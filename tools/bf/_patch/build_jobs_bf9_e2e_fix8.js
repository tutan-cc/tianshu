/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_e2e_fix8.js — ⑦ 的部分上餐断言改成「增量」

   上一跑只剩 1 条红：
       他还缺一样 → 部分上餐回 +3.5s 耐心  [{"patience":8.3,"max":24.5,"serves":2,"bonus":4.8}]
   耐心 5 → 8.3 完全正确（+3.5s 且没超上限），错的是断言口径：
   `serves` / `bonus` 是**本局累计**，而 ⑤ 那段刚刚也成功上过一次餐（同一局、没重开），
   所以读到的 2 / 4.8 是两次之和。

   修法：在点击前记一份快照，断言**这一次点击带来的增量** = 1 次 / 3.5s。
   这才是这条用例真正要证明的东西（一次部分上餐回多少耐心）。

   用法：
     node tools/bf/_patch/build_jobs_bf9_e2e_fix8.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_e2e_fix8.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/bf/e2e-audio.js";
const jobs = [];
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function J(from, text) { jobs.push({ file: FILE, from, to: null, text }); }

J(String.raw`    var pick = d.pickFor("egg");
    d.clearAudio();
    clickBox(window.Breakfast.plateBox(col));                // ← 真实鼠标点这一列的专属盘
    await sleep(150);`,
String.raw`    var pick = d.pickFor("egg");
    /* 部分上餐的计数是**本局累计**的（⑤ 那段也可能上过餐）→ 这里记快照，断言"这一次"的增量 */
    var ps0 = d.state().partialServes, pb0 = d.state().partialBonus;
    d.clearAudio();
    clickBox(window.Breakfast.plateBox(col));                // ← 真实鼠标点这一列的专属盘
    await sleep(150);`);

J(String.raw`                            partialServes: d.state().partialServes, partialBonus: d.state().partialBonus,`,
String.raw`                            partialServes: d.state().partialServes, partialBonus: d.state().partialBonus,
                            dServes: d.state().partialServes - ps0,
                            dBonus: Math.round((d.state().partialBonus - pb0) * 10) / 10,`);

J(String.raw`  A(jp2.patience > 5 && jp2.patience < 9 && jp2.partialServes === 1 && jp2.partialBonus === 3.5,
    "真浏览器：他还缺一样 → 部分上餐回 +3.5s 耐心（5 → " + jp2.patience + "，上限 " + jp2.max + "）",
    JSON.stringify({ patience: jp2.patience, max: jp2.max, serves: jp2.partialServes, bonus: jp2.partialBonus }));`,
String.raw`  A(jp2.patience > 5 && jp2.patience < 9 && jp2.dServes === 1 && jp2.dBonus === 3.5,
    "真浏览器：他还缺一样 → 部分上餐回 +3.5s 耐心（5 → " + jp2.patience + "，上限 " + jp2.max + "）",
    JSON.stringify({ patience: jp2.patience, max: jp2.max, 本次次数: jp2.dServes, 本次秒数: jp2.dBonus,
                     本局累计: jp2.partialServes + "/" + jp2.partialBonus + "s" }));`);

/* 落盘：锚点行尾逐个核对 */
const src = fs.readFileSync(path.join(OUT, FILE), "utf8");
jobs.forEach((job, i) => {
  if (countOcc(src, job.from) === 1) return;
  const c = crlf(job.from), ct = crlf(job.text);
  if (countOcc(src, c) === 1) { job.from = c; job.text = ct; return; }
  console.error("✗ job#" + (i + 1) + " 锚点出现 " + countOcc(src, job.from) + " 次（CRLF 版 " +
    countOcc(src, c) + " 次）：" + JSON.stringify(job.from.slice(0, 70)));
  process.exit(1);
});
fs.writeFileSync(path.join(__dirname, "jobs_bf9_e2e_fix8.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_e2e_fix8.json：" + jobs.length + " 个 job");
