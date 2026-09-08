import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

process.env.DB_PATH = ':memory:';
process.env.INTERNAL_API_TOKEN = 'test-token';
process.env.LOG_LEVEL = 'error';
process.env.SSO_BASE_URL = 'http://127.0.0.1:1';

const { INTERNAL_AUTH_HEADER } = await import('@ghcp/shared');
const { buildApp } = await import('../server.js');
const { initializeStorage, getStorage } = await import('../db/connection.js');

const TOKEN = 'test-token';
let base = '';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      [INTERNAL_AUTH_HEADER]: TOKEN,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body };
}

test('账号池管理 API 端到端', async (t) => {
  const app = buildApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  // 预置两个真实存在的账号，作为池成员
  await initializeStorage();
  const storage = getStorage();
  for (const id of ['demo01', 'demo02']) {
    await storage.importCopilotOauthToken({
      identity: id,
      ssoUser: id,
      ghLogin: id,
      copilotOauthToken: `gho_fake_${id}`,
    });
  }

  await t.test('未带内部 token 应被拒', async () => {
    const res = await fetch(`${base}/pools`);
    assert.equal(res.status, 401);
  });

  await t.test('创建池', async () => {
    const r = await api('/pools', {
      method: 'POST',
      body: JSON.stringify({ poolId: 'team-alpha', sessionTtlSeconds: 900, cooldownSeconds: 120 }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.poolId, 'team-alpha');
    assert.equal(r.body.strategy, 'least-loaded', '默认策略应为 least-loaded');
    assert.equal(r.body.sessionTtlSeconds, 900);
    assert.equal(r.body.totalMembers, 0);
  });

  await t.test('池名不能和已有账号撞车', async () => {
    const r = await api('/pools', { method: 'POST', body: JSON.stringify({ poolId: 'demo01' }) });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'pool_id_conflicts_with_account');
  });

  await t.test('非法策略被拒', async () => {
    const r = await api('/pools', { method: 'POST', body: JSON.stringify({ poolId: 'p2', strategy: 'nope' }) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'pool_strategy_invalid');
  });

  await t.test('加成员', async () => {
    for (const identity of ['demo01', 'demo02']) {
      const r = await api('/pools/team-alpha/members', {
        method: 'POST',
        body: JSON.stringify({ identity }),
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.identity, identity);
      assert.equal(r.body.state, 'active');
    }
    const detail = await api('/pools/team-alpha');
    assert.equal(detail.body.totalMembers, 2);
    assert.equal(detail.body.activeMembers, 2);
  });

  await t.test('不存在的账号不能加进池', async () => {
    const r = await api('/pools/team-alpha/members', {
      method: 'POST',
      body: JSON.stringify({ identity: 'ghost-account' }),
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'account_not_found');
  });

  await t.test('池不能包含自己', async () => {
    await api('/pools', { method: 'POST', body: JSON.stringify({ poolId: 'self-ref' }) });
    const r = await api('/pools/self-ref/members', {
      method: 'POST',
      body: JSON.stringify({ identity: 'self-ref' }),
    });
    assert.equal(r.status, 404); // self-ref 不是账号，先被 account_not_found 挡住
  });

  await t.test('改池配置', async () => {
    const r = await api('/pools/team-alpha', {
      method: 'PATCH',
      body: JSON.stringify({ strategy: 'least-loaded', enabled: false }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.strategy, 'least-loaded');
    assert.equal(r.body.enabled, false);
    // 改回来
    await api('/pools/team-alpha', {
      method: 'PATCH',
      body: JSON.stringify({ strategy: 'sticky-affinity', enabled: true }),
    });
  });

  await t.test('列出所有池', async () => {
    const r = await api('/pools');
    assert.equal(r.status, 200);
    assert.ok(r.body.items.some((p: any) => p.poolId === 'team-alpha'));
  });

  await t.test('手动解除冷却', async () => {
    await storage.markMemberFailure('team-alpha', 'demo01', 1, 600, true);
    let members = await storage.listPoolMembers('team-alpha');
    assert.equal(members.find((m) => m.identity === 'demo01')!.state, 'cooling');

    const r = await api('/pools/team-alpha/members/demo01/resume', { method: 'POST' });
    assert.equal(r.status, 200);
    members = await storage.listPoolMembers('team-alpha');
    assert.equal(members.find((m) => m.identity === 'demo01')!.state, 'active');
  });

  await t.test('移除成员', async () => {
    const r = await api('/pools/team-alpha/members/demo02', { method: 'DELETE' });
    assert.equal(r.status, 200);
    const detail = await api('/pools/team-alpha');
    assert.equal(detail.body.totalMembers, 1);
  });

  await t.test('清理过期会话绑定', async () => {
    const r = await api('/pools/maintenance/prune-sessions', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.removed, 'number');
  });

  await t.test('删除池', async () => {
    const r = await api('/pools/team-alpha', { method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal((await api('/pools/team-alpha')).status, 404);
  });

  await new Promise<void>((r) => server.close(() => r()));
});
