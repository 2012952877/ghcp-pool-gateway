import { randomUUID } from 'node:crypto';
import { HttpApiError, type EnsureSsoUserResponse, type SsoType } from '@ghcp/shared';
import {
  beginCopilotOauthAuthorization,
  claimIdentityInitialization,
  createAccount,
  failCopilotOauthAuthorization,
  getAccount,
  invalidateCopilotOauthToken,
  releaseIdentityInitialization,
} from '../db/accountsRepo.js';
import { ensureSsoUser, syncEmuUser } from '../clients/ssoClient.js';
import { createLoginTask } from '../clients/loginClient.js';
import { config } from '../config.js';
import { Logger } from '../logger.js';
import { findPool, resolvePoolMember } from '../pool/poolResolver.js';
import type { CopilotAuthContext } from './copilotAuth.js';

export interface GetAuthOptions {
  /** 会话标识，决定池内落到哪个成员。缺省时所有请求视为同一会话 */
  sessionKey?: string;
  /** 本次请求内要跳过的成员（故障转移重试用） */
  exclude?: readonly string[];
}

/** 没有会话信号时的固定 key：让这类请求稳定落在同一成员，避免无谓打散缓存 */
const DEFAULT_SESSION_KEY = 'default';

export class CopilotAuthNotReadyError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'account_initializing' | 'account_limit_reached' | 'oauth_not_ready',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CopilotAuthNotReadyError';
  }
}

class CopilotAuthManager {
  private readonly logger = new Logger('copilot-auth-manager');
  private readonly initializing = new Map<string, { prepared: Promise<void>; completed: Promise<void> }>();

  /**
   * 解析出本次请求要用的 Copilot 凭据。
   *
   * ⚠️ 池判断必须在 `getAccount` **之前**：否则池名会被当成未知 identity，
   * 触发冷启动自动开通，真的去 SSO 建一个叫池名的用户。
   */
  async getAuth(identity: string, options: GetAuthOptions = {}): Promise<CopilotAuthContext> {
    const pool = await findPool(identity);
    if (!pool) return this.getAuthForAccount(identity);

    const sessionKey = options.sessionKey ?? DEFAULT_SESSION_KEY;
    const resolved = await resolvePoolMember(pool, sessionKey, options.exclude ?? []);
    const context = await this.getAuthForAccount(resolved.identity);
    return { ...context, poolId: pool.poolId };
  }

  /** 原 1:1 逻辑，逐行保留 */
  private async getAuthForAccount(identity: string): Promise<CopilotAuthContext> {
    const account = await getAccount(identity);
    if (!account) {
      try {
        await this.beginIdentityInitialization(identity);
      } catch (err) {
        if (err instanceof HttpApiError && err.code === 'sso_user_limit_reached') {
          throw new CopilotAuthNotReadyError(409, 'account_limit_reached', err.message, err.details);
        }
        throw err;
      }
      throw new CopilotAuthNotReadyError(202, 'account_initializing', 'Account initialization has started.');
    }
    if (!account.copilotOauthToken || account.copilotOauthStatus !== 'valid') {
      const initializing = account.copilotOauthStatus === 'refreshing';
      throw new CopilotAuthNotReadyError(
        initializing ? 202 : 503,
        initializing ? 'account_initializing' : 'oauth_not_ready',
        initializing
          ? 'Copilot OAuth authorization is in progress for this identity.'
          : 'Copilot OAuth authorization is required for this identity.',
      );
    }
    return {
      identity,
      accessToken: account.copilotOauthToken,
      api: config.copilotApiBaseUrl,
    };
  }

  async triggerOauthRefresh(identity: string, options: { ssoPassword?: string; ssoType?: SsoType } = {}): Promise<void> {
    const account = await getAccount(identity);
    if (!account) throw new Error(`Unknown identity "${identity}".`);
    if (!account.ssoUser) throw new Error(`Identity "${identity}" is missing an SSO user.`);
    if (!account.ghLogin) throw new Error(`Identity "${identity}" is missing a GitHub login.`);
    if (!options.ssoPassword) throw new Error('ssoPassword is required to reauthorize Copilot OAuth.');
    const oauthAttemptId = randomUUID();
    if (!await beginCopilotOauthAuthorization(identity, oauthAttemptId)) {
      throw new Error(`Unknown identity "${identity}".`);
    }
    try {
      await createLoginTask({
        identity,
        ssoUser: account.ssoUser,
        ssoPassword: options.ssoPassword,
        ghLogin: account.ghLogin,
        oauthAttemptId,
        ssoType: options.ssoType ?? 'custom',
      });
    } catch (err) {
      await failCopilotOauthAuthorization(identity, oauthAttemptId);
      throw err;
    }
  }

  invalidate(identity: string, expectedToken: string): Promise<boolean> {
    return invalidateCopilotOauthToken(identity, expectedToken, 'expired');
  }

  private async beginIdentityInitialization(identity: string): Promise<void> {
    const existing = this.initializing.get(identity);
    if (existing) return existing.prepared;

    const claimId = randomUUID();
    const claimed = await claimIdentityInitialization(identity, claimId, config.identityInitLeaseSeconds);
    if (!claimed) return;

    this.logger.info('identity-init', 'Initializing unknown identity', { identity });
    const ensured = ensureSsoUser({ identity, preferredSsoUser: ssoUserFromIdentity(identity) });
    const prepared = ensured.then(() => undefined);
    const completed = ensured.then((result) => this.initializeEnsuredIdentity(identity, result));
    const state = { prepared, completed };
    this.initializing.set(identity, state);
    void completed
      .catch((err: unknown) => {
        this.logger.error('identity-init', 'Identity initialization failed', {
          identity,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(async () => {
        if (this.initializing.get(identity) === state) this.initializing.delete(identity);
        try {
          await releaseIdentityInitialization(identity, claimId);
        } catch (err) {
          this.logger.error('identity-init-release', 'Failed to release identity initialization claim', {
            identity,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return prepared;
  }

  private async initializeEnsuredIdentity(identity: string, ensured: EnsureSsoUserResponse): Promise<void> {
    const synced = await syncEmuUser(ensured.user.ssoUser, { assignCopilotSeat: true });
    if (!synced.ghLogin) throw new Error(`SSO user "${ensured.user.ssoUser}" did not return a GH login.`);
    const oauthAttemptId = randomUUID();
    await createAccount({
      identity,
      ssoUser: ensured.user.ssoUser,
      ghLogin: synced.ghLogin,
      copilotOauthStatus: 'refreshing',
      copilotOauthAttemptId: oauthAttemptId,
    });
    const ssoPassword = ensured.passwordForLogin;
    if (!ssoPassword) {
      await failCopilotOauthAuthorization(identity, oauthAttemptId);
      throw new Error(`SSO password is required to initialize identity "${identity}"; reauthorize it from Console with an explicit password.`);
    }
    try {
      await createLoginTask({
        identity,
        ssoUser: ensured.user.ssoUser,
        ssoPassword,
        ghLogin: synced.ghLogin,
        oauthAttemptId,
        ssoType: 'custom',
      });
    } catch (err) {
      await failCopilotOauthAuthorization(identity, oauthAttemptId);
      throw err;
    }
  }
}

function ssoUserFromIdentity(identity: string): string {
  const normalized = identity
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stripEnterpriseShortcode(normalized).slice(0, 32);
}

function stripEnterpriseShortcode(value: string): string {
  const shortcode = config.enterpriseShortcode.trim().toLowerCase();
  if (!shortcode) return value;
  const suffix = `_${shortcode}`;
  if (!value.endsWith(suffix)) return value;
  const stripped = value.slice(0, -suffix.length);
  return stripped || value;
}

export const copilotAuthManager = new CopilotAuthManager();
