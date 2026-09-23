/* ═══════════════════════════════════════════════════════════════════════════
   _bf14_pressure_probe.js — bf-14「锅内限时起锅」压力探针（纯 Node，不弹窗、不起浏览器）
   运行：node tools/bf/_patch/_bf14_pressure_probe.js

   探针 A（验收第 3 条）：点完 9 样食材，然后**什么都不做 60 秒**（游戏时间）——
      断言 9 份**全部**在起锅窗口超时后变成糊（burnt=9）、盘上 0 份、
      且糊锅**不会自动清**（60s 后仍然糊着占住锅）。
   探针 B（验收第 3 条后半）：先做一份放进盘，再对**同一列**下料 →
      熟了没地方起锅（plate-occupied）→ 窗口继续走 → 超时糊。
   探针 C：口径自检（autoPlate 默认关 / 窗口剩余 / 糊锅粘住 / 双锅并行互不影响）。
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const OUT = path.join(__dirname, "..", "..", "..");
const SRC = fs.readFileSync(path.join(OUT, "breakfast.js"), "utf8");

const ctx = vm.createContext({ console, Math, Date, isFinite, Number, String, Object, Array });
ctx.window = ctx;
vm.runInContext(SRC + "\n;globalThis.__BF = window.Breakfast;", ctx);
const R = ctx.__BF.rules;

let bad = 0, n = 0;
function A(ok, name, extra) {
  n++;
  if (!ok) bad++;
  console.log((ok ? "  ✔ " : "  ✗ ") + name + (extra ? "（" + extra + "）" : ""));
}
/** 小局：时长拉到 9999、不自动进店（顾客由探针自己 spawn） */
function mk(cfg) {
  const st = R.newState(Object.assign({ duration: 9999, goal: 99 }, cfg || {}));
  st.running = true; st.nextIn = 1e6;
  return st;
}
/** 推进 n 秒（1/60 步长，确定性；step 内部有 0.5s 卡帧保护） */
function adv(st, sec) {
  const steps = Math.round(sec * 60);
  for (let i = 0; i < steps && !st.over; i++) R.step(st, 1 / 60);
  return st;
}
/** 推进到「某一列进入起锅窗口」为止（返回用掉的秒数） */
function advUntilPick(st, col, maxSec) {
  const max = Math.round((maxSec === undefined ? 12 : maxSec) * 60);
  for (let i = 0; i < max; i++) {
    if (st.stations[col].state === "perfect" && st.stations[col].serveWin > 0) return i / 60;
    R.step(st, 1 / 60);
  }
  return -1;
}

console.log("\n══ 探针 A：点完 9 样食材 → 什么都不做 60 秒（验收第 3 条）══");
{
  const st = mk();                                   // 注意：**不传 autoPlate**（页面口径）
  A(st.cfg.autoPlate === false, "不传 autoPlate 时默认关闭（页面永不传它）", "autoPlate=" + st.cfg.autoPlate);
  const seen = {};                                   // 每口锅出现过的状态帧
  R.FOOD_IDS.forEach(function (f) { A(R.placeFood(st, f, null) === true, "下料 " + R.FOOD[f].n + " → 第 " + R.columnOf(f) + " 列"); });
  A(st.stations.filter(function (s) { return !!s.food; }).length === 9, "9 口锅同时开工（多锅并行不受影响）");
  /* 60 秒里只推进时钟、一个键都不按 */
  for (let i = 0; i < 60 * 60; i++) {
    R.step(st, 1 / 60);
    for (let c = 0; c < 9; c++) {
      const s = st.stations[c];
      if (!s.food) continue;
      const key = R.FOOD_IDS[c] + ":" + s.state;
      seen[key] = (seen[key] || 0) + 1;
    }
  }
  console.log("  锅上出现过的状态帧：" + JSON.stringify(Object.keys(seen).sort().reduce(function (o, k) {
    if (/:(perfect|raw|over|burnt)$/.test(k)) o[k.replace(/:.*:/, ":")] = seen[k]; return o; }, {})));
  const states = {};
  Object.keys(seen).forEach(function (k) {
    const stt = k.split(":")[1];
    states[stt] = (states[stt] || 0) + seen[k];
  });
  console.log("  按状态汇总：" + JSON.stringify(states));
  A(st.burnt === 9, "9 份全部在起锅窗口超时后糊掉（st.burnt = 9）", "burnt=" + st.burnt);
  A(st.expire === 9, "记了 9 次「忘起锅」（st.expire = 9）", "expire=" + st.expire);
  A(st.plates.length === 0, "盘上 0 份（没有任何一份自动落盘）", "plates=" + st.plates.length);
  A(st.stations.every(function (s) { return s.state === "burnt" && s.food; }),
    "9 口锅 60s 后**仍然糊着**（糊锅不会自动清 —— 必须双击）",
    st.stations.map(function (s) { return s.state; }).join(","));
  A(st.stations.filter(function (s) { return s.state === "burnt"; }).length === 9, "9 口锅全糊");
  A(R.placeFoodEx(st, "egg", null).why === "station-occupied", "糊着的锅不能再下料（station-occupied）",
    R.placeFoodEx(st, "egg", null).why);
  const sc = st.score, ts = st.tossed;
  A(R.trashColumn(st, 3) === true, "双击第 3 列 → 丢掉糊的");
  A(st.stations[3].food === null && st.stations[3].state === "idle", "锅清空、恢复 idle");
  A(st.score === sc, "丢垃圾桶不扣分", "score " + sc + " → " + st.score);
  A(st.tossed === ts + 1, "记了一次丢弃（tossed）");
  A(R.placeFood(st, "egg", null) === true, "丢掉后这口锅立刻能再用");
}

console.log("\n══ 探针 B：盘里放着 → 锅里没地方起锅 → 只能糊（验收第 3 条后半）══");
{
  const st = mk();
  const col = R.columnOf("egg");
  A(R.placeFood(st, "egg", null) === true, "① 第 3 列下第一份煎蛋");
  let t = advUntilPick(st, col, 6);
  A(t >= 0, "② 煎蛋熟了并进入起锅窗口（用了 " + t.toFixed(2) + "s）");
  const left0 = st.stations[col].serveWin;
  A(left0 > 0 && left0 <= R.SERVE_WINDOW + 1e-9, "窗口剩余 " + left0.toFixed(2) + "s（≤ SERVE_WINDOW）");
  const r1 = R.takeOut(st, col);
  A(r1.ok === true && r1.kind === "plated", "③ 单击锅起锅 → 落到第 3 列专属盘", JSON.stringify(r1.tier));
  A(R.plateOfStation(st, col).food === "egg", "盘上那份就是煎蛋（永久保鲜）");
  A(st.stations[col].food === null, "起锅后锅位空出来");
  /* ④ 盘里还放着，再对同一列下料（bf-14：允许，代价是没地方起锅） */
  A(R.placeFood(st, "egg", null) === true, "④ 盘里还放着一份时**照样能下料**（用户原话「锅里也可以同时煮着」）");
  t = advUntilPick(st, col, 6);
  A(t >= 0, "⑤ 第二份也熟了、进入起锅窗口（用了 " + t.toFixed(2) + "s）");
  const r2 = R.takeOut(st, col);
  A(r2.ok === false && r2.why === "plate-occupied", "⑥ 单击锅起锅被拒：盘里还有一份，没地方放", r2.why);
  A(/盘里还有一份/.test(r2.hint || ""), "提示语正确：" + r2.hint, r2.hint);
  A(st.plates.length === 1 && st.plates[0].food === "egg", "盘上那份没被动过（还是第一份）");
  A(st.stations[col].food === "egg" && st.stations[col].state === "perfect", "锅里的第二份仍在等（窗口继续走）");
  /* ⑦ 窗口继续走 → 超时糊 */
  const leftNow = st.stations[col].serveWin;
  adv(st, leftNow - 0.01);
  A(st.stations[col].state === "perfect", "⑦ 窗口内还剩 0.01s：还没糊（窗口没被拒绝重置）");
  adv(st, 0.05);
  A(st.stations[col].state === "burnt", "⑧ 窗口走完 → 锅里的第二份**糊了**");
  A(st.burnt === 1 && st.expire === 1, "记账：burnt=1 / expire=1", "burnt=" + st.burnt + " expire=" + st.expire);
  A(st.plates.length === 1 && st.plates[0].state === "perfect", "盘上第一份**完好无损**（糊的是锅里那份）");
  A(R.placeFoodEx(st, "egg", null).why === "station-occupied", "⑨ 糊锅不能再下料（station-occupied）");
  const sc = st.score;
  A(R.trashColumn(st, col) === true, "⑩ 双击这一列 → 丢掉糊的（连盘上那份一起清）");
  A(st.score === sc, "不扣分", "score=" + st.score);
  A(R.stationFree(st, col) === true, "锅恢复可用");
  A(R.placeFood(st, "egg", null) === true, "马上能再下一份");
}

console.log("\n══ 探针 C：窗口边界 / 多锅并行 / 口径自检 ══");
{
  /* C1 窗口边界：SERVE_WINDOW-ε 不糊 / +ε 糊（确定性时钟推进） */
  const st = mk();
  const col = R.columnOf("bacon");
  R.placeFood(st, "bacon", null);
  const used = advUntilPick(st, col, 8);
  A(used >= 0, "培根进入起锅窗口（" + used.toFixed(2) + "s）");
  const eps = 0.02;
  adv(st, R.SERVE_WINDOW - eps);
  A(st.stations[col].state === "perfect" && st.burnt === 0,
    "窗口 " + (R.SERVE_WINDOW - eps) + "s（SERVE_WINDOW-ε）：**不糊**", "state=" + st.stations[col].state);
  const left = st.stations[col].serveWin;
  A(Math.abs(left - eps) < 0.02, "此时窗口剩余 ≈ ε", "left=" + left.toFixed(4));
  adv(st, 2 * eps);
  A(st.stations[col].state === "burnt" && st.burnt === 1,
    "窗口 " + (R.SERVE_WINDOW + eps) + "s（SERVE_WINDOW+ε）：**糊**", "state=" + st.stations[col].state);

  /* C2 多锅并行：同时 3 口锅在窗口期内互不影响 */
  const p = mk();
  const cols = [R.columnOf("juice"), R.columnOf("milk"), R.columnOf("bun")];
  cols.forEach(function (c) { A(R.placeFood(p, R.foodOfColumn(c), null) === true, "并行下料 " + R.FOOD[R.foodOfColumn(c)].n); });
  let guard = 0;
  while (guard++ < 900) {
    const open = cols.filter(function (c) { return p.stations[c].state === "perfect" && p.stations[c].serveWin > 0; });
    if (open.length === 3) break;
    R.step(p, 1 / 60);
  }
  A(cols.every(function (c) { return p.stations[c].state === "perfect" && p.stations[c].serveWin > 0; }),
    "3 口锅**同时在**起锅窗口里（互不影响）",
    cols.map(function (c) { return R.FOOD[R.foodOfColumn(c)].n + "=" + p.stations[c].serveWin.toFixed(2) + "s"; }).join(" · "));
  const before = cols.map(function (c) { return p.stations[c].serveWin; });
  /* 只对第 1 口动手，另两口应该原样继续倒数 */
  A(R.takeOut(p, cols[0]).ok === true, "其中一口起锅成功");
  A(p.stations[cols[1]].food && p.stations[cols[2]].food, "另外两口锅里的东西还在（没被牵连）");
  adv(p, 1.0);
  A(Math.abs(p.stations[cols[1]].serveWin - (before[1] - 1)) < 0.02 &&
    Math.abs(p.stations[cols[2]].serveWin - (before[2] - 1)) < 0.02,
    "另外两口的窗口各自照常倒数 1s（互不干扰）",
    p.stations[cols[1]].serveWin.toFixed(2) + " / " + p.stations[cols[2]].serveWin.toFixed(2));
  A(p.stations[cols[0]].food === null && p.plates.length === 1, "起锅那口已经空出、盘上 1 份");
  /* 谁都不管 → 剩下的各自糊 */
  adv(p, R.SERVE_WINDOW + 0.2);
  A(p.burnt === 2 && p.expire === 2, "剩下两口各自超时糊掉（burnt=2）", "burnt=" + p.burnt);

  /* C3 口径自检 */
  A(R.SERVE_WINDOW === 4.5, "起锅窗口现值 SERVE_WINDOW = " + R.SERVE_WINDOW + "s");
  A(R.SERVE_WARN_SEC === 1.0, "最后 1 秒红闪阈值 SERVE_WARN_SEC = " + R.SERVE_WARN_SEC);
  A(R.PAN_BURNT_STICKY === true, "PAN_BURNT_STICKY = true：糊锅只能双击清");
  A(typeof R.takeOut === "function" && typeof R.serveWinLeft === "function", "takeOut / serveWinLeft 已导出");
  const d = mk({ autoPlate: true });
  A(d.cfg.autoPlate === true, "显式 autoPlate:true 仍可打开（调试 / 老回归通道）");
  const e = mk();
  A(e.cfg.autoPlate === false, "显式不传 → 关闭");
  /* 盘上永久保鲜没有被回退 */
  const fp = mk();
  const cc = R.columnOf("salad");
  R.placeFood(fp, "salad", null);
  advUntilPick(fp, cc, 5);
  R.takeOut(fp, cc);
  const pl = R.plateOfStation(fp, cc);
  adv(fp, 60);
  A(pl.state === "perfect" && pl.tier === "hot" && !isFinite(pl.left),
    "盘上永久保鲜仍是老口径：放 60s 仍 perfect/hot、left=Infinity",
    "age=" + pl.age + " tier=" + pl.tier);
}

console.log("\n[结果] 断言 " + (n - bad) + "/" + n + " 通过" + (bad ? ("，失败 " + bad) : ""));
process.exit(bad ? 1 : 0);
