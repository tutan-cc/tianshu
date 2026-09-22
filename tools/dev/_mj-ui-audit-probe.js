/* ═══════════════════════════════════════════════════════════════════════════
   tools/dev/_mj-ui-audit-probe.js — 人类/UI 路径 + 渲染层 牌张守恒审计探针

   为什么还要这个：纯逻辑探针（_mj-tile-audit-probe.js）跑 600 局 77248 拍全绿，
   说明「AI 四家互打」的引擎路径是守恒的。用户实测看到的是**真实页面 + 真鼠标点击 +
   真定时器节奏**下的画面，所以还必须审计：
     ① 人类座位（isHuman=true）的路径：pump / showHumanUI / resolveAct / 挂机定时器 / onClick
     ② 渲染层：每一帧「画面上每种牌各几张」（renderAudit，不猜像素）
   本探针用真 Chrome(headless CDP) 打开 index.html → 跳到麻将 → 审计整局。

   用法：node tools/dev/_mj-ui-audit-probe.js [--games=40] [--live=1]
     --games=N  快进局数（debug.step + debug.act，每拍 + 每帧审计）
     --live=N   真实节奏局数（真 pump 定时器 + 真鼠标点手牌，最贴近用户实测）
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9246;
const OUT = path.join(__dirname, "..", "..");
const BASE = "file:///" + OUT.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
const PROF = OUT + "\\_prof_tileaudit";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const argv = process.argv.slice(2);
const argNum = (n, d) => { const m = argv.find(a => a.indexOf("--" + n + "=") === 0); return m ? +m.split("=")[1] : d; };
const GAMES = argNum("games", 40);
const LIVE = argNum("live", 1);
const argvHas = n => argv.some(a => a === "--" + n || a.indexOf("--" + n + "=") === 0);

function req(method, p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method }, resp => {
      let d = ""; resp.on("data", c => d += c);
      resp.on("end", () => { try { res(JSON.parse(d)); } catch (e) { res(d); } });
    });
    r.on("error", rej); r.end();
  });
}
let id = 0, ws, pend = {};
function send(m, p) {
  return new Promise((res, rej) => {
    const i = ++id; pend[i] = res;
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    setTimeout(() => { if (pend[i]) { delete pend[i]; rej(new Error("timeout " + m)); } }, 60000);
  });
}
async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: false });
  if (r.result && r.result.exceptionDetails) return "EXC:" + ((r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text || "");
  return r.result && r.result.result ? r.result.result.value : undefined;
}

/* ── 页内：一局快进自走 + 每拍每帧审计（同步执行，避免上百次往返）
      policy.peng=1 → 人类座位的碰/杠窗口一律吃下（覆盖「人真的碰/杠」这条路径，
      否则 1675 拍里人类一次都没碰过 —— 那是最大的覆盖盲区）。 ── */
const FAST_GAME = `(function(policy){
  policy = policy || {};
  var MJ = window.Mahjong;
  var out = { beats: 0, frames: 0, renderOver: [], renderMax: 0, renderModes: {}, steps: 0,
              acts: {}, bad: 0, err: "", phase: "?", melds: 0 };
  if (!MJ || !MJ.debug || !MJ.debug.tileAudit) { out.err = "no-tileAudit-api"; return out; }
  MJ.debug.tileAuditInstall();
  MJ.debug.tileAuditOn(true, null);
  function oneFrame(){
    try { MJ.debug.render(); } catch(e) { out.err = "render:" + (e.message||e); }
    out.frames++;
    var ra = MJ.debug.renderAudit();
    if (ra) {
      out.renderModes[ra.mode] = (out.renderModes[ra.mode]||0) + 1;
      if (ra.max > out.renderMax) out.renderMax = ra.max;
      if (!ra.ok && !ra.debugView && out.renderOver.length < 12) out.renderOver.push(ra);
    }
  }
  oneFrame();
  var guard = 0, miss = 0;
  while (guard++ < 4000) {
    var E = MJ.debug.engine();
    if (!E || E.phase === "over" || E.result) break;
    var pend = E.pending, h = E.P[0].hand.length, a = "";
    if (E.phase === "claim" && pend && pend.seat === 0) {
      if (policy.peng === 0) a = "pass";
      else if (pend.actions.indexOf("gang") >= 0) a = "gang";
      else if (policy.peng === 2 && pend.actions.indexOf("peng") >= 0) a = "peng";
      else a = "pass";
    }
    else if (E.phase === "rob" && pend && pend.seats && pend.seats.indexOf(0) >= 0) a = "pass";
    else if (E.phase === "turn" && E.cur === 0) {
      var kk = pend || {};
      if (policy.gang !== false && ((kk.anGangs && kk.anGangs.length) || (kk.addGangs && kk.addGangs.length))) a = "gang";
      else if (h % 3 === 2) a = "discard";
      else if (h % 3 === 1) a = "draw";
    }
    if (a) {
      out.acts[a] = (out.acts[a]||0)+1;
      if (!MJ.debug.act(a)) { if (++miss > 3) { out.bad++; break; } } else miss = 0;
    } else {
      var r = MJ.debug.step();
      out.steps++;
      if (r === "over" || r === "off") break;
      if (r === "wait") { if (++miss > 3) { out.bad++; break; } } else miss = 0;
    }
    oneFrame();
  }
  var rs = MJ.debug.tileAuditState();
  out.beats = rs.n; out.fails = rs.fails;
  out.report = MJ.debug.tileAuditReport();
  var st = MJ.debug.state();
  out.phase = st ? st.phase : "?";
  out.handLen = st ? st.handCount : -1;
  out.melds = E && E.P[0] ? E.P[0].melds.length : -1;
  try { MJ.dispose(); } catch(e) {}          /* 清掉挂起的 pump 定时器，避免返回后牌局继续跑 */
  return out;
})`;

/* ── 页内：真实节奏局的「一拍」——人在环只处理响应窗口，其余交给真 pump ── */
const LIVE_TICK = `(function(){
  var MJ = window.Mahjong, E = MJ.debug.engine();
  var ra = null;
  try { MJ.debug.render(); ra = MJ.debug.renderAudit(); } catch(e) {}
  var act = "";
  if (E && E.phase === "claim" && E.pending && E.pending.seat === 0) act = "pass";
  else if (E && E.phase === "rob" && E.pending && E.pending.seats && E.pending.seats.indexOf(0) >= 0) act = "pass";
  if (act) MJ.debug.act(act);
  var rs = MJ.debug.tileAuditState(), st = MJ.debug.state();
  return { phase: st ? st.phase : "?", cur: st ? st.cur : -1, hand: st ? st.handCount : -1,
           act: act, beats: rs.n, fails: rs.fails, over: !!(st && (st.result || st.phase === "over")),
           frame: ra ? { ok: ra.ok, mode: ra.mode, max: ra.max, total: ra.total, over: ra.over } : null };
})()`;

/* ── 页内：复现「桌上出现六张六条」 ──
   做法（与用户截图同形）：先真打若干拍，找到一张「别处已经有 n 张」的牌 T，
   再用调试摆牌 API（Mahjong.debug.setHand —— tools/e2e 里用的同一个 API）
   把一张含 3 张 T 的手牌摆上去 → 摆牌**只加不减**，全场 T 立刻变成 n+3 张。
   然后同时读两个口径：tileAudit()（容器守恒）与 renderAudit()（本帧画面上每张牌各几张）。 */
function reproScript(wantTile) {
  return `(function(){
  var MJ = window.Mahjong, out = { ok: true };
  MJ.debug.tileAuditInstall(); MJ.debug.tileAuditOn(true, null);
  /* ① 真打若干拍（AI + 人类出牌都走真实引擎路径），让牌分布到四个容器里 */
  var guard = 0;
  while (guard++ < 46) {
    var E = MJ.debug.engine();
    if (!E || E.phase === "over" || E.result) break;
    var pend = E.pending, h = E.P[0].hand.length, a = "";
    if (E.phase === "claim" && pend && pend.seat === 0) a = "pass";
    else if (E.phase === "rob" && pend && pend.seats && pend.seats.indexOf(0) >= 0) a = "pass";
    else if (E.phase === "turn" && E.cur === 0 && h % 3 === 1) a = "draw";
    else if (E.phase === "turn" && E.cur === 0 && h % 3 === 2) a = "discard";
    if (a) { if (!MJ.debug.act(a)) break; } else { if (MJ.debug.step() === "over") break; }
  }
  var before = MJ.debug.tileAudit();
  out.before = { ok: before.ok, total: before.total, expect: before.expect, beats: MJ.debug.tileAuditState().n,
                 places: MJ.debug.tileAuditPlaces(before) };
  /* ② 选一张「别处已有若干张」的牌：优先用户说的 6条，其次挑「别处张数最多」的那张 */
  var E2 = MJ.debug.engine();
  function mineOf(t) { var n = 0; for (var i = 0; i < E2.P[0].hand.length; i++) if (E2.P[0].hand[i] === t) n++; return n; }
  function elsewhereOf(t) { return (before.byType[t] || 0) - mineOf(t); }
  var want = ${JSON.stringify(wantTile)}, T = want, k;
  if (elsewhereOf(T) < 1) {
    var best = -1;
    for (k in before.byType) if (before.byType.hasOwnProperty(k)) {
      var e = elsewhereOf(k);
      if (e > best) { best = e; T = k; }
    }
    if (best < 1) { out.err = "没有一张牌「别处也有」——本次没构造出复现"; return out; }
  }
  out.rig = { tile: T, elsewhere: elsewhereOf(T), mine: mineOf(T),
              total_before: (before.byType[T] || 0) };
  /* ③ 摆一张「含 3 张 T」的 14 张手牌（tools/e2e 用的同一个调试 API）→ 只加不减 */
  var hand = [T, T, T], i2;
  for (i2 = 0; i2 < E2.P[0].hand.length && hand.length < 14; i2++) {
    if (E2.P[0].hand[i2] !== T) hand.push(E2.P[0].hand[i2]);
  }
  while (hand.length < 14) hand.push(T);
  out.setHand = MJ.debug.setHand(hand, [], null);
  var after = MJ.debug.tileAudit();
  out.after = { ok: after.ok, total: after.total, expect: after.expect, tile: T,
                count: after.byType[T], places: MJ.debug.tileAuditPlaces(after),
                violations: after.violations.map(function (v) { return { tile: v.tile, count: v.count, where: v.where }; }) };
  /* ④ 渲染一帧：读「本帧画面上这张牌各画了几张」 */
  try { MJ.debug.render(); } catch (e) { out.renderErr = String(e.message || e); }
  var ra = MJ.debug.renderAudit();
  out.render = ra ? { ok: ra.ok, mode: ra.mode, total: ra.total, max: ra.max, over: ra.over,
                      tileFaces: (ra.byType && ra.byType[T]) || 0 } : null;
  out.handShown = MJ.debug.hand().length;
  out.ok = out.before.ok && after.ok && (!ra || ra.ok);
  return out;
})()`;
}

(async () => {
  try { fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) {}
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1440,900",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--allow-file-access-from-files", "--disable-web-security",
    "--hide-scrollbars", `--user-data-dir=${PROF}`, "about:blank"], { stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 60; i++) { try { await req("GET", "/json/version"); up = true; break; } catch (e) { await sleep(400); } }
  if (!up) { try { chrome.kill(); } catch (e) {} console.error("✗ Chrome 未启动调试端口（沙箱禁止命名管道？）"); process.exit(2); }

  const tab = await req("PUT", "/json/new?" + encodeURIComponent(BASE + "/index.html"));
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  await send("Page.enable"); await send("Runtime.enable");
  await sleep(2500);

  /* 跳到麻将面板（与 tools/e2e/mj-browser.js 同一条路径） */
  await ev('localStorage.clear()');
  await send("Page.navigate", { url: BASE + "/index.html" }); await sleep(2500);
  await ev('document.getElementById("dbgMj").click()'); await sleep(5200);
  await ev('document.getElementById("skipnode").click()'); await sleep(3200);
  const on = await ev('document.getElementById("mj").classList.contains("on")');
  const busy = await ev("Mahjong.isBusy()");
  const api = await ev("typeof Mahjong.debug.tileAudit");
  console.log("麻将面板 on=" + on + " busy=" + busy + " tileAudit=" + api);
  if (on !== true || api !== "function") { console.error("✗ 进不去麻将面板 / 没有 tileAudit API"); process.exit(2); }

  let bad = 0, gameFails = 0, renderViol = 0;
  const firstReport = [];

  /* ══════ 阶段 0：复现「桌上出现六张六条」（可选） ══════ */
  if (argvHas("repro")) {
    console.log("\n═══ 阶段 0：复现「桌上出现六张六条」（调试摆牌 API 只加不减）═══");
    for (const seedTile of ["6条", "5条"]) {
      await ev("Mahjong.start(document.getElementById('mj'), {})");
      await sleep(150);
      const r = await ev(reproScript(seedTile));
      if (typeof r === "string") { console.log("  复现异常：" + r); bad++; continue; }
      if (r.err) { console.log("  [" + seedTile + "] " + r.err); continue; }
      console.log("  ── 目标牌 " + r.rig.tile + "：摆牌前全场 " + r.rig.total_before + " 张（自己手牌 " +
        r.rig.mine + " + 别处 " + r.rig.elsewhere + "）");
      console.log("     真打 " + r.before.beats + " 拍后容器审计：" + (r.before.ok ? "ok" : "✖") + " · 总数 " +
        r.before.total + "/" + r.before.expect);
      console.log("     调试摆牌 setHand 返回 " + r.setHand + " → 摆牌后全场 " + r.rig.tile + " = " +
        r.after.count + " 张 · 总数 " + r.after.total + "/" + r.after.expect);
      console.log("     摆牌后逐位置：" + r.after.places);
      for (const v of r.after.violations) console.log("     ✖ " + (v.tile || "（结构）") + " × " + v.count + " → " + v.where);
      if (r.render) console.log("     本帧画面审计：" + (r.render.ok ? "ok" : "✖ 超标") + " · 画面共 " + r.render.total +
        " 张牌面 · 单种最大 " + r.render.max + " · " + r.rig.tile + " 画了 " + r.render.tileFaces + " 张" +
        ((r.render.over || []).length ? " · 超标牌面 " + JSON.stringify(r.render.over) : ""));
    }
    console.log("\n最终审计状态：" + await ev("JSON.stringify({fails: Mahjong.debug.tileAuditState().fails, n: Mahjong.debug.tileAuditState().n})"));
    try { chrome.kill(); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
  }

  /* ══════ 阶段 1：快进整局 × N（每拍 + 每帧审计） ══════ */
  console.log("\n═══ 阶段 1：UI 路径快进整局 × " + GAMES + "（人类座位 + 每拍审计 + 每帧渲染审计）═══");
  let totalBeats = 0, totalFrames = 0, maxFace = 0, acts = {};
  const modes = {};
  for (let g = 1; g <= GAMES; g++) {
    await ev("Mahjong.start(document.getElementById('mj'), {})");
    await sleep(150);
    /* 三种人类策略轮流：① 只过 ② 一律杠/碰 ③ 只碰不杠 —— 把「人真的碰/杠」这条路径跑满 */
    const pol = g % 3 === 0 ? { peng: 2, gang: true } : (g % 3 === 1 ? { peng: 1, gang: true } : { peng: 0, gang: false });
    const r = await ev(FAST_GAME + "(" + JSON.stringify(pol) + ")");
    if (typeof r === "string" || !r || r.err) { console.log("  局 " + g + " 异常：" + (typeof r === "string" ? r : JSON.stringify(r).slice(0, 300))); bad++; continue; }
    totalBeats += r.beats || 0; totalFrames += r.frames || 0;
    for (const k in (r.renderModes || {})) modes[k] = (modes[k] || 0) + r.renderModes[k];
    for (const k in (r.acts || {})) acts[k] = (acts[k] || 0) + r.acts[k];
    if (r.renderMax > maxFace) maxFace = r.renderMax;
    if (r.fails) { gameFails++; if (firstReport.length < 6) firstReport.push({ game: g, policy: pol, engine: r.report }); }
    if ((r.renderOver || []).length) { renderViol++; if (firstReport.length < 6) firstReport.push({ game: g, render: r.renderOver }); }
    if (g <= 3 || r.fails || (r.renderOver || []).length) {
      console.log("  局 " + String(g).padStart(3) + " 策略 " + (pol.peng === 2 ? "只碰" : (pol.peng === 1 ? "杠/碰" : "只过")) +
        " 拍 " + String(r.beats).padStart(4) + " 帧 " + String(r.frames).padStart(4) +
        " 引擎违规 " + r.fails + " 结算=" + r.phase + " 我副露=" + r.melds + " 单种最大可视 " + r.renderMax +
        ((r.renderOver || []).length ? " ✖渲染超标 " + JSON.stringify(r.renderOver[0].over) : ""));
    }
  }
  console.log("阶段1 合计：引擎审计 " + totalBeats + " 拍 · 渲染审计 " + totalFrames + " 帧 · 引擎违规局 " + gameFails +
    " · 渲染超标局 " + renderViol + " · 画面单种最大 " + maxFace + " 张（上限 4）");
  console.log("阶段1 帧类型：" + JSON.stringify(modes) + " · 人类座位动作：" + JSON.stringify(acts));

  /* ══════ 阶段 2：真实节奏（真 pump 定时器 + 真鼠标点手牌） ══════ */
  for (let g = 1; g <= LIVE; g++) {
    console.log("\n═══ 阶段 2：真实节奏局 " + g + "（真定时器 + 真鼠标 onClick）═══");
    await ev("Mahjong.start(document.getElementById('mj'), {})");
    await sleep(200);
    await ev("Mahjong.debug.tileAuditInstall(); Mahjong.debug.tileAuditOn(true, null)");
    let clicks = 0, ticks = 0, lastFails = 0, renderBad = 0, renderMax = 0, done = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) {
      const r = await ev(LIVE_TICK);
      ticks++;
      if (typeof r === "object" && r) {
        if (r.fails > lastFails) { console.log("  ✖ 第 " + r.beats + " 拍后引擎审计违规（fails=" + r.fails + "）"); lastFails = r.fails; }
        if (r.frame && !r.frame.ok && r.frame.mode !== "demo" && r.frame.mode !== "sheet") {
          renderBad++; console.log("  ✖ 渲染超标：" + JSON.stringify(r.frame));
        }
        if (r.frame && r.frame.max > renderMax) renderMax = r.frame.max;
        if (r.over) { done = true; break; }
        if (r.phase === "turn" && r.cur === 0 && r.hand % 3 === 2) {
          /* 真鼠标点手牌最后一张（走 onClick → hitHand → canHumanDiscard 全路径） */
          let rr = [];
          try { rr = JSON.parse(await ev("JSON.stringify(Mahjong.debug.handRects())") || "[]"); } catch (e) {}
          if (rr.length) {
            const t = rr[rr.length - 1];
            await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(t.cx), y: Math.round(t.cy), button: "none" });
            await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(t.cx), y: Math.round(t.cy), button: "left", clickCount: 1 });
            await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(t.cx), y: Math.round(t.cy), button: "left", clickCount: 1 });
            clicks++;
          }
        }
      }
      await sleep(400);
    }
    console.log("  局 " + g + "：tick " + ticks + " · 真鼠标点击 " + clicks + " · 渲染超标帧 " + renderBad +
      " · 画面单种最大 " + renderMax + " · 跑完=" + done);
    console.log("  引擎审计状态：" + await ev("JSON.stringify(Mahjong.debug.tileAuditState())"));
    console.log("  末帧渲染审计：" + await ev("JSON.stringify(Mahjong.debug.renderAudit())"));
    const parsed = JSON.parse((await ev("JSON.stringify(Mahjong.debug.tileAuditState())")) || "{}");
    if (parsed.fails) { bad++; console.log("  ✖ 违规明细：" + String(await ev("JSON.stringify(Mahjong.debug.tileAuditReport())")).slice(0, 3000)); }
    if (renderBad) bad++;
  }

  console.log("\n最终审计状态：" + await ev("JSON.stringify({fails: Mahjong.debug.tileAuditState().fails, n: Mahjong.debug.tileAuditState().n})"));
  if (firstReport.length) { console.log("\n首次违规取证："); console.log(JSON.stringify(firstReport, null, 1).slice(0, 6000)); }
  console.log(gameFails || renderViol || bad ? "\n✖ 发现违规（引擎 " + gameFails + " 局 / 渲染 " + renderViol + " 局 / 其他 " + bad + "）"
    : "\n✔ 未发现违规：引擎每拍守恒 + 每帧画面单种 ≤4");

  try { chrome.kill(); } catch (e) {}
  await sleep(400);
  try { fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) {}
  process.exit(gameFails || renderViol || bad ? 1 : 0);
})().catch(async e => { console.error("✗ " + (e && e.stack || e)); process.exit(3); });
