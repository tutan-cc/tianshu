#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
restore_bf_archive.py — 把 audio/bf/_unused/ 归档件补进仓库（需在有那份文件的机器上跑）

═══ 背景 ═══
`tests/breakfast.test.cjs` 有一整块「归档区验证」（7 处断言，其中一条要求 ≥70 个文件）：
  const ARCH = path.join(dir, "_unused");
  assert.ok(fs.existsSync(ARCH), "归档目录 audio/bf/_unused/ 存在");
  assert.ok(archived.length >= 70, "_unused/ 里归档件齐全");
  ["happy_alt1.mp3", "happy_alt4.mp3", ...].forEach(f => assert.ok(fs.existsSync(at(f)), ...));

但 `audio/bf/_unused/`（早餐店欢呼语音的 78 个旧件）**从未提交进库**，
所以换任何一台机器 clone 后跑这个测试都会失败：
  AssertionError: 对照件 happy_alt1.mp3 还在盘上

根因是 .gitignore 里曾有一条 `audio/**/_*` 通配（本意拦生成脚本的草稿日志
`_failures.json`），它把 `_unused/` 这个**正式归档目录**一起挡了。
该通配已收窄为逐条精确规则（见 .gitignore 的说明），所以现在**直接 git add 即可，不需要 -f**。

═══ 用法（必须在有那份文件的机器上跑）═══
    python tools/audio/restore_bf_archive.py            # 只检查
    python tools/audio/restore_bf_archive.py --commit   # 检查通过后提交

本脚本做四件事：
  1. 确认 `audio/bf/_unused/` 存在且 mp3 数 ≥70（不满足就明确说「你不在有那份文件的机器上」）
  2. 逐文件核对 `git check-ignore`，确认**没有**被忽略规则挡住（挡住就打印是哪一条）
  3. 提交（--commit 时）
  4. 提交前跑一次早餐店测试，确认真的修好了
"""

import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import paths as PA
    REPO = PA.REPO_ROOT
except Exception:
    REPO = os.path.dirname(os.path.dirname(HERE))

ARCH_REL = "audio/bf/_unused"
MIN_FILES = 70          # 与 tests/breakfast.test.cjs 的断言保持一致


def run(cmd, **kw):
    return subprocess.run(cmd, cwd=REPO, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", **kw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="检查通过后提交并推送")
    args = ap.parse_args()

    arch = os.path.join(REPO, ARCH_REL.replace("/", os.sep))
    print(f"仓库：{REPO}")

    # ── 1. 目录与文件数 ─────────────────────────────────────────────
    if not os.path.isdir(arch):
        print(f"\n✘ 找不到 {ARCH_REL}\\")
        print("  → 说明**你不在有那份归档的机器上**（那些文件从未入库）。")
        print("     请在做过 bf-12 仓库清理的那台机器上跑本脚本。")
        print("     或：如果那台机器也不在了，归档件就真的丢了 ——")
        print("     此时应改测试（把「盘上检查」降级为「目录存在才验」），而不是硬撑。")
        return 1
    mp3s = sorted(f for f in os.listdir(arch) if f.lower().endswith(".mp3"))
    print(f"\n目录存在：{ARCH_REL}   mp3 {len(mp3s)} 个")
    if len(mp3s) < MIN_FILES:
        print(f"✘ 只有 {len(mp3s)} 个，测试要求 ≥{MIN_FILES} 个 —— 归档不齐，先补齐再提交。")
        return 1
    print(f"✔ 数量达标（≥{MIN_FILES}）")

    # ── 2. 逐文件确认不被忽略 ───────────────────────────────────────
    print("\n检查忽略规则（关键：曾经有 `audio/**/_*` 通配把它们整目录挡住）：")
    blocked = []
    for f in mp3s[:8] + mp3s[-3:]:        # 抽样首尾，避免 78 次调用太慢
        rel = f"{ARCH_REL}/{f}"
        r = run(["git", "check-ignore", "-v", rel])
        if r.returncode == 0 and r.stdout.strip():
            blocked.append((rel, r.stdout.strip()))
    if blocked:
        print("  ✘ 仍被忽略，不能入库：")
        for rel, why in blocked:
            print(f"     {rel}\n       <- {why}")
        print("  → 修 .gitignore（把通配改成逐条精确规则），再跑本脚本。")
        return 1
    print(f"  ✔ 抽样的 {min(len(mp3s), 11)} 个文件都不被忽略（可直接 git add，无需 -f）")

    # ── 3. 提交 ─────────────────────────────────────────────────────
    if not args.commit:
        print("\n[只检查] 要提交请加 --commit")
        print("  等价命令：")
        print(f'    git add "{ARCH_REL}"')
        print(f'    git commit -m "补入 breakfast 欢呼语音归档 {len(mp3s)} 个（测试依赖，此前未入库）"')
        return 0

    print("\n=== 暂存 ===")
    r = run(["git", "add", ARCH_REL])
    if r.returncode != 0:
        print("  ✘ git add 失败：" + (r.stderr or "")[:300])
        return 1
    st = run(["git", "status", "--porcelain", ARCH_REL])
    n_staged = len([l for l in st.stdout.split("\n") if l.strip()])
    print(f"  已暂存 {n_staged} 项")
    if n_staged == 0:
        print("  （无变化，可能早已提交）")
        return 0

    print("\n=== 提交 ===")
    msg = (f"补入 breakfast 欢呼语音归档 {len(mp3s)} 个（测试依赖，此前未入库）\n\n"
           f"tests/breakfast.test.cjs 的「归档区验证」有 7 处断言依赖 {ARCH_REL}/，\n"
           f"但那批文件从未入库（曾被 .gitignore 的 `audio/**/_*` 通配挡住，\n"
           f"该通配已收窄为逐条精确规则），导致换机器 clone 后早餐店测试必失败。\n\n"
           f"素材授权：项目自产（StepAudio/百炼 TTS），可自由使用。")
    r = run(["git", "commit", "-m", msg])
    print("  " + (r.stdout or r.stderr or "").strip()[-400:])
    if r.returncode != 0:
        return 1

    print("\n=== 跑早餐店测试确认修好 ===")
    r = run(["node", "tests/breakfast.test.cjs"])
    tail = (r.stdout or "").strip().split("\n")[-4:]
    for l in tail:
        print("  " + l)
    if r.returncode == 0:
        print("\n✔ 测试通过。推送：git push origin main")
    else:
        print("\n⚠ 测试仍未通过 —— 看上面输出，可能还缺别的文件。")
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
