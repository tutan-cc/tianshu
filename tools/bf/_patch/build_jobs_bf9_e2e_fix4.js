/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_e2e_fix4.js — e2e 改用**游戏时钟**推进，不再赌墙钟

   上一跑拿到了决定性数据：
       真浏览器：这一局的时钟真的在走  [elapsed 2 → 2.1 → 2.1 · running=true · mode=running]
   也就是说：真实时间过了约 470ms，**游戏内只走了 0.1s** —— 这台 headless Chrome 里的 rAF
   只有墙钟的 ~1/5 速度（无头浏览器对不可见标签页的帧率限制）。
   于是「await sleep(320) 之后再点同一样」在游戏时钟上只隔了 0.1s → 被 300ms 节流挡住，
   看起来像 bug，其实是**测试自己错用了墙钟**（节流判据用的是 st.elapsed）。

   修法：所有「需要游戏时间流逝」的地方改用 debug.tick(dt)（真浏览器里同样可用，
   与无头用例是同一套口径），墙钟只留给「等页面真的跑起来」这种场合。
     ⑥ 过 300ms 节流窗口：await sleep(320) → d.tick(0.4)
     ⑤ 上餐循环：await sleep(90) → d.tick(0.12)；没人时 await sleep(120) → d.tick(0.5)
     ⑦ 等煎蛋熟：Date.now() 轮询 → 直接 d.tick(1/60) 推到落盘（与无头同款）
   ⑥ 的「时钟真的在走」探针保留（那是一条该有的验收）。

   用法：
     node tools/bf/_patch/build_jobs_bf9_e2e_fix4.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_e2e_fix4.json --fresh-bak
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

/* ── ① ⑥：过 300ms 节流窗口要用游戏时钟 ────────────────────────────────── */
J(String.raw`    await sleep(320);                                   // 离开 300ms 节流窗口
    var e1 = d.state().elapsed;                         // 时钟真的在走吗（节流判据用的是它）`,
String.raw`    d.tick(0.4);                                        // ⚠ 用**游戏时钟**过 300ms 节流窗口
    var e1 = d.state().elapsed;                         // （墙钟在这台 headless 上只有 ~1/5 速，
                                                        //   赌 await sleep(320) 会被节流挡住）`);

/* ── ② ⑤：上餐循环改用 tick 推游戏时间 ─────────────────────────────────── */
J(String.raw`      if (!os.length) { await sleep(120); continue; }
      var c = os[0], want = null;
      for (var i = 0; i < c.order.length; i++) if (c.done.indexOf(c.order[i]) < 0) { want = c.order[i]; break; }
      if (!want) { await sleep(80); continue; }
      var col = d.columnOf(want), s = d.stations()[col];
      if (!s.food && !s.plate) d.drop(want, col);
      await sleep(90);
      var s2 = d.stations()[col];`,
String.raw`      if (!os.length) { d.tick(0.5); continue; }           // 没人 → 用游戏时钟等新顾客进店
      var c = os[0], want = null;
      for (var i = 0; i < c.order.length; i++) if (c.done.indexOf(c.order[i]) < 0) { want = c.order[i]; break; }
      if (!want) { d.tick(0.2); continue; }
      var col = d.columnOf(want), s = d.stations()[col];
      if (!s.food && !s.plate) d.drop(want, col);
      d.tick(0.12);                                        // 用游戏时钟推（墙钟只有 ~1/5 速）
      var s2 = d.stations()[col];`);

/* ── ③ ⑦：等煎蛋熟/落盘也改用 tick 推进 ───────────────────────────────── */
J(String.raw`    var col = d.columnOf("egg");
    if (!d.stations()[col].plate && !d.stations()[col].food) d.drop("egg", col);
    var t0 = Date.now();
    while (Date.now() - t0 < 8000 && !d.stations()[col].plate) await sleep(70);
    var plated = !!d.stations()[col].plate;`,
String.raw`    var col = d.columnOf("egg");
    if (!d.stations()[col].plate && !d.stations()[col].food) d.drop("egg", col);
    /* 用游戏时钟把这份煎蛋推到落盘（与无头用例同一口径；墙钟在这里只有 ~1/5 速） */
    for (var k = 0; k < 400 && !d.stations()[col].plate; k++) d.tick(1 / 60);
    var plated = !!d.stations()[col].plate;`);

/* ── ④ ⑦：清场也用游戏时钟（让顾客真的走掉、位置腾出来）────────────────── */
J(String.raw`    d.orders().forEach(function(o){ d.setPatience(o.id, 0); });   // 先让场上的人走光
    await sleep(500);`,
String.raw`    d.orders().forEach(function(o){ d.setPatience(o.id, 0); });   // 先让场上的人走光
    d.tick(0.6);                                                  // 用游戏时钟推他们离场`);

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
fs.writeFileSync(path.join(__dirname, "jobs_bf9_e2e_fix4.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_e2e_fix4.json：" + jobs.length + " 个 job");
