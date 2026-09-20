/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/sync_sections.js — 把 *_section.txt 与**已落盘的代码**重新对齐

   为什么需要：
     这些 *_section.txt 是 patch 的「源文本」，但一轮里常常有后续修正
     （本轮就有：url() 改名 sfxUrl、debug.audio().log/plays 是数组、cv 要在 start() 之后取、
       节流用例的相位修正……）。如果只改代码不回写源文本，下次有人重跑 builder 就会把老版本插回来。
     所以每轮收尾都跑一次这个脚本：从**当前文件**里把那一节原样切出来覆盖源文本。

   用法：node tools/bf/_patch/sync_sections.js
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const write = (f, s) => fs.writeFileSync(path.join(__dirname, f), s, "utf8");

/** 从 text 里切出 [startNeedle 所在行 .. endNeedle 所在行) 的整段（依赖唯一锚点）*/
function slice(text, startNeedle, endExclusiveNeedle, file) {
  const a = text.indexOf(startNeedle);
  if (a < 0) throw new Error(file + "：找不到起始锚 " + startNeedle);
  if (text.indexOf(startNeedle, a + 1) >= 0) throw new Error(file + "：起始锚不唯一 " + startNeedle);
  const a2 = text.lastIndexOf("\n", a) + 1;
  const b = text.indexOf(endExclusiveNeedle, a);
  if (b < 0) throw new Error(file + "：找不到结束锚 " + endExclusiveNeedle);
  return text.slice(a2, text.lastIndexOf("\n", b) + 1).replace(/\r\n/g, "\n");
}

/* ① breakfast.js 的音效章节（1b） → audio_section.txt */
{
  const src = read("breakfast.js");
  const sec = slice(src, "/* ═══════════ 1b. 音效 / 顾客语音", "  /* ═══════════════ 2. 运行时状态", "breakfast.js");
  write("audio_section.txt", sec);
  console.log("· audio_section.txt  ← breakfast.js 的 1b 节（" + sec.split("\n").length + " 行）");
}

/* ② tests/breakfast.test.cjs 的第 9 节 → tests_audio_section.txt
   ⚠ 这一节在文件**末尾**，所以切法是「从节首注释一直切到文件结尾」，与 ① 不同 */
{
  const src = read("tests/breakfast.test.cjs");
  const i = src.indexOf("/* ═══════════════════════════════════════════════════════════════════════════\r\n   9. 音效 / 顾客语音");
  const i2 = i >= 0 ? i : src.indexOf("   9. 音效 / 顾客语音（bf-audio-1）");
  if (i2 < 0) throw new Error("tests/breakfast.test.cjs：找不到第 9 节");
  const a = src.lastIndexOf("\n", i2) + 1;
  const sec = src.slice(a).replace(/\r\n/g, "\n");
  write("tests_audio_section.txt", sec);
  console.log("· tests_audio_section.txt ← tests/breakfast.test.cjs 末节（" + sec.split("\n").length + " 行）");
}

/* ③ tools/bf/headless.js 的 runAudio 一节 → headless_audio_section.txt */
{
  const src = read("tools/bf/headless.js");
  const i = src.indexOf("/* ══════════════ 音效 / 顾客语音（bf-audio-1）无头验收");
  if (i < 0) throw new Error("headless.js：找不到 runAudio 节首注释");
  const a = src.lastIndexOf("\n", i) + 1;
  const b = src.indexOf("runMain();", a);
  if (b < 0) throw new Error("headless.js：找不到 runMain();");
  const sec = src.slice(a, src.lastIndexOf("\n", b)).replace(/\r\n/g, "\n").replace(/\s*$/, "\n");
  write("headless_audio_section.txt", sec);
  console.log("· headless_audio_section.txt ← headless.js 的 runAudio 节（" + sec.split("\n").length + " 行）");
}
console.log("✔ 三份源文本已与落盘代码对齐");
