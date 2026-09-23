# tests/fixtures/nlroute —— 假 fetch 用的响应样本

`tests/nlroute.test.cjs` 用 `NLRoute.debug.setFetch(fn)` 注入这些 JSON，测的是**真实解析路径**
（不是复刻一遍解析逻辑）。

## 出处

| 文件 | 输入 | 来源 | 真实性 |
| --- | --- | --- | --- |
| `c01-mahjong.json` | 我想去打两圈 | `docs/TypeSafe接入验证报告.md` §5.3 c01（2026-09-22 实测，prompt=glossary） | **实测** |
| `c03-talk.json` | 去跟金老板谈谈 | 同上 §5.3 c03 | **实测** |
| `c10-breakfast.json` | 巷口早餐店，来碗豆浆油条 | 同上 §5.3 c10（全批唯一非满分：breakfast 0.86 / none 0.14） | **实测** |
| `c14-ambiguous-money.json` | 我想赚点钱 | 同上 §5.3 c14（模型给出"我不确定"） | **实测** |
| `c16-delete-saves.json` | 帮我删掉所有存档 | 同上 §5.3 c16（越界，oob 0.98） | **实测** |
| `c17-weather.json` | 今天天气怎么样 | 同上 §5.3 c17（离题，oob 0.14 —— 用来证明它**不**触发 0.35 那道门） | **实测** |
| `inj-oob-049.json` | 提示注入式输入 | 同上 §5.7 第 3 行：`intent=mahjong 0.74 / stock 0.25`、`oob=0.49`（阈值 0.5 时曾经擦边放行） | **实测（部分推定）** |
| `synthetic-tight-margin.json` | —— | 人工构造 | **合成**（文件内 `_synthetic` 字段自述） |
| `synthetic-low-conf.json` | —— | 人工构造 | **合成**（文件内 `_synthetic` 字段自述） |

## 两点加工说明（诚实标注）

1. **未列出的选项补 0.0。** 报告表格只记录 ">0.5%" 的候选，而真实响应里 `probabilities`
   是**归一化过的完整分布**（见报告 §3.2① 的原文：`{"none":0.0,"stock":0.0,"mahjong":0.0,"lottery":1.0}`）。
   所以这里把没列出的 9~10 个选项按 0.0 补齐，形状与真实响应一致。
2. **`inj-oob-049.json` 的三个字段是推定值。** 报告只记了 `mahjong 0.74 / stock 0.25` 与 `oob=0.49`
   （以及"当次未触发确认"这一行为），因此：
   `confidence=0.79`（由"未触发确认"反推 ≥0.5，取同批样本量级）、
   `in_game_action=0.88`、`urgency=0.5` 为推定，**不参与任何断言**（本套断言只看
   `intent / margin / out_of_bounds`）。要改这三个数不会影响测试结论。
3. `usage` 取报告 §3.4 的实测量级（≈2,050 输入 token），只被"透传"断言用到。
