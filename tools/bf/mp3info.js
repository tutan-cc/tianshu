/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/mp3info.js — 只读 MP3 头，量出**时长 / 采样率 / 声道数**（不依赖 ffmpeg）

   为什么不用 ffprobe：
     `node tools/bf/headless.js` 与 `node tests/breakfast.test.cjs` 是**纯 Node 证据链**
     （本沙箱起不了浏览器，也不该假设别人机器上装了 ffmpeg / 在 PATH 里）。
     而「tick.mp3 ≤120ms」「语音件都是 48kHz 单声道」这两条是**规格**，必须能自动断言。

   实现要点（都踩过）：
     · 跳过 ID3v2（10 字节头 + syncsafe 长度），再从第一个帧同步字（0xFF Ex）开始。
     · **优先读 Xing/Info 头里的帧数**：CBR 裸流按「字节数 ÷ 码率」估时长会把编码器延迟
       和填充帧算进去 —— 实测同一条 110ms 的滴答会被算成 144ms（与 ffprobe 不带 Xing 时一致）。
       LAME/ffmpeg 默认写的 Info 帧里带真实帧数，按它算才与 ffprobe 一致（0.110s）。
     · 声道数取帧头的 channel mode：3 = 单声道。
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");

// MPEG1 Layer3 码率表（kbps）；MPEG2/2.5 Layer3 是另一套
const BR_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BR_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SR_V1 = [44100, 48000, 32000, 0];
const SR_V2 = [22050, 24000, 16000, 0];
const SR_V25 = [11025, 12000, 8000, 0];

/** 解析一个帧头 → { version:1|2|25, bitrate, sampleRate, pad, channels, frameLen, samples } */
function frameAt(b, i) {
  if (i + 4 > b.length) return null;
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const verBits = (b[i + 1] >>> 3) & 3;          // 3=MPEG1 · 2=MPEG2 · 0=MPEG2.5
  const layerBits = (b[i + 1] >>> 1) & 3;        // 1 = Layer III
  const brIdx = (b[i + 2] >>> 4) & 15;
  const srIdx = (b[i + 2] >>> 2) & 3;
  const pad = (b[i + 2] >>> 1) & 1;
  const mode = (b[i + 3] >>> 6) & 3;             // 3 = 单声道
  if (layerBits !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const version = verBits === 3 ? 1 : (verBits === 2 ? 2 : 25);
  const bitrate = (version === 1 ? BR_V1L3[brIdx] : BR_V2L3[brIdx]) * 1000;
  const sampleRate = (version === 1 ? SR_V1 : (version === 2 ? SR_V2 : SR_V25))[srIdx];
  const samples = version === 1 ? 1152 : 576;
  const frameLen = Math.floor(samples / 8 * bitrate / sampleRate) + pad;
  if (!bitrate || !sampleRate || frameLen < 24) return null;
  return { version, bitrate, sampleRate, pad, channels: mode === 3 ? 1 : 2, frameLen, samples, offset: i };
}

function skipId3(b) {
  if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {   // "ID3"
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    return 10 + size;
  }
  return 0;
}

/** → { duration, decoded, sampleRate, channels, bitrate, frames, xing }
      duration = 按 Xing/Info 的 gapless 信息算的「真」时长（没有 Xing 时 = decoded）
      decoded  = 逐帧数 × 每帧样本数 —— **播放器真正会播的长度**（含编码器延迟/填充）
      规格核对一律用 decoded：填充静音播放器不会替你剪掉（实测差 24~58ms）。 */
function mp3Info(file) {
  const b = fs.readFileSync(file);
  let i = skipId3(b);
  while (i < b.length - 4 && !frameAt(b, i)) i++;
  const f = frameAt(b, i);
  if (!f) return { duration: 0, decoded: 0, sampleRate: 0, channels: 0, bitrate: 0, frames: 0, xing: false };
  /* Xing / Info 头：紧跟边信息后面。**两个偏移都要试** ——
     MPEG1 规范是 32 字节边信息（+36），MPEG2/2.5 是 17（+21）；
     但 ffmpeg 给 MPEG1 的 CBR 文件也写成 +21（实测 audio/bf/tick.mp3 的 Info 在 66 = 45+21），
     只试 +36 会漏判，于是时长按帧数算，比 ffprobe 多报 24ms。 */
  let xing = false, frames = 0;
  for (const off of [i + 4 + 32, i + 4 + 17]) {
    const tag = b.slice(off, off + 4).toString("latin1");
    if (tag === "Xing" || tag === "Info") {
      xing = true;
      const flags = b.readUInt32BE(off + 4);
      if (flags & 1) frames = b.readUInt32BE(off + 8);
      break;
    }
  }
  let n = 0;                                      // 逐帧数（不管有没有 Xing，都要数出来）
  {
    let p = i, guard = 0;
    while (p < b.length - 4 && guard++ < 200000) {
      const g = frameAt(b, p);
      if (g) { n++; p += g.frameLen; } else p++;
    }
  }
  const decoded = n * f.samples / f.sampleRate;
  return {
    duration: frames ? frames * f.samples / f.sampleRate : decoded,
    decoded: decoded,
    sampleRate: f.sampleRate,
    channels: f.channels,
    bitrate: f.bitrate,
    frames: n,
    xing: xing
  };
}

module.exports = { mp3Info };

if (require.main === module) {
  for (const f of process.argv.slice(2)) {
    const r = mp3Info(f);
    console.log(f + "  gapless " + (r.duration * 1000).toFixed(0) + "ms · 解码 " +
      (r.decoded * 1000).toFixed(0) + "ms · " + r.sampleRate + "Hz · " +
      r.channels + "ch · " + (r.bitrate / 1000) + "kbps · " + r.frames + " 帧" + (r.xing ? " · Xing/Info" : ""));
  }
}
