#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   tools/dev/nlroute-browser.js — **真浏览器**验证自然语言影子模式（nlroute.js + 本地反代）

   为什么非要真浏览器：nlroute.js 的几条承诺在 Node 单测里证不了 ——
     ① 「侧栏输入框可见 + 提交只出提示」是 DOM/样式问题；
     ② 「点了真入口（#mjFreeBtn / #bfBtn）才会回填 actual」靠的是 **capture 阶段 click
        监听 + MutationObserver 观察 overlay 的 class** —— 假 DOM 里没有 MutationObserver；
     ③ **端到端真的能路由**：页面 → 本地反代（key 只在反代进程）→ TypeSafe 真接口 → intent；
        顺带证明这一切之后页面**没有发生任何跳转**。

   三种 fetch 形态都跑：
     A. 假响应（NLRoute.debug.setFetch）—— 不联网、可复现，用来测判定与回填；
     B. 真反代 + 真 key —— 端到端（key 从进程环境变量/Windows 用户级变量读，**不进浏览器**）；
     C. 直连官方端点 —— 复现 CORS 被拦（说明为什么必须走反代）+ 反代停掉后的降级表现。

   做法：本地 HTTP（127.0.0.1:8000）+ headless Chrome（--remote-debugging-port）+ 只走 CDP，
        不装 puppeteer、不弹任何窗口/对话框。反代是本脚本自己 spawn 的子进程，跑完就停。

   用法：node tools/dev/nlroute-browser.js            # 全自动，跑完自己收摊
        node tools/dev/nlroute-browser.js --keep      # 出图后保留浏览器/服务（调试用）
        node tools/dev/nlroute-browser.js --no-live   # 跳过要真 key 的端到端（无 key 时自动跳过）
   退出码：0 全过；1 有失败项。
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.NL_PORT || 8000);
const CDP_PORT = Number(process.env.NL_CDP_PORT || 9444);
const PROXY_PORT = Number(process.env.NL_PROXY_PORT || 8010);
const BASE = "http://127.0.0.1:" + PORT;
const CHROME = process.env.NL_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROF = path.join(os.tmpdir(), "nlroute-chrome-prof");
const SHOT = path.join(ROOT, "测试截图", "nlroute-shadow-sidebar.png");
const SHOT_LIVE = path.join(ROOT, "测试截图", "nlroute-live-e2e.png");
const KEEP = process.argv.indexOf("--keep") >= 0;
const NO_LIVE = process.argv.indexOf("--no-live") >= 0;

const checks = [], errors = [];
function A(ok, name, extra) {
  const line = name + (extra === undefined ? "" : "  [" + extra + "]");
  if (ok) { checks.push(line); console.log("  ✔ " + line); }
  else { errors.push(line); console.log("  ✖ " + line); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 有没有可用的真 key（只读，不打印、不落盘） */
function hasRealKey() {
  if (process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.trim()) return true;
  if (process.platform === "win32") {
    try {
      const out = execSync('reg query "HKCU\\Environment" /v TYPESAFE_API_KEY', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return !!out.match(/TYPESAFE_API_KEY\s+REG_\w+\s+(\S+)/);
    } catch (e) { return false; }
  }
  return false;
}

/* ── 本地静态服务（照 http.server 的口径：MIME 对、Range 忽略、Range 请求也返回整份） ── */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".svg": "image/svg+xml", ".woff2": "font/woff2",
};
function startServer() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || "/").split("?")[0]);
    if (p === "/" || p === "") p = "/index.html";
    const full = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ""));
    if (!full.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end("not found: " + p); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": "no-store" });
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(full).pipe(res);
    });
  });
  return new Promise((res, rej) => {
    srv.on("error", rej);
    srv.listen(PORT, "127.0.0.1", () => res(srv));
  });
}

/* ── 反代子进程（key 由它自己从环境变量/用户级变量读，页面全程拿不到） ── */
function startProxy() {
  const child = spawn(process.execPath, [path.join(ROOT, "tools", "dev", "nlroute-proxy.js"), "--port=" + PROXY_PORT], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  return new Promise(async (resolve) => {
    for (let i = 0; i < 40; i++) {
      const h = await plainReq("GET", "http://127.0.0.1:" + PROXY_PORT + "/health");
      if (h.status === 200 && h.json && h.json.ok) return resolve({ child, health: h.json, log: () => out.join("") });
      await sleep(250);
    }
    resolve({ child, health: null, log: () => out.join("") });
  });
}
function plainReq(method, url, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: u.hostname, port: u.port, path: u.pathname + (u.search || ""), method: method,
      headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json: json, text: text });
      });
    });
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, error: "timeout" }); });
    r.on("error", (e) => resolve({ status: 0, error: String(e && e.message || e) }));
    if (data) r.write(data);
    r.end();
  });
}

/* ── 极简 CDP 客户端（Node 自带 WebSocket，不装依赖） ── */
function httpJson(p) {
  return new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: CDP_PORT, path: p, method: "GET" }, (r) => {
      let b = ""; r.setEncoding("utf8");
      r.on("data", (d) => (b += d));
      r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error("非 JSON：" + b.slice(0, 200))); } });
    });
    req.on("error", rej); req.end();
  });
}
async function httpPut(p) {
  return new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: CDP_PORT, path: p, method: "PUT" }, (r) => {
      let b = ""; r.setEncoding("utf8");
      r.on("data", (d) => (b += d));
      r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { res(b); } });
    });
    req.on("error", rej); req.end();
  });
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pend = new Map();
  let id = 0;
  const api = {
    ready: new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("WS 失败")); }),
    onEvent: null,
    send(method, params) {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method: method, params: params || {} }));
      return new Promise((res, rej) => {
        const t = setTimeout(() => { pend.delete(mid); rej(new Error("CDP 超时：" + method)); }, 60000);
        pend.set(mid, (m) => { clearTimeout(t); res(m); });
      });
    },
    close() { try { ws.close(); } catch (e) { } },
  };
  ws.onmessage = (e) => {
    let m = null; try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.id && pend.has(m.id)) { const f = pend.get(m.id); pend.delete(m.id); f(m); }
    else if (api.onEvent) api.onEvent(m);
  };
  return api;
}

/* --serve-only：只把本地静态服务起着（给 tools/dev/nlroute-up.ps1 用，免得它再依赖 python）。
   作为模块被 require 时不启动任何东西。 */
if (require.main === module && process.argv.indexOf("--serve-only") >= 0) {
  startServer().then(() => {
    console.log("nlroute 静态服务已起：http://127.0.0.1:" + PORT + "/index.html（Ctrl+C 停止）");
  }).catch((e) => {
    console.error("✖ 静态服务起不来：" + ((e && e.message) || e));
    process.exit(2);
  });
} else if (require.main === module) {
  main();
}

module.exports = { startServer, hasRealKey, PORT };

async function main() {
  const live = !NO_LIVE && hasRealKey();
  console.log("nlroute 影子模式 · 真浏览器验证（静态 " + BASE + " · 反代 127.0.0.1:" + PROXY_PORT + " · headless Chrome CDP）");
  console.log("  · 真 key 端到端：" + (live ? "开（key 只在反代子进程里）" : "跳过（--no-live 或没读到 key）"));
  let srv = null, chrome = null, cdp = null, proxy = null;
  const evidence = { base: BASE, proxyPort: PROXY_PORT, live: live, checks: checks, errors: errors };
  try {
    srv = await startServer();
    console.log("  · 本地静态服务已起：" + BASE);

    /* 先起反代 —— 影子 UI 靠它探通才显示 */
    proxy = await startProxy();
    A(!!proxy.health, "本地反代已起（GET /health 200）", proxy.health ? "hasKey=" + proxy.health.hasKey + " upstream=" + proxy.health.upstream : "没起来");
    evidence.proxyHealth = proxy.health;

    try { fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) { }
    chrome = spawn(CHROME, [
      "--headless=new", "--remote-debugging-port=" + CDP_PORT, "--window-size=1440,900",
      "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
      "--hide-scrollbars",
      /* 刻意**不加** --disable-web-security：默认 Web 安全模型才是玩家的真实环境，
         下面那条"直连对照"就是靠它才照出 CORS 现状的。 */
      "--mute-audio", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
      "--user-data-dir=" + PROF, "about:blank",
    ], { stdio: "ignore" });

    let up = false;
    for (let i = 0; i < 60; i++) { try { await httpJson("/json/version"); up = true; break; } catch (e) { await sleep(400); } }
    A(up, "headless Chrome 调试端口已就绪", "port=" + CDP_PORT);
    if (!up) throw new Error("Chrome 未能在 24s 内起来");

    const tab = await httpPut("/json/new?" + encodeURIComponent(BASE + "/index.html"));
    cdp = connect(tab.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Log.enable").catch(() => { });
    const pageErrors = [];
    cdp.onEvent = (m) => { if (m.method === "Log.entryAdded" && m.params && m.params.entry && m.params.entry.level === "error") pageErrors.push(m.params.entry.text); };

    async function ev(expr) {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) throw new Error("页面求值异常：" + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result && r.result.result ? r.result.result.value : null;
    }
    async function waitReady() {
      for (let i = 0; i < 100; i++) { if (await ev("document.readyState") === "complete") return true; await sleep(200); }
      return false;
    }
    await waitReady();
    await sleep(1200);

    /* ── 0. 加载态 ── */
    A(await ev("typeof window.NLRoute === 'object'") === true, "nlroute.js 已被 index.html 加载（window.NLRoute 存在）");
    A(await ev("typeof window.Mahjong === 'object' && typeof window.Breakfast === 'object'") === true, "原有模块仍在（Mahjong / Breakfast）");
    /* 反代在跑 → 探通后应当"自动可用"，页面里一个 key 都没有 */
    for (let i = 0; i < 20; i++) { if (await ev("window.NLRoute.available()") === true) break; await sleep(300); }
    A(await ev("window.NLRoute.available()") === true, "反代在跑 → 自动可用（**页面里没有任何 key**）");
    A(await ev("localStorage.getItem('cs2_ts_key')") === null, "浏览器 localStorage 里没有 key（凭据只在 Node 侧）");
    const ep = await ev("window.NLRoute.endpoint()");
    A(/127\.0\.0\.1:8010\/route$/.test(String(ep)), "默认端点就是本地反代", ep);
    A(await ev("window.NLRoute.debug.health().ok") === true, "debug.health() 探通");

    /* ── 1. 开始游戏 → 回到沙盘（侧栏在沙盘里） ── */
    await ev("document.getElementById('startBtn').click()");
    await sleep(2200);
    /* headless Chrome 播不了 H.264 → 游戏自己弹「检测不到视频文件」（环境现象，不是本模块的问题）；
       关掉它，再把剧情节点走完回到沙盘，好让截图里真的看得见侧栏。 */
    await ev("(function(){ var w=document.getElementById('mediawarn'); if(w && getComputedStyle(w).display !== 'none'){ var b=document.getElementById('mwClose'); if(b) b.click(); } })()");
    await sleep(400);
    let backToSandbox = false;
    for (let i = 0; i < 14; i++) {
      const st = await ev(`(function(){ return {
        cine: document.getElementById('cine').classList.contains('on'),
        choice: document.getElementById('choice').classList.contains('on'),
        cont: document.getElementById('cont').classList.contains('on')
      }; })()`);
      if (!st.cine && !st.choice) { backToSandbox = true; break; }
      if (st.choice) await ev("(function(){ var o=document.querySelector('#choiceOpts .opt'); if(o) o.click(); })()");
      else if (st.cont) await ev("document.getElementById('cont').click()");
      else await ev("document.getElementById('skipnode').click()");
      await sleep(900);
    }
    A(backToSandbox === true, "剧情已走完，回到沙盘（#cine / #choice 都关了）");
    await ev("document.getElementById('nlShadow').scrollIntoView({ block: 'center' })");
    await sleep(400);

    const vis = await ev(`(function(){
      var el = document.getElementById('nlShadow');
      var inp = document.getElementById('nlInput');
      var btn = document.getElementById('nlGo');
      var side = document.getElementById('side');
      var r = el ? el.getBoundingClientRect() : null;
      var ri = inp ? inp.getBoundingClientRect() : null;
      var cs = el ? getComputedStyle(el) : null;
      return {
        gameOn: document.getElementById('game').classList.contains('on'),
        sideW: side ? Math.round(side.getBoundingClientRect().width) : -1,
        display: el ? el.style.display : null,
        cssDisplay: cs ? cs.display : null,
        box: r ? [Math.round(r.width), Math.round(r.height), Math.round(r.x), Math.round(r.y)] : null,
        inViewport: !!(r && r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.width > 0 && r.height > 0),
        inputBox: ri ? [Math.round(ri.width), Math.round(ri.height)] : null,
        placeholder: inp ? inp.getAttribute('placeholder') : null,
        btn: btn ? btn.textContent : null,
        inSide: !!(el && el.parentNode && el.parentNode.id === 'side'),
        afterMjBtn: !!(el && el.previousElementSibling && el.previousElementSibling.id === 'bfBtn'),
        beforeBfNote: !!(el && el.nextElementSibling && el.nextElementSibling.id === 'bfNote')
      };
    })()`);
    A(vis.gameOn === true, "游戏已进入沙盘（#game.on）");
    A(vis.inSide === true, "影子输入块挂在 #side 里（侧栏）");
    A(vis.afterMjBtn === true && vis.beforeBfNote === true, "位置紧挨「🀄 找人打两圈」「🍳 做份早餐」（同一区域）");
    A(vis.display === "" && vis.cssDisplay !== "none", "影子输入块可见（display 不是 none）", "display=" + JSON.stringify(vis.display));
    A(vis.inViewport === true, "**滚进视口后确实看得见**", JSON.stringify(vis.box) + " 视口高=" + (await ev("window.innerHeight")));
    A(vis.inputBox && vis.inputBox[1] >= 14, "输入框真的渲染出来了", JSON.stringify(vis.inputBox));
    A(/说一句你想做的事/.test(String(vis.placeholder)), "占位文案正确", vis.placeholder);
    A(vis.btn === "发送", "提交按钮文案", vis.btn);
    A(vis.sideW > 0, "侧栏宽度正常（未被窄屏媒体查询隐藏）", vis.sideW + "px");

    /* ── 2. 假响应阶段：判定 + 不跳转 + 真实入口回填 ── */
    const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "nlroute", "c01-mahjong.json"), "utf8"));
    const FIXTURE_BF = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "nlroute", "c10-breakfast.json"), "utf8"));
    const FIXTURE_TALK = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "nlroute", "c03-talk.json"), "utf8"));
    const injectFake = (fx) => ev(`window.NLRoute.debug.setFetch(function(url, init){
      if (/\\/health$/.test(String(url))) return Promise.resolve({ status:200, ok:true, json:function(){ return Promise.resolve({ok:true,service:"nlroute-browser-fake"}); } });
      return Promise.resolve({ status:200, ok:true, json:function(){ return Promise.resolve(${JSON.stringify(fx)}); } });
    })`);
    await injectFake(FIXTURE);

    const SNAP = `(function(){
      return {
        overlays: [].slice.call(document.querySelectorAll('.overlay')).map(function(o){ return o.id + ':' + (o.classList.contains('on')?1:0); }).join(','),
        mjBusy: (window.Mahjong && Mahjong.isBusy) ? Mahjong.isBusy() : null,
        bfBusy: (window.Breakfast && Breakfast.isBusy) ? Breakfast.isBusy() : null,
        doneLen: (typeof S !== 'undefined' && S && S.done) ? S.done.length : -1,
        bonds: JSON.stringify((typeof S !== 'undefined' && S && S.bonds) || null),
        save: localStorage.getItem('cs2_save') || '',
        uiMsg: document.getElementById('nlMsg').textContent,
        logLen: window.NLRoute.log().length
      };
    })()`;
    const snap = () => ev(SNAP);
    const diffOf = (a, b, keys) => keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .map((k) => k + ": " + JSON.stringify(a[k]).slice(0, 60) + " → " + JSON.stringify(b[k]).slice(0, 60));

    const before = await snap();
    await ev("document.getElementById('nlInput').value = '我想去打两圈'");
    await ev("document.getElementById('nlGo').click()");
    for (let i = 0; i < 40; i++) { if (/影子模式/.test(String(await ev("document.getElementById('nlMsg').textContent")))) break; await sleep(50); }
    const after = await snap();
    A(after.overlays === before.overlays, "**提交后没有任何 overlay 被打开**（玩法状态不变）", after.overlays);
    A(after.mjBusy === before.mjBusy && after.bfBusy === before.bfBusy, "Mahjong/Breakfast isBusy 未变", after.mjBusy + "/" + after.bfBusy);
    A(after.doneLen === before.doneLen, "剧情节点进度（S.done）没变", after.doneLen);
    A(diffOf(before, after, ["overlays", "mjBusy", "bfBusy", "doneLen"]).length === 0, "提交前后玩法硬状态零差异");
    A(after.bonds === before.bonds, "羁绊数值一位都没动", diffOf(before, after, ["bonds"]).join(" | "));
    await sleep(700);
    const control = await snap();
    A(diffOf(after, control, ["overlays", "mjBusy", "bfBusy"]).length === 0, "控制窗口（只等 700ms 不提交）：玩法状态同样不变");
    if (diffOf(after, control, ["save", "bonds", "doneLen"]).length) {
      console.log("    ℹ 控制窗口里剧情自身的推进改了：" + diffOf(after, control, ["save", "bonds", "doneLen"]).join(" | "));
    }
    A(/影子模式/.test(String(after.uiMsg)) && /未跳转/.test(String(after.uiMsg)), "UI 只给一行轻提示", after.uiMsg);
    A(/识别为「麻将 · 听牌挑战」100%/.test(String(after.uiMsg)), "提示里含识别结果与置信度", after.uiMsg);
    const L1 = JSON.parse(await ev("JSON.stringify(window.NLRoute.log())"));
    A(L1.length === 1, "语料记了 1 条", L1.length);
    A(L1[0].intent === "mahjong" && L1[0].actual === null, "记录 intent=mahjong、actual 仍为 null");
    A(JSON.parse(await ev("localStorage.getItem('cs2_nl_log')")).length === 1, "记录真的落在 localStorage 的 cs2_nl_log 里");
    const stats1 = JSON.parse(await ev("JSON.stringify(window.NLRoute.debug.stats())"));
    A(stats1.ok === 1 && stats1.errors === 0, "stats：1 次成功、0 次失败", JSON.stringify(stats1));

    /* 真实入口 ①：侧栏「🀄 找人打两圈」 */
    await ev("document.getElementById('mjFreeBtn').click()");
    await sleep(500);
    let st = await ev("(function(){var l=window.NLRoute.log(); return {rec:l[l.length-1], lobbyOn:document.getElementById('mjLobby').classList.contains('on')};})()");
    A(st.rec.actual === "mahjong", "点侧栏「🀄 找人打两圈」→ actual 回填 mahjong", JSON.stringify(st.rec.actual));
    A(/mjFreeBtn/.test(String(st.rec.actualWhy)), "回填来源记的是真入口", st.rec.actualWhy);
    A(st.lobbyOn === true, "原有入口行为没被改（开局面板照样打开）");
    await ev("document.getElementById('mjLobby').classList.remove('on')");

    /* 真实入口 ②：侧栏「🍳 做份早餐」 */
    await injectFake(FIXTURE_BF);
    await ev("document.getElementById('nlInput').value = '给他做份早餐'");
    await ev("document.getElementById('nlGo').click()");
    await sleep(600);
    await ev("document.getElementById('bfBtn').click()");
    await sleep(400);
    st = await ev("(function(){var l=window.NLRoute.log(); return {rec:l[l.length-1], bfPickOn:document.getElementById('bfPick').classList.contains('on')};})()");
    A(st.rec.actual === "breakfast", "点侧栏「🍳 做份早餐」→ actual 回填 breakfast", JSON.stringify(st.rec.actual));
    A(st.bfPickOn === true, "选对象面板照常打开（入口行为未变）");
    await ev("document.getElementById('bfPick').classList.remove('on')");

    /* 真实入口 ③：剧情节点开面板（**只走 MutationObserver**，不点任何按钮） */
    await injectFake(FIXTURE_TALK);
    await ev("document.getElementById('nlInput').value = '去跟金老板谈谈'");
    await ev("document.getElementById('nlGo').click()");
    await sleep(600);
    await ev("document.getElementById('talk').classList.add('on')");
    await sleep(300);
    st = await ev("(function(){var l=window.NLRoute.log(); return {rec:l[l.length-1], hits:window.NLRoute.debug.hooks().overlayHits};})()");
    A(st.rec.actual === "talk", "剧情打开 #talk 面板 → overlay 观察者回填 talk", JSON.stringify(st.rec.actual));
    A(st.hits > 0, "overlay 观察者确实被触发过", "overlayHits=" + st.hits);
    await ev("document.getElementById('talk').classList.remove('on')");

    /* 截图（侧栏可见性证据） */
    try {
      fs.mkdirSync(path.dirname(SHOT), { recursive: true });
      const s = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(SHOT, Buffer.from(s.result.data, "base64"));
      A(fs.statSync(SHOT).size > 20000, "截图已保存（沙盘 + 侧栏影子输入块）", SHOT + " · " + fs.statSync(SHOT).size + "B");
    } catch (e) { A(false, "截图失败", String(e && e.message)); }

    /* ── 3. 真端到端：页面 → 反代 → TypeSafe（真 key），仍然不跳转 ── */
    const jumpBefore = await ev(SNAP);
    await ev("window.NLRoute.debug.setFetch(null)");          // 撤掉假 fetch → 走真网络
    let liveOut = null;
    if (live) {
      /* 用一句**没在此前出现过**的话，避免吃到 30s 内存缓存（否则测的就不是真网络了） */
      await ev("(function(){ document.getElementById('nlInput').value = '手痒了，想上桌搓一把'; document.getElementById('nlGo').click(); })()");
      for (let i = 0; i < 150; i++) {                            // 真接口 + 跨境：最多等 15s
        const m = String(await ev("document.getElementById('nlMsg').textContent"));
        if (/影子模式|解析失败/.test(m)) break;
        await sleep(100);
      }
      const rec = JSON.parse(await ev("JSON.stringify(window.NLRoute.log().slice(-1)[0])"));
      liveOut = { msg: await ev("document.getElementById('nlMsg').textContent"), rec: rec };
      A(rec.cached === false, "这一条**不是缓存**（走的是真网络）", "cached=" + rec.cached);
      A(rec.intent === "mahjong", "**真接口（经反代）→ intent=mahjong**", "intent=" + rec.intent + " conf=" + rec.confidence + " err=" + rec.error);
      A(rec.error === null, "真接口这条没有 error", String(rec.error));
      A(rec.confidence >= 0.5, "真接口置信度正常", String(rec.confidence));
      A(rec.latencyMs >= 100, "记录里有真实网络延迟（不是缓存命中）", rec.latencyMs + "ms");
      A(/识别为「麻将 · 听牌挑战」/.test(String(liveOut.msg)), "UI 提示与真返回一致", liveOut.msg);
    } else {
      console.log("    ℹ 没读到真 key / --no-live：跳过真接口端到端（反代 503 路径下面单独验）");
    }
    /* 关键：走了真接口之后，页面**依然没有任何跳转** */
    const jumpAfter = await ev(SNAP);
    A(jumpAfter.overlays === jumpBefore.overlays, "**真接口路由之后也没有任何 overlay 被打开**", jumpAfter.overlays);
    A(jumpAfter.mjBusy === jumpBefore.mjBusy && jumpAfter.bfBusy === jumpBefore.bfBusy, "真接口路由后 isBusy 未变");
    A(jumpAfter.doneLen === jumpBefore.doneLen, "真接口路由后剧情进度未变");
    A(jumpAfter.bonds === jumpBefore.bonds, "真接口路由后羁绊数值未变");

    /* 真实入口对账：真路由之后再点一次真入口 → actual 回填，且 stats.agree 记一笔 */
    if (live) {
      await ev("document.getElementById('mjFreeBtn').click()");     // 真入口：找人打两圈
      await sleep(400);
      const rec2 = JSON.parse(await ev("JSON.stringify(window.NLRoute.log().slice(-1)[0])"));
      A(rec2.actual === "mahjong", "真路由那条语料被真入口回填 actual=mahjong", JSON.stringify(rec2.actual));
      A(/mjFreeBtn/.test(String(rec2.actualWhy)), "回填来源记的是真入口", rec2.actualWhy);
      const dump = JSON.parse(await ev("JSON.stringify(window.NLRoute.exportJSON())"));
      A(dump.stats.filled >= 4, "导出对账：filled=" + dump.stats.filled, "agree=" + dump.stats.agree + " disagree=" + dump.stats.disagree + " byActual=" + JSON.stringify(dump.stats.byActual));
      A(dump.stats.disagree === 0, "四条语料的「模型判断 == 真实去向」全部对上（agree=" + dump.stats.agree + "）");
      evidence.corpus = dump;
      await ev("document.getElementById('mjLobby').classList.remove('on')");
    }

    /* ── 4. 直连对照：CORS 被拦（说明为什么必须走反代） ── */
    await ev("(function(){ NLRoute.configure('apikey_not_a_real_key_for_cors_check'); NLRoute.debug.setEndpoint('https://api.typesafe.ai/v1/systemone'); })()");
    const direct = JSON.parse(await ev("window.NLRoute.route('我想去刮张彩票试试手气').then(function(r){ return JSON.stringify({intent:r.intent,error:r.error,skipped:r.skipped}); })"));
    A(direct.intent === "none" && !!direct.error, "直连官方端点 → 被浏览器拦下（route 仍返回 none + error，不抛）", JSON.stringify(direct));
    A(/Failed to fetch/i.test(String(direct.error)), "错误就是 CORS 造成的 Failed to fetch（这就是默认走反代的理由）", String(direct.error));
    A((await ev("[].slice.call(document.querySelectorAll('.overlay')).filter(function(o){return o.classList.contains('on');}).length")) === 0, "直连失败路径也没有打开任何玩法");

    /* ── 5. 反代停掉 → 降级表现 ── */
    try { proxy.child.kill(); } catch (e) { }
    await sleep(700);
    /* UI 可见性规则：配过 key 的人（这里刚配过）→ 仍可见，好看见原因 */
    await ev("window.NLRoute.debug.setEndpoint('http://127.0.0.1:" + PROXY_PORT + "/route')");
    const probeDown = await ev("window.NLRoute.probe()");
    A(probeDown === false, "反代停掉 → probe() === false");
    A(await ev("window.NLRoute.available()") === false, "反代停掉 → available()===false");
    await ev("document.getElementById('nlInput').value = '我想去打两圈啊'");
    await ev("document.getElementById('nlGo').click()");
    await sleep(900);
    const downMsg = String(await ev("document.getElementById('nlMsg').textContent"));
    A(/本地反代没在跑/.test(downMsg), "UI 提示准确：本地反代没在跑", downMsg);
    A(/nlroute-proxy/.test(downMsg), "提示里给出启动命令");
    A((await ev("[].slice.call(document.querySelectorAll('.overlay')).filter(function(o){return o.classList.contains('on');}).length")) === 0, "反代停掉时也没有打开任何玩法");
    A(await ev("typeof window.NLRoute.route === 'function'") === true, "模块仍然在世（没有崩、没影响游戏）");

    /* ── 5b. 全新玩家视角（验收方 P1 第 3 条）：**没 key + 反代没起**也要看得见指引 ── */
    await ev("window.NLRoute.configure('')");                       // 一个凭据都不留（模拟全新装的玩家）
    const logLenBefore = await ev("window.NLRoute.log().length");
    const fresh = await ev(`(function(){
      var el = document.getElementById('nlShadow');
      var r = el.getBoundingClientRect();
      return {
        hasKey: localStorage.getItem('cs2_ts_key') !== null,
        available: window.NLRoute.available(),
        display: el.style.display,
        visible: getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0,
        msg: document.getElementById('nlMsg').textContent
      };
    })()`);
    A(fresh.hasKey === false && fresh.available === false, "全新玩家：没有 key、端点也不可用");
    A(fresh.display !== "none" && fresh.visible === true, "**但影子块仍然可见**（否则看不到任何指引）", "display=" + JSON.stringify(fresh.display));
    A(/本地反代没在跑/.test(String(fresh.msg)) && /nlroute-proxy/.test(String(fresh.msg)), "提示直接给出启动命令", fresh.msg);
    A((await ev("window.NLRoute.log().length")) === logLenBefore, "仅仅显示指引**不会**产生任何记录/请求");
    A((await ev("[].slice.call(document.querySelectorAll('.overlay')).filter(function(o){return o.classList.contains('on');}).length")) === 0, "全新玩家视角下也没有任何跳转");

    /* ── 6. console error 检查（唯一允许的是浏览器自己报的 CORS） ── */
    const corsErrs = pageErrors.filter((t) => /CORS policy|Access-Control-Allow-Origin/i.test(String(t)));
    const errs = pageErrors.filter((t) => !/favicon|net::ERR|Failed to load resource/i.test(String(t)) && !/CORS policy|Access-Control-Allow-Origin/i.test(String(t)));
    A(errs.length === 0, "除浏览器自己报的 CORS 外，没有任何页面级 console error", errs.slice(0, 3).join(" | "));
    A(corsErrs.length >= 1, "（证据）直连对照确实触发了 CORS 拦截", String(corsErrs[0]).slice(0, 110));

    /* ── 7. 反代日志不泄 key ── */
    const plog = proxy.log();
    A(!/apikey_[A-Za-z0-9]{8,}/.test(plog), "反代进程输出里没有凭据形状的串");
    A(/POST \/route/.test(plog), "反代日志记到了 /route 请求");

    evidence.liveResult = liveOut;
    evidence.pageErrors = pageErrors;
    evidence.proxyLog = plog.split("\n").slice(-12);
    fs.writeFileSync(path.join(ROOT, "测试截图", "nlroute-browser-verify.json"), JSON.stringify(evidence, null, 1));
    console.log("\n  · 证据：" + SHOT);
    console.log("  · 证据：" + path.join(ROOT, "测试截图", "nlroute-browser-verify.json"));
  } catch (e) {
    errors.push("探针异常：" + (e && e.stack || e));
    console.log("  ✖ 探针异常：" + (e && e.stack || e));
  } finally {
    if (cdp) cdp.close();
    if (!KEEP) {
      if (chrome) { try { chrome.kill(); } catch (e) { } }
      if (proxy && proxy.child) { try { proxy.child.kill(); } catch (e) { } }
      if (srv) { try { srv.close(); } catch (e) { } }
      try { fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) { }
    }
  }
  console.log("\n" + "═".repeat(72));
  console.log("通过 " + checks.length + " 项，失败 " + errors.length + " 项");
  if (errors.length) { errors.forEach((e) => console.log("   · " + e)); process.exit(1); }
  console.log("✔ 真浏览器验证：影子模式不跳转 + 真实入口回填 + 反代端到端全部成立");
  process.exit(0);
}
