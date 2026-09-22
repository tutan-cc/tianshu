/* 智脑提示取证探针（不改任何源码，只读）：找出「建议牌 == 关键牌」的真实反例。
   运行：node tools/dev/hint-probe.js */
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "mahjong.js"), "utf8");

/* ── 最小 DOM stub（与 mahjong-logic.js 同款，够 start() 用） ── */
const ID_MAP = new Map(), HTML_IDS = new Map(), VOID_TAGS = { br: 1, hr: 1, img: 1, input: 1, meta: 1, link: 1 };
function regIds(el) { if (!el || typeof el !== "object") return; if (el.id) ID_MAP.set(el.id, el); if (el.childNodes) for (const c of el.childNodes) regIds(c); }
function unregIds(el) { if (!el || typeof el !== "object") return; if (el.childNodes) for (const c of el.childNodes) unregIds(c); }
function makeElement(tag) {
  const e = {
    tagName: String(tag || "div").toUpperCase(), id: "", className: "", style: {}, dataset: {}, childNodes: [], children: [], _html: "", _text: "", parentNode: null,
    classList: { _s: new Set(), add() { for (const a of arguments) this._s.add(a); }, remove() { for (const a of arguments) this._s.delete(a); }, contains(c) { return this._s.has(c); }, toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); this.children.push(c); this._html = ""; regIds(c); return c; },
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) { this.childNodes.splice(i, 1); this.children.splice(i, 1); } unregIds(c); return c; },
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { left: 10, top: 20, width: 1180, height: 818 }; },
    getContext() {
      const noop = () => {};
      return { setTransform: noop, clearRect: noop, fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, arc: noop, ellipse: noop, fill: noop, stroke: noop, save: noop, restore: noop, clip: noop, translate: noop, scale: noop, rotate: noop, quadraticCurveTo: noop, closePath: noop, fillText: noop, strokeText: noop, drawImage: noop, putImageData: noop, getImageData: () => ({ data: [] }), createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }), createPattern: () => null, measureText: () => ({ width: 8 }), set fillStyle(v) {}, set strokeStyle(v) {}, set font(v) {}, set lineWidth(v) {}, set shadowColor(v) {}, set shadowBlur(v) {}, set textAlign(v) {}, set textBaseline(v) {}, set lineCap(v) {}, set lineJoin(v) {}, set globalAlpha(v) {} };
    },
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
  e._sync = function () { if (this._html || !this.childNodes.length) return this._html; let s = ""; for (const c of this.childNodes) { const t = c.tagName.toLowerCase(); s += "<" + t + (c.id ? ' id="' + c.id + '"' : "") + ">" + c._sync() + (VOID_TAGS[t] ? "" : "</" + t + ">"); } return s; };
  Object.defineProperty(e, "innerHTML", { get() { return this._sync(); }, set(v) { unregIds(this); this.childNodes = []; this.children = []; this._html = String(v == null ? "" : v); parseIds(this._html, this); ensureIds(this._html); }, configurable: true });
  Object.defineProperty(e, "textContent", { get() { return this._text || this._sync().replace(/<[^>]*>/g, ""); }, set(v) { this._text = String(v == null ? "" : v); }, configurable: true });
  Object.defineProperty(e, "lastChild", { get() { return this.childNodes[this.childNodes.length - 1] || null; }, configurable: true });
  return e;
}
function parseIds(html, root) {
  const re = /<([a-zA-Z][\w-]*)([^>]*)>/g; let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase(), idm = /id\s*=\s*"([^"]*)"/.exec(m[2]);
    if (!idm || !idm[1]) continue;
    const el = makeElement(tag); el.id = idm[1];
    const cm = /class\s*=\s*"([^"]*)"/.exec(m[2]); if (cm) el.className = cm[1];
    ID_MAP.set(el.id, el);
  }
}
function ensureIds(html) { const re = /id\s*=\s*"([^"]+)"/g; let m; while ((m = re.exec(html))) if (!HTML_IDS.has(m[1])) HTML_IDS.set(m[1], makeElement("div")); }
const documentStub = { createElement: makeElement, getElementById(id) { return ID_MAP.get(id) || HTML_IDS.get(id) || null; }, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, head: makeElement("head"), body: makeElement("body") };
const windowStub = { setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {}, console, Math, Date, JSON, devicePixelRatio: 1, document: documentStub, innerWidth: 1280, innerHeight: 900, AudioSys: { blip() {}, click() {}, ding() {}, good() {}, bad() {} } };
windowStub.window = windowStub;
const ctx = vm.createContext(windowStub);
vm.runInContext(SRC, ctx, { filename: "mahjong.js" });
const MJ = ctx.Mahjong || windowStub.Mahjong, T = MJ.test;

const SUIT_MAP = { m: "万", s: "条", p: "筒" }, HONOR_CH = "东南西北中發白";
function P(s) {
  const out = [];
  for (const part of String(s).split(/\s+/)) {
    if (!part) continue;
    const m = /^([0-9]+)([msp])$/.exec(part);
    if (m) { for (const ch of m[1]) out.push(ch + SUIT_MAP[m[2]]); continue; }
    const m2 = /^([1-9])([万条筒])$/.exec(part);
    if (m2) { out.push(part); continue; }
    for (const ch of part) out.push(ch);
  }
  return out;
}
const meld = (type, s, an) => { const t = P(s); return { type, tiles: type === "gang" ? [t[0], t[0], t[0], t[0]] : [t[0], t[0], t[0]], from: 3, an: !!an, kind: an ? "an" : "ming" }; };
const sortT = a => a.slice().sort(T.cmpTile);
const rm = (h, t) => { const o = h.slice(); const i = o.indexOf(t); if (i < 0) return null; o.splice(i, 1); return o; };
const sh = (h, mk) => T.totalShanten(h, mk || 0);

function rndHand(pos, honors) {
  const pool = [];
  for (const t of (honors ? T.KINDS_ALL : T.KINDS)) for (let q = 0; q < 4; q++) pool.push(t);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  return pool.slice(0, pos);
}

let problems = 0;
function bug(tag, msg) { problems++; if (problems <= 25) console.log("  ✗ [" + tag + "] " + msg); }

console.log("═══ A. discardIdx 是否真的指向那张牌（13/14 张、含摸牌在最右） ═══");
{
  let bad = 0, n = 0;
  for (let it = 0; it < 300; it++) {
    const h = rndHand(14, true);
    const p = { hand: h.slice(), melds: [], drawn: h[h.length - 1], kongDraw: false };
    T.normalizeHand(p);                                   // 引擎里的真实摆放：摸到的牌在最右
    const raw = p.hand.slice();
    const r = T.hintCalc({ hand: raw, melds: [], seen: {}, honors: true });
    n++;
    if (r.discard && raw[r.discardIdx] !== r.discard) { bad++; if (bad <= 3) bug("A", "hand=" + raw.join(" ") + " discard=" + r.discard + " idx=" + r.discardIdx + " → hand[idx]=" + raw[r.discardIdx]); }
  }
  console.log("  discardIdx 指向错误 " + bad + "/" + n);
}

console.log("═══ B. 已 13 张听牌 + 摸一张 → 建议是否破听 ═══");
{
  let cases = 0, broke = 0, nullDiscard = 0;
  const sample = [];
  for (let it = 0; it < 4000 && cases < 400; it++) {
    const h13 = rndHand(13, true);
    const w = T.waitsFor(h13, [], true);
    if (!w.length) continue;
    cases++;
    const pool = [];
    for (const t of T.KINDS_ALL) for (let q = 0; q < 4; q++) pool.push(t);
    const draw = pool[Math.floor(Math.random() * pool.length)];
    const raw0 = h13.concat([draw]);
    const p = { hand: raw0.slice(), melds: [], drawn: draw, kongDraw: false };
    T.normalizeHand(p);
    const raw = p.hand.slice();
    const r = T.hintCalc({ hand: raw, melds: [], seen: {}, honors: true });
    const after = r.discard ? sh(rm(raw, r.discard), 0) : sh(raw, 0);
    if (!r.discard) { nullDiscard++; continue; }
    if (after > 0) {
      broke++;
      if (sample.length < 8) sample.push({ hand: sortT(h13).join(" "), waits: w.join("/"), draw, suggest: r.discard, afterShanten: after, tenpaiAfter: r.tenpaiAfter, waitsAfter: (r.waits || []).join("/"), opt0: (r.options || []).map(o => o.discard + ":" + o.shanten).join(" ") });
    }
  }
  console.log("  已听 13 张样本 " + cases + "；建议破听 " + broke + "；无建议(null) " + nullDiscard);
  sample.forEach(s => console.log("     · 听 " + s.waits + " | 摸 " + s.draw + " → 建议打 " + s.suggest + "（打完 " + s.afterShanten + " 向听, tenpaiAfter=" + s.tenpaiAfter + "）手牌 " + s.hand + " | options " + s.opt0));
}

console.log("═══ C. 副露手：melds 是否被计入（暗手 3k+1 张） ═══");
{
  const m = [meld("peng", "5万")];
  const h = P("123m 789m 23s 99s 5p 1p").concat();       // 10 张暗手（1 副露）= 3*3+1
  const r = T.hintCalc({ hand: h, melds: m, seen: {}, honors: true });
  console.log("  10 张暗手 + 1 副露：discard=" + r.discard + " shanten=" + r.shanten + " now=" + r.tenpaiNow + " after=" + r.tenpaiAfter + " waits=" + (r.waits || []).join("/"));
  const h14 = h.concat(["9筒"]);                          // 摸一张 → 11 张 = 3k+2
  const r2 = T.hintCalc({ hand: h14, melds: m, seen: {}, honors: true });
  console.log("  摸 9筒 → discard=" + r2.discard + " shanten=" + r2.shanten + " tenpaiNow=" + r2.tenpaiNow + " tenpaiAfter=" + r2.tenpaiAfter + " afterShanten=" + (r2.discard ? sh(rm(h14, r2.discard), 1) : "-"));
}

console.log("═══ D. 时序：摸牌前 / 摸牌后 hint 是否同步（引擎级） ═══");
{
  MJ.start(makeElement("div"), {});
  let found = 0, stale = 0, missing = 0;
  for (let it = 0; it < 40 && found < 6; it++) {
    MJ.debug.setHand(rndHand(13, true), [], null);
    const E = MJ.debug.engine();
    E.phase = "turn"; E.cur = 0;
    const before = MJ.debug.hintNow();
    if (!before) { missing++; continue; }
    if (!T.hintCalc) break;
    // 造一张「摸牌前 / 摸牌后建议不同」的牌
    const p = E.P[0];
    const cands = T.KINDS_ALL.filter(t => {
      const h2 = p.hand.concat([t]);
      const r = T.hintCalc({ hand: h2, melds: p.melds, seen: {}, honors: p.melds.length ? true : E.honors });
      return r.discard && r.discard !== t;
    });
    if (!cands.length) continue;
    const t = cands[0];
    p.hand.push(t); p.drawn = t; T.normalizeHand(p);
    const after = MJ.debug.hintNow();                    // 摸牌后立刻读
    const want = T.hintCalc({ hand: p.hand.slice(), melds: p.melds, seen: MJ.debug ? {} : {}, honors: E.honors });
    found++;
    if (!after) { missing++; continue; }
    if (after.tile !== undefined ? false : after.discard !== want.discard) { stale++; console.log("     · 摸 " + t + " 后 hint=" + after.discard + " 期望=" + want.discard + " 手牌=" + p.hand.join(" ")); }
  }
  console.log("  构造到 " + found + " 组；慢一拍 " + stale + "；读不到 " + missing);
}

console.log("═══ E. 确定性 / 缓存 ═══");
{
  const h = P("123m 456m 789m 12s 99s 5p");
  T.hintCacheClear();
  const rs = [];
  for (let i = 0; i < 5; i++) { const r = T.hintCalc({ hand: h.slice(), melds: [], seen: {}, honors: true }); rs.push(r.discard + "|" + r.shanten + "|" + (r.waits || []).join("/") + "|" + r.ukeire); }
  console.log("  同手牌 5 次：" + (rs.every(x => x === rs[0]) ? "一致 ✔" : "不一致 ✗ " + rs.join(" , ")));
  // melds 变化但不影响 sig?
  const a = T.hintCalc({ hand: P("123m 456m 789m 23s 99s"), melds: [meld("peng", "5万")], seen: {}, honors: true });
  const b = T.hintCalc({ hand: P("123m 456m 789m 23s 99s"), melds: [meld("peng", "6万")], seen: {}, honors: true });
  console.log("  melds 5万/6万 两次同签名？ " + (a === b ? "同一对象（命中旧缓存）✗" : "不同对象 ✔") + " shanten " + a.shanten + " / " + b.shanten);
  const c = T.hintCalc({ hand: P("123m 456m 789m 23s 99s"), melds: [], seen: {}, honors: false });
  const d = T.hintCalc({ hand: P("123m 456m 789m 23s 99s"), melds: [], seen: {}, honors: true });
  console.log("  字牌开关两态同对象？ " + (c === d ? "✗" : "✔"));
}

console.log("═══ F. UI 三者一致：面板文案 / 金框 / debug.hint() ═══");
{
  const host = makeElement("div");
  MJ.dispose(); MJ.start(host, {});
  let bad = 0, n = 0;
  for (let it = 0; it < 40; it++) {
    MJ.debug.setHand(rndHand(14, true), [], null);
    // 让最后一格是「摸到的牌」
    const E = MJ.debug.engine(), p = E.P[0];
    const last = p.hand[p.hand.length - 1];
    p.drawn = last; T.normalizeHand(p);
    MJ.debug.render();
    const h = MJ.debug.hintNow();
    if (!h) continue;
    n++;
    const bt = MJ.debug.brainText();
    const rects = MJ.debug.handRects();
    const idx = bt.hintIdx;
    const markTile = rects[idx] ? rects[idx].tile : "(越界)";
    const panelHas = bt.panel.indexOf("打 " + h.discard) >= 0;
    if (!panelHas || markTile !== h.discard || (h.discardIdx >= 0 && idx !== h.discardIdx)) {
      bad++;
      if (bad <= 6) console.log("  ✗ 面板=" + (bt.panel.replace(/<[^>]*>/g, " ").trim().slice(0, 24)) + " | hint.discard=" + h.discard + " idx=" + h.discardIdx + " | 金框 idx=" + idx + " 落到 " + markTile + " | 手牌 " + p.hand.join(" "));
    }
  }
  console.log("  UI 三者不一致 " + bad + "/" + n);
}

console.log("\n总问题数：" + problems);
