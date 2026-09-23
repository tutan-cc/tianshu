/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/_bf13_pressure_probe.js — bf-13 证据：把「压力点」量出来

   报告里要说清「这条改动把哪些压力去掉了」，所以不能靠嘴说，这里跑三组对照：

   A) autoPlate 默认（页面真实默认，index.html 不传这个开关）
      「点一下食材，然后什么都不做」60 秒（游戏时间）：
      锅里会不会糊？盘上会不会糊/降档/消失？还能不能上餐、吃几分？
   B) autoPlate:false（页面到不了的调试手感 = 旧「按住看火」）
      同样 60 秒不管：锅里糊几份？
   C) 盘上永久保鲜的口径自检：plateBurntAt / plateLeftSec / plateExpired 的返回值。

   运行：node tools/bf/_patch/_bf13_pressure_probe.js
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "breakfast.js"), "utf8");
const ctx = vm.createContext({ console, Math, Date, isFinite, Number, String, Object, Array });
ctx.window = ctx;
vm.runInContext(SRC + "\n;globalThis.__BF = window.Breakfast;", ctx);
const R = ctx.__BF.rules;

function advance(st, seconds) {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n && !st.over; i++) R.step(st, 1 / 60);
  return st;
}
function run(label, autoPlate, seconds) {
  const st = R.newState({ duration: 9999, goal: 99, autoPlate: autoPlate });
  st.running = true; st.nextIn = 1e6;                       // 不自动进店：只看锅 / 盘本身
  const panStates = {};
  R.FOOD_IDS.forEach(f => R.placeFood(st, f, null));
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n && !st.over; i++) {
    R.step(st, 1 / 60);
    st.stations.forEach(s => { if (s.food) panStates[s.food + ":" + s.state] = (panStates[s.food + ":" + s.state] || 0) + 1; });
  }
  const plates = st.plates.map(p => ({ station: p.station, food: p.food, state: p.state, tier: p.tier,
                                       age: p.age, left: p.left, burning: p.burning }));
  console.log("\n── " + label + "（autoPlate=" + autoPlate + "，不管它 " + seconds + "s）──");
  console.log("  锅上出现过的状态帧：" + (Object.keys(panStates).length ? JSON.stringify(panStates) : "（锅里一直什么都没有）"));
  console.log("  糊掉份数 st.burnt = " + st.burnt + " · 忘取 st.expire = " + st.expire + " · 丢弃 st.tossed = " + st.tossed);
  console.log("  盘上份数 = " + plates.length + " / " + R.PLATES_TOTAL);
  plates.forEach(p => console.log("    - 第 " + p.station + " 列 " + p.food + "：state=" + p.state +
    " tier=" + p.tier + " age=" + p.age + "s left=" + p.left + " burning=" + p.burning));
  /* 还能不能上餐、吃几分（现场造一位只要这一样的顾客） */
  if (plates.length) {
    const c = R.spawnCustomer(st, [plates[0].food]);
    c.patience = c.patienceMax = 600;
    const r = R.serveFromColumn(st, plates[0].station);
    console.log("  放 " + plates[0].age + "s 后上餐：" + JSON.stringify({ ok: r.ok, kind: r.kind, heat: r.heat, delta: r.delta }));
  }
  return { burnt: st.burnt, expire: st.expire, plates: st.plates.length };
}

console.log("════ bf-13 压力点实测（breakfast.js = " + (fs.statSync(path.join(ROOT, "breakfast.js")).size) + " 字节）════");
const A = run("A) 页面默认：熟了自动落盘 + 点完就不管", true, 60);
const B = run("B) 对照：autoPlate:false（旧「按住看火」那条路，页面到不了）", false, 60);

console.log("\n── C) 盘上永久保鲜的口径自检 ──");
console.log("  PLATE_KEEP = " + R.PLATE_KEEP + " · PLATE_NO_TIMER = " + R.PLATE_NO_TIMER);
console.log("  plateBurntAt(0 / 4.49 / 4.5 / 60 / 1e6) = " +
  [0, 4.49, 4.5, 60, 1e6].map(a => R.plateBurntAt(a)).join(" / "));
console.log("  plateLeftSec(0 / 4.5 / 600) = " + [0, 4.5, 600].map(a => R.plateLeftSec(a)).join(" / "));
const st0 = R.newState({ duration: 9999, goal: 99 });
console.log("  plateExpired(空状态) = " + R.plateExpired(st0, null));

console.log("\n── 结论 ──");
console.log("  A：autoPlate 打开时，食物一到「恰好」就在同一帧离开锅 → 锅里既不会过火也不会糊，" +
            "盘上又永久保鲜 → 「忘取就报废」整条压力链在默认玩法下已经不存在（burnt=" + A.burnt + "）。");
console.log("  B：关掉 autoPlate 才有锅内 生→恰好→过火→糊（burnt=" + B.burnt + "）—— 但页面从不传这个开关，" +
            "所以它只是调试/测试手感，不是玩家能碰到的路径。");
