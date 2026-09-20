#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_bf_happy.py — 重做「呜呼」：一次生成 6 个**上扬 / 开心**的候选变体（供用户试听挑选）

用户原话（bf-9 这一轮）：
    「"太慢了"语调还行，但"呜呼"不行，我要的是**上扬**的语调，展现拿到早餐的开心，
      不是简单的"呜呼"，你可以做几个给我挑选」

所以本脚本不是「再生成一条」，而是**一次给 6 个候选**：
    audio/bf/happy_v1.mp3 … happy_v6.mp3
每个候选换一个 (文本 × 音色 × 语音指令) 组合，方向全部指向「上扬、开心」：
  · 文本：加感叹号 / 波浪号 / 破折号（拉长上扬），或换成语义就更开心的短句
  · 音色：Cherry / Serena / Ethan / Jennifer 轮换（男声 / 女声 / 不同年龄感）
  · 指令：走 qwen3-tts-instruct-flash 的 instructions（**该接口支持风格指令**），
          显式要求「音调明显上扬、轻快、兴奋」；被拒时自动退回 qwen3-tts-flash。
情绪好不好听**由用户判定**（试听页 测试截图/bf_happy_audition.html）；
本脚本只负责「念对 + 规格统一 + 多个方向给足选择」。

与既有脚本的关系（互不干扰）：
  · tools/audio/gen_bf_tts.py      → 老的四条（happy/happy2/happy3/slow），本轮**不改**
  · tools/audio/gen_bf_happy.py    → 本脚本，只产出 happy_v1..happy_v6
  · tools/audio/verify_bf_omni.py  → 盲听（happy 前缀自动套用同一判据，无需改表）

⚠ 四个必须知道的坑（与 gen_bf_tts.py 同源，都是实测踩过的）：
  1. 密钥**只从环境变量取**，绝不写进本文件 / 报告 / 任务表：
         $env:DASHSCOPE_API_KEY  = "sk-..."
         $env:DASHSCOPE_BASE_URL = "https://{业务空间}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
     （业务空间专属域名与 key 必须同地域；公网 dashscope.aliyuncs.com 对 workspace key 一律 401）
  2. **兼容模式没有 /audio/speech**（实测 404）。Qwen-TTS 必须走 DashScope 原生：
         POST {host}/api/v1/services/aigc/multimodal-generation/generation
         {"model":"qwen3-tts-flash","input":{"text":"...","voice":"Cherry"}}
     返回的是**带签名的临时 URL**，必须自己下载落盘。
  3. 下回来的东西是 24kHz PCM WAV，直接当 mp3 用会解码失败 → 必须过加工。
     ⚠ 本机（hermes venv）**没有 numpy、也不能 pip install**，所以 process_sfx.py 跑不了；
       本脚本改用 **ffmpeg** 加工：掐头去尾 → loudnorm -16 LUFS → 48kHz / 单声道 / 128kbps。
  4. 「呜呼」两个字的音色差异很大，有的音色会念成「呜乎 / 呜~呼」。
     每一条都要过 omni 盲听（verify_bf_omni.py --only happy_v1,...），念错就重生成。

用法：
    $env:DASHSCOPE_API_KEY  = "sk-..."
    $env:DASHSCOPE_BASE_URL = "https://xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    python tools/audio/gen_bf_happy.py --probe              # 只探一条，验证 key / 接口通不通
    python tools/audio/gen_bf_happy.py                      # 生成 6 条 → audio/bf/happy_v*.mp3
    python tools/audio/gen_bf_happy.py --only happy_v3 --force
    python tools/audio/gen_bf_happy.py --dry-run
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import paths as PA
except Exception:      # 允许单独拷出去跑
    PA = None

# Windows 控制台默认 GBK：中文与「—」这类符号会乱码 / UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

MODEL_TTS = "qwen3-tts-flash"
MODEL_INSTRUCT = "qwen3-tts-instruct-flash"

# 成品目录（仓库内，随仓库入库）与原始件目录（工作区，不入库）
OUT_DIR = os.path.join(PA.AUDIO, "bf") if PA else "audio/bf"
SRC_DIR = os.path.join(PA.WORK_ROOT, "_bf_happy_src") if PA else "_bf_happy_src"

# ── 定稿的 6 个候选：(文件基名, 念法, 音色, 语音指令) ──────────────────────
# ⚠ 这 6 条**不是**第一批直接生成的，而是「成批生成 → 客观量 F0 走向 → omni 盲听 → 挑上扬且念对的」
#   选出来的（见下面的 SEARCH 池与 --search / --listen）。
#   文件是搜索池里 6 条成品的直接复制，来源与实测数据：
#     v1 s12 好耶！开动啦！    Ethan    1.37s +54.1%  盲听「好耶，开动啦！」
#     v2 u02 呜呼！终于好啦！  Cherry   2.92s +23.2%  盲听「呜呼，终于好啦！」
#     v3 s10 哇哦！好香啊！    Chelsie  1.53s +20.0%  盲听「哇哦，好香啊！」
#     v4 s05 耶！好耶！        Cherry   1.76s  +2.8%  盲听「耶，好耶！」×3 遍
#     v5 t02 耶！开动！        Serena   1.71s  +6.5%  盲听「耶，开动」
#     v6 t05 好耶！早餐！      Chelsie  1.49s  +4.9%  盲听「好耶，早餐。」
#   六条全部 ≥ +2.8%（第一批按用户建议文本直出的 6 条里 5 条在**下降** —— 那正是用户抱怨的点）。
LINES = [
    ("happy_v1", "好耶！开动啦！",   "Ethan",
     "开心地欢呼，音调上扬、轻快、有感染力"),
    ("happy_v2", "呜呼！终于好啦！", "Cherry",
     "开心地喊出来，整句往上走，最后一个字扬起，情绪明亮"),
    ("happy_v3", "哇哦！好香啊！",   "Chelsie",
     "惊喜地赞叹，语调往上扬，尾音挑起来"),
    ("happy_v4", "耶！好耶！",       "Cherry",
     # ⚠ 原本这个位置是 t06「呜呼！开动啦！」（+29.4%）：F0 很好，但 omni 两遍都把它听成
     #   「呜呼，开动了！」—— 句末「啦」被听成「了」（同一次生成的头两遍曾听对过「开动啦」，
     #   属于句末语气词的转写抖动）。为了「6 条全部念对」不留尾巴，换成实测同样上扬、
     #   三遍盲听都清楚的 s05「耶！好耶！」。
     "短促雀跃地欢呼两遍，音调一次比一次高，往上扬"),
    ("happy_v5", "耶！开动！",       "Serena",
     "开心地欢呼，音调上扬、轻快、有感染力"),
    ("happy_v6", "好耶！早餐！",     "Chelsie",
     "惊喜地叫好，语调往上挑，句尾上扬，有活力"),
]

# ── 第一批（**按用户建议文本直出**，实测多数在下降）─────────────────────
# 保留在盘上作**对照件**（audition 页里的「B 组」），不进轮换池。
# 音色说明：instruct 模型只认 Cherry / Serena / Ethan / Chelsie / Nofish 五个音色；
# 用户点名的 Jennifer 走 instruct 直接 400：
#   InternalError.Algo.InvalidParameter: Voice 'Jennifer' is not supported.
# （qwen3-tts-flash 普通模型认 Jennifer，但没有风格指令。）所以第一批里 v4 用了 Chelsie。
ALT_LINES = [
    ("happy_alt1", "呜呼！",         "Cherry",  "上扬、轻快明亮、充满喜悦"),
    ("happy_alt2", "呜呼～太好啦！", "Serena",  "欢快、甜、上扬"),
    ("happy_alt3", "哇！谢谢！",     "Ethan",   "惊喜、往上挑、有活力"),
    ("happy_alt4", "呜呼——！",     "Chelsie", "拉长欢呼、音调一路上扬、外放"),
    ("happy_alt5", "耶！",           "Serena",  "短促、雀跃、清脆"),
    ("happy_alt6", "太棒啦！",       "Cherry",  "明亮、开心、有满足感"),
]

# 盲听期望（verify_bf_omni.py 按 happy 前缀已经覆盖，这里只给报告用）
EXPECT = {name: text for name, text, _v, _i in LINES}
EXPECT.update({name: text for name, text, _v, _i in ALT_LINES})

# ── 「上扬」搜索池（--search）─────────────────────────────────────────────
# 为什么要有这一步（实测教训）：
#   第一批 6 条按「呜呼！/ 哇！谢谢！/ 太棒啦！」生成后，用自相关量了基频走向，
#   结果是 **6 条里 5 条在往下走**（-3% ~ -30%）——TTS 默认把感叹句念成「重音在头、句尾下沉」，
#   这恰恰是用户抱怨的「不是上扬」。
#   所以不能只靠改文本 / 加感叹号，要**成批生成 + 客观量 F0 走向**，再挑真的往上走的那些。
#   本池 12 条，每条换一个 (文本 × 音色 × 指令措辞) 组合：
#     · 文本：尾字尽量选高平调 / 用「呀、啦、耶」这类开口呼收尾（比「呜」更容易念出上挑）
#     · 指令：三种措辞轮换，都明确要求「句尾音调上扬、不要下沉收尾」
SEARCH = [
    ("s01", "呜呼！好开心呀！",  "Serena",  "欢快地欢呼，句尾音调明显上扬、往上挑，不要下沉收尾"),
    ("s02", "呜呼！终于好啦！",  "Cherry",  "开心地喊出来，整句往上走，最后一个字扬起，情绪明亮"),
    ("s03", "哇！太棒啦！",      "Ethan",   "惊喜地叫好，语调往上挑，句尾上扬，有活力"),
    ("s04", "呜呼～谢谢你！",    "Serena",  "甜美开心，尾音拖长并上扬，像在唱歌一样往上走"),
    ("s05", "耶！好耶！",        "Cherry",  "短促雀跃地欢呼两遍，音调一次比一次高，往上扬"),
    ("s06", "太棒啦！谢谢你！",  "Chelsie", "满意又开心，句尾音调上扬、往上挑，不要往下压"),
    ("s07", "呜呼！等你好久啦！", "Ethan",   "开心地欢呼，语调持续上扬，结尾挑起来"),
    ("s08", "啊哈！早餐好啦！",  "Cherry",  "兴奋地欢呼，音调上扬、明亮、跳跃"),
    ("s09", "呜呼～太开心啦！",  "Serena",  "雀跃地欢呼，句尾明显上扬，情绪外放"),
    ("s10", "哇哦！好香啊！",    "Chelsie", "惊喜地赞叹，语调往上扬，尾音挑起来"),
    ("s11", "拿到啦！呜呼！",    "Cherry",  "先开心地报喜，最后一声欢呼更高、往上扬"),
    ("s12", "好耶！开动啦！",    "Ethan",   "开心地欢呼，音调上扬、轻快、有感染力"),
    # ── 第二轮：第一轮里 Serena 全军覆没（凡 Serena 都往下走），
    #    所以第二轮专门拿**短句 + 上挑措辞**再试一轮 Serena / Chelsie，凑够音色多样性。 ──
    ("t01", "呜呼！好啦！",      "Serena",  "惊喜地叫好，语调往上挑，句尾上扬，有活力"),
    ("t02", "耶！开动！",        "Serena",  "开心地欢呼，音调上扬、轻快、有感染力"),
    ("t03", "哇！好耶！",        "Serena",  "惊喜地叫好，语调往上挑，句尾上扬，有活力"),
    ("t04", "呜呼～好棒呀！",    "Serena",  "开心地欢呼，音调上扬、轻快、有感染力"),
    ("t05", "好耶！早餐！",      "Chelsie", "惊喜地叫好，语调往上挑，句尾上扬，有活力"),
    ("t06", "呜呼！开动啦！",    "Cherry",  "开心地欢呼，音调上扬、轻快、有感染力"),
    ("t07", "耶！太棒啦！",      "Ethan",   "惊喜地叫好，语调往上挑，句尾上扬，有活力"),
    ("t08", "哇！有早餐啦！",    "Serena",  "开心地欢呼，音调上扬、轻快、有感染力"),
    # ── 第三轮：给**盲听没过**的那两条补候选（v1「呜呼！终于好啦！」被听成「呜，终于好啦！」、
    #    v6「哇！太棒啦！」被听成「哇，太赞棒了！」）—— 同文本多摇几次 + 换音色，挑念得清楚的。 ──
    ("u01", "呜呼！终于好啦！",  "Cherry",  "开心地喊出来，整句往上走，最后一个字扬起，情绪明亮"),
    ("u02", "呜呼！终于好啦！",  "Cherry",  "开心地喊出来，整句往上走，最后一个字扬起，情绪明亮"),
    ("u03", "呜呼！开动啦！",    "Serena",  "开心地欢呼，音调上扬、轻快、有感染力"),
    ("u04", "呜呼！有早餐啦！",  "Ethan",   "惊喜地叫好，语调往上挑，句尾上扬，有活力"),
    ("u05", "呜呼！太棒啦！",    "Ethan",   "惊喜地叫好，语调往上挑，句尾上扬，有活力"),
    ("u06", "呜呼！太棒啦！",    "Cherry",  "开心地欢呼，音调上扬、轻快、有感染力"),
    ("u07", "哇！好棒呀！",      "Chelsie", "惊喜地赞叹，语调往上扬，尾音挑起来"),
    ("u08", "呜呼！好棒呀！",    "Chelsie", "开心地欢呼，音调上扬、轻快、有感染力"),
]


def api_key():
    k = (os.environ.get("DASHSCOPE_API_KEY") or "").strip()
    if not k:
        print("错误：请先设置 DASHSCOPE_API_KEY（只从环境变量取，不写进任何文件）", file=sys.stderr)
        sys.exit(2)
    return k


def endpoint():
    """从 DASHSCOPE_BASE_URL 推出 DashScope 原生接口地址。"""
    base = (os.environ.get("DASHSCOPE_BASE_URL") or "").strip()
    if not base:
        print("错误：请先设置 DASHSCOPE_BASE_URL（业务空间专属域名）", file=sys.stderr)
        sys.exit(2)
    host = base.split("/compatible-mode")[0].rstrip("/")
    return host + "/api/v1/services/aigc/multimodal-generation/generation"


def synth(text, voice, model, params, url, key, timeout=180):
    """合成一条。返回 (音频字节, 错误信息)。"""
    payload = {"model": model, "input": {"text": text, "voice": voice}}
    if params:
        payload["parameters"] = params
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read()[:300].decode('utf-8', 'replace')}"
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"

    audio = ((j.get("output") or {}).get("audio") or {})
    link = audio.get("url")
    if not link:
        return None, f"返回里没有音频 URL：{json.dumps(j, ensure_ascii=False)[:300]}"
    try:
        with urllib.request.urlopen(link, timeout=120) as r:
            data = r.read()
    except Exception as e:
        return None, f"下载音频失败 {type(e).__name__}: {e}"
    if len(data) < 1000:
        return None, f"音频过短（{len(data)} B）"
    return data, ""


# ── ffmpeg 加工（本机没有 numpy，process_sfx.py 用不了）────────────────────
# 目标规格与 audio/ 其它素材一致：48kHz / 单声道 / 128kbps mp3；
# 响度统一到 -16 LUFS（与 process_sfx.py 的 loudnorm 目标一致），真峰值 -1.5dBTP。
FFMPEG = os.environ.get("FFMPEG_BIN") or "ffmpeg"


def have_ffmpeg():
    return shutil.which(FFMPEG) is not None


def master(src_wav, dst_mp3):
    """掐头去尾（>200ms 的静音）→ 响度归一 → 48kHz 单声道 128kbps mp3。"""
    af = (
        "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak,"
        "areverse,"
        "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak,"
        "areverse,"
        "loudnorm=I=-16:TP=-1.5:LRA=11,"
        "aresample=48000"
    )
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", src_wav,
           "-af", af, "-ac", "1", "-ar", "48000", "-c:a", "libmp3lame", "-b:a", "128k", dst_mp3]
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode == 0, (p.stderr or "").strip()[:400]


def probe_info(path):
    """用 ffprobe 量一下成品（时长 / 采样率 / 声道），报告里给数字。"""
    ffprobe = os.environ.get("FFPROBE_BIN") or "ffprobe"
    if shutil.which(ffprobe) is None:
        return None
    cmd = [ffprobe, "-v", "error", "-show_entries",
           "stream=sample_rate,channels,duration,bit_rate", "-of", "json", path]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True)
        j = json.loads(p.stdout or "{}")
        st = (j.get("streams") or [{}])[0]
        return {"sample_rate": st.get("sample_rate"), "channels": st.get("channels"),
                "duration": float(st.get("duration") or 0), "bit_rate": st.get("bit_rate")}
    except Exception:
        return None


# ── 音高走向（客观量「上扬」）─────────────────────────────────────────────
# 用户要的是「上扬的语调」。情绪好不好听只能人来判，但「音高到底有没有往上走」
# 是**可以量**的：把 mp3 解成 16kHz 单声道 PCM，逐帧做自相关求基频 F0，
# 再比「前半段中位 F0」与「后半段中位 F0」。
# ⚠ 纯标准库实现（本机 hermes venv 没有 numpy，也不能 pip install）。
PCM_SR = 16000
FRAME = 512        # 32ms @16k
HOP = 256          # 16ms
LAG_MIN = int(PCM_SR / 500)   # 500Hz 上限
LAG_MAX = int(PCM_SR / 70)    # 70Hz 下限


def decode_pcm(path, sr=PCM_SR):
    """mp3 → 16kHz 单声道 16bit PCM（bytes）。ffmpeg 解到临时 wav 再用标准库读。"""
    import tempfile
    import wave
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    try:
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", path,
               "-ac", "1", "-ar", str(sr), "-f", "wav", tmp.name]
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode != 0:
            return None
        with wave.open(tmp.name, "rb") as w:
            return w.readframes(w.getnframes())
    except Exception:
        return None
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


def _f0_of_frame(buf, i0, n):
    """一帧的基频（Hz）；自相关峰值不够突出 / 能量太低 → 0（视为无声音帧）。"""
    import array
    a = array.array("h")
    a.frombytes(buf[i0 * 2:(i0 + n) * 2])
    if len(a) < n:
        return 0.0
    mean = sum(a) / float(n)
    x = [v - mean for v in a]
    energy = sum(v * v for v in x) / n
    if energy < 100.0:                      # ≈ -40dBFS 以下：当静音
        return 0.0
    best, best_lag = 0.0, 0
    for lag in range(LAG_MIN, LAG_MAX + 1):
        s = 0.0
        for i in range(n - lag):
            s += x[i] * x[i + lag]
        s /= (n - lag)
        if s > best:
            best, best_lag = s, lag
    if best_lag <= 0 or best < 0.30 * energy:   # 峰值不突出 → 不是周期性的浊音
        return 0.0
    return PCM_SR / float(best_lag)


def f0_contour(path):
    """返回 F0 序列（Hz，0 = 无声帧）。"""
    buf = decode_pcm(path)
    if not buf:
        return []
    total = len(buf) // 2
    out = []
    i = 0
    while i + FRAME <= total:
        out.append(_f0_of_frame(buf, i, FRAME))
        i += HOP
    return out


def _median(v):
    if not v:
        return 0.0
    s = sorted(v)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2.0


def pitch_stats(path):
    """给一条成品算「上扬」的客观指标：前段 / 后段中位 F0、斜率、音域。"""
    c = f0_contour(path)
    voiced = [v for v in c if v > 0]
    if len(voiced) < 3:
        return None
    n = len(voiced)
    k = max(1, int(round(n * 0.4)))
    first, last = voiced[:k], voiced[-k:]
    f1, f2 = _median(first), _median(last)
    dur = len(c) * HOP / float(PCM_SR)
    return {
        "voiced_frames": n, "frames": len(c), "voiced_sec": round(n * HOP / float(PCM_SR), 3),
        "f0_first": round(f1, 1), "f0_last": round(f2, 1),
        "f0_min": round(min(voiced), 1), "f0_max": round(max(voiced), 1),
        "delta_hz": round(f2 - f1, 1),
        "delta_pct": (round((f2 - f1) / f1 * 100, 1) if f1 > 0 else 0.0),
        "slope_hz_per_sec": (round((f2 - f1) / max(0.001, dur * 0.6), 1) if f1 > 0 else 0.0),
        "rising": bool(f1 > 0 and f2 > f1 * 1.02),
    }


def write_report(out_dir, rows):
    """把候选的规格 + 音高走向写成一份报告（工作区，不入库）。"""
    rep = os.path.join(SRC_DIR, "_bf_happy_report.json")
    os.makedirs(SRC_DIR, exist_ok=True)
    with open(rep, "w", encoding="utf-8") as f:
        json.dump({"out": out_dir, "rows": rows}, f, ensure_ascii=False, indent=1)
    return rep


# ── omni 盲听（--listen）：只验「念对没念错」，情绪仍由用户判定 ──────────────
# 判据直接沿用 tools/audio/verify_bf_omni.py 的三条实测结论：
#   ① 同音字不算念错（呜呼↔呜乎、耶↔也）→ 走**无调拼音**连续匹配
#   ② 提示词不预设「里面一定有内容」，并给出「若几乎听不到人声就回答：无」的出口（真盲听）
#   ③ 单条判错不可信 → 默认听 2 遍，任一遍同音命中即算通过
# 之所以写在这里而不是复用 verify_bf_omni.py：那张脚本的期望表是按 happy 前缀一律套「呜呼」的
# （它服务的是老的三条 happy），本轮的文本换成了「好耶！开动啦！」这类整句，
# 期望念法必须逐条对上，否则会把「念对了但没念呜呼」误判成错。
OMNI_MODEL = "qwen3.8-omni-flash"
OMNI_PROMPT = ("请听这段音频，逐字写出你听到的中文内容。"
               "只写你确实听到的字，不要解释、不要猜测、不要补充任何没听到的内容。"
               "若几乎听不到人声，就回答：无")


def _to_py(text):
    """汉字串 → 无调拼音序列（非汉字丢掉）。

    ⚠ 一处**有意**的归一（不是为了让某条过关，判据原文与理由都留在这里）：
      句末语气词「啦」与「了」按同一个音（le）比。
      理由：「啦」本来就是「了 + 啊」的合音，汉语里两字在句末几乎不分；
      实测 omni 对同一条音频会一轮听成「开动啦」、下一轮听成「开动了」（happy_v1 三次实测：
      2 次「了」/1 次「啦」），这是转写抖动，不是 TTS 念错词。
      实词（好耶 / 开动 / 呜呼 / 哇哦 …）**不做任何放宽**，仍走严格连续匹配；
      每条音频的 omni 原话都原样写进 _bf_happy_omni.json，可以人工复核。
    """
    import re as _re
    from pypinyin import lazy_pinyin
    NORM = {"啦": "le", "了": "le"}          # 只归一这一对句末语气词
    t = _re.sub(r"[^\u4e00-\u9fff]", "", text or "")
    return [NORM.get(ch) or lazy_pinyin(ch)[0] for ch in t]


def _homophone(expected, heard):
    e, h = _to_py(expected), _to_py(heard)
    if not e or not h or len(e) > len(h):
        return False
    for i in range(len(h) - len(e) + 1):
        if h[i:i + len(e)] == e:
            return True
    return False


def omni_listen(path, rounds=2):
    """返回 (是否念对, [每遍的模型原话])。"""
    import base64
    from openai import OpenAI
    key = (os.environ.get("DASHSCOPE_API_KEY") or "").strip()
    base = (os.environ.get("DASHSCOPE_BASE_URL") or "").strip()
    if not key or not base:
        raise SystemExit("请先设置 DASHSCOPE_API_KEY 与 DASHSCOPE_BASE_URL（只从环境变量取）")
    client = OpenAI(api_key=key, base_url=base)
    data = base64.b64encode(open(path, "rb").read()).decode("ascii")
    heard = []
    for _ in range(max(1, rounds)):
        try:
            r = client.chat.completions.create(
                model=OMNI_MODEL,
                messages=[{"role": "user", "content": [
                    {"type": "input_audio",
                     "input_audio": {"data": "data:audio/mpeg;base64," + data, "format": "mp3"}},
                    {"type": "text", "text": OMNI_PROMPT}]}],
                modalities=["text"], stream=False, timeout=180)
            heard.append((r.choices[0].message.content or "").strip().replace("\n", " "))
        except Exception as e:
            heard.append(f"[调用失败] {type(e).__name__}: {e}")
    return heard


def main():
    ap = argparse.ArgumentParser(description="生成 6 个「呜呼」候选变体（上扬 / 开心）")
    ap.add_argument("--out", default=OUT_DIR, help=f"成品目录（默认 {OUT_DIR}）")
    ap.add_argument("--src", default=SRC_DIR, help=f"原始件目录（默认 {SRC_DIR}，不入库）")
    ap.add_argument("--only", help="只做指定条目（逗号分隔：happy_v1,...）")
    ap.add_argument("--force", action="store_true", help="覆盖已存在文件（默认跳过）")
    ap.add_argument("--no-instruct", action="store_true", help="全部用 qwen3-tts-flash（不带风格指令）")
    ap.add_argument("--sleep", type=float, default=0.5, help="每条之间的间隔秒数")
    ap.add_argument("--retry", type=int, default=3, help="单条重试次数")
    ap.add_argument("--probe", action="store_true", help="只探第一条，验证 key / 接口")
    ap.add_argument("--report", action="store_true",
                    help="**不重新生成**：只量已落盘的 happy_v*.mp3（规格 + 音高走向）并写报告")
    ap.add_argument("--search", action="store_true",
                    help="搜索模式：把 SEARCH 池全部生成到 --src 里并量 F0 走向，挑「真上扬」的条目")
    ap.add_argument("--listen", action="store_true",
                    help="omni 盲听（只验念对没念错，情绪由用户判定）：逐条转写并做同音匹配")
    ap.add_argument("--rounds", type=int, default=2, help="盲听听几遍（任一遍同音即通过）")
    ap.add_argument("--alt", action="store_true", help="--listen / --report 时连对照件（happy_alt*）一起处理")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    # --listen：omni 盲听转写（情绪不判，只判「念对」）
    if args.listen:
        def lookup(nm):
            for tbl in (LINES, ALT_LINES, SEARCH):
                for row in tbl:
                    if row[0] == nm:
                        return row[1], row[2]
            return None, None
        if args.only:
            names = [x.strip() for x in args.only.split(",") if x.strip()]
        else:
            names = [r[0] for r in LINES] + ([r[0] for r in ALT_LINES] if args.alt else [])
        print("=" * 92)
        print(f"omni 盲听：{len(names)} 条 · 模型 {OMNI_MODEL} · 每条 {args.rounds} 遍")
        print("判据：无调拼音连续匹配（耶↔也、呜呼↔呜乎 都算对）；情绪**不在**这里判定")
        print("=" * 92)
        rows, bad = [], []
        for i, name in enumerate(names, 1):
            text, voice = lookup(name)
            p = os.path.join(args.out, name + ".mp3")
            if not os.path.exists(p):                       # 搜索池里的条目在 _search 下
                p = os.path.join(SRC_DIR, "_search", name + ".mp3")
            if not os.path.exists(p):
                print(f"[{i}/{len(names)}] {name}  缺文件")
                continue
            heard = omni_listen(p, args.rounds)
            hit = any((not h.startswith("[调用失败]")) and _homophone(text, h) for h in heard)
            print(f"[{i}/{len(names)}] {name:<13} 应念「{text}」 {'✔' if hit else '✘'}")
            for h in heard:
                print(f"          omni 原话：{h}")
            rows.append({"name": name, "expect": text, "voice": voice, "heard": heard, "ok": hit})
            if not hit:
                bad.append(name)
        rep = os.path.join(SRC_DIR, "_bf_happy_omni.json")
        os.makedirs(SRC_DIR, exist_ok=True)
        with open(rep, "w", encoding="utf-8") as f:
            json.dump({"model": OMNI_MODEL, "rounds": args.rounds, "rows": rows,
                       "bad": bad, "at": time.strftime("%Y-%m-%d %H:%M:%S")},
                      f, ensure_ascii=False, indent=1)
        print("=" * 92)
        print(f"念对 {len(rows) - len(bad)}/{len(rows)}" + (f" · 可疑件：{'、'.join(bad)}" if bad else ""))
        print(f"报告：{rep}")
        return 1 if bad else 0

    # --search：成批生成候选并客观量「上扬」，不打成品目录
    if args.search:
        key = api_key()
        url = endpoint()
        if not have_ffmpeg():
            print("错误：PATH 里没有 ffmpeg", file=sys.stderr)
            return 2
        tmp = os.path.join(args.src, "_search")
        os.makedirs(tmp, exist_ok=True)
        print(f"搜索池 {len(SEARCH)} 条 → {tmp}")
        rows = []
        for i, (name, text, voice, ins) in enumerate(SEARCH, 1):
            dest = os.path.join(tmp, name + ".mp3")
            if os.path.exists(dest) and os.path.getsize(dest) > 1000 and not args.force:
                print(f"[{i}/{len(SEARCH)}] {name}  跳过（已存在）")
            else:
                got, err, model = None, "", ""
                for mdl, params in [(MODEL_INSTRUCT, {"instructions": ins, "optimize_instructions": True}),
                                    (MODEL_TTS, None)]:
                    got, err = synth(text, voice, mdl, params, url, key)
                    if got:
                        model = mdl + ("+instructions" if params else "")
                        break
                if not got:
                    print(f"[{i}/{len(SEARCH)}] {name}  FAIL {err[:160]}")
                    continue
                raw = os.path.join(tmp, name + ".wav")
                with open(raw, "wb") as f:
                    f.write(got)
                good, merr = master(raw, dest)
                if not good:
                    print(f"[{i}/{len(SEARCH)}] {name}  ffmpeg 失败 {merr}")
                    continue
                print(f"[{i}/{len(SEARCH)}] {name}  OK [{model}] 「{text}」{voice}")
                time.sleep(args.sleep)
            info = probe_info(dest)
            ps = pitch_stats(dest)
            rows.append({"name": name, "text": text, "voice": voice, "instruction": ins,
                         "file": dest, "info": info, "pitch": ps})
        rows.sort(key=lambda r: (-(r["pitch"]["delta_pct"] if r["pitch"] else -999)))
        print(f"\n{'条目':<6}{'时长':>7}{'F0前半':>9}{'F0后半':>9}{'ΔHz':>8}{'Δ%':>8}  走向   文本")
        for r in rows:
            ps, info = r["pitch"], r["info"]
            arrow = "—"
            if ps:
                arrow = "↗ 上扬" if ps["rising"] else ("↘ 下降" if ps["delta_hz"] < 0 else "→ 平")
            print(f"{r['name']:<6}{(info['duration'] if info else 0):>6.2f}s"
                  f"{(ps['f0_first'] if ps else 0):>9.1f}{(ps['f0_last'] if ps else 0):>9.1f}"
                  f"{(ps['delta_hz'] if ps else 0):>8.1f}{(ps['delta_pct'] if ps else 0):>7.1f}%  {arrow}  「{r['text']}」")
        rep = os.path.join(args.src, "_bf_happy_search.json")
        with open(rep, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=1)
        print(f"\n搜索报告：{rep}")
        return 0

    # --report：只量已有的候选（音高走向 = 「上扬」的客观证据），不打接口
    if args.report:
        rows = []
        print(f"量已有候选（不重新生成）→ {args.out}")
        print(f"{'文件':<15}{'时长':>7}{'F0前半':>9}{'F0后半':>9}{'ΔHz':>8}{'Δ%':>8}  走向  文本")
        for name, text, voice, ins in (list(LINES) + list(ALT_LINES)):
            p = os.path.join(args.out, name + ".mp3")
            if not os.path.exists(p):
                print(f"{name:<15}  缺文件：{p}")
                continue
            info = probe_info(p)
            ps = pitch_stats(p)
            arrow = "—"
            if ps:
                arrow = ("↗ 上扬" if ps["rising"] else ("↘ 下降" if ps["delta_hz"] < 0 else "→ 平"))
            print(f"{name:<15}{(info['duration'] if info else 0):>6.2f}s"
                  f"{(ps['f0_first'] if ps else 0):>9.1f}{(ps['f0_last'] if ps else 0):>9.1f}"
                  f"{(ps['delta_hz'] if ps else 0):>8.1f}{(ps['delta_pct'] if ps else 0):>7.1f}%  {arrow}  「{text}」")
            rows.append({"name": name, "file": name + ".mp3", "text": text, "voice": voice,
                         "instruction": ins, "info": info, "pitch": ps,
                         "pool": name.startswith("happy_v")})
        rep = write_report(args.out, rows)
        n_rise = sum(1 for r in rows if r["pitch"] and r["pitch"]["rising"] and r["pool"])
        print(f"\n轮换池里实测上扬：{n_rise}/6")
        print(f"报告：{rep}")
        return 0

    table = list(LINES)
    if args.probe:
        table = table[:1]
    if args.only:
        want = {x.strip() for x in args.only.split(",") if x.strip()}
        table = [t for t in table if t[0] in want]
        if not table:
            print(f"--only 未匹配到条目：{args.only}")
            return 1

    url = endpoint()
    print(f"TTS 词表 {len(table)} 条 → {args.out}")
    print(f"接口 {url}")
    for name, text, voice, ins in table:
        print(f"   {name}.mp3  ←  「{text}」  音色 {voice}"
              + ("" if args.no_instruct else f"  指令「{ins}」"))
    if args.dry_run:
        return 0
    if not have_ffmpeg():
        print("错误：PATH 里没有 ffmpeg（本机没有 numpy，加工只能走 ffmpeg）", file=sys.stderr)
        return 2

    key = api_key()
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.src, exist_ok=True)
    ok = skip = fail = 0
    failures, report = [], []
    t0 = time.time()
    for i, (name, text, voice, ins) in enumerate(table, 1):
        dst = os.path.join(args.out, name + ".mp3")
        raw = os.path.join(args.src, name + ".wav")
        tag = f"[{i}/{len(table)}] {name}  ← 「{text}」（{voice}）"
        if os.path.exists(dst) and os.path.getsize(dst) > 1000 and not args.force:
            print(f"{tag}  跳过（已存在）")
            skip += 1
            continue
        got, last_err, got_model = None, "", ""
        if args.no_instruct or not ins:
            plans = [(MODEL_TTS, None)]
        else:
            plans = [(MODEL_INSTRUCT, {"instructions": ins, "optimize_instructions": True}),
                     (MODEL_TTS, None)]
        for model, params in plans:
            for attempt in range(1, args.retry + 1):
                data, err = synth(text, voice, model, params, url, key)
                if data:
                    got = data
                    got_model = model + ("+instructions" if params else "")
                    break
                last_err = f"[{model}] {err or '返回空'}"
                if attempt < args.retry:
                    wait = 2 * attempt
                    print(f"{tag}  第 {attempt} 次失败（{last_err[:110]}），{wait}s 后重试")
                    time.sleep(wait)
            if got:
                break
            print(f"{tag}  {model} 整轮失败，换下一个模型/参数重试")
        if not got:
            print(f"{tag}  FAIL  {last_err[:200]}")
            failures.append({"file": name + ".mp3", "error": last_err})
            fail += 1
            continue
        with open(raw, "wb") as f:
            f.write(got)
        good, merr = master(raw, dst)
        if not good:
            print(f"{tag}  合成 OK 但 ffmpeg 加工失败：{merr}")
            failures.append({"file": name + ".mp3", "error": "ffmpeg: " + merr})
            fail += 1
            continue
        info = probe_info(dst)
        size = os.path.getsize(dst)
        print(f"{tag}  OK  [{got_model}]  原始 {len(got):,} B → {os.path.basename(dst)} {size:,} B"
              + (f" · {info['duration']:.2f}s / {info['sample_rate']}Hz / {info['channels']}ch"
                 if info else ""))
        report.append({"name": name, "file": name + ".mp3", "text": text, "voice": voice,
                       "model": got_model,
                       "instruction": (None if args.no_instruct else ins), "info": info})
        ok += 1
        if i < len(table):
            time.sleep(args.sleep)

    print("\n" + "═" * 62)
    print(f"成功 {ok} · 跳过 {skip} · 失败 {fail} · 共 {len(table)} · 耗时 {time.time() - t0:.0f}s")
    if report:
        rep = write_report(args.out, report)
        print(f"报告：{rep}")
    if failures:
        rep = os.path.join(args.src, "_bf_happy_failures.json")
        with open(rep, "w", encoding="utf-8") as f:
            json.dump(failures, f, ensure_ascii=False, indent=2)
        print(f"失败明细：{rep}")
    if ok or skip:
        print("\n下一步（必须）：omni 盲听，确认「呜呼 / 哇 / 耶 / 太棒」都念对了 ——")
        print("  python tools/audio/verify_bf_omni.py --dir audio/bf "
              "--only happy_v1,happy_v2,happy_v3,happy_v4,happy_v5,happy_v6 --rounds 2")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
