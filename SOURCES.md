# 素材来源与授权清单（SOURCES）

> 借鉴自参考项目 `tutan123/tianshu` 的 `assets/SOURCES.md` 纪律：**每一项素材都要写清来源与授权状态**。
> 本文件随项目更新；⚠ 标记项在公开发布前必须处理。

## 一、视频 / 图片

| 素材 | 来源 | 授权状态 |
|---|---|---|
| `video/*.mp4`（35 段实拍） | 第三方素材库，按人物/场景分类（原路径含项目旧名，改名后未追溯） | ⚠ **未核实，不入库**。发布前必须替换为自有素材或取得授权 |
| `video/poster/*.jpg`（35 张剧照） | 由上表视频用 ffmpeg 抽帧生成 | ⚠ 随源视频，同上，不入库 |
| `video/fx_market.mp4`、`video/fx_flood.mp4`（+ 对应 2 张剧照） | 本项目程序化生成（PowerShell + System.Drawing 逐帧绘图 → ffmpeg 合成） | ✅ 原创，**已入库**（其余 68 个实拍素材不入库） |
| `art/**`（94 个 png） | Lovart AI 生成，见第五节 | ✅ 原创，**已入库** |

> **为什么这几类入库与否不同**：授权清晰、体积小、不会反复重做的自产素材直接入库；
> 授权未核实的实拍素材（208 MB）走带外分发。
> 详见 `dist/素材分发/README.md` 与 `协作者上手指南.md`。

## 二、音频（305 个文件，**全部自产，已入库**）

全部由本项目用 StepFun **StepAudio 3**（Gen / TTS 两个端点）生成，可自由使用，随仓库分发。
制作流程与工具链见 `docs/音频素材制作.md` 与 `tools/audio/README.md`。

| 目录 | 数量 | 内容 | 生成方式 |
|---|---|---|---|
| `audio/vo_real/` | 54 | 主线台词配音（13 个角色 + 旁白） | TTS，固定 `voice` 保证同角色音色一致 |
| `audio/mj/` | 43 | 麻将牌名播报 · 座位0（主角，共用目录） | TTS `cixingnansheng` |
| `audio/mj/seat1|2|3/` | 43×3 | 麻将牌名播报 · 金老板 / 红姐 / 顾曼 | TTS，各座位固定音色 |
| `audio/sfx/` | 65 | 玩法与 UI 音效（麻将 / 早餐店 / 谈判 / 格斗 / 躲避 / 股市 / 答题 / 刮刮乐） | Gen，`[音效描述]` |
| `audio/amb/` | 9 | 场景环境音（对应 9 个 `loc`） | Gen |
| `audio/bgm/` | 5 | 5 种情绪 BGM（calm / city / tense / night / dark） | Gen |

**授权：AI 生成，无第三方版权。** 已随仓库入库（`git clone` 即可获得，无需额外素材包）。

### 已移除的音频及其原因（历史记录，保留供追溯）

| 原路径 | 内容 | 处置 | 依据 |
|---|---|---|---|
| `audio/vo_real/*.mp3`（24 条，旧） | 从实拍视频用 `silencedetect` 自动截取的**演员原声** | **移出仓库** → `H:\GAMEDEV\Tianshu-第三方素材\audio\vo_actor\` | 内容是他人的声音与原台词，与实拍视频同性质（授权未核实） |
| `audio/vo/*.mp3`（45 条，旧） | Windows SAPI 合成 TTS | **已删除** | 念稿感重、质量不达标 |
| `audio/mj/*.mp3`（45 条，旧） | 同上，麻将牌名播报 | **已删除**，后被 StepAudio TTS 版本取代 | 同上 |

> ⚠ 若日后改用其它外部 TTS / 音效服务生成，请在下表追加来源与授权记录。

### 音频的验收链路（为什么可以放心入库）

四层自动验收，1572 项断言全绿：声学（时长/响度/静音/削波）· 音色（mel 平坦度，判「物理音 vs 纯音」）·
内容（本地 SenseVoice ASR 比对，抓念错与提示词泄漏）· 感知（Qwen-Omni 全模态，覆盖 ASR 看不到的
音效/音乐/环境音）。接线由 `tools/e2e/audio-wiring.js` 逐个 URL 验可达性。
详见 `docs/全模态模型做音频验收.md`。

## 三、代码与第三方库

| 项 | 说明 |
|---|---|
| `index.html` 全部代码 | 本项目自研；架构仿照《天枢 · 重启大一》v1.6 制作方案（数据驱动节点 / 视频优先 / 珍珠链叙事） |
| 参考项目 | `tutan123/tianshu`（GitHub）——本轮借鉴其存档校验、装备加成、circuit/memory 小游戏机制与测试契约，**均为思路借鉴，未复制其代码** |
| 第三方库 | **无**。项目零依赖：无 Three.js / Matter.js / 构建工具，双击即可运行 |

## 四、生成工具链（可复现）

### 4.1 音频（已入库，`tools/audio/`）

| 脚本 | 作用 |
|---|---|
| `paths.py` | 路径解析（环境变量可覆盖，跨机器可跑） |
| `step_gen_audio.py` | 核心：调 StepAudio（Gen 音效 / TTS 配音两种任务） |
| `gen_sfx.py` | 65 个音效 + 9 个环境音 |
| `gen_mj_by_seat_tts.py` | 麻将牌名，四个座位分音色（含 speed 校正、`--only` 单条重做） |
| `gen_bgm.py` | 5 种情绪 BGM（生成后自动验收循环接缝） |
| `process_sfx.py` | 切静音 / 响度归一 / 防硬切 / 循环交叉淡化（五个 `--preset`） |
| `check_audio.py` · `check_bgm.py` · `audio_eval.py` | 声学 · 循环 · 四层综合评估 |
| `verify_audio_content.py` · `verify_mj_asr.py` · `verify_pairwise.py` | 内容核对（ASR / 拼音同音 / 跨座位交叉） |
| `omni_judge.py` · `regen_sfx_noise.py` | 全模态感知层验收 · 纯音音效重做 |

### 4.2 图片（Lovart AI，见第五节）

| 脚本 | 作用 |
|---|---|
| `tools/bf/assets/gen.js` · `gen2.js` | 九宫格切片（自动求切分参数，不写死） |
| `tools/bf/assets/faces-happy-gen.js` | 满意表情切片 |

### 4.3 早期一次性脚本（未随包保留，仅记录）

| 脚本 | 作用 |
|---|---|
| `_genanim2.ps1` | 生成交易屏 K 线动画（.NET 逐帧 → ffmpeg）。管线细节见《架构文档》4.11 |
| `_vo_extract.js` | 从 `index.html` 抽取全部台词 → `_vo_lines.json`（后继：`tools/voice/lines.json`） |
| `_vo_gen.ps1` · `_vo_gen_narr.ps1` | 旧 Windows SAPI TTS 配音（已被 `tools/audio/` 的 StepAudio 取代） |
| `_vo_real.ps1` | 旧「真人原声抽取」（已废弃：那份素材授权未核实，已移出仓库） |
| `_e2e.js` / `_e2e_solo.js` / `_e2e_vo.js` | 旧 CDP 验收脚本（已归位到 `tools/e2e/`） |

---

## 五、Lovart 生成素材（原创，已入库）

| 材料 | 内容 | 用途 |
|---|---|---|
| `art/lovart_63f2f17a1187.png` | 食材九宫格（9 种早餐） | 已切片 → `art/icons/*.png` |
| `art/lovart_41a8d9d144bc.png` | 早餐店场景背景 | 已裁切 → `art/bg/kitchen.png` |
| `art/lovart_7f81bea2418a.png` | 厨具九宫格 | 已切片 → `art/icons/gear/*.png` |
| `art/lovart_a5fddf40cc93.png` | 顾客头像六宫格（3 人 × 平静/着急） | 已切片 → `art/icons/faces/*.png` |
| `art/lovart_d72b7b15758c.png` | UI 元素九宫格 | 已切片 → `art/icons/ui/*.png` |
| `art/lovart_531fa9608451.png` | 玩法入口图标九宫格 | 已切片 → `art/icons/game/*.png` |

生成方式：Lovart AI（`lovart-api` skill，MCP/HTTP 均未使用），以用户提供的手游截图作风格参考图；提示词见 早餐店-素材全集接入报告.md。
版权：AI 生成原创素材，无第三方版权，随仓库分发。

### 五之二、Lovart 第二批（本轮新增，已入库）

| 材料（按生成顺序） | 内容 | 用途 |
|---|---|---|
| `art/lovart_d227a60381a7.png` | 盘面六宫格（空盘 / 只装煎蛋 / 只装培根 ｜ 只装三明治 / 只装包子 / 只装沙拉） | 已切片 → `art/icons/gear/plate_{empty,egg,bacon,sandwich,bun,salad}.png` |
| `art/lovart_83728cd45e62.png` | 早餐店背景 v2（完整樱花树冠 + 完整开放厨房货架） | 已裁切 → `art/bg/kitchen2.png`（首选，v1 兜底） |
| `art/lovart_65d159fe6de7.png` | 顾客头像六宫格：女房东 ×(平静/着急/满意) ｜ 女护士 ×(平静/着急/满意) | 已切片 → `art/icons/faces/{fang,lu}_{calm,urgent,happy}.png` |
| `art/lovart_1a973d87de0e.png` | 麻将/中式茶室包间背景（深绿绒布方桌留空 + 四把木椅 + 暖光吊灯） | 已裁切 → `art/bg/mahjong.png` |
| `art/lovart_cef6ccfa89a5.png` | 麻将道具九宫格（白板 / 發 / 两骰子 ｜ 蓝·红·金筹码 ｜ 深蓝斜纹牌背 / 木牌尺 / 烟灰缸） | 已切片 → `art/icons/mj/*.png` |

切片参数见 `art/_assets2_report.json`（脚本 `tools/bf/assets/gen2.js` 自动求出，未写死）。
接入过程与取舍见 `docs/早餐店-素材二批接入报告.md`。

### 五之三、Lovart 第三批（满意表情，已入库）

| 材料 | 内容 | 用途 |
|---|---|---|
| `art/lovart_cca01cd7ba70.png` | 顾客头像横排三格：学生 / 女白领 / 胖大爷 ×「满意」 | 已切片 → `art/icons/faces/{stud,office,uncle}_happy.png` |

补齐后 `art/icons/faces/` 为 **5 位角色 × 3 情绪 = 15 张**（此前 happy 态只有女房东 / 女护士两张，
其余三位在「订单全部拿到」时走「回退平静脸」）。切片参数见 `art/_faces_happy3_report.json`
（脚本 `tools/bf/assets/faces-happy-gen.js` 调用 `tools/bf/assets/gen2.js` 的 `sliceGrid()` 自动求出，未写死）。
接入过程见 `docs/满意表情与麻将桌装饰接入报告.md`。


