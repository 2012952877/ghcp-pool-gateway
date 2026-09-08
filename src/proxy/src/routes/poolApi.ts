import { Router } from 'express';
import { apiError } from '@ghcp/shared';
import { getAccount } from '../db/accountsRepo.js';
import {
  addPoolMember,
  createPool,
  deletePool,
  getPool,
  getPoolDetail,
  listPoolMembers,
  listPools,
  pruneExpiredSessionAffinity,
  removePoolMember,
  updatePool,
} from '../db/poolRepo.js';
import { POOL_STRATEGIES, type PoolStrategy } from '../pool/poolTypes.js';
import { Logger } from '../logger.js';

export const poolApiRouter = Router();
const logger = new Logger('pool-api');

/** 池名不能和已有的普通账号 identity 撞车 —— 否则请求路由会出现二义 */
async function conflictsWithAccount(poolId: string): Promise<boolean> {
  return Boolean(await getAccount(poolId));
}

poolApiRouter.get('/pools', async (_req, res) => {
  const pools = await listPools();
  const detailed = await Promise.all(pools.map((p) => getPoolDetail(p.poolId)));
  res.json({ items: detailed.filter(Boolean), total: pools.length });
});

poolApiRouter.get('/pools/:poolId', async (req, res) => {
  const detail = await getPoolDetail(req.params.poolId);
  if (!detail) {
    res.status(404).json(apiError('pool_not_found', 'Pool was not found.'));
    return;
  }
  res.json(detail);
});

poolApiRouter.post('/pools', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const poolId = typeof body.poolId === 'string' ? body.poolId.trim() : '';
  if (!poolId) {
    res.status(400).json(apiError('pool_id_required', 'poolId is required.'));
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(poolId)) {
    res.status(400).json(apiError('pool_id_invalid', 'poolId contains unsupported characters.'));
    return;
  }
  if (await conflictsWithAccount(poolId)) {
    res.status(409).json(apiError(
      'pool_id_conflicts_with_account',
      `An account named "${poolId}" already exists; pool ids must not collide with account identities.`,
    ));
    return;
  }
  const strategy = readStrategy(body.strategy);
  if (body.strategy !== undefined && !strategy) {
    res.status(400).json(apiError('pool_strategy_invalid', `strategy must be one of: ${POOL_STRATEGIES.join(', ')}`));
    return;
  }
  const pool = await createPool({
    poolId,
    strategy,
    sessionTtlSeconds: readPositiveInt(body.sessionTtlSeconds),
    cooldownSeconds: readPositiveInt(body.cooldownSeconds),
    failureThreshold: readPositiveInt(body.failureThreshold),
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  });
  logger.info('pool-created', 'Created account pool', { poolId });
  res.status(201).json(await getPoolDetail(pool.poolId));
});

poolApiRouter.patch('/pools/:poolId', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const strategy = readStrategy(body.strategy);
  if (body.strategy !== undefined && !strategy) {
    res.status(400).json(apiError('pool_strategy_invalid', `strategy must be one of: ${POOL_STRATEGIES.join(', ')}`));
    return;
  }
  const updated = await updatePool(req.params.poolId, {
    strategy,
    sessionTtlSeconds: readPositiveInt(body.sessionTtlSeconds),
    cooldownSeconds: readPositiveInt(body.cooldownSeconds),
    failureThreshold: readPositiveInt(body.failureThreshold),
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  });
  if (!updated) {
    res.status(404).json(apiError('pool_not_found', 'Pool was not found.'));
    return;
  }
  logger.info('pool-updated', 'Updated account pool', { poolId: req.params.poolId });
  res.json(await getPoolDetail(updated.poolId));
});

poolApiRouter.delete('/pools/:poolId', async (req, res) => {
  const deleted = await deletePool(req.params.poolId);
  if (!deleted) {
    res.status(404).json(apiError('pool_not_found', 'Pool was not found.'));
    return;
  }
  logger.info('pool-deleted', 'Deleted account pool', { poolId: req.params.poolId });
  res.json({ deleted: true, poolId: req.params.poolId });
});

poolApiRouter.get('/pools/:poolId/members', async (req, res) => {
  if (!await getPool(req.params.poolId)) {
    res.status(404).json(apiError('pool_not_found', 'Pool was not found.'));
    return;
  }
  res.json({ items: await listPoolMembers(req.params.poolId) });
});

poolApiRouter.post('/pools/:poolId/members', async (req, res) => {
  const poolId = req.params.poolId;
  if (!await getPool(poolId)) {
    res.status(404).json(apiError('pool_not_found', 'Pool was not found.'));
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const identity = typeof body.identity === 'string' ? body.identity.trim() : '';
  if (!identity) {
    res.status(400).json(apiError('identity_required', 'identity is required.'));
    return;
  }
  // 成员必须是已存在且已授权的账号，否则请求打过去必然失败
  const account = await getAccount(identity);
  if (!account) {
    res.status(404).json(apiError('account_not_found', `Account "${identity}" does not exist. Onboard it first.`));
    return;
  }
  if (identity === poolId) {
    res.status(400).json(apiError('member_cannot_be_pool', 'A pool cannot contain itself.'));
    return;
  }
  const member = await addPoolMember({
    poolId,
    identity,
    weight: readPositiveInt(body.weight),
    state: body.state === 'disabled' ? 'disabled' : 'active',
  });
  logger.info('member-added', 'Added pool member', { poolId, identity });
  res.status(201).json({
    ...member,
    accountStatus: account.copilotOauthStatus,
    ghLogin: account.ghLogin,
  });
});

poolApiRouter.delete('/pools/:poolId/members/:identity', async (req, res) => {
  const removed = await removePoolMember(req.params.poolId, req.params.identity);
  if (!removed) {
    res.status(404).json(apiError('member_not_found', 'Pool member was not found.'));
    return;
  }
  logger.info('member-removed', 'Removed pool member', {
    poolId: req.params.poolId,
    identity: req.params.identity,
  });
  res.json({ removed: true, poolId: req.params.poolId, identity: req.params.identity });
});

/** 手动解除某成员的冷却（排障用） */
poolApiRouter.post('/pools/:poolId/members/:identity/resume', async (req, res) => {
  const { poolId, identity } = req.params;
  const members = await listPoolMembers(poolId);
  if (!members.some((m) => m.identity === identity)) {
    res.status(404).json(apiError('member_not_found', 'Pool member was not found.'));
    return;
  }
  await addPoolMember({ poolId, identity, state: 'active' });
  const { getStorage, initializeStorage } = await import('../db/connection.js');
  await initializeStorage();
  await getStorage().markMemberSuccess(poolId, identity);
  logger.info('member-resumed', 'Manually resumed pool member', { poolId, identity });
  res.json(await getPoolDetail(poolId));
});

poolApiRouter.post('/pools/maintenance/prune-sessions', async (_req, res) => {
  const removed = await pruneExpiredSessionAffinity();
  res.json({ removed });
});

function readStrategy(value: unknown): PoolStrategy | undefined {
  if (typeof value !== 'string') return undefined;
  return POOL_STRATEGIES.includes(value as PoolStrategy) ? (value as PoolStrategy) : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n > 0 ? n : undefined;
}
