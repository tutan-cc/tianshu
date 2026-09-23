/*
  cabinet-check.js —— 街机机身的两条硬约束核对（用**真实像素**，不是记账估算）。

  ① 世界只落在 CRT 屏幕矩形内；
  ② 整帧要铺满画布（机壳/操作台本来就画在屏幕外，这条只是确认没漏画）。

  为什么不用 tests/fight2.test.cjs 的桩来量：桩不保存像素，"落笔范围"只能靠记
  调用参数的变换后坐标估算 —— 实测那样必然误报（相机侧的整幅矩形、零高度矩形求交
  都会算歪）。这里数的是**真正写进画布的像素**，没有解释空间。

  已知并接受的偏差：屏幕右边界外 1px 的那一列（x = x+w）会有约 650 个像素，
  来自光栅化的边界包含关系（fillRect 的循环是 `<= x+w`）。占屏内亮像素的 0.08%，
  且落在外框的 12px 黑凹槽里，视觉上不可见 —— 所以容差定为 0.1%。

  用法：node tools/dev/cabinet-check.js   → 退出码非 0 表示越界超限
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { readHtml, grabConst, evalConstIn, serialize } = require("../../tests/lib/extract.cjs");
const { makeSink } = require("./canvas-sink.cjs");
const { encodePng } = require("./png-write.cjs");

const html = readHtml();
const api = new vm.Script("(function(){\n" +
  "const FIGHT2_TUNE = " + grabConst(html, "FIGHT2_TUNE") + ";\n" +
  /* Fight2Stage.drawCards 要读卡池（每张牌的名字/类型/消耗），必须一起抽出来 */
  "const FIGHT2_CARDS = " + grabConst(html, "FIGHT2_CARDS") + ";\n" +
  "const Fight2Stage = " + serialize(evalConstIn(html, "Fight2Stage")) + ";\n" +
  "var document={getElementById:function(){return {style:{},dataset:{},innerHTML:\"\",textContent:\"\",\n" +
  "  classList:{add:function(){},remove:function(){},contains:function(){return false;}},\n" +
  "  addEventListener:function(){},removeEventListener:function(){}};},querySelectorAll:function(){return [];}};\n" +
  "function $(id){return document.getElementById(id);}\n" +
  "var window={addEventListener:function(){},removeEventListener:function(){}};\n" +
  "function requestAnimationFrame(){return 1;} function cancelAnimationFrame(){}\n" +
  "return { S:Fight2Stage };\n})()").runInNewContext({ console, Math });

const S = api.S;
S.SPRITES.puncher = null; S.SPRITES.brawler = null;      // 骨骼回落：不依赖立绘文件
const sink = makeSink(1680, 900, 1);
S.begin({ getContext: () => sink.ctx, width: 1680, height: 900, addEventListener(){}, removeEventListener(){} });
S.running = false; S.arcadeOn = false; S.arcade = 0; S.arcadeMode = true;
/* 给 HUD 喂一份状态：--png 导出帧时要能看到血条上的身份标签（你 / 对手） */
S.sync({ hp:99, maxHp:99, foeHp:268, foeMax:320, stamMine:0.8, stamFoe:0.6,
         turn:5, ap:4, phase:"act", meName:"陈默", foeName:"花衬衫",
         hand:["jab","combo","breathe","unload"] });

const R = S.screenRect();
const TOL = 0.001;                                        // 0.1%：见文件头的说明

/* ── ① 只画世界：机壳与罩都停掉，画布上除了世界什么都没有 ── */
const rawFrame = S.drawMachineFrame;
const rawOverlay = S.drawMachineOverlay;
S.drawMachineFrame = function () {};
S.drawMachineOverlay = function () {};
sink.px.fill(0);
S.frameOnce();

let inside = 0, outside = 0, stray = [];
for (let y = 0; y < 900; y++) for (let x = 0; x < 1680; x++) {
  const i = (y * 1680 + x) * 3;
  if (sink.px[i] + sink.px[i + 1] + sink.px[i + 2] <= 40) continue;
  if (x >= R.x && x < R.x + R.w && y >= R.y && y < R.y + R.h) inside++;
  else { outside++; if (stray.length < 6) stray.push("(" + x + "," + y + ")"); }
}
const ratio = inside ? outside / inside : 1;

/* ── ② 完整一帧：确认机壳画到了屏幕之外（整帧范围大于屏幕） ── */
S.drawMachineFrame = rawFrame;
S.drawMachineOverlay = rawOverlay;
sink.px.fill(0);
/* 推 6 帧而不是 1 帧：手牌有"依次飞入"的动画（handDrawn 每帧 +0.06），
   只推一帧的话卡牌几乎还停在屏幕下方，--png 导出来看不到牌。 */
for (let i = 0; i < 6; i++) S.frameOnce();
let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
for (let y = 0; y < 900; y++) for (let x = 0; x < 1680; x++) {
  const i = (y * 1680 + x) * 3;
  if (sink.px[i] + sink.px[i + 1] + sink.px[i + 2] <= 40) continue;
  if (x < minX) minX = x; if (x > maxX) maxX = x;
  if (y < minY) minY = y; if (y > maxY) maxY = y;
}

console.log("屏幕矩形        (" + R.x + "," + R.y + ")..(" + (R.x + R.w) + "," + (R.y + R.h) + ")");
console.log("只画世界：屏内 " + inside + " · 屏外 " + outside +
  "（" + (ratio * 100).toFixed(3) + "%）" + (stray.length ? "  样本 " + stray.join(" ") : ""));
let bad = 0;
if (inside < R.w * R.h * 0.5) { console.log("✘ 屏内亮像素太少 —— 世界可能没画进屏幕"); bad++; }
else console.log("✔ 世界确实画满屏幕");
if (ratio > TOL) { console.log("✘ 屏外像素超过容差 " + (TOL * 100) + "%"); bad++; }
else console.log("✔ 世界被裁在屏幕内（溢出 " + (ratio * 100).toFixed(3) + "% ≤ " + (TOL * 100) + "%）");
console.log("整帧落笔范围    (" + minX + "," + minY + ")..(" + maxX + "," + maxY + ")");
if (minX > 0 || maxX < 1679) { console.log("✘ 机壳没有铺满画布（可能某一段没画）"); bad++; }
else console.log("✔ 机壳与操作台铺满画布（画在屏幕之外，符合预期）");

/* --png：顺手导出这一帧，用来肉眼核对 HUD（血条上的「你 · 陈默 / 花衬衫 · 对手」标签） */
if (process.argv.includes("--png")) {
  const buf = Buffer.alloc(1680 * 900 * 4, 255);
  for (let i = 0; i < 1680 * 900; i++) {
    buf[i * 4] = sink.px[i * 3]; buf[i * 4 + 1] = sink.px[i * 3 + 1]; buf[i * 4 + 2] = sink.px[i * 3 + 2];
  }
  const out = path.join(__dirname, "..", "..", "_cabinet-frame.png");
  fs.writeFileSync(out, encodePng(1680, 900, buf));
  console.log("已导出 " + out);
}
process.exit(bad ? 1 : 0);
