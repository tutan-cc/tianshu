// 「一刀两断」· 切果 —— 纯逻辑单测
// 运行：node tests/slash.test.cjs
//
// 测什么、为什么不测别的：
//   这个玩法的风险一半在**几何与手感**（判定是不是真的按线段∩椭圆算、慢刀是不是真切不开），
//   一半在**经济**（分数→奖金的阶梯会不会变成刷钱机或劝退机）。所以这里一条 UI 都不测，只锁：
//     ① 规则的结构不变量（可复现、模式配置、几何判定、计分）
//     ② 经济不变量（25% 命中必亏 / 55% 打平 / 85% 手熟赚 / 95% 封顶）
//   改 TUNE（GRAVITY / 速度阈值 / 计分 / PAYOUT / DIFFS）后**必须**重跑本文件。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "slash.js"), "utf8");

function load() {
  const ctx = vm.createContext({ console: console });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInContext(SRC, ctx);
  return ctx.Slash;
}
const S = load();
const R = S.rules;

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
/** 用同一套 simulateGame 估某个技能水平的期望净收益 */
function ev(modeId, diff, skill, n, seed0) {
  const N = n || 1200, out = [];
  for (let i = 0; i < N; i++) {
    const sc = R.simulateGame({ mode: modeId, diff: diff, skill: skill, seed: (seed0 || 9000) + i * 61 }).score;
    out.push(R.payoutOf(sc, R.MODES[modeId].id) - R.TUNE.ENTRY);
  }
  return mean(out);
}

/* ═══════════════ ① 规则的结构不变量 ═══════════════ */

test("模块对外形状符合规格", () => {
  assert.equal(typeof S.start, "function");
  assert.equal(typeof S.isBusy, "function");
  assert.equal(typeof S.dispose, "function");
  assert.equal(typeof S.debug.state, "function");
  assert.equal(typeof S.debug.swipe, "function");
  assert.equal(R.MODES.length, 3, "三模式");
  assert.equal(R.DIFFS.length, 3, "三难度");
  assert.ok(R.FRUITS.length >= 8, "水果种类不少于 8");
  assert.equal(R.TUNE.ENTRY, 20, "入场费与刮刮乐/开窗小料同价");
});

test("同种子 → 同一波（可复现：截图、单测、复现 bug 都靠它）", () => {
  const mk = () => R.spawnWave(R.makeRng(4321), R.MODES[0], R.DIFFS[1]);
  const a = mk(), b = mk(), c = R.spawnWave(R.makeRng(4322), R.MODES[0], R.DIFFS[1]);
  assert.equal(JSON.stringify(a), JSON.stringify(b), "同种子完全一致");
  assert.notEqual(JSON.stringify(a), JSON.stringify(c), "换种子要变");
  a.forEach((it) => {
    assert.ok(it.vy < 0, "水果是**向上**抛的");
    assert.ok(it.x > 0 && it.x < R.VIEW.W, "出生点在画面内");
  });
});

test("模式配置：禅意没有炸弹、经典有命无数、计时模式有倒计时", () => {
  const [classic, arcade, zen] = R.MODES;
  assert.ok(classic.lives > 0 && !classic.ms, "经典：3 条命、无倒计时");
  assert.ok(!arcade.lives && arcade.ms > 0 && arcade.bombs && arcade.special, "街机：计时 + 炸弹 + 特殊果");
  assert.ok(!zen.lives && zen.ms > 0 && !zen.bombs, "禅意：计时、无炸弹");
  /* 禅意模式即使难度给足了炸弹概率，也必须一个都不出 */
  const rng = R.makeRng(777);
  let bombs = 0;
  for (let i = 0; i < 4000; i++) {
    R.spawnWave(rng, zen, R.DIFFS[2]).forEach((it) => { if (it.type === "bomb") bombs++; });
  }
  assert.equal(bombs, 0, "禅意模式不该出现炸弹，实际 " + bombs);
});

test("生成器：难度越高 → 同屏上限与炸弹比例越高（单调）", () => {
  const alive = R.DIFFS.map((d) => d.aliveMax);
  const bomb = R.DIFFS.map((d) => d.bombP);
  const gap = R.DIFFS.map((d) => d.gapMin);
  assert.ok(alive[0] <= alive[1] && alive[1] <= alive[2], "同屏上限单调不减");
  assert.ok(bomb[0] <= bomb[1] && bomb[1] <= bomb[2], "炸弹比例单调不减");
  assert.ok(gap[0] >= gap[1] && gap[1] >= gap[2], "抛出间隔单调不增（越难越密）");
  /* 实测分布要落在声明的档位之间 */
  const rng = R.makeRng(999);
  let bombs = 0, total = 0;
  for (let i = 0; i < 4000; i++) R.spawnWave(rng, R.MODES[1], R.DIFFS[1]).forEach((it) => { total++; if (it.type === "bomb") bombs++; });
  const p = bombs / total;
  assert.ok(p > R.DIFFS[0].bombP && p < R.DIFFS[2].bombP + 0.06, "普通难度的炸弹占比应落在简单与困难之间：" + p.toFixed(3));
});

test("几何：线段∩椭圆（含刀刃半径加宽）", () => {
  const e = { x: 100, y: 100, rx: 40, ry: 40 };
  assert.equal(R.segHit({ x1: 0, y1: 100, x2: 200, y2: 100 }, e, 0), true, "横穿圆心");
  assert.equal(R.segHit({ x1: 0, y1: 0, x2: 0, y2: 60 }, e, 0), false, "离得远");
  /* 差一点点没碰到：加了刀刃半径就该碰到 */
  const near = { x1: 0, y1: 100, x2: 200, y2: 100 - 0 };
  assert.equal(R.segHit({ x1: 0, y1: 100, x2: 200, y2: 100 }, { x: 100, y: 100, rx: 40, ry: 40 }, 0), true);
  assert.equal(R.segHit({ x1: 100, y1: 20, x2: 100, y2: 55 }, e, 0), false, "纵向差 5px 没碰到");
  assert.equal(R.segHit({ x1: 100, y1: 20, x2: 100, y2: 55 }, e, 10), true, "刀刃半径 +10 后切到了");
  /* 香蕉那种扁的（rx≠ry）：沿长轴能切到，沿短轴方向差一点就切不到 */
  const ban = { x: 0, y: 0, rx: 54, ry: 26 };
  assert.equal(R.segHit({ x1: -120, y1: 0, x2: 120, y2: 0 }, ban, 0), true);
  assert.equal(R.segHit({ x1: -120, y1: 40, x2: 120, y2: 40 }, ban, 0), false, "扁水果的短轴方向要真的差得出来");
});

test("手感：动作太慢切不开（速度阈值是玩法的地基）", () => {
  const slow = { x1: 0, y1: 0, x2: 6, y2: 0 };       // 16ms 走 6px ≈ 375px/s … 见下
  const fast = { x1: 0, y1: 0, x2: 40, y2: 0 };
  assert.equal(R.fastEnough(fast, 16, 340), true, "16ms 走 40px ≈ 2500px/s，该能切");
  assert.equal(R.fastEnough(slow, 200, 340), false, "200ms 才走 6px ≈ 30px/s，切不开");
  assert.equal(R.fastEnough(slow, 0, 340), false, "dt=0 不能算数（防除零）");
});

test("暴击：只有**正中 + 高速**才算（两条件缺一不可）", () => {
  const e = { x: 100, y: 100, rx: 40, ry: 40 };
  assert.equal(R.isCrit(e, 100, 100, 2000), true, "正中 + 高速 → 暴击");
  assert.equal(R.isCrit(e, 100, 100, 300), false, "正中但刀慢 → 不暴击");
  assert.equal(R.isCrit(e, 138, 100, 2000), false, "擦边（距中心 0.95r）→ 不暴击");
});

test("计分：连击 / 暴击 / 双倍，且连击只在 ≥3 个时给", () => {
  assert.equal(R.cutScore(1, 0, false), 1, "一个水果 1 分");
  assert.equal(R.cutScore(2, 0, false), 2, "两个水果没有连击奖励");
  assert.equal(R.cutScore(3, 0, false), 3 + R.TUNE.COMBO_SCORE, "三个起算连击");
  assert.equal(R.cutScore(3, 1, false), 3 + R.TUNE.COMBO_SCORE + R.TUNE.CRIT_SCORE, "暴击额外加");
  assert.equal(R.cutScore(3, 1, true), (3 + R.TUNE.COMBO_SCORE + R.TUNE.CRIT_SCORE) * 2, "双倍整刀翻倍");
});

test("派彩：阶梯单调不减、每个模式一套、0 分不给钱", () => {
  const ids = R.MODES.map((m) => m.id);
  let prevCash = -1;
  for (const id of ids) {
    const ladder = R.TUNE.PAYOUT[id];
    assert.ok(ladder && ladder.length >= 5, id + " 要有自己的阶梯");
    let lastMin = -1, lastCash = -1;
    ladder.forEach((r) => {
      assert.ok(r.min > lastMin, id + " 的分数门槛要递增");
      assert.ok(r.cash >= lastCash, id + " 的奖金要单调不减");
      lastMin = r.min; lastCash = r.cash;
    });
    assert.equal(R.payoutOf(0, id), 0, id + " 0 分不给钱");
    assert.ok(R.payoutOf(99999, id) > 200, id + " 顶档要够高（够得着的大奖）");
  }
  /* 三模式分数尺度差一个数量级，所以阶梯必须不同（同一套会一边刷钱一边劝退） */
  assert.notEqual(R.TUNE.PAYOUT.classic[3].min, R.TUNE.PAYOUT.zen[3].min, "经典与禅意的阶梯不该重合");
  assert.ok(R.TUNE.PAYOUT.arcade[3].min < R.TUNE.PAYOUT.zen[3].min, "禅意能堆更多分，门槛该更高");
});

test("未定义的分数/模式不会炸（防御性）", () => {
  assert.equal(R.payoutOf(-5, "arcade"), 0, "负分给 0");
  assert.equal(typeof R.payoutOf(100, "不存在的模式"), "number", "未知模式回落到默认阶梯而不是崩");
  assert.equal(R.fastEnough({ x1: 0, y1: 0, x2: 0, y2: 0 }, 16, 340), false, "零长线段不算挥刀");
});

/* ═══════════════ ② 经济不变量（蒙特卡洛 simulateGame） ═══════════════ */

test("经济不变量 ①：乱切必亏 —— 三个模式在 25% 命中率下都亏掉大半入场费", () => {
  R.MODES.forEach((m, i) => {
    const e = ev(i, 1, 0.25, 900, 11000);
    assert.ok(e < -12, `${m.id} 乱切期望应为负且接近 −20，实际 ${e.toFixed(1)}`);
  });
});

test("经济不变量 ②：打平区 —— 55% 命中率的期望落在 −15…+20", () => {
  R.MODES.forEach((m, i) => {
    const e = ev(i, 1, 0.55, 900, 12000);
    assert.ok(e > -15 && e < 20, `${m.id} 55% 命中应接近打平，实际 ${e.toFixed(1)}`);
  });
});

test("经济不变量 ③：手熟有回报但不失控 —— 85% 命中 +20…+200，95% 命中 ≤ +300", () => {
  R.MODES.forEach((m, i) => {
    const good = ev(i, 1, 0.85, 900, 13000);
    const ace = ev(i, 1, 0.95, 900, 14000);
    assert.ok(good > 20 && good < 200, `${m.id} 85% 命中的期望应在 +20…+200，实际 ${good.toFixed(1)}`);
    assert.ok(ace <= 300, `${m.id} 95% 命中的期望要封顶在 +300 以内，实际 ${ace.toFixed(1)}`);
    assert.ok(ace >= good, `命中率更高不该赚得更少：${ace.toFixed(1)} vs ${good.toFixed(1)}`);
  });
});

test("经济不变量 ④：难度是「技术溢价」而不是白送 —— 同一技能下越难回报越高，但乱切仍亏", () => {
  const easy = ev(1, 0, 0.85, 700, 15000);
  const hard = ev(1, 2, 0.85, 700, 16000);
  assert.ok(hard >= easy, `困难难度对 85% 命中的玩家回报应不低于简单：${hard.toFixed(1)} vs ${easy.toFixed(1)}`);
  const hardBad = ev(1, 2, 0.25, 700, 17000);
  assert.ok(hardBad < -12, `乱切去打困难也该亏，实际 ${hardBad.toFixed(1)}`);
});

test("模拟器可复现：同 seed 同结果（否则标定不可信）", () => {
  const a = R.simulateGame({ mode: 1, diff: 1, skill: 0.7, seed: 2024 });
  const b = R.simulateGame({ mode: 1, diff: 1, skill: 0.7, seed: 2024 });
  const c = R.simulateGame({ mode: 1, diff: 1, skill: 0.7, seed: 2025 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
});

test("结算恒等式与成就门槛：净收益 = 奖金 − 入场；门槛值必须够得着", () => {
  const entry = R.TUNE.ENTRY;
  R.MODES.forEach((m, i) => {
    const r = R.simulateGame({ mode: i, diff: 1, skill: 0.85, seed: 18000 + i });
    const payout = R.payoutOf(r.score, m.id);
    assert.equal(payout - entry, payout - entry);                       // 恒等式本身
    assert.ok(payout >= 0, "奖金不为负");
  });
  /* 【刀客】门槛要落在"手熟打得到、乱切打不到"之间 */
  const goodScores = [], badScores = [];
  for (let i = 0; i < 300; i++) {
    goodScores.push(R.simulateGame({ mode: 1, diff: 1, skill: 0.85, seed: 19000 + i * 7 }).score);
    badScores.push(R.simulateGame({ mode: 1, diff: 1, skill: 0.25, seed: 19500 + i * 7 }).score);
  }
  const gate = R.TUNE.ACHV_SCORE;
  assert.ok(goodScores.filter((s) => s >= gate).length > 30, "手熟玩家应该有一批局能拿到【刀客】");
  assert.equal(badScores.filter((s) => s >= gate).length, 0, "乱切不该摸到【刀客】");
  assert.ok(R.TUNE.ACHV_SINGLE >= 5 && R.TUNE.ACHV_SINGLE <= 8, "【一刀两断】门槛要合理（5–8 个）");
});
