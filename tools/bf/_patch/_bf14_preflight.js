/* ═══════════════════════════════════════════════════════════════════════════
   _bf14_preflight.js — 落盘前把所有 job 的锚点在**当前磁盘文件**上验一遍
   （复刻 patch-literal.js 的换行归一与唯一性规则，但一次把全部不匹配的行打出来）
   用法：node tools/bf/_patch/_bf14_preflight.js [jobs.json] [baseFile]
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const jobFile = process.argv[2] || "tools/bf/_patch/jobs_bf14.json";
const baseFile = process.argv[3] || null;
const spec = JSON.parse(fs.readFileSync(path.join(OUT, jobFile), "utf8"));

function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function normEol(t, eol) { return String(t).replace(/\r\n|\r|\n/g, "\n").split("\n").join(eol); }
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

const files = new Map();
for (const j of spec.jobs) if (!files.has(j.file)) files.set(j.file, fs.readFileSync(path.join(OUT, baseFile || j.file), "utf8"));
let bad = 0, n = 0;
for (const j of spec.jobs) {
  n++;
  const cur = files.get(j.file);
  const fa = findAnchor(cur, j.from);
  let msg = "";
  if (fa.hits !== 1) msg += "起始锚命中 " + fa.hits + " 次";
  let endIdx = -1;
  if (fa.hits === 1) {
    const a = cur.indexOf(fa.s);
    endIdx = a + fa.s.length;
    if (j.to) {
      const ft = findAnchor(cur, j.to);
      if (ft.hits !== 1) msg += (msg ? " / " : "") + "结束锚命中 " + ft.hits + " 次";
      else {
        const b = cur.indexOf(ft.s);
        if (b < a) msg += (msg ? " / " : "") + "结束锚在起始锚之前";
        else endIdx = b + ft.s.length;
      }
    }
  }
  const label = "job#" + n + " " + j.file + " · " + path.basename(j.textFile || "");
  if (msg) {
    bad++;
    console.log("✗ " + label + " → " + msg);
    /* 逐行 diff：找出锚里第一处与文件不一致的行（定位真正的错字）*/
    if (fa.hits === 0) {
      const src = cur.replace(/\r\n/g, "\n").split("\n");
      const a = fa.s.replace(/\r\n/g, "\n").split("\n");
      let at = src.findIndex(l => l === a[0]);
      if (at < 0) {
        const probe = a[0].trim().slice(0, 24);
        at = src.findIndex(l => l.indexOf(probe) >= 0);
        console.log("   首行不匹配；按内容找到最近的行 idx=" + at + " → " + JSON.stringify((src[at] || "").slice(0, 70)));
        if (at < 0) continue;
      }
      for (let i = 0; i < a.length; i++) {
        if (src[at + i] !== a[i]) {
          console.log("   第 +" + i + " 行不一致：");
          console.log("     文件：" + JSON.stringify(src[at + i] === undefined ? "<EOF>" : src[at + i]));
          console.log("     锚　：" + JSON.stringify(a[i]));
          break;
        }
      }
    }
  } else {
    const removed = cur.slice(cur.indexOf(fa.s), endIdx);
    console.log("✓ " + label + " → 删 " + removed.split("\n").length + " 行 / 插 " +
      fs.readFileSync(path.join(OUT, j.textFile), "utf8").split("\n").length + " 行");
  }
}
console.log((bad ? "✗ " : "✔ ") + (n - bad) + "/" + n + " 个锚点可用" + (baseFile ? "（基准：" + baseFile + "）" : ""));
process.exit(bad ? 1 : 0);
