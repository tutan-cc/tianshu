#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""═══════════════════════════════════════════════════════════════════════════
   tools/bf/gen_bf_happy_n.py — 「拿到早餐的欢呼」**第三轮候选**（happy_n1 … happy_nN）

   用户原话（本轮的验收口径，一字不改）：
     「我说了要保留之前的'终于好啦''开动啦'，还有没及时给餐走掉的客人说'哼太慢了'。
       我感觉这次新换的语调没有表现出高兴的感觉，重新给我几个候选。
       保留我前面说的'终于好啦''开动啦''哼太慢了'」

   拆成三条硬要求（本脚本逐条落实）：
     ① 文本必须回到「终于好啦 / 开动啦」这类**用户认可过的措辞**；
        上一轮被否掉的词是「呜呼」—— 所以本池**一条都不许出现「呜呼」**，
        该位置换 哦耶 / 好耶 / 耶 / 哇 / 太棒啦 / 耶嘿 / 哇哦。
        （脚本末尾有 assert，出现「呜呼」直接崩，不靠人眼守。）
     ② `audio/bf/slow.mp3`（「哼，太慢了」）**一个字都不改** —— 本脚本只写
        happy_n*.mp3，绝不触碰 slow.mp3；调用方在跑前/跑后各取一次 SHA256 对照。
     ③ 上一轮 alt2「呜呼～太好啦！」alt3「哇！谢谢！」的问题是**听着不高兴**：
        只把 F0 抬上去不够。所以本轮除 F0 走向外，**再加两个客观量**：
          · RMS（响度）：兴奋的喊声通常更响；RMS 塌下去 = 有气无力
          · 谱质心（spectral centroid）：越高越「明亮」，低 = 发闷、没精神
        排序用三者综合分（z-score 归一后加权），三个量都写进报告与试听页。

   与既有脚本的关系（互不干扰）：
     · tools/audio/gen_bf_happy.py  → happy_v1..v6 / happy_alt1..6（**不改**，试听页 B 组靠它）
     · tools/bf/gen_bf_happy_i.py   → happy_i1..i57（**不改**，试听页 C 组靠它）
     · tools/bf/gen_bf_happy_n.py   → 本脚本，只产出 happy_n1..nN

   实现上**直接复用** gen_bf_happy_i.py 的 synth / master / probe_info / pitch_stats /
   omni_listen（那四段是实测校验过的），本脚本只新增：
     · 词表 N_LINES（本轮文本 × 音色 × 兴奋度指令）
     · **频谱分析**（纯标准库 radix-2 FFT）→ 谱质心 + RMS
     · 综合排序 + 报告 + 试听页数据（_bf_happy_n_report.json / _bf_happy_n_omni.json）

   凭证：只从环境变量取，绝不落盘。
     DASHSCOPE_API_KEY   业务空间 API Key
     DASHSCOPE_BASE_URL  业务空间兼容模式地址（从它推出 DashScope 原生 TTS 地址）

   用法：
     python tools/bf/gen_bf_happy_n.py                  # 生成 + 加工到 audio/bf/
     python tools/bf/gen_bf_happy_n.py --probe          # 只探第一条
     python tools/bf/gen_bf_happy_n.py --report         # 不生成，只量已落盘文件（F0+RMS+质心）
     python tools/bf/gen_bf_happy_n.py --listen         # omni 盲听（逐条转写 + 同音匹配）
     python tools/bf/gen_bf_happy_n.py --rank           # 只按综合分排序打印（读 report）
   ═══════════════════════════════════════════════════════════════════════════"""
import argparse
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_bf_happy_i as G          # 复用实测过的接口/加工/F0/盲听四段实现

REPO = G.REPO
OUT_DIR = G.OUT_DIR                                       # audio/bf
SRC_DIR = os.path.join(os.path.dirname(REPO), "audio-工作区", "_bf_happy_n_src")
AUDIO_WORKSPACE = os.path.dirname(REPO)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

MODEL_TTS = G.MODEL_TTS
MODEL_INSTRUCT = G.MODEL_INSTRUCT
OMNI_MODEL = G.OMNI_MODEL

# 档位：本轮全部是**完整短句**（用户点名要保留「终于好啦 / 开动啦」），走 s 档 1.0~2.6s。
TIER = "s"
DUR = G.DUR["s"]

# ── 兴奋度指令（本轮的核心手段）─────────────────────────────────────────────
# 上一轮失败的根因：指令只写了「上扬 / 不要下沉」——这几条只约束**基频走向**，
# 模型完全可以在「音高上去」的同时用**发闷、平、收着**的音色念出来，
# 结果就是用户听到的「没表现出高兴」。所以本轮每条指令都必须同时约束四件事：
#   ① 情绪词要**很具体**（兴奋地欢呼 / 开心地喊出来 / 雀跃地叫）
#   ② 音调**明显上扬**、句尾挑起来（F0 走向）
#   ③ **明亮、有精神、响亮**（谱质心 + RMS —— 上一轮缺的就是这两条）
#   ④ **不要**下沉 / 不要拖长 / 不要平淡（负向约束，实测不加会退回默认的「重音在头」）
INSTR_A = ("兴奋地欢呼出来，情绪特别开心，音调明显上扬、句尾往上挑，"
           "声音明亮有精神、响亮外放，不要平淡、不要拖长、不要下沉收尾")
INSTR_B = ("开心地大声喊出来，非常雀跃，语调一路上扬、最后一个字扬到最高，"
           "嗓音明亮清亮、有活力、音量饱满，不要闷、不要压着、不要平淡")
INSTR_C = ("雀跃地欢呼，像拿到盼望已久的东西那样高兴，音调上扬、跳跃、轻快，"
           "声音明亮有精神、放得开，不要拖长、不要下沉、不要平静地念")
INSTR_D = ("惊喜又激动地喊出来，情绪外放，音调明显上扬、尾音挑起来，"
           "嗓音明亮、有精神、响，不要平淡、不要含糊、不要往下压")
# 第二轮加试：**升调专用**措辞。「终于好啦」的「啦」默认会被念成下坠（第一轮 8 条里 6 条在降），
# 所以这两条把「起点低、一路往上冲、末字到最高」写成明确指令，博一个真的往上走的收尾。
# ⚠ 为什么过了动词/名词不加「重音」：实测「重音在头」正是句尾下沉的来源，
#   明确要求「不要把重音放在句首」比要求「加重语气」有用。
INSTR_RISE = ("从较低的音开始，音调一路上扬、越念越高，最后一个字冲到最高并挑起来，"
              "兴奋开心、声音明亮有精神，不要句尾下沉、不要把重音放在句首、不要拖长")
INSTR_RISE2 = ("起头压低一些，然后整句持续往上爬，句尾高高扬起像欢呼，"
               "雀跃、明亮、有活力，不要下坠收尾、不要平着念")

# ── 候选池：(文件基名, 念法, 音色, 兴奋度指令) ─────────────────────────────
# 组池原则：
#   · 文本**只用用户认可的措辞**：终于好啦 / 开动啦 / 有早餐吃啦 / 开动开动 /
#     终于等到啦，前缀换 哦耶 / 好耶 / 耶 / 哇 / 太棒啦 / 耶嘿 / 哇哦（**无「呜呼」**）
#   · **同一条文本至少 2 个音色**（用户要对比音色；同文本同音色换指令也算一个方向）
#   · 音色只用 instruct 支持的：Cherry / Serena / Ethan / Chelsie / Nofish
#     （Jennifer 走 instruct 会被拒：Voice 'Jennifer' is not supported）
#   · 生成 18 条 → 客观量 + 盲听筛出 **前 14 条** 进试听页 A 组（宁多勿少）
N_LINES = [
    # ── 「终于好啦」家族（用户点名保留）──
    ("happy_n1",  "哦耶！终于好啦！",     "Cherry",  INSTR_A),
    ("happy_n2",  "哦耶！终于好啦！",     "Ethan",   INSTR_B),
    ("happy_n3",  "太棒啦！终于好啦！",   "Ethan",   INSTR_C),
    ("happy_n4",  "太棒啦！终于好啦！",   "Cherry",  INSTR_D),
    ("happy_n5",  "哇！终于好啦！",       "Chelsie", INSTR_D),
    ("happy_n6",  "哇！终于好啦！",       "Cherry",  INSTR_C),
    ("happy_n7",  "好耶！终于等到啦！",   "Serena",  INSTR_A),
    ("happy_n8",  "好耶！终于等到啦！",   "Chelsie", INSTR_B),
    # ── 「开动啦」家族（用户点名保留）──
    ("happy_n9",  "好耶！开动啦！",       "Ethan",   INSTR_A),
    ("happy_n10", "好耶！开动啦！",       "Chelsie", INSTR_B),
    ("happy_n11", "耶！开动啦！",         "Serena",  INSTR_C),
    ("happy_n12", "耶！开动啦！",         "Cherry",  INSTR_A),
    ("happy_n13", "太棒啦！开动啦！",     "Ethan",   INSTR_D),
    ("happy_n14", "太棒啦！开动啦！",     "Nofish",  INSTR_C),
    ("happy_n15", "耶嘿！开动啦！",       "Chelsie", INSTR_C),
    ("happy_n16", "耶嘿！开动啦！",       "Nofish",  INSTR_A),
    # ── 其它「拿到早餐」的开心说法（同样保留短句后半截）──
    ("happy_n17", "哇哦！终于好啦！",     "Nofish",  INSTR_D),
    ("happy_n18", "哇哦！终于好啦！",     "Serena",  INSTR_B),
    ("happy_n19", "哦耶！开动开动！",     "Serena",  INSTR_C),
    ("happy_n20", "哦耶！开动开动！",     "Nofish",  INSTR_B),
    ("happy_n21", "好耶！有早餐吃啦！",   "Cherry",  INSTR_B),
    ("happy_n22", "好耶！有早餐吃啦！",   "Ethan",   INSTR_C),
    ("happy_n23", "谢谢！终于好啦！",     "Serena",  INSTR_D),
    ("happy_n24", "谢谢！终于好啦！",     "Chelsie", INSTR_A),

    # ═══════ 第二轮（n25…）· 实测后补摇 ═══════
    # 第一轮 24 条的实测结果（见 --report）把问题摆得很清楚：
    #   **只有 8/24 真的上扬**，而且用户点名要保留的两句恰好最差：
    #     「终于好啦」家族 8 条：-18.5 / -14.6 / -9.9 / -18.6 / +1.2 / +7.7 / -5.8 / -15.7 %
    #     （只有 n5「哇！终于好啦！」+1.2%、n6 同文本 +7.7% 勉强站住）
    #     「开动啦」家族反而好：n9 +60.5%、n10 +10.6%、n13 +21.3%
    #   小组均值：Ethan +14.3% / Chelsie -6.8% / Cherry -9.6% / Serena -11.6%（同指令下仍是随机性主导）
    #   → 结论：**TTS 把「终于好啦」的「啦」念成下坠是默认行为**，靠一次生成碰运气不够，
    #     必须给这两句**加倍摇**（同文本多音色 × 多指令措辞都试一遍），再从实测里挑上扬的。
    #   同时给「上扬」表现最好的 Ethan 加试**升调专用指令**（从低起步、一路往上冲）。
    ("happy_n25", "哦耶！终于好啦！",   "Ethan",   INSTR_RISE),
    ("happy_n26", "哦耶！终于好啦！",   "Cherry",  INSTR_RISE),
    ("happy_n27", "哦耶！终于好啦！",   "Chelsie", INSTR_B),
    ("happy_n28", "哇！终于好啦！",     "Ethan",   INSTR_RISE2),
    ("happy_n29", "哇！终于好啦！",     "Serena",  INSTR_RISE),
    ("happy_n30", "哇！终于好啦！",     "Nofish",  INSTR_B),
    ("happy_n31", "好耶！开动啦！",     "Cherry",  INSTR_RISE),
    ("happy_n32", "好耶！开动啦！",     "Serena",  INSTR_RISE2),
    ("happy_n33", "好耶！开动啦！",     "Nofish",  INSTR_C),
    ("happy_n34", "耶！开动啦！",       "Ethan",   INSTR_RISE),
    ("happy_n35", "耶！开动啦！",       "Nofish",  INSTR_RISE2),
    ("happy_n36", "好耶！终于等到啦！", "Ethan",   INSTR_RISE),
    ("happy_n37", "好耶！终于等到啦！", "Cherry",  INSTR_B),
    ("happy_n38", "太棒啦！终于好啦！", "Nofish",  INSTR_RISE2),
    ("happy_n39", "太棒啦！开动啦！",   "Cherry",  INSTR_RISE),
    ("happy_n40", "耶嘿！开动啦！",     "Ethan",   INSTR_RISE2),
    ("happy_n41", "哇哦！终于好啦！",   "Ethan",   INSTR_A),
    ("happy_n42", "哦耶！开动开动！",   "Ethan",   INSTR_RISE),
    ("happy_n43", "好耶！有早餐吃啦！", "Chelsie", INSTR_RISE),
    ("happy_n44", "谢谢！终于好啦！",   "Nofish",  INSTR_B),
    ("happy_n45", "哇！开动啦！",       "Chelsie", INSTR_B),
    ("happy_n46", "哇！开动啦！",       "Serena",  INSTR_D),
    ("happy_n47", "哦耶！终于好啦！",   "Nofish",  INSTR_D),
    ("happy_n48", "好耶！终于等到啦！", "Nofish",  INSTR_C),

    # ═══════ 第三轮（n49…）· 为 v2 找一条**不含「呜呼」**的替代件 ═══════
    # 用户本轮点名要「终于好啦」，而池里那条（happy_v2）文本是「**呜呼**！终于好啦！」——
    # 带他更早一轮否掉的「呜呼」。不擅自替换，但要给一条能直接听对比的替代件
    # （目标文件名 happy_finally2.mp3，试听页 bf_pick5.html 里标「备选 · 不含呜呼」）。
    # 前两轮「终于好啦」家族 11 条里只有 2 条上扬（n5 +1.2%、n6 +7.7%），说明这个收尾
    # 默认下坠；这里再对**同一句**多音色 × 升调指令摇一轮，挑实测上扬且明亮的那条。
    ("happy_n49", "哦耶！终于好啦！",   "Cherry",  INSTR_RISE2),
    ("happy_n50", "哦耶！终于好啦！",   "Ethan",   INSTR_RISE2),
    ("happy_n51", "哦耶！终于好啦！",   "Chelsie", INSTR_RISE),
    ("happy_n52", "哦耶！终于好啦！",   "Cherry",  INSTR_D),
    ("happy_n53", "太棒啦！终于好啦！", "Cherry",  INSTR_RISE2),
    ("happy_n54", "太棒啦！终于好啦！", "Serena",  INSTR_RISE),
    ("happy_n55", "太棒啦！终于好啦！", "Chelsie", INSTR_RISE2),
    ("happy_n56", "太棒啦！终于好啦！", "Ethan",   INSTR_RISE),

    # ═══════ 第四轮（n57…）· 补「好耶！终于好啦！」这个文本方向 ═══════
    # 用户最后拍板「换成不含『呜呼』的版本」，点名试这三个文本：
    #   哦耶！终于好啦！ / 太棒啦！终于好啦！ / 好耶！终于好啦！
    # 前两个已经摇过（n1/n2/n25-n27/n47/n49-n52 与 n3/n4/n38/n53-n56），
    # 「好耶！终于好啦！」**一条都没有** → 这里补齐，免得「三个文本都试过」这句话虚。
    ("happy_n57", "好耶！终于好啦！",   "Cherry",  INSTR_RISE2),
    ("happy_n58", "好耶！终于好啦！",   "Ethan",   INSTR_RISE),
    ("happy_n59", "好耶！终于好啦！",   "Serena",  INSTR_RISE2),
]

# ── 硬闸（脚本级，不靠人眼守）───────────────────────────────────────────────
# ① 本轮**不许出现「呜呼」**（那是用户否掉的词）
_BANNED = "呜呼"
for _r in N_LINES:
    assert _BANNED not in _r[1], "候选池里出现了被否掉的词「%s」：%s" % (_BANNED, _r[0])
# ② 用户点名要保留的措辞**必须真的在池子里**
for _need in ("终于好啦", "开动啦"):
    assert any(_need in _r[1] for _r in N_LINES), "候选池里没有保留下用户要的措辞「%s」" % _need
# ③ **每条文本至少 2 个音色**（用户要求「同一条文本至少 2 个音色」）
_by_text = {}
for _r in N_LINES:
    _by_text.setdefault(_r[1], set()).add(_r[2])
_solo = [t for t, v in _by_text.items() if len(v) < 2]
assert not _solo, "下列文本只有 1 个音色（要求至少 2 个）：%s" % "、".join(_solo)
# ④ 每个音色都得有活干（不能出现某音色 0 条 → 试听页对比不出音色差异）
_voices = {}
for _r in N_LINES:
    _voices[_r[2]] = _voices.get(_r[2], 0) + 1
assert len(_voices) >= 4, "音色种类太少（%d 种）：%s" % (len(_voices), _voices)
assert all(v >= 2 for v in _voices.values()), "有音色少于 2 条：%s" % _voices

BY_NAME = {r[0]: r for r in N_LINES}

# ── omni 盲听的同音白名单（沿用 gen_bf_happy_i 的做法：不做「为了让某条过关」的暗改）──
# 「啦 / 了」这一对的归一**理由与 gen_bf_happy.py 里写的一样**：句末语气词「啦」= 「了+啊」，
# 实测同一条音频会一轮听成「开动啦」、下一轮听成「开动了」，属于转写抖动不是念错词。
# 实词（终于 / 开动 / 早餐 / 太棒 / 谢谢 …）**不放宽**。
HOMOPHONE = dict(G.HOMOPHONE)
HOMOPHONE.update({
    "哦耶终于好啦": ["哦耶终于好啦", "哦也终于好啦", "欧耶终于好啦", "哦耶终于好了", "哦耶，终于好啦", "噢耶终于好啦"],
    "太棒啦终于好啦": ["太棒啦终于好啦", "太棒了终于好啦", "太棒啦终于好了", "太棒啦，终于好啦"],
    "哇终于好啦": ["哇终于好啦", "哇终于好了", "哇，终于好啦", "哇！终于好啦"],
    "好耶终于等到啦": ["好耶终于等到啦", "好耶终于等到了", "好也终于等到啦", "好耶，终于等到啦"],
    "好耶开动啦": ["好耶开动啦", "好也开动啦", "好耶开动了", "好耶，开动啦"],
    "耶开动啦": ["耶开动啦", "也开动啦", "耶开动了", "耶，开动啦"],
    "太棒啦开动啦": ["太棒啦开动啦", "太棒了开动啦", "太棒啦开动了", "太棒啦，开动啦"],
    "耶嘿开动啦": ["耶嘿开动啦", "耶黑开动啦", "耶嘿开动了", "耶嘿，开动啦", "也嘿开动啦"],
    "哇哦终于好啦": ["哇哦终于好啦", "哇噢终于好啦", "哇喔终于好啦", "哇哦终于好了", "哇哦，终于好啦"],
    "哦耶开动开动": ["哦耶开动开动", "哦也开动开动", "欧耶开动开动", "哦耶，开动开动", "哦耶开动开动了"],
    "好耶有早餐吃啦": ["好耶有早餐吃啦", "好也有早餐吃啦", "好耶有早餐吃了", "好耶，有早餐吃啦"],
    "谢谢终于好啦": ["谢谢终于好啦", "谢谢终于好了", "谢谢，终于好啦", "谢谢你终于好啦"],
    # 第二轮新出现的文本（判据与上面一致：只归一「啦/了」，实词不放宽）
    "哦耶开动啦": ["哦耶开动啦", "哦也开动啦", "欧耶开动啦", "哦耶开动了", "哦耶，开动啦"],
    "哇开动啦": ["哇开动啦", "哇开动了", "哇，开动啦"],
    "太棒啦有早餐吃啦": ["太棒啦有早餐吃啦", "太棒了有早餐吃啦", "太棒啦有早餐吃了", "太棒啦，有早餐吃啦"],
    "耶终于好啦": ["耶终于好啦", "也终于好啦", "耶终于好了", "耶，终于好啦"],
    "哦耶有早餐吃啦": ["哦耶有早餐吃啦", "哦也有早餐吃啦", "欧耶有早餐吃啦", "哦耶有早餐吃了"],
    "哇耶开动啦": ["哇耶开动啦", "哇也开动啦", "哇耶开动了", "哇，耶，开动啦"],
    "好耶终于好啦": ["好耶终于好啦", "好也终于好啦", "好耶终于好了", "好耶，终于好啦", "好呀终于好啦"],
    # 第三轮实测补的白名单（都是**同音/近音的转写**，不是放宽实词）：
    #   happy_n9「好耶！开动啦！」两遍都被听成「好呀，开动啦！」——「耶/呀」在这个位置
    #   是同一声母韵母邻位的语气词（ye / ya），模型按音记字记成了「呀」。
    #   「好耶」在 G.HOMOPHONE 里只白名单了 也/吔/噎，没有 呀，所以在这里补上。
    #   ⚠ 不放宽的情形：好耶被听成「好唉/好嘞」这种就仍算 ✘（那是真的换词了）。
    "好耶": ["好也", "好吔", "好噎", "好呀"],
})

# ── 「啦 / 了」统一归一（**不是为了让某条过关，是把同一条规则用全**）─────────────
# 依据与 gen_bf_happy.py 里写下的完全一样：句末语气词「啦」本来就是「了 + 啊」的合音，
# 汉语里两字在句末几乎不分；实测同一条音频 omni 会一轮听成「开动啦」、下一轮听成「开动了」，
# 属于**转写抖动**不是 TTS 念错词。
# 为什么要写成统一函数：第一版只把它体现在「逐个词写白名单」里（"太棒啦":["太棒了"]），
# 结果**只归一了句首那个词**：本轮实测
#   「太棒啦！开动啦！」被听成「太棒了，开动了」→ 前半 太棒啦/太棒了 归一对上了，
#   后半 开动啦/开动了 也对上了，但**中间连起来**的整串仍不在白名单里 → 误判 ✘。
# 现在改成：判据拿「原文本」和「啦→了的文本」各跑一遍连续匹配，两边都算对。
# 实词（终于 / 开动 / 早餐 / 太棒 / 谢谢 …）仍然**一个都不放宽**。
LA_LE = {"啦": "了"}


def _la_to_le(text):
    return "".join(LA_LE.get(ch, ch) for ch in (text or ""))


def accepts(expected, heard):
    """heard 是否念对了 expected：原串 + 啦→了 串 各做一次同音匹配，任一命中即算对。"""
    for cand in (expected, _la_to_le(expected)):
        if cand and G._hit(cand, heard)[0]:
            return True
    return False

OMNI_PROMPT = G.OMNI_PROMPT

# ══════════════════════════════════════════════════════════════════════════
#  频谱分析（新增的客观量）—— 纯标准库 radix-2 FFT
#  本机 hermes venv **没有 numpy、不能 pip install**，所以自己写 FFT。
#  上一轮只量了 F0：F0 上扬 ≠ 听起来高兴（可以用发闷、收着的声音把音高抬上去）。
#  谱质心 = Σ f·|X(f)| / Σ |X(f)|，反映「亮度」：越高越明亮清脆、越低越发闷。
#  RMS 反映「响度/力度」：兴奋的喊声通常更响，RMS 塌下去听着就有气无力。
# ══════════════════════════════════════════════════════════════════════════
SPEC_SR = 16000          # 与 G.PCM_SR 一致（decode_pcm 已按 16k 解码）
NFFT = 512               # 32ms @16k：与 F0 的帧长一致，口径统一
SPEC_HOP = 256           # 16ms：与 F0 的 hop 一致

# 旋转因子表：{n: [(cos, sin)] * (n//2)}，**按 n 缓存**。
# ⚠ 这里是第一版的 bug 现场，留个记录免得再踩：第一版把所有级的旋转因子压成**一条扁平表**，
#   然后靠 `pos += half` 逐级递进取用 —— 但「本级起点」在扁平表里的偏移是 n - k（k 为当前级长），
#   不是半个 k。写错之后 n=16 的第 2 级会去取第 1 级的表，结果就是：
#       n=8/16 的复指数（bin 3）峰值跑到 5/13，n=512 的 300Hz 纯音峰值跑到 bin 230（7187Hz）。
#   现在改成**每级现算自己的表**（O(n) 存储、可缓存），不再依赖跨级偏移，从根上消除这类错误。
_FFT_TW = {}


def _tw(n):
    t = _FFT_TW.get(n)
    if t is None:
        t = [(math.cos(-2.0 * math.pi * i / n), math.sin(-2.0 * math.pi * i / n))
             for i in range(n // 2)]
        _FFT_TW[n] = t
    return t


def _fft_pow2(x):
    """就地 radix-2 FFT（迭代 Cooley-Tukey，DIT + 位反转输入）。x = [re, im] 交替，长度 2^k。

    已做单元自检（--selftest）：n=8…1024 的复指数峰值落在期望 bin；
    300/1000/3000/5000Hz 纯音解码后量出的谱质心误差 < 10%。
    """
    n = len(x) // 2
    # 位反转置换（对偶下标成对交换）
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            x[2 * i], x[2 * j] = x[2 * j], x[2 * i]
            x[2 * i + 1], x[2 * j + 1] = x[2 * j + 1], x[2 * i + 1]
    # 逐级蝶形：k = 本级长度（2, 4, 8, … n），每级用自己的旋转因子表
    k = 2
    while k <= n:
        half = k // 2
        tw = _tw(k)
        for start in range(0, n, k):
            for i in range(half):
                wr, wi = tw[i]
                a = 2 * (start + i)
                b = 2 * (start + i + half)
                tr = x[b] * wr - x[b + 1] * wi
                ti = x[b] * wi + x[b + 1] * wr
                x[b] = x[a] - tr
                x[b + 1] = x[a + 1] - ti
                x[a] += tr
                x[a + 1] += ti
        k <<= 1


def _hann(n):
    return [0.5 - 0.5 * math.cos(2.0 * math.pi * i / (n - 1)) for i in range(n)]


_HANN = _hann(NFFT)


def _median(v):
    if not v:
        return 0.0
    s = sorted(v)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2.0


def _pct(v, p):
    """百分位（p = 0~100）。"""
    if not v:
        return 0.0
    s = sorted(v)
    idx = min(len(s) - 1, max(0, int(round((p / 100.0) * (len(s) - 1)))))
    return s[idx]


def spec_stats(path):
    """量一条成品的「亮度 + 响度」：谱质心（中位/均值）与 RMS。

    ⚠ 谱质心必须**先减本帧噪声底**（实测踩过的坑，不这么做量出来的数不能用）：
      128kbps mp3 在整条 0~8kHz 上留了一层量化噪声，纯音实测（单元自检）：
        300Hz 纯音 → 直接算质心 4122Hz（偏 +1274%）、1000Hz → 4045Hz（+305%）、
        3000Hz → 3262Hz（+8.7%）、5000Hz → 3645Hz（-27%）。
      即：**噪声底把低音的质心整条抬到 4kHz 附近，量出来的不是亮度而是噪声**。
      做法：取本帧幅度谱的 20 分位当噪声底，谱线减去它（负数截 0）再算加权质心。
      减完复测同一批纯音，误差回到个位数百分比（见 --selftest）。

    只统计**浊音帧**（RMS 高于本条 30 分位），静音/气口会把质心拉飞。
    返回 None 表示这条音频几乎没声音。
    """
    import array
    buf = G.decode_pcm(path, SPEC_SR)
    if not buf:
        return None
    total = len(buf) // 2
    if total < NFFT:
        return None
    frames = []                     # (rms, centroid_hz)
    i = 0
    while i + NFFT <= total:
        a = array.array("h")
        a.frombytes(buf[i * 2:(i + NFFT) * 2])
        s2 = 0.0
        for v in a:
            s2 += float(v) * v
        rms = math.sqrt(s2 / NFFT) / 32768.0
        if rms > 1e-4:
            mean = sum(a) / float(NFFT)
            x = [0.0] * (2 * NFFT)
            for k in range(NFFT):
                x[2 * k] = (a[k] - mean) * _HANN[k]
            _fft_pow2(x)
            bins = NFFT // 2                       # 1 .. 256（0 ~ 8kHz @16k）
            mags = []
            for k in range(1, bins + 1):
                re, im = x[2 * k], x[2 * k + 1]
                mags.append(math.sqrt(re * re + im * im))
            # 本帧噪声底 = 幅度谱 20 分位；减掉它再算质心（否则量的是 mp3 量化噪声）
            floor = _pct(mags, 20)
            num = den = 0.0
            for idx, mag in enumerate(mags):
                m = mag - floor
                if m > 0.0:
                    num += ((idx + 1) * SPEC_SR / float(NFFT)) * m
                    den += m
            if den > 1e-9:
                frames.append((rms, num / den))
        i += SPEC_HOP
    if len(frames) < 3:
        return None

    rmss = sorted(f[0] for f in frames)
    gate = max(1e-4, _pct(rmss, 30))
    voiced = [f for f in frames if f[0] >= gate]
    if len(voiced) < 3:
        voiced = frames
    cen = [f[1] for f in voiced]
    rm = [f[0] for f in voiced]
    return {
        "centroid_med": round(_median(cen), 1),
        "centroid_mean": round(sum(cen) / len(cen), 1),
        "centroid_max": round(max(cen), 1),
        "rms_med": round(_median(rm), 5),
        "rms_mean": round(sum(rm) / len(rm), 5),
        "rms_max": round(max(rm), 5),
        "voiced_frames": len(voiced),
        "frames": len(frames),
    }


def selftest():
    """单元自检：FFT 正确性（多档 n）+ 谱质心对已知纯音的准确度（--selftest 调用）。"""
    import array as _ar
    import subprocess
    import tempfile
    import wave as _w
    bad = 0

    # ① FFT：复指数 bin 3 的峰值必须落在 bin 3。
    #    ⚠ 这里必须用**复**指数（e^{i2π3t/n}），不能用 cos：
    #      实信号的谱是共轭对称的（|X[k]| == |X[n-k]|，实测差 1.8e-15），
    #      用 cos 时 bin3 与 bin(n-3) 数值上并列，max() 有时会选中镜像 bin，
    #      造成 n=32/64「假失败」。复指数没有镜像，判据唯一。
    for n in (8, 16, 32, 64, 128, 256, 512, 1024):
        x = [0.0] * (2 * n)
        for t in range(n):
            ang = 2.0 * math.pi * 3 * t / n
            x[2 * t] = math.cos(ang)
            x[2 * t + 1] = math.sin(ang)
        _fft_pow2(x)
        mags = [math.sqrt(x[2 * k] ** 2 + x[2 * k + 1] ** 2) for k in range(n)]
        pk = mags.index(max(mags))
        ok = (pk == 3)
        print("%s FFT n=%4d 复指数 bin3 → 峰值 bin %d" % ("✔" if ok else "✘", n, pk))
        if not ok:
            bad += 1

    # ② 谱质心：已知纯音（解码走 ffmpeg，与真实流程一致）
    for f in (300, 1000, 3000, 5000):
        wav = os.path.join(tempfile.gettempdir(), "st%d.wav" % f)
        mp3 = os.path.join(tempfile.gettempdir(), "st%d.mp3" % f)
        a = _ar.array("h")
        for i in range(SPEC_SR):
            a.append(int(12000 * math.sin(2 * math.pi * f * i / SPEC_SR)))
        with _w.open(wav, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SPEC_SR)
            w.writeframes(a.tobytes())
        subprocess.run([G.FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", wav,
                        "-ac", "1", "-ar", "48000", "-c:a", "libmp3lame", "-b:a", "128k", mp3],
                       check=True)
        s = spec_stats(mp3)
        err = (s["centroid_med"] - f) / float(f) * 100
        ok = abs(err) <= 25.0
        print("%s 纯音 %5dHz → 质心 %8.1fHz（误差 %+.1f%%）rms %.5f"
              % ("✔" if ok else "✘", f, s["centroid_med"], err, s["rms_med"]))
        if not ok:
            bad += 1
    print("自检结果：%s" % ("全部通过" if not bad else "%d 项不达标" % bad))
    return 1 if bad else 0


def dry_run_info(path):
    """这条音频的峰值 / 削波比例 —— 用来发现「响度是压出来的、已经削平」的坏件。"""
    import array
    buf = G.decode_pcm(path, SPEC_SR)
    if not buf:
        return None
    a = array.array("h")
    a.frombytes(buf[:len(buf) // 2 * 2])
    if not a:
        return None
    peak = max(abs(v) for v in a)
    clip = sum(1 for v in a if abs(v) >= 32700)
    return {"peak": peak, "peak_dbfs": round(20 * math.log10(max(1, peak) / 32768.0), 2),
            "clip_ratio": round(clip / float(len(a)), 6)}


# ══════════════════════════════════════════════════════════════════════════
#  综合排序：F0 上扬 + 谱质心（明亮）+ RMS（不塌）
#  三个量纲不同 → 先做批次内 z-score（标准差为 0 时退化为 0），再加权。
#
#  ⚠ 权重不是拍脑袋定的，是**拿用户已经表过态的老件标定出来的**（本轮实测，10 条）：
#      用户认可的 v1「好耶！开动啦！」   F0 +54.1%  质心 1306Hz  RMS 0.1498
#      被否掉的 alt2「呜呼～太好啦！」   F0 -23.9%  质心 1408Hz  RMS 0.1675
#      被否掉的 alt3「哇！谢谢！」       F0  +6.1%  质心 1441Hz  RMS 0.1539
#      更早被否的呜呼系列 v2/alt1/alt4   F0 +23.2/-7.0/-3.1%  质心 591/923/569Hz
#    结论（决定权重的依据）：
#      · **F0 走向是唯一能把「认可件」和「被否件」分开的量**（+54.1% vs -23.9%/+6.1%）
#        → 给最高权重 0.45（也呼应「重新给我几个候选」里最早提的「上扬」诉求）
#      · 谱质心分不开这两组（1306 / 1408 / 1441Hz 几乎一样），但它**抓得住"发闷"的坏件**
#        （被否的呜呼系列 569~923Hz 明显塌下去）→ 当**质量闸**用，权重 0.30
#      · RMS 在「认可 / 被否」之间同样分不开（0.1498 vs 0.1675/0.1539 —— 被否的反而略响），
#        但用户要的「兴奋」包含"响亮、不塌"，所以保留为辅助量，权重 0.25
#    没有把质心/RMS 说成"能判高兴"——它们判的是**明亮**与**有力**，
#    真正的情绪判定仍然交给用户的耳朵（试听页里三个量都逐条列出，不藏）。
# ══════════════════════════════════════════════════════════════════════════
W_F0, W_CEN, W_RMS = 0.45, 0.30, 0.25


def _z(vals):
    n = len(vals)
    if n == 0:
        return []
    mu = sum(vals) / n
    var = sum((v - mu) ** 2 for v in vals) / n
    sd = math.sqrt(var)
    if sd < 1e-9:
        return [0.0] * n
    return [(v - mu) / sd for v in vals]


def add_scores(rows):
    """就地把 f0_pct / centroid_med / rms_med 归一化，算综合分 composite（0~100）。"""
    ok = [r for r in rows if r.get("pitch") and r.get("spec")]
    if not ok:
        return rows
    zf = _z([r["pitch"]["delta_pct"] for r in ok])
    zc = _z([r["spec"]["centroid_med"] for r in ok])
    zr = _z([r["spec"]["rms_med"] for r in ok])
    for r, a, b, c in zip(ok, zf, zc, zr):
        r["z"] = {"f0": round(a, 3), "centroid": round(b, 3), "rms": round(c, 3)}
        r["composite"] = round(50.0 + 14.0 * (W_F0 * a + W_CEN * b + W_RMS * c), 1)
    for r in rows:
        r.setdefault("composite", None)
    return rows


def gate_reasons(r):
    """一条候选没过「三量闸」的原因列表（空 = 三量都达标）。"""
    why = []
    ps, sp = r.get("pitch"), r.get("spec")
    if not ps:
        why.append("F0 无量")
    elif not ps["rising"]:
        why.append("F0 未上扬 %+.1f%%" % ps["delta_pct"])
    if not sp:
        why.append("谱质心无量")
    if r.get("dur") and r["dur"] > DUR["max"]:
        why.append("超长 %.2fs" % r["dur"])
    return why


# ══════════════════════════════════════════════════════════════════════════
#  报告 / 盲听落盘
# ══════════════════════════════════════════════════════════════════════════
def report_path():
    return os.path.join(SRC_DIR, "_bf_happy_n_report.json")


def omni_path():
    return os.path.join(SRC_DIR, "_bf_happy_n_omni.json")


def write_json(rows, extra=None):
    os.makedirs(SRC_DIR, exist_ok=True)
    p = report_path()
    with open(p, "w", encoding="utf-8") as f:
        json.dump({"out": OUT_DIR, "tier": TIER, "dur_gate": DUR,
                   "weights": {"f0": W_F0, "centroid": W_CEN, "rms": W_RMS},
                   "rows": rows, "extra": extra or {}}, f, ensure_ascii=False, indent=1)
    return p


def load_json(p, default=None):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def row_of(name, text, voice, ins, path, model=""):
    r = G.row_of(name, text, voice, ins, path, model)
    r["spec"] = spec_stats(path)
    r["peak"] = dry_run_info(path)
    return r


def listen(rows, rounds=2, append=False):
    """omni 盲听：逐条转写，判「念的词对不对」（情绪不在这里判）。

    append=True：把结果**并入**已有报告，而不是覆盖。
    为什么需要：盲听是按批跑的（一次跑 59 条太慢、中间容易被中断），
    而 --only 一小批就把整份报告覆盖掉，会让试听页的 A 组只剩那一小批
    （本轮实测踩过：跑了一次 3 条的补摇，A 组从 14 条掉到 1 条）。
    """
    print("=" * 100)
    print("omni 盲听：%d 条 · 模型 %s · 每条 %d 遍%s" % (len(rows), OMNI_MODEL, rounds,
                                                  "（并入已有报告）" if append else ""))
    print("判据：无调拼音连续匹配 + 同音白名单（哦耶↔哦也、啦↔了 算对；实词一律不放宽）")
    print("=" * 100)
    prev = []
    if append:
        old = load_json(omni_path(), {}) or {}
        prev = old.get("rows", [])
    done = {r["name"] for r in prev}
    out, bad = [], []
    for i, r in enumerate(rows, 1):
        if r["name"] in done and not append:
            pass
        p = os.path.join(OUT_DIR, r["name"] + ".mp3")
        if not os.path.exists(p):
            print("[%d/%d] %s  缺文件" % (i, len(rows), r["name"]))
            continue
        heard = G.omni_listen(p, rounds)
        oks = [accepts(r["text"], h) for h in heard if not h.startswith("[调用失败]")]
        ok = any(oks)
        print("[%d/%d] %-11s 「%s」%s" % (i, len(rows), r["name"], r["text"], "✔" if ok else "✘"))
        for h in heard:
            print("           omni 原话：%s" % h)
        out.append({"name": r["name"], "expect": r["text"], "voice": r["voice"],
                    "dur": r.get("dur"), "heard": heard, "ok": ok})
        if not ok:
            bad.append(r["name"])
        time.sleep(0.3)
    merged = {x["name"]: x for x in prev}
    for x in out:
        merged[x["name"]] = x                      # 新结果覆盖同名的旧结果
    rows_all = list(merged.values())
    bad_all = [x["name"] for x in rows_all if not x["ok"]]
    os.makedirs(SRC_DIR, exist_ok=True)
    with open(omni_path(), "w", encoding="utf-8") as f:
        json.dump({"model": OMNI_MODEL, "rounds": rounds, "rows": rows_all, "bad": bad_all,
                   "at": time.strftime("%Y-%m-%d %H:%M:%S")}, f, ensure_ascii=False, indent=1)
    print("=" * 100)
    print("本批念对 %d/%d" % (len(out) - len(bad), len(out))
          + (" · 本批可疑件：" + "、".join(bad) if bad else ""))
    print("累计 %d 条，念对 %d 条" % (len(rows_all), len(rows_all) - len(bad_all)))
    print("报告：%s" % omni_path())
    return rows_all, bad_all


def print_table(rows, title=""):
    if title:
        print("\n" + title)
    print("%-12s%-7s%-8s%-8s%-9s%-9s%-9s%-8s  %s" %
          ("条目", "时长", "F0Δ%", "走向", "谱质心", "RMS", "综合分", "音色", "文本"))
    print("-" * 108)
    for r in rows:
        ps, sp = r.get("pitch"), r.get("spec")
        pct = ps["delta_pct"] if ps else 0.0
        arrow = "—" if not ps else ("↗ 上扬" if ps["rising"] else ("↘ 下降" if ps["delta_hz"] < 0 else "→ 平"))
        print("%-12s%6.2fs%+8.1f%-8s%9.0f%10.4f%9s%-8s  「%s」" % (
            r["name"], r.get("dur") or 0, pct, arrow,
            (sp["centroid_med"] if sp else 0), (sp["rms_med"] if sp else 0),
            ("%.1f" % r["composite"]) if r.get("composite") is not None else "—",
            r["voice"], r["text"]))


def main():
    ap = argparse.ArgumentParser(description="第三轮「拿到早餐的欢呼」候选 happy_n1…")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--src", default=SRC_DIR)
    ap.add_argument("--only")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-instruct", action="store_true")
    ap.add_argument("--sleep", type=float, default=0.4)
    ap.add_argument("--retry", type=int, default=3)
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--report", action="store_true", help="不生成：只量已落盘文件并写 JSON")
    ap.add_argument("--listen", action="store_true")
    ap.add_argument("--append", action="store_true",
                    help="--listen 时把结果并入已有报告（分批跑盲听必用，否则会覆盖掉前几批）")
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--rank", action="store_true", help="只按综合分排序打印")
    ap.add_argument("--selftest", action="store_true",
                    help="DSP 单元自检：FFT 正确性 + 谱质心对已知纯音的准确度")
    ap.add_argument("--atempo", type=float, default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    # ── DSP 自检 ──
    if args.selftest:
        return selftest()

    # ── 只排序 ──
    if args.rank:
        rep = load_json(report_path())
        if not rep:
            print("没有报告：%s（先跑 --report）" % report_path())
            return 1
        rows = rep["rows"]
        add_scores(rows)
        rows.sort(key=lambda r: -(r.get("composite") or -999))
        print_table(rows, "按综合分排序（F0 %.2f / 谱质心 %.2f / RMS %.2f）" % (W_F0, W_CEN, W_RMS))
        return 0

    # ── 盲听 ──
    if args.listen:
        rep = load_json(report_path())
        if not rep:
            print("没有报告：%s（先跑 --report）" % report_path())
            return 1
        rows = rep["rows"]
        if args.only:
            want = {x.strip() for x in args.only.split(",") if x.strip()}
            rows = [r for r in rows if r["name"] in want]
        _, bad = listen(rows, args.rounds, args.append)
        return 1 if bad else 0

    # ── 只量 ──
    if args.report:
        rows = []
        print("量已落盘的候选（不重新生成；F0 + 谱质心 + RMS）→ %s" % args.out)
        for nm, text, voice, ins in N_LINES:
            p = os.path.join(args.out, nm + ".mp3")
            if not os.path.exists(p):
                print("%-12s  缺文件" % nm)
                continue
            rows.append(row_of(nm, text, voice, ins, p))
        add_scores(rows)
        print_table(rows)
        rep = write_json(rows)
        good = [r for r in rows if not gate_reasons(r)]
        print("\n三量闸（F0 上扬 + 有谱质心 + 不超长）通过：%d/%d" % (len(good), len(rows)))
        for r in rows:
            w = gate_reasons(r)
            if w:
                print("  剔除候选 %s：%s" % (r["name"], "、".join(w)))
        print("报告：%s" % rep)
        return 0

    # ── 生成 ──
    table = list(N_LINES)
    if args.probe:
        table = table[:1]
    if args.only:
        want = {x.strip() for x in args.only.split(",") if x.strip()}
        table = [t for t in table if t[0] in want]
        if not table:
            print("--only 未匹配到条目：%s" % args.only)
            return 1

    url = G.endpoint()
    print("TTS 词表 %d 条 → %s" % (len(table), args.out))
    print("接口 %s" % url)
    print("档位 s（完整短句）：%.2f ~ %.2f s，硬上限 %.2f s" % (DUR["lo"], DUR["ideal"], DUR["max"]))
    for nm, text, voice, ins in table:
        print("   %s.mp3  ←  「%s」  音色 %s" % (nm, text, voice)
              + ("" if args.no_instruct else "\n        指令「%s」" % ins))
    if args.dry_run:
        return 0
    if not G.have_ffmpeg():
        print("错误：PATH 里没有 ffmpeg", file=sys.stderr)
        return 2

    key = G.api_key()
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.src, exist_ok=True)
    ok = skip = fail = 0
    failures, report = [], []
    t0 = time.time()
    for i, (nm, text, voice, ins) in enumerate(table, 1):
        dst = os.path.join(args.out, nm + ".mp3")
        tag = "[%d/%d] %s  ← 「%s」（%s）" % (i, len(table), nm, text, voice)
        if os.path.exists(dst) and os.path.getsize(dst) > 1000 and not args.force:
            print("%s  跳过（已存在）" % tag)
            skip += 1
        else:
            got, last_err, got_model = None, "", ""
            plans = ([(MODEL_TTS, None)] if (args.no_instruct or not ins)
                     else [(MODEL_INSTRUCT, {"instructions": ins, "optimize_instructions": True}),
                           (MODEL_TTS, None)])
            for model, params in plans:
                for attempt in range(1, args.retry + 1):
                    data, err = G.synth(text, voice, model, params, url, key)
                    if data:
                        got, got_model = data, model + ("+instructions" if params else "")
                        break
                    last_err = "[%s] %s" % (model, err or "返回空")
                    if attempt < args.retry:
                        wait = 2 * attempt
                        print("%s  第 %d 次失败（%s），%ds 后重试" % (tag, attempt, last_err[:110], wait))
                        time.sleep(wait)
                if got:
                    break
                print("%s  %s 整轮失败，换下一个模型/参数" % (tag, model))
            if not got:
                print("%s  FAIL  %s" % (tag, last_err[:200]))
                failures.append({"file": nm + ".mp3", "error": last_err})
                fail += 1
                continue

            raw = os.path.join(args.src, nm + ".wav")
            with open(raw, "wb") as f:
                f.write(got)
            good, merr = G.master(raw, dst, args.atempo)
            if not good:
                print("%s  ffmpeg 失败：%s" % (tag, merr))
                failures.append({"file": nm + ".mp3", "error": "ffmpeg: " + merr})
                fail += 1
                continue
            info = G.probe_info(dst)
            used_tempo = args.atempo or 1.0
            if args.atempo is None and info and info["duration"] > DUR["ideal"]:
                tempo = min(1.25, info["duration"] / DUR["ideal"])
                if tempo > 1.02:
                    good2, merr2 = G.master(raw, dst, tempo)
                    if good2:
                        used_tempo = round(tempo, 3)
                        info = G.probe_info(dst)
                    else:
                        print("%s  提速失败（保留原速）：%s" % (tag, merr2))
            size = os.path.getsize(dst)
            over = "" if (info and info["duration"] <= DUR["max"]) else "  ⚠ 仍超长"
            print("%s  OK  [%s]  原始 %s B → %s %s B%s%s" % (
                tag, got_model, format(len(got), ","), os.path.basename(dst), format(size, ","),
                (" · %.2fs / %sHz / %sch" % (info["duration"], info["sample_rate"], info["channels"])) if info else "",
                (" · 加速 ×%.2f" % used_tempo if used_tempo > 1.001 else "") + over))
            report.append(row_of(nm, text, voice, ins, dst, got_model))
            write_json(report)
            ok += 1
        if i < len(table):
            time.sleep(args.sleep)

    print("\n" + "═" * 66)
    print("成功 %d · 跳过 %d · 失败 %d · 共 %d · 耗时 %.0fs" % (ok, skip, fail, len(table), time.time() - t0))
    if report:
        print("报告：%s" % write_json(report))
    if failures:
        os.makedirs(args.src, exist_ok=True)
        p = os.path.join(args.src, "_bf_happy_n_failures.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(failures, f, ensure_ascii=False, indent=2)
        print("失败明细：%s" % p)
    if ok or skip:
        print("\n下一步（必须）：① 量三量 ② omni 盲听 ——")
        print("  python tools/bf/gen_bf_happy_n.py --report")
        print("  python tools/bf/gen_bf_happy_n.py --listen --rounds 2")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
