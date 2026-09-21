# 待办：把 `audio/bf/_unused/` 归档件补进仓库

> **给做过 bf-12 仓库清理的同学。** 这条待办必须在**那台有归档文件的机器**上做。

## 现象

换一台机器 clone 后，`tests/breakfast.test.cjs` **必然失败**（本地实测 81 通过 / 1 失败）：

```
✖ failing tests:
AssertionError [ERR_ASSERTION]: 对照件 happy_alt1.mp3 还在盘上
（bf-12 起归档在 _unused/，试听页要用）
```

## 原因（两层，第二层是根因）

**第一层**：`tests/breakfast.test.cjs` 的「归档区验证」有 **7 处断言**依赖
`audio/bf/_unused/`：

| 行 | 断言 |
|---|---|
| 2642 | `const ARCH = path.join(dir, "_unused")` |
| 2669 | 对照件 `happy_alt1/4/5/6.mp3` 还在盘上 |
| 2690 | `happy_v2.mp3` 仍留在盘上 |
| 2699 | 从 `happy_n56.mp3` 量规格 |
| 2725 | 归档目录存在 |
| 2727 | 归档件 **≥70 个** |
| 2728+ | 逐个核对归档件规格 |

**第二层（根因）**：那 78 个文件**从未提交进库**。测试注释里其实写明了这一点
（「下划线前缀目录被 .gitignore 排除 → 不入库、不分发」），
所以它们只存在于做过清理的那台机器上 ——
**作者本机测试通过，别人 clone 后必失败**。这类「只在别人机器上出现」的故障最费时间。

那条 gitignore 规则是个 **`audio/**/_*` 通配**，本意只是拦生成脚本的草稿日志
（如 `audio/mj/seat1/_failures.json`），却把 `_unused/` 这个**正式归档目录**一起挡了。

## 已修（不需要你再处理）

`.gitignore` 的通配已收窄为逐条精确规则，并附了「反面清单」与
「新增规则前先问：这个路径会不会被测试或代码引用？」。

**验证过：现在直接 `git add` 即可，不需要 `-f`。**

## 你要做的（在那台机器上）

```powershell
# 1. 抽查：确认文件还在、且不再被忽略
python tools\audio\restore_bf_archive.py

# 2. 提交（脚本会先复检忽略规则、再跑早餐店测试确认修好）
python tools\audio\restore_bf_archive.py --commit

# 3. 推送
git push origin main
```

脚本做四件事：确认目录存在且 ≥70 个 mp3 · 逐文件核对没被忽略规则挡住 ·
提交 · 跑测试确认真的修好。**在没那份文件的机器上跑，它会明确告诉你「你不在有那份归档的机器上」**，
不会假装成功。

## 如果那台机器上的文件已经没了

那就别硬撑 —— 改测试是对的：把「盘上检查」降级为「`_unused/` 存在才验，否则显式跳过并标注原因」。
但**优先选补文件**：归档件是试听页的对照素材（B 组），删掉会丢掉「为什么当初没选它」的证据。

## 顺带更新清单

文件入库后跑一次，把新素材纳入契约：

```powershell
powershell -File .\pack-media.ps1     # 媒体清单.json 会变成 ~468 个文件
powershell -File .\link-media.ps1     # 应 全通过
```

> 分发包（`dist\素材分发\media-*.zip`）**只含 `video/`**，所以归档件不会进 zip ——
> 它们随仓库走，和其余自产音频一样。
