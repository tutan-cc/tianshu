/*
  card-preview.js —— 卡牌正反面**设计预览**（不动战斗逻辑，只出图给策划挑样式）。

  为什么要单独做：卡牌样式是"看一眼就知道行不行"的东西，
  直接改战斗代码再截图验证，一轮要跑几十秒；这里只画卡，改一版看一版。
  它用的是**最终会进游戏的那套绘制函数**（把 CardArt 抽到 index.html 里，
  这个工具从 index.html 抽出来用），所以预览与实机是同一份代码。

  用法：node tools/dev/card-preview.js  → card-preview.png
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { readHtml, grabConst, evalConstIn, serialize } = require("../../tests/lib/extract.cjs");
const { encodePng } = require("./png-write.cjs");
const { makeSink } = require("./canvas-sink.cjs");

const html = readHtml();
const api = new vm.Script("(function(){\n" +
  "const FIGHT2_CARDS = " + grabConst(html, "FIGHT2_CARDS") + ";\n" +
  "const CardArt = " + serialize(evalConstIn(html, "CardArt")) + ";\n" +
  "return { CARDS:FIGHT2_CARDS, Art:CardArt };\n" +
  "})()").runInNewContext({ console, Math });

const W = 1680, H = 1360;
const sink = makeSink(W, H, 1);
const g = sink.ctx;
const Art = api.Art, CARDS = api.CARDS;

/* 背景：深色桌面 + 一点中央光，别让卡牌浮在纯黑上 */
g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
g.fillStyle = "#0a0810"; g.fillRect(0, 0, W, H);
{
  const rl = g.createRadialGradient ? g.createRadialGradient(W / 2, H * 0.35, 40, W / 2, H * 0.35, W * 0.6) : null;
  if(rl){ rl.addColorStop(0, "rgba(90,70,140,.30)"); rl.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rl; g.fillRect(0, 0, W, H * 0.8); }
}
g.restore();

const CW = 216, CH = 288;                       // 卡牌尺寸（和游戏内一致）
/* 第一排：背面 + 各类型正面 */
const demos = [
  ["back", "back"],
  ["front", "jab"], ["front", "combo"], ["front", "heavy"], ["front", "low"],
];
/* 第二排：四类各一张（类型色对照） */
const row2 = [["front", "guard"], ["front", "unload"], ["front", "read"], ["front", "counterup"], ["front", "breathe"]];

function place(row, col, cols, total) {
  const gap = 26;
  const totalW = cols * CW + (cols - 1) * gap;
  const x0 = (W - totalW) / 2;
  return { x: x0 + col * (CW + gap), y: 70 + row * (CH + 96) };
}

g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
Art.label(g, "卡牌背面（未翻开）与进攻牌正面", 24, 40, "#ffd76e", "bold 22px 'Arial Black',sans-serif");
demos.forEach(([face, id], i) => {
  const p = place(0, i, demos.length);
  if(face === "back") Art.back(g, p.x, p.y, CW, CH);
  else Art.front(g, p.x, p.y, CW, CH, CARDS[id]);
});
Art.label(g, "防守 / 技能 / 治疗 三类（边框与顶角徽记按类型上色）", 24, 470, "#4dd8ff", "bold 22px 'Arial Black',sans-serif");
row2.forEach(([face, id], i) => {
  const p = place(1, i, row2.length);
  Art.front(g, p.x, p.y, CW, CH, CARDS[id]);
});
Art.label(g, "翻牌动作预览：背面 → 压扁 → 正面（横向缩放，模拟卡片翻转）",
  24, 880, "#b07dff", "bold 20px 'Arial Black',sans-serif");
g.restore();

/* 第三排：三帧翻牌过程（用同一张牌的不同进度画三遍） */
{
  const steps = [0.15, 0.5, 0.85];
  const gap = 60, totalW = steps.length * CW + (steps.length - 1) * gap;
  const x0 = 40;
  steps.forEach((k, i) => {
    const x = x0 + i * (CW + gap), y = 760;
    const s = Math.abs(Math.cos(k * Math.PI));      // 1 → 0 → 1
    const showFront = k > 0.5;
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    g.translate(x + CW / 2, y + CH / 2);
    g.scale(Math.max(0.04, s), 1);
    g.translate(-CW / 2, -CH / 2);
    if(showFront) Art.front(g, 0, 0, CW, CH, CARDS.jab);
    else Art.back(g, 0, 0, CW, CH);
    g.restore();
  });
}

/* 右侧：2 倍放大的正反面，用来看细节（描边、名牌、胶囊、徽记） */
{
  const Z = 1.85, bigW = CW * Z, bigH = CH * Z;
  const bx = W - bigW * 2 - 90, by = 700;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  Art.label(g, "2x 放大：背面 / 正面", bx, by - 16, "#5dffa0", "bold 18px 'Arial Black',sans-serif");
  g.translate(bx, by);
  g.scale(Z, Z);
  Art.back(g, 0, 0, CW, CH);
  g.restore();
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  g.translate(bx + bigW + 40, by);
  g.scale(Z, Z);
  Art.front(g, 0, 0, CW, CH, CARDS.combo);
  g.restore();
}

const buf = Buffer.alloc(W * H * 4, 255);
for (let i = 0; i < W * H; i++) {
  buf[i * 4] = sink.px[i * 3]; buf[i * 4 + 1] = sink.px[i * 3 + 1]; buf[i * 4 + 2] = sink.px[i * 3 + 2];
}
const out = path.join(__dirname, "..", "..", "card-preview.png");
fs.writeFileSync(out, encodePng(W, H, buf));
console.log("卡牌设计预览 → " + out + "  " + W + "x" + H);
console.log("（用的是 index.html 里的 CardArt，和实机同一份绘制代码）");
