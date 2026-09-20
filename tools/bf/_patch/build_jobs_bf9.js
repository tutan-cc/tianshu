/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9.js — 生成本轮（bf-9）的逐字字面替换作业单

   为什么用「生成器 + JSON」而不是手写 JSON：
     本轮要改 15 处，锚点全是带中文的多行源码片段；手写 JSON 得把换行转义成 \n，
     一处错位就是一次失败的替换。这里用模板字符串写「原文 / 新文」，
     生成器只负责 JSON.stringify —— 人看的是源码样子的文本，机器拿到的是合法 JSON。

   用法：
     node tools/bf/_patch/build_jobs_bf9.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const jobs = [];
/* ⚠ breakfast.js 是 **CRLF** 行尾（实测：3019 个 CRLF + 192 个单独 LF）。
   这里按 LF 写锚点，落盘前统一转成 CRLF —— 否则锚点一次也匹配不上
   （第一次跑就是这么失败的：起始锚出现 0 次）。 */
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
/** 唯一锚点 + 整段替换（from 必须在全文里恰好出现 1 次） */
function J(file, from, text) { jobs.push({ file, from: crlf(from), text: crlf(text) }); }

/* ── ① 9 样食材的时长梯度重做（用户：白粥太慢）────────────────────────── */
J("breakfast.js",
`  var FOOD = {
    congee:   { n:"白粥",   kind:"pot",     dur:5.0, pw:1.2, burn:1.6, c:"#f2ece0" },
    milk:     { n:"热牛奶", kind:"pot",     dur:2.6, pw:0.7, burn:0.9, c:"#eef4ff" },
    soup:     { n:"清汤",   kind:"pot",     dur:3.4, pw:0.9, burn:1.1, c:"#cfe8ff" },
    egg:      { n:"煎蛋",   kind:"griddle", dur:3.0, pw:0.8, burn:1.0, c:"#ffd76e" },
    bacon:    { n:"培根",   kind:"griddle", dur:3.6, pw:0.9, burn:1.2, c:"#ff7d6e" },
    sandwich: { n:"三明治", kind:"griddle", dur:4.4, pw:1.0, burn:1.3, c:"#e0a45c" },
    bun:      { n:"包子",   kind:"steamer", dur:4.0, pw:1.1, burn:1.4, c:"#f7efe1" },
    salad:    { n:"沙拉",   kind:"counter", dur:1.8, pw:0.6, burn:0.8, c:"#7fe08a" },
    juice:    { n:"果汁",   kind:"juicer",  dur:1.5, pw:0.6, burn:0.7, c:"#ffb347" }
  };`,
`  /* ── 火候时长平衡（bf-9：按用户实测「白粥煮的太慢了」重做整条梯度）──────────
     旧值白粥 5.0s。重排原则（不是把白粥一个人改小，而是把 9 样的梯度一起看）：
       · **最长不超过 ~3.6s**：画面上 9 列可以同时开工，但玩家的注意力只够盯 4~5 口锅，
         任何一样超过 3.6s 都会退化成「点完就走 → 回来发现糊了」的纯惩罚；
       · 保留「快 / 中 / 慢」三档可感知：1.2s（果汁）→ 3.4s（白粥），相邻两样至少差 0.2s，
         玩家能凭手感记住「哪样要等多久」；
       · 完美窗口按 25%~50% 的比例给：越快的菜窗口占比越大（短菜容错高，不至于必糊）；
       · 糊的宽限（burn）统一收在 0.7~1.2s：糊得有预警，但拖着不管一定报废。
     新表（dur = 熟 / pw = 完美窗口 / burn = 过火到糊的宽限；糊点 = dur+pw+burn）：
       果汁   1.2 / 0.6 / 0.7 → 糊点 2.5s      沙拉   1.5 / 0.6 / 0.8 → 2.9s
       热牛奶 2.0 / 0.7 / 0.8 → 3.5s           煎蛋   2.2 / 0.7 / 0.9 → 3.8s
       清汤   2.6 / 0.8 / 1.0 → 4.4s           培根   2.8 / 0.8 / 1.0 → 4.6s
       包子   3.0 / 0.9 / 1.1 → 5.0s           三明治 3.2 / 0.9 / 1.1 → 5.2s
       白粥   3.4 / 1.0 / 1.2 → 5.6s（旧：5.0 / 1.2 / 1.6 → 7.8s）
     白粥仍是**最慢**的一样（保留「熬粥要等」的手感），但 5.0 → 3.4s 之后不再拖垮整局节奏。 */
  var FOOD = {
    congee:   { n:"白粥",   kind:"pot",     dur:3.4, pw:1.0, burn:1.2, c:"#f2ece0" },
    milk:     { n:"热牛奶", kind:"pot",     dur:2.0, pw:0.7, burn:0.8, c:"#eef4ff" },
    soup:     { n:"清汤",   kind:"pot",     dur:2.6, pw:0.8, burn:1.0, c:"#cfe8ff" },
    egg:      { n:"煎蛋",   kind:"griddle", dur:2.2, pw:0.7, burn:0.9, c:"#ffd76e" },
    bacon:    { n:"培根",   kind:"griddle", dur:2.8, pw:0.8, burn:1.0, c:"#ff7d6e" },
    sandwich: { n:"三明治", kind:"griddle", dur:3.2, pw:0.9, burn:1.1, c:"#e0a45c" },
    bun:      { n:"包子",   kind:"steamer", dur:3.0, pw:0.9, burn:1.1, c:"#f7efe1" },
    salad:    { n:"沙拉",   kind:"counter", dur:1.5, pw:0.6, burn:0.8, c:"#7fe08a" },
    juice:    { n:"果汁",   kind:"juicer",  dur:1.2, pw:0.6, burn:0.7, c:"#ffb347" }
  };`);

/* ── ② 部分上餐加耐心的常量 ─────────────────────────────────────────── */
J("breakfast.js",
`  var MAX_CUSTOMERS = 3;    // 同时最多 3 位`,
`  var MAX_CUSTOMERS = 3;    // 同时最多 3 位
  /* ── 部分上餐：顾客收到「订单里的某一样」→ 耐心回一点（bf-9 用户要求）────────
     用户原话：「客户要三种早餐，他收到其中某一种的时候，耐心等候的时间会稍微增加」。
     规则三条（都有断言）：
       ① 只有**这一样确实在他订单里、而且他还没拿到过**才加；
          上错菜 / 糊菜在 serveFoodToCustomer 的前两个分支就 return 了，走不到加成那一步
          —— 乱上菜没有奖励；
       ② 每成功送到一样 +PARTIAL_PATIENCE_BONUS 秒（只在**还没拿齐**时加：
          拿齐的那位马上离场，给他加耐心没有意义）；
       ③ **上限 = 他的初始耐心 patienceMax**：不能靠一样一样地送无限续命。
          已经顶到初始值（或只剩一点余量）时，多出来的部分直接截掉 —— 到顶就加 0。
     取 3.5s 的理由：一轮「下锅 → 熟 → 落盘 → 上餐」大约 2~4s，3.5s 刚好抵消掉一次操作，
     让「一次招待三位、先给每人一样」成为**正收益**的打法；再多（≥5s）就会让三家同时
     顶满耐心、把「顾客会走」这条压力整个抹掉。 */
  var PARTIAL_PATIENCE_BONUS = 3.5;   // 每送到一样（订单还没齐）回多少秒耐心`);

/* ── ③ 上餐选人：统一口径（三级排序）─────────────────────────────────── */
J("breakfast.js",
`  /** 单击盘时「自动挑顾客」（要求 A3）：在正等着这份、且还没拿到这份的顾客里，
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
  }`,
`  /* ── 上餐选人：**全项目唯一口径**（bf-9 用户要求）─────────────────────────
     用户原话：「做好的早餐会优先给耐心值最低的客人，而不是只能给第一位客人」。

     【排查结论（改前）】三条上餐路径当时分别是什么策略：
       · 单击某一列专属盘 serveFromColumn()      → 已经走 pickCustomerIndexFor（比**绝对秒数**最小）
       · 锅里现做、取出即送 takeReady()          → 也走同一个函数（注释里写着"以前另写了一段
                                                  先来先得的 first-fit，已改"）
       · 点顾客卡 actCustomer()                  → 玩家**明确点谁就给谁**（这是选择，不是自动挑人）
       · 「拖拽上餐」这条路径**根本不存在**：能拖的只有底部食材桶 → 中间的锅（onDown/onUp），
         盘子没有拖拽（所以也没有"拖到谁身上"这回事）。
     也就是说：规则层写的确实是"绝对耐心最少"，但**手感上就等于"只给第一位"** ——
     因为所有顾客的耐心都按 1 秒/秒 掉，先来的人天然秒数最少（订单长度只影响初始上限）。
     两个量在玩家眼里是分开的：卡上画的那条进度条、闪红、滴答、着急脸，用的都是**比例**
     （patienceRatioOf），而绝对秒数只有内部在看。于是"第一位"和"进度条最短的那位"
     经常不是同一个人 —— 这正是用户看到的现象。

     【新口径（候选集内三级排序，全部可断言）】
       候选集 = 订单里有这一样 ∧ 这一样还没拿到 ∧ 没走 ∧ 没生气
       ① 【救命档】绝对秒数 ≤ SERVE_DANGER_SEC 的候选 → 先排（真的要走了），档内比绝对秒数；
       ② 【看着最急档】其余候选 → 比**耐心剩余比例**（玩家眼里的「耐心值最低」就是它），
          最小的先得；
       ③ 平手 → 绝对秒数更小的先得；再平手 → 座位序（先来的先得）。
     为什么保留①这一档：只按比例挑，可能挑走一位订单长（上限高）的顾客，
     而另一位订单短的顾客其实马上要走 —— 那是白送 −8 分。救命档把这种亏兜住。
     三条路径共用这一个函数，不再各写一份（老版本就是这么分叉出"先来先得"的）。*/
  var SERVE_DANGER_SEC = 6.0;   // 剩这么少秒数 → 越过比例，绝对优先（可调）

  /** 候选顾客在 st.customers 里的下标（正需要这份、还没拿到、还没走），按座位序 */
  function serveCandidates(st, foodId) {
    var out = [];
    if (!st || !st.customers) return out;
    for (var i = 0; i < st.customers.length; i++) {
      var c = st.customers[i];
      if (!c || c.left || c.angry) continue;
      if (!isFoodInOrder(c.order, foodId)) continue;
      if (c.done.indexOf(foodId) >= 0) continue;
      out.push(i);
    }
    return out;
  }
  function patOf(c) { var p = Number(c && c.patience); return isFinite(p) ? p : 0; }
  /** 三级排序键的两两比较（数组按位比，带浮点容差）*/
  function keyLess(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] < b[i] - 1e-9) return true;
      if (a[i] > b[i] + 1e-9) return false;
    }
    return false;
  }
  /** 挑顾客：返回 st.customers 下标，没人要返回 -1（规则见上）*/
  function pickServeTarget(st, foodId) {
    var cands = serveCandidates(st, foodId);
    if (!cands.length) return -1;
    var best = -1, bestKey = null;
    for (var k = 0; k < cands.length; k++) {
      var i = cands[k], c = st.customers[i];
      var pat = patOf(c), ratio = patienceRatioOf(c);
      var danger = (pat <= SERVE_DANGER_SEC + 1e-9) ? 0 : 1;   // 0 = 救命档，排在前面
      var key = [danger, danger === 0 ? pat : ratio, pat, i];
      if (!bestKey || keyLess(key, bestKey)) { bestKey = key; best = i; }
    }
    return best;
  }
  /** 兼容旧名字（单测 / 无头验收 / debug.pickFor 都读它）：语义 = pickServeTarget */
  function pickCustomerIndexFor(st, foodId) { return pickServeTarget(st, foodId); }`);

/* ── ④ 部分上餐加耐心（记账 + 函数本体）────────────────────────────────── */
J("breakfast.js",
`  /** 出餐记账核心（盘上出餐与现做灶位出餐共用一套规则）：`,
`  /** 部分上餐的耐心加成（bf-9 用户要求）：成功送到一样、且他还没拿齐 → +N 秒，
      但**绝不超过他的初始耐心**（patienceMax）。返回**真实加了多少秒**（已经到顶就是 0），
      调用方把它记进出餐结果里，方便断言与 UI 提示。 */
  function givePartialPatience(st, c) {
    if (!c) return 0;
    var max = Number(c.patienceMax); if (!isFinite(max) || max <= 0) max = 0.01;
    var cur = Math.max(0, patOf(c));
    var add = Math.min(PARTIAL_PATIENCE_BONUS, Math.max(0, max - cur));
    if (add > 0) c.patience = cur + add;
    c.patienceBonus = round1((c.patienceBonus || 0) + add);      // 这位顾客累计收到多少加成
    if (st) {
      st.partialServes = (st.partialServes || 0) + 1;            // 记一次"部分上餐"
      st.partialBonus = round1((st.partialBonus || 0) + add);    // 本局一共回了多少秒
      if (add > 0) addFloat(st, "还差 " + remainOf(c) + " 样 · 耐心 +" + round1(add) + "s", PAL.green, 22);
    }
    return add;
  }
  /** 出餐记账核心（盘上出餐与现做灶位出餐共用一套规则）：`);

J("breakfast.js",
`    if (remainOf(c) <= 0) {
      var allPerfect = true;`,
`    /* ③ 还没拿齐 → 收到「其中某一样」也给点甜头（bf-9 用户要求）：
       耐心 +PARTIAL_PATIENCE_BONUS，但上限是他**初始耐心**（givePartialPatience 里截断）。
       位置有意放在这里：上错菜 / 糊菜在上面两个分支就 return 了，走不到这一行；
       而已经拿齐的那位马上要离场，也不必再加耐心。 */
    var partialBonus = (remainOf(c) > 0) ? givePartialPatience(st, c) : 0;
    if (remainOf(c) <= 0) {
      var allPerfect = true;`);

J("breakfast.js",
`    return { ok:true, kind: perfect ? (tier === "hot" ? "perfect-hot" : "perfect") : "over",
             food:foodId, state:foodState, heat:tier, delta:d, perfect:perfect, cookSec:cookSec, customer:c };`,
`    return { ok:true, kind: perfect ? (tier === "hot" ? "perfect-hot" : "perfect") : "over",
             food:foodId, state:foodState, heat:tier, delta:d, perfect:perfect, cookSec:cookSec, customer:c,
             partialBonus:partialBonus, patience:Math.round(c.patience * 100) / 100 };`);

/* ── ⑤ 下锅那一刻触发烹饪音效 ─────────────────────────────────────────── */
J("breakfast.js",
`    st.made++;
    st.selected = { kind:"station", idx:si };`,
`    st.made++;
    /* 下锅那一刻的音效（bf-9 用户要求：「点做果汁的时候触发榨果汁的音效，
       点煎蛋的时候触发煎蛋的音效」）。触发点**就在这里** —— 料真的进了锅那一瞬间；
       不是出锅、不是上餐，也不是被拒的时候（锅忙 / 盘占用 / 拖错列在上面就 return 了）。
       同一食材 300ms 内只响一次、不同食材最多叠 2 条、音量 / 🔊🔇 开关 / 四级静默回落
       全部走既有的 audio 通道（见 playCook）。 */
    playCook(st, foodId);
    st.selected = { kind:"station", idx:si };`);

/* ── ⑥ 音效表：happy 六条变体 + 9 条下锅音效 ─────────────────────────── */
J("breakfast.js",
`  var BF_SFX_VOL = { tick:0.35, happy:0.55, slow:0.55 };   // 音量（滴答压低，别吵）
  var BF_SFX_FILES = {
    tick:  ["tick.mp3"],
    happy: ["happy.mp3", "happy2.mp3", "happy3.mp3"],      // 变体：随机取，且不连着重复同一条
    slow:  ["slow.mp3"]
  };
  var AUDIO_NAMES = ["tick", "happy", "slow"];`,
`  var BF_SFX_VOL = {
    tick:0.35, happy:0.55, slow:0.55,                      // 滴答压低，别吵；两条语音适中
    /* 下锅音效（bf-9）：9 样食材各一条。素材侧已经统一到 -18 LUFS，
       这里再按"吵不吵"微调：榨汁机 / 培根油花这类宽频噪声压到 0.42~0.45，
       闷响类（白粥 / 蒸笼 / 砧板）给 0.50，煎蛋那记"滋啦"最提神给 0.55。 */
    cook_congee:0.50, cook_milk:0.45, cook_soup:0.45, cook_egg:0.55, cook_bacon:0.42,
    cook_sandwich:0.45, cook_bun:0.50, cook_salad:0.50, cook_juice:0.42
  };
  /* 每样食材 → 它下锅时该响的那条音效（一对一，用户要求的"点果汁响榨汁机"就靠这张表）。
     文件都在 audio/bf/，由 tools/audio/gen_bf_cook_sfx.py 合成（纯标准库 DSP + ffmpeg 加工）。*/
  var BF_COOK_FILES = {
    congee:  "cook_congee.mp3",    // 白粥：下米的沉闷一声 + 搅动
    milk:    "cook_milk.mp3",      // 热牛奶：倒奶的注流声
    soup:    "cook_soup.mp3",      // 清汤：汤水入锅的咕咚
    egg:     "cook_egg.mp3",       // 煎蛋：磕蛋 + 下油锅的滋啦
    bacon:   "cook_bacon.mp3",     // 培根：持续滋滋 + 油花爆裂
    sandwich:"cook_sandwich.mp3",  // 三明治：上烤盘的闷响 + 炙烤
    bun:     "cook_bun.mp3",       // 包子：笼盖轻磕 + 蒸汽
    salad:   "cook_salad.mp3",     // 沙拉：砧板上快切三下
    juice:   "cook_juice.mp3"      // 果汁：榨汁机电机嗡鸣
  };
  var BF_SFX_FILES = {
    tick:  ["tick.mp3"],
    /* 「拿到早餐」的欢呼（bf-9 重做）：6 条**实测上扬**的变体，随机取、且不连着重复同一条。
       用户挑定之后只留一条即可（单条时 pick() 恒返回 0，不再随机）：
         happy: ["happy_v3.mp3"]                                        */
    happy: ["happy_v1.mp3", "happy_v2.mp3", "happy_v3.mp3",
            "happy_v4.mp3", "happy_v5.mp3", "happy_v6.mp3"],
    slow:  ["slow.mp3"]
  };
  /* 下锅通道：名字统一是 cook_<食材id>，一个通道一个文件（挂进同一张表 → 开关 / 回落 / 台账全复用）*/
  function cookChannel(foodId) { return BF_COOK_FILES[foodId] ? ("cook_" + foodId) : ""; }
  (function () {
    for (var f in BF_COOK_FILES) if (Object.prototype.hasOwnProperty.call(BF_COOK_FILES, f))
      BF_SFX_FILES[cookChannel(f)] = [BF_COOK_FILES[f]];
  })();
  var AUDIO_NAMES = ["tick", "happy", "slow",
                     "cook_congee", "cook_milk", "cook_soup", "cook_egg", "cook_bacon",
                     "cook_sandwich", "cook_bun", "cook_salad", "cook_juice"];`);

/* ── ⑦ play() 支持"记一条被节流掉的记录" ─────────────────────────────── */
J("breakfast.js",
`    function play(name, at) {
      if (!BF_SFX_FILES[name]) return null;
      var i = pick(name);
      if (!enabled()) return rec(name, i, false, "off", at);`,
`    function play(name, at, skipWhy) {
      if (!BF_SFX_FILES[name]) return null;
      var i = pick(name);
      /* skipWhy：调用方主动放弃这一声（节流 / 并发满了）→ 只留一条可诊断的记录，不发声。
         为什么要有这条：下锅音效连续快点时不节流的实测效果是"糊成一片噪音"，
         而"静默丢掉"又会让验收看不出差别（跟素材缺失长得一样）。 */
      if (skipWhy) return rec(name, i, false, skipWhy, at);
      if (!enabled()) return rec(name, i, false, "off", at);`);

/* ── ⑧ 每局的音频台账：下锅音效的节流 / 并发状态 ───────────────────────── */
J("breakfast.js",
`    return { tickNext:0, lastTickAt:-1e9, lastHappyAt:-1e9, lastSlowAt:-1e9,
             ticks:0, happies:0, slows:0 };`,
`    return { tickNext:0, lastTickAt:-1e9, lastHappyAt:-1e9, lastSlowAt:-1e9,
             ticks:0, happies:0, slows:0,
             /* 下锅音效（bf-9）：每样食材上一次响的时刻（同一食材 300ms 节流）+
                当前"占线"的几条（不同食材可叠，但同时最多 2 条）*/
             cookLast:{}, cookPlaying:[], cooks:0, cookSkips:0 };`);

/* ── ⑨ playCook：下锅音效的节流 + 并发上限 ───────────────────────────── */
J("breakfast.js",
`  /** 等太久走掉 → 「哼，太慢了」（同一帧多人离开也只播一次）*/
  function playSlow(st) {
    if (!st || !st.audio) return null;
    var a = st.audio;
    if (st.elapsed - a.lastSlowAt < SLOW_MIN_GAP) return null;
    a.lastSlowAt = st.elapsed; a.slows++;
    return audio.play("slow", st.elapsed);
  }`,
`  /** 等太久走掉 → 「哼，太慢了」（同一帧多人离开也只播一次）*/
  function playSlow(st) {
    if (!st || !st.audio) return null;
    var a = st.audio;
    if (st.elapsed - a.lastSlowAt < SLOW_MIN_GAP) return null;
    a.lastSlowAt = st.elapsed; a.slows++;
    return audio.play("slow", st.elapsed);
  }

  /* ── 下锅音效（bf-9 用户要求：点食材进锅的那一刻，按食材触发）──────────────
     两条纪律，都是实测出来的（连续快点 9 个桶，不节流会糊成一片噪音）：
       · **同一食材 300ms 内只响一次**（COOK_MIN_GAP）—— 手抖连点同一样不出双重声；
       · **不同食材可以叠，但同时最多 2 条**（COOK_MAX_CONCURRENT）—— 保留下锅的"手感密度"，
         又不至于 9 条一起炸。
     被节流 / 并发满时不发声，但**留一条 why:"throttle" / "busy" 的记录**（验收与排查要看）。
     开关关掉（why:"off"）/ 没有 Audio（"no-audio"）/ play 被拦（"blocked"）
     依旧走 audio.play 那套四级静默回落，玩法与得分完全不受影响。 */
  var COOK_MIN_GAP = 0.30;          // 同一食材的最小间隔（秒）
  var COOK_MAX_CONCURRENT = 2;      // 同时最多几条下锅音效
  var COOK_TAIL_SEC = 0.70;         // 一条音效"占线"多久（素材 0.42~0.66s，取 0.70 兜住）

  /** 点食材下锅 → 按食材响对应的音效。返回 audio 记录（被节流时 ok:false）。 */
  function playCook(st, foodId) {
    if (!st || !st.audio) return null;
    var ch = cookChannel(foodId);
    if (!ch) return null;
    var a = st.audio, at = st.elapsed;
    if (!a.cookLast) a.cookLast = {};
    if (!a.cookPlaying) a.cookPlaying = [];
    var last = a.cookLast[foodId];
    if (typeof last === "number" && at - last < COOK_MIN_GAP - 1e-9) {
      a.cookSkips = (a.cookSkips || 0) + 1;
      return audio.play(ch, at, "throttle");
    }
    /* 清掉已经播完的占线（按时间戳判，不依赖任何定时器）*/
    var live = [];
    for (var i = 0; i < a.cookPlaying.length; i++)
      if (a.cookPlaying[i].until > at) live.push(a.cookPlaying[i]);
    a.cookPlaying = live;
    if (a.cookPlaying.length >= COOK_MAX_CONCURRENT) {
      a.cookSkips = (a.cookSkips || 0) + 1;
      return audio.play(ch, at, "busy");
    }
    a.cookLast[foodId] = at;
    a.cookPlaying.push({ ch:ch, food:foodId, until:at + COOK_TAIL_SEC });
    a.cooks = (a.cooks || 0) + 1;
    return audio.play(ch, at);
  }`);

/* ── ⑩ 规则层导出（音效侧）───────────────────────────────────────────── */
J("breakfast.js",
`    TICK_MIN_GAP:TICK_MIN_GAP, HAPPY_MIN_GAP:HAPPY_MIN_GAP, SLOW_MIN_GAP:SLOW_MIN_GAP,
    SOUND_KEY:BF_SOUND_KEY, DIR:BF_AUDIO_DIR, FILES:BF_SFX_FILES, VOL:BF_SFX_VOL, NAMES:AUDIO_NAMES,`,
`    TICK_MIN_GAP:TICK_MIN_GAP, HAPPY_MIN_GAP:HAPPY_MIN_GAP, SLOW_MIN_GAP:SLOW_MIN_GAP,
    COOK_MIN_GAP:COOK_MIN_GAP, COOK_MAX_CONCURRENT:COOK_MAX_CONCURRENT, COOK_TAIL_SEC:COOK_TAIL_SEC,
    COOK_FILES:BF_COOK_FILES, cookChannel:cookChannel, playCook:playCook,
    SOUND_KEY:BF_SOUND_KEY, DIR:BF_AUDIO_DIR, FILES:BF_SFX_FILES, VOL:BF_SFX_VOL, NAMES:AUDIO_NAMES,`);

/* ── ⑪ 规则层导出（选人 / 耐心侧）────────────────────────────────────── */
J("breakfast.js",
`    pickCustomerIndexFor: pickCustomerIndexFor, pickPlateIndex: pickPlateIndex,`,
`    pickCustomerIndexFor: pickCustomerIndexFor, pickServeTarget: pickServeTarget,
    serveCandidates: serveCandidates, SERVE_DANGER_SEC: SERVE_DANGER_SEC,
    PARTIAL_PATIENCE_BONUS: PARTIAL_PATIENCE_BONUS, givePartialPatience: givePartialPatience,
    pickPlateIndex: pickPlateIndex,`);

/* ── ⑫ 新局状态：部分上餐的计数 ───────────────────────────────────────── */
J("breakfast.js",
`      served:0, perfect:0, normal:0, hot:0, burnt:0, burntServed:0, wrong:0, angry:0, made:0,`,
`      served:0, perfect:0, normal:0, hot:0, burnt:0, burntServed:0, wrong:0, angry:0, made:0,
      partialServes:0, partialBonus:0,          // 部分上餐：次数 / 一共回给顾客多少秒耐心
      cooks:0,                                  // 本局触发过多少次下锅音效`);

/* ── ⑬ debug.state()：把本轮新增的量暴露给无头 / 真浏览器验收 ─────────── */
J("breakfast.js",
`          prepped:st.prepped, autoPlate:!!st.cfg.autoPlate, plateCount:st.plates.length,`,
`          prepped:st.prepped, autoPlate:!!st.cfg.autoPlate, plateCount:st.plates.length,
          partialServes:st.partialServes || 0, partialBonus:Math.round((st.partialBonus || 0) * 10) / 10,
          partialBonusPer:PARTIAL_PATIENCE_BONUS, serveDangerSec:SERVE_DANGER_SEC,`);

/* ── ⑭ debug.audio()：下锅音效的台账 ─────────────────────────────────── */
J("breakfast.js",
`                 ticks:(st && st.audio ? st.audio.ticks : 0),
                 happies:(st && st.audio ? st.audio.happies : 0),
                 slows:(st && st.audio ? st.audio.slows : 0),`,
`                 ticks:(st && st.audio ? st.audio.ticks : 0),
                 happies:(st && st.audio ? st.audio.happies : 0),
                 slows:(st && st.audio ? st.audio.slows : 0),
                 cooks:(st && st.audio ? (st.audio.cooks || 0) : 0),
                 cookSkips:(st && st.audio ? (st.audio.cookSkips || 0) : 0),
                 cookPlaying:(st && st.audio && st.audio.cookPlaying) ? st.audio.cookPlaying.length : 0,
                 cookFiles:BF_COOK_FILES, cookGap:COOK_MIN_GAP, cookMax:COOK_MAX_CONCURRENT,`);

/* ── ⑮ 顶栏提示文案：说清"送给谁" ─────────────────────────────────────── */
J("breakfast.js",
`      "① 点食材 → 自动进它正上方那一列的锅 ｜ ② 点上方专属盘 → 自动送给正在等的顾客（优先最急的） ｜ " +`,
`      "① 点食材 → 自动进它正上方那一列的锅 ｜ ② 点上方专属盘 → 自动送给最急的顾客（耐心最少 / 快走的那位优先） ｜ " +`);

fs.writeFileSync(path.join(__dirname, "jobs_bf9.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9.json：" + jobs.length + " 个 job");
jobs.forEach((j, i) => console.log("  #" + (i + 1) + " " + j.file +
  "  锚 " + j.from.split("\n")[0].slice(0, 44) + "…"));
