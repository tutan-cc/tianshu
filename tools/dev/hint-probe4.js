/* 性能探针：找出 hintCalc 在哪些手牌上会卡住（渲染线程会一起卡 → 面板慢一拍）
   运行：node tools/dev/hint-probe4.js */
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
function rnd(n, honors) { const pool = []; for (const t of (honors ? T.KINDS_ALL : T.KINDS)) for (let q = 0; q < 4; q++) pool.push(t); for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; } return pool.slice(0, n); }
const mk = (t) => ({ type: "peng", tiles: [t, t, t], from: 3, an: false, kind: "ming" });
const sortT = a => a.slice().sort(T.cmpTile);

console.log("— A. 无副露 14 张随机手（300 手，逐手计时） —");
let worst = 0, wHand = "", sum = 0, n = 0, over100 = 0;
for (let it = 0; it < 300; it++) {
  const h = rnd(14, true);
  T.hintCacheClear();
  const t0 = Date.now();
  T.hintCalc({ hand: h.slice(), melds: [], seen: {}, honors: true });
  const ms = Date.now() - t0;
  sum += ms; n++; if (ms > worst) { worst = ms; wHand = sortT(h).join(" "); } if (ms > 100) over100++;
}
console.log("  最坏 " + worst + "ms（" + wHand + "）平均 " + (sum / n).toFixed(0) + "ms；>100ms " + over100 + "/" + n);

console.log("— B. 1 副露 11 张暗手（100 手） —");
worst = 0; wHand = ""; sum = 0; n = 0; over100 = 0;
for (let it = 0; it < 100; it++) {
  const h = rnd(11, true);
  const melds = [mk(T.KINDS_ALL[it % 34])];
  T.hintCacheClear();
  const t0 = Date.now();
  T.hintCalc({ hand: h.slice(), melds: melds, seen: {}, honors: true });
  const ms = Date.now() - t0;
  sum += ms; n++; if (ms > worst) { worst = ms; wHand = sortT(h).join(" ") + " + 碰" + melds[0].tiles[0]; } if (ms > 100) over100++;
  if (it % 10 === 0) console.log("    #" + it + " " + ms + "ms");
}
console.log("  最坏 " + worst + "ms（" + wHand + "）平均 " + (sum / n).toFixed(0) + "ms；>100ms " + over100 + "/" + n);

console.log("— C. 2 副露 8 张暗手（80 手） —");
worst = 0; wHand = ""; sum = 0; n = 0;
for (let it = 0; it < 80; it++) {
  const h = rnd(8, true);
  const melds = [mk(T.KINDS_ALL[it % 34]), mk(T.KINDS_ALL[(it * 5 + 3) % 34])];
  T.hintCacheClear();
  const t0 = Date.now();
  T.hintCalc({ hand: h.slice(), melds: melds, seen: {}, honors: true });
  const ms = Date.now() - t0;
  sum += ms; n++; if (ms > worst) { worst = ms; wHand = sortT(h).join(" ") + " + 2 副露"; }
  if (it % 10 === 0) console.log("    #" + it + " " + ms + "ms");
}
console.log("  最坏 " + worst + "ms（" + wHand + "）平均 " + (sum / n).toFixed(0) + "ms");
