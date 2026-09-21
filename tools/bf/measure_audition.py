#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""量 A 组（已启用：v1/alt2/v3/alt3/v5/v6）+ B 组（未启用对照 alt1/alt4/alt5/alt6）的
时长与 F0 走向，输出 JSON 给试听页用（数据全部实测，不手写）。

C 组（备选 happy_i*）的数据直接取 tools/bf/gen_bf_happy_i.py 写的报告，不在这里重量。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_bf_happy_i as G   # 复用同一套 probe_info / pitch_stats（不自造第二套口径）

REPO = G.REPO
BF = os.path.join(REPO, "audio", "bf")

# (文件基名, 念法, 音色)  —— 文本/音色来自 tools/audio/gen_bf_happy.py 的 LINES / ALT_LINES
A_GROUP = [
    ("happy_v1",   "好耶！开动啦！",   "Ethan"),
    ("happy_alt2", "呜呼～太好啦！",   "Serena"),
    ("happy_v3",   "哇哦！好香啊！",   "Chelsie"),
    ("happy_alt3", "哇！谢谢！",       "Ethan"),
    ("happy_v5",   "耶！开动！",       "Serena"),
    ("happy_v6",   "好耶！早餐！",     "Chelsie"),
]
B_GROUP = [
    ("happy_alt1", "呜呼！",           "Cherry"),
    ("happy_alt4", "呜呼——！",       "Chelsie"),
    ("happy_alt5", "耶！",             "Serena"),
    ("happy_alt6", "太棒啦！",         "Cherry"),
]


def measure(group):
    rows = []
    for name, text, voice in group:
        p = os.path.join(BF, name + ".mp3")
        if not os.path.exists(p):
            print("缺文件：" + p, file=sys.stderr)
            continue
        info = G.probe_info(p)
        ps = G.pitch_stats(p)
        rows.append({
            "id": name, "file": name + ".mp3", "text": text, "voice": voice,
            "dur": round(info["duration"], 3) if info else 0.0,
            "info": info, "pitch": ps,
            "pct": (ps["delta_pct"] if ps else None),
            "rising": bool(ps and ps["rising"]),
        })
        print("%-13s %.2fs  %s%+.1f%%  「%s」" % (
            name, rows[-1]["dur"],
            "↗" if rows[-1]["rising"] else ("↘" if (ps and ps["delta_hz"] < 0) else "→"),
            rows[-1]["pct"] or 0, text))
    return rows


def main():
    print("A 组（已启用）")
    a = measure(A_GROUP)
    print("B 组（未启用对照）")
    b = measure(B_GROUP)
    out = os.path.join(REPO, "tools", "bf", "_patch", "bf10_audition_data.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"A": a, "B": b}, f, ensure_ascii=False, indent=1)
    print("→ " + out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
