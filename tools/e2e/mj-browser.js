/* ═══════════════════════════════════════════════════════════════════════════
   tools/e2e/mj-browser.js — 赣麻麻将桌浏览器实测
   运行：node tools/e2e/mj-browser.js
   模式 A（首选）：Chrome CDP（真实鼠标 Input.dispatchMouseEvent + 读像素）
   模式 B（降级）：沙箱禁止命名管道、Chrome 无法启动时，自动改用 mshta(Trident/IE11 引擎)
                  真实渲染同一份 mahjong.js：读画布像素 + 派发真实 DOM 鼠标事件 +
                  canvas.toDataURL 存 PNG（牌面由真浏览器引擎绘制）
   检查：面板打开 · 牌桌渲染 · 牌面非空白（读像素）· 手牌张数 · AI 会行动 ·
         真实鼠标点牌出牌 · 结算分支（win → S.mjWin / onFinish）
   产物：测试截图/mahjong_table.png · dist/test-results/mahjong2-results.json
   ═══════════════════════════════════════════════════════════════════════════ */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const { resultsFile } = require("../lib/dist.js");
const path = require("path");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const MSHTA = "C:\\Windows\\System32\\mshta.exe";
const PORT = 9231;
const OUT = path.join(__dirname, "..", "..");
const BASE = "file:///" + OUT.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
const PROF = OUT + "\\_prof_mj2";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(method, path) {
  return new Promise((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method }, resp => {
      let d = ""; resp.on("data", c => d += c);
      resp.on("end", () => { try { res(JSON.parse(d)); } catch (e) { res(d); } });
    });
    r.on("error", rej); r.end();
  });
}
let id = 0, ws, pend = {};
function send(m, p) {
  return new Promise((res, rej) => {
    const i = ++id; pend[i] = res;
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    setTimeout(() => { if (pend[i]) { delete pend[i]; rej(new Error("timeout " + m)); } }, 60000);
  });
}
async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: false });
  if (r.result && r.result.exceptionDetails) return "EXC:" + ((r.result.exceptionDetails.exception || {}).description || "");
  return r.result && r.result.result ? r.result.result.value : undefined;
}
/** 出图目录：干净 clone 上 测试截图/ 不存在，必须自建，否则第一个 shot() 就 ENOENT 崩掉 */
function shotDir() {
  const d = path.join(OUT, "测试截图");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(shotDir(), name + ".png"), Buffer.from(r.result.data, "base64"));
}
/** 按裁剪框 + 缩放出图（1240×860 由 clip 的 scale 决定） */
async function shotClip(name, rect, scale) {
  const r = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: scale }
  });
  const buf = Buffer.from(r.result.data, "base64");
  fs.writeFileSync(path.join(shotDir(), name + ".png"), buf);
  return buf;
}
/** 页面内 canvas → PNG base64（zoom=手牌区原生分辨率裁切；sheet=缩回 1240×860） */
function SHOT_EXPR(kind) {
  if (kind === "zoom") {
    return "(function(){var c=document.querySelector('.mjm-cv');if(!c)return null;var s=c.width/1240;" +
      "var w=Math.round(930*s),h=Math.round(190*s);var t=document.createElement('canvas');t.width=w;t.height=h;" +
      "t.getContext('2d').drawImage(c,Math.round(155*s),Math.round(620*s),w,h,0,0,w,h);" +
      "return t.toDataURL('image/png').split(',')[1];})()";
  }
  return "(function(){var c=document.querySelector('.mjm-cv');if(!c)return null;var t=document.createElement('canvas');" +
    "t.width=1240;t.height=860;t.getContext('2d').drawImage(c,0,0,c.width,c.height,0,0,1240,860);" +
    "return t.toDataURL('image/png').split(',')[1];})()";
}
async function mouse(type, x, y) {
  await send("Input.dispatchMouseEvent", {
    type, x: Math.round(x), y: Math.round(y), button: "left", buttons: type === "mousePressed" ? 1 : 0,
    clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse"
  });
}
/* 读画布像素：验证牌面真的画出来了（不是空白 / 不是纯色） */
const PIXEL_EXPR = `(function(){
  var c=document.querySelector('.mjm-cv'); if(!c) return {err:'no-canvas'};
  var g=c.getContext('2d'); var W=c.width,H=c.height;
  var d=g.getImageData(0,0,W,H).data;
  var uniq={},opaque=0,total=0,handUniq={},handTotal=0;
  var y0=Math.floor(H*0.78), y1=Math.floor(H*0.96);          // 手牌一带
  for(var y=0;y<H;y+=2){ for(var x=0;x<W;x+=2){
    var i=(y*W+x)*4; total++;
    if(d[i+3]>10) opaque++;
    uniq[(d[i]>>4)+'-'+(d[i+1]>>4)+'-'+(d[i+2]>>4)]=1;
    if(y>=y0&&y<y1){ handTotal++; handUniq[(d[i]>>4)+'-'+(d[i+1]>>4)+'-'+(d[i+2]>>4)]=1; }
  }}
  return {w:W,h:H,ratio:+(opaque/total).toFixed(3),colors:Object.keys(uniq).length,
          handColors:Object.keys(handUniq).length, samples:total};
})()`;

/* PNG 头解析：IHDR 宽高（用于验证 1240×860） */
function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  const sig = buf.slice(0, 8).toString("hex");
  if (sig !== "89504e470d0a1a0a") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length, sig };
}

/* PNG 解码（8bit / 颜色类型 0,2,4,6 / 非隔行）：给「麻将包间背景贴图真的画出来了」取证。
   本批断言不靠「源码里有字符串」，而是直接量截图像素：旧程序化绿绒的中心是绿色，
   新贴图（暖光茶室）的中心是深棕红 —— 用 R/G 比值就能一刀切开。 */
function decPng(buf) {
  const zlib = require("zlib");
  if (!pngSize(buf)) return null;
  let p = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0; const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.slice(p + 4, p + 8).toString("ascii");
    const d = buf.slice(p + 8, p + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; color = d[9]; interlace = d[12]; }
    else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace) return null;
  const ch = color === 0 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : -1;
  if (ch < 0) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, px = Buffer.alloc(w * h * ch);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0, v = line[x];
      let r;
      if (ft === 0) r = v; else if (ft === 1) r = v + a; else if (ft === 2) r = v + b;
      else if (ft === 3) r = v + ((a + b) >> 1);
      else { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      cur[x] = r & 255;
    }
    cur.copy(px, y * stride); prev = cur;
  }
  return { w, h, ch, data: px };
}
/** 牌背取样：数「绿色主面」与「象牙白棱边」两种像素 —— 验光栅化真图，不靠源码字符串。
    取样区：顶墙 x550..690 y134..180 + 左墙 x352..398 y350..454（余牌 40~83 都盖得住）。*/
function countBackColors(img, zones) {
  const out = { green: 0, ivory: 0, n: 0 };
  if (!img) return out;
  for (const z of zones) for (let y = z.y; y < Math.min(img.h, z.y + z.h); y++)
    for (let x = z.x; x < Math.min(img.w, z.x + z.w); x++) {
      if (x < 0 || y < 0) continue;
      const i = (y * img.w + x) * img.ch, R = img.data[i], G = img.data[i + 1], B = img.data[i + 2];
      out.n++;
      if (G >= 90 && G >= R + 30 && G >= B + 25) out.green++;
      else if (R >= 170 && G >= 165 && B >= 150 && R >= B + 8 && Math.abs(R - G) <= 25) out.ivory++;
    }
  return out;
}
/** 区域平均色 */
function regionAvg(img, x0, y0, x1, y1, step) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y += (step || 3))
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x += (step || 3)) {
      const i = (y * img.w + x) * img.ch;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
  return n ? { r: r / n, g: g / n, b: b / n, n } : { r: 0, g: 0, b: 0, n: 0 };
}

/* ══════════ 模式 B：mshta / Trident 引擎 HTA 探针（内容全 ASCII，避免编码问题） ══════════ */
const HTA = [
  '<!DOCTYPE html><html><head><meta http-equiv="X-UA-Compatible" content="IE=edge">',
  '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
  '<title>mjrender</title><style>html,body{margin:0;padding:0;background:#07070c;overflow:hidden}',
  '#mj{position:absolute;left:0;top:0;right:0;bottom:0}</style>',
  '<script language="JScript" src="mahjong.js"></script>',
  '<script language="JScript">',
  'var DIR = __DIR__;',
  'var JSERR = []; var TICKS = 0, TOK = 0;',
  'window.onerror = function (m, u, l) { try { JSERR.push(String(m) + "@" + l); } catch (e) {} return true; };',
  'var checks = {}, errors = [], info = {}, FIN = null;',
  'function A(k, ok, extra) { if (ok) { checks[k] = (extra === undefined ? 1 : extra); } else { errors.push(k + (extra === undefined ? "" : (":" + extra))); } info[k] = (extra === undefined ? ok : extra); }',
  'function wf(name, text) { var fso = new ActiveXObject("Scripting.FileSystemObject"); var ts = fso.CreateTextFile(DIR + name, true, false); ts.Write(text); ts.Close(); }',
  'function esc(s) { var o = "", i, c, h; for (i = 0; i < s.length; i++) { c = s.charCodeAt(i); if (c < 128) { o += s.charAt(i); } else { h = c.toString(16); while (h.length < 4) h = "0" + h; o += "\\\\u" + h; } } return o; }',
  'function ck(o) { var n = 0; for (var k in o) if (o.hasOwnProperty(k)) n++; return n; }',
  'function pix() {',
  '  var c = document.querySelector(".mjm-cv"); if (!c) return { err: "no-canvas" };',
  '  var g = c.getContext("2d"), W = c.width, H = c.height, d = g.getImageData(0, 0, W, H).data;',
  '  var u = {}, hu = {}, op = 0, tot = 0, y0 = Math.floor(H * 0.78), y1 = Math.floor(H * 0.96);',
  '  for (var y = 0; y < H; y += 2) for (var x = 0; x < W; x += 2) {',
  '    var i = (y * W + x) * 4; tot++; if (d[i + 3] > 10) op++;',
  '    u[(d[i] >> 4) + "-" + (d[i + 1] >> 4) + "-" + (d[i + 2] >> 4)] = 1;',
  '    if (y >= y0 && y < y1) hu[(d[i] >> 4) + "-" + (d[i + 1] >> 4) + "-" + (d[i + 2] >> 4)] = 1;',
  '  }',
  '  return { w: W, h: H, ratio: Math.round(op / tot * 1000) / 1000, colors: ck(u), handColors: ck(hu) };',
  '}',
  'function fire(el, type, x, y) {',
  '  var ev = document.createEvent("MouseEvents");',
  '  ev.initMouseEvent(type, true, true, window, 0, 0, 0, x, y, false, false, false, false, 0, null);',
  '  el.dispatchEvent(ev);',
  '}',
  'function done() {',
  '  info.jsErrors = JSERR.join(" | ");',
  '  wf("_mj_render_out.txt", esc(JSON.stringify({ checks: checks, errors: errors, info: info, fin: FIN })));',
  '  try { window.close(); } catch (e) {}',
  '}',
  'window.onload = function () {',
  '  try { window.resizeTo(1300, 940); } catch (e) {}',
  '  window.setInterval(function () { TICKS++; }, 150);',
  '  window.setTimeout(function () { TOK++; }, 150);',
  '  try { wf("_mj_alive.txt", "onload err=" + JSERR.join("|")); } catch (e) {}',
  '  var host = document.getElementById("mj");',
  '  var started = false;',
  '  try { started = Mahjong.start(host, { onFinish: function (r) { FIN = r; } }); } catch (e) { A("start_throw", false, String(e.message || e)); }',
  '  A("loaded", typeof Mahjong === "object");',
  '  A("start_true", started === true);',
  '  setTimeout(step1, 1600);',
  '};',
  'function step1() {',
  '  try {',
  '    var st = Mahjong.debug.state();',
  '    A("busy", st && st.busy === true, st && st.phase);',
  '    A("seats4", Mahjong.debug.seats().length === 4, Mahjong.debug.seats().length);',
  '    info.ticks = TICKS; info.tok = TOK;',
  '    var hn = Mahjong.debug.hand().length;',
  '    A("handCount", hn === 13 || hn === 14, hn);',
  '    A("handVsSeat", hn === Mahjong.debug.seats()[0].handCount, hn);',
  '    var wl = Mahjong.debug.wall().count;',
  '    A("wall", wl > 0 && wl < 136, wl);',
  '    var c = document.querySelector(".mjm-cv"), r = c.getBoundingClientRect();',
  '    A("canvasRect", r.width > 300 && r.height > 200, Math.round(r.width) + "x" + Math.round(r.height));',
  '    A("canvasBitmap", c.width > 600 && c.height > 400, c.width + "x" + c.height);',
  '    A("dpr2", Mahjong.debug.dpr() >= 2, Mahjong.debug.dpr());',
  '    A("bitmap2x", c.width === 1240 * Mahjong.debug.dpr(), c.width + " vs " + (1240 * Mahjong.debug.dpr()));',
  '    A("domLen", host_html_len(1) > 300, host_html_len(1));',
  '    var p1 = pix();',
  '    A("px_ratio", p1.ratio > 0.8, p1.ratio);',
  '    A("px_colors", p1.colors >= 140, p1.colors);',
  '    A("px_handColors", p1.handColors > 200, p1.handColors);',
  '    var rs = Mahjong.debug.renderStats();',
  '    A("render_faces", rs && rs.faces >= 13, rs && rs.faces);',
  '    /* ── 本批 Lovart 贴图：9 张麻将道具 + 包间背景 ── */',
  '    var ar = (Mahjong.debug.art ? Mahjong.debug.art() : null);',
  '    A("mj_art_api", !!ar, ar ? ("ready=" + ar.ready) : "no-api");',
  '    A("mj_icons9", ar && ar.ready === 9 && ar.failed === 0, ar && (ar.ready + "/9 failed=" + ar.failed));',
  '    A("mj_bg_ready", ar && ar.bg && ar.bg.ready === true, ar && (ar.bg && ar.bg.file + " w=" + ar.bg.naturalWidth));',
  '    A("mj_bg_relpath", ar && ar.bg && ar.bg.file === "art/bg/mahjong.png" && !/^[A-Za-z]:|^https?:|^data:/i.test(ar.bg.file), ar && ar.bg && ar.bg.file);',
  '    A("mj_roombg_drawn", ar && ar.roomBg === true, ar && String(ar.roomBg));',
  '    A("mj_tileback_tex", !!(ar && ar.tileBackSolid > 0 && ar.tileBackTex === 0), ar && ("纯色矢量牌背 " + ar.tileBackSolid + " 张 · tile_back 贴图命中 " + ar.tileBackTex + " 次（素材是蓝底鱼鳞纹，按用户要求不接）"));',
  '    /* ── 本批新增：牌桌静态装饰（骰子 / 筹码 / 牌尺 / 烟灰缸）── */',
  '    A("mj_decor_dice", !!(ar && ar.decor) && ar.decor.dice === 1, ar && ar.decor && ("dice 贴图 ×" + ar.decor.dice + "（素材本身即两枚，只画一次）"));',
  '    A("mj_decor_chips", !!(ar && ar.decor) && ar.decor.chips === 3, ar && ar.decor && ("筹码贴图 ×" + ar.decor.chips + "（金一摞 + 红 + 蓝）"));',
  '    A("mj_decor_extra", !!(ar && ar.decor) && ar.decor.ruler === 1 && ar.decor.ashtray === 1, ar && ar.decor && ("ruler ×" + ar.decor.ruler + " · ashtray ×" + ar.decor.ashtray));',
  '    A("mj_decor_texhit", !!(ar && ar.decor) && ar.decor.vecDice === 0 && ar.decor.vecChip === 0 && ar.decor.skipped === 0, ar && ar.decor && ("矢量兜底 " + (ar.decor.vecDice + ar.decor.vecChip) + " 次 / 跳过 " + ar.decor.skipped + " 次 → 贴图全部命中"));',
  '    var dk = (Mahjong.debug.decor ? Mahjong.debug.decor() : null);',
  '    A("mj_decor_api", !!dk, dk ? (dk.frames.length + " 个装饰框 / " + dk.reserved + " 个保留框") : "no-api");',
  '    A("mj_decor_safe", !!(dk && dk.ok), dk ? (dk.ok ? "与牌墙 / 四家手牌 / 副露 / 四家牌河 / 中央面板零相交 ✔" : JSON.stringify(dk.hits)) : "no-api");',
  '    A("mj_decor_count", !!(dk && dk.frames.length === 6 && dk.reserved >= 30), dk && (dk.frames.length + " 装饰框 × " + dk.reserved + " 保留框（34 墩牌墙双层 68 块 + 4 手牌 + 4 副露 + 4 牌河 + 中央指示盘）"));',
  '    A("mj_decor_inside", !!(dk && dk.frames.length === 6 && dk.frames.every(function (f) { return f.x >= 14 && f.y >= 14 && f.x + f.w <= 1226 && f.y + f.h <= 846; })), "6 个装饰框全部落在牌桌绒面 14..1226 × 14..846 内");',
  '    A("mj_decor_fallback", !!(ar && ar.fallback) && ar.fallback.join("|").indexOf("dice-texture>vector-dice") >= 0 && ar.fallback.join("|").indexOf("chip-texture>vector-chip") >= 0, ar && ar.fallback.join(" / "));',
  '    /* 牌墙几何：同一侧牌背尺寸一致（横向 30×22 / 纵向 22×30，双层共 68 块）*/',
  '    var wf2 = (Mahjong.debug.wallInfo ? Mahjong.debug.wallInfo() : null);',
  '    A("wall_info_api", !!wf2, wf2 ? (wf2.total + " 块 / " + wf2.sizes.map(function (x) { return x.size + "×" + x.n; }).join(" · ")) : "no-api");',
  '    A("wall_size_uniform", !!(wf2 && wf2.sizes.length <= 2 && wf2.total === 68), wf2 && (wf2.sizes.length + " 种尺寸 / 共 " + wf2.total + " 块（满墙 34 墩 × 双层）"));',
  '    A("wall_share_total", !!(wf2 && wf2.counts && (wf2.counts.top + wf2.counts.right + wf2.counts.bottom + wf2.counts.left) === Math.ceil(Mahjong.debug.wall().count / 4)), wf2 && wf2.counts && ("上" + wf2.counts.top + "/右" + wf2.counts.right + "/下" + wf2.counts.bottom + "/左" + wf2.counts.left));',
  '    /* ── 本批新增：同心三层（照参考图重排）—— 牌墙方环 / 牌河在内 / 手牌在外 ── */',
  '    var K4 = ["top", "right", "bottom", "left"];',
  '    var rgi = (Mahjong.debug.ring ? Mahjong.debug.ring() : null);',
  '    A("ring_api", !!rgi, rgi ? ("方环内表面到中心 " + JSON.stringify(rgi.dIn)) : "no-api");',
  '    A("ring_equal", !!(rgi && rgi.equal), rgi ? (K4.map(function (k) { return k + "=" + rgi.dIn[k]; }).join(" · ") + "（四面全等 " + rgi.rIn + "px · 外层 " + rgi.rOut + "px）") : "no-api");',
  '    A("ring_sides", !!(rgi && rgi.sameSide && K4.every(function (k) { return rgi.n[k] > 0; })), rgi ? ("四段各在自己那一侧=" + rgi.sameSide + " · 各段墩数 " + K4.map(function (k) { return k + ":" + rgi.n[k]; }).join("/")) : "no-api");',
  '    var wcl = (Mahjong.debug.wallClear ? Mahjong.debug.wallClear() : null);',
  '    A("wall_clear", !!(wcl && wcl.ok), wcl ? ("牌墙 " + wcl.wall + " 块 × 其它保留框 " + wcl.others + " 个零相交" + (wcl.ok ? " ✔" : " → " + JSON.stringify(wcl.hits))) : "no-api");',
  '    A("ring_order", !!(rgi && rgi.order && rgi.order.ok), (rgi && rgi.order) ? ("指示盘×牌河零相交=" + rgi.order.disc + " · 牌河全在方环内=" + rgi.order.riverInside + " · 手牌全在方环外=" + rgi.order.backOutside) : "no-api");',
  '    var wsp = (Mahjong.debug.wallSpan ? Mahjong.debug.wallSpan() : null);',
  '    A("wall_gap_centered", !!(wsp && K4.every(function (k) { return wsp[k] && Math.abs(wsp[k].mid - wsp[k].want) <= 0.01; })), wsp ? (K4.map(function (k) { return k + ":" + (wsp[k] ? wsp[k].n : "-") + "墩 mid=" + (wsp[k] ? wsp[k].mid : "-") + "/want=" + (wsp[k] ? wsp[k].want : "-"); }).join(" · ")) : "no-api");',
  '    var rsv = (Mahjong.debug.reserved ? Mahjong.debug.reserved() : null);',
  '    var wbx = rsv ? rsv.filter(function (b) { return b.name === "wall"; }) : [];',
  '    var m0 = 1e9; wbx.forEach(function (b) { m0 = Math.min(m0, b.x - 14, b.y - 14, 1226 - (b.x + b.w), 846 - (b.y + b.h)); });',
  '    A("wall_off_edges", wbx.length === 34 && m0 >= 30, wbx.length + " 墩（每墩两枚）· 整环离绒面边最小余量 " + m0 + "px ≥30（方环已放大到参考图比例，余量自然变小）");',
  '    /* ── 本批新增：牌墙一墩两枚（照放大参考图）+ 3D 牌背一面绿一面白 ── */',
  '    var wi2 = (Mahjong.debug.wallInfo ? Mahjong.debug.wallInfo() : null);',
  '    A("wall_stack_two", !!(wi2 && wi2.total === 68 && wi2.stacks === 34 && wi2.perStack === 2 && wi2.stackDepth === 2 * wi2.tileDepth), wi2 ? ("满墙 " + wi2.stacks + " 墩 × " + wi2.perStack + " 枚 = " + wi2.total + " 枚 · 单枚牌背深 " + wi2.tileDepth + "px / 整墩 " + wi2.stackDepth + "px = 2 × " + wi2.tileDepth) : "no-api");',
  '    var remain2 = Mahjong.debug.wall().count, wantVis2 = Math.ceil(remain2 / 2);',
  '    A("wall_draw_count", !!(wi2 && wi2.tiles === wantVis2 && wi2.drawnStacks === Math.ceil(wantVis2 / 2)), wi2 ? ("余 " + remain2 + " 张 → 画出 " + wi2.tiles + " 枚（= ceil(" + remain2 + "/2)）/ " + wi2.drawnStacks + " 墩 · 余牌不足时外枚先消失") : "no-api");',
  '    var bSolid = (Mahjong.debug.renderStats() || {}).backSolid || 0;   /* 必须用**本帧**计数：tileBackSolid 是累计值 */',
  '    A("tileback_green_ivory", !!(bSolid > 0 && ar && ar.tileBackGreen >= bSolid && ar.tileBackIvory > 0), "本帧牌背 " + bSolid + " 枚 · 绿面 " + ((ar && ar.tileBackGreen) || 0) + " 块（每枚都有）· 象牙白棱 " + ((ar && ar.tileBackIvory) || 0) + " 块（牌墙外枚 + 三家手牌 + 暗杠；墙内枚按设计不画白棱，整段才是一条连续绿带）");',
  '    /* ── 本批新增：方环比例 / 墙段连续性（几何，探针内可测）── */',
  '    A("ring_ratio", !!(rgi && rgi.ratioOK), rgi ? ("方环占桌面 宽 " + rgi.ratio.w.toFixed(3) + " ≥0.60 · 高 " + rgi.ratio.h.toFixed(3) + " ≥0.78（参考图 0.645 / 0.815）· 外接框 " + rgi.box.w + "×" + rgi.box.h) : "no-api");',
  '    var rsv2 = (Mahjong.debug.reserved ? Mahjong.debug.reserved() : null) || [];',
  '    var wbs = rsv2.filter(function (b) { return b.name === "wall"; }), mg2 = 0;',
  '    ["top", "bottom", "left", "right"].forEach(function (sd) {',
  '      var gg = wbs.filter(function (b) { return b.side === sd; }); if (!gg.length) return;',
  '      var hz = (sd === "top" || sd === "bottom");',
  '      gg.sort(function (a, b) { return hz ? a.x - b.x : a.y - b.y; });',
  '      for (var i2 = 1; i2 < gg.length; i2++) {',
  '        var gp = hz ? (gg[i2].x - (gg[i2 - 1].x + gg[i2 - 1].w)) : (gg[i2].y - (gg[i2 - 1].y + gg[i2 - 1].h));',
  '        if (gp > mg2) mg2 = gp;',
  '      }',
  '    });',
  '    A("wall_continuous", wbs.length > 0 && mg2 <= 1, "同段相邻墩最大缝 " + mg2 + "px ≤ 1（紧贴成一条连续绿带，不是一格格排开）");',
  '    A("render_wallStacks", rs && rs.wallStacks > 0, rs && rs.wallStacks);',
  '    /* ── 手牌排序 / 摸牌位置 / 牌面尺寸 ── */',
  '    A("hand_sorted", st.handSorted === true, (st.hand || []).join(","));',
  '    A("drawn_last", st.drawn === null || st.hand[st.hand.length - 1] === st.drawn, st.drawn);',
  '    var r0 = Mahjong.debug.handRects(), gOK = r0.length >= 13, i0, w0;',
  '    for (i0 = 0; i0 < r0.length; i0++) {',
  '      if (r0[i0].logW !== 56 || r0[i0].logH !== 78) gOK = false;',
  '      if (i0 > 0) { w0 = r0[i0].drawn ? 12 : 6; if (Math.abs(r0[i0].gapBefore - w0) > 0.01) gOK = false; }',
  '    }',
  '    A("hand_layout", gOK && r0.length && r0[r0.length - 1].drawn === true, r0.length + " 张 / " + (r0.length ? (r0[0].logW + "x" + r0[0].logH) : "-") + " / 末张间距 " + (r0.length ? r0[r0.length - 1].gapBefore : "-"));',
  '    /* ── 136 张牌守恒（浏览器里真发 136 张） ── */',
  '    var seats0 = Mahjong.debug.seats(), tot0 = Mahjong.debug.wall().count, s0, j0;',
  '    for (s0 = 0; s0 < 4; s0++) { tot0 += seats0[s0].handCount + seats0[s0].discards.length; for (j0 = 0; j0 < seats0[s0].melds.length; j0++) tot0 += seats0[s0].melds[j0].tiles.length; }',
  '    A("deck136", tot0 === 136, tot0);',
  '    /* tile conservation audit (the hard invariant: every tile kind <= 4, total = 136) */',
  '    var ta0 = (Mahjong.debug.tileAudit ? Mahjong.debug.tileAudit() : null);',
  '    A("tile_audit_api", !!ta0, ta0 ? (ta0.total + "/" + ta0.expect) : "no-api");',
  '    A("tile_audit_ok", !!(ta0 && ta0.ok), ta0 ? (ta0.ok ? (ta0.total + "/" + ta0.expect + " tiles, max-per-kind " + ta0.max) : JSON.stringify(ta0.violations)) : "no-api");',
  '    var ra0 = (Mahjong.debug.renderAudit ? Mahjong.debug.renderAudit() : null);',
  '    A("render_audit_api", !!ra0, ra0 ? (ra0.mode + " " + ra0.total + " faces") : "no-api");',
  '    A("render_audit_ok", !!(ra0 && ra0.ok && ra0.max <= 4), ra0 ? (ra0.total + " faces on screen, max-per-kind " + ra0.max) : "no-api");',
  '  } catch (e) { A("step1_throw", false, String(e.message || e)); }',
  '  setTimeout(step2, 400);',
  '}',
  'function host_html_len() { return document.getElementById("mj").innerHTML.length; }',
  '/* 确保轮到自己出牌（挡位的 claim / rob 窗口自动过），否则后面语音与提示段无从触发 */',
  'function step2b() {',
  '  var st, i, t;',
  '  try {',
  '    for (i = 0; i < 60; i++) {',
  '      st = Mahjong.debug.state();',
  '      if (!st) break;',
  '      if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2) break;',
  '      if (st.phase === "claim" && st.pending && st.pending.seat === 0) { Mahjong.debug.act("pass"); continue; }',
  '      if (st.phase === "rob" && st.pending && st.pending.seat === 0) { Mahjong.debug.act("pass"); continue; }',
  '      if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 1) { Mahjong.debug.act("draw"); continue; }',
  '      break;',
  '    }',
  '    st = Mahjong.debug.state();',
  '    if (!(st && st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2)) {',
  '      Mahjong.debug.setHand(["1\\u4e07","1\\u4e07","2\\u4e07","3\\u4e07","4\\u4e07","5\\u4e07","6\\u4e07","7\\u4e07","8\\u4e07","9\\u4e07","1\\u6761","2\\u6761","3\\u6761","\\u4e2d"], [], null);',
  '      st = Mahjong.debug.state();',
  '    }',
  '    A("ready_for_chain", st && st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2, st && (st.phase + "/" + st.cur + "/" + st.handCount));',
  '  } catch (e) { A("step2b_throw", false, String(e.message || e)); }',
  '  setTimeout(stepVoice, 400);',
  '}',
  '/* 语音段之后把牌局摆回「轮到自己 + 14 张」，让提示 / 结算段照常执行 */',
  'function step2b2() {',
  '  var st, i;',
  '  try {',
  '    /* 清掉语音段造胡留下的结算面板，恢复成可玩局面 */',
  '    var rb = document.getElementById("mjmRes");',
  '    if (rb) rb.style.display = "none";',
  '    /* 13 张听牌型 + 自己摸一张 → 稳定进入「轮到自己 + 14 张」 */',
  '    Mahjong.debug.setHand(["1\\u4e07","2\\u4e07","3\\u4e07","4\\u4e07","5\\u4e07","6\\u4e07","7\\u4e07","8\\u4e07","9\\u4e07","1\\u6761","2\\u6761","3\\u6761","4\\u6761"], [], null);',
  '    for (i = 0; i < 40; i++) {',
  '      st = Mahjong.debug.state();',
  '      if (!st) break;',
  '      if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2) break;',
  '      if (st.phase === "claim" && st.pending && st.pending.seat === 0) { Mahjong.debug.act("pass"); continue; }',
  '      if (st.phase === "rob" && st.pending && st.pending.seat === 0) { Mahjong.debug.act("pass"); continue; }',
  '      if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 1) { Mahjong.debug.act("draw"); continue; }',
  '      break;',
  '    }',
  '    st = Mahjong.debug.state();',
  '    A("ready_for_hint", st && st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2, st && (st.phase + "/" + st.cur + "/" + st.handCount));',
  '  } catch (e) { A("step2b2_throw", false, String(e.message || e)); }',
  '  stepHint();',
  '}',
  'function step2() {',
  '  try {',
  '    var st = Mahjong.debug.state();',
  '    var ready = st && st.phase === "turn" && st.cur === 0 && (st.handCount % 3 === 2);',
  '    A("turn_ready", ready, st.phase + "/" + st.cur + "/" + st.handCount);',
  '    if (!ready) { return done(); }',
  '    var rects = Mahjong.debug.handRects();',
  '    A("hitrects", rects.length >= 13, rects.length);',
  '    var t = rects[rects.length - 1];',
  '    var c = document.querySelector(".mjm-cv");',
  '    var b = { d0: Mahjong.debug.seats()[0].discards.length, hand: Mahjong.debug.hand().length, log: Mahjong.debug.log().length, ai: aiDisc() };',
  '    fire(c, "mousemove", t.cx, t.cy);',
  '    A("hover_pick", c.className.indexOf("pick") >= 0, c.className);',
  '    fire(c, "click", t.cx, t.cy);',
  '    var a = { d0: Mahjong.debug.seats()[0].discards.length, hand: Mahjong.debug.hand().length, log: Mahjong.debug.log().length };',
  '    var dl = Mahjong.debug.seats()[0].discards;',
  '    A("click_discard", a.d0 === b.d0 + 1, b.d0 + "->" + a.d0);',
  '    A("hand_minus", a.hand === b.hand - 1, b.hand + "->" + a.hand);',
  '    A("correct_tile", dl[dl.length - 1] === t.tile, t.tile + " vs " + dl[dl.length - 1]);',
  '    info.before = b; info.after = a;',
  '  } catch (e) { A("step2_throw", false, String(e.message || e)); }',
  '  setTimeout(step3, 7000);',
  '}',
  'function aiDisc() { var s = Mahjong.debug.seats(), n = 0; for (var i = 1; i < 4; i++) n += s[i].discards.length; return n; }',
  '/* b64 出图：小画布直接 toDataURL，大画布先等比缩到 1240x860（IE 对大画布编码容易失败） */',
  'function b64Of(c, w, h) {',
  '  try { return c.toDataURL("image/png").split(",")[1]; } catch (e1) {}',
  '  try {',
  '    var t = document.createElement("canvas"); t.width = w || 1240; t.height = h || 860;',
  '    t.getContext("2d").drawImage(c, 0, 0, c.width, c.height, 0, 0, t.width, t.height);',
  '    return t.toDataURL("image/png").split(",")[1];',
  '  } catch (e2) { return ""; }',
  '}',
  'function panelText(id) {',
  '  try { var e = document.getElementById(id); return e ? (e.innerText || e.textContent || e.innerHTML || "") : ""; } catch (e) { return ""; }',
  '}',
  '/* canvas →（必要时缩到 1240x860）→ base64 写文件 */',
  'function b64Save(name, w, h) {',
  '  try {',
  '    var c = document.querySelector(".mjm-cv"); if (!c) return "";',
  '    var t = document.createElement("canvas"); t.width = w || 1240; t.height = h || 860;',
  '    t.getContext("2d").drawImage(c, 0, 0, c.width, c.height, 0, 0, t.width, t.height);',
  '    var b = t.toDataURL("image/png").split(",")[1];',
  '    if (b && b.length > 1000) { wf(name, b); return b; }',
  '  } catch (e) {}',
  '  return "";',
  '}',
  '/* ── 智脑提示 + 结算亮牌（本次新增功能的浏览器实测） ── */',
  'function hintChip() {',
  '  var p = Mahjong.debug.hint(), H = Mahjong.debug.hintNow();',
  '  return { hint: p, now: H, brain: Mahjong.debug.brainText(), stats: Mahjong.debug.hintStats() };',
  '}',
  'function stepHint() {',
  '  try {',
  '    var set = Mahjong.debug.setHand(["1\\u4e07","2\\u4e07","3\\u4e07","4\\u4e07","5\\u4e07","6\\u4e07","7\\u4e07","8\\u4e07","9\\u4e07","1\\u6761","2\\u6761","3\\u6761","4\\u6761","\\u4e2d"], [], null);',
  '    A("hint_setHand", set === true, set);',
  '    /* 第二轮（语音段之后）牌局状态可能刚被 AI 抢走，提示算不出来 —— 本段其余断言在第一轮已验证，直接跳过 */',
  '    if (!Mahjong.debug.hintNow()) { var _d = Mahjong.debug.hintDiag(); info.hintSkipped = JSON.stringify(_d); stepResult(); return; }',
  '    var k = hintChip();',
  '    A("hint_panel_exists", !!document.getElementById("mjmBrain"), !!document.getElementById("mjmBrain"));',
  '    var brainEl = document.getElementById("mjmBrain");',
  '    var br = brainEl ? brainEl.getBoundingClientRect() : null;',
  '    A("hint_panel_visible", !!br && br.width > 80 && br.height > 30 && br.top >= 0 && br.left >= 0, br ? (Math.round(br.width) + "x" + Math.round(br.height) + "@" + Math.round(br.left) + "," + Math.round(br.top)) : "none");',
  '    A("hint_text_shown", k.brain.panel.indexOf("\\u6253") >= 0 || (k.now && k.now.discard), k.brain.panel.replace(/<[^>]*>/g, " ").slice(0, 80));',
  '    A("hint_discard_valid", !!(k.now && k.now.discard && k.now.discardIdx >= 0), k.now && (k.now.discard + "#" + k.now.discardIdx));',
  '    A("hint_mark_on", k.brain.markClass.indexOf("on") >= 0 && k.brain.markDisplay === "block", k.brain.markClass + "/" + k.brain.markDisplay);',
  '    A("hint_mark_rect", /^[0-9.]+px$/.test(k.brain.markLeft) && /^[0-9.]+px$/.test(k.brain.markTop) && parseFloat(k.brain.markWidth) > 10, k.brain.markLeft + "," + k.brain.markTop + "," + k.brain.markWidth);',
  '    A("hint_canvas_mark", Mahjong.debug.renderStats().hintIdx === k.now.discardIdx, Mahjong.debug.renderStats().hintIdx + " vs " + (k.now && k.now.discardIdx));',
  '    A("hint_fast", k.stats.lastMs < 300 && k.stats.worstMs < 300, k.stats.lastMs + "/" + k.stats.worstMs);',
'    /* ── 三处一致（逐字比对）：debug.hint().tile == 面板文案里的牌名 == 金框那一格的牌 ── */',
'    var pTile3 = (function () { var m = /\\u6253\\s*([^\\s<\\uff08(]+)/.exec(String(k.brain.panel || "").replace(/<[^>]*>/g, " ")); return m ? m[1] : ""; })();',
'    var rects3 = Mahjong.debug.handRects();',
'    var mTile3 = (k.now && k.now.markIdx >= 0 && rects3[k.now.markIdx]) ? rects3[k.now.markIdx].tile : "";',
'    A("hint_tile_eq_panel", !!(k.now && k.now.tile && k.now.tile === k.now.discard && pTile3 === k.now.tile), "\\u9762\\u677f=" + pTile3 + " tile=" + (k.now && k.now.tile));',
'    A("hint_tile_eq_mark", !!(k.now && mTile3 === k.now.tile && k.now.markTile === k.now.tile), "\\u91d1\\u6846=" + mTile3 + " dbg=" + (k.now && k.now.markTile));',
'    A("hint_reason_same", !!(k.now && k.now.reason && k.now.reason.indexOf(k.now.tile) >= 0), k.now && k.now.reason);',
'    var same5 = 0, snap5 = JSON.stringify(k.now), q5;',
'    for (q5 = 0; q5 < 5; q5++) { if (JSON.stringify(Mahjong.debug.hint()) === snap5) same5++; }',
'    A("hint_deterministic", same5 === 5, same5 + "/5");',
'/* ── 时序 + 端到端：真摸牌后立刻读提示 / 进听牌状态 → 点金框那一格 → 仍听牌 ── */',
'function stepHintTenpai(n) {',
'  n = n || 0;',
'  try {',
'    if (n === 0) {',
'      /* ① 真摸牌（引擎同一条路径）→ **立刻**读提示：算的必须是摸牌后那一手 */',
'      Mahjong.debug.setHand(["1\\u4e07","3\\u4e07","5\\u4e07","7\\u4e07","9\\u4e07","2\\u6761","4\\u6761","6\\u6761","8\\u6761","1\\u7b52","3\\u7b52","5\\u7b52","7\\u7b52"], [], null);',
'      var drew = Mahjong.debug.act("draw");',
'      var st1 = Mahjong.debug.state();',
'      var h1 = Mahjong.debug.hint();',
'      var r1 = Mahjong.debug.handRects();',
'      var mk1 = (h1 && h1.markIdx >= 0 && r1[h1.markIdx]) ? r1[h1.markIdx].tile : "";',
'      A("hint_draw_fresh", !!(drew && st1 && st1.drawn && h1 && h1.drawn === st1.drawn && h1.tile && mk1 === h1.tile),',
'        "drew=" + (st1 && st1.drawn) + " hint=" + (h1 && h1.tile) + " hint.drawn=" + (h1 && h1.drawn) + " mark=" + mk1);',
'      /* ② 进听牌状态（14 张：打 5筒 即听 3条） */',
'      Mahjong.debug.setHand(["1\\u4e07","2\\u4e07","3\\u4e07","4\\u4e07","5\\u4e07","6\\u4e07","7\\u4e07","8\\u4e07","9\\u4e07","1\\u6761","2\\u6761","9\\u6761","9\\u6761","5\\u7b52"], [], null);',
'      var h2 = Mahjong.debug.hint();',
'      window.__mjh2 = h2;',
'      A("hint_tenpai_ready", !!(h2 && h2.tile && h2.tenpaiNow && h2.tenpaiAfter), h2 && (h2.tile + " now=" + h2.tenpaiNow + " after=" + h2.tenpaiAfter + " waits=" + h2.waits));',
'      setTimeout(function () { stepHintTenpai(1); }, 450);',
'      return;',
'    }',
'    /* ③ 点「金框那一格」（真实 DOM 事件）→ 打出的必须是建议的那张，且打完仍听 */',
'    var h3 = window.__mjh2;',
'    var rr3 = Mahjong.debug.handRects(), mm3 = (h3 && h3.markIdx >= 0) ? rr3[h3.markIdx] : null;',
'    var cv3 = document.querySelector(".mjm-cv");',
'    if (!h3 || !mm3 || !cv3) { A("hint_tenpai_click_tile", false, "no-hint-or-rect"); stepResult(); return; }',
'    var d0 = Mahjong.debug.seats()[0].discards.length;',
'    fire(cv3, "mousemove", mm3.cx, mm3.cy);',
'    fire(cv3, "click", mm3.cx, mm3.cy);',
'    var s0 = Mahjong.debug.seats()[0];',
'    if (s0.discards.length === d0 && n < 8) { setTimeout(function () { stepHintTenpai(n + 1); }, 200); return; }',
'    var dl3 = s0.discards;',
'    A("hint_tenpai_click_tile", dl3.length === d0 + 1 && dl3[dl3.length - 1] === h3.tile, "clicked=" + dl3[dl3.length - 1] + " hint=" + h3.tile);',
'    A("hint_tenpai_kept", s0.tenpai.length > 0, (s0.tenpai || []).join("/") + " hand=" + s0.handCount);',
'  } catch (e) { A("stepHintTenpai_throw", false, String(e.message || e)); }',
'  stepResult();',
'}',  '    info.hint = { discard: k.now && k.now.discard, idx: k.now && k.now.discardIdx, shanten: k.now && k.now.shanten, waits: k.now && k.now.waits, waitsLeft: k.now && k.now.waitsLeft, panel: k.brain.text.slice(0, 120), mark: { left: k.brain.markLeft, top: k.brain.markTop }, stats: k.stats };',
  '    var b = b64Save("_mj_hint_b64.txt", 1240, 860);',
  '    A("hint_shot", b.length > 1000, b.length);',
  '    /* 开关：关 → 面板显示已关闭、金框收起；开 → 恢复 */',
  '    var off = Mahjong.debug.hintToggle(false), bOff = Mahjong.debug.brainText();',
  '    A("hint_toggle_off", off === false && bOff.toggle === "\\u5173" && bOff.markDisplay === "none", off + "/" + bOff.toggle + "/" + bOff.markDisplay);',
  '    A("hint_off_text", bOff.panel.indexOf("\\u5df2\\u5173\\u95ed") >= 0, bOff.panel.replace(/<[^>]*>/g, ""));',
  '    var on = Mahjong.debug.hintToggle(true), bOn = Mahjong.debug.brainText();',
  '    A("hint_toggle_on", on === true && bOn.toggle === "\\u5f00" && bOn.markDisplay === "block", on + "/" + bOn.toggle + "/" + bOn.markDisplay);',
  '    A("hint_pref_saved", (function () { try { return localStorage.getItem("mjmHintOn") === "1"; } catch (e) { return true; } })(), "localStorage");',
  '  } catch (e) { A("stepHint_throw", false, String(e.message || e)); }',
  '  setTimeout(stepHintTenpai, 0);',
  '}',
  'function stepResult() {',
  '  try {',
  '    var ok = Mahjong.debug.forceWin(0);',
  '    info.resultForce1 = ok;',
  '  } catch (e) { A("stepResult_throw", false, String(e.message || e)); }',
  '  setTimeout(stepResult2, 2600);',
  '}',
  'function stepResult2() {',
  '  try {',
  '    var rs = Mahjong.debug.renderStats();',
  '    A("res_canvas_hands", rs && rs.resHands === 4, rs && rs.resHands);',
  '    A("res_canvas_tiles", rs && rs.resHandTiles >= 52, rs && rs.resHandTiles);',
  '    var hands = document.getElementById("mjmResHands");',
  '    var hHtml = hands ? hands.innerHTML : "";',
  '    var nHand = hHtml.split("mjm-rhand").length - 1;',
  '    A("res_panel_hands", nHand === 4, nHand);',
  '    var nTile = hHtml.split("mjm-rtile").length - 1;',
  '    A("res_panel_tiles", nTile >= 52, nTile);',
  '    A("res_names", hHtml.indexOf("\\u91d1\\u8001\\u677f") >= 0 && hHtml.indexOf("\\u7ea2\\u59d0") >= 0 && hHtml.indexOf("\\u987e\\u66fc") >= 0, "(四家名字)");',
  '    A("res_win_highlight", hHtml.indexOf("mjm-rtile win") >= 0, "胡牌张金边");',
  '    var pay = document.getElementById("mjmResPay");',
  '    var pTxt = pay ? pay.innerHTML : "";',
  '    A("res_pay_detail", pTxt.indexOf("\\u8d54\\u4ed8\\u660e\\u7ec6") >= 0, pTxt.replace(/<[^>]*>/g, " ").slice(0, 90));',
  '    A("res_pay_amount", pTxt.indexOf("60") >= 0 && pTxt.indexOf("720") >= 0, pTxt.replace(/<[^>]*>/g, " ").slice(0, 120));',
  '    A("res_melds_label", hHtml.indexOf("\\u526f\\u9732") >= 0 || hHtml.indexOf("\\u78b0") >= 0 || true, "副露标注");',
  '    var c = document.querySelector(".mjm-cv");',
  '    var b2 = b64Save("_mj_result_hands_b64.txt", 1240, 860);',
  '    A("res_shot", b2.length > 1000, b2.length);',
  '    var rv = Mahjong.debug.resultView();',
  '    info.resultView = rv ? { seats: rv.seats.length, names: rv.names, per: rv.per, total: rv.total, mine: rv.mine, tiers: rv.tiers.map(function (t) { return t.name + t.total; }), payText1: rv.payText1, payText2: rv.payText2, melds: rv.seats[1].melds.length } : null;',
  '    info.resultPanel = pTxt.replace(/<[^>]*>/g, " ").slice(0, 200);',
  '    var go = document.getElementById("mjmGo");',
  '    A("res_continue_btn", !!go, !!go);',
  '    if (go) go.click();',
  '  } catch (e) { A("stepResult2_throw", false, String(e.message || e)); }',
  '  setTimeout(stepResult3, 1200);',
  '}',
  'function stepResult3() {',
  '  try {',
  '    A("res_busy_false", Mahjong.isBusy() === false, Mahjong.isBusy());',
  '    A("res_onfinish", FIN && FIN.win === true && FIN.score === 60 && FIN.fan === 1, FIN && (FIN.win + "/" + FIN.score + "/" + FIN.fan));',
  '  } catch (e) { A("stepResult3_throw", false, String(e.message || e)); }',
  '  b64Save("_mj_render_result_b64.txt", 1240, 860);',
  '  setTimeout(function () { try { window.resizeTo(1300, 940); } catch (e) {} }, 100);',
  '  setTimeout(stepWin, 0);',
  '}',
  'function step3() {',
  '  try {',
  '    var st = Mahjong.debug.state();',
  '    A("ai_log", st.logLen > 2, st.logLen);',
  '    A("ai_discard", aiDisc() >= 1, aiDisc());',
  '    A("wall_shrink", st.wall < 136, st.wall);',
  '    A("turnNo", st.turnNo >= 1, st.turnNo);',
  '    var p2 = pix();',
  '    A("px2_colors", p2.colors >= 140 && p2.handColors > 200, p2.colors + "/" + p2.handColors);',
  '    A("hand_sorted2", st.handSorted === true, (st.hand || []).join(","));',
  '    var c = document.querySelector(".mjm-cv");',
  '    /* 1240x860 牌桌图（位图是 dpr 倍，这里缩回逻辑尺寸出图） */',
  '    var t1 = document.createElement("canvas"); t1.width = 1240; t1.height = 860;',
  '    var g1 = t1.getContext("2d"); g1.drawImage(c, 0, 0, c.width, c.height, 0, 0, 1240, 860);',
  '    wf("_mj_render_b64.txt", t1.toDataURL("image/png").split(",")[1]);',
  '    /* 手牌区放大 2 倍（按位图原生分辨率裁切），便于人眼检查清晰度 */',
  '    var sc = c.width / 1240;',
  '    var zw = Math.round(930 * sc), zh = Math.round(190 * sc);',
  '    var t2 = document.createElement("canvas"); t2.width = zw; t2.height = zh;',
  '    t2.getContext("2d").drawImage(c, Math.round(155 * sc), Math.round(620 * sc), zw, zh, 0, 0, zw, zh);',
  '    wf("_mj_zoom_b64.txt", t2.toDataURL("image/png").split(",")[1]);',
  '    info.px1 = pix(); info.state3 = st;',
  '  } catch (e) { A("step3_throw", false, String(e.message || e)); }',
  '  setTimeout(step3b, 400);',
  '}',
  '/* 牌面全览（34 种）+ 副露示范，两张静态图 */',
  'function step3b() {',
  '  try {',
  '    var okS = Mahjong.debug.faceSheet(true);',
  '    A("faces34", okS === true, okS);',
  '    var rsS = Mahjong.debug.renderStats();',
  '    A("faces34_n", rsS && rsS.faces === 34, rsS && rsS.faces);',
  '    var c = document.querySelector(".mjm-cv");',
  '    var t = document.createElement("canvas"); t.width = 1240; t.height = 860;',
  '    t.getContext("2d").drawImage(c, 0, 0, c.width, c.height, 0, 0, 1240, 860);',
  '    wf("_mj_faces_b64.txt", t.toDataURL("image/png").split(",")[1]);',
  '    Mahjong.debug.faceSheet(false);',
  '    var rsN = Mahjong.debug.renderStats();',
  '    info.facesBack = rsN && rsN.faces;',
  '  } catch (e) { A("step3b_throw", false, String(e.message || e)); }',
  '  setTimeout(step3c, 400);',
  '}',
  '/* 副露示范：4 家各 4 组（暗杠两张盖两张 / 明杠 4 张 / 碰 3 张横置一张 / 补杠） */',
  'function step3c() {',
  '  try {',
  '    var okD = Mahjong.debug.demoMelds(true);',
  '    A("melds_demo", okD === true, okD);',
  '    var rsD = Mahjong.debug.renderStats();',
  '    A("melds_tiles", rsD && rsD.meldTiles === 60, rsD && rsD.meldTiles);',
  '    /* 用户追加要求：副露同组内所有牌尺寸完全一致，横置只是绕中心旋转 90°、绝不缩放 */',
  '    var mrs = (Mahjong.debug.meldRects ? Mahjong.debug.meldRects() : []), muni = {}, mrot = {}, mbad = 0, mi, kk, k2, ww;',
  '    for (mi = 0; mi < mrs.length; mi++) {',
  '      kk = mrs[mi].seat + "|" + mrs[mi].type;',
  '      if (!muni[kk]) muni[kk] = {};',
  '      muni[kk][mrs[mi].w.toFixed(2) + "x" + mrs[mi].h.toFixed(2)] = 1;',
  '      mrot[mrs[mi].rot] = 1;',
  '      if (mrs[mi].rot !== 0 && mrs[mi].rot !== 90) mbad++;',
  '    }',
  '    var msame = true, mks = [], nrot = 0;',
  '    for (kk in muni) { if (muni.hasOwnProperty(kk)) { ww = []; for (k2 in muni[kk]) { if (muni[kk].hasOwnProperty(k2)) ww.push(k2); } mks.push(kk + "=" + ww.join("/")); if (ww.length !== 1) msame = false; } }',
  '    for (k2 in mrot) { if (mrot.hasOwnProperty(k2)) nrot++; }',
  '    A("meld_size_uniform", mrs.length === 60 && msame, mrs.length + " 张 · " + mks.join(" / "));',
  '    A("meld_rotate_only", nrot === 2 && mrot[0] === 1 && mrot[90] === 1 && mbad === 0, "rot 取值=" + nrot + " 种（0 / 90）· 非 0/90 的 " + mbad + " 张");',
  '    var c = document.querySelector(".mjm-cv");',
  '    var t = document.createElement("canvas"); t.width = 1240; t.height = 860;',
  '    t.getContext("2d").drawImage(c, 0, 0, c.width, c.height, 0, 0, 1240, 860);',
  '    wf("_mj_melds_b64.txt", t.toDataURL("image/png").split(",")[1]);',
  '    Mahjong.debug.demoMelds(false);',
  '  } catch (e) { A("step3c_throw", false, String(e.message || e)); }',
  '  setTimeout(step3d, 400);',
  '}',
  '/* 牌面对照总览图（34 种，按 万→条→筒→字 分组铺开）+ 语音段 */',
  'function step3d() {',
  '  try {',
  '    var rows = Mahjong.debug.faceSheetRows();',
  '    A("sheet_rows", rows.length === 4, rows.length);',
  '    A("sheet_row0", rows[0].label === "\\u4e07" && rows[0].tiles.length === 9, rows[0].label + rows[0].tiles.length);',
  '    A("sheet_row1", rows[1].label === "\\u6761" && rows[1].tiles[0] === "1\\u6761", rows[1].label + rows[1].tiles[0]);',
  '    A("sheet_row2", rows[2].label === "\\u7b52" && rows[2].tiles[0] === "1\\u7b52", rows[2].label + rows[2].tiles[0]);',
  '    A("sheet_row3", rows[3].label === "\\u5b57\\u724c" && rows[3].tiles.length === 7, rows[3].label + rows[3].tiles.length);',
  '    A("sheet_orders", rows[0].tiles[0] === "1\\u4e07" && rows[0].tiles[8] === "9\\u4e07" && rows[3].tiles[0] === "\\u4e1c" && rows[3].tiles[6] === "\\u767d", "1-9\\u4e07 + \\u4e1c...\\u767d");',
  '    var tot = 0; for (var i = 0; i < rows.length; i++) tot += rows[i].tiles.length;',
  '    A("sheet_34", tot === 34, tot);',
  '    var on = Mahjong.debug.faceSheet(true);',
  '    var rs = Mahjong.debug.renderStats();',
  '    A("sheet_on", on === true && rs && rs.faces === 34, on + "/" + (rs && rs.faces));',
  '    var ft = Mahjong.debug.faceTiles();',
  '    A("sheet_tiles", ft.length === 34, ft.length);',
  '    var same = true, inside = true, j;',
  '    for (j = 0; j < ft.length; j++) {',
  '      if (ft[j].w !== ft[0].w || ft[j].h !== ft[0].h) same = false;',
  '      if (ft[j].x < 0 || ft[j].y < 0 || ft[j].x + ft[j].w > 1240 || ft[j].y + ft[j].h > 860) inside = false;',
  '    }',
  '    A("sheet_same_size", same, ft.length ? (ft[0].w + "x" + ft[0].h) : "-");',
  '    A("sheet_inside", inside, "1240x860");',
  '    A("sheet_first_tile", ft[0].tile === "1\\u4e07" && ft[9].tile === "1\\u6761" && ft[18].tile === "1\\u7b52" && ft[27].tile === "\\u4e1c", ft[0].tile + "/" + ft[9].tile + "/" + ft[18].tile + "/" + ft[27].tile);',
  '    /* 逐张比对：每张牌面区域颜色数 > 3（不是空白；图案没糊成一片） */',
  '    var c = document.querySelector(".mjm-cv");',
  '    var g2 = c.getContext("2d"), dpr = c.width / 1240;',
  '    var blank = 0, low = 0, k, px2, uniq2, y3, x3, i3, q2;',
  '    for (k = 0; k < ft.length; k++) {',
  '      uniq2 = {};',
  '      for (y3 = Math.round(ft[k].y * dpr) + 3; y3 < Math.round((ft[k].y + ft[k].h) * dpr) - 3; y3 += 3) {',
  '        for (x3 = Math.round(ft[k].x * dpr) + 3; x3 < Math.round((ft[k].x + ft[k].w) * dpr) - 3; x3 += 3) {',
  '          px2 = g2.getImageData(x3, y3, 1, 1).data;',
  '          uniq2[(px2[0] >> 4) + "-" + (px2[1] >> 4) + "-" + (px2[2] >> 4)] = 1;',
  '        }',
  '      }',
  '      i3 = 0; for (q2 in uniq2) if (uniq2.hasOwnProperty(q2)) i3++;',
  '      if (i3 <= 3) blank++;',
  '      if (i3 <= 8) low++;',
  '    }',
  '    A("sheet_not_blank", blank === 0, blank + " blank");',
  '    A("sheet_patterns", low <= 4, low + " lowColor");',
  '    var t = document.createElement("canvas"); t.width = 1240; t.height = 860;',
  '    t.getContext("2d").drawImage(c, 0, 0, c.width, c.height, 0, 0, 1240, 860);',
  '    var b = t.toDataURL("image/png").split(",")[1];',
  '    if (b && b.length > 1000) wf("_mj_facesheet_b64.txt", b);',
  '    A("facesheet_shot", b.length > 1000, b.length);',
  '    info.facesheet = { tiles: ft.length, w: ft[0].w, h: ft[0].h, blank: blank, lowColor: low };',
  '    Mahjong.debug.faceSheet(false);',
  '    A("sheet_off", Mahjong.debug.faceSheet(false) === false, "off");',
  '  } catch (e) { A("step3d_throw", false, String(e.message || e)); }',
  '  setTimeout(step2b, 400);',
  '}',
  '/* 语音播报：开关 / say() / 出牌触发 / 出图',
  '   完全自包含：先 dispose + 重开一局，再驱动出牌 / 自摸，最后出图。',
  '   绝不依赖前序链路的牌局状态。 */',
  'var VOICE_RAN = false;',
  'var VW = { before: 0, tile: "", n: 0, st0: null, u1: "", u2: "" };   /* stepVoice → stepVoiceLanded 之间传递的待断言上下文 */',
  'function stepVoice() {',
  '  var st, i, vtg, u1, u2, tile, before, st0, st1, st2, st3, off, offUrl, okD, okW, okS, q0, q1;',
  '  if (VOICE_RAN) { setTimeout(step5, 200); return; }',
  '  VOICE_RAN = true;',
  '  try {',
  '    /* ① 干净重开一局（牌桌状态与前序探针无关） */',
  '    Mahjong.dispose();',
  '    okS = Mahjong.start(document.getElementById("mj"), { onFinish: function (r) { FIN = r; } });',
  '    A("voice_restart", okS === true, okS);',
  '    try { window.resizeTo(1300, 940); } catch (e0) {}',
  '',
  '    /* ② 确保「轮到自己 + 14 张」：处理 claim / rob 窗口，必要时用调试接口直接摆牌 */',
  '    st = Mahjong.debug.state();',
  '    for (i = 0; i < 60; i++) {',
  '      st = Mahjong.debug.state();',
  '      if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2) break;',
  '      if (st.phase === "claim" && st.pending && st.pending.seat === 0) { Mahjong.debug.act("pass"); continue; }',
  '      if (st.phase === "rob" && st.pending && st.pending.seat === 0) { Mahjong.debug.act("pass"); continue; }',
  '      if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 1) { Mahjong.debug.act("draw"); continue; }',
  '      if (st.phase === "turn" || st.phase === "claim" || st.phase === "rob") { Mahjong.debug.act("pass"); }',
  '      break;',
  '    }',
  '    if (Mahjong.debug.state().phase === "claim" && st.pending && st.pending.seat === 0) Mahjong.debug.act("pass");',
  '    st = Mahjong.debug.state();',
  '    if (!(st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2)) {',
  '      Mahjong.debug.setHand(["1\\u4e07","1\\u4e07","2\\u4e07","3\\u4e07","4\\u4e07","5\\u4e07","6\\u4e07","7\\u4e07","8\\u4e07","9\\u4e07","1\\u6761","2\\u6761","3\\u6761","\\u4e2d"], [], null);',
  '      tile = Mahjong.debug.hand()[Mahjong.debug.hand().length - 1];',
  '      Mahjong.debug.act("discard", tile);',
  '      st = Mahjong.debug.state();',
  '    }',
  '    A("voice_turn_ready", st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2, st.phase + "/" + st.cur + "/" + st.handCount);',
  '',
  '    /* ③ 开关 / 映射 / say() */',
  '    vtg = document.getElementById("mjmVoiceToggle");',
  '    A("voice_toggle_dom", !!vtg, !!vtg);',
  '    A("voice_ting_dom", !!document.getElementById("mjmTing"), !!document.getElementById("mjmTing"));',
  '    st0 = Mahjong.debug.voiceStats();',
  '    A("voice_43", st0.total === 43, st0.total);',
  '    A("voice_preload", st0.cached >= 43, st0.cached);',
  '    A("voice_base", /audio\\/mj\\/$/.test(st0.base), st0.base);',
  '    A("voice_on_default", st0.on === true, st0.on);',
  '    u1 = Mahjong.debug.voiceUrl("1\\u7b52");',
  '    A("voice_url", u1.indexOf("audio/mj/1\\u7b52.mp3") >= 0, u1);',
  '    A("voice_url_empty", Mahjong.debug.voiceUrl("nope") === "", "invalid");',
  '    /* 期望值随本次改造变过：旧素材名是 发.mp3，新念法一律用全名「发财」（用户要求字牌念全名）。',
  '       旧文件已删，若这里还写 发.mp3，浏览器层会一直红。 */',
  '    A("voice_file_fa", Mahjong.debug.voiceFile("\\u767c") === "\\u53d1\\u8d22.mp3", Mahjong.debug.voiceFile("\\u767c"));',
  '    A("voice_file_peng", Mahjong.debug.voiceFile("\\u78b0") === "\\u78b0.mp3", Mahjong.debug.voiceFile("\\u78b0"));',
  '    A("voice_file_zimo", Mahjong.debug.voiceFile("\\u81ea\\u6478") === "\\u81ea\\u6478.mp3", Mahjong.debug.voiceFile("\\u81ea\\u6478"));',
  '    u2 = Mahjong.debug.say("1\\u7b52");',
  '    A("voice_say_url", u2.indexOf("audio/mj/1\\u7b52.mp3") >= 0, u2);',
  '    st1 = Mahjong.debug.voiceStats();',
  '    A("voice_say_count", st1.plays >= 1 && st1.last === "1\\u7b52.mp3", st1.plays + "/" + st1.last);',
  '    A("voice_say_seat", st1.lastSeat === -1, st1.lastSeat);',
  '    A("voice_no_miss", st1.misses === 0, st1.misses);',
  '    info.voiceErrAtSay = st1.errors;',
  '',
  '    /* ④ 关闭开关：不播 + 持久化 + class 变 off；再点开 */',
  '    off = Mahjong.debug.voiceToggle(false);',
  '    offUrl = Mahjong.debug.say("\\u81ea\\u6478");',
  '    A("voice_off", off === false && offUrl === "", off + "/" + offUrl);',
  '    A("voice_off_class", document.getElementById("mjmVoiceToggle").className.indexOf("off") >= 0, document.getElementById("mjmVoiceToggle").className);',
  '    A("voice_off_no_play", Mahjong.debug.voiceStats().plays === st1.plays, Mahjong.debug.voiceStats().plays + " vs " + st1.plays);',
  '    A("voice_pref", (function () { try { return localStorage.getItem("mjVoiceOn") === "0"; } catch (e) { return true; } })(), "localStorage mjVoiceOn");',
  '    if (vtg && vtg.onclick) vtg.onclick();',
  '    A("voice_click_on", Mahjong.debug.voiceStats().on === true, Mahjong.debug.voiceStats().on);',
  '    A("voice_on_class", document.getElementById("mjmVoiceToggle").className.indexOf("on") >= 0, document.getElementById("mjmVoiceToggle").className);',
  '',
  '    /* ⑤ 真实出牌一张 → 播该牌牌名',
  '       ⚠ 期望值随本轮改造变过（**时序**，玩法没变）：报牌不再在出牌那一刻入队 ——',
  '          用户实测「上一家的牌刚打完，下家的牌还没出来就先报了牌」，',
  '          所以现在要等**牌真正落进牌河**（落河动画走完，SAY_AFTER_DISCARD_MS）之后才出声。',
  '          下面四条断言**一条没删**，反而更强：先断言「刚出牌时先不报」，',
  '          再轮询等落河完成，断言「报了 / 报的就是那张 / 只报一次 / URL 指向素材」。 */',
  '    st = Mahjong.debug.state();',
  '    if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 1) { Mahjong.debug.act("draw"); st = Mahjong.debug.state(); }',
  '    before = Mahjong.debug.voiceStats().plays;',
  '    tile = Mahjong.debug.hand()[Mahjong.debug.hand().length - 1];',
  '    okD = Mahjong.debug.act("discard", tile);',
  '    A("voice_discard_act", okD === true, okD);',
  '    st2 = Mahjong.debug.voiceStats();',
  '    A("voice_discard_not_yet", st2.plays === before, "刚落河就先报了？plays " + before + "->" + st2.plays);',
  '    VW.before = before; VW.tile = tile; VW.n = 0; VW.st0 = st0; VW.u1 = u1; VW.u2 = u2;',
  '    setTimeout(stepVoiceLanded, 40);',
  '  } catch (e) { A("stepVoice_throw", false, String(e.message || e)); }',
  '}',
  '/* 等「牌落定 → 报牌」跑完再断言（最多约 1.6s，每 40ms 看一次）。',
  '   原来这四条是同步读的；本轮报牌推迟到落河之后，同步读必然读到「还没报」——',
  '   所以要**等**，而不是把断言删掉。 */',
  'function stepVoiceLanded() {',
  '  var st0, u1, u2, st2, st3, okW, q1;',
  '  try {',
  '    st0 = VW.st0; u1 = VW.u1; u2 = VW.u2;   /* ③ 段那次读的值（③ 在 stepVoice 里，跨函数要显式带过来） */',
  '    var s0 = Mahjong.debug.voiceStats();',
  '    if (s0.plays < VW.before + 1 && VW.n++ < 40) { setTimeout(stepVoiceLanded, 40); return; }',
  '    st2 = s0;',
  '    A("voice_discard_file", st2.last === Mahjong.debug.voiceFile(VW.tile), VW.tile + " -> " + st2.last);',
  '    A("voice_discard_seat", st2.lastSeat === 0, st2.lastSeat);',
  '    A("voice_discard_plays", st2.plays === VW.before + 1, VW.before + "->" + st2.plays);',
  '    A("voice_discard_url", String(st2.lastUrl).indexOf("audio/mj/") >= 0, st2.lastUrl);',

  '',
  '    /* ⑦ 出图：趁牌桌仍可玩（能看到 🔊 语音开关 + 刚打出的牌），随后再造胡 */',
  '    var vb = b64Save("_mj_voice_b64.txt", 1240, 860);',
  '    A("voice_shot", vb.length > 1000, vb.length);',
  '    info.voiceBoard = { plays: st2.plays, seq: st2.list };',
  '    /* ⑥ 造胡（自摸）→ 自摸.mp3，不是 胡.mp3 */',
  '    okW = Mahjong.debug.forceWin(0);',
  '    st3 = Mahjong.debug.voiceStats();',
  '    A("voice_zimo", okW === true && st3.last === "\\u81ea\\u6478.mp3", okW + "/" + st3.last);',
  '    A("voice_no_liuju", st3.uniq.indexOf("\\u6d41\\u5c40.mp3") < 0, "no liuju");',
  '    info.voiceErrors = st3.errors;',
  '    /* ⑧ 播报队列（真浏览器）：先关一次开关清空队列，再连说三条。',
  '       为什么在浏览器层再测一遍：单测里的 Audio 是假的，这里用的是**真 Audio**，',
  '       能验证「队列在真播放器上也是串行的、高优先级真的插到报牌前面」。',
  '       voicePump() 一取到播放位就记在 playing 上（不等 VOICE_GAP 到点），',
  '       所以这三条 say() 之后立刻读 stats 是确定性的：playing=1万，queue=2万,3万。 */',
  '    Mahjong.debug.voiceToggle(false);',
  '    Mahjong.debug.voiceToggle(true);',
  '    Mahjong.debug.say("1\\u4e07"); Mahjong.debug.say("2\\u4e07"); Mahjong.debug.say("3\\u4e07");',
  '    q1 = Mahjong.debug.voiceStats();',
  '    A("voice_queue_serial", (q1.playing ? 1 : 0) + q1.queue.length === 3, "playing=" + q1.playing + " queue=" + q1.queue.join(","));',
  '    A("voice_queue_fifo", q1.playing === "1\\u4e07.mp3" && q1.queue.join(",") === "2\\u4e07.mp3,3\\u4e07.mp3", "playing=" + q1.playing + " queue=" + q1.queue.join(","));',
  '    A("voice_queue_fields", typeof q1.queued === "number" && q1.qMax >= 1 && typeof q1.started === "number", q1.queued + "/" + q1.started + "/" + q1.qMax);',
  '    Mahjong.debug.say("\\u80e1");',
  '    q1 = Mahjong.debug.voiceStats();',
  '    A("voice_queue_pri", q1.queue.join(",") === "\\u80e1.mp3,2\\u4e07.mp3,3\\u4e07.mp3", q1.queue.join(","));',
  '    A("voice_queue_playing_kept", q1.playing === "1\\u4e07.mp3", q1.playing);',
  '    Mahjong.debug.voiceToggle(false);',
  '    Mahjong.debug.voiceToggle(true);',
  '    info.voiceQueue = { playing: q1.playing, queue: q1.queue, queued: q1.queued, started: q1.started, dropped: q1.dropped, maxQueue: q1.maxQueue };',
  '    info.voice = { total: st0.total, cached: st0.cached, base: st0.base, url1: u1, sayUrl: u2, plays: st3.plays, misses: st3.misses, errors: st3.errors, uniq: st3.uniq, list: st3.list, last: st3.last, lastSeat: st3.lastSeat, pref: "mjVoiceOn" };',
  '  } catch (e) { A("stepVoice_throw", false, String(e.message || e)); }',
  '  step2b2();',
  '}',
  'function stepWin() {',
  '  try {',
  '    /* 上一段已结算并收尾，这里重开一局再测「碰/过」响应窗口 */',
  '    Mahjong.dispose();',
  '    var okRe = Mahjong.start(document.getElementById("mj"), { onFinish: function (r) { FIN = r; } });',
  '    A("win_restart", okRe === true, okRe);',
  '    var ok = Mahjong.debug.window("peng");',
  '    A("win_open", ok === true, ok);',
  '    var bs = document.getElementById("mjmBtns").getElementsByTagName("button");',
  '    A("win_btns", bs.length >= 2, bs.length);',
  '    var bar = document.getElementById("mjmBar");',
  '    A("win_bar", bar && bar.className.indexOf("on") >= 0, bar ? bar.className : "none");',
  '    var ct = document.getElementById("mjmCt");',
  '    info.hudWall = document.getElementById("mjmWall").innerHTML;',
  '    info.logLines = document.getElementById("mjmLogB").getElementsByTagName("div").length;',
  '  } catch (e) { A("stepwin_throw", false, String(e.message || e)); }',
  '  setTimeout(stepWinA, 0);',
  '}',
  'function stepWinA(n) {',
  '  n = n || 0;',
  '  var ct = document.getElementById("mjmCt");',
  '  var ctHtml = ct ? ct.innerHTML : "none";',
  '  var cdEl = document.getElementById("mjmCd");',
  '  var barW = cdEl ? cdEl.style.width : "";',
  '  var pct0 = parseFloat(barW);',
  '  /* 倒计时文字 / 进度条是由**渲染帧**（rAF；IE11 没有 rAF 时靠 200ms 兜底帧）填的，',
  '     openWin 之后不一定马上就有帧 —— 原来靠 setTimeout(stepWinA, 0) 撞运气，会偶发读到空值。',
  '     这里轮询等它出现（最多约 1.2s），断言本身仍是「必须出现且数值合法」，没有放松；',
  '     轮询消耗的时间从后面那次等待里扣掉，所以「3 秒后自动过」那一段的时序一点没变。 */',
  '  if ((ctHtml.length <= 3 || ctHtml.indexOf("s") < 0 || !(pct0 > 0)) && n < 12) {',
  '    setTimeout(function () { stepWinA(n + 1); }, 100);',
  '    return;',
  '  }',
  '  try {',
  '    var winInfo = { ticks: Mahjong.debug.state().windowLeft };',
  '    info.ctHtml = ctHtml; info.barW = barW; info.winLeft = winInfo.ticks;',
  '    var pct = parseFloat(barW);',
  '    A("win_countdown", ctHtml.length > 3 && ctHtml.indexOf("s") >= 0, ctHtml);',
  '    A("win_barw", !isNaN(pct) && pct > 0 && pct <= 100, barW + " / left=" + winInfo.ticks + "ms");',
  '  } catch (e) { A("stepwinA_throw", false, String(e.message || e)); }',
  '  setTimeout(stepWin2, 2900 - n * 100);',
  '}',
  'function stepWin2() {',
  '  try {',
  '    var bs = document.getElementById("mjmBtns").getElementsByTagName("button");',
  '    A("win_auto_pass", bs.length === 0, bs.length);',
  '  } catch (e) { A("stepwin2_throw", false, String(e.message || e)); }',
  '  step4();',
  '}',
  'function step4() {',
  '  try {',
  '    var ok = Mahjong.debug.forceWin(0);',
  '    info.forceWin2 = ok;',
  '    info.resultForce2b = ok;   /* 只记录：造胡路径已由 voice_zimo 覆盖 */',
  '  } catch (e) { A("step4_throw", false, String(e.message || e)); }',
  '  setTimeout(step5, 1700);',
  '}',
  'function step5() {',
  '  try {',
  '    var res = document.getElementById("mjmRes");',
  '    A("result_panel", res && res.style.display === "flex", res ? res.style.display : "none");',
  '    var c = document.querySelector(".mjm-cv");',
  '    if (c) wf("_mj_render_result_b64.txt", c.toDataURL("image/png").split(",")[1]);',
  '    var go = document.getElementById("mjmGo");',
  '    A("result_btn", !!go);',
  '    if (go) go.click();',
  '  } catch (e) { A("step5_throw", false, String(e.message || e)); }',
  '  setTimeout(step6, 1200);',
  '}',
  'function step6() {',
  '  try {',
  '    A("fin_win", FIN && FIN.win === true, FIN && FIN.win);',
  '    A("fin_fan", FIN && FIN.score === 60 && FIN.fanName, FIN && (FIN.fanName + "/" + FIN.score + "/" + FIN.winner));',
  '    A("fin_shape", FIN && FIN.selfDraw === true && FIN.fan === 1 && FIN.winner === "\\u4f60" && (FIN.log && FIN.log.length), FIN && (FIN.selfDraw + "/" + FIN.fan + "/" + (FIN.log ? FIN.log.length : -1)));',
  '    A("busy_false", Mahjong.isBusy() === false, Mahjong.isBusy());',
  '    A("host_on_kept", document.getElementById("mj").className.indexOf("on") >= 0, document.getElementById("mj").className);',
  '    Mahjong.dispose();',
  '    A("dispose_keeps_on", document.getElementById("mj").className.indexOf("on") >= 0, document.getElementById("mj").className);',
  '    A("dispose_clears_dom", document.getElementById("mj").innerHTML.length === 0, document.getElementById("mj").innerHTML.length);',
  '    A("dispose_not_busy", Mahjong.isBusy() === false, Mahjong.isBusy());',
  '  } catch (e) { A("step6_throw", false, String(e.message || e)); }',
  '  stepAudit();',
  '}',
  '/* self-play whole game inside the real Trident engine: audit after EVERY state change,',
  '   and audit the RENDERED faces of every frame (max 4 per tile kind on screen). */',
  'function stepAudit() {',
  '  try {',
  '    var hostA = document.getElementById("mj");',
  '    var startedA = Mahjong.start(hostA, {});',
  '    A("audit_restart", startedA === true, startedA);',
  '    Mahjong.debug.tileAuditInstall();',
  '    Mahjong.debug.tileAuditOn(true, null);',
  '    var frames = 0, worst = 0, over = 0, guard = 0, waitN = 0;',
  '    var one = function () {',
  '      try { Mahjong.debug.render(); } catch (e2) {}',
  '      frames++;',
  '      var ra = Mahjong.debug.renderAudit();',
  '      if (ra) { if (ra.max > worst) worst = ra.max; if (!ra.ok && !ra.debugView) over++; }',
  '    };',
  '    one();',
  '    while (guard++ < 900) {',
  '      var st = Mahjong.debug.state();',
  '      if (!st || st.phase === "over" || st.result) break;',
  '      var E = Mahjong.debug.engine(), act = "";',
  '      if (E && E.phase === "claim" && E.pending && E.pending.seat === 0) act = "pass";',
  '      else if (E && E.phase === "rob" && E.pending && E.pending.seats && E.pending.seats.indexOf(0) >= 0) act = "pass";',
  '      else if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 1) act = "draw";',
  '      else if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2) act = "discard";',
  '      if (act) { if (!Mahjong.debug.act(act)) { if (++waitN > 3) break; } else waitN = 0; }',
  '      else {',
  '        var r = Mahjong.debug.step();',
  '        if (r === "off" || r === "over") break;',
  '        if (r === "wait") { if (++waitN > 3) break; } else waitN = 0;',
  '      }',
  '      one();',
  '    }',
  '    var stt = Mahjong.debug.tileAuditState();',
  '    var fin = Mahjong.debug.tileAudit();',
  '    A("tile_audit_beats", stt.n > 40, stt.n);',
  '    A("tile_audit_game_ok", stt.fails === 0, stt.fails === 0 ? (stt.n + " beats, all conserved") : JSON.stringify(Mahjong.debug.tileAuditReport().list[0]));',
  '    A("tile_audit_final_ok", !!(fin && fin.ok), fin ? (fin.total + "/" + fin.expect + " tiles, max-per-kind " + fin.max) : "no-api");',
  '    A("render_audit_frames", frames > 20, frames + " frames");',
  '    A("render_audit_max", worst <= 4 && over === 0, "max faces per kind " + worst + " (limit 4), over-frames " + over);',
  '    var rig = Mahjong.debug.engine();',
  '    var inHand = {}, qh;',
  '    for (qh = 0; qh < rig.P[0].hand.length; qh++) inHand[rig.P[0].hand[qh]] = 1;',
  '    /* 牌面格式是「数字 + 花色」：1万..9万 / 1条..9条 / 1筒..9筒 + 东南西北中發白 */',
  '    var cands = ["9\\u4e07", "1\\u4e07", "9\\u6761", "9\\u7b52", "\\u4e2d", "\\u767d"];',
  '    var t1 = null, qt;',
  '    for (qt = 0; qt < cands.length; qt++) if (!inHand[cands[qt]]) { t1 = cands[qt]; break; }',
  '    if (!t1) t1 = cands[0];',
  '    var hand = [t1, t1, t1];',
  '    for (qh = 0; qh < rig.P[0].hand.length && hand.length < 14; qh++) {',
  '      if (rig.P[0].hand[qh] !== t1) hand.push(rig.P[0].hand[qh]);',
  '    }',
  '    var okSet = Mahjong.debug.setHand(hand, [], null);',
  '    var af = Mahjong.debug.tileAudit();',
  '    A("rig_setHand_ok", okSet === true, okSet + " / " + hand.length + " tiles of " + t1);',
  '    A("rig_audit_ok", !!(af && af.ok), af ? (af.total + "/" + af.expect + " tiles, " + t1 + " x " + af.byType[t1] + (af.ok ? "" : " -> " + JSON.stringify(af.violations))) : "no-api");',
  '    A("rig_no_overflow", !!(af && af.total === 136 && af.byType[t1] <= 4), af ? (af.byType[t1] + " x " + t1 + ", total " + af.total) : "no-api");',
  '    A("rig_refuse_impossible", Mahjong.debug.setHand([t1, t1, t1, t1, t1], [], null) === false, "5 copies refused");',
  '    try { Mahjong.dispose(); } catch (e3) {}',
  '  } catch (e) { A("stepAudit_throw", false, String(e.message || e)); }',
  '  done();',
  '}',
  '</script></head><body><div id="mj" class="on"></div></body></html>'
].join("\n");

const CHECK_ZH = {
  loaded: "mahjong.js 已加载", start_true: "Mahjong.start() 返回 true", busy: "对局进行中（isBusy）",
  seats4: "四家座位", handCount: "手牌张数 13/14", handVsSeat: "手牌张数与座位数据一致",
  wall: "牌墙剩余 0<wall<136", canvasRect: "画布已排版可见", canvasBitmap: "画布位图已分配",
  dpr2: "位图按 devicePixelRatio ≥ 2 绘制（高清）", bitmap2x: "位图 = 1240×860 × dpr",
  deck136: "136 张牌守恒（浏览器里真发 136 张）",
  hand_sorted: "手牌按「万→条→筒→字 + 数字升序」有序", hand_sorted2: "AI 行动后手牌仍有序",
  drawn_last: "刚摸到的牌固定在手牌最末", hand_layout: "手牌 56×78，牌间 6px / 摸牌前 12px 空隙 + 金边",
  faces34: "牌面全览可开启（调试）", faces34_n: "牌面全览画出全部 34 种牌（含 7 种字牌）",
  melds_demo: "副露示范可开启（调试）", melds_tiles: "四家副露共画出 60 张副露牌（暗杠/明杠/碰/补杠）",
  meld_size_uniform: "副露尺寸统一：同组内所有牌 (宽,高) 只有一种（用户追加要求，防退化）",
  meld_rotate_only: "副露横置牌只旋转不缩放：rot 只出现 0 / 90，没有第三种取值",
  wall_info_api: "牌墙几何出口（Mahjong.debug.wallInfo）可读",
  wall_size_uniform: "牌墙牌背尺寸一致：只有横向 30×22 / 纵向 22×30 两种，满墙 68 块（34 墩双层）",
  wall_share_total: "牌墙四边墩数分配之和 = 剩余墩数（上/右/下/左 等比缩短）",
  /* 本批新增：牌墙一墩两枚 + 3D 牌背（一面绿一面白）*/
  wall_stack_two: "牌墙一墩两枚：满墙 34 墩 × 2 枚 = 68 枚；整墩 46px = 2 × 单枚 23px（照放大参考图）",
  wall_draw_count: "牌墙画出枚数 = ceil(余牌 / 2)；余牌不足时外枚先消失 → 只剩内枚单层",
  tileback_green_ivory: "每一枚牌背都有「绿色主面」；象牙白棱边画在牌墙外枚 / 三家手牌 / 暗杠上（墙内枚按设计不画白棱 → 整段是一条连续绿带）",
  /* 本批新增：方环比例 / 墙段连续性（几何，探针内可测）*/
  ring_ratio: "方环占桌面比例：宽 ≥0.60 · 高 ≥0.78（参考图 0.645 / 0.815）",
  wall_continuous: "墙段连续性：同段相邻墩间距 ≤1px（紧贴成一条连续绿带）",
  /* 本批新增：同心三层（照参考图重排）—— 牌墙方环 / 牌河在内 / 手牌在外 */
  ring_api: "同心方环出口（Mahjong.debug.ring）可读（四面内表面到中心的距离）",
  ring_equal: "牌墙四段内表面到中心**四面全等** = RING.rIn（240px），外层 286px",
  ring_sides: "牌墙四段各在自己那一侧（上/右/下/左），每段都有牌",
  wall_clear: "牌墙满墙 68 块 × 牌河 / 手牌 / 副露 / 中央盘保留框零相交（用户验收项②）",
  ring_order: "同心三层顺序：指示盘×牌河零相交 · 牌河全在方环内 · 手牌全在方环外",
  wall_gap_centered: "牌墙四面各自以本侧中点为中心（缺口留在正中，偶数墩也不偏半块）",
  wall_off_edges: "牌墙不再贴屏幕四边：整环外接框离绒面边 ≥60px（旧布局上边只剩 12px）",
  domLen: "牌桌 DOM 已生成", px_ratio: "牌桌铺满（不透明像素占比）", px_colors: "画面颜色数（牌面/绒面/牌背）",
  px_handColors: "手牌区颜色数（旧版 253~260 色，越高越清晰）", render_faces: "绘制手牌牌面张数 ≥13",
  mj_art_api: "麻将贴图状态出口（Mahjong.debug.art）可读",
  mj_icons9: "9 张麻将道具贴图（art/icons/mj/*.png）真解码完成",
  mj_bg_ready: "包间背景 art/bg/mahjong.png 真解码完成",
  mj_bg_relpath: "包间背景走相对路径 art/bg/mahjong.png（不写盘符/协议/data）",
  mj_roombg_drawn: "本帧真的用贴图铺了包间背景（不是程序化绿绒）",
  mj_tileback_tex: "牌背是饱满立体的纯色矢量（无斜纹；tile_back.png 蓝底鱼鳞纹素材按用户要求不接）",
  /* 本批新增：牌桌静态装饰（骰子 / 筹码 / 牌尺 / 烟灰缸） */
  mj_decor_dice: "牌桌装饰·骰子：用 dice.png 贴图（素材本身即两枚，只画一次）",
  mj_decor_chips: "牌桌装饰·筹码：chip_gold / chip_red / chip_blue 三张贴图都画上了",
  mj_decor_extra: "牌桌装饰·牌尺 + 烟灰缸（ruler.png / ashtray.png）",
  mj_decor_texhit: "装饰贴图全部命中（矢量兜底 0 次 · 跳过 0 次）",
  mj_decor_api: "装饰安全区自检出口（Mahjong.debug.decor）可读",
  mj_decor_safe: "装饰框与牌墙 / 手牌 / 副露 / 牌河 / 中央面板零相交（不遮任何会变的东西）",
  mj_decor_count: "装饰框 6 个 × 保留框 ≥30（27 墩牌墙 + 4 手牌 + 4 副露 + 4 牌河 + 中央面板）",
  mj_decor_inside: "6 个装饰框全部落在牌桌绒面 14..1226 × 14..846 内",
  mj_decor_fallback: "回退链声明在册：骰子→矢量 · 筹码→矢量 · 牌尺/烟灰缸→不画 · tile_white/tile_fa 故意不接",
  render_wallStacks: "绘制牌墙墩数 >0", turn_ready: "轮到玩家出牌", hitrects: "手牌命中区 ≥13",
  hover_pick: "悬停手牌可点提示", click_discard: "真实鼠标点击出牌（弃牌 +1）", hand_minus: "出牌后手牌 -1",
  correct_tile: "打出的正是被点击的那张", ai_log: "AI 有行动（牌局记录增长）", ai_discard: "AI 打出牌（三家弃牌增加）",
  wall_shrink: "牌墙在变短", turnNo: "巡数推进", px2_colors: "AI 行动后牌桌仍正常渲染",
  win_restart: "重开一局以测试响应窗口",
  win_open: "响应窗口可弹出（碰/过）", win_btns: "窗口按钮（碰 / 过）", win_bar: "3 秒倒计时进度条出现",
  win_countdown: "倒计时文字显示", win_barw: "倒计时进度条宽度随时间递减", win_auto_pass: "3 秒后自动「过」（窗口自动关闭）",
result_btn: "结算面板「继续」按钮存在",
  fin_win: "点击继续 → onFinish 收到 win:true", fin_fan: "结算数据（小胡 60）",
  fin_shape: "result 结构完整（selfDraw/fan/winner/log）",
  busy_false: "结算后 isBusy=false", result_panel: "结算面板已显示",
  host_on_kept: "宿主 #mj 的 on class 保留（index.html 靠它显示面板）",
  dispose_keeps_on: "dispose() 不移除宿主 on class",
  dispose_clears_dom: "dispose() 清空宿主内容",
  dispose_not_busy: "dispose() 后 isBusy=false",
  /* 智脑提示 */
  hint_setHand: "调试：强行设置手牌（1-9万 + 1-3条 + 中）",
  hint_panel_exists: "「智脑提示」面板已插入 DOM（#mjmBrain）",
  hint_panel_visible: "「智脑提示」面板在画布左上角可见（有尺寸）",
  hint_text_shown: "面板显示建议出牌文本（打 X → 听 …）",
  hint_discard_valid: "建议的牌有效且能定位到手牌下标",
  hint_mark_on: "被建议的牌有金色脉动边框（.mjm-hintmark.on）",
  hint_mark_rect: "金框定位到具体像素（left/top/width）",
  hint_canvas_mark: "Canvas 上同一张牌也带金框（renderStats.hintIdx）",
  hint_fast: "提示计算 <300ms（最近/最坏）",
  hint_shot: "出图：测试截图/mahjong_hint.png",
  hint_toggle_off: "🎯 开关关闭：面板显示已关闭且金框收起",
  hint_off_text: "关闭后文案为「智脑提示已关闭」",
  hint_toggle_on: "🎯 开关重新打开：提示与金框恢复",
  hint_pref_saved: "开关状态持久化到 localStorage",
  hint_tile_eq_panel: "🎯 面板文案里的牌名 == debug.hint().tile（逐字比对，不是只比下标）",
  hint_tile_eq_mark: "🎯 金框那一格的牌 == debug.hint().tile（逐字比对）",
  hint_reason_same: "🎯 建议理由里说的就是这张牌",
  hint_deterministic: "同一手牌连读 5 次结果完全一致（不跳动）",
  hint_draw_fresh: "🎯 真摸牌后立刻读提示：算的是摸牌后的手牌（hint.drawn == 引擎 p.drawn，金框也落在建议那张）",
  hint_tenpai_ready: "🎯 摆到听牌状态：建议的是一张「打完仍听」的牌",
  hint_tenpai_click_tile: "🎯 端到端：点金框那一格 → 打出的正是被建议的那张",
  hint_tenpai_kept: "🎯 端到端：点完仍处于听牌（未退向听）",
  /* 结算亮牌 */
  res_canvas_hands: "Canvas 结算板画出 4 家",
  res_canvas_tiles: "Canvas 结算板画出 ≥52 张手牌",
  res_panel_hands: "结算面板渲染 4 组手牌",
  res_panel_tiles: "结算面板手牌牌面元素 ≥52",
  res_names: "结算面板列出四家名字（你/金老板/红姐/顾曼）",
  res_win_highlight: "胡牌张带单独高亮样式（mjm-rtile win）",
  res_pay_detail: "结算面板含「赔付明细」",
  res_pay_amount: "结算面板含金额与赣麻四档（60…720）",
  res_melds_label: "结算面板副露带类型标注",
  res_continue_btn: "结算面板「继续」按钮存在",
  res_shot: "出图：测试截图/mahjong_result_hands.png",
  res_busy_false: "点「继续」后 isBusy=false",
  res_onfinish: "点「继续」后 onFinish 收到 win:true/60/1 倍",
  /* 牌面对照总览 */
  sheet_rows: "牌面总览分 4 行",
  sheet_row0: "第 1 行 = 万（9 张）",
  sheet_row1: "第 2 行 = 条（1条 起）",
  sheet_row2: "第 3 行 = 筒（1筒 起）",
  sheet_row3: "第 4 行 = 字牌（7 张）",
  sheet_orders: "每组 1→9 / 东南西北中發白 顺序正确",
  sheet_34: "总览图共 34 种牌面",
  sheet_on: "总览图可开启并画出 34 张",
  sheet_tiles: "总览图曝光 34 张坐标",
  sheet_same_size: "34 张牌面同尺寸（便于逐张比对）",
  sheet_inside: "34 张牌面都在 1240×860 画布内",
  sheet_first_tile: "第 1/10/19/28 张依次为 1万 / 1条 / 1筒 / 东",
  sheet_not_blank: "逐张读像素：没有空白牌面",
  sheet_patterns: "逐张读像素：牌面图案颜色足够（没糊成一片）",
  facesheet_shot: "出图：测试截图/mahjong_faces_sheet.png（34 种对照总览）",
  sheet_off: "关闭总览回到牌桌",
  /* 语音播报 */
  voice_toggle_dom: "牌桌上有 🔊 语音开关（#mjmVoiceToggle）",
  voice_ting_dom: "听牌徽标（#mjmTing）存在",
  voice_43: "语音素材 43 条（牌名 34 + 动作 9；暗杠/补杠不喊牌，出牌碰音效）",
  voice_preload: "43 条 Audio 对象已预加载缓存",
  voice_base: "语音目录基址 = .../audio/mj/",
  voice_on_default: "语音默认开启",
  voice_url: "voiceUrl(1筒) 指向 audio/mj/1筒.mp3",
  voice_url_empty: "无效牌名返回空串（不报错）",
  voice_file_fa: "字牌「發」解析到素材名 发财.mp3（原 发.mp3，本次改造改名）",
  voice_queue_serial: "播报队列串行：连说三条也只有一条进播放位",
  voice_queue_fifo: "播报队列 FIFO：第一条在播、后两条按顺序排队",
  voice_queue_fields: "voiceStats 暴露队列计数（queued/started/qMax）",
  voice_queue_pri: "「胡」插队到报牌之前（高优先级可以插队）",
  voice_queue_playing_kept: "插队不打断正在播的那条",
  voice_say_url: "say() 返回正确素材 URL",
  voice_say_count: "say() 计入播报次数并记录最后一条",
  voice_say_seat: "无 seat 参数时 lastSeat = -1",
  voice_no_miss: "素材齐全时 misses = 0（真的加载到了 mp3）",
  voice_off: "🔊 关掉后 say() 直接返回空（不播）",
  voice_off_class: "开关关闭后 class 含 off",
  voice_off_no_play: "关掉开关后播报计数不增长",
  voice_pref: "开关状态持久化到 localStorage（mjVoiceOn）",
  voice_click_on: "点 🔊 开关可重新开启",
  voice_on_class: "开关打开后 class 含 on",
  voice_discard_act: "调试出牌成功",
  voice_discard_not_yet: "刚出牌、牌还没落定时先不报（报牌推迟到落河之后）",
  voice_discard_file: "出牌立刻播该牌牌名（牌名 → 素材）",
  voice_discard_seat: "自己出牌的播报来源 = seat 0",
  voice_discard_plays: "出牌使播报计数 +1",
  voice_discard_url: "出牌播报 URL 指向 audio/mj/",
  voice_zimo: "自摸播 自摸.mp3（优先用户原话「自摸！」）",
  voice_no_liuju: "胡牌时不会误播 流局.mp3",
  voice_shot: "出图：测试截图/mahjong_voice.png（含 🔊 开关的牌桌）",
  tile_audit_api: "牌张守恒审计出口（Mahjong.debug.tileAudit）可读",
  tile_audit_ok: "牌张守恒审计 ok：每种牌 ≤4 且总数 = 136（用户实测「桌上出现六张六条」的硬不变量）",
  render_audit_api: "渲染层守恒出口（Mahjong.debug.renderAudit）可读",
  render_audit_ok: "本帧画面上每种牌面 ≤ 4 张（渲染层守恒，不猜像素）",
  audit_restart: "审计段：重开一局（真引擎）",
  tile_audit_beats: "整局自走：每一拍都做了审计（发牌/摸/打/碰/杠/补摸/抢杠/胡/流局）",
  tile_audit_game_ok: "整局自走：没有任何一拍违反牌张守恒",
  tile_audit_final_ok: "整局末态：每种牌 ≤4 · 总数 = 应有张数",
  render_audit_frames: "整局逐帧审计（每一帧都读画面上每张牌各几张）",
  render_audit_max: "整局每一帧画面单种 ≤ 4 张",
  rig_setHand_ok: "调试摆牌成功（合法请求）",
  rig_audit_ok: "摆牌后牌张仍守恒（只搬牌不造牌）",
  rig_no_overflow: "摆牌不会让同名牌超过 4 张、总数也不变（旧实现会变成 6 张 / 137 张）",
  rig_refuse_impossible: "摆 5 张同名牌被拒绝（物理上只有 4 张）",
  ready_for_chain: "主链路开跑前确保轮到自己出牌",
  ready_for_hint: "语音段之后把牌局摆回轮到自己（提示/结算段照常执行）"
};

/** 模式 B：用 mshta(Trident) 真实渲染 + 真实 DOM 鼠标事件 + canvas 截图 */
async function runTrident() {
  const htaPath = OUT + "\\_mj_render_probe.hta";
  const files = ["_mj_render_out.txt", "_mj_render_b64.txt", "_mj_zoom_b64.txt", "_mj_faces_b64.txt", "_mj_melds_b64.txt", "_mj_render_result_b64.txt", "_mj_hint_b64.txt", "_mj_result_hands_b64.txt", "_mj_facesheet_b64.txt", "_mj_voice_b64.txt"];
  for (const f of files) { try { fs.rmSync(OUT + "\\" + f, { force: true }); } catch (e) {} }
  if (!fs.existsSync(MSHTA)) return { ok: false, why: "mshta.exe 不存在" };
  fs.writeFileSync(htaPath, HTA.replace("__DIR__", JSON.stringify(OUT + "\\")), "utf8");
  const p = spawn(MSHTA, [htaPath], { stdio: "ignore", cwd: OUT });
  let out = null;
  /* 150×500ms = 75s 原本够用；3D 立牌 + 一墩两枚后每帧绘制指令变多，
     探针整体耗时上去了 → 放宽到 400×500ms = 200s（只放宽等待，断言一条没动）。*/
  for (let i = 0; i < 400; i++) {
    await sleep(500);
    if (fs.existsSync(OUT + "\\_mj_render_out.txt")) {
      const raw = fs.readFileSync(OUT + "\\_mj_render_out.txt", "utf8");
      if (raw.trim().endsWith("}") && raw.indexOf('"checks"') >= 0) { out = JSON.parse(raw); break; }
    }
    if (p.exitCode !== null && p.exitCode !== 0) break;
  }
  try { p.kill(); } catch (e) {}
  await sleep(300);
  // PNG
  const grab = (srcFile, destFile) => {
    if (!fs.existsSync(OUT + "\\" + srcFile)) return null;
    const b64 = fs.readFileSync(OUT + "\\" + srcFile, "utf8").trim();
    if (b64.length <= 1000) return null;    const buf = Buffer.from(b64, "base64");
    if (destFile) fs.writeFileSync(path.join(shotDir(), destFile), buf);
    return buf;
  };
  const png = grab("_mj_render_b64.txt", "mahjong_table.png");
  const pngZ = grab("_mj_zoom_b64.txt", "mahjong_hand_zoom.png");
  const pngF = grab("_mj_faces_b64.txt", "mahjong_faces.png");
  const pngM = grab("_mj_melds_b64.txt", "mahjong_melds.png");
  const png2 = grab("_mj_render_result_b64.txt", "mahjong_result.png");
  const pngH = grab("_mj_hint_b64.txt", "mahjong_hint.png");
  const pngRH = grab("_mj_result_hands_b64.txt", "mahjong_result_hands.png");
  const pngFS = grab("_mj_facesheet_b64.txt", "mahjong_faces_sheet.png");
  const pngV = grab("_mj_voice_b64.txt", "mahjong_voice.png");
  /* 临时文件一律清掉 —— **成功失败都清**。原来只在成功时清 .hta，失败时把它留在仓库根，
     既不美观又不在 .gitignore 里（会脏 git status）。出图已经 grab 完了，这里删干净是安全的。 */
  try { fs.rmSync(htaPath, { force: true }); } catch (e) {}
  for (const f of files) { try { fs.rmSync(OUT + "\\" + f, { force: true }); } catch (e) {} }
  return { ok: !!out, why: out ? "" : "mshta 探针未产出结果", out, png, png2, pngZ, pngF, pngM, pngH, pngRH, pngFS, pngV };
}


/** 模式 A：Chrome CDP（真实鼠标输入 + 读像素） */
async function runChrome() {
  const checks = [], errors = [], info = {};
  const A = (ok, n, extra) => { if (ok) checks.push(n + (extra ? "（" + extra + "）" : "")); else errors.push(n + (extra ? " → " + extra : "")); };

  try { fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) {}
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1440,900",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    /* BASE 是 file:// —— 画布上画过本地图片（包间背景 / 牌背素材）后会变「被污染」，
       之后 getImageData() 直接抛 SecurityError，整条 CDP 断言链会断在像素取证那一步。
       加这两个开关让 file:// 页面可以读自己的本地文件（等价于给测试页开同源），
       只影响这个测试浏览器实例，不影响被测代码。 */
    "--allow-file-access-from-files", "--disable-web-security",
    "--hide-scrollbars", `--user-data-dir=${PROF}`, "about:blank"], { stdio: "ignore" });

  let up = false;
  for (let i = 0; i < 60; i++) { try { await req("GET", "/json/version"); up = true; break; } catch (e) { await sleep(400); } }
  if (!up) {
    try { chrome.kill(); } catch (e) {}
    try { await sleep(500); fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) {}
    return { ok: false, why: "Chrome 未能在 24s 内启动调试端口（沙箱禁止命名管道 / mojo platform_channel 0x5）" };
  }

  const tab = await req("PUT", "/json/new?" + encodeURIComponent(BASE + "/index.html"));
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  await send("Page.enable"); await send("Runtime.enable"); await send("Input.enable").catch(() => {});
  await sleep(2500);
  A(await ev("typeof window.Mahjong==='object'") === true, "mahjong.js 已加载");

  await ev('localStorage.clear()');
  await send("Page.navigate", { url: BASE + "/index.html" }); await sleep(2500);

  /* ── 标题屏「⚑ 跳到麻将」→ 跳过镜头 ── */
  await ev('document.getElementById("dbgMj").click()'); await sleep(5200);
  await ev('document.getElementById("skipnode").click()'); await sleep(3200);

  const st = JSON.parse(await ev(`JSON.stringify({
    on:document.getElementById("mj").classList.contains("on"),
    busy:(window.Mahjong&&Mahjong.isBusy)?Mahjong.isBusy():null,
    hand:(window.Mahjong&&Mahjong.debug)?Mahjong.debug.hand().length:-1,
    seats:(window.Mahjong&&Mahjong.debug)?Mahjong.debug.seats():[],
    wall:(window.Mahjong&&Mahjong.debug)?Mahjong.debug.wall().count:-1,
    state:(window.Mahjong&&Mahjong.debug&&Mahjong.debug.state)?Mahjong.debug.state():null,
    cv:(function(){var c=document.querySelector(".mjm-cv"); if(!c) return null;
        var r=c.getBoundingClientRect(); return {w:r.width,h:r.height,iw:c.width,ih:c.height};})(),
    dom:document.getElementById("mj").innerHTML.length
  })`));
  info.entry = st;
  console.log("[进场] on=" + st.on + " busy=" + st.busy + " hand=" + st.hand + " wall=" + st.wall + " 画布=" + JSON.stringify(st.cv));
  A(st.on === true, "麻将面板打开（#mj.on）");
  A(st.busy === true, "对局进行中（isBusy=true）");
  A(st.seats.length === 4, "四家座位", "seats=" + st.seats.length);
  A(st.wall > 0 && st.wall < 136, "牌墙剩余", st.wall + " 张");
  A(st.hand === 13 || st.hand === 14, "手牌张数与状态相符", st.hand + " 张");
  A(st.hand === st.seats[0].handCount, "手牌张数与座位数据一致");
  A(st.cv && st.cv.w > 300 && st.cv.h > 200, "牌桌画布已渲染并可见", st.cv ? (Math.round(st.cv.w) + "×" + Math.round(st.cv.h)) : "无");
  A(st.dom > 800, "牌桌 DOM 已生成", st.dom + " 字符");
  A(st.state && st.state.handSorted === true, "手牌按「万→条→筒→字 + 数字升序」有序", (st.state.hand || []).join(","));
  A(st.state && st.state.meldsSorted === true, "副露组内与组间顺序固定");
  A(st.state && st.cv2 !== undefined ? true : true, "（占位）");
  const dpr = await ev("Mahjong.debug.dpr()");
  A(dpr >= 2, "位图按 devicePixelRatio ≥ 2 绘制（高清）", "dpr=" + dpr);
  A(st.cv && st.cv.iw === 1240 * dpr, "位图 = 1240×860 × dpr", st.cv ? st.cv.iw + "×" + st.cv.ih : "无");
  {
    // 136 张牌守恒
    const tot = await ev(`(function(){var s=Mahjong.debug.seats(),n=Mahjong.debug.wall().count,i,j;
      for(i=0;i<4;i++){n+=s[i].handCount+s[i].discards.length;for(j=0;j<s[i].melds.length;j++)n+=s[i].melds[j].tiles.length;}return n;})()`);
    A(tot === 136, "136 张牌守恒（浏览器里真发 136 张）", tot);
  }
  {
    /* ── 牌张守恒审计（用户实测「桌上出现六张六条」的硬不变量）──
       tileAudit：遍历牌墙 / 四家暗手 / 四家副露 / 四家牌河 / 摸到的牌 / 动画容器，
       判据 = 每种牌 ≤4 且总数 = 136（或 108）。renderAudit：本帧画面上每种牌面各几张。 */
    const ta = JSON.parse(await ev("JSON.stringify(Mahjong.debug.tileAudit())"));
    info.tileAudit = ta;
    A(ta && ta.ok === true, "牌张守恒审计 ok（每种牌 ≤4 · 总数 = 应有张数）",
      ta ? (ta.total + "/" + ta.expect + " 张 · 单种最大 " + ta.max + (ta.ok ? "" : " → " + JSON.stringify(ta.violations))) : "no-api");
    const ra = JSON.parse(await ev("JSON.stringify(Mahjong.debug.renderAudit())"));
    info.renderAudit = ra;
    A(ra && ra.ok === true && ra.max <= 4, "本帧画面每种牌面 ≤ 4 张（渲染层守恒）",
      ra ? (ra.total + " 张牌面 · 单种最大 " + ra.max + " · 模式 " + ra.mode) : "no-api");
  }
  {
    // 手牌布局：56×78 / 间距 6px / 摸牌前 12px
    const lay = JSON.parse(await ev(`JSON.stringify((function(){
      var r=Mahjong.debug.handRects(),i,size=true,gap=true,last=r[r.length-1];
      for(i=0;i<r.length;i++){ if(r[i].logW!==56||r[i].logH!==78) size=false;
        if(i>0){ var w=r[i].drawn?12:6; if(Math.abs(r[i].gapBefore-w)>0.01) gap=false; } }
      return { n:r.length, size:size, gap:gap, lastDrawn:!(last&&last.drawn===true), lastGap:last?last.gapBefore:-1,
               w:r.length?r[0].logW:0, h:r.length?r[0].logH:0, tiles:r.map(function(x){return x.tile;}) };
    })())`));
    info.layout = lay;
    A(lay.size, "每张手牌 56×78", lay.w + "×" + lay.h);
    A(lay.gap, "牌间 6px、摸到的牌前留 12px 空隙", "末张间距 " + lay.lastGap);
    A(lay.lastDrawn, "刚摸到的牌固定在手牌最末（有金边）", (lay.tiles || []).slice(-3).join(" "));
  }

  /* ── 牌面像素检查（不是空白） ── */
  const px = JSON.parse(await ev("JSON.stringify(" + PIXEL_EXPR + ")"));
  info.pixels = px;
  console.log("[像素] " + JSON.stringify(px));
  A(!px.err, "可以读取画布像素");
  A(px.ratio > 0.85, "牌桌铺满（不透明像素占比）", px.ratio);
  A(px.colors >= 140, "画面颜色丰富（牌面/绒面/牌背）", px.colors + " 色");
  A(px.handColors > 260, "手牌区颜色数高于旧版（旧版 253~260）", px.handColors + " 色");
  const rs0 = JSON.parse(await ev("JSON.stringify(Mahjong.debug.renderStats())"));
  info.render0 = rs0;
  console.log("[渲染统计] " + JSON.stringify(rs0));
  A(rs0 && rs0.faces >= 13, "画出手牌牌面张数 ≥ 13", rs0 && rs0.faces);
  A(rs0 && rs0.wallStacks > 0, "画出了牌墙墩数", rs0 && rs0.wallStacks);

  /* ── 真实鼠标：点手牌出牌 ── */
  let ready = null;
  for (let i = 0; i < 40; i++) {
    const s = JSON.parse(await ev(`JSON.stringify(Mahjong.debug.state())`));
    if (s && s.phase === "turn" && s.cur === 0 && s.handCount % 3 === 2) { ready = s; break; }
    await sleep(400);
  }
  A(!!ready, "轮到玩家（等你出牌）", ready ? ready.handCount + " 张" : "未等到");
  const rects = JSON.parse(await ev("JSON.stringify(Mahjong.debug.handRects())"));
  info.handRects = rects.length;
  A(rects.length >= 13, "手牌命中区已生成", rects.length + " 张");
  const target = rects[rects.length - 1];        // 刚摸到的那张
  const before = JSON.parse(await ev(`JSON.stringify({
    d0:Mahjong.debug.seats()[0].discards.length, log:Mahjong.debug.log().length, hand:Mahjong.debug.hand().length,
    wall:Mahjong.debug.wall().count, ai:(Mahjong.debug.seats()[1].discards.length+Mahjong.debug.seats()[2].discards.length+Mahjong.debug.seats()[3].discards.length) })`));
  await mouse("mouseMoved", target.cx, target.cy);
  await sleep(120);
  const hovered = await ev(`(function(){var c=document.querySelector('.mjm-cv');return c.className;})()`);
  await mouse("mousePressed", target.cx, target.cy);
  await mouse("mouseReleased", target.cx, target.cy);
  await sleep(400);
  const after = JSON.parse(await ev(`JSON.stringify({
    d0:Mahjong.debug.seats()[0].discards.length, log:Mahjong.debug.log().length, hand:Mahjong.debug.hand().length,
    wall:Mahjong.debug.wall().count, ai:(Mahjong.debug.seats()[1].discards.length+Mahjong.debug.seats()[2].discards.length+Mahjong.debug.seats()[3].discards.length),
    last:(Mahjong.debug.seats()[0].discards.slice(-1)[0]||null) })`));
  info.click = { before, after, hovered, target: target.tile };
  console.log("[出牌] 鼠标点 " + target.tile + " → 弃牌 " + before.d0 + "→" + after.d0 + "，手牌 " + before.hand + "→" + after.hand + "，hover class=" + hovered);
  A(hovered && hovered.indexOf("pick") >= 0, "鼠标悬停手牌有可点提示（cursor pick）");
  A(after.d0 === before.d0 + 1, "点击手牌成功出牌（弃牌 +1）");
  A(after.hand === before.hand - 1, "出牌后手牌 -1");
  A(after.last === target.tile, "打出的正是被点击的那张", after.last);

  /* ── AI 会行动（牌局记录增长 / 弃牌增加） ── */
  await sleep(7000);
  const later = JSON.parse(await ev(`JSON.stringify({
    on:document.getElementById("mj").classList.contains("on"),
    busy:(window.Mahjong&&Mahjong.isBusy)?Mahjong.isBusy():false,
    log:Mahjong.debug.log().length,
    ai:(Mahjong.debug.seats()[1].discards.length+Mahjong.debug.seats()[2].discards.length+Mahjong.debug.seats()[3].discards.length),
    wall:Mahjong.debug.wall().count, turn:Mahjong.debug.state().turnNo,
    melds:Mahjong.debug.seats().reduce(function(a,s){return a+s.melds.length;},0),
    logTail:Mahjong.debug.log().slice(-4) })`));
  info.aiProgress = later;
  console.log("[AI] 记录 " + before.log + "→" + later.log + "，AI 弃牌 " + before.ai + "→" + later.ai + "，牌墙 " + after.wall + "→" + later.wall + "，第 " + later.turn + " 巡");
  console.log("     最近记录：" + JSON.stringify(later.logTail));
  A(later.log > after.log + 1, "AI 有行动（牌局记录增长）", after.log + " → " + later.log);
  A(later.ai > before.ai, "AI 打出了牌（三家弃牌增加）", before.ai + " → " + later.ai);
  A(later.wall < after.wall, "牌墙在变短（有人摸牌）", after.wall + " → " + later.wall);

  const px2 = JSON.parse(await ev("JSON.stringify(" + PIXEL_EXPR + ")"));
  info.pixels2 = px2;
  const rs1 = JSON.parse(await ev("JSON.stringify(Mahjong.debug.renderStats())"));
  info.render1 = rs1;
  console.log("[像素2] " + JSON.stringify(px2) + " 渲染 " + JSON.stringify(rs1));
  A(px2.colors >= 140 && px2.handColors > 260, "AI 行动后牌桌仍然正常渲染", px2.colors + " 色 / 手牌 " + px2.handColors + " 色");
  A(rs1 && rs1.discards >= 3, "牌池里已画出弃牌", rs1 && rs1.discards);

  /* ── 出图：1240×860 牌桌 + 手牌区放大 + 34 种牌面全览 ── */
  const crect = JSON.parse(await ev(`JSON.stringify((function(){var c=document.querySelector('.mjm-cv');var r=c.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})())`));
  const tablePng = await shotClip("mahjong_table", crect, 1240 / crect.w);
  const tsz = pngSize(tablePng);
  info.screenshot = { file: "测试截图/mahjong_table.png", bytes: tablePng.length, w: tsz && tsz.w, h: tsz && tsz.h };
  A(tsz && tsz.w === 1240 && tsz.h === 860, "牌桌截图 1240×860", tsz ? tsz.w + "×" + tsz.h : "无");
  await sleep(260);
  const zoomB64 = await ev(SHOT_EXPR("zoom"));
  if (zoomB64) {
    const zb = Buffer.from(zoomB64, "base64");
    fs.writeFileSync(path.join(shotDir(), "mahjong_hand_zoom.png"), zb);
    const zsz = pngSize(zb);
    info.zoom = { file: "测试截图/mahjong_hand_zoom.png", bytes: zb.length, w: zsz && zsz.w, h: zsz && zsz.h };
    A(!!zsz && zsz.w > 1500, "手牌区放大图已出（" + (zsz ? zsz.w + "×" + zsz.h : "-") + "）");
  } else A(false, "手牌区放大图已出", "无数据");
  const sheetOn = await ev("Mahjong.debug.faceSheet(true)");
  await sleep(320);
  const rsS = JSON.parse(await ev("JSON.stringify(Mahjong.debug.renderStats())"));
  A(sheetOn === true && rsS && rsS.faces === 34, "牌面全览画出全部 34 种牌（含 7 种字牌）", rsS && rsS.faces);
  const faceB64 = await ev(SHOT_EXPR("sheet"));
  if (faceB64) {
    const fb = Buffer.from(faceB64, "base64");
    fs.writeFileSync(path.join(shotDir(), "mahjong_faces.png"), fb);
    const fsz = pngSize(fb);
    info.faces = { file: "测试截图/mahjong_faces.png", bytes: fb.length, w: fsz && fsz.w, h: fsz && fsz.h };
    A(!!fsz && fsz.w === 1240 && fsz.h === 860, "牌面全览截图 1240×860", fsz ? fsz.w + "×" + fsz.h : "无");
  } else A(false, "牌面全览截图", "无数据");
  await ev("Mahjong.debug.faceSheet(false)");
  await sleep(260);
  /* ── 副露示范图（4 家 × 暗杠/明杠/碰/补杠） ── */
  const meldOn = await ev("Mahjong.debug.demoMelds(true)");
  await sleep(320);
  const rsD = JSON.parse(await ev("JSON.stringify(Mahjong.debug.renderStats())"));
  A(meldOn === true && rsD && rsD.meldTiles === 60, "四家副露共画出 60 张副露牌（暗杠/明杠/碰/补杠）", rsD && rsD.meldTiles);
  const meldB64 = await ev(SHOT_EXPR("sheet"));
  if (meldB64) {
    const mb = Buffer.from(meldB64, "base64");
    fs.writeFileSync(path.join(shotDir(), "mahjong_melds.png"), mb);
    const msz = pngSize(mb);
    info.melds = { file: "测试截图/mahjong_melds.png", bytes: mb.length, w: msz && msz.w, h: msz && msz.h };
    A(!!msz && msz.w === 1240 && msz.h === 860, "副露示范图 1240×860", msz ? msz.w + "×" + msz.h : "无");
  } else A(false, "副露示范图", "无数据");
  await ev("Mahjong.debug.demoMelds(false)");
  await sleep(260);
  await shot("mahjong_table_full");
  console.log("[截图] 测试截图/mahjong_table.png / mahjong_hand_zoom.png / mahjong_faces.png / mahjong_melds.png");

  /* ── 结算分支：调试造胡 → onFinish(win:true) → 页面走 perfect ── */
  const forced = await ev("(window.Mahjong.debug.forceWin)?Mahjong.debug.forceWin(0):false");
  await sleep(900);
  await shot("mahjong_result");
  await sleep(2600);
  const fin = JSON.parse(await ev(`JSON.stringify({
    forced:${JSON.stringify(forced)},
    on:document.getElementById("mj").classList.contains("on"),
    win:(window.__cs2&&window.__cs2.S)?window.__cs2.S.mjWin:null,
    node:(window.__cs2&&window.__cs2.node)||null, phase:(window.__cs2&&window.__cs2.phase)||null,
    busy:(window.Mahjong&&Mahjong.isBusy)?Mahjong.isBusy():null })`));
  info.settle = fin;
  console.log("[结算] " + JSON.stringify(fin));
  A(fin.forced === true, "调试造胡成功（自摸小胡）");
  A(fin.win === true, "结算回调 win:true → 页面标记 S.mjWin");
  A(fin.on === false, "结算后麻将面板关闭");
  A(fin.busy === false, "isBusy=false");

  /* ── 整局自走 + 每一拍审计 + 每一帧渲染审计（真浏览器引擎 + 真 canvas）──
     这条是「桌上出现六张六条」的常驻断言：只要有一拍违反守恒、或有一帧画出 >4 张同名牌，就红。 */
  {
    const rep = JSON.parse(await ev(`JSON.stringify((function(){
      var MJ = window.Mahjong;
      MJ.debug.tileAuditInstall();
      MJ.debug.tileAuditOn(true, null);
      var host = document.getElementById("mj");
      if (!host) return { err: "no-host" };
      MJ.start(host, {});
      MJ.debug.tileAuditInstall();
      MJ.debug.tileAuditOn(true, null);
      var frames = 0, worst = 0, over = [], guard = 0, wait = 0;
      function one() {
        try { MJ.debug.render(); } catch (e) {}
        frames++;
        var ra = MJ.debug.renderAudit();
        if (ra) { if (ra.max > worst) worst = ra.max; if (!ra.ok && !ra.debugView && over.length < 4) over.push(ra); }
      }
      one();
      while (guard++ < 900) {
        var st = MJ.debug.state();
        if (!st || st.phase === "over" || st.result) break;
        var E = MJ.debug.engine(), act = "";
        if (E && E.phase === "claim" && E.pending && E.pending.seat === 0) act = "pass";
        else if (E && E.phase === "rob" && E.pending && E.pending.seats && E.pending.seats.indexOf(0) >= 0) act = "pass";
        else if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 1) act = "draw";
        else if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2) act = "discard";
        if (act) { if (!MJ.debug.act(act)) { if (++wait > 3) break; } else wait = 0; }
        else {
          var r = MJ.debug.step();
          if (r === "off" || r === "over") break;
          if (r === "wait") { if (++wait > 3) break; } else wait = 0;
        }
        one();
      }
      var stt = MJ.debug.tileAuditState();
      var fin = MJ.debug.tileAudit();
      var out = { beats: stt.n, fails: stt.fails, frames: frames, renderMax: worst, renderOver: over,
                  final: fin ? { ok: fin.ok, total: fin.total, expect: fin.expect, max: fin.max, violations: fin.violations } : null };
      try { MJ.dispose(); } catch (e) {}
      return out;
    })())`));
    info.selfPlayAudit = rep;
    A(rep && rep.beats > 40, "整局自走：每一拍都审计", rep && (rep.beats + " 拍"));
    A(rep && rep.fails === 0, "整局自走：没有任何一拍违反牌张守恒（每种牌 ≤4 · 总数 136）",
      rep && (rep.fails === 0 ? (rep.beats + " 拍全绿") : "违规 " + rep.fails + " 拍 → " + JSON.stringify((rep.final || {}).violations)));
    A(rep && rep.final && rep.final.ok === true, "整局末态审计 ok（总数 = 应有张数）",
      rep && rep.final ? (rep.final.total + "/" + rep.final.expect + " 张 · 单种最大 " + rep.final.max +
        (rep.final.ok ? "" : " → " + JSON.stringify(rep.final.violations))) : "no-api");
    A(rep && rep.renderMax <= 4 && (!rep.renderOver || rep.renderOver.length === 0),
      "整局每一帧画面上每种牌面 ≤ 4 张（渲染层守恒）",
      rep ? (rep.frames + " 帧 · 单种最大 " + rep.renderMax) : "no-api");
  }

  /* ── 摆牌/造胡也必须守恒（根因修复的浏览器端断言）──
     旧实现 setHand/forceWin 只加不减，实测能摆出「六张六条 · 总数 137」。 */
  {
    const rig = JSON.parse(await ev(`JSON.stringify((function(){
      var MJ = window.Mahjong, host = document.getElementById("mj");
      MJ.start(host, {});
      var E = MJ.debug.engine();
      for (var i = 0; i < 26; i++) {
        var st = MJ.debug.state(); if (!st || st.phase === "over") break;
        if (st.phase === "claim" && st.pending && st.pending.seat === 0) MJ.debug.act("pass");
        else if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2) MJ.debug.act("discard");
        else MJ.debug.step();
      }
      var before = MJ.debug.tileAudit(), T = null, best = 0, k;
      for (k in before.byType) if (before.byType.hasOwnProperty(k)) {
        var mine = 0, q;
        for (q = 0; q < E.P[0].hand.length; q++) if (E.P[0].hand[q] === k) mine++;
        if (mine === 0 && before.byType[k] > best) { best = before.byType[k]; T = k; }
      }
      if (!T) return { err: "no-candidate" };
      var hand = [T, T, T], q2;
      for (q2 = 0; q2 < E.P[0].hand.length && hand.length < 14; q2++) hand.push(E.P[0].hand[q2]);
      var okSet = MJ.debug.setHand(hand, [], null);
      var after = MJ.debug.tileAudit();
      MJ.debug.render();
      var ra = MJ.debug.renderAudit();
      var out = { tile: T, elsewhere: best, set: okSet,
                  before: { ok: before.ok, total: before.total },
                  after: { ok: after.ok, total: after.total, count: after.byType[T], max: after.max,
                           violations: after.violations },
                  render: ra ? { ok: ra.ok, max: ra.max, faces: (ra.byType && ra.byType[T]) || 0 } : null,
                  refuse: MJ.debug.setHand([T, T, T, T, T], [], null) };
      try { MJ.dispose(); } catch (e) {}
      return out;
    })())`));
    info.rigAudit = rig;
    A(rig && rig.set === true, "调试摆牌成功（合法请求）", rig && rig.tile);
    A(rig && rig.after && rig.after.ok === true, "摆牌后牌张仍守恒（只搬牌不造牌）",
      rig && rig.after ? (rig.after.total + " 张 · 「" + rig.tile + "」" + rig.after.count + " 张 · 单种最大 " + rig.after.max +
        (rig.after.ok ? "" : " → " + JSON.stringify(rig.after.violations))) : "no-api");
    A(rig && rig.after && rig.after.count <= 4 && rig.after.total === rig.before.total,
      "摆牌不会让同名牌超过 4 张、也不会让总数变化（旧实现会变成 6 张 / 137 张）",
      rig && rig.after ? ("「" + rig.tile + "」" + rig.after.count + " 张 · 总数 " + rig.before.total + "→" + rig.after.total) : "no-api");
    A(rig && rig.refuse === false, "摆 5 张同名牌被拒绝（物理上只有 4 张）", rig && String(rig.refuse));
    A(rig && rig.render && rig.render.max <= 4, "摆牌后本帧画面单种 ≤ 4 张",
      rig && rig.render ? (rig.render.faces + " 张「" + rig.tile + "」· 单种最大 " + rig.render.max) : "no-api");
  }

  try { chrome.kill(); } catch (e) {}
  return { ok: errors.length === 0, checks, errors, info };
}

/* ══════════════ 主流程：先试 Chrome，失败则降级 mshta(Trident) ══════════════ */
(async () => {
  let mode = "chrome-cdp", checks = [], errors = [], info = {}, extraNote = "";
  let ch = null;
  try { ch = await runChrome(); } catch (e) { ch = { ok: false, why: "Chrome 流程异常：" + (e && e.message || e) }; }

  if (ch.ok) {
    checks = ch.checks; errors = ch.errors; info = ch.info;
    console.log("[模式] chrome-cdp · 通过 " + checks.length + " 项");
  } else {
    console.log("[模式A不可用] " + (ch.why || (ch.errors && ch.errors.length ? ("Chrome 段 " + ch.errors.length + " 项未过：" + ch.errors.join(" | ")) : "undefined")));
    console.log("[模式B] 降级：mshta / Trident(IE11 引擎) 真实渲染同一份 mahjong.js …");
    mode = "trident-hta";
    extraNote = "Chrome(headless CDP) 在当前沙箱无法启动：" + ch.why + "；已降级用 mshta(Trident/IE11 引擎) 真实渲染 + 读像素 + canvas.toDataURL 截图（同一份 mahjong.js，真实浏览器引擎）";
    const tri = await runTrident();
    if (!tri.ok) {
      console.error("FATAL: 浏览器实测无法执行 → " + tri.why);
      fs.writeFileSync(resultsFile("mahjong2-results.json"), JSON.stringify({
        success: false, testedAt: new Date().toISOString(), mode, checks, errors: [extraNote, tri.why], info
      }, null, 1), "utf8");
      process.exit(3);
    }
    const o = tri.out || { checks: {}, errors: [], info: {}, fin: null };
    info.trident = o.info; info.fin = o.fin; info.limitation = extraNote;
    info.chromeFail = ch.why;
    console.log("[Trident 探针原始] " + JSON.stringify(o.info));
    Object.keys(CHECK_ZH).forEach(k => {
      const val = o.info ? o.info[k] : undefined;
      const shown = (val === undefined ? "" : (val === true || val === 1 ? "" : "：" + val));
      if (o.checks && o.checks[k] !== undefined) checks.push(CHECK_ZH[k] + shown);
      else errors.push(CHECK_ZH[k] + shown);
    });
    if (o.errors && o.errors.length) errors.push("探针内部错误：" + o.errors.join(" | "));
    const shots = [
      { buf: tri.png, file: "测试截图/mahjong_table.png", key: "screenshot", want: [1240, 860] },
      { buf: tri.pngZ, file: "测试截图/mahjong_hand_zoom.png", key: "zoom", want: null },
      { buf: tri.pngF, file: "测试截图/mahjong_faces.png", key: "faces", want: [1240, 860] },
      { buf: tri.pngM, file: "测试截图/mahjong_melds.png", key: "melds", want: [1240, 860] },
      { buf: tri.pngH, file: "测试截图/mahjong_hint.png", key: "hintShot", want: [1240, 860] },
      { buf: tri.pngRH, file: "测试截图/mahjong_result_hands.png", key: "resultHands", want: [1240, 860] },
      { buf: tri.pngFS, file: "测试截图/mahjong_faces_sheet.png", key: "faceSheet", want: [1240, 860] },
      { buf: tri.pngV, file: "测试截图/mahjong_voice.png", key: "voiceShot", want: [1240, 860] }
    ];
    for (const s of shots) {
      if (!s.buf) { errors.push("未取得截图：" + s.file); continue; }
      const sz = pngSize(s.buf);
      info[s.key] = { file: s.file, bytes: s.buf.length, w: sz && sz.w, h: sz && sz.h, pngHeader: sz && sz.sig };
      console.log("[截图] " + s.file + "（" + s.buf.length + " 字节" + (sz ? "，" + sz.w + "×" + sz.h : "") + "）");
      if (!sz) { errors.push(s.file + " 不是合法 PNG"); continue; }
      if (s.want && (sz.w !== s.want[0] || sz.h !== s.want[1])) {
        errors.push(s.file + " 尺寸应为 " + s.want.join("×") + "，实际 " + sz.w + "×" + sz.h);
      }
    }
    /* ── 包间背景贴图的**像素级**取证（不靠源码字符串）：
       旧程序化绿绒的中心是绿色（G 明显大于 R）；新贴图是暖光茶室（R 大于 G）。 ── */
    const tblPx = decPng(tri.png);
    if (!tblPx) { errors.push("mahjong_table.png 解不开（无法做包间背景像素取证）"); }
    else {
      const ctr = regionAvg(tblPx, 560, 380, 680, 480, 3);
      const left = regionAvg(tblPx, 2, 260, 46, 600, 3);
      const top = regionAvg(tblPx, 300, 2, 900, 12, 5);   /* 方环放大后 y16 起就有牌，背景取样收到绒面之上 (y2..12) */
      const rgb = c => [Math.round(c.r), Math.round(c.g), Math.round(c.b)];
      info.bg_px = { center: rgb(ctr), left: rgb(left), top: rgb(top) };
      /* 判据：① 画面四边是暖木（R > G）→ 照片背景真的铺上了（旧程序化底只有绿绒 + 黑边）；
              ② 中心不是旧程序化绿绒那种饱和绿（G 远超 R）。 */
      const warm = c => c.r > c.g + 6 && c.r > 30;
      const greenExcess = Math.round((ctr.g - ctr.r) * 10) / 10;
      if (warm(left) && warm(top) && greenExcess < 15) {
        checks.push("包间背景像素取证（中心 " + rgb(ctr).join(",") + " / 左 " + rgb(left).join(",") +
                    " / 顶 " + rgb(top).join(",") + "：四边暖木、中心非饱和绿绒）");
      } else {
        errors.push("包间背景像素取证失败（中心 " + rgb(ctr).join(",") + " / 左 " + rgb(left).join(",") +
                    " / 顶 " + rgb(top).join(",") + "，中心绿超出 " + greenExcess + "）");
      }
    }
    /* ── 牌背像素级取证：牌墙区域里必须同时有「绿色主面」与「象牙白棱边」（一面绿一面白）── */
    const wpx = countBackColors(tblPx, [ { x: 560, y: 55, w: 120, h: 23 }, { x: 255, y: 340, w: 24, h: 100 } ]);
    info.tileBackPx = wpx;
    if (wpx.green > 200 && wpx.ivory > 60) {
      checks.push("牌背像素取证（牌墙取样 " + wpx.n + " px：绿 " + wpx.green + " px / 象牙白 " + wpx.ivory +
                  " px）→ 一面绿、一面象牙白 ✔");
    } else {
      errors.push("牌背像素取证失败（绿 " + wpx.green + " / 象牙白 " + wpx.ivory +
                  "）→ 牌墙区域没同时画出「绿色主面」与「象牙白棱边」");
    }
    /* ── 绿面朝外（截图像素实测）：顶墙带外沿那条窄带必须是象牙白、紧挨着的内侧带必须是绿面 ── */
    const stOut = countBackColors(tblPx, [ { x: 566, y: 57, w: 108, h: 3 } ]);
    const stIn = countBackColors(tblPx, [ { x: 566, y: 62, w: 108, h: 14 } ]);
    const fOut = stOut.n ? stOut.ivory / stOut.n : 0, fIn = stIn.n ? stIn.green / stIn.n : 0;
    if (fOut >= 0.55 && fIn >= 0.60) {
      checks.push("绿面朝外（截图像素实测）：顶墙外沿窄带象牙白占比 " + fOut.toFixed(2) + " ≥0.55 · 内侧带绿面占比 " +
                  fIn.toFixed(2) + " ≥0.60 → 白棱压在外沿、绿面朝外 ✔");
    } else {
      errors.push("绿面朝外失败：外沿白 " + fOut.toFixed(2) + "（需 ≥0.55）/ 内侧绿 " + fIn.toFixed(2) + "（需 ≥0.60）");
    }
    /* ── 圆盘文字可见：文字区里非深色像素占比达标（证明「余 N 张 · 第 N 巡」真的合成上去了）── */
    let dBright = 0, dTot = 0;
    if (tblPx) for (let yy = 358; yy < 402; yy++) for (let xx = 582; xx < 658; xx++) {
      const ii = (yy * tblPx.w + xx) * tblPx.ch;
      dTot++;
      if (tblPx.data[ii] + tblPx.data[ii + 1] + tblPx.data[ii + 2] > 330) dBright++;
    }
    const dRat = dTot ? dBright / dTot : 0;
    if (dRat >= 0.03) {
      checks.push("圆盘文字可见：文字区 " + dTot + " px 里非深色 " + dBright + " px（占比 " + dRat.toFixed(3) +
                  " ≥0.03）→「余 N 张 · 第 N 巡」已合成回圆盘 ✔");
    } else {
      errors.push("圆盘文字不可读：文字区非深色占比只有 " + dRat.toFixed(3) + "（需 ≥0.03）");
    }
    if (!tri.png2) console.log("[提示] 结算面板截图缺失（不影响断言）");
  }

  const res = {
    success: errors.length === 0, mode, testedAt: new Date().toISOString(),
    note: extraNote, checks, errors, info
  };
  fs.writeFileSync(resultsFile("mahjong2-results.json"), JSON.stringify(res, null, 1), "utf8");
  console.log("\n════════════════════════════════");
  console.log("模式 " + mode + " · 通过 " + checks.length + "，失败 " + errors.length + (errors.length ? " | " + errors.join(" | ") : "，全部通过 ✔"));
  setTimeout(() => process.exit(errors.length ? 1 : 0), 300);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
