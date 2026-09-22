/* 探针 7：搞清「真牌局快进」的正确驱动方式（人类回合 / 响应窗口）
   运行：node tools/dev/hint-probe7.js */
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
MJ.start(mkEl("div"), {});
const E = MJ.debug.engine();
console.log("isHuman: " + E.P.map(p => p.isHuman).join(",") + "  phase=" + E.phase + " dealer=" + E.dealer);
for (let i = 0; i < 60; i++) {
  const before = E.phase + "/" + E.cur + "/手" + E.P[0].hand.length + "/副" + E.P[0].melds.length;
  const r = MJ.debug.step();
  const after = E.phase + "/" + E.cur + "/手" + E.P[0].hand.length + "/副" + E.P[0].melds.length;
  console.log("#" + i + "  " + before + "  --" + r + "-->  " + after + "  pending=" + (E.pending ? E.pending.type + ":" + (E.pending.seat !== undefined ? E.pending.seat : JSON.stringify(E.pending.seats)) : "-"));
  if (E.phase === "turn" && E.cur === 0 && E.P[0].hand.length % 3 === 2) {
    const h = MJ.debug.hintNow();
    const d = h ? h.discard : null;
    console.log("     人类回合：手=" + E.P[0].hand.join(" ") + " 摸=" + E.P[0].drawn + " → hint=" + (h ? d + " idx" + h.discardIdx + " sh" + h.shanten : "null"));
    const idx = d ? E.P[0].hand.indexOf(d) : -1;
    const ok = MJ.debug.act("discard", idx >= 0 ? idx : E.P[0].hand.length - 1);
    console.log("     出牌 " + ok);
    if (!ok) break;
  } else if (E.phase === "claim" && E.pending.seat === 0) {
    console.log("     人类碰杠窗口：" + JSON.stringify(E.pending.actions) + " 牌=" + E.pending.tile + " 手=" + E.P[0].hand.join(" "));
    MJ.debug.act("pass");
  } else if (E.phase === "over") { console.log("     结束：" + (E.result ? E.result.fanName : "")); break; }
  if (r === "over") break;
}
process.exit(0);
