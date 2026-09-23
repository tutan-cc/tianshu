/* 一次性：无头验证 sfx-preview.html —— 结构、零错误、每个音效都能合成。 */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9350;
const URL = "file:///C:/Users/chris/Desktop/%E9%87%8D%E7%94%9F2-%E5%8E%9F%E5%9E%8B/sfx-preview.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(JSON.parse(d))); }).on("error", rej);
});
(async () => {
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + path.join(process.env.TEMP, "sfx-chk"),
    "--window-size=1280,900", URL], { stdio: "ignore" });
  let t = null;
  for (let i = 0; i < 40; i++) { try { t = await getJson("http://127.0.0.1:" + PORT + "/json/list"); break; } catch (e) { await sleep(250); } }
  const page = t.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
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
  await sleep(1200);

  console.log("音效条目数 = " + await ev("document.querySelectorAll('.item').length"));
  console.log("分组标题   = " + await ev("document.querySelectorAll('.grp').length") + " 组");
  /* 逐个点"试听"：把每个音效都真的合成一遍，看有没有抛错 */
  const n = await ev("document.querySelectorAll('.item button').length");
  for (let i = 0; i < n; i++) {
    await ev("document.querySelectorAll('.item button')[" + i + "].click()");
    await sleep(150);
  }
  console.log("已逐个试听 " + n + " 个音效");
  console.log("音效上下文状态 = " + await ev("(window.__acState || 'n/a')"));
  console.log("JS 运行时错误 = " + (errs.length ? "\n  " + errs.slice(0, 5).join("\n  ") : "无 ✔"));
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot.result && shot.result.data) {
    require("fs").writeFileSync(path.join(__dirname, "..", "..", "_sfx-preview.png"), Buffer.from(shot.result.data, "base64"));
    console.log("已导出 _sfx-preview.png");
  }
  ws.close(); chrome.kill();
  await sleep(200);
  process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.log("脚本异常: " + e.message); process.exit(1); });
