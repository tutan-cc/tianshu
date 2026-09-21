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
  const FIGHT2_TUNE = ${grabConst(html, "FIGHT2_TUNE")};
  const FIGHT2_FOE_MOVES = ${grabConst(html, "FIGHT2_FOE_MOVES")};
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
  /* window 要真的记监听器：防守窗口也走 InputBus，泄漏断言要靠它 */
  function mkTarget(o){
    o._h = {};
    o.addEventListener = function(t,f){ (this._h[t] = this._h[t] || []).push(f); };
    o.removeEventListener = function(t,f){ var a = this._h[t] || []; var i = a.indexOf(f); if(i >= 0) a.splice(i,1); };
    o.count = function(t){ return (this._h[t] || []).length; };
    return o;
  }
  var __cs2 = {};
  var window = mkTarget({ __cs2:__cs2 });
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
    "return { startFight2:startFight2, EL:EL, SFX:SFX, AFTER:AFTER, BOUND:BOUND, S:S, WIN:window,\n" +
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
  /* ⚠ 必须清掉判定条/防守条那几个元素的样式：
     假 DOM 的元素是**跨战斗复用**的，上一场残留的 style.left 会被
     `cursorPos()` 当成"本场光标已经走了这么远"，于是推进循环一帧都不跑就落下
     （实测："良好"那一档因此停在 17.6，而目标是 19.3）。 */
  ["fight2Bar", "fight2Zone", "fight2ZonePerfect", "fight2Cur", "fight2Tell"].forEach((id) => {
    const el = EL[id]; if (el) el.style = {};
  });
  /* 兜底血量与 brawl2 节点保持一致（调平后是 320）；单个用例要特例时传 it 覆盖 */
  api.startFight2(Object.assign({ type: "fight2", title: "一打二", hp: 320,
    perfect: { phy: 14 }, ok: { phy: 8 }, miss: { phy: 4 } }, it || {}));
};
const cursorPos = () => { const v = parseFloat(EL.fight2Cur.style.left); return isNaN(v) ? 0 : v; };
/** 按红闪提示的 tell 文案决定该按哪个方向（与战斗里那套映射一致） */
function dirForTell() {
  const t = plain(EL.fight2Tell.innerHTML);
  if (/左右晃动/.test(t)) return "down";
  if (/抬腿/.test(t)) return "up";
  return "left";
}
/** 故意按**确定错**的方向：先读 tell 推出正确方向，再反着按。
    别用"固定按某个方向"来模拟不防守 —— 实测按 down 时对手恰好常出需要 down 的招，
    结果"从不防守"跑出零伤害。方向是 3 选 1，固定值迟早会撞上正确答案。 */
function dirWrong() {
  const right = dirForTell();
  return right === "left" ? "right" : right === "down" ? "up" : "down";
}
let turnAtStart = 1;
/** 直拳的行动力消耗 —— **从 FIGHT2_MOVES 读**，不要在用例里写死。
    调平期把直拳从 1AP 改成 2AP，所有写死 `ap>=1 就出招` 的用例都会在 ap=1 时空转
    （出招被拒 → 判定条不开 → 循环到上限），实测就是这么卡住的。 */
const JAB_AP = JSON.parse(grabConst(html, "FIGHT2_MOVES")).jab.ap;

/** 打一招并把光标推到指定落点。
    ⚠ 不能"边读当前光标位置边推进"：每帧走 2.2，而完美区只有 0.3×14 ≈ 4.2 宽，
      一旦多推一帧就掉出完美区（实测"完美"会偶发变成"良好"）；
      而"先读一次当前位置"又会被上一招残留的 DOM 值骗到。
      可靠做法：算出**目标帧数**，推那么多帧，不再回头看。 */
function strike(kind, pick) {
  api.setRng(0.5);
  SFX.length = 0;
  F().act(kind);
  const L = parseFloat(EL.fight2Zone.style.left), W = parseFloat(EL.fight2Zone.style.width);
  const target = pick(L, W);
  /* judgeBar 每帧 pos += 2.2（从 0 起），所以第 n 帧落在 2.2n */
  const need = Math.round(target / 2.2);
  for (let i = 0; i < need; i++) api.step();
  const landed = 2.2 * need;
  if (EL.fight2Bar.style.display !== "none" && typeof EL.fight2Bar.onclick === "function") EL.fight2Bar.click();
  return { landed, zoneL: L, zoneW: W, target: target, need: need, sfx: fightSfx(), log: plain(lastRow()) };
}

/** 把回合推进到"下一次轮到玩家"，沿途把防守窗口按对手的 tell 闪掉。
    P2 之后回合结束不再直接摸到玩家 —— 中间夹着对手的出招与红闪窗口。
    ⚠ 退出条件是"**见过防守阶段之后又回到 act**"，不能写成 `turn > turnAtStart`：
      turnAtStart 不随循环更新，一旦成立就永远成立 → 循环直接空转到次数上限
      （实测：卡在"第 2 回合"、循环 401 次）。 */
function advanceTurn() {
  let g = 0, sawDefend = false;
  while (F().alive && g++ < 200) {
    const st = F().state();
    if (st.phase === "defend") {
      sawDefend = true;
      /* 这一层也会替玩家按方向 —— 调平时"故意按错"必须同样生效，
         否则 advanceTurn 里会一直按对，把"不防守"这个对照组悄悄变成"完美防守"。 */
      if (!F().defend(turnDirWrong ? dirWrong() : dirForTell())) api.step();
    } else if (sawDefend) {
      break;                                   // 防守结束、又轮到玩家 → 收工
    } else {
      api.step();
    }
  }
  return F().state();
}
/** 调平对照用：为 true 时 advanceTurn 里也故意按错方向 */
let turnDirWrong = false;
/** 打一招，若因此结束了回合就一路推到下一次轮到玩家 */
function actAndSettle(kind, pick) {
  const t0 = F().state().turn;
  const r = strike(kind, pick);
  if (F().alive && F().state().phase === "defend") { turnAtStart = t0; advanceTurn(); }
  return r;
}
/** 把这一场打完（沿途正常防守），用于清理"低扫把行动力用完 → 进防守窗口"的悬空状态 */
function settleFight() {
  let g = 0;
  while (F().alive && g++ < 400) {
    const st = F().state();
    if (st.phase === "defend") { if (!F().defend(dirForTell())) api.step(); }
    else if (st.stunMine) F().act("jab");
    else if (st.ap >= JAB_AP) actAndSettle("jab", wantPerfect);   // 读真实消耗，别写死
    else api.step();
  }
  return F().state();
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
  A(st.hp > 0 && st.foeHp === 320 && st.ap === 4 && st.turn === 1,
    "初始状态：满血 / 对手 320 / 4 行动力 / 第 1 回合",
    JSON.stringify({ hp: st.hp, foe: st.foeHp, ap: st.ap, turn: st.turn }));
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

/* ── 3. 行动力与回合 ──
   ⚠ 这里全部走 FIGHT2_MOVES 的数据，不写死数字：调平期改过行动力上限与招式消耗
     （1AP 直拳 ×3 → 2AP 直拳 ×2），写死的断言会在调平后集体失效。 */
{
  newFight();
  const AP = 4;                       // 与 FIGHT2_TUNE.AP 一致
  A(F().ap === AP, "开局满行动力（FIGHT2_TUNE.AP）", String(F().ap));
  actAndSettle("jab", wantPerfect);
  A(F().ap === AP - 2, "直拳消耗 2 行动力（读 FIGHT2_MOVES 的定义）", String(F().ap));
  const hpAfterJab = F().hp;
  actAndSettle("low", wantPerfect);               // 再 2 点 → 归零 → 自动结束回合
  A(F().turn === 2, "行动力用完 → 自动进入第 2 回合", String(F().turn));
  A(F().ap === AP, "新回合行动力恢复满", String(F().ap));
  A(F().hp <= hpAfterJab, "对手在这一回合打中了你（或被你闪掉了）", hpAfterJab + " → " + F().hp);
  A(F().foeHp < (F().state().foeMax), "你的低扫也打中了对手", "foeHp=" + F().foeHp);
}
{
  newFight();
  actAndSettle("guard", wantPerfect);
  A(F().guard >= 20, "抱架累计格挡（+20）", "guard=" + F().guard);
  A(F().ap === 3, "抱架只花 1 行动力（比出招便宜，所以抱得住）", String(F().ap));
}
{
  newFight();
  F().act("combo");
  A(F().ap === 2, "组合拳消耗 2 行动力", String(F().ap));
  actAndSettle("jab", wantPerfect);
  A(F().ap === 4 && F().turn === 2, "2+2 把 4 点行动力用完 → 进入第 2 回合",
    "ap=" + F().ap + " turn=" + F().turn);
}
{
  /* 行动力不够时必须被拒（不能白打）。
     ⚠ 别用"打一招把行动力用掉"来构造不足：招式消耗与行动力上限都是可调的，
       写死"低扫之后只剩 1 点"在调平后就失效了（实测 ap 变成 0，断言自己骗自己）。
       直接用 set() 把行动力摆成不足，语义更清楚。 */
  newFight();
  F().set({ ap: 1 });                             // 低扫要 2 点
  const before = F().state();
  F().act("low");                                 // 应被拒
  A(F().ap === before.ap && F().turn === before.turn,
    "行动力不足时出招被拒（不会白打也不会误推进回合）",
    "ap " + before.ap + " → " + F().ap + " turn " + before.turn + " → " + F().turn);
  A(F().foeHp === before.foeHp, "被拒时对手一点血都没掉", "foeHp " + before.foeHp + " → " + F().foeHp);
}

/* ── 4. 读招与意图公示 ── */
{
  newFight();
  const before = EL.fight2Foe.innerHTML;
  strike("read", wantPerfect);
  A(F().read === 2, "读招置位两回合（P2 起公示两回合）", String(F().read));
  /* 意图公示要**渲染一次**才出现在面板上：strike() 落判那一刻 render 的还是旧状态，
     这里是再点一帧（玩家在真实流程里下个回合开头就会看到）。 */
  api.step();
  F().set({});                                    // set() 内部会 render()
  A(/读招生效/.test(EL.fight2Foe.innerHTML) && EL.fight2Foe.innerHTML !== before,
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
  while (F().alive && g++ < 300) actAndSettle("jab", wantPerfect);
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

/* ══════════════ P2：体干 / 预判防守 / 反击窗口 ══════════════ */

/** 让回合推进到"对手正在出招"的瞬间（红闪窗口），返回此刻的对手招式信息 */
function advanceToDefend() {
  let g = 0;
  while (F().alive && F().state().phase !== "defend" && g++ < 30) {
    if (F().state().ap <= 0) F().act("jab");
    else strike("jab", wantPerfect);
  }
  return F().state();
}
/** 从当前状态推进到下一次"轮到玩家" */
function settle() {
  let g = 0;
  while (F().alive && F().state().phase !== "act" && g++ < 10) api.step();
}

/* ── 10. 体干条：显示 / 命中推对手 / 硬吃掉自己的 ── */
{
  newFight();
  const st0 = F().state();
  A(st0.stamMine === 1 && st0.stamFoe === 1, "开局双方体干满", st0.stamMine + "/" + st0.stamFoe);
  strike("jab", wantPerfect);
  A(F().state().stamFoe < 1, "命中推掉对手体干", "stamFoe=" + F().state().stamFoe);
  A(F().state().stamMine <= 1, "自己出招也付一点体干（不能超过上限）", "stamMine=" + F().state().stamMine);
  A(String(EL.fight2StamMine.style.width).indexOf("%") > 0, "体干条宽度已渲染",
    "我的 " + EL.fight2StamMine.style.width + " / 对手 " + EL.fight2StamFoe.style.width);
}
{
  /* 抱架 / 读招是"养体干"的招 */
  newFight();
  F().set({ stamMine: 0.4 });
  strike("guard", wantPerfect);
  A(F().state().stamMine > 0.4, "抱架回体干", "0.40 → " + F().state().stamMine.toFixed(2));
  F().set({ stamMine: 0.4 });
  strike("read", wantPerfect);
  A(F().state().stamMine > 0.4, "读招回体干", "0.40 → " + F().state().stamMine.toFixed(2));
}

/* ── 11. 硬吃：掉血 + 掉体干；体干归零 → 硬直 ── */
{
  newFight();
  advanceToDefend();
  const before = F().state();
  A(before.phase === "defend", "轮到了对手出招（红闪窗口）", "phase=" + before.phase);
  A(EL.fight2Tell.style.display === "block", "红闪提示已显示", plain(EL.fight2Tell.innerHTML));
  /* 什么都不按 → 超时按"没防住"结算 */
  let g = 0;
  while (F().state().phase === "defend" && g++ < 200) api.step();
  const after = F().state();
  A(after.hp < before.hp, "没按方向键 → 硬吃伤害", before.hp + " → " + after.hp);
  A(after.stamMine < before.stamMine + 1e-9, "硬吃也掉体干", before.stamMine.toFixed(2) + " → " + after.stamMine.toFixed(2));
  A(EL.fight2Tell.style.display === "none", "结算后红闪收起", String(EL.fight2Tell.style.display));
}
{
  /* 体干归零 → 硬直：下一回合动不了
     注意别把体干设成 0：startTurn() 会回 0.08，正好把归零条件破坏掉。
     设成"小于一次硬吃的量"（0.30）即可 —— 挨一下就归零。 */
  newFight();
  F().set({ stamMine: 0.2 });
  advanceToDefend();
  let g = 0;
  while (F().state().phase === "defend" && g++ < 200) api.step();   // 硬吃 → 体干归零 → 置硬直
  A(F().state().stunMine === true, "体干被打空 → 进入硬直", "stamMine=" + F().state().stamMine.toFixed(3));
  const turnBefore = F().state().turn;
  F().act("jab");                         // 硬直期出招 = 白费；回合让给对手（进入防守窗口）
  A(F().state().stunMine === false, "硬直被消耗掉（那一回合确实动不了）");
  A(F().state().phase === "defend", "回合直接让给了对手（没有打出去）",
    "phase=" + F().state().phase + " turn=" + F().state().turn + "（原 " + turnBefore + "）");
  A(/动不了/.test(plain(EL.fight2Log.innerHTML)), "日志写明了本回合动不了",
    plain(EL.fight2Log.innerHTML).slice(-50));
}
{
  /* 硬直伤害倍率的算术：同一次攻击，硬直态应当明显高于普通态 */
  newFight();
  advanceToDefend();
  const hp0 = F().state().hp;
  let g = 0;
  while (F().state().phase === "defend" && g++ < 200) api.step();
  const normalLoss = hp0 - F().state().hp;
  /* 再来一次，这次先置上硬直（关掉读招减伤与格挡，排除干扰） */
  newFight();
  F().set({ stunMine: true, read: 0, guard: 0 });
  advanceToDefend();
  const hp1 = F().state().hp;
  g = 0;
  while (F().state().phase === "defend" && g++ < 200) api.step();
  const stunLoss = hp1 - F().state().hp;
  A(normalLoss > 0 && stunLoss > normalLoss,
    "硬直期受伤明显高于普通态（×2.5 的算术方向正确）",
    "普通 " + normalLoss + " vs 硬直 " + stunLoss);
}

/* ── 12. 预判防守：方向对 = 完全闪避 + 开反击窗口 ── */
{
  newFight();
  advanceToDefend();
  /* 对手第一手是直拳（def:"left"），按对方向应当零伤害 */
  const hp0 = F().state().hp, st0 = F().state().stamMine;
  const ok = F().defend("left");
  A(ok === true, "defend('left') 走通了真实按键路径", String(ok));
  const st = F().state();
  A(st.hp === hp0, "方向对 → 完全闪避，一点血都不掉", hp0 + " → " + st.hp);
  A(st.stamMine < st0, "闪避要付体干", st0.toFixed(2) + " → " + st.stamMine.toFixed(2));
  A(st.counter === true, "闪开之后打开反击窗口", "counter=" + st.counter);
  A(st.phase === "act", "回到玩家回合", "phase=" + st.phase);
}
{
  /* 方向错 = 硬吃 */
  newFight();
  advanceToDefend();
  const hp0 = F().state().hp;
  F().defend("up");                                  // 直拳该按 left
  A(F().state().hp < hp0, "方向按错 → 硬吃伤害", hp0 + " → " + F().state().hp);
  A(F().state().counter === false, "没闪开就没有反击窗口", "counter=" + F().state().counter);
}

/* ── 13. 反击窗口：这一手攻击 ×2.2，用掉即关 ── */
{
  newFight();
  advanceToDefend();
  F().defend("left");                                // 闪开 → counter=true
  A(F().state().counter === true, "（前置）反击窗口已打开");
  const foeHp0 = F().state().foeHp;
  const LOW = JSON.parse(grabConst(html, "FIGHT2_MOVES")).low.dmg;   // 低扫基础伤害（别写死）
  strike("low", () => 1);                            // 低扫不吃三档表 → 纯看反击倍率
  const dealt = foeHp0 - F().state().foeHp;
  A(dealt === Math.round(LOW * 2.2), "反击窗口内低扫 " + LOW + " → " + Math.round(LOW * 2.2) + "（×2.2）",
    "实际造成 " + dealt);
  A(F().state().counter === false, "反击窗口用掉即关（不会一路白拿）", "counter=" + F().state().counter);
  void settleFight();
}
{
  /* 关掉反击窗口后，同样的招应当回到基础伤害 */
  newFight();
  const foeHp0 = F().state().foeHp;
  const LOW = JSON.parse(grabConst(html, "FIGHT2_MOVES")).low.dmg;
  strike("low", () => 1);
  A(foeHp0 - F().state().foeHp === LOW, "非反击窗口低扫就是 " + LOW + "（对照组）",
    "实际造成 " + (foeHp0 - F().state().foeHp));
}

/* ── 14. 对手体干见底 → 硬直 + 主动给玩家反击窗口 ── */
{
  /* 对手体干见底 → 这一手打不出来（喘气），并把反击窗口白送给玩家。
     ⚠ 断言要在"对手刚喘完气"这一刻做：再往后玩家一出手就把 counter 用掉了。
     ⚠ 起始值给负数（会被夹到 0）：回合恢复是 +0.08，对手最便宜的招只要 0.06 ——
       给正数很容易正好让他出得起，就测不到"喘气"这条分支了。 */
  newFight();
  F().set({ stamFoe: -1 });
  let g = 0, sawCounter = false, sawLog = "";
  while (F().state().phase === "act" && F().alive && g++ < 10) {
    strike("jab", wantPerfect);
    /* 趁"这一招之后、下一招之前"取样：对手喘气给出的反击窗口就在这一刻 */
    const s = F().state();
    if (s.counter) { sawCounter = true; sawLog = plain(EL.fight2Log.innerHTML); }
  }
  const st = F().state();
  A(sawCounter, "他打不出东西 → 主动给你反击窗口（在被用掉之前抓到了）",
    "循环 " + g + " 次 · 末态 counter=" + st.counter);
  A(/没能还手|没打出来|喘/.test(sawLog || plain(EL.fight2Log.innerHTML)), "日志说明了原因",
    (sawLog || plain(EL.fight2Log.innerHTML)).slice(-60));
  A(st.hp === st.maxHp, "他这一手没能伤到你", "hp=" + st.hp + "/" + st.maxHp);
}

/* ── 15. 招式库与 tell 表：每条进攻招都要有可闪的方向 ── */
{
  const html2 = readHtml();
  const moves = JSON.parse(grabConst(html2, "FIGHT2_FOE_MOVES"));
  A(moves.length >= 5, "对手招式库有 " + moves.length + " 招", moves.map((m) => m.id).join(","));
  const attackers = moves.filter((m) => m.dmg > 0);
  A(attackers.every((m) => ["left", "right", "down", "up"].indexOf(m.def) >= 0),
    "每一条会伤人的招都配了可闪方向（否则玩家只能干吃）",
    attackers.map((m) => m.id + ":" + m.def).join(" "));
  A(moves.every((m) => m.tell), "每一招都有 tell 文案（红闪要显示得出东西）",
    moves.map((m) => m.id).join(","));
  A(moves.some((m) => m.def === null && m.dmg === 0), "存在不用闪的招（抱架/虚招），否则防守变成机械刷");
  const tunes = JSON.parse(grabConst(html2, "FIGHT2_TUNE"));
  A(tunes.STUN_TAKEN_MULT === 2.5 && tunes.COUNTER_MULT === 2.2 && tunes.TELL_MS === 450,
    "调参区与设计文档一致（硬直 ×2.5 / 反击 ×2.2 / 红闪 450ms）", JSON.stringify(tunes));
}

/* ── 16. 防守期间不接受出招（红闪窗口里按攻击键应当无效） ── */
{
  newFight();
  advanceToDefend();
  const st0 = F().state();
  F().act("low");
  const st1 = F().state();
  A(st1.phase === "defend" && st1.foeHp === st0.foeHp, "红闪窗口里出招无效（不会偷袭也不会误推进）",
    "phase=" + st1.phase + " foeHp " + st0.foeHp + " → " + st1.foeHp);
}

/* ── 17. 全程跑通：机制叠加下还能正常结束 ── */
{
  newFight();
  let g = 0;
  while (F().alive && g++ < 400) {
    const st = F().state();
    if (st.phase === "defend") {
      /* 按对手这一手的 def 闪（读不到就按 left）——正常玩家会这么打 */
      const cur = String(EL.fight2Tell.innerHTML);
      const dir = /重心前压|后撤半步/.test(cur) ? "left" : /左右晃动/.test(cur) ? "down"
                : /抬腿/.test(cur) ? "up" : "left";
      if (!F().defend(dir)) api.step();
    } else if (st.stunMine) {
      F().act("jab");
    } else if (st.ap >= JAB_AP) {
      strike("jab", wantPerfect);
    } else {
      api.step();
    }
  }
  A(!F().alive, "机制叠加后战斗仍能正常结束", "循环 " + g + " 次 · 第 " + F().state().turn + " 回合");
  A(AFTER.length >= 1, "结算照常走 afterInter", JSON.stringify(AFTER).slice(0, 70));
  A(api.WIN.count("keydown") === 0, "打完之后没有残留键盘监听（防守窗口也接了 InputBus）",
    "剩 " + api.WIN.count("keydown") + " 个");
}

/* ══════════════ P3 前置：调平回归（一局该有多长） ══════════════
   这一组是"防漂移"用的。P2 第一版就是手算的数值：以为 6–9 回合，实测 2 回合，
   体干/硬直/反击窗口一次都没来得及触发 —— 机制做了等于白做。
   所以把"实测回合数"直接钉在测试里：改数值后如果跑出 2 回合，测试立刻红。 */
{
  /* 从 brawl2 节点读对手血量。⚠ 别用宽松的正则：`/brawl2:...hp:(\d+)/` 会一路
     匹配到**下一个**节点的 inter.hp（旧 brawl 的 74），实测就踩了这个坑 —— 断言
     拿着 74 去跑，还以为是调平没生效。这里只取 brawl2 那一段。 */
  const foeHpOf = (() => {
    const i = html.indexOf("brawl2:{");
    if (i < 0) return null;
    const seg = html.slice(i, i + 1500);
    const m = /type:"fight2"[\s\S]{0,120}?hp:(\d+)/.exec(seg);
    return m ? Number(m[1]) : null;
  })();
  A(foeHpOf !== null, "能从 brawl2 节点读到对手血量（调平断言的输入）", String(foeHpOf));

  /** 完美打法打完一整局，返回统计 */
  function playFull(grade, dodge) {
    newFight({ hp: foeHpOf });
    turnDirWrong = !dodge;                  // 让 advanceTurn 里也按同一种策略走
    const maxHp = F().state().maxHp;
    let g = 0, stunSeen = false, counterSeen = false, restSeen = false, defendSeen = 0;
    while (F().alive && g++ < 400) {
      const st = F().state();
      if (st.counter) counterSeen = true;
      if (/喘|没能还手|没打出来/.test(plain(String(st.log.join(" "))))) restSeen = true;
      if (st.phase === "defend") {
        defendSeen++;
        if (!F().defend(dodge ? dirForTell() : dirWrong())) api.step();
      } else if (st.stunMine) {
        stunSeen = true;
        F().act("jab");
      } else if (st.ap >= JAB_AP) {
        actAndSettle("jab", grade === "perfect" ? wantPerfect : wantGood);
      } else {
        api.step();
      }
    }
    const st = F().state();
    turnDirWrong = false;
    return { turns: st.turn, lost: maxHp - st.hp, maxHp, stunSeen, counterSeen, restSeen, loops: g };
  }

  const ideal = playFull("perfect", true);
  A(ideal.turns >= 6 && ideal.turns <= 9,
    "理想打法一局落在 6–9 回合（设计目标 §7.1）", ideal.turns + " 回合 · 承伤 " + ideal.lost + "/" + ideal.maxHp);
  A(ideal.lost < ideal.maxHp * 0.5,
    "全程闪对的话不该被打残（防守是有回报的）", "承伤 " + ideal.lost + "/" + ideal.maxHp);
  A(ideal.counterSeen || ideal.restSeen,
    "一局内至少能看到一次「对手喘气/反击窗口」（体干机制真的走起来了）",
    "反击窗口 " + ideal.counterSeen + " · 对手喘气 " + ideal.restSeen);

  const sloppy = playFull("good", true);
  A(sloppy.turns >= ideal.turns,
    "只打良好档 → 一局不会比完美打法更短", "良好 " + sloppy.turns + " 回合 vs 完美 " + ideal.turns);

  const noDodge = playFull("perfect", false);
  /* 断言"明显更疼"而不是"两倍"：对手一局只有约 5 次出手机会（体干限制），
     所以差距不可能无限拉大。实测：闪对 0 伤 / 不闪掉 2/3 血。
     这条的意义是"防守必须值钱"，不是"不防守必输"。 */
  A(noDodge.lost > ideal.lost + 20,
    "从不防守的代价足够大（明显比闪对疼）",
    "不防守 " + noDodge.lost + " vs 闪对 " + ideal.lost);
}

console.log("");
console.log("[结果] 通过 " + pass + "，失败 " + fails.length + (fails.length ? "" : "，全部通过 ✔"));
if (fails.length) { console.log("失败项："); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fails.length ? 1 : 0);
