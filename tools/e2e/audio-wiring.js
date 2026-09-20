// 素材接线核对：代码点名的每一个音频文件是否**真的能取到**。
//
// 为什么必须单独做一层（这是本轮踩过的最贵的坑）：
//   AudioSys / mahjong.js 全层都是「有文件用文件，缺失回落合成」。
//   这个设计本身是对的（素材没到位时游戏照常发声），
//   但它让「素材缺失」与「素材接错」在断言层面**完全无法区分** ——
//   实测 1542 项断言全绿的情况下，牌桌上「暗杠」「补杠」完全没有声音：
//   VOICE_NAMES 登记了它们 → 素材侧按设计不生成 → 四座位全 404 →
//   Audio 无 error 兜底 → say() 只看对象非空 → 静默丢弃、不报错、不计 misses。
//
//   所以必须到运行时**主动探测存在性**：读路径 → 发请求看状态码 → 试播看 error。
//   本脚本覆盖：音效(audio/sfx) · 环境音(audio/amb) · BGM(audio/bgm) · 麻将牌名(audio/mj/*)
//
// 用法：node tools/e2e/audio-wiring.js
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { resultsFile } = require("../lib/dist.js");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9261;
const OUT = path.join(__dirname, "..", "..");
// 走 HTTP 而不是 file://：与玩家实际访问一致（python -m http.server 8000）
const HTTP_BASE = process.env.WIRING_BASE || "http://127.0.0.1:8000";
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
  if (r.result && r.result.exceptionDetails) return "EXC:" + ((r.result.exceptionDetails.exception || {}).description || "");
  return r.result && r.result.result ? r.result.result.value : undefined;
}

(async () => {
  const checks = [], errors = [];
  const A = (ok, name, detail) => {
    const line = name + (detail === undefined ? "" : "  [" + detail + "]");
    ok ? checks.push(line) : errors.push(line);
  };

  // 先确认 HTTP 服务在跑（素材存在性必须走真实服务判断）
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
    console.log("       （用 file:// 也能查存在性，但那不是玩家的访问方式，故不降级）");
    process.exit(0);
  }

  /* ⚠ --disk-cache-size=1：**必须关掉 Chrome 的磁盘缓存**。
     本脚本用的是固定 profile（仓库里的 _prof_wiring），缓存会跨次运行留着。
     改完 mahjong.js 再跑，浏览器可能仍在跑缓存里的**旧脚本** ——
     实测：素材侧全绿（251 个文件 HTTP 200），却报「空URL seat0/东风」，
     因为跑的是旧词表（旧表里没有「东风」这个键）；换个全新 profile 立刻正常。
     那等于「断言测的不是你改的那份代码」，比测试失败更危险。 */
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1440,900",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--disk-cache-size=1", "--media-cache-size=1",
    `--user-data-dir=${OUT}\\_prof_wiring`, "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) { try { await req("GET", "/json/version"); break; } catch (e) { await sleep(400); } }
  const tab = await req("PUT", "/json/new?" + encodeURIComponent(HTTP_BASE + "/index.html"));
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  await send("Page.enable"); await send("Runtime.enable");
  await sleep(3000);

  /* ── 1. 音效 / 环境音：从磁盘清单交叉核对（代码里是变量拼名，跑不到全部）── */
  /* ⚠ 默认值必须是**仓库根**，不是那个外部媒体库。
     音频早已随仓库入库（仓库根 audio/ 是唯一权威，见 tools/audio/paths.py 的说明），
     媒体库现在只放第三方视频。写死 "H:\\GAMEDEV\\..." 的后果实测过：
     换台机器 / 换个人 clone，这条路根本不存在 →
     names.sfx/amb/bgm/mj 全是空数组 → 「音效文件数 ≥60」「环境音 9 个」「BGM 5 种情绪」
     「voiceStats().total 与素材文件数一致」四条直接失败（本地实测 6/10）。
     更坏的是「四个座位牌名集合完全相同」这类**空集合对比**会假绿（0 == 0）——
     素材全丢也照样通过。所以默认值只能是仓库根，媒体库靠 MEDIA_ROOT 显式覆盖。 */
  const MEDIA = process.env.MEDIA_ROOT || path.join(__dirname, "..", "..");
  const dirs = {
    sfx: path.join(MEDIA, "audio", "sfx"),
    amb: path.join(MEDIA, "audio", "amb"),
    bgm: path.join(MEDIA, "audio", "bgm"),
    mj: path.join(MEDIA, "audio", "mj"),
  };
  const names = {};
  for (const k of Object.keys(dirs)) {
    names[k] = fs.existsSync(dirs[k])
      ? fs.readdirSync(dirs[k]).filter(f => f.endsWith(".mp3")).map(f => f.slice(0, -4))
      : [];
  }
  A(names.sfx.length >= 60, "音效文件数 ≥60", names.sfx.length);
  A(names.amb.length === 9, "环境音 9 个地点齐", names.amb.length);
  // BGM：代码里 bgm(mood) 的 5 个取值必须都有文件，否则静默回落合成
  const MOODS = ["calm", "city", "tense", "night", "dark"];
  const missBgm = MOODS.filter(m => names.bgm.indexOf(m) < 0);
  A(missBgm.length === 0, "BGM 5 种情绪齐全（audio/bgm/<mood>.mp3）",
    missBgm.length ? "缺 " + missBgm.join(",") : names.bgm.join(","));

  /* ── 2. 座位牌名：四个座位集合必须一致（不一致就会 404 后无兜底）── */
  const seats = ["", "seat1", "seat2", "seat3"];
  const seatSets = seats.map(s => {
    const d = s ? path.join(dirs.mj, s) : dirs.mj;
    return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith(".mp3")).map(f => f.slice(0, -4)).sort() : [];
  });
  A(seatSets.every(s => s.length === seatSets[0].length), "四个座位牌名数量一致",
    seatSets.map((s, i) => (seats[i] || "座位0") + ":" + s.length).join(" "));
  const diffSeat = seatSets.slice(1).map((s, i) =>
    s.filter(x => seatSets[0].indexOf(x) < 0).concat(seatSets[0].filter(x => s.indexOf(x) < 0)));
  A(diffSeat.every(d => d.length === 0), "四个座位牌名集合完全相同",
    diffSeat.some(d => d.length) ? JSON.stringify(diffSeat) : "4×" + seatSets[0].length);

  /* ── 3. 真发 HTTP 请求：确认每个文件都能取到（这是抓 404 的关键一步）── */
  const probe = await ev([
    '(async function(){',
    '  var out = { ok: 0, bad: [] };',
    '  var list = ' + JSON.stringify(
      Object.keys(dirs).flatMap(k => names[k].map(n => {
        const sub = k === "mj" ? "mj/" : k + "/";
        return "audio/" + sub + n + ".mp3";
      })).concat(seatSets.slice(1).flatMap((s, i) =>
        s.map(n => "audio/mj/seat" + (i + 1) + "/" + n + ".mp3")))
    ) + ';',
    '  for (var i = 0; i < list.length; i++) {',
    '    try { var r = await fetch(list[i], { method: "HEAD" });',
    '      if (r.status === 200) out.ok++; else out.bad.push(r.status + " " + list[i]); }',
    '    catch (e) { out.bad.push("ERR " + list[i]); }',
    '  }',
    '  out.total = list.length;',
    '  return JSON.stringify(out);',
    '})()'
  ].join("\n"));
  let pr = {};
  try { pr = JSON.parse(probe); } catch (e) { pr = { ok: 0, bad: ["解析失败:" + probe], total: 0 }; }
  A(pr.bad.length === 0, "全部素材文件 HTTP 200", `${pr.ok}/${pr.total}` + (pr.bad.length ? " 坏:" + pr.bad.slice(0, 6).join(" | ") : ""));

  /* ── 4. 语音路径解析 + 回落逻辑（代码侧）── */
  const vres = await ev([
    '(async function(){',
    '  var d = window.Mahjong && window.Mahjong.debug;',
    '  if (!d || !d.voiceUrl) return JSON.stringify({ err: "无 Mahjong.debug.voiceUrl" });',
    '  var out = { words: 0, bad: [], total: 0, stats: null };',
    '  /* 改字牌念法之后，**素材文件名就是语音词表的键**（东风/南风/…/红中/发财/白板），',
    '     所以直接把文件名交给 voiceUrl() 即可。这里原先有一层「发 → 發」的首字替换：',
    '     它把文件名当"代码词汇"来猜，改名后会造出「發财」这种不存在的名字（误报），',
    '     那个「看到首字就替换」的写法本身就是隐患，已随改造删掉。',
    '     牌面字符（东/發/白…）→ 词的映射由 tools/test/mahjong-logic.js 单测覆盖。 */',
    '  var names = ' + JSON.stringify(seatSets[0]) + ';',
    '  for (var s = 0; s < 4; s++) {',
    '    for (var i = 0; i < names.length; i++) {',
    '      var u = d.voiceUrl(names[i], s); out.total++;',
    '      if (!u) { out.bad.push("空URL seat" + s + "/" + names[i]); continue; }',
    '      try { var r = await fetch(u, { method: "HEAD" });',
    '        if (r.status === 200) out.words++; else out.bad.push(r.status + " seat" + s + "/" + names[i]); }',
    '      catch (e) { out.bad.push("ERR seat" + s + "/" + names[i]); }',
    '    }',
    '  }',
    '  out.stats = d.voiceStats ? d.voiceStats() : null;',
    '  return JSON.stringify(out);',
    '})()'
  ].join("\n"));
  let vr = {};
  try { vr = JSON.parse(vres); } catch (e) { vr = { err: String(vres) }; }
  if (vr.err) {
    A(false, "Mahjong.debug.voiceUrl 可用", vr.err);
  } else {
    A(vr.bad.length === 0, "四个座位所有牌名 URL 均可取到",
      `${vr.words}/${vr.total}` + (vr.bad.length ? " 坏:" + vr.bad.slice(0, 6).join(" | ") : ""));
    A(vr.stats && vr.stats.total === seatSets[0].length,
      "voiceStats().total 与素材文件数一致",
      vr.stats ? vr.stats.total + " vs " + seatSets[0].length : "无 stats");
    A(vr.stats && !vr.stats.fallbacks, "没有发生座位→共用目录回落（回落=该座位缺文件）",
      vr.stats ? String(vr.stats.fallbacks || 0) : "无");
  }

  /* ── 5. 实际能播（403/404 之外，还要排除「取到了但解码失败」）── */
  const play = await ev([
    '(async function(){',
    '  function tryPlay(url){ return new Promise(function(res){',
    '    var a = new Audio(url); var done = false; a.volume = 0;',
    '    a.addEventListener("error", function(){ if(!done){done=true; res("ERROR " + url);} });',
    '    a.addEventListener("canplaythrough", function(){ if(!done){done=true; res("OK " + a.duration.toFixed(2));} });',
    '    setTimeout(function(){ if(!done){done=true; res("TIMEOUT " + url);} }, 8000);',
    '    a.play().catch(function(){});',
    '  }); }',
    '  var out = [];',
    '  out.push(await tryPlay("audio/sfx/sfx-mj-clack.mp3"));',
    '  out.push(await tryPlay("audio/amb/amb-office.mp3"));',
    '  out.push(await tryPlay("audio/bgm/" + ' + JSON.stringify(MOODS[0]) + ' + ".mp3"));',
    '  out.push(await tryPlay("audio/bgm/" + ' + JSON.stringify(MOODS[MOODS.length - 1]) + ' + ".mp3"));',
    '  return out.join(" | ");',
    '})()'
  ].join("\n"));
  const playBad = String(play).split("|").map(s => s.trim()).filter(s => s && !s.startsWith("OK"));
  A(playBad.length === 0, "音效/环境音/BGM 抽样可实际播放", playBad.length ? playBad.join(" | ") : String(play));

  /* ── 收尾 ── */
  console.log("── 素材接线核对 ──");
  checks.forEach(c => console.log("  ✔ " + c));
  errors.forEach(e => console.log("  ✗ " + e));
  console.log(`[结果] 通过 ${checks.length}，失败 ${errors.length}` +
    (errors.length ? " | " + errors.join(" | ") : ""));

  try {
    const f = resultsFile("audio-wiring-results.json");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({
      success: errors.length === 0, checks, errors,
      counts: { sfx: names.sfx.length, amb: names.amb.length, bgm: names.bgm.length, mj: seatSets[0].length },
    }, null, 1), "utf8");
  } catch (e) { }

  try { chrome.kill(); } catch (e) { }
  process.exit(errors.length ? 1 : 0);
})();
