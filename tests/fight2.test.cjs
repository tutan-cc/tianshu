#!/usr/bin/env node
/*
  tests/fight2.test.cjs — 打斗 2.0（fight2）骨架冒烟测试（P1）

  P1 的交付物是一个"骨架"：判定条 / 音效 / 结算出口都接通，机制（距离轴 / 体干 /
  AI 权重状态机）留给 P2–P4。骨架测试要守住的不是玩法深度，而是**接线正确性**：
    · 行动力扣除与回合推进；
    · 攻击按**卡面数值直接结算**（推条与三档已删除，张力改由装甲 / 连段 / 体力承担）；
    · 卡牌系统：抽牌 → 翻牌 → 出牌（翻牌不花行动力）→ 洗牌 / 治疗 / 卸力都接上了；
    · 结果走 afterInter（否则节点数据 / flags / 成就 / 章节卡全都要改）；
    · 跳过战斗这条出口存在（给纯剧情流玩家）；
    · 测试接口 __cs2.fight2.state() 可用（后续 P2–P4 的断言都要靠它）；
    · DOM id 全部另起 —— 旧 #fight 的全局绑定不能把 fight2 的按钮抢走。

  本次改版（卡牌阶段）删掉了三样东西，凡是守它们的断言都换了表达（不是删掉）：
    ① 三档判定（完美 ×1.9 / 良好 ×1.3 / 偏出 ×0.7）；② 连打手速（mashLoop）；
    ③ 攻击用的推条（precision() 现在直接 cb("flat")）。
  顶上来的是明牌机制：对手装甲（FOE_ARMOR，只有重拳破甲）、连段（同回合第 2 张攻击牌
  ×CHAIN_MULT）、每回合重抽的手牌（HAND_SIZE，全部背面朝上，翻牌不花行动力）。
  ⚠ 判定条**没有**从本文件消失干净：防守窗口仍用 judgeBar 收方向键（只看方向、不看位置），
    那条链路归 tests/fight-loop.test.cjs 与 tests/judge-bar.test.cjs 一起守。
    所以这里的断言一律区分阶段 —— "出招不打开判定条"只在 act 阶段成立，
    防守窗口里 fight2Bar 会被打开（但 onclick 收的是方向，不会产生三档伤害）。

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
  /* 卡牌：招式的"牌面"与牌堆构成。startFight2 会调 buildFight2Deck()，
     不抽出来的话直接 ReferenceError（和 P3 那次漏 Fight2Stage 是同一类问题）。 */
  const FIGHT2_CARDS = ${grabConst(html, "FIGHT2_CARDS")};
  /* CardArt：Fight2Stage.drawCards 用它画牌面/牌背，不抽出来会 ReferenceError */
  const CardArt = ${grabConst(html, "CardArt")};
  ${grabFn(html, "buildFight2Deck")}
  /* judgeGrade / mashLoop 是旧判定链路的残留：攻击流程**已经不用它们**了
     （"三档/连打确实被删干净"由文件末尾的源码级断言守着）。
     抽出来只是让这份沙箱和 index.html 的依赖形状一致 —— 真被删掉时会在这里
     报"抽取失败"，而不是静默少覆盖一段。
     judgeBar 不一样：防守窗口还在用它收方向键，是真的会被调用的。 */
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
  /* STRAYS = "世界糊到裁剪框外"的记录。
     为什么要单独记：PIX 记的是调用参数的变换后坐标、**不过裁剪**，
     而世界本来就比屏幕宽（相机在动），拿 PIX 断言"没溢出屏幕"必然误报。
     记账区间只在**世界那一段**（drawMachineFrame 之外）：
     机壳/操作台本来就画在裁剪框外，算进来会假报警。 */
  var STRAYS = [];
  var CLIPBOX = null;                       // {x0,y0,x1,y1}，只在世界那一段生效
  var CANVAS = { w: 1680, h: 900 };         // 画布外的顶点不算越界（整幅矩形的边角）
  var STRAY_TOL = 0;                        // 越界容差（由用例设定）
  var STRAY_TAG = "";                       // 当前正在画什么（定位越界来源用）
  function px(x, y){ if(x<PIX.minX)PIX.minX=x; if(x>PIX.maxX)PIX.maxX=x;
                     if(y<PIX.minY)PIX.minY=y; if(y>PIX.maxY)PIX.maxY=y; PIX.n++;
                     var inCanvas = x>=0 && y>=0 && x<CANVAS.w && y<CANVAS.h;
                     if(CLIPBOX && inCanvas && STRAYS.length < 20 &&
                        (x<CLIPBOX.x0-STRAY_TOL||x>CLIPBOX.x1+STRAY_TOL||
                         y<CLIPBOX.y0-STRAY_TOL||y>CLIPBOX.y1+STRAY_TOL))
                       STRAYS.push([Math.round(x), Math.round(y), STRAY_TAG]); }
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
      closePath:function(){}, arc:function(){}, ellipse:function(){},
      /* rect / clip：CardArt.back 用 rect+clip 把斜纹裁在卡内。
         桩只需要"能调用"（舞台所有绘制都被 try/catch 包着，但这条不该靠 catch 兜）。 */
      rect:function(){}, clip:function(){},
      createLinearGradient:function(){ return grad; }, createRadialGradient:function(){ return grad; },
      measureText:function(t){ return { width:String(t).length*8 }; },
      fillRect:function(x,y,w,h){
        /* 记账要和真画布一致：**先与裁剪框求交**，再看落笔是否越界。
           只记角点是错的 —— 铺满整幅的 fillRect（环境光、地面线）角点天然在框外，
           但实际落笔被裁在框内，那样会刷出一堆假越界（实测 18 例全是假的）。 */
        var a=tf(x,y), b=tf(x+w,y+h);
        var x0=Math.min(a[0],b[0]), x1=Math.max(a[0],b[0]);
        var y0=Math.min(a[1],b[1]), y1=Math.max(a[1],b[1]);
        if(CLIPBOX){
          var cx0=Math.max(x0,CLIPBOX.x0), cx1=Math.min(x1,CLIPBOX.x1);
          var cy0=Math.max(y0,CLIPBOX.y0), cy1=Math.min(y1,CLIPBOX.y1);
          if(cx1>=cx0 && cy1>=cy0){ px(cx0,cy0); px(cx1,cy1); }
          else { px(x0,y0); px(x1,y1); }                  // 整块在框外：照实记，该报警
        } else { px(x0,y0); px(x1,y1); }
      },
      strokeRect:function(x,y,w,h){ var p=tf(x,y); var q=tf(x+w,y+h);
        px(Math.min(p[0],q[0]),Math.min(p[1],q[1])); px(Math.max(p[0],q[0]),Math.max(p[1],q[1])); },
      fill:function(){}, stroke:function(){},
      fillText:function(t,x,y){ var p=tf(x,y); px(p[0],p[1]); },
      strokeText:function(t,x,y){ var p=tf(x,y); px(p[0],p[1]); },
      drawImage:function(img,dx,dy,dw,dh){
        /* ⚠ 与真 canvas 对齐口径：drawImage 的 dx/dy/dw/dh 是**用户坐标**（世界坐标），
           当前变换只在"绘制那一刻"生效。所以这里同时记两份：
             · dw/dh/worldX/worldY = 调用参数（世界坐标）—— 断言缩放/贴地用它
             · x0..y1 = 变换后的设备矩形 —— 断言"画在屏幕内"用它
           早期只记设备矩形，于是"立绘缩放"这类断言怎么算都对不上（多乘了一次 k）。 */
        IMGS.push({ img:img, dw:dw, dh:dh, wx:dx, wy:dy, wLowY:dy+dh,
                    x0:Math.min(tf(dx,dy)[0],tf(dx+dw,dy+dh)[0]),
                    x1:Math.max(tf(dx,dy)[0],tf(dx+dw,dy+dh)[0]),
                    y0:Math.min(tf(dx,dy)[1],tf(dx+dw,dy+dh)[1]),
                    y1:Math.max(tf(dx,dy)[1],tf(dx+dw,dy+dh)[1]) });
        var a=tf(dx,dy), b=tf(dx+dw,dy+dh);
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
    "  STRAYS:STRAYS, setClipBox:function(b){ CLIPBOX = b; },\n" +
    "  setStrayTol:function(v){ STRAY_TOL = v; }, setStrayTag:function(t){ STRAY_TAG = t; },\n" +
    "  el:function(id){ return mkEl(id); },\n" +
    "  step:function(){ var q=PENDING; PENDING=[]; CLOCK+=FRAME_MS;\n" +
    "    for(var i=0;i<q.length;i++) q[i](CLOCK); return q.length; },\n" +
    "  clear:function(){ PENDING.length = 0; SFX.length = 0; },\n" +
    "  setRng:function(v){ RNG=v; }, cs2:function(){ return __cs2; } };\n" +
    "})()").runInNewContext({ console, Math });
} catch (e) { err = e.message + "\n" + (e.stack || "").split("\n").slice(1, 3).join("\n"); }

A(!!api && typeof api.startFight2 === "function", "能从 index.html 抽出真实的 startFight2()", err || "");
if (!api) { console.log("\n[结果] 通过 " + pass + "，失败 " + fails.length + " —— 抽取失败"); process.exit(1); }

const { EL, SFX, AFTER, fakeSprite } = api;
/* 卡牌阶段改版后，原来那两个"读源文件按钮文案"的辅助函数（srcEl / actsOf）已经没人用了：
   招式定位搬到了牌面（FIGHT2_CARDS），断言改成直接读卡池对象，更可靠。
   留着死代码会让人以为还有按钮要维护，所以删掉。 */
const F = () => api.cs2().fight2;
const fightSfx = () => SFX.filter((s) => /^sfx-fight-/.test(s));
const plain = (s) => String(s).replace(/<[^>]+>/g, "");
const lastRow = () => { const r = String(EL.fight2Log.innerHTML).split('<div class="trow">'); return r[r.length - 1] || ""; };
/** brawl2 节点的对手血量 —— 从节点读，别在用例里写死。
    调平期它从 320 改到了 260：砍掉三档 ×1.9 之后，12 回合的伤害上限只有
    24 拳 × 12 − 14 装甲 = **274**，320 血在数学上永远打不死（实测循环不结束）。
    ⚠ 别用宽松正则：`/brawl2:...hp:(\d+)/` 会一路匹配到**下一个**节点的 inter.hp
      （旧 brawl 的 74），实测就踩过这个坑 —— 断言拿着 74 去跑，还以为是调平没生效。
      这里只取 brawl2 那一段。 */
const BRAWL2_HP = (() => {
  const i = html.indexOf("brawl2:{");
  if (i < 0) return null;
  const seg = html.slice(i, i + 1500);
  const m = /type:"fight2"[\s\S]{0,120}?hp:(\d+)/.exec(seg);
  return m ? Number(m[1]) : null;
})();
const newFight = (it) => {
  api.clear(); AFTER.length = 0;
  /* ⚠ 必须清掉判定条/防守条那几个元素的样式：
     假 DOM 的元素是**跨战斗复用**的，上一场残留的 style.left 会被
     `cursorPos()` 当成"本场光标已经走了这么远"，于是推进循环一帧都不跑就落下
     （实测："良好"那一档因此停在 17.6，而目标是 19.3）。 */
  ["fight2Bar", "fight2Zone", "fight2ZonePerfect", "fight2Cur", "fight2Tell"].forEach((id) => {
    const el = EL[id]; if (el) el.style = {};
  });
  /* 兜底血量与 brawl2 节点保持一致（调平后是 260，直接从节点读，别再写死）；
     单个用例要特例时传 it 覆盖 */
  api.startFight2(Object.assign({ type: "fight2", title: "一打二", hp: BRAWL2_HP || 260,
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
/** 调参表：用 evalConstIn 拿**真的那个对象**（不是 JSON 副本），
    这样用例能直接读它、必要时也能改它来构造局面。
    ⚠ 卡牌阶段之后只剩 FOE_ARMOR / CHAIN_MULT / HAND_SIZE / AP / COMBO_BONUS_CAP 这些
      还被 fight2 读；BAR_SPEED / INPUT_GRACE 已经没有任何 fight2 代码引用
      （它们原来是推条手感旋钮）—— 这条"已经没人读"由文件末尾的源码级断言守着，
      所以这里**不再**像旧版那样把 INPUT_GRACE 改成 0（那是给已删除的推条用例让路的）。 */
const F2_TUNE = evalConstIn(html, "FIGHT2_TUNE");
const F2_MOVES = evalConstIn(html, "FIGHT2_MOVES");

/* 卡牌阶段改版：**推条没了**（玩家两次反馈"太难瞄/鸡肋"）。
   `strike(kind, pick)` 保留原名与签名（几十处调用点不用改），但语义变成
   "出一招并结算" —— 伤害按卡面数值直接落下，不再有第二参数（三档落点）的含义。
   原来那个 pick 参数留着是为了兼容调用写法，现在被忽略。 */
function strike(kind, pick) {
  api.setRng(0.5);
  SFX.length = 0;
  const before = F().state();
  F().act(kind);
  const after = F().state();
  return { landed: 0, zoneL: 0, zoneW: 0, target: 0, need: 0,
           dealt: (before.foeHp - after.foeHp),
           sfx: fightSfx(), log: plain(lastRow()) };
}

/** 走玩家的两步操作把第 i 张牌**真的打出去**：背面牌第一次点只翻开（不花行动力），
    第二次点才结算。返回第二次（出牌）那一下的返回值。
    ⚠ 为什么不直接 playCard(i) 一次：setHand() 只换 hand、**不重置 hidden**
      （两个数组是平行的，hidden 里还留着上一手的 4 个 true），所以"构造出来的手牌"
      第一下必然只是翻开 —— 实测 `F().setHand(["bandage"]); F().playCard(0)` 会让
      行动力一点都不掉、牌也没进弃牌堆（旧断言就是这么红的）。
      这里先把牌翻到正面，再打出去，语义正好是玩家真实的两步。 */
function playCardNow(i) {
  if (F().deck().hidden[i]) F().playCard(i);          // 第一步：翻开（不花行动力）
  return F().playCard(i);                             // 第二步：打出去（消耗行动力并结算）
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
/** 用**卡牌路径**把这一场打完（先翻开、再打能打得起的最贵攻击牌）。
    为什么需要：卡牌阶段不能再"一直点直拳" —— 行动力不够时 act() 会直接返回、
    既不结算也不结束回合，循环会空转到上限（实测 301 次不结束，看着像游戏卡死，
    其实是驱动方式不成立）。玩家真实操作是"翻开→挑一张→打不起就结束回合"。 */
const CARD_ORDER = ["heavy", "combo", "low", "jab", "guard", "unload", "counterup", "bandage", "breathe", "read"];
function playOneCard() {
  const d = F().deck();
  for (let i = 0; i < d.hand.length; i++) if (d.hidden[i]) F().playCard(i);   // 先翻牌（不花行动力）
  const d2 = F().deck();
  if (!d2.hand.length) { F().endTurn(); return; }
  for (const kind of CARD_ORDER) {
    const i = d2.hand.findIndex((id) => id === kind);
    if (i < 0) continue;
    if (F().playCard(i)) return;
  }
  F().endTurn();                                        // 都打不起 → 交回合
}
/** 打完一整局（沿途闪避），返回循环次数 */
function settleByCards(maxLoop) {
  let g = 0;
  const cap = maxLoop || 400;
  while (F().alive && g++ < cap) {
    const s = F().state();
    if (s.phase === "defend") { if (!F().defend(dirForTell())) api.step(); }
    else playOneCard();
  }
  return g;
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
/* wantGood / wantMiss（良好档、偏出档的落点）已随三档一起删掉：strike() 的第二个参数
   现在被忽略，留着一个没人用的落点函数只会让人以为还有三档要瞄。 */

/* ── 1. 接线：DOM id 另起 + 按钮绑定 ── */
newFight();
A(EL.fight2.classList.contains("on"), "fight2 面板已打开");
A(api.BOUND.length === 6, "6 个按钮都绑上了点击（走 #fight2Btns，不是旧的 #fightBtns）",
  api.BOUND.join(","));
A(api.BOUND.indexOf("skip") >= 0, "「跳过战斗」出口存在（给纯剧情流玩家）");
A(typeof F().state === "function", "测试接口 __cs2.fight2.state() 可用");
{
  const st = F().state();
  A(st.hp > 0 && st.foeHp === BRAWL2_HP && st.ap === 4 && st.turn === 1,
    "初始状态：满血 / 对手 " + BRAWL2_HP + "（brawl2 节点）/ 4 行动力 / 第 1 回合",
    JSON.stringify({ hp: st.hp, foe: st.foeHp, ap: st.ap, turn: st.turn }));
  A(Array.isArray(st.log) && st.log.length >= 1, "state().log 有开场白", JSON.stringify(st.log));
}

/* ── 2. 攻击是"明牌结算"：没有推条、没有三档 ──────────────────────────────
   玩家两次反馈（"完美区太难瞄"、"不需要什么进入绿条点击，鸡肋的很"）之后，
   三档判定与连打一起砍掉。这一组断言守住"真的砍干净了"，并验证替代机制：
   装甲（普通攻击先扣装甲）与破甲（重拳无视装甲）。 */
{
  newFight();
  const P = strike("jab", wantPerfect);
  A(!/完美命中|命中 ×|偏出/.test(P.log), "攻击不再有三档文案（推条已移除）", P.log);
  A(/造成/.test(P.log), "攻击按卡面数值直接结算", P.log);
  /* ⚠ 用 F().bars() 取判定条元素：桩 DOM 是**按需创建**的（mkEl 在第一次 $() 时才建），
     直接读 EL.fight2Bar 会是 undefined。 */
  const barEl = F().bars().bar;
  A(!!barEl && (barEl.style.display !== "block" || !barEl.onclick),
    "出招不再打开判定条", barEl ? ("bar=" + barEl.style.display + " onclick=" + String(barEl.onclick)) : "拿不到判定条元素");
}
{
  /* 装甲：对手有装甲时，普通攻击先被吃掉一部分 */
  newFight();
  const armor0 = F().deck().foeArmor;
  A(armor0 > 0, "对手开局有装甲值", "armor=" + armor0);
  strike("jab", wantPerfect);
  const armor1 = F().deck().foeArmor;
  A(armor1 < armor0, "普通攻击会削减对手装甲", armor0 + " → " + armor1);
}
{
  /* 破甲：重拳无视装甲（装甲不掉，但伤害全额进血） */
  newFight();
  const a0 = F().deck().foeArmor, hp0 = F().state().foeHp;
  strike("heavy", wantPerfect);
  const a1 = F().deck().foeArmor, hp1 = F().state().foeHp;
  A(a1 === a0, "重拳是破甲牌：装甲值不变", a0 + " → " + a1);
  A(hp0 - hp1 >= 20, "重拳伤害全额打进血里（不被装甲吃）", "掉血 " + (hp0 - hp1));
}
{
  /* 连段：同一回合内第二张攻击牌加伤 */
  newFight();
  const LOW = F2_MOVES.low.dmg;
  F().set({ ap: 4 });
  strike("low", wantPerfect);                       // 第一手：原值
  const hpA = F().state().foeHp;
  strike("low", wantPerfect);                       // 第二手：连段 ×CHAIN_MULT
  const hpB = F().state().foeHp;
  const first = hpA, second = hpA - hpB;
  A(second > LOW, "同回合第二张攻击牌吃到连段加伤",
    "第一手 " + LOW + " → 第二手 " + second + "（×" + F2_TUNE.CHAIN_MULT + "）");
}

/* ── 3. 卡牌：抽牌 / 翻牌 / 出牌 ── */
{
  newFight();
  const d = F().deck();
  A(d.hidden.filter(Boolean).length === d.hand.length,
    "抽到的手牌**全部背面朝上**（要先翻开）",
    "隐藏 " + d.hidden.filter(Boolean).length + "/" + d.hand.length);
  /* 第一次点：只翻开，不消耗行动力、不造成伤害 */
  const ap0 = F().state().ap, foe0 = F().state().foeHp;
  const r1 = F().playCard(0);
  A(r1 === true, "点背面牌 → 翻开成功", "playCard(0) → " + r1);
  A(F().deck().hidden[0] === false, "第一张牌已翻开", "hidden=" + JSON.stringify(F().deck().hidden));
  A(F().state().ap === ap0 && F().state().foeHp === foe0,
    "翻开**不消耗行动力、不造成伤害**（翻牌与出牌是两个动作）",
    "ap " + ap0 + " → " + F().state().ap + " · 对手 " + foe0 + " → " + F().state().foeHp);
  /* 第二次点：打出去 */
  const kind = F().deck().hand[0];
  F().playCard(0);
  A(F().deck().hand.length === d.hand.length - 1, "第二次点 → 打出（手牌少一张）",
    "手牌 " + F().deck().hand.length);
  A(F().deck().discard.indexOf(kind) >= 0, "打出的牌进弃牌堆", "弃牌 " + F().deck().discard.join(","));
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

/* ── 5. 组合拳两段（卡牌阶段：不再有连打条） ── */
{
  newFight();
  strike("combo", wantPerfect);
  const logTxt = plain(EL.fight2Log.innerHTML);
  A(/组合拳 · 一段/.test(logTxt), "组合拳一段照常结算", logTxt.slice(-80));
  A(/组合拳 · 二段/.test(logTxt), "二段自动接上（不再需要连打手速）", logTxt.slice(-70));
  /* 连打条彻底退役：卡牌阶段没有任何"手速"入口。
     ⚠ 桩 DOM 按需创建，所以先经 $() 拿到元素再断言（直接读 EL.qteMash 会是 undefined）。 */
  const mashEl = api.el("qteMash");
  A(!!mashEl && mashEl.style.display !== "block",
    "连打条不再出现（手速要素已移除）", mashEl ? String(mashEl.style.display) : "拿不到元素");
}

/* ── 6. 结算出口：必须走 afterInter（否则节点/flags/成就/章节卡全要改）── */
{
  newFight();
  const g = settleByCards();
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

/* ── 9. 判定条收摊 → 「出招这条链路上根本没有判定条」 ──
   原来这三条守的是"落判之后判定条必须收摊、onclick 清掉、不留监听"。
   攻击用的推条整个删掉之后，"落判"这件事不存在了，所以要守的反面是
   **它确实没被这条链路碰过**（否则以后谁把 judgeBar 接回攻击流程，这里毫无反应）：
     · 出招不会打开判定条、不会挂落判回调；
     · 出招不会在 window 上留按键监听（旧 precision 的监听器从来不摘，打一局攒 20 个）；
     · 点判定条元素不会造成任何伤害（旧落判入口已死）。
   ⚠ 这三条只在 **act 阶段**成立：防守窗口仍用 judgeBar 收方向键（那时 bar 会被打开、
     onclick 会挂上方向回调），那是另一条链路，见文件顶部的说明。 */
{
  newFight();
  strike("jab", wantPerfect);
  const B = F().bars();
  A(B.bar.style.display !== "block" && B.bar.onclick === null,
    "出招不打开判定条、也不挂落判回调（与第 2 组不同角度：那条读的是 bars() 的初值）",
    "display=" + JSON.stringify(B.bar.style.display) + " onclick=" + String(B.bar.onclick));
  A(api.WIN.count("keydown") === 0, "出招不会在 window 上留按键监听（旧 precision 会攒监听器）",
    "剩 " + api.WIN.count("keydown") + " 个");
  const foe9 = F().state().foeHp, ap9 = F().state().ap;
  B.bar.click();                       // 桩 DOM 的 click() 走 onclick —— 现在必然为空
  A(F().state().foeHp === foe9 && F().state().ap === ap9,
    "点判定条元素不再有任何作用（不造成伤害、不推进回合 —— 落判入口已死）",
    "对手 " + foe9 + " → " + F().state().foeHp + " · ap " + ap9 + " → " + F().state().ap);
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
  /* 硬直伤害倍率的算术：同一次攻击，硬直态应当明显高于普通态。
     ⚠ 硬直必须在**推进到防守窗口之后**再置：`act()` 里有一条"硬直期出招 = 白费"的分支
       （stunMine → 消耗掉硬直并把回合让给对手），而 advanceToDefend 是靠出招推进的。
       先置硬直的话第一拳就会把它吃掉，等对手打过来时 stunMine 已经是 false ——
       实测两边都掉 30 血，看着像"倍率没生效"，其实是构造方式错了。 */
  newFight();
  advanceToDefend();
  const hp0 = F().state().hp;
  let g = 0;
  while (F().state().phase === "defend" && g++ < 200) api.step();
  const normalLoss = hp0 - F().state().hp;
  /* 再来一次，这次在红闪窗口里置上硬直（关掉读招减伤与格挡，排除干扰） */
  newFight();
  advanceToDefend();
  F().set({ stunMine: true, read: 0, guard: 0 });
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
  A(F().deck().foeArmor === 0,
    "（前置）对手装甲已被前面的直拳磨光（不然这一手会先被吸掉 14，数字对不上）",
    "armor=" + F().deck().foeArmor);
  const foeHp0 = F().state().foeHp;
  const LOW = JSON.parse(grabConst(html, "FIGHT2_MOVES")).low.dmg;   // 低扫基础伤害（别写死）
  strike("low", () => 1);                            // 低扫不看判定表 → 纯看反击倍率
  const dealt = foeHp0 - F().state().foeHp;
  A(dealt === Math.round(LOW * 2.2), "反击窗口内低扫 " + LOW + " → " + Math.round(LOW * 2.2) + "（×2.2）",
    "实际造成 " + dealt);
  A(F().state().counter === false, "反击窗口用掉即关（不会一路白拿）", "counter=" + F().state().counter);
  void settleFight();
}
{
  /* 关掉反击窗口后，同样的招应当回到基础伤害。
     ⚠ 卡牌阶段多了一层**对手装甲**（FOE_ARMOR=14）：装甲还在时低扫 17 会先被吸掉 14，
       实测只剩 3 —— 拿它当"基础伤害"的对照组会测出一个假数（旧断言就是这么红的）。
       所以先把装甲磨光：装甲只被**普通攻击**扣（重拳是破甲牌，只绕过、不削减），
       两记直拳 12+18 正好把它从 14 磨到 0。
     ⚠ 连段（同回合第 2 张攻击牌 ×CHAIN_MULT）会污染这一手：所以磨完装甲要**过一回合**
       （startTurn 里 chain 归零），再在第一手打低扫。
     ⚠ 过回合时**故意不闪**（硬吃）：闪开会给反击窗口 ×2.2，实测低扫会变成 37。 */
  newFight();
  const LOW = JSON.parse(grabConst(html, "FIGHT2_MOVES")).low.dmg;
  F().set({ ap: 12 });                               // 同一回合里把两拳打完，别让 AP 用尽自动过回合
  strike("jab", wantPerfect);
  strike("jab", wantPerfect);
  A(F().deck().foeArmor === 0, "（前置）两记直拳把装甲磨到 0", "armor=" + F().deck().foeArmor);
  F().endTurn();
  let g = 0;
  while (F().state().phase === "defend" && g++ < 200) api.step();     // 不按方向 → 硬吃，不开反击窗口
  A(F().state().phase === "act" && F().state().counter === false,
    "（前置）新回合开始：连段归零、没有反击窗口加成",
    "phase=" + F().state().phase + " chain=" + F().deck().chain + " counter=" + F().state().counter);
  const foeHp0 = F().state().foeHp;
  strike("low", () => 1);
  A(foeHp0 - F().state().foeHp === LOW, "非反击窗口、装甲已破 → 低扫就是 " + LOW + "（对照组）",
    "实际造成 " + (foeHp0 - F().state().foeHp) + "｜" + plain(lastRow()));
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

/* ── 17. 全程跑通：机制叠加下还能正常结束 ──
   ⚠ 驱动必须走**卡牌路径**（settleByCards）：卡牌阶段不能像以前那样"一直点直拳" ——
     行动力不够时 act() 直接 return、既不结算也不结束回合，循环会空转到上限；
     实测旧驱动跑出"循环 401 次、停在第 3 回合"，看着像游戏卡死，其实是驱动方式不成立
     （玩家真实操作是"翻开 → 挑一张 → 打不起就点结束回合"）。 */
{
  newFight();
  const g = settleByCards();
  A(!F().alive, "机制叠加后战斗仍能正常结束", "循环 " + g + " 次 · 第 " + F().state().turn + " 回合");
  A(AFTER.length >= 1, "结算照常走 afterInter", JSON.stringify(AFTER).slice(0, 70));
  A(api.WIN.count("keydown") === 0, "打完之后没有残留键盘监听（防守窗口也接了 InputBus）",
    "剩 " + api.WIN.count("keydown") + " 个");
}

/* ══════════════ P3 前置：调平回归（一局该有多长） ══════════════
   这一组是"防漂移"用的。P2 第一版就是手算的数值：以为 6–9 回合，实测 2 回合，
   体干/硬直/反击窗口一次都没来得及触发 —— 机制做了等于白做。
   所以把"实测回合数"直接钉在测试里：改数值后如果跑出 2 回合，测试立刻红。

   卡牌阶段重新标定（本次改版：砍三档 ×1.9 / 加对手装甲与连段 / 对手血量 320→260）：
   · 驱动 = playFull()：先翻牌 → 挑一张打得起的攻击牌 → 打不起就点结束回合；
     防守一律按 tell 闪对。这就是"理想打法"。
   · **实测 60 局**（每局重洗牌）：最小 7、最大 12、均值 9.4 回合，
     分布 7×2 / 8×10 / 9×21 / 10×18 / 11×6 / 12×3；60 局**全部**把对手打死
     （收官时对手血量最大 0、均值 −18.6），也就是说没有一局是靠 12 回合兜底比血量收场的。
   · 为什么判据放在"3 局的平均/多数"而不是单局：单局方差有 ±2（7~12），
     钉死单局等于抛硬币（实测跑 15 次里就出现过一次边界外的值）。
     3 局平均实测落在 8–11（20 组三连样本），所以区间取 **7–12**（实测 ±1）。
   · 原设计目标 §7.1 的 6–9 是"两招 2AP、无装甲、对手 200 血"时代的数字。
     现在伤害端砍了 ×1.9、但连段 ×1.5 与破甲重拳补回来一部分，血量又降到 260，
     两者大致抵消 —— 实测落在同一档（7–12），没有变成速通。
   ⚠ 别指望 api.setRng() 能固定牌序：沙箱里的 shuffle 调的是 Math.random，
     而 runInNewContext 传进去的是**真 Math**（那个 RNG 桩挂在另一个对象 M 上，没人读），
     所以 setRng 是空操作 —— 这也是本组必须写成区间/多样本的原因。 */
{
  A(BRAWL2_HP !== null, "能从 brawl2 节点读到对手血量（调平断言的输入）", String(BRAWL2_HP));

  /** 打完整局（打到胜负分出），返回统计。
      dodge=false → 故意按错方向（"从不防守"的对照组）；
      lazy=true   → 故意打差：每回合只出一张最便宜的攻击牌，剩下的行动力直接作废
                    （对应原来"只打良好档"那条对照组：伤害更低 → 一局不该更短）。 */
  function playFull(dodge, lazy) {
    newFight({ hp: BRAWL2_HP });
    turnDirWrong = !dodge;                  // 让 advanceTurn 里也按同一种策略走
    const maxHp = F().state().maxHp;
    let g = 0, stunSeen = false, counterSeen = false, restSeen = false, defendSeen = 0;
    while (F().alive && g++ < 400) {
      const st = F().state();
      if (st.counter) counterSeen = true;
      if (st.stunMine) stunSeen = true;
      if (/喘|没能还手|没打出来/.test(plain(String(st.log.join(" "))))) restSeen = true;
      if (st.phase === "defend") {
        defendSeen++;
        if (!F().defend(dodge ? dirForTell() : dirWrong())) api.step();
      } else if (lazy) {
        const d = F().deck();
        for (let i = 0; i < d.hand.length; i++) if (d.hidden[i]) F().playCard(i);   // 翻牌不花行动力
        const j = F().deck().hand.findIndex((id) => id === "jab" || id === "low");
        if (j >= 0) playCardNow(j);        // 只出一张便宜攻击牌
        F().endTurn();                     // 剩下的行动力直接作废（phase 已进 defend 时是空操作）
      } else {
        playOneCard();
      }
    }
    const st = F().state();
    turnDirWrong = false;
    return { turns: st.turn, lost: maxHp - st.hp, maxHp, foeHp: st.foeHp, stunSeen, counterSeen,
             restSeen, loops: g, defendSeen, win: api.S.fightWon };
  }

  const runs = [playFull(true, false), playFull(true, false), playFull(true, false)];
  const turns = runs.map((r) => r.turns);
  const avgTurns = turns.reduce((a, b) => a + b, 0) / turns.length;
  const worstLoss = Math.max.apply(null, runs.map((r) => r.lost));
  const bestFoe = Math.max.apply(null, runs.map((r) => r.foeHp));
  const koRuns = runs.filter((r) => r.foeHp <= 0).length;

  A(turns.every((t) => t >= 6),
    "每一局都不会短到 5 回合以内（机制来得及展开，不是速通）",
    "三局回合数 " + turns.join("/") + "（实测 60 局最低 7，这里取 ±1 余量到 6 以下才报）");
  A(avgTurns >= 7 && avgTurns <= 12,
    "理想打法平均落在 7–12 回合（实测 60 局 7–12、均值 9.4；三局平均实测 8–11）",
    "三局 " + turns.join("/") + " → 平均 " + avgTurns.toFixed(2) +
    " · 承伤 " + worstLoss + "/" + runs[0].maxHp + " · 对手剩 " + runs.map((r) => r.foeHp).join("/"));
  A(koRuns >= 2, "三局里至少两局是把对手**打死**收官的（不是靠 12 回合兜底比血量）",
    "打死 " + koRuns + "/3 局 · 收官时对手剩 " + runs.map((r) => r.foeHp).join("/") + "（实测 60 局全部 ≤0）");
  A(worstLoss < runs[0].maxHp * 0.5,
    "全程闪对的话不该被打残（防守是有回报的）", "最差一局承伤 " + worstLoss + "/" + runs[0].maxHp);
  A(runs.some((r) => r.counterSeen || r.restSeen),
    "一局内至少能看到一次「对手喘气/反击窗口」（体干机制真的走起来了）",
    runs.map((r) => "反击 " + r.counterSeen + "/喘气 " + r.restSeen).join(" · "));

  /* 懒打对照组：判据不能用"收官时对手剩多少血"——
     战斗以 foeHp<=0 结束，血量会到负数（实测 −3 ~ −9），而"懒打也打赢"时两边都是负数，
     比负数大小就看运气（实测 2/8 次翻转失败）。连打删除后懒打能靠 12 回合兜底偶尔打赢，
     所以这条从"必然更差"降级为"不会更好、也不会更快"。 */
  const lazy = playFull(true, true);
  A(lazy.turns >= Math.max.apply(null, turns),
    "打得差（每回合只出一张便宜牌、行动力作废）不会让一局更短",
    "懒打 " + lazy.turns + " 回合 vs 理想 " + turns.join("/") + "（实测懒打恒为 13 回合 = 撞兜底）");
  A(lazy.foeHp >= bestFoe,
    "懒打不会比理想打法更快解决对手（收官时对手剩血 ≥ 理想的最差局）",
    "懒打剩 " + lazy.foeHp + " vs 理想最多剩 " + bestFoe +
    " · 理想三局 " + runs.map((r) => r.foeHp).join("/") +
    "（注：<=0 表示已打赢，所以这条不能按「剩得多=更差」读）");

  const noDodge = [playFull(false, false), playFull(false, false), playFull(false, false)];
  const totalLoss = noDodge.reduce((a, r) => a + r.lost, 0);
  /* 断言"明显更疼"而不是"两倍"：对手一局只有约 8 次出手机会（体干限制 + 玩家把它打喘），
     而且手牌好的一局可能直接把它打死、它根本没机会还手 —— 单局伤害波动很大
     （实测 40 局：12 / 17 / 26 / 26 / 27 / 37 … 131 / 132 / 134，均值 93.5）。
     所以判据放在 3 局累计上（实测三局累计 196–397），单局只要求"确实挨了打"。
     这条的意义是"防守必须值钱"，不是"不防守必输"。 */
  A(noDodge.every((r) => r.lost > 0) && totalLoss >= 60,
    "从不防守的代价足够大（三局累计明显比闪对疼）",
    "三局掉血 " + noDodge.map((r) => r.lost).join("/") + " = " + totalLoss + " vs 闪对 0");
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
  /* 命中 → 火花 + 顿帧 + 对手受击姿势。
     ⚠ 这里必须用**重拳（破甲）**，不能再用直拳：对手开局有 14 点装甲，直拳只有 12 ——
       打出去会被全吸收，走的是 hitFoe 的"伤害为 0"分支（轻震 + 对手不进受击姿势）。
       旧写法（strike("jab")）在新机制下变成了"在测格挡演出"，名字与实测对不上。
       重拳 atkTag=pierce，无视装甲，26 点全额进血 → 才是真正的"命中"。 */
  newFight();
  strike("heavy", wantPerfect);
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
  /* 伤害为 0 → 不该演成"打实了"。
     原来是靠"偏出"（miss 档）制造空挥，三档删掉之后，能造出 0 伤害的真实场景
     只剩"装甲全吸收"：直拳 12 < 装甲 14，第一拳必然 0 伤害（日志写「装甲吸收 12」）。
     hitFoe 的实现里 d <= 0 走的是 Fight2Stage.hit("block") 轻震档：
     顿帧 4 / 震动 6（真命中是 light 6/8、heavy 12/20），而且**不给对手切受击姿势**。
     所以这里守的不再是"零特效"，而是"演出必须比真命中轻、且不冒充命中"——
     原来那两条（fx===0 / hitstop===0）在新机制下已经不可能成立（block 也会放环）。 */
  newFight();
  const r0 = strike("jab", wantPerfect);
  const s0 = F().stage();
  A(r0.dealt === 0, "（前置）这一拳被装甲全吸收、伤害为 0", "掉血 " + r0.dealt + "｜" + r0.log);
  A(s0.foePoseName === "idle", "被装甲全吃掉的一击不演成命中（对手不进受击姿势）",
    "foePose=" + s0.foePoseName);
  A(s0.ko === 0 && s0.koText === "", "伤害为 0 不会打出 KO 横幅",
    "ko=" + s0.ko + " text=" + JSON.stringify(s0.koText));
  /* ⚠ 比的是 **fx（还活着的火花数）**，不是 fxCount：
     fxCount 是"命中事件计数器"，block 档也会 +1 —— 实测两边都是 1，比不出强弱。 */
  const blockStop = s0.hitstop, blockFx = s0.fx;
  newFight();
  strike("heavy", wantPerfect);                        // 破甲 26 → 真命中
  const s1 = F().stage();
  A(s1.hitstop > blockStop && s1.fx > blockFx,
    "真命中的顿帧与特效**严格强于**被装甲吸收的一击（空挥就是空挥）",
    "吸收：顿帧 " + blockStop + "/火花 " + blockFx + " vs 命中：顿帧 " + s1.hitstop + "/火花 " + s1.fx);
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
  /* 结算 → KO 横幅 + 输家倒地 + 相机推近 + 演完自停。
     ⚠ 驱动换成卡牌路径（settleByCards）：一直点直拳在新机制下有两个坑 ——
       ① 直拳被装甲吸收、DPR 低到打不死对手（12 回合兜底会先触发）；
       ② 体力见底时下回合只有 3 点行动力，直拳要 2 点 → 打不起第二拳、
          act() 又不会因此结束回合，循环直接空转（实测"循环 401 次"）。
       卡牌驱动会翻牌、挑打得起的牌、都打不起就点结束回合，三样都能绕开。 */
  newFight();
  const g = settleByCards();
  const s4 = F().stage();
  A(!F().alive && api.S.fightWon === true,
    "（前置）这一局打赢了", "循环 " + g + " 次 · 第 " + F().state().turn + " 回合 · fightWon=" + api.S.fightWon);
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
  /* 运行时按事件切姿势档。
     ⚠ 用重拳（破甲）：直拳 12 < 装甲 14，打出去是 0 伤害，对手**不会**进 "hit" 档
       （hitFoe 的 d <= 0 分支只放轻震、不动对手姿势）—— 旧写法在新机制下必然读到 idle。 */
  newFight();
  strike("heavy", wantPerfect);
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
  api.startFight2({ type: "fight2", title: "一打二", hp: BRAWL2_HP, perfect: {}, ok: {}, miss: {} });
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
  /* 机内模式：世界必须**被缩放并裁进屏幕**。
     这条用**精确几何**判，不用"落笔包围盒"：
     试过四种口径都不行 —— 整帧 PIX（机壳本来就画在屏外）、世界段的越界记账
     （桩的记账与真画布有偏差，实测把 HUD 贴边的像素全报成越界）、数最终像素
     （桩不保存像素）。而"世界被缩放成屏幕大小"这件事本身是精确可判的：
     立绘的 drawImage 目标矩形 = 屏幕矩形 × (世界坐标/世界尺寸)，反推即得缩放与落点。
     真实像素层面的"溢出多少"由 `node tools/dev/cabinet-check.js` 负责（实测 0.082%）。 */
  const S2 = api.Stage;
  const meta = S2.SPRITE_META;
  meta.puncher.standH = 400; meta.puncher.lowY = { idle:12, strike:12, hit:12, ko:12 };
  meta.brawler.standH = 420; meta.brawler.lowY = { idle:30, strike:30, hit:30, ko:30 };
  S2.SPRITES.puncher = { ready:4, need:4, poses:{ idle:fakeSprite(220, 400) } };
  S2.SPRITES.brawler = { ready:4, need:4, poses:{ idle:fakeSprite(200, 420) } };
  S2.pose("me", "idle");
  api.IMGS.length = 0;
  S2.frameOnce();
  const kk = R.w / S2.W;
  /* dw/dh 是**世界坐标**下的尺寸（真 canvas 的口径）：立绘在世界里身高 = 420*hi = 445.2，
     与"世界→屏幕"的 k 无关；k 只在绘制那一刻作用于画布变换。 */
  const wantDh = 420 * 1.06;
  const gi = api.IMGS.filter((r) => Math.abs(r.dh - wantDh) < 1).pop();
  A(!!gi, "机内模式：立绘仍按世界尺度缩放（世界的坐标体系没有被屏幕矩形改动）",
    gi ? ("世界身高 dh=" + gi.dh.toFixed(1) + " 期望≈" + wantDh.toFixed(1) + " · k=" + kk.toFixed(4))
       : JSON.stringify(api.IMGS.map((r) => [Math.round(r.dw), Math.round(r.dh)])));
  if (gi) {
    A(gi.x0 >= R.x - 2 && gi.x1 <= R.x + R.w + 2 && gi.y1 <= R.y + R.h + 2,
      "立绘落在屏幕矩形内（世界的落点被框进 CRT）",
      "立绘 (" + gi.x0.toFixed(0) + "," + gi.y0.toFixed(0) + ")..(" + gi.x1.toFixed(0) + "," + gi.y1.toFixed(0) +
      ") · 屏幕 (" + R.x + "," + R.y + ")..(" + (R.x + R.w) + "," + (R.y + R.h) + ")");
  }
  S2.SPRITES.puncher = null; S2.SPRITES.brawler = null;
}
{
  /* 街机过场：点「开始战斗」先"化身进街机"，期间锁住出招。
     ⚠ 这里刻意**不**用 newFight()（它会跳过片头），要的是刚 begin 的原始状态。 */
  api.clear(); AFTER.length = 0;
  api.startFight2({ type:"fight2", title:"一打二", hp:BRAWL2_HP, perfect:{}, ok:{}, miss:{} });
  const s0 = F().stage();
  A(s0.arcadeOn === true, "开局处于「化身进街机」过场中", "arcadeOn=" + s0.arcadeOn);
  const ap0 = F().state().ap;
  F().act("jab");
  A(F().state().ap === ap0 && F().state().foeHp === BRAWL2_HP, "过场期间出招被挡（不会把行动力打空）",
    "ap " + ap0 + " → " + F().state().ap + " · foeHp " + F().state().foeHp);
  stageStep(120);
  A(F().stage().arcadeOn === false, "过场结束后自动收尾", "arcadeOn=" + F().stage().arcadeOn);
  /* 出招是否被受理 → 改看**行动力与结算**，不再看判定条开没开。
     原来这条读的是"伤害要等落判才结算，所以判定条开了就说明出招被受理了"；
     推条删掉之后，"受理"的证据变成：AP 被扣 + 装甲被扣（伤害当场结算，没有中间态）。 */
  const ap1 = F().state().ap, armor1 = F().deck().foeArmor;
  F().act("jab");
  A(F().state().ap === ap1 - JAB_AP && F().deck().foeArmor < armor1,
    "过场结束后出招不再被挡（行动力被扣、伤害当场结算）",
    "ap " + ap1 + " → " + F().state().ap + " · 装甲 " + armor1 + " → " + F().deck().foeArmor);
  A(EL.fight2Bar.style.display !== "block", "出招**不**打开判定条（推条已从攻击链路删除）",
    "bar.display=" + JSON.stringify(EL.fight2Bar.style.display));
}

/* ── 玩法可读性：图例 / 招式定位 / 常驻操作提示 ──────────────────────────
   为什么要有这组：这三样都是**玩家实测反馈**才发现的缺失 ——
     · 判定条没有图例，玩家不知道游标要进绿带、金色块是完美区；
     · 按钮只写「精准」二字，读不出"精准 = 要推判定条"；
     · 规则原文在面板顶部的 #fight2Sub 里，打起来一滚就看不见，
       于是"对手出招要按方向闪"这条也没人看到。
   它们很容易在后续改动里被悄悄删掉（删了不影响任何机制断言），所以钉在这里。
   ⚠ 卡牌阶段改版后，"怎么出招"从"推条进绿带"变成了"点牌翻开 → 点牌出招"，
     这一组跟着换口径：守的不再是"三档说明写清楚了"，而是
     "**现在该干什么**写在常驻状态行里、而且三档已经从 fight2 撤掉了"。
   ⚠ 已记名的产品侧遗留（不由这里断言，见交接报告）：#fight2Sub 在 act 阶段仍拼着
     「游标扫进绿带…金色块=完美 ×1.9…偏出 ×0.7」这段文案，FIGHT2_CARDS.jab.t 也还写着
     「完美 ×1.9」—— 都是被删掉的推条机制的残留，玩家看得见但已经不成立。 */
{
  /* ① 操作说明 —— #fight2Legend 那一整行已隐藏，说明改由状态行 #fight2Num 常驻。
     ⚠ 原来这条断言的是"#fight2Sub 把三档（绿带/金色块/偏出）写清楚了" ——
       三档已从 fight2 删除，那条断言守的是**已经不存在的机制**
       （而且会被 index.html 里那段没清掉的残留文案一直喂绿），
       所以改成守"新玩法的操作说明 + 旧机制的缺席"。 */
  newFight();
  const subOf = () => plain(EL.fight2Sub.innerHTML);
  const hintOf0 = () => plain(EL.fight2Num.innerHTML);
  A(!/绿带|金色块|偏出/.test(hintOf0()),
    "「现在该干什么」里不再提三档（推条已从攻击链路删除）", hintOf0().slice(-44));
  A(/点牌/.test(subOf()) || /点牌/.test(hintOf0()), "操作说明还在（点牌出招）",
    subOf().slice(0, 40) + " ｜ " + hintOf0().slice(-30));
  A(EL.fight2Legend.style.display === "none",
    "旧的独立图例行已隐藏（不再挤压手牌区）",
    "legend.display=" + JSON.stringify(EL.fight2Legend.style.display));

  /* 出招 → **立刻结算**，中间没有"等你落判"那一态。
     这是原「出招后判定条出现（前提）」的替代：原来那个"前提"要守的是
     "出招之后有一个等玩家落判的中间态"，现在中间态不存在了，所以改守它的反面 ——
     出招后①装甲当场被扣（伤害已经算完）②判定条面板没被打开。 */
  const armor0 = F().deck().foeArmor;
  F().act("jab");
  A(F().deck().foeArmor < armor0, "出招立刻结算（装甲当场被扣，没有等落判的中间态）",
    "装甲 " + armor0 + " → " + F().deck().foeArmor);
  A(F().bars().bar.style.display !== "block", "出招不再打开判定条（卡牌按卡面数值结算）",
    "bar=" + JSON.stringify(F().bars().bar.style.display));

  /* ② 招式定位写在**牌面**上（原按钮文案已随按钮一起退役）：
     要读判定 / 确定伤害 / 回体干 / 看意图 / 加血，都要在卡池里看得出来。 */
  const C = evalConstIn(html, "FIGHT2_CARDS");
  const desc = (k) => (C[k] ? C[k].n + " " + C[k].t + " " + C[k].v : "");
  A(!!(C.jab && C.combo && C.jab.type === "atk" && C.combo.type === "atk"),
    "攻牌定位正确（直拳 / 组合拳 type=atk）", desc("jab").slice(0, 26) + " / " + desc("combo").slice(0, 26));
  A(/恒定|不赌/.test(C.low.t), "低扫牌写明「恒定伤害、不赌手感」", desc("low").slice(0, 30));
  A(/格挡/.test(C.guard.t) && /体干/.test(C.guard.t), "抱架牌写明格挡与体干", desc("guard").slice(0, 26));
  A(/公示/.test(C.read.t), "读招牌写明公示意图", desc("read").slice(0, 26));
  A(C.breathe.type === "heal" && /回血|回合/.test(C.breathe.t),
    "喘息是治疗牌且写明代价（让回合）", desc("breathe").slice(0, 30));
  A(C.unload.type === "def" && /减半/.test(C.unload.t), "卸力是防守牌（下次受击减半）", desc("unload").slice(0, 26));
  A(C.counterup.type === "sk" && /反击/.test(C.counterup.t), "蓄势是技能牌（打开反击窗口）", desc("counterup").slice(0, 26));
  /* 四类都要有牌，否则"可以攻击、可以加血、可以技能"就不成立 */
  const types = Object.keys(C).map((k) => C[k].type);
  ["atk", "def", "sk", "heal"].forEach((tp) => {
    A(types.indexOf(tp) >= 0, "牌池覆盖类型 " + tp, types.join(","));
  });

  /* ③ 常驻操作提示：底部状态行按阶段给"现在该干什么"。
     卡牌阶段第一步是**翻开**（翻开不花行动力），所以"第一次操作前就把怎么玩说出来"
     这条要守的是"点牌翻开看看这回合抽到什么（翻开不花行动力）"里那两半信息：
     点哪张 / 这一步不花行动力。少了任何一半，玩家都会以为点牌就要付行动力。 */
  newFight();
  const hintOf = () => plain(EL.fight2Num.innerHTML);
  A(/点牌/.test(hintOf()), "轮到你时提示怎么出招（点牌开局）", hintOf().slice(-44));
  A(/翻开/.test(hintOf()) && /不花行动力/.test(hintOf()),
    "第一次出招前就把「点牌翻开（不花行动力）」说出来了", hintOf().slice(-44));
  /* 提示不是一句写死的开场白：把手牌全翻开（这一步不花行动力）之后必须改口。
     ⚠ 别用 setHand() 构造这一步：setHand 只换 hand、不重置 hidden，
       两边的长度会不一致，hintNow 的"全背面"判据（faceDown === hand.length）就失效了。 */
  const hint0 = hintOf();
  const d3 = F().deck();
  d3.hidden.forEach((h, i) => { if (h) F().playCard(i); });
  A(F().deck().hidden.every((h) => h === false), "（前置）四张牌都翻开了",
    "hidden=" + JSON.stringify(F().deck().hidden));
  A(/点已翻开/.test(hintOf()) && hintOf() !== hint0,
    "翻完牌后提示跟着状态改口成「点已翻开的牌出招」（不是写死的开场白）",
    hint0.slice(-22) + " → " + hintOf().slice(-30));
  F().set({ ap: 0 });   // set() 内部会 render()，所以提示会跟着更新
  A(/用完/.test(hintOf()) || /他的回合/.test(hintOf()), "行动力用完后提示改口", hintOf().slice(-38));

  /* 防守阶段（另起一局，避免上一段把回合弄僵） */
  newFight();
  advanceToDefend();
  A(F().state().phase === "defend", "确实进入了防守阶段（前提）", "phase=" + F().state().phase);
  A(/←/.test(hintOf()) && /闪/.test(hintOf()), "对手出招时提示按方向闪开", hintOf().slice(-48));
  A(EL.fight2Legend.style.display === "none", "防守时不显示判定条图例（那时没有判定条）",
    "legend.display=" + JSON.stringify(EL.fight2Legend.style.display));
  let g = 0;
  while (F().state().phase === "defend" && g++ < 200) api.step();
}

/* ── 推条已从 fight2 退役：它确实被删干净了吗？ ───────────────────────────
   玩家实测原话（两次反馈）："完美区还是太难瞄，盯着游标进绿带点了，可是直接跳过了
   根本没反应"、"不需要什么进入绿条点击，鸡肋的很"。于是三档判定连同输入缓冲、
   攻击用的推条一起砍掉，取而代之的是明牌机制（装甲 / 连段 / 体力）。
   原来这一组守的是"完美区够得着 + 提前点击不被吞"，那两条的对象已经不存在了 ——
   但**不能静默消失**：换成一整套"它确实被删干净了"的守门断言。
   为什么非要守"删干净"：这三样东西一旦被谁接回攻击流程（比如又想加个暴击），
   光看别的用例是发现不了的 —— 它们只会在玩家那里表现为"怎么又要瞄了"。
   做法分两层：
     ① 源码层：startFight2 的函数体里不再出现这些名字（最硬的证据）；
     ② 运行层：出招不会打开判定条 / 不会挂回调 / 点它不会有任何反应。
   ⚠ 判定条本身**没有**从工程里删掉：旧 fight 面板（拳击馆剧情）与 fight2 的
     防守窗口都还在用它，那两个链路由 tests/fight-loop.test.cjs、tests/judge-bar.test.cjs
     守着。所以这里只断言"fight2 的**攻击**链路不再引用它"。 */
{
  const SRC = grabFn(html, "startFight2");
  A(!/BAR_SPEED|INPUT_GRACE/.test(SRC),
    "fight2 的代码里不再引用推条手感调参（FIGHT2_TUNE.BAR_SPEED / INPUT_GRACE 已是死配置）",
    "命中：" + (SRC.match(/BAR_SPEED|INPUT_GRACE/g) || []).join(",") || "无");
  A(!/judgeGrade/.test(SRC), "fight2 不再引用三档判定表 judgeGrade（倍率表只留给旧 fight 面板）",
    "命中：" + (SRC.match(/judgeGrade/g) || []).join(",") || "无");
  A(!/mashLoop/.test(SRC), "fight2 不再引用连打（手速要素整个退役）",
    "命中：" + (SRC.match(/mashLoop/g) || []).join(",") || "无");
  /* precision() 只剩一个"确定命中"的空壳（保留函数名，调用点不用改） */
  A(/function precision\(cb\)\{\s*cb\("flat"\);\s*\}/.test(SRC),
    "precision() 已是确定命中（cb(\"flat\")），不再开任何判定条",
    (SRC.match(/function precision\(cb\)\{[^}]*\}/) || ["没找到"])[0]);
  /* 攻击链路里不能出现 judgeBar 的调用参数（防守窗口那两处是**保留**的）：
     数一下 startFight2 里 judgeBar( 的出现次数，应当只有防守窗口那 2 处。 */
  const barCalls = (SRC.match(/judgeBar\(\{/g) || []).length;
  A(barCalls === 2, "judgeBar 在 fight2 里只剩防守窗口那两处调用（攻击链路一处都没有）",
    "judgeBar({ × " + barCalls);

  /* 运行层：出招不打开判定条、点它也没反应（旧落判入口已死） */
  newFight();
  api.setRng(0.5);
  const foe0 = F().state().foeHp, armor0 = F().deck().foeArmor;
  F().act("jab");
  const B = F().bars();
  A(B.bar.style.display !== "block", "出招不打开判定条（旧「判定条已开出」那条前提的反面）",
    "display=" + JSON.stringify(B.bar.style.display) + " onclick=" + String(B.bar.onclick));
  A(F().deck().foeArmor < armor0, "出招当场结算（伤害不等落判）",
    "装甲 " + armor0 + " → " + F().deck().foeArmor + " · 对手 " + foe0 + " → " + F().state().foeHp);
  const ap1 = F().state().ap, foe1 = F().state().foeHp;
  B.bar.click();                                   // 旧落判入口：点一下应当什么都没发生
  A(F().state().ap === ap1 && F().state().foeHp === foe1,
    "点判定条不再造成任何伤害、也不推进回合（缓冲窗口那套已经不存在了）",
    "ap " + ap1 + " → " + F().state().ap + " · 对手 " + foe1 + " → " + F().state().foeHp);
}

/* ── 招式经济：每个招式都要有存在的理由 ──────────────────────────────────
   为什么单独测：玩家实测问过"蓄力连按很多下的意义是什么" —— 查下去发现组合拳
   连打 10 下总共只有 19 伤害，而直拳完美是 23：**这个招式的收益是负的**。
   这类"数值上没有意义"的选项不会有任何机制断言去抓，所以在这里钉住两条边界。
   ⚠ 卡牌阶段之后，下面这段算术**已经不对应 fight2 的实际伤害**了：
     三档（FIGHT_GRADE_MULT）与连打（comboMash / COMBO_BONUS_CAP）都从攻击流程里删掉，
     comboMash 现在没有任何调用点。实战数值是：
       直拳 12 / 2AP · 低扫 17 / 2AP · 组合拳 8+4=12 / 2AP · 重拳 26 / 3AP（破甲、无视装甲）
     —— 也就是说**组合拳在数值上被低扫完全压制**（同为 2AP，12 < 17，破甲还轮不到它）。
     这几条断言暂时保持原样（它们证明的是"调参表里那条早已不被调用的曲线形状正确"），
     但别把它当成"组合拳有存在理由"的证据；这条数值问题已记进交接报告，
     等策划重调卡面数值时一并处理。 */
{
  /* 招式经济（卡牌阶段口径）。
     ⚠ 这一组原来守的是"连打曲线"（`bone(c) = ⌊(c-3)×2.6⌋`、`COMBO_BONUS_CAP`）——
       连打已随推条一起删除，那条曲线与 `comboMash` 都成了死代码，
       于是原来 5 条断言会**一直喂着死代码**（删了就红，等于用测试把死代码钉住）。
       现在改成守新机制：组合拳两段的总伤必须**高于**直拳（否则这张牌没有存在意义 ——
       这正是玩家最初问"连按很多下的意义是什么"的根因），且二段按 ×CHAIN_MULT 递进。 */
  const MV = evalConstIn(html, "FIGHT2_MOVES");
  const T2 = evalConstIn(html, "FIGHT2_TUNE");
  const first = MV.combo.dmg;
  const second = Math.round(first * T2.CHAIN_MULT);
  const comboTotal = first + second;

  A(comboTotal > MV.jab.dmg,
    "组合拳两段合计必须优于直拳（否则这张牌是负收益）",
    "组合拳 " + first + "+" + second + "=" + comboTotal + " vs 直拳 " + MV.jab.dmg);
  A(second > first,
    "二段比一段重（接力重击，不是把一段拆成两半）",
    "一段 " + first + " → 二段 " + second + "（×" + T2.CHAIN_MULT + "）");
  A(comboTotal > MV.low.dmg,
    "组合拳合计也要压过低扫（低扫的定位是「不吃手感、稳定」，不是「最赚」）",
    "组合拳 " + comboTotal + " vs 低扫 " + MV.low.dmg);
  /* 连打确实删干净了：源码里不该再有连打曲线与 comboMash 空壳 */
  {
    const body = html.slice(html.indexOf("function startFight2"));
    A(body.indexOf("function comboMash") < 0,
      "fight2 里不再有 comboMash（连打入口已随手速要素一起删除）", "已删");
    A(body.indexOf("Math.floor((c - 3) * 2.6)") < 0,
      "fight2 里不再有连打曲线（COMBO_BONUS_CAP 的那条公式）", "已删");
  }
  /* 每回合行动力要够出两次招，否则一局会被拖长 */
  A(T2.AP >= MV.jab.ap * 2, "每回合行动力够出两次主要招式（AP " + T2.AP + " ≥ " + MV.jab.ap + "×2）",
    "AP=" + T2.AP);
}

/* ── 卡牌系统：抽牌 / 打牌 / 洗牌 / 治疗 / 新卡效果 ──────────────────────
   为什么单独一组：从"固定 6 个按钮"改成"每回合抽牌"是系统级改动，
   而且它引入的全是新失败模式（手牌不刷新、抽牌堆空了不洗、点击不消耗牌…），
   这些都不会被原来的招式断言覆盖。 */
{
  /* ① 开局抽牌 */
  /* 牌堆张数从**真实函数**算（体魄/智慧会加牌，写死 12 会随属性变化而失效） */
  const DECK_N = F().deckSize();
  const d0 = F().deck();
  A(d0.hand.length === F2_TUNE.HAND_SIZE,
    "开局抽到 " + F2_TUNE.HAND_SIZE + " 张手牌", "手牌 " + d0.hand.length + "：" + d0.hand.join(","));
  A(d0.draw.length === DECK_N - F2_TUNE.HAND_SIZE,
    "抽牌堆剩下没发出去的那些（牌堆 " + DECK_N + " 张）",
    "抽牌堆 " + d0.draw.length + " · 弃牌 " + d0.discard.length);
  A(d0.hand.every((id) => !!evalConstIn(html, "FIGHT2_CARDS")[id]),
    "手牌里的每张 id 都能在卡池里查到（不会画出 undefined 的牌）", d0.hand.join(","));

  /* ② 打出一张牌：消耗行动力 + 进弃牌堆 + 手牌少一张
     ⚠ 用 playCardNow() 而不是 playCard() 一次：setHand() 只换 hand、**不重置 hidden**，
       构造出来的手牌第一次点只会被翻开（不花钱也不结算）—— 旧断言就是这么红的。 */
  newFight();
  F().setHand(["bandage"]);                       // 固定手牌，避免随机性
  const before = F().state();
  const ok = playCardNow(0);
  const after = F().state();
  A(ok === true, "点牌就能打出去（走的是和画布点击同一个函数）", "playCard(0) → " + ok);
  A(F().deck().hand.length === 0 && F().deck().discard.indexOf("bandage") >= 0,
    "打出的牌进了弃牌堆、手牌少一张",
    "手牌 " + F().deck().hand.length + " · 弃牌 " + F().deck().discard.join(","));
  A(after.ap === before.ap - 1, "止血消耗 1 点行动力", before.ap + " → " + after.ap);

  /* ③ 行动力不够时打不出去，并且**要说出来**（不说的话玩家以为点击没生效） */
  newFight();
  F().setHand(["heavy"]);                         // 重拳 3 AP
  F().set({ ap: 1 });
  const heavyOk = playCardNow(0);
  A(heavyOk === false && F().deck().hand.length === 1,
    "行动力不足时打不出去、手牌不消耗", "ap=1 打重拳 → " + heavyOk);
  A(/行动力不够/.test(plain(lastRow())), "而且会把原因写进日志（不是静默失败）",
    plain(lastRow()).slice(0, 30));

  /* ④ 回合刷新：手牌全弃、重新抽
     ⚠ 驱动必须用 endTurn()：`set({ap:0})` 只是把数字清零，**不会**触发 endTurn
       （act() 在 ap<=0 时直接 return），原来靠 advanceToDefend() 推进的话
       循环 30 次也进不了防守阶段，phase 一直停在 act ——
       于是"新回合重新抽满手牌"是在拿**没变过的**旧手牌断言，属于假通过
       （实测那一版 弃牌=0，上回合的手牌原封不动躺在 hand 里）。 */
  newFight();
  const handBefore = F().deck().hand.join(",");
  F().set({ ap: 0 });
  F().endTurn();                                  // 行动力用尽 → 交回合（玩家的真实路径）
  let g = 0; while (F().state().phase === "defend" && g++ < 200) api.step();
  const d1 = F().deck();
  A(d1.hand.length === F2_TUNE.HAND_SIZE, "新回合重新抽满手牌", "手牌 " + d1.hand.length);
  A(d1.discard.length >= 1, "上一回合的手牌进了弃牌堆（回合结束不做保留）",
    "弃牌 " + d1.discard.length + "（上回合手牌 " + handBefore + "）");
  A(d1.hand.length + d1.discard.length + d1.draw.length === DECK_N,
    "牌张守恒：手牌 + 弃牌堆 + 抽牌堆 = 牌堆总数（一张都没丢）",
    d1.hand.length + "+" + d1.discard.length + "+" + d1.draw.length + " = " +
    (d1.hand.length + d1.discard.length + d1.draw.length) + " / " + DECK_N +
    "（上回合手牌 " + handBefore + "）");

  /* ⑤ 抽牌堆空了要把弃牌堆洗回来（否则几回合后无牌可抽）
     ⚠ 原来这条只断言"弃牌堆里有牌可洗"，洗牌那段代码一次都没跑过。
       这里补上真实路径：清空抽牌堆 → 打出一张（进弃牌堆）→ 过一回合，
       startTurn 里的 drawCards 必须把弃牌堆洗回来，并且把这件事写进日志。 */
  newFight();
  F().setDraw([]);                                // 抽牌堆清空
  F().setHand(["jab"]);
  F().set({ ap: 4 });
  playCardNow(0);                                 // 打出的牌进弃牌堆
  const d2 = F().deck();
  A(d2.discard.indexOf("jab") >= 0 && d2.draw.length === 0,
    "（前置）抽牌堆空、弃牌堆里有牌可洗", "弃牌 " + d2.discard.join(",") + " · 抽牌堆 " + d2.draw.length);
  F().endTurn();
  let g5 = 0; while (F().state().phase === "defend" && g5++ < 200) api.step();
  const d2b = F().deck();
  A(d2b.hand.indexOf("jab") >= 0, "抽牌堆空了也能抽到牌（弃牌堆洗回来了，不会卡死无牌可抽）",
    "手牌 " + d2b.hand.join(",") + " · 抽牌堆 " + d2b.draw.length + " · 弃牌 " + d2b.discard.length);
  A(/洗回抽牌堆/.test(plain(EL.fight2Log.innerHTML)), "洗牌这件事写进了日志（玩家看得见）",
    plain(EL.fight2Log.innerHTML).slice(-40));

  /* ⑥ 新卡效果：卸力（下次受击减半）
     ⚠ 三个都踩过坑，写下来免得再犯：
       ① 用 set({ap:0}) 直接清零**不会**触发 endTurn，phase 一直停在 act，
          挨打根本没发生 → 断言假通过。要用"打牌把行动力用光"这条真实路径。
       ② 耗行动力别用抱架：4 张抱架叠 80 格挡，伤害全被挡掉，测不出减半。
          用止血（1 AP、只回血不格挡）来耗。
       ③ 打牌要走 playCardNow()（setHand 之后手牌还是背面，第一次点只翻开）。 */
  newFight();
  F().setHand(["bandage", "bandage", "bandage", "bandage"]);
  playCardNow(0); playCardNow(0); playCardNow(0); playCardNow(0);
  A(F().state().phase === "defend", "（前置）四张牌把行动力用光 → 进入防守窗口",
    "ap=" + F().state().ap + " phase=" + F().state().phase);
  const hpBefore = F().state().hp;
  let g2 = 0; while (F().state().phase === "defend" && g2++ < 200) api.step();   // 不按方向 → 硬吃
  const baseLoss = hpBefore - F().state().hp;
  A(baseLoss > 0, "（前置）硬吃确实掉了血（无卸力时的基准）", "掉血 " + baseLoss);

  /* 同样硬吃一次，但这次先打一张卸力 */
  newFight();
  F().setHand(["unload", "bandage", "bandage", "bandage"]);
  playCardNow(0);                                 // 卸力（1 AP）
  A(F().deck().unload === 1, "卸力打出去后层数 +1", "unload=" + F().deck().unload);
  playCardNow(0); playCardNow(0); playCardNow(0); // 三张止血 → 用光行动力
  A(F().state().phase === "defend", "（前置）卸力那局也进了防守窗口", "phase=" + F().state().phase);
  const hpB2 = F().state().hp;
  let g3 = 0; while (F().state().phase === "defend" && g3++ < 200) api.step();
  const hpA2 = F().state().hp;
  A(/卸力减半/.test(plain(lastRow())), "挨打时日志标注「卸力减半」", plain(lastRow()).slice(0, 50));
  A(F().deck().unload === 0, "卸力是消耗品（用掉就没了）", "unload=" + F().deck().unload);
  A(hpB2 - hpA2 < baseLoss, "有卸力时这一击比基准更轻",
    "基准掉 " + baseLoss + " → 有卸力掉 " + (hpB2 - hpA2));

  /* ⑦ 新卡效果：止血回血、喘息回更多但让回合 */
  newFight();
  F().set({ hp: 50 });
  F().setHand(["bandage"]);
  const hp0 = F().state().hp;
  playCardNow(0);
  A(F().state().hp === hp0 + 9, "止血回 9 点", hp0 + " → " + F().state().hp);

  newFight();
  F().set({ hp: 50 });
  const turnBefore = F().state().turn;
  F().setHand(["breathe"]);
  playCardNow(0);
  A(F().state().hp === 68, "喘息回 18 点", "50 → " + F().state().hp);
  A(F().state().phase === "defend" || F().state().turn > turnBefore,
    "喘息的代价：回合交给对手（进了防守窗口或已推进回合）",
    "phase=" + F().state().phase + " turn " + turnBefore + " → " + F().state().turn);
}

console.log("");
console.log("[结果] 通过 " + pass + "，失败 " + fails.length + (fails.length ? "" : "，全部通过 ✔"));
if (fails.length) { console.log("失败项："); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fails.length ? 1 : 0);
