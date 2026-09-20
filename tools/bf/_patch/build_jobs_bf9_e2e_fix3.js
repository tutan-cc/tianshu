/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_e2e_fix3.js — 给 e2e 的 ⑥ 段加「时钟有没有在走」的探针

   为什么：上一跑里 ⑥ 出现了自相矛盾的结果 ——
     · 点果汁 / 点煎蛋两条都过了（说明两次点击真的落到了画布的桶上、playCook 真的跑了）；
     · 但紧接着「同一食材 300ms 节流」那三下里，**第一下也被节流了**（juice 1 → 1、throttle=2）。
   节流判据是 `st.elapsed - cookLast[foodId] < 0.3`，两次点击之间明明 `await sleep(320)`。
   所以要么游戏时钟没在走（rAF 被挂起 / 局已经不 running），要么重启那一步没真的把局面拉回来。
   这两种可能必须用**数据**分开，不能靠猜 —— 于是在 ⑥ 里加了：
     · 点击前 / 320ms 后各读一次 state().elapsed 与 running
     · 断言「时钟确实在走」（这本身就是一条该有的验收：真浏览器里真的有帧在推）
    重启函数里也补一步：把 `#bfGame` 覆盖层的 `on` 加回来 ——
   `Breakfast.dispose()` 会 hideOverlayOf() 把覆盖层摘掉，重开一局后画布虽然建好了，
   但 layout 是 0×0，命中框全部退化，点击会落到 (0,0)。

   用法：
     node tools/bf/_patch/build_jobs_bf9_e2e_fix3.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_e2e_fix3.json --fresh-bak
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

/* ① ⑥ 的重开函数：重开之后把覆盖层加回来（否则画布 layout 是 0×0）*/
J(String.raw`    function ensureRunning(){
      if (d.state().running) return "running";
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      return "restarted";
    }`,
String.raw`    function showOverlay(){
      var o = document.getElementById("bfGame");
      if (o && o.classList) o.classList.add("on");
    }
    function ensureRunning(){
      var st = d.state();
      if (st && st.running) return "running";
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      showOverlay();          // dispose() 会把覆盖层摘掉 → 不补回来画布就是 0×0，点击全落空
      return "restarted";
    }`);

/* ② ⑥ 的主流程：加时钟探针（e0/e1）+ 重开后补覆盖层 */
J(String.raw`    var mode = ensureRunning();
    for (var i = 0; i < 9; i++) d.trashCol(i);          // 清空 9 列，保证点得下去
    d.setSound(true);
    d.clearAudio();
    var r1 = clickBox(window.Breakfast.bucketBox(8));    // 果汁机那一桶
    await sleep(150);`,
String.raw`    var mode = ensureRunning();
    for (var i = 0; i < 9; i++) d.trashCol(i);          // 清空 9 列，保证点得下去
    d.setSound(true);
    d.clearAudio();
    var e0 = d.state().elapsed;
    var r1 = clickBox(window.Breakfast.bucketBox(8));    // 果汁机那一桶
    await sleep(150);`);

J(String.raw`    await sleep(320);                                   // 离开 300ms 节流窗口
    var r2 = clickBox(window.Breakfast.bucketBox(3));    // 煎蛋那一桶
    await sleep(150);`,
String.raw`    await sleep(320);                                   // 离开 300ms 节流窗口
    var e1 = d.state().elapsed;                         // 时钟真的在走吗（节流判据用的是它）
    var r2 = clickBox(window.Breakfast.bucketBox(3));    // 煎蛋那一桶
    await sleep(150);
    var e2 = d.state().elapsed;`);

J(String.raw`    return JSON.stringify({ mode: mode, rc:[r1, r2], juice: juice.length, juiceFood: juiceFood,`,
String.raw`    return JSON.stringify({ mode: mode, rc:[r1, r2], juice: juice.length, juiceFood: juiceFood,
                            e0: e0, e1: e1, e2: e2, running: !!d.state().running,
                            cvW: (function(){ var c = document.querySelector("canvas.bf-cv");
                                              return c ? Math.round(c.getBoundingClientRect().width) : -1; })(),`);

/* ③ ⑦ 的重开也补覆盖层 */
J(String.raw`    var st0 = d.state();
    if (!st0 || !st0.running) {                                   // 上一局打完了 → 用超长局重开
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      await sleep(400);
    }`,
String.raw`    var st0 = d.state();
    if (!st0 || !st0.running) {                                   // 上一局打完了 → 用超长局重开
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      var ov = document.getElementById("bfGame");                 // dispose 摘掉的覆盖层要补回来
      if (ov && ov.classList) ov.classList.add("on");
      await sleep(400);
    }`);

/* ④ ⑤ 的重开同样补覆盖层（那里也要真点/真跑）*/
J(String.raw`    function restartLong(){
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      return true;
    }`,
String.raw`    function restartLong(){
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      var ov = document.getElementById("bfGame");     // dispose() 顺手摘掉了覆盖层，补回来
      if (ov && ov.classList) ov.classList.add("on");
      await sleep(300);                               // 让新局真的跑几帧（顾客要进来）
      return true;
    }`);

/* ⑤ 断言里带上诊断数据 */
J(String.raw`  A(jc.juice === 1, "真浏览器：点「果汁」桶 → 真的播了 audio/bf/cook_juice.mp3",
    "juice=" + jc.juice + " · 锅里=" + jc.juiceFood + " · " + JSON.stringify(jc.plays || []));`,
String.raw`  A(jc.juice === 1, "真浏览器：点「果汁」桶 → 真的播了 audio/bf/cook_juice.mp3",
    "juice=" + jc.juice + " · 锅里=" + jc.juiceFood + " · mode=" + jc.mode +
    " · 画布宽=" + jc.cvW + " · " + JSON.stringify(jc.plays || []));
  A(jc.e1 > jc.e0 && jc.e2 >= jc.e1 && jc.running === true,
    "真浏览器：这一局的时钟真的在走（rAF 在推帧，节流判据才成立）",
    "elapsed " + jc.e0 + " → " + jc.e1 + " → " + jc.e2 + " · running=" + jc.running + " · mode=" + jc.mode);`);

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
fs.writeFileSync(path.join(__dirname, "jobs_bf9_e2e_fix3.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_e2e_fix3.json：" + jobs.length + " 个 job");
