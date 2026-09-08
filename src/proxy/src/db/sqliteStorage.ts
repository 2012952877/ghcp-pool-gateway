import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import {
  newRequestId,
  nowIso,
  pageResponse,
  type CopilotOauthStatus,
  type DeleteProxyAccountResult,
  type PageResponse,
  type ProxyRequestStatDto,
} from '@ghcp/shared';
import { runMigrations } from './migrations.js';
import { POOL_DEFAULTS } from '../pool/poolTypes.js';
import type {
  AddPoolMemberInput,
  CreatePoolInput,
  ProxyPoolMemberRecord,
  ProxyPoolRecord,
  ProxySessionAffinityRecord,
  UpdatePoolInput,
  AccountListQuery,
  CreateAccountInput,
  DeleteAccountsBySsoUserResult,
  ImportCopilotOauthTokenInput,
  ProxyAccountRecord,
  ProxyStorage,
  RecordRequestStatInput,
} from './storageTypes.js';

interface AccountRow {
  identity: string;
  sso_user: string;
  gh_login: string | null;
  copilot_oauth_token: string | null;
  copilot_oauth_status: CopilotOauthStatus;
  copilot_oauth_updated_at: string | null;
  copilot_oauth_attempt_id: string | null;
  created_at: string;
  updated_at: string;
}

interface StatRow {
  id: string;
  identity: string;
  pool_id?: string | null;
  gh_login?: string;
  requested_at: string;
  path: ProxyRequestStatDto['path'];
  model?: string;
  success: 0 | 1;
  failure_reason?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_tokens?: number;
  cache_input_tokens?: number;
  cache_write_tokens?: number;
}

export class SqliteStorage implements ProxyStorage {
  private db?: Database.Database;

  constructor(
    private readonly path: string,
    private readonly requestStatsPerAccountLimit: number,
  ) {}

  async initialize(): Promise<void> {
    if (this.db) return;
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    const db = new BetterSqlite3(this.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    this.db = db;
  }

  async ping(): Promise<void> {
    this.database().prepare('SELECT 1').get();
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  async listAccounts(query: AccountListQuery = {}): Promise<PageResponse<ProxyAccountRecord>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
    const q = query.q?.trim();
    const where = q ? 'WHERE identity LIKE ? OR sso_user LIKE ? OR gh_login LIKE ?' : '';
    const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
    const sort = sortColumn(query.sort);
    const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
    const total = (this.database()
      .prepare(`SELECT COUNT(*) AS count FROM proxy_accounts ${where}`)
      .get(...args) as { count: number }).count;
    const rows = this.database()
      .prepare(`SELECT * FROM proxy_accounts ${where} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize) as AccountRow[];
    return pageResponse(rows.map(mapAccountRow), total, page, pageSize);
  }

  async getAccount(identity: string): Promise<ProxyAccountRecord | undefined> {
    const row = this.database()
      .prepare('SELECT * FROM proxy_accounts WHERE identity = ?')
      .get(identity) as AccountRow | undefined;
    return row ? mapAccountRow(row) : undefined;
  }

  async deleteAccount(identity: string): Promise<DeleteProxyAccountResult | undefined> {
    const target = identity.trim();
    if (!target) return undefined;
    return this.database().transaction(() => {
      const exists = this.database().prepare('SELECT 1 FROM proxy_accounts WHERE identity = ?').get(target);
      if (!exists) return undefined;
      const deletedRequestStats = this.database()
        .prepare('DELETE FROM proxy_request_stats WHERE identity = ?')
        .run(target).changes;
      const deletedAccount = this.database()
        .prepare('DELETE FROM proxy_accounts WHERE identity = ?')
        .run(target).changes;
      if (deletedAccount !== 1) throw new Error(`Failed to delete Proxy account "${target}".`);
      return { identity: target, deletedRequestStats };
    })();
  }

  async deleteAccountsBySsoUser(ssoUser: string): Promise<DeleteAccountsBySsoUserResult> {
    const target = ssoUser.trim();
    if (!target) return { ssoUser: target, matchedAccounts: 0, deletedAccounts: 0, deletedRequestStats: 0 };
    return this.database().transaction(() => {
      const accounts = this.database()
        .prepare('SELECT identity FROM proxy_accounts WHERE lower(sso_user) = lower(?)')
        .all(target) as Array<{ identity: string }>;
      const identities = accounts.map((account) => account.identity);
      let deletedRequestStats = 0;
      if (identities.length > 0) {
        const placeholders = identities.map(() => '?').join(', ');
        deletedRequestStats = this.database()
          .prepare(`DELETE FROM proxy_request_stats WHERE identity IN (${placeholders})`)
          .run(...identities).changes;
      }
      const deletedAccounts = this.database()
        .prepare('DELETE FROM proxy_accounts WHERE lower(sso_user) = lower(?)')
        .run(target).changes;
      return {
        ssoUser: target,
        matchedAccounts: accounts.length,
        deletedAccounts,
        deletedRequestStats,
      };
    })();
  }

  async createAccount(input: CreateAccountInput): Promise<ProxyAccountRecord> {
    const now = nowIso();
    this.database()
      .prepare(`
        INSERT INTO proxy_accounts (
          identity, sso_user, gh_login, copilot_oauth_status, copilot_oauth_attempt_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET
          sso_user = excluded.sso_user,
          gh_login = COALESCE(excluded.gh_login, proxy_accounts.gh_login),
          updated_at = excluded.updated_at
      `)
      .run(
        input.identity,
        input.ssoUser,
        input.ghLogin,
        input.copilotOauthStatus ?? 'missing',
        input.copilotOauthAttemptId,
        now,
        now,
      );
    return (await this.getAccount(input.identity))!;
  }

  async importCopilotOauthToken(input: ImportCopilotOauthTokenInput): Promise<ProxyAccountRecord> {
    const now = nowIso();
    this.database()
      .prepare(`
        INSERT INTO proxy_accounts (
          identity, sso_user, gh_login, copilot_oauth_token, copilot_oauth_status,
          copilot_oauth_updated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'valid', ?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET
          sso_user = excluded.sso_user,
          gh_login = COALESCE(excluded.gh_login, proxy_accounts.gh_login),
          copilot_oauth_token = excluded.copilot_oauth_token,
          copilot_oauth_status = 'valid',
          copilot_oauth_updated_at = excluded.copilot_oauth_updated_at,
          copilot_oauth_attempt_id = NULL,
          updated_at = excluded.updated_at
      `)
      .run(input.identity, input.ssoUser, input.ghLogin, input.copilotOauthToken, now, now, now);
    return (await this.getAccount(input.identity))!;
  }

  async saveCopilotOauthToken(
    identity: string,
    oauthAttemptId: string,
    copilotOauthToken: string,
    ghLogin?: string,
  ): Promise<ProxyAccountRecord | undefined> {
    const now = nowIso();
    const result = this.database()
      .prepare(`
        UPDATE proxy_accounts
        SET copilot_oauth_token = ?, gh_login = COALESCE(?, gh_login),
            copilot_oauth_status = 'valid', copilot_oauth_updated_at = ?,
            copilot_oauth_attempt_id = NULL, updated_at = ?
        WHERE identity = ? AND copilot_oauth_attempt_id = ?
      `)
      .run(copilotOauthToken, ghLogin, now, now, identity, oauthAttemptId);
    return result.changes > 0 ? this.getAccount(identity) : undefined;
  }

  async markCopilotOauthStatus(identity: string, status: CopilotOauthStatus): Promise<void> {
    this.database()
      .prepare('UPDATE proxy_accounts SET copilot_oauth_status = ?, updated_at = ? WHERE identity = ?')
      .run(status, nowIso(), identity);
  }

  async beginCopilotOauthAuthorization(identity: string, oauthAttemptId: string): Promise<boolean> {
    return this.database()
      .prepare(`
        UPDATE proxy_accounts
        SET copilot_oauth_status = 'refreshing', copilot_oauth_attempt_id = ?, updated_at = ?
        WHERE identity = ?
      `)
      .run(oauthAttemptId, nowIso(), identity).changes > 0;
  }

  async failCopilotOauthAuthorization(identity: string, oauthAttemptId: string): Promise<boolean> {
    return this.database()
      .prepare(`
        UPDATE proxy_accounts
        SET copilot_oauth_status = 'failed', updated_at = ?
        WHERE identity = ? AND copilot_oauth_attempt_id = ?
      `)
      .run(nowIso(), identity, oauthAttemptId).changes > 0;
  }

  async invalidateCopilotOauthToken(
    identity: string,
    expectedToken: string,
    status: Extract<CopilotOauthStatus, 'expired' | 'failed'>,
  ): Promise<boolean> {
    const now = nowIso();
    return this.database()
      .prepare(`
        UPDATE proxy_accounts
        SET copilot_oauth_token = NULL, copilot_oauth_status = ?,
            copilot_oauth_updated_at = ?, copilot_oauth_attempt_id = NULL, updated_at = ?
        WHERE identity = ? AND copilot_oauth_token = ? AND copilot_oauth_status = 'valid'
      `)
      .run(status, now, now, identity, expectedToken).changes > 0;
  }

  async claimIdentityInitialization(identity: string, claimId: string, leaseSeconds: number): Promise<boolean> {
    const now = nowIso();
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    return this.database()
      .prepare(`
        INSERT INTO proxy_identity_initializations (
          identity, claim_id, lease_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET
          claim_id = excluded.claim_id,
          lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at
        WHERE proxy_identity_initializations.lease_expires_at <= excluded.updated_at
      `)
      .run(identity, claimId, leaseExpiresAt, now, now).changes > 0;
  }

  async releaseIdentityInitialization(identity: string, claimId: string): Promise<boolean> {
    return this.database()
      .prepare('DELETE FROM proxy_identity_initializations WHERE identity = ? AND claim_id = ?')
      .run(identity, claimId).changes > 0;
  }

  async recordRequestStat(input: RecordRequestStatInput): Promise<void> {
    this.database()
      .prepare(`
        INSERT INTO proxy_request_stats (
          id, identity, pool_id, gh_login, requested_at, path, model, success, failure_reason,
          input_tokens, output_tokens, cache_tokens, cache_input_tokens, cache_write_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        newRequestId(),
        input.identity,
        input.poolId ?? null,
        input.ghLogin,
        nowIso(),
        input.path,
        input.model,
        input.success ? 1 : 0,
        input.failureReason,
        input.inputTokens,
        input.outputTokens,
        input.cacheTokens,
        input.cacheInputTokens,
        input.cacheWriteTokens,
      );
    this.pruneStats(input.identity);
  }

  async listRequestStats(identity?: string, limit = 100): Promise<ProxyRequestStatDto[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    const rows = identity
      ? this.database()
          .prepare('SELECT * FROM proxy_request_stats WHERE identity = ? ORDER BY requested_at DESC, id DESC LIMIT ?')
          .all(identity, boundedLimit)
      : this.database()
          .prepare('SELECT * FROM proxy_request_stats ORDER BY requested_at DESC, id DESC LIMIT ?')
          .all(boundedLimit);
    return (rows as StatRow[]).map(mapStatRow);
  }

  async pruneAllRequestStats(): Promise<void> {
    this.database()
      .prepare(`
        DELETE FROM proxy_request_stats
        WHERE id IN (
          SELECT id
          FROM (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY identity
                ORDER BY requested_at DESC, id DESC
              ) AS retention_rank
            FROM proxy_request_stats
          )
          WHERE retention_rank > ?
        )
      `)
      .run(this.requestStatsPerAccountLimit);
  }

  // -------------------------- account pool --------------------------

  async listPools(): Promise<ProxyPoolRecord[]> {
    const rows = this.database().prepare('SELECT * FROM proxy_pools ORDER BY pool_id').all() as PoolRow[];
    return rows.map(mapPoolRow);
  }

  async getPool(poolId: string): Promise<ProxyPoolRecord | undefined> {
    const row = this.database()
      .prepare('SELECT * FROM proxy_pools WHERE pool_id = ?')
      .get(poolId) as PoolRow | undefined;
    return row ? mapPoolRow(row) : undefined;
  }

  async createPool(input: CreatePoolInput): Promise<ProxyPoolRecord> {
    const now = nowIso();
    this.database()
      .prepare(
        'INSERT INTO proxy_pools (pool_id, strategy, session_ttl_seconds, cooldown_seconds, failure_threshold, enabled, created_at, updated_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        + ' ON CONFLICT(pool_id) DO UPDATE SET strategy = excluded.strategy,'
        + ' session_ttl_seconds = excluded.session_ttl_seconds, cooldown_seconds = excluded.cooldown_seconds,'
        + ' failure_threshold = excluded.failure_threshold, enabled = excluded.enabled, updated_at = excluded.updated_at',
      )
      .run(
        input.poolId,
        input.strategy ?? POOL_DEFAULTS.strategy,
        input.sessionTtlSeconds ?? POOL_DEFAULTS.sessionTtlSeconds,
        input.cooldownSeconds ?? POOL_DEFAULTS.cooldownSeconds,
        input.failureThreshold ?? POOL_DEFAULTS.failureThreshold,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    return (await this.getPool(input.poolId))!;
  }

  async updatePool(poolId: string, input: UpdatePoolInput): Promise<ProxyPoolRecord | undefined> {
    const existing = await this.getPool(poolId);
    if (!existing) return undefined;
    this.database()
      .prepare(
        'UPDATE proxy_pools SET strategy = ?, session_ttl_seconds = ?, cooldown_seconds = ?,'
        + ' failure_threshold = ?, enabled = ?, updated_at = ? WHERE pool_id = ?',
      )
      .run(
        input.strategy ?? existing.strategy,
        input.sessionTtlSeconds ?? existing.sessionTtlSeconds,
        input.cooldownSeconds ?? existing.cooldownSeconds,
        input.failureThreshold ?? existing.failureThreshold,
        (input.enabled ?? existing.enabled) ? 1 : 0,
        nowIso(),
        poolId,
      );
    return this.getPool(poolId);
  }

  async deletePool(poolId: string): Promise<boolean> {
    return this.database().transaction(() => {
      this.database().prepare('DELETE FROM proxy_session_affinity WHERE pool_id = ?').run(poolId);
      this.database().prepare('DELETE FROM proxy_pool_members WHERE pool_id = ?').run(poolId);
      return this.database().prepare('DELETE FROM proxy_pools WHERE pool_id = ?').run(poolId).changes > 0;
    })();
  }

  async listPoolMembers(poolId: string): Promise<ProxyPoolMemberRecord[]> {
    const rows = this.database()
      .prepare('SELECT * FROM proxy_pool_members WHERE pool_id = ? ORDER BY identity')
      .all(poolId) as PoolMemberRow[];
    return rows.map(mapPoolMemberRow);
  }

  async addPoolMember(input: AddPoolMemberInput): Promise<ProxyPoolMemberRecord> {
    const now = nowIso();
    this.database()
      .prepare(
        'INSERT INTO proxy_pool_members (pool_id, identity, weight, state, consecutive_failures, created_at, updated_at)'
        + ' VALUES (?, ?, ?, ?, 0, ?, ?)'
        + ' ON CONFLICT(pool_id, identity) DO UPDATE SET weight = excluded.weight,'
        + ' state = excluded.state, updated_at = excluded.updated_at',
      )
      .run(
        input.poolId,
        input.identity,
        input.weight ?? POOL_DEFAULTS.weight,
        input.state ?? 'active',
        now,
        now,
      );
    const row = this.database()
      .prepare('SELECT * FROM proxy_pool_members WHERE pool_id = ? AND identity = ?')
      .get(input.poolId, input.identity) as PoolMemberRow;
    return mapPoolMemberRow(row);
  }

  async removePoolMember(poolId: string, identity: string): Promise<boolean> {
    return this.database().transaction(() => {
      this.database()
        .prepare('DELETE FROM proxy_session_affinity WHERE pool_id = ? AND identity = ?')
        .run(poolId, identity);
      return this.database()
        .prepare('DELETE FROM proxy_pool_members WHERE pool_id = ? AND identity = ?')
        .run(poolId, identity).changes > 0;
    })();
  }

  async markMemberSuccess(poolId: string, identity: string): Promise<void> {
    const now = nowIso();
    this.database()
      .prepare(
        "UPDATE proxy_pool_members SET consecutive_failures = 0, state = 'active', cooling_until = NULL,"
        + " last_used_at = ?, updated_at = ? WHERE pool_id = ? AND identity = ? AND state != 'disabled'",
      )
      .run(now, now, poolId, identity);
  }

  async markMemberFailure(
    poolId: string,
    identity: string,
    failureThreshold: number,
    cooldownSeconds: number,
    forceCooldown = false,
  ): Promise<boolean> {
    return this.database().transaction(() => {
      const row = this.database()
        .prepare('SELECT * FROM proxy_pool_members WHERE pool_id = ? AND identity = ?')
        .get(poolId, identity) as PoolMemberRow | undefined;
      if (!row || row.state === 'disabled') return false;
      const failures = (row.consecutive_failures ?? 0) + 1;
      const shouldCool = forceCooldown || failures >= failureThreshold;
      const coolingUntil = shouldCool
        ? new Date(Date.now() + cooldownSeconds * 1000).toISOString()
        : null;
      this.database()
        .prepare(
          'UPDATE proxy_pool_members SET consecutive_failures = ?, state = ?, cooling_until = ?,'
          + ' updated_at = ? WHERE pool_id = ? AND identity = ?',
        )
        .run(failures, shouldCool ? 'cooling' : row.state, coolingUntil, nowIso(), poolId, identity);
      return shouldCool;
    })();
  }

  async getSessionAffinity(
    poolId: string,
    sessionKey: string,
  ): Promise<ProxySessionAffinityRecord | undefined> {
    const row = this.database()
      .prepare('SELECT * FROM proxy_session_affinity WHERE pool_id = ? AND session_key = ?')
      .get(poolId, sessionKey) as SessionAffinityRow | undefined;
    if (!row) return undefined;
    if (new Date(row.expires_at).getTime() <= Date.now()) return undefined;
    return mapSessionAffinityRow(row);
  }

  async upsertSessionAffinity(
    poolId: string,
    sessionKey: string,
    identity: string,
    ttlSeconds: number,
  ): Promise<void> {
    const now = nowIso();
    const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.database()
      .prepare(
        'INSERT INTO proxy_session_affinity (session_key, pool_id, identity, created_at, last_used_at, expires_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?)'
        + ' ON CONFLICT(session_key, pool_id) DO UPDATE SET identity = excluded.identity,'
        + ' last_used_at = excluded.last_used_at, expires_at = excluded.expires_at',
      )
      .run(sessionKey, poolId, identity, now, now, expires);
  }

  async clearSessionAffinity(poolId: string, sessionKey: string): Promise<void> {
    this.database()
      .prepare('DELETE FROM proxy_session_affinity WHERE pool_id = ? AND session_key = ?')
      .run(poolId, sessionKey);
  }

  async pruneExpiredSessionAffinity(): Promise<number> {
    return this.database()
      .prepare('DELETE FROM proxy_session_affinity WHERE expires_at <= ?')
      .run(nowIso()).changes;
  }

  private pruneStats(identity: string): void {
    this.database()
      .prepare(`
        DELETE FROM proxy_request_stats
        WHERE identity = ?
          AND id NOT IN (
            SELECT id FROM proxy_request_stats
            WHERE identity = ?
            ORDER BY requested_at DESC, id DESC
            LIMIT ?
          )
      `)
      .run(identity, identity, this.requestStatsPerAccountLimit);
  }

  private database(): Database.Database {
    if (!this.db) throw new Error('SQLite storage has not been initialized.');
    return this.db;
  }
}

function mapAccountRow(row: AccountRow): ProxyAccountRecord {
  return {
    identity: row.identity,
    ssoUser: row.sso_user,
    ghLogin: row.gh_login ?? undefined,
    copilotOauthToken: row.copilot_oauth_token ?? undefined,
    copilotOauthStatus: row.copilot_oauth_status,
    copilotOauthUpdatedAt: row.copilot_oauth_updated_at ?? undefined,
    copilotOauthAttemptId: row.copilot_oauth_attempt_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStatRow(row: StatRow): ProxyRequestStatDto {
  return {
    id: row.id,
    identity: row.identity,
    poolId: row.pool_id ?? undefined,
    ghLogin: row.gh_login,
    requestedAt: row.requested_at,
    path: row.path,
    model: row.model,
    success: row.success === 1,
    failureReason: row.failure_reason,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheTokens: row.cache_tokens,
    cacheInputTokens: row.cache_input_tokens,
    cacheWriteTokens: row.cache_write_tokens,
  };
}

function sortColumn(sort: AccountListQuery['sort']): string {
  switch (sort) {
    case 'identity':
      return 'identity';
    case 'ssoUser':
      return 'sso_user';
    case 'ghLogin':
      return 'gh_login';
    case 'copilotOauthStatus':
      return 'copilot_oauth_status';
    case 'createdAt':
      return 'created_at';
    default:
      return 'updated_at';
  }
}

interface PoolRow {
  pool_id: string;
  strategy: string;
  session_ttl_seconds: number;
  cooldown_seconds: number;
  failure_threshold: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface PoolMemberRow {
  pool_id: string;
  identity: string;
  weight: number;
  state: string;
  cooling_until: string | null;
  consecutive_failures: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionAffinityRow {
  session_key: string;
  pool_id: string;
  identity: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
}

function mapPoolRow(row: PoolRow): ProxyPoolRecord {
  return {
    poolId: row.pool_id,
    strategy: row.strategy as ProxyPoolRecord['strategy'],
    sessionTtlSeconds: row.session_ttl_seconds,
    cooldownSeconds: row.cooldown_seconds,
    failureThreshold: row.failure_threshold,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPoolMemberRow(row: PoolMemberRow): ProxyPoolMemberRecord {
  return {
    poolId: row.pool_id,
    identity: row.identity,
    weight: row.weight,
    state: row.state as ProxyPoolMemberRecord['state'],
    coolingUntil: row.cooling_until ?? undefined,
    consecutiveFailures: row.consecutive_failures,
    lastUsedAt: row.last_used_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSessionAffinityRow(row: SessionAffinityRow): ProxySessionAffinityRecord {
  return {
    sessionKey: row.session_key,
    poolId: row.pool_id,
    identity: row.identity,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}
