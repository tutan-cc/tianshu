/* 一次性调试：在 drawCabinet 的分段点上量屏内亮度，定位是哪一句把屏幕刷黑的。 */
const fs = require("fs");
const vm = require("vm");
const { readHtml, grabConst, evalConstIn, serialize } = require("./tests/lib/extract.cjs");
const { makeSink } = require("./tools/dev/canvas-sink.cjs");

const html = readHtml();
const api = new vm.Script("(function(){\n" +
  "const FIGHT2_TUNE = " + grabConst(html, "FIGHT2_TUNE") + ";\n" +
  "const Fight2Stage = " + serialize(evalConstIn(html, "Fight2Stage")) + ";\n" +
  "var document={getElementById:function(){return {style:{},dataset:{},innerHTML:\"\",textContent:\"\",\n" +
  "  classList:{add:function(){},remove:function(){},contains:function(){return false;}},\n" +
  "  addEventListener:function(){},removeEventListener:function(){}};},querySelectorAll:function(){return [];}};\n" +
  "function $(id){return document.getElementById(id);}\n" +
  "var window={addEventListener:function(){},removeEventListener:function(){}};\n" +
  "function requestAnimationFrame(){return 1;} function cancelAnimationFrame(){}\n" +
  "return { S:Fight2Stage };\n})()").runInNewContext({ console, Math });

const S = api.S;
const sink = makeSink(1680, 900, 1);
const g = sink.ctx;
S.SPRITES.puncher = null; S.SPRITES.brawler = null;
S.begin({ getContext: () => g, width: 1680, height: 900, addEventListener(){}, removeEventListener(){} });
S.running = false;
S.arcadeOn = false; S.arcade = 0; S.arcadeMode = true;

const R = S.screenRect();
function litPct() {
  let lit = 0, tot = 0;
  for (let y = R.y + 20; y < R.y + R.h - 20; y += 3)
    for (let x = R.x + 20; x < R.x + R.w - 20; x += 3) {
      const i = (y * 1680 + x) * 3; tot++;
      if (sink.px[i] + sink.px[i + 1] + sink.px[i + 2] > 60) lit++;
    }
  return (lit / tot * 100).toFixed(1) + "%";
}

/* window.__ARC_DBG 由 vm 里的 window 暴露？—— 简单起见直接给 S.drawCabinet 包一层，
   在每个分段点前后用 drawCrt/drawMarquee/drawDeck 的调用顺序推断。这里改用更直接的办法：
   逐段"空实现"替换，哪一段被换掉之后屏内亮起来，元凶就是它。 */
const cases = [
  ["原样", () => {}],
  ["去 marquee", () => { S.drawMarquee = function () {}; }],
  ["去 deck", () => { S.drawDeck = function () {}; }],
  ["去 crt", () => { S.drawCrt = function () {}; }],
];
const orig = { drawMarquee: S.drawMarquee, drawDeck: S.drawDeck, drawCrt: S.drawCrt };
for (const [name, setup] of cases) {
  S.drawMarquee = orig.drawMarquee; S.drawDeck = orig.drawDeck; S.drawCrt = orig.drawCrt;
  setup();
  S.frameOnce();
  console.log(name.padEnd(12) + " 屏内亮度 " + litPct());
}
