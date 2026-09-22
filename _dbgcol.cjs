/* 一次性调试：量机壳各带区的实际颜色，确认立柱是不是太暗。 */
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
S.frameOnce();

const R = S.screenRect();
const at = (x, y) => { const i = (y * 1680 + x) * 3;
  return "rgb(" + String(sink.px[i]).padStart(3) + "," + String(sink.px[i + 1]).padStart(3) + "," + String(sink.px[i + 2]).padStart(3) + ")"; };
console.log("screenRect=" + JSON.stringify(R));
console.log("左立柱 x=100/112/126/140/150 y=450 : " + [100, 112, 126, 140, 150].map((x) => at(x, 450)).join(" "));
console.log("右立柱 x=1530/1544/1560/1580 y=450: " + [1530, 1544, 1560, 1580].map((x) => at(x, 450)).join(" "));
console.log("顶板带  y=20/45/70  x=840         : " + [20, 45, 70].map((y) => at(840, y)).join(" "));
console.log("遮罩区  y=78  x=300/840/1400      : " + [300, 840, 1400].map((x) => at(x, 78)).join(" "));
console.log("操作台  y=800/860  x=840          : " + [800, 860].map((y) => at(840, y)).join(" "));
console.log("操作台上沿 y=769..790 x=400       : " + [769, 775, 782, 790].map((y) => at(400, y)).join(" "));
