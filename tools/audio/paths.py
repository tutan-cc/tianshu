#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
paths.py — 音频工具链的路径解析（唯一来源）

为什么单独抽一个模块：
  这些脚本原先散在仓库外，路径全是硬编码的 `H:\\GAMEDEV\\...` ——
  换台机器、换个目录就全跑不了。协作者拿到仓库后应该能直接跑，
  所以路径统一在这里解析，规则是「**环境变量优先，否则按仓库位置推导**」。

推导规则（都用 tools/audio/paths.py 自身位置反推）：
    REPO_ROOT   = <仓库根>                    …… tools/audio/ 往上两级
    MEDIA_ROOT  = <仓库根>上级/Tianshu-Prototype-媒体素材
                  （与 pack-media.ps1 / link-media.ps1 的候选逻辑一致：
                    媒体库放在仓库**同级**目录，名字优先用这个）
    WORK_ROOT   = <仓库根>上级/audio-工作区     …… 原始件与中间产物（不入库、不分发）
    MODEL_ROOT  = <仓库根>上级/models           …… 本地 ASR 模型

可用环境变量覆盖（跨机器 / CI 用）：
    DSH_REPO_ROOT · DSH_MEDIA_ROOT · DSH_WORK_ROOT · DSH_MODEL_ROOT
    STEP_API_KEY                                …… StepAudio 的 key（不在代码里硬编码）

依赖：**只用标准库**，不 import 本项目别的模块，避免循环依赖。
"""

import os

HERE = os.path.dirname(os.path.abspath(__file__))
# tools/audio/ -> tools/ -> <仓库根>
_REPO_GUESS = os.path.dirname(os.path.dirname(HERE))


def _first_dir(*cands):
    """返回第一个存在的目录；都不存在时返回第一个候选（便于报错时显示期望位置）。"""
    for c in cands:
        if c and os.path.isdir(c):
            return os.path.abspath(c)
    return os.path.abspath(cands[0]) if cands else ""


REPO_ROOT = os.path.abspath(os.environ.get("DSH_REPO_ROOT") or _REPO_GUESS)
_PARENT = os.path.dirname(REPO_ROOT)

MEDIA_ROOT = _first_dir(
    os.environ.get("DSH_MEDIA_ROOT") or "",
    os.path.join(_PARENT, "Tianshu-Prototype-媒体素材"),
)
WORK_ROOT = _first_dir(
    os.environ.get("DSH_WORK_ROOT") or "",
    os.path.join(_PARENT, "audio-工作区"),
)
MODEL_ROOT = _first_dir(
    os.environ.get("DSH_MODEL_ROOT") or "",
    os.path.join(_PARENT, "models"),
)

# ── 常用子目录（方便各脚本直接引用，不必自己拼）─────────────────────
#
# ⚠⚠ 成品音频的**唯一权威在仓库里**（<仓库根>/audio/），不在媒体库。
#   因为 audio/ 是自产素材、已随仓库入库（305 个文件）。
#   若让工具去媒体库读写，就会出现两份副本 —— 工具验收一份、git 提交另一份，
#   迟早分叉。所以成品路径一律指向仓库。
#
#   媒体库（MEDIA_ROOT）现在只用于：
#     · 第三方实拍视频（video/，授权未核实，不入库）—— pack-media.ps1 从这里取
#     · 历史遗留的 audio/ 副本（旧布局留下的，可忽略；以仓库那份为准）
#
#   加工中转与原始件仍走 WORK_ROOT（仓库外，不入库、不分发）。
AUDIO = os.path.join(REPO_ROOT, "audio")
DIR_SFX = os.path.join(AUDIO, "sfx")
DIR_AMB = os.path.join(AUDIO, "amb")
DIR_BGM = os.path.join(AUDIO, "bgm")
DIR_MJ = os.path.join(AUDIO, "mj")
DIR_VO = os.path.join(AUDIO, "vo_real")

# 媒体库里的视频（第三方，不入库）
DIR_VIDEO_LIB = os.path.join(MEDIA_ROOT, "video")

# 原始件（生成直出，未加工）：不入库、不分发，放工作区
SRC_SFX = os.path.join(WORK_ROOT, "_sfx_src")
SRC_AMB = os.path.join(WORK_ROOT, "_amb_src")
SRC_BGM = os.path.join(WORK_ROOT, "_bgm_src")
SRC_MJ0 = os.path.join(WORK_ROOT, "_原始件备份", "_mj0_src")
SRC_VO = os.path.join(WORK_ROOT, "vo_real")

# 台词任务表（54 条的真源）
VO_JOBS = os.path.join(WORK_ROOT, "vo_jobs.json")

# 本地 ASR 模型（sherpa-onnx + SenseVoice）
ASR_MODEL = os.path.join(MODEL_ROOT, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17")

# StepAudio 端点与模型（Gen 与 TTS 是两个端点，别混）
GEN_URL = "https://api.stepfun.com/v1/audio/generate"
TTS_URL = "https://api.stepfun.com/v1/audio/speech"
GEN_MODEL = "stepaudio-3-gen-preview"
TTS_MODEL = "stepaudio-3-tts"


def api_key():
    """STEP_API_KEY：只从环境变量取，**绝不写进代码**。"""
    return (os.environ.get("STEP_API_KEY") or "").strip()


def report():
    """打印当前解析结果，排查路径问题时先看这个。"""
    lines = [
        ("仓库根", REPO_ROOT),
        ("媒体库", MEDIA_ROOT),
        ("工作区", WORK_ROOT),
        ("模型目录", MODEL_ROOT),
        ("ASR 模型", ASR_MODEL),
        ("台词任务表", VO_JOBS),
        ("STEP_API_KEY", "已设置" if api_key() else "**未设置**（生成类脚本会退出）"),
    ]
    w = max(len(k) for k, _ in lines)
    for k, v in lines:
        print(f"  {k:<{w}}  {v}")
        if v and not os.path.exists(v) and not str(v).startswith(("已", "**")):
            print(f"  {'':<{w}}    ⚠ 不存在")


if __name__ == "__main__":
    print("音频工具链路径解析：")
    report()
