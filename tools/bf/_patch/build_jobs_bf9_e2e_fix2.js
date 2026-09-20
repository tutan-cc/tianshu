/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_e2e_fix2.js — e2e 里两个「名字写错了」的修

   症状：⑥⑦ 两段真浏览器用例全部读成 undefined（注入的页面代码抛异常）。
   根因（静态核对源码就知道，不用猜）：
     · `VIEW` 挂在 **api** 上（breakfast.js:3111 `VIEW: VIEW`），不是 `ui` 上 ——
       我写成了 `window.Breakfast.ui.VIEW` → undefined → 后面 `V.w` 直接抛。
     · 三个命中框函数也一样在 api 上（breakfast.js:3115
       `stationBox / plateBox / bucketBox / customerCardBox`），debug 里**没有**它们 ——
       我写成了 `d.bucketBox(...)` / `d.plateBox(...)`，同样 undefined。

   修法：全部改成 `window.Breakfast.VIEW` / `window.Breakfast.bucketBox(...)` /
   `window.Breakfast.plateBox(...)`（与无头用例里的 `B.bucketBox(i)` 是同一处）。

   用法：
     node tools/bf/_patch/build_jobs_bf9_e2e_fix2.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_e2e_fix2.json --fresh-bak
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

/* ① ⑥ 的 clickBox：视图尺寸取 api.VIEW（带一个明确的失败出口，别再静默 NaN）*/
J(String.raw`    function clickBox(b){
      var cv = document.querySelector("canvas.bf-cv");
      if (!cv) return "no-canvas";
      var r = cv.getBoundingClientRect();
      var V = window.Breakfast.ui.VIEW;`,
String.raw`    function clickBox(b){
      var cv = document.querySelector("canvas.bf-cv");
      if (!cv) return "no-canvas";
      var r = cv.getBoundingClientRect();
      var V = window.Breakfast.VIEW;               // ⚠ VIEW 挂在 api 上，不在 ui 上
      if (!V || !V.w) return "no-view";`);

/* ② ⑥ 里点果汁 / 点煎蛋：桶的命中框在 api 上 */
J(String.raw`    var r1 = clickBox(d.bucketBox(8));                  // 果汁机那一桶`,
  String.raw`    var r1 = clickBox(window.Breakfast.bucketBox(8));    // 果汁机那一桶`);

J(String.raw`    var r2 = clickBox(d.bucketBox(3));                  // 煎蛋那一桶`,
  String.raw`    var r2 = clickBox(window.Breakfast.bucketBox(3));    // 煎蛋那一桶`);

J(String.raw`    clickBox(d.bucketBox(8));                            // 这一下响
    d.trashCol(8);
    clickBox(d.bucketBox(8));                            // 紧接着再点 → 节流，不响`,
String.raw`    clickBox(window.Breakfast.bucketBox(8));              // 这一下响
    d.trashCol(8);
    clickBox(window.Breakfast.bucketBox(8));              // 紧接着再点 → 节流，不响`);

/* ③ ⑦ 的 clickBox 与点盘 */
J(String.raw`    function clickBox(b){
      var cv = document.querySelector("canvas.bf-cv");
      var r = cv.getBoundingClientRect();
      var V = window.Breakfast.ui.VIEW;`,
String.raw`    function clickBox(b){
      var cv = document.querySelector("canvas.bf-cv");
      var r = cv.getBoundingClientRect();
      var V = window.Breakfast.VIEW;               // ⚠ VIEW 挂在 api 上，不在 ui 上`);

J(String.raw`    clickBox(d.plateBox(col));                              // ← 真实鼠标点这一列的专属盘`,
  String.raw`    clickBox(window.Breakfast.plateBox(col));                // ← 真实鼠标点这一列的专属盘`);

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
fs.writeFileSync(path.join(__dirname, "jobs_bf9_e2e_fix2.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_e2e_fix2.json：" + jobs.length + " 个 job");
