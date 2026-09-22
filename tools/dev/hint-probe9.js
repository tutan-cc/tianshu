/* 探针 9：核准新增测试要用的每一手构造（听没听 / 向听几 / 进张） */
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "mahjong.js"), "utf8");
const documentStub = { createElement: () => ({ style: {}, childNodes: [], appendChild() {}, addEventListener() {}, setAttribute() {}, getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }), getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, head: null, body: null };
const windowStub = { setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {}, console, Math, Date, JSON, devicePixelRatio: 1, document: documentStub, innerWidth: 1280, innerHeight: 900, AudioSys: {} };
windowStub.window = windowStub;
const ctx = vm.createContext(windowStub);
vm.runInContext(SRC, ctx, { filename: "mahjong.js" });
const T = ctx.Mahjong.test;
const SUIT_MAP = { m: "万", s: "条", p: "筒" };
function P(s) { const out = []; for (const part of String(s).split(/\s+/)) { if (!part) continue; const m = /^([0-9]+)([msp])$/.exec(part); if (m) { for (const ch of m[1]) out.push(ch + SUIT_MAP[m[2]]); continue; } const m2 = /^([1-9])([万条筒])$/.exec(part); if (m2) { out.push(part); continue; } for (const ch of part) out.push(ch); } return out; }
const meld = (type, s, an) => { const t = P(s); return { type, tiles: type === "gang" ? [t[0], t[0], t[0], t[0]] : [t[0], t[0], t[0]], from: 3, an: !!an, kind: an ? "an" : "ming" }; };
const sortT = a => a.slice().sort(T.cmpTile);

const G = [
  ["两面", [], P("123m 456m 789m 23s 99s")],
  ["单钓", [], P("123m 456m 789m 123s 9s")],
  ["坎张", [], P("123m 456m 789m 13s 99s")],
  ["对倒", [], P("123m 456m 789m 22s 99s")],
  ["七对", [], P("11m 22m 33m 44s 55s 66p 7p")],
  ["龙七对形", [], P("11m 22m 33m 44m 55s 66s 7s")],
  ["字牌单钓", [], P("123m 456m 789m 99s 东东")],
  ["字牌对倒", [], P("123m 456m 789m 东东 南南")],
  ["单副露两面", [meld("peng", "5万")], P("123m 789m 23s 99s")],
  ["单副露单钓", [meld("peng", "5万")], P("123m 789m 123s 9s")],
  ["单副露对倒", [meld("peng", "5万")], P("123m 789m 22s 99s")],
  ["双副露单钓", [meld("peng", "5万"), meld("peng", "2条")], P("123m 789m 9s")],
  ["双副露两面", [meld("peng", "5万"), meld("peng", "2条")], P("123m 23s 99s")],
  ["大吊车", [meld("peng", "5万"), meld("peng", "6条"), meld("gang", "7筒", true), meld("peng", "东")], P("9s")],
  ["三副露", [meld("peng", "5万"), meld("peng", "6条"), meld("peng", "7筒")], P("123m 9s")],
  ["副露+字牌", [meld("peng", "5万")], P("123m 789m 99s 东东")]
];
for (const [name, melds, h] of G) {
  const w = T.waitsFor(h, melds, true);
  console.log((w.length ? "✔" : "✗") + " " + name.padEnd(12) + " 暗手 " + String(h.length).padStart(2) + " 张 [" + sortT(h).join(" ") + "] 副露 " + melds.length +
    " → 听 " + (w.join("/") || "(无)") + " sh=" + T.totalShanten(h, melds.length));
}
console.log("\n— 副露向听 / 进张 —");
const m5 = [meld("peng", "5万")];
console.log("h11 = 123m 789m 23s 99s 中 +碰5万 → totalShanten(11,1)=" + T.totalShanten(P("123m 789m 23s 99s 中"), 1) + "（期望 0 = 打 中 即听）");
for (const s of ["123m 789m 23s 9s 5p", "123m 789m 23s 9s 9p", "123m 789m 2s 3s 9s 5p", "135m 789m 23s 9s 5p"]) {
  const h = P(s);
  console.log("  h10 = " + sortT(h).join(" ") + "(" + h.length + "张) +碰5万 → sh=" + T.totalShanten(h, 1) + " 进张=" + T.gainsOf(h, 1, {}, true, undefined, m5).map(x => x.tile + "×" + x.left).join(" ") || "(空)");
}
console.log("\n— base（去掉哪张）—");
const h14 = P("123m 456m 789m 23s 99s 1万");
for (const d of ["1万", "9条"]) {
  const r = T.hintCalc({ hand: h14, melds: [], drawn: d, seen: {}, honors: true });
  console.log("  drawn=" + d + " → base=" + r.base.join(" ") + " | discard=" + r.discard + " tenpaiNow=" + r.tenpaiNow + " improve=" + r.improve.map(x => x.tile).join("/") + " | " + r.reason);
}
const rNo = T.hintCalc({ hand: h14, melds: [], seen: {}, honors: true });
console.log("  不传 drawn → base=" + rNo.base.join(" ") + "（应与 drawn=1万 相同）");
const rSort = T.hintCalc({ hand: T.sortTiles(h14), melds: [], seen: {}, honors: true });
console.log("  传排序后的数组 → base=" + rSort.base.join(" ") + "（末张 = " + sortT(h14)[sortT(h14).length - 1] + "）");
console.log("\n— noBetter 分支（字牌关 + 字牌听）—");
const rn = T.hintCalc({ hand: P("123m 456m 789m 99s 东东").concat(["5筒"]), melds: [], seen: {}, honors: false });
console.log("  honors=false 手=123m 456m 789m 99s 东东 5筒 → discard=" + rn.discard + " tenpaiNow=" + rn.tenpaiNow + " shantenNow=" + rn.shantenNow + " noBetter=" + rn.noBetter + " | " + rn.reason);
const rn2 = T.hintCalc({ hand: P("123m 456m 789m 99s 东东 5筒"), melds: [], seen: {}, honors: true });
console.log("  honors=true  同一手 → discard=" + rn2.discard + " tenpaiNow=" + rn2.tenpaiNow + " noBetter=" + rn2.noBetter + " | " + rn2.reason);
console.log("\n— 时序：同一 13 张核心 + 两张不同摸牌 → 建议 —");
const core = P("13579m 2468s 1357p");
for (const d of ["1万", "中", "5筒"]) {
  const r = T.hintCalc({ hand: core.concat([d]), melds: [], drawn: d, seen: {}, honors: true });
  console.log("  摸 " + d + " → 建议打 " + r.discard + "（sh " + r.shanten + "）| " + r.reason);
}
