/* 智脑提示取证探针 3：与「独立参考解」大规模对拍，找出建议不准的真实反例。
   参考解：对每个可打的牌算 [真向听, 真有效进张]，取 (向听最小 → 进张最多) 的最优集合。
   运行：node tools/dev/hint-probe3.js */
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "mahjong.js"), "utf8");

const ID_MAP = new Map(), VOID_TAGS = { br: 1, hr: 1, img: 1, input: 1, meta: 1, link: 1 };
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
    getContext() { const noop = () => {}; return { setTransform: noop, clearRect: noop, fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, arc: noop, ellipse: noop, fill: noop, stroke: noop, save: noop, restore: noop, clip: noop, translate: noop, scale: noop, rotate: noop, quadraticCurveTo: noop, closePath: noop, fillText: noop, strokeText: noop, drawImage: noop, putImageData: noop, getImageData: () => ({ data: [] }), createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }), createPattern: () => null, measureText: () => ({ width: 8 }), set fillStyle(v) {}, set strokeStyle(v) {}, set font(v) {}, set lineWidth(v) {}, set shadowColor(v) {}, set shadowBlur(v) {}, set textAlign(v) {}, set textBaseline(v) {}, set lineCap(v) {}, set lineJoin(v) {}, set globalAlpha(v) {} }; },
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
const HTML_IDS = new Map();
function ensureIds(html) { const re = /id\s*=\s*"([^"]+)"/g; let m; while ((m = re.exec(html))) if (!HTML_IDS.has(m[1])) HTML_IDS.set(m[1], makeElement("div")); }
const documentStub = { createElement: makeElement, getElementById(id) { return ID_MAP.get(id) || HTML_IDS.get(id) || null; }, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, head: makeElement("head"), body: makeElement("body") };
const windowStub = { setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {}, console, Math, Date, JSON, devicePixelRatio: 1, document: documentStub, innerWidth: 1280, innerHeight: 900, AudioSys: { blip() {}, click() {}, ding() {}, good() {}, bad() {} } };
windowStub.window = windowStub;
const ctx = vm.createContext(windowStub);
vm.runInContext(SRC, ctx, { filename: "mahjong.js" });
const MJ = ctx.Mahjong, T = MJ.test;

const SUIT_MAP = { m: "万", s: "条", p: "筒" };
function P(s) { const out = []; for (const part of String(s).split(/\s+/)) { if (!part) continue; const m = /^([0-9]+)([msp])$/.exec(part); if (m) { for (const ch of m[1]) out.push(ch + SUIT_MAP[m[2]]); continue; } const m2 = /^([1-9])([万条筒])$/.exec(part); if (m2) { out.push(part); continue; } for (const ch of part) out.push(ch); } return out; }
const meld = (type, s, an) => { const t = P(s); return { type, tiles: type === "gang" ? [t[0], t[0], t[0], t[0]] : [t[0], t[0], t[0]], from: 3, an: !!an, kind: an ? "an" : "ming" }; };
const sortT = a => a.slice().sort(T.cmpTile);
const rm = (h, t) => { const o = h.slice(), i = o.indexOf(t); if (i < 0) return null; o.splice(i, 1); return o; };
const cIn = (h, t) => h.filter(x => x === t).length;
function deal(deck, n, i) { return deck.slice(i, i + n); }
function rndHand(n, honors) { const pool = []; for (const t of (honors ? T.KINDS_ALL : T.KINDS)) for (let q = 0; q < 4; q++) pool.push(t); for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; } return pool.slice(0, n); }

/* 参考解：对每个可打牌 → 真向听 + 真有效进张 */
function refOptions(hand, melds, seen, honors) {
  const mk = melds.length, out = [];
  for (const d of Array.from(new Set(hand))) {
    const rest = rm(hand, d);
    const w = T.waitsFor(rest, melds, honors);
    const sh = T.totalShanten(rest, mk);
    let n = 0;
    if (w.length) { for (const t of w) n += Math.max(0, 4 - cIn(rest, t) - (seen[t] || 0)); }
    else { const g = T.gainsOf(rest, mk, seen, honors, undefined, melds); for (const x of g) n += x.left; }
    out.push({ d, sh, waits: w, uke: n });
  }
  return out;
}

console.log("═══ ① 建议 vs 参考解：向听是否最小 / 进张是否最多（无副露 + 有副露） ═══");
{
  let n = 0, worseSh = 0, worseUke = 0, deadWait = 0;
  const ex = { sh: [], uke: [], dead: [] };
  const scenarios = [
    { name: "无副露", mk: 0, honors: true },
    { name: "1副露", mk: 1, honors: true },
    { name: "2副露", mk: 2, honors: true },
    { name: "无字牌", mk: 0, honors: false }
  ];
  for (const sc of scenarios) {
    for (let it = 0; it < 600; it++) {
      const melds = [];
      const used = [];
      for (let m = 0; m < sc.mk; m++) {
        const t = (sc.honors ? T.KINDS_ALL : T.KINDS)[Math.floor(Math.random() * (sc.honors ? 34 : 27))];
        if (used.indexOf(t) >= 0) { m--; continue; }
        used.push(t); melds.push(meld("peng", "", 0).type === "peng" ? { type: "peng", tiles: [t, t, t], from: 3, an: false, kind: "ming" } : null);
      }
      const need = 14 - sc.mk * 3;
      const hand = rndHand(need, sc.honors);
      const p = { hand: hand.slice(), melds: melds, drawn: hand[hand.length - 1] };
      T.normalizeHand(p);
      const raw = p.hand.slice();
      const r = T.hintCalc({ hand: raw, melds: melds, seen: {}, honors: sc.honors });
      const ref = refOptions(raw, melds, {}, sc.honors);
      n++;
      const bestSh = Math.min.apply(null, ref.map(o => o.sh));
      const cands = ref.filter(o => o.sh === bestSh);
      const bestUke = Math.max.apply(null, cands.map(o => o.uke));
      const got = ref.filter(o => o.d === r.discard)[0];
      if (!got) { worseSh++; continue; }
      if (got.sh > bestSh) {
        worseSh++;
        if (ex.sh.length < 6) ex.sh.push(sc.name + " | 手 " + raw.join(" ") + " 副露 " + melds.length + " → 建议打 " + r.discard + "（" + got.sh + " 向听）最优 " + bestSh + " 向听；可打 " + cands.map(o => o.d).join("/"));
      } else if (got.uke < bestUke) {
        worseUke++;
        if (ex.uke.length < 6) ex.uke.push(sc.name + " | 手 " + raw.join(" ") + " 副露 " + melds.length + " → 建议打 " + r.discard + "（进张 " + got.uke + "）最优进张 " + bestUke + "（" + cands.map(o => o.d + ":" + o.uke).join(" ") + "）");
      }
      if (got.sh === 0 && got.waits.length === 0) {
        deadWait++;
        if (ex.dead.length < 6) ex.dead.push(sc.name + " | 手 " + raw.join(" ") + " → 建议打 " + r.discard + " 号称 0 向听却无听牌");
      }
    }
  }
  console.log("  样本 " + n + "；向听更差 " + worseSh + "；进张更少 " + worseUke + "；0 向听但无听 " + deadWait);
  ex.sh.forEach(s => console.log("     ✗[向听] " + s));
  ex.uke.forEach(s => console.log("     ✗[进张] " + s));
  ex.dead.forEach(s => console.log("     ✗[死听] " + s));
}

console.log("═══ ② 听牌保护：真听牌（打掉摸的那张即回原手）→ 建议是否破听 ═══");
{
  let tested = 0, broke = 0; const ex = [];
  for (let it = 0; it < 20000 && tested < 3000; it++) {
    const mk = it % 3 === 0 ? 0 : (it % 3 === 1 ? 1 : 2);
    const melds = [];
    for (let m = 0; m < mk; m++) { const t = T.KINDS_ALL[(it * 7 + m * 11) % 34]; melds.push({ type: "peng", tiles: [t, t, t], from: 3, an: false, kind: "ming" }); }
    const need = 13 - mk * 3;
    const h13 = rndHand(need, true);
    const w0 = T.waitsFor(h13, melds, true);
    if (!w0.length) continue;
    tested++;
    const draw = T.KINDS_ALL[(it * 13) % 34];
    if (cIn(h13, draw) >= 4) continue;
    const h14 = h13.concat([draw]);
    const p = { hand: h14.slice(), melds: melds, drawn: draw }; T.normalizeHand(p);
    const raw = p.hand.slice();
    const r = T.hintCalc({ hand: raw, melds: melds, seen: {}, honors: true });
    const after = rm(raw, r.discard);
    const w1 = T.waitsFor(after, melds, true);
    const sh1 = T.totalShanten(after, mk);
    if (!w1.length && sh1 > 0) {
      broke++;
      if (ex.length < 6) ex.push("听 " + w0.join("/") + " 摸 " + draw + " → 建议打 " + r.discard + "（打完 " + sh1 + " 向听）手 " + raw.join(" ") + " 副露 " + mk);
    }
  }
  console.log("  真听牌样本 " + tested + "；破听 " + broke);
  ex.forEach(s => console.log("     ✗ " + s));
}

console.log("═══ ③ 三处一致（debug.hint / 面板文案 / 金框）在大规模随机手牌下 ═══");
{
  MJ.start(makeElement("div"), {});
  let n = 0, bad = 0; const ex = [];
  for (let it = 0; it < 300; it++) {
    const mk = it % 4 === 0 ? 1 : 0;
    const melds = mk ? [{ type: "peng", tiles: ["5万", "5万", "5万"], from: 3, an: false, kind: "ming" }] : [];
    const hand = rndHand(14 - mk * 3, true);
    MJ.debug.setHand(hand, melds, hand[hand.length - 1]);
    const E = MJ.debug.engine(), p = E.P[0];
    p.drawn = p.hand[p.hand.length - 1]; T.normalizeHand(p);
    MJ.debug.render();
    const h = MJ.debug.hintNow();
    if (!h) continue;
    n++;
    const bt = MJ.debug.brainText(), rects = MJ.debug.handRects();
    const markTile = rects[bt.hintIdx] ? rects[bt.hintIdx].tile : "(无)";
    const panelOk = bt.panel.indexOf("打 " + h.discard) >= 0;
    if (!panelOk || markTile !== h.discard || h.tile === undefined && false) {
      bad++;
      if (ex.length < 6) ex.push("面板「" + bt.panel.replace(/<[^>]*>/g, " ").trim().slice(0, 20) + "」 hint.discard=" + h.discard + " idx=" + h.discardIdx + " 金框idx=" + bt.hintIdx + "→" + markTile + " 手 " + p.hand.join(" "));
    }
  }
  console.log("  样本 " + n + "；不一致 " + bad);
  ex.forEach(s => console.log("     ✗ " + s));
}

console.log("═══ ④ 缓存：同一多张手牌、不同「摸到的牌」→ discardIdx 是否被旧缓存污染 ═══");
{
  T.hintCacheClear();
  const core = P("123m 456m 789m 12s 99s");               // 13 张，等 3条
  const a = core.concat(["5筒"]);                         // 摸 5筒 → 建议打 5筒
  const p1 = { hand: a.slice(), melds: [], drawn: "5筒" }; T.normalizeHand(p1);
  const r1 = T.hintCalc({ hand: p1.hand.slice(), melds: [], seen: {}, honors: true });
  const p2 = { hand: core.concat(["5筒"]).slice(), melds: [], drawn: "5筒" }; T.normalizeHand(p2);
  // 第二次：同样的多张手牌，但摸到的是「建议打的那张」之前的另一张（顺序不同）
  const b = P("123m 456m 789m 12s 99s").filter(x => x !== "9条").concat(["9条"]);   // 9条 换到最右
  const p3 = { hand: b.slice(), melds: [], drawn: "9条" }; T.normalizeHand(p3);
  const r3 = T.hintCalc({ hand: p3.hand.slice(), melds: [], seen: {}, honors: true });
  console.log("  ① 手 " + p1.hand.join(" ") + " → discard=" + r1.discard + " idx=" + r1.discardIdx + "（该位=" + p1.hand[r1.discardIdx] + "）");
  console.log("  ② 手 " + p3.hand.join(" ") + " → discard=" + r3.discard + " idx=" + r3.discardIdx + "（该位=" + p3.hand[r3.discardIdx] + "）");
  // 直接构造：同一 sig、两种摆放
  T.hintCacheClear();
  const arr1 = sortT(core.concat(["9条"])); arr1.push("6筒");             // 摸 6筒
  const rA = T.hintCalc({ hand: arr1.slice(), melds: [], seen: {}, honors: true });
  const arr2 = sortT(core.concat(["9条"])); const i9 = arr2.indexOf("9条"); arr2.splice(i9, 1); arr2.push("9条");
  const rB = T.hintCalc({ hand: arr2.slice(), melds: [], seen: {}, honors: true });
  console.log("  ③ sig 相同但摆放不同：A(drawn 6筒) discard=" + rA.discard + " idx=" + rA.discardIdx + " 该位=" + arr1[rA.discardIdx]);
  console.log("     B(drawn 9条) discard=" + rB.discard + " idx=" + rB.discardIdx + " 该位=" + arr2[rB.discardIdx] + (rA === rB ? "  ← 同一缓存对象" : ""));
}

console.log("═══ ⑤ 有效进张（melds）：base=1 → 改善张是否被吞 ═══");
{
  const melds = [{ type: "peng", tiles: ["5万", "5万", "5万"], from: 3, an: false, kind: "ming" }];
  const h10 = P("123m 789m 23s 99s");                     // 10 张暗手 + 1 副露 = 13
  const g = T.gainsOf(h10, 1, {}, true, undefined, melds);
  const w = T.waitsFor(h10, melds, true);
  console.log("  暗手 " + sortT(h10).join(" ") + " + 碰5万 → totalShanten(13张)=" + T.totalShanten(h10, 1) + " waits=" + (w.join("/") || "无"));
  console.log("    gainsOf = " + (g.map(x => x.tile + "×" + x.left).join(" ") || "(空)"));
  const rows = [];
  for (const t of T.KINDS_ALL) {
    const h11 = h10.concat([t]);
    const s2 = T.totalShanten(h11, 1);
    let truthMin = 99; for (const d of Array.from(new Set(h11))) truthMin = Math.min(truthMin, T.totalShanten(rm(h11, d), 1));
    if (truthMin < T.totalShanten(h10, 1)) rows.push(t + ":total=" + s2 + "/真=" + truthMin);
  }
  console.log("    真能改善的进张：" + (rows.join(" ") || "(无)"));
}
