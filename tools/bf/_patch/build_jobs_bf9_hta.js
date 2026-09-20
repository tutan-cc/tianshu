/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_hta.js — 让 mshta/HTA 探针「不弹窗、不弹错、跑完自关」

   事故（用户录屏时被打断）：tools/e2e/bf.js 的模式 B 探针
     · 在桌面上**弹出可见的 mshta 窗口**；
     · breakfast.js 撞到 IE11 不支持的 `ctx.ellipse` → IE 弹出**模态「脚本发生错误」对话框**，
       用户必须手动点掉。
   （ellipse 那条已在 breakfast.js 里补了 polyfill，这里解决"别再弹到用户脸上"。）

   本作业单只动 tools/e2e/bf.js 里的 **HTA 模板字符串**，加三道防线：

     ① 窗口藏起来：脚本一解析就 `moveTo(-4000,-4000)` + `resizeTo(200,140)`
        （HTA 是受信任的，window.moveTo/resizeTo 可用；即使失败也不影响结果文件）。
     ② `window.onerror` 兜底：捕获任何脚本错误 → 记进 errors → **写成结果文件** →
        `window.close()`，并且 `return true`（IE 里 onerror 返回 true = 不再弹"脚本错误"对话框）。
     ③ 一定收尾：`run()` 外面包 try/catch + 60 秒看门狗定时器，
        无论走哪条路都写结果并关窗；`finish()` 加重入保护（只写一次、只关一次）。

   另外把等待时间说明写进注释（bf.js 那边最多等 60 秒，看门狗设 55 秒，先自关再被杀）。

   用法：
     node tools/bf/_patch/build_jobs_bf9_hta.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_hta.json --fresh-bak
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

/* ① 头部：藏窗口 + onerror 兜底（返回 true 抑制 IE 的「脚本发生错误」对话框）*/
J(String.raw`/* ── 模式 B：mshta / Trident(IE11) 降级探针 ──
   内容全 ASCII（避免 HTA 编码问题）；只测「同一份 breakfast.js 在真实浏览器引擎里能不能
   加载 / 开局 / 画非空白 / 用 debug API 打完整局」，截图走 canvas.toDataURL。 */
const HTA = String.raw` + "`" + String.raw`<html><head><meta http-equiv="X-UA-Compatible" content="IE=edge">
<script>
var fso = new ActiveXObject("Scripting.FileSystemObject");
var DIR = __DIR__;
function w(name, txt){ var f=fso.CreateTextFile(DIR+name, true); f.Write(txt); f.Close(); }
function b64(name, dataUrl){ try{ w(name, dataUrl.split(",")[1]); }catch(e){ w(name, "ERR:"+e.message); } }
function run(){`,
String.raw`/* ── 模式 B：mshta / Trident(IE11) 降级探针 ──
   内容全 ASCII（避免 HTA 编码问题）；只测「同一份 breakfast.js 在真实浏览器引擎里能不能
   加载 / 开局 / 画非空白 / 用 debug API 打完整局」，截图走 canvas.toDataURL。

   ⚠⚠ 两条硬纪律（用户实测被弹窗打断过，必须一直保留）：
     ① **不许弹到用户脸上**：脚本一解析就把窗口挪到屏幕外并缩到最小；
     ② **不许弹「脚本发生错误」对话框**：window.onerror 里 return true 会抑制 IE 的模态报错框，
        同时把错误写进结果文件并关窗（这样异步失败也能被验收看见，而不是卡一个对话框）。 */
const HTA = String.raw` + "`" + String.raw`<html><head><meta http-equiv="X-UA-Compatible" content="IE=edge">
<script>
try{ window.moveTo(-4000,-4000); window.resizeTo(220,140); }catch(e){}   // ① 躲到屏幕外
var fso = new ActiveXObject("Scripting.FileSystemObject");
var DIR = __DIR__;
var __done = false;
function w(name, txt){ var f=fso.CreateTextFile(DIR+name, true); f.Write(txt); f.Close(); }
function b64(name, dataUrl){ try{ w(name, dataUrl.split(",")[1]); }catch(e){ w(name, "ERR:"+e.message); } }
/* 兜底收尾：只写一次、只关一次；onerror 返回 true 抑制 IE 的模态报错框 ② */
function fatal(msg, url, line){
  try{
    if(!__done){
      __done = true;
      var res = { success:false, checks:[], errors:["未捕获的脚本错误：" + msg + " @" + url + ":" + line],
                  info:{ fatal:true, line:line } };
      try{ w("_bf_trident_out.txt", JSON.stringify(res)); }catch(e){}
    }
  }catch(e){}
  try{ window.close(); }catch(e){}
  return true;
}
window.onerror = function(msg, url, line){ return fatal(msg, url, line); };
function run(){`);

/* ② finish()：重入保护 + 一定关窗 */
J(String.raw`  function finish(){
    var res = { success: out.errors.length===0, checks: out.checks, errors: out.errors, info: out };
    w("_bf_trident_out.txt", JSON.stringify(res));
    try{ window.close(); }catch(e){}
  }
}
window.onload = run;`,
String.raw`  function finish(){
    if(__done) return;                       // 重入保护：onerror 与正常路径只写一次
    __done = true;
    try{
      var res = { success: out.errors.length===0, checks: out.checks, errors: out.errors, info: out };
      w("_bf_trident_out.txt", JSON.stringify(res));
    }catch(e){}
    try{ window.close(); }catch(e){}         // 跑完立刻关窗，绝不留窗口在桌面上
  }
}
/* ③ 一定收尾：run() 包 try/catch + 55 秒看门狗（bf.js 那边最多等 60 秒）*/
window.onload = function(){
  try{ setTimeout(function(){ fatal("看门狗超时（55s）", "watchdog", 0); }, 55000); }catch(e){}
  try{ run(); }
  catch(e){ fatal(e && e.message ? e.message : String(e), "run", 0); }
};`);

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
fs.writeFileSync(path.join(__dirname, "jobs_bf9_hta.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_hta.json：" + jobs.length + " 个 job");
