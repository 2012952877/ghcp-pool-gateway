import { getStorage, initializeStorage } from '../db/connection.js';
import { Logger } from '../logger.js';
import { isMemberAvailable, selectMember } from './poolSelector.js';
import type { ProxyPoolMemberRecord, ProxyPoolRecord } from './poolTypes.js';

const logger = new Logger('pool-resolver');

export class PoolAllCoolingError extends Error {
  constructor(
    readonly poolId: string,
    readonly retryAfterSeconds: number,
  ) {
    super(`All members of pool "${poolId}" are cooling down.`);
    this.name = 'PoolAllCoolingError';
  }
}

export class PoolEmptyError extends Error {
  constructor(readonly poolId: string) {
    super(`Pool "${poolId}" has no usable members.`);
    this.name = 'PoolEmptyError';
  }
}

export interface ResolvedPoolMember {
  pool: ProxyPoolRecord;
  identity: string;
  /** 命中已有会话绑定（缓存热）还是新分配 */
  reused: boolean;
}

/** 查池；不是池就返回 undefined，调用方走原有 1:1 路径 */
export async function findPool(identity: string): Promise<ProxyPoolRecord | undefined> {
  await initializeStorage();
  const pool = await getStorage().getPool(identity);
  if (!pool || !pool.enabled) return undefined;
  return pool;
}

/**
 * 为一次请求解析出实际要使用的成员账号。
 *
 * 顺序：会话已有绑定且可用 → 直接复用；否则按策略选一个并写入绑定。
 * `exclude` 用于同一请求内的故障转移重试。
 */
export async function resolvePoolMember(
  pool: ProxyPoolRecord,
  sessionKey: string,
  exclude: readonly string[] = [],
): Promise<ResolvedPoolMember> {
  await initializeStorage();
  const storage = getStorage();
  const now = new Date();
  const members = await storage.listPoolMembers(pool.poolId);
  if (members.length === 0) throw new PoolEmptyError(pool.poolId);

  const excluded = new Set(exclude);

  // ① 已有会话绑定且该成员当前可用 → 复用
  //
  // ⚠️ 只有 sticky-affinity 才复用绑定。least-loaded / round-robin 的目的就是
  // 每次重新分配，如果这里无条件复用，它们第一次绑定后就退化成粘性了 —— 等于没分摊。
  if (pool.strategy === 'sticky-affinity' && excluded.size === 0) {
    const affinity = await storage.getSessionAffinity(pool.poolId, sessionKey);
    if (affinity) {
      const bound = members.find((m) => m.identity === affinity.identity);
      if (bound && isMemberAvailable(bound, now)) {
        // 续期，让活跃会话不会中途因 TTL 过期而被重新分配
        await storage.upsertSessionAffinity(
          pool.poolId,
          sessionKey,
          bound.identity,
          pool.sessionTtlSeconds,
        );
        return { pool, identity: bound.identity, reused: true };
      }
      // 绑定的成员不可用（冷却/移除）→ 丢弃绑定，下面重新选
      await storage.clearSessionAffinity(pool.poolId, sessionKey);
      logger.info('affinity-rebind', 'Bound member unavailable, reselecting', {
        poolId: pool.poolId,
        previous: affinity.identity,
      });
    }
  }

  // ② 选新成员
  const outcome = selectMember({ pool, members, sessionKey, exclude, now });
  if (outcome.kind === 'empty') throw new PoolEmptyError(pool.poolId);
  if (outcome.kind === 'all-cooling') {
    throw new PoolAllCoolingError(pool.poolId, outcome.retryAfterSeconds);
  }

  // 只有粘性策略才需要落绑定；其余策略每次重新分配，写了也不会被读
  if (pool.strategy === 'sticky-affinity') {
    await storage.upsertSessionAffinity(
      pool.poolId,
      sessionKey,
      outcome.identity,
      pool.sessionTtlSeconds,
    );
  }
  logger.info('member-selected', 'Selected pool member', {
    poolId: pool.poolId,
    identity: outcome.identity,
    reason: outcome.reason,
    excluded: exclude.length,
  });
  return { pool, identity: outcome.identity, reused: false };
}

export async function reportMemberSuccess(poolId: string, identity: string): Promise<void> {
  try {
    await initializeStorage();
    await getStorage().markMemberSuccess(poolId, identity);
  } catch (err) {
    logger.error('member-success', 'Failed to record member success', {
      poolId,
      identity,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 记一次失败。`forceCooldown` 用于 429 —— 限流应立刻冷却，不必等失败计数攒够。
 */
export async function reportMemberFailure(
  pool: ProxyPoolRecord,
  identity: string,
  options: { forceCooldown?: boolean } = {},
): Promise<boolean> {
  try {
    await initializeStorage();
    return await getStorage().markMemberFailure(
      pool.poolId,
      identity,
      pool.failureThreshold,
      pool.cooldownSeconds,
      options.forceCooldown ?? false,
    );
  } catch (err) {
    logger.error('member-failure', 'Failed to record member failure', {
      poolId: pool.poolId,
      identity,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export type { ProxyPoolMemberRecord, ProxyPoolRecord };
