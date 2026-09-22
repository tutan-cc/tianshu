/* 一次性调试：量"机身区带"的亮度，确认黑底到底画到了哪里。 */
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
S.running = false; S.arcadeOn = false; S.arcade = 0; S.arcadeMode = true;

const R = S.screenRect();
const zone = (x0, y0, x1, y1, step) => {
  let lit = 0, tot = 0;
  for (let y = y0; y < y1; y += (step || 2)) for (let x = x0; x < x1; x += (step || 2)) {
    const i = (y * 1680 + x) * 3; tot++;
    if (sink.px[i] + sink.px[i + 1] + sink.px[i + 2] > 60) lit++;
  }
  return (lit / tot * 100).toFixed(1) + "%";
};

S._probe = (n) => {
  console.log("  [" + n.padEnd(14) + "] 屏内 " + zone(R.x + 20, R.y + 20, R.x + R.w - 20, R.y + R.h - 20, 4) +
    " · 左机壳带 " + zone(R.x - 80, 200, R.x, 700, 4) +
    " · 操作台带 " + zone(R.x, R.y + R.h, R.x + R.w, 900, 4));
};
S.frameOnce();
S._probe = null;
console.log("\nscreenRect = " + JSON.stringify(R));
