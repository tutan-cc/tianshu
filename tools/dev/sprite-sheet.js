/*
  sprite-sheet.js —— 用**真实的 Fight2Stage.drawFighter** 出一张立绘对照图（PNG）。

  为什么要有它：立绘这条链上有三个"看不出来就会错"的点，读代码发现不了 ——
    ① 比例：四张图高度差极大（陈默站 309 / 倒地 126），按"每张各自拉到 420px 高"缩放，
       倒地那张会变成宽 780px 的怪物；
    ② 贴地：切图对齐后底部有 0~21px 空档，拿"图片底边"当脚底人就会陷进地里；
    ③ 镜像：整张图 scale(-1,1) 是**绕锚点**镜像的，若图从锚点起画而不是以锚点为中心，
       图会被整个甩到另一侧 —— 实测表现是花衬衫的立绘紧贴格子右缘、一半出画。
  这张图把三条都变成能看见的东西，并且每格并排给出「立绘 / 骨骼回落」两条路。

  用法（在仓库根）：
    node tools/dev/sprite-sheet.js                # → sprite-sheet.png
    node tools/dev/sprite-sheet.js --out x.png
  退出码：脚底偏差 > 3px 或站姿高度失真 > 40px 时非 0（可当回归闸用）。
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { readHtml, evalConstIn, serialize } = require("../../tests/lib/extract.cjs");
const { decodePng } = require("./png-read.cjs");
const { encodePng } = require("./png-write.cjs");
const { makeSink } = require("./canvas-sink.cjs");

const ROOT = path.join(__dirname, "..", "..");
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return path.join(ROOT, i >= 0 ? process.argv[i + 1] : "sprite-sheet.png");
})();

const html = readHtml();
const POSES = ["idle", "strike", "hit", "ko"];

/* ── 载入真实立绘（自己解 PNG，见 png-read.cjs） ── */
function loadSpriteSet(slug) {
  const dir = path.join(ROOT, "art", "fight2");
  const index = JSON.parse(fs.readFileSync(path.join(dir, slug + ".json"), "utf8"));
  const poses = {};
  for (const p of POSES) {
    const meta = index.poses[p];
    if (!meta) continue;
    const im = decodePng(fs.readFileSync(path.join(dir, meta.file)));
    poses[p] = { w: im.w, h: im.h, px: im.px, naturalWidth: im.w, naturalHeight: im.h };
  }
  return { slug, index, poses };
}
const SETS = { puncher: loadSpriteSet("puncher"), brawler: loadSpriteSet("brawler") };

/* ── 最小 vm 环境：只抽 Fight2Stage ── */
const api = new vm.Script("(function(){\n" +
  "const Fight2Stage = " + serialize(evalConstIn(html, "Fight2Stage")) + ";\n" +
  "var document={getElementById:function(){return {style:{},dataset:{},innerHTML:\"\",textContent:\"\",\n" +
  "  classList:{add:function(){},remove:function(){},contains:function(){return false;}},\n" +
  "  addEventListener:function(){},removeEventListener:function(){}};},querySelectorAll:function(){return [];}};\n" +
  "function $(id){return document.getElementById(id);}\n" +
  "var window={addEventListener:function(){},removeEventListener:function(){}};\n" +
  "function requestAnimationFrame(){return 1;} function cancelAnimationFrame(){}\n" +
  "return { S:Fight2Stage };\n})()").runInNewContext({ console, Math });
const S = api.S;

/* 把真实立绘塞进 SPRITES（真浏览器里这是 Image.onload 干的活）；
   standH / lowY 从切图脚本产出的 JSON 回填 —— 图里画的就是线上那套数值。 */
for (const slug of ["puncher", "brawler"]) {
  const set = SETS[slug];
  S.SPRITE_META[slug].standH = set.index.poses.idle.h;
  for (const p of Object.keys(set.poses)) S.SPRITE_META[slug].lowY[p] = set.index.poses[p].lowY;
  S.SPRITES[slug] = { ready: 4, need: 4, poses: set.poses };
}

/* ── 布局：2 行（角色）× 4 列（姿势），每格再左右并排「立绘 / 骨骼回落」──
   两半各自独立渲染、按**局部窗口**量测：第一版把两半画在同一张 1680 宽画布上，
   量出来的宽度全是 1680、脚底偏差 73px —— 因为量到了隔壁那个人。
   ⚠ 阶段画布要够高：陈默缩放后身高 445px（420 × 1.06），地面线放 320 时头顶
     会跑到画布外被裁掉，量出来的"身高"比真身高矮 40px（也曾经误导过判断）。 */
const VW = 1680, VH = 1100, GROUND = 760;     // 地面线以下留 340px 给倒影，以上 760px 给人物
const ANCHOR = 320;                           // 人物贴地点（靠左放，右边够画一整格）
const HALF_W = 210, CELL_H = 900, CELL_W = HALF_W * 2;
const SRC_X0 = ANCHOR - HALF_W / 2;           // 量测/拷贝窗口的左边界（以贴地点为中心）
const SRC_Y0 = GROUND - 600;                  // 窗口上边界：够放下 445px 身高 + 余量
const ROWS = [
  { slug: "puncher", who: "player",  flipped: false },
  { slug: "brawler", who: "brawler", flipped: true  },
];
const SHEET_W = CELL_W * POSES.length, SHEET_H = CELL_H * ROWS.length;
const sheet = Buffer.alloc(SHEET_W * SHEET_H * 4, 0);
for (let i = 3; i < sheet.length; i += 4) sheet[i] = 255;

const sink = makeSink(VW, VH, 1, { alphaTrack: true });
const g = sink.ctx;
const BG = [0x10, 0x10, 0x18];
/** 量测用"实心"判据：该像素被以 ≥50% 的不透明度写过。
 *  ⚠ 必须这样排除**地面倒影**（drawFighter 用 globalAlpha 0.18 画的），否则
 *    内容的像素范围会一路向下延伸，量出来是"人物低于地面 182px"——一个纯粹的假问题。
 *    （这条弯路花了好几轮：先怀疑镜像、再怀疑 lowY、最后才发现量的是倒影。） */
const solid = (x, y) => sink.amax[y * VW + x] >= 0.5;
/* ⚠ 舞台常量必须在**渲染之前**就位：第一版写在循环之后，渲染时用的还是默认 GROUND=700，
   于是人画在 y≈700、地面线和量测窗口却在 y=320，量出来的东西全对不上。 */
S.W = VW; S.H = VH; S.GROUND = GROUND;

/** 只画人物，不画舞台：这样"比例/贴地"不会被背景干扰。
 *  ⚠ 判"内容"的规则只能是「不是背景色」：第一版顺手把地面线的颜色也排掉，
 *    结果骨骼路径的蓝边 rgb(62,157,190) 一起被吃掉，量出来的身高只有 30px。
 *  坐标系统一用**局部坐标**：人物贴地点 = (ANCHOR, GROUND)，量测/拷贝窗口以它为中心。
 *  之前混用"全局画布坐标 + 窗口偏移"，光这一处就错了三次（量到隔壁人、把人物推半格、
 *  地面线写在循环之后），所以这里刻意让窗口原点唯一。 */
function renderFighter(f) {
  /* 临时挂一层 drawImage 追踪（SHEET_DEBUG=1 时开）：立绘的几何算错时，
     光看"脚底偏了多少"猜不出原因，必须看真正的变换矩阵与目标矩形。 */
  const trace = process.env.SHEET_DEBUG ? [] : null;
  const rawDraw = g.drawImage;
  if (trace) {
    g.drawImage = function (img, dx, dy, dw, dh) {
      const m = (g.__m ? g.__m() : null);
      trace.push("    drawImage(" + [dx, dy, dw, dh].map((v) => (v || 0).toFixed(1)).join(",") +
        ")  m=[" + (m ? m.map((v) => v.toFixed(3)).join(",") : "?") + "]");
      return rawDraw.call(g, img, dx, dy, dw, dh);
    };
  }
  /* ⚠ 清屏要走 clearRect()，不能只 px.fill(0)：alphaTrack 的 amax 缓冲也要一起清，
     否则下一格会量到上一格的残留（表现是所有格子都量成满格）。 */
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, VW, VH); g.restore();
  sink.px.fill(0);
  /* 背景与地面线是全不透明填的：这一段必须关掉 alphaTrack，
     否则整块画布都成了"实心"，量测就没意义了。 */
  g.__alphaTrack(false);
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#101018"; g.fillRect(0, 0, VW, VH);
  g.strokeStyle = "#3a3a52"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(SRC_X0, GROUND); g.lineTo(SRC_X0 + HALF_W, GROUND); g.stroke();
  g.restore();
  g.__alphaTrack(true);
  S.drawFighter(g, f);
  /* 半格之间的分隔线：画在人物**之后**，否则会被盖掉；
     它是"立绘 | 骨骼"这条读图约定的唯一视觉提示。 */
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = "#2b2b3d"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(SRC_X0 + HALF_W, 0); g.lineTo(SRC_X0 + HALF_W, CELL_H); g.stroke();
  g.restore();
  if (trace) {
    g.drawImage = rawDraw;
    console.log("  [dbg] " + f.who + " x=" + f.x + " flipped=" + f.flipped + " pose=" + f.poseName +
      " sprite=" + f.sprite + " poseOf.step=" + (f.pose ? f.pose.step : "?") +
      " spriteOf=" + (S.spriteOf(f.sprite, f.poseName) ? "OK" : "null"));
    trace.forEach((t) => console.log(t));
  }
}

/** 量测：只看这一半格的窗口。返回的 x/y 都是**窗口内**偏移。
 *  用 solid()（不透明度 ≥0.5）而不是"不是背景色"：后者会把倒影算成人物。 */
function measure() {
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  for (let y = 0; y < CELL_H; y++) for (let k = 0; k < HALF_W; k++) {
    if (!solid(SRC_X0 + k, SRC_Y0 + y)) continue;
    if (k < minX) minX = k; if (k > maxX) maxX = k;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  /* 落地点：取"每列最低的实心像素"的 **80 分位**。
     为什么不用"最靠下的一个像素"：出拳时拳套也在下面，会被带偏（实测 strike 量出来是拳头）。
     为什么不用"中间几条列的最低点"：两腿之间有缝，中间那几条列可能整列都是空的。
     为什么不用"最低的一行"：源图脚底还有一层模糊的接地阴影，算进去会得出"人浮在地面上方"。 */
  const lows = [];
  for (let k = 0; k < HALF_W; k++) {
    for (let y = maxY; y >= minY; y--) if (solid(SRC_X0 + k, SRC_Y0 + y)) { lows.push(y); break; }
  }
  lows.sort((a, b) => a - b);
  const foot = lows.length ? lows[Math.min(lows.length - 1, Math.floor(lows.length * 0.8))] : -1;
  return { minX, maxX, minY, maxY, foot };
}

/** 把这一格的窗口拷到对照图上 */
function pasteCell(destX, destY) {
  for (let y = 0; y < CELL_H; y++) {
    const sy = SRC_Y0 + y;
    if (sy < 0 || sy >= VH) continue;
    for (let x = 0; x < HALF_W; x++) {
      const sx = SRC_X0 + x;
      if (sx < 0 || sx >= VW) continue;
      const si = (sy * VW + sx) * 3, ti = ((destY + y) * SHEET_W + (destX + x)) * 4;
      sheet[ti] = sink.px[si]; sheet[ti + 1] = sink.px[si + 1];
      sheet[ti + 2] = sink.px[si + 2]; sheet[ti + 3] = 255;
    }
  }
}

const measured = [];
let row = 0;
for (const R of ROWS) {
  for (let c = 0; c < POSES.length; c++) {
    const pose = POSES[c];
    const cellX = c * CELL_W, cellY = row * CELL_H;
    for (const useSprite of [true, false]) {
      S.me = { x: ANCHOR, who: "player", sprite: "puncher", o: false, flipped: false };
      S.foe = { x: ANCHOR, who: "brawler", sprite: "brawler", o: true, flipped: R.slug === "brawler" };
      const f = R.who === "player" ? S.me : S.foe;
      if (!useSprite) f.sprite = null;            // 摘掉立绘 → spriteOf 返回 null → 走骨骼回落
      f.flipped = R.flipped;
      f.poseName = pose;
      f.pose = S.poseOf(f.who, pose);
      renderFighter(f);
      pasteCell(cellX + (useSprite ? 0 : HALF_W), cellY);
      if (useSprite) {
        const m = measure();
        const meta = SETS[R.slug].poses[pose];
        if (process.env.SHEET_DEBUG) console.log("  [dbg] " + R.slug + " " + pose +
          " window=" + m.minX + "," + m.minY + ".." + m.maxX + "," + m.maxY +
          " foot(win)=" + m.foot + " SRC_Y0=" + SRC_Y0 + " GROUND=" + GROUND +
          " → 画布 y=" + (SRC_Y0 + m.foot));
        measured.push({ slug: R.slug, pose, srcW: meta.w, srcH: meta.h,
                        drawW: m.maxX - m.minX + 1, drawH: m.maxY - m.minY + 1,
                        footToGround: (SRC_Y0 + m.foot) - GROUND });
      }
    }
  }
  row++;
}

fs.writeFileSync(OUT, encodePng(SHEET_W, SHEET_H, sheet));

console.log("立绘对照图 → " + OUT + "  " + SHEET_W + "x" + SHEET_H);
console.log("每格左半 = Lovart 立绘，右半 = 骨骼回落；横线是地面线（GROUND=" + GROUND + "）\n");
console.log("角色      姿势     源图        立绘画到屏上   脚底-地面线");
for (const m of measured) {
  console.log(m.slug.padEnd(9) + m.pose.padEnd(8) +
    (m.srcW + "x" + m.srcH).padEnd(12) + (m.drawW + "x" + m.drawH).padEnd(15) +
    (m.footToGround >= 0 ? "+" : "") + m.footToGround);
}
/* 关键校验（只对**立姿**三个姿势成立；倒地那格整个人是横的，"最低点"不是脚，不参与比较）：
   ① 贴地锚点是否生效：立姿三格脚底偏差要小；
   ② 缩放基准是否是"站姿身高"而不是"每图各自拉高"：立姿三格身高要一致、倒地不能拉宽。
   容差 20px 的来历：站姿身高 420px，20px 约 5%、约四分之一个头。残差来自源图里
   "最低的不透明像素"其实是各姿势不同的**接地阴影/拳套**，不是脚 —— 先把阈值钉在
   "肉眼看不出来"的量级上，真跳脚（第一版是 183px）会立刻超标。 */
let bad = 0;
for (const slug of ["puncher", "brawler"]) {
  const rows = measured.filter((m) => m.slug === slug);
  const stand = rows.filter((r) => r.pose !== "ko");
  const gaps = stand.map((r) => r.footToGround);
  const spread = Math.max(...gaps) - Math.min(...gaps);
  const hs = stand.map((r) => r.drawH);
  const hSpread = Math.max(...hs) - Math.min(...hs);
  const ko = rows.find((r) => r.pose === "ko");
  const okFeet = spread <= 20, okScale = hSpread <= 40, okKo = ko.drawW < 400;
  console.log(`\n${slug}：立姿脚底偏差 ${spread}px ${okFeet ? "✔" : "✘ 换姿势会跳脚"}` +
    ` · 立姿身高差 ${hSpread}px ${okScale ? "✔ 比例一致" : "✘ 比例失真"}` +
    ` · 倒地宽 ${ko.drawW}px ${okKo ? "✔ 没被拉成怪物" : "✘ 缩放基准错了"}`);
  console.log(`  （倒地那格脚底-地面线 ${ko.footToGround >= 0 ? "+" : ""}${ko.footToGround}px：躺着的人"最低点"本来就不是脚，仅供看图参考）`);
  if (!okFeet || !okScale || !okKo) bad++;
}
process.exit(bad ? 1 : 0);
