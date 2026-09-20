/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_hta_unicode.js — 探针结果文件改写成 Unicode(UTF-16LE)

   现象：模式 B 跑通之后，控制台里的中文全是乱码：
       ✔ breakfast.js �� Trident ������سɹ�
   原因：HTA 里 `fso.CreateTextFile(name, true)` 默认按**系统 ANSI(GBK)** 写，
       而 Node 侧按 UTF-8 读 → 中文全花。
   修法：两边一起改 ——
     · HTA：`CreateTextFile(DIR+name, true, true)`（第三个参数 = Unicode/UTF-16LE）
     · Node：`readFileSync(f, "utf16le")`，并去掉可能的前导 BOM（\ufeff）
   影响面：_bf_trident_out.txt（结果 JSON）与 _bf_trident_b64.txt（截图 base64）两个都要改，
   否则截图那条会读成乱码。

   用法：
     node tools/bf/_patch/build_jobs_bf9_hta_unicode.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_hta_unicode.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/e2e/bf.js";
const jobs = [];
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function J(from, text) { jobs.push({ file: FILE, from, to: null, text }); }

/* ① HTA 写文件改成 Unicode */
J(String.raw`function w(name, txt){ var f=fso.CreateTextFile(DIR+name, true); f.Write(txt); f.Close(); }`,
String.raw`/* 第三个参数 true = Unicode(UTF-16LE)：默认的 ANSI 写出来 Node 按 UTF-8 读会全是乱码 */
function w(name, txt){ var f=fso.CreateTextFile(DIR+name, true, true); f.Write(txt); f.Close(); }`);

/* ② Node 读结果 JSON 用 utf16le + 去 BOM */
J(String.raw`      const raw = fs.readFileSync(f, "utf8");
      if (raw.trim().endsWith("}") && raw.indexOf('"checks"') >= 0) { try { out = JSON.parse(raw); break; } catch (e) {} }`,
String.raw`      const raw = fs.readFileSync(f, "utf16le").replace(/^\ufeff/, "");   // HTA 侧写的是 UTF-16LE
      if (raw.trim().endsWith("}") && raw.indexOf('"checks"') >= 0) { try { out = JSON.parse(raw); break; } catch (e) {} }`);

/* ③ Node 读截图 base64 也用 utf16le（trim 会顺手去掉 BOM）*/
J(String.raw`    const b = fs.readFileSync(b64f, "utf8").trim();`,
  String.raw`    const b = fs.readFileSync(b64f, "utf16le").trim();    // 同上：UTF-16LE，trim 去掉 BOM`);

const src = fs.readFileSync(path.join(OUT, FILE), "utf8");
jobs.forEach((job, i) => {
  if (countOcc(src, job.from) === 1) return;
  const c = crlf(job.from), ct = crlf(job.text);
  if (countOcc(src, c) === 1) { job.from = c; job.text = ct; return; }
  console.error("✗ job#" + (i + 1) + " 锚点出现 " + countOcc(src, job.from) + " 次（CRLF 版 " +
    countOcc(src, c) + " 次）：" + JSON.stringify(job.from.slice(0, 80)));
  process.exit(1);
});
fs.writeFileSync(path.join(__dirname, "jobs_bf9_hta_unicode.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_hta_unicode.json：" + jobs.length + " 个 job");
