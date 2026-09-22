/* 一次性调试：只画一帧 Fight2Stage（机内模式）导出 PNG，用来确认机身到底画在哪。 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { readHtml, grabFn, grabConst, evalConstIn, serialize } = require("./tests/lib/extract.cjs");
const { encodePng } = require("./tools/dev/png-write.cjs");
const { makeSink } = require("./tools/dev/canvas-sink.cjs");

const html = readHtml();
const prelude = `
  const FIGHT2_TUNE = ${grabConst(html, "FIGHT2_TUNE")};
  const Fight2Stage = ${serialize(evalConstIn(html, "Fight2Stage"))};
  var document={getElementById:function(){return {style:{},dataset:{},innerHTML:"",textContent:"",
    classList:{add:function(){},remove:function(){},contains:function(){return false;}},
    addEventListener:function(){},removeEventListener:function(){}};},querySelectorAll:function(){return [];}};
  function $(id){return document.getElementById(id);}
  var window={addEventListener:function(){},removeEventListener:function(){}};
  function requestAnimationFrame(){return 1;} function cancelAnimationFrame(){}
`;
const api = new vm.Script("(function(){\n" + prelude + "\nreturn { S:Fight2Stage };\n})()")
  .runInNewContext({ console, Math });

const S = api.S;
const sink = makeSink(1680, 900, 1);
const g = sink.ctx;
S.SPRITES.puncher = null; S.SPRITES.brawler = null;
S.begin({ getContext: () => g, width: 1680, height: 900, addEventListener(){}, removeEventListener(){} });
S.running = false;
S.arcadeOn = false; S.arcade = 0; S.arcadeMode = true;
S.sync({ hp: 400, maxHp: 400, foeHp: 320, foeMax: 320, stamMine: 1, stamFoe: 1,
         turn: 1, ap: 4, phase: "act" });
S.frameOnce();

const R = S.screenRect();
fs.writeFileSync("_frame_machine.png", encodePng(1680, 900, (() => {
  const buf = Buffer.alloc(1680 * 900 * 4, 255);
  for (let i = 0; i < 1680 * 900; i++) {
    buf[i * 4] = sink.px[i * 3]; buf[i * 4 + 1] = sink.px[i * 3 + 1];
    buf[i * 4 + 2] = sink.px[i * 3 + 2]; buf[i * 4 + 3] = 255;
  }
  return buf;
})()));

/* 沿画面中轴与几条关键扫描线取色，看看机壳该在的地方到底是什么颜色 */
const at = (x, y) => { const i = (y * 1680 + x) * 3;
  return "(" + sink.px[i] + "," + sink.px[i + 1] + "," + sink.px[i + 2] + ")"; };
console.log("screenRect = " + JSON.stringify(R) + "  arcadeMode=" + S.arcadeMode);
console.log("左机壳 x=100   y=100/450/800 : " + at(100, 100) + " " + at(100, 450) + " " + at(100, 800));
console.log("左立柱 x=150   y=450          : " + at(150, 450));
console.log("屏内人物 x=840 y=430          : " + at(840, 430) + "  ← 躯干上，暗是正常的");
console.log("屏内空地 x=400 y=700          : " + at(400, 700));
console.log("屏内地板 x=840 y=600          : " + at(840, 600));
console.log("屏内霓虹 x=250 y=200          : " + at(250, 200));
console.log("顶板   x=840   y=45           : " + at(840, 45));
console.log("操作台 x=840   y=860          : " + at(840, 860));
console.log("右机壳 x=1580  y=450          : " + at(1580, 450));
console.log("已导出 _frame_machine.png");
