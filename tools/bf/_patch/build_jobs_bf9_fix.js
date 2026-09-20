/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_fix.js — bf-9 收尾的两处小修

   ① breakfast.js：debug.state() 里补 `cooks`（本局触发过多少次下锅音效）。
      无头验收要读它；上一版只把 partialServes / partialBonus 暴露了，漏了这一个。

   ② tools/bf/headless.js：把「3 位顾客耐心 5 / 20 / 40」改成游戏里**真能摆出来**的值。
      patienceFor(len) = (10 + 7.5×len) × 难度系数，len ≤ 3 → 单局耐心上限 ≈ 32.5s，
      **40 秒在这个游戏里根本不存在**（纯逻辑单测里可以直接改字段，所以那边照旧 5/20/40）。
      无头这层走的是真实 setPatience，所以改成 5 / 12 / 30（三个明显不同的档），
      并把「上限各不相同」写进断言文案。

   用法：
     node tools/bf/_patch/build_jobs_bf9_fix.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_fix.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const jobs = [];
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function J(file, from, text) { jobs.push({ file, from, to: null, text }); }

/* ── ① debug.state() 补 cooks / partialServes 的口径 ──────────────────── */
J("breakfast.js",
`          partialServes:st.partialServes || 0, partialBonus:Math.round((st.partialBonus || 0) * 10) / 10,
          partialBonusPer:PARTIAL_PATIENCE_BONUS, serveDangerSec:SERVE_DANGER_SEC,`,
`          partialServes:st.partialServes || 0, partialBonus:Math.round((st.partialBonus || 0) * 10) / 10,
          partialBonusPer:PARTIAL_PATIENCE_BONUS, serveDangerSec:SERVE_DANGER_SEC,
          /* 下锅音效的次数记在**音频台账** st.audio.cooks 上（与滴答 / 欢呼的计数同一个地方）*/
          cooks:(st.audio ? (st.audio.cooks || 0) : 0)`);

/* ── ② 无头：耐心摆成游戏里真能出现的三个档 ───────────────────────────── */
J("tools/bf/headless.js",
`    const idLate = d.pushCustomer(["egg", "congee"]);      // 先来的
    const idMid = d.pushCustomer(["egg", "salad"]);
    const idHurry = d.pushCustomer(["egg", "juice"]);      // 最后来的`,
`    /* ⚠ 耐心上限 = (10 + 7.5×订单长度) × 难度系数，单局最多 ≈32.5s ——
       「40 秒」在游戏里摆不出来（纯逻辑单测可以直接改字段，那边照旧 5/20/40）。
       这里用 5 / 12 / 30：三档差距明显，足以验证「挑最急的那位」。 */
    const idLate = d.pushCustomer(["egg", "bacon", "salad"]);   // 先来的（长单，上限最高）
    const idMid = d.pushCustomer(["egg", "congee"]);
    const idHurry = d.pushCustomer(["egg", "juice"]);          // 最后来的（要摆成最急）`);

J("tools/bf/headless.js",
`    const pLate = abs(idLate, 40), pMid = abs(idMid, 20), pHurry = abs(idHurry, 5);
    A(Math.abs(pLate - 40) < 0.05 && Math.abs(pMid - 20) < 0.05 && Math.abs(pHurry - 5) < 0.05,
      "3 位顾客的耐心分别摆成 40 / 20 / 5", pLate + " / " + pMid + " / " + pHurry);`,
`    const pLate = abs(idLate, 30), pMid = abs(idMid, 12), pHurry = abs(idHurry, 5);
    A(Math.abs(pLate - 30) < 0.05 && Math.abs(pMid - 12) < 0.05 && Math.abs(pHurry - 5) < 0.05,
      "3 位顾客的耐心分别摆成 30 / 12 / 5（三档明显不同）", pLate + " / " + pMid + " / " + pHurry);`);

/* ── 落盘：锚点行尾逐个核对 ───────────────────────────────────────────── */
const cache = {};
jobs.forEach((job, i) => {
  if (!cache[job.file]) cache[job.file] = fs.readFileSync(path.join(OUT, job.file), "utf8");
  const src = cache[job.file];
  if (countOcc(src, job.from) === 1) return;
  const c = crlf(job.from), ct = crlf(job.text);
  if (countOcc(src, c) === 1) { job.from = c; job.text = ct; return; }
  console.error("✗ job#" + (i + 1) + " " + job.file + " 锚点出现 " + countOcc(src, job.from) +
    " 次（CRLF 版 " + countOcc(src, c) + " 次）");
  process.exit(1);
});
fs.writeFileSync(path.join(__dirname, "jobs_bf9_fix.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_fix.json：" + jobs.length + " 个 job");
