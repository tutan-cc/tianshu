/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_hta_shots.js — 模式 B 的截图别再覆盖正式出图

   为什么：模式 B（Trident 降级）跑通之后会把 canvas.toDataURL 的结果写到
     `测试截图/bf_game.png` 与 `bf_pass.png` —— 而这两张**正式出图**是
     tools/bf/shots/panel.js 用自写软件光栅化器渲染的高质量版本（含 234 段真字体文字）。
     以前因为编码 bug 它一个字节都写不出来，所以看不出问题；编码修好之后就会覆盖掉正式出图。

   修法：Trident 的截图单独存成 `bf_trident_probe.png`（只写一份），不再动 bf_game / bf_pass。
        正式出图仍然由 tools/bf/shots/panel.js 负责。

   用法：
     node tools/bf/_patch/build_jobs_bf9_hta_shots.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_hta_shots.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/e2e/bf.js";
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
const FROM =
`    if (b.length > 1000) {
      fs.writeFileSync(path.join(SHOT_DIR, "bf_game.png"), Buffer.from(b, "base64"));
      fs.writeFileSync(path.join(SHOT_DIR, "bf_pass.png"), Buffer.from(b, "base64"));
      shots = ["bf_game.png", "bf_pass.png"];
    }`;
const TEXT =
`    if (b.length > 1000) {
      /* ⚠ 只写自己的名字：bf_game.png / bf_pass.png 是 tools/bf/shots/panel.js 用软件光栅化器
         渲染的**正式出图**（含真字体文字），Trident 这张 1080×620 的 canvas 转储不该盖掉它们。 */
      fs.writeFileSync(path.join(SHOT_DIR, "bf_trident_probe.png"), Buffer.from(b, "base64"));
      shots = ["bf_trident_probe.png"];
    }`;

const src = fs.readFileSync(path.join(OUT, FILE), "utf8");
const job = { file: FILE, from: FROM, text: TEXT };
if (countOcc(src, job.from) !== 1) {
  if (countOcc(src, crlf(job.from)) === 1) { job.from = crlf(job.from); job.text = crlf(job.text); }
  else { console.error("✗ 锚点出现 " + countOcc(src, job.from) + " 次"); process.exit(1); }
}
fs.writeFileSync(path.join(__dirname, "jobs_bf9_hta_shots.json"),
  JSON.stringify({ jobs: [job] }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_hta_shots.json：1 个 job");
