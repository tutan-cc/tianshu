/* ═══════════════════════════════════════════════════════════════════════════
   mk_bf14b_jobs.js — bf-14 第二轮（修两处真机行为 + 补测试断言）
     · breakfast.js ①：serveCustomer 取走盘上那份时**不该再清空锅**（bf-14 起锅里可以同时煮着）
     · breakfast.js ②：mkPlate 初始化 age = 0（起锅那一刻盘龄就是 0，别留 undefined）
     · tests ③：计分用例里那段「熟了自动落盘」按新口径改写（点锅起锅）
     · tests ④：永久保鲜② 重做一份前要先下料
     · tests ⑤：bf-14② 补「从盘上出餐**不会**动到锅里那份」
   用法：node tools/bf/_patch/mk_bf14b_jobs.js
         node tools/bf/_patch/_bf14_preflight.js tools/bf/_patch/jobs_bf14b.json
         node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf14b.json
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const T = [], jobs = [];
function job(name, file, from, to, text) {
  T.push({ name: name, text: text });
  jobs.push({ file: file, from: from, to: to || undefined, textFile: "tools/bf/_patch/bf14b_" + name + ".txt" });
}

/* ── ① serveCustomer：取走盘上那份不再清空锅 ─────────────────────────────── */
job("serve_owner", "breakfast.js",
`    st.plates.splice(pi, 1);
    /* 盘被取走 → 归属灶位立刻可用（糊的也算，见下面 burnt 分支） */
    var owner = stationByIdx(st, p.station);
    if (owner) { owner.food = null; owner.t = 0; owner.state = "idle"; owner.doneAt = 0; owner.serveWin = 0; owner.burntAt = 0; }
    var tier = p.tier || heatTierOf(p.state, st.elapsed - p.at);`,
null,
`    st.plates.splice(pi, 1);
    /* bf-14：盘被取走**只清盘，不动锅**。理由 —— 用户要求「餐盘可以一直放着，锅里也可以同时煮着」，
       所以「盘上有存货」与「锅里在煮 / 在等起锅」可以同时成立；
       老口径那句「盘被取走 → 归属灶位立刻可用」在当时是对的（锅里那份早就在盘上了），
       现在再清一次会把玩家正在等起锅的那份**悄悄抹掉**（真机复现过：点盘出餐 → 锅里的熟份凭空消失）。
       想清锅仍然只有一条路：双击（trashStation）。 */
    var tier = p.tier || heatTierOf(p.state, st.elapsed - p.at);`);

/* ── ② mkPlate：age 初始化 ─────────────────────────────────────────────── */
job("mkplate_age", "breakfast.js",
`    return { station:stationIdx, food:foodId, state:state, tier:tier, hot:(tier === "hot"),
             at:st.elapsed, left:PLATE_NO_TIMER, burning:false, burntAt:0,`,
null,
`    return { station:stationIdx, food:foodId, state:state, tier:tier, hot:(tier === "hot"),
             at:st.elapsed, age:0, left:PLATE_NO_TIMER, burning:false, burntAt:0,`);

/* ── ③ 计分用例：熟了自动落盘 → 点锅起锅 ───────────────────────────────── */
job("score_plate", "tests/breakfast.test.cjs",
`  // 自动落盘：真实帧推进下，一到「恰好」就离开锅、落到本列专属盘（要求 A3）
  st = plateState();
  longPatience(R.spawnCustomer(st, ["egg"]));
  assert.equal(R.placeFood(st, "egg", null), true, "点一下食材 → 自动进它那一列");
  advance(st, R.FOOD.egg.dur + 0.1);
  assert.equal(st.stations[3].food, null, "熟了以后锅里立刻空出来");
  assert.equal(R.plateOfStation(st, 3).food, "egg", "那份煎蛋在自己的专属盘上");
  assert.equal(R.phaseOf(st, 3), "plated", "状态机：cooking → plated");
  const rAgain = R.serveFromColumn(st, 3);
  assert.equal(rAgain.ok, true); assert.equal(rAgain.delta, 14, "单击盘出餐 = 热乎 14");
  assert.equal(st.hot, 1);`,
null,
`  // 起锅：真实帧推进下，一到「恰好」进起锅窗口 → 单击锅 → 落到本列专属盘
  // （原口径是「一到恰好就自动落盘」；bf-14 改成玩家点锅起锅，见 bf-14①②）
  st = plateState();
  longPatience(R.spawnCustomer(st, ["egg"]));
  assert.equal(R.placeFood(st, "egg", null), true, "点一下食材 → 自动进它那一列");
  advance(st, R.FOOD.egg.dur + 0.1);
  assert.equal(st.stations[3].state, "perfect", "熟了（停在锅里等起锅）");
  assert.equal(st.plates.length, 0, "熟了**不再自动落盘**（原口径：锅里立刻空出来）");
  assert.equal(R.takeOut(st, 3).ok, true, "单击锅 → 起锅");
  assert.equal(st.stations[3].food, null, "起锅以后锅里才空出来");
  assert.equal(R.plateOfStation(st, 3).food, "egg", "那份煎蛋在自己的专属盘上");
  assert.equal(R.phaseOf(st, 3), "plated", "状态机：cooking → window → plated");
  const rAgain = R.serveFromColumn(st, 3);
  assert.equal(rAgain.ok, true); assert.equal(rAgain.delta, 14, "单击盘出餐 = 热乎 14");
  assert.equal(st.hot, 1);`);

/* ── ④ 永久保鲜②：重做一份要先下料 ─────────────────────────────────────── */
job("keep2_place", "tests/breakfast.test.cjs",
`  R.trashStation(st, col);                        // 清掉锅里那份（顺带清盘），再原样做一份放回盘上
  assert.equal(pickOut(st, col, 12).ok, true, "重做一份放回盘上");`,
null,
`  R.trashStation(st, col);                        // 清掉锅里那份（顺带清盘），再原样做一份放回盘上
  assert.equal(R.placeFood(st, "bun", null), true, "重新下料");
  assert.equal(pickOut(st, col, 12).ok, true, "重做一份放回盘上");`);

/* ── ⑤ bf-14②：补「出餐不动锅」断言（对应 ① 的真机修复） ───────────────── */
job("serve_keeps_pan", "tests/breakfast.test.cjs",
`  assert.equal(st.stations[col].state, "perfect", "锅里那份还在（窗口继续走）");
  assert.ok(st.stations[col].serveWin > 0, "被拒**不会**重置窗口（剩余 " + st.stations[col].serveWin.toFixed(2) + "s）");
  const left = st.stations[col].serveWin;
  advance(st, left - 0.01);`,
null,
`  assert.equal(st.stations[col].state, "perfect", "锅里那份还在（窗口继续走）");
  assert.ok(st.stations[col].serveWin > 0, "被拒**不会**重置窗口（剩余 " + st.stations[col].serveWin.toFixed(2) + "s）");
  /* ④ 把盘上那份送出去腾地方：**只清盘，不许动锅**（锅里那份还在等起锅）*/
  const cw = longPatience(R.spawnCustomer(st, ["egg"]));
  const sv0 = R.serveFromColumn(st, col);
  assert.equal(sv0.ok, true, "盘上那份送给顾客");
  assert.equal(R.plateOfStation(st, col), null, "盘空了");
  assert.equal(cw.done.indexOf("egg") >= 0, true, "顾客拿到了那一份");
  assert.equal(st.stations[col].food, "egg", "出餐**没有**把锅里那份清掉（bf-14 真机修复）");
  assert.equal(st.stations[col].state, "perfect", "锅里那份还是恰好");
  assert.ok(st.stations[col].serveWin > 0, "窗口照旧在走（看门狗没被出餐重置）");
  assert.equal(R.takeOut(st, col).ok, true, "盘一空，窗口内点锅 → 起锅成功");
  assert.equal(R.plateOfStation(st, col).food, "egg", "第二份进盘了");
  R.trashStation(st, col);                       // 清干净，回到后面「盘被占 → 糊」那条主线
  assert.equal(R.placeFood(st, "egg", null), true, "重新下料，继续验「盘被占 → 窗口走完 → 糊」");
  const po2 = pickOut(st, col);
  assert.equal(po2.why, "plate-occupied", "盘被占（这次是被出餐后重下的那份占着）");
  const left = st.stations[col].serveWin;
  advance(st, left - 0.01);`);

const dir = path.join(OUT, "tools", "bf", "_patch");
for (const t of T) fs.writeFileSync(path.join(dir, "bf14b_" + t.name + ".txt"), t.text.replace(/\r\n/g, "\n"), "utf8");
fs.writeFileSync(path.join(dir, "jobs_bf14b.json"), JSON.stringify({ jobs: jobs }, null, 1), "utf8");
console.log("✓ 生成 " + T.length + " 个 job → tools/bf/_patch/jobs_bf14b.json");
T.forEach((t, i) => console.log("  job#" + (i + 1) + " · " + t.name + " · " + t.text.split("\n").length + " 行"));
