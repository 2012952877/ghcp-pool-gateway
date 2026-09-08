/**
 * 账号池（Account Pool）类型定义
 *
 * 设计目标：把一个对外暴露的 identity（池）映射到后台多个真实账号，
 * 在提升总额度与并发能力的同时保持请求可用。
 *
 * 默认策略 least-loaded：每次挑最久未使用的成员，负载最均匀，
 * 适合多个租户共用同一个池的场景。需要按会话追溯、或客户端用了
 * 有状态接口时，改用 sticky-affinity。
 */

/** 池的成员选择策略 */
export type PoolStrategy =
  /** 会话粘性 + Rendezvous 哈希放置：同一会话固定落在同一成员 */
  | 'sticky-affinity'
  /** 忽略亲和，每次挑最久未使用的成员，负载最均匀（默认） */
  | 'least-loaded'
  /** 按会话哈希分配：同一会话结果稳定，但不看负载 */
  | 'round-robin';

export const POOL_STRATEGIES: readonly PoolStrategy[] = [
  'sticky-affinity',
  'least-loaded',
  'round-robin',
];

/** 成员状态 */
export type PoolMemberState =
  /** 可用 */
  | 'active'
  /** 因 429 / 配额耗尽临时冷却，`coolingUntil` 到期后自动恢复 */
  | 'cooling'
  /** 人工停用，不参与选择 */
  | 'disabled';

export interface ProxyPoolRecord {
  poolId: string;
  strategy: PoolStrategy;
  /** 会话绑定的存活时间（秒）。同一会话在此时间内始终落到同一账号 */
  sessionTtlSeconds: number;
  /** 成员遇到 429 后的冷却时长（秒） */
  cooldownSeconds: number;
  /** 连续失败多少次后进入冷却 */
  failureThreshold: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyPoolMemberRecord {
  poolId: string;
  /** 指向 proxy_accounts.identity —— 逻辑关联，无外键 */
  identity: string;
  /** 相对权重，影响 Rendezvous 哈希的分配比例 */
  weight: number;
  state: PoolMemberState;
  coolingUntil?: string;
  consecutiveFailures: number;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProxySessionAffinityRecord {
  sessionKey: string;
  poolId: string;
  identity: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export interface CreatePoolInput {
  poolId: string;
  strategy?: PoolStrategy;
  sessionTtlSeconds?: number;
  cooldownSeconds?: number;
  failureThreshold?: number;
  enabled?: boolean;
}

export interface UpdatePoolInput {
  strategy?: PoolStrategy;
  sessionTtlSeconds?: number;
  cooldownSeconds?: number;
  failureThreshold?: number;
  enabled?: boolean;
}

export interface AddPoolMemberInput {
  poolId: string;
  identity: string;
  weight?: number;
  state?: PoolMemberState;
}

/** 池默认值 */
export const POOL_DEFAULTS = {
  strategy: 'least-loaded' as PoolStrategy,
  /** 30 分钟：足够覆盖一次连续的 Claude Code 会话 */
  sessionTtlSeconds: 1800,
  /** 5 分钟：与 Copilot 侧常见的限流窗口相当 */
  cooldownSeconds: 300,
  failureThreshold: 3,
  weight: 1,
} as const;
