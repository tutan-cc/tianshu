/*
  play.js —— 用真实 startFight2 打完整局并打印过程（调平用）。

  刻意写得"笨"：循环里每一步都打印状态，任何卡住都能一眼看出卡在哪。
  不追求优雅 —— 它是个诊断工具。

  用法：
    node tools/dev/play.js                # 完美打法 + 闪对
    node tools/dev/play.js nosdodge       # 完美打法 + 一直按错方向
    node tools/dev/play.js good           # 只打良好档
*/
const vm = require("vm");
const { readHtml, grabFn, grabConst, evalConstIn, serialize } = require("../../tests/lib/extract.cjs");

const html = readHtml();
const MODE = process.argv[2] || "perfect";
/* 调参表：落判帧数与"打不打得赢"都取决于它，别写死 */
const TUNE = evalConstIn(html, "FIGHT2_TUNE");
const MOVES = evalConstIn(html, "FIGHT2_MOVES");
const FOE_MOVES = evalConstIn(html, "FIGHT2_FOE_MOVES");

const foeHpOf = (() => {
  const i = html.indexOf("brawl2:{");
  const seg = html.slice(i, i + 1500);
  const m = /type:"fight2"[\s\S]{0,120}?hp:(\d+)/.exec(seg);
  return m ? Number(m[1]) : null;
})();

const prelude = `
  const FIGHT_GRADE_MULT = ${grabConst(html, "FIGHT_GRADE_MULT")};
  const FIGHT2_TUNE = ${grabConst(html, "FIGHT2_TUNE")};
  const FIGHT2_FOE_MOVES = ${grabConst(html, "FIGHT2_FOE_MOVES")};
  const FIGHT2_MOVES = ${grabConst(html, "FIGHT2_MOVES")};
  /* 卡牌：startFight2 会建牌堆（buildFight2Deck），Fight2Stage.drawCards 会读卡池 */
  const FIGHT2_CARDS = ${grabConst(html, "FIGHT2_CARDS")};
  const CardArt = ${grabConst(html, "CardArt")};
  ${grabFn(html, "buildFight2Deck")}
  ${grabFn(html, "judgeGrade")}
  ${grabFn(html, "mashLoop")}
  ${grabFn(html, "judgeBar")}
  /* P3 起 startFight2 会调 Fight2Stage.begin()，所以这个诊断工具必须把舞台也抽出来
     —— 否则直接 ReferenceError（本工具在 P2 之后坏掉了，一直没被发现）。 */
  const Fight2Stage = ${serialize(evalConstIn(html, "Fight2Stage"))};
  var SFX=[],AFTER=[],RNG=0.5,CLOCK=0,FRAME_MS=1000/60,PENDING=[];
  var M=Object.create(Math); M.random=function(){return RNG;};
  var InputBus={owner:null,_kd:null,_ku:null,
    setOwner(o,h){ this.release(); this.owner=o; const x=h||{};
      if(x.keydown){ this._kd=x.keydown; W.addEventListener("keydown",this._kd); }
      const s=this; return function(){ if(s.owner===o) s.release(); }; },
    release(){ if(this._kd){ W.removeEventListener("keydown",this._kd); this._kd=null; } this.owner=null; },
    activeCount(){ return this._kd?1:0; } };
  var EL={};
  function mkEl(id){ if(EL[id])return EL[id];
    return (EL[id]={id:id,style:{},dataset:{},innerHTML:"",textContent:"",scrollTop:0,scrollHeight:0,onclick:null,
      classList:{_s:{},add:function(c){this._s[c]=1;},remove:function(c){delete this._s[c];},contains:function(c){return !!this._s[c];}},
      addEventListener:function(){},removeEventListener:function(){},
      click:function(){ if(this.onclick) this.onclick({stopPropagation:function(){}}); }}); }
  var document={getElementById:function(id){return mkEl(id);},querySelectorAll:function(s){
    if(s.indexOf("fight2Btns")<0) return [];
    return ["jab","combo","low","guard","read","skip"].map(function(a){var e=mkEl("b-"+a);e.dataset.act=a;return e;});}};
  function $(id){return mkEl(id);}
  var __cs2={};
  var W={_h:{},addEventListener:function(t,f){(this._h[t]=this._h[t]||[]).push(f);},
    removeEventListener:function(t,f){var a=this._h[t]||[];var i=a.indexOf(f);if(i>=0)a.splice(i,1);},
    count:function(t){return (this._h[t]||[]).length;}};
  var window=W; window.__cs2=__cs2;
  var AudioSys={good:function(){},bad:function(){},ding:function(){},blip:function(){},play:function(){return true;}};
  var S={stats:{phy:18},fightWon:false};
  function afterInter(fx,why){ AFTER.push({fx:fx,why:why}); }
  function takeBuff(){return {};}
  function bonus(){return {};}
  function requestAnimationFrame(cb){ PENDING.push(cb); return 0; }
  var performance={now:function(){return CLOCK;}};
  var setTimeout=function(){return 0;};
`;

const api = new vm.Script("(function(){\n" + prelude + "\n" + grabFn(html, "startFight2") + "\n" +
  "return { startFight2:startFight2, EL:EL, W:window, AFTER:AFTER, S:S, Stage:Fight2Stage,\n" +
  "  step:function(){ var q=PENDING; PENDING=[]; CLOCK+=FRAME_MS;\n" +
  "    for(var i=0;i<q.length;i++) q[i](CLOCK); return q.length; },\n" +
  "  setRng:function(v){RNG=v;}, cs2:function(){return __cs2;} };\n" +
  "})()").runInNewContext({ console, Math: Object.create(Math) });

const F = () => api.cs2().fight2;
const st = () => F().state();
const plain = (s) => String(s).replace(/<[^>]+>/g, "");

api.setRng(0.5);
api.startFight2({ type: "fight2", title: "调平", hp: foeHpOf, perfect: {}, ok: {}, miss: {} });
/* ⚠ 跳过"化身进街机"过场：过场期间 transitionGuard() 会挡掉所有出招，
   而本工具是手动推帧的 —— 不跳过的话每次 act() 都被拒，
   表现是"打了 600 次、伤害全是 0、ap 一直是 4"（P3 之后这个工具就是这么坏掉的）。 */
api.Stage.arcadeOn = false; api.Stage.arcade = 0;
console.log("对手血量 =", foeHpOf, "· 玩家满血 =", st().maxHp, "· 模式 =", MODE);
console.log("调参：行动力 " + TUNE.AP + "/回合 · 判定条 " + TUNE.BAR_SPEED +
  "%/帧 · 输入缓冲 " + TUNE.INPUT_GRACE + "ms · 反击 ×" + TUNE.COUNTER_MULT);
/* 伤害账：静态推算，方便和下面的实测对照 */
{
  const G = evalConstIn(html, "FIGHT_GRADE_MULT");
  const perJab = Math.round(MOVES.jab.dmg * G.perfect);
  const perTurn = perJab * Math.floor(TUNE.AP / MOVES.jab.ap);
  const foeMax = foeHpOf || 320;
  const worst = Math.max(...FOE_MOVES.map((m) => m.dmg || 0));
  console.log("");
  console.log("── 伤害账 ──");
  console.log("  完美直拳 " + perJab + "/次 · 每回合 ≈ " + perTurn + " ⇒ 对手 " + foeMax +
    " 血要 ≈ " + Math.ceil(foeMax / perTurn) + " 回合");
  console.log("  对手单发最痛 " + worst + " · 我方满血 " + st().maxHp + " ⇒ 全程不闪只能活 " +
    (st().maxHp / worst).toFixed(1) + " 回合（" + Math.floor(st().maxHp / worst) + " 次挨打）");
  console.log("");
}

/** 打一招：把光标推到目标档位再落判 */
function strike(grade) {
  const before = st();
  F().act("jab");
  const B = F().bars();
  const L = parseFloat(B.zone.style.left), W = parseFloat(B.zone.style.width);
  const target = grade === "good" ? L + W * 0.15 : L + W * 0.5;
  const need = Math.round(target / TUNE.BAR_SPEED);
  for (let i = 0; i < need; i++) api.step();
  if (B.bar.onclick) B.bar.onclick({ stopPropagation() {} });
  const after = st();
  return { dmg: before.foeHp - after.foeHp, ap: after.ap, turn: after.turn };
}

function dirFromTell() {
  const t = plain(api.EL.fight2Tell.innerHTML);
  if (/左右晃动/.test(t)) return "down";
  if (/抬腿/.test(t)) return "up";
  return "left";
}

let g = 0, strikes = 0, dodges = 0, hitsTaken = 0, stunned = 0;
/* 闪避成功率（%）：用确定性模式生成"每 N 次闪错 1 次"，避免 RNG 抖动。
   MODE 可以是 perfect / good / nosdodge，也可以是 dodge50 / dodge75 这种带成功率的写法。 */
const dodgeAcc = (() => {
  const m = /^dodge(\d+)$/.exec(MODE);
  if (m) return Number(m[1]);
  return MODE === "nosdodge" ? 0 : 100;
})();
let dodgesSeen = 0;
while (F().alive && g++ < 600) {
  const s = st();
  if (s.phase === "defend") {
    const tell = plain(api.EL.fight2Tell.innerHTML);
    /* 按成功率决定这一次闪对还是闪错（闪错 = 故意按一个确定错的键） */
    dodgesSeen++;
    const slip = dodgeAcc < 100 && (dodgesSeen * (100 - dodgeAcc)) % 100 < (100 - dodgeAcc);
    const dir = slip ? dirWrong() : (MODE === "nosdodge" ? "right" : dirFromTell());
    const hp0 = s.hp;
    const ok = F().defend(dir);
    const s2 = st();
    if (s2.hp < hp0) hitsTaken++;
    else dodges++;
    if (g < 400) console.log("  [防守] tell=\"" + tell.slice(0, 22) + "\" 按 " + dir + " → " +
      (s2.hp < hp0 ? "挨打 -" + (hp0 - s2.hp) : "闪开") + " · 血 " + s2.hp + " · 第 " + s2.turn + " 回合" +
      (ok ? "" : " ⚠defend 返回 false"));
  } else if (s.stunMine) {
    stunned++;
    if (g < 400) console.log("  [硬直] 这回合动不了");
    F().act("jab");
  } else if (s.ap >= FigAp()) {
    const r = strike(MODE === "good" ? "good" : "perfect");
    strikes++;
    if (g < 400) console.log("  [出招] 第 " + r.turn + " 回合 直拳 → -" + r.dmg +
      " · 对手 " + st().foeHp + " · 我血 " + st().hp + " · ap " + r.ap +
      " · 体干 " + st().stamMine.toFixed(2) + "/" + st().stamFoe.toFixed(2));
  } else {
    if (g < 400) console.log("  [等待] phase=" + s.phase + " ap=" + s.ap + " turn=" + s.turn +
      " PENDING 空转（这是个 bug 信号）");
    api.step();
  }
}
function FigAp() { return MOVES.jab.ap; }
/** 按一个"确定错"的方向：先读 tell 推出正确方向再反着按。
    别用固定方向 —— 3 选 1，固定值迟早会撞上正确答案。 */
function dirWrong() {
  const r = dirFromTell();
  return r === "left" ? "right" : r === "down" ? "up" : "down";
}

const fin = st();
console.log("");
console.log("── 结果 ──");
console.log("  模式 " + MODE + "（闪避成功率 " + dodgeAcc + "%）");
console.log("  回合数 " + fin.turn + " · 出招 " + strikes + " 次 · 闪开 " + dodges + " 次 · 挨打 " + hitsTaken + " 次");
console.log("  剩余血 " + Math.max(0, fin.hp) + "/" + fin.maxHp + " · 对手剩余 " + fin.foeHp + " · 硬直 " + stunned + " 次");
console.log("  循环 " + g + " 次 · 存活 " + fin.alive + " · 结算 " + JSON.stringify(api.AFTER.map((a) => a.why)));
