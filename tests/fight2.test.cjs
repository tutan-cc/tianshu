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
const { readHtml, grabFn, grabConst, grab, evalConstIn, serialize } = require("./lib/extract.cjs");

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
  /* 真实的侧视舞台（P3）。必须用 evalConstIn 而不是 JSON.parse(grabConst(...))：
     它是个含方法的对象字面量，序列化会丢掉方法。 */
  const Fight2Stage = ${serialize(evalConstIn(html, "Fight2Stage"))};

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

  /* ── 记账用的桩 canvas 2D ──────────────────────────────────────────────
     为什么需要：P3 的断言全是"机制是否驱动了画面"。真浏览器里没法自动断言，
     无头环境又没有 canvas，所以这里放一个**只记账不画画**的 2D 上下文：
       · PIX  = 被写过的像素包围盒（用来问"到底画了东西没有"）
       · IMGS = 每次 drawImage 的目标矩形（用来钉住立绘的缩放/贴地/居中几何）
     舞台里所有绘制调用都被 try/catch 包着（拿不到 2D 上下文就只跑状态机），
     所以桩不需要画得对，只要存在且能被调用。 */
  var PIX = { minX: 1e9, maxX: -1, minY: 1e9, maxY: -1, n: 0 };
  var IMGS = [];
  function px(x, y){ if(x<PIX.minX)PIX.minX=x; if(x>PIX.maxX)PIX.maxX=x;
                     if(y<PIX.minY)PIX.minY=y; if(y>PIX.maxY)PIX.maxY=y; PIX.n++; }
  var FAKE_CTX = (function(){
    var M = [1,0,0,1,0,0], st = [];
    var tf = function(x,y){ return [M[0]*x+M[2]*y+M[4], M[1]*x+M[3]*y+M[5]]; };
    var grad = { addColorStop:function(){} };
    return {
      globalAlpha:1, fillStyle:"#000", strokeStyle:"#000", lineWidth:1, font:"12px x",
      lineCap:"butt", lineJoin:"miter", textAlign:"left", textBaseline:"alphabetic",
      save:function(){ st.push([M.slice(), this.globalAlpha]); },
      restore:function(){ var s=st.pop(); if(s){ M=s[0]; this.globalAlpha=s[1]; } },
      setTransform:function(a,b,c,d,e,f){ M=[a,b,c,d,e,f]; },
      translate:function(x,y){ M=[M[0],M[1],M[2],M[3],M[4]+M[0]*x+M[2]*y,M[5]+M[1]*x+M[3]*y]; },
      scale:function(x,y){ M=[M[0]*x,M[1]*x,M[2]*y,M[3]*y,M[4],M[5]]; },
      clearRect:function(){}, beginPath:function(){}, moveTo:function(){}, lineTo:function(){},
      closePath:function(){}, arc:function(){}, ellipse:function(){}, rect:function(){},
      createLinearGradient:function(){ return grad; }, createRadialGradient:function(){ return grad; },
      measureText:function(t){ return { width:String(t).length*8 }; },
      fillRect:function(x,y){ var p=tf(x,y); px(p[0],p[1]); },
      strokeRect:function(x,y){ var p=tf(x,y); px(p[0],p[1]); },
      fill:function(){}, stroke:function(){},
      fillText:function(t,x,y){ var p=tf(x,y); px(p[0],p[1]); },
      strokeText:function(t,x,y){ var p=tf(x,y); px(p[0],p[1]); },
      drawImage:function(img,dx,dy,dw,dh){
        var a=tf(dx,dy), b=tf(dx+dw,dy+dh);
        IMGS.push({ img:img, dw:dw, dh:dh, x0:Math.min(a[0],b[0]), x1:Math.max(a[0],b[0]),
                    y0:Math.min(a[1],b[1]), y1:Math.max(a[1],b[1]) });
        px(a[0],a[1]); px(b[0],b[1]);
      },
    };
  })();
  /* 桩画布要**够高**：陈默缩放后身高 445px，而舞台默认 GROUND=700、H=900 ——
     立绘头顶会跑到画布外（真浏览器里同样偏上，但这里会让几何断言更难读）。
     把地面线放到 720、画布放到 1080，人物完整落进来，量出来的数字才可信。 */
  var FAKE_CV = { width:1680, height:1080, style:{}, getContext:function(){ return FAKE_CTX; },
    addEventListener:function(){}, removeEventListener:function(){} };
  /* 假立绘：真浏览器里这是 Image.onload 之后才 ready 的东西。
     默认**不装**（保住"无头环境没有真 Image → 走骨骼回落"这条真实路径），
     要测立绘分支时显式装。 */
  function fakeSprite(w, h){ return { width:w, height:h, naturalWidth:w, naturalHeight:h }; }
`;

let api = null, err = "";
try {
  api = new vm.Script("(function(){\n" + prelude + "\n" + grabFn(html, "startFight2") + "\n" +
    "return { startFight2:startFight2, EL:EL, SFX:SFX, AFTER:AFTER, BOUND:BOUND, S:S, WIN:window,\n" +
    "  Stage:Fight2Stage, PIX:PIX, IMGS:IMGS, FAKE_CV:FAKE_CV, fakeSprite:fakeSprite,\n" +
    "  step:function(){ var q=PENDING; PENDING=[]; CLOCK+=FRAME_MS;\n" +
    "    for(var i=0;i<q.length;i++) q[i](CLOCK); return q.length; },\n" +
    "  clear:function(){ PENDING.length = 0; SFX.length = 0; },\n" +
    "  setRng:function(v){ RNG=v; }, cs2:function(){ return __cs2; } };\n" +
    "})()").runInNewContext({ console, Math });
} catch (e) { err = e.message + "\n" + (e.stack || "").split("\n").slice(1, 3).join("\n"); }

A(!!api && typeof api.startFight2 === "function", "能从 index.html 抽出真实的 startFight2()", err || "");
if (!api) { console.log("\n[结果] 通过 " + pass + "，失败 " + fails.length + " —— 抽取失败"); process.exit(1); }

const { EL, SFX, AFTER, fakeSprite } = api;
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
  /* 跳过"化身进街机"的片头：测试是手动推帧的，片头期间出招会被**设计性**地挡掉，
     不跳过的话所有出招类断言都会被静默挡掉（片头本身另有专项用例）。 */
  api.Stage.arcadeOn = false; api.Stage.arcade = 0;
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
  /* 体干条不再用 DOM 进度条了（P3 改成 canvas HUD，见 Fight2Stage.drawHud）：
     这里验的是"状态同步进舞台了"，画面本身另有无头舞台用例负责。 */
  api.Stage.begin(api.FAKE_CV); api.Stage.running = false;
  api.Stage.sync({ hp: F().state().hp, maxHp: F().state().hp, foeHp: F().state().foeHp, foeMax: 320,
    stamMine: F().state().stamMine, stamFoe: F().state().stamFoe, turn: F().state().turn,
    ap: F().state().ap, phase: "act" });
  const hud = api.Stage.debugState();
  A(hud.stamMine !== null && hud.stamFoe !== null && hud.stamFoe < 1,
    "体干已同步进 canvas HUD（不再是 DOM 进度条）",
    "我的 " + hud.stamMine + " / 对手 " + hud.stamFoe);
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

/* ── P3：侧视舞台（造型 / 姿势表 / 立绘 / 街机过场）──────────────────────
   一条元断言先钉住"能力存在"：本会话发生过一次测试文件被编码事故毁掉、恢复成旧版的事，
   旧版里根本没有 Fight2Stage 导出，后面这些用例会整段静默消失而测试仍然"全绿"。
   所以先显式要求舞台 API 在，缺了就报出来。 */
A(!!api.Stage && typeof api.Stage.frameOnce === "function" && typeof api.Stage.debugState === "function",
  "舞台 API 已导出（frameOnce / debugState）—— 缺少它说明这批 P3 用例被整段丢掉了",
  api.Stage ? Object.keys(api.Stage).length + " 个键" : "api.Stage 不存在");

/** 手动推帧（测试环境没有 rAF 循环；帧定时器靠 step() 模拟出的 PENDING 队列） */
function stageStep(n) { for (let i = 0; i < n; i++) { api.step(); api.Stage.frameOnce(); } }


{
  newFight();
  const s0 = F().stage();
  A(s0.running === true && s0.frame >= 1, "舞台跟着战斗一起跑（begin 后至少画过一帧）",
    "running=" + s0.running + " frame=" + s0.frame);
}
{
  /* 命中 → 火花 + 顿帧 + 对手受击姿势 */
  newFight();
  strike("jab", wantPerfect);
  /* ⚠ 推帧数要**卡在火花寿命之内**：打击的顿帧（12 帧）会冻结 step()，火花是顿帧之后才诞生的；
     而火花寿命只有 14~24 帧。推 30 帧 = 先冻结 12 帧、再让火花烧完，于是读到 fx=0 ——
     那不是"没有特效"，是"特效已经演完了"（实测 fxCount=1 而 fx=0）。推 8 帧刚好。 */
  stageStep(8);
  const s1 = F().stage();
  A(s1.fx > 0, "命中产生命中特效（火花/扩散环）",
    "fx=" + s1.fx + " fxCount=" + s1.fxCount + " hitstop=" + s1.hitstop);
  A(s1.mePose && s1.mePose.armF > 0.5, "出招时前手伸出（姿势被驱动了）", JSON.stringify(s1.mePose));
}
{
  /* 偏出 → 不该有火花 */
  newFight();
  strike("jab", wantMiss);
  const s2 = F().stage();
  A(s2.fx === 0, "偏出没有命中特效（空挥就是空挥）", "fx=" + s2.fx);
  A(s2.hitstop === 0, "偏出没有顿帧", "hitstop=" + s2.hitstop);
}
{
  /* 挨打 → 玩家侧也有火花与受击姿势。
     ⚠ 用**单调累加器** fxCount 判断，不要比较 fx 数组长度：粒子有生命周期，
       before/after 之间老粒子会被回收，实测出现过 25 → 25 的假失败。 */
  newFight();
  advanceToDefend();
  api.Stage.after.length = 0;
  api.Stage.pose("foe", "strike");
  api.Stage.fx.length = 0;
  const before = F().stage().fxCount, beforeLive = F().stage().fx;
  let g = 0;
  while (F().state().phase === "defend" && g++ < 200) api.step();   // 不按方向 → 硬吃
  const s3 = F().stage();
  A(s3.fxCount > before, "挨打也会产生命中特效", "fxCount " + before + " → " + s3.fxCount);
  A(s3.fx > beforeLive, "挨打这一击的火花还活在场上", "fx " + beforeLive + " → " + s3.fx);
  A(s3.hitstop > 0, "挨打也有顿帧", "hitstop=" + s3.hitstop);
  A(s3.mePoseName === "hit" || s3.mePoseName === "idle", "受击后玩家姿势切到了受击/待机档",
    "mePoseName=" + s3.mePoseName);
}
{
  /* 结算 → KO 横幅 + 输家倒地 + 相机推近 + 演完自停 */
  newFight();
  let g = 0;
  while (F().alive && g++ < 400) actAndSettle("jab", wantPerfect);
  const s4 = F().stage();
  A(s4.ko > 0 && s4.koText === "K.O.", "打赢 → 舞台打出 K.O. 横幅", JSON.stringify({ ko: s4.ko, text: s4.koText }));
  A(s4.zoom > 1, "结算时相机推近", "zoom=" + s4.zoom);
  stageStep(180);
  A(api.Stage.running === false, "演出结束后舞台停止（不留 rAF 循环）", "running=" + api.Stage.running);
}
{
  /* 两个角色的造型与体型/姿势表都要**分开**，否则"一打二"的两个人会长得一样 */
  const B = evalConstIn(html, "Fight2Stage");
  const bodies = B.BODIES || {}, poses = B.POSES || {};
  A(!!(bodies.player && bodies.brawler && bodies.player.hi > bodies.brawler.hi
      && bodies.brawler.torso > bodies.player.torso && bodies.brawler.arm > bodies.player.arm
      && bodies.brawler.spread > bodies.player.spread && bodies.brawler.shoulder > bodies.player.shoulder),
    "体型参数按角色分开且方向正确（高瘦 vs 矮壮）",
    JSON.stringify({ player: bodies.player, brawler: bodies.brawler }).slice(0, 130));
  A(!!(poses.player && poses.brawler && poses.player.strike && poses.brawler.strike),
    "姿势表按角色分开（player / brawler 各 5 套）",
    Object.keys(poses).map((k) => k + ":" + Object.keys(poses[k]).length).join(" "));
  A(poses.brawler.strike.step > poses.player.strike.step && poses.brawler.strike.lean > poses.player.strike.lean,
    "同一个「出拳」两人幅度不同：莽夫冲得更远、倾得更多",
    "step " + poses.player.strike.step + " vs " + poses.brawler.strike.step);
  A(poses.brawler.ko.crouch > poses.player.ko.crouch, "倒地幅度也不同：莽夫躺得更平",
    poses.player.ko.crouch + " vs " + poses.brawler.ko.crouch);
  A(B.SPRITE_META && B.SPRITE_META.puncher && B.SPRITE_META.brawler
      && B.SPRITE_META.puncher.standH > 0 && B.SPRITE_META.brawler.standH > 0,
    "立绘元数据（standH / lowY）两套都在 —— 缺了就只能按各图拉高、倒地会被放大 3 倍",
    JSON.stringify({ puncher: B.SPRITE_META.puncher.standH, brawler: B.SPRITE_META.brawler.standH }));

  /* ── 配色也按角色分：莽夫暖红系、陈默冷蓝系，都保留轮廓光 ──
     断言"两个色系真的不同"而不是写死具体色值：调色是策划的活，
     但"红蓝不能撞成一样"和"轮廓光不能丢"是设计约束。 */
  const pal = B.PALETTE || {};
  A(!!(pal.player && pal.brawler && pal.player.near && pal.brawler.near),
    "配色表按角色分开（player / brawler 各有远/近两档）",
    Object.keys(pal).map((k) => k + ":" + (pal[k].label || "?")).join(" "));
  if (pal.player && pal.brawler) {
    /* 色相判据：暖色 R > B，冷色 B > R —— 用分量关系而不是具体色号，调色时不会误报 */
    const hue = (hex) => {
      const h = String(hex).replace("#", "");
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    };
    const bEdge = hue(pal.brawler.near.edge), pEdge = hue(pal.player.near.edge);
    A(bEdge[0] > bEdge[2] && pEdge[2] > pEdge[0],
      "莽夫是暖色系（轮廓光 R>B）、陈默是冷色系（B>R）",
      "莽夫 rgb(" + bEdge + ") vs 陈默 rgb(" + pEdge + ")");
    A(pal.brawler.near.edge !== pal.player.near.edge,
      "两人的轮廓光色值不同（一眼能分辨的关键）",
      pal.brawler.near.edge + " vs " + pal.player.near.edge);
    /* 远/近两档必须不同：两个人画在同一平面上，同色会糊成一坨 */
    A(pal.brawler.far.main !== pal.brawler.near.main && pal.player.far.main !== pal.player.near.main,
      "每个角色内部还分远/近两档明度（手臂叠一起不会糊）",
      "莽夫 " + pal.brawler.far.main + "→" + pal.brawler.near.main);
    A(typeof B.palOf === "function" && B.palOf("brawler").near.edge === pal.brawler.near.edge
        && B.palOf("没这个角色").near.edge === pal.player.near.edge,
      "palOf() 能按角色取色，未知角色回落到玩家那套",
      typeof B.palOf === "function" ? "有 palOf" : "没有 palOf");
  }
}

{
  /* 运行时验证"姿势切换走的是**各自那套**" —— 不是"两张表存在"而已。
     同一个「出拳」：莽夫的 lean/step 明显大于陈默（大开大合 vs 紧凑收敛）。
     注意不能用骨骼像素去比（两人 x 不同、体型不同，数字没法直接比），
     直接比**姿势值**才是这条设计约束本身。 */
  newFight();
  const S = api.Stage;
  S.pose("me", "strike"); S.pose("foe", "strike");
  S.frameOnce();
  const st = S.debugState();
  A(st.mePoseName === "strike" && st.foePoseName === "strike",
    "双方都切到 strike 档", st.mePoseName + " / " + st.foePoseName);
  const T = evalConstIn(html, "Fight2Stage").POSES;
  /* 姿势是**插值**过去的（`pose()` 只设目标），所以要推够帧数才收敛到目标值 */
  stageStep(90);
  const s2 = S.debugState();
  A(Math.abs(s2.foeLean - T.brawler.strike.lean) < 0.02 && Math.abs(s2.meLean - T.player.strike.lean) < 0.02,
    "同一个出拳档，两人各自收敛到**自己表里**的 lean",
    "莽夫 " + s2.foeLean + "（表 " + T.brawler.strike.lean + "）· 陈默 " + s2.meLean + "（表 " + T.player.strike.lean + "）");
  A(s2.foeStep > s2.meStep, "莽夫冲得更远（各自表里的 step 不同）",
    "step " + s2.foeStep + " vs " + s2.meStep);
  /* 反差要够"一眼"：幅度差至少 1.5 倍，否则玩家分不出风格 */
  A(T.brawler.strike.lean > T.player.strike.lean * 1.5 && T.brawler.strike.step > T.player.strike.step * 1.5,
    "两个角色的动作幅度差 ≥1.5 倍（大开大合 vs 紧凑，不是微调）",
    "lean " + T.player.strike.lean + "→" + T.brawler.strike.lean +
    " · step " + T.player.strike.step + "→" + T.brawler.strike.step);
}
{
  /* 运行时按事件切姿势档 */
  newFight();
  strike("jab", wantPerfect);
  const s1 = F().stage();
  A(s1.mePoseName === "strike" && s1.foePoseName === "hit",
    "一次命中里：出招方 poseName=strike、挨打方=hit", s1.mePoseName + " / " + s1.foePoseName);
  A(s1.spriteMe === false && s1.spriteFoe === false,
    "测试环境没有真 Image → 立绘未就绪，绘制走骨骼回落（回落路径必须能跑）",
    "spriteMe=" + s1.spriteMe + " spriteFoe=" + s1.spriteFoe);
}
{
  /* ── 立绘分支的几何 ────────────────────────────────────────────────────
     为什么必须专门测：测试环境没有真 Image，上面所有用例都走**骨骼回落**，
     于是立绘分支整整一大段零覆盖 —— 实测就漏掉一个真 bug：
       drawFighter 用 f.who（体型档位 "player"）去查立绘，而立绘 slug 在 f.sprite（"puncher"），
       SPRITES.player 不存在 → 陈默永远回落骨骼；花衬衫只是恰好 who 与 sprite 同名（都是
       "brawler"），所以只有一半角色被坑，看画面很容易误判成"两个都在用立绘"。
     这里用记账桩把几何钉住：缩放基准、贴地锚点、镜像不跑位、倒地不放大。 */
  const S = api.Stage;
  const meta = S.SPRITE_META;
  meta.puncher.standH = 400; meta.puncher.lowY = { idle:12, strike:12, hit:12, ko:12 };
  meta.brawler.standH = 420; meta.brawler.lowY = { idle:30, strike:30, hit:30, ko:30 };
  S.SPRITES.puncher = { ready:4, need:4, poses:{
    idle:fakeSprite(220,400), strike:fakeSprite(240,395),
    hit:fakeSprite(240,390),  ko:fakeSprite(300,150) } };
  S.SPRITES.brawler = { ready:4, need:4, poses:{
    idle:fakeSprite(200,420), strike:fakeSprite(210,415),
    hit:fakeSprite(210,410),  ko:fakeSprite(280,200) } };
  newFight();
  api.Stage.begin(api.FAKE_CV);
  api.Stage.running = false;
  api.Stage.GROUND = 720;
  /* ⚠ 必须关掉"机内模式"：机身常驻后整场都套着一次"世界 → CRT 屏"的等比缩放平移
     （见 draw() 里的 screenRect），量出来的坐标就不再是**世界坐标**了。
     这一组断言量的是立绘在世界里的几何（贴地/居中），所以要单独关掉它；
     机内模式本身另有一组断言（见下面街机机身那两段）。 */
  api.Stage.arcadeMode = false;
  api.PIX.minX = 1e9; api.PIX.maxX = -1; api.PIX.minY = 1e9; api.PIX.maxY = -1; api.PIX.n = 0;
  api.IMGS.length = 0;
  api.Stage.pose("me", "idle"); api.Stage.pose("foe", "idle");
  api.Stage.frameOnce();

  const sd = api.Stage.debugState();
  A(sd.spriteMe === true && sd.spriteFoe === true,
    "立绘就绪时两个角色都取得到（查 f.sprite，不是 f.who）",
    "spriteMe=" + sd.spriteMe + " spriteFoe=" + sd.spriteFoe + " ready=" + JSON.stringify(sd.spriteReady));
  A(api.IMGS.length >= 2, "立绘分支真的调了 drawImage（不是静默回落骨骼）", "drawImage × " + api.IMGS.length);

  /* 陈默：420×hi(1.06)=445.2 → k=445.2/400=1.113 → 220×400 画成 244.9×445.2。
     ⚠ 一帧里同一张立绘会被 drawImage **两次**：先画地面倒影（scale(1,-0.42)、18% 透明），
       再画本体。倒影底边 = GROUND + lowY*k + dh*0.42 ≈ 900，比本体（≈713）低得多，
       所以"取 dh≈445.2 的第一个矩形"会抓到倒影 —— 这条断言第一版就是这么误报的。
       判别方法：本体贴在地面线附近，倒影明显在下。 */
  const drawn = api.IMGS.filter((r) => Math.abs(r.dh - 445.2) < 0.6);
  const meIdle = drawn.find((r) => r.y1 - api.Stage.GROUND < 60);
  const meRefl = drawn.find((r) => r.y1 - api.Stage.GROUND > 60);
  A(!!meIdle, "陈默的立绘按**站姿身高**缩放（420×hi），不是按各图自身拉高",
    meIdle ? "dh=" + meIdle.dh.toFixed(1) + " dw=" + meIdle.dw.toFixed(1) + " · 同尺寸矩形 ×" + drawn.length
           : JSON.stringify(api.IMGS.map((r) => [Math.round(r.dw), Math.round(r.dh)])));
  if (meIdle) {
    A(Math.abs(meIdle.dw - 244.9) < 1.2, "宽度同比例（没有把窄图拉宽）", "dw=" + meIdle.dw.toFixed(1));
    const expect = api.Stage.GROUND + 12 * (445.2 / 400);
    /* 容差 6：桩 canvas 会把像素坐标取整（真 canvas 不取整），
       所以"底边落在 GROUND + lowY*k 上"只能验到取整量级。
       这条断言要挡的是**性质错误**（比如把图片底边当脚底 → 会差 lowY 本身或整张图高）。 */
    A(Math.abs(meIdle.y1 - expect) < 6, "落地点按 lowY 贴地（不是把图片底边当脚底）",
      "底边=" + meIdle.y1.toFixed(1) + " 期望≈" + expect.toFixed(1) + " GROUND=" + api.Stage.GROUND);
    A(!!meRefl && meRefl.y1 > meIdle.y1 + 100, "同一张立绘另有一份地面倒影（在地面线下方）",
      meRefl ? "本体底边=" + meIdle.y1.toFixed(1) + " 倒影底边=" + meRefl.y1.toFixed(1) : "没找到倒影");
    A(Math.abs((meIdle.x0 + meIdle.x1) / 2 - api.Stage.me.x) < 1.5,
      "立绘以贴地点为水平中心（镜像绕贴地点，不会把图甩到另一侧）",
      "中心=" + ((meIdle.x0 + meIdle.x1) / 2).toFixed(1) + " 贴地点=" + api.Stage.me.x);
  }
  /* 倒地：300×150 的图 k=1.113 → 宽 333.9、高 166.9（远小于 445，说明没被拉到站姿高度） */
  api.IMGS.length = 0;
  api.Stage.pose("me", "ko");
  api.Stage.frameOnce();
  const ko = api.IMGS.filter((r) => Math.abs(r.dw - 333.9) < 2.5).pop();
  A(!!ko, "倒地姿势按自身尺寸画（没被拉到站姿高度）",
    ko ? "dw=" + ko.dw.toFixed(1) + " dh=" + ko.dh.toFixed(1)
       : JSON.stringify(api.IMGS.map((r) => [Math.round(r.dw), Math.round(r.dh)])));

  /* 收尾：撤掉假立绘，恢复"无头环境没有 Image"这个真实前提 */
  S.SPRITES.puncher = null; S.SPRITES.brawler = null;
  S.arcadeMode = true;                                   // 还回默认值，别污染后面的用例
}
{
  /* ── 街机机身：打完一整局都待在机器里 ──────────────────────────────────
     验收三件事：
       ① 屏幕矩形在世界之内且留出了顶板与操作台（不然 LOGO / 摇杆会被挤出画布）；
       ② 机身常驻时，世界被**等比**装进屏幕 —— 等比很重要，否则人物会被拉扁；
       ③ 过场结束后 arcadeOn 归假但 arcadeMode 仍为真（机器不消失）。 */
  const S = api.Stage;
  const R = S.screenRect();
  A(R.w > 0 && R.h > 0 && R.x >= 0 && R.y >= 0 && R.x + R.w <= S.W && R.y + R.h <= S.H,
    "屏幕矩形在画布之内", JSON.stringify(R));
  A(R.y >= 70 && (S.H - (R.y + R.h)) >= 70,
    "上下留出了顶板与操作台（LOGO / 摇杆不会被挤掉）",
    "上 " + R.y + "px · 下 " + (S.H - (R.y + R.h)) + "px");

  api.clear(); AFTER.length = 0;
  api.startFight2({ type: "fight2", title: "一打二", hp: 320, perfect: {}, ok: {}, miss: {} });
  S.begin(api.FAKE_CV); S.running = false;
  A(S.arcadeMode === true && S.arcadeOn === true, "开局：机身常驻 + 过场进行中",
    "arcadeMode=" + S.arcadeMode + " arcadeOn=" + S.arcadeOn);
  const k = R.w / S.W;
  A(Math.abs(k - R.h / S.H) < 0.02,
    "世界到屏幕是**等比**缩放（不等比会把人物拉扁）",
    "kx=" + k.toFixed(4) + " ky=" + (R.h / S.H).toFixed(4));
  A(k > 0.5 && k < 1, "缩放系数在合理区间（世界缩小后装进屏里）", "k=" + k.toFixed(4));
  stageStep(160);                                        // 推完过场（约 2 秒 / 120 帧）
  A(S.arcadeOn === false && S.arcadeMode === true,
    "过场结束后机台**不消失**（玩家一直在机器里打）",
    "arcadeOn=" + S.arcadeOn + " arcadeMode=" + S.arcadeMode);
  /* 机内模式下画一帧：内容必须真的画在屏幕矩形内，而不是铺满整块画布 */
  api.PIX.minX = 1e9; api.PIX.maxX = -1; api.PIX.minY = 1e9; api.PIX.maxY = -1;
  S.frameOnce();
  A(api.PIX.maxX <= R.x + R.w + 40 && api.PIX.maxY <= R.y + R.h + 40,
    "机身常驻时游戏内容画在屏幕矩形内（不会溢出到机壳上）",
    "内容右下 (" + api.PIX.maxX + "," + api.PIX.maxY + ") 屏幕右下 (" +
    (R.x + R.w) + "," + (R.y + R.h) + ")");
}
{
  /* 街机过场：点「开始战斗」先"化身进街机"，期间锁住出招。
     ⚠ 这里刻意**不**用 newFight()（它会跳过片头），要的是刚 begin 的原始状态。 */
  api.clear(); AFTER.length = 0;
  api.startFight2({ type:"fight2", title:"一打二", hp:320, perfect:{}, ok:{}, miss:{} });
  const s0 = F().stage();
  A(s0.arcadeOn === true, "开局处于「化身进街机」过场中", "arcadeOn=" + s0.arcadeOn);
  const ap0 = F().state().ap;
  F().act("jab");
  A(F().state().ap === ap0 && F().state().foeHp === 320, "过场期间出招被挡（不会把行动力打空）",
    "ap " + ap0 + " → " + F().state().ap + " · foeHp " + F().state().foeHp);
  stageStep(120);
  A(F().stage().arcadeOn === false, "过场结束后自动收尾", "arcadeOn=" + F().stage().arcadeOn);
  /* 伤害要等落判才结算，所以这里看的是"判定条开了没" */
  F().act("jab");
  A(EL.fight2Bar.style.display === "block", "过场结束后出招能打开判定条（出招不再被挡）",
    "bar.display=" + EL.fight2Bar.style.display);
}

console.log("");
console.log("[结果] 通过 " + pass + "，失败 " + fails.length + (fails.length ? "" : "，全部通过 ✔"));
if (fails.length) { console.log("失败项："); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fails.length ? 1 : 0);
