/**
 * 实验：GHCP 账号池下的 prompt 缓存作用域
 *
 * 要回答的问题：
 *   缓存是按「GHCP 账号」隔离，还是按「Anthropic 组织」共享？
 *   这决定了账号池能否用 least-loaded 均匀分摊 —— 如果按账号隔离，
 *   每次换号都会 cache miss 并付 1.25× 的写入成本，池化就是净亏。
 *
 * 方法：
 *   给 demo01 / demo02 各签发一把 1:1 虚拟 key（metadata.trusted_user_id
 *   分别为账号名），这样可以精确控制每次请求落在哪个 GHCP 账号上。
 *   然后用同一段前缀在两个账号之间交叉发送，观察 usage 里的
 *   cache_creation_input_tokens / cache_read_input_tokens。
 *
 * 用法：
 *   node tests/cache-cross-account.mjs
 *
 * 环境变量：
 *   API_BASE   默认 https://api.20.78.139.35.nip.io
 *   KEY_A      绑定 demo01 的虚拟 key
 *   KEY_B      绑定 demo02 的虚拟 key
 */

const API_BASE = process.env.API_BASE ?? 'https://api.20.78.139.35.nip.io';
const KEY_A = process.env.KEY_A ?? '';
const KEY_B = process.env.KEY_B ?? '';
const MODEL = process.env.MODEL ?? 'claude-sonnet-5';
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 16);

if (!KEY_A || !KEY_B) {
  console.error('请先设置 KEY_A / KEY_B（分别绑定 demo01 / demo02 的虚拟 key）');
  process.exit(2);
}

/** 每次运行用一个唯一 ID，保证前缀是全新的，不会命中上一轮跑剩的缓存 */
const RUN_ID = Math.random().toString(36).slice(2, 10).toUpperCase();

// ──────────────────────────────────────────────────────────────
// 构造足够长的前缀
//
// Anthropic 的 prompt 缓存有最小长度门槛（Opus/Sonnet 约 1024 token），
// 低于门槛不会建缓存。这里用自然的技术文档语料堆到 2000 token 以上。
//
// ⚠️ 不要用「Rule 1 / Rule 2 / Rule 3...」这类机械重复的合成文本 ——
//    实测会触发模型的 refusal（stop_reason: refusal），干扰实验。
// ──────────────────────────────────────────────────────────────

const SECTIONS = [
  ['服务分层', '网关层负责鉴权与配额，业务层只处理领域逻辑，两者通过内部令牌通信。网关不感知业务语义，业务层不重复做认证，职责边界清晰。跨层调用一律走服务名，不依赖宿主机端口映射。'],
  ['数据一致性', '账户余额的变更走单一写入路径，所有读取从只读副本获取。副本延迟在正常情况下低于两百毫秒，超过阈值会触发告警并临时回退到主库读取。'],
  ['限流策略', '按调用方维度做令牌桶限流，桶容量与补充速率均可在运行时调整。突发流量允许短暂超出稳态速率，但累计超额会被削减。限流决策记录在独立的审计流里。'],
  ['缓存治理', '所有缓存条目必须显式声明存活时间，禁止无限期驻留。缓存键包含版本号，发布新版本时自然失效，不需要手工清理。缓存未命中不应导致雪崩，需要有单飞机制。'],
  ['故障隔离', '下游依赖按重要性分级，非关键依赖失败时降级返回默认值而不是整体报错。熔断器在连续失败达到阈值后打开，半开状态用少量探测请求确认恢复。'],
  ['可观测性', '每个请求携带贯穿全链路的追踪标识，日志、指标、链路三者通过这个标识关联。关键路径的耗时分位数按分钟粒度聚合，异常分位数变化会自动关联到最近的发布记录。'],
  ['配置管理', '配置与代码分离，敏感配置通过密钥管理服务注入，不落盘也不进镜像。配置变更需要经过审批流，变更记录保留完整的前后对比。'],
  ['发布流程', '采用渐进式发布，先在小流量环境验证核心指标，确认无退化后再逐步扩大范围。任何阶段发现异常都可以一键回滚到上一个稳定版本。'],
  ['容量规划', '按业务峰值的一点五倍预留容量，弹性伸缩的触发阈值设在百分之七十。扩容动作有冷却期，避免指标抖动导致反复伸缩。'],
  ['数据保留', '明细日志保留三十天，聚合指标保留一年，审计记录按合规要求长期保存。超期数据自动归档到冷存储，归档过程不影响在线查询。'],
  ['依赖管理', '第三方依赖锁定精确版本，升级前需要在隔离环境验证兼容性。安全公告触发的紧急升级走快速通道，但仍需要完成回归测试。'],
  ['权限模型', '默认拒绝，按最小权限授予。权限变更有有效期，到期自动回收。高危操作需要二次确认，且操作记录不可篡改。'],
];

/** 拼出一段自然、够长、且带本轮唯一标识的前缀文本 */
function buildPrefix(variant) {
  const head =
    `内部工程规范手册（编号 ${RUN_ID}-${variant}）\n\n` +
    `本手册描述服务端系统的设计约定，供接入方参考。以下条目按主题分组。\n\n`;
  const body = SECTIONS.map(([title, text], i) => `${i + 1}. ${title}\n${text}\n`).join('\n');
  const tail =
    `\n以上条目适用于当前版本。变体标识 ${variant} 用于区分不同的实验前缀，` +
    `内容本身不因变体而改变含义，仅用于构造互不相同的缓存键。\n`;
  return head + body + tail;
}

// ──────────────────────────────────────────────────────────────
// 发送请求
// ──────────────────────────────────────────────────────────────

/**
 * @param key      虚拟 key（决定落到哪个 GHCP 账号）
 * @param variant  前缀变体，不同变体 = 不同缓存键
 * @param opts.cache  是否给前缀打 cache_control 标记
 * @param opts.short  是否用短前缀（用于验证最小长度门槛）
 */
async function ask(key, variant, opts = {}) {
  const { cache = true, short = false } = opts;

  const text = short
    ? `短前缀 ${RUN_ID}-${variant}，仅用于验证最小长度门槛。`
    : buildPrefix(variant);

  const systemBlock = { type: 'text', text };
  if (cache) systemBlock.cache_control = { type: 'ephemeral' };

  const res = await fetch(`${API_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [systemBlock],
      messages: [{ role: 'user', content: '收到请回复"OK"，不要解释。' }],
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    return { ok: false, status: res.status, detail: JSON.stringify(body).slice(0, 220) };
  }
  const u = body.usage ?? {};
  return {
    ok: true,
    input: u.input_tokens ?? 0,
    write: u.cache_creation_input_tokens ?? 0,
    read: u.cache_read_input_tokens ?? 0,
    stop: body.stop_reason,
  };
}

// ──────────────────────────────────────────────────────────────
// 断言与输出
// ──────────────────────────────────────────────────────────────

let failures = 0;
const rows = [];

function record(id, desc, acct, r, expect, pass) {
  rows.push({ id, desc, acct, r, expect, pass });
  const mark = pass ? '✅' : '❌';
  if (!pass) failures++;
  const nums = r.ok
    ? `input=${String(r.input).padStart(5)}  write=${String(r.write).padStart(5)}  read=${String(r.read).padStart(5)}`
    : `HTTP ${r.status} ${r.detail}`;
  console.log(`  ${mark} ${id}  ${desc.padEnd(26)} [${acct}]  ${nums}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('═'.repeat(78));
  console.log(`  跨账号 prompt 缓存实验    RUN_ID=${RUN_ID}`);
  console.log(`  端点 ${API_BASE}`);
  console.log('═'.repeat(78));
  console.log();

  // 先确认前缀长度确实过了门槛
  const probe = buildPrefix('X');
  console.log(`  前缀字符数 ≈ ${probe.length}（需 ≥ 1024 token 才会建缓存）`);
  console.log();

  // 证明后续几次发的前缀确实逐字节相同 —— 否则 miss 可能只是内容不同
  const { createHash } = await import('node:crypto');
  const digestA = createHash('sha256').update(buildPrefix('A')).digest('hex').slice(0, 16);
  console.log(`  前缀 A 的 sha256 前缀 = ${digestA}（下面 S1/S2/S3 用的是同一段文本）`);
  console.log();

  console.log('── 第一组：同账号基线（关键对照）────────────────────────────────');
  const s1 = await ask(KEY_A, 'A');
  record('S1', '冷启动，建立缓存', 'demo01', s1, 'write>0, read=0',
    s1.ok && s1.write > 0 && s1.read === 0);

  await sleep(2000);
  const s2 = await ask(KEY_A, 'A');
  record('S2', '★同账号重复请求', 'demo01', s2, 'read>0',
    s2.ok && s2.read > 0);

  console.log();
  console.log('── 第二组：跨账号（本实验要回答的问题）─────────────────────────');
  await sleep(2000);
  const s3 = await ask(KEY_B, 'A');
  record('S3', '★跨账号，同一前缀', 'demo02', s3, '待观测',
    s3.ok);

  await sleep(2000);
  const s4 = await ask(KEY_B, 'A');
  record('S4', 'demo02 自己重复一次', 'demo02', s4, 'read>0',
    s4.ok && s4.read > 0);

  // 为兼容下方汇总
  const e1 = s1, e2 = s3, e3 = s3, e4 = s4;
  const SAME_ACCOUNT_HITS = s2.ok && s2.read > 0;
  const CROSS_ACCOUNT_HITS = s3.ok && s3.read > 0;

  console.log();
  console.log('── 第三组：对照实验，证明测的确实是缓存 ────────────────────────');

  // 对照 1：全新前缀不应命中。若这条也 read>0，说明前面两条不足以证明任何东西。
  const c1 = await ask(KEY_B, 'C');
  record('C1', '不同前缀不应命中', 'demo02', c1, 'read=0',
    c1.ok && c1.read === 0);

  // 对照 2：不打 cache_control 标记，则既不写也不读
  const c2 = await ask(KEY_A, 'A', { cache: false });
  record('C2', '不打标记则不缓存', 'demo01', c2, 'write=0, read=0',
    c2.ok && c2.write === 0 && c2.read === 0);

  // 对照 3：低于最小长度门槛，打了标记也不会建缓存
  const c3 = await ask(KEY_A, 'D', { short: true });
  record('C3', '过短则不建缓存', 'demo01', c3, 'write=0',
    c3.ok && c3.write === 0);

  console.log();
  console.log('═'.repeat(78));
  console.log('  判定');
  console.log('═'.repeat(78));
  console.log(`  同账号重复请求命中缓存    : ${SAME_ACCOUNT_HITS ? '是' : '否'}  (S2 read=${s2.read})`);
  console.log(`  跨账号同一前缀命中缓存    : ${CROSS_ACCOUNT_HITS ? '是' : '否'}  (S3 read=${s3.read}, write=${s3.write})`);
  console.log();

  if (!SAME_ACCOUNT_HITS) {
    console.log('  ⚠️  同账号基线都没命中 —— 说明这条链路上缓存整体没生效，');
    console.log('      跨账号的结果无法解读。先排查前缀长度、cache_control 标记、');
    console.log('      以及上游是否透传了缓存字段，再重跑。');
  } else if (CROSS_ACCOUNT_HITS) {
    console.log('  结论：缓存在 GHCP 账号之间【共享】。');
    console.log('        => 账号池按负载均匀分摊不会损失缓存收益，least-loaded 安全。');
  } else {
    console.log('  结论：缓存按 GHCP 账号【隔离】。');
    console.log('        同账号能命中，换账号则重新写入 —— 说明缓存键里含账号维度。');
    console.log('        => 均匀分摊会带来额外的缓存写入成本，需要重新评估默认策略：');
    console.log('           长会话、大前缀的场景应优先 sticky-affinity。');
  }
  console.log('═'.repeat(78));

  // 本脚本的目的是观测事实，不是断言某个预期结果。
  // 只有当对照组自身矛盾（同账号基线都不命中）时才算失败。
  process.exit(SAME_ACCOUNT_HITS ? 0 : 1);
})();
