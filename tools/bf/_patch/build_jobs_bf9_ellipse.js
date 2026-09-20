/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_ellipse.js — IE11 / Trident 兼容：ellipse() polyfill

   事故（用户实测截图）：桌面弹出 mshta 探针窗口 + IE「脚本发生错误」对话框 ——
       行 2387 对象不支持 "ellipse" 属性或方法
       URL file:///…/breakfast.js
   `tools/e2e/bf.js` 的模式 B（Chrome 起不来时的降级）就是 mshta/Trident(IE11) 引擎，
   而 IE11 的 Canvas2D **没有 ellipse()**（这一堆调用在 breakfast.js 里早就有，
   不是本轮新加的 —— 本轮只改了时长/耐心/选人/音效，没碰绘制）。
   但项目一直有「ES5 + IE11 可跑」的约束（HTA 探针 / 老引擎降级都要能画），所以补 polyfill。

   做法：用「分段三次贝塞尔」近似椭圆弧（**不改 CTM**）——
   为什么不用 save/scale/arc/restore 那套：那个会把非等比缩放留在路径上，
   `stroke()` 的线宽会被压扁（本项目 2758 / 2760 两处就是 ellipse + stroke）。
   贝塞尔版与原生的参数语义一致（含 rotation / startAngle / endAngle / counterclockwise），
   线宽不受影响，IE11 有 bezierCurveTo。

   幂等：装之前先判 `typeof proto.ellipse === "function"`，原生有就一个字节都不改
   （所以 Chrome / Edge / 无头假 canvas 的行为与外观**完全不变**）。

   安装点两处：
     · 模块级：真的存在 CanvasRenderingContext2D.prototype 时装上（浏览器）
     · start() 里拿到 g 之后：再对实例装一次（覆盖「原型够不到 / 传进来的是替身 ctx」）

   用法：
     node tools/bf/_patch/build_jobs_bf9_ellipse.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_ellipse.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "breakfast.js";
const jobs = [];
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function J(from, text) { jobs.push({ file: FILE, from, to: null, text }); }

/* ① polyfill 本体 + 模块级安装（放在 roundRect 前面，绘制工具区）*/
J(`  function roundRect(g, x, y, w, h, r) {`,
`  /* ── Canvas2D.ellipse 的 polyfill（IE11 / Trident 没有这个 API）──────────────
     背景：tools/e2e/bf.js 的模式 B 探针跑在 mshta(Trident/IE11) 里，
     实测会弹「对象不支持 ellipse 属性或方法」的脚本错误对话框（行 2387）。
     项目约束是「ES5 + IE11 也要能画」，所以这里补一个等价实现。

     实现：把椭圆弧按 ≤90° 分段，用**三次贝塞尔**逼近（k = 4/3·tan(Δ/4)）。
       · 不改 CTM（不用 save/scale/arc/restore）—— 那套会把非等比缩放留在路径上，
         stroke() 的线宽会被压扁；本项目有 ellipse + stroke 的用法。
       · 参数语义与原生一致：rotation（弧度）、startAngle / endAngle、counterclockwise。
       · 半径为 0 / NaN 时直接返回（与原生「什么都不加进路径」一致，也避免 IE 上 arc 抛错）。
     幂等：原生有 ellipse 就原样不动 —— Chrome / Edge / 无头假 canvas 的外观与行为完全不变。 */
  var ELLIPSE_K = 4 / 3;
  function installEllipsePolyfill(proto) {
    if (!proto) return false;
    if (typeof proto.ellipse === "function") return false;          // 原生已有 → 绝不覆盖
    if (typeof proto.bezierCurveTo !== "function" || typeof proto.moveTo !== "function") return false;
    proto.ellipse = function (x, y, rx, ry, rot, a0, a1, ccw) {
      var rxa = Math.abs(Number(rx) || 0), rya = Math.abs(Number(ry) || 0);
      if (!(rxa > 0) || !(rya > 0)) return;
      x = Number(x) || 0; y = Number(y) || 0;
      rot = Number(rot) || 0;
      a0 = Number(a0) || 0; a1 = Number(a1) || 0;
      var delta = a1 - a0;
      if (ccw) { if (delta > 0) delta -= Math.PI * 2; if (delta < -Math.PI * 2) delta = -Math.PI * 2; }
      else { if (delta < 0) delta += Math.PI * 2; if (delta > Math.PI * 2) delta = Math.PI * 2; }
      if (!delta) return;
      var n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
      var step = delta / n, k = ELLIPSE_K * Math.tan(step / 4);
      var cs = Math.cos(rot), sn = Math.sin(rot);
      /* 椭圆上的点（先算局部坐标，再按 rotation 旋转、平移到 x/y）*/
      function px(u, v) { return x + u * cs - v * sn; }
      function py(u, v) { return y + u * sn + v * cs; }
      var s0 = a0;
      this.moveTo(px(rxa * Math.cos(s0), rya * Math.sin(s0)),
                  py(rxa * Math.cos(s0), rya * Math.sin(s0)));
      for (var i = 0; i < n; i++) {
        var s = a0 + i * step, e = s + step;
        var cx1 = rxa * Math.cos(s), cy1 = rya * Math.sin(s);
        var cx2 = rxa * Math.cos(e), cy2 = rya * Math.sin(e);
        /* 导数（切线）：d/dθ (rx·cosθ, ry·sinθ) = (-rx·sinθ, ry·cosθ) */
        var t1u = -rxa * Math.sin(s), t1v = rya * Math.cos(s);
        var t2u = -rxa * Math.sin(e), t2v = rya * Math.cos(e);
        var c1u = cx1 + k * t1u, c1v = cy1 + k * t1v;
        var c2u = cx2 - k * t2u, c2v = cy2 - k * t2v;
        this.bezierCurveTo(px(c1u, c1v), py(c1u, c1v),
                           px(c2u, c2v), py(c2u, c2v),
                           px(cx2, cy2), py(cx2, cy2));
      }
    };
    return true;
  }
  /* 模块级先装一次（浏览器里 CanvasRenderingContext2D.prototype 一定在）*/
  (function () {
    try {
      installEllipsePolyfill(root.CanvasRenderingContext2D && root.CanvasRenderingContext2D.prototype);
    } catch (e) {}
  })();

  function roundRect(g, x, y, w, h, r) {`);

/* ② start() 里拿到 ctx 之后再对实例装一次（原型够不到 / 替身 ctx 的场合）*/
J(`    var g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);`,
`    var g = cv.getContext("2d");
    installEllipsePolyfill(g);            // IE11/Trident 没有 ellipse：这里再兜一次（幂等）
    g.setTransform(dpr, 0, 0, dpr, 0, 0);`);

const src = fs.readFileSync(path.join(OUT, FILE), "utf8");
jobs.forEach((job, i) => {
  if (countOcc(src, job.from) === 1) return;
  const c = crlf(job.from), ct = crlf(job.text);
  if (countOcc(src, c) === 1) { job.from = c; job.text = ct; return; }
  console.error("✗ job#" + (i + 1) + " 锚点出现 " + countOcc(src, job.from) + " 次（CRLF 版 " +
    countOcc(src, c) + " 次）：" + JSON.stringify(job.from.slice(0, 70)));
  process.exit(1);
});
fs.writeFileSync(path.join(__dirname, "jobs_bf9_ellipse.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_ellipse.json：" + jobs.length + " 个 job");
