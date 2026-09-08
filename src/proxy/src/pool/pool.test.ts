import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.INTERNAL_API_TOKEN = 'test-token';
process.env.LOG_LEVEL = 'error';

const { initializeStorage, getStorage } = await import('../db/connection.js');
const { findPool, resolvePoolMember, reportMemberFailure, reportMemberSuccess } =
  await import('./poolResolver.js');
const { deriveSessionKey } = await import('./sessionKey.js');

const POOL = 'pool-test';
const MEMBERS = ['acct-a', 'acct-b', 'acct-c', 'acct-d'];

async function setupPool(overrides: Record<string, unknown> = {}) {
  await initializeStorage();
  const storage = getStorage();
  // 显式指定策略：默认已改为 least-loaded，粘性相关用例必须自己声明
  await storage.createPool({ poolId: POOL, strategy: 'sticky-affinity', cooldownSeconds: 60, failureThreshold: 2, ...overrides });
  for (const identity of MEMBERS) {
    await storage.addPoolMember({ poolId: POOL, identity, state: 'active' });
  }
  return storage;
}

function fakeReq(headers: Record<string, string> = {}) {
  return { headers } as unknown as Parameters<typeof deriveSessionKey>[0];
}

test('1:1 身份不会被误判为池', async () => {
  await setupPool();
  assert.equal(await findPool('some-normal-identity'), undefined);
  assert.ok(await findPool(POOL));
});

test('禁用的池回落为普通身份', async () => {
  const storage = await setupPool();
  await storage.updatePool(POOL, { enabled: false });
  assert.equal(await findPool(POOL), undefined);
  await storage.updatePool(POOL, { enabled: true });
  assert.ok(await findPool(POOL));
});

test('会话粘性：同一 sessionKey 反复解析落在同一成员', async () => {
  await setupPool();
  const pool = (await findPool(POOL))!;
  const key = 'session-sticky';
  const first = await resolvePoolMember(pool, key);
  assert.equal(first.reused, false);
  for (let i = 0; i < 10; i++) {
    const again = await resolvePoolMember(pool, key);
    assert.equal(again.identity, first.identity, '同一会话必须落到同一账号');
    assert.equal(again.reused, true, '第二次起应命中已有绑定');
  }
});

test('不同会话会分散到多个成员', async () => {
  await setupPool();
  const pool = (await findPool(POOL))!;
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const r = await resolvePoolMember(pool, `session-spread-${i}`);
    seen.add(r.identity);
  }
  assert.ok(seen.size >= 3, `应覆盖多个账号，实际 ${seen.size}`);
});

test('429 立刻冷却该成员，会话自动改绑到别的成员', async () => {
  const storage = await setupPool();
  const pool = (await findPool(POOL))!;
  const key = 'session-failover';
  const before = await resolvePoolMember(pool, key);

  // 429 → forceCooldown，不必攒够失败次数
  const cooled = await reportMemberFailure(pool, before.identity, { forceCooldown: true });
  assert.equal(cooled, true, '429 应立刻进入冷却');

  const after = await resolvePoolMember(pool, key);
  assert.notEqual(after.identity, before.identity, '冷却后必须换成员');

  const members = await storage.listPoolMembers(POOL);
  const cooledMember = members.find((m) => m.identity === before.identity)!;
  assert.equal(cooledMember.state, 'cooling');
  assert.ok(cooledMember.coolingUntil);
});

test('普通失败要攒够阈值才冷却', async () => {
  await setupPool();
  const pool = (await findPool(POOL))!;
  const target = MEMBERS[0]!;
  assert.equal(await reportMemberFailure(pool, target), false, '第 1 次失败不应冷却');
  assert.equal(await reportMemberFailure(pool, target), true, '第 2 次达到阈值应冷却');
});

test('成功会清零失败计数并解除冷却', async () => {
  const storage = await setupPool();
  const pool = (await findPool(POOL))!;
  const target = MEMBERS[1]!;
  await reportMemberFailure(pool, target, { forceCooldown: true });
  await reportMemberSuccess(POOL, target);
  const member = (await storage.listPoolMembers(POOL)).find((m) => m.identity === target)!;
  assert.equal(member.state, 'active');
  assert.equal(member.consecutiveFailures, 0);
  assert.equal(member.coolingUntil, undefined);
});

test('全员冷却时抛 PoolAllCoolingError 并给出 retryAfter', async () => {
  await setupPool();
  const pool = (await findPool(POOL))!;
  for (const m of MEMBERS) await reportMemberFailure(pool, m, { forceCooldown: true });
  await assert.rejects(
    () => resolvePoolMember(pool, 'session-all-cooling'),
    (err: any) => {
      assert.equal(err.name, 'PoolAllCoolingError');
      assert.ok(err.retryAfterSeconds > 0);
      return true;
    },
  );
});

test('移除成员时该成员的会话绑定一并清理', async () => {
  const storage = await setupPool();
  const pool = (await findPool(POOL))!;
  const key = 'session-remove';
  const bound = await resolvePoolMember(pool, key);
  assert.ok(await storage.getSessionAffinity(POOL, key));
  await storage.removePoolMember(POOL, bound.identity);
  assert.equal(await storage.getSessionAffinity(POOL, key), undefined);
  const next = await resolvePoolMember(pool, key);
  assert.notEqual(next.identity, bound.identity);
});

test('会话 key 推导优先级：header > metadata > prompt 前缀', () => {
  const withHeader = deriveSessionKey(fakeReq({ 'x-session-id': 'abc' }), { metadata: { user_id: 'u1' } });
  assert.equal(withHeader.origin, 'header');

  const withMeta = deriveSessionKey(fakeReq(), { metadata: { user_id: 'u1' }, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(withMeta.origin, 'metadata');

  const withPrompt = deriveSessionKey(fakeReq(), { system: 'You are a helpful assistant', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(withPrompt.origin, 'prompt-prefix');

  const empty = deriveSessionKey(fakeReq(), undefined);
  assert.equal(empty.origin, 'fallback');
});

test('相同 prompt 前缀 → 相同会话 key（缓存亲和的基础）', () => {
  const a = deriveSessionKey(fakeReq(), {
    system: 'SYSTEM PROMPT AAA',
    messages: [{ role: 'user', content: '第一个问题' }],
  });
  const b = deriveSessionKey(fakeReq(), {
    system: 'SYSTEM PROMPT AAA',
    messages: [{ role: 'user', content: '第一个问题' }],
  });
  const c = deriveSessionKey(fakeReq(), {
    system: 'SYSTEM PROMPT BBB',
    messages: [{ role: 'user', content: '第一个问题' }],
  });
  assert.equal(a.key, b.key, '相同前缀必须得到相同 key');
  assert.notEqual(a.key, c.key, '不同系统提示词应得到不同 key');
});
