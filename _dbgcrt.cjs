/* 一次性调试：逐层关掉 CRT 效果，定位"屏内整体偏暗"是哪一层造成的。 */
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

const rawCrt = S.drawCrt.bind(S);
const at = (x, y) => { const i = (y * 1680 + x) * 3;
  return "rgb(" + sink.px[i] + "," + sink.px[i + 1] + "," + sink.px[i + 2] + ")"; };

/* 基准：完全跳过 CRT，看屏内本来应该多亮 */
const cases = [
  ["跳过 CRT", () => { S.drawCrt = function () {}; }],
  ["全开", () => { S.drawCrt = (gg, R, lit) => rawCrt(gg, R, lit); }],
  ["只压暗关", () => { S.drawCrt = (gg, R, lit) => rawCrt(gg, R, lit, { scan: 0.14, glass: 0.05, vig: 0 }); }],
  ["只扫描线关", () => { S.drawCrt = (gg, R, lit) => rawCrt(gg, R, lit, { scan: 0, glass: 0.05, vig: 0.26 }); }],
  ["只玻璃关", () => { S.drawCrt = (gg, R, lit) => rawCrt(gg, R, lit, { scan: 0.14, glass: 0, vig: 0.26 }); }],
];
for (const [name, setup] of cases) {
  setup();
  S.frameOnce();
  console.log(name.padEnd(12) + " 屏内地板 " + at(840, 600) + "  屏内霓虹 " + at(250, 200));
}
