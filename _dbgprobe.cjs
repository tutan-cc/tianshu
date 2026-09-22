/* 一次性调试：跳过 drawArcade，判断屏内是"被盖住"还是"世界根本没画进来"。 */
const fs = require("fs");
const vm = require("vm");
const { readHtml, grabConst, evalConstIn, serialize } = require("./tests/lib/extract.cjs");
const { makeSink } = require("./tools/dev/canvas-sink.cjs");
const { encodePng } = require("./tools/dev/png-write.cjs");

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

function dump(name) {
  const buf = Buffer.alloc(1680 * 900 * 4, 255);
  for (let i = 0; i < 1680 * 900; i++) {
    buf[i * 4] = sink.px[i * 3]; buf[i * 4 + 1] = sink.px[i * 3 + 1];
    buf[i * 4 + 2] = sink.px[i * 3 + 2]; buf[i * 4 + 3] = 255;
  }
  fs.writeFileSync(name, encodePng(1680, 900, buf));
  /* 统计屏幕矩形内的"非黑"像素比例：>0 说明世界画进来了 */
  const R = S.screenRect();
  let lit = 0, tot = 0;
  for (let y = R.y + 20; y < R.y + R.h - 20; y += 3)
    for (let x = R.x + 20; x < R.x + R.w - 20; x += 3) {
      const i = (y * 1680 + x) * 3; tot++;
      if (sink.px[i] + sink.px[i + 1] + sink.px[i + 2] > 60) lit++;
    }
  console.log(name.padEnd(24) + "屏内非黑像素 " + (lit / tot * 100).toFixed(1) + "%");
}

S.frameOnce();
dump("_probe_full.png");

/* 跳过机身：世界应该原样可见 */
const rawArcade = S.drawArcade;
S.drawArcade = function () {};
S.frameOnce();
dump("_probe_nocabinet.png");

/* 恢复机身，但把 drawCrt 也停掉 */
S.drawArcade = rawArcade;
const rawCrt = S.drawCrt;
S.drawCrt = function () {};
S.frameOnce();
dump("_probe_nocrt.png");

/* 只停掉"屏幕点亮压黑"那一段：把 arcade 置为 1（不在 0<p<1 区间） */
S.drawCrt = rawCrt;
S.arcadeMode = true; S.arcade = 1; S.arcadeOn = false;
S.frameOnce();
dump("_probe_arcade1.png");
