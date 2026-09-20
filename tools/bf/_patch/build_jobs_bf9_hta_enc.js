/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_hta_enc.js — bf.js 的 HTA 也要 UTF-8 BOM + charset

   实测结论（tools/bf/trident-probe.js 里一路查出来的）：
     mshta/IE 读 `.hta` **按 ANSI(GBK)** 解码，不看文件其实是 UTF-8。
     仓库路径里有中文（…\重生2-原型\），模板里 `DIR = "C:\...\重生2-原型\"`
     被当 GBK 读 → 路径变乱码 → FSO 建文件抛异常 →
     `_bf_trident_out.txt` 永远写不出来 → bf.js 只能报「mshta 探针未产出结果」。
     这也解释了为什么模式 B 一直"跑不起来"：不是引擎不行，是**编码**。

   两处一起上：
     ① HTA 模板 head 里加 `<meta http-equiv="Content-Type" content="text/html; charset=utf-8">`；
     ② 落盘时加 UTF-8 BOM（`"\ufeff" + HTA`）。
   （同时保留上一轮加的三道防线：窗口藏起来 / onerror 抑制弹窗 / 跑完自关。）

   用法：
     node tools/bf/_patch/build_jobs_bf9_hta_enc.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_hta_enc.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/e2e/bf.js";
const jobs = [];
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function J(from, text) { jobs.push({ file: FILE, from, to: null, text }); }

/* ① HTA 模板：补 charset meta */
J(String.raw`const HTA = String.raw` + "`" + String.raw`<html><head><meta http-equiv="X-UA-Compatible" content="IE=edge">
<script>
try{ window.moveTo(-4000,-4000); window.resizeTo(220,140); }catch(e){}   // ① 躲到屏幕外`,
String.raw`const HTA = String.raw` + "`" + String.raw`<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<script>
try{ window.moveTo(-4000,-4000); window.resizeTo(220,140); }catch(e){}   // ① 躲到屏幕外`);

/* ② 落盘：UTF-8 BOM（mshta 按 ANSI 读，没有 BOM 中文路径就是乱码）
   ⚠ String.raw 里写什么就是什么：文件里是 `OUT + "\\"`（两个反斜杠），
     这里就必须写两个 —— 写四个会变成"锚点出现 0 次"（第一次就是这么挂的）。 */
J(String.raw`  fs.writeFileSync(htaPath, HTA.replace("__DIR__", JSON.stringify(OUT + "\\")), "utf8");`,
String.raw`  /* ⚠ 必须带 UTF-8 BOM：mshta 按 ANSI(GBK) 读 .hta，
     仓库路径里的中文会变乱码 → FSO 建文件抛异常 → 结果文件永远写不出来
     （这就是模式 B「mshta 探针未产出结果」的真凶，与引擎能力无关）。 */
  fs.writeFileSync(htaPath, "\ufeff" + HTA.replace("__DIR__", JSON.stringify(OUT + "\\")), "utf8");`);

const src = fs.readFileSync(path.join(OUT, FILE), "utf8");
jobs.forEach((job, i) => {
  if (countOcc(src, job.from) === 1) return;
  const c = crlf(job.from), ct = crlf(job.text);
  if (countOcc(src, c) === 1) { job.from = c; job.text = ct; return; }
  console.error("✗ job#" + (i + 1) + " 锚点出现 " + countOcc(src, job.from) + " 次（CRLF 版 " +
    countOcc(src, c) + " 次）：" + JSON.stringify(job.from.slice(0, 80)));
  process.exit(1);
});
fs.writeFileSync(path.join(__dirname, "jobs_bf9_hta_enc.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_hta_enc.json：" + jobs.length + " 个 job");
