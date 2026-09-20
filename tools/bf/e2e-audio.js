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
const FILES = ["tick.mp3", "happy.mp3", "happy2.mp3", "happy3.mp3", "slow.mp3"];
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
  A(FILES.every(f => fs.existsSync(path.join(OUT, "audio", "bf", f))), "五个素材文件在磁盘上（" + FILES.length + " 个）");

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
  A(String(decode).indexOf("EXC:") !== 0 && bad.length === 0, "五个素材在真 Chrome 里都能解码播放", String(decode));
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
    d.clearAudio();
    var t0 = Date.now(), served = false, tries = 0;
    while (Date.now() - t0 < 20000 && !served && tries++ < 400) {
      var os = d.orders();
      os.forEach(function(o){ d.setPatience(o.id, 0.95); });     // 这一段别让人跑单
      if (!os.length) { await sleep(120); continue; }
      var c = os[0], want = null;
      for (var i = 0; i < c.order.length; i++) if (c.done.indexOf(c.order[i]) < 0) { want = c.order[i]; break; }
      if (!want) { await sleep(80); continue; }
      var col = d.columnOf(want), s = d.stations()[col];
      if (!s.food && !s.plate) d.drop(want, col);
      await sleep(90);
      var s2 = d.stations()[col];
      if (s2.plate && s2.plateState !== "burnt") { var r = d.serveCol(col); if (r && r.ok) served = true; }
    }
    var plays = d.audio().plays;
    return JSON.stringify({ served: served, n: plays.filter(function(p){ return /happy(2|3)?\\.mp3$/.test(p.url); }).length, plays: plays });
  })()`);
  let jh = {};
  try { jh = JSON.parse(happyRun); } catch (e) { jh = { err: String(happyRun) }; }
  A(jh.served === true, "真浏览器里完成了一次上餐（happy 断言的前提）");
  A(jh.n === 1, "上餐成功 → 恰好播一条「呜呼」（三个变体之一）",
    JSON.stringify((jh.plays || []).map(p => p.url)));
  const allBad = ["tick", "slow", "happy"].map(k => (k === "tick" ? jt : k === "slow" ? js : jh))
    .flatMap(j => (j.plays || [])).filter(p => p.ok === false);
  A(allBad.length === 0, "整轮没有一条播放因「文件缺失 / 解码失败 / 策略拦截」被标掉",
    allBad.length ? JSON.stringify(allBad) : "全绿");

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
