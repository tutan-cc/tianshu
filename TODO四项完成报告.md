# 待办清算报告（4 项 · 全部真跑验证）

日期：2026-09-21 · 仓库：`重生2-原型`（天枢原型）· 分支 `main` · **未做任何 commit / push**

---

## 0. 统一验收结果（串行 · 机器空载）

| # | 命令 | 结果 | 基线 → 现在 |
|---|------|------|-------------|
| 1 | `node --check breakfast.js` | exit=0 | 不变 |
| 2 | `node tools/dev/check-inline.js` | 内联脚本 2 段，语法失败 **0** | 不变 |
| 3 | `node tests/breakfast.test.cjs` | **83 / 83**，fail 0 | 79 → **83**（+4 条练手局断言，无退） |
| 4 | `node tools/bf/headless.js` | **465 / 465** | 465 → 465（无退） |
| 5 | `node tools/e2e/audio-wiring.js` | **10 / 10** | 10 → 10（无退） |
| 6 | `node tools/e2e/bf.js` | **模式 A `chrome-cdp` 通过 58，失败 0** | 原来必然降级 → **现在真跑通** |
| 6b | `BF_E2E_MODE_B=1 node tools/e2e/bf.js` | 模式 B `trident-hta` 通过 6，失败 0 | **向后兼容仍在** |
| 7 | `node tools/test/mahjong-logic.js` | **983 / 983** | 983 → 983（无退） |
| 附 | `node tests/audio-paths.test.cjs` | **20 / 20** | 无退（移音频后必跑） |
| 附 | `node tools/bf/e2e-audio.js`（真 Chrome） | **31 / 31** | 无退（移音频后必跑） |

模式 A 连跑 3 次 → 58/58、58/58、58/58（无 flaky）。

---

## 1. 早餐店入口修复（练手局 + `{force:true}` + `#dbgBf` 直接开局）

### 1.1 改了什么

**`breakfast.js`（规则层，10 处字面替换）**

| 位置 | 改动 |
|------|------|
| `newState()` `st.cfg` | 新增白名单字段 `practice: cfg.practice === true`（不显式列出来永远是 `undefined`） |
| `start()` `cfg` | 新增 `practice: opts.practice === true` |
| `finish()` | `var practice = !!st.cfg.practice; if (practice) delta = 0;`；结果新增 `practice` 标；`impact` / `quota` 换练手局口径 |
| 游戏条标题 | 练手局时追加 `🎯 练手局 · 不影响好感` |
| Canvas 赠送对象行 | 练手局时追加 `🎯 练手局` |
| `showResult()` 面板 | 标题改「练手局 · 不影响好感」+ 顶部醒目横幅 + 好感行写 **「不变（练手局）」** + 出口按钮改「结束练手局 · 继续」 |
| `debug.state()` | 暴露 `practice:!!st.cfg.practice`（真浏览器验收读它） |
| `ui.openTargetPanel()` | 新增**练手局入口排**（9 个角色按钮，恒定可点、不受 20~79 与「今天送过」限制） |

> ⚠ 练手按钮刻意用 `.bf-pchip`，**不用** `.bf-card`（`tools/bf/headless.js` 断言正式卡恰好 9 张），也**不用** `.bf-btn`（`tools/e2e/bf.js` 靠 `#bfPickHost .bf-btn` 的第一个找「先不做了」）。

**`index.html`（页面 glue，12 处字面替换；改前已备份 `index.html.todo1bak`）**

| 位置 | 改动 |
|------|------|
| `let bfRunning, bfNode` | 追加 `bfPractice` |
| `startBreakfastGame()` | `const practice = !!opts.practice;` `const forceOK = !!opts.force && (practice \|\| !!opts.debug);` → `if(!chk.ok && !forceOK)` 才拒。**`force` 只在 debug / 练手路径生效** |
| 同上 | `Breakfast.start(..., { practice: practice })`；`bfPractice = practice` |
| `bfFinish()` | 把 `practice` 传给 `bfApplyResult` |
| `bfApplyResult()` | `practice` 时**跳过** `S.bonds` / `S.breakfastDay` / `S.bfWin` / `checkAchv()`；`S.bfLast` 里记一条 `practice:true` 台账；toast 明确写「练手局 · 不影响好感 · 好感仍是 N（没变）」 |
| `openBreakfast()` | 新增 `onPracticePick` → `startBreakfastGame(id, {story:false, practice:true, force:true})` |
| `CS2_DEBUG.bfStart` / `__cs2.bfStart` | 注入 `{debug:true}` —— `CS2_DEBUG.bfStart("fang",{force:true})` 可绕开门槛；新增 `bfPractice(id)` 便捷入口 |
| `#dbgBf` 点击 | **不再只弹 toast**：`enterGame()` 后直接 `startBreakfastGame("fang", {practice:true, force:true})` |
| `bfNoteHtml()` | 空态提示补一句「想试玩 → 面板底下的 🎯 练手局」 |
| `__cs2.bfDom()` | 新增 `pickPractice`（练手入口计数，供验收） |

### 1.2 验收证据

`node tests/breakfast.test.cjs` → 83/83，其中 4 条是新增：

```
✔ 练手局①：practice 一路传到规则层（newState / start / debug.state 三处都认）
✔ 练手局②：通过路径 —— 数值照常算，但 bondDelta 恒为 0，面板明确标注
✔ 练手局③：失败路径也不扣好感（bondDelta 仍是 0，不是 −3~−6）
✔ 练手局④：对照 —— 不带 practice 的正常局照旧结算（+6~+10，没被练手局改坏）
```

真 Chrome（`node tools/e2e/bf.js`，模式 A）里的关键断言：

```
✔ 练手局对照：man 好感 0 走正常门槛必被拒（就是用户被卡住的情形）（{"ok":false,"why":"好感不足 20，现在送反而尴尬"}）
✔ 练手局对照：不带 force 的 debug 开局同样被门槛拒绝
✔ 练手局：好感 0 的角色也能开局（practice + force 绕开门槛）
✔ 练手局状态正确（running / practice=true）（{"practice":true,"target":"顾曼"}）
✔ ★ 练手局结算面板明确标注「练手局 · 不影响好感」
✔ ★ 结算面板里好感那一行写「不变（练手局）」（不是 +6）
✔ 练手局结算结果 practice=true / bondDelta=0（practice=true delta=0）
✔ ★ 练手局结束后 S.bonds 逐字段完全没变（{"fang":52,"su":38,"lin":55,"wen":24,"lei":0,"hong":85,"guo":31,"lu":0,"man":0}）
✔ ★ 练手局结束后 S.breakfastDay 没变（没写「今天已送」）（{"day":1,"sent":["fang"]}）
✔ ★ 练手局后 man 仍显示「太生疏」而不是「今天已经送过」
✔ 面板底部有练手局入口（任意角色 · 不受 20~79 门槛限制）（练手入口 9 个）
✔ ★ 点「跳到早餐店」直接进游戏（canvas 已挂载），不再只是弹 toast（{"game":true,"canvas":1}）
✔ ★ 开的是练手局（practice=true · 默认对象 fang）（{"practice":true,"target":"芳姐"}）
✔ ★ 全新档全员好感仍是 0（练手局一个字都没改）（{"fang":0,"su":0,...,"man":0}）
```

---

## 2. 仓库清理

### 2.1 `mahjong.js.layoutbak` 取消跟踪

```
$ git rm --cached mahjong.js.layoutbak
rm 'mahjong.js.layoutbak'

$ git status --short -- mahjong.js.layoutbak
D  mahjong.js.layoutbak          ← 第一列 D = 已暂存的「从索引移除」

$ Get-Item mahjong.js.layoutbak
Length 238718  LastWriteTime 2026/9/19 15:16:10   ← 文件本体还在（供回滚）

$ git ls-files | Select-String 'layoutbak'
（空 = 已彻底不跟踪）
```

原因确认：`.gitignore` 第 68 行确有 `*.layoutbak`，但**忽略规则对已跟踪文件无效**，所以必须 `git rm --cached`。

### 2.2 未使用语音归拢

核对方式（**以代码实际引用为准**，不靠文件名猜）：把 `breakfast.js` 装进 vm，直接读运行时的 `rules.audio.FILES` 与 `rules.audio.COOK_FILES`，再与磁盘清单做差集。

```
$ node tools/bf/audio-ref-audit.js          # dry-run（默认不搬）
── 代码里点名的通道 ──
   tick → tick.mp3
   happy → happy_v1.mp3, happy_v3.mp3, happy_finally2.mp3, happy_i45.mp3
   slow → slow.mp3
   cook_* → cook_congee / cook_milk / cook_soup / cook_egg / cook_bacon /
            cook_sandwich / cook_bun / cook_salad / cook_juice .mp3
── 保留（盘上 15 个，全部被代码引用）──
── 归档（盘上 78 个，代码一个字都没引用）──
核对：代码引用的 15 个文件全部在保留清单里 → true
核对：保留 15 + 归档 78 = 盘上 93 个 mp3
```

搬完后再跑同一条命令：

```
核对：代码引用的 15 个文件全部在保留清单里 → true
核对：保留 15 + 归档 0 = 盘上 15 个 mp3
```

**保留清单（15 个 · 一个没动，含用户点名的 4 条 happy + slow + tick + 9 条 cook_*）**

```
tick.mp3  slow.mp3
happy_v1.mp3  happy_v3.mp3  happy_finally2.mp3  happy_i45.mp3
cook_congee.mp3 cook_milk.mp3 cook_soup.mp3 cook_egg.mp3 cook_bacon.mp3
cook_sandwich.mp3 cook_bun.mp3 cook_salad.mp3 cook_juice.mp3
```

**移动清单（78 个 · `audio/bf/X` → `audio/bf/_unused/X`，共 2 062 134 B）**

| 组 | 个数 |
|----|------|
| `happy_n1..n59`（本轮候选全集） | 59 |
| `happy_alt1..alt6`（更早的候选） | 6 |
| `happy_i10 / i26 / i38 / i47 / i55`（上一轮备选） | 5 |
| `happy_v2 / v4 / v5 / v6`（已出池） | 4 |
| `happy / happy2 / happy3`（最老的三条） | 3 |
| `happy_finally3`（对比件） | 1 |
| **合计** | **78** |

逐条原路径 → 新路径的完整机器可读清单：`audio/bf/_unused/_MANIFEST.json`（含每个文件字节数）。
`_unused/` 被 `.gitignore` 第 93 行 `audio/**/_*` 命中（`git check-ignore -v` 已验证），与 `audio/mj/_bak_pre_wopeng/` 同做法：**不入库、不分发，但文件一个都没删**。

> git 侧表现：这 78 个原本是 tracked，移进 `_` 目录后 `git status` 记为 ` D audio/bf/xxx.mp3`（78 条）。**这是本次清理的预期结果**（等于「下次提交时把它们从库里删掉」），未做任何提交。

### 2.3 引用核对（移动后重跑）

- `node tests/breakfast.test.cjs` → 83/83。其中音频那节已改成：旧件断言走 `at()` 解析到 `_unused/`，并**新增两条硬判据**：
  - `_unused/` 里归档件齐全，且**没有任何一个**被 `R.audio.FILES` 或 `COOK_FILES` 引用；
  - `audio/bf/` 根目录 `.mp3` **恰好 15 个**，且 `deepEqual` 就是通道点名的那 15 个。
- `node tests/audio-paths.test.cjs` → 20/20（「清单登记的 305 个音频文件真实存在」「音效/环境音/BGM 数量与基线一致 65/9/5」全过）。
- `node tools/bf/e2e-audio.js`（真 Chrome 解码 + 真播放）→ 31/31，播放记录全部落在保留的 `audio/bf/tick.mp3` / `slow.mp3` / `cook_*.mp3` / `happy_i45.mp3` 上。
- `node tools/e2e/audio-wiring.js` → 10/10（麻将侧，251/251 素材 HTTP 200）。

### 2.4 两个试听页

两个页面都由 `tools/bf/make_audition_page.py` 生成，原本写死 `au.src = "../audio/bf/" + v.file`，会把 21 / 2 条已归档的条目打成 404。

改法（在**生成器**里改，再重生成页面，避免下次生成又退回旧行为）：

1. 新增 `bf_path(fn)`：正式目录优先、否则回落 `_unused/` —— 现量时长/F0/谱质心/RMS 的三个读取点全部改走它（否则读不到 → `row()` 返回 `None` → **那一行从页面上静默消失**）。
2. 数据里新增 `keep`（15 项保留清单）；模板里播放路径改成
   `au.src = ((DATA.keep || []).indexOf(v.file) >= 0 ? "../audio/bf/" : "../audio/bf/_unused/") + v.file;`
3. 两个页面各加一段「bf-12 归档」说明（哪些还在岗、归档去哪了、文件没删）。

重生成输出：

```
A 组：59 条候选里取综合分前 14 条 · A 组 14 条 / B 组 4 条 / C 组 6 条 / 停用 2 条   → bf_happy_audition.html
池内 5 条 + 停用/对比 2 条                                                        → bf_pick5.html
（没有任何 "⚠ 缺文件，跳过"）
```

引用核对（把页面里的 `DATA` 抠出来，按同一条规则解析并 HTTP HEAD）：

```
── 测试截图/bf_happy_audition.html ──   keep 清单 15 个 ✔ · 引用文件 25 个 · 走 _unused/ 的 21 个 · 全部 HTTP 200 ✔
── 测试截图/bf_pick5.html ──────────   keep 清单 15 个 ✔ · 引用文件  7 个 · 走 _unused/ 的  2 个 · 全部 HTTP 200 ✔
合计 32 条引用，取不到的 0 条
```

---

## 3. `patch-literal.js`：`--fresh-bak` 变默认

### 3.1 新旧默认对照

| | 原行为 | 新行为 |
|---|--------|--------|
| **默认（不加参数）** | 备份已存在则**不动** → 备份 = **最初那一版**；语法闸回滚会把**上一轮的好改动一起退掉**（历史事故） | **每次改前刷新备份** → 备份 = **本次改前那一版**；回滚只退本次改动 |
| `--fresh-bak` | 刷新备份（显式） | **仍然接受**，与默认完全等价（老脚本 / 老文档不用改） |
| `--keep-bak` | （不存在） | **新增**：拿回旧语义（备份已存在就不动，备份 = 最初那一版） |
| 两个 flag 同时写 | — | 直接拒绝：`✗ --keep-bak 与 --fresh-bak 互斥，只能写一个`（exit 2） |
| 日志 | `· 备份 → x.bf8bak` | `· 备份模式：刷新（默认…）` / `保留（--keep-bak…）`，并写清 `（已刷新 = 本次改前那一版）` / `（新建…）` / `（保留…）` |

**如何恢复旧行为**：`node tools/dev/patch-literal.js jobs.json --keep-bak`

文件头部注释（第 11–15 行的「③ 备份」）与用法段（第 19–22 行）已同步改写。

### 3.2 真实演示：改两次，第二次故意写语法错误

**演示① 新默认**（`_todo3_demo.js`，初始 `var todo3 = "A";`）

```
第 1 次改动（A → B，合法）
· 备份模式：刷新（默认：备份 = 本次改前那一版）
· 备份 → _todo3_demo.js.bf8bak（已刷新 = 本次改前那一版）
· node --check _todo3_demo.js ✓        → EXIT=0
   改动后内容：var todo3 = "A";  /  var step1 = "first-change-KEPT";

第 2 次改动（故意引入语法错误）
· 备份 → _todo3_demo.js.bf8bak（已刷新 = 本次改前那一版）
✗ 语法检查失败：_todo3_demo.js:3 ▸ function broken( { this is not javascript ▸ SyntaxError: Unexpected identifier 'is'
↩ 已回滚：_todo3_demo.js（坏版本留在 _todo3_demo.js.bfbroken 供定位）
        → EXIT=1

★ 回滚后内容：var todo3 = "A";  /  var step1 = "first-change-KEPT";
   → 第一次改动**还在**，只退回了第二次
```

**演示② 对照 `--keep-bak`（旧语义）** —— 同一场景：

```
第 1 次（--keep-bak）· 备份 → _todo3_demo_kb.js.bf8bak（新建 = 第一次改前那一版）→ EXIT=0
第 2 次（--keep-bak，语法错误）· 备份 → _todo3_demo_kb.js.bf8bak（保留 = 第一次改前那一版 · --keep-bak）→ EXIT=1
★ 回滚后内容：var todo3 = "A";        ← step1 **一起没了** = 历史上那个事故，已复现
```

**附加**：`--fresh-bak` 仍被接受（`· 备份模式：刷新…` → EXIT=0）；`--keep-bak --fresh-bak` 同写 → EXIT=2。

> 顺带真抓到一次：Task 2 给 `tests/breakfast.test.cjs` 写注释时把 `audio/**/_*` 写进了 `/* */` 块注释（`*/` 提前闭合注释）→ 语法闸拦下、`↩ 已回滚`，改掉注释措辞后重跑通过。**闸是真在工作的。**

---

## 4. `tools/e2e/bf.js` 模式 A 修复

### 4.1 根因不是一条，是四条（逐条实测出来的）

| # | 根因 | 证据 / 修法 |
|---|------|-------------|
| ① | **没摆前置状态**。`localStorage.clear()` 后是全新档，全员好感 0 → 9 张卡全灰 → 面板里一张 `data-ok="1"` 的卡都没有 → 选不了对象 → 后续每步都拿不到东西 | 照抄 `tools/bf/e2e-audio.js`：进沙盘后用 `CS2_DEBUG.mjSet` 摆好感 `{fang:42,su:38,lin:55,wen:24,lei:0,hong:85,guo:31,lu:0,man:0}`（刻意覆盖 可送 / 太生疏 / 已满 三种分支）。**断言一条没放松** |
| ② | **页面走 `file://`，canvas 被 taint**。`art/*.png` 与 `file://` 页面不同源，画进 canvas 后 `getImageData` 抛 `SecurityError` → 「读像素」永远失败 | 默认基地址改成 `http://127.0.0.1:8000`（同源），服务器没起才回落 `file://`；新增 `pickBase()` 探测并打印用的是哪个 |
| ③ | **`ev()` 把异常吞成 `undefined`**。`exceptionDetails` 挂在 **`r.result`** 上，原代码查的是 `r.exceptionDetails`（永远 undefined）→ 页内异常一个都检测不到 → 调用方 `JSON.parse(undefined)` 只抛一句 `"undefined" is not valid JSON`，把真正的 `SecurityError` 盖掉 | 改成读 `r.result.exceptionDetails`；`r.error` / 没有 `r.result` 时**显式抛错**并带上最后一个表达式 |
| ④ | **读账顺序反了**。页面 glue 是**点结算面板出口**才落账（`close(true)→onFinish→bfFinish→bfApplyResult`），原工具先读 `bfResult`/`S.bonds`/`S.breakfastDay` 再点出口 → 永远读到上一局（第一局读到 `null`），4~8 条断言假失败 | ⑤ / ⑥b / ⑦ 三处全部改成**先点出口、再读账** |

顺手修的两处真问题：
- **⑦「第二位对象」撞车**：原代码只返回「第一位 20~79 的角色」，而 `pick` 很可能就是同一位 → 撞「每日一次」→ 必失败。现在显式跳过本局已送过的那位。
- **失败路径少一拍等待**：`FAILDRIVER` 直接 `d.tick` 跑完，结算面板靠 rAF 里的 `showResult()` 渲染，紧接着就读会偶发读到空 —— 本轮实测 flaky 一次。补 `await sleep(500)`（与 ⑤ 对齐），此后连跑 3 次 58/58 稳定。

### 4.2 可观测性（顺手加固，不是功能）

- 降级时把模式 A 的失败项**逐条打印**（原来只打一句 `（undefined）`，完全看不出为什么降级）。
- `runChrome()` 断言未过时把 `errors.slice(0,3)` 拼进 `why`。
- `ev()` 记录 `lastExpr`，异常信息里带「最后求值的表达式」。
- 新增 `BF_E2E_MODE_B=1` 强制走模式 B —— 模式 A 修好后模式 B 平时不会再被触发，**没有这个开关就没法证明降级路径仍然可用**。

### 4.3 验收

```
$ node tools/e2e/bf.js
[基准] 页面基地址 = http://127.0.0.1:8000（本地 HTTP，canvas 同源可读像素）
[模式A] 尝试 Chrome(headless) + CDP：真实鼠标 + 读像素 + 完整两条路径…
[结果] 模式=chrome-cdp · 通过 58，失败 0

$ $env:BF_E2E_MODE_B=1; node tools/e2e/bf.js
[模式B] 降级：mshta / Trident(IE11 引擎) 真实渲染同一份 breakfast.js …（BF_E2E_MODE_B=1 强制走模式 B…）
[结果] 模式=trident-hta · 通过 6，失败 0
```

---

## 5. 纪律执行情况

- ✅ **没有任何 git 写操作**，只做了第 2 项明确要求的 `git rm --cached mahjong.js.layoutbak`；未 commit、未 push。
- ✅ 只碰了 `index.html`（第 1 项必须）与 `tools/e2e/bf.js`（第 4 项必须），**没碰** `tools/dev/fight2-balance.js`（该文件当前不存在于 `tools/dev/`，也没被创建）。
- ✅ `index.html` 改前备份 `index.html.todo1bak`（232 749 B，= 改前 SHA256 `E1235218…`），12 条锚**改前逐条核对唯一性**后才动手。
- ✅ 全部改动走 `tools/dev/patch-literal.js` 逐字字面替换；语法闸失败立即回滚（真发生过一次，见 3.2）。
- ✅ **没碰** `mahjong.js` 业务逻辑、`tools/dev/stamp.js`（`git status` 对这三个文件为空）。
- ✅ 备份全部保留（见下）。
- ✅ 只删了自己创建的临时文件；探针全程藏窗口 + `onerror` 自关，没弹窗打扰。

### 改动的文件

```
 M breakfast.js                     练手局规则层（10 处）
 M index.html                       练手局 glue + force + #dbgBf（12 处）
 M tests/breakfast.test.cjs         +4 条练手局断言；音频断言改走 _unused/
 M tools/dev/patch-literal.js       备份默认翻转 + --keep-bak
 M tools/e2e/bf.js                  模式 A 四条根因 + 练手局/#dbgBf 断言 + 可观测性
 M tools/bf/make_audition_page.py   bf_path + keep 清单 + 页面说明
D  mahjong.js.layoutbak             git rm --cached（文件本体保留）
 D audio/bf/*.mp3 ×78               移入 _unused/（未提交）
?? tools/bf/audio-ref-audit.js      新增：运行时真源核对工具（默认 dry-run）
   测试截图/bf_happy_audition.html   重新生成（归档感知）
   测试截图/bf_pick5.html            重新生成（归档感知）
   audio/bf/_unused/                78 个 mp3 + _MANIFEST.json
```

**保留的备份**：`index.html.todo1bak`、`breakfast.js.todo1bak`、`tests/breakfast.test.cjs.todo1bak`、
`tools/dev/patch-literal.js.todo3bak`、`tools/e2e/bf.js.todo4bak`、`测试截图/bf_happy_audition.html.todo2bak`、`测试截图/bf_pick5.html.todo2bak`。
**逐字补丁工单**（可复算记录）：`tools/dev/_todo1_*.json`、`_todo2_tests_jobs.json`、`_todo3_jobs.json`、`_todo4_*.json`。

---

## 6. 未完成项 / 诚实说明

1. **音频移动在 git 里是「78 条删除」**。因为 `_unused/` 被 `.gitignore` 排除，git 只看到 tracked 文件消失。这正是「归拢到不入库目录」的应有表现，但**需要一次 commit 才会真正从库里移除**；本轮按纪律没有提交。若希望「保留在库但换个目录」，得改成非下划线目录名。
2. **`audio/bf/_happy_i_report.md` 没动**（它不是音频，且已是 `_` 前缀、已被忽略）。
3. **`tools/e2e/bf.js` 模式 B 的覆盖率没变**（6 项）：HTA 里没有 `index.html` 页面壳，侧栏入口 / 剧情分支 / 结算面板 DOM 本来就覆盖不到 —— 这部分现在由模式 A（58 项）真浏览器覆盖。
4. **模式 A 的 58 项里有几处依赖真实计时**（`await sleep(500/600)`）。本轮连跑 3 次稳定，但在极端负载机器上仍可能出现「面板还没渲染」的偶发失败。已把失败路径对齐 ⑤ 的等待，但没有做成「轮询直到出现」的确定性写法（改动面会更大）。
5. **`mahjong-logic.js` 出现过一次 982/983**：失败项是 `⑦ 单次提示计算最坏耗时 546ms < 300ms`，发生在我**并发跑 4 个测试**的时候。空载重跑两次都是 983/983。该文件本轮**一个字节都没改**（`git status` 为空），判定为 CPU 争用导致的计时断言抖动。
6. **`#dbgBf` 默认对象写死 `fang`**（按验收要求「例如默认对象 fang」）。想换人请走面板底部的练手入口，或 `CS2_DEBUG.bfPractice("su")`。
7. **`tools/dev/patch-literal.js` 自身的历史 `.bf8bak` 已被新默认刷新**（现在是「本轮改前」那一版）；要找回更早的版本可用 `tools/dev/patch-literal.js.todo3bak`。
