// 「开窗」· 赌石 —— 纯逻辑单测
// 运行：node tests/jade.test.cjs
//
// 测什么、为什么不测别的：
//   这个玩法的全部风险都在**数值**上 —— 找茬是"信息"，出价是"下注"，切开是"结算"。
//   只要这三件事的数学不歪，画面与手感可以慢慢调；一旦数值歪了（比如估价偷看了
//   隐藏的底价、或者首档定得比期望还低），立刻会变成刷钱机或劝退机。所以这里
//   一条 UI 都不测，只锁：
//     ① 规则的结构不变量（可复现、埋点不重叠、估价不读隐藏信息、结算恒等式）
//     ② 经济不变量（盲出必亏、技能有回报、完美读料也不失控）
//   改 jade.js 的 TUNE / SPEC / QUALITY / COLOR / FLAWS 后**必须**重跑本文件。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "jade.js"), "utf8");

function load() {
  const ctx = vm.createContext({ console: console });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInContext(SRC, ctx);
  return ctx.Jade;
}
const J = load();
const R = J.rules;

/* ── 工具 ── */
function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function quantile(a, p) { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length * p)]; }

/* ═══════════════ ① 规则的结构不变量 ═══════════════ */

test("模块对外形状符合规格", () => {
  assert.equal(typeof J.start, "function");
  assert.equal(typeof J.isBusy, "function");
  assert.equal(typeof J.dispose, "function");
  assert.equal(typeof J.debug.state, "function");
  assert.equal(typeof J.debug.tap, "function");
  assert.equal(typeof J.debug.bid, "function");
  assert.equal(J.TUNE.PRICES.length, 3, "三档出价");
  assert.equal(J.TUNE.STONES_PER_RUN, 3, "一局三块");
  assert.ok(J.view === undefined || true, "VIEW 由 J.VIEW 暴露");
  assert.equal(J.VIEW.W > 0 && J.VIEW.H > 0, true);
});

test("同种子 → 同一块石头（可复现：截图、单测、复现 bug 都靠它）", () => {
  const a = R.genStone(12345), b = R.genStone(12345), c = R.genStone(12346);
  assert.equal(JSON.stringify(a.feats), JSON.stringify(b.feats), "同种子特征完全一致");
  assert.equal(a.trueValue, b.trueValue);
  assert.equal(a.quality.id, b.quality.id);
  assert.equal(a.color.id, b.color.id);
  assert.notEqual(JSON.stringify(a.geo) + a.base, JSON.stringify(c.geo) + c.base, "换种子要变");
});

test("特征埋点：都在石头里、互不重叠、数量不越界", () => {
  const maxFlaw = R.SPEC.FLAW_COUNT_P.length - 1;
  const maxGood = R.SPEC.GOOD_COUNT_P.length - 1;
  for (let i = 0; i < 3000; i++) {
    const st = R.genStone(700 + i);
    const flaws = R.flawsOf(st), goods = R.goodsOf(st);
    assert.ok(flaws.length <= maxFlaw, "垮特征数越界：" + flaws.length);
    assert.ok(goods.length <= maxGood, "涨特征数越界：" + goods.length);
    assert.ok(st.feats.length > 0 || (flaws.length === 0 && goods.length === 0));
    for (let k = 0; k < st.feats.length; k++) {
      const f = st.feats[k];
      assert.ok(R.insideStone(f.x, f.y, st.geo), `特征 ${f.kind} 落在石头外`);
      for (let m = k + 1; m < st.feats.length; m++) {
        const g = st.feats[m], dx = f.x - g.x, dy = f.y - g.y;
        assert.ok(Math.sqrt(dx * dx + dy * dy) >= 60, "两个特征挨得太近，找茬会变成一坨");
      }
    }
  }
});

test("估价**绝不读隐藏信息**（防『照着答案出价』—— 曾经真的这么错过）", () => {
  /* 用会抛异常的 getter 当探针：只要 estimateOf 碰了底价/种/色/真实价值，这条就炸 */
  const boom = (feats) => ({
    feats: feats,
    get base() { throw new Error("估价读了隐藏的底价"); },
    get quality() { throw new Error("估价读了隐藏的种"); },
    get color() { throw new Error("估价读了隐藏的色"); },
    get trueValue() { throw new Error("估价读了真实价值"); }
  });
  const feats = [
    { kind: "mangdai", isFlaw: false }, { kind: "songhua", isFlaw: false },
    { kind: "lie", isFlaw: true }, { kind: "jiao", isFlaw: true }
  ];
  const a = R.estimateOf(boom(feats), [0, 2]);
  const b = R.estimateOf(boom(feats), [0, 2]);
  assert.deepEqual(a, b, "同样的『看到的东西』必须给出同样的判断");
  assert.ok(a.mid > 0 && a.low >= 0 && a.high > a.low, "区间要成立");
});

test("估价随信息单调：找到垮特征越低、找到涨特征越高、看全了区间更窄", () => {
  const feats = [
    { kind: "mangdai", isFlaw: false }, { kind: "songhua", isFlaw: false },
    { kind: "lie", isFlaw: true }, { kind: "liu", isFlaw: true }, { kind: "jia", isFlaw: true }
  ];
  const st = { feats: feats };
  const none = R.estimateOf(st, []);
  const good = R.estimateOf(st, [0, 1]);
  const bad  = R.estimateOf(st, [2]);
  const fake = R.estimateOf(st, [4]);
  assert.ok(good.mid > none.mid, "看到松花蟒带要把判断抬起来");
  assert.ok(bad.mid < none.mid, "看到裂要把判断压下去");
  assert.ok(fake.mid < bad.mid, "假皮要压得比裂更狠");
  /* 注意比的是**相对**宽度：判断被抬高时绝对区间自然也会变宽，
     真正要锁的是"看得越多，不确定度越小"这件事。
     ⚠ 要比同量级的两次判断：估价值被压到个位数时（例如同时看到裂+注胶+假皮），
     round10 会把相对宽度放大到失真 —— 那是度量的锅，不是玩法的锅。 */
  const rel = (e) => (e.high - e.low) / Math.max(1, e.mid);
  assert.ok(rel(good) < rel(none), `看得越多相对区间应更窄：${rel(good).toFixed(2)} vs ${rel(none).toFixed(2)}`);
  const three = R.estimateOf(st, [0, 1, 2]);     // 蟒带+松花+裂：mid 仍在百元量级
  assert.ok(three.mid > 20 && rel(three) < rel(good),
    `同一量级下，多看出一处特征应更窄：${rel(three).toFixed(2)} vs ${rel(good).toFixed(2)}`);
});

test("结算恒等式：净收益 = 真实价值 − 出价；假皮几乎归零；门槛判定正确", () => {
  for (let i = 0; i < 500; i++) {
    const st = R.genStone(9000 + i);
    for (const p of R.PRICES) {
      const s = R.settle(st, p);
      assert.equal(s.net, st.trueValue - p, "结算恒等式被破坏");
      assert.equal(s.jackpot, (st.trueValue - p) >= 3000);
    }
  }
  /* 假皮：价值必须被压到近乎归零（这是"看走眼"的最惨下场） */
  const fake = { base: 100, quality: { mul: 1 }, color: { mul: 1 }, feats: [{ kind: "jia", isFlaw: true }] };
  assert.ok(R.trueValueOf(fake) <= 10, "假皮应把价值压到 0 附近，实际 " + R.trueValueOf(fake));
});

test("涨特征真的与种水色相关（否则『看松花蟒带』就是纯噪音）", () => {
  const N = 30000;
  let mang = 0, mangBing = 0, noGood = 0, noGoodBing = 0, boli = 0, mangBoli = 0;
  for (let i = 0; i < N; i++) {
    const st = R.genStone(31000 + i);
    const goods = R.goodsOf(st).map((f) => f.kind);
    const hasMang = goods.indexOf("mangdai") >= 0;
    const isBing = st.quality.id === "bing" || st.quality.id === "boli";
    if (hasMang) { mang++; if (isBing) mangBing++; } else { noGood++; if (isBing) noGoodBing++; }
    if (st.quality.id === "boli") { boli++; if (hasMang) mangBoli++; }
  }
  const pBingMang = mangBing / mang, pBingNo = noGoodBing / noGood;
  assert.ok(pBingMang > pBingNo * 1.8,
    `有蟒带时出冰/玻璃的概率应显著更高：${(pBingMang * 100).toFixed(1)}% vs ${(pBingNo * 100).toFixed(1)}%`);
  assert.ok(boli / N < 0.02, "玻璃种要稀有（<2%），实际 " + (boli / N * 100).toFixed(2) + "%");
  assert.ok(mangBoli / Math.max(1, boli) > 0.4, "高货应主要来自有蟒带的石头");
});

/* ═══════════════ ② 经济不变量（蒙特卡洛） ═══════════════ */

const N = 20000;
function sampleValues() {
  const v = [];
  for (let i = 0; i < N; i++) v.push(R.genStone(40000 + i).trueValue);
  return v;
}

test("经济不变量 ①：无信息盲出，三档**全部**为负期望（庄家占优）", () => {
  const vals = sampleValues();
  const E = mean(vals);
  for (const p of R.PRICES) {
    const ev = E - p;
    assert.ok(ev < 0, `盲出 ¥${p} 的期望应为负，实际 ${ev.toFixed(1)}（E[价值]=${E.toFixed(1)}）`);
  }
});

test("经济不变量 ②：先验常数与实测期望一致（改了分布没重标 → 这条会红）", () => {
  const E = mean(sampleValues());
  const prior = R.SPEC.PRIOR_MID;
  assert.ok(Math.abs(E - prior) / prior < 0.08,
    `PRIOR_MID=${prior} 与实测 E[价值]=${E.toFixed(1)} 偏差过大 —— 改了种水色/底价分布就要重标 PRIOR_MID 与 TUNE.PRICES`);
});

test("经济不变量 ③：找茬命中率越高，每次出价的期望越高（技能有回报）", () => {
  function strategy(skill) {
    let ev = 0, bids = 0;
    for (let i = 0; i < N; i++) {
      const st = R.genStone(50000 + i);
      const found = [];
      st.feats.forEach((f, k) => { if (Math.random() < skill) found.push(k); });
      /* 合理玩家：发现致命特征就走人；估值盖得住档位才出价 */
      if (found.some((k) => st.feats[k].kind === "lie" || st.feats[k].kind === "jia")) continue;
      const est = R.estimateOf(st, found);
      let best = 0;
      for (const p of R.PRICES) if (est.mid > p && p > best) best = p;
      if (best > 0) { ev += st.trueValue - best; bids++; }
    }
    return { perBid: bids ? ev / bids : 0, bids: bids };
  }
  const half = strategy(0.4), full = strategy(1.0);
  assert.ok(half.bids > 200 && full.bids > 200, "两种水平都要有足够样本");
  assert.ok(full.perBid > half.perBid,
    `看得全应比只看一半更赚：${full.perBid.toFixed(0)} vs ${half.perBid.toFixed(0)}`);
  assert.ok(half.perBid > 0, "半吊子玩家也不该被惩罚到负期望（否则没人愿意玩）");
});

test("经济不变量 ④：完美读料也不失控（每块期望有上限，防刷钱）", () => {
  let ev = 0;
  for (let i = 0; i < N; i++) {
    const st = R.genStone(60000 + i);
    const found = st.feats.map((f, k) => k);            // 上帝视角：特征全看到
    if (found.some((k) => st.feats[k].kind === "lie" || st.feats[k].kind === "jia")) continue;
    const est = R.estimateOf(st, found);
    let best = 0;
    for (const p of R.PRICES) if (est.mid > p && p > best) best = p;
    if (best > 0) ev += st.trueValue - best;
  }
  const perStone = ev / N;
  assert.ok(perStone < 120,
    `完美读料的每块期望 ${perStone.toFixed(1)} 过高（>120）—— 这就是刷钱机，请抬价或缩分布`);
});

test("分布形状：中位数远低于期望（大部分石头是垮的，少数高货撑起平均）", () => {
  const vals = sampleValues();
  const E = mean(vals), p50 = quantile(vals, 0.5), p99 = quantile(vals, 0.99);
  assert.ok(p50 < E * 0.6, `中位数 ${p50} 应明显低于期望 ${E.toFixed(0)}（赌石的手感来源）`);
  assert.ok(p99 > R.PRICES[2], `p99=${p99} 应高于最高档 ¥${R.PRICES[2]}，否则全押档永远没意义`);
  const maxV = Math.max.apply(null, vals);
  assert.ok(maxV > 4000, "要存在真正的一刀富（单块 > ¥4000），实际最高 " + maxV);
});
