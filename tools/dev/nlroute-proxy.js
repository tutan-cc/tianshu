#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   tools/dev/nlroute-proxy.js — 自然语言影子模式的**本地反代**（零依赖 Node）

   为什么需要它（实测结论，不是设计偏好）：
     TypeSafe 的接口是给服务端用的。带 Authorization + application/json 的 POST 必然触发
     CORS 预检，而它对未知 Origin 直接拒：
        OPTIONS (Origin: null)                  → 400 "Disallowed CORS origin"
        OPTIONS (Origin: http://127.0.0.1:8000) → 400 "Disallowed CORS origin"
     所以游戏页面（file:// 或本地 http）**直连到不了模型**。
   反代一次解决两件事：
     ① 页面 → 127.0.0.1（同机、由本进程补 CORS 头）→ 上游，浏览器不再参与跨域判断；
     ② **key 只在 Node 侧**：浏览器 localStorage 里一个凭据都不用放。

   路由：
     GET  /health  → 200 {ok, upstream, hasKey, keyLen, model, version, uptimeMs}
     POST /route   → 原样转发请求体到 https://api.typesafe.ai/v1/systemone，
                     补上 Authorization: Bearer <key>（key 只从环境变量读），
                     **状态码与响应体一字不改地透传**（400/401/422 也照传）
     OPTIONS 任意  → 204 + CORS 头（预检直接放行，不让浏览器去问上游）

   安全边界：
     · key 只从环境变量 TYPESAFE_API_KEY 读（Windows 下再兜底读一次用户级变量）；
       读不到 → POST /route 返回 503 + 明确错误，**不崩、不回显任何凭据**。
     · **来源白名单在 OPTIONS 与 POST 两层都校验**：非本机来源（不是 127.0.0.1 / localhost / null）
       一律 403 且**不转发** —— 只做预检校验会被"简单请求"（Content-Type: text/plain 不触发预检）
       绕过，那样任何网页都能把本机反代当成免费 LLM 中继。
       允许 `null` 是因为游戏可能从 file:// 直接打开；要更严用 --no-null-origin 关掉它。
     · 日志只打 方法/路径/请求体字节数/耗时/状态码 —— **不打 key、不打完整 state**
       （--verbose 才额外打一句玩家原话，且仍不打 state 的其余部分）。
     · 只监听 127.0.0.1（不是 0.0.0.0），局域网里别的机器连不上。
     · 收到的 Authorization 头一律**丢弃**（浏览器说它有什么 key 都不算数，只认服务端环境变量）。

   用法：
     node tools/dev/nlroute-proxy.js                     # 127.0.0.1:8010
     node tools/dev/nlroute-proxy.js --port=8011 --verbose
     node tools/dev/nlroute-proxy.js --no-null-origin    # 连 file:// 也不放行（更严）
   退出码：0 正常关闭；2 启动失败（端口占用等）。
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const http = require("http");
const https = require("https");
const { execSync } = require("child_process");

const VERSION = "1.0.0";
const UPSTREAM = "https://api.typesafe.ai/v1/systemone";
const MODEL_HINT = "jev-latest";

/* ── 凭据：只从环境变量读；Windows 再兜底读用户级变量（仓库既有约定，见 typesafe-route-demo.js）。
      allowUserEnv=false 时不做那次兜底（单测要一个确定"没有 key"的实例）。
      绝不打印、绝不写盘。 ── */
function readKey(env, allowUserEnv) {
  const e = (env || process.env).TYPESAFE_API_KEY;
  if (e && String(e).trim()) return { key: String(e).trim(), from: "env" };
  if (allowUserEnv !== false && process.platform === "win32") {
    try {
      const out = execSync('reg query "HKCU\\Environment" /v TYPESAFE_API_KEY', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = out.match(/TYPESAFE_API_KEY\s+REG_\w+\s+(\S+)/);
      if (m && m[1].trim()) return { key: m[1].trim(), from: "user-env" };
    } catch (err) { /* 读不到就走 503 分支 */ }
  }
  return { key: null, from: null };
}

/* ── CORS / 来源白名单 ──────────────────────────────────────────────────────
   只放行**本机来源**：
     · http://127.0.0.1:<任意端口> · http://localhost:<任意端口>  ← 本地静态服务
     · null                                                      ← 本地 file:// 打开的页面
   白名单**同时**用在预检（OPTIONS）与真实请求（POST）上：
   两者只做 OPTIONS 校验是不够的 —— 页面可以用 `Content-Type: text/plain` 发**简单请求**绕过预检，
   那样就能把本机反代当成免费的 LLM 中继（烧配额）。所以 POST 层必须自己再判一次，非白名单来源直接 403、**不转发**。
   残余风险（写在报告里）：`Origin: null` 也可能来自恶意页面的 sandbox iframe；
   要更严就用 `--no-null-origin` 关掉 null（代价：file:// 直接打开的游戏页用不了，必须从本地 HTTP 起）。 */
function allowOrigin(origin, allowNull) {
  if (!origin) return null;                       // 没有 Origin = 非浏览器客户端（curl / 本仓探针），上面单独判
  if (origin === "null") return allowNull === false ? null : "null";
  try {
    const u = new URL(origin);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]") return origin;
  } catch (e) { /* 非法 Origin → 不放行 */ }
  return null;
}
/** 无 Origin 头 = 不是浏览器发的跨源请求（浏览器一定会带），本机工具放行 */
function originDecision(origin, allowNull) {
  if (!origin) return { ok: true, echo: null, why: "no-origin(local-tool)" };
  const ok = allowOrigin(origin, allowNull);
  if (ok) return { ok: true, echo: ok, why: "allowlist" };
  return { ok: false, echo: null, why: "origin-not-allowlisted" };
}
function corsHeaders(echoOrigin) {
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (echoOrigin) h["Access-Control-Allow-Origin"] = echoOrigin;
  return h;
}
function send(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  }, extraHeaders || {}));
  res.end(body);
}

/**
 * 造一个反代服务（导出出来是为了让单测能在进程内起一个，指向假上游）。
 * @param {object} opts
 *   port        监听端口（默认 8010；0 = 随机端口，测试用）
 *   host        默认 127.0.0.1
 *   upstream    上游 URL（默认官方端点；测试可指向本地假上游）
 *   key         显式 key（默认从环境变量读；**测试用假 key**）
 *   timeoutMs   上游超时（默认 30000）
 *   log         日志函数（默认 console.log；测试可注入以断言"日志里没有 key"）
 *   verbose     是否额外打印玩家原话
 */
function createServer(opts) {
  opts = opts || {};
  const host = opts.host || "127.0.0.1";
  const upstream = opts.upstream || UPSTREAM;
  const timeoutMs = Number(opts.timeoutMs || 30000);
  const log = opts.log || ((s) => console.log(s));
  const verbose = !!opts.verbose;
  const allowNullOrigin = opts.allowNullOrigin !== false;      // file:// 的 Origin: null 默认放行
  const startedAt = Date.now();
  const cred = opts.key ? { key: opts.key, from: "explicit" } : readKey(opts.env, opts.userEnvFallback);
  const stats = { health: 0, route: 0, ok: 0, upstreamErr: 0, noKey: 0, badBody: 0, forbidden: 0 };

  const u = new URL(upstream);
  const transport = u.protocol === "http:" ? http : https;

  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    const origin = req.headers.origin;
    const od = originDecision(origin, allowNullOrigin);
    const cors = corsHeaders(od.echo);
    const path = String(req.url || "/").split("?")[0];

    /* ① 来源白名单：预检与真实请求**都要过**。
       只做 OPTIONS 会被"简单请求"（text/plain 不触发预检）绕过 → 本机反代就成了公网可用的 LLM 中继。 */
    if (!od.ok) {
      stats.forbidden++;
      log(`[${new Date().toISOString()}] ${req.method} ${path} → 403 来源不在白名单：origin=${origin}（${Date.now() - t0}ms）`);
      send(res, 403, {
        error: {
          type: "forbidden_origin",
          message: "反代只服务本机页面（http://127.0.0.1:* / http://localhost:* / file:// 的 null）",
          origin: origin || null,
        },
      }, cors);
      return;
    }

    /* ② 预检：直接 204，不让浏览器去问上游（上游对非白名单 Origin 会 400） */
    if (req.method === "OPTIONS") {
      res.writeHead(204, Object.assign({ "Content-Length": "0" }, cors));
      res.end();
      log(`[${new Date().toISOString()}] OPTIONS ${path} → 204  origin=${origin || "-"} (${Date.now() - t0}ms)`);
      return;
    }

    if (req.method === "GET" && (path === "/health" || path === "/")) {
      stats.health++;
      send(res, 200, {
        ok: true,
        service: "nlroute-proxy",
        version: VERSION,
        upstream: upstream,
        model: MODEL_HINT,
        hasKey: !!cred.key,
        keySource: cred.key ? cred.from : null,
        keyLen: cred.key ? cred.key.length : 0,     // 只给长度，不给任何字符
        uptimeMs: Date.now() - startedAt,
        stats: stats,
      }, cors);
      log(`[${new Date().toISOString()}] GET /health → 200  hasKey=${!!cred.key}  origin=${origin || "-"} (${Date.now() - t0}ms)`);
      return;
    }

    if (req.method === "POST" && path === "/route") {
      stats.route++;
      const chunks = [];
      let bytes = 0;
      req.on("data", (c) => { bytes += c.length; if (bytes > 512 * 1024) { req.destroy(); } else chunks.push(c); });
      req.on("error", () => { /* 客户端断开：静默 */ });
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(body.toString("utf8")); } catch (e) { parsed = null; }
        const utter = parsed && parsed.state && typeof parsed.state.player_utterance === "string" ? parsed.state.player_utterance : "";
        const tag = `POST /route  body=${bytes}B` + (verbose && utter ? `  utterance="${utter.slice(0, 80)}"` : "") + `  origin=${origin || "-"}`;
        if (!cred.key) {
          stats.noKey++;
          log(`[${new Date().toISOString()}] ${tag} → 503 没读到 TYPESAFE_API_KEY（${Date.now() - t0}ms）`);
          send(res, 503, {
            error: { type: "no_key", message: "反代没有读到 TYPESAFE_API_KEY：请在启动反代的终端里设置该环境变量（或写进 Windows 用户级变量），然后重启反代。" },
          }, cors);
          return;
        }
        if (!parsed || !parsed.questions || !parsed.model) {
          stats.badBody++;
          log(`[${new Date().toISOString()}] ${tag} → 400 请求体不是 {state, model, questions}`);
          send(res, 400, { error: { type: "bad_request", message: "请求体必须形如 {state, model, questions}（反代只做透明转发，不补字段）" } }, cors);
          return;
        }

        const upHeaders = {
          "Content-Type": "application/json",
          "Content-Length": body.length,
          Authorization: "Bearer " + cred.key,          // ← 浏览器带来的 Authorization 一律丢弃，只认这里的
          "User-Agent": "nlroute-proxy/" + VERSION,
        };
        const up = transport.request({
          protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443),
          path: u.pathname + (u.search || ""), method: "POST", headers: upHeaders, timeout: timeoutMs,
        }, (upRes) => {
          const out = [];
          upRes.on("data", (c) => out.push(c));
          upRes.on("end", () => {
            const payload = Buffer.concat(out);
            if (upRes.statusCode === 200) stats.ok++; else stats.upstreamErr++;
            const h = Object.assign({}, cors, {
              "Content-Type": upRes.headers["content-type"] || "application/json; charset=utf-8",
              "Content-Length": payload.length,
              "Cache-Control": "no-store",
            });
            /* 上游的状态码与响应体**原样透传**（400/401/422 不改语义） */
            const rid = upRes.headers["x-typesafe-request-id"];
            if (rid) h["X-Typesafe-Request-Id"] = rid;
            res.writeHead(upRes.statusCode || 502, h);
            res.end(payload);
            log(`[${new Date().toISOString()}] ${tag} → ${upRes.statusCode}  upstream=${Date.now() - t0}ms${rid ? "  " + rid : ""}`);
          });
        });
        up.on("timeout", () => {
          stats.upstreamErr++;
          up.destroy(new Error("upstream timeout"));
        });
        up.on("error", (err) => {
          if (res.headersSent) { try { res.end(); } catch (e) { /* 忽略 */ } return; }
          stats.upstreamErr++;
          const msg = String((err && err.message) || err);
          const isTimeout = /timeout/i.test(msg);
          log(`[${new Date().toISOString()}] ${tag} → ${isTimeout ? 504 : 502} 上游失败：${msg}（${Date.now() - t0}ms）`);
          send(res, isTimeout ? 504 : 502, {
            error: {
              type: isTimeout ? "upstream_timeout" : "upstream_error",
              message: "反代连不上 TypeSafe：" + msg,
              upstream: upstream,
            },
          }, cors);
        });
        up.end(body);
      });
      return;
    }

    send(res, 404, { error: { type: "not_found", message: "只有 GET /health 与 POST /route（预检走 OPTIONS）" } }, cors);
    log(`[${new Date().toISOString()}] ${req.method} ${path} → 404`);
  });

  server.on("clientError", (err, socket) => { try { socket.destroy(); } catch (e) { } });

  return {
    server: server,
    stats: stats,
    keySource: cred.key ? cred.from : null,
    hasKey: !!cred.key,
    allowNullOrigin: allowNullOrigin,
    listen() {
      return new Promise((resolve, reject) => {
        /* 注意 port=0 是"随便挑一个空闲端口"（单测用），不能被 || 兜底成 8010 */
        const want = (opts.port === undefined || opts.port === null || opts.port === "") ? 8010 : Number(opts.port);
        server.once("error", reject);
        server.listen(want, host, () => resolve(server.address()));
      });
    },
    close() { return new Promise((r) => server.close(() => r(true))); },
  };
}

/* ── CLI ── */
function arg(name, dflt) {
  const a = process.argv.find((x) => x === "--" + name || x.startsWith("--" + name + "="));
  if (a === undefined) return dflt;
  return a.includes("=") ? a.split("=").slice(1).join("=") : true;
}

if (require.main === module) {
  const port = Number(arg("port", 8010));
  const host = String(arg("host", "127.0.0.1"));
  const app = createServer({
    port: port, host: host,
    upstream: String(arg("upstream", UPSTREAM)),
    timeoutMs: Number(arg("timeout", 30000)),
    verbose: !!arg("verbose", false),
    allowNullOrigin: !arg("no-null-origin", false),
  });
  app.listen().then((addr) => {
    console.log("nlroute 反代已启动 · v" + VERSION);
    console.log("  监听    : http://" + host + ":" + addr.port + "   （GET /health · POST /route）");
    console.log("  上游    : " + String(arg("upstream", UPSTREAM)));
    console.log("  凭据    : " + (app.hasKey ? "已从 " + app.keySource + " 读到（内容与长度都不打印）" : "**没读到 TYPESAFE_API_KEY** —— /route 会返回 503"));
    console.log("  来源    : 只放行 http://127.0.0.1:* / http://localhost:*" + (app.allowNullOrigin ? " / null(file://)" : "（null 已用 --no-null-origin 关掉）") + "，其余 403 且不转发");
    console.log("  页面端  : NLRoute 默认就打这个端口，起来即可用（不需要在浏览器里配 key）");
    console.log("  停止    : Ctrl+C");
  }).catch((e) => {
    console.error("✖ 反代启动失败：" + ((e && e.message) || e));
    process.exit(2);
  });
  process.on("SIGINT", () => { console.log("\n反代已停止。"); process.exit(0); });
  process.on("SIGTERM", () => { process.exit(0); });
}

module.exports = { createServer, readKey, allowOrigin, originDecision, UPSTREAM, VERSION };
