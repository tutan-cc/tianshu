#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_mj_omni.py — 用**全模态模型盲听**验收麻将报牌语音（念得对不对）

为什么要单开一层：
  `verify_mj_asr.py` 走本地 SenseVoice，模型文件 229MB、不入库，换台机器就跑不了；
  而报牌词只有 0.3~0.8s，ASR 对这么短的喊牌识别率天然低。
  百炼的 `qwen3.8-omni-flash` 能直接「听」音频（用户指定用它做音频内容验收），
  于是内容核对可以完全不依赖本地模型。

⚠ 三个判定上的坑（都实测过，写在判据里了）：
  1. **同音字不是念错**：`九筒`(jiǔ tǒng) 被听成「酒桶」、`碰`(pèng) 被听成「砰」，
     这些都是**完全同音**的正确件。所以判据必须是**拼音同音匹配**，
     不能拿汉字串直接比 —— 手写近音字表更糟，verify_mj_asr.py 里记着实测误报 40+ 条。
  2. **提示词不能预设「里面一定有内容」**：omni_judge.py 实测过，
     第一版提示词会让它对纯静音编出「确认蜂鸣声」。本脚本的提示词显式给出
     「若几乎听不到人声就回答：无」这个出口，且**不提任何期望答案**（盲听）。
  3. **单条判错不可信**：短促喊牌本来就容易被听岔。所以默认听 `--rounds 2` 遍，
     任一遍同音命中即算通过；两遍都不是同音才标红，并把它当「可疑件」交付人工/重生成。

用法：
    $env:DASHSCOPE_API_KEY  = "sk-..."
    $env:DASHSCOPE_BASE_URL = "https://xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    python tools/audio/verify_mj_omni.py                       # 验 audio/mj（43 条）
    python tools/audio/verify_mj_omni.py --dir audio/mj/seat1
    python tools/audio/verify_mj_omni.py --only 红中,白板,东风 --rounds 2
报告落在工作区（**不入库**）：<工作区>/_mj_omni_report.json / .txt
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

# Windows 控制台默认是 GBK：中文全是乱码，`↔` 这种字符更会直接
# UnicodeEncodeError 把脚本崩掉（实测踩过）。统一按 UTF-8 输出，编不出的字符用 ? 代替，
# 不让「打印」这种小事中断验收。报告文件本来就是 UTF-8 写的，不受影响。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

MODEL = "qwen3.8-omni-flash"

# 盲听提示词：**不提期望答案**，并显式给出「什么都没有」这个出口（见文件头第 2 条）
PROMPT = ("请听这段音频，逐字写出你听到的中文内容。"
          "只写你确实听到的字，不要解释、不要猜测、不要补充任何没听到的内容。"
          "若几乎听不到人声，就回答：无")

# 文件名（阿拉伯数字）→ 应该听到的念法（汉字数字）
NUM_CN = {"1": "一", "2": "二", "3": "三", "4": "四", "5": "五",
          "6": "六", "7": "七", "8": "八", "9": "九"}
AR2PY = {v: k for k, v in NUM_CN.items()}
CN2AR = dict(AR2PY)
CN2AR.update({"两": "2"})
# 汉字数字 → 拼音（与阿拉伯数字统一走 AR2PY，避免「九」和「9」两套写法比不出来）
NUM_PY = {"1": "yi", "2": "er", "3": "san", "4": "si", "5": "wu",
          "6": "liu", "7": "qi", "8": "ba", "9": "jiu"}


def expected_reading(base):
    """文件基名 → 应该念出来的词（"1万" → "一万"；其余同名）。"""
    m = re.match(r"^([1-9])([万条筒])$", base)
    return NUM_CN[m.group(1)] + m.group(2) if m else base


def to_py(text):
    """汉字/数字串 → 无调拼音串（数字先归一成汉字再转拼音）。"""
    from pypinyin import lazy_pinyin
    t = re.sub(r"[^\u4e00-\u9fff0-9]", "", text or "")
    t = "".join(CN2AR.get(c, c) for c in t)
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
    ap = argparse.ArgumentParser(description="用 qwen3.8-omni-flash 盲听验收麻将报牌语音")
    ap.add_argument("--dir", default=(PA.DIR_MJ if PA else "audio/mj"), help="要验收的目录")
    ap.add_argument("--only", help="只验指定词（逗号分隔，文件基名）")
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
    print("判据：**拼音同音**（无调）匹配。九筒↔酒桶、碰↔砰 是同音字，不算错。\n")

    rows, bad = [], []
    t0 = time.time()
    for i, name in enumerate(files, 1):
        base_name = name[:-4]
        exp = expected_reading(base_name)
        heard, hit = [], False
        for _ in range(max(1, args.rounds)):
            txt = listen(client, os.path.join(args.dir, name), args.model)
            heard.append(txt)
            if not txt.startswith("[调用失败]") and homophone(exp, txt):
                hit = True
        mark = "✔" if hit else "✘"
        print(f"[{i}/{len(files)}] {base_name:<6} 应念「{exp}」 {mark}")
        for t in heard:
            print(f"          omni 原话：{t}")
        rows.append({"file": name, "expect": exp, "heard": heard, "ok": hit,
                     "py_expect": "".join(to_py(exp))})
        if not hit:
            bad.append(base_name)

    outdir = args.out or (PA.WORK_ROOT if PA else ".")
    try:
        os.makedirs(outdir, exist_ok=True)
        rep = os.path.join(outdir, "_mj_omni_report.json")
        with open(rep, "w", encoding="utf-8") as f:
            json.dump({"dir": args.dir, "model": args.model, "rounds": args.rounds,
                       "pass": len(rows) - len(bad), "total": len(rows), "bad": bad,
                       "at": time.strftime("%Y-%m-%d %H:%M:%S"), "rows": rows},
                      f, ensure_ascii=False, indent=1)
        print(f"\n报告：{rep}")
    except Exception as e:
        print(f"（报告写出失败：{e}）")

    print("=" * 92)
    print(f"通过 {len(rows) - len(bad)}/{len(rows)} · 耗时 {time.time() - t0:.0f}s")
    if bad:
        print(f"⚠ 两遍都不是同音的**可疑件**（重生成后重验）：{'、'.join(bad)}")
    print("=" * 92)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
