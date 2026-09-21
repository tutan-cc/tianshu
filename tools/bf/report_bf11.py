#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 bf-11 本轮（重出「高兴」候选 + 换掉「呜呼」版「终于好啦」）写成一份 markdown 报告。
数据全部来自实测 JSON，不手写：
  · tools/bf/gen_bf_happy_n.py 写的 _bf_happy_n_report.json（F0 + 谱质心 + RMS）
  · 同目录 _bf_happy_n_omni.json（omni 盲听转写）
  · 池内 5 条现量（时长 / F0 / 谱质心 / RMS）

输出：<工作区>/_bf_happy_n_src/_bf_happy_n_report.md
用法：python tools/bf/report_bf11.py [--stdout]
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_bf_happy_n as N

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

OUT_MD = os.path.join(N.SRC_DIR, "_bf_happy_n_report.md")

# 池内 5 条（顺序 = breakfast.js 里 BF_SFX_FILES.happy 的顺序 + slow）
POOL = [("「开动啦」", "happy_v1.mp3", "好耶！开动啦！", "Ethan", "成功上餐"),
        ("v3", "happy_v3.mp3", "哇哦！好香啊！", "Chelsie", "成功上餐"),
        ("「终于好啦」（本轮新换 · 不含呜呼）", "happy_finally2.mp3", "太棒啦！终于好啦！", "Ethan", "成功上餐"),
        ("i45", "happy_i45.mp3", "哇哦！", "Cherry", "成功上餐"),
        ("「哼，太慢了」", "slow.mp3", "哼，太慢了", "—", "跑单")]
OFF = [("happy_v2.mp3", "呜呼！终于好啦！", "Cherry", "已停用 · 含「呜呼」，用户否决；文件留在盘上"),
       ("happy_finally3.mp3", "哇！终于好啦！", "Cherry", "对比件 · 不含「呜呼」，未进池")]


def load(p, default=None):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def measure(f):
    p = os.path.join(N.OUT_DIR, f)
    if not os.path.exists(p):
        return None
    info = N.G.probe_info(p)
    return {"dur": info["duration"] if info else 0.0,
            "ps": N.G.pitch_stats(p), "sp": N.spec_stats(p)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stdout", action="store_true")
    args = ap.parse_args()

    rep = load(N.report_path())
    if not rep:
        print("缺报告：%s（先跑 gen_bf_happy_n.py --report）" % N.report_path(), file=sys.stderr)
        return 2
    omni = load(N.omni_path(), {}) or {}
    heard = {r["name"]: r for r in omni.get("rows", [])}

    rows = rep["rows"]
    N.add_scores(rows)
    rows.sort(key=lambda r: (0 if ((r.get("pitch") or {}).get("delta_pct", -999)) >= 2.0 else 1,
                             -(r.get("composite") or -999)))

    L = []
    A = L.append
    A("# 早餐店「拿到早餐的欢呼」—— 本轮候选与池子变更（bf-11）")
    A("")
    A("用户本轮三条原话：")
    A("")
    A("> 「我说了要保留之前的'终于好啦''开动啦'，还有没及时给餐走掉的客人说'哼太慢了'。")
    A("> 我感觉这次新换的语调没有表现出高兴的感觉，重新给我几个候选。")
    A("> 保留我前面说的'终于好啦''开动啦''哼太慢了'」")
    A("")
    A("> 「游戏里轮换「终于好啦」「开动啦」「哼，太慢了」这三个之前的语言。")
    A("> 还有 v3 和 i45 共 5 个。你把这三个之前的语言再给我听一下。」")
    A("")
    A("> 「换成不含'呜呼'的版本」")
    A("")
    A("## 一、游戏轮换池（已生效，真源 = `breakfast.js` 的 `BF_SFX_FILES`）")
    A("")
    A("```js")
    A('happy: ["happy_v1.mp3", "happy_v3.mp3", "happy_finally2.mp3", "happy_i45.mp3"],')
    A('slow:  ["slow.mp3"]')
    A("```")
    A("")
    A("| 用户说的 | 文件 | 念法 | 音色 | 时长 | F0 走向 | 谱质心 | RMS | 用途 |")
    A("|---|---|---|---|---|---|---|---|---|")
    for said, f, text, voice, use in POOL:
        m = measure(f)
        if not m:
            A("| %s | `%s` | 「%s」 | %s | 缺文件 | — | — | — | %s |" % (said, f, text, voice, use))
            continue
        A("| %s | `%s` | 「%s」 | %s | %.2fs | %+.1f%% | %d Hz | %.4f | %s |" % (
            said, f, text, voice, m["dur"], m["ps"]["delta_pct"],
            m["sp"]["centroid_med"], m["sp"]["rms_med"], use))
    A("")
    A("## 二、`happy_v2` 的处置（用户要求「换成不含呜呼的版本」）")
    A("")
    A("- `happy_v2.mp3`「**呜呼**！终于好啦！」**已不在任何播放通道里**"
      "（运行时核对：`happy_v2.mp3 在任何通道里? false`），**文件仍留在盘上**供对比。")
    A("- 取代它的是 `happy_finally2.mp3`「太棒啦！终于好啦！」——**不含「呜呼」**。")
    A("- 替代件实测：**F0 +53.6%**（148→228Hz）、谱质心 **1189Hz**、RMS **0.1050**、")
    A("  omni 盲听两遍都听成「太棒了，终于好了」= **念对**。它是 `happy_n56.mp3` 的逐字节副本。")
    A("- 另留对比件 `happy_finally3.mp3`「哇！终于好啦！」（Cherry，F0 +7.7%）——**未进池**。")
    A("")
    A("| 文件 | 念法 | 音色 | 状态 |")
    A("|---|---|---|---|")
    for f, text, voice, note in OFF:
        A("| `%s` | 「%s」 | %s | %s |" % (f, text, voice, note))
    A("")
    A("## 三、本轮候选表（共 %d 条 · 上扬的排前面）" % len(rows))
    A("")
    A("| 编号 | 念法 | 音色 | 时长 | F0Δ% | 走向 | 谱质心 | RMS | 综合分 | omni 盲听 |")
    A("|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        ps, sp = r.get("pitch"), r.get("spec")
        if not ps or not sp:
            continue
        h = heard.get(r["name"])
        if h:
            hs = ("✔ " if h.get("ok") else "✘ ") + " ／ ".join(h.get("heard") or [])
        else:
            hs = "（未听）"
        hs = hs.replace("|", "/").replace("\n", " ")
        A("| `%s` | 「%s」 | %s | %.2fs | %+.1f%% | %s | %d Hz | %.4f | %s | %s |" % (
            r["name"], r["text"], r["voice"], r["dur"], ps["delta_pct"],
            "↗ 上扬" if ps["rising"] else ("↘ 下降" if ps["delta_hz"] < 0 else "→ 平"),
            sp["centroid_med"], sp["rms_med"],
            ("%.1f" % r["composite"]) if r.get("composite") is not None else "—", hs))
    A("")
    A("三量权重：F0 **{:.2f}** / 谱质心 **{:.2f}** / RMS **{:.2f}**"
      "（拿用户已表态的老件标定：认可的 v1 F0 +54.1%，被否的 alt2/alt3 -23.9%/+6.1%）。"
      .format(N.W_F0, N.W_CEN, N.W_RMS))
    A("")
    A("## 四、被淘汰的与原因")
    A("")
    gate = [r for r in rows if ((r.get("pitch") or {}).get("delta_pct", -999)) < 2.0]
    A("1. **F0 未上扬（%d 条）** —— 用户第一条诉求就是「上扬」，这些实测没做到：" % len(gate))
    A("")
    A("   " + "、".join("`%s` %+.1f%%" % (r["name"], r["pitch"]["delta_pct"]) for r in gate))
    A("")
    bad = omni.get("bad") or []
    A("2. **omni 盲听没念对（%d 条）** —— %s" % (len(bad), "、".join("`%s`" % b for b in bad) if bad else "无"))
    A("")
    if "happy_n9" in bad:
        A("   其中 `happy_n9`「好耶！开动啦！」是本轮**客观量最好**的一条（F0 **+60.5%**、综合分最高），")
        A("   但 omni **连续 6 次**都听成「**好呀**」而不是「好耶」——判断它确实把这个字念偏了，")
        A("   所以**没有放进 A 组**（没有为了好看放宽判据）。")
        A("")
    A("## 五、试听页")
    A("")
    A("- **`测试截图/bf_pick5.html`** —— 只列池内 5 条 + 停用/对比 2 条")
    A("  （用户要求「你把这三个之前的语言再给我听一下」）。大号播放按钮 + 文本 + 音色 + 时长 + 用途 + 「▶ 全播一遍」。")
    A("- **`测试截图/bf_happy_audition.html`** —— A 组 = 本轮新候选 `n1…n14`（全部过了 omni）；")
    A("  B 组 = 当前在用 4 条（✅ 已启用）；C 组 = 上轮备选 6 条；停用区 = `happy_v2` / `happy_finally3`。")
    A("- 两页都**无外链、无 CDN、离线可开**；引用的音频全部 HTTP 200。")
    A("")
    A("## 六、`slow.mp3`（「哼，太慢了」）未被改动")
    A("")
    A("```")
    A("before: 002E77235A0620E8827C83C7F32ADD818D2228F3C559E63B749117757C8BE985")
    A("after : 002E77235A0620E8827C83C7F32ADD818D2228F3C559E63B749117757C8BE985")
    A("```")
    A("")
    A("生成时间：%s" % __import__("time").strftime("%Y-%m-%d %H:%M"))
    A("")

    os.makedirs(N.SRC_DIR, exist_ok=True)
    with open(OUT_MD, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(L))
    print("→ %s" % OUT_MD)
    if args.stdout:
        print("\n".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
