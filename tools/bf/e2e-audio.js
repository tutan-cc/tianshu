/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/e2e-audio.js — 早餐店音效 / 顾客语音：**真浏览器**验收（CDP）

   为什么还要这一层（Node 无头那 400 条已经覆盖了调度逻辑）：
     无头用的是**假 Audio**：它能证明「什么时候 new 了哪个文件、音量多少」，
     但证明不了「浏览器真的能解码这几个 mp3、真的播得出来」。
     audio-wiring.js 那一层的教训是现成的：素材缺失 / 接错在「静默回落」的设计下
     于断言层面完全看不出来，必须**到运行时主动探测**。
     所以这里：真 Chrome + 真 HTTP + 真 Audio 元素，逐个 canplaythrough，
     再真开一局，制造滴答 / 跑单 / 上餐三种事件，读 debug.audio() 的播放台账。

   用法（需要本地 HTTP 服务）：
     python -m http.server 8000            # 仓库根
     node tools/bf/e2e-audio.js
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { resultsFile } = require("../lib/dist.js");

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.BF_CDP_PORT || 9263);
const OUT = path.join(__dirname, "..", "..");
const HTTP_BASE = process.env.BF_BASE || "http://127.0.0.1:8000";
const PROFILE = path.join(OUT, "_prof_bfaudio");
/* bf-9：欢呼换成 6 条新录音（实测上扬），另加 9 条「下锅那一刻」的烹饪音效。
   bf-10：欢呼池按用户拍板改成 v1 / alt2 / v3 / alt3 / v5 / v6 ——
   这里保持写死（这一层的意义就是「不依赖页面里的常量也能证明文件真的能播」），
   池子一旦再改，这个清单与下面那条池子断言要一起改。 */
/* 原（bf-10）：happy_v1/alt2/v3/alt3/v5/v6（6 条池）
   新（bf-11）：happy_v1/v3/finally2/i45（4 条池）
   原因：用户 bf-11 重新点名 4 条，并要求把「终于好啦」那条换成**不含「呜呼」**的版本
   （happy_v2 → happy_finally2）。happy_finally2.mp3 是**新文件**，必须在这里也证明
   「真 Chrome 能解码播放」—— 新文件最容易出静默 404。 */
const FILES = ["tick.mp3", "slow.mp3",
               "happy_v1.mp3", "happy_v3.mp3",
               "happy_finally2.mp3", "happy_i45.mp3",
               "cook_congee.mp3", "cook_milk.mp3", "cook_soup.mp3", "cook_egg.mp3",
               "cook_bacon.mp3", "cook_sandwich.mp3", "cook_bun.mp3",
               "cook_salad.mp3", "cook_juice.mp3"];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(method, p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method }, resp => {
      let d = ""; resp.on("data", c => d += c); resp.on("end", () => { try { res(JSON.parse(d)); } catch (e) { res(d); } });
    });
    r.on("error", rej); r.end();
  });
}
let id = 0, ws, pend = {};
function send(m, p) {
  return new Promise((res, rej) => {
    const i = ++id; pend[i] = res;
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    setTimeout(() => { if (pend[i]) { delete pend[i]; rej(new Error("timeout " + m)); } }, 120000);
  });
}
async function ev(e) {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) {
    const ex = r.result.exceptionDetails;
    return "EXC:" + ((ex.exception && ex.exception.description) || ex.text || "unknown");
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}

(async () => {
  const checks = [], errors = [];
  const A = (ok, name, detail) => {
    const line = name + (detail === undefined ? "" : "  [" + detail + "]");
    ok ? checks.push(line) : errors.push(line);
  };

  /* 先确认 HTTP 服务在跑（素材必须走真实服务判断，与玩家访问方式一致）*/
  let serverUp = false;
  try {
    await new Promise((res, rej) => {
      const r = http.get(HTTP_BASE + "/index.html", resp => { resp.resume(); res(resp.statusCode); });
      r.on("error", rej); r.setTimeout(5000, () => { r.destroy(); rej(new Error("timeout")); });
    });
    serverUp = true;
  } catch (e) { serverUp = false; }
  if (!serverUp) {
    console.log("[跳过] " + HTTP_BASE + " 无响应 —— 本测试需要本地 HTTP 服务：");
    console.log("       cd 仓库根 && python -m http.server 8000");
    process.exit(0);
  }
  A(FILES.every(f => fs.existsSync(path.join(OUT, "audio", "bf", f))), "全部素材文件在磁盘上（" + FILES.length + " 个）");

  /* --autoplay-policy：headless 里没有"用户手势"，不加这条 play() 会被策略拒 →
     那测的就是「被拦回落」而不是「真能播」。两条都要覆盖，所以先验真播（本脚本），
     被拦回落留给工具链里的无头用例（tools/bf/headless.js 的 audioBlock 场景）。 */
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1440,900",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--autoplay-policy=no-user-gesture-required",
    "--disk-cache-size=1", "--media-cache-size=1",
    `--user-data-dir=${PROFILE}`, "about:blank"], { stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 60; i++) { try { await req("GET", "/json/version"); up = true; break; } catch (e) { await sleep(400); } }
  if (!up) {
    console.log("[跳过] Chrome 没能起 CDP（" + CHROME + "）—— 真浏览器这层跑不了，但工具链的无头用例仍有效");
    try { chrome.kill(); } catch (e) {}
    process.exit(0);
  }
  const tab = await req("PUT", "/json/new?" + encodeURIComponent(HTTP_BASE + "/index.html"));
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  await send("Page.enable"); await send("Runtime.enable");
  await sleep(1500);
  /* 清掉可能残留的 bfSoundOn，再从干净状态重新进页面（开关默认值必须是「开」）*/
  await ev("localStorage.clear()");
  await send("Page.navigate", { url: HTTP_BASE + "/index.html" });
  await sleep(2800);
  /* 进沙盘：S（存档状态）要等「开始」之后才存在 —— 直接 bfStart 会因为 S 未初始化而抛
     （实测：bfCanSend → Cannot read properties of undefined (reading 'bonds')）*/
  await ev('document.getElementById("startBtn").click()');
  await sleep(1800);

  /* ── ① 真浏览器里逐个解码（canplaythrough + duration）── */
  const decode = await ev(`(async function(){
    var files = ${JSON.stringify(FILES)};
    var out = [];
    for (var i = 0; i < files.length; i++) {
      var url = "audio/bf/" + files[i];
      out.push(await new Promise(function(res){
        var a = new Audio(url); var done = false; a.volume = 0;
        a.addEventListener("error", function(){ if(!done){done=true;res(files[i]+"=ERROR");} });
        a.addEventListener("canplaythrough", function(){ if(!done){done=true;res(files[i]+"=OK "+a.duration.toFixed(3)+"s");} });
        setTimeout(function(){ if(!done){done=true;res(files[i]+"=TIMEOUT");} }, 8000);
        a.play().catch(function(){});
      }));
    }
    return out.join(" | ");
  })()`);
  const bad = String(decode).split("|").map(s => s.trim()).filter(s => s && s.indexOf("=OK") < 0);
  A(String(decode).indexOf("EXC:") !== 0 && bad.length === 0,
    FILES.length + " 个素材在真 Chrome 里都能解码播放", String(decode));
  const tickLine = String(decode).split("|").map(s => s.trim()).find(s => s.indexOf("tick.mp3=OK") === 0) || "";
  A(/tick\.mp3=OK 0\.0\d\ds/.test(tickLine) || /tick\.mp3=OK 0\.1[0-2]\ds/.test(tickLine),
    "tick.mp3 时长确实是「短促一声」（≤0.12s）", tickLine);

  /* ── ② 真开一局：debug 台账 + 两个开关入口 ──
     注意两件事（都实测过）：
       · 页面 glue 的 startBreakfastGame 里 duration/goal 是**写死的** 75 / 8，而且先过 bfCanSend
         （好感 20~79、今天没送过）—— 新档全员好感 <20，直接开会被拒；
         所以先用页面自己的调试钩子 CS2_DEBUG.mjSet 把苏晚晴好感置到 40（= 玩家正常能到的手感区间）。
       · S（存档状态）要等进沙盘之后才存在，直接 bfStart 会抛
         "Cannot read properties of undefined (reading 'bonds')"。 */
  const started = await ev(`(function(){
    if (!window.__cs2 || !window.__cs2.bfStart) return JSON.stringify({ err: "no-glue" });
    var info = {};
    try {
      var st = window.CS2_DEBUG.state();
      var b = Object.assign({}, st.bonds); b.su = 40;
      window.CS2_DEBUG.mjSet({ bonds: b, breakfastDay: { day: st.day, sent: [] } });
      info.bondSet = true;
    } catch (e) { info.bondSet = String(e); }
    var chk = null; try { chk = window.bfCanSend("su"); } catch (e) { chk = { ok: false, why: String(e) }; }
    info.chk = chk;
    info.ok = !!(chk && chk.ok) ? !!window.__cs2.bfStart("su", {}) : false;
    info.hasDebug = !!(window.__cs2.bf && window.__cs2.bf.audio);
    return JSON.stringify(info);
  })()`);
  let sj = {};
  try { sj = JSON.parse(started); } catch (e) { sj = { err: String(started) }; }
  A(sj.ok === true && sj.hasDebug === true, "页面 glue 能开局，且 debug.audio() 可用", String(started));
  if (sj.ok !== true) {
    console.log("── 真浏览器音效验收（提前结束：页面没能开局）──");
    errors.forEach(e => console.log("  ✗ " + e));
    try { chrome.kill(); } catch (e) {}
    process.exit(1);
  }
  await sleep(600);
  const a0 = await ev("JSON.stringify(window.__cs2.bf.audio())");
  let j0 = {};
  try { j0 = JSON.parse(a0); } catch (e) { j0 = {}; }
  A(j0.on === true && j0.tickAt === 0.3 && j0.gapFar === 1 && j0.gapNear === 0.5,
    "真浏览器里读到的常量 / 开关与规格一致",
    "on=" + j0.on + " TICK_AT=" + j0.tickAt + " far=" + j0.gapFar + " near=" + j0.gapNear);
  /* bf-11：页面里读到的欢呼池 = 用户拍板的 4 条（顺序即拍板顺序）
     原（bf-10）：["happy_v1.mp3","happy_alt2.mp3","happy_v3.mp3","happy_alt3.mp3","happy_v5.mp3","happy_v6.mp3"]
     新（bf-11）：["happy_v1.mp3","happy_v3.mp3","happy_finally2.mp3","happy_i45.mp3"]
     原因：用户 bf-11 点名 4 条 + 要求「终于好啦」换成不含「呜呼」的版本。 */
  A(JSON.stringify(j0.files && j0.files.happy) ===
    JSON.stringify(["happy_v1.mp3", "happy_v3.mp3",
                    "happy_finally2.mp3", "happy_i45.mp3"]),
    "真浏览器里读到的欢呼池 = bf-11 拍板池（v1/v3/finally2/i45）",
    JSON.stringify((j0.files || {}).happy));

  const btn = await ev(`(function(){
    var b = document.querySelector("#bfSound");
    if (!b) return "no-button";
    var before = b.textContent;
    b.click();
    var d = window.__cs2.bf.audio();
    return JSON.stringify({ before: before, after: b.textContent, on: d.on, store: localStorage.getItem("bfSoundOn") });
  })()`);
  let jb = {};
  try { jb = JSON.parse(btn); } catch (e) { jb = { err: String(btn) }; }
  A(/🔊/.test(jb.before || "") && /🔇/.test(jb.after || ""), "顶栏 #bfSound 点一下：🔊 → 🔇", JSON.stringify(jb));
  A(jb.on === false && jb.store === "0", "开关真写进了 localStorage.bfSoundOn", String(jb.store));
  const back = await ev(`(function(){ document.querySelector("#bfSound").click(); return JSON.stringify(window.__cs2.bf.audio().on ? localStorage.getItem("bfSoundOn") : "?"); })()`);
  A(back === '"1"' || back === "1", "再点一下开回来（localStorage 也跟着变）", String(back));

  /* 留一张截图：游戏内能看见「顶栏按钮 + 图例徽章」两个音效开关（人工复核 UI 用）*/
  try {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const shotDir = path.join(OUT, "测试截图");
    fs.mkdirSync(shotDir, { recursive: true });
    fs.writeFileSync(path.join(shotDir, "bf_audio_switch.png"), Buffer.from(shot.result.data, "base64"));
    checks.push("截图：测试截图/bf_audio_switch.png（顶栏 🔊 按钮 + 图例条左端徽章）");
  } catch (e) {}

  /* ── ③ 滴答：把顾客耐心压到 5%，等真实帧推进 ── */
  const tickRun = await ev(`(async function(){
    var d = window.__cs2.bf;
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    /* 等第一位顾客进店 */
    var t0 = Date.now();
    while (Date.now() - t0 < 8000 && d.orders().length === 0) await sleep(100);
    if (!d.orders().length) return JSON.stringify({ err: "没有顾客进店" });
    d.clearAudio();
    d.orders().forEach(function(o){ d.setPatience(o.id, 0.05); });
    await sleep(1200);                       // 5% 档 → 0.5s 一下，1.2 秒里必然响过
    var plays = d.audio().plays;
    return JSON.stringify({ plays: plays, ratio: d.audio().ratio, n: plays.filter(function(p){ return /tick\\.mp3$/.test(p.url); }).length });
  })()`);
  let jt = {};
  try { jt = JSON.parse(tickRun); } catch (e) { jt = { err: String(tickRun) }; }
  A(jt.n >= 1, "真浏览器里低耐心顾客触发了滴答（真 Audio 播放）",
    "tick " + jt.n + " 条 · ratio=" + jt.ratio + " · " + JSON.stringify((jt.plays || []).map(p => p.url + "@" + p.volume)));
  A((jt.plays || []).every(p => p.ok !== false), "没有一条因为「文件坏 / 被策略拦」被标掉",
    JSON.stringify((jt.plays || []).map(p => p.why || "ok")));

  /* ── ④ 跑单 → 「哼，太慢了」 ── */
  const slowRun = await ev(`(async function(){
    var d = window.__cs2.bf;
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    d.clearAudio();
    d.orders().forEach(function(o){ d.setPatience(o.id, 0); });
    await sleep(500);
    var plays = d.audio().plays;
    return JSON.stringify({ n: plays.filter(function(p){ return /slow\\.mp3$/.test(p.url); }).length,
                            angry: d.state().angry, plays: plays });
  })()`);
  let js = {};
  try { js = JSON.parse(slowRun); } catch (e) { js = { err: String(slowRun) }; }
  A(js.n === 1, "同一帧多位顾客跑单 → 只播一条「哼，太慢了」", "slow " + js.n + " 条 · angry=" + js.angry);

  /* ── ⑤ 上餐成功 → 「呜呼」 ── */
  const happyRun = await ev(`(async function(){
    var d = window.__cs2.bf;
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    /* ⚠ bf-9 起做菜变快 → 页面 glue 的「75 秒 / 8 位」正式局可能在这一段里就打完（win → dispose），
       那时 d.state() 是 null，后面全读成 undefined。所以每轮先确认还在跑，不在就用超长局重开。 */
    async function restartLong(){        // ⚠ 必须是 async：里面有 await（普通函数里写 await 是语法错误，
                                        //    整个注入脚本会编译失败 → ⑤ 的返回值全是 undefined）
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      var ov = document.getElementById("bfGame");     // dispose() 顺手摘掉了覆盖层，补回来
      if (ov && ov.classList) ov.classList.add("on");
      await sleep(300);                               // 让新局真的跑几帧
      return true;
    }
    var st0 = d.state();
    var restarts = 0;
    if (!st0 || !st0.running) { await restartLong(); restarts++; }
    for (var i = 0; i < 9; i++) d.trashCol(i);          // 清空 9 列，保证下得去料
    d.clearAudio();
    /* 自己造一位顾客（别赌随机进店：headless 里 rAF 只有墙钟 ~1/5 速），
       再用游戏时钟把这一单做出来 —— 与 ⑦ 同一套确定性写法。 */
    var id = d.pushCustomer();
    var served = false, steps = 0;
    for (; steps < 900 && !served; steps++) {
      var o = d.orders().filter(function(x){ return x.id === id; })[0];
      if (!o) { id = d.pushCustomer(); d.setPatience(id, 0.95); continue; }
      d.setPatience(id, 0.95);                          // 这一段别让他跑单
      var want = null;
      for (var j = 0; j < o.order.length; j++) if (o.done.indexOf(o.order[j]) < 0) { want = o.order[j]; break; }
      if (!want) { served = true; break; }              // 整单做齐 → 也算走完一次上餐
      var col = d.columnOf(want), s = d.stations()[col];
      if (s.plate && s.plateState === "burnt") d.trashCol(col);      // 糊了就丢掉重来
      if (!s.food && !s.plate) d.drop(want, col);
      d.tick(1 / 60);
      var s2 = d.stations()[col];
      if (s2.plate && s2.plateState !== "burnt") { var r = d.serveCol(col); if (r && r.ok) served = true; }
    }
    var plays = d.audio().plays;
    return JSON.stringify({ served: served, restarts: restarts, steps: steps,
                            n: plays.filter(function(p){ return /happy_(?:v1|v3|i45|finally2)\\.mp3$/.test(p.url); }).length,
                            running: !!(d.state() && d.state().running),
                            plays: plays });
  })()`);
  let jh = {};
  try { jh = JSON.parse(happyRun); } catch (e) { jh = { err: String(happyRun) }; }
  A(jh.served === true, "真浏览器里完成了一次上餐（happy 断言的前提）",
    "steps=" + jh.steps + " · restarts=" + jh.restarts + " · running=" + jh.running);
  A(jh.n === 1, "上餐成功 → 恰好播一条欢呼（六个变体之一）",
    JSON.stringify((jh.plays || []).map(p => p.url)));
  A((jh.plays || []).some(p => /happy_(?:v1|v3|i45|finally2)\.mp3$/.test(p.url) && p.volume >= 0.3 && p.volume <= 0.8),
    "欢呼的音量与规格一致（0.55）",
    JSON.stringify((jh.plays || []).filter(p => /happy_v/.test(p.url)).map(p => p.url + "@" + p.volume)));
  const allBad = ["tick", "slow", "happy"].map(k => (k === "tick" ? jt : k === "slow" ? js : jh))
    .flatMap(j => (j.plays || [])).filter(p => p.ok === false);
  A(allBad.length === 0, "整轮没有一条播放因「文件缺失 / 解码失败 / 策略拦截」被标掉",
    allBad.length ? JSON.stringify(allBad) : "全绿");

  /* ── ⑥ 下锅音效（bf-9）：真浏览器里点食材 → 真的播了对应音效 ──
     用**真实 MouseEvent** 点在画布上的食材桶（坐标由 debug.bucketBox + 画布 rect 换算），
     不是调 debug API —— 证明的是「玩家的手点下去会响」，而不是「函数调用会响」。 */
  const cookRun = await ev(`(async function(){
    var d = window.__cs2.bf;
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    function showOverlay(){
      var o = document.getElementById("bfGame");
      if (o && o.classList) o.classList.add("on");
    }
    function ensureRunning(){
      var st = d.state();
      if (st && st.running) return "running";
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      showOverlay();          // dispose() 会把覆盖层摘掉 → 不补回来画布就是 0×0，点击全落空
      return "restarted";
    }
    function clickBox(b){
      var cv = document.querySelector("canvas.bf-cv");
      if (!cv) return "no-canvas";
      var r = cv.getBoundingClientRect();
      var V = window.Breakfast.VIEW;               // ⚠ VIEW 挂在 api 上，不在 ui 上
      if (!V || !V.w) return "no-view";
      cv.dispatchEvent(new MouseEvent("mousedown",
        { clientX: r.left + ((b.x + b.w / 2) / V.w) * r.width,
          clientY: r.top + ((b.y + b.h / 2) / V.h) * r.height,
          bubbles: true, cancelable: true, view: window }));
      return "clicked";
    }
    var mode = ensureRunning();
    for (var i = 0; i < 9; i++) d.trashCol(i);          // 清空 9 列，保证点得下去
    d.setSound(true);
    d.clearAudio();
    var e0 = d.state().elapsed;
    var r1 = clickBox(window.Breakfast.bucketBox(8));    // 果汁机那一桶
    await sleep(150);
    var juice = d.audio().plays.filter(function(p){ return /cook_juice\.mp3$/.test(p.url); });
    var juiceFood = d.stations()[8].food;
    d.tick(0.8);                                        // ⚠ 用**游戏时钟**：0.8s 同时满足两件事 ——
                                                        //   · 过了同食材 300ms 节流窗口
                                                        //   · 前两条的占线窗口（COOK_TAIL_SEC 0.7s）也过期，
                                                        //     并发额度腾出来，第三下才验得到"节流"而不是"busy"
    var e1 = d.state().elapsed;
    var r2 = clickBox(window.Breakfast.bucketBox(3));    // 煎蛋那一桶
    await sleep(150);
    var e2 = d.state().elapsed;
    var egg = d.audio().plays.filter(function(p){ return /cook_egg\.mp3$/.test(p.url); });
    var eggFood = d.stations()[3].food;
    /* 节流：清掉果汁列 → 同一时刻连点两下，第二下必须被 300ms 窗口挡住 */
    d.trashCol(8);
    var n0 = d.audio().plays.filter(function(p){ return /cook_juice\.mp3$/.test(p.url); }).length;
    clickBox(window.Breakfast.bucketBox(8));              // 这一下响
    var f1 = d.stations()[8].food;                        // 诊断：这一下真的下锅了吗
    d.trashCol(8);
    clickBox(window.Breakfast.bucketBox(8));              // 紧接着再点 → 节流，不响
    var f2 = d.stations()[8].food;                        // 诊断：第二下呢
    await sleep(80);
    var n1 = d.audio().plays.filter(function(p){ return /cook_juice\.mp3$/.test(p.url); }).length;
    var thr = d.audio().log.filter(function(r){ return r.why === "throttle"; }).length;
    var tail = d.audio().log.slice(-8).map(function(r){ return r.name + ":" + (r.why || "ok"); });
    return JSON.stringify({ mode: mode, rc:[r1, r2], juice: juice.length, juiceFood: juiceFood,
                            e0: e0, e1: e1, e2: e2, running: !!d.state().running,
                            cvW: (function(){ var c = document.querySelector("canvas.bf-cv");
                                              return c ? Math.round(c.getBoundingClientRect().width) : -1; })(),
                            egg: egg.length, eggFood: eggFood, n0: n0, n1: n1, throttle: thr,
                            cooks: d.state().cooks, gap: d.audio().cookGap, max: d.audio().cookMax,
                            f1: f1, f2: f2, tail: tail, on: d.audio().on,
                            plays: d.audio().plays.map(function(p){ return p.url; }) });
  })()`);
  let jc = {};
  try { jc = JSON.parse(cookRun); } catch (e) { jc = { err: String(cookRun) }; }
  A(jc.juice === 1, "真浏览器：点「果汁」桶 → 真的播了 audio/bf/cook_juice.mp3",
    "juice=" + jc.juice + " · 锅里=" + jc.juiceFood + " · mode=" + jc.mode +
    " · 画布宽=" + jc.cvW + " · " + JSON.stringify(jc.plays || []));
  A(jc.e1 > jc.e0 && jc.e2 >= jc.e1 && jc.running === true,
    "真浏览器：这一局的时钟真的在走（rAF 在推帧，节流判据才成立）",
    "elapsed " + jc.e0 + " → " + jc.e1 + " → " + jc.e2 + " · running=" + jc.running + " · mode=" + jc.mode);
  A(jc.juiceFood === "juice", "点果汁确实把果汁放进了第 8 列（触发点就是下锅那一刻）", String(jc.juiceFood));
  A(jc.egg === 1, "真浏览器：点「煎蛋」桶 → 真的播了 audio/bf/cook_egg.mp3",
    "egg=" + jc.egg + " · 锅里=" + jc.eggFood);
  A(jc.eggFood === "egg", "点煎蛋确实把煎蛋放进了第 3 列", String(jc.eggFood));
  A(jc.n1 === jc.n0 + 1 && jc.throttle >= 1,
    "真浏览器：同一食材 300ms 内连点 → 只多响一声（被节流的那次留了记录）",
    "juice " + jc.n0 + " → " + jc.n1 + " · throttle=" + jc.throttle +
    " · 锅里 " + jc.f1 + "→" + jc.f2 + " · 开关=" + jc.on + " · 台账尾 " + JSON.stringify(jc.tail));
  A(jc.gap === 0.3 && jc.max === 2, "真浏览器里读到的节流 / 并发常量与规格一致",
    jc.gap + "s / " + jc.max + " 条");
  A(jc.cooks >= 3, "下锅音效的台账在真浏览器里也记数（state().cooks）", String(jc.cooks));

  /* ── ⑦ 上餐选人 + 部分上餐（bf-9）：真实点专属盘送给「耐心最低」那位 ── */
  const pickRun = await ev(`(async function(){
    var d = window.__cs2.bf;
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    function clickBox(b){
      var cv = document.querySelector("canvas.bf-cv");
      var r = cv.getBoundingClientRect();
      var V = window.Breakfast.VIEW;               // ⚠ VIEW 挂在 api 上，不在 ui 上
      cv.dispatchEvent(new MouseEvent("mousedown",
        { clientX: r.left + ((b.x + b.w / 2) / V.w) * r.width,
          clientY: r.top + ((b.y + b.h / 2) / V.h) * r.height,
          bubbles: true, cancelable: true, view: window }));
    }
    var st0 = d.state();
    if (!st0 || !st0.running) {                                   // 上一局打完了 → 用超长局重开
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      var ov = document.getElementById("bfGame");                 // dispose 摘掉的覆盖层要补回来
      if (ov && ov.classList) ov.classList.add("on");
      await sleep(400);
    }
    for (var i = 0; i < 9; i++) d.trashCol(i);
    d.orders().forEach(function(o){ d.setPatience(o.id, 0); });   // 先让场上的人走光
    d.tick(0.6);                                                  // 用游戏时钟推他们离场
    /* 耐心上限 = (10 + 7.5×订单长度) × 难度系数（单局最多 ≈32.5s），
       所以摆 30 / 12 / 5 三档（40s 在游戏里摆不出来）。 */
    var a = d.pushCustomer(["egg", "bacon", "salad"]);     // 先来的（长单，上限最高）
    var b = d.pushCustomer(["egg", "congee"]);
    var c = d.pushCustomer(["egg", "juice"]);              // 最后来的 → 要摆成最急
    function abs(id, want){
      var o = d.orders().filter(function(x){ return x.id === id; })[0];
      if (!o) return null;
      d.setPatience(id, want / o.patienceMax);
      return d.orders().filter(function(x){ return x.id === id; })[0].patience;
    }
    var col = d.columnOf("egg");
    if (!d.stations()[col].plate && !d.stations()[col].food) d.drop("egg", col);
    /* 用游戏时钟把这份煎蛋推到落盘（与无头用例同一口径；墙钟在这里只有 ~1/5 速） */
    for (var k = 0; k < 400 && !d.stations()[col].plate; k++) d.tick(1 / 60);
    var plated = !!d.stations()[col].plate;
    /* 摆耐心放在「点击前一刻」：等煎蛋熟的这几秒里耐心一直在掉 */
    d.orders().forEach(function(o){ if (o.id !== a && o.id !== b && o.id !== c) d.setPatience(o.id, 0.98); });
    var pA = abs(a, 30), pB = abs(b, 12), pC = abs(c, 5);
    var pick = d.pickFor("egg");
    /* 部分上餐的计数是**本局累计**的（⑤ 那段也可能上过餐）→ 这里记快照，断言"这一次"的增量 */
    var ps0 = d.state().partialServes, pb0 = d.state().partialBonus;
    d.clearAudio();
    clickBox(window.Breakfast.plateBox(col));                // ← 真实鼠标点这一列的专属盘
    await sleep(150);
    var os = d.orders();
    var got = os.filter(function(o){ return o.done.indexOf("egg") >= 0; }).map(function(o){ return o.id; });
    var hurry = os.filter(function(o){ return o.id === c; })[0];
    var others = os.filter(function(o){ return o.id === a || o.id === b; })
                    .map(function(o){ return o.id + ":" + (o.done.indexOf("egg") >= 0 ? "拿到了" : "没拿到"); });
    return JSON.stringify({ plated: plated, pA: pA, pB: pB, pC: pC, pick: pick, want: c, got: got,
                            patience: hurry ? hurry.patience : null, max: hurry ? hurry.patienceMax : null,
                            partialServes: d.state().partialServes, partialBonus: d.state().partialBonus,
                            dServes: d.state().partialServes - ps0,
                            dBonus: Math.round((d.state().partialBonus - pb0) * 10) / 10,
                            happy: d.audio().plays.filter(function(p){ return /happy_(?:v1|v3|i45|finally2)\.mp3$/.test(p.url); }).length,
                            others: others });
  })()`);
  let jp2 = {};
  try { jp2 = JSON.parse(pickRun); } catch (e) { jp2 = { err: String(pickRun) }; }
  A(jp2.plated === true && Math.abs(jp2.pC - 5) < 0.2 && Math.abs(jp2.pB - 12) < 0.3,
    "真浏览器：3 位都要煎蛋，耐心摆成 30 / 12 / 5（煎蛋已落到专属盘）",
    "30→" + jp2.pA + " · 12→" + jp2.pB + " · 5→" + jp2.pC);
  A(jp2.pick === jp2.want, "真浏览器：规则层挑中耐心 5 那位（不是第一位）",
    "pick → #" + jp2.pick + " · 期望 #" + jp2.want);
  A((jp2.got || []).indexOf(jp2.want) >= 0 && (jp2.got || []).length === 1,
    "真浏览器：真实鼠标点盘 → 煎蛋落在耐心 5 那位头上（另外两位没被越位送）",
    "拿到煎蛋 #" + (jp2.got || []).join("/") + " · 别人 " + JSON.stringify(jp2.others || []));
  A(jp2.patience > 5 && jp2.patience < 9 && jp2.dServes === 1 && jp2.dBonus === 3.5,
    "真浏览器：他还缺一样 → 部分上餐回 +3.5s 耐心（5 → " + jp2.patience + "，上限 " + jp2.max + "）",
    JSON.stringify({ patience: jp2.patience, max: jp2.max, 本次次数: jp2.dServes, 本次秒数: jp2.dBonus,
                     本局累计: jp2.partialServes + "/" + jp2.partialBonus + "s" }));
  A(jp2.happy === 1, "真浏览器：这一次上餐照样播了一条欢呼（bf-11 的 4 条变体之一）", String(jp2.happy));

  /* ── ⑧ 兼容性（bf-9 补）：Chrome 里 ellipse 仍是原生实现 → 外观与行为完全不变 ──
     IE11/Trident 没有 Canvas2D.ellipse（HTA 探针会弹「对象不支持 ellipse」），
     所以 breakfast.js 装了一个幂等 polyfill；Chrome 这条路径必须**一个字节都没动**。 */
  const ellipseState = await ev(`(function(){
    var proto = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
    if (!proto || typeof proto.ellipse !== "function") return "no-ellipse";
    return (String(proto.ellipse).indexOf("[native code]") >= 0) ? "native" : "patched";
  })()`);
  A(ellipseState === "native",
    "Chrome：CanvasRenderingContext2D.prototype.ellipse 仍是原生实现（polyfill 只对 IE11 生效）",
    String(ellipseState));

  /* ── 收尾 ── */
  await ev("(function(){ try{ window.__cs2.bf.close(); }catch(e){} return 1; })()");
  console.log("── 早餐店音效 · 真浏览器验收 ──");
  checks.forEach(c => console.log("  ✔ " + c));
  errors.forEach(e => console.log("  ✗ " + e));
  console.log(`[结果] 通过 ${checks.length}，失败 ${errors.length}` + (errors.length ? " | " + errors.join(" | ") : ""));
  try {
    fs.writeFileSync(resultsFile("bf-audio-e2e-results.json"), JSON.stringify({
      success: errors.length === 0, checks, errors, at: new Date().toISOString(),
      base: HTTP_BASE, autoplay: "no-user-gesture-required"
    }, null, 1), "utf8");
  } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  process.exit(errors.length ? 1 : 0);
})();
