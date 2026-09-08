/**
 * 缓存最终验证：证明「会话粘性下，池化不破坏 prompt 缓存」
 *
 * 设计要点：
 *  - 每次运行用唯一版本号做前缀 → 缓存必然冷启动
 *  - 系统提示词是内容各异的自然文本，不重复 → 避免误判拒绝
 *  - 遇到 refusal 自动重试
 *  - 记录每次请求实际落到哪个账号
 */
const T: [string, string][] = [
  ['光合作用', '绿色植物利用光能把二氧化碳和水转化为有机物并释放氧气。这一过程主要发生在叶绿体中，分为光反应和暗反应两个阶段。光反应在类囊体膜上进行，把光能转化为化学能储存在 ATP 和 NADPH 中。暗反应又称卡尔文循环，在基质中利用这些能量固定二氧化碳，最终生成葡萄糖。叶绿素对红光和蓝紫光吸收最强，对绿光反射最多，这正是叶片呈现绿色的原因。'],
  ['板块构造', '地球的岩石圈被分割成若干块板块，它们漂浮在软流圈之上并缓慢移动。板块交界处分为离散型、汇聚型和转换型三类。离散边界常形成大洋中脊，汇聚边界可能产生海沟与造山带，转换边界则以水平错动为主。喜马拉雅山脉是印度板块与欧亚板块碰撞抬升的结果，至今仍在缓慢升高。'],
  ['蒸汽机', '蒸汽机把热能转化为机械功，是工业革命的重要动力来源。瓦特改良的分离式冷凝器显著提高了热效率，使蒸汽机得以广泛应用于矿山排水、纺织和运输。随后高压蒸汽机的出现进一步推动了铁路和轮船的发展。功率单位瓦特正是为纪念这位发明家而命名的。'],
  ['货币职能', '货币通常被认为具有价值尺度、流通手段、贮藏手段和支付手段等职能。价值尺度使商品价值可以统一衡量，流通手段让交换摆脱了物物交换的双重巧合难题。贮藏手段要求币值相对稳定，支付手段则支撑了信用与延期结算。现代信用货币的价值来自国家信用而非贵金属储备。'],
  ['季风气候', '季风是由海陆热力性质差异引起的大范围盛行风向随季节显著变化的现象。夏季陆地升温快形成低压，风由海洋吹向陆地并带来充沛降水；冬季相反，风由内陆吹向海洋，气候干冷。南亚和东亚是典型的季风区，农业生产高度依赖季风的到来时间与强度。'],
  ['免疫系统', '免疫系统由先天免疫和适应性免疫两部分构成。先天免疫反应迅速但缺乏特异性，包括物理屏障、吞噬细胞和补体系统。适应性免疫依赖淋巴细胞识别特定抗原，反应较慢但具有记忆性。疫苗正是利用这种记忆特性，让身体在未接触病原体的情况下建立防御能力。'],
  ['桥梁结构', '常见桥型包括梁桥、拱桥、悬索桥和斜拉桥。梁桥构造简单但跨度受限；拱桥通过拱的推力把荷载传递到基础；悬索桥用主缆承受拉力，适合超大跨度；斜拉桥的索直接从塔连到桥面，施工相对便利。选型需要综合考虑跨度、地质条件、通航要求和造价。'],
  ['土壤形成', '土壤由母质在气候、生物、地形和时间共同作用下逐渐发育而成。风化作用破碎岩石形成矿物颗粒，生物活动带来有机质并促进团粒结构的形成。不同成土条件造就了黑土、红壤、灰化土等各具特征的土壤类型。一厘米厚的表土可能需要上百年才能自然形成。'],
  ['声音传播', '声音是介质中传播的机械波，需要介质才能传播，真空中无法传声。传播速度取决于介质的弹性和密度，通常在固体中最快、气体中最慢。频率决定音调，振幅决定响度，波形则影响音色。二十摄氏度空气中的声速约为每秒三百四十三米。'],
  ['城市热岛', '城市地区气温普遍高于周边郊区的现象称为城市热岛效应。建筑材料的高蓄热能力、人为热排放、绿地和水体减少都是成因。缓解措施包括增加城市绿化、使用高反射率屋面材料以及优化通风廊道布局。夜间热岛强度通常比白天更明显。'],
  ['汇率制度', '汇率制度大致可分为固定汇率、浮动汇率以及介于两者之间的中间形态。固定汇率有利于稳定预期但需要外汇储备支撑，浮动汇率能自动调节国际收支但波动较大。多数经济体实际采取有管理的浮动，在容忍区间内让市场决定，必要时进行干预。'],
  ['催化剂', '催化剂能改变化学反应速率而自身在反应前后质量和化学性质不变。它通过提供能量更低的反应路径来降低活化能。工业上广泛使用的合成氨铁催化剂和汽车尾气三元催化器都是典型例子。酶是生物体内的天然催化剂，具有极高的专一性和效率。'],
  ['潮汐现象', '潮汐主要由月球和太阳对地球的引潮力引起，月球的作用约为太阳的两倍。当日月地三者接近一条直线时出现大潮，成直角时出现小潮。沿海地区的潮差受海岸地形影响很大，喇叭形的海湾往往能放大潮差。'],
  ['纸的传播', '造纸术改进后经由中亚向西传播，逐渐取代了此前使用的莎草纸和羊皮纸。相比之下纸张原料易得、成本低廉，为印刷术的推广奠定了物质基础。书籍成本的下降显著加快了知识的扩散速度。'],
];

const RUN_ID = process.env.RUN_ID || String(Date.now());
const SYSTEM = `你是一个知识助手。资料版本 ${RUN_ID}。下面是背景资料，回答问题时可以参考。\n\n`
  + T.map(([k, v], i) => `${i + 1}. ${k}\n${v}`).join('\n\n');

const API = 'https://api.20.78.139.35.nip.io';
const KEY = process.env.POOL_API_KEY!;
const INTERNAL = process.env.POOL_INTERNAL!;
const POOL = 'team-pool';

async function setStrategy(s: string) {
  await fetch(`${API}/api/pools/${POOL}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL },
    body: JSON.stringify({ strategy: s }),
  });
}

async function whichAccount(sessionKeyHint: string): Promise<string> {
  // 用池详情的 lastUsedAt 变化推断不便，改为直接读 request stats 的最后一条
  const r = await fetch(`${API}/api/request-stats?limit=1`, { headers: { 'X-Internal-Token': INTERNAL } });
  const j = await r.json() as any;
  const items = Array.isArray(j) ? j : (j.items ?? []);
  return items[0]?.identity ?? '?';
}

async function ask(sid: string, q: string, tries = 3) {
  for (let t = 0; t < tries; t++) {
    const res = await fetch(`${API}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': KEY,
        'X-User-Identity': POOL, 'X-Session-Id': sid, 'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-5', max_tokens: 64, thinking: { type: 'disabled' },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: q }],
      }),
    });
    const b = await res.json() as any;
    if (res.status === 200 && b?.stop_reason !== 'refusal') {
      const u = b.usage ?? {};
      return { ok: true, input: u.input_tokens ?? 0, read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0 };
    }
    await new Promise((s) => setTimeout(s, 1500));
  }
  return { ok: false, input: 0, read: 0, write: 0 };
}

const QS = [
  '光合作用分哪两个阶段？',
  '悬索桥靠什么承受拉力？',
  '什么是城市热岛效应？',
  '催化剂为什么能加快反应？',
  '大潮出现在什么时候？',
  '声音在哪种介质中传播最快？',
];

async function run(strategy: string, label: string, same: boolean) {
  await setStrategy(strategy);
  console.log(`\n──────── ${label} ────────`);
  let read = 0, write = 0, input = 0, ok = 0;
  const accounts: string[] = [];
  for (let i = 0; i < QS.length; i++) {
    const sid = same ? `final-sticky-${RUN_ID}` : `final-rr-${RUN_ID}-${i}`;
    const r = await ask(sid, QS[i]!);
    if (!r.ok) { console.log(`  第 ${i + 1} 轮  连续 3 次被误判拒绝，跳过`); continue; }
    ok++; read += r.read; write += r.write; input += r.input;
    const acct = await whichAccount(sid);
    accounts.push(acct);
    console.log(`  第 ${i + 1} 轮  账号=${acct.padEnd(8)} cache_read=${String(r.read).padStart(6)}  cache_write=${String(r.write).padStart(6)}${r.read > 0 ? '  ← 命中' : ''}`);
    await new Promise((s) => setTimeout(s, 1200));
  }
  const total = read + write + input;
  const rate = total ? (read / total) * 100 : 0;
  const aiu = (input * 500 + read * 50 + write * 625) / 1e6;
  console.log(`  ── 用到的账号: ${[...new Set(accounts)].join(', ') || '无'}`);
  console.log(`  ── 命中率 ${rate.toFixed(1)}%  write=${write}  read=${read}  输入侧 ${aiu.toFixed(4)} AIU  (成功 ${ok}/${QS.length})`);
  return { read, write, rate, aiu, accounts: [...new Set(accounts)] };
}

console.log(`系统提示词约 ${Math.round(SYSTEM.length / 1.6)} token   运行标识 ${RUN_ID}`);
const sticky = await run('sticky-affinity', 'A. 会话粘性（同一会话）', true);
await setStrategy('sticky-affinity');
console.log('\n' + '═'.repeat(54));
console.log(`  会话粘性下：写入 ${sticky.write} token，命中 ${sticky.read} token，命中率 ${sticky.rate.toFixed(1)}%`);
console.log(`  全程只用了 ${sticky.accounts.length} 个账号: ${sticky.accounts.join(', ')}`);
console.log('═'.repeat(54));
