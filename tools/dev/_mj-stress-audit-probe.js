/* ═══════════════════════════════════════════════════════════════════════════
   tools/dev/_mj-stress-audit-probe.js — 边界用例定向打击 · 每一拍审计

   为什么单独一个：随机对局几乎撞不到「抢杠 / 连续碰杠 / 四副露大吊车 / 杠后补摸」
   这些**高频改手牌**的路径（抢杠是唯一会把 3 张牌 concat 回手牌的地方）。
   这里的每个场景都**用固定的牌墙夹具**把局面钉死，跑完每一拍都审计。

   夹具纪律（很重要）：夹具本身绝不允许破坏守恒 ——
     craft(): 把想要的牌精确放到 deal() 的取牌位置上，剩下的牌原样放进牌墙，
              整副牌恒为 createWall() 的一个排列 → 手牌 13×4 + 庄家 1 = 53 张，牌墙 83 张。
     makeMeld(): 只把**手牌里已有的**牌搬进副露组，不凭空造牌。
   所以任何违规都只可能来自 mahjong.js 自己。

   用法：node tools/dev/_mj-stress-audit-probe.js [--verbose]
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "mahjong.js"), "utf8");
const VERBOSE = process.argv.indexOf("--verbose") >= 0;

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
const T = MJ.test;

const HOST_RANDOM = Math.random;
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ── 夹具：把 spec 里的牌精确放到 deal() 的位置上，其余原样入墙 ── */
function craft(seed, honors, spec) {
  Math.random = mulberry32(seed >>> 0);
  const full = T.createWall(honors);
  const need = {}, has = {};
  for (const t of full) has[t] = (has[t] || 0) + 1;
  for (const i of Object.keys(spec)) {
    if (i === "draw") continue;
    for (const t of spec[i]) need[t] = (need[t] || 0) + 1;
  }
  if (spec.draw) need[spec.draw] = (need[spec.draw] || 0) + 1;   /* 庄家第 14 张（wall[52]）也要算进预算 */
  for (const t of Object.keys(need)) {
    if (need[t] > has[t]) throw new Error("夹具要 " + t + " × " + need[t] + "，牌组只有 " + has[t] + " 张");
  }
  const rest = [];
  for (const t of Object.keys(has)) for (let k = 0; k < has[t] - (need[t] || 0); k++) rest.push(t);
  T.shuffle(rest);
  const wall = [];
  let rp = 0;
  /* deal(): for k in 0..12 { for i in 0..3 { P[i].hand.push(wall.shift()) } } → 位置 4k+i → 家 i */
  for (let k = 0; k < 13; k++) for (let i = 0; i < 4; i++) {
    wall.push(spec[i] && spec[i][k] !== undefined ? spec[i][k] : rest[rp++]);
  }
  if (spec.draw) wall[52] = spec.draw;                          /* 庄家（座位 0）的第一张摸牌 */
  else wall.push(rest[rp++]);
  for (let p = 53; p < full.length; p++) wall.push(rest[rp++]);
  /* 位置 0..51 + 52 + 53.. = 整副牌；用了 spec.draw 时 rest 自然少一张，所以两边都该刚好取完 */
  if (rp !== rest.length || wall.length !== full.length) {
    throw new Error("夹具牌墙对不上：取用 " + rp + "/" + rest.length + " · 牌墙 " + wall.length + "/" + full.length);
  }
  const E = new T.Engine(10, { honors: honors });
  E.wall = wall;
  E.deal();
  return E;
}
/** 把「手牌里已有的」n 张 tile 搬进一个副露组（守恒） */
function makeMeld(E, seat, tile, type, kind, from) {
  const p = E.P[seat], n = type === "peng" ? 3 : 4, idx = [];
  for (let i = p.hand.length - 1; i >= 0 && idx.length < n; i--) if (p.hand[i] === tile) idx.push(i);
  if (idx.length < n) throw new Error("座位 " + seat + " 手牌里没有 " + n + " 张 " + tile);
  for (const i of idx) p.hand.splice(i, 1);
  const tiles = [];
  for (let k = 0; k < n; k++) tiles.push(tile);
  p.melds.push({ type: type, tiles: tiles, from: from === undefined ? (seat + 1) % 4 : from, an: false, kind: kind });
  T.normalizeHand(p);
  return p;
}
/** 把座位手牌换成「牌墙里已经有的那些」——绝不用它换牌，只用来摆听牌/死牌 */
function setHandFromWall(E, seat, want) {
  const p = E.P[seat], give = p.hand.slice();
  const pool = {};
  for (const t of E.wall) pool[t] = (pool[t] || 0) + 1;
  const need = {};
  for (const t of want) need[t] = (need[t] || 0) + 1;
  for (const t of Object.keys(need)) {
    /* 先把「给回去的牌」算进可用池 */
    const back = give.filter(x => x === t).length;
    if ((pool[t] || 0) + back < need[t]) throw new Error("牌墙里凑不出 " + t + " × " + need[t]);
  }
  /* 从牌墙里取 want（有就拿走），取不到的用「给回去的牌」抵（同一张牌来回换） */
  const takeFromWall = [];
  for (const t of want) {
    const i = E.wall.indexOf(t);
    if (i >= 0) { E.wall.splice(i, 1); takeFromWall.push(t); }
  }
  for (const t of takeFromWall) { const i = want.indexOf(t); if (i >= 0) want = want.slice(0, i).concat(want.slice(i + 1)); }
  /* 剩下的用 give 里的同名牌顶上 */
  const restWant = want.slice();
  for (const t of restWant) {
    const i = give.indexOf(t);
    if (i < 0) throw new Error("换牌失败：" + t);
    give.splice(i, 1);
    const j = restWant.indexOf(t); restWant.splice(j, 1);
  }
  for (const t of give) E.wall.push(t);                       /* 旧牌回墙 */
  p.hand = takeFromWall.concat(restWant);
  T.normalizeHand(p);
  return p;
}

/* ── 场景运行器：每一拍审计 ── */
const rows = [];
function scenario(name, honors, fn) {
  T.tileAuditInstall(); T.tileAuditOn(true, null);
  let err = "", note = "";
  try { note = fn() || ""; } catch (e) { err = String((e && e.message) || e); }
  const rep = T.tileAuditReport();
  T.tileAuditOn(false);
  Math.random = HOST_RANDOM;
  rows.push({ name, beats: rep.n, fails: rep.fails, err, note, list: rep.list });
  const bad = rep.fails || err;
  console.log((bad ? "  ✖ " : "  ✔ ") + name);
  console.log("      审计 " + rep.n + " 拍 · 违规 " + rep.fails + (err ? " · 异常 " + err : "") + (note ? " · " + note : ""));
  for (const f of rep.list) for (const v of f.violations) {
    console.log("      → [" + f.tag + "] " + (v.tile || "（结构）") + " × " + v.count + " : " + v.where);
  }
  return !bad;
}

/** 把整局推到底（人当 AI 走；响应窗口一律过） */
function runOut(E, maxSteps) {
  let n = 0;
  while (E.phase !== "over" && n < (maxSteps || 4000)) {
    if (E.phase === "turn") E.aiStep();
    else if (E.phase === "claim") E.claim(E.pending.seat, "pass");
    else if (E.phase === "rob") E.passRob(E.pending.seats[0]);
    else break;
    n++;
  }
  return n;
}

console.log("═══ 边界用例定向打击（每一拍都审计 · 夹具本身守恒）═══\n");
let bad = 0;
const A = (n, h, f) => { if (!scenario(n, h, f)) bad++; };

/* ── ① 补杠 → 被抢杠胡（唯一会把 3 张 concat 回手牌的路径） ── */
A("① 补杠（回头杠）→ 被下家抢杠胡", true, () => {
  /* 9筒 4 张全在 0 家：3 张做副露碰 + 1 张在手 → 可补杠；
     1 家听 9筒（123筒 456筒 78筒 + 99条 + 111条，手里没有 9筒） */
  const E = craft(101, true, {
    0: ["9筒", "9筒", "9筒", "9筒", "1万", "2万", "3万", "4万", "5万", "6万", "7万", "8万", "9万"],
    1: ["1筒", "2筒", "3筒", "4筒", "5筒", "6筒", "7筒", "8筒", "9条", "9条", "1条", "1条", "1条"],
    2: ["1万", "1万", "2条", "2条", "3条", "3条", "4条", "4条", "5条", "5条", "6条", "6条", "7条"],
    3: ["东", "东", "南", "南", "西", "西", "北", "北", "中", "中", "發", "發", "白"]
  });
  makeMeld(E, 0, "9筒", "peng", "ming", 1);                   /* 手牌 −3 → 副露碰 9筒；手里还剩 1 张 9筒 */
  E.cur = 0; E.phase = "turn";
  E.pending = { type: "turn", seat: 0, anGangs: [], addGangs: ["9筒"] };
  const before = T.tileAudit(E);
  if (!before.ok) throw new Error("夹具状态就不守恒：" + JSON.stringify(before.violations));
  if (!E.turnGang(0, "9筒", "bu")) throw new Error("补杠失败（夹具不对）");
  if (E.phase !== "rob") return "补杠后没人能抢（夹具没触发抢杠）";
  const robber = E.pending.seats[0];
  E.rob(robber);
  if (!E.result || !E.result.robKong) throw new Error("抢杠没成功");
  const a = T.tileAudit(E);
  if (!a.ok) throw new Error("抢杠后违规：" + JSON.stringify(a.violations));
  return "抢杠家 P" + robber + " · 9筒全场 " + a.byType["9筒"] + " 张 · 总数 " + a.total;
});

/* ── ② 直杠（大明杠）→ 被抢杠胡 ── */
A("② 直杠（大明杠）→ 被抢杠胡", true, () => {
  /* 0 家手里 3 张 9筒；2 家打出第 4 张 → 直杠 → 1 家抢（1 家听 9筒且手里没有 9筒，9筒全场刚好 4 张） */
  const E = craft(102, true, {
    0: ["9筒", "9筒", "9筒", "1万", "2万", "3万", "4万", "5万", "6万", "7万", "8万", "东", "南"],
    1: ["1筒", "2筒", "3筒", "4筒", "5筒", "6筒", "7筒", "8筒", "9条", "9条", "1条", "1条", "1条"],
    2: ["9筒", "2条", "3条", "4条", "5条", "6条", "7条", "8条", "西", "西", "北", "北", "發"],
    3: ["东", "东", "南", "南", "西", "西", "北", "北", "中", "中", "發", "發", "白"]
  });
  E.cur = 2; E.phase = "turn"; E.turn(2);                       /* 2 家先摸一张（出牌前必须有 14 张） */
  if (E.phase === "over") return "2 家摸牌就胡了（夹具没料到）";
  if (!E.discard(2, E.P[2].hand.indexOf("9筒"))) throw new Error("2 家打不出 9筒");
  if (E.phase !== "claim") return "没开出碰/杠窗口（夹具不对）";
  if (E.pending.seat !== 0) return "窗口不在 0 家（在 P" + E.pending.seat + "）";
  if (!E.claim(0, "gang")) throw new Error("直杠失败");
  if (E.phase !== "rob") return "直杠后没人能抢（夹具没触发）";
  const pre = T.tileAudit(E);
  const r = T.closestRobCheck || null;
  E.rob(E.pending.seats[0]);
  const a = T.tileAudit(E);
  if (!a.ok) throw new Error("抢杠后违规：" + JSON.stringify(a.violations));
  return "抢杠前 9筒 " + pre.byType["9筒"] + " 张 → 抢杠后 " + a.byType["9筒"] + " 张（应仍 4）· 总数 " + a.total;
});

/* ── ③ 直杠后无人抢 → 杠后补摸 → 打完 ── */
A("③ 直杠 → 无人抢 → 杠后补摸 → 打到结束", true, () => {
  const E = craft(103, true, {
    0: ["9筒", "9筒", "9筒", "1万", "2万", "3万", "4万", "5万", "6万", "7万", "8万", "东", "南"],
    1: ["1筒", "2筒", "3筒", "5筒", "7筒", "2条", "4条", "6条", "8条", "西", "西", "北", "北"],
    2: ["9筒", "1条", "2条", "3条", "4条", "5条", "6条", "7条", "8条", "中", "中", "發", "發"],
    3: ["东", "东", "南", "南", "西", "西", "北", "北", "白", "白", "白", "中", "發"]
  });
  E.cur = 2; E.phase = "turn"; E.turn(2);
  if (E.phase === "over") return "2 家摸牌就胡了（夹具没料到）";
  E.discard(2, E.P[2].hand.indexOf("9筒"));
  if (E.phase === "claim" && E.pending.seat === 0) E.claim(0, "gang");
  else return "0 家没拿到杠窗口（夹具不对）";
  const n = runOut(E, 4000);
  const a = T.tileAudit(E);
  return "续跑 " + n + " 拍 · 9筒全场 " + a.byType["9筒"] + " 张 · 总数 " + a.total + "/" + a.expect +
    " · 结局 " + (E.result && E.result.draw ? "流局" : (E.result ? E.result.winner + " 胡" : "未结束"));
});

/* ── ④ 暗杠 → 杠后补摸（杠开分支 + 不杠开分支） ── */
A("④ 暗杠 → 杠后补摸 → 打到结束", true, () => {
  const E = craft(104, true, {
    0: ["5筒", "5筒", "5筒", "5筒", "1万", "3万", "5万", "7万", "9万", "1条", "4条", "7条", "东"],
    1: ["1筒", "3筒", "6筒", "7筒", "8筒", "2条", "5条", "8条", "西", "西", "北", "北", "白"],
    2: ["2筒", "4筒", "9筒", "1条", "2条", "3条", "6条", "9条", "南", "南", "中", "中", "發"],
    3: ["东", "东", "南", "南", "西", "西", "北", "北", "中", "發", "白", "白", "9筒"]
  });
  E.cur = 0; E.phase = "turn";
  E.pending = { type: "turn", seat: 0, anGangs: ["5筒"], addGangs: [] };
  if (!E.turnGang(0, "5筒", "an")) throw new Error("暗杠失败");
  const mid = T.tileAudit(E);
  const meld = E.P[0].melds[0];
  const n = runOut(E, 4000);
  const a = T.tileAudit(E);
  return "暗杠副露 " + meld.tiles.length + " 张（应 4）· 暗杠后即时审计 " + (mid.ok ? "ok" : "✖") +
    " · 续跑 " + n + " 拍 · 5筒全场 " + a.byType["5筒"] + " 张 · 总数 " + a.total + "/" + a.expect;
});

/* ── ⑤ 连续碰 → 补杠 → 暗杠（同一家一拍内连做） ── */
A("⑤ 连续碰 2 次 → 暗杠 → 补杠（同家连续改手牌）", true, () => {
  const E = craft(105, true, {
    0: ["1筒", "1筒", "1筒", "1筒", "3筒", "3筒", "3筒", "4筒", "4筒", "4筒", "4筒", "1万", "2万"],
    1: ["2万", "3万", "4万", "5万", "6万", "7万", "8万", "9万", "1条", "3条", "5条", "7条", "9条"],
    2: ["5筒", "6筒", "7筒", "8筒", "9筒", "2条", "4条", "6条", "8条", "东", "南", "西", "北"],
    3: ["东", "东", "南", "南", "西", "西", "北", "北", "中", "中", "發", "發", "白"]
  });
  makeMeld(E, 0, "3筒", "peng", "ming", 1);                    /* 手牌 −3 → 副露碰 3筒 */
  makeMeld(E, 0, "4筒", "peng", "ming", 2);                    /* 手牌 −3 → 副露碰 4筒（手里还剩 1 张 4筒） */
  const h0 = E.P[0].hand.length;
  E.cur = 0; E.phase = "turn";
  E.pending = { type: "turn", seat: 0, anGangs: ["1筒"], addGangs: ["4筒"] };
  if (!E.turnGang(0, "1筒", "an")) throw new Error("暗杠 1筒 失败");
  const afterAn = T.tileAudit(E);
  E.cur = 0; E.phase = "turn";
  E.pending = { type: "turn", seat: 0, anGangs: [], addGangs: ["4筒"] };
  if (!E.turnGang(0, "4筒", "bu")) throw new Error("补杠 4筒 失败");
  const a = T.tileAudit(E);
  if (!a.ok) throw new Error("连做之后违规：" + JSON.stringify(a.violations));
  const n = runOut(E, 4000);
  const b = T.tileAudit(E);
  return "手牌 " + h0 + " → 副露 " + E.P[0].melds.length + " 组（碰3 + 碰3 + 暗杠4 + 补杠4 = 14 张）" +
    " · 暗杠后 " + (afterAn.ok ? "ok" : "✖") + " · 1筒 " + b.byType["1筒"] + " / 3筒 " + b.byType["3筒"] +
    " / 4筒 " + b.byType["4筒"] + " · 总数 " + b.total + "/" + b.expect + " · 续跑 " + n;
});

/* ── ⑥ 四副露大吊车（单吊将）→ 摸到那张就胡 ── */
A("⑥ 四副露大吊车（4 碰 + 单吊 9筒 → 摸 9筒 胡）", true, () => {
  const E = craft(106, true, {
    draw: "9筒",                                               /* 庄家第 14 张 = 单吊的那张 → 必成大吊车 */
    0: ["1万", "1万", "1万", "2条", "2条", "2条", "3筒", "3筒", "3筒", "6万", "6万", "6万", "9筒"],
    1: ["1筒", "3筒", "5筒", "7筒", "9条", "4条", "6条", "8条", "东", "南", "西", "北", "白"],
    2: ["2万", "4万", "6万", "8万", "2条", "4条", "6条", "8条", "中", "中", "發", "發", "白"],
    3: ["东", "东", "南", "南", "西", "西", "北", "北", "中", "發", "白", "白", "9条"]
  });
  makeMeld(E, 0, "1万", "peng", "ming", 1);
  makeMeld(E, 0, "2条", "peng", "ming", 2);
  makeMeld(E, 0, "3筒", "peng", "ming", 3);
  makeMeld(E, 0, "6万", "peng", "ming", 1);
  const a0 = T.tileAudit(E);
  if (!a0.ok) throw new Error("四副露后违规：" + JSON.stringify(a0.violations));
  if (E.P[0].hand.length !== 2) return "夹具手牌 " + E.P[0].hand.length + " 张（期望 2 = 单吊对子），跳过";
  if (E.P[0].hand[0] !== "9筒" || E.P[0].hand[1] !== "9筒") return "夹具单吊不是 9筒 对子：" + E.P[0].hand.join(",");
  const ev = T.evaluate(E.P[0].hand, E.P[0].melds);
  if (!ev) throw new Error("四副露 + 9筒对子竟然不成牌");
  E.settle(0, { selfDraw: true }, ev);                          /* 走真实结算路径（四副露大吊车） */
  const b = T.tileAudit(E);
  if (!b.ok) throw new Error("大吊车结算后违规：" + JSON.stringify(b.violations));
  return "大吊车 " + ev.name + " · 9筒全场 " + b.byType["9筒"] + " 张 · 总数 " + b.total + "/" + b.expect +
    " · 结算 " + E.result.fanName + " 每家 " + E.result.perPlayer;
});

/* ── ⑦ 流局（牌墙摸完） ── */
A("⑦ 流局（牌墙摸完 · 四家都不胡）", true, () => {
  const E = craft(107, true, {
    0: ["1万", "4万", "7万", "1条", "4条", "7条", "1筒", "4筒", "7筒", "东", "南", "西", "北"],
    1: ["2万", "5万", "8万", "2条", "5条", "8条", "2筒", "5筒", "8筒", "东", "南", "西", "北"],
    2: ["3万", "6万", "9万", "3条", "6条", "9条", "3筒", "6筒", "9筒", "东", "南", "西", "北"],
    3: ["1万", "2万", "3万", "4万", "5万", "6万", "7万", "8万", "9万", "1条", "2条", "3条", "5条"]
  });
  /* 把 0 家的手牌全换成牌墙里的散牌，保证它胡不了；其余靠 AI 打完 */
  const n = runOut(E, 4000);
  const a = T.tileAudit(E);
  return "续跑 " + n + " 拍 · 结局 " + (E.result && E.result.draw ? "流局（" + E.result.why + "）" : "居然分出了胜负：" + (E.result && E.result.winner)) +
    " · 总数 " + a.total + "/" + a.expect + " · 单种最大 " + a.max;
});

/* ── ⑧ 108 张牌组（honors=false）整局 ── */
A("⑧ 108 张牌组（无字牌）整局", false, () => {
  const E = craft(108, false, {});
  const n = runOut(E, 4000);
  const a = T.tileAudit(E);
  return "续跑 " + n + " 拍 · 总数 " + a.total + "/" + a.expect + " · 单种最大 " + a.max;
});

/* ── ⑨ 连开 3 局（重开不清旧容器 → 立刻现形） ── */
A("⑨ 连开 3 局（每局每一拍审计）", true, () => {
  let n = 0, s = "";
  for (let g = 0; g < 3; g++) {
    const E = craft(109 + g, true, {});
    n += runOut(E, 4000);
    const a = T.tileAudit(E);
    s += "[" + (g + 1) + "] 总数 " + a.total + " 最大 " + a.max + " ";
    if (!a.ok) throw new Error("第 " + (g + 1) + " 局违规：" + JSON.stringify(a.violations));
  }
  return s + "· 合计 " + n + " 拍";
});

/* ── ⑩ 同一张牌「手牌 2 张 + 牌河 1 张」被碰（用户截图最可能的那一手） ── */
A("⑩ 手牌 3 张 6条 + 别家打出第 4 张 → 碰（副露 3 + 牌河 −1 + 手牌 −2）", true, () => {
  const E = craft(110, true, {
    0: ["6条", "6条", "6条", "1万", "2万", "3万", "4万", "5万", "6万", "7万", "8万", "东", "南"],
    1: ["1筒", "2筒", "3筒", "4筒", "5筒", "6筒", "7筒", "8筒", "9筒", "西", "西", "北", "北"],
    2: ["6条", "1条", "2条", "3条", "4条", "5条", "7条", "8条", "9条", "中", "中", "發", "發"],
    3: ["东", "东", "南", "南", "西", "西", "北", "北", "白", "白", "白", "中", "發"]
  });
  E.cur = 2; E.phase = "turn"; E.turn(2);
  if (E.phase === "over") return "2 家摸牌就胡了（夹具没料到）";
  if (!E.discard(2, E.P[2].hand.indexOf("6条"))) throw new Error("2 家打不出 6条");
  if (E.phase !== "claim" || E.pending.seat !== 0) return "0 家没拿到碰窗口（夹具不对）";
  const cnt = E.pending.tile;
  if (!E.claim(0, "peng")) throw new Error("碰失败");
  const a = T.tileAudit(E);
  return "碰 " + cnt + "：全场 " + a.byType[cnt] + " 张 · 手牌里还剩 " + T.countIn(E.P[0].hand, cnt) +
    " 张 · 副露 " + E.P[0].melds[0].tiles.length + " 张 · 牌河 " + E.P[2].discards.length + " 张 · 总数 " + a.total +
    (a.byType[cnt] > 4 ? "  ✖ 超过 4 张！" : " ✔ 未超 4 张");
});

console.log("\n════════════════════════════════");
console.log(rows.length + " 个场景 · 违规 " + bad + " 个 · 合计审计 " + rows.reduce((s, r) => s + r.beats, 0) + " 拍");
process.exit(bad ? 1 : 0);
