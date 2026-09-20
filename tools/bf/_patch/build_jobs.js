/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs.js — 生成「早餐店音效接入」这一轮的 patch-literal 作业表

   为什么要有生成器而不是手写 jobs.json：
     本轮所有锚点都必须是**逐字字面**，而源文件里那行「2. 运行时状态」上有一长串 ═ 装饰字符，
     手工誊写极易差一个字符（差一个就 job 直接失败，甚至更糟：锚点重复）。
     所以锚点一律从 breakfast.js 里**按行切出来**（lineWith / spanWith），保证与源文件逐字相等。

   ⚠ 行尾风格：breakfast.js 是 **CRLF**。所有锚点里的换行必须与源文件一致，
     新增文本也一律按源文件的 EOL 生成（否则会插进一堆孤立 \r，diff 会很难看）。
     本脚本读一次源文件判定 EOL，然后全程用它。

   用法：
     node tools/bf/_patch/build_jobs.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_audio.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", "..");
const SRC_FILE = "breakfast.js";
const src = fs.readFileSync(path.join(ROOT, SRC_FILE), "utf8");
const EOL = src.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
/** 把多行文本按源文件的 EOL 拼起来（传进来的片段一律用 \n）*/
const L = (...lines) => lines.join(EOL);

function countOcc(hay, needle) {
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function lineStart(s, i) { return s.lastIndexOf("\n", i) + 1; }
function lineEnd(s, i) {
  let k = s.indexOf("\n", i);
  if (k < 0) k = s.length;
  if (k > 0 && s[k - 1] === "\r") k--;          // 行尾 \r 不算行内容（新增文本自己带 EOL）
  return k;
}
/** 取出「包含 needle 的那一整行」（needle 必须唯一）*/
function lineWith(needle) {
  const n = countOcc(src, needle);
  if (n !== 1) throw new Error("锚点不唯一（" + n + " 次）：" + needle);
  const i = src.indexOf(needle);
  return src.slice(lineStart(src, i), lineEnd(src, i));
}
/** 取出「从含 a 的那行开头 到 含 b 的那行结尾」的整段（a/b 都必须唯一）*/
function spanWith(a, b) {
  if (countOcc(src, a) !== 1) throw new Error("起始锚不唯一：" + a);
  if (countOcc(src, b) !== 1) throw new Error("结束锚不唯一：" + b);
  const ia = src.indexOf(a), ib = src.indexOf(b);
  if (ib < ia) throw new Error("结束锚在起始锚之前：" + b);
  return src.slice(lineStart(src, ia), lineEnd(src, ib));
}

const jobs = [];
const push = (from, text) => jobs.push({ file: SRC_FILE, from, text });

/* ── J1：整段插入「1b. 音效 / 顾客语音」────────────────────────────────────
   text = 新章节正文 + 原样保留的「2. 运行时状态」那一行（锚点行本身要被替换回来）。 */
const MARKER = lineWith("2. 运行时状态（纯数据");
const section = fs.readFileSync(path.join(__dirname, "audio_section.txt"), "utf8")
  .replace(/\r\n/g, "\n").replace(/\s*$/, "\n");
fs.writeFileSync(path.join(__dirname, "audio_section_final.txt"),
                 (section + MARKER + "\n").replace(/\n/g, EOL), "utf8");
jobs.push({ file: SRC_FILE, from: MARKER, textFile: "tools/bf/_patch/audio_section_final.txt" });

/* ── J2：newState 里挂音频台账 ── */
const J2 = lineWith("customers:[], stations:[], plates:[], floats:[], smoke:[], seq:1,");
push(J2, J2 + EOL + "      audio:newAudioState(),                       // 音效台账（滴答节奏 / 各通道节流时钟 / 计数）");

/* ── J3：step() 顾客耐心段 —— 记「本帧有人跑单」的标志 ── */
const J3 = spanWith("/* 顾客耐心 */",
                    "if (remainOf(c) <= 0) { c.left = true; c.leftAt = st.elapsed; continue; }");
const J3_ANCHOR = "    var list = activeCustomers(st);";
if (countOcc(J3, J3_ANCHOR) !== 1) throw new Error("J3 内部锚点不唯一");
push(J3, J3.replace(J3_ANCHOR, L(J3_ANCHOR,
  "    var leftNow = false;          // 本帧有没有人「等太久走掉」（同一帧多人也只播一次「哼，太慢了」）")));

/* ── J4：跑单事件处置标志 ── */
const J4 = lineWith('ev.push({ t:"leave", id:c.id });');
push(J4, J4 + EOL + "          leftNow = true;");

/* ── J5：顾客清理之后 → 音频调度（滴答 + 跑单语音）── */
const J5 = spanWith("/* 已完成的顾客留 0.5s 让飘字播完，然后离场（已完成的在出餐时就置 left） */",
                    "if (c.left && c.leftAt !== undefined && st.elapsed - c.leftAt > 1.3) st.customers.splice(i, 1);");
push(J5, L(J5,
  "",
  "    /* 音效 / 顾客语音调度：放在顾客账算完**之后** —— 所以「顾客跑单 / 被服务完」当帧就会停滴答。",
  "       滴答的阈值 / 节奏 / 全局节流、以及「哼，太慢了」的只播一次，都在 stepAudio 里（纯函数可单测）。*/",
  "    stepAudio(st, leftNow);"));

/* ── J6：成功上餐 → 「呜呼～」── */
const J6 = spanWith('return { ok:true, kind: perfect ? (tier === "hot" ? "perfect-hot" : "perfect") : "over",',
                    'food:foodId, state:foodState, heat:tier, delta:d, perfect:perfect, cookSec:cookSec, customer:c };');
push(J6, L("    /* ② 拿到早餐 → 高兴地「呜呼～」：一次成功上餐只播一次；",
  "       糊的 / 上错的在上面两个分支就 return 了，不会响（那种情况顾客要走，不该欢呼）。 */",
  "    playHappy(st);") + EOL + J6);

/* ── J7：LAY 里加徽章命中框 ── */
const J7 = spanWith("platesLabelY: 312,", "bucketLabelDy: -14");
push(J7, L(J7 + ",",
  "    /* 图例条左端的 🔊/🔇 小开关（可点）——那一行左侧本来就是空的（居中说明文字从 ~170px 才起），",
  "       所以徽章塞在这里不会挤到任何既有元素 */",
  "    soundBadge: { x:20, y:287, w:124, h:22 }"));

/* ── J8：命中框取值函数 ── */
const J8 = lineWith("function customerCardBox(i) { return { x:LAY.cards.x0");
push(J8, L(J8,
  "  /** 声音开关徽章的命中框（绘制与点击共用同一个框）*/",
  "  function soundBox() { return LAY.soundBadge; }"));

/* ── J9：顶栏加 🔊/🔇 按钮（与「收 摊」同款木牌样式）── */
const J9 = spanWith('var btnEnd = mkBtn("收 摊", "bf-wood");', "bar.appendChild(btnEnd);");
push(J9, L("    /* 声音开关：早餐店此前没有任何静音 / 音量设置 → 按用户要求用 localStorage.bfSoundOn（默认开），",
  "       这里给一个真实按钮（与「收 摊」同款木牌样式，风格一致）；图例条左端的徽章是同一个开关的第二入口。 */",
  '    var btnSound = mkBtn(soundLabel(), "bf-wood");',
  '    btnSound.id = "bfSound";',
  '    btnSound.setAttribute("data-act", "sound");',
  '    btnSound.title = "音效开关（记在 localStorage.bfSoundOn）";',
  "    bar.appendChild(btnSound);") + EOL + J9);

/* ── J10：实例句柄里带上按钮 ── */
const J10 = lineWith("st:st, host:hostEl, wrap:wrap, cv:cv, g:g, panel:panel, btnEnd:btnEnd,");
push(J10, J10.replace("btnEnd:btnEnd,", "btnEnd:btnEnd, btnSound:btnSound,"));

/* ── J11：按钮事件 ── */
const J11 = lineWith('btnEnd.addEventListener("click", function () { finishNow("主动收摊"); });');
push(J11, L('    btnSound.addEventListener("click", function (ev) {',
  "      if (ev && ev.preventDefault) ev.preventDefault();",
  "      toggleSound();",
  "    });") + EOL + J11);

/* ── J12：画布上的徽章命中（点它也能切开关）── */
const J12 = spanWith("function onDown(evt) {", "/* ① 底部食材桶：单击 = 自动进它自己那一列的锅（也可以拖，见 onUp） */");
const J12_ANCHOR = "      var p = toLocal(evt);";
if (countOcc(J12, J12_ANCHOR) !== 1) throw new Error("J12 内部锚点不唯一");
push(J12, J12.replace(J12_ANCHOR, L(J12_ANCHOR,
  "      /* ⓪ 图例条左端的 🔊/🔇 徽章：切换音效开关（与顶栏按钮同一个开关）*/",
  "      if (hit(p.x, p.y, soundBox())) { resetDouble(); toggleSound(); return; }")));

/* ── J13：drawLegend 里画徽章 ── */
const J13 = spanWith('if (drawAssetFit(g, assetOf(GEAR_ICON, "tools"), { x: x + w - 60, y: y + 2, w: 54, h: h - 4 }, null)) IA.drawn.gearTools',
                     "IA.drawn.legend = true;");
const J13_ANCHOR = '      g.restore();' + EOL + '      g.textAlign = "left";';
if (countOcc(J13, J13_ANCHOR) !== 1) throw new Error("J13 内部锚点不唯一");
push(J13, J13.replace(J13_ANCHOR, L(
  "      /* 声音开关徽章（图例条左端空位；可点，见 onDown）—— 🔊 开 / 🔇 关 一眼可见 */",
  "      var sb = soundBox(), sOn = audio.enabled();",
  '      g.fillStyle = sOn ? "rgba(255,214,110,.16)" : "rgba(255,255,255,.05)";',
  "      roundRect(g, sb.x, sb.y, sb.w, sb.h, 6); g.fill();",
  '      g.strokeStyle = sOn ? "rgba(255,214,110,.60)" : "rgba(255,255,255,.22)";',
  "      g.lineWidth = 2; roundRect(g, sb.x, sb.y, sb.w, sb.h, 6); g.stroke();",
  "      g.font = fontOf(FONT.micro, true);",
  "      g.fillStyle = sOn ? PAL.gold : PAL.dim;",
  '      g.fillText(sOn ? "🔊 音效 开" : "🔇 音效 关", sb.x + sb.w / 2, sb.y + sb.h / 2);',
  '      IA.drawn.soundBadge = sOn ? "on" : "off";',
  '      g.restore();', '      g.textAlign = "left";')));

/* ── J14：rules 导出 audio ── */
const J14 = lineWith("quoteFor: quoteFor, impactOf: impactOf, quotaOf: quotaOf, QUOTES: QUOTES, QUOTE_FALLBACK: QUOTE_FALLBACK");
push(J14, L(J14 + ",",
  "    /* 音效 / 顾客语音（bf-audio-1）：阈值 / 节奏 / 节流 / 开关 / 播放记录，全在这里 */",
  "    audio: audioRules"));

/* ── J15：debug 暴露现场台账 ── */
const J15 = lineWith("goBtn: function () { return inst ? (inst.goBtn || null) : null; }");
push(J15, L(J15 + ",",
  "      /** 音效 / 顾客语音的现场台账（无头验收读它：常量、开关、比例、计数、播放序列）*/",
  "      audio: function () {",
  "        var st = curState();",
  "        return { on:audio.enabled(), key:BF_SOUND_KEY, dir:BF_AUDIO_DIR,",
  "                 tickAt:TICK_AT, tickNear:TICK_NEAR, gapFar:TICK_GAP_FAR, gapNear:TICK_GAP_NEAR,",
  "                 minGap:TICK_MIN_GAP, happyGap:HAPPY_MIN_GAP, slowGap:SLOW_MIN_GAP,",
  "                 vol:audio.vol, files:audio.files,",
  "                 ratio:(st ? Math.round(minPatienceRatio(st) * 1000) / 1000 : null),",
  "                 tickDue:(st ? tickDue(st) : false),",
  "                 ticks:(st && st.audio ? st.audio.ticks : 0),",
  "                 happies:(st && st.audio ? st.audio.happies : 0),",
  "                 slows:(st && st.audio ? st.audio.slows : 0),",
  "                 badge:(inst && inst.drawn) ? (inst.drawn.soundBadge || null) : null,",
  "                 label:soundLabel(),",
  "                 plays:audio.plays(), log:audio.log() };",
  "      },",
  "      /** 开关（浏览器 / 无头都能用；与两个 UI 入口是同一个开关）*/",
  "      setSound: function (b) { return audio.setEnabled(b); },",
  "      toggleSound: function () { return toggleSound(); },",
  "      /** 顶栏音效按钮（#bfSound）与图例徽章的命中框 */",
  "      soundBtn: function () { return inst ? (inst.btnSound || null) : null; },",
  "      soundBox: function () { return soundBox(); },",
  "      /** 清空播放记录（验收每个场景前调一次，读到的序列才是这一段产生的）*/",
  "      clearAudio: function () { audio.clear(); return true; }"));

/* ── 落盘作业表 ── */
const out = path.join(__dirname, "jobs_audio.json");
fs.writeFileSync(out, JSON.stringify({ note: "早餐店音效 / 顾客语音接入（bf-audio-1）", eol: EOL === "\r\n" ? "CRLF" : "LF", jobs }, null, 1), "utf8");
console.log("作业表：" + out + "（" + jobs.length + " 个 job · 源文件 EOL=" + (EOL === "\r\n" ? "CRLF" : "LF") + "）");
jobs.forEach((j, i) => console.log("  job#" + (i + 1) + "  " + (j.textFile || ("+" + j.text.length + " 字符")) +
  "  锚：" + JSON.stringify(j.from.slice(0, 46))));
