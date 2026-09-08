/**
 * 决定性实验：prompt 缓存到底按什么隔离？
 *
 * 做法：用 demo01 写入缓存，然后用 demo02 发**完全相同**的请求。
 *   - 若 demo02 出现 cache_read > 0  → 缓存跨 GHCP 账号共享（按 GitHub 的 Anthropic 组织）
 *   - 若 demo02 仍是 cache_write     → 缓存按 GHCP 账号隔离
 *
 * 这一条决定了「100 人分摊到 100 个账号」会不会丢缓存。
 */
const T: [string, string][] = [
  ['光合作用', '绿色植物利用光能把二氧化碳和水转化为有机物并释放氧气。这一过程主要发生在叶绿体中，分为光反应和暗反应两个阶段。光反应在类囊体膜上进行，把光能转化为化学能储存在 ATP 和 NADPH 中。暗反应又称卡尔文循环，在基质中利用这些能量固定二氧化碳，最终生成葡萄糖。叶绿素对红光和蓝紫光吸收最强，对绿光反射最多。'],
  ['板块构造', '地球的岩石圈被分割成若干块板块，它们漂浮在软流圈之上并缓慢移动。板块交界处分为离散型、汇聚型和转换型三类。离散边界常形成大洋中脊，汇聚边界可能产生海沟与造山带，转换边界以水平错动为主。喜马拉雅山脉是印度板块与欧亚板块碰撞抬升的结果。'],
  ['蒸汽机', '蒸汽机把热能转化为机械功，是工业革命的重要动力来源。瓦特改良的分离式冷凝器显著提高了热效率，使蒸汽机得以广泛应用于矿山排水、纺织和运输。随后高压蒸汽机的出现进一步推动了铁路和轮船的发展。'],
  ['货币职能', '货币通常被认为具有价值尺度、流通手段、贮藏手段和支付手段等职能。价值尺度使商品价值可以统一衡量，流通手段让交换摆脱了物物交换的双重巧合难题。贮藏手段要求币值相对稳定，支付手段则支撑了信用与延期结算。'],
  ['季风气候', '季风是由海陆热力性质差异引起的大范围盛行风向随季节显著变化的现象。夏季陆地升温快形成低压，风由海洋吹向陆地并带来充沛降水；冬季相反，风由内陆吹向海洋，气候干冷。南亚和东亚是典型的季风区。'],
  ['免疫系统', '免疫系统由先天免疫和适应性免疫两部分构成。先天免疫反应迅速但缺乏特异性，包括物理屏障、吞噬细胞和补体系统。适应性免疫依赖淋巴细胞识别特定抗原，反应较慢但具有记忆性，这也是疫苗发挥作用的基础。'],
  ['桥梁结构', '常见桥型包括梁桥、拱桥、悬索桥和斜拉桥。梁桥构造简单但跨度受限；拱桥通过拱的推力把荷载传递到基础；悬索桥用主缆承受拉力，适合超大跨度；斜拉桥的索直接从塔连到桥面，施工相对便利。'],
  ['土壤形成', '土壤由母质在气候、生物、地形和时间共同作用下逐渐发育而成。风化作用破碎岩石形成矿物颗粒，生物活动带来有机质并促进团粒结构的形成。不同成土条件造就了黑土、红壤、灰化土等各具特征的土壤类型。'],
  ['声音传播', '声音是介质中传播的机械波，需要介质才能传播，真空中无法传声。传播速度取决于介质的弹性和密度，通常在固体中最快、气体中最慢。频率决定音调，振幅决定响度，波形则影响音色。'],
  ['城市热岛', '城市地区气温普遍高于周边郊区的现象称为城市热岛效应。建筑材料的高蓄热能力、人为热排放、绿地和水体减少都是成因。缓解措施包括增加城市绿化、使用高反射率屋面材料以及优化通风廊道布局。'],
  ['汇率制度', '汇率制度大致可分为固定汇率、浮动汇率以及介于两者之间的中间形态。固定汇率有利于稳定预期但需要外汇储备支撑，浮动汇率能自动调节国际收支但波动较大。多数经济体实际采取有管理的浮动。'],
  ['催化剂', '催化剂能改变化学反应速率而自身在反应前后质量和化学性质不变。它通过提供能量更低的反应路径来降低活化能。工业上广泛使用的合成氨铁催化剂和汽车尾气三元催化器都是典型例子。'],
  ['潮汐现象', '潮汐主要由月球和太阳对地球的引潮力引起，月球的作用约为太阳的两倍。当日月地三者接近一条直线时出现大潮，成直角时出现小潮。沿海地区的潮差受海岸地形影响很大。'],
  ['纸的传播', '造纸术改进后经由中亚向西传播，逐渐取代了此前使用的莎草纸和羊皮纸。相比之下纸张原料易得、成本低廉，为印刷术的推广奠定了物质基础。书籍成本的下降显著加快了知识的扩散速度。'],
];

const RUN = process.env.RUN_ID || String(Date.now());
const SYSTEM = `你是一个知识助手。资料版本 ${RUN}。下面是背景资料。\n\n`
  + T.map(([k, v], i) => `${i + 1}. ${k}\n${v}`).join('\n\n');

const API = 'https://api.20.78.139.35.nip.io';
const KEY = process.env.POOL_API_KEY!;

/** 直接指定账号（1:1 模式），完全绕开池的分配逻辑 */
async function ask(identity: string, q: string, tries = 4) {
  for (let t = 0; t < tries; t++) {
    const res = await fetch(`${API}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': KEY,
        'X-User-Identity': identity, 'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-5', max_tokens: 48, thinking: { type: 'disabled' },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: q }],
      }),
    });
    const b = await res.json() as any;
    if (res.status === 200 && b?.stop_reason !== 'refusal') {
      const u = b.usage ?? {};
      return { ok: true, read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0 };
    }
    await new Promise((s) => setTimeout(s, 1500));
  }
  return { ok: false, read: 0, write: 0 };
}

const Q = '光合作用分哪两个阶段？';
console.log(`资料版本 ${RUN}，系统提示词约 ${Math.round(SYSTEM.length / 1.6)} token\n`);

console.log('① demo01 第 1 次（预期：写入缓存）');
let r = await ask('demo01', Q);
console.log(`   ok=${r.ok}  cache_read=${r.read}  cache_write=${r.write}`);
await new Promise((s) => setTimeout(s, 2000));

console.log('\n② demo01 第 2 次（预期：命中自己写的缓存）');
r = await ask('demo01', Q);
console.log(`   ok=${r.ok}  cache_read=${r.read}  cache_write=${r.write}`);
await new Promise((s) => setTimeout(s, 2000));

console.log('\n③ demo02 第 1 次 —— 关键：换账号，同样的请求');
const r3 = await ask('demo02', Q);
console.log(`   ok=${r3.ok}  cache_read=${r3.read}  cache_write=${r3.write}`);

console.log('\n' + '═'.repeat(56));
if (!r3.ok) {
  console.log('  ⚠️ demo02 请求失败，结论不成立，需重跑');
} else if (r3.read > 0) {
  console.log('  结论：✅ 缓存【跨 GHCP 账号共享】');
  console.log('        → 换账号不丢缓存，100 人摊到 100 个账号也能保持命中');
} else {
  console.log('  结论：❌ 缓存【按 GHCP 账号隔离】');
  console.log('        → 换账号必然重写缓存，分摊与缓存不可兼得');
}
console.log('═'.repeat(56));
