/* ═══════════════════════════════════════════════════════════════════════════
   mk_bf14h2_jobs.js — bf-14 第五轮：无头 ⑥.5 段的收尾（把第 0 列的盘重新摆回来 + expire 断言改相对值）
   用法：node tools/bf/_patch/mk_bf14h2_jobs.js
         node tools/bf/_patch/_bf14_preflight.js tools/bf/_patch/jobs_bf14h2.json
         node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf14h2.json
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/bf/headless.js";
const T = [], jobs = [];
function job(name, from, to, text) {
  T.push({ name: name, text: text });
  jobs.push({ file: FILE, from: from, to: to || undefined, textFile: "tools/bf/_patch/bf14h2_" + name + ".txt" });
}

job("replate0", `  d4.trash(0);
  /* bf-13 盘上永久保鲜：旧断言是「停 1.7s → 温 / 停 3.2s → 凉」，现在改成`,
null,
`  d4.trash(0);
  /* 回到「盘上永久保鲜」那条线：重新做一份放回第 0 列的盘上（下面按盘龄验档位）*/
  A(d4.placeEx("congee", null).ok === true, "再下一份白粥");
  for (let i = 0; i < 400 && !d4.stations()[0].windowOpen; i++) d4.tick(1 / 60);
  A(d4.takeOut(0).ok === true, "窗口内点锅起锅 → 放回盘上");
  A(d4.plates().length === 1 && d4.plates()[0].station === 0 && d4.plates()[0].tier === "hot",
    "盘上 1 份（第 0 列 · 热乎）—— 本段后续断言的对象");
  /* bf-13 盘上永久保鲜：旧断言是「停 1.7s → 温 / 停 3.2s → 凉」，现在改成`);

job("expire_rel", `    if (nowant) {
      A(d4.stations()[nowant.col].plate === nowant.f, "这份留在盘上永久保鲜（不消耗）");
      d4.setPlateAge(nowant.col, B.SERVE_WINDOW - 0.1);`,
null,
`    if (nowant) {
      A(d4.stations()[nowant.col].plate === nowant.f, "这份留在盘上永久保鲜（不消耗）");
      /* bf-14：「忘取」账现在**只由锅里的起锅窗口超时**产生（上面刚验过一次），
         所以这里改成相对值 —— 盘龄再怎么拨，这个账都不许动。 */
      const exp0 = d4.state().expire;
      d4.setPlateAge(nowant.col, B.SERVE_WINDOW - 0.1);`);

job("expire_assert", `      A(d4.state().expire === 0, "「忘取」账仍是 0（旧断言：记了一次忘取）");`,
null,
`      A(d4.state().expire === exp0, "盘龄再大也不记「忘起锅」（expire 只由锅内窗口超时产生）",
        exp0 + " → " + d4.state().expire);`);

const dir = path.join(OUT, "tools", "bf", "_patch");
for (const t of T) fs.writeFileSync(path.join(dir, "bf14h2_" + t.name + ".txt"), t.text.replace(/\r\n/g, "\n"), "utf8");
fs.writeFileSync(path.join(dir, "jobs_bf14h2.json"), JSON.stringify({ jobs: jobs }, null, 1), "utf8");
console.log("✓ 生成 " + T.length + " 个 job → tools/bf/_patch/jobs_bf14h2.json");
T.forEach((t, i) => console.log("  job#" + (i + 1) + " · " + t.name + " · " + t.text.split("\n").length + " 行"));
