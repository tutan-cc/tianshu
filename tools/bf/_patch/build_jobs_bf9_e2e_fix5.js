/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_e2e_fix5.js — e2e 第五轮：补诊断 + ⑤ 自己造顾客

   上一跑剩 5 条红，两处：
     ① ⑤（上餐成功 → 播欢呼）：`d.orders()` 一直是空 —— headless 里 rAF 只有墙钟 ~1/5 速，
        「等顾客随机进店」这条路太慢。改成**场上没人就自己 pushCustomer()**，
        把这一段的重点（真浏览器里上餐 → 真播一条欢呼）交回给这条用例本身。
     ② ⑥（同食材 300ms 节流）：`juice 1 → 1 · throttle=0` —— 两次点击**既没响也没被节流**，
        说明 placeFoodEx 直接返回了 not-ok（连 playCook 都没走到）。
        这一条不能再猜，于是把诊断数据打出来：
          · 每次点击后 `stations()[8].food` 到底是什么（点到了 / 没点到 / 被拒）
          · `d.audio().log` 最后 8 条的 name+why（有没有 off/blocked/no-audio）
        下一跑按数据说话。

   用法：
     node tools/bf/_patch/build_jobs_bf9_e2e_fix5.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_e2e_fix5.json --fresh-bak
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

/* ── ① ⑤：场上没人就自己造一个（别赌随机进店）──────────────────────────── */
J(String.raw`      if (!os.length) { d.tick(0.5); continue; }           // 没人 → 用游戏时钟等新顾客进店`,
String.raw`      /* 没人就自己 push 一个：headless 里 rAF 只有墙钟 ~1/5 速，
         「等顾客随机进店」会把 20 秒预算全耗在等上面（实测 orders 一直为空）。*/
      if (!os.length) { d.pushCustomer(); d.tick(0.2); continue; }`);

/* ── ② ⑥：点击后把「锅里到底有没有东西」与「台账最后几条」带回来 ────────── */
J(String.raw`    d.trashCol(8);
    var n0 = d.audio().plays.filter(function(p){ return /cook_juice\.mp3$/.test(p.url); }).length;
    clickBox(window.Breakfast.bucketBox(8));              // 这一下响
    d.trashCol(8);
    clickBox(window.Breakfast.bucketBox(8));              // 紧接着再点 → 节流，不响
    await sleep(80);
    var n1 = d.audio().plays.filter(function(p){ return /cook_juice\.mp3$/.test(p.url); }).length;
    var thr = d.audio().log.filter(function(r){ return r.why === "throttle"; }).length;`,
String.raw`    d.trashCol(8);
    var n0 = d.audio().plays.filter(function(p){ return /cook_juice\.mp3$/.test(p.url); }).length;
    clickBox(window.Breakfast.bucketBox(8));              // 这一下响
    var f1 = d.stations()[8].food;                        // 诊断：这一下真的下锅了吗
    d.trashCol(8);
    clickBox(window.Breakfast.bucketBox(8));              // 紧接着再点 → 节流，不响
    var f2 = d.stations()[8].food;                        // 诊断：第二下呢
    await sleep(80);
    var n1 = d.audio().plays.filter(function(p){ return /cook_juice\.mp3$/.test(p.url); }).length;
    var thr = d.audio().log.filter(function(r){ return r.why === "throttle"; }).length;
    var tail = d.audio().log.slice(-8).map(function(r){ return r.name + ":" + (r.why || "ok"); });`);

J(String.raw`                            cooks: d.state().cooks, gap: d.audio().cookGap, max: d.audio().cookMax,
                            plays: d.audio().plays.map(function(p){ return p.url; }) });`,
String.raw`                            cooks: d.state().cooks, gap: d.audio().cookGap, max: d.audio().cookMax,
                            f1: f1, f2: f2, tail: tail, on: d.audio().on,
                            plays: d.audio().plays.map(function(p){ return p.url; }) });`);

J(String.raw`  A(jc.n1 === jc.n0 + 1 && jc.throttle >= 1,
    "真浏览器：同一食材 300ms 内连点 → 只多响一声（被节流的那次留了记录）",
    "juice " + jc.n0 + " → " + jc.n1 + " · throttle=" + jc.throttle);`,
String.raw`  A(jc.n1 === jc.n0 + 1 && jc.throttle >= 1,
    "真浏览器：同一食材 300ms 内连点 → 只多响一声（被节流的那次留了记录）",
    "juice " + jc.n0 + " → " + jc.n1 + " · throttle=" + jc.throttle +
    " · 锅里 " + jc.f1 + "→" + jc.f2 + " · 开关=" + jc.on + " · 台账尾 " + JSON.stringify(jc.tail));`);

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
fs.writeFileSync(path.join(__dirname, "jobs_bf9_e2e_fix5.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_e2e_fix5.json：" + jobs.length + " 个 job");
