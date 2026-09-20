#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_bf_tts.py — 用**阿里云百炼 Qwen-TTS** 生成早餐店小游戏的顾客语音

与麻将那条链的关系（**互不干扰**，本轮并行改造）：
  · tools/audio/gen_mj_bailian_tts.py → 麻将报牌语音（43 条 · voice=Cherry）
  · 本脚本                            → 早餐店顾客语音（呜呼 / 哼，太慢了）
  两者共用同一套「百炼原生 multimodal-generation + 下载临时 URL + 落盘」的做法，
  但**产物目录、词表、参数完全独立**：audio/bf/ 只归本脚本。

要生成的素材（放 audio/bf/）：
  happy.mp3   「呜呼～」      拿到早餐时的高兴喊声（主用件）
  happy2.mp3  「呜呼～」      变体（另一个音色）—— 避免同一句听腻
  happy3.mp3  「呜呼！」      变体（第三个音色 / 语气更冲）
  slow.mp3    「哼，太慢了」  等太久走掉的顾客（不满）

⚠ 四个必须知道的坑（与 gen_mj_bailian_tts.py 同源，实测踩过）：
  1. 密钥**只从环境变量取**，绝不写进代码 / 报告 / 任务表：
         $env:DASHSCOPE_API_KEY  = "sk-..."
         $env:DASHSCOPE_BASE_URL = "https://{业务空间}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
     （业务空间专属域名与 key 必须同地域；公网 dashscope.aliyuncs.com 对 workspace key 一律 401。）
  2. 兼容模式**没有 /audio/speech**（实测 404），Qwen-TTS 必须走 DashScope 原生：
         POST {host}/api/v1/services/aigc/multimodal-generation/generation
         {"model":"qwen3-tts-flash","input":{"text":"呜呼～","voice":"Cherry"}}
     返回的是**带签名的临时 URL**（.wav），必须自己下载落盘。
  3. 下回来的东西扩展名是 .wav、内容是 24kHz PCM WAV；直接当 mp3 用会解码失败。
     所以生成后**必须**过一遍加工（见 --post）：
         python tools/audio/process_sfx.py --src DIR --out audio/bf --preset word --force
     它统一成 48kHz / 128kbps / 单声道 mp3，与 audio/ 其它素材规格一致。
     （本机 hermes venv 的 python 没有 numpy、也装不了，process_sfx.py 需要 numpy →
       换 `D:\\anaconda\\python.exe` 跑；脚本里只提示，不代跑。）
  4. 「～」不是所有音色都念得出来。**每一条都要过 omni 盲听**（verify_bf_omni.py），
     念错就重生成 —— 用户明确要求「念对」。

用法：
    $env:DASHSCOPE_API_KEY  = "sk-..."
    $env:DASHSCOPE_BASE_URL = "https://xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    python tools/audio/gen_bf_tts.py --out "$env:USERPROFILE\\Desktop\\audio-工作区\\_bf_src"
    python tools/audio/gen_bf_tts.py --out DIR --only happy,slow --force
    python tools/audio/gen_bf_tts.py --out DIR --dry-run
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
except Exception:      # 允许单独拷出去跑
    PA = None

# Windows 控制台默认 GBK：中文标题会乱码，个别符号还会 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

MODEL_TTS = "qwen3-tts-flash"
MODEL_INSTRUCT = "qwen3-tts-instruct-flash"

# ── 词表：(文件基名, 念法, 音色, 语音指令) ────────────────────────────────
# 指令走 qwen3-tts-instruct-flash（optimize_instructions=true）；
# 某条指令模型不认 / 报错时会自动退回 qwen3-tts-flash 重试一次（见 synth 循环）。
LINES = [
    ("happy",  "呜呼～",    "Cherry",
     "顾客拿到刚做好的热早餐，开心地欢呼一声，语气兴奋、轻快、上扬，很短"),
    ("happy2", "呜呼～",    "Ethan",
     "年轻男生拿到早餐，高兴地喊了一声，自然、有活力、不夸张"),
    ("happy3", "呜呼！",    "Jennifer",
     "女生拿到早餐，惊喜地喊了一声，活泼、明亮、短促"),
    ("slow",   "哼，太慢了", "Cherry",
     "先用鼻腔不满地哼一声「哼」，稍微拖长，再说「太慢了」，语气冷淡、不耐烦"),
]

# ⚠ 定稿用的**加工预设不是同一条**（实测，别照抄麻将那条命令）：
#   happy / happy2 / happy3  → `--preset word`
#       「呜呼～」是单音节语气词、内部没有停顿，word 预设（gap_tol=0.15）正好精确掐头去尾。
#   slow                     → `--preset voice`
#       实测：用 word 预设加工「哼，太慢了」，句首那个短促的「哼」会被当成
#       「比 gap_tol 更长的停顿之前的一段」整段丢掉 —— 原始件 1.68s 被剪到 0.99s，
#       omni 盲听两遍都只听到「太慢了」（4 条候选件里 3 条这样）。
#       换 voice 预设（keep_all=True、gap_tol=0.80）后同样是 48kHz/128kbps，
#       三条候选稳过、盲听原文是「哼，太慢了。」。所以这一条必须用 voice。
#   复现命令：
#     python tools/audio/process_sfx.py --src DIR --out audio/bf --preset word  --only happy,happy2,happy3 --force
#     python tools/audio/process_sfx.py --src DIR --out audio/bf --preset voice --only slow --force

# 盲听验收的期望念法（verify_bf_omni.py 也读这份表，避免两处各写一遍）
EXPECT = {name: text for name, text, _v, _i in LINES}

# ── 「哼，太慢了」的候选件（--candidates）─────────────────────────────────
# 为什么需要：Cherry 音色把「哼」念成了鼻腔轻哼（hng），
# omni 盲听两遍都听成「嗯，太慢了」——即"哼"没被听出来。
# 按用户要求「念错就重生成」，这里一次多生几条（换音色 / 换标点 / 换指令），
# 盲听挑出真正听得出「哼」的那条，再定稿成 audio/bf/slow.mp3。
SLOW_CANDIDATES = [
    ("slow_a", "哼，太慢了", "Cherry",
     "先用鼻腔不满地哼一声「哼」，稍微拖长，再说「太慢了」，语气冷淡、不耐烦"),
    ("slow_b", "哼！太慢了！", "Ethan",
     "男生不耐烦地重重哼一声，然后抱怨「太慢了」，语气冷淡、带点不耐烦"),
    ("slow_c", "哼，太慢了", "Cherry", None),
    ("slow_d", "哼。太慢了。", "Ethan",
     "顾客等了很久，很不高兴，先冷哼一声再说「太慢了」"),
]


def api_key():
    k = (os.environ.get("DASHSCOPE_API_KEY") or "").strip()
    if not k:
        print("错误：请先设置 DASHSCOPE_API_KEY（百炼控制台 → API-KEY 管理）", file=sys.stderr)
        sys.exit(2)
    return k


def endpoint():
    """从 DASHSCOPE_BASE_URL 推出 DashScope 原生接口地址（与 gen_mj_bailian_tts.py 同规则）。"""
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
    ap = argparse.ArgumentParser(description="用百炼 Qwen-TTS 生成早餐店顾客语音")
    ap.add_argument("--out", required=True,
                    help="输出目录（原始件；建议放工作区，之后过 process_sfx.py）")
    ap.add_argument("--only", help="只做指定条目（逗号分隔：happy,happy2,happy3,slow）")
    ap.add_argument("--candidates", action="store_true",
                    help="生成「哼，太慢了」的候选件 slow_a..slow_d（盲听挑选用）")
    ap.add_argument("--force", action="store_true", help="覆盖已存在文件（默认跳过）")
    ap.add_argument("--no-instruct", action="store_true",
                    help="全部用 qwen3-tts-flash（不带语音指令）")
    ap.add_argument("--sleep", type=float, default=0.6, help="每条之间的间隔秒数")
    ap.add_argument("--retry", type=int, default=3, help="单条重试次数")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    table = list(SLOW_CANDIDATES if args.candidates else LINES)
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

    key = api_key()
    os.makedirs(args.out, exist_ok=True)
    ok = skip = fail = 0
    failures = []
    for i, (name, text, voice, ins) in enumerate(table, 1):
        # ⚠ 原始件**故意**存成 .mp3（内容其实是 24kHz PCM WAV，百炼返回的直链就是 .wav）。
        #   原因：process_sfx.py 只扫 --src 下的 *.mp3，命名统一成 .mp3 才能一条命令过完整条链；
        #   ffmpeg 按内容嗅探，扩展名不影响解码。这与 gen_mj_bailian_tts.py 的做法一致（坑 3）。
        dest = os.path.join(args.out, name + ".mp3")
        dest_wav = os.path.join(args.out, name + ".wav")
        tag = f"[{i}/{len(table)}] {name}  ← 「{text}」（{voice}）"
        if (os.path.exists(dest) and os.path.getsize(dest) > 1000) or \
           (os.path.exists(dest_wav) and os.path.getsize(dest_wav) > 1000):
            if not args.force:
                print(f"{tag}  跳过（已存在）")
                skip += 1
                continue
        got, last_err = None, ""
        # 先用 instruct 模型（带指令）；失败则退回普通 flash 再来一轮 —— 指令被拒时仍有素材。
        # 词表里指令为 None 的条目（例如 slow_c 基线）直接走普通 flash，不发 instructions。
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
                    break
                last_err = f"[{model}] {err or '返回空'}"
                if attempt < args.retry:
                    wait = 2 * attempt
                    print(f"{tag}  第 {attempt} 次失败（{last_err[:110]}），{wait}s 后重试")
                    time.sleep(wait)
            if got:
                break
            print(f"{tag}  {model} 整轮失败，换下一个模型/参数重试")
        if got:
            with open(dest, "wb") as f:
                f.write(got)
            print(f"{tag}  OK  {len(got):,} B → {os.path.basename(dest)}")
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
        rep = os.path.join(args.out, "_bf_failures.json")
        with open(rep, "w", encoding="utf-8") as f:
            json.dump(failures, f, ensure_ascii=False, indent=2)
        print(f"失败明细：{rep}")
    if ok or skip:
        print("\n下一步（必须）：过加工预设，转成 48kHz/128kbps mp3 ——")
        print(f'  python tools/audio/process_sfx.py --src "{args.out}" '
              f'--out "audio/bf" --preset word --force')
        print("（本机 hermes venv 无 numpy：用 D:\\anaconda\\python.exe 跑上面这条）")
        print("\n然后必须盲听验收：")
        print("  python tools/audio/verify_bf_omni.py --dir audio/bf --rounds 2")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
