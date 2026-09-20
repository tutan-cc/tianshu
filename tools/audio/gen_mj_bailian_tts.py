#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_mj_bailian_tts.py — 用**阿里云百炼（Model Studio）Qwen-TTS** 重做麻将报牌语音

与 gen_mj_by_seat_tts.py 的分工：
  · gen_mj_by_seat_tts.py → 走 StepAudio（STEP_API_KEY），产的是**按座位分音色**的整套牌名
  · 本脚本               → 走百炼 Qwen-TTS（DASHSCOPE_API_KEY），产的是**统一音色**的一套词
  两者产物文件名一致，互相覆盖；谁跑最后谁说了算。

为什么要重做（用户要求）：
  旧素材是「东/南/西/北/中/发/白」一个字一个文件，牌桌上听起来就是「中」「白」「东」——
  单音节太含糊。新念法：
      中 → 红中 · 白 → 白板 · 东/南/西/北 → 东风/南风/西风/北风 · 發 → 发财
  万/条/筒 不变，仍是「一万…九筒」（**文件名仍是 1万.mp3，文件名与念法本来就是两回事**）。
  本轮追加（用户要求 · 第一人称）：碰 → 「我碰」· 杠 → 「我杠」。
  ⚠ 只改念法，**文件名一个字不动**（玩法侧 voiceFile("碰") 仍解析到 碰.mp3），
     所以调用方、断言、素材清单都不受影响；重生成后四个目录的条目数仍是 43。

⚠ 三个必须知道的坑：
  1. 密钥**只从环境变量取**，绝不写进代码/任务表/报告：
         $env:DASHSCOPE_API_KEY  = "sk-..."
         $env:DASHSCOPE_BASE_URL = "https://{业务空间}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
     （本项目的百炼业务空间域名与 key 必须同地域，北京 key 打新加坡域名会 401。）
  2. 百炼的 OpenAI 兼容模式**没有 /audio/speech**（实测 404），
     Qwen-TTS 要走 DashScope 原生 `multimodal-generation`：
         POST {host}/api/v1/services/aigc/multimodal-generation/generation
         {"model":"qwen3-tts-flash","input":{"text":"红中","voice":"Cherry"}}
     返回的是**一个带签名的临时 URL**，必须自己下载落盘。
  3. 下回来的东西**扩展名是 .mp3，内容其实是 24kHz PCM WAV**（实测 ffprobe: pcm_s16le）。
     直接当 mp3 用，某些播放器会解码失败。所以本脚本之后**必须**过一遍
     `process_sfx.py --preset word` —— 它顺手转成 48kHz/128kbps 单声道 mp3，
     与 audio/ 里其它素材规格一致。

用法：
    $env:DASHSCOPE_API_KEY = "sk-..."
    $env:DASHSCOPE_BASE_URL = "https://xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    python tools/audio/gen_mj_bailian_tts.py --out "<工作区>/_mj_bailian_src" --voice Cherry
    python tools/audio/gen_mj_bailian_tts.py --out DIR --only 红中,白板 --force
    python tools/audio/gen_mj_bailian_tts.py --out DIR --dry-run
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import paths as PA
except Exception:  # 允许单独拷出去跑
    PA = None

# Windows 控制台默认 GBK：中文标题/表格线会乱码，个别符号还会 UnicodeEncodeError。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

MODEL_TTS = "qwen3-tts-flash"
MODEL_INSTRUCT = "qwen3-tts-instruct-flash"

# ── 词表：(文件名基名, 要念的中文) ────────────────────────────────────
# 文件名沿用玩法侧的写法（"1万" 这种阿拉伯数字），念法用汉字数字。
NUM_CN = {"1": "一", "2": "二", "3": "三", "4": "四", "5": "五",
          "6": "六", "7": "七", "8": "八", "9": "九"}
SUITS = ["万", "条", "筒"]
TILES = [(f"{n}{s}", NUM_CN[n] + s) for n in "123456789" for s in SUITS]

# 字牌：**旧文件名 → 新文件名**，念法就是新文件名去掉 .mp3。
# 用户要求「打中念红中、打白念白板、打东念东风」；「發」念「发财」比单念「发」清楚，
# 且与「红中/白板」同一规矩（字牌一律念全名）。
HONORS = [("东", "东风"), ("南", "南风"), ("西", "西风"), ("北", "北风"),
          ("中", "红中"), ("发", "发财"), ("白", "白板")]

# 动作类：**保留**（用户明确「保留动作类」）。默认念法即文件名，**但碰/杠例外** ——
# 用户追加要求：「碰牌的时候要喊"我碰"；杠牌的时候说"我杠"」（第一人称）。
# 所以这两条的**文件名一个字都不改**（玩法侧 voiceFile("碰") 仍解析到 碰.mp3），
# 只改 TTS 文本：仓库根 audio/mj/ 与 seat1/2/3 四个目录都要按新念法重生成。
CALLS = [("碰", "我碰"), ("杠", "我杠"), ("杠开", "杠开"), ("抢杠", "抢杠"), ("胡", "胡"),
         ("自摸", "自摸"), ("听", "听"), ("过", "过"), ("流局", "流局")]


# 旧名 → 新名（用于 --drop-legacy 清理，以及排查代码里的残留引用）
LEGACY = {old: new for old, new in HONORS if old != new}


def word_table():
    """→ [(文件基名, 念法)]，共 43 条（27 序数牌 + 7 字牌 + 9 动作）。"""
    items = list(TILES)
    items += [(new, new) for _old, new in HONORS]
    items += list(CALLS)                      # 已经是 (文件基名, 念法) 对
    return items


def api_key():
    k = (os.environ.get("DASHSCOPE_API_KEY") or "").strip()
    if not k:
        print("错误：请先设置 DASHSCOPE_API_KEY（百炼控制台 → API-KEY 管理）", file=sys.stderr)
        sys.exit(2)
    return k


def endpoint():
    """从 DASHSCOPE_BASE_URL 推出 DashScope 原生接口地址。

    OpenAI 兼容模式的地址长这样：
        https://{空间}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
    原生接口在同一个 host 上：
        https://{空间}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
    """
    base = (os.environ.get("DASHSCOPE_BASE_URL") or "").strip()
    if not base:
        print("错误：请先设置 DASHSCOPE_BASE_URL（业务空间专属域名，见文件头说明）", file=sys.stderr)
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


def main():
    ap = argparse.ArgumentParser(description="用百炼 Qwen-TTS 生成麻将报牌语音")
    ap.add_argument("--out", required=True, help="输出目录（原始件；建议放工作区，之后过 process_sfx.py）")
    ap.add_argument("--voice", default="Cherry", help="音色（默认 Cherry；见百炼 Qwen-TTS 音色列表）")
    ap.add_argument("--model", default=MODEL_TTS, help=f"模型（默认 {MODEL_TTS}）")
    ap.add_argument("--instruct", help="语音指令（给了就自动切到 qwen3-tts-instruct-flash）")
    ap.add_argument("--only", help="只做指定词（逗号分隔，可用旧名 中/白/东 指代新名）")
    ap.add_argument("--force", action="store_true", help="覆盖已存在文件（默认跳过）")
    ap.add_argument("--sleep", type=float, default=0.6, help="每条之间的间隔秒数")
    ap.add_argument("--retry", type=int, default=3, help="单条重试次数")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    table = word_table()
    if args.only:
        want = {x.strip() for x in args.only.split(",") if x.strip()}
        want |= {LEGACY[w] for w in list(want) if w in LEGACY}      # 旧名也能指到新名
        table = [(f, t) for f, t in table if f in want or t in want]
        if not table:
            print(f"--only 未匹配到条目：{args.only}")
            return 1

    model = MODEL_INSTRUCT if args.instruct else args.model
    params = None
    if args.instruct:
        params = {"instructions": args.instruct, "optimize_instructions": True}

    url = endpoint()
    print(f"TTS 模型 {model} · 音色 {args.voice} · {len(table)} 条 → {args.out}")
    print(f"接口 {url}")
    if params:
        print(f"指令 {params['instructions']}")
    if args.dry_run:
        for f, t in table:
            print(f"   {f}.mp3  ←  「{t}」")
        return 0

    key = api_key()
    os.makedirs(args.out, exist_ok=True)
    ok = skip = fail = 0
    failures = []
    for i, (name, text) in enumerate(table, 1):
        dest = os.path.join(args.out, name + ".mp3")
        tag = f"[{i}/{len(table)}] {name}.mp3  ← 「{text}」"
        if os.path.exists(dest) and not args.force and os.path.getsize(dest) > 1000:
            print(f"{tag}  跳过（已存在 {os.path.getsize(dest):,} B）")
            skip += 1
            continue
        got, last_err = None, ""
        for attempt in range(1, args.retry + 1):
            data, err = synth(text, args.voice, model, params, url, key)
            if data:
                got = data
                break
            last_err = err or "返回空"
            if attempt < args.retry:
                wait = 2 * attempt
                print(f"{tag}  第 {attempt} 次失败（{last_err[:110]}），{wait}s 后重试")
                time.sleep(wait)
        if got:
            with open(dest, "wb") as f:
                f.write(got)
            print(f"{tag}  OK  {len(got):,} B")
            ok += 1
        else:
            print(f"{tag}  FAIL  {last_err[:200]}")
            failures.append({"file": name + ".mp3", "error": last_err})
            fail += 1
        if i < len(table):
            time.sleep(args.sleep)

    print("\n" + "═" * 62)
    print(f"成功 {ok} · 跳过 {skip} · 失败 {fail} · 共 {len(table)}")
    if failures:
        rep = os.path.join(args.out, "_failures.json")
        with open(rep, "w", encoding="utf-8") as f:
            json.dump(failures, f, ensure_ascii=False, indent=2)
        print(f"失败明细：{rep}")
    if ok or skip:
        print("\n下一步（必须）：过加工预设，转成 48kHz/128kbps mp3 ——")
        print(f'  python tools/audio/process_sfx.py --src "{args.out}" '
              f'--out "audio/mj" --preset word --force')
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
