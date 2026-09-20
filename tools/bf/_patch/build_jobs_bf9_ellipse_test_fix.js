/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_ellipse_test_fix.js — 修一条自己写错的断言

   新用例里「控制点偏移 ≈ 0.5523·r」那条断言取错了轴：
   整圆第一段从 θ=0 出发（点 = (x+rx, y)），沿 y 方向切出，
   所以控制点 c1 = (x+rx, y + k·ry) —— kappa 体现在 **y** 偏移上，
   而我拿 x 偏移去比（那一位本来就等于 0）。

   用法：
     node tools/bf/_patch/build_jobs_bf9_ellipse_test_fix.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_ellipse_test_fix.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tests/breakfast.test.cjs";
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
const FROM =
`  /* 控制点也要落在「圆外一点」的合理位置（kappa ≈ 0.5523 的经典近似值）*/
  const k = Math.abs(c1.segs[0][0][0] - 40);
  assert.ok(k > 0.5 && k < 0.6, "第一段控制点偏移 ≈ 0.5523·r（贝塞尔近似系数）：" + k.toFixed(4));`;
const TEXT =
`  /* 控制点要落在「贝塞尔近似」该在的位置：第一段从 θ=0 出发、沿 +y 切出，
     所以 kappa 体现在**纵坐标**偏移上（c1 = (x+rx, y + k·ry)，k ≈ 0.5523）*/
  const kappa = Math.abs(c1.segs[0][0][1] - 20) / 30;
  assert.ok(kappa > 0.5 && kappa < 0.6,
    "第一段控制点纵偏移 / r ≈ 0.5523（贝塞尔近似系数）：" + kappa.toFixed(4));`;

const src = fs.readFileSync(path.join(OUT, FILE), "utf8");
const job = { file: FILE, from: FROM, text: TEXT };
if (countOcc(src, job.from) !== 1) {
  if (countOcc(src, crlf(job.from)) === 1) { job.from = crlf(job.from); job.text = crlf(job.text); }
  else { console.error("✗ 锚点出现 " + countOcc(src, job.from) + " 次"); process.exit(1); }
}
fs.writeFileSync(path.join(__dirname, "jobs_bf9_ellipse_test_fix.json"),
  JSON.stringify({ jobs: [job] }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_ellipse_test_fix.json：1 个 job");
