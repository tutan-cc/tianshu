/* ═══════════════════════════════════════════════════════════════════════════
   tools/dev/stamp.js — 版本戳生成/校验（零依赖 · 幂等 · 不碰模块文件）

   为什么有这个东西：踩过一次坑 —— 页面 CSS/图片是新的，但 breakfast.js
   走了浏览器缓存，新加的"音效"不生效却完全看不出来。所以要在页面右下角
   常驻一枚水印：build 时间 + 各模块大小 + 内容指纹。戳比代码旧 = 缓存。

   它做什么：
     · 读 index.html / mahjong.js / breakfast.js / map3d.js 的 mtime + 字节数
     · build    = **非 index.html 的模块**里最新的 mtime → YYYYMMDD-HHMM（本地时区）
     · ch       = 内容指纹（6 位）：
                    · index.html  → 先**剔掉 BUILD-STAMP 标记块**再算 SHA1
                    · 其余模块    → 字节数 + mtime 拼起来算 SHA1
                  任何参与文件的内容/mtime 一变 → ch 必变
     · kb       = 每个模块的 KB 数（四舍五入）
     · 把结果写进 index.html 的 BUILD-STAMP:BEGIN/END 标记块（只换块内内容，
       逐字替换、幂等；没有标记块时插入一次到 </body> 之前）

   ⚠ 两条"别改回去"的坑（都真踩过，都是 index.html 自我引用）：
     1. index.html **不能**参与 ch 的 size+mtime —— 脚本一写盘就改掉它自己的
        size/mtime → 永远不幂等，且 idx 体积永远报的是写盘前的旧值。
        所以 index.html 走"剔块后内容哈希"。
     2. index.html **不能**参与 build 的 max(mtime) —— 它的 mtime 就是"上次盖章
        时间"，纳进来 build 会每盖一次往前走一格，永不收敛。
        所以 build 只看 mahjong.js / breakfast.js / map3d.js。
     同理，块内也不要写 index.html 自己的 mtime。

   用法：
     node tools/dev/stamp.js             写入（页面 + 控制台）
     node tools/dev/stamp.js --check     只校验：页面戳与当前文件不一致 → 退出码 1
     node tools/dev/stamp.js --print     只打印本应写入的标记块，不改文件
     node tools/dev/stamp.js --json      以 JSON 输出（可与 --check 组合做 CI 消费）
     node tools/dev/stamp.js --paths     只打印参与指纹的文件清单
     node tools/dev/stamp.js --quiet     静默（只看退出码）

   退出码：
     0 = 成功（写入完成，或 --check 一致）
     1 = --check 不一致（缓存风险），或标记块损坏
     2 = 用法错误 / 目标文件缺失
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..", "..");         // → 重生2-原型/
const INDEX = path.join(ROOT, "index.html");
const SELF = "index.html";                             // 需要"剔块后取哈希"的那个

/* 参与指纹的模块（顺序固定 → 指纹可复现）。tag 只用于水印/JSON 里的短标签 */
const MODULES = [
  { file: "index.html",   tag: "idx" },
  { file: "mahjong.js",   tag: "mj"  },
  { file: "breakfast.js", tag: "bf"  },
  { file: "map3d.js",     tag: "map" },
];

const BEGIN = "<!-- BUILD-STAMP:BEGIN -->";
const END = "<!-- BUILD-STAMP:END -->";

const argv = process.argv.slice(2);
const FLAGS = ["--check", "--print", "--json", "--paths", "--quiet"];
const has = (f) => argv.includes(f);
const CHECK = has("--check");
const PRINT = has("--print");
const JSONOUT = has("--json");
const PATHS = has("--paths");
const QUIET = has("--quiet");
const USAGE = "用法：node tools/dev/stamp.js [--check|--print|--json|--paths|--quiet]";

for (const a of argv) {
  if (FLAGS.indexOf(a) < 0) { console.error("✗ 未知参数：" + a + "\n" + USAGE); process.exit(2); }
}
/** 给人看的输出（--quiet / --json 时全部压掉，避免污染机器可读输出）*/
const say = (...a) => { if (!QUIET && !JSONOUT) console.log(...a); };

const sha1 = (s) => crypto.createHash("sha1").update(s, "utf8").digest("hex");

/* ── 1. 标记块定位（先于指纹，因为指纹要剔掉它）────────────────────────── */
function countOcc(hay, needle) {
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}

/** 定位标记块：markers（成对，替换块内）| insert（没有，插到 </body> 前）| broken */
function locate(html) {
  const nB = countOcc(html, BEGIN), nE = countOcc(html, END);
  if (nB === 1 && nE === 1) {
    const a = html.indexOf(BEGIN), b = html.indexOf(END) + END.length;
    if (b < a) return { kind: "broken", why: "END 出现在 BEGIN 之前" };
    return { kind: "markers", start: a, end: b };
  }
  if (nB === 0 && nE === 0) {
    const bodyEnd = html.lastIndexOf("</body>");
    if (bodyEnd < 0) return { kind: "broken", why: "找不到 </body>，无法插入标记块" };
    const lineStart = html.lastIndexOf("\n", bodyEnd) + 1;
    /* </body> 顶格时 indent = ""，插完补一个换行，保持文件形状整齐 */
    const indent = /^[ \t]*$/.test(html.slice(lineStart, bodyEnd)) ? html.slice(lineStart, bodyEnd) : "";
    return { kind: "insert", start: lineStart, end: lineStart, indent: indent };
  }
  return {
    kind: "broken",
    why: "标记块不成对：BEGIN×" + nB + " / END×" + nE + "（可能被手工删坏，请修成一对后再跑）",
  };
}

/** 剔掉标记块后的正文（含块外的换行由调用方决定）→ 指纹与幂等的基础 */
function stripBlock(html) {
  const loc = locate(html);
  if (loc.kind !== "markers") return { ok: loc.kind === "insert", html: html, loc: loc };
  return { ok: true, html: html.slice(0, loc.start) + html.slice(loc.end), loc: loc };
}

/* ── 2. 采集真实文件状态 ───────────────────────────────────────────────── */
function localStamp(ms) {                       // 本地时区 YYYYMMDD-HHMM
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    "-" + p(d.getHours()) + p(d.getMinutes());
}

function collect(html) {
  const strip = stripBlock(html);
  if (!strip.ok) return { fatal: strip.loc.why };

  const mods = MODULES.map((m) => {
    const p = path.join(ROOT, m.file);
    let st;
    try { st = fs.statSync(p); }
    catch (e) { return { fatal: "读不到 " + m.file + "：" + e.message }; }
    if (!st.isFile()) return { fatal: "不是文件：" + m.file };
    return {
      file: m.file, tag: m.tag, path: p,
      size: st.size,
      mtimeMs: Math.round(st.mtimeMs),
      mtimeISO: new Date(st.mtimeMs).toISOString(),
    };
  });
  const bad = mods.find((m) => m.fatal);
  if (bad) return { fatal: bad.fatal };

  /* 算 build / 采集 mtime 时**一律排除 index.html**：
     它的 mtime = "上次盖章时间"，纳入就会自我引用（盖一次 build 就往前走一格，永不收敛）。
     它的真实内容由 idxHash（剔块后）代表。 */
  const others = mods.filter((m) => m.file !== SELF);
  const newest = others.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  const tie = others.filter((m) => m.mtimeMs === newest.mtimeMs);

  /* index.html：剔块后的内容哈希 + 剔块后长度；其余模块：字节数 + mtime
     （大文件不必读进来算哈希，够用且快）*/
  const stripped = strip.html;
  const idxHash = sha1(stripped);

  const ch = sha1([
    "idx:" + idxHash + ":" + Buffer.byteLength(stripped, "utf8"),
    ...others.map((m) => m.file + ":" + m.size + ":" + m.mtimeMs),
  ].join("|")).slice(0, 6);

  return {
    build: localStamp(newest.mtimeMs),
    buildMs: newest.mtimeMs,
    newestFile: newest.file,
    ch: ch,
    idxHash: idxHash,
    idxStrippedBytes: Buffer.byteLength(stripped, "utf8"),
    sizesKB: mods.reduce((o, m) => (o[m.tag] = Math.round(m.size / 1024), o), {}),
    modules: mods,
    tie: tie.length > 1 ? tie.map((m) => m.file) : null,
    loc: strip.loc,
  };
}

/* ── 3. 渲染标记块（同一份 state → 逐字节相同的块，这是幂等的基础）──────── */
function wmText(s) {
  const kb = s.sizesKB;
  return [
    "天枢原型",
    "build " + s.build,
    "ch " + s.ch,
    "bf " + kb.bf + "K",
    "mj " + kb.mj + "K",
    "idx " + kb.idx + "K",
    "map " + kb.map + "K",
  ].join(" · ");
}

function renderBlock(s) {
  const payload = JSON.stringify({
    build: s.build,
    fingerprint: s.ch,
    sizes: s.sizesKB,
    files: s.modules.reduce((o, m) => (o[m.file] = m.size, o), {}),
    /* ⚠ 只收**非 index.html** 的 mtime：index.html 自己的 mtime 就是"上次盖章时间"，
       把它写进块里 → 每次写盘都改掉块内容 → 永不幂等（踩过这个坑，别加回来）。
       index.html 的真实内容由下面的 idxContentHash（剔块后）代表。*/
    mtimes: s.modules.filter((m) => m.file !== SELF).reduce((o, m) => (o[m.file] = m.mtimeMs, o), {}),
    idxContentHash: s.idxHash,
    idxContentBytes: s.idxStrippedBytes,
    generatedBy: "tools/dev/stamp.js",
  });

  return [
    BEGIN,
    "<!-- 由 tools/dev/stamp.js 生成 —— 不要手改块内内容；改了跑一次 stamp.js 会原样覆盖 -->",
    '<div id="buildStamp" data-build="' + s.build + '" data-fp="' + s.ch + '"',
    '     title="构建版本戳 · build ' + s.build + " · 内容指纹 " + s.ch +
      "（由 tools/dev/stamp.js 生成；戳早于代码 = 浏览器缓存，Ctrl+Shift+R）\"",
    '     aria-hidden="true"',
    '     style="position:fixed;right:8px;bottom:6px;z-index:180;pointer-events:none;user-select:none;' +
      '-webkit-user-select:none;font:10px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace;' +
      'color:rgba(236,234,244,.45);letter-spacing:.02em;text-shadow:0 1px 2px rgba(0,0,0,.75);' +
      'white-space:nowrap;max-width:70vw;overflow:hidden;text-overflow:ellipsis">' + wmText(s) + "</div>",
    "<script>window.__BUILD=" + payload + ";</script>",
    END,
  ].join("\n");
}

/* ── 4. 应用/校验 ──────────────────────────────────────────────────────── */
function readIndex() {
  try { return fs.readFileSync(INDEX, "utf8"); }
  catch (e) { console.error("✗ 读不到 index.html：" + e.message); process.exit(2); }
}

/** 用新块重建 index.html；insert 时补一个换行 + 原缩进 */
function applyBlock(html, block) {
  const loc = locate(html);
  if (loc.kind === "broken") return { ok: false, why: loc.why };
  const insert = loc.kind === "insert" ? block + "\n" + loc.indent : block;
  return {
    ok: true,
    html: html.slice(0, loc.start) + insert + html.slice(loc.end),
    kind: loc.kind,
  };
}

/** 从页面里抓回现有戳，用于 --check */
function extractPageState(html) {
  const loc = locate(html);
  if (loc.kind !== "markers") return { ok: false, why: "标记块" + (loc.kind === "insert" ? "不存在" : "损坏：" + loc.why) };
  const seg = html.slice(loc.start, loc.end);
  const g = (re) => { const m = re.exec(seg); return m ? m[1] : null; };
  const out = {
    build: g(/data-build="([^"]*)"/),
    ch: g(/data-fp="([^"]*)"/),
    hasDiv: /id="buildStamp"/.test(seg),
    mJson: /window\.__BUILD=(\{[\s\S]*?\});/.exec(seg),
  };
  if (!out.build || !out.ch || !out.hasDiv || !out.mJson) {
    return { ok: false, why: "块里缺少 data-build / data-fp / #buildStamp / __BUILD 之一" };
  }
  try { out.payload = JSON.parse(out.mJson[1]); }
  catch (e) { return { ok: false, why: "__BUILD 的 JSON 解析失败：" + e.message }; }
  return { ok: true, state: out };
}

/* ── 5. 主流程 ─────────────────────────────────────────────────────────── */
const html = readIndex();
const state = collect(html);
if (state.fatal) { console.error("✗ " + state.fatal); process.exit(2); }

if (PATHS) { state.modules.forEach((m) => console.log(m.path)); process.exit(0); }

const block = renderBlock(state);

if (CHECK) {
  const existing = extractPageState(html);
  const problems = [];
  if (!existing.ok) problems.push(existing.why);
  else {
    const p = existing.state;
    if (p.build !== state.build) problems.push("build 不一致：页面 " + p.build + " ≠ 当前 " + state.build);
    if (p.ch !== state.ch) problems.push("指纹不一致：页面 " + p.ch + " ≠ 当前 " + state.ch);
    const want = JSON.parse(/window\.__BUILD=(\{[\s\S]*?\});/.exec(block)[1]);
    for (const k of Object.keys(want.sizes)) {
      if (!p.payload.sizes || p.payload.sizes[k] !== want.sizes[k]) {
        problems.push("体积不一致 " + k + "：页面 " + (p.payload.sizes || {})[k] + " ≠ 当前 " + want.sizes[k] + "K");
      }
    }
    /* 逐文件核对字节数：能指出到底是哪个模块变了（比只说"指纹不同"有用）*/
    for (const m of state.modules) {
      const had = p.payload.files ? p.payload.files[m.file] : undefined;
      if (had !== m.size) problems.push("文件已变 " + m.file + "：" + had + " → " + m.size + " 字节");
    }
    /* mtime 也要核：只碰过 mtime（内容没变）也该报——这正是"重新盖一次章"的信号。
       index.html 自己不在 mtimes 里（它的 mtime 就是盖章时间，见 renderBlock 注释） */
    for (const m of state.modules) {
      if (m.file === SELF) continue;
      const had = p.payload.mtimes ? p.payload.mtimes[m.file] : undefined;
      if (had !== undefined && had !== m.mtimeMs) {
        problems.push("mtime 已变 " + m.file + "：" + new Date(had).toISOString() + " → " + m.mtimeISO);
      }
    }
    if (p.payload.idxContentHash && p.payload.idxContentHash !== state.idxHash) {
      problems.push("index.html 内容哈希不一致（剔掉标记块后）：" + p.payload.idxContentHash + " → " + state.idxHash);
    }
    /* 结构性自检：块内文本是否与应有文案逐字一致 */
    const wantText = wmText(state);
    const gotText = /<div id="buildStamp"[\s\S]*?>([^<]*)<\/div>/.exec(html.slice(locate(html).start, locate(html).end));
    if (gotText && gotText[1] !== wantText) problems.push("水印文案与应有内容不一致：" + JSON.stringify(gotText[1]));
  }

  if (JSONOUT) {
    console.log(JSON.stringify({
      ok: problems.length === 0,
      page: existing.ok ? { build: existing.state.build, fingerprint: existing.state.ch } : null,
      current: { build: state.build, fingerprint: state.ch, sizesKB: state.sizesKB },
      problems: problems,
    }));
  } else if (problems.length) {
    console.error("✗ 版本戳过期（页面里的戳 ≠ 当前文件状态）：");
    problems.forEach((x) => console.error("   · " + x));
    console.error("   → 跑 `node tools/dev/stamp.js` 重新盖章；若浏览器里看到旧戳，Ctrl+Shift+R 强刷。");
  } else {
    say("✔ 版本戳一致 · build " + state.build + " · ch " + state.ch + " · " +
      "bf " + state.sizesKB.bf + "K / mj " + state.sizesKB.mj + "K / idx " + state.sizesKB.idx + "K / map " + state.sizesKB.map + "K");
  }
  process.exit(problems.length ? 1 : 0);
}

if (PRINT) { console.log(block); process.exit(0); }

const applied = applyBlock(html, block);
if (!applied.ok) { console.error("✗ 无法处理 index.html：" + applied.why); process.exit(1); }

const changed = applied.html !== html;
if (changed) {
  /* 写回：保持 UTF-8 无 BOM（原文件本就无 BOM），字节级写，避免换行被改写 */
  fs.writeFileSync(INDEX, Buffer.from(applied.html, "utf8"));
}
/* changed === false 时一个字节都不动（连 mtime 都不碰 —— 否则会污染下一次 build）*/

const lineNo = applied.html.slice(0, applied.html.indexOf(BEGIN)).split("\n").length;
const report = {
  ok: true,
  action: changed ? (applied.kind === "insert" ? "inserted" : "updated") : "unchanged",
  idempotent: !changed,
  blockAt: "index.html 第 " + lineNo + " 行",
  build: state.build,
  fingerprint: state.ch,
  sizesKB: state.sizesKB,
  newestFile: state.newestFile,
  tie: state.tie,
  text: wmText(state),
};

if (JSONOUT) console.log(JSON.stringify(report));
else {
  say("✔ 版本戳" + (changed
    ? "已写入 index.html：" + report.blockAt + "（" + (applied.kind === "insert" ? "首次插入" : "更新块内内容") + "）"
    : "已是最新：内容零改动，未写入任何字节（幂等）"));
  say("  水印文案：" + report.text);
  say("  build " + state.build + " · 内容指纹 " + state.ch + " · 最新改动 " + state.newestFile);
  if (state.tie) say("  ⚠ mtime 撞车（build 时间分辨不出谁最后改，指纹仍准确）：" + state.tie.join(" / "));
  say("  控制台自查：__BUILD.fingerprint / __BUILD.build / __BUILD.sizes");
  say("  打包前校验：node tools/dev/stamp.js --check");
}
process.exit(0);
