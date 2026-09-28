/* bf-13 一次性工具：预检 jobs 锚点命中数（与 patch-literal.js 同一套 findAnchor 逻辑）。
   用法：node tools/bf/_patch/_bf13_preflight.js [jobs.json]
   不做任何替换，只报告 —— 锚点缩进/换行是本轮唯一踩过的坑。 */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");

function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function normEol(text, eol) { return String(text).replace(/\r\n|\r|\n/g, "\n").split("\n").join(eol); }
function findAnchor(cur, raw) {
  const cands = [];
  for (const eol of ["\r\n", "\n"]) {
    const s = normEol(raw, eol);
    if (!cands.some(c => c.s === s)) cands.push({ s: s, eol: eol });
  }
  const out = cands.map(c => ({ s: c.s, eol: c.eol, hits: countOcc(cur, c.s) }));
  const one = out.filter(o => o.hits === 1);
  return one.length ? one[0] : out[0];
}

const jobsRel = process.argv[2] || "tools/bf/_patch/jobs_bf13.json";
const spec = JSON.parse(fs.readFileSync(path.join(OUT, jobsRel), "utf8"));
const files = {};
let bad = 0;
for (let i = 0; i < spec.jobs.length; i++) {
  const job = spec.jobs[i];
  if (!files[job.file]) files[job.file] = fs.readFileSync(path.join(OUT, job.file), "utf8");
  const cur = files[job.file];
  const fa = findAnchor(cur, job.from);
  let msg = "job#" + (i + 1) + " from hits=" + fa.hits;
  let ok = fa.hits === 1;
  if (job.to) {
    const ft = findAnchor(cur, job.to);
    const a = cur.indexOf(fa.s), b = cur.indexOf(ft.s);
    msg += " · to hits=" + ft.hits + " · 顺序=" + (b >= a ? "OK" : "倒置");
    if (ft.hits !== 1 || b < a) ok = false;
  }
  if (!ok) bad++;
  console.log((ok ? "  ✔ " : "  ✘ ") + msg + "  ｜ " + JSON.stringify(String(fa.s).slice(0, 34)));
}
console.log(bad ? ("✘ " + bad + " 个 job 的锚点不合格") : "✔ 全部 " + spec.jobs.length + " 个 job 锚点唯一且顺序正确");
process.exit(bad ? 1 : 0);
