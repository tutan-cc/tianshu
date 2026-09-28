/* ═══════════════════════════════════════════════════════════════════════════
   mk_bf14_tests.js — bf-14 第二轮：改写 tests/breakfast.test.cjs 的旧口径断言 + 新增本轮断言
   用法：node tools/bf/_patch/mk_bf14_tests.js
         node tools/bf/_patch/_bf14_preflight.js tools/bf/_patch/jobs_bf14_tests.json
         node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf14_tests.json
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tests/breakfast.test.cjs";
const T = [], jobs = [];
function job(name, from, to, text) {
  T.push({ name: name, text: text });
  jobs.push({ file: FILE, from: from, to: to || undefined, textFile: "tools/bf/_patch/bf14t_" + name + ".txt" });
}

/* ── Q1 文件头 + 三个 helper ────────────────────────────────────────────── */
job("header", `         盘上永久保鲜（bf-13：不降档 / 无倒计时 / 不糊 / 不消失；锅内该糊还是糊）`,
null,
`         盘上永久保鲜（bf-13：不降档 / 无倒计时 / 不糊 / 不消失）/
         锅内限时起锅（bf-14：恰好不再自动落盘 → 窗口内点锅起锅；盘被占就只能糊；糊锅双击才清）`);

job("helpers", `/** 只看「锅里火候」的小局：关掉自动落盘（食物留在锅里，方便断言 生→恰好→过火→糊） */
function wokState(cfg) { const st = R.newState(Object.assign({ duration: 12, goal: 99, autoPlate:false }, cfg || {})); st.running = true; return st; }
/** 走完整新规则的小局：9 列各 1 专属盘、熟了自动落盘、**盘上永久保鲜**（不降档 / 不糊 /
    不消失、没有倒计时）。nextIn 拉大 → 不自动进店，只有测试自己 spawn 的顾客在场。 */
function plateState(cfg) { const st = R.newState(Object.assign({ duration: 999, goal: 99, autoPlate:true }, cfg || {})); st.running = true; st.nextIn = 1e6; return st; }`,
null,
`/** 只看「锅里火候」的小局：**按住看火（manual）**—— bf-14 起默认那条路会在「恰好」定格等起锅，
    只有 manual 不开起锅窗口，食物才留在锅里走完 生 → 恰好 → 过火 → 糊 这条完整曲线。 */
function wokState(cfg) { const st = R.newState(Object.assign({ duration: 12, goal: 99 }, cfg || {})); st.running = true; return st; }
/** 走**页面口径**的小局（bf-14）：9 列各 1 专属盘、autoPlate **不传（默认关闭）**、盘上永久保鲜。
    锅里熟了要自己点锅起锅（用 pickOut()）；没人管就超时糊、糊了必须双击才清。
    nextIn 拉大 → 不自动进店，只有测试自己 spawn 的顾客在场。 */
function plateState(cfg) { const st = R.newState(Object.assign({ duration: 999, goal: 99 }, cfg || {})); st.running = true; st.nextIn = 1e6; return st; }
/** bf-14：推进到某一列进入「起锅窗口」为止（不起锅）。返回用掉的秒数，超时 / 先糊了返回 -1。 */
function advToWindow(st, col, maxSec) {
  const max = Math.round((maxSec === undefined ? 12 : maxSec) * 60);
  for (let i = 0; i < max && !st.over; i++) {
    if (st.stations[col].state === "perfect" && st.stations[col].serveWin > 0) return i / 60;
    R.step(st, 1 / 60);
  }
  return -1;
}
/** bf-14：**单击锅起锅**（把某列锅里那份放进本列专属盘）。
    先推进到窗口内，再调 takeOut —— 盘被占 / 已糊都会如实返回 { ok:false, why }。 */
function pickOut(st, col, maxSec) {
  const max = Math.round((maxSec === undefined ? 12 : maxSec) * 60);
  for (let i = 0; i < max && !st.over; i++) {
    const s = st.stations[col];
    if (s.state === "burnt") return { ok:false, why:"burnt" };
    if (s.state === "perfect" && s.serveWin > 0) return R.takeOut(st, col);
    R.step(st, 1 / 60);
  }
  return { ok:false, why:"timeout" };
}`);

job("autoserve", `/** 给当前第一位顾客做他要的下一道菜，熟了落到本列盘上再端上去（返回 serve 结果，做不了返回 null） */
function autoServe(st) {
  const list = R.activeCustomers(st);
  if (!list.length) return null;
  const c0 = list[0];
  let want = null;
  for (let i = 0; i < c0.order.length; i++) if (c0.done.indexOf(c0.order[i]) < 0) { want = c0.order[i]; break; }
  if (!want) return null;
  const col = R.columnOf(want);
  if (!R.stationFree(st, col)) return null;
  if (!R.placeFood(st, want, col)) return null;
  let k = 0;
  while (!R.plateOfStation(st, col) && k++ < 1200 && !st.over) R.step(st, 1 / 60);
  if (st.over || !R.plateOfStation(st, col)) { R.trashStation(st, col); return null; }
  return R.serveFromColumn(st, col);          // 单击盘 → 自动送给正在等的顾客
}`,
null,
`/** 给当前第一位顾客做他要的下一道菜：下锅 → **窗口内点锅起锅**（bf-14）→ 单击盘端上去。
    做不了 / 没人要 → 清掉这一列并返回 null。返回 serve 结果。 */
function autoServe(st) {
  const list = R.activeCustomers(st);
  if (!list.length) return null;
  const c0 = list[0];
  let want = null;
  for (let i = 0; i < c0.order.length; i++) if (c0.done.indexOf(c0.order[i]) < 0) { want = c0.order[i]; break; }
  if (!want) return null;
  const col = R.columnOf(want);
  if (R.plateOfStation(st, col)) {                 // 盘里还有一份 → 先送出去腾地方（bf-14）
    const rr = R.serveFromColumn(st, col);
    if (!rr.ok) R.trashStation(st, col);
  }
  if (!R.stationFree(st, col)) return null;
  if (!R.placeFood(st, want, col)) return null;
  const po = pickOut(st, col);                     // 熟了要在起锅窗口内点锅
  if (!po.ok) { R.trashStation(st, col); return null; }
  const r = R.serveFromColumn(st, col);            // 单击盘 → 自动送给正在等的顾客
  if (!r.ok) R.trashStation(st, col);
  return r;
}`);

/* ── Q2 过关判定（机器人）───────────────────────────────────────────────── */
job("winbot", `    // 2) 推进到有东西落到盘上（或 1 秒）
    let frames = 0;
    while (frames++ < 60 && !st.over) { R.step(st, 1 / 60); if (st.plates.length) break; }
    if (st.over) break;
    // 3) 单击每一列的专属盘：自动送给正在需要 + 耐心最少的顾客（没人要就留着）
    for (let i = 0; i < st.stations.length; i++) if (R.plateOfStation(st, i)) R.serveFromColumn(st, i);
    // 4) 清掉糊掉的残骸 / 没人要的存货，避免堵住某一列
    for (let i = 0; i < st.stations.length; i++) {
      const p = R.plateOfStation(st, i);
      if ((p && p.state === "burnt") || st.stations[i].state === "burnt") R.trashStation(st, i);
    }`,
null,
`    // 2) 推进到有锅进入「起锅窗口」（bf-14：不再自动落盘；或 1 秒）
    let frames = 0;
    while (frames++ < 60 && !st.over) {
      R.step(st, 1 / 60);
      if (st.stations.some(s => s.state === "perfect" && s.serveWin > 0)) break;
    }
    if (st.over) break;
    // 3) 起锅：窗口内**单击锅** → 落到本列专属盘（盘被占就先点盘把旧的送出去）
    for (let i = 0; i < st.stations.length; i++) {
      const s = st.stations[i];
      if (s.state !== "perfect" || !(s.serveWin > 0)) continue;
      if (R.plateOfStation(st, i)) { const r0 = R.serveFromColumn(st, i); if (!r0.ok) R.trashStation(st, i); }
      else R.takeOut(st, i);
    }
    // 4) 单击每一列的专属盘：自动送给正在需要 + 耐心最少的顾客（没人要就留着）
    for (let i = 0; i < st.stations.length; i++) if (R.plateOfStation(st, i)) R.serveFromColumn(st, i);
    // 5) 清掉糊掉的残骸 / 没人要的存货，避免堵住某一列
    for (let i = 0; i < st.stations.length; i++) {
      const p = R.plateOfStation(st, i);
      if ((p && p.state === "burnt") || st.stations[i].state === "burnt") R.trashStation(st, i);
    }`);

/* ── Q3 点击下料路由（盘占用那一段）────────────────────────────────────── */
job("place_route", `  // 熟了自动落到本列专属盘 → 锅里空了，但盘占着 → 仍然拒绝下料
  advance(st, 3.2);
  assert.equal(R.plateOfStation(st, 3).food, "egg", "熟了落到第 3 列的专属盘");
  const pbusy = R.placeFoodEx(st, "egg", null);
  assert.equal(pbusy.ok, false); assert.equal(pbusy.why, "plate-occupied");
  assert.match(pbusy.hint, /盘里还有一份，先送出去/);
  // 送出去以后这一列立刻恢复
  longPatience(R.spawnCustomer(st, ["egg"]));
  assert.equal(R.serveFromColumn(st, 3).ok, true);
  assert.equal(R.placeFood(st, "egg", null), true, "盘空 → 马上能再下一份");`,
null,
`  // bf-14：熟了**不再自动落盘** → 进起锅窗口；单击锅起锅才进盘
  advance(st, 3.2);
  assert.equal(st.plates.length, 0, "熟了不再自动落盘（原口径：同一帧落到专属盘）");
  assert.equal(st.stations[3].state, "perfect", "停在「恰好」等起锅");
  assert.ok(st.stations[3].serveWin > 0, "起锅窗口开着（剩余 " + st.stations[3].serveWin.toFixed(2) + "s）");
  const got3 = R.takeOut(st, 3);
  assert.equal(got3.ok, true); assert.equal(got3.kind, "plated", "窗口内单击锅 → 起锅入盘");
  assert.equal(R.plateOfStation(st, 3).food, "egg", "落到第 3 列的专属盘");
  assert.equal(st.stations[3].food, null, "锅里立刻空出来");
  // bf-14 新口径：盘里还有一份**也允许下料**（用户原话「锅里也可以同时煮着」）——
  //   代价是这份熟了**没地方放**：窗口内点锅被拒（plate-occupied），窗口继续走 → 糊
  const pbusy = R.placeFoodEx(st, "egg", null);
  assert.equal(pbusy.ok, true, "盘占着照样能下料（原口径：下料就被 plate-occupied 拒掉）");
  const pick3 = pickOut(st, 3);
  assert.equal(pick3.ok, false); assert.equal(pick3.why, "plate-occupied", "起锅被拒：盘里还有一份，没地方放");
  assert.match(pick3.hint, /盘里还有一份，先送出去/);
  assert.ok(pick3.left > 0, "被拒那一刻窗口还在走（剩余 " + pick3.left.toFixed(2) + "s，不是「没窗口」）");
  // 把盘上那份送出去 → 盘空了，窗口还在 → 这一下起锅就成
  longPatience(R.spawnCustomer(st, ["egg"]));
  assert.equal(R.serveFromColumn(st, 3).ok, true, "盘上那份送给顾客");
  assert.equal(R.plateOfStation(st, 3), null, "盘空了");
  assert.equal(R.takeOut(st, 3).ok, true, "盘一空，窗口内再点锅 → 起锅成功");
  assert.equal(R.plateOfStation(st, 3).food, "egg", "第二份也进盘了");`);

/* ── Q4 每一列都有专属盘（9 盘那一段）──────────────────────────────────── */
job("nineplates", `  // 9 列同时各放一份 → 9 份都能各自落到自己的盘上（不限量）
  const each = ["congee", "milk", "soup", "egg", "bacon", "sandwich", "bun", "salad", "juice"];
  each.forEach((f, i) => assert.equal(R.placeFood(st, f, null), true, "第 " + i + " 列下 " + f));
  assert.equal(st.made, 9, "9 列同时开工");
  advance(st, 5.2);
  assert.equal(st.plates.length, 9, "9 份全部落到各自的专属盘上（没有 3 盘限量）");
  assert.equal(new Set(st.plates.map(p => p.station)).size, 9, "没有两个灶位共用一个盘");
  for (let i = 0; i < 9; i++) {
    const p = R.plateOfStation(st, i);
    assert.ok(p, i + " 号灶位有自己的盘");
    assert.equal(p.station, i, "盘记录里写着唯一的归属灶位");
    assert.equal(p.food, each[i], "盘里正好是这一列做出来的东西");
    assert.equal(R.stationFree(st, i), false, "盘上有东西 → 这一列不可下料");
    assert.equal(R.placeFoodEx(st, each[i], null).why, "plate-occupied", "原因码 plate-occupied：" + each[i]);
  }
  // 只丢掉第 0 列 → 只有它恢复
  assert.equal(R.trashColumn(st, 0), true);
  assert.equal(R.stationFree(st, 0), true, "丢掉后第 0 列恢复");
  assert.equal(st.plates.length, 8, "别的 8 列不受影响");
  assert.equal(R.stationFree(st, 1), false, "第 1 列还占着");
  assert.equal(R.placeFood(st, "congee", null), true, "第 0 列马上能再用");`,
null,
`  // 9 列同时各放一份 → 9 份各自进起锅窗口 → 逐口点锅起锅（不限量、不串台）
  const each = ["congee", "milk", "soup", "egg", "bacon", "sandwich", "bun", "salad", "juice"];
  each.forEach((f, i) => assert.equal(R.placeFood(st, f, null), true, "第 " + i + " 列下 " + f));
  assert.equal(st.made, 9, "9 列同时开工");
  for (let i = 0; i < 9; i++) {
    const po = pickOut(st, i, 12);
    assert.equal(po.ok, true, "第 " + i + " 列窗口内点锅起锅（why=" + po.why + "）");
  }
  assert.equal(st.plates.length, 9, "9 份全部落到各自的专属盘上（没有 3 盘限量）");
  assert.equal(new Set(st.plates.map(p => p.station)).size, 9, "没有两个灶位共用一个盘");
  for (let i = 0; i < 9; i++) {
    const p = R.plateOfStation(st, i);
    assert.ok(p, i + " 号灶位有自己的盘");
    assert.equal(p.station, i, "盘记录里写着唯一的归属灶位");
    assert.equal(p.food, each[i], "盘里正好是这一列做出来的东西");
    assert.equal(R.stationFree(st, i), true, "锅空了 → 这一列可以继续下料（bf-14：盘占着不挡下料）");
  }
  // bf-14：盘占着也能下料（代价是熟了没地方起锅）—— 只动第 0 列，验完立刻还原
  assert.equal(R.placeFoodEx(st, each[0], null).ok, true, "第 0 列盘占着也能下料（原口径：plate-occupied）");
  assert.equal(R.takeOut(st, 0).why, "raw", "刚下锅还没熟 → 起锅被拒（raw）");
  assert.equal(R.trashStation(st, 0), true, "清掉第 0 列（锅 + 盘）");
  assert.equal(R.placeFood(st, each[0], null), true, "重下一份");
  assert.equal(pickOut(st, 0, 12).ok, true, "再起锅一次，回到 9 盘");
  assert.equal(st.plates.length, 9, "9 盘又齐了");
  // 只丢掉第 0 列 → 只有它恢复
  assert.equal(R.trashColumn(st, 0), true);
  assert.equal(R.stationFree(st, 0), true, "丢掉后第 0 列恢复");
  assert.equal(st.plates.length, 8, "别的 8 列不受影响");
  assert.equal(R.plateOfStation(st, 1).food, "milk", "第 1 列的盘还占着（bf-14：盘占着不挡下料）");
  assert.equal(R.placeFood(st, "congee", null), true, "第 0 列马上能再用");`);

/* ── Q5 autoPlate 默认关那条用例整条重写（原 989-1019）─────────────────── */
job("autoplate_case", `test("熟了自动落到本列专属盘（autoPlate 默认开）；manual 按住看火不落盘、照样烧到糊", () => {
  const st = R.newState({ duration:999, goal:99 });
  assert.equal(st.cfg.autoPlate, true, "默认自动落盘（新模型的核心规则）");
  st.running = true; st.nextIn = 1e6;
  const col = R.columnOf("bacon");                       // 2.8s 熟（bf-9 新表）
  assert.equal(R.placeFood(st, "bacon", null), true);
  advance(st, 2.0);
  assert.equal(st.plates.length, 0, "还没熟 → 不落盘");
  assert.equal(R.phaseOf(st, col), "cooking");
  advance(st, 1.7);
  assert.equal(st.plates.length, 1, "进了完美窗口 → 自动落到本列专属盘");
  assert.equal(st.stations[col].food, null, "落盘后锅位立刻空出来");
  assert.equal(R.phaseOf(st, col), "plated");
  assert.equal(st.prepped, 1, "记账：备好 1 份");
  // manual（按住看火）→ 食物留在锅里，会一路烧到糊
  const st2 = plateState();
  assert.equal(R.placeFoodEx(st2, "bacon", null, { manual:true }).ok, true);
  advance(st2, R.FOOD.bacon.dur + 0.2);                  // 完美窗口内（2.8 + 0.7 = 3.5 出窗口）
  assert.equal(st2.plates.length, 0, "manual 不自动落盘");
  assert.equal(st2.stations[4].state, "perfect");
  advance(st2, 2.5);
  assert.equal(st2.stations[4].state, "burnt", "按住不管 → 真的会糊（看火的压力还在）");
  assert.equal(st2.burnt, 1);
  // 关掉 autoPlate 的旧手感：手动 takePlate 才落盘
  const st3 = R.newState({ duration:999, goal:99, autoPlate:false }); st3.running = true; st3.nextIn = 1e6;
  R.placeFood(st3, "congee", null);
  advance(st3, 5.1);
  assert.equal(st3.plates.length, 0, "autoPlate:false → 不自动落盘");
  assert.equal(R.takePlate(st3, 0), true, "手动落盘照旧");
  assert.equal(st3.plates.length, 1);
});`,
null,
`test("bf-14：autoPlate 默认**关闭**（不传也关）；manual 按住看火不开窗口、照样烧到糊；显式 true 才回旧口径", () => {
  /* ① 默认（不传 autoPlate）：绝不自动落盘 —— 一到「恰好」就进起锅窗口等玩家点锅 */
  const st = R.newState({ duration:999, goal:99 });
  assert.equal(st.cfg.autoPlate, false, "默认**关闭**（原口径：cfg.autoPlate !== false → 打开）");
  st.running = true; st.nextIn = 1e6;
  const col = R.columnOf("bacon");                       // 2.8s 熟（bf-9 新表）
  assert.equal(R.placeFood(st, "bacon", null), true);
  advance(st, 2.0);
  assert.equal(st.plates.length, 0, "还没熟 → 锅里烧着");
  assert.equal(R.phaseOf(st, col), "cooking");
  advance(st, R.FOOD.bacon.dur - 2.0 + 0.02);
  assert.equal(st.plates.length, 0, "进「恰好」**也不落盘**（原口径：同一帧自动落盘）");
  assert.equal(st.stations[col].state, "perfect", "停在恰好");
  assert.ok(st.stations[col].serveWin > 0, "起锅窗口开着（剩余 " + st.stations[col].serveWin.toFixed(2) + "s）");
  assert.equal(R.phaseOf(st, col), "window", "状态机：window（还没落盘）");
  assert.equal(R.takeOut(st, col).ok, true, "单击锅 → 起锅");
  assert.equal(st.plates.length, 1, "起锅后落到本列专属盘");
  assert.equal(st.stations[col].food, null, "起锅后锅位立刻空出来");
  assert.equal(R.phaseOf(st, col), "plated");
  assert.equal(st.prepped, 1, "记账：备好 1 份");
  /* ② manual（按住看火）→ **不开**起锅窗口，食物留在锅里一路 over → burnt（完整曲线仍可观察） */
  const st2 = plateState();
  assert.equal(R.placeFoodEx(st2, "bacon", null, { manual:true }).ok, true);
  advance(st2, R.FOOD.bacon.dur + 0.2);                  // 完美窗口内（2.8 + 0.8 = 3.6 出窗口）
  assert.equal(st2.plates.length, 0, "manual 不落盘");
  assert.equal(st2.stations[4].state, "perfect");
  assert.equal(st2.stations[4].serveWin, 0, "manual **不开**起锅窗口（所以才会自然过火）");
  advance(st2, R.FOOD.bacon.pw + 0.2);
  assert.equal(st2.stations[4].state, "over", "过火这一档只有 manual 这条路上看得到");
  advance(st2, 1.5);
  assert.equal(st2.stations[4].state, "burnt", "按住不管 → 真的会糊（看火的压力还在）");
  assert.equal(st2.burnt, 1);
  /* ③ 显式 autoPlate:true → 旧口径仍在（调试 / 老回归通道）：一到「恰好」同帧落盘、不开窗口 */
  const st3 = R.newState({ duration:999, goal:99, autoPlate:true }); st3.running = true; st3.nextIn = 1e6;
  assert.equal(st3.cfg.autoPlate, true, "显式 true 时才打开");
  R.placeFood(st3, "congee", null);
  advance(st3, R.FOOD.congee.dur + 0.1);
  assert.equal(st3.plates.length, 1, "autoPlate:true → 自动落盘（旧口径）");
  assert.equal(st3.stations[0].food, null, "锅里立刻空出来");
  assert.equal(st3.stations[0].serveWin, 0, "这条路上不开起锅窗口");
  assert.equal(st3.burnt, 0, "旧口径下锅里不会糊");
  assert.equal(R.takePlate(st3, 0), true, "手动落盘照旧（幂等：盘上已有 → true）");
});`);

/* ── Q6 盘上永久保鲜（煮得久的那条）—— 落盘方式改成点锅 ─────────────────── */
job("keep_long", `  assert.equal(R.placeFood(st, "congee", null), true);
  advance(st, R.FOOD.congee.dur + 0.1);           // 煮了 3.5s（比旧的 4.5s 窗口还长）
  const p = R.plateOfStation(st, 0);
  assert.ok(p, "白粥落盘了");`,
null,
`  assert.equal(R.placeFood(st, "congee", null), true);
  const po0 = pickOut(st, 0, 12);                  // bf-14：熟了要在起锅窗口内点锅
  assert.equal(po0.ok, true, "窗口内单击锅 → 起锅落盘");
  const p = R.plateOfStation(st, 0);
  assert.ok(p, "白粥落盘了");`);

/* ── Q7 永久保鲜②：盘占用那一段 ────────────────────────────────────────── */
job("keep2", `  /* 盘占着这一列：锅不能再下料（旧规则不变），但这是「占位」不是「报废」 */
  assert.equal(R.placeFoodEx(st, "bun", null).why, "plate-occupied", "盘占着 → 原因码 plate-occupied（不是 burnt）");
  /* 双击仍然丢得掉 —— 「盘上东西丢不丢」仍由玩家决定（这一条是留给用户的折中②的现状） */
  assert.equal(R.trashColumn(st, col), true, "双击盘照样能丢掉（丢弃仍需玩家操作）");`,
null,
`  /* bf-14：盘占着**不再挡下料**（用户原话「锅里也可以同时煮着」）——
     代价搬到了「起锅那一刻」：没地方放 → plate-occupied → 窗口走完就糊（原口径在下料时就拒）。 */
  assert.equal(R.placeFoodEx(st, "bun", null).ok, true, "盘占着也能下料（原口径：plate-occupied）");
  const pk = pickOut(st, col);
  assert.equal(pk.ok, false); assert.equal(pk.why, "plate-occupied", "起锅被拒：盘里还有一份，没地方放");
  assert.equal(R.plateOfStation(st, col).state, "perfect", "盘上那份没被动过（永久保鲜，还是好的）");
  assert.equal(st.burnt, 0, "「没地方放」这一刻还不算糊（窗口还在走）");
  R.trashStation(st, col);                        // 清掉锅里那份（顺带清盘），再原样做一份放回盘上
  assert.equal(pickOut(st, col, 12).ok, true, "重做一份放回盘上");
  assert.equal(st.burnt, 0, "丢掉锅里那份也不记糊");
  /* 双击仍然丢得掉 —— 「盘上东西丢不丢」仍由玩家决定 */
  assert.equal(R.trashColumn(st, col), true, "双击盘照样能丢掉（丢弃仍需玩家操作）");`);

/* ── Q8 永久保鲜③ 的 ③b（自动落盘那条）────────────────────────────────── */
job("keep3b", `  /* ③b 自动落盘（默认开）：一到「恰好」就离开锅 → 锅里根本不给它糊的机会 */
  const st2 = plateState();
  assert.equal(st2.cfg.autoPlate, true, "autoPlate 默认开");
  assert.equal(R.placeFood(st2, "egg", null), true);
  advance(st2, R.FOOD.egg.dur + 0.05);
  assert.equal(st2.stations[col].food, null, "熟了立刻落盘 → 锅位空出来");
  assert.equal(R.plateOfStation(st2, col).state, "perfect");
  advance(st2, 60);
  assert.equal(st2.burnt, 0, "自动落盘这条路上锅内不会糊（压力点只剩「按住看火」那条）");
  assert.equal(R.plateOfStation(st2, col).tier, "hot", "盘上那份 60s 后仍是热乎档");`,
null,
`  /* ③b 页面默认（autoPlate **关闭** · bf-14）：一到「恰好」就停在锅里等起锅；
         这里点锅起锅，之后盘上那份 60s 后仍是热乎档（锅内那条压力不回流到盘上） */
  const st2 = plateState();
  assert.equal(st2.cfg.autoPlate, false, "bf-14：autoPlate 默认关闭");
  assert.equal(R.placeFood(st2, "egg", null), true);
  assert.equal(pickOut(st2, col, 12).ok, true, "窗口内单击锅 → 起锅落盘");
  assert.equal(st2.stations[col].food, null, "起锅后锅位空出来");
  assert.equal(R.plateOfStation(st2, col).state, "perfect");
  advance(st2, 60);
  assert.equal(st2.burnt, 0, "盘上那份 60s 里一次都没糊（压力只在锅里，不在盘上）");
  assert.equal(R.plateOfStation(st2, col).tier, "hot", "盘上那份 60s 后仍是热乎档");`);

/* ── Q9 新增 4 条 bf-14 用例（插在永久保鲜③ 之后）───────────────────────── */
job("newcases", `  assert.equal(R.trashColumn(st3, col3), true, "双击才丢得掉");
  assert.equal(c3.done.indexOf("bacon") >= 0, false, "那份始终没送出去");
});`,
null,
`  assert.equal(R.trashColumn(st3, col3), true, "双击才丢得掉");
  assert.equal(c3.done.indexOf("bacon") >= 0, false, "那份始终没送出去");
});

/* ══════════════ 3c. 锅内限时起锅（bf-14 用户要求）══════════════
   用户原话：「餐盘可以一直放着，锅里也可以同时煮着，但是锅里的熟了必须在规定时间内起锅啊，
             如果备用餐盘里放着，锅里要起锅的没地方放就只能糊掉，然后想再使用锅，
             就要双击扔掉里面的食物」。
   四条新用例：① autoPlate 默认关（含页面 start 那条路）；
              ② 恰好不进盘 / 窗口内点锅起锅 / 盘被占 → 提示 + 继续计时 → 超时糊；
              ③ 糊锅不可用 → 双击丢弃 → 恢复（不扣分）+ 窗口边界 ±ε；
              ④ 多锅并行（3 口同时在窗口里互不影响）。 */

test("bf-14①：autoPlate 默认关闭 —— 不传该参数也关（newState 与页面 start 两条路都验）", () => {
  /* newState：不传 / 传 false / 传 true 三种 */
  assert.equal(R.newState({ duration: 75, goal: 8 }).cfg.autoPlate, false, "不传 autoPlate → 关闭（页面口径）");
  assert.equal(R.newState({ autoPlate: false }).cfg.autoPlate, false, "显式 false → 关闭");
  assert.equal(R.newState({ autoPlate: true }).cfg.autoPlate, true, "显式 true → 打开（只剩调试 / 老回归这条通道）");
  /* 页面路径：真走 start()，玩家那一侧（index.html 从不传 autoPlate）必须是关闭 */
  const b = bootDom();
  assert.equal(b.B.start(b.host, { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish(){} }), true, "开局");
  const d = b.B.debug;
  assert.equal(d.state().autoPlate, false, "**页面开局默认关闭自动落盘**");
  assert.equal(d.state().panWindow, R.SERVE_WINDOW, "页面读到的起锅窗口 = SERVE_WINDOW");
  assert.equal(d.state().panBurntSticky, true, "页面读到的「糊锅粘住」= true");
  assert.equal(b.B.SERVE_WINDOW, 4.5, "SERVE_WINDOW 现值仍是 4.5s（可调常量）");
  assert.equal(b.B.SERVE_WARN_SEC, 1.0, "最后 1 秒红闪阈值");
  assert.equal(b.B.PAN_PICK_TEXT, "恰好 · 起锅", "锅内起锅提示文案（UI 与规则同源）");
  assert.equal(b.B.PAN_BLOCKED_TEXT, "盘占着 · 没地方放", "盘被占时的文案");
  assert.equal(b.B.PAN_BURNT_TEXT, "糊了 · 双击丢掉", "糊锅文案");
  /* 熟了不再落盘：页面里真下料、真推进到恰好 */
  assert.equal(d.drop("egg", null), true, "点食材下锅");
  for (let i = 0; i < 400 && d.stations()[3].state !== "perfect"; i++) d.tick(1 / 60);
  assert.equal(d.stations()[3].state, "perfect", "煎蛋熟了");
  assert.equal(d.plates().length, 0, "熟了**没有**自动落盘（本轮核心口径）");
  assert.equal(d.stations()[3].food, "egg", "那份还在锅里等起锅");
  assert.equal(d.stations()[3].windowOpen, true, "起锅窗口开着");
  assert.ok(d.stations()[3].serveWin > 0, "窗口倒计时在走（剩余 " + d.stations()[3].serveWin.toFixed(2) + "s）");
  assert.equal(d.state().windows, 1, "顶栏口径：此刻有 1 口锅等着起锅");
  /* 单击锅 = 起锅（debug.takeOut 与 tap("station") 是同一条路；真鼠标点击见无头验收）*/
  assert.equal(d.takeOut(3).ok, true, "单击锅 → 起锅");
  assert.equal(d.stations()[3].plate, "egg", "起锅落到专属盘");
  assert.equal(d.plates().length, 1, "盘上 1 份");
  assert.equal(d.plates()[0].tier, "hot", "入盘即最高档（热乎）");
  assert.equal(d.state().windows, 0, "起锅后这口锅的窗口关闭");
  d.close();
});

test("bf-14②：恰好不进盘 → 窗口内单击锅起锅（最高档）；盘被占 → 提示 + 继续计时 → 超时糊", () => {
  const st = plateState();                       // 页面口径：autoPlate 不传（默认关闭）
  const col = R.columnOf("egg");
  /* ① 恰好 → 不进盘、进窗口 */
  assert.equal(R.placeFood(st, "egg", null), true, "煎蛋下锅");
  advance(st, R.FOOD.egg.dur + 0.02);
  assert.equal(st.stations[col].state, "perfect", "刚进「恰好」");
  assert.equal(st.plates.length, 0, "**不进盘**（原口径：同一帧自动落盘）");
  assert.ok(st.stations[col].serveWin > 0, "进入起锅窗口（剩余 " + st.stations[col].serveWin.toFixed(2) + "s）");
  assert.equal(R.isServeWindowOpen(st.stations[col]), true, "isServeWindowOpen 真的为 true（原口径：恒 false）");
  assert.equal(R.phaseOf(st, col), "window", "状态机：window（还没落盘）");
  /* ② 窗口内单击锅 → 入盘，盘上是最高档（热乎 14 分） */
  const r = R.takeOut(st, col);
  assert.equal(r.ok, true); assert.equal(r.kind, "plated");
  assert.equal(r.tier, "hot", "入盘即最高档");
  const p = R.plateOfStation(st, col);
  assert.equal(p.food, "egg"); assert.equal(p.state, "perfect"); assert.equal(p.tier, "hot");
  assert.equal(p.left, Infinity, "盘上永久保鲜：没有倒计时");
  assert.equal(st.stations[col].food, null, "起锅后锅位立刻空出来");
  assert.equal(st.prepped, 1, "记账：备好 1 份");
  /* ③ 盘被占：再下一份 → 熟了没地方放 → 起锅被拒 + 窗口继续走 */
  assert.equal(R.placeFood(st, "egg", null), true, "盘里还放着一份时**照样能下料**（新口径）");
  const po = pickOut(st, col);
  assert.equal(po.ok, false); assert.equal(po.why, "plate-occupied", "起锅被拒：盘里还有一份，没地方放");
  assert.match(po.hint, /盘里还有一份/);
  assert.equal(st.plates.length, 1, "盘上那份没被动过");
  assert.equal(st.stations[col].state, "perfect", "锅里那份还在（窗口继续走）");
  assert.ok(st.stations[col].serveWin > 0, "被拒**不会**重置窗口（剩余 " + st.stations[col].serveWin.toFixed(2) + "s）");
  const left = st.stations[col].serveWin;
  advance(st, left - 0.01);
  assert.equal(st.stations[col].state, "perfect", "窗口内还剩 0.01s：还没糊");
  advance(st, 0.03);
  assert.equal(st.stations[col].state, "burnt", "窗口走完 → 锅里那份**糊了**");
  assert.equal(st.burnt, 1, "burnt 记账 +1"); assert.equal(st.expire, 1, "expire（忘起锅）+1");
  assert.equal(st.plates.length, 1, "盘上那份完好（糊的只是锅里那份）");
  assert.equal(R.plateOfStation(st, col).state, "perfect", "盘上那份仍是 perfect（永久保鲜不受影响）");
});

test("bf-14③：糊锅不能再下料（station-occupied）→ 双击丢弃 → 恢复可用且不扣分；窗口边界 ±ε", () => {
  /* 窗口边界：SERVE_WINDOW-ε 不糊 / +ε 糊（确定性时钟推进，不读真实时钟） */
  const st = plateState();
  const col = R.columnOf("bacon");
  assert.equal(R.placeFood(st, "bacon", null), true, "培根下锅");
  assert.ok(advToWindow(st, col, 8) >= 0, "培根进入起锅窗口");
  const eps = 0.02;
  advance(st, R.SERVE_WINDOW - eps);
  assert.equal(st.stations[col].state, "perfect", "SERVE_WINDOW-ε：**不糊**");
  assert.equal(st.burnt, 0, "还没糊");
  advance(st, eps * 2);
  assert.equal(st.stations[col].state, "burnt", "SERVE_WINDOW+ε：**糊**");
  assert.equal(st.burnt, 1, "糊掉记账 +1（只有这一次）");
  /* 糊锅 → 不可用（理由码正确） */
  const rPlace = R.placeFoodEx(st, "bacon", null);
  assert.equal(rPlace.ok, false); assert.equal(rPlace.why, "station-occupied", "糊着的时候不能再下料（理由码正确）");
  assert.equal(R.stationFree(st, col), false, "这一列不可用");
  assert.equal(R.takeOut(st, col).why, "burnt", "单击锅只会被告知「只能丢掉」");
  assert.equal(R.serveFromColumn(st, col).why, "no-plate", "锅里那份没落盘 → 单击盘没东西可送");
  /* 糊残骸**不会自动清**（bf-14：以前 14 秒自己消失）*/
  assert.equal(R.PAN_BURNT_STICKY, true, "PAN_BURNT_STICKY = true");
  advance(st, 60);
  assert.equal(st.stations[col].state, "burnt", "放手 60 秒：糊残骸**还在**（必须双击）");
  assert.equal(st.stations[col].food, "bacon", "锅里那份还堵着");
  /* 双击 → 丢掉 → 恢复（不扣分）*/
  const sc = st.score;
  assert.equal(R.trashColumn(st, col), true, "双击锅（或该列盘）→ 丢掉糊的");
  assert.equal(st.score, sc, "丢垃圾桶不扣分");
  assert.equal(st.stations[col].food, null, "锅清空");
  assert.equal(R.stationFree(st, col), true, "锅恢复可用");
  assert.equal(R.trashColumn(st, col), false, "再点一次无事发生");
  assert.equal(st.score, sc, "仍然不扣分");
  assert.equal(R.placeFood(st, "bacon", null), true, "马上能再下一份");
});

test("bf-14④：多锅并行 —— 3 口锅同时在起锅窗口里，各点各的互不影响", () => {
  const st = plateState();
  const foods = ["juice", "milk", "bun"];
  const cols = foods.map(f => R.columnOf(f));
  foods.forEach(f => assert.equal(R.placeFood(st, f, null), true, "并行下料 " + R.FOOD[f].n));
  let g = 0;
  while (g++ < 900 && !cols.every(c => st.stations[c].state === "perfect" && st.stations[c].serveWin > 0)) R.step(st, 1 / 60);
  assert.equal(cols.every(c => st.stations[c].state === "perfect" && st.stations[c].serveWin > 0), true,
    "3 口锅**同时在**窗口里：" + cols.map(c => R.FOOD[R.foodOfColumn(c)].n + " " + st.stations[c].serveWin.toFixed(2) + "s").join(" · "));
  const before = cols.map(c => st.stations[c].serveWin);
  assert.equal(R.takeOut(st, cols[0]).ok, true, "第 1 口起锅成功");
  assert.equal(st.plates.length, 1, "只有第 1 口那份进了盘");
  assert.equal(!!st.stations[cols[1]].food && !!st.stations[cols[2]].food, true, "另两口锅里的东西还在（没被牵连）");
  advance(st, 1.0);
  assert.ok(Math.abs(st.stations[cols[1]].serveWin - (before[1] - 1)) < 0.02,
    "第 2 口的窗口照常倒数 1s（" + st.stations[cols[1]].serveWin.toFixed(2) + "s）");
  assert.ok(Math.abs(st.stations[cols[2]].serveWin - (before[2] - 1)) < 0.02,
    "第 3 口的窗口照常倒数 1s（" + st.stations[cols[2]].serveWin.toFixed(2) + "s）");
  /* 谁都不管 → 剩下两口各自超时糊掉；已经起锅那口不受影响 */
  advance(st, R.SERVE_WINDOW + 0.2);
  assert.equal(st.burnt, 2, "剩下两口各自糊掉（burnt=2）");
  assert.equal(st.stations[cols[0]].state, "idle", "已经起锅那口是干净的（没被牵连）");
  assert.equal(st.plates.length, 1, "盘上还是第 1 口那份");
  assert.equal(R.plateOfStation(st, cols[0]).food, "juice", "盘上那份就是第 1 口的果汁");
});`);

/* ── Q10 botRun（结算面板那套用例的机器人）────────────────────────────── */
job("botrun", `/** 机器人：看单下料 → 熟了自动落盘 → 单击盘出餐（真把「通过」跑出来） */
function botRun(B) {
  const d = B.debug;
  let guard = 0;
  while (!d.state().over && guard++ < 6000) {
    for (const c of d.orders()) for (const f of c.order) {
      if (c.done.indexOf(f) >= 0) continue;
      if (d.stations().some(s => s.food === f)) continue;
      if (d.plates().some(p => p.food === f && p.state !== "burnt")) continue;
      d.drop(f, null);
    }
    for (let n = 0; n < 60 && !d.state().over; n++) { d.tick(1 / 60); if (d.plates().some(p => p.state === "perfect")) break; }
    if (d.state().over) break;
    d.stations().forEach((s, i) => { if (s.plate && s.plateState !== "burnt") d.serveCol(i); });
    d.stations().forEach((s, i) => {
      if (s.state === "burnt" || s.plateState === "burnt") { d.trash(i); return; }
      if (s.plate) { const r = d.serveCol(i); if (!r.ok && r.why === "no-want") d.trash(i); }
    });
    d.tick(0.15);
  }
  return d.state();
}`,
null,
`/** 机器人：看单下料 → 锅里熟了**在窗口内点锅起锅**（bf-14）→ 单击盘出餐（真把「通过」跑出来） */
function botRun(B) {
  const d = B.debug;
  let guard = 0;
  while (!d.state().over && guard++ < 6000) {
    /* ① 起锅：锅里进窗口的那份 → 单击锅；盘被占就先点盘把旧的送出去 */
    d.stations().forEach((s, i) => {
      if (s.state === "perfect" && s.windowOpen) {
        if (s.plate) { const r = d.serveCol(i); if (!r.ok) d.trash(i); }
        else d.takeOut(i);
      }
    });
    /* ② 盘上的存货 → 单击盘送给要的人；糊了 / 没人要 → 丢掉，别堵着 */
    d.stations().forEach((s, i) => {
      if (s.state === "burnt" || s.plateState === "burnt") { d.trash(i); return; }
      if (s.plate) { const r = d.serveCol(i); if (!r.ok && r.why === "no-want") d.trash(i); }
    });
    /* ③ 看单下料（每样只进自己那一列）*/
    for (const c of d.orders()) for (const f of c.order) {
      if (c.done.indexOf(f) >= 0) continue;
      if (d.stations().some(s => s.food === f)) continue;
      if (d.plates().some(p => p.food === f && p.state !== "burnt")) continue;
      d.drop(f, null);
    }
    for (let n = 0; n < 60 && !d.state().over; n++) {
      d.tick(1 / 60);
      if (d.stations().some(s => s.windowOpen)) break;
    }
    if (d.state().over) break;
    d.tick(0.15);
  }
  return d.state();
}`);

/* ── Q11 下锅音效：落盘那一段 ───────────────────────────────────────────── */
job("audiocook", `  assert.equal(R.placeFood(st, "egg", null), true);
  advance(st, 2.6);                                   // 熟了自动落盘
  assert.equal(R.plateOfStation(st, 3).food, "egg", "确实落盘了");
  assert.equal(played("cook_egg").length, 1, "出锅 / 落盘不响（只在下锅那一刻响）");`,
null,
`  assert.equal(R.placeFood(st, "egg", null), true);
  assert.equal(pickOut(st, 3, 6).ok, true, "熟了在窗口内点锅起锅（bf-14：不再自动落盘）");
  assert.equal(R.plateOfStation(st, 3).food, "egg", "确实落盘了");
  assert.equal(played("cook_egg").length, 1, "起锅 / 落盘不响（只在下锅那一刻响）");`);

/* ── Q12 下锅音效：静默环境那一段 ──────────────────────────────────────── */
job("audiosilent", `  /* 玩法账照记：下料 / 落盘 / 出餐一条都不少 */
  advance(st, R.FOOD.juice.dur + 0.1);
  assert.equal(R.plateOfStation(st, 8).food, "juice", "果汁照样熟了落盘");
  assert.equal(st.made, 2, "两次下料都记在账上");`,
null,
`  /* 玩法账照记：下料 / 起锅 / 出餐一条都不少 */
  assert.equal(pickOut(st, 8, 6).ok, true, "果汁照样能起锅落盘（窗口内点锅）");
  assert.equal(R.plateOfStation(st, 8).food, "juice", "果汁落到第 8 列的盘上");
  assert.equal(st.made, 2, "两次下料都记在账上");`);

/* ── 落盘 ──────────────────────────────────────────────────────────────── */
const dir = path.join(OUT, "tools", "bf", "_patch");
for (const t of T) fs.writeFileSync(path.join(dir, "bf14t_" + t.name + ".txt"), t.text.replace(/\r\n/g, "\n"), "utf8");
fs.writeFileSync(path.join(dir, "jobs_bf14_tests.json"), JSON.stringify({ jobs: jobs }, null, 1), "utf8");
console.log("✓ 生成 " + T.length + " 个 job → tools/bf/_patch/jobs_bf14_tests.json");
T.forEach((t, i) => console.log("  job#" + (i + 1) + " · " + t.name + " · " + t.text.split("\n").length + " 行"));
