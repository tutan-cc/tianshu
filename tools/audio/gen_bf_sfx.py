#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_bf_sfx.py — 合成早餐店的**倒计时滴答**（tick.mp3）

为什么要自己合成、而不是走 TTS：
  用户要的是「短促干净的一下滴答」——TTS 念「滴答」两个字最短也要 0.4s 以上，
  而且带人声腔体感；而倒计时滴答在玩法里 0.5s 就要响一次，必须 ≤120ms、
  不能有混响尾巴，否则快速连击会糊成噪音。所以这一条走**程序化合成**。

参考：tools/audio/gen_sfx.py（那是 StepAudio 生成，需要 STEP_API_KEY；本脚本只用标准库 + ffmpeg）
     tools/audio/process_sfx.py --preset word（统一响度 / 格式）

声音设计（目标：干净、不刺耳、像挂钟/节拍器的一下）：
  · 主体：约 1050Hz 的阻尼正弦（Q 值高 → 音高明确但不"叫"），指数衰减 ~35ms
  · 起音：3ms 的滤波噪声瞬态（给"咔"的接触感，不带金属尖啸）
  · 收尾：整体 ≤120ms，末端 8ms 淡出到 0（否则每 0.5s 一次的截断会"噗"一声）
  · 上限软削波（tanh）避免瞬态爆点；峰值归一化到 −6 dBFS 再交给响度加工
  · 高通：把 200Hz 以下的能量压掉，避免和小音量设备上的低频嗡声打架

产出：<out>/tick.wav → 之后由 process_sfx.py（--preset word）统一成
      48kHz / 128kbps / 单声道 mp3 落到 audio/bf/tick.mp3。

用法：
    python tools/audio/gen_bf_sfx.py --out "$env:USERPROFILE\\Desktop\\audio-工作区\\_bf_src"
    python tools/audio/gen_bf_sfx.py --out DIR --ms 110 --hz 1050 --force
"""

import argparse
import json
import math
import os
import random
import struct
import subprocess
import sys
import wave

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

SR = 48000


def synth_tick(ms=70, hz=1050.0, seed=20260920):
    """返回 [-1,1] 的浮点样本列表：一声 ≤120ms 的滴答。

    ⚠ 为什么默认 70ms 而不是贴着 120ms：
      MP3 的**帧粒度是 1152 样本 = 24ms（48kHz）**，而 LAME 还要在前面塞约 1105 样本
      （23ms）的编码器延迟。实测原始件 110ms 时：解码出来是 6 个数据帧 = 144ms，
      ffmpeg 再给一个 Xing/Info 帧 → 总共 7 帧 = **168ms**。
      ffprobe 读 Xing 里的 gapless 信息会报 110ms（"真"时长），
      但**播放器不会替你剪掉那些填充静音** —— 真正播出来就是 168ms，超过用户要求的 120ms。
      所以这里把源时长压到 70ms（4 个数据帧 = 96ms 解码长度，带上延迟也 <120ms），
      并让 encode_mp3 关掉 Xing 帧：两种口径（ffprobe / 逐帧数）都能落在 120ms 以内。
    """
    n = int(SR * ms / 1000.0)
    rnd = random.Random(seed)
    body_decay = 0.016          # 主体指数衰减时间常数（秒）—— 70ms 内衰减到 ~1.4%
    click_decay = 0.0014        # 起音噪声瞬态（秒）
    atk = int(SR * 0.0015)      # 1.5ms 起音斜坡，避免第一个样本跳变
    rel = int(SR * 0.007)       # 末端 7ms 淡出
    out = []
    for i in range(n):
        t = i / SR
        # ① 主体：阻尼正弦（二次指数 → 尾巴收得更干净）
        env = math.exp(-t / body_decay) * math.exp(-(t / body_decay) ** 2 * 0.35)
        s = math.sin(2 * math.pi * hz * t) * env
        s += 0.28 * math.sin(2 * math.pi * hz * 2.0 * t) * env ** 2      # 一点泛音，音色更"木"
        # ② 起音瞬态：短噪声（只在前 6ms）
        if t < 0.006:
            s += (rnd.random() * 2 - 1) * 0.5 * math.exp(-t / click_decay)
        out.append(s)
    # ③ 高通（一阶差分近似）+ 软削波 + 包络（起音斜坡 / 末端淡出）
    hp = []
    prev_x = 0.0
    prev_y = 0.0
    for s in out:
        y = 0.92 * (prev_y + s - prev_x)          # 一阶高通，压掉 200Hz 以下的能量
        prev_x, prev_y = s, y
        hp.append(y)
    peak = max(1e-9, max(abs(v) for v in hp))
    soft = [math.tanh(v / peak * 1.6) for v in hp]                     # 软削波
    peak2 = max(1e-9, max(abs(v) for v in soft))
    final = []
    for i, v in enumerate(soft):
        g = 1.0
        if i < atk:
            g *= i / atk
        if i >= n - rel:
            g *= max(0.0, (n - i) / rel)
        final.append(v / peak2 * 0.5 * g)                              # 峰值 −6 dBFS
    return final


def write_wav(path, samples, sr=SR):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for v in samples:
            iv = int(max(-1.0, min(1.0, v)) * 32767.0)
            frames += struct.pack("<h", iv)
        w.writeframes(bytes(frames))


FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"


def encode_mp3(src, dst):
    """把 WAV 编成 48kHz / 128kbps / 单声道 mp3，并做 −16 LUFS 响度归一。

    等价于 process_sfx.py --preset word 的「响度 + 格式」部分，但**不加首尾余量**：
    process_sfx 的 word 预设会补 pad 0.03s + tail_pad 0.02~0.06s，而且末尾有一条
    「加工后短于 0.12s 就当成切光丢弃」的防呆 —— 对 ≤120ms 的滴答来说，
    这两条正好互相打架（补完余量超 120ms / 不补就被丢）。所以滴答这一条自己编码，
    加工完仍然 ≤120ms，其余语音仍走 process_sfx.py（见 gen_bf_tts.py）。
    """
    cmd = [FFMPEG, "-y", "-v", "error", "-i", src,
           "-af", "loudnorm=I=-16.0:TP=-1.5:LRA=11",
           "-ac", "1", "-ar", "48000", "-b:a", "128k",
           # ⚠ **关掉 Xing/Info 帧**（-write_xing 0）：它本身是一个 24ms 的静音帧。
           #   带着它时「逐帧数」的时长会比「ffprobe 读 gapless 信息」多 24ms，
           #   实测 110ms 的滴答变成 7 帧 = 168ms（播放器真会播这么久）。
           #   关掉之后两种口径一致（本脚本末尾会分别核对）。
           "-write_xing", "0",
           dst]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0 or not os.path.exists(dst) or os.path.getsize(dst) < 600:
        return False, (p.stderr.decode("utf-8", "replace")[:200] or "输出异常")
    return True, ""


def probe(path):
    """→ (时长秒, 采样率, 声道, 码率) ；失败返回 (0,0,0,'')"""
    p = subprocess.run([FFPROBE, "-v", "error", "-show_entries",
                        "format=duration,bit_rate:stream=sample_rate,channels",
                        "-of", "json", path], capture_output=True)
    try:
        j = json.loads(p.stdout.decode("utf-8", "replace"))
        st = (j.get("streams") or [{}])[0]
        fm = j.get("format") or {}
        return (float(fm.get("duration") or 0), int(st.get("sample_rate") or 0),
                int(st.get("channels") or 0), int(fm.get("bit_rate") or 0))
    except Exception:
        return (0.0, 0, 0, 0)


def main():
    ap = argparse.ArgumentParser(description="合成早餐店倒计时滴答 tick.wav")
    ap.add_argument("--out", required=True, help="输出目录（原始件；之后过 process_sfx.py）")
    ap.add_argument("--ms", type=int, default=110, help="时长毫秒（≤120，默认 110）")
    ap.add_argument("--hz", type=float, default=1050.0, help="主体频率（默认 1050）")
    ap.add_argument("--name", default="tick", help="文件基名（默认 tick）")
    ap.add_argument("--mp3", help="同时编码成品 mp3 到这个目录（正式素材目录，如 audio/bf）")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    if args.ms > 120:
        print(f"⚠ --ms={args.ms} 超过用户要求的 120ms 上限，已夹到 120", file=sys.stderr)
        args.ms = 120
    os.makedirs(args.out, exist_ok=True)
    dest = os.path.join(args.out, args.name + ".wav")
    if os.path.exists(dest) and not args.force:
        print(f"跳过（已存在 {dest}，加 --force 覆盖）")
        return 0

    s = synth_tick(ms=args.ms, hz=args.hz)
    write_wav(dest, s)
    peak = max(abs(v) for v in s)
    print(f"OK {dest}  {len(s)} 样本 · {len(s)/SR*1000:.0f}ms · 峰值 {20*math.log10(max(peak,1e-9)):.1f} dBFS")

    if args.mp3:
        os.makedirs(args.mp3, exist_ok=True)
        mp3 = os.path.join(args.mp3, args.name + ".mp3")
        good, err = encode_mp3(dest, mp3)
        if not good:
            print(f"编码失败：{err}", file=sys.stderr)
            return 1
        dur, sr, ch, br = probe(mp3)
        print(f"编码 OK {mp3}  ffprobe 时长 {dur*1000:.0f}ms · {sr}Hz · {ch}ch · {br//1000}kbps")
        # 再按「帧数 × 24ms」算一遍**解码长度**（播放器真正会播的长度，见 synth_tick 的说明）
        import json as _json
        nf = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "a", "-count_frames",
                             "-show_entries", "stream=nb_read_frames", "-of", "json", mp3],
                            capture_output=True)
        try:
            frames = int((_json.loads(nf.stdout.decode("utf-8", "replace")).get("streams") or [{}])[0]
                         .get("nb_read_frames") or 0)
        except Exception:
            frames = 0
        decoded = frames * 1152 / 48000.0 if frames else dur
        print(f"           逐帧解码长度 {decoded*1000:.0f}ms（{frames} 帧 × 24ms）")
        if dur > 0.120 or decoded > 0.120:
            print(f"⚠ 成品超过 120ms 上限（ffprobe {dur*1000:.0f}ms / 解码 {decoded*1000:.0f}ms）",
                  file=sys.stderr)
            return 1
        if sr != 48000 or ch != 1:
            print(f"⚠ 成品规格不是 48kHz 单声道（{sr}Hz/{ch}ch）", file=sys.stderr)
            return 1
        print("成品规格核对通过：两种口径都 ≤120ms · 48kHz · 单声道 · 128kbps · −16 LUFS")
        return 0

    print("\n下一步（必须）：过加工预设，转成 48kHz/128kbps mp3 ——")
    print(f'  python tools/audio/process_sfx.py --src "{args.out}" '
          f'--out "audio/bf" --preset word --force')
    print("（加工后请核对：时长仍 ≤120ms、无爆音。本脚本不含响度归一化，归一化交给 process_sfx.py）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
