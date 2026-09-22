/* 一次性调试：数一次 frameOnce 里 draw / drawArcade / drawCabinet 各被调几次，并看调用栈。 */
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

let nDraw = 0, nArcade = 0, nCab = 0, nWorld = 0;
const wrap = (name, counter) => {
  const raw = S[name];
  S[name] = function () { counter(); return raw.apply(this, arguments); };
};
wrap("draw", () => nDraw++);
wrap("drawArcade", () => nArcade++);
wrap("drawCabinet", () => nCab++);
wrap("drawBackdrop", () => nWorld++);

const R = S.screenRect();
const lit = () => {
  let a = 0, t = 0;
  for (let y = R.y + 20; y < R.y + R.h - 20; y += 5) for (let x = R.x + 20; x < R.x + R.w - 20; x += 5) {
    const i = (y * 1680 + x) * 3; t++; if (sink.px[i] + sink.px[i + 1] + sink.px[i + 2] > 60) a++;
  }
  return (a / t * 100).toFixed(1) + "%";
};
S._noBezel = true;
S._probe = (n) => console.log("      [cab] " + n.padEnd(14) + " lit=" + lit());

S.frameOnce();
S._probe = null;
console.log("draw=" + nDraw + " drawArcade=" + nArcade + " drawCabinet=" + nCab +
  " drawBackdrop=" + nWorld + "  最终屏内 lit=" + lit());
