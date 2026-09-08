import { getStorage, initializeStorage } from './connection.js';
import type {
  AddPoolMemberInput,
  CreatePoolInput,
  ProxyPoolMemberRecord,
  ProxyPoolRecord,
  UpdatePoolInput,
} from './storageTypes.js';

export type {
  AddPoolMemberInput,
  CreatePoolInput,
  ProxyPoolMemberRecord,
  ProxyPoolRecord,
  UpdatePoolInput,
} from './storageTypes.js';

export async function listPools(): Promise<ProxyPoolRecord[]> {
  await initializeStorage();
  return getStorage().listPools();
}

export async function getPool(poolId: string): Promise<ProxyPoolRecord | undefined> {
  await initializeStorage();
  return getStorage().getPool(poolId);
}

export async function createPool(input: CreatePoolInput): Promise<ProxyPoolRecord> {
  await initializeStorage();
  return getStorage().createPool(input);
}

export async function updatePool(
  poolId: string,
  input: UpdatePoolInput,
): Promise<ProxyPoolRecord | undefined> {
  await initializeStorage();
  return getStorage().updatePool(poolId, input);
}

export async function deletePool(poolId: string): Promise<boolean> {
  await initializeStorage();
  return getStorage().deletePool(poolId);
}

export async function listPoolMembers(poolId: string): Promise<ProxyPoolMemberRecord[]> {
  await initializeStorage();
  return getStorage().listPoolMembers(poolId);
}

export async function addPoolMember(input: AddPoolMemberInput): Promise<ProxyPoolMemberRecord> {
  await initializeStorage();
  return getStorage().addPoolMember(input);
}

export async function removePoolMember(poolId: string, identity: string): Promise<boolean> {
  await initializeStorage();
  return getStorage().removePoolMember(poolId, identity);
}

export async function pruneExpiredSessionAffinity(): Promise<number> {
  await initializeStorage();
  return getStorage().pruneExpiredSessionAffinity();
}

/** 池视图：池本身 + 成员 + 每个成员的实时可用性 */
export interface PoolDetail extends ProxyPoolRecord {
  members: Array<ProxyPoolMemberRecord & { available: boolean }>;
  activeMembers: number;
  totalMembers: number;
}

export async function getPoolDetail(poolId: string): Promise<PoolDetail | undefined> {
  const pool = await getPool(poolId);
  if (!pool) return undefined;
  const members = await listPoolMembers(poolId);
  const now = Date.now();
  const decorated = members.map((m) => ({
    ...m,
    available:
      m.state === 'active'
      || (m.state === 'cooling' && (!m.coolingUntil || new Date(m.coolingUntil).getTime() <= now)),
  }));
  return {
    ...pool,
    members: decorated,
    activeMembers: decorated.filter((m) => m.available).length,
    totalMembers: decorated.length,
  };
}
