// 「准点下班」· 办公室潜行 —— 纯逻辑单测（V2：3000×2000 连续世界）
// 运行：node tests/clockout.test.cjs
//
// 测什么、为什么不测别的：
//   V2 把引擎从"瓦片网格"换成了"连续世界像素 + 墙体矩形 + 视野锥"，风险随之集中到四处，
//   而这四类错误在画面上全都只表现为"有点怪"：
//     ① **视线与视野锥**。判定就是两个纯函数，潜行游戏的 bug 几乎全在这里 ——
//        "隔着墙也看得见"、"正好贴在锥边上反而绝对安全"、"距离差 0.001px 就看不见"。
//        眼睛看不出来，只有直接喂世界像素验边界才验得动。
//     ② **巡逻 AI 与寻路**。NPC 不穿墙、不卡死、同 seed 逐位可复现，这三件事任一坏掉，
//        表现都只是"这局有点怪"，但复现、调参与背板子全废。
//     ③ **地图几何**。关键点落在墙里 / 出口走不到 / 某面墙既拦不住人也挡不住视线。
//     ④ **状态机与时机**。失败必须整局字节级冻结、文件夹必须提前用、cover 当帧到期当帧失效、
//        换层必须换图且整段继承剩余时间 —— 这些差一帧就变成"有时能过有时不能过"。
//   所以这里一条像素都不测，只锁上面四类 + 本项目原有的两条老不变量（缺常量守卫 / 经济不变量）。
//   规格 §8 的 11 条上游契约逐条对应下面的 `契约N：` 测试名，另加本项目最看重的视野锥边界
//   与两条不变量（契约 12–14）。
//   改 clockout.js 的 MAPS / MODES / LEVELS / 视线判定 / tick 顺序之后**必须**重跑本文件。
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
const MODES = Object.keys(R.MODES);
const LEVELS = R.LEVELS;
const WORLD_R = 18;      /* 规格 §1.2：玩家移动与 NPC 移动用的碰撞半径 */

/* ── 工具 ───────────────────────────────────────────────────────────────── */

/* 按 30fps 推进模拟（上游 tests/game.test.mjs 的 advance 口径）。 */
function advance(g, seconds, input) {
  const n = Math.round(seconds * 30);
  for (let i = 0; i < n; i++) R.tick(g, 1 / 30, input);
}
/* "被暴露"的一局：玩家站在空地，一个 300 视距的主管正对着他（pause 钉住不动）。
   站在这里是为了让"看见 / 没看见"只由被测的那一个变量决定。 */
function exposed() {
  const g = R.createGame(1, [], "normal", 42);
  R.start(g);
  g.player = { x: 1500, y: 1100, moving: false };
  g.npcs = [{ id: "supervisor", x: 1500, y: 950, range: 300, fov: 1.2,
              angle: Math.PI / 2, pause: 100, route: [], target: 0 }];
  return g;
}
function patrolCount(g) {
  let c = 0;
  for (let i = 0; i < g.npcs.length; i++) if (g.npcs[i].id !== "coworker") c++;
  return c;
}
function meanNet(mode, skill, n, seed0) {
  let sum = 0;
  n = n || 300; seed0 = seed0 || 50000;
  for (let i = 0; i < n; i++) sum += R.simulateRun(mode, skill, seed0 + i).net;
  return sum / n;
}
/* 建局很贵：出生点重选要扫 26×14 的候选网格、每个候选还要跑一次 BFS 寻路。
   所以"只看不改"的断言统一走这个带缓存的入口，别把同一局反复建（整套要跑在 5 秒内）。
   ⚠ 任何会改 g 的场景（tick / start / interact / 改 phase）必须自己 R.createGame。 */
const specCache = new Map();
function specGame(level, mode, seed, floor) {
  const key = level + "|" + mode + "|" + seed + "|" + (floor || 1);
  if (!specCache.has(key)) specCache.set(key, R.createGame(level, [], mode, seed, floor));
  return specCache.get(key);
}

/* ═══════════════ ① 模块形状（本项目原有不变量） ═══════════════ */

test("模块对外形状符合规格（V2 版本号 + 调试钩子一个不少）", () => {
  assert.equal(typeof C.start, "function", "Clockout.start 必须存在（浏览器验收脚本依赖它）");
  assert.equal(typeof C.isBusy, "function", "Clockout.isBusy 必须存在");
  assert.equal(typeof C.dispose, "function", "Clockout.dispose 必须存在");
  assert.equal(typeof C.version, "string", "Clockout.version 必须是字符串");
  assert.equal(typeof C.debug.state, "function", "debug.state 必须存在");
  assert.equal(typeof C.debug.tick, "function", "debug.tick 必须存在");
  assert.equal(typeof C.debug.retry, "function", "debug.retry 必须存在（失败后 E/空格已失效，重试只能走它或点画面）");
  assert.equal(typeof C.debug.seek, "function", "debug.seek 必须存在");
  assert.equal(typeof C.debug.placePatrol, "function", "debug.placePatrol 必须存在");
});

test("rules 暴露 V2 的全部纯函数（规格 §1–§5 的判定层）", () => {
  const need = ["walkable", "clearLine", "segmentWalkable", "pathTo", "sees", "captureIfSeen",
                "buildLevel", "validateLevel", "retryLevel", "nextLevel", "createGame"];
  const missing = need.filter((k) => typeof R[k] !== "function");
  assert.deepEqual(missing, [], "rules 少了这些纯函数（判定层必须能被单测直接调用）：" + missing.join(", "));
});

test("MODES 恰好三档，且每档都带齐 V2 真正生效的字段", () => {
  assert.equal(MODES.length, 3, "难度必须恰好三档（普通/变态/地狱）");
  const fields = ["speed", "range", "time", "extra", "wait", "cover", "pause", "floors"];
  const missing = [];
  for (const m of MODES) for (const f of fields) if (!Number.isFinite(R.MODES[m][f])) missing.push(m + "." + f);
  assert.deepEqual(missing, [], "MODES 缺字段或值不是有限数：" + missing.join(", "));
});

test("LEVELS 恰好三关，且第 i 关与第 i 张地图一一对应", () => {
  assert.equal(LEVELS.length, 3, "必须恰好三关");
  assert.deepEqual(LEVELS.map((l) => l.mapId), R.MAPS.map((m) => m.id),
    "第 i 关的 mapId 必须等于第 i 张地图的 id（关卡 ↔ 地图一一对应）");
});

test("MODES[x].time 是**倍率**不是秒数：实际时限 = round(LEVELS.time × 倍率)", () => {
  const bad = [];
  for (const m of MODES) for (let l = 1; l <= 3; l++) {
    const g = specGame(l, m, 3);
    const want = Math.round(LEVELS[l - 1].time * R.MODES[m].time);
    if (g.config.time !== want) bad.push(m + " L" + l + " 实际 " + g.config.time + " ≠ " + want);
  }
  assert.deepEqual(bad, [], "时限没有按倍率折算（把 MODES.time 当成秒数用会直接算错）：" + bad.join("; "));
});

/* ═══════════════ ② 契约 1：三张图互不相同 + 五个关键点可达 ═══════════════ */

test("契约1：三张地图的 walls 互不相同", () => {
  const n = new Set(R.MAPS.map((m) => JSON.stringify(m.walls))).size;
  assert.equal(n, 3, "三张地图的墙体几何必须互不相同，否则换关其实是在同一张图上跑");
});

test("契约1：每关 5 个关键点都能站人 walkable(p,18)", () => {
  const bad = [];
  for (let l = 1; l <= 3; l++) {
    const g = specGame(l, "normal", 7);
    for (const id of Object.keys(g.map.points)) {
      const p = g.map.points[id];
      if (!R.walkable(p.x, p.y, WORLD_R, g.map)) bad.push("L" + l + " " + id + "(" + p.x + "," + p.y + ")");
    }
  }
  assert.deepEqual(bad, [], "关键点落在墙里（玩家站不上去，整关直接废）：" + bad.join(", "));
});

test("契约1：每关 5 个关键点都能从出生点走得到（pathTo 非空）", () => {
  const bad = [];
  for (let l = 1; l <= 3; l++) {
    const g = specGame(l, "normal", 7);
    for (const id of Object.keys(g.map.points)) {
      if (!R.pathTo(g.map, g.player, g.map.points[id]).length) bad.push("L" + l + " " + id);
    }
  }
  assert.deepEqual(bad, [], "关键点从出生点走不到（不可通关，潜行游戏最恶心的 bug）：" + bad.join(", "));
});

test("契约1：validateLevel 对三张地图都报不出问题", () => {
  const probs = [];
  for (const m of R.MAPS) probs.push(...R.validateLevel(m));
  assert.equal(probs.length, 0, "地图自检不过：\n  " + probs.join("\n  "));
});

/* ═══════════════ ③ 契约 2：家具既挡路又挡视线 ═══════════════ */

test("契约2：每面墙的中心 walkable(...,18) 必须为 false（挡得住人）", () => {
  const bad = [];
  for (const map of R.MAPS) {
    for (const a of map.walls) {
      if (R.walkable(a[0] + a[2] / 2, a[1] + a[3] / 2, WORLD_R, map) !== false) bad.push("图" + map.id + " " + JSON.stringify(a));
    }
  }
  assert.deepEqual(bad, [], "这些墙太薄，玩家能站进墙里（家具形同虚设）：" + bad.join(", "));
});

test("契约2：横穿每面墙的 clearLine 必须为 false（挡得住视线）", () => {
  const bad = [];
  for (const map of R.MAPS) {
    for (const a of map.walls) {
      const y = a[1] + a[3] / 2;
      if (R.clearLine({ x: a[0] - 40, y: y }, { x: a[0] + a[2] + 40, y: y }, map) !== false) bad.push("图" + map.id + " " + JSON.stringify(a));
    }
  }
  assert.deepEqual(bad, [], "隔着这些墙还能互相看见（潜行的遮挡完全失效）：" + bad.join(", "));
});

/* ═══════════════ ④ 契约 3：同 seed 可复现，换 seed 必须变 ═══════════════ */

test("契约3：同 seed 建局完全可复现（npcs 逐字段一致）", () => {
  const a = R.createGame(1, [], "hell", 11);
  const b = R.createGame(1, [], "hell", 11);
  assert.equal(JSON.stringify(a.npcs), JSON.stringify(b.npcs),
    "同 seed 两次建局的 NPC 不一致（bug 复现不了、蒙卡也测不了）");
});

test("契约3：不同 seed 的巡逻目的地必须不同（否则重试就是背板子）", () => {
  const bad = [];
  for (const m of MODES) {
    const a = specGame(2, m, 1337);
    const b = specGame(2, m, 1338);
    if (JSON.stringify(a.npcs.map((n) => n.route)) === JSON.stringify(b.npcs.map((n) => n.route))) bad.push(m);
  }
  assert.deepEqual(bad, [], "换 seed 后巡逻路线一字不变（重试变成背板子，随机巡查名存实亡）：" + bad.join(", "));
});

/* ═══════════════ ⑤ 契约 4：巡逻不穿墙、不卡死 ═══════════════ */

/* 这条是全场最贵的一条：3 关 × 3 模式 × 2 seed，各跑满 1800 帧（dt=0.05 → 90 秒）。
   seed 取 2 个而不是 3 个，纯粹是为了让整套跑进 5 秒 —— 帧数一帧没减（"跑足"这件事不能打折）。
   玩家用 cover=1000 免疫，把"被抓"这个变量摘掉，只留巡逻本身。跑一次给下面两条断言共用。 */
let patrolRun = null;
function runPatrolStress() {
  if (patrolRun) return patrolRun;
  const offTrack = [], stuck = [];
  for (let l = 1; l <= 3; l++) {
    for (const mode of MODES) {
      for (let seed = 1; seed <= 2; seed++) {
        const tag = "L" + l + "/" + mode + "/seed" + seed;
        const g = R.createGame(l, [], mode, seed);
        R.start(g);
        g.time = 1000; g.cover = 1000;                 /* 免疫 + 不会超时 */
        const origins = g.npcs.map((n) => ({ x: n.x, y: n.y }));
        let escaped = false;
        for (let i = 0; i < 1800 && !escaped; i++) {
          R.tick(g, 0.05);
          for (const n of g.npcs) {
            if (!R.walkable(n.x, n.y, WORLD_R, g.map)) {
              offTrack.push(tag + " " + n.id + " 在 (" + n.x.toFixed(1) + "," + n.y.toFixed(1) + ")");
              escaped = true;
              break;
            }
          }
        }
        g.npcs.forEach((n, i) => {
          const d = Math.hypot(n.x - origins[i].x, n.y - origins[i].y);
          if (!(d > 20)) stuck.push(tag + " " + n.id + " 90 秒只挪了 " + d.toFixed(2) + "px");
        });
      }
    }
  }
  patrolRun = { offTrack: offTrack, stuck: stuck };
  return patrolRun;
}

test("契约4：多关×多模式×多 seed 跑满 1800 帧，每帧每个 NPC 都在可走位置", () => {
  const r = runPatrolStress();
  assert.deepEqual(r.offTrack.slice(0, 3), [], "巡逻者穿墙 / 走出了可走区域：" + r.offTrack.slice(0, 3).join(" | "));
});

test("契约4：跑满 90 秒后每个 NPC 位移都必须 > 20px（没有卡死）", () => {
  const r = runPatrolStress();
  assert.deepEqual(r.stuck.slice(0, 3), [], "有巡逻者 90 秒原地不动（撞墙清空路线后没能自愈）：" + r.stuck.slice(0, 3).join(" | "));
});

/* ═══════════════ ⑥ 契约 5：出生点安全（第一帧不会即被抓） ═══════════════ */

test("契约5：每种模式每关建局后第一帧仍是 playing", () => {
  const bad = [];
  for (let l = 1; l <= 3; l++) {
    for (const mode of MODES) {
      const g = R.createGame(l, [], mode, 1);
      R.start(g);
      R.tick(g, 0.05);
      if (g.phase !== "playing") bad.push("L" + l + "/" + mode + " → " + g.phase + "：" + g.message);
    }
  }
  assert.deepEqual(bad, [], "出生点不安全（开局第一帧就被抓，这一档根本没法玩）：" + bad.join(" | "));
});

/* ═══════════════ ⑦ 契约 6：进入视野第一帧失败 + 失败后整局冻结 ═══════════════ */

test("契约6：进入视野的第一帧立即 lost，且 suspicion=100", () => {
  const g = exposed();
  assert.equal(R.sees(g.npcs[0], g.player, g.map), true, "测试前提：这一局确实已经被主管看见");
  R.tick(g, 0.03);
  assert.equal(g.phase, "lost", "第一帧被看见却没有立即失败（潜行的核心承诺：看见即结束）");
  assert.equal(g.suspicion, 100, "被抓当帧 suspicion 必须是 100（HUD 靠它切红色暴露态）");
});

test("契约6：失败后施加输入 / E / 空格，整个状态快照完全不变", () => {
  const g = exposed();
  R.tick(g, 0.03);
  /* 契约是「失败并结算之后任何输入都改不动状态」，不是「结算之前不可变」。
     R.tick 是内层 tick，只把局面打成 lost、不负责结算（结算是收口函数的职责），
     所以这里必须先显式结算一次再截图 —— 否则测的是「结算本身会不会漂」而不是「冻结」。 */
  R.settleIfLost(g);
  assert.equal(g.settled, true, "失败后没有结算（result 会恒为 null、onSettle 不触发）");
  const snap = JSON.stringify(g);
  for (let i = 0; i < 60; i++) R.tick(g, 1 / 30, { x: 1, y: 0 });
  R.useFile(g);
  R.interact(g);
  assert.equal(JSON.stringify(g), snap, "结算之后整局没有字节级冻结（移动/用文件夹/交互还能改状态）");
});

/* ═══════════════ ⑧ 契约 7：文件夹必须提前用 + cover 当帧到期当帧失效 ═══════════════ */

test("契约7：被看见的当帧用文件夹无法补救（仍 lost，且 file 保留在手上）", () => {
  const late = exposed();
  late.file = true;
  R.useFile(late);
  assert.equal(late.phase, "lost", "被看见当帧用文件夹竟然补救成功（文件夹变成了免死金牌，可以一路按过去）");
  assert.equal(late.file, true, "失败那一帧不该消耗文件夹（先捕获后使用，file 必须原样留着）");
});

test("契约7：提前使用文件夹得到 cover === coverDuration", () => {
  const early = exposed();
  early.npcs[0].angle = 0;                    /* 先把主管转开，别让"使用"这一步本身失败 */
  early.file = true;
  R.useFile(early);
  assert.equal(early.cover, early.config.coverDuration,
    "用文件夹后的免疫时长不等于 coverDuration（模式伪装时长形同虚设）");
});

test("契约7：cover > 0 期间即使正对视野也安全（1 秒内仍 playing）", () => {
  const early = exposed();
  early.npcs[0].angle = 0;
  early.file = true;
  R.useFile(early);
  early.npcs[0].angle = Math.PI / 2;           /* 立刻转回来正对玩家 */
  advance(early, 1);
  assert.equal(early.phase, "playing", "伪装有效期内仍然被抓（cover 没有真正免疫视线）");
});

test("契约7：cover 降到 0.01 时遇 dt=0.03 当帧即失效（先递减后判定）", () => {
  const early = exposed();
  early.npcs[0].angle = 0;
  early.file = true;
  R.useFile(early);
  early.npcs[0].angle = Math.PI / 2;
  early.cover = 0.01;
  R.tick(early, 0.03);
  assert.equal(early.phase, "lost", "保护到期不是当帧生效（cover 先判定后递减的话会白送一帧无敌）");
});

/* ═══════════════ ⑨ 契约 8：难度压力关系 + 重试/过关保留 ═══════════════ */

/* 三档压力关系只用第 2 关（bossDelay≠0 且时限各不相同）横向比。
   这一组是纯读的，走缓存入口。 */
function modeTrio() { return MODES.map((m) => specGame(2, m, 0)); }

test("契约8：时限关系 普通 > 变态 > 地狱/层数", () => {
  const [n, e, h] = modeTrio();
  assert.ok(n.time > e.time && e.time > h.time / h.floors,
    "时限关系不成立：" + n.time + " / " + e.time + " / " + (h.time / h.floors) +
    "（变态必须比普通短；地狱更长是因为两层共用，按层折算后必须仍比变态紧）");
});

test("契约8：NPC 数随难度递增", () => {
  const [n, e, h] = modeTrio();
  assert.ok(n.npcs.length < e.npcs.length && e.npcs.length < h.npcs.length,
    "NPC 数没有随难度递增：" + n.npcs.length + " / " + e.npcs.length + " / " + h.npcs.length);
});

test("契约8：coverDuration 随难度递减", () => {
  const [n, e, h] = modeTrio();
  assert.ok(n.config.coverDuration > e.config.coverDuration && e.config.coverDuration > h.config.coverDuration,
    "伪装时长没有随难度递减：" + n.config.coverDuration + " / " + e.config.coverDuration + " / " + h.config.coverDuration);
});

test("契约8：liftWait 随难度递增", () => {
  const [n, e, h] = modeTrio();
  assert.ok(n.config.liftWait < e.config.liftWait && e.config.liftWait < h.config.liftWait,
    "电梯等待没有随难度递增：" + n.config.liftWait + " / " + e.config.liftWait + " / " + h.config.liftWait);
});

test("契约8：retryLevel 保留 mode/clearedTimes、回到本关第一层、换新 seed", () => {
  const g = R.createGame(2, [12], "hell", 5, 2);
  const retry = R.retryLevel(g);
  assert.equal(retry.mode, "hell", "重试丢了模式（重试会变成换难度）");
  assert.equal(retry.level, 2, "重试没有回到本关");
  assert.equal(retry.floor, 1, "地狱二层重试没有回到第一层（会带着「已经上过二层」的状态重开）");
  assert.equal(JSON.stringify(retry.clearedTimes), "[12]", "重试丢了已通关记录（进度被清空）");
  assert.notEqual(retry.seed, g.seed, "重试沿用了旧 seed（重试变成背板子）");
});

test("契约8：nextLevel 保留 mode、level+1、并把本关 elapsed 追加进 clearedTimes", () => {
  const g = R.createGame(2, [12], "extreme", 5);
  g.phase = "won";
  g.elapsed = 15;
  const next = R.nextLevel(g);
  assert.equal(next.mode, "extreme", "过关后丢了模式");
  assert.equal(next.level, 3, "nextLevel 没有推进到下一关");
  assert.equal(JSON.stringify(next.clearedTimes), "[12,15]", "本关 elapsed 没有入账到 clearedTimes");
});

/* ═══════════════ ⑩ 契约 9：三模式 × 三关 × 每层 全流程实跑 ═══════════════ */

/* 这条要"真的按 pathTo 走过去"，所以是整套里最贵的一段：跑一次，把每一步观测都记进 row，
   再由下面的若干条测试各断言一件事（一条测试只锁一个契约）。 */
function walkTo(g, p, row) {
  const route = R.pathTo(g.map, g.player, p);
  row.routeLens.push(route.length);
  if (!route.length) { row.notes.push("pathTo 返回空 → (" + p.x + "," + p.y + ")"); return false; }
  const pts = [];
  for (let i = 0; i < route.length; i++) pts.push([route[i][0], route[i][1]]);
  pts.push([p.x, p.y]);
  for (let k = 0; k < pts.length; k++) {
    const tx = pts[k][0], ty = pts[k][1];
    let arrived = false;
    for (let i = 0; i < 200; i++) {
      const dx = tx - g.player.x, dy = ty - g.player.y, d = Math.hypot(dx, dy);
      if (d < 4) { arrived = true; break; }
      R.tick(g, 1 / 60, { x: dx / d, y: dy / d });
      if (g.phase !== "playing") { row.notes.push("走位途中离开 playing：" + g.phase + " / " + g.message); return false; }
    }
    if (!arrived) {
      row.notes.push("走不到路点 (" + tx + "," + ty + ")，玩家卡在 (" +
        g.player.x.toFixed(1) + "," + g.player.y.toFixed(1) + ")");
      return false;
    }
  }
  return true;
}
let flowRun = null;
function runFlow() {
  if (flowRun) return flowRun;
  const rows = [], levels = [];
  for (const mode of MODES) {
    let g = R.createGame(1, [], mode, 10);
    for (let l = 1; l <= 3; l++) {
      R.start(g);
      const lv = { mode: mode, level: l, startPhase: g.phase, rows: [] };
      for (let floor = 1; floor <= g.floors; floor++) {
        const r = { mode: mode, level: l, floor: floor, floors: g.floors, notes: [], routeLens: [] };
        r.floorOk = (g.floor === floor);
        r.patrolsAtStart = patrolCount(g);
        g.npcs = [];                                    /* 隔离潜行层：这条只验"能不能走通流程" */
        r.walkPrinter = walkTo(g, g.map.points.printer, r);
        r.phaseAfterWalkPrinter = g.phase;
        r.interactPrinter = R.interact(g);
        r.fileAfterPickup = g.file === true;
        r.useFileOk = R.useFile(g);
        r.cover = g.cover;
        r.coverDuration = g.config.coverDuration;
        r.walkLift = walkTo(g, g.map.points.lift, r);
        r.phaseAfterWalkLift = g.phase;
        r.interactLiftCall = R.interact(g);
        r.liftAfterCall = g.lift;
        r.liftTimerAfterCall = g.liftTimer;
        r.liftWait = g.config.liftWait;
        advance(g, g.config.liftWait + 0.1);
        r.liftAfterWait = g.lift;
        r.phaseAfterWait = g.phase;
        const oldMapId = g.map.id, oldTime = g.time, oldElapsed = g.elapsed;
        r.interactLiftEnter = R.interact(g);
        r.phaseAfterEnter = g.phase;
        r.mapChanged = g.map.id !== oldMapId;
        r.timeKept = g.time === oldTime;
        r.elapsedKept = g.elapsed === oldElapsed;
        r.cargoCleared = (g.file === false && g.fileTaken === false && g.cover === 0);
        r.floorAfter = g.floor;
        if (floor < g.floors) {
          r.patrolsOnSecondFloor = patrolCount(g);
          advance(g, 3);                                /* floor-intro 期间推 3 秒 */
          r.timeFrozen = g.time === oldTime;
          r.elapsedFrozen = g.elapsed === oldElapsed;
          r.nextLevelInFloorIntro = R.nextLevel(g);
          r.enterFloorOk = R.enterFloor(g);
          r.phaseAfterEnterFloor = g.phase;
        } else {
          r.phaseFinal = g.phase;
        }
        rows.push(r); lv.rows.push(r);
      }
      lv.totalTime = R.totalTime(g);
      lv.afterLastFloor = g.phase;
      lv.next = R.nextLevel(g);
      levels.push(lv);
      if (l < 3) { if (lv.next) g = lv.next; else break; }
    }
  }
  flowRun = { rows: rows, levels: levels };
  return flowRun;
}
function flowRows() { return runFlow().rows; }

test("契约9：每层都能按 pathTo 实走到打印区", () => {
  const bad = flowRows().filter((r) => !r.walkPrinter)
    .map((r) => r.mode + "/L" + r.level + "/F" + r.floor + " " + r.notes.join("；"));
  assert.deepEqual(bad, [], "走不到打印区（这一层不可能通关）：" + bad.join(" | "));
});

test("契约9：在打印区按 E 就能拿到文件夹", () => {
  const bad = flowRows().filter((r) => !r.interactPrinter || !r.fileAfterPickup)
    .map((r) => r.mode + "/L" + r.level + "/F" + r.floor + " file=" + r.fileAfterPickup);
  assert.deepEqual(bad, [], "站在打印区按 E 却拿不到文件夹：" + bad.join(" | "));
});

test("契约9：走位全程都留在 playing（路没被堵死，也没踩进视野）", () => {
  const bad = [];
  for (const r of flowRows()) {
    if (r.phaseAfterWalkPrinter !== "playing" || r.phaseAfterWalkLift !== "playing") {
      bad.push(r.mode + "/L" + r.level + "/F" + r.floor + " " + r.notes.join("；"));
    }
  }
  assert.deepEqual(bad, [], "实走过程中离开了 playing：" + bad.join(" | "));
});

test("契约9：走位用的 pathTo 路线必须都非空", () => {
  const bad = [];
  for (const r of flowRows()) {
    if (!r.routeLens.length || r.routeLens.some((n) => !n)) bad.push(r.mode + "/L" + r.level + "/F" + r.floor);
  }
  assert.deepEqual(bad, [], "寻路给出了空路线（说明关键点之间根本不连通）：" + bad.join(", "));
});

test("契约9：useFile 得到 cover === coverDuration", () => {
  const bad = flowRows().filter((r) => !r.useFileOk || r.cover !== r.coverDuration)
    .map((r) => r.mode + "/L" + r.level + "/F" + r.floor + " cover=" + r.cover + " 期望 " + r.coverDuration);
  assert.deepEqual(bad, [], "用文件夹后的免疫时长不对：" + bad.join(" | "));
});

test("契约9：电梯 idle → calling（liftTimer=liftWait）→ 等够 liftWait+0.1s → open", () => {
  const bad = [];
  for (const r of flowRows()) {
    if (!r.interactLiftCall || r.liftAfterCall !== "calling") bad.push(r.mode + "/L" + r.level + "/F" + r.floor + " 呼叫后 lift=" + r.liftAfterCall);
    if (r.liftTimerAfterCall !== r.liftWait) bad.push(r.mode + "/L" + r.level + "/F" + r.floor + " liftTimer=" + r.liftTimerAfterCall + " ≠ " + r.liftWait);
    if (r.liftAfterWait !== "open") bad.push(r.mode + "/L" + r.level + "/F" + r.floor + " 等够时间仍为 " + r.liftAfterWait);
  }
  assert.deepEqual(bad, [], "电梯状态机不对：" + bad.join(" | "));
});

test("契约9：非末层换层后 floor 变 2 且换到**下一张图**（map.id 必须变）", () => {
  const bad = [];
  for (const r of flowRows()) {
    if (r.floor >= r.floors) continue;
    if (r.phaseAfterEnter !== "floor-intro") bad.push(r.mode + "/L" + r.level + " 换层后 phase=" + r.phaseAfterEnter);
    if (r.floorAfter !== r.floor + 1) bad.push(r.mode + "/L" + r.level + " floor=" + r.floorAfter);
    if (!r.mapChanged) bad.push(r.mode + "/L" + r.level + " 换层没换图");
  }
  assert.deepEqual(bad, [], "换层没有换到下一张图 / floor 没变 2：" + bad.join(" | "));
});

test("契约9：换层时 time 与 elapsed 完全不变（整段继承，不是重置）", () => {
  const bad = [];
  for (const r of flowRows()) {
    if (r.floor >= r.floors) continue;
    if (!r.timeKept) bad.push(r.mode + "/L" + r.level + " 剩余时间被重置");
    if (!r.elapsedKept) bad.push(r.mode + "/L" + r.level + " elapsed 被重置");
  }
  assert.deepEqual(bad, [], "换层重置了计时（两层共用时限的承诺被破坏）：" + bad.join(" | "));
});

test("契约9：换层清空携带物（file / fileTaken / cover）", () => {
  const bad = [];
  for (const r of flowRows()) {
    if (r.floor >= r.floors) continue;
    if (!r.cargoCleared) bad.push(r.mode + "/L" + r.level);
  }
  assert.deepEqual(bad, [], "换层没有清空文件夹与伪装（二层可以直接按空格，打印区失去意义）：" + bad.join(" | "));
});

test("契约9：floor-intro 期间推 3 秒，计时一动不动", () => {
  const bad = [];
  for (const r of flowRows()) {
    if (r.floor >= r.floors) continue;
    if (!r.timeFrozen || !r.elapsedFrozen) bad.push(r.mode + "/L" + r.level);
  }
  assert.deepEqual(bad, [], "换层介绍浮层期间计时还在走（读说明就是扣时间）：" + bad.join(" | "));
});

test("契约9：floor-intro 时 nextLevel 无效，enterFloor 后才继续", () => {
  const bad = [];
  for (const r of flowRows()) {
    if (r.floor >= r.floors) continue;
    if (r.nextLevelInFloorIntro !== null) bad.push(r.mode + "/L" + r.level + " nextLevel 在 floor-intro 上居然生效了");
    if (!r.enterFloorOk || r.phaseAfterEnterFloor !== "playing") bad.push(r.mode + "/L" + r.level + " enterFloor 失败");
  }
  assert.deepEqual(bad, [], "换层浮层的进入/推进语义不对：" + bad.join(" | "));
});

test("契约9：末层 interact 必须 won", () => {
  const bad = flowRows().filter((r) => r.floor >= r.floors && r.phaseFinal !== "won")
    .map((r) => r.mode + "/L" + r.level + " → " + r.phaseFinal);
  assert.deepEqual(bad, [], "站在 opened 电梯前按下 E 却没有通关：" + bad.join(" | "));
});

test("契约9：每关 totalTime > 0（三关累计用时必须真被记下来）", () => {
  const bad = runFlow().levels.filter((lv) => !(lv.totalTime > 0))
    .map((lv) => lv.mode + "/L" + lv.level + " totalTime=" + lv.totalTime);
  assert.deepEqual(bad, [], "totalTime 不是正数（结算数字会变成 0）：" + bad.join(", "));
});

test("契约9：前两关能 nextLevel 到下一关，第 3 关之后再 nextLevel 为 null", () => {
  const bad = [];
  for (const lv of runFlow().levels) {
    if (lv.level < 3 && !lv.next) bad.push(lv.mode + "/L" + lv.level + " 通关后拿不到下一关");
    if (lv.level === 3 && lv.next !== null) bad.push(lv.mode + " 第 3 关之后还能继续推进");
  }
  assert.deepEqual(bad, [], "关卡推进的边界不对：" + bad.join(" | "));
});

/* ═══════════════ ⑪ 契约 10：地狱双层与二层失败重试 ═══════════════ */

test("契约10：地狱每层巡查数（不含同事）为 6", () => {
  const bad = [];
  for (let l = 1; l <= 3; l++) {
    for (const floor of [1, 2]) {
      const n = patrolCount(specGame(l, "hell", 7, floor));
      if (n !== 6) bad.push("L" + l + " F" + floor + " 巡查=" + n);
    }
  }
  assert.deepEqual(bad, [], "地狱每层巡查数不是 6（模式描述与实机不一致）：" + bad.join(", "));
});

test("契约10：二层失败后 retryLevel 回到 floor=1", () => {
  const g = R.createGame(2, [12], "hell", 7, 2);
  g.phase = "lost";
  assert.equal(R.retryLevel(g).floor, 1, "地狱二层失败后重试没有回到第一层（会从二层半途重开）");
});

test("契约10：二层失败后 retryLevel 保留 level / mode / 已通关记录", () => {
  const g = R.createGame(2, [12], "hell", 7, 2);
  g.phase = "lost";
  const retry = R.retryLevel(g);
  assert.equal(retry.level, 2, "重试丢了关卡号");
  assert.equal(retry.mode, "hell", "重试丢了模式");
  assert.equal(JSON.stringify(retry.clearedTimes), "[12]", "重试丢了已通关记录");
});

/* ═══════════════ ⑫ 契约 11：暂停 / 超时 / 过早推进 / 非法关卡 ═══════════════ */

test("契约11：paused 期间推 2 秒，计时不变", () => {
  const g = R.createGame(1, [], "normal", 99);
  R.start(g);
  g.phase = "paused";
  const t = g.time;
  advance(g, 2);
  assert.equal(g.time, t, "暂停期间还在倒计时（暂停键形同虚设）");
});

test("契约11：time 耗尽的当帧即 lost，且 time 归零", () => {
  const g = R.createGame(1, [], "normal", 99);
  R.start(g);
  g.time = 0.01;
  R.tick(g, 0.05);
  assert.equal(g.phase, "lost", "时间耗尽没有当帧失败（会白送一帧继续行动）");
  assert.equal(g.time, 0, "超时后 time 没有夹到 0（HUD 会显示负数）");
});

test("契约11：非 won 时 nextLevel 返回 null", () => {
  const g = R.createGame(1, [], "normal", 99);
  R.start(g);
  assert.equal(R.nextLevel(g), null, "还在 playing 就能 nextLevel（可以跳关，三关的进度就没有意义了）");
});

test("契约11：lost 上再调 start() 无效", () => {
  const g = R.createGame(1, [], "normal", 99);
  R.start(g);
  g.phase = "lost";
  R.start(g);
  assert.equal(g.phase, "lost", "在失败局上调用 start() 让它复活了（结算会重复落地）");
});

test("契约11：非法关卡 createGame(4) 抛 RangeError", () => {
  /* ⚠ 用名字判断而不是 assert.throws(fn, RangeError)：模块跑在 vm 的独立 realm 里，
     它抛出的 RangeError 不是测试 realm 的 RangeError，instanceof 一定为 false。 */
  assert.throws(() => R.createGame(4), (e) => e && e.name === "RangeError",
    "越界关卡没有抛 RangeError（会造出一个 map 为 undefined 的坏局）");
});

/* ═══════════════ ⑬ 契约 12：视野锥边界（本项目最看重的两条） ═══════════════ */

/* 空地图：只有 bounds、没有墙，把"遮挡"这个变量摘掉，只验距离与角度。 */
const EMPTY = { bounds: [0, 0, 3000, 2000], walls: [] };
const NX = 1500, NY = 1000;
function guard(angle, fov, range) {
  return { id: "supervisor", x: NX, y: NY, angle: angle, fov: fov, range: range };
}

test("契约12：距离**正好等于** range 算看得见（判定是严格 >）", () => {
  assert.equal(R.sees(guard(0, 1.1, 300), { x: 1800, y: 1000 }, EMPTY), true,
    "距离正好等于 range 却被判看不见（把 > 写成 >= 会凭空切掉一圈视野）");
});

test("契约12：距离超过 range 看不见", () => {
  assert.equal(R.sees(guard(0, 1.1, 300), { x: 1800.001, y: 1000 }, EMPTY), false,
    "距离超出 range 还能看见（视距参数失效）");
});

test("契约12：角度**正好等于**半角算看不见（判定是严格 <）", () => {
  const half = 1.1 / 2;
  const p = { x: NX + 150, y: NY + 150 };                  /* atan2(150,150) 正好是 π/4 */
  const base = Math.atan2(p.y - NY, p.x - NX);
  const n = guard(base - half, 1.1, 300);
  const d = Math.atan2(p.y - n.y, p.x - n.x) - n.angle;    /* 与引擎 sees() 内的算式逐字相同 */
  assert.equal(d, half, "测试前提：这个点必须正好落在半角上（否则这条断言测不到等号）");
  assert.equal(R.sees(n, p, EMPTY), false,
    "角度正好等于半角却算看得见（把 < 写成 <= 会让贴着锥边走变成绝对危险）");
});

test("契约12：角度略小于半角算看得见（边界没被多切一刀）", () => {
  const half = 1.1 / 2;
  const p = { x: NX + 150, y: NY + 150 };
  const base = Math.atan2(p.y - NY, p.x - NX);
  assert.equal(R.sees(guard(base - half * 0.999, 1.1, 300), p, EMPTY), true,
    "半角内侧一点点就看不见了（视野锥比标称的窄）");
});

test("契约12：左右对称 —— 负方向半角内看得见、正好半角看不见", () => {
  const half = 1.1 / 2;
  const p = { x: NX + 150, y: NY + 150 };
  const base = Math.atan2(p.y - NY, p.x - NX);
  assert.equal(R.sees(guard(base + half * 0.999, 1.1, 300), p, EMPTY), true, "锥体左半边（负偏移）不对称");
  assert.equal(R.sees(guard(base + half, 1.1, 300), p, EMPTY), false, "负方向正好等于半角却算看得见");
});

test("契约12：贴脸（1px）正前方看得见 —— V2 没有最小距离豁免", () => {
  assert.equal(R.sees(guard(0, 1.1, 300), { x: NX + 1, y: NY }, EMPTY), true,
    "贴脸反而看不见（偷偷加了最小距离分支，玩家可以钻进怀里）");
});

test("契约12：墙后的目标看不见（遮挡优先于角度）", () => {
  const walled = { bounds: [0, 0, 3000, 2000], walls: [[1650, 900, 40, 200]] };
  assert.equal(R.sees(guard(0, 1.1, 300), { x: 1800, y: 1000 }, walled), false,
    "隔着墙还能看见（潜行的遮挡完全失效）");
});

test("契约12：世界 bounds 之外的点看不见（边界也算阻挡）", () => {
  assert.equal(R.sees(guard(0, 1.1, 300), { x: 3100, y: 1000 }, EMPTY), false,
    "目标点在 world bounds 之外却算看得见（clearLine 漏掉了边界）");
});

test("契约12：fov 是弧度整锥张角 —— 主管/老板/保安 1.1、同事 1.5", () => {
  const bad = [];
  for (const mode of MODES) {
    const g = specGame(1, mode, 3);
    for (const n of g.npcs) {
      const want = n.id === "coworker" ? 1.5 : 1.1;
      if (n.fov !== want) bad.push(mode + "/" + n.id + " fov=" + n.fov + " 期望 " + want);
    }
  }
  assert.deepEqual(bad, [], "视野锥张角不是规格值（fov 是**整锥弧度**，不是倍数）：" + bad.join(", "));
});

test("契约12：同事永远不能抓人（只能喊话）", () => {
  const g = R.createGame(1, [], "normal", 42);
  R.start(g);
  g.player = { x: 1500, y: 1100, moving: false };
  g.npcs = [{ id: "coworker", x: 1500, y: 950, range: 300, fov: 1.5,
              angle: Math.PI / 2, pause: 100, route: [], target: 0 }];
  assert.equal(R.sees(g.npcs[0], g.player, g.map), true, "测试前提：这一局同事确实看得见玩家");
  assert.equal(R.captureIfSeen(g), false, "同事把人抓了（同事只该喊话，不该是隐形杀手）");
});

/* ═══════════════ ⑭ 契约 13：缺常量守卫 ═══════════════ */

test("契约13：TUNE 里被代码引用的常量必须全部存在且为有限数", () => {
  /* 上一个玩法栽过：`TUNE.DOG_RANGE` 忘了定义 → `d < NaN` 恒假 → 整条机制是死的，
     而页面不报错、画面也完全正常。所以这里直接把源码里引用到的键名抠出来逐个验。 */
  const refs = new Set();
  const re = /TUNE\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(SRC))) refs.add(m[1]);
  const bad = [...refs].filter((k) => !Number.isFinite(T[k]));
  assert.deepEqual(bad, [], "TUNE 缺这些常量（代码引用了但它们不存在/不是有限数）：" + bad.join(", "));
});

test("契约13：MODES 里被代码引用的字段必须全部存在且为有限数", () => {
  const refs = new Set();
  const re = /difficulty\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(SRC))) refs.add(m[1]);
  const bad = [];
  for (const k of refs) for (const id of MODES) {
    const v = R.MODES[id][k];
    if (v === undefined) bad.push(id + "." + k + " 不存在");
    else if (typeof v === "number" && !Number.isFinite(v)) bad.push(id + "." + k + " 不是有限数");
  }
  assert.deepEqual(bad, [], "MODES 缺这些字段（代码引用了但它们不存在）：" + bad.join(", "));
});

test("契约13：config 里被代码引用的字段必须全部存在（三模式 × 三关）", () => {
  const refs = new Set();
  const re = /config\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(SRC))) refs.add(m[1]);
  const bad = [];
  for (const mode of MODES) for (let l = 1; l <= 3; l++) {
    const cfg = specGame(l, mode, 3).config;
    for (const k of refs) if (cfg[k] === undefined) bad.push(mode + "/L" + l + "." + k);
  }
  assert.deepEqual(bad, [], "config 缺这些字段（代码引用了但它们没被算出来）：" + bad.join(", "));
});

test("契约13：TUNE 的关键手感常量必须为正", () => {
  const positive = ["ENTRY", "TILE", "P_R", "SPEED", "PATROL_SPEED", "FOV_DEG", "FOV_COWORKER",
                    "RANGE", "DISGUISE_SEC", "DISGUISE_HELL", "FOLDER_PER_LEVEL", "COFFEE_LURE_SEC",
                    "COFFEE_REACH", "ELEV_WAIT", "ELEV_REACH", "TIME_NORMAL", "TIME_HELL", "REVEAL_SEC",
                    "WORLD_W", "WORLD_H", "PER_LEVEL", "PER_SECOND_LEFT", "GHOST_BONUS", "SPEED_BONUS_MAX"];
  const bad = positive.filter((k) => !(T[k] > 0));
  assert.deepEqual(bad, [], "这些 TUNE 常量必须为正，否则对应机制会静默失效：" + bad.join(", "));
});

test("契约13：TUNE 的兼容键必须与引擎真正生效的数值一致", () => {
  const bad = [];
  if (T.DISGUISE_SEC !== R.MODES.normal.cover) bad.push("DISGUISE_SEC ≠ normal.cover");
  if (T.DISGUISE_HELL !== R.MODES.hell.cover) bad.push("DISGUISE_HELL ≠ hell.cover");
  if (T.ELEV_WAIT !== LEVELS[0].liftWait + R.MODES.normal.wait) bad.push("ELEV_WAIT ≠ L1.liftWait + normal.wait");
  if (T.RANGE !== LEVELS[0].range * R.MODES.normal.range) bad.push("RANGE ≠ L1.range × normal.range");
  if (T.PATROL_SPEED !== LEVELS[0].speed * R.MODES.normal.speed) bad.push("PATROL_SPEED ≠ L1.speed × normal.speed");
  if (T.TIME_NORMAL !== LEVELS[0].time) bad.push("TIME_NORMAL ≠ L1.time");
  if (T.TIME_HELL !== Math.round(LEVELS[0].time * R.MODES.hell.time)) bad.push("TIME_HELL ≠ round(L1.time × hell.time)");
  if (Math.abs(T.FOV_DEG - 1.1 * 180 / Math.PI) > 1e-6) bad.push("FOV_DEG ≠ 1.1 rad");
  if (Math.abs(T.FOV_COWORKER - 1.5 * 180 / Math.PI) > 1e-6) bad.push("FOV_COWORKER ≠ 1.5 rad");
  assert.deepEqual(bad, [], "TUNE 的兼容键和引擎真实数值漂了（读兼容键的旧脚本/界面会显示错的数）：" + bad.join("; "));
});

test("契约13：pathTo 的路点全部落在 TUNE.TILE 网格上（网格步长键没有失效）", () => {
  const bad = [];
  for (const map of R.MAPS) {
    for (const w of R.pathTo(map, map.points.start, map.points.lift)) {
      if (w[0] % T.TILE !== 0 || w[1] % T.TILE !== 0) bad.push("图" + map.id + " (" + w[0] + "," + w[1] + ")");
    }
  }
  assert.deepEqual(bad, [], "寻路路点不在 TUNE.TILE 网格上（TILE 已经不是真正的网格步长）：" + bad.join(", "));
});

/* ═══════════════ ⑮ 契约 14 + 经济不变量（本项目原有不变量） ═══════════════ */

test("契约14：低技能长期期望为负（乱撞必亏）", () => {
  const bad = MODES.filter((m) => !(meanNet(m, 0.03) < 0))
    .map((m) => m + " E[净]=" + meanNet(m, 0.03).toFixed(2));
  assert.deepEqual(bad, [], "低技能居然能赚钱（挂机就是印钞机）：" + bad.join(", "));
});

test("契约14：高技能期望为正（练熟了必须有回报）", () => {
  const bad = MODES.filter((m) => !(meanNet(m, 1.0) > 0))
    .map((m) => m + " E[净]=" + meanNet(m, 1.0).toFixed(2));
  assert.deepEqual(bad, [], "练到满级还不赚钱（玩家没有理由练）：" + bad.join(", "));
});

test("契约14：高技能期望有界（不超过入场费的 3 倍，不能是印钞机）", () => {
  /* 写成"入场费的 N 倍"而不是写死元数 —— 调 ENTRY 时这条断言不会变成假绿灯 */
  const bad = MODES.filter((m) => !(meanNet(m, 1.0) < T.ENTRY * 3))
    .map((m) => m + " E[净]=" + meanNet(m, 1.0).toFixed(2));
  assert.deepEqual(bad, [], "高技能收益超过入场费的 3 倍，属于印钞机：" + bad.join(", "));
});

test("契约14：三模式的收益量级可比（没有哪一档明显更划算）", () => {
  const nets = MODES.map((m) => meanNet(m, 0.95));
  const lo = Math.min(...nets), hi = Math.max(...nets);
  assert.ok(lo > 0, "有模式在高技能下仍不赚钱：" + nets.map((v) => v.toFixed(1)).join(" / "));
  assert.ok(hi / lo < 2.5, "三模式的收益量级差得太多（" + lo.toFixed(1) + " … " + hi.toFixed(1) + "），会没人打难的那档");
});

test("经济：赔付阶梯单调不减、0 分不给钱、封顶取最高档", () => {
  const bad = [];
  for (const id of Object.keys(R.PAYOUT)) {
    const lad = R.PAYOUT[id];
    if (R.payoutOf(0, id) !== 0) bad.push(id + "：0 分给了钱");
    if (R.payoutOf(-100, id) !== 0) bad.push(id + "：负分给了钱");
    if (lad[0].min !== 0) bad.push(id + "：第一档不从 0 分开始");
    let prev = -1;
    for (let sc = 0; sc <= lad[lad.length - 1].min + 3000; sc += 71) {
      const p = R.payoutOf(sc, id);
      if (p < prev) bad.push(id + "：分数涨了赔付却降了（" + sc + "）");
      prev = p;
    }
    for (let i = 1; i < lad.length; i++) if (!(lad[i].min > lad[i - 1].min)) bad.push(id + "：门槛没有递增");
  }
  assert.deepEqual(bad, [], "赔付阶梯不合法：" + bad.join("; "));
});

test("经济：得分表里没有任何「被发现/被抓」的加分项", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(R.SCORE_TABLE, "caught"), false, "得分表里混进了 caught 加分项");
  assert.equal(Object.prototype.hasOwnProperty.call(R.SCORE_TABLE, "detected"), false, "得分表里混进了 detected 加分项");
  assert.equal(R.scoreOf("caught"), 0, "未登记的事件必须 0 分（失败只能扣，不能变成收益）");
  assert.equal(R.scoreOf("任何没登记的名字"), 0, "未登记的事件必须 0 分");
});

test("经济：一关不过绝不赚到钱（奖励必须按进度打折）", () => {
  /* 第一版时间分是全额给的，于是"一关不过、原地躲到时间结束"也能拿满额时间分 —— 那是一个
     不动就赚钱的漏洞。正确结构：时间分 × (通关数 / 总关数)。 */
  let worst = -Infinity, n = 0;
  for (let i = 0; i < 200; i++) {
    const r = R.simulateRun("normal", 0.02, 70000 + i);
    if (r.cleared === 0) { n++; worst = Math.max(worst, r.net); }
  }
  assert.ok(n > 0, "样本里没有「零通关」的局，这条不变量测不出来");
  assert.ok(worst <= 0, "一关不过却是正收益：" + worst + "（奖励没有按进度打折）");
});

test("经济：评级分布与实机一致（S 只在三关全通且零被发现时出现）", () => {
  const seen = {};
  for (let i = 0; i < 600; i++) {
    const r = R.simulateRun("normal", 0.9, 12000 + i);
    seen[r.grade] = (seen[r.grade] || 0) + 1;
    if (r.grade === "S") assert.ok(r.allClear && r.ghost, "S 却不是「全通 + 零被发现」");
    if (r.grade === "A") assert.ok(r.allClear && !r.ghost, "A 却不是「全通但有被发现」");
  }
  assert.ok(Object.keys(seen).length >= 2, "评级分布太单一：" + JSON.stringify(seen));
});
