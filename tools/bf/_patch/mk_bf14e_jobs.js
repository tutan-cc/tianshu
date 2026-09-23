/* ═══════════════════════════════════════════════════════════════════════════
   mk_bf14e_jobs.js — bf-14 第七轮：真 Chrome 验收（tools/bf/e2e-audio.js）按新口径改写
     两处机器人都在等「自动落盘」，bf-14 起必须**点锅起锅**：
       ① ⑤ 上餐成功 → 欢呼 那条链的机器人
       ② ⑦ 上餐选人（耐心 30/12/5）那条链的机器人
   用法：node tools/bf/_patch/mk_bf14e_jobs.js
         node tools/bf/_patch/_bf14_preflight.js tools/bf/_patch/jobs_bf14e.json
         node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf14e.json
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/bf/e2e-audio.js";
const T = [], jobs = [];
function job(name, from, to, text) {
  T.push({ name: name, text: text });
  jobs.push({ file: FILE, from: from, to: to || undefined, textFile: "tools/bf/_patch/bf14e_" + name + ".txt" });
}

job("happy_bot", `      var col = d.columnOf(want), s = d.stations()[col];
      if (s.plate && s.plateState === "burnt") d.trashCol(col);      // 糊了就丢掉重来
      if (!s.food && !s.plate) d.drop(want, col);
      d.tick(1 / 60);
      var s2 = d.stations()[col];
      if (s2.plate && s2.plateState !== "burnt") { var r = d.serveCol(col); if (r && r.ok) served = true; }`,
null,
`      var col = d.columnOf(want), s = d.stations()[col];
      if (s.plate && s.plateState === "burnt") d.trashCol(col);      // 糊了就丢掉重来
      if (!s.food && !s.plate) d.drop(want, col);
      d.tick(1 / 60);
      /* bf-14：锅里熟了要**点锅起锅**（不再自动落盘）；盘被占就先点盘把旧的送出去 */
      var s2 = d.stations()[col];
      if (s2.state === "perfect" && s2.windowOpen) {
        if (s2.plate) d.serveCol(col);
        else d.takeOut(col);
      }
      var s3 = d.stations()[col];
      if (s3.plate && s3.plateState !== "burnt") { var r = d.serveCol(col); if (r && r.ok) served = true; }`);

job("pick_bot", `    var col = d.columnOf("egg");
    if (!d.stations()[col].plate && !d.stations()[col].food) d.drop("egg", col);
    /* 用游戏时钟把这份煎蛋推到落盘（与无头用例同一口径；墙钟在这里只有 ~1/5 速） */
    for (var k = 0; k < 400 && !d.stations()[col].plate; k++) d.tick(1 / 60);
    var plated = !!d.stations()[col].plate;`,
null,
`    var col = d.columnOf("egg");
    if (!d.stations()[col].plate && !d.stations()[col].food) d.drop("egg", col);
    /* 用游戏时钟把这份煎蛋推到「起锅窗口」，再**点锅起锅**（bf-14：不再自动落盘。
       墙钟在这里只有 ~1/5 速，所以必须用游戏时钟推。） */
    for (var k = 0; k < 400 && !d.stations()[col].windowOpen; k++) d.tick(1 / 60);
    var pick = d.takeOut(col);
    var plated = !!(pick && pick.ok) && !!d.stations()[col].plate;`);

const dir = path.join(OUT, "tools", "bf", "_patch");
for (const t of T) fs.writeFileSync(path.join(dir, "bf14e_" + t.name + ".txt"), t.text.replace(/\r\n/g, "\n"), "utf8");
fs.writeFileSync(path.join(dir, "jobs_bf14e.json"), JSON.stringify({ jobs: jobs }, null, 1), "utf8");
console.log("✓ 生成 " + T.length + " 个 job → tools/bf/_patch/jobs_bf14e.json");
T.forEach((t, i) => console.log("  job#" + (i + 1) + " · " + t.name + " · " + t.text.split("\n").length + " 行"));
