/* 智脑提示取证探针 2：副露 / 时序 / 性能 / 听牌保护（只读，不改源码）
   运行：node tools/dev/hint-probe2.js */
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "mahjong.js"), "utf8");
const ID_MAP = new Map(), HTML_IDS = new Map();
function mkEl(tag) {
  const e = { tagName: String(tag).toUpperCase(), id: "", className: "", style: {}, childNodes: [], children: [], _html: "", _text: "",
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { this.childNodes.push(c); this.children.push(c); return c; }, removeChild(c) { return c; },
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { left: 10, top: 20, width: 1180, height: 818 }; },
    getContext() { const n = () => {}; return new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 8 }) : k === "getImageData" ? () => ({ data: [] }) : k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop: n }) : k === "createPattern" ? () => null : n), set: () => true }); },
    querySelector() { return null; }, querySelectorAll() { return []; } };
  Object.defineProperty(e, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v == null ? "" : v); const re = /id\s*=\s*"([^"]+)"/g; let m; while ((m = re.exec(this._html))) if (!HTML_IDS.has(m[1])) HTML_IDS.set(m[1], mkEl("div")); }, configurable: true });
  Object.defineProperty(e, "textContent", { get() { return this._text || this._html.replace(/<[^>]*>/g, ""); }, set(v) { this._text = String(v == null ? "" : v); }, configurable: true });
  return e;
}
const documentStub = { createElement: mkEl, getElementById(id) { return ID_MAP.get(id) || HTML_IDS.get(id) || null; }, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, head: mkEl("head"), body: mkEl("body") };
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

function truthBestDiscard(hand, melds, honors) {           // 独立口径：暴力枚举（用 waitsFor + stdShanten 交叉）
  const mk = melds.length, u = Array.from(new Set(hand));
  let best = { sh: 99, waits: [], disc: null };
  for (const d of u) {
    const rest = rm(hand, d);
    const w = T.waitsFor(rest, melds, honors);
    const sh = w.length ? 0 : T.stdShanten(rest, mk);     // 只用 stdShanten，避开七对/DP 口径
    if (sh < best.sh || (sh === best.sh && w.length > best.waits.length)) best = { sh, waits: w, disc: d };
  }
  return best;
}

console.log("═══ 1. 副露手：totalShanten(14 张等价手) 是否把「听牌」误判成「已成牌 -1」 ═══");
{
  const cases = [];
  for (let n = 0; n < 4000; n++) {
    const pool = [];
    for (const t of T.KINDS_ALL) for (let q = 0; q < 4; q++) pool.push(t);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    const melds = [meld("peng", "5万")];
    const h11 = pool.slice(0, 11);                        // 1 副露 + 11 张暗手 = 14
    const ts = T.totalShanten(h11, 1);
    const truth = (function () {                          // 真值：打一张后最好（只用 stdShanten）
      let b = 99;
      for (const d of Array.from(new Set(h11))) b = Math.min(b, T.stdShanten(rm(h11, d), 1));
      return b;
    })();
    if (ts !== truth) cases.push({ h: sortT(h11).join(" "), ts, truth, w: T.waitsFor(rm(h11, h11[0]), melds, true).length });
    if (cases.length >= 5) break;
  }
  console.log("  反例 " + cases.length + " 例：");
  cases.forEach(c => console.log("     · 暗手 " + c.h + " + 碰5万 → totalShanten=" + c.ts + "（真值 " + c.truth + "）"));
}

console.log("═══ 2. 副露手：ukeireSet 的「有效进张」是否被吞掉（base=1 → 期望 s2=0） ═══");
{
  const melds = [meld("peng", "5万")];
  const h10 = P("123m 789m 23s 99s 中");                  // 10 张暗手 = 3*3+1，总 13
  console.log("  暗手 " + sortT(h10).join(" ") + " + 碰5万（共 13 张）");
  const w = T.waitsFor(h10, melds, true);
  console.log("    waitsFor = " + (w.join("/") || "(无)") + " ; stdShanten = " + T.stdShanten(h10, 1) + " ; totalShanten = " + T.totalShanten(h10, 1));
  const g = T.gainsOf(h10, 1, {}, true, undefined, melds);
  console.log("    gainsOf(有效进张) = " + (g.map(x => x.tile + "×" + x.left).join(" ") || "(空)"));
  // 逐张打印 s2
  const rows = [];
  for (const t of T.KINDS_ALL) {
    const h11 = h10.concat([t]);
    const s2 = T.totalShanten(h11, 1);
    const stdAfterDiscard = Math.min.apply(null, Array.from(new Set(h11)).map(d => T.stdShanten(rm(h11, d), 1)));
    if (stdAfterDiscard < T.stdShanten(h10, 1)) rows.push(t + ": total=" + s2 + " 真值=" + stdAfterDiscard);
  }
  console.log("    能改善的进张（前 12）：" + rows.slice(0, 12).join(" | "));
}

console.log("═══ 3. 听牌保护：构造听牌手（含副露/字牌/单钓/两面/七对/大吊车）+ 随机摸牌 ═══");
{
  const CASES = [
    { name: "两面(无副露)", melds: [], h13: P("123m 456m 789m 23s 99s") },
    { name: "单钓(无副露)", melds: [], h13: P("123m 456m 789m 123s 9s") },
    { name: "七对听", melds: [], h13: P("11m 22m 33m 44m 55s 66s 7p") },
    { name: "字牌听", melds: [], h13: P("123m 456m 789m 99s 东东") },
    { name: "单副露两面", melds: [meld("peng", "5万")], h13: P("123m 789m 23s 99s 中") },
    { name: "单副露单钓", melds: [meld("peng", "5万")], h13: P("123m 789m 123s 9s 中") },
    { name: "大吊车(4副露)", melds: [meld("peng", "5万"), meld("peng", "6条"), meld("gang", "7筒", true), meld("peng", "东")], h13: P("9s") },
    { name: "双副露", melds: [meld("peng", "5万"), meld("peng", "2条")], h13: P("123m 789m 99s 中") }
  ];
  let broke = 0, tested = 0, oops = [];
  for (const c of CASES) {
    const w0 = T.waitsFor(c.h13, c.melds, true);
    if (!w0.length) { console.log("  · " + c.name + "：构造手牌并未听牌（waits 空），跳过"); continue; }
    for (const draw of T.KINDS_ALL) {
      if (cIn(c.h13, draw) >= 4) continue;
      const h14 = c.h13.concat([draw]);
      const p = { hand: h14.slice(), melds: c.melds, drawn: draw };
      T.normalizeHand(p);
      const raw = p.hand.slice();
      const r = T.hintCalc({ hand: raw, melds: c.melds, seen: {}, honors: true });
      tested++;
      if (!r.discard) { oops.push(c.name + " 摸 " + draw + " → 无建议"); continue; }
      const after = rm(raw, r.discard);
      const stillTenpai = T.waitsFor(after, c.melds, true).length > 0;
      const shAfter = stillTenpai ? 0 : T.stdShanten(after, c.melds.length);
      if (shAfter > 0) { broke++; if (oops.length < 14) oops.push(c.name + " 听 " + w0.join("/") + " 摸 " + draw + " → 建议打 " + r.discard + "（打完 " + shAfter + " 向听，破听）手牌 " + raw.join(" ")); }
    }
    console.log("  · " + c.name + "：听 " + w0.join("/") + " ✔ 构造成功");
  }
  console.log("  合计测试 " + tested + " 组；破听 " + broke);
  oops.slice(0, 14).forEach(s => console.log("     ✗ " + s));
}

console.log("═══ 4. 真牌局抽样：人类每次出牌前，「已听 → 建议是否破听」+ 用时 ═══");
{
  const host = mkEl("div");
  MJ.start(host, {});
  let turns = 0, tenpaiTurns = 0, broke = 0, worstMs = 0, worstHand = "", slow = 0, sum = 0;
  MJ.debug.setHand(P("123m 456m 789m 23s 99s 5p"), [], null);
  const E = MJ.debug.engine();
  for (let step = 0; step < 3000; step++) {
    const r = MJ.debug.step();
    if (r === "over" || !r) break;
    const p = E.P[0];
    if (E.phase === "turn" && E.cur === 0 && p.hand.length % 3 === 2) {
      const before = p.hand.slice(0, p.hand.length - (p.drawn !== null ? 1 : 0));
      const w = T.waitsFor(before, p.melds, E.honors);
      const t0 = Date.now();
      const h = MJ.debug.hintNow();
      const ms = Date.now() - t0;
      sum += ms; if (ms > worstMs) { worstMs = ms; worstHand = p.hand.join(" "); }
      if (ms > 120) slow++;
      turns++;
      if (w.length && h && h.discard) {
        tenpaiTurns++;
        const after = rm(p.hand, h.discard);
        if (!T.waitsFor(after, p.melds, E.honors).length) {
          broke++;
          if (broke <= 8) console.log("     ✗ 听 " + w.join("/") + " | 建议打 " + h.discard + " → 破听 | 手牌 " + p.hand.join(" ") + " 副露 " + p.melds.length);
        }
      }
      // 出建议的那张（若合法），继续牌局
      const idx = p.hand.indexOf(h && h.discard) >= 0 ? p.hand.indexOf(h.discard) : p.hand.length - 1;
      if (!MJ.debug.act("discard", idx)) break;
    }
  }
  console.log("  人类回合 " + turns + "；其中已听 " + tenpaiTurns + "；破听 " + broke);
  console.log("  hint 用时 最坏 " + worstMs + "ms（>120ms 共 " + slow + " 次，平均 " + (sum / Math.max(1, turns)).toFixed(1) + "ms）最坏手牌 " + worstHand);
}
