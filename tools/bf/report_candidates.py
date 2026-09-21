#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「上扬且不超长 / 上扬但超长 / 未上扬」三类候选整理成 markdown（提交报告直接引用）。
数据来自 tools/bf/gen_bf_happy_i.py 写的 _bf_happy_i_report.json 与 _bf_happy_i_omni.json。
"""
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                    "..", "audio-工作区", "_bf_happy_i_src")
BASE = os.path.abspath(BASE)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_patch", "bf10_rising_table.md")

GATE = {"t": 1.60, "s": 3.00}


def main():
    rep = json.load(open(os.path.join(BASE, "_bf_happy_i_report.json"), encoding="utf-8"))
    omni = json.load(open(os.path.join(BASE, "_bf_happy_i_omni.json"), encoding="utf-8"))
    heard = {r["name"]: r["heard"] for r in omni["rows"]}
    okmap = {r["name"]: r["ok"] for r in omni["rows"]}

    rise_ok, rise_over, fall = [], [], []
    for r in rep["rows"]:
        ps = r.get("pitch")
        dur = (r.get("info") or {}).get("duration") or 0
        tier = r.get("tier", "t")
        if ps and ps["rising"]:
            (rise_ok if dur <= GATE[tier] else rise_over).append(r)
        else:
            fall.append(r)

    L = ["# bf-10 「语气助词」候选实测表（数据来自 JSON，不是手写）", ""]
    L.append("口径：F0 走向 = 自相关逐帧基频的「前 40% 中位数 → 后 40% 中位数」；")
    L.append("时长闸：短语气词档（t）≤1.6s、完整短句档（s）≤3.0s；omni = qwen3.8-omni-flash 盲听转写。")
    L.append("")

    def table(rows, title):
        L.append("## " + title + "（%d 条）" % len(rows))
        L.append("")
        L.append("| 编号 | 档 | 念法 | 音色 | 时长 | F0 前→后 | 走向 | omni 转写原文 | omni |")
        L.append("|---|---|---|---|---|---|---|---|---|")
        for r in sorted(rows, key=lambda x: -((x.get("pitch") or {}).get("delta_pct") or 0)):
            nm, ps = r["name"], r.get("pitch")
            dur = ((r.get("info") or {}).get("duration") or 0)
            h = heard.get(nm)
            mark = "" if nm not in okmap else ("OK" if okmap[nm] else "FAIL")
            L.append("| %s | %s | %s | %s | %.2fs | %s | %s | %s | %s |" % (
                nm, r.get("tier", "t"), r["text"], r["voice"], dur,
                ("%.0f→%.0f Hz (%+.1f%%)" % (ps["f0_first"], ps["f0_last"], ps["delta_pct"])) if ps else "—",
                ("↗" if ps and ps["rising"] else ("↘" if ps and ps["delta_hz"] < 0 else "→")) if ps else "—",
                " / ".join(h) if h else "（未盲听）", mark))
        L.append("")

    table(rise_ok, "上扬且不超长（合格候选）")
    table(rise_over, "上扬但超长（淘汰：超时长闸）")
    table(fall, "未上扬（淘汰：F0 前段→后段没有往上走）")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")
    print("→ " + OUT)
    print("合格 %d · 上扬但超长 %d · 未上扬 %d（共 %d）" % (
        len(rise_ok), len(rise_over), len(fall), len(rep["rows"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
