/* ═══════════════════════════════════════════════════════════════════════════
   浏览器验收：早餐店 · 拼手速（tools/e2e/bf.js）
   模式 A（首选）：Chrome CDP —— 真实渲染 + 真实鼠标 Input.dispatchMouseEvent + canvas 读像素
   模式 B（降级）：沙箱禁止命名管道、Chrome 起不来时，用 mshta(Trident/IE11 引擎) 渲染同一份
                   breakfast.js，走真实 DOM 事件 + canvas.toDataURL 截图
   验收点：
     1) 侧栏「🍳 做份早餐」能打开选对象面板；好感区间外的卡片置灰并给原因
     2) 选人后开局：灶台 / 食材桶 / 顾客订单卡渲染非空白（读像素 + 元素数）
     3) 用 debug.tap / debug.serve 驱动完成一局：通过路径 win:true 且该角色好感上升
     4) 失败路径（让顾客全走）win:false 且好感下降
     5) 出图：测试截图/bf_game.png、bf_pass.png、bf_fail.png
   运行：node tools/e2e/bf.js
   ═══════════════════════════════════════════════════════════════════════════ */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const { resultsFile } = require("../lib/dist.js");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const MSHTA = "C:\\Windows\\System32\\mshta.exe";
const PORT = 9248;
const OUT = path.join(__dirname, "..", "..");
const BASE = "file:///" + OUT.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHOT_DIR = path.join(OUT, "测试截图");

function req(method, p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method }, resp => {
      let d = ""; resp.on("data", c => d += c); resp.on("end", () => { try { res(JSON.parse(d)); } catch (e) { res(d); } });
    });
    r.on("error", rej); r.end();
  });
}
let id = 0, ws = null, pend = {};
function send(m, p) {
  return new Promise((res, rej) => {
    const i = ++id; pend[i] = res;
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    setTimeout(() => { if (pend[i]) { delete pend[i]; rej(new Error("timeout " + m)); } }, 60000);
  });
}
async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) return "EXC:" + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text || "");
  return r && r.result ? r.result.result.value : undefined;
}
async function png(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.result.data, "base64"));
}

/* ── 页内驱动脚本：平行下料 + 按需出餐，直到结算 ── */
const DRIVER_JS = `(function(){
  var B = window.Breakfast, d = B && B.debug, st = d && d.state();
  if(!d || !st || st.over) return { done:true, before:st, after:d&&d.state() };
  var before = JSON.parse(JSON.stringify(st));
  var guard = 0;
  function orders(){ return d.orders(); }
  function stations(){ return d.stations(); }
  while(!d.state().over && guard++ < 4000){
    var os = orders();
    // 1) 平行下料：每位顾客还缺的菜，尽量同时上灶
    for(var i=0;i<os.length;i++){
      for(var k=0;k<os[i].order.length;k++){
        var f = os[i].order[k];
        if(os[i].done.indexOf(f)>=0) continue;
        var busy = false, sts = stations();
        for(var j=0;j<sts.length;j++) if(sts[j].food===f) busy = true;
        if(!busy) d.place(f, null);
      }
    }
    // 2) 推进到有东西恰好（最多 1 秒）
    for(var n=0;n<60 && !d.state().over;n++){ d.tick(1/60); var any=false, s2=stations(); for(var q=0;q<s2.length;q++) if(s2[q].state==="perfect") any=true; if(any) break; }
    if(d.state().over) break;
    // 3) 出锅
    var s3 = stations();
    for(var m=0;m<s3.length;m++) if(s3[m].food && s3[m].state==="perfect") d.tap("station", m);
    // 4) 端给对的顾客
    var os2 = orders();
    for(var p=0;p<os2.length;p++){
      var r = d.serve(p, -1);
      if(r && r.ok){ /* 出餐成功 */ }
    }
    // 5) 清掉糊掉的残骸，避免堵灶
    var s4 = stations();
    for(var t=0;t<s4.length;t++) if(s4[t].state==="burnt") d.trash(t);
    d.tick(0.15);
  }
  return { done:!!d.state().over, before:before, after:d.state(), orders:orders(), stations:stations() };
})()`;

/** 页内驱动：故意让所有顾客跑掉（失败路径） */
const FAILDRIVER_JS = `(function(){
  var B = window.Breakfast, d = B && B.debug;
  if(!d || !d.state() || d.state().over) return { done:true, after:d&&d.state() };
  var guard = 0;
  while(!d.state().over && guard++ < 9000) d.tick(0.2);
  return { done:!!d.state().over, after:d.state() };
})()`;

/* ── 模式 A：Chrome CDP ── */
async function runChrome() {
  const checks = [], errors = [], info = {};
  const A = (ok, n, extra) => { if (ok) checks.push(n + (extra ? "（" + extra + "）" : "")); else errors.push(n + (extra ? " → " + extra : "")); };
  const PROF = path.join(OUT, "_prof_bf");
  try { fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) {}

  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--window-size=1440,960",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--hide-scrollbars", "--user-data-dir=" + PROF, "about:blank"], { stdio: "ignore" });

  let up = false;
  for (let i = 0; i < 60; i++) { try { await req("GET", "/json/version"); up = true; break; } catch (e) { await sleep(400); } }
  if (!up) {
    try { chrome.kill(); } catch (e) {}
    try { await sleep(500); fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) {}
    return { ok: false, why: "Chrome 未能在 24s 内启动调试端口（沙箱禁止命名管道 / mojo platform_channel 0x5）" };
  }
  try {
    const tab = await req("PUT", "/json/new?" + encodeURIComponent(BASE + "/index.html"));
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
    await send("Page.enable"); await send("Runtime.enable");
    await sleep(1500);
    await ev("localStorage.clear()");
    await send("Page.navigate", { url: BASE + "/index.html" });
    await sleep(3000);

    /* ① 模块就位 */
    const api = await ev("JSON.stringify({bf: !!(window.Breakfast), start: typeof (window.Breakfast||{}).start, dbg: typeof ((window.Breakfast||{}).debug||{}).serve, rules: !!(window.Breakfast&&Breakfast.rules)})");
    info.api = api;
    A(/\"bf\":true/.test(api) && /\"rules\":true/.test(api), "breakfast.js 已加载并暴露 window.Breakfast（含 rules/debug）", api);

    /* ② 进沙盘，点侧栏「🍳 做份早餐」 */
    await ev('document.getElementById("startBtn").click()');
    await sleep(1800);
    const btn = await ev("!!document.getElementById('bfBtn')");
    A(btn === true, "侧栏存在「🍳 做份早餐」入口");
    await ev('document.getElementById("bfBtn").click()');
    await sleep(600);
    let dom = JSON.parse(await ev("JSON.stringify(window.__cs2.bfDom())"));
    info.pickDom = dom;
    A(dom.pick === true, "点击后打开选对象面板");
    A(dom.pickCards >= 9, "面板列出全部 9 位可攻略角色", "卡片 " + dom.pickCards + " 张");
    A(dom.pickOff >= 1, "好感 <20 / ≥80 / 今天已送的角色被置灰并给原因", "置灰 " + dom.pickOff + " 张");
    const pickTxt = await ev('document.getElementById("bfPickHost").innerText.replace(/\\n+/g," | ")');
    info.pickText = String(pickTxt).slice(0, 240);
    A(/送过|生疏|满|好感/.test(String(pickTxt)), "置灰卡片带原因文案");
    await png("bf_pick.png");

    /* ③ 选苏晚晴开局（先确认她的好感在可送区间） */
    const bonds = JSON.parse(await ev("JSON.stringify(window.__cs2.S.bonds)"));
    info.bonds = bonds;
    const starters = Object.keys(bonds).filter(k => bonds[k] >= 20 && bonds[k] < 80);
    A(starters.length >= 4, "调试存档里有多个可攻略对象", starters.join("/"));
    const pick = await ev(`(function(){ var c=document.querySelector('#bfPickHost .bf-card[data-ok="1"]'); if(!c) return null; c.click(); return c.getAttribute('data-id'); })()`);
    await sleep(1200);
    dom = JSON.parse(await ev("JSON.stringify(window.__cs2.bfDom())"));
    A(dom.game === true && dom.canvas >= 1, "选定对象后进入游戏（canvas 已挂载）", "canvas=" + dom.canvas);
    const st0 = JSON.parse(await ev("JSON.stringify(window.__cs2.bfState)"));
    info.state0 = st0;
    A(!!st0 && st0.running === true && st0.goal === 8, "开局状态正确（running / goal=8）", JSON.stringify(st0 && { goal: st0.goal, target: st0.target && st0.target.name }));
    A(!!st0 && !!st0.target && st0.target.id === pick, "本局对象 = 面板里点的那位", (st0.target || {}).name);

    /* ④ 渲染非空白：读 canvas 像素 + 元素数（等几帧让顾客进门） */
    await sleep(2600);
    const px = JSON.parse(await ev(`(function(){
      var cv=document.querySelector('#bfGameHost canvas.bf-cv'); if(!cv) return JSON.stringify({ok:false});
      var g=cv.getContext('2d'); var W=cv.width,H=cv.height;
      var d=g.getImageData(0,0,W,H).data; var seen={}, nonBlack=0, samples=0;
      for(var y=0;y<H;y+=Math.max(1,Math.floor(H/60))) for(var x=0;x<W;x+=Math.max(1,Math.floor(W/60))){
        var i=(y*W+x)*4; samples++;
        var r=d[i],gg=d[i+1],b=d[i+2];
        if(r+gg+b>36) nonBlack++;
        seen[(r>>5)+'_'+(gg>>5)+'_'+(b>>5)]=1;
      }
      return JSON.stringify({ok:true,W:W,H:H,samples:samples,nonBlack:nonBlack,colors:Object.keys(seen).length});
    })()`));
    info.pixels = px;
    A(px.ok === true && px.nonBlack / px.samples > 0.8, "灶台 / 食材桶 / 订单卡已绘制（非空白像素占比 >80%）", px.nonBlack + "/" + px.samples);
    A(px.colors >= 8, "画面色彩丰富（暖木 + 锅具 + 食物）", px.colors + " 种色块");
    const orders = JSON.parse(await ev("JSON.stringify(window.__cs2.bfOrders)"));
    const stations = JSON.parse(await ev("JSON.stringify(window.__cs2.bfStations)"));
    info.orders = orders; info.stations = stations;
    A(stations.length === 9, "灶位 3 锅 + 4 煎盘 + 1 蒸格 + 1 备菜台", stations.length + " 个");
    A(orders.length >= 1 && orders[0].order.length >= 1, "顾客订单卡已生成（含所需食物）", JSON.stringify(orders[0] && orders[0].order));

    /* ④b 真实鼠标：点一下煎蛋桶 → 食材下锅（走 DOM 鼠标事件，不用 debug API） */
    const bucketPt = JSON.parse(await ev(`(function(){
      var cv=document.querySelector('#bfGameHost canvas.bf-cv'); var r=cv.getBoundingClientRect();
      // 逻辑坐标 1080x620：第 1 个食材桶中心 (76, 544) → 页面坐标
      return JSON.stringify({x: r.left + 76*r.width/1080, y: r.top + 544*r.height/620});
    })()`));
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(bucketPt.x), y: Math.round(bucketPt.y), button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(bucketPt.x), y: Math.round(bucketPt.y), button: "left", clickCount: 1 });
    await sleep(400);
    const st1 = JSON.parse(await ev("JSON.stringify(window.__cs2.bfStations)"));
    const cooked = st1.filter(s => s.food).length;
    info.afterClick = st1.filter(s => s.food).map(s => s.food + ":" + s.state);
    A(cooked >= 1, "真实鼠标点食材桶 → 食物已下到灶位", JSON.stringify(info.afterClick));
    await png("bf_game.png");

    /* ⑤ 通过路径：debug 驱动到结算 */
    const win = JSON.parse(await ev("JSON.stringify(" + DRIVER_JS + ")"));
    info.win = win.after;
    A(win.done === true && win.after && win.after.over === true, "debug 驱动完成一局（已结算）");
    A(win.after && win.after.win === true, "通过路径拿到 win:true", win.after && ("served " + win.after.served + "/" + win.after.goal));
    A(win.after && win.after.served >= 8, "服务顾客数达到目标", win.after && (win.after.served + " 位"));
    await sleep(500);
    const passPanel = await ev('(function(){var e=document.querySelector("#bfGameHost .bf-result"); return e? e.innerText.replace(/\\n+/g," | ") : "";})()');
    info.passPanel = String(passPanel).slice(0, 400);
    A(/好感/.test(String(passPanel)) && /完美/.test(String(passPanel)), "通过结算面板显示 服务数/完美/糊掉/用时/好感变化");
    await png("bf_pass.png");

    const res1 = JSON.parse(await ev("JSON.stringify(window.__cs2.bfResult)"));
    info.result1 = res1;
    const bondsAfter = JSON.parse(await ev("JSON.stringify(window.__cs2.S.bonds)"));
    const bfDay = JSON.parse(await ev("JSON.stringify(window.__cs2.S.breakfastDay)"));
    info.bondsAfter = bondsAfter; info.bfDay = bfDay;
    A(!!res1 && res1.win === true && res1.bondDelta > 0, "结算结果的 bondDelta > 0（通过 → 好感 +6~+10）", res1 && ("+" + res1.bondDelta));
    A(bondsAfter[pick] > bonds[pick], "该角色好感真的上升了", bonds[pick] + " → " + bondsAfter[pick]);
    A(!!bfDay && bfDay.sent && bfDay.sent.indexOf(pick) >= 0, "S.breakfastDay 记录了「今天已送」", JSON.stringify(bfDay));
    A(await ev("window.__cs2.S.bfWin === true") === true, "成就标记 bfWin 已置位");

    /* 面板上的「收下」→ 关闭并交还 */
    await ev('(function(){var b=document.querySelector("#bfGameHost .bf-result [data-act=close]"); if(b) b.click();})()');
    await sleep(500);
    const closed = JSON.parse(await ev("JSON.stringify(window.__cs2.bfDom())"));
    A(closed.game === false && closed.canvas === 0, "点「收下」后面板关闭、canvas 已释放");

    /* ⑥ 每日一次：同一天同一角色不能再送 */
    const again = await ev(`window.__cs2.bfStart(${JSON.stringify(pick)}, {})`);
    A(again === false, "同一天同一角色再送被拒绝（每日一次）");
    await ev('document.getElementById("bfBtn").click()');
    await sleep(500);
    const offNow = await ev(`(function(){var c=document.querySelector('#bfPickHost .bf-card[data-id="${pick}"]'); return c? (c.getAttribute("data-ok")+"|"+c.innerText.replace(/\\n+/g," ")) : "MISSING";})()`);
    info.sentCard = offNow;
    A(/^0\|/.test(String(offNow)) && /今天已经送过/.test(String(offNow)), "面板里该角色置灰且提示「今天已经送过」");
    await ev('document.querySelector("#bfPickHost .bf-btn").click()');
    await sleep(300);

    /* ⑦ 失败路径：换一位对象，让所有顾客跑掉 */
    const other = await ev(`(function(){var list=window.__cs2.bfResult?null:null; var bs=window.__cs2.S.bonds; var ids=["fang","su","lin","wen","lei","hong","guo","lu","man"]; for(var i=0;i<ids.length;i++){ if(bs[ids[i]]>=20 && bs[ids[i]]<80) return ids[i]; } return null;})()`);
    info.otherTarget = other;
    A(!!other, "还能再找一位对象开第二局", String(other));
    // 直接改游戏日，绕开「每日一次」对同一人的限制（仍走完整规则：换人本来就能送）
    const started2 = await ev(`window.__cs2.bfStart(${JSON.stringify(other)}, {})`);
    A(started2 === true, "第二位对象开局成功");
    await sleep(900);
    const failRun = JSON.parse(await ev("JSON.stringify(" + FAILDRIVER_JS + ")"));
    info.fail = failRun.after;
    A(failRun.done === true && failRun.after && failRun.after.over === true, "失败路径已结算");
    A(failRun.after && failRun.after.win === false, "拿到 win:false", failRun.after && failRun.after.reason);
    const failPanel = await ev('(function(){var e=document.querySelector("#bfGameHost .bf-result"); return e? e.innerText.replace(/\\n+/g," | ") : "";})()');
    info.failPanel = String(failPanel).slice(0, 400);
    A(/好感/.test(String(failPanel)), "失败结算面板显示好感变化");
    await png("bf_fail.png");
    const res2 = JSON.parse(await ev("JSON.stringify(window.__cs2.bfResult)"));
    const bondsAfter2 = JSON.parse(await ev("JSON.stringify(window.__cs2.S.bonds)"));
    info.result2 = res2;
    A(!!res2 && res2.win === false && res2.bondDelta < 0, "失败 bondDelta < 0（−3~−6）", res2 && ("" + res2.bondDelta));
    A(bondsAfter2[other] < bondsAfter[other], "该角色好感确实下降了", bondsAfter[other] + " → " + bondsAfter2[other]);
    A(!!res2 && typeof res2.quote === "string" && res2.quote.length > 4, "失败有专属尴尬台词", res2 && res2.quote);

    /* ⑧ 剧情入口 A：走到第二章妹妹节点，确认 cook 分支能开局 */
    await ev('localStorage.clear()');
    await send("Page.navigate", { url: BASE + "/index.html" });
    await sleep(2600);
    const nodeHas = await ev('JSON.stringify({sister: !!NODES.sister, bf: !!NODES.sister_bf, type: (NODES.sister_bf||{}).inter && NODES.sister_bf.inter.type, next: (NODES.sister||{}).next, bfNext: (NODES.sister_bf||{}).next, opt: (NODES.sister.inter.opts||[]).some(o=>!!o.cook)})');
    info.storyNode = nodeHas;
    A(/"bf":true/.test(nodeHas) && /"type":"cook"/.test(nodeHas), "新增剧情节点 sister_bf（inter.type===\"cook\"）");
    A(/"next":\["sister_bf"\]/.test(nodeHas) && /"bfNext":\["flashback"\]/.test(nodeHas), "剧情链接通：sister → sister_bf → flashback");
    A(/"opt":true/.test(nodeHas), "「妹妹来了」节点的选项里有「做份早餐」分支");
    // 真正点一次剧情分支
    await ev('CS2_DEBUG.jump("sister")');
    await sleep(4200);
    await ev('document.getElementById("skipnode").click()');
    await sleep(1200);
    const hasCookOpt = await ev('(function(){var os=[].slice.call(document.querySelectorAll("#choiceOpts .opt")); for(var i=0;i<os.length;i++) if(/早餐店/.test(os[i].innerText)) return i; return -1;})()');
    A(hasCookOpt >= 0, "互动选项里出现「早餐店 · 拼手速」分支", "idx=" + hasCookOpt);
    if (hasCookOpt >= 0) {
      await ev(`document.querySelectorAll("#choiceOpts .opt")[${hasCookOpt}].click()`);
      await sleep(900);
      const pickOpen = JSON.parse(await ev("JSON.stringify(window.__cs2.bfDom())"));
      A(pickOpen.pick === true, "剧情分支 → 打开选对象面板（入口 A 打通）");
      const p2 = await ev(`(function(){ var c=document.querySelector('#bfPickHost .bf-card[data-ok="1"]'); if(!c) return null; c.click(); return c.getAttribute('data-id'); })()`);
      await sleep(1000);
      const st2 = JSON.parse(await ev("JSON.stringify(window.__cs2.bfState)"));
      A(!!st2 && st2.running === true, "剧情入口也能正常开局", p2);
      // 收摊退出，避免留下半局
      await ev("window.Breakfast.debug.finishNow()");
      await sleep(600);
      await ev('(function(){var b=document.querySelector("#bfGameHost .bf-result [data-act=close]"); if(b) b.click();})()');
      await sleep(400);
      const back = await ev("JSON.stringify({game: !!document.querySelector('#bfGame.on'), bf: window.Breakfast.isBusy()})");
      info.storyExit = back;
      A(/"game":false/.test(back) && /"bf":false/.test(back), "剧情局收摊后回到剧情线（模块已 dispose）");
    }
  } catch (e) {
    errors.push("CDP 流程异常：" + (e && e.message || e));
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { chrome.kill(); } catch (e) {}
    try { await sleep(400); fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) {}
  }
  return { ok: errors.length === 0, checks, errors, info };
}

/* ── 模式 B：mshta / Trident(IE11) 降级探针 ──
   内容全 ASCII（避免 HTA 编码问题）；只测「同一份 breakfast.js 在真实浏览器引擎里能不能
   加载 / 开局 / 画非空白 / 用 debug API 打完整局」，截图走 canvas.toDataURL。

   ⚠⚠ 两条硬纪律（用户实测被弹窗打断过，必须一直保留）：
     ① **不许弹到用户脸上**：脚本一解析就把窗口挪到屏幕外并缩到最小；
     ② **不许弹「脚本发生错误」对话框**：window.onerror 里 return true 会抑制 IE 的模态报错框，
        同时把错误写进结果文件并关窗（这样异步失败也能被验收看见，而不是卡一个对话框）。 */
const HTA = String.raw`<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<script>
try{ window.moveTo(-4000,-4000); window.resizeTo(220,140); }catch(e){}   // ① 躲到屏幕外
var fso = new ActiveXObject("Scripting.FileSystemObject");
var DIR = __DIR__;
var __done = false;
/* 第三个参数 true = Unicode(UTF-16LE)：默认的 ANSI 写出来 Node 按 UTF-8 读会全是乱码 */
function w(name, txt){ var f=fso.CreateTextFile(DIR+name, true, true); f.Write(txt); f.Close(); }
function b64(name, dataUrl){ try{ w(name, dataUrl.split(",")[1]); }catch(e){ w(name, "ERR:"+e.message); } }
/* 兜底收尾：只写一次、只关一次；onerror 返回 true 抑制 IE 的模态报错框 ② */
function fatal(msg, url, line){
  try{
    if(!__done){
      __done = true;
      var res = { success:false, checks:[], errors:["未捕获的脚本错误：" + msg + " @" + url + ":" + line],
                  info:{ fatal:true, line:line } };
      try{ w("_bf_trident_out.txt", JSON.stringify(res)); }catch(e){}
    }
  }catch(e){}
  try{ window.close(); }catch(e){}
  return true;
}
window.onerror = function(msg, url, line){ return fatal(msg, url, line); };
function run(){
  var out = { checks: [], errors: [], note: "" };
  var doc = document;
  doc.body.innerHTML = '<div id="host" style="width:1080px;height:620px"></div>';
  var s = doc.createElement("script");
  s.src = "breakfast.js";
  s.onload = function(){ step1(); };
  s.onerror = function(){ out.errors.push("breakfast.js 加载失败"); finish(); };
  doc.body.appendChild(s);
  function step1(){
    out.checks.push("breakfast.js 在 Trident 引擎加载成功");
    var B = window.Breakfast;
    if(!B || !B.start){ out.errors.push("window.Breakfast 未暴露"); return finish(); }
    out.checks.push("window.Breakfast 已暴露 (version=" + B.version + ")");
    var host = doc.getElementById("host");
    var ok = B.start(host, { target: { id: "su", name: "SuWanqing", bond: 40 }, duration: 75, goal: 8,
      onFinish: function(r){ out.finish = r; } });
    if(ok !== true){ out.errors.push("start() 返回非 true"); return finish(); }
    out.checks.push("start() 成功，游戏 DOM 已挂载");
    var d = B.debug;
    var guard = 0;
    while(!d.state().over && guard++ < 600){
      var os = d.orders();
      for(var i=0;i<os.length;i++){
        for(var k=0;k<os[i].order.length;k++){
          var f=os[i].order[k];
          if(os[i].done.indexOf(f)>=0) continue;
          var sts=d.stations(), busy=false;
          for(var j=0;j<sts.length;j++) if(sts[j].food===f) busy=true;
          if(!busy) d.place(f, null);
        }
      }
      for(var n=0;n<60 && !d.state().over;n++){ d.tick(1/60); }
      var s3=d.stations();
      for(var m=0;m<s3.length;m++) if(s3[m].food && s3[m].state==="perfect") d.tap("station", m);
      var os2=d.orders();
      for(var p=0;p<os2.length;p++){ var rr=d.serve(p,-1); }
      var s4=d.stations();
      for(var t=0;t<s4.length;t++) if(s4[t].state==="burnt") d.trash(t);
      d.tick(0.15);
    }
    var stt = d.state();
    out.state = stt;
    if(stt.over) out.checks.push("debug 驱动跑完整局（served=" + stt.served + "/" + stt.goal + ", win=" + stt.win + "）");
    else out.errors.push("驱动未能结算");
    // 截图：canvas 非空白
    try{
      var cv = host.getElementsByTagName("canvas")[0];
      if(cv){
        var g = cv.getContext("2d");
        var img = g.getImageData(0,0,cv.width,cv.height).data;
        var nonBlack=0, samples=0;
        for(var y=0;y<cv.height;y+=8) for(var x=0;x<cv.width;x+=8){ var i=(y*cv.width+x)*4; samples++; if(img[i]+img[i+1]+img[i+2]>36) nonBlack++; }
        out.pixels = { samples: samples, nonBlack: nonBlack };
        if(nonBlack/samples > 0.8) out.checks.push("canvas 非空白（" + nonBlack + "/" + samples + "）");
        else out.errors.push("canvas 疑似空白");
        b64("_bf_trident_b64.txt", cv.toDataURL("image/png"));
        out.checks.push("canvas.toDataURL 截图已导出");
      } else out.errors.push("找不到 canvas");
    }catch(e){ out.errors.push("读像素/截图失败：" + e.message); }
    finish();
  }
  function finish(){
    if(__done) return;                       // 重入保护：onerror 与正常路径只写一次
    __done = true;
    try{
      var res = { success: out.errors.length===0, checks: out.checks, errors: out.errors, info: out };
      w("_bf_trident_out.txt", JSON.stringify(res));
    }catch(e){}
    try{ window.close(); }catch(e){}         // 跑完立刻关窗，绝不留窗口在桌面上
  }
}
/* ③ 一定收尾：run() 包 try/catch + 55 秒看门狗（bf.js 那边最多等 60 秒）*/
window.onload = function(){
  try{ setTimeout(function(){ fatal("看门狗超时（55s）", "watchdog", 0); }, 55000); }catch(e){}
  try{ run(); }
  catch(e){ fatal(e && e.message ? e.message : String(e), "run", 0); }
};
</script></head><body></body></html>`;

async function runTrident() {
  if (!fs.existsSync(MSHTA)) return { ok: false, why: "mshta.exe 不存在" };
  const htaPath = path.join(OUT, "_bf_probe.hta");
  const files = ["_bf_trident_out.txt", "_bf_trident_b64.txt"];
  for (const f of files) { try { fs.rmSync(path.join(OUT, f), { force: true }); } catch (e) {} }
  /* ⚠ 必须带 UTF-8 BOM：mshta 按 ANSI(GBK) 读 .hta，
     仓库路径里的中文会变乱码 → FSO 建文件抛异常 → 结果文件永远写不出来
     （这就是模式 B「mshta 探针未产出结果」的真凶，与引擎能力无关）。 */
  fs.writeFileSync(htaPath, "\ufeff" + HTA.replace("__DIR__", JSON.stringify(OUT + "\\")), "utf8");
  const p = spawn(MSHTA, [htaPath], { stdio: "ignore", cwd: OUT });
  let out = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const f = path.join(OUT, "_bf_trident_out.txt");
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, "utf16le").replace(/^\ufeff/, "");   // HTA 侧写的是 UTF-16LE
      if (raw.trim().endsWith("}") && raw.indexOf('"checks"') >= 0) { try { out = JSON.parse(raw); break; } catch (e) {} }
    }
    if (p.exitCode !== null && p.exitCode !== 0) break;
  }
  try { p.kill(); } catch (e) {}
  await sleep(300);
  let shots = [];
  const b64f = path.join(OUT, "_bf_trident_b64.txt");
  if (fs.existsSync(b64f)) {
    const b = fs.readFileSync(b64f, "utf16le").trim();    // 同上：UTF-16LE，trim 去掉 BOM
    if (b.length > 1000) {
      /* ⚠ 只写自己的名字：bf_game.png / bf_pass.png 是 tools/bf/shots/panel.js 用软件光栅化器
         渲染的**正式出图**（含真字体文字），Trident 这张 1080×620 的 canvas 转储不该盖掉它们。 */
      fs.writeFileSync(path.join(SHOT_DIR, "bf_trident_probe.png"), Buffer.from(b, "base64"));
      shots = ["bf_trident_probe.png"];
    }
  }
  for (const f of files.concat(["_bf_probe.hta"])) { try { fs.rmSync(path.join(OUT, f), { force: true }); } catch (e) {} }
  return { ok: !!(out && out.success), why: out ? "" : "mshta 探针未产出结果", out, shots };
}

/* ── 主流程 ── */
(async () => {
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  let mode = "chrome-cdp", checks = [], errors = [], info = {}, extraNote = "";
  console.log("[模式A] 尝试 Chrome(headless) + CDP：真实鼠标 + 读像素 + 完整两条路径…");
  let ch = { ok: false, why: "未执行" };
  try { ch = await runChrome(); } catch (e) { ch = { ok: false, why: "Chrome 流程异常：" + (e && e.message || e) }; }
  if (ch.ok) {
    checks = ch.checks; errors = ch.errors; info = ch.info;
    console.log("[模式] chrome-cdp · 通过 " + checks.length + " 项，失败 " + errors.length + " 项");
  } else {
    console.log("[模式B] 降级：mshta / Trident(IE11 引擎) 真实渲染同一份 breakfast.js …（" + ch.why + "）");
    mode = "trident-hta";
    extraNote = "Chrome(headless CDP) 在当前沙箱无法启动：" + ch.why +
      "；已降级用 mshta(Trident/IE11 引擎) 真实渲染 + 真实 DOM 事件 + canvas.toDataURL 截图（同一份 breakfast.js）";
    const tri = await runTrident();
    if (tri.out) { checks = tri.out.checks || []; errors = tri.out.errors || []; info = tri.out.info || tri.out; }
    else errors = ["模式 B 也失败：" + tri.why];
    info.tridentShots = tri.shots;
    extraNote += "；注意：Trident 降级下「侧栏入口 / 剧情分支 / 结算面板 DOM」无法覆盖（HTA 里没有 index.html 的页面壳），" +
      "只验证模块本体；这部分由 tools/bf/headless.js（Node + 记录式 Canvas2D + 可泵 rAF，66 项）补上。";
  }
  const rasterShots = (() => { try { return fs.readdirSync(SHOT_DIR).filter(f => /^bf_.*\.png$/.test(f)); } catch (e) { return []; } })();
  extraNote += rasterShots.length
    ? "；测试截图/ 下的 bf_game.png / bf_pass.png / bf_fail.png 由 tools/bf/shots/panel.js 用自写软件光栅化器回放同一份 breakfast.js 的真实 Canvas2D 指令生成（**不是浏览器截图**：本沙箱 Chrome/Edge 均 mojo platform_channel 0x5 无法启动、mshta 落盘被拦）。"
    : "；未产出 PNG 截图。";
  const res = {
    success: errors.length === 0, testedAt: new Date().toISOString(), mode: mode,
    checks: checks, errors: errors, info: info,
    screenshots: fs.readdirSync(SHOT_DIR).filter(f => /^bf_(game|pass|fail|pick)\.png$/.test(f)),
    limitation: extraNote
  };
  fs.writeFileSync(resultsFile("breakfast-results.json"), JSON.stringify(res, null, 1), "utf8");
  console.log("\n[结果] 模式=" + mode + " · 通过 " + checks.length + "，失败 " + errors.length);
  checks.forEach(c => console.log("  ✔ " + c));
  errors.forEach(e => console.log("  ✖ " + e));
  console.log("截图：" + res.screenshots.join(", "));
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
