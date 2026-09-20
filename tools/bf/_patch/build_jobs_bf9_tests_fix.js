/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_tests_fix.js — 修上一步新断言里的两处坑

   跑完 jobs_bf9_tests.json 之后还剩 2 条红，都是**新写的断言自己**的问题（不是源码问题）：

   ① 浮点边界：`2.2 + 0.7 === 2.9000000000000004`，所以字面量 `2.9` 仍然落在
      「s < dur+pw」这一侧 → cookState 返回 perfect，而不是预期的 over。
      （旧表的 3.0+0.8 恰好等于字面量 3.8，所以老用例没暴露这个问题。）
      修法：边界值一律用 `Food.dur + Food.pw` 这样**算出来**的数，另外单独断言
      「算出来的边界与设计值 2.9 / 3.8 相差 < 1e-9」，意图照样钉死。

   ② `cookWalk(st, "egg", "burnt")` 是按真实帧推进到糊的（≈3.8s+），
      这段时间顾客的耐心在掉 —— 所以耐心必须**在开煮之前**记下、**在上餐之前**重新摆好，
      否则断言的是「煮完糊之后剩多少」，不是「原来是多少」。

   用法：
     node tools/bf/_patch/build_jobs_bf9_tests_fix.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_tests_fix.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tests/breakfast.test.cjs";
const jobs = [];
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function J(from, text) { jobs.push({ file: FILE, from, to: null, text }); }

/* ── ① 浮点边界：用算出来的边界，另加「边界值确实等于设计值」的断言 ─────── */
J(`  assert.equal(R.cookState("egg", 2.199), "raw", "差 1ms 到 2.2 仍是生");
  assert.equal(R.cookState("egg", 2.2), "perfect", "2.2 恰好进完美窗口");
  // 窗口内部 / 右侧边界
  assert.equal(R.cookState("egg", 2.5), "perfect", "窗口正中");
  assert.equal(R.cookState("egg", 2.899), "perfect", "差 1ms 到 2.9 仍是恰好");
  assert.equal(R.cookState("egg", 2.9), "over", "2.9 出窗口 → 过火（普通分，不糊）");
  assert.equal(R.cookState("egg", 3.799), "over", "差 1ms 到 3.8 仍可端");
  assert.equal(R.cookState("egg", 3.8), "burnt", "3.8 起就是糊");
  assert.equal(R.cookState("egg", 9.0), "burnt");`,
`  assert.equal(R.cookState("egg", 2.199), "raw", "差 1ms 到 2.2 仍是生");
  assert.equal(R.cookState("egg", 2.2), "perfect", "2.2 恰好进完美窗口");
  /* ⚠ 边界值必须**算出来**再比：2.2 + 0.7 在双精度里是 2.9000000000000004，
     字面量 2.9 反而落在窗口内侧（旧表 3.0+0.8 恰好等于 3.8，所以老用例没暴露这点）。 */
  const END = F.dur + F.pw, BRN = F.dur + F.pw + F.burn;
  assert.ok(Math.abs(END - 2.9) < 1e-9, "完美窗口右界 = 2.9s（2.2 + 0.7）");
  assert.ok(Math.abs(BRN - 3.8) < 1e-9, "糊点 = 3.8s（2.2 + 0.7 + 0.9）");
  assert.equal(R.cookState("egg", 2.5), "perfect", "窗口正中");
  assert.equal(R.cookState("egg", END - 0.001), "perfect", "差 1ms 出窗口仍是恰好");
  assert.equal(R.cookState("egg", END), "over", "出窗口 → 过火（普通分，不糊）");
  assert.equal(R.cookState("egg", BRN - 0.001), "over", "差 1ms 到糊点仍可端");
  assert.equal(R.cookState("egg", BRN), "burnt", "到糊点就是糊");
  assert.equal(R.cookState("egg", 9.0), "burnt");`);

/* ── ② 糊菜那条：耐心在「煮到糊」的过程中会掉，断言前要重新摆好 ─────────── */
J(`  st = plateState();
  const cb = R.spawnCustomer(st, ["egg", "juice"]);
  cb.patienceMax = 30; cb.patience = 12;
  const colB = cookWalk(st, "egg", "burnt");
  assert.equal(R.takePlate(st, colB), true, "糊的也能落到盘上");`,
`  st = plateState();
  const cb = R.spawnCustomer(st, ["egg", "juice"]);
  cb.patienceMax = 30;
  const colB = cookWalk(st, "egg", "burnt");     // ⚠ 这一段按真实帧推进 ≈3.8s+，耐心会掉
  cb.patience = 12;                              // 所以耐心要摆到「上餐前一刻」再定值
  assert.equal(R.takePlate(st, colB), true, "糊的也能落到盘上");`);

/* ── 落盘：锚点行尾逐个核对（同前一个脚本）───────────────────────────── */
const src = fs.readFileSync(path.join(OUT, FILE), "utf8");
jobs.forEach((job, i) => {
  if (countOcc(src, job.from) === 1) return;
  const c = crlf(job.from), ct = crlf(job.text);
  if (countOcc(src, c) === 1) { job.from = c; job.text = ct; return; }
  console.error("✗ job#" + (i + 1) + " 锚点出现 " + countOcc(src, job.from) + " 次（CRLF 版 " +
    countOcc(src, c) + " 次）");
  process.exit(1);
});
fs.writeFileSync(path.join(__dirname, "jobs_bf9_tests_fix.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_tests_fix.json：" + jobs.length + " 个 job");
