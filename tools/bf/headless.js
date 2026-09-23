/* ═══════════════════════════════════════════════════════════════════════════
   无头渲染验收（Chrome / Edge / mshta 都被当前沙箱拦住时的降级证据链）
   做法：在 Node 里给 breakfast.js 套一个「最小 DOM + 记录式 Canvas2D + 可手动泵的 rAF」环境，
        真实调用 start()，然后一帧帧泵动画循环，统计：
          · 绘制指令数 / 用色数量 / 食物矢量图元（煎蛋/培根/三明治/粥/沙拉/果汁…）
          · 灶位、出餐盘、食材桶、顾客订单卡、顶栏倒计时的绘制证据
          · 火候三态（生 / 恰好 / 糊）描边色是否按规则变化
          · 真实鼠标事件（mousedown/mousemove/mouseup）能不能把食材放进灶位
          · debug 驱动一条通过路径 + 一条失败路径，读结算 result 与 onFinish
        这不是像素级证据（那需要真浏览器），但足以证明「渲染层真的在画、且画的是该画的东西」。
   运行：node tools/bf/headless.js
   ═══════════════════════════════════════════════════════════════════════════ */
const fs = require("fs");
const { resultsFile } = require("../lib/dist.js");
const mp3 = require("./mp3info.js");                  // 只读 MP3 头量时长（不依赖 ffmpeg）
const path = require("path");
const vm = require("vm");

const OUT = path.join(__dirname, "..", "..");
const SHOT_DIR = path.join(OUT, "测试截图");
const SRC = fs.readFileSync(path.join(OUT, "breakfast.js"), "utf8");
/* 画面逻辑尺寸（放大后的规格：要求 B ≥1100×680）*/
const VW = 1180, VH = 790;

/* ── 本地食材贴图（art/icons/<foodId>.png）────────────────────────────────
   breakfast.js 现在会预加载 art/icons/ 下的本地 PNG 并 drawImage。
   无头环境本来没有真实解码能力，所以这里做一个**真去文件系统读 PNG** 的替身：
   读 IHDR 拿到真实宽高喂给 naturalWidth/naturalHeight —— 这样「按图片真实宽高
   等比缩放」的那段代码走的是真数据，而不是被桩成一个假数字。 */
const ICON_DIR = path.join(OUT, "art", "icons");
/** 读 PNG 的 IHDR → { w, h }（不解 IDAT，只取宽高；校验签名与 8bit/颜色类型）*/
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG：" + file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), depth: b[24], color: b[25] };
}
/** 把 <img>.src（可能是绝对路径 / file:// URL / 相对 URL）落成磁盘路径 */
function resolveImgPath(src) {
  let s = String(src || "");
  if (/^file:\/\//i.test(s)) {
    s = decodeURIComponent(s.replace(/^file:\/\//i, ""));
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);            // /C:/... → C:/...
  }
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\")) return path.normalize(s);
  if (s.startsWith("/")) s = s.slice(1);
  return path.join(OUT, s);
}
/** 记录式图片替身：src 一赋值就同步去磁盘读 PNG（成功→loaded，失败→error）*/
function makeRecord() {
  return { drawImage: [], imgLoads: [], imgErrors: [],
           /* 音效验收用：new Audio / play() 的调用序列、被 pause 过的音频、内存 localStorage */
           audio: [], audioPauses: [], storage: {} };
}
function makeImageCtor(record) {
  return function Image() {
    const img = {
      naturalWidth: 0, naturalHeight: 0, complete: false, width: 0, height: 0,
      onload: null, onerror: null, _src: "",
      get src() { return this._src; },
      set src(v) {
        this._src = String(v);
        let sz = null;
        try { sz = pngSize(resolveImgPath(v)); } catch (e) { sz = null; }
        if (sz) {
          this.naturalWidth = sz.w; this.naturalHeight = sz.h; this.width = sz.w; this.height = sz.h;
          this.complete = true;
          record.imgLoads.push({ src: this._src, w: sz.w, h: sz.h });
          if (typeof this.onload === "function") this.onload({ target: this });
        } else {
          this.complete = false;
          record.imgErrors.push({ src: this._src });
          if (typeof this.onerror === "function") this.onerror({ target: this });
        }
      }
    };
    return img;
  };
}

/* ── 记录式 Audio 替身（音效验收用）──────────────────────────────────────
   breakfast.js 的音效层是「有文件用文件，缺失静默回落」：没有 Audio / play() 被拦 / error 事件
   → 都不许影响玩法。无头里就给一个**只记录不发声**的 Audio：
     · 每次 new / play 都留痕（src + volume），断言直接看调用序列；
     · audioBlock:true 时，play() 会**同步**触发 error 事件并返回一个同步 catch 的 thenable ——
       这样「被浏览器策略拦 / 文件缺失」这条回落路径在同步的无头流程里也能断言到（不用等微任务）；
     · pause() 也留痕：breakfast.js 声称「不打断正在播的其它语音」，这一条要能被证伪。 */
function makeAudioCtor(record, opts) {
  opts = opts || {};
  return function Audio(src) {
    const a = {
      src: String(src || ""), volume: 1, currentTime: 0, paused: true, _h: {},
      addEventListener(t, f) { (a._h[t] = a._h[t] || []).push(f); },
      removeEventListener(t, f) { const h = a._h[t] || []; const i = h.indexOf(f); if (i >= 0) h.splice(i, 1); },
      play() {
        const rec = { src: a.src, volume: a.volume, blocked: !!opts.audioBlock };
        record.audio.push(rec);
        if (opts.audioBlock) {
          (a._h.error || []).slice().forEach(f => f({ type: "error", target: a }));
          return { catch(fn) { rec.blocked = true; try { fn(new Error("NotAllowedError: play() blocked")); } catch (e) {} return this; } };
        }
        a.paused = false;
        return { catch() { return this; } };
      },
      pause() { a.paused = true; record.audioPauses.push(a.src); },
      load() {}, canPlayType() { return "maybe"; }
    };
    return a;
  };
}
/** 内存 localStorage 替身：验「开关记在 localStorage.bfSoundOn 里」*/
function makeLocalStorage(record) {
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(record.storage, k) ? record.storage[k] : null; },
    setItem(k, v) { record.storage[k] = String(v); },
    removeItem(k) { delete record.storage[k]; },
    clear() { record.storage = {}; }
  };
}
/* ── 固定随机种子（可复现）───────────────────────────────────────────────
   breakfast.js 里所有随机都走 rnd01() → Math.random()（顾客进店 / 订单长度 / 订单内容 /
   进店间隔）。无头链把宿主 Math 换成一个定种子 PRNG，场景就完全可复现：
   不会因为「某次随机到 3 张单子刚好覆盖 9 样菜」「某个顾客的耐心刚好在这一帧归零」
   这类偶发场景让验收飘。默认种子固定 → 连跑结果逐字一致；
   BF_SEED=123 可以换种子做鲁棒性扫测（用于确认断言不是只对某一个种子成立）。 */
const BF_SEED = (process.env.BF_SEED === undefined || process.env.BF_SEED === "") ? 20260917 : (Number(process.env.BF_SEED) || 20260917);
function makeRng(seed) {                       // mulberry32
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 宿主 Math：继承真 Math 的全部常量/函数，只把 random 换成本局的定种子 PRNG */
function seededMath(seed) { const M = Object.create(Math); M.random = makeRng(seed); return M; }

/* ── 极简选择器匹配：tag / .class / #id / tag.class / [attr="v"] / :not(.x) ── */
function matchSel(el, sel) {
  let s = String(sel).trim();
  const nots = [];
  s = s.replace(/:not\(([^)]*)\)/g, (_, inner) => { nots.push(inner.trim()); return ""; });
  let attr = null;
  s = s.replace(/\[([^\]=]+)(?:=("?)([^\]"]*)\2)?\]/g, (_, k, _q, v) => { attr = { k: k.trim(), v: v }; return ""; });
  let tag = null;
  const tagM = s.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  if (tagM) { tag = tagM[0].toUpperCase(); s = s.slice(tagM[0].length); }
  const idM = s.match(/#([\w-]+)/); const id = idM ? idM[1] : null;
  const clsM = s.match(/\.([\w-]+)/g); const clss = clsM ? clsM.map(x => x.slice(1)) : [];
  if (tag && el.tagName !== tag) return false;
  if (id && el.id !== id) return false;
  for (const c of clss) if (String(el.className).split(/\s+/).indexOf(c) < 0) return false;
  if (attr) {
    const val = el.getAttribute ? el.getAttribute(attr.k) : el[attr.k];
    if (val === null || val === undefined) return false;
    if (attr.v !== undefined && String(val) !== String(attr.v)) return false;
  }
  for (const n of nots) if (matchSel(el, n)) return false;
  return true;
}

/* ── 记录式 Canvas2D mock ── */
function makeCtx(record) {
  const log = { ops: 0, fills: 0, strokes: 0, arcs: 0, ellipses: 0, rects: 0, texts: 0, gradients: 0, images: 0 };
  const colors = {}, strokes = {}, texts = [];
  let cur = { fill: "#000", stroke: "#000", font: "10px sans-serif", alpha: 1, lineWidth: 1 };
  const stack = [];
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const ctx = {
    canvas: null,
    get fillStyle() { return cur.fill; }, set fillStyle(v) { cur.fill = v; bump(colors, String(v)); },
    get strokeStyle() { return cur.stroke; }, set strokeStyle(v) { cur.stroke = v; bump(strokes, String(v)); },
    get font() { return cur.font; }, set font(v) { cur.font = v; },
    get globalAlpha() { return cur.alpha; }, set globalAlpha(v) { cur.alpha = v; },
    get lineWidth() { return cur.lineWidth; }, set lineWidth(v) { cur.lineWidth = v; },
    textAlign: "left", textBaseline: "alphabetic",
    save() { log.ops++; stack.push(Object.assign({}, cur)); },
    restore() { log.ops++; if (stack.length) cur = stack.pop(); },
    translate() { log.ops++; }, scale() { log.ops++; }, rotate() { log.ops++; }, setTransform() { log.ops++; },
    beginPath() { log.ops++; }, closePath() { log.ops++; },
    moveTo() { log.ops++; }, lineTo() { log.ops++; }, quadraticCurveTo() { log.ops++; }, bezierCurveTo() { log.ops++; },
    arc() { log.ops++; log.arcs++; }, ellipse() { log.ops++; log.ellipses++; }, rect() { log.ops++; log.rects++; },
    fillRect() { log.ops++; log.rects++; log.fills++; }, strokeRect() { log.ops++; log.strokes++; },
    fill() { log.ops++; log.fills++; }, stroke() { log.ops++; log.strokes++; }, clip() { log.ops++; },
    fillText(t) { log.ops++; log.texts++; texts.push(String(t)); },
    strokeText(t) { log.ops++; log.texts++; texts.push(String(t)); },
    measureText(t) { return { width: String(t).length * 6 }; },
    createLinearGradient() { log.gradients++; return { addColorStop() {} }; },
    createRadialGradient() { log.gradients++; return { addColorStop() {} }; },
    createPattern() { return null; },
    /* 现在允许画 art/** 下的本地贴图（背景 / 食材 / 厨具 / 头像 / UI）。
       这里不改写像素，只如实记录每次 drawImage 的**源矩形 + 目标框**：
       5 参（图 + 目标框）与 9 参（源矩形 + 目标框）都记全，断言直接对着记录核对。 */
    drawImage(img, dx, dy, dw, dh) {
      log.ops++; log.images++;
      if (!record) return;
      const a = arguments.length;
      const nw = (img && img.naturalWidth) || 0, nh = (img && img.naturalHeight) || 0;
      const rec = { img: img, src: (img && img.src) || "", argc: a,
                    sx: 0, sy: 0, sw: nw, sh: nh, dx: dx, dy: dy, dw: dw, dh: dh };
      if (a >= 9) { rec.sx = dx; rec.sy = dy; rec.sw = dw; rec.sh = dh;
                    rec.dx = arguments[5]; rec.dy = arguments[6]; rec.dw = arguments[7]; rec.dh = arguments[8]; }
      record.drawImage.push(rec);
    },

    getImageData() { return { data: new Uint8ClampedArray(4) }; },
    putImageData() {},
  };
  return { ctx, log, colors, strokes, texts };
}

/* ── 最小 DOM mock ── */
function makeEl(tag, record) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], parentNode: null,
    id: "", className: "", _html: "", textContent: "", type: "", value: "",
    style: {}, dataset: {}, _handlers: {},
    set innerHTML(v) { this._html = String(v); this.children = []; }, get innerHTML() { return this._html; },
    setAttribute(k, v) { if (k === "id") this.id = v; if (k === "class") this.className = v; this[k] = v; },
    getAttribute(k) { return this[k] === undefined ? null : this[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    addEventListener(t, f) { (this._handlers[t] = this._handlers[t] || []).push(f); },
    removeEventListener(t, f) { const h = this._handlers[t] || []; const i = h.indexOf(f); if (i >= 0) h.splice(i, 1); },
    dispatch(t, ev) { (this._handlers[t] || []).slice().forEach(f => f(ev || {})); },
    /** 真按钮语义：点一下 = 派发 click（无头里验 #bfGo 出口） */
    click() { this.dispatch("click", { preventDefault() {}, stopPropagation() {} }); },
    all() { const out = []; (function walk(n) { (n.children || []).forEach(c => { out.push(c); walk(c); }); })(this); return out; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { return this.all().filter(e => matchSel(e, sel)); },
    getBoundingClientRect() { return { left: 0, top: 0, width: VW, height: VH, right: VW, bottom: VH }; },
    getContext() { return this._ctx; },
    classList: null,
  };
  el.classList = {
    /* 注意：[].slice.call(Set) 恒为 []（Set 不是数组式对象）→ 会把 className 抹成空串。
       这里必须用 [...s] / Array.from(s)，否则 classList.add 等于「清空 class」。 */
    add(c) { const s = new Set(String(el.className).split(/\s+/).filter(Boolean)); s.add(c); el.className = [...s].join(" "); },
    remove(c) { const s = new Set(String(el.className).split(/\s+/).filter(Boolean)); s.delete(c); el.className = [...s].join(" "); },
    contains(c) { return String(el.className).split(/\s+/).indexOf(c) >= 0; },
    toggle(c, on) { if (on === undefined) on = !this.contains(c); on ? this.add(c) : this.remove(c); },
  };
  if (el.tagName === "CANVAS") {
    const m = makeCtx(record);
    el._ctx = m.ctx; m.ctx.canvas = el; el._m = m;
    el.width = 300; el.height = 150;
  }
  return el;
}

/* ── 装载：可手动泵的 rAF + 可控时钟 ── */
function boot(opts) {
  opts = opts || {};
  const record = makeRecord();
  const ImageCtor = makeImageCtor(record);
  const AudioCtor = makeAudioCtor(record, opts);        // 假 Audio（音效验收；opts.audioBlock 可模拟被拦）
  const body = makeEl("body", record);
  const host = makeEl("div", record); host.id = "bfGameHost"; body.appendChild(host);
  const frames = [];
  let clock = 0;
  const listeners = { window: {}, document: {} };
  const win = {
    devicePixelRatio: 2,
    performance: { now: () => clock },
    requestAnimationFrame: cb => { frames.push(cb); return frames.length; },
    cancelAnimationFrame: id => { frames[id - 1] = null; },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    addEventListener: (t, f) => { (listeners.window[t] = listeners.window[t] || []).push(f); },
    removeEventListener: (t, f) => { const h = listeners.window[t] || []; const i = h.indexOf(f); if (i >= 0) h.splice(i, 1); },
    document: null,
    Image: ImageCtor,
    Audio: AudioCtor,                                  // breakfast.js 的音效层会 new Audio(url)
    localStorage: makeLocalStorage(record),            // 音效开关键（bfSoundOn）落在这里
    /* 本地贴图按「当前页面目录」解析 → 这里把页面当作 OUT/index.html，
       于是 art/icons/<foodId>.png 落到 OUT/art/icons/ 下（真有文件，真读宽高）。 */
    location: { href: "file:///" + path.join(OUT, "index.html").replace(/\\/g, "/"), pathname: "/" + path.join(OUT, "index.html").replace(/\\/g, "/") },
  };
  win.document = {
    body,
    createElement: tag => makeEl(tag, record),
    getElementById: id => (id === "bfGameHost" ? host : null),
    querySelector: sel => body.querySelector(sel),
    querySelectorAll: sel => body.querySelectorAll(sel),
    /* 记录 keydown：ESC = 点出口按钮（#bfGo）要能在无头里验 */
    addEventListener: (t, f) => { (listeners.document[t] = listeners.document[t] || []).push(f); },
    removeEventListener: (t, f) => { const h = listeners.document[t] || []; const i = h.indexOf(f); if (i >= 0) h.splice(i, 1); },
  };
  /* 关键：breakfast.js 在**模块初始化时**就预加载贴图，所以「没有 Image / 加载失败」
     这两个开关必须在跑源码之前就位（第一版把它们放在 start() 里，永远走不到，
     6 条断言直接翻车）。做法是塞一个 __bfIconPre 到全局，源码顶部读它。 */
  const ctx = vm.createContext(Object.assign(win, {
    console, Math: seededMath(BF_SEED), Date, isFinite, Number, String, Object, Array,
    __bfIconPre: { noImages: !!opts.noImages, forceFail: !!opts.imagesFail }
  }));
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.runInContext(SRC + "\n;globalThis.__BF = window.Breakfast;", ctx);
  /** 泵 n 帧（每帧把时钟往前推 ms 毫秒），返回渲染次数 */
  function pump(n, ms) {
    let rendered = 0;
    for (let i = 0; i < n; i++) {
      clock += (ms === undefined ? 16 : ms);
      const list = frames.slice();
      frames.length = 0;
      list.forEach(cb => { if (cb) { cb(clock); rendered++; } });
      if (!frames.length) break;                 // 循环已结束（结算/销毁）
    }
    return rendered;
  }
  return { B: ctx.__BF, body, host, pump, listeners, win: ctx, now: () => clock, canvas: () => host.querySelector("canvas.bf-cv"),
           record, ImageCtor,
           /** 改图片可用性开关后按当前基准重新预加载 9 张（用来分别验图片 / 矢量两条分支）*/
           reloadIcons: (flags) => {
             const f = flags || {};
             vm.runInContext("(function(){var F=globalThis.__BF.__bfIconFlags();" +
               "F.forceFail=" + (f.forceFail ? "true" : "false") + ";" +
               "F.forceNull=" + (f.forceNull ? "true" : "false") + ";})();", ctx);
             const before = record.drawImage.length;
             vm.runInContext("globalThis.__BF.__bfPreloadIcons();", ctx);
             return { before: before, after: record.drawImage.length };
           },
           /** ESC = 点 #bfGo（无头里把 keydown 递给 breakfast.js 挂上去的那个监听） */
           esc: () => (listeners.document.keydown || []).slice().forEach(f => f({ key: "Escape", preventDefault() {}, stopPropagation() {} })),
           docKeys: () => (listeners.document.keydown || []).length };
}

/* ── 测试 ── */
const checks = [], errors = [];
const A = (ok, name, extra) => { if (ok) checks.push(name + (extra ? "（" + extra + "）" : "")); else errors.push(name + (extra ? " → " + extra : "")); };

function runMain() {
  const { B, host, pump, listeners, canvas } = boot();
  A(!!B && typeof B.start === "function", "breakfast.js 在无 DOM 依赖环境里装载成功");
  A(!!B.rules && !!B.ui && !!B.debug, "对外 API 齐全（start/isBusy/dispose + rules/ui/debug）");

  /* ① 开局 + 首帧渲染 */
  let finished = null;
  const okStart = B.start(host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 75, goal: 8, onFinish: r => { finished = r; } });
  A(okStart === true, "start() 返回 true，游戏挂载到宿主节点");
  A(B.isBusy() === true, "isBusy() === true");
  const cv = canvas();
  A(!!cv, "宿主里生成了 canvas.bf-cv");
  const m = cv._m;
  A(VW >= 1100 && VH >= 680, "画面规格 ≥1100×680（要求 B1）", VW + "×" + VH);
  A(cv.width === VW * 2 && cv.height === VH * 2, "位图按 devicePixelRatio=2 绘制", cv.width + "×" + cv.height);
  {
    const v = B.debug.view();
    A(!!v && v.w === VW && v.h === VH, "debug.view() 报告的画布逻辑尺寸与规格一致", v && (v.w + "×" + v.h));
    A(v.font.body >= 16 && v.font.tiny >= 16, "正文字号 ≥16px（要求 B2）", "正文 " + v.font.body + "px / 最小 " + v.font.tiny + "px");
    A(v.font.micro >= 13, "列头小字 ≥13px（用户要求「小字」）", "列头 " + v.font.micro + "px");
    A(v.font.clock >= 28 && v.font.score >= 28 && v.font.patience >= 28, "关键数字 ≥28px（倒计时/分数/耐心）",
      "倒计时 " + v.font.clock + " / 分数 " + v.font.score + " / 耐心 " + v.font.patience);
    A(v.icon.food >= 64, "单份食物视觉尺寸 ≥64px（要求 B3）", v.icon.food + "px");
    A(v.lay.stove.panW >= 110, "每个锅位 ≥110px（要求 B5）", v.lay.stove.panW + "px");
    A(v.lay.cards.w >= 220, "顾客卡宽度 ≥220（要求 B6）", v.lay.cards.w + "×" + v.lay.cards.h + "（为让出 9 列，卡片压矮了）");
  }
  A(m.log.ops > 800, "首帧真的画了一堆东西（绘制指令数）", m.log.ops + " ops");
  /* 本轮起，锅体 / 盘 / 食物改走贴图，矢量图元数量会下降 —— 所以判据从
     「矢量 fills 很多」改成「矢量图元 + 贴图 drawImage 合计画满整屏」，
     两边任一充足都说明画面不是空的（缺素材时 fills 多，有素材时 images 多）。 */
  A(m.log.fills > 40 && m.log.strokes > 20, "首帧真的画了一堆矢量图元（底衬 / 边框 / 文字底）",
    m.log.fills + " fills / " + m.log.strokes + " strokes");
  A(m.log.images >= 25, "首帧真的把贴图画上去了（背景 + 9 厨具 + 9 盘 + 9 桶 + 星级 + 金币）",
    m.log.images + " 次 drawImage");
  A(Object.keys(m.colors).length >= 10, "用到了多种颜色（暖木 + 锅具 + 食物）", Object.keys(m.colors).length + " 种");
  A(m.log.gradients >= 3, "用了渐变（暖木背景 / 锅体）", m.log.gradients + " 个渐变");

  /* ② 食材桶 / 9 列灶位 / 9 个专属盘 */
  const FOODN = ["煎蛋", "培根", "三明治", "白粥", "热牛奶", "包子", "沙拉", "果汁", "清汤"];
  const shown = FOODN.filter(n => m.texts.some(t => t.indexOf(n) >= 0));
  A(shown.length === 9, "底部食材桶 9 样全部画出（含文字标签）", shown.join("/"));
  A(m.texts.some(t => /汤锅/.test(t)) && m.texts.some(t => /煎盘/.test(t)) && m.texts.some(t => /蒸格/.test(t)) && m.texts.some(t => /沙拉台/.test(t)) && m.texts.some(t => /果汁机/.test(t)),
    "五类厨具（汤锅/煎盘/蒸格/沙拉台/果汁机）都画出来了");
  A(m.texts.filter(t => /· 空/.test(t)).length >= 9, "9 个专属空盘都画了（浅色轮廓 + 列归属标签）",
    "「…· 空」×" + m.texts.filter(t => /· 空/.test(t)).length);
  A(m.texts.some(t => /点食材/.test(t)) && m.texts.some(t => /双击盘/.test(t)),
    "画布图例写清三条操作：点食材 → 自动下锅 ｜ 点盘 → 送给顾客 ｜ 双击盘 → 丢垃圾桶");
  A(m.texts.some(t => /苏晚晴/.test(t)), "顶栏画出了本次赠送对象");
  A(m.texts.some(t => /⏱/.test(t)) && m.texts.some(t => /顾客 \d+ \/ \d+/.test(t)), "顶栏画出了倒计时与目标进度");
  {
    const barEl = host.querySelector(".bf-bar");
    const tipEl = host.querySelector(".bf-tip");
    const titleEl = host.querySelector(".bf-title");
    A(!!barEl && !!tipEl && !!titleEl && /苏晚晴/.test(String(titleEl._html)) &&
      /点食材/.test(String(tipEl._html)) && /双击盘/.test(String(tipEl._html)),
      "标题栏 / 提示行 DOM 里写着赠送对象与三条操作提示",
      String((tipEl && tipEl._html) || "").slice(0, 60));
  }
  /* 食物现在是贴图（drawImage），矢量椭圆只剩盘底阴影 ——「有没有食物」改成
     「贴图或矢量图元任一充足」。 */
  A(m.log.ellipses > 5 || m.log.images >= 25, "画面里真有一份份食物（食物贴图 drawImage 或矢量图元）",
    m.log.ellipses + " 个 ellipse / " + m.log.images + " 次 drawImage");
  A(m.log.arcs > 5, "圆形图元（炉口火焰 / 樱瓣）在画", m.log.arcs + " 个 arc");
  A(!m.colors["#8a87a3"], "9 样食材都有自己的矢量图（没有落到 drawFood 的兜底灰块）",
    m.colors["#8a87a3"] ? "有食材缺图（兜底灰块 ×" + m.colors["#8a87a3"] + "）" : "全部有图");

  /* ③ 泵帧：顾客进店 → 订单卡 + 耐心条 + 顶栏进度 */
  const t0 = m.texts.length;
  const rendered = pump(400, 16);                // ≈6.4 秒
  A(rendered >= 10, "动画循环可持续泵帧（rAF 正常重绘）", rendered + " 帧");
  const frameTexts = m.texts.slice(t0);
  const os0 = B.debug.orders();
  A(os0.length >= 1, "顾客陆续进店并生成订单", os0.length + " 位");
  A(os0[0].order.length >= 1 && os0[0].order.length <= 3, "订单长度 1~3 样", JSON.stringify(os0[0].order));
  A(frameTexts.some(t => /顾客 #/.test(t)), "订单卡画出了顾客编号");
  A(frameTexts.some(t => /^\d+(\.\d+)?s$/.test(t)), "订单卡画出了耐心倒计时（秒）", (frameTexts.filter(t => /^\d+(\.\d+)?s$/.test(t))[0] || ""));
  A(frameTexts.some(t => /顾客 \d+ \/ \d+/.test(t)), "顶栏画出了「顾客 N / 8」进度", (frameTexts.filter(t => /顾客 \d+ \/ \d+/.test(t))[0] || ""));
  A(frameTexts.some(t => /⏱/.test(t)), "顶栏画出了倒计时");
  A(frameTexts.filter(t => FOODN.indexOf(t) >= 0).length >= 1, "订单卡里画出了所需食物的矢量图标");
  A(B.debug.stations().length === 9, "9 列 = 9 灶位（3 锅 + 3 煎盘 + 蒸格 + 沙拉台 + 果汁机）", B.debug.stations().length + " 个");

  /* ④ 火候三态描边色（生 → 恰好 → 糊） */
  const beforeOps = m.log.ops;
  pump(30, 16);
  A(m.log.ops > beforeOps + 30 * m.log.ops / 1e9, "运行中每帧都在重绘", (m.log.ops - beforeOps) + " ops / 30 帧");
  B.debug.place("egg", 3);
  A(B.debug.stations()[3].food === "egg", "debug.place 把煎蛋放到 1 号煎盘");
  const strokesAt = () => Object.assign({}, m.strokes);
  B.debug.setCook(3, 0.5); pump(2); const sRaw = strokesAt();
  B.debug.setCook(3, 2.5); pump(2); const sPerf = strokesAt();   // 新表：煎蛋 2.2s 熟 / 2.9s 出窗口
  const grew = (a, b, k) => (b[k] || 0) > (a[k] || 0);
  A(grew(sRaw, sPerf, "#5dffa0"), "「恰好」时出现绿色描边（完美窗口）", "#5dffa0 ×" + (sPerf["#5dffa0"] || 0));
  B.debug.setCook(3, 5.2); pump(2); const sBurn = strokesAt();
  A(grew(sPerf, sBurn, "#ff4d6d"), "「糊」时出现红色描边（焦黑警告）", "#ff4d6d ×" + (sBurn["#ff4d6d"] || 0));
  A(B.debug.stations()[3].state === "burnt", "state() 报告该灶位已糊");
  B.debug.trash(3);                              // 清掉这一列，后面的鼠标用例要重新用第 3 列
  A(B.debug.stations()[3].food === null, "双击/右键清空这一列后锅位恢复");
  const t1 = m.texts.length;
  B.debug.place("congee", 0);                    // 白粥：3.4s 恰好 / 5.6s 糊（bf-9 新表）
  pump(540, 16);                                 // ≈8.6 秒：走完 生 → 恰好 → 糊，飘字会被真的画出来
  A(B.debug.stations()[0].state === "burnt", "汤锅里的白粥在真实帧推进下烧糊了", B.debug.stations()[0].state + " @ " + B.debug.stations()[0].t + "ms");
  A(m.texts.slice(t1).some(t => /糊了/.test(t)), "糊掉时画了「糊了！」飘字", (m.texts.slice(t1).filter(t => /糊/.test(t))[0] || ""));
  A(m.texts.slice(t1).some(t => /丢掉了/.test(t)) === false, "（丢垃圾桶前还没丢）");
  B.debug.trash(0);
  A(B.debug.stations()[0].food === null, "垃圾桶：糊掉的食物丢掉后灶位清空，且不扣分");
  A(B.debug.score() !== null, "debug.score() 可读");

  /* ⑤ 列绑定（要求 A1）+ 真实鼠标事件（不走 debug API） */
  const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  {
    /* 9 列列对齐：底部食材桶 / 中列锅 / 上列专属盘 同一 x 中心线（±2px） */
    let worst = 0;
    for (let i = 0; i < 9; i++) {
      const sb = B.stationBox(i), pb = B.plateBox(i), bb = B.bucketBox(i);
      const cxs = sb.x + sb.w / 2, cxp = pb.x + pb.w / 2, cxb = bb.x + bb.w / 2;
      worst = Math.max(worst, Math.abs(cxs - cxp), Math.abs(cxs - cxb));
      A(pb.y + pb.h <= sb.y, "第 " + i + " 列：专属盘在锅的正上方");
      A(bb.y >= sb.y + sb.h, "第 " + i + " 列：食材桶在锅的正下方（底排）");
      A(pb.x >= 0 && pb.x + pb.w <= VW && bb.x >= 0 && bb.x + bb.w <= VW, "第 " + i + " 列不越界");
    }
    A(worst <= 2, "9 列列对齐：食材桶 / 锅 / 专属盘 同一 x 中心线（最大偏差 " + worst.toFixed(2) + "px ≤ 2px）");
    A(B.FOOD_IDS.length === 9 && B.COL_N === 9, "9 列 = 9 样食材（底部一排 9 个桶）",
      B.FOOD_IDS.map(f => B.FOOD[f].n).join("/"));
    A(B.debug.columns().length === 9, "9 个灶位");
    A(B.debug.plates().length <= 9 && B.PLATES_TOTAL === 9, "9 个专属盘（每列 1 个）");
    const cols = B.debug.columns();
    A(cols.every((c, i) => c.col === i && c.food === B.FOOD_IDS[i] && c.stationName === B.COLS[i].station),
      "列绑定一一对应且索引稳定：food ↔ 灶位 ↔ 盘",
      cols.map(c => c.food + "→" + c.stationName).join(" "));
    A(cols.every(c => c.plateName.indexOf(B.FOOD[c.food].n) === 0), "每列的盘都带自己的归属标签（如「煎蛋盘」）",
      cols.slice(3, 6).map(c => c.plateName).join(" / "));
    A(bucketBoxAll9(), "底部食材桶与上方锅与盘数量一致（各 9 个）");
  }
  function bucketBoxAll9() {
    let n = 0;
    for (let i = 0; i < 9; i++) { const b = B.bucketBox(i); if (b && b.w > 0) n++; }
    return n === 9;
  }
  /* 单击食材（真实鼠标）→ 自动进它自己那一列的锅 */
  const BUCKET3 = center(B.bucketBox(3));      // 煎蛋桶（第 3 列）
  const POT0 = center(B.stationBox(0));        // 白粥锅（第 0 列）
  A(BUCKET3.y > VH * 0.8 && POT0.y > VH * 0.45, "食材桶在最底部、锅位在中部（布局纪律）",
    "桶 y=" + Math.round(BUCKET3.y) + " · 锅 y=" + Math.round(POT0.y));
  const stBefore = B.debug.stations().filter(s => s.food).map(s => s.food);
  cv.dispatch("mousedown", { clientX: BUCKET3.x, clientY: BUCKET3.y, preventDefault() {} });
  (listeners.window["mouseup"] || []).slice().forEach(f => f({ clientX: BUCKET3.x, clientY: BUCKET3.y, preventDefault() {} }));
  A(B.debug.stations()[3].food === "egg", "真实鼠标单击食材桶 → 食物自动进入它正上方那一列的锅（第 3 列煎蛋盘）",
    JSON.stringify(B.debug.stations().filter(s => s.food).map(s => s.food)));
  A(B.debug.stations().filter(s => s.food).length === stBefore.length + 1, "只下了一份");
  A(B.debug.stations()[3].state === "raw" || B.debug.stations()[3].phase === "raw" || B.debug.stations()[3].phase === "cooking",
    "对应那一列进入 cooking", B.debug.stations()[3].phase);
  /* 拖到别人的锅（煎蛋 → 白粥锅）会被拒（原因码 wrong-column） */
  const t3 = m.texts.length;
  cv.dispatch("mousedown", { clientX: BUCKET3.x, clientY: BUCKET3.y, preventDefault() {} });
  cv.dispatch("mousemove", { clientX: POT0.x, clientY: POT0.y, preventDefault() {} });
  (listeners.window["mouseup"] || []).slice().forEach(f => f({ clientX: POT0.x, clientY: POT0.y, preventDefault() {} }));
  A(B.debug.stations()[0].food === null, "拖到别人的锅（煎蛋 → 白粥锅）会被拒绝");
  A(m.texts.slice(t3).some(x => /别人的锅|只进自己那一列/.test(x)), "被拒时给了原因文案",
    (m.texts.slice(t3).filter(x => /别人的锅|只进自己那一列/.test(x))[0] || ""));
  /* 单击盘 → 自动送给正在需要这份、且耐心最少的顾客 */
  for (let i = 0; i < 300 && !B.debug.stations()[3].plate; i++) B.debug.tick(1 / 60);
  A(B.debug.stations()[3].plate === "egg", "熟了自动落到本列专属盘（第 3 列）", String(B.debug.stations()[3].plate));
  A(B.debug.stations()[3].food === null, "落盘后锅位立刻空出来");
  B.debug.pushCustomer(["egg"]);                       // 保证此刻真的有人要这份
  const PLATE3 = center(B.plateBox(3));
  /* 这一下只比较「点击本身造成的改变」：点在 handler 里同步完成，不推进时钟，
     所以分数变化只可能来自这次出餐（+14/10/6），不会被旁边顾客流失干扰。
     也不再拿 state().served 当判据 —— served 是「整单做齐的顾客数」，
     如果规则挑中的是位「两样菜只上了第一样」的顾客，served 不会 +1（旧断言因此偶发失败）。 */
  const scServe = B.debug.state().score;
  const eggDoneBefore = B.debug.orders().filter(c => c.done.indexOf("egg") >= 0).map(c => c.id);
  const expEgg = B.debug.pickFor("egg");               // 规则层：该送给「正需要这份 + 耐心最少」的那位
  cv.dispatch("mousedown", { clientX: PLATE3.x, clientY: PLATE3.y, preventDefault() {} });
  const ordersAfterClick = B.debug.orders();
  const gotEgg = ordersAfterClick.filter(c => c.done.indexOf("egg") >= 0 && eggDoneBefore.indexOf(c.id) < 0).map(c => c.id);
  const eggLeftFull = !ordersAfterClick.some(c => c.id === expEgg);   // 整单做齐 → 当场离场（served++）
  const serveGain = B.debug.state().score - scServe;
  A(expEgg >= 0 && serveGain > 0 && (gotEgg.indexOf(expEgg) >= 0 || eggLeftFull),
    "真实鼠标单击专属盘 → 自动送给需要这份的顾客（规则＝耐心最少的那位）",
    "期望 #" + expEgg + " · 拿到煎蛋 #" + gotEgg.join("/") + " · 整单离场=" + eggLeftFull + " · 分数 " + scServe + " → " + B.debug.state().score);
  pump(1, 420);                                        // 让双击窗口过去（下一次点击算单击）
  A(B.debug.stations()[3].plate === null, "送出后盘清空、这一列恢复可用");
  /* ── bf-13 盘上永久保鲜：放再久也不糊 / 不降档 / 不消失（用户要求「备用餐盘不要有倒计时」）──
     旧断言是「盘上停留超过过火计时 → 变糊」，现在改成「放 90 秒仍是热乎档、仍是完美份」；
     而「糊盘」这条交互 / 渲染路径改走它**唯一**的真实来源：锅里烧糊了再端上盘。 */
  B.debug.drop("egg", null);
  for (let i = 0; i < 300 && !B.debug.stations()[3].plate; i++) B.debug.tick(1 / 60);
  A(B.debug.stations()[3].plate === "egg", "再做一份，等着它落盘");
  B.debug.setPlateAge(3, B.SERVE_WINDOW + 0.5);         // 拨到「旧过火计时」之后
  B.debug.tick(1 / 60);
  A(B.debug.plates().some(p => p.station === 3 && p.state === "perfect"),
    "盘上停留超过 4.5s **也不糊** → 永久保鲜（旧断言：变糊 / 要求 A5）", JSON.stringify(B.debug.plates()));
  B.debug.setPlateAge(3, 90);                           // 90 秒
  B.debug.tick(1 / 60);
  const p90 = B.debug.plates().filter(p => p.station === 3)[0];
  A(!!p90 && p90.tier === "hot" && p90.age === 90, "盘上放 90 秒仍是「热乎」最高档（14 分档）",
    p90 ? ("tier=" + p90.tier + " age=" + p90.age + "s") : "盘不见了");
  A(!!p90 && !isFinite(p90.left), "盘上没有倒计时（left = Infinity 哨兵）", p90 && ("left=" + p90.left));
  A(B.debug.state().expire === 0, "「忘取」账是 0（盘上不存在忘取报废）");
  /* 糊盘只能这样造：锅里按住看火烧糊 → 端上盘（盘上自己永远不会变糊） */
  B.debug.trash(3);
  A(B.debug.place("egg", null) === true, "按住看火下一份煎蛋（manual：不自动落盘）");
  for (let i = 0; i < 400 && B.debug.stations()[3].state !== "burnt"; i++) B.debug.tick(1 / 60);
  A(B.debug.stations()[3].state === "burnt", "锅内照样会糊（锅内路径不受影响）");
  A(B.debug.burnPlate(3) === true, "锅里糊了再端上盘 → 造出「糊盘」（盘上唯一的糊盘来源）");
  pump(1, 420);
  cv.dispatch("mousedown", { clientX: PLATE3.x, clientY: PLATE3.y, preventDefault() {} });
  pump(1, 420);
  A(B.debug.stations()[3].plate === "egg", "糊的那份单击被拒：还留在盘上（提示「糊了，只能丢掉」）",
    (m.texts.slice(-40).filter(x => /糊/.test(x))[0] || ""));

  /* 分数快照放在「两次点击之间」：这一段等待会推进时钟（顾客耐心在走、可能有顾客流失 −8），
     从更早的地方取快照会把「别人耐心归零」记到双击头上。点击本身不推进时钟 → 只比较点击前后的差。 */
  const scoreBefore = B.debug.state().score;
  cv.dispatch("mousedown", { clientX: PLATE3.x, clientY: PLATE3.y, preventDefault() {} });
  cv.dispatch("mousedown", { clientX: PLATE3.x, clientY: PLATE3.y, preventDefault() {} });   // 双击（同一帧内 350ms 内）
  A(B.debug.stations()[3].plate === null, "真实鼠标双击专属盘 → 清空这一列（锅 + 盘）");
  A(B.debug.state().score === scoreBefore, "双击丢弃不扣分",
    "scoreBefore=" + scoreBefore + " after=" + B.debug.state().score);
  A(B.debug.state().tossed >= 1, "记了一次丢弃（结算面板用）");
  /* 单击食材 → 这一列立刻能再开工（锅与盘都空了） */
  cv.dispatch("mousedown", { clientX: BUCKET3.x, clientY: BUCKET3.y, preventDefault() {} });
  A(B.debug.stations()[3].food === "egg", "丢掉后同一列马上能再下一份");

  /* ⑥ dispose 清空宿主 */
  B.dispose();
  A(B.isBusy() === false, "dispose() 后 isBusy() === false");
  A(host.children.length === 0, "dispose() 清空了宿主节点");
  A(B.start(host, { target: { id: "su", name: "x", bond: 20 } }) === true, "dispose 后可以再开一局");
  B.dispose();

  /* ⑥.5 新操作模型：9 列各 1 专属盘 + 自动落盘 + 单击盘出餐 + 盘上永久保鲜（bf-13 无倒计时）*/
  const d4b = boot();
  d4b.B.start(d4b.host, { target: { id: "lin", name: "林溪", bond: 44 }, duration: 999, goal: 99, onFinish: () => {} });
  const d4 = d4b.B.debug;
  A(d4.state().autoPlate === true, "页面开局默认打开「熟了自动落到本列专属盘」");
  A(d4.state().platesTotal === 9 && d4.state().columns === 9, "9 列 × 每列 1 个专属盘（不再限量 3 盘）");
  A(!isFinite(d4.state().plateLife) && d4.state().plateKeep === true && d4.state().serveWindow === 4.5,
    "盘上永久保鲜：plateLife = Infinity（无倒计时）/ plateKeep = true；锅内窗口常量仍是 4.5（兼容层）",
    "plateLife=" + d4.state().plateLife + " plateKeep=" + d4.state().plateKeep);
  const pm = d4.prepMap();
  A(pm.prep.length === 9 && pm.serve.length === 0, "9 列都有盘，没有「无盘现做灶位」", JSON.stringify(pm.prep));
  const map0 = d4.plateMap();
  A(map0.length === 9, "9 个灶位都在 plateMap 里");
  A(map0.every((x, i) => x.hasPlate === true && x.colFood === d4b.B.FOOD_IDS[i]), "每列的灶位 ↔ 食材 ↔ 盘一一对应，不可互换",
    JSON.stringify(map0.map(x => x.station + ":" + x.colFood)));
  A(map0.every(x => x.plateStation === -1 || x.plateStation === x.station), "不存在两个灶位共用一盘");
  /* 单击食材 → 只进它自己那一列 */
  A(d4.drop("congee", null) === true, "点白粥 → 进第 0 列（白粥锅）");
  A(d4.stations()[0].food === "congee", "就在它那一列");
  A(d4.placeEx("congee", 4).why === "wrong-column", "拖到培根盘 → wrong-column");
  /* 熟了自动落到本列专属盘 */
  for (let i = 0; i < 320 && !d4.stations()[0].plate; i++) d4.tick(1 / 60);
  A(d4.stations()[0].plate === "congee", "熟了自动落到第 0 列的专属盘（不用手动出锅）", JSON.stringify(d4.plates()));
  A(d4.stations()[0].phase === "plated", "状态机走到 plated（cooking → plated）", d4.stations()[0].phase);
  A(d4.stations()[0].food === null, "落盘后锅位立刻空出来");
  const p0 = d4.plates()[0];
  A(p0.tier === "hot" && p0.hot === true, "刚落盘 = 热乎（14 分档）", p0.tier);
  A(p0.station === 0, "这盘记录着自己的归属灶位", "station=" + p0.station);
  A(!isFinite(p0.left), "盘上**没有倒计时**（left = Infinity 哨兵；旧断言：≈4.5s 在走）", "left=" + p0.left);
  d4b.pump(2);                                   // 泵两帧让渲染层把本帧的绘制统计刷新出来
  const V4 = d4.view();
  A(V4.drawn.plates === 9 && V4.drawn.pans === 9, "本帧画出 9 个锅位 + 9 个专属盘",
    V4.drawn.plates + " 盘 / " + V4.drawn.pans + " 锅");
  A(V4.plateCount === 1 && V4.drawn.foods >= 1, "落盘的那份真的在盘上（plateCount=1）", "plateCount=" + V4.plateCount);
  /* 盘占用 / 锅忙 → 明确原因码 */
  const rej = d4.placeEx("congee", null);
  A(rej.ok === false && rej.why === "plate-occupied", "盘里有东西时拒绝下料（原因码 plate-occupied）", rej.why);
  A(/盘里还有一份/.test(rej.hint || ""), "提示语：盘里还有一份，先送出去", rej.hint);
  /* bf-13 盘上永久保鲜：旧断言是「停 1.7s → 温 / 停 3.2s → 凉」，现在改成
     「停 1.7s / 3.2s / 90s 都还是 hot」—— 档位不再随盘龄变化（这是本轮口径变化的核心）。 */
  d4.setPlateAge(0, B.HEAT.hotSec + 0.2);
  d4.tick(1 / 60);
  A(d4.plates()[0].tier === "hot", "盘上停 1.7s → 仍是 hot（旧断言：温 10 分档）", d4.plates()[0].tier + " age=" + d4.plates()[0].age);
  d4.setPlateAge(0, B.HEAT.warmSec + 0.2);
  d4.tick(1 / 60);
  A(d4.plates()[0].tier === "hot", "盘上停 3.2s → 仍是 hot（旧断言：凉 6 分档）", d4.plates()[0].tier + " age=" + d4.plates()[0].age);
  d4.setPlateAge(0, 90);
  d4.tick(1 / 60);
  A(d4.plates()[0].tier === "hot" && d4.plates()[0].state === "perfect", "盘上停 90s → 仍是 hot / perfect（永久保鲜）",
    d4.plates()[0].tier + " age=" + d4.plates()[0].age);
  /* 单击盘 → 自动送给正在需要 + 耐心最少的顾客 */
  d4.pushCustomer(["congee"]);
  const cands = d4.orders().filter(function(c){ return c.order.indexOf("congee") >= 0 && c.done.indexOf("congee") < 0; });
    var expId = null, bestPat = Infinity;
    cands.forEach(function(c){ var p = Number(c.patience); if (isFinite(p) && p < bestPat - 1e-9) { bestPat = p; expId = c.id; } });
    /* orders() 里的 patience 只留两位小数：两位候选可能「并列最少」→ 允许落在并列集合里，
       并在失败信息里把候选与各自 patience 都打出来（便于诊断是不是规则/取值口径不一致）。 */
    const bestCands = cands.filter(function(c){ return Math.abs(Number(c.patience) - bestPat) < 1e-9; }).map(function(c){ return c.id; });
    const who = d4.pickFor("congee");
  A(expId !== null && bestCands.indexOf(who) >= 0, "单击盘自动挑「正需要这份」且耐心最少的顾客（平手取先来的）",
    "挑中 #" + who + " · 耐心最少候选 #" + bestCands.join("/") + " · 全部候选 " +
    cands.map(function(c){ return "#" + c.id + "(耐心 " + c.patience + " · 单 " + c.order.join("+") + ")"; }).join(" "));
  const srv = d4.serveCol(0);
  A(srv.ok === true && srv.heat === "hot" && srv.delta === 14, "放了 90s 的那份照样吃最高档（热乎 +14；旧断言：凉 +6）",
    JSON.stringify({ heat: srv.heat, delta: srv.delta }));
  A(d4.stations()[0].plate === null && d4.plates().length === 0, "盘被取走 → 归属灶位立即可用");
  A(d4.placeEx("congee", null).ok === true, "灶位恢复可用：马上又能下一份");
  /* 没人要这份 → 不消耗、留在盘上（先挑一个「此刻场上没人还缺」的食材，避免随机点单干扰） */
  d4.trash(0);
  {
    const B9 = d4b.B;
    const wanted = {};
    d4.orders().forEach(c => c.order.forEach(f => { if (c.done.indexOf(f) < 0) wanted[f] = 1; }));
    let nowant = null;
    for (const f of B9.FOOD_IDS) {
      const col = B9.columnOf(f);
      if (wanted[f]) continue;
      if (d4.stations()[col].plate || d4.stations()[col].food) continue;
      d4.drop(f, null);
      for (let i = 0; i < 340 && !d4.stations()[col].plate; i++) d4.tick(1 / 60);
      if (d4.stations()[col].plate !== f) continue;
      const r = d4.serveCol(col);
      if (!r.ok && r.why === "no-want") { nowant = { r: r, col: col, f: f }; break; }
      /* 这一份刚好有人要 → 正常送掉了，换下一样接着验 */
    }
    A(!!nowant, "此刻没人要这份 → 拒绝出餐（原因码 no-want）",
      nowant ? (B9.FOOD[nowant.f].n + " @ 第 " + nowant.col + " 列：" + nowant.r.hint) : "候选食材都被人要走了");
    if (nowant) {
      A(d4.stations()[nowant.col].plate === nowant.f, "这份留在盘上永久保鲜（不消耗）");
      d4.setPlateAge(nowant.col, B.SERVE_WINDOW - 0.1);
      d4.tick(1 / 60);
      A(d4.plates().some(p => p.station === nowant.col && p.state === "perfect"), "旧窗口前 0.1s：还是好的（未糊）");
      d4.setPlateAge(nowant.col, B.SERVE_WINDOW + 0.05);
      d4.tick(1 / 60);
      A(d4.plates().some(p => p.station === nowant.col && p.state === "perfect"), "盘上停留超过 4.5s **也不糊**（旧断言：变糊）");
      A(d4.plates().some(p => p.station === nowant.col && p.tier === "hot"), "档位也没掉（仍是热乎）");
      A(d4.state().expire === 0, "「忘取」账仍是 0（旧断言：记了一次忘取）");
      d4.setPlateAge(nowant.col, 60);
      d4.tick(1 / 60);
      A(d4.plates().some(p => p.station === nowant.col && p.state === "perfect"), "放到 60s 还是完美档、还在盘上");
      const rNo = d4.serveCol(nowant.col);
      A(rNo.ok === false && rNo.why === "no-want", "仍然只是「没人要」，不是 burnt（旧断言：原因码 burnt）", rNo.why);
      const sc5 = d4.state().score;
      A(d4.trashCol(nowant.col) === true, "双击（trashCol）照样丢得掉 —— 丢弃仍需玩家操作");
      A(d4.state().score === sc5, "丢垃圾桶不扣分");
      A(d4.stations()[nowant.col].plate === null && d4.placeEx(nowant.f, null).ok === true, "丢完这一列立刻能再用");
    }
  }
  d4.close();

  /* ⑥.6 bf-13 盘上永久保鲜的边界：旧窗口前后都不糊、放 90 秒仍是热乎档、盘上那份不会消失；
         锅内路径不受影响（锅里该糊还是糊），糊盘只来自「锅里糊了再端上盘」。 */
  const d5b = boot();
  d5b.B.start(d5b.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 999, goal: 99, onFinish: () => {} });
  const d5 = d5b.B.debug;
  A(d5.drop("egg", null) === true, "煎蛋下到第 3 列");
  for (let i = 0; i < 300 && !d5.stations()[3].plate; i++) d5.tick(1 / 60);
  A(d5.stations()[3].plate === "egg", "熟了自动落到第 3 列的专属盘");
  d5.setPlateAge(3, B.SERVE_WINDOW - 0.1);
  d5.tick(1 / 60);
  A(d5.stations()[3].plateState === "perfect", "旧窗口前 0.1s：还是好的（未糊）", d5.stations()[3].plateState);
  A(d5.stations()[3].tier === "hot", "此时仍是「热乎」档（旧断言：只剩「凉」档）", d5.stations()[3].tier);
  A(d5.state().burnt === 0, "还没糊");
  d5.setPlateAge(3, B.SERVE_WINDOW + 0.01);
  d5.tick(1 / 60);
  A(d5.stations()[3].plateState === "perfect", "旧窗口后 0.01s：**还是好的**（旧断言：已经糊）", d5.stations()[3].plateState);
  A(d5.stations()[3].tier === "hot", "档位也没掉");
  A(d5.state().burnt === 0 && d5.state().expire === 0, "糊 / 忘取一次都没记（旧断言：各记一次）");
  A(d5.state().score === 0, "不扣分");
  d5.setPlateAge(3, 90);
  d5.tick(1 / 60);
  A(d5.stations()[3].plateState === "perfect" && d5.stations()[3].tier === "hot", "放 90 秒仍是 perfect / hot");
  A(d5.state().plateCount === 1, "那份一直留在盘上（没有消失、没有被自动清掉）");
  A(d5.placeEx("egg", null).why === "plate-occupied", "盘占着这一列 → 下料被拒（但这是占位，不是报废）");
  A(d5.trashCol(3) === true && d5.placeEx("egg", null).ok === true, "双击丢掉后才能再用");
  /* 糊盘唯一来源：锅里烧糊 → 端上盘；糊菜端给顾客 → 顾客当场离开（现有规则不变） */
  A(d5.place("congee", null) === true, "第 0 列按住看火下一份白粥（manual：不自动落盘）");
  for (let i = 0; i < 600 && d5.stations()[0].state !== "burnt"; i++) d5.tick(1 / 60);
  A(d5.stations()[0].state === "burnt", "锅内照样会糊（白粥糊点 5.6s）");
  A(d5.burnPlate(0) === true, "锅里糊了再端上盘 → 糊盘（盘上唯一的糊盘来源）");
  A(d5.plates().some(p => p.state === "burnt"), "盘上那份确实是 burnt");
  const sB = d5.state().served, aB = d5.state().angry;
  d5.pushCustomer(["congee"]);
  const rb = d5.serveId(d5.orders()[d5.orders().length - 1].id, -1);
  A(rb.kind === "burnt" && rb.delta === -5, "糊菜端上桌 → 顾客当场离开（−5，现有规则不变）",
    JSON.stringify({ kind: rb.kind, delta: rb.delta }));
  A(d5.state().served === sB && d5.state().angry === aB + 1, "糊菜不算服务成功，只记一次跑单");
  A(d5.stations()[0].plate === null, "糊盘被端走后这一列清空");
  A(d5.placeEx("egge", null).why === "no-food", "不存在的食材 → 原因码 no-food");
  d5.close();


  /* ⑥.7 列对齐 / 列头小字 / 三条操作提示的渲染证据 */
  const d6b = boot();
  d6b.B.start(d6b.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 999, goal: 99, onFinish: () => {} });
  const d6 = d6b.B.debug;
  d6b.canvas()._m.texts.length = 0;
  d6b.pump(1);
  const t6 = d6b.canvas()._m.texts;
  A(t6.some(x => /白粥 · 汤锅 · 3\.4s/.test(x)), "列头小字：食材 · 厨具 · 时长（新表：白粥 3.4s）", (t6.filter(x => /汤锅/.test(x))[0] || ""));
  A(t6.filter(x => / · (汤锅|煎盘|蒸格|沙拉台|果汁机) · /.test(x)).length >= 9, "9 列每列都有列头小字",
    "×" + t6.filter(x => / · (汤锅|煎盘|蒸格|沙拉台|果汁机) · /.test(x)).length);
  A(t6.some(x => /鸡蛋|煎蛋盘 · 空/.test(x)) || t6.filter(x => /· 空/.test(x)).length >= 9, "空盘画出列归属标签（「煎蛋盘 · 空」）",
    (t6.filter(x => /· 空/.test(x))[0] || ""));
  A(t6.filter(x => /· 空/.test(x)).length >= 9, "9 个空盘都有归属标签", "×" + t6.filter(x => /· 空/.test(x)).length);
  A(t6.some(x => /点食材/.test(x)) && t6.some(x => /双击盘/.test(x)) && t6.some(x => /送给正在等的顾客/.test(x)),
    "操作图例写清三条：点食材 → 自动下锅 ｜ 点盘 → 送给顾客 ｜ 双击盘 → 丢垃圾桶");
  A(t6.some(x => /点我下锅/.test(x)), "底排食材桶写着「点我下锅」", "×" + t6.filter(x => x === "点我下锅").length);
  A(t6.some(x => /9 列 × 每列 1 锅 1 专属盘/.test(x)), "盘区标题写明「9 列 × 每列 1 锅 1 专属盘」");
  A(t6.some(x => /备菜盘/.test(x)) === false, "旧文案「备菜盘 ×3」已经不在");
  A(t6.some(x => /现做现送/.test(x)) === false, "旧文案「现做现送」已经不在");
  /* 盘上有食物：画出档位 + **静态**的「∞ 可一直放着」（bf-13：盘上没有倒计时）。
     旧断言是「档位 + N.Ns 内送出」；现在反过来要求**不能**再出现任何「N.Ns 内送出」文案。 */
  d6.drop("egg", null);
  for (let i = 0; i < 300 && !d6.stations()[3].plate; i++) d6.tick(1 / 60);
  d6b.canvas()._m.texts.length = 0;
  d6b.pump(1);
  const t6b = d6b.canvas()._m.texts;
  A(t6b.some(x => /煎蛋·热乎/.test(x)), "盘上有食物时画出食材 + 档位（煎蛋·热乎）",
    (t6b.filter(x => /·热乎/.test(x))[0] || ""));
  A(t6b.some(x => /可一直放着/.test(x)), "盘下画的是静态提示「∞ 可一直放着」，取代倒计时",
    (t6b.filter(x => /可一直放着/.test(x))[0] || ""));
  A(!t6b.some(x => /内送出/.test(x)), "盘上**一个倒计时都没有**（旧断言要求画出「N.Ns 内送出」，现在要求它不存在）",
    (t6b.filter(x => /内送出/.test(x))[0] || "没有任何「内送出」文案"));
  /* 放 90 秒：还是那句静态提示 + 热乎档，也不会被画成糊盘 */
  d6.setPlateAge(3, 90);
  d6.tick(1 / 60);
  d6b.canvas()._m.texts.length = 0;
  d6b.pump(1);
  const t6b2 = d6b.canvas()._m.texts;
  A(t6b2.some(x => /煎蛋·热乎/.test(x)) && t6b2.some(x => /可一直放着/.test(x)),
    "放 90 秒后还是「煎蛋·热乎」+「∞ 可一直放着」（档位与文案都不变）");
  A(!t6b2.some(x => /糊了/.test(x)) && !t6b2.some(x => /只能丢/.test(x)),
    "放 90 秒也不会画出「糊了 · 只能丢」（旧断言：超时 4.5s 就画糊了）");
  /* 糊盘的渲染仍然要验 —— 唯一来源是「锅里烧糊了再端上盘」 */
  d6.trash(3);
  A(d6.place("egg", null) === true, "按住看火下一份煎蛋（manual）");
  for (let i = 0; i < 400 && d6.stations()[3].state !== "burnt"; i++) d6.tick(1 / 60);
  A(d6.burnPlate(3) === true, "锅里糊了端上盘 → 造一份糊盘（渲染回归用）");
  d6b.canvas()._m.texts.length = 0;
  const strokes6 = Object.assign({}, d6b.canvas()._m.strokes);
  const imgN6 = d6b.record.drawImage.length;
  d6b.pump(1);
  const t6c = d6b.canvas()._m.texts;
  A(t6c.some(x => /糊了/.test(x)) && t6c.some(x => /只能丢/.test(x)), "糊了的盘画出「糊了 · 只能丢（双击）」",
    (t6c.filter(x => /只能丢/.test(x))[0] || ""));

  /* 红叉现在是 ui/cross.png 贴图（缺图才回退红色矢量叉）→ 两条路任一成立即可，
     并在 extra 里把「贴图几次 / 矢量描边涨了多少」都打出来，便于一眼看出走的哪条。 */
  const cross6 = d6b.record.drawImage.slice(imgN6).filter(x => /art\/icons\/ui\/cross\.png$/.test(x.src));
  A(cross6.length > 0 || (d6b.canvas()._m.strokes["#ff4d6d"] || 0) > (strokes6["#ff4d6d"] || 0),
    "糊了画出红色警告（红叉贴图；缺图时回退红色矢量叉）",
    "cross.png ×" + cross6.length + " · #ff4d6d " + (strokes6["#ff4d6d"] || 0) + " → " + (d6b.canvas()._m.strokes["#ff4d6d"] || 0));
  d6.close();

  /* ⑦ 通过路径 */
  const d2b = boot();
  let winRes = null, winN = 0;
  d2b.B.start(d2b.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 75, goal: 8, onFinish: r => { winN++; winRes = r; } });
  const d2 = d2b.B.debug;
  let guard = 0;
  while (!d2.state().over && guard++ < 4000) {
    const os = d2.orders();
    for (const c of os) for (const f of c.order) {
      if (c.done.indexOf(f) >= 0) continue;
      if (d2.stations().some(s => s.food === f)) continue;
      if (d2.plates().some(p => p.food === f && p.state !== "burnt")) continue;   // 这一列盘上已有
      d2.drop(f, null);                                                            // 食材只进它自己那一列（自动落盘）
    }
    for (let n = 0; n < 60 && !d2.state().over; n++) { d2.tick(1 / 60); if (d2.plates().some(p => p.state === "perfect")) break; }
    if (d2.state().over) break;
    /* 单击每一列的专属盘 → 自动送给「正在需要 + 耐心最少」的顾客（新玩法的连做节奏） */
    d2.stations().forEach((s, i) => { if (s.plate && s.plateState !== "burnt") d2.serveCol(i); });
    /* 糊的 / 没人要的存货清掉，别堵着某一列 */
    d2.stations().forEach((s, i) => {
      if (s.state === "burnt" || s.plateState === "burnt") { d2.trash(i); return; }
      if (s.plate) { const r = d2.serveCol(i); if (!r.ok && r.why === "no-want") d2.trash(i); }
    });
    d2.tick(0.15);
  }
  const win = d2.state();
  A(win.over === true, "通过路径：debug 驱动跑完整局");
  A(win.win === true, "拿到 win:true", "served " + win.served + "/" + win.goal);
  A(win.served >= 8, "服务满 8 位顾客", win.served + " 位");
  A(!!win.result && win.result.bondDelta > 0, "结算：好感上升", win.result && ("+" + win.result.bondDelta));
  A(!!win.result.quote && win.result.quote.length > 4, "通过有专属台词", win.result && win.result.quote);
  A(/苏晚晴/.test((win.result && win.result.impact) || ""), "本局影响一句话带对方名字");
  A(!!d2b.host.querySelector(".bf-result"), "结算面板 DOM 已渲染");
  pumpSettle(d2b);                               // 泵几帧让画布循环走到 showResult()，面板才有内容
  const panelEl = d2b.host.querySelector(".bf-result");
  const panelTxt = String(panelEl ? (panelEl._html || panelEl.innerHTML) : "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  A(/服务顾客/.test(panelTxt) && /完美份数/.test(panelTxt) && /烧糊份数/.test(panelTxt) && /用时/.test(panelTxt) && /好感/.test(panelTxt),
    "结算面板含 服务顾客/目标 · 完美份数 · 烧糊份数 · 用时 · 好感变化",
    panelTxt.slice(6, 90));
  /* ── 出口按钮 #bfGo：通过路径点它 → 面板关闭 + onFinish 收到 win:true **一次** ── */
  const goWin = d2b.host.querySelector("#bfGo");
  A(!!goWin, "通过路径的结算面板里有出口按钮 #bfGo（真 DOM 节点）");
  A(!!goWin && /收下早餐\s*·\s*继续/.test(goWin.textContent), "通过时按钮文案「收下早餐 · 继续」", goWin && goWin.textContent);
  A(!!goWin && goWin.getAttribute("data-act") === "close", "保留 data-act=close（兼容旧验收脚本选择器）");
  A(winN === 0, "结算面板出来时 onFinish 还没被调用（等玩家点出口）");
  if (goWin) { goWin.click(); goWin.click(); goWin.click(); }        // 连点 3 次
  A(winN === 1, "点 #bfGo → onFinish 恰好一次（连点 3 次仍为 " + winN + "）");
  A(d2b.B.isBusy() === false, "点 #bfGo 后模块已 dispose");
  A(d2b.host.children.length === 0, "点 #bfGo 后 #bfGameHost 已清空（覆盖层不留死界面）");
  A(d2b.docKeys() === 0, "点 #bfGo 后 document 上不留 keydown 监听");
  const life2 = d2b.B.debug.lifecycle();
  A(life2.rafCancelled >= 1 && life2.escBound === life2.escRemoved && life2.escActive === false,
    "dispose() 清理干净：rAF 已取消 / ESC 监听挂摘配平（挂 " + life2.escBound + " 摘 " + life2.escRemoved + "）");
  A(!!winRes && winRes.win === true, "onFinish 回调收到同一份 result", winRes && winRes.quote);

  /* ⑧ 失败路径 */
  const d3b = boot();
  let loseRes = null, loseN = 0;
  d3b.B.start(d3b.host, { target: { id: "guo", name: "陈果", bond: 30 }, duration: 20, goal: 8, onFinish: r => { loseN++; loseRes = r; } });
  const d3 = d3b.B.debug;
  guard = 0;
  while (!d3.state().over && guard++ < 20000) d3.tick(0.2);
  const lose = d3.state();
  A(lose.over === true, "失败路径：已结算");
  A(lose.win === false, "拿到 win:false", lose.reason);
  A(!!lose.result && lose.result.bondDelta < 0 && lose.result.bondDelta >= -6, "失败 → 好感 −3~−6", lose.result && ("" + lose.result.bondDelta));
  A(!!lose.result && !!lose.result.quote && lose.result.quote.length > 4, "失败有专属尴尬台词", lose.result && lose.result.quote);
  pumpSettle(d3b);
  const failTxt = String(d3b.host.querySelector(".bf-result").innerHTML).replace(/<[^>]+>/g, " ");
  A(/好感/.test(failTxt), "失败结算面板也显示好感变化");
  A(/明天再来|台阶/.test(failTxt), "失败面板给了「下次再来」的台阶（不虐主）");
  const goFail = d3b.host.querySelector("#bfGo");
  A(!!goFail && /算了，明天再来\s*·\s*继续/.test(goFail.textContent), "失败时按钮文案「算了，明天再来 · 继续」", goFail && goFail.textContent);
  if (goFail) { goFail.click(); goFail.click(); goFail.click(); }
  A(loseN === 1, "失败路径点 #bfGo → onFinish 恰好一次（连点 3 次仍为 " + loseN + "）");
  A(d3b.B.isBusy() === false, "失败路径点 #bfGo 后模块已 dispose");
  A(!!loseRes && loseRes.win === false, "失败路径 onFinish 也收到 result");

  /* ⑧b ESC = 点 #bfGo（第三个无头局：不点鼠标，只按 ESC） */
  const d7b = boot();
  let escRes = null, escN = 0;
  d7b.B.start(d7b.host, { target: { id: "guo", name: "陈果", bond: 30 }, duration: 20, goal: 8, onFinish: r => { escN++; escRes = r; } });
  const d7 = d7b.B.debug;
  let g7 = 0;
  while (!d7.state().over && g7++ < 20000) d7.tick(0.2);
  pumpSettle(d7b);
  A(d7b.docKeys() === 1, "开局时 document 上恰好挂了 1 个 keydown（ESC 出口）");
  d7b.esc();
  A(escN === 1 && !!escRes && escRes.win === false, "ESC = 点 #bfGo：退出但不丢结算结果（onFinish 一次）");
  d7b.esc(); d7b.esc();
  A(escN === 1, "ESC 连按仍是 1 次（幂等 + 监听已摘）");
  A(d7b.B.isBusy() === false && d7b.docKeys() === 0, "ESC 之后已收摊且不留监听");

  /* ⑨ 贴图规格（已从「零外部图片」改为「只加载 art/icons/ 下的本地图片 + 必须有矢量回退」）
        ——原来的两条断言与现在的需求冲突，这里改成更准确的新断言，没有删掉不管：
        原：源码不含 drawImage（不引用外部图片）
        新：drawImage 只允许配 art/icons/ 下的本地 PNG，且必须保留矢量回退
        原因：用户用 Lovart 生成了九宫格食材素材，要把程序化矢量图标换成真实贴图；
              但必须保留「缺素材 / 无头环境 → 矢量」的兜底，离线仍然可玩。 */
  {
    const ios = B.debug.icons();
    A(ios.length === 9 && ios.every(x => x.id), "debug.icons() 列出 9 样食材的贴图状态", ios.map(x => x.id).join("/"));
    A(ios.every(x => /(^|\/)art\/icons\/[a-z]+\.png$/.test(x.src) || x.src === ""),
      "贴图 src 一律落在本地 art/icons/<foodId>.png（无 http/data 外链）",
      ios.map(x => x.src.split("/").slice(-2).join("/")).join(" "));
    A(ios.every(x => !/^https?:|^data:/i.test(x.src)), "没有任何 http(s):// 或 data: 外链图片");
    A(!/url\(/.test(SRC), "源码不使用 url() 贴图");
    /* 矢量回退必须还在源码里：drawFood → drawFoodImg 失败 → drawFoodVector */
    A(/function drawFoodVector\(/.test(SRC) && /function drawFoodImg\(/.test(SRC) &&
      /function drawFood\(g, id, s, cook\) \{\s*\n\s*if \(drawFoodImg\(g, id, s, cook\)\) return;\s*\n\s*drawFoodVector\(g, id, s, cook\);/.test(SRC),
      "drawFood = 贴图优先 → 矢量回退（两条路径都在源码里，回退没有被删）");
    A(!/^\s*(import|export)\s/m.test(SRC.replace(/\/\*[\s\S]*?\*\//g, "")), "不使用 ES module（自包含 IIFE）");
    A(/\(function \(root\)/.test(SRC) && /root\.Breakfast = api/.test(SRC), "IIFE + window.Breakfast 暴露方式与 mahjong.js 一致");
  }

  /* ⑨b 贴图路径：真的从 art/icons/ 读到 9 张 PNG（宽高由真文件 IHDR 给出） */
  {
    const b2 = boot();
    const ios2 = b2.B.debug.icons();                 // 预加载发生在模块初始化时，开局前就可读
    A(ios2.filter(x => x.loaded).length === 9, "9 张本地贴图全部解码完成（真读 art/icons/*.png 的 IHDR）",
      "loaded=" + ios2.filter(x => x.loaded).length + " / vector=" + ios2.filter(x => x.drawAs === "vector").length);
    A(ios2.every(x => x.naturalWidth === 256 && x.naturalHeight === 256),
      "9 张贴图都是 256×256（切片规格）", [...new Set(ios2.map(x => x.naturalWidth + "×" + x.naturalHeight))].join(" "));
    A(ios2.every(x => !/^https?:|^data:/i.test(x.src)) && ios2.every(x => /art\/icons\/[a-z]+\.png$/.test(x.src)),
      "src 全部是 art/icons/<foodId>.png 本地路径（无外链 / 无 data URI）");
    /* reloadIcons 只是「按当前开关重新预加载」，本身不该画任何图 */
    const rl = b2.reloadIcons({});
    A(rl.after - rl.before === 0, "重新预加载不会顺手画图（drawImage 次数不变）", "Δ=" + (rl.after - rl.before));
    /* 真开局：确认每样食物都走了 drawImage 而不是矢量 */
    let fin2 = null;
    b2.B.start(b2.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 20, goal: 8, onFinish: r => { fin2 = r; } });
    b2.pump(3);
    const st = b2.B.debug.view().icons;
    A(st.ready === 9 && st.failed === 0, "开局后 9 张贴图可用、0 张失败", "ready=" + st.ready + " failed=" + st.failed);
    A(st.span === 36 && st.spec === 76,
      "贴图沿用既有视觉尺寸（局部跨度 36px → bucket/card/plate/pan 四种缩放都不变）",
      "span=" + st.span + "px / 单份食物规格 " + st.spec + "px");
    const di = b2.record.drawImage;
    A(di.length > 0, "开局首帧真的调用了 ctx.drawImage（用的是贴图）", di.length + " 次");
    /* 贴图范围从「只允许 art/icons/<foodId>.png」扩到本批 4 组 + 背景，
       断言同步收紧成：只允许 art/ 下的本地 PNG（bg / icons / icons/<group>），
       且协议必须是本地（无 http(s) / data）。 */
    A(di.every(x => /(^|\/)art\/(bg\/kitchen2?\.png|icons\/([a-z]+\/)?[a-z_]+\.png)$/.test(x.src)),
      "每次 drawImage 的图都来自本地 art/（背景 v2 / 食材 / 厨具 / 盘面 / 头像 / UI）",
      [...new Set(di.map(x => x.src.split("/").slice(-2).join("/")))].slice(0, 8).join(" "));
    A(di.every(x => !/^https?:|^data:/i.test(x.src)), "drawImage 只画本地文件（没有 http(s) / data URI 外链）");
    A(di.every(x => (x.argc === 5 || x.argc === 9) && x.dw > 0 && x.dh > 0 && x.sw > 0 && x.sh > 0),
      "drawImage 用 5 参（图+目标框）或 9 参（源矩形+目标框），源/目标框都是正尺寸",
      di.length ? ("例如 argc=" + di[0].argc + " " + di[0].sw.toFixed(0) + "×" + di[0].sh.toFixed(0) + " → " + di[0].dw.toFixed(1) + "×" + di[0].dh.toFixed(1)) : "无");
    A(b2.B.debug.icons().every(x => x.drawAs === "image"), "9 样食物的绘制源都判定为 image");
    b2.B.dispose();
  }

  /* ⑨c 矢量回退：没有 Image 构造器 / 9 张全加载失败 → 一条 drawImage 都不发，游戏照样画得出来 */
  {
    const b3 = boot({ noImages: true });
    let fin3 = null;
    b3.B.start(b3.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 20, goal: 8, onFinish: r => { fin3 = r; } });
    A(b3.B.debug.view().icons.ready === 0 && b3.B.debug.view().icons.vector === 9,
      "无 Image 构造器时 9 张全部判定为「走矢量」", "ready=0 vector=9");
    b3.pump(3);
    const m3 = b3.canvas()._m;
    A(b3.record.drawImage.length === 0, "无 Image 时不发任何 drawImage");
    A(m3.log.ops > 800 && m3.log.fills > 80, "回退路径照旧画满整屏（矢量指令数）", m3.log.ops + " ops / " + m3.log.fills + " fills");
    A(m3.log.ellipses > 0 && Object.keys(m3.colors).length >= 10, "矢量回退用到了椭圆与多种颜色（真的画了食物）",
      m3.log.ellipses + " ellipses / " + Object.keys(m3.colors).length + " 色");
    A(b3.B.debug.icons().every(x => x.drawAs === "vector"), "9 样食物都判定为 vector");
    b3.B.dispose();

    /* 9 张全失败（有 Image 但读不到文件）→ 同样必须回退。
       这里用一个**不存在的基准目录**触发真实路径的加载失败（走 onerror），
       而不是只翻 forceFail 开关 —— 后者只标记槽位，不经过真实加载流程。 */
    const b4 = boot();
    const badBase = path.join(OUT, "art", "__no_such_dir__") + "/";
    const pr = b4.B.__bfPreloadIcons(badBase);
    A(pr.ready === 0 && pr.vector === 9 && pr.failed === 9,
      "9 张食材贴图全加载失败 → 全部回退矢量", "ready=" + pr.ready + " failed=" + pr.failed);
    A(b4.B.art.ready().gear === 0 && b4.B.art.ready().face === 0 && b4.B.art.ready().ui === 0 && b4.B.art.ready().bg === 0,
      "同一批坏目录下，厨具 / 头像 / UI / 背景也一起判为不可用（统一加载器，四条路一起回退）",
      JSON.stringify(b4.B.art.ready()));
    b4.B.start(b4.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 20, goal: 8, onFinish: () => {} });
    const st4 = b4.B.debug.view().icons;
    A(st4.ready === 0 && st4.vector === 9, "开局后仍然 9 张不可用（不做二次加载）", "ready=" + st4.ready);
    b4.pump(3);
    /* 素材总数随每一批新图同步增长：9 食材 + 12 厨具/盘位 + 15 头像（5 角色 × 平急喜）
       + 9 UI + 1 背景首选 = 46；再加背景兜底那张 kitchen.png = 47 个 src，
       坏目录下这 47 个 onerror 必须全被接住 —— 断言跟着数字改，而不是删掉这条。 */
    A(b4.record.drawImage.length === 0 && b4.record.imgErrors.length === 47,
      "加载失败时一条 drawImage 都不发，47 个 onerror 全被接住（含背景两张候选）",
      "errors=" + b4.record.imgErrors.length + " / drawImage=" + b4.record.drawImage.length);
    A(b4.canvas()._m.log.fills > 80, "加载失败也照旧画满整屏（矢量兜底生效）");
    b4.B.dispose();
  }

  /* ⑨d 本轮 5 组素材的接入证据：背景铺满 / 厨具与盘位贴图 / 头像按耐心切换 / UI 元素
         —— 全部由「真跑 breakfast.js → 记录 drawImage（源矩形 + 目标框）」证明，
            不是源码里出现了字符串就算数。 */
  {
    const b5 = boot();
    const A5 = b5.B.art;
    A(!!A5 && typeof A5.bg === "function" && typeof A5.groups === "function",
      "api.art 暴露贴图映射表与背景几何（单测与无头共用同一个出口）");
    const bg = A5.bg();
    const rpt = JSON.parse(fs.readFileSync(path.join(OUT, "art", "_assets_report.json"), "utf8"));
    /* 本批换成 v2（art/bg/kitchen2.png）：两级回退里的首选；v1 仍在册兜底。
       断言改成「与 art/_assets2_report.json 逐字一致」+ 「保整幅宽」两条。 */
    const rpt2 = JSON.parse(fs.readFileSync(path.join(OUT, "art", "_assets2_report.json"), "utf8"));
    const r2 = rpt2.backgrounds.filter(b => b.key === "kitchen2")[0];
    A(bg.ready === true && bg.loaded >= 1 && bg.failed === 0,
      "背景 art/bg/kitchen2.png 真解码完成（读的是真文件的 IHDR）",
      "spec " + bg.spec.w + "×" + bg.spec.h + " loaded=" + bg.loaded + " failed=" + bg.failed);
    A(bg.active === "kitchen2", "生效的是 v2 那一张（active=" + bg.active + "，v1 只作兜底）");
    A(JSON.stringify(bg.srcWindow) === JSON.stringify(r2.srcWindow),
      "breakfast.js 的源窗口与 art/_assets2_report.json 逐字一致（测量结果没被手改）", JSON.stringify(bg.srcWindow));
    A(bg.scale === r2.scale && bg.strategy === r2.strategy && bg.croppedPerSide === r2.croppedPerSide,
      "裁切策略与报告一致（scale=" + bg.scale + " / " + bg.strategy + " / 左右各裁 " + bg.croppedPerSide + "px）");
    A(bg.counterTopCanvasY === r2.counterTopCanvasY,
      "木台面上沿画布 y 与报告一致（" + bg.counterTopCanvasY + " = 源 " + bg.counterTopSrcY + " / 源高 " + bg.srcWindow.h + " × 画布 " + b5.B.VIEW.h + "）");
    A(bg.counterTopCanvasY > b5.B.LAY.plate.y && bg.counterTopCanvasY < b5.B.LAY.buckets.y,
      "盘带 / 锅带 / 桶带三段全部落在木台面上（台面上沿落在盘带之内）",
      "y=" + bg.counterTopCanvasY + " ∈ (" + b5.B.LAY.plate.y + ", " + b5.B.LAY.buckets.y + ") · 9 列元素位置一字未动");
    A(bg.croppedPerSide === 0 && bg.srcWindow.w >= 2048,
      "v2 保整幅宽：左右各裁 0px，完整樱花树冠 + 完整货架都在画面里（源窗口宽 " + bg.srcWindow.w + "）");
    A(bg.bottomFillPx > 0, "画布底部用木纹平铺补了 " + bg.bottomFillPx + "px（不是纯色渐变）");
    A(bg.fallback.join(">") === "kitchen2>kitchen>vector", "两级回退链写在 art.bg().fallback：" + bg.fallback.join(">"));
    A(b5.B.debug.bg().file === "art/bg/kitchen2.png" && !/^[A-Za-z]:|^https?:|^data:/i.test(A5.bg().file),
      "背景走相对路径 art/bg/kitchen2.png（不写盘符 / 协议 / data URI）");

    /* 真开局 → 背景在最底层被 drawImage，且目标框铺满整块画布 */
    b5.B.start(b5.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 20, goal: 8, onFinish: () => {} });
    b5.pump(2);
    const bgi = b5.record.drawImage.filter(x => /art\/bg\/kitchen2\.png$/.test(x.src));
    A(bgi.length > 0, "最底层真的 drawImage 铺了背景（不是只登记了个开关）", bgi.length + " 次");
    const g0 = bgi[0];
    A(!!g0 && g0.dx === 0 && g0.dy === 0 && g0.dw === VW && g0.dh === VH,
      "背景目标框 = 整块画布（0,0,1180,790）→ 铺满",
      g0 ? ("dx/dy/dw/dh = " + [g0.dx, g0.dy, g0.dw, g0.dh].join(",")) : "没有记录");
    const tex = b5.B.debug.tex();
    A(tex.bg === true && (tex.bgMode === "fit" || tex.bgMode === "cover"),
      "debug.tex() 报告本帧背景已绘制", "mode=" + tex.bgMode);
    A(tex.panTex >= 9, "9 个灶位都画了厨具贴图（汤锅/煎盘/蒸笼/托盘/果汁壶）", "panTex=" + tex.panTex);
    A(tex.plateTex >= 9, "9 个专属盘都画了盘位贴图", "plateTex=" + tex.plateTex);
    A(tex.gearTools >= 1, "图例条右端画了「锅铲+夹子」贴图", "gearTools=" + tex.gearTools);
    const names = b5.record.drawImage.map(x => x.src.split("/").pop());
    const cnt = n => names.filter(v => v === n).length;
    A(cnt("pot.png") >= 3 && cnt("griddle.png") >= 3 && cnt("steamer.png") >= 1 && cnt("tray.png") >= 1 && cnt("juice_jug.png") >= 1,
      "锅位贴图按 kind 映射正确（锅×3 / 煎盘×3 / 蒸笼×1 / 托盘×1 / 果汁壶×1）",
      "pot=" + cnt("pot.png") + " griddle=" + cnt("griddle.png") + " steamer=" + cnt("steamer.png") +
      " tray=" + cnt("tray.png") + " juice_jug=" + cnt("juice_jug.png"));
    A(cnt("plate_empty.png") >= 9, "9 个空盘都用了 plate_empty.png", "×" + cnt("plate_empty.png"));
    A(cnt("stars.png") >= 5 && cnt("coin.png") >= 1, "顶栏星级用 stars.png 的单颗星、得分用 coin.png",
      "stars×" + cnt("stars.png") + " coin×" + cnt("coin.png"));

    /* 盘上有食物 → 换「有食物盘」贴图（煎蛋培根盘 / 包子盘），且不再叠一份食材贴图。
       注意：无头 ctx 替身**不实现 translate/scale**（只记次数），所以 drawImage 记下来的
       坐标是**局部坐标**，不能用绝对位置判断「画在哪个盘位」。
       这里改成数「每帧某张贴图画了几次」—— 底排 9 个食材桶每帧各画一次，
       盘位上再叠一份，那个数字就会 +1，与坐标无关。 */
    const d5 = b5.B.debug;
    const cntName = (n) => b5.record.drawImage.filter(r => r.src.split("/").pop() === n).length;
    b5.record.drawImage.length = 0;
    b5.pump(1);
    const baseEgg = cntName("egg.png"), baseCongee = cntName("congee.png");
    A(baseEgg === 1 && baseCongee === 1, "9 个盘全空时，每样食材贴图每帧只画 1 次（底排食材桶）",
      "egg=" + baseEgg + " congee=" + baseCongee);
    /* ① 煎蛋 → 专属盘贴图 plate_egg（只装煎蛋），不再叠食材贴图。
       本轮修的缺陷：以前煎蛋与培根**共用** plate_egg_bacon.png → 盘上分不清食材。 */
    b5.record.drawImage.length = 0;
    d5.drop("egg", null); d5.plateNow(3);
    b5.pump(1);
    const n2 = b5.record.drawImage.map(x => x.src.split("/").pop());
    A(n2.indexOf("plate_egg.png") >= 0, "煎蛋落到盘上 → 用 plate_egg.png（只装煎蛋的盘）");
    A(n2.indexOf("plate_egg_bacon.png") < 0, "不再出现旧的共用盘 plate_egg_bacon.png（老缺陷已删）");
    A(n2.filter(v => v === "egg.png").length === baseEgg,
      "盘贴图自带食物时不再叠一份食材贴图（整帧 egg.png 次数不变，一盘两样会被这个数抓到）",
      "egg.png " + baseEgg + " → " + n2.filter(v => v === "egg.png").length);
    /* ①b 培根 → 另一张 plate_bacon（与煎蛋盘**不是同一张图**，这是本轮验收的核心）*/
    b5.record.drawImage.length = 0;
    d5.drop("bacon", null); d5.plateNow(4);
    b5.pump(1);
    const n2b = b5.record.drawImage.map(x => x.src.split("/").pop());
    A(n2b.indexOf("plate_bacon.png") >= 0, "培根落到盘上 → 用 plate_bacon.png（只装培根的盘）");
    A(n2b.filter(v => v === "plate_egg.png").length === 1 && n2b.filter(v => v === "plate_bacon.png").length === 1,
      "同一帧里煎蛋盘与培根盘同时存在、各画各的贴图（盘上分得清食材）",
      "plate_egg×" + n2b.filter(v => v === "plate_egg.png").length + " plate_bacon×" + n2b.filter(v => v === "plate_bacon.png").length);
    /* ② 包子 → 专属盘贴图 plate_bun（自带包子） */
    b5.record.drawImage.length = 0;
    d5.drop("bun", null); d5.plateNow(6);
    b5.pump(1);
    const n3 = b5.record.drawImage.map(x => x.src.split("/").pop());
    A(n3.indexOf("plate_bun.png") >= 0, "包子落到盘上 → 用 plate_bun.png（包子盘）");
    A(n3.filter(v => v === "bun.png").length === 1, "包子盘自带包子 → 不再叠一份 bun.png",
      "bun.png ×" + n3.filter(v => v === "bun.png").length);
    /* ③ 没有专属盘贴图的食材（白粥）→ 仍然是「空盘 + 食物贴图」 */
    b5.record.drawImage.length = 0;
    d5.drop("congee", null); d5.plateNow(0);
    b5.pump(1);
    const n4 = b5.record.drawImage.map(x => x.src.split("/").pop());
    A(n4.indexOf("plate_empty.png") >= 0 && n4.filter(v => v === "congee.png").length === baseCongee + 1,
      "白粥落盘 → 盘位是「plate_empty + 食物贴图」（没有专属盘贴图的食材照旧这样画）",
      "plate_empty=" + n4.filter(v => v === "plate_empty.png").length + " congee.png " + baseCongee + " → " + n4.filter(v => v === "congee.png").length);
    /* ④ 糊了 → 红叉贴图（bf-13：盘上不会自然变糊，糊盘只来自「锅里糊了再端上盘」）*/
    d5.trash(6);                                     // 先清掉刚才那份包子盘
    A(d5.burnPlate(6) === true, "锅里烧糊 → 端上盘，造一份糊盘（盘上唯一的糊盘来源）");
    b5.record.drawImage.length = 0;
    b5.pump(1);
    A(b5.record.drawImage.some(x => /art\/icons\/ui\/cross\.png$/.test(x.src)),
      "盘上那份糊了 → 画红叉贴图 ui/cross.png（矢量红叉只是缺图时的兜底）");
    b5.B.dispose();
  }


  /* ⑨e 顾客头像按耐心阈值切换 + UI 元素（耐心条按比例裁源矩形 / 星级 / 金币 / 绿勾） */
  {
    const b6 = boot();
    b6.B.start(b6.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 30, goal: 8, onFinish: () => {} });
    const d6 = b6.B.debug;
    /* 第 1 位故意点两样：整单完成的顾客会立刻离店（不再画卡），
       所以「订单项打勾」要在**还差一样**的状态下验。 */
    const pid = [d6.pushCustomer(["congee", "egg"]), d6.pushCustomer(["milk"]), d6.pushCustomer(["soup"])];
    const PAT = [0.82, 0.55, 0.22];
    pid.forEach((id, i) => d6.setPatience(id, PAT[i]));
    b6.record.drawImage.length = 0;
    b6.pump(1);
    const faces = d6.faces();
    A(faces.length === 3, "3 位顾客各有一个头像位", faces.length + " 位");
    A(faces[0].mood === "calm" && faces[1].mood === "calm" && faces[2].mood === "urgent",
      "耐心 82% / 55% / 22% → 平静 / 平静 / 着急（阈值 40%）",
      faces.map(f => f.ratio + "→" + f.mood).join(" · "));
    A(b6.B.art.faceUrgentAt === 0.4, "阈值写在常量里且读得到（FACE_ICON.urgentAt = 0.40）",
      "faceUrgentAt=" + b6.B.art.faceUrgentAt);
    const fdraw = b6.record.drawImage.filter(x => /art\/icons\/faces\//.test(x.src));
    const perCard = faces.map(f => {
      const hit = fdraw.filter(x => (x.dx + x.dw / 2) >= f.box.x && (x.dx + x.dw / 2) <= f.box.x + f.box.w);
      return hit.length ? hit[hit.length - 1].src.split("/").pop() : "";
    });
    A(perCard[0].indexOf("_calm") > 0 && perCard[1].indexOf("_calm") > 0 && perCard[2].indexOf("_urgent") > 0,
      "每张卡的头像位真的按耐心阈值切换贴图（calm / calm / urgent）", perCard.join(" ") || "没画头像");
    /* 同一位顾客改耐心 → 立刻换脸（证明是阈值在驱动，不是随机 / 一次性）*/
    const c0 = faces[0].id;
    d6.setPatience(c0, 0.2);
    b6.record.drawImage.length = 0; b6.pump(1);
    A(b6.record.drawImage.some(x => /_urgent\.png$/.test(x.src)), "耐心掉到 20% → 同一位顾客换成「着急」脸",
      b6.record.drawImage.filter(x => /faces\//.test(x.src)).map(x => x.src.split("/").pop()).join(" "));
    d6.setPatience(c0, 0.9);
    b6.record.drawImage.length = 0; b6.pump(1);
    A(b6.record.drawImage.some(x => /_calm\.png$/.test(x.src)), "耐心回到 90% → 又换回「平静」脸");
    A(d6.faces().length >= 1 && d6.faces().every(f => /^(stud|office|uncle|fang|lu)_(calm|urgent|happy)$/.test(f.name)),
      "头像文件名是 5 位角色 × 3 种情绪（映射表封闭）",
      [...new Set(d6.faces().map(f => f.name))].join(" / "));
    const pool6 = d6.faces()[0] ? d6.faces()[0].pool : [];
    A(pool6.length === 5 && new Set(pool6).size === 5, "本局角色池是 5 位的一个排列：" + pool6.join("/"));
    A(b6.B.art.facePoolSeed === 20240918 && JSON.stringify(b6.B.art.facePoolOf(20240918)) === JSON.stringify(pool6),
      "角色池由固定种子决定（seed=" + b6.B.art.facePoolSeed + " → " + pool6.join("/") + "，可复现）");
    /* ★ 第三态：该顾客订单全部拿到 → 立刻换「满意」脸。
       时序注意：真实玩法里「订单完成」会在**下一次 step()** 里把顾客置 left（立刻让出座位），
       而 render() 只画 activeCustomers（!left）→ 满意脸只存在于「完成的那一帧」。
       所以这里用一帧 1ms 的泵（1ms < 1/60s 的步长阈值）**只渲染、不推进 step**，
       才能稳定抓到那一帧 —— 本轮把断言收紧成「必须真的画出 *_happy.png」，
       不再允许用「顾客已离场」这条捷径蒙过去（三位角色的 happy 已切齐）。 */
    const fBefore = d6.faces();
    const cH = fBefore.length > 1 ? fBefore[1].id : (fBefore[0] ? fBefore[0].id : -1);
    const kindH = fBefore.length > 1 ? fBefore[1].kind : (fBefore[0] ? fBefore[0].kind : "");
    A(cH >= 0, "有顾客可以验「满意」态");
    /* debug.serveAll 把某位顾客的订单一次补齐（不推进游戏时间）*/
    d6.serveAll(cH);
    b6.record.drawImage.length = 0;
    b6.pump(1, 1);
    const hitH = d6.faces().filter(f => f.id === cH)[0];
    A(!!hitH && hitH.happy === true && hitH.mood === "happy",
      "订单全部拿到 → 该顾客头像进入第三态 happy",
      hitH ? (hitH.name + " mood=" + hitH.mood + " happy=" + hitH.happy) : "（顾客已离场：满单后 step() 置 left）");
    const happyDrawn = b6.record.drawImage.filter(x => /_happy\.png$/.test(x.src));
    A(happyDrawn.length > 0,
      "帧里真的画了「满意」那张头像贴图",
      happyDrawn.map(x => x.src.split("/").pop()).join(" ") || ("没画（kind=" + kindH + "）"));
    A(happyDrawn.length > 0 && happyDrawn.every(x => new RegExp("art/icons/faces/" + kindH + "_happy\\.png$").test(x.src)),
      "画出来的正是这位顾客（" + kindH + "）自己的 *_happy.png（不是别人的、也不是回退的平静脸）",
      [...new Set(happyDrawn.map(x => x.src.split("/").pop()))].join(" "));

    /* UI：耐心条底槽 bar_empty + 前景 bar_full 按剩余比例裁**源矩形** */
    d6.setPatience(pid[0], 0.8); d6.setPatience(pid[1], 0.5); d6.setPatience(pid[2], 0.2);
    b6.record.drawImage.length = 0;
    b6.pump(1);
    const di6 = b6.record.drawImage;
    const bars = di6.filter(x => /art\/icons\/ui\/bar_empty\.png$/.test(x.src));
    const fills = di6.filter(x => /art\/icons\/ui\/bar_full\.png$/.test(x.src)).sort((a, b) => a.dx - b.dx);
    A(bars.length >= 2, "在场的顾客卡都画了 bar_empty 底槽", "×" + bars.length + "（在场 " + d6.faces().length + " 位）");
    A(fills.length === bars.length, "每位在场顾客的耐心条都画了 bar_full 前景（与底槽一一对应）",
      "底槽 ×" + bars.length + " / 前景 ×" + fills.length);
    A(fills.length >= 2 && fills[fills.length - 1].sw < fills[0].sw,
      "前景的源矩形宽度随剩余耐心单调递减（真的按比例裁，不是把整条压扁）",
      fills.map(x => x.sw.toFixed(0)).join(" > ") + "  （" + fills.length + " 条：验证时已有一位顾客满单离场）");
    A(fills.every(x => x.dw > 0 && x.dh > 0 && x.sw > 0 && x.sw <= 256),
      "前景目标框为正、源矩形不超过贴图宽度", fills.length ? ("sw=" + fills[0].sw.toFixed(0) + " dw=" + fills[0].dw.toFixed(0)) : "无");
    const st6 = di6.filter(x => /art\/icons\/ui\/stars\.png$/.test(x.src));
    A(st6.length >= 5, "顶栏 5 颗星都是从 stars.png 裁出来的单颗星", "×" + st6.length);
    A(st6.length >= 5 && st6.every(x => x.sw > 0 && x.sw < 256 && x.sh > 0),
      "单颗星用源矩形裁剪（sw 小于整幅宽度）", st6.length ? ("sw=" + st6[0].sw.toFixed(0) + "/256") : "无");
    A(di6.some(x => /art\/icons\/ui\/coin\.png$/.test(x.src)), "得分旁边画的是金币 coin.png");
    /* 上桌打勾：让一位顾客的整单完成 → check.png */
    const dz = b6.B.debug;
    dz.drop("congee", null); dz.plateNow(0); dz.serveCol(0);
    b6.record.drawImage.length = 0;
    b6.pump(1);
    A(b6.record.drawImage.some(x => /art\/icons\/ui\/check\.png$/.test(x.src)),
      "订单项完成 → 画绿勾贴图 ui/check.png",
      b6.record.drawImage.filter(x => /ui\//.test(x.src)).map(x => x.src.split("/").pop()).join(" "));
    b6.B.dispose();
  }

  /* ⑨f 玩法入口图标：9 张 art/icons/game/*.png + index.html 的侧栏 / 面板接入 */
  {
    const games = ["mahjong", "breakfast", "talk", "fight", "lottery", "stock", "dodge", "circuit", "memory"];
    const missing = games.filter(n => !fs.existsSync(path.join(OUT, "art", "icons", "game", n + ".png")));
    A(missing.length === 0, "9 张玩法入口图标都在盘上", missing.length ? "缺：" + missing.join(",") : "9/9");
    const sizes = games.map(n => {
      const b = fs.readFileSync(path.join(OUT, "art", "icons", "game", n + ".png"));
      return b.readUInt32BE(16) + "×" + b.readUInt32BE(20);
    });
    A([...new Set(sizes)].length === 1 && sizes[0] === "128×128",
      "9 张都是 128×128（同一套切片规格）", [...new Set(sizes)].join(" "));
    games.forEach(n => A(HTML.indexOf("art/icons/game/" + n + ".png") > 0,
      "index.html 引用了 art/icons/game/" + n + ".png"));
    A(/id="lotteryBtn"><img class="gm-ico" src="art\/icons\/game\/lottery\.png"/.test(HTML),
      "侧栏「刮刮乐」按钮用图标（emoji 作回退）");
    A(/id="mjFreeBtn"><img class="gm-ico" src="art\/icons\/game\/mahjong\.png"/.test(HTML),
      "侧栏「找人打两圈」按钮用图标（emoji 作回退）");
    A(/id="bfBtn"[^>]*><img class="gm-ico" src="art\/icons\/game\/breakfast\.png"/.test(HTML),
      "侧栏「做份早餐」按钮用图标（emoji 作回退）");
    A(/<span class="gm-emj">🎟<\/span>/.test(HTML) && /<span class="gm-emj">🀄<\/span>/.test(HTML) &&
      /<span class="gm-emj">🍳<\/span>/.test(HTML),
      "三个侧栏按钮都保留了 emoji 兜底文案（img onerror / style.display=none 时显示）");
    A(/onerror="this\.remove\(\)"/.test(HTML), "图片加载失败时摘掉 img，不留破图占位");
    A(/\.gm-ico\{display:none/.test(HTML), "入口图标默认 display:none，只有 onload 成功才显示");
    ["dodge", "stock", "circuit", "memory", "talk", "fight"].forEach(n => {
      A(new RegExp('<h3[^>]*><img class="gm-ico" src="art/icons/game/' + n + '\\.png"').test(HTML),
        "玩法面板标题带了 " + n + " 图标");
    });
    A(/#bfGame \.bf-btn\.bf-wood\{[^}]*btn_wood\.png/.test(HTML),
      "顶栏「收摊」按钮用木牌贴图（CSS background-image，失败时退回原描边）");
    A(/#bfGame \.bf-btn\.bf-red\{[^}]*btn_red\.png/.test(HTML), "结算主按钮用红漆贴图");
    A(/\.bf-uiico\{display:none/.test(HTML) && /function uiIconTag\(name, emoji\)/.test(SRC),
      "结算面板的 UI 贴图（绿勾 / 红叉 / 灯泡）走 uiIconTag，带 emoji 回退");
  }

  /* ⑩ 剧情入口链路：sister_bf →（选对象）→ 局 → #bfGo → afterInter → after 镜头 → finishNode

        → S.done 含 sister_bf → next 解锁 flashback；自由局则回沙盘 + 结算 toast。
       做法：把 index.html 里**真实的内联胶水层**（applyFx / afterInter / finishNode / advance / isAvail
       + 早餐店整段 glue）逐字抽出来，和真 breakfast.js 一起跑在同一个无头 vm 里（S / render / toast
       等页面副作用用桩），这样链路断言的是真代码，而不是复刻一份。 */
  runGlueChain(A);

  /* ⑪ 其它玩法的结算出口（麻将 #mjmGo）也做了同样的视口兜底 */
  const MJ = fs.readFileSync(path.join(OUT, "mahjong.js"), "utf8");
  A(/\.mjm-card\.wide\{[^}]*max-height:min\(94%,calc\(100vh - 56px\)\)/.test(MJ), "麻将结算卡 max-height 也按视口收敛");
  A(/#mjmGo\{position:sticky;bottom:0/.test(MJ), "麻将结算卡「继 续」#mjmGo sticky 钉在卡底部");
  A(/\.mjm-card\.wide\{[^}]*overflow-y:auto/.test(MJ), "麻将结算卡内部可滚动（四家手牌再长也滚得动）");
}

/** 结算面板出现后，泵几帧让飘字/面板渲染完（面板关闭按钮不在 canvas 上） */
function pumpSettle(b) { b.pump(6); }

/* ═══════════════════════════════════════════════════════════════════════════
   ⑩ 剧情入口链路：真 index.html 胶水层 × 真 breakfast.js（同一个无头 vm）
   ═══════════════════════════════════════════════════════════════════════════ */
const HTML = fs.readFileSync(path.join(OUT, "index.html"), "utf8");
const PAGE = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
/** 从内联脚本里按「字面签名 + 大括号配平」整段抽出一个函数（逐字复制，不猜、不切片猜） */
function grabFn(script, signature) {
  const i = script.indexOf(signature);
  if (i < 0) throw new Error("找不到函数：" + signature);
  let depth = 0;
  for (let k = script.indexOf("{", i); k < script.length; k++) {
    const c = script[k];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return script.slice(i, k + 1); }
  }
  throw new Error("大括号不配平：" + signature);
}
const GLUE_TAIL = '$("bfBtn").addEventListener("click", function(){ openBreakfast(); });';
/** 早餐店整段胶水（从段落注释到侧栏按钮绑定，逐字） */
function glueSrc() {
  const i = PAGE.indexOf("/* ═══════════════ 早餐店 · 拼手速");
  const j = PAGE.indexOf(GLUE_TAIL);
  if (i < 0 || j < 0) throw new Error("找不到 index.html 里的早餐店胶水层");
  return PAGE.slice(i, j + GLUE_TAIL.length);
}
/** 页面里被胶水层调用的真函数：结算落地 / afterInter / finishNode / advance / isAvail 解锁判定 */
function pageFns() {
  return ["function applyFx(r, why){", "function bumpStat(k){", "function afterInter(fxR, why){",
          "function finishNode(){", "function advance(){", "function isAvail(id){"]
    .map(s => grabFn(PAGE, s)).join("\n");
}
const GLUE_PRELUDE = [
  "var __trace = { xp:0, achv:0, render:0, save:0, toast:[], playShot:0, openInter:0, good:0, bad:0, invite:0, endcard:false };",
  "function gainXp(n){ __trace.xp += n; }",
  "function checkAchv(){ __trace.achv++; }",
  "function clearActive(){ if(S) S.active = null; }",
  "function render(){ __trace.render++; }",
  "function save(){ __trace.save++; }",
  "function toast(h){ __trace.toast.push(String(h)); }",
  "function stopVO(){}",
  "function playShot(){ __trace.playShot++; }",
  "function openInter(it){ __trace.openInter++; }",
  "function showEndcard(){ __trace.endcard = true; }",
  "function map3dPause(){}",
  "function mjMaybeInvite(){ __trace.invite++; }",
  "function grantItem(){}",
  "var $ = function(id){ return document.getElementById(id); };",
  "var fx = { pause:function(){}, removeAttribute:function(){}, load:function(){} };",
  "var AudioSys = { init:function(){}, click:function(){}, good:function(){ __trace.good++; }, bad:function(){ __trace.bad++; } };",
  "var map3dReady = false, Map3D = { setMood:function(){} };",
  "var curNode = null, shotIdx = 0, shotQueue = [], phase = \"shots\";",
  "var S = null;",
].join("\n");
/** 胶水层内部的 let 变量（bfRunning / bfNode / bfLastResult）用探针读出来 */
const GLUE_PROBE = "globalThis.__glueProbe = function(){ return { running:bfRunning, node:bfNode, last:bfLastResult }; };";
/** 起一个「页面级」无头宿主：真 breakfast.js + 真 DATA + 真胶水层 + 桩掉的页面副作用 */
function bootGlue() {
  const body = makeEl("body");
  const ids = {};
  const docListeners = {};
  function slot(id, cls, parent) {
    const e = makeEl("div"); e.id = id; e.className = cls || "";
    (parent || body).appendChild(e); ids[id] = e; return e;
  }
  const bfGame = slot("bfGame", "overlay bf-overlay");
  const bfGameHost = slot("bfGameHost", "panel bf-panel bf-game-panel", bfGame);
  const bfPick = slot("bfPick", "overlay bf-overlay");
  const bfPickHost = slot("bfPickHost", "panel bf-panel", bfPick);
  slot("bfBtn", "btn-m"); slot("cine", "");
  const frames = []; let clock = 0;
  const doc = {
    body, createElement: makeEl,
    getElementById: id => ids[id] || slot(id, ""),
    querySelector: sel => body.querySelector(sel),
    querySelectorAll: sel => body.querySelectorAll(sel),
    addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
    removeEventListener: (t, f) => { const h = docListeners[t] || []; const i = h.indexOf(f); if (i >= 0) h.splice(i, 1); },
  };
  const ctx = vm.createContext({
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, isFinite, parseInt, parseFloat, Set, Map,
    document: doc, devicePixelRatio: 1, __cs2: {},
    performance: { now: () => clock },
    requestAnimationFrame: cb => { frames.push(cb); return frames.length; },
    cancelAnimationFrame: id => { frames[id - 1] = null; },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.runInContext(SRC + "\n;globalThis.__BF = window.Breakfast;", ctx);            // 真玩法模块
  const DATA = PAGE.slice(PAGE.indexOf("const PLACES"), PAGE.indexOf("/* ═══════════════ 音频层"));
  vm.runInContext(DATA + "\n;globalThis.NODES=NODES;globalThis.BONDS=BONDS;globalThis.STATS=STATS;globalThis.ACHV=ACHV;", ctx);
  vm.runInContext(GLUE_PRELUDE, ctx);
  vm.runInContext(pageFns() + "\n" + glueSrc() + "\n" + GLUE_PROBE, ctx);
  function pump(n, ms) {
    for (let i = 0; i < n; i++) {
      clock += (ms === undefined ? 16 : ms);
      const list = frames.slice(); frames.length = 0;
      list.forEach(cb => { if (cb) cb(clock); });
      if (!frames.length) break;
    }
  }
  return {
    ctx, ids, doc, pump, B: ctx.__BF, NODES: ctx.NODES, BONDS: ctx.BONDS,
    trace: () => ctx.__trace,
    probe: () => ctx.__glueProbe(),
    docKeys: () => (docListeners.keydown || []).length,
    setS(bonds, extra) {
      const b = {}; for (const k in ctx.BONDS) b[k] = 30;
      for (const k in (bonds || {})) b[k] = bonds[k];
      ctx.S = Object.assign({
        done: [], stats: { cash: 120, cha: 20, phy: 18, int: 40 }, bonds: b, flags: [], achv: [],
        day: 7, per: 0, card1: 1, card2: 0, history: [], active: null,
        rpg: { xp: 0, owned: [], equipped: { hand: null, outfit: null, accessory: null }, bag: {} },
        buffs: { time: 0, window: 0, hp: 0, capital: 0 },
      }, extra || {});
      return ctx.S;
    },
  };
}
/** 真打赢一局（看单下料 → 熟了自动落盘 → 单击盘出餐） */
function driveWin(B) {
  const d = B.debug;
  let guard = 0;
  while (!d.state().over && guard++ < 6000) {
    for (const c of d.orders()) for (const f of c.order) {
      if (c.done.indexOf(f) >= 0) continue;
      if (d.stations().some(s => s.food === f)) continue;
      if (d.plates().some(p => p.food === f && p.state !== "burnt")) continue;
      d.drop(f, null);
    }
    for (let n = 0; n < 60 && !d.state().over; n++) { d.tick(1 / 60); if (d.plates().some(p => p.state === "perfect")) break; }
    if (d.state().over) break;
    d.stations().forEach((s, i) => { if (s.plate && s.plateState !== "burnt") d.serveCol(i); });
    d.stations().forEach((s, i) => {
      if (s.state === "burnt" || s.plateState === "burnt") { d.trash(i); return; }
      if (s.plate) { const r = d.serveCol(i); if (!r.ok && r.why === "no-want") d.trash(i); }
    });
    d.tick(0.15);
  }
  return d.state();
}

function runGlueChain(A) {
  /* ── 入口 A · 剧情节点 sister_bf（inter.type === "cook"）── */
  const G = bootGlue();
  const N = G.NODES;
  A(!!N.sister_bf && !!N.sister_bf.inter && N.sister_bf.inter.type === "cook",
    "剧情入口数据齐：sister_bf.inter.type === \"cook\"");
  A((N.sister_bf.next || []).indexOf("flashback") >= 0, "sister_bf.next 指向 flashback");
  A(Array.isArray(N.sister_bf.after) && N.sister_bf.after.length >= 1, "sister_bf 有 after 镜头（结算后要接着播）");
  const S = G.setS({ su: 40 });                       // 苏晚晴好感 40 → 今天还没送过 → 可选
  const node = N.sister_bf; node.id = "sister_bf";
  G.ctx.curNode = node;
  const cha0 = S.stats.cha, phy0 = S.stats.phy, bond0 = S.bonds.su;

  G.ctx.startCook(node.inter);                        // openInter(cook) → startCook → openBreakfast
  A(G.ids.bfPick.classList.contains("on"), "从剧情节点进：startCook 打开「做份早餐·送给谁」面板");
  A(G.ids.bfGame.classList.contains("on") === false, "这时游戏覆盖层还没开");
  const wrap = G.ids.bfPickHost.children[0];
  A(!!wrap && wrap.querySelectorAll(".bf-card").length === 9, "选对象面板列出 9 位可攻略角色");
  const card = wrap.querySelector('.bf-card[data-id=su]');
  A(!!card, "拿到苏晚晴那张卡（好感 40 · 今天没送过 → 可选）");
  card.dispatch("click");                             // = 玩家点这张卡
  A(G.ids.bfPick.classList.contains("on") === false, "选完 → 选对象面板关闭");
  A(G.ids.bfGame.classList.contains("on") === true, "选完 → 早餐店游戏覆盖层打开");
  const p1 = G.probe();
  A(p1.running === true && p1.node === true, "胶水层记住「本局是从剧情节点进来的」（bfRunning / bfNode 都是 true）");

  const st = driveWin(G.B);                            // 真打一局
  A(st.win === true, "剧情局真打赢了", "served " + st.served + "/" + st.goal);
  G.pump(3);
  const go = G.ids.bfGameHost.querySelector("#bfGo");
  A(!!go, "剧情局结算面板里也有出口按钮 #bfGo");
  A(!!go && /收下早餐\s*·\s*继续/.test(go.textContent), "剧情局按钮文案「收下早餐 · 继续」");
  A(G.probe().last === null, "结算面板出来时还没把结果交出去");
  if (go) { go.click(); go.click(); go.click(); }      // 连点 3 次
  A(G.probe().running === false && G.probe().node === false, "点 #bfGo → 胶水层收摊（bfRunning / bfNode 复位）");
  A(G.ids.bfGame.classList.contains("on") === false, "点 #bfGo → #bfGame 覆盖层关闭");
  A(!!G.probe().last && G.probe().last.win === true, "点 #bfGo → onFinish 把 win:true 的 result 交给胶水层");
  A(S.bonds.su === bond0 + G.probe().last.bondDelta, "好感真落地：苏晚晴 " + bond0 + " → " + S.bonds.su,
    "Δ" + G.probe().last.bondDelta);
  A(!!S.breakfastDay && S.breakfastDay.sent.indexOf("su") >= 0, "每日一次记账：su 进了今天的已送名单");
  A(S.bfWin === true, "通过 → S.bfWin 记上（成就链要用）");
  /* afterInter：结算退出后接着播节点自己的 after 镜头 */
  A(G.ctx.phase === "after", "afterInter 把演出切到 after 阶段（不是直接丢回沙盘）");
  A(G.ctx.shotQueue === node.after, "afterInter 播放的是 sister_bf 自己的 after 镜头队列");
  A(G.trace().playShot >= 1, "after 镜头真的被播放（playShot 被调用）");
  A(S.done.indexOf("sister_bf") < 0, "after 镜头还没走完 → 节点还没算完成（finishNode 未跑）");
  G.ctx.advance();                                     // 玩家点「继续 ▸」把 after 镜头走完
  A(S.done.indexOf("sister_bf") >= 0, "after 镜头走完 → finishNode 把 sister_bf 记进 S.done");
  A(G.ctx.isAvail("flashback") === true, "next 节点因此解锁：isAvail(\"flashback\") === true");
  A(S.stats.cha === cha0 + 3 && S.stats.phy === phy0 + 1,
    "节点奖励真落地：魅力 " + cha0 + "→" + S.stats.cha + " · 体质 " + phy0 + "→" + S.stats.phy);
  A(S.active === null, "finishNode → clearActive：演出快照已清（回沙盘不是半路状态）");
  A(G.trace().render >= 1, "finishNode → render()：HUD / 侧栏恢复可用");
  A(G.ids.bfPick.classList.contains("on") === false && G.ids.bfGame.classList.contains("on") === false,
    "两个覆盖层都已关掉（不留挡住沙盘的死界面）");
  A(G.docKeys() === 0, "剧情局收摊后 document 上不留 keydown 监听");

  /* ── 入口 B · 侧栏自由局：退出后回沙盘 + 结算 toast ── */
  const G2 = bootGlue();
  const S2 = G2.setS({ guo: 30 });
  G2.ctx.curNode = null;                               // 自由局：不在任何剧情节点里
  G2.ctx.openBreakfast();                              // 侧栏「🍳 做份早餐」
  const wrap2 = G2.ids.bfPickHost.children[0];
  const card2 = wrap2 && wrap2.querySelector('.bf-card[data-id=guo]');
  A(!!card2, "侧栏入口同样能开出选对象面板");
  card2.dispatch("click");
  A(G2.ids.bfGame.classList.contains("on") === true, "侧栏入口开局：游戏覆盖层打开");
  A(G2.probe().node === false, "侧栏自由局不是剧情局（bfNode === false）");
  const st2 = driveWin(G2.B);
  A(st2.win === true, "自由局也真打赢了");
  G2.pump(3);
  const go2 = G2.ids.bfGameHost.querySelector("#bfGo");
  A(!!go2, "自由局结算面板里也有 #bfGo");
  if (go2) { go2.click(); go2.click(); }
  A(G2.probe().running === false && G2.ids.bfGame.classList.contains("on") === false,
    "自由局点 #bfGo → 回沙盘（覆盖层关闭）");
  A(S2.done.length === 0, "自由局不往 S.done 里塞节点（不误触剧情推进）");
  A(G2.ctx.phase === "shots", "自由局不走 afterInter（phase 没被改动）");
  const toasts2 = G2.trace().toast.join(" || ");
  A(/本局影响/.test(toasts2), "自由局退出后给「本局影响」结算 toast", toasts2.slice(0, 60));
  A(/接下来/.test(toasts2), "自由局退出后给「接下来还能干什么」toast");
  A(/服务\s*\d+\/\d+/.test(toasts2), "结算 toast 带今日战绩（服务 x/8 · 完美 · 糊 · 得分）");
  A(!!S2.bfLast && S2.bfLast.target === "guo", "S.bfLast 记下今日战绩（侧栏「上次」那一行要用）");
  A(G2.trace().render >= 2, "自由局退出后 render() 被调用 → 侧栏 / HUD 恢复可用");
  A(G2.docKeys() === 0, "自由局收摊后 document 上不留 keydown 监听");
}

/* ══════════════ 音效 / 顾客语音（bf-audio-1）无头验收 ══════════════
   证据链：真起一局 → 用 debug API 把顾客耐心压到阈值上下 → 断言**假 Audio 的调用序列**
   （谁、哪个文件、什么音量、第几次），再验开关、素材缺失 / 被拦两种回落、玩法不受影响。

   为什么要在无头里单独做这一层：
     breakfast.js 的音效层是「有文件用文件，缺失静默回落」，这跟素材接线那个坑一模一样 ——
     静默回落会让「素材缺了 / 根本没接线」在断言层面**看不出来**。所以这里既查磁盘素材规格，
     也查运行时真的 new 了 Audio 并调了 play()（而不是只写了个函数没接上）。 */
function runAudio() {
  const bfDir = path.join(OUT, "audio", "bf");
  /* bf-9：欢呼换成 6 条新录音（都是实测上扬的），另加 9 条「下锅那一刻」的烹饪音效。
     bf-10：用户试听后拍板把池子改成 v1 / alt2 / v3 / alt3 / v5 / v6 ——
     这里**不再写死文件名**，改成开局后从 debug.audio().files.happy 现取（见 ② 段），
     免得以后每次换池都要同步一份常量（上一版就是写死了 v1..v6）。 */
  const FILES = ["tick.mp3", "slow.mp3",
                 "cook_congee.mp3", "cook_milk.mp3", "cook_soup.mp3", "cook_egg.mp3",
                 "cook_bacon.mp3", "cook_sandwich.mp3", "cook_bun.mp3",
                 "cook_salad.mp3", "cook_juice.mp3"];


  /* ── ① 素材：都在磁盘上、规格统一 ── */
  const missing = FILES.filter(f => !fs.existsSync(path.join(bfDir, f)) || fs.statSync(path.join(bfDir, f)).size < 600);
  A(missing.length === 0, "audio/bf " + FILES.length + " 个素材都在磁盘上且非空",
    missing.length ? "缺：" + missing.join(",") : FILES.length + " 个都齐");
  const tk = mp3.mp3Info(path.join(bfDir, "tick.mp3"));
  A(tk.decoded > 0.02 && tk.decoded <= 0.120, "tick.mp3 是「短促一声」：解码长度 ≤120ms",
    (tk.decoded * 1000).toFixed(0) + "ms（" + tk.frames + " 帧）");
  A(tk.sampleRate === 48000 && tk.channels === 1, "tick.mp3 规格 48kHz / 单声道",
    tk.sampleRate + "Hz / " + tk.channels + "ch");
  /* bf-10：这七条的规格改到 ② 段按**开局后的真池子**量（见 a0.files.happy 那几句）——
     原来这里写死了 v1..v6，用户换池之后就会量到错的文件上。 */
  /* 9 条下锅音效都是「短促的一声」：0.2s < 时长 ≤ 0.8s */
  const cookInfos = FILES.filter(f => /^cook_/.test(f)).map(f => mp3.mp3Info(path.join(bfDir, f)));
  A(cookInfos.length === 9 && cookInfos.every(i => i.decoded > 0.2 && i.decoded <= 0.8),
    "9 条下锅音效都是短促一声（0.2~0.8s）",
    cookInfos.map(i => (i.decoded * 1000).toFixed(0)).join("/") + "ms");
  A(cookInfos.every(i => i.sampleRate === 48000 && i.channels === 1), "9 条下锅音效规格与别的素材一致（48kHz / 单声道）");

  /* ── ② 真跑一局，记录假 Audio 的调用序列 ── */
  const g = boot();
  const B = g.B, d = B.debug, rec = g.record;
  const tickCalls = () => rec.audio.filter(c => /audio\/bf\/tick\.mp3$/.test(c.src));
  /* 原（bf-10）：/audio\/bf\/happy_(?:v[1-6]|alt[23])\.mp3$/  —— 6 条池
     新（bf-11）：/audio\/bf\/happy_(?:v[13]|i45|finally2)\.mp3$/ —— 4 条池
     原因：用户 bf-11 重新点名 4 条并把「终于好啦」换成不含「呜呼」的版本；
     alt2/alt3/v5/v6 已不在池里，正则必须同步收紧，否则「播了池外文件」也能通过。 */
  const happyCalls = () => rec.audio.filter(c => /audio\/bf\/happy_(?:v[13]|i45|finally2)\.mp3$/.test(c.src));
  const slowCalls = () => rec.audio.filter(c => /audio\/bf\/slow\.mp3$/.test(c.src));

  A(B.start(g.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 300, goal: 99, onFinish() {} }) === true,
    "音效用例：新开一局（duration 300 / goal 99，不会自己结束）");
  g.pump(10);
  const cv = g.canvas();                           // ⚠ start() 之后才取：之前宿主节点是空的
  const a0 = d.audio();
  A(typeof d.audio === "function" && !!a0, "debug.audio() 台账可读");
  A(a0.on === true, "默认开（localStorage 里没有 bfSoundOn 时也是开）", String(a0.on));
  A(a0.tickAt === 0.30 && a0.gapFar === 1.0 && a0.gapNear === 0.5,
    "常量与规格一致：TICK_AT=0.30 · 30% 档 1.0s · 10% 档 0.5s",
    a0.tickAt + " / " + a0.gapFar + "s / " + a0.gapNear + "s");
  A(a0.files.happy.length === 4 && a0.files.tick.length === 1 && a0.files.slow.length === 1,
    "词表：滴答 1 条 · 欢呼 4 个变体（bf-11 拍板）· 哼 1 条",
    "tick=" + a0.files.tick.join(",") + " happy=" + a0.files.happy.join(","));
  /* 欢呼池在**开局之后**现取（池子写死过一次、用户又换了人，
     所以这里不再抄一份常量；池子里每条都按规格量一遍 —— 换人不换规格）
     原（bf-10）：欢呼池 6 条、断言 alt2/alt3 进池且 v2/v4 出池
     新（bf-11）：欢呼池 4 条 —— 用户重新点名「开动啦(v1) / v3 / 终于好啦 / i45」，
     并要求把「终于好啦」那条换成**不含「呜呼」**的版本（happy_v2 → happy_finally2）。 */
  const poolNames = a0.files.happy.slice();
  const poolInfos = poolNames.map(f => mp3.mp3Info(path.join(bfDir, f)));
  A(poolInfos.every(i => i.sampleRate === 48000 && i.channels === 1),
    "欢呼池 4 条都是 48kHz / 单声道（bf-11 拍板池：v1/v3/finally2/i45）",
    poolNames.map((f, i) => f + "=" + poolInfos[i].duration.toFixed(2) + "s").join(" "));
  A(poolInfos.every(i => i.decoded > 0.4 && i.decoded <= 3.0),
    "4 条欢呼每条 0.4~3s（边做边喊不至于叠成一片）",
    poolInfos.map(i => i.decoded.toFixed(2)).join(" / "));
  A(poolNames.indexOf("happy_v1.mp3") >= 0 && poolNames.indexOf("happy_v3.mp3") >= 0
    && poolNames.indexOf("happy_finally2.mp3") >= 0 && poolNames.indexOf("happy_i45.mp3") >= 0
    && poolNames.indexOf("happy_v2.mp3") < 0,
    "用户 bf-11 拍板生效：点名 4 条进池，happy_v2（含「呜呼」）出池", poolNames.join(","));
  const cookKeys = Object.keys(a0.cookFiles || {});

  A(cookKeys.length === 9 && cookKeys.every(f => (a0.files["cook_" + f] || []).length === 1),
    "词表：9 样食材各有一条下锅音效，且都挂进同一张素材表（开关 / 回落 / 台账复用）",
    cookKeys.map(f => f + "→" + ((a0.files["cook_" + f] || [])[0] || "无")).join(" "));
  A(a0.cookGap === 0.3 && a0.cookMax === 2,
    "下锅音效的纪律：同食材 300ms 节流 · 同时最多 2 条",
    a0.cookGap + "s / " + a0.cookMax + " 条");
  A(a0.vol.tick < a0.vol.happy && a0.vol.happy <= 0.8, "滴答音量低于语音（不吵人）",
    "tick=" + a0.vol.tick + " happy=" + a0.vol.happy + " slow=" + a0.vol.slow);
  A(a0.key === "bfSoundOn" && a0.dir === "audio/bf/", "开关键 / 素材目录就是约定的那两个",
    a0.key + " · " + a0.dir);

  const idA = d.pushCustomer(["congee"]);
  const idB = d.pushCustomer(["egg"]);
  g.pump(6);
  A(rec.audio.length === 0, "顾客刚进店（耐心充足）→ 一条音效都没播", rec.audio.length + " 次调用");

  /* ── ③ 滴答：30% 阈值 ── */
  d.setPatience(idA, 0.31); d.setPatience(idB, 0.95);
  d.tick(1 / 60);
  A(tickCalls().length === 0, "耐心 31%（>30%）→ 不播滴答");
  d.setPatience(idA, 0.29);
  d.tick(1 / 60);
  A(tickCalls().length === 1, "耐心 29%（≤30%）→ 当帧就播一条滴答",
    tickCalls()[0] && tickCalls()[0].src);
  A(tickCalls()[0] && tickCalls()[0].volume > 0 && tickCalls()[0].volume < 0.6,
    "滴答音量压低（" + (tickCalls()[0] || {}).volume + "）");

  /* ── ④ 滴答：全局节流（两位同时低耐心也只有一条）── */
  /* 上一档是 1.0s 间隔，先把那个窗口空跑掉，再开始计数（否则相位会把第一条挤到窗口外）*/
  for (let i = 0; i < 72; i++) { d.tick(1 / 60); d.setPatience(idA, 0.05); d.setPatience(idB, 0.05); }
  rec.audio.length = 0;
  let maxPerFrame = 0;
  for (let i = 0; i < 120; i++) {                   // 2 秒窗口（0.5s 档 → 3~5 条）
    const before = rec.audio.length;
    d.tick(1 / 60);
    maxPerFrame = Math.max(maxPerFrame, rec.audio.length - before);
    d.setPatience(idA, 0.05); d.setPatience(idB, 0.05);
  }
  A(maxPerFrame === 1, "两位顾客同时 5% → 同一帧最多一条滴答（不是一人一条）", maxPerFrame + " 条/帧");
  A(tickCalls().length >= 3 && tickCalls().length <= 5,
    "2 秒窗口内 3~5 条（单通道节流；逐人播会是 8~10 条）", tickCalls().length + " 条");

  /* ── ⑤ 滴答：越急越密 ── */
  const countTicks = (ratio, seconds) => {
    rec.audio.length = 0;
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n; i++) { d.tick(1 / 60); d.setPatience(idA, ratio); d.setPatience(idB, 0.95); }
    return tickCalls().length;
  };
  const far = countTicks(0.28, 3.0), near = countTicks(0.08, 3.0);
  A(near > far, "越急越密：30% 档 3 秒 " + far + " 条 → 10% 档 3 秒 " + near + " 条");

  /* ── ⑥ 上餐成功 → 「呜呼」只播一次 ── */
  rec.audio.length = 0;
  let served = false;
  for (let guard = 0; guard < 6000 && !served; guard++) {
    d.orders().forEach(o => d.setPatience(o.id, 0.95));      // 别让谁在这一段里跑单
    const os = d.orders();
    if (!os.length) { d.tick(0.2); continue; }
    const c = os[0];
    let want = null;
    for (const f of c.order) if (c.done.indexOf(f) < 0) { want = f; break; }
    if (!want) { d.tick(0.1); continue; }
    const col = d.columnOf(want);
    const s = d.stations()[col];
    if (!s.food && !s.plate) d.drop(want, col);
    d.tick(1 / 60);
    const s2 = d.stations()[col];
    if (s2.plate && s2.plateState !== "burnt") { const r = d.serveCol(col); if (r.ok) served = true; }
  }
  A(served, "无头里真的完成了一次上餐（happy 断言的前提）");
  A(happyCalls().length === 1, "上餐成功 → 恰好播一条欢呼", happyCalls().length + " 条");
  A(!!happyCalls()[0] && /^audio\/bf\/happy_(?:v[13]|i45|finally2)\.mp3$/.test(happyCalls()[0].src),
    "播的是 bf-11 拍板池里的一条：" + ((happyCalls()[0] || {}).src || "无"));
  A(tickCalls().length === 0, "这一段没有误播滴答（耐心被压住 ≥95%）");

  /* ── ⑦ 跑单 → 「哼，太慢了」，同一帧多人也只播一条 ── */
  rec.audio.length = 0;
  const ids = d.orders().map(o => o.id);
  A(ids.length >= 1, "在场还有顾客可以演「等太久走掉」", ids.length + " 位");
  const angry0 = d.state().angry;
  ids.forEach(id => d.setPatience(id, 0));
  d.tick(1 / 60);
  A(slowCalls().length === 1, "同一帧 " + ids.length + " 位顾客离开 → 只播一条「哼，太慢了」", slowCalls().length + " 条");
  A(!!slowCalls()[0] && slowCalls()[0].src === "audio/bf/slow.mp3", "播的是 audio/bf/slow.mp3");
  A(d.state().angry >= angry0 + 1, "顾客确实跑单了（angry 计数上升）", angry0 + " → " + d.state().angry);
  const nAfterSlow = tickCalls().length;
  for (let i = 0; i < 60; i++) d.tick(1 / 60);
  A(tickCalls().length === nAfterSlow, "跑单之后 1 秒内不再滴答（人已经不催了）");

  /* ── ⑧ 开关：顶栏按钮 + 图例徽章 + localStorage ── */
  const btn = g.host.querySelector("#bfSound");
  A(!!btn, "顶栏生成了 #bfSound 音效开关（与「收 摊」同款 bf-wood）", btn ? String(btn.className) : "无");
  A(!!btn && /🔊/.test(String(btn.textContent)), "开着的时候按钮写「🔊 音效」", btn && String(btn.textContent));
  const box = d.soundBox();
  A(!!box && box.w > 60 && box.h >= 18 && box.x >= 0 && box.y > 0,
    "图例条左端有徽章命中框（可点）", JSON.stringify(box));
  if (btn) btn.click();
  A(d.audio().on === false, "点顶栏按钮 → 关掉", String(d.audio().on));
  A(!!btn && /🔇/.test(String(btn.textContent)), "关掉后按钮写「🔇 静音」", btn && String(btn.textContent));
  A(rec.storage["bfSoundOn"] === "0", "开关写进 localStorage.bfSoundOn", JSON.stringify(rec.storage));
  g.pump(2);
  A(d.audio().badge === "off", "画布徽章跟着变（badge=off）", String(d.audio().badge));
  const offLog0 = d.audio().log.length;
  rec.audio.length = 0;
  const idC = d.pushCustomer(["egg"]);
  d.setPatience(idC, 0.10);
  d.tick(1 / 60);                                  // 本该滴答
  d.setPatience(idC, 0);
  d.tick(1 / 60);                                  // 本该跑单语音
  A(rec.audio.length === 0, "关掉之后：滴答 / 哼 一条都不播（没有 new Audio）", rec.audio.length + " 次调用");
  const offLog = d.audio().log.slice(offLog0);
  A(offLog.length >= 1 && offLog.every(r => r.why === "off"), "但台账留了 off 记录（可诊断）",
    offLog.map(r => r.name + ":" + r.why).join(","));
  cv.dispatch("mousedown", { clientX: box.x + box.w / 2, clientY: box.y + box.h / 2, preventDefault() {} });
  A(d.audio().on === true, "点画布图例徽章 → 同样能开回来（两个入口同一个开关）");
  A(rec.storage["bfSoundOn"] === "1", "开回来也写 localStorage", JSON.stringify(rec.storage));
  g.pump(2);
  A(d.audio().badge === "on", "徽章回到 🔊 开");
  A(rec.audioPauses.length === 0, "全程没有 pause() 过任何音频（不打断正在播的语音）",
    rec.audioPauses.length + " 次 pause");

  /* ── ⑨ 素材缺失 / 被浏览器策略拦：静默、不影响玩法 ── */
  const g2 = boot({ audioBlock: true });
  const B2 = g2.B, d2 = B2.debug, rec2 = g2.record;
  A(B2.start(g2.host, { duration: 300, goal: 99, onFinish() {} }) === true, "素材缺失场景：照样能开局");
  let threw = null;
  try {
    const id2 = d2.pushCustomer(["egg"]);
    d2.setPatience(id2, 0.10);
    d2.tick(1 / 60);                                // 滴答
    d2.setPatience(id2, 0);
    d2.tick(1 / 60);                                // 跑单
    g2.pump(5);
  } catch (e) { threw = e; }
  A(threw === null, "文件缺失 / play() 被拦 → 不抛错、不冒泡", threw ? String(threw.message) : "无异常");
  A(rec2.audio.length >= 2, "确实尝试播过（有调用记录可查）", rec2.audio.length + " 次调用");
  A(rec2.audio.every(c => c.blocked === true), "每次调用都被环境标成被拦/缺失");
  A(B2.isBusy() === true && d2.state().running === true, "玩法照常：游戏还在跑（isBusy / running 都为真）");
  A(d2.audio().plays.length === 0, "台账里没有「播成功」的记录（全被标掉，不冒充满分）");
  A(d2.audio().log.some(r => r.why === "load-error" || r.why === "blocked"),
    "记录里能看到 load-error / blocked",
    d2.audio().log.map(r => r.why).join(","));
  B2.dispose();
  B.dispose();
  A(B.isBusy() === false, "音效用例收尾：两局都已 dispose（不留后台循环）");
}

/* ═══════════════════════════════════════════════════════════════════════════
   bf-9 四条改动（用户实测后提的）—— 全部走**真实鼠标事件** + **假 Audio 的调用序列**：
     ① 新时长表：9 列各自在自己的时刻熟（最长 3.4s，白粥不再拖垮节奏）
     ② 下锅音效：点哪样响哪样（9 样一对一）、同食材 300ms 节流、同时最多 2 条、开关能关掉
     ③ 上餐选人：3 位都要同一份（耐心 5/20/40）→ 必定送给耐心 5 那位；
        以及「不再只能给第一位」—— 第一位秒数更少但进度条更长时，给进度条短的那位
     ④ 部分上餐：真实点盘送一样 → 耐心 +3.5s，且**不超过他的初始耐心**
   ═══════════════════════════════════════════════════════════════════════════ */
function runBf9() {
  const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const CANON = { congee:"白粥", milk:"热牛奶", soup:"清汤", egg:"煎蛋", bacon:"培根",
                  sandwich:"三明治", bun:"包子", salad:"沙拉", juice:"果汁" };
  /** 开一局 + 拿到画布（真实鼠标事件要往画布上 dispatch）*/
  function newGame(goal) {
    const g = boot();
    A(g.B.start(g.host, { target: { id: "su", name: "苏晚晴", bond: 40 },
                          duration: 999, goal: goal || 99, onFinish() {} }) === true,
      "bf-9：新开一局（duration 999 / goal " + (goal || 99) + "）");
    return { g: g, B: g.B, d: g.B.debug, rec: g.record, cv: g.canvas() };
  }
  const click = (cv, pt) => cv.dispatch("mousedown", { clientX: pt.x, clientY: pt.y, preventDefault() {} });

  /* ── ① 下锅音效：真实鼠标点 9 个食材桶 ── */
  {
    const G = newGame();
    const B = G.B, d = G.d, rec = G.rec, cv = G.cv;
    const cookCalls = f => rec.audio.filter(c => c.src === "audio/bf/cook_" + f + ".mp3");
    A(d.audio().cookFiles && Object.keys(d.audio().cookFiles).length === 9,
      "下锅音效映射表有 9 条（食材 → 文件）", JSON.stringify(d.audio().cookFiles));
    const seen = [];
    for (let i = 0; i < 9; i++) {
      const f = B.FOOD_IDS[i], bp = center(B.bucketBox(i));
      const n0 = rec.audio.length;
      click(cv, bp);                                     // ← 真实鼠标点「第 i 个食材桶」
      const got = cookCalls(f);
      seen.push((got[0] || {}).src || "");
      A(got.length === 1, "点「" + CANON[f] + "」桶 → new Audio(audio/bf/cook_" + f + ".mp3)",
        got.length + " 条：" + rec.audio.slice(n0).map(c => c.src.replace("audio/bf/", "")).join(","));
      A(got.length === 1 && got[0].volume >= 0.3 && got[0].volume <= 0.6,
        "「" + CANON[f] + "」下锅音量落在 0.3~0.6（不吵）", got[0] ? String(got[0].volume) : "无");
      A(d.state().cooks === i + 1, "台账记下锅次数（" + CANON[f] + " → " + (i + 1) + "）",
        String(d.state().cooks));
      d.tick(0.75);                                      // 让这一条播完（不同食材也受并发上限约束）
    }
    A(new Set(seen).size === 9 && seen.every(s => /^audio\/bf\/cook_\w+\.mp3$/.test(s)),
      "9 个桶点到的是 9 个**互不相同**的文件", seen.map(s => s.replace("audio/bf/", "")).join(" "));
    /* 落盘 / 上餐不响下锅音效 */
    const nBefore = cookCalls("egg").length;
    for (let k = 0; k < 200 && !d.stations()[3].plate; k++) d.tick(1 / 60);
    A(!!d.stations()[3].plate, "煎蛋熟了自动落到专属盘（不响下锅音效的前提）");
    A(cookCalls("egg").length === nBefore, "出锅 / 落盘不响下锅音效（只在下锅那一刻响）",
      cookCalls("egg").length + " 条");
    G.B.dispose();
  }

  /* ── ② 同一食材 300ms 节流（真实连点同一个桶）── */
  {
    const G = newGame();
    const d = G.d, rec = G.rec, cv = G.cv;
    const jp = center(G.B.bucketBox(8));                 // 第 8 桶 = 果汁
    const juice = () => rec.audio.filter(c => /cook_juice\.mp3$/.test(c.src));
    d.tick(0.4);                                         // 先离开上一局残留的窗口（新局其实没有，保险）
    rec.audio.length = 0;
    click(cv, jp);
    A(juice().length === 1, "第一次点果汁 → 响一条", juice().length + " 条");
    d.trashCol(8);                                       // 清空这一列，马上再点（时间不推进）
    click(cv, jp);
    A(juice().length === 1, "300ms 内连点同一样 → 不叠第二声（COOK_MIN_GAP）", juice().length + " 条");
    A(d.audio().log.filter(r => r.why === "throttle").length === 1, "被节流的那次留了 throttle 记录（可诊断）",
      d.audio().log.filter(r => r.why).map(r => r.why).join(","));
    A(d.audio().plays.filter(p => p.name === "cook_juice").length === 1, "被节流的不算「播成功」");
    d.trashCol(8); d.tick(0.35);                         // 过 300ms 窗口
    click(cv, jp);
    A(juice().length === 2, "过了 300ms → 再点能响（不是「一局只响一次」）", juice().length + " 条");
    G.B.dispose();
  }

  /* ── ③ 不同食材可叠，但同一时刻最多 2 条 ── */
  {
    const G = newGame();
    const d = G.d, rec = G.rec, cv = G.cv;
    rec.audio.length = 0;
    [0, 1, 3, 7].forEach(i => click(cv, center(G.B.bucketBox(i))));   // 白粥 / 牛奶 / 煎蛋 / 沙拉，同一时刻
    const n = rec.audio.filter(c => /cook_/.test(c.src)).length;
    A(n === 2, "同时点 4 样不同食材 → 只响 2 条（并发上限 2，不糊成一片）", n + " 条");
    A(d.audio().log.filter(r => r.why === "busy").length === 2, "被并发上限挡下的 2 次留了 busy 记录",
      d.audio().log.filter(r => r.why).map(r => r.why).join(","));
    A(d.state().cooks === 2, "台账只记 2 次下锅音效", String(d.state().cooks));
    G.B.dispose();
  }

  /* ── ④ 开关关掉 → 下锅音效一条都不播 ── */
  {
    const G = newGame();
    const d = G.d, rec = G.rec, cv = G.cv;
    A(d.setSound(false) === false, "关掉音效开关（与滴答 / 语音同一个开关）");
    rec.audio.length = 0;
    click(cv, center(G.B.bucketBox(8)));
    click(cv, center(G.B.bucketBox(3)));
    A(rec.audio.length === 0, "关掉之后点食材下锅：一条都不播（没有 new Audio）", rec.audio.length + " 次调用");
    const log = d.audio().log.filter(r => /^cook_/.test(r.name));
    A(log.length >= 2 && log.every(r => r.why === "off"),
      "但台账留了 off 记录（可诊断）", log.map(r => r.name + ":" + r.why).join(","));
    d.setSound(true);
    G.B.dispose();
  }

  /* ── ⑤ 上餐选人 + 部分上餐（真实鼠标点专属盘）── */
  {
    const G = newGame();
    const B = G.B, d = G.d, cv = G.cv;
    A(d.state().partialBonusPer === 3.5 && d.state().serveDangerSec === 6,
      "新常量暴露给验收：部分上餐 +3.5s · 救命档 6s",
      d.state().partialBonusPer + " / " + d.state().serveDangerSec);
    /* ⚠ 耐心上限 = (10 + 7.5×订单长度) × 难度系数，单局最多 ≈32.5s ——
       「40 秒」在游戏里摆不出来（纯逻辑单测可以直接改字段，那边照旧 5/20/40）。
       这里用 5 / 12 / 30：三档差距明显，足以验证「挑最急的那位」。 */
    const idLate = d.pushCustomer(["egg", "bacon", "salad"]);   // 先来的（长单，上限最高）
    const idMid = d.pushCustomer(["egg", "congee"]);
    const idHurry = d.pushCustomer(["egg", "juice"]);          // 最后来的（要摆成最急）
    const abs = (id, want) => {                            // 按绝对值摆耐心（返回摆好后的值）
      const o = d.orders().filter(x => x.id === id)[0];
      if (!o) return null;
      d.setPatience(id, want / o.patienceMax);
      return d.orders().filter(x => x.id === id)[0].patience;
    };
    /* 先把煎蛋煮好落到盘上（这一段耐心会掉，所以摆值放在点击前一刻）*/
    d.drop("egg", null);
    for (let k = 0; k < 200 && !d.stations()[3].plate; k++) d.tick(1 / 60);
    A(!!d.stations()[3].plate, "煎蛋已经落在第 3 列的专属盘上");
    const pLate = abs(idLate, 30), pMid = abs(idMid, 12), pHurry = abs(idHurry, 5);
    A(Math.abs(pLate - 30) < 0.05 && Math.abs(pMid - 12) < 0.05 && Math.abs(pHurry - 5) < 0.05,
      "3 位顾客的耐心分别摆成 30 / 12 / 5（三档明显不同）", pLate + " / " + pMid + " / " + pHurry);
    A(d.pickFor("egg") === idHurry, "规则层：正需要这份的 3 位里挑耐心最少的（#" + idHurry + "）",
      "pickFor → #" + d.pickFor("egg"));
    click(cv, center(B.plateBox(3)));                      // ← 真实鼠标单击第 3 列的专属盘
    const after = d.orders();
    const got = after.filter(o => o.done.indexOf("egg") >= 0).map(o => o.id);
    A(got.length === 1 && got[0] === idHurry,
      "真实点盘 → 煎蛋送给耐心 5 那位（不是第一位）", "拿到煎蛋的是 #" + got.join("/"));
    const hurry = after.filter(o => o.id === idHurry)[0];
    A(!!hurry && Math.abs(hurry.patience - 8.5) < 0.1,
      "他还缺 juice → 部分上餐给他回 +3.5s 耐心（5 → 8.5）", hurry ? String(hurry.patience) : "无");
    A(d.state().partialServes === 1 && d.state().partialBonus === 3.5,
      "台账：部分上餐 1 次 / 一共回了 3.5s", d.state().partialServes + " 次 / " + d.state().partialBonus + "s");

    /* 上限：耐心已经顶到初始值 → 再送一样只加余量（不越过初始耐心）*/
    const idFull = d.pushCustomer(["congee", "bacon"]);
    const oFull = d.orders().filter(x => x.id === idFull)[0];
    d.drop("congee", null);
    for (let k = 0; k < 300 && !d.stations()[0].plate; k++) d.tick(1 / 60);
    d.setPatience(idFull, 1.0);                            // = 初始耐心（满）
    const full0 = d.orders().filter(x => x.id === idFull)[0].patience;
    A(Math.abs(full0 - oFull.patienceMax) < 0.05, "把这位摆成「满耐心」（= 初始耐心）", String(full0));
    click(cv, center(B.plateBox(0)));
    const full1 = d.orders().filter(x => x.id === idFull)[0];
    A(!!full1 && Math.abs(full1.patience - oFull.patienceMax) < 0.05,
      "满耐心时再收一样 → 顶到初始耐心就停（不能靠上餐无限续命）",
      full1 ? full1.patience + " / 上限 " + full1.patienceMax : "无");

    /* 不再「只能给第一位」：第一位秒数更少、但进度条更长 → 给进度条短的那位 */
    d.tick(0.4);
    const idFirst = d.pushCustomer(["egg", "bacon"]);       // 先来（短单）
    const idOther = d.pushCustomer(["egg", "congee", "soup"]); // 后来（长单）
    d.drop("egg", null);
    for (let k = 0; k < 300 && !d.stations()[3].plate; k++) d.tick(1 / 60);
    const fAbs = abs(idFirst, 8), oAbs = abs(idOther, 9);
    const os = d.orders();
    const fO = os.filter(o => o.id === idFirst)[0], oO = os.filter(o => o.id === idOther)[0];
    A(Math.abs(fAbs - 8) < 0.05 && Math.abs(oAbs - 9) < 0.05, "第一位 8s / 第二位 9s（第一位绝对秒数更少）",
      fAbs + " / " + oAbs);
    A(fO.patience / fO.patienceMax > oO.patience / oO.patienceMax,
      "但第一位的进度条更长（" + (fO.patience / fO.patienceMax).toFixed(2) + " > " +
      (oO.patience / oO.patienceMax).toFixed(2) + "）→ 只比秒数的旧规则会给他");
    A(d.pickFor("egg") === idOther, "新规则给进度条最短的那位（不再「只能给第一位」）",
      "pickFor → #" + d.pickFor("egg") + "（第一位是 #" + idFirst + "）");
    click(cv, center(B.plateBox(3)));
    const got2 = d.orders().filter(o => o.done.indexOf("egg") >= 0).map(o => o.id);
    A(got2.indexOf(idOther) >= 0 && got2.indexOf(idFirst) < 0,
      "真实点盘 → 落在进度条最短那位头上", "拿到煎蛋的是 #" + got2.join("/"));
    G.B.dispose();
  }
}

runMain();
runAudio();          // 音效 / 顾客语音（bf-audio-1）
runBf9();            // bf-9：用户实测后的四条改动


const shots = fs.existsSync(SHOT_DIR) ? fs.readdirSync(SHOT_DIR).filter(f => /^bf_/.test(f)) : [];
const res = {
  success: errors.length === 0,
  testedAt: new Date().toISOString(),
  mode: "node-headless-canvas-stub",
  note: "Chrome / Edge 在当前沙箱一律 mojo platform_channel 0x5（拒绝访问）无法启动；mshta(Trident) 能起进程但落盘被拦。故用 Node + 记录式 Canvas2D + 可泵 rAF 真跑渲染与玩法，作为降级证据链。",
  checks, errors,
  limits: { pixelEvidence: false, screenshotAvailable: shots.length > 0, reason: "像素级截图与 CDP 真实鼠标需要可启动的浏览器；本沙箱不具备（已尝试 Chrome / Edge / mshta）" }
};
fs.writeFileSync(resultsFile("breakfast-headless-results.json"), JSON.stringify(res, null, 1), "utf8");
console.log("[无头渲染验收] 模式=" + res.mode);
checks.forEach(c => console.log("  ✔ " + c));
errors.forEach(e => console.log("  ✖ " + e));
console.log("通过 " + checks.length + "，失败 " + errors.length);
process.exit(errors.length ? 1 : 0);
