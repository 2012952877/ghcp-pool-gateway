// 独立验证 Rendezvous 选择算法的三个关键性质（与 poolSelector.ts 同算法）
const { createHash } = require('crypto');

function weightedScore(sessionKey, identity, weight) {
  const d = createHash('sha256').update(`${sessionKey} ${identity}`).digest();
  const raw = d.readUIntBE(0, 6) / 0x1000000000000;
  const unit = Math.min(Math.max(raw, Number.EPSILON), 1 - Number.EPSILON);
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1;
  return -w / Math.log(unit);
}
function pick(members, sessionKey) {
  let best = members[0], bestScore = -Infinity;
  for (const m of members) {
    const s = weightedScore(sessionKey, m.identity, m.weight);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best.identity;
}
const mk = (n, w = 1) => Array.from({ length: n }, (_, i) => ({ identity: `acct-${String(i).padStart(3, '0')}`, weight: w }));
const keys = (n) => Array.from({ length: n }, (_, i) => createHash('sha256').update(`session-${i}`).digest('hex'));

// ── 性质 1：粘性（同 key 必同成员）
const pool100 = mk(100), K = keys(10000);
let stable = true;
for (const k of K.slice(0, 200)) {
  const first = pick(pool100, k);
  for (let r = 0; r < 20; r++) if (pick(pool100, k) !== first) stable = false;
}
console.log(`【性质1】粘性：同一 sessionKey 重复选择 20 次结果一致  → ${stable ? '✅ 通过' : '❌ 失败'}`);

// ── 性质 2：分布均匀度
const count = {};
for (const k of K) { const id = pick(pool100, k); count[id] = (count[id] || 0) + 1; }
const vals = Object.values(count);
const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
console.log(`【性质2】分布：10000 会话 / 100 账号  均值=${mean.toFixed(1)} 标准差=${sd.toFixed(1)} 变异系数=${(sd / mean * 100).toFixed(1)}%  最少=${Math.min(...vals)} 最多=${Math.max(...vals)}  → ${sd / mean < 0.2 ? '✅ 均匀' : '⚠️ 偏斜'}`);
console.log(`          覆盖账号数 ${vals.length}/100`);

// ── 性质 3：成员移除时的重映射范围（最重要 —— 决定缓存损失面）
const before = {}; for (const k of K) before[k] = pick(pool100, k);
const removed = 'acct-042';
const pool99 = pool100.filter((m) => m.identity !== removed);
let remapped = 0, remappedFromOther = 0;
for (const k of K) {
  const now = pick(pool99, k);
  if (now !== before[k]) { remapped++; if (before[k] !== removed) remappedFromOther++; }
}
console.log(`【性质3】移除 1 个账号：重映射 ${remapped}/10000 (${(remapped / 100).toFixed(1)}%)，其中「本不该动却动了」的 ${remappedFromOther}  → ${remappedFromOther === 0 ? '✅ 只影响被移除账号的会话' : '❌ 波及无关会话'}`);

// ── 性质 4：权重生效
const weighted = [{ identity: 'big', weight: 8 }, { identity: 'small-1', weight: 1 }, { identity: 'small-2', weight: 1 }];
const wc = {};
for (const k of K) { const id = pick(weighted, k); wc[id] = (wc[id] || 0) + 1; }
const bigPct = (wc['big'] / K.length * 100).toFixed(1);
console.log(`【性质4】权重 8:1:1 → big=${bigPct}% (理论 80%)  small-1=${(wc['small-1'] / 100).toFixed(1)}%  small-2=${(wc['small-2'] / 100).toFixed(1)}%  → ${Math.abs(bigPct - 80) < 3 ? '✅ 符合' : '⚠️ 偏差大'}`);

// ── 对比：如果用逐请求轮询，缓存命中率会怎样
console.log('');
console.log('【对比】同一会话连发 20 个请求，落在几个不同账号上：');
console.log(`   Rendezvous 粘性 : 1 个账号   → 缓存命中率 ~95%（首次 write，其余 read）`);
console.log(`   逐请求轮询(100) : 20 个账号  → 缓存命中率 0%（每次都是 cache_write）`);
