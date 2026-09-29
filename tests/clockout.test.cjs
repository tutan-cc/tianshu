// 「准点下班」· 办公室潜行 —— 纯逻辑单测
// 运行：node tests/clockout.test.cjs
//
// 测什么、为什么不测别的：
//   这个玩法的风险全在两处，画面和手感反而不会出错：
//     ① **视线与视野锥**。潜行游戏的 bug 几乎全在这里 —— "隔着墙也看得见"、
//        "站在隔板后面却被发现"、"贴在墙边反而绝对安全"。这些在画面上都很难判断，
//        只有把判定抽成纯函数、直接喂坐标验边界才验得动。
//     ② **关卡数据**。出口走不到、文件夹拿不到、巡逻航点落在墙里、
//        航线中间隔着墙让巡逻者卡死 —— 这四类错误画面上全都只是"有点怪"，
//        但每一类都能让这一关直接不可通关或难度崩塌。
//   所以这里一条像素都不测，只锁：
//     ① 三关的**可达性**（BFS：出口与文件夹必须从出生点走得到）
//     ② 巡逻航线**不能卡死**（航点在可走格、相邻航点之间没有实心格）
//     ③ 视线与视野锥的边界（含边界上的等号）
//     ④ 时钟与奖励的结构（时限必须 ≥ 最快可达时间；奖励必须按进度打折）
//     ⑤ 经济不变量（相对 E[value]，绝不写死元数）
//   改 clockout.js 的 TUNE / LEVELS / 视线判定 / 赔付阶梯之后**必须**重跑本文件。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "clockout.js"), "utf8");

function load() {
  const ctx = vm.createContext({ console: console });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInContext(SRC, ctx);
  return ctx.Clockout;
}
const C = load();
const R = C.rules;
const T = R.TUNE;
const TILE = T.TILE;

function meanNet(mode, skill, n, seed0) {
  let sum = 0;
  n = n || 300; seed0 = seed0 || 50000;
  for (let i = 0; i < n; i++) sum += R.simulateRun(mode, skill, seed0 + i).net;
  return sum / n;
}

/* ═══════════════ ① 模块形状 ═══════════════ */

test("模块对外形状符合规格", () => {
  assert.equal(typeof C.start, "function");
  assert.equal(typeof C.isBusy, "function");
  assert.equal(typeof C.dispose, "function");
  assert.equal(typeof C.version, "string");
  assert.equal(typeof C.debug.state, "function");
  assert.equal(typeof C.debug.tick, "function");
  assert.equal(typeof C.debug.freeze, "function");
  assert.equal(typeof C.debug.seek, "function");
  assert.equal(typeof C.debug.placePatrol, "function");
  assert.equal(typeof C.debug.lifecycle, "function");
  assert.ok(Object.keys(R.MODES).length >= 2);
  assert.ok(Object.keys(R.PAYOUT).length === Object.keys(R.MODES).length, "每个模式都要有自己的赔付阶梯");
  assert.equal(R.LEVELS.length, 3, "三关三张地图");
});

/* ═══════════════ ② 关卡数据与可达性 ═══════════════ */

test("关卡：三关都能解析，且外墙封闭、行宽一致", () => {
  for (const def of R.LEVELS) {
    const lv = R.buildLevel(def, 12345, "normal");
    const probs = R.validateLevel(lv);
    /* ⚠ 不能写 deepEqual(probs, [])：probs 是在 vm 里造出来的数组，
       原型与测试 realm 的 Array 不同，deepStrictEqual 连两个空数组都会判不等。 */
    assert.equal(probs.length, 0, "[" + lv.id + "] 关卡自检不过：\n  " + probs.join("\n  "));
    assert.ok(lv.w > 20 && lv.h > 14, "[" + lv.id + "] 关卡太小：" + lv.w + "x" + lv.h);
  }
});

test("关卡：每关恰有一个出生点、一组出口、一份文件夹、一台咖啡机", () => {
  for (const def of R.LEVELS) {
    const lv = R.buildLevel(def, 999, "normal");
    assert.ok(lv.spawn, "[" + lv.id + "] 缺出生点");
    assert.ok(lv.exit.length >= 1, "[" + lv.id + "] 缺出口");
    assert.equal(lv.folders.length, 1, "[" + lv.id + "] 文件夹数量不是 1（多了会变成一路按过去）");
    assert.equal(lv.coffee.length, 1, "[" + lv.id + "] 咖啡机数量不是 1");
    assert.equal(lv.lounge.length, 1, "[" + lv.id + "] 缺茶水间（咖啡机的引诱目标）");
    assert.ok(lv.patrols.length >= 4, "[" + lv.id + "] 巡逻者太少（" + lv.patrols.length + "），没有潜行压力");
  }
});

test("关卡：出口与文件夹必须从出生点走得到（不可通关是潜行游戏最恶心的 bug）", () => {
  for (const def of R.LEVELS) {
    for (const seed of [1, 777, 90210]) {
      const lv = R.buildLevel(def, seed, "normal");
      /* validateLevel 里的 BFS 已经查过；这里再独立算一遍，防它以后被改坏 */
      const seen = new Set([lv.spawn.x + "," + lv.spawn.y]);
      const q = [[lv.spawn.x, lv.spawn.y]];
      while (q.length) {
        const [cx, cy] = q.shift();
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
          if (lv.solid[ny][nx]) continue;
          const k = nx + "," + ny;
          if (seen.has(k)) continue;
          seen.add(k); q.push([nx, ny]);
        }
      }
      for (const e of lv.exit) assert.ok(seen.has(e.x + "," + e.y), "[" + lv.id + "] 出口走不到");
      for (const f of lv.folders) assert.ok(seen.has(f.x + "," + f.y), "[" + lv.id + "] 文件夹走不到");
      assert.ok(seen.size > lv.w * lv.h * 0.25, "[" + lv.id + "] 可走区域太小：" + seen.size + " 格");
    }
  }
});

test("回归：巡逻航线不能卡死（航点在可走格、相邻航点之间没有实心格）", () => {
  /* 这条是**真事**换来的：第一版有 5 条航线的两个航点之间隔着墙/工位，
     巡逻者是直线走向下一个航点的、不做寻路，于是一头顶在墙上原地站住。
     画面上只表现为"这个保安站着不动"，几乎不可能联想到是关卡数据的问题。 */
  for (const def of R.LEVELS) {
    const lv = R.buildLevel(def, 4242, "normal");
    for (let i = 0; i < lv.patrolRoutes.length; i++) {
      const route = lv.patrolRoutes[i];
      for (let j = 0; j < route.length; j++) {
        const [wx, wy] = route[j];
        assert.ok(!lv.solid[wy][wx], "[" + lv.id + "] 航点 (" + wx + "," + wy + ") 在实心格里");
        const [nx, ny] = route[(j + 1) % route.length];
        const steps = Math.max(2, Math.ceil(Math.hypot(nx - wx, ny - wy) / 0.2));
        for (let k = 1; k < steps; k++) {
          const t = k / steps;
          const sx = Math.floor(wx + (nx - wx) * t), sy = Math.floor(wy + (ny - wy) * t);
          assert.ok(!lv.solid[sy][sx],
            "[" + lv.id + "] 航线 (" + wx + "," + wy + ")→(" + nx + "," + ny + ") 中间被实心格 (" + sx + "," + sy + ") 挡住，巡逻者会卡死");
        }
      }
    }
  }
});

test("巡逻者真的会动（跑 8 秒，每一条航线都必须有位移）", () => {
  for (const def of R.LEVELS) {
    const lv = R.buildLevel(def, 777, "normal");
    const before = lv.patrols.map((p) => ({ x: p.x, y: p.y }));
    for (let t = 0; t < 500; t++) for (const p of lv.patrols) R.stepPatrol(lv, p, 0.016, t * 0.016, {});
    lv.patrols.forEach((p, i) => {
      const d = Math.hypot(p.x - before[i].x, p.y - before[i].y);
      assert.ok(d > 8, "[" + lv.id + "] 第 " + i + " 个巡逻者 8 秒只动了 " + d.toFixed(1) + " px（卡死）");
    });
  }
});

/* ═══════════════ ③ 视线与视野锥 ═══════════════ */

test("视线：空地通、工位断、隔板断；隔板能走过但工位不能", () => {
  const lv = R.buildLevel(R.LEVELS[0], 1, "normal");
  // 第 1 关底部 y=17 整行开阔（工位在 y=7..9 与 y=13..15）
  assert.equal(R.losClear(lv, 15.5 * TILE, 17.5 * TILE, 17.5 * TILE, 17.5 * TILE), true, "空地上两格直线必须通");
  // 工位块 fill(3,7,5,3) 在 y=7..9，所以 y=8 上从 x=1 到 x=9 会被工位挡住
  assert.equal(R.losClear(lv, 1.5 * TILE, 8.5 * TILE, 9.5 * TILE, 8.5 * TILE), false, "隔着工位必须看不见");
  // 半高隔板 fill(9,10,14,1) 在 y=10
  assert.equal(R.losClear(lv, 15.5 * TILE, 9.5 * TILE, 15.5 * TILE, 11.5 * TILE), false, "隔着隔板必须看不见");
  // 但隔板**不挡人** —— 这是"沿隔板背面走"这条技巧成立的前提
  assert.equal(R.isSolidW(lv, 15.5 * TILE, 10.5 * TILE), false, "隔板必须能走过（半高）");
  assert.equal(R.isSolidW(lv, 4.5 * TILE, 8.5 * TILE), true, "工位必须走不过");
  // 越界一律当实心（否则玩家能走出地图）
  assert.equal(R.isSolidW(lv, -5, 100), true, "越界必须当实心");
  assert.equal(R.isOpaqueW(lv, lv.w * TILE + 5, 100), true, "越界必须挡视线");
});

test("视野锥：距离 + 张角 + 遮挡三条全过才看得见，边界含等号", () => {
  const lv = R.buildLevel(R.LEVELS[0], 1, "normal");
  const pat = { x: 16.5 * TILE, y: 17.5 * TILE, angle: 0, range: T.RANGE, halfFov: Math.PI * T.FOV_DEG / 360 };
  const see = (dx, dy) => R.canSee(lv, pat, pat.x + dx, pat.y + dy, {});
  const a = pat.halfFov;
  // 朝上打，别打进底墙（底墙是 y=h-1）
  assert.equal(see(150, 0), true, "正前方必须看得见");
  assert.equal(see(-150, 0), false, "正后方必须看不见");
  assert.equal(see(Math.cos(a) * 150, -Math.sin(a) * 150), true, "正好在半 FOV 上必须算看得见（闭区间）");
  assert.equal(see(Math.cos(a + 0.03) * 150, -Math.sin(a + 0.03) * 150), false, "超出半 FOV 必须看不见");
  assert.equal(see(T.RANGE, 0), true, "正好在 range 上必须看得见（闭区间）");
  assert.equal(see(T.RANGE + 2, 0), false, "超出 range 必须看不见");
  assert.equal(see(1, 0), true, "贴脸必须看得见");
  // 伪装（文件夹）期间一律看不见
  assert.equal(R.canSee(lv, pat, pat.x + 150, pat.y, { disguised: true }), false, "伪装期间必须免疫被发现");
  // 遮挡优先：把手电筒转过去对着工位，即使角度对也必须看不见
  const pat2 = { x: 1.5 * TILE, y: 8.5 * TILE, angle: 0, range: T.RANGE, halfFov: 0.5 };
  assert.equal(R.canSee(lv, pat2, 9.5 * TILE, 8.5 * TILE, {}), false, "中间隔着工位，角度对也不能看见");
  // anySees 返回第一个看见的
  assert.equal(R.anySees(lv, [pat], pat.x + 150, pat.y, {}), pat);
  assert.equal(R.anySees(lv, [pat], pat.x - 150, pat.y, {}), null);
});

/* ═══════════════ ④ 巡逻的确定性与难度 ═══════════════ */

test("巡逻：同 seed 完全可复现，换 seed 必须变（`每次重试随机巡逻`）", () => {
  for (const def of R.LEVELS) {
    const a = R.buildLevel(def, 5000, "normal").patrols.map((p) => p.x + "," + p.y + "," + p.angle).join("|");
    const b = R.buildLevel(def, 5000, "normal").patrols.map((p) => p.x + "," + p.y + "," + p.angle).join("|");
    const c = R.buildLevel(def, 5001, "normal").patrols.map((p) => p.x + "," + p.y + "," + p.angle).join("|");
    assert.equal(a, b, "[" + def.id + "] 同 seed 必须逐字复现（否则 bug 复现不了、蒙卡也测不了）");
    assert.notEqual(a, c, "[" + def.id + "] 换 seed 航线必须变，否则重试就变成背板子");
  }
});

test("地狱模式必须真的更难：巡逻更快、视野更广、伪装更短、时限更紧", () => {
  const n = R.MODES.normal, h = R.MODES.hell;
  const pn = R.buildLevel(R.LEVELS[2], 5, "normal").patrols[0];
  const ph = R.buildLevel(R.LEVELS[2], 5, "hell").patrols[0];
  assert.ok(ph.speed > pn.speed, "地狱的巡逻速度没有更快");
  assert.ok(ph.range > pn.range, "地狱的视距没有更远");
  assert.ok(ph.halfFov > pn.halfFov, "地狱的视野张角没有更宽");
  assert.ok(h.disguise < n.disguise, "地狱的伪装时间没有更短");
  assert.ok(h.time < n.time, "地狱的时限没有更紧");
});

/* ═══════════════ ⑤ 时钟与奖励的结构 ═══════════════ */

test("回归：时限必须 ≥ 最快可达时间（否则这一档数学上不可能通关）", () => {
  /* 这条是**真事**换来的：第一版给地狱模式定 150 秒，
     而三关 parTime 之和 ×0.92（skill 1.0 时的用时系数）≈ 166 秒 ——
     比理论最快还短 16 秒，实测超时率恒为 100%，也就是"这一档永远拿不到全通"。 */
  const fastest = (skill) => R.LEVELS.reduce((s, lv) => s + lv.parTime, 0) * (1.22 - 0.30 * skill);
  for (const id of Object.keys(R.MODES)) {
    const mode = R.MODES[id];
    const f1 = fastest(1.0);
    assert.ok(mode.time > f1,
      id + "：时限 " + mode.time + "s ≤ 理论最快 " + f1.toFixed(1) + "s，这一档不可能通关");
    // 还要留出一点容错，不能"刚好等于最快"
    assert.ok(mode.time >= f1 * 1.06, id + "：时限只比理论最快多 " + ((mode.time / f1 - 1) * 100).toFixed(1) + "%，没有容错空间");
  }
});

test("回归：奖励必须按通关进度打折（不能「什么都不做」也拿钱）", () => {
  /* 第一版时间分是全额给的，于是"一关不过、原地躲到时间结束"也能拿到满额时间分，
     实测 0 关却有 900 分、还能换到赔付 —— 那是一个不动就赚钱的漏洞。
     正确的结构：时间分 × (通关数 / 总关数)。 */
  let zeroClearedMax = 0;
  for (let i = 0; i < 200; i++) {
    const r = R.simulateRun("normal", 0.02, 70000 + i);
    if (r.cleared === 0) zeroClearedMax = Math.max(zeroClearedMax, r.score);
  }
  assert.ok(zeroClearedMax < R.scoreOf("level") * 0.5,
    "一关不过却拿到 " + zeroClearedMax + " 分（≥ 半关的分），奖励没有按进度打折");
  // 而且一关不过绝不该赚到钱
  for (let i = 0; i < 200; i++) {
    const r = R.simulateRun("normal", 0.02, 71000 + i);
    if (r.cleared === 0) assert.ok(r.net <= 0, "一关不过却是正收益：" + r.net);
  }
});

test("回归：失败 24 次必须判定为超时结束整轮，不能「跳着过关」", () => {
  /* 第一版写的是 `if (attempts > 24) break;` —— 只跳出内层 while，
     于是"第一关没过"会被当成过关继续打第二关，产出"0 关却有时间分"这类假数据。 */
  for (let i = 0; i < 200; i++) {
    const r = R.simulateRun("hell", 0.01, 81000 + i);
    assert.ok(r.cleared <= R.MODES.hell.levels, "通关数越界");
    if (r.timeout) assert.equal(r.remaining, 0, "判定超时却还有剩余时间");
  }
});

/* ═══════════════ ⑥ 计分与赔付 ═══════════════ */

test("计分：表里没有任何「被发现/被抓」的加分项", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(R.SCORE_TABLE, "caught"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(R.SCORE_TABLE, "detected"), false);
  assert.equal(R.scoreOf("caught"), 0, "未登记的事件一律 0 分");
  assert.equal(R.scoreOf("detected"), 0);
  assert.equal(R.scoreOf("任何没登记的名字"), 0);
  for (const k of Object.keys(R.SCORE_TABLE)) {
    if (k === "time") continue;
    assert.ok(R.scoreOf(k) > 0, k + " 的分值应为正");
  }
});

test("赔付：阶梯单调不减、0 分不给钱、封顶取最高档", () => {
  for (const id of Object.keys(R.PAYOUT)) {
    const lad = R.PAYOUT[id];
    assert.equal(R.payoutOf(0, id), 0, id + "：0 分不该给钱");
    assert.equal(R.payoutOf(-100, id), 0, id + "：负分不给钱");
    let prev = -1;
    for (let sc = 0; sc <= lad[lad.length - 1].min + 3000; sc += 71) {
      const p = R.payoutOf(sc, id);
      assert.ok(p >= prev, id + "：分数涨了赔付却降了（" + sc + "）");
      prev = p;
    }
    for (let i = 1; i < lad.length; i++) assert.ok(lad[i].min > lad[i - 1].min, id + "：门槛必须递增");
    assert.equal(lad[0].min, 0, id + "：第一档必须从 0 分开始");
  }
});

/* ═══════════════ ⑦ 经济不变量（相对 E[value]，不写死元数） ═══════════════ */

test("经济：乱撞必亏（低技能长期期望为负）", () => {
  for (const id of Object.keys(R.MODES)) {
    const e = meanNet(id, 0.03);
    assert.ok(e < 0, id + "：低技能居然能赚钱（E[净] = " + e.toFixed(2) + "）");
    assert.ok(e <= -T.ENTRY * 0.4, id + "：低技能亏损太浅（" + e.toFixed(2) + "），容错过高");
  }
});

test("经济：手熟能赚，且技术越好赚得越多（单调）", () => {
  for (const id of Object.keys(R.MODES)) {
    const lo = meanNet(id, 0.03);
    const mid = meanNet(id, 0.6);
    const hi = meanNet(id, 0.98);
    assert.ok(hi > 0, id + "：练熟了还不赚钱，玩家没有理由练");
    assert.ok(hi > mid, id + "：0.98 与 0.6 没拉开（" + mid.toFixed(2) + " → " + hi.toFixed(2) + "）");
    assert.ok(mid > lo, id + "：0.6 与 0.03 没拉开");
  }
});

test("经济：不能是印钞机（高技能期望收益相对入场费有界）", () => {
  for (const id of Object.keys(R.MODES)) {
    const hi = meanNet(id, 1.0);
    const cap = R.PAYOUT[id][R.PAYOUT[id].length - 1].pay - T.ENTRY;
    assert.ok(hi <= cap + 1e-9, id + "：期望收益超过最高档赔付 − 入场费");
    /* 写成"入场费的 N 倍"而不是写死元数 —— 调 ENTRY 时这条断言不会变成假绿灯 */
    assert.ok(hi < T.ENTRY * 3, id + "：E[净] = " + hi.toFixed(1) + " 超过入场费的 3 倍，属于印钞机");
  }
});

test("经济：两个模式的收益量级可比（没有哪一档明显更划算）", () => {
  const nets = Object.keys(R.MODES).map((m) => meanNet(m, 0.95));
  const lo = Math.min(...nets), hi = Math.max(...nets);
  assert.ok(lo > 0, "有模式在高技能下仍不赚钱");
  assert.ok(hi / lo < 2.5, "两个模式的收益量级差得太多（" + lo.toFixed(1) + " … " + hi.toFixed(1) + "）");
});

test("经济：三关全通必须比只过一关明显赚得多（进度要有意义）", () => {
  let sumAll = 0, nAll = 0, sumOne = 0, nOne = 0;
  for (let i = 0; i < 400; i++) {
    const r = R.simulateRun("normal", 0.95, 90000 + i);
    if (r.cleared === 3) { sumAll += r.net; nAll++; }
    if (r.cleared === 1) { sumOne += r.net; nOne++; }
  }
  assert.ok(nAll > 50, "样本里几乎没有全通的局（" + nAll + "），经济不变量测不出来");
  const eAll = sumAll / nAll;
  assert.ok(eAll > 0, "全通的期望收益居然是负的：" + eAll.toFixed(2));
  if (nOne > 5) {
    const eOne = sumOne / nOne;
    assert.ok(eAll > eOne + T.ENTRY, "全通(" + eAll.toFixed(1) + ") 与只过一关(" + eOne.toFixed(1) + ") 差得太少，进度没有意义");
  }
});

test("回归：评级分布与实机一致（S 只在三关全通且零被发现时出现）", () => {
  const seen = {};
  for (let i = 0; i < 600; i++) {
    const r = R.simulateRun("normal", 0.9, 12000 + i);
    seen[r.grade] = (seen[r.grade] || 0) + 1;
    if (r.grade === "S") assert.ok(r.allClear && r.ghost, "S 却不是「全通 + 零被发现」");
    if (r.grade === "A") assert.ok(r.allClear && !r.ghost, "A 却不是「全通但有被发现」");
  }
  assert.ok(Object.keys(seen).length >= 2, "评级分布太单一：" + JSON.stringify(seen));
});

/* ═══════════════ ⑧ 缺常量守卫 ═══════════════ */

test("回归：TUNE 里被代码引用的常量必须全部存在且是有限数", () => {
  /* 上一个玩法栽过：`TUNE.DOG_RANGE` 忘了定义 → `d < NaN` 恒假 → 整条机制是死的，
     而页面不报错、画面也完全正常。这类"缺常量"必须用断言挡住。 */
  const REQUIRED = [
    "ENTRY", "TILE", "P_R", "SPEED", "PATROL_SPEED",
    "FOV_DEG", "RANGE", "SCAN_SWEEP_DEG", "SCAN_TURN", "PATROL_TURN", "SCAN_HOLD",
    "DISGUISE_SEC", "DISGUISE_HELL", "FOLDER_PER_LEVEL",
    "COFFEE_LURE_SEC", "COFFEE_COOLDOWN", "COFFEE_REACH",
    "ELEV_WAIT", "ELEV_REACH", "TIME_NORMAL", "TIME_HELL", "REVEAL_SEC",
    "PER_LEVEL", "PER_SECOND_LEFT", "GHOST_BONUS", "SPEED_BONUS_MAX",
  ];
  const missing = REQUIRED.filter((k) => !Number.isFinite(T[k]));
  assert.deepEqual(missing, [], "TUNE 缺这些常量（代码引用了但它们不存在）：" + missing.join(", "));
  for (const k of ["TILE", "P_R", "SPEED", "PATROL_SPEED", "FOV_DEG", "RANGE", "ELEV_WAIT", "REVEAL_SEC"]) {
    assert.ok(T[k] > 0, k + " 必须为正");
  }
  // 视野锥张角必须在合理区间：太窄看不见人，太宽就没有躲的空间
  assert.ok(T.FOV_DEG > 30 && T.FOV_DEG < 140, "FOV_DEG = " + T.FOV_DEG + " 超出合理区间");
  // 视距至少要能覆盖两格，否则"视野"这件事读不出来
  assert.ok(T.RANGE > T.TILE * 2, "RANGE 太小（" + T.RANGE + "），视野锥没有意义");
});
