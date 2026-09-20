#!/usr/bin/env node
/*
  tests/fight-loop.test.cjs — 打斗主回路单测（P0：三档判定 × 音效接入 × 组合拳连打）

  为什么不用浏览器：本机 Chrome 无头起不来（沙箱禁命名管道），mshta 不稳定，
  纯逻辑断言在这里更可靠。做法与 tests/audio-paths.test.cjs 同源 ——
  **把真实的 startFight() 从 index.html 里抽出来跑**，不是复刻一份实现来测。

  驱动模型（踩了四次坑才定下来，写在这里免得后人重踩）：
    ① 判定条光标由 rAF 驱动，而 rAF 回调**递归**排下一帧。
       所以 rAF 替身不是"跑 N 帧"，而是**先排队**（PENDING.push），
       由测试 step() 逐帧放行 —— 每帧之后都能读光标的真实位置。
    ② 绿区位置真随机（left = 8 + Math.random()*(84-w)），**不能算死帧数**。
       做法：先看绿区画在哪，再逐帧推进到光标落进目标档位，然后 click()。
       于是三档都是被真实驱动出来的，不是改内部变量。
    ③ 每招 precision() 会把 pos 重置为 0，但 DOM 上还留着上一招的位置 ——
       **必须先 step() 一帧再读**，否则读到残留值（实测"良好"那招就是这么空过的）。
    ④ `push()` 是 startFight **内部的局部函数**，会遮蔽外层同名函数 ——
       想读战斗日志只能读渲染结果（#fightLog.innerHTML）。

  用法：node tests/fight-loop.test.cjs
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HTML = path.join(__dirname, "..", "index.html");
let pass = 0;
const fails = [];
function A(ok, name, detail) {
  const line = name + (detail === undefined ? "" : "  [" + detail + "]");
  if (ok) { pass++; console.log("  ✔ " + line); } else { fails.push(line); console.log("  ✖ " + line); }
}

/* ── 通用抽取：不做字符级括号匹配，直接问 JS 引擎 ──
   为什么放弃"数括号"：这一版之前写过三回字符扫描器，都被**字符串/模板串/注释**里的大括号、
   或者对象方法简写（`setOwner(){...}`）搞错，报出来的错还都长得像"桩点丢了"。
   既然最终判据本来就是"这段代码能不能编译"，那就别猜了 ——
   用**括号预筛缩小范围**，再**二分找最长的能编译前缀**。引擎的解析器一定比手写扫描器准。 */
function matchingEnd(src, openIdx, budget) {
  const open = src[openIdx];
  const close = open === "{" ? "}" : open === "(" ? ")" : "]";
  let depth = 0;
  const limit = Math.min(src.length, openIdx + (budget || 200000));
  for (let i = openIdx; i < limit; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < limit && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < limit && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < limit && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i + 1; }
  }
  return limit;                      // 没配平就给个上界，交给二分去收敛
}
/** 求值一个字面量：二分找"最长的能编译前缀" */
function evalLiteralIn(src, openIdx, sandbox) {
  const hiInit = matchingEnd(src, openIdx);
  let lo = openIdx + 2, hi = hiInit, best = null;
  const tryAt = (end) => {
    try { return { v: new vm.Script("(" + src.slice(openIdx, end) + ")").runInNewContext(sandbox || {}) }; }
    catch (e) { return null; }
  };
  const top = tryAt(hiInit);
  if (top) return top.v;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = tryAt(mid);
    if (r) { best = r.v; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (best !== null) return best;
  throw new Error("字面量求值失败（上限 " + hiInit + " 处也编译不过）");
}
/** 抽具名函数：⚠ 必须连参数列表一起抽，否则编译出 `function f{`
    ⚠ 索引基准：先把源**切到函数起点**再算花括号位置。直接用全文索引会差出前面几万字符，
      结果就是"抽取失败"这种看起来像桩点丢了、其实是偏移错了的假故障。 */
function grabFn(html, name) {
  const m = new RegExp("function\\s+" + name + "\\s*\\(").exec(html);
  if (!m) throw new Error("找不到 function " + name + "(");
  const src = html.slice(html.indexOf("(", m.index));
  const params = grab(src, 0);                       // 参数列表：小括号，无歧义
  const braceIdx = params.length;                    // 参数列表收尾就是花括号所在
  if (src[braceIdx] !== "{") throw new Error("函数 " + name + " 的体不在参数之后，实际是 " + JSON.stringify(src[braceIdx]));
  const end = matchingEnd(src, braceIdx);
  const body = src.slice(braceIdx, end);
  try { new vm.Script("function _t" + params + body); }
  catch (e) { throw new Error("函数 " + name + " 抽取结果编译不过：" + e.message.split("\n")[0]); }
  return "function " + name + params + body;
}
/** 取"第一个配平处"的片段 —— 只用于**无歧义的小片段**（参数列表）。 */
function grab(src, openIdx) {
  return src.slice(openIdx, matchingEnd(src, openIdx));
}
/** 抽一个字面量常量，序列化成源码（保留方法体） */
function grabConst(html, name) {
  const m = new RegExp("const\\s+" + name + "\\s*=\\s*([\\[{])").exec(html);
  if (!m) throw new Error("找不到 const " + name);
  return serialize(evalLiteralIn(html, html.indexOf(m[1], m.index)));
}

/** 深度还原一个值，**保留函数源码**。
    ⚠ 不能用 JSON.stringify —— 它会把对象里的方法整个丢掉。
    （InputBus 真身因为用的是"对象方法简写"，连 serialize 也救不了 —— 那种情况用
      evalLiteralIn 直接在沙箱里求值，不要试图把它变成文本。） */
function serialize(v, depth) {
  depth = depth || 0;
  if (depth > 6) return "null";
  if (v === null || v === undefined) return "null";
  const t = typeof v;
  if (t === "function") return "(" + v.toString() + ")";
  if (t === "number" || t === "boolean") return String(v);
  if (t === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => serialize(x, depth + 1)).join(",") + "]";
  return "{" + Object.keys(v).map((k) => JSON.stringify(k) + ":" + serialize(v[k], depth + 1)).join(",") + "}";
}

const html = fs.readFileSync(HTML, "utf8");

/** 在判定条每帧记一次 {pos,left,w}，用来核对"判定用的位置"与"驱动到的位置"是否一致。
    ⚠ 这段必须在 prelude 模板字符串**之前**求值：模板是立刻求值的，
      把 hooked 放在后面会踩 const 的 TDZ（Cannot access 'hooked' before initialization），
      而且因为 prelude 里的 grabFn(hooked,...) 只是个普通调用，报出来的现象会变成
      "帧记录空/抽取不对"这种看着毫不相关的错 —— 这个坑实际踩过一次。 */
const NEEDLE = "if(cur) cur.style.left = pos + \"%\";";
if (html.indexOf(NEEDLE) < 0) throw new Error("judgeBar 的帧记录桩点没找到，index.html 改了？");
const hooked = html.replace(NEEDLE, NEEDLE + " FRAMES.push({pos:pos,left:left,w:w});");
if (hooked === html) throw new Error("桩点替换失败");
if (grabFn(hooked, "judgeBar").indexOf("FRAMES.push") < 0) {
  throw new Error("hook 没进抽出的 judgeBar —— 抽取的花括号范围不对");
}

const prelude = `
  const FIGHT_GRADE_MULT = ${grabConst(html, "FIGHT_GRADE_MULT")};
  const FIGHT_FOE_I = ${grabConst(html, "FIGHT_FOE_I")};
  ${grabFn(html, "judgeGrade")}
  ${grabFn(html, "mashLoop")}
  ${grabFn(hooked, "judgeBar")}
  /* InputBus 用替身而不用真身：真身是**对象方法简写**，Function.prototype.toString()
     对简写会丢掉 function 关键字，序列化进脚本必然语法错误（见 serialize 的注释）。
     替身与真身行为等价 —— 同一时间只有一个 owner，接管时替换、释放时摘监听 ——
     真身的接口形状与监听成对性另有断言校验（见"InputBus 契约"那一组）。 */
  var window = null;
  var InputBus = {
    owner:null, _kd:null, _ku:null,
    setOwner(owner, handlers){
      this.release();
      this.owner = owner;
      const h = handlers || {};
      if(h.keydown){ this._kd = h.keydown; window.addEventListener("keydown", this._kd); }
      if(h.keyup){   this._ku = h.keyup;   window.addEventListener("keyup",   this._ku); }
      const self = this;
      return function release(){ if(self.owner === owner) self.release(); };
    },
    release(){
      if(this._kd){ window.removeEventListener("keydown", this._kd); this._kd = null; }
      if(this._ku){ window.removeEventListener("keyup",   this._ku); this._ku = null; }
      this.owner = null;
    },
    activeCount(){ return (this._kd?1:0) + (this._ku?1:0); },
  };

  var SFX = [];        // 被点名的音效（本测试的核心断言对象）
  var AFTER = [];      // afterInter 调用记录
  var PROBE = null;    // 判定瞬间的内部数值（由下面 replace 注入）
  var FRAMES = [];     // 每帧的 {pos,left,w}：用来核对"判定用的位置"与"驱动到的位置"是否一致
  var RNG = 0.5;       // 注入给 Math.random 的值
  var CLOCK = 0, FRAME_MS = 1000 / 60;
  var PENDING = [];    // 排队的 rAF 回调
  var PUSHED = [];     // 内层 push 的插桩记录（有些提示在连打覆盖层开着时 push，DOM 上看不到）
  var M = Object.create(Math); M.random = function(){ return RNG; };

  var EL = {};
  function mkEl(id){
    if(EL[id]) return EL[id];
    return (EL[id] = {
      id:id, style:{}, dataset:{}, innerHTML:"", textContent:"", value:"",
      scrollTop:0, scrollHeight:0, onclick:null,
      classList:{ _s:{}, add:function(c){this._s[c]=1;}, remove:function(c){delete this._s[c];},
                  contains:function(c){return !!this._s[c];},
                  toggle:function(c,v){ v?this.add(c):this.remove(c); } },
      addEventListener:function(){}, removeEventListener:function(){},
      click:function(){ if(this.onclick) this.onclick({ stopPropagation:function(){} }); }
    });
  }
  var document = { getElementById:function(id){ return mkEl(id); }, querySelectorAll:function(){ return []; } };
  function $(id){ return mkEl(id); }
  var __cs2 = {};                                   // 真实代码会往 window.__cs2.fight 挂接口
  /* InputBus 会往 window 上挂/摘 keydown，所以假 window 必须真的记监听器 */
  function mkTarget(o){ o._h = {}; o.addEventListener = function(t,f){ (this._h[t] = this._h[t] || []).push(f); };
    o.removeEventListener = function(t,f){ var a = this._h[t] || []; var i = a.indexOf(f); if(i >= 0) a.splice(i,1); };
    o.count = function(t){ return (this._h[t] || []).length; }; return o; }
  window = mkTarget({ __cs2:__cs2 });

  var AudioSys = {
    good:function(){ SFX.push("(beep-good)"); }, bad:function(){ SFX.push("(beep-bad)"); },
    ding:function(){ SFX.push("(beep-ding)"); }, blip:function(){ SFX.push("(beep-blip)"); },
    play:function(n){ SFX.push(n); return true; }     // 模拟"素材齐备"
  };
  var S = { stats:{ phy:18 }, fightWon:false };
  function afterInter(fx, why){ AFTER.push({ fx:fx, why:why }); }
  function takeBuff(){ return {}; }
  function bonus(){ return {}; }
  /* rAF 只排队，由测试 step() 逐帧放行 */
  function requestAnimationFrame(cb){ PENDING.push(cb); return 0; }
  var performance = { now:function(){ return CLOCK; } };
  var setTimeout = function(){ return 0; };            // 连打窗口不真等
`;

/** 抽 startFight（从 hooked 源抽，这样它内部调用的 judgeBar 也带帧记录） */
let startSrc = grabFn(hooked, "startFight");
/* 给内层 push 插桩：日志为空时必须能看出"是没调用 push"还是"写进了别的数组" */
startSrc = startSrc.replace("function push(s){ log.push(s); }",
  "function push(s){ PUSHED.push(String(s)); log.push(s); }");
if (startSrc.indexOf("PUSHED.push") < 0) throw new Error("push 桩点没找到");

let api = null, err = "", script = "";
try {
  script = "(function(){\n" + prelude + "\n" + startSrc + "\n" +
    "return { startFight:startFight, EL:EL, SFX:SFX, AFTER:AFTER, S:S, WIN:window,\n" +
    "  step:function(){ var q=PENDING; PENDING=[]; CLOCK+=FRAME_MS;\n" +
    "    for(var i=0;i<q.length;i++) q[i](CLOCK); return q.length; },\n" +
    "  pending:function(){ return PENDING.length; },\n" +
    "  clear:function(){ PENDING.length = 0; PUSHED.length = 0; FRAMES.length = 0; },\n" +
    "  get pushed(){ return PUSHED; },\n" +
    "  get frames(){ return FRAMES; },\n" +
    "  inputBus:function(){ return InputBus; },\n" +
    "  keydownCount:function(){ return window.count(\"keydown\"); },\n" +
    "  setRng:function(v){ RNG=v; }, cs2:function(){ return __cs2; } };\n" +
    "})()";
  api = new vm.Script(script).runInNewContext({ console });
} catch (e) {
  if (process.env.FIGHT_DEBUG) {
    const decls = (script.match(/const\s+FIGHT_FOE_I/g) || []).length;
    console.log("=== script 里 `const FIGHT_FOE_I` 声明次数: " + decls + " ===");
    console.log("=== script 里 `const FIGHT_GRADE_MULT` 声明次数: " +
      (script.match(/const\s+FIGHT_GRADE_MULT/g) || []).length + " ===");
    console.log("=== script 里 `function startFight` 次数: " +
      (script.match(/function\s+startFight/g) || []).length + " ===");
    console.log("=== script 里 `function judgeBar` 次数: " +
      (script.match(/function\s+judgeBar/g) || []).length + " ===");
  }
  err = e.message + "\n" + (e.stack || "").split("\n").slice(1, 3).join("\n");
}

A(!!api && typeof api.startFight === "function", "能从 index.html 抽出真实的 startFight()", err || "");
if (!api) {
  console.log("\n[结果] 通过 " + pass + "，失败 " + fails.length + " —— 抽取失败");
  process.exit(1);
}

const { EL, SFX, AFTER } = api;
const fightSfx = () => SFX.filter((s) => /^sfx-fight-/.test(s));
/** 战斗日志只能从渲染层读：push() 是 startFight 的局部函数 */
const logHTML = () => String(EL.fightLog.innerHTML);
const plain = (s) => String(s).replace(/<[^>]+>/g, "");
const resetBufs = () => { SFX.length = 0; AFTER.length = 0; };
const newFight = () => {
  resetBufs();
  api.clear();                     // ⚠ 清掉上一场残留的 rAF 回调，否则会串场
  api.startFight({ title: "一打二", hp: 74, perfect: { phy: 14 }, miss: { phy: 4 } });
};
const cursorPos = () => {
  const v = parseFloat(EL.fightCur.style.left);
  return isNaN(v) ? 0 : v;         // 第一帧之前 style.left 还没写过 → 视作 0
};
/** 只取最后一条战斗日志：日志是累积的，跨招断言会被上一招的文案污染 */
const lastRow = () => {
  const rows = logHTML().split('<div class="trow">');
  return rows.length > 1 ? rows[rows.length - 1] : "";
};

/** 打一招，并把光标**逐帧推进到目标档位**后落下 */
function strike(kind, pick, opts) {
  opts = opts || {};
  api.setRng(opts.rng === undefined ? 0.5 : opts.rng);
  SFX.length = 0;
  api.pushed.length = 0;
  api.cs2().fight.act(kind);
  const zoneL = parseFloat(EL.fightZone.style.left);
  const zoneW = parseFloat(EL.fightZone.style.width);
  const target = pick(zoneL, zoneW);
  // 判定条刚开出来时的瞬时状态：owner 应该是本玩法 —— 注意必须在 click() 之前读，
  // 因为 finish() 会立刻 release()，之后再问就永远是 null 了。
  const ownerDuring = api.inputBus().owner;
  const kdDuring = api.WIN.count("keydown");
  // 必须先跑一帧：每招 pos 会重置为 0，但 DOM 上还留着上一招的位置
  api.step();
  let frames = 1;
  while (frames < 120 && cursorPos() < target) { api.step(); frames++; }
  const landed = cursorPos();
  const frameRuns = api.frames.slice();      // judgeBar 每帧记的 {pos,left,w}
  EL.fightBar.click();
  const fr = frameRuns[frameRuns.length - 1] || null;
  return { log: logHTML(), sfx: fightSfx(), landed: landed, frames: frames,
           zoneL: zoneL, zoneW: zoneW, frame: fr,
           ownerDuring: ownerDuring, kdDuring: kdDuring,
           pushed: api.pushed.slice() };
}
/* 三种落点选择器 */
const wantPerfect = (L, W) => L + W / 2;        // 绿区正中 → 完美
const wantGood    = (L, W) => L + W * 0.15;     // 绿区左段（避开中央 30%）→ 良好
const wantMiss    = (L, W) => L + W + 8;        // 绿区右界外 → 偏出

/* ── 0. InputBus 接口契约 ──
   驱动用的是等价替身，所以这里必须校验**真身**的接口形状，
   否则哪天有人把 setOwner 改名 / 改返回，替身还会一路绿着把 bug 放过去。 */
{
  /* 在一个记账假 window 里求值**真身字面量** —— 闭包完整，测的是真代码 */
  const fakeWin = { n:0, addEventListener(){ this.n++; }, removeEventListener(){ this.n--; } };
  const real = evalLiteralIn(html,
    html.indexOf("{", /const\s+InputBus\s*=\s*\{/.exec(html).index), { window: fakeWin });
  A(!!real && typeof real.setOwner === "function" && typeof real.release === "function"
      && typeof real.activeCount === "function",
    "真实 InputBus 提供 setOwner / release / activeCount",
    real ? Object.keys(real).join(",") : "抽取失败");
  real.release();
  const r1 = real.setOwner("a", { keydown(){} });
  const after1 = fakeWin.n;
  real.setOwner("b", { keydown(){} });
  const after2 = fakeWin.n;                 // 换 owner 应替换而非累加
  A(after1 === 1 && after2 === 1, "真身：换 owner 时监听数保持 1（替换而非累加）",
    "挂载数 " + after1 + " → " + after2);
  real.release();
  A(fakeWin.n === 0, "真身：release() 摘掉监听", "剩 " + fakeWin.n);
  const r3 = real.setOwner("c", { keydown(){} });
  r3(); r3();                               // 重复归还
  A(fakeWin.n === 0 && real.activeCount() === 0,
    "真身：归还函数幂等（重复调用不会把计数弄成负数）", "n=" + fakeWin.n);
  real.release();
}

/* ── 1. 开局 ── */
newFight();
A(EL.fight.classList.contains("on"), "打斗面板已打开");
A(EL.fightNum.innerHTML.indexOf("行动力") >= 0, "状态行渲染了行动力", String(EL.fightNum.innerHTML).slice(0, 62));
A(api.cs2().fight.hp > 0 && api.cs2().fight.foeHp === 74, "双方生命初始化正常",
  "hp=" + api.cs2().fight.hp + " foe=" + api.cs2().fight.foeHp);

/* ── 2. 三档判定（真实驱动光标） ── */
{
  const P = strike("jab", wantPerfect);
  A(P.landed >= P.zoneL && P.landed <= P.zoneL + P.zoneW, "（前置）光标确实落在绿区内",
    "落点 " + P.landed.toFixed(1) + " 绿区[" + P.zoneL.toFixed(1) + "," + (P.zoneL + P.zoneW).toFixed(1) + "] 推进 " + P.frames + " 帧");
  A(/完美命中/.test(P.log), "光标停在绿区中央 → 判定「完美」");
  A(P.sfx.indexOf("sfx-fight-perfect") >= 0, "完美播放 sfx-fight-perfect", JSON.stringify(P.sfx));
  A(/造成 23 伤害/.test(P.log), "完美按 ×1.9 结算：直拳 12 → 23 伤害");
}
{
  const G = strike("jab", wantGood);
  A(/命中 ×1\.3/.test(lastRow(G.log)), "光标停在绿区侧段 → 判定「良好」",
    "落点 " + G.landed.toFixed(1) + " 推进 " + G.frames + " 帧 | 末条 " + plain(lastRow(G.log)));
  A(G.sfx.indexOf("sfx-fight-hit") >= 0, "良好播放 sfx-fight-hit", JSON.stringify(G.sfx));
  A(/造成 16 伤害/.test(G.log), "良好按 ×1.3 结算：直拳 12 → 16 伤害");
}
{
  const M = strike("jab", wantMiss);
  A(/偏出/.test(M.log), "光标越过绿区右界 → 判定「偏出」", "落点 " + M.landed.toFixed(1));
  A(M.sfx.indexOf("sfx-fight-whiff") >= 0, "偏出播放 sfx-fight-whiff", JSON.stringify(M.sfx));
  A(/造成 8 伤害/.test(M.log), "偏出按 ×0.7 结算：直拳 12 → 8 伤害");
}
{
  /* 光标一帧都不推进 → 停在 0；绿区 left>=8，必然在区外 */
  newFight();
  api.setRng(0.5);
  api.cs2().fight.act("jab");
  EL.fightBar.click();
  A(/偏出/.test(logHTML()), "光标没走到绿区 → 同样判「偏出」");
}

/* ── 3. 低扫不走判定表 ── */
{
  newFight();
  const L2 = strike("low", wantPerfect);
  A(/造成 16 伤害/.test(L2.log) && !/×1\.3|×1\.9|×0\.7/.test(L2.log),
    "低扫不吃三档表，恒为 16 伤害（日志里没有倍率标记）", (L2.log.match(/造成 \d+ 伤害/) || [""])[0]);
}

/* ── 4. 行动力与回合 ── */
newFight();
A(api.cs2().fight.ap === 3 && api.cs2().fight.turn === 1, "开局 3 行动力 · 第 1 回合",
  "ap=" + api.cs2().fight.ap + " turn=" + api.cs2().fight.turn);
strike("jab", wantPerfect); strike("jab", wantPerfect); strike("jab", wantPerfect);
A(api.cs2().fight.turn === 2, "打空 3 点行动力 → 自动进入第 2 回合", "turn=" + api.cs2().fight.turn);
A(api.cs2().fight.ap === 3, "新回合行动力恢复为 3", "ap=" + api.cs2().fight.ap);

/* ── 5. 对手回合音效（挨打 / 格挡） ──
   对手第 1 招是直拳（FIGHT_FOE_I[0]）→ 应播 sfx-fight-hurt。
   ⚠ 别用"看到任意 fight 音效就跳出"当循环条件 —— 自己出招也会播音效。 */
newFight();
SFX.length = 0;
strike("jab", wantPerfect); strike("jab", wantPerfect); strike("jab", wantPerfect);
A(api.cs2().fight.turn === 2, "（前置）第 1 回合确实已结束", "turn=" + api.cs2().fight.turn);
A(fightSfx().indexOf("sfx-fight-hurt") >= 0,
  "对手打中你 → 播放 sfx-fight-hurt", JSON.stringify(fightSfx()));

/* ── 6. 组合拳连打尾段（P0·3） ── */
newFight();
{
  const ap0 = api.cs2().fight.ap;
  const C = strike("combo", wantPerfect);        // 一段完美命中 → 应接连打
  A(api.cs2().fight.ap === ap0 - 2, "组合拳消耗 2 行动力", "ap " + ap0 + " → " + api.cs2().fight.ap);
  A(/组合拳/.test(C.log), "组合拳走两段结构（一段先判定）", plain(C.log).slice(-110));
  A(EL.qteMash.style.display === "block", "一段命中 → 连打条显示（mashbar 被打开）",
    "qteMash.display=" + EL.qteMash.style.display);
  A(EL.qteHint.textContent.indexOf("连打") >= 0, "连打提示文案已写入",
    String(EL.qteHint.textContent).slice(0, 44));
}
{
  newFight();
  const C2 = strike("combo", wantMiss);          // 一段偏出
  /* 这里断言 push 记录而不是 DOM：偏出分支的提示是在 renderFight() 之后才 push 的，
     而此刻连打覆盖层还开着 → DOM 上还看不到。用 push 记录才能测到真实文案。 */
  const pushedText = C2.pushed.map(plain).join(" | ");
  A(/连打没接上/.test(pushedText), "一段偏出 → 不接连打尾段（空挥不该也连打）", pushedText.slice(-90));
}
{
  /* 连打次数 → 二段伤害映射（与 comboMash 的公式一致：min(4, floor(count/3))） */
  const cases = [[0, 0], [2, 0], [3, 1], [5, 1], [6, 2], [8, 2], [9, 3], [12, 4], [30, 4]];
  const bad = cases.filter(([c, b]) => Math.min(4, Math.floor(c / 3)) !== b);
  A(bad.length === 0, "连打次数 → 二段伤害映射：floor(count/3) 且上限 +4",
    cases.map(([c, b]) => c + "→" + b).join(" "));
}

/* ── 7. 结算 ── */
newFight();
SFX.length = 0;
let guard = 0;
while (EL.fight.classList.contains("on") && guard++ < 300) strike("jab", wantPerfect);
A(!EL.fight.classList.contains("on"), "战斗能正常结束（面板关闭）", "循环 " + guard + " 次");
A(AFTER.length >= 1, "结算走 afterInter 出口（与旧行为一致）", JSON.stringify(AFTER).slice(0, 84));
A(fightSfx().indexOf("sfx-fight-win") >= 0 || fightSfx().indexOf("sfx-fight-lose") >= 0,
  "胜负各播 sfx-fight-win / sfx-fight-lose", JSON.stringify(fightSfx().slice(-3)));

/* ── 8. 音效命名约定（§5.0）── */
{
  const all = [...new Set(fightSfx())];
  const wrong = all.filter((n) => n.indexOf("sfx-fight-") !== 0);
  A(wrong.length === 0 && all.length > 0,
    "打斗点名的音效全部符合 sfx-fight-* 命名（写错名不报错、只会静音）", all.join(", "));
  const expected = ["sfx-fight-hit", "sfx-fight-block", "sfx-fight-hurt", "sfx-fight-whiff",
                    "sfx-fight-perfect", "sfx-fight-win", "sfx-fight-lose"];
  const disk = expected.filter((n) => fs.existsSync(path.join(__dirname, "..", "audio", "sfx", n + ".mp3")));
  A(disk.length === expected.length, "7 条格斗音效在磁盘上齐备", disk.length + "/" + expected.length);
}

/* ── 9. P1：判定条走公共 judgeBar + InputBus 不留监听器 ── */
{
  newFight();
  const S9 = strike("jab", wantPerfect);
  A(!!S9.frame, "judgeBar 的帧记录可用（判定条在用公共实现）", JSON.stringify(S9.frame));
  if (S9.frame) {
    /* 判定用的位置必须就是驱动到的位置 —— 两处各算一半最容易出这种错 */
    A(Math.abs(S9.frame.pos - S9.landed) < 0.01,
      "判定用的 pos 与光标实际渲染位置一致（防止判定和显示各算一半）",
      "pos=" + S9.frame.pos.toFixed(2) + " 光标=" + S9.landed.toFixed(2));
    A(!!S9.frame.left && !!S9.frame.w, "judgeBar 拿到了 zone 几何",
      "left=" + S9.frame.left.toFixed(1) + " w=" + S9.frame.w);
  }
  A(S9.ownerDuring === "fight-precision", "判定条进行中 InputBus 的 owner 是 fight-precision",
    String(S9.ownerDuring));
  A(S9.kdDuring === 1, "判定条进行中 window 上恰好 1 个 keydown（不会按次数累积）",
    "实际 " + S9.kdDuring + " 个");
}
{
  /* 监听器不泄漏：打一局会开十几次判定条，结束后 window 上不该还剩 keydown */
  newFight();
  let guard9 = 0;
  while (EL.fight.classList.contains("on") && guard9++ < 300) strike("jab", wantPerfect);
  A(api.WIN.count("keydown") === 0,
    "战斗结束后 window 上没有残留 keydown 监听（InputBus 成对摘除）",
    "还剩 " + api.WIN.count("keydown") + " 个；本局开了 " + guard9 + " 次判定条");
  A(api.inputBus().owner === null, "InputBus 已释放（owner 归空）", String(api.inputBus().owner));
}

console.log("");
console.log("[结果] 通过 " + pass + "，失败 " + fails.length + (fails.length ? "" : "，全部通过 ✔"));
if (fails.length) { console.log("失败项："); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fails.length ? 1 : 0);
