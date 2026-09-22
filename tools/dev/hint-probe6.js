/* 探针 6：真牌局快进，人类每个回合逐项对拍（听牌保护 / 建议 vs 更优解 / 面板 vs 金框 vs hint）
   运行：node tools/dev/hint-probe6.js */
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "mahjong.js"), "utf8");
const ID_MAP = new Map(), VOID_TAGS = { br: 1, hr: 1, img: 1, input: 1, meta: 1, link: 1 };
function regIds(el) { if (!el || typeof el !== "object") return; if (el.id) ID_MAP.set(el.id, el); if (el.childNodes) for (const c of el.childNodes) regIds(c); }
function unregIds(el) { if (!el || typeof el !== "object") return; if (el.childNodes) for (const c of el.childNodes) unregIds(c); }
function makeElement(tag) {
  const e = { tagName: String(tag || "div").toUpperCase(), id: "", className: "", style: {}, dataset: {}, childNodes: [], children: [], _html: "", _text: "", parentNode: null,
    classList: { _s: new Set(), add() { for (const a of arguments) this._s.add(a); }, remove() { for (const a of arguments) this._s.delete(a); }, contains(c) { return this._s.has(c); }, toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); this.children.push(c); this._html = ""; regIds(c); return c; },
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) { this.childNodes.splice(i, 1); this.children.splice(i, 1); } unregIds(c); return c; },
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { left: 10, top: 20, width: 1180, height: 818 }; },
    getContext() { const noop = () => {}; return { setTransform: noop, clearRect: noop, fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, arc: noop, ellipse: noop, fill: noop, stroke: noop, save: noop, restore: noop, clip: noop, translate: noop, scale: noop, rotate: noop, quadraticCurveTo: noop, closePath: noop, fillText: noop, strokeText: noop, drawImage: noop, putImageData: noop, getImageData: () => ({ data: [] }), createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }), createPattern: () => null, measureText: () => ({ width: 8 }), set fillStyle(v) {}, set strokeStyle(v) {}, set font(v) {}, set lineWidth(v) {}, set shadowColor(v) {}, set shadowBlur(v) {}, set textAlign(v) {}, set textBaseline(v) {}, set lineCap(v) {}, set lineJoin(v) {}, set globalAlpha(v) {} }; },
    querySelector() { return null; }, querySelectorAll() { return []; } };
  e._sync = function () { if (this._html || !this.childNodes.length) return this._html; let s = ""; for (const c of this.childNodes) { const t = c.tagName.toLowerCase(); s += "<" + t + (c.id ? ' id="' + c.id + '"' : "") + ">" + c._sync() + (VOID_TAGS[t] ? "" : "</" + t + ">"); } return s; };
  Object.defineProperty(e, "innerHTML", { get() { return this._sync(); }, set(v) { unregIds(this); this.childNodes = []; this.children = []; this._html = String(v == null ? "" : v); parseIds(this._html, this); ensureIds(this._html); }, configurable: true });
  Object.defineProperty(e, "textContent", { get() { return this._text || this._sync().replace(/<[^>]*>/g, ""); }, set(v) { this._text = String(v == null ? "" : v); }, configurable: true });
  Object.defineProperty(e, "lastChild", { get() { return this.childNodes[this.childNodes.length - 1] || null; }, configurable: true });
  return e;
}
function parseIds(html) { const re = /<([a-zA-Z][\w-]*)([^>]*)>/g; let m; while ((m = re.exec(html))) { const idm = /id\s*=\s*"([^"]*)"/.exec(m[2]); if (!idm || !idm[1]) continue; const el = makeElement(m[1]); el.id = idm[1]; const cm = /class\s*=\s*"([^"]*)"/.exec(m[2]); if (cm) el.className = cm[1]; ID_MAP.set(el.id, el); } }
const HTML_IDS = new Map();
function ensureIds(html) { const re = /id\s*=\s*"([^"]+)"/g; let m; while ((m = re.exec(html))) if (!HTML_IDS.has(m[1])) HTML_IDS.set(m[1], makeElement("div")); }
const documentStub = { createElement: makeElement, getElementById(id) { return ID_MAP.get(id) || HTML_IDS.get(id) || null; }, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, head: makeElement("head"), body: makeElement("body") };
const windowStub = { setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {}, console, Math, Date, JSON, devicePixelRatio: 1, document: documentStub, innerWidth: 1280, innerHeight: 900, AudioSys: { blip() {}, click() {}, ding() {}, good() {}, bad() {} } };
windowStub.window = windowStub;
const ctx = vm.createContext(windowStub);
vm.runInContext(SRC, ctx, { filename: "mahjong.js" });
const MJ = ctx.Mahjong, T = MJ.test;
const sortT = a => a.slice().sort(T.cmpTile);
const rm = (h, t) => { const o = h.slice(), i = o.indexOf(t); if (i < 0) return null; o.splice(i, 1); return o; };
const cIn = (h, t) => h.filter(x => x === t).length;
const SUIT_MAP = { m: "万", s: "条", p: "筒" };
function P(s) { const out = []; for (const part of String(s).split(/\s+/)) { if (!part) continue; const m = /^([0-9]+)([msp])$/.exec(part); if (m) { for (const ch of m[1]) out.push(ch + SUIT_MAP[m[2]]); continue; } const m2 = /^([1-9])([万条筒])$/.exec(part); if (m2) { out.push(part); continue; } for (const ch of part) out.push(ch); } return out; }

function seenOf(E, seat) {
  const s = {};
  for (let i = 0; i < 4; i++) { const p = E.P[i];
    if (i !== seat) for (const t of p.discards) s[t] = (s[t] || 0) + 1;
    for (const m of p.melds) for (const t of m.tiles) s[t] = (s[t] || 0) + 1; }
  return s;
}

let stat = { turns: 0, tenpai: 0, broke: 0, dead: 0, worse: 0, uiBad: 0, stale: 0, slow: 0, worstMs: 0 };
const ex = { broke: [], dead: [], worse: [], ui: [], stale: [] };

const GAMES = Number(process.argv[2] || 3);
for (let game = 0; game < GAMES; game++) {
  if (game === 0) MJ.start(makeElement("div"), {}); else { MJ.dispose(); MJ.start(makeElement("div"), {}); }
  const E = MJ.debug.engine();
  process.stdout.write("  [对局 " + (game + 1) + "/" + GAMES + "] 回合 " + stat.turns + " 已听 " + stat.tenpai + " 破听 " + stat.broke + " 听口差 " + stat.worse + " UI " + stat.uiBad + "\n");
  for (let step = 0; step < 4000; step++) {
    const r = MJ.debug.step();
    if (r === "over" || !r) break;
    const p = E.P[0];
    if (E.phase === "claim" && E.pending && E.pending.seat === 0) { MJ.debug.act("pass"); continue; }
    if (E.phase === "rob" && E.pending && E.pending.seats.indexOf(0) >= 0) { MJ.debug.act("pass"); continue; }
    if (!(E.phase === "turn" && E.cur === 0 && p.hand.length % 3 === 2)) continue;
    // —— 人类回合：真实引擎状态 ——
    const drawn = (p.drawn !== null && p.drawn !== undefined) ? p.drawn : null;
    const base13 = drawn !== null ? rm(p.hand, drawn) : p.hand.slice();
    const w0 = T.waitsFor(base13, p.melds, E.honors);
    const seen = seenOf(E, 0);
    const t0 = Date.now();
    const h = MJ.debug.hintNow();
    const ms = Date.now() - t0;
    if (ms > stat.worstMs) stat.worstMs = ms;
    if (ms > 100) stat.slow++;
    const bt = MJ.debug.brainText();
    const rects = MJ.debug.handRects();
    stat.turns++;
    if (!h) continue;
    // ① UI 一致（此刻 hintNow 已刷新面板 + 金框；rects 是上一帧的摆放）
    const markTile = rects[bt.hintIdx] ? rects[bt.hintIdx].tile : "(越界)";
    if (bt.panel.indexOf("打 " + h.discard) < 0 || markTile !== h.discard) {
      stat.uiBad++;
      if (ex.ui.length < 6) ex.ui.push("面板=" + bt.panel.replace(/<[^>]*>/g, " ").trim().slice(0, 22) + " | hint=" + h.discard + " idx=" + h.discardIdx + " | 金框 idx=" + bt.hintIdx + "→" + markTile + " | 手 " + p.hand.join(" "));
    }
    // ② 参考解
    let bestLeft = -1, bestOpts = [], deadLeft = 0;
    for (const d of Array.from(new Set(p.hand))) {
      const rest = rm(p.hand, d), w = T.waitsFor(rest, p.melds, E.honors);
      let left = 0; for (const t of w) left += Math.max(0, 4 - cIn(rest, t) - (seen[t] || 0));
      if (w.length && left > bestLeft) { bestLeft = left; bestOpts = [d + "→" + w.join("/")]; }
      else if (w.length && left === bestLeft) bestOpts.push(d + "→" + w.join("/"));
    }
    const mineRest = rm(p.hand, h.discard);
    const mineW = T.waitsFor(mineRest, p.melds, E.honors);
    let mineLeft = 0; for (const t of mineW) mineLeft += Math.max(0, 4 - cIn(mineRest, t) - (seen[t] || 0));
    // ③ 真听牌保护
    if (w0.length) {
      stat.tenpai++;
      if (!mineW.length && T.totalShanten(mineRest, p.melds.length) > 0) {
        stat.broke++;
        if (ex.broke.length < 6) ex.broke.push("听 " + w0.join("/") + "（摸 " + drawn + "）→ 建议打 " + h.discard + " | 手 " + p.hand.join(" ") + " | 副露 " + p.melds.length + " | 面板 " + bt.panel.replace(/<[^>]*>/g, " ").trim().slice(0, 30));
      } else if (!mineW.length) { stat.dead++; if (ex.dead.length < 6) ex.dead.push("听 " + w0.join("/") + " → 建议打 " + h.discard + "（打完无听）手 " + p.hand.join(" ")); }
    }
    if (bestLeft > mineLeft) {
      stat.worse++;
      if (ex.worse.length < 8) ex.worse.push("建议打 " + h.discard + " → 听 " + (mineW.join("/") || "无") + "(" + mineLeft + "张) | 更优 " + bestOpts.slice(0, 3).join(" ") + "(" + bestLeft + "张) | 手 " + p.hand.join(" ") + " 副露 " + p.melds.length);
    }
    // ④ 出牌继续
    const idx = p.hand.indexOf(h.discard);
    if (!MJ.debug.act("discard", idx >= 0 ? idx : p.hand.length - 1)) break;
  }
}
console.log("人类回合 " + stat.turns + "；已听回合 " + stat.tenpai);
console.log("  ① 面板/金框/hint 不一致：" + stat.uiBad);
console.log("  ② 参考解更优（听口张数更少）：" + stat.worse);
console.log("  ③ 已听却建议破听：" + stat.broke + " / 打完无听：" + stat.dead);
console.log("  ④ hint 用时 >100ms：" + stat.slow + " 最坏 " + stat.worstMs + "ms");
ex.ui.forEach(s => console.log("   ✗[UI] " + s));
ex.broke.forEach(s => console.log("   ✗[破听] " + s));
ex.dead.forEach(s => console.log("   ✗[无听] " + s));
ex.worse.forEach(s => console.log("   ✗[听口差] " + s));
process.exit(0);
