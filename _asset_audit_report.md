# 素材治理语义审计报告（TypeSafe / Jev）

> 生成时间：2026-09-21T09:43:47.654Z · 模型：jev-1.13.0
> 工具：`tools/audit/asset-audit.cjs`（确定性对账在代码，语义判定在 Jev）

## 一、对账事实（代码算出，零推断）

| 项 | 值 |
|---|---|
| 媒体清单条目 | 375 |
| 磁盘 audio 文件 | 408 |
| 清单登记但磁盘缺失 | 28 |
| 磁盘存在但未登记 | 131 |
| art/ png 实际 | 98（SOURCES.md 声称 94） |
| art/ 是否在清单内 | **否** |
| 接线验收盲区 | audio/bf(95)、audio/vo_real(54) |
| git 跟踪 video/ 文件 | 4（第三方素材未泄漏进公开仓库） |
| git 跟踪 audio/ 文件 | 320 |

## 二、Jev 语义判定

### SOURCES.md 的验收声明覆盖不到实际范围

*doc_claim_overreach*

- SOURCES.md 称「接线由 `tools/e2e/audio-wiring.js` 逐个 URL 验可达性」，用于支撑「为什么可以放心入库」。
- 但该脚本的覆盖集不含 audio/bf(95)、audio/vo_real(54)，共 149 个音频文件。
- 同一节还宣称「四层自动验收，1572 项断言全绿」——该数字对未覆盖目录同样不成立。

- **影响** 2.28/3 —— 治理出现盲区：缺失的自动发现手段让问题可能在发布前一直查不出来（置信 70%）
- **归类** `coverage_gap`（置信 87%）
- **阻断发布** 75%
- **建议动作** `add_coverage`（置信 43%）

### SOURCES.md 素材计数过期：声称 94 个 png，实际 98 个

*doc_count_mismatch*

- SOURCES.md 写「`art/**`（94 个 png）」。
- 磁盘实际 png 计数：98。
- 差额 4 个，含 art/fight2/ 打斗精灵图与 art/icons/_zoom_*、_sheet_preview* 等后续新增。

- **影响** 1.08/3 —— 文档或清单与事实不符：会误导后续维护者，但游戏照常运行（置信 87%）
- **归类** `doc_drift`（置信 100%）
- **阻断发布** 10%
- **建议动作** `sync_docs`（置信 69%）

### 第三方素材的授权边界：video/ 被 git 跟踪 4 个文件

*license_boundary*

- SOURCES.md 声明 68 个实拍素材「授权未核实、不入库」，走带外分发。
- git 实际跟踪的 video/ 文件（4 个）：video/fx_flood.mp4、video/fx_market.mp4、video/poster/fx_flood.jpg、video/poster/fx_market.jpg
- 磁盘上 video/ 共 70 个条目，其中未核实的 68 个已被 .gitignore 排除，未进入版本库。
- 对照：audio/ 被跟踪 320 个（自产素材，授权清晰，应当入库）。

- **建议动作** `add_coverage`（置信 23%）
- **边界已正确执行** 88%
- **保障强度** 1.03/2 —— 靠 .gitignore 等静态配置，但没有任何测试会在它被改坏时报警（置信 96%）

### 素材改名未同步清单：7 组 × 4 个目录（共 28 个文件）

*rename_drift*

- 媒体清单.json 登记的是旧短名，磁盘上已是新长名，两边对不上。
- 涉及的目录：audio/mj、audio/mj/seat1、audio/mj/seat2、audio/mj/seat3
- 改名映射（每个目录各一份）：白.mp3 → 白板.mp3、北.mp3 → 北风.mp3、东.mp3 → 东风.mp3、发.mp3 → 发财.mp3、南.mp3 → 南风.mp3、西.mp3 → 西风.mp3、中.mp3 → 红中.mp3
- 后果：清单登记的文件在磁盘上不存在（28 条），磁盘上的实际文件又不在清单里（28 条）—— 同一批文件同时触发两类告警。

- **影响** 1.89/3 —— 治理出现盲区：缺失的自动发现手段让问题可能在发布前一直查不出来（置信 82%）
- **归类** `rename_drift`（置信 100%）
- **阻断发布** 69%
- **建议动作** `update_manifest`（置信 90%）

### art/ 完全不在媒体清单治理范围内

*manifest_scope_gap*

- 媒体清单.json 只含 audio/ 与 video/ 条目，无任何 art/ 条目。
- art/ 有 98 个 png，含 Lovart 生成素材与程序切片产物，目前只靠 SOURCES.md 散文描述治理。
- SOURCES.md 对 art/ 的授权结论是「AI 生成原创，随仓库分发」，但无逐项登记（对比 audio/ 的 305 条逐项 sha256）。

- **影响** 2.21/3 —— 治理出现盲区：缺失的自动发现手段让问题可能在发布前一直查不出来（置信 72%）
- **归类** `coverage_gap`（置信 98%）
- **阻断发布** 50%
- **建议动作** `update_manifest`（置信 61%）

### 磁盘存在但未登记清单：audio/bf（cook 系）（9 个）

*disk_unlisted*

- 目录 audio/bf（cook 系） 下有 9 个文件不在 媒体清单.json 中。
- 样例：cook_bacon.mp3、cook_bun.mp3、cook_congee.mp3、cook_egg.mp3、cook_juice.mp3、cook_milk.mp3、cook_salad.mp3、cook_sandwich.mp3、cook_soup.mp3
- 清单总条目 375，磁盘 audio 文件 408 —— 差额说明清单已过期。

- **影响** 1.85/3 —— 治理出现盲区：缺失的自动发现手段让问题可能在发布前一直查不出来（置信 70%）
- **处置** `active_asset_needs_registration`（置信 92%）
- **命名清晰度** 0.94/2（置信 89%）

### 磁盘存在但未登记清单：audio/bf/_unused（79 个）

*disk_unlisted*

- 目录 audio/bf/_unused 下有 79 个文件不在 媒体清单.json 中。
- 样例：happy.mp3、happy2.mp3、happy3.mp3、happy_alt1.mp3、happy_alt2.mp3、happy_alt3.mp3、happy_alt4.mp3、happy_alt5.mp3、happy_alt6.mp3、happy_finally3.mp3、happy_i10.mp3、happy_i26.mp3 …
- 清单总条目 375，磁盘 audio 文件 408 —— 差额说明清单已过期。

- **影响** 1.73/3 —— 治理出现盲区：缺失的自动发现手段让问题可能在发布前一直查不出来（置信 59%）
- **处置** `superseded_backup`（置信 72%）
- **命名清晰度** 0.52/2（置信 27%）

### 磁盘存在但未登记清单：audio/mj/_bak_pre_wopeng（8 个，分布在 4 个子目录）

*disk_unlisted*

- audio/mj/_bak_pre_wopeng 及其子目录下共 8 个文件不在 媒体清单.json 中。
- 分布在：audio/mj/_bak_pre_wopeng/root、audio/mj/_bak_pre_wopeng/seat1、audio/mj/_bak_pre_wopeng/seat2、audio/mj/_bak_pre_wopeng/seat3
- 目录名以下划线开头，按项目既有约定属于非正式产物（对比 tools/archive/ 的历史脚本归档）。

- **影响** 1.44/3 —— 文档或清单与事实不符：会误导后续维护者，但游戏照常运行（置信 47%）
- **处置** `superseded_backup`（置信 87%）
- **命名清晰度** 1.16/2（置信 48%）

### 磁盘存在但未登记清单：audio/bf（happy 系）（5 个）

*disk_unlisted*

- 目录 audio/bf（happy 系） 下有 5 个文件不在 媒体清单.json 中。
- 样例：happy_finally2.mp3、happy_i45.mp3、happy_v1.mp3、happy_v3.mp3、_happy_i_report.md
- 注意：其中含 .md 文档（非素材文件），说明该目录里混入了非素材产物。

- **影响** 1.80/3 —— 治理出现盲区：缺失的自动发现手段让问题可能在发布前一直查不出来（置信 68%）
- **处置** `debug_artifact`（置信 58%）
- **命名清晰度** 0.83/2（置信 72%）

### 验收链路未覆盖：audio/bf（95 个文件）

*wiring_coverage_gap*

- audio-wiring.js 的覆盖集是 sfx/amb/bgm/mj，不含 audio/bf。
- 该目录有 95 个音频文件，从未做过「运行时可达性」验证。
- 现有接线结果全文为绿：10 项通过、0 项失败，但样本只含 251 个文件。
- 项目自身记录过同类事故：素材缺失与接线错误在断言层无法区分，导致「牌桌暗杠补杠完全没有声音」却 1542 项断言全绿。

- **影响** 2.01/3 —— 治理出现盲区：缺失的自动发现手段让问题可能在发布前一直查不出来（置信 98%）
- **归类** `coverage_gap`（置信 100%）
- **阻断发布** 81%
- **建议动作** `add_coverage`（置信 100%）

### 验收链路未覆盖：audio/vo_real（54 个文件）

*wiring_coverage_gap*

- audio-wiring.js 的覆盖集是 sfx/amb/bgm/mj，不含 audio/vo_real。
- 该目录有 54 个音频文件，从未做过「运行时可达性」验证。
- 现有接线结果全文为绿：10 项通过、0 项失败，但样本只含 251 个文件。
- 项目自身记录过同类事故：素材缺失与接线错误在断言层无法区分，导致「牌桌暗杠补杠完全没有声音」却 1542 项断言全绿。

- **影响** 2.10/3 —— 治理出现盲区：缺失的自动发现手段让问题可能在发布前一直查不出来（置信 89%）
- **归类** `coverage_gap`（置信 100%）
- **阻断发布** 81%
- **建议动作** `add_coverage`（置信 100%）

### 磁盘存在但未登记清单：audio/bf（零散）（2 个）

*disk_unlisted*

- 目录 audio/bf（零散） 下有 2 个文件不在 媒体清单.json 中。
- 样例：slow.mp3、tick.mp3
- 清单总条目 375，磁盘 audio 文件 408 —— 差额说明清单已过期。

- **影响** 1.94/3 —— 治理出现盲区：缺失的自动发现手段让问题可能在发布前一直查不出来（置信 67%）
- **处置** `active_asset_needs_registration`（置信 53%）
- **命名清晰度** 0.60/2（置信 39%）

## 三、开销

- 请求数：12
- 输入 tokens：17100 · 输出 tokens：1477
- 端到端：2.4 秒（并发 5）

> 阈值与处置口径需在真实数据上校准；本报告只提供判定与证据，不自动改动仓库。
