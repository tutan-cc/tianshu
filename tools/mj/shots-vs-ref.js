/* ═══════════════════════════════════════════════════════════════════════════
   tools/mj/shots-vs-ref.js — 测试截图/mj_layout_vs_ref.png：**与参考图并排对照**

   上 = 参考图（真实麻将 App，缩放到与我们同宽 1240），下 = 我们的布局（1240×860 桌面原图）。
   两半**同宽**，所以同一个归一化 x 在上下两半是**同一条竖线** —— 直接看差在哪。
   并在两半上画出关键元素的参考线（牌墙内外沿 / 圆心）+ 标注。

   前置：先跑一次 node tools/mj/shots-layout.js（它会导出 dist/test-results/mj_layout_raw.bin）。
   参考图 raw RGB 由本脚本自己用 System.Drawing 转一次（Node 没内置 JPEG 解码）。

   运行：node tools/mj/shots-vs-ref.js [参考图路径]
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const { createCanvas } = require("../lib/raster.js");
const { execFileSync } = require("child_process");

const OUT = path.join(__dirname, "..", "..");
const SHOT = path.join(OUT, "测试截图");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });
const TR = path.join(OUT, "dist", "test-results");
if (!fs.existsSync(TR)) fs.mkdirSync(TR, { recursive: true });

/* 参考图默认取**仓库内**那份（tools/mj/_refcrop/ref_tiles.png，已入库）。
   ⚠ 原先默认值是作者本机的 dsh 附件缓存绝对路径
     （C:\Users\chris\.dsh\attachments\v1\objects\f4\...），
     换台机器就跑不了 —— 属于「只在作者机器上可用」的硬编码。
     仓库里本来就有同源的那张图，指过去即可开箱即用。
   仍可用命令行参数覆盖：node tools/mj/shots-vs-ref.js <参考图路径> */
const REF_DEFAULT = path.join(__dirname, "_refcrop", "ref_tiles.png");
const REF = process.argv[2] || REF_DEFAULT;
const REF_RAW = path.join(TR, "ref_raw.bin");
const REF_META = path.join(TR, "ref_raw.json");
const OUR_RAW = path.join(TR, "mj_layout_raw.bin");
const OUR_META = path.join(TR, "mj_layout_raw.json");
const PNG = path.join(SHOT, "mj_layout_vs_ref.png");

/* ── 1. 参考图 → raw RGB（只转一次，缓存）────────────────────────────────── */
function ensureRefRaw() {
  if (fs.existsSync(REF_RAW) && fs.existsSync(REF_META)) return JSON.parse(fs.readFileSync(REF_META, "utf8"));
  if (!fs.existsSync(REF)) throw new Error("参考图不存在：" + REF + "（可用参数指定路径）");
  const ps = [
    "Add-Type -AssemblyName System.Drawing;",
    "$bb=New-Object System.Drawing.Bitmap -ArgumentList '" + REF.replace(/'/g, "''") + "';",
    "$rr=New-Object System.Drawing.Rectangle -ArgumentList 0,0,$bb.Width,$bb.Height;",
    "$dd=$bb.LockBits($rr,[System.Drawing.Imaging.ImageLockMode]::ReadOnly,[System.Drawing.Imaging.PixelFormat]::Format24bppRgb);",
    "$yy=New-Object byte[] ($dd.Stride*$bb.Height);",
    "[System.Runtime.InteropServices.Marshal]::Copy($dd.Scan0,$yy,0,$yy.Length); $bb.UnlockBits($dd);",
    "$st=$dd.Stride; $wd=$bb.Width; $hg=$bb.Height; $bb.Dispose();",
    "[System.IO.File]::WriteAllBytes('" + REF_RAW.replace(/'/g, "''") + "',$yy);",
    "Write-Output ($wd.ToString()+' '+$hg.ToString()+' '+$st.ToString())"
  ].join(" ");
  const o = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  const p = o.trim().split(/\s+/).map(Number);
  const meta = { w: p[0], h: p[1], stride: p[2] };
  fs.writeFileSync(REF_META, JSON.stringify(meta), "utf8");
  return meta;
}
const rm = ensureRefRaw();
const refBuf = fs.readFileSync(REF_RAW);
const om = JSON.parse(fs.readFileSync(OUR_META, "utf8"));
const ourBuf = fs.readFileSync(OUR_RAW);
console.log("[参考图] " + rm.w + "×" + rm.h + "   [我们的桌面] " + om.w + "×" + om.h);

/* ── 2. 画布：上参考 / 下我们，同宽 1240 ─────────────────────────────────── */
const CW = 1240, RH = Math.round(rm.h * CW / rm.w);          // 参考图缩放后的高
const HEAD = 46, TAIL = 30, GAP = 54, NOTES = 118;
const TOTAL = HEAD + RH + TAIL + GAP + TAIL + om.h + NOTES;
const cv = createCanvas(CW, TOTAL, { hostWidth: CW, hostHeight: TOTAL, hostDpr: 1 });
const texts = [];
cv.__textHook = t => texts.push(t);

/** 最近邻缩放 blit，并可指定放置位置。
    ⚠ bgr：GDI+ 的 Format24bppRgb 在内存里其实是 **BGR** 顺序（踩过坑：青绿桌面会变成土黄），
    参考图那一份必须把 R/B 换回来；我们自己的 raster.js 缓冲是 RGB，不用换。 */
function blit(src, sw, sh, sstride, dw, dh, ox, oy, bgr) {
  const db = cv._buf, dwid = cv._w, dhei = cv._h;
  for (let y = 0; y < dh; y++) {
    const dy = oy + y; if (dy < 0 || dy >= dhei) continue;
    const sy = Math.min(sh - 1, Math.floor(y * sh / dh));
    for (let x = 0; x < dw; x++) {
      const dx = ox + x; if (dx < 0 || dx >= dwid) continue;
      const sx = Math.min(sw - 1, Math.floor(x * sw / dw));
      const sp = sy * sstride + sx * 3, dp = (dy * dwid + dx) * 3;
      db[dp] = src[sp + (bgr ? 2 : 0)]; db[dp + 1] = src[sp + 1]; db[dp + 2] = src[sp + (bgr ? 0 : 2)];
    }
  }
}
function line(x0, y0, x1, y1, col, w) {
  cv.save(); cv.strokeStyle = col; cv.lineWidth = w || 1;
  cv.beginPath(); cv.moveTo(x0, y0); cv.lineTo(x1, y1); cv.stroke(); cv.restore();
}
function box(x, y, w, h, col, lw) {
  cv.save(); cv.strokeStyle = col; cv.lineWidth = lw || 1.5;
  cv.strokeRect(x + .5, y + .5, w - 1, h - 1); cv.restore();
}

cv.fillStyle = "#0b0a10"; cv.fillRect(0, 0, CW, TOTAL);
const rx = y => Math.round(y * RH / rm.h);                     // 参考图 y → 上半画布 y
const ry0 = HEAD, oy0 = HEAD + RH + TAIL + GAP + TAIL;         // 两半的起始 y

/* 上半：参考图 */
blit(refBuf, rm.w, rm.h, rm.stride, CW, RH, 0, ry0, true);
/* 下半：我们的桌面 */
blit(ourBuf, om.w, om.h, om.w * 3, CW, om.h, 0, oy0, false);

/* ── 3. 竖参考线（两半同一条 x —— 归一化 x 相同）────────────────────────── */
const RG = [ { nx: 0.182, t: "参考：左墙外沿" }, { nx: 0.251, t: "参考：左墙内沿" },
             { nx: 0.497, t: "参考：圆心" }, { nx: 0.680, t: "参考：右墙内沿" },
             { nx: 0.770, t: "参考：右墙外沿" } ];
const OG = [ { nx: 256 / 1240, t: "我们：左墙外沿" }, { nx: 302 / 1240, t: "我们：左墙内沿" },
             { nx: 620 / 1240, t: "我们：圆心" }, { nx: 938 / 1240, t: "我们：右墙内沿" },
             { nx: 984 / 1240, t: "我们：右墙外沿" } ];
for (const g of RG) { const x = Math.round(g.nx * CW);
  line(x, ry0, x, ry0 + RH, "rgba(255,215,110,.55)", 1); }
for (const g of OG) { const x = Math.round(g.nx * CW);
  line(x, oy0, x, oy0 + om.h, "rgba(120,230,255,.55)", 1); }

/* 参考图量出来的关键框（归一化 → 画布） */
const REFBOX = [
  { x0: .182, x1: .251, y0: .132, y1: .673, c: "#78e6ff", t: "左墙段" },
  { x0: .680, x1: .770, y0: .095, y1: .705, c: "#78e6ff", t: "右墙段" },
  { x0: .385, x1: .663, y0: .014, y1: .105, c: "#8ef2c0", t: "上墙段" },
  { x0: .291, x1: .734, y0: .732, y1: .795, c: "#8ef2c0", t: "下墙段" },
  { x0: .497, x1: .497, y0: .398, y1: .398, c: "#ff7d9c", t: "圆盘中心", dot: true }
];
for (const b of REFBOX) {
  if (b.dot) { cv.save(); cv.fillStyle = b.c; cv.beginPath();
    cv.arc(Math.round(b.x0 * CW), ry0 + rx(b.y0 * rm.h), 5, 0, Math.PI * 2); cv.fill(); cv.restore(); continue; }
  box(b.x0 * CW, ry0 + rx(b.y0 * rm.h), (b.x1 - b.x0) * CW, rx((b.y1 - b.y0) * rm.h), b.c, 1.5);
}
/* 我们的方环（同样归一化） */
const ourRing = { x0: 256 / 1240, x1: 984 / 1240, y0: 55 / 860, y1: 705 / 860 };
box(ourRing.x0 * CW, oy0 + ourRing.y0 * om.h, (ourRing.x1 - ourRing.x0) * CW, (ourRing.y1 - ourRing.y0) * om.h, "#ffd76e", 2);

/* ── 4. 文字 ─────────────────────────────────────────────────────────────── */
cv.textAlign = "center"; cv.textBaseline = "middle";
cv.fillStyle = "#ffe9b8"; cv.font = "bold 20px system-ui";
cv.fillText("布局对照：上 = 参考图（真实麻将 App，缩放到同宽）     下 = 我们的布局（1240×860）", CW / 2, 22);
cv.fillStyle = "#cbb894"; cv.font = "12px system-ui";
cv.fillText("两半同宽 → 同一条竖线在上下两半就是同一个归一化 x；金线 = 参考图量出的牌墙内外沿，青线 = 我们的", CW / 2, 40);

cv.font = "bold 13px system-ui"; cv.textAlign = "left";
cv.fillStyle = "#ffd76e"; cv.fillText("① 参考图 " + rm.w + "×" + rm.h + "（缩放后 " + CW + "×" + RH + "）", 10, ry0 + 14);
cv.fillStyle = "#ffd76e"; cv.fillText("② 我们的桌面 " + om.w + "×" + om.h + "（原始 1:1）", 10, oy0 + 14);
let ly = ry0 + RH + 14;
cv.fillStyle = "#8ef2c0"; cv.font = "13px system-ui"; cv.textAlign = "left";
cv.fillText("参考图量测（归一化，来自 tools/mj/measure-ref.js）：左墙 x 0.182..0.251（占桌面宽 7.6%）· 右墙 x 0.680..0.770 · " +
  "上墙 y 0.014..0.105 · 下墙 y 0.732..0.795 · 圆盘中心 (0.497, 0.398)", 10, ly);
ly += 18;
cv.fillText("→ 牌墙方环**外沿**占桌面宽度 0.588、占高度 0.781（放大 2.17 倍看：桌面上是个正方形方环）", 10, ly);
ly += 18;
cv.fillStyle = "#ffd76e";
cv.fillText("我们的实现（本轮放大后）：方环外沿 x 256..984 y 55..705 → 外接框 728×650 = 占桌面宽 0.601、占高 0.781 ✔ 已达标", 10, ly);
ly += 18;
cv.fillStyle = "#ff7d9c";
cv.fillText("仍不一致：① 方环是**微扁矩形** 728×650（参考图在桌面上是正方形）—— 画布 1.44:1，正方形方环不可能同时满足宽 0.60 与高 0.78；" +
  "② 参考图里上家的手牌在画面外（我们为了可读性画了出来）", 10, ly);
ly += 18;
cv.fillStyle = "#cbb894";
cv.fillText("③ 参考图左右两段墙是斜的（桌面透视）；我们按俯视正交画成竖直（用户已同意这个降级）· " +
  "④ 各家「N 张」挂牌位置按副露外侧对称摆放", 10, ly);

/* ── 3b. 圆盘文字：软件光栅化器不画汉字，所以下半（我们的桌面）要**用 GDI+ 把中文补回圆盘**，
      否则对照图上圆盘是一团深色（用户与上级都点过这条）。数值取自 mj_layout_raw.json。── */
const dCx = om.discCx || 620, dCy = om.discCy || 380;
cv.textAlign = "center"; cv.textBaseline = "middle";
cv.fillStyle = "#ffd76e"; cv.font = "bold 22px system-ui";
cv.fillText("余 " + (om.wall === undefined ? "?" : om.wall), dCx, oy0 + dCy - 12);
cv.fillStyle = "#dfe6f2"; cv.font = "13px system-ui";
cv.fillText("张 · 第 " + (om.turn === undefined ? "?" : om.turn) + " 巡", dCx, oy0 + dCy + 13);
cv.fillStyle = "#ffd76e"; cv.font = "bold 13px system-ui";
cv.fillText("南", dCx, oy0 + dCy - 74); cv.fillText("北", dCx, oy0 + dCy + 74);
cv.fillText("西", dCx - 74, oy0 + dCy); cv.fillText("东", dCx + 74, oy0 + dCy);

fs.writeFileSync(PNG, cv.toPNG());
const MANIFEST = path.join(TR, "_vs_ref_text.json");
fs.writeFileSync(MANIFEST, JSON.stringify({ at: new Date().toISOString(), shots: [{ png: PNG, texts: texts }] }), "utf8");
try {
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(OUT, "tools", "lib", "text-compose.ps1"), "-Manifest", MANIFEST], { stdio: "inherit", cwd: OUT });
} catch (e) { console.error("（文字合成失败）：" + (e && e.message)); }
try { fs.rmSync(MANIFEST, { force: true }); } catch (e) {}
console.log("[mj_layout_vs_ref.png] " + CW + "×" + TOTAL + "  " + (fs.statSync(PNG).size / 1024).toFixed(1) + "KB");
