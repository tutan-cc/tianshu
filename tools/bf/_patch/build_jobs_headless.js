/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_headless.js — 生成「无头验收加音效一节」的 patch-literal 作业表

   做四件事（全部逐字字面，锚点从源文件切出来）：
     ① makeRecord 里加 audio / audioPauses / storage 三个记录桶
     ② 新增「记录式 Audio 替身」+「内存 localStorage 替身」两个工厂
     ③ boot() 里把 Audio / localStorage 注入 vm 上下文（并支持 audioBlock 模拟被拦）
     ④ 文件末尾追加 runAudio() 一节，并在 runMain() 之后调用

   用法：
     node tools/bf/_patch/build_jobs_headless.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_headless_audio.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/bf/headless.js";
const src = fs.readFileSync(path.join(ROOT, FILE), "utf8");
const EOL = src.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
const L = (...lines) => lines.join(EOL);

function countOcc(hay, needle) {
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function lineStart(s, i) { return s.lastIndexOf("\n", i) + 1; }
function lineEnd(s, i) {
  let k = s.indexOf("\n", i);
  if (k < 0) k = s.length;
  if (k > 0 && s[k - 1] === "\r") k--;
  return k;
}
function lineWith(needle) {
  const n = countOcc(src, needle);
  if (n !== 1) throw new Error("锚点不唯一（" + n + " 次）：" + needle);
  const i = src.indexOf(needle);
  return src.slice(lineStart(src, i), lineEnd(src, i));
}

const jobs = [];
const push = (from, text) => jobs.push({ file: FILE, from, text });

/* ① 记录桶 */
const J1 = lineWith("return { drawImage: [], imgLoads: [], imgErrors: [] };");
push(J1, L("  return { drawImage: [], imgLoads: [], imgErrors: [],",
  "           /* 音效验收用：new Audio / play() 的调用序列、被 pause 过的音频、内存 localStorage */",
  "           audio: [], audioPauses: [], storage: {} };"));

/* ② 两个替身工厂（插在固定随机种子那节之前）*/
const J2 = lineWith("/* ── 固定随机种子（可复现）");
push(J2, L(
  "/* ── 记录式 Audio 替身（音效验收用）──────────────────────────────────────",
  "   breakfast.js 的音效层是「有文件用文件，缺失静默回落」：没有 Audio / play() 被拦 / error 事件",
  "   → 都不许影响玩法。无头里就给一个**只记录不发声**的 Audio：",
  "     · 每次 new / play 都留痕（src + volume），断言直接看调用序列；",
  "     · audioBlock:true 时，play() 会**同步**触发 error 事件并返回一个同步 catch 的 thenable ——",
  "       这样「被浏览器策略拦 / 文件缺失」这条回落路径在同步的无头流程里也能断言到（不用等微任务）；",
  "     · pause() 也留痕：breakfast.js 声称「不打断正在播的其它语音」，这一条要能被证伪。 */",
  "function makeAudioCtor(record, opts) {",
  "  opts = opts || {};",
  "  return function Audio(src) {",
  "    const a = {",
  "      src: String(src || \"\"), volume: 1, currentTime: 0, paused: true, _h: {},",
  "      addEventListener(t, f) { (a._h[t] = a._h[t] || []).push(f); },",
  "      removeEventListener(t, f) { const h = a._h[t] || []; const i = h.indexOf(f); if (i >= 0) h.splice(i, 1); },",
  "      play() {",
  "        const rec = { src: a.src, volume: a.volume, blocked: !!opts.audioBlock };",
  "        record.audio.push(rec);",
  "        if (opts.audioBlock) {",
  "          (a._h.error || []).slice().forEach(f => f({ type: \"error\", target: a }));",
  "          return { catch(fn) { rec.blocked = true; try { fn(new Error(\"NotAllowedError: play() blocked\")); } catch (e) {} return this; } };",
  "        }",
  "        a.paused = false;",
  "        return { catch() { return this; } };",
  "      },",
  "      pause() { a.paused = true; record.audioPauses.push(a.src); },",
  "      load() {}, canPlayType() { return \"maybe\"; }",
  "    };",
  "    return a;",
  "  };",
  "}",
  "/** 内存 localStorage 替身：验「开关记在 localStorage.bfSoundOn 里」*/",
  "function makeLocalStorage(record) {",
  "  return {",
  "    getItem(k) { return Object.prototype.hasOwnProperty.call(record.storage, k) ? record.storage[k] : null; },",
  "    setItem(k, v) { record.storage[k] = String(v); },",
  "    removeItem(k) { delete record.storage[k]; },",
  "    clear() { record.storage = {}; }",
  "  };",
  "}",
  "") + J2);

/* ③ boot() 注入 */
const J3a = lineWith("const ImageCtor = makeImageCtor(record);");
push(J3a, J3a + EOL + "  const AudioCtor = makeAudioCtor(record, opts);        // 假 Audio（音效验收；opts.audioBlock 可模拟被拦）");

const J3b = lineWith("    Image: ImageCtor,");
push(J3b, L(J3b,
  "    Audio: AudioCtor,                                  // breakfast.js 的音效层会 new Audio(url)",
  "    localStorage: makeLocalStorage(record),            // 音效开关键（bfSoundOn）落在这里"));

/* ④ 顶部 require + 末尾追加并调用 */
const J4 = lineWith('const { resultsFile } = require("../lib/dist.js");');
push(J4, J4 + EOL + 'const mp3 = require("./mp3info.js");                  // 只读 MP3 头量时长（不依赖 ffmpeg）');

const runAudio = fs.readFileSync(path.join(__dirname, "headless_audio_section.txt"), "utf8")
  .replace(/\r\n/g, "\n").replace(/\s*$/, "\n").replace(/\n/g, EOL);
const J5 = lineWith("runMain();");
push(J5, runAudio + EOL + "runMain();" + EOL + "runAudio();          // 音效 / 顾客语音（bf-audio-1）");

const out = path.join(__dirname, "jobs_headless_audio.json");
fs.writeFileSync(out, JSON.stringify({
  note: "无头验收新增音效一节：假 Audio 记录调用序列 + 素材规格 + 回落 + 开关",
  eol: EOL === "\r\n" ? "CRLF" : "LF",
  jobs
}, null, 1), "utf8");
console.log("作业表：" + out + "（" + jobs.length + " 个 job · EOL=" + (EOL === "\r\n" ? "CRLF" : "LF") + "）");
jobs.forEach((j, i) => console.log("  job#" + (i + 1) + " +" + j.text.length + " 字符  锚：" + JSON.stringify(j.from.slice(0, 52))));
