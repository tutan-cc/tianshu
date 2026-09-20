#!/usr/bin/env node
/*
  tests/audio-paths.test.cjs — 音频素材路径解析单测（P-1 回归闸）

  为什么必须单独一个测试（这是本轮踩过的最贵的坑）：
    AudioSys 全层是「有文件用文件、缺失回落合成」。这条兜底是对的，
    但它让"素材缺失"和"素材接错"在断言层面**完全无法区分**。
    v1.24 基线实测：audio/sfx/ 里 54 条带 `sfx-` 前缀（sfx-fight-hit.mp3），
    11 条 UI 音效不带前缀（ui-click.mp3）；而代码只拼 `audio/sfx/<name>.mp3` →
    那 54 条永远取不到。环境音同理：素材叫 amb-alley.mp3，代码拼 audio/amb/alley.mp3 → 9/9 全丢。

    而且 sfxFile() 原先**无条件 return true**，pool 又缓存了坏元素 →
    连"回落 beep"都没发生，是彻底没声音，且不报错、不抛异常。

    已有的 tools/e2e/audio-wiring.js 没能拦住它：那个脚本只从**磁盘**读文件名、
    逐个 probe 素材本身，从来没驱动过 AudioSys 的路径构造函数 ——
    于是"素材全绿、代码全错"。本测试补的就是「素材 ↔ 代码」之间那道缝。

  做法：**把真实的 AudioSys 对象从 index.html 里抽出来，用 FakeAudio 驱动**。
    不是复刻一份实现来测（那种测试测的是副本，不是出货代码）。
    抽取方式与 tools/dev/check-inline.js 同源：读 index.html → 取内联脚本 → 在 vm 沙箱里求值。
    FakeAudio 按**真实磁盘**回答：文件不存在 → 异步 error；存在 → 异步 canplaythrough。
    于是 AudioSys 的三态机（pending / ready / bad）被真实地跑了一遍。

  用法：node tests/audio-paths.test.cjs
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const HTML = path.join(ROOT, "index.html");
const MANIFEST = path.join(ROOT, "媒体清单.json");

let pass = 0;
const fails = [];
function A(ok, name, detail) {
  const line = name + (detail === undefined ? "" : "  [" + detail + "]");
  if (ok) { pass++; console.log("  ✔ " + line); } else { fails.push(line); console.log("  ✖ " + line); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 等 FakeAudio 的异步探测落定。
   ⚠ 别把这个值压到 30ms —— 探测回调是 setTimeout 排的队，机器一忙（比如同时在跑
     麻将那 978 项）就可能排在 30ms 之后，于是"ready"断言偶发失败。
     实测就是这个原因，单独跑 20/20、接在大套件后面跑变成 18/20。给足余量。 */
const SETTLE = 120;

/* ── 括号配对抽取（跳过字符串与注释，避免误配） ── */
function grab(src, openIdx) {
  const open = src[openIdx], close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  throw new Error("括号未闭合（内联脚本里 AudioSys 的字面量跨出了预期范围）");
}

/* ── 抽取真实的 AudioSys ──
   注意：AudioSys 在被抽取的这个 vm 沙箱里求值，所以它方法体里的 `Audio`
   查的是**沙箱自己的全局** —— 换 FakeAudio 必须换沙箱里那个，不是 Node 的 globalThis。 */
const sandbox = {
  requestAnimationFrame: (fn) => setTimeout(fn, 16),
  setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, console,
  Audio: function () { throw new Error("FakeAudio 尚未注入"); },
};
let AudioSys = null, extractErr = "";
try {
  const html = fs.readFileSync(HTML, "utf8");
  const m = /const\s+AudioSys\s*=\s*\{/.exec(html);
  if (!m) throw new Error("index.html 里找不到 `const AudioSys = {`");
  AudioSys = new vm.Script("(" + grab(html, html.indexOf("{", m.index)) + ")").runInNewContext(sandbox);
} catch (e) { extractErr = e.message; }

A(!!AudioSys && typeof AudioSys.sfxFile === "function" && typeof AudioSys.amb === "function",
  "能从 index.html 抽出真实的 AudioSys（含 sfxFile / amb / bgm）",
  extractErr || ("方法数 " + (AudioSys ? Object.keys(AudioSys).length : 0)));

if (!AudioSys) {
  console.log("\n[结果] 通过 " + pass + "，失败 " + fails.length + " —— 抽取失败，后续断言跳过");
  process.exit(1);
}

/* FakeAudio 在**沙箱内**求值，才能被 AudioSys 看到 */
class FakeAudio {
  constructor(src) {
    this.src = String(src); this.volume = 1; this.paused = true; this.ended = false;
    this.currentTime = 0; this.duration = 12; this.loop = false; this.preload = "";
    this.oncanplaythrough = null; this.onerror = null; this.onloadedmetadata = null;
    this._exists = fs.existsSync(path.join(ROOT, this.src.split("#")[0]));
    CALLS.constructed.push(this.src);
  }
  load() {
    setTimeout(() => {
      if (this._exists) { if (this.onloadedmetadata) this.onloadedmetadata(); if (this.oncanplaythrough) this.oncanplaythrough(); }
      else { CALLS.errors.push(this.src); if (this.onerror) this.onerror(); }
    }, 1);
  }
  play() { this.paused = false; CALLS.played.push(this.src); return Promise.resolve(); }
  pause() { this.paused = true; }
  cloneNode() { return new FakeAudio(this.src); }
}
const CALLS = { constructed: [], played: [], errors: [] };
sandbox.Audio = FakeAudio;

/* bgm() 开头有 `if(!this.ctx) return` 的守卫 —— 不给 ctx 的话它直接返回，测不到东西 */
const CTX_STUB = {
  currentTime: 0, destination: {},
  createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: {} }),
  createGain: () => ({ connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } }),
  createBiquadFilter: () => ({ connect() {}, frequency: {} }),
};

function resetAudioSys() {
  AudioSys.pool = {}; AudioSys.mediaState = {}; AudioSys.mediaResolved = {};
  AudioSys.ambName = null; AudioSys.ambStack = null; AudioSys.ambEl = null;
  AudioSys.curMood = null; AudioSys.bgmEl = null; AudioSys.bgmTimer = null;
  AudioSys.ctx = CTX_STUB;
  AudioSys.master = { connect() {} };
  AudioSys.on = true;
  CALLS.constructed.length = 0; CALLS.played.length = 0; CALLS.errors.length = 0;
}

(async () => {
  /* ── 1. 候选列表构造（纯函数，先把这层锁死） ── */
  A(AudioSys.mediaName("audio/sfx/sfx-fight-hit.mp3") === "sfx-fight-hit",
    "mediaName：取文件名、去扩展名", AudioSys.mediaName("audio/sfx/sfx-fight-hit.mp3"));

  const c1 = AudioSys.mediaCandidates("audio/sfx/ui-click.mp3", "sfx-");
  A(c1.length === 2 && c1[0] === "audio/sfx/ui-click.mp3" && c1[1] === "audio/sfx/sfx-ui-click.mp3",
    "无前缀音效 → 原名 + sfx- 变体两个候选", JSON.stringify(c1));

  const c2 = AudioSys.mediaCandidates("audio/sfx/sfx-mj-clack.mp3", "sfx-");
  A(c2.length === 1 && c2[0] === "audio/sfx/sfx-mj-clack.mp3",
    "已带 sfx- 前缀 → 不重复加（否则造出 sfx-sfx-）", JSON.stringify(c2));

  const c3 = AudioSys.mediaCandidates("audio/amb/alley.mp3", "amb-");
  A(c3.length === 2 && c3[1] === "audio/amb/amb-alley.mp3",
    "环境音 → 原名 + amb- 变体", JSON.stringify(c3));

  const c4 = AudioSys.mediaCandidates("audio/bgm/tense.mp3", "sfx-");
  A(c4.length === 2 && c4[0] === "audio/bgm/tense.mp3",
    "BGM → 原名仍排在候选第一位（素材无前缀，不能被变体挤后）", JSON.stringify(c4));

  /* ── 2. sfxFile 三态机（真实代码 + 真实磁盘） ── */
  resetAudioSys();
  const r1 = AudioSys.sfxFile("ui-click");
  /* 首次调用（探测在途）刻意返回 true，与"缺失才回落"并不矛盾：
       pending = 文件即将可用，此刻回落会**多响一声 beep**（探测通常几十毫秒完成）；
       bad     = 真缺失，那时返回 false，让 `if(!sfxFile()) blip()` 接手。
     而 v1.24 的病根是它**永远**返回 true —— 连 bad 也返回 true。
     所以本测试真正要锁死的是下面「缺失音效返回 false」那一条。 */
  A(r1 === true, "sfxFile 首次调用（探测在途）返回 true —— 不回落，避免多响一声 beep", "returned " + r1);
  await sleep(SETTLE);
  A(AudioSys.mediaState["ui-click"] === "ready" && AudioSys.mediaResolved["ui-click"] === "audio/sfx/ui-click.mp3",
    "ui-click 探测完成 → ready，解析到无前缀原名",
    AudioSys.mediaState["ui-click"] + " @ " + AudioSys.mediaResolved["ui-click"]);

  /* ── 2 续：就绪后必须返回 true 并真的播了 ── */
  const r2 = AudioSys.sfxFile("ui-click");
  A(r2 === true, "就绪后 sfxFile 返回 true", "returned " + r2);
  A(CALLS.played.indexOf("audio/sfx/ui-click.mp3") >= 0,
    "确实对真实文件调用了 play()", "played=" + JSON.stringify(CALLS.played));

  /* ── 3. 带 sfx- 前缀的音效：v1.24 完全取不到的那 54 条 ── */
  AudioSys.sfxFile("sfx-fight-hit"); await sleep(SETTLE);
  A(AudioSys.mediaResolved["sfx-fight-hit"] === "audio/sfx/sfx-fight-hit.mp3",
    "sfx-fight-hit（打斗命中）解析成功 ← v1.24 死在这条",
    AudioSys.mediaState["sfx-fight-hit"] + " @ " + AudioSys.mediaResolved["sfx-fight-hit"]);

  AudioSys.sfxFile("sfx-mj-clack"); await sleep(SETTLE);
  A(AudioSys.mediaResolved["sfx-mj-clack"] === "audio/sfx/sfx-mj-clack.mp3",
    "sfx-mj-clack（麻将暗杠）解析成功 ← v1.24 静音那条",
    AudioSys.mediaState["sfx-mj-clack"] + " @ " + AudioSys.mediaResolved["sfx-mj-clack"]);

  /* ── 4. 缺失音效必须被判定为 bad 且返回 false（兜底才真正生效） ── */
  AudioSys.sfxFile("no-such-sfx-xyzzy"); await sleep(SETTLE);
  A(AudioSys.mediaState["no-such-sfx-xyzzy"] === "bad",
    "不存在的音效判定为 bad（不会永远停在 pending）", AudioSys.mediaState["no-such-sfx-xyzzy"]);
  A(AudioSys.sfxFile("no-such-sfx-xyzzy") === false,
    "缺失音效返回 false → `if(!sfxFile()) blip()` 兜底重新可用");

  /* ── 5. 环境音候选回落 ── */
  resetAudioSys();
  AudioSys.amb("alley"); await sleep(SETTLE);
  A(AudioSys.ambStack && AudioSys.ambStack.url === "audio/amb/amb-alley.mp3",
    "amb('alley') 回落到 amb-alley.mp3 ← v1.24 九个地点全丢",
    (AudioSys.ambStack ? AudioSys.ambStack.url : "无") +
    " | 候选 " + JSON.stringify(CALLS.constructed.filter((s) => s.indexOf("/amb/") >= 0)));

  /* ── 6. BGM 走原名 ── */
  resetAudioSys();
  AudioSys.bgm("tense"); await sleep(SETTLE);
  A(!!AudioSys.bgmEl && AudioSys.bgmEl.src === "audio/bgm/tense.mp3",
    "bgm('tense') 用原名 tense.mp3 起播", AudioSys.bgmEl ? AudioSys.bgmEl.src : "无 bgmEl");

  /* ── 7/8. 素材清单自审：存在性 + 全量"代码可达性" ── */
  let mani = null;
  try { mani = JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch (e) { }
  if (!mani || !Array.isArray(mani.files)) {
    A(false, "媒体清单.json 可解析且含 files 数组");
  } else {
    const audio = mani.files.filter((f) => /^audio\//.test(f.path));
    const miss = audio.filter((f) => !fs.existsSync(path.join(ROOT, f.path.split("#")[0])));

    /* ⚠ 已知且**与本次改动无关**的清单过期：麻将 7 张字牌的报牌语音在"改字牌念法"那轮
       从 `东.mp3 / 发.mp3 / 白.mp3 …` 改名成了 `东风.mp3 / 发财.mp3 / 白板.mp3 …`（见 mahjong.js 的说明），
       但 媒体清单.json 里 seat0~seat3 四份登记仍是旧名 → 7×4 = 28 条对不上。
       磁盘上文件是齐的（每座位 43 个），**运行时不受影响**（voiceUrl 走新名）。
       这里精确断言"缺失项恰好就是这 28 条旧字牌名"，一旦哪天多了别的缺失就会红。 */
    const STALE = ["东", "南", "西", "北", "发", "白", "中"].map((n) => "/" + n + ".mp3");
    const staleMiss = miss.filter((f) => STALE.some((s) => f.path.endsWith(s)));
    const otherMiss = miss.filter((f) => !STALE.some((s) => f.path.endsWith(s)));
    A(otherMiss.length === 0,
      "清单登记的 " + audio.length + " 个音频文件真实存在（除 28 条已知过期的字牌旧名）",
      otherMiss.length ? "缺 " + otherMiss.length + "：" + otherMiss.slice(0, 5).map((f) => f.path).join(", ")
                       : "仅 " + staleMiss.length + " 条字牌旧名过期（磁盘文件齐）");

    // 磁盘侧必须有对应新名的文件 —— 证明"清单过期"而不是"文件丢失"
    const seatDirs = ["audio/mj", "audio/mj/seat1", "audio/mj/seat2", "audio/mj/seat3"];
    const newNames = ["东风", "南风", "西风", "北风", "发财", "白板", "红中"].map((n) => n + ".mp3");
    const missingNew = [];
    for (const d of seatDirs)
      for (const n of newNames)
        if (!fs.existsSync(path.join(ROOT, d, n))) missingNew.push(d + "/" + n);
    A(missingNew.length === 0,
      "四个座位的 7 张字牌新名文件齐全（28 条）",
      missingNew.length ? "缺 " + missingNew.slice(0, 4).join(", ") : "4 座 × 7 张 = 28 条齐");

    const sfx = audio.filter((f) => /^audio\/sfx\//.test(f.path));
    const amb = audio.filter((f) => /^audio\/amb\//.test(f.path));
    const bgm = audio.filter((f) => /^audio\/bgm\//.test(f.path));
    A(sfx.length === 65 && amb.length === 9 && bgm.length === 5,
      "音效/环境音/BGM 数量与基线一致（65 / 9 / 5）",
      sfx.length + " / " + amb.length + " / " + bgm.length);

    /* 反向核对：把磁盘上的真实文件名当作"代码会拼的名字"，
       看候选列表能否覆盖到它。这一条是给未来改命名风格的人准备的闸门。 */
    const unreachable = [];
    for (const f of audio) {
      const rel = f.path.split("#")[0];
      const seg = rel.split("/");
      const dir = seg.slice(0, -1).join("/") + "/";
      const prefix = dir.indexOf("/sfx/") >= 0 ? "sfx-" : (dir.indexOf("/amb/") >= 0 ? "amb-" : "");
      const onDisk = seg[seg.length - 1].replace(/\.mp3$/i, "");
      const base = (prefix && onDisk.indexOf(prefix) === 0) ? onDisk.slice(prefix.length) : onDisk;
      if (AudioSys.mediaCandidates(dir + base + ".mp3", prefix).indexOf(rel) < 0) unreachable.push(rel);
    }
    A(unreachable.length === 0, "所有入库音频都在代码候选列表的覆盖范围内",
      unreachable.length ? unreachable.slice(0, 3).join(" | ") : audio.length + " 个全可达");
  }

  console.log("");
  console.log("[结果] 通过 " + pass + "，失败 " + fails.length + (fails.length ? "" : "，全部通过 ✔"));
  if (fails.length) { console.log("失败项："); fails.forEach((f) => console.log("  - " + f)); }
  process.exit(fails.length ? 1 : 0);
})();
