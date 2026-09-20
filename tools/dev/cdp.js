/* ═══════════════════════════════════════════════════════════════════════════
   tools/dev/cdp.js — 极简 Chrome DevTools Protocol 客户端（零依赖）

   为什么有这个：验收"页面上常驻可见的版本戳"需要**真浏览器**证据 ——
   光看 HTML 源码里有没有那段 div 不算数，要看到它真的渲染出来、且位置/层级
   符合要求。项目里只有 bf/headless.js 那种"最小 DOM 替身"，没有真浏览器驱动，
   所以这里手写一个：只用 Node 内置的 http + net，不装 puppeteer。

   用法（先自己起一个带 --remote-debugging-port 的 Chrome）：
     node tools/dev/cdp.js <port> eval "<js 表达式>"        → 打印求值结果(JSON)
     node tools/dev/cdp.js <port> shot <输出png> [宽] [高]   → 截图
     node tools/dev/cdp.js <port> nav <url>                → 打开页面并等 load
   例：
     node tools/dev/cdp.js 9333 eval "document.title"
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");

const PORT = Number(process.argv[2] || 9333);
const CMD = process.argv[3];

function httpJson(path) {
  return new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: path, method: "GET" }, (r) => {
      let b = "";
      r.setEncoding("utf8");
      r.on("data", (d) => (b += d));
      r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error("非 JSON：" + b.slice(0, 200))); } });
    });
    req.on("error", rej);
    req.end();
  });
}

/* ── 极简 WebSocket 客户端（只做 client→server 掩码帧 + 收文本帧）───────── */
class WS {
  constructor(url) {
    const u = new URL(url);
    this.sock = net.connect(Number(u.port), u.hostname);
    this.buf = Buffer.alloc(0);
    this.waiters = new Map();
    this.id = 0;
    this.onText = null;
    this.ready = new Promise((res, rej) => {
      const key = crypto.randomBytes(16).toString("base64");
      this.sock.on("connect", () => {
        this.sock.write(
          "GET " + u.pathname + (u.search || "") + " HTTP/1.1\r\n" +
          "Host: " + u.host + "\r\n" +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n" +
          "Origin: http://127.0.0.1\r\n\r\n"
        );
      });
      this.sock.on("error", rej);
      this._onHandshake = () => res();
    });
    this.sock.on("data", (d) => this._feed(d));
  }
  _feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this._onHandshake) {
      const i = this.buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      const head = this.buf.slice(0, i).toString();
      if (!/101/.test(head)) throw new Error("WebSocket 握手失败：" + head.split("\r\n")[0]);
      this.buf = this.buf.slice(i + 4);
      const f = this._onHandshake; this._onHandshake = null; f();
    }
    for (;;) {
      const fr = this._frame();
      if (!fr) return;
      if (fr.op === 1) {
        const txt = fr.payload.toString("utf8");
        let msg; try { msg = JSON.parse(txt); } catch (e) { continue; }
        if (msg.id && this.waiters.has(msg.id)) {
          const w = this.waiters.get(msg.id); this.waiters.delete(msg.id); w(msg);
        } else if (this.onText) this.onText(msg);
      } else if (fr.op === 8) { this.sock.end(); }
    }
  }
  _frame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (masked) off += 4;
    if (b.length < off + len) return null;
    const payload = b.slice(off, off + len);
    this.buf = b.slice(off + len);
    return { op: op, payload: payload };
  }
  send(method, params) {
    const id = ++this.id;
    const data = Buffer.from(JSON.stringify({ id: id, method: method, params: params || {} }), "utf8");
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
    else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiters.delete(id); rej(new Error("CDP 超时：" + method)); }, 30000);
      this.waiters.set(id, (m) => { clearTimeout(t); res(m); });
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* 等 Chrome 的调试端口起来（最多 20 秒）*/
  let ver = null;
  for (let i = 0; i < 100; i++) {
    try { ver = await httpJson("/json/version"); break; } catch (e) { await sleep(200); }
  }
  if (!ver) { console.error("✗ 连不上 127.0.0.1:" + PORT + " 的调试端口（Chrome 起了吗？）"); process.exit(2); }

  /* 找到页面 target（没有就新建一个）*/
  let list = await httpJson("/json/list");
  let page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) {
    await httpJson("/json/new?about:blank");
    list = await httpJson("/json/list");
    page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  }
  if (!page) { console.error("✗ 没有可用的 page target"); process.exit(2); }

  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.ready;
  await ws.send("Runtime.enable");
  await ws.send("Page.enable");

  if (CMD === "eval") {
    /* 表达式可以写成 <file>.js 从文件读 —— 免去 PowerShell 反复吃掉引号的麻烦 */
    const arg = process.argv[4] || "";
    const expr = /\.js$/i.test(arg) && fs.existsSync(arg) ? fs.readFileSync(arg, "utf8") : arg;
    const r = await ws.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true, awaitPromise: true,
    });
    if (r.result && r.result.exceptionDetails) { console.error("✗ 求值异常：" + JSON.stringify(r.result.exceptionDetails)); process.exit(1); }
    console.log(JSON.stringify(r.result && r.result.result ? r.result.result.value : null));
  } else if (CMD === "nav") {
    await ws.send("Page.navigate", { url: process.argv[4] });
    await sleep(500);
    /* 等 document.readyState 到 complete */
    for (let i = 0; i < 100; i++) {
      const r = await ws.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (r.result && r.result.result && r.result.result.value === "complete") break;
      await sleep(200);
    }
    console.log("navigated: " + process.argv[4]);
  } else if (CMD === "shot") {
    const file = process.argv[4];
    const r = await ws.send("Page.captureScreenshot", { format: "png" });
    const b64 = r.result && r.result.data;
    if (!b64) { console.error("✗ 截图失败：" + JSON.stringify(r).slice(0, 300)); process.exit(1); }
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
    console.log("shot → " + file + "（" + fs.statSync(file).size + " 字节）");
  } else {
    console.error("未知子命令：" + CMD + "（可用：eval / nav / shot）");
    process.exit(2);
  }
  ws.sock.end();
  process.exit(0);
})().catch((e) => { console.error("✗ " + (e && e.stack || e)); process.exit(1); });
