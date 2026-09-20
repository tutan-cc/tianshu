/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_e2e_fix.js — e2e-audio.js 补「这一局结束了怎么办」

   实测（第一次跑 bf-9 的 e2e）：④ 之前的用例全绿，⑤ 开始整段翻红。
   原因是**这一轮改动本身**：做菜变快（煎蛋 3.0→2.2s、白粥 5.0→3.4s …），
   页面 glue 开的是「75 秒 / 服务 8 位」的正式局，于是游戏在 ⑤ 跑到一半就 **win → onFinish
   → dispose**，此后 `d.state()` 返回 null，后面所有断言都读到 undefined。

   修法不是把断言放宽，而是让用例自己**扛住这一局结束**：
     页面内统一加一个 restartLong()：一发现没在跑，就用超长局（999s / goal 99）重开一局，
     再继续测。这样测的仍然是「真浏览器 + 真音频 + 真鼠标」，
     而不是「碰巧这一局还没结束」。

   用法：
     node tools/bf/_patch/build_jobs_bf9_e2e_fix.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_e2e_fix.json --fresh-bak
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

/* ── ① ⑤ 上餐那段：每轮先确认「还在跑」，否则用超长局重开 ───────────────── */
J(String.raw`  const happyRun = await ev(` + "`" + String.raw`(async function(){
    var d = window.__cs2.bf;
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    d.clearAudio();
    var t0 = Date.now(), served = false, tries = 0;
    while (Date.now() - t0 < 20000 && !served && tries++ < 400) {
      var os = d.orders();`,
String.raw`  const happyRun = await ev(` + "`" + String.raw`(async function(){
    var d = window.__cs2.bf;
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    /* ⚠ bf-9 起做菜变快 → 页面 glue 的「75 秒 / 8 位」正式局可能在这一段里就打完（win → dispose），
       那时 d.state() 是 null，后面全读成 undefined。所以每轮先确认还在跑，不在就用超长局重开。 */
    function restartLong(){
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      return true;
    }
    d.clearAudio();
    var t0 = Date.now(), served = false, tries = 0, restarts = 0;
    while (Date.now() - t0 < 20000 && !served && tries++ < 400) {
      var st0 = d.state();
      if (!st0 || !st0.running) { restartLong(); restarts++; await sleep(400); continue; }
      var os = d.orders();`);

/* ── ② ⑤ 的返回里带上 restarts，便于诊断；断言照旧 ──────────────────────── */
J(String.raw`    var plays = d.audio().plays;
    return JSON.stringify({ served: served, n: plays.filter(function(p){ return /happy_v[1-6]\\.mp3$/.test(p.url); }).length, plays: plays });
  })()` + "`" + String.raw`);`,
String.raw`    var plays = d.audio().plays;
    return JSON.stringify({ served: served, restarts: restarts,
                            n: plays.filter(function(p){ return /happy_v[1-6]\\.mp3$/.test(p.url); }).length,
                            plays: plays });
  })()` + "`" + String.raw`);`);

/* ── ③ ⑦ 上餐选人那段：同样先确保在跑（而不是直接报 not-running 退出）──── */
J(String.raw`    if (!d.state().running) return JSON.stringify({ err: "not-running" });
    for (var i = 0; i < 9; i++) d.trashCol(i);
    d.orders().forEach(function(o){ d.setPatience(o.id, 0); });   // 先让场上的人走光`,
String.raw`    var st0 = d.state();
    if (!st0 || !st0.running) {                                   // 上一局打完了 → 用超长局重开
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      await sleep(400);
    }
    for (var i = 0; i < 9; i++) d.trashCol(i);
    d.orders().forEach(function(o){ d.setPatience(o.id, 0); });   // 先让场上的人走光`);

/* ── 落盘：锚点行尾逐个核对 ───────────────────────────────────────────── */
const src = fs.readFileSync(path.join(OUT, FILE), "utf8");
jobs.forEach((job, i) => {
  if (countOcc(src, job.from) === 1) return;
  const c = crlf(job.from), ct = crlf(job.text);
  if (countOcc(src, c) === 1) { job.from = c; job.text = ct; return; }
  console.error("✗ job#" + (i + 1) + " 锚点出现 " + countOcc(src, job.from) + " 次（CRLF 版 " +
    countOcc(src, c) + " 次）");
  console.error("  锚首 90 字：" + JSON.stringify(job.from.slice(0, 90)));
  process.exit(1);
});
fs.writeFileSync(path.join(__dirname, "jobs_bf9_e2e_fix.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_e2e_fix.json：" + jobs.length + " 个 job");
