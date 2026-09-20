/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_ellipse_e2e.js — 真浏览器里钉一条「polyfill 没碰原生」

   目标（用户要求）：「目标是 HTA/Trident 探针不再报错，且 **Chrome/Edge 下外观不变**」。
   最直接的证据是：Chrome 里 `CanvasRenderingContext2D.prototype.ellipse`
   **仍然是原生实现**（`String(fn)` 里带 `[native code]`）—— 也就是说 polyfill 的守卫
   `if (typeof proto.ellipse === "function") return false;` 生效，绘制调用一个字节都没变。

   （本来想直接做「改前/改后同一场景逐像素比」，但那几张正式出图里含**随机会员/随机订单**，
     PNG 哈希逐字节比对没有意义 —— 所以这里用「原生函数没被替换」+ 单测里的几何断言
     （端点严格落在椭圆上、控制点用标准 kappa）来共同证明外观一致。）

   用法：
     node tools/bf/_patch/build_jobs_bf9_ellipse_e2e.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_ellipse_e2e.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/bf/e2e-audio.js";
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
const FROM = `  /* ── 收尾 ── */
  await ev("(function(){ try{ window.__cs2.bf.close(); }catch(e){} return 1; })()");`;
const TEXT = `  /* ── ⑧ 兼容性（bf-9 补）：Chrome 里 ellipse 仍是原生实现 → 外观与行为完全不变 ──
     IE11/Trident 没有 Canvas2D.ellipse（HTA 探针会弹「对象不支持 ellipse」），
     所以 breakfast.js 装了一个幂等 polyfill；Chrome 这条路径必须**一个字节都没动**。 */
  const ellipseState = await ev(\`(function(){
    var proto = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
    if (!proto || typeof proto.ellipse !== "function") return "no-ellipse";
    return (String(proto.ellipse).indexOf("[native code]") >= 0) ? "native" : "patched";
  })()\`);
  A(ellipseState === "native",
    "Chrome：CanvasRenderingContext2D.prototype.ellipse 仍是原生实现（polyfill 只对 IE11 生效）",
    String(ellipseState));

  /* ── 收尾 ── */
  await ev("(function(){ try{ window.__cs2.bf.close(); }catch(e){} return 1; })()");`;

const src = fs.readFileSync(path.join(OUT, FILE), "utf8");
const job = { file: FILE, from: FROM, text: TEXT };
if (countOcc(src, job.from) !== 1) {
  if (countOcc(src, crlf(job.from)) === 1) { job.from = crlf(job.from); job.text = crlf(job.text); }
  else { console.error("✗ 锚点出现 " + countOcc(src, job.from) + " 次"); process.exit(1); }
}
fs.writeFileSync(path.join(__dirname, "jobs_bf9_ellipse_e2e.json"),
  JSON.stringify({ jobs: [job] }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_ellipse_e2e.json：1 个 job");
