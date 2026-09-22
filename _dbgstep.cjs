/* 一次性调试：用 S._probe 在 drawCabinet 每段之后量屏内亮度，定位元凶。 */
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

/* 在"世界画完、机身还没画"的时刻量一次：把 drawArcade 包起来 */
const rawArcade = S.drawArcade;
S.drawArcade = function (gg) {
  console.log("  [机身之前] 屏内亮度 " + litPct());
  return rawArcade.call(this, gg);
};

S._probe = (n) => console.log("  [段] " + n.padEnd(14) + " 屏内亮度 " + litPct());
S.frameOnce();
S._probe = null;
