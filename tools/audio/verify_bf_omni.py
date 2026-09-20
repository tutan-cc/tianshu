#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_bf_omni.py — 用**全模态模型盲听**验收早餐店顾客语音（念得对不对）

与麻将那条链的关系：
  tools/audio/verify_mj_omni.py → 麻将报牌 43 条（并发改造中，本脚本只参考其判据与写法，**不改它**）
  本脚本                        → 早餐店 4 条语音 + 1 条滴答（tick 是非人声件，只记录描述）

判据沿用 verify_mj_omni.py 的三条实测结论（都是踩过的坑）：
  1. **同音字不是念错**：呜呼 ↔ 呜呼/呜乎、哼 ↔ 亨，走**无调拼音**连续匹配，不拿汉字串直接比。
  2. **提示词不能预设「里面一定有内容」**：显式给出「若几乎听不到人声就回答：无」这个出口，
     且**不提任何期望答案**（真盲听）。
  3. **单条判错不可信**：默认听 `--rounds 2` 遍，任一遍同音命中即算通过。
     两遍都不是同音才标红 → 当「可疑件」交付人工 / 重生成。

tick.mp3 怎么验：
  它是合成音效，**本来就没有人声**。所以对它的期望是「无」（模型应听不出可转录的中文），
  判据是 `expect == None`。
  ⚠ 实测补充：**omni 拒收 <0.15s 的音频** —— 70ms 的滴答发过去直接 400
    `invalid_parameter_error: The audio is empty`（两遍都一样，不是偶发）。
    用户对滴答的要求是「≤120ms 的一声」，与「能被人声模型判读」天然冲突，
    所以对这类**极短非人声件**本脚本不硬判，改记为 `skip`，并指到真正合适的核对手段：
      · tools/bf/mp3info.js         —— 只读 MP3 头量时长 / 采样率 / 声道（Node，无需 ffmpeg）
      · tools/bf/e2e-audio.js       —— 真 Chrome 里 new Audio + canplaythrough，量出真时长
      · tests/breakfast.test.cjs    —— 断言 tick ≤120ms / 48kHz / 单声道

用法：
    $env:DASHSCOPE_API_KEY  = "sk-..."
    $env:DASHSCOPE_BASE_URL = "https://xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    python tools/audio/verify_bf_omni.py                      # 验 audio/bf（5 条）
    python tools/audio/verify_bf_omni.py --only happy,slow --rounds 3
报告落在工作区（**不入库**）：<工作区>/_bf_omni_report.json / .txt
"""

import argparse
import base64
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import paths as PA
except Exception:
    PA = None

# Windows 控制台默认 GBK：中文与「→」这类符号会乱码 / UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

MODEL = "qwen3.8-omni-flash"

# 盲听提示词：不提期望答案，并给出「什么都没有」的出口（判据 2）
PROMPT = ("请听这段音频，逐字写出你听到的中文内容。"
          "只写你确实听到的字，不要解释、不要猜测、不要补充任何没听到的内容。"
          "若几乎听不到人声，就回答：无")

DIR_BF = os.path.join(PA.AUDIO, "bf") if PA else "audio/bf"

# ── 期望念法（与 gen_bf_tts.py 的 LINES 同源；expect=None = 非人声件，只记录描述）──
EXPECT = {
    "happy":  "呜呼",
    "happy2": "呜呼",
    "happy3": "呜呼",
    "slow":   "哼太慢了",
    "tick":   None,
}


def expect_of(base):
    """文件基名 → 期望念法。

    先精确查表；查不到再看前缀 —— 这样「slow_a / slow_b / happy_v2」这类
    **候选件**（gen_bf_tts.py --candidates）不用改这张表也能按同一判据盲听。
    两头都不匹配 → 返回基名本身（当作词，严格判定，避免"未知文件静默通过"）。
    """
    if base in EXPECT:
        return EXPECT[base]
    for key in ("happy", "slow"):
        if base.startswith(key):
            return EXPECT[key]
    return base

# 非人声件：模型只要听出这些「确实有人在说话」的实词，就说明它不是干净的音效
SPEECH_HINT = ("呜", "呼", "哼", "太慢", "慢", "你好", "谢谢")

NUM_PY = {"1": "yi", "2": "er", "3": "san", "4": "si", "5": "wu",
          "6": "liu", "7": "qi", "8": "ba", "9": "jiu"}


def to_py(text):
    """汉字串 → 无调拼音序列（非汉字一律丢掉；数字按读音归一）。"""
    try:
        from pypinyin import lazy_pinyin
    except ImportError:
        raise SystemExit("需要 pypinyin：pip install pypinyin（本机 hermes venv 已装）")
    t = re.sub(r"[^\u4e00-\u9fff0-9]", "", text or "")
    out = []
    for ch in t:
        out.append(NUM_PY[ch] if ch in NUM_PY else (lazy_pinyin(ch) or [ch])[0])
    return out


def homophone(expected, heard):
    """期望词的拼音序列是否**连续出现**在盲听转录里 —— 是则「念对了」。"""
    e, h = to_py(expected), to_py(heard)
    if not e or not h or len(e) > len(h):
        return False
    for i in range(len(h) - len(e) + 1):
        if h[i:i + len(e)] == e:
            return True
    return False


def audio_b64(path):
    return base64.b64encode(open(path, "rb").read()).decode("ascii")


# ── 极短件（<0.15s）omni 会拒收，先自己量一下时长 ────────────────────────
MIN_JUDGE_SEC = 0.15
_BR_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
_SR_V1 = [44100, 48000, 32000, 0]


def mp3_duration(path):
    """逐帧数出来的解码长度（秒）——与 tools/bf/mp3info.js 同一口径。
    只认 MPEG1 Layer3（本项目音频统一 48kHz，都是这一档）；解析不了返回 0。"""
    b = open(path, "rb").read()
    i = 0
    if len(b) > 10 and b[0:3] == b"ID3":
        i = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f))
    n = 0
    guard = 0
    while i < len(b) - 4 and guard < 200000:
        guard += 1
        if b[i] != 0xFF or (b[i + 1] & 0xE0) != 0xE0:
            i += 1
            continue
        ver = (b[i + 1] >> 3) & 3
        layer = (b[i + 1] >> 1) & 3
        br = (b[i + 2] >> 4) & 15
        sr = (b[i + 2] >> 2) & 3
        pad = (b[i + 2] >> 1) & 1
        if layer != 1 or ver != 3 or br in (0, 15) or sr == 3:
            i += 1
            continue
        brate = _BR_V1L3[br] * 1000
        srate = _SR_V1[sr]
        flen = int(1152 / 8 * brate / srate) + pad
        n += 1
        i += max(24, flen)
    return n * 1152 / 48000.0 if n else 0.0


def listen(client, path, model=MODEL, timeout=180):
    """盲听一段，返回模型原话（失败时返回带 [调用失败] 前缀的串）。"""
    last = ""
    for attempt in range(2):
        try:
            r = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": [
                    {"type": "input_audio",
                     "input_audio": {"data": "data:audio/mpeg;base64," + audio_b64(path), "format": "mp3"}},
                    {"type": "text", "text": PROMPT}]}],
                modalities=["text"], stream=False, timeout=timeout)
            return (r.choices[0].message.content or "").strip().replace("\n", " ")
        except Exception as e:
            last = f"[调用失败] {type(e).__name__}: {e}"
            time.sleep(2)
    return last


def main():
    ap = argparse.ArgumentParser(description="用 qwen3.8-omni-flash 盲听验收早餐店语音")
    ap.add_argument("--dir", default=DIR_BF, help="要验收的目录（默认 audio/bf）")
    ap.add_argument("--only", help="只验指定条目（逗号分隔，文件基名）")
    ap.add_argument("--rounds", type=int, default=2, help="每条听几遍（任一遍同音即通过）")
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--out", help="报告输出目录（默认工作区，**不入库**）")
    args = ap.parse_args()

    try:
        from openai import OpenAI
    except ImportError:
        print("需要 openai SDK：pip install openai", file=sys.stderr)
        return 2

    key = (os.environ.get("DASHSCOPE_API_KEY") or "").strip()
    base = (os.environ.get("DASHSCOPE_BASE_URL") or "").strip()
    if not key or not base:
        print("请先设置 DASHSCOPE_API_KEY 与 DASHSCOPE_BASE_URL（只从环境变量取）", file=sys.stderr)
        return 2
    client = OpenAI(api_key=key, base_url=base)

    files = sorted(f for f in os.listdir(args.dir) if f.lower().endswith(".mp3"))
    if args.only:
        want = {x.strip() for x in args.only.split(",") if x.strip()}
        files = [f for f in files if f[:-4] in want]
    if not files:
        print(f"{args.dir} 里没有匹配的 mp3")
        return 1

    print("=" * 92)
    print(f"盲听验收：{len(files)} 条 · 目录 {args.dir} · 模型 {args.model} · 每条 {args.rounds} 遍")
    print("=" * 92)
    print("判据：**无调拼音连续匹配**（呜呼↔呜呼/呜乎、哼↔亨 都算对）；tick 是非人声件，只记录描述。\n")

    rows, bad, skipped = [], [], []
    t0 = time.time()
    for i, name in enumerate(files, 1):
        base_name = name[:-4]
        exp = expect_of(base_name)
        full = os.path.join(args.dir, name)
        dur = mp3_duration(full)
        if exp is None and dur < MIN_JUDGE_SEC:
            note = (f"极短非人声件（{dur*1000:.0f}ms < {MIN_JUDGE_SEC*1000:.0f}ms）：omni 会拒收"
                    f"（实测 400 The audio is empty）→ 改由声学规格核对：tools/bf/mp3info.js / "
                    f"tools/bf/e2e-audio.js（真 Chrome 解码） / tests/breakfast.test.cjs")
            print(f"[{i}/{len(files)}] {base_name:<7} 非人声件 · 跳过盲听（{dur*1000:.0f}ms 太短）")
            print(f"          {note}")
            rows.append({"file": name, "expect": None, "heard": [], "ok": True,
                         "skipped": "too-short-for-omni", "duration": dur, "note": note})
            skipped.append(base_name)
            continue
        heard, hit = [], False
        for _ in range(max(1, args.rounds)):
            txt = listen(client, full, args.model)
            heard.append(txt)
            if txt.startswith("[调用失败]"):
                continue
            if exp is None:
                # 非人声件：任何一遍听出「完整实词」即判不干净
                if any(h in txt for h in SPEECH_HINT):
                    hit = False
                else:
                    hit = True
            elif homophone(exp, txt):
                hit = True
        mark = "✔" if hit else "✘"
        label = ("非人声件（只记录）" if exp is None else f"应念「{exp}」")
        print(f"[{i}/{len(files)}] {base_name:<7} {label} {mark}")
        for t in heard:
            print(f"          omni 原话：{t}")
        rows.append({"file": name, "expect": exp, "heard": heard, "ok": hit,
                     "py_expect": ("" if exp is None else "".join(to_py(exp)))})
        if not hit:
            bad.append(base_name)

    outdir = args.out or (PA.WORK_ROOT if PA else ".")
    try:
        os.makedirs(outdir, exist_ok=True)
        rep = os.path.join(outdir, "_bf_omni_report.json")
        with open(rep, "w", encoding="utf-8") as f:
            json.dump({"dir": args.dir, "model": args.model, "rounds": args.rounds,
                       "pass": len(rows) - len(bad), "total": len(rows), "bad": bad,
                       "skipped": skipped,
                       "at": time.strftime("%Y-%m-%d %H:%M:%S"), "rows": rows},
                      f, ensure_ascii=False, indent=1)
        txt = os.path.join(outdir, "_bf_omni_report.txt")
        with open(txt, "w", encoding="utf-8") as f:
            for r in rows:
                exp = "非人声件" if r["expect"] is None else r["expect"]
                tag = "SKIP(太短)" if r.get("skipped") else ("PASS" if r["ok"] else "FAIL")
                f.write(f"{r['file']}\t期望={exp}\t{tag}\n")
                for h in r["heard"]:
                    f.write(f"\tomni原话：{h}\n")
                if r.get("note"):
                    f.write(f"\t说明：{r['note']}\n")
        print(f"\n报告：{rep}")
        print(f"      {txt}")
    except Exception as e:
        print(f"（报告写出失败：{e}）")

    print("=" * 92)
    print(f"通过 {len(rows) - len(bad)}/{len(rows)} · 耗时 {time.time() - t0:.0f}s"
          + (f" · 跳过盲听 {len(skipped)} 条（{('、'.join(skipped))}：太短，omni 拒收）" if skipped else ""))
    if bad:
        print(f"⚠ 两遍都没对上的**可疑件**（重生成后重验）：{'、'.join(bad)}")
    print("=" * 92)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
