/* ═══════════════════════════════════════════════════════════════════════════
   mk_bf14_jobs.js — bf-14「锅内限时起锅」第一轮：生成 breakfast.js 的逐字替换 job
   用法：node tools/bf/_patch/mk_bf14_jobs.js
         node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf14.json
   规格（用户原话）：
     「餐盘可以一直放着，锅里也可以同时煮着，但是锅里的熟了必须在规定时间内起锅啊，
       如果备用餐盘里放着，锅里要起锅的没地方放就只能糊掉，然后想再使用锅，
       就要双击扔掉里面的食物」
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const T = [], jobs = [];
function job(name, file, from, to, text) {
  T.push({ name: name, text: text });
  jobs.push({ file: file, from: from, to: to || undefined, textFile: "tools/bf/_patch/bf14_" + name + ".txt" });
}

/* ── J1 头部玩法规格 2)（含 3) 的首行，避免吃掉它） ─────────────────────── */
job("h_rule2", "breakfast.js",
`   2) 「熟了之后点一下就可以给顾客」：完美窗口一到自动落到本列专属盘；
      单击该盘 → 自动送给「正在需要这份、且耐心最少」的顾客；
      此刻没人需要 → 不消耗、留在盘上（盘上永久保鲜，没有任何倒计时）并提示「现在没人要这份」。`,
`   3) 「点两下是扔进垃圾桶」：双击盘（或双击锅内成品）→ 丢垃圾桶，清空锅与盘，不扣分。`,
`   2) 「锅里熟了必须在规定时间内起锅」（bf-14 用户要求）：完美一到**不再自动落盘**，
      锅内立刻进入 SERVE_WINDOW 秒的「起锅窗口」（火候暂停 + 倒计时环）：
        · 窗口内**单击锅** = 起锅 → 落进本列专属盘（盘上从此永久保鲜）；
        · 该列盘里已经有一份（「备用餐盘里放着」）→ 没地方放：提示「盘里还有一份，先送出去」，
          窗口**继续走**，走完这份就糊在锅里（这是本作唯一的报废来源）；
        · 糊了 → 这口锅被那份占死，**双击锅（或该列盘）丢掉**才能再用（不扣分）。
      单击盘 → 自动送给「正在需要这份、且耐心最少」的顾客；
      此刻没人需要 → 不消耗、留在盘上（盘上永久保鲜，没有任何倒计时）并提示「现在没人要这份」。
      ⚠ 与 bf-3 的**有意改动**：盘里有一份时**允许继续下锅**（用户原话「餐盘可以一直放着，
      锅里也可以同时煮着」）—— 否则「起锅没地方放 → 糊」这条规则永远触发不到。
   3) 「点两下是扔进垃圾桶」：双击盘（或双击锅内成品）→ 丢垃圾桶，清空锅与盘，不扣分。`);

/* ── J2 头部 4) 里的压力说明（连 5) 的首行一起保留） ────────────────────── */
job("h_rule4", "breakfast.js",
`      压力全部留在锅里（生 → 恰好 → 过火 → 糊），见上面那条火候状态机。`,
`   5) 顾客陆续进店（同时最多 3 位），每位 1–3 样早餐；订单卡有耐心倒计时条`,
`      压力全部留在锅里（生 → 恰好 → **限时起锅** → 糊），见上面那条火候状态机与第 2) 条。
   5) 顾客陆续进店（同时最多 3 位），每位 1–3 样早餐；订单卡有耐心倒计时条`);

/* ── J3 头部 6) 糊残骸不再自动清（连 7) 的首行一起保留） ────────────────── */
job("h_rule6", "breakfast.js",
`   6) 糊菜端给顾客 → 该顾客直接不满离开（扣分）；糊掉的可丢垃圾桶（不扣分，只浪费时间；
      **锅里**的糊残骸留 14 秒自动清 —— 盘上不会自动清，放多久都还在）`,
`   7) 规定时间内（默认 75s）服务满 N 位（默认 8 位）即通过，否则失败`,
`   6) 糊菜端给顾客 → 该顾客直接不满离开（扣分）；糊掉的可丢垃圾桶（不扣分，只浪费时间；
      **锅里**的糊残骸**不再自动清**（bf-14：以前 14 秒自动消失 → 现在必须双击 ——
      用户原话「想再使用锅，就要双击扔掉里面的食物」）；盘上更不会自动清，放多久都还在）
   7) 规定时间内（默认 75s）服务满 N 位（默认 8 位）即通过，否则失败`);

/* ── J4 常量块（起锅窗口 / 糊不再自动清 / 新文案） ───────────────────────── */
job("const", "breakfast.js",
`  /* ── 盘上永久保鲜（bf-13 用户要求）────────────────────────────────────────`,
`  var BURNT_LIFE_MS = 14000;// 烧糊的残骸在**锅里**留 14 秒自动清（盘上不会自动清：盘上放多久都在）`,
`  /* ── 锅内「限时起锅」（bf-14 用户要求）────────────────────────────────────
     用户原话：「餐盘可以一直放着，锅里也可以同时煮着，但是锅里的熟了必须在规定时间内起锅啊，
               如果备用餐盘里放着，锅里要起锅的没地方放就只能糊掉，然后想再使用锅，
               就要双击扔掉里面的食物」。
     「锅」与「盘」是两套完全独立的规则：
       · 盘（做好的那份）＝ **永久保鲜**（bf-13 原样保留）：落盘那一刻是什么档就永远是什么档
         （完美份恒为「热乎」14 分），没有倒计时、不会凉、不会糊、不会自己消失。
       · 锅（烹饪 + 起锅）＝ 本作**唯一的压力点**：
           t < dur            生     —— 点食材下锅，烧着
           dur..dur+pw        恰好   —— **立刻进入「起锅窗口」**（火候暂停，倒计时 SERVE_WINDOW 秒）
           窗口内单击锅        起锅   —— 落进该列专属盘（盘上从此永久保鲜）
           窗口走完还没起锅    糊     —— st.burnt++ / st.expire++，锅被这份占死
           糊了之后            **必须双击锅（或该列盘）丢掉**才能再用这口锅（不扣分）
       · 该列盘里已经有一份 → 起锅**没地方放**：提示「盘里还有一份，先送出去」，
         窗口**继续走**（不暂停、不宽限）→ 走完就糊。这正是用户那句「没地方放就只能糊掉」。
     为什么窗口内要「暂停火候」：不然窗口会被完美窗口 pw（0.6~1.0s）提前吃掉，
     「规定时间内起锅」会变成「1 秒内起锅」；把火候按住，SERVE_WINDOW 才是玩家真正拥有的秒数
     （旧的 openServeWindow 就是按这个思路写的，这里沿用同一手法，并把窗口接到**每一列**上）。
     两个如实记录的副作用：
       ① 默认玩法下「过火」这一档不再出现（完美一到就定格等人起锅）；cookState() 的四段曲线
          **一个字都没改**，「按住看火」（manual / setCook / debug.place）那条路照样能完整看到
          生 → 恰好 → 过火 → 糊（单测仍在验它）；
       ② autoPlate（熟了自动落盘）**默认关**：它是 bf-3 起的旧规则，现在只剩「显式传
          autoPlate:true」这一条调试 / 老回归通道，页面（index.html 从不传它）永远走不到。 */
  var SERVE_WINDOW = 4.5;                    // 锅内**起锅窗口**（秒）：锅里熟了必须在这段时间内起锅
  var SERVE_WARN_SEC = 1.0;                  // 窗口最后一秒：倒计时环红闪
  var HEAT = {
    hotSec: SERVE_WINDOW / 3, warmSec: SERVE_WINDOW * 2 / 3, coldSec: SERVE_WINDOW,
    hot: 14, warm: 10, cold: 6,
    overPenalty: -3
  };
  var HOT_MS = HEAT.hotSec * 1000;   // 兼容旧字段名：热乎窗口（毫秒）
  /* 锅内糊了之后**不再自动清**（bf-14）：用户要求「想再使用锅，就要双击扔掉里面的食物」。
     BURNT_LIFE_MS 保留常量名（旧调用方 / 老报告还在读它），但 bf-14 起 step() 不再用它。 */
  var PAN_BURNT_STICKY = true;               // 糊的锅只能靠玩家双击清（不自动清、不过期）
  var BURNT_LIFE_MS = 14000;                 // 兼容保留：bf-13 及以前「锅内残骸 14 秒自动清」
  /* 锅内三句状态文案（规则层与 UI 同源，测试直接读常量断言）*/
  var PAN_PICK_TEXT = "恰好 · 起锅";          // 锅里刚好（窗口内）那行字
  var PAN_BLOCKED_TEXT = "盘占着 · 没地方放"; // 盘被占 → 起锅没地方放（窗口继续走 → 最终糊）
  var PAN_BURNT_TEXT = "糊了 · 双击丢掉";     // 糊锅那行字（必须双击才清）`);

/* ── J5 盘上永久保鲜常量注释里的「压力」一句 ─────────────────────────────── */
job("plate_note", "breakfast.js",
`     压力只留在锅里（忘出锅 → 糊），盘上不再承担任何计时压力。 */`,
`  var PLATES_TOTAL = COL_N;                  // 盘数 = 列数 = 9`,
`     压力只留在锅里（**限时起锅**：窗口内没起锅 → 糊），盘上不承担任何计时压力。 */
  var PLATES_TOTAL = COL_N;                  // 盘数 = 列数 = 9`);

/* ── J6 isServeWindowOpen ───────────────────────────────────────────────── */
job("iswin", "breakfast.js",
`  /** 出餐窗口（旧机制的兼容保留）：现在食物一到「恰好」就自动落到专属盘，
      锅内窗口不再打开，所以这个判定恒为 false；纯函数保留给单测 / 旧调用方。 */
  function isServeWindowOpen(s) { return !!(s && s.food && s.state === "perfect" && (s.serveWin || 0) > 0); }`,
null,
`  /** 锅内「起锅窗口」是否开着（bf-14 起这条路径**每一列都会真的走**）：
      锅里一到「恰好」→ 开窗 SERVE_WINDOW 秒，期间火候暂停（这才是玩家真正能用的起锅时间）；
      窗口内单击锅 = 起锅落盘；窗口走完还没起锅 = 这份糊在锅里（必须双击才清）。 */
  function isServeWindowOpen(s) { return !!(s && s.food && s.state === "perfect" && (s.serveWin || 0) > 0); }`);

/* ── J7 newState：autoPlate 默认关 ──────────────────────────────────────── */
job("newstate", "breakfast.js",
`             /* 自动落盘（要求 A3：熟了自动落到本列专属盘）——
                bf-3 起这是核心规则，所以默认打开；显式传 autoPlate:false 才关掉
                （关掉是「按住看火」的调试手感：食物留在锅里，手动 takePlate 才落盘）。 */
             autoPlate: cfg.autoPlate !== false,`,
null,
`             /* 熟了**不再**自动落盘（bf-14 用户要求「锅里熟了必须在规定时间内起锅」）：
                默认关闭，而且**不传这个参数时也是关闭**（页面 / index.html 从不传它，
                所以玩家那一侧永远走「限时起锅」）。只有显式传 autoPlate:true 才回到旧口径
                （调试 / 老回归用：一到「恰好」同帧落盘，锅内不开窗口）。 */
             autoPlate: cfg.autoPlate === true,`);

/* ── J8 stationFree：盘占着也能下料 ─────────────────────────────────────── */
job("stationfree", "breakfast.js",
`  /** 灶位是否空着可用（锅空 + 本列的专属盘也空）—— 盘占着就不能再下料 */
  function stationFree(st, stationIdx) {
    var s = stationByIdx(st, stationIdx);
    if (!s || s.food) return false;
    if (isServeWindowOpen(s)) return false;
    return plateIdxOfStation(st, stationIdx) < 0;
  }`,
null,
`  /** 灶位是否空着可用 —— bf-14 起**只看锅**：锅里没东西（也没有起锅窗口）就能下料。
      盘占着也允许下料（用户原话「餐盘可以一直放着，锅里也可以同时煮着」）——
      代价是这份熟了**没地方起锅**：窗口内点锅会被拒（plate-occupied），窗口走完就糊。 */
  function stationFree(st, stationIdx) {
    var s = stationByIdx(st, stationIdx);
    if (!s || s.food) return false;
    if (isServeWindowOpen(s)) return false;
    return true;
  }`);

/* ── J9 placeFoodEx：删掉「盘占着不准下料」 ─────────────────────────────── */
job("place", "breakfast.js",
`    if (s.food) return no("station-occupied");                 // 锅里还在做：生的 / 熟的 / 糊的残骸
    if (plateIdxOfStation(st, si) >= 0) return no("plate-occupied");   // 本列盘里还有一份 → 不准再下料`,
null,
`    if (s.food) return no("station-occupied");                 // 锅里还在做：生的 / 熟的 / 糊的残骸
    /* bf-14：本列盘里还有一份**也允许下料**（用户原话「餐盘可以一直放着，锅里也可以同时煮着」）。
       这份熟了会没地方起锅 → 窗口内点锅被拒（plate-occupied）→ 窗口走完糊在锅里。
       原因码 plate-occupied 因此从「下料被拒」搬到了「起锅被拒」（见 takeOut）。 */`);

/* ── J10 takePlate 注释（连「糊盘唯一来源」那行一起替换） ───────────────── */
job("takeplate_doc", "breakfast.js",
`  /** 手动出餐：把锅里做好的食物拾到它自己的专属盘上（自动落盘模式下由 step 代劳）。
      每列都有盘（要求 A5），所以任何一列都能落盘。
      注意：这里**也接糊的份**（s.state === "burnt" 时不算 raw / idle）—— 这正是
      「糊盘」唯一的来源（锅里糊了再端上盘）；盘上自己永远不会变糊（bf-13 永久保鲜）。 */`,
null,
`  /** 手动出餐（低层原语）：把锅里做好的食物拾到它自己的专属盘上。
      bf-14 起玩家那条路走 takeOut()（带「起锅窗口 / 盘被占」判定）；这个函数保留原语义，
      供 debug.burnPlate / debug.plateNow 与老回归直接调用。
      注意：这里**也接糊的份**（s.state === "burnt" 时不算 raw / idle）—— 这正是
      「糊盘」唯一的来源（锅里糊了再端上盘）；盘上自己永远不会变糊（bf-13 永久保鲜）。 */`);

/* ── J11 autoPlateStations 注释（旧口径，只有显式开关才走） ─────────────── */
job("autoplate_doc", "breakfast.js",
`  /** 自动落盘（要求 A3：熟了自动落到本列专属盘）：
      锅里一到「恰好」就落到本列的盘上，不用手动出锅、锅位立刻空出来。
      9 列都生效（不再分「预备盘 / 现做」）；manual（按住看火）时不落盘。 */`,
null,
`  /** 自动落盘（**旧口径 · bf-14 起默认关闭**）：锅里一到「恰好」就落到本列的盘上。
      只有显式 cfg.autoPlate:true（调试 / 老回归）才走这里；页面默认走「限时起锅」。
      manual（按住看火）时也不落盘。 */`);

/* ── J12 起锅窗口三件套（openServeWindow / serveWinLeft / takeOut / burnStation / expire） ── */
job("window", "breakfast.js",
`  /* ── 出餐窗口（现做灶位）：出一份就要立刻送，超时即糊 ────────────────────
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
  }`,
null,
`  /* ── 锅内「起锅窗口」（bf-14）：熟了必须限时起锅，超时即糊，糊了必须双击 ────
     openServeWindow：锅内刚到「恰好」→ 打开 SERVE_WINDOW 秒的窗口 + 暂停火候
       （step 里对处于窗口中的那份不再累加火候）→ 这 4.5 秒是玩家真正能用的时间。
     takeOut        ：窗口内**单击锅** = 起锅 → 落进该列专属盘；盘被占 → 没地方放（plate-occupied），
                      窗口**继续走**（这里什么都不改），走完就糊。
     burnStation    ：窗口超时 → 那份糊掉（锅体焦黑 + 冒烟 + 记账 + 飘字）；
                      bf-14 起糊残骸**不再自动清**，必须双击锅 / 盘才清得掉。
     取出并立刻送往顾客那条老路（takeReady）原样保留：它只服务「没有专属盘」的灶位（现在恒为空集）。 */
  function openServeWindow(st, stationIdx) {
    var s = stationByIdx(st, stationIdx);
    if (!st || !s || !s.food) return null;
    s.serveWin = SERVE_WINDOW;
    s.readyAt = st.elapsed;                 // 窗口起点：倒计时按 st.elapsed 算（不累积浮点误差）
    return { t:"window", idx:stationIdx, food:s.food, left:SERVE_WINDOW };
  }
  /** 窗口剩余秒数（纯函数：窗口起点 readyAt 起算，确定性、可断言、不依赖帧率）*/
  function serveWinLeft(st, s) {
    if (!st || !s || !s.food || s.state !== "perfect") return 0;
    var a = Number(s.readyAt); if (!(a >= 0)) return 0;
    return Math.max(0, SERVE_WINDOW - (st.elapsed - a));
  }
  /** **起锅**（单击锅内的成品）→ 落进该列专属盘。返回 { ok, why, hint, ... }：
       · 没开局 / 锅空          → not-running / no-food
       · 还没熟（生）           → raw（提示还要几秒）
       · 已经糊了               → burnt（提示「糊了，只能丢掉（双击）」）
       · 该列盘里已经有东西     → **plate-occupied**：起锅没地方放 → 提示先送出去，
                                  窗口**继续走**，走完就糊（用户要求的那条规则）
       · 盘空                   → 起锅成功（盘上从此永久保鲜，档位冻结在落盘那一刻）*/
  function takeOut(st, stationIdx) {
    if (!st || !st.running || st.over) return { ok:false, why:"not-running", hint:"还没开局", station:stationIdx };
    var s = stationByIdx(st, stationIdx);
    if (!s) return { ok:false, why:"no-station", hint:"没有这一列", station:stationIdx };
    if (!s.food) return { ok:false, why:"no-food", hint:"锅里空着 —— 先点下面的食材下锅", station:stationIdx };
    if (s.state === "burnt")
      return { ok:false, why:"burnt", hint:"糊了，只能丢掉（双击这一列）", food:s.food, station:stationIdx };
    if (s.state === "raw" || s.state === "idle")
      return { ok:false, why:"raw", station:stationIdx, food:s.food, left:serveWinLeft(st, s),
               hint:"还没熟 —— " + (FOOD[s.food] || {}).n + " 要 " + FOOD[s.food].dur.toFixed(1) + "s" };
    if (plateIdxOfStation(st, stationIdx) >= 0)
      return { ok:false, why:"plate-occupied", station:stationIdx, food:s.food, left:serveWinLeft(st, s),
               hint:(PLACE_WHY["plate-occupied"] || "盘里还有一份，先送出去") + "（双击盘可以丢掉）" };
    var foodId = s.food, state = s.state;
    if (!takePlate(st, stationIdx)) return { ok:false, why:"no-plate", hint:"这一列没有专属盘", station:stationIdx };
    var p = plateOfStation(st, stationIdx);
    return { ok:true, kind:"plated", why:"", station:stationIdx, food:foodId, state:state,
             tier:(p ? p.tier : null), hot:!!(p && p.hot), left:0, plate:p };
  }
  /** 窗口超时 → 这份糊掉（锅体焦黑 + 冒烟 + 记账 + 飘字）。返回事件对象（step / expireServeWindows 共用）。*/
  function burnStation(st, stationIdx, why) {
    var s = stationByIdx(st, stationIdx);
    if (!st || !s || !s.food) return null;
    s.state = "burnt"; s.serveWin = 0; s.burntAt = st.elapsed;
    st.burnt++; st.expire++;
    st.smoke.push({ x:stationIdx, t:0, life:1.6 });
    var bb = stationBox(stationIdx);
    addFloat(st, "没起锅 · 糊了！", "#ff4d6d", 28, bb.x + bb.w / 2, bb.y + bb.h / 2);
    return { t:"burnt", idx:stationIdx, food:s.food, why:why || "window-expired" };
  }
  /** 独立跑一次「起锅窗口超时结算」（step 每帧已内联同样逻辑；这个入口供单测 / 外部调用）。
      判定按 st.elapsed：窗口起点起算满 SERVE_WINDOW 秒还没被起锅 → 糊。 */
  function expireServeWindows(st) {
    var ev = [];
    if (!st) return ev;
    for (var i = 0; i < st.stations.length; i++) {
      var s = st.stations[i];
      if (!s.food || s.state === "burnt") continue;
      if (!(s.serveWin > 0)) continue;
      /* 窗口只属于「恰好」那一刻：一旦这份食物越过完美窗口（变过火），就没得端了 */
      if (s.state !== "perfect") { s.serveWin = 0; continue; }
      s.serveWin = serveWinLeft(st, s);
      if (s.serveWin > 0) continue;                      // 窗口还没走完 → 继续等玩家起锅
      var be = burnStation(st, i, "window-expired");     // 窗口走完还没起锅 → 糊
      if (be) ev.push(be);
    }
    return ev;
  }`);

/* ── J13 serveFromColumn：盘空时提示「先点锅起锅」 ───────────────────────── */
job("servecol", "breakfast.js",
`    if (k < 0) return { ok:false, why:"no-plate", hint:"盘里还空着 —— 先点下面的食材下锅", station:stationIdx };`,
null,
`    if (k < 0) {
      /* 盘空：锅里若正有一份等着起锅，提示就直接指向那口锅（bf-14） */
      var s0 = stationByIdx(st, stationIdx);
      var h0 = isServeWindowOpen(s0)
        ? ("盘里还空着 —— 锅里那份正等着起锅：点一下锅（还剩 " + round1(serveWinLeft(st, s0)) + "s）")
        : "盘里还空着 —— 先点下面的食材下锅";
      return { ok:false, why:"no-plate", hint:h0, station:stationIdx };
    }`);

/* ── J14 step：一到「恰好」就开起锅窗口 ─────────────────────────────────── */
job("step", "breakfast.js",
`          /* 旧机制的兼容保留：只有「没有专属盘」的灶位才会在锅内开「出餐窗口」。
             现在 9 列都有盘（hasPlate 恒为 true），所以这一步永远不触发；
             autoPlateStations 会在同一帧里把这份直接落到本列专属盘上。
             注意 manual 只表示「别自动落盘」（按住看火 / 调试用），与窗口无关。 */
          if (!hasPlate(i)) ev.push(openServeWindow(st, i));`,
null,
`          /* bf-14：锅里一到「恰好」就开「起锅窗口」—— 玩家必须在 SERVE_WINDOW 秒内单击锅起锅。
             两个例外（都不开窗口，保持旧手感）：
               · manual（按住看火 / debug.place / setCook）：一路烧到过火、糊，单测验完整曲线；
               · cfg.autoPlate:true（旧口径 · 调试 / 老回归）：同一帧由 autoPlateStations 落盘。 */
          if (!s.manual && !st.cfg.autoPlate) {
            ev.push(openServeWindow(st, i));
            var wb0 = stationBox(i);
            addFloat(st, "熟了 · 起锅！", PAL.green, 22, wb0.x + wb0.w / 2, wb0.y + wb0.h - 26);
          }`);

/* ── J15 step：窗口倒计时（每列都走）+ 糊残骸不再自动清 ─────────────────── */
job("step2", "breakfast.js",
`      /* 出餐窗口倒计时（现做灶位）：窗口走完还没端走 → 当场糊 */
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
      }`,
null,
`      /* 起锅窗口倒计时（bf-14 · 每一列都真的在走）：窗口走完还没起锅 → 当场糊，
         这口锅被这份占死 —— 必须双击丢掉才能再用（下面不再有「自动清」这条路）。 */
      if (s.food && s.state === "perfect" && s.serveWin > 0) {
        s.serveWin = serveWinLeft(st, s);
        if (s.serveWin <= 0) {
          var be = burnStation(st, i, "window-expired");
          if (be) ev.push(be);
        }
      } else if (s.food && s.state !== "perfect" && s.serveWin > 0) {
        s.serveWin = 0;                                  // 越过完美窗口 → 窗口作废
      }
      /* 糊残骸（bf-14）：**不再自动清**。用户原话「想再使用锅，就要双击扔掉里面的食物」，
         所以这里只记一次糊的时刻（渲染 / 记账用），清空只走 trashStation（双击 / 右键）。 */
      if (s.state === "burnt" && !s.burntAt) s.burntAt = st.elapsed;`);

/* ── J16 start()：autoPlate 默认关 ──────────────────────────────────────── */
job("start", "breakfast.js",
`      autoPlate: opts.autoPlate !== false,           // 页面默认打开「做好自动落入专属盘」`,
null,
`      autoPlate: opts.autoPlate === true,            // bf-14：默认**关闭**（熟了要玩家在窗口内点锅起锅）`);
job("start2", "breakfast.js",
`    st.cfg.autoPlate = cfg.autoPlate;                // 9 列都是「熟了自动落到本列专属盘」`,
null,
`    st.cfg.autoPlate = cfg.autoPlate;                // bf-14 默认 false：9 列的熟份都停在锅里等起锅`);

/* ── J17 顶栏 DOM 提示行 ────────────────────────────────────────────────── */
job("tip", "breakfast.js",
`      "① 点食材 → 自动进它正上方那一列的锅 ｜ ② 点上方专属盘 → 自动送给最急的顾客（耐心最少 / 快走的那位优先） ｜ " +
      "③ 双击盘 → 丢垃圾桶（不扣分）· 盘上永久保鲜：没有倒计时、不会凉、不会糊，放多久都能上"`,
null,
`      "① 点食材 → 自动进它正上方那一列的锅 ｜ ② 锅里熟了要在 " + SERVE_WINDOW + " 秒内**点一下锅起锅**" +
      "（落到本列专属盘）—— 盘被占了就没地方放，只能等它糊掉 ｜ " +
      "③ 点专属盘 → 自动送给最急的顾客（耐心最少 / 快走的那位优先） ｜ " +
      "④ 双击锅 / 盘 → 丢垃圾桶（不扣分）；**糊了必须双击丢掉才能再用这口锅** ｜ " +
      "⑤ 盘上永久保鲜：没有倒计时、不会凉、不会糊，放多久都能上"`);

/* ── J18 actStation：单击锅 = 起锅 ──────────────────────────────────────── */
job("actstation", "breakfast.js",
`    /** 点锅（这一列的灶位）：锅里那份是什么状态就给什么提示；
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
    }`,
null,
`    /** 点锅（这一列的灶位）—— bf-14 起**单击 = 起锅**：
        锅内「恰好」且还在窗口里 → 落进本列专属盘（盘空才行）；
        盘里已经有一份 → 起锅没地方放（暖色提示「盘里还有一份，先送出去」），
        窗口**继续走** → 走完这份糊在锅里（再点锅只会提示「双击丢掉」）；
        锅里还生 → 提示还要几秒；锅空 → 提示点食材 / 盘里那份先送出去。 */
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
      var ro = takeOut(st, i);
      if (ro.ok) {
        st.selected = { kind:"plate", idx:i };
        flash("起锅 · 落到" + plateNameOf(i) + "（" + (TIER_NAME[ro.tier] || "") + "）—— 点盘送出去", PAL.green);
        return;
      }
      if (ro.why === "burnt") { flash("糊了，只能丢掉（双击这一列）", PAL.red); return; }
      if (ro.why === "raw") { flash("锅里还在做 —— " + (FOOD[s.food] || {}).n + " 要 " + FOOD[s.food].dur.toFixed(1) + "s"); return; }
      if (ro.why === "plate-occupied") {
        flash("盘里还有一份，先送出去 —— " + round1(ro.left) + "s 内不起锅这份就糊了", PAL.steelHot); return;
      }
      flash(ro.hint || "起不了锅", whyColor(ro.why));
    }`);

/* ── J19 顶栏第二行明细 ─────────────────────────────────────────────────── */
job("topbar", "breakfast.js",
`      g.fillText("完美 " + st.perfect + " · 温 " + (st.heat.warm || 0) + " · 凉 " + (st.heat.cold || 0) +
                 " · 糊 " + st.burnt + "（忘取 " + (st.expire || 0) + "）· 跑单 " + st.angry + " · 上错 " + st.wrong +
                 " · 盘上 " + st.plates.length + "/" + PLATES_TOTAL + " · 盘上永久保鲜（无倒计时）", 18, 50);`,
null,
`      var pickN = 0;
      for (var wi = 0; wi < st.stations.length; wi++) if (isServeWindowOpen(st.stations[wi])) pickN++;
      g.fillText("完美 " + st.perfect + " · 温 " + (st.heat.warm || 0) + " · 凉 " + (st.heat.cold || 0) +
                 " · 糊 " + st.burnt + "（忘起锅 " + (st.expire || 0) + "）· 跑单 " + st.angry + " · 上错 " + st.wrong +
                 " · 盘上 " + st.plates.length + "/" + PLATES_TOTAL + " · " +
                 (pickN > 0 ? ("锅里等着起锅 " + pickN + " 份") : "盘上永久保鲜（无倒计时）"), 18, 50);`);

/* ── J20 drawPan：起锅提示 + 倒计时环 ───────────────────────────────────── */
job("drawpan_a", "breakfast.js",
`      var left = Math.max(0, s.serveWin || 0);           // 旧机制：锅内出餐窗口剩余（现在恒为 0）
      var frac = SERVE_WINDOW > 0 ? Math.max(0, Math.min(1, left / SERVE_WINDOW)) : 0;
      var lastSec = ready && left <= SERVE_WARN_SEC;
      var blink = Math.floor(nowMs() / 200) % 2 === 0;`,
null,
`      var left = Math.max(0, s.serveWin || 0);           // bf-14：锅内「起锅窗口」剩余秒数（真的在走）
      var frac = SERVE_WINDOW > 0 ? Math.max(0, Math.min(1, left / SERVE_WINDOW)) : 0;
      var lastSec = ready && left > 0 && left <= SERVE_WARN_SEC;
      var picking = ready && left > 0;                  // 正在窗口里等人起锅
      var blink = Math.floor(nowMs() / 200) % 2 === 0;`);
job("drawpan_b", "breakfast.js",
`      if (busy) g.globalAlpha = 0.42;                       // 盘里还有一份 → 锅位半透明`,
null,
`      if (busy && !fd) g.globalAlpha = 0.42;                // 盘里还有一份（且锅空着）→ 锅位半透明`);
job("drawpan_c", "breakfast.js",
`      /* 旧机制的锅内出餐窗口环（兼容保留：现在食物一到「恰好」就落盘，不会开窗口）*/
      if (ready && left > 0) {`,
null,
`      /* 起锅窗口倒计时环（bf-14）：跟着火候环外圈走 —— 橙 → 最后一秒红闪 → 走完变焦黑锅 */
      if (ready && left > 0) {`);
job("drawpan_d", "breakfast.js",
`      g.font = fontOf(FONT.micro, false); g.fillStyle = "rgba(255,255,255,.34)";
      g.fillText(busy ? "盘里还有一份" : (fd ? "在烧" : "空着 · 点食材"), cx, b.y + 29);`,
null,
`      /* bf-14：锅里「恰好」→ 这行小字变成起锅指令（盘占着就明说「没地方放」，红闪）*/
      g.font = fontOf(FONT.micro, true);
      if (picking && busy) {
        g.fillStyle = lastSec && blink ? "#ffffff" : PAL.red;
        g.fillText("盘占着 · 没地方放", cx, b.y + 29);
      } else if (picking) {
        g.fillStyle = lastSec && blink ? "#ffffff" : PAL.green;
        g.fillText("起锅！点一下这口锅", cx, b.y + 29);
      } else {
        g.font = fontOf(FONT.micro, false); g.fillStyle = "rgba(255,255,255,.34)";
        g.fillText(busy ? "盘里还有一份" : (fd ? "在烧" : "空着 · 点食材"), cx, b.y + 29);
      }`);
job("drawpan_e", "breakfast.js",
`        var txt = s.state === "burnt" ? "糊了 · 双击丢掉"
                : (s.state === "perfect" ? "恰好 · 落盘"
                : (s.state === "over" ? "过火 · 可上" : "生 " + (s.t / 1000).toFixed(1) + "s"));
        g.fillStyle = s.state === "burnt" ? "#ffd0d8" : (s.state === "perfect" ? "#ddffe9" : "rgba(255,255,255,.60)");`,
null,
`        var txt = s.state === "burnt" ? PAN_BURNT_TEXT
                : (s.state === "perfect" ? (busy ? PAN_BLOCKED_TEXT : (PAN_PICK_TEXT + " " + left.toFixed(1) + "s"))
                : (s.state === "over" ? "过火 · 可上" : "生 " + (s.t / 1000).toFixed(1) + "s"));
        g.fillStyle = s.state === "burnt" ? "#ffd0d8"
                    : (s.state === "perfect" ? (busy ? "#ffd0d8" : (lastSec && blink ? "#ffffff" : "#ddffe9"))
                    : "rgba(255,255,255,.60)");`);

/* ── J21 底排说明 ───────────────────────────────────────────────────────── */
job("plates_label", "breakfast.js",
`      g.fillText("9 列 × 每列 1 锅 1 专属盘 · 盘上永久保鲜：没有倒计时 / 不会凉 / 不会糊，放多久都能上",
                 W - LAY.buckets.x0, LAY.buckets.y + LAY.bucketLabelDy);`,
null,
`      g.fillText("9 列 × 每列 1 锅 1 专属盘 · 锅里熟了要在 " + SERVE_WINDOW + "s 内点锅起锅；盘被占了就只能糊掉（双击丢弃再用锅）· 盘上永久保鲜",
                 W - LAY.buckets.x0, LAY.buckets.y + LAY.bucketLabelDy);`);

/* ── J22 操作图例 ───────────────────────────────────────────────────────── */
job("legend", "breakfast.js",
`      g.fillText("① 点食材 → 自动下锅　｜　② 点专属盘 → 送给正在等的顾客　｜　③ 双击盘 → 丢垃圾桶（不扣分）　｜　④ 盘上永久保鲜：不会凉 · 不会糊",
                 x + w / 2, y + h / 2);`,
null,
`      g.fillText("① 点食材 → 自动下锅　｜　② 熟了 " + SERVE_WINDOW + "s 内点锅起锅　｜　③ 点盘 → 送给正在等的顾客　｜　④ 双击盘 → 丢垃圾桶（糊了必须双击才清）",
                 x + w / 2, y + h / 2);`);

/* ── J23 新手引导（大厅空场那行字）─────────────────────────────────────── */
job("newbie", "breakfast.js",
`        g.fillText("顾客马上进门 —— 可以先把 " + COL_N + " 列里的食材点上，熟了各自落到本列的盘上等着（盘上 4.5 秒内要送出去）", b0.x + wAll / 2, b0.y + LAY.cards.h / 2);`,
null,
`        g.fillText("顾客马上进门 —— 先把 " + COL_N + " 列的食材点上；锅里一熟就点锅起锅（" + SERVE_WINDOW + "s 内），落到本列盘上等着 —— 盘上放多久都能上", b0.x + wAll / 2, b0.y + LAY.cards.h / 2);`);

/* ── J24 结算面板：忘取 → 忘起锅 ───────────────────────────────────────── */
job("panel", "breakfast.js",
`          row("烧糊份数", String(r.burnt) + (r.expire ? ("（忘取 " + r.expire + "）") : "")) +`,
null,
`          row("烧糊份数", String(r.burnt) + (r.expire ? ("（忘起锅 " + r.expire + "）") : "")) +`);

/* ── J25 rules 导出 ─────────────────────────────────────────────────────── */
job("rules_exp2", "breakfast.js",
`    PLATE_KEEP: PLATE_KEEP, PLATE_NO_TIMER: PLATE_NO_TIMER, PLATE_KEEP_TEXT: PLATE_KEEP_TEXT,`,
null,
`    PLATE_KEEP: PLATE_KEEP, PLATE_NO_TIMER: PLATE_NO_TIMER, PLATE_KEEP_TEXT: PLATE_KEEP_TEXT,
    /* bf-14 锅内限时起锅：糊锅不可自动清 + 三句状态文案（UI 与断言同源）*/
    PAN_BURNT_STICKY: PAN_BURNT_STICKY,
    PAN_PICK_TEXT: PAN_PICK_TEXT, PAN_BLOCKED_TEXT: PAN_BLOCKED_TEXT, PAN_BURNT_TEXT: PAN_BURNT_TEXT,`);
job("rules_exp3", "breakfast.js",
`    takePlate: takePlate, autoPlateStations: autoPlateStations, trashStation: trashStation, trashPlate: trashPlate,`,
null,
`    takePlate: takePlate, takeOut: takeOut, serveWinLeft: serveWinLeft, burnStation: burnStation,
    autoPlateStations: autoPlateStations, trashStation: trashStation, trashPlate: trashPlate,`);

/* ── J26 api 导出 ───────────────────────────────────────────────────────── */
job("api_exp", "breakfast.js",
`    PREP_PLATES: PREP_PLATES, SERVE_WINDOW: SERVE_WINDOW,
    PLATE_KEEP: PLATE_KEEP, PLATE_NO_TIMER: PLATE_NO_TIMER,`,
null,
`    PREP_PLATES: PREP_PLATES, SERVE_WINDOW: SERVE_WINDOW, SERVE_WARN_SEC: SERVE_WARN_SEC,
    PLATE_KEEP: PLATE_KEEP, PLATE_NO_TIMER: PLATE_NO_TIMER,
    PAN_BURNT_STICKY: PAN_BURNT_STICKY,
    PAN_PICK_TEXT: PAN_PICK_TEXT, PAN_BLOCKED_TEXT: PAN_BLOCKED_TEXT, PAN_BURNT_TEXT: PAN_BURNT_TEXT,`);

/* ── J27 debug.state：起锅口径字段 ──────────────────────────────────────── */
job("dbg_state", "breakfast.js",
`          serveWindow:SERVE_WINDOW, plateLife:PLATE_NO_TIMER, plateKeep:PLATE_KEEP,
          expire:st.expire || 0, tossed:st.tossed || 0,`,
null,
`          serveWindow:SERVE_WINDOW, panWindow:SERVE_WINDOW, panBurntSticky:PAN_BURNT_STICKY,
          plateLife:PLATE_NO_TIMER, plateKeep:PLATE_KEEP,
          expire:st.expire || 0, tossed:st.tossed || 0,`);

/* ── J28 debug.stations：窗口剩余 / 是否被盘堵住 ────────────────────────── */
job("dbg_stations", "breakfast.js",
`                   serveWin:Math.round((s.serveWin || 0) * 1000) / 1000,
                   windowOpen:isServeWindowOpen(s) };`,
null,
`                   serveWin:Math.round((s.serveWin || 0) * 1000) / 1000,
                   windowLeft:Math.round(serveWinLeft(st, s) * 1000) / 1000,
                   picking:(s.state === "perfect" && (s.serveWin || 0) > 0),
                   blockedByPlate:(s.state === "perfect" && (s.serveWin || 0) > 0 && !!p),
                   windowOpen:isServeWindowOpen(s) };`);

/* ── J29 debug.tap("station") = 起锅 + 新增 debug.takeOut ───────────────── */
job("dbg_tap", "breakfast.js",
`        /* plate = 单击盘 → 出餐（要求 A3）；station = 锅内做好的手动落盘（autoPlate 关掉时才用得上） */
        if (kind === "plate") return serveFromColumn(st, idx).ok;
        if (kind === "station") return takePlate(st, idx);`,
null,
`        /* plate = 单击盘 → 出餐（要求 A3）；station = **单击锅 = 起锅**（bf-14，走完整判定）*/
        if (kind === "plate") return serveFromColumn(st, idx).ok;
        if (kind === "station") return takeOut(st, idx).ok;`);
job("dbg_takeout", "breakfast.js",
`      /** 单击某一列的盘 → 送给「正在需要 + 耐心最少」的顾客（返回完整结果，测试读 why / delta）*/
      serveCol: function (idx) { var st = curState(); if (!st) return { ok:false, why:"no-run" }; return serveFromColumn(st, idx); },`,
null,
`      /** 单击某一列的盘 → 送给「正在需要 + 耐心最少」的顾客（返回完整结果，测试读 why / delta）*/
      serveCol: function (idx) { var st = curState(); if (!st) return { ok:false, why:"no-run" }; return serveFromColumn(st, idx); },
      /** bf-14：单击锅 = 起锅（完整结果；why="plate-occupied" = 盘被占、没地方放，窗口继续走）*/
      takeOut: function (idx) { var st = curState(); if (!st) return { ok:false, why:"no-run" }; return takeOut(st, idx); },`);

/* ── 落盘：text 文件 + jobs.json ───────────────────────────────────────── */
const dir = path.join(OUT, "tools", "bf", "_patch");
let maxLines = 0;
for (const t of T) {
  const f = path.join(dir, "bf14_" + t.name + ".txt");
  fs.writeFileSync(f, t.text.replace(/\r\n/g, "\n"), "utf8");
  maxLines = Math.max(maxLines, t.text.split("\n").length);
}
fs.writeFileSync(path.join(dir, "jobs_bf14.json"), JSON.stringify({ jobs: jobs }, null, 1), "utf8");
console.log("✓ 生成 " + T.length + " 个 job（最长 " + maxLines + " 行）→ tools/bf/_patch/jobs_bf14.json");
T.forEach((t, i) => console.log("  job#" + (i + 1) + " · " + t.name + " · " + t.text.split("\n").length + " 行"));
