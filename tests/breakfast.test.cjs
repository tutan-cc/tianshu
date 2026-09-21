/* ═══════════════════════════════════════════════════════════════════════════
   纯逻辑单测：早餐店 · 拼手速（vm 注入 breakfast.js，含最小 window）
   运行：node --test tests/breakfast.test.cjs
         沙箱禁止 node --test 起子进程时，`node tests/breakfast.test.cjs` 跑同一批用例
   覆盖：火候状态机边界 / 顾客与订单生成（难度曲线 / 最多 3 位）/
         计分（完美 / 普通 / 上错 / 糊菜上桌 / 顾客离开）/
         过关判定（服务满 goal / 超时失败）/ 好感结算（+6~+10 / −3~−6、每日一次、区间置灰）
   ═══════════════════════════════════════════════════════════════════════════ */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "breakfast.js"), "utf8");

/** 注入：只要 window 是对象即可（rules 层完全不碰 DOM；start() 未调用） */
function loadBf() {
  const ctx = vm.createContext({ console, Math, Date, isFinite, Number, String, Object, Array });
  ctx.window = ctx;
  vm.runInContext(SRC + "\n;globalThis.__BF = window.Breakfast;", ctx);
  return ctx.__BF;
}
const BF = loadBf();
const R = BF.rules;

function mkState(cfg) { return R.newState(Object.assign({ duration: 75, goal: 8 }, cfg || {})); }
/** 只看「锅里火候」的小局：关掉自动落盘（食物留在锅里，方便断言 生→恰好→过火→糊） */
function wokState(cfg) { const st = R.newState(Object.assign({ duration: 12, goal: 99, autoPlate:false }, cfg || {})); st.running = true; return st; }
/** 走完整新规则的小局：9 列各 1 专属盘、熟了自动落盘、盘上停留超过 SERVE_WINDOW 就糊。
    nextIn 拉大 → 不自动进店，只有测试自己 spawn 的顾客在场。 */
function plateState(cfg) { const st = R.newState(Object.assign({ duration: 999, goal: 99, autoPlate:true }, cfg || {})); st.running = true; st.nextIn = 1e6; return st; }
/** 让测试自己 spawn 的顾客拥有长耐心，不受本小局时长限制影响 */
function longPatience(c) { c.patience = c.patienceMax = 600; return c; }
/** 推进 n 秒（1/60 步长；step 内部有 0.5s 卡帧保护） */
function advance(st, seconds) {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n && !st.over; i++) R.step(st, 1 / 60);
  return st;
}
/** 把某样食物放到「它自己那一列」的锅里，并把火候定到指定秒数（不额外推进时间）。
    默认 manual（按住看火）→ 食物留在锅里，方便断言火候；传 manual=false 则交给自动落盘。 */
function cookTo(st, foodId, sec, manual) {
  const c = R.columnOf(foodId);
  assert.ok(c >= 0, foodId + " 有自己那一列");
  const r = R.placeFoodEx(st, foodId, c, (manual === false) ? null : { manual:true });
  assert.equal(r.ok, true, "下料 " + foodId + " → 第 " + c + " 列（why=" + r.why + "）");
  st.stations[c].t = sec * 1000;
  st.stations[c].state = R.cookState(foodId, sec);
  if (st.stations[c].state === "perfect") st.stations[c].doneAt = st.elapsed;
  return c;
}
/** 让某样食物「熟了并落到本列专属盘」，返回列下标（完美 / 过火都算熟） */
function plated(st, foodId, sec) {
  const c = cookTo(st, foodId, sec === undefined ? R.FOOD[foodId].dur : sec, true);
  const s2 = st.stations[c].state;
  assert.ok(s2 === "perfect" || s2 === "over", foodId + " 熟了（" + s2 + "）");
  assert.equal(R.takePlate(st, c), true, foodId + " 落到第 " + c + " 列的专属盘");
  return c;
}
/** 用真实帧推进把食物煮到目标火候（perfect / burnt 的副作用都会记账）。
    默认用 manual 按住看火：食物留在锅里，所以 恰好 → 过火 → 糊 一路走得完。 */
function cookWalk(st, foodId, targetState, stationIdx) {
  const c = (stationIdx === undefined || stationIdx === null) ? R.columnOf(foodId) : stationIdx;
  const r = R.placeFoodEx(st, foodId, c, { manual:true });
  assert.equal(r.ok, true, "有空锅可放 " + foodId + "（why=" + r.why + "）");
  const maxFrames = 60 * (R.burnAt(foodId) + 1) + 240;
  for (let i = 0; i < maxFrames; i++) {
    if (st.stations[c].state === targetState) return c;
    R.step(st, 1 / 60);
  }
  assert.equal(st.stations[c].state, targetState, "没走到目标火候 " + targetState);
  return c;
}
/** vm 里造的对象与测试进程的对象原型不同，deepStrictEqual 会误判 → 用 JSON 比结构 */
function jsonEq(actual, expected, msg) { assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg); }
/** 顾客对象来自 vm realm，跨 realm 的 indexOf 会失效 → 按 id 找下标 */
function ci(st, c) { for (let i = 0; i < st.customers.length; i++) if (st.customers[i].id === c.id) return i; return -1; }
/** 把某一列做好的这份端给顾客 c：还没落盘就先落盘，然后按「这一列的盘」出餐 */
function deliverTo(st, i, c) {
  if (!R.plateOfStation(st, i)) R.takePlate(st, i);
  return R.serveCustomer(st, ci(st, c), R.plateIdxOfStation(st, i));
}
/** 给当前第一位顾客做他要的下一道菜，熟了落到本列盘上再端上去（返回 serve 结果，做不了返回 null） */
function autoServe(st) {
  const list = R.activeCustomers(st);
  if (!list.length) return null;
  const c0 = list[0];
  let want = null;
  for (let i = 0; i < c0.order.length; i++) if (c0.done.indexOf(c0.order[i]) < 0) { want = c0.order[i]; break; }
  if (!want) return null;
  const col = R.columnOf(want);
  if (!R.stationFree(st, col)) return null;
  if (!R.placeFood(st, want, col)) return null;
  let k = 0;
  while (!R.plateOfStation(st, col) && k++ < 1200 && !st.over) R.step(st, 1 / 60);
  if (st.over || !R.plateOfStation(st, col)) { R.trashStation(st, col); return null; }
  return R.serveFromColumn(st, col);          // 单击盘 → 自动送给正在等的顾客
}

/* ══════════════ 1. 火候状态机 ══════════════ */

test("火候状态机：煎蛋 2.2s / 完美窗口 0.7s / 0.9s 后糊 —— 两侧临界值都判对", () => {
  const F = R.FOOD.egg;
  assert.equal(F.dur, 2.2); assert.equal(F.pw, 0.7); assert.equal(F.burn, 0.9);
  assert.equal(R.burnAt("egg"), 3.8, "糊的临界 = 2.2+0.7+0.9");
  // 窗口左侧边界
  assert.equal(R.cookState("egg", 0), "raw");
  assert.equal(R.cookState("egg", 1.1), "raw", "半熟还是生的（不能出锅）");
  assert.equal(R.cookState("egg", 2.199), "raw", "差 1ms 到 2.2 仍是生");
  assert.equal(R.cookState("egg", 2.2), "perfect", "2.2 恰好进完美窗口");
  /* ⚠ 边界值必须**算出来**再比：2.2 + 0.7 在双精度里是 2.9000000000000004，
     字面量 2.9 反而落在窗口内侧（旧表 3.0+0.8 恰好等于 3.8，所以老用例没暴露这点）。 */
  const END = F.dur + F.pw, BRN = F.dur + F.pw + F.burn;
  assert.ok(Math.abs(END - 2.9) < 1e-9, "完美窗口右界 = 2.9s（2.2 + 0.7）");
  assert.ok(Math.abs(BRN - 3.8) < 1e-9, "糊点 = 3.8s（2.2 + 0.7 + 0.9）");
  assert.equal(R.cookState("egg", 2.5), "perfect", "窗口正中");
  assert.equal(R.cookState("egg", END - 0.001), "perfect", "差 1ms 出窗口仍是恰好");
  assert.equal(R.cookState("egg", END), "over", "出窗口 → 过火（普通分，不糊）");
  assert.equal(R.cookState("egg", BRN - 0.001), "over", "差 1ms 到糊点仍可端");
  assert.equal(R.cookState("egg", BRN), "burnt", "到糊点就是糊");
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
});

test("火候状态机：真实推进（step）能按秒数走到 perfect → over → burnt（按住看火，不自动落盘）", () => {
  const st = wokState();
  const i = cookTo(st, "congee", 0);                    // 白粥锅 = 第 0 列
  assert.equal(i, 0, "白粥进第 0 列（白粥锅）");
  advance(st, 3.5); assert.equal(st.stations[i].state, "perfect", "3.5s 后恰好（新表：白粥 3.4s 熟）");
  advance(st, 1.0); assert.equal(st.stations[i].state, "over", "再过 1.0s 过火（完美窗口 1.0s）");
  advance(st, 1.2); assert.equal(st.stations[i].state, "burnt", "再过 1.2s 糊（糊点 5.6s）");
  assert.equal(st.burnt, 1, "糊掉计数 +1");
});

test("列绑定：9 列一一对应（食材 ↔ 灶位 ↔ 专属盘），索引稳定、不可互换", () => {
  const st = mkState(); st.running = true;
  assert.equal(R.COL_N, 9, "一共 9 列");
  assert.equal(R.FOOD_IDS.length, 9, "9 样食材 = 9 列");
  assert.equal(st.stations.length, 9, "9 个灶位");
  assert.equal(R.PLATES_TOTAL, 9, "9 个专属盘（每列 1 个）");
  /* 每一列的绑定逐条对上：FOOD_IDS[i] ↔ 灶位 i ↔ 盘 i */
  for (let i = 0; i < 9; i++) {
    const f = R.FOOD_IDS[i];
    assert.equal(R.COLS[i].food, f, "第 " + i + " 列的食材是 " + f);
    assert.equal(R.columnOf(f), i, "columnOf(" + f + ") = " + i);
    assert.equal(R.foodOfColumn(i), f, "foodOfColumn(" + i + ") 反向一致");
    assert.equal(st.stations[i].kind, R.COLS[i].kind, "第 " + i + " 列的厨具稳定");
    assert.equal(st.stations[i].col, i, "灶位记录里写着列号");
    assert.equal(R.hasPlate(i), true, "第 " + i + " 列有自己的专属盘");
    assert.equal(R.isPrepStation(i), true, "每列都有盘（不再分预备/现做）");
  }
  for (let i = 0; i < 9; i++) for (let j = i + 1; j < 9; j++)
    assert.notEqual(R.FOOD_IDS[i], R.FOOD_IDS[j], "两列不会绑同一样食材");
  jsonEq(R.FOOD_IDS.map((f, i) => [f, R.columnOf(f), st.stations[i].kind]),
    [["congee",0,"pot"], ["milk",1,"pot"], ["soup",2,"pot"],
     ["egg",3,"griddle"], ["bacon",4,"griddle"], ["sandwich",5,"griddle"],
     ["bun",6,"steamer"], ["salad",7,"counter"], ["juice",8,"juicer"]],
    "9 列绑定表（写死、不可互换）");
  /* 越界一律没有盘 / 没有列 */
  assert.equal(R.hasPlate(-1), false); assert.equal(R.hasPlate(9), false);
  assert.equal(R.columnOf("nope"), -1); assert.equal(R.foodOfColumn(9), null);
  assert.equal(R.columnOf("egg"), 3, "煎蛋只会进第 3 列（煎蛋盘）");
  assert.equal(R.columnOf("congee"), 0, "白粥只会进第 0 列（白粥锅）");
  /* 拖到别人的锅 → 拒绝（原因码 wrong-column）*/
  assert.equal(R.placeFood(st, "egg", 0), false, "煎蛋不能放白粥锅");
  assert.equal(st.lastPlace.why, "wrong-column");
  assert.match(st.lastPlace.hint, /别人的锅/);
  assert.equal(R.placeFood(st, "egg", 3), true, "煎蛋进自己的煎蛋盘");
  assert.equal(R.placeFood(st, "egg", 3), false, "同一个锅不能叠放");
  assert.equal(st.lastPlace.why, "station-occupied");
  assert.equal(R.firstFreeStation(st, "egg"), -1, "食材只认自己那一列：那列忙就没得放");
  assert.equal(R.firstFreeStation(st, "milk"), 1, "别的列照旧空着");
});

/* ══════════════ 2. 顾客与订单生成 / 难度曲线 ══════════════ */

test("难度曲线：顾客越来越急、耐心越来越短、订单结构随难度移动", () => {
  const cfg = { duration: 75, goal: 8 };
  // 开局 roll<0.40 才是 1 样；收官 roll<0.14 才是 1 样（明显更难）
  assert.equal(R.orderLenAt(0, cfg, 0.10), 1);
  assert.equal(R.orderLenAt(0, cfg, 0.40), 2);
  assert.equal(R.orderLenAt(0, cfg, 0.90), 3);
  assert.equal(R.orderLenAt(75, cfg, 0.02), 1, "收官时只有最早那一小段 roll 还是 1 样");
  assert.equal(R.orderLenAt(75, cfg, 0.20), 2);
  assert.equal(R.orderLenAt(75, cfg, 0.72), 3, "收官时 roll≥0.72 就是 3 样");
  assert.equal(R.orderLenAt(75, cfg, 0.95), 3);
  // 同一 roll 下收官订单不会更短
  for (let i = 0; i <= 100; i++) {
    const r = i / 100;
    assert.ok(R.orderLenAt(75, cfg, r) >= R.orderLenAt(0, cfg, r), "同一 roll 下收官订单不会更短（roll=" + r + "）");
  }
  const avg = t => { let s = 0; for (let i = 0; i < 100; i++) s += R.orderLenAt(t, cfg, i / 100); return s / 100; };
  assert.ok(avg(75) > avg(0), "收官平均订单更长（" + avg(0).toFixed(2) + " → " + avg(75).toFixed(2) + "）");
  // 耐心随时间变短
  assert.ok(R.patienceFor(2, 75, cfg) < R.patienceFor(2, 0, cfg), "收官耐心更短");
  assert.ok(R.patienceFor(3, 0, cfg) > R.patienceFor(1, 0, cfg), "订单越长耐心越多");
  assert.ok(R.patienceFor(3, 75, cfg) > 15, "最短也不会短于 15s（可玩性）");
  // 收官：订单更长 + 耐心更短 ⇒ 单位时间压力更大
  const pressure = t => avg(t) / R.patienceFor(2, t, cfg);
  assert.ok(pressure(75) > pressure(0), "收官压力更大（" + pressure(0).toFixed(3) + " → " + pressure(75).toFixed(3) + "）");
});

test("顾客生成：开局 0.45s 内进第一位；同时最多 3 位；送客后立刻补位", () => {
  const st = mkState(); st.running = true;
  advance(st, 0.5);
  assert.equal(R.activeCustomers(st).length, 1, "开店后第一位顾客进门");
  assert.ok(st.customers[0].order.length >= 1 && st.customers[0].order.length <= 3, "订单长度 1~3");
  assert.ok(st.customers[0].patience > 0);
  // 连续做单送客 40 秒：同时在场永远 ≤ 3，顾客不断轮换
  let guard = 0, maxAtOnce = 0, servedByMe = 0;
  while (st.elapsed < 40 && guard++ < 4000 && !st.over) {
    maxAtOnce = Math.max(maxAtOnce, R.activeCustomers(st).length);
    if (!R.activeCustomers(st).length) { R.step(st, 0.1); continue; }
    const r = autoServe(st);
    if (r && r.ok) servedByMe++;
    for (const c of R.activeCustomers(st)) if (c.patience < 30) c.patience = c.patienceMax = 120;
    R.step(st, 0.1);
  }
  assert.ok(maxAtOnce <= 3, "同时最多 3 位（实测 " + maxAtOnce + "）");
  assert.ok(servedByMe >= 4, "40 秒内能服务 4 位以上（实测 " + servedByMe + "）");
  assert.ok(maxAtOnce >= 2, "顾客会叠加（实测同时最多 " + maxAtOnce + " 位）");
  assert.equal(st.angry, 0, "一直被好好服务 → 没有人跑单");
});

test("订单生成：同一张订单不重复点同一食物（顾客 / 纯函数两条路都验）", () => {
  for (let len = 1; len <= 3; len++) {
    for (let k = 0; k < 200; k++) {
      const o = R.orderFor(len, k / 200, k);
      assert.equal(o.length, len, "长度正确");
      assert.equal(new Set(o).size, len, "同一订单不重复：" + o.join(","));
      o.forEach(f => assert.ok(R.FOOD[f], "食物存在：" + f));
    }
  }
  for (let k = 0; k < 200; k++) {
    const c = R.newCustomer(k, k % 75, { duration: 75, goal: 8 }, k / 200);
    assert.equal(new Set(c.order).size, c.order.length, "顾客订单不重复：" + c.order.join(","));
    assert.ok(c.order.length >= 1 && c.order.length <= 3);
  }
});

test("顾客 patienceMax 与实际耐心一致；服务完立刻让出座位", () => {
  const st = mkState();
  st.running = true;                                    // 先开局（没开局不能下料 / 出餐）
  const c0 = R.spawnCustomer(st, ["egg"]);
  assert.equal(c0.patience, c0.patienceMax);
  const i0 = cookTo(st, "egg", R.FOOD.egg.dur + 0.05);   // 刚进完美窗口（新表：煎蛋 2.2s 熟）
  const got = deliverTo(st, i0, c0);                    // 取出并端上桌
  assert.equal(got.ok, true, "端上桌");
  assert.equal(st.stations[i0].food, null, "取出后锅里空了");
  assert.equal(st.served, 1, "服务计数 +1");
  assert.equal(R.activeCustomers(st).length, 0, "顾客立即让出座位");
  assert.equal(R.remainOf(c0), 0);
});

/* ══════════════ 3. 计分 ══════════════ */

test("计分：完美 +13（10+1+热乎 2）／普通 +7／上错 −5／糊菜上桌 −5 且顾客离开／顾客离开 −8", () => {
  const S = R.SCORE;
  assert.equal(S.perfect, 10); assert.equal(S.warm, 6); assert.equal(S.hotBonus, 3);
  assert.equal(S.wrong, -5); assert.equal(S.burnt, -5); assert.equal(S.leave, -8); assert.equal(S.tick, 1);
  assert.equal(R.scoreDelta("perfect", { hot: true }), 14);
  assert.equal(R.scoreDelta("perfect", { hot: false }), 11);
  assert.equal(R.scoreDelta("warm", { hot: true }), 10);
  assert.equal(R.scoreDelta("warm", { hot: false }), 7);
  assert.equal(R.scoreDelta("wrong"), -5);
  assert.equal(R.scoreDelta("burnt"), -5);
  assert.equal(R.scoreDelta("leave"), -8);
  assert.equal(R.scoreDelta("star"), 12);
  assert.equal(R.scoreDelta("不存在"), 0);

  // ── 完美（热乎）出餐（新模型：熟了自动落到本列专属盘 → 单击盘送给顾客）
  let st = plateState();
  const cp = longPatience(R.spawnCustomer(st, ["egg"]));
  const i1 = plated(st, "egg", R.FOOD.egg.dur + 0.05);   // 刚进完美窗口就落盘 → 热乎
  const d1 = deliverTo(st, i1, cp);
  assert.equal(d1.kind, "perfect-hot", "盘上出餐（完美 + 热乎）");
  assert.equal(d1.delta, 14, "完美 + 热乎 = 14");
  assert.equal(d1.heat, "hot", "出锅即刻 → 热乎");
  assert.equal(st.perfect, 1); assert.equal(st.hot, 1); assert.equal(st.served, 1);

  // 自动落盘：真实帧推进下，一到「恰好」就离开锅、落到本列专属盘（要求 A3）
  st = plateState();
  longPatience(R.spawnCustomer(st, ["egg"]));
  assert.equal(R.placeFood(st, "egg", null), true, "点一下食材 → 自动进它那一列");
  advance(st, R.FOOD.egg.dur + 0.1);
  assert.equal(st.stations[3].food, null, "熟了以后锅里立刻空出来");
  assert.equal(R.plateOfStation(st, 3).food, "egg", "那份煎蛋在自己的专属盘上");
  assert.equal(R.phaseOf(st, 3), "plated", "状态机：cooking → plated");
  const rAgain = R.serveFromColumn(st, 3);
  assert.equal(rAgain.ok, true); assert.equal(rAgain.delta, 14, "单击盘出餐 = 热乎 14");
  assert.equal(st.hot, 1);

  // ── 过火（普通）出餐：锅里过了完美窗口才落盘（按住看火那条路）→ 6+1 = 7
  st = plateState();
  const cb = longPatience(R.spawnCustomer(st, ["egg"]));
  assert.equal(R.placeFoodEx(st, "egg", 3, { manual:true }).ok, true, "按住看火（不自动落盘）");
  st.stations[3].t = (R.FOOD.egg.dur + R.FOOD.egg.pw + 0.4) * 1000;
  st.stations[3].state = R.cookState("egg", st.stations[3].t / 1000);
  const i2 = 3;
  assert.equal(st.stations[i2].state, "over", "过了完美窗口 → 过火");
  assert.equal(R.plateOfStation(st, i2), null, "还没落盘");
  assert.equal(R.takePlate(st, i2), true, "过火的这份照样能落到本列专属盘（普通分）");
  assert.equal(st.plates[0].hot, false, "过火不算热乎");
  const r2 = R.serveFromColumn(st, i2);
  assert.equal(r2.kind, "over"); assert.equal(r2.delta, 7, "盘上过火出餐 6+1 = 7");
  assert.equal(st.normal, 1, "过火记进「普通」档"); assert.equal(st.perfect, 0);

  // 过火那份走「食材 → 盘 → 顾客」整条新链路（分不变 6+1=7）
  st = plateState();
  const cb0 = longPatience(R.spawnCustomer(st, ["congee"]));
  const i2b = plated(st, "congee", R.FOOD.congee.dur + R.FOOD.congee.pw + 0.3);
  assert.equal(st.stations[i2b].state === "over" || st.plates[0].state === "over", true, "过火");
  assert.equal(st.plates[0].hot, false, "过火不算热乎");
  const r2b = R.serveFromColumn(st, i2b);
  assert.equal(r2b.kind, "over"); assert.equal(r2b.delta, 7, "盘上过火出餐 6+1 = 7");
  assert.equal(st.normal, 1, "过火记进「普通」档"); assert.equal(st.perfect, 0);

  // ── 上错菜（点顾客卡自动配盘那条路能主动端错）
  st = plateState();
  const cw = longPatience(R.spawnCustomer(st, ["egg"]));
  const i3 = cookTo(st, "congee", R.FOOD.congee.dur);   // 端一份白粥给只点了煎蛋的人
  const d3 = deliverTo(st, i3, cw);
  assert.equal(d3.kind, "wrong");
  assert.equal(d3.delta, -5, "上错菜 −5");
  assert.equal(st.wrong, 1);
  assert.equal(st.served, 0, "上错菜不算服务成功");
  assert.equal(R.activeCustomers(st).length, 1, "顾客还在（还有耐心就不走）");

  // 盘上那份此刻没人要 → 单击盘不消耗、留在盘上（要求 A3）
  st = plateState();
  longPatience(R.spawnCustomer(st, ["congee"]));
  const ib = plated(st, "egg", R.FOOD.egg.dur + 0.05);
  const db = R.serveFromColumn(st, ib);
  assert.equal(db.ok, false); assert.equal(db.why, "no-want", "没人要这份 → 拒绝出餐");
  assert.equal(st.score, 0, "不消耗、不扣分");
  assert.equal(R.plateOfStation(st, ib).food, "egg", "那份还留在盘上（继续走热乎度衰减）");
  assert.equal(st.served, 0);

  // ── 糊菜端上桌 → 顾客直接不满离开（用干净状态，避免前面场景的顾客干扰）
  st = plateState();
  const cburn = longPatience(R.spawnCustomer(st, ["egg"]));
  const burntBefore = st.burnt;
  const i4 = cookWalk(st, "egg", "burnt");
  assert.equal(st.stations[i4].state, "burnt");
  assert.equal(st.burnt, burntBefore + 1, "烧糊记账 +1");
  assert.equal(R.plateOfStation(st, i4), null, "按住看火时食物留在锅里（没落盘）");
  const angryBefore = st.angry;
  const nActive = R.activeCustomers(st).length;          // 上桌那一刻在场人数
  assert.equal(R.serveFromColumn(st, i4).why, "no-plate", "锅里那份还没落盘，单击盘没东西可送");
  const r4 = R.serveFoodToCustomer(st, cburn, "egg", "burnt", "cold", 6);
  assert.equal(r4.kind, "burnt");
  assert.equal(r4.delta, -5, "糊菜端上桌 −5");
  assert.equal(st.angry, angryBefore + 1, "顾客不满离开");
  assert.equal(cburn.angry, true, "该顾客被标记为不满");
  assert.equal(R.activeCustomers(st).length, nActive - 1, "被得罪的顾客立刻离场（其他人不受影响）");
  assert.equal(R.activeCustomers(st).indexOf(cburn), -1, "他不在场上了");
  assert.equal(st.served, 0);
  assert.equal(st.burnt, burntBefore + 1, "糊掉计数不重复累加（端上桌不再额外记一次）");

  // 糊菜走「盘」这条路：顾客同样当场离开
  st = plateState();
  const cburn2 = longPatience(R.spawnCustomer(st, ["congee"]));
  const i4b = cookWalk(st, "congee", "burnt");
  assert.equal(R.hasPlate(i4b), true);
  R.takePlate(st, i4b);
  assert.equal(st.plates[0].hot, false);
  const r4b = R.serveCustomer(st, ci(st, cburn2), 0);
  assert.equal(r4b.kind, "burnt"); assert.equal(r4b.delta, -5, "盘上糊菜端上桌同样 −5");

  // ── 顾客等太久自己走 → −8（一位只扣一次）
  st = mkState({ duration: 4, goal: 8 });      // 时限短，避免新顾客插进来干扰断言
  st.running = true;
  const cl = R.spawnCustomer(st, ["congee"]);
  cl.patience = cl.patienceMax = 3;
  const angry0 = st.angry, score0 = st.score;
  advance(st, 3.7);
  assert.equal(st.angry, angry0 + 1, "耐心耗尽 → 走人");
  assert.equal(st.score, score0 - 8, "顾客离开 −8");
  assert.equal(st.served, 0);
  assert.equal(st.served, 0);
  const scoreOnce = st.score, angryOnce = st.angry;
  for (let k = 0; k < 5; k++) { cl.patience = -1; R.step(st, 1 / 60); }   // 反复踩同一位顾客
  assert.equal(st.angry, angryOnce, "同一位顾客只记一次跑单（不重复扣分）");
  assert.equal(st.score, scoreOnce);
});

test("计分：糊掉的食物丢垃圾桶不扣分，只浪费时间", () => {
  const st = plateState();
  const i = cookWalk(st, "egg", "burnt");
  assert.equal(st.stations[i].state, "burnt");
  assert.equal(st.burnt, 1);
  const before = st.score;
  assert.equal(R.trashStation(st, i), true);
  assert.equal(st.score, before, "丢垃圾桶不扣分");
  assert.equal(st.stations[i].food, null, "锅清空");
  assert.equal(st.burnt, 1, "但糊掉的事实仍然记账（结算面板显示）");
  // 生料也能丢（清锅，不扣分）
  const i2 = cookTo(st, "congee", 1.0);
  assert.equal(R.trashStation(st, i2), true);
  assert.equal(st.score, before, "生料丢掉同样不扣分");
});

test("计分：一条订单全完美（≥2 样）额外 +12；混合则不给", () => {
  let st = plateState();
  const c1 = R.spawnCustomer(st, ["egg", "congee"]);
  let i = plated(st, "egg", R.FOOD.egg.dur + 0.05); deliverTo(st, i, c1);          // 恰好 → 热乎
  i = cookTo(st, "congee", R.FOOD.congee.dur + R.FOOD.congee.pw + 0.3);            // 过火
  R.takePlate(st, i); deliverTo(st, i, c1);
  assert.equal(st.served, 1);
  assert.equal(st.score, 14 + 7, "全完美不成立 → 没有额外 12");

  st = plateState();
  const c2 = R.spawnCustomer(st, ["egg", "congee"]);
  i = plated(st, "egg", R.FOOD.egg.dur + 0.05); deliverTo(st, i, c2);
  i = plated(st, "congee", R.FOOD.congee.dur + 0.05); deliverTo(st, i, c2);
  assert.equal(st.score, 14 + 14 + 12, "两样都完美 → 额外 +12");
});

/* ══════════════ 4. 过关判定 ══════════════ */

test("过关判定：75 秒内服务满 8 位 → win:true（点单要什么做什么，9 列平行下料 + 单击盘出餐）", () => {
  const st = mkState({ duration: 75, goal: 8 });
  st.running = true;
  let guard = 0;
  while (!st.over && guard++ < 3000) {
    // 1) 把所有顾客还缺的菜尽量平行下锅（每样只进自己那一列）
    const list0 = R.activeCustomers(st);
    for (const c of list0) for (const f of c.order) {
      if (c.done.indexOf(f) >= 0) continue;
      if (st.stations.some(s => s.food === f)) continue;
      if (R.plateOfStation(st, R.columnOf(f))) continue;
      R.placeFood(st, f, null);
    }
    // 2) 推进到有东西落到盘上（或 1 秒）
    let frames = 0;
    while (frames++ < 60 && !st.over) { R.step(st, 1 / 60); if (st.plates.length) break; }
    if (st.over) break;
    // 3) 单击每一列的专属盘：自动送给正在需要 + 耐心最少的顾客（没人要就留着）
    for (let i = 0; i < st.stations.length; i++) if (R.plateOfStation(st, i)) R.serveFromColumn(st, i);
    // 4) 清掉糊掉的残骸 / 没人要的存货，避免堵住某一列
    for (let i = 0; i < st.stations.length; i++) {
      const p = R.plateOfStation(st, i);
      if ((p && p.state === "burnt") || st.stations[i].state === "burnt") R.trashStation(st, i);
    }
    R.step(st, 0.15); guard++;
  }
  assert.ok(st.over, "已结算");
  assert.equal(st.result.win, true, "服务满 8 位 → 通过");
  assert.equal(st.result.served, 8);
  assert.equal(st.result.goal, 8);
  assert.equal(st.result.burnt, 0, "规划得当就不会糊");
  assert.equal(st.angry, 0, "全程没人跑单");
  assert.ok(st.result.score > 0, "得分为正：" + st.result.score);
  assert.ok(st.elapsed < 75, "在时限内完成（用时 " + st.elapsed.toFixed(1) + "s）");
  assert.ok(st.result.bondDelta >= 6 && st.result.bondDelta <= 10, "通过 → 好感 +6~+10（实得 +" + st.result.bondDelta + "）");
});

test("过关判定：时间用尽仍未服务满 → win:false（判定依据是 served，不是分数）", () => {
  const st = mkState({ duration: 9, goal: 8 });
  st.running = true;
  // 不服务，只让顾客不断进店 / 跑单；9 秒太短，气走人数到不了 5 → 由「时间到」分支结算
  let guard = 0;
  while (!st.over && guard++ < 3000) { R.step(st, 1 / 60); if (st.elapsed > 1 && guard % 40 === 0) R.spawnCustomer(st, ["egg"]); }
  assert.equal(st.over, true);
  assert.equal(st.result.win, false, "时间到，只服务了 " + st.result.served + " 位 → 失败");
  assert.equal(st.result.served, 0);
  assert.match(st.result.reason, /时间到/);
  assert.ok(st.result.bondDelta <= -3 && st.result.bondDelta >= -6, "失败 −3~−6（实得 " + st.result.bondDelta + "）");
  assert.ok(st.result.impact.length > 6, "有本局影响一句话");
});

test("好感结算：失败但做出过东西 → 按糊掉的份数 / 服务数给 −3~−6（不虐主）", () => {
  const st = mkState({ duration: 40, goal: 8 });
  st.running = true;
  // 1) 先正常服务两位（证明「做出过东西」）
  let guard = 0, served0 = 0;
  while (!st.over && guard++ < 300 && st.served < 2) {
    if (!R.activeCustomers(st).length) { R.step(st, 0.2); continue; }
    autoServe(st);
    R.step(st, 0.1);
  }
  served0 = st.served;
  assert.equal(served0, 2, "先服务了 2 位");
  // 2) 故意把剩下的时间耗光：所有顾客耐心压到 1 秒，三列里再烧糊 3 份
  for (let i = 0; i < st.stations.length; i++) R.trashStation(st, i);   // 先清锅清盘
  for (const f of ["congee", "milk", "soup"]) assert.equal(R.placeFood(st, f, null), true, f + " 下锅");
  // 直接把三锅的火候推过糊点（模拟"忘了看火"）
  for (let i = 0; i < st.stations.length; i++) if (st.stations[i].food) st.stations[i].t = (R.burnAt(st.stations[i].food) + 0.05) * 1000;
  while (!st.over && guard++ < 12000) {
    R.step(st, 1 / 60);
    for (const c of R.activeCustomers(st)) if (c.patience > 0.8) c.patience = 0.8;
  }
  assert.equal(st.over, true, "已结算");
  assert.equal(st.result.win, false);
  assert.ok(st.result.burnt >= 3, "糊了 " + st.result.burnt + " 份");
  assert.equal(st.result.served, 2, "结算面板能显示服务了 2 位");
  assert.ok(st.result.bondDelta <= -3 && st.result.bondDelta >= -6, "失败区间 −3~−6（实得 " + st.result.bondDelta + "）");
  assert.ok(/[「"]/.test(st.result.quote), "有专属尴尬台词：" + st.result.quote);
  assert.ok(st.result.impact.length > 6, "有本局影响一句话");
  assert.match(st.result.impact, /糊|焦|凉|空|手/);
});

test("好感结算：失败也留台阶 —— 文案里必须出现「明天再来」这类不虐主的说法", () => {
  const st = mkState({ duration: 3, goal: 8, target:{ id:"su", name:"苏晚晴", bond:40 } });
  st.running = true;
  advance(st, 3.7);
  assert.equal(st.result.win, false);
  assert.ok(st.result.bondDelta >= -6, "最多 −6");
  assert.match(R.impactOf(false, 0, 0, 0, "苏晚晴"), /空|凉/);
  // 结果里的 target 信息完整（结算面板要显示对象与好感变化）
  assert.equal(st.result.target.id, "su");
  assert.equal(st.result.target.name, "苏晚晴");
  assert.equal(st.result.target.bond, 40);
});

test("过关判定：气走 5 位顾客 → 提前失败（不用等满 75 秒）", () => {
  const st = mkState({ duration: 75, goal: 8 });
  st.running = true;
  let guard = 0;
  while (!st.over && guard++ < 60) {
    const list = R.activeCustomers(st);
    if (!list.length) { R.spawnCustomer(st, ["egg"]); continue; }
    list[0].patience = 0.001;
    advance(st, 1 / 60 + 0.001);
  }
  assert.equal(st.over, true);
  assert.equal(st.result.win, false);
  assert.equal(st.angry, 5, "气走 5 位提前结算");
  assert.ok(st.elapsed < 20, "提前结束（用时 " + st.elapsed.toFixed(1) + "s）");
});

test("debug.finishNow 语义：按当前服务数给通过 / 失败", () => {
  const st = mkState({ duration: 75, goal: 8 });
  st.running = true;
  st.served = 8;
  R.finish(st, st.served >= st.cfg.goal, "服务满");
  assert.equal(st.result.win, true);
  const st2 = mkState({ duration: 75, goal: 8 });
  st2.running = true; st2.served = 3; st2.burnt = 4;
  R.finish(st2, false, "主动收摊");
  assert.equal(st2.result.win, false);
  assert.equal(st2.result.bondDelta, R.bondDeltaLose(4, 3));
});

/* ══════════════ 5. 好感结算 ══════════════ */

test("好感结算：完美份数 / 热乎份数 → bondDelta（通过 +6~+10）", () => {
  assert.equal(R.bondDeltaWin(0, 0), 6, "一份完美都没有也给 +6（不虐主）");
  assert.equal(R.bondDeltaWin(1, 1), 6);
  assert.equal(R.bondDeltaWin(3, 0), 7);
  assert.equal(R.bondDeltaWin(6, 0), 8);
  assert.equal(R.bondDeltaWin(9, 0), 9);
  assert.equal(R.bondDeltaWin(9, 4), 10);
  assert.equal(R.bondDeltaWin(12, 9), 10, "上限 10");
  assert.equal(R.bondDeltaWin(99, 99), 10, "绝不超过 +10");
  let prev = -1;
  for (let p = 0; p <= 14; p++) { const v = R.bondDeltaWin(p, 0); assert.ok(v >= prev, "完美越多加得越多"); prev = v; }
  assert.ok(R.bondHeat(5, 0) > R.bondHeat(2, 0), "热乎度随完美份数上升");
  assert.ok(R.bondHeat(0, 4) > R.bondHeat(0, 0), "热乎份数也计入");
});

test("好感结算：失败 → bondDelta −3~−6", () => {
  assert.equal(R.bondDeltaLose(0, 8), -3, "一份都没糊 → 只 −3");
  assert.equal(R.bondDeltaLose(0, 1), -4, "只服务了 1 位 → −4");
  assert.equal(R.bondDeltaLose(3, 5), -4);
  assert.equal(R.bondDeltaLose(6, 5), -5);
  assert.equal(R.bondDeltaLose(12, 5), -6, "上下限夹住");
  assert.equal(R.bondDeltaLose(99, 0), -6, "最差也只 −6");
  for (let b = 0; b <= 20; b++) { const v = R.bondDeltaLose(b, 3); assert.ok(v <= -3 && v >= -6, "始终在 −3~−6"); }
});

test("好感结算：bondDeltaFor 按胜负分流", () => {
  assert.equal(R.bondDeltaFor(true, 9, 4, 0, 8), 10);
  assert.equal(R.bondDeltaFor(false, 0, 0, 0, 8), -3);
});

test("选对象规则：好感 20~79 才可选；<20 / ≥80 / 今天已送 → 置灰并给原因", () => {
  const bonds = { fang:14, su:22, lin:79, wen:80, lei:20, hong:12, guo:55, lu:9, man:31 };
  const ids = Object.keys(bonds);
  const list = R.eligibleTargets(bonds, ids, {});
  const by = {}; list.forEach(x => by[x.id] = x);
  assert.equal(by.fang.ok, false); assert.match(by.fang.why, /生疏|≥20|好感 14/);
  assert.equal(by.hong.ok, false); assert.match(by.hong.why, /生疏/);
  assert.equal(by.lu.ok, false); assert.match(by.lu.why, /生疏/);
  assert.equal(by.wen.ok, false); assert.match(by.wen.why, /满|80/);
  assert.equal(by.su.ok, true, "好感 22 可选");
  assert.equal(by.lin.ok, true, "好感 79 可选（边界内）");
  assert.equal(by.lei.ok, true, "好感 20 是下边界，刚好可选");
  assert.equal(by.man.ok, true);
  // 今天已送过的置灰
  const list2 = R.eligibleTargets(bonds, ids, { guo:true });
  const guo = list2.find(x => x.id === "guo");
  assert.equal(guo.ok, false); assert.match(guo.why, /今天已经送过/);
  assert.equal(list2.filter(x => x.ok).length, list.filter(x => x.ok).length - 1);
  // 不可选的人也保留在列表里（置灰可见，不是消失）
  assert.equal(list.length, ids.length);
  // canSend 同规则
  assert.equal(R.canSend(bonds, "su", 7, null).ok, true);
  assert.equal(R.canSend(bonds, "fang", 7, null).ok, false);
  assert.equal(R.canSend(bonds, "wen", 7, null).ok, false);
});

test("每日一次：S.breakfastDay 记录同一天同一角色只能送一次，换天自动重置", () => {
  let bf = null;
  bf = R.markSent(bf, "su", 7);
  jsonEq(bf, { day:7, sent:["su"] }, "首条记录");
  assert.equal(R.canSend({ su:40 }, "su", 7, bf).ok, false, "同一天同一角色不能再送");
  assert.match(R.canSend({ su:40 }, "su", 7, bf).why, /今天已经给他送过/);
  assert.equal(R.canSend({ su:40, lin:44 }, "lin", 7, bf).ok, true, "换个人还能送");
  bf = R.markSent(bf, "lin", 7);
  jsonEq(bf.sent.slice().sort(), ["lin", "su"], "同一天可以送多个人，但每人一次");
  const map = R.sentToday(bf, 7);
  assert.equal(map.su, true); assert.equal(map.lin, true); assert.equal(map.guo, undefined);
  // 换天（Day 8）→ 自动清空
  bf = R.markSent(bf, "guo", 8);
  jsonEq(bf, { day:8, sent:["guo"] }, "换天重置");
  assert.equal(R.canSend({ su:40 }, "su", 8, bf).ok, true, "新的一天又能送了");
  jsonEq(Object.assign({}, R.sentToday(bf, 8)), { guo:true }, "今天的已送名单");
  jsonEq(Object.assign({}, R.sentToday(bf, 7)), {}, "旧的那天不再算已送");
  // 不会重复记录
  bf = R.markSent(bf, "guo", 8);
  jsonEq(bf.sent, ["guo"], "同一天同一角色重复记录不会叠加");
  // 坏数据容错（存档里字段被改坏也不崩）
  jsonEq(R.markSent("坏的", "su", 3), { day:3, sent:["su"] }, "脏数据重置");
  jsonEq(R.markSent(undefined, "su", 3), { day:3, sent:["su"] }, "空数据初始化");
  jsonEq(R.markSent({ day:3, sent:"不是数组" }, "su", 3), { day:3, sent:["su"] }, "字段类型错也兜住");
});

test("好感区间置灰规则：20 与 80 两个边界都精确", () => {
  const bonds = { a:19, b:20, c:79, d:80 };
  const list = R.eligibleTargets(bonds, ["a", "b", "c", "d"], {});
  assert.equal(list.find(x => x.id === "a").ok, false, "19 → 置灰");
  assert.equal(list.find(x => x.id === "b").ok, true, "20 → 可选");
  assert.equal(list.find(x => x.id === "c").ok, true, "79 → 可选");
  assert.equal(list.find(x => x.id === "d").ok, false, "80 → 置灰");
});

/* ══════════════ 6. 结算结果 / 文案 ══════════════ */

test("result 字段齐全，且 quote 与 target 对得上（9 位角色都有专属台词）", () => {
  const need = ["win", "served", "goal", "perfect", "burnt", "score", "bondDelta", "target", "quote"];
  for (const id of R.TARGET_IDS) {
    const cfg = { duration: 75, goal: 8, target:{ id:id, name:id, bond:40 } };
    const st = R.newState(cfg); st.running = true; st.perfect = 6; st.hot = 4; st.served = 8;
    R.finish(st, true, "test");
    need.forEach(k => assert.ok(k in st.result, "字段 " + k + " 存在 (" + id + ")"));
    assert.ok(st.result.quote.length > 4, id + " 有通过台词");
    assert.equal(st.result.target.id, id);
    const st2 = R.newState(cfg); st2.running = true; st2.burnt = 4; st2.served = 2;
    R.finish(st2, false, "test");
    assert.ok(st2.result.quote.length > 4, id + " 有失败台词");
    assert.ok(st2.result.bondDelta < 0);
    assert.notEqual(st2.result.quote, st.result.quote, id + " 成功 / 失败台词不同");
  }
  // 未知角色走兜底文案
  const st3 = R.newState({ duration: 75, goal: 8, target:{ id:"nobody", name:"路人", bond:30 } });
  st3.running = true; R.finish(st3, true, "t");
  assert.ok(st3.result.quote.length > 4, "兜底台词可用");
  // finish 幂等：重复调用不会改写结果
  const once = JSON.stringify(st3.result);
  R.finish(st3, false, "again");
  assert.equal(JSON.stringify(st3.result), once, "finish 只结算一次");
});

test("本局影响一句话：胜负 / 糊多少 → 不同文案，且带对方名字", () => {
  const win1 = R.impactOf(true, 10, 0, 6, "苏晚晴");
  const win2 = R.impactOf(true, 2, 1, 0, "苏晚晴");
  const lose1 = R.impactOf(false, 0, 5, 0, "苏晚晴");
  assert.match(win1, /苏晚晴/); assert.match(lose1, /苏晚晴/);
  assert.notEqual(win1, win2);
  assert.notEqual(win1, lose1);
  assert.match(lose1, /糊|焦/);
});

test("所有 9 位可攻略角色都在 TARGETS 里（与页面羁绊键一致）", () => {
  const want = ["fang", "su", "lin", "wen", "lei", "hong", "guo", "lu", "man"];
  jsonEq(R.TARGET_IDS.slice().sort(), want.slice().sort(), "角色 id 与 BONDS 键一一对应");
  BF.TARGETS.forEach(t => { assert.ok(t.name && t.f, t.id + " 有名字与头像"); assert.ok(R.QUOTES[t.role], t.id + " 有台词表"); });
});

test("新局状态：默认 75 秒 / 8 位，灶位与出餐盘都为空", () => {
  const st = mkState();
  assert.equal(st.cfg.duration, 75); assert.equal(st.cfg.goal, 8);
  assert.equal(st.stations.length, 9);
  assert.equal(st.stations.every(s => s.food === null && s.state === "idle"), true);
  assert.equal(st.plates.length, 0);
  assert.equal(st.customers.length, 0);
  assert.equal(st.running, false, "未 start 时不自动跑");
  assert.equal(st.elapsed, 0);
  const ev = R.step(st, 1);
  assert.equal(JSON.stringify(ev), "[]", "未 running → step 不产生事件");
  assert.equal(st.elapsed, 0, "未 start 时不推进时间");
  assert.equal(R.activeCustomers(st).length, 0);
  assert.equal(R.placeFood(st, "egg", 3), false, "没开局不能下料");
  assert.equal(R.takePlate(st, 3), false, "没开局不能出锅");
});

/* ══════ 7. 新操作模型（bf-3）：列绑定 / 点击下料路由 / 单击盘出餐 / 双击丢弃 / 9 盘 + 过火报废 ══════ */

test("点击下料路由：单击食材 → 自动进它自己那一列的锅（锅忙 / 盘占用 → 明确原因码）", () => {
  const st = plateState();
  assert.equal(R.placeFood(st, "egg", null), true, "点煎蛋 → 进第 3 列（煎蛋盘）");
  assert.equal(st.stations[3].food, "egg", "就在它那一列，不会跑去别的锅");
  assert.equal(st.stations.filter(s => s.food).length, 1, "只下了这一份");
  assert.equal(R.stationIndexOfKind(st, "griddle", 0), 3, "煎蛋盘 = 第 3 列");
  assert.equal(R.stationIndexOfKind(st, "griddle", 1), 4, "培根盘 = 第 4 列");
  assert.equal(R.stationIndexOfKind(st, "griddle", 2), 5, "三明治盘 = 第 5 列");
  assert.equal(R.stationIndexOfKind(st, "pot", 0), 0, "白粥锅 = 第 0 列");
  assert.equal(R.stationIndexOfKind(st, "juicer", 0), 8, "果汁机 = 第 8 列");
  // 锅还在做 → 拒绝并给原因码
  const busy = R.placeFoodEx(st, "egg", null);
  assert.equal(busy.ok, false); assert.equal(busy.why, "station-occupied");
  assert.match(busy.hint, /锅里还在做/);
  // 别的锅空着也不许去（这是一个「什么锅做什么食材」的游戏）
  assert.equal(R.stationFree(st, 4), true, "4 号煎盘空着");
  assert.equal(R.placeFoodEx(st, "egg", 4).why, "wrong-column", "但煎蛋只认自己那一列");
  // 熟了自动落到本列专属盘 → 锅里空了，但盘占着 → 仍然拒绝下料
  advance(st, 3.2);
  assert.equal(R.plateOfStation(st, 3).food, "egg", "熟了落到第 3 列的专属盘");
  const pbusy = R.placeFoodEx(st, "egg", null);
  assert.equal(pbusy.ok, false); assert.equal(pbusy.why, "plate-occupied");
  assert.match(pbusy.hint, /盘里还有一份，先送出去/);
  // 送出去以后这一列立刻恢复
  longPatience(R.spawnCustomer(st, ["egg"]));
  assert.equal(R.serveFromColumn(st, 3).ok, true);
  assert.equal(R.placeFood(st, "egg", null), true, "盘空 → 马上能再下一份");
  // 别的列完全不受影响
  assert.equal(R.placeFood(st, "bacon", null), true, "培根走它自己那一列（4）");
  assert.equal(st.stations[4].food, "bacon");
});

test("单击盘出餐：自动选中正在需要该食物的顾客，优先耐心最少者", () => {
  const st = plateState();
  const slow = longPatience(R.spawnCustomer(st, ["egg"]));       // 耐心 600
  const hurried = longPatience(R.spawnCustomer(st, ["egg", "congee"]));
  hurried.patience = 6;                                         // 更急
  const other = longPatience(R.spawnCustomer(st, ["congee"]));    // 不要煎蛋
  const col = plated(st, "egg", R.FOOD.egg.dur + 0.05);
  assert.equal(R.pickCustomerIndexFor(st, "egg"), st.customers.indexOf(hurried), "优先耐心最少的");
  assert.equal(R.pickCustomerIndexFor(st, "congee"), st.customers.indexOf(hurried), "最急的那位也最优先");
  assert.equal(R.pickCustomerIndexFor(st, "juice"), -1, "没人要的食材返回 -1");
  const r = R.serveFromColumn(st, col);
  assert.equal(r.ok, true); assert.equal(r.delta, 14);
  assert.equal(st.served, 0, "他还要 congee，这单没完成");
  assert.equal(hurried.done.indexOf("egg") >= 0, true, "落在他头上");
  assert.equal(slow.done.indexOf("egg") >= 0, false, "慢的那位没被越位");
  assert.equal(R.activeCustomers(st).length, 3, "其他人都还在");
  assert.equal(R.pickCustomerIndexFor(st, "congee"), st.customers.indexOf(hurried), "他还缺 congee → 仍然最优先");
  assert.equal(R.pickCustomerIndexFor(st, "egg"), st.customers.indexOf(slow), "煎蛋只剩慢的那位要了");
  // 剩下那位还等着 → 再做一份，这次自动挑到他
  const col2 = plated(st, "egg", R.FOOD.egg.dur + 0.05);
  const r2 = R.serveFromColumn(st, col2);
  assert.equal(r2.ok, true);
  assert.equal(slow.done.indexOf("egg") >= 0, true, "第二轮送给剩下那位");
});

test("单击盘：此刻没人要这份 → 不消耗、留在盘上继续走热乎度衰减（凉了还能上）", () => {
  const st = plateState();
  longPatience(R.spawnCustomer(st, ["congee"]));
  const col = plated(st, "sandwich", R.FOOD.sandwich.dur + 0.05);
  const score0 = st.score;
  const r = R.serveFromColumn(st, col);
  assert.equal(r.ok, false); assert.equal(r.why, "no-want");
  assert.match(r.hint, /现在没人要这份/);
  assert.equal(st.score, score0, "不扣分");
  assert.equal(st.wrong, 0, "也不算上错菜");
  assert.equal(R.plateOfStation(st, col).food, "sandwich", "那份还在盘上");
  assert.equal(R.platePhaseOf(R.plateOfStation(st, col), st.elapsed), "hot");
  advance(st, 2.0);
  assert.equal(R.plateOfStation(st, col).tier, "warm", "留着不动 → 掉到「温」");
  advance(st, 1.5);
  assert.equal(R.plateOfStation(st, col).tier, "cold", "再掉到「凉」");
  longPatience(R.spawnCustomer(st, ["sandwich"]));
  const r2 = R.serveFromColumn(st, col);
  assert.equal(r2.ok, true); assert.equal(r2.heat, "cold"); assert.equal(r2.delta, 6, "凉了照样能上（+6 · 不劝退）");
});

test("双击丢弃：清空这一列的锅与盘、不扣分；糊的单击被拒（原因码 burnt）只能双击丢", () => {
  const st = plateState();
  longPatience(R.spawnCustomer(st, ["egg"]));
  const col = plated(st, "egg", R.FOOD.egg.dur + 0.05);
  assert.equal(!!R.plateOfStation(st, col), true);
  const score0 = st.score;
  assert.equal(R.trashColumn(st, col), true, "双击盘 → 丢垃圾桶");
  assert.equal(R.plateOfStation(st, col), null, "盘清空");
  assert.equal(st.stations[col].food, null, "锅也清空");
  assert.equal(st.score, score0, "不扣分");
  assert.equal(st.wrong, 0, "不算上错菜");
  assert.equal(R.stationFree(st, col), true, "这一列立刻能再用");
  // 锅里还在做的也能双击丢掉
  assert.equal(R.placeFood(st, "egg", null), true);
  assert.equal(R.trashColumn(st, col), true, "双击锅 = 倒掉生料");
  assert.equal(st.stations[col].food, null);
  assert.equal(st.tossed >= 2, true, "记了丢弃次数（结算面板用）");
  // 糊的那份：单击被拒，只能双击
  const col2 = cookWalk(st, "bacon", "burnt");
  assert.equal(R.plateOfStation(st, col2), null, "按住看火的糊份留在锅里");
  assert.equal(R.takePlate(st, col2), true, "糊的也能落到本列盘上（锅清空）");
  assert.equal(R.plateOfStation(st, col2).state, "burnt");
  const sc2 = st.score;
  const bad = R.serveFromColumn(st, col2);
  assert.equal(bad.ok, false); assert.equal(bad.why, "burnt", "糊的单击被拒");
  assert.match(bad.hint, /只能丢/);
  assert.equal(st.score, sc2, "拒绝时不扣分");
  assert.equal(R.plateOfStation(st, col2).state, "burnt", "糊的还在盘上（没被吃掉）");
  assert.equal(R.trashColumn(st, col2), true, "双击才丢得掉");
  assert.equal(R.plateOfStation(st, col2), null);
  assert.equal(st.score, sc2, "丢掉糊的不扣分");
  assert.equal(R.placeFood(st, "bacon", null), true, "丢完立刻能再用");
});

test("9 盘 + 过火报废：盘上停留超过 SERVE_WINDOW → 变糊 → 只能丢（窗口前 0.01s 未糊 / 后 0.01s 已糊）", () => {
  assert.equal(R.SERVE_WINDOW, 4.5, "过火计时 4.5s");
  assert.equal(R.PLATES_TOTAL, 9, "9 个专属盘（不再是 3 个备菜盘）");
  assert.equal(R.MAX_PLATES, 9);
  // ① 纯函数边界：精确到 0.01s
  assert.equal(R.plateBurntAt(R.SERVE_WINDOW - 0.01), false, "窗口前 0.01s 还没糊");
  assert.equal(R.plateBurntAt(R.SERVE_WINDOW + 0.01), true, "窗口后 0.01s 已经糊");
  assert.equal(R.plateBurntAt(R.SERVE_WINDOW), true, "正好到点即糊");
  assert.equal(R.plateBurntAt(0), false, "刚落盘不算糊");
  assert.ok(Math.abs(R.plateLeftSec(0) - R.SERVE_WINDOW) < 1e-9, "刚落盘还剩满窗口");
  assert.ok(Math.abs(R.plateLeftSec(R.SERVE_WINDOW + 1)) < 1e-9, "超时后剩余 0");
  // ② 真实推进的边界：窗口前 0.01s 还活着（凉档），窗口后 0.01s 已经糊
  const st = plateState();
  const col = plated(st, "salad", R.FOOD.salad.dur + 0.05);
  const p = R.plateOfStation(st, col);
  p.at = st.elapsed - (R.SERVE_WINDOW - 0.01);
  R.step(st, 0);
  assert.equal(R.plateOfStation(st, col).state, "perfect", "窗口前 0.01s：还是好的");
  assert.equal(R.plateOfStation(st, col).tier, "cold", "此时只剩「凉」档（越拖越差）");
  assert.equal(st.burnt, 0, "还没糊");
  R.plateOfStation(st, col).at = st.elapsed - (R.SERVE_WINDOW + 0.01);
  R.step(st, 0);
  assert.equal(R.plateOfStation(st, col).state, "burnt", "窗口后 0.01s：糊了");
  assert.equal(st.burnt, 1, "糊掉记账 +1");
  assert.equal(st.expire, 1, "记在「忘取」账上");
  assert.equal(R.serveFromColumn(st, col).why, "burnt", "糊的单击被拒");
  const sc = st.score;
  assert.equal(R.trashColumn(st, col), true, "只能双击丢");
  assert.equal(st.score, sc, "丢垃圾桶不扣分");
  // ③ 自然推进（不手动拨表）也会超时报废
  const st2 = plateState();
  const col2 = plated(st2, "juice", R.FOOD.juice.dur + 0.05);
  advance(st2, R.SERVE_WINDOW - 0.2);
  assert.equal(R.plateOfStation(st2, col2).state, "perfect", "4.3s：还在盘上等着");
  advance(st2, 0.3);
  assert.equal(R.plateOfStation(st2, col2).state, "burnt", "4.6s：忘取 → 糊");
});

test("热乎度三档：盘上 热乎 14 / 温 10 / 凉 6，单调递减，三档都还能上餐", () => {
  assert.equal(R.HEAT.hot, 14); assert.equal(R.HEAT.warm, 10); assert.equal(R.HEAT.cold, 6);
  assert.ok(R.HEAT.hot > R.HEAT.warm && R.HEAT.warm > R.HEAT.cold, "单调递减 14 > 10 > 6");
  assert.ok(R.HEAT.hotSec < R.HEAT.warmSec && R.HEAT.warmSec < R.SERVE_WINDOW, "三档均分在过火窗口内");
  assert.equal(R.heatTierOf("perfect", 0), "hot");
  assert.equal(R.heatTierOf("perfect", R.HEAT.hotSec), "hot", "边界还算热乎");
  assert.equal(R.heatTierOf("perfect", R.HEAT.hotSec + 0.01), "warm");
  assert.equal(R.heatTierOf("perfect", R.HEAT.warmSec), "warm", "边界还算温");
  assert.equal(R.heatTierOf("perfect", R.HEAT.warmSec + 0.01), "cold");
  assert.equal(R.heatTierOf("over", 0), "warm", "过火拿不到热乎档（旧档 over=7 的手感不变）");
  assert.equal(R.serveScore("perfect", "hot"), 14);
  assert.equal(R.serveScore("perfect", "warm"), 10);
  assert.equal(R.serveScore("perfect", "cold"), 6);
  assert.equal(R.serveScore("over", "warm"), 7);
  assert.equal(R.serveScore("over", "cold"), 3);
  // 三档各自真的能上餐（分数对得上）
  [[0.5, "hot", 14], [2.2, "warm", 10], [4.0, "cold", 6]].forEach(function (row) {
    const age = row[0], tier = row[1], delta = row[2];
    const st = plateState();
    const c = longPatience(R.spawnCustomer(st, ["milk"]));
    const col = plated(st, "milk", R.FOOD.milk.dur + 0.05);
    R.plateOfStation(st, col).at = st.elapsed - age;
    R.step(st, 0);
    assert.equal(R.plateOfStation(st, col).tier, tier, age + "s → " + tier);
    const r = R.serveFromColumn(st, col);
    assert.equal(r.ok, true); assert.equal(r.delta, delta, age + "s → " + delta + " 分");
    assert.equal(c.done.indexOf("milk") >= 0, true, "照样算服务成功");
  });
  // 档位只降不升
  const st = plateState();
  const col = plated(st, "congee", R.FOOD.congee.dur + 0.05);
  const seq = [R.plateOfStation(st, col).tier];
  for (let k = 0; k < 4; k++) {
    advance(st, 1);
    const t2 = R.plateOfStation(st, col).tier;
    if (t2 !== seq[seq.length - 1]) seq.push(t2);
  }
  jsonEq(seq, ["hot", "warm", "cold"], "档位只降不升");
});

test("每一列都有专属盘：9 盘不限量，盘占用只堵它自己那一列（要求 A5）", () => {
  const st = plateState();
  jsonEq(R.prepStationIndices(), [0, 1, 2, 3, 4, 5, 6, 7, 8], "9 列都有盘（不再只有前 3 个）");
  jsonEq(R.serveStationIndices(), [], "没有「无盘现做灶位」了");
  for (let i = 0; i < 9; i++) assert.equal(st.stations[i].hasPlate, true, i + " 号灶位有自己的盘");
  // 9 列同时各放一份 → 9 份都能各自落到自己的盘上（不限量）
  const each = ["congee", "milk", "soup", "egg", "bacon", "sandwich", "bun", "salad", "juice"];
  each.forEach((f, i) => assert.equal(R.placeFood(st, f, null), true, "第 " + i + " 列下 " + f));
  assert.equal(st.made, 9, "9 列同时开工");
  advance(st, 5.2);
  assert.equal(st.plates.length, 9, "9 份全部落到各自的专属盘上（没有 3 盘限量）");
  assert.equal(new Set(st.plates.map(p => p.station)).size, 9, "没有两个灶位共用一个盘");
  for (let i = 0; i < 9; i++) {
    const p = R.plateOfStation(st, i);
    assert.ok(p, i + " 号灶位有自己的盘");
    assert.equal(p.station, i, "盘记录里写着唯一的归属灶位");
    assert.equal(p.food, each[i], "盘里正好是这一列做出来的东西");
    assert.equal(R.stationFree(st, i), false, "盘上有东西 → 这一列不可下料");
    assert.equal(R.placeFoodEx(st, each[i], null).why, "plate-occupied", "原因码 plate-occupied：" + each[i]);
  }
  // 只丢掉第 0 列 → 只有它恢复
  assert.equal(R.trashColumn(st, 0), true);
  assert.equal(R.stationFree(st, 0), true, "丢掉后第 0 列恢复");
  assert.equal(st.plates.length, 8, "别的 8 列不受影响");
  assert.equal(R.stationFree(st, 1), false, "第 1 列还占着");
  assert.equal(R.placeFood(st, "congee", null), true, "第 0 列马上能再用");
});

test("熟了自动落到本列专属盘（autoPlate 默认开）；manual 按住看火不落盘、照样烧到糊", () => {
  const st = R.newState({ duration:999, goal:99 });
  assert.equal(st.cfg.autoPlate, true, "默认自动落盘（新模型的核心规则）");
  st.running = true; st.nextIn = 1e6;
  const col = R.columnOf("bacon");                       // 2.8s 熟（bf-9 新表）
  assert.equal(R.placeFood(st, "bacon", null), true);
  advance(st, 2.0);
  assert.equal(st.plates.length, 0, "还没熟 → 不落盘");
  assert.equal(R.phaseOf(st, col), "cooking");
  advance(st, 1.7);
  assert.equal(st.plates.length, 1, "进了完美窗口 → 自动落到本列专属盘");
  assert.equal(st.stations[col].food, null, "落盘后锅位立刻空出来");
  assert.equal(R.phaseOf(st, col), "plated");
  assert.equal(st.prepped, 1, "记账：备好 1 份");
  // manual（按住看火）→ 食物留在锅里，会一路烧到糊
  const st2 = plateState();
  assert.equal(R.placeFoodEx(st2, "bacon", null, { manual:true }).ok, true);
  advance(st2, R.FOOD.bacon.dur + 0.2);                  // 完美窗口内（2.8 + 0.7 = 3.5 出窗口）
  assert.equal(st2.plates.length, 0, "manual 不自动落盘");
  assert.equal(st2.stations[4].state, "perfect");
  advance(st2, 2.5);
  assert.equal(st2.stations[4].state, "burnt", "按住不管 → 真的会糊（看火的压力还在）");
  assert.equal(st2.burnt, 1);
  // 关掉 autoPlate 的旧手感：手动 takePlate 才落盘
  const st3 = R.newState({ duration:999, goal:99, autoPlate:false }); st3.running = true; st3.nextIn = 1e6;
  R.placeFood(st3, "congee", null);
  advance(st3, 5.1);
  assert.equal(st3.plates.length, 0, "autoPlate:false → 不自动落盘");
  assert.equal(R.takePlate(st3, 0), true, "手动落盘照旧");
  assert.equal(st3.plates.length, 1);
});

test("糊的那份：不清掉就堵着这一列；丢完才能再用（焦黑 + 冒烟的渲染见无头证据链）", () => {
  const st = plateState();
  const col = cookWalk(st, "egg", "burnt");
  assert.equal(st.stations[col].state, "burnt");
  assert.equal(R.phaseOf(st, col), "burnt");
  const r = R.placeFoodEx(st, "egg", null);
  assert.equal(r.ok, false); assert.equal(r.why, "station-occupied", "糊着的时候不能再下料");
  assert.equal(R.stationFree(st, col), false);
  const sc = st.score;
  assert.equal(R.trashColumn(st, col), true, "双击丢掉");
  assert.equal(st.score, sc, "丢垃圾桶不扣分");
  assert.equal(st.stations[col].food, null, "锅清空");
  assert.equal(R.stationFree(st, col), true, "清空后立刻恢复可用");
  assert.equal(R.placeFood(st, "egg", null), true, "马上又能下一份");
});

test("灶位 / 盘状态机是纯函数：idle → raw → cooking → ready → plated；盘 hot → warm → cold → burnt", () => {
  const st = R.newState({ duration:999, goal:99, autoPlate:false }); st.running = true; st.nextIn = 1e6;
  assert.equal(R.phaseOf(st, 3), "idle");
  assert.equal(R.phaseOf(st, 99), "none", "不存在的灶位");
  R.placeFood(st, "egg", null);
  assert.equal(R.phaseOf(st, 3), "raw");
  st.stations[3].t = 1000; assert.equal(R.phaseOf(st, 3), "cooking");
  st.stations[3].t = 3000; st.stations[3].state = "perfect";
  assert.equal(R.phaseOf(st, 3), "ready", "恰好但还没落盘 → ready");
  R.takePlate(st, 3);
  assert.equal(R.phaseOf(st, 3), "plated", "落盘后 → plated");
  // over / burnt 这两条支路在「锅里还有东西」时才看得到
  R.placeFoodEx(st, "bacon", null, { manual:true });
  st.stations[4].state = "over"; assert.equal(R.phaseOf(st, 4), "over");
  st.stations[4].state = "burnt"; assert.equal(R.phaseOf(st, 4), "burnt");
  assert.equal(R.platePhaseOf(null, 0), "none");
  assert.equal(R.platePhaseOf(st.plates[0], st.elapsed), "hot");
  assert.equal(R.platePhaseOf(st.plates[0], st.elapsed + R.HEAT.hotSec + 0.01), "warm");
  assert.equal(R.platePhaseOf(st.plates[0], st.elapsed + R.HEAT.warmSec + 0.01), "cold");
  assert.equal(R.platePhaseOf(st.plates[0], st.elapsed + R.SERVE_WINDOW + 0.01), "burnt", "超时 → 糊");
  // 纯函数：反复调用不改状态
  const snap = JSON.stringify({ f:st.stations[3].food, n:st.plates.length });
  R.phaseOf(st, 3); R.phaseOf(st, 3); R.platePhaseOf(st.plates[0], st.elapsed);
  assert.equal(JSON.stringify({ f:st.stations[3].food, n:st.plates.length }), snap, "无副作用");
});

test("列对齐布局：9 列各自「底部食材 → 中列锅 → 上列盘」同一 x 中心线（±2px）、不越界、不重叠", () => {
  const V = BF.VIEW, L = BF.LAY;
  assert.ok(V.w >= 1100 && V.h >= 680, "画面 ≥1100×680（实测 " + V.w + "×" + V.h + "）");
  assert.ok(L.stove.panW >= 110 && L.stove.panH >= 110, "每个锅位 ≥110px（" + L.stove.panW + "×" + L.stove.panH + "）");
  for (let i = 0; i < 9; i++) {
    const s = BF.stationBox(i), p = BF.plateBox(i), b = BF.bucketBox(i);
    const cx = x => x.x + x.w / 2;
    assert.ok(Math.abs(cx(s) - cx(p)) <= 2, i + " 列：锅与专属盘同一 x 中心线");
    assert.ok(Math.abs(cx(s) - cx(b)) <= 2, i + " 列：锅与底部食材桶同一 x 中心线");
    assert.ok(p.y + p.h <= s.y, i + " 列：盘在锅的正上方");
    assert.ok(b.y >= s.y + s.h, i + " 列：食材桶在锅的正下方");
    [s, p, b].forEach((box, k) => {
      assert.ok(box.x >= 0 && box.x + box.w <= V.w, "第 " + i + " 列第 " + k + " 个盒子不越界（x）");
      assert.ok(box.y >= L.topH && box.y + box.h <= V.h, "第 " + i + " 列第 " + k + " 个盒子不越界（y）");
    });
  }
  for (let a = 0; a < 9; a++) for (let b2 = a + 1; b2 < 9; b2++) {
    const A = BF.stationBox(a), Bx = BF.stationBox(b2);
    assert.ok(A.x + A.w <= Bx.x || Bx.x + Bx.w <= A.x, "列 " + a + " 与 " + b2 + " 不相交");
  }
  const lastBucket = BF.bucketBox(8), lastCard = BF.customerCardBox(2);
  assert.ok(lastBucket.x + lastBucket.w <= V.w, "最后一个食材桶不越界");
  assert.ok(lastCard.x + lastCard.w <= V.w, "第三张顾客卡不越界");
  assert.ok(L.cards.y > L.topH, "顾客卡在顶栏下面");
  assert.ok(L.legend.y >= L.cards.y + L.cards.h, "操作图例在顾客卡下方");
  assert.ok(L.plate.y > L.legend.y + L.legend.h, "专属盘在操作图例下方");
  assert.ok(L.stove.y > L.plate.y + L.plate.h, "锅区在专属盘下方");
  assert.ok(L.buckets.y > L.stove.y + L.stove.panH, "食材桶在最底部（底排）");
  assert.ok(L.buckets.y + L.buckets.h <= V.h, "食材桶在画面内");
});

test("画面参数达标：容器 ≥1100×680、正文 ≥16px、列头小字 ≥13px、关键数字 ≥28px、食物图标 ≥64px", () => {
  const V = BF.VIEW, F2 = BF.FONT, I = BF.ICON;
  assert.ok(V.w >= 1100 && V.h >= 680, "画面 ≥1100×680（实测 " + V.w + "×" + V.h + "）");
  assert.ok(F2.body >= 16, "正文 ≥16px（" + F2.body + "）");
  assert.ok(F2.tiny >= 16, "小注释字号 ≥16px（" + F2.tiny + "）");
  assert.ok(F2.label >= 16 && F2.name >= 16 && F2.bucket >= 16, "标签 / 名字 / 食材名都 ≥16px");
  assert.ok(F2.micro >= 13, "列头小字（用户要求「小字」）≥13px（" + F2.micro + "）");
  assert.ok(F2.clock >= 28, "倒计时 ≥28px（" + F2.clock + "）");
  assert.ok(F2.score >= 28, "分数 ≥28px（" + F2.score + "）");
  assert.ok(F2.patience >= 28, "耐心 ≥28px（" + F2.patience + "）");
  assert.ok(I.food >= 64, "单份食物视觉尺寸 ≥64px（" + I.food + "）");
  assert.ok(I.bucket >= 64 && I.card >= 64 && I.plate >= 64, "各处的食物图标都 ≥64px");
  assert.ok(BF.LAY.cards.w >= 220, "顾客卡宽度 ≥220（" + BF.LAY.cards.w + "）");
});

test("过火计时从「落盘那一刻」起算：煮得久的菜不会一落盘就糊", () => {
  const st = plateState();
  longPatience(R.spawnCustomer(st, ["congee"]));
  assert.equal(R.placeFood(st, "congee", null), true);
  advance(st, R.FOOD.congee.dur + 0.1);           // 煮了 5.1s（比 4.5s 的过火窗口还长）
  const p = R.plateOfStation(st, 0);
  assert.ok(p, "白粥落盘了");
  assert.equal(p.state, "perfect", "刚落盘还是好的（计时从落盘起算，不是从下锅起算）");
  assert.ok(p.age <= 0.25, "落盘年龄 ≈ 0（" + p.age + "s）");
  assert.ok(p.left > R.SERVE_WINDOW - 0.3, "剩余窗口 ≈ 4.5s（实际 " + p.left + "s）");
  advance(st, R.SERVE_WINDOW - 0.3);
  assert.equal(R.plateOfStation(st, 0).state, "perfect", "还剩 0.3s 可以送出去");
  advance(st, 0.4);
  assert.equal(R.plateOfStation(st, 0).state, "burnt", "超时才糊");
});

test("双击丢弃的时机窗口：DOUBLE_MS=425ms；同一目标点两下才算双击（常量 + 落到清空语义）", () => {
  assert.equal(R.DOUBLE_MS, 425, "双击判定窗口 425ms（放宽后更好点）");
  assert.ok(R.DOUBLE_MS > 0 && R.DOUBLE_MS <= 500, "既不能太短（点不出来）也不能太长（误触）");
  const st = plateState();
  const col = plated(st, "bun", R.FOOD.bun.dur + 0.05);
  const sc = st.score;
  assert.equal(R.trashColumn(st, col), true, "双击 → 清锅 + 清盘");
  assert.equal(R.trashColumn(st, col), false, "已经空了的列再丢一次无事发生（不报错）");
  assert.equal(st.score, sc, "始终不扣分");
  assert.equal(R.stationFree(st, col), true, "丢完这一列可用");
});

/* ═══════════════════════════════════════════════════════════════════════════
   结算面板的**出口**（#bfGo）· 无头 DOM +「真实 CSS → 布局几何」断言
   背景：用户实测「游戏结束然后呢，都没有找到可以退出游戏的按钮和衔接剧情」——
        1440×900 窗口里「顶栏 + 1180×790 等比放大的画布」已经把 .bf-panel 撑出视口，
        结算面板排在画布下面 → 被裁掉，出口按钮根本不在屏幕里，onFinish 也永远不触发。
   做法：用最小 DOM 真跑 Breakfast.start()（真出结算面板），再按 index.html 里**真实生效的
        CSS 声明**算几何：面板 max-height:calc(100vh-20px) 居中 → 结算面板 sticky 贴底 →
        .bf-row sticky bottom:0。按钮底边 = 面板可见底边 − 边框 − padding-bottom，与内容多高无关。
   ═══════════════════════════════════════════════════════════════════════════ */
const HTML_SRC = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const CSS_SRC = (HTML_SRC.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1];

/** 取某条选择器的声明块（逐字匹配「选择器{」，取样式表里第一处 = 未被媒体查询覆盖的主规则） */
function cssRule(sel) {
  const i = CSS_SRC.indexOf(sel + "{");
  if (i < 0) return "";
  const j = CSS_SRC.indexOf("}", i);
  return CSS_SRC.slice(i + sel.length + 1, j);
}
/** 从声明里取 "max-height:calc(100vh - 20px)" 的视口换算值 */
function vhMaxHeight(decl, vh) {
  const m = /max-height:\s*calc\(100vh\s*-\s*(\d+)px\)/.exec(decl || "");
  return m ? vh - Number(m[1]) : null;
}
/** 结算出口几何模型（输入视口高，输出面板/结算面板/按钮的落点；全部由真实 CSS 推导） */
function exitGeom(vh) {
  const panelDecl = cssRule("#bfGame .panel.bf-panel.bf-game-panel");
  const resultDecl = cssRule(".bf-result");
  const rowDecl = cssRule(".bf-result .bf-row");
  const goDecl = cssRule("#bfGo");
  const panelMaxH = vhMaxHeight(panelDecl, vh);
  const resultMaxH = vhMaxHeight(resultDecl, vh);
  const padB = Number((/padding:\s*12px\s+14px\s+(\d+)px/.exec(panelDecl) || [])[1] || 14);
  const panelTop = (vh - panelMaxH) / 2;                       // .overlay 居中
  const panelBottom = vh - panelTop;
  const rowBottom = panelBottom - 1 - padB;                    // 减 .panel 边框 1px + padding-bottom
  const goFont = Number((/font-size:\s*(\d+)px/.exec(goDecl) || [])[1] || 18);
  const goPadY = Number((/(?:^|;)padding:\s*(\d+)px/.exec(goDecl) || [])[1] || 12);
  return {
    vh, panelMaxH, resultMaxH, panelTop, panelBottom, rowBottom,
    btnH: goPadY * 2 + Math.round(goFont * 1.2),
    panelScroll: /overflow-y:auto/.test(panelDecl),
    resultScroll: /overflow-y:auto/.test(resultDecl),
    resultSticky: /position:sticky/.test(resultDecl) && /bottom:0/.test(resultDecl),
    rowSticky: /position:sticky/.test(rowDecl) && /bottom:0/.test(rowDecl),
  };
}

/* ── 极简选择器匹配（tag / .class / #id，够用且不引依赖） ── */
function matchSel(el, sel) {
  let s = String(sel).trim();
  if (s[0] === "#") return el.id === s.slice(1);
  if (s[0] === ".") return String(el.className).split(/\s+/).indexOf(s.slice(1)) >= 0;
  return el.tagName === s.toUpperCase();
}
/* ── 记录式 Canvas2D（只为让 render() 跑起来） ── */
function makeCtx() {
  const noop = () => {};
  const ctx = {
    canvas: null, fillStyle: "#000", strokeStyle: "#000", globalAlpha: 1, lineWidth: 1,
    font: "10px sans-serif", textAlign: "left", textBaseline: "alphabetic",
    save: noop, restore: noop, translate: noop, scale: noop, rotate: noop, setTransform: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, quadraticCurveTo: noop,
    bezierCurveTo: noop, arc: noop, ellipse: noop, rect: noop, fill: noop, stroke: noop,
    fillRect: noop, strokeRect: noop, clip: noop, fillText: noop, strokeText: noop,
    measureText: t => ({ width: String(t).length * 6 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    getImageData: () => ({ data: [] }), putImageData: noop,
  };
  return ctx;
}
function mkEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], parentNode: null,
    id: "", className: "", _html: "", textContent: "", type: "", style: {}, dataset: {},
    _handlers: {}, __rect: null,
    set innerHTML(v) { this._html = String(v); this.children = []; },
    get innerHTML() { return this._html; },
    setAttribute(k, v) { if (k === "id") this.id = v; this[k] = v; },
    getAttribute(k) { return this[k] === undefined ? null : this[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    addEventListener(t, f) { (this._handlers[t] = this._handlers[t] || []).push(f); },
    removeEventListener(t, f) { const h = this._handlers[t] || []; const i = h.indexOf(f); if (i >= 0) h.splice(i, 1); },
    dispatch(t, ev) { (this._handlers[t] || []).slice().forEach(f => f(ev || {})); },
    click() { this.dispatch("click", { preventDefault() {}, stopPropagation() {} }); },
    all() { const out = []; (function walk(n) { (n.children || []).forEach(c => { out.push(c); walk(c); }); })(this); return out; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { return this.all().filter(e => matchSel(e, sel)); },
    getBoundingClientRect() { return this.__rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    getContext() { return this._ctx; },
    offsetWidth: 0,
  };
  el.classList = {
    add(c) { const s = new Set(String(el.className).split(/\s+/).filter(Boolean)); s.add(c); el.className = [...s].join(" "); },
    remove(c) { const s = new Set(String(el.className).split(/\s+/).filter(Boolean)); s.delete(c); el.className = [...s].join(" "); },
    contains(c) { return String(el.className).split(/\s+/).indexOf(c) >= 0; },
    toggle(c, on) { if (on === undefined) on = !this.contains(c); on ? this.add(c) : this.remove(c); },
  };
  if (el.tagName === "CANVAS") { el._ctx = makeCtx(); el._ctx.canvas = el; el.width = 300; el.height = 150; }
  return el;
}
/** 起一个「#bfGame 覆盖层 > .panel#bfGameHost」的无头宿主（结构与 index.html 一致） */
function bootDom() {
  const body = mkEl("body");
  const overlay = mkEl("div"); overlay.id = "bfGame"; overlay.className = "overlay bf-overlay on";
  const host = mkEl("div"); host.id = "bfGameHost"; host.className = "panel bf-panel bf-game-panel";
  overlay.appendChild(host); body.appendChild(overlay);
  const keys = [];
  const doc = {
    body, createElement: mkEl,
    getElementById: id => (id === "bfGameHost" ? host : (id === "bfGame" ? overlay : null)),
    querySelector: sel => body.querySelector(sel),
    querySelectorAll: sel => body.querySelectorAll(sel),
    addEventListener: (t, f) => { if (t === "keydown") keys.push(f); },
    removeEventListener: (t, f) => { if (t === "keydown") { const i = keys.indexOf(f); if (i >= 0) keys.splice(i, 1); } },
  };
  let clock = 0;
  const frames = [];
  const sandbox = {
    console, Math, Date, isFinite, Number, String, Object, Array, JSON, Set,
    devicePixelRatio: 1, document: doc,
    performance: { now: () => clock },
    requestAnimationFrame: cb => { frames.push(cb); return frames.length; },
    cancelAnimationFrame: id => { frames[id - 1] = null; },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const ctx = vm.createContext(sandbox);
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.runInContext(SRC + "\n;globalThis.__BF = window.Breakfast;", ctx);
  function pump(n, ms) {
    for (let i = 0; i < n; i++) {
      clock += (ms === undefined ? 16 : ms);
      const list = frames.slice(); frames.length = 0;
      list.forEach(cb => { if (cb) cb(clock); });
      if (!frames.length) break;
    }
  }
  return { B: ctx.__BF, doc, host, overlay, pump, keys, esc: () => keys.slice().forEach(f => f({ key: "Escape", preventDefault() {}, stopPropagation() {} })) };
}
/** 机器人：看单下料 → 熟了自动落盘 → 单击盘出餐（真把「通过」跑出来） */
function botRun(B) {
  const d = B.debug;
  let guard = 0;
  while (!d.state().over && guard++ < 6000) {
    for (const c of d.orders()) for (const f of c.order) {
      if (c.done.indexOf(f) >= 0) continue;
      if (d.stations().some(s => s.food === f)) continue;
      if (d.plates().some(p => p.food === f && p.state !== "burnt")) continue;
      d.drop(f, null);
    }
    for (let n = 0; n < 60 && !d.state().over; n++) { d.tick(1 / 60); if (d.plates().some(p => p.state === "perfect")) break; }
    if (d.state().over) break;
    d.stations().forEach((s, i) => { if (s.plate && s.plateState !== "burnt") d.serveCol(i); });
    d.stations().forEach((s, i) => {
      if (s.state === "burnt" || s.plateState === "burnt") { d.trash(i); return; }
      if (s.plate) { const r = d.serveCol(i); if (!r.ok && r.why === "no-want") d.trash(i); }
    });
    d.tick(0.15);
  }
  return d.state();
}
/** 起一局 + 真跑到结算面板出现；返回 {boot, res, panel, go} */
function settleDom(win) {
  const b = bootDom();
  let calls = 0, last = null;
  b.B.start(b.host, {
    target: { id: win ? "su" : "guo", name: win ? "苏晚晴" : "陈果", bond: win ? 40 : 30 },
    duration: win ? 75 : 20, goal: 8,
    onFinish: r => { calls++; last = r; },
  });
  if (win) {
    botRun(b.B);
    assert.equal(b.B.debug.state().win, true, "机器人真打出了通过");
    b.pump(3);                                   // 泵几帧让画布循环走到 showResult()
  } else {
    let g = 0;
    while (!b.B.debug.state().over && g++ < 20000) b.B.debug.tick(0.2);
    assert.equal(b.B.debug.state().win, false, "失败路径真跑出来了");
    b.pump(3);
  }
  const panel = b.host.querySelector(".bf-result");
  const go = b.host.querySelector("#bfGo");
  return { b, panel, go, calls: () => calls, last: () => last, reset: () => { calls = 0; } };
}

test("#bfGo：结算面板有出口按钮、文案分胜负、尺寸 >0（真 DOM 节点，不是只有字符串）", () => {
  const w = settleDom(true);
  assert.ok(w.panel, "结算面板已出现在 #bfGameHost 里");
  assert.ok(w.go, "#bfGo 是真实 DOM 节点（浏览器 / 无头都能 querySelector 到）");
  assert.equal(w.go.tagName, "BUTTON", "#bfGo 是按钮");
  assert.ok(/收下早餐\s*·\s*继续/.test(w.go.textContent), "通过时文案「收下早餐 · 继续」（实际 " + w.go.textContent + "）");
  assert.equal(w.go.getAttribute("data-act"), "close", "保留 data-act=close（兼容旧验收脚本选择器）");
  assert.ok(w.panel.querySelectorAll("button").indexOf(w.go) >= 0, "出口按钮真的长在结算面板里");
  assert.ok(w.b.B.isBusy() === true, "面板还在 → 局还没交出去");

  const l = settleDom(false);
  assert.ok(l.go, "失败也有 #bfGo");
  assert.ok(/算了，明天再来\s*·\s*继续/.test(l.go.textContent), "失败文案「算了，明天再来 · 继续」（实际 " + l.go.textContent + "）");
});

test("#bfGo 在任何视口都可见：面板高度 ≤ 视口高、按钮 getBoundingClientRect().bottom ≤ 视口高", () => {
  const w = settleDom(true);
  assert.ok(w.go, "#bfGo 存在且可见才会被断言到");
  for (const vh of [1200, 900, 768, 600, 480]) {
    const g = exitGeom(vh);
    assert.equal(typeof g.panelMaxH, "number", vh + "：能读到面板 max-height:calc(100vh - 20px)");
    assert.equal(typeof g.resultMaxH, "number", vh + "：能读到 .bf-result max-height:calc(100vh - 40px)");
    assert.ok(g.panelScroll, vh + "：游戏面板内部可滚动（overflow-y:auto）");
    assert.ok(g.resultScroll, vh + "：结算面板内部可滚动（overflow-y:auto）");
    assert.ok(g.resultSticky, vh + "：结算面板 sticky 贴住游戏面板底部");
    assert.ok(g.rowSticky, vh + "：出口按钮那一行 sticky 贴住结算面板底部");
    /* ① 面板本身不超视口 */
    const panelRect = { top: g.panelTop, bottom: g.panelBottom, height: g.panelMaxH };
    assert.ok(panelRect.height <= vh, vh + "：面板高度 " + panelRect.height + " ≤ 视口 " + vh);
    assert.ok(panelRect.top >= 0 && panelRect.bottom <= vh, vh + "：面板整体在视口内（" + panelRect.top + "~" + panelRect.bottom + "）");
    /* ② 结算面板在视口内，且按钮底边不越界 */
    const resultTop = Math.max(g.panelTop, g.rowBottom - Math.min(g.resultMaxH, g.panelMaxH));
    const btnBottom = g.rowBottom;
    assert.ok(resultTop >= 0, vh + "：结算面板顶边 " + resultTop + " 没跑到视口外");
    assert.equal(resultTop >= g.panelTop, true, vh + "：结算面板在游戏面板里（sticky 贴底）");
    assert.ok(btnBottom <= vh, vh + "：按钮底边 " + btnBottom + " ≤ 视口高 " + vh);
    assert.ok(btnBottom - g.btnH >= 0, vh + "：按钮顶边 " + (btnBottom - g.btnH) + " 也在视口内");
    assert.ok(g.btnH > 0, vh + "：按钮高度 > 0（" + g.btnH + "px）");
    /* ③ 把模型数值落到真实节点上：尺寸 > 0 */
    w.go.__rect = { left: 0, top: btnBottom - g.btnH, right: 320, bottom: btnBottom, width: 320, height: g.btnH };
    w.panel.__rect = { left: 0, top: resultTop, right: 1150, bottom: g.rowBottom, width: 1150, height: g.rowBottom - resultTop };
    const r = w.go.getBoundingClientRect();
    assert.ok(r.width > 0 && r.height > 0, vh + "：按钮尺寸 " + r.width + "×" + r.height + " > 0");
    assert.ok(w.panel.getBoundingClientRect().height <= vh, vh + "：结算面板高度 ≤ 视口");
    assert.ok(r.bottom <= vh, vh + "：按钮 getBoundingClientRect().bottom " + r.bottom + " ≤ 视口高 " + vh);
  }
});

test("点 #bfGo：onFinish 恰好一次（连点 3 次仍为 1）+ dispose 清计时器 / 监听 + 覆盖层隐藏", () => {
  const w = settleDom(true);
  const before = w.b.B.debug.lifecycle();
  assert.ok(before.escBound >= 1 && before.escActive === true, "开局时 ESC 监听已挂上（escBound=" + before.escBound + "）");
  assert.equal(w.calls(), 0, "结算面板出来时还没交结果（等玩家点出口）");
  w.go.click(); w.go.click(); w.go.click();                      // 连点 3 次（含重复触发 / 手快）
  assert.equal(w.calls(), 1, "onFinish 恰好调用一次（实际 " + w.calls() + "）");
  assert.ok(w.last() && w.last().win === true, "onFinish 收到的是这一局的 result（win:true）");
  assert.equal(w.b.B.isBusy(), false, "点完 isBusy()===false（模块已收摊）");
  const after = w.b.B.debug.lifecycle();
  assert.equal(after.rafCancelled >= 1, true, "rAF 计时器已取消（rafCancelled=" + after.rafCancelled + "）");
  assert.equal(after.escRemoved, after.escBound, "ESC 监听已摘掉（挂 " + after.escBound + " / 摘 " + after.escRemoved + "）");
  assert.equal(after.escActive, false, "ESC 不再处于激活态");
  assert.equal(w.b.keys.length, 0, "document 上不留 keydown 监听");
  assert.equal(w.b.host.children.length, 0, "#bfGameHost 已清空（没有留一个挡住的死界面）");
  assert.equal(w.b.host.classList.contains("bf-on"), false, "宿主 class 已摘");
  assert.equal(w.b.overlay.classList.contains("on"), false, "覆盖层 #bfGame 已关闭");
  assert.equal(w.b.B.start(w.b.host, { onFinish: () => {} }), true, "收摊后还能再开一局（状态没粘住）");
  w.b.B.dispose();
});

test("ESC = 点 #bfGo（退出但不丢结算结果，且同样只交一次）", () => {
  const w = settleDom(true);
  assert.equal(w.calls(), 0, "ESC 之前没交过结果");
  w.b.esc();
  assert.equal(w.calls(), 1, "ESC → onFinish 恰好一次（实际 " + w.calls() + "）");
  assert.ok(w.last() && w.last().win === true, "ESC 交出去的是这一局的结算 result（win:true）");
  assert.ok(w.last() && typeof w.last().served === "number" && typeof w.last().bondDelta === "number",
    "ESC 交出去的 result 字段齐全（served / bondDelta）");
  w.b.esc(); w.b.esc();                                          // 再按也没用（监听已摘 + 幂等）
  assert.equal(w.calls(), 1, "ESC 连按仍是 1 次");
  assert.equal(w.b.B.isBusy(), false, "ESC 之后模块已收摊");
  assert.equal(w.b.overlay.classList.contains("on"), false, "ESC 也把覆盖层关掉");
  /* 对局中（还没结算）ESC 不该抢：先开一局、面板还没出 */
  const g = bootDom();
  let n = 0;
  g.B.start(g.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 75, goal: 8, onFinish: () => { n++; } });
  assert.equal(g.host.querySelector(".bf-result").style.display, "none", "刚开局结算面板是 display:none");
  g.esc();
  assert.equal(n, 0, "还没结算时按 ESC 不交结果（不抢对局中的 ESC）");
  assert.equal(g.B.isBusy(), true, "还没结算时按 ESC 不关局");
  g.B.dispose();
});

test("结算面板写清「接下来干什么」：本局影响（rules.impactOf 同源）+ 今日额度（rules.quotaOf 同源）", () => {
  const w = settleDom(true);
  const txt = String(w.panel._html || w.panel.innerHTML).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.ok(/本局影响/.test(txt), "面板有「本局影响」一行");
  assert.ok(/接下来/.test(txt), "面板有「接下来」一行（今日是否还能再送）");
  const r = w.last() || w.b.B.debug.state().result;
  assert.ok(txt.indexOf(R.impactOf(r.win, r.perfect, r.burnt, r.hot, r.target.name)) >= 0, "本局影响文案与 rules.impactOf 同源");
  assert.ok(txt.indexOf(R.quotaOf(r.win, r.bondDelta, r.target.name)) >= 0, "今日额度文案与 rules.quotaOf 同源");
  assert.ok(/换个人|明天再来/.test(txt), "告诉玩家接下来能干什么（换个人 / 明天再来）");
  assert.ok(typeof R.quotaOf === "function", "rules.quotaOf 已导出（页面 toast 与面板同一份文案）");
  const l = settleDom(false);
  const ltxt = String(l.panel._html || l.panel.innerHTML);
  assert.ok(/台阶|明天再来/.test(ltxt), "失败面板同样给台阶");
});

/* ═══════════════════════════════════════════════════════════════════════════
   本轮新增：素材贴图（背景 / 厨具 / 头像 / UI）的映射表 · 统一加载器 · 回退路径
   这些用例**不需要 DOM**：映射表与加载器在模块初始化时就绪，纯逻辑单测就能覆盖
   「映射完整 / 路径是相对路径 / 缺图时一律回退 / 耐心阈值切换头像」四件事。
   ═══════════════════════════════════════════════════════════════════════════ */

/** 带「假 Image + location」的装载：只验证统一加载器的行为（src 拼装 / 就绪统计 / 失败回退）
    ok=true  → 每次 src 赋值都当成功解码（naturalWidth>0、complete=true、触发 onload）
    ok=false → 一律走 onerror（等价于 34 个文件全丢了） */
/** api.art.ready() 的 5 个计数拼成 "food,gear,face,ui,bg"（跨 realm 对象不能 deepStrictEqual） */
function readyStr(A) { return ["food", "gear", "face", "ui", "bg"].map(k => A.ready()[k]).join(","); }
function loadBfWithFakeImage(opts) {
  const made = [];
  const ctx = vm.createContext({ console, Math, Date, isFinite, Number, String, Object, Array });
  function FakeImage() {
    return {
      naturalWidth: 0, naturalHeight: 0, complete: false, onload: null, onerror: null, _src: "",
      get src() { return this._src; },
      set src(v) {
        this._src = String(v);
        made.push(this._src);
        if (opts && opts.ok === false) { if (typeof this.onerror === "function") this.onerror({ target: this }); return; }
        this.naturalWidth = 64; this.naturalHeight = 64; this.complete = true;
        if (typeof this.onload === "function") this.onload({ target: this });
      }
    };
  }
  ctx.window = ctx;
  ctx.Image = FakeImage;
  ctx.location = { href: "file:///C:/proj/reborn2/index.html" };
  vm.runInContext(SRC + "\n;globalThis.__BF = window.Breakfast;", ctx);
  return { B: ctx.__BF, srcs: () => made.slice() };
}

test("素材映射表完整：5 类厨具有贴图；9 样食材都有盘位贴图；15 头像 + 9 UI 全在册", () => {
  const A = BF.art;
  assert.ok(A && typeof A.groups === "function", "api.art 已导出（贴图映射与状态的机器可读出口）");
  /* 厨具：灶位 kind → gear 贴图名，五个 kind 一个都不能漏 */
  const kinds = [...new Set(R.COLS.map(c => c.kind))].sort();
  assert.deepEqual(kinds, ["counter", "griddle", "juicer", "pot", "steamer"], "9 列用到 5 种灶位 kind");
  assert.equal(A.gearIds.length, 12, "厨具 + 盘位贴图 12 张：" + A.gearIds.join("/"));
  kinds.forEach(k => {
    const n = A.gearOfKind(k);
    assert.ok(n && A.gearIds.indexOf(n) >= 0, "灶位 kind=" + k + " → gear/" + n + ".png（在册）");
  });
  /* 盘位：每样食材都有盘位贴图，且必须是 gear 组里真实存在的文件 */
  R.FOOD_IDS.forEach(f => {
    const t = A.plateTexOf(f);
    assert.ok(A.gearIds.indexOf(t) >= 0, "食材 " + f + " → 盘位贴图 gear/" + t + ".png（在册）");
  });
  /* 本批修正的缺陷：煎蛋盘与培根盘曾经共用 plate_egg_bacon.png → 盘上分不清食材。
     现在**每样自带食物的食材各有一张盘**（6 张），且映射必须一一对应、互不共用。 */
  assert.equal(JSON.stringify(A.plateTexIds),
    JSON.stringify(["plate_empty", "plate_egg", "plate_bacon", "plate_sandwich", "plate_bun", "plate_salad"]),
    "盘面贴图 6 张在册：" + A.plateTexIds.join("/"));
  assert.equal(A.plateTexOf("egg"), "plate_egg", "煎蛋 → 只装煎蛋的盘 plate_egg");
  assert.equal(A.plateTexOf("bacon"), "plate_bacon", "培根 → 只装培根的盘 plate_bacon");
  assert.notEqual(A.plateTexOf("egg"), A.plateTexOf("bacon"),
    "★ 缺陷已修：煎蛋盘 ≠ 培根盘（不再共用一张图）");
  assert.equal(A.plateTexOf("sandwich"), "plate_sandwich", "三明治 → plate_sandwich");
  assert.equal(A.plateTexOf("bun"), "plate_bun", "包子 → 只装包子的盘 plate_bun");
  assert.equal(A.plateTexOf("salad"), "plate_salad", "沙拉 → plate_salad");
  assert.equal(A.plateTexOf("congee"), "plate_empty", "其余食材 → 空盘 + 食物贴图");
  assert.equal(A.plateTexOf(null), "plate_empty", "空盘位 → plate_empty");
  /* 5 样「自带食物」的食材映射各不相同（真正的核心断言）*/
  const fiveFoods = ["egg", "bacon", "sandwich", "bun", "salad"];
  assert.equal(new Set(fiveFoods.map(f => A.plateTexOf(f))).size, 5,
    "5 样自带食物的食材 → 5 张互不相同的盘贴图");
  fiveFoods.forEach(f => assert.ok(A.plateTexHasFood(f), f + " 的盘贴图里自带食物（不再叠食材贴图）"));
  assert.ok(!A.plateTexHasFood("congee") && !A.plateTexHasFood("juice"),
    "plateTexHasFood：白粥 / 果汁仍走「空盘 + 食材贴图」");
  /* 头像 / UI / 分组 */
  assert.equal(A.faceIds.length, 15, "15 张头像（5 位角色 × 平静/着急/满意；本轮把 stud/office/uncle 的 happy 补齐）：" + A.faceIds.join("/"));
  assert.equal(JSON.stringify(A.faceKinds), JSON.stringify(["stud", "office", "uncle", "fang", "lu"]),
    "顾客角色池 5 位：" + A.faceKinds.join("/"));
  assert.equal(JSON.stringify(A.faceMoods), JSON.stringify(["calm", "urgent", "happy"]),
    "头像三态：" + A.faceMoods.join("/"));
  assert.equal(A.uiIds.length, 9, "9 个 UI 元素：" + A.uiIds.join("/"));
  ["bar_empty", "bar_full", "stars", "btn_wood", "btn_red", "coin", "bulb", "check", "cross"].forEach(n =>
    assert.ok(A.uiIds.indexOf(n) >= 0, "UI 元素在册：" + n));
  /* 注意：api.art 返回的是 vm 里的对象/数组（跨 realm），deepStrictEqual 会因为
     原型不同而失败 → 这里一律先拼成字符串再比。 */
  assert.equal(A.groups().map(g => g.key + ":" + g.ids.length).join("|"),
    "food:9|gear:12|face:15|ui:9", "四组贴图都在统一加载器里（food/gear/face/ui）");
  assert.equal(A.total(), 46, "素材总数 = 9 食材 + 12 厨具/盘位 + 15 头像 + 9 UI + 1 背景 = 46");
  assert.equal(A.totalFiles(), 47, "磁盘上的候选文件 47 = 46 + 背景兜底那一张（kitchen2 之外还有 kitchen）");
});

test("贴图路径一律是「页面目录 + 相对路径」：不写盘符、不写协议、不写 data URI", () => {
  const A = BF.art;
  A.groups().forEach(g => {
    assert.ok(/^art\/icons\//.test(g.dir), g.key + " 组目录是相对路径：" + g.dir);
    assert.ok(!/^[A-Za-z]:|^\/|^https?:|^data:/i.test(g.dir), g.key + " 组目录不含盘符 / 协议 / data:");
    assert.equal(g.ext, ".png", g.key + " 扩展名固定 .png");
    g.ids.forEach(id => assert.ok(/^[a-z_]+$/.test(id), g.key + " 的 id 只用小写字母与下划线：" + id));
  });
  const bg = A.bg();
  assert.equal(bg.dir + bg.name, "art/bg/kitchen2.png", "背景首选 v2：art/bg/kitchen2.png（相对页面目录）");
  assert.ok(/art\/bg\/kitchen2\.png$/.test(bg.file) && /art\/bg\/kitchen\.png$/.test("art/bg/" + bg.slots[1].name),
    "两级回退的两个文件名都对：" + bg.file + " → art/bg/" + bg.slots[1].name);
  assert.ok(!/^[A-Za-z]:|^https?:|^data:/i.test(bg.file), "背景路径不含盘符 / 协议 / data:");
});

test("背景层：几何常量与磁盘上的真图对得上，木台面上沿落在专属盘带上方", () => {
  const bg = BF.art.bg();
  const f = path.join(ROOT, bg.file);
  assert.ok(fs.existsSync(f), "背景文件真实存在：" + bg.file);
  const b = fs.readFileSync(f);
  const fileW = b.readUInt32BE(16), fileH = b.readUInt32BE(20);
  assert.equal(fileW, BF.VIEW.w, "art/bg/kitchen2.png 的实际宽 = 画布宽 " + BF.VIEW.w + "（左右一处都没裁，整幅宽都在）");
  assert.equal(fileH, BF.VIEW.h, "art/bg/kitchen2.png 的实际高 = 画布高 " + BF.VIEW.h);
  assert.equal(bg.spec.w, bg.crop.w, "spec.w = 源窗口宽（" + bg.spec.w + "）");
  assert.equal(bg.spec.h, bg.crop.h, "spec.h = 源窗口高（" + bg.spec.h + "，含底部补带那一段）");
  /* 源窗口与「源图坐标」自洽：x 方向必须在图内；y 方向允许超出（超出部分由木纹平铺补满）*/
  assert.ok(bg.crop.x >= 0 && bg.crop.x + bg.crop.w <= bg.srcSpec.w,
    "源窗口横向在源图 " + bg.srcSpec.w + " 之内（x=" + bg.crop.x + " w=" + bg.crop.w + "）");
  assert.ok(bg.crop.y >= 0 && bg.crop.y < bg.srcSpec.h,
    "源窗口起点在源图内（y=" + bg.crop.y + " < " + bg.srcSpec.h + "）");
  assert.ok(bg.crop.y + bg.crop.h >= bg.srcSpec.h,
    "源窗口覆盖到源图底边（不足的 " + bg.bottomFillPx + "px 由底部木纹补带填满）");
  assert.ok(bg.counterTopSrcY >= bg.crop.y && bg.counterTopSrcY <= bg.crop.y + bg.crop.h,
    "木台面上沿（源 y=" + bg.counterTopSrcY + "）在可见窗口内");
  /* 关键对齐：v2 的代价是台面**下移到盘带之内**（保整幅宽的必然结果）。
     不变式：台面上沿不高于盘带顶部（否则台面会压到顾客卡），且 9 列元素位置一个都没动。 */
  assert.ok(bg.counterTopCanvasY > bg.counterTopCanvasYTarget - 1,
    "v2 台面画布 y=" + bg.counterTopCanvasY + " ≥ 目标 " + bg.counterTopCanvasYTarget + "（保整幅宽 → 台面只会更低）");
  assert.equal(bg.counterTopCanvasY, 405.7, "v2 台面实测画布 y = 405.7（源 y=704 / 源高 1371 × 画布 790）");
  /* v2 的取舍：保整幅宽 → 台面下移到「盘带之内」（不再压到 328 之上）。
     所有游戏元素位置不变；台面覆盖全部三段（盘/锅/桶）这一条仍然成立。 */
  assert.ok(bg.counterTopCanvasY > BF.LAY.plate.y && bg.counterTopCanvasY < BF.LAY.buckets.y,
    "台面上沿 y=" + bg.counterTopCanvasY + " 落在盘带内（" + BF.LAY.plate.y + ".." + BF.LAY.buckets.y +
    "），这是保整幅宽的代价；三段元素全部画在木台面上");
  assert.ok(bg.counterTopCanvasY <= BF.LAY.buckets.y,
    "台面上沿也在食材桶带之上（桶带 y=" + BF.LAY.buckets.y + "）");
  assert.equal(bg.strategy, "full-width", "v2 策略 = 保整幅宽（full-width）");
  assert.equal(bg.croppedPerSide, 0, "左右各裁 0px → 完整樱花树冠 + 完整货架都在画面里");
  assert.ok(bg.bottomFillPx > 0, "画布底部补带 " + bg.bottomFillPx + "px（木纹平铺，不是纯色渐变）");
  assert.ok(BF.LAY.buckets.y + BF.LAY.buckets.h <= BF.VIEW.h, "底排食材桶仍在画面内（没被背景挪动）");
  assert.ok(bg.view.w === BF.VIEW.w && bg.view.h === BF.VIEW.h, "背景对齐用的画布尺寸与 VIEW 一致");
  /* 无 Image 的单测环境里，背景也必须判为「不可用」→ 走程序化底 */
  assert.equal(bg.ready, false, "单测环境没有 Image → 背景判为不可用（回退程序化底）");
});

test("统一加载器：预加载 45 张本地贴图；就绪判定 / 全失败回退两条路都走得到", () => {
  /* 这个 vm 环境里没有 Image 构造器（单测就是这么设计的）→ 全部判为「走矢量」 */
  assert.equal(readyStr(BF.art), "0,0,0,0,0", "无 Image 时全部判为不可用 → 一律回退矢量");
  /* 换成带「假 Image + location」的环境：验证 src 拼装与就绪统计 */
  const okCtx = loadBfWithFakeImage({ ok: true });
  const A1 = okCtx.B.art;
  assert.equal(readyStr(A1), "9,12,15,9,1", "有 Image 时外挂 46 张贴图全部就绪（背景算 1；头像 15 = 5 角色 × 3 情绪）");
  const srcs = okCtx.srcs();
  assert.equal(A1.totalFiles(), 47, "磁盘候选文件 47 张（背景 2 张候选）");
  assert.equal(srcs.length, 47, "一共预加载 47 个 src（46 贴图 + 背景兜底那一张，实际 " + srcs.length + "）");
  assert.ok(srcs.every(s => s.indexOf("art/") >= 0 && /\.png$/.test(s)), "每张都是 .png 且落在 art/ 下");
  assert.ok(srcs.every(s => !/^https?:|^data:/i.test(s)), "没有任何 http(s):// 或 data: 外链");
  assert.ok(srcs.every(s => s.indexOf("C:/proj/reborn2/art/") >= 0), "src = 页面目录 + art/… （相对页面，不写死盘符）");
  assert.ok(srcs.some(s => /art\/icons\/gear\/pot\.png$/.test(s)), "厨具 src 形如 …/art/icons/gear/pot.png");
  assert.ok(srcs.some(s => /art\/icons\/faces\/stud_calm\.png$/.test(s)), "头像 src 形如 …/art/icons/faces/stud_calm.png");
  assert.ok(srcs.some(s => /art\/icons\/faces\/stud_happy\.png$/.test(s)) && srcs.some(s => /art\/icons\/faces\/uncle_happy\.png$/.test(s)),
    "本批补的三个 happy 也在预加载清单里（stud_happy / uncle_happy）");
  assert.ok(srcs.some(s => /art\/icons\/ui\/bar_empty\.png$/.test(s)), "UI src 形如 …/art/icons/ui/bar_empty.png");
  assert.ok(srcs.some(s => /art\/bg\/kitchen2\.png$/.test(s)), "背景优先 src 形如 …/art/bg/kitchen2.png");
  assert.ok(srcs.some(s => /art\/bg\/kitchen\.png$/.test(s)), "背景兜底 src 形如 …/art/bg/kitchen.png（两级回退）");
  /* 全部加载失败（真实走 onerror 的那条路）→ 计数落到 failed 上，ready 归零 → 回退 */
  const failCtx = loadBfWithFakeImage({ ok: false });
  const A2 = failCtx.B.art;
  assert.equal(readyStr(A2), "0,0,0,0,0", "全部加载失败 → 全部回退矢量");
  const failed = A2.groups().reduce((a, g) => a + g.failed, 0) + A2.bg().failed;
  assert.equal(failed, 47, "47 个 onerror 全都被接住（failed=" + failed + "，含背景两张候选）");
});

test("顾客头像按耐心阈值切换：> 40% 平静 / ≤ 40% 着急（阈值写在常量里）", () => {
  const A = BF.art;
  assert.equal(A.faceUrgentAt, 0.4, "阈值常量 FACE_ICON.urgentAt = 0.40（可调）");
  assert.equal(A.faceOf(0, 1), "fang_calm", "满耐心 → 平静（角色来自本局角色池）");
  assert.equal(A.faceOf(0, 0.41), "fang_calm", "41% → 平静（> 40%）");
  assert.equal(A.faceOf(0, 0.4), "fang_urgent", "40% → 着急（≤ 40%，边界取着急）");
  assert.equal(A.faceOf(0, 0.39), "fang_urgent", "39% → 着急");
  assert.equal(A.faceOf(0, 0), "fang_urgent", "耐心耗尽 → 着急");
  /* 第三态「满意」：该顾客订单全部拿到（正在离场）→ happy，与耐心多少无关 */
  assert.equal(A.faceOf(0, 1, true), "fang_happy", "全部拿到 → 满意脸（满耐心也切 happy）");
  assert.equal(A.faceOf(0, 0, true), "fang_happy", "全部拿到 → 满意脸（耐心 0 也切 happy）");
  assert.equal(A.faceMoodOf(5, 1, true), "happy", "faceMoodOf(·, ·, true) = happy");
  assert.equal(A.faceMoodOf(5, 0.9, false), "calm", "faceMoodOf(·, 90%, false) = calm");
  assert.equal(A.faceMoodOf(5, 0.1, false), "urgent", "faceMoodOf(·, 10%, false) = urgent");
  assert.ok(typeof A.faceSatisfied === "function" && A.faceSatisfied({ order:["egg"], done:["egg"] }) === true,
    "faceSatisfied：order 全部拿到 → true");
  assert.equal(A.faceSatisfied({ order:["egg", "bun"], done:["egg"] }), false, "还差一样 → 不算满意");
  assert.equal(A.faceSatisfied({ order:[], done:[] }), false, "空订单不算满意（防开局误判）");
  assert.ok(/FACE_SATISFIED_RULE/.test(SRC) && /var FACE_SATISFIED_RULE =/.test(SRC),
    "「满意」判据写成常量 FACE_SATISFIED_RULE：" + A.faceSatisfiedRule);
  /* 异常输入（负数 / NaN）按「满耐心」处理 —— 真正的钳位在调用点（Math.max(0, patience)），
     所以负耐心根本不会走到这里；下面两条一起把这个约定钉住。 */
  assert.equal(A.faceOf(0, -5), "fang_calm", "负数（异常输入）→ 按满耐心，不炸");
  assert.equal(A.faceOf(0, NaN), "fang_calm", "NaN（异常输入）→ 按满耐心，不炸");
  assert.ok(/Math\.max\(0, c\.patience\) \/ Math\.max\(0\.01, c\.patienceMax\)/.test(SRC),
    "调用点把耐心钳到 ≥ 0（drawCustomerFace）→ 负耐心不会真的传进 faceNameOf");
  /* 5 位角色的**外部形象池**：固定种子 → 可复现随机顺序（不是简单的 0,1,2 轮换）*/
  const pool = A.facePoolOf(undefined);
  assert.equal(pool.length, 5, "角色池 5 位：" + pool.join("/"));
  assert.equal(new Set(pool).size, 5, "角色池是 5 个不同角色的一个排列：" + pool.join("/"));
  assert.equal(new Set(pool).size, 5, "角色池是 5 个不同角色：" + pool.join("/"));
  const kindSet = {}; A.faceKinds.forEach(k => { kindSet[k] = 1; });
  assert.ok(pool.every(k => kindSet[k] === 1) && Object.keys(kindSet).length === pool.length,
    "角色池 = 5 位角色的一次真正排列（可复现随机，不是简单轮换）：" + JSON.stringify(pool));
  assert.equal(JSON.stringify(A.facePoolOf(A.facePoolSeed)), JSON.stringify(pool),
    "同一固定种子 → 同一套顺序（可复现）");
  assert.equal(JSON.stringify(A.facePoolOf(A.facePoolSeed)), JSON.stringify(A.facePoolOf(A.facePoolSeed)),
    "facePoolOf 是纯函数（连调两次结果一致）");
  /* 5 位顾客各取一个池内角色；第 6 位回到池首（轮换）*/
  const got = [0, 1, 2, 3, 4, 5].map(i => A.faceOf(i, 1).replace(/_(calm|urgent|happy)$/, ""));
  assert.equal(new Set(got.slice(0, 5)).size, 5, "顾客 0..4 拿到 5 个不同角色：" + got.slice(0, 5).join("/"));
  assert.equal(got[5], got[0], "第 6 位顾客回到池首（轮换）");
  assert.equal(got.join("/"), pool.concat([pool[0]]).join("/"), "角色分配与角色池顺序逐字一致");
  assert.ok(A.faceMoods.indexOf("happy") >= 0 && A.faceMoods.length === 3, "三态常量在册：calm/urgent/happy");
  assert.ok(A.faceIds.indexOf("fang_happy") >= 0 && A.faceIds.indexOf("lu_happy") >= 0,
    "女房东 / 女护士的「满意」贴图都切好了");
  /* 生成的名字必须在册（否则 assetOf 拿不到图 → 静默回退，测试就漏了）*/
  /* 本轮已把 stud / office / uncle 的 happy 三张补齐（见文件末尾新增测试）→
     15 张全在册；将来若再出现缺图，应在这里重新列一份 MISSING 并断言「运行期回退平静脸」。*/
  [0, 1, 2, 3, 4, 5].forEach(i => [0, 0.2, 0.4, 0.41, 1].forEach(r => {
    const n = A.faceOf(i, r);
    assert.ok(A.faceIds.indexOf(n) >= 0, "faceOf(" + i + "," + r + ") 的结果在册：" + n);
  }));
  [0, 1, 2, 3, 4, 5].forEach(i => {
    const n = A.faceOf(i, 1, true);
    const kind = n.replace(/^([a-z]+)_happy$/, "$1");
    assert.ok(A.faceIds.indexOf(n) >= 0, "happy 态在册（15 张已切齐，不再回退平静脸）：" + n + "（角色 " + kind + "）");
  });
});

test("回退路径写死在源码里：每一处贴图都有矢量兜底（缺素材也能玩）", () => {
  assert.ok(/function drawFoodVector\(/.test(SRC) && /function drawFoodImg\(/.test(SRC),
    "食材：drawFoodVector（矢量）+ drawFoodImg（贴图）两条路都在");
  assert.ok(/function drawAvatar\(/.test(SRC) && /drawAvatar\(g, box\.x \+ 38, box\.y \+ 58, 21, c\.id\);/.test(SRC),
    "头像：贴图拿不到时回退程序化头像 drawAvatar");
  assert.ok(/var gearImg = assetOf\(GEAR_ICON, gearNameOfKind\(s\.kind\)\);/.test(SRC) &&
    /\} else if \(s\.kind === "pot"\)/.test(SRC),
    "锅位：贴图优先，缺图回退矢量锅体（pot / griddle / steamer / counter / juicer 五条都在）");
  assert.ok(/var ptex = assetOf\(GEAR_ICON, plateTexOfFood\(p \? p\.food : null\)\);/.test(SRC),
    "盘位：贴图优先，缺图回退矢量盘");
  assert.ok(/if \(drawUiIcon\(g, "cross"/.test(SRC) && /g\.strokeStyle = PAL\.red; g\.lineWidth = 7;/.test(SRC),
    "糊了红叉：贴图优先，缺图回退红色矢量叉");
  assert.ok(/function bgDrawArgs\(/.test(SRC) && /function drawBg\(\) \{/.test(SRC),
    "背景：cover 参数 + 加载失败回退程序化底");
  assert.ok(/function drawStar\(/.test(SRC) && /function starPath\(/.test(SRC),
    "星级：stars.png 单颗星优先，缺图回退矢量星");
  assert.ok(/assetOf\(g, id\)/.test(SRC) && /naturalWidth/.test(SRC) && /complete !== false/.test(SRC),
    "统一就绪判定：naturalWidth > 0 且 complete !== false（未解码完就当没有）");
});


/* ═══════════════════════════════════════════════════════════════════════════
   本轮新增：盘面 6 张真的互不相同 / 背景 v2 优先 + 两级回退 / 头像三态与 5 人池
   ═══════════════════════════════════════════════════════════════════════════ */

/** 极简 PNG 解码（8bit、颜色类型 0/2/4/6、非隔行）——只为本文件里的「贴图真的不一样」取证 */
function decodePngRGBA(file) {
  const zlib = require("zlib");
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG：" + file);
  let p = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; color = d[9]; interlace = d[12]; }
    else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  assert.equal(depth, 8, "PNG 8bit：" + path.basename(file));
  assert.equal(interlace, 0, "PNG 非隔行：" + path.basename(file));
  const ch = color === 0 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : -1;
  assert.ok(ch > 0, "PNG 颜色类型可解（" + color + "）：" + path.basename(file));
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, px = Buffer.alloc(w * h * ch);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0, v = line[x];
      let r;
      if (ft === 0) r = v; else if (ft === 1) r = v + a; else if (ft === 2) r = v + b;
      else if (ft === 3) r = v + ((a + b) >> 1);
      else { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      cur[x] = r & 255;
    }
    cur.copy(px, y * stride); prev = cur;
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * ch;
    if (ch === 1) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[s]; rgba[i * 4 + 3] = 255; }
    else if (ch === 2) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[s]; rgba[i * 4 + 3] = px[s + 1]; }
    else if (ch === 3) { rgba[i * 4] = px[s]; rgba[i * 4 + 1] = px[s + 1]; rgba[i * 4 + 2] = px[s + 2]; rgba[i * 4 + 3] = 255; }
    else { rgba[i * 4] = px[s]; rgba[i * 4 + 1] = px[s + 1]; rgba[i * 4 + 2] = px[s + 2]; rgba[i * 4 + 3] = px[s + 3]; }
  }
  return { w, h, data: rgba };
}
/** 两张贴图的「不透明像素平均色」是否真的不同（阈值 6/255，肉眼可辨）*/
function meanColorOf(png) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < png.w * png.h; i++) {
    if (png.data[i * 4 + 3] < 128) continue;
    r += png.data[i * 4]; g += png.data[i * 4 + 1]; b += png.data[i * 4 + 2]; n++;
  }
  return n ? [r / n, g / n, b / n, n] : [0, 0, 0, 0];
}
function colorDist(a, b) { return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); }

test("本轮新增：盘面 6 张贴图在磁盘上真实存在，且「按食物映射」的 5 张互不相同（修掉共用一张图的老缺陷）", () => {
  const A = BF.art;
  const ids = A.plateTexIds;
  assert.equal(ids.length, 6, "盘面贴图 6 张：" + ids.join("/"));
  const loaded = {};
  ids.forEach(id => {
    const f = path.join(ROOT, "art", "icons", "gear", id + ".png");
    assert.ok(fs.existsSync(f), "盘面贴图真实存在：" + id + ".png");
    loaded[id] = decodePngRGBA(f);
    assert.ok(loaded[id].w >= 128 && loaded[id].h >= 128, id + ".png 尺寸够用：" + loaded[id].w + "×" + loaded[id].h);
  });
  /* 核心：映射到的 5 张盘贴图，两两「不透明像素的平均色」必须明显不同
     （老版本 egg/bacon 都指向 plate_egg_bacon → 差值 0 → 这条会直接挂） */
  const five = ["egg", "bacon", "sandwich", "bun", "salad"].map(f => A.plateTexOf(f));
  for (let i = 0; i < five.length; i++) for (let j = i + 1; j < five.length; j++) {
    const a = meanColorOf(loaded[five[i]]), b = meanColorOf(loaded[five[j]]);
    const d = colorDist(a, b);
    assert.ok(d > 6, "盘贴图 " + five[i] + " 与 " + five[j] + " 真的不是同一张（平均色差 " + d.toFixed(1) + "）");
    assert.ok(a[3] > 0 && b[3] > 0, "两张盘贴图都有不透明像素");
  }
  /* 空盘必须和任何一张「装了食物」的盘都不一样（保证空盘是空的）*/
  const empty = meanColorOf(loaded.plate_empty);
  ["plate_egg", "plate_bacon", "plate_sandwich", "plate_bun", "plate_salad"].forEach(id => {
    assert.ok(colorDist(empty, meanColorOf(loaded[id])) > 6, "空盘 plate_empty 与 " + id + " 明显不同");
  });
  /* 逐张「自有食物」清单与映射表一一对应（哪个文件配哪样菜，写死在这里当契约）*/
  const MAP = { plate_egg:"egg", plate_bacon:"bacon", plate_sandwich:"sandwich", plate_bun:"bun", plate_salad:"salad" };
  Object.keys(MAP).forEach(id => assert.equal(A.plateTexOf(MAP[id]), id, MAP[id] + " → " + id + "（盘面自带该食物）"));
  assert.equal(A.plateTexOf("milk"), "plate_empty", "没有专属盘的食材（牛奶）仍走空盘");
});

test("本轮新增：背景 v2 优先 + 两级回退（kitchen2 → kitchen → 程序化底），且 v2 是保整幅宽", () => {
  const A = BF.art;
  const bg = A.bg();
  assert.equal(JSON.stringify(A.bgSlots()), JSON.stringify(["kitchen2:kitchen2.png", "kitchen:kitchen.png"]),
    "背景候选顺序 = v2 在前、v1 兜底：" + A.bgSlots().join(" / "));
  assert.equal(bg.fallback.join(">"), "kitchen2>kitchen>vector", "回退链写死在 art.bg().fallback 里");
  assert.ok(fs.existsSync(path.join(ROOT, "art", "bg", "kitchen2.png")), "v2 素材真实存在：art/bg/kitchen2.png");
  assert.ok(fs.existsSync(path.join(ROOT, "art", "bg", "kitchen.png")), "v1 素材保留着（兜底用）：art/bg/kitchen.png");
  const k2 = decodePngRGBA(path.join(ROOT, "art", "bg", "kitchen2.png"));
  assert.equal(k2.w, BF.VIEW.w, "v2 是整幅宽（" + k2.w + "px = 画布宽），左右一处没裁");
  assert.ok(bg.srcWindow.w >= 2048, "v2 的源窗口覆盖整幅源宽：" + bg.srcWindow.w);
  /* v2 的「完整樱花树冠 / 完整货架」取证：左右两条边缘竖带里必须还有粉色（樱花）或暖木（货架）*/
  const band = 46;
  let pinkLeft = 0, pinkRight = 0;
  for (let y = 0; y < Math.round(k2.h * 0.45); y++) for (let x = 0; x < band; x++) {
    const i = (y * k2.w + x) * 4, j = (y * k2.w + (k2.w - 1 - x)) * 4;
    if (k2.data[i] > 170 && k2.data[i + 2] > 140 && k2.data[i + 1] < k2.data[i + 2]) pinkLeft++;
    if (k2.data[j] > 170 && k2.data[j + 2] > 140 && k2.data[j + 1] < k2.data[j + 2]) pinkRight++;
  }
  assert.ok(pinkLeft + pinkRight > 400, "左右边缘带里仍有樱花色像素（左 " + pinkLeft + " / 右 " + pinkRight + "）→ 树冠没被裁掉");
  /* 底部补带：最底一行必须仍是木台面色（不是纯色 / 不是黑边）*/
  let br = 0, bg2 = 0, bb = 0, n = 0;
  for (let x = 0; x < k2.w; x += 3) { const i = ((k2.h - 2) * k2.w + x) * 4; br += k2.data[i]; bg2 += k2.data[i + 1]; bb += k2.data[i + 2]; n++; }
  br /= n; bg2 /= n; bb /= n;
  assert.ok(br > 90 && br > bb + 25 && Math.abs(br - bg2) > 8, "画布最底一行是暖木色（rgb " +
    [br, bg2, bb].map(v => Math.round(v)).join(",") + "）→ 底部补带不是纯色块 / 黑边");
  assert.ok(/if \(bandH > 0\.5 && meta && nhB > 0\)/.test(SRC) && /bgBand/.test(SRC),
    "drawBg 里真的写了「底部木纹补带」这条分支");
  assert.ok(/for \(var by = bandY; by < VIEW\.h \+ 1; by \+= gh\)/.test(SRC),
    "补带是把木纹条纵向平铺（不是拉伸一整条）");
  assert.ok(/drawImage\(bimg, bargs\.sx, bargs\.sy, nwS, nhS, bargs\.dx, bargs\.dy, bargs\.dw, bargs\.dh\)/.test(SRC),
    "背景走 9 参 drawImage（源矩形 + 目标矩形），软件光栅化器能真出图");
});

test("本轮新增：顾客头像三态 + 5 人形象池（固定种子、可复现、不破坏布局）", () => {
  const A = BF.art;
  assert.equal(A.facePoolSeed, 20240918, "固定种子写成常量 FACE_POOL_SEED = 20240918");
  const p1 = A.facePoolOf(A.facePoolSeed), p2 = A.facePoolOf(A.facePoolSeed);
  assert.equal(JSON.stringify(p1), JSON.stringify(p2), "同种子 → 同顺序（可复现）");
  assert.equal(new Set(p1).size, 5, "角色池是 5 个不同角色");
  /* 「满意」这一态：订单全部拿到 → happy（与耐心无关），并且是常量化的判据 */
  assert.ok(/面向"|order.length > 0 且 done 覆盖全部 order/.test(A.faceSatisfiedRule), "满意判据可读：" + A.faceSatisfiedRule);
  assert.equal(A.faceSatisfied({ order:["egg", "bun"], done:["bun", "egg"] }), true, "顺序无关，全部拿到即满意");
  assert.equal(A.faceSatisfied({ order:["egg", "bun"], done:["egg"] }), false, "少一样 → 不是满意");
  assert.equal(A.faceSatisfied(null), false, "null 安全");
  assert.equal(A.faceMoodOf(0, 0.99, true), "happy", "满意优先于耐心（即使耐心 99%）");
  assert.equal(A.faceMoodOf(0, 0.41, false), "calm");
  assert.equal(A.faceMoodOf(0, 0.40, false), "urgent");
  /* 三态都真的切到了文件（5 位角色 × 3 情绪 = 15 张，本轮已全部切齐）*/
  const moods = {};
  [0, 1, 2, 3, 4].forEach(i => { [false, true].forEach(h => {
    const n = (h ? A.faceOf(i, 1, true) : A.faceOf(i, 0.9, false));
    moods[n] = true;
  }); });
  assert.ok(Object.keys(moods).length >= 8, "至少切到 8 张不同的头像：" + Object.keys(moods).join("/"));
  /* 布局不变式：卡位仍是 3 张、每张卡的头像框仍是 64×68（换头像不改布局）*/
  assert.equal(BF.LAY.cards.n, 3, "顾客卡位仍是 3 张（头像池从 3 扩到 5 不动布局）");
  assert.ok(/drawAssetFit\(g, img, \{ x: box\.x \+ 10, y: box\.y \+ 22, w: 64, h: 68 \}, null\)/.test(SRC.replace(/^ +/gm, "  ")),
    "头像绘制框仍是 64×68（耐心条 / 订单卡 / 勾选位置都没动）");
});

test("本轮新增：5 位角色头像贴图在磁盘上齐全（女房东 / 女护士 × 平急喜），且与上一轮 6 张并存", () => {
  const A = BF.art;
  const need = ["fang_calm", "fang_urgent", "fang_happy", "lu_calm", "lu_urgent", "lu_happy",
                "stud_calm", "stud_urgent", "stud_happy", "office_calm", "office_urgent", "office_happy",
                "uncle_calm", "uncle_urgent", "uncle_happy"];
  need.forEach(id => {
    const f = path.join(ROOT, "art", "icons", "faces", id + ".png");
    assert.ok(fs.existsSync(f), "头像贴图真实存在：" + id + ".png");
    assert.ok(A.faceIds.indexOf(id) >= 0, "头像贴图在册：" + id);
  });
  assert.equal(A.faceIds.length, 15, "头像贴图 15 张（5 位角色 × 平急喜）：" + A.faceIds.join("/"));
  /* 女房东的三态必须真的互不相同（平静 / 着急 / 满意 各一张）*/
  const f1 = meanColorOf(decodePngRGBA(path.join(ROOT, "art", "icons", "faces", "fang_calm.png")));
  const f2 = meanColorOf(decodePngRGBA(path.join(ROOT, "art", "icons", "faces", "fang_urgent.png")));
  const f3 = meanColorOf(decodePngRGBA(path.join(ROOT, "art", "icons", "faces", "fang_happy.png")));
  assert.ok(colorDist(f1, f2) > 6 && colorDist(f2, f3) > 6 && colorDist(f1, f3) > 6,
    "女房东三态是 3 张不同的图（色差 " + [colorDist(f1, f2), colorDist(f2, f3), colorDist(f1, f3)].map(v => v.toFixed(1)).join("/") + "）");
  const l1 = meanColorOf(decodePngRGBA(path.join(ROOT, "art", "icons", "faces", "lu_calm.png")));
  const l3 = meanColorOf(decodePngRGBA(path.join(ROOT, "art", "icons", "faces", "lu_happy.png")));
  assert.ok(colorDist(l1, l3) > 6, "女护士平静 ≠ 满意（色差 " + colorDist(l1, l3).toFixed(1) + "）");
  assert.ok(colorDist(f1, l1) > 6, "女房东 ≠ 女护士（两个角色不是同一张图）");
});

/* ═══════════════════════════════════════════════════════════════════════════
   本轮新增：三位顾客（学生 / 女白领 / 胖大爷）的「满意」贴图补齐
     · 贴图真的在磁盘上、真的在统一加载器在册、三个角色映射各自正确
     · 三张与各自的 calm 不是同一张图（真的换了表情，不是复制文件名）
     · 回退链仍是两级：happy 缺图 → calm → 矢量头像（源码里两条路都在）
   ═══════════════════════════════════════════════════════════════════════════ */
test("本轮新增：stud/office/uncle 的 happy 贴图补齐（15 张齐全）+ 映射 + 两级回退", () => {
  const A = BF.art;
  const THREE = ["stud_happy", "office_happy", "uncle_happy"];

  /* ① 文件真的在磁盘上，且是 192×192 的透明底 PNG（与既有 calm/urgent 同规格） */
  THREE.forEach(id => {
    const f = path.join(ROOT, "art", "icons", "faces", id + ".png");
    assert.ok(fs.existsSync(f), "满意的三张头像贴图真实存在：art/icons/faces/" + id + ".png");
    const p = decodePngRGBA(f);
    assert.equal(p.w, 192, id + " 是 192 宽（与既有头像同规格）");
    assert.equal(p.h, 192, id + " 是 192 高");
    /* 去白底：四角必须基本透明（白底已被抠成 alpha=0） */
    const corner = [[1, 1], [190, 1], [1, 190], [190, 190]];
    let opaqueCorner = 0;
    corner.forEach(function (c) { if (p.data[(c[1] * p.w + c[0]) * 4 + 3] > 40) opaqueCorner++; });
    assert.ok(opaqueCorner <= 1, id + " 四角已去白底（不透明角 " + opaqueCorner + "/4）");
  });

  /* ② 15 张（5 角色 × 3 情绪）全部在册 —— 一张不缺，happy 态不再靠回退 */
  const ALL = [];
  A.faceKinds.forEach(k => A.faceMoods.forEach(m => ALL.push(k + "_" + m)));
  assert.equal(ALL.length, 15, "期望 15 个「角色 × 情绪」组合");
  ALL.forEach(n => assert.ok(A.faceIds.indexOf(n) >= 0, "15 张全在统一加载器在册：" + n));
  assert.equal(A.faceIds.length, 15, "5 位角色 × 3 情绪，总数 15：" + A.faceIds.join("/"));

  /* ③ 映射：固定种子池顺序 → 每个角色都能拿到自己的 happy 名（不是都退到同一张） */
  const pool = A.facePoolFor(null);
  assert.equal(pool.length, 5, "角色池 5 位");
  const happyOf = {};
  for (let i = 0; i < 5; i++) {
    const n = A.faceOfIn(null, i, 1, true);          // 耐心 100 + 满意 → 必须是 happy
    const kind = n.replace(/_happy$/, "");
    assert.equal(n, pool[i] + "_happy", "顾客 #" + i + "（角色 " + pool[i] + "）满意态 → " + n);
    assert.ok(THREE.indexOf(n) >= 0 || /^(fang|lu)_happy$/.test(n), "happy 名落在 15 张清单里：" + n);
    happyOf[kind] = n;
  }
  assert.equal(new Set(Object.keys(happyOf)).size, 5, "5 位角色拿到 5 个不同的 happy 名");
  assert.equal(happyOf.stud, "stud_happy", "学生 → stud_happy");
  assert.equal(happyOf.office, "office_happy", "女白领 → office_happy");
  assert.equal(happyOf.uncle, "uncle_happy", "胖大爷 → uncle_happy");
  /* 满意优先于耐心：耐心 0 也是 happy（离场那一刻就是这张脸） */
  assert.equal(A.faceMoodOf(0, 0, true), "happy", "耐心 0 + 全部拿到 → 仍是 happy");

  /* ④ 三张 happy 与各自的 calm 必须是不同图（真的换了表情，不是同一张改名） */
  ["stud", "office", "uncle"].forEach(k => {
    const c = meanColorOf(decodePngRGBA(path.join(ROOT, "art", "icons", "faces", k + "_calm.png")));
    const h = meanColorOf(decodePngRGBA(path.join(ROOT, "art", "icons", "faces", k + "_happy.png")));
    assert.ok(colorDist(c, h) > 6, k + " 的 calm 与 happy 是两张不同的图（平均色差 " + colorDist(c, h).toFixed(1) + "）");
  });
  /* 三张 happy 互不相同（不是同一张图复制三份） */
  const hs = ["stud", "office", "uncle"].map(k => meanColorOf(decodePngRGBA(path.join(ROOT, "art", "icons", "faces", k + "_happy.png"))));
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
    assert.ok(colorDist(hs[i], hs[j]) > 6, "三位顾客的 happy 互不相同（" + i + "/" + j + " 色差 " + colorDist(hs[i], hs[j]).toFixed(1) + "）");
  }

  /* ⑤ 两级回退仍写死在源码里：happy 缺图 → 平静脸 → 矢量头像 */
  assert.ok(/if \(!img && mood === "happy"\) \{/.test(SRC),
    "drawCustomerFace：happy 取不到图时先退回平静脸（第二级）");
  assert.ok(/name = faceNameIn\(st0, c\.id, n, false\);/.test(SRC),
    "第二级用的正是「同一位角色的平静脸」（不是随便换人）");
  assert.ok(/drawAvatar\(g, box\.x \+ 38, box\.y \+ 58, 21, c\.id\);/.test(SRC),
    "第三级回退矢量头像 drawAvatar（缺素材也玩得下去）");
  assert.ok(/IA\.drawn\.faceHappyFallback/.test(SRC),
    "happy → calm 这一跳有计数（IA.drawn.faceHappyFallback），出图/探针可自证");
  /* 切片管线可复现：新三张由「3 列 × 1 行」图集脚本产出，脚本真的复用了既有 sliceGrid */
  const gen = fs.readFileSync(path.join(ROOT, "tools", "bf", "assets", "faces-happy-gen.js"), "utf8");
  assert.ok(/require\("\.\/gen2\.js"\)/.test(gen) && /A2\.sliceGrid\(/.test(gen),
    "切片脚本复用 tools/bf/assets/gen2.js 的 sliceGrid（未重写抠图/缩放算法）");
  assert.ok(/rows: 1, cols: 3/.test(gen) && /target: 192, pad: 8/.test(gen),
    "切片参数：3 列 × 1 行、192px、pad 8（与既有 faces 组一致）");
  /* 源图集按「素材契约」属于可选的原始生成物：在库就一并校验，不在库不算失败
     ——避免留下一条只有本机才过的断言（素材不入库是既有纪律，见 SOURCES.md 第五节）。 */
  const grid = path.join(ROOT, "art", "lovart_cca01cd7ba70.png");
  if (fs.existsSync(grid)) {
    const g = decodePngRGBA(grid);
    assert.ok(g.w === 2172 && g.h === 724, "源图集尺寸仍是 3 列 × 1 行（2172×724），切片参数未过时");
  } else {
    console.log("  [skip] art/lovart_cca01cd7ba70.png 不在库（素材分发体系下属可选项）；三张切片产物已单独校验");
  }
});


/* ═══════════════════════════════════════════════════════════════════════════
   9. 音效 / 顾客语音（bf-audio-1）

   用户三条要求 → 本节的断言：
     ① 顾客耐心快到时要有「滴答」倒计时提示音（≤30% 开始，越急越密，全局只一条，人走即停）
     ② 顾客拿到早餐 → 高兴的「呜呼～」（一次成功上餐只播一次，音量适中）
     ③ 等太久走掉的顾客 → 「哼，太慢了」（同一帧多人离开也只播一次）
     外加：开关关掉三类音都不播；素材缺失 / 没有 Audio / 播放被拦 → 静默不抛错。

   脚手架：`rules.audio.hook(fn)` 注入一个**只记录不发声**的播放器。
     断言看的是**调用序列**（谁、哪个文件、什么音量、第几次），完全不依赖浏览器音频栈；
     纯逻辑 vm 里本来就没有 Audio / localStorage —— 那正好也是「素材缺失」那条用例的真实环境。
   ═══════════════════════════════════════════════════════════════════════════ */
const mp3info = require("../tools/bf/mp3info.js");

const PLAYS = [];                        // hook 收到的播放序列（每个用例开头清空）
/** 开声音 + 挂钩子 + 清记录 */
function audioArmed() {
  R.audio.setEnabled(true);
  R.audio.hook(function (r) { PLAYS.push(r); });
  R.audio.clear(); PLAYS.length = 0;
}
/** 关声音（钩子留着，验证「一条都不播」而不是「没挂钩子」）*/
function audioMuted() {
  R.audio.setEnabled(false);
  R.audio.clear(); PLAYS.length = 0;
}
/** 回到「环境里没有 Audio、也没有钩子」的默认态（每个用例收尾都调它，避免串场）*/
function audioUnhook() {
  R.audio.hook(null); R.audio.setEnabled(true); R.audio.clear(); PLAYS.length = 0;
}
const played = (name) => PLAYS.filter(p => p.name === name);
/** 把某位顾客的耐心定在指定比例（配合每帧回填，避免边跑边掉档）*/
function hold(c, ratio) { c.patienceMax = 1000; c.patience = ratio * 1000; }

test("音效①：滴答阈值 —— 耐心 31% 不响、29% 响（TICK_AT = 0.30 可调）", () => {
  assert.equal(R.audio.TICK_AT, 0.30, "阈值常量 TICK_AT = 0.30");
  assert.equal(R.audio.SOUND_KEY, "bfSoundOn", "开关键就是用户指定的 localStorage.bfSoundOn");
  audioArmed();
  const st = plateState();                       // duration 999 / goal 99 / 不自动进店
  const c = R.spawnCustomer(st);
  hold(c, 0.31);
  R.step(st, 1 / 60);
  assert.equal(played("tick").length, 0, "31%（>30%）不播滴答");
  assert.equal(R.audio.tickDue(st), false, "tickDue() 同判 false");
  hold(c, 0.29);
  R.step(st, 1 / 60);
  assert.equal(played("tick").length, 1, "29%（≤30%）当帧就响一条");
  assert.equal(played("tick")[0].url, "audio/bf/tick.mp3", "播的是 audio/bf/tick.mp3");
  assert.ok(played("tick")[0].volume > 0 && played("tick")[0].volume < 0.6,
    "滴答音量压得低（" + played("tick")[0].volume + "）");
  audioUnhook();
});

test("音效①：滴答节奏 —— 30% 档 1.0s 一下、10% 档 0.5s 一下（越急越密）", () => {
  assert.equal(R.audio.tickGapFor(0.29), 1.0, "30% 档 → 1.0s");
  assert.equal(R.audio.tickGapFor(0.09), 0.5, "10% 档 → 0.5s");
  assert.equal(R.audio.TICK_GAP_FAR > R.audio.TICK_GAP_NEAR, true, "远档间隔确实更长");
  const st = plateState();
  const c = R.spawnCustomer(st);
  c.patienceMax = 1000;
  function runFor(ratio, seconds) {              // 同一局里换档跑同样长的窗口
    audioArmed();
    c.patience = ratio * 1000;
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n; i++) { R.step(st, 1 / 60); c.patience = ratio * 1000; }
    return played("tick").length;
  }
  const far = runFor(0.29, 3.0);
  const near = runFor(0.09, 3.0);
  assert.equal(far, 3, "30% 档 3 秒响 3 下（0 / 1 / 2 秒）");
  assert.equal(near, 6, "10% 档 3 秒响 6 下（每 0.5 秒一下）");
  assert.ok(near > far, "越急越密：" + far + " → " + near);
  audioUnhook();
});

test("音效①：滴答全局节流 —— 两位顾客同时低耐心，同一时刻只有一条", () => {
  audioArmed();
  const st = plateState();
  const a = R.spawnCustomer(st), b = R.spawnCustomer(st);
  hold(a, 0.05); hold(b, 0.05);                  // 两位都在 5%
  R.step(st, 1 / 60);
  assert.equal(played("tick").length, 1, "同一帧只播一条（不是每位顾客各一条）");
  for (let i = 0; i < 60; i++) { R.step(st, 1 / 60); a.patience = b.patience = 50; }
  const n = played("tick").length;
  /* 逐位顾客各播一条的实现，这一秒会响 4~6 下；单通道节流最多 3 下 */
  assert.ok(n >= 2 && n <= 3, "1 秒内 " + n + " 条（单通道 0.5s 档，≤3）");
  assert.equal(played("tick").every(p => p.url === "audio/bf/tick.mp3"), true, "全是同一条滴答素材");
  audioUnhook();
});

test("音效①：顾客离开 / 被服务完 → 立刻停滴答", () => {
  audioArmed();
  const st = plateState();
  const c = R.spawnCustomer(st, ["egg"]);
  hold(c, 0.01);                                 // 1% —— 已经进入 10% 档
  R.step(st, 1 / 60);
  assert.equal(played("tick").length, 1, "先正常响一条");
  const col = R.columnOf("egg");
  cookTo(st, "egg", R.FOOD.egg.dur, true);
  assert.equal(R.takePlate(st, col), true);
  const r = R.serveFromColumn(st, col);
  assert.equal(r.ok, true, "服务成功");
  const nAfterServe = played("tick").length;
  for (let i = 0; i < 90; i++) R.step(st, 1 / 60);
  assert.equal(played("tick").length, nAfterServe, "拿齐订单后 1.5 秒内不再滴答（人已不催）");
  /* 反过来：另一位等太久走掉之后也不能继续滴答 */
  const st2 = plateState();
  const c2 = R.spawnCustomer(st2);
  hold(c2, 0.01);
  R.step(st2, 1 / 60);
  c2.patience = 0.001;                           // 下一帧跑单
  PLAYS.length = 0;
  R.step(st2, 1 / 60);
  assert.equal(c2.left, true, "顾客走掉");
  assert.equal(played("tick").length, 0, "他走的那一帧就不再滴答");
  assert.equal(played("slow").length, 1, "取而代之是「哼，太慢了」");
  audioUnhook();
});

test("音效②：拿到早餐 → 播欢呼（一次成功上餐只播一次，变体 6 选 1 · bf-9 重做）", () => {
  audioArmed();
  const st = plateState();
  const c = R.spawnCustomer(st, ["egg"]);
  longPatience(c);
  const col = R.columnOf("egg");
  cookTo(st, "egg", R.FOOD.egg.dur, true);
  assert.equal(R.takePlate(st, col), true);
  const r = R.serveFromColumn(st, col);
  assert.equal(r.ok, true, "服务成功");
  assert.equal(r.customer, c, "送给了点煎蛋的那位");
  const h = played("happy");
  assert.equal(h.length, 1, "只播一次欢呼（不是每个分支都播一遍）");
  /* bf-11：用户重新拍板 —— 欢呼池换成 4 条（含「终于好啦」那条的**不含「呜呼」**版本）。
     原断言：/^audio\/bf\/happy_(?:v[1-6]|alt[23])\.mp3$/  （bf-10 的 6 条池）
     新断言：/^audio\/bf\/happy_(?:v[13]|i45|finally2)\.mp3$/ （bf-11 的 4 条池）
     原因：用户原话「换成不含『呜呼』的版本」→ happy_v2（「呜呼！终于好啦！」）被换成
     happy_finally2（「太棒啦！终于好啦！」）；同时 alt2 / alt3 / v5 / v6 已不在池里，
     所以正则不能再放它们进来（否则「播了池外的文件」也能通过 = 断言失去意义）。*/
  assert.ok(/^audio\/bf\/happy_(?:v[13]|i45|finally2)\.mp3$/.test(h[0].url),
    "取的是最终 4 条池里的一条：" + h[0].url);
  assert.ok(h[0].volume >= 0.3 && h[0].volume <= 0.8, "音量适中：" + h[0].volume);
  assert.equal(played("tick").length, 0, "不误放滴答");
  assert.equal(played("slow").length, 0, "不误放「哼，太慢了」");
  /* 最终池就是用户拍板的 4 条（顺序也照拍板结果写死，改池必须同步这里）
     原：["happy_v1.mp3","happy_alt2.mp3","happy_v3.mp3","happy_alt3.mp3","happy_v5.mp3","happy_v6.mp3"]（6 条）
     新：["happy_v1.mp3","happy_v3.mp3","happy_finally2.mp3","happy_i45.mp3"]（4 条）
     原因：用户 bf-11 点名「终于好啦 / 开动啦 / v3 / i45」，并追加「换成不含『呜呼』的版本」。 */
  jsonEq(R.audio.FILES.happy, ["happy_v1.mp3", "happy_v3.mp3",
                               "happy_finally2.mp3", "happy_i45.mp3"]);
  assert.equal(R.audio.FILES.happy.length, 4, "4 条都在轮换池（随机取、不连重）");

  R.audio.FILES.happy.forEach((f, i) => {
    assert.ok(fs.existsSync(path.join(ROOT, "audio", "bf", f)), "audio/bf/" + f + " 在盘上");
  });

  /* 同一次服务只播一次：再调一次同一份出餐（盘已空）不会重复播 */
  const again = R.serveFromColumn(st, col);
  assert.equal(again.ok, false, "盘空了 → 出餐被拒");
  assert.equal(played("happy").length, 1, "仍然是 1 次");
  audioUnhook();
});

test("音效②：糊的端上桌不播「呜呼」（顾客是被气走的，不该欢呼）", () => {
  audioArmed();
  const st = plateState();
  const c = R.spawnCustomer(st, ["egg"]);
  longPatience(c);
  const col = cookWalk(st, "egg", "burnt");       // 一路煮到糊
  assert.equal(R.takePlate(st, col), true, "糊的也能落到盘上（规则不变：只能丢 / 端上去气人）");
  const r = R.serveCustomer(st, ci(st, c), R.plateIdxOfStation(st, col));
  assert.equal(r.kind, "burnt", "确实走了「糊菜上桌」分支");
  assert.equal(played("happy").length, 0, "没有「呜呼」");
  assert.equal(played("slow").length, 0, "「哼，太慢了」只属于「等太久走掉」，糊菜上桌不算");
  audioUnhook();
});

test("音效③：等太久走掉 → 播「哼，太慢了」（同一帧多人离开也只播一次）", () => {
  audioArmed();
  const st = plateState();
  const a = R.spawnCustomer(st), b = R.spawnCustomer(st);
  hold(a, 0.01); hold(b, 0.01);
  a.patience = 0.001; b.patience = 0.001;         // 两位同一帧耗光
  R.step(st, 1 / 60);
  assert.equal(a.left === true && a.angry === true, true, "顾客 A 生气离开");
  assert.equal(b.left === true && b.angry === true, true, "顾客 B 生气离开");
  const s = played("slow");
  assert.equal(s.length, 1, "同一帧两位离开 → 只播一次");
  assert.equal(s[0].url, "audio/bf/slow.mp3", "播的是 audio/bf/slow.mp3");
  assert.ok(s[0].volume >= 0.3 && s[0].volume <= 0.8, "音量适中：" + s[0].volume);
  assert.equal(played("happy").length, 0, "走掉不播「呜呼」");
  /* 隔得够久再走一位 → 会再响一次（节流不是「一局只响一次」）*/
  const c3 = R.spawnCustomer(st);
  hold(c3, 0.01); c3.patience = 0.001;
  R.step(st, 1 / 60);
  assert.equal(played("slow").length, 1, "同帧内仍只有一条");
  for (let i = 0; i < 120; i++) R.step(st, 1 / 60);       // 推进 2 秒（> SLOW_MIN_GAP）
  const c4 = R.spawnCustomer(st);
  hold(c4, 0.01); c4.patience = 0.001;
  R.step(st, 1 / 60);
  assert.equal(played("slow").length, 2, "过了节流窗口后新一位走掉 → 再响一条");
  audioUnhook();
});

test("音效：开关关闭 → 三类音一条都不播（记录里标 off）", () => {
  audioMuted();
  /* 三种触发各走一遍：滴答（还在等的最急那位）/ 跑单（等太久走掉）/ 服务成功（呜呼）*/
  const st = plateState();
  const c = R.spawnCustomer(st);
  hold(c, 0.10);                       // 10%：进滴答档，但这一帧还不至于走
  R.step(st, 1 / 60);                  // → 滴答
  c.patience = 0.001;
  R.step(st, 1 / 60);                  // → 等太久走掉 → 「哼，太慢了」
  /* 服务成功那条路 */
  const st2 = plateState();
  const c2 = R.spawnCustomer(st2, ["egg"]);
  longPatience(c2);
  const col = R.columnOf("egg");
  cookTo(st2, "egg", R.FOOD.egg.dur, true);
  R.takePlate(st2, col);
  assert.equal(R.serveFromColumn(st2, col).ok, true);
  assert.equal(PLAYS.length, 0, "钩子一次都没被调用（三类音全不播）");
  assert.equal(R.audio.plays().length, 0, "plays() 也是空");
  const log = R.audio.log();
  assert.ok(log.length >= 3, "但每次触发都留了记录（可诊断）：" + log.length + " 条");
  assert.equal(log.every(r => r.ok === false && r.why === "off"), true,
    "记录全是 off：" + JSON.stringify(log.map(r => r.why)));
  const names = log.map(r => r.name);
  assert.equal(["tick", "happy", "slow"].every(n => names.indexOf(n) >= 0), true,
    "三类触发都留下了 off 记录：" + names.join(","));
  audioUnhook();
});

test("音效：素材缺失 / 没有 Audio / 播放器抛错 → 全部静默，玩法不受影响", () => {
  /* ① 环境里根本没有 Audio（纯逻辑 vm 就是这样）—— 不许抛错，只记 why:"no-audio" */
  R.audio.hook(null); R.audio.setEnabled(true); R.audio.clear(); PLAYS.length = 0;
  const st = plateState();
  const c = R.spawnCustomer(st);
  hold(c, 0.10);
  assert.doesNotThrow(() => R.step(st, 1 / 60), "低耐心触发滴答时不抛错");
  c.patience = 0.001;
  assert.doesNotThrow(() => R.step(st, 1 / 60), "跑单触发语音时不抛错");
  /* 服务成功那条路也走一遍（呜呼）*/
  const stS = plateState();
  const cS = R.spawnCustomer(stS, ["egg"]);
  longPatience(cS);
  const colS = R.columnOf("egg");
  cookTo(stS, "egg", R.FOOD.egg.dur, true);
  R.takePlate(stS, colS);
  assert.doesNotThrow(() => R.serveFromColumn(stS, colS), "上餐成功触发呜呼时不抛错");
  const log = R.audio.log();
  assert.ok(log.length >= 3, "三类触发都留了记录：" + log.length + " 条");
  assert.equal(log.every(r => r.ok === false && r.why === "no-audio"), true,
    "全记 no-audio：" + JSON.stringify(log.map(r => r.why)));
  const names0 = log.map(r => r.name);
  assert.equal(["tick", "happy", "slow"].every(n => names0.indexOf(n) >= 0), true,
    "三类音都尝试过：" + names0.join(","));
  assert.equal(R.audio.plays().length, 0, "plays() 里没有「播成功」的记录");
  /* ② 播放器抛错（模拟文件坏 / 被浏览器自动播放策略拦）—— 同样不许冒泡 */
  R.audio.hook(function () { throw new Error("blocked by policy"); });
  const st2 = plateState();
  const c2 = R.spawnCustomer(st2);
  hold(c2, 0.01); c2.patience = 0.001;
  assert.doesNotThrow(() => R.step(st2, 1 / 60), "钩子抛错也不冒泡");
  assert.equal(R.audio.plays().every(r => r.ok === false), true, "抛错的记录被标掉（不冒充成功）");
  assert.ok(R.audio.log().some(r => r.why === "sink-error"), "记录里能看到 sink-error");
  /* ③ 源码层面的三条回落路径都写死了（可被静态核对） */
  assert.ok(/typeof A !== "function"\) return rec\(name, i, false, "no-audio", at\)/.test(SRC),
    "没有 Audio → 记 no-audio 后静默返回");
  assert.ok(/pr\.catch\(function \(\) \{ r\.ok = false; r\.why = "blocked"; \}\)/.test(SRC),
    "play() 返回的 Promise 被拦 → catch 吞掉（不 unhandled rejection）");
  assert.ok(/a\.addEventListener\("error", function \(\) \{ r\.ok = false; r\.why = "load-error"; \}\)/.test(SRC),
    "文件缺失（404 / 解码失败）→ error 事件只标记录，不弹错");
  audioUnhook();
});

test("音效：不打断别人的语音 + 台账 / 徽章接口齐全（对页面层友好）", () => {
  /* 本模块只 new 自己的 Audio：既不 pause() 别人，也不排队别人的语音（麻将队列在 mahjong.js）*/
  assert.ok(!/\.pause\(\)/.test(SRC), "breakfast.js 里没有任何 .pause()（不会打断正在播的语音）");
  assert.ok(/stepAudio\(st, leftNow\)/.test(SRC), "音频调度挂在 step() 里（无定时器、不额外起循环）");
  /* 台账 / UI 钩子：无头与浏览器验收都读它们 */
  ["TICK_AT", "TICK_GAP_FAR", "TICK_GAP_NEAR", "TICK_MIN_GAP", "HAPPY_MIN_GAP", "SLOW_MIN_GAP",
   "SOUND_KEY", "DIR", "FILES", "VOL", "plays", "log", "hook", "setEnabled", "tickDue",
   "tickGapFor", "minPatienceRatio", "patienceRatioOf", "stepAudio", "newAudioState",
   "playHappy", "playSlow", "soundBox", "soundLabel", "toggleSound"].forEach(k => {
    assert.ok(R.audio[k] !== undefined, "rules.audio." + k + " 存在");
  });
  /* 徽章命中框落在图例条里（不会压到别的东西） */
  const sb = R.audio.soundBox();
  assert.ok(sb && sb.w > 60 && sb.h >= 18, "徽章尺寸合理：" + JSON.stringify(sb));
  /* 缺 st.audio 的老状态对象也不能炸（防御性）*/
  assert.doesNotThrow(() => R.audio.stepAudio({ elapsed: 0 }, false), "stepAudio 对残缺 state 安全");
  assert.equal(R.audio.stepAudio(null, true), undefined, "state 为 null 直接返回");
  audioUnhook();
});

test("音效②：连着一单三样不叠声 —— HAPPY_MIN_GAP 节流（同一时刻只响一条）", () => {
  audioArmed();
  const st = plateState();
  const c = R.spawnCustomer(st, ["egg", "bacon", "juice"]);
  longPatience(c);
  const serveOne = (food) => {                      // 做一份 + 落盘 + 端给同一位顾客
    const col = R.columnOf(food);
    cookTo(st, food, R.FOOD[food].dur, true);
    assert.equal(R.takePlate(st, col), true, food + " 落到第 " + col + " 列");
    return R.serveFromColumn(st, col);
  };
  assert.equal(serveOne("egg").ok, true, "第一样端上去");
  assert.equal(serveOne("bacon").ok, true, "紧接着第二样端上去（同一时刻）");
  assert.equal(played("happy").length, 1, "同一时刻连续上两样 → 只播一条「呜呼」（不叠声）");
  assert.ok(R.audio.HAPPY_MIN_GAP >= 0.8,
    "节流窗口 ≥ 最短那条喊声的长度（0.91s），不然两句会盖在一起：" + R.audio.HAPPY_MIN_GAP);
  advance(st, R.audio.HAPPY_MIN_GAP + 0.3);         // 推过窗口
  assert.equal(serveOne("juice").ok, true, "第三样（过了节流窗口）端上去");
  assert.equal(played("happy").length, 2, "过窗口后再上餐 → 再响一条（节流不是「一局只响一次」）");
  assert.equal(played("tick").length, 0, "全程不误放滴答（耐心满）");
  audioUnhook();
});

/* ═══════════════════════════════════════════════════════════════════════════
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
  cb.patienceMax = 30;
  const colB = cookWalk(st, "egg", "burnt");     // ⚠ 这一段按真实帧推进 ≈3.8s+，耐心会掉
  cb.patience = 12;                              // 所以耐心要摆到「上餐前一刻」再定值
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

test("兼容：IE11/Trident 没有 Canvas2D.ellipse → 幂等 polyfill（原生有就一个字节都不改）", () => {
  /* 事故背景：tools/e2e/bf.js 的模式 B 探针跑在 mshta(Trident/IE11) 里，
     实测弹「对象不支持 ellipse 属性或方法」的脚本错误对话框（breakfast.js 行 2387）。
     项目约束是「ES5 + IE11 也能画」，所以补了贝塞尔版 polyfill。 */
  assert.equal(typeof R.installEllipsePolyfill, "function", "polyfill 暴露在 rules 上供测试直调");

  function mkCtx(hasEllipse) {
    const c = { moved: [], segs: [], bez: 0, ellipseCalls: 0 };
    c.moveTo = (x, y) => c.moved.push([x, y]);
    c.bezierCurveTo = (a, b, d, e, f, g) => { c.bez++; c.segs.push([[a, b], [d, e], [f, g]]); };
    if (hasEllipse) c.ellipse = function () { c.ellipseCalls++; };
    return c;
  }

  /* ① 装上之后真的能画：整圆 = 4 段（每段 ≤90°），起点/终点都在 (x+rx, y)，闭合 */
  const c1 = mkCtx(false);
  assert.equal(R.installEllipsePolyfill(c1), true, "缺 ellipse → 装上");
  assert.equal(typeof c1.ellipse, "function");
  c1.ellipse(10, 20, 30, 30, 0, 0, Math.PI * 2);
  assert.equal(c1.bez, 4, "整圆 = 4 段三次贝塞尔");
  assert.ok(Math.abs(c1.moved[0][0] - 40) < 1e-9 && Math.abs(c1.moved[0][1] - 20) < 1e-9,
    "起点 = θ=0 的点 (x+rx, y)：" + JSON.stringify(c1.moved[0]));
  const last = c1.segs[3][2];
  assert.ok(Math.abs(last[0] - 40) < 1e-9 && Math.abs(last[1] - 20) < 1e-9, "最后一段回到起点（闭合）");
  c1.segs.forEach(s => {
    const p = s[2], d = Math.hypot(p[0] - 10, p[1] - 20);
    assert.ok(Math.abs(d - 30) < 1e-6, "每个端点都落在圆上（半径 " + d.toFixed(6) + "）");
  });
  /* 控制点要落在「贝塞尔近似」该在的位置：第一段从 θ=0 出发、沿 +y 切出，
     所以 kappa 体现在**纵坐标**偏移上（c1 = (x+rx, y + k·ry)，k ≈ 0.5523）*/
  const kappa = Math.abs(c1.segs[0][0][1] - 20) / 30;
  assert.ok(kappa > 0.5 && kappa < 0.6,
    "第一段控制点纵偏移 / r ≈ 0.5523（贝塞尔近似系数）：" + kappa.toFixed(4));

  /* ② 幂等 + 绝不覆盖原生（＝ Chrome/Edge 的外观与行为完全不变）*/
  assert.equal(R.installEllipsePolyfill(c1), false, "装第二次 → false，不重复包装");
  const c2 = mkCtx(true);
  assert.equal(R.installEllipsePolyfill(c2), false, "原生有 ellipse → 不动它");
  c2.ellipse(0, 0, 1, 1, 0, 0, 1);
  assert.equal(c2.ellipseCalls, 1, "调用仍然走原生");
  assert.equal(c2.bez, 0, "没有偷偷替换成贝塞尔");

  /* ③ 椭圆 + rotation：端点落在**旋转后**的椭圆上（不是随便糊一段曲线）*/
  const c3 = mkCtx(false); R.installEllipsePolyfill(c3);
  c3.ellipse(0, 0, 40, 10, Math.PI / 2, 0, Math.PI * 2);
  assert.equal(c3.bez, 4, "椭圆整圈同样是 4 段");
  c3.segs.forEach(s => {
    const p = s[2];
    /* 长轴 40、短轴 10、再转 90° → (x/10)² + (y/40)² = 1 */
    const v = Math.pow(p[0] / 10, 2) + Math.pow(p[1] / 40, 2);
    assert.ok(Math.abs(v - 1) < 1e-6, "落在旋转后的椭圆上（值 " + v.toFixed(9) + "）");
  });

  /* ④ 边界：半径 0 / 负半径 / 半圈 / counterclockwise */
  const c4 = mkCtx(false); R.installEllipsePolyfill(c4);
  assert.doesNotThrow(() => c4.ellipse(0, 0, 0, 5, 0, 0, Math.PI * 2), "半径 0 不抛错");
  assert.equal(c4.bez, 0, "半径 0 → 什么都不加进路径（与原生一致）");
  assert.doesNotThrow(() => c4.ellipse(0, 0, -5, -5, 0, 0, Math.PI * 2), "负半径按绝对值处理（不抛错）");
  assert.equal(c4.bez, 4, "负半径照样画出整圆");
  c4.bez = 0;
  c4.ellipse(0, 0, 5, 5, 0, 0, Math.PI);
  assert.equal(c4.bez, 2, "半圈 = 2 段");
  c4.bez = 0;
  c4.ellipse(0, 0, 5, 5, 0, 0, -Math.PI, true);
  assert.equal(c4.bez, 2, "顺时针半圈 = 2 段");
  /* ⑤ 没有 bezierCurveTo 的环境（极简替身）→ 明确返回 false，不许抛 */
  const c5 = { moveTo() {} };
  assert.equal(R.installEllipsePolyfill(c5), false, "画不了的环境返回 false（不硬装）");
  assert.equal(R.installEllipsePolyfill(null), false, "传 null 也安全");
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

test("音效：audio/bf 素材在磁盘上齐全，且规格统一（tick ≤120ms / 48kHz / 单声道）", () => {
  const dir = path.join(ROOT, "audio", "bf");
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
  /* 对照件（B 组）留在盘上、但**不在**任何通道里（不参与轮换）。
     bf-10：alt2 / alt3 被用户挑中、**已进轮换池** → 从「不参与」这张清单里移出，
     改成单独断言它们真的在池子里（见下面那段），清单里只留仍未启用的 4 条。 */
  ["happy_alt1.mp3", "happy_alt4.mp3", "happy_alt5.mp3", "happy_alt6.mp3"].forEach(f => {
    assert.ok(fs.existsSync(path.join(dir, f)), "对照件 audio/bf/" + f + " 还在（试听页要用）");
    assert.equal(R.audio.NAMES.some(n => R.audio.FILES[n].indexOf(f) >= 0), false,
      f + " 不参与轮换（只在试听页里出现）");
  });
  /* bf-11：**哪 4 条在轮换池里** + 它们都在盘上、规格与其余欢呼一致。
     原断言（bf-10）：["happy_alt2.mp3","happy_alt3.mp3"] 已进轮换池
     新断言（bf-11）：["happy_v1.mp3","happy_v3.mp3","happy_finally2.mp3","happy_i45.mp3"] 进池
     原因：用户 bf-11 重新点名了 4 条，并要求把「终于好啦」那条换成**不含「呜呼」**的版本
     （happy_v2 → happy_finally2）；alt2 / alt3 随之出池。
     这一条同时守住「代码点名的每条都真的在盘上」——happy_finally2.mp3 是新文件，
     万一没落盘，就是静默 404，只有这里能拦住。 */
  ["happy_v1.mp3", "happy_v3.mp3", "happy_finally2.mp3", "happy_i45.mp3"].forEach(f => {
    assert.equal(R.audio.FILES.happy.indexOf(f) >= 0, true, f + " 在轮换池里（用户 bf-11 拍板）");
    const info = mp3info.mp3Info(path.join(dir, f));
    assert.equal(info.sampleRate, 48000, f + " 是 48kHz");
    assert.equal(info.channels, 1, f + " 是单声道");
    assert.ok(info.decoded > 0.4 && info.decoded <= 3.0,
      f + " 时长 " + info.decoded.toFixed(2) + "s（0.4~3s）");
  });
  /* happy_v2 已出池（用户否决「呜呼」），但**文件仍留在盘上**供对比 */
  assert.equal(R.audio.FILES.happy.indexOf("happy_v2.mp3"), -1, "happy_v2.mp3 已不在任何播放通道里");
  assert.ok(fs.existsSync(path.join(dir, "happy_v2.mp3")), "happy_v2.mp3 文件仍留在盘上（对比用）");
  /* 池里的「终于好啦」那条**不许含「呜呼」** —— 这正是本轮替换的目的，写成断言防止回退 */
  const finallyName = R.audio.FILES.happy.filter(f => f.indexOf("finally") >= 0);
  assert.equal(finallyName.length, 1, "池里有且只有一条 happy_finally*.mp3（本轮新换的「终于好啦」）");
  /* 池里唯一那条「终于好啦」必须就是 happy_finally2.mp3（内容 = 实测上扬的 happy_n56 的副本）*/
  assert.equal(finallyName[0], "happy_finally2.mp3", "「终于好啦」那条 = happy_finally2.mp3");
  /* 它的字节数必须与摇出来的源件 happy_n56.mp3 一致 —— 防止「复制时拷错文件」这类静默事故
     （本轮它就是 happy_n56.mp3 的副本；尺寸对不上说明接错了源）*/
  const srcN56 = path.join(dir, "happy_n56.mp3");
  if (fs.existsSync(srcN56)) {
    assert.equal(fs.statSync(path.join(dir, "happy_finally2.mp3")).size, fs.statSync(srcN56).size,
      "happy_finally2.mp3 与源件 happy_n56.mp3 尺寸一致（接对了源）");
  }

  Object.keys(R.audio.COOK_FILES).forEach(f => {
    const info = mp3info.mp3Info(path.join(dir, R.audio.COOK_FILES[f]));
    assert.ok(info.decoded > 0.2 && info.decoded <= 0.8,
      R.audio.COOK_FILES[f] + " 解码时长 " + (info.decoded * 1000).toFixed(0) + "ms（0.2~0.8s）");
  });
  /* 滴答必须「短促」：按**逐帧解码长度**算（播放器真正会播的长度，含编码器填充）*/
  const tick = mp3info.mp3Info(path.join(dir, "tick.mp3"));
  assert.ok(tick.decoded > 0.02 && tick.decoded <= 0.120,
    "tick.mp3 解码长度 " + (tick.decoded * 1000).toFixed(0) + "ms ≤120ms（硬性要求）");
  assert.ok(tick.duration <= 0.120, "tick.mp3 gapless 时长也 ≤120ms：" + (tick.duration * 1000).toFixed(0) + "ms");
  /* 六条欢呼 + 一条「太慢了」都要有人声时长（>0.4s），不是空文件 */
  ["happy_v1.mp3", "happy_v2.mp3", "happy_v3.mp3", "happy_v4.mp3", "happy_v5.mp3",
   "happy_v6.mp3", "slow.mp3"].forEach(f => {
    const info = mp3info.mp3Info(path.join(dir, f));
    assert.ok(info.decoded > 0.4, f + " 时长 " + (info.decoded * 1000).toFixed(0) + "ms，像一条语音");
  });
  /* 欢呼不能太长（一边上餐一边还在喊会叠声）：6 条都 ≤ 3s */
  R.audio.FILES.happy.forEach(f => {
    const info = mp3info.mp3Info(path.join(dir, f));
    assert.ok(info.decoded <= 3.0, f + " 时长 " + info.decoded.toFixed(2) + "s ≤ 3s");
  });
test("音效：bf-11 最终轮换池 = 用户拍板的 4 条（v1/v3/finally2/i45 · 随机不连重）", () => {
  const dir = path.join(ROOT, "audio", "bf");
  /* 原（bf-10）：["happy_v1.mp3","happy_alt2.mp3","happy_v3.mp3","happy_alt3.mp3","happy_v5.mp3","happy_v6.mp3"]（6 条）
     新（bf-11）：["happy_v1.mp3","happy_v3.mp3","happy_finally2.mp3","happy_i45.mp3"]（4 条）
     原因：用户 bf-11 原话「游戏里轮换『终于好啦』『开动啦』『哼，太慢了』这三个之前的语言。
     还有 v3 和 i45 共 5 个」，随后又追加「换成不含『呜呼』的版本」——
     于是「终于好啦」那条由 happy_v2（「呜呼！终于好啦！」）换成 happy_finally2（「太棒啦！终于好啦！」）。
     顺序 = 用户点名顺序：开动啦(v1) → v3 → 终于好啦(finally2) → i45。
     slow（「哼，太慢了」）是跑单语音，走单独通道，不在这个池子里。 */
  const POOL = ["happy_v1.mp3", "happy_v3.mp3", "happy_finally2.mp3", "happy_i45.mp3"];
  /* ① 顺序与内容 = 用户拍板结果 */
  jsonEq(R.audio.FILES.happy, POOL);
  /* ② 每一条都在盘上 → 不存在「点名的文件不在盘上」的静默 404 */
  POOL.forEach(f => assert.ok(fs.existsSync(path.join(dir, f)), "audio/bf/" + f + " 在盘上"));
  /* ③ 用户点名的 4 条都在池子里；被否掉的旧件不在池里 */
  ["happy_v1.mp3", "happy_v3.mp3", "happy_finally2.mp3", "happy_i45.mp3"].forEach(f => {
    assert.equal(POOL.indexOf(f) >= 0, true, f + " 已启用（用户 bf-11 点名）");
  });
  assert.equal(POOL.indexOf("happy_v2.mp3"), -1, "happy_v2 已换掉（含「呜呼」，用户否决）");
  assert.equal(POOL.indexOf("happy_v4.mp3"), -1, "v4 不在本轮点名的 4 条里");
  assert.equal(POOL.indexOf("happy_alt2.mp3"), -1, "alt2 不在本轮点名的 4 条里");
  assert.equal(POOL.indexOf("happy_alt3.mp3"), -1, "alt3 不在本轮点名的 4 条里");
  /* ④ 它们仍然只是「文件」：没被任何**通道名**顶替（通道还是 happy 一个）*/
  assert.equal(R.audio.NAMES.filter(n => n === "happy").length, 1, "通道名仍是 happy");
  assert.equal(R.audio.url("happy", 0), "audio/bf/happy_v1.mp3", "下标 0 = v1「开动啦」（顺序即拍板顺序）");
  assert.equal(R.audio.url("happy", 1), "audio/bf/happy_v3.mp3", "下标 1 = v3");
  assert.equal(R.audio.url("happy", 2), "audio/bf/happy_finally2.mp3", "下标 2 = finally2「终于好啦」");
  assert.equal(R.audio.url("happy", 3), "audio/bf/happy_i45.mp3", "下标 3 = i45");
  /* ⑤ 随机不连重：hook 住播放器，用真正的触发函数 playHappy 连抽 24 次
     （每次隔 1s > HAPPY_MIN_GAP=0.9 → 节流不拦），邻两次不得是同一条，且 4 条都要出现过。
     为什么不直接调 audio.play：rules.audio 是**挑过的公开面**（没有 play），验收要贴着真实触发链走。 */
  const seen = [];
  R.audio.hook(function (r) { if (r && r.name === "happy") seen.push(r.url); });
  R.audio.setEnabled(true);
  R.audio.clear();
  for (let i = 0; i < 24; i++) R.audio.playHappy({ audio:{ lastHappyAt:-99, happies:0 }, elapsed: i * 1.0 });
  R.audio.hook(null);
  R.audio.clear();
  assert.equal(seen.length, 24, "24 次都播了（节流没把它们拦掉）");
  let adjacentSame = 0;
  for (let i = 1; i < seen.length; i++) if (seen[i] === seen[i - 1]) adjacentSame++;
  assert.equal(adjacentSame, 0, "从不连着重复同一条（lastPick 生效）");
  /* 原（bf-10）：new Set(seen).size === 6（6 条都要轮到）
     新（bf-11）：new Set(seen).size === 4（池子就是 4 条）—— 原因同上：池子从 6 条变 4 条 */
  assert.equal(new Set(seen).size, 4, "4 条都轮到过：" + Array.from(new Set(seen)).sort().join(","));
  /* ⑥ 池子非空、每条 URL 都在池子里（pick 不会越界）*/
  seen.forEach(u => assert.ok(POOL.indexOf(u.replace("audio/bf/", "")) >= 0, "播出的都在池子里：" + u));
});



  /* 素材目录与代码里写的目录一致（改目录时两边一起改） */
  assert.equal(R.audio.DIR, "audio/bf/", "代码里的素材目录 = audio/bf/");
  assert.equal(R.audio.url("tick", 0), "audio/bf/tick.mp3", "url() 拼出来的路径对得上");
});


