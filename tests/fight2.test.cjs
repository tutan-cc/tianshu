#!/usr/bin/env node
/*
  tests/fight2.test.cjs — 打斗 2.0（fight2）骨架冒烟测试（P1）

  P1 的交付物是一个"骨架"：判定条 / 音效 / 结算出口都接通，机制（距离轴 / 体干 /
  AI 权重状态机）留给 P2–P4。骨架测试要守住的不是玩法深度，而是**接线正确性**：
    · 行动力扣除与回合推进；
    · 三档判定真的接进了伤害（不是"有判定但伤害恒定"）；
    · 结果走 afterInter（否则节点数据 / flags / 成就 / 章节卡全都要改）；
    · 跳过战斗这条出口存在（给纯剧情流玩家）；
    · 测试接口 __cs2.fight2.state() 可用（后续 P2–P4 的断言都要靠它）；
    · DOM id 全部另起 —— 旧 #fight 的全局绑定不能把 fight2 的按钮抢走。

  做法：用 tests/lib/extract.cjs 把真实的 startFight2 抽出来，配假 DOM + 排队式 rAF 驱动。

  用法：node tests/fight2.test.cjs
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { readHtml, grabFn, grabConst, grab } = require("./lib/extract.cjs");

const html = readHtml();
let pass = 0;
const fails = [];
function A(ok, name, detail) {
  const line = name + (detail === undefined ? "" : "  [" + detail + "]");
  if (ok) { pass++; console.log("  ✔ " + line); } else { fails.push(line); console.log("  ✖ " + line); }
}

const prelude = `
  const FIGHT_GRADE_MULT = ${grabConst(html, "FIGHT_GRADE_MULT")};
  const FIGHT_FOE_I = ${grabConst(html, "FIGHT_FOE_I")};
  const FIGHT2_MOVES = ${grabConst(html, "FIGHT2_MOVES")};
  ${grabFn(html, "judgeGrade")}
  ${grabFn(html, "mashLoop")}
  ${grabFn(html, "judgeBar")}

  var SFX = [], AFTER = [], LOG = [], RNG = 0.5;
  var CLOCK = 0, FRAME_MS = 1000 / 60, PENDING = [];
  var M = Object.create(Math); M.random = function(){ return RNG; };
  var InputBus = {
    owner:null, _kd:null, _ku:null,
    setOwner(owner, handlers){ this.release(); this.owner = owner; const h = handlers || {};
      if(h.keydown){ this._kd = h.keydown; window.addEventListener("keydown", this._kd); }
      if(h.keyup){ this._ku = h.keyup; window.addEventListener("keyup", this._ku); }
      const self = this; return function(){ if(self.owner === owner) self.release(); }; },
    release(){ if(this._kd){ window.removeEventListener("keydown", this._kd); this._kd = null; }
      if(this._ku){ window.removeEventListener("keyup", this._ku); this._ku = null; } this.owner = null; },
    activeCount(){ return (this._kd?1:0) + (this._ku?1:0); },
  };
  var EL = {};
  function mkEl(id){ if(EL[id]) return EL[id];
    return (EL[id] = { id:id, style:{}, dataset:{}, innerHTML:"", textContent:"",
      scrollTop:0, scrollHeight:0, onclick:null,
      classList:{ _s:{}, add:function(c){this._s[c]=1;}, remove:function(c){delete this._s[c];},
                  contains:function(c){return !!this._s[c];}, toggle:function(c,v){ v?this.add(c):this.remove(c); } },
      addEventListener:function(){}, removeEventListener:function(){},
      click:function(){ if(this.onclick) this.onclick({ stopPropagation:function(){} }); } }); }
  /* querySelectorAll 要返回 fight2 的 6 个按钮 —— startFight2 靠它绑点击。
     这里刻意只认 "#fight2Btns"：正好顺带验证"DOM id 另起"这件事。 */
  var BOUND = [];
  var document = {
    getElementById: function(id){ return mkEl(id); },
    querySelectorAll: function(sel){
      if(sel.indexOf("fight2Btns") < 0) return [];
      return ["jab","combo","low","guard","read","skip"].map(function(a){
        var el = mkEl("btn-" + a); el.dataset.act = a;
        BOUND.push(a); return el;
      });
    },
  };
  function $(id){ return mkEl(id); }
  var __cs2 = {};
  var window = { __cs2:__cs2, addEventListener:function(){}, removeEventListener:function(){} };
  var AudioSys = { good:function(){SFX.push("(beep-good)");}, bad:function(){SFX.push("(beep-bad)");},
    ding:function(){SFX.push("(beep-ding)");}, blip:function(){SFX.push("(beep-blip)");},
    play:function(n){ SFX.push(n); return true; } };
  var S = { stats:{ phy:18 }, fightWon:false };
  function afterInter(fx, why){ AFTER.push({ fx:fx, why:why }); }
  function takeBuff(){ return {}; }
  function bonus(){ return {}; }
  function requestAnimationFrame(cb){ PENDING.push(cb); return 0; }
  var performance = { now:function(){ return CLOCK; } };
  var setTimeout = function(){ return 0; };
`;

let api = null, err = "";
try {
  api = new vm.Script("(function(){\n" + prelude + "\n" + grabFn(html, "startFight2") + "\n" +
    "return { startFight2:startFight2, EL:EL, SFX:SFX, AFTER:AFTER, BOUND:BOUND, S:S,\n" +
    "  step:function(){ var q=PENDING; PENDING=[]; CLOCK+=FRAME_MS;\n" +
    "    for(var i=0;i<q.length;i++) q[i](CLOCK); return q.length; },\n" +
    "  clear:function(){ PENDING.length = 0; SFX.length = 0; },\n" +
    "  setRng:function(v){ RNG=v; }, cs2:function(){ return __cs2; } };\n" +
    "})()").runInNewContext({ console, Math });
} catch (e) { err = e.message + "\n" + (e.stack || "").split("\n").slice(1, 3).join("\n"); }

A(!!api && typeof api.startFight2 === "function", "能从 index.html 抽出真实的 startFight2()", err || "");
if (!api) { console.log("\n[结果] 通过 " + pass + "，失败 " + fails.length + " —— 抽取失败"); process.exit(1); }

const { EL, SFX, AFTER } = api;
const F = () => api.cs2().fight2;
const fightSfx = () => SFX.filter((s) => /^sfx-fight-/.test(s));
const plain = (s) => String(s).replace(/<[^>]+>/g, "");
const lastRow = () => { const r = String(EL.fight2Log.innerHTML).split('<div class="trow">'); return r[r.length - 1] || ""; };
const newFight = (it) => {
  api.clear(); AFTER.length = 0;
  api.startFight2(Object.assign({ type: "fight2", title: "一打二", hp: 74,
    perfect: { phy: 14 }, ok: { phy: 8 }, miss: { phy: 4 } }, it || {}));
};
const cursorPos = () => { const v = parseFloat(EL.fight2Cur.style.left); return isNaN(v) ? 0 : v; };

/** 打一招并把光标推到指定落点。
    ⚠ 推进循环不能在 `cursorPos() < target` 成立时就再走一帧：每帧走 2.2，
      而完美区只有 0.3×14 ≈ 4.2 宽 —— 过冲一帧就掉出完美区了（实测就是这么误判成"良好"的）。
      正确做法：先看**下一帧会不会过头**，会过头就停在当前帧。 */
function strike(kind, pick) {
  api.setRng(0.5);
  SFX.length = 0;
  F().act(kind);
  const L = parseFloat(EL.fight2Zone.style.left), W = parseFloat(EL.fight2Zone.style.width);
  const target = pick(L, W);
  api.step();
  let n = 1;
  while (n < 200 && cursorPos() + 2.2 <= target) { api.step(); n++; }
  const landed = cursorPos();
  if (EL.fight2Bar.style.display !== "none" && typeof EL.fight2Bar.onclick === "function") EL.fight2Bar.click();
  return { landed, zoneL: L, zoneW: W, target: target, sfx: fightSfx(), log: plain(lastRow()) };
}
const wantPerfect = (L, W) => L + W / 2;
const wantGood = (L, W) => L + W * 0.15;
const wantMiss = (L, W) => L + W + 8;

/* ── 1. 接线：DOM id 另起 + 按钮绑定 ── */
newFight();
A(EL.fight2.classList.contains("on"), "fight2 面板已打开");
A(api.BOUND.length === 6, "6 个按钮都绑上了点击（走 #fight2Btns，不是旧的 #fightBtns）",
  api.BOUND.join(","));
A(api.BOUND.indexOf("skip") >= 0, "「跳过战斗」出口存在（给纯剧情流玩家）");
A(typeof F().state === "function", "测试接口 __cs2.fight2.state() 可用");
{
  const st = F().state();
  A(st.hp > 0 && st.foeHp === 74 && st.ap === 3 && st.turn === 1,
    "初始状态：满血 / 对手 74 / 3 行动力 / 第 1 回合", JSON.stringify({ hp: st.hp, foe: st.foeHp, ap: st.ap, turn: st.turn }));
  A(Array.isArray(st.log) && st.log.length >= 1, "state().log 有开场白", JSON.stringify(st.log));
}

/* ── 2. 三档判定真的接进伤害 ── */
{
  newFight();
  const P = strike("jab", wantPerfect);
  A(/完美命中/.test(P.log), "绿区中央 → 完美", "落点 " + P.landed.toFixed(1) + " | " + P.log);
  A(P.sfx.indexOf("sfx-fight-perfect") >= 0, "完美播放 sfx-fight-perfect", JSON.stringify(P.sfx));
  A(/造成 23 伤害/.test(P.log), "完美 ×1.9：直拳 12 → 23");
}
{
  newFight();
  const G = strike("jab", wantGood);
  A(/命中 ×1\.3/.test(G.log), "绿区侧段 → 良好", "落点 " + G.landed.toFixed(1) + " | " + G.log);
  A(G.sfx.indexOf("sfx-fight-hit") >= 0, "良好播放 sfx-fight-hit", JSON.stringify(G.sfx));
  A(/造成 16 伤害/.test(G.log), "良好 ×1.3：直拳 12 → 16");
}
{
  newFight();
  const M = strike("jab", wantMiss);
  A(/偏出/.test(M.log), "绿区外 → 偏出", "落点 " + M.landed.toFixed(1) + " | " + M.log);
  A(M.sfx.indexOf("sfx-fight-whiff") >= 0, "偏出播放 sfx-fight-whiff", JSON.stringify(M.sfx));
  A(/造成 8 伤害/.test(M.log), "偏出 ×0.7：直拳 12 → 8");
}

/* ── 3. 行动力与回合 ── */
{
  newFight();
  A(F().ap === 3, "开局 3 行动力", String(F().ap));
  strike("jab", wantPerfect);
  A(F().ap === 2, "直拳消耗 1 行动力", String(F().ap));
  const hpAfterJab = F().hp;
  strike("low", wantPerfect);                     // 低扫 2 行动力 → 归零 → 自动结束回合
  A(F().turn === 2, "行动力归零 → 自动进入第 2 回合", String(F().turn));
  A(F().ap === 3, "新回合行动力恢复为 3", String(F().ap));
  A(F().hp < hpAfterJab, "对手在这一回合打中了你", hpAfterJab + " → " + F().hp);
  A(F().foeHp < 74, "你的低扫也打中了对手", "foeHp=" + F().foeHp);
}
{
  newFight();
  strike("guard", wantPerfect);
  A(F().guard >= 16, "抱架累计格挡", "guard=" + F().guard);
  A(F().ap === 2, "抱架消耗 1 行动力", String(F().ap));
}
{
  newFight();
  F().act("combo");
  A(F().ap === 1, "组合拳消耗 2 行动力", String(F().ap));
  strike("jab", wantPerfect);                     // 还剩 1 点，能打
  A(F().ap === 3 && F().turn === 2, "再打一记直拳把行动力用完 → 进入第 2 回合",
    "ap=" + F().ap + " turn=" + F().turn);
}
{
  /* 行动力不够时必须被拒（不能白打） */
  newFight();
  strike("low", wantPerfect);                     // ap 3→1
  const before = F().state();
  F().act("low");                                 // 还想要 2 点 → 应被拒
  A(F().ap === before.ap && F().turn === before.turn,
    "行动力不足时出招被拒（不会白打也不会误推进回合）",
    "ap " + before.ap + " → " + F().ap + " turn " + before.turn + " → " + F().turn);
}

/* ── 4. 读招与意图公示 ── */
{
  newFight();
  const before = EL.fight2Foe.innerHTML;
  strike("read", wantPerfect);
  A(F().read === 1, "读招置位", String(F().read));
  A(/（读招生效）/.test(EL.fight2Foe.innerHTML) && EL.fight2Foe.innerHTML !== before,
    "读招后对手意图被公示", plain(EL.fight2Foe.innerHTML));
}

/* ── 5. 组合拳两段 + 连打尾段 ── */
{
  newFight();
  const C = strike("combo", wantPerfect);
  A(/组合拳 · 一段/.test(C.log), "组合拳一段走判定", C.log);
  A(EL.qteMash.style.display === "block", "一段命中 → 连打条打开", String(EL.qteMash.style.display));
}
{
  newFight();
  const C2 = strike("combo", wantMiss);
  A(/连打没接上/.test(plain(EL.fight2Log.innerHTML)), "一段偏出 → 不接连打", plain(EL.fight2Log.innerHTML).slice(-60));
}

/* ── 6. 结算出口：必须走 afterInter（否则节点/flags/成就/章节卡全要改）── */
{
  newFight();
  let g = 0;
  while (F().alive && g++ < 300) strike("jab", wantPerfect);
  A(!F().alive, "战斗能结束", "循环 " + g + " 次");
  A(!EL.fight2.classList.contains("on"), "结束时面板关闭");
  A(AFTER.length === 1, "恰好结算一次（不会重复发奖）", JSON.stringify(AFTER));
  A(AFTER.length === 1 && AFTER[0].fx && AFTER[0].fx.phy !== undefined,
    "结算带上了节点的奖励对象 it.perfect/it.miss", JSON.stringify(AFTER[0] && AFTER[0].fx));
  A(api.S.fightWon === true || AFTER[0].why.indexOf("打倒") >= 0, "胜负记录了 S.fightWon 或走 miss 分支",
    "fightWon=" + api.S.fightWon + " why=" + (AFTER[0] && AFTER[0].why));
  A(fightSfx().indexOf("sfx-fight-win") >= 0 || fightSfx().indexOf("sfx-fight-lose") >= 0,
    "结算音效已播", JSON.stringify(fightSfx().slice(-3)));
}

/* ── 7. 跳过战斗：判据是"谁剩得更少"，不是"对手是否掉到半血" ── */
{
  newFight();
  api.S.fightWon = false;
  F().set({ hp: F().state().maxHp, foeHp: 74 });    // 双方满血
  F().act("skip");
  A(!F().alive && !EL.fight2.classList.contains("on"), "「跳过战斗」能立刻收场");
  A(AFTER.length === 1, "跳过也走 afterInter（一次性）", JSON.stringify(AFTER));
  /* 结算文案与 afterInter 的出口：赢了走 it.perfect，输了走 it.miss。
     这里满血对满血但自己血上限更高（99 vs 74）→ 判赢，走 perfect 分支。 */
  A(AFTER.length === 1 && AFTER[0].fx && AFTER[0].fx.phy === 14,
    "跳过判赢 → 走节点的 perfect 奖励", JSON.stringify(AFTER[0] && AFTER[0].fx));
  A(AFTER.length === 1 && /打赢了/.test(AFTER[0].why), "判赢时文案是「打赢了」", AFTER[0] && AFTER[0].why);
  A(api.S.fightWon === true, "双方满血开打就跳过：自己血更多 → 判赢", "fightWon=" + api.S.fightWon);
}
{
  newFight();
  api.S.fightWon = false;
  F().set({ hp: 20, foeHp: 74 });                   // 自己残血、对手满血
  F().act("skip");
  A(api.S.fightWon === false, "自己残血（比例低于对手）时跳过 → 判输",
    "hp 20/99 vs foe 74/74 → fightWon=" + api.S.fightWon);
  A(AFTER.length === 1 && AFTER[0].fx && AFTER[0].fx.phy === 4,
    "跳过判输 → 走节点的 miss 奖励", JSON.stringify(AFTER[0] && AFTER[0].fx));
  /* 文案方向也要锁：输了不能显示"打赢了"，而且"跳过战斗"要跟着**实际分支**走 */
  A(AFTER.length === 1 && /被打倒了/.test(AFTER[0].why) && !/打赢了/.test(AFTER[0].why),
    "判输时文案是「被打倒了」而不是「打赢了」", AFTER[0] && AFTER[0].why);
  A(AFTER.length === 1 && /跳过战斗/.test(AFTER[0].why),
    "「跳过战斗」标注跟着实际分支走（不会跑到赢的那句上）", AFTER[0] && AFTER[0].why);
}

/* ── 8. 重复结算防护 ── */
{
  newFight();
  F().act("skip"); F().act("skip"); F().act("jab");
  A(AFTER.length === 1, "结算后再操作不会二次发奖", "AFTER=" + AFTER.length);
}

/* ── 9. 判定条收摊：不留监听 ── */
{
  newFight();
  strike("jab", wantPerfect);
  A(EL.fight2Bar.style.display === "none", "落判后判定条隐藏", String(EL.fight2Bar.style.display));
  A(EL.fight2Bar.onclick === null, "落判后 onclick 已清（避免二次落判）", String(EL.fight2Bar.onclick));
}

console.log("");
console.log("[结果] 通过 " + pass + "，失败 " + fails.length + (fails.length ? "" : "，全部通过 ✔"));
if (fails.length) { console.log("失败项："); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fails.length ? 1 : 0);
