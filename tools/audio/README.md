# tools/audio/ —— 音频素材工具链

> 从「一句描述」到「入库可玩的音效/配音/BGM」的完整流水线。
> **生成用 StepAudio，加工用本目录脚本，验收入库用 `link-media.ps1` + 测试套件。**
>
> 这套工具原先散在仓库外，2026-09-19 归位到这里：
> 「`tools/` 是源码」这个约定不该有例外，否则协作者 clone 下来无法复现素材。

## 三条主线

| 想做 | 用什么 | 产物落到 |
|---|---|---|
| 音效 / 环境音 | `gen_sfx.py` | `audio/sfx/`、`audio/amb/` |
| 麻将牌名（按座位分音色） | `gen_mj_by_seat_tts.py`（StepAudio） | `audio/mj/`、`audio/mj/seat1-3/` |
| 麻将报牌语音（统一音色，**百炼 TTS**） | `gen_mj_bailian_tts.py` + `process_sfx.py --preset word` | `audio/mj/`、`audio/mj/seat1-3/` |
| BGM（5 种情绪） | `gen_bgm.py` | `audio/bgm/` |
| 台词配音 | `step_gen_audio.py --jobs vo_jobs.json` | `audio/vo_real/` |

四条都走同一条后处理：`process_sfx.py --preset <类型>`。

## 路径与密钥（跨机器可跑）

所有路径由 `paths.py` 统一解析，规则是 **环境变量优先，否则按仓库位置推导**：

```
<仓库根>/tools/audio/paths.py
   REPO_ROOT   = <仓库根>
   MEDIA_ROOT  = <仓库根>上级/Tianshu-Prototype-媒体素材
   WORK_ROOT   = <仓库根>上级/audio-工作区     ← 原始件与中间产物都在这里（不入库、不分发）
   MODEL_ROOT  = <仓库根>上级/models           ← 本地 ASR 模型
```

想放到别处就设环境变量，**不必改代码**：

```powershell
$env:DSH_MEDIA_ROOT = "D:\媒体素材"
$env:DSH_WORK_ROOT  = "D:\音频工作区"
$env:DSH_MODEL_ROOT = "D:\models"
python tools\audio\paths.py        # 打印当前解析结果（排查路径问题先看这个）
```

密钥**只从环境变量取，绝不写进代码**：

```powershell
$env:STEP_API_KEY = "<你的 key>"
```

## 后处理预设：必须用 preset，别手写参数

`process_sfx.py` 的四个预设把踩过的坑固化成了参数组。**同一组 `rel_db` 对 60 秒环境音
和 0.3 秒单字的意义完全不同** —— 手写参数必然配错（实测曾把牌名平均时长削掉 24%）。

| 预设 | 用途 | 关键差异 |
|---|---|---|
| `sfx` | 游戏音效 | 内部无长停顿，`gap_tol=0.06` 精确掐头去尾 |
| `word` | 麻将牌名等短词 | `rel_db=42` 更保守 + 尾部余量按内容长度自适应 |
| `voice` | 台词配音 | `keep_all=True` —— **不丢句**（见下） |
| `amb` | 环境音 | 不裁内容，只统一响度 |
| `bgm` | BGM | −22 LUFS + 循环交叉淡化 1s |

```powershell
python tools\audio\process_sfx.py --src RAW --out FINAL --preset voice --force
python tools\audio\process_sfx.py --src RAW --out FINAL --preset word --only 西 --force  # 单条重做
```

### ⚠ `voice` 的 `keep_all=True` 不能去掉

原来的边界检测是「**保留最长连续有声段**」。多句台词在句间停顿超过 `gap_tol` 时，
**其余的句子会被整段丢掉，而且不报任何错**。实测：

- 顾曼 `investor_s0`：三句产出为三段、句间停顿 0.8s，恰好越过 `gap_tol=0.8` → 首句消失（5.10s → 2.79s）
- 复查全部 54 条台词，`rent_s1.mp3` **真的少了后半句**「可你总得给我个准话。」（1.72s → 4.03s）

`keep_all=True` 改为取「**首尾有声帧**」而不是长度择优。代价是可能多留一点段间房间声，
但「多留一点静音」远好于「少说一句话」。

## 目录里各脚本干什么

| 脚本 | 作用 |
|---|---|
| `paths.py` | 路径解析（唯一来源）。`python paths.py` 可自检 |
| `step_gen_audio.py` | **核心**：读 JSON 任务表调 StepAudio。Gen 与 TTS 两种任务（按有无 `voice` 字段区分） |
| `gen_sfx.py` | 生成 65 个音效 + 9 个环境音（清单从玩法调用点反推） |
| `gen_mj_by_seat_tts.py` | 麻将牌名，按座位固定音色。含 `speed` 校正与 `--only` 单条重做 |
| `gen_bgm.py` | 5 种情绪 BGM。**生成后自动验收循环质量**（音乐生成不确定性大，见下） |
| `process_sfx.py` | 切静音 + 响度归一 + 防硬切 + 循环交叉淡化。预设见上 |
| `check_audio.py` | 声学体检（时长/峰值/RMS/有声占比/前导静音/削波） |
| `check_bgm.py` | BGM 专项：时长/响度/**循环接缝差**/周期性 |
| `verify_audio_content.py` | 长台词内容核对（ASR 全文比对） |
| `gen_mj_bailian_tts.py` | **百炼 Qwen-TTS** 生成麻将报牌语音（字牌念全名：红中/白板/东风/发财） |
| `verify_mj_omni.py` | **盲听**验收报牌语音念得对不对（qwen3.8-omni-flash + 拼音同音匹配，不依赖本地 ASR 模型） |
| `verify_mj_asr.py` | 牌名内容核对（拼音同音匹配 + **跨座位共识**） |
| `verify_pairwise.py` | 同词跨座位交叉验证：`--len` 有声段时长 / `--content` ASR+提示泄漏 / `--acoustic` MFCC-DTW |
| `audio_eval.py` | **四层综合评估器**（推荐日常用）：声学 + 音色 + 内容 + 感知。`--audit-sfx` 全量音色审计 |
| `regen_sfx_noise.py` | 重做「本该是物理音却做成了纯音」的音效（强噪声提示词 + 平坦度验收） |
| `omni_judge.py` | 用全模态模型（Qwen-Omni）做**感知层**验收：音效/音乐/环境音 —— ASR 完全看不到的那部分 |
| `asr_local.py` | 本地 SenseVoice 转录（离线，免 API 费用） |

## 依赖

```powershell
pip install numpy sherpa-onnx pypinyin
pip install openai        # 仅 omni_judge.py 需要（全模态感知层验收）
# ffmpeg / ffprobe 需在 PATH 上（解码、响度归一、出图都靠它）
```

本地 ASR 模型（约 229 MB，不入库）：

```
<仓库根>上级/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/
```

全模态验收另外需要百炼的凭据（**只从环境变量取**）：

```powershell
$env:DASHSCOPE_API_KEY  = "sk-..."                  # 百炼控制台 → API-KEY 管理
$env:DASHSCOPE_BASE_URL = "https://{业务空间}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
```

## 验收：改完素材必须跑这三步

```powershell
# 1. 声学体检
python tools\audio\check_audio.py <目录> --min-dur 0.15 --max-dur 3.0 --min-peak -24
python tools\audio\check_bgm.py                      # BGM 专测

# 2. 内容核对
python tools\audio\verify_audio_content.py <目录>     # 台词
python tools\audio\verify_mj_asr.py                   # 牌名（跨座位共识）
python tools\audio\verify_pairwise.py --len           # 牌名有声段时长（抓截断）
python tools\audio\verify_pairwise.py --content       # 牌名内容 + 提示泄漏
python tools\audio\audio_eval.py <目录> --no-omni     # 四层里的前三层（离线免费）
python tools\audio\audio_eval.py --audit-sfx          # 全量音色审计：物理音 vs 纯音
python tools\audio\omni_judge.py --selftest           # 感知层：先验模型可信度
python tools\audio\audio_eval.py <目录>               # 四层全开（需 DASHSCOPE_API_KEY）

# 3. 接线 + 入库（最关键，能抓到「断言全绿但没声音」）
powershell -File .\pack-media.ps1      # 更新 媒体清单.json 与分发包
powershell -File .\link-media.ps1      # 按清单逐文件校验 SHA256
node tools\e2e\audio-wiring.js         # 需要 python -m http.server 8000
powershell -File .\run-all-tests.ps1
```

---

## ⚠️ 必须知道的坑（都实测过，不是理论）

### 0. `cixingnansheng` 会把舞台提示**念出来** —— 提示词泄漏与音色有关

**这是本项目最隐蔽的一个坑，藏了很久才暴露。**

牌名生成原本一律用「（利落报牌，语速偏快）9筒」这种长舞台提示。
换到座位0（主角音色 `cixingnansheng`）后，实测 ASR 转录出的是：

```
输入：（利落报牌，语速偏快）9筒
ASR ：利落爆牌酒桶。          ← 提示词被当成正文念了，牌名被淹掉
```

而座位 1/2/3 用**完全相同的模板**一直正常。对照实验说明这**取决于音色**：

| 音色 | 输入 | 结果 |
|---|---|---|
| `cixingnansheng` | 「（利落报牌，语速偏快）9筒」 | **泄漏**（「利落爆牌酒桶」） |
| `lengyanyujie` | 同上（同模板） | 正常（「球桶。」） |
| `cixingnansheng` | 「（平静地）9筒」 | 正常 |
| `cixingnansheng` | 「9筒」 | 正常 |

**规则：括号里的舞台提示只写两三个字的情绪词**（`gen_mj_by_seat_tts.py` 的
`MOODS` / `TILE_MOOD`）。长描述还有另一个雷：会触发内容审核 HTTP 451。

> 换新音色时，**必须重新验证提示词**，不能假设「别的音色能用它就能用」。

### 0b. 「加工前后总时长」是个测不出问题的指标

曾经用它当验收依据，结果漏掉一个存在很久的严重缺陷：
共用目录（座位0）43 条里 **15 条的有声内容被削到不足座位目录的 55%** ——
`杠开` 0.02s、`1筒` 0.04s、`杠` 0.02s，短到「五万」和「一万」都分不出来
（实测 5万 被听成「喂」）。而当时的时长报表一切「正常」。

**它只能说明「削掉了静音」，不能说明「留下了完整人声」。**
要测的是**有声段时长**与**内容**：

```powershell
python tools\audio\verify_pairwise.py --len       # 有声段时长 vs 其它座位
python tools\audio\verify_pairwise.py --content   # ASR + 提示泄漏检测
```

### 1. 「素材缺失」与「素材接错」在断言层面无法区分

`AudioSys` 全层是「有文件用文件，缺失回落合成」。设计本身是对的，
但它让 1542 项断言全绿的情况下，牌桌上「暗杠」「补杠」**完全没有声音**
（四个座位全 404 → `Audio` 无 error 兜底 → 静默丢弃）。
**所以 `tools/e2e/audio-wiring.js` 是必需的一层**，它主动发 `HEAD` 探存在性。

### 2. ASR 对短促喊牌识别率低 —— 单条判错不可信

「杠」被听成「告/干/大」、「碰」被听成「哼」是常态。
**跨座位共识**比单条可信：同一个词多数座位都判错才值得查
（注意是「多数」不是「全部」—— 曾因为要求「全判错」，被一个侥幸正确的座位
掩盖了两条真坏件）。`verify_pairwise.py --acoustic` 用来区分「ASR 判错」与「真坏件」。

⚠ 但 `--acoustic` 的适用边界很窄：牌名多是 0.4~0.7s 的**两字短词**，
MFCC-DTW 在这个尺度上分辨力很差（同类词与异类词的距离高度重叠）。
所以它加了「分差 < 2.0 不下结论」的门槛，对单音节短促音直接弃权。
**它的定位是缩小人工听辨范围，不是替代人耳。**

顺带：ASR 会把口语「七」写成 `7`，比对前必须做汉字数字归一，否则正确件会被误报。

### 2b. 用全模态模型（Qwen-Omni）做感知层验收 —— 以及它的三个限制

音效/音乐/环境音在纯 ASR 眼里**等于不存在**（`暗杠.mp3` 转录结果是空字符串），
这层盲区可以用全模态模型补上。实测 `qwen3.8-omni-flash`：

| 能力 | 实测结果 |
|---|---|
| 判类（语音/音效/音乐/环境音） | **93%**（15 个真实素材，14 对；5 类是人工分的） |
| 描述音效 | 很强：「木槌敲击声、低沉鼓声、最后一下金属镲片」「持续的低频轰鸣」 |
| 情绪/氛围标注 | ASR 完全做不到：「忧郁、沉思、孤寂」「阴郁、压迫、悬疑」 |
| 顺带验证语音内容 | 可用（但 ASR 更专） |

**三个必须知道的限制**（`omni_judge.py --selftest` 就是为此设计的）：

1. **它会对纯静音编造内容。** 喂一段 ffmpeg 生成的、逐样本全零的 3 秒静音，
   它 5 次里有 4 次编出「游戏界面确认蜂鸣声」「低频持续电子单音（类似测试音）」。
   **静音检测必须用声学层（`check_audio.py`），不能交给模型。**
2. **幻觉率由提示词决定。** 第一版提示词（「这是一段游戏音频素材…」）会让它
   为了配合提问而编造；改成明确列出「静音」选项并要求「不要猜测或补充并不存在的内容」
   后，同一文件 4 次全对。**别让提示词预设「里面一定有内容」。**
3. **不能做细粒度音质判断。** 它说「突然截断」时对多数素材都是误报 ——
   「听起来像不像话」它能答，「接缝是否超过 6dB」它答不了（那是 `check_bgm.py` 的事）。

结论：**它管「这是什么、什么感觉」，声学层管「是否合格」，ASR 管「念得对不对」。**
三者互补，不可互相替代。

### 2c. 座位号从 0 开始 —— `if args.seat` 会把 `--seat 0` 当成没传

`0` 是 falsy，`--seat 0` 会被判成「没指定」而跑遍所有座位（实测浪费 3 倍 API 调用）。
一律写 `if args.seat is not None`。这类坑在座位号/索引上很常见。

### 3. 音乐的生成不确定性远大于音效/人声 —— 「重跑」不是免费的

同一份提示词重跑 5 条 BGM，接缝差从「0.7~4.4dB 全部达标」变成
「night 12.4dB / dark 6.5dB + 强周期 0.69」。**动它之前先备份当前达标件，跑完必须重新验收。**
`gen_bgm.py` 已内置自动验收，不达标会报错。

### 4. 别让 ASR 缓存落进仓库

`tools/` 只放源码。缓存一律落 `WORK_ROOT`，否则跑一次工具就污染 `git status`。

### 5. PowerShell 写出的 `.ps1`/`.json` 常带 BOM

`step_gen_audio.py` 读任务表用 `utf-8-sig` 就是为了容忍 BOM，
否则 `json.load` 会报 `Unexpected UTF-8 BOM`。**别改成 `utf-8`。**
