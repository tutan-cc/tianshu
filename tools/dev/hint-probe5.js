/* 探针 5：直接找「建议的那张打完 → 听口变差/变死」的真实反例（廉价参考解）
   运行：node tools/dev/hint-probe5.js */
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
const sortT = a => a.slice().sort(T.cmpTile);
const rm = (h, t) => { const o = h.slice(), i = o.indexOf(t); if (i < 0) return null; o.splice(i, 1); return o; };
const cIn = (h, t) => h.filter(x => x === t).length;
function rnd(n, honors) { const pool = []; for (const t of (honors ? T.KINDS_ALL : T.KINDS)) for (let q = 0; q < 4; q++) pool.push(t); for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; } return pool.slice(0, n); }
const mkPeng = t => ({ type: "peng", tiles: [t, t, t], from: 3, an: false, kind: "ming" });
/** 廉价参考：每个可打牌 → 打完是否听、听什么、剩几张、向听 */
function refAll(raw, melds, honors) {
  const mk = melds.length, seen = {}, out = [];
  for (const d of Array.from(new Set(raw))) {
    const rest = rm(raw, d), w = T.waitsFor(rest, melds, honors);
    let left = 0;
    for (const t of w) left += Math.max(0, 4 - cIn(rest, t) - (seen[t] || 0));
    out.push({ d, rest, waits: w, left, sh: T.totalShanten(rest, mk) });
  }
  return out;
}
function check(scName, mkCount, honors, N) {
  let n = 0, deadBetter = 0, leftWorse = 0, shWorse = 0;
  const ex = [];
  for (let it = 0; it < N; it++) {
    const melds = [];
    for (let m = 0; m < mkCount; m++) {
      let t, guard = 0;
      do { t = (honors ? T.KINDS_ALL : T.KINDS)[Math.floor(Math.random() * (honors ? 34 : 27))]; } while (melds.some(x => x.tiles[0] === t) && ++guard < 50);
      melds.push(mkPeng(t));
    }
    const raw0 = rnd(14 - mkCount * 3, honors);
    const p = { hand: raw0.slice(), melds: melds, drawn: raw0[raw0.length - 1] };
    T.normalizeHand(p);
    const raw = p.hand.slice();
    const r = T.hintCalc({ hand: raw, melds: melds, seen: {}, honors: honors });
    if (!r.discard) continue;
    n++;
    const all = refAll(raw, melds, honors);
    const mine = all.filter(o => o.d === r.discard)[0];
    if (!mine) continue;
    const tenpai = all.filter(o => o.waits.length > 0);
    const bestLeft = tenpai.length ? Math.max.apply(null, tenpai.map(o => o.left)) : -1;
    const minSh = Math.min.apply(null, all.map(o => o.sh));
    if (mine.sh > minSh) { shWorse++; if (ex.length < 5) ex.push("[破向听] " + scName + " 手 " + raw.join(" ") + " 副露 " + mkCount + " → 建议打 " + r.discard + "(" + mine.sh + "向听) 最优 " + minSh + "；可打 " + all.filter(o => o.sh === minSh).map(o => o.d).join("/")); }
    else if (tenpai.length && mine.waits.length === 0 && mine.sh === 0) { deadBetter++; if (ex.length < 5) ex.push("[假听] " + scName + " 手 " + raw.join(" ") + " → 建议打 " + r.discard + " 号称听牌但 waitsFor 为空"); }
    else if (tenpai.length && mine.waits.length > 0 && mine.left < bestLeft) { leftWorse++; if (ex.length < 5) ex.push("[听口差] " + scName + " 手 " + raw.join(" ") + " 副露 " + mkCount + " → 建议打 " + r.discard + " 听 " + mine.waits.join("/") + "(" + mine.left + "张)；更优 " + tenpai.filter(o => o.left === bestLeft).map(o => o.d + "→" + o.waits.join("/") + "(" + o.left + "张)").join(" ")); }
  }
  console.log("  " + scName + "：样本 " + n + "；破向听 " + shWorse + "；假听 " + deadBetter + "；听口更差 " + leftWorse);
  ex.forEach(s => console.log("     ✗ " + s));
}
console.log("═══ 无副露 14 张 ═══"); check("无副露", 0, true, 1500);
console.log("═══ 1 副露 11 张 ═══"); check("1副露", 1, true, 1500);
console.log("═══ 2 副露 8 张 ═══"); check("2副露", 2, true, 1500);
console.log("═══ 无字牌 14 张 ═══"); check("无字牌", 0, false, 1500);
