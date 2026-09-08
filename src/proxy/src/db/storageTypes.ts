import type {
  CopilotOauthStatus,
  DeleteProxyAccountResult,
  PageResponse,
  ProxyRequestStatDto,
} from '@ghcp/shared';
import type {
  AddPoolMemberInput,
  CreatePoolInput,
  ProxyPoolMemberRecord,
  ProxyPoolRecord,
  ProxySessionAffinityRecord,
  UpdatePoolInput,
} from '../pool/poolTypes.js';

export type {
  AddPoolMemberInput,
  CreatePoolInput,
  ProxyPoolMemberRecord,
  ProxyPoolRecord,
  ProxySessionAffinityRecord,
  UpdatePoolInput,
};

export interface ProxyAccountRecord {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthToken?: string;
  copilotOauthStatus: CopilotOauthStatus;
  copilotOauthUpdatedAt?: string;
  copilotOauthAttemptId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'identity' | 'ssoUser' | 'ghLogin' | 'copilotOauthStatus' | 'createdAt' | 'updatedAt';
  dir?: 'asc' | 'desc';
}

export interface CreateAccountInput {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthStatus?: CopilotOauthStatus;
  copilotOauthAttemptId?: string;
}

export interface ImportCopilotOauthTokenInput {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthToken: string;
}

export interface DeleteAccountsBySsoUserResult {
  ssoUser: string;
  matchedAccounts: number;
  deletedAccounts: number;
  deletedRequestStats: number;
}

export interface RecordRequestStatInput {
  identity: string;
  /** 池模式下：identity 记成员账号，poolId 记对外暴露的池名 */
  poolId?: string;
  ghLogin?: string;
  path: ProxyRequestStatDto['path'];
  model?: string;
  success: boolean;
  failureReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  cacheInputTokens?: number;
  cacheWriteTokens?: number;
}

export interface ProxyStorage {
  initialize(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;

  listAccounts(query?: AccountListQuery): Promise<PageResponse<ProxyAccountRecord>>;
  getAccount(identity: string): Promise<ProxyAccountRecord | undefined>;
  deleteAccount(identity: string): Promise<DeleteProxyAccountResult | undefined>;
  deleteAccountsBySsoUser(ssoUser: string): Promise<DeleteAccountsBySsoUserResult>;
  createAccount(input: CreateAccountInput): Promise<ProxyAccountRecord>;
  importCopilotOauthToken(input: ImportCopilotOauthTokenInput): Promise<ProxyAccountRecord>;
  saveCopilotOauthToken(
    identity: string,
    oauthAttemptId: string,
    copilotOauthToken: string,
    ghLogin?: string,
  ): Promise<ProxyAccountRecord | undefined>;
  markCopilotOauthStatus(identity: string, status: CopilotOauthStatus): Promise<void>;
  beginCopilotOauthAuthorization(identity: string, oauthAttemptId: string): Promise<boolean>;
  failCopilotOauthAuthorization(identity: string, oauthAttemptId: string): Promise<boolean>;
  invalidateCopilotOauthToken(
    identity: string,
    expectedToken: string,
    status: Extract<CopilotOauthStatus, 'expired' | 'failed'>,
  ): Promise<boolean>;

  claimIdentityInitialization(identity: string, claimId: string, leaseSeconds: number): Promise<boolean>;
  releaseIdentityInitialization(identity: string, claimId: string): Promise<boolean>;

  recordRequestStat(input: RecordRequestStatInput): Promise<void>;
  listRequestStats(identity?: string, limit?: number): Promise<ProxyRequestStatDto[]>;
  pruneAllRequestStats(): Promise<void>;

  // ── 账号池 ──
  listPools(): Promise<ProxyPoolRecord[]>;
  getPool(poolId: string): Promise<ProxyPoolRecord | undefined>;
  createPool(input: CreatePoolInput): Promise<ProxyPoolRecord>;
  updatePool(poolId: string, input: UpdatePoolInput): Promise<ProxyPoolRecord | undefined>;
  deletePool(poolId: string): Promise<boolean>;

  listPoolMembers(poolId: string): Promise<ProxyPoolMemberRecord[]>;
  addPoolMember(input: AddPoolMemberInput): Promise<ProxyPoolMemberRecord>;
  removePoolMember(poolId: string, identity: string): Promise<boolean>;
  /** 记一次成功：清零失败计数、解除冷却、刷新 last_used_at */
  markMemberSuccess(poolId: string, identity: string): Promise<void>;
  /** 记一次失败：失败数累加，达到阈值则进入冷却。返回是否已冷却 */
  markMemberFailure(
    poolId: string,
    identity: string,
    failureThreshold: number,
    cooldownSeconds: number,
    forceCooldown?: boolean,
  ): Promise<boolean>;

  getSessionAffinity(poolId: string, sessionKey: string): Promise<ProxySessionAffinityRecord | undefined>;
  /** 绑定或续期会话 → 成员 */
  upsertSessionAffinity(
    poolId: string,
    sessionKey: string,
    identity: string,
    ttlSeconds: number,
  ): Promise<void>;
  clearSessionAffinity(poolId: string, sessionKey: string): Promise<void>;
  /** 清理过期绑定，返回删除行数 */
  pruneExpiredSessionAffinity(): Promise<number>;
}
