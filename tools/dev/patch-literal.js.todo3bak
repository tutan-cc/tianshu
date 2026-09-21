/* ═══════════════════════════════════════════════════════════════════════════
   tools/dev/patch-literal.js — 逐字字面替换器（严格校验 · 自动备份 · 语法检查 · 失败回滚）

   为什么要这个：本轮要改 breakfast.js / index.html 这种大文件，纪律要求
   「只许逐字字面替换，不许模糊正则、不许按锚点相对切片」。手工替换两次翻车，
   所以把纪律写成工具，每次改动都过一遍这四道闸：

     ① 唯一性：from（起始锚）与 to（结束锚）在全文中必须**恰好出现 1 次**
        —— 出现 0 次（写错字）或 ≥2 次（锚太短）都直接中止，绝不猜；
     ② 幂等：替换文本不得已经在文件里（防止同一份 job 跑两遍悄悄插两份）；
     ③ 备份：第一次写之前把原文件复制成 <file>.bf8bak（已存在则不动 → 永远是改前的那份）；
     ④ 语法闸：写完对 .js/.cjs 跑 node --check；对 .html 抽出每个内联 <script>
        块单独 node --check。任何一条不过 → 立刻用备份整文件回滚并报错退出。

   用法：
     node tools/dev/patch-literal.js jobs.json
   jobs.json：
     { "jobs": [
         { "file":"breakfast.js", "from":"<起始锚>", "to":"<结束锚>", "textFile":"_new_a.txt" },
         { "file":"breakfast.js", "from":"<唯一片段>",                    "text":"<替换成>" }
     ] }
     · from+to  : 把 [from .. to]（含两端）整段换成 text/textFile 内容
     · 只有 from: 把 from 这一段（必须唯一）换成 text/textFile（等同精确 replace）
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm");
const { execFileSync } = require("child_process");

const OUT = path.join(__dirname, "..", "..");
const BAK = ".bf8bak";

function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}

/* 换行归一（bf-10 踩过的坑）：
   本仓的文件是**换行混排**的 —— 同一个文件里既有 CRLF 也有历史裸 LF 行
   （实测 headless.js 整段 1426–1432 是裸 LF、其余是 CRLF；breakfast.test.cjs 也是混的）。
   jobs.json 里手写锚根本猜不准某一行是哪种，猜错就报「起始锚出现 0 次」，
   而错的是一个看不见的字符，非常难查（本轮为此翻车两次）。
   所以这里不再让写 job 的人去猜：把锚渲染成**两种风格各试一次**，
   哪种在该文件里恰好命中 1 次就用哪种；替换文本跟着用同一种风格。
   这样纯 CRLF / 纯 LF / 混排三种文件都能直接写锚。 */
function majorEol(text) {
  const crlf = countOcc(text, "\r\n");
  const lf = countOcc(text, "\n") - crlf;
  return crlf >= lf ? "\r\n" : "\n";
}
function normEol(text, eol) {
  return String(text).replace(/\r\n|\r|\n/g, "\n").split("\n").join(eol);
}
/** 在 cur 里找锚：CRLF 版 / LF 版各试一次 → {at, len, eol, hits} */
function findAnchor(cur, raw) {
  const cands = [];
  for (const eol of ["\r\n", "\n"]) {
    const s = normEol(raw, eol);
    if (!cands.some(c => c.s === s)) cands.push({ s: s, eol: eol });
  }
  const out = cands.map(c => ({ s: c.s, eol: c.eol, hits: countOcc(cur, c.s) }));
  const one = out.filter(o => o.hits === 1);
  if (one.length) return one[0];
  return out[0];        // 都不唯一 → 交回调用方报错（消息里带命中数）
}
/* 语法闸：用 vm.Script 在**本进程内**编译（等价 node --check，但不需要再起子进程 ——
   本沙箱里 node 子进程用管道捕获输出会 EPERM，所以不做 spawn）。 */
function checkJs(file) {
  try { new vm.Script(fs.readFileSync(file, "utf8"), { filename: file }); return ""; }
  catch (e) { return String(e.stack || e.message).split("\n").slice(0, 5).join(" ▸ "); }
}
/** 抽取 html 里的内联 <script> 块（不含 src= 的）逐个做语法检查 */
function checkHtml(file) {
  const html = fs.readFileSync(file, "utf8");
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, i = 0, bad = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bfpatch"));
  while ((m = re.exec(html))) {
    i++;
    const f = path.join(tmpDir, "inline" + i + ".js");
    fs.writeFileSync(f, m[1]);
    const err = checkJs(f);
    if (err) bad.push("内联脚本#" + i + "（" + m[1].length + " 字符）：" + err);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { n: i, err: bad.join(" ;; ") };
}

const jobFile = process.argv[2];
if (!jobFile) { console.error("用法：node tools/dev/patch-literal.js jobs.json [--fresh-bak]"); process.exit(2); }
const FRESH = process.argv.indexOf("--fresh-bak") >= 0;
const spec = JSON.parse(fs.readFileSync(path.resolve(OUT, jobFile), "utf8"));

/* 先把所有 job 在内存里跑一遍（全部通过才落盘 —— 避免"改了一半"的中间态）*/
const plan = new Map();                       // file → {orig, next, touched}
let step = 0;
for (const job of spec.jobs) {
  step++;
  const file = path.resolve(OUT, job.file);
  if (!plan.has(file)) plan.set(file, { orig: fs.readFileSync(file, "utf8"), next: null, file: file });
  const e = plan.get(file);
  const cur = e.next === null ? e.orig : e.next;
  const rawText = job.textFile ? fs.readFileSync(path.resolve(OUT, job.textFile), "utf8") : (job.text || "");
  /* 锚：先定换行风格（两种都试，命中 1 次的那个为准）*/
  const fa = findAnchor(cur, job.from);
  if (fa.hits !== 1) {
    console.error("✗ job#" + step + "（" + job.file + "）：起始锚出现 " + fa.hits + " 次（必须恰好 1 次）");
    console.error("  锚首 60 字：" + JSON.stringify(String(fa.s).slice(0, 60)));
    process.exit(1);
  }
  const text = normEol(rawText, fa.eol);
  const from = fa.s;
  const a = cur.indexOf(from);
  let end = a + from.length;
  if (job.to) {
    const ft = findAnchor(cur, job.to);
    if (ft.hits !== 1) {
      console.error("✗ job#" + step + "（" + job.file + "）：结束锚出现 " + ft.hits + " 次（必须恰好 1 次）");
      console.error("  锚首 60 字：" + JSON.stringify(String(ft.s).slice(0, 60)));
      process.exit(1);
    }
    const b = cur.indexOf(ft.s);
    if (b < a) { console.error("✗ job#" + step + "（" + job.file + "）：结束锚在起始锚之前"); process.exit(1); }
    end = b + ft.s.length;
  }
  if (countOcc(cur, text) > 0 && text.length > 40) {
    console.error("✗ job#" + step + "（" + job.file + "）：替换文本已经在文件里了（幂等保护，拒绝重复插入）");
    process.exit(1);
  }
  const next = cur.slice(0, a) + text + cur.slice(end);
  if (next === cur) { console.error("✗ job#" + step + "（" + job.file + "）：替换前后完全一样"); process.exit(1); }
  e.next = next;
  const removed = cur.slice(a, end);
  console.log("· job#" + step + " " + job.file + "：删 " + removed.split("\n").length + " 行 / " + removed.length +
    " 字符 → 插 " + text.split("\n").length + " 行 / " + text.length + " 字符");
}

/* 落盘（先备份；--fresh-bak 时把旧备份删掉，让备份 = 上一版好状态）*/
const written = [];
for (const [file, e] of plan) {
  const bak = file + BAK;
  if (FRESH && fs.existsSync(bak)) fs.rmSync(bak);
  if (!fs.existsSync(bak)) { fs.copyFileSync(file, bak); console.log("· 备份 → " + path.basename(bak)); }
  fs.writeFileSync(file, e.next);
  written.push(file);
}

/* 语法闸：不过就整文件回滚 */
let failed = false;
for (const file of written) {
  if (/\.(js|cjs)$/i.test(file)) {
    const err = checkJs(file);
    if (err) { console.error("✗ 语法检查失败：" + path.basename(file) + " → " + err); failed = true; }
    else console.log("· node --check " + path.basename(file) + " ✓");
  } else if (/\.html?$/i.test(file)) {
    const r = checkHtml(file);
    if (r.err) { console.error("✗ 内联脚本语法失败：" + path.basename(file) + " → " + r.err); failed = true; }
    else console.log("· index.html 内联脚本 " + r.n + " 块 node --check ✓");
  }
}
if (failed) {
  for (const file of written) {
    fs.copyFileSync(file, file + ".bfbroken");
    fs.copyFileSync(file + BAK, file);
    console.error("↩ 已回滚：" + path.basename(file) + "（坏版本留在 " + path.basename(file) + ".bfbroken 供定位）");
  }
  process.exit(1);
}
console.log("✔ " + spec.jobs.length + " 个 job 全部落盘并通过语法闸");
