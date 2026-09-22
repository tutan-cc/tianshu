/* 智脑提示自查演示（只读）：打印 Mahjong.debug.hint() 的真实返回，以及「面板 / 金框 / tile」三处逐字一致
   运行：node tools/dev/hint-selfcheck-demo.js */
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "mahjong.js"), "utf8");
const ID_MAP = new Map(), VOID_TAGS = { br: 1, hr: 1, img: 1, input: 1, meta: 1, link: 1 };
function regIds(el) { if (!el || typeof el !== "object") return; if (el.id) ID_MAP.set(el.id, el); if (el.childNodes) for (const c of el.childNodes) regIds(c); }
function unregIds(el) { if (!el || typeof el !== "object") return; if (el.childNodes) for (const c of el.childNodes) unregIds(c); }
function mkEl(tag) {
  const e = { tagName: String(tag).toUpperCase(), id: "", className: "", style: {}, childNodes: [], children: [], _html: "", _text: "", parentNode: null,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} }, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { this.childNodes.push(c); this.children.push(c); this._html = ""; regIds(c); return c; },
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) { this.childNodes.splice(i, 1); this.children.splice(i, 1); } unregIds(c); return c; },
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 1180, height: 818 }; },
    getContext() { const n = () => {}; return new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 8 }) : k === "getImageData" ? () => ({ data: [] }) : (k === "createLinearGradient" || k === "createRadialGradient") ? () => ({ addColorStop: n }) : k === "createPattern" ? () => null : n), set: () => true }); },
    querySelector() { return null; }, querySelectorAll() { return []; } };
  e._sync = function () { if (this._html || !this.childNodes.length) return this._html; let s = ""; for (const c of this.childNodes) { const t = c.tagName.toLowerCase(); s += "<" + t + (c.id ? ' id="' + c.id + '"' : "") + ">" + c._sync() + (VOID_TAGS[t] ? "" : "</" + t + ">"); } return s; };
  Object.defineProperty(e, "innerHTML", { get() { return this._sync(); }, set(v) { unregIds(this); this.childNodes = []; this.children = []; this._html = String(v == null ? "" : v); parseIds(this._html); ensureIds(this._html); }, configurable: true });
  Object.defineProperty(e, "textContent", { get() { return this._text || this._sync().replace(/<[^>]*>/g, ""); }, set(v) { this._text = String(v == null ? "" : v); }, configurable: true });
  Object.defineProperty(e, "lastChild", { get() { return this.childNodes[this.childNodes.length - 1] || null; }, configurable: true });
  return e;
}
function parseIds(html) { const re = /<([a-zA-Z][\w-]*)([^>]*)>/g; let m; while ((m = re.exec(html))) { const idm = /id\s*=\s*"([^"]*)"/.exec(m[2]); if (!idm || !idm[1]) continue; const el = mkEl(m[1]); el.id = idm[1]; const cm = /class\s*=\s*"([^"]*)"/.exec(m[2]); if (cm) el.className = cm[1]; ID_MAP.set(el.id, el); } }
const HTML_IDS = new Map();
function ensureIds(html) { const re = /id\s*=\s*"([^"]+)"/g; let m; while ((m = re.exec(html))) if (!HTML_IDS.has(m[1])) HTML_IDS.set(m[1], mkEl("div")); }
const documentStub = { createElement: mkEl, getElementById: id => ID_MAP.get(id) || HTML_IDS.get(id) || null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, head: mkEl("head"), body: mkEl("body") };
const windowStub = { setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, console, Math, Date, JSON, devicePixelRatio: 1, document: documentStub, innerWidth: 1280, innerHeight: 900, AudioSys: {} };
windowStub.window = windowStub;
const ctx = vm.createContext(windowStub);
vm.runInContext(SRC, ctx, { filename: "mahjong.js" });
const MJ = ctx.Mahjong, T = MJ.test;
const SUIT_MAP = { m: "万", s: "条", p: "筒" };
function P(s) { const out = []; for (const part of String(s).split(/\s+/)) { if (!part) continue; const m = /^([0-9]+)([msp])$/.exec(part); if (m) { for (const ch of m[1]) out.push(ch + SUIT_MAP[m[2]]); continue; } const m2 = /^([1-9])([万条筒])$/.exec(part); if (m2) { out.push(part); continue; } for (const ch of part) out.push(ch); } return out; }
const meld = (type, s, an) => { const t = P(s); return { type, tiles: type === "gang" ? [t[0], t[0], t[0], t[0]] : [t[0], t[0], t[0]], from: 3, an: !!an, kind: an ? "an" : "ming" }; };

MJ.start(mkEl("div"), {});
const panelDiscard = (html) => { const m = /打\s*([^\s<（(]+)/.exec(String(html || "").replace(/<[^>]*>/g, " ")); return m ? m[1] : ""; };

const CASES = [
  { name: "普通听牌（打 5筒 即听 3条）", hand: P("123m 456m 789m 12s 99s 5p"), melds: [] },
  { name: "有副露（碰 5万）", hand: P("123m 789m 23s 99s 5p"), melds: [meld("peng", "5万")] },
  { name: "大吊车（4 副露）", hand: P("9s 5p"), melds: [meld("peng", "5万"), meld("peng", "6条"), meld("gang", "7筒", true), meld("peng", "东")] }
];
for (const c of CASES) {
  MJ.debug.setHand(c.hand, c.melds, c.hand[c.hand.length - 1]);
  MJ.debug.render();
  const h = MJ.debug.hint();
  const bt = MJ.debug.brainText();
  const rects = MJ.debug.handRects();
  console.log("\n=== " + c.name + " ===");
  console.log("  手牌：" + c.hand.join(" ") + "（副露 " + c.melds.length + " 组）");
  console.log("  Mahjong.debug.hint() = " + JSON.stringify({
    discard: h.discard, tile: h.tile, shanten: h.shanten, waits: h.waits, ukeire: h.ukeire, reason: h.reason
  }, null, 0));
  console.log("  面板文字：打 " + panelDiscard(bt.panel) + "   |   hint().tile = " + h.tile + "   |   金框那一格 = " + (rects[h.markIdx] || {}).tile +
    "   →   " + (panelDiscard(bt.panel) === h.tile && (rects[h.markIdx] || {}).tile === h.tile ? "三者同一张 ✔" : "不一致 ✗"));
  console.log("  hint().markTile=" + h.markTile + " markIdx=" + h.markIdx + " discardIdx=" + h.discardIdx + " noBetter=" + h.noBetter);
}
process.exit(0);
