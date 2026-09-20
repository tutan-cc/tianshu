/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_ellipse_test.js — 给 ellipse polyfill 补「可用 + 幂等 + 不动原生」的断言

   ① breakfast.js：把 installEllipsePolyfill 挂到 rules 上（供单测直接调，
      不用为了测它去搭一个 canvas）。
   ② tests/breakfast.test.cjs：新增一条用例，钉住四件事 ——
        · 缺 ellipse 的 ctx 装上之后真的能画（整圆 = 4 段贝塞尔、端点落在圆上、闭合）
        · 椭圆 + rotation 的端点落在旋转后的椭圆上（不是随便糊一段曲线）
        · 幂等：装第二次返回 false；**原生有 ellipse 就一个字节都不改**
        · 半径 0 / 负半径 / 半圈 / counterclockwise 都不抛错且段数正确
      「Chrome/Edge 外观不变」正是靠第三条（原生分支完全没被碰过）来保证的。

   用法：
     node tools/bf/_patch/build_jobs_bf9_ellipse_test.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_ellipse_test.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const jobs = [];
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function J(file, from, text) { jobs.push({ file, from, to: null, text }); }

/* ① rules 上暴露 polyfill */
J("breakfast.js",
`    BURNT_LIFE_MS: BURNT_LIFE_MS, DOUBLE_MS: DOUBLE_MS,`,
`    BURNT_LIFE_MS: BURNT_LIFE_MS, DOUBLE_MS: DOUBLE_MS,
    /* 绘制兼容层（IE11/Trident 没有 Canvas2D.ellipse）：幂等，原生有就一个字节都不改 */
    installEllipsePolyfill: installEllipsePolyfill,`);

/* ② 单测 */
const TEST = `test("兼容：IE11/Trident 没有 Canvas2D.ellipse → 幂等 polyfill（原生有就一个字节都不改）", () => {
  /* 事故背景：tools/e2e/bf.js 的模式 B 探针跑在 mshta(Trident/IE11) 里，
     实测弹「对象不支持 ellipse 属性或方法」的脚本错误对话框（breakfast.js 行 2387）。
     项目约束是「ES5 + IE11 也能画」，所以补了贝塞尔版 polyfill。 */
  assert.equal(typeof R.installEllipsePolyfill, "function", "polyfill 暴露在 rules 上供测试直调");

  function mkCtx(hasEllipse) {
    const c = { moved: [], segs: [], bez: 0, ellipseCalls: 0 };
    c.moveTo = (x, y) => c.moved.push([x, y]);
    c.bezierCurveTo = (a, b, d, e, f, g) => { c.bez++; c.segs.push([[a, b], [d, e], [f, g]]); };
    if (hasEllipse) c.ellipse = function () { c.ellipseCalls++; };
    return c;
  }

  /* ① 装上之后真的能画：整圆 = 4 段（每段 ≤90°），起点/终点都在 (x+rx, y)，闭合 */
  const c1 = mkCtx(false);
  assert.equal(R.installEllipsePolyfill(c1), true, "缺 ellipse → 装上");
  assert.equal(typeof c1.ellipse, "function");
  c1.ellipse(10, 20, 30, 30, 0, 0, Math.PI * 2);
  assert.equal(c1.bez, 4, "整圆 = 4 段三次贝塞尔");
  assert.ok(Math.abs(c1.moved[0][0] - 40) < 1e-9 && Math.abs(c1.moved[0][1] - 20) < 1e-9,
    "起点 = θ=0 的点 (x+rx, y)：" + JSON.stringify(c1.moved[0]));
  const last = c1.segs[3][2];
  assert.ok(Math.abs(last[0] - 40) < 1e-9 && Math.abs(last[1] - 20) < 1e-9, "最后一段回到起点（闭合）");
  c1.segs.forEach(s => {
    const p = s[2], d = Math.hypot(p[0] - 10, p[1] - 20);
    assert.ok(Math.abs(d - 30) < 1e-6, "每个端点都落在圆上（半径 " + d.toFixed(6) + "）");
  });
  /* 控制点也要落在「圆外一点」的合理位置（kappa ≈ 0.5523 的经典近似值）*/
  const k = Math.abs(c1.segs[0][0][0] - 40);
  assert.ok(k > 0.5 && k < 0.6, "第一段控制点偏移 ≈ 0.5523·r（贝塞尔近似系数）：" + k.toFixed(4));

  /* ② 幂等 + 绝不覆盖原生（＝ Chrome/Edge 的外观与行为完全不变）*/
  assert.equal(R.installEllipsePolyfill(c1), false, "装第二次 → false，不重复包装");
  const c2 = mkCtx(true);
  assert.equal(R.installEllipsePolyfill(c2), false, "原生有 ellipse → 不动它");
  c2.ellipse(0, 0, 1, 1, 0, 0, 1);
  assert.equal(c2.ellipseCalls, 1, "调用仍然走原生");
  assert.equal(c2.bez, 0, "没有偷偷替换成贝塞尔");

  /* ③ 椭圆 + rotation：端点落在**旋转后**的椭圆上（不是随便糊一段曲线）*/
  const c3 = mkCtx(false); R.installEllipsePolyfill(c3);
  c3.ellipse(0, 0, 40, 10, Math.PI / 2, 0, Math.PI * 2);
  assert.equal(c3.bez, 4, "椭圆整圈同样是 4 段");
  c3.segs.forEach(s => {
    const p = s[2];
    /* 长轴 40、短轴 10、再转 90° → (x/10)² + (y/40)² = 1 */
    const v = Math.pow(p[0] / 10, 2) + Math.pow(p[1] / 40, 2);
    assert.ok(Math.abs(v - 1) < 1e-6, "落在旋转后的椭圆上（值 " + v.toFixed(9) + "）");
  });

  /* ④ 边界：半径 0 / 负半径 / 半圈 / counterclockwise */
  const c4 = mkCtx(false); R.installEllipsePolyfill(c4);
  assert.doesNotThrow(() => c4.ellipse(0, 0, 0, 5, 0, 0, Math.PI * 2), "半径 0 不抛错");
  assert.equal(c4.bez, 0, "半径 0 → 什么都不加进路径（与原生一致）");
  assert.doesNotThrow(() => c4.ellipse(0, 0, -5, -5, 0, 0, Math.PI * 2), "负半径按绝对值处理（不抛错）");
  assert.equal(c4.bez, 4, "负半径照样画出整圆");
  c4.bez = 0;
  c4.ellipse(0, 0, 5, 5, 0, 0, Math.PI);
  assert.equal(c4.bez, 2, "半圈 = 2 段");
  c4.bez = 0;
  c4.ellipse(0, 0, 5, 5, 0, 0, -Math.PI, true);
  assert.equal(c4.bez, 2, "顺时针半圈 = 2 段");
  /* ⑤ 没有 bezierCurveTo 的环境（极简替身）→ 明确返回 false，不许抛 */
  const c5 = { moveTo() {} };
  assert.equal(R.installEllipsePolyfill(c5), false, "画不了的环境返回 false（不硬装）");
  assert.equal(R.installEllipsePolyfill(null), false, "传 null 也安全");
});

`;

const src = fs.readFileSync(path.join(OUT, "tests/breakfast.test.cjs"), "utf8");
const anchor = `test("下锅音效④：9 样食材各有各的文件，点哪样响哪样（映射逐条对）", () => {`;
if (countOcc(src, anchor) !== 1) { console.error("✗ 测试插入锚点不唯一"); process.exit(1); }
J("tests/breakfast.test.cjs", anchor, TEST + anchor);

/* 落盘：锚点行尾逐个核对（两个文件各自核） */
const cache = {};
jobs.forEach((job, i) => {
  if (!cache[job.file]) cache[job.file] = fs.readFileSync(path.join(OUT, job.file), "utf8");
  const s = cache[job.file];
  if (countOcc(s, job.from) === 1) return;
  const c = crlf(job.from), ct = crlf(job.text);
  if (countOcc(s, c) === 1) { job.from = c; job.text = ct; return; }
  console.error("✗ job#" + (i + 1) + " " + job.file + " 锚点出现 " + countOcc(s, job.from) + " 次");
  process.exit(1);
});
fs.writeFileSync(path.join(__dirname, "jobs_bf9_ellipse_test.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_ellipse_test.json：" + jobs.length + " 个 job");
