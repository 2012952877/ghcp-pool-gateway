/**
 * 端到端验证账号池：本地起 Proxy（SQLite），种入两个真实 Copilot 账号，
 * 建池 → 发真实请求 → 验证会话粘性、分散、缓存命中、故障转移。
 */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

process.env.DB_PATH = ':memory:';
process.env.INTERNAL_API_TOKEN = 'e2e-token';
process.env.LOG_LEVEL = 'error';
process.env.SSO_BASE_URL = 'http://127.0.0.1:1';
process.env.IDENTITY_HEADER_REQUIRED = 'true';
process.env.API_KEY = 'e2e-inbound-key';

const { INTERNAL_AUTH_HEADER } = await import('@ghcp/shared');
const { buildApp } = await import('./src/proxy/src/server.js');
const { initializeStorage, getStorage } = await import('./src/proxy/src/db/connection.js');

const seed = JSON.parse(readFileSync('./seed-accounts.json', 'utf8')) as Array<{
  identity: string; sso_user: string; gh_login: string; copilot_oauth_token: string;
}>;

const app = buildApp();
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', () => r()));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;
const POOL = 'team-pool';

async function adminApi(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', [INTERNAL_AUTH_HEADER]: 'e2e-token', ...(init.headers ?? {}) },
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : undefined };
}

/** 模拟 LiteLLM：注入 X-User-Identity 后打 Proxy */
async function chat(identity: string, systemPrompt: string, userText: string, sessionId?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-Identity': identity,
    'anthropic-version': '2023-06-01',
    'x-api-key': 'e2e-inbound-key',
  };
  if (sessionId) headers['X-Session-Id'] = sessionId;
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 40,
      thinking: { type: 'disabled' },
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  const t = await res.text();
  let body: any; try { body = JSON.parse(t); } catch { body = t; }
  return { status: res.status, body };
}

const line = (s = '') => console.log(s);
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  line(`  ${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

try {
  await initializeStorage();
  const storage = getStorage();

  line('══════ 准备 ══════');
  for (const a of seed) {
    await storage.importCopilotOauthToken({
      identity: a.identity, ssoUser: a.sso_user, ghLogin: a.gh_login,
      copilotOauthToken: a.copilot_oauth_token,
    });
  }
  line(`  种入 ${seed.length} 个真实账号: ${seed.map((s) => s.identity).join(', ')}`);

  const created = await adminApi('/pools', {
    method: 'POST',
    body: JSON.stringify({ poolId: POOL, sessionTtlSeconds: 600, cooldownSeconds: 60 }),
  });
  line(`  建池 ${POOL}  HTTP ${created.status}`);
  for (const a of seed) {
    const r = await adminApi(`/pools/${POOL}/members`, { method: 'POST', body: JSON.stringify({ identity: a.identity }) });
    line(`  加入成员 ${a.identity}  HTTP ${r.status}`);
  }

  // ── 1. 1:1 模式未受影响 ─────────────────────────────
  line();
  line('══════ 1. 回归：1:1 模式仍然正常 ══════');
  const direct = await chat('Demo01', 'You are a test bot.', '回复OK');
  check('直接用 Demo01（非池）能正常调用', direct.status === 200, `HTTP ${direct.status}`);
  const stats1 = await storage.listRequestStats('Demo01', 5);
  check('统计记在 Demo01 名下且 pool_id 为空', stats1.length > 0 && !(stats1[0] as any).poolId);

  // ── 2. 会话粘性 ───────────────────────────────────
  line();
  line('══════ 2. 会话粘性：同一会话固定同一账号 ══════');
  const SYS = 'You are a helpful assistant for session stickiness testing.';
  const used: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await chat(POOL, SYS, `第 ${i + 1} 轮，回复OK`, 'session-A');
    if (r.status !== 200) { check(`第 ${i + 1} 轮请求`, false, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`); break; }
    const affinity = await storage.getSessionAffinity(POOL, (await import('./src/proxy/src/pool/sessionKey.js'))
      .deriveSessionKey({ headers: { 'x-session-id': 'session-A' } } as any, undefined).key);
    used.push(affinity?.identity ?? '?');
  }
  check('4 轮请求全部成功', used.length === 4, `实际 ${used.length} 轮`);
  check('4 轮落在同一账号', new Set(used).size === 1, `账号序列: ${used.join(' → ')}`);

  // ── 3. 不同会话分散 ───────────────────────────────
  line();
  line('══════ 3. 不同会话分散到多个账号 ══════');
  const spread = new Map<string, string>();
  for (let i = 0; i < 8; i++) {
    const sid = `session-spread-${i}`;
    const r = await chat(POOL, `System prompt variant ${i}`, '回复OK', sid);
    if (r.status !== 200) continue;
    const key = (await import('./src/proxy/src/pool/sessionKey.js'))
      .deriveSessionKey({ headers: { 'x-session-id': sid } } as any, undefined).key;
    const aff = await storage.getSessionAffinity(POOL, key);
    if (aff) spread.set(sid, aff.identity);
  }
  const distinct = new Set(spread.values());
  check('8 个会话覆盖到多个账号', distinct.size >= 2, `覆盖 ${distinct.size} 个: ${[...distinct].join(', ')}`);

  // ── 4. 统计归因 ──────────────────────────────────
  line();
  line('══════ 4. 统计归因：记成员账号 + 池名 ══════');
  let poolStatCount = 0;
  for (const a of seed) {
    const st = await storage.listRequestStats(a.identity, 50);
    poolStatCount += st.filter((s: any) => s.poolId === POOL).length;
  }
  check('池请求记在成员账号名下并带 pool_id', poolStatCount > 0, `${poolStatCount} 条`);
  const poolNameStats = await storage.listRequestStats(POOL, 10);
  check('不会错误地把统计记在池名下', poolNameStats.length === 0, `池名下 ${poolNameStats.length} 条`);

  // ── 5. 故障转移 ──────────────────────────────────
  line();
  line('══════ 5. 故障转移：账号冷却后自动改绑 ══════');
  const beforeKey = (await import('./src/proxy/src/pool/sessionKey.js'))
    .deriveSessionKey({ headers: { 'x-session-id': 'session-A' } } as any, undefined).key;
  const boundBefore = (await storage.getSessionAffinity(POOL, beforeKey))!.identity;
  await storage.markMemberFailure(POOL, boundBefore, 1, 300, true);
  const after = await chat(POOL, SYS, '冷却后重试，回复OK', 'session-A');
  const boundAfter = (await storage.getSessionAffinity(POOL, beforeKey))?.identity;
  check('冷却后请求仍成功', after.status === 200, `HTTP ${after.status}`);
  check('已切换到另一个账号', boundAfter !== undefined && boundAfter !== boundBefore, `${boundBefore} → ${boundAfter}`);

  // ── 6. 池详情 ────────────────────────────────────
  line();
  line('══════ 6. 池状态可观测 ══════');
  const detail = await adminApi(`/pools/${POOL}`);
  check('池详情可读', detail.status === 200);
  line(`  成员状态: ${detail.body.members.map((m: any) => `${m.identity}=${m.state}`).join(', ')}`);
  line(`  可用 ${detail.body.activeMembers}/${detail.body.totalMembers}`);

  line();
  line('═'.repeat(52));
  line(failures === 0 ? '  结果：✅ 全部通过' : `  结果：❌ ${failures} 项失败`);
  line('═'.repeat(52));
} catch (err) {
  console.error('E2E 异常:', err);
  failures++;
} finally {
  await new Promise<void>((r) => server.close(() => r()));
  process.exit(failures === 0 ? 0 : 1);
}
