/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_tests.js — 本轮（bf-9）的测试改动作业单

   两类改动：
     ① 受新时长表影响的**旧断言**：把写死的秒数改成跟着 R.FOOD 走，
        这样以后再调平衡也不会连带弄坏一批无关用例；
     ② 本轮四条改动的**新断言**（部分上餐加耐心 / 上餐选人 / 下锅音效 / 素材齐全）。

   ⚠ 行尾：tests/breakfast.test.cjs 是 CRLF 为主、夹着少数 LF。
     所以这里按 LF 写锚点，落盘前**先试 CRLF 再试 LF**，哪种在原文里恰好出现 1 次用哪种
     （手写死 CRLF 会在那几行 LF 上翻车）。

   用法：
     node tools/bf/_patch/build_jobs_bf9_tests.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_tests.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tests/breakfast.test.cjs";
const jobs = [];
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function J(from, text) { jobs.push({ file: FILE, from, text }); }

/* ── ① 火候状态机：煎蛋的新数字（2.2 / 0.7 / 0.9，糊点 3.8）────────────── */
J(`test("火候状态机：煎蛋 3.0s / 完美窗口 0.8s / 1.0s 后糊 —— 两侧临界值都判对", () => {
  const F = R.FOOD.egg;
  assert.equal(F.dur, 3.0); assert.equal(F.pw, 0.8); assert.equal(F.burn, 1.0);
  assert.equal(R.burnAt("egg"), 4.8, "糊的临界 = 3.0+0.8+1.0");
  // 窗口左侧边界
  assert.equal(R.cookState("egg", 0), "raw");
  assert.equal(R.cookState("egg", 1.5), "raw", "半熟还是生的（不能出锅）");
  assert.equal(R.cookState("egg", 2.999), "raw", "差 1ms 到 3.0 仍是生");
  assert.equal(R.cookState("egg", 3.0), "perfect", "3.0 恰好进完美窗口");
  // 窗口内部 / 右侧边界
  assert.equal(R.cookState("egg", 3.4), "perfect", "窗口正中");
  assert.equal(R.cookState("egg", 3.799), "perfect", "差 1ms 到 3.8 仍是恰好");
  assert.equal(R.cookState("egg", 3.8), "over", "3.8 出窗口 → 过火（普通分，不糊）");
  assert.equal(R.cookState("egg", 4.799), "over", "差 1ms 到 4.8 仍可端");
  assert.equal(R.cookState("egg", 4.8), "burnt", "4.8 起就是糊");
  assert.equal(R.cookState("egg", 9.0), "burnt");
  // 其它食物的窗口各不相同
  assert.equal(R.cookState("congee", 5.0), "perfect", "白粥 5.0s 进窗口");
  assert.equal(R.cookState("congee", 6.2), "over", "白粥窗口 1.2s");
  assert.equal(R.burnAt("congee"), 7.8);
  assert.equal(R.cookState("milk", 2.6), "perfect");
  assert.equal(R.burnAt("milk"), 4.2);
  assert.equal(R.cookState("juice", 1.5), "perfect");
  assert.equal(R.cookState("nope", 1), "idle", "未知食物 → idle");
  assert.equal(R.cookState("egg", -5), "raw", "负数按 0 处理");
});`,
`test("火候状态机：煎蛋 2.2s / 完美窗口 0.7s / 0.9s 后糊 —— 两侧临界值都判对", () => {
  const F = R.FOOD.egg;
  assert.equal(F.dur, 2.2); assert.equal(F.pw, 0.7); assert.equal(F.burn, 0.9);
  assert.equal(R.burnAt("egg"), 3.8, "糊的临界 = 2.2+0.7+0.9");
  // 窗口左侧边界
  assert.equal(R.cookState("egg", 0), "raw");
  assert.equal(R.cookState("egg", 1.1), "raw", "半熟还是生的（不能出锅）");
  assert.equal(R.cookState("egg", 2.199), "raw", "差 1ms 到 2.2 仍是生");
  assert.equal(R.cookState("egg", 2.2), "perfect", "2.2 恰好进完美窗口");
  // 窗口内部 / 右侧边界
  assert.equal(R.cookState("egg", 2.5), "perfect", "窗口正中");
  assert.equal(R.cookState("egg", 2.899), "perfect", "差 1ms 到 2.9 仍是恰好");
  assert.equal(R.cookState("egg", 2.9), "over", "2.9 出窗口 → 过火（普通分，不糊）");
  assert.equal(R.cookState("egg", 3.799), "over", "差 1ms 到 3.8 仍可端");
  assert.equal(R.cookState("egg", 3.8), "burnt", "3.8 起就是糊");
  assert.equal(R.cookState("egg", 9.0), "burnt");
  // 其它食物的窗口各不相同（新表：白粥 3.4 / 热牛奶 2.0 / 果汁 1.2）
  assert.equal(R.cookState("congee", 3.4), "perfect", "白粥 3.4s 进窗口");
  assert.equal(R.cookState("congee", 4.4), "over", "白粥窗口 1.0s");
  assert.equal(R.burnAt("congee"), 5.6);
  assert.equal(R.cookState("milk", 2.0), "perfect");
  assert.equal(R.burnAt("milk"), 3.5);
  assert.equal(R.cookState("juice", 1.2), "perfect");
  assert.equal(R.cookState("nope", 1), "idle", "未知食物 → idle");
  assert.equal(R.cookState("egg", -5), "raw", "负数按 0 处理");
});

test("新时长表（bf-9）：9 样食材梯度重排 —— 白粥不再「煮太慢」，最长 ≤ 3.6s", () => {
  /* 用户实测原话：「白粥煮的太慢了」（旧值 5.0s）。这张表就是**契约**：
     时长 / 完美窗口 / 糊的宽限 / 糊点 四列都要对得上；
     「最长 ≤ 3.6s」是硬约束 —— 画面上 9 列能同时开工，但玩家的注意力只够盯 4~5 口锅，
     再长就退化成「点完就走 → 回来发现糊了」的纯惩罚。 */
  const WANT = [
    // 食材,       时长, 完美窗口, 糊的宽限, 糊点(= 时长+窗口+宽限)
    ["juice",    1.2, 0.6, 0.7, 2.5],
    ["salad",    1.5, 0.6, 0.8, 2.9],
    ["milk",     2.0, 0.7, 0.8, 3.5],
    ["egg",      2.2, 0.7, 0.9, 3.8],
    ["soup",     2.6, 0.8, 1.0, 4.4],
    ["bacon",    2.8, 0.8, 1.0, 4.6],
    ["bun",      3.0, 0.9, 1.1, 5.0],
    ["sandwich", 3.2, 0.9, 1.1, 5.2],
    ["congee",   3.4, 1.0, 1.2, 5.6]
  ];
  jsonEq(R.FOOD_IDS.slice().sort(), WANT.map(w => w[0]).sort(), "9 样食材一个不少");
  WANT.forEach(function (row) {
    const id = row[0], f = R.FOOD[id];
    assert.equal(f.dur, row[1], id + " 时长");
    assert.equal(f.pw, row[2], id + " 完美窗口");
    assert.equal(f.burn, row[3], id + " 糊的宽限");
    assert.equal(R.burnAt(id), row[4], id + " 糊点 = 时长 + 窗口 + 宽限");
    assert.equal(f.total, row[4], id + " total 字段与糊点一致（结算 / 面板读它）");
    assert.ok(f.dur <= 3.6, id + " 时长 " + f.dur + "s ≤ 3.6s（注意力上限，硬约束）");
    assert.ok(f.pw >= 0.6 && f.pw <= f.dur, id + " 完美窗口 " + f.pw + "s 在该食物的合理区间");
    assert.ok(f.burn >= 0.7 && f.burn <= 1.2, id + " 糊的宽限 " + f.burn + "s 落在 0.7~1.2s");
  });
  /* 白粥必须仍然是**最慢**的一样（保留「熬粥要等」的手感），但已经明显下来了 */
  const slowest = WANT.slice().sort((a, b) => b[1] - a[1])[0];
  assert.equal(slowest[0], "congee", "白粥还是最慢的那样");
  assert.equal(R.FOOD.congee.dur, 3.4, "白粥 5.0s → 3.4s（用户嫌慢的就是这一条）");
  /* 梯度要能被手感分辨：最快到最慢差 ≥ 2s，且相邻两档有可感知的间隔 */
  const durs = WANT.map(w => w[1]).sort((a, b) => a - b);
  assert.ok(durs[durs.length - 1] - durs[0] >= 2.0, "最快与最慢差 ≥ 2s：" + durs[0] + " → " + durs[durs.length - 1]);
  for (let i = 1; i < durs.length; i++)
    assert.ok(durs[i] - durs[i - 1] >= 0.2 - 1e-9, "相邻两档差 ≥ 0.2s：" + durs[i - 1] + " → " + durs[i]);
  assert.equal(new Set(durs).size, durs.length, "9 个时长互不相同（没有两样完全一样）");
});`);

/* ── ② 真实推进那条：跟着新表走（白粥 3.4 / 窗口 1.0 / 糊点 5.6）────────── */
J(`  advance(st, 5.1); assert.equal(st.stations[i].state, "perfect", "5.1s 后恰好");
  advance(st, 1.2); assert.equal(st.stations[i].state, "over", "再过 1.2s 过火（完美窗口 1.2s）");
  advance(st, 1.7); assert.equal(st.stations[i].state, "burnt", "再过 1.7s 糊（糊点 7.8s）");`,
`  advance(st, 3.5); assert.equal(st.stations[i].state, "perfect", "3.5s 后恰好（新表：白粥 3.4s 熟）");
  advance(st, 1.0); assert.equal(st.stations[i].state, "over", "再过 1.0s 过火（完美窗口 1.0s）");
  advance(st, 1.2); assert.equal(st.stations[i].state, "burnt", "再过 1.2s 糊（糊点 5.6s）");`);

/* ── ③ 把写死的秒数换成跟着 R.FOOD 走（以后再调平衡不会连带弄坏）─────────── */
J(`  const i0 = cookTo(st, "egg", 3.2);`,
  `  const i0 = cookTo(st, "egg", R.FOOD.egg.dur + 0.05);   // 刚进完美窗口（新表：煎蛋 2.2s 熟）`);

J(`  const i1 = plated(st, "egg", 3.0);              // 刚进完美窗口就落盘 → 热乎`,
  `  const i1 = plated(st, "egg", R.FOOD.egg.dur + 0.05);   // 刚进完美窗口就落盘 → 热乎`);

J(`  assert.equal(R.placeFood(st, "egg", null), true, "点一下食材 → 自动进它那一列");
  advance(st, 3.1);`,
`  assert.equal(R.placeFood(st, "egg", null), true, "点一下食材 → 自动进它那一列");
  advance(st, R.FOOD.egg.dur + 0.1);`);

J(`  const i3 = cookTo(st, "congee", 5.0);                 // 端一份白粥给只点了煎蛋的人`,
  `  const i3 = cookTo(st, "congee", R.FOOD.congee.dur);   // 端一份白粥给只点了煎蛋的人`);

J(`  const ib = plated(st, "egg", 3.0);
  const db = R.serveFromColumn(st, ib);`,
`  const ib = plated(st, "egg", R.FOOD.egg.dur + 0.05);
  const db = R.serveFromColumn(st, ib);`);

J(`  let i = plated(st, "egg", 3.0); deliverTo(st, i, c1);                            // 恰好 → 热乎`,
  `  let i = plated(st, "egg", R.FOOD.egg.dur + 0.05); deliverTo(st, i, c1);          // 恰好 → 热乎`);

J(`  i = plated(st, "egg", 3.0); deliverTo(st, i, c2);
  i = plated(st, "congee", 5.0); deliverTo(st, i, c2);`,
`  i = plated(st, "egg", R.FOOD.egg.dur + 0.05); deliverTo(st, i, c2);
  i = plated(st, "congee", R.FOOD.congee.dur + 0.05); deliverTo(st, i, c2);`);

J(`  const col = plated(st, "egg", 3.0);
  assert.equal(R.pickCustomerIndexFor(st, "egg"), st.customers.indexOf(hurried), "优先耐心最少的");`,
`  const col = plated(st, "egg", R.FOOD.egg.dur + 0.05);
  assert.equal(R.pickCustomerIndexFor(st, "egg"), st.customers.indexOf(hurried), "优先耐心最少的");`);

J(`  const col2 = plated(st, "egg", 3.0);
  const r2 = R.serveFromColumn(st, col2);`,
`  const col2 = plated(st, "egg", R.FOOD.egg.dur + 0.05);
  const r2 = R.serveFromColumn(st, col2);`);

J(`  const col = plated(st, "sandwich", 4.4);`,
  `  const col = plated(st, "sandwich", R.FOOD.sandwich.dur + 0.05);`);

J(`  const col = plated(st, "egg", 3.0);
  assert.equal(!!R.plateOfStation(st, col), true);`,
`  const col = plated(st, "egg", R.FOOD.egg.dur + 0.05);
  assert.equal(!!R.plateOfStation(st, col), true);`);

J(`  const col = plated(st, "salad", 1.8);`,
  `  const col = plated(st, "salad", R.FOOD.salad.dur + 0.05);`);

J(`  const col2 = plated(st2, "juice", 1.5);`,
  `  const col2 = plated(st2, "juice", R.FOOD.juice.dur + 0.05);`);

J(`    const col = plated(st, "milk", 2.6);`,
  `    const col = plated(st, "milk", R.FOOD.milk.dur + 0.05);`);

J(`  const col = plated(st, "congee", 5.0);
  const seq = [R.plateOfStation(st, col).tier];`,
`  const col = plated(st, "congee", R.FOOD.congee.dur + 0.05);
  const seq = [R.plateOfStation(st, col).tier];`);

J(`  const col = R.columnOf("bacon");                       // 3.6s 熟`,
  `  const col = R.columnOf("bacon");                       // 2.8s 熟（bf-9 新表）`);

J(`  assert.equal(R.placeFoodEx(st2, "bacon", null, { manual:true }).ok, true);
  advance(st2, 3.7);
  assert.equal(st2.plates.length, 0, "manual 不自动落盘");
  assert.equal(st2.stations[4].state, "perfect");
  advance(st2, 2.5);`,
`  assert.equal(R.placeFoodEx(st2, "bacon", null, { manual:true }).ok, true);
  advance(st2, R.FOOD.bacon.dur + 0.2);                  // 完美窗口内（2.8 + 0.7 = 3.5 出窗口）
  assert.equal(st2.plates.length, 0, "manual 不自动落盘");
  assert.equal(st2.stations[4].state, "perfect");
  advance(st2, 2.5);`);

J(`  const col = plated(st, "bun", 4.0);`,
  `  const col = plated(st, "bun", R.FOOD.bun.dur + 0.05);`);

/* ── ④ 「呜呼」六条变体（bf-9 重做）──────────────────────────────────── */
J(`test("音效②：拿到早餐 → 播「呜呼」（一次成功上餐只播一次，变体 3 选 1）", () => {`,
  `test("音效②：拿到早餐 → 播欢呼（一次成功上餐只播一次，变体 6 选 1 · bf-9 重做）", () => {`);

J(`  const h = played("happy");
  assert.equal(h.length, 1, "只播一次「呜呼」（不是每个分支都播一遍）");
  assert.ok(/^audio\\/bf\\/happy(2|3)?\\.mp3$/.test(h[0].url), "取的是 happy 变体之一：" + h[0].url);`,
`  const h = played("happy");
  assert.equal(h.length, 1, "只播一次欢呼（不是每个分支都播一遍）");
  assert.ok(/^audio\\/bf\\/happy_v[1-6]\\.mp3$/.test(h[0].url), "取的是 happy 六条变体之一：" + h[0].url);`);

J(`  jsonEq(R.audio.FILES.happy, ["happy.mp3", "happy2.mp3", "happy3.mp3"]);`,
`  /* bf-9：老的 happy/happy2/happy3 换成了 6 条**实测上扬**的新录音（用户嫌旧的不上扬） */
  jsonEq(R.audio.FILES.happy, ["happy_v1.mp3", "happy_v2.mp3", "happy_v3.mp3",
                               "happy_v4.mp3", "happy_v5.mp3", "happy_v6.mp3"]);
  assert.equal(R.audio.FILES.happy.length, 6, "6 条候选都进轮换池（用户挑定后再删）");
  R.audio.FILES.happy.forEach((f, i) => {
    assert.ok(fs.existsSync(path.join(ROOT, "audio", "bf", f)), "audio/bf/" + f + " 在盘上");
  });`);

/* ── ⑤ 本轮四条改动的新断言（插在最后那条素材盘点用例之前）────────────── */
const NEW_TESTS = `/* ═══════════════════════════════════════════════════════════════════════════
   10. bf-9：用户实测后的四条改动

     ① 白粥不再「煮太慢」→ 9 样食材的时长梯度重排（见前面「新时长表」那条）
     ② 顾客收到订单里的**某一样** → 耐心 +PARTIAL_PATIENCE_BONUS（上限 = 他的初始耐心）
     ③ 上餐优先「耐心值最低」的客人，而不是只能给第一位
     ④ 点食材下锅那一刻 → 按食材触发对应的烹饪音效（同食材 300ms 节流 / 同时最多 2 条）
   ═══════════════════════════════════════════════════════════════════════════ */

test("部分上餐②：收到订单里的某一样 → 耐心 +3.5s；上限是**他的初始耐心**", () => {
  assert.equal(R.PARTIAL_PATIENCE_BONUS, 3.5, "常量 PARTIAL_PATIENCE_BONUS = 3.5s");
  assert.ok(R.PARTIAL_PATIENCE_BONUS >= 3 && R.PARTIAL_PATIENCE_BONUS <= 4,
    "取值落在用户建议的 3~4s：" + R.PARTIAL_PATIENCE_BONUS);

  /* ① 三样订单，先给一样 → +3.5s（12 → 15.5） */
  const st = plateState();
  const c = R.spawnCustomer(st, ["egg", "congee", "juice"]);
  c.patienceMax = 30; c.patience = 12;
  const col = plated(st, "egg", R.FOOD.egg.dur + 0.05);
  const r = R.serveFromColumn(st, col);
  assert.equal(r.ok, true); assert.equal(r.kind, "perfect-hot", "完美 + 热乎");
  assert.equal(r.customer, c, "送给点这份的那位");
  assert.equal(c.done.indexOf("egg") >= 0, true, "这一样确实记到他头上");
  assert.equal(Math.round(c.patience * 10) / 10, 15.5, "12 + 3.5 = 15.5");
  assert.equal(r.partialBonus, 3.5, "出餐结果里带着「实际加了多少秒」");
  assert.equal(st.partialServes, 1, "记了一次「部分上餐」");
  assert.equal(st.partialBonus, 3.5, "本局累计回给顾客 3.5s 耐心");

  /* ② 再给一样 → 继续加（15.5 → 19），不会因为"已经加过"就停 */
  const col2 = plated(st, "congee", R.FOOD.congee.dur + 0.05);
  const r2 = R.serveFromColumn(st, col2);
  assert.equal(r2.customer, c);
  assert.equal(r2.partialBonus, 3.5, "第二样同样 +3.5");
  assert.equal(Math.round(c.patience * 10) / 10, 19, "15.5 + 3.5 = 19");
  assert.equal(st.partialServes, 2);

  /* ③ 上限：只剩 1s 余量 → 只加 1s，正好顶到初始耐心，且**上限本身没被改大** */
  const c2 = R.spawnCustomer(st, ["milk", "salad"]);
  c2.patienceMax = 30; c2.patience = 29;
  const m = plated(st, "milk", R.FOOD.milk.dur + 0.05);
  const rm = R.serveFromColumn(st, m);
  assert.equal(rm.customer, c2, "送给点牛奶的那位");
  assert.equal(rm.partialBonus, 1, "只剩 1s 余量 → 只加 1s（3.5s 被上限截断）");
  assert.equal(c2.patience, 30, "正好顶到初始耐心");
  assert.equal(c2.patienceMax, 30, "上限本身没被改大 —— 不能靠一次次上餐无限续命");

  /* ④ 31% 那一类边界：耐心只剩 31% 时收到一样 → 加完就脱离「滴答档」（≤30%） */
  const st2 = plateState();
  const c3 = R.spawnCustomer(st2, ["bacon", "soup"]);
  c3.patienceMax = 100; c3.patience = 31;
  assert.equal(R.audio.patienceRatioOf(c3), 0.31, "先确认在 31%（>30% 不滴答）");
  const b = plated(st2, "bacon", R.FOOD.bacon.dur + 0.05);
  const rb = R.serveFromColumn(st2, b);
  assert.equal(rb.partialBonus, 3.5);
  assert.equal(c3.patience, 34.5, "31 + 3.5 = 34.5");
  assert.ok(R.audio.patienceRatioOf(c3) > R.audio.TICK_AT, "回到 30% 以上 → 不再滴答（耐心是真的回血了）");
});

test("部分上餐②：上错菜 / 糊菜 / 已经拿齐 —— 一律不加耐心（不乱发奖励）", () => {
  /* ① 上错菜：端一份他没点的东西 → −5，耐心不动 */
  let st = plateState();
  const cw = R.spawnCustomer(st, ["egg", "juice"]);
  cw.patienceMax = 30; cw.patience = 12;
  const colC = plated(st, "congee", R.FOOD.congee.dur + 0.05);
  const rw = R.serveCustomer(st, ci(st, cw), R.plateIdxOfStation(st, colC));
  assert.equal(rw.kind, "wrong"); assert.equal(st.wrong, 1, "记了一次上错菜");
  assert.equal(cw.patience, 12, "上错菜不加耐心（乱上菜没有奖励）");
  assert.equal(st.partialServes || 0, 0, "也不算一次「部分上餐」");
  assert.equal(rw.partialBonus, undefined, "上错菜的结果里根本没有 partialBonus 字段");

  /* ② 糊菜端上桌：顾客当场走（−5），更不该加 */
  st = plateState();
  const cb = R.spawnCustomer(st, ["egg", "juice"]);
  cb.patienceMax = 30; cb.patience = 12;
  const colB = cookWalk(st, "egg", "burnt");
  assert.equal(R.takePlate(st, colB), true, "糊的也能落到盘上");
  const rb = R.serveCustomer(st, ci(st, cb), R.plateIdxOfStation(st, colB));
  assert.equal(rb.kind, "burnt");
  assert.equal(cb.patience, 12, "糊菜不加耐心（他是被气走的）");
  assert.equal(st.partialServes || 0, 0);

  /* ③ 拿齐了：不给（他马上要离场，加了也白加），耐心保持原样 */
  st = plateState();
  const c1 = R.spawnCustomer(st, ["egg"]);
  c1.patienceMax = 30; c1.patience = 12;
  const e1 = plated(st, "egg", R.FOOD.egg.dur + 0.05);
  const r1 = R.serveFromColumn(st, e1);
  assert.equal(r1.partialBonus, 0, "这一样拿齐了 → 没有部分加成");
  assert.equal(c1.patience, 12, "耐心保持原样（这一单已经完成，他立刻离场）");
  assert.equal(st.served, 1, "整单完成，服务计数 +1");
  assert.equal(st.partialServes || 0, 0, "「拿齐」不算部分上餐");
});

test("上餐选人③：3 位都要同一份、耐心 5 / 20 / 40 → 必定送给耐心 5 那位", () => {
  const st = plateState();
  const a = R.spawnCustomer(st, ["egg", "congee"]);      // 先来的
  const b = R.spawnCustomer(st, ["egg", "salad"]);
  const c3 = R.spawnCustomer(st, ["egg", "juice"]);      // 最后来的
  a.patienceMax = 60; a.patience = 40;
  b.patienceMax = 60; b.patience = 20;
  c3.patienceMax = 60; c3.patience = 5;
  const col = plated(st, "egg", R.FOOD.egg.dur + 0.05);

  assert.equal(R.pickServeTarget(st, "egg"), ci(st, c3), "规则层直接挑中耐心 5 的那位");
  assert.equal(R.pickCustomerIndexFor(st, "egg"), ci(st, c3), "旧名字（兼容层）是同一条规则");
  const r = R.serveFromColumn(st, col);
  assert.equal(r.ok, true);
  assert.equal(r.customer, c3, "煎蛋落在耐心 5 那位头上");
  assert.equal(c3.done.indexOf("egg") >= 0, true);
  assert.equal(a.done.indexOf("egg") >= 0, false, "先来的那位没被越位送");
  assert.equal(b.done.indexOf("egg") >= 0, false, "耐心 20 那位也没被越位");
  assert.equal(Math.round(c3.patience * 10) / 10, 8.5, "他还缺 juice → 收到一样后 +3.5s（5 → 8.5）");
  assert.equal(a.patience, 40); assert.equal(b.patience, 20, "别人的耐心不受影响");

  /* 他只剩 juice：再做一份，仍然优先给他（最急）→ 整单完成 */
  const col2 = plated(st, "juice", R.FOOD.juice.dur + 0.05);
  assert.equal(R.pickServeTarget(st, "juice"), ci(st, c3), "最急的那位继续优先");
  const r2 = R.serveFromColumn(st, col2);
  assert.equal(r2.customer, c3);
  assert.equal(st.served, 1, "整单完成");
  assert.equal(c3.left, true, "拿齐后让出座位");
  assert.equal(R.activeCustomers(st).length, 2, "另外两位还在等");

  /* 煎蛋只剩 a / b 要 → 挑耐心更少的 b（20 < 40） */
  const col3 = plated(st, "egg", R.FOOD.egg.dur + 0.05);
  assert.equal(R.pickServeTarget(st, "egg"), ci(st, b), "剩下的候选里挑耐心更少的");
  assert.equal(R.serveFromColumn(st, col3).customer, b, "真的送给了 b");
});

test("上餐选人③：不再「只能给第一位」—— 进度条最短的先得；快走的（≤6s）越过比例优先", () => {
  /* 【排查结论】改前 pickCustomerIndexFor 比的是**绝对秒数**最小。所有顾客的耐心都按
     1 秒/秒 掉，先来的人天然秒数最少 → 手感上就等于「只给第一位」。
     而玩家在卡上看到的进度条 / 闪红 / 滴答 / 着急脸，用的都是**比例**。
     两个量不是一回事，于是出现「明明第二位更急，却总是给第一位」。 */
  /* ① 第一位绝对秒数更少，但第二位进度条更短 → 新的规则给第二位 */
  let st = plateState();
  const first = R.spawnCustomer(st, ["egg", "congee"]);            // 先来：订单短 → 上限低
  const later = R.spawnCustomer(st, ["egg", "bacon", "juice"]);    // 后来：订单长 → 上限高
  first.patienceMax = 17.5; first.patience = 8;                    // 进度条 46%
  later.patienceMax = 32.5; later.patience = 9;                    // 进度条 28%
  assert.ok(first.patience < later.patience,
    "第一位绝对秒数更少（" + first.patience + " < " + later.patience + "）→ 只比秒数的旧规则必然给他");
  assert.ok(R.audio.patienceRatioOf(later) < R.audio.patienceRatioOf(first),
    "但第二位的进度条更短（" + R.audio.patienceRatioOf(later) + " < " + R.audio.patienceRatioOf(first) + "）");
  assert.ok(first.patience > R.SERVE_DANGER_SEC && later.patience > R.SERVE_DANGER_SEC,
    "两位都还没进「救命档」（都 > 6s），所以这里比的就是进度条");
  assert.equal(R.pickServeTarget(st, "egg"), ci(st, later), "新规则给进度条最短的那位，不是第一位");

  /* ② 救命档：有人只剩 ≤6s（真的要走了）→ 越过比例，先救他 */
  st = plateState();
  const urgent = R.spawnCustomer(st, ["egg", "juice"]);
  const relaxed = R.spawnCustomer(st, ["egg", "congee", "bacon"]);
  urgent.patienceMax = 30; urgent.patience = 5.5;      // 18.3% · 5.5s 后就走 → 救命档
  relaxed.patienceMax = 50; relaxed.patience = 7;      // 14% · 进度条更短，但还有 7s
  assert.ok(R.audio.patienceRatioOf(relaxed) < R.audio.patienceRatioOf(urgent),
    "「看着更急」的其实是第二位（进度条更短）");
  assert.ok(urgent.patience <= R.SERVE_DANGER_SEC, "第一位才是真会走的那位（≤ " + R.SERVE_DANGER_SEC + "s）");
  assert.equal(R.pickServeTarget(st, "egg"), ci(st, urgent),
    "救命档越过比例：先救「真会走」的那位（不然白丢 −8）");

  /* ③ 完全平手 → 座位序（先来的先得） */
  st = plateState();
  const s1 = R.spawnCustomer(st, ["egg", "juice"]);
  const s2 = R.spawnCustomer(st, ["egg", "congee"]);
  s1.patienceMax = 30; s1.patience = 12;
  s2.patienceMax = 30; s2.patience = 12;
  assert.equal(R.pickServeTarget(st, "egg"), ci(st, s1), "平手取先来的（座位序）");

  /* ④ 候选集：只要「订单里有这一样 ∧ 还没拿到 ∧ 没走」*/
  jsonEq(R.serveCandidates(st, "egg"), [ci(st, s1), ci(st, s2)], "候选集按座位序");
  jsonEq(R.serveCandidates(st, "salad"), [], "没人要的食材 → 空候选集");
  assert.equal(R.pickServeTarget(st, "salad"), -1, "没人要 → -1（单击盘时就是 no-want）");
  s1.done.push("egg");
  jsonEq(R.serveCandidates(st, "egg"), [ci(st, s2)], "已经拿到这一样的顾客不再进候选集");
  s1.done.pop();
  s1.left = true;
  jsonEq(R.serveCandidates(st, "egg"), [ci(st, s2)], "走了的顾客不再进候选集");
});

test("下锅音效④：9 样食材各有各的文件，点哪样响哪样（映射逐条对）", () => {
  /* 用户原话：「点做果汁的时候可以触发榨果汁的音效，点煎蛋的时候可以触发煎蛋的音效」*/
  const WANT = {
    congee: "cook_congee.mp3", milk: "cook_milk.mp3", soup: "cook_soup.mp3", egg: "cook_egg.mp3",
    bacon: "cook_bacon.mp3", sandwich: "cook_sandwich.mp3", bun: "cook_bun.mp3",
    salad: "cook_salad.mp3", juice: "cook_juice.mp3"
  };
  jsonEq(R.audio.COOK_FILES, WANT, "食材 → 文件 一对一（9 样全都有，一个不缺）");
  assert.equal(new Set(Object.keys(WANT).map(k => WANT[k])).size, 9, "9 个文件互不相同（每样有自己的声音）");
  R.FOOD_IDS.forEach(f => {
    assert.equal(R.audio.cookChannel(f), "cook_" + f, f + " 的通道名 = cook_<食材id>");
    jsonEq(R.audio.FILES["cook_" + f], [WANT[f]], f + " 的通道挂进了同一张素材表（开关 / 回落 / 台账全复用）");
    assert.equal(R.audio.url("cook_" + f, 0), "audio/bf/" + WANT[f], f + " 拼出来的 URL 对得上");
    assert.ok(R.audio.VOL["cook_" + f] > 0.3 && R.audio.VOL["cook_" + f] <= 0.6,
      f + " 音量落在 0.3~0.6：" + R.audio.VOL["cook_" + f]);
    assert.ok(R.audio.NAMES.indexOf("cook_" + f) >= 0, f + " 的通道登记在 NAMES 里（盘点脚本读它）");
  });

  /* 真的点一下：每样单独开一局点一次 → 恰好响它自己那一条 */
  R.FOOD_IDS.forEach(f => {
    audioArmed();
    const st = plateState();
    assert.equal(R.placeFood(st, f, null), true, "点 " + f + " → 进它自己那一列");
    const got = PLAYS.filter(p => p.name === "cook_" + f);
    assert.equal(got.length, 1, f + " 下锅响了一条");
    assert.equal(got[0].url, "audio/bf/" + WANT[f], f + " 响的是它自己的文件：" + got[0].url);
    assert.equal(PLAYS.length, 1, f + " 只响这一条（不是顺手响一堆）");
    audioUnhook();
  });

  /* 触发点是「下锅那一刻」：被拒的时候不响，出锅 / 上餐 / 丢垃圾桶也都不响 */
  audioArmed();
  const st = plateState();
  assert.equal(R.placeFood(st, "egg", null), true);
  assert.equal(played("cook_egg").length, 1, "第一次下锅 → 响");
  assert.equal(R.placeFoodEx(st, "egg", null).ok, false, "锅还忙着（station-occupied）");
  assert.equal(played("cook_egg").length, 1, "被拒的那次不响");
  assert.equal(R.placeFoodEx(st, "egg", 1).why, "wrong-column", "拖到别人的锅被拒");
  assert.equal(played("cook_egg").length, 1, "拖错列也不响");
  R.trashColumn(st, 3);
  assert.equal(played("cook_egg").length, 1, "丢垃圾桶不响");
  assert.equal(R.placeFood(st, "egg", null), true);
  advance(st, 2.6);                                   // 熟了自动落盘
  assert.equal(R.plateOfStation(st, 3).food, "egg", "确实落盘了");
  assert.equal(played("cook_egg").length, 1, "出锅 / 落盘不响（只在下锅那一刻响）");
  const c = longPatience(R.spawnCustomer(st, ["egg"]));
  assert.equal(R.serveFromColumn(st, 3).ok, true, "上餐成功");
  assert.equal(played("cook_egg").length, 1, "上餐不响");
  assert.equal(played("happy").length, 1, "该响的是「欢呼」，不是下锅音效");
  audioUnhook();
});

test("下锅音效④：同一食材 300ms 内只响一次；不同食材可叠，但同时最多 2 条", () => {
  assert.equal(R.audio.COOK_MIN_GAP, 0.3, "同食材节流 300ms（常量可调）");
  assert.equal(R.audio.COOK_MAX_CONCURRENT, 2, "同时最多 2 条（再快也不糊成一片噪音）");

  /* ① 同一样连点：300ms 内只响一次，被节流的那次留一条 why:"throttle" 记录 */
  audioArmed();
  const st = plateState();
  assert.equal(R.placeFood(st, "juice", null), true);
  assert.equal(played("cook_juice").length, 1, "第一下响");
  R.trashColumn(st, 8);                               // 清空这一列，马上再点
  advance(st, 0.1);                                   // 只过了 100ms
  assert.equal(R.placeFood(st, "juice", null), true, "100ms 后又点了一次（放得下）");
  assert.equal(played("cook_juice").length, 1, "100ms 内连点同一样 → 不叠第二声");
  assert.equal(R.audio.log().filter(r => r.why === "throttle").length, 1,
    "被节流的那次留了记录（否则「静默丢掉」跟素材缺失长得一样，没法排查）");
  assert.equal(R.audio.plays().length, 1, "被节流的不算「播成功」");
  R.trashColumn(st, 8);
  advance(st, 0.25);                                  // 累计 350ms > 300ms
  assert.equal(R.placeFood(st, "juice", null), true);
  assert.equal(played("cook_juice").length, 2, "过了 300ms → 可以再响（不是「一局只响一次」）");

  /* ② 不同食材：可以叠，但同时最多 2 条 */
  audioArmed();
  const st2 = plateState();
  R.placeFood(st2, "egg", null);
  R.placeFood(st2, "bacon", null);
  R.placeFood(st2, "juice", null);
  R.placeFood(st2, "salad", null);
  assert.equal(played("cook_egg").length, 1, "第 1 条响");
  assert.equal(played("cook_bacon").length, 1, "第 2 条响（不同食材可以叠）");
  assert.equal(played("cook_juice").length, 0, "第 3 条被并发上限挡住");
  assert.equal(played("cook_salad").length, 0, "第 4 条同样被挡住");
  assert.equal(R.audio.log().filter(r => r.why === "busy").length, 2, "两次都留了 busy 记录");
  assert.equal(PLAYS.length, 2, "同一时刻最多 2 条下锅音效");
  advance(st2, R.audio.COOK_TAIL_SEC + 0.05);         // 前两条播完 → 腾出额度
  assert.equal(R.placeFood(st2, "bacon", null), false, "培根列还占着（这一列没清）");
  R.trashColumn(st2, 4);
  assert.equal(R.placeFood(st2, "bacon", null), true);
  assert.equal(played("cook_bacon").length, 2, "腾出额度后可以再响");
  audioUnhook();
});

test("下锅音效④：开关关掉一条都不播（全标 off）；钩子抛错也不冒泡", () => {
  audioMuted();
  const st = plateState();
  /* 一样一样地点、中间留足时间 → 不触发节流 / 并发，读到的 why 才是干净的 off */
  R.FOOD_IDS.forEach((f, i) => {
    assert.equal(R.placeFood(st, f, null), true, "点 " + f);
    if (i < R.FOOD_IDS.length - 1) advance(st, R.audio.COOK_TAIL_SEC + 0.1);
  });
  assert.equal(PLAYS.length, 0, "9 样全下锅，钩子一次都没被调用（全静音）");
  assert.equal(R.audio.plays().length, 0, "plays() 也是空");
  const log = R.audio.log().filter(r => /^cook_/.test(r.name));
  assert.equal(log.length, 9, "9 次下锅 9 条记录（可诊断）：" + log.length);
  assert.equal(log.every(r => r.ok === false && r.why === "off"), true,
    "全是 off：" + JSON.stringify(log.map(r => r.why)));
  assert.equal(log.map(r => r.name).join(","),
    R.FOOD_IDS.map(f => "cook_" + f).join(","), "9 条记录的通道与食材一一对应");

  /* 钩子抛错（模拟文件坏 / 被自动播放策略拦）→ 玩法照常，记录标掉 */
  R.audio.hook(function () { throw new Error("blocked by policy"); });
  R.audio.setEnabled(true); R.audio.clear();
  const st2 = plateState();
  assert.doesNotThrow(() => R.placeFood(st2, "juice", null), "钩子抛错时下锅也不冒泡");
  assert.ok(R.audio.log().some(r => r.why === "sink-error"), "记录里能看到 sink-error");
  assert.equal(R.audio.plays().every(r => r.ok === false), true, "抛错的记录不冒充成功");
  audioUnhook();
});

test("下锅音效④：没有 Audio / 素材缺失的环境（纯逻辑 vm）也静默，玩法不受影响", () => {
  R.audio.hook(null); R.audio.setEnabled(true); R.audio.clear(); PLAYS.length = 0;
  const st = plateState();
  assert.doesNotThrow(() => R.placeFood(st, "juice", null), "没有 Audio 时不抛错");
  assert.doesNotThrow(() => R.placeFood(st, "egg", null));
  const log = R.audio.log().filter(r => /^cook_/.test(r.name));
  assert.ok(log.length >= 2, "两次下锅都留了记录");
  assert.equal(log.every(r => r.ok === false && r.why === "no-audio"), true,
    "全记 no-audio：" + JSON.stringify(log.map(r => r.why)));
  assert.equal(R.audio.plays().length, 0, "没有「播成功」的记录");
  /* 玩法账照记：下料 / 落盘 / 出餐一条都不少 */
  advance(st, R.FOOD.juice.dur + 0.1);
  assert.equal(R.plateOfStation(st, 8).food, "juice", "果汁照样熟了落盘");
  assert.equal(st.made, 2, "两次下料都记在账上");
});

`;

J(`test("音效：audio/bf 五个素材在磁盘上齐全，且规格统一（tick ≤120ms / 48kHz / 单声道）", () => {`,
  NEW_TESTS + `test("音效：audio/bf 素材在磁盘上齐全，且规格统一（tick ≤120ms / 48kHz / 单声道）", () => {`);

/* ── ⑥ 素材盘点：把新增的 6 条欢呼 + 9 条下锅音效一起盘 ────────────────── */
J(`  const dir = path.join(ROOT, "audio", "bf");
  const want = ["tick.mp3", "happy.mp3", "happy2.mp3", "happy3.mp3", "slow.mp3"];
  want.forEach(f => {
    const p = path.join(dir, f);
    assert.ok(fs.existsSync(p), "audio/bf/" + f + " 存在");
    assert.ok(fs.statSync(p).size > 600, "audio/bf/" + f + " 非空（" + fs.statSync(p).size + " B）");
    const info = mp3info.mp3Info(p);
    assert.equal(info.sampleRate, 48000, f + " 是 48kHz（与 audio/ 其它素材一致）");
    assert.equal(info.channels, 1, f + " 是单声道");
    assert.ok(info.bitrate >= 96000 && info.bitrate <= 192000, f + " 码率 " + info.bitrate / 1000 + "kbps");
  });`,
`  const dir = path.join(ROOT, "audio", "bf");
  /* bf-9：欢呼换成 6 条新录音、下锅音效新增 9 条 —— 全部纳入规格盘点 */
  const want = ["tick.mp3", "slow.mp3",
                "happy_v1.mp3", "happy_v2.mp3", "happy_v3.mp3",
                "happy_v4.mp3", "happy_v5.mp3", "happy_v6.mp3",
                "cook_congee.mp3", "cook_milk.mp3", "cook_soup.mp3", "cook_egg.mp3",
                "cook_bacon.mp3", "cook_sandwich.mp3", "cook_bun.mp3",
                "cook_salad.mp3", "cook_juice.mp3"];
  want.forEach(f => {
    const p = path.join(dir, f);
    assert.ok(fs.existsSync(p), "audio/bf/" + f + " 存在");
    assert.ok(fs.statSync(p).size > 600, "audio/bf/" + f + " 非空（" + fs.statSync(p).size + " B）");
    const info = mp3info.mp3Info(p);
    assert.equal(info.sampleRate, 48000, f + " 是 48kHz（与 audio/ 其它素材一致）");
    assert.equal(info.channels, 1, f + " 是单声道");
    assert.ok(info.bitrate >= 96000 && info.bitrate <= 192000, f + " 码率 " + info.bitrate / 1000 + "kbps");
  });
  /* 代码里点名要播的每一条都必须真的在盘上 —— 否则就是「静默 404」，断言层面看不出来 */
  R.audio.NAMES.forEach(n => {
    assert.ok(R.audio.FILES[n] && R.audio.FILES[n].length, n + " 通道有素材清单");
    R.audio.FILES[n].forEach(f => {
      assert.ok(fs.existsSync(path.join(dir, f)), "通道 " + n + " 点名的 audio/bf/" + f + " 在盘上");
    });
  });
  /* 对照件（B 组）留在盘上、但**不在**任何通道里（不参与轮换） */
  ["happy_alt1.mp3", "happy_alt2.mp3", "happy_alt3.mp3",
   "happy_alt4.mp3", "happy_alt5.mp3", "happy_alt6.mp3"].forEach(f => {
    assert.ok(fs.existsSync(path.join(dir, f)), "对照件 audio/bf/" + f + " 还在（试听页要用）");
    assert.equal(R.audio.NAMES.some(n => R.audio.FILES[n].indexOf(f) >= 0), false,
      f + " 不参与轮换（只在试听页里出现）");
  });
  /* 下锅音效是「短促的一声」：0.2s < 时长 ≤ 0.8s（太长会盖住下一声） */
  Object.keys(R.audio.COOK_FILES).forEach(f => {
    const info = mp3info.mp3Info(path.join(dir, R.audio.COOK_FILES[f]));
    assert.ok(info.decoded > 0.2 && info.decoded <= 0.8,
      R.audio.COOK_FILES[f] + " 解码时长 " + (info.decoded * 1000).toFixed(0) + "ms（0.2~0.8s）");
  });`);

J(`  /* 三条语音都要有人声时长（>0.4s），不是空文件 */
  ["happy.mp3", "happy2.mp3", "happy3.mp3", "slow.mp3"].forEach(f => {
    const info = mp3info.mp3Info(path.join(dir, f));
    assert.ok(info.decoded > 0.4, f + " 时长 " + (info.decoded * 1000).toFixed(0) + "ms，像一条语音");
  });`,
`  /* 六条欢呼 + 一条「太慢了」都要有人声时长（>0.4s），不是空文件 */
  ["happy_v1.mp3", "happy_v2.mp3", "happy_v3.mp3", "happy_v4.mp3", "happy_v5.mp3",
   "happy_v6.mp3", "slow.mp3"].forEach(f => {
    const info = mp3info.mp3Info(path.join(dir, f));
    assert.ok(info.decoded > 0.4, f + " 时长 " + (info.decoded * 1000).toFixed(0) + "ms，像一条语音");
  });
  /* 欢呼不能太长（一边上餐一边还在喊会叠声）：6 条都 ≤ 3s */
  R.audio.FILES.happy.forEach(f => {
    const info = mp3info.mp3Info(path.join(dir, f));
    assert.ok(info.decoded <= 3.0, f + " 时长 " + info.decoded.toFixed(2) + "s ≤ 3s");
  });`);

/* ── 落盘：锚点的行尾在原文里可能是 CRLF 也可能是 LF，逐个试 ─────────────── */
const src = fs.readFileSync(path.join(OUT, FILE), "utf8");
jobs.forEach((job, i) => {
  if (countOcc(src, job.from) === 1) return;
  const lf = job.from, lfText = job.text;
  const c = crlf(lf), ct = crlf(lfText);
  if (countOcc(src, c) === 1) { job.from = c; job.text = ct; return; }
  console.error("✗ job#" + (i + 1) + " 锚点在原文里出现 " + countOcc(src, lf) + " 次（CRLF 版 " +
    countOcc(src, c) + " 次）");
  console.error("  锚首 80 字：" + JSON.stringify(lf.slice(0, 80)));
  process.exit(1);
});

fs.writeFileSync(path.join(__dirname, "jobs_bf9_tests.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_tests.json：" + jobs.length + " 个 job（锚点行尾已逐个核对）");
