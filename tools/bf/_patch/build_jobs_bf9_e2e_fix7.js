/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_e2e_fix7.js — ⑤ 那段注入代码的语法错误

   症状：⑤ 的返回值整段是 undefined（`steps=undefined · restarts=undefined · running=undefined`）
        → 说明注入页面的那段代码**根本没跑起来**（Runtime.evaluate 抛了 SyntaxError）。

   根因：我在 ⑤ 的 `restartLong()` 里写了 `await sleep(300);`，但它是**普通函数**
        （只有最外层那个 `(async function(){…})()` 是 async）。
        JS 里「非 async 函数体内出现 await」是**语法错误**，整个脚本直接编译失败。

   修法：`function restartLong()` → `async function restartLong()`，
        调用点 `restartLong();` → `await restartLong();`。

   用法：
     node tools/bf/_patch/build_jobs_bf9_e2e_fix7.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_e2e_fix7.json --fresh-bak
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

J(String.raw`    function restartLong(){
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      var ov = document.getElementById("bfGame");     // dispose() 顺手摘掉了覆盖层，补回来
      if (ov && ov.classList) ov.classList.add("on");
      await sleep(300);                               // 让新局真的跑几帧（顾客要进来）
      return true;
    }`,
String.raw`    async function restartLong(){        // ⚠ 必须是 async：里面有 await（普通函数里写 await 是语法错误，
                                        //    整个注入脚本会编译失败 → ⑤ 的返回值全是 undefined）
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      var ov = document.getElementById("bfGame");     // dispose() 顺手摘掉了覆盖层，补回来
      if (ov && ov.classList) ov.classList.add("on");
      await sleep(300);                               // 让新局真的跑几帧
      return true;
    }`);

J(String.raw`    if (!st0 || !st0.running) { restartLong(); restarts++; }`,
  String.raw`    if (!st0 || !st0.running) { await restartLong(); restarts++; }`);

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
fs.writeFileSync(path.join(__dirname, "jobs_bf9_e2e_fix7.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_e2e_fix7.json：" + jobs.length + " 个 job");
