/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_e2e_fix6.js — e2e 第六轮

   ① ⑥ 的节流用例：诊断数据说明白了 ——
        台账尾 ["cook_juice:ok","cook_egg:ok","cook_juice:busy","cook_juice:busy"]
      两次点击被**并发上限 2** 挡住（不是被 300ms 节流挡的）：前两条的「占线」窗口是
      COOK_TAIL_SEC = 0.7s，而我只用 `d.tick(0.4)` 推了 0.4s 游戏时间。
      → 改成 `d.tick(0.8)`：既过了 300ms 同食材窗口，也把并发额度腾出来。
        这样第三下才会走到「同食材 300ms 节流」那条分支（正是这条用例要验的）。

   ② ⑤ 上餐那句：headless 里 rAF 只有墙钟 ~1/5 速，「边等边推」的轮询循环太脆
      （20 秒墙钟预算、还要赌顾客进店 + 列不被占）。⑦ 已经证明「自己造顾客 + tick 推到落盘 +
      真实点盘」这条确定性路子稳，于是把 ⑤ 也改成同一套确定性写法：
      重开一局（超长局）→ pushCustomer → 一路 tick 做出来 → serveCol → 断言恰好一条欢呼。

   用法：
     node tools/bf/_patch/build_jobs_bf9_e2e_fix6.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_e2e_fix6.json --fresh-bak
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

/* ── ① ⑥：0.4 → 0.8（同时腾出并发额度）────────────────────────────────── */
J(String.raw`    d.tick(0.4);                                        // ⚠ 用**游戏时钟**过 300ms 节流窗口
    var e1 = d.state().elapsed;                         // （墙钟在这台 headless 上只有 ~1/5 速，
                                                        //   赌 await sleep(320) 会被节流挡住）`,
String.raw`    d.tick(0.8);                                        // ⚠ 用**游戏时钟**：0.8s 同时满足两件事 ——
                                                        //   · 过了同食材 300ms 节流窗口
                                                        //   · 前两条的占线窗口（COOK_TAIL_SEC 0.7s）也过期，
                                                        //     并发额度腾出来，第三下才验得到"节流"而不是"busy"
    var e1 = d.state().elapsed;`);

/* ── ② ⑤：改成确定性写法（与 ⑦ 同一套）──────────────────────────────── */
J(String.raw`    d.clearAudio();
    var t0 = Date.now(), served = false, tries = 0, restarts = 0;
    while (Date.now() - t0 < 20000 && !served && tries++ < 400) {
      var st0 = d.state();
      if (!st0 || !st0.running) { restartLong(); restarts++; await sleep(400); continue; }
      var os = d.orders();
      os.forEach(function(o){ d.setPatience(o.id, 0.95); });     // 这一段别让人跑单
      /* 没人就自己 push 一个：headless 里 rAF 只有墙钟 ~1/5 速，
         「等顾客随机进店」会把 20 秒预算全耗在等上面（实测 orders 一直为空）。*/
      if (!os.length) { d.pushCustomer(); d.tick(0.2); continue; }
      var c = os[0], want = null;
      for (var i = 0; i < c.order.length; i++) if (c.done.indexOf(c.order[i]) < 0) { want = c.order[i]; break; }
      if (!want) { d.tick(0.2); continue; }
      var col = d.columnOf(want), s = d.stations()[col];
      if (!s.food && !s.plate) d.drop(want, col);
      d.tick(0.12);                                        // 用游戏时钟推（墙钟只有 ~1/5 速）
      var s2 = d.stations()[col];
      if (s2.plate && s2.plateState !== "burnt") { var r = d.serveCol(col); if (r && r.ok) served = true; }
    }
    var plays = d.audio().plays;`,
String.raw`    var st0 = d.state();
    var restarts = 0;
    if (!st0 || !st0.running) { restartLong(); restarts++; }
    for (var i = 0; i < 9; i++) d.trashCol(i);          // 清空 9 列，保证下得去料
    d.clearAudio();
    /* 自己造一位顾客（别赌随机进店：headless 里 rAF 只有墙钟 ~1/5 速），
       再用游戏时钟把这一单做出来 —— 与 ⑦ 同一套确定性写法。 */
    var id = d.pushCustomer();
    var served = false, steps = 0;
    for (; steps < 900 && !served; steps++) {
      var o = d.orders().filter(function(x){ return x.id === id; })[0];
      if (!o) { id = d.pushCustomer(); d.setPatience(id, 0.95); continue; }
      d.setPatience(id, 0.95);                          // 这一段别让他跑单
      var want = null;
      for (var j = 0; j < o.order.length; j++) if (o.done.indexOf(o.order[j]) < 0) { want = o.order[j]; break; }
      if (!want) { served = true; break; }              // 整单做齐 → 也算走完一次上餐
      var col = d.columnOf(want), s = d.stations()[col];
      if (s.plate && s.plateState === "burnt") d.trashCol(col);      // 糊了就丢掉重来
      if (!s.food && !s.plate) d.drop(want, col);
      d.tick(1 / 60);
      var s2 = d.stations()[col];
      if (s2.plate && s2.plateState !== "burnt") { var r = d.serveCol(col); if (r && r.ok) served = true; }
    }
    var plays = d.audio().plays;`);

J(String.raw`    return JSON.stringify({ served: served, restarts: restarts,
                            n: plays.filter(function(p){ return /happy_v[1-6]\\.mp3$/.test(p.url); }).length,
                            plays: plays });
  })()` + "`" + String.raw`);`,
String.raw`    return JSON.stringify({ served: served, restarts: restarts, steps: steps,
                            n: plays.filter(function(p){ return /happy_v[1-6]\\.mp3$/.test(p.url); }).length,
                            running: !!(d.state() && d.state().running),
                            plays: plays });
  })()` + "`" + String.raw`);`);

J(String.raw`  A(jh.served === true, "真浏览器里完成了一次上餐（happy 断言的前提）");`,
String.raw`  A(jh.served === true, "真浏览器里完成了一次上餐（happy 断言的前提）",
    "steps=" + jh.steps + " · restarts=" + jh.restarts + " · running=" + jh.running);`);

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
fs.writeFileSync(path.join(__dirname, "jobs_bf9_e2e_fix6.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_e2e_fix6.json：" + jobs.length + " 个 job");
