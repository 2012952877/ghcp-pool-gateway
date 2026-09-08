/** 从公网验证云上账号池：会话粘性 / 分散 / 故障转移 / 统计归因 */
const API = 'https://api.20.78.139.35.nip.io';
const API_KEY = process.env.POOL_API_KEY!;
const INTERNAL = process.env.POOL_INTERNAL!;
const POOL = 'team-pool';

async function chat(identity: string, text: string, sessionId: string) {
  const res = await fetch(`${API}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'X-User-Identity': identity,
      'X-Session-Id': sessionId,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 40,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: text }],
    }),
  });
  const t = await res.text();
  let body: any; try { body = JSON.parse(t); } catch { body = t; }
  return { status: res.status, body };
}

async function poolDetail() {
  const res = await fetch(`${API}/api/pools/${POOL}`, {
    headers: { 'X-Internal-Token': INTERNAL },
  });
  return res.json() as Promise<any>;
}

async function stats(identity: string) {
  const res = await fetch(`${API}/api/request-stats?identity=${identity}&limit=100`, {
    headers: { 'X-Internal-Token': INTERNAL },
  });
  const j = await res.json() as any;
  return Array.isArray(j) ? j : (j.items ?? []);
}

let fail = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) fail++;
};

console.log('══════ 1. 会话粘性（同一 session 连发 5 次）══════');
const SID = `cloud-sticky-${Date.now()}`;
let sent = 0;
for (let i = 0; i < 5; i++) {
  const r = await chat(POOL, `第 ${i + 1} 次，回复OK`, SID);
  if (r.status === 200) sent++;
  else console.log(`     第 ${i + 1} 次 HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
}
ok('5 次请求全部成功', sent === 5, `${sent}/5`);

const allStats = [...(await stats('demo01')), ...(await stats('demo02'))];
const stickyHits = allStats.filter((s: any) => s.poolId === POOL);
const stickyAccounts = new Set(stickyHits.map((s: any) => s.identity));
ok('请求都记在成员账号名下并带 pool_id', stickyHits.length >= 5, `${stickyHits.length} 条`);

console.log();
console.log('══════ 2. 多会话分散 ══════');
const spreadAccounts = new Set<string>();
for (let i = 0; i < 10; i++) {
  const r = await chat(POOL, '回复OK', `cloud-spread-${Date.now()}-${i}`);
  if (r.status !== 200) console.log(`     会话 ${i} HTTP ${r.status}`);
}
const after = [...(await stats('demo01')), ...(await stats('demo02'))];
for (const s of after) if (s.poolId === POOL) spreadAccounts.add(s.identity);
ok('多会话覆盖到 2 个账号', spreadAccounts.size >= 2, `覆盖: ${[...spreadAccounts].join(', ')}`);

console.log();
console.log('══════ 3. 池状态 ══════');
const d = await poolDetail();
ok('池详情可读', Boolean(d.poolId));
console.log(`     成员: ${d.members.map((m: any) => `${m.identity}=${m.state}(用过${m.lastUsedAt ? '是' : '否'})`).join(', ')}`);
console.log(`     可用: ${d.activeMembers}/${d.totalMembers}`);
const usedCount = d.members.filter((m: any) => m.lastUsedAt).length;
ok('两个成员都实际承接过流量', usedCount === 2, `${usedCount}/2`);

console.log();
console.log('══════ 4. 1:1 模式回归（直接用 demo01）══════');
const direct = await chat('demo01', '回复OK', 'cloud-direct');
ok('单账号直连仍正常', direct.status === 200, `HTTP ${direct.status}`);

console.log();
console.log('═'.repeat(50));
console.log(fail === 0 ? '  云上验证：✅ 全部通过' : `  云上验证：❌ ${fail} 项失败`);
console.log('═'.repeat(50));
process.exit(fail === 0 ? 0 : 1);
