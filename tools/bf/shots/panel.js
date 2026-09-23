/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/shots/panel.js — 出图：用自写软件光栅化器回放 breakfast.js 真实发出的 Canvas2D 指令
   产物：测试截图/bf_game.png   放大后的进行中画面（1770×1185，1080p 级别）
        测试截图/bf_pan_window.png 锅内限时起锅特写（起锅窗口 + 倒计时环 + 已糊锅 + 盘占着）
        测试截图/bf_plates.png 灶位 + 专属盘特写（2360×580，其中几盘已备好、一盘糊了）
        测试截图/bf_pass.png   通过结算（含好感变化）
        测试截图/bf_fail.png   失败结算（含好感变化）
   流程：① Node 真跑 breakfast.js（真动画循环）→ 记录式 Canvas2D
        ② 形状交给 tools/lib/raster.js 软件光栅化
        ③ 文字交给 __textHook 收集 → tools/lib/text-compose.ps1 用 System.Drawing + 系统字体（微软雅黑）
           把真汉字合成回 PNG —— 出图里的中文是清楚的系统字体，不是 5×7 点阵/方块。
   运行：node tools/bf/shots/panel.js          （会顺带调用 pwsh 合成文字；失败会提示手动跑）
        pwsh -File tools/lib/text-compose.ps1     （只重跑文字合成）
   ═══════════════════════════════════════════════════════════════════════════ */
const fs = require("fs");
const { resultsFile } = require("../../lib/dist.js");
const path = require("path");
const vm = require("vm");
const { createCanvas } = require("../../lib/raster.js");

const OUT = path.join(__dirname, "..", "..", "..");
const SHOT = path.join(OUT, "测试截图");
const SRC = fs.readFileSync(path.join(OUT, "breakfast.js"), "utf8");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

/* ── 本地食材贴图：真去文件系统读 art/icons/<foodId>.png ──
   breakfast.js 现在会预加载这些 PNG 并 drawImage；出图要看到真图标，
   所以这里给一个 src 一赋值就同步读 PNG 头的 Image 替身
   （自然宽高 = 真文件的 IHDR），像素则交给 tools/lib/raster.js 的 drawImage 现解现合成。 */
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG：" + file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
function resolveImgPath(src) {
  let s = String(src || "");
  if (/^file:\/\//i.test(s)) { s = decodeURIComponent(s.replace(/^file:\/\//i, "")); if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1); }
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\")) return path.normalize(s);
  if (s.startsWith("/")) s = s.slice(1);
  return path.join(OUT, s);
}
function ImageCtorFor() {
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
          this.naturalWidth = sz.w; this.naturalHeight = sz.h; this.width = sz.w; this.height = sz.h; this.complete = true;
          if (typeof this.onload === "function") this.onload({ target: this });
        } else if (typeof this.onerror === "function") this.onerror({ target: this });
      }
    };
    return img;
  };
}

const BITMAP_TEXT = process.argv.indexOf("--bitmap-text") >= 0;   // 兜底：用点阵文字直接出图

/* ── 最小 DOM（只为让 start() 跑起来；玩法与绘制全在 breakfast.js）── */
function makeEl(tag) {
  const e = {
    tagName: String(tag).toUpperCase(), children: [], parentNode: null,
    id: "", className: "", _html: "", textContent: "", type: "", value: "",
    style: {}, dataset: {}, _handlers: {},
    set innerHTML(v) { this._html = String(v); this.children = []; }, get innerHTML() { return this._html; },
    setAttribute(k, v) { if (k === "id") this.id = v; if (k === "class") this.className = v; this[k] = v; },
    getAttribute(k) { return this[k] === undefined ? null : this[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    addEventListener(t, f) { (this._handlers[t] = this._handlers[t] || []).push(f); },
    removeEventListener() {},
    dispatch() {},
    all() { const o = []; (function w(n) { (n.children || []).forEach(c => { o.push(c); w(c); }); })(this); return o; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getContext() { return this._ctx; },
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
  };
  return e;
}

/** 起一局（scale = 位图放大倍数 = devicePixelRatio；bufW/bufH = 位图缓冲区尺寸（逻辑像素），
    用来裁切特写 —— breakfast.js 只认 1180×790 的逻辑画面，缓冲区可以只覆盖要出图的那一块） */
function boot(scale, bufW, bufH) {
  const VW = 1180 * scale, VH = 790 * scale;                    // breakfast.js 眼里的画布尺寸
  const BW = Math.round((bufW || 1180) * scale), BH = Math.round((bufH || 790) * scale);
  const canvas = createCanvas(BW, BH);
  const texts = [];
  if (!BITMAP_TEXT) canvas.__textHook = (t) => texts.push(t);
  const body = makeEl("body");
  const host = makeEl("div"); host.id = "bfGameHost"; body.appendChild(host);
  const frames = [];
  let clock = 0;
  const win = {
    devicePixelRatio: scale,
    performance: { now: () => clock },
    requestAnimationFrame: cb => { frames.push(cb); return frames.length; },
    cancelAnimationFrame: id => { frames[id - 1] = null; },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    document: null,
    Image: ImageCtorFor(),
    /* 贴图按「当前页面目录」解析 → art/icons/<foodId>.png 落到 OUT/art/icons/ */
    location: { href: "file:///" + path.join(OUT, "index.html").replace(/\\/g, "/"), pathname: "/" + path.join(OUT, "index.html").replace(/\\/g, "/") },
  };
  win.document = {
    body, createElement: (tag) => {
      const e = makeEl(tag);
      if (e.tagName === "CANVAS") { e._ctx = canvas; canvas.canvas = e; e.width = VW; e.height = VH; }
      return e;
    },
    getElementById: id => (id === "bfGameHost" ? host : null),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const ctx = vm.createContext(Object.assign(win, { console, Math, Date, isFinite, Number, String, Object, Array }));
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.runInContext(SRC + "\n;globalThis.__BF = window.Breakfast;", ctx);
  function pump(n, ms) {
    for (let i = 0; i < n; i++) {
      clock += (ms === undefined ? 16 : ms);
      const l = frames.slice(); frames.length = 0;
      l.forEach(cb => cb && cb(clock));
      if (!frames.length) break;
    }
  }
  return { B: ctx.__BF, host, pump, canvas, texts, s: scale };
}

/** 推进 d 秒游戏逻辑：step() 内部把单次 dt 夹到 0.5s，所以要按 1/60 小步走 */
function adv(d, seconds) {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n && !d.state().over; i++) d.tick(1 / 60);
}

/** 机器人：看单下料（每样只进自己那一列）+ 锅里熟了**在窗口内点锅起锅** + 单击盘出餐
    （bf-14：熟了不再自动落盘；盘被占就先点盘把旧的送出去）*/
function bot(B, maxSteps) {
  const d = B.debug;
  let guard = 0;
  while (!d.state().over && guard++ < (maxSteps || 5000)) {
    d.stations().forEach((s, i) => {                              // ① 起锅
      if (s.state === "perfect" && s.windowOpen) {
        if (s.plate) { const r = d.serveCol(i); if (!r.ok) d.trash(i); }
        else d.takeOut(i);
      }
    });
    d.stations().forEach((s, i) => {                              // ② 盘上的送出去 / 清掉
      if (s.state === "burnt" || s.plateState === "burnt") { d.trash(i); return; }
      if (s.plate) { const r = d.serveCol(i); if (!r.ok && r.why === "no-want") d.trash(i); }
    });
    for (const c of d.orders()) for (const f of c.order) {        // ③ 看单下料
      if (c.done.indexOf(f) >= 0) continue;
      if (d.stations().some(s => s.food === f)) continue;
      if (d.plates().some(p => p.food === f && p.state !== "burnt")) continue;
      d.drop(f, null);
    }
    for (let n = 0; n < 60 && !d.state().over; n++) {
      d.tick(1 / 60);
      if (d.stations().some(s => s.windowOpen)) break;            // 有锅进起锅窗口了
    }
    if (d.state().over) break;
    d.tick(0.12);
  }
}

/* ── 结算面板（本体是 DOM，这里按同源数据画到画布上，方便一张图看全）── */
function drawPanel(cv, r, B) {
  const V = B.VIEW;
  const px = 150, pw = V.w - 300, py = 150, ph = 470;
  const g = cv;
  g.save();
  g.fillStyle = "rgba(6,4,9,.72)"; g.fillRect(0, 0, V.w, V.h);
  g.fillStyle = "rgba(14,11,22,.98)";
  g.beginPath(); g.rect(px, py, pw, ph); g.fill();
  g.strokeStyle = r.win ? "#5dffa0" : "#ff4d6d"; g.lineWidth = 4;
  g.beginPath(); g.rect(px, py, pw, ph); g.stroke();
  g.textAlign = "left"; g.textBaseline = "middle";
  g.fillStyle = "#ffd76e"; g.font = "bold 40px 'Microsoft YaHei',sans-serif";
  g.fillText(r.win ? "🍳 送出热乎早餐" : "…早餐烧坏了", px + 40, py + 56);
  g.fillStyle = "#cfe8ff"; g.font = "bold 24px 'Microsoft YaHei',sans-serif";
  g.fillStyle = "#a9d8ff";
  g.fillText("顾客：" + (r.quote || ""), px + 40, py + 112);
  const tgt = r.target || { name: "对方", bond: "-" };
  const rows = [
    ["服务顾客", r.served + " / " + r.goal],
    ["完美份数", r.perfect + "（热乎 " + r.hot + "）"],
    ["热乎/温/凉", r.heat.hot + " / " + r.heat.warm + " / " + r.heat.cold],
    ["出餐预备", r.prepped + " 份（9 列专属盘）"],
    ["烧糊份数", String(r.burnt)],
    ["用时", r.elapsed.toFixed(1) + "s / " + r.duration + "s"],
    ["本局得分", String(r.score)],
    [tgt.name + " 好感", (r.bondDelta > 0 ? "+" : "") + r.bondDelta +
      "（" + tgt.bond + " → " + Math.max(0, Math.min(100, Number(tgt.bond) + r.bondDelta)) + "）"],
  ];
  let y = py + 158;
  g.font = "25px 'Microsoft YaHei',sans-serif";
  rows.forEach((kv, i) => {
    const x = px + 40 + (i % 2) * (pw / 2 - 10);
    if (i % 2 === 0) y += 46;
    g.fillStyle = "#b0a08c"; g.fillText(kv[0], x, y);
    g.fillStyle = (i === 7) ? (r.bondDelta > 0 ? "#5dffa0" : "#ff4d6d") : "#ffd76e";
    g.font = "bold 26px 'Microsoft YaHei',sans-serif";
    g.fillText(kv[1], x + 178, y);
    g.font = "25px 'Microsoft YaHei',sans-serif";
  });
  g.fillStyle = "#b0a08c"; g.font = "22px 'Microsoft YaHei',sans-serif";
  g.fillText("📌 " + (r.impact || ""), px + 40, y + 52, pw - 80);
  g.fillStyle = "rgba(176,160,140,.75)"; g.font = "19px 'Microsoft YaHei',sans-serif";
  g.fillText("（结算面板本体是 DOM 弹层；这里按同源 result 数据画到画布上，便于一张图看全）", px + 40, py + ph - 34, pw - 80);
  g.restore();
}

const manifest = [];
function save(cv, name, texts, note) {
  const png = path.join(SHOT, name);
  fs.writeFileSync(png, cv.toPNG());
  manifest.push({ png, texts: texts || [], note: note || "" });
  console.log("  出图 " + name + " · " + fs.statSync(png).size + " 字节 · " + (texts ? texts.length : 0) + " 段文字");
}

/* ══════════ ① 进行中（放大后的整屏 · 1770×1185） ══════════
   局面按用户要求摆：底部 9 个食材桶 → 中列 9 口锅（2 口在烧）→ 上列 9 个专属盘。
   bf-13 盘上永久保鲜：5 个盘上的份盘龄从 0.4s 到 90s，画面上**全部**是「热乎」+
   「∞ 可一直放着」—— 旧图在这里摆的是「热乎 / 温 / 凉 / 糊了」四态 + N.Ns 倒计时，
   那套口径（4.5s 不取就糊）已经不存在了，见 ②b 那张对比图。 */
{
  const SC = 1.5;
  const b = boot(SC);
  b.B.start(b.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 75, goal: 8, onFinish: () => {} });
  const d = b.B.debug;
  adv(d, 4.2);                                        // 逻辑推进（不渲染）：顾客进门、订单卡出来
  /* ① 五列各做一份 → **窗口内点锅起锅** → 落到各自专属盘上（bf-14：不再自动落盘）*/
  d.drop("milk", null); d.drop("sandwich", null); d.drop("salad", null);
  d.drop("bun", null); d.drop("soup", null);
  { let g = 0;
    while (g++ < 900 && d.plates().length < 5) {
      d.stations().forEach(s => { if (s.state === "perfect" && s.windowOpen && !s.plate) d.takeOut(s.i); });
      d.tick(1 / 60);
    } }
  /* ② 一口锅（第 4 列培根）**没人起锅** → 窗口走完自己糊：焦黑锅体 + 红叉 +「糊了 · 双击丢掉」*/
  d.drop("bacon", null);
  { let g = 0; while (g++ < 700 && d.stations()[4].state !== "burnt") d.tick(1 / 60); }
  /* ③ 两口锅正**等在起锅窗口**里（锅上「起锅！点一下这口锅」+ 窗口倒计时环）*/
  d.drop("congee", null); d.drop("egg", null);
  { let g = 0;
    while (g++ < 400 && !(d.stations()[0].state === "perfect" && d.stations()[0].windowOpen &&
                          d.stations()[3].state === "perfect" && d.stations()[3].windowOpen)) d.tick(1 / 60); }
  d.tick(0.55);                                       // 让「熟了 · 起锅！」飘字播完，出图干净
  /* bf-13：盘龄从 0.4s 摆到 90s —— 档位**一个都不掉**（旧口径这里会摆出 温 / 凉，4.5s 后还变糊）*/
  d.setPlateAge(1, 0.4);                              // 热牛奶 → 盘龄 0.4s
  d.setPlateAge(5, 2.2);                              // 三明治 → 盘龄 2.2s
  d.setPlateAge(7, 3.6);                              // 沙拉   → 盘龄 3.6s
  d.setPlateAge(6, 30);                               // 包子   → 盘龄 30s
  d.setPlateAge(2, 90);                               // 清汤   → 盘龄 90s
  b.texts.length = 0;                                  // 只保留最后一帧的文字（否则会把历史帧叠在一起）
  b.pump(1, 16);                                       // 只渲染最后这一帧
  save(b.canvas, "bf_game.png", b.texts,
    "进行中（bf-14）：9 列列对齐 + 盘上 5 份（盘龄 0.4~90s）全部「热乎」+「∞ 可一直放着」+ " +
    "锅里 2 口正等起锅（「恰好 · 起锅 N.Ns」+ 窗口倒计时环）+ 1 口没人起锅已经糊（焦黑 + 红叉 +「糊了 · 双击丢掉」）");
  const st = d.state();
  const pickN = d.stations().filter(s => s.windowOpen).length;
  console.log("    [进行中] 顾客 " + d.orders().length + " 位 · 锅里 " + d.stations().filter(s => s.food).length +
              " 样（等起锅 " + pickN + " · 已糊 " + d.stations().filter(s => s.state === "burnt").length + "）· 盘上 " + d.plates().length + "/9 份 " +
              JSON.stringify(d.plates().map(p => p.food + ":" + (p.state === "burnt" ? "糊" : p.tier) + "@" + p.age + "s")) +
              " · 糊 " + st.burnt + " 份（忘起锅 " + st.expire + "）· 分 " + st.score +
              " · 盘上「内送出」文案 " + b.texts.filter(t => /内送出/.test(t.text)).length + " 处" +
              " · 锅内「起锅」文案 " + b.texts.filter(t => /起锅/.test(t.text)).length + " 处");
}


/* ══════════ ② 列对齐特写（3 列完整竖列 + 标注） ══════════
   取第 3/4/5 列（煎蛋盘 / 培根盘 / 三明治盘）：左边多留一块「注解栏」、上面留标题带、
   下面留操作提示带（缓冲区比画面大，多出来的部分专门写注解）。 */
{
  const SC = 3;
  const CX0 = 13 + 3 * 129, CW = 3 * 129 - 8;            // 第 3~5 列（400 → 779）
  const CY0 = 300, CH = 486;                             // 列头下方 → 食材桶底
  const PAD = 380, TOP = 130, BAND = 162;                // 左注解栏 / 上标题带 / 下提示带（设备像素）
  const b = boot(SC, (CW * SC + PAD) / SC, (TOP + CH * SC + BAND) / SC);
  b.B.start(b.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 999, goal: 9, onFinish: () => {} });
  const d = b.B.debug;
  adv(d, 1.2);
  /* 三列摆出三种状态（bf-14）：煎蛋**等在起锅窗口**、培根**刚起锅落盘**（热乎）、三明治还在烧 */
  d.drop("egg", null); d.drop("bacon", null);
  { let g = 0; while (g++ < 400 && !d.stations()[4].windowOpen) d.tick(1 / 60); }
  d.takeOut(4);                                          // 培根：窗口内点锅 → 起锅落盘（热乎）
  d.drop("sandwich", null);                              // 三明治随后下锅 → 还在烧
  adv(d, 1.05);                                          // 飘字播完（煎蛋那口锅仍在窗口里）
  d.setPlateAge(4, 0.4);                                 // 培根那份 → 热乎档（14 分）
  b.canvas.setTransform(SC, 0, 0, SC, PAD - CX0 * SC, TOP - CY0 * SC);
  b.texts.length = 0;
  b.pump(1, 16);
  /* 画面里落在「注解栏 / 标题带 / 提示带」那几块上的游戏文字要剔掉，否则会盖在注解上
     （文字是最后用系统字体合成上去的，光靠底板盖不住） */
  const W0 = Math.round(CW * SC + PAD), H0 = Math.round(TOP + CH * SC + BAND);
  const keep = b.texts.filter(t => t.x >= PAD - 4 && t.x <= W0 + 4 && t.y >= TOP - 4 && t.y <= TOP + CH * SC + 4);
  b.texts.length = 0; keep.forEach(t => b.texts.push(t));
  /* ── 注解：重置成设备像素坐标后直接画 ── */
  const dx = (lx) => PAD + (lx - CX0) * SC;
  const dy = (ly) => TOP + (ly - CY0) * SC;
  const colC = [3, 4, 5].map(i => dx(13 + i * 129 + 60.5));      // 三列的中心线（设备 x）
  const plateRowY = dy(378), panRowY = dy(529), bucketRowY = dy(694);
  const W = W0, H = H0;
  b.canvas.setTransform(1, 0, 0, 1, 0, 0);
  const put = (t, x, y, px, color, align) => {
    b.canvas.fillStyle = color; b.canvas.font = (px >= 26 ? "bold " : "") + px + "px 'Microsoft YaHei',sans-serif";
    b.canvas.textAlign = align || "left"; b.canvas.textBaseline = "middle";
    b.canvas.fillText(t, x, y);
    b.canvas.textAlign = "left";
  };
  const line = (x1, y1, x2, y2, color, lw) => {
    b.canvas.strokeStyle = color; b.canvas.lineWidth = lw || 3;
    b.canvas.beginPath(); b.canvas.moveTo(x1, y1); b.canvas.lineTo(x2, y2); b.canvas.stroke();
  };
  /* 左侧注解栏底板 */
  b.canvas.fillStyle = "rgba(9,6,11,.97)"; b.canvas.fillRect(0, 0, PAD, H);
  line(PAD - 1, 0, PAD - 1, H, "rgba(255,214,110,.45)", 4);
  /* 三行标签 + 指向三列的引线 */
  put("专属盘", 20, plateRowY - 30, 30, "#ffd76e");
  put("（点一下 → 送给顾客）", 20, plateRowY + 6, 18, "#cfe8ff");
  line(22, plateRowY + 34, PAD + 40, plateRowY + 34, "rgba(255,214,110,.8)", 3);
  put("锅 / 煎盘", 20, panRowY - 30, 30, "#ffd76e");
  put("（点食材 → 自动下锅）", 20, panRowY + 6, 18, "#cfe8ff");
  line(22, panRowY + 34, PAD + 40, panRowY + 34, "rgba(255,214,110,.8)", 3);
  put("食材桶", 20, bucketRowY - 30, 30, "#ffd76e");
  put("（点我下锅）", 20, bucketRowY + 6, 18, "#cfe8ff");
  line(22, bucketRowY + 34, PAD + 40, bucketRowY + 34, "rgba(255,214,110,.8)", 3);
  /* 每列的竖直中心线：证明「食材 / 锅 / 专属盘」同一 x 中心线 */
  colC.forEach(cx => line(cx, TOP + 5, cx, TOP + CH * SC - 5, "rgba(93,255,160,.55)", 2));
  put("同一 x 中心线", PAD + 8, TOP - 26, 22, "#5dffa0");
  /* 顶部标题带 */
  b.canvas.fillStyle = "rgba(9,6,11,.97)"; b.canvas.fillRect(0, 0, W, TOP);
  line(0, TOP - 1, W, TOP - 1, "rgba(255,214,110,.45)", 4);
  put("列对齐：一列 = 食材 ↔ 锅 ↔ 专属盘（三者同一条竖线）", 20, 40, 34, "#ffd76e");
  put("本图取第 3~5 列（煎蛋盘 / 培根盘 / 三明治盘）：底部食材 → 中列锅 → 上列专属盘", 20, 88, 24, "#b0a08c");
  /* 底部操作提示带 */
  const bandY = TOP + CH * SC;
  b.canvas.fillStyle = "rgba(9,6,11,.97)"; b.canvas.fillRect(0, bandY, W, BAND);
  line(0, bandY + 1, W, bandY + 1, "rgba(255,214,110,.45)", 4);
  put("操作：① 点食材 → 自动进它正上方那一列的锅　　② 锅里熟了 → 4.5s 内点一下锅起锅（落到本列专属盘）",
    20, bandY + 48, 27, "#f6efe2");
  put("③ 点专属盘 → 送给正在等的顾客　　④ 双击盘 / 锅 → 丢垃圾桶；盘被占了就只能糊掉，糊了必须双击才清",
    20, bandY + 104, 27, "#5dffa0");
  save(b.canvas, "bf_columns.png", b.texts,
    "特写：3 列完整竖列（食材桶 → 锅 → 专属盘 同一 x 中心线）+ 左侧「专属盘/锅/食材」注解 + 顶部列对齐说明 + 底部三条操作提示");
  console.log("    [列特写] 三列状态 " +
    JSON.stringify(d.stations().slice(3, 6).map(s => s.colFood + ":" + s.state + "/" + (s.plate ? s.plate + "@" + s.tier : "空"))));
}

/* ══════════ ②b 盘上永久保鲜特写（bf-13 · bf_plates_nocountdown.png） ══════════
   用户要求：「帮我修改一下早餐游戏的备用餐盘，就是做好的早餐放旁边的盘子不要有倒计时，
             可以一直放着不会冷掉」。
   这张图专门证明这件事：同一个画面里 9 个专属盘全都有食物，盘龄从 0.4s 摆到 300s，
   画面上**全部**是「食材·热乎」+「∞ 可一直放着」——
   旧口径下同一盘会依次降成「温 / 凉」并显示「4.1s / 2.3s / 0.9s 内送出」，4.5s 之后整个变成糊盘。
   底部注解带把「删掉的旧文案」与「现在真实画出来的文案」并排放在一起，一眼能看出差别；
   最下面一行是本帧的**实测计数**（盘上「内送出」文案 0 处）。 */
{
  const SC = 2.4;                                        // 放大倍数（设备像素 / 逻辑像素）
  const CX0 = 8, CW = 1164;                              // 逻辑 x：9 列盘区（13 .. 1166）
  const CY0 = 320, CH = 140;                             // 逻辑 y：盘带（328..438 的盘 + 两行小字）
  const TOP = 224, BAND = 452;                           // 上标题带 / 下注解带（设备像素）
  /* 上带分四行：标题 / 说明 / 九列「盘龄→档位」/ 每列头顶的盘龄标签（贴在盘带正上方，不与标题压字）*/
  const W0 = Math.round(CW * SC), H0 = TOP + Math.round(CH * SC) + BAND;
  const b = boot(SC, CW, H0 / SC);
  b.B.start(b.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 999, goal: 99, onFinish: () => {} });
  const d = b.B.debug;
  adv(d, 1.2);
  /* 9 列各做一份 → 各自窗口内**点锅起锅** → 9 份全部落到各自的专属盘上（一锅一盘，列对齐）
     （bf-14：熟了不再自动落盘；这一步就是玩家真实要做的操作）*/
  b.B.FOOD_IDS.forEach(function (f) { d.drop(f, null); });
  { let g = 0;
    while (g++ < 1200 && d.plates().length < 9) {
      d.stations().forEach(function (s) { if (s.state === "perfect" && s.windowOpen && !s.plate) d.takeOut(s.i); });
      d.tick(1 / 60);
    } }
  /* 盘龄梯度：0.4s → 300s。旧口径下这张表几乎每一行都会被判「糊掉 / 只能丢」。 */
  adv(d, 1.2);                                           // 让「熟了 · 起锅！」飘字播完，出图干净
  const AGES = [0.4, 2, 3.6, 6, 12, 25, 60, 150, 300];
  AGES.forEach(function (a, i) { d.setPlateAge(i, a); });
  d.tick(1 / 60);
  const TIER_CN = { hot: "热乎", warm: "温", cold: "凉", burnt: "糊" };
  /* 同样的盘龄在**旧口径**下会是什么下场（只用于图中注解，代码里这条曲线已经不再作用于盘上）*/
  const OLD_TIER = { 0.4: "旧：热乎 14 分", 2: "旧：温 10 分", 3.6: "旧：凉 6 分" };
  const byCol = {};
  d.plates().forEach(function (p) { byCol[p.station] = p; });
  const measured = d.plates().map(p => p.food + ":" + p.tier + "@" + p.age + "s").join(" · ");
  /* 用 SC 倍的变换把「盘那一行」铺满整幅图宽 */
  b.canvas.setTransform(SC, 0, 0, SC, -CX0 * SC, TOP - CY0 * SC);
  b.texts.length = 0;
  b.pump(1, 16);
  /* 只保留落在盘带里的游戏文字（顶栏 / 顾客卡 / 食材桶那两行的字会盖住注解带） */
  const keep = b.texts.filter(t => t.x >= -4 && t.x <= W0 + 4 &&
                                   t.y >= TOP - 4 && t.y <= TOP + CH * SC + 4);
  b.texts.length = 0; keep.forEach(t => b.texts.push(t));
  const plateTexts = keep.map(t => t.text);
  const cntTimer = plateTexts.filter(x => /内送出/.test(x)).length;      // 旧口径：每盘 1 处
  const cntKeep = plateTexts.filter(x => /可一直放着/.test(x)).length;
  const cntHot = plateTexts.filter(x => /·热乎/.test(x)).length;
  b.canvas.setTransform(1, 0, 0, 1, 0, 0);
  const W = W0, H = H0;
  const put = (t, x, y, px, color, align, bold) => {
    b.canvas.fillStyle = color;
    b.canvas.font = ((bold === undefined ? px >= 26 : bold) ? "bold " : "") + px + "px 'Microsoft YaHei',sans-serif";
    b.canvas.textAlign = align || "left"; b.canvas.textBaseline = "middle";
    b.canvas.fillText(t, x, y);
    b.canvas.textAlign = "left";
  };
  const box = (x, y, w, h, stroke, fill) => {
    if (fill) { b.canvas.fillStyle = fill; b.canvas.fillRect(x, y, w, h); }
    b.canvas.strokeStyle = stroke; b.canvas.lineWidth = 4;
    b.canvas.strokeRect(x, y, w, h);
  };
  /* ── 每列正上方的盘龄标签（证明档位与盘龄无关）── */
  AGES.forEach(function (a, i) {
    const cx = (13 + i * 129 + 60.5 - CX0) * SC;
    put("盘龄 " + a + "s", cx, TOP - 46, 25, a >= 60 ? "#5dffa0" : "#b0a08c", "center");
    /* 旧口径（heatTierOf 的老曲线：≤1.5s 热乎 14 分 / ≤3.0s 温 10 分 / ≤4.5s 凉 6 分 / >4.5s 糊）*/
    const oldTxt = OLD_TIER[a] || "旧：早就糊了";
    put(oldTxt, cx, TOP - 18, 19, OLD_TIER[a] ? "#8a7a6a" : "#ff4d6d", "center");
  });
  /* ── 顶部标题带 ── */
  b.canvas.fillStyle = "rgba(9,6,11,.97)"; b.canvas.fillRect(0, 0, W, TOP);
  b.canvas.strokeStyle = "rgba(255,214,110,.45)"; b.canvas.lineWidth = 4;
  b.canvas.beginPath(); b.canvas.moveTo(0, TOP - 1); b.canvas.lineTo(W, TOP - 1); b.canvas.stroke();
  put("盘上永久保鲜（bf-13）：餐盘上「没有倒计时」，放多久都不会凉 / 不会糊 / 不会消失", 20, 32, 40, "#ffd76e");
  put("下图是 breakfast.js 真发出的 Canvas2D 指令画出来的盘区：9 个专属盘全都有食物，盘龄 0.4s → 300s，" +
      "档位一律「热乎」，盘下只写静态的「∞ 可一直放着」", 20, 80, 25, "#b0a08c");
  put("九列「盘龄 → 实测档位」：" + AGES.map((a, i) =>
      a + "s→" + (byCol[i] ? (TIER_CN[byCol[i].tier] || byCol[i].tier) : "?")).join("　｜　"),
      20, 124, 24, "#cfe8ff");
  /* ── 底部注解带：旧 / 新并排 ── */
  const bandY = TOP + Math.round(CH * SC);
  b.canvas.fillStyle = "rgba(9,6,11,.97)"; b.canvas.fillRect(0, bandY, W, BAND);
  b.canvas.strokeStyle = "rgba(255,214,110,.45)"; b.canvas.lineWidth = 4;
  b.canvas.beginPath(); b.canvas.moveTo(0, bandY + 1); b.canvas.lineTo(W, bandY + 1); b.canvas.stroke();
  const bx = 24, bw = (W - 72) / 2, by = bandY + 22, bh = 238;
  box(bx, by, bw, bh, "#ff4d6d", "rgba(255,77,109,.07)");
  box(bx + bw + 24, by, bw, bh, "#5dffa0", "rgba(93,255,160,.07)");
  put("旧口径（本次删除）", bx + 22, by + 34, 30, "#ff4d6d");
  put("盘上「煎蛋·热乎」+「4.1s 内送出」", bx + 22, by + 84, 25, "#ffd0d8");
  put("停 1.5s → 「煎蛋·温」+「2.3s 内送出」", bx + 22, by + 122, 25, "#ffd0d8");
  put("停 3.0s → 「煎蛋·凉」+「0.9s 内送出」", bx + 22, by + 160, 25, "#ffd0d8");
  put("停 4.5s → 「煎蛋·糊了」+「只能丢（双击）」（忘取就报废）", bx + 22, by + 198, 25, "#ffd0d8");
  const rx = bx + bw + 46;
  put("新口径（本图真实画面）", rx, by + 34, 30, "#5dffa0");
  put("盘上「煎蛋·热乎」+「∞ 可一直放着」", rx, by + 84, 25, "#d8ffe8");
  put("盘龄 2s / 12s / 60s / 300s → 画面上一个字都不变", rx, by + 122, 25, "#d8ffe8");
  put("上餐恒为最高档 14 分（完美 + 热乎），放 300 秒也一样", rx, by + 160, 25, "#d8ffe8");
  put("不会凉 / 不会糊 / 不会自己消失（盘上那份只有玩家双击才走）", rx, by + 198, 25, "#d8ffe8");
  const codeY = by + bh + 30;
  put("代码口径：plateLeftSec() ≡ Infinity（没有倒计时）· plateBurntAt() / plateExpired() ≡ false（盘上没有过期）· " +
      "盘上不存在 burnt 分支；糊盘唯一的来源是「锅里已经糊了再端上盘」",
      24, codeY, 24, "#cbd6e6");
  put("锅内（bf-14）：生 → 恰好 → **起锅窗口（4.5s，火候暂停）** → 糊。本图这 9 份都是「窗口内点锅起锅」落盘的 —— 不再自动落盘",
      24, codeY + 34, 24, "#cbd6e6");
  put("本帧实测：盘区文字共 " + plateTexts.length + " 段 —— 「内送出」倒计时 " + cntTimer + " 处（旧口径每盘 1 处）· " +
      "「∞ 可一直放着」" + cntKeep + " 处 · 「·热乎」" + cntHot + " 处",
      24, codeY + 70, 26, "#ffd76e");
  put("实测盘上状态：" + measured, 24, codeY + 104, 22, "#a9a2bd");
  put("运行：node tools/bf/shots/panel.js ｜ 画面 = breakfast.js 真发出的 Canvas2D 指令经 tools/lib/raster.js 软件光栅化（非浏览器截图）",
      24, codeY + 134, 22, "#8a8296");
  save(b.canvas, "bf_plates_nocountdown.png", b.texts,
    "盘上无倒计时（bf-13）：9 个专属盘全部有食物、盘龄 0.4~300s，画面全部「食材·热乎」+「∞ 可一直放着」；" +
    "底部并排对照「旧口径的 4.1s/2.3s/0.9s 内送出 → 温 → 凉 → 糊」与「新口径的静态提示」");
  console.log("    [盘上无倒计时] 9 盘 " + measured);
  console.log("    [盘上无倒计时] 盘区文字 " + plateTexts.length + " 段 · 「内送出」" + cntTimer +
              " 处（应为 0）· 「可一直放着」" + cntKeep + " 处（应为 9）· 「·热乎」" + cntHot + " 处（应为 9）");
}
/* ══════════ ②c 锅内限时起锅特写（bf-14 · bf_pan_window.png） ══════════
   用户要求：「锅里熟了要在规定时间内起锅；如果备用餐盘里放着，锅里要起锅的没地方放就只能糊掉；
             想再使用锅，就要双击扔掉里面的食物」。
   同一帧里摆出三种锅内状态（都是 breakfast.js 真跑出来的）：
     · 第 3 列 煎蛋   = **起锅窗口**：绿环 +「起锅！点一下这口锅」+「恰好 · 起锅 N.Ns」倒计时
     · 第 4 列 培根   = 没人起锅 → **已糊**：焦黑锅体 + 红叉 +「糊了 · 双击丢掉」
     · 第 5 列 三明治 = 盘里已经有一份 → 起锅**没地方放**：红字「盘占着 · 没地方放」（窗口还在走）
   底部注解带写清交互与后果，并打出本帧实测计数。 */
{
  const SC = 2.2;
  const CY0 = 312, CH = 312;                             // 逻辑 y：盘带顶（328-16）→ 锅底（608+16）
  const TOP = 210, BAND = 452;                           // 设备像素：上标题带 / 下注解带
  const H0 = TOP + Math.round(CH * SC) + BAND;
  const b = boot(SC, 1180, H0 / SC);
  b.B.start(b.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 999, goal: 99, onFinish: () => {} });
  const d = b.B.debug;
  adv(d, 1.2);
  const calm = () => d.orders().forEach(o => d.setPatience(o.id, 0.99));   // 这一段别让谁跑单（会飘红字）
  /* ① 第 4 列（培根）：下锅后**没人起锅** → 窗口走完自己糊 */
  d.drop("bacon", null);
  { let g = 0; while (g++ < 800 && d.stations()[4].state !== "burnt") { calm(); d.tick(1 / 60); } }
  /* ② 第 5 列（三明治）：先起锅一份进盘 → 再下一份 → 盘占着 → 锅上「盘占着 · 没地方放」*/
  d.drop("sandwich", null);
  { let g = 0; while (g++ < 500 && !d.stations()[5].windowOpen) { calm(); d.tick(1 / 60); } }
  d.takeOut(5);                                          // 第一份 → 专属盘（盘上永久保鲜）
  d.drop("sandwich", null);                              // 第二份接着下锅
  /* ③ 第 3 列（煎蛋）：下锅 → 进起锅窗口（绿环 +「起锅！点一下这口锅」）*/
  d.drop("egg", null);
  { let g = 0;
    while (g++ < 700 && !(d.stations()[5].windowOpen && d.stations()[3].windowOpen)) { calm(); d.tick(1 / 60); } }
  d.tick(0.4);                                           // 让「熟了 · 起锅！」飘字淡掉，画面干净
  const S3 = d.stations()[3], S4 = d.stations()[4], S5 = d.stations()[5];
  const P5 = d.plates().filter(p => p.station === 5)[0];
  /* ── 回放这一帧（只取盘带 + 锅带那一段）── */
  b.canvas.setTransform(SC, 0, 0, SC, 0, TOP - CY0 * SC);
  b.texts.length = 0;
  b.pump(1, 16);
  const W0 = Math.round(1180 * SC);
  const keep = b.texts.filter(t => t.y >= TOP - 4 && t.y <= TOP + CH * SC + 4);
  b.texts.length = 0; keep.forEach(t => b.texts.push(t));
  const panTexts = keep.map(t => t.text);
  /* 文字计数（交叉证据）：注意「盘占着 · 没地方放」在锅上会画**两处**（锅顶小字 + 锅底那行），
     所以图里报「几口锅」必须从 state 读，文字计数只打印到控制台。 */
  const cntPick = panTexts.filter(x => /起锅！点一下这口锅/.test(x)).length;
  const cntRing = panTexts.filter(x => /恰好 · 起锅 \d+\.\d+s/.test(x)).length;
  const cntBurnt = panTexts.filter(x => /糊了 · 双击丢掉/.test(x)).length;
  const cntBlocked = panTexts.filter(x => /盘占着 · 没地方放/.test(x)).length;
  const cntKeep = panTexts.filter(x => /可一直放着/.test(x)).length;
  const stAll = d.stations();
  const nPick = stAll.filter(s => s.picking && !s.blockedByPlate).length;   // 几口锅在起锅窗口里等人点
  const nBlocked = stAll.filter(s => s.blockedByPlate).length;             // 几口锅被盘堵住
  const nBurntPan = stAll.filter(s => s.state === "burnt").length;         // 几口锅糊着
  b.canvas.setTransform(1, 0, 0, 1, 0, 0);
  const W = W0, H = H0;
  const put = (t, x, y, px, color, align, bold) => {
    b.canvas.fillStyle = color;
    b.canvas.font = ((bold === undefined ? px >= 26 : bold) ? "bold " : "") + px + "px 'Microsoft YaHei',sans-serif";
    b.canvas.textAlign = align || "left"; b.canvas.textBaseline = "middle";
    b.canvas.fillText(t, x, y);
    b.canvas.textAlign = "left";
  };
  /* ── 顶部标题带（4 行）── */
  b.canvas.fillStyle = "rgba(9,6,11,.97)"; b.canvas.fillRect(0, 0, W, TOP);
  b.canvas.strokeStyle = "rgba(255,214,110,.45)"; b.canvas.lineWidth = 4;
  b.canvas.beginPath(); b.canvas.moveTo(0, TOP - 1); b.canvas.lineTo(W, TOP - 1); b.canvas.stroke();
  put("锅内限时起锅（bf-14）：锅里熟了要在 4.5s 内点一下锅起锅；盘被占了就只能糊掉", 20, 34, 40, "#ffd76e");
  put("下图是 breakfast.js 真发出的 Canvas2D 指令画出来的盘区 + 锅区（同一帧里的三种锅内状态）", 20, 84, 26, "#b0a08c");
  put("① 第 3 列 煎蛋 = 起锅窗口（绿环 + 倒计时）　② 第 4 列 培根 = 没人起锅 → 已糊（焦黑 + 红叉）　" +
      "③ 第 5 列 三明治 = 盘里已有一份 →「盘占着 · 没地方放」", 20, 128, 24, "#cfe8ff");
  put("窗口内**火候暂停**：这 4.5 秒是玩家真正能用的时间（否则会被 0.6~1.0s 的完美窗口提前吃掉）",
      20, 166, 23, "#a9a2bd");
  /* ── 底部注解带（交互表 + 后果 + 实测）── */
  const bandY = TOP + Math.round(CH * SC);
  b.canvas.fillStyle = "rgba(9,6,11,.97)"; b.canvas.fillRect(0, bandY, W, BAND);
  b.canvas.strokeStyle = "rgba(255,214,110,.45)"; b.canvas.lineWidth = 4;
  b.canvas.beginPath(); b.canvas.moveTo(0, bandY + 1); b.canvas.lineTo(W, bandY + 1); b.canvas.stroke();
  put("交互（一句话）：单击锅 = 起锅（落进该列专属盘）｜ 单击盘 = 送给耐心最少的顾客 ｜ 双击锅 / 盘 = 丢垃圾桶（不扣分）",
      24, bandY + 44, 28, "#f6efe2");
  put("盘被占了 → 起锅被拒（plate-occupied，提示「盘里还有一份，先送出去」），**窗口继续走** → 走完就糊；" +
      "糊了口锅被占死（下料被拒 station-occupied），**必须双击丢掉**才能再用（糊残骸不再自动消失）",
      24, bandY + 92, 26, "#ffd0d8");
  put("盘上永久保鲜（bf-13 保持不变）：不会凉 / 不会糊 / 不会消失，盘下永远写着「∞ 可一直放着」——" +
      " 压力只在锅里，不在盘上", 24, bandY + 136, 26, "#d8ffe8");
  put("本帧实测：等着起锅 " + nPick + " 口（煎蛋剩 " + (S3.serveWin || 0).toFixed(1) + "s）· 已糊 " + nBurntPan +
      " 口（培根 · burnt=" + d.state().burnt + "）· 盘占着没地方放 " + nBlocked + " 口（三明治）· " +
      "盘上保鲜 " + cntKeep + " 份（三明治·热乎 ·「∞ 可一直放着」）",
      24, bandY + 186, 26, "#ffd76e");
  put("对照：旧口径（bf-13）默认「一到恰好就自动落盘」，锅内窗口恒不触发 —— 本图这一天起，锅里必须由玩家起锅",
      24, bandY + 228, 24, "#cbd6e6");
  put("运行：node tools/bf/shots/panel.js ｜ 画面 = breakfast.js 真发出的 Canvas2D 指令经 tools/lib/raster.js 软件光栅化（非浏览器截图）",
      24, bandY + 268, 22, "#8a8296");
  save(b.canvas, "bf_pan_window.png", b.texts,
    "锅内限时起锅（bf-14）：同一帧三种锅内状态 —— 起锅窗口（绿环 + 起锅提示 + 倒计时）/ 没人起锅已糊（焦黑 + 红叉 + 双击丢掉）/" +
    "盘占着没地方放（红字，窗口继续走）；底部写清单击 / 双击各做什么与后果");
  console.log("    [锅内起锅] 等着起锅 " + nPick + " 口 · 已糊 " + nBurntPan + " 口 · 盘占着 " + nBlocked + " 口 · burnt=" + d.state().burnt +
              "（文字证据：起锅提示 " + cntPick + " 处 · 倒计时 " + cntRing + " 处 · 糊了 " + cntBurnt +
              " 处 · 没地方放 " + cntBlocked + " 处 · 可一直放着 " + cntKeep + " 处）");
  console.log("    [锅内起锅] 第三列 " + S3.state + " 剩 " + (S3.serveWin || 0).toFixed(2) + "s / 第四列 " + S4.state +
              " / 第五列 " + S5.state + " 盘=" + (P5 ? P5.food + "@" + P5.tier : "空"));
}

/* ══════════ ③ 通过结算 ══════════ */
{
  const b = boot(1.5);
  let res = null;
  b.B.start(b.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 75, goal: 8, onFinish: r => { res = r; } });
  bot(b.B);
  b.texts.length = 0;
  b.pump(1, 16);
  const st = b.B.debug.state();
  if (!st.win) throw new Error("通过路径没跑成（win=" + st.win + "）");
  b.texts.length = 0;                                 // 面板是弹层：只合成面板自己的文字
  drawPanel(b.canvas, st.result, b.B);
  save(b.canvas, "bf_pass.png", b.texts, "通过结算：服务满 8 位 + 好感上升 + 热乎度分布");
  console.log("    [通过] served=" + st.served + "/" + st.goal + " · 完美 " + st.perfect + " · 糊 " + st.burnt +
              " · 热乎度 " + JSON.stringify(st.result.heat) + " · 好感 +" + st.result.bondDelta);
}

/* ══════════ ④ 失败结算 ══════════ */
{
  const b = boot(1.5);
  b.B.start(b.host, { target: { id: "guo", name: "陈果", bond: 30 }, duration: 30, goal: 8, onFinish: () => {} });
  const d = b.B.debug;
  // 一边手忙脚乱做一点、一边让顾客等到走：失败但做出过东西（−3~−6 不虐主）
  d.drop("egg", null); d.drop("bacon", null); d.drop("congee", null);
  let g2 = 0;
  while (!d.state().over && g2++ < 30000) d.tick(0.2);
  const st = d.state();
  if (st.win !== false) throw new Error("失败路径没跑成");
  b.texts.length = 0;
  b.pump(1, 16);
  b.texts.length = 0;                                 // 面板是弹层：只合成面板自己的文字
  drawPanel(b.canvas, st.result, b.B);
  save(b.canvas, "bf_fail.png", b.texts, "失败结算：跑单/糊掉 + 好感下降（仍在 −3~−6 的台阶内）");
  console.log("    [失败] served=" + st.served + " · 糊 " + st.burnt + " · 跑单 " + st.angry +
              " · 好感 " + st.result.bondDelta + " · " + st.reason);
}

/* ══════════ ⑤ 结算出口可见性：整屏 1440×900（证明「收下早餐 · 继续」在视口里） ══════════
   断点是「1440×900 窗口里 顶栏 + 1180×790 等比画布 已经把面板撑出视口，结算面板排在画布下面
   → 被裁掉，没有任何出口」。这张图按同一档视口出整屏：
     ① 真跑 breakfast.js 打到通过 → 真 Canvas2D 回放画进「舞台区」
     ② 面板 / 结算面板 / 出口按钮的盒子按 index.html 里**真实生效的 CSS** 摆：
        #bfGameHost max-height:calc(100vh-20px)=880 居中 → .bf-result sticky bottom:0 贴底 →
        .bf-row sticky bottom:0 → 按钮永远落在面板可见底边内侧
     ③ 标出视口边界、按钮底边 y 值、以及与视口底的距离 —— 一眼能看出按钮没被裁在下面
   注：盒子位置由 CSS 推导（本沙箱起不了浏览器，没有 layout engine）；图里的游戏画面与按钮文案
       都是 breakfast.js 真跑出来的，不是画的示意图。 */
{
  const SC = 1.5;                                   // 设备像素 / CSS 像素
  const VW = 1440, VH = 900;                        // 用户实测的窗口档位
  const BAND = 200;                                 // 视口下方注解带（在视口之外，不遮挡整屏）
  const HTML_S = fs.readFileSync(path.join(OUT, "index.html"), "utf8");
  const STYLE_S = (HTML_S.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1];
  const rule = (sel) => { const i = STYLE_S.indexOf(sel + "{"); return i < 0 ? "" : STYLE_S.slice(i + sel.length + 1, STYLE_S.indexOf("}", i)); };
  const vhCalc = (decl) => { const m = /max-height:\s*calc\(100vh\s*-\s*(\d+)px\)/.exec(decl || ""); return m ? VH - Number(m[1]) : null; };
  const panelDecl = rule("#bfGame .panel.bf-panel.bf-game-panel");
  const resDecl = rule(".bf-result");
  const rowDecl = rule(".bf-result .bf-row");
  const goDecl = rule("#bfGo");

  const b = boot(SC, VW, VH + BAND);                 // 缓冲区 = 整屏 + 注解带
  let res = null;
  b.B.start(b.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 75, goal: 8, onFinish: r => { res = r; } });
  bot(b.B);
  const st = b.B.debug.state();
  if (!st.win) throw new Error("结算出口出图：通过路径没跑成（win=" + st.win + "）");

  /* ── 面板盒子（真实 CSS 推导）── */
  const padX = 14, padTop = 12, padBot = 14, border = 1;
  const panelW = Math.min(1180, VW * 0.96);
  const panelMaxH = vhCalc(panelDecl);               // 880
  const resultMaxH = vhCalc(resDecl);                // 860
  const contentW = panelW - padX * 2 - border * 2;   // 1150
  const stageH = 790 * contentW / 1180;              // 画布等比放大后的高度 770
  const barH = 48;                                   // 顶栏（标题 22px + 提示 + 收摊按钮）
  /* 结算面板内容高度：按 CSS 字号 / 行高 / 内边距逐行累加 */
  const R = st.result;
  const kv = [
    ["服务顾客", R.served + " / " + R.goal],
    ["完美份数", String(R.perfect) + (R.hot ? ("（热乎 " + R.hot + "）") : "")],
    ["热乎度", "热乎 " + R.heat.hot + " · 温 " + R.heat.warm + " · 凉 " + R.heat.cold],
    ["出餐预备", R.prepped + " 份（9 列专属盘 ×" + R.platesTotal + "）"],
    ["烧糊份数", String(R.burnt) + (R.expire ? ("（忘起锅 " + R.expire + "）") : "")],
    ["用时", R.elapsed.toFixed(1) + "s / " + R.duration + "s"],
    ["本局得分", String(R.score)],
    [R.target.name + " 好感", (R.bondDelta > 0 ? "+" : "") + R.bondDelta],
  ];
  const gridCols = Math.max(1, Math.floor((contentW + 22) / (250 + 22)));   // .bf-grid auto-fit minmax(250px,1fr) gap 22
  const gridRows = Math.ceil(kv.length / gridCols);
  let resContentH = 16;
  resContentH += Math.round(24 * 1.2) + 6;                                   // h3
  resContentH += Math.round(17 * 1.85) + 6 + 12;                             // .bf-q（一行）
  resContentH += gridRows * (Math.round(17 * 1.4) + 10) + 12;                // .bf-kv ×行
  resContentH += Math.round(16 * 1.9) + 10;                                  // 📌 本局影响（一行）
  resContentH += Math.round(16 * 1.9) * 2 + 10;                              // 🎯 接下来（两行）
  resContentH += 4 + 12 + 46 + 2;                                            // .bf-row margin/padding/按钮
  resContentH += 16;
  const resultH = Math.min(resultMaxH, resContentH);
  const panelContentH = padTop + barH + 8 + stageH + 8 + resultH + padBot;
  const panelH = Math.min(panelMaxH, panelContentH);
  const panelX = Math.round((VW - panelW) / 2), panelY = Math.round((VH - panelH) / 2);
  const resultBottom = panelY + panelH - border - padBot;
  const resultTop = resultBottom - resultH;
  const resultX = panelX + border + padX, resultW = contentW;
  const rowBottom = resultBottom - 16;                                     // .bf-result padding-bottom:16px
  const btnBottom = rowBottom - 2;                                          // .bf-row padding-bottom:2px
  const btnFont = 18, btnPadY = 12, btnPadX = 28;
  const btnH = btnPadY * 2 + Math.round(btnFont * 1.2);

  /* ── 先画游戏画面（真回放）到舞台区；泵这一帧同时把结算面板填上 ── */
  const stageX = panelX + border + padX, stageY = panelY + border + padTop + barH + 8;
  const gs = SC * contentW / 1180;
  b.texts.length = 0;
  b.canvas.setTransform(gs, 0, 0, gs, stageX * SC, stageY * SC);
  b.pump(1, 16);                                     // 画最后一帧（结算那一帧）+ showResult()
  /* 文字是最后用系统字体合成上去的（底板盖不住文字）：结算面板会盖住画面下半部分，
     落在那里的游戏文字必须剔掉，否则会浮在结算面板上面。 */
  const keep = b.texts.filter(t => t.y < (resultTop - 2) * SC);
  b.texts.length = 0; keep.forEach(t => b.texts.push(t));
  /* 真结算面板已经在 host 里：出口按钮文案直接读模块真建的节点（不是图里另写的） */
  const wrapEl = b.host.children[0];
  const panelEl = wrapEl.children[2];
  const rowEl = panelEl.children[panelEl.children.length - 1];
  const goEl = rowEl.children[rowEl.children.length - 1];
  const goText = goEl.textContent;                   // 「收下早餐 · 继续」
  const escText = rowEl.children[0].textContent;     // ESC 提示
  const btnW = btnPadX * 2 + Math.round(goText.replace(/\s/g, "").length * btnFont * 0.92);
  const btnX = resultX + resultW - 18 - btnW, btnY = btnBottom - btnH;

  /* ── 再画整屏外壳 / 面板 / 结算面板 / 出口按钮（设备像素） ── */
  const g = b.canvas;
  g.setTransform(1, 0, 0, 1, 0, 0);
  const d = (v) => Math.round(v * SC);
  const put = (t, x, y, px, color, align, bold) => {
    g.fillStyle = color;
    g.font = ((bold === undefined ? px >= 26 : bold) ? "bold " : "") + Math.round(px) + "px 'Microsoft YaHei',sans-serif";
    g.textAlign = align || "left"; g.textBaseline = "middle";
    g.fillText(t, x, y); g.textAlign = "left";
  };
  const box = (x, y, w2, h2, fill, stroke, lw) => {
    if (fill) { g.fillStyle = fill; g.fillRect(x, y, w2, h2); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 2; g.beginPath(); g.rect(x, y, w2, h2); g.stroke(); }
  };
  /* 页面底 + 覆盖层蒙版（.overlay 的 rgba(4,3,8,.72)） */
  box(0, 0, d(VW), d(VH), "#060409", null);
  box(0, 0, d(VW), d(VH), "rgba(4,3,8,.72)", null);
  /* 游戏面板（.panel: rgba(14,12,22,.96) + 1px var(--line)） */
  box(d(panelX), d(panelY), d(panelW), d(panelH), "rgba(14,12,22,.96)", "rgba(120,110,160,.45)", Math.max(1, d(1)));
  /* 顶栏：标题 + 提示 + 收 摊 */
  g.save(); g.beginPath(); g.rect(d(panelX + border), d(stageY - barH - 8), d(contentW), d(barH + 8)); g.clip();
  put("🍳 早餐店 · 拼手速　→ 苏晚晴", d(stageX), d(panelY + border + padTop + 14), d(22), "#ffd76e", "left", true);
  put("① 点食材 → 自动进它正上方那一列的锅　② 点上方专属盘 → 自动送给正在等的顾客　③ 双击盘 → 丢垃圾桶",
      d(stageX), d(panelY + border + padTop + 38), d(15), "#a9a2bd", "left", false);
  box(d(panelX + panelW - padX - 96), d(panelY + border + padTop + 6), d(96), d(34), "rgba(255,214,110,.08)", "rgba(255,214,110,.45)", Math.max(1, d(1)));
  put("收 摊", d(panelX + panelW - padX - 48), d(panelY + border + padTop + 23), d(16), "#ffd76e", "center", false);
  g.restore();
  /* 结算面板（sticky 贴底）+ 内容 */
  box(d(resultX), d(resultTop), d(resultW), d(resultH), "rgba(12,9,18,.94)", R.win ? "rgba(93,255,160,.55)" : "rgba(255,77,109,.55)", Math.max(2, d(2)));
  let cy = resultTop + 16;
  put("🍳 送出热乎早餐", d(resultX + 18), d(cy + 14), d(24), "#ffd76e", "left", true);
  cy += Math.round(24 * 1.2) + 6;
  put(R.quote, d(resultX + 18), d(cy + 16), d(17), "#e8e2f2", "left", false);
  cy += Math.round(17 * 1.85) + 6 + 12;
  for (let i = 0; i < kv.length; i++) {
    const col = i % gridCols, rowI = Math.floor(i / gridCols);
    const cw = contentW / gridCols, x = resultX + 18 + col * cw, y = cy + rowI * (Math.round(17 * 1.4) + 10) + 5;
    put(kv[i][0], d(x), d(y + 10), d(17), "#a9a2bd", "left", false);
    put(String(kv[i][1]), d(x + cw - 22), d(y + 10), d(18), i === 7 ? (R.bondDelta > 0 ? "#5dffa0" : "#ff4d6d") : "#ffd76e", "right", true);
    g.strokeStyle = "rgba(120,110,160,.35)"; g.lineWidth = Math.max(1, d(1));
    g.beginPath(); g.moveTo(d(x), d(y + 20)); g.lineTo(d(x + cw - 22), d(y + 20)); g.stroke();
  }
  cy += gridRows * (Math.round(17 * 1.4) + 10) + 12;
  put("📌 本局影响 · " + R.impact, d(resultX + 18), d(cy + 15), d(16), "#a9a2bd", "left", false);
  cy += Math.round(16 * 1.9) + 10;
  put("🎯 接下来 · " + R.quota, d(resultX + 18), d(cy + 15), d(16), "#a9a2bd", "left", false);
  cy += Math.round(16 * 1.9) * 2 + 10;
  /* 出口那一行：sticky bottom:0（渐变底 + ESC 提示 + 按钮） */
  const rowTop = rowBottom - (12 + btnH + 2);
  const grad = g.createLinearGradient(0, d(rowTop), 0, d(rowBottom));
  grad.addColorStop(0, "rgba(12,9,18,0)"); grad.addColorStop(0.45, "rgba(12,9,18,.97)"); grad.addColorStop(1, "rgba(12,9,18,.97)");
  box(d(resultX), d(rowTop), d(resultW), d(rowBottom - rowTop), grad, null);
  put(escText, d(resultX + 18), d(btnY + btnH / 2), d(14), "#a9a2bd", "left", false);
  box(d(btnX), d(btnY), d(btnW), d(btnH), "rgba(93,255,160,.10)", "rgba(93,255,160,.75)", Math.max(2, d(1.5)));
  put(goText, d(btnX + btnW / 2), d(btnY + btnH / 2), d(btnFont), "#5dffa0", "center", true);
  /* ── 视口内的标记：红框圈出出口按钮（其余说明放在视口下方的注解带） ── */
  g.setLineDash([d(8), d(6)]);
  g.strokeStyle = "#ff4d6d"; g.lineWidth = Math.max(2, d(2));
  g.beginPath(); g.rect(d(btnX - 6), d(btnY - 6), d(btnW + 12), d(btnH + 12)); g.stroke();
  g.setLineDash([]);
  /* 视口边框（整屏边界 = 浏览器视口边界） */
  g.strokeStyle = "rgba(255,255,255,.5)"; g.lineWidth = Math.max(2, d(2));
  g.beginPath(); g.rect(d(1), d(1), d(VW) - d(2), d(VH) - d(2)); g.stroke();
  /* 按钮底边 → 视口底边 的余量标尺 */
  g.strokeStyle = "#5dffa0"; g.lineWidth = Math.max(1, d(1));
  g.beginPath(); g.moveTo(d(VW) - d(56), d(btnBottom)); g.lineTo(d(VW) - d(56), d(VH)); g.stroke();
  g.beginPath(); g.moveTo(d(VW) - d(62), d(btnBottom)); g.lineTo(d(VW) - d(50), d(btnBottom)); g.stroke();
  g.beginPath(); g.moveTo(d(VW) - d(62), d(VH)); g.lineTo(d(VW) - d(50), d(VH)); g.stroke();

  /* ── 视口下方注解带：整屏之外，写明每一条 CSS 兜底与实测 y 值 ── */
  const bandTop = d(VH);
  box(0, bandTop, d(VW), d(BAND), "#0b0912", null);
  box(0, bandTop, d(VW), Math.max(2, d(2)), "#ffd76e", null);
  put("▲ 以上 = 浏览器视口 " + VW + "×" + VH + "（CSS px，整屏截图；视口里除了红框没有任何注解）",
      d(20), bandTop + d(26), d(20), "#ffd76e", "left", true);
  put("· 面板 #bfGameHost：max-height:calc(100vh - 20px) = " + panelMaxH + " → 居中在 y " + panelY + " ~ " + (panelY + panelH) + "（内部可滚，画布再高也不会把出口挤出视口）",
      d(20), bandTop + d(56), d(17), "#cbd6e6", "left", false);
  put("· 结算面板 .bf-result：max-height:calc(100vh - 40px) = " + resultMaxH + " + overflow-y:auto + position:sticky;bottom:0 → 钉在面板可见底边 y " + resultTop + " ~ " + resultBottom,
      d(20), bandTop + d(82), d(17), "#cbd6e6", "left", false);
  put("· 出口那一行 .bf-row：position:sticky;bottom:0 → 按钮「" + goText + "」底边 y = " + btnBottom + " ≤ 视口 " + VH + "（距视口底还有 " + (VH - btnBottom) + " px；红框 = 按钮真实位置）",
      d(20), bandTop + d(108), d(17), "#5dffa0", "left", false);
  put("· 断点根因：原来 .bf-result 排在 1180×790 等比放大的画布下面，.panel 没有 max-height / 内滚 → 1440×900 下整块被裁在视口外，按钮与 onFinish 都够不到",
      d(20), bandTop + d(134), d(17), "#ff9ec7", "left", false);
  put("· 画面：真跑 breakfast.js 打到通过后的最后一帧（软件光栅化回放）+ 真结算面板内容；按钮文案直接读模块真建的 #bfGo 节点",
      d(20), bandTop + d(160), d(17), "#a9a2bd", "left", false);
  save(b.canvas, "bf_result_exit.png", b.texts,
    "结算出口可见性：1440×900 整屏 + 面板 max-height/sticky 的真实 CSS 推导 + 真回放的游戏画面；红框 = #bfGo「" + goText + "」按钮，底边 y=" + btnBottom + " ≤ 900");
  console.log("    [结算出口] 面板 y " + panelY + "~" + (panelY + panelH) + "（max " + panelMaxH + "）· 结算面板 y " +
              resultTop + "~" + resultBottom + " · 按钮底边 y=" + btnBottom + " ≤ 视口 " + VH +
              " · 按钮文案「" + goText + "」");
}

fs.writeFileSync(resultsFile("bf_shots_text.json"),
  JSON.stringify({ at: new Date().toISOString(), shots: manifest }, null, 1), "utf8");
fs.writeFileSync(resultsFile("breakfast-shots.json"),
  JSON.stringify({
    at: new Date().toISOString(),
    mode: BITMAP_TEXT ? "software-raster-replay+bitmap-text" : "software-raster-replay+system-font-text",
    note: "非浏览器截图：把 breakfast.js 真发出的 Canvas2D 指令在 Node 里光栅化；文字由 tools/lib/text-compose.ps1 用系统字体（微软雅黑）合成",
    files: manifest.map(m => ({ png: path.basename(m.png), note: m.note, texts: m.texts.length })),
  }, null, 1), "utf8");
console.log("[出图完成] " + manifest.length + " 张 → " + SHOT);
if (!BITMAP_TEXT) {
  const { spawnSync } = require("child_process");
  const ps = path.join(OUT, "tools/lib/text-compose.ps1");
  let r = spawnSync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps], { stdio: "inherit" });
  if (r.error || r.status !== 0) r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps], { stdio: "inherit" });
  if (r.error || r.status !== 0) {
    console.log("[文字合成] 调用 PowerShell 失败(" + ((r.error && r.error.message) || ("exit " + r.status)) +
                ") → 请手动执行：powershell -File tools/lib/text-compose.ps1（或 node tools/bf/shots/panel.js --bitmap-text 用点阵字兜底）");
  }
}
