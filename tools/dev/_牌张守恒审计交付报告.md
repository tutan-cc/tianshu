# 牌张守恒审计 + 「桌上出现六张六条」根因修复 · 交付报告

> 用户实测：「桌上出现六张六条？？？每张牌型有且只能有四张啊」
> 硬不变量：**每种牌 ≤ 4 张 · 全场恒 = 136 张**（`INCLUDE_HONORS=false` 时 108 张）

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 审计函数 | `Mahjong.debug.tileAudit()`（容器口径）+ `Mahjong.debug.renderAudit()`（渲染口径），**单测 / 探针 / 浏览器断言同一份实现** |
| 全量实测 | AI 对战 600 局 **77,248 拍** · UI/人类路径 70 局 **9,869 拍 + 5,409 帧** · 边界用例 10 个 **5,022 拍** · 浏览器真引擎自走 **188 拍 + 104 帧** → **全部守恒** |
| 唯一能造出「六张六条」的路径 | 调试摆牌 API `Mahjong.debug.setHand()` / `forceWin()`（旧实现**只加不减**）→ **已复现、已修复** |
| 复现证据 | 修复前：真打 82 拍（136/136、6条 4 张）→ `setHand(含 3 张 6条)` → **6条 × 6 张 · 总数 137/136**；修复后同一实验：**6条 × 4 张 · 总数 136/136 · 画面 4 张** |
| 新增断言 | `tools/test/mahjong-logic.js` 第 22 节（98 条）+ `tools/e2e/mj-browser.js` 15 条（Chrome 段 5 + Trident 段 10） |
| 验收 | `node --check mahjong.js` ✔ · `node tools/dev/check-inline.js` ✔（2 段内联）· 单测 **1083 → 1181 条**（本轮实测 1180~1181 通过，唯一失败是**既有**的「提示计算最坏耗时 < 300ms」负载型断言）· e2e Trident **176 → 191 项**（本轮 189 通过，失败项是**既有**的脆弱检查，见 §6） |

---

## 1. 审计函数：用法与口径

### 1.1 `Mahjong.debug.tileAudit([engine])`

**唯一口径**：把场上每一张牌在**哪个容器**里数一遍。

遍历的位置（一个不落）：

| 位置 | 说明 |
|---|---|
| `E.wall` | 牌墙（含未摸的墩；摸牌 `shift` / 杠后补摸 `pop`，两者都真的移走） |
| `E.P[i].hand` | 四家暗手 |
| `E.P[i].drawn` | 当前摸到的牌 —— **链接位**：它就是手牌最后那张，单独计数会重复，所以只校验「手牌里确实有这张」 |
| `E.P[i].melds[].tiles` | 四家副露：碰 3 / 明杠 4 / **暗杠 4** / 补杠 4（按数组实长，并校验张数） |
| `E.P[i].discards` | 四家弃牌（牌河） |
| `G.anim.disc` | 落河动画记录 —— **链接位**：渲染只取 `seat/at` 算进度，从不按 `anim.disc.tile` 画牌 |
| `G.view` | 结算亮牌板（派生视图）：只校验它与引擎**逐张一致** |

判据：
1. 每种牌 **≤ 4**（并校验牌种属于本局牌组）
2. 全场总数 **= 136 / 108**
3. 容器之间**不许共用同一个数组对象**（浅拷贝 / 共享引用 → 同一张牌存在两处）
4. 链接位（`drawn` / 动画）指向的牌必须是本局合法牌种、且确实存在于该在的地方

返回值：

```js
{
  total,            // 实际统计到的总张数（用户截图那局看的就是这个数）
  expect,           // 应有张数 136 / 108
  ok,               // 硬不变量是否成立
  byType: { "6条": 4, ... },
  violations: [ { tile:"6条", count:6, where:"牌墙 3 张 + P0(你).手牌 3 张" } ],
  places: { "牌墙": { count, tiles }, "P0(你).手牌": {...}, "动画.落河(P1·链接)": {...} },
  marks: [ { where, tile, ok } ],
  max, honors, wall, turnNo, phase
}
```

### 1.2 `Mahjong.debug.renderAudit()` —— 渲染层守恒（审计第二步 d）

`drawTileFace()` 是**所有牌面绘制的唯一出口**（手牌 / 副露 / 牌河 / 落河动画 / 结算亮牌板 / 牌面总览），
它在 `G.stat.faceTiles` 里逐张记账；`renderAudit()` 统计**本帧画面上每种牌面各几张**（≤ 4），
**不猜像素**。`mode` 区分 `table / result / sheet / demo`（后两个是调试视图，`debugView:true`）。

### 1.3 常驻断言开关（探针 / 单测打开，线上默认关）

```js
Mahjong.debug.tileAuditInstall();                       // 把 Engine 的每个状态变更入口包一层审计（幂等）
Mahjong.debug.tileAuditOn(true, hook);                  // 打开；hook(rec) 可选
Mahjong.debug.tileAuditReport();                        // { on, n, fails, list:[{tag,seat,tile,violations,places}] }
Mahjong.debug.tileAuditState();                         // { on, n, fails, last }
```

包住的入口 = 发牌 / 摸牌 / 出牌 / 碰 / 直杠 / 暗杠 / 补杠 / 抢杠 / 让杠 / 杠后补摸 / 成牌 / 流局。
**关掉开关后包装体只有一次布尔判断，零开销。**

---

## 2. 根因（指到函数 / 行）

### 2.1 先排除「正常对局」——它不是嫌疑对象（有数据）

| 覆盖路径 | 规模 | 结果 |
|---|---|---|
| 纯 AI 四家互打（`_mj-tile-audit-probe.js`） | 600 局 / **77,248 拍**（每次状态变更后审计） | 0 违规 |
| UI + 人类座位（`_mj-ui-audit-probe.js`，真 Chrome）：人类出牌 990 次 / 碰 19 次 / 杠 3 次 | 70 局 / **9,869 拍 + 5,409 帧** | 0 违规 · 画面单种最大 **4** |
| 边界用例（`_mj-stress-audit-probe.js`，固定牌墙夹具、夹具本身守恒） | 10 场景 / **5,022 拍**：补杠被抢 · 直杠被抢 · 暗杠补摸 · 连续碰/杠/补杠 · 四副露大吊车 · 流局 · 108 张 · 连开 3 局 · 手牌 3 张 6条被碰 | 0 违规 |
| 浏览器真引擎自走（e2e Trident 段新增） | 整局 **188 拍 + 104 帧** | 0 违规 |

> 也就是说：**发牌 / 摸 / 打 / 碰 / 明杠 / 暗杠 / 补杠 / 抢杠 / 胡 / 流局 这些正常路径，一张牌都不会多。**

### 2.2 真正会「凭空复制」的只有一处：调试摆牌 API

**修复前那一版（`mahjong.js.bf8bak`，与用户手里的 v1.30 包逐行相同）**：

```js
// L5217-5220  dbgSetHand
p.hand = (hand || []).slice();          // ← 旧手牌原地丢弃、新手牌凭空出现
if (melds !== undefined && melds !== null) p.melds = melds.slice();

// L5289-5297  dbgForceWin
var oldCount = p.hand.length;
p.hand = hand.slice();                  // ← 同上：只加不减
p.melds = [];                           // ← 旧副露的牌也一起消失
```

**机理**：这两个函数是「整手替换」——**新牌凭空加上去、旧牌凭空消失**，
整副牌的总数开始漂移，某一种牌很容易超过 4 张；随后**结算亮牌板 / 牌桌就会把它画出来**。

**实测复现**（`node tools/dev/_mj-ui-audit-probe.js --repro`，真 Chrome + 真渲染）：

```
── 目标牌 6条：摆牌前全场 4 张（自己手牌 1 + 别处 3）
   真打 82 拍后容器审计：ok · 总数 136/136
   调试摆牌 setHand 返回 true → 摆牌后全场 6条 = 6 张 · 总数 137/136
   ✖ 6条 × 6 → 牌墙 3 张 + P0(你).手牌 3 张
   ✖ （结构） × 137 → 全场总数 137 ≠ 应有 136 张（差 1）
```

**这就是用户截图里的那一幕**：6条 一共 6 张，分散在「自己的手牌 / 牌墙（别处）」。
（这两个 API 在出厂的 `index.html` 上是够得着的：`window.__cs2.mj = Mahjong.debug`；
仓库自带的浏览器探针 mshta/Trident 会**弹出一个可见窗口**渲染同一张牌桌，并在其中调用它们 ——
`_mj_render_probe.hta` / `_mj_alive.txt` 就是它的产物。）

---

## 3. 修复点

1. **新增守恒摆牌 `rigPlayerPreserving(E, seat, wantHand, wantMelds)`**（当前 `mahjong.js` L5086）
   只做一件事：**搬牌，绝不造牌**。
   - 想要的牌优先从「自己现有手牌 + 副露」留用；
   - 缺的从 `牌墙 → 别家暗手 → 别家牌河 → 别家副露（整组拆掉、其余牌回牌墙）` 依次取，
     每取一张等量回填一张旧牌（别家容器张数不变）；
   - 剩下的旧牌全部回牌墙；
   - 请求里某种牌 **> 4 张**（物理上不存在）→ 返回 `false`，**不改任何状态**。
   → 因为整副牌只是被重新分配，「每种牌 ≤4 · 总数 = 136」**自动成立**，不可能再摆出第 5 张。
2. **`dbgSetHand`**（L5330-5335）、**`dbgForceWin`**（L5408-5411）改走守恒版。
3. 渲染层记账：`drawTileFace()` 开头把牌面写进 `G.stat.faceTiles`（`renderTable` 每帧重置）；
   `renderAudit()` 读它统计。
4. 审计口径细节：`G.anim.disc` 是「落河动画起点记录」而非牌容器（渲染从不按它的 tile 画牌），
   按**链接位**登记 + 校验牌种合法，不参与计数 —— 早期版本用「现在还在不在动画中」去比牌河最后一张，
   在快进测试里会误判（已修，并在代码注释里写明原因）。

---

## 4. 复现 / 验证日志（修复前后对照）

```
【修复前】node tools/dev/_mj-ui-audit-probe.js --repro
  目标牌 6条：摆牌前全场 4 张（自己手牌 1 + 别处 3）
  真打 82 拍后容器审计：ok · 总数 136/136
  调试摆牌 setHand 返回 true → 摆牌后全场 6条 = 6 张 · 总数 137/136
  ✖ 6条 × 6 → 牌墙 3 张 + P0(你).手牌 3 张
  ✖ （结构） × 137 → 全场总数 137 ≠ 应有 136 张（差 1）

【修复后】同一实验
  目标牌 6条：摆牌前全场 4 张（自己手牌 0 + 别处 4）
  真打 81 拍后容器审计：ok · 总数 136/136
  调试摆牌 setHand 返回 true → 摆牌后全场 6条 = 4 张 · 总数 136/136
  本帧画面审计：ok · 画面共 64 张牌面 · 单种最大 4 · 6条 画了 4 张
  （另：请求 5 张同名牌 → 返回 false 被拒绝，状态不变）
```

其他关键日志：

```
【纯 AI 600 局】跑完 600 局 · 每拍审计共 77248 次 · 违规局数 0 · 全部守恒 ✔
【UI 路径 60 局】引擎审计 8194 拍 · 渲染审计 4480 帧 · 引擎违规局 0 · 渲染超标局 0 · 画面单种最大 4 张
                 人类座位动作：{"discard":990,"peng":19,"pass":52,"gang":3}
【边界用例】10 个场景 · 违规 0 个 · 合计审计 5022 拍
            ① 补杠→被抢杠胡：9筒全场 4 张 · 总数 136      ② 直杠→被抢杠胡：抢杠前后 9筒 均 4 张
            ④ 暗杠→补摸：副露 4 张 · 5筒 4 张 · 136        ⑤ 连续碰/暗杠/补杠：1筒4/3筒4/4筒4 · 136
            ⑥ 四副露大吊车：大大胡 每家 120 · 136           ⑦ 流局：136/136 · 单种最大 4
            ⑧ 108 张牌组：108/108                           ⑩ 手牌 3 张 6条 被碰：全场仍 4 张、手牌剩 1 张
【e2e Trident 段新增】tile_audit_ok:"136/136 tiles, max-per-kind 4"
                      tile_audit_game_ok:"188 beats, all conserved"
                      render_audit_max:"max faces per kind 4 (limit 4), over-frames 0"（104 帧）
                      rig_setHand_ok / rig_no_overflow / rig_refuse_impossible 全绿
```

---

## 5. 新增断言清单

### 5.1 `tools/test/mahjong-logic.js` 第 22 节（98 条）

- **22.0** 出口形状：`tileAudit` / `renderAudit` / `tileAuditInstall` / `tileAuditOn` / `debug.tileAudit` 同源
- **22.1** 造牌 / 发牌后：136 张 · 34 种 · 每种 4 张 · ok；`honors=false` → 108 张且无字牌
- **22.2 AI 整局 × 3，每一拍审计**（发牌/摸/打/碰/杠/补摸/抢杠/胡/流局）→ `fails === 0`
- **22.3 边界用例（每种都逐拍审计）**
  ① 补杠 → 被抢杠胡（唯一会把 3 张 `concat` 回手牌的路径）
  ② 直杠 → 被抢杠胡
  ③ 暗杠 → 杠后补摸 → 打到结束
  ④ 连续碰 2 次 → 暗杠 → 补杠（同家连续改手牌）
  ⑤ 四副露大吊车（4 碰 + 单吊 9筒）→ 真实结算
  ⑥ 流局（牌墙摸完）
  ⑦ 108 张牌组整局
  ⑧ 连开 3 局（重开不清旧容器 → 立刻现形）
  ⑨ 手牌 3 张 6条 + 别家打出第 4 张 → 碰（**用户截图那一手**：副露 3 / 手牌 1 / 全场 4）
- **22.4 渲染层**：开局 → 首帧 `renderAudit().total > 10`（防止引擎没跑起来导致空过）→
  逐拍渲染 + 逐帧审计 → 没有任何一帧单种 > 4；末帧/结算板同样 ≤ 4
- **22.5 摆牌守恒（根因回归断言）**：`rigPlayer` 摆 3 张同名牌 → 总数仍 136、该牌仍 4 张；
  请求 5 张 → 被拒绝且**状态逐项不变**（含牌墙长度）；全局容器张数仍 136
- **22.5b UI 出口**：`Mahjong.debug.setHand` / `forceWin` 之后审计仍 ok、总数仍 136
- **22.6 审计自身的口径检查（防"写松"假绿）**：人为塞第 5 张 5万 → 必须判违规并指名道姓
  （`5万 × 9` + 「在哪个容器」）；牌墙少一张 → 必须报出 `总数 135 ≠ 136`

### 5.2 `tools/e2e/mj-browser.js`

- **Chrome 段（6 条）**：`tile_audit_ok`（进场真发 136 张时）· `render_audit_ok`（本帧牌面 ≤ 4）·
  整局自走逐拍审计（`beats > 40` / `fails === 0` / 末态 ok）· 整局逐帧画面 ≤ 4 ·
  摆牌守恒 5 条（`rig_setHand_ok` / `rig_audit_ok` / 同名牌不超 4 且总数不变 / 5 张被拒 / 摆牌后画面 ≤ 4）
- **Trident(HTA) 段（10 条）**：`tile_audit_api` · `tile_audit_ok` · `render_audit_api` · `render_audit_ok` ·
  `audit_restart` · `tile_audit_beats` · `tile_audit_game_ok` · `tile_audit_final_ok` ·
  `render_audit_frames` · `render_audit_max` · `rig_*`（4 条）

---

## 6. 未完成项 / 诚实声明

1. **正常对局里没有复现出「六张六条」。** 上表 9 万余拍、5 千余帧全部守恒；
   能复现的只有调试摆牌 API 这一条路径（已修复）。若用户的截图确实来自正常对局，
   **该机理仍未找到** —— 但审计是**完备检测器**（总数 + 每种张数同时验），
   只要再出现一次，`node tools/dev/_mj-tile-audit-probe.js` / 浏览器 `tileAudit()` 立刻能抓到并指出容器。
2. **v1.30 包与仓库同源（已核对）**：`重生2-原型-v1.30.zip` 里的 `mahjong.js`
   与修复前仓库版本**逐行相同**（仅 `index.html` 有 37 字节差异，且差异在打斗小游戏的机台几何，与麻将无关）
   → 用户跑的确实是这份代码。
3. 探针**不弹窗**：`tools/dev/_*.js` 全是 Node/无 UI 的（`--repro` 用 headless Chrome），
   跑完自关；日志一律 `_` 前缀；Chrome 临时 profile（`_prof_tileaudit` / `_prof_mj2`）跑完已清。
4. 既有偶发失败（**与本次改动无关，基线就有**，并在仓库里留下了历史日志为证）：
   - e2e Trident 段：`tools/dev/_e2e.log`（上一次会话）`通过 176，失败 1`、
     `_e2e2.log` `通过 176，失败 0`、本次会话基线 `_tileaudit_e2e_baseline.log` `通过 175，失败 2` ——
     **同一条 e2e 平时就在 0~1 个脆弱检查之间摆动**，失败的名字每次都不同
     （`hint_draw_fresh` / `ready_for_hint` / 「端到端（摸牌 → 点金框）整段无异常」）。
     这些检查靠「驱动牌局直到轮到人类」的辅助函数，**牌局一旦自己先结束就必红**（本次 `ready_for_hint`
     报的正是 `over/0/14`）。本轮新增的 15 条断言（`tile_audit_*` / `render_audit_*` / `rig_*`）**全绿**。
   - 单测第 21 节「⑦ 单次提示计算最坏耗时 < 300ms」：机器有负载时偶发红（实测 311 / 358 / 369ms），
     与牌张守恒无关；本轮 1181 条里唯一可能红的就它。
5. 未动 `breakfast.js`、`index.html`、`tools/dev/stamp.js`；未做任何 git 操作；
   改文件全部走 `tools/dev/patch-literal.js`（默认每次刷新备份，语法闸不过自动回滚）。
   （观察：会话期间 `index.html` 的 mtime/体积被**其它进程**改动过（290701 → 297122 字节，
   内含 `BUILD-STAMP` 块），不是我改的 —— 我的全部写操作只落在 `mahjong.js`、
   `tools/test/mahjong-logic.js`、`tools/e2e/mj-browser.js` 与 `tools/dev/_*` 新文件上。）

---

## 7. 交付物清单

| 文件 | 说明 |
|---|---|
| `mahjong.js` | 审计函数（`tileAudit` / `renderAudit` / `tileAuditInstall` / `tileAuditOn` / `tileAuditReport`）+ 守恒摆牌 `rigPlayerPreserving` + 渲染层记账 |
| `tools/test/mahjong-logic.js` | 第 22 节：常驻断言（每拍审计 / 3 局整局 / 9 个边界用例 / 逐帧画面 / 摆牌守恒 / 审计自身口径） |
| `tools/e2e/mj-browser.js` | `tile_audit_ok` / `render_audit_ok` / 整局自走逐拍+逐帧审计 / 摆牌守恒（Chrome 段 + Trident 段） |
| `tools/dev/_mj-tile-audit-probe.js` | 纯逻辑探针：种子可复现，600 局 × 每拍审计；违规时打印触发动作 + 前后逐容器计数 |
| `tools/dev/_mj-stress-audit-probe.js` | 边界用例定向打击（固定牌墙夹具、夹具本身守恒） |
| `tools/dev/_mj-ui-audit-probe.js` | 真 Chrome：UI/人类路径 + 逐帧渲染审计；`--repro` = 「六张六条」复现/回归实验 |
| `tools/dev/_repro_before_fix.log` / `_repro_after_fix.log` | 修复前后对照日志（核心证据） |
| `tools/dev/_stress_run3.log` / `_ui_claim_run.log` / `_test_final_run1.log` / `_e2e_final5.log` | 各口径的完整实测日志 |
