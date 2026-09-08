/**
 * 账号池（Account Pool）类型定义
 *
 * 设计目标：把一个对外暴露的 identity（池）映射到后台多个真实账号，
 * 在提升总额度与并发的同时**保住 prompt 缓存命中率**。
 *
 * 关键取舍：分散发生在「会话」粒度而非「请求」粒度。
 * 逐请求轮询会让每个账号都要重写一遍缓存（cache_write 625 AIU/1M，
 * 比未命中的 input 500 还贵），总成本不降反升。
 */

/** 池的成员选择策略 */
export type PoolStrategy =
  /** 会话粘性 + Rendezvous 哈希放置（默认，缓存友好） */
  | 'sticky-affinity'
  /** 忽略亲和，永远选当前负载最低的成员（缓存不友好，仅用于对照测试） */
  | 'least-loaded'
  /** 纯轮询（缓存最不友好，仅用于对照测试） */
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
