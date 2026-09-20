# tools/ —— 开发与验收工具

> **这些不是缓存文件，是源码。** 约 30 个 Node 脚本 + 2 个 PowerShell 渲染器，
> 跑的是真断言（麻将 847 项、早餐店 350 项）。
> 2026-09-19 从仓库根目录整体归位到这里，并按角色分目录。

## 目录结构

```
tools/
├─ lib/          共用库（被其它脚本 require，不要单独跑）
│  ├─ raster.js            自写软件光栅化器：解 PNG（zlib+反过滤）、按变换做 source-over 合成
│  └─ text-compose.ps1     System.Drawing 合成真汉字到 PNG（光栅化器画不了中文）
├─ test/         单元测试（纯逻辑，不需要浏览器）
│  └─ mahjong-logic.js     麻将逻辑 847 项
├─ e2e/          端到端 / 无头验收
│  ├─ main.js              全流程回归（16 节点）
│  ├─ bf.js                早餐店剧情链路
│  ├─ mj-browser.js        麻将浏览器实测（mshta 探针）
│  ├─ mj-system.js         麻将系统断言
│  ├─ leisure.js           闲暇玩法
│  ├─ map3d.js             3D 沙盘
│  ├─ solo-fallback.js     「缺少 video 目录」降级诊断
│  └─ debug.js             调试辅助
├─ bf/           早餐店
│  ├─ headless.js          无头验收 350 项 ← 最常用
│  ├─ shots/               出图（panel.js / panel2.js）
│  ├─ assets/              素材切片与出图（gen.js / gen2.js / shots.js / shots2.js）
│  └─ icons/               图标生成与出图（gen.js / shots.js）
├─ mj/           麻将
│  └─ shots.js             出图流水线（4 张验收图）
├─ mjsys/        麻将渲染子系统
│  ├─ probe-lib.js         mshta / System.Drawing 探针底座
│  └─ render.ps1           主题渲染器（注意：与 probe-lib.js 必须同级，见下）
├─ voice/        配音
│  ├─ e2e.js               配音验收
│  └─ lines.json           台词表
├─ audio/        音频素材工具链（生成 → 加工 → 校验）
│  ├─ README.md            整套流水线 + 五个必须知道的坑 ← 动音频素材前先读
│  ├─ paths.py             路径解析（环境变量可覆盖，跨机器可跑）
│  ├─ step_gen_audio.py    核心：调 StepAudio（Gen 音效 / TTS 配音两种任务）
│  ├─ gen_sfx.py           65 个音效 + 9 个环境音
│  ├─ gen_mj_by_seat_tts.py 麻将牌名（按座位分音色，含 speed 校正）
│  ├─ gen_bgm.py           5 种情绪 BGM（生成后自动验收循环质量）
│  ├─ process_sfx.py       切静音/响度归一/防硬切/循环交叉淡化（用 --preset）
│  ├─ check_audio.py       声学体检
│  ├─ check_bgm.py         BGM 专项（循环接缝）
│  ├─ verify_audio_content.py / verify_mj_asr.py  内容核对（ASR）
│  └─ asr_local.py         本地 SenseVoice 转录
├─ dev/          改动工具
│  ├─ patch-literal.js     逐字字面替换器（唯一性/幂等/备份/语法闸/失败回滚）← 改大文件必须用它
│  ├─ check-inline.js      校验 index.html 内联 <script> 语法
│  ├─ stamp.js             版本戳：写/校验 index.html 右下角水印（build + 指纹 + 体积）
│  └─ cdp.js               极简 Chrome DevTools Protocol 客户端（真浏览器取证：eval/nav/shot）
├─ patch/        替换器的数据（不是代码）
│  ├─ jobs/                13 个 job 定义
│  └─ text/                13 个替换文本
├─ verify/       一次性验证
│  └─ bf-btn.js            headless Chrome + CDP 验证标题屏入口（不入库，见 .gitignore）
└─ archive/      已退役脚本（保留供追溯，勿用）
   ├─ bf-integrate.js       一次性集成脚本（已完成使命）
   ├─ bf-jobs-probe.js      定位哪条 job 把语法带崩（诊断用）
   ├─ dom-probe.js / dom-probe2.js
   └─ vo-*.ps1 / mj-voice-gen.ps1 / vo-extract.js
```

## 最常用的三条

```bash
node tools/test/mahjong-logic.js    # 麻将纯逻辑单测（847 项）
node tools/bf/headless.js           # 早餐店无头验收（351 项）
node tools/dev/check-inline.js      # index.html 内联脚本语法闸（改内联胶水层后必跑）
node tools/dev/stamp.js             # 重新盖版本戳（改了 index.html/模块后跑一次）
node tools/dev/stamp.js --check     # 戳与文件不一致 → 退出码 1（打包/CI 前的闸门）
```

> 想「一条命令跑完全部三层」而不是一条条敲：
> `powershell -NoProfile -ExecutionPolicy Bypass -File run-all-tests.ps1`（`-SkipBrowser` 跳过浏览器层）。
> 分层原理、怎么给新玩法加用例、断言口径与踩坑清单见根目录 **`小游戏自动化调测指南.md`**。

## 依赖关系

```
tools/bf/shots/panel.js      ┐
tools/bf/shots/panel2.js     ┤
tools/bf/assets/shots.js     ├──→ tools/lib/raster.js
tools/bf/assets/shots2.js    ┤
tools/bf/icons/shots.js      ┘
tools/mj/shots.js            ────→ tools/mjsys/probe-lib.js ──→ tools/mjsys/render.ps1
                                                             └─→ tools/lib/text-compose.ps1
```

---

## ⚠️ 四个必须知道的约定

### 0. 别用 `python -m http.server` 把 `tools/` 暴露到公网

本地服务用 `python -m http.server 8000`（在仓库根执行），而它会把**整个目录**暴露出去 ——
包括 `tools/` 下全部脚本。本机自测无所谓；**对外演示时等于公开了全部开发脚本**。

### 1. 脚本用 `__dirname` 推算仓库根，层级改了就要跟着改

每个脚本内部都有这样一个根变量，**层级按自身所在深度推算**：

| 脚本位置 | 写法 |
|---|---|
| `tools/e2e/*.js`、`tools/bf/headless.js`、`tools/dev/*.js`、`tools/test/*.js` | `path.join(__dirname, "..", "..")` |
| `tools/bf/shots/*.js`、`tools/bf/assets/*.js`、`tools/bf/icons/*.js` | `path.join(__dirname, "..", "..", "..")` |
| `tools/mjsys/probe-lib.js` | `path.join(__dirname, "..", "..")` |

**你新写脚本时必须照此推算**，否则会去 `tools/` 里找 `index.html` 而失败。

### 2. 生成物落 `dist/`，`tools/` 与 `tests/` 只放源码

| 目录 | 放什么 |
|---|---|
| `tools/` | 纯代码 + 补丁数据，跑完不该多出文件 |
| `tests/` | **只放测试源码**（`*.test.cjs`），不放结果 |
| `dist/media-*.zip` | 素材分发包（走 GitHub Release，不入库） |
| `dist/test-results/` | **测试与出图产物的 JSON**（带时间戳，每次跑都会改写，故不入库） |
| `测试截图/` | 出图流水线的 PNG 产物 |

测试结果此前写在 `tests/` 下且被 git 跟踪，导致**每跑一次测试就污染 `git status`**；
现已全部改到 `dist/test-results/`。你新写脚本时请沿用这个约定。

例外：`tools/mjsys/probe-lib.js` 的探针临时文件（`_mj_panels.json` / `.hta` / `_out.txt`）
也落在仓库根，用完不清理 —— 这是历史行为。

### 3. `patch-literal.js` 的 job 路径相对**仓库根**，且备份后缀是设计

```bash
# job 与 textFile 都相对仓库根解析
node tools/dev/patch-literal.js tools/patch/jobs/render.json             # 演练
node tools/dev/patch-literal.js tools/patch/jobs/render.json --fresh-bak # 落盘
```

它用环境变量 `BF_BAK` 指定递增备份后缀（`.bf7bak` / `.bf8bak` …），
仓库根那些 `breakfast.js.bf8bak` 之类是**每轮迭代留的回滚点，故意保留**，已被 `.gitignore` 排除。

### 4. `mjsys/probe-lib.js` 与 `mjsys/render.ps1` 必须同级

`probe-lib.js` 内部按同目录找 `render.ps1`。要动就一起动。

---

## 新旧路径对照表

工具此前散在仓库根目录，且用 `_bf_` / `_mj_` 等前缀 + `.cjs` 扩展名。
`docs/` 下 11 份历史报告写于那个时期，**其中的命令未改动**，按下表换算：

| 旧路径 | 新路径 |
|---|---|
| `_bf_raster.cjs` | `tools/lib/raster.js` |
| `_bf_text.ps1` | `tools/lib/text-compose.ps1` |
| `_test_mahjong_logic.cjs` | `tools/test/mahjong-logic.js` |
| `_e2e.js` | `tools/e2e/main.js` |
| `_e2e_solo.js` | `tools/e2e/solo-fallback.js` |
| `_e2e_breakfast.js` | `tools/e2e/bf.js` |
| `_e2e_mahjong2.js` | `tools/e2e/mj-browser.js` |
| `_e2e_mj_system.js` | `tools/e2e/mj-system.js` |
| `_e2e_leisure.js` | `tools/e2e/leisure.js` |
| `_e2e_map.js` | `tools/e2e/map3d.js` |
| `_e2e_debug.js` | `tools/e2e/debug.js` |
| `_e2e_vo.js` | `tools/voice/e2e.js` |
| `_e2e_bf_headless.cjs` | `tools/bf/headless.js` |
| `_bf_shots.cjs` | `tools/bf/shots/panel.js` |
| `_bf_shots2.cjs` | `tools/bf/shots/panel2.js` |
| `_bf_assets_gen.cjs` | `tools/bf/assets/gen.js` |
| `_bf_assets2_gen.cjs` | `tools/bf/assets/gen2.js` |
| `_bf_assets_shots.cjs` | `tools/bf/assets/shots.js` |
| `_bf_assets2_shots.cjs` | `tools/bf/assets/shots2.js` |
| `_bf_icons_gen.cjs` | `tools/bf/icons/gen.js` |
| `_bf_icons_shots.cjs` | `tools/bf/icons/shots.js` |
| `_mj_shots.cjs` | `tools/mj/shots.js` |
| `_mj_probe_lib.cjs` | `tools/mjsys/probe-lib.js` |
| `_mj_render.ps1` | `tools/mjsys/render.ps1` |
| `_bf_patch.cjs` | `tools/dev/patch-literal.js` |
| `_bf_check_inline.cjs` | `tools/dev/check-inline.js` |
| `_bf_jobs_*.json` | `tools/patch/jobs/*.json`（去掉 `_bf_jobs_` 前缀） |
| `_bf_new_*.txt` | `tools/patch/text/*.txt`（去掉 `_bf_new_` 前缀） |
| `_vo_lines.json` | `tools/voice/lines.json` |
| `_bf_integrate.cjs` | `tools/archive/bf-integrate.js` |
| `_bf_jobs_probe.cjs` | `tools/archive/bf-jobs-probe.js` |
| `_dom_probe.cjs` / `_dom_probe2.cjs` | `tools/archive/dom-probe.js` / `dom-probe2.js` |
| `_mj_voice_gen.ps1` / `_vo_gen*.ps1` / `_vo_real.ps1` / `_vo_extract.js` | `tools/archive/` 下同名 |

---

## 关于 `.cjs` → `.js`

原脚本用 `.cjs` 扩展名。本仓库**没有 `package.json`**，Node 对 `.js` 默认就是 CommonJS，
`.cjs` 并非必需 —— 已统一改为 `.js`。

以后若要加 `package.json`：**不要设 `"type": "module"`**，否则这些脚本会被当 ESM 解析而全部报错。
若确实需要 ESM，请把 `tools/` 排除或改用 `.cjs`。

## 归位后的验证基线（2026-09-19 实测）

| 项目 | 结果 |
|---|---|
| `node --check` 全部脚本 | 30/30 通过 |
| `node tools/test/mahjong-logic.js` | **847 / 847 全部通过** |
| `node tools/bf/headless.js` | **通过 350，失败 0** |
| `node tools/dev/check-inline.js` | 内联脚本 1 段，语法失败 0 |
| `tools/patch/jobs` 里全部 `textFile` 引用 | 13/13 有效 |
| `patch-literal.js` 的 job/textFile 解析 | 已实测可读 |
