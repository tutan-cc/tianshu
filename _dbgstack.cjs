/* 一次性调试：打印 drawArcade 的调用栈与 this 身份，确认后半段为何不执行。 */
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

let calls = 0;
const raw = S.drawArcade;
S.drawArcade = function (gg) {
  calls++;
  const mine = this === S;
  console.log("\n[调用 #" + calls + "] this===S? " + mine +
    "  this.arcadeMode=" + this.arcadeMode + " this.arcadeOn=" + this.arcadeOn +
    " this.arcade=" + this.arcade);
  /* 手动把 drawArcade 的每一步走一遍，看到底哪一步之后断掉 */
  try {
    const r = raw.call(this, gg);
    console.log("  返回: " + r);
  } catch (e) {
    console.log("  !! 抛异常: " + e.message + "\n" + (e.stack || "").split("\n").slice(1, 5).join("\n"));
  }
  return undefined;
};

S.SPRITES.puncher = null; S.SPRITES.brawler = null;
S.begin({ getContext: () => g, width: 1680, height: 900, addEventListener(){}, removeEventListener(){} });
S.running = false;
S.arcadeOn = false; S.arcade = 0; S.arcadeMode = true;
console.log("准备调用 frameOnce：arcadeMode=" + S.arcadeMode);
S.frameOnce();
console.log("\nframeOnce 结束，drawArcade 被调用 " + calls + " 次");
