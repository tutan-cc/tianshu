/*
  cardfight-shot.js —— 用 Chrome DevTools Protocol 驱动无头 Chrome，
  自动点「开始对决」并把每个阶段截图存下来。

  为什么不用浏览器扩展那套：扩展需要关闭用户所有 Chrome 窗口才能连上 relay，
  代价太大。CDP 是内置的（Node 22+ 有全局 WebSocket），零依赖、不碰用户浏览器配置。

  用法：node tools/dev/cardfight-shot.js
  产物：_shots/01-opening.png … 05-resolved.png
*/
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT = path.join(__dirname, "..", "..", "_shots");
const PORT = 9333;
const GAME = "file:///C:/Users/chris/Desktop/%E9%87%8D%E7%94%9F2-%E5%8E%9F%E5%9E%8B/cardfight.html";

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

(async () => {
  const prof = path.join(process.env.TEMP, "cf-cdp-prof");
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + prof,
    "--window-size=1280,860",
    GAME,
  ], { stdio: "ignore" });

  /* 等 DevTools 起来 */
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await getJson("http://127.0.0.1:" + PORT + "/json/list"); break; }
    catch (e) { await sleep(250); }
  }
  if (!targets) { console.log("拿不到 DevTools 目标，Chrome 没起来"); chrome.kill(); process.exit(1); }
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) { console.log("没找到 page 目标"); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") {
      errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push(m.params.args.map((a) => a.value).join(" "));
    }
  };
  const send = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, "base64"));
      console.log("  截图 " + name);
    } else console.log("  ✖ 截图失败 " + name);
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await sleep(1400);

  console.log("阶段 1：开场");
  await shot("01-opening.png");

  console.log("阶段 2：点开始 → 中央 12 张卡背 + 人物战场");
  await evaluate('document.getElementById("goBtn").click()');
  await sleep(2200);
  await shot("02-deck.png");
  console.log("    中央卡背数量 = " + await evaluate('document.querySelectorAll("#deck .card").length'));
  /* 立绘是否真的加载出来了（加载失败会退回剪影，页面不会崩，所以要主动查） */
  const sprites = await evaluate(`JSON.stringify(Object.keys(Stage.img).map(k => [k, !!(Stage.img[k].complete && Stage.img[k].naturalWidth)]))`);
  const arr = JSON.parse(sprites || "[]");
  const okCount = arr.filter((a) => a[1]).length;
  console.log("    立绘加载 = " + okCount + "/" + arr.length + (okCount === arr.length ? " ✔" : " ✘ 缺失：" + JSON.stringify(arr.filter((a) => !a[1]).map((a) => a[0]))));
  console.log("    战场画布 = " + await evaluate('(function(){var c=document.getElementById("arena");return c.width+"x"+c.height})()'));

  console.log("阶段 3：自己抽 3 张（点牌堆卡背）→ 飞入 + 翻面");
  /* 按**真实屏幕坐标**挑左上角最靠前的那张卡背来点。
     ⚠ 不要用 `#deck .card:nth-child(n)`：网格是 grid-auto-flow，
       抽走一张之后其余会重排，"第 n 个"与"第 n 格"不是一回事。 */
  const tapBack = `(function(){
    var s = document.getElementById("stage").getBoundingClientRect();
    var k = s.width / 1280;
    var list = [].slice.call(document.querySelectorAll("#deck .card.pickable"));
    list.sort(function(a,b){
      var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
      return (ra.top-rb.top) || (ra.left-rb.left);
    });
    var el = list[0];
    if (!el) return "none";
    var r = el.getBoundingClientRect();
    var opt = {bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2};
    el.dispatchEvent(new MouseEvent("click", opt));
    return Math.round(r.left) + "," + Math.round(r.top);
  })()`;
  for (let i = 0; i < 3; i++) {
    const at = await evaluate(tapBack);
    const left = await evaluate('document.getElementById("deckPile").textContent');
    console.log("    抽第 " + (i + 1) + " 张 → 点的位置 " + at + " · 提示「" + left + "」");
    await sleep(900);
    if (i === 0) await shot("03a-flying.png");
  }
  await sleep(900);
  await shot("03-hand.png");
  const st3 = await evaluate(`JSON.stringify({
    slots: document.querySelectorAll("#slots .card").length,
    faceUp: document.querySelectorAll("#slots .card.flipped").length,
    deckLeft: document.querySelectorAll("#deck .card").length,
    round: document.getElementById("roundTxt").textContent,
    callout: document.getElementById("callout").textContent
  })`);
  console.log("    " + st3);

  console.log("阶段 4：点第一张手牌 → 对手出牌 + 结算");
  await evaluate('document.querySelector("#slots .card").click()');
  await sleep(2600);
  await shot("04-foe.png");
  console.log("    对手牌 = " + await evaluate('document.querySelectorAll("#foeCard .card").length'));

  /* 单独验证"打斗动作"：直接触发一次出招/挨打，抓姿势切换那一瞬间。
     只看静态截图分不清"在打"还是"站着"，所以还要读姿势与位移。 */
  console.log("阶段 4.5：动作验证（出招姿势 + 前冲位移 + 挨打后仰）");
  await evaluate('Stage.attack("player"); Stage.attack("enemy")');
  await sleep(150);
  const poseInfo = await evaluate('JSON.stringify({p:Stage.F.player.pose, e:Stage.F.enemy.pose, pf:Math.round(Stage.F.player.fwd), ef:Math.round(Stage.F.enemy.fwd)})');
  console.log("    出招瞬间 = " + poseInfo);
  await shot("04a-strike.png");
  await evaluate('Stage.hurt("enemy", true)');
  await sleep(120);
  const hurtInfo = await evaluate('JSON.stringify({e:Stage.F.enemy.pose, ef:Math.round(Stage.F.enemy.fwd), fx:Stage.fx.length, shake:Math.round(Stage.shake)})');
  console.log("    挨打瞬间 = " + hurtInfo + "（fx>0 表示有火花粒子）");
  await shot("04b-hurt.png");

  console.log("阶段 5：结算完（等飘字与血条动画）");
  await sleep(4200);
  await shot("05-resolved.png");
  const st5 = await evaluate(`JSON.stringify({
    pHp: document.getElementById("pHpTxt").textContent,
    eHp: document.getElementById("eHpTxt").textContent,
    pSh: document.getElementById("pShTxt").textContent,
    round: document.getElementById("roundTxt").textContent,
    log: (document.getElementById("rLog").textContent || "").slice(0, 0),
    handAgain: document.querySelectorAll("#slots .card").length
  })`);
  console.log("    " + st5);

  /* ── 把整局打完：验证 5 轮上限、血量归零、结果面板 ──
     只跑到第 2 轮不足以证明"一局能结束"（可能在第 4 轮某处卡住不动）。
     每轮点第一张手牌，然后等"轮次文字变化"或"结果面板出现"，最多等 12 秒。 */
  console.log("阶段 6：打完整局（5 轮 × 每轮 3 次交锋 = 15 次），验证结果面板");
  /* ⚠ 两处与旧流程不同，都是规则改动带来的：
       · 抽牌是**放回式**：每轮中央都是完整 12 张，不存在抽空；
       · 一轮要打 **3 次**（抽 3 张 = 3 次 PK），所以每次交锋点一张
         **还没用过**的牌（用完的会被摘掉 .pickable，直接选它就行）。 */
  let guard = 0, lastRound = "", stallLog = [];
  while (guard++ < 200) {
    if (await evaluate('document.getElementById("result").classList.contains("on")')) break;
    const probe = await evaluate('JSON.stringify({ph:(window.S?S.phase:"?"),d:(window.S?S.drawn:-1),bout:(window.S?S.bout:-1),slot:document.querySelectorAll("#slots .card").length,pick:document.querySelectorAll("#slots .card.pickable").length,deck:document.querySelectorAll("#deck .card.pickable").length,r:document.getElementById("roundTxt").textContent})');
    const P = JSON.parse(probe);
    if (guard % 20 === 0 || guard > 170) stallLog.push(guard + ":" + probe);
    const need = P.ph === "draw" ? (3 - P.d) : 0;
    if (need > 0) { await evaluate(tapBack); await sleep(1000); continue; }
    if (P.ph === "pick" && P.pick > 0) {
      lastRound = P.r;
      const boutBefore = P.bout;
      const spentBefore = await evaluate('document.querySelectorAll("#slots .card.spent").length');
      await evaluate('(function(){var e=document.querySelectorAll("#slots .card.pickable"); if(e.length) e[0].click();})()');
      /* 等这一**次交锋**结算完。判据用"已用牌数变化 / 交锋号变化 / 进下一轮 / 收局" ——
         ⚠ 不能拿点击**之前**探测到的 bout 去和循环里新读的值比：
           那样条件在点击前就已经成立，会立刻 break 并重复点同一张牌（实测空转 200 次）。 */
      for (let w = 0; w < 36; w++) {
        await sleep(500);
        const st = await evaluate('JSON.stringify({r:document.getElementById("roundTxt").textContent,o:document.getElementById("result").classList.contains("on"),ph:(window.S?S.phase:""),b:(window.S?S.bout:-1),spent:document.querySelectorAll("#slots .card.spent").length})');
        const o = JSON.parse(st);
        if (o.o) break;
        if (o.r !== lastRound) break;                        // 进下一轮
        if (o.ph === "pick" && (o.b !== boutBefore || o.spent !== spentBefore)) break;  // 可打下一次
      }
      continue;
    }
    await sleep(400);
  }
  console.log("    （循环 " + guard + " 次）");
  if (stallLog.length) console.log("    阶段轨迹: " + stallLog.join(" | "));
  const fin = await evaluate(`JSON.stringify({
    over: document.getElementById("result").classList.contains("on"),
    ttl: document.getElementById("rTtl").textContent,
    sub: document.getElementById("rSub").textContent,
    pHp: document.getElementById("rHp").textContent,
    eHp: document.getElementById("rEhp").textContent,
    rounds: document.getElementById("rRounds").textContent,
    logLines: document.querySelectorAll("#rLog div").length,
    poses: Stage.F.player.pose + "/" + Stage.F.enemy.pose
  })`);
  console.log("    " + fin);
  await shot("06-result.png");
  await evaluate('document.getElementById("againBtn").click()');
  await sleep(1000);
  await shot("07-again.png");
  console.log("    再来一局后面板已关闭 = " + await evaluate('!document.getElementById("result").classList.contains("on")'));

  const dbg = await evaluate("JSON.stringify(window.__dbg)");
  console.log("    内部计数 = " + dbg + "（flies 每轮 3 次，5 轮 = 15）");

  console.log("\nJS 运行时错误：" + (errors.length ? "\n  " + errors.slice(0, 6).join("\n  ") : "无 ✔"));
  ws.close();
  chrome.kill();
  await sleep(300);
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log("脚本出错：" + e.message); process.exit(1); });
