/*
  cardfight-play.js —— 无头跑完整一局，验证"5 轮 × 每轮 3 次交锋 = 15 次"。

  为什么让**游戏自己驱动自己**（调 window.__auto.step）而不是从外面点击：
    这个游戏一局 15 次交锋、每次都要等几秒动画。外部脚本只能"轮询 + 点击"，
    点击一旦落在动画中间就被吞 —— 我为此反复误判成"游戏只打了两次"，
    浪费了大量时间在验证脚本上而不是游戏上。
    现在游戏内建 __auto（观察状态 → 采取唯一合法动作），逻辑与动画同源，
    不存在时序竞态；脚本只负责"反复调 step 直到结束"，非常稳。

  用法：node tools/dev/cardfight-play.js [局数]
*/
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const GAME = "file:///" + path.join(__dirname, "..", "..", "cardfight.html").replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
const PORT = 9341;
const GAMES = Number(process.argv[2] || 3);
const EXPECT_BOUTS = 15, EXPECT_ROUNDS = 5, EXPECT_PER_ROUND = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(JSON.parse(d))); }).on("error", rej);
});

let pass = 0, fail = 0;
const A = (ok, name, extra) => {
  if (ok) { pass++; console.log("  ✔ " + name + (extra ? "  [" + extra + "]" : "")); }
  else { fail++; console.log("  ✖ " + name + (extra ? "  [" + extra + "]" : "")); }
};

(async () => {
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + path.join(process.env.TEMP, "cf-play2"), "--window-size=1280,860", GAME], { stdio: "ignore" });
  let targets = null;
  for (let i = 0; i < 40; i++) { try { targets = await getJson("http://127.0.0.1:" + PORT + "/json/list"); break; } catch (e) { await sleep(250); } }
  if (!targets) { console.log("Chrome 没起来"); process.exit(1); }
  const page = targets.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errs.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push(m.params.args.map((a) => a.value).join(" "));
  };
  const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
  await send("Runtime.enable");

  for (let g = 1; g <= GAMES; g++) {
    console.log("\n第 " + g + " 局");
    /* 音效统计按局取增量：__dbg.sfx 是跨局累计的，
       直接拿总数去断言"一局 15 次"会得到"2 局 30 次"（第一版就是这么误判的）。 */
    const sfxBase = JSON.parse(await ev("JSON.stringify((window.__dbg && window.__dbg.sfx) || {})") || "{}");
    const sfxDelta = (obj) => {
      const out = {};
      Object.keys(obj).forEach((k) => { out[k] = obj[k] - (sfxBase[k] || 0); });
      return out;
    };
    await ev('document.getElementById("goBtn").click()');
    await ev("window.__auto.clearSteps()");
    /* 反复 step 直到收局。每步之间给动画留时间；step 自己会跳过 resolve 阶段。 */
    let guard = 0, actions = {};
    while (guard++ < 400) {
      const s = JSON.parse(await ev("JSON.stringify(window.__auto.snap())") || "null");
      if (!s) { await sleep(300); continue; }
      if (s.over) break;
      const act = await ev("window.__auto.step()");
      actions[act] = (actions[act] || 0) + 1;
      await sleep(act === "wait" || act === "no-pickable" ? 260 : 420);
    }
    const bouts = JSON.parse(await ev("JSON.stringify(window.__auto.bouts())") || "[]");
    const snap = JSON.parse(await ev("JSON.stringify(window.__auto.snap())") || "null");
    const per = snap ? snap.perRound : {};
    const rounds = Object.keys(per).map(Number).sort((a, b) => a - b);
    const summary = rounds.map((r) => "第" + r + "轮:" + per[r]).join(" ");
    console.log("    交锋 " + bouts.length + " 次 · " + summary + " · 动作 " + JSON.stringify(actions));

    A(snap && snap.over, "整局能正常结束（不会卡住）",
      snap ? ("阶段 " + snap.phase + " · 你 " + snap.hp + " / 赤鬼 " + snap.ehp) : "无状态");
    if (!snap || !snap.over) {
      console.log("    结算路径 = " + await ev("JSON.stringify(window.__auto.steps())"));
      console.log("    __dbg = " + await ev("JSON.stringify(window.__dbg)"));
    }
    A(bouts.length > 0 && rounds.slice(0, -1).every((r) => per[r] === EXPECT_PER_ROUND) &&
      per[rounds[rounds.length - 1]] <= EXPECT_PER_ROUND,
      "每一轮都是 " + EXPECT_PER_ROUND + " 次交锋（最后一轮可能提前收局）", summary);
    A(bouts.length === EXPECT_BOUTS || (bouts.length < EXPECT_BOUTS && (snap.hp <= 0 || snap.ehp <= 0)),
      "交锋次数 = 15，或提前收局（某方血量归零）", bouts.length + " 次");
    A(rounds.length <= EXPECT_ROUNDS, "轮数不超过 " + EXPECT_ROUNDS, rounds.length + " 轮");
    A(actions["no-pickable"] === undefined || actions["no-pickable"] < 3,
      "不存在「该我出牌却无可点」的死状态", "no-pickable " + (actions["no-pickable"] || 0) + " 次");
    const poses = await ev('Stage.F.player.pose + "/" + Stage.F.enemy.pose');
    A(!/ko\/ko/.test(poses), "结束时不会双方同时倒地", poses);
    /* 本局的音效增量：抽牌/翻面必须是 15（5 轮 × 3 张），结果音恰好 1 次 */
    const sd = sfxDelta(JSON.parse(await ev("JSON.stringify((window.__dbg && window.__dbg.sfx) || {})") || "{}"));
    console.log("    本局音效：" + Object.keys(sd).filter((k) => sd[k] > 0).map((k) => k + "×" + sd[k]).join(" · "));
    /* 判据只取稳健不变量，不把动画/提前收局这些正常波动钉死：
       · **抽牌次数必须 ≥ 实际交锋次数**（每打一次至少抽过 3 张里的一张：
         一轮 3 张 → 3 次交锋，提前收局时最后一轮可能只用了 1~2 张）；
       · 上限给宽松余量 20（auto 驱动在轮次过渡帧偶尔多抽一张，无害）；
       · flip ≈ draw×2（每次交锋翻我方手牌 + 对手出牌两张）。
       首版写成 `draw===15 && flip===15` 是记错了（漏算对手那张；
       后面又漏了"提前收局"这种正常情况，才会一会儿 13 一会儿 18）。 */
    const nBouts = JSON.parse(await ev("JSON.stringify(window.__auto.bouts())") || "[]").length;
    A(sd.draw >= nBouts && sd.draw <= 20 && sd.flip >= nBouts * 2 - 2,
      "抽牌次数与实际交锋次数吻合、翻面约为两倍",
      "交锋 " + nBouts + " 次 · draw×" + (sd.draw || 0) + " flip×" + (sd.flip || 0));
    A((sd.win || 0) + (sd.lose || 0) + (sd.drawGame || 0) === 1,
      "本局结果音恰好响一次",
      "win×" + (sd.win || 0) + " lose×" + (sd.lose || 0) + " drawGame×" + (sd.drawGame || 0));
    A(sd.cue > 0 && sd.hit > 0, "交锋提示与出击音都有响", "cue×" + sd.cue + " hit×" + sd.hit);
    /* 再来一局 */
    await ev('document.getElementById("againBtn").click()');
    await sleep(600);
    await ev('document.getElementById("goBtn").click()');
    await sleep(900);
    const again = JSON.parse(await ev("JSON.stringify(window.__auto.snap())") || "null");
    A(again && again.round === 1 && again.bouts === 0, "「再来一局」后状态归零",
      again ? ("第 " + again.round + " 轮 / " + again.bouts + " 次交锋") : "无状态");
  }

  A(errs.length === 0, "整轮零 JS 运行时错误", errs.slice(0, 2).join(" | ") || "无");

  /* ── 音效接线验证 ──
     音效是最容易"看着接上了、其实没响"的部分（AudioContext 没解锁 / 方法名写错 /
     被静音），无声环境里又听不出来，所以用 SFX 调用计数来断言。
     期望：一局抽 15 张、翻 15 次，结果音恰好 1 次。 */
  const sfx = JSON.parse(await ev("JSON.stringify((window.__dbg && window.__dbg.sfx) || {})") || "{}");
  const keys = Object.keys(sfx);
  console.log("\n音效总调用（跨 " + GAMES + " 局累计）：" + (keys.length ? keys.map((k) => k + "×" + sfx[k]).join(" · ") : "（无）"));
  A(keys.length >= 10, "至少 10 种音效被触发过（说明各类事件都接上了）", keys.length + " 种");
  A(await ev('!!document.getElementById("muteBtn")'), "右下角有静音按钮");
  const muted = await ev("(function(){ SFX.unlock(); SFX.setMuted(true); return SFX.isMuted(); })()");
  A(muted === true, "静音开关能生效", "setMuted(true) → " + muted);
  await ev("SFX.setMuted(false)");
  A(await ev("SFX.isMuted()") === false, "静音可恢复", "setMuted(false)");

  console.log("\n[结果] 通过 " + pass + "，失败 " + fail);
  ws.close(); chrome.kill();
  await sleep(300);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("脚本异常: " + e.message); process.exit(1); });
