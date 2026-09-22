/* ═══════════════════════════════════════════════════════════════════════════
   tools/dev/_mj-tile-audit-probe.js — 牌张守恒审计探针（无 UI · 不弹窗）

   目的：定位用户实测「桌上出现六张六条」的**根因**——
        在**每一次状态变更后**执行审计（发牌/摸牌/出牌/碰/明杠/暗杠/补杠/抢杠/胡/流局），
        一旦 ok=false 立刻打印**触发它的那一次动作** + 动作前后各位置计数。

   用法：
     node tools/dev/_mj-tile-audit-probe.js                    # 扫 200 个种子（136 张 / 含字牌）
     node tools/dev/_mj-tile-audit-probe.js --seeds=1..400
     node tools/dev/_mj-tile-audit-probe.js --seed=37 --verbose   # 单个种子 · 逐拍日志
     node tools/dev/_mj-tile-audit-probe.js --honors=0            # 108 张牌组（旧赣麻）
     node tools/dev/_mj-tile-audit-probe.js --stress               # 重点怀疑场景定向打击

   种子即复现：同一 seed 下洗牌序列完全确定（探针接管 Math.random），
   所以「seed + 动作序列」就是可复现的最小重放输入。
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "mahjong.js"), "utf8");

/* ── 极简 DOM stub（纯逻辑探针：只跑 Engine，不做渲染） ── */
function el() {
  return {
    id: "", className: "", style: {}, childNodes: [], children: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { return c; }, removeChild(c) { return c; }, focus() {}, blur() {}, click() {},
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 1180, height: 818 }; },
    getContext() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
    innerHTML: "", textContent: ""
  };
}
const documentStub = {
  createElement: el, getElementById() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  addEventListener() {}, head: el(), body: el()
};
const windowStub = {
  setTimeout, clearTimeout, setInterval() { return 0; }, clearInterval() {},
  requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
  console, Math, Date, JSON, devicePixelRatio: 1,
  document: documentStub, innerWidth: 1280, innerHeight: 900,
  AudioSys: { blip() {}, click() {}, ding() {}, good() {}, bad() {} }
};
windowStub.window = windowStub;
const ctx = vm.createContext(windowStub);
vm.runInContext(SRC, ctx, { filename: "mahjong.js" });
const MJ = ctx.Mahjong || windowStub.Mahjong;
if (!MJ) { console.error("mahjong.js 未导出 window.Mahjong"); process.exit(1); }
const T = MJ.test;
if (!T.tileAudit) { console.error("mahjong.js 缺 Mahjong.test.tileAudit（审计函数没装上？）"); process.exit(1); }

/* ── 可复现随机：接管 Math.random（mahjong.js 在 vm 里共用宿主 Math） ── */
const HOST_RANDOM = Math.random;
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function seedRandom(seed) { Math.random = mulberry32(seed >>> 0); }
function unseedRandom() { Math.random = HOST_RANDOM; }

/* ── 参数 ── */
const argv = process.argv.slice(2);
function argNum(name, dflt) {
  const m = argv.find(a => a.indexOf("--" + name + "=") === 0);
  return m ? +m.split("=")[1] : dflt;
}
const argvHas = n => argv.some(a => a === "--" + n || a.indexOf("--" + n + "=") === 0);
const HONORS = argNum("honors", 1) !== 0;
const VERBOSE = argvHas("verbose");
const STRESS = argvHas("stress");
let S0 = 1, S1 = argNum("games", 200);
{
  const m = argv.find(a => a.indexOf("--seeds=") === 0);
  if (m) { const p = m.split("=")[1].split(".."); S0 = +p[0]; S1 = p.length > 1 ? +p[1] : +p[0]; }
  const one = argv.find(a => a.indexOf("--seed=") === 0);
  if (one) { S0 = S1 = +one.split("=")[1]; }
}

const pad = (s, n) => { s = String(s); while (s.length < n) s += " "; return s; };
const padL = (s, n) => { s = String(s); while (s.length < n) s = " " + s; return s; };
function placesOf(a) { return T.tileAuditPlaces(a); }
/** 某张牌在「前 / 后」两次审计里各位置各几张（违规报告的关键一行） */
function diffTile(before, after, tile) {
  const out = [];
  const names = {};
  [before, after].forEach(a => { if (a) for (const n in a.places) names[n] = 1; });
  for (const n of Object.keys(names)) {
    const b = (before && before.places[n] && before.places[n].tiles[tile]) || 0;
    const c = (after && after.places[n] && after.places[n].tiles[tile]) || 0;
    if (b || c) out.push(n + " " + b + "→" + c);
  }
  return out.join(" · ");
}

/* ═══════════ 一局：每次状态变更后审计 ═══════════ */
function runGame(seed, maxSteps) {
  seedRandom(seed);
  const E = new T.Engine(10, { honors: HONORS });
  const beats = [];
  let firstFail = null;
  T.tileAuditInstall();
  T.tileAuditOn(true, function (rec) {
    beats.push(rec);
    if (!rec.ok && !firstFail) firstFail = beats.length - 1;
    if (VERBOSE) {
      console.log("  " + padL(beats.length, 4) + " " + pad(rec.tag, 34) + " " +
        T.tileAuditLine(rec.audit) + "  " + placesOf(rec.audit));
    }
  });
  E.deal();
  let steps = 0;
  while (E.phase !== "over" && steps < (maxSteps || 4000)) { E.aiStep(); steps++; }
  T.tileAuditOn(false);
  unseedRandom();
  return { engine: E, beats, steps, firstFail, result: E.result };
}

/* ═══════════ 定向压力（边界用例） ═══════════
   边界用例（补杠/直杠被抢杠、暗杠补摸、连续碰杠、四副露大吊车、流局、重开、108 张）
   已搬到专用探针 tools/dev/_mj-stress-audit-probe.js —— 那里用**固定牌墙夹具**把局面钉死，
   而且夹具本身守恒（craft 只重排整副牌 / makeMeld 只搬自己手里的牌），
   所以报出来的任何违规都只可能来自 mahjong.js。
   （早期版本在这里用 rigHand 直接改内存摆牌，那等于用探针自己的 bug 去测被测代码 —— 已删。）*/
function stressBattery() {
  console.log("\n边界用例请跑：node tools/dev/_mj-stress-audit-probe.js");
  return 0;
}


let failSeeds = [], totalBeats = 0, games = 0, firstDetail = null;
const tagHist = {};

console.log("═══ 牌张守恒审计探针 ═══");
console.log("牌组：" + (HONORS ? "136 张（含东南西北中發白）" : "108 张（无字牌）") +
  " · 种子 " + S0 + (S1 > S0 ? ".." + S1 : "") + " · 每一拍都审计");

for (let seed = S0; seed <= S1; seed++) {
  const g = runGame(seed, 4000);
  games++;
  totalBeats += g.beats.length;
  if (g.firstFail !== null) {
    failSeeds.push(seed);
    const i = g.firstFail, rec = g.beats[i], prev = i > 0 ? g.beats[i - 1] : null;
    for (let k = Math.max(0, i - 8); k <= i; k++) {
      const t = g.beats[k].tag;
      tagHist[t] = (tagHist[t] || 0) + 1;
    }
    if (!firstDetail) {
      firstDetail = { seed: seed, idx: i, rec: rec, prev: prev, beats: g.beats };
    }
  }
}
unseedRandom();

console.log("\n跑完 " + games + " 局 · 每拍审计共 " + totalBeats + " 次 · 违规局数 " + failSeeds.length +
  (failSeeds.length ? "（种子 " + failSeeds.slice(0, 20).join(",") + (failSeeds.length > 20 ? " …" : "") + "）" : " · 全部守恒 ✔"));

if (firstDetail) {
  const { seed, idx, rec, prev, beats } = firstDetail;
  console.log("\n══════════ 第一次违规：种子 " + seed + " · 第 " + (idx + 1) + " 拍 ══════════");
  console.log("触发动作：" + rec.tag + (rec.tile ? " · 牌 " + rec.tile : "") +
    " · 第 " + rec.turnNo + " 巡 · phase=" + rec.phase);
  console.log("审计总数：" + rec.audit.total + " / 应有 " + rec.audit.expect +
    "（差 " + (rec.audit.total - rec.audit.expect) + "）· 单种最大 " + rec.audit.max);
  console.log("\n动作前后「各位置计数」：");
  console.log("  前：" + (prev ? placesOf(prev.audit) : "（本拍是第一步，无前态）"));
  console.log("  后：" + placesOf(rec.audit));
  console.log("\n违规明细：");
  for (const v of rec.audit.violations) {
    console.log("  ✖ " + (v.tile ? "[" + v.tile + "] 全场 " + v.count + " 张" : "（结构）") + " → " + v.where);
    if (v.tile) console.log("     该牌逐位置：前 " + diffTile(prev && prev.audit, null, v.tile) +
      " ｜ 后 " + diffTile(null, rec.audit, v.tile));
  }
  console.log("\n最近 " + Math.min(10, idx + 1) + " 拍动作序列（种子 " + seed + " 可精确重放）：");
  for (let k = Math.max(0, idx - 9); k <= idx; k++) {
    const b = beats[k];
    console.log("  " + padL(k + 1, 4) + " " + pad(b.tag, 34) + " " + T.tileAuditLine(b.audit) + (k === idx ? "   ← 触发" : ""));
  }
  console.log("\n重放：node tools/dev/_mj-tile-audit-probe.js --seed=" + seed + " --verbose");
}

if (STRESS) stressBattery();
process.exit(failSeeds.length || firstDetail ? 1 : 0);
