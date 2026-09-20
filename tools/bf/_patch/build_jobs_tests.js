/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_tests.js — 生成「音效单测」追加作业

   用途：把 tools/bf/_patch/tests_audio_section.txt 追加到 tests/breakfast.test.cjs 末尾。
   锚点从目标文件里**按行切出来**（避免手抄中文/装饰字符出错），追加文本按目标文件 EOL 生成。

   用法：
     node tools/bf/_patch/build_jobs_tests.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_tests_audio.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", "..");
const FILE = "tests/breakfast.test.cjs";
const src = fs.readFileSync(path.join(ROOT, FILE), "utf8");
const EOL = src.indexOf("\r\n") >= 0 ? "\r\n" : "\n";

const NEEDLE = "[skip] art/lovart_cca01cd7ba70.png 不在库";
const n = src.split(NEEDLE).length - 1;
if (n !== 1) throw new Error("锚点不唯一（" + n + " 次）：" + NEEDLE);
const at = src.indexOf(NEEDLE);
const ls = src.lastIndexOf("\n", at) + 1;
let le = src.indexOf("\n", at);
if (le < 0) le = src.length;
if (le > 0 && src[le - 1] === "\r") le--;
const anchorLine = src.slice(ls, le);            // 该行原文（含结尾 console.log(...)）
const tail = src.slice(le);                      // 该行之后的一切（闭合的 } 与 }); 及文件末尾空行）
/* ⚠ 追加到**文件末尾**的正确写法：
     patch-literal 的语义是「只把 from 这一段换成 text，锚点之后的内容原样保留」，
     所以要追加到末尾，from 必须一直吃到**文件结尾**（from = 唯一行 + 其后全部内容），
     text = 同一段 + 新章节。
   两个踩过的坑：
     · 只把 console.log 那一行当锚点 → 新章节会插进 `} else { ... }` 里面（上一版就是这么翻车的）；
     · text 里再拼一份 tail → 文件末尾会多出一份 } / }); 的副本（语法直接不过）。
   唯一性没问题：from 以那一行唯一的 console.log 开头，整段自然唯一。 */
const section = fs.readFileSync(path.join(__dirname, "tests_audio_section.txt"), "utf8")
  .replace(/\r\n/g, "\n").replace(/\s*$/, "\n");
const from = (anchorLine + tail).replace(/\s*$/, "");
const text = from + EOL + EOL + section.replace(/\n/g, EOL);

const out = path.join(__dirname, "jobs_tests_audio.json");
fs.writeFileSync(out, JSON.stringify({
  note: "新增「9. 音效 / 顾客语音」用例（bf-audio-1）—— 追加到 tests/breakfast.test.cjs 末尾",
  eol: EOL === "\r\n" ? "CRLF" : "LF",
  jobs: [{ file: FILE, from: from, text: text }]
}, null, 1), "utf8");
console.log("作业表：" + out + " · 追加 " + section.split("\n").length + " 行 · EOL=" + (EOL === "\r\n" ? "CRLF" : "LF"));
console.log("锚（唯一行 + 其后到文件末尾，共 " + from.split("\n").length + " 行）：" +
  JSON.stringify(from.slice(0, 60)) + " … " + JSON.stringify(from.slice(-24)));
