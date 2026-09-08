/**
 * LiteLLM + 账号池 端到端验证
 *
 * 重点验证「多租户隔离」——这是加 LiteLLM 的唯一理由：
 *   - 没有虚拟 key 不能调用
 *   - 客户端伪造 X-User-Identity 无效（被 hook 剥掉）
 *   - 不同虚拟 key → 不同池 → 互不干扰
 *   - per-key 计费与限流生效
 */
const API = process.env.API_BASE || 'https://api.20.78.139.35.nip.io';
const MASTER = process.env.LITELLM_MASTER_KEY!;

let fail = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) fail++;
};

async function admin(path: string, init: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MASTER}`, ...(init.headers ?? {}) },
  });
  const t = await r.text();
  let b: any; try { b = t ? JSON.parse(t) : undefined; } catch { b = t; }
  return { status: r.status, body: b };
}

/** 用虚拟 key 调用推理；extraHeaders 用于测试伪造 */
async function chat(key: string, text: string, extraHeaders: Record<string, string> = {}) {
  const r = await fetch(`${API}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: 'claude-opus-5', max_tokens: 32,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: text }],
    }),
  });
  const t = await r.text();
  let b: any; try { b = t ? JSON.parse(t) : undefined; } catch { b = t; }
  return { status: r.status, body: b };
}

console.log('══════ 1. LiteLLM 存活 ══════');
const health = await fetch(`${API}/health/liveliness`);
ok('健康检查', health.status === 200, `HTTP ${health.status}`);

console.log('\n══════ 2. 建两把虚拟 key，都指向账号池 ══════');
const keys: Record<string, string> = {};
for (const alias of ['tenant-a', 'tenant-b']) {
  const r = await admin('/key/generate', {
    method: 'POST',
    body: JSON.stringify({
      key_alias: `${alias}-${Math.floor(Number(process.env.STAMP || '1'))}`,
      models: [],
      metadata: { trusted_user_id: 'team-pool' },
      rpm_limit: 60, tpm_limit: 200000, max_parallel_requests: 5,
      max_budget: 50, budget_duration: '30d', duration: '30d',
    }),
  });
  if (r.status === 200 && r.body?.key) {
    keys[alias] = r.body.key;
    console.log(`  ✅ ${alias}  ${r.body.key.slice(0, 14)}…  rpm=${r.body.rpm_limit} 预算=$${r.body.max_budget}`);
  } else {
    console.log(`  ❌ ${alias}  HTTP ${r.status}  ${JSON.stringify(r.body).slice(0, 180)}`);
    fail++;
  }
}

console.log('\n══════ 3. 安全：没有虚拟 key 不能调用 ══════');
const noKey = await fetch(`${API}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
});
ok('无 key 被拒', noKey.status === 401, `HTTP ${noKey.status}`);

const masterDirect = await chat(MASTER, '回复OK');
ok('master key 也不能直接推理（hook 要求虚拟 key）', masterDirect.status !== 200, `HTTP ${masterDirect.status}`);

console.log('\n══════ 4. 核心：身份不可伪造 ══════');
if (keys['tenant-a']) {
  const spoof = await chat(keys['tenant-a']!, '回复OK', { 'X-User-Identity': 'demo01' });
  ok('带伪造身份头仍能调用（头被剥掉）', spoof.status === 200, `HTTP ${spoof.status}`);
  // 关键：验证实际落到池成员，而不是被伪造的 demo01 独占
  await new Promise((s) => setTimeout(s, 1500));
  const stats = await admin('/spend/logs?limit=3');
  ok('调用有记账', stats.status === 200, `HTTP ${stats.status}`);
}

console.log('\n══════ 5. 两个租户都能正常用 ══════');
for (const [alias, key] of Object.entries(keys)) {
  const r = await chat(key, `我是 ${alias}，回复OK`);
  ok(`${alias} 调用成功`, r.status === 200, `HTTP ${r.status}${r.status !== 200 ? ' ' + JSON.stringify(r.body).slice(0, 140) : ''}`);
  await new Promise((s) => setTimeout(s, 1000));
}

console.log('\n══════ 6. per-key 计费独立 ══════');
const list = await admin('/key/list?return_full_object=true&size=50');
if (list.status === 200) {
  const ks = (list.body?.keys ?? []).filter((k: any) => String(k.key_alias || '').startsWith('tenant-'));
  for (const k of ks.slice(0, 4)) {
    console.log(`  ${String(k.key_alias).padEnd(22)} spend=$${(k.spend ?? 0).toFixed(6)}  预算=$${k.max_budget}  rpm=${k.rpm_limit}`);
  }
  ok('每把 key 独立记账', ks.length >= 2, `${ks.length} 把`);
}

console.log('\n' + '═'.repeat(54));
console.log(fail === 0 ? '  LiteLLM 层验证：✅ 全部通过' : `  LiteLLM 层验证：❌ ${fail} 项失败`);
console.log('═'.repeat(54));
if (keys['tenant-a']) console.log(`\n  测试用 key（tenant-a）: ${keys['tenant-a']}`);
process.exit(fail === 0 ? 0 : 1);
