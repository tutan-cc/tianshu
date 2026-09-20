/* ═══════════════════════════════════════════════════════════════════════════
   breakfast.js — 早餐店 · 拼手速（Canvas 全程序化绘制，零外部图片）
   自包含 IIFE，暴露全局 window.Breakfast；ES5 风格，不使用 ES module，
   不依赖页面内变量（只读 opts / 挂载 hostEl）。

   对外 API（规格）：
     window.Breakfast.start(hostEl, opts) -> boolean
       opts:{ target:{id,name,bond}, duration:75, goal:8, onFinish(result) }
     window.Breakfast.isBusy(), dispose()
     window.Breakfast.debug = { state(), orders(), stations(), score(),
                                tap(kind,idx), serve(ci,pi), trash(idx), finishNow() }
     result: { win, served, goal, perfect, burnt, score, bondDelta, target, quote }

   附加（单测 / 页面规则层用，不属于规格）：window.Breakfast.rules / .ui
   纯逻辑与渲染层分离：rules 里的函数不碰 DOM，可在 vm 里单独注入测试。

   ── 玩法规格（bf-3 新操作模型 / 按用户口述实现）──────────────────────────
   0) 「什么锅能对应做什么食材，要放在一列」：画面 9 列，列内三者同一 x 中心线 ——
      屏幕底部那一排食材（第 i 桶）→ 正上方就是它的锅/煎盘/蒸格（第 i 号灶位）
      → 再上方就是该灶位的专属空盘（第 i 号盘）。
      绑定写死：FOOD_IDS[i] ↔ 灶位 i ↔ 盘 i，一一对应、终身不可互换（columnOf 纯函数）。
   1) 「点一下食物，食物会自动进入它对应的锅」：单击食材桶 → 自动进它那一列下锅。
      该列锅正忙 / 该列盘里还有一份 → 拒绝并给原因码（station-occupied / plate-occupied）。
   2) 「熟了之后点一下就可以给顾客」：完美窗口一到自动落到本列专属盘；
      单击该盘 → 自动送给「正在需要这份、且耐心最少」的顾客；
      此刻没人需要 → 不消耗、留在盘上（继续走热乎度衰减）并提示「现在没人要这份」。
   3) 「点两下是扔进垃圾桶」：双击盘（或双击锅内成品）→ 丢垃圾桶，清空锅与盘，不扣分。
      糊掉的那份单击被拒（原因码 burnt，提示「糊了，只能丢掉」）→ 只能双击丢掉；
      糊的若硬端给顾客（点顾客卡自动配盘那条路）→ 顾客当场离开（现有规则不变）。
   4) 「每个锅都配备一个空盘」：取消「3 个备菜盘限量」，9 列各配 1 个空盘（共 9 盘）。
      压力不消失：食物落在盘上超过 SERVE_WINDOW（过火计时，4.5s）即糊：
      热乎 ≤1.5s（14 分）→ 温 ≤3.0s（10 分）→ 凉 ≤4.5s（6 分）→ 糊（只能丢）。
   5) 顾客陆续进店（同时最多 3 位），每位 1–3 样早餐；订单卡有耐心倒计时条
   6) 糊菜端给顾客 → 该顾客直接不满离开（扣分）；糊掉的可丢垃圾桶（不扣分，只浪费时间；
      盘/锅上留 14 秒自动清）
   7) 规定时间内（默认 75s）服务满 N 位（默认 8 位）即通过，否则失败
   8) 难度曲线：随时间推移顾客来得更快、订单更长、耐心更短
   好感结算（页面规则层调用）：
     通过 → +6~+10（热乎度 / 完美份数越高加得越多）；失败 → −3~−6
     每日一次：同一游戏日同一角色只能送一次（S.breakfastDay 记录）
     好感 ≥80 或 <20 的角色在选对象面板置灰并给原因
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";
  if (!root || root.Breakfast) return;

  var doc = root.document;
  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (!s) continue;
      for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
    }
    return t;
  }
  function nowMs() { return (root.performance && root.performance.now) ? root.performance.now() : Date.now(); }
  function rnd01() { return Math.random(); }
  function round1(v) { return Math.round(v * 10) / 10; }

  /* ═══════════════ 1. 常量：食物 / 列绑定 / 计分 / 文字（纯数据） ═══════════════ */

  /* 火候三态由「烹饪时长 + 完美窗口宽度」决定（锅里那套状态机，规则不变）：
       t < dur             → 生
       dur ≤ t < dur+PW    → 恰好（完美窗口）
       dur+PW ≤ t < burnAt → 过火（仍可端，普通分）
       t ≥ burnAt          → 糊（端给顾客会把人气走，只能丢垃圾桶）
     burnAt = dur + PW + burn（burn = 糊的宽限时长）                              */
  var FOOD = {
    congee:   { n:"白粥",   kind:"pot",     dur:5.0, pw:1.2, burn:1.6, c:"#f2ece0" },
    milk:     { n:"热牛奶", kind:"pot",     dur:2.6, pw:0.7, burn:0.9, c:"#eef4ff" },
    soup:     { n:"清汤",   kind:"pot",     dur:3.4, pw:0.9, burn:1.1, c:"#cfe8ff" },
    egg:      { n:"煎蛋",   kind:"griddle", dur:3.0, pw:0.8, burn:1.0, c:"#ffd76e" },
    bacon:    { n:"培根",   kind:"griddle", dur:3.6, pw:0.9, burn:1.2, c:"#ff7d6e" },
    sandwich: { n:"三明治", kind:"griddle", dur:4.4, pw:1.0, burn:1.3, c:"#e0a45c" },
    bun:      { n:"包子",   kind:"steamer", dur:4.0, pw:1.1, burn:1.4, c:"#f7efe1" },
    salad:    { n:"沙拉",   kind:"counter", dur:1.8, pw:0.6, burn:0.8, c:"#7fe08a" },
    juice:    { n:"果汁",   kind:"juicer",  dur:1.5, pw:0.6, burn:0.7, c:"#ffb347" }
  };
  /* ── 列绑定（用户新操作模型的核心，要求 A1）───────────────────────────────
     FOOD_IDS[i] ↔ 灶位 i ↔ 盘 i：三种东西一一对应、索引稳定、终身不可互换。
     顺序 = 屏幕上的列序（左 → 右）：3 口锅 ｜ 3 个煎盘 ｜ 蒸格 · 沙拉台 · 果汁机。 */
  var FOOD_IDS = ["congee", "milk", "soup", "egg", "bacon", "sandwich", "bun", "salad", "juice"];
  var COLS = [
    { food:"congee",   kind:"pot",     station:"白粥锅" },
    { food:"milk",     kind:"pot",     station:"热牛奶锅" },
    { food:"soup",     kind:"pot",     station:"清汤锅" },
    { food:"egg",      kind:"griddle", station:"煎蛋盘" },
    { food:"bacon",    kind:"griddle", station:"培根盘" },
    { food:"sandwich", kind:"griddle", station:"三明治盘" },
    { food:"bun",      kind:"steamer", station:"蒸笼" },
    { food:"salad",    kind:"counter", station:"沙拉台" },
    { food:"juice",    kind:"juicer",  station:"果汁机" }
  ];
  var COL_N = COLS.length;                                   // 9 列（= 9 灶位 = 9 专属盘）
  var STATION_NAME = { pot:"汤锅", griddle:"煎盘", steamer:"蒸格", counter:"沙拉台", juicer:"果汁机" };
  /* 兼容层：STATIONS 现在就是「一列一个灶位」，count 恒为 1，索引与列号一致 */
  var STATIONS = [];
  (function () {
    for (var ci = 0; ci < COLS.length; ci++)
      STATIONS.push({ kind:COLS[ci].kind, name:COLS[ci].station, count:1, col:ci, food:COLS[ci].food });
  })();
  /* ── 列绑定纯函数（不可互换，测试与渲染层都读它）── */
  function columnOf(foodId) { for (var i = 0; i < COL_N; i++) if (COLS[i].food === foodId) return i; return -1; }
  function foodOfColumn(i) { return (i >= 0 && i < COL_N) ? COLS[i].food : null; }
  function colNameOf(i) { return (i >= 0 && i < COL_N) ? COLS[i].station : ""; }
  function kindOfColumn(i) { return (i >= 0 && i < COL_N) ? COLS[i].kind : null; }
  /** 该列专属盘的标签（如「煎蛋盘 · 空」/「白粥盘 · 空」）*/
  function plateNameOf(i) { var f = foodOfColumn(i); return f ? ((FOOD[f] || {}).n + "盘") : "盘"; }

  var SCORE = {
    perfect: 10,     // 完美出餐基础分
    warm: 6,         // 过火出餐基础分
    hotBonus: 3,     // 出锅 2s 内的「热乎」额外分
    wrong: -5,       // 上错菜（食物不符订单）
    burnt: -5,       // 把糊的食物端给顾客
    leave: -8,       // 顾客失去耐心离开
    tick: 1,         // 每完成一样订单的服务分
    star: 12         // 一条订单全部完美 → 额外分
  };
  /* ── 过火计时（要求 A5：取消「3 个备菜盘限量」，9 列各配 1 盘，
        但食物落在盘上超过 SERVE_WINDOW 就从 热乎 → 温 → 凉 → 糊，糊了只能丢）────────
         SERVE_WINDOW = 4.5s，三段均分：
           0 – 1.5s  热乎 → 14 分
           1.5 – 3.0s 温   → 10 分
           3.0 – 4.5s 凉   →  6 分（仍可上餐，只是分低）
           > 4.5s         糊   → 只能双击丢垃圾桶
         火候过火（没在完美窗口出锅）的份再扣 3 分 → 温 7 / 凉 3（旧档手感不变）。
         三档分数单调递减：14 > 10 > 6。                                          */
  var SERVE_WINDOW = 4.5;                    // 过火计时（秒，可调）：盘上停留的上限
  var SERVE_WARN_SEC = 1.0;                  // 最后 1 秒：红闪
  var HEAT = {
    hotSec: SERVE_WINDOW / 3, warmSec: SERVE_WINDOW * 2 / 3, coldSec: SERVE_WINDOW,
    hot: 14, warm: 10, cold: 6,
    overPenalty: -3
  };
  var HOT_MS = HEAT.hotSec * 1000;   // 兼容旧字段名：热乎窗口（毫秒）
  var BURNT_LIFE_MS = 14000;// 烧糊的残骸在盘/锅上留 14 秒（可双击丢掉）
  /* ── 每个锅都配备一个空盘（要求 A5）────────────────────────────────────────
     9 个灶位各配 1 个专属盘，索引一一对应（i 号灶位 ↔ i 号盘），没有共用、没有限量。
     保留的压力改由「过火计时」承担：盘上那份超时即糊，忘取就报废。 */
  var PLATES_TOTAL = COL_N;                  // 盘数 = 列数 = 9
  var PREP_PLATES = COL_N;                   // 兼容旧字段名（现在每列都有盘）
  var MAX_PLATES = PLATES_TOTAL;
  var DOUBLE_MS = 425;                       // 双击判定窗口（毫秒）
  /* 下料被拒的原因码（要求 A2：返回明确原因码）*/
  var PLACE_WHY = {
    "not-running":     "还没开局",
    "no-food":         "没有这样食材",
    "wrong-column":    "那是别人的锅 —— 每样食材只进自己那一列",
    "station-occupied":"锅里还在做 —— 等它熟（糊了就双击丢掉）",
    "plate-occupied":  "盘里还有一份，先送出去",
    "no-free-station": "对应的锅占着 —— 先送出去或丢掉"
  };
  var MAX_ANGRY = 5;        // 气走 5 位顾客 → 提前失败
  var SPAWN_START = 2.0;    // 开局顾客间隔（秒）
  var SPAWN_END = 4.0;      // 收官顾客间隔（秒）
  var MAX_CUSTOMERS = 3;    // 同时最多 3 位

  function diffAt(elapsed, cfg) {
    var d = Number(cfg && cfg.duration); if (!(d > 0)) d = 75;
    var t = Number(elapsed); if (!(t >= 0)) t = 0;
    return Math.max(0, Math.min(1, t / d));
  }
  /** 难度曲线：0（开局）→ 1（收官）。
      收官时顾客来得更急、耐心更短，但手上时间少了，订单反而更短（否则无法完成）。
      净效果：单位时间压力明显上升。 */
  function orderLenAt(elapsed, cfg, rnd) {
    var d = diffAt(elapsed, cfg);
    var roll = (typeof rnd === "number") ? rnd : 0.5;
    if (roll < 0.40 - 0.26 * d) return 1;      // 开局只有 40% 是 1 样，收官 14%
    if (roll < 0.82 - 0.10 * d) return 2;      // 开局 42% 是 2 样，收官 38%
    return 3;                                  // 开局 18% 是 3 样，收官 48%
  }
  function patienceFor(len, elapsed, cfg) {
    var d = diffAt(elapsed, cfg);
    var base = 10 + 7.5 * (len > 0 ? len : 1);        // 1 样 ≈ 17.5s，3 样 ≈ 32.5s
    return round1(base * (1 - 0.33 * d));
  }
  function spawnGapFor(elapsed, cfg, rnd) {
    var d = diffAt(elapsed, cfg);
    var s = SPAWN_START + (SPAWN_END - SPAWN_START) * d;
    var roll = (typeof rnd === "number") ? rnd : 0.5;
    return round1(s * (0.86 + 0.28 * roll));
  }
  /** 下一位顾客的等待时间：店里没人时几乎立刻补位，满员时慢一点 */
  function nextGap(elapsed, cfg, runningCount, rnd) {
    if (!runningCount) return 0.5;
    var g = spawnGapFor(elapsed, cfg, rnd);
    return round1(g * (runningCount >= MAX_CUSTOMERS ? 1.25 : 1));
  }

  /** 火候状态机：输入已烹饪秒数 → idle / raw / perfect / over / burnt */
  function cookState(foodId, t) {
    var f = FOOD[foodId]; if (!f) return "idle";
    var s = Number(t); if (!(s >= 0)) s = 0;
    var done = f.dur, end = f.dur + f.pw, burn = f.dur + f.pw + f.burn;
    if (s < done) return "raw";
    if (s < end) return "perfect";
    if (s < burn) return "over";
    return "burnt";
  }
  function burnAt(foodId) { var f = FOOD[foodId]; return f ? Math.round((f.dur + f.pw + f.burn) * 100) / 100 : 0; }
  function stationKindOf(foodId) { var f = FOOD[foodId]; return f ? f.kind : null; }

  /* ── 列 ↔ 灶位 ↔ 盘（要求 A1/A5：一一对应，不再分「预备盘 / 现做」两类）──────
     每一列都有一个专属空盘：0..COL_N-1。索引一一对应、稳定且不可互换。
     isPrepStation / hasPlate 保留旧名字，语义变成「这一列有没有专属盘」（全部都有）。 */
  function isPrepStation(stationIdx) { return stationIdx >= 0 && stationIdx < COL_N; }
  function prepStationIndices() {
    var out = [];
    for (var i = 0; i < COL_N; i++) out.push(i);
    return out;
  }
  /** 兼容旧 API：现在没有「无盘的现做灶位」了 → 恒为空集 */
  function serveStationIndices() { return []; }
  /** 每列一个专属盘（i 号灶位 ↔ i 号盘）*/
  function hasPlate(stationIdx) { return stationIdx >= 0 && stationIdx < COL_N; }
  /** 出餐窗口（旧机制的兼容保留）：现在食物一到「恰好」就自动落到专属盘，
      锅内窗口不再打开，所以这个判定恒为 false；纯函数保留给单测 / 旧调用方。 */
  function isServeWindowOpen(s) { return !!(s && s.food && s.state === "perfect" && (s.serveWin || 0) > 0); }
  /** 盘上停留是否已经超过「过火计时」（纯函数，边界精确：4.49 不糊 / 4.51 糊）*/
  function plateBurntAt(ageSec) { var a = Number(ageSec); if (!(a >= 0)) a = 0; return a >= SERVE_WINDOW - 1e-9; }
  /** 盘上这份还剩多少秒（到「糊」为止）*/
  function plateLeftSec(ageSec) { var a = Number(ageSec); if (!(a >= 0)) a = 0; return Math.max(0, SERVE_WINDOW - a); }

  /* ── 顾客 / 订单 ── */
  /** 订单：从食材池里不重复地抽 len 样（保证同一张单子不会点两遍同一样） */
  function orderFor(len, rnd, salt) {
    if (!(len > 0)) len = 1; if (len > FOOD_IDS.length) len = FOOD_IDS.length;
    var pool = FOOD_IDS.slice(), order = [];
    var r = Math.abs(Number(rnd)); if (!isFinite(r)) r = 0.5;
    var s = Math.abs(Number(salt) || 0);
    for (var k = 0; k < len && pool.length; k++) {
      var idx = Math.floor(Math.abs(Math.sin((k + 1) * 12.9898 + r * 78.233 + s * 3.7)) * pool.length) % pool.length;
      order.push(pool.splice(idx, 1)[0]);
    }
    return order;
  }
  function newCustomer(i, elapsed, cfg, rnd) {
    var len = orderLenAt(elapsed, cfg, rnd);
    var order = orderFor(len, rnd, i);
    var pat = patienceFor(order.length, elapsed, cfg);
    return { id:i, order:order, done:[], patience:pat, patienceMax:pat,
             angry:false, left:false, t:elapsed };
  }

  /* ── 计分 ── */
  var SCORE_KINDS = ["perfect", "warm", "wrong", "burnt", "leave", "tick", "star"];
  function scoreDelta(kind, ctx) {
    ctx = ctx || {};
    var hot = !!ctx.hot;
    switch (kind) {
      case "perfect": return SCORE.perfect + SCORE.tick + (hot ? SCORE.hotBonus : 0);
      case "warm":    return SCORE.warm + SCORE.tick + (hot ? SCORE.hotBonus : 0);
      case "wrong":   return SCORE.wrong;
      case "burnt":   return SCORE.burnt;
      case "leave":   return SCORE.leave;
      case "tick":    return SCORE.tick;
      case "star":    return SCORE.star;
      default:        return 0;
    }
  }
  function isFoodInOrder(order, foodId) { return !!(order && order.indexOf(foodId) >= 0); }

  /* ── 热乎度档位（纯函数）────────────────────────────────────────────────
     tier(state, ageSec) → "hot" | "warm" | "cold"
     过火（over）的份拿不到「热乎」，最高只到「温」—— 这正是旧档 perfect/warm 的区分，
     也保证「越早送越好」：同一份食物随停留时间只会单调降档。                        */
  var HEAT_TIERS = ["hot", "warm", "cold"];
  function heatTierOf(state, ageSec) {
    var a = Number(ageSec); if (!(a >= 0)) a = 0;
    if (state === "over" || state === "burnt") return a <= HEAT.warmSec ? "warm" : "cold";
    if (a <= HEAT.hotSec) return "hot";
    if (a <= HEAT.warmSec) return "warm";
    return "cold";
  }
  function heatScore(tier) { return (tier === "hot") ? HEAT.hot : (tier === "warm" ? HEAT.warm : HEAT.cold); }
  /** 上餐得分 = 热乎档分 + 过火惩罚（旧档：完美热乎 14 / 过火 7，逐字不变） */
  function serveScore(state, tier) { return heatScore(tier) + (state === "over" ? HEAT.overPenalty : 0); }
  function isHotTier(tier) { return tier === "hot"; }

  /* ── 好感结算（页面规则层与单测共用） ── */
  function bondHeat(perfect, hot) {
    var p = Math.max(0, Number(perfect) || 0), h = Math.max(0, Number(hot) || 0);
    return Math.max(0, Math.min(100, Math.round(p * 30 + h * 10)));
  }
  function bondDeltaWin(perfect, hot) {
    var p = Math.max(0, Number(perfect) || 0), h = Math.max(0, Number(hot) || 0);
    return Math.max(6, Math.min(10, 6 + Math.floor(p / 3) + (h >= 4 ? 1 : 0)));
  }
  function bondDeltaLose(burnt, served) {
    var b = Math.max(0, Number(burnt) || 0), s = Math.max(0, Number(served) || 0);
    return -Math.max(3, Math.min(6, 3 + Math.floor(b / 3) + (s <= 1 ? 1 : 0)));
  }
  function bondDeltaFor(win, perfect, hot, burnt, served) {
    return win ? bondDeltaWin(perfect, hot) : bondDeltaLose(burnt, served);
  }
  /** 可攻略角色筛选：20 ≤ 好感 ≤ 79 且今天没送过 → 可选；否则置灰 + 原因 */
  function eligibleTargets(bonds, targetIds, sentMap) {
    var list = [];
    for (var i = 0; i < targetIds.length; i++) {
      var id = targetIds[i];
      var bond = Number(bonds && bonds[id]); if (!isFinite(bond)) bond = 0;
      var sent = !!(sentMap && sentMap[id]);
      var why = "", ok = true;
      if (bond < 20) { ok = false; why = "好感 " + bond + " · 还太生疏（≥20 才收得下这份早餐）"; }
      else if (bond >= 80) { ok = false; why = "好感 " + bond + " · 已经满了，不用再刷了"; }
      else if (sent) { ok = false; why = "好感 " + bond + " · 今天已经送过了，明天再来"; }
      list.push({ id:id, bond:bond, ok:ok, why:why, sent:sent });
    }
    return list;
  }
  function canSend(bonds, id, day, bfDay) {
    var bond = Number(bonds && bonds[id]); if (!isFinite(bond)) bond = 0;
    if (bond < 20) return { ok:false, why:"好感不足 20，现在送反而尴尬" };
    if (bond >= 80) return { ok:false, why:"好感已满 80，不用再送" };
    if (bfDay && Number(bfDay.day) === Number(day) && bfDay.sent && bfDay.sent.indexOf(id) >= 0)
      return { ok:false, why:"今天已经给他送过了" };
    return { ok:true, why:"" };
  }
  function markSent(bfDay, id, day) {
    var prev = (bfDay && typeof bfDay === "object" && Object.prototype.toString.call(bfDay.sent) === "[object Array]") ? bfDay.sent : [];
    var out = { day:(bfDay && typeof bfDay === "object") ? bfDay.day : day, sent:[] };
    for (var i = 0; i < prev.length; i++) if (typeof prev[i] === "string") out.sent.push(prev[i]);
    if (Number(out.day) !== Number(day)) { out.day = Number(day); out.sent = []; }
    if (out.sent.indexOf(id) < 0) out.sent.push(id);
    return out;
  }
  function sentToday(bfDay, day) {
    var m = {};
    if (bfDay && Number(bfDay.day) === Number(day) && bfDay.sent)
      for (var i = 0; i < bfDay.sent.length; i++) m[bfDay.sent[i]] = true;
    return m;
  }

  /* ── 文案（与规则层同源：结算面板 / toast 都取这里） ── */
  var QUOTES = {
    fang: { hi:["「姐活这么大，头一回有人给我送热早饭。这房租，姐不催了。」"],
            ok:["「你煮的粥，比姐自己熬的稠。……行吧，下个月房租给你抹个零。」","「大清早的，站门口给我送早饭？你还挺会做人。」"],
            bad:["「……这是粥还是炭？行，心意姐收了，东西倒了。」","「你先学会别把锅烧穿，再来哄姐。」"] },
    su:   { hi:["「热乎的……你几点起的？」她低头笑，「那我明天，早点出门。」"],
            ok:["「跑完步正好饿！你怎么知道我今天加量？」","「谢啦——明天早上，老地方见？」"],
            bad:["「……这个是不是糊了？」她还是咬了一口，「没事，我胃口好。」","「你昨天是不是也熬夜了？看着比我还不像人。」"] },
    lin:  { hi:["「这味道……你自己做的？」她抬头看你两秒，「以后别对别人也这样。」"],
            ok:["「早。」她接过纸袋，「同事看见了要传八卦的——谢了。」","「你怎么知道我没吃早饭？……好吧，我脸上写着。」"],
            bad:["「……我拿去茶水间热一下吧。」她笑得很勉强。","「你确定这是给活人吃的？」"] },
    wen:  { hi:["「这个……很好吃。」她小声说，「我今天的错题，好像也没那么难了。」"],
            ok:["「谢谢……我正好饿了。」她把书挪开一点，给你腾了半个位子。","「你怎么知道我这几天只吃巧克力？」"],
            bad:["「（她看了看，又看了看你）你是不是把书和锅放一起了？」","「……我还是吃巧克力吧。」"] },
    lei:  { hi:["「你做的？」她挑眉，「行啊，以后打不动了去开早餐店，我给你投钱。」"],
            ok:["「啧，还知道给教练带饭。」她一口吞了半个，「明早六点，别迟到。」","「不错，够实在。比那些只会送花的强。」"],
            bad:["「这玩意儿能练出肌肉吗？」她捏了捏，「拿回去自己吃。」"] },
    hong: { hi:["「热乎的。」她盯着碗看了会，「小陈，你在图我什么？……算了，别答。」"],
            ok:["「哟，太阳打西边出来了。」她扒拉两口，「比店里厨房做得像样。」","「打烊才睡的人，居然给我送早饭。」"],
            bad:["「糊了。」她闻了闻，笑出声，「不过比昨晚那桌酒强。放着吧。」"] },
    guo:  { hi:["「哥，你以后天天做给我吃好不好？」她把碗抱得紧紧的。","「……你是不是又熬夜做了？下次我自己来。」"],
            ok:["「哥！你居然会做饭了？」她一口一个包子，「比我煮的面好吃多了。」","「谢谢哥——我带去学校吃！」"],
            bad:["「哥，这能吃吗……」她戳了戳，「我蘸点酱油试试。」","「（她把烧焦的那块藏起来）没事，我吃别的。」"] },
    lu:   { hi:["「你等多久了？」她看看还冒着热气的粥，又看看你，「……值夜班也没你这么熬的。」"],
            ok:["「夜班刚下……你怎么知道我这时候饿。」她捧着碗，手指慢慢暖回来。","「热的。谢谢。」她难得笑了一下。"],
            bad:["「这些我见多了。」她看了一眼，「急诊室的病人都不吃这个。」"] },
    man:  { hi:["「热乎的。」她放下文件，「今天的会，往后推半小时。」"],
            ok:["「早餐？」她挑了下眉，「我上一次吃早餐，是三年前。」","「……还行。你比我想的会照顾人。」"],
            bad:["「这就是你说的『证明给我看』？」她把盘子推回去。","「下次带方案，别带这个。」"] }
  };
  var QUOTE_FALLBACK = {
    hi:["「这么用心？我记着了。」"],
    ok:["「……谢谢。心意我收下了。」", "「热的，正好。」"],
    bad:["「……下次别勉强。」", "「心意领了，东西就……算了吧。」"]
  };
  function pickQuote(role, tier, ti) {
    var q = QUOTES[role] || {};
    var arr = (q[tier] && q[tier].length) ? q[tier] : (QUOTE_FALLBACK[tier] || QUOTE_FALLBACK.ok);
    var i = Math.abs(Math.floor(Number(ti) || 0)) % arr.length;
    return arr[i];
  }
  function quoteFor(role, win, quality, ti) {
    var tier = win ? (quality >= 0.45 ? "hi" : "ok") : "bad";
    return pickQuote(role, tier, ti);
  }
  /** 「接下来还能干什么」一句话（结算面板用；与 impactOf 同源，纯函数、单测可断言）
      同一天同一个人只算一次 → 不论通过还是失败，这一份都已经用掉今天的额度。 */
  function quotaOf(win, bondDelta, targetName) {
    var nm = targetName || "对方";
    var d = Number(bondDelta) || 0;
    return "好感 " + (d > 0 ? "+" : "") + d + "，今天这一份就算数了 —— " + nm +
           " 今天不能再送（同一天同一个人只算一次）：换个人，或明天再来。";
  }
  /** 本局影响一句话（结算面板与页面 toast 同源） */
  function impactOf(win, perfect, burnt, hot, targetName) {
    var nm = targetName || "对方";
    if (win) {
      if (perfect >= 8) return "一早上火光没断过，还在冒热气的这一份，比什么话都管用 —— " + nm + "记了很久。";
      if (perfect >= 4) return "火候基本稳了，袋子递出去的时候还是温的。" + nm + "没有客气。";
      return "手忙脚乱，但总算赶在上班前把热乎的一口送到了" + nm + "手里。";
    }
    if (burnt >= 3) return "灶台糊了三回，最后只端得出这一份焦的 —— " + nm + "还是接过去了。";
    if (perfect === 0 && hot === 0) return "忙了一早上什么都没做成，" + nm + "看着你空着的手。";
    return "晚了。袋子凉了，" + nm + "没多说什么。";
  }

  /* ═══════════ 1b. 音效 / 顾客语音（bf-audio-1：滴答 / 呜呼 / 哼，太慢了）═════════
     用户三条要求（逐条对应到下面的触发点）：
       ① 顾客耐心快到时要有「滴答」式倒计时提示音 —— 耐心剩余 ≤ TICK_AT(30%) 开始响，
          越急越密（30% 档 1.0s 一下，≤10% 档 0.5s 一下）
       ② 顾客拿到早餐 → 高兴地喊一声「呜呼～」（三个音色变体随机取，避免听腻）
       ③ 等太久走掉的顾客 → 「哼，太慢了」
     四条设计约束（都是用户/项目明确要求）：
       · **有文件用文件，缺失静默回落**：文件不存在 / 环境里没有 Audio / 被浏览器自动播放
         策略拦截 → 不抛错、不报错、不影响玩法（只在记录里留一个 why，验收读得到）。
       · **不许叠成噪音**：滴答是**全店一条**（不是每位顾客各一条），按紧迫度限流，
         再加一道 TICK_MIN_GAP 保险丝；「呜呼」「哼」各自也有最小间隔
         （同一单连着上三样菜不会叠三声）。
       · **不打断别的语音**：本模块只 new 自己的 Audio()，不排队、不暂停、不接管别人的播放 ——
         麻将那条报牌队列在 mahjong.js 里，两套互不触碰。
       · **开关沿用**：早餐店此前没有任何音量/静音设置，所以按用户要求用
         localStorage.bfSoundOn（"0"/"off"/"false" = 关；缺省开）。
         UI 两处都能点：顶栏的 🔊/🔇 按钮、图例条左端的同款小徽章。
     素材：audio/bf/{tick,happy,happy2,happy3,slow}.mp3（48kHz / 128kbps / 单声道）      */
  var TICK_AT = 0.30;        // 耐心剩余 ≤30% 开始滴答（可调常量）
  var TICK_NEAR = 0.10;      // ≤10% 进入「更急」档
  var TICK_GAP_FAR = 1.0;    // 30% 档：每秒 1 次
  var TICK_GAP_NEAR = 0.5;   // 10% 档：每 0.5 秒 1 次
  var TICK_MIN_GAP = 0.25;   // 全局节流下限（保险丝：任何两次滴答至少隔这么久）
  var HAPPY_MIN_GAP = 0.90;  // 两条「呜呼」之间的最小间隔（≈最短那条喊声 0.91s：连续上菜不叠声）
  var SLOW_MIN_GAP = 0.80;   // 两条「哼，太慢了」之间的最小间隔
  var BF_SOUND_KEY = "bfSoundOn";     // localStorage 键（默认开）
  var BF_AUDIO_DIR = "audio/bf/";     // 素材目录（相对页面，与 art/ 同一套解析口径）
  var BF_SFX_VOL = { tick:0.35, happy:0.55, slow:0.55 };   // 音量（滴答压低，别吵）
  var BF_SFX_FILES = {
    tick:  ["tick.mp3"],
    happy: ["happy.mp3", "happy2.mp3", "happy3.mp3"],      // 变体：随机取，且不连着重复同一条
    slow:  ["slow.mp3"]
  };
  var AUDIO_NAMES = ["tick", "happy", "slow"];

  /* ── 播放引擎（模块级单例；不依赖 DOM，纯逻辑测试里也能跑）─────────────────
     三级回落，任何一级出问题都只是「这一声没响」：
       ① 测试注入的 sink（rules.audio.hook(fn)）→ 只记录，不发声
       ② 浏览器的 new Audio(url) + play()（.catch 吞掉自动播放策略拦截）
       ③ 都没有（Node / 老环境）→ 记一条 why:"no-audio" 就结束            */
  var audio = (function () {
    var on = null;        // null = 还没读过开关（懒读；没有 localStorage 的环境照样能跑）
    var sink = null;      // 测试注入的播放器：给了就不走 new Audio
    var log = [];         // 播放 / 跳过记录（验收读它；上限 240 条，防无限增长）
    var LOG_MAX = 240;
    var lastPick = {};    // 每个通道上一条用过的变体下标（避免连着重复同一句）

    function store() {
      try { return (root && root.localStorage) ? root.localStorage : null; } catch (e) { return null; }
    }
    /** 开关：localStorage.bfSoundOn；读不到（无痕/沙箱/无 localStorage）→ 默认开 */
    function enabled() {
      if (on !== null) return on;
      var raw = null;
      try { var ls = store(); if (ls && ls.getItem) raw = ls.getItem(BF_SOUND_KEY); } catch (e) { raw = null; }
      on = !(raw === "0" || raw === "off" || raw === "false");
      return on;
    }
    function setEnabled(b) {
      on = !!b;
      try { var ls = store(); if (ls && ls.setItem) ls.setItem(BF_SOUND_KEY, on ? "1" : "0"); } catch (e) {}
      return on;
    }
    function toggle() { return setEnabled(!enabled()); }
    function sfxUrl(name, i) {
      var f = BF_SFX_FILES[name]; if (!f || !f.length) return "";
      var k = (typeof i === "number" && i >= 0 && i < f.length) ? Math.floor(i) : 0;
      return BF_AUDIO_DIR + f[k];
    }
    /** 取一个变体下标（多条时避免连着重复同一条；单条恒 0）*/
    function pick(name) {
      var f = BF_SFX_FILES[name]; if (!f || f.length <= 1) return 0;
      var i = Math.abs(Math.floor(rnd01() * f.length)) % f.length;
      if (lastPick[name] === i) i = (i + 1) % f.length;
      lastPick[name] = i;
      return i;
    }
    function rec(name, i, ok, why, at) {
      var r = { name:name, url:sfxUrl(name, i), volume:BF_SFX_VOL[name] || 0,
                at:(typeof at === "number") ? round1(at) : 0, ok:!!ok, why:why || "" };
      log.push(r);
      if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
      return r;
    }
    /** 播一条。**任何异常都不许冒泡**（缺文件 / 没有 Audio / 被策略拦截 → 静默） */
    function play(name, at) {
      if (!BF_SFX_FILES[name]) return null;
      var i = pick(name);
      if (!enabled()) return rec(name, i, false, "off", at);
      if (typeof sink === "function") {
        var r0 = rec(name, i, true, "sink", at);
        try { sink(r0); } catch (e) { r0.ok = false; r0.why = "sink-error"; }
        return r0;
      }
      var A = root ? root.Audio : null;
      if (typeof A !== "function") return rec(name, i, false, "no-audio", at);
      var r = rec(name, i, true, "", at);
      try {
        var a = new A(r.url);
        try { a.volume = r.volume; } catch (e2) {}
        /* 文件缺失（404 / 解码失败）→ error 事件；**静默**，只把这条记录标一下 */
        if (a.addEventListener) a.addEventListener("error", function () { r.ok = false; r.why = "load-error"; });
        var pr = a.play ? a.play() : null;
        if (pr && typeof pr.catch === "function") pr.catch(function () { r.ok = false; r.why = "blocked"; });
      } catch (e3) { r.ok = false; r.why = "throw"; }
      return r;
    }
    return {
      enabled:enabled, setEnabled:setEnabled, toggle:toggle, play:play, url:sfxUrl, pick:pick,
      log:function () { return log.slice(); },
      /** 真的播出去的记录（开关关掉 / 没有 Audio 的不算）—— 验收只断言它 */
      plays:function () { var out = []; for (var i = 0; i < log.length; i++) if (log[i].ok) out.push(log[i]); return out; },
      clear:function () { log.length = 0; lastPick = {}; },
      hook:function (fn) { sink = (typeof fn === "function") ? fn : null; return !!sink; },
      files:BF_SFX_FILES, vol:BF_SFX_VOL, key:BF_SOUND_KEY, dir:BF_AUDIO_DIR
    };
  })();

  /* ── 滴答：触发阈值与节奏（全是纯函数，单测直接断言阈值 / 档位，不用起渲染层）── */
  /** 某位顾客的耐心剩余比例（0..1）*/
  function patienceRatioOf(c) {
    if (!c) return 1;
    var pat = Number(c.patience); if (!isFinite(pat)) pat = 0;
    var max = Number(c.patienceMax); if (!isFinite(max) || max <= 0) max = 0.01;
    return Math.max(0, pat) / Math.max(0.01, max);
  }
  /** 全店**最急**那位顾客的耐心比例；没有在等的顾客 → 1。
      已经拿齐订单、正在离场的不算（不再催他）。 */
  function minPatienceRatio(st) {
    var list = activeCustomers(st), m = 1;
    for (var i = 0; i < list.length; i++) {
      if (remainOf(list[i]) <= 0) continue;
      var r = patienceRatioOf(list[i]);
      if (r < m) m = r;
    }
    return m;
  }
  /** 滴答节奏：≤10% 档更快（30% 档 1.0s / 10% 档 0.5s）*/
  function tickGapFor(ratio) { return (Number(ratio) <= TICK_NEAR) ? TICK_GAP_NEAR : TICK_GAP_FAR; }
  /** 这一帧该不该滴答（纯判定，不改状态）*/
  function tickDue(st) {
    if (!st || !st.audio) return false;
    if (!(minPatienceRatio(st) <= TICK_AT)) return false;
    return st.elapsed + 1e-9 >= st.audio.tickNext;
  }
  /** 每局一份的音频台账（跟着 st 走，不进 localStorage）*/
  function newAudioState() {
    return { tickNext:0, lastTickAt:-1e9, lastHappyAt:-1e9, lastSlowAt:-1e9,
             ticks:0, happies:0, slows:0 };
  }
  /** 一帧一次的音频调度：滴答（全局节流）+ 本帧有人跑单时的「哼，太慢了」（只播一次）。
      调用点在 step() 里、顾客账算完之后 —— 所以「顾客离开 / 被服务」当帧就会停滴答。 */
  function stepAudio(st, leftNow) {
    if (!st || !st.audio) return;
    var a = st.audio, r = minPatienceRatio(st);
    if (r <= TICK_AT) {
      if (tickDue(st)) {
        a.tickNext = st.elapsed + Math.max(TICK_MIN_GAP, tickGapFor(r));
        a.lastTickAt = st.elapsed; a.ticks++;
        audio.play("tick", st.elapsed);
      }
    } else {
      /* 没人急了（都走了 / 都被服务完了）→ 计时器归位：下次一进 30% 立刻响，不残留节奏 */
      a.tickNext = st.elapsed;
    }
    if (leftNow) playSlow(st);
  }
  /** 拿到早餐 → 「呜呼～」（同一次服务只播一次；HAPPY_MIN_GAP 内不重复叠声）*/
  function playHappy(st) {
    if (!st || !st.audio) return null;
    var a = st.audio;
    if (st.elapsed - a.lastHappyAt < HAPPY_MIN_GAP) return null;
    a.lastHappyAt = st.elapsed; a.happies++;
    return audio.play("happy", st.elapsed);
  }
  /** 等太久走掉 → 「哼，太慢了」（同一帧多人离开也只播一次）*/
  function playSlow(st) {
    if (!st || !st.audio) return null;
    var a = st.audio;
    if (st.elapsed - a.lastSlowAt < SLOW_MIN_GAP) return null;
    a.lastSlowAt = st.elapsed; a.slows++;
    return audio.play("slow", st.elapsed);
  }
  /** 开关的两处 UI 共用同一份文案 */
  function soundLabel() { return audio.enabled() ? "🔊 音效" : "🔇 静音"; }
  /** 顶栏按钮 / 图例徽章共用的切换（改了开关 → 同步按钮文案 + 重绘画布上的徽章）*/
  function toggleSound() {
    var on = audio.toggle();
    if (inst) {
      if (inst.btnSound) { try { inst.btnSound.textContent = soundLabel(); } catch (e) {} }
      if (inst.render) { try { inst.render(); } catch (e) {} }
    }
    return on;
  }
  /** 对外暴露的规则层（单测用；与 UI 无关）*/
  var audioRules = {
    TICK_AT:TICK_AT, TICK_NEAR:TICK_NEAR, TICK_GAP_FAR:TICK_GAP_FAR, TICK_GAP_NEAR:TICK_GAP_NEAR,
    TICK_MIN_GAP:TICK_MIN_GAP, HAPPY_MIN_GAP:HAPPY_MIN_GAP, SLOW_MIN_GAP:SLOW_MIN_GAP,
    SOUND_KEY:BF_SOUND_KEY, DIR:BF_AUDIO_DIR, FILES:BF_SFX_FILES, VOL:BF_SFX_VOL, NAMES:AUDIO_NAMES,
    enabled:audio.enabled, setEnabled:audio.setEnabled, toggle:audio.toggle, hook:audio.hook,
    log:audio.log, plays:audio.plays, clear:audio.clear, url:audio.url,
    patienceRatioOf:patienceRatioOf, minPatienceRatio:minPatienceRatio,
    tickGapFor:tickGapFor, tickDue:tickDue, stepAudio:stepAudio, newAudioState:newAudioState,
    playHappy:playHappy, playSlow:playSlow,
    soundBox:soundBox, soundLabel:soundLabel, toggleSound:toggleSound
  };

  /* ═══════════════ 2. 运行时状态（纯数据，step() 驱动，无 DOM） ═══════════════ */
  /* ═══════════════ 2. 运行时状态（纯数据，step() 驱动，无 DOM） ═══════════════ */


  function newState(cfg) {
    cfg = cfg || {};
    var st = {
      cfg: { duration: cfg.duration > 0 ? cfg.duration : 75, goal: cfg.goal > 0 ? cfg.goal : 8,
             target: cfg.target || null,
             /* 自动落盘（要求 A3：熟了自动落到本列专属盘）——
                bf-3 起这是核心规则，所以默认打开；显式传 autoPlate:false 才关掉
                （关掉是「按住看火」的调试手感：食物留在锅里，手动 takePlate 才落盘）。 */
             autoPlate: cfg.autoPlate !== false },
      running:false, over:false, elapsed:0, score:0,
      served:0, perfect:0, normal:0, hot:0, burnt:0, burntServed:0, wrong:0, angry:0, made:0,
      heat:{ hot:0, warm:0, cold:0 }, prepped:0, lastPlace:null, expire:0, tossed:0,
      customers:[], stations:[], plates:[], floats:[], smoke:[], seq:1,
      audio:newAudioState(),                       // 音效台账（滴答节奏 / 各通道节流时钟 / 计数）
      selected:{ kind:null, idx:-1 }, nextIn:0.45, win:false, reason:"", result:null
    };
    var i;
    /* 9 列：i 号灶位 ↔ FOOD_IDS[i] ↔ i 号专属盘（索引写死，永不互换） */
    for (i = 0; i < COL_N; i++) {
      var cd = COLS[i];
      st.stations.push({ col:i, kind:cd.kind, name:cd.station, idx:i, station:i, colFood:cd.food, food:null, t:0,
                         state:"idle", doneAt:0, at:0, manual:false, serveWin:0, readyAt:0,
                         prep:true, hasPlate:true,
                         box:{ x:0, y:0, w:0, h:0 }, plateBox:{ x:0, y:0, w:0, h:0 } });
    }
    return st;
  }
  function stationByIdx(st, idx) { return (idx >= 0 && idx < st.stations.length) ? st.stations[idx] : null; }
  /** 按厨具种类取第 i 个灶位（兼容旧签名；一列一个灶位，所以就是列号）*/
  function stationIndexOfKind(st, kind, i) {
    var k = 0;
    for (var c = 0; c < COL_N; c++) {
      if (COLS[c].kind !== kind) continue;
      if (k === i) return c;
      k++;
    }
    return -1;
  }
  /* ── 专属出餐盘：每个灶位有且只有一个盘（索引一一对应，绝无共用）───────────
     st.plates 是「有东西的盘」的紧凑列表，每条记录带 station = 灶位下标，
     因此 plates.length 恒等于「盘上现有的份数」，而每个 station 至多出现在一条记录里。 */
  function plateIdxOfStation(st, stationIdx) {
    if (!st || !st.plates) return -1;
    for (var k = 0; k < st.plates.length; k++) if (st.plates[k].station === stationIdx) return k;
    return -1;
  }
  function plateOfStation(st, stationIdx) {
    var k = plateIdxOfStation(st, stationIdx);
    return k >= 0 ? st.plates[k] : null;
  }
  /** 灶位是否空着可用（锅空 + 本列的专属盘也空）—— 盘占着就不能再下料 */
  function stationFree(st, stationIdx) {
    var s = stationByIdx(st, stationIdx);
    if (!s || s.food) return false;
    if (isServeWindowOpen(s)) return false;
    return plateIdxOfStation(st, stationIdx) < 0;
  }
  /** 兼容旧签名：现在食材只进自己那一列 → 有空就返回该列，否则 -1 */
  function firstFreeStation(st, foodId) {
    var c = columnOf(foodId);
    return (c >= 0 && stationFree(st, c)) ? c : -1;
  }
  /** 造一条专属盘记录（owningStation = 它唯一的归属灶位） */
  function mkPlate(st, stationIdx, foodId, state) {
    var age = 0;
    var tier = heatTierOf(state, age);
    return { station:stationIdx, food:foodId, state:state, tier:tier, hot:(tier === "hot"),
             at:st.elapsed, left:round1(plateLeftSec(0)), burning:false, burntAt:0,
             cookSec:Math.round((st.stations[stationIdx].t || 0)) / 1000, seen:false };
  }
  /** 刷新一盘的热乎度（时间只会让它降档）＋ 记下「还有几秒到糊」 */
  function refreshPlate(st, p) {
    if (!p) return p;
    var age = Math.max(0, st.elapsed - (p.at || 0));
    p.age = round1(age);
    if (p.state === "burnt") { p.tier = heatTierOf("burnt", age); p.hot = false; p.left = 0; p.burning = true; return p; }
    p.tier = heatTierOf(p.state, age);
    p.hot = (p.tier === "hot");
    p.left = round1(plateLeftSec(age));
    p.burning = plateBurntAt(age);
    return p;
  }
  /** 该盘是否已经过了「过火计时」（超时 = 糊）*/
  function plateExpired(st, p) {
    if (!p || p.state === "burnt") return false;
    return plateBurntAt(Math.max(0, st.elapsed - (p.at || 0)));
  }
  /** 灶位出餐状态机（纯函数）：
       idle → raw → cooking → ready → plated →（served / trashed 是动作，不是状态）
       另有 over（过火，仍可上餐）、window（旧机制的锅内出餐窗口，兼容保留）
       与 burnt（糊，只能丢）几个支路。 */
  function phaseOf(st, stationIdx) {
    var s = stationByIdx(st, stationIdx);
    if (!s) return "none";
    var plated = plateIdxOfStation(st, stationIdx) >= 0;
    if (s.food) {
      if (s.state === "burnt") return "burnt";
      if (s.state === "over") return "over";
      if (s.state === "perfect") {
        if (s.serveWin > 0) return (plated ? "plated" : "window");
        return "ready";
      }
      var sec = (s.t || 0) / 1000;
      if (!(sec > 0)) return "raw";
      var f = FOOD[s.food];
      if (f && sec < f.dur) return "cooking";
      return plated ? "plated" : "cooking";
    }
    return plated ? "plated" : "idle";
  }
  /** 盘状态机（纯函数）：plated → hot → warm → cold → burnt → served / trashed */
  function platePhaseOf(p, elapsed) {
    if (!p) return "none";
    if (p.state === "burnt") return "burnt";
    var age = Math.max(0, Number(elapsed) - (p.at || 0));
    if (plateBurntAt(age)) return "burnt";
    return heatTierOf(p.state, age);
  }
  function activeCustomers(st) {
    var out = [];
    for (var i = 0; i < st.customers.length; i++) if (!st.customers[i].left) out.push(st.customers[i]);
    return out;
  }
  function remainOf(c) {
    var n = 0;
    for (var i = 0; i < c.order.length; i++) if (c.done.indexOf(c.order[i]) < 0) n++;
    return n;
  }
  function addFloat(st, text, color, size, x, y) {
    st.floats.push({ x:(x === undefined ? 0 : x), y:(y === undefined ? 0 : y), text:text,
                     c:color || "#ffd76e", size:size || 24, t:0, life:0.95, at:0 });
    return st.floats[st.floats.length - 1];
  }

  /** 单击食材桶：食物自动进入「它自己那一列」的锅（要求 A1/A2：一一对应，不认别的灶位）。
      stationIdx 只在「拖拽」时传进来，用来把「拖到别人的锅」明确拒掉（原因码 wrong-column）。 */
  function placeFoodEx(st, foodId, stationIdx, opts) {
    opts = opts || {};
    function no(why) {
      var r = { ok:false, why:why, hint:PLACE_WHY[why] || "", station:-1, food:foodId };
      if (st) st.lastPlace = r;
      return r;
    }
    if (!st || !st.running || st.over) return no("not-running");
    if (!FOOD[foodId]) return no("no-food");
    var own = columnOf(foodId);
    if (own < 0) return no("no-food");
    /* 列绑定写死：拖到别的列 = 拒绝（不是「有别的空锅就去」） */
    if (stationIdx !== undefined && stationIdx !== null && stationIdx >= 0 && stationIdx !== own)
      return no("wrong-column");
    var si = own;
    var s = stationByIdx(st, si);
    if (!s) return no("no-free-station");
    if (s.food) return no("station-occupied");                 // 锅里还在做：生的 / 熟的 / 糊的残骸
    if (plateIdxOfStation(st, si) >= 0) return no("plate-occupied");   // 本列盘里还有一份 → 不准再下料
    s.food = foodId; s.t = 0; s.state = "raw"; s.doneAt = 0; s.at = st.elapsed;
    s.serveWin = 0; s.readyAt = 0; s.burntAt = 0;  // 下料即清空上一次的窗口 / 糊焦计时
    s.manual = !!opts.manual;                     // manual = 按住盯火候（不自动落盘，测试/调试用）
    st.made++;
    st.selected = { kind:"station", idx:si };
    var ok = { ok:true, why:"", hint:"", station:si, col:si, food:foodId };
    st.lastPlace = ok;
    return ok;
  }
  /** 兼容旧签名：成功返回 true（原因码走 placeFoodEx / st.lastPlace） */
  function placeFood(st, foodId, stationIdx) { return placeFoodEx(st, foodId, stationIdx, null).ok; }
  /** 手动出餐：把锅里做好的食物拾到它自己的专属盘上（自动落盘模式下由 step 代劳）。
      每列都有盘（要求 A5），所以任何一列都能落盘。 */
  function takePlate(st, stationIdx) {
    if (!st || !st.running || st.over) return false;
    var s = stationByIdx(st, stationIdx);
    if (!s) return false;
    if (!hasPlate(stationIdx)) return false;
    if (plateIdxOfStation(st, stationIdx) >= 0) return true;      // 已经在自己盘上 → 幂等
    if (!s.food || s.state === "idle" || s.state === "raw") return false;
    st.plates.push(mkPlate(st, stationIdx, s.food, s.state));
    if (s.state === "perfect") st.prepped++;
    s.food = null; s.t = 0; s.state = "idle"; s.doneAt = 0; s.serveWin = 0; s.burntAt = 0;
    return true;
  }
  /** 自动落盘（要求 A3：熟了自动落到本列专属盘）：
      锅里一到「恰好」就落到本列的盘上，不用手动出锅、锅位立刻空出来。
      9 列都生效（不再分「预备盘 / 现做」）；manual（按住看火）时不落盘。 */
  function autoPlateStations(st) {
    var out = [];
    if (!st || !st.cfg || !st.cfg.autoPlate) return out;
    for (var i = 0; i < st.stations.length; i++) {
      var s = st.stations[i];
      if (!s.food || s.state !== "perfect" || s.manual) continue;
      if (plateIdxOfStation(st, i) >= 0) continue;
      st.plates.push(mkPlate(st, i, s.food, "perfect"));
      st.prepped++;
      var fb = plateBox(i);
      addFloat(st, "熟了 · 落到专属盘", PAL.green, 20, fb.x + fb.w / 2, fb.y + 8);
      s.food = null; s.t = 0; s.state = "idle"; s.doneAt = 0; s.serveWin = 0; s.burntAt = 0;
      out.push({ t:"plated", idx:i, station:i, food:st.plates[st.plates.length - 1].food });
    }
    return out;
  }
  /** 垃圾桶（双击盘 / 双击锅内成品 / 右键）：丢掉这一列锅与盘上的东西，不扣分，只浪费时间。
      糊掉的那份必须靠这一步才能清空（要求 A4：糊了只能双击丢掉）。 */
  function trashStation(st, stationIdx) {
    if (!st) return false;
    var s = stationByIdx(st, stationIdx);
    if (!s) return false;
    var k = plateIdxOfStation(st, stationIdx);
    if (!s.food && k < 0) return false;
    var wasBurnt = (s.state === "burnt") || (k >= 0 && st.plates[k].state === "burnt");
    var wasGood = !wasBurnt && (!!s.food || k >= 0);
    st.tossed++;
    if (wasBurnt) addFloat(st, "丢掉糊的（不扣分）", "#c8b8a6", 20);
    else if (wasGood) addFloat(st, "丢垃圾桶（不扣分）", "#c8b8a6", 20);
    s.food = null; s.t = 0; s.state = "idle"; s.doneAt = 0; s.serveWin = 0; s.readyAt = 0; s.burntAt = 0;
    if (k >= 0) st.plates.splice(k, 1);
    return true;
  }
  /** 丢一盘（按灶位；盘与该灶位一一对应，所以等价于 trashStation） */
  function trashPlate(st, stationIdx) { return trashStation(st, stationIdx); }
  /** 「双击盘/锅」＝丢这一列（要求 A4）—— 语义与 trashStation 完全一致，单独留个名字给交互层与测试 */
  function trashColumn(st, stationIdx) { return trashStation(st, stationIdx); }
  /** 自动挑一盘：只挑「这位顾客还缺的」那一盘，越合适（订单要的 / 完美 / 新鲜）分越高。
      他还要的菜已经上过的那一份不再重复给（否则等于白送一次「上错菜」−5）。
      主动点错（点某盘送给不对的人）仍然照旧扣分 —— 那是玩家的操作。 */
  function pickPlateIndex(st, customer) {
    var best = -1, bestScore = -1, i, p, sc;
    for (i = 0; i < st.plates.length; i++) {
      p = st.plates[i];
      if (!isFoodInOrder(customer.order, p.food)) continue;              // 他没点这样
      if (customer.done.indexOf(p.food) >= 0) continue;                 // 这样已经给过他了
      sc = 100.6;
      if (p.state === "burnt") sc -= 50;
      else if (p.state === "perfect") sc += 8;
      sc += (p.tier === "hot" ? 3 : (p.tier === "warm" ? 1 : 0)) + Math.max(0, 1 - (p.cookSec || 0) / 6);
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    return best;
  }
  /** 单击盘时「自动挑顾客」（要求 A3）：在正等着这份、且还没拿到这份的顾客里，
      挑耐心最少的那位（并列时先来的先得）。返回顾客在 st.customers 里的下标，没人要返回 -1。 */
  function pickCustomerIndexFor(st, foodId) {
    var best = -1, bestPat = Infinity;
    for (var i = 0; i < st.customers.length; i++) {
      var c = st.customers[i];
      if (!c || c.left || c.angry) continue;
      if (!isFoodInOrder(c.order, foodId)) continue;
      if (c.done.indexOf(foodId) >= 0) continue;
      var pat = Number(c.patience); if (!isFinite(pat)) pat = 0;
      if (pat < bestPat - 1e-9) { bestPat = pat; best = i; }
    }
    return best;
  }
  /** 单击某一列的专属盘 → 出餐（要求 A3）。返回 { ok, kind, why, hint, ... }：
      · 盘空            → no-plate（提示「盘里还空着」）
      · 盘上是糊的      → burnt  （提示「糊了，只能丢掉」→ 只能双击丢）
      · 此刻没人要这份  → no-want（不消耗，留在盘上继续走热乎度衰减）
      · 有人要          → 送给「耐心最少」的那位，按热乎档记账（14 / 10 / 6） */
  function serveFromColumn(st, stationIdx) {
    if (!st || !st.running || st.over) return { ok:false, why:"not-running", hint:"还没开局" };
    var k = plateIdxOfStation(st, stationIdx);
    if (k < 0) return { ok:false, why:"no-plate", hint:"盘里还空着 —— 先点下面的食材下锅", station:stationIdx };
    var p = st.plates[k];
    refreshPlate(st, p);
    if (p.state === "burnt")
      return { ok:false, why:"burnt", hint:"糊了，只能丢掉（双击这一列）", food:p.food, station:stationIdx };
    var ci = pickCustomerIndexFor(st, p.food);
    if (ci < 0)
      return { ok:false, why:"no-want", hint:"现在没人要这份 —— 先放着（会变凉）", food:p.food, station:stationIdx };
    var r = serveCustomer(st, ci, k);
    r.station = stationIdx;
    r.food = p.food;
    return r;
  }

  /* ── 出餐窗口（现做灶位）：出一份就要立刻送，超时即糊 ────────────────────
     openServeWindow：锅内刚到「恰好」→ 打开 SERVE_WINDOW 秒的窗口，并让火候暂停
       （step 里对处于窗口中的那份不再累加火候），所以这 3 秒是玩家真正能用的时间。
     expireServeWindows：窗口走完还没端走 → 那份糊掉（锅体焦黑 + 冒烟），必须丢垃圾桶才能再用。
     取出并立刻送往顾客由 takeReady 负责（服务记账走 serveFoodToCustomer，与盘上出餐同源）。 */
  function openServeWindow(st, stationIdx) {
    var s = stationByIdx(st, stationIdx);
    if (!st || !s || !s.food) return null;
    s.serveWin = SERVE_WINDOW;
    s.readyAt = st.elapsed;
    return { t:"window", idx:stationIdx, food:s.food, left:SERVE_WINDOW };
  }
  /** 独立跑一次「窗口超时结算」（step 每帧已内联同样逻辑；这个入口供单测 / 外部调用）。
      调用前应先把 serveWin 递减到 0（例如 step 的帧推进）。 */
  function expireServeWindows(st) {
    var ev = [];
    if (!st) return ev;
    for (var i = 0; i < st.stations.length; i++) {
      var s = st.stations[i];
      if (!s.food || s.state === "burnt") continue;
      if (!(s.serveWin > 0)) continue;
      /* 窗口只属于「恰好」那一刻：一旦这份食物越过完美窗口（变过火），就没得端了 */
      if (s.state !== "perfect") { s.serveWin = 0; continue; }
      if (s.serveWin > 0) continue;                      // 窗口还没走完 → 继续等玩家出手
      s.state = "burnt";                                 // 窗口走完还没端走 → 忘出锅，糊
      st.burnt++; st.expire++;
      st.smoke.push({ x:i, t:0, life:1.6 });
      var bb = stationBox(i);
      addFloat(st, "忘出锅 · 糊了！", "#ff4d6d", 28, bb.x + bb.w / 2, bb.y + bb.h / 2);
      ev.push({ t:"burnt", idx:i, food:s.food, why:"window-expired" });
    }
    return ev;
  }
  /** 现做灶位的「取出并立刻送往顾客」：
      有顾客正等着这份 → 记一次正常服务（热乎档，与盘上出餐同一套记账）；
      没人点这份 → 只能丢弃（不扣分，避免窗口一开就必然烧焦）。
      返回 { ok, kind:"served"|"tossed", ... }。 */
  function takeReady(st, stationIdx) {
    if (!st || !st.running || st.over) return { ok:false, why:"not-running" };
    var s = stationByIdx(st, stationIdx);
    if (!s || !s.food) return { ok:false, why:"no-food" };
    if (s.state === "burnt") return { ok:false, why:"burnt", hint:"糊了，只能丢掉（双击这一列）" };
    if (s.state === "raw") return { ok:false, why:"raw", hint:"还没熟" };
    if (!(s.serveWin > 0)) return { ok:false, why:"no-window", hint:"这份没在出餐窗口里（过火了）" };
    var foodId = s.food, state = s.state, cookSec = round1((s.t || 0) / 1000);
    /* 找一位正等着这份的顾客 —— 复用盘上出餐的同一条选客规则（pickCustomerIndexFor：
       正等着这份、且还没拿到这份的顾客里挑耐心最少的那位，并列时先来的先得）。
       这里以前另外写了一段「先来先得」的 first-fit，与规则层不一致：
       同一个食物，「点盘出餐」和「锅里现取」会送给不同的顾客。 */
    var ci = pickCustomerIndexFor(st, foodId), target = (ci >= 0) ? st.customers[ci] : null;
    /* 无论送出还是丢弃，这份都离开锅 → 灶位立刻空出来 */
    s.food = null; s.t = 0; s.state = "idle"; s.doneAt = 0; s.serveWin = 0; s.readyAt = 0; s.burntAt = 0;
    if (!target) {
      addFloat(st, (FOOD[foodId] || {}).n + " 没人点 —— 丢弃（不扣分）", "#c8b8a6", 22);
      return { ok:true, kind:"tossed", food:foodId, served:false };
    }
    var r = serveFoodToCustomer(st, target, foodId, state, "hot", cookSec);
    if (r.kind === "wrong") {                            // 理论上不会发生（已经按单匹配）
      addFloat(st, "上错菜了！", "#ff4d6d", 24);
    }
    return { ok:true, kind:"served", food:foodId, served:true, heat:"hot", delta:r.delta,
             perfect:r.perfect, customer:r.customer, score:r };
  }
  /** 出餐记账核心（盘上出餐与现做灶位出餐共用一套规则）：
      糊菜端上桌 → 顾客当场离开（−5）；上错菜 → −5；对上了 → 热乎档分（14/10/6，过火再 −3）。 */
  function serveFoodToCustomer(st, c, foodId, foodState, tier, cookSec) {
    if (foodState === "burnt") {                      // 糊菜端上桌 → 顾客直接不满离开（规则不变）
      st.score += scoreDelta("burnt");
      st.burntServed++; st.angry++;
      c.angry = true; c.left = true; c.leftAt = st.elapsed;
      addFloat(st, "糊的！" + SCORE.burnt, "#ff4d6d", 30);
      return { ok:true, kind:"burnt", food:foodId, state:foodState, heat:tier, delta:SCORE.burnt, customer:c };
    }
    if (!isFoodInOrder(c.order, foodId)) {           // 上错菜
      st.score += scoreDelta("wrong");
      st.wrong++;
      addFloat(st, "上错菜 " + SCORE.wrong, "#ff4d6d", 28);
      return { ok:true, kind:"wrong", food:foodId, state:foodState, heat:tier, delta:SCORE.wrong, customer:c };
    }
    var perfect = foodState === "perfect";
    var d = serveScore(foodState, tier);
    st.score += d;
    st.heat[tier] = (st.heat[tier] || 0) + 1;
    if (perfect) { st.perfect++; if (tier === "hot") st.hot++; } else st.normal++;
    if (!c.perfectList) c.perfectList = [];
    c.perfectList[c.order.indexOf(foodId)] = perfect;
    c.done.push(foodId);
    var HEATC = { hot:"#ffd76e", warm:"#ffb347", cold:"#9aa3b8" };
    addFloat(st, (d > 0 ? "+" : "") + d + (perfect ? "" : " 过火"),
             HEATC[tier] || "#cfd2e6", tier === "hot" ? 30 : 24);
    if (remainOf(c) <= 0) {
      var allPerfect = true;
      for (var i = 0; i < c.order.length; i++) if (!c.perfectList[i]) allPerfect = false;
      if (allPerfect && c.order.length > 1) {
        st.score += scoreDelta("star");
        addFloat(st, "全部完美 +" + SCORE.star, "#5dffa0", 24);
      }
      c.servedAt = st.elapsed;
      c.left = true; c.leftAt = st.elapsed;          // 立刻让出座位，1.3s 后再从画面移除
      st.served++;
    }
    /* ② 拿到早餐 → 高兴地「呜呼～」：一次成功上餐只播一次；
       糊的 / 上错的在上面两个分支就 return 了，不会响（那种情况顾客要走，不该欢呼）。 */
    playHappy(st);
    return { ok:true, kind: perfect ? (tier === "hot" ? "perfect-hot" : "perfect") : "over",
             food:foodId, state:foodState, heat:tier, delta:d, perfect:perfect, cookSec:cookSec, customer:c };
  }
  /** 出餐给顾客（pi 省略时自动挑一盘最合适的）。
      取走那一盘 = 它所属的灶位立刻空出来可用（要求 A2）。 */
  function serveCustomer(st, ci, pi) {
    if (!st || !st.running || st.over) return { ok:false, why:"not-running" };
    var c = st.customers[ci];
    if (!c || c.left || c.angry) return { ok:false, why:"no-customer" };
    if (pi === undefined || pi === null || pi < 0) pi = pickPlateIndex(st, c);
    var p = (pi >= 0) ? st.plates[pi] : null;
    if (!p) return { ok:false, why:"no-plate" };
    refreshPlate(st, p);
    st.plates.splice(pi, 1);
    /* 盘被取走 → 归属灶位立刻可用（糊的也算，见下面 burnt 分支） */
    var owner = stationByIdx(st, p.station);
    if (owner) { owner.food = null; owner.t = 0; owner.state = "idle"; owner.doneAt = 0; owner.serveWin = 0; owner.burntAt = 0; }
    var tier = p.tier || heatTierOf(p.state, st.elapsed - p.at);
    return serveFoodToCustomer(st, c, p.food, p.state, tier, p.cookSec);
  }

  function spawnCustomer(st, order) {
    var c = newCustomer(st.seq++, st.elapsed, st.cfg, rnd01());
    if (order && order.length) {
      c.order = order.slice();
      c.patienceMax = c.patience = patienceFor(c.order.length, st.elapsed, st.cfg);
    }
    c.t = st.elapsed;
    st.customers.push(c);
    return c;
  }

  /** 纯逻辑推进：dt 秒。返回本步事件列表 */
  function step(st, dt) {
    var ev = [];
    if (!st || !st.running || st.over) return ev;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.5) dt = 0.5;                          // 卡帧保护
    st.elapsed += dt;
    var i, k, s, c, cst;

    /* 灶位火候推进 */
    for (i = 0; i < st.stations.length; i++) {
      s = st.stations[i];
      if (!s.food) continue;
      /* 现做灶位进了出餐窗口 → 火候暂停（"关火等人端"）：
         这样「出锅 3.5 秒内送出去」才是真正可用的 3 秒，而不是被 0.8s 的完美窗口提前吃掉。
         已经糊的那份也不再推进火候（糊了只能丢，不会自己"回生"）。 */
      if (!isServeWindowOpen(s) && s.state !== "burnt") s.t += dt * 1000;
      var ns = cookState(s.food, s.t / 1000);
      /* 糊过的那份不再回生：火候停在「恰好」的边界上时，cookState 会重新算出 perfect，
         所以糊了就是糊了 —— 只能丢垃圾桶（trashStation 才会清空灶位）。 */
      if (s.state === "burnt") ns = "burnt";
      if (ns !== s.state) {
        if (ns === "perfect") {
          s.doneAt = st.elapsed;
          ev.push({ t:"perfect", idx:i, food:s.food });
          /* 旧机制的兼容保留：只有「没有专属盘」的灶位才会在锅内开「出餐窗口」。
             现在 9 列都有盘（hasPlate 恒为 true），所以这一步永远不触发；
             autoPlateStations 会在同一帧里把这份直接落到本列专属盘上。
             注意 manual 只表示「别自动落盘」（按住看火 / 调试用），与窗口无关。 */
          if (!hasPlate(i)) ev.push(openServeWindow(st, i));
        }
        if (ns === "burnt" && s.state !== "burnt") {
          st.burnt++;
          st.smoke.push({ x:i, t:0, life:1.6 });
          var bb = stationBox(i);
          addFloat(st, "糊了！", "#ff4d6d", 28, bb.x + bb.w / 2, bb.y + bb.h / 2);
          ev.push({ t:"burnt", idx:i, food:s.food });
        }
        s.state = ns;
      }
      /* 出餐窗口倒计时（现做灶位）：窗口走完还没端走 → 当场糊 */
      if (!hasPlate(i) && s.state === "perfect" && s.serveWin > 0) {
        s.serveWin = Math.max(0, s.serveWin - dt);
        if (s.serveWin <= 0) {
          s.state = "burnt"; st.burnt++; st.expire++;
          st.smoke.push({ x:i, t:0, life:1.6 });
          var wb = stationBox(i);
          addFloat(st, "忘出锅 · 糊了！", "#ff4d6d", 28, wb.x + wb.w / 2, wb.y + wb.h / 2);
          ev.push({ t:"burnt", idx:i, food:s.food, why:"window-expired" });
        }
      } else if (!hasPlate(i) && s.state !== "perfect" && s.serveWin > 0) {
        s.serveWin = 0;                                  // 越过完美窗口 → 窗口作废
      }
      /* 糊了又放着不管：残骸按壁钟时间留 14 秒自动清（连它的盘一起清），不至于永久堵灶 */
      if (s.state === "burnt" && !s.burntAt) s.burntAt = st.elapsed;
      if (s.state === "burnt" && st.elapsed - s.burntAt > BURNT_LIFE_MS / 1000) {
        s.food = null; s.t = 0; s.state = "idle"; s.serveWin = 0; s.readyAt = 0; s.burntAt = 0;
        var kb = plateIdxOfStation(st, i);
        if (kb >= 0) st.plates.splice(kb, 1);
      }
    }
    /* 自动落盘（要求 A3）：一到「恰好」就落到本列的专属盘上（9 列都生效）*/
    var plated = autoPlateStations(st);
    for (i = 0; i < plated.length; i++) ev.push(plated[i]);
    /* 专属盘：热乎度只随时长降档（热乎 → 温 → 凉）；
       走过 SERVE_WINDOW（过火计时，4.5s）→ 糊，只能双击丢掉（要求 A5 的压力来源）。 */
    for (i = 0; i < st.plates.length; i++) {
      var pl = st.plates[i];
      refreshPlate(st, pl);
      if (pl.state !== "burnt" && plateExpired(st, pl)) {
        pl.state = "burnt"; pl.tier = heatTierOf("burnt", pl.age || 0); pl.hot = false;
        pl.left = 0; pl.burning = true; pl.burntAt = st.elapsed;
        st.burnt++; st.expire++;
        st.smoke.push({ x:pl.station, t:0, life:1.6 });
        var pb2 = plateBox(pl.station);
        addFloat(st, "忘取了 · 糊了！", "#ff4d6d", 24, pb2.x + pb2.w / 2, pb2.y + 8);
        ev.push({ t:"plate-burnt", idx:pl.station, station:pl.station, food:pl.food, why:"plate-expired" });
        continue;
      }
      /* 糊了又不管：残骸按壁钟时间留 14 秒自动清（这一列的盘清空），不至于永久堵住一列 */
      if (pl.state === "burnt") {
        if (!pl.burntAt) pl.burntAt = st.elapsed;
        if (st.elapsed - pl.burntAt > BURNT_LIFE_MS / 1000) { st.plates.splice(i, 1); i--; }
      }
    }
    /* 顾客耐心 */
    var list = activeCustomers(st);
    var leftNow = false;          // 本帧有没有人「等太久走掉」（同一帧多人也只播一次「哼，太慢了」）
    for (i = 0; i < list.length; i++) {
      c = list[i];
      if (remainOf(c) <= 0) { c.left = true; c.leftAt = st.elapsed; continue; }
      c.patience -= dt;
      if (c.patience <= 0) {
        c.left = true; c.angry = true; c.leftAt = st.elapsed;
        if (!c.counted) {                        // 每位顾客只记一次「跑单」
          c.counted = true;
          st.angry++; st.score += scoreDelta("leave");
          addFloat(st, "顾客走了 " + SCORE.leave, "#ff4d6d", 26);
          ev.push({ t:"leave", id:c.id });
          leftNow = true;
        }
      }
    }
    /* 已完成的顾客留 0.5s 让飘字播完，然后离场（已完成的在出餐时就置 left） */
    for (i = st.customers.length - 1; i >= 0; i--) {
      c = st.customers[i];
      if (c.left && c.leftAt !== undefined && st.elapsed - c.leftAt > 1.3) st.customers.splice(i, 1);

    /* 音效 / 顾客语音调度：放在顾客账算完**之后** —— 所以「顾客跑单 / 被服务完」当帧就会停滴答。
       滴答的阈值 / 节奏 / 全局节流、以及「哼，太慢了」的只播一次，都在 stepAudio 里（纯函数可单测）。*/
    stepAudio(st, leftNow);
    }
    /* 粒子 / 飘字 */
    for (i = st.smoke.length - 1; i >= 0; i--) { st.smoke[i].t += dt; if (st.smoke[i].t > st.smoke[i].life) st.smoke.splice(i, 1); }
    for (i = st.floats.length - 1; i >= 0; i--) { st.floats[i].t += dt; if (st.floats[i].t > st.floats[i].life) st.floats.splice(i, 1); }

    /* 顾客进店 */
    if (activeCustomers(st).length < MAX_CUSTOMERS) {
      st.nextIn -= dt;
      if (st.nextIn <= 0) {
        spawnCustomer(st);
        st.nextIn = nextGap(st.elapsed, st.cfg, activeCustomers(st).length, rnd01());
      }
    } else st.nextIn = Math.min(st.nextIn, 0.12);     // 满员：下一位在门口等着

    /* 胜负判定 */
    if (st.served >= st.cfg.goal) { ev.push({ t:"win" }); finish(st, true, "服务满 " + st.cfg.goal + " 位顾客"); }
    else if (st.angry >= MAX_ANGRY) { ev.push({ t:"lose" }); finish(st, false, "连着气走了 " + MAX_ANGRY + " 位顾客"); }
    else if (st.elapsed >= st.cfg.duration) {
      var w = st.served >= st.cfg.goal;
      finish(st, w, w ? ("服务满 " + st.cfg.goal + " 位顾客") : ("时间到，只服务了 " + st.served + " 位"));
      ev.push({ t: w ? "win" : "lose" });
    }
    return ev;
  }

  /** 结算：算出 result（含 bondDelta / quote / impact） */
  function finish(st, win, reason) {
    if (!st) return null;
    if (st.over) return st.result;
    st.over = true; st.running = false; st.win = !!win; st.reason = reason || "";
    var target = st.cfg.target || null;
    var role = (target && target.role) ? target.role : (target ? target.id : "");
    var hot = st.hot, i;
    for (i = 0; i < st.plates.length; i++) if (st.plates[i].hot) hot++;
    var quality = bondHeat(st.perfect, hot) / 100;
    var delta = bondDeltaFor(st.win, st.perfect, hot, st.burnt, st.served);
    st.result = {
      win: st.win, served: st.served, goal: st.cfg.goal,
      perfect: st.perfect, normal: st.normal, hot: hot,
      burnt: st.burnt, burntServed: st.burntServed, wrong: st.wrong, angry: st.angry, made: st.made,
      heat: { hot:st.heat.hot || 0, warm:st.heat.warm || 0, cold:st.heat.cold || 0 },
      prepped: st.prepped || 0,
      expire: st.expire || 0, tossed: st.tossed || 0,
      /* 兼容字段：prepPlates / serveWindow 保留，但语义已变 —— 现在 9 列各 1 盘、
         serveWindow = 盘上的「过火计时」；serveStations（无盘灶位）恒为 0 */
      prepPlates: PLATES_TOTAL, platesTotal: PLATES_TOTAL, columns: COL_N,
      serveWindow: SERVE_WINDOW, plateLife: SERVE_WINDOW, serveStations: 0,
      starRate: st.served > 0 ? Math.round((st.perfect / st.served) * 100) / 100 : 0,
      score: st.score, elapsed: round1(st.elapsed), duration: st.cfg.duration,
      bondDelta: delta, quality: quality,
      target: target ? { id:(target.id || ""), name:(target.name || target.id || ""), bond:target.bond } : null,
      quote: quoteFor(role, st.win, quality, st.seq),
      impact: impactOf(st.win, st.perfect, st.burnt, hot, target ? (target.name || "") : "对方"),
      quota: quotaOf(st.win, delta, target ? (target.name || "") : "对方"),
      reason: st.reason
    };
    return st.result;
  }

  /* ═══════════════ 3. Canvas 渲染（全程序化，零外部图片） ═══════════════ */

  /* ── 画面尺寸 / 字号 / 图标尺寸（要求 B：整体放大到 1440 窗口下几乎铺满）──────
     文字一律用 Canvas fillText 真系统字体（中文正常），不使用点阵字。          */
  var VIEW = { w: 1180, h: 790 };
  var W = VIEW.w, H = VIEW.h;
  var FONT = { tiny:16, body:17, label:18, name:20, title:22, micro:13, small:14,
               num:30, clock:34, score:34, patience:28, cardNo:19, bucket:19, panName:15 };
  var ICON = { food:76, bucket:74, card:68, plate:64, pan:72 };   // 单份食物视觉尺寸（px）
  var FS = { bucket:1.95, card:1.5, plate:1.5, pan:1.7, shop:1.35 };  // 矢量食物缩放

  /* ═══ 贴图资源总表（art/**）：**所有**贴图走同一个加载器 ═══════════════════
     离线优先、缺图可玩：模块初始化时用 new Image() 预加载本地 PNG，绘制处优先
     drawImage；图片没就绪 / 加载失败 / 环境里根本没有 Image（无头测试、老浏览器）
     → 一律回退到原来的矢量画法（食材 drawFoodVector / 程序化头像 / 矢量锅盘 / 矢量勾叉）。
     所以规格是：**只允许加载 art/ 下的本地图片，且每一处都必须有矢量回退**。

     五组资源，路径全部由「当前页面所在目录 + 组目录」拼出来，
     绝不写死盘符 / 协议 / data URI → 整个文件夹换位置也能跑：

       food  art/icons/<foodId>.png   9 张食材（上一轮已接入）
       gear  art/icons/gear/*.png     9 张厨具（汤锅/三格煎盘/蒸笼 · 空盘/煎蛋培根盘/包子盘 · 果汁壶/木托盘/锅铲夹子）
       face  art/icons/faces/*.png   15 张顾客头像（5 位角色：学生/白领/大爷/房东/护士 × 平静/着急/满意）
       ui    art/icons/ui/*.png       9 个 UI 元素（耐心条底/满、三星、木牌按钮、红漆按钮、金币、灯泡、绿勾、红叉）
       bg    art/bg/kitchen.png       场景背景（木台面 + 樱花街 + 右后开放厨房）

     尺寸：SPEC 是原素材里「食物的视觉跨度」；IMG_SPAN 是它在 drawFood 局部
     坐标（未缩放）里的等效跨度。矢量画法的形状大致落在 ±18 之内（跨度 ≈36），
     所以取 36 就能让贴图与原来的视觉尺寸一致，同时沿用既有的 FS.* 缩放 ——
     桶 74 / 卡 68 / 盘 64 / 煎盘 72 与列对齐、点击热区全部不变。
     其余贴图一律「等比塞进各自的框里居中」，绝不拉伸变形。 */
  var ICON_ROOT = "";                    // 测试可覆盖的根目录（__bfPreloadIcons）
  /** 页面所在目录（带结尾 /）；取不到就返回空串（相对路径照样能用） */
  function pageDir() {
    var loc = root.location, href = "";
    if (loc) {
      if (typeof loc.href === "string" && loc.href) href = loc.href;
      else if (typeof loc.pathname === "string" && loc.pathname) href = loc.pathname;
    }
    if (!href) return "";
    href = href.replace(/\\/g, "/");
    var i = href.lastIndexOf("/");
    return i >= 0 ? href.slice(0, i + 1) : href;
  }
  var ICON_GROUPS = [];
  function mkIconGroup(key, dir, ids) {
    var g = { key:key, dir:dir, ext:".png", ids:ids, base:"", map:{}, loaded:0, failed:0 };
    ICON_GROUPS.push(g); return g;
  }
  var FOOD_ICON = mkIconGroup("food", "art/icons/", FOOD_IDS);
  FOOD_ICON.spec = ICON.food; FOOD_ICON.span = 36; FOOD_ICON.scale = 1;
  FOOD_ICON.forceFail = false; FOOD_ICON.forceNull = false;
  var GEAR_ICON = mkIconGroup("gear", "art/icons/gear/",
    ["pot", "griddle", "steamer",
     "plate_empty", "plate_egg", "plate_bacon", "plate_sandwich", "plate_bun", "plate_salad",
     "juice_jug", "tray", "tools"]);
  var FACE_ICON = mkIconGroup("face", "art/icons/faces/",
    ["stud_calm", "stud_urgent", "stud_happy", "office_calm", "office_urgent", "office_happy",
     "uncle_calm", "uncle_urgent", "uncle_happy",
     "fang_calm", "fang_urgent", "fang_happy", "lu_calm", "lu_urgent", "lu_happy"]);
  var UI_ICON = mkIconGroup("ui", "art/icons/ui/",
    ["bar_empty", "bar_full", "stars", "btn_wood", "btn_red", "coin", "bulb", "check", "cross"]);
  /* 头像阈值：耐心 ≤ 40% → 「着急」那张脸；> 40% → 「平静」；全部拿到 → 「满意」（见 faceMoodOf）*/
  FACE_ICON.urgentAt = 0.40;
  /** 组基准路径（带结尾 /）：页面目录 + 组目录；测试覆盖时用 ICON_ROOT 顶掉页面目录 */
  function groupBase(g) { return (ICON_ROOT || pageDir()) + g.dir; }
  function initIconGroup(g) {
    g.base = groupBase(g);
    g.loaded = 0; g.failed = 0; g.map = {};
    if (!root.Image || FOOD_ICON.forceNull) return g;           // 无 Image 构造器 → 全矢量
    for (var i = 0; i < g.ids.length; i++) {
      (function (id) {
        var img = null;
        try { img = new root.Image(); } catch (e) { img = null; }
        if (!img) { g.failed++; return; }
        g.map[id] = img;
        if (FOOD_ICON.forceFail) { g.failed++; return; }         // 只有 onerror 会来
        img.onload = function () { g.loaded++; };
        img.onerror = function () { g.failed++; };
        try { img.src = g.base + id + g.ext; } catch (e) { g.failed++; }
      })(g.ids[i]);
    }
    return g;
  }
  /* ── 背景底图（art/bg/kitchen.png）─────────────────────────────────────────
     素材已按画布比例裁好（1193×798 ≈ VIEW 1180×790），并让「干净木台面上沿」
     正好落在画布 y = 318（= LAY.colHeaderY，列头线）：
       源图 2048×1152 里木台面上沿 y=675 → 裁切图内 y=321 → 画布 y=317.8
     于是 盘带 328..438 / 锅带 450..608 / 桶带 624..776 三段**全部**落在木台面上，
     而顾客卡与顶栏落在街景上 —— 游戏元素一个都没动（列对齐有无头断言保护）。
     裁切参数与测量过程在 art/_assets_report.json（脚本 _bf_assets_gen.cjs 自动求出）。 */
  /* ── 背景底图（两级回退）─────────────────────────────────────────────────────
     首选 art/bg/kitchen2.png（本批 Lovart 新素材：**完整樱花树冠 + 完整开放厨房与货架**，
     主体离边 ≥5% 安全边距）；加载失败 → art/bg/kitchen.png（上一轮 v1）；
     再失败 → drawBg 里的程序化木台 / 樱瓣 / 暖光底。功能一点不少。

     v2 的裁切策略与代价（参数全部由 tools/bf/assets/gen2.js 从源图自动求出，
     写进 art/_assets2_report.json，这里只是把测量结果抄成常量给无头断言校验）：
       源图 2048×1152，测出「干净木台面上沿」源 y=704；
       画布 1180×790，若把台面精确对到 LAY.colHeaderY=318，需要放大到 scale≈1.05，
       左右各裁 464px（源宽的 45%）→ 樱花树冠与右侧货架会被裁掉，正是 v2 要避免的。
       所以 v2 选择**保整幅宽**：scale = 1180/2048 = 0.5762，左右 0 裁切；
       代价是台面在画布上落到 y≈406（而非 318），画布底部缺的 126px 用
       「台面木纹纵向平铺 + 向底端线性压深 40%」补满（木纹横向连续，接缝不可见）。
       ⇒ 9 列元素（盘带 328..438 / 锅带 450..608 / 桶带 624..776）位置一字未动，
         台面把它们全部覆盖（台面顶 406 在盘带之内 → 盘/锅/桶三段都画在木台面上）。      */
  var BG_SLOTS = [
    { id:"kitchen2", name:"kitchen2.png", img:null, loaded:0, failed:0 },
    { id:"kitchen",  name:"kitchen.png",  img:null, loaded:0, failed:0 }
  ];
  var BG_META = {
    kitchen2: {
      srcSpec: { w: 2048, h: 1152 },
      srcWindow: { x: 0, y: 0, w: 2048, h: 1371 },        // 覆盖源图整幅宽（1371 = 790 / 0.5762）
      scale: 0.576172,
      counterTopSrcY: 704, counterTopInCrop: 704, counterTopCanvasY: 405.7,
      strategy: "full-width", croppedPerSide: 0, croppedPercent: 0, bottomFillPx: 126,
      aspect: 1180 / 790
    },
    kitchen: {
      srcSpec: { w: 2048, h: 1152 },
      srcWindow: { x: 428, y: 354, w: 1193, h: 798 },
      scale: 1.0,
      counterTopSrcY: 675, counterTopInCrop: 321, counterTopCanvasY: 318,
      strategy: "v1-cover-crop", croppedPerSide: 0, croppedPercent: 0, bottomFillPx: 0,
      aspect: 1193 / 798
    }
  };
  var BG_IMG = {
    dir: "art/bg/", name: "kitchen2.png", img: null, loaded: 0, failed: 0,
    /* 兼容旧字段（v1 的裁切测量结果仍然保留，断言读得到）*/
    srcSpec: { w: 2048, h: 1152 },
    crop: { x: 428, y: 354, w: 1193, h: 798 },
    counterTopSrcY: 675, counterTopInCrop: 321, counterTopCanvasY: 318,
    scrimTop: 0.66, scrimAll: 0.32, bottomFillDark: 0.40,     // 可读性压暗：整幅 32%
    fillFromCounter: true                                     // 底部补带取「木台面木纹条」
  };
  /** 当前生效的背景槽（v2 可用 → v2；否则 v1；都不可用 → null）*/
  function bgSlotActive() {
    for (var i = 0; i < BG_SLOTS.length; i++) {
      var s = BG_SLOTS[i];
      if (s.img) { var nw = s.img.naturalWidth || 0; if (nw > 0 && s.img.complete !== false) return s; }
    }
    return null;
  }
  function initBackground() {
    for (var i = 0; i < BG_SLOTS.length; i++) {
      var s = BG_SLOTS[i];
      s.img = null; s.loaded = 0; s.failed = 0;
      if (!root.Image || FOOD_ICON.forceNull) continue;
      var img = null;
      try { img = new root.Image(); } catch (e) { img = null; }
      if (!img) { s.failed++; continue; }
      s.img = img;
      if (FOOD_ICON.forceFail) { s.failed++; continue; }
      (function (slot) {
        slot.img.onload = function () { slot.loaded++; };
        slot.img.onerror = function () { slot.failed++; };
      })(s);
      try { img.src = (ICON_ROOT || pageDir()) + BG_IMG.dir + s.name; } catch (e) { s.failed++; }
    }
    /* 兼容字段：让 art.bg() / 旧断言仍能读到「当前生效那张」的信息 */
    var act = bgSlotActive();
    BG_IMG.img = act ? act.img : (BG_SLOTS[0].img || BG_SLOTS[1].img || null);
    BG_IMG.name = act ? act.name : BG_SLOTS[0].name;
    BG_IMG.loaded = BG_SLOTS[0].loaded + BG_SLOTS[1].loaded;
    BG_IMG.failed = BG_SLOTS[0].failed + BG_SLOTS[1].failed;
    return BG_IMG;
  }

  function initIcons(baseDir) {
    ICON_ROOT = baseDir ? String(baseDir) : "";
    if (ICON_ROOT && ICON_ROOT.charAt(ICON_ROOT.length - 1) !== "/") ICON_ROOT += "/";
    for (var i = 0; i < ICON_GROUPS.length; i++) initIconGroup(ICON_GROUPS[i]);
    initBackground();
    return ICON_GROUPS;
  }
  /** 本帧可用（真解码完成）的贴图；否则返回 null → 调用方回退矢量 */
  function assetOf(g, id) {
    var img = g && g.map[id];
    if (!img) return null;
    var nw = img.naturalWidth || 0;
    return (nw > 0 && img.complete !== false) ? img : null;
  }
  function foodIcon(id) { return assetOf(FOOD_ICON, id); }
  function readyCount(g) { var n = 0; for (var i = 0; i < g.ids.length; i++) if (assetOf(g, g.ids[i])) n++; return n; }
  /** 9 张食材里有几张真的能画（给 debug / 测试用）*/
  function iconReadyCount() { return readyCount(FOOD_ICON); }
  /** 9 张食材里有几张只能走矢量回退 */
  function vectorCount() { return FOOD_IDS.length - iconReadyCount(); }
  /* 测试挂钩：允许在脚本装载前用 root.__bfIconPre 预设两个开关，
     这样「环境里没有 Image / 全部加载失败」两条回退分支才走得到。
     页面正常运行时这个变量不存在，两个开关都是 false。 */
  if (root.__bfIconPre) {
    FOOD_ICON.forceNull = !!root.__bfIconPre.noImages;
    FOOD_ICON.forceFail = !!root.__bfIconPre.forceFail;
  }
  /** 兼容旧名：重新预加载全部贴图（现在不只食材了）*/
  function initFoodIcons(baseDir) { initIcons(baseDir); return FOOD_ICON; }

  /** 灶位 kind → 厨具贴图名（锅 / 煎盘 / 蒸笼 / 木托盘 / 果汁壶）*/
  function gearNameOfKind(kind) { return GEAR_OF_KIND[kind] || null; }
  /* ── 贴图映射表（纯数据 + 纯函数：单测直接断言「映射完整」）───────────────
     盘位贴图：本批 Lovart 素材把「盘面」拆成了 6 张一一对应的图
     （空盘 / 只装煎蛋 / 只装培根 / 只装三明治 / 只装包子 / 只装沙拉）。
     上一轮的缺陷：煎蛋盘与培根盘共用 plate_egg_bacon.png → 盘上分不清食材。
     现在按「盘上实际食物」映射，每种食物一张：                             */
  var GEAR_OF_KIND = { pot:"pot", griddle:"griddle", steamer:"steamer", counter:"tray", juicer:"juice_jug" };
  var PLATE_TEX_OF_FOOD = {
    egg:"plate_egg", bacon:"plate_bacon", sandwich:"plate_sandwich",
    bun:"plate_bun", salad:"plate_salad"
  };
  var PLATE_TEX_IDS = ["plate_empty", "plate_egg", "plate_bacon", "plate_sandwich", "plate_bun", "plate_salad"];
  /** 盘位贴图：每种食物一张专属盘；没有专属盘的食材（白粥/汤/果汁/牛奶）用空盘 + 食材贴图 */
  function plateTexOfFood(foodId) { return foodId ? (PLATE_TEX_OF_FOOD[foodId] || "plate_empty") : "plate_empty"; }
  /** 这张盘贴图里自带食物吗（自带就不再叠一份食材贴图，避免一盘两样）*/
  function plateTexHasFood(foodId) { return !!(foodId && PLATE_TEX_OF_FOOD[foodId]); }
  /* ── 顾客角色池（要求：5 位外部形象随机分配，固定种子保证可复现）──────────────
     学生 stud（红帽·双肩包）/ 白领 office / 大爷 uncle 是上一轮的 3 位；
     本批新增女房东 fang / 女护士 lu。**卡位仍然是 3 张**，只换头像，不改布局。 */
  var FACE_KINDS = ["stud", "office", "uncle", "fang", "lu"];   // 5 位角色
  var FACE_MOODS = ["calm", "urgent", "happy"];                 // 三态
  var FACE_POOL_SEED = 20240918;                                // 固定种子（常量，可调）
  /** 固定种子的可复现随机角色池：同一 seed 永远得到同一套顺序 → 无头断言 / 出图都稳定。
      用 prand（纯函数）+ Fisher–Yates；纯函数、无副作用、可单测。            */
  function facePoolOf(seed) {
    var s = (seed === undefined || seed === null || !isFinite(Number(seed))) ? FACE_POOL_SEED : Math.round(Number(seed));
    var pool = FACE_KINDS.slice(), i, k, t;
    for (i = pool.length - 1; i > 0; i--) {
      k = Math.floor(prand(i * 7.13 + s * 0.0001) * (i + 1)) % (i + 1);
      t = pool[i]; pool[i] = pool[k]; pool[k] = t;
    }
    return pool;
  }
  /** 顾客编号 → 角色名（用常量池；state 版本见 faceNameIn）。负数 / 非数按 0。 */
  function faceKindOf(cid) {
    var n = Math.round(Number(cid));
    if (!isFinite(n)) n = 0;
    var pool = facePoolFor(null);
    return pool[Math.abs(n) % pool.length];
  }
  /** 本局角色池（有 cfg.seed 用 seed，否则用固定常量 → 永远可复现）*/
  function facePoolFor(state) {
    var s = (state && state.cfg && state.cfg.seed !== undefined) ? state.cfg.seed : FACE_POOL_SEED;
    return facePoolOf(s);
  }
  /** 「满意」判据 = 订单全部拿到（与 remainOf(c) <= 0 同源，这里显式写清并留常量说明）*/
  var FACE_SATISFIED_RULE = "order.length > 0 且 done 覆盖全部 order（等价于 remainOf(c) <= 0）";
  function faceSatisfied(c) {
    if (!c) return false;
    var order = c.order || [], done = c.done || [];
    if (!order.length) return false;
    for (var i = 0; i < order.length; i++) if (done.indexOf(order[i]) < 0) return false;
    return true;
  }
  /** 情绪判定（纯函数）：全部拿到（正在离场满意）→ happy；耐心 > 40% → calm；≤ 40% → urgent */
  function faceMoodOf(cid, patienceRatio, satisfied) {
    if (satisfied === true) return "happy";
    var n = Number(patienceRatio); if (!(n >= 0)) n = 1;
    return n > FACE_ICON.urgentAt ? "calm" : "urgent";
  }
  /** 顾客头像贴图名（三态）。cid 可以是顾客编号或顾客对象；state 给了就用本局角色池。 */
  function faceNameIn(state, cid, patienceRatio, satisfied) {
    var pool = facePoolFor(state);
    var n = Math.round(Number(cid)); if (!isFinite(n)) n = 0;
    var k = pool[Math.abs(n) % pool.length];
    return k + "_" + faceMoodOf(cid, patienceRatio, satisfied);
  }
  /** 兼容旧调用签名 faceNameOf(cid, ratio, satisfied)：用**常量池**（与 facePoolFor(null) 一致）*/
  function faceNameOf(cid, patienceRatio, satisfied) { return faceNameIn(null, cid, patienceRatio, satisfied); }
  /** 5 位角色 × 3 种情绪 = 15 张，**本轮已全部切齐**：
      上一轮 3 位老角色各有 calm/urgent 两张；素材二批补了女房东/女护士 ×3（6 张）；
      本轮（tools/bf/assets/faces-happy-gen.js，源 art/lovart_cca01cd7ba70.png 3 列 × 1 行）补了
      学生/女白领/胖大爷的 happy 三张 → 15 张在册，happy 态不再回退平静脸。
      回退链仍然保留两级：happy 缺图 → calm → 矢量头像（见 drawCustomerFace）。*/
  function faceTexIds() {
    var out = [];
    for (var i = 0; i < FACE_KINDS.length; i++) for (var j = 0; j < FACE_MOODS.length; j++) out.push(FACE_KINDS[i] + "_" + FACE_MOODS[j]);
    return out;
  }

  /* stars.png 里三颗星的子框（相对 stars.png 画布的比例）——由 _bf_assets_gen.cjs
     在源图上按「列投影的 3 段独立游程」测出来，写进 art/_assets_report.json */
  var STAR_SUB = [
    { x:0.0742, y:0.3594, w:0.2682, h:0.2852 },
    { x:0.3625, y:0.3594, w:0.2657, h:0.2852 },
    { x:0.6482, y:0.3594, w:0.2657, h:0.2852 }
  ];
  /* ── 贴图绘制的三个小工具（都保持长宽比，绝不拉伸变形）────────────────── */
  /** 等比塞进 box 并居中 */
  function fitIn(box, ar, k) {
    k = (k === undefined || !(k > 0)) ? 1 : k;
    var w = box.w * k, h = box.h * k;
    if (ar > w / h) h = w / ar; else w = h * ar;
    return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w: w, h: h };
  }
  /** 画一张贴图（等比塞进 box 居中）；alpha 传 null 表示沿用外层 globalAlpha */
  function drawAssetFit(g, img, box, alpha) {
    if (!img) return false;
    var nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
    if (!(nw > 0) || !(nh > 0)) return false;
    var r = fitIn(box, nw / nh);
    g.save();
    if (alpha !== undefined && alpha !== null) g.globalAlpha = alpha;
    g.drawImage(img, r.x, r.y, r.w, r.h);
    g.restore();
    return true;
  }
  /** 背景铺满画布的参数：素材比例与画布一致 → 直接整幅铺；换了素材比例不符 → 运行期 cover 裁切 */
  /* ── 背景铺满参数：优先用**当前生效那张背景自己的比例**（换了素材也不用改常量），
        比例不符就运行期 cover 居中裁切；比例一致（v1/v2 都是 1180:790）→ 直接整幅铺。 */
  function bgDrawArgs(img) {
    var nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
    if (!(nw > 0) || !(nh > 0)) return null;
    var arImg = nw / nh, arView = W / H;
    if (Math.abs(arImg - arView) / arView <= 0.02) return { sx:0, sy:0, sw:nw, sh:nh, dx:0, dy:0, dw:W, dh:H, mode:"fit" };
    var sw, sh;
    if (arImg > arView) { sh = nh; sw = nh * arView; } else { sw = nw; sh = nw / arView; }
    return { sx:(nw - sw) / 2, sy:(nh - sh) / 2, sw:sw, sh:sh, dx:0, dy:0, dw:W, dh:H, mode:"cover" };
  }
  /** 当前生效的背景源（槽位 + 测量常量）；都不可用 → null（drawBg 走程序化底）*/
  function bgSource() {
    var s = bgSlotActive();
    if (!s) return null;
    var meta = BG_META[s.id] || BG_META.kitchen;
    return { img:s.img, slot:s, id:s.id, meta:meta, scale:meta.scale };
  }
  /** 兼容旧名：当前背景图（没就绪 → null）*/
  function bgIcon() { var src = bgSource(); return src ? src.img : null; }
  /** 木台面上沿真实落在画布上的 y：按「当前生效那张背景」的实际比例算
      （v1 整幅铺 → 321/798*790 = 317.8；v2 整幅铺 → 704/1371*790 = 405.7）
      无头 / 单测用它断言「9 列元素一个都没被挪动」。 */
  function counterTopCanvasY() {
    var src = bgSource();
    if (!src || !src.img) return BG_META[BG_SLOTS[0].id].counterTopCanvasY;  // 没有贴图 → 报首选素材的几何常量
    var nw = src.img.naturalWidth || 0;
    /* 分母必须是**源窗口高**（= 源图高度），不是补带之后的画布高：
       v2 载入的是「整幅宽 + 底部补带」的成品图（1180×790），若拿它当分母，
       台面 y 会算成 704（源像素）而不是 405.7（画布像素）。 */
    var nh = (src.meta.srcWindow && src.meta.srcWindow.h) || src.img.naturalHeight || 0;
    if (!(nw > 0) || !(nh > 0)) return BG_META[BG_SLOTS[0].id].counterTopCanvasY;
    return Math.round(src.meta.counterTopSrcY * H / nh * 10) / 10;
  }

  initIcons();

  /** 星级贴图：从 stars.png 里取第 i%3 颗星（9 参 drawImage 的源矩形裁剪）；dim=true 画成空星。
      贴图不可用返回 false → 调用方回退矢量星。 */
  function drawStar(g, img, i, cx, cy, size, dim) {
    if (!img) return false;
    var nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
    if (!(nw > 0) || !(nh > 0)) return false;
    var b = STAR_SUB[((i % 3) + 3) % 3];
    var sw = b.w * nw, sh = b.h * nh;
    var dh = size, dw = size * sw / sh;
    g.save();
    if (dim) g.globalAlpha = 0.26;
    g.drawImage(img, b.x * nw, b.y * nh, sw, sh, cx - dw / 2, cy - dh / 2, dw, dh);
    g.restore();
    return true;
  }
  /** 画一个 UI 贴图（等比塞进 size×size 方框，左上角在 x,y）；成功返回 true */
  function drawUiIcon(g, name, x, y, size) {
    var img = assetOf(UI_ICON, name);
    if (!img) return false;
    return drawAssetFit(g, img, { x:x, y:y, w:size, h:size }, null);
  }

  /** 贴图映射与加载状态（单测 / 无头断言直接读；不需要开局就能问）
      —— 这是「映射完整 + 回退可用」这两条验收的机器可读出口。 */
  /** 贴图映射与加载状态（单测 / 无头断言直接读；不需要开局就能问）
      —— 这是「映射完整 + 回退可用」这两条验收的机器可读出口。 */
  var art = {
    groups: function () {
      return ICON_GROUPS.map(function (g2) {
        return { key:g2.key, dir:g2.dir, ext:g2.ext, ids:g2.ids.slice(), base:g2.base,
                 loaded:g2.loaded, failed:g2.failed, ready:readyCount(g2) };
      });
    },
    group: function (key) {
      for (var i = 0; i < ICON_GROUPS.length; i++) if (ICON_GROUPS[i].key === key) return ICON_GROUPS[i];
      return null;
    },
    /** 背景（两级回退）：ready/id 是**当前生效**那张；slots 是全部候选与各自的加载状态 */
    bg: function () {
      var src = bgSource();
      /* 没有可用贴图时，报「首选素材 kitchen2」的几何常量（与 file/name 一致，便于断言）*/
      var meta = src ? src.meta : BG_META[BG_SLOTS[0].id];
      var slots = BG_SLOTS.map(function (s) {
        return { id:s.id, name:s.name, file:"art/bg/" + s.name, loaded:s.loaded, failed:s.failed,
                 ready:!!(s.img && (s.img.naturalWidth || 0) > 0 && s.img.complete !== false) };
      });
      return { dir:BG_IMG.dir, name: src ? src.slot.name : BG_SLOTS[0].name,
               file: BG_IMG.dir + (src ? src.slot.name : BG_SLOTS[0].name),
               active: src ? src.id : null, slot: src ? src.slot.id : null, slots: slots,
               fallback: ["kitchen2", "kitchen", "vector"],
               spec:{ w: meta.srcWindow.w, h: meta.srcWindow.h }, srcSpec: meta.srcSpec,
               crop: { x: meta.srcWindow.x, y: meta.srcWindow.y, w: meta.srcWindow.w, h: meta.srcWindow.h },
               srcWindow: meta.srcWindow, scale: meta.scale, strategy: meta.strategy,
               croppedPerSide: meta.croppedPerSide, croppedPercent: meta.croppedPercent,
               bottomFillPx: meta.bottomFillPx,
               counterTopSrcY: meta.counterTopSrcY, counterTopInCrop: meta.counterTopInCrop,
               counterTopCanvasY: counterTopCanvasY(), counterTopCanvasYTarget: BG_IMG.counterTopCanvasY,
               view:{ w:VIEW.w, h:VIEW.h }, ready:!!src, loaded:BG_IMG.loaded, failed:BG_IMG.failed };
    },
    bgDraw: function () { var img = bgIcon(); return img ? bgDrawArgs(img) : null; },
    /** 背景候选清单（断言「v2 优先、v1 兜底」用）*/
    bgSlots: function () { return BG_SLOTS.map(function (s) { return s.id + ":" + s.name; }); },
    gearOfKind: gearNameOfKind, plateTexOf: plateTexOfFood, plateTexHasFood: plateTexHasFood,
    plateTexIds: PLATE_TEX_IDS.slice(),
    faceOf: faceNameOf, faceOfIn: faceNameIn, faceUrgentAt: FACE_ICON.urgentAt,
    faceKinds: FACE_KINDS.slice(), faceMoods: FACE_MOODS.slice(), facePoolSeed: FACE_POOL_SEED,
    facePoolOf: facePoolOf, facePoolFor: facePoolFor, faceMoodOf: faceMoodOf,
    faceSatisfied: function (c) { return faceSatisfied(c); }, faceSatisfiedRule: FACE_SATISFIED_RULE,
    foodIds: FOOD_IDS.slice(), gearIds: GEAR_ICON.ids.slice(), faceIds: FACE_ICON.ids.slice(),
    uiIds: UI_ICON.ids.slice(), starSub: STAR_SUB,
    ready: function () {
      return { food:readyCount(FOOD_ICON), gear:readyCount(GEAR_ICON), face:readyCount(FACE_ICON),
               ui:readyCount(UI_ICON), bg:(bgIcon() ? 1 : 0) };
    },
    total: function () {
      var n = 1;
      for (var i = 0; i < ICON_GROUPS.length; i++) n += ICON_GROUPS[i].ids.length;
      return n;
    },
    /** 磁盘上真实存在的候选文件总数（背景是 2 张候选：kitchen2 + kitchen）*/
    totalFiles: function () {
      var n = BG_SLOTS.length;
      for (var i = 0; i < ICON_GROUPS.length; i++) n += ICON_GROUPS[i].ids.length;
      return n;
    }
  };


  var PAL = {
    ink:"#f6efe2", dim:"#b0a08c", gold:"#ffd76e", green:"#5dffa0", red:"#ff4d6d",
    steel:"#7c8296", steelHot:"#ffb347", card:"#2f1e2c", cardLine:"#6b4670", sakura:"#ff9ec7",
    wood:"#5a3a22", woodDark:"#2a1a12", plateRim:"#e8e2d6", panDark:"#191620"
  };
  var TIER_COLOR = { hot:"#ffd76e", warm:"#ffb347", cold:"#9aa3b8" };
  var TIER_NAME = { hot:"热乎", warm:"温", cold:"凉" };
  /* ── 列对齐布局（要求 A1）───────────────────────────────────────────────────
     一行 9 列，每列自上而下：列头小字 → 专属空盘 → 锅/煎盘/蒸格 → 食材桶，
     三者的 x 中心线完全相同（colCX），视觉上就是一竖列。
     竖直分区：顶栏 0..62 ｜ 顾客卡 68..278 ｜ 操作图例 284..312 ｜ 列头 318
               ｜ 专属盘 328..438 ｜ 锅 450..608 ｜ 食材桶 624..776                 */
  var COLW = 121, COLGAP = 8, COLSX0 = 13;
  var LAY = {
    topH: 62,
    cards: { x0:18, y:68, w:372, h:210, gap:14, n:3 },
    legend: { x:14, y:284, w:1152, h:28 },
    colHeaderY: 318,
    plate: { y:328, w:121, h:110 },
    stove: { x0:COLSX0, y:450, cols:9, panW:113, panH:158, plateW:121, plateH:110, cellGap:8, colGap:COLGAP, rowGap:0, colW:COLW },
    buckets: { x0:COLSX0, y:624, w:121, h:152, gap:COLGAP },
    platesLabelY: 312,          // 兼容旧字段（现在这一行画的是操作图例）
    bucketLabelDy: -14,
    /* 图例条左端的 🔊/🔇 小开关（可点）——那一行左侧本来就是空的（居中说明文字从 ~170px 才起），
       所以徽章塞在这里不会挤到任何既有元素 */
    soundBadge: { x:20, y:287, w:124, h:22 }
  };
  /** 第 i 列的左边界 / 中心线（列内三者共用同一条中心线）*/
  function colX(i) { return LAY.stove.x0 + i * (COLW + COLGAP); }
  function colCX(i) { return colX(i) + COLW / 2; }
  function stationCol(i) { return i; }
  function stationRow(i) { return 0; }
  function stationBox(i) {
    var w = LAY.stove.panW, h = LAY.stove.panH;
    return { x:colCX(i) - w / 2, y:LAY.stove.y, w:w, h:h };
  }
  /** 每个灶位的专属盘（一一对应：i 号灶位 ↔ i 号盘），在它的正上方 */
  function plateBox(i) {
    var w = LAY.plate.w, h = LAY.plate.h;
    return { x:colCX(i) - w / 2, y:LAY.plate.y, w:w, h:h };
  }
  /** 底部食材桶（在它那一列的最下面）*/
  function bucketBox(i) {
    var w = LAY.buckets.w, h = LAY.buckets.h;
    return { x:colCX(i) - w / 2, y:LAY.buckets.y, w:w, h:h };
  }
  function customerCardBox(i) { return { x:LAY.cards.x0 + i * (LAY.cards.w + LAY.cards.gap), y:LAY.cards.y, w:LAY.cards.w, h:LAY.cards.h }; }
  /** 声音开关徽章的命中框（绘制与点击共用同一个框）*/
  function soundBox() { return LAY.soundBadge; }

  function roundRect(g, x, y, w, h, r) {
    if (r > w / 2) r = w / 2; if (r > h / 2) r = h / 2;
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }
  function hit(x, y, b) { return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; }
  function prand(i) { var v = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v); }
  function fmtT(s) { s = Math.max(0, s); var m = Math.floor(s / 60), ss = Math.floor(s % 60); return m + ":" + (ss < 10 ? "0" : "") + ss; }
  function starPath(g, cx, cy, r) {
    g.beginPath();
    for (var i = 0; i < 10; i++) {
      var rr = (i % 2 === 0) ? r : r * 0.45, a = -Math.PI / 2 + i * Math.PI / 5;
      var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  }

  /* ── 食物绘制：优先贴图，缺图自动回退矢量 ─────────────────────────────────
     贴图路径：只在 drawFood 的局部坐标里画一个 span×span 的方框，因此自动继承
     既有的 FS.* 缩放与 translate —— 桶 / 卡 / 盘 / 煎盘 / 拖拽 五处尺寸与位置
     与改之前完全一致，点击热区与 9 列列对齐不受影响。
     火候表现：progress ring / 耐心条 / 金框脉动都画在 drawFood 之外，贴图不参与，
     所以「完美出锅」的视觉提示照旧。 */
  function drawFoodImg(g, id, s, cook) {
    var img = foodIcon(id);
    if (!img) return false;
    var nw = img.naturalWidth, nh = img.naturalHeight;
    var want = FOOD_ICON.span * (FOOD_ICON.scale > 0 ? FOOD_ICON.scale : 1);
    var k = want / Math.max(nw, nh);                 // 等比：最长边 = want
    var dw = nw * k, dh = nh * k;
    g.save(); g.scale(s, s);
    if (cook === "burnt") g.globalAlpha = 0.62;      // 糊了压暗（矢量画法用深色，贴图用半透明）
    g.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    g.restore();
    return true;
  }
  /* ── 食物矢量绘制：坐标原点在食物中心，s 为缩放 ──
     （贴图不可用时的回退，也是无头测试 / 老浏览器 / 缺素材时的唯一画法）*/
  function drawFoodVector(g, id, s, cook) {
    cook = cook || "raw";
    g.save(); g.scale(s, s);
    var burnt = cook === "burnt", raw = cook === "raw";
    switch (id) {
      case "egg": {
        g.fillStyle = burnt ? "#4a3624" : "#fffaf0";
        g.beginPath(); g.ellipse(0, 0, 19, 15, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = burnt ? "#5a3a12" : (raw ? "#ffd24a" : (cook === "perfect" ? "#ffb020" : "#c8791a"));
        g.beginPath(); g.ellipse(2, 0, 8.5, 7.5, 0, 0, Math.PI * 2); g.fill();
        if (!burnt) { g.fillStyle = "rgba(255,255,255,.6)"; g.beginPath(); g.ellipse(4.6, -2.4, 2.6, 2, 0, 0, Math.PI * 2); g.fill(); }
        if (burnt) { g.strokeStyle = "#140f08"; g.lineWidth = 1.4; g.beginPath(); g.moveTo(-9, -3); g.lineTo(2, 4); g.moveTo(-2, -7); g.lineTo(7, 2); g.stroke(); }
        break;
      }
      case "bacon": {
        var bc = burnt ? "#3a2418" : (raw ? "#e08a86" : "#c8563f");
        for (var r = 0; r < 3; r++) {
          g.fillStyle = bc; g.beginPath();
          g.moveTo(-16, -9 + r * 8);
          g.quadraticCurveTo(-4, -14 + r * 8, 16, -7 + r * 8);
          g.quadraticCurveTo(6, -3 + r * 8, -16, -5 + r * 8);
          g.closePath(); g.fill();
          if (!burnt) { g.fillStyle = "rgba(255,235,220,.5)"; g.fillRect(-14, -8 + r * 8, 26, 2.2); }
        }
        break;
      }
      case "sandwich": {
        g.fillStyle = burnt ? "#3a2a1a" : "#e6b877";
        g.beginPath(); g.moveTo(-17, -6); g.lineTo(17, -6); g.quadraticCurveTo(12, -18, 0, -17); g.quadraticCurveTo(-12, -18, -17, -6); g.fill();
        g.fillStyle = burnt ? "#241a10" : "#3f8f4a"; g.fillRect(-17, -5, 34, 4);
        g.fillStyle = burnt ? "#4a2a1a" : "#c0563f"; g.fillRect(-16, -1, 32, 5);
        g.fillStyle = burnt ? "#8a6a2a" : "#ffd76e";
        g.beginPath(); g.moveTo(-14, 4); g.lineTo(14, 4); g.lineTo(9, 9); g.lineTo(-9, 9); g.closePath(); g.fill();
        g.fillStyle = burnt ? "#33251a" : "#e6b877"; g.fillRect(-16, 9, 32, 7);
        break;
      }
      case "soup": {
        /* 清汤：浅色汤碗 + 清亮汤面 + 蛋花葱花（第 2 列「清汤锅」专属）*/
        g.fillStyle = "#f3f0ea";
        g.beginPath(); g.moveTo(-18, -8); g.lineTo(18, -8); g.lineTo(13, 12); g.lineTo(-13, 12); g.closePath(); g.fill();
        g.fillStyle = burnt ? "#5a4a2a" : "#e9cd92";
        g.beginPath(); g.ellipse(0, -8, 18, 5.5, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = "rgba(0,0,0,.14)"; g.beginPath(); g.ellipse(0, -8, 15, 4, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = burnt ? "#3a2a12" : (cook === "perfect" ? "#f8e0ad" : "#e9cd92");
        g.beginPath(); g.ellipse(0, -8, 14, 3.4, 0, 0, Math.PI * 2); g.fill();
        if (!burnt) {                                   // 蛋花 + 葱花
          g.fillStyle = "#fff8e0"; g.beginPath(); g.ellipse(6, -9, 3.6, 2.1, 0.3, 0, Math.PI * 2); g.fill();
          g.fillStyle = "#4fae57";
          g.beginPath(); g.arc(-6, -8, 1.7, 0, Math.PI * 2); g.fill();
          g.beginPath(); g.arc(2, -7, 1.3, 0, Math.PI * 2); g.fill();
        }
        if (cook === "perfect" || cook === "over") {     // 热气
          g.strokeStyle = "rgba(255,255,255,.42)"; g.lineWidth = 1.4;
          for (var sw = 0; sw < 2; sw++) { g.beginPath(); g.moveTo(-4 + sw * 9, -13); g.quadraticCurveTo(-7 + sw * 9, -19, -3 + sw * 9, -24); g.stroke(); }
        }
        if (burnt) { g.fillStyle = "rgba(20,14,8,.5)"; g.beginPath(); g.ellipse(0, -8, 12, 3, 0, 0, Math.PI * 2); g.fill(); }
        break;
      }
      case "congee": case "milk": {
        var bowl = id === "congee";
        g.fillStyle = "#f3f0ea";
        g.beginPath(); g.moveTo(-18, -8); g.lineTo(18, -8); g.lineTo(13, 12); g.lineTo(-13, 12); g.closePath(); g.fill();
        g.fillStyle = bowl ? (burnt ? "#6a5334" : "#f7f1e2") : (burnt ? "#8a7a6a" : "#fdfdff");
        g.beginPath(); g.ellipse(0, -8, 18, 5.5, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = "rgba(0,0,0,.16)"; g.beginPath(); g.ellipse(0, -8, 15, 4, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = bowl ? (cook === "perfect" ? "#f6e8c8" : "#efe4d0") : "#ffffff";
        g.beginPath(); g.ellipse(0, -8, 14, 3.4, 0, 0, Math.PI * 2); g.fill();
        if (cook === "perfect" || cook === "over") {
          g.strokeStyle = "rgba(255,255,255,.4)"; g.lineWidth = 1.4;
          for (var w = 0; w < 2; w++) { g.beginPath(); g.moveTo(-5 + w * 9, -13); g.quadraticCurveTo(-8 + w * 9, -19, -4 + w * 9, -24); g.stroke(); }
        }
        if (burnt) { g.fillStyle = "rgba(20,14,8,.55)"; g.beginPath(); g.ellipse(0, -8, 12, 3, 0, 0, Math.PI * 2); g.fill(); }
        break;
      }
      case "bun": {
        g.fillStyle = burnt ? "#3d2c1c" : "#f8f0e0";
        g.beginPath(); g.ellipse(0, 1, 15, 13, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = burnt ? "#241a10" : "rgba(180,150,110,.45)"; g.lineWidth = 1.2;
        for (var f = 0; f < 5; f++) {
          var a = -Math.PI / 2 + (f - 2) * 0.5;
          g.beginPath(); g.moveTo(0, -7); g.lineTo(Math.cos(a) * 12, Math.sin(a) * 6 + 6); g.stroke();
        }
        g.fillStyle = cook === "perfect" ? "#ffb347" : "rgba(0,0,0,.10)";
        g.beginPath(); g.ellipse(0, -9, 3, 1.6, 0, 0, Math.PI * 2); g.fill();
        break;
      }
      case "salad": {
        g.fillStyle = "#f3f0ea";
        g.beginPath(); g.moveTo(-17, -6); g.lineTo(17, -6); g.lineTo(12, 13); g.lineTo(-12, 13); g.closePath(); g.fill();
        g.fillStyle = burnt ? "#3f5230" : "#4fae57";
        g.beginPath(); g.ellipse(-6, -8, 8, 6, .3, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(6, -9, 7, 5.5, -.4, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(0, -5, 7, 5, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = burnt ? "#5a2020" : "#e2453f";
        g.beginPath(); g.arc(-4, -9, 2.6, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(7, -7, 2.4, 0, Math.PI * 2); g.fill();
        g.fillStyle = burnt ? "#8a7a3a" : "#ffd76e";
        g.beginPath(); g.arc(1, -12, 2.2, 0, Math.PI * 2); g.fill();
        break;
      }
      case "juice": {
        g.fillStyle = "rgba(255,255,255,.10)"; roundRect(g, -12, -14, 24, 28, 5); g.fill();
        g.fillStyle = burnt ? "#5a3a10" : "#ffb347"; roundRect(g, -10, -2, 20, 15, 3); g.fill();
        g.strokeStyle = "rgba(255,255,255,.5)"; g.lineWidth = 1.2; roundRect(g, -12, -14, 24, 28, 5); g.stroke();
        g.strokeStyle = "#ff7d9c"; g.lineWidth = 3; g.beginPath(); g.moveTo(4, -14); g.lineTo(10, -26); g.stroke();
        g.fillStyle = "#ffd76e"; g.beginPath(); g.arc(-2, 4, 1.8, 0, Math.PI * 2); g.fill();
        break;
      }
      default: { g.fillStyle = "#8a87a3"; g.beginPath(); g.arc(0, 0, 10, 0, Math.PI * 2); g.fill(); }
    }
    g.restore();
  }
  /** 食物绘制总入口：贴图优先，失败/未就绪 → 矢量回退（离线也能玩） */
  function drawFood(g, id, s, cook) {
    if (drawFoodImg(g, id, s, cook)) return;
    drawFoodVector(g, id, s, cook);
  }

  var RAF = root.requestAnimationFrame || function (cb) { return root.setTimeout(function () { cb(nowMs()); }, 16); };
  var CAF = root.cancelAnimationFrame || root.clearTimeout;

  /* ═══════════════ 4. 实例层（start / dispose / 交互 / 渲染循环） ═══════════════ */

  var inst = null;                                   // 同一时刻只允许一局
  /** 生命周期计数：供无头验收断言「dispose 后计时器 / 监听已清」 */
  var lifecycle = { escBound:0, escRemoved:0, rafCancelled:0, disposed:0 };
  var TARGETS = [
    { id:"fang", name:"芳姐",   role:"fang", f:"🏠" },
    { id:"su",   name:"苏晚晴", role:"su",   f:"🏃" },
    { id:"lin",  name:"林溪",   role:"lin",  f:"💼" },
    { id:"wen",  name:"温阮",   role:"wen",  f:"📖" },
    { id:"lei",  name:"雷姐",   role:"lei",  f:"🥊" },
    { id:"hong", name:"红姐",   role:"hong", f:"🍷" },
    { id:"guo",  name:"陈果",   role:"guo",  f:"🎒" },
    { id:"lu",   name:"白露",   role:"lu",   f:"🤍" },
    { id:"man",  name:"顾曼",   role:"man",  f:"👑" }
  ];
  var TARGET_IDS = [];
  (function () { for (var i = 0; i < TARGETS.length; i++) TARGET_IDS.push(TARGETS[i].id); })();

  function el(tag, cls, html) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function mkBtn(text, cls) {
    var b = doc.createElement("button");
    b.type = "button"; b.className = "bf-btn" + (cls ? " " + cls : "");
    b.textContent = text;
    return b;
  }
  /** 结算面板 / 提示处的 UI 贴图（DOM）：图片加载失败 → 自动摘掉 img，保留后面的 emoji 兜底文案 */
  function uiIconTag(name, emoji) {
    var src = groupBase(UI_ICON) + name + UI_ICON.ext;
    return '<img class="bf-uiico" src="' + src + '" alt=""' +
           ' onload="this.style.display=\u0027inline-block\u0027;this.nextSibling.style.display=\u0027none\u0027;"' +
           ' onerror="this.remove()"><span class="bf-emj">' + emoji + '</span>';
  }
  function escHtml(s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function start(hostEl, opts) {
    if (!hostEl || !doc) return false;
    if (inst) return false;                          // 已有局在跑
    opts = opts || {};
    var cfg = {
      duration: opts.duration > 0 ? opts.duration : 75,
      goal: opts.goal > 0 ? opts.goal : 8,
      target: opts.target || null,
      autoPlate: opts.autoPlate !== false,           // 页面默认打开「做好自动落入专属盘」
      onFinish: (typeof opts.onFinish === "function") ? opts.onFinish : null
    };
    var st = newState(cfg);
    st.cfg.autoPlate = cfg.autoPlate;                // 9 列都是「熟了自动落到本列专属盘」

    hostEl.innerHTML = "";
    hostEl.classList.add("bf-on");
    var wrap = el("div", "bf-wrap");
    var bar = el("div", "bf-bar");
    bar.appendChild(el("div", "bf-title", "🍳 早餐店 · 拼手速" + (cfg.target ? ("　→ " + cfg.target.name) : "")));
    bar.appendChild(el("div", "bf-tip",
      "① 点食材 → 自动进它正上方那一列的锅 ｜ ② 点上方专属盘 → 自动送给正在等的顾客（优先最急的） ｜ " +
      "③ 双击盘 → 丢垃圾桶（不扣分）· 盘上停留超过 " + SERVE_WINDOW.toFixed(1) + "s 会糊，糊了只能双击丢掉"));
    /* 声音开关：早餐店此前没有任何静音 / 音量设置 → 按用户要求用 localStorage.bfSoundOn（默认开），
       这里给一个真实按钮（与「收 摊」同款木牌样式，风格一致）；图例条左端的徽章是同一个开关的第二入口。 */
    var btnSound = mkBtn(soundLabel(), "bf-wood");
    btnSound.id = "bfSound";
    btnSound.setAttribute("data-act", "sound");
    btnSound.title = "音效开关（记在 localStorage.bfSoundOn）";
    bar.appendChild(btnSound);
    var btnEnd = mkBtn("收 摊", "bf-wood");
    bar.appendChild(btnEnd);
    var stage = el("div", "bf-stage");
    var cv = doc.createElement("canvas");
    cv.className = "bf-cv";
    stage.appendChild(cv);
    var panel = el("div", "bf-result");
    panel.style.display = "none";
    wrap.appendChild(bar); wrap.appendChild(stage); wrap.appendChild(panel);
    hostEl.appendChild(wrap);

    var dpr = Math.max(1, Math.min(2.5, root.devicePixelRatio || 1));
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = "100%"; cv.style.height = "auto"; cv.style.display = "block";
    var g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    var IA = {
      st:st, host:hostEl, wrap:wrap, cv:cv, g:g, panel:panel, btnEnd:btnEnd, btnSound:btnSound,
      dpr:dpr, raf:0, last:nowMs(), acc:0, drag:null, hover:-1, hoverBucket:-1, finished:false,
      drawn:{ plates:0, pans:0, cards:0, buckets:0, foods:0 }
    };
    inst = IA;

    /* ── 坐标换算（不依赖任何页面 CSS 变量） ── */
    function toLocal(evt) {
      var r = cv.getBoundingClientRect();
      var t = (evt.touches && evt.touches[0]) ? evt.touches[0] : ((evt.changedTouches && evt.changedTouches[0]) ? evt.changedTouches[0] : evt);
      var sx = r.width / W, sy = r.height / H;
      return { x:(t.clientX - r.left) / (sx || 1), y:(t.clientY - r.top) / (sy || 1) };
    }
    function stationAt(x, y) {
      for (var i = 0; i < st.stations.length; i++) if (hit(x, y, stationBox(i))) return i;
      return -1;
    }
    function bucketAt(x, y) {
      for (var i = 0; i < FOOD_IDS.length; i++) if (hit(x, y, bucketBox(i))) return i;
      return -1;
    }
    /** 点到某个盘 → 返回它唯一的归属灶位下标（盘与灶位一一对应）*/
    function plateAt(x, y) {
      for (var i = 0; i < st.stations.length; i++) if (hit(x, y, plateBox(i))) return i;
      return -1;
    }
    function customerAt(x, y) {
      var list = activeCustomers(st);
      for (var i = 0; i < list.length && i < LAY.cards.n; i++)
        if (hit(x, y, customerCardBox(i))) return st.customers.indexOf(list[i]);
      return -1;
    }
    function flash(msg, color) {
      var f = addFloat(st, msg, color || PAL.red, 24);
      f.center = true;
    }
    /* ── 双击判定（要求 A4：点两下 = 扔进垃圾桶）──
       同一个目标（盘 / 锅）在 DOUBLE_MS 内被点第二下即算双击。 */
    var lastTap = { key:"", t:0 };
    function isDouble(kind, idx) {
      var k = kind + ":" + idx, t = nowMs();
      if (lastTap.key === k && (t - lastTap.t) <= DOUBLE_MS) { lastTap = { key:"", t:0 }; return true; }
      lastTap = { key:k, t:t };
      return false;
    }
    function resetDouble() { lastTap = { key:"", t:0 }; }
    /** 提示色：能补救的（盘占着 / 还没熟 / 没人要）用暖色，硬错误用红色 */
    function whyColor(why) { return (why === "plate-occupied" || why === "no-want" || why === "station-occupied") ? PAL.steelHot : PAL.red; }

    /** 点锅（这一列的灶位）：锅里那份是什么状态就给什么提示；
        已经在盘上的（自动落盘后）点锅 = 提示去点上方的盘；
        锅内若有做好的（manual 模式）→ 手动落到本列盘上。 */
    function actStation(i) {
      var s = st.stations[i];
      if (!s) return;
      var p = plateOfStation(st, i);
      var label = colNameOf(i);
      if (!s.food) {
        if (p) flash(label + " 的盘里还有一份 —— 先点它送出去（双击丢垃圾桶）", PAL.steelHot);
        else flash(label + " 空着 —— 点下面它那一列的食材下锅", PAL.dim);
        return;
      }
      if (s.state === "burnt") { flash("糊了，只能丢掉（双击这一列）", PAL.red); return; }
      if (s.state === "raw") { flash("锅里还在做 —— " + (FOOD[s.food] || {}).n + " 要 " + FOOD[s.food].dur.toFixed(1) + "s"); return; }
      /* 锅里做好的（autoPlate 关掉时的调试手感）：点一下 = 落到本列专属盘 */
      if (takePlate(st, i)) {
        var pp = plateOfStation(st, i);
        if (pp) { st.selected = { kind:"plate", idx:i }; flash("熟了 · 落到" + plateNameOf(i) + " —— 点盘送出去", PAL.green); }
        return;
      }
      if (p) flash(label + " 的盘里还有一份，先送出去", PAL.steelHot);
    }
    /** 单击盘（要求 A3）：自动送给正在需要这份、且耐心最少的顾客；
        没人要 → 不消耗，留在盘上继续走热乎度衰减；糊了 → 只能双击丢。 */
    function actPlate(si) {
      var r = serveFromColumn(st, si);
      if (r.ok) {
        if (r.kind === "wrong") { flash("上错菜了！", PAL.red); return; }
        if (r.kind === "burnt") { flash("糊的东西端上桌 —— 顾客走了", PAL.red); return; }
        st.selected = { kind:"customer", idx:(r.customer ? r.customer.id : -1) };
        flash("出餐！+" + r.delta + " " + TIER_NAME[r.heat || "hot"], PAL.green);
        return;
      }
      if (r.why === "burnt") { flash(r.hint || "糊了，只能丢掉", PAL.red); return; }
      flash(r.hint || "送不出去", whyColor(r.why));
    }
    function actCustomer(ci) {
      if (ci < 0) return;
      var r = serveCustomer(st, ci, null);
      if (!r.ok && r.why === "no-plate") flash("盘里还没有做好的 —— 先点食材下锅");
      else if (r.ok && r.kind === "wrong") flash("上错菜了！" + (FOOD[r.food] ? FOOD[r.food].n : "") + " 不是他要的");
      else if (r.ok && r.kind === "burnt") flash("糊的东西端上桌 —— 顾客走了");
    }
    function onDown(evt) {
      if (st.over || !doc) return;
      var p = toLocal(evt);
      /* ⓪ 图例条左端的 🔊/🔇 徽章：切换音效开关（与顶栏按钮同一个开关）*/
      if (hit(p.x, p.y, soundBox())) { resetDouble(); toggleSound(); return; }
      /* ① 底部食材桶：单击 = 自动进它自己那一列的锅（也可以拖，见 onUp） */
      var bi = bucketAt(p.x, p.y);
      if (bi >= 0) {
        resetDouble();
        var r0 = placeFoodEx(st, FOOD_IDS[bi], null, null);
        if (!r0.ok) flash((FOOD[FOOD_IDS[bi]] || {}).n + "：" + (r0.hint || "放不下"), whyColor(r0.why));
        IA.drag = { food:FOOD_IDS[bi], x:p.x, y:p.y, moved:false };
        IA.hoverBucket = bi;
        render(); return;
      }
      /* ② 中列的锅：双击 = 丢垃圾桶；单击 = 状态提示 / 手动落盘 */
      var si = stationAt(p.x, p.y);
      if (si >= 0) {
        if (isDouble("station", si)) { trashColumn(st, si); flash("丢进垃圾桶（不扣分）", PAL.steelHot); }
        else actStation(si);
        render(); return;
      }
      /* ③ 上列的专属盘：双击 = 丢垃圾桶；单击 = 送给顾客 */
      var pi = plateAt(p.x, p.y);
      if (pi >= 0) {
        if (isDouble("plate", pi)) { trashColumn(st, pi); flash("丢进垃圾桶（不扣分）", PAL.steelHot); }
        else actPlate(pi);
        render(); return;
      }
      /* ④ 顾客卡：点一下 = 用最合适的一盘直接上菜（保留的旧操作） */
      var ci = customerAt(p.x, p.y);
      if (ci >= 0) { resetDouble(); actCustomer(ci); render(); return; }
    }
    function onMove(evt) {
      var p = toLocal(evt);
      IA.hover = stationAt(p.x, p.y);
      IA.hoverBucket = bucketAt(p.x, p.y);
      if (IA.drag) { IA.drag.moved = true; IA.drag.x = p.x; IA.drag.y = p.y; render(); }
    }
    function onUp(evt) {
      if (!IA.drag) return;
      var p = toLocal(evt), d = IA.drag; IA.drag = null;
      if (!d.moved) { render(); return; }                 // 单击已经在 onDown 里下过料了
      /* 拖拽（保留的兼容操作）：只认它自己那一列的锅，拖到别人的锅会被拒（wrong-column） */
      var si = stationAt(p.x, p.y);
      if (si < 0 && p.y > LAY.stove.y - 60 && p.y < LAY.buckets.y) {   // 拖到锅区但没压准 → 就近吸附
        var near = -1, best = 1e9;
        for (var k = 0; k < st.stations.length; k++) {
          var b = stationBox(k), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
          var dd = (cx - p.x) * (cx - p.x) + (cy - p.y) * (cy - p.y);
          if (dd < best) { best = dd; near = k; }
        }
        if (best < 90 * 90) si = near;
      }
      if (si >= 0) {
        var r = placeFoodEx(st, d.food, si, null);
        if (!r.ok) flash((FOOD[d.food] || {}).n + "：" + (r.hint || "放不下"), whyColor(r.why));
      }
      render();
    }
    function onLeave() { IA.drag = null; IA.hover = -1; IA.hoverBucket = -1; render(); }
    function onCtx(evt) {                                  // 右键 = 丢垃圾桶（与双击同义，保留的手感）
      var p = toLocal(evt), si = stationAt(p.x, p.y);
      if (si < 0) si = plateAt(p.x, p.y);
      if (si >= 0 && (st.stations[si].food || plateOfStation(st, si))) {
        evt.preventDefault(); trashColumn(st, si); render();
      }
    }

    cv.addEventListener("mousedown", onDown);
    cv.addEventListener("mousemove", onMove);
    root.addEventListener("mouseup", onUp);
    cv.addEventListener("mouseleave", onLeave);
    cv.addEventListener("contextmenu", onCtx);
    cv.addEventListener("touchstart", function (e) { onDown(e); e.preventDefault(); }, { passive:false });
    cv.addEventListener("touchmove", function (e) { onMove(e); e.preventDefault(); }, { passive:false });
    cv.addEventListener("touchend", function (e) { onUp(e); e.preventDefault(); }, { passive:false });
    /* ── ESC = 点「出口按钮」（只在结算面板已经出现时接管，不抢对局中的 ESC）──
       语义与点击 #bfGo 完全一致：退出但不丢结算结果，且只会交一次 onFinish。 */
    function onEsc(e) {
      if (!e) return;
      var k = e.key || e.code || "";
      if (!(k === "Escape" || k === "Esc" || e.keyCode === 27)) return;
      if (panel.style.display === "none") return;      // 还没结算 → 不接管
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      close(true);
    }
    if (doc && doc.addEventListener) { doc.addEventListener("keydown", onEsc); IA.escOn = true; lifecycle.escBound++; }
    IA.detach = function () {
      cv.removeEventListener("mousedown", onDown);
      cv.removeEventListener("mousemove", onMove);
      root.removeEventListener("mouseup", onUp);
      cv.removeEventListener("mouseleave", onLeave);
      cv.removeEventListener("contextmenu", onCtx);
      if (IA.escOn && doc && doc.removeEventListener) { doc.removeEventListener("keydown", onEsc); lifecycle.escRemoved++; }
      IA.escOn = false;
    };
    btnSound.addEventListener("click", function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      toggleSound();
    });
    btnEnd.addEventListener("click", function () { finishNow("主动收摊"); });

    /* ── 渲染（Canvas 只画食物 / 锅具 / 盘子 / 卡片底与进度环，文字全部用真系统字体）── */
    function fontOf(px, bold) { return (bold ? "bold " : "") + px + "px system-ui,'Segoe UI','Microsoft YaHei',sans-serif"; }

    /* 背景：最底层先铺 art/bg/kitchen2.png（**两级回退**：kitchen2 → kitchen → 程序化底）。
       v2 是「整幅宽铺满」（左右 0 裁切，完整樱花树冠 + 完整货架都在画面里），
       木台面上沿落在画布 y≈406；画布底部比素材多出来的那 126px 用
       「台面木纹纵向平铺 + 向底端线性压深 40%」补齐（木纹横向连续 → 看不出接缝）。
       铺完再叠两层「可读性压暗」；两张贴图都加载失败 → 回退原来的程序化木台 / 樱瓣 / 暖光底。 */
    function drawBg() {
      var src = bgSource();
      var bimg = src ? src.img : null, bargs = bimg ? bgDrawArgs(bimg) : null;
      IA.drawn.bg = !!bargs;
      IA.drawn.bgMode = bargs ? bargs.mode : "vector";
      IA.drawn.bgSlot = src ? src.id : "vector";
      IA.drawn.bgBand = 0;
      if (bargs) {
        var nwB = bimg.naturalWidth || 0, nhB = bimg.naturalHeight || 0;
        var nwS = bargs.sw, nhS = bargs.sh;
        /* 先整幅铺满（fit / cover 由 bgDrawArgs 定），再补底部木纹带 */
        g.drawImage(bimg, bargs.sx, bargs.sy, nwS, nhS, bargs.dx, bargs.dy, bargs.dw, bargs.dh);
        IA.drawn.bgW = nwS; IA.drawn.bgH = nhS;
        var bandY = VIEW.h, meta = src ? src.meta : null;
        if (meta && meta.counterTopSrcY > 0 && nhS > 0) {
          /* 素材底边画到画布哪一行（cover 裁切时算上 sy 偏置） */
          bandY = Math.max(0, Math.min(VIEW.h, (nhS - bargs.sy) * VIEW.h / nhS));
        }
        var bandH = VIEW.h - bandY;
        if (bandH > 0.5 && meta && nhB > 0) {                      // 需要补带
          var mTop = meta.counterTopSrcY, sy0 = bargs.sy + mTop;   // 木台面木纹条的起始源行
          var rowH = Math.max(1, nhB - mTop);
          var gh = Math.max(1, Math.round(rowH * VIEW.w / nwB));   // 平铺一格在画布上的高度
          g.save();
          g.beginPath(); g.rect(0, bandY, VIEW.w, bandH); g.clip();
          for (var by = bandY; by < VIEW.h + 1; by += gh) {
            var hh = Math.min(gh, VIEW.h - by);
            if (hh <= 0) break;
            g.drawImage(bimg, bargs.sx, sy0, nwB - bargs.sx, rowH, 0, by, VIEW.w, hh);
          }
          /* 向画面底端线性压深（台面往前伸出画面的暗部） */
          var dg = g.createLinearGradient(0, bandY, 0, VIEW.h);
          dg.addColorStop(0, "rgba(8,5,3,0)");
          dg.addColorStop(1, "rgba(8,5,3," + BG_IMG.bottomFillDark + ")");
          g.fillStyle = dg; g.fillRect(0, bandY, VIEW.w, bandH);
          g.restore();
          IA.drawn.bgBand = Math.round(bandH);
        }
        g.fillStyle = "rgba(12,7,4," + BG_IMG.scrimAll + ")"; g.fillRect(0, 0, W, H);
        var sgr = g.createLinearGradient(0, LAY.topH, 0, LAY.legend.y + LAY.legend.h);
        sgr.addColorStop(0, "rgba(12,7,4," + BG_IMG.scrimTop + ")"); sgr.addColorStop(1, "rgba(12,7,4,0)");
        g.fillStyle = sgr; g.fillRect(0, LAY.topH, W, LAY.legend.y + LAY.legend.h - LAY.topH);
      } else {
        var lg = g.createLinearGradient(0, 0, 0, H);
        lg.addColorStop(0, "#4d301c"); lg.addColorStop(0.5, "#33200f"); lg.addColorStop(1, "#1d120a");
        g.fillStyle = lg; g.fillRect(0, 0, W, H);
        /* 暖木台面木纹 */
        for (var w = 0; w < 28; w++) {
          var y = 70 + w * 26;
          g.strokeStyle = "rgba(255,205,150," + (0.018 + prand(w) * 0.032).toFixed(3) + ")";
          g.lineWidth = 1 + prand(w + 3) * 2;
          g.beginPath(); g.moveTo(0, y);
          for (var x = 0; x <= W; x += 60) g.lineTo(x, y + Math.sin((x + w * 40) / 170) * 3.2);
          g.stroke();
        }
        /* 淡粉樱瓣（低饱和，不抢戏）*/
        for (var i = 0; i < 44; i++) {
          var px = prand(i) * W, py = prand(i + 90) * H, r = 3 + prand(i + 7) * 4;
          g.fillStyle = "rgba(255,170,200," + (0.04 + prand(i + 3) * 0.05).toFixed(3) + ")";
          g.beginPath(); g.ellipse(px, py, r, r * 0.6, prand(i + 5) * 3, 0, Math.PI * 2); g.fill();
        }
        g.fillStyle = "rgba(12,7,4,.34)"; g.fillRect(0, LAY.topH, W, LAY.buckets.y - LAY.topH);
      }
      var rg = g.createRadialGradient(W / 2, 470, 60, W / 2, 470, 640);
      rg.addColorStop(0, "rgba(255,170,80,.20)"); rg.addColorStop(1, "rgba(255,170,80,0)");
      g.fillStyle = rg; g.fillRect(0, LAY.topH, W, H - LAY.topH);
    }



    function drawTopBar() {
      g.fillStyle = "rgba(14,9,14,.90)"; g.fillRect(0, 0, W, LAY.topH);
      g.fillStyle = "rgba(255,214,110,.28)"; g.fillRect(0, LAY.topH - 2, W, 2);
      g.textBaseline = "middle"; g.textAlign = "left";
      var left = Math.max(0, st.cfg.duration - st.elapsed);
      var urgent = left <= 10;
      /* 倒计时：大号；剩 10 秒变红闪烁 */
      g.font = fontOf(FONT.clock, true);
      g.fillStyle = urgent ? (Math.floor(nowMs() / 300) % 2 ? "#ffffff" : PAL.red) : PAL.gold;
      g.fillText("⏱ " + fmtT(left), 18, 24);
      /* 服务进度 x / 8 */
      g.font = fontOf(FONT.num, true); g.fillStyle = PAL.ink;
      g.fillText("顾客 " + st.served + " / " + st.cfg.goal, 176, 24);
      var pbX = 350, pbW = 180;
      g.fillStyle = "rgba(255,255,255,.14)"; roundRect(g, pbX, 16, pbW, 16, 8); g.fill();
      g.fillStyle = st.served >= st.cfg.goal ? PAL.green : PAL.gold;
      roundRect(g, pbX, 16, Math.max(4, pbW * Math.min(1, st.served / st.cfg.goal)), 16, 8); g.fill();
      /* 星级：按完美率 —— 用 art/icons/ui/stars.png 里的单颗星（9 参 drawImage 取源矩形）*/
      var rate = st.served > 0 ? st.perfect / st.served : (st.perfect > 0 ? 1 : 0);
      var stars = Math.max(0, Math.min(5, Math.round(rate * 5)));
      var starImg = assetOf(UI_ICON, "stars");
      for (var i = 0; i < 5; i++) {
        var sx0 = pbX + pbW + 30 + i * 30;
        if (starImg && drawStar(g, starImg, i, sx0, 24, 24, i >= stars)) { IA.drawn.uiStars = (IA.drawn.uiStars || 0) + 1; }
        else {
          starPath(g, sx0, 24, 12);
          g.fillStyle = i < stars ? PAL.gold : "rgba(255,255,255,.13)"; g.fill();
        }
      }
      /* 得分：金币贴图（缺图 → 回退原来的金星）*/
      var coinImg = assetOf(UI_ICON, "coin");
      if (coinImg) { IA.drawn.uiCoin = (IA.drawn.uiCoin || 0) + 1; drawAssetFit(g, coinImg, { x: pbX + pbW + 201, y: 10, w: 28, h: 28 }, null); }
      else { starPath(g, pbX + pbW + 214, 24, 13); g.fillStyle = PAL.gold; g.fill(); }
      g.font = fontOf(FONT.score, true); g.fillStyle = PAL.ink;
      g.fillText(String(st.score), pbX + pbW + 234, 24);

      /* 第二行：明细 + 赠送对象 */
      g.font = fontOf(FONT.tiny, false); g.fillStyle = PAL.dim;
      g.fillText("完美 " + st.perfect + " · 温 " + (st.heat.warm || 0) + " · 凉 " + (st.heat.cold || 0) +
                 " · 糊 " + st.burnt + "（忘取 " + (st.expire || 0) + "）· 跑单 " + st.angry + " · 上错 " + st.wrong +
                 " · 盘上 " + st.plates.length + "/" + PLATES_TOTAL + " · 过火计时 " + SERVE_WINDOW.toFixed(1) + "s", 18, 50);
      if (st.cfg.target) {
        g.textAlign = "right"; g.fillStyle = PAL.sakura; g.font = fontOf(16, true);
        g.fillText("这份早餐 → " + st.cfg.target.name + "（好感 " + st.cfg.target.bond + "）", W - 18, 50);
        g.textAlign = "left";
      }
    }

    /* 顾客头像：程序化（发型 + 肤色 + 衣着色块）*/
    function drawAvatar(g, cx, cy, r, seed) {
      var s0 = Math.abs(Math.round(Number(seed) || 0));
      var skin = ["#f3d3b6", "#e8c1a0", "#dcb08c", "#f6dcc4"][s0 % 4];
      var hair = ["#2b2118", "#4a2f22", "#1d1a24", "#5a3a2a", "#6b4a2e"][(s0 + 1) % 5];
      var cloth = ["#c9556e", "#4d7ec9", "#6aa06a", "#c9a04d", "#8a5fc0", "#3f8f9a"][(s0 + 2) % 6];
      g.fillStyle = "rgba(0,0,0,.30)"; g.beginPath(); g.ellipse(cx, cy + r * 0.25, r * 1.02, r * 1.02, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = cloth; g.beginPath(); g.ellipse(cx, cy + r * 1.25, r * 0.98, r * 0.70, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = skin; g.fillRect(cx - r * 0.22, cy + r * 0.42, r * 0.44, r * 0.55);
      g.fillStyle = skin; g.beginPath(); g.arc(cx, cy, r * 0.70, 0, Math.PI * 2); g.fill();
      g.fillStyle = hair; g.beginPath(); g.arc(cx, cy - r * 0.14, r * 0.74, Math.PI * 1.00, Math.PI * 2.00); g.fill();
      if (s0 % 2 === 0) {
        g.beginPath(); g.ellipse(cx - r * 0.62, cy + r * 0.16, r * 0.20, r * 0.56, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(cx + r * 0.62, cy + r * 0.16, r * 0.20, r * 0.56, 0, 0, Math.PI * 2); g.fill();
      }
      g.fillStyle = "#2a2028";
      g.beginPath(); g.arc(cx - r * 0.24, cy + r * 0.02, r * 0.075, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(cx + r * 0.24, cy + r * 0.02, r * 0.075, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "rgba(0,0,0,.28)"; g.lineWidth = 2;
      g.beginPath(); g.arc(cx, cy, r * 0.70, 0, Math.PI * 2); g.stroke();
    }

    /** 顾客头像贴图（三态）：订单全部拿到（正在离场满意）→ happy；耐心 > 40% → calm；
        ≤ 40% → urgent。角色从**本局角色池**里按顾客编号取（5 位：学生/白领/大爷/女房东/护士）。
        15 张（5 角色 × 3 情绪）本轮已切齐；万一某张缺图 / 没解码完 → 先退回平静脸，
        再不行才回退矢量头像 —— 语义不变，离线也能玩。                              */
    function drawCustomerFace(box, c) {
      var st0 = curState();
      var n = Math.max(0, c.patience) / Math.max(0.01, c.patienceMax);
      var happy = faceSatisfied(c);
      var mood = faceMoodOf(c.id, n, happy);
      var name = faceNameIn(st0, c.id, n, happy);
      var img = assetOf(FACE_ICON, name);
      if (!img && mood === "happy") {                    // 缺「满意」贴图 → 退回平静脸（比回退矢量更自然）
        name = faceNameIn(st0, c.id, n, false);
        img = assetOf(FACE_ICON, name);
        IA.drawn.faceHappyFallback = (IA.drawn.faceHappyFallback || 0) + 1;
      }
      if (img && drawAssetFit(g, img, { x: box.x + 10, y: box.y + 22, w: 64, h: 68 }, null)) {
        IA.drawn.faces = (IA.drawn.faces || 0) + 1;
        IA.drawn.faceMood = mood;
        IA.drawn.faceName = name;
        IA.drawn.faceHappy = happy;
        return true;
      }
      IA.drawn.faceMood = "vector";
      IA.drawn.faceName = "";
      IA.drawn.faceMoodWanted = mood;
      drawAvatar(g, box.x + 38, box.y + 58, 21, c.id);
      return false;
    }


    function drawCustomer(c, box, slot) {

      var warn = Math.max(0, c.patience) / Math.max(0.01, c.patienceMax);
      var low = warn < 0.3;
      var flashOn = low && (Math.floor(nowMs() / 260) % 2 === 0);
      var cg = g.createLinearGradient(0, box.y, 0, box.y + box.h);
      cg.addColorStop(0, "#3d2537"); cg.addColorStop(1, "#20131f");
      g.fillStyle = cg; roundRect(g, box.x, box.y, box.w, box.h, 14); g.fill();
      /* 顶部条（粉色氛围）+ 边框 */
      g.fillStyle = "rgba(255,158,199,.10)"; roundRect(g, box.x, box.y, box.w, 30, 14); g.fill();
      g.strokeStyle = c.angry ? PAL.red : (flashOn ? PAL.red : (low ? PAL.steelHot : PAL.cardLine));
      g.lineWidth = (c.angry || flashOn) ? 4 : 2;
      roundRect(g, box.x, box.y, box.w, box.h, 14); g.stroke();
      /* 头像 + 编号 */
      drawCustomerFace(box, c);
      g.textAlign = "left"; g.textBaseline = "middle";
      g.font = fontOf(FONT.cardNo, true); g.fillStyle = PAL.ink;
      g.fillText("顾客 #" + c.id, box.x + 68, box.y + 44);
      g.font = fontOf(FONT.small, false); g.fillStyle = PAL.dim;
      g.fillText(c.order.length + " 样早餐 · 还差 " + remainOf(c) + " 样", box.x + 68, box.y + 68);
      /* 订单食物图标 + 完成打勾 */
      var n = Math.max(1, c.order.length), iw = Math.min(96, (box.w - 40) / n);
      var x0 = box.x + 20 + Math.max(0, (box.w - 40 - n * iw) / 2);
      var iconY = box.y + 118;
      for (var i = 0; i < c.order.length; i++) {
        var fid = c.order[i], got = c.done.indexOf(fid) >= 0;
        var cx = x0 + i * iw + iw / 2;
        g.fillStyle = got ? "rgba(93,255,160,.14)" : "rgba(255,255,255,.06)";
        roundRect(g, cx - 34, iconY - 34, 68, 68, 12); g.fill();
        g.strokeStyle = got ? PAL.green : "rgba(255,255,255,.14)"; g.lineWidth = got ? 3 : 1.5;
        roundRect(g, cx - 34, iconY - 34, 68, 68, 12); g.stroke();
        g.globalAlpha = got ? 0.45 : 1;
        g.save(); g.translate(cx, iconY + 3); drawFood(g, fid, FS.card, "perfect"); g.restore();
        g.globalAlpha = 1;
        g.font = fontOf(FONT.small, true); g.fillStyle = got ? PAL.green : PAL.ink; g.textAlign = "center";
        g.fillText((FOOD[fid] || {}).n, cx, iconY + 50);
        if (got) {
          if (drawUiIcon(g, "check", cx + 8, iconY - 40, 34)) IA.drawn.uiCheck = (IA.drawn.uiCheck || 0) + 1;
          else {
            g.strokeStyle = PAL.green; g.lineWidth = 5; g.beginPath();
            g.moveTo(cx + 14, iconY - 22); g.lineTo(cx + 23, iconY - 12); g.lineTo(cx + 38, iconY - 34); g.stroke();
          }
        }
      }
      g.textAlign = "left";
      /* 耐心：大号数字 + 粗条（快走时变红闪烁）*/
      var by = box.y + box.h - 30, bw = box.w - 32 - 96, bx = box.x + 16;
      var col = warn > 0.6 ? PAL.green : (warn > 0.3 ? PAL.steelHot : PAL.red);
      var ratio = Math.max(0, Math.min(1, warn));
      var barB = assetOf(UI_ICON, "bar_empty"), barF = assetOf(UI_ICON, "bar_full");
      if (barB) {
        /* 底槽 = bar_empty 整条铺满；前景 = bar_full **按剩余比例裁源矩形**（不是把整条压扁）*/
        g.drawImage(barB, bx, by, bw, 22);
        IA.drawn.uiBar = (IA.drawn.uiBar || 0) + 1;
        if (barF && ratio > 0.004) {
          var nwF = barF.naturalWidth || 0, nhF = barF.naturalHeight || 0;
          g.drawImage(barF, 0, 0, nwF * ratio, nhF, bx, by, Math.max(3, bw * ratio), 22);
          IA.drawn.uiBarFill = (IA.drawn.uiBarFill || 0) + 1;
        }
        /* 旧矢量条的三档配色（绿/橙/红）与「快走闪白」两个语义，用半透明色块压在贴图上保留 */
        if (warn <= 0.6) {
          g.fillStyle = warn <= 0.3 ? "rgba(255,77,109,.34)" : "rgba(255,179,71,.26)";
          roundRect(g, bx, by, Math.max(3, bw * ratio), 22, 11); g.fill();
        }
        if (flashOn) { g.fillStyle = "rgba(255,255,255,.55)"; roundRect(g, bx, by, Math.max(3, bw * ratio), 22, 11); g.fill(); }
      } else {
        g.fillStyle = "rgba(0,0,0,.45)"; roundRect(g, bx, by, bw, 22, 11); g.fill();
        g.fillStyle = flashOn ? "#ffffff" : col;
        roundRect(g, bx, by, Math.max(4, bw * ratio), 22, 11); g.fill();
      }

      g.font = fontOf(FONT.patience, true);
      g.fillStyle = flashOn ? "#ffffff" : col; g.textAlign = "right";
      g.fillText(Math.max(0, c.patience).toFixed(1) + "s", box.x + box.w - 16, by + 11);
      g.textAlign = "left";
      if (c.angry) { g.fillStyle = "rgba(255,77,109,.18)"; roundRect(g, box.x, box.y, box.w, box.h, 14); g.fill(); }
      if (got2(c)) {
        if (drawUiIcon(g, "check", box.x + box.w - 58, box.y + 8, 36)) IA.drawn.uiCheck = (IA.drawn.uiCheck || 0) + 1;
        else { g.font = fontOf(40, true); g.fillStyle = "rgba(93,255,160,.9)"; g.textAlign = "center"; g.fillText("✓", box.x + box.w - 40, box.y + 26); g.textAlign = "left"; }
      }
    }
    function got2(c) { return c.order.length > 0 && remainOf(c) <= 0; }
    /* ── 列对齐：每列自上而下 = 专属盘 → 锅 → 食材桶，同一 x 中心线（要求 A1）── */
    function drawColumnGuide(i) {
      var cx = colCX(i);
      g.save();
      g.strokeStyle = "rgba(255,214,110,.16)"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx, LAY.colHeaderY + 6); g.lineTo(cx, LAY.buckets.y - 6); g.stroke();
      g.restore();
    }
    /** 列头小字：煎蛋 · 煎盘 · 3.0s（用户要求「列头显示这类小字」）*/
    function drawColumnHeader(i) {
      var f = FOOD[FOOD_IDS[i]];
      g.save();
      g.textAlign = "center"; g.textBaseline = "middle";
      g.font = fontOf(FONT.micro, true); g.fillStyle = PAL.gold;
      g.fillText(f.n + " · " + STATION_NAME[f.kind] + " · " + f.dur.toFixed(1) + "s", colCX(i), LAY.colHeaderY);
      g.restore();
    }
    function drawStations() {
      var pans = 0, plates = 0;
      for (var i = 0; i < st.stations.length; i++) {
        var s = st.stations[i], b = stationBox(i), pb = plateBox(i);
        s.box.x = b.x; s.box.y = b.y; s.box.w = b.w; s.box.h = b.h;
        s.plateBox.x = pb.x; s.plateBox.y = pb.y; s.plateBox.w = pb.w; s.plateBox.h = pb.h;
        var plate = plateOfStation(st, i);
        s.isPrep = true; s.hasPlate = true;
        drawColumnGuide(i);
        drawColumnHeader(i);
        drawPan(b, s, !!plate, IA.hover === i);          // 盘里还有一份 → 锅位半透明（不能下料）
        drawPlate(pb, plate, s);
        plates++;
        pans++;
      }
      IA.drawn.pans = pans; IA.drawn.plates = plates;
      IA.drawn.prepStations = 0;                          // 兼容旧字段：不再分「预备盘灶位」
      IA.drawn.serveStations = 0;                         // 兼容旧字段：不再有「无盘现做灶位」
      IA.drawn.columns = COL_N;
    }
    /** 锅 / 煎盘 / 蒸格 / 沙拉台 / 果汁机（每列一个，正上方是自己的专属盘）*/
    function drawPan(b, s, busy, isHover) {
      var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      var fd = s.food ? FOOD[s.food] : null;
      var R = Math.min(b.w, b.h) / 2 - 9;
      var ready = !!fd && s.state === "perfect";
      var left = Math.max(0, s.serveWin || 0);           // 旧机制：锅内出餐窗口剩余（现在恒为 0）
      var frac = SERVE_WINDOW > 0 ? Math.max(0, Math.min(1, left / SERVE_WINDOW)) : 0;
      var lastSec = ready && left <= SERVE_WARN_SEC;
      var blink = Math.floor(nowMs() / 200) % 2 === 0;
      g.save();
      if (busy) g.globalAlpha = 0.42;                       // 盘里还有一份 → 锅位半透明
      var pg = g.createLinearGradient(0, b.y, 0, b.y + b.h);
      if (s.kind === "pot") { pg.addColorStop(0, "#414859"); pg.addColorStop(1, "#12151d"); }
      else if (s.kind === "griddle") { pg.addColorStop(0, "#37303c"); pg.addColorStop(1, "#141118"); }
      else if (s.kind === "steamer") { pg.addColorStop(0, "#7d5931"); pg.addColorStop(1, "#2f1e0e"); }
      else { pg.addColorStop(0, "#6d4527"); pg.addColorStop(1, "#2a180d"); }
      /* 焦黑：锅体整个变黑（糊掉的锅一眼可辨） */
      if (s.state === "burnt") { pg = g.createLinearGradient(0, b.y, 0, b.y + b.h); pg.addColorStop(0, "#1a1512"); pg.addColorStop(1, "#050403"); }
      /* 灶位贴图：汤锅 / 三格煎盘 / 蒸笼 / 木托盘 / 果汁壶（等比塞进灶位框，缺图 → 矢量锅体）*/
      var gearImg = assetOf(GEAR_ICON, gearNameOfKind(s.kind));
      g.fillStyle = pg;
      if (gearImg) {
        drawAssetFit(g, gearImg, { x: b.x + 6, y: b.y + 30, w: b.w - 12, h: b.h - 56 }, null);
        IA.drawn.gear = (IA.drawn.gear || 0) + 1;
      } else if (s.kind === "pot") { g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill(); }
      else { roundRect(g, b.x + 5, b.y + 5, b.w - 10, b.h - 10, 16); g.fill(); }
      if (!gearImg) {
        if (s.kind === "pot") {
          g.strokeStyle = "rgba(200,210,230,.40)"; g.lineWidth = 5;
          g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
          g.fillStyle = "rgba(255,255,255,.07)";
          g.beginPath(); g.arc(cx, cy, R - 9, 0, Math.PI * 2); g.fill();
        } else if (s.kind === "steamer") {
          g.strokeStyle = "rgba(255,225,180,.22)"; g.lineWidth = 3;
          for (var k = 0; k < 3; k++) { g.beginPath(); g.moveTo(b.x + 16 + k * 30, b.y + 26); g.lineTo(b.x + 16 + k * 30, b.y + b.h - 24); g.stroke(); }
        } else if (s.kind === "counter" || s.kind === "juicer") {
          g.strokeStyle = "rgba(255,225,180,.14)"; g.lineWidth = 2;
          for (var k2 = 1; k2 < 4; k2++) { g.beginPath(); g.moveTo(b.x + 10, b.y + 26 + k2 * 26); g.lineTo(b.x + b.w - 10, b.y + 26 + k2 * 26); g.stroke(); }
        } else {
          g.strokeStyle = "rgba(255,255,255,.10)"; g.lineWidth = 2;
          g.beginPath(); g.moveTo(b.x + 14, b.y + b.h - 26); g.lineTo(b.x + b.w - 14, b.y + b.h - 26); g.stroke();
        }
      }

      if (s.kind === "pot" || s.kind === "griddle") {        // 火口
        for (var f = 0; f < 4; f++) {
          var fx = b.x + 18 + f * ((b.w - 36) / 3);
          g.fillStyle = (fd && s.state !== "burnt") ? "rgba(255,140,50,.60)" : "rgba(255,140,50,.18)";
          g.beginPath(); g.arc(fx, b.y + b.h - 16, 6, 0, Math.PI * 2); g.fill();
        }
      }
      /* 进度环：生=浅蓝 / 恰好=绿 / 过火=橙 / 糊=红 */
      var rr = R - 16;
      /* 环的底：先用深色描一圈当「垫底」，否则进度环压在亮色厨具贴图上会看不清
         （生=浅蓝 / 恰好=绿 / 过火=橙 / 糊=红 这四档语义一个都没改）*/
      g.lineWidth = 13; g.strokeStyle = "rgba(10,7,4,.55)";
      g.beginPath(); g.arc(cx, cy, rr, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 9; g.strokeStyle = "rgba(255,255,255,.10)";
      g.beginPath(); g.arc(cx, cy, rr, 0, Math.PI * 2); g.stroke();
      if (fd) {
        var total = fd.dur + fd.pw + fd.burn;
        var pct = Math.max(0, Math.min(1, (s.t / 1000) / total));
        g.strokeStyle = s.state === "perfect" ? PAL.green
                      : (s.state === "burnt" ? PAL.red : (s.state === "over" ? PAL.steelHot : "#7fb0d8"));
        g.lineWidth = 9;
        g.beginPath(); g.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct); g.stroke();
        g.save(); g.translate(cx, cy - 4);
        if (s.state === "perfect") g.translate(0, Math.sin(nowMs() / 160) * 2);
        drawFood(g, s.food, FS.pan, s.state);
        g.restore();
      }
      /* 旧机制的锅内出餐窗口环（兼容保留：现在食物一到「恰好」就落盘，不会开窗口）*/
      if (ready && left > 0) {
        g.strokeStyle = lastSec && blink ? "#ffffff" : (lastSec ? PAL.red : PAL.steelHot);
        g.lineWidth = lastSec ? 12 : 10;
        g.beginPath();
        g.arc(cx, cy, R - 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
        g.stroke();
      }
      if (s.state === "burnt") { g.fillStyle = "rgba(0,0,0,.62)"; roundRect(g, b.x + 5, b.y + 5, b.w - 10, b.h - 10, 16); g.fill(); }
      else if (s.state === "over") { g.fillStyle = "rgba(255,179,71,.16)"; roundRect(g, b.x, b.y, b.w, b.h, 16); g.fill(); }
      g.restore();
      /* 边框 + 名字 */
      var edge = !fd ? (busy ? "rgba(255,179,71,.40)" : "rgba(255,255,255,.16)")
                     : (s.state === "perfect" ? PAL.green
                     : (s.state === "burnt" ? PAL.red
                     : (s.state === "over" ? PAL.steelHot : "#8a93a8")));
      g.strokeStyle = isHover ? PAL.gold : edge;
      g.lineWidth = (s.state === "perfect" || s.state === "burnt") ? 4 : (isHover ? 4 : 2);
      roundRect(g, b.x, b.y, b.w, b.h, 16); g.stroke();
      g.textBaseline = "middle"; g.textAlign = "center";
      g.font = fontOf(FONT.panName, true); g.fillStyle = PAL.ink;
      g.fillText(colNameOf(s.col), cx, b.y + 13);
      g.font = fontOf(FONT.micro, false); g.fillStyle = "rgba(255,255,255,.34)";
      g.fillText(busy ? "盘里还有一份" : (fd ? "在烧" : "空着 · 点食材"), cx, b.y + 29);
      if (s.state === "burnt") {
        /* 焦黑锅 + 红叉（贴图）+ 冒烟 */
        if (drawUiIcon(g, "cross", cx - 24, cy - 24, 48)) IA.drawn.uiCross = (IA.drawn.uiCross || 0) + 1;
        else {
          g.strokeStyle = PAL.red; g.lineWidth = 7;
          g.beginPath(); g.moveTo(cx - 18, cy - 18); g.lineTo(cx + 18, cy + 18);
          g.moveTo(cx + 18, cy - 18); g.lineTo(cx - 18, cy + 18); g.stroke();
        }
        g.fillStyle = "rgba(190,190,190,.60)";
        for (var k3 = 0; k3 < 5; k3++) {
          var sy = b.y + 30 - ((nowMs() / 9 + k3 * 26) % 54);
          g.beginPath(); g.arc(cx + (k3 - 2) * 10 + Math.sin(nowMs() / 300 + k3) * 5, sy, 8 - k3 * 0.7, 0, Math.PI * 2); g.fill();
        }
      }
      if (fd) {
        g.font = fontOf(FONT.micro, true); g.textAlign = "center";
        var txt = s.state === "burnt" ? "糊了 · 双击丢掉"
                : (s.state === "perfect" ? "恰好 · 落盘"
                : (s.state === "over" ? "过火 · 可上" : "生 " + (s.t / 1000).toFixed(1) + "s"));
        g.fillStyle = s.state === "burnt" ? "#ffd0d8" : (s.state === "perfect" ? "#ddffe9" : "rgba(255,255,255,.60)");
        g.fillText(txt, cx, b.y + b.h - 9);
      }
      g.textAlign = "left";
    }
    /* 专属盘（每列一个，在锅的正上方）：空盘 = 浅色轮廓 + 列归属标签（「煎蛋盘 · 空」）；
       有食物 = 食物 + 热乎档位 + 倒计时 / 降档提示；糊了 = 红叉 + 「只能丢」 */
    function drawPlate(b, p, s) {
      var cx = b.x + b.w / 2, cy = b.y + 46;
      var rw = b.w / 2 - 6, rh = 30;
      var tier = p ? (p.tier || "warm") : null;
      var col = p ? (TIER_COLOR[tier] || PAL.steel) : null;
      g.fillStyle = "rgba(0,0,0,.42)";
      g.beginPath(); g.ellipse(cx, cy + 7, rw, rh, 0, 0, Math.PI * 2); g.fill();
      /* 盘位贴图：空盘 / 有食物盘（煎蛋培根盘、包子盘）；糊了 → 半透明压暗（双击丢弃的视觉）*/
      var ptex = assetOf(GEAR_ICON, plateTexOfFood(p ? p.food : null));
      if (ptex) {
        drawAssetFit(g, ptex, { x: b.x + 6, y: cy - 36, w: b.w - 12, h: 72 }, (p && p.state === "burnt") ? 0.55 : null);
        IA.drawn.plateTex = (IA.drawn.plateTex || 0) + 1;
      } else {
        var pg = g.createLinearGradient(cx - rw, cy - rh, cx + rw, cy + rh);
        if (!p) { pg.addColorStop(0, "rgba(246,242,232,.22)"); pg.addColorStop(1, "rgba(186,182,174,.07)"); }
        else { pg.addColorStop(0, "rgba(255,255,255,.38)"); pg.addColorStop(1, col); }
        g.fillStyle = pg; g.beginPath(); g.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = p ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.26)"; g.lineWidth = 3;
        g.beginPath(); g.ellipse(cx, cy, rw * 0.72, rh * 0.72, 0, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = p ? col : "rgba(255,255,255,.38)"; g.lineWidth = p ? 4 : 2.5;
        g.beginPath(); g.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2); g.stroke();
      }
      g.textAlign = "center"; g.textBaseline = "middle";
      if (!p) {                                              // 空盘：贴图 / 矢量轮廓 + 列归属标签
        g.font = fontOf(FONT.micro, true);
        g.fillStyle = ptex ? "rgba(74,54,36,.88)" : "rgba(255,255,255,.46)";   // 白瓷盘上要用深色字才读得出
        g.fillText(plateNameOf(s.col) + " · 空", cx, cy);
        g.textAlign = "left";
        return;
      }
      /* 有食物：盘贴图自带食物（煎蛋培根盘 / 包子盘）时不再叠一份，避免一盘两样 */
      if (!(ptex && plateTexHasFood(p.food))) { g.save(); g.translate(cx, cy - 6); drawFood(g, p.food, FS.plate, p.state); g.restore(); }

      if (p.state === "burnt") {                             // 糊：红叉 + 只能双击丢
        if (drawUiIcon(g, "cross", cx - 19, cy - 23, 38)) IA.drawn.uiCross = (IA.drawn.uiCross || 0) + 1;
        else {
          g.strokeStyle = PAL.red; g.lineWidth = 6;
          g.beginPath(); g.moveTo(cx - 16, cy - 20); g.lineTo(cx + 16, cy + 8); g.moveTo(cx + 16, cy - 20); g.lineTo(cx - 16, cy + 8); g.stroke();
        }
        g.fillStyle = "rgba(0,0,0,.55)"; roundRect(g, b.x + 2, b.y + b.h - 34, b.w - 4, 32, 8); g.fill();
        g.font = fontOf(FONT.micro, true); g.fillStyle = "#ffd0d8";
        g.fillText((FOOD[p.food] || {}).n + "·糊了", cx, b.y + b.h - 24);
        g.fillStyle = "rgba(255,160,180,.95)";
        g.fillText("只能丢（双击）", cx, b.y + b.h - 10);
        g.textAlign = "left";
        return;
      }
      var left = (typeof p.left === "number") ? p.left : plateLeftSec(p.age || 0);
      var urgent = left <= SERVE_WARN_SEC;
      var blink2 = urgent && (Math.floor(nowMs() / 200) % 2 === 0);
      g.fillStyle = "rgba(0,0,0,.55)"; roundRect(g, b.x + 2, b.y + b.h - 34, b.w - 4, 32, 8); g.fill();
      g.font = fontOf(FONT.micro, true);
      g.fillStyle = blink2 ? "#ffffff" : (TIER_COLOR[tier] || PAL.ink);
      g.fillText((FOOD[p.food] || {}).n + "·" + (TIER_NAME[tier] || ""), cx, b.y + b.h - 24);
      g.font = fontOf(FONT.micro, false);
      g.fillStyle = blink2 ? "#ffffff" : (urgent ? PAL.red : "rgba(255,255,255,.72)");
      g.fillText(left.toFixed(1) + "s 内送出", cx, b.y + b.h - 10);
      g.textAlign = "left";
    }
    /** 底排食材桶的标题（顺带把「正上方就是它的锅」讲清楚）*/
    function drawPlates() {
      g.font = fontOf(FONT.label, true); g.fillStyle = PAL.gold; g.textAlign = "left"; g.textBaseline = "middle";
      g.fillText("食材 · 点一下自动进它正上方那一列的锅", LAY.buckets.x0, LAY.buckets.y + LAY.bucketLabelDy);
      g.textAlign = "right"; g.fillStyle = PAL.dim; g.font = fontOf(FONT.tiny, false);
      g.fillText("9 列 × 每列 1 锅 1 专属盘 · 盘上停留超过 " + SERVE_WINDOW.toFixed(1) + "s 会糊，糊了只能双击丢掉",
                 W - LAY.buckets.x0, LAY.buckets.y + LAY.bucketLabelDy);
      g.textAlign = "left";
    }
    /** 操作图例条：三条操作写清楚（要求 A7：点食材 / 点盘 / 双击盘）*/
    function drawLegend() {
      var x = LAY.legend.x, y = LAY.legend.y, w = LAY.legend.w, h = LAY.legend.h;
      g.save();
      g.fillStyle = "rgba(14,9,14,.86)"; roundRect(g, x, y, w, h, 8); g.fill();
      g.strokeStyle = "rgba(255,214,110,.35)"; g.lineWidth = 2; roundRect(g, x, y, w, h, 8); g.stroke();
      g.textBaseline = "middle"; g.textAlign = "center";
      g.font = fontOf(FONT.small, true); g.fillStyle = PAL.ink;
      g.fillText("① 点食材 → 自动下锅（进它那一列）　｜　② 点专属盘 → 送给正在等的顾客　｜　③ 双击盘 → 丢垃圾桶（不扣分）",
                 x + w / 2, y + h / 2);
      /* 厨具素材里的「锅铲 + 夹子」放在图例条右端的空位（不挤文字，纯装饰）*/
      if (drawAssetFit(g, assetOf(GEAR_ICON, "tools"), { x: x + w - 60, y: y + 2, w: 54, h: h - 4 }, null)) IA.drawn.gearTools = (IA.drawn.gearTools || 0) + 1;
      /* 声音开关徽章（图例条左端空位；可点，见 onDown）—— 🔊 开 / 🔇 关 一眼可见 */
      var sb = soundBox(), sOn = audio.enabled();
      g.fillStyle = sOn ? "rgba(255,214,110,.16)" : "rgba(255,255,255,.05)";
      roundRect(g, sb.x, sb.y, sb.w, sb.h, 6); g.fill();
      g.strokeStyle = sOn ? "rgba(255,214,110,.60)" : "rgba(255,255,255,.22)";
      g.lineWidth = 2; roundRect(g, sb.x, sb.y, sb.w, sb.h, 6); g.stroke();
      g.font = fontOf(FONT.micro, true);
      g.fillStyle = sOn ? PAL.gold : PAL.dim;
      g.fillText(sOn ? "🔊 音效 开" : "🔇 音效 关", sb.x + sb.w / 2, sb.y + sb.h / 2);
      IA.drawn.soundBadge = sOn ? "on" : "off";
      g.restore();
      g.textAlign = "left";
      IA.drawn.legend = true;
    }
    function drawBuckets() {
      for (var i = 0; i < FOOD_IDS.length; i++) {
        var b = bucketBox(i), fd = FOOD[FOOD_IDS[i]], hov = IA.hoverBucket === i;
        var grad = g.createLinearGradient(0, b.y, 0, b.y + b.h);
        grad.addColorStop(0, "#6d4629"); grad.addColorStop(1, "#2c1a10");
        g.fillStyle = grad; roundRect(g, b.x, b.y, b.w, b.h, 14); g.fill();
        g.strokeStyle = hov ? PAL.gold : "rgba(255,204,140,.42)"; g.lineWidth = hov ? 4 : 2;
        roundRect(g, b.x, b.y, b.w, b.h, 14); g.stroke();
        g.fillStyle = "rgba(0,0,0,.24)"; roundRect(g, b.x + 8, b.y + 8, b.w - 16, 76, 12); g.fill();
        g.save(); g.translate(b.x + b.w / 2, b.y + 46); drawFood(g, FOOD_IDS[i], FS.bucket, "perfect"); g.restore();
        g.textAlign = "center"; g.textBaseline = "middle";
        g.font = fontOf(FONT.bucket, true); g.fillStyle = PAL.ink;
        g.fillText(fd.n, b.x + b.w / 2, b.y + 100);
        g.font = fontOf(FONT.small, false); g.fillStyle = PAL.dim;
        g.fillText(STATION_NAME[fd.kind] + " · " + fd.dur.toFixed(1) + "s", b.x + b.w / 2, b.y + 122);
        g.font = fontOf(FONT.micro, true); g.fillStyle = "rgba(255,214,110,.78)";
        g.fillText("点我下锅", b.x + b.w / 2, b.y + 142);
        g.textAlign = "left";
      }
    }
    function drawFloats() {
      g.textAlign = "center"; g.textBaseline = "middle";
      for (var i = 0; i < st.floats.length; i++) {
        var f = st.floats[i], k = f.t / f.life;
        g.globalAlpha = Math.max(0, 1 - k);
        g.font = fontOf(Math.round(f.size * (1 + 0.22 * (1 - Math.min(1, k * 4)))), true);
        g.fillStyle = f.c;
        g.fillText(f.text, f.x, f.y - k * (f.center ? 16 : 30));
        g.globalAlpha = 1;
      }
      g.textAlign = "left";
    }
    function drawDrag() {
      if (!IA.drag) return;
      g.save(); g.globalAlpha = 0.94;
      g.fillStyle = "rgba(0,0,0,.35)"; g.beginPath(); g.arc(IA.drag.x, IA.drag.y, 40, 0, Math.PI * 2); g.fill();
      g.translate(IA.drag.x, IA.drag.y); drawFood(g, IA.drag.food, FS.bucket, "perfect");
      g.restore();
    }
    function positionFloats() {
      var list = activeCustomers(st);
      for (var i = 0; i < st.floats.length; i++) {
        var f = st.floats[i];
        if (f.x === 0 && f.y === 0) {
          if (f.center) { f.x = W / 2; f.y = LAY.platesLabelY + 6; }
          else if (list.length) { var b = customerCardBox(Math.min(list.length - 1, LAY.cards.n - 1)); f.x = b.x + b.w / 2; f.y = b.y + LAY.cards.h - 40; }
          else { f.x = W / 2; f.y = LAY.platesLabelY + 6; }
        }
      }
    }
    function render() {
      if (!doc) return;
      drawBg();
      var list = activeCustomers(st);
      for (var i = 0; i < list.length && i < LAY.cards.n; i++) drawCustomer(list[i], customerCardBox(i), i);
      if (!list.length && !st.over) {
        var b0 = customerCardBox(0);
        var wAll = LAY.cards.w * LAY.cards.n + LAY.cards.gap * (LAY.cards.n - 1);
        g.fillStyle = "rgba(255,255,255,.045)"; roundRect(g, b0.x, b0.y, wAll, LAY.cards.h, 14); g.fill();
        g.strokeStyle = "rgba(255,214,110,.28)"; g.lineWidth = 3; roundRect(g, b0.x, b0.y, wAll, LAY.cards.h, 14); g.stroke();
        g.font = fontOf(24, true); g.fillStyle = "rgba(255,214,110,.88)"; g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText("顾客马上进门 —— 可以先把 " + COL_N + " 列里的食材点上，熟了各自落到本列的盘上等着（盘上 4.5 秒内要送出去）", b0.x + wAll / 2, b0.y + LAY.cards.h / 2);
        g.textAlign = "left";
      }
      drawStations();
      drawPlates();
      drawBuckets();
      drawTopBar();
      drawLegend();
      positionFloats();
      drawFloats();
      drawDrag();
      IA.drawn.cards = Math.min(list.length, LAY.cards.n);
      IA.drawn.buckets = FOOD_IDS.length;
      IA.drawn.foods = st.plates.length + st.stations.filter(function (s2) { return !!s2.food; }).length;
    }

    function loop() {
      if (IA.finished) return;
      var t = nowMs(), dt = (t - IA.last) / 1000; IA.last = t;
      if (!(dt >= 0)) dt = 0;
      IA.acc += dt;
      var guard = 0;
      while (IA.acc >= 1 / 60 && guard++ < 6) { step(st, 1 / 60); IA.acc -= 1 / 60; }
      render();
      if (st.over) { IA.finished = true; showResult(); return; }
      IA.raf = RAF.call(root, loop);
    }

    function showResult() {
      var r = st.result || finish(st, st.win, st.reason);
      var win = !!r.win;
      panel.className = "bf-result " + (win ? "win" : "lose");
      panel.style.display = "block";
      var tgt = r.target || { name:"对方", bond:"-" };
      var bondTxt = (r.bondDelta > 0 ? "+" : "") + r.bondDelta;
      function row(k, v) { return '<div class="bf-kv"><span>' + k + '</span><b>' + v + '</b></div>'; }
      /* 信息区走 innerHTML；出口按钮用真实 DOM 节点建 —— 无论浏览器还是无头 DOM，
         document.querySelector("#bfGo") / panel.querySelector("#bfGo") 都取得到。 */
      panel.innerHTML =
        '<h3>' + uiIconTag(win ? "check" : "cross", win ? "🍳" : "…") + (win ? "送出热乎早餐" : "早餐烧坏了") + '</h3>' +
        '<div class="bf-q">' + escHtml(r.quote) + '</div>' +
        '<div class="bf-grid">' +
          row("服务顾客", r.served + " / " + r.goal) +
          row("完美份数", String(r.perfect) + (r.hot ? ("（热乎 " + r.hot + "）") : "")) +
          row("热乎度", "热乎 " + r.heat.hot + " · 温 " + r.heat.warm + " · 凉 " + r.heat.cold) +
          row("出餐预备", r.prepped + " 份（9 列专属盘 ×" + r.platesTotal + "）") +
          row("烧糊份数", String(r.burnt) + (r.expire ? ("（忘取 " + r.expire + "）") : "")) +
          row("用时", r.elapsed.toFixed(1) + "s / " + r.duration + "s") +
          row("本局得分", String(r.score)) +
          row(tgt.name + " 好感", '<b class="' + (r.bondDelta > 0 ? "up" : "down") + '">' + bondTxt + '</b>') +
        '</div>' +
        '<div class="bf-imp">📌 本局影响 · ' + escHtml(r.impact) + '</div>' +
        '<div class="bf-imp dim">' + uiIconTag("bulb", "🎯") + ' 接下来 · ' + escHtml(r.quota || quotaOf(win, r.bondDelta, tgt.name)) + '</div>' +
        (win ? '' : '<div class="bf-imp dim">失败也有台阶：明天再来一次就行 —— 只要好感还在 20~79 之间。</div>');
      var rowEl = el("div", "bf-row");
      var escHint = el("span", "bf-esc");
      escHint.textContent = "按 ESC 也可以退出（结算结果不会丢）";
      var go = mkBtn(win ? "收下早餐 · 继续" : "算了，明天再来 · 继续", "primary bf-red");
      go.id = "bfGo";
      go.setAttribute("data-act", "close");                 // 兼容旧验收脚本选择器
      go.addEventListener("click", function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        close(true);
      });
      rowEl.appendChild(escHint);
      rowEl.appendChild(go);
      panel.appendChild(rowEl);
      try { panel.scrollTop = 0; } catch (e) {}
      IA.goBtn = go;
    }
    function finishNow(why) {
      if (st.over) return st.result;
      finish(st, st.served >= st.cfg.goal, why || "主动收摊");
      if (!IA.finished) { IA.finished = true; showResult(); }
      return st.result;
    }
    /** 关闭并交还控制权；deliver=true 时把 result 交给 onFinish。
        幂等：连点 #bfGo / 点完再按 ESC 都只会交一次（onFinish 恰好一次）。 */
    function close(deliver) {
      if (IA.closed) return st.result;
      IA.closed = true;
      var r = st.result || finish(st, st.win, st.reason);
      var cb = cfg.onFinish;
      dispose();
      if (deliver && cb) { try { cb(r); } catch (e) {} }
      return r;
    }
    IA.close = close;
    IA.finishNow = finishNow;
    IA.render = render;
    IA.showResult = showResult;

    /* 初始：先热两样，别让玩家开局空等 */
    st.running = true; st.over = false; st.elapsed = 0; st.nextIn = 0.45;
    IA.last = nowMs();
    render();                          // 首帧同步绘制（E2E 读像素时才有内容）
    IA.raf = RAF.call(root, loop);
    return true;
  }

  function dispose() {
    if (!inst) return;
    var IA = inst; inst = null;
    IA.finished = true;
    if (IA.raf) { try { CAF.call(root, IA.raf); } catch (e) {} IA.raf = 0; lifecycle.rafCancelled++; }
    try { if (IA.detach) IA.detach(); } catch (e) {}
    try { if (IA.host) { IA.host.innerHTML = ""; IA.host.classList.remove("bf-on"); } } catch (e) {}
    try { hideOverlayOf(IA.host); } catch (e) {}    // 兜底：onFinish 没接住时也不留挡住的死界面
    lifecycle.disposed++;
  }
  /** 兜底：从 host 往上找 .overlay 祖先并摘掉 on（覆盖层一定要关掉） */
  function hideOverlayOf(from) {
    var n = from, guard = 0;
    while (n && guard++ < 12) {
      if (n.classList && n.classList.contains && n.classList.contains("overlay") && n.classList.remove)
        n.classList.remove("on");
      n = n.parentNode;
    }
  }
  function isBusy() { return !!inst; }
  function curState() { return inst ? inst.st : null; }

  /* ═══════════════ 5. 对外 API ═══════════════ */
  (function () {
    for (var i = 0; i < FOOD_IDS.length; i++) {
      var f = FOOD[FOOD_IDS[i]];
      f.need = STATION_NAME[f.kind];
      f.total = round1(f.dur + f.pw + f.burn);
    }
  })();

  var rules = {
    FOOD: FOOD, FOOD_IDS: FOOD_IDS, STATIONS: STATIONS, SCORE: SCORE, HEAT: HEAT,
    MAX_CUSTOMERS: MAX_CUSTOMERS, MAX_ANGRY: MAX_ANGRY, MAX_PLATES: MAX_PLATES, HOT_MS: HOT_MS,
    PREP_PLATES: PREP_PLATES, SERVE_WINDOW: SERVE_WINDOW, SERVE_WARN_SEC: SERVE_WARN_SEC,
    BURNT_LIFE_MS: BURNT_LIFE_MS, DOUBLE_MS: DOUBLE_MS,
    COLS: COLS, COL_N: COL_N, PLATES_TOTAL: PLATES_TOTAL,
    columnOf: columnOf, foodOfColumn: foodOfColumn, colNameOf: colNameOf, kindOfColumn: kindOfColumn,
    plateNameOf: plateNameOf, plateBurntAt: plateBurntAt, plateLeftSec: plateLeftSec, plateExpired: plateExpired,
    PLACE_WHY: PLACE_WHY, HEAT_TIERS: HEAT_TIERS,
    TARGETS: TARGETS, TARGET_IDS: TARGET_IDS,
    newState: newState, step: step, finish: finish, placeFood: placeFood, placeFoodEx: placeFoodEx,
    takePlate: takePlate, autoPlateStations: autoPlateStations, trashStation: trashStation, trashPlate: trashPlate,
    trashColumn: trashColumn,
    takeReady: takeReady, openServeWindow: openServeWindow, expireServeWindows: expireServeWindows,
    isPrepStation: isPrepStation, hasPlate: hasPlate, prepStationIndices: prepStationIndices,
    serveStationIndices: serveStationIndices, isServeWindowOpen: isServeWindowOpen,
    serveFoodToCustomer: serveFoodToCustomer, serveFromColumn: serveFromColumn,
    pickCustomerIndexFor: pickCustomerIndexFor, pickPlateIndex: pickPlateIndex,
    serveCustomer: serveCustomer, spawnCustomer: spawnCustomer,
    plateIdxOfStation: plateIdxOfStation, plateOfStation: plateOfStation, stationFree: stationFree, mkPlate: mkPlate,
    refreshPlate: refreshPlate, phaseOf: phaseOf, platePhaseOf: platePhaseOf,
    heatTierOf: heatTierOf, heatScore: heatScore, serveScore: serveScore, isHotTier: isHotTier,
    cookState: cookState, burnAt: burnAt, stationKindOf: stationKindOf, stationByIdx: stationByIdx,
    stationIndexOfKind: stationIndexOfKind, firstFreeStation: firstFreeStation,
    activeCustomers: activeCustomers, remainOf: remainOf, orderFor: orderFor, newCustomer: newCustomer,
    foodName: function (id) { return FOOD[id] ? FOOD[id].n : id; },
    diffAt: diffAt, orderLenAt: orderLenAt, patienceFor: patienceFor, spawnGapFor: spawnGapFor, nextGap: nextGap,
    scoreDelta: scoreDelta, SCORE_KINDS: SCORE_KINDS, isFoodInOrder: isFoodInOrder,
    bondDeltaWin: bondDeltaWin, bondDeltaLose: bondDeltaLose, bondDeltaFor: bondDeltaFor, bondHeat: bondHeat,
    eligibleTargets: eligibleTargets, canSend: canSend, markSent: markSent, sentToday: sentToday,
    quoteFor: quoteFor, impactOf: impactOf, quotaOf: quotaOf, QUOTES: QUOTES, QUOTE_FALLBACK: QUOTE_FALLBACK,
    /* 音效 / 顾客语音（bf-audio-1）：阈值 / 节奏 / 节流 / 开关 / 播放记录，全在这里 */
    audio: audioRules
  };

  var ui = {
    TARGETS: TARGETS, TARGET_IDS: TARGET_IDS,
    canSend: canSend, eligible: eligibleTargets, markSent: markSent, sentToday: sentToday,
    bondDeltaFor: bondDeltaFor, bondDeltaWin: bondDeltaWin, bondDeltaLose: bondDeltaLose,
    quoteFor: quoteFor, impactOf: impactOf, quotaOf: quotaOf,
    /** 选对象面板：list = [{id,name,f,bond,ok,why}] */
    openTargetPanel: function (hostEl, list, opts) {
      if (!hostEl || !doc) return false;
      opts = opts || {};
      hostEl.innerHTML = "";
      var wrap = el("div", "bf-tp");
      wrap.appendChild(el("h3", null, "🍳 做份早餐 · 送给谁？"));
      wrap.appendChild(el("div", "bf-tp-sub",
        "同一天同一个人只能送一次（当前 Day " + (opts.day === undefined ? "-" : opts.day) + "）· 通过：好感 +6~+10 · 失败：好感 −3~−6（不虐主）"));
      var grid = el("div", "bf-tp-grid");
      for (var i = 0; i < list.length; i++) {
        (function (t) {
          var card = el("div", "bf-card" + (t.ok ? "" : " off"));
          card.setAttribute("data-id", t.id);
          card.setAttribute("data-ok", t.ok ? "1" : "0");
          card.innerHTML =
            '<div class="bf-f">' + (t.f || "🙂") + '</div>' +
            '<div class="bf-cn">' + escHtml(t.name) + '</div>' +
            '<div class="bf-cb">好感 <b>' + t.bond + '</b></div>' +
            (t.ok
              ? '<div class="bf-cg">通过 +6~+10 · 失败 −6~−3</div><div class="bf-cr">热乎 / 完美越多，加得越多</div>'
              : '<div class="bf-cw">' + escHtml(t.why) + '</div>');
          if (t.ok) card.addEventListener("click", function () { if (opts.onPick) opts.onPick({ id:t.id, name:t.name, bond:t.bond, f:t.f }); });
          grid.appendChild(card);
        })(list[i]);
      }
      wrap.appendChild(grid);
      var row = el("div", "bf-row");
      var cancel = mkBtn("先不做了");
      cancel.addEventListener("click", function () { if (opts.onCancel) opts.onCancel(); });
      row.appendChild(cancel);
      wrap.appendChild(row);
      hostEl.appendChild(wrap);
      return true;
    }
  };

  var api = {
    version: "bf-3.0",
    TARGETS: TARGETS,
    FOOD: FOOD, FOOD_IDS: FOOD_IDS, STATIONS: STATIONS, SCORE: SCORE, HEAT: HEAT,
    COLS: COLS, COL_N: COL_N, PLATES_TOTAL: PLATES_TOTAL,
    VIEW: VIEW, FONT: FONT, ICON: ICON, LAY: LAY,
    MAX_PLATES: MAX_PLATES, MAX_CUSTOMERS: MAX_CUSTOMERS, MAX_ANGRY: MAX_ANGRY,
    PREP_PLATES: PREP_PLATES, SERVE_WINDOW: SERVE_WINDOW,
    columnOf: columnOf, foodOfColumn: foodOfColumn, colNameOf: colNameOf,
    stationBox: stationBox, plateBox: plateBox, bucketBox: bucketBox, customerCardBox: customerCardBox,
    art: art,
    start: start, isBusy: isBusy, dispose: dispose,
    rules: rules, ui: ui,
    debug: {
      state: function () {
        var st = curState(); if (!st) return null;
        return { running:st.running, over:st.over, elapsed:Math.round(st.elapsed * 100) / 100,
          score:st.score, served:st.served, goal:st.cfg.goal, perfect:st.perfect, normal:st.normal,
          hot:st.hot, heat:{ hot:st.heat.hot || 0, warm:st.heat.warm || 0, cold:st.heat.cold || 0 },
          prepped:st.prepped, autoPlate:!!st.cfg.autoPlate, plateCount:st.plates.length,
          prepPlates:PLATES_TOTAL, platesTotal:PLATES_TOTAL, columns:COL_N, colN:COL_N,
          serveWindow:SERVE_WINDOW, plateLife:SERVE_WINDOW, expire:st.expire || 0, tossed:st.tossed || 0,
          windows:st.stations.filter(function (s) { return isServeWindowOpen(s); }).length,
          burnt:st.burnt, burntServed:st.burntServed, wrong:st.wrong, angry:st.angry, win:st.win, reason:st.reason,
          target:st.cfg.target, result:st.result };
      },
      orders: function () {
        var st = curState(); if (!st) return [];
        return activeCustomers(st).map(function (c) {
          return { id:c.id, order:c.order.slice(), done:c.done.slice(),
            patience:Math.round(c.patience * 100) / 100, patienceMax:c.patienceMax, angry:c.angry };
        });
      },
      stations: function () {
        var st = curState(); if (!st) return [];
        return st.stations.map(function (s, i) {
          var p = plateOfStation(st, i);
          return { i:i, col:s.col, name:colNameOf(i), colFood:foodOfColumn(i),
                   kind:s.kind, idx:s.idx, food:s.food, t:Math.round(s.t), state:s.state,
                   phase:phaseOf(st, i), plate:p ? p.food : null, tier:p ? p.tier : null, manual:!!s.manual,
                   prep:true, hasPlate:true,
                   plateState:p ? p.state : null, plateLeft:p ? (p.left || 0) : 0,
                   serveWin:Math.round((s.serveWin || 0) * 1000) / 1000,
                   windowOpen:isServeWindowOpen(s) };
        });
      },
      plates: function () {
        var st = curState(); if (!st) return [];
        return st.plates.map(function (p) {
          return { station:p.station, food:p.food, state:p.state, tier:p.tier, hot:!!p.hot,
                   age:p.age || 0, left:(typeof p.left === "number") ? p.left : 0, cookSec:p.cookSec || 0 };
        });
      },
      /** 9 列的绑定关系（要求 A1：一一对应、索引稳定、不可互换）*/
      columns: function () {
        var st = curState(); if (!st) return [];
        return COLS.map(function (c, i) {
          var s = st ? st.stations[i] : null;
          var p = st ? plateOfStation(st, i) : null;
          return { col:i, food:c.food, foodName:(FOOD[c.food] || {}).n, kind:c.kind,
                   stationName:c.station, plateName:plateNameOf(i),
                   cook:(s ? s.food : null), state:(s ? s.state : "idle"),
                   plate:(p ? p.food : null), tier:(p ? p.tier : null),
                   plateState:(p ? p.state : null), plateLeft:(p ? (p.left || 0) : 0) };
        });
      },
      columnOf: function (foodId) { return columnOf(foodId); },
      /** 单击盘会送给谁（返回顾客 id，没人要返回 -1）*/
      pickFor: function (foodId) {
        var st = curState(); if (!st) return -1;
        var ci = pickCustomerIndexFor(st, foodId);
        return ci < 0 ? -1 : st.customers[ci].id;
      },
      score: function () { var st = curState(); return st ? st.score : null; },
      goal: function () { var st = curState(); return st ? st.cfg.goal : null; },
      /** 渲染层实测数据（尺寸 / 字号 / 本帧真的画了几个锅位与盘子）*/
      view: function () {
        if (!inst) return null;
        return { w:VIEW.w, h:VIEW.h, dpr:inst.dpr, cvW:inst.cv.width, cvH:inst.cv.height,
                 font:FONT, icon:ICON, lay:LAY, drawn:inst.drawn,
                 icons:{ span:FOOD_ICON.span, scale:FOOD_ICON.scale, dir:FOOD_ICON.dir, ext:FOOD_ICON.ext,
                         base:FOOD_ICON.base, spec:FOOD_ICON.spec, ids:FOOD_IDS.slice(),
                         loaded:FOOD_ICON.loaded, failed:FOOD_ICON.failed,
                         ready:iconReadyCount(), vector:vectorCount() },
                 stationCount:inst.st.stations.length, plateCount:inst.st.plates.length };
      },
      /** 贴图可用性（给测试看：几张真的能画、几张只能走矢量）*/
      icons: function () {
        var out = [];
        for (var i = 0; i < FOOD_IDS.length; i++) {
          var id = FOOD_IDS[i], img = FOOD_ICON.map[id], nw = img ? (img.naturalWidth || 0) : 0;
          out.push({ id:id, has:!!img, loaded:!!(img && nw > 0 && img.complete !== false),
                     src:(img && typeof img.src === "string") ? img.src : "", naturalWidth:nw,
                     naturalHeight:(img ? (img.naturalHeight || 0) : 0),
                     drawAs:foodIcon(id) ? "image" : "vector" });
        }
        return out;
      },
      /** 每个灶位 ↔ 专属盘的一一对应关系（现在 9 列每列都有盘）*/
      /** 背景底图状态（无头验收：背景真的被画出来了吗）*/
      bg: function () { return art.bg(); },
      /** 本帧各类贴图的实际使用次数（无头验收读它 —— 贴图真的走 drawImage 了）*/
      tex: function () {
        var d = inst ? inst.drawn : {};
        return { bg:!!d.bg, bgMode:d.bgMode || null, panTex:d.gear || 0, plateTex:d.plateTex || 0,
                 faces:d.faces || 0, faceMood:d.faceMood || null, faceName:d.faceName || null,
                 uiBar:d.uiBar || 0, uiBarFill:d.uiBarFill || 0, uiStars:d.uiStars || 0,
                 uiCoin:d.uiCoin || 0, uiCheck:d.uiCheck || 0, uiCross:d.uiCross || 0,
                 gearTools:d.gearTools || 0 };
      },
      /** 顾客头像（三态）：耐心比例 / 是否全部拿到 → calm / urgent / happy；出图与断言都读它 */
      faces: function () {
        var st = curState(); if (!st) return [];
        return activeCustomers(st).map(function (c, i) {
          var n = Math.max(0, c.patience) / Math.max(0.01, c.patienceMax);
          var happy = faceSatisfied(c);
          var name = faceNameIn(st, c.id, n, happy);
          var img = FACE_ICON.map[name];
          return { slot:i, id:c.id, ratio:Math.round(n * 1000) / 1000, name:name,
                   mood:faceMoodOf(c.id, n, happy), happy:happy, kind:faceKindOf(c.id),
                   pool:facePoolFor(st), satisfiedRule:FACE_SATISFIED_RULE,
                   ready:!!assetOf(FACE_ICON, name), src:(img && typeof img.src === "string") ? img.src : "",
                   box:customerCardBox(Math.min(i, LAY.cards.n - 1)) };
        });
      },
      /** 出图 / 测试用：把某位顾客的耐心直接定到「满耐心的百分之几」（r ∈ 0..1）*/
      setPatience: function (cid, ratio) {
        var st = curState(); if (!st) return false;
        var r = Number(ratio); if (!(r >= 0)) r = 1; if (r > 1) r = 1;
        for (var i = 0; i < st.customers.length; i++) {
          if (st.customers[i].id === cid) {
            st.customers[i].patience = st.customers[i].patienceMax * r;
            return true;
          }
        }
        return false;
      },
      plateMap: function () {

        var st = curState(); if (!st) return [];
        return st.stations.map(function (s, i) {
          var p = plateOfStation(st, i);
          return { station:i, col:i, kind:s.kind, idx:s.idx, prep:true, hasPlate:true,
                   colFood:foodOfColumn(i),
                   plateStation:(p ? p.station : -1), food:(p ? p.food : null) };
        });
      },
      /** 列绑定（兼容旧 prepMap 的名字）：9 列、每列都有盘、没有「无盘现做灶位」*/
      prepMap: function () {
        return { prepPlates:PLATES_TOTAL, platesTotal:PLATES_TOTAL, columns:COL_N,
                 serveWindow:SERVE_WINDOW, plateLife:SERVE_WINDOW,
                 prep:prepStationIndices(), serve:serveStationIndices() };
      },
      /** 下料并拿到明确原因码（要求 A2） */
      placeEx: function (foodId, stationIdx) { var st = curState(); return st ? placeFoodEx(st, foodId, stationIdx, null) : { ok:false, why:"no-run" }; },
      /** 正常下料（走游戏自动装盘路径）*/
      drop: function (foodId, stationIdx) { var st = curState(); return st ? placeFood(st, foodId, stationIdx) : false; },
      /** tap("bucket",i) 下料（自动进第 i 列）/ tap("plate",i) 单击盘出餐 / tap("dbl",i) 双击盘丢垃圾桶 */
      tap: function (kind, idx) {
        var st = curState(); if (!st) return false;
        if (kind === "bucket" || kind === "food") return placeFood(st, (typeof idx === "string") ? idx : FOOD_IDS[idx], null);
        /* plate = 单击盘 → 出餐（要求 A3）；station = 锅内做好的手动落盘（autoPlate 关掉时才用得上） */
        if (kind === "plate") return serveFromColumn(st, idx).ok;
        if (kind === "station") return takePlate(st, idx);
        if (kind === "trash" || kind === "dbl" || kind === "double") return trashColumn(st, idx);
        if (kind === "customer") return serveCustomer(st, idx, null).ok;
        return false;
      },
      /** 单击某一列的盘 → 送给「正在需要 + 耐心最少」的顾客（返回完整结果，测试读 why / delta）*/
      serveCol: function (idx) { var st = curState(); if (!st) return { ok:false, why:"no-run" }; return serveFromColumn(st, idx); },
      /** 双击某一列的盘 / 锅 → 丢垃圾桶（清空锅 + 盘，不扣分）*/
      trashCol: function (idx) { var st = curState(); if (!st) return false; return trashColumn(st, idx); },
      /** 现做灶位：取出并立刻送往顾客（没人点 → 丢弃，不扣分）*/
      ready: function (idx) { var st = curState(); if (!st) return { ok:false, why:"no-run" }; return takeReady(st, idx); },
      serve: function (ci, pi) { var st = curState(); if (!st) return { ok:false, why:"no-run" }; return serveCustomer(st, ci, pi); },
      /** 按顾客 id 出餐（不受 left/离场影响的原位查找）*/
      serveId: function (cid, pi) {
        var st = curState(); if (!st) return { ok:false, why:"no-run" };
        for (var i = 0; i < st.customers.length; i++) if (st.customers[i].id === cid) return serveCustomer(st, i, pi);
        return { ok:false, why:"no-customer" };
      },
      trash: function (idx) { var st = curState(); if (!st) return false; return trashStation(st, idx); },
      finishNow: function () { return inst ? inst.finishNow("debug") : null; },
      close: function () { return inst ? inst.close(true) : null; },
      /** 测试用：按固定 dt 秒推进（不依赖 rAF）。
          注意 step() 内部把单次 dt 夹到 0.5s（卡帧保护），这里按 1/60 切片补齐，语义才是「推进 dt 秒」。 */
      tick: function (dt) {
        var st = curState(); if (!st) return null;
        var d = (typeof dt === "number" && dt > 0) ? dt : (1 / 60);
        var ev = [], guard = 0;
        while (d > 0 && guard++ < 4096) {
          var slice = d > 0.5 ? 0.5 : d;
          var one = step(st, slice);
          for (var i = 0; i < one.length; i++) ev.push(one[i]);
          d -= slice;
          if (st.over) break;
        }
        return ev;
      },
      pushCustomer: function (order) { var st = curState(); if (!st) return null; return spawnCustomer(st, order).id; },
      /** 下料并「按住火候」：不自动装盘（用于验证生→恰好→糊的火候状态机）*/
      place: function (foodId, stationIdx) {
        var st = curState(); if (!st) return false;
        return placeFoodEx(st, foodId, stationIdx, { manual:true }).ok;
      },
      /** 手动装盘（旧手感 / 回归用）*/
      plate: function (stationIdx) { var st = curState(); return st ? takePlate(st, stationIdx) : false; },
      /** 调试 / 出图用：把某盘「已放置多久」定到指定秒数（用来摆出 热乎 / 温 / 凉 三档同框）*/
      setPlateAge: function (stationIdx, ageSec) {
        var st = curState(); if (!st) return false;
        var k = plateIdxOfStation(st, stationIdx); if (k < 0) return false;
        var a = Number(ageSec); if (!(a >= 0)) a = 0;
        st.plates[k].at = st.elapsed - a;
        refreshPlate(st, st.plates[k]);
        return true;
      },
      setCook: function (stationIdx, seconds) {
        var st = curState(); if (!st) return false;
        var s = stationByIdx(st, stationIdx); if (!s || !s.food) return false;
        s.t = seconds * 1000; s.state = cookState(s.food, seconds);
        s.manual = true;                                    // 直接改火候时按住，别被自动落盘吃掉
        if (s.state === "perfect") s.doneAt = st.elapsed;
        return true;
      },
      /** 出图用：让某一列「生 → 恰好 → 落在盘上」一步到位（不推进时间）*/
      plateNow: function (stationIdx) {
        var st = curState(); if (!st) return false;
        var s = stationByIdx(st, stationIdx); if (!s) return false;
        if (!s.food) return false;
        s.t = FOOD[s.food].dur * 1000; s.state = "perfect";
        return takePlate(st, stationIdx);
      },
      /** 出图 / 测试用：把某一列的盘直接推到「糊」（过火计时走完）*/
      burnPlate: function (stationIdx) {
        var st = curState(); if (!st) return false;
        var k = plateIdxOfStation(st, stationIdx); if (k < 0) return false;
        var p = st.plates[k];
        p.at = st.elapsed - (SERVE_WINDOW + 0.01);
        refreshPlate(st, p);
        step(st, 0);                                        // 让 step 里的「过火 → 糊」结算跑一次
        return st.plates[k] ? st.plates[k].state === "burnt" : false;
      },
      /** 出图 / 测试用：把某位顾客的订单**一次补齐**（不推进时间），用于验「全部拿到 → 满意脸」*/
      serveAll: function (cid) {
        var st = curState(); if (!st) return false;
        var c = null;
        for (var i = 0; i < st.customers.length; i++) if (st.customers[i].id === cid) c = st.customers[i];
        if (!c) return false;
        for (var k = 0; k < c.order.length; k++) {
          if (c.done.indexOf(c.order[k]) < 0) c.done.push(c.order[k]);
        }
        /* 只把订单标记为「全部拿到」——**不置 left**：出图 / 断言要在「满意」那一态停住，
           真实玩法里的离场由 step() 负责（订单完成时才置 left）。这样 happy 头像才抓得到。 */
        if (!c.satisfiedAt) c.satisfiedAt = st.elapsed;
        return true;
      },
      /** 生命周期计数（无头验收用）：escBound/escRemoved 应配平，rafCancelled ≥ 1 表示循环已停 */
      lifecycle: function () {
        return { escBound:lifecycle.escBound, escRemoved:lifecycle.escRemoved,
                 rafCancelled:lifecycle.rafCancelled, disposed:lifecycle.disposed,
                 escActive:!!(inst && inst.escOn), busy:!!inst };
      },
      /** 结算面板的出口按钮（结算前为 null）——浏览器 / 无头 DOM 都取得到 #bfGo */
      goBtn: function () { return inst ? (inst.goBtn || null) : null; },
      /** 音效 / 顾客语音的现场台账（无头验收读它：常量、开关、比例、计数、播放序列）*/
      audio: function () {
        var st = curState();
        return { on:audio.enabled(), key:BF_SOUND_KEY, dir:BF_AUDIO_DIR,
                 tickAt:TICK_AT, tickNear:TICK_NEAR, gapFar:TICK_GAP_FAR, gapNear:TICK_GAP_NEAR,
                 minGap:TICK_MIN_GAP, happyGap:HAPPY_MIN_GAP, slowGap:SLOW_MIN_GAP,
                 vol:audio.vol, files:audio.files,
                 ratio:(st ? Math.round(minPatienceRatio(st) * 1000) / 1000 : null),
                 tickDue:(st ? tickDue(st) : false),
                 ticks:(st && st.audio ? st.audio.ticks : 0),
                 happies:(st && st.audio ? st.audio.happies : 0),
                 slows:(st && st.audio ? st.audio.slows : 0),
                 badge:(inst && inst.drawn) ? (inst.drawn.soundBadge || null) : null,
                 label:soundLabel(),
                 plays:audio.plays(), log:audio.log() };
      },
      /** 开关（浏览器 / 无头都能用；与两个 UI 入口是同一个开关）*/
      setSound: function (b) { return audio.setEnabled(b); },
      toggleSound: function () { return toggleSound(); },
      /** 顶栏音效按钮（#bfSound）与图例徽章的命中框 */
      soundBtn: function () { return inst ? (inst.btnSound || null) : null; },
      soundBox: function () { return soundBox(); },
      /** 清空播放记录（验收每个场景前调一次，读到的序列才是这一段产生的）*/
      clearAudio: function () { audio.clear(); return true; }
    },
    /* ── 贴图相关的测试挂钩（不属规格，页面代码不需要用）───────────────
       __bfIconFlags()  : 读写 FOOD_ICON 的开关（测试用来分别走「图片」与「矢量回退」）
       __bfPreloadIcons(): 按当前 base / 开关重新预加载 9 张并返回统计 */
    __bfIconFlags: function () { return FOOD_ICON; },
    __bfPreloadIcons: function (baseDir) {
      initFoodIcons(baseDir);
      return { base:FOOD_ICON.base, loaded:FOOD_ICON.loaded, failed:FOOD_ICON.failed,
               ready:iconReadyCount(), vector:vectorCount() };
    }
  };
  root.Breakfast = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
