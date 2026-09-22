#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
lovart_gen.py —— 通过 Lovart skill 生成 puncher 立绘。

为什么要这个包装：PowerShell 会把 `--prefer-models '{"IMAGE":[...]}'` 的引号吃掉，
导致 skill 的 json.loads 报 "Expecting property name enclosed in double quotes"。
把参数放进 Python 列表再 subprocess 调用，就完全不经过 shell 的引号解析。

用法：
    python tools/dev/lovart_gen.py --prompt-file tools/dev/_p.json --out _ref/out
    （请先把 skill 的 AK/SK 从注册表读进环境变量）
"""
import argparse
import json
import os
import subprocess
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt-file", required=True, help="含 prompt / attachments / models 的 JSON")
    ap.add_argument("--out", default="_ref/out")
    ap.add_argument("--thread-id", default="")
    args = ap.parse_args()

    with open(args.prompt_file, "r", encoding="utf-8") as f:
        spec = json.load(f)

    skill = os.path.join(os.environ["DSH_HOME"], "skills", "lovart", "scripts", "agent_skill.py")
    cmd = [sys.executable, skill, "chat", "--prompt", spec["prompt"],
           "--json", "--download", "--output-dir", args.out]
    if spec.get("models"):
        cmd += ["--prefer-models", json.dumps(spec["models"])]
    for url in spec.get("attachments", []):
        cmd += ["--attachments", url]
    if spec.get("include_tools"):
        cmd += ["--include-tools"] + spec["include_tools"]
    if args.thread_id:
        cmd += ["--thread-id", args.thread_id]

    print("[cmd] agent_skill.py chat  (prompt %d 字, attachments %d 个, models %s)"
          % (len(spec["prompt"]), len(spec.get("attachments", [])), spec.get("models")))
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = p.stdout or ""
    try:
        data = json.loads(out)
    except Exception:
        print("---- 原始输出（无法解析为 JSON）----")
        print(out[-4000:])
        print("---- stderr ----")
        print((p.stderr or "")[-2000:])
        return 1
    # 精简摘要，避免把整个 items 打出来
    print(json.dumps({
        "final_status": data.get("final_status"),
        "generation_succeeded": data.get("generation_succeeded"),
        "thread_id": data.get("thread_id"),
        "project_id": data.get("project_id"),
        "artifacts": [a.get("content") for it in data.get("items", [])
                      if it.get("type") == "generator"
                      for a in (it.get("artifacts") or [])],
        "downloaded": [d.get("local_path") for d in (data.get("downloaded") or [])],
        "failures": data.get("failures"),
        "warning": data.get("warning"),
        "agent_message": (data.get("agent_message") or "")[:500],
    }, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
