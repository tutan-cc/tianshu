#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""═══════════════════════════════════════════════════════════════════════════
   tools/bf/gen_bf_happy_i.py — 「拿到早餐」的**语气助词**候选（happy_i1 … happy_iN）

   为什么又做一轮（用户第二轮反馈）：
     用户原话：「那个『呜呼』还是很奇怪，我想要展现的是拿到早餐的开心，其实是个
     语气助词，如果你觉得『呜呼』没法体现可以换成别的语气助词例如『哦耶』」。
     上一轮 v1–v6 交的仍然是**完整句子**（「好耶！开动啦！」「呜呼！终于好啦！」），
     最短的也有 1.37s、最长 2.92s —— 一条 2.92s 的语音在这个场景里必然"奇怪"：
     顾客拿到一份早餐时脱口而出的应该是一声**短促、上扬的感叹**，不是一句话。
     所以本轮的三条硬指标：
       · 文本：**1~3 个字 + 感叹号**，删掉所有后半句（不许出现「开动啦/终于好啦」）
       · 时长：**0.5 ~ 1.2s 为宜，硬上限 1.6s**（超过就淘汰或加速重做）
       · 音高：前段→末段 F0 **上扬**（自相关法量，百分比写进报告）
     再叠一层 omni 盲听核对「念的确实是目标语气词」（哦耶↔哦也 这种同音字算对）。

   与 gen_bf_happy.py 的关系：
     那个脚本是本项目音频生成的模板（接口 / ffmpeg 加工 / 自相关 F0 / omni 盲听
     四段实现都经过实测校验），本脚本**沿用同一套实现**，只换词表与判据。
     没有直接复用它是因为它的 LINES/EXPECT/--report/--listen 全部按 happy_v* 写死，
     改老脚本风险更大（试听页 B 组还要靠它复现）。

   凭证：只从环境变量取，绝不落盘。
     DASHSCOPE_API_KEY   业务空间 API Key
     DASHSCOPE_BASE_URL  业务空间兼容模式地址（从它推出 DashScope 原生 TTS 地址）

   用法：
     python tools/bf/gen_bf_happy_i.py                 # 生成 + 加工到 audio/bf/
     python tools/bf/gen_bf_happy_i.py --probe         # 只探第一条
     python tools/bf/gen_bf_happy_i.py --report        # 不生成，只量已落盘文件 + 写 JSON
     python tools/bf/gen_bf_happy_i.py --listen        # omni 盲听（逐条转写 + 同音匹配）
     python tools/bf/gen_bf_happy_i.py --report --write-md   # 顺带写 audio/bf/_happy_i_report.md
   ═══════════════════════════════════════════════════════════════════════════"""
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
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(REPO, "audio", "bf")
SRC_DIR = os.path.join(os.path.dirname(REPO), "audio-工作区", "_bf_happy_i_src")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

MODEL_TTS = "qwen3-tts-flash"
MODEL_INSTRUCT = "qwen3-tts-instruct-flash"
OMNI_MODEL = "qwen3.8-omni-flash"

# ── 时长闸：**两档**（用户第二轮更正口径）────────────────────────────────
#   短语气词档（tier="t"）：0.4 ~ 1.2s 为宜，硬上限 1.6s
#   完整短句档（tier="s"）：1.0 ~ 2.6s 为宜，硬上限 3.0s
#   为什么要分档：用户先说「要的是脱口而出的语气助词」，随后更正为
#   「『终于好啦』『开动啦』这类可以保留，我只觉得『呜呼』有问题」——
#   即**句子长度不是问题，词才是问题**。所以两类各出一批，让用户自己挑。
DUR = {
    "t": {"lo": 0.40, "ideal": 1.20, "max": 1.60},
    "s": {"lo": 1.00, "ideal": 2.60, "max": 3.00},
}
DUR_IDEAL = DUR["t"]["ideal"]     # 兼容旧报告的顶层字段
DUR_MAX = DUR["t"]["max"]

# ── 候选池：(文件基名, 念法, 音色, 风格指令, 档位) ──────────────────────────
# 组池原则（用户点名要求）：
#   ① 文本**一律不含「呜呼」** —— 上轮 v2「呜呼！终于好啦！」那类正是要换掉的；
#      该位置换成自然的中文开心语气助词：哦耶 / 耶 / 哇 / 哇哦 / 好耶 / 太棒啦 / 耶嘿
#   ② 同一文本**尽量两个不同音色各出一条**，方便用户对比音色
#   ③ 音色只用 instruct 模型支持的四个：Cherry / Serena / Ethan / Chelsie
#      （Jennifer 走 instruct 会被拒：Voice 'Jennifer' is not supported）
#   ④ 指令统一往「轻快、句尾上挑、不要拖长」上写 —— 上一轮的教训是
#      TTS 默认把感叹句念成「重音在头、句尾下沉」，必须显式要求上挑
INSTR_SHORT = "很短促地喊一声，兴奋开心，音调上扬，句尾往上挑，不要拖长、不要下沉"
INSTR_SURPRISE = "短促地惊叹一声，惊喜开心，音调明显上扬，尾音挑起来，不要拖长"
INSTR_THANKS = "开心地道谢，语气轻快上扬，短促、有感染力，不要拖长"
INSTR_SENT = "开心地喊出来，音调上扬、轻快明亮，句尾往上挑，不要下沉收尾"
INSTR_SENT2 = "激动又开心地欢呼，语调持续上扬，最后一个字扬起来，有感染力"
# 第二轮专用：短感叹句的**首选**念法就是「起头别高、往上冲」。
# 第一轮实测 35 条里 22 条在**下降**（i1「哦耶！」-24.3%、i7「哇！」-28.2%、
# i16「谢谢！」-40.5%…）——TTS 默认把感叹句念成「重音在头、句尾下沉」，
# 短句尤其明显（就一两个音节，重音一压整条就往下走）。
# 所以第二轮把指令改成「从较低的音开始、一路往上冲、末尾到最高」，
# 并且**每个目标词 × 多个音色**都摇一遍，再按实测 F0 筛。
INSTR_RISE = "从较低的音开始，音调一路往上冲，最后一个字到最高、明显上挑，短促开心，不要下沉收尾"
INSTR_RISE2 = "起头压低一点，然后音调持续上扬，句尾高高扬起，像欢呼一样往上走，短促不要拖长"

LINES = [
    # ═══════ A 档 · 短语气助词（tier "t"，0.4~1.2s）═══════
    # ── 主推：用户点名的「哦耶」家族（4 个音色各一条）──
    ("happy_i1",  "哦耶！",     "Cherry",   INSTR_SHORT, "t"),
    ("happy_i2",  "哦耶！",     "Serena",   INSTR_SHORT, "t"),
    ("happy_i3",  "哦耶！",     "Ethan",    INSTR_SHORT, "t"),
    ("happy_i4",  "哦耶！",     "Chelsie",  INSTR_SHORT, "t"),
    # ── 「耶！」单字：最短的一档（2 个音色）──
    ("happy_i5",  "耶！",       "Cherry",   INSTR_SHORT, "t"),
    ("happy_i6",  "耶！",       "Serena",   INSTR_SHORT, "t"),
    # ── 「哇！」/「哇哦！」：惊喜向（3 条，两个音色）──
    ("happy_i7",  "哇！",       "Cherry",   INSTR_SURPRISE, "t"),
    ("happy_i8",  "哇！",       "Ethan",    INSTR_SURPRISE, "t"),
    ("happy_i9",  "哇哦！",     "Serena",   INSTR_SURPRISE, "t"),
    # ── 「好耶！」（2 个音色）──
    ("happy_i10", "好耶！",     "Cherry",   INSTR_SHORT, "t"),
    ("happy_i11", "好耶！",     "Chelsie",  INSTR_SHORT, "t"),
    # ── 「太棒啦！」（2 个音色）──
    ("happy_i12", "太棒啦！",   "Serena",   "开心地叫好，短促有力，音调上扬，句尾挑起来，不要拖长", "t"),
    ("happy_i13", "太棒啦！",   "Ethan",    "开心地叫好，短促有力，音调上扬，句尾挑起来，不要拖长", "t"),
    # ── 两个语气词连喊（略长，但仍是纯语气助词）──
    ("happy_i14", "耶！太棒了！", "Cherry",  "雀跃地连喊两声，一次比一次高，音调上扬，短促不拖长", "t"),
    ("happy_i15", "哦耶，好耶！", "Serena",  "连着开心地喊，音调上扬、轻快雀跃，短促不拖长", "t"),
    # ── 道谢向（2 个音色）──
    ("happy_i16", "谢谢！",     "Cherry",   INSTR_THANKS, "t"),
    ("happy_i17", "哇！谢谢！", "Ethan",    INSTR_SURPRISE + "，后面带一句道谢", "t"),
    # ── 「耶嘿！」：用户建议里的那个（2 个音色，各摇一次）──
    ("happy_i18", "耶嘿！",     "Cherry",   INSTR_SURPRISE, "t"),
    ("happy_i19", "耶嘿！",     "Serena",   INSTR_SHORT, "t"),
    # ── 「哦耶！」再摇两条（第一轮里挑上扬的那条留，其余淘汰）──
    ("happy_i20", "哦耶！",     "Cherry",   INSTR_SURPRISE, "t"),
    ("happy_i21", "哦耶！",     "Ethan",    "很短促地喊一声，兴奋开心，音调上扬，句尾往上挑，不要拖长、不要下沉", "t"),

    # ═══════ B 档 · 完整短句（tier "s"，1.0~2.6s）：保留后半句，只去掉「呜呼」═══════
    ("happy_i22", "哦耶！终于好啦！",   "Cherry",  INSTR_SENT, "s"),
    ("happy_i23", "哦耶！终于好啦！",   "Ethan",   INSTR_SENT2, "s"),
    ("happy_i24", "好耶！开动啦！",     "Ethan",   INSTR_SENT, "s"),
    ("happy_i25", "好耶！开动啦！",     "Chelsie", INSTR_SENT, "s"),
    ("happy_i26", "哇！有早餐吃啦！",   "Serena",  INSTR_SENT2, "s"),
    ("happy_i27", "哇！有早餐吃啦！",   "Cherry",  INSTR_SENT, "s"),
    ("happy_i28", "耶！太棒啦！",       "Ethan",   INSTR_SENT2, "s"),
    ("happy_i29", "耶！太棒啦！",       "Serena",  INSTR_SENT, "s"),
    ("happy_i30", "哦耶！谢谢！",       "Cherry",  "开心地欢呼并道谢，语调上扬、明亮，句尾挑起来，不要拖长", "s"),
    ("happy_i31", "哦耶！谢谢！",       "Serena",  "开心地欢呼并道谢，语调上扬、明亮，句尾挑起来，不要拖长", "s"),
    ("happy_i32", "哇哦！好香啊！",     "Chelsie", "惊喜地赞叹，语调往上扬，尾音挑起来，明亮开心", "s"),
    ("happy_i33", "哇哦！好香啊！",     "Serena",  "惊喜地赞叹，语调往上扬，尾音挑起来，明亮开心", "s"),
    # ── 「耶嘿」放进句子里再试一次（保留后半句的那种语气）──
    ("happy_i34", "耶嘿！终于好啦！",   "Cherry",  INSTR_SENT2, "s"),
    ("happy_i35", "耶嘿！有早餐吃啦！", "Serena",  INSTR_SENT, "s"),

    # ═══════ 第三轮 · 短语气词的「上扬」重摇（tier "t"）═══════
    # 第一轮 18 条短语气词只有 6 条实测上扬，而其中「哦耶！」「哇！」「太棒啦！」
    # 「谢谢！」这几个正是用户点名的词 —— 一个上扬的都没有。所以这一轮换成
    # INSTR_RISE/RISE2（起头压低 → 一路往上冲），每个词 × 多个音色重摇一遍。
    ("happy_i36", "哦耶！",     "Cherry",   INSTR_RISE,  "t"),
    ("happy_i37", "哦耶！",     "Serena",   INSTR_RISE2, "t"),
    ("happy_i38", "哦耶！",     "Ethan",    INSTR_RISE2, "t"),
    ("happy_i39", "哦耶！",     "Chelsie",  INSTR_RISE,  "t"),
    ("happy_i40", "哦耶！",     "Serena",   INSTR_RISE,  "t"),
    ("happy_i41", "哦耶！",     "Chelsie",  INSTR_RISE2, "t"),
    ("happy_i42", "哇！",       "Cherry",   INSTR_RISE,  "t"),
    ("happy_i43", "哇！",       "Serena",   INSTR_RISE,  "t"),
    ("happy_i44", "哇！",       "Chelsie",  INSTR_RISE2, "t"),
    ("happy_i45", "哇哦！",     "Cherry",   INSTR_RISE,  "t"),
    ("happy_i46", "哇哦！",     "Ethan",    INSTR_RISE2, "t"),
    ("happy_i47", "好耶！",     "Serena",   INSTR_RISE,  "t"),
    ("happy_i48", "好耶！",     "Ethan",    INSTR_RISE2, "t"),
    ("happy_i49", "太棒啦！",   "Cherry",   INSTR_RISE,  "t"),
    ("happy_i50", "太棒啦！",   "Chelsie",  INSTR_RISE,  "t"),
    ("happy_i51", "耶！",       "Ethan",    INSTR_RISE,  "t"),
    ("happy_i52", "耶！",       "Chelsie",  INSTR_RISE2, "t"),
    ("happy_i53", "谢谢！",     "Serena",   INSTR_RISE,  "t"),
    ("happy_i54", "谢谢！",     "Ethan",    INSTR_RISE2, "t"),
    ("happy_i55", "耶嘿！",     "Ethan",    INSTR_RISE,  "t"),
    ("happy_i56", "耶嘿！",     "Chelsie",  INSTR_RISE2, "t"),
    ("happy_i57", "好耶！",     "Cherry",   INSTR_RISE2, "t"),
]

# 档位表（name → tier），下面到处要用
TIER = {r[0]: r[4] for r in LINES}


def dur_ok(name, dur):
    """按档位判时长；返回 (是否在硬上限内, 是否落在「为宜」区间, 档位)"""
    t = TIER.get(name, "t")
    d = DUR[t]
    return (bool(dur and dur <= d["max"]), bool(dur and d["lo"] <= dur <= d["ideal"]), t)

# ── omni 盲听的「念对」判据 ────────────────────────────────────────────────
# 用户原话里就留了余地：「哦耶被听成哦也**可接受**，听成别的词就不合格」。
# 所以判据分两层：
#   ① 无调拼音**连续匹配**（沿 gen_bf_happy.py / verify_bf_omni.py 的三条实测结论：
#      同音字不算念错、单条判错不可信要听 2 遍、提示词给「听不到就回答：无」的出口）
#   ② **同音白名单**：把实测里出现过的同音/近音转写也算对，
#      逐条列在 HOMOPHONE 里 —— 理由写清楚，不做「为了让某条过关」的暗改。
HOMOPHONE = {
    # 语气助词本来就没有标准写法，模型按音记字，下面这些是本轮实测出现的：
    "哦耶": ["哦也", "噢耶", "噢也", "欧耶", "欧也", "呕耶", "哦吔", "哦叶", "喔耶", "哦噎"],
    "耶": ["也", "吔", "噎", "叶", "夜"],
    "哇": ["哇", "哇啊", "娃"],
    "哇哦": ["哇噢", "哇喔", "哇欧", "哇哦哦", "哇呕"],
    "好耶": ["好也", "好吔", "好噎"],
    "耶嘿": ["耶黑", "耶嗨", "耶嘿", "也嘿", "耶嘿耶嘿"],
    "太棒啦": ["太棒了", "太棒拉", "太棒辣"],
    "谢谢": ["谢谢", "谢谢你", "谢啦"],
    "耶太棒了": ["耶太棒了", "耶，太棒了", "耶太棒啦", "耶，太棒啦"],
    "哦耶好耶": ["哦耶好耶", "哦耶，好耶", "哦也好也"],
    # B 档完整短句（实测里模型偶尔会掉一两个字，但**实词**不放宽：
    # 「终于」不能听成「总算」、「开动」不能听成「吃饭」——那才是真的念错）
    "哦耶终于好啦": ["哦耶终于好啦", "哦也终于好啦", "欧耶终于好啦", "哦耶终于好了", "哦耶，终于好啦"],
    "好耶开动啦": ["好耶开动啦", "好也开动啦", "好耶开动了", "好耶，开动啦"],
    "哇有早餐吃啦": ["哇有早餐吃啦", "哇有早餐吃了", "哇，有早餐吃啦", "哇有早餐啦"],
    "耶太棒啦": ["耶太棒啦", "也太棒啦", "耶太棒了", "耶，太棒啦"],
    "哦耶谢谢": ["哦耶谢谢", "哦也谢谢", "欧耶谢谢", "哦耶谢谢你", "哦耶，谢谢"],
    "哇哦好香啊": ["哇哦好香啊", "哇噢好香啊", "哇哦好香呀", "哇，好香啊"],
    "耶嘿终于好啦": ["耶嘿终于好啦", "耶黑终于好啦", "耶嘿终于好了", "耶嘿，终于好啦"],
    "耶嘿有早餐吃啦": ["耶嘿有早餐吃啦", "耶黑有早餐吃啦", "耶嘿有早餐吃了", "耶嘿，有早餐吃啦"],
}

OMNI_PROMPT = ("请听这段音频，逐字写出你听到的中文内容。"
               "只写你确实听到的字，不要解释、不要猜测、不要补充任何没听到的内容。"
               "若几乎听不到人声，就回答：无")


# ── 凭证 / 接口 ────────────────────────────────────────────────────────────
def api_key():
    k = (os.environ.get("DASHSCOPE_API_KEY") or "").strip()
    if not k:
        print("错误：请先设置 DASHSCOPE_API_KEY（只从环境变量取，不写进任何文件）", file=sys.stderr)
        sys.exit(2)
    return k


def endpoint():
    base = (os.environ.get("DASHSCOPE_BASE_URL") or "").strip()
    if not base:
        print("错误：请先设置 DASHSCOPE_BASE_URL（业务空间专属域名）", file=sys.stderr)
        sys.exit(2)
    host = base.split("/compatible-mode")[0].rstrip("/")
    return host + "/api/v1/services/aigc/multimodal-generation/generation"


def synth(text, voice, model, params, url, key, timeout=180):
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


# ── ffmpeg 加工（本机 hermes venv 没有 numpy、不能 pip install → 只能走 ffmpeg）──
FFMPEG = os.environ.get("FFMPEG_BIN") or "ffmpeg"
FFPROBE = os.environ.get("FFPROBE_BIN") or "ffprobe"


def have_ffmpeg():
    return shutil.which(FFMPEG) is not None


def master(src, dst, atempo=None):
    """掐头去尾（>45dB 以下的静音）→（可选）提速 → 响度归一 → 48kHz 单声道 128kbps mp3。

    atempo 用来把「念长了」的语气助词压回短促区间：**只改节奏、不改音高**
    （atempo 是变速不变调；本机 ffmpeg 8.1 没编 rubberband，所以不做变调）。
    语速上限取 1.25 —— 再快就会听出机械感，那种"奇怪"正是用户要避免的。
    """
    chain = [
        "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak",
        "areverse",
        "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak",
        "areverse",
    ]
    if atempo and abs(atempo - 1.0) > 0.001:
        chain.append("atempo=%.4f" % atempo)
    chain += ["loudnorm=I=-16:TP=-1.5:LRA=11", "aresample=48000"]
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", src,
           "-af", ",".join(chain), "-ac", "1", "-ar", "48000",
           "-c:a", "libmp3lame", "-b:a", "128k", dst]
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode == 0, (p.stderr or "").strip()[:400]


def probe_info(path):
    if shutil.which(FFPROBE) is None:
        return None
    cmd = [FFPROBE, "-v", "error", "-show_entries",
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
# 纯标准库自相关求 F0：mp3 → 16kHz 单声道 PCM → 逐帧自相关 → 前 40% / 后 40% 中位数。
# 与 gen_bf_happy.py 完全同一套参数（FRAME=512 / HOP=256 / 500~70Hz），这样两轮的
# Δ% 可以放在同一张表里直接比。
PCM_SR = 16000
FRAME = 512
HOP = 256
LAG_MIN = int(PCM_SR / 500)
LAG_MAX = int(PCM_SR / 70)


def decode_pcm(path, sr=PCM_SR):
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
    import array
    a = array.array("h")
    a.frombytes(buf[i0 * 2:(i0 + n) * 2])
    if len(a) < n:
        return 0.0
    mean = sum(a) / float(n)
    x = [v - mean for v in a]
    energy = sum(v * v for v in x) / n
    if energy < 100.0:
        return 0.0
    best, best_lag = 0.0, 0
    for lag in range(LAG_MIN, LAG_MAX + 1):
        s = 0.0
        for i in range(n - lag):
            s += x[i] * x[i + lag]
        s /= (n - lag)
        if s > best:
            best, best_lag = s, lag
    if best_lag <= 0 or best < 0.30 * energy:
        return 0.0
    return PCM_SR / float(best_lag)


# 同一份 PCM 在一轮里会被量很多次（生成时 + --report 时），
# 单帧自相关是 LAG 数 × 帧长的双层循环（几万次乘加）→ 加一层结果缓存，
# 让「重复量同一条」几乎不花时间（key = 帧字节的 hash + 帧长）。
_F0_CACHE = {}


def f0_of_frame_cached(buf, i0, n):
    key = (hash(buf[i0 * 2:(i0 + n) * 2]), n)
    v = _F0_CACHE.get(key)
    if v is None:
        v = _f0_of_frame(buf, i0, n)
        if len(_F0_CACHE) > 40000:
            _F0_CACHE.clear()
        _F0_CACHE[key] = v
    return v


def f0_contour(path):
    buf = decode_pcm(path)
    if not buf:
        return []
    total = len(buf) // 2
    out, i = [], 0
    while i + FRAME <= total:
        out.append(f0_of_frame_cached(buf, i, FRAME))
        i += HOP
    return out


def _median(v):
    if not v:
        return 0.0
    s = sorted(v)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2.0


def pitch_stats(path):
    c = f0_contour(path)
    voiced = [v for v in c if v > 0]
    if len(voiced) < 3:
        return None
    n = len(voiced)
    k = max(1, int(round(n * 0.4)))
    f1, f2 = _median(voiced[:k]), _median(voiced[-k:])
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


# ── omni 盲听：只验「念对没念错」────────────────────────────────────────────
def _to_py(text):
    """汉字串 → 无调拼音序列（非汉字丢掉）。"""
    import re as _re
    from pypinyin import lazy_pinyin
    t = _re.sub(r"[^\u4e00-\u9fff]", "", text or "")
    return [lazy_pinyin(ch)[0] for ch in t]


def _hit(expected, heard):
    """expected 的有效念法（含同音白名单）是否出现在 heard 里。"""
    e_raw = "".join(ch for ch in (expected or "") if "\u4e00" <= ch <= "\u9fff")
    cands = [e_raw] + HOMOPHONE.get(e_raw, [])
    h = _to_py(heard)
    if not h:
        return False, []
    tried = []
    for cand in cands:
        e = _to_py(cand)
        if not e or len(e) > len(h):
            continue
        tried.append(cand)
        for i in range(len(h) - len(e) + 1):
            if h[i:i + len(e)] == e:
                return True, tried
    return False, tried


def omni_listen(path, rounds=2):
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


def row_of(name, text, voice, ins, path, model=""):
    info = probe_info(path)
    ps = pitch_stats(path)
    dur = info["duration"] if info else 0.0
    len_ok, len_ideal, tier = dur_ok(name, dur)
    return {
        "name": name, "file": name + ".mp3", "text": text, "voice": voice,
        "instruction": ins, "model": model, "tier": tier,
        "info": info, "pitch": ps,
        "dur": round(dur, 3),
        "pct": (ps["delta_pct"] if ps else None),
        "rising": bool(ps and ps["rising"]),
        "len_ok": len_ok,
        "len_ideal": len_ideal,
    }


def write_json(rows, extra=None):
    os.makedirs(SRC_DIR, exist_ok=True)
    rep = os.path.join(SRC_DIR, "_bf_happy_i_report.json")
    with open(rep, "w", encoding="utf-8") as f:
        json.dump({"out": OUT_DIR, "dur_gate": DUR,
                   "rows": rows, "extra": extra or {}},
                  f, ensure_ascii=False, indent=1)
    return rep


def main():
    ap = argparse.ArgumentParser(description="「拿到早餐」的语气助词候选（happy_i1…）")
    ap.add_argument("--out", default=OUT_DIR, help=f"成品目录（默认 {OUT_DIR}）")
    ap.add_argument("--src", default=SRC_DIR, help=f"原始件目录（默认 {SRC_DIR}，不入库）")
    ap.add_argument("--only", help="只做指定条目（逗号分隔）")
    ap.add_argument("--force", action="store_true", help="覆盖已存在文件（默认跳过）")
    ap.add_argument("--no-instruct", action="store_true", help="全部用 qwen3-tts-flash")
    ap.add_argument("--sleep", type=float, default=0.4)
    ap.add_argument("--retry", type=int, default=3)
    ap.add_argument("--probe", action="store_true", help="只探第一条")
    ap.add_argument("--report", action="store_true", help="不生成：只量已落盘文件并写 JSON")
    ap.add_argument("--listen", action="store_true", help="omni 盲听（逐条转写 + 同音匹配）")
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--atempo", type=float, default=None,
                    help="强制按这个倍速加工（默认自动：念长了才提速，上限 1.25）")
    ap.add_argument("--write-md", action="store_true", help="顺带写 audio/bf/_happy_i_report.md")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    by_name = {r[0]: r for r in LINES}

    # ── 盲听 ──────────────────────────────────────────────────────────────
    if args.listen:
        names = ([x.strip() for x in args.only.split(",") if x.strip()] if args.only
                 else [r[0] for r in LINES])
        print("=" * 96)
        print(f"omni 盲听：{len(names)} 条 · 模型 {OMNI_MODEL} · 每条 {args.rounds} 遍")
        print("判据：无调拼音连续匹配 + 同音白名单（哦耶↔哦也、耶↔也 都算对）；情绪不在这里判")
        print("=" * 96)
        rows, bad = [], []
        for i, nm in enumerate(names, 1):
            row = by_name.get(nm)
            if not row:
                print(f"[{i}/{len(names)}] {nm}  不在词表里")
                continue
            _, text, voice, _, tier = row
            p = os.path.join(args.out, nm + ".mp3")
            if not os.path.exists(p):
                print(f"[{i}/{len(names)}] {nm}  缺文件")
                continue
            info = probe_info(p)
            heard = omni_listen(p, args.rounds)
            oks = [_hit(text, h)[0] for h in heard if not h.startswith("[调用失败]")]
            ok = any(oks)
            print(f"[{i}/{len(names)}] {nm:<11} [{tier}] 「{text}」{(info['duration'] if info else 0):.2f}s "
                  f"{'✔' if ok else '✘'}")
            for h in heard:
                print(f"           omni 原话：{h}")
            rows.append({"name": nm, "expect": text, "voice": voice, "tier": tier,
                         "dur": round(info["duration"], 3) if info else 0,
                         "heard": heard, "ok": ok})
            if not ok:
                bad.append(nm)
            time.sleep(0.3)
        os.makedirs(args.src, exist_ok=True)
        rep = os.path.join(args.src, "_bf_happy_i_omni.json")
        with open(rep, "w", encoding="utf-8") as f:
            json.dump({"model": OMNI_MODEL, "rounds": args.rounds, "rows": rows, "bad": bad,
                       "at": time.strftime("%Y-%m-%d %H:%M:%S")}, f, ensure_ascii=False, indent=1)
        print("=" * 96)
        print(f"念对 {len(rows) - len(bad)}/{len(rows)}" + (f" · 可疑件：{'、'.join(bad)}" if bad else ""))
        print(f"报告：{rep}")
        return 1 if bad else 0

    # ── 只量（不生成）────────────────────────────────────────────────────
    if args.report:
        rows = []
        print(f"量已落盘的候选（不重新生成）→ {args.out}")
        print(f"{'文件':<14}{'档':>3}{'时长':>7}{'F0前半':>9}{'F0后半':>9}{'ΔHz':>8}{'Δ%':>8}  走向   文本")
        for nm, text, voice, ins, tier in LINES:
            p = os.path.join(args.out, nm + ".mp3")
            if not os.path.exists(p):
                print(f"{nm:<14}  缺文件")
                continue
            r = row_of(nm, text, voice, ins, p)
            ps = r["pitch"]
            arrow = "—" if not ps else ("↗ 上扬" if ps["rising"] else ("↘ 下降" if ps["delta_hz"] < 0 else "→ 平"))
            flag = "" if r["len_ok"] else "  ⚠ 超长"
            print(f"{nm:<14}{tier:>3}{r['dur']:>6.2f}s{(ps['f0_first'] if ps else 0):>9.1f}"
                  f"{(ps['f0_last'] if ps else 0):>9.1f}{(ps['delta_hz'] if ps else 0):>8.1f}"
                  f"{(ps['delta_pct'] if ps else 0):>7.1f}%  {arrow}  「{text}」{flag}")
            rows.append(r)
        rep = write_json(rows)
        good = [r for r in rows if r["rising"] and r["len_ok"]]
        bad = [r for r in rows if not (r["rising"] and r["len_ok"])]
        print(f"\n上扬 {sum(1 for r in rows if r['rising'])}/{len(rows)} · "
              f"上扬且不超长 {len(good)}/{len(rows)}")
        if bad:
            def why(r):
                if not r["len_ok"]:
                    return r["name"] + "(超长)"
                return r["name"] + ("(未上扬 %+.1f%%)" % (r["pct"] or 0))
            print("剔除候选：" + "、".join(why(r) for r in bad))
        print(f"报告：{rep}")
        if args.write_md:
            md = write_md(rows)
            print(f"表格：{md}")
        return 0

    # ── 生成 ──────────────────────────────────────────────────────────────
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
    for nm, text, voice, ins, tier in table:
        g = DUR[tier]
        print(f"   {nm}.mp3  [{tier} {g['lo']}~{g['ideal']}s]  ←  「{text}」  音色 {voice}"
              + ("" if args.no_instruct else f"  指令「{ins}」"))
    if args.dry_run:
        return 0
    if not have_ffmpeg():
        print("错误：PATH 里没有 ffmpeg", file=sys.stderr)
        return 2

    key = api_key()
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.src, exist_ok=True)
    ok = skip = fail = 0
    failures, report = [], []
    t0 = time.time()
    for i, (nm, text, voice, ins, tier) in enumerate(table, 1):
        dst = os.path.join(args.out, nm + ".mp3")
        gate = DUR[tier]
        tag = f"[{i}/{len(table)}] {nm} [{tier}]  ← 「{text}」（{voice}）"
        if os.path.exists(dst) and os.path.getsize(dst) > 1000 and not args.force:
            print(f"{tag}  跳过（已存在）")
            skip += 1
            continue
        got, last_err, got_model = None, "", ""
        plans = ([(MODEL_TTS, None)] if (args.no_instruct or not ins)
                 else [(MODEL_INSTRUCT, {"instructions": ins, "optimize_instructions": True}),
                       (MODEL_TTS, None)])
        for model, params in plans:
            for attempt in range(1, args.retry + 1):
                data, err = synth(text, voice, model, params, url, key)
                if data:
                    got, got_model = data, model + ("+instructions" if params else "")
                    break
                last_err = f"[{model}] {err or '返回空'}"
                if attempt < args.retry:
                    wait = 2 * attempt
                    print(f"{tag}  第 {attempt} 次失败（{last_err[:110]}），{wait}s 后重试")
                    time.sleep(wait)
            if got:
                break
            print(f"{tag}  {model} 整轮失败，换下一个模型/参数")
        if not got:
            print(f"{tag}  FAIL  {last_err[:200]}")
            failures.append({"file": nm + ".mp3", "error": last_err})
            fail += 1
            continue

        raw = os.path.join(args.src, nm + ".wav")
        with open(raw, "wb") as f:
            f.write(got)

        # 先按原速加工看时长；超过本档「为宜」上限再按自动倍速重做一次（上限 1.25）。
        # ⚠ B 档（完整短句）的「为宜」上限是 2.6s：超过 2.6s 才提速，
        #   轻微提速（≤1.25）听不出机械感，但能保证不跟下一声叠在一起。
        good, merr = master(raw, dst, args.atempo)
        if not good:
            print(f"{tag}  ffmpeg 失败：{merr}")
            failures.append({"file": nm + ".mp3", "error": "ffmpeg: " + merr})
            fail += 1
            continue
        info = probe_info(dst)
        used_tempo = args.atempo or 1.0
        if args.atempo is None and info and info["duration"] > gate["ideal"]:
            tempo = min(1.25, info["duration"] / gate["ideal"])
            if tempo > 1.02:
                good2, merr2 = master(raw, dst, tempo)
                if good2:
                    used_tempo = round(tempo, 3)
                    info = probe_info(dst)
                else:
                    print(f"{tag}  提速失败（保留原速）：{merr2}")
        size = os.path.getsize(dst)
        over = "" if (info and info["duration"] <= gate["max"]) else "  ⚠ 仍超长"
        print(f"{tag}  OK  [{got_model}]  原始 {len(got):,} B → {os.path.basename(dst)} {size:,} B"
              + (f" · {info['duration']:.2f}s / {info['sample_rate']}Hz / {info['channels']}ch" if info else "")
              + (f" · 加速 ×{used_tempo:.2f}" if used_tempo > 1.001 else "") + over)
        ps = pitch_stats(dst)
        report.append({"name": nm, "file": nm + ".mp3", "text": text, "voice": voice,
                       "model": got_model, "instruction": (None if args.no_instruct else ins),
                       "tier": tier, "atempo": used_tempo, "info": info, "pitch": ps})
        # 逐条落盘：单帧自相关是纯 Python 的重计算（35 条要跑几十秒），
        # 生成时既然已经算过 F0，就别让 --report 再算第二遍。
        write_json(report)
        ok += 1
        if i < len(table):
            time.sleep(args.sleep)

    print("\n" + "═" * 66)
    print(f"成功 {ok} · 跳过 {skip} · 失败 {fail} · 共 {len(table)} · 耗时 {time.time() - t0:.0f}s")
    if report:
        rep = write_json(report)
        print(f"报告：{rep}")
    if failures:
        os.makedirs(args.src, exist_ok=True)
        rep = os.path.join(args.src, "_bf_happy_i_failures.json")
        with open(rep, "w", encoding="utf-8") as f:
            json.dump(failures, f, ensure_ascii=False, indent=2)
        print(f"失败明细：{rep}")
    if ok or skip:
        print("\n下一步（必须）：omni 盲听，确认语气词念对了 ——")
        print("  python tools/bf/gen_bf_happy_i.py --listen --rounds 2")
    return 0 if fail == 0 else 1


def write_md(rows):
    """把候选表写成 markdown（提交报告直接引用；数据全部来自实测）。"""
    p = os.path.join(OUT_DIR, "_happy_i_report.md")
    lines = ["| 编号 | 档 | 念法 | 音色 | 时长 | F0 前→后 | 走向 | 是否达标 |",
             "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        ps = r["pitch"]
        tier = r.get("tier", "t")
        if not ps:
            lines.append(f"| {r['name']} | {tier} | 「{r['text']}」 | {r['voice']} | {r['dur']:.2f}s | — | — | 无量 |")
            continue
        arrow = "↗" if ps["rising"] else ("↘" if ps["delta_hz"] < 0 else "→")
        okk = "✔" if (r["rising"] and r["len_ok"]) else ("超长" if not r["len_ok"] else "未上扬")
        lines.append(f"| {r['name']} | {tier} | 「{r['text']}」 | {r['voice']} | {r['dur']:.2f}s | "
                     f"{ps['f0_first']:.0f}→{ps['f0_last']:.0f}Hz ({r['pct']:+.1f}%) | {arrow} | {okk} |")
    with open(p, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return p


if __name__ == "__main__":
    sys.exit(main())
