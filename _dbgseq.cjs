/* 一次性调试：只记方法名、每步 try/catch，定位 drawArcade 后半段为何不执行。 */
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

const names = ["save", "restore", "translate", "scale", "setTransform", "clip",
               "fillRect", "strokeRect", "arc", "fill", "stroke"];
const seq = [];
for (const n of names) {
  const raw = g[n];
  if (typeof raw !== "function") { console.log("!! ctx." + n + " 不是函数"); continue; }
  g[n] = function () { seq.push(n); return raw.apply(g, arguments); };
}
console.log("包装完成，共 " + names.length + " 个方法");

S.SPRITES.puncher = null; S.SPRITES.brawler = null;
S.begin({ getContext: () => g, width: 1680, height: 900, addEventListener(){}, removeEventListener(){} });
S.running = false;
S.arcadeOn = false; S.arcade = 0; S.arcadeMode = true;

const rawArcade = S.drawArcade;
S.drawArcade = function (gg) {
  const mark = seq.length;
  let err = null;
  try { rawArcade.call(this, gg); } catch (e) { err = e; }
  console.log("\ndrawArcade 期间调用序列(" + (seq.length - mark) + " 次): " +
    seq.slice(mark).join(" → "));
  if (err) console.log("!! 抛异常: " + err.message + "\n" + (err.stack || "").split("\n").slice(1, 5).join("\n"));
};

seq.length = 0;
S.frameOnce();
console.log("\n整帧调用总数 " + seq.length);
