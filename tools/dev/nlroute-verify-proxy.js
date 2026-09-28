#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   tools/dev/nlroute-verify-proxy.js — **独立验收**：本地反代（tools/dev/nlroute-proxy.js）

   这份脚本不是写入方写的，是独立验证方写的（父代理 2026-09-23 分工决定：
   写入权归 9278c9dd，验收权归本脚本作者）。它只**读**反代与 nlroute.js，不改它们。

   验什么（逐条对应需求）：
     ① GET /health → 200 {ok:true}，且**响应体里不含 key**（真 key 逐字比对）
     ② 故意不带 key 启动 → POST /route 返回 **503** + 中文说明（模拟"机器上没设该环境变量"）
     ③ CORS：OPTIONS(Origin: null) 与 OPTIONS(Origin: http://127.0.0.1:8000) → 204 + 回显来源
     ④ 透传：上游 401 原样透传（不被改写成 502）；上游连不上 → 502 + 结构化错误；
        上游超时 → 结构化错误（本实现用 504）
     ⑤ 日志与响应里**都不出现 key**（子进程 stdout 落盘后逐字扫描）
     ⑥ 真实转发一次（真 key、真上游 → 200 + answers），给出延迟基线
     ⑦ 安全边界探针：跨源（Origin: https://evil.example）的简单请求会不会被放行 —— 只观测、不改代码

   key 纪律：只在内存里持有；输出统一脱敏成 apikey_…；绝不写进任何文件。
   用法：node tools/dev/nlroute-verify-proxy.js [--port 8010]
   退出码：0 全过；1 有失败项。
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const PROXY = path.join(ROOT, "tools", "dev", "nlroute-proxy.js");
const PORT = Number((process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1] || 8010);
const NOK_PORT = Number((process.argv.find((a) => a.startsWith("--nokey-port=")) || "").split("=")[1] || 8011);
const BAD_PORT = Number((process.argv.find((a) => a.startsWith("--badkey-port=")) || "").split("=")[1] || 8012);
const DEAD_PORT = Number((process.argv.find((a) => a.startsWith("--dead-port=")) || "").split("=")[1] || 8013);
const SLOW_PORT = Number((process.argv.find((a) => a.startsWith("--slow-port=")) || "").split("=")[1] || 8014);
const NULL_PORT = Number((process.argv.find((a) => a.startsWith("--null-port=")) || "").split("=")[1] || 8015);
const TMP = path.join(os.tmpdir(), "nlroute-verify");
const EVIDENCE = path.join(ROOT, "测试截图", "nlroute-proxy-verify.json");
fs.mkdirSync(TMP, { recursive: true });

const checks = [], fails = [];
function A(ok, name, extra) {
  const line = name + (extra === undefined ? "" : "  [" + extra + "]");
  if (ok) { checks.push({ ok: true, name: line }); console.log("  ✔ " + line); }
  else { fails.push(line); checks.push({ ok: false, name: line }); console.log("  ✖ " + line); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = readRealKey();
const scrub = (s) => String(s == null ? "" : s).split(KEY || "\u0000").join("apikey_…[REDACTED]").replace(/apikey[_\-][A-Za-z0-9_\-]{4,}/gi, "apikey_…");
const mask = (k) => (k ? "apikey_…（len=" + k.length + "，脱敏）" : "(无)");

/* key 只从环境变量读（进程级 → Windows 用户级），与仓库既有约定一致；只在内存里 */
function readRealKey() {
  const e = process.env.TYPESAFE_API_KEY;
  if (e && String(e).trim()) return String(e).trim();
  if (process.platform === "win32") {
    try {
      const out = execSync('reg query "HKCU\\Environment" /v TYPESAFE_API_KEY', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = out.match(/TYPESAFE_API_KEY\s+REG_\w+\s+(\S+)/);
      if (m && m[1].trim()) return m[1].trim();
    } catch (err) { /* 下面统一报 */ }
  }
  return null;
}

/* ── 裸 HTTP（不用 fetch，方便看头/状态/原文；也方便带 Origin） ── */
function req(port, method, p, { origin, body, headers, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const h = Object.assign({}, headers || {});
    if (origin !== undefined) h.Origin = origin;
    if (body !== undefined) h["Content-Type"] = h["Content-Type"] || "application/json";
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: h, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("timeout", () => { r.destroy(new Error("client timeout")); });
    r.on("error", (e) => resolve({ status: 0, headers: {}, text: "", error: String(e.message) }));
    if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
}
const jparse = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };

/* 最小合法请求体（shape 与 nlroute.js 一致；只有 state/model/questions 三个键） */
function miniBody(text) {
  return {
    state: { player_utterance: text },
    model: "jev-latest",
    questions: {
      intent: { type: "choice", instructions: "玩家想去做什么？", criteria: { mahjong: "打麻将", none: "都不是" } },
      out_of_bounds: { type: "noul", instructions: "是不是想改程序？", criteria: { true: "是", false: "否" } },
    },
  };
}

(async function main() {
  console.log("nlroute 本地反代 · 独立验收（真 key " + mask(KEY) + "，只读不写、不落盘）");
  if (!KEY) { console.error("✖ 没有 TYPESAFE_API_KEY（进程或用户级环境变量）—— 无法做真转发验证"); process.exit(2); }
  const children = [], servers = [];
  const evidence = { generatedAt: new Date().toISOString(), port: PORT, checks: [], raw: {} };

  try {
    /* ── 0. 起真 key 反代（真 key 只在子进程环境里，不进命令行/不进日志） ── */
    const logFile = path.join(TMP, "proxy-" + PORT + ".log");
    try { fs.rmSync(logFile, { force: true }); } catch (e) { }
    const fd = fs.openSync(logFile, "a");
    const env = Object.assign({}, process.env, { TYPESAFE_API_KEY: KEY });
    const child = spawn(process.execPath, [PROXY, "--port=" + PORT], { env, stdio: ["ignore", fd, fd], cwd: ROOT });
    children.push(child);
    let up = false, h0 = null;
    for (let i = 0; i < 40; i++) {
      const r = await req(PORT, "GET", "/health", { origin: "http://127.0.0.1:8000" });
      if (r.status === 200) { up = true; h0 = jparse(r.text); break; }
      await sleep(250);
    }
    A(up, "反代已起在 127.0.0.1:" + PORT + "，GET /health → 200", up ? JSON.stringify({ ok: h0 && h0.ok, hasKey: h0 && h0.hasKey }) : "起不来");
    A(!!(h0 && h0.ok === true), "GET /health 返回 {ok:true}", h0 && JSON.stringify({ ok: h0.ok, service: h0.service, upstream: h0.upstream }));
    A(!!(h0 && h0.hasKey === true), "/health 报告 hasKey=true（不暴露 key 本身）");
    A(!JSON.stringify(h0 || {}).includes(KEY), "**/health 响应体里不含 key**（逐字比对真 key）");
    const hReq = await req(PORT, "GET", "/health", { origin: "http://127.0.0.1:8000" });
    A(hReq.headers["access-control-allow-origin"] === "http://127.0.0.1:8000",
      "GET /health 回显允许的来源（Access-Control-Allow-Origin）", hReq.headers["access-control-allow-origin"]);

    /* ── 1. CORS 预检 ── */
    const o1 = await req(PORT, "OPTIONS", "/route", { origin: "null", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    A(o1.status === 204, "OPTIONS /route（Origin: null，file:// 页面）→ 204", "status=" + o1.status);
    A(o1.headers["access-control-allow-origin"] === "null", "回显 Origin: null", o1.headers["access-control-allow-origin"]);
    const o2 = await req(PORT, "OPTIONS", "/route", { origin: "http://127.0.0.1:8000", headers: { "Access-Control-Request-Method": "POST" } });
    A(o2.status === 204, "OPTIONS /route（Origin: http://127.0.0.1:8000）→ 204", "status=" + o2.status);
    A(o2.headers["access-control-allow-origin"] === "http://127.0.0.1:8000", "回显 Origin: http://127.0.0.1:8000", o2.headers["access-control-allow-origin"]);
    A(/POST/i.test(String(o2.headers["access-control-allow-methods"])) && /Content-Type/i.test(String(o2.headers["access-control-allow-headers"])),
      "预检头齐：allow-methods 含 POST、allow-headers 含 Content-Type",
      o2.headers["access-control-allow-methods"] + " | " + o2.headers["access-control-allow-headers"]);
    evidence.raw.preflight = { null: { status: o1.status, acao: o1.headers["access-control-allow-origin"] }, local: { status: o2.status, acao: o2.headers["access-control-allow-origin"], methods: o2.headers["access-control-allow-methods"], headers: o2.headers["access-control-allow-headers"] } };

    /* ── 2. 真实转发一次（真 key → 真上游） ── */
    const t0 = Date.now();
    const fw = await req(PORT, "POST", "/route", { origin: "http://127.0.0.1:8000", body: miniBody("我想去打两圈") });
    const fwJson = jparse(fw.text);
    A(fw.status === 200, "POST /route（Origin 是本机页面）→ 200，真上游真转发", "status=" + fw.status + " " + (Date.now() - t0) + "ms");
    A(!!(fwJson && fwJson.answers && fwJson.answers.intent), "响应体是上游原始 JSON（含 answers.intent）", fwJson && JSON.stringify(fwJson.answers.intent).slice(0, 120));
    A(fw.headers["access-control-allow-origin"] === "http://127.0.0.1:8000", "转发响应也带 CORS 头（页面才读得到）");
    A(!fw.text.includes(KEY), "**转发响应里不含 key**（逐字比对）");
    evidence.raw.forward = { status: fw.status, ms: Date.now() - t0, intentAnswer: fwJson && fwJson.answers && fwJson.answers.intent, model: fwJson && fwJson.model };

    /* ── 3. 请求体校验（反代的本地 400，不应白跑一次上游） ── */
    const bad = await req(PORT, "POST", "/route", { origin: "http://127.0.0.1:8000", body: { hello: 1 } });
    A(bad.status === 400 && /bad_request|bad_json|empty_body/.test(bad.text), "请求体不是 {state,model,questions} → 400 + 结构化错误", "status=" + bad.status + " " + scrub(bad.text).slice(0, 120));
    const empty = await req(PORT, "POST", "/route", { origin: "http://127.0.0.1:8000", body: "" });
    A(empty.status === 400, "空 body → 400", "status=" + empty.status + " " + scrub(empty.text).slice(0, 100));
    const nf = await req(PORT, "GET", "/nope", { origin: "http://127.0.0.1:8000" });
    A(nf.status === 404, "未知路径 → 404", "status=" + nf.status);

    /* ── 4. 故意不带 key 的实例 → /route 503 + 中文说明 ──
       做法：用反代**导出的模块 API** 在另一个端口起实例，env 传空对象，
       并把 `child_process.execSync` 打桩成失败 —— 精确模拟"这台机器上没设该环境变量"。
       （**没有**改动机器上的任何环境变量，也没有动写入方的代码。） */
    const cp = require("child_process");
    const realExecSync = cp.execSync;
    let nokInfo = null;
    try {
      cp.execSync = function () { throw new Error("simulated: no user-level env var on this machine"); };
      const mod = require(PROXY);
      const app = mod.createServer({ port: NOK_PORT, env: {}, log: function () { } });
      servers.push(app);
      await app.listen();
      nokInfo = { hasKey: app.hasKey, keySource: app.keySource };
      const h = await req(NOK_PORT, "GET", "/health", { origin: "http://127.0.0.1:8000" });
      const hj = jparse(h.text);
      A(h.status === 200 && hj && hj.ok === true && hj.hasKey === false, "没 key 的实例：/health 仍 200 且 hasKey=false（进程活着，页面探测不会误判成「反代没跑」）", h.status + " hasKey=" + (hj && hj.hasKey));
      const r503 = await req(NOK_PORT, "POST", "/route", { origin: "http://127.0.0.1:8000", body: miniBody("我想去打两圈") });
      const j503 = jparse(r503.text);
      A(r503.status === 503, "**没 key → POST /route 返回 503**", "status=" + r503.status);
      A(!!(j503 && j503.error && j503.error.type === "no_key"), "503 带结构化错误 error.type=no_key", j503 && JSON.stringify(j503.error).slice(0, 160));
      A(/TYPESAFE_API_KEY/.test(r503.text) && /[\u4e00-\u9fff]/.test(r503.text), "503 文案里有环境变量名 + 中文说明（页面能直接给玩家看）", scrub(r503.text).slice(0, 200));
      A(!r503.text.includes(KEY), "503 响应里不含 key");
      evidence.raw.noKey = { status: r503.status, body: jparse(r503.text), keySource: nokInfo.keySource };
    } finally { cp.execSync = realExecSync; }

    /* ── 5. 透传：上游 401 原样出去（不被改写） ── */
    try {
      const mod = require(PROXY);
      const badApp = mod.createServer({ port: BAD_PORT, key: "apikey_verify_placeholder_0000_0000", log: function () { } });
      servers.push(badApp);
      await badApp.listen();
      const r401 = await req(BAD_PORT, "POST", "/route", { origin: "http://127.0.0.1:8000", body: miniBody("我想去打两圈") });
      A(r401.status === 401, "**伪 key → 上游 401 原样透传**（没被改写成 502）", "status=" + r401.status + " " + scrub(r401.text).slice(0, 140));
      A(/authentication|Cannot authenticate|401/i.test(r401.text), "401 的响应体也来自上游（语义不变）", scrub(r401.text).slice(0, 140));
      evidence.raw.passthrough401 = { status: r401.status, body: scrub(r401.text).slice(0, 400) };

      /* 上游连不上 → 502；上游挂起 → 结构化超时 */
      const deadApp = mod.createServer({ port: DEAD_PORT, key: "apikey_verify_placeholder_0000_0000", upstream: "http://127.0.0.1:9/dead", log: function () { } });
      servers.push(deadApp);
      await deadApp.listen();
      const rDead = await req(DEAD_PORT, "POST", "/route", { origin: "http://127.0.0.1:8000", body: miniBody("我想去打两圈") });
      const jDead = jparse(rDead.text);
      A(rDead.status === 502, "上游连不上 → **502** + 结构化错误", "status=" + rDead.status + " " + scrub(rDead.text).slice(0, 140));

      /* 假上游：收到请求就挂着不回应 → 看反代的超时行为 */
      const slow = http.createServer(() => { /* 故意不回应 */ });
      await new Promise((r) => slow.listen(SLOW_PORT, "127.0.0.1", r));
      servers.push({ close: () => new Promise((r) => slow.close(() => r(true))) });
      const slowApp = mod.createServer({ port: SLOW_PORT + 100, key: "apikey_verify_placeholder_0000_0000", upstream: "http://127.0.0.1:" + SLOW_PORT + "/hang", timeoutMs: 1200, log: function () { } });
      servers.push(slowApp);
      await slowApp.listen();
      const tSlow = Date.now();
      const rSlow = await req(SLOW_PORT + 100, "POST", "/route", { origin: "http://127.0.0.1:8000", body: miniBody("我想去打两圈"), timeoutMs: 12000 });
      A(rSlow.status === 504 || rSlow.status === 502, "上游挂起 → 网关超时（502/504）+ 结构化错误，不挂死", "status=" + rSlow.status + " " + (Date.now() - tSlow) + "ms " + scrub(rSlow.text).slice(0, 120));
      A(/upstream_timeout|timeout/.test(rSlow.text), "超时错误体里点明是上游超时", scrub(rSlow.text).slice(0, 140));
      evidence.raw.upstreamFail = { dead: { status: rDead.status, body: scrub(rDead.text).slice(0, 300) }, slow: { status: rSlow.status, ms: Date.now() - tSlow, body: scrub(rSlow.text).slice(0, 300) } };
    } catch (e) {
      A(false, "上游失败路径验证", scrub(e && e.message));
    }

    /* ── 6. P0 复验：跨源简单请求（不触发预检）必须 403 **且不转发** ──
       背景：`Content-Type: text/plain` 的跨源 POST 不触发预检，若 POST 层不判 Origin，
       恶意页面就能把本机反代当免费 LLM 中继（烧配额）。写入方已修，这里复验两条：
         ① 响应 403 + 结构化错误 forbidden_origin
         ② **没有转发** —— 用"上游调用日志行数不变"证明（日志里每条真转发都有 `upstream=`） */
    const upstreamCalls = () => ((fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "").match(/upstream=\d+ms/g) || []).length;
    const upBefore = upstreamCalls();
    const evil = await req(PORT, "POST", "/route", {
      origin: "https://evil.example",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },      // 简单请求：不触发预检
      body: JSON.stringify(miniBody("我想去打两圈")),
    });
    await sleep(300);
    const upAfter = upstreamCalls();
    A(evil.status === 403, "**跨源简单请求（Origin: https://evil.example）→ 403**（P0 修复已生效）", "status=" + evil.status + " " + scrub(evil.text).slice(0, 140));
    A(/forbidden_origin|origin/i.test(evil.text), "403 带结构化错误（说明来源不在白名单）", scrub(evil.text).slice(0, 160));
    A(upAfter === upBefore, "**且确认没有转发到上游**（上游调用日志行数未变）", "upstream 调用 " + upBefore + " → " + upAfter);
    A(evil.headers["access-control-allow-origin"] === undefined, "403 响应不回显 ACAO（浏览器也读不到）", String(evil.headers["access-control-allow-origin"]));
    const evilNote = "跨源简单请求（Origin: https://evil.example, Content-Type: text/plain）→ HTTP " + evil.status +
      "；上游调用行数 " + upBefore + " → " + upAfter + (upAfter === upBefore ? "（未转发）" : "（**被转发了！**）");
    evidence.raw.crossOrigin = { status: evil.status, acao: evil.headers["access-control-allow-origin"] || null, upstreamCallsBefore: upBefore, upstreamCallsAfter: upAfter, note: evilNote };

    /* 6b. 本机来源的同样请求仍然通（别把 P0 修成"谁都进不来"） */
    const upBefore6b = upstreamCalls();
    const okLocal = await req(PORT, "POST", "/route", { origin: "http://127.0.0.1:8000", body: miniBody("我想去打两圈") });
    A(okLocal.status === 200, "同一路径、本机来源（http://127.0.0.1:8000）仍照常转发 → 200", "status=" + okLocal.status);
    const okNull = await req(PORT, "POST", "/route", { origin: "null", body: miniBody("我想去打两圈") });
    A(okNull.status === 200, "file:// 页面的 Origin: null 也仍照常转发 → 200", "status=" + okNull.status);
    await sleep(250);
    A(upstreamCalls() === upBefore6b + 2, "这两条**确实转发到了上游**（upstream 计数 +2）", "upstream " + upBefore6b + " → " + upstreamCalls());

    /* 6c. 没有 Origin 头（curl / Node 工具这类非浏览器客户端）→ 放行 */
    const noOrigin = await req(PORT, "POST", "/route", { body: miniBody("我想去打两圈") });
    A(noOrigin.status === 200, "无 Origin 头（非浏览器客户端）→ 放行转发 200", "status=" + noOrigin.status);

    /* 6d. --no-null-origin（更严模式）：file:// 的 null 也要挡掉 */
    try {
      const mod2 = require(PROXY);
      const strictApp = mod2.createServer({ port: NULL_PORT, key: KEY, log: function () { }, allowNullOrigin: false });
      servers.push(strictApp);
      await strictApp.listen();
      const sNull = await req(NULL_PORT, "POST", "/route", { origin: "null", body: miniBody("我想去打两圈") });
      A(sNull.status === 403, "--no-null-origin 实例：Origin: null → 403", "status=" + sNull.status);
      const sLocal = await req(NULL_PORT, "POST", "/route", { origin: "http://127.0.0.1:8000", body: miniBody("我想去打两圈") });
      A(sLocal.status === 200, "--no-null-origin 实例：本机 http 源仍放行（只收紧 file://）", "status=" + sLocal.status);
      const sPre = await req(NULL_PORT, "OPTIONS", "/route", { origin: "null", headers: { "Access-Control-Request-Method": "POST" } });
      A(sPre.status === 403 || sPre.headers["access-control-allow-origin"] === undefined,
        "--no-null-origin 实例：null 的预检也不放行", "status=" + sPre.status + " acao=" + String(sPre.headers["access-control-allow-origin"]));
      evidence.raw.noNullOrigin = { post: sNull.status, local: sLocal.status, preflight: sPre.status };
    } catch (e) { A(false, "--no-null-origin 复验", scrub(e && e.message)); }


    /* ── 7. 日志脱敏：子进程 stdout 逐字扫描 ── */
    await sleep(200);
    let logText = "";
    try { logText = fs.readFileSync(logFile, "utf8"); } catch (e) { }
    A(logText.length > 0, "反代有请求日志（stdout 已捕获）", logText.split("\n").length + " 行");
    A(!logText.includes(KEY), "**日志里没有 key**（逐字比对真 key）");
    A(!/player_utterance|minigames|common_phrasings/.test(logText), "日志里没有完整 state 的字段名（只打字节数/状态码/耗时）");
    const logLines = logText.split("\n").filter(Boolean).slice(-8).map(scrub);
    console.log("  · 反代日志（末 8 行，已脱敏）：\n      " + logLines.join("\n      "));
    evidence.raw.proxyLogTail = logLines;

    evidence.checks = checks;
    evidence.fails = fails;
    fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
    fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 1));
    console.log("\n  · 证据：" + EVIDENCE);
  } catch (e) {
    fails.push("脚本异常：" + scrub(e && e.stack || e));
    console.log("  ✖ 脚本异常：" + scrub(e && e.stack || e));
  } finally {
    for (const s of servers) { try { await s.close(); } catch (e) { } }
    for (const c of children) { try { c.kill(); } catch (e) { } }
    await sleep(300);
  }
  console.log("\n" + "═".repeat(72));
  console.log("通过 " + (checks.length - fails.length) + " 项，失败 " + fails.length + " 项");
  if (fails.length) { fails.forEach((f) => console.log("   · " + f)); process.exit(1); }
  console.log("✔ 本地反代验收：健康探测 / CORS 预检 / 503 无 key / 状态码透传 / 日志脱敏 全部成立");
  process.exit(0);
})();
