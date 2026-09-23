/* ═══════════════════════════════════════════════════════════════════════════
   mk_bf14g_jobs.js — bf-14 第十一轮：真 Chrome 里用**真实鼠标单击锅**验「起锅」（新交互的主证据）
   用法：node tools/bf/_patch/mk_bf14g_jobs.js
         node tools/bf/_patch/_bf14_preflight.js tools/bf/_patch/jobs_bf14g.json
         node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf14g.json
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/bf/e2e-audio.js";
const T = [], jobs = [];
function job(name, from, to, text) {
  T.push({ name: name, text: text });
  jobs.push({ file: FILE, from: from, to: to || undefined, textFile: "tools/bf/_patch/bf14g_" + name + ".txt" });
}

job("real_click", `    for (var k = 0; k < 400 && !d.stations()[col].windowOpen; k++) d.tick(1 / 60);
    var pick = d.takeOut(col);
    var plated = !!(pick && pick.ok) && !!d.stations()[col].plate;`,
null,
`    for (var k = 0; k < 400 && !d.stations()[col].windowOpen; k++) d.tick(1 / 60);
    var winLeft = d.stations()[col].serveWin;               // 起锅窗口还剩多少秒（真浏览器里读得到）
    clickBox(window.Breakfast.stationBox(col));             // ← 真实鼠标**单击锅** = 起锅（bf-14 新交互）
    var po = d.stations()[col];                             // 点击本身不推进时钟 → 点完立刻读
    var plated = !!po.plate;
    var platedTier = po.tier;`);

job("real_click_json", `    return JSON.stringify({ plated: plated, pA: pA, pB: pB, pC: pC, pick: pick, want: c, got: got,`,
null,
`    return JSON.stringify({ plated: plated, platedTier: platedTier, winLeft: winLeft,
                            pA: pA, pB: pB, pC: pC, pick: pick, want: c, got: got,`);

job("real_click_assert", `  A(jp2.pick === jp2.want, "真浏览器：规则层挑中耐心 5 那位（不是第一位）",`,
null,
`  A(jp2.plated === true && jp2.platedTier === "hot" && jp2.winLeft > 0,
    "真浏览器：真实鼠标**单击锅** → 起锅落到本列专属盘（bf-14 新交互；入盘即最高档「热乎」）",
    "窗口剩余 " + String(jp2.winLeft) + "s · 盘上 tier=" + jp2.platedTier);
  A(jp2.pick === jp2.want, "真浏览器：规则层挑中耐心 5 那位（不是第一位）",`);

const dir = path.join(OUT, "tools", "bf", "_patch");
for (const t of T) fs.writeFileSync(path.join(dir, "bf14g_" + t.name + ".txt"), t.text.replace(/\r\n/g, "\n"), "utf8");
fs.writeFileSync(path.join(dir, "jobs_bf14g.json"), JSON.stringify({ jobs: jobs }, null, 1), "utf8");
console.log("✓ 生成 " + T.length + " 个 job → tools/bf/_patch/jobs_bf14g.json");
T.forEach((t, i) => console.log("  job#" + (i + 1) + " · " + t.name + " · " + t.text.split("\n").length + " 行"));
