/* 探针 8：摸牌后「立刻」读面板/金框（= showHumanUI 的真实顺序）→ 金框是否落在旧摆放上
   运行：node tools/dev/hint-probe8.js */
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

MJ.start(mkEl("div"), {});
const E = MJ.debug.engine(), p = E.P[0];
/* 手牌 13 张 + 一副摸到就建议打掉的局面 */
MJ.debug.setHand(P("123m 456m 789m 12s 99s"), [], null);
console.log("摸牌前：手 " + p.hand.join(" ") + "（" + p.hand.length + " 张）drawn=" + p.drawn);
const rectsBefore = MJ.debug.handRects();
console.log("  上一帧摆放 " + rectsBefore.length + " 格：" + rectsBefore.map(r => r.tile).join(" "));

/* 真实摸牌（引擎同一条路径：push + drawn + normalizeHand），随后**立刻**读提示（= showHumanUI → refreshHint） */
const t = "5筒";
p.hand.push(t); p.drawn = t; T.normalizeHand(p);
E.phase = "turn"; E.cur = 0; E.pending = { type: "turn", seat: 0, anGangs: [], addGangs: [] };
const h = MJ.debug.hintNow();                          // 不经过 render
const bt = MJ.debug.brainText();
const rectsNow = MJ.debug.handRects();                 // 仍是旧摆放（下一帧才会更新）
const markTile = rectsNow[bt.hintIdx] ? rectsNow[bt.hintIdx].tile : "(越界)";
console.log("摸牌后：手 " + p.hand.join(" ") + "（" + p.hand.length + " 张）drawn=" + p.drawn);
console.log("  面板：" + bt.panel.replace(/<[^>]*>/g, " ").trim());
console.log("  hint.discard=" + h.discard + " discardIdx=" + h.discardIdx + "  hand[idx]=" + p.hand[h.discardIdx]);
console.log("  金框 idx=" + bt.hintIdx + " → handRects[idx].tile = " + markTile + "  " + (markTile === h.discard ? "✔ 一致" : "✗ 不一致（金框盖在别的牌上）"));
console.log("  DOM 金框 left=" + bt.markLeft + " top=" + bt.markTop + " display=" + bt.markDisplay);
/* 下一帧之后（正常渲染） */
MJ.debug.render();
const bt2 = MJ.debug.brainText();
console.log("下一帧后：金框 idx=" + bt2.hintIdx + " → " + (MJ.debug.handRects()[bt2.hintIdx] || {}).tile + "  " + ((MJ.debug.handRects()[bt2.hintIdx] || {}).tile === h.discard ? "✔" : "✗"));
process.exit(0);
