/* ═══════════════════════════════════════════════════════════════════════════
   mk_bf14_panel2.js — bf-14 第九轮：bf_pan_window.png 的计数口径修正
     「盘占着」在锅上是**画两处**的（锅顶小字 + 锅底那行），文字计数会翻倍 ——
     图里那句注解必须报「几口锅」，不能报「几处文字」。改成从 state 读（picking / blockedByPlate），
     文字计数只作为交叉证据打印在控制台。
   用法：node tools/bf/_patch/mk_bf14_panel2.js
         node tools/bf/_patch/_bf14_preflight.js tools/bf/_patch/jobs_bf14_panel2.json
         node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf14_panel2.json
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/bf/shots/panel.js";
const T = [], jobs = [];
function job(name, from, to, text) {
  T.push({ name: name, text: text });
  jobs.push({ file: FILE, from: from, to: to || undefined, textFile: "tools/bf/_patch/bf14p2_" + name + ".txt" });
}

job("counters", `  const cntPick = panTexts.filter(x => /起锅！点一下这口锅/.test(x)).length;
  const cntRing = panTexts.filter(x => /恰好 · 起锅 \\d+\\.\\d+s/.test(x)).length;
  const cntBurnt = panTexts.filter(x => /糊了 · 双击丢掉/.test(x)).length;
  const cntBlocked = panTexts.filter(x => /盘占着 · 没地方放/.test(x)).length;
  const cntKeep = panTexts.filter(x => /可一直放着/.test(x)).length;`,
null,
`  /* 文字计数（交叉证据）：注意「盘占着 · 没地方放」在锅上会画**两处**（锅顶小字 + 锅底那行），
     所以图里报「几口锅」必须从 state 读，文字计数只打印到控制台。 */
  const cntPick = panTexts.filter(x => /起锅！点一下这口锅/.test(x)).length;
  const cntRing = panTexts.filter(x => /恰好 · 起锅 \\d+\\.\\d+s/.test(x)).length;
  const cntBurnt = panTexts.filter(x => /糊了 · 双击丢掉/.test(x)).length;
  const cntBlocked = panTexts.filter(x => /盘占着 · 没地方放/.test(x)).length;
  const cntKeep = panTexts.filter(x => /可一直放着/.test(x)).length;
  const stAll = d.stations();
  const nPick = stAll.filter(s => s.picking && !s.blockedByPlate).length;   // 几口锅在起锅窗口里等人点
  const nBlocked = stAll.filter(s => s.blockedByPlate).length;             // 几口锅被盘堵住
  const nBurntPan = stAll.filter(s => s.state === "burnt").length;         // 几口锅糊着`);

job("labels", `  put("本帧实测：起锅提示 " + cntPick + " 口 · 窗口倒计时 " + cntRing + " 口（煎蛋剩 " + (S3.serveWin || 0).toFixed(1) + "s）· " +
      "已糊 " + cntBurnt + " 口（培根 · burnt=" + d.state().burnt + "）· 盘占着 " + cntBlocked + " 口（三明治）· " +
      "盘上 " + cntKeep + " 份（三明治·热乎）",
      24, bandY + 186, 26, "#ffd76e");`,
null,
`  put("本帧实测：等着起锅 " + nPick + " 口（煎蛋剩 " + (S3.serveWin || 0).toFixed(1) + "s）· 已糊 " + nBurntPan +
      " 口（培根 · burnt=" + d.state().burnt + "）· 盘占着没地方放 " + nBlocked + " 口（三明治）· " +
      "盘上保鲜 " + cntKeep + " 份（三明治·热乎 ·「∞ 可一直放着」）",
      24, bandY + 186, 26, "#ffd76e");`);

job("consolelog", `  console.log("    [锅内起锅] 起锅提示 " + cntPick + " 口 · 倒计时 " + cntRing + " 口 · 已糊 " + cntBurnt +
              " 口 · 盘占着 " + cntBlocked + " 口 · 盘上保鲜文案 " + cntKeep + " 处 · burnt=" + d.state().burnt);`,
null,
`  console.log("    [锅内起锅] 等着起锅 " + nPick + " 口 · 已糊 " + nBurntPan + " 口 · 盘占着 " + nBlocked + " 口 · burnt=" + d.state().burnt +
              "（文字证据：起锅提示 " + cntPick + " 处 · 倒计时 " + cntRing + " 处 · 糊了 " + cntBurnt +
              " 处 · 没地方放 " + cntBlocked + " 处 · 可一直放着 " + cntKeep + " 处）");`);

const dir = path.join(OUT, "tools", "bf", "_patch");
for (const t of T) fs.writeFileSync(path.join(dir, "bf14p2_" + t.name + ".txt"), t.text.replace(/\r\n/g, "\n"), "utf8");
fs.writeFileSync(path.join(dir, "jobs_bf14_panel2.json"), JSON.stringify({ jobs: jobs }, null, 1), "utf8");
console.log("✓ 生成 " + T.length + " 个 job → tools/bf/_patch/jobs_bf14_panel2.json");
T.forEach((t, i) => console.log("  job#" + (i + 1) + " · " + t.name + " · " + t.text.split("\n").length + " 行"));
