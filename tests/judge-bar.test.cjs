#!/usr/bin/env node
/*
  tests/judge-bar.test.cjs — 公共判定条 judgeBar + 键盘输入总线 InputBus 单测（P1）

  背景：打斗的「精准」与拳击馆的「蓄力反击」原本是两份几乎一样的光标+判定代码，
  差别只在参数（速度 2.2/1.6、时长 1.4s/无限、完美区来源）。P1 把它们合成一条 judgeBar。
  这个测试要守住两件事：
    ① 合成之后**行为不变** —— 拳击馆那场是"等玩家按、不超时"，打斗是"1.4 秒限时"，
       两种语义必须都还在（这是最容易在重构里丢掉的东西）；
    ② 多区间语义正确 —— 打斗要「完美/良好/偏出」三档，靠的是**完美区 + 良好区两条**。
       只给完美区会退化成两档（绿区里但不在中央的那段被判成打空），这个回归真实发生过。

  做法与 tests/audio-paths.test.cjs / tests/fight-loop.test.cjs 同源：
  **把真实的 judgeBar / InputBus 从 index.html 抽出来跑**，不是复刻实现。
  rAF 用"排队 + 逐帧放行"的替身，于是能把光标精确停在任意位置。

  用法：node tests/judge-bar.test.cjs
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HTML = path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(HTML, "utf8");

let pass = 0;
const fails = [];
function A(ok, name, detail) {
  const line = name + (detail === undefined ? "" : "  [" + detail + "]");
  if (ok) { pass++; console.log("  ✔ " + line); } else { fails.push(line); console.log("  ✖ " + line); }
}

/* ── 抽取（与 fight-loop.test.cjs 同一套：括号预筛 + 引擎校验）──
   踩过的坑：抽具名函数必须连参数列表一起抽，且索引基准要切到函数起点。 */
function matchingEnd(src, openIdx, budget) {
  const open = src[openIdx];
  const close = open === "{" ? "}" : open === "(" ? ")" : "]";
  let depth = 0;
  const limit = Math.min(src.length, openIdx + (budget || 200000));
  for (let i = openIdx; i < limit; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { const q = c; i++; while (i < limit && src[i] !== q) { if (src[i] === "\\") i++; i++; } continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < limit && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < limit && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i + 1; }
  }
  return limit;
}
function grab(src, o) { return src.slice(o, matchingEnd(src, o)); }
function grabFn(src, name) {
  const m = new RegExp("function\\s+" + name + "\\s*\\(").exec(src);
  if (!m) throw new Error("找不到 function " + name + "(");
  const s = src.slice(src.indexOf("(", m.index));
  const params = grab(s, 0);
  return "function " + name + params + s.slice(params.length, matchingEnd(s, params.length));
}
/** 抽一个"数据型"常量（不含方法简写，所以可以序列化） */
function grabDataConst(src, name) {
  const m = new RegExp("const\\s+" + name + "\\s*=\\s*([\\[{])").exec(src);
  if (!m) throw new Error("找不到 const " + name);
  const oi = src.indexOf(m[1], m.index);
  const lit = grab(src, oi);
  try { return JSON.stringify(new vm.Script("(" + lit + ")").runInNewContext({})); }
  catch (e) { throw new Error("常量 " + name + " 求值失败：" + e.message.split("\n")[0]); }
}

const prelude = `
  ${grabFn(html, "judgeBar")}
  ${grabFn(html, "mashLoop")}

  /* InputBus 用替身：真身是对象方法简写，Function.prototype.toString() 会丢掉 function 关键字，
     序列化进脚本必然语法错误。替身与真身行为等价（同一时间只一个 owner），
     真身另有契约断言（见"真身契约"那一组）。
     ⚠ window 由宿主通过 runInNewContext 注入（这里不要重新赋值），否则 InputBus 挂不上监听。 */
  var InputBus = {
    owner:null, _kd:null, _ku:null, _last:null,
    setOwner(owner, handlers){
      this.release();
      this.owner = owner; this._last = owner;
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

  var CLOCK = 0, FRAME_MS = 1000 / 60;
  var PENDING = [];
  var EL = {};
  function mkEl(id){
    if(EL[id]) return EL[id];
    return (EL[id] = { id:id, style:{}, classList:{ _s:{}, add:function(c){this._s[c]=1;},
      remove:function(c){delete this._s[c];}, contains:function(c){return !!this._s[c];} },
      onclick:null, textContent:"", innerHTML:"", addEventListener:function(){}, removeEventListener:function(){} });
  }
  function $(id){ return mkEl(id); }
  var S = { stats:{ phy:18 } };
  var AFTER = [];
  function afterInter(fx, why){ AFTER.push({ fx:fx, why:why }); }
  function takeBuff(){ return {}; }
  function bonus(){ return {}; }
  var KO_PERFECT = false;
  var AudioSys = { good:function(){}, bad:function(){}, ding:function(){}, blip:function(){} };
  function requestAnimationFrame(cb){ PENDING.push(cb); return 0; }
  var performance = { now:function(){ return CLOCK; } };
  var setTimeout = function(){ return 0; };
`;

/** 假 window：真的记监听器 */
function mkWindow() {
  const w = { _h: {} };
  w.addEventListener = (t, f) => { (w._h[t] = w._h[t] || []).push(f); };
  w.removeEventListener = (t, f) => { const a = w._h[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); };
  w.count = (t) => (w._h[t] || []).length;
  return w;
}

let api = null, err = "";
const fakeWin = mkWindow();            // 由宿主持有，注入沙箱后 InputBus 才挂得上监听
try {
  api = new vm.Script("(function(){\n" + prelude + "\n" +
    "return { judgeBar:judgeBar, EL:EL, AFTER:AFTER, S:S, WIN:window,\n" +
    "  step:function(){ var q=PENDING; PENDING=[]; CLOCK+=FRAME_MS;\n" +
    "    for(var i=0;i<q.length;i++) q[i](CLOCK); return q.length; },\n" +
    "  pending:function(){ return PENDING.length; },\n" +
    "  clear:function(){ PENDING.length = 0; AFTER.length = 0; },\n" +
    "  inputBus:function(){ return InputBus; },\n" +
    "  get koPerfect(){ return KO_PERFECT; },\n" +
    "  setRng:function(v){ var r=v; Math.random = function(){ return r; }; } };\n" +
    "})()").runInNewContext({ console, Math: Object.create(Math), window: fakeWin });
} catch (e) { err = e.message + "\n" + (e.stack || "").split("\n").slice(1, 3).join("\n"); }

A(!!api && typeof api.judgeBar === "function", "能从 index.html 抽出真实的 judgeBar()", err || "");
if (!api) { console.log("\n[结果] 通过 " + pass + "，失败 " + fails.length + " —— 抽取失败"); process.exit(1); }

const { EL, AFTER } = api;
/** 取（或建）一个假元素 —— 与 prelude 里的 mkEl 共用同一份缓存，
    所以判定条写进去的 style 在这里读得到。 */
function $(id) {
  if (!EL[id]) {
    EL[id] = {
      id: id, style: {}, onclick: null, textContent: "", innerHTML: "",
      addEventListener() {}, removeEventListener() {},
      classList: { _s: {}, add(c) { this._s[c] = 1; }, remove(c) { delete this._s[c]; },
                   contains(c) { return !!this._s[c]; } },
    };
  }
  return EL[id];
}

/** 开一条判定条，返回它的控制句柄与观测值 */
function openBar(opts) {
  opts = opts || {};
  api.clear();
  const zones = opts.zones || [
    { pct: [0.35, 0.65], grade: "perfect", relTo: "zone" },
    { pct: [0, 1], grade: "good", relTo: "zone" },
  ];
  const got = [];
  const bar = api.judgeBar({
    owner: opts.owner || "t", speed: opts.speed === undefined ? 2.2 : opts.speed,
    duration: opts.duration === undefined ? 1.4 : opts.duration,
    width: opts.width === undefined ? 20 : opts.width,
    left: opts.left === undefined ? 40 : opts.left,
    show: opts.show,
    els: { bar: $("bar"), zone: $("zone"), cursor: $("cur"), perfect: $("perf") },
    zones: zones,
    onDone: (g) => got.push(g),
  });
  return { bar: bar, got: got };
}

/* ── 1. 基本：光标按 speed 前进、位置写进 cursor ── */
{
  api.setRng(0.5);
  const B = openBar({ speed: 2.2, duration: 0, width: 20, left: 40 });
  api.step(); api.step(); api.step();
  A(Math.abs($("cur").style.left.replace("%", "") - 6.6) < 0.001,
    "speed=2.2 → 三帧后光标在 6.6%", $("cur").style.left);
  A($("zone").style.left === "40%" && $("zone").style.width === "20%",
    "区间几何写进了 zone 元素", $("zone").style.left + "/" + $("zone").style.width);
  A(B.got.length === 0, "还没落判 → 回调未触发", "got=" + JSON.stringify(B.got));
}

/* ── 2. 多区间：完美区 / 良好区（打斗的三档就靠这两条）── */
{
  /* 绿区 [40,60]；完美区 = 中央 30% → [47,53]；良好区 = 整条绿区 */
  const cases = [
    [50, "perfect", "绿区正中 → 完美"],
    [48, "perfect", "完美区左缘内 → 完美"],
    [52.9, "perfect", "完美区右缘内 → 完美"],
    [46, "good", "绿区左段（完美区外）→ 良好"],
    [54, "good", "绿区右段（完美区外）→ 良好"],
    [41.8, "good", "绿区左缘内侧（离边界 1.8）→ 良好"],
    [59.4, "good", "绿区右缘内侧 → 良好"],
    [39.6, "miss", "绿区左缘外侧 → 偏出"],
    [61.6, "miss", "绿区右缘外侧 → 偏出"],
  ];
  for (const [pos, want, desc] of cases) {
    api.setRng(0.5);
    const B = openBar({ speed: 2.2, duration: 0, width: 20, left: 40 });
    /* 逐帧推到目标位置：每帧 +2.2，取最近的帧 */
    const need = Math.round(pos / 2.2);
    for (let i = 0; i < need; i++) api.step();
    const actual = parseFloat($("cur").style.left);
    B.bar.click();
    A(B.got[0] === want, desc + "（pos≈" + actual.toFixed(1) + "，落判 " + B.got[0] + "）",
      "期望 " + want + " 实得 " + B.got[0]);
  }
}

/* ── 3. 只给完美区一条会退化成两档 ← 真实发生过的回归 ── */
{
  api.setRng(0.5);
  const B = openBar({ speed: 2.2, duration: 0, width: 20, left: 40,
    zones: [{ pct: [0.35, 0.65], grade: "perfect", relTo: "zone" }] });
  const need = Math.round(46 / 2.2);
  for (let i = 0; i < need; i++) api.step();
  B.bar.click();
  A(B.got[0] === "miss",
    "只给完美区时，绿区侧段会被判成 miss —— 所以打斗必须同时给良好区",
    "落判 " + B.got[0]);
}

/* ── 4. 超时语义：duration>0 到点自动落判；duration=0 永远等玩家 ── */
{
  api.setRng(0.5);
  const B = openBar({ speed: 2.2, duration: 1.4, width: 20, left: 40 });
  let frames = 0;
  while (B.got.length === 0 && frames < 200) { api.step(); frames++; }
  A(B.got.length === 1, "限时判定：1.4 秒到点自动落判（等玩家按就会卡死）",
    frames + " 帧后落判 " + B.got[0]);
  A(Math.abs(frames * (1000 / 60) - 1400) < 40, "落判时刻 ≈ 1.4 秒", (frames * 1000 / 60).toFixed(0) + "ms");
}
{
  api.setRng(0.5);
  const B = openBar({ speed: 2.2, duration: 0, width: 20, left: 40 });
  for (let i = 0; i < 300; i++) api.step();      // 5 秒
  A(B.got.length === 0, "拳击馆那场是「等玩家按」：duration=0 → 跑 5 秒也不落判（行为与改版前一致）",
    "got=" + JSON.stringify(B.got));
  B.bar.click();
  A(B.got.length === 1, "玩家点击后才落判", "落判 " + B.got[0]);
}

/* ── 5. 键盘：空格/回车都能落判 ── */
for (const code of ["Space", "Enter"]) {
  api.setRng(0.5);
  const B = openBar({ duration: 0, width: 20, left: 40 });
  const kd = api.WIN._h.keydown[0];
  kd({ code: code, preventDefault() {} });
  A(B.got.length === 1 && B.got[0] === "miss", "按 " + code + " 也能落判（光标还在 0 处 → 偏出）",
    JSON.stringify(B.got));
}

/* ── 6. 落判后必须收摊：监听摘掉、owner 归空、onclick 清掉、重复点击无效 ── */
{
  api.setRng(0.5);
  const B = openBar({ duration: 0, width: 20, left: 40, owner: "x", show: "block" });
  A(api.WIN.count("keydown") === 1, "落判前挂着 1 个 keydown", String(api.WIN.count("keydown")));
  A($("bar").style.display === "block", "show=block 时判定条显示", String($("bar").style.display));
  B.bar.click();
  A(api.WIN.count("keydown") === 0, "落判后 keydown 已摘", String(api.WIN.count("keydown")));
  A(api.inputBus().owner === null, "落判后 InputBus owner 归空", String(api.inputBus().owner));
  A($("bar").onclick === null, "落判后 onclick 已清（避免二次落判）", String($("bar").onclick));
  A($("bar").style.display === "none", "落判后判定条隐藏", String($("bar").style.display));
  B.bar.click(); B.bar.click();
  A(B.got.length === 1, "重复点击不会二次落判", "got=" + JSON.stringify(B.got));
}

/* ── 7. 接管语义：新判定条会替换旧 owner，不会同时挂两个监听 ── */
{
  api.setRng(0.5);
  const B1 = openBar({ duration: 0, width: 20, left: 40, owner: "first" });
  const B2 = openBar({ duration: 0, width: 20, left: 40, owner: "second" });
  A(api.WIN.count("keydown") === 1, "开第二条判定条后仍然只有 1 个 keydown（替换而非累加）",
    String(api.WIN.count("keydown")));
  A(api.inputBus().owner === "second", "owner 换成了后来的那条", String(api.inputBus().owner));
  /* 空格只喂给当前 owner */
  api.WIN._h.keydown[0]({ code: "Space", preventDefault() {} });
  A(B2.got.length === 1 && B1.got.length === 0,
    "空格只落判当前 owner（旧那条不会被顺带触发）",
    "B1=" + JSON.stringify(B1.got) + " B2=" + JSON.stringify(B2.got));
}

/* ── 8. 真身契约：InputBus 的接口形状与监听成对性（替身挡不住漂移）── */
{
  const fakeWin = { n: 0, addEventListener() { this.n++; }, removeEventListener() { this.n--; } };
  const oi = html.indexOf("{", /const\s+InputBus\s*=\s*\{/.exec(html).index);
  const real = new vm.Script("(" + grab(html, oi) + ")").runInNewContext({ window: fakeWin });
  A(typeof real.setOwner === "function" && typeof real.release === "function"
      && typeof real.activeCount === "function",
    "真实 InputBus 提供 setOwner / release / activeCount", Object.keys(real).join(","));
  real.release();
  real.setOwner("a", { keydown() {} });
  const n1 = fakeWin.n;
  real.setOwner("b", { keydown() {} });
  const n2 = fakeWin.n;
  A(n1 === 1 && n2 === 1, "真身：换 owner 时监听数保持 1", n1 + " → " + n2);
  real.release();
  A(fakeWin.n === 0, "真身：release() 摘干净", String(fakeWin.n));
  const r = real.setOwner("c", { keydown() {} });
  r(); r();
  A(fakeWin.n === 0 && real.activeCount() === 0, "真身：归还函数幂等", "n=" + fakeWin.n);
  real.release();
}

/* ── 9. 完美区可视化宽度与 zones 一致（避免"画的一半、判的一半"）── */
{
  api.setRng(0.5);
  openBar({ duration: 0, width: 20, left: 40,
    zones: [{ pct: [0.35, 0.65], grade: "perfect", relTo: "zone" }, { pct: [0, 1], grade: "good", relTo: "zone" }] });
  A(Math.abs(parseFloat($("perf").style.width) - 30) < 0.001,
    "完美区可视化宽度 = 区间宽度的 30%（与判定区间同源）", $("perf").style.width);
}

console.log("");
console.log("[结果] 通过 " + pass + "，失败 " + fails.length + (fails.length ? "" : "，全部通过 ✔"));
if (fails.length) { console.log("失败项："); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fails.length ? 1 : 0);
