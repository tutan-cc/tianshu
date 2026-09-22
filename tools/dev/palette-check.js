/*
  palette-check.js —— 只画**骨骼回落路径**的两个角色并排对照，验证配色按角色分开。
  为什么单独要这个：立绘就绪时走的是立绘分支，配色表根本不参与绘制，
  所以「暖红 vs 冷蓝」在样片里看不出来 —— 必须强制摘掉立绘才能看到。

  用法：node tools/dev/palette-check.js   → palette-check.png
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { readHtml, evalConstIn, serialize } = require("../../tests/lib/extract.cjs");
const { encodePng } = require("./png-write.cjs");
const { makeSink } = require("./canvas-sink.cjs");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(ROOT, "palette-check.png");

const api = new vm.Script("(function(){\n" +
  "const Fight2Stage = " + serialize(evalConstIn(readHtml(), "Fight2Stage")) + ";\n" +
  "var document={getElementById:function(){return {style:{},dataset:{},innerHTML:\"\",textContent:\"\",\n" +
  "  classList:{add:function(){},remove:function(){},contains:function(){return false;}},\n" +
  "  addEventListener:function(){},removeEventListener:function(){}};},querySelectorAll:function(){return [];}};\n" +
  "function $(id){return document.getElementById(id);}\n" +
  "var window={addEventListener:function(){},removeEventListener:function(){}};\n" +
  "function requestAnimationFrame(){return 1;} function cancelAnimationFrame(){}\n" +
  "return { S:Fight2Stage };\n})()").runInNewContext({ console, Math });
const S = api.S;
S.SPRITES.puncher = null; S.SPRITES.brawler = null;   // 强制骨骼回落：这才走配色表

const VW = 1680, VH = 1100, GROUND = 780, ANCHOR = 420;
const HALF_W = 420, CELL_H = 900, CELL_W = HALF_W * 2;
const POSES = ["idle", "strike"];
const ROWS = [
  { slug: "player",  who: "player",  flipped: false },
  { slug: "brawler", who: "brawler", flipped: true  },
];
const SHEET_W = CELL_W * POSES.length, SHEET_H = CELL_H * ROWS.length;
const sheet = Buffer.alloc(SHEET_W * SHEET_H * 4, 0);
for (let i = 3; i < sheet.length; i += 4) sheet[i] = 255;

S.W = VW; S.H = VH; S.GROUND = GROUND;
const sink = makeSink(VW, VH, 1);
const g = sink.ctx;

for (let r = 0; r < ROWS.length; r++) {
  for (let c = 0; c < POSES.length; c++) {
    const R = ROWS[r];
    const f = { x: ANCHOR, who: R.who, sprite: null, o: R.who !== "player", flipped: R.flipped,
                poseName: POSES[c], pose: S.poseOf(R.who, POSES[c]) };
    f.body = S.BODIES[R.who];
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, VW, VH); g.restore();
    sink.px.fill(0);
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#0b0b12"; g.fillRect(0, 0, VW, VH);
    g.strokeStyle = "#3a3a52"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, GROUND); g.lineTo(VW, GROUND); g.stroke();
    g.restore();
    S.drawFighter(g, f);
    /* 拷进对照图：以贴地点为中心 */
    const x0 = ANCHOR - HALF_W / 2;
    const destX = c * CELL_W, destY = r * CELL_H;
    const SRC_Y0 = GROUND - 700;
    for (let y = 0; y < CELL_H; y++) {
      const sy = SRC_Y0 + y;
      if (sy < 0 || sy >= VH) continue;
      for (let x = 0; x < HALF_W; x++) {
        const sx = x0 + x;
        if (sx < 0 || sx >= VW) continue;
        const si = (sy * VW + sx) * 3, ti = ((destY + y) * SHEET_W + (destX + x)) * 4;
        sheet[ti] = sink.px[si]; sheet[ti + 1] = sink.px[si + 1];
        sheet[ti + 2] = sink.px[si + 2]; sheet[ti + 3] = 255;
      }
    }
  }
}

/* 采样"本体轮廓光"的实际像素：取画面里最亮的暖色与冷色像素，验证两条色系真的画出来了 */
function dominantHue(buf, W, H) {
  let warm = 0, cool = 0;
  for (let i = 0; i < W * H; i++) {
    const o = i * 4, r = buf[o], g2 = buf[o + 1], b = buf[o + 2];
    if (r + g2 + b < 90) continue;
    if (r - b > 25) warm++; else if (b - r > 25) cool++;
  }
  return { warm, cool };
}
const hue = dominantHue(sheet, SHEET_W, SHEET_H);

fs.writeFileSync(OUT, encodePng(SHEET_W, SHEET_H, sheet));
console.log("配色对照图 → " + OUT + "  " + SHEET_W + "x" + SHEET_H);
console.log("（第 1 行 = 陈默 player · 冷蓝系；第 2 行 = 莽夫 brawler · 暖红系；两列 = idle / strike）");
console.log("全图暖色像素 " + hue.warm + " · 冷色像素 " + hue.cool);
let bad = 0;
if (hue.warm < 500 || hue.cool < 500) { console.log("✘ 两个色系没有同时出现 —— 配色可能没生效"); bad++; }
else console.log("✔ 暖色与冷色两套都在场（两个角色一眼能分辨）");
for (const slug of ["player", "brawler"]) {
  const tone = S.palOf(slug);
  console.log("  " + slug.padEnd(8) + tone.label + "  远侧 " + tone.far.main + "  本体 " + tone.near.main +
    "  轮廓光 " + tone.near.edge + "  拳套收口 " + tone.cuff);
}
process.exit(bad ? 1 : 0);
