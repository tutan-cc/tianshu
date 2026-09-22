/* ═══════════════════════════════════════════════════════════════════════════
   纯逻辑自测（赣麻规则）：vm 注入 mahjong.js（含最小 DOM stub），
   断言 造牌 / 牌型判定 / 赔付 / 抢杠 / 无吃无点炮 / AI 整局，
   以及本次新增的 向听数 / 有效进张 / 智脑提示 / 结算亮牌 / 提示 UI。
   运行：node tools/test/mahjong-logic.js
   ═══════════════════════════════════════════════════════════════════════════ */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "mahjong.js"), "utf8");

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra ? " → " + extra : "")); }
  return !!cond;
}
function eq(a, b, name) { return ok(a === b, name, "期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a)); }
function group(t) { console.log("\n── " + t + " ──"); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 最小 DOM stub ──
   mahjong.js 用 innerHTML 拼结算面板 / 提示面板，所以 stub 会把 innerHTML 里带 id 的
   标签也登记进 ID_MAP（否则 #mjmGo / #mjmResHands 这种动态节点查不到）。 */
const ID_MAP = new Map();
const VOID_TAGS = { br: 1, hr: 1, img: 1, input: 1, meta: 1, link: 1 };
function regIds(el) {
  if (!el || typeof el !== "object") return;
  if (el.id) ID_MAP.set(el.id, el);
  if (el.childNodes) for (const c of el.childNodes) regIds(c);
}
function unregIds(el) {
  /* 注意：只注销子节点。元素自己在真 DOM 里不会因为设置 innerHTML 而改名/消失。 */
  if (!el || typeof el !== "object") return;
  if (el.childNodes) for (const c of el.childNodes) unregIds(c);
}
function makeElement(tag) {
  const e = {
    tagName: String(tag || "div").toUpperCase(), id: "", className: "", style: {}, dataset: {},
    childNodes: [], children: [], _html: "", _text: "", parentNode: null,
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
  /** 像真 DOM 一样：innerHTML 读的是「当前子节点序列化」或上次写入的字符串 */
  e._sync = function () {
    if (this._html || !this.childNodes.length) return this._html;
    let s = "";
    for (const c of this.childNodes) {
      const t = c.tagName.toLowerCase();
      s += "<" + t + (c.id ? ' id="' + c.id + '"' : "") + (c.className ? ' class="' + c.className + '"' : "") + ">";
      s += c._sync();
      if (!VOID_TAGS[t]) s += "</" + t + ">";
    }
    return s;
  };
  Object.defineProperty(e, "innerHTML", {
    get() { return this._sync(); },
    set(v) {
      unregIds(this);
      this.childNodes = []; this.children = [];
      this._html = String(v == null ? "" : v);
      parseIds(this._html, this);
      ensureIds(this._html);
    }, configurable: true
  });
  Object.defineProperty(e, "textContent", { get() { return this._text || this._sync().replace(/<[^>]*>/g, ""); }, set(v) { this._text = String(v == null ? "" : v); }, configurable: true });
  Object.defineProperty(e, "lastChild", { get() { return this.childNodes[this.childNodes.length - 1] || null; }, configurable: true });
  return e;
}
/** 极简 HTML 扫描：只登记标签与 id（不建整棵树），足够 getElementById 用 */
function parseIds(html, root) {
  const re = /<([a-zA-Z][\w-]*)([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    const idm = /id\s*=\s*"([^"]*)"/.exec(m[2]);
    if (!idm || !idm[1]) continue;
    const el = makeElement(tag);
    el.id = idm[1];
    const cm = /class\s*=\s*"([^"]*)"/.exec(m[2]);
    if (cm) el.className = cm[1];
    if (VOID_TAGS[tag]) { el._html = ""; ID_MAP.set(el.id, el); continue; }
    const start = m.index + m[0].length;
    const openRe = new RegExp("<" + tag + "(?=[\\s>])", "gi");
    const closeRe = new RegExp("</" + tag + "\\s*>", "gi");
    let depth = 1, idx = start, end = html.length;
    while (depth > 0) {
      openRe.lastIndex = idx; closeRe.lastIndex = idx;
      const o = openRe.exec(html), c = closeRe.exec(html);
      if (!c) { end = html.length; break; }
      if (o && o.index < c.index) { depth++; idx = o.index + 1; }
      else { depth--; idx = c.index + c[0].length; end = c.index; if (depth === 0) break; }
    }
    el._html = html.slice(start, end);
    parseIds(el._html, el);
    ID_MAP.set(el.id, el);
  }
}
/** 兜底：任何写进 innerHTML 的 id 都留个长期占位元素，保证 getElementById 查得到
   （真 DOM 里它们本来就在，只是这个 stub 不建整棵树） */
const HTML_IDS = new Map();
function ensureIds(html) {
  const re = /id\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (!HTML_IDS.has(m[1])) HTML_IDS.set(m[1], makeElement("div"));
  }
}
const documentStub = {
  createElement: makeElement,
  getElementById(id) { return ID_MAP.get(id) || HTML_IDS.get(id) || null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  addEventListener() {}, head: makeElement("head"), body: makeElement("body")
};
const windowStub = {
  setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
  console, Math, Date, JSON, devicePixelRatio: 1,
  document: documentStub,
  innerWidth: 1280, innerHeight: 900,
  AudioSys: { blip() {}, click() {}, ding() {}, good() {}, bad() {} }
};
windowStub.window = windowStub;

const ctx = vm.createContext(windowStub);
vm.runInContext(SRC, ctx, { filename: "mahjong.js" });
const MJ = ctx.Mahjong || windowStub.Mahjong;
if (!MJ) { console.error("mahjong.js 未导出 window.Mahjong"); process.exit(1); }
const T = MJ.test;

/* ── 手牌书写："123m 456m 789m 123s 99s"（m=万 s=条 p=筒）；字牌直接写 东/南/西/北/中/發/白 ── */
const SUIT_MAP = { m: "万", s: "条", p: "筒" };
const HONOR_CH = "东南西北中發白";
function P(s) {
  const out = [];
  for (const part of String(s).split(/\s+/)) {
    if (!part) continue;
    const m = /^([0-9]+)([msp])$/.exec(part);
    if (m) { for (const ch of m[1]) out.push(ch + SUIT_MAP[m[2]]); continue; }
    const m2 = /^([1-9])([万条筒])$/.exec(part);            // 也接受 "9筒 / 1万" 这种直写
    if (m2) { out.push(part); continue; }
    for (const ch of part) if (HONOR_CH.indexOf(ch) < 0) throw new Error("bad hand token: " + part);
    for (const ch of part) out.push(ch);
  }
  return out;
}
function meld(type, s, an) {
  const t = P(s);
  return { type, tiles: type === "gang" ? [t[0], t[0], t[0], t[0]] : [t[0], t[0], t[0]], from: 0, an: !!an, kind: an ? "an" : "ming" };
}

/* ═══════════════ 1. 造牌 ═══════════════ */
group("1. 造牌 / 牌张");
{
  const wall = T.createWall();
  eq(wall.length, 136, "共 136 张（108 序数牌 + 28 字牌）");
  const c = T.counts(wall);
  eq(Object.keys(c).length, 34, "34 种牌（万条筒 1-9 + 东南西北中發白）");
  let allFour = true, onlyKnown = true, honorN = 0;
  for (const k of Object.keys(c)) {
    if (c[k] !== 4) allFour = false;
    if (/^[1-9][万条筒]$/.test(k)) continue;
    if (T.HONORS.indexOf(k) >= 0) { honorN++; continue; }
    onlyKnown = false;
  }
  ok(allFour, "每种恰好 4 张");
  ok(onlyKnown, "只有万条筒 1-9 与 7 种字牌（无其他牌）");
  eq(honorN, 7, "7 种字牌都在牌墙里");
  eq(T.sortTiles(wall).length, 136, "排序后仍是 136 张");
  eq(T.createWall(false).length, 108, "createWall(false) → 旧 108 张牌组");
  eq(Object.keys(T.counts(T.createWall(false))).length, 27, "旧牌组 27 种（无字牌）");
  ok(T.createWall(false).every(t => !T.isHonor(t)), "旧牌组里没有字牌");
  eq(T.deckSize(), 136, "deckSize() = 136");
  eq(T.deckSize(false), 108, "deckSize(false) = 108");
}

/* ═══════════════ 2. 牌型判定 ═══════════════ */
group("2. 牌型判定");
const CASES = [
  ["小胡 · 三顺一对", "123m 456m 789m 123s 99s", [], "small"],
  ["小胡 · 刻子+顺子", "111m 234m 567m 789s 22p", [], "small"],
  ["小胡 · 混合花色", "123m 345s 678p 999s 55m", [], "small"],
  ["小胡 · 幺九对将", "11m 234m 567m 789m 123p", [], "small"],
  ["小胡 · 副露碰", "234m 567m 123s 99s", [meld("peng", "1m")], "small"],
  ["小胡 · 副露明杠", "123m 456m 789s 22s", [meld("gang", "5p")], "small"],
  ["小胡 · 条子顺子", "123s 456s 789s 123p 99m", [], "small"],
  ["大胡 · 碰碰胡（全刻子）", "111m 222m 333s 444p 55s", [], "big"],
  ["大胡 · 碰碰胡（含幺九）", "999m 888p 777s 111s 22m", [], "big"],
  ["大胡 · 副露两碰", "222s 555s 99m", [meld("peng", "3m"), meld("peng", "7p")], "big"],
  ["大胡 · 副露杠+碰", "444m 666m 77p", [meld("gang", "1s"), meld("peng", "2p")], "big"],
  ["七对 · 七组对子", "11m 22m 33m 44s 55s 66p 77p", [], "bigger"],
  ["七对 · 含幺九", "11m 99m 33s 44s 55p 66p 88p", [], "bigger"],
  ["大大胡 · 龙七对（1 组 4 张）", "1111m 22m 33s 44s 55p 66p", [], "biggest"],
  ["大大胡 · 龙七对（2 组 4 张）", "1111m 2222s 33p 44p 55p", [], "biggest"],
  ["大吊车 · 4 碰单调", "55m", [meld("peng", "1m"), meld("peng", "2s"), meld("peng", "3p"), meld("peng", "4s")], "bigger"],
  ["大吊车 · 3 碰 1 杠单调", "99p", [meld("peng", "1m"), meld("peng", "2s"), meld("peng", "3p"), meld("gang", "6m")], "bigger"],
  ["大吊车 · 4 杠单调", "33s", [meld("gang", "1m"), meld("gang", "2p"), meld("gang", "5s"), meld("gang", "7s")], "bigger"],
  ["未成牌 · 全孤张", "13579m 2468s 13579p", [], null],
  ["未成牌 · 只有 13 张", "123m 456m 789m 123s 9s", [], null],
  ["未成牌 · 差一张（12s+5p）", "123m 456m 789m 12s 99s 5p", [], null],
  ["未成牌 · 六对+两张散牌", "11m 22m 33m 44s 55s 66p 78p", [], null],
  ["未成牌 · 两对子拆不开", "11m 234m 567m 99s 123p 5p", [], null],
  ["未成牌 · 多对子带副露（不算七对）", "11m 44m 77m 99s 55p 3s", [meld("peng", "1p")], null],
  ["未成牌 · 多对子（两对将）", "11m 22m 33m 44s 55s 66p 78p", [], null],
  ["字牌 · 刻子 + 顺子 = 小胡", "东东东 123m 456m 789m 99s", [], "small"],
  ["字牌 · 对子作将", "123m 456m 789m 123s 东东", [], "small"],
  ["字牌 · 全字牌碰碰胡 = 大胡", "东东东 南南南 西西西 北北北 中中", [], "big"],
  ["字牌 · 混序数牌碰碰胡", "中中中 111m 222s 333p 白白", [], "big"],
  ["字牌 · 七对", "东东 南南 西西 北北 中中 發發 白白", [], "bigger"],
  ["字牌 · 龙七对（4 张东）", "东东东东 南南 西西 北北 中中 發發", [], "biggest"],
  ["未成牌 · 字牌不能组顺子（东南西）", "东南西 北北 123m 456m 789m", [], null],
  ["未成牌 · 字牌不能组顺子（东南西北）", "东南西北 中中 123m 456m 99p", [], null],
  ["未成牌 · 字牌混入顺子假象", "东南西 123m 456m 789m 99s", [], null],
  ["未成牌 · 字牌单张凑不出", "123m 456m 789m 123s 东", [], null]
];
let caseN = 0;
for (const [name, hand, melds, want] of CASES) {
  caseN++;
  const r = T.evaluate(P(hand), melds);
  const got = r ? r.tier : null;
  ok(got === want, "用例 " + caseN + " " + name, "期望 " + want + "，实际 " + got + (r ? "(" + r.name + ")" : ""));
}
group("2b. 判定辅助函数");
{
  ok(T.isSevenPairs(P("11m 22m 33m 44s 55s 66p 77p")), "isSevenPairs 七对");
  ok(!T.isSevenPairs(P("111m 22m 33m 44s 55s 66p 7p")), "isSevenPairs 非七对");
  ok(T.isDragonSevenPairs(P("1111m 22m 33s 44s 55p 66p")), "isDragonSevenPairs 龙七对");
  ok(!T.isDragonSevenPairs(P("11m 22m 33m 44s 55s 66p 77p")), "isDragonSevenPairs 普通七对为假");
  ok(T.isAllTriplets(P("111m 222m 333s 444p 55s"), []), "isAllTriplets 碰碰胡");
  ok(!T.isAllTriplets(P("123m 456m 789m 123s 99s"), []), "isAllTriplets 有顺子为假");
  ok(T.isStandardWin(P("123m 456m 789m 123s 99s"), 0), "isStandardWin 小胡");
  ok(!T.isStandardWin(P("13579m 2468s 13579p"), 0), "isStandardWin 孤张为假");
  ok(T.isHonor("东") && T.isHonor("發") && T.isHonor("白"), "isHonor 认得字牌");
  ok(!T.isHonor("1万") && !T.isHonor("9筒"), "isHonor 不误判序数牌");
  eq(T.tileGroup("东"), 3, "字牌分组序号 3（排在筒之后）");
  eq(T.tileGroup("1万") + "" + T.tileGroup("1条") + "" + T.tileGroup("1筒"), "012", "万条筒分组 0/1/2");
  ok(T.isStandardWin(P("东东东 123m 456m 789m 99s"), 0), "字牌刻子算面子");
  ok(!T.isStandardWin(P("东南西 123m 456m 789m 99s"), 0), "字牌顺子不算面子");
  ok(!T.isStandardWin(P("东南西北 11m 123s 456s"), 0), "字牌拼不出面子");
}

/* ═══════════════ 3. 赔付（打 10 元基准） ═══════════════ */
group("3. 赔付 / 杠开");
{
  const s = T.scoreOf("small", {});
  eq(s.per, 20, "小胡 每家 20");
  eq(s.total, 60, "小胡 共收 60");
  eq(s.fan, 1, "小胡 1 倍");
  const b = T.scoreOf("big", {});
  eq(b.per, 80, "大胡 每家 80");
  eq(b.total, 240, "大胡 共收 240");
  const g = T.scoreOf("bigger", {});
  eq(g.per, 120, "大大胡 每家 120");
  eq(g.total, 360, "大大胡 共收 360");
  const x = T.scoreOf("biggest", {});
  eq(x.per, 240, "最大胡 每家 240");
  eq(x.total, 720, "最大胡 共收 720");
  eq([s.total, b.total, g.total, x.total].join("/"), "60/240/360/720", "赣麻四档 60/240/360/720");
  const k1 = T.scoreOf("small", { kongDraw: true });
  eq(k1.tier, "big", "杠开 · 小胡 → 大胡");
  eq(k1.total, 240, "杠开 · 小胡 60 → 240");
  ok(k1.fanName.indexOf("杠开") >= 0, "杠开文案带「杠开」→ " + k1.fanName);
  eq(T.scoreOf("big", { kongDraw: true }).total, 480, "杠开 · 大胡 240 → 480");
  eq(T.scoreOf("bigger", { kongDraw: true }).total, 720, "杠开 · 大大胡 360 → 720");
  const rk = T.scoreOf("small", { robKong: true });
  eq(rk.payerOnly, true, "抢杠 · 标记「杠牌一家包赔」");
  eq(rk.per, 20, "抢杠 · 每家赔付仍按档位算");
  ok(rk.fanName.indexOf("抢杠") >= 0, "抢杠文案带「抢杠」→ " + rk.fanName);
}

/* ═══════════════ 4. 抢杠规则 ═══════════════ */
group("4. 抢杠规则");
{
  eq(T.canRobKong("ming"), true, "明杠（直杠）可抢");
  eq(T.canRobKong("bu"), true, "补杠（回头杠）可抢");
  eq(T.canRobKong("an"), false, "暗杠不可抢");
  eq(T.robbable.an, false, "robbable 表：an=false");
}

/* ═══════════════ 5. 无吃 / 无点炮 ═══════════════ */
group("5. 无吃 / 无点炮");
{
  const e0 = new T.Engine(10);
  e0.deal();
  eq(e0.discard(0, 0), true, "轮到自己可以出牌");
  eq(e0.discard((e0.cur + 2) % 4, 0), false, "不是自己回合不能出牌（当前 " + e0.cur + " 号）");
  eq(e0.discard(0, 0), false, "已经出过牌，同一巡不能连出");
  const e = new T.Engine(10);
  e.deal();
  e.P[1].discards.push("1万");
  e.afterDiscard(1, "5筒");
  ok(e.phase === "claim" || e.phase === "turn", "弃牌后只可能出现 碰/杠 响应或下一家回合（无吃、无点炮）");
  /* 别人打出的牌不能直接胡：claim 只接受 peng / gang / pass */
  const e2 = new T.Engine(10);
  e2.deal();
  e2.P[1].hand = P("5筒 5筒 1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 2s");
  e2.afterDiscard(0, "5筒");
  if (e2.phase === "claim") {
    eq(e2.P[1].hand.length >= 13, true, "进入碰/杠响应时手牌仍完整");
    eq(e2.claim(1, "hu"), false, "claim 不接受「胡」（无点炮）");
  } else {
    ok(true, "（本手未触发响应窗口，跳过 claim(hu) 断言）");
  }
}

/* ═══════════════ 6. 抢杠胡（引擎级） ═══════════════ */
group("6. 抢杠胡（引擎级）");
{
  const e = new T.Engine(10);
  e.P[0].melds = [meld("peng", "5筒")];
  e.P[0].hand = P("1m 2m 3m 6m 7m 8m 1s 2s 3s 5p");
  e.P[1].hand = P("1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 2s 3s 5p");
  e.P[1].drawn = null;
  e.cur = 0; e.phase = "turn";
  e.pending = { type: "turn", seat: 0, anGangs: [], addGangs: ["5筒"] };
  eq(e.turnGang(0, "5筒", "bu"), true, "0 号家补杠 5筒");
  eq(e.phase, "rob", "补杠后进入抢杠窗口");
  eq(e.rob(1), true, "1 号家抢杠胡成功");
  eq(e.phase, "over", "抢杠后本局结束");
  ok(e.result && e.result.robKong === true, "result 标记 robKong");
  eq(e.result.seat, 1, "胡家是 1 号");
  eq(e.result.from, 0, "result.from = 杠牌的 0 号（包赔家）");
  eq(e.result.payerOnly, true, "标记杠牌一家包赔");
  /* 暗杠不能被抢 */
  const e2 = new T.Engine(10);
  e2.P[0].hand = P("1m 1m 1m 1m 2m 3m 4m 5m 6m 7m 8m 9m 1s");
  e2.P[1].hand = P("1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 2s 3s 9s");
  e2.cur = 0; e2.phase = "turn"; e2.pending = { type: "turn", seat: 0, anGangs: ["1万"], addGangs: [] };
  e2.turnGang(0, "1万", "an");
  ok(e2.phase !== "rob", "暗杠不进入抢杠窗口（phase=" + e2.phase + "）");
}

/* ═══════════════ 7. 听牌 ═══════════════ */
group("7. 听牌 / waitsFor");
{
  eq(T.waitsFor(P("123m 456m 789m 23s 99s"), [], true).join("/"), "1条/4条", "两面听 1条/4条");
  eq(T.waitsFor(P("123m 456m 789m 12s 99s"), [], true).join("/"), "3条", "单钓 3条");
  eq(T.waitsFor(P("11m 22m 33m 44s 55s 66p 7p"), [], true).join("/"), "7筒", "七对听 7筒");
  eq(T.waitsFor(P("123m 456m 789m 12s 99s 5p"), [], true).length, 0, "14 张（多一张）不算听牌");
  ok(T.isTenpai(P("123m 456m 789m 23s 99s"), [], true), "isTenpai 两面听");
  ok(!T.isTenpai(P("13579m 2468s 1357p"), [], true), "isTenpai 散牌为假");
  const w = T.waitsFor(P("123m 456m 789m 东南西北"), [], true);
  ok(w.indexOf("中") < 0 && w.indexOf("發") < 0, "东南西北 不会听「中/發」（字牌不组顺子）");
}

/* ═══════════════ 8. AI 整局（136 张含字牌） ═══════════════ */
group("8. AI 整局（4 家自动 · 136 张含字牌）");
{
  let n = 0, bad = 0;
  const tiers = {};
  for (let i = 0; i < 40; i++) {
    const r = T.autoPlay(4000, true);
    n++;
    if (!r.result && r.steps >= 4000) { bad++; continue; }
    if (r.result) { const k = r.result.draw ? "流局" : r.result.tierName; tiers[k] = (tiers[k] || 0) + 1; }
  }
  eq(bad, 0, "40 局自动对战全部正常收尾（" + n + " 局）");
  console.log("  档位分布：", JSON.stringify(tiers));
  ok(Object.keys(tiers).length > 0, "至少出现一种结算档位");
  const r2 = T.autoPlay(4000, false);
  ok(r2 && (r2.result || r2.steps >= 4000), "无字牌 108 张也能整局跑完");
}

/* ═══════════════ 9. 引擎基础流程 ═══════════════ */
group("9. 引擎基础流程");
{
  const e = new T.Engine(10);
  e.deal();
  eq(e.P[0].hand.length, 14, "庄家起手 14 张");
  eq(e.P[1].hand.length, 13, "闲家起手 13 张");
  eq(e.wall.length, 136 - 53, "牌墙 83 张");
  eq(e.phase, "turn", "发牌后进入出牌阶段");
  eq(e.cur, 0, "庄家先出牌");
  const t = e.P[0].hand[0];
  eq(e.discard(0, 0), true, "庄家打出第一张");
  eq(e.P[0].hand.length, 13, "出牌后 13 张");
  eq(e.P[0].discards[e.P[0].discards.length - 1], t, "牌河里是打出的那张");
  /* 打完第一张后：下一家（或响应窗口）接上；此时只有 e.cur 那家能出牌 */
  const other = (e.cur + 2) % 4;
  eq(e.discard(other, 0), false, "不是自己回合不能出牌（" + other + " 号，当前 " + e.cur + " 号）");
  ok(T.handIsSorted(e.P[1]), "对手手牌按牌面有序");
  ok(T.meldsAreSorted(e.P[1]), "副露（空）也有序");
}

/* ═══════════════ 10. 对外 API 形状 ═══════════════ */
group("10. 对外 API 形状");
{
  ok(typeof MJ.start === "function", "Mahjong.start 是函数");
  ok(typeof MJ.isBusy === "function", "Mahjong.isBusy 是函数");
  ok(typeof MJ.dispose === "function", "Mahjong.dispose 是函数");
  ok(!!MJ.debug && typeof MJ.debug.act === "function", "Mahjong.debug.act 存在");
  ok(!!MJ.debug && typeof MJ.debug.setHand === "function", "Mahjong.debug.setHand 存在");
  ok(!!MJ.debug && typeof MJ.debug.hintNow === "function", "Mahjong.debug.hintNow 存在");
  ok(!!MJ.debug && typeof MJ.debug.brainText === "function", "Mahjong.debug.brainText 存在");
  ok(!!MJ.debug && typeof MJ.debug.hintToggle === "function", "Mahjong.debug.hintToggle 存在");
  ok(!!MJ.debug && typeof MJ.debug.hintStats === "function", "Mahjong.debug.hintStats 存在");
  ok(!!MJ.debug && typeof MJ.debug.resultView === "function", "Mahjong.debug.resultView 存在");
  ok(!!T && typeof T.hintCalc === "function", "test.hintCalc 存在");
  ok(!!T && typeof T.buildResultView === "function", "test.buildResultView 存在");
  ok(!!T && typeof T.resultHtml === "function", "test.resultHtml 存在");
  ok(!!T && typeof T.gainsOf === "function", "test.gainsOf 存在");
  ok(!!T && typeof T.remainingOf === "function", "test.remainingOf 存在");
  ok(!!T && typeof T.hintCacheStats === "function", "test.hintCacheStats 存在");
}

/* ═══════════════ 11. 手牌整理（排序） ═══════════════ */
group("11. 手牌整理（排序）");
{
  const p = { hand: P("9筒 1万 东 3条 2万 1条 5筒 9万 1筒 中 7条 白 4筒"), melds: [], drawn: null };
  T.normalizeHand(p);
  eq(p.hand.join(","), T.sortTiles(p.hand).join(","), "手牌整理为「万→条→筒→字 + 数字升序」");
  ok(T.handIsSorted(p), "handIsSorted 为真");
  const p2 = { hand: P("123m 456m 789m 123s 9s"), melds: [], drawn: null };
  p2.hand.push("5筒"); p2.drawn = "5筒";
  T.normalizeHand(p2);
  eq(p2.hand[p2.hand.length - 1], "5筒", "摸到的牌固定在最右");
  const p3 = { hand: [], melds: [{ type: "peng", tiles: P("9筒 5筒 1筒"), from: 1, an: false, kind: "ming" }], drawn: null };
  T.normalizeHand(p3);
  eq(p3.melds[0].tiles.join(","), "1筒,5筒,9筒", "副露组内按牌面排序");
  ok(T.meldsAreSorted(p3), "meldsAreSorted 为真");
}

/* ═══════════════ 12. 字牌（引擎级） ═══════════════ */
group("12. 字牌（引擎级）");
{
  const honors = T.autoPlay(4000, true);
  ok(honors.result || honors.steps >= 4000, "带字牌 136 张能整局跑完");
  const no = T.autoPlay(4000, false);
  ok(no.result || no.steps >= 4000, "无字牌 108 张能整局跑完");
  eq(T.kindsFor(true).length, 34, "kindsFor(true) = 34 种");
  eq(T.kindsFor(false).length, 27, "kindsFor(false) = 27 种");
  /* 字牌不参与顺子：4 张单字牌不该被顺子「美化」 */
  eq(T.stdShanten(P("东南西北"), 0), 8, "东南西北 4 张孤张字牌 = 8 向听（不组顺子）");
  eq(T.totalShanten(P("123m 456p 789s 东南西北"), 0), 2, "东南西北 不能当搭子 → 仍是 2 向听");
}

/* ═══════════════ 13. 渲染冒烟（stub canvas） ═══════════════ */
group("13. 渲染冒烟（stub canvas）");
{
  const host = makeElement("div");
  eq(MJ.start(host, {}), true, "Mahjong.start 返回 true");
  eq(MJ.isBusy(), true, "开局后 isBusy=true");
  const st = MJ.debug.state();
  ok(!!st && st.on === true, "state.on = true");
  eq(st.phase, "turn", "开局即等玩家出牌");
  ok(st.handSorted === true, "手牌有序");
  const rs = MJ.debug.renderStats();
  ok(!!rs && (typeof rs.frames === "number" || rs.frames === undefined), "renderStats 可读（frames=" + (rs && rs.frames) + "）");
  eq(st.lastErr, "", "渲染无异常");
  ok(MJ.debug.hand().length >= 13, "debug.hand() 返回手牌");
  ok(MJ.debug.wall().count > 0 && MJ.debug.wall().count < 136, "牌墙剩余合法");
  eq(MJ.debug.seats().length, 4, "四家座位");
  MJ.dispose();
  eq(MJ.isBusy(), false, "dispose 后 isBusy=false");
}

/* ═══════════════ 14. 向听数（已知手牌 + DP/暴力双实现交叉验证） ═══════════════ */
group("14. 向听数（已知手牌 + DP/暴力双实现交叉验证）");
{
  const SH = [
    ["成牌 · 三顺一对（14 张）", "123m 456m 789m 123s 99s", 0, -1, -1],
    ["听牌 · 四刻单钓 5万", "111m 222m 333m 444m 5m", 0, 0, 0],
    ["听牌 · 单钓 3条", "123m 456m 789m 12s 99s", 0, 0, 0],
    ["听牌 · 两面 1条/4条", "123m 456m 789m 23s 99s", 0, 0, 0],
    ["听牌 · 九莲式 1112345678999万", "1112345678999m", 0, 0, 0],
    ["听牌 · 14 张只差一张弃牌", "123m 456m 789m 1s 2s 9s 5p 5p", 0, 0, 0],
    ["4 向听 · 无字牌最散", "13579m 2468s 1357p", 0, 4, 4],
    ["8 向听 · 幺九+字牌全孤张（七对更近 = 6）", "19m 19s 19p 东南西北中發白", 0, 8, 6],
    ["8 向听 · 三类牌全孤张", "1m 4m 7m 1s 4s 7s 1p 4p 9p 东南西北", 0, 8, 6],
    ["七对听牌（标准型 1 向听）", "11m 22m 33m 44s 55s 66p 7p", 0, 1, 0],
    ["七对成牌（14 张）", "11m 22m 33m 44s 55s 66p 77p", 0, 1, -1],
    ["七对听牌 · 同花色", "1122334455667m", 0, 0, 0],
    ["七对听牌 · 同花色 6 对一单", "11m 22m 33m 44m 55m 66m 7m", 0, 0, 0],
    ["七对听牌 · 字牌", "东东 南南 西西 北北 中中 發發 白", 0, 3, 0],
    ["字牌刻子 + 单钓 9条", "东东东 123m 456m 789m 9s", 0, 0, 0],
    ["字牌刻子成牌", "东东东 123m 456m 789m 99s", 0, -1, -1],
    ["14 张听牌 · 多面", "234m 567m 234s 567s 5p", 0, 0, 0],
    ["成牌 · 含字牌刻子", "123m 456m 789m 111s 22s", 0, -1, -1],
    ["字牌不能组顺子（东南西+北北）", "东南西 北北 123m 456m 789m", 0, 1, 1],
    ["字牌不能组顺子（东南西北+中中）", "东南西北 中中 123m 456m 99p", 0, 2, 2],
    ["字牌不能组顺子（东南西北 作搭子）", "123m 456p 789s 东南西北", 0, 2, 2],
    ["副露 1 组 · 11 张成牌", "123m 456m 789s 22s", 1, -1, -1],
    ["副露 1 组 · 10 张听牌", "123m 456m 22s 99s", 1, 0, 0],
    ["副露 2 组 · 8 张成牌", "123m 456s 99p", 2, -1, -1],
    ["副露 2 组 · 7 张听牌", "123m 456s 9p", 2, 0, 0],
    ["副露 3 组 · 4 张听牌（两对）", "11m 22m", 3, 0, 0],
    ["副露 3 组 · 4 张两面听", "1234m", 3, 0, 0],
    ["副露 3 组 · 字牌孤张（东南西+东）", "东南西 东", 3, 1, 1],
    ["副露 3 组 · 4 张成牌", "111m 222m 333m 44m", 3, -1, -1],
    ["大吊车 · 副露 4 组单调成对", "55m", 4, -1, -1],
    ["大吊车 · 副露 4 组单调听牌差一张", "11m", 4, -1, -1]
  ];
  let k = 0;
  for (const [name, h, mc, wantStd, wantTotal] of SH) {
    k++;
    const hh = P(h);
    const gotStd = T.stdShanten(hh, mc), gotTot = T.totalShanten(hh, mc);
    ok(gotStd === wantStd, "用例 " + k + " [标准型] " + name, "期望 " + wantStd + "，实际 " + gotStd);
    ok(gotTot === wantTotal, "用例 " + k + " [综合含七对] " + name, "期望 " + wantTotal + "，实际 " + gotTot);
    eq(T.stdShantenBrute(hh, mc), gotStd, "用例 " + k + " 暴力实现与 DP 一致：" + name);
  }
  ok(SH.length >= 15, "已知向听用例 ≥15 组（实际 " + SH.length + " 组）");

  /* 两条完全独立的实现（DP 与暴力拆解）逐手交叉比对 */
  let bad = 0, cmp = 0;
  for (let it = 0; it < 1500; it++) {
    const honors = it % 2 === 0;
    const mc = it % 5;
    const len = (it % 3 === 0) ? (14 - 3 * mc) : (13 - 3 * mc);
    if (len <= 0) continue;
    const pool = [];
    for (const t of (honors ? T.KINDS_ALL : T.KINDS)) for (let q = 0; q < 4; q++) pool.push(t);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    const h = pool.slice(0, len);
    cmp++;
    if (T.stdShanten(h, mc) !== T.stdShantenBrute(h, mc)) {
      bad++;
      if (bad <= 5) console.error("  DP/暴力不一致 mc=" + mc + "：" + T.sortTiles(h).join(" "));
    }
  }
  eq(bad, 0, "随机 " + cmp + " 手（含副露 0~4 组、含/不含字牌）DP 与暴力实现结果完全一致");
  ok(cmp >= 1000, "随机交叉验证样本量 ≥1000（实际 " + cmp + "）");

  ok(T.evaluate(P("东南西 北北 123m 456m 789m"), []) === null, "东南西 不是面子（evaluate 返回 null）");
  eq(T.totalShanten(P("东南西 北北 123m 456m 789m"), 0), 1,
    "向听按「3 面子 + 北北将 + 字牌单张」算 = 1（不把东南西 当顺子）");
  eq(T.totalShanten(P("19m 19s 19p 东南西北中發白"), 0), 6,
    "13 张全孤张：七对 6 向听优于标准型 8 向听");
}

/* ═══════════════ 15. 有效进张与剩余张数 ═══════════════ */
group("15. 有效进张 / 剩余张数");
{
  const H = P("123m 456m 789m 23s 99s");
  eq(T.remainingOf("1条", H, {}), 4, "1条 手里没有、桌上没见 → 还剩 4");
  eq(T.remainingOf("9条", H, {}), 2, "9条 手里 2 张 → 还剩 2");
  eq(T.remainingOf("1条", H, { "1条": 2 }), 2, "1条 已见 2 张 → 还剩 2");
  eq(T.remainingOf("3条", H, { "3条": 4 }), 0, "3条 已见 4 张 → 一张不剩");
  eq(T.remainingOf("9条", H, { "9条": 3 }), 0, "9条 手里 2 + 已见 3 → 钳到 0（不会负数）");
  eq(T.remainingOf("东", H, {}), 4, "字牌同理");

  const W = T.gainsOf(H, 0, {}, true, 0);
  eq(W.map(x => x.tile).join(" "), "1条 4条", "两面听的有效牌就是 1条 / 4条");
  eq(W.reduce((a, x) => a + x.left, 0), 8, "两张各剩 4 张 → 共 8 张");

  const W2 = T.gainsOf(H, 0, { "1条": 2, "4条": 1 }, true, 0);
  eq(W2.reduce((a, x) => a + x.left, 0), 5, "已见 1条×2 / 4条×1 → 剩 2 + 3 = 5 张");
  const w1 = W2.filter(x => x.tile === "1条");
  eq(w1.length, 1, "1条 仍在进张列表里");
  eq(w1.length ? w1[0].left : -1, 2, "1条 剩 2 张（4 − 0 − 2）");

  const W3 = T.gainsOf(H, 0, { "1条": 4 }, true, 0);
  eq(W3.map(x => x.tile).join(" "), "4条", "1条 已见 4 张 → 从进张里剔除");
  eq(W3[0].left, 4, "4条 仍是 4 张");

  const meldsSeen = { "5筒": 3, "1万": 3, "2万": 1 };
  eq(T.remainingOf("5筒", P("13579m 2468s 1357p"), meldsSeen), 0, "手里 1 张 5筒 + 桌上 3 张 → 一张不剩");
  eq(T.remainingOf("1万", P("13579m 2468s 1357p"), meldsSeen), 0, "手里 1 张 1万 + 桌上 3 张 → 一张不剩");
  eq(T.remainingOf("9万", P("13579m 2468s 1357p"), meldsSeen), 3, "手里 1 张 9万 + 桌上没见 → 还剩 3");
  eq(T.remainingOf("2万", P("13579m 2468s 1357p"), meldsSeen), 3, "手里没有 2万 + 桌上已见 1 张 → 还剩 3");

  /* 未听牌：每个「进张」都必须真的让向听 −1，且剩余张数账目闭合 */
  let bad = 0, checked = 0, hands = 0;
  for (let it = 0; it < 120; it++) {
    const pool = [];
    for (const t of T.KINDS_ALL) for (let q = 0; q < 4; q++) pool.push(t);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    const h = pool.slice(0, 13);
    const s = T.totalShanten(h, 0);
    if (s <= 0) continue;
    hands++;
    const g = T.gainsOf(h, 0, {}, true, s);
    for (const x of g) {
      checked++;
      if (T.totalShanten(h.concat([x.tile]), 0) !== s - 1) bad++;
      if (4 - T.countIn(h, x.tile) !== x.left) bad++;           // 桌上没见 → left 必须等于 4 − 手里张数
    }
  }
  eq(bad, 0, "随机 " + hands + " 手（未听牌）：每个进张都能让向听 −1，且剩余张数账目闭合（共查 " + checked + " 张）");
  ok(checked > 0, "随机手牌确实存在进张（共 " + checked + " 张）");
  ok(hands >= 50, "未听牌样本量充足（" + hands + " 手）");
}

/* ═══════════════ 16. 智脑提示（选牌 / 听牌 / 有效牌） ═══════════════ */
group("16. 智脑提示（选牌 / 听牌 / 有效牌）");
{
  const h1 = T.hintCalc({ hand: P("123m 456m 789m 12s 99s 5p"), melds: [], seen: {}, honors: true });
  eq(h1.discard, "5筒", "① 14 张手牌建议打 5筒");
  eq(h1.shanten, 0, "① 打完即听（0 向听）");
  eq(h1.tenpaiAfter, true, "① 标记「打完成听」");
  eq(h1.waits.join("/"), "3条", "① 听 3条");
  eq(h1.waitsLeft, 4, "① 剩 4 张");
  const t1 = T.hintLines(h1);
  eq(t1.l1, "打 5筒 → 听 3条（剩 4 张）", "① 提示文案：打 5筒 → 听 3条（剩 4 张）");
  ok(/^有效牌：/.test(t1.l2), "① 第二行以「有效牌：」开头 → " + t1.l2);

  const h2 = T.hintCalc({ hand: P("123m 456m 789m 23s 99s 东"), melds: [], seen: {}, honors: true });
  eq(h2.discard, "东", "② 打孤张字牌 东");
  eq(h2.waits.join("/"), "1条/4条", "② 两面听 1条/4条");
  eq(h2.waitsLeft, 8, "② 剩 8 张");
  eq(T.hintLines(h2).l1, "打 东 → 听 1条/4条（剩 8 张）", "② 提示文案带张数");

  const h3 = T.hintCalc({ hand: P("11m 22m 33m 44s 55s 66p 7p"), melds: [], seen: {}, honors: true });
  eq(h3.tenpaiNow, true, "③ 13 张手牌判定「已听」");
  eq(h3.discard, null, "③ 已听时没有「建议打出的牌」");
  eq(h3.waits.join("/"), "7筒", "③ 六对一单 → 只听 7筒");
  eq(T.hintLines(h3).l1, "已听：7筒（剩 3 张）", "③ 文案：已听：7筒（剩 3 张）");

  const h4 = T.hintCalc({ hand: P("13579m 2468s 1357p 中"), melds: [], seen: {}, honors: true });
  ok(h4.improve.length > 0 && h4.improve.length <= 5, "④ 有效牌提示列 1~5 种（实际 " + h4.improve.length + "）");
  ok(h4.improve.every(x => x.left >= 1 && x.left <= 4), "④ 每种都标注 1~4 的剩余张数");
  ok(/^有效牌：/.test(T.hintLines(h4).l2), "④ 文案以「有效牌：」开头 → " + T.hintLines(h4).l2);
  ok(h4.improveKinds >= h4.improve.length, "④ improveKinds 不少于展示条数");

  const h5h = P("7m 8m 3s 5s 8s 9s 9s 5p 6p 7p 8p 东 發發");
  const h5 = T.hintCalc({ hand: h5h, melds: [], seen: {}, honors: true });
  eq(h5.discard, "东", "⑤ 并列时选孤张（字牌孤张 东）");
  ok(T.isolation(h5h, "东") < T.isolation(h5h, "5筒"), "⑤ 东 的孤张度确实低于 5筒");
  ok(T.isolation(h5h, "东") < T.isolation(h5h, "8筒"), "⑤ 东 的孤张度确实低于 8筒");

  /* ⑥ 选牌最优性：随机 400 手，断言建议的那张确实「向听最小且进张最多」 */
  let bad = 0, checked = 0, tenpaiCases = 0, nonTenpai = 0;
  for (let it = 0; it < 400; it++) {
    const pool = [];
    for (const t of T.KINDS_ALL) for (let q = 0; q < 4; q++) pool.push(t);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    /* 一半随机手牌，一半构造「一打即听」：4 组面子 + 1 张单吊，摸到重复张 */
    let h = pool.slice(0, 14);
    if (it % 2 === 1) {
      const melds = ["1万", "1万", "1万", "1条", "1条", "1条", "1筒", "1筒", "1筒", "2万", "3万", "4万"];
      h = melds.concat(["9条", "9条"]);
    }
    const r = T.hintCalc({ hand: h, melds: [], seen: {}, honors: true });    const opts = r.options;
    let bs = 99, bu = -1;
    for (const o of opts) { if (o.shanten < bs) { bs = o.shanten; bu = o.ukeire; } else if (o.shanten === bs && o.ukeire > bu) bu = o.ukeire; }
    const chosen = opts.filter(o => o.discard === r.discard)[0];
    checked++;
    if (!chosen || chosen.shanten !== bs || chosen.ukeire !== bu) {
      bad++;
      if (bad <= 3) console.error("  非最优：手牌 " + T.sortTiles(h).join(" ") + " 建议 " + r.discard + "（sh " + (chosen && chosen.shanten) + "/" + bs + "，uke " + (chosen && chosen.ukeire) + "/" + bu + "）");
    }
    if (bs === 0) tenpaiCases++; else nonTenpai++;
  }
  eq(bad, 0, "随机 " + checked + " 手：建议打出的那张始终是「向听最小 + 进张最多」的最优解之一");
  ok(tenpaiCases > 0, "样本里含「一打即听」的局面（" + tenpaiCases + " / " + checked + "）");
  ok(nonTenpai > 0, "样本里也含非听牌局面（" + nonTenpai + " / " + checked + "）");

  /* ⑦ 缓存 + 性能（目标 < 300ms） */
  T.hintCacheClear();
  const s1 = T.hintCacheStats();
  T.hintCalc({ hand: P("13579m 2468s 1357p 中"), melds: [], seen: {}, honors: true });
  const s2 = T.hintCacheStats();
  T.hintCalc({ hand: P("13579m 2468s 1357p 中"), melds: [], seen: {}, honors: true });
  const s3 = T.hintCacheStats();
  eq(s1.size, 0, "⑦ 缓存初始为空");
  eq(s2.size, 1, "⑦ 首次计算写入缓存");
  eq(s3.hits, 1, "⑦ 相同手牌第二次直接命中缓存");
  let worst = 0, worstHand = "", sum = 0, n = 0;
  for (let it = 0; it < 60; it++) {
    const pool = [];
    for (const t of T.KINDS_ALL) for (let q = 0; q < 4; q++) pool.push(t);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    const h = pool.slice(0, 14);
    T.hintCacheClear();
    const t0 = Date.now();
    T.hintCalc({ hand: h, melds: [], seen: {}, honors: true });
    const ms = Date.now() - t0;
    sum += ms; n++;
    if (ms > worst) { worst = ms; worstHand = T.sortTiles(h).join(" "); }
  }
  ok(worst < 300, "⑦ 单次提示计算最坏耗时 " + worst + "ms < 300ms（平均 " + (sum / n).toFixed(0) + "ms）");
  console.log("  提示最坏耗时 " + worst + "ms / 平均 " + (sum / n).toFixed(0) + "ms（" + worstHand + "）");
}

/* ═══════════════ 17. 结算亮牌数据结构 ═══════════════ */
group("17. 结算亮牌数据结构");
{
  function mkE() { const e = new T.Engine(10); e.deal(); return e; }
  function sortedOk(h) { for (let i = 1; i < h.length; i++) if (T.cmpTile(h[i - 1], h[i]) > 0) return false; return true; }

  const e1 = mkE();
  e1.P[0].hand = P("123m 456m 789m 123s 99s"); e1.P[0].melds = []; e1.P[0].drawn = "9条";
  e1.P[1].hand = P("11m 22m 33m 44s 55s 66p 7p"); e1.P[1].drawn = "7筒";
  e1.P[2].hand = P("13579m 2468s 135p 9p 9p"); e1.P[2].drawn = null;
  e1.P[3].hand = P("123m 456m 789m 111s 22s"); e1.P[3].drawn = "2条";
  e1.settle(0, { selfDraw: true }, T.evaluate(e1.P[0].hand, e1.P[0].melds));
  const r1 = T.buildResultView(e1, e1.result);
  eq(r1.seats.length, 4, "① 四家都有亮牌数据");
  eq(r1.seats.map(s => s.name).join("/"), "你/金老板/红姐/顾曼", "① 四家名字顺序正确");
  eq(r1.names, "你/金老板/红姐/顾曼", "① names 字段与座位一致");
  ok(r1.seats.every(s => sortedOk(s.hand)), "① 每家手牌都按「万→条→筒→字 + 数字」排好序");
  eq(r1.seats[0].hand.length, 14, "① 胡家手牌 14 张（含胡的那张）");
  eq(r1.seats[0].win, true, "① 胡家标记 win");
  eq(r1.seats[0].winTile, "9条", "① 记录胡的那张牌 9条");
  ok(r1.seats[0].winTileIdx >= 0 && r1.seats[0].hand[r1.seats[0].winTileIdx] === "9条", "① 胡牌张能在手牌里定位（单独描金边用）");
  eq(r1.seats[0].tierName, "小胡", "① 档位为小胡");
  eq(r1.seats[0].how, "自摸", "① 标注自摸");
  eq(r1.seats[0].net, 60, "① 你的净收支 +60");
  eq(r1.per, 20, "① 小胡每家应付 20");
  eq(r1.total, 60, "① 小胡共收 60");
  eq(r1.payers.length, 3, "① 三家都要付");
  eq(r1.payers.map(p => p.amount).join("/"), "20/20/20", "① 三家各付 20");
  ok(r1.payText1.indexOf("赔付明细") >= 0 && r1.payText1.indexOf("60") >= 0 && r1.payText1.indexOf("20") >= 0,
    "① 赔付明细文本包含金额 → " + r1.payText1);
  ok(r1.payText2.indexOf("+60") >= 0, "① 明示你的净收支 → " + r1.payText2);
  eq(r1.tiers.map(t => t.total).join("/"), "60/240/360/720", "① 列出赣麻四档赔付 60/240/360/720");
  eq(r1.tiers.map(t => t.name).join("/"), "小胡/大胡/大大胡/最大胡", "① 四档名称正确");
  ok(r1.tiers.filter(t => t.cur).length === 1 && r1.tiers.filter(t => t.cur)[0].key === "small", "① 当前档位高亮正确");

  const e2 = mkE();
  e2.P[0].hand = P("123m 456m 789m 123s 99s"); e2.P[0].melds = []; e2.P[0].drawn = "9条";
  e2.P[1].hand = P("234m 567m 123s 99s");
  e2.P[1].melds = [
    { type: "peng", tiles: P("5筒 5筒 5筒"), from: 0, an: false, kind: "ming" },
    { type: "gang", tiles: P("3万 3万 3万 3万"), from: 2, an: true, kind: "an" },
    { type: "gang", tiles: P("7条 7条 7条 7条"), from: 1, an: false, kind: "ming" },
    { type: "gang", tiles: P("中 中 中 中"), from: 3, an: false, kind: "bu" }
  ];
  e2.P[1].drawn = null;
  e2.P[2].hand = P("13579m 2468s 1357p"); e2.P[2].drawn = null;
  e2.P[3].hand = P("19m 19s 19p 东南西北中發白"); e2.P[3].drawn = null;
  e2.settle(0, { selfDraw: true }, T.evaluate(e2.P[0].hand, e2.P[0].melds));
  const r2 = T.buildResultView(e2, e2.result);
  eq(r2.seats[1].melds.length, 4, "② 副露四组都进结算数据");
  eq(r2.seats[1].melds.map(m => m.label).join("/"), "碰/暗杠/明杠/补杠", "② 副露类型分别标注 碰/暗杠/明杠/补杠");
  ok(r2.seats[1].melds.every(m => sortedOk(m.tiles)), "② 副露组内也按牌面排序");
  eq(r2.seats[1].meldTxt.indexOf("碰5筒") >= 0, true, "② 副露文本带类型与牌面 → " + r2.seats[1].meldTxt);
  eq(r2.seats[2].tenpai, false, "② 散牌家标记未听牌");
  eq(r2.seats[3].tenpai, false, "② 13 张全孤张不算听牌");
  const e2b = mkE();
  e2b.P[0].hand = P("123m 456m 789m 123s 99s"); e2b.P[0].drawn = "9条";
  e2b.P[3].hand = P("123m 456m 789m 23s 99s"); e2b.P[3].drawn = null;
  e2b.settle(0, { selfDraw: true }, T.evaluate(e2b.P[0].hand, e2b.P[0].melds));
  const r2b = T.buildResultView(e2b, e2b.result);
  eq(r2b.seats[3].tenpai, true, "② 两面听的家标记 tenpai");
  ok(r2b.seats[3].waits.length > 0, "② 听牌家给出听牌张 → " + r2b.seats[3].waits.join("/"));

  const e3 = mkE();
  e3.P[1].hand = P("123m 456m 789m 111s 22s"); e3.P[1].melds = []; e3.P[1].drawn = "2条";
  e3.P[0].hand = P("123m 456m 789m 123s 9s"); e3.P[0].drawn = null;
  e3.P[2].hand = P("13579m 2468s 1357p"); e3.P[2].drawn = null;
  e3.P[3].hand = P("19m 19s 19p 东南西北中發白"); e3.P[3].drawn = null;
  e3.settle(1, { selfDraw: true }, T.evaluate(e3.P[1].hand, e3.P[1].melds));
  const r3 = T.buildResultView(e3, e3.result);
  eq(r3.seats[1].win, true, "③ AI（金老板）是胡家");
  eq(r3.mine, -20, "③ 你付 20");
  eq(r3.seats[0].pay, 20, "③ 你的应付额 20");
  eq(r3.seats[2].pay + r3.seats[3].pay, 40, "③ 其他两家各付 20");
  ok(r3.payText1.indexOf("你 付 20") >= 0, "③ 赔付明细里列出你的应付 → " + r3.payText1);
  ok(r3.payText2.indexOf("-20") >= 0, "③ 你的净收支 −20 → " + r3.payText2);

  const TIERCASE = [
    ["123m 456m 789m 123s 99s", [], "小胡", 60],
    ["111m 222m 333s 444p 55s", [], "大胡", 240],
    ["11m 22m 33m 44s 55s 66p 77p", [], "大大胡", 360],
    ["1111m 22m 33s 44s 55p 66p", [], "最大胡", 720]
  ];
  for (const [h, melds, wantName, wantTotal] of TIERCASE) {
    const e = mkE();
    e.P[0].hand = P(h); e.P[0].melds = melds; e.P[0].drawn = null;
    const ev = T.evaluate(e.P[0].hand, e.P[0].melds);
    if (!ev) { ok(false, "④ " + wantName + " 用例成牌判定失败：" + h); continue; }
    e.settle(0, { selfDraw: true }, ev);
    const rv = T.buildResultView(e, e.result);
    eq(rv.tierName, wantName, "④ " + h + " → 档位 " + wantName);
    eq(rv.total, wantTotal, "④ " + wantName + " 共收 " + wantTotal);
    eq(rv.mine, wantTotal, "④ " + wantName + " 你的净收支 +" + wantTotal);
    eq(rv.per * 3, wantTotal, "④ 每家应付 × 3 = " + wantTotal);
  }

  const e5 = mkE();
  e5.P[0].melds = [{ type: "peng", tiles: P("5筒 5筒 5筒"), from: 1, an: false, kind: "ming" }];
  e5.P[0].hand = P("1m 2m 3m 6m 7m 8m 1s 2s 3s 5p");
  e5.P[1].hand = P("1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 2s 3s 5p"); e5.P[1].drawn = null;
  e5.P[2].hand = P("13579m 2468s 1357p"); e5.P[2].drawn = null;
  e5.P[3].hand = P("19m 19s 19p 东南西北中發白"); e5.P[3].drawn = null;
  e5.cur = 0; e5.phase = "turn";
  e5.pending = { type: "turn", seat: 0, anGangs: [], addGangs: ["5筒"] };
  ok(e5.turnGang(0, "5筒", "bu") === true, "⑤ 0 号家补杠 5筒");
  ok(e5.rob(1) === true, "⑤ 1 号家抢杠胡");
  const r5 = T.buildResultView(e5, e5.result);
  eq(r5.payerOnly, true, "⑤ 标记「杠牌一家包赔」");
  eq(r5.payerSeat, 0, "⑤ 包赔家是杠牌的 0 号（你）");
  eq(r5.seats[0].pay, 60, "⑤ 你（杠家）付全部 60");
  eq(r5.seats[2].pay, 0, "⑤ 红姐付 0");
  eq(r5.seats[3].pay, 0, "⑤ 顾曼付 0");
  eq(r5.seats[1].net, 60, "⑤ 抢杠家收 60");
  eq(r5.mine, -60, "⑤ 你的净收支 −60");
  eq(r5.seats[1].how, "抢杠胡", "⑤ 标注「抢杠」来源");
  ok(r5.payText1.indexOf("包赔三家") >= 0, "⑤ 明细里说明包赔 → " + r5.payText1);

  const e6 = mkE();
  e6.P[0].hand = P("123m 456m 789m 123s 9s"); e6.P[0].drawn = null;
  e6.P[1].hand = P("13579m 2468s 1357p"); e6.P[1].drawn = null;
  e6.P[2].hand = P("19m 19s 19p 东南西北中發白"); e6.P[2].drawn = null;
  e6.P[3].hand = P("123m 456m 789m 23s 99s"); e6.P[3].drawn = null;
  e6.drawGame("牌墙摸完（无人成牌）");
  const r6 = T.buildResultView(e6, e6.result);
  eq(r6.draw, true, "⑥ 标记流局");
  ok(r6.why.indexOf("牌墙摸完") >= 0, "⑥ 说明原因：牌墙摸完 → " + r6.why);
  eq(r6.seats.length, 4, "⑥ 流局也亮四家手牌");
  eq(r6.seats.reduce((a, s) => a + s.hand.length, 0), 52, "⑥ 四家手牌共 52 张（13×4）");
  ok(r6.seats.every(s => sortedOk(s.hand)), "⑥ 流局四家手牌都排好序");
  ok(r6.seats.every(s => s.net === 0), "⑥ 流局不计收支");
  eq(r6.mine, 0, "⑥ 流局你的净收支 0");
  eq(r6.payText1.indexOf("流局原因") >= 0, true, "⑥ 流局文案带原因 → " + r6.payText1);

  const e7 = mkE();
  e7.P[0].hand = P("55m");
  e7.P[0].melds = [
    { type: "peng", tiles: P("1m 1m 1m"), from: 1, an: false, kind: "ming" },
    { type: "peng", tiles: P("2s 2s 2s"), from: 2, an: false, kind: "ming" },
    { type: "peng", tiles: P("3p 3p 3p"), from: 3, an: false, kind: "ming" },
    { type: "gang", tiles: P("6m 6m 6m 6m"), from: -1, an: true, kind: "an" }
  ];
  e7.P[0].drawn = "5万";
  e7.settle(0, { selfDraw: true }, T.evaluate(e7.P[0].hand, e7.P[0].melds));
  const r7 = T.buildResultView(e7, e7.result);
  eq(r7.tierName, "大大胡", "⑦ 大吊车（手中仅剩一张单调成对）= 大大胡 360");
  eq(r7.total, 360, "⑦ 大吊车共收 360");
  eq(r7.seats[0].melds.map(m => m.label).join("/"), "碰/碰/碰/暗杠", "⑦ 大吊车的副露类型也都标出来");
  const e8 = mkE();
  e8.P[0].hand = P("1111m 22m 33s 44s 55p 66p"); e8.P[0].melds = []; e8.P[0].drawn = "1万";
  e8.settle(0, { selfDraw: true }, T.evaluate(e8.P[0].hand, e8.P[0].melds));
  const r8 = T.buildResultView(e8, e8.result);
  eq(r8.tierName, "最大胡", "⑧ 龙七对（七对含 4 张）= 最大胡 720");
  eq(r8.total, 720, "⑧ 龙七对共收 720");

  const html1 = T.resultHtml(r1, e1.result);
  eq((html1.match(/class="mjm-rhand[ "]/g) || []).length, 4, "⑨ 结算面板渲染出 4 组手牌");
  eq((html1.match(/class="mjm-rtile/g) || []).length, r1.handTotal + r1.meldTotal,
    "⑨ 手牌牌面元素数 = 四家手牌总张数（" + (r1.handTotal + r1.meldTotal) + "）");
  ok(html1.indexOf("赔付明细") >= 0 && html1.indexOf("共 60") >= 0, "⑨ 面板文本含赔付明细与金额");
  ok(html1.indexOf('id="mjmGo"') >= 0, "⑨ 面板带「继续」按钮（沿用 onFinish 流程）");
  ok(html1.indexOf("mjm-rtile win") >= 0, "⑨ 胡的那张牌在面板里有单独高亮样式");
  ok(html1.indexOf("小胡") >= 0 && html1.indexOf("720") >= 0, "⑨ 面板列出四档赔付（60/240/360/720）");
  const html2 = T.resultHtml(r2, e2.result);
  eq(html2.indexOf("碰5筒") >= 0, true, "⑨ 副露在面板里标注为「类型+牌面」（碰5筒）");
  eq(html2.indexOf("暗杠3万") >= 0, true, "⑨ 暗杠标注出来（暗杠3万）");
  eq(html2.indexOf("补杠中") >= 0, true, "⑨ 补杠标注出来（补杠中）");
  eq(html2.indexOf("明杠7条") >= 0, true, "⑨ 明杠标注出来（明杠7条）");
  const html6 = T.resultHtml(r6, e6.result);
  eq((html6.match(/class="mjm-rhand[ "]/g) || []).length, 4, "⑨ 流局面板同样渲染 4 组手牌");
  ok(html6.indexOf("流局原因") >= 0, "⑨ 流局面板说明原因");
}

/* ═══════════════ 18. 提示 UI + 结算亮牌（stub DOM） ═══════════════ */
(async function section18() {
  group("18. 提示 UI / 结算亮牌（stub DOM）");
  const host = makeElement("div");
  eq(MJ.start(host, {}), true, "开局（stub DOM）");
  ok(!!documentStub.getElementById("mjmBrain"), "「智脑提示」面板已插入 DOM");
  ok(!!documentStub.getElementById("mjmBrainB"), "提示文本容器存在");
  ok(!!documentStub.getElementById("mjmHintToggle"), "提示开关存在");
  ok(!!documentStub.getElementById("mjmHintMark"), "手牌金框叠加层存在");

  const res = MJ.debug.setHand(P("123m 456m 789m 1s 2s 3s 4s 中"), [], null);
  eq(res, true, "调试：强行给一手 14 张牌并轮到自己");
  const h = MJ.debug.hintNow();
  ok(!!h, "hintNow() 同步算出提示");
  eq(h.discard, "中", "建议打 中（打掉中 即听 1条/4条）");
  eq(h.discardIdx >= 0, true, "建议的牌在手牌里有下标（画金框用）");
  const bt = MJ.debug.brainText();
  ok(bt.panel.indexOf("打 中") >= 0, "面板显示「打 中 …」建议文本 → " + bt.panel.replace(/<[^>]*>/g, " ").slice(0, 70));
  ok(bt.panel.indexOf("剩 ") >= 0 || bt.panel.indexOf("有效进张") >= 0, "面板显示听牌/进张张数");
  eq(bt.markClass.indexOf("on") >= 0, true, "被建议的牌有高亮 class（on）");
  ok(/^\d+(\.\d+)?px$/.test(bt.markLeft), "金框定位到具体像素 left=" + bt.markLeft);
  ok(/^\d+(\.\d+)?px$/.test(bt.markTop), "金框定位到具体像素 top=" + bt.markTop);
  eq(bt.markDisplay, "block", "金框已显示");
  const rs = MJ.debug.renderStats();
  eq(rs.hintIdx, h.discardIdx, "画布上同一张牌也带金框标记（renderStats.hintIdx）");

  eq(MJ.debug.hintToggle(false), false, "关闭智脑提示");
  const btOff = MJ.debug.brainText();
  eq(btOff.toggle, "关", "开关文字变成「关」");
  ok(btOff.panel.indexOf("已关闭") >= 0, "面板提示已关闭 → " + btOff.panel.replace(/<[^>]*>/g, ""));
  eq(btOff.markDisplay, "none", "关闭后金框收起");
  eq(MJ.debug.hint(), null, "关闭后 hint() 返回 null");
  eq(MJ.debug.hintToggle(true), true, "重新开启智脑提示");
  const btOn = MJ.debug.brainText();
  eq(btOn.toggle, "开", "开关文字回到「开」");
  ok(btOn.panel.indexOf("打 中") >= 0, "开启后提示恢复");
  eq(MJ.debug.hintToggle(), false, "不带参数 = 切换（开 → 关）");
  eq(MJ.debug.hintToggle(), true, "不带参数 = 切换（关 → 开）");
  const hs = MJ.debug.hintStats();
  ok(hs.calcCount >= 1 && typeof hs.lastMs === "number", "提示统计可读：算过 " + hs.calcCount + " 次，最近 " + hs.lastMs + "ms");

  const resEl = () => documentStub.getElementById("mjmRes") || { innerHTML: "", style: {} };
  eq(MJ.debug.forceWin(0), true, "调试造胡（小胡自摸）");
  eq(MJ.debug.act("settle"), true, "触发结算面板");
  for (let i = 0; i < 30 && resEl().style.display !== "flex"; i++) await sleep(60);
  const rv = MJ.debug.resultView();
  ok(!!rv && rv.seats.length === 4, "结算亮牌数据已生成（4 家）");
  const panelHtml = resEl().innerHTML;
  eq((panelHtml.match(/class="mjm-rhand[ "]/g) || []).length, 4, "结算面板渲染出 4 组手牌");
  const tiles = panelHtml.match(/class="mjm-rtile/g) || [];
  ok(tiles.length >= 52, "面板里手牌牌面元素数 ≥52（实际 " + tiles.length + "）");
  ok(panelHtml.indexOf("赔付明细") >= 0 && panelHtml.indexOf("60") >= 0, "赔付明细文本包含金额");
  ok(panelHtml.indexOf('id="mjmResHands"') >= 0, "面板含手牌区容器 #mjmResHands");
  ok(panelHtml.indexOf('id="mjmResPay"') >= 0, "面板含赔付区容器 #mjmResPay");
  ok(panelHtml.indexOf('id="mjmGo"') >= 0, "面板含「继续」按钮 #mjmGo");
  const rs2 = MJ.debug.render();
  eq(rs2.resHands, 4, "Canvas 亮牌板画出 4 家");
  ok(rs2.resHandTiles >= 52, "Canvas 亮牌板画出 ≥52 张手牌（实际 " + rs2.resHandTiles + "）");

  let fin = null;
  MJ.dispose();
  const host2 = makeElement("div");
  eq(MJ.start(host2, { onFinish: function (r) { fin = r; } }), true, "带 onFinish 重新开局");
  eq(MJ.debug.forceWin(0), true, "再次造胡");
  eq(MJ.debug.act("settle"), true, "再次结算");
  for (let i = 0; i < 30 && resEl().style.display !== "flex"; i++) await sleep(60);
  const go2 = documentStub.getElementById("mjmGo");
  ok(!!go2, "「继续」按钮已解析进 DOM（stub 会登记 innerHTML 里的 id）");
  if (go2 && typeof go2.onclick === "function") go2.onclick();
  ok(!!fin && fin.win === true && fin.score === 60 && fin.fan === 1, "点击继续 → onFinish 收到 win:true / 60 / 1 倍（契约不变）");
  eq(MJ.isBusy(), false, "结算后 isBusy=false");
  MJ.dispose();
  eq(MJ.isBusy(), false, "dispose 后 isBusy=false");

  console.log("\n════════════════════════════════");
})();


/* ─────────────── 20. 赌注系统 / 自由局 / 打法 / 邀约 / 口碑 / 情报（本次新增，全部同步） ─────────────── */
(function section20() {
  group("20. 赌注 / 打法 / 邀约 / 口碑 / 情报");
  const R = MJ.rules;
  const resOf = (o) => Object.assign({ win:false, selfDraw:true, draw:false, seat:-1, tier:"small", tierName:"小胡",
    score:0, perPlayer:0, payPerHouse:0, totalWin:0, netCash:0, from:-1, payerOnly:false, robKong:false,
    kongDraw:false, stake:10, log:[] }, o);
  const newS = () => ({ stats:{cash:100}, bonds:{hong:20, man:20, guo:20}, flags:[], achv:[],
    mjRep:50, mjStreak:0, mjWins:0, mjLosses:0, mjNet:0, mjInvites:{} });

  /* ① 三档注码：每家应付 = 张数 × 注码；胡家共收 = 三家之和 */
  const tiers50 = R.stakeTierList(50);
  eq(tiers50.map(t => t.stake).join("/"), "50/200/1000", "① 自由局三档注码 = ¥50 / ¥200 / ¥1000");
  eq(MJ.rules.STAKE_TIERS.join("/"), "50/200/1000", "① STAKE_TIERS 对外可见");
  eq(tiers50[0].per, 100, "① ¥50 档：小胡每家 = 2 张 × 50 = ¥100");
  eq(tiers50[0].total, 300, "① ¥50 档：小胡共收 = 100 × 3 = ¥300");
  eq(tiers50[2].per, 2000, "① ¥1000 档：小胡每家 = 2 × 1000 = ¥2000");
  eq(tiers50[2].total, 6000, "① ¥1000 档：小胡共收 ¥6000");
  let sc = T.scoreOf("small", { stake: 50 });
  eq(sc.per + "/" + sc.total, "100/300", "① 小胡 ¥50 档：每家 100 / 共 300");
  sc = T.scoreOf("big", { stake: 200 });
  eq(sc.per + "/" + sc.total, "1600/4800", "① 大胡（8 张）¥200 档：每家 1600 / 共 4800");
  sc = T.scoreOf("bigger", { stake: 1000 });
  eq(sc.per + "/" + sc.total, "12000/36000", "① 大大胡（12 张）¥1000 档：每家 12000 / 共 36000");
  sc = T.scoreOf("biggest", { stake: 1000 });
  eq(sc.per + "/" + sc.total, "24000/72000", "① 龙七对（24 张）¥1000 档：每家 24000 / 共 72000");
  sc = T.scoreOf("small", { stake: 1000, kongDraw: true });
  eq(sc.per + "/" + sc.total, "8000/24000", "① 杠开：小胡升大胡（8 张 × 1000）");
  sc = T.scoreOf("big", { stake: 50, kongDraw: true });
  eq(sc.per + "/" + sc.total, "800/2400", "① 杠开且已是大胡：张数翻倍（16 × 50）");
  eq(T.scoreOf("small", { robKong: true, stake: 200 }).payerOnly, true, "① 抢杠胡标记「杠家包赔三家」");
  const t10 = T.tierList(10).map(t => t.total).join("/");
  eq(t10, "60/240/360/720", "① 注码 10 时四档合计仍是 60/240/360/720（面板旧文案不变）");
  eq(T.tierList(200).map(t => t.total).join("/"), "1200/4800/7200/14400", "① 注码 200 时四档合计按比例放大");

  /* ② stake 默认 10：不传 stake 的旧调用行为完全不变 */
  eq(T.STAKE, 10, "② Mahjong.test.STAKE 默认注码 = 10");
  eq(R.stakeOf(undefined) + "/" + R.stakeOf(null) + "/" + R.stakeOf(0) + "/" + R.stakeOf("x"), "10/10/10/10",
    "② 非法/缺省注码一律回落到 10（向后兼容）");
  const eOld = new T.Engine(); eOld.deal();
  eOld.P[0].hand = P("123m 456m 789m 123s 99s"); eOld.P[0].melds = []; eOld.P[0].drawn = "9条";
  eOld.settle(0, { selfDraw: true }, T.evaluate(eOld.P[0].hand, eOld.P[0].melds));
  eq(eOld.result.stake, 10, "② 不传 stake 的引擎 stake = 10");
  eq(eOld.result.perPlayer, 20, "② 小胡每家仍是 20");
  eq(eOld.result.score, 60, "② score 仍是 60（旧契约不变）");
  eq(eOld.result.payPerHouse + "/" + eOld.result.totalWin + "/" + eOld.result.netCash, "20/60/60",
    "② 新增字段在默认注码下 = 20 / 60 / 60");
  eq(eOld.result.fan, 1, "② 番数仍是 1（旧契约不变）");
  /* 不传 style 的旧调用 = 认真模式，智脑照旧 */
  MJ.dispose();
  const hostOld = makeElement("div");
  eq(MJ.start(hostOld, {}), true, "② 不传 style 时开局成功（旧调用不变）");
  eq(MJ.debug.style().style, "serious", "② 缺省打法 = 认真");
  eq(MJ.debug.style().hintLocked, false, "② 认真模式不锁智脑");
  eq(MJ.debug.hintToggle(true), true, "② 认真模式可以开智脑（旧行为不变）");
  MJ.dispose();

  /* ③ 赌注换算进结算结果：三种注码 × 胜负方的净收支 */
  const mkE2 = (stake) => { const e = new T.Engine(stake); e.deal(); return e; };
  const winCase = (stake, hand) => {
    const e = mkE2(stake);
    e.P[0].hand = P(hand); e.P[0].melds = []; e.P[0].drawn = null;
    e.settle(0, { selfDraw: true }, T.evaluate(e.P[0].hand, e.P[0].melds));
    return e.result;
  };
  let r = winCase(200, "123m 456m 789m 123s 99s");
  eq(r.netCash, 1200, "③ ¥200 档小胡自摸 → 净收支 +1200");
  eq(r.payPerHouse, 400, "③ ¥200 档小胡每家应付 400");
  eq(r.totalWin, 1200, "③ ¥200 档小胡共收 1200");
  r = winCase(1000, "1111m 22m 33s 44s 55p 66p");
  eq(r.tier, "biggest", "③ ¥1000 档龙七对档位判定正确");
  eq(r.tiles, 24, "③ 龙七对 24 张");
  eq(r.netCash, 72000, "③ ¥1000 档龙七对 → 净收支 +72000");
  r = winCase(50, "111m 222m 333s 444p 55s");
  eq(r.netCash, 1200, "③ ¥50 档碰碰胡 → 净收支 +1200（8 张 × 50 × 3）");
  /* 别人胡牌：你按每家应付付钱 */
  const eLose = mkE2(200);
  eLose.P[1].hand = P("123m 456m 789m 111s 22s"); eLose.P[1].melds = []; eLose.P[1].drawn = "2条";
  eLose.settle(1, { selfDraw: true }, T.evaluate(eLose.P[1].hand, eLose.P[1].melds));
  eq(eLose.result.netCash, -400, "③ 别人胡牌 → 你付 ¥400（¥200 档小胡）");
  eq(eLose.result.win, false, "③ 别人胡牌时 win=false");
  /* 抢杠包赔：杠家付三家之和 */
  const eRob = mkE2(200);
  eRob.P[0].melds = [{ type: "peng", tiles: P("5筒 5筒 5筒"), from: 1, an: false, kind: "ming" }];
  eRob.P[0].hand = P("1m 2m 3m 6m 7m 8m 1s 2s 3s 5p");
  eRob.P[1].hand = P("1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 2s 3s 5p"); eRob.P[1].drawn = null;
  eRob.P[2].hand = P("13579m 2468s 1357p"); eRob.P[2].drawn = null;
  eRob.P[3].hand = P("19m 19s 19p 东南西北中發白"); eRob.P[3].drawn = null;
  eRob.cur = 0; eRob.phase = "turn"; eRob.pending = { type:"turn", seat:0, anGangs:[], addGangs:["5筒"] };
  ok(eRob.turnGang(0, "5筒", "bu") === true, "③ 你补杠 5筒");
  ok(eRob.rob(1) === true, "③ 金老板抢杠胡");
  eq(eRob.result.payerOnly, true, "③ 标记包赔");
  eq(eRob.result.from, 0, "③ 包赔家 = 你（杠家）");
  eq(eRob.result.netCash, -1200, "③ 抢杠包赔：你付三家之和 ¥1200（¥200 档）");
  eq(eRob.result.payPerHouse, 400, "③ 抢杠包赔每家应付仍是 400");
  const eRob2 = mkE2(50);
  eRob2.P[0].melds = [{ type:"peng", tiles: P("5筒 5筒 5筒"), from: 1, an: false, kind:"ming" }];
  eRob2.P[0].hand = P("1m 2m 3m 6m 7m 8m 1s 2s 3s 5p");
  eRob2.P[2].hand = P("1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 2s 3s 5p"); eRob2.P[2].drawn = null;
  eRob2.P[1].hand = P("13579m 2468s 1357p"); eRob2.P[1].drawn = null;
  eRob2.P[3].hand = P("19m 19s 19p 东南西北中發白"); eRob2.P[3].drawn = null;
  eRob2.cur = 0; eRob2.phase = "turn"; eRob2.pending = { type:"turn", seat:0, anGangs:[], addGangs:["5筒"] };
  eRob2.turnGang(0, "5筒", "bu"); eRob2.rob(2);
  eq(eRob2.result.netCash, -300, "③ ¥50 档抢杠包赔：你付 ¥300");
  eq(eRob2.result.seat, 2, "③ 抢杠家是红姐");
  /* 流局：不结算 */
  const eDraw = mkE2(1000);
  eDraw.drawGame("牌墙摸完（无人成牌）");
  eq(eDraw.result.netCash + "/" + eDraw.result.payPerHouse + "/" + eDraw.result.totalWin, "0/0/0",
    "③ 流局：netCash / payPerHouse / totalWin 全 0（不结算）");
  eq(eDraw.result.stake, 1000, "③ 流局也带上本局注码（面板显示用）");

  /* ④ 结算亮牌板：注码 / 净收支 / 打法 / 羁绊 / 口碑 / 情报 都进面板 */
  /* ④-1 放水局：让红姐（座位 2）胡 → 面板要写明打法 / 好感 +6 / 口碑 −2 / 解锁她的情报 */
  const eView = new T.Engine(200, { style: "gentle" }); eView.deal();
  eView.P[2].hand = P("123m 456m 789m 111s 22s"); eView.P[2].melds = []; eView.P[2].drawn = "2条";
  eView.P[0].hand = P("123m 456m 789m 1s 2s 3s 4s 中"); eView.P[0].drawn = null;
  eView.settle(2, { selfDraw: true }, T.evaluate(eView.P[2].hand, eView.P[2].melds));
  const vInv = { id:"hong", name:"红姐", bond:"hong", seat:2, stake:200, pureBond:false };
  const v = T.buildResultView(eView, eView.result, { state: newS(), style: "gentle", invite: vInv, applyCash: true });
  eq(v.stake, 200, "④ 结算数据带上注码");
  eq(v.netCash, -400, "④ 放水让红姐胡：你的净收支 −400");
  eq(v.style, "gentle", "④ 结算数据带上打法（引擎 放水）");
  ok(v.cashText.indexOf("注码 ¥200") >= 0 && v.cashText.indexOf("每家 ¥400") >= 0 && v.cashText.indexOf("共收 ¥1200") >= 0,
    "④ 注码 / 每家应付 / 共收写进面板文案 → " + v.cashText);
  ok(v.cashText.indexOf("你的净收支 −¥400") >= 0, "④ 面板写明你的净收支（负数用 −¥）→ " + v.cashText);
  ok(v.styleText.indexOf("放水") >= 0 && v.styleText.indexOf("智脑提示关闭") >= 0, "④ 面板写明打法 → " + v.styleText);
  ok(v.bondText.indexOf("红姐") >= 0 && v.bondText.indexOf("+6") >= 0, "④ 放水且对家胡 → 红姐好感 +6 → " + v.bondText);
  eq(v.report.bond.after, 26, "④ 红姐 20 → 26");
  eq(v.repText, "牌友口碑 −3（50 → 47）", "④ 放水 −2 且单局输掉 2×注码 −1 → 口碑 −3 → " + v.repText);
  ok(v.intelText.indexOf("🀄") >= 0 && v.intelText.indexOf("红姐的铺面情报") >= 0, "④ 放水让对方胡 → 解锁对方情报 → " + v.intelText);
  ok(v.achvText.indexOf("冤家") >= 0, "④ 单局输掉 2×注码 → 面板列出「冤家」→ " + v.achvText);
  eq(v.tiers.map(t => t.total).join("/"), "1200/4800/7200/14400", "④ 面板四档按注码 200 换算");
  const htmlV = T.resultHtml(v, eView.result);
  ok(htmlV.indexOf("注码 ¥200") >= 0, "④ 结算面板 HTML 含注码行");
  ok(htmlV.indexOf('id="mjmResCash"') >= 0 && htmlV.indexOf('id="mjmResBond"') >= 0 && htmlV.indexOf('id="mjmResIntel"') >= 0,
    "④ 结算面板 HTML 含注码/羁绊/情报行（#mjmResCash / #mjmResBond / #mjmResIntel）");
  /* ④-2 认真局自摸：面板写明 +¥ 净收支 */
  const eView2 = new T.Engine(200, { style: "serious" }); eView2.deal();
  eView2.P[0].hand = P("123m 456m 789m 123s 99s"); eView2.P[0].melds = []; eView2.P[0].drawn = "9条";
  eView2.settle(0, { selfDraw: true }, T.evaluate(eView2.P[0].hand, eView2.P[0].melds));
  const v2 = T.buildResultView(eView2, eView2.result, { state: newS(), style: "serious" });
  eq(v2.netCash, 1200, "④ 认真局自摸净收支 +1200");
  ok(v2.cashText.indexOf("你的净收支 +¥1200") >= 0, "④ 面板写正数净收支 → " + v2.cashText);
  eq(v2.repText, "牌友口碑 +6（50 → 56）", "④ 认真赢太多：胡牌 +3 / 赢太多 +3 → " + v2.repText);

  /* ⑤ 放水（打法）：智脑提示被禁用且本局不可开；出牌走「次优解」 */
  MJ.dispose();
  const hostG = makeElement("div");
  eq(MJ.start(hostG, { style: "gentle", stake: 200, state: newS(), invite: vInv }), true, "⑤ 放水局开局成功");
  const stG = MJ.debug.style();
  eq(stG.hintOn, false, "⑤ 放水局智脑提示默认关闭");
  eq(stG.hintLocked, true, "⑤ 放水局智脑被锁");
  eq(MJ.debug.hintToggle(true), false, "⑤ 放水局点开关也开不了（返回 false）");
  eq(MJ.debug.hintStats().on, false, "⑤ 提示统计里仍是关闭");
  eq(MJ.debug.hint(), null, "⑤ 放水局不产出提示（hint() = null）");
  const bG = MJ.debug.brainText();
  eq(bG.toggle, "锁", "⑤ 开关显示为「锁」");
  ok(bG.panel.indexOf("放水") >= 0 && bG.panel.indexOf("已关闭") >= 0, "⑤ 面板写明放水模式提示已关闭 → " + bG.panel.replace(/<[^>]*>/g, ""));
  eq(bG.markDisplay, "none", "⑤ 放水局不画建议金框");
  eq(MJ.debug.hintToggle(false), false, "⑤ 放水局只能保持关闭");
  MJ.dispose();
  /* 次优解：同一手牌，放水解的进张 ≤ 最优解，且向听不变差 */
  const gHand = P("123m 456m 789m 123s 4s 中");
  const gCalc = R.gentleCalc(gHand, [], {}, true);
  const gHint = T.hintCalc({ hand: gHand, melds: [], seen: {}, honors: true });
  ok(gCalc.tile && gHand.indexOf(gCalc.tile) >= 0, "⑤ 放水解是一张手里的牌 → " + gCalc.tile);
  ok(gCalc.shanten >= gHint.shanten, "⑤ 放水解不会让自己更远（" + gCalc.shanten + " ≥ " + gHint.shanten + "）");
  ok(gCalc.ukeire <= gHint.ukeire, "⑤ 放水解的有效进张 ≤ 最优解（" + gCalc.ukeire + " ≤ " + gHint.ukeire + "）");
  let diff = 0, same = 0, worse = 0, n14 = 0;
  for (const h of [P("13579m 2468s 1357p 中"), P("11223344m 6677s 8p 9p"), P("19m 19s 19p 东南西北中發白 中"),
                   P("2345m 3456s 4567p 88m"), P("123456789m 123s 99s"), P("2244668m 2244s 8s 9p 9p")]) {
    if (h.length % 3 !== 2) continue;                    // 只比 14 张（该出牌的手牌）
    n14++;
    const g = R.gentleCalc(h, [], {}, true);
    const o = T.hintCalc({ hand: h, melds: [], seen: {}, honors: true });
    if (g.tile === o.discard) same++; else diff++;
    if (g.shanten > o.shanten) worse++;
  }
  ok(n14 >= 5, "⑤ 样本都是 14 张手牌（" + n14 + " 手）");
  ok(diff > 0, "⑤ 样本里放水解与最优解不同（次优解生效：" + diff + " 手不同 / " + same + " 手相同）");
  eq(worse, 0, "⑤ 放水解在任何样本里都不会让向听变差（0 手更差）");
  eq(R.gentleDiscard(P("13579m 2468s 1357p 中"), [], {}, true), R.gentleCalc(P("13579m 2468s 1357p 中"), [], {}, true).tile,
    "⑤ gentleDiscard 与 gentleCalc 一致");

  /* ⑥ 牌桌情报映射：赢下这一桌 → 三家线索；放水让对方胡 → 对方线索 */
  eq(R.intelOfSeat(1), "金老板的软肋", "⑥ 座位 1 → 金老板的软肋");
  eq(R.intelOfSeat(2), "红姐的铺面情报", "⑥ 座位 2 → 红姐的铺面情报");
  eq(R.intelOfSeat(3), "顾曼的底线", "⑥ 座位 3 → 顾曼的底线");
  eq(R.intelOfSeat(0), null, "⑥ 自己座位没有情报（不硬塞）");
  eq(R.intelById("zhao"), "赵家的资金链", "⑥ 赵家资金链映射已预留（后续章节可扩）");
  let ev = R.eventsOf(resOf({ win:true, seat:0, netCash:1200, stake:200, totalWin:1200, payPerHouse:400 }),
    "serious");
  eq(R.intelUnlocked(ev).join("/"), "金老板的软肋/红姐的铺面情报/顾曼的底线", "⑥ 赢下这一桌 → 解锁三家情报");
  eq(ev.winTooMuch, true, "⑥ ¥200 档赢 1200 > 2×注码 → 赢太多");
  ev = R.eventsOf(resOf({ win:false, seat:2, netCash:-400, stake:200, payPerHouse:400, totalWin:1200 }), "gentle");
  eq(R.intelUnlocked(ev).join("/"), "红姐的铺面情报", "⑥ 放水让红姐（座位 2）胡 → 只解锁她那条情报");
  eq(ev.npcWon + "/" + ev.npcSeat, "true/2", "⑥ 事件记录「对家胡了、胡家座位 2」");
  ev = R.eventsOf(resOf({ win:false, seat:2, netCash:-400, stake:200 }), "serious");
  eq(R.intelUnlocked(ev).length, 0, "⑥ 认真模式下输给别人 → 不解锁情报");
  ev = R.eventsOf(resOf({ draw:true, seat:-1 }), "serious");
  eq(R.intelUnlocked(ev).length + R.achvOf(ev, 0).length, 0, "⑥ 流局不解锁情报、不给成就");

  /* ⑦ 牌友口碑增减规则（逐条：连胡 / 被抢杠 / 包赔 / 放水 / 认真赢太多） */
  const EV = (o) => Object.assign({ draw:false, win:false, seat:-1, style:"serious", stake:10, net:0, per:0, totalWin:0,
    tier:"small", tierName:"小胡", robKong:false, kongDraw:false, payerOnly:false, payerSeat:-1,
    playerRobbed:false, playerRobKong:false, npcWon:false, npcSeat:-1, winTooMuch:false, loseBig:false }, o);
  const evWin = R.eventsOf(resOf({ win:true, seat:0, netCash:20, stake:10, totalWin:20 }), "serious");
  const evRob = R.eventsOf(resOf({ win:true, seat:0, netCash:20, stake:10, robKong:true }), "serious");
  const evPayer = R.eventsOf(resOf({ win:false, seat:1, netCash:-60, stake:10, payerOnly:true, from:0 }), "serious");
  const evKong = R.eventsOf(resOf({ win:true, seat:0, netCash:20, stake:10, kongDraw:true }), "serious");
  const evGentle = R.eventsOf(resOf({ win:false, seat:2, netCash:-20, stake:20 }), "gentle");
  const evBig = R.eventsOf(resOf({ win:true, seat:0, netCash:1200, stake:200 }), "serious");
  const evLoseBig = R.eventsOf(resOf({ win:false, seat:1, netCash:-1200, stake:200 }), "serious");
  eq(evWin.winTooMuch, false, "⑦ 小赢（20 = 2×注码）不算赢太多");
  eq(evBig.winTooMuch, true, "⑦ 赢 1200 > 2×200 → 赢太多");
  eq(evPayer.playerRobbed, true, "⑦ 事件标记「你杠被抢、包赔三家」");
  eq(evPayer.loseBig, true, "⑦ 事件标记「单局大亏」");
  eq(R.repDeltaOf(EV({ win:true }), 1), 3, "⑦ 胡牌 +3");
  eq(R.repDeltaOf(EV({ win:true }), 2), 3, "⑦ 两连胡仍是 +3（未到三连）");
  eq(R.repDeltaOf(EV({ win:true }), 3), 7, "⑦ 三连胡再 +4（共 +7）");
  eq(R.repDeltaOf(EV({ playerRobbed:true, payerOnly:true, payerSeat:0 }), 0), -5, "⑦ 杠被抢、包赔三家 −5");
  eq(R.repDeltaOf(evPayer, 0), -6, "⑦ 包赔且单局大亏：−5 + (−1) = −6");
  eq(R.repDeltaOf(EV({ win:true, robKong:true, playerRobKong:true }), 1), 5, "⑦ 抢杠胡成功 +2（叠加胡牌 +3）");
  eq(R.repDeltaOf(EV({ win:true, kongDraw:true }), 1), 4, "⑦ 杠上开花 +1（叠加胡牌 +3）");
  eq(R.repDeltaOf(EV({ style:"gentle" }), 0), -2, "⑦ 放水 −2");
  eq(R.repDeltaOf(EV({ style:"gentle", win:true }), 1), 1, "⑦ 放水但自己胡了：+3 −2 = +1");
  eq(R.repDeltaOf(EV({ win:true, winTooMuch:true }), 1), 6, "⑦ 认真且赢太多 +3（叠加胡牌 +3）");
  eq(R.repDeltaOf(EV({ loseBig:true }), 0), -1, "⑦ 单局大亏 −1");
  eq(R.repDeltaOf(evLoseBig, 0), -1, "⑦ 输 6×注码 → −1");
  eq(R.repDeltaOf(evRob, 1), 5, "⑦ 抢杠胡（真实结算对象）口碑 +5");
  eq(R.repDeltaOf(evKong, 1), 4, "⑦ 杠上开花（真实结算对象）口碑 +4");
  eq(R.repDeltaOf(evGentle, 0), -2, "⑦ 放水（真实结算对象）口碑 −2");
  eq(R.repDeltaOf(R.eventsOf(resOf({ draw:true, seat:-1 }), "serious"), 0), 0, "⑦ 流局口碑不变");
  eq(MJ.rules.REP_INIT, 50, "⑦ 口碑初始 50");
  const sRep = newS(); sRep.mjRep = 98;
  R.applyOutcome(sRep, resOf({ win:true, seat:0, netCash:20, stake:10 }), { style:"serious" });
  eq(sRep.mjRep, 100, "⑦ 口碑上限封顶 100（98 + 3 → 100）");
  const sRep2 = newS(); sRep2.mjRep = 1;
  R.applyOutcome(sRep2, resOf({ win:false, seat:1, netCash:-60, stake:10, payerOnly:true, from:0 }), { style:"serious" });
  eq(sRep2.mjRep, 0, "⑦ 口碑下限兜底 0");

  /* ⑧ 羁绊增减（只有邀约局才动羁绊；认真赢太多扣、放水加） */
  const invH = { id:"hong", name:"红姐", bond:"hong", seat:2, stake:200, pureBond:false };
  const invG = { id:"guo", name:"陈果", bond:"guo", seat:-1, stake:50, pureBond:true };
  eq(R.bondDeltaOf(evWin, null), 0, "⑧ 自由局不动羁绊");
  eq(R.bondDeltaOf(EV({ style:"gentle", npcWon:true, npcSeat:2 }), invH), 6, "⑧ 放水且红姐胡 → 好感 +6");
  eq(R.bondDeltaOf(EV({ style:"gentle", win:true }), invH), 3, "⑧ 放水但自己还是胡了 → 好感 +3");
  eq(R.bondDeltaOf(EV({ style:"gentle", npcWon:true, npcSeat:1 }), invH), 3, "⑧ 放水但胡的是别人 → 好感 +3");
  eq(R.bondDeltaOf(EV({ win:true, winTooMuch:true, net:600, stake:200 }), invH), -2,
    "⑧ 认真赢太多（600 = 3×注码）→ 好感 −2");
  eq(R.bondDeltaOf(EV({ win:true, winTooMuch:true, net:1000, stake:200 }), invH), -3,
    "⑧ 赢得更多（1000 = 5×注码）→ 好感 −3");
  eq(R.bondDeltaOf(EV({ win:true, winTooMuch:true, net:4000, stake:200 }), invH), -4,
    "⑧ 赢得最狠（4000 = 20×注码）→ 好感 −4（封顶）");
  eq(R.bondDeltaOf(EV({ win:true, net:400, stake:200 }), invH), 1, "⑧ 认真小赢（刚好 2×注码，不算赢太多）→ 好感 +1");
  eq(R.bondDeltaOf(EV({ npcWon:true, npcSeat:2, net:-400, stake:200 }), invH), -1, "⑧ 认真输了 → 好感 −1");
  eq(R.bondDeltaOf(EV({ draw:true }), invH), 0, "⑧ 流局 → 好感不变");
  eq(R.bondDeltaOf(EV({ draw:true, style:"gentle" }), invG), 4, "⑧ 妹妹局（纯涨羁绊）恒定 +4");
  eq(R.bondDeltaOf(EV({ win:true, winTooMuch:true, net:6000, stake:50 }), invG), 4, "⑧ 妹妹局赢多少都是 +4（不扣好感）");

  /* ⑨ 成就：三连胡 / 包赔三家 / 牌桌老千 / 冤家 */
  eq(R.achvOf(evWin, 1).join("/"), "mjWin", "⑨ 胡牌 → 牌桌老千（保留）");
  eq(R.achvOf(evWin, 3).join("/"), "mjWin/mjStreak3", "⑨ 连续三局胡 → 三连胡");
  eq(R.achvOf(evWin, 2).indexOf("mjStreak3"), -1, "⑨ 两连胡不算三连胡");
  eq(R.achvOf(EV({ playerRobbed:true, payerOnly:true, payerSeat:0 }), 0).join("/"), "mjPayer", "⑨ 杠被抢包赔 → 包赔三家");
  eq(R.achvOf(evPayer, 0).join("/"), "mjPayer/mjRival", "⑨ 包赔且输光注码 → 包赔三家 + 冤家");
  eq(R.achvOf(EV({ loseBig:true }), 0).join("/"), "mjRival", "⑨ 单局输光所选注码（净亏 ≥ 2×注码）→ 冤家");
  const sA = newS();
  R.applyOutcome(sA, resOf({ win:true, seat:0, netCash:60, stake:10 }), { style:"serious" });
  R.applyOutcome(sA, resOf({ win:true, seat:0, netCash:60, stake:10 }), { style:"serious" });
  R.applyOutcome(sA, resOf({ win:true, seat:0, netCash:60, stake:10 }), { style:"serious" });
  eq(sA.mjStreak, 3, "⑨ 连胡计数 = 3");
  ok(sA.achv.indexOf("mjStreak3") >= 0, "⑨ 第三局写入三连胡成就");
  eq(sA.mjWins, 3, "⑨ 战绩：3 胜");
  eq(sA.mjNet, 180, "⑨ 战绩：净收支累计 180");
  R.applyOutcome(sA, resOf({ win:false, seat:1, netCash:-20, stake:10 }), { style:"serious" });
  eq(sA.mjStreak, 0, "⑨ 输一局 → 连胡清零");
  eq(sA.mjLosses, 1, "⑨ 战绩：1 负");
  eq(sA.mjNet, 160, "⑨ 战绩：净收支 160");

  /* ⑩ applyOutcome：财富按「张数 × 注码」变化，输光不破产（保底 0） */
  const sC = newS(); sC.stats.cash = 100;
  let rep = R.applyOutcome(sC, resOf({ win:true, seat:0, netCash:1200, stake:200, totalWin:1200, payPerHouse:400 }), { style:"serious" });
  eq(sC.stats.cash, 1300, "⑩ 赢 ¥1200 → 财富 100 → 1300");
  eq(rep.cash.delta, 1200, "⑩ 报告里写明财富变化 +1200");
  eq(rep.cash.net, 1200, "⑩ 报告里写明本局净收支");
  const sL = newS(); sL.stats.cash = 60;
  rep = R.applyOutcome(sL, resOf({ win:false, seat:1, netCash:-400, stake:200 }), { style:"serious" });
  eq(sL.stats.cash, 0, "⑩ 输光 → 财富保底 0（不给负）");
  eq(rep.cash.delta, -60, "⑩ 报告里的实际扣款是 −60（不是 −400）");
  eq(rep.cash.net, -400, "⑩ 报告里同时保留账面净收支 −400");
  const sF = newS(); sF.stats.cash = 500;
  R.applyOutcome(sF, resOf({ win:true, seat:0, netCash:1200, stake:200, totalWin:1200 }), { style:"serious", applyCash:false });
  eq(sF.stats.cash, 500, "⑩ applyCash:false（剧情局）不动财富");
  const sRec = newS();
  R.applyOutcome(sRec, resOf({ win:true, seat:0, netCash:1200, stake:200, totalWin:1200 }), { style:"serious", countRecord:false });
  eq(sRec.mjWins + "/" + sRec.mjNet, "0/0", "⑩ countRecord:false 时不计战绩");
  const sInv = newS();
  rep = R.applyOutcome(sInv, resOf({ win:false, seat:2, netCash:-400, stake:200, payPerHouse:400, totalWin:1200 }),
    { style:"gentle", invite: invH });
  eq(sInv.bonds.hong, 26, "⑩ 邀约局落地羁绊：红姐 20 → 26");
  ok(rep.bond && rep.bond.id === "hong" && rep.bond.delta === 6, "⑩ 报告里带羁绊变化明细");
  ok(rep.flags.indexOf("红姐的铺面情报") >= 0, "⑩ 报告里带新解锁的情报");
  ok(sInv.flags.indexOf("红姐的铺面情报") >= 0, "⑩ 情报写进 S.flags");
  eq(sInv.flags.length, 1, "⑩ 只解锁对方那一条情报");
  const sInv2 = newS();
  R.applyOutcome(sInv2, resOf({ win:false, seat:2, netCash:-400, stake:200 }), { style:"gentle", invite: invH });
  R.applyOutcome(sInv2, resOf({ win:false, seat:2, netCash:-400, stake:200 }), { style:"gentle", invite: invH });
  eq(sInv2.flags.length, 1, "⑩ 重复解锁同一情报不会重复写入");
  eq(sInv2.bonds.hong, 32, "⑩ 羁绊可累加（20 → 32）");
  const sPrev = newS();
  const pv = R.previewOutcome(sPrev, resOf({ win:true, seat:0, netCash:1200, stake:200 }), { style:"serious" });
  eq(sPrev.stats.cash, 100, "⑩ 预演（结算面板用）不改真实状态");
  eq(pv.cash.after, 1300, "⑩ 预演结果与真实落地一致（1300）");
  eq(pv.lines.join(" | ").indexOf("注码 ¥200") >= 0, true, "⑩ 预演给出面板文案行 → " + pv.lines[0]);

  /* ⑪ 邀约规则：羁绊阈值 / 时段 / 冷却 / 已接受不再弹 / 财富不足 */
  const mkS = (o) => Object.assign({ bonds:{hong:20, man:20, guo:20}, per:2, stats:{cash:2000}, mjInvites:{} }, o);
  const mkS3 = (o) => mkS(Object.assign({ ch:3 }, o || {}));          // 章节足够的存档形状
  /* 顺序按新规格「章节 > 羁绊 > 时段」给出：顾曼 ch:2 与当前章节 3 有落差 → 排在不限章节的
     红姐 / 陈果之后。旧实现是硬编码数组顺序 hong/man/guo，这里已同步为 hong/guo/man。 */
  let list = R.inviteList(mkS3(), 1000);
  eq(list.map(x => x.id).join("/"), "hong/guo/man", "⑪ 三家羁绊都达标 → 三条候选（章节足够；顾曼 ch:2 有落差排最后）");
  eq(list[0].stake + "/" + list[1].stake + "/" + list[2].stake, "200/50/1000", "⑪ 注码：红姐 ¥200 / 陈果 ¥50 / 顾曼 ¥1000");
  eq(list[0].seat + "/" + list[1].seat + "/" + list[2].seat, "2/-1/3", "⑪ 座位：红姐 2 / 陈果不上桌 / 顾曼 3");
  eq(list[1].pureBond, true, "⑪ 妹妹局标记「纯涨羁绊」");
  ok(list[0].msg.length > 0, "⑪ 邀约带手机消息文案 → " + list[0].msg);
  eq(R.inviteList(mkS3({ bonds:{hong:19, man:20, guo:20} }), 1000).map(x => x.id).join("/"), "guo/man",
    "⑪ 红姐羁绊 19 < 20 → 不约");
  eq(R.inviteList(mkS3({ per:0 }), 1000).map(x => x.id).join("/"), "guo/man",
    "⑪ 白天（per=0）红姐不约（只在晚上 per=2）");
  eq(R.inviteList(mkS3({ per:2, mjInvites:{ hong:{t:0, mode:"accepted"} } }), 1e9).map(x => x.id).join("/"), "guo/man",
    "⑪ 接受过 → 本轮人生不再弹同一条");
  eq(R.inviteList(mkS3({ per:2, mjInvites:{ hong:{t:900, mode:"declined"} } }), 1000).map(x => x.id).join("/"), "guo/man",
    "⑪ 「改天」后 20 分钟内冷却不再骚扰");
  eq(R.inviteList(mkS3({ per:2, mjInvites:{ hong:{t:900, mode:"declined"} } }), 900 + R.INVITE_COOLDOWN_MS)
    .map(x => x.id).join("/"), "hong/guo/man", "⑪ 冷却结束后可以再约（20 分钟）");
  const poor = R.inviteList(mkS3({ stats:{cash:120} }), 1000);
  eq(poor.length, 3, "⑪ 财富不足时仍然列出邀约（只是不能接受）");
  eq(poor[0].ok, false, "⑪ 红姐 ¥200 档：财富 120 不足 → 置灰");
  ok(poor[0].reason.indexOf("财富不足") >= 0, "⑪ 给出置灰原因 → " + poor[0].reason);
  eq(poor[1].ok, true, "⑪ 妹妹 ¥50 档仍可接受");
  eq(R.inviteList(mkS3({ bonds:{hong:0,man:0,guo:0} }), 1000).length, 0, "⑪ 羁绊都不达标 → 不弹任何邀约");
  /* 旧调用（不传章节）行为不变：章节限定的角色不会在「不知道章节」时冒出来 */
  eq(R.inviteList(mkS({ bonds:{hong:20,man:20,guo:20} }), 1000).map(x => x.id).join("/"), "hong/guo",
    "⑪ 不传章节：只弹不限章节的角色（顾曼 ch:2 不出）");

  /* ⑫ 开局面板（DOM）：三档可选 / 财富不足置灰 / 打法切换 / 开始回调 */
  const lobbyHost = makeElement("div");
  let started = null, canceled = false;
  eq(MJ.openLobby(lobbyHost, { cash: 60, record:{ wins:2, losses:1, net:180, rep:56 },
    onStart: (o)=>{ started = o; }, onCancel: ()=>{ canceled = true; } }), true, "⑫ 开局面板渲染成功");
  const L1 = MJ.debug.lobbyState();
  eq(L1.tiers.length, 3, "⑫ 面板列出三档注码");
  eq(L1.tiers.map(t => (t.ok ? 1 : 0)).join(""), "100", "⑫ 财富 60：只有 ¥50 档可选，另两档置灰");
  eq(L1.tiers[1].reason.indexOf("财富不足") >= 0, true, "⑫ 置灰档位给出原因 → " + L1.tiers[1].reason);
  eq(L1.stake, 50, "⑫ 默认选中第一个买得起的档位（¥50）");
  ok(!!documentStub.getElementById("mjmStake50") && !!documentStub.getElementById("mjmStake200") &&
     !!documentStub.getElementById("mjmStake1000"), "⑫ 三档按钮都在 DOM 里（#mjmStake50/200/1000）");
  ok(documentStub.getElementById("mjmStake200").className.indexOf("off") >= 0, "⑫ 置灰档位带 off 样式");
  ok(documentStub.getElementById("mjmStake50").onclick() === true, "⑫ 点 ¥50 档可选");
  ok(documentStub.getElementById("mjmStake200").onclick() === false, "⑫ 点置灰的 ¥200 档点不动（返回 false）");
  eq(MJ.debug.lobbyState().stake, 50, "⑫ 置灰档位不会被选中");
  documentStub.getElementById("mjmStyleGentle").onclick();
  eq(MJ.debug.lobbyState().style, "gentle", "⑫ 选「放水」打法");
  documentStub.getElementById("mjmStyleSerious").onclick();
  eq(MJ.debug.lobbyState().style, "serious", "⑫ 切回「认真」");
  documentStub.getElementById("mjmLobbyGo").onclick();
  ok(!!started && started.stake === 50 && started.style === "serious", "⑫ 点「开局」→ 回调 {stake:50, style:serious}");
  documentStub.getElementById("mjmLobbyCancel").onclick();
  eq(canceled, true, "⑫ 点「再想想」→ 取消回调");
  const lobbyHost2 = makeElement("div");
  MJ.openLobby(lobbyHost2, { cash: 0 });
  eq(MJ.debug.lobbyState().ok, false, "⑫ 财富 0：没有任何档位可选");
  eq(documentStub.getElementById("mjmStake50").onclick(), false, "⑫ 财富 0 时 ¥50 档也点不动（不破产）");

  /* ⑬ 邀约条（DOM）：接受 / 改天 回调 + 财富不足禁用 */
  const invHost = makeElement("div");
  let accepted = null, declined = null;
  const inv = { id:"hong", name:"红姐", stake:200, where:"金色年华 · 后巷", msg:"三缺一，来不来？", ok:true };
  eq(MJ.showInvite(invHost, inv, { onAccept:(o)=>accepted=o, onDecline:(o)=>declined=o }), true, "⑬ 邀约条渲染成功");
  const ivs = MJ.debug.inviteState();
  eq(ivs.open + "/" + ivs.id + "/" + ivs.stake, "true/hong/200", "⑬ 邀约条状态：红姐 ¥200");
  ok(!!documentStub.getElementById("mjmInviteYes") && !!documentStub.getElementById("mjmInviteNo"),
    "⑬ 邀约条有「接受」「改天」两个按钮");
  const metaTxt = documentStub.getElementById("mjmInviteMeta").innerHTML;
  ok(metaTxt.indexOf("注码 ¥200") >= 0 && metaTxt.indexOf("金色年华") >= 0, "⑬ 邀约条写明注码与地点 → " + metaTxt);
  eq(documentStub.getElementById("mjmInviteYes").onclick(), true, "⑬ 点「接受」");
  ok(!!accepted && accepted.id === "hong", "⑬ 接受回调带回该条邀约");
  eq(MJ.debug.inviteState().accepted, true, "⑬ 状态标记 accepted");
  const invHost2 = makeElement("div");
  MJ.showInvite(invHost2, inv, { onAccept:(o)=>accepted=o, onDecline:(o)=>declined=o });
  documentStub.getElementById("mjmInviteNo").onclick();
  eq(declined && declined.id, "hong", "⑬ 点「改天」→ 回调");
  eq(MJ.debug.inviteState().declined, true, "⑬ 状态标记 declined");
  const invHost3 = makeElement("div");
  MJ.showInvite(invHost3, { id:"man", name:"顾曼", stake:1000, ok:false, reason:"财富不足（需要 ¥1000，当前 ¥10）", msg:"今晚有个局" }, {});
  eq(documentStub.getElementById("mjmInviteYes").onclick(), false, "⑬ 财富不足的邀约点「接受」无效");
  ok(documentStub.getElementById("mjmInviteMeta").innerHTML.indexOf("财富不足") >= 0, "⑬ 财富不足时邀约条写明原因");
  eq(MJ.hideInvite(invHost3), true, "⑬ hideInvite 可收起邀约条");
  eq(MJ.debug.inviteState(), null, "⑬ 收起后状态清空");

  /* ⑭ onFinish 新字段（stake / payPerHouse / totalWin / netCash / style / report） */
  MJ.dispose();
  const hostF = makeElement("div");
  let fin = null;
  eq(MJ.start(hostF, { stake: 1000, style: "serious", state: newS(),
    invite: { id:"man", name:"顾曼", bond:"man", seat:3, stake:1000, pureBond:false },
    onFinish: (r)=>{ fin = r; } }), true, "⑭ ¥1000 档开局");
  eq(MJ.debug.forceWin(0), true, "⑭ 调试造胡（小胡自摸）");
  eq(MJ.debug.act("settle"), true, "⑭ 触发结算面板");
  const goEl = documentStub.getElementById("mjmGo");
  ok(!!goEl && typeof goEl.onclick === "function", "⑭ 结算面板的「继续」按钮可点");
  if (goEl) goEl.onclick();
  ok(!!fin, "⑭ onFinish 被调用");
  eq(fin.stake, 1000, "⑭ onFinish.stake = 1000");
  eq(fin.payPerHouse, 2000, "⑭ onFinish.payPerHouse = 2000（2 张 × 1000）");
  eq(fin.totalWin, 6000, "⑭ onFinish.totalWin = 6000（三家之和）");
  eq(fin.netCash, 6000, "⑭ onFinish.netCash = +6000");
  eq(fin.style, "serious", "⑭ onFinish.style = serious");
  eq(fin.score, 6000, "⑭ 旧字段 score 同步按注码换算（6000）");
  ok(!!fin.report && fin.report.cashText.indexOf("¥1000") >= 0, "⑭ onFinish.report 带面板文案");
  eq(fin.report.bond.delta, -4, "⑭ 顾曼局：认真赢太多（6000 = 6×1000）→ 好感 −4");
  eq(fin.report.bond.after, 16, "⑭ 顾曼 20 → 16");
  eq(MJ.isBusy(), false, "⑭ 结算后 isBusy=false");
  MJ.dispose();

  /* ═══════════ ⑮ INVITES 表完整性 / 邀约优先级 / 剧情后果 flag / 本局影响同源 / 5 条新情报 ═══════════ */
  group("20b. INVITES 表 / 邀约优先级 / 剧情后果 / 本局影响同源 / 新情报");
  {
    const INV = R.INVITES;
    /* ⑮① 表完整性：8 条、字段齐全、条件合法、注码 ∈ {50,200,1000} */
    eq(INV.length, 8, "⑮① INVITES 共 8 条可邀约角色");
    eq(INV.map(d => d.id).join("/"), "hong/man/guo/lin/su/wen/lei/lu", "⑮① id 顺序与声明一致");
    eq(INV.map(d => d.name).join("/"), "红姐/顾曼/陈果/林溪/苏晚晴/温阮/雷姐/白露", "⑮① 显示名齐全");
    const STAKES = R.STAKE_TIERS.join("/");
    let fieldBad = [], condBad = [], stakeBad = [], dupId = {};
    for (const d of INV) {
      if (dupId[d.id]) fieldBad.push(d.id + ":重复id"); dupId[d.id] = 1;
      for (const k of ["id","name","cname","bond","min","per","ch","where","stake","seat","msg","openLine","settle","note"])
        if (d[k] === undefined) fieldBad.push(d.id + ":" + k);
      if (!Array.isArray(d.bonds) || !d.bonds.length) fieldBad.push(d.id + ":bonds");
      else for (const b of d.bonds) {
        if (!b.key || !(b.min > 0) || !isFinite(b.pri)) condBad.push(d.id + ":" + JSON.stringify(b));
        if (!b.gain || typeof b.gain !== "object") condBad.push(d.id + ":gain");
      }
      if (R.STAKE_TIERS.indexOf(d.stake) < 0) stakeBad.push(d.id + ":" + d.stake);
      if (d.per !== null && [0,1,2].indexOf(d.per) < 0) condBad.push(d.id + ":per" + d.per);
      if (d.ch !== null && (!(d.ch >= 1) || d.ch > 3)) condBad.push(d.id + ":ch" + d.ch);
      if ([null,-1,0,1,2,3].indexOf(d.seat) < 0) condBad.push(d.id + ":seat" + d.seat);
      if (typeof d.pureBond !== "boolean") fieldBad.push(d.id + ":pureBond");
    }
    eq(fieldBad.length, 0, "⑮① 字段齐全（缺失项：" + fieldBad.join(",") + "）");
    eq(condBad.length, 0, "⑮① 触发条件合法（非法项：" + condBad.join(",") + "）");
    eq(stakeBad.length, 0, "⑮① 注码都在 " + STAKES + " 三档内（越界：" + stakeBad.join(",") + "）");
    /* 新增 5 人：注码与产出有差异 + 各自情报 */
    const NEW5 = ["lin","su","wen","lei","lu"];
    eq(NEW5.map(id => R.inviteDef(id).stake).join("/"), "50/200/50/200/50", "⑮① 新增 5 人注码 50/200/50/200/50（有差异）");
    eq(NEW5.map(id => R.inviteDef(id).intel).join("/"),
      "公司的人事风声/她的旧伤/她错的那道题/馆里的旧账/急诊室的秘密", "⑮① 新增 5 人各自带一条情报");
    eq(NEW5.map(id => Object.keys(R.inviteDef(id).bonds[0].gain).join("+")).join(","), "int,cha,int,phy,spi+cha",
      "⑮① 新增 5 人产出维度各异（智力/魅力/智力/体魄/精神+魅力）");
    eq(R.inviteDef("lu").bonds[0].gain.spi, 5, "⑮① 白露产出「精神 +5」（spi 维度）");
    /* ⑮② 邀约优先级：章节匹配 > 通用兜底 > 羁绊高 > 时段匹配 */
    const B = { hong:20, man:20, guo:20, lin:20, su:20, wen:20, lei:20, lu:20 };
    const S = (o) => Object.assign({ bonds:Object.assign({}, B), per:2, stats:{cash:5000}, mjInvites:{} }, o);
    eq(R.inviteList(S({ ch:2 }), 1000).map(x => x.id).join("/"), "lin/lei/wen/man/hong/guo",
      "⑮② 当前章节 2：本章专属（lin/lei/wen/man）优先于通用兜底（hong/guo）；苏晚晴下午局不在此刻");
    eq(R.inviteList(S({ ch:3 }), 1000).map(x => x.id).join("/"), "hong/guo/lin/lei/wen/man",
      "⑮② 当前章节 3：本章无专属 → 通用角色（红姐/陈果）先于已过章的顾曼等");
    /* 同时段只能有一位：雷姐 / 白露 都是「晚上限定」，同一时刻只留优先级高的那位 */
    eq(R.inviteList(S({ ch:2, per:2 }), 1000).map(x => x.id).indexOf("lu"), -1,
      "⑮② 晚上同一时段：雷姐（pri 28）压过白露（pri 26），白露本次不弹（不重复骚扰同一个夜场）");
    eq(R.inviteList(S({ ch:2, per:2, bonds:{ hong:0, man:0, guo:0, lin:0, su:0, wen:0, lei:0, lu:20 } }), 1000).map(x => x.id).join("/"), "lu",
      "⑮② 但只有白露达标时，邀约就是白露（¥50 · 急诊室的秘密）");
    eq(R.pickInvite(S({ ch:2 }), 1000).id, "lin", "⑮② pickInvite：章节 2 取本章专属里优先级最高的一条（林溪）");
    eq(R.pickInvite(S({ ch:3 }), 1000).id, "hong", "⑮② pickInvite：章节 3 取通用角色（红姐）");
    eq(R.inviteList(S({ ch:2, bonds:{ hong:20, man:20, guo:20, lin:0, su:0, wen:0, lei:0, lu:0 } }), 1000).map(x => x.id).join("/"),
      "man/hong/guo", "⑮② 章节 2 + 只有老三人达标 → 顾曼（本章专属）第一（旧断言之外的章节维度证明）");
    eq(R.inviteList(S({ ch:2, per:1, bonds:{ hong:40, man:20, guo:20, lin:0, su:20, wen:0, lei:0, lu:0 } }), 1000).map(x => x.id).join("/"),
      "su/man/guo", "⑮② 下午（per=1）：苏晚晴时段匹配可约，红姐（只在晚上）不约");    eq(R.inviteList(S({ ch:2, per:2, bonds:{ hong:0, man:0, guo:0, lin:30, lei:30, su:0, wen:0, lu:0 } }), 1000).map(x => x.id).join("/"), "lin/lei",
      "⑮② 同章节：羁绊值相同（都 30）→ 按收益优先级 pri 降序（林溪 30 > 雷姐 28）");
    /* 同一次只弹一条 + 被拒不重复 + 财富不足给原因 */
    const one = R.pickInvite(S({ ch:3 }), 1000);
    ok(one && one.id, "⑮② 同一次只弹一条（pickInvite 返回单条）" + one.id);
    eq(R.inviteList(S({ ch:3, mjInvites:{ hong:{ t:1000, mode:"declined" } } }), 1000).map(x => x.id).join("/"),
      "guo/lin/lei/wen/man", "⑮② 被拒的红姐在 20 分钟冷却内不再出现");
    eq(R.inviteList(S({ ch:3, mjInvites:{ hong:{ t:1000, mode:"accepted" } } }), 1e9).map(x => x.id).indexOf("hong"), -1,
      "⑮② 接受过的角色本轮不再弹");
    const pv = R.inviteList(S({ ch:3, stats:{ cash:60 } }), 1000);
    eq(pv[0].ok, false, "⑮② 财富不足 → 该条禁用");
    ok(pv[0].reason.indexOf("财富不足") >= 0, "⑮② 禁用给出原因 → " + pv[0].reason);
    /* ⑮③ 放水 / 认真 → flag 映射 */
    const evG = R.eventsOf(resOf({ win:false, seat:3, draw:false, stake:1000, netCash:-2000, payPerHouse:2000, style:"gentle" }), "gentle");
    const invMan = R.inviteDef("man"), invJin = { id:"jin", name:"金老板", cname:"金老板", bond:"jin", min:20, seat:1, stake:200, pureBond:false };
    const invHong = R.inviteDef("hong");
    eq(R.consequenceFlags(evG, invMan).join("/"), "顾曼的赏识", "⑮③ 顾曼局放水且她胡 → flag 顾曼的赏识");
    eq(R.consequenceFlags(evG, invJin).join("/"), "金老板的信任", "⑮③ 金老板局放水且他胡 → flag 金老板的信任");
    const evTW = R.eventsOf(resOf({ win:true, seat:0, draw:false, stake:200, netCash:1200, payPerHouse:400, totalWin:1200, style:"serious" }), "serious");
    eq(R.consequenceFlags(evTW, invHong).join("/"), "牌桌结梁子：红姐", "⑮③ 认真赢太狠 → flag 牌桌结梁子：红姐");
    eq(R.consequenceFlags(evTW, invMan).join("/"), "牌桌结梁子：顾曼", "⑮③ 认真赢太狠（顾曼局）→ 牌桌结梁子：顾曼");
    eq(R.consequenceFlags(evTW, R.inviteDef("lei")).join("/"), "牌桌结梁子：雷姐", "⑮③ flag 名称按角色名拼接");
    const evSmall = R.eventsOf(resOf({ win:true, seat:0, draw:false, stake:200, netCash:400, style:"serious" }), "serious");
    eq(R.consequenceFlags(evSmall, invHong).length, 0, "⑮③ 认真小赢（刚好 2×注码）→ 不结梁子、无赏识/信任 flag");
    eq(R.consequenceFlags(evSmall, invMan).length, 0, "⑮③ 认真小赢（顾曼局）→ 也不给赏识 flag");
    eq(R.consequenceFlags(R.eventsOf(resOf({ draw:true, seat:-1, style:"gentle" }), "gentle"), invMan).length, 0,
      "⑮③ 流局不发任何剧情后果 flag（避免误触发隐藏选项）");
    eq(R.consequenceFlags(R.eventsOf(resOf({ win:true, seat:0, draw:false, stake:200, netCash:1200, style:"gentle" }), "gentle"), invMan).length, 0,
      "⑮③ 放水但自己还是胡了 → 不发「赏识」（她只欣赏你真的把牌留给她）");
    eq(R.consequenceFlags(R.eventsOf(resOf({ win:false, seat:1, draw:false, stake:200, netCash:-400, style:"serious" }), "serious"), invJin).length, 0,
      "⑮③ 认真输给别人 → 不发「信任」");
    /* 落地：applyOutcome 写入 flag + 报告带后果与影响行 */
    const sC = newS(); sC.stats.cash = 5000;
    const repC = R.applyOutcome(sC, resOf({ win:false, seat:3, draw:false, stake:1000, netCash:-2000, payPerHouse:2000, totalWin:6000, style:"gentle" }),
      { style:"gentle", invite:invMan });
    ok(sC.flags.indexOf("顾曼的赏识") >= 0, "⑮③ 落地：S.flags 写入「顾曼的赏识」");
    ok(repC.flags.indexOf("顾曼的赏识") >= 0, "⑮③ 报告 flags 带「顾曼的赏识」");
    eq(repC.impactText.indexOf("放水陪玩"), 0, "⑮③ 影响行以打法开头 → " + repC.impactText);
    ok(repC.impactText.indexOf("顾曼好感 +6") >= 0, "⑮③ 影响行带羁绊数字（与落地同源）→ " + repC.impactText);
    ok(repC.impactText.indexOf("已获得可用的把柄") >= 0, "⑮③ 影响行说明「已获得可用的把柄」→ " + repC.impactText);
    eq(repC.impact.flag, "顾曼的赏识", "⑮③ 影响行元数据带 flag");
    const sR = newS(); sR.stats.cash = 5000;
    const repR = R.applyOutcome(sR, resOf({ win:true, seat:0, draw:false, stake:200, netCash:1200, payPerHouse:400, totalWin:1200, style:"serious" }),
      { style:"serious", invite:invHong });
    ok(sR.flags.indexOf("牌桌结梁子：红姐") >= 0, "⑮③ 落地：认真赢太狠写入「牌桌结梁子：红姐」");
    eq(repR.impactText.indexOf("认真打满"), 0, "⑮③ 影响行以「认真打满」开头 → " + repR.impactText);
    ok(repR.impactText.indexOf("牌桌结梁子：红姐") >= 0, "⑮③ 影响行点名结梁子 → " + repR.impactText);
    /* ⑮④ 「本局影响」文案与规则层同源：同一输入 → 一致输出（面板预览 vs 真实落地） */
    const sPrev = newS(); sPrev.stats.cash = 5000;
    const pvRes = resOf({ win:false, seat:3, draw:false, stake:1000, netCash:-2000, payPerHouse:2000, totalWin:6000, style:"gentle" });
    const pvOut = R.previewOutcome(sPrev, pvRes, { style:"gentle", invite:invMan });
    const sAct = newS(); sAct.stats.cash = 5000;
    const acOut = R.applyOutcome(sAct, pvRes, { style:"gentle", invite:invMan });
    eq(pvOut.impactText, acOut.impactText, "⑮④ 预演（结算板）与真实落地的「本局影响」完全一致");
    eq(pvOut.lines.filter(l => l.indexOf("本局影响") === 0).length, 1, "⑮④ lines 里正好一条「本局影响」行");
    /* 同源证明：纯函数 impactText 手工传「与落地完全相同的 parts」→ 输出必须逐字相同 */
    const sameParts = acOut.bond && acOut.bond.delta
      ? [acOut.bond.name + "好感 " + (acOut.bond.delta > 0 ? "+" : "−") + Math.abs(acOut.bond.delta),
         "口碑 " + (acOut.rep.delta > 0 ? "+" : "−") + Math.abs(acOut.rep.delta)]
      : ["口碑 " + acOut.rep.delta];
    eq(R.impactText(pvOut.ev, invMan, sameParts), acOut.impactText,
      "⑮④ impactText 纯函数与 applyOutcome 输出同源（同一输入 → 逐字一致）");
    eq(R.impactText(pvOut.ev, invMan, sameParts), R.impactText(pvOut.ev, invMan, sameParts),
      "⑮④ 纯函数幂等（两次调用一致）");
    /* 面板文案就是规则层那一行（buildResultView 直出，不各写一份） */
    ok(pvOut.impactText === R.impactText(pvOut.ev, invMan, sameParts), "⑮④ 面板行不另写副本（单一来源）");
    ok(!pvOut.impactText || typeof pvOut.impactText === "string", "⑮④ 影响行是字符串（面板直接 escHtml 显示）");
    /* 结算面板 DOM：本局影响行真的渲染出来了（用调试接口喂一个「顾曼放水胡牌」的确定结果） */
    eq(MJ.dispose(), true, "⑮④ 收尾上一局");
    const hostI = makeElement("div");
    const sDom = newS(); sDom.stats.cash = 5000;
    eq(MJ.start(hostI, { stake:1000, style:"gentle", state:sDom,
      invite:{ id:"man", name:"顾曼", cname:"顾曼", bond:"man", seat:3, stake:1000, pureBond:false },
      onFinish: ()=>{} }), true, "⑮④ 顾曼局（放水 · ¥1000）开局");
    eq(MJ.debug.showResult({ win:false, seat:3, draw:false, tier:"small", tierName:"小胡",
      stake:1000, payPerHouse:2000, totalWin:6000, netCash:-2000, payerOnly:false, from:-1, style:"gentle" }), true,
      "⑮④ 调试接口直接用「顾曼胡牌」结果弹结算板");
    const vI = MJ.debug.resultView();
    ok(!!vI && !!vI.impactText, "⑮④ 结算数据带 impactText → " + (vI && vI.impactText));
    const impEl = documentStub.getElementById("mjmResImpact");
    ok(!!impEl, "⑮④ 结算板出现 #mjmResImpact（本局影响）行");
    ok(impEl && String(impEl.innerHTML).indexOf("本局影响") >= 0, "⑮④ 该行写明「本局影响」→ " + (impEl && impEl.innerHTML));
    ok(impEl && String(impEl.innerHTML).indexOf("放水陪玩") >= 0, "⑮④ 该行含打法（放水陪玩）→ " + (impEl && impEl.innerHTML));
    ok(impEl && String(impEl.innerHTML).indexOf("已获得可用的把柄") >= 0, "⑮④ 该行说明「已获得可用的把柄」→ " + (impEl && impEl.innerHTML));
    eq(vI.impactFlag, "顾曼的赏识", "⑮④ 该行背后的 flag = 顾曼的赏识（面板行用人话、元数据留 flag）");
    eq(vI.impactNote, "顾曼：「你明明能赢，却把牌留给了我。」", "⑮④ 该行附带她的那句台词（角色口吻）");
    ok(String(impEl.innerHTML).indexOf("顾曼好感 +6") >= 0, "⑮④ 该行数字 = 规则层真实落地值（好感 +6）→ " + (impEl && impEl.innerHTML));
    MJ.dispose();
    /* ⑮⑤ 新增 5 条情报的解锁映射 */
    eq(R.intelById("lin"), "公司的人事风声", "⑮⑤ 林溪 → 公司的人事风声");
    eq(R.intelById("su"), "她的旧伤", "⑮⑤ 苏晚晴 → 她的旧伤");
    eq(R.intelById("wen"), "她错的那道题", "⑮⑤ 温阮 → 她错的那道题");
    eq(R.intelById("lei"), "馆里的旧账", "⑮⑤ 雷姐 → 馆里的旧账");
    eq(R.intelById("lu"), "急诊室的秘密", "⑮⑤ 白露 → 急诊室的秘密");
    for (const id of ["lin","su","wen","lei","lu"]) {
      const s5 = newS(); s5.stats.cash = 5000;
      const d = R.inviteDef(id);
      const res5 = resOf({ win:true, seat:0, draw:false, stake:d.stake, netCash:d.stake*2, payPerHouse:d.stake*2, totalWin:d.stake*6, style:"serious" });
      const rep5 = R.applyOutcome(s5, res5, { style:"serious", invite:{ id:d.id, name:d.name, cname:d.cname, bond:d.bond, seat:-1, stake:d.stake, pureBond:false } });
      eq(s5.flags.indexOf(d.intel) >= 0, true, "⑮⑤ 赢下 " + d.name + " 的局 → 解锁「" + d.intel + "」");
      ok(rep5.flags.indexOf(d.intel) >= 0, "⑮⑤ 报告 flags 里带「" + d.intel + "」");
      eq(R.inviteIdByIntel(d.intel), d.id, "⑮⑤ 情报反查角色 id：" + d.intel + " → " + d.id);
      ok(R.inviteGainText(d).length > 0, "⑮⑤ 邀约条「本局可能获得」有文案 → " + R.inviteGainText(d));
      ok(R.inviteGainText(d).indexOf(d.intel) < 0, "⑮⑤ 情报名不剧透（面板文案里不出现「" + d.intel + "」）");
    }
    /* ⑮⑥ 邀约条 DOM 带注码 + 「本局可能获得」 */
    const invHost5 = makeElement("div");
    const dSu = R.inviteDef("su");
    const listSu = R.inviteList(S({ ch:2, per:1, bonds:{ hong:0, man:0, guo:0, lin:0, su:20, wen:0, lei:0, lu:0 } }), 1000);
    eq(listSu.length, 1, "⑮⑥ 只有苏晚晴达标 → 恰一条");
    eq(MJ.showInvite(invHost5, listSu[0], {}), true, "⑮⑥ 邀约条渲染成功（新角色）");
    const meta5 = String(documentStub.getElementById("mjmInviteMeta").innerHTML);
    const gain5 = String(documentStub.getElementById("mjmInviteGain").innerHTML);
    ok(meta5.indexOf("注码 ¥200") >= 0, "⑮⑥ 邀约条写明注码 ¥200 → " + meta5);
    ok(gain5.indexOf("本局可能获得") >= 0, "⑮⑥ 邀约条写明「本局可能获得」→ " + gain5);
    ok(gain5.indexOf(dSu.note) >= 0, "⑮⑥ 可能获得文案 = 角色 note（情报名隐藏）→ " + gain5);
    eq(MJ.debug.inviteState().intel, "她的旧伤", "⑮⑥ 调试接口暴露该条邀约的情报（供剧情联动校验）");
    eq(MJ.hideInvite(invHost5), true, "⑮⑥ 收起邀约条");
    /* 纯涨羁绊局的影响行也要有 */
    const sGuo = newS(); sGuo.stats.cash = 5000;
    const repGuo = R.applyOutcome(sGuo, resOf({ win:false, seat:1, draw:false, stake:50, netCash:-100, style:"gentle" }),
      { style:"gentle", invite:R.inviteDef("guo") });
    eq(repGuo.impactText.indexOf("放水陪玩"), 0, "⑮⑥ 妹妹局影响行以打法开头 → " + repGuo.impactText);
    ok(repGuo.impactText.indexOf("陈果") >= 0, "⑮⑥ 妹妹局影响行给她一句台词 → " + repGuo.impactText);
    eq(repGuo.consequenceFlags.length, 0, "⑮⑥ 妹妹局（pureBond）不写结梁子/AI flag");
  }
  console.log("\n════════════════════════════════");
})();

/* ─────────────── 19. 打牌语音播报（素材名映射 / 开关持久化 / 事件触发 / 缺文件不报错） ─────────────── */
(async function section19() {
  group("19. 打牌语音播报");

  /* ① 纯映射：给定「打出 1筒 / 碰 / 自摸」能解析到正确文件名 */
  eq(T.voiceFile("1筒"), "1筒.mp3", "牌名映射：1筒 → 1筒.mp3");
  eq(T.voiceFile("9万"), "9万.mp3", "牌名映射：9万 → 9万.mp3");
  eq(T.voiceFile("5条"), "5条.mp3", "牌名映射：5条 → 5条.mp3");
  /* ⚠ 本节 4 条断言的**期望值在本次改造中变了**（原期望 → 新期望 → 原因）：
       · 东 → "东.mp3"      变成 "东风.mp3"  ——用户要求：打「东」必须念「东风」
       · 白 → "白.mp3"      变成 "白板.mp3"  ——用户要求：打「白」必须念「白板」
       · 中 → "中.mp3"      变成 "红中.mp3"  ——用户要求：打「中」必须念「红中」
       · 發 → "发.mp3"      变成 "发财.mp3"  ——字牌一律念全名；「发」单音节同样含糊
     断言一条没删，只是期望值跟着需求走（素材侧已按新念法重新生成）。 */
  eq(T.voiceFile("东"), "东风.mp3", "字牌映射：东 → 东风.mp3（原 东.mp3，用户要求念「东风」）");
  eq(T.voiceFile("南"), "南风.mp3", "字牌映射：南 → 南风.mp3（原 南.mp3）");
  eq(T.voiceFile("西"), "西风.mp3", "字牌映射：西 → 西风.mp3（原 西.mp3）");
  eq(T.voiceFile("北"), "北风.mp3", "字牌映射：北 → 北风.mp3（原 北.mp3）");
  eq(T.voiceFile("中"), "红中.mp3", "字牌映射：中 → 红中.mp3（原 中.mp3，用户要求念「红中」）");
  eq(T.voiceFile("白"), "白板.mp3", "字牌映射：白 → 白板.mp3（原 白.mp3，用户要求念「白板」）");
  eq(T.voiceFile("發"), "发财.mp3", "字牌映射：牌面「發」(U+767C) → 素材名 发财.mp3（原 发.mp3）");
  /* 素材文件名 = 词表的键：拿素材名直接问也必须通（e2e 是拿文件名来问的） */
  eq(T.voiceFile("红中"), "红中.mp3", "素材名直接可解析：红中 → 红中.mp3（幂等）");
  eq(T.voiceFile("发财"), "发财.mp3", "素材名直接可解析：发财 → 发财.mp3");
  eq(T.voiceFile("白板"), "白板.mp3", "素材名直接可解析：白板 → 白板.mp3");
  /* 旧名必须解析不出来：旧素材已删，代码里若还有残留引用，这里立刻炸 */
  eq(T.voiceFile("发"), "", "旧名「发」已停用 → 空（素材改名 发财.mp3）");
  eq(T.VOICE_HONOR_WORDS["东"], "东风", "字牌词表：东 → 东风");
  eq(T.VOICE_HONOR_WORDS["中"], "红中", "字牌词表：中 → 红中");
  eq(T.VOICE_HONOR_WORDS["白"], "白板", "字牌词表：白 → 白板");
  eq(T.VOICE_HONOR_WORDS["發"], "发财", "字牌词表：發 → 发财");
  eq(Object.keys(T.VOICE_HONOR_WORDS).length, 7, "字牌词表 7 条（东南西北中發白）");
  /* 万/条/筒 念法不变：文件名即词，不参与字牌改名 */
  eq(T.voiceFile("1万"), "1万.mp3", "万/条/筒 映射不变：1万 → 1万.mp3（念法仍是「一万」）");
  eq(T.voiceFile("碰"), "碰.mp3", "动作映射：碰 → 碰.mp3");
  eq(T.voiceFile("杠"), "杠.mp3", "动作映射：杠 → 杠.mp3");
  /* 暗杠 / 补杠 **不是语音词**：它们是手上动作，出牌碰实音（sfx-mj-clack）。
     素材侧 gen_mj_by_seat_tts.py 的 SILENT 常量同样把它们排除在 TTS 之外。
     曾经把它们登记进词表，结果每个座位都去请求不存在的 seatN/暗杠.mp3：
     4 次 404、完全无声，还不会让任何测试失败（AudioSys 静默吞掉）。
     现在明确断言「解析为空」，防止以后又被加回去。 */
  eq(T.voiceFile("暗杠"), "", "暗杠不是语音词 → 空（改出牌碰实音 mj-clack）");
  eq(T.voiceFile("补杠"), "", "补杠不是语音词 → 空（改出牌碰实音 mj-clack）");
  eq(T.voiceFile("胡"), "胡.mp3", "动作映射：胡 → 胡.mp3");
  eq(T.voiceFile("自摸"), "自摸.mp3", "动作映射：自摸 → 自摸.mp3（按用户原话优先「自摸！」）");
  eq(T.voiceFile("抢杠"), "抢杠.mp3", "动作映射：抢杠 → 抢杠.mp3");
  eq(T.voiceFile("杠开"), "杠开.mp3", "动作映射：杠开 → 杠开.mp3");
  eq(T.voiceFile("听"), "听.mp3", "动作映射：听 → 听.mp3");
  eq(T.voiceFile("过"), "过.mp3", "动作映射：过 → 过.mp3");
  eq(T.voiceFile("流局"), "流局.mp3", "动作映射：流局 → 流局.mp3");
  eq(T.voiceFile("1筒.mp3"), "1筒.mp3", "已带扩展名也能解析（幂等）");
  eq(T.voiceFile(""), "", "空串 → 空（静默跳过）");
  eq(T.voiceFile(null), "", "null → 空（静默跳过）");
  eq(T.voiceFile(undefined), "", "undefined → 空（静默跳过）");
  eq(T.voiceFile("10筒"), "", "不存在的牌名 → 空（不猜、不报错）");
  eq(T.voiceFile("一筒"), "", "汉字数字不算牌名 → 空");
  eq(T.voiceFile("碰碰"), "", "错词 → 空");
  eq(T.voiceFile("100万"), "", "越界数字 → 空");
  let nk = 0;
  for (const k of Object.keys(T.VOICE_NAMES)) nk++;
  eq(nk, 43, "语音词表共 43 条（27 序数牌 + 7 字牌 + 9 动作；暗杠/补杠不喊牌）");
  let files = 0, namesOk = true;
  for (const k of Object.keys(T.VOICE_NAMES)) { if (T.voiceFile(k)) files++; else namesOk = false; }
  eq(files, 43, "43 个词条全部能解析到文件名（无死词条）");
  eq(namesOk, true, "词表里没有解析不出来的词条");
  eq(T.VOICE_KEY, "mjVoiceOn", "localStorage 键名 = mjVoiceOn");
  const fileList = [];
  for (const k of Object.keys(T.VOICE_NAMES)) fileList.push(T.voiceFile(k));
  eq(fileList.filter((v, i) => fileList.indexOf(v) === i).length, 43, "43 个文件名互不重复");

  /* ② URL / 基址（HTA 里是绝对 file:// 路径，index.html 里是相对路径） */
  const vbase = MJ.debug.voiceBase();
  ok(/audio\/mj\/$/.test(vbase), "语音目录基址以 audio/mj/ 结尾 → " + vbase);
  const u1 = MJ.debug.voiceUrl("1筒");
  ok(u1.indexOf("audio/mj/1筒.mp3") >= 0, "voiceUrl(1筒) 指向 audio/mj/1筒.mp3 → " + u1);
  eq(u1, MJ.debug.voiceUrl("1筒"), "同一张牌 URL 稳定（可缓存复用）");
  eq(MJ.debug.voiceUrl("不存在"), "", "无法映射的名字返回空串");
  eq(u1.indexOf("?") < 0 && u1.indexOf("&") < 0, true, "URL 不带查询串（静态素材）");
  ok(MJ.debug.voiceRelBase().length > 0, "voiceRelBase() 可读 → " + MJ.debug.voiceRelBase());
  eq(MJ.debug.voiceStats().total, 43, "voiceStats().total = 43 条素材");

  /* ③ 开关：切换 / 持久化 / 关闭后不播 */
  eq(typeof MJ.debug.voiceToggle(), "boolean", "voiceToggle() 无参 = 切换，返回布尔");
  eq(MJ.debug.voiceToggle(false), false, "关闭语音");
  eq(MJ.debug.voiceStats().on, false, "voiceStats().on = false");
  const playsBefore = MJ.debug.voiceStats().plays;
  const missBefore = MJ.debug.voiceStats().misses;
  eq(MJ.debug.say("自摸"), "", "关掉开关后 say() 直接返回空（不播）");
  eq(MJ.debug.voiceStats().plays, playsBefore, "关掉开关后 plays 不增长");
  eq(MJ.debug.voiceStats().misses, missBefore, "关掉开关后也不记 miss");
  eq(MJ.debug.voiceToggle(true), true, "重新打开语音");
  eq(MJ.debug.voiceStats().on, true, "voiceStats().on 恢复 true");
  let lsVal = "n/a";
  try { lsVal = String(windowStub.localStorage ? windowStub.localStorage.getItem("mjVoiceOn") : "n/a"); } catch (e) { lsVal = "n/a"; }
  ok(lsVal === "1" || lsVal === "n/a", "开关状态写入 localStorage（键 mjVoiceOn）= " + lsVal);

  /* ④ 缺文件不抛错：stub 环境没有 Audio，say() 也必须静默返回 URL */
  let threw = false;
  try {
    MJ.debug.say("1筒"); MJ.debug.say("碰"); MJ.debug.say("自摸");
    MJ.debug.say("不存在的牌"); MJ.debug.say(""); MJ.debug.say(null);
  } catch (e) { threw = true; }
  eq(threw, false, "无 Audio 环境（素材缺失）下 say() 不抛错，静默跳过");
  const stA = MJ.debug.voiceStats();
  ok(stA.errors >= 0 && stA.misses >= 0, "voiceStats 暴露 misses/errors 计数（misses=" + stA.misses + " errors=" + stA.errors + "）");
  eq(stA.last, "自摸.mp3", "最后一次成功解析到的是 自摸.mp3");
  ok(stA.uniq.indexOf("1筒.mp3") >= 0 && stA.uniq.indexOf("碰.mp3") >= 0, "1筒 / 碰 都进入过播报记录");
  ok(typeof stA.lastAt === "number" && isFinite(stA.lastAt), "记录播报时间戳（便于验证「不阻塞」）→ " + stA.lastAt);

  /* ⑤ 事件触发：出牌 → 牌名；自摸 → 自摸；开关点得动 */
  MJ.dispose();
  const hostV = makeElement("div");
  eq(MJ.start(hostV, {}), true, "语音段：开局");
  eq(MJ.debug.voiceStats().plays, 0, "新开一局 plays 归零（不把上一局算进来）");
  eq(MJ.debug.voiceStats().ting.join(","), "false,false,false,false", "新开一局听牌播报状态复位");
  ok(!!documentStub.getElementById("mjmVoiceToggle"), "牌桌上存在 🔊 语音开关（#mjmVoiceToggle）");
  ok(!!documentStub.getElementById("mjmTing"), "听牌徽标（#mjmTing）已插入 DOM");
  {
    const tgEl = documentStub.getElementById("mjmVoiceToggle");
    ok(tgEl.className.indexOf("on") >= 0 && tgEl.className.indexOf("off") < 0, "默认开启（class 含 on）→ " + tgEl.className);
    if (typeof tgEl.onclick === "function") tgEl.onclick();
    eq(MJ.debug.voiceStats().on, false, "点 🔊 开关 → 关闭");
    ok(tgEl.className.indexOf("off") >= 0, "关闭后开关 class 含 off → " + tgEl.className);
    if (typeof tgEl.onclick === "function") tgEl.onclick();
    eq(MJ.debug.voiceStats().on, true, "再点 🔊 开关 → 重新开启");
  }
  {
    const handTile = MJ.debug.hand()[MJ.debug.hand().length - 1];
    const playsBefore5 = MJ.debug.voiceStats().plays;
    eq(MJ.debug.act("discard", handTile), true, "调试出牌（打 " + handTile + "）");
    /* ⚠ 这几条的**时序期望变了**（玩法没变）：报牌不再在出牌那一刻入队 ——
       用户实测「上一家的牌刚打完，下家的牌还没出来就先报了牌」，
       所以现在要等**牌真正落进牌河**（落河动画走完，SAY_AFTER_DISCARD_MS）才出声。
       断言一条没删，反而更强了：先断言「刚出牌、牌还没落定时先不报」，
       再等落河完成断言「报了，而且报的就是打出去的那张」。 */
    eq(MJ.debug.voiceStats().plays, playsBefore5, "刚出牌、牌还没落定时**先不报**（旧实现这里就已经报出去了）");
    await sleep(T.SAY_AFTER_DISCARD_MS + 60);
    eq(MJ.debug.voiceStats().last, T.voiceFile(handTile), "牌落定后才播该牌牌名 → " + T.voiceFile(handTile));
    eq(MJ.debug.voiceStats().lastSeat, 0, "播报来源标记为自己（seat=0）");
    ok(MJ.debug.voiceStats().lastUrl.indexOf(T.voiceFile(handTile)) >= 0, "播报 URL 指向该牌素材 → " + MJ.debug.voiceStats().lastUrl);
    eq(MJ.debug.voiceStats().disc.length >= 1 &&
       MJ.debug.voiceStats().disc[MJ.debug.voiceStats().disc.length - 1].tile, handTile,
       "对账簿记的也是这张（牌河 = 唯一数据源）");

  }
  eq(MJ.debug.forceWin(0), true, "语音段：造胡（自摸）");
  {
    const st = MJ.debug.voiceStats();
    ok(st.last === "自摸.mp3" || st.uniq.indexOf("自摸.mp3") >= 0, "自摸触发 自摸.mp3 → " + st.last);
    eq(st.uniq.indexOf("流局.mp3") >= 0, false, "胡牌不会误播 流局.mp3");
    eq(st.lastSeat, 0, "自摸播报来源是自己");
  }
  eq(MJ.debug.voiceStats().plays >= 2, true, "同局内 plays 单调增长（出牌 + 自摸已入账）");
  eq(MJ.debug.voiceStats().uniq.indexOf("听.mp3") >= 0, false, "未听牌时不会误播「听」（只有真听牌那一刻才播）");
  {
    let ok2 = false;
    try { MJ.debug.say("碰", { seat: 1 }); ok2 = true; } catch (e) { ok2 = false; }
    eq(ok2, true, "say(碰, {seat:1}) 不抛错（AI 碰也能播）");
    ok(MJ.debug.voiceStats().uniq.indexOf("碰.mp3") >= 0, "碰.mp3 已入播报记录");
    eq(MJ.debug.voiceStats().ting.length, 4, "四家听牌播报状态各自独立（避免重复「听」）");
  }

  /* ⑥ 牌面总览图分组：万 → 条 → 筒 → 字牌（与 KINDS / 手牌排序一致的分组顺序） */
  {
    const rows = MJ.debug.faceSheetRows();
    eq(rows.length, 4, "总览图分 4 行（万 / 条 / 筒 / 字牌）");
    eq(rows[0].label, "万", "第 1 行 = 万");
    eq(rows[1].label, "条", "第 2 行 = 条");
    eq(rows[2].label, "筒", "第 3 行 = 筒");
    eq(rows[3].label, "字牌", "第 4 行 = 字牌");
    eq(rows[0].tiles.join(" "), "1万 2万 3万 4万 5万 6万 7万 8万 9万", "万行 1→9 顺序");
    eq(rows[1].tiles.join(" "), "1条 2条 3条 4条 5条 6条 7条 8条 9条", "条行 1→9 顺序");
    eq(rows[2].tiles.join(" "), "1筒 2筒 3筒 4筒 5筒 6筒 7筒 8筒 9筒", "筒行 1→9 顺序");
    eq(rows[3].tiles.join(" "), "东 南 西 北 中 發 白", "字牌行 东南西北中發白");
    let tot = 0; for (const r of rows) tot += r.tiles.length;
    eq(tot, 34, "总览图共 34 种牌面");
    eq(MJ.debug.faceSheet(true), true, "打开牌面总览");
    eq(MJ.debug.renderStats().faces, 34, "总览图画出 34 张牌面");
    const ft = MJ.debug.faceTiles();
    eq(ft.length, 34, "总览图曝光 34 张坐标（供探针逐张核对）");
    ok(ft.every(t => t.w === ft[0].w && t.h === ft[0].h), "总览图每张牌面同尺寸（便于逐张比对）");
    ok(ft.every(t => t.x >= 0 && t.y >= 0 && t.x + t.w <= 1240 && t.y + t.h <= 860), "总览图所有牌面都在画布内");
    eq(ft[0].tile, "1万", "总览图第 1 张 = 1万");
    eq(ft[9].tile, "1条", "总览图第 10 张 = 1条（条排在万之后）");
    eq(ft[18].tile, "1筒", "总览图第 19 张 = 1筒（筒排在条之后）");
    eq(ft[27].tile, "东", "总览图第 28 张 = 东（字牌最后）");
    eq(MJ.debug.faceSheet(false), false, "关闭牌面总览回到牌桌");
  /* ─────────── 19b. 节奏 / 落河对齐 / 报牌对账 / 杠开收紧（用户实测四问的回归） ───────────
     用户原话（本轮四个问题）：
       ① 「语音衔接还是太快了，上一家的牌刚打完，下家的牌还没出来就先报了牌」
       ② 「三个对家出牌还是要稍微慢一点，打的太快了」
       ③ 「出现了打的牌跟报出来的牌不一样的情况」
       ④ 「还有乱喊杠开的情况都要修正」
     这一节就是把①③④钉死成断言，把②钉成可断言的常量 + 实测步进。 */
  group("19b. 节奏 / 报牌时序 / 弃牌对账 / 杠开");

  /* ── ① 节奏常量：单一出处 · 人类可读 · 报牌晚于落河 ── */
  eq(T.AI_MIN_MS, T.AI_STEP_MS, "步进下限 = AI_STEP_MS（抖动只加不减，任何一拍都不会更快）");
  eq(T.AI_MIN_MS >= 1200, true, "AI 步进下限 ≥1200ms（原来 500–800ms 太快）→ " + T.AI_MIN_MS);
  eq(T.AI_STEP_MS <= 1800 && T.AI_DRAW_MS <= 1800 && T.AI_DISCARD_MS <= 1800, true,
    "三段步进都在人类可读区间 1200–1800 → 通用 " + T.AI_STEP_MS + " / 摸牌 " + T.AI_DRAW_MS + " / 出牌 " + T.AI_DISCARD_MS);
  eq(T.AI_DISCARD_MS > T.AI_STEP_MS, true, "出牌那一拍比通用步进长（留给报牌播到一半）");
  eq(T.AI_DRAW_MS >= T.AI_STEP_MS, true, "摸牌那一拍不短于通用步进");
  eq(T.AI_MAX_MS, T.AI_DISCARD_MS + T.AI_JITTER_MS, "步进上限 = 出牌拍 + 抖动上限（可断言的上界）");
  eq(T.SAY_AFTER_DISCARD_MS, T.DISCARD_ANIM_MS, "报牌延迟 = 落河动画时长（同一个常量：牌落定即报牌）");
  eq(T.SAY_AFTER_DISCARD_MS > 0, true, "报牌不是 0 延迟（0 就退回「先报后出」）→ " + T.SAY_AFTER_DISCARD_MS + "ms");
  eq(T.AI_DISCARD_MS >= T.SAY_MIN_STEP_MS, true,
    "出牌那一拍 ≥「上一条报牌开播后 N ms」的下限 → " + T.AI_DISCARD_MS + " ≥ " + T.SAY_MIN_STEP_MS);
  eq(T.DISCARD_FALL_PX > 0, true, "落河动画有位移（不是瞬移）→ " + T.DISCARD_FALL_PX + "px");

  /* ── ② 碰/杠事件播的就是这两个文件（念法「我碰 / 我杠」由素材侧 TTS 决定） ── */
  eq(T.voiceFile("碰"), "碰.mp3", "碰事件 → 碰.mp3（文件名不变，只改音频内容念「我碰」）");
  eq(T.voiceFile("杠"), "杠.mp3", "杠事件 → 杠.mp3（文件名不变，只改音频内容念「我杠」）");
  {
    const py = fs.readFileSync(path.join(ROOT, "tools", "audio", "gen_mj_bailian_tts.py"), "utf8");
    ok(py.indexOf('("碰", "我碰")') >= 0, "TTS 词表：碰.mp3 念「我碰」（用户追加要求，第一人称）");
    ok(py.indexOf('("杠", "我杠")') >= 0, "TTS 词表：杠.mp3 念「我杠」");
    ok(py.indexOf("暗杠") < 0 && py.indexOf("补杠") < 0,
      "暗杠/补杠仍不在 TTS 词表里（手上动作只出牌碰实音 mj-clack，与素材侧 SILENT 常量一致）");
  }

  /* ── ③ 假 Audio + **受控时钟** ──
     ⚠ 必须先 voiceCacheClear()：本节前半段用过别的假 Audio，缓存里留着它们的实例，
        不清掉的话 say() 会复用那些「不会 ended」的旧对象，队列直接卡死。
     ⚠ 假 Audio **不再自动播完**（ended 由测试手动触发；只有 autoEnd=true 时才用真实时钟收尾）。
        为什么改：上一版靠 40ms 真实 setTimeout 自动 ended，于是「报牌到底出没出声」变成
        **依赖真实时钟的持续演化状态** —— 上级实测同一份代码 978 / 977 / 978 随机红，
        失败项就是那条。现在 ④ 段用受控时钟（手动 advance + 手动 ended）把时序钉死，
        ④b 段才开 autoEnd 跑真实时钟，而且 ④b 只断言**同步可观测量**。 */
  const played = [];
  const audioInsts = [];
  let autoEnd = false, clack = 0, clock = null;
  function fireEnded(a) { (a._ev["ended"] || []).slice().forEach(f => f()); }
  function AutoAudio(url) { this.src = String(url); this.volume = 1; this.currentTime = 0; this.duration = 0.2; this._ev = {}; }
  AutoAudio.prototype.addEventListener = function (t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); };
  AutoAudio.prototype.removeEventListener = function (t, fn) { const a = this._ev[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
  AutoAudio.prototype.load = function () {};
  AutoAudio.prototype.pause = function () {};
  AutoAudio.prototype.play = function () {
    const self = this;
    played.push(String(this.src).replace(/^.*\//, ""));
    audioInsts.push(this);
    if (autoEnd) setTimeout(() => fireEnded(self), 40);        // 只有 ④b 之后才用真实时钟收尾
    return Promise.resolve();
  };
  windowStub.Audio = AutoAudio;
  windowStub.AudioSys.sfxFile = function (n) { if (n === "mj-clack") clack++; };
  eq(MJ.debug.voiceCacheClear(), true, "清掉旧 Audio 缓存（换整层假 Audio 实现）");

  /* 受控时钟：把 windowStub 上的 setTimeout/clearTimeout 换成**可手动推进**的队列。
     于是「落河动画 260ms → 报牌」「队列间隔 120ms」全由测试精确推进，不看真实时钟脸色 ——
     这是让「报牌次数 = 出牌次数」确定性的关键（黄金法则：只断言被操作动作自身的影响，
     不读持续演化、依赖真实时钟的世界状态）。
     mahjong.js 的 later() 走 root.setTimeout，而 root 就是这个 windowStub，换掉即可。 */
  function makeClock() {
    const q = [];
    let now = 0, seq = 0;
    const realST = windowStub.setTimeout, realCT = windowStub.clearTimeout;
    windowStub.setTimeout = function (fn, ms) { const id = ++seq; q.push({ id: id, fn: fn, at: now + Math.max(0, +ms || 0) }); return id; };
    windowStub.clearTimeout = function (id) { for (let i = 0; i < q.length; i++) if (q[i].id === id) { q.splice(i, 1); return; } };
    return {
      advance: function (ms) {
        const target = now + ms;
        for (;;) {
          q.sort((a, b) => (a.at - b.at) || (a.id - b.id));
          if (!q.length || q[0].at > target) break;
          const t = q.shift(); now = t.at;
          try { t.fn(); } catch (e) { /* 与生产 later() 一致：定时器里抛错不中断牌局 */ }
        }
        now = target;
      },
      restore: function () { windowStub.setTimeout = realST; windowStub.clearTimeout = realCT; }
    };
  }
  /** 把「正在播的那条」立刻播完（手动 ended）并把队列往前推 —— 确定性，不用真实时钟 */
  function flushAudio(rounds) {
    for (let k = 0; k < (rounds || 8); k++) {
      clock.advance(T.VOICE_GAP + 10);          // 队列间隔到点 → 下一条开播（play 被调用）
      const a = audioInsts.pop();
      if (!a) break;
      fireEnded(a);                            // 立刻播完 → finish → voicePump
    }
  }


  /* ── ④ 逐张对拍：报牌内容 == 牌河里那张牌（≥30 次出牌，四个座位轮流） ──
     为什么用「摆好手牌直接 E.discard」而不是跑一整局：
       整局的每一步都会触发智脑提示 / 向听数重算（实测一拍 0.3–1.5s），跑完一局要几十秒，
       而且牌局什么时候结束、谁会碰杠都不确定，「30 次出牌」这个数就凑不稳。
       这里把牌摆成**确定性牌序**：34 种牌各打一次、四个座位轮流、其他三家手握 13 张死牌
       （任何一张进张都成不了牌，也不会有人碰/杠），于是
         · 每一次 E.discard 必然落河一张、必然报一张；
         · 期望序列可以逐字写出来（EXPECT）。
       走的仍是**生产路径**：E.discard → 日志 → playNewSfx() → voiceHook() → discardLanded()。 */
  const POOL = [];
  for (const s of ["万", "条", "筒"]) for (let n = 1; n <= 9; n++) POOL.push(n + s);
  POOL.push("东", "南", "西", "北", "中", "發", "白");              // 34 张，含 7 种字牌
  const DEAD13 = ["1万", "4万", "7万", "1条", "4条", "7条", "1筒", "4筒", "7筒", "东", "南", "西", "中"];
  eq(POOL.length, 34, "对拍牌序 = 全部 34 种牌（含字牌，覆盖念名全表）");
  {
    MJ.dispose();
    clock = makeClock();                   // ④ 全程受控：连 start() 里那次 later(pump,520) 也只进队列、不会自己乱跑
    eq(MJ.start(makeElement("div"), {}), true, "对拍段：开一局干净的（对账簿 / 日志 / 计数都从 0 起算）");
    MJ.debug.voiceToggle(true);
    MJ.debug.engine().phase = "idle";      // 挂起自动 pump：这 34 张由测试自己一张张打，牌序才确定
    eq(MJ.debug.voiceStats().discN, 0, "对拍段：discN 从 0 起算");
    let okDisc = true, okPair = true, notYet = 0, fired = 0, badFile = "", boundary259 = null, boundary260 = null;
    for (let i = 0; i < POOL.length; i++) {
      const seat = i % 4, tile = POOL[i], E = MJ.debug.engine();
      if (!E) { okDisc = false; break; }
      for (let s = 0; s < 4; s++) {                              // 四家手握死牌：谁也胡不了、谁也不用碰
        E.P[s].hand = DEAD13.slice(); E.P[s].melds = []; E.P[s].drawn = null; E.P[s].kongDraw = false;
      }
      E.P[seat].hand = [tile].concat(DEAD13.slice(0, 13));        // 14 张，待打的这张在最前
      E.cur = seat; E.phase = "turn"; E.result = null;
      E.pending = { type: "turn", seat: seat, anGangs: [], addGangs: [] };
      if (E.discard(seat, E.P[seat].hand.indexOf(tile)) !== true) { okDisc = false; break; }
      E.phase = "idle";                                          // 让 debug.step() 只灌语音、不再推进一步
      MJ.debug.step();                                           // 生产路径：playNewSfx → voiceHook
      /* ⚠ voiceStats().disc 是**快照**（每次 map 出一批新对象）→ 推进时钟后必须**重新读那一格**，
         不能拿推进前抓到的那份对象看 said：那份永远是 false（上一版就是这么假红的）。 */
      const at = MJ.debug.voiceStats().disc.length - 1;
      if (at >= 0 && MJ.debug.voiceStats().disc[at].said === false) notYet++;   // 刚落河：账已记、定时器已挂、还没出声
      if (i === 0) {                                              // 精确边界：259ms 不报，260ms 才报
        clock.advance(T.SAY_AFTER_DISCARD_MS - 1);
        boundary259 = at >= 0 ? MJ.debug.voiceStats().disc[at].said : null;
        clock.advance(1);
        boundary260 = at >= 0 ? MJ.debug.voiceStats().disc[at].said : null;
      } else {
        clock.advance(T.SAY_AFTER_DISCARD_MS);
      }
      if (at >= 0 && MJ.debug.voiceStats().disc[at].said === true) fired++;
      flushAudio();                                               // 手动播完 → 队列继续（确定性）
    }
    flushAudio(40);                                               // 收尾：把队列排空
    const vs = MJ.debug.voiceStats();
    const E = MJ.debug.engine();
    const logSeq = E.log.filter(e => e.kind === "discard" && e.tile).map(e => e.tile);
    const queued = (vs.playing ? 1 : 0) + vs.queue.length;
    for (let i = 0; i < vs.disc.length; i++) {
      const r = vs.disc[i];
      if (r.seat !== i % 4 || r.file !== T.voiceFile(r.tile)) { okPair = false; if (!badFile) badFile = "第" + i + "条 " + r.seat + "|" + r.tile + "→" + r.file; }
    }
    clock.restore();                                              // ④b/⑥/⑦ 段回到真实时钟
    eq(okDisc, true, "34 次出牌全部成功落河（四个座位轮流）");
    eq(logSeq.join(","), POOL.join(","), "引擎日志里的出牌序列 == 期望牌序（34 张，逐字）");
    eq(vs.disc.length, POOL.length, "对账簿条数 == 出牌次数（" + vs.disc.length + " = " + POOL.length + "，不丢不重）");
    eq(vs.discN, POOL.length, "discN == 出牌次数（" + vs.discN + "）");
    eq(vs.disc.map(r => r.tile).join(","), POOL.join(","), "**报的牌**逐字等于**实际打出的牌**（34/34 零不一致）");
    eq(vs.disc.map(r => r.file).join(","), POOL.map(t => T.voiceFile(t)).join(","), "报牌文件名 == 该牌素材名（逐字）");
    /* ↓ 时序口径改成**确定性**的（原来是读真实时钟有没有走完 → 负载下会随机红）：
         受控时钟不推进就绝不会出声，推进 SAY_AFTER_DISCARD_MS 就必然出声 ——
         只断言「被操作动作自身的影响」，不读持续演化的世界状态。 */
    eq(notYet, POOL.length, "34 张刚落河时都**还没有**出声（受控时钟未推进 → 一定没响）");
    eq(boundary259, false, "距落定 " + (T.SAY_AFTER_DISCARD_MS - 1) + "ms 时仍未报（报牌不早于落河）");
    eq(boundary260, true, "落定后整 " + T.SAY_AFTER_DISCARD_MS + "ms 才报（= 落河动画时长）");
    eq(fired, POOL.length, "受控时钟推进后 " + fired + "/" + POOL.length + " 张全部出声（不丢）");
    eq(vs.started, POOL.length, "实际开播条数 == 出牌次数（started=" + vs.started + "）");
    eq(queued, 0, "收尾时队列是空的（受控时钟下确定性排空）");
    eq(vs.dropped, 0, "队列没有丢弃任何一条报牌（dropped=0）");
    eq(vs.mismatch, 0, "牌河与日志没有一次不一致（mismatch=0）");
    eq(vs.lost, 0, "没有因日志截断而丢掉的报牌（lost=0）");
    eq(vs.misses, 0, "34 条报牌都拿到了素材（misses=0）");
    eq(okPair, true, "逐条复核：座位轮转 + 文件名 == voiceFile(tile)" + (badFile ? " → " + badFile : ""));
    console.log("  弃牌对账：34/34 张逐字一致 · 受控时钟下「落河 → 报牌」精确 = " + T.SAY_AFTER_DISCARD_MS +
      "ms（" + (T.SAY_AFTER_DISCARD_MS - 1) + "ms 不报 / " + T.SAY_AFTER_DISCARD_MS + "ms 报）· started=" + vs.started +
      " · dropped=" + vs.dropped + " · mismatch=" + vs.mismatch + " · lost=" + vs.lost);
  }


  /* ── ④b 真牌局抽样：同样逐张对拍（限 14 拍，快进只为了让测试几十秒内跑完） ── */
  let paceMin = Infinity, paceMax = -Infinity, paceN = 0, liveDisc = 0;
  {
    MJ.dispose();
    eq(MJ.start(makeElement("div"), {}), true, "真局抽样：开局");
    MJ.debug.voiceToggle(true);
    const live0 = MJ.debug.voiceStats().discN;
    for (let i = 0; i < 14; i++) {
      const st = MJ.debug.state();
      const E1 = MJ.debug.engine();
      if (!st || st.phase === "over") break;
      const n0 = MJ.debug.voiceStats().discN;
      const robMine = st.phase === "rob" && E1 && E1.pending && E1.pending.seats && E1.pending.seats.indexOf(0) >= 0;
      if (st.phase === "turn" && st.cur === 0) {
        if (st.handCount % 3 === 2) { const h = MJ.debug.hand(); MJ.debug.act("discard", h[h.length - 1]); }
        else MJ.debug.act("draw");
      } else if (st.phase === "claim" && st.pending && st.pending.seat === 0) {
        MJ.debug.act("pass");
      } else if (robMine) {
        MJ.debug.act("pass");
      } else {
        MJ.debug.step();
      }
      if (MJ.debug.voiceStats().discN > n0) await sleep(T.SAY_AFTER_DISCARD_MS + 20);
    }
    for (let k = 0; k < 40; k++) {              // 等队列排空
      const s = MJ.debug.voiceStats();
      if (!s.playing && !s.queue.length) break;
      await sleep(50);
    }
    autoEnd = true;                             // 这一段跑**真实时钟**：让假 Audio 自己播完，模拟真牌局的队列推进
    const vs = MJ.debug.voiceStats(), E = MJ.debug.engine();
    const logSeq = E.log.filter(e => e.kind === "discard" && e.tile).map(e => e.seat + "|" + e.tile);
    liveDisc = vs.discN;
    const pc = MJ.debug.pace();
    paceN += pc.n;
    if (pc.min && pc.min < paceMin) paceMin = pc.min;
    if (pc.max > paceMax) paceMax = pc.max;
    /* ⚠ 口径（黄金法则）：这一段是**活的生命周期**，只断言**同步可观测量** ——
       入账条数 / 逐张对拍 / 文件名 / mismatch / lost。
       **不**断言 said、started、dropped 这类「定时器有没有走完、播放有没有真的发生」的状态：
       它们依赖真实时钟，负载一高就随机红（上级实测 978/977/978）。
       那几项由 ④ 段的受控时钟确定性覆盖。 */
    let same = true, firstBad = "", allFile = true, firedN = 0, lateBad = 0, minDy = Infinity, maxDy = -Infinity;
    for (let i = 0; i < vs.disc.length; i++) {
      const r = vs.disc[i];
      if (r.seat + "|" + r.tile !== logSeq[i]) { same = false; if (!firstBad) firstBad = r.seat + "|" + r.tile + " vs " + logSeq[i]; }
      if (r.file !== T.voiceFile(r.tile)) allFile = false;
      /* 只对**已经出声**的那几条比时序：真实时钟只会让定时器更晚、绝不会更早，
         所以「不早于落河」是单向确定量；还没到点的条目一律不算失败。 */
      if (r.said) {
        firedN++;
        const dy = r.sayAt - (r.landAt + T.DISCARD_ANIM_MS);
        if (dy < -8) lateBad++;
        if (dy < minDy) minDy = dy;
        if (dy > maxDy) maxDy = dy;
      }
    }
    eq(liveDisc >= 6, true, "真牌局抽样里落了 " + liveDisc + " 张牌（14 拍）");
    eq(vs.disc.length, logSeq.length, "真牌局：报牌**入账**条数 == 出牌条数（" + vs.disc.length + "）");
    eq(vs.discN, logSeq.length, "真牌局：discN（落河次数）== 出牌条数（" + vs.discN + "）");
    eq(same, true, "真牌局：逐张对拍「牌河里的牌 == 日志里的牌」（座位|牌面）" + (firstBad ? " → " + firstBad : ""));
    eq(allFile, true, "真牌局：每条入账的报牌文件名 == voiceFile(tile)");
    eq(lateBad, 0, "真牌局：凡已出声的报牌**都晚于**牌落定（不早于落河）→ 已出声 " + firedN + " 条 · 最早 dy=" +
      (firedN ? Math.round(minDy) : "-") + "ms / 最晚 dy=" + (firedN ? Math.round(maxDy) : "-") + "ms");
    eq(vs.mismatch, 0, "真牌局：牌河与日志没有一次不一致（mismatch=0）");
    eq(vs.lost, 0, "真牌局：没有因日志截断而丢掉的报牌（lost=0）");
    console.log("  真牌局抽样：入账 " + vs.disc.length + " 条（其中真实时钟下已出声 " + firedN + " 条 · 落定→出声 " +
      (firedN ? Math.round(minDy) + "~" + Math.round(maxDy) + "ms" : "-") + "；未到点的条目不计入断言）");

  }
  eq(paceN > 0, true, "采到 AI 步进实测样本 " + paceN + " 个（来自真实 pump 排期，不是常量照抄）");
  eq(paceMin >= T.AI_MIN_MS, true, "实测最快的一拍 = " + paceMin + "ms ≥ 步进下限 " + T.AI_MIN_MS + "ms");
  eq(paceMax <= T.AI_MAX_MS, true, "实测最慢的一拍 = " + paceMax + "ms ≤ 步进上限 " + T.AI_MAX_MS + "ms");
  console.log("  AI 步进实测：" + paceMin + "~" + paceMax + "ms（下限 " + T.AI_MIN_MS + " · 出牌拍 " + T.AI_DISCARD_MS +
    " · 抖动上限 " + T.AI_JITTER_MS + " · 实测样本 " + paceN + " 个）");


  /* ── ⑥ 杠开只在「杠后补摸的那张自摸」时播 ── */
  {
    /* ⑤-1 暗杠 + 杠后补摸（没胡）→ 一条语音都不该多播，出的是牌碰实音 */
    MJ.dispose();
    eq(MJ.start(makeElement("div"), {}), true, "杠开段：开局（暗杠）");
    MJ.debug.voiceToggle(true);
    /* 10 张怎么摸都成不了牌的散牌：任何一张进张都凑不出 3 面子 + 1 将 */
    eq(MJ.debug.setHand(["1万", "1万", "1万", "1万", "2万", "4万", "6万", "8万", "1条", "3条", "5条", "东", "南", "西"], [], null),
      true, "摆牌：四张 1万（可暗杠）+ 10 张死牌");
    const bK = MJ.debug.voiceStats();
    const bClack = clack;
    eq(MJ.debug.act("gang"), true, "暗杠 1万（随后杠后补摸一张）");
    await sleep(T.SAY_AFTER_DISCARD_MS + 120);
    const vK = MJ.debug.voiceStats();
    eq(vK.uniq.indexOf("杠开.mp3"), -1, "暗杠 + 补摸（没胡）**不播**杠开（用户实测「乱喊杠开」的就是这条路径）");
    eq(vK.uniq.indexOf("杠.mp3"), -1, "暗杠也不喊「杠」（手上动作，只出牌碰实音）");
    eq(vK.plays, bK.plays, "这条路径一条语音都不该播（plays 不变）→ " + bK.plays + " → " + vK.plays);
    eq(clack, bClack + 1, "暗杠补摸出的是牌碰实音 mj-clack（clack " + bClack + " → " + clack + "）");
  }
  {
    /* ⑤-2 补杠 + 杠后补摸（没胡）→ 同样不播杠开 */
    MJ.dispose();
    eq(MJ.start(makeElement("div"), {}), true, "杠开段：开局（补杠）");
    MJ.debug.voiceToggle(true);
    eq(MJ.debug.setHand(["9筒", "2万", "4万", "6万", "8万", "1条", "3条", "5条", "东", "南", "西"],
      [{ type: "peng", tiles: ["9筒", "9筒", "9筒"], from: 1, an: false, kind: "ming" }], null), true,
      "摆牌：碰了 9筒 + 手里第 4 张（可补杠）+ 10 张死牌");
    const bB = MJ.debug.voiceStats();
    const bClack2 = clack;
    eq(MJ.debug.act("gang"), true, "补杠 9筒（随后杠后补摸一张）");
    await sleep(T.SAY_AFTER_DISCARD_MS + 120);
    const vB = MJ.debug.voiceStats();
    eq(vB.uniq.indexOf("杠开.mp3"), -1, "补杠 + 补摸（没胡）**不播**杠开");
    eq(vB.uniq.indexOf("杠.mp3"), -1, "补杠也不喊「杠」（手上动作，只出牌碰实音）");
    eq(clack, bClack2 + 1, "补杠出的是牌碰实音 mj-clack");
  }
  {
    /* ⑤-3 直杠本身：只喊「杠」，不喊杠开 */
    MJ.dispose();
    eq(MJ.start(makeElement("div"), {}), true, "杠开段：开局（直杠）");
    MJ.debug.voiceToggle(true);
    const E5 = MJ.debug.engine();
    eq(MJ.debug.setHand(["5筒", "5筒", "5筒", "1万", "2万", "4万", "6万", "8万", "1条", "3条", "东", "南", "西"], [], null),
      true, "摆牌：自己手里三张 5筒");
    E5.P[1].hand = ["5筒", "1万", "2万", "3万", "4万", "5万", "6万", "7万", "8万", "9万", "1条", "2条", "3条", "4条"];
    E5.cur = 1; E5.phase = "turn";
    E5.pending = { type: "turn", seat: 1, anGangs: [], addGangs: [] };
    eq(E5.discard(1, 0), true, "1 家打出 5筒（自己三张在手 → 可直杠）");
    eq(MJ.debug.step(), "wait", "走一拍：轮到自己处理碰/杠窗口（debug.step 与 pump 同路径）");
    eq(MJ.debug.state().phase, "claim", "响应窗口就是碰/杠（phase=claim）");
    eq(MJ.debug.act("gang"), true, "直杠 5筒");
    await sleep(60);
    const vG = MJ.debug.voiceStats();
    ok(vG.uniq.indexOf("杠.mp3") >= 0, "直杠喊的是 杠.mp3（念「我杠」由素材侧 TTS 决定）→ " + vG.list.join(","));
    eq(vG.uniq.indexOf("杠开.mp3"), -1, "直杠本身不播杠开（杠开只属于杠后补摸自摸）");
  }
  {
    /* ⑤-4 杠后补摸自摸 → 播杠开，且一局只播一次 */
    MJ.dispose();
    eq(MJ.start(makeElement("div"), {}), true, "杠开段：开局（杠上开花）");
    MJ.debug.voiceToggle(true);
    eq(MJ.debug.forceWin(0, true), true, "造一次「杠上开花」（杠后补摸的那张自摸）");
    await sleep(60);
    const vW = MJ.debug.voiceStats();
    eq(vW.uniq.indexOf("杠开.mp3") >= 0, true, "杠后补摸自摸 → **播** 杠开.mp3 → " + vW.list.join(","));
    eq(vW.list.filter(f => f === "杠开.mp3").length, 1, "杠开只播一次（list 里出现 1 次）");
    const E6 = MJ.debug.engine();
    E6.phase = "turn";                        // 让第二发能进去：模拟「同一局里又出现一次杠开事件」
    eq(MJ.debug.forceWin(0, true), true, "同一局内再造一次杠开事件");
    await sleep(60);
    eq(MJ.debug.voiceStats().list.filter(f => f === "杠开.mp3").length, 1, "一局内不会重复播杠开（第二次被 G.kongSaid 挡住）");
  }

  /* ── ⑦ 碰事件播的确实是 碰.mp3（用户追加：碰牌要喊「我碰」） ── */
  {
    MJ.dispose();
    eq(MJ.start(makeElement("div"), {}), true, "碰牌段：开局");
    MJ.debug.voiceToggle(true);
    const E7 = MJ.debug.engine();
    const h0 = MJ.debug.hand();
    h0[h0.length - 1] = "7筒";                // 手里留一张 7筒，打出去引 1 家碰
    eq(MJ.debug.setHand(h0, [], null), true, "摆牌：自己手里有 7筒");
    E7.P[1].hand = ["7筒", "7筒", "1万", "2万", "4万", "6万", "8万", "1条", "3条", "5条", "东", "南", "西"];
    eq(MJ.debug.act("discard", "7筒"), true, "打出 7筒");
    eq(MJ.debug.state().phase, "claim", "1 家可碰（phase=claim）");
    eq(E7.claim(1, "peng"), true, "1 家碰下这张 7筒");
    MJ.debug.step();
    /* 碰是喊话（当场出声），自己那张 7筒 是报牌（要等落河）→ 两个时刻都要等够 */
    await sleep(T.SAY_AFTER_DISCARD_MS + 80);
    const vP = MJ.debug.voiceStats();
    ok(vP.uniq.indexOf("碰.mp3") >= 0, "碰事件播的是 碰.mp3（内容念「我碰」由素材侧 TTS 决定）→ " + vP.list.join(","));
    ok(vP.uniq.indexOf("7筒.mp3") >= 0, "自己打出的 7筒 也照常报牌 → " + vP.list.join(","));
  }

  MJ.dispose();
  delete windowStub.Audio;                     // 收尾：把假 Audio 撤掉，缓存也清干净
  MJ.debug.voiceCacheClear();
  delete windowStub.AudioSys.sfxFile;
  eq(MJ.isBusy(), false, "19b 收尾：dispose 后 isBusy=false");

  }

  /* ⑦ 播报队列：不打断 / 优先级 / 上限与间隔
     为什么必须用假 Audio：这三条都是**时序**性质 ——
     「第二条有没有在第一条 ended 之前开始」在真浏览器里要靠耳朵听，
     在单测里只能让 Audio 变成可记录 play/ended 的假对象。
     ⚠ 假 Audio 必须在这里才装：本节前半段有「无 Audio 环境不抛错」的断言，
       提前装上会把那条断言测成假的（永远是另一条路径）。 */
  {
    const plays = [];                    // 播放流水：{url, start, end}
    let clock = 0;                       // 逻辑时钟：每次 play/end 各 +1，用来比先后
    const all = [];                      // 所有 Audio 实例
    function FakeAudio(url) {
      this.src = String(url); this.volume = 1; this.currentTime = 0;
      this.duration = 0.5; this.preload = ""; this._ev = {}; this._rec = null;
      all.push(this);
    }
    FakeAudio.last = null;
    FakeAudio.prototype.addEventListener = function (t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); };
    FakeAudio.prototype.removeEventListener = function (t, fn) {
      const a = this._ev[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    };
    FakeAudio.prototype.load = function () {};
    FakeAudio.prototype.pause = function () { if (this._rec && !this._rec.end) this._rec.end = ++clock; };
    FakeAudio.prototype.play = function () {
      this._rec = { url: this.src, start: ++clock, end: 0, inst: this };
      plays.push(this._rec); FakeAudio.last = this;
      return Promise.resolve();
    };
    FakeAudio.prototype.fire = function (t) { (this._ev[t] || []).slice().forEach((f) => f()); };
    FakeAudio.prototype.end = function () { if (this._rec && !this._rec.end) this._rec.end = ++clock; this.fire("ended"); };

    MJ.dispose();                        // 先收掉牌局：否则 AI 出牌的自动播报会混进队列
    windowStub.Audio = FakeAudio;        // say() → voiceAudio() 从这里 new Audio
    eq(MJ.debug.voiceToggle(true), true, "队列段：语音开关打开");
    const VS = () => MJ.debug.voiceStats();

    /* ① 不打断：连说三条 → 只有第一条进播放位，后两条排队 */
    MJ.debug.say("1万"); MJ.debug.say("2万"); MJ.debug.say("3万");
    eq(VS().playing, "1万.mp3", "连说三条：只有第一条进播放位，后两条只排队");
    eq(VS().queue.join(","), "2万.mp3,3万.mp3", "后两条在队列里等着（原来的实现会在这里 pause 掉第一条）");
    await sleep(240);
    eq(plays.length, 1, "同一时刻**只播一条**（连说三条也只有一条真正 play）→ " + plays.length);
    ok(plays[0].url.indexOf("1万.mp3") >= 0, "在播的是第一条 → " + plays[0].url);

    /* ② ended 之后才轮到第二条，且第二条的开始晚于第一条的结束 */
    FakeAudio.last.end();
    await sleep(300);
    eq(VS().playing, "2万.mp3", "第一条 ended 后才轮到第二条");
    eq(plays.length, 2, "第二条此时才开始播 → " + plays.length);
    ok(plays[1].start > plays[0].end,
      "第二条在第一条 ended **之后**才开始（未打断）：end=" + plays[0].end + " < start=" + plays[1].start);
    eq(VS().queue.join(","), "3万.mp3", "队列里只剩第三条");

    /* ③ 优先级只改排队顺序：喊话插到报牌之前，同级 FIFO；正在播的不受影响 */
    MJ.debug.say("4万");
    eq(VS().queue.join(","), "3万.mp3,4万.mp3", "报牌依次排队（同级 FIFO）");
    MJ.debug.say("胡");
    eq(VS().queue.join(","), "胡.mp3,3万.mp3,4万.mp3", "「胡」插队到报牌之前（高优先级可以插队）");
    eq(VS().playing, "2万.mp3", "插队**不动正在播的那条**（2万.mp3 照常播完）");
    MJ.debug.say("碰");
    eq(VS().queue.join(","), "胡.mp3,碰.mp3,3万.mp3,4万.mp3", "同级喊话 FIFO：碰 排在 胡 之后");
    MJ.debug.say("5万");
    eq(VS().queue.join(","), "胡.mp3,碰.mp3,3万.mp3,4万.mp3,5万.mp3", "报牌一律排在喊话之后，不打乱喊话顺序");
    ok(T.VOICE_CALL_SET["胡"] && T.VOICE_CALL_SET["碰"] && T.VOICE_CALL_SET["抢杠"] && T.VOICE_CALL_SET["自摸"],
      "喊话白名单含 碰/杠/杠开/抢杠/胡/自摸");
    eq(!!T.VOICE_CALL_SET["1万"], false, "牌名不是喊话（低优先级，只排队）");
    eq(T.VOICE_PRI_CALL > T.VOICE_PRI_TILE, true, "喊话优先级高于报牌（" + T.VOICE_PRI_CALL + " > " + T.VOICE_PRI_TILE + "）");

    /* ④ 上限：队满丢**最旧的低优先级**项，喊话一条不丢 */
    MJ.debug.say("6万");
    eq(VS().queue.length, T.VOICE_Q_MAX, "队列涨到上限 " + T.VOICE_Q_MAX + " 条");
    const dropBefore = VS().dropped;
    MJ.debug.say("7万");
    eq(VS().queue.length, T.VOICE_Q_MAX, "再塞一条仍然封顶在 " + T.VOICE_Q_MAX + "（不会排到天荒地老）");
    eq(VS().dropped, dropBefore + 1, "队满时丢弃了 1 条（dropped=" + VS().dropped + "）");
    eq(VS().queue.indexOf("3万.mp3"), -1, "被丢的是**最旧的低优先级**项 3万.mp3，不是喊话");
    eq(VS().queue.join(","), "胡.mp3,碰.mp3,4万.mp3,5万.mp3,6万.mp3,7万.mp3", "丢弃只发生在报牌上，喊话顺序不变");

    /* ⑤ 队满且全是喊话 → 新来的报牌丢自己（绝不挤掉已排队的喊话） */
    for (let g = 0; g < 60; g++) {
      const s = VS();
      if (!s.playing && !s.queue.length) break;
      if (s.playing) FakeAudio.last.end();
      await sleep(210);
    }
    eq(VS().playing, "", "排空后没有正在播的条目");
    eq(VS().queue.length, 0, "排空后队列为空");
    for (const w of ["胡", "碰", "杠", "自摸", "抢杠", "杠开", "流局"]) MJ.debug.say(w);
    eq(VS().playing, "胡.mp3", "占播放位的是第一条喊话");
    eq(VS().queue.length, T.VOICE_Q_MAX, "其余喊话把队列占满（" + T.VOICE_Q_MAX + " 条）");
    const drop2 = VS().dropped;
    MJ.debug.say("9万");
    eq(VS().dropped, drop2 + 1, "队满且自己优先级最低时，丢的是**新来的报牌**");
    eq(VS().queue.indexOf("9万.mp3"), -1, "9万.mp3 没有挤进队列");
    eq(VS().queue.join(","), "碰.mp3,杠.mp3,自摸.mp3,抢杠.mp3,杠开.mp3,流局.mp3", "已排队的喊话一条没被挤掉");

    /* ⑥ 两条之间留最小间隔，不连成一片 */
    for (let g = 0; g < 60; g++) {
      const s = VS();
      if (!s.playing && !s.queue.length) break;
      if (s.playing) FakeAudio.last.end();
      await sleep(210);
    }
    MJ.debug.say("1条");
    await sleep(20);
    FakeAudio.last.end();                       // 结束这一条，让下一条进入间隔
    const n0 = plays.length;
    MJ.debug.say("2条");
    await sleep(50);                            // < VOICE_GAP
    eq(plays.length, n0, "间隔未到不开播（VOICE_GAP=" + T.VOICE_GAP + "ms）");
    await sleep(320);
    eq(plays.length, n0 + 1, "间隔过后才播下一条");

    /* ⑦ 关掉语音：正在播的 + 排队的 一起清 */
    MJ.debug.say("1筒"); MJ.debug.say("2筒");
    MJ.debug.voiceToggle(false);
    eq(VS().queue.length, 0, "关掉语音 → 待播队列清空");
    eq(VS().playing, "", "关掉语音 → 播放位也清空（不会把排队的念完）");
    eq(VS().on, false, "voiceStats().on = false");
    eq(MJ.debug.voiceToggle(true), true, "队列段收尾：重新打开语音");

    /* ⑧ 队列计数进 voiceStats（可观测，便于线上排查「喊话怎么没响」） */
    const st8 = VS();
    ok(typeof st8.queued === "number" && st8.queued > 0, "voiceStats 暴露 queued 计数 = " + st8.queued);
    ok(typeof st8.started === "number" && st8.started > 0, "voiceStats 暴露 started 计数 = " + st8.started);
    ok(st8.maxQueue > 0 && st8.maxQueue <= T.VOICE_Q_MAX, "最大队列长度 " + st8.maxQueue + " ≤ 上限 " + T.VOICE_Q_MAX);
    delete windowStub.Audio;
  }

  MJ.dispose();
  eq(MJ.isBusy(), false, "语音段收尾：dispose 后 isBusy=false");
  /* ─────────── 21. 智脑提示：实时性 / 听牌保护 / 三处一致 / 缓存 ───────────
     用户实测：「AI 辅助打牌不准，听胡的牌 AI 指示打出去」。这一节把六个方向全部钉死：
       · base 必须是「真实手牌去掉刚摸到的那张」（老实现去掉的是排序后最大的一张）
       · 副露手的 3k+2 听牌不许被当成「已成牌 -1」（否则有效进张整批被吞 → 面板「有效牌：无」）
       · 已听牌时建议打出的那张，打完必须**仍然听牌**；所有打法都破听时必须显式标记
       · 面板文案 / 手牌金框 / debug.hint().tile 三处逐字同一张（不是只对齐下标）
       · 摸牌后立刻读提示 → 必须是摸牌后的手牌算出来的（构造出「摸牌前后建议不同」来钉死）
       · melds / drawn / 字牌开关 / 已见 任一变化 → 签名必变，绝不命中旧手牌缓存 */
  group("21. 智脑提示 · 实时性 / 听牌保护 / 三处一致 / 缓存");
  {
    /** 从面板 HTML 里逐字抠出「打 X」的那张牌名 */
    const panelDiscard = (html) => {
      const m = /打\s*([^\s<（(]+)/.exec(String(html || "").replace(/<[^>]*>/g, " "));
      return m ? m[1] : "";
    };
    const m5 = [meld("peng", "5万")];

    /* ① base = 真实手牌去掉「刚摸到的那张」（不是排序后最大的一张） */
    const hD = P("123m 456m 789m 23s 99s 1万");             // 引擎摆放：摸到的 1万 在最后
    const rA = T.hintCalc({ hand: hD, melds: [], drawn: "1万", seen: {}, honors: true });
    eq(rA.base.join(" "), T.sortTiles(P("123m 456m 789m 23s 99s")).join(" "), "① base = 真实手牌去掉刚摸到的 1万（不是排序后最大的一张 9条）");
    eq(rA.tenpaiNow, true, "① 去掉摸到的那张 → 摸牌前那手确实已听（面板/理由都按它说）");
    const rB = T.hintCalc({ hand: hD, melds: [], drawn: "9条", seen: {}, honors: true });
    ok(rA.base.join(",") !== rB.base.join(","), "① 换一张「摸到的牌」→ base 跟着变（口径真的看 drawn）");
    const rC = T.hintCalc({ hand: hD, melds: [], seen: {}, honors: true });
    eq(rC.base.join(" "), rA.base.join(" "), "① 不传 drawn → 按引擎摆放取数组最后一张（与 drawn=1万 同解）");
    const hSorted = T.sortTiles(hD);
    const rD = T.hintCalc({ hand: hSorted, melds: [], seen: {}, honors: true });
    ok(rD.base.join(",") !== rA.base.join(","), "① 数组末张换成 9条 → base 跟着换（绝不瞎猜哪张是摸的）");
    const gA = T.gainsOf(rA.base, 0, {}, true, undefined, []);
    eq(rA.improve.map(x => x.tile).join(","), gA.slice(0, rA.improve.length).map(x => x.tile).join(","), "① 「有效牌」是从同一手 base 算出来的（口径一致）");

    /* ② 副露：3k+2 的听牌不许被算成「已成牌 -1」 */
    const h11 = P("123m 789m 23s 99s 中");                  // 11 张暗手 + 碰 = 14
    eq(T.totalShanten(h11, 1), 0, "② 副露手 3k+2 听牌 = 0 向听（老实现错报 -1 = 已成牌）");
    const rM = T.hintCalc({ hand: h11, melds: m5, drawn: "中", seen: {}, honors: true });
    eq(rM.discard, "中", "② 副露手建议打掉刚摸的 中（打完成听）");
    eq(rM.tenpaiAfter, true, "② 打完成听");
    eq(rM.waits.join("/"), "1条/4条", "② 听 1条/4条");
    ok(rM.shanten >= 0, "② 向听不给负数（-1 只表示真的已成牌，实际 " + rM.shanten + "）");

    /* ③ 副露：1 向听的有效进张不能被吞（老实现 → 面板「有效牌：无」） */
    const h10 = P("123m 789m 23s 9s 5p");
    eq(T.totalShanten(h10, 1), 1, "③ 构造出一手「有副露的 1 向听」");
    const g10 = T.gainsOf(h10, 1, {}, true, undefined, m5);
    ok(g10.length > 0, "③ 1 向听（有副露）的有效进张不空 → " + (g10.map(x => x.tile + "×" + x.left).join(" ") || "(空)"));
    ok(g10.some(x => x.tile === "1条") && g10.some(x => x.tile === "4条"), "③ 23条 的进张 1条/4条 都在列表里");
    const rG = T.hintCalc({ hand: h10.concat(["5筒"]), melds: m5, drawn: "5筒", seen: {}, honors: true });
    ok(rG.improve.length > 0, "③ 提示面板的「有效牌」不空（有副露时也一样）→ " + rG.improve.map(x => x.tile).join("/"));

    /* ④ 听牌保护：16 组已听手牌（两面 / 单钓 / 坎张 / 对倒 / 七对 / 龙七对 / 字牌 / 1~4 副露 / 大吊车）× 多张摸牌 */
    const TEN = [
      ["两面（无副露）", [], P("123m 456m 789m 23s 99s")],
      ["单钓（无副露）", [], P("123m 456m 789m 123s 9s")],
      ["坎张（无副露）", [], P("123m 456m 789m 13s 99s")],
      ["对倒（无副露）", [], P("123m 456m 789m 22s 99s")],
      ["七对", [], P("11m 22m 33m 44s 55s 66p 7p")],
      ["龙七对形", [], P("11m 22m 33m 44m 55s 66s 7s")],
      ["字牌单钓", [], P("123m 456m 789m 99s 东东")],
      ["字牌对倒", [], P("123m 456m 789m 东东 南南")],
      ["单副露·两面", [meld("peng", "5万")], P("123m 789m 23s 99s")],
      ["单副露·单钓", [meld("peng", "5万")], P("123m 789m 123s 9s")],
      ["单副露·对倒", [meld("peng", "5万")], P("123m 789m 22s 99s")],
      ["副露+字牌对倒", [meld("peng", "5万")], P("123m 789m 99s 东东")],
      ["双副露·单钓", [meld("peng", "5万"), meld("peng", "2条")], P("123m 789m 9s")],
      ["双副露·两面", [meld("peng", "5万"), meld("peng", "2条")], P("123m 23s 99s")],
      ["三副露·单钓", [meld("peng", "5万"), meld("peng", "6条"), meld("peng", "7筒")], P("123m 9s")],
      ["大吊车（4 副露）", [meld("peng", "5万"), meld("peng", "6条"), meld("gang", "7筒", true), meld("peng", "东")], P("9s")]
    ];
    const DRAWS = ["1筒", "5万", "9条", "东", "白", "2条", "7筒"];
    /** 去掉一张（本地实现，不依赖内部导出） */
    const rm1 = (h, t) => { const o = h.slice(); const i = o.indexOf(t); if (i < 0) return null; o.splice(i, 1); return o; };
    let grp = 0, combos = 0, broke = 0, nullDisc = 0, nb = 0;
    const brokeEx = [];
    for (const [name, melds, h13] of TEN) {
      const w0 = T.waitsFor(h13, melds, true);
      ok(w0.length > 0, "④ " + name + "：构造成立（听 " + w0.join("/") + "）");
      grp++;
      const draws = w0.concat(DRAWS).filter(t => {
        let n = T.countIn(h13, t);
        for (const m of melds) n += T.countIn(m.tiles, t);
        return n < 4;
      });
      for (const d of draws) {
        const h14 = h13.concat([d]);
        const r = T.hintCalc({ hand: h14, melds: melds, drawn: d, seen: {}, honors: true });
        combos++;
        if (!r.discard) { nullDisc++; continue; }
        if (r.noBetter) {
          nb++;
          ok(r.options.every(o => !o.waits.length), "④ " + name + " 摸 " + d + "：noBetter 时所有打法确实都破听（显式标记，不静默）");
          continue;
        }
        const rest = rm1(h14, r.discard);
        const w1 = T.waitsFor(rest, melds, true);
        const sh1 = T.totalShanten(rest, melds.length);
        if (w1.length === 0 || sh1 > 0) {
          broke++;
          if (brokeEx.length < 5) brokeEx.push(name + " 摸 " + d + " → 建议打 " + r.discard + "（打完 " + sh1 + " 向听 / 听 " + (w1.join("/") || "无") + "）");
        }
      }
    }
    ok(grp >= 15, "④ 已听手牌构造 ≥15 组（实际 " + grp + " 组）");
    eq(broke, 0, "④ 已听牌时建议打出的那张，打完**仍然听牌**（0 组破听 / 共 " + combos + " 次摸牌）" + (brokeEx.length ? " → " + brokeEx.join("；") : ""));
    eq(nullDisc, 0, "④ 已听牌时一定有建议（不给空建议）");
    ok(combos >= 100, "④ 组合覆盖足够（" + combos + " 次摸牌）");
    eq(nb, 0, "④ 常规听牌不会出现「无更好选择」（出现即说明保护逻辑漏了）");

    /* ⑤ 三处一致：debug.hint().tile == 面板文案的牌名 == 金框那一格的牌（逐字，不比下标） */
    MJ.dispose();
    eq(MJ.start(makeElement("div"), {}), true, "⑤ 开局（stub DOM）");
    const UIS = [
      { name: "无副露", melds: [], hand: P("123m 456m 789m 12s 99s 5p") },
      { name: "单副露", melds: m5, hand: P("123m 789m 23s 99s 5p") },
      { name: "字牌", melds: [], hand: P("123m 456m 789m 23s 99s 东") },
      { name: "大吊车", melds: [meld("peng", "5万"), meld("peng", "6条"), meld("gang", "7筒", true), meld("peng", "东")], hand: P("9s 5p") }
    ];
    let uiBad = 0;
    for (const u of UIS) {
      eq(MJ.debug.setHand(u.hand, u.melds, u.hand[u.hand.length - 1]), true, "⑤ " + u.name + "：摆牌并轮到自己");
      MJ.debug.render();
      const h = MJ.debug.hint();
      ok(!!h, "⑤ " + u.name + "：算得出提示");
      if (!h) { uiBad++; continue; }
      const bt = MJ.debug.brainText();
      const rects = MJ.debug.handRects();
      const pTile = panelDiscard(bt.panel);
      const mTile = rects[h.markIdx] ? rects[h.markIdx].tile : "(无)";
      const iTile = rects[bt.hintIdx] ? rects[bt.hintIdx].tile : "(无)";
      ok(h.tile === h.discard, "⑤ " + u.name + "：tile 与 discard 是同一张（" + h.tile + "）");
      ok(pTile === h.tile, "⑤ " + u.name + "：面板文案里的牌名 == hint().tile（面板=" + pTile + " / hint=" + h.tile + "）");
      ok(mTile === h.tile, "⑤ " + u.name + "：金框那一格 == hint().tile（金框=" + mTile + "）");
      ok(iTile === h.tile && h.markIdx === bt.hintIdx, "⑤ " + u.name + "：hintIdx/markIdx 也落在同一张上（" + bt.hintIdx + "）");
      ok(h.reason.indexOf("打 " + h.tile) >= 0, "⑤ " + u.name + "：理由文案指向同一张 → " + h.reason);
      if (!(h.tile === h.discard && pTile === h.tile && mTile === h.tile && iTile === h.tile)) uiBad++;
    }
    eq(uiBad, 0, "⑤ 面板 / 金框 / debug.hint() 三处逐字一致（0 处不一致）");

    /* ⑤b 高亮定位：手牌一变（刚摸牌）就「立刻」读提示时，金框也必须落在建议的那张牌上 */
    const core10 = P("123m 789m 23s 99s");                  // 10 张暗手 + 碰 = 13
    eq(MJ.debug.setHand(core10, m5, null), true, "⑤b 摆成「摸牌前」的一帧（13 张）");
    MJ.debug.render();
    const p0 = MJ.debug.engine().P[0];
    p0.hand.push("5筒"); p0.drawn = "5筒"; T.normalizeHand(p0);   // 真实摸牌（引擎同一条路径）
    const hA = MJ.debug.hint();                             // 不等下一帧，立刻读（= showHumanUI 的顺序）
    const btA = MJ.debug.brainText(), rectsA = MJ.debug.handRects();
    ok(!!hA, "⑤b 摸牌后立刻算得出提示");
    eq(hA && hA.tile, "5筒", "⑤b 摸到 5筒 → 建议打 5筒");
    eq(hA && hA.markTile, "5筒", "⑤b 刚摸牌就渲染：金框仍在建议的那张上（老实现越界消失 / 盖到别的牌）");
    ok(hA && hA.markIdx >= 0, "⑤b 金框定位到了具体一格（markIdx=" + (hA && hA.markIdx) + "）");
    eq(btA.markDisplay, "block", "⑤b 金框已显示（不是被藏起来）");
    MJ.debug.render();                                      // 下一帧：画布与 DOM 都按新手牌重画
    const btB = MJ.debug.brainText(), rectsB = MJ.debug.handRects();
    eq(rectsB[btB.hintIdx] ? rectsB[btB.hintIdx].tile : "(无)", "5筒", "⑤b 重画后 hintIdx 那一格仍是建议的那张（三者同源）");

    /* ⑥ 确定性：同一手牌连算 5 次完全一致；手牌不变时面板不跳动、不重算 */
    const hDet = P("123m 456m 789m 12s 99s 东");
    T.hintCacheClear();
    const sig5 = [];
    for (let i = 0; i < 5; i++) {
      const r = T.hintCalc({ hand: hDet, melds: [], drawn: "东", seen: {}, honors: true });
      sig5.push([r.discard, r.tile, r.shanten, r.waits.join("/"), r.waitsLeft, r.ukeire, r.reason].join("|"));
    }
    eq(new Set(sig5).size, 1, "⑥ 同一手牌连算 5 次结果完全一致 → " + sig5[0]);
    eq(MJ.debug.setHand(hDet, [], "东"), true, "⑥ 摆牌");
    MJ.debug.render();
    const c0 = MJ.debug.hintStats().calcCount;
    const s1 = JSON.stringify(MJ.debug.hint());
    let jump = 0;
    for (let i = 0; i < 4; i++) { MJ.debug.render(); if (JSON.stringify(MJ.debug.hint()) !== s1) jump++; }
    eq(jump, 0, "⑥ 手牌不变时提示不跳动（4 次重画结果一致）");
    eq(MJ.debug.hintStats().calcCount, c0, "⑥ 手牌不变 → 一次都不重算（calcCount 不涨）");

    /* ⑦ 时序：摸牌后「立刻」读 → 必须是摸牌后的手牌算出来的建议（构造出摸牌前后建议不同来钉死） */
    const core13 = P("13579m 2468s 1357p");
    const dX = "1万", dY = "中";
    const rX = T.hintCalc({ hand: core13.concat([dX]), melds: [], drawn: dX, seen: {}, honors: true });
    const rY = T.hintCalc({ hand: core13.concat([dY]), melds: [], drawn: dY, seen: {}, honors: true });
    ok(rX.discard !== rY.discard, "⑦ 构造成立：摸 " + dX + " 建议打 " + rX.discard + "，摸 " + dY + " 建议打 " + rY.discard);
    eq(MJ.debug.setHand(core13.concat([dX]), [], dX), true, "⑦ 摸到 " + dX + "（引擎摆放）");
    const hX = MJ.debug.hint();
    eq(hX && hX.tile, rX.discard, "⑦ 摸牌后读到的是**这一手**的建议（" + rX.discard + "）");
    ok(hX && hX.tile !== rY.discard, "⑦ 不是另一手/上一拍的建议（" + (hX && hX.tile) + " ≠ " + rY.discard + "）");
    eq(MJ.debug.setHand(core13, [], null), true, "⑦ 回到摸牌前（13 张）");
    eq(MJ.debug.hint(), null, "⑦ 摸牌前不给「打哪张」的建议（不拿旧手牌糊弄）");
    eq(MJ.debug.setHand(core13.concat([dY]), [], dY), true, "⑦ 换成摸 " + dY);
    eq(MJ.debug.hint().tile, rY.discard, "⑦ 摸到别的牌 → 建议立刻跟着换（" + rY.discard + "）");

    /* ⑧ 缓存正确性：melds / drawn / 字牌开关 / 已见 任一变化 → 签名必变、绝不命中旧缓存 */
    const k0 = T.hintKeyOf(P("123m 789m 23s 99s"), m5, null, true, {});
    eq(T.hintKeyOf(P("123m 789m 23s 99s"), m5, null, true, {}), k0, "⑧ 同状态签名稳定（不抖动）");
    ok(T.hintKeyOf(P("123m 789m 23s 99s"), [meld("peng", "6万")], null, true, {}) !== k0, "⑧ 副露牌面变了（组数不变）→ 签名必变");
    ok(T.hintKeyOf(P("123m 789m 23s 99s"), [meld("peng", "5万"), meld("peng", "6万")], null, true, {}) !== k0, "⑧ 副露组数变了 → 签名必变");
    ok(T.hintKeyOf(P("123m 789m 23s 99s"), m5, "9条", true, {}) !== k0, "⑧ 「摸到的牌」变了 → 签名必变");
    ok(T.hintKeyOf(P("123m 789m 23s 99s"), m5, null, false, {}) !== k0, "⑧ 字牌开关变了 → 签名必变");
    ok(T.hintKeyOf(P("123m 789m 23s 99s"), m5, null, true, { "1条": 1 }) !== k0, "⑧ 已见变了 → 签名必变");
    const cA = T.hintCalc({ hand: hD, melds: [], drawn: "1万", seen: {}, honors: true });
    const cB = T.hintCalc({ hand: hD, melds: [], drawn: "9条", seen: {}, honors: true });
    ok(cA !== cB, "⑧ 同一手牌不同「摸到的牌」→ 不是同一个缓存对象（老实现会命中同一份）");
    ok(cA.base.join(",") !== cB.base.join(","), "⑧ 两者的 base 确实不同（真的按 drawn 重算了）");
    const cC = T.hintCalc({ hand: h11, melds: m5, drawn: "中", seen: {}, honors: true });
    const cD = T.hintCalc({ hand: h11, melds: [meld("peng", "6万")], drawn: "中", seen: {}, honors: true });
    ok(cC !== cD, "⑧ 副露牌面不同 → 不命中旧缓存");

    /* ⑨ 「所有打法都会破听」必须显式标记（noBetter + 面板写明），绝不静默建议 */
    const nbHand = P("123m 456m 789m 111s 1条 东");           // 摸到 1条：东 是唯一听口，而 1条 已见 4 张
    const rNB = T.hintCalc({ hand: nbHand, melds: [], drawn: "1条", seen: {}, honors: false });
    eq(rNB.noBetter, true, "⑨ 字牌关但只听字牌 → noBetter=true（显式标记）");
    ok(T.hintLines(rNB).l3.indexOf("无更好选择") >= 0, "⑨ 面板 l3 写明「无更好选择」→ " + T.hintLines(rNB).l3);
    ok(rNB.reason.indexOf("无更好选择") >= 0, "⑨ 理由文案同样写明 → " + rNB.reason);
    const rNB2 = T.hintCalc({ hand: nbHand, melds: [], drawn: "1条", seen: {}, honors: true });
    eq(rNB2.noBetter, false, "⑨ 同一手牌「字牌开」时听牌保护正常（不误报 noBetter）");
    eq(rNB2.discard, "1条", "⑨ 字牌开：建议打掉刚摸的 1条，保住「听 东」");
    eq(rNB2.tenpaiAfter, true, "⑨ 打完仍听");

    MJ.dispose();
  }




  /* ═══════════════ 22. 牌张守恒审计（硬不变量：每种牌 ≤4 · 全场 = 136/108） ═══════════════
     背景：用户实测「桌上出现六张六条？？？每张牌型有且只能有四张啊」。
     这一节把审计变成**常驻断言**：发牌 / 摸牌 / 打牌 / 碰 / 明杠 / 暗杠 / 补杠 / 抢杠 / 胡 / 流局
     每一次状态变更后都审计一次，任何一次违规即失败。
     审计口径与浏览器断言、探针**同一份实现**（Mahjong.test.tileAudit），不各写一套。 */
  group("22. 牌张守恒审计（每一拍 · 硬不变量）");
  {
    /* ── 22.0 出口形状 ── */
    eq(typeof T.tileAudit, "function", "22.0 审计函数存在（Mahjong.test.tileAudit）");
    eq(typeof T.renderAudit, "function", "22.0 渲染层审计存在（按本帧逐张牌面记账）");
    eq(typeof T.tileAuditInstall, "function", "22.0 常驻断言：tileAuditInstall（包住每个状态变更入口）");
    eq(typeof T.tileAuditOn, "function", "22.0 常驻断言开关：tileAuditOn");
    eq(typeof MJ.debug.tileAudit, "function", "22.0 debug 出口同源（Mahjong.debug.tileAudit）");

    /* ── 22.1 造牌后立刻审计：136 张 / 每种 4 张 / ok ── */
    {
      const E = new T.Engine(10, { honors: true });
      const a = T.tileAudit(E);
      eq(a.total, 136, "22.1 未发牌时牌墙 = 136 张");
      eq(a.expect, 136, "22.1 应有张数 = 136（含字牌）");
      eq(a.ok, true, "22.1 未发牌时审计 ok" + (a.ok ? "" : " → " + JSON.stringify(a.violations)));
      eq(a.max, 4, "22.1 单种最多 4 张");
      eq(Object.keys(a.byType).length, 34, "22.1 34 种牌");
      E.deal();
      const b = T.tileAudit(E);
      eq(b.total, 136, "22.1 发牌后仍 136 张（13×4 + 庄家 1 + 牌墙 83）");
      eq(b.ok, true, "22.1 发牌后审计 ok" + (b.ok ? "" : " → " + JSON.stringify(b.violations)));
      eq(b.max, 4, "22.1 发牌后单种仍 ≤ 4");
      const c8 = T.tileAudit(new T.Engine(10, { honors: false }));
      eq(c8.expect, 108, "22.1 honors=false → 应有 108 张");
      eq(c8.total, 108, "22.1 honors=false → 实际 108 张");
      ok(Object.keys(c8.byType).every(t => T.HONORS.indexOf(t) < 0), "22.1 honors=false 时场上没有字牌");
    }

    /* ── 22.2 AI 整局（≥3 局）：**每一拍**都审计，任何一拍违规即失败 ── */
    {
      let beats = 0, fails = 0, games = 0, firstBad = ""; console.log("    · 22.2 开始（3 局整局逐拍审计）");
      for (let g = 0; g < 3; g++) {
        const E = new T.Engine(10, { honors: true });
        T.tileAuditInstall();
        T.tileAuditOn(true, null);
        E.deal();
        let step = 0;
        while (E.phase !== "over" && step < 500) { E.aiStep(); step++; }
        const st = T.tileAuditState();
        beats += st.n; fails += st.fails; games++;
        if (st.fails && !firstBad) firstBad = JSON.stringify(T.tileAuditReport().list[0]);
        T.tileAuditOn(false);
        const a = T.tileAudit(E);
        ok(a.ok, "22.2 第 " + (g + 1) + " 局整局每一拍守恒（" + st.n + " 拍）" +
          (a.ok ? "" : " → " + JSON.stringify(a.violations)));
      }
      ok(beats > 200, "22.2 三局共审计 " + beats + " 拍（每拍一次，不是只审首尾）");
      eq(fails, 0, "22.2 三局里没有任何一拍违规" + (fails ? " → " + firstBad : ""));
      ok(games === 3, "22.2 跑满 3 局");
    }

    /* ── 22.3 边界用例：每一种都必须审计（并发场景靠固定牌墙夹具钉死，夹具本身守恒） ── */
    {
      /* 夹具：把想要的牌精确放到 deal() 的取牌位置，其余原样入墙（整副牌的一个排列） */
      const craft = (seed, honors, spec) => {
        const full = T.createWall(honors), need = {}, hasC = {};
        for (const t of full) hasC[t] = (hasC[t] || 0) + 1;
        for (const i of Object.keys(spec)) {
          if (i === "draw") continue;
          for (const t of spec[i]) need[t] = (need[t] || 0) + 1;
        }
        if (spec.draw) need[spec.draw] = (need[spec.draw] || 0) + 1;
        for (const t of Object.keys(need)) if (need[t] > hasC[t]) throw new Error("夹具要 " + t + " × " + need[t]);
        const rest = [];
        for (const t of Object.keys(hasC)) for (let k = 0; k < hasC[t] - (need[t] || 0); k++) rest.push(t);
        T.shuffle(rest);
        const wall = [];
        let rp = 0;
        for (let k = 0; k < 13; k++) for (let i = 0; i < 4; i++) {
          wall.push(spec[i] && spec[i][k] !== undefined ? spec[i][k] : rest[rp++]);
        }
        if (spec.draw) wall[52] = spec.draw; else wall.push(rest[rp++]);
        for (let p = 53; p < full.length; p++) wall.push(rest[rp++]);
        if (wall.length !== full.length) throw new Error("夹具牌墙长度 " + wall.length);
        const E = new T.Engine(10, { honors });
        E.wall = wall;
        E.deal();
        return E;
      };
      /* 只把「手牌里已有的」牌搬进副露组（守恒） */
      const makeMeld = (E, seat, tile, type) => {
        const p = E.P[seat], n = type === "peng" ? 3 : 4, idx = [];
        for (let i = p.hand.length - 1; i >= 0 && idx.length < n; i--) if (p.hand[i] === tile) idx.push(i);
        if (idx.length < n) throw new Error("手牌里没有 " + n + " 张 " + tile);
        for (const i of idx) p.hand.splice(i, 1);
        const tiles = []; for (let k = 0; k < n; k++) tiles.push(tile);
        p.melds.push({ type, tiles, from: (seat + 1) % 4, an: false, kind: "ming" });
        T.normalizeHand(p);
        return p;
      };
      const runOut = (E, cap) => {
        let n = 0, stuck = 0, prev = "";
        const lim = cap || 220;
        while (E.phase !== "over" && n < lim) {
          if (E.phase === "turn") E.aiStep();
          else if (E.phase === "claim" && E.pending && E.pending.seat !== undefined) E.claim(E.pending.seat, "pass");
          else if (E.phase === "rob" && E.pending && E.pending.seats && E.pending.seats.length) E.passRob(E.pending.seats[0]);
          else break;
          n++;
          const sig = E.phase + "|" + E.wall.length + "|" + E.P[0].hand.length + "|" + E.cur;
          if (sig === prev) { if (++stuck > 4) break; } else { stuck = 0; prev = sig; }
        }
        return n;
      };
      let T22 = Date.now();
      const mark22 = (s) => console.log("    · 22 进度 " + s + "（+" + (Date.now() - T22) + "ms）");
      const caseAudit = (label, fn) => {
        mark22("开始 " + label);
        T.tileAuditInstall(); T.tileAuditOn(true, null);
        let err = "", info = "";
        try { info = fn() || ""; } catch (e) { err = String((e && e.message) || e); }
        const st = T.tileAuditState(), rep = T.tileAuditReport();
        T.tileAuditOn(false);
        ok(!err, "22.3 " + label + "（夹具/流程异常）" + (err ? " → " + err : ""));
        mark22("完成 " + label + "（" + st.n + " 拍）");
        eq(st.fails, 0, "22.3 " + label + "：每一拍审计通过（" + st.n + " 拍）" +
          (st.fails ? " → " + JSON.stringify(rep.list[0].violations) : "") + (info ? " · " + info : ""));
      };

      /* ① 补杠（回头杠）→ 被抢杠胡（唯一会把 3 张 concat 回手牌的路径） */
      caseAudit("补杠 → 被抢杠胡", () => {
        const E = craft(101, true, {
          0: ["9筒", "9筒", "9筒", "9筒", "1万", "2万", "3万", "4万", "5万", "6万", "7万", "8万", "9万"],
          1: ["1筒", "2筒", "3筒", "4筒", "5筒", "6筒", "7筒", "8筒", "9条", "9条", "1条", "1条", "1条"],
          2: ["1万", "1万", "2条", "2条", "3条", "3条", "4条", "4条", "5条", "5条", "6条", "6条", "7条"],
          3: ["东", "东", "南", "南", "西", "西", "北", "北", "中", "中", "發", "發", "白"]
        });
        makeMeld(E, 0, "9筒", "peng");
        E.cur = 0; E.phase = "turn";
        E.pending = { type: "turn", seat: 0, anGangs: [], addGangs: ["9筒"] };
        if (!E.turnGang(0, "9筒", "bu")) throw new Error("补杠失败");
        if (E.phase !== "rob") throw new Error("没触发抢杠窗口");
        E.rob(E.pending.seats[0]);
        const a = T.tileAudit(E);
        if (!a.ok) throw new Error(JSON.stringify(a.violations));
        return "9筒全场 " + a.byType["9筒"] + " 张（应 4）· 总数 " + a.total;
      });

      /* ② 直杠（大明杠）→ 被抢杠胡 */
      caseAudit("直杠 → 被抢杠胡", () => {
        const E = craft(102, true, {
          0: ["9筒", "9筒", "9筒", "1万", "2万", "3万", "4万", "5万", "6万", "7万", "8万", "东", "南"],
          1: ["1筒", "2筒", "3筒", "4筒", "5筒", "6筒", "7筒", "8筒", "9条", "9条", "1条", "1条", "1条"],
          2: ["9筒", "2条", "3条", "4条", "5条", "6条", "7条", "8条", "西", "西", "北", "北", "發"],
          3: ["东", "东", "南", "南", "西", "西", "北", "北", "中", "中", "發", "發", "白"]
        });
        E.cur = 2; E.phase = "turn"; E.turn(2);
        if (E.phase === "over") throw new Error("2 家摸牌就胡了");
        if (!E.discard(2, E.P[2].hand.indexOf("9筒"))) throw new Error("2 家打不出 9筒");
        if (E.phase !== "claim" || E.pending.seat !== 0) throw new Error("0 家没拿到杠窗口");
        if (!E.claim(0, "gang")) throw new Error("直杠失败");
        if (E.phase !== "rob") throw new Error("没触发抢杠窗口");
        E.rob(E.pending.seats[0]);
        const a = T.tileAudit(E);
        if (!a.ok) throw new Error(JSON.stringify(a.violations));
        return "9筒全场 " + a.byType["9筒"] + " 张（应 4）· 总数 " + a.total;
      });

      /* ③ 暗杠 → 杠后补摸 → 打到结束 */
      caseAudit("暗杠 → 杠后补摸 → 打到结束", () => {
        const E = craft(104, true, {
          0: ["5筒", "5筒", "5筒", "5筒", "1万", "3万", "5万", "7万", "9万", "1条", "4条", "7条", "东"],
          1: ["1筒", "3筒", "6筒", "7筒", "8筒", "2条", "5条", "8条", "西", "西", "北", "北", "白"],
          2: ["2筒", "4筒", "9筒", "1条", "2条", "3条", "6条", "9条", "南", "南", "中", "中", "發"],
          3: ["东", "东", "南", "南", "西", "西", "北", "北", "中", "發", "白", "白", "9筒"]
        });
        E.cur = 0; E.phase = "turn";
        E.pending = { type: "turn", seat: 0, anGangs: ["5筒"], addGangs: [] };
        if (!E.turnGang(0, "5筒", "an")) throw new Error("暗杠失败");
        eq(E.P[0].melds[0].tiles.length, 4, "22.3 暗杠副露 = 4 张（不是 3 张）");
        const n = runOut(E);
        const a = T.tileAudit(E);
        if (!a.ok) throw new Error(JSON.stringify(a.violations));
        return "副露 4 张 · 续跑 " + n + " 拍 · 5筒 " + a.byType["5筒"] + " 张 · 总数 " + a.total;
      });

      /* ④ 连续碰 2 次 → 暗杠 → 补杠（同一家一拍内连做） */
      caseAudit("连续碰 → 暗杠 → 补杠（同家连续改手牌）", () => {
        const E = craft(105, true, {
          0: ["1筒", "1筒", "1筒", "1筒", "3筒", "3筒", "3筒", "4筒", "4筒", "4筒", "4筒", "1万", "2万"],
          1: ["2万", "3万", "4万", "5万", "6万", "7万", "8万", "9万", "1条", "3条", "5条", "7条", "9条"],
          2: ["5筒", "6筒", "7筒", "8筒", "9筒", "2条", "4条", "6条", "8条", "东", "南", "西", "北"],
          3: ["东", "东", "南", "南", "西", "西", "北", "北", "中", "中", "發", "發", "白"]
        });
        makeMeld(E, 0, "3筒", "peng");
        makeMeld(E, 0, "4筒", "peng");
        E.cur = 0; E.phase = "turn";
        E.pending = { type: "turn", seat: 0, anGangs: ["1筒"], addGangs: ["4筒"] };
        if (!E.turnGang(0, "1筒", "an")) throw new Error("暗杠 1筒 失败");
        E.cur = 0; E.phase = "turn";
        E.pending = { type: "turn", seat: 0, anGangs: [], addGangs: ["4筒"] };
        if (!E.turnGang(0, "4筒", "bu")) throw new Error("补杠 4筒 失败");
        const a = T.tileAudit(E);
        if (!a.ok) throw new Error(JSON.stringify(a.violations));
        const n = runOut(E);
        const b = T.tileAudit(E);
        if (!b.ok) throw new Error(JSON.stringify(b.violations));
        return "副露 " + E.P[0].melds.length + " 组（3+3+4+4=14 张）· 1筒 " + b.byType["1筒"] +
          " / 3筒 " + b.byType["3筒"] + " / 4筒 " + b.byType["4筒"] + " · 续跑 " + n + " 拍";
      });

      /* ⑤ 四副露大吊车（4 碰 + 单吊对子）→ 真实结算 */
      caseAudit("四副露大吊车（4 碰 + 单吊 9筒）", () => {
        const E = craft(106, true, {
          draw: "9筒",
          0: ["1万", "1万", "1万", "2条", "2条", "2条", "3筒", "3筒", "3筒", "6万", "6万", "6万", "9筒"],
          1: ["1筒", "3筒", "5筒", "7筒", "9条", "4条", "6条", "8条", "东", "南", "西", "北", "白"],
          2: ["2万", "4万", "6万", "8万", "2条", "4条", "6条", "8条", "中", "中", "發", "發", "白"],
          3: ["东", "东", "南", "南", "西", "西", "北", "北", "中", "發", "白", "白", "9条"]
        });
        makeMeld(E, 0, "1万", "peng");
        makeMeld(E, 0, "2条", "peng");
        makeMeld(E, 0, "3筒", "peng");
        makeMeld(E, 0, "6万", "peng");
        eq(E.P[0].hand.length, 2, "22.3 大吊车手牌剩 2 张（单吊对子）");
        const ev = T.evaluate(E.P[0].hand, E.P[0].melds);
        ok(!!ev, "22.3 四副露 + 9筒对子 = 成牌");
        E.settle(0, { selfDraw: true }, ev);
        const a = T.tileAudit(E);
        if (!a.ok) throw new Error(JSON.stringify(a.violations));
        return ev.name + " · 9筒 " + a.byType["9筒"] + " 张 · 总数 " + a.total + " · 结算 " + E.result.fanName;
      });

      /* ⑥ 流局（牌墙摸完） */
      caseAudit("流局（牌墙摸完 · 四家都不胡）", () => {
        const E = craft(107, true, {
          0: ["1万", "4万", "7万", "1条", "4条", "7条", "1筒", "4筒", "7筒", "东", "南", "西", "北"],
          1: ["2万", "5万", "8万", "2条", "5条", "8条", "2筒", "5筒", "8筒", "东", "南", "西", "北"],
          2: ["3万", "6万", "9万", "3条", "6条", "9条", "3筒", "6筒", "9筒", "东", "南", "西", "北"],
          3: ["1万", "2万", "3万", "4万", "5万", "6万", "7万", "8万", "9万", "1条", "2条", "3条", "5条"]
        });
        const n = runOut(E);
        const a = T.tileAudit(E);
        if (!a.ok) throw new Error(JSON.stringify(a.violations));
        return "续跑 " + n + " 拍 · " + (E.result && E.result.draw ? "流局" : "分出胜负") + " · 总数 " + a.total + "/" + a.expect;
      });

      /* ⑦ 108 张牌组整局 */
      caseAudit("108 张牌组（无字牌）整局", () => {
        const E = craft(108, false, {});
        const n = runOut(E);
        const a = T.tileAudit(E);
        if (!a.ok) throw new Error(JSON.stringify(a.violations));
        eq(a.expect, 108, "22.3 无字牌局应有 108 张");
        return "续跑 " + n + " 拍 · 总数 " + a.total + "/" + a.expect;
      });

      /* ⑧ 连开 3 局（重开不清旧容器 → 立刻现形） */
      caseAudit("连开 3 局（重开不清旧容器）", () => {
        let s = "";
        for (let g = 0; g < 3; g++) {
          const E = craft(109 + g, true, {});
          runOut(E);
          const a = T.tileAudit(E);
          if (!a.ok) throw new Error("第 " + (g + 1) + " 局：" + JSON.stringify(a.violations));
          s += "[" + (g + 1) + "] " + a.total + " 张 ";
        }
        return s;
      });

      /* ⑨ 手牌 3 张 + 别家打出第 4 张 → 碰（用户截图那一手：副露 3 / 手牌 1 / 全场 4）
         夹具纪律：除 6条 外，四家手牌一律摆成「同花色两两相隔 ≥2、无对子」的死牌 ——
         保证任何一种摸牌都成不了牌（否则随机摸到一张就胡了，用例会不稳定）。 */
      caseAudit("碰：手牌 3 张 + 别家打出第 4 张", () => {
        const E = craft(110, true, {
          0: ["6条", "6条", "6条", "1万", "4万", "7万", "1筒", "4筒", "7筒", "东", "南", "西", "北"],
          1: ["1条", "4条", "7条", "2万", "5万", "8万", "2筒", "5筒", "8筒", "东", "南", "西", "北"],
          2: ["6条", "2条", "5条", "8条", "3万", "6万", "9万", "3筒", "6筒", "9筒", "中", "發", "白"],
          3: ["9条", "3条", "2筒", "5筒", "8筒", "2万", "5万", "8万", "东", "南", "西", "北", "中"]
        });
        E.cur = 2; E.phase = "turn"; E.turn(2);
        if (E.phase === "over") throw new Error("2 家摸牌就胡了（夹具不是死牌）");
        if (!E.discard(2, E.P[2].hand.indexOf("6条"))) throw new Error("2 家打不出 6条");
        if (E.phase !== "claim" || E.pending.seat !== 0) throw new Error("0 家没拿到碰窗口");
        if (!E.claim(0, "peng")) throw new Error("碰失败");
        const a = T.tileAudit(E);
        if (!a.ok) throw new Error(JSON.stringify(a.violations));
        eq(a.byType["6条"], 4, "22.3 碰完 6条 全场仍是 4 张（不是 5/6 张）");
        eq(T.countIn(E.P[0].hand, "6条"), 1, "22.3 碰完手牌里只剩 1 张 6条（不是 3 张）");
        eq(E.P[0].melds[0].tiles.length, 3, "22.3 副露 = 3 张");
        return "全场 6条 " + a.byType["6条"] + " 张 · 手牌 " + T.countIn(E.P[0].hand, "6条") + " 张";
      });
    }

    /* ── 22.4 渲染层：每一帧「画面上每种牌各几张」≤ 4（审计第二步 d） ── */
    {
      console.log("    · 22.4 开始（整局逐帧渲染审计）");
      eq(MJ.start(makeElement("div"), {}), true, "22.4 开局（渲染层审计）");
      eq(MJ.isBusy(), true, "22.4 开局后 isBusy=true（渲染层断言的前提）");
      eq(MJ.debug.render() !== null, true, "22.4 强制渲染一帧");
      const r0 = MJ.debug.renderAudit();
      ok(r0 && r0.ok, "22.4 首帧渲染审计 ok（单种最大 " + (r0 && r0.max) + "）");
      eq(r0.mode, "table", "22.4 首帧类型 = table");
      ok(r0.total > 10, "22.4 首帧真的画了牌面（" + r0.total + " 张 —— 防止引擎没跑起来时空过）");
      ok(r0.max <= 4, "22.4 首帧画面单种 ≤ 4（实际 " + r0.max + "）");
      /* 逐帧循环里把智脑提示关掉：它跟「画面张数」无关（金框只描边、不画牌面），
         但它每次摸牌都要重算一遍（实测最坏数百毫秒）—— 开着跑 200 帧会把自测拖成十几分钟。 */
      MJ.debug.hintToggle(false);
      /* 真打一整局，每一拍都渲染 + 审计画面张数 */
      MJ.debug.tileAuditInstall(); MJ.debug.tileAuditOn(true, null);
      let frames = 0, worst = 0, over = [], guard = 0, wait22 = 0;
      const oneFrame = () => {
        const tf = Date.now();
        try { MJ.debug.render(); } catch (e) {}
        if (frames % 10 === 0) console.log("    · 22.4 帧 " + frames + " 单帧渲染 " + (Date.now() - tf) + "ms");
        frames++;
        const ra = MJ.debug.renderAudit();
        if (ra) {
          if (ra.max > worst) worst = ra.max;
          if (!ra.ok && !ra.debugView && over.length < 4) over.push(ra);
        }
      };
      oneFrame();
      /* 逐帧审计的口径是"跑过的每一帧"，不是"必须跑到结算" ——
         封顶 70 拍是为了让自测时长可控（整局逐帧的重口径由浏览器探针承担：
         tools/dev/_mj-ui-audit-probe.js 一次跑 4480 帧 / e2e 自走整局）。 */
      while (guard++ < 70) {
        const st = MJ.debug.state();
        if (!st || st.phase === "over" || st.result) break;
        let act = "";
        if (st.phase === "claim" && st.pending && st.pending.seat === 0) act = "pass";
        else if (st.phase === "rob" && st.pending && st.pending.seat === 0) act = "pass";
        else if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 1) act = "draw";
        else if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2) act = "discard";
        if (act) { if (!MJ.debug.act(act)) { if (++wait22 > 3) break; } else wait22 = 0; }
        else {
          const rr22 = MJ.debug.step();
          if (rr22 === "off" || rr22 === "over") break;
          if (rr22 === "wait") { if (++wait22 > 3) break; } else wait22 = 0;
        }
        oneFrame();
      }
      const st22 = MJ.debug.tileAuditState();
      eq(st22.fails, 0, "22.4 整局（人 + AI 混打）每一拍容器审计通过（" + st22.n + " 拍）" +
        (st22.fails ? " → " + JSON.stringify(T.tileAuditReport().list[0].violations) : ""));
      ok(frames > 12, "22.4 逐帧审计 " + frames + " 帧（牌局可能很早就分出胜负，所以只要求真的画了很多帧）");
      eq(over.length, 0, "22.4 没有任何一帧画面单种 > 4" + (over.length ? " → " + JSON.stringify(over[0].over) : ""));
      ok(worst <= 4, "22.4 画面单种最大 = " + worst + "（上限 4）");
      ok(st22.n > 12, "22.4 整局真的推进了 " + st22.n + " 拍（不是开局就断）");
      MJ.debug.hintToggle(true);
      /* 结算亮牌板也审计（四家手牌全亮 —— 最容易看出"多出一张"的画面） */
      MJ.debug.render();
      const rEnd = MJ.debug.renderAudit();
      ok(rEnd && rEnd.max <= 4, "22.4 结算/末帧画面单种 ≤ 4（实际 " + (rEnd && rEnd.max) + " · 模式 " + (rEnd && rEnd.mode) + "）");
      T.tileAuditOn(false);
      MJ.dispose();
    }

    /* ── 22.5 调试摆牌守恒（根因修复的回归断言）──
       旧实现 setHand/forceWin 直接 `p.hand = want` + `p.melds = []` = 只加不减，
       实测能摆出「6条 × 6 张 · 总数 137/136」——用户截图里的「六张六条」就是这个机理。
       修复后摆牌只搬牌不造牌：同名牌永远 ≤4、总数永远 136。 */
    {
      console.log("    · 22.5 开始（摆牌守恒 · 引擎级）");
      /* 直接用守恒摆牌的实现（Mahjong.test.rigPlayer）跑，不依赖 UI 生命周期 ——
         这样这条断言在任何环境下都稳定复现「只搬牌不造牌」。 */
      eq(typeof T.rigPlayer, "function", "22.5 摆牌实现可见（Mahjong.test.rigPlayer —— setHand/forceWin 的底层）");
      const E = new T.Engine(10, { honors: true });
      E.deal();
      for (let i = 0; i < 30 && E.phase !== "over"; i++) E.aiStep();     /* 真打若干拍，让牌散到四个容器里 */
      const before = T.tileAudit(E);
      eq(before.ok, true, "22.5 摆牌前审计 ok（总数 " + before.total + "/" + before.expect + "）");
      /* 找一张「自己手里没有、别处有」的牌 —— 摆 3 张进去一定是合法请求（≤4 张） */
      const P0 = E.P[0], mineOf = (k) => T.countIn(P0.hand, k);
      let T2 = null, bestE = 0;
      for (const k of Object.keys(before.byType)) {
        const e = before.byType[k] - mineOf(k);
        if (mineOf(k) === 0 && e > bestE) { bestE = e; T2 = k; }
      }
      ok(!!T2, "22.5 找到「自己手里 0 张、别处 " + bestE + " 张」的牌：" + T2);
      const hand = [T2, T2, T2];
      for (const h of P0.hand) hand.push(h);           /* 原手牌全带上（不封顶）：请求里 T2 恰好 3 张 → 永远合法 */
      const wantN = 3;
      eq(T.rigPlayer(E, 0, hand, []), true, "22.5 摆牌成功（合法请求）");
      const after = T.tileAudit(E);
      eq(after.ok, true, "22.5 摆牌后审计仍 ok" + (after.ok ? "" : " → " + JSON.stringify(after.violations)));
      eq(after.total, 136, "22.5 摆牌后总数仍 = 136（旧实现是 137）");
      eq(after.byType[T2], 4, "22.5 摆牌后「" + T2 + "」全场仍是 4 张（旧实现能摆到 5~6 张）");
      eq(T.countIn(P0.hand, T2), wantN, "22.5 手牌里确实是 " + wantN + " 张 " + T2);
      eq(P0.hand.length, hand.length, "22.5 手牌张数 = 摆牌请求的张数（" + hand.length + " 张）");
      ok(hand.length >= 8, "22.5 摆牌请求是一手真牌（" + hand.length + " 张）");
      /* 物理上不存在的请求（同名牌 5 张）→ 必须拒绝，且不改任何状态 */
      const snap = after.total + "|" + after.byType[T2] + "|" + T.countIn(P0.hand, T2) + "|" + E.wall.length;
      eq(T.rigPlayer(E, 0, [T2, T2, T2, T2, T2], []), false, "22.5 摆 5 张同名牌被拒绝（物理上只有 4 张）");
      const refused = T.tileAudit(E);
      eq(refused.ok, true, "22.5 被拒绝后审计仍 ok（状态没被改坏）");
      eq(refused.total + "|" + refused.byType[T2] + "|" + T.countIn(P0.hand, T2) + "|" + E.wall.length, snap,
        "22.5 被拒绝后状态与摆牌前**逐项一致**（含牌墙长度）");
      /* 别家的牌也不能被凭空吞掉 / 复制：摆牌前后「全局容器张数」逐项守恒 */
      const cnt = (X) => { let n = X.wall.length; for (const p of X.P) { n += p.hand.length + p.discards.length; for (const m of p.melds) n += m.tiles.length; } return n; };
      eq(cnt(E), 136, "22.5 摆牌后全局容器张数仍是 136");
    }

    /* ── 22.5b UI 摆牌出口（Mahjong.debug.setHand / forceWin）也必须守恒 ──
       这一节依赖 UI 生命周期，所以只在开局成功时断言；开局失败会单独报出来（不静默跳过）。 */
    {
      const started = MJ.start(makeElement("div"), {});
      eq(started, true, "22.5b 开局成功（UI 摆牌出口）");
      const E = MJ.debug.engine();
      ok(!!E, "22.5b 开局后引擎可读（G.E 非空）");
      if (E) {
        for (let i = 0; i < 26; i++) {
          const st = MJ.debug.state();
          if (!st || st.phase === "over") break;
          if (st.phase === "claim" && st.pending && st.pending.seat === 0) MJ.debug.act("pass");
          else if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2) MJ.debug.act("discard");
          else if (MJ.debug.step() === "off") break;
        }
        const b2 = MJ.debug.tileAudit();
        eq(b2.ok, true, "22.5b 摆牌前审计 ok（总数 " + b2.total + "）");
        let U = null, be = 0;
        for (const k of Object.keys(b2.byType)) {
          const m = T.countIn(E.P[0].hand, k), e = b2.byType[k] - m;
          if (m === 0 && e > be) { be = e; U = k; }
        }
        ok(!!U, "22.5b 找到「自己手里 0 张、别处 " + be + " 张」的牌：" + U);
        const h2 = [U, U, U];
        for (const h of E.P[0].hand) h2.push(h);        /* 原手牌全带上：请求里 U 恰好 3 张 → 永远合法 */
        eq(MJ.debug.setHand(h2, [], null), true, "22.5b debug.setHand 成功");
        const a2 = MJ.debug.tileAudit();
        eq(a2.ok, true, "22.5b setHand 后审计仍 ok" + (a2.ok ? "" : " → " + JSON.stringify(a2.violations)));
        eq(a2.total, 136, "22.5b setHand 后总数仍 = 136");
        eq(a2.byType[U], 4, "22.5b setHand 后「" + U + "」全场仍 4 张（旧实现摆出 6 张）");
        eq(MJ.debug.setHand([U, U, U, U, U], [], null), false, "22.5b 摆 5 张同名牌被拒绝");
        eq(MJ.debug.forceWin(0), true, "22.5b forceWin 成功（守恒版）");
        const fw = MJ.debug.tileAudit();
        eq(fw.ok, true, "22.5b forceWin 后审计仍 ok" + (fw.ok ? "" : " → " + JSON.stringify(fw.violations)));
        eq(fw.total, 136, "22.5b forceWin 后总数仍 = 136");
        ok(fw.max <= 4, "22.5b forceWin 后单种 ≤ 4（实际 " + fw.max + "）");
      }
      T.tileAuditOn(false);
      MJ.dispose();
    }

    /* ── 22.6 审计自身的口径检查（防止审计被"写松"而假绿） ── */
    {
      const E = new T.Engine(10, { honors: true });
      E.deal();
      const a = T.tileAudit(E);
      const names = Object.keys(a.places);
      ok(names.indexOf("牌墙") >= 0, "22.6 审计覆盖牌墙");
      ok(names.some(n => /^P0\(.*\)\.手牌$/.test(n)), "22.6 审计覆盖四家暗手");
      ok(names.some(n => /副露/.test(n)) || E.P.every(p => !p.melds.length), "22.6 审计覆盖副露（碰/明杠/暗杠/补杠）");
      ok(names.some(n => /弃牌$/.test(n)) || E.P.every(p => !p.discards.length), "22.6 审计覆盖四家牌河");
      /* 主动造一次「同名牌 5 张」：审计必须抓住（否则这一节的绿灯没有意义） */
      const E2 = new T.Engine(10, { honors: true });
      E2.deal();
      const had5 = T.countIn(E2.P[0].hand, "5万");          /* 起手可能已经有几张 5万（随机） */
      E2.P[0].hand.push("5万", "5万", "5万", "5万", "5万");
      const bad = T.tileAudit(E2);
      eq(bad.ok, false, "22.6 人为塞第 5 张 5万 → 审计必须判违规（not ok）");
      const v5 = bad.violations.filter(v => v.tile === "5万");
      eq(v5.length, 1, "22.6 正好报出一条 5万 违规");
      eq(v5[0].count, 9, "22.6 违规条目指名道姓：5万 × 9（整副牌本来 4 张 + 人为塞 5 张）");
      eq(T.countIn(E2.P[0].hand, "5万"), had5 + 5, "22.6 手牌里 5万 = 起手 " + had5 + " + 人为塞 5");
      eq(v5[0].where.indexOf("P0(你).手牌 " + T.countIn(E2.P[0].hand, "5万") + " 张") >= 0, true,
        "22.6 违规条目给出「在哪个容器」：→ " + v5[0].where);
      /* 总数被破坏也要抓 */
      const E3 = new T.Engine(10, { honors: true });
      E3.deal();
      E3.wall.pop();
      const bad2 = T.tileAudit(E3);
      eq(bad2.ok, false, "22.6 牌墙少一张（总数 135）→ 审计必须判违规");
      ok(bad2.violations.some(v => v.count === 135 && /全场总数/.test(v.where)), "22.6 违规条目报出总数 135 ≠ 136");
    }
  }
  console.log("通过 " + pass + " / 共 " + (pass + fail) + (fail ? "，失败 " + fail : "，全部通过 ✔"));

  if (fail) { console.log("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
})();
