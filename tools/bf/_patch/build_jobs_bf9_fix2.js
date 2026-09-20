/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_fix2.js — bf-9 收尾（第 2 次）

   上一版 build_jobs_bf9_fix.js 里的 3 个 job 有 2 个已经落盘，重跑会命中幂等保护，
   所以这里只做**还没做的那一处**：

     breakfast.js 的 debug.state().cooks 读错了地方 ——
     下锅音效的次数记在**音频台账** st.audio.cooks 上（playCook 里 a.cooks++，
     与滴答 / 欢呼的计数放在同一个对象里），而 state() 读的是 st.cooks（永远是 0）。
     无头验收因此读不到次数（9 条断言全红：期望 1..9，实际 0）。

   用法：
     node tools/bf/_patch/build_jobs_bf9_fix2.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_fix2.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "breakfast.js";
const FROM =
`          partialBonusPer:PARTIAL_PATIENCE_BONUS, serveDangerSec:SERVE_DANGER_SEC,
          cooks:st.cooks || 0,                      // 本局触发过多少次「下锅音效」（无头 / 真浏览器验收读它）`;
const TEXT =
`          partialBonusPer:PARTIAL_PATIENCE_BONUS, serveDangerSec:SERVE_DANGER_SEC,
          /* 下锅音效的次数记在**音频台账** st.audio.cooks 上（playCook 里 a.cooks++，
             与滴答 / 欢呼的计数放在同一个对象里）—— 这里必须读同一处，否则永远是 0 */
          cooks:(st.audio ? (st.audio.cooks || 0) : 0),`;

const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
const src = fs.readFileSync(path.join(OUT, FILE), "utf8");
const job = { file: FILE, from: FROM, text: TEXT };
if (countOcc(src, job.from) !== 1) {
  if (countOcc(src, crlf(job.from)) === 1) { job.from = crlf(job.from); job.text = crlf(job.text); }
  else { console.error("✗ 锚点出现 " + countOcc(src, job.from) + " 次"); process.exit(1); }
}
fs.writeFileSync(path.join(__dirname, "jobs_bf9_fix2.json"),
  JSON.stringify({ jobs: [job] }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_fix2.json：1 个 job");
