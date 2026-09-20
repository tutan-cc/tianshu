#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_bf_cook_sfx.py — 早餐店「下锅那一刻」的 9 条烹饪音效（点食材 → 进对应锅时触发）

用户原话（bf-9 这一轮）：
    「点做果汁的时候可以触发榨果汁的音效，点煎蛋的时候可以触发煎蛋的音效」
硬要求：果汁（榨汁机）+ 煎蛋（下锅滋啦）必须有；其余 7 样（培根 / 蒸笼 / 倒牛奶 /
        盛粥 / 清汤 / 沙拉切菜 / 三明治烤面包）尽量做全。

为什么不用 gen_sfx.py / StepAudio（诚实记录）：
  · tools/audio/gen_sfx.py 走的是 StepAudio 3 Gen（`STEP_API_KEY` + api.stepfun.com），
    本轮环境里**没有这个 key**，跑不了；而且它是「一段文字描述 → 云端合成」，
    9 条要反复试听才能定，链路长。
  · 本机 python 是 hermes venv：**没有 numpy、也不能 pip install**，
    所以 tools/audio/process_sfx.py（依赖 numpy）用不了。
  → 于是这里用**纯标准库 DSP 现场合成**（math / random / wave / array），
    再用 **ffmpeg** 统一加工成 48kHz / 单声道 / 128kbps mp3。
    好处：完全离线、可复现、参数可调、零外部依赖；代价：音色是"合成感"而非实拍采样。
    每条的音色设计都写在下面 DESIGN 表里，想换音色改参数重跑即可。

用法：
    python tools/audio/gen_bf_cook_sfx.py                 # 生成 9 条 → audio/bf/cook_*.mp3
    python tools/audio/gen_bf_cook_sfx.py --only juice,egg --force
    python tools/audio/gen_bf_cook_sfx.py --dry-run
    python tools/audio/gen_bf_cook_sfx.py --list
"""

import argparse
import array
import json
import math
import os
import random
import shutil
import subprocess
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import paths as PA
except Exception:
    PA = None

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

SR = 48000                     # 采样率（与 audio/ 其它素材一致）
OUT_DIR = os.path.join(PA.AUDIO, "bf") if PA else "audio/bf"
WORK = os.path.join(PA.WORK_ROOT, "_bf_sfx_work") if PA else "_bf_sfx_work"
FFMPEG = os.environ.get("FFMPEG_BIN") or "ffmpeg"
FFPROBE = os.environ.get("FFPROBE_BIN") or "ffprobe"

# ── 音色设计表：(文件名, 中文, 一句说明) ─────────────────────────────────
DESIGN = [
    ("cook_juice",    "果汁 · 榨汁机", "电机低频嗡鸣 + 果肉翻滚，转速先快后慢地收尾"),
    ("cook_egg",      "煎蛋 · 下锅",   "蛋壳磕开的一声脆响，紧接一记滋啦（下油锅）"),
    ("cook_bacon",    "培根 · 煎",     "持续滋滋声，油花爆裂的密集脆响"),
    ("cook_bun",      "包子 · 蒸笼",   "掀笼盖的竹木轻磕 + 蒸汽「嘶」的一声"),
    ("cook_milk",     "热牛奶 · 倒",   "液体倒入锅中的连续注流声，尾音带气泡"),
    ("cook_soup",     "清汤 · 下锅",   "汤水入锅的「咕咚」一声 + 短促水声"),
    ("cook_congee",   "白粥 · 下米",   "稠粥落锅的沉闷一声 + 搅动的黏稠摩擦"),
    ("cook_salad",    "沙拉 · 切菜",   "菜刀在砧板上快切三下，木头共鸣"),
    ("cook_sandwich", "三明治 · 烤",   "面包放上烤盘的一声闷响 + 轻微炙烤声"),
]

random.seed(20250917)          # 固定种子：同样的代码每次都出同样的音效（可复现）


# ══════════════════ 纯标准库 DSP 小工具 ══════════════════
def buf(sec):
    return [0.0] * int(SR * sec)


def mix(dst, src, gain=1.0, at=0.0):
    """把 src 叠加到 dst 的 at 秒处（越界自动截断）。"""
    i0 = int(at * SR)
    for i, v in enumerate(src):
        k = i0 + i
        if 0 <= k < len(dst):
            dst[k] += v * gain
    return dst


def env_exp(n, attack=0.002, decay=0.3, power=2.0):
    """快起 + 指数衰减的包络。"""
    out = [0.0] * n
    na = max(1, int(attack * SR))
    for i in range(n):
        a = i / na if i < na else 1.0
        d = math.exp(-power * (i / SR) / max(1e-4, decay))
        out[i] = a * d
    return out


def noise(n, rng=random):
    return [rng.uniform(-1.0, 1.0) for _ in range(n)]


class Biquad:
    """RBJ cookbook 双二阶滤波器（低通 / 高通 / 带通都够用）。"""

    def __init__(self, kind, f0, q=0.707):
        w0 = 2 * math.pi * f0 / SR
        alpha = math.sin(w0) / (2 * q)
        cw = math.cos(w0)
        if kind == "lp":
            b0, b1, b2 = (1 - cw) / 2, 1 - cw, (1 - cw) / 2
            a0, a1, a2 = 1 + alpha, -2 * cw, 1 - alpha
        elif kind == "hp":
            b0, b1, b2 = (1 + cw) / 2, -(1 + cw), (1 + cw) / 2
            a0, a1, a2 = 1 + alpha, -2 * cw, 1 - alpha
        else:  # bp（单位峰值增益）
            b0, b1, b2 = alpha, 0.0, -alpha
            a0, a1, a2 = 1 + alpha, -2 * cw, 1 - alpha
        self.b = (b0 / a0, b1 / a0, b2 / a0)
        self.a = (a1 / a0, a2 / a0)
        self.x1 = self.x2 = self.y1 = self.y2 = 0.0

    def __call__(self, x):
        b0, b1, b2 = self.b
        a1, a2 = self.a
        y = b0 * x + b1 * self.x1 + b2 * self.x2 - a1 * self.y1 - a2 * self.y2
        self.x2, self.x1 = self.x1, x
        self.y2, self.y1 = self.y1, y
        return y


def filt(src, kind, f0, q=0.707):
    f = Biquad(kind, f0, q)
    return [f(v) for v in src]


def sweep_tone(n, f_start, f_end, amp=1.0, decay=0.3):
    """频率从 f_start 扫到 f_end 的阻尼正弦（「咕咚」「啪」这类）。"""
    out = [0.0] * n
    ph = 0.0
    e = env_exp(n, 0.001, decay, 2.4)
    for i in range(n):
        t = i / n
        f = f_start + (f_end - f_start) * t
        ph += 2 * math.pi * f / SR
        out[i] = amp * math.sin(ph) * e[i]
    return out


def clicks(n, times, decay=0.02, body=1200.0, amp=0.9):
    """一串短促的撞击（油花 / 切菜 / 竹盖磕碰）。"""
    out = [0.0] * n
    for t in times:
        i0 = int(t * SR)
        ln = min(n - i0, int(decay * 5 * SR))
        if ln <= 0:
            continue
        hit = sweep_tone(ln, body * 1.6, body * 0.7, amp, decay)
        for i, v in enumerate(hit):
            out[i0 + i] += v
    return out


# ══════════════════ 9 条音效 ══════════════════
def sfx_juice():
    """榨汁机：电机嗡鸣（锯齿谐波）+ AM 抖动 + 果肉翻滚的噪声，收尾转速下降。"""
    n = int(SR * 0.62)
    out = [0.0] * n
    ph = 0.0
    for i in range(n):
        t = i / SR
        # 转速：起转 → 稳定 → 收尾降速
        rpm = 1.0 if t < 0.06 else (1.0 - 0.45 * (t - 0.06) / 0.56)
        f0 = 92.0 * rpm
        ph += 2 * math.pi * f0 / SR
        s = 0.0
        for h, a in ((1, 0.5), (2, 0.30), (3, 0.18), (5, 0.10), (7, 0.06)):
            s += a * math.sin(ph * h)
        am = 0.82 + 0.18 * math.sin(2 * math.pi * 27 * t)          # 电机抖动
        out[i] = s * am
    out = filt(out, "lp", 2600)
    # 果肉在杯里滚动：带通噪声 + 几下颗粒撞击
    rum = filt(noise(n), "bp", 1500, 1.2)
    e = env_exp(n, 0.02, 0.5, 1.6)
    for i in range(n):
        out[i] = 0.55 * out[i] + 0.35 * rum[i] * e[i]
    mix(out, clicks(n, [0.03, 0.12, 0.22, 0.34, 0.47], 0.018, 2100, 0.35))
    mix(out, clicks(n, [0.0], 0.03, 700, 0.5))                      # 杯子放上台面
    return out


def sfx_egg():
    """煎蛋：蛋壳磕开（两下脆响）+ 立刻一记滋啦。"""
    n = int(SR * 0.55)
    out = [0.0] * n
    mix(out, clicks(n, [0.0, 0.055], 0.012, 2600, 1.0))             # 磕蛋壳
    sz = filt(noise(n), "hp", 2200)
    e = env_exp(n, 0.004, 0.42, 1.5)
    for i in range(n):
        out[i] += 0.85 * sz[i] * e[i]
    # 蛋白摊开：一小段中频「哗」，位置在 0.07s
    body = filt(noise(n), "bp", 900, 0.9)
    e2 = env_exp(n, 0.01, 0.18, 2.0)
    for i in range(n):
        out[i] += 0.30 * body[i] * e2[i]
    out = filt(out, "hp", 320)
    return out


def sfx_bacon():
    """培根：持续滋滋 + 密集油花爆裂。"""
    n = int(SR * 0.66)
    sz = filt(noise(n), "hp", 2600)
    e = env_exp(n, 0.03, 0.5, 1.2)
    out = [0.8 * sz[i] * e[i] for i in range(n)]
    times = []
    t = 0.02
    while t < 0.62:                                   # 越往后越稀（火候在收）
        times.append(t)
        t += random.uniform(0.012, 0.05)
    mix(out, clicks(n, times, 0.006, 3200, 0.5))
    out = filt(out, "hp", 500)
    return out


def sfx_bun():
    """蒸笼：竹盖轻磕两下 + 蒸汽「嘶」。"""
    n = int(SR * 0.6)
    out = [0.0] * n
    mix(out, clicks(n, [0.0, 0.045], 0.035, 480, 0.9))              # 竹木共鸣（低频体）
    mix(out, clicks(n, [0.0, 0.045], 0.010, 1900, 0.35))            # 木盖的高频磕碰
    st = filt(noise(n), "bp", 4200, 0.8)
    e = env_exp(n, 0.06, 0.5, 1.3)
    for i in range(n):
        out[i] += 0.65 * st[i] * e[i]
    return out


def sfx_milk():
    """倒牛奶：连续注流（中心频率上行的带通噪声）+ 尾段气泡。"""
    n = int(SR * 0.58)
    out = [0.0] * n
    seg = 256
    src = noise(n)
    for i in range(n):
        t = i / SR
        fc = 900 + 1500 * min(1.0, t / 0.5)                          # 液面升高 → 音色变亮
        # 用分段带通模拟滑动中心频率（纯标准库：每段换一次滤波器系数）
        pass
    # 分段滤波（比逐样本换系数快，听感上也够滑）
    out = [0.0] * n
    for i0 in range(0, n, seg):
        i1 = min(n, i0 + seg)
        fc = 900 + 1500 * min(1.0, (i0 / SR) / 0.5)
        f = Biquad("bp", fc, 1.1)
        for i in range(i0, i1):
            out[i] = f(src[i])
    e = env_exp(n, 0.02, 0.45, 1.4)
    for i in range(n):
        out[i] *= e[i]
    # 气泡：一串上行的短音（液面下的气泡破裂）
    bub = [0.0] * n
    for k in range(7):
        t = 0.12 + k * 0.055
        i0 = int(t * SR)
        ln = min(n - i0, int(0.05 * SR))
        if ln <= 0:
            continue
        tone = sweep_tone(ln, 700 + 120 * k, 1500 + 200 * k, 0.22, 0.012)
        for i, v in enumerate(tone):
            bub[i0 + i] += v
    mix(out, bub)
    return out


def sfx_soup():
    """清汤入锅：咕咚一声 + 短促水声（比牛奶更"稀"、更快）。"""
    n = int(SR * 0.46)
    out = [0.0] * n
    mix(out, sweep_tone(n, 420, 150, 0.9, 0.10))                     # 咕咚（音高下行）
    w = filt(noise(n), "bp", 2600, 0.8)
    e = env_exp(n, 0.006, 0.22, 1.6)
    for i in range(n):
        out[i] += 0.55 * w[i] * e[i]
    mix(out, clicks(n, [0.09, 0.17, 0.26], 0.02, 1500, 0.28))        # 液面回弹的小泡
    return out


def sfx_congee():
    """白粥下米（稠）：沉闷的一声 + 黏稠搅动。"""
    n = int(SR * 0.52)
    out = [0.0] * n
    mix(out, sweep_tone(n, 260, 90, 1.0, 0.12))                      # 比清汤更闷更低
    thick = filt(noise(n), "bp", 700, 0.7)
    e = env_exp(n, 0.02, 0.34, 1.5)
    wob = [0.0] * n
    for i in range(n):
        t = i / SR
        wob[i] = thick[i] * (0.6 + 0.4 * math.sin(2 * math.pi * 7 * t))   # 黏稠的搅动感
    for i in range(n):
        out[i] += 0.45 * wob[i] * e[i]
    mix(out, clicks(n, [0.04, 0.13, 0.23], 0.025, 380, 0.35))        # 米粒落锅
    out = filt(out, "lp", 3200)
    return out


def sfx_salad():
    """沙拉：砧板上快切三下。"""
    n = int(SR * 0.42)
    out = [0.0] * n
    mix(out, clicks(n, [0.0, 0.10, 0.20, 0.30], 0.028, 300, 0.95))   # 木头共鸣（刀落砧板）
    mix(out, clicks(n, [0.0, 0.10, 0.20, 0.30], 0.006, 3200, 0.55))  # 刀刃切入的脆声
    cr = filt(noise(n), "bp", 3400, 0.9)                             # 菜叶的沙沙
    e = env_exp(n, 0.02, 0.3, 1.2)
    for i in range(n):
        out[i] += 0.20 * cr[i] * e[i]
    return out


def sfx_sandwich():
    """三明治：面包放上烤盘的一声闷响 + 轻微炙烤。"""
    n = int(SR * 0.5)
    out = [0.0] * n
    mix(out, sweep_tone(n, 220, 110, 0.85, 0.07))                    # 闷响
    sz = filt(noise(n), "hp", 3000)
    e = env_exp(n, 0.02, 0.35, 1.6)
    for i in range(n):
        out[i] += 0.45 * sz[i] * e[i]
    mix(out, clicks(n, [0.14, 0.25, 0.37], 0.008, 2800, 0.22))
    out = filt(out, "hp", 260)
    return out


BUILD = {
    "cook_juice": sfx_juice, "cook_egg": sfx_egg, "cook_bacon": sfx_bacon,
    "cook_bun": sfx_bun, "cook_milk": sfx_milk, "cook_soup": sfx_soup,
    "cook_congee": sfx_congee, "cook_salad": sfx_salad, "cook_sandwich": sfx_sandwich,
}


# ══════════════════ 落盘 / 加工 ══════════════════
def normalize(x, peak=0.92):
    m = max(1e-9, max(abs(v) for v in x))
    g = peak / m
    return [v * g for v in x]


def dc_block(x):
    out = [0.0] * len(x)
    prev_x = prev_y = 0.0
    for i, v in enumerate(x):
        y = v - prev_x + 0.995 * prev_y
        out[i] = y
        prev_x, prev_y = v, y
    return out


def write_wav(path, x):
    """float 列表 → 16bit PCM WAV（标准库 wave）。"""
    x = dc_block(normalize(x))
    a = array.array("h", (int(max(-1.0, min(1.0, v)) * 32767) for v in x))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(a.tobytes())


def master(src_wav, dst_mp3):
    """48kHz / 单声道 / 128kbps；SFX 统一到 -18 LUFS（比语音 -16 略低，留出叠加余量）。"""
    # 掐掉首尾静音；两端各 3ms / 20ms 淡入淡出（避免掐断爆音）
    dur = 0.0
    try:
        with wave.open(src_wav, "rb") as w:
            dur = w.getnframes() / float(w.getframerate())
    except Exception:
        pass
    af = ("silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak,"
          "areverse,"
          "silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak,"
          "areverse,"
          f"afade=t=in:st=0:d=0.003,afade=t=out:st={max(0.0, dur - 0.02):.3f}:d=0.02,"
          "loudnorm=I=-18:TP=-2.0:LRA=8,aresample=48000")
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", src_wav,
           "-af", af, "-ac", "1", "-ar", "48000", "-c:a", "libmp3lame", "-b:a", "128k", dst_mp3]
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode == 0, (p.stderr or "").strip()[:400]


def probe_info(path):
    if shutil.which(FFPROBE) is None:
        return None
    cmd = [FFPROBE, "-v", "error", "-show_entries",
           "stream=sample_rate,channels,duration,bit_rate", "-of", "json", path]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True)
        st = (json.loads(p.stdout or "{}").get("streams") or [{}])[0]
        return {"sample_rate": st.get("sample_rate"), "channels": st.get("channels"),
                "duration": round(float(st.get("duration") or 0), 3), "bit_rate": st.get("bit_rate")}
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description="合成早餐店下锅音效（纯标准库 DSP + ffmpeg 加工）")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--work", default=WORK, help="中间 WAV 目录（不入库）")
    ap.add_argument("--only", help="只做指定条目（逗号分隔：juice,egg,...）")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    table = list(DESIGN)
    if args.only:
        want = {"cook_" + x.strip() for x in args.only.split(",") if x.strip()}
        want |= {x.strip() for x in args.only.split(",") if x.strip()}
        table = [t for t in table if t[0] in want]
        if not table:
            print("--only 未匹配到条目")
            return 1

    if args.list or args.dry_run:
        for name, cn, desc in table:
            print(f"  {name + '.mp3':<20} {cn:<14} {desc}")
        return 0

    if shutil.which(FFMPEG) is None:
        print("错误：PATH 里没有 ffmpeg（本机没有 numpy，加工只能走 ffmpeg）", file=sys.stderr)
        return 2
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.work, exist_ok=True)

    ok = skip = fail = 0
    rows = []
    for name, cn, desc in table:
        dst = os.path.join(args.out, name + ".mp3")
        raw = os.path.join(args.work, name + ".wav")
        if os.path.exists(dst) and os.path.getsize(dst) > 800 and not args.force:
            print(f"  {name}.mp3  跳过（已存在）")
            skip += 1
            continue
        try:
            x = BUILD[name]()
        except Exception as e:
            print(f"  {name}  合成失败：{type(e).__name__}: {e}")
            fail += 1
            continue
        write_wav(raw, x)
        good, err = master(raw, dst)
        if not good:
            print(f"  {name}  ffmpeg 加工失败：{err}")
            fail += 1
            continue
        info = probe_info(dst)
        spek = (f" · {info['duration']:.2f}s / {info['sample_rate']}Hz / {info['channels']}ch"
                if info else "")
        print(f"  {name + '.mp3':<20} {cn:<14} {os.path.getsize(dst):>6,} B{spek}   {desc}")
        rows.append({"file": name + ".mp3", "cn": cn, "desc": desc, "info": info})
        ok += 1

    print(f"\n成功 {ok} · 跳过 {skip} · 失败 {fail} · 共 {len(table)}")
    if rows:
        rep = os.path.join(args.work, "_bf_cook_sfx_report.json")
        with open(rep, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=1)
        print(f"报告：{rep}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
