/* 一次性调试：打印一次机内帧里 drawArcade 相关的全部 canvas 操作与变换矩阵。 */
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
let depth = 0, log = [], on = false;
const wrap = (name, tag) => {
  const raw = g[name].bind(g);
  g[name] = function () {
    if (on) {
      const m = g.__m();
      log.push("  ".repeat(Math.max(0, depth)) + tag + " " + name +
        "  m=[" + m.map((v) => (+v).toFixed(1)).join(",") + "]");
    }
    if (name === "save") depth++;
    const r = raw.apply(g, arguments);
    if (name === "restore") depth--;
    return r;
  };
};
for (const n of ["save", "restore", "translate", "scale", "setTransform", "clip", "fillRect", "strokeRect", "arc"]) wrap(n, "·");

const rawArcade = S.drawArcade.bind(S);
S.drawArcade = function (gg) {
  on = true; log.length = 0; log.push("--- drawArcade 开始 ---");
  console.log("drawArcade: arcadeMode=" + S.arcadeMode + " arcadeOn=" + S.arcadeOn +
    " arcade=" + S.arcade + " typeof drawCabinet=" + typeof S.drawCabinet +
    " typeof screenRect=" + typeof S.screenRect);
  let r;
  try { r = rawArcade(gg); }
  catch (e) { console.log("!! drawArcade 抛异常: " + e.message + "\n" +
    (e.stack || "").split("\n").slice(1, 4).join("\n")); }
  log.forEach((l) => console.log(l));
  log.length = 0; on = false;
  return r;
};
/* 直接点名调一次，绕开所有早退条件 */
try {
  console.log("\n[直调] drawCabinet(g, 1, 1)：");
  on = true;
  S.drawCabinet(g, 1, 1);
} catch (e) { console.log("!! drawCabinet 抛异常: " + e.message + "\n" +
    (e.stack || "").split("\n").slice(1, 5).join("\n")); }
log.forEach((l) => console.log(l)); log.length = 0; on = false;

S.SPRITES.puncher = null; S.SPRITES.brawler = null;
S.begin({ getContext: () => g, width: 1680, height: 900, addEventListener(){}, removeEventListener(){} });
S.running = false;
S.arcadeOn = false; S.arcade = 0; S.arcadeMode = true;
S.frameOnce();

console.log("transform 相关操作共 " + log.length + " 条；drawArcade 段落如下：");
const i = log.findIndex((l) => l.indexOf("drawArcade 开始") >= 0);
log.slice(i).slice(0, 24).forEach((l) => console.log(l));
