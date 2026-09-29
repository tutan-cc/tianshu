/* ══════════════════════════════════════════════════════════════════════════════
   delivery.js —「您好，您的外卖」· 小区送餐（伪 3D 追尾视角）

   自包含 IIFE，暴露全局 window.Delivery；ES5 风格，不使用 ES module，
   不依赖页面内变量（只读 opts / 挂载 hostEl）。零素材：楼栋、取餐柜、顾客、障碍
   全部用 canvas 图元程序化绘制。

   一句话规格：骑着电动车在小区环路里跑一圈，把餐投进亮绿灯的取餐柜、擦身递给
   楼下等的顾客，躲开狗和小孩，别逆行。

   对外 API（规格）：
     window.Delivery.start(hostEl, opts) -> boolean
       opts:{ cash:()=>number, phys:()=>number, intel:()=>number,
              onSettle:(net,info)=>{}, onFinish:(sum)=>{},
              practice:boolean, mode:"shift|rush|week" }
     window.Delivery.isBusy(), dispose()
     window.Delivery.debug = { state(), route(), press(verb), tick(ms), pause(), resume(),
                               finishNow(), teleport(orderIndex), lifecycle() }

   附加（单测用，不属于规格）：window.Delivery.rules = { makeRng, project, buildRoute,
     scoreOf, SCORE_TABLE, judgeDeliver, approachT, gradeOf, payoutOf, simulateShift,
     MODES, PAYOUT, TUNE, HAZARDS }

   ── 设计要点（为什么这么做，改之前先读）────────────────────────────────────────
   1) **投射数学是纯函数**，与渲染分离。project() 不碰 canvas，单测直接喂数验算
      （路中心段 screen.x 必须等于 W/2；camera.z 翻倍则 screen.w 减半）。伪 3D 的 bug
      极难靠肉眼定位，只有把数学抽出来才验得动。

   2) **逆行不给分是结构性约束，不是"我记得别加分"**：
      全部得分走 scoreOf(kind,…)，而 SCORE_TABLE 里**根本没有 violation 这一项** ——
      未登记的事件一律返回 0 分，想加也没地方加。单测构造"全程逆行 vs 全程顺行"两局，
      断言分数差 = 0。（逆行只换时间，代价是迎面来车与保安罚款。）

   3) **两级危险**：碰撞类（小孩/车/垃圾桶/锥桶/狗咬/迎面车）记一次「失误」，
      3 次当班结束；颠簸类（坑/排水沟/水坑/球/遥控车/景观池）记一次「洒汤」，
      该单差评但不结束。碰撞是你的错、颠簸是路况，责任不同惩罚就不同。

   4) **两套投递共用一套判定**（judgeDeliver），判定三条轴：灯色对不对（读）、
      时机在不在甜区（掐）、身位在不在同侧（控车）。缺一条就退化成"见到就按"。

   5) **经济不变量靠 simulateShift 蒙卡断言，且一律相对于 E[value]**：
      瞎送必亏 / 手熟能赚 / 高技能封顶。任何写死的元数都会在调参后变成假绿灯
      （切果那次就栽在这上面）。
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";
  if (!root || root.Delivery) return;

  var doc = root.document;

  /* ═════════════════ 1. 调参区（改手感只动这里） ═════════════════ */

  var TUNE = {
    ENTRY: 20,                // 入场 ¥20（租车+电池，与刮刮乐/开窗同价）

    /* ── 伪 3D 投射 ──
       ⚠ 世界单位标定（改任何尺寸前先读这段）：ROAD_W 是**半**路宽，
       全路 2800 单位 ≈ 9 米 → **1 米 ≈ 311 单位**。所有精灵的 w/h 都按这把尺子写，
       写成"看起来差不多大"的小数字会让楼房只有一米宽（第一次就写错了）。 */
    SEG_LEN: 200,             // 世界单位/段
    RUMBLE_LEN: 3,            // 每几段换一次路面色（形成横向条纹）
    ROAD_W: 1400,             // 路面半宽 ≈ 4.5 米
    FOV: 100,                 // 视场角（度）
    CAM_H: 900,               // 相机离地高 ≈ 2.9 米
    DRAW_DIST: 240,           // 往前画 240 段 = 48000 单位 ≈ 154 米
    FOG: 5,
    CENTRIFUGAL: 0.30,        // 弯道把你甩出去的力度

    /* ── 速度（世界单位/秒）──
       9000 单位/秒 = 29 米/秒 ≈ 104 km/h（街机尺度，不是真电动车）。
       巡航 60% → 17.4 米/秒，一圈 1100 段（220000 单位 ≈ 707 米）约 40 秒 ——
       这是一个"班次"该有的体量。 */
    MAX_SPEED: 9000,
    ACCEL: 2600,
    BRAKE: -12000,
    DECEL: -1500,             // 松手自然减速
    OFFROAD_DECEL: -6000,
    OFFROAD_LIMIT: 3200,
    CRUISE: 0.60,             // 自动巡航速度比例（触屏也能玩：不用一直按加速）

    /* ── 投递判定 ──
       ⚠ 窗口宽度是**按反应时间倒推**的，不是凭手感写的小数字：
       巡航 5400 单位/秒 ÷ 200 单位/段 = 27 段/秒。
       第一版 APPROACH=16（0.59 秒）、APPROACH_HAND=9（0.33 秒）——
       都短于"看到准星环 → 判断绿区 → 按键"所需的约 1 秒，机制实际按不出来。
       现在 36 段 ≈ 1.33 秒（满速时 0.8 秒）、擦身 24 段 ≈ 0.89 秒：
       两者仍保持"擦身更窄"的区分，但都在可操作范围。单测有断言守着这两条底线。 */
    APPROACH: 36,             // 提前多少段开始出现准星（柜）
    APPROACH_HAND: 24,        // 擦身递餐的窗口更短（这才是"擦身"）
    SWEET: 0.72,              // 甜区中心（0=刚进窗口，1=到达目标）
    SWEET_TOL: 0.11,
    HIT_TOL: 0.32,
    LATERAL: 0.10,            // 身位：playerX × side 必须 > 此值（不能隔半条路投）
    DECOY_PENALTY: 1,         // 投到红灯柜：浪费 1 份餐 + 清连送
    /* 引开恶犬的动作窗口（段）。⚠ 这个值必须按"人的反应时间"倒推，不能凭手感写小：
       1 段 = 200 单位 ≈ 0.64 米；巡航 5400 单位/秒 = 17.4 米/秒。
       第一版定 10 段 = 6.4 米 → 只有 0.37 秒（满速时 0.2 秒），比人的反应时间还短，
       「扔备餐引狗」这条机制实际永远按不出来。45 段 = 29 米 ≈ 1.7 秒，才够看-判-按。 */
    DOG_RANGE: 45,

    /* ── 资源与失误 ── */
    BAG_BASE: 6,              // 保温箱容量
    MISTAKES_MAX: 3,          // 碰撞 3 次当班结束
    SPILL_TIP_LOSS: true,     // 洒过汤的单不给好评打赏

    /* ── 违规（只换时间，不给分） ──
       ⚠ WRONGWAY_X 不能把"左半幅"整个划成逆行：左侧也会派订单，而送左侧单要求
       playerX × (-1) > LATERAL 即 playerX < -0.10 —— 若逆行线定在 -0.15，
       送左侧单就必然违规，两条规则直接打架（截图里送左单时"逆行中"会亮起来）。
       现在只把**最左那条窄带**（≈路宽的 26%）划成对向车道，
       合法骑行区是 [-0.48, 1.0]，左侧订单在 [-0.48, -0.10] 内就能送达。 */
    WRONGWAY_X: -0.48,        // playerX 低于此值算逆行（最左那条对向车道）
    WRONGWAY_SPEED_MUL: 1.12, // 路空，能骑更快
    WRONGWAY_SPAWN: 0.55,     // 对向来车的密度系数
    ONCOM_XMIN: -1.02,        // 对向来车的横向范围（就在那条带里）
    ONCOM_XMAX: -0.58,
    FINE: 50,                 // 被保安拦下罚 ¥50
    GUARD_HOLD: 1.2,          // 拦停秒数（净亏时间）

    /* ── 计分 ── */
    BASE_DELIVER: 100,
    STREAK_CAP: 5,            // 连送倍率 5 倍封顶（照抄原作）
    PERFECT: 200,             // 精准投递 / 精准递餐（原作 Bullseye）
    TIP: 400,                 // 好评打赏：零碰撞+未超时+未洒汤（填原作的恶作剧槽位）
    DOG: 200,                 // 引开恶犬
    HELP: 200,                // 顺手帮带
    CLEAN: 500,               // 整班零失误
    SPEED_RATE: 12            // 提前收工奖励：每省 1 秒 12 分（parTime 贴着可达时间定，见 buildRoute）
  };

  /* ⚠ 得分登记表 —— 唯一的加分行数来源。
     刻意**没有** violation 这一项：逆行不产生任何分数。
     scoreOf() 对未登记的 kind 一律返回 0，所以"顺手给逆加点分"这种改动
     在结构上就做不到，而不是靠人记得。 */
  var SCORE_TABLE = {
    deliver: TUNE.BASE_DELIVER,
    perfect: TUNE.PERFECT,
    tip:     TUNE.TIP,
    dog:     TUNE.DOG,
    help:    TUNE.HELP,
    clean:   TUNE.CLEAN,
    speed:   1
  };

  /* ── 三种模式 ── */
  var MODES = {
    shift: { id:"shift", n:"单班",   sub:"跑完一天的活",       days:1, timeLimit:0,  bag:TUNE.BAG_BASE, orders:[6] },
    rush:  { id:"rush",  n:"午高峰", sub:"75 秒冲单量",        days:1, timeLimit:75, bag:4,             orders:[9] },
    week:  { id:"week",  n:"一周",   sub:"连跑七天，日结",      days:7, timeLimit:0,  bag:TUNE.BAG_BASE, orders:[6,7,8,9,10,11,12] }
  };

  /* 赔付阶梯：每模式一条（单一阶梯会把某个模式变成印钞机 —— 切果那次踩过）。
     数值由 simulateShift 分布反推，见 tests/delivery.test.cjs 的不变量断言。
     ⚠ 阶梯**必须留出高段位**：第一版顶格定在 skill 0.7 就能摸到的分数上，
     结果 0.7/0.9/1.0 三档期望收益全是同一个数（¥167/170/170）—— 技术再好也不多拿一分，
     等于把后半段难度设计整段作废。现在按各档分数分布把顶格抬到 skill≈1.0 才够得着。 */
  var PAYOUT = {
    shift: [ {min:0,pay:0}, {min:280,pay:3}, {min:660,pay:8}, {min:1180,pay:16},
             {min:1900,pay:26}, {min:2750,pay:38}, {min:3800,pay:52}, {min:5100,pay:70} ],
    rush:  [ {min:0,pay:0}, {min:400,pay:3}, {min:900,pay:8}, {min:1500,pay:14},
             {min:2200,pay:22}, {min:3000,pay:32}, {min:4000,pay:46}, {min:5600,pay:78} ],
    week:  [ {min:0,pay:0}, {min:2500,pay:8}, {min:5500,pay:20}, {min:10000,pay:38},
             {min:16000,pay:62}, {min:24000,pay:92}, {min:33000,pay:126},
             {min:43000,pay:164}, {min:54000,pay:205} ]
  };

  /* ── 危险表：两级 ──
     tier "hit"  = 碰撞类 → 记失误，3 次结束
     tier "bump" = 颠簸类 → 记洒汤，该单差评但不结束
     w/h 是世界单位（1 米 ≈ 311 单位），碰撞判定用 w/2 当半径。 */
  var HAZARDS = {
    dog:    { tier:"hit",  n:"没牵绳的狗",   w:400,  h:620,  why:"狗追上来咬到了" },
    child:  { tier:"hit",  n:"追跑的小孩",   w:360,  h:560,  why:"撞到小孩" },
    car:    { tier:"hit",  n:"倒车的私家车", w:1800, h:1500, why:"被车蹭到" },
    oncom:  { tier:"hit",  n:"迎面来车",     w:1900, h:1500, why:"逆行撞上对向来车" },
    guard:  { tier:"none", n:"小区保安",     w:400,  h:530,  why:"被保安拦下" },
    bin:    { tier:"bump", n:"垃圾桶",       w:620,  h:900,  why:"蹭翻垃圾桶，汤洒了" },
    cone:   { tier:"bump", n:"施工锥桶",     w:340,  h:520,  why:"压到锥桶，颠洒了" },
    pothole:{ tier:"bump", n:"塌陷井盖",     w:700,  h:60,   why:"压过塌陷井盖" },
    drain:  { tier:"bump", n:"排水沟栅",     w:560,  h:50,   why:"排水沟颠了一下" },
    puddle: { tier:"bump", n:"积水",         w:1100, h:40,   why:"冲过积水，溅进箱子" },
    ball:   { tier:"bump", n:"滚来的皮球",   w:280,  h:280,  why:"压到皮球" },
    rccar:  { tier:"bump", n:"小孩的遥控车", w:420,  h:180,  why:"压到遥控车" },
    pond:   { tier:"bump", n:"景观池边",     w:1400, h:60,   why:"骑到景观池边，颠洒了" }
  };

  /* ═════════════════ 2. 纯规则层（无 DOM，可在 vm 里整局自跑） ═════════════════ */

  /* xorshift32：确定性随机。**不用 Math.imul** —— 仓库要求模块兼容 IE11。
     ⚠ 必须在构造时**预热 8 轮**：xorshift32 的第一个输出对相近种子几乎不变
     （实测 300 个相邻种子的首值全挤在 0.658–0.685）。单日模式每局只掷一次随机
     （比如"要不要被保安拦下"），不预热就等于这个判定被焊死成一个固定结果。
     预热后首值才真正散开。 */
  function makeRng(seed) {
    var s = (seed >>> 0) || 0x1F2E3D4C;
    function next() {
      s ^= (s << 13); s >>>= 0;
      s ^= (s >>> 17);
      s ^= (s << 5);  s >>>= 0;
      return s;
    }
    for (var w = 0; w < 8; w++) next();
    return function () { return next() / 4294967296; };
  }

  function limit(v, mn, mx) { return v < mn ? mn : (v > mx ? mx : v); }
  function toInt(v, d) { return Math.round(v * d) / d; }
  function easeIn(a, b, p)    { return a + (b - a) * Math.pow(p, 2); }
  function easeOut(a, b, p)   { return a + (b - a) * (1 - Math.pow(1 - p, 2)); }
  function easeInOut(a, b, p) { return a + (b - a) * (-Math.cos(p * Math.PI) / 2 + 0.5); }

  /* ── 伪 3D 投射（纯函数，单测主力）──
     把世界坐标点 p 投到屏幕。返回 false 表示该点在相机后方/太近，调用方必须丢弃。
     三个经典坑的坑位就在这里：z 太小要丢、y 的符号、w 与 scale 成正比。 */
  function project(p, camX, camY, camZ, camDepth, width, height, roadWidth) {
    p.camera.x = (p.world.x || 0) - camX;
    p.camera.y = (p.world.y || 0) - camY;
    p.camera.z = (p.world.z || 0) - camZ;
    if (!(p.camera.z > camDepth)) return false;   // ← 坑 1：近于相机深度，丢弃
    p.screen.scale = camDepth / p.camera.z;
    p.screen.x = Math.round((width  / 2) + (p.screen.scale * p.camera.x * width  / 2));
    p.screen.y = Math.round((height / 2) - (p.screen.scale * p.camera.y * height / 2));
    p.screen.w = Math.round(                p.screen.scale * roadWidth  * width  / 2);
    return true;
  }

  /* ── 路线配方：按天程序化生成（同 seed 必逐段相同）──
     段数规模：满速 9000 单位/秒 ÷ 每段 200 = 45 段/秒。赛道必须远长于 DRAW_DIST，
     否则会看到赛道自己接上：这里 1000 段（=20 万单位）起，第 7 天约 2000 段；
     按 60% 巡航算一圈 37…74 秒，正是一个"班次"的体量。

     ⚠ 弯道必须**缓**且**正反交替**：render() 里 x 是逐段累加的横移
     （`x += dx; dx += seg.curve`），一个持续 n 段的弯会把 x 推到 ≈ curve×n²/2。
     实测第一版（curve 到 ±8、单段长 180 段、不交替）x 最高冲到 12.9 万单位 = 路半宽的 92 倍，
     240 段绘制范围里平均只剩 35 段可见、最差一段都看不见 —— 表现为"前方路面整块消失"。
     现在 curve ≤ ±2、单段 ≤ 140 段、且方向强制交替，x 稳定在一万以内。 */
  function planRoute(day, rng) {
    var pieces = [], len = 0, sign = 1;
    var targetLen = 1000 + day * 130;
    function flip() { sign = -sign; return sign * 2; }      // ±2，且左右交替
    pieces.push({ t:"straight", n:50 });                    // 起步直道：给玩家进入状态
    len += 50;
    pieces.push({ t:"curve", n:64, curve:flip(), hill:0 });
    len += 64;
    while (len < targetLen) {
      var r = rng();
      var n = 60 + Math.floor(rng() * 80);                  // 60…140
      if (r < 0.34)      pieces.push({ t:"curve",   n:n, curve:flip(), hill:0 });
      else if (r < 0.54) pieces.push({ t:"hill",    n:n, curve:0, hill:(rng() < 0.5 ? -1 : 1) * (120 + Math.floor(rng() * 260)) });
      else if (r < 0.74) pieces.push({ t:"scurve",  n:n });           // 内部自带正反，天然抵消
      else if (r < 0.87) pieces.push({ t:"narrow",  n:n, curve:flip() });   // 窄路：两侧楼房贴得近
      else               pieces.push({ t:"straight", n:n });
      len += n;
    }
    return { pieces: pieces, len: len };
  }

  /* ── 建赛道：闭合环线（小区环路本来就是环，跑完一圈 = 收工）── */
  function buildRoute(day, seed, modeId) {
    var mode = MODES[modeId] || MODES.shift;
    var d = limit(day | 0, 1, 7);
    var rng = makeRng((((seed >>> 0) || 12345) ^ (d * 0x9E3779B1)) >>> 0);
    var plan = planRoute(d, rng);
    var segs = [];
    var startY = 0;

    function addSeg(curve, y) {
      var n = segs.length;
      segs.push({
        index: n,
        p1: { world:{ x:0, y:startY, z:n * TUNE.SEG_LEN },       camera:{}, screen:{} },
        p2: { world:{ x:0, y:y,      z:(n + 1) * TUNE.SEG_LEN }, camera:{}, screen:{} },
        curve: curve,
        dark: (Math.floor(n / TUNE.RUMBLE_LEN) % 2) === 0,
        narrow: false,
        sprites: [], orders: [], decoys: [], hazards: [], items: [],
        guard: false, clip: 0, fog: 1, looped: false
      });
    }
    function lastY() { return segs.length ? segs[segs.length - 1].p2.world.y : 0; }
    /* addRoad(enter, hold, leave, curve, hill)：**共产生 enter+hold+leave 段**。
       ⚠ 这里踩过一次：把「一段长 n 的直道」写成 addRoad(n,n,n,…)，段数被撑成 3 倍，
       赛道长度与配方完全对不上。要 n 段就传 (0, n, 0)。 */
    function addRoad(enter, hold, leave, curve, hill) {
      var y0 = lastY(), y1 = y0 + (hill || 0), total = enter + hold + leave, i;
      if (total <= 0) return;
      for (i = 0; i < enter; i++) addSeg(easeIn(0, curve, i / enter), easeInOut(y0, y1, i / total));
      for (i = 0; i < hold;  i++) addSeg(curve,                         easeInOut(y0, y1, (enter + i) / total));
      for (i = 0; i < leave; i++) addSeg(easeInOut(curve, 0, i / leave), easeInOut(y0, y1, (enter + hold + i) / total));
    }

    var i, j, pc, start, isNarrow, h;
    for (i = 0; i < plan.pieces.length; i++) {
      pc = plan.pieces[i];
      start = segs.length;                                  // 记住起点：narrow 标记要用
      isNarrow = (pc.t === "narrow");
      if (pc.t === "straight")    addRoad(0, pc.n, 0, 0, 0);
      else if (pc.t === "curve")  addRoad(Math.floor(pc.n * 0.25), Math.floor(pc.n * 0.5), Math.floor(pc.n * 0.25), pc.curve, 0);
      else if (pc.t === "hill")   addRoad(Math.floor(pc.n * 0.4), Math.floor(pc.n * 0.2), Math.floor(pc.n * 0.4), 0, pc.hill);
      else if (pc.t === "scurve") {
        h = Math.floor(pc.n / 2);
        addRoad(Math.floor(h * 0.3), Math.floor(h * 0.7), 0,  2, 0);
        addRoad(0, Math.floor(h * 0.7), Math.floor(h * 0.3), -2, 0);
      }
      else if (isNarrow)          addRoad(Math.floor(pc.n * 0.3), Math.floor(pc.n * 0.4), Math.floor(pc.n * 0.3), pc.curve, 0);
      for (j = start; j < segs.length; j++) segs[j].narrow = isNarrow;
    }

    /* ── 闭合环线：把高度收回起点 ──
       ⚠ 赛道是**环形**的，跑完一圈会绕回第 0 段。如果末端高度不是起点高度，
       环线在垂直方向就是断的：骑过终点线时前方所有段的世界高度都比相机低一大截，
       投影后落到屏幕下方，全部被 maxy 剔除 —— 实测表现是**路面整块消失、
       只剩最近一段，像骑进虚空**（这个 bug 画面上很吓人，但逻辑层完全测不出来，
       是靠截图才看见的）。经典 outrun 实现里对应 addDownhillToEnd 这一步。 */
    var yEnd = lastY() - startY;
    if (Math.abs(yEnd) > 0.5) {
      var rampN = Math.max(60, Math.min(240, Math.round(Math.abs(yEnd) / 4)));
      addRoad(Math.floor(rampN * 0.4), Math.floor(rampN * 0.2), Math.floor(rampN * 0.4), 0, -yEnd);
    }
    var total = segs.length;

    /* ── 楼房/树/灯：两侧装饰。尺寸按 1 米 ≈ 311 单位写 ──
       每 6 段一档（不是每段），这样视野内的精灵数量可控：DRAW_DIST 240 ÷ 6 × 4 ≈ 160 个/帧。 ── */
    var rl = makeRng((((seed >>> 0) || 12345) ^ (d * 0x85EBCA6B)) >>> 0);
    for (i = 0; i < total; i += 6) {
      var near = segs[i].narrow;
      /* 楼房：宽 8–15 米、高 16–39 米（5–13 层），退到人行道外 */
      if (rl() < 0.82) segs[i].sprites.push({ t:"building", off:-(1.9 + rl() * 1.1) * (near ? 0.82 : 1), h:5000 + Math.floor(rl() * 7000), w:2500 + Math.floor(rl() * 2200), lit:rl() });
      if (rl() < 0.82) segs[i].sprites.push({ t:"building", off: (1.9 + rl() * 1.1) * (near ? 0.82 : 1), h:5000 + Math.floor(rl() * 7000), w:2500 + Math.floor(rl() * 2200), lit:rl() });
      if (rl() < 0.5)  segs[i].sprites.push({ t:"tree", off:(rl() < 0.5 ? -1 : 1) * (1.36 + rl() * 0.5), h:1500 + Math.floor(rl() * 900), w:900 + Math.floor(rl() * 500) });
      if (rl() < 0.3)  segs[i].sprites.push({ t:"lamp", off:(rl() < 0.5 ? -1 : 1) * 1.28, h:1900, w:90 });
      if (rl() < 0.22) segs[i].sprites.push({ t:"sign", off:(rl() < 0.5 ? -1 : 1) * (1.44 + rl() * 0.3), h:900, w:700 });   // 单元门牌/门禁
    }

    /* ── 订单：绿灯柜 + 楼下顾客，沿整圈均匀铺开 ── */
    var orderCount = mode.orders[Math.min(d, mode.orders.length) - 1] || 6;
    var orders = [], decoys = [], items = [], helps = [], hz = [];
    var orng = makeRng((((seed >>> 0) || 12345) ^ (d * 0xC2B2AE35)) >>> 0);
    var span = total / orderCount;
    for (i = 0; i < orderCount; i++) {
      var at = limit(Math.floor((i + 0.5) * span + (orng() - 0.5) * span * 0.5), 60, total - 40);
      var isHand = orng() < 0.40;                       // 40% 是擦身递餐
      var o = {
        n: i + 1, seg: at, z: at * TUNE.SEG_LEN, side: (orng() < 0.5 ? -1 : 1),
        kind: isHand ? "handoff" : "locker",
        lit: "green",
        state: "pending", perfect: false, spilled: false, over: false
      };
      segs[at].orders.push(o);
      orders.push(o);
    }
    /* 红灯柜 = 别人的单（"读灯"这条判断轴）。随机铺，且与任何订单拉开**至少一个投掷窗口**
       （APPROACH + 8 段）—— 否则红灯柜和绿灯柜会同时落进一个投掷窗口，
       按下空格时"投哪一个"就不再取决于玩家读灯，而是取决于谁离得近，
       这条判断轴等于作废。找不到足够远的位置就少放一个，不硬塞。 */
    var decoyWant = Math.max(3, Math.round(orderCount * 0.7));
    for (i = 0; i < decoyWant; i++) {
      var dat = -1, tries, cand, far, k;
      for (tries = 0; tries < 40; tries++) {
        cand = limit(Math.floor(orng() * (total - 80)) + 40, 30, total - 20);
        far = true;
        for (k = 0; k < orders.length; k++) {
          if (Math.abs(orders[k].seg - cand) < TUNE.APPROACH + 8) { far = false; break; }
        }
        if (far && !segs[cand].decoys.length) { dat = cand; break; }
      }
      if (dat < 0) continue;
      var dc = { seg:dat, z:dat * TUNE.SEG_LEN, side:(orng() < 0.5 ? -1 : 1), lit:"red", n:0, done:false };
      segs[dat].decoys.push(dc);
      decoys.push(dc);
    }

    /* ── 补给点：取餐点（**骑过去自动补满**保温箱，不用按键 —— 键位留给两个投递动词）── */
    for (i = 1; i <= 4; i++) {
      var iat = limit(Math.floor(total * i / 5 + orng() * 10), 30, total - 20);
      var it = { t:"pickup", seg:iat, z:iat * TUNE.SEG_LEN, side:(i % 2 ? 1 : -1), used:false };
      segs[iat].items.push(it); items.push(it);
    }
    /* ── 帮带点：顺手帮带 +200（按 F）── */
    var helpCount = 2 + Math.floor(d / 3);
    for (i = 1; i <= helpCount; i++) {
      var hat = limit(Math.floor(total * (i - 0.5) / helpCount + orng() * 16), 30, total - 20);
      var hp = { t:"help", seg:hat, z:hat * TUNE.SEG_LEN, side:(orng() < 0.5 ? -1 : 1) };
      segs[hat].items.push(hp); helps.push(hp);
    }

    /* ── 危险：**按间距铺**，不按比例。
       按比例会在长赛道上铺出几百个障碍挤成一片；按间距才能保证"每隔多少米一个"的手感。
       第 1 天每 50 段一个，第 7 天每 26 段一个。 ── */
    var hstep = 54 - d * 4;
    var hkind = ["dog","child","car","bin","cone","pothole","drain","puddle","ball","rccar","dog","child"];
    for (i = 60; i < total - 30; i += hstep) {
      var hat2 = limit(i + Math.floor((orng() - 0.5) * hstep * 0.5), 40, total - 20);
      var kind = hkind[Math.floor(orng() * hkind.length)];
      var hzx = (orng() < 0.5 ? -1 : 1) * (orng() * 0.86);
      var hzr = { kind:kind, seg:hat2, z:hat2 * TUNE.SEG_LEN, x:hzx, tier:HAZARDS[kind].tier, done:false };
      segs[hat2].hazards.push(hzr); hz.push(hzr);
    }
    /* ── 景观池：路面外侧连成一片（骑进去就洒汤）。宽 2200 单位 ≈ 7 米 ── */
    for (i = 0; i < total; i += 90) {
      var pside = (rl() < 0.5 ? -1 : 1) * 1.55;
      for (j = 0; j < 10 && i + j < total; j++) segs[i + j].sprites.push({ t:"pond", off:pside, h:160, w:2200 });
    }
    /* ── 保安岗：逆行会被拦下 ── */
    var gstep = Math.floor(total / 9);
    for (i = gstep; i < total; i += gstep) {
      segs[i].guard = true;
      segs[i].sprites.push({ t:"guard", off:-1.18, h:530, w:190 });
    }

    /* 标准用时：按 60% 巡航跑完全程 + 12% 余量。
       提前收工奖励 = (parTime − 实际用时) × SPEED_RATE，所以 parTime 必须**贴着可达时间**，
       定成"三倍宽裕"会让奖励变成白送。 */
    var parTime = (total * TUNE.SEG_LEN) / (TUNE.MAX_SPEED * TUNE.CRUISE) * 1.12;

    return {
      day: d, segments: segs, total: total,
      length: total * TUNE.SEG_LEN,
      orders: orders, decoys: decoys, items: items, helps: helps, hazards: hz,
      orderCount: orderCount, parTime: parTime
    };
  }

  /* ── 找出玩家前方 range 段内、还没被引开的狗 ──
     放在纯函数层是为了**可测**：扫描上界必须是 range 本身，
     一旦有人再写死一个小常数（曾经是 8），DOG_RANGE 调多大都没用，
     而画面上完全看不出来。单测直接构造赛道验边界。 */
  function findDogNear(route, pd, range) {
    var n = route.total;
    var pIdx = Math.floor(pd / TUNE.SEG_LEN) % n;
    var span = Math.max(8, Math.round(range));
    var i, k, sg, hz, d;
    for (k = -1; k <= span; k++) {
      sg = route.segments[(pIdx + k + n) % n];
      for (i = 0; i < sg.hazards.length; i++) {
        hz = sg.hazards[i];
        if (hz.done || hz.kind !== "dog") continue;
        d = hz.z - pd;
        if (d > -TUNE.SEG_LEN && d < range * TUNE.SEG_LEN) return hz;
      }
    }
    return null;
  }

  /* ── 计分：唯一入口 ──
     未登记的事件返回 0（所以逆行永远 0 分 —— 结构上做不到加分）。 */
  function scoreOf(kind, streak, extra) {
    if (!Object.prototype.hasOwnProperty.call(SCORE_TABLE, kind)) return 0;
    if (kind === "deliver") {
      var s = limit(streak | 0, 1, TUNE.STREAK_CAP);
      return SCORE_TABLE.deliver * s;
    }
    if (kind === "speed") return Math.max(0, Math.round((extra || 0) * TUNE.SPEED_RATE));
    return SCORE_TABLE[kind];
  }

  /* ── 接近进度 t：0 = 刚进窗口，1 = 到达目标；-1 = 已过，-2 = 还没进窗口 ── */
  function approachT(orderZ, playerZ, windowLen) {
    var d = orderZ - playerZ;
    var win = windowLen || (TUNE.APPROACH * TUNE.SEG_LEN);
    if (d < 0) return -1;
    if (d > win) return -2;
    return 1 - d / win;
  }

  /* ── 投递判定：三条轴（身位 / 时机 / 灯色由调用方另判）──
     返回 {ok, perfect, why}。why 取值：early / late / wrongside / ok */
  function judgeDeliver(order, playerZ, playerX, isHand) {
    var win = (isHand ? TUNE.APPROACH_HAND : TUNE.APPROACH) * TUNE.SEG_LEN;
    var t = approachT(order.z, playerZ, win);
    if (t === -1) return { ok:false, perfect:false, why:"late",      t:t };
    if (t === -2) return { ok:false, perfect:false, why:"early",     t:t };
    if (playerX * order.side <= TUNE.LATERAL) return { ok:false, perfect:false, why:"wrongside", t:t };
    var near = Math.abs(t - TUNE.SWEET);
    if (near <= TUNE.SWEET_TOL) return { ok:true, perfect:true,  why:"ok", t:t };
    if (near <= TUNE.HIT_TOL)   return { ok:true, perfect:false, why:"ok", t:t };
    return { ok:false, perfect:false, why:(t < TUNE.SWEET ? "early" : "late"), t:t };
  }

  /* ── 评级：阈值照抄原作 ── */
  function gradeOf(perfect, delivered, total) {
    if (total > 0 && perfect) return "S";
    if (total > 0 && delivered / total >= 0.8) return "A";
    if (total > 0 && delivered / total >= 0.5) return "B";
    return "C";
  }

  function payoutOf(score, modeId) {
    var lad = PAYOUT[modeId] || PAYOUT.shift;
    var pay = 0;
    for (var i = 0; i < lad.length; i++) if (score >= lad[i].min) pay = lad[i].pay;
    return pay;
  }

  /* ── 蒙卡：纯函数整局自跑，不开浏览器就能出分数分布 ──
     用途只有一个：给赔付阶梯定数、并让"经济不变量"能被断言。
     关键纪律：**得分必须走同一套 scoreOf/判定语义**，否则模拟与实机漂移，
     定出来的阶梯就是错的。 */
  function simulateShift(modeId, skill, seed, opt) {
    opt = opt || {};
    var mode = MODES[modeId] || MODES.shift;
    var wrongway = !!opt.wrongway;              // 只影响用时与罚款，**不影响分数**
    var s = limit(+skill || 0, 0, 1);
    var rng = makeRng(((seed >>> 0) || 777) ^ 0x5BF03635);
    /* ⚠ 违规相关的随机必须走**独立**的 rng：
       若和主序列共用，逆行分支多消耗一个随机数就会把后续所有订单的命中结果整体挪位，
       「逆行不改变分数」这条不变量就永远测不出来（测出来的差异是随机序列错位，不是逆行造成的）。 */
    var grng = makeRng((((seed >>> 0) || 777) ^ 0x27D4EB2F) >>> 0);

    var st = {
      score:0, delivered:0, total:0, perfectHits:0, mistakes:0, spilled:0, wrong:0,
      streak:0, bestStreak:0, perfectStreak:0, fines:0, time:0, parTime:0,
      tips:0, helps:0, dog:0, cleanBonus:0, speedBonus:0, scoreNoSpeed:0, days:0, gameOver:false
    };

    for (var d = 1; d <= mode.days; d++) {
      var route = buildRoute(d, (seed >>> 0) || 777, modeId);
      var orders = route.orders;
      var dDelivered = 0, dSpilled = 0, dWrong = 0, dHelps = 0, dDogs = 0;
      var mistakesAtStart = st.mistakes;
      st.total += orders.length;
      st.days++;
      st.parTime += route.parTime;

      /* 每单：完美 / 命中 / 漏送 / 送错（读错灯）—— 概率由 skill 推 */
      var pPerfect = 0.62 * s;
      var pHit     = 0.30 * s;
      var pWrong   = 0.16 * (1 - s);
      for (var i = 0; i < orders.length; i++) {
        var r = rng();
        if (r < pPerfect) {
          st.streak++; if (st.streak > st.bestStreak) st.bestStreak = st.streak;
          st.delivered++; dDelivered++; st.perfectHits++;
          st.perfectStreak++;
          st.score += scoreOf("deliver", st.streak) + scoreOf("perfect");
          /* 好评打赏：**连 3 单精准**才给 —— 与实机 resolveDeliver 完全同一条规则。
             这里必须复刻，不能"估个比例"：模拟与实机一旦漂移，赔付阶梯就是照错的分布定的。 */
          if (st.perfectStreak % 3 === 0) { st.tips++; st.score += scoreOf("tip"); }
        } else if (r < pPerfect + pHit) {
          st.streak++; if (st.streak > st.bestStreak) st.bestStreak = st.streak;
          st.delivered++; dDelivered++;
          st.perfectStreak = 0;
          st.score += scoreOf("deliver", st.streak);
        } else if (r < pPerfect + pHit + pWrong) {
          st.wrong++; dWrong++; st.streak = 0; st.perfectStreak = 0;   // 投到红灯柜：清连送
        } else {
          st.streak = 0; st.perfectStreak = 0;                          // 漏送
        }
      }

      /* 帮带：按 F 顺手捎上 */
      dHelps = Math.round(route.helps.length * Math.min(1, 0.35 + 0.6 * s));
      st.helps += dHelps;
      st.score += dHelps * scoreOf("help");

      /* 引开恶犬 */
      var dogs = 0, k;
      for (k = 0; k < route.hazards.length; k++) if (route.hazards[k].kind === "dog") dogs++;
      dDogs = Math.round(dogs * Math.min(1, 0.3 + 0.65 * s));
      st.dog += dDogs;
      st.score += dDogs * scoreOf("dog");

      /* 两级危险：skill 越低越容易吃。
         ⚠ 碰撞次数必须**按危险点数量摊开**算，不能一天只掷一次 —— 一天掷一次的话
         单日最多吃到 1 次失误，而 MISTAKES_MAX 是 3，于是"3 次失误当班结束"
         这条规则在单班/高峰模式下永远触发不了（等于没写）。
         现在按 危险点数 × 系数 × (1-skill)² 得到当日期望碰撞数再取整。 */
      var bad = 1 - s;
      dSpilled = Math.round(route.hazards.length * 0.10 * bad);
      st.spilled += dSpilled;
      var expColl = route.hazards.length * 0.11 * bad * bad;
      var coll = Math.floor(expColl + rng());
      if (coll > 0) st.mistakes += Math.min(TUNE.MISTAKES_MAX - st.mistakes, coll);

      /* 用时：逆行省时间（这是逆行唯一的收益） */
      var t = route.parTime * (1.30 - 0.40 * s);
      if (wrongway) {
        t *= 0.88;
        /* 被保安拦下的概率与罚款 —— 只动钱，不动分 */
        if (grng() < 0.42) { st.fines += TUNE.FINE; t += TUNE.GUARD_HOLD; }
      }
      st.time += t;

      /* 整班零失误：**按天判**（一周档里"这一天跑得干净"就该给），不是整周累计 */
      if (st.mistakes === mistakesAtStart && dSpilled === 0 && dDelivered === orders.length) {
        st.cleanBonus++;
        st.score += scoreOf("clean");
      }

      if (st.mistakes >= TUNE.MISTAKES_MAX) { st.gameOver = true; break; }
    }

    /* 提前收工奖励（与实机同一公式）。
       ⚠ scoreNoSpeed 是**加时间奖励之前**的分数：单测靠它断言
       「逆行不改变分数」—— 逆行的收益只体现为时间（进而体现在速度奖励上），
       和"骑得快"拿到的奖励是同一种，不是给违规单独发分。 */
    st.scoreNoSpeed = st.score;
    st.speedBonus = scoreOf("speed", 0, Math.max(0, st.parTime - st.time));
    st.score += st.speedBonus;

    st.payout = payoutOf(st.score, modeId);
    st.net = st.payout - TUNE.ENTRY - st.fines;
    st.perfect = !st.gameOver && st.delivered === st.total && st.mistakes === 0;
    st.grade = gradeOf(st.perfect, st.delivered, st.total);
    return st;
  }

  /* 把上面这些挂到 exports 上（单测与渲染层共用同一份实现） */
  var rules = {
    makeRng: makeRng, project: project, buildRoute: buildRoute, planRoute: planRoute,
    scoreOf: scoreOf, SCORE_TABLE: SCORE_TABLE, judgeDeliver: judgeDeliver,
    approachT: approachT, gradeOf: gradeOf, payoutOf: payoutOf,
    findDogNear: findDogNear,
    simulateShift: simulateShift, limit: limit,
    MODES: MODES, PAYOUT: PAYOUT, TUNE: TUNE, HAZARDS: HAZARDS
  };

  /* ── 调试钩子容器：**必须在这里就建成对象**。
     若写成 var debug = {…} 放在文件后半段，本文件的导出赋值会先执行、
     捕获到 undefined —— var 只提升声明不提升赋值，函数声明才整份提升。 ── */
  var debug = {};

  /* ═════════════════ 3. 渲染层 + 对局循环 ═════════════════
     这一层只碰 canvas 与事件，不算经济：所有得分/判定都回上面那层纯函数，
     保证「模拟里验过的数」与「实机跑出来的数」是同一套。 */

  var G = null;                                   // 当前对局（null = 没开局）
  var hostEl = null, cv = null, ctx = null, W = 960, H = 540;
  var rafId = 0, lastTs = 0, running = false;
  var opts0 = null;                               // start() 传进来的 opts，settle/finish 回调要用
  var K = { left:false, right:false, up:false, down:false };
  var ptr = { on:false, id:0, x0:0, y0:0, x:0, y:0, t0:0, steer:0, moved:0 };
  var toastList = [];

  var COL = {
    skyTop:"#101528", skyBot:"#2c2340", haze:"#4a3a5c",
    grass1:"#171d2b", grass2:"#141924",
    road1:"#2c2c35", road2:"#272730",
    oncom:"#21222c",                                  // 对向车道（略冷略暗）
    rumble1:"#c9a24a", rumble2:"#8a6f31",
    lane:"#7d7663", curb:"#3c3c49",
    body:"#e9e3d1", bodyDark:"#23252f", box:"#2f8f7a", boxLid:"#1b6355",
    helmet:"#ffd23c", rider:"#1f3f3a",
    green:"#5dffa0", red:"#ff4d6d", gold:"#ffd76e", cyan:"#4dd8ff",
    dim:"#8d8aa0", ink:"#0b0a13"
  };

  function beep(f, d, t, g) { try { if (root.AudioSys && root.AudioSys.blip) root.AudioSys.blip(f, d, t, g); } catch (e) {} }
  function sfx(n) { try { if (root.AudioSys && root.AudioSys.play) root.AudioSys.play(n); } catch (e) {} }
  function pushToast(s, col) { toastList.push({ s:s, col:col || COL.gold, t:1.6 }); if (toastList.length > 4) toastList.shift(); }

  function txt(s, x, y, size, color, align, weight) {
    ctx.font = (weight || "bold") + " " + size + "px 'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
    ctx.textAlign = align || "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }
  function roundRect(g, x, y, w, h, r) {
    if (w <= 0 || h <= 0) return;
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  /* ── 3.1 画布 ── */
  function fitCanvas() {
    if (!cv || !hostEl) return;
    var rect = hostEl.getBoundingClientRect ? hostEl.getBoundingClientRect() : null;
    var w = Math.max(560, Math.round((rect && rect.width) || 960));
    var h = Math.round(w * 9 / 16);
    if (h > 620) { h = 620; }
    W = w; H = h;
    cv.width = W; cv.height = h;
    cv.style.width = "100%"; cv.style.height = h + "px";
  }

  /* ── 3.2 精灵绘制器 ──
     统一约定：sx = 该精灵所在路面点的屏幕 x，syBase = 路面点屏幕 y，
     sc = 路段投射 scale。世界单位的尺寸换算成像素 = sc × 单位 × W/2。
     clipY 是山丘遮挡线（段的 seg.clip），低于它的部分被裁掉。 */
  function clipDraw(clipY, fn) {
    if (clipY > 0 && clipY < H) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, clipY); ctx.clip(); fn(); ctx.restore();
    } else fn();
  }

  var DRAW = {
    building: function (sx, sy, sc, sp) {
      var dw = sc * sp.w * W / 2, dh = sc * sp.h * W / 2;
      if (dw < 1.5 || dh < 1.5) return;
      var x = sx - dw / 2, y = sy - dh;
      ctx.fillStyle = (sp.lit > 0.55) ? "#2b3149" : "#242938";
      ctx.fillRect(x, y, dw, dh);
      ctx.fillStyle = "rgba(0,0,0,.38)";
      ctx.fillRect(x, y, dw, Math.max(1, dh * 0.05));
      if (dw > 16 && dh > 16) {
        /* 窗户：固定 6 个候选位，按 sp.lit 决定亮哪几个。
           ⚠ 不要写 rows×cols 双层循环逐窗填 —— 视野里同时有几十栋楼，
           逐窗填充会一帧几千次 fillRect，直接掉帧。 */
        var seed = Math.round(sp.lit * 997), k, wx, wy, on;
        for (k = 0; k < 6; k++) {
          on = ((seed + k * 37) % 5) < 2;
          wx = x + dw * (0.16 + (k % 2) * 0.42);
          wy = y + dh * (0.14 + Math.floor(k / 2) * 0.26);
          ctx.fillStyle = on ? "rgba(255,215,110,.50)" : "rgba(130,150,200,.13)";
          ctx.fillRect(wx, wy, dw * 0.30, dh * 0.13);
        }
      }
    },
    tree: function (sx, sy, sc, sp) {
      var dw = sc * sp.w * W / 2, dh = sc * sp.h * W / 2;
      if (dw < 1 || dh < 1) return;
      ctx.fillStyle = "#3b2c22";
      ctx.fillRect(sx - dw * 0.06, sy - dh * 0.34, dw * 0.12, dh * 0.34);
      ctx.fillStyle = "#1f3d2b";
      ctx.beginPath();
      ctx.ellipse(sx, sy - dh * 0.62, dw * 0.5, dh * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(93,255,160,.13)";
      ctx.beginPath();
      ctx.ellipse(sx - dw * 0.14, sy - dh * 0.74, dw * 0.26, dh * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
    },
    lamp: function (sx, sy, sc, sp) {
      var dw = Math.max(1, sc * sp.w * W / 2), dh = sc * sp.h * W / 2;
      if (dh < 1) return;
      ctx.fillStyle = "#4a4a58";
      ctx.fillRect(sx - dw / 2, sy - dh, dw, dh);
      ctx.fillStyle = "rgba(255,215,110,.75)";
      ctx.beginPath(); ctx.arc(sx, sy - dh, Math.max(1, dw * 1.6), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,215,110,.09)";
      ctx.beginPath(); ctx.arc(sx, sy - dh, Math.max(2, dw * 5), 0, Math.PI * 2); ctx.fill();
    },
    sign: function (sx, sy, sc, sp) {
      var dw = sc * sp.w * W / 2, dh = sc * sp.h * W / 2;
      if (dw < 2 || dh < 2) return;
      ctx.fillStyle = "#2a2f42";
      ctx.fillRect(sx - dw / 2, sy - dh, dw, dh);
      ctx.strokeStyle = "rgba(201,162,74,.6)"; ctx.lineWidth = Math.max(1, dw * 0.03);
      ctx.strokeRect(sx - dw / 2, sy - dh, dw, dh);
      if (dw > 18) { ctx.fillStyle = "rgba(93,255,160,.5)"; ctx.fillRect(sx - dw * 0.3, sy - dh * 0.62, dw * 0.6, dh * 0.16); }
    },
    pond: function (sx, sy, sc, sp) {
      var dw = sc * sp.w * W / 2, dh = Math.max(2, sc * sp.w * 0.22 * W / 2);
      if (dw < 2) return;
      ctx.fillStyle = "#1d3550";
      ctx.beginPath(); ctx.ellipse(sx, sy, dw / 2, dh / 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(77,216,255,.20)";
      ctx.beginPath(); ctx.ellipse(sx - dw * 0.12, sy - dh * 0.12, dw * 0.3, dh * 0.24, 0, 0, Math.PI * 2); ctx.fill();
    },
    guard: function (sx, sy, sc, sp) {
      var dw = Math.max(1.5, sc * sp.w * W / 2), dh = sc * sp.h * W / 2;
      if (dh < 2) return;
      ctx.fillStyle = "#20304a";                       // 保安制服
      ctx.fillRect(sx - dw / 2, sy - dh * 0.62, dw, dh * 0.62);
      ctx.fillStyle = "#e8dfc6";                       // 脸
      ctx.beginPath(); ctx.arc(sx, sy - dh * 0.74, dw * 0.42, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#1b2a3f";                       // 大檐帽
      ctx.fillRect(sx - dw * 0.6, sy - dh * 0.92, dw * 1.2, dh * 0.12);
    }
  };

  /* 订单目标：绿灯柜（你的单）/ 红灯柜（别人的单，投了算送错）/ 楼下等的顾客 */
  function drawLocker(sx, sy, sc, lit, glow) {
    var w = sc * 620 * W / 2, h = sc * 780 * W / 2;      // 2 米 × 2.5 米
    if (w < 3 || h < 3) return;
    var x = sx - w / 2, y = sy - h;
    ctx.fillStyle = "#2b3040"; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(255,255,255,.14)"; ctx.lineWidth = Math.max(1, w * 0.012);
    ctx.strokeRect(x, y, w, h);
    /* 3×3 格柜，只有中间一列亮 —— 缩到几十像素也读得出"亮/不亮" */
    var on = (lit === "green") ? COL.green : COL.red;
    var cw = w / 3.6, ch = h / 4.2, r, c;
    for (r = 0; r < 3; r++) for (c = 0; c < 3; c++) {
      var isLit = (c === 1 && r === 1);
      ctx.fillStyle = isLit ? on : "rgba(255,255,255,.07)";
      ctx.fillRect(x + w * 0.10 + c * cw, y + h * 0.10 + r * ch, cw * 0.78, ch * 0.78);
    }
    if (glow > 0) {
      ctx.fillStyle = (lit === "green") ? "rgba(93,255,160," + (0.20 * glow) + ")" : "rgba(255,77,109," + (0.18 * glow) + ")";
      ctx.beginPath(); ctx.arc(sx, sy - h * 0.62, Math.max(3, w * 1.5), 0, Math.PI * 2); ctx.fill();
    }
  }
  function drawCustomer(sx, sy, sc, wave) {
    var w = Math.max(1.6, sc * 360 * W / 2), h = sc * 1700 * W / 2;
    if (h < 3) return;
    ctx.fillStyle = "#33405c"; ctx.fillRect(sx - w * 0.28, sy - h * 0.66, w * 0.56, h * 0.66);   // 身体
    ctx.fillStyle = "#e8d6b8";
    ctx.beginPath(); ctx.arc(sx, sy - h * 0.76, w * 0.26, 0, Math.PI * 2); ctx.fill();            // 头
    /* 举起的手 + 手机微光：一眼看出"在等人/能递" */
    ctx.fillStyle = "#33405c";
    ctx.fillRect(sx + w * 0.22, sy - h * (0.90 + 0.06 * wave), w * 0.13, h * 0.30);
    ctx.fillStyle = "rgba(77,216,255,.85)";
    ctx.fillRect(sx + w * 0.20, sy - h * (0.92 + 0.06 * wave), w * 0.18, h * 0.05);
  }
  function drawHazard(sx, sy, sc, hz) {
    var w = sc * hz.w * W / 2, h = sc * hz.h * W / 2;
    if (w < 1.2) return;
    switch (hz.kind) {
      case "dog":
        ctx.fillStyle = "#6b5334";
        ctx.beginPath(); ctx.ellipse(sx, sy - h * 0.42, w * 0.46, h * 0.26, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(sx + w * 0.42, sy - h * 0.58, w * 0.19, 0, Math.PI * 2); ctx.fill();
        ctx.fillRect(sx - w * 0.34, sy - h * 0.24, w * 0.1, h * 0.24);
        ctx.fillRect(sx + w * 0.2, sy - h * 0.24, w * 0.1, h * 0.24);
        break;
      case "child":
        ctx.fillStyle = "#c85a7a"; ctx.fillRect(sx - w * 0.24, sy - h * 0.6, w * 0.48, h * 0.6);
        ctx.fillStyle = "#e8d6b8"; ctx.beginPath(); ctx.arc(sx, sy - h * 0.72, w * 0.26, 0, Math.PI * 2); ctx.fill();
        break;
      case "car":
        ctx.fillStyle = "#3a4056"; roundRect(ctx, sx - w / 2, sy - h, w, h, h * 0.22); ctx.fill();
        ctx.fillStyle = "rgba(140,180,230,.30)";
        ctx.fillRect(sx - w * 0.32, sy - h * 0.86, w * 0.64, h * 0.34);
        ctx.fillStyle = "#ff4d6d";
        ctx.fillRect(sx - w * 0.54, sy - h * 0.30, w * 0.10, h * 0.12);
        ctx.fillRect(sx + w * 0.44, sy - h * 0.30, w * 0.10, h * 0.12);
        break;
      case "bin":
        ctx.fillStyle = "#2f4a3a"; roundRect(ctx, sx - w / 2, sy - h, w, h, w * 0.12); ctx.fill();
        ctx.fillStyle = "#3d6350"; ctx.fillRect(sx - w * 0.56, sy - h, w * 1.12, h * 0.14);
        break;
      case "cone":
        ctx.fillStyle = "#e2762c";
        ctx.beginPath(); ctx.moveTo(sx, sy - h); ctx.lineTo(sx + w / 2, sy); ctx.lineTo(sx - w / 2, sy); ctx.closePath(); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.fillRect(sx - w * 0.28, sy - h * 0.52, w * 0.56, h * 0.13);
        break;
      case "pothole": case "drain":
        ctx.fillStyle = (hz.kind === "drain") ? "#20242e" : "#12151c";
        ctx.beginPath(); ctx.ellipse(sx, sy - 1, w / 2, Math.max(2, w * 0.16), 0, 0, Math.PI * 2); ctx.fill();
        if (hz.kind === "drain") { ctx.strokeStyle = "rgba(160,160,180,.35)"; ctx.lineWidth = 1; ctx.stroke(); }
        break;
      case "puddle":
        ctx.fillStyle = "rgba(60,120,180,.42)";
        ctx.beginPath(); ctx.ellipse(sx, sy - 1, w / 2, Math.max(2, w * 0.14), 0, 0, Math.PI * 2); ctx.fill();
        break;
      case "ball":
        ctx.fillStyle = "#e8e2d0"; ctx.beginPath(); ctx.arc(sx, sy - h * 0.5, w * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#2b3040"; ctx.beginPath(); ctx.arc(sx, sy - h * 0.5, w * 0.18, 0, Math.PI * 2); ctx.fill();
        break;
      case "rccar":
        ctx.fillStyle = "#c94f4f"; roundRect(ctx, sx - w / 2, sy - h, w, h, h * 0.3); ctx.fill();
        ctx.fillStyle = "#20222c";
        ctx.beginPath(); ctx.arc(sx - w * 0.3, sy - 1, w * 0.11, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(sx + w * 0.3, sy - 1, w * 0.11, 0, Math.PI * 2); ctx.fill();
        break;
      default:
        ctx.fillStyle = "#3a4056"; ctx.fillRect(sx - w / 2, sy - Math.max(2, h), w, Math.max(2, h));
    }
  }
  function drawItem(sx, sy, sc, it) {
    var w = sc * 1100 * W / 2, h = sc * 1300 * W / 2;
    if (w < 3) return;
    if (it.t === "pickup") {                       // 取餐点：带棚的档口 + 餐袋
      ctx.fillStyle = "#2a3a34"; ctx.fillRect(sx - w / 2, sy - h * 0.8, w, h * 0.8);
      ctx.fillStyle = "#c9a24a"; ctx.fillRect(sx - w * 0.56, sy - h * 0.92, w * 1.12, h * 0.13);
      ctx.fillStyle = "#e9e3d1"; ctx.fillRect(sx - w * 0.22, sy - h * 0.5, w * 0.44, h * 0.3);
      ctx.fillStyle = "rgba(93,255,160,.85)";
      ctx.fillRect(sx - w * 0.3, sy - h * 0.98, w * 0.6, h * 0.04);
    } else {                                        // 帮带点：待捎的快递
      ctx.fillStyle = "#8a6a3a"; ctx.fillRect(sx - w * 0.32, sy - h * 0.42, w * 0.64, h * 0.42);
      ctx.fillStyle = "#c9a24a"; ctx.fillRect(sx - w * 0.04, sy - h * 0.42, w * 0.08, h * 0.42);
      ctx.fillStyle = "rgba(255,215,110,.85)";      // 向上的箭头 = 捎上
      ctx.beginPath();
      ctx.moveTo(sx, sy - h * 0.72); ctx.lineTo(sx + w * 0.16, sy - h * 0.52);
      ctx.lineTo(sx - w * 0.16, sy - h * 0.52); ctx.closePath(); ctx.fill();
    }
  }

  /* ── 3.3 玩家（电动车 + 骑手），屏幕空间固定位置 ── */
  function drawPlayer(speedPct, steer, bounce) {
    var cx = W / 2 + steer * W * 0.035, base = H - Math.round(H * 0.055) + bounce;
    var bw = Math.max(120, W * 0.20), bh = bw * 0.68;
    ctx.save();
    ctx.translate(cx, base);
    ctx.fillStyle = "rgba(0,0,0,.35)";                                  // 地面影子
    ctx.beginPath(); ctx.ellipse(0, 0, bw * 0.44, bh * 0.09, 0, 0, Math.PI * 2); ctx.fill();
    var wy = -bh * 0.20, wr = bh * 0.20;
    ctx.fillStyle = COL.bodyDark;                                       // 轮子
    ctx.beginPath(); ctx.arc(-bw * 0.32, wy, wr, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc( bw * 0.32, wy, wr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#8f8a76";
    ctx.beginPath(); ctx.arc(-bw * 0.32, wy, wr * 0.42, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc( bw * 0.32, wy, wr * 0.42, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COL.body;                                           // 踏板车身
    roundRect(ctx, -bw * 0.36, -bh * 0.52, bw * 0.72, bh * 0.26, bh * 0.1); ctx.fill();
    ctx.fillStyle = COL.rider;                                          // 骑手
    roundRect(ctx, -bw * 0.15, -bh * 0.94, bw * 0.30, bh * 0.44, bh * 0.12); ctx.fill();
    ctx.fillStyle = COL.helmet;
    ctx.beginPath(); ctx.arc(0, -bh * 1.00, bh * 0.17, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1b1d26";
    ctx.beginPath(); ctx.arc(bw * 0.06, -bh * 1.02, bh * 0.10, 0, Math.PI * 2); ctx.fill();
    /* 后座保温箱：外卖的身份标识，永远是画面里最跳的一块 */
    var box = bw * 0.30, by = -bh * 0.86;
    ctx.fillStyle = COL.box; roundRect(ctx, -bw * 0.40 - box * 0.5, by, box, box * 0.86, box * 0.14); ctx.fill();
    ctx.fillStyle = COL.boxLid; ctx.fillRect(-bw * 0.40 - box * 0.5, by, box, box * 0.2);
    ctx.fillStyle = "#e9e3d1";
    ctx.fillRect(-bw * 0.40 - box * 0.22, by + box * 0.36, box * 0.44, box * 0.12);
    if (speedPct > 0.75) {                                              // 高速时的速度线
      ctx.strokeStyle = "rgba(255,255,255,.16)"; ctx.lineWidth = 2;
      for (var i = 0; i < 3; i++) {
        var ly = -bh * (0.3 + i * 0.22);
        ctx.beginPath(); ctx.moveTo(-bw * (0.5 + i * 0.08), ly); ctx.lineTo(-bw * (0.9 + i * 0.12), ly); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ── 3.4 主渲染 ── */
  function findSegment(z) {
    var t = G.route;
    return t.segments[Math.floor(z / TUNE.SEG_LEN) % t.total];
  }
  function pctRemain(z, len) { return (z % len) / len; }
  function interp(a, b, p) { return a + (b - a) * p; }

  function render() {
    if (!G || !ctx) return;
    var t = G.route;
    var camZ = G.position;
    var baseSeg = findSegment(camZ);
    var basePct = pctRemain(camZ, TUNE.SEG_LEN);
    var pSeg = findSegment(camZ + G.playerZ);
    var pPct = pctRemain(camZ + G.playerZ, TUNE.SEG_LEN);
    var playerY = interp(pSeg.p1.world.y, pSeg.p2.world.y, pPct);
    var camY = playerY + TUNE.CAM_H;
    var maxy = H, x = 0, dx = -(baseSeg.curve * basePct), n, i, seg;

    /* 天与远景 */
    var sky = ctx.createLinearGradient(0, 0, 0, H * 0.55);
    sky.addColorStop(0, COL.skyTop); sky.addColorStop(1, COL.skyBot);
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = COL.grass1; ctx.fillRect(0, H * 0.5, W, H * 0.5);
    if (G.wrongway) {                                  // 逆行：整屏压一层红
      ctx.fillStyle = "rgba(255,77,109,.07)"; ctx.fillRect(0, 0, W, H);
    }

    /* 路面（近 → 远；maxy 保证山坡后面的段不覆盖近处） */
    var drawn = [];
    for (n = 0; n < TUNE.DRAW_DIST; n++) {
      seg = t.segments[(baseSeg.index + n) % t.total];
      seg.looped = seg.index < baseSeg.index;
      seg.fog = Math.exp(-TUNE.FOG * Math.pow(n / TUNE.DRAW_DIST, 2));
      seg.clip = maxy;
      project(seg.p1, G.playerX * TUNE.ROAD_W - x, camY, camZ - (seg.looped ? t.length : 0), G.camDepth, W, H, TUNE.ROAD_W);
      project(seg.p2, G.playerX * TUNE.ROAD_W - x - dx, camY, camZ - (seg.looped ? t.length : 0), G.camDepth, W, H, TUNE.ROAD_W);
      x += dx; dx += seg.curve;
      if (!(seg.p1.camera.z > G.camDepth) || seg.p2.screen.y >= seg.p1.screen.y || seg.p2.screen.y >= maxy) continue;
      drawSegment(seg);
      drawn.push(seg);
      maxy = seg.p2.screen.y;
    }

    /* 精灵：**远 → 近**（否则近处的会被远处覆盖） */
    for (n = drawn.length - 1; n >= 0; n--) {
      seg = drawn[n];
      for (i = 0; i < seg.sprites.length; i++) drawSegSprite(seg, seg.sprites[i]);
    }
    for (n = drawn.length - 1; n >= 0; n--) {
      seg = drawn[n];
      for (i = 0; i < seg.items.length; i++) drawSegItem(seg, seg.items[i]);
      for (i = 0; i < seg.hazards.length; i++) drawSegHazard(seg, seg.hazards[i]);
      for (i = 0; i < seg.decoys.length; i++) drawSegLocker(seg, seg.decoys[i], false);
      for (i = 0; i < seg.orders.length; i++) {
        if (seg.orders[i].state === "pending") drawSegLocker(seg, seg.orders[i], true);
      }
    }
    /* 迎面来车（不属于任何段，按 z 现算屏幕位置） */
    for (i = 0; i < G.oncom.length; i++) drawOncoming(G.oncom[i]);

    drawPlayer(G.speed / TUNE.MAX_SPEED, G.steerVis, G.bounce);
    drawHud();
  }

  function fogOver(fog) { return "rgba(16,21,40," + (1 - fog).toFixed(3) + ")"; }

  function drawSegment(seg) {
    var p1 = seg.p1.screen, p2 = seg.p2.screen;
    var grass = seg.dark ? COL.grass1 : COL.grass2;
    var road  = seg.dark ? COL.road1  : COL.road2;
    var rum   = seg.dark ? COL.rumble1: COL.rumble2;
    var w1 = p1.w, w2 = p2.w, y1 = p1.y, y2 = p2.y;
    ctx.fillStyle = grass;
    ctx.fillRect(0, y2, W, y1 - y2 + 1);
    /* 路肩条纹（金/暗金交替 → 车速感来自条纹滚动） */
    poly(p1.x - w1 * 1.16, y1, p1.x - w1, y1, p2.x - w2, y2, p2.x - w2 * 1.16, y2, rum);
    poly(p1.x + w1, y1, p1.x + w1 * 1.16, y1, p2.x + w2 * 1.16, y2, p2.x + w2, y2, rum);
    /* 路面 */
    poly(p1.x - w1, y1, p1.x + w1, y1, p2.x + w2, y2, p2.x - w2, y2, road);
    /* 最左那条对向车道：颜色略冷、略暗，让"骑过去就是逆行"一眼可读 */
    var uW = TUNE.WRONGWAY_X;
    poly(p1.x - w1, y1, p1.x + uW * w1, y1, p2.x + uW * w2, y2, p2.x - w2, y2, COL.oncom);
    /* 中心虚线：画在合法区与对向车道的分界上（不是路面正中），且在亮段才画，形成节奏 */
    if (seg.dark && w1 > 3) {
      var c1 = p1.x + uW * w1, c2 = p2.x + uW * w2;
      var lw1 = Math.max(1, w1 * 0.035), lw2 = Math.max(1, w2 * 0.035);
      poly(c1 - lw1, y1, c1 + lw1, y1, c2 + lw2, y2, c2 - lw2, y2, COL.lane);
    }
    if (seg.fog < 1) { ctx.fillStyle = fogOver(seg.fog); ctx.fillRect(0, y2, W, y1 - y2 + 1); }
  }
  function poly(x1, y1, x2, y2, x3, y3, x4, y4, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.lineTo(x4, y4);
    ctx.closePath(); ctx.fill();
  }

  function spriteOrigin(seg, off) {
    var sc = seg.p1.screen.scale;
    return { x: seg.p1.screen.x + sc * off * TUNE.ROAD_W * W / 2, y: seg.p1.screen.y, sc: sc };
  }
  function drawSegSprite(seg, sp) {
    if (!(seg.p1.screen.scale > 0) || seg.p1.screen.y > seg.clip + 4) return;
    var o = spriteOrigin(seg, sp.off);
    if (o.x < -W || o.x > W * 2) return;
    clipDraw(seg.clip, function () { DRAW[sp.t](o.x, o.y, o.sc, sp); });
    if (seg.fog < 0.85) { ctx.fillStyle = fogOver(seg.fog); }   // 雾里不额外压，交给路段
  }
  function drawSegLocker(seg, o, isOrder) {
    if (!(seg.p1.screen.scale > 0)) return;
    var off = o.side * 1.06;
    var p = spriteOrigin(seg, off);
    if (p.x < -W || p.x > W * 2) return;
    var near = G.nearTarget === o ? 1 : 0;
    clipDraw(seg.clip, function () {
      if (o.kind === "handoff") drawCustomer(p.x, p.y, p.sc, G.wave);
      else drawLocker(p.x, p.y, p.sc, o.lit, near);
    });
  }
  function drawSegItem(seg, it) {
    if (!(seg.p1.screen.scale > 0)) return;
    var p = spriteOrigin(seg, it.side * 1.24);
    if (p.x < -W || p.x > W * 2) return;
    clipDraw(seg.clip, function () { drawItem(p.x, p.y, p.sc, it); });
  }
  function drawSegHazard(seg, hz) {
    if (!(seg.p1.screen.scale > 0 || hz.done)) return;
    if (hz.done) return;                       // 已经被处理掉（狗被引开等）
    var p = spriteOrigin(seg, hz.x);
    if (p.x < -W || p.x > W * 2) return;
    clipDraw(seg.clip, function () { drawHazard(p.x, p.y, p.sc, hz); });
  }
  function drawOncoming(c) {
    /* ⚠ 必须先确认这一段**本帧真的被投射过**：
       超出 DRAW_DIST 的段屏幕上还是上一帧的残值，直接拿去画会把车画到错误的深度上。 */
    var rel = (c.z - G.position) / TUNE.SEG_LEN;
    if (!(rel >= 1 && rel <= TUNE.DRAW_DIST)) return;
    var p = spriteOrigin(findSegment(c.z), c.x);
    if (p.x < -W || p.x > W * 2) return;
    drawHazard(p.x, p.y, p.sc, { kind:"car", w:1900, h:1500 });
  }

  /* ── 3.5 HUD ── */
  function drawHud() {
    var pad = Math.round(W * 0.022);
    /* 左上：分数 + 连送 */
    txt("分数 " + G.score, pad, pad + 12, 17, COL.gold);
    if (G.streak > 1) {
      var hot = Math.min(1, G.streak / TUNE.STREAK_CAP);
      txt("连送 ×" + Math.min(G.streak, TUNE.STREAK_CAP) + (G.streak > TUNE.STREAK_CAP ? "（封顶）" : ""),
          pad, pad + 34, 14, hot >= 1 ? COL.red : COL.green);
    }
    txt("送达 " + G.delivered + "/" + G.total + " · 第 " + G.day + "/" + G.dayCount + " 天",
        pad, pad + 56, 13, COL.dim, "left", "normal");
    /* 右上：餐量 / 失误 / 用时 */
    txt("🍱 保温箱 " + G.bag + "/" + G.bagMax, W - pad, pad + 12, 14, G.bag > 0 ? COL.body : COL.red, "right");
    txt("失误 " + G.mistakes + "/" + TUNE.MISTAKES_MAX, W - pad, pad + 34, 14,
        G.mistakes > 0 ? COL.red : COL.dim, "right");
    txt("用时 " + G.time.toFixed(0) + "s / 标准 " + G.parTime.toFixed(0) + "s", W - pad, pad + 56, 13, COL.dim, "right", "normal");

    /* 逆行警告：**明确写着不加分** —— 收益（时间）与代价（罚款/被撞）都摆出来 */
    if (G.wrongway) {
      var bw = Math.round(W * 0.46), bx = (W - bw) / 2, by = pad + 4;
      ctx.fillStyle = "rgba(255,77,109,.16)"; roundRect(ctx, bx, by, bw, 30, 6); ctx.fill();
      ctx.strokeStyle = "rgba(255,77,109,.6)"; ctx.lineWidth = 1; roundRect(ctx, bx, by, bw, 30, 6); ctx.stroke();
      txt("⚠ 逆行中 · 省时间但**不加分** · 罚款 ¥" + TUNE.FINE, W / 2, by + 16, 13, COL.red, "center");
    }
    if (G.holdUntil > G.time) txt("被保安拦下…", W / 2, H * 0.42, 20, COL.red, "center");

    /* 准星环：目标接近时出现，绿区是甜区 */
    if (G.nearTarget && G.nearT >= 0) drawReticle(G.nearTarget, G.nearT);

    /* 操作提示：优先级 = 狗（有时限，最急） > 投递目标 > 补给点 */
    var hint = null, hintCol = COL.gold;
    if (G.hintDog) { hint = "🐕 狗追上来了 —— 【空格 / 点一下】扔份备餐引开它"; hintCol = COL.red; }
    else if (G.nearTarget) {
      hint = (G.nearTarget.kind === "handoff")
        ? "【F / 点一下】递给楼下等的顾客"
        : (G.nearTarget.lit === "green" ? "【空格 / 点一下】投进亮绿灯的柜格" : "红灯柜 = 别人的单，别投");
      if (G.nearTarget.lit === "red") hintCol = COL.red;
    } else if (G.hintPickup) hint = "骑过去自动补满保温箱";
    else if (G.hintHelp) hint = "【F / 点一下】顺手帮带";
    if (hint) txt(hint, W / 2, H - Math.round(H * 0.085), 15, hintCol, "center");

    /* 弹出提示 */
    for (var i = 0; i < toastList.length; i++) {
      var tt = toastList[i];
      ctx.globalAlpha = Math.min(1, tt.t * 1.6);
      txt(tt.s, W / 2, H * 0.30 + i * 24, 18, tt.col, "center");
      ctx.globalAlpha = 1;
    }
  }
  /* 收缩的准星环：外环 = 投掷窗口，绿弧 = 甜区，指针 = 当前进度 t */
  function drawReticle(o, t) {
    var seg = G.route.segments[o.seg];
    var need = (o.kind === "handoff") ? TUNE.APPROACH_HAND : TUNE.APPROACH;
    var rel = Math.round((o.z - G.position) / TUNE.SEG_LEN);
    if (rel < 0 || rel > TUNE.DRAW_DIST) return;
    var live = G.route.segments[(findSegment(G.position).index + rel) % G.route.total];
    if (!(live.p1.screen.scale > 0)) return;
    var p = spriteOrigin(live, o.side * 1.06);
    var r = Math.max(24, Math.min(64, W * 0.045));
    var cy = p.y - r * 1.1;
    var inSweet = Math.abs(t - TUNE.SWEET) <= TUNE.SWEET_TOL;
    ctx.save();
    ctx.translate(p.x, cy);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,.28)";
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    /* 甜区弧：从 -90° 起按 t 的角度体系摆放 */
    var a0 = -Math.PI / 2 + (TUNE.SWEET - TUNE.SWEET_TOL) * Math.PI * 2;
    var a1 = -Math.PI / 2 + (TUNE.SWEET + TUNE.SWEET_TOL) * Math.PI * 2;
    ctx.strokeStyle = inSweet ? COL.gold : COL.green;
    ctx.lineWidth = inSweet ? 6 : 5;
    ctx.beginPath(); ctx.arc(0, 0, r, a0, a1); ctx.stroke();
    /* 指针 */
    var ang = -Math.PI / 2 + limit(t, 0, 1) * Math.PI * 2;
    ctx.strokeStyle = inSweet ? COL.gold : COL.cyan;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(Math.cos(ang) * r * 0.62, Math.sin(ang) * r * 0.62);
    ctx.lineTo(Math.cos(ang) * r * 1.14, Math.sin(ang) * r * 1.14); ctx.stroke();
    ctx.restore();
  }

  /* ═════════════════ 4. 对局逻辑 ═════════════════ */

  function newGame(opts) {
    opts = opts || {};
    var mode = MODES[opts.mode] || MODES.shift;
    var seed = (opts.seed >>> 0) || ((Date.now() ^ 0x9E3779B9) >>> 0);
    var camDepth = 1 / Math.tan((TUNE.FOV / 2) * Math.PI / 180);
    var g = {
      mode: mode, modeId: mode.id, seed: seed,
      camDepth: camDepth, playerZ: TUNE.CAM_H * camDepth,
      rng: makeRng(seed ^ 0x1234567),
      phase: "play", paused: false,
      day: 1, dayCount: mode.days,
      position: 0, playerX: 0.34, speed: TUNE.MAX_SPEED * TUNE.CRUISE * 0.4,
      steerVis: 0, bounce: 0, wave: 0,
      bag: mode.bag, bagMax: mode.bag,
      score: 0, streak: 0, bestStreak: 0, perfectStreak: 0,
      delivered: 0, total: 0, dayDelivered: 0, dayTotal: 0,
      perfectHits: 0, tips: 0,
      mistakes: 0, spilled: 0, daySpilled: 0, dayMistakes: 0, wrong: 0, fines: 0, caught: 0,
      helps: 0, dogs: 0, cleanBonus: 0, speedBonus: 0,
      time: 0, parTime: 0, dayTime: 0, dayStartScore: 0,
      wrongway: false, wrongwayTime: 0, holdUntil: 0, hitFlash: 0,
      oncom: [], oncomTimer: 1.2,
      frozen: false,
      nearTarget: null, nearT: -1, hintPickup: false, hintHelp: false, hintDog: false,
      entryCharged: false, dirty: false,
      route: null,
      practice: !!opts.practice,
      dayReceipt: null, result: null,
      steerInput: 0
    };
    loadDay(g, 1);
    return g;
  }

  function loadDay(g, day) {
    g.route = buildRoute(day, g.seed, g.modeId);
    g.day = day;
    g.dayTotal = g.route.orders.length;
    g.dayDelivered = 0;
    g.daySpilled = 0;
    g.dayMistakes = 0;
    g.dayStartScore = g.score;
    g.total += g.dayTotal;
    g.bag = g.bagMax;
    g.position = 0;
    g.playerX = 0.34;
    g.time = 0;
    g.parTime = g.route.parTime;
    g.oncom = [];
    g.oncomTimer = 1.0;
    g.nearTarget = null; g.nearT = -1;
    g.wrongway = false; g.holdUntil = 0;
    g.dayReceipt = null;
    g.phase = "play";
  }

  /* ── 4.1 每帧推进 ── */
  function step(dt) {
    var g = G;
    if (!g || g.phase !== "play") return;
    if (dt > 0.1) dt = 0.1;                      // 切标签页回来别一次跳半秒
    g.wave += dt * 3;
    g.hitFlash = Math.max(0, g.hitFlash - dt * 2.5);
    var i, sp = g.speed / TUNE.MAX_SPEED;

    /* 被保安拦停：原地不动，时间照走（净亏时间） */
    if (g.holdUntil > g.time) { g.speed = 0; g.time += dt; updateNear(g); return; }

    var seg = findSegment(g.position + g.playerZ);
    var dx = dt * 2 * sp;
    var prev = g.position;
    g.position += dt * g.speed;
    if (g.position >= g.route.length) g.position -= g.route.length;

    /* 转向：键盘 + 拖动叠加；弯道的离心力把你往外甩 */
    var steer = limit((K.left ? -1 : 0) + (K.right ? 1 : 0) + g.steerInput, -1, 1);
    g.steerVis = steer;
    g.playerX += dx * steer;
    g.playerX -= dx * sp * seg.curve * TUNE.CENTRIFUGAL;

    /* 逆行判定（**只影响速度上限/来车/罚款，不碰分数**） */
    g.wrongway = (g.playerX < TUNE.WRONGWAY_X);
    if (g.wrongway) g.wrongwayTime += dt;

    /* 油门：不踩就平滑回巡航（触屏也能玩） */
    var mul = g.wrongway ? TUNE.WRONGWAY_SPEED_MUL : 1;
    var cruise = TUNE.MAX_SPEED * TUNE.CRUISE * mul;
    if (K.up) g.speed += TUNE.ACCEL * dt;
    else if (K.down) g.speed += TUNE.BRAKE * dt;
    else g.speed += (cruise - g.speed) * Math.min(1, dt * 1.5);
    if (Math.abs(g.playerX) > 1 && g.speed > TUNE.OFFROAD_LIMIT) g.speed += TUNE.OFFROAD_DECEL * dt;
    g.speed = limit(g.speed, 0, TUNE.MAX_SPEED * mul);
    g.bounce = Math.sin(g.time * 26) * (sp > 0.35 ? 1.4 : 0.5) * (Math.abs(g.playerX) > 1 ? 3 : 1);
    g.playerX = limit(g.playerX, -1.9, 1.9);
    g.time += dt;

    /* 圈跑完 → 今天收工（提前送完也算收工，对应速度奖励） */
    if (g.position < prev) { endDay(g, "lap"); return; }

    /* 保安拦停：逆行 + 经过保安岗 → 罚款 + 停 1.2 秒。**不给分**。
       练手局连罚款也免（否则文案会说"罚款 ¥50"却一分不扣，与总账口径不一致）。 */
    if (g.wrongway && seg.guard) {
      seg.guard = false;                          // 每个岗只拦一次
      g.caught++;
      g.holdUntil = g.time + TUNE.GUARD_HOLD;
      if (g.practice) {
        pushToast("🚧 被保安拦下 · 停 1.2 秒（练手局不罚款）", COL.red);
      } else {
        g.fines += TUNE.FINE;
        g.dirty = true;
        pushToast("🚧 被保安拦下 · 罚款 ¥" + TUNE.FINE + " · 停 1.2 秒", COL.red);
      }
      beep(160, 0.25, "sawtooth", 0.09);
    }

    /* 迎面来车：对向车道一直有车，这是逆行的真实代价 */
    g.oncomTimer -= dt;
    if (g.oncomTimer <= 0) {
      g.oncomTimer = 0.6 + g.rng() * 0.8;
      g.oncom.push({ z: g.position + (TUNE.DRAW_DIST + 20) * TUNE.SEG_LEN,
                     x: TUNE.ONCOM_XMIN + g.rng() * (TUNE.ONCOM_XMAX - TUNE.ONCOM_XMIN),
                     spd: 3500 + g.rng() * 3200 });
    }
    for (i = g.oncom.length - 1; i >= 0; i--) {
      var c = g.oncom[i];
      c.z -= (c.spd + g.speed * 0.25) * dt;
      if (Math.abs(c.z - (g.position + g.playerZ)) < 900 && Math.abs(c.x - g.playerX) * TUNE.ROAD_W < 1150) {
        g.oncom.splice(i, 1); bump(g, "oncom", true);
      } else if (c.z < g.position - 3000) g.oncom.splice(i, 1);
    }

    /* 危险判定：只看玩家前后 2 段内的（静态危险每圈只吃一次） */
    var pIdx = findSegment(g.position + g.playerZ).index;
    for (var d = -1; d <= 2; d++) {
      var sg = g.route.segments[(pIdx + d + g.route.total) % g.route.total];
      for (i = 0; i < sg.hazards.length; i++) {
        var hz = sg.hazards[i];
        if (hz.done) continue;
        if (Math.abs(g.playerX - hz.x) * TUNE.ROAD_W < HAZARDS[hz.kind].w * 0.5) {
          hz.done = true;
          bump(g, hz.kind, HAZARDS[hz.kind].tier === "hit");
          if (g.phase !== "play") return;             // bump 可能已经把班结了，别再往下跑
        }
      }
      /* 取餐点：骑过去自动补满，不占按键 */
      for (i = 0; i < sg.items.length; i++) {
        var it = sg.items[i];
        if (it.t === "pickup" && !it.used) {
          it.used = true;
          if (g.bag < g.bagMax) { g.bag = g.bagMax; pushToast("🍱 取餐点 · 保温箱补满", COL.green); beep(620, 0.10, "triangle", 0.07); }
        }
      }
    }
    if (g.phase !== "play") return;

    /* 漏送：过了投递窗口还没送出（每单自己一段窗口，过去就作废） */
    var pdNow = g.position + g.playerZ;
    for (i = 0; i < g.route.orders.length; i++) {
      var o = g.route.orders[i];
      if (o.state !== "pending") continue;
      if (pdNow - o.z > TUNE.SEG_LEN * 1.5) {
        o.state = "missed"; g.streak = 0; g.perfectStreak = 0;
        pushToast("漏送 #" + o.n, COL.red);
      }
    }
    updateNear(g);
    if (g.dayDelivered >= g.dayTotal && g.dayTotal > 0) endDay(g, "allDone");

    /* 弹出提示寿命 */
    for (i = toastList.length - 1; i >= 0; i--) {
      toastList[i].t -= dt;
      if (toastList[i].t <= 0) toastList.splice(i, 1);
    }
  }

  /* 找出当前最近的可投目标 + 提示状态 */
  function updateNear(g) {
    var pd = g.position + g.playerZ, best = null, bestD = 1e9, i, o, d, win;
    for (i = 0; i < g.route.orders.length; i++) {
      o = g.route.orders[i];
      if (o.state !== "pending") continue;
      win = (o.kind === "handoff" ? TUNE.APPROACH_HAND : TUNE.APPROACH) * TUNE.SEG_LEN;
      d = o.z - pd;
      if (d < -TUNE.SEG_LEN || d > win) continue;
      if (d < bestD) { bestD = d; best = o; }
    }
    for (i = 0; i < g.route.decoys.length; i++) {
      var dc = g.route.decoys[i];
      if (dc.done) continue;
      d = dc.z - pd;
      if (d < -TUNE.SEG_LEN || d > TUNE.APPROACH * TUNE.SEG_LEN) continue;
      if (d < bestD) { bestD = d; best = dc; }
    }
    g.nearTarget = best;
    if (best) {
      win = (best.kind === "handoff" ? TUNE.APPROACH_HAND : TUNE.APPROACH) * TUNE.SEG_LEN;
      g.nearT = approachT(best.z, pd, win);
    } else g.nearT = -1;

    g.hintPickup = false; g.hintHelp = false; g.hintDog = false;
    if (nearDog(g, true)) g.hintDog = true;      // 狗在动作窗口内 → HUD 必须提示按空格
    for (i = 0; i < g.route.items.length; i++) {
      var it = g.route.items[i];
      d = it.z - pd;
      if (d < 0 || d > TUNE.APPROACH * 0.6 * TUNE.SEG_LEN) continue;
      if (it.t === "pickup" && !it.used && g.bag < g.bagMax) g.hintPickup = true;
      if (it.t === "help" && !it.used) g.hintHelp = true;
    }
  }

  /* ── 4.2 碰撞 / 洒汤 ── */
  function bump(g, kind, isHit) {
    var hz = HAZARDS[kind] || { n:"障碍", why:"撞上了" };
    if (isHit) {
      g.mistakes++;
      g.dayMistakes++;
      g.streak = 0; g.perfectStreak = 0;
      g.speed *= 0.30;
      g.hitFlash = 1;
      pushToast("💥 " + hz.why + " · 失误 " + g.mistakes + "/" + TUNE.MISTAKES_MAX, COL.red);
      beep(120, 0.28, "square", 0.10);
      if (g.mistakes >= TUNE.MISTAKES_MAX) { endShift(g, "mistakes"); return; }
    } else {
      g.spilled++; g.daySpilled++;
      g.streak = 0; g.perfectStreak = 0;
      g.speed *= 0.58;
      pushToast("💧 " + hz.why + "（该单差评）", COL.red);
      beep(220, 0.16, "sine", 0.07);
    }
  }

  /* ── 4.3 两个动词 ── */
  function pickInRange(g, wantKind, auto) {
    var pd = g.position + g.playerZ, best = null, bestD = 1e9, i, o, d, win;
    var list = [];
    for (i = 0; i < g.route.orders.length; i++) if (g.route.orders[i].state === "pending") list.push(g.route.orders[i]);
    for (i = 0; i < list.length; i++) {
      o = list[i];
      if (wantKind && o.kind !== wantKind) continue;
      win = (o.kind === "handoff" ? TUNE.APPROACH_HAND : TUNE.APPROACH) * TUNE.SEG_LEN;
      d = o.z - pd;
      if (d < -TUNE.SEG_LEN * 2 || d > win) continue;
      if (d < bestD) { bestD = d; best = o; }
    }
    if (best) return best;
    /* 就近的那个优先：两个键都能用，不把"按对键"做成难度轴
       （真正的三条轴是 灯色 / 时机 / 身位，键位混淆只是噪音） */
    if (wantKind) return pickInRange(g, null, false);
    /* 红灯柜：投了 = 送错（"读灯"这条轴）。也算进候选，让玩家自己踩坑 */
    if (wantKind !== "handoff") {
      for (i = 0; i < g.route.decoys.length; i++) {
        var dc = g.route.decoys[i];
        if (dc.done) continue;
        d = dc.z - pd;
        if (d < -TUNE.SEG_LEN * 2 || d > TUNE.APPROACH * TUNE.SEG_LEN) continue;
        if (d < bestD) { bestD = d; best = dc; }
      }
    }
    return best;
  }
  function nearDog(g, chasingOnly) {
    return findDogNear(g.route, g.position + g.playerZ, TUNE.DOG_RANGE);
  }

  function act(kind) {
    var g = G;
    if (!g || g.phase !== "play" || g.paused) return false;
    if (g.holdUntil > g.time) return false;
    var auto = (kind === "auto");
    var i, it;

    /* ① 狗在追 → 扔备餐引开（空格语义） */
    if (kind === "throw" || auto) {
      var dog = nearDog(g, true);
      if (dog) {
        if (g.bag <= 0) { pushToast("保温箱空了，没法引狗", COL.red); return false; }
        g.bag--; dog.done = true; g.dogs++;
        g.score += scoreOf("dog");
        pushToast("🐕 引开恶犬 +" + TUNE.DOG, COL.green);
        beep(700, 0.10, "triangle", 0.08);
        return true;
      }
    }
    /* ② 最近的投递目标（空格偏好柜单 / F 偏好递单；自动模式两者都行） */
    var want = (kind === "hand") ? "handoff" : (kind === "throw" ? "locker" : null);
    var cand = pickInRange(g, want, auto);
    if (cand && cand.lit !== "red") { return resolveDeliver(g, cand); }
    if (cand && cand.lit === "red") {
      /* 红灯柜 = 别人的单。投了算送错：费一份餐 + 清连送，但不记失误 */
      if (g.bag <= 0) { pushToast("保温箱空了", COL.red); return false; }
      cand.done = true; g.bag--; g.wrong++; g.streak = 0; g.perfectStreak = 0;
      pushToast("❌ 红灯柜是别人的单 · 送错了", COL.red);
      beep(180, 0.20, "square", 0.08);
      return true;
    }
    /* ③ 帮带点（F 语义） */
    if (kind === "hand" || auto) {
      var pd = g.position + g.playerZ;
      for (i = 0; i < g.route.items.length; i++) {
        it = g.route.items[i];
        if (it.t !== "help" || it.used) continue;
        var d = it.z - pd;
        if (d < -TUNE.SEG_LEN || d > TUNE.APPROACH * 0.5 * TUNE.SEG_LEN) continue;
        if (g.playerX * it.side <= TUNE.LATERAL) { pushToast("身位不对，捎不上", COL.red); return false; }
        it.used = true; g.helps++;
        g.score += scoreOf("help");
        pushToast("📦 顺手帮带 +" + TUNE.HELP, COL.green);
        beep(660, 0.09, "triangle", 0.07);
        return true;
      }
    }
    /* ④ 什么都没够着：空抛要费一份餐（这就是"别乱扔"的手感来源） */
    if (kind === "throw" && g.bag > 0) {
      g.bag--; g.streak = 0; g.perfectStreak = 0;
      pushToast("空抛 —— 白瞎一份餐", COL.red);
      beep(200, 0.12, "sine", 0.05);
      return true;
    }
    return false;
  }

  function resolveDeliver(g, o) {
    var pd = g.position + g.playerZ;
    var isHand = (o.kind === "handoff");
    var j = judgeDeliver(o, pd, g.playerX, isHand);
    if (!j.ok) {
      if (j.why === "wrongside") { pushToast("身位不对 —— 骑到" + (o.side < 0 ? "左" : "右") + "侧才够得着", COL.red); beep(180, 0.12, "sawtooth", 0.06); return false; }
      if (j.why === "early")     { pushToast("投早了，还没到跟前", COL.red); beep(180, 0.12, "sawtooth", 0.06); return false; }
      return false;
    }
    if (g.bag <= 0) { pushToast("保温箱空了 —— 去取餐点补", COL.red); return false; }
    g.bag--;
    o.state = "done"; o.perfect = j.perfect;
    g.streak++; if (g.streak > g.bestStreak) g.bestStreak = g.streak;
    g.score += scoreOf("deliver", g.streak);
    g.dayDelivered++; g.delivered++;
    if (j.perfect) {
      g.perfectHits++;
      g.perfectStreak++;
      g.score += scoreOf("perfect");
      /* 好评打赏：**连 3 单精准**才给（填原作的恶作剧槽位）。
         做成"连 3 单"而不是"每单精准就给"，是因为每单都给会让 +400 变成主要收入，
         压过送达本身 —— 那样"投得准"就不再是加分项，而是唯一玩法。 */
      if (g.perfectStreak % 3 === 0) {
        g.tips++; g.score += scoreOf("tip");
        pushToast("⭐ 连 3 单精准 · 好评打赏 +" + TUNE.TIP, COL.gold);
        beep(880, 0.16, "triangle", 0.09);
      } else pushToast("🎯 精准" + (isHand ? "递餐" : "投递") + " +" + TUNE.PERFECT, COL.green);
    } else {
      g.perfectStreak = 0;
      pushToast("✅ 送达 +" + scoreOf("deliver", g.streak), COL.green);
    }
    beep(520 + Math.min(6, g.streak) * 60, 0.09, "triangle", 0.07);
    return true;
  }

  /* ── 4.4 日结 / 班结 ── */
  function endDay(g, why) {
    /* 提前收工奖励：与 sim 同一公式（都走 scoreOf("speed") ），按天结算 */
    g.speedBonus += scoreOf("speed", 0, Math.max(0, g.parTime - g.time));
    var dayScore = g.score - g.dayStartScore;
    var perfectDay = (g.dayDelivered === g.dayTotal) && (g.daySpilled === 0) && (g.dayMistakes === 0);
    if (perfectDay) { g.cleanBonus++; g.score += scoreOf("clean"); }
    g.dayReceipt = {
      day: g.day, why: why,
      delivered: g.dayDelivered, total: g.dayTotal,
      score: g.score - g.dayStartScore,
      time: g.time, parTime: g.parTime,
      spilled: g.daySpilled, mistakes: g.dayMistakes,
      clean: perfectDay,
      grade: gradeOf(perfectDay, g.dayDelivered, g.dayTotal)
    };
    g.phase = "receipt";
    beep(perfectDay ? 990 : 740, 0.18, "triangle", 0.08);
  }

  function endShift(g, why) {
    /* 若是在某一天中途结束（撞满 3 次），把这一天的提前收工奖励也补上 */
    if (g.phase === "play") g.speedBonus += scoreOf("speed", 0, Math.max(0, g.parTime - g.time));
    g.score += g.speedBonus;
    var perfect = (g.delivered === g.total) && (g.mistakes === 0) && (g.spilled === 0);
    var grade = gradeOf(perfect, g.delivered, g.total);
    var pay = payoutOf(g.score, g.modeId);
    /* ⚠ 练手局必须**连入场费一起免掉**，不能只把 entry 字段报成 0 却仍在 net 里扣掉 ¥20 ——
       那样总账上「赔付 − 入场 − 罚款」的算式与 net 对不上（实测 3 − 0 − 0 却显示 −17），
       玩家看到的就是一笔算不明白的账。 */
    var entryCharge = g.practice ? 0 : TUNE.ENTRY;
    var fineCharge  = g.practice ? 0 : g.fines;
    var net = pay - entryCharge - fineCharge;
    g.result = {
      why: why, mode: g.modeId, grade: grade, perfect: perfect,
      score: g.score, delivered: g.delivered, total: g.total,
      perfectHits: g.perfectHits, tips: g.tips, helps: g.helps, dogs: g.dogs,
      cleanBonus: g.cleanBonus, speedBonus: g.speedBonus,
      mistakes: g.mistakes, spilled: g.spilled, wrong: g.wrong,
      fines: fineCharge, caught: g.caught,
      pay: pay, entry: entryCharge, net: net,
      bestStreak: g.bestStreak, days: g.day
    };
    g.phase = "result";
    /* 练手局不结算财富（沿用开窗/切果的练手局口径） */
    if (!g.practice && opts0 && typeof opts0.onSettle === "function") {
      try { opts0.onSettle(net, g.result); } catch (e) {}
    }
    if (opts0 && typeof opts0.onFinish === "function") {
      try { opts0.onFinish(g.result); } catch (e) {}
    }
    beep(perfect ? 1180 : 620, 0.3, "triangle", 0.09);
  }

  /* ── 4.5 输入 ── */
  var KEYMAP = {
    ArrowLeft:"left", a:"left", A:"left",
    ArrowRight:"right", d:"right", D:"right",
    ArrowUp:"up", w:"up", W:"up",
    ArrowDown:"down", s:"down", S:"down"
  };
  function onKeyDown(e) {
    var g = G; if (!g) return;
    var k = KEYMAP[e.key];
    if (k) { K[k] = true; e.preventDefault(); return; }
    if (e.key === " " || e.key === "Spacebar" || e.code === "Space") {
      e.preventDefault();
      if (g.phase === "receipt") { nextDay(g); return; }
      if (g.phase === "result")  { restart(); return; }
      act("throw"); return;
    }
    if (e.key === "f" || e.key === "F") { e.preventDefault(); act("hand"); return; }
    if (e.key === "p" || e.key === "P") { g.paused = !g.paused; e.preventDefault(); return; }
    if (e.key === "Escape") { if (g.phase === "receipt") nextDay(g); }
  }
  function onKeyUp(e) { var k = KEYMAP[e.key]; if (k) K[k] = false; }

  function localXY(e) {
    var r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function onPtrDown(e) {
    if (!G) return;
    ptr.on = true; ptr.id = e.pointerId;
    var p = localXY(e);
    ptr.x0 = ptr.x = p.x; ptr.y0 = ptr.y0 = p.y; ptr.t0 = Date.now(); ptr.moved = 0; ptr.steer = 0;
    if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (er) {} }
    e.preventDefault();
  }
  function onPtrMove(e) {
    if (!G || !ptr.on || e.pointerId !== ptr.id) return;
    var p = localXY(e);
    ptr.moved += Math.abs(p.x - ptr.x) + Math.abs(p.y - ptr.y);
    ptr.x = p.x; ptr.y = p.y;
    /* 横向拖动转向：拖出屏宽的 18% 即为满舵 —— 与 PaperRoute 的"拖动转向"同一种手感 */
    ptr.steer = limit((ptr.x0 - p.x) / (W * 0.18), -1, 1);
    if (G) G.steerInput = ptr.steer;
    e.preventDefault();
  }
  function onPtrUp(e) {
    if (!G || !ptr.on || e.pointerId !== ptr.id) return;
    var quick = (Date.now() - ptr.t0) < 320;
    ptr.on = false; ptr.steer = 0;
    if (G) G.steerInput = 0;
    if (quick && ptr.moved < 14) act("auto");        // 轻点 = 上下文动作（投/递/引狗/帮带）
    e.preventDefault();
  }

  /* ── 4.6 主循环 ── */
  function frame(ts) {
    if (!running) return;
    rafId = root.requestAnimationFrame(frame);
    if (!lastTs) lastTs = ts;
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    /* frozen 是**只给调试钩子用**的冻结：停掉 rAF 推进，但 act() 照常可用。
       与 paused（玩家按 P 暂停）不同 —— 暂停时当然不该还能投递。
       无头验收需要在"位置完全可控"的前提下精确命中某一张订单。 */
    if (G && !G.paused && !G.frozen && G.phase === "play") step(dt);
    render();
    if (G && (G.phase === "receipt" || G.phase === "result")) drawOverlayPanel();
    if (G && G.paused) {
      ctx.fillStyle = "rgba(11,10,19,.6)"; ctx.fillRect(0, 0, W, H);
      txt("已暂停", W / 2, H / 2 - 10, 28, COL.gold, "center");
      txt("P 继续 · Esc 关闭", W / 2, H / 2 + 24, 14, COL.dim, "center", "normal");
    }
  }

  /* 小票式结算面板（原作是报纸头版；外卖对应的纸质凭证就是小票） */
  function drawOverlayPanel() {
    var g = G, r = g.dayReceipt, res = g.result;
    var pw = Math.min(W * 0.66, 520), ph = 300, px = (W - pw) / 2, py = (H - ph) / 2 - 10;
    ctx.fillStyle = "rgba(11,10,19,.82)"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#f4efe2"; roundRect(ctx, px, py, pw, ph, 6); ctx.fill();
    ctx.strokeStyle = "#c9a24a"; ctx.lineWidth = 2; roundRect(ctx, px, py, pw, ph, 6); ctx.stroke();
    var lx = px + 22, rx = px + pw - 22, y = py + 30;
    txt("您 好 ， 您 的 外 卖", px + pw / 2, y, 17, "#20222c", "center");
    y += 16;
    ctx.strokeStyle = "rgba(32,34,44,.22)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(rx, y); ctx.stroke();
    y += 22;
    function row(k, v, col) {
      txt(k, lx, y, 13, "#5b5646", "left", "normal");
      txt(v, rx, y, 14, col || "#20222c", "right");
      y += 24;
    }
    if (r) {
      txt("第 " + r.day + " / " + g.dayCount + " 天" + (r.why === "allDone" ? " · 提前送完" : " · 跑完一圈"),
          px + pw / 2, y - 4, 12, "#8a836f", "center", "normal");
      y += 20;
      row("送达", r.delivered + " / " + r.total);
      row("当日得分", String(r.score));
      row("用时", r.time.toFixed(0) + "s（标准 " + r.parTime.toFixed(0) + "s）");
      row("洒汤", String(r.spilled), r.spilled ? "#b03a4a" : "#20222c");
      row("失误", String(r.mistakes), r.mistakes ? "#b03a4a" : "#20222c");
      row("当日评级", r.grade, r.grade === "S" ? "#1c7a4a" : "#20222c");
      y += 4;
      ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(rx, y); ctx.stroke();
      y += 20;
      txt(r.clean ? "整班零失误 · 干净的一天 ✓" : "明天注意别洒汤", px + pw / 2, y, 12,
          r.clean ? "#1c7a4a" : "#8a836f", "center", "normal");
      y += 22;
      txt("【空格】" + (r.day < g.dayCount ? "继续下一天" : "看总账"), px + pw / 2, py + ph - 24, 14, "#20222c", "center");
    } else if (res) {
      row("总送达", res.delivered + " / " + res.total);
      row("精准 / 打赏", res.perfectHits + " / " + res.tips);
      row("帮带 · 引开恶犬", res.helps + " · " + res.dogs);
      row("零失误天数", String(res.cleanBonus));
      row("提前收工奖励", "+" + res.speedBonus);
      row("送错 / 洒汤 / 失误", res.wrong + " / " + res.spilled + " / " + res.mistakes,
          (res.wrong + res.spilled + res.mistakes) ? "#b03a4a" : "#20222c");
      row("违规罚款", res.fines ? "−¥" + res.fines : "无", res.fines ? "#b03a4a" : "#20222c");
      y += 4; ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(rx, y); ctx.stroke(); y += 22;
      row("总分 / 评级", res.score + " · " + res.grade);
      row("赔付 − 入场", "¥" + res.pay + " − ¥" + res.entry);
      txt("净收益  " + (res.net > 0 ? "+" : "") + "¥" + res.net, px + pw / 2, y + 6, 20,
          res.net > 0 ? "#1c7a4a" : (res.net < 0 ? "#b03a4a" : "#20222c"), "center");
      y += 34;
      txt(g.practice ? "练手局 · 不结算财富" : "【空格】再来一单 · Esc 关闭", px + pw / 2, py + ph - 22, 13, "#8a836f", "center", "normal");
    }
  }

  function nextDay(g) {
    if (g.day < g.dayCount) { loadDay(g, g.day + 1); }
    else endShift(g, "weekDone");
  }
  function restart() { startRun(); }

  function startRun() {
    G = newGame(opts0);
    toastList.length = 0;
    lastTs = 0;
    return G;
  }

  /* ── 4.7 start / dispose / isBusy ── */
  function start(host, opts) {
    if (!root || !doc) return false;
    if (running) dispose();
    hostEl = host;
    if (!hostEl) return false;
    opts0 = opts || {};
    var c = doc.createElement("canvas");
    c.style.display = "block"; c.style.borderRadius = "4px";
    c.style.background = "#0b0a13"; c.style.touchAction = "none";
    hostEl.innerHTML = "";
    hostEl.appendChild(c);
    cv = c; ctx = c.getContext("2d");
    if (!ctx) { hostEl.innerHTML = ""; return false; }
    fitCanvas();
    startRun();
    doc.addEventListener("keydown", onKeyDown, false);
    doc.addEventListener("keyup", onKeyUp, false);
    cv.addEventListener("pointerdown", onPtrDown, false);
    cv.addEventListener("pointermove", onPtrMove, false);
    cv.addEventListener("pointerup", onPtrUp, false);
    cv.addEventListener("pointercancel", onPtrUp, false);
    running = true;
    lastTs = 0;
    rafId = root.requestAnimationFrame(frame);
    return true;
  }

  function dispose() {
    running = false;
    if (rafId) { try { root.cancelAnimationFrame(rafId); } catch (e) {} rafId = 0; }
    if (doc) {
      doc.removeEventListener("keydown", onKeyDown, false);
      doc.removeEventListener("keyup", onKeyUp, false);
    }
    if (cv) {
      cv.removeEventListener("pointerdown", onPtrDown, false);
      cv.removeEventListener("pointermove", onPtrMove, false);
      cv.removeEventListener("pointerup", onPtrUp, false);
      cv.removeEventListener("pointercancel", onPtrUp, false);
    }
    if (hostEl) hostEl.innerHTML = "";
    cv = null; ctx = null; G = null; hostEl = null; opts0 = null;
    K.left = K.right = K.up = K.down = false;
    ptr.on = false; ptr.steer = 0;
    toastList.length = 0;
    return true;
  }
  function isBusy() { return running; }

  /* ── 4.8 调试钩子（无头验收用；与其它玩法的 debug 约定一致）── */
  debug.state = function () {
    if (!G) return null;
    var g = G;
    return {
      phase: g.phase, day: g.day, dayCount: g.dayCount, mode: g.modeId,
      score: g.score, streak: g.streak, bestStreak: g.bestStreak, perfectStreak: g.perfectStreak,
      delivered: g.delivered, total: g.total, dayDelivered: g.dayDelivered, dayTotal: g.dayTotal,
      bag: g.bag, bagMax: g.bagMax, mistakes: g.mistakes, spilled: g.spilled, wrong: g.wrong,
      perfectHits: g.perfectHits, tips: g.tips, helps: g.helps, dogs: g.dogs,
      cleanBonus: g.cleanBonus, speedBonus: g.speedBonus,
      fines: g.fines, caught: g.caught,
      practice: g.practice, wrongway: g.wrongway,
      /* 逆行期间被保安拦停会 holdUntil > time（速度强制 0）。
         验收要看"逆行能跑多快"就必须读 speedCap，不能读瞬时 speed —— 会被拦停干扰。 */
      speedCap: Math.round(TUNE.MAX_SPEED * (g.wrongway ? TUNE.WRONGWAY_SPEED_MUL : 1)),
      held: g.holdUntil > g.time, holdLeft: +Math.max(0, g.holdUntil - g.time).toFixed(2),
      position: Math.round(g.position), speed: Math.round(g.speed), playerX: +g.playerX.toFixed(3),
      time: +g.time.toFixed(2), parTime: +g.parTime.toFixed(2),
      nearTarget: g.nearTarget ? { n:g.nearTarget.n, kind:g.nearTarget.kind, lit:g.nearTarget.lit, side:g.nearTarget.side } : null,
      nearT: +g.nearT.toFixed(3),
      hintDog: !!g.hintDog, hintHelp: !!g.hintHelp, hintPickup: !!g.hintPickup,
      result: g.result, receipt: g.dayReceipt,
      oncoming: g.oncom.length, worldW: W, worldH: H, camDepth: +g.camDepth.toFixed(4), playerZ: Math.round(g.playerZ)
    };
  };
  debug.route = function () { return G ? G.route : null; };
  debug.act = function (kind) { return act(kind || "auto"); };
  debug.key = function (name, down) { if (KEYMAP[name] !== undefined || K[name] !== undefined) K[name] = !!down; };
  debug.keyDown = function (k) { onKeyDown({ key:k, preventDefault:function () {} }); };
  debug.tick = function (ms) { var n = Math.max(1, Math.round((ms || 16) / 16)), i; for (i = 0; i < n; i++) step(0.016); render(); };
  debug.pause = function () { if (G) G.paused = true; };
  debug.resume = function () { if (G) G.paused = false; };
  /* 冻结 rAF 推进（但保留 act/tick）—— 无头验收靠它做确定性命中 */
  debug.freeze = function (on) { if (G) G.frozen = (on !== false); };
  debug.unfreeze = function () { if (G) G.frozen = false; };
  debug.restart = function (opts) { if (opts) opts0 = opts; return startRun(); };
  debug.finishNow = function () { if (G) endShift(G, "debug"); render(); };
  debug.finishDay = function () { if (G) { endDay(G, "debug"); render(); } };
  debug.nextDay = function () { if (G) { nextDay(G); render(); } };
  /* 把玩家挪到某张订单的投递窗口正中、并摆到正确的一侧 —— 无头验收靠它精准命中 */
  debug.aimAt = function (idx, tOverride) {
    if (!G) return null;
    var o = G.route.orders[idx];
    if (!o) return null;
    var win = (o.kind === "handoff" ? TUNE.APPROACH_HAND : TUNE.APPROACH) * TUNE.SEG_LEN;
    var t = (tOverride === undefined) ? TUNE.SWEET : tOverride;
    G.position = o.z - (1 - t) * win - G.playerZ;
    if (G.position < 0) G.position += G.route.length;
    /* 身位摆到"合法区内、且在这一侧"：0.34 而不是 0.55 —— 后者对左侧目标会踩进对向车道，
       变成一边送货一边违规（这条是截图里看出来的：送左单时"逆行中"警告亮着）。 */
    G.playerX = o.side * 0.34;
    updateNear(G);
    return { n:o.n, kind:o.kind, lit:o.lit, nearT:+G.nearT.toFixed(3), playerX:+G.playerX.toFixed(3) };
  };
  debug.aimAtDecoy = function (idx, tOverride) {
    if (!G) return null;
    var d = G.route.decoys[idx];
    if (!d) return null;
    var win = TUNE.APPROACH * TUNE.SEG_LEN;
    var t = (tOverride === undefined) ? TUNE.SWEET : tOverride;
    G.position = d.z - (1 - t) * win - G.playerZ;
    if (G.position < 0) G.position += G.route.length;
    G.playerX = d.side * 0.34;
    updateNear(G);
    return { nearT:+G.nearT.toFixed(3), lit:d.lit };
  };
  debug.setLateral = function (x) { if (G) { G.playerX = x; updateNear(G); } };
  debug.setBag = function (n) { if (G) G.bag = n; };
  /* 跳到某一赛道段（无头验收要精确撞上"保安岗""补给点"这类稀疏对象，
     靠骑过去撞运气既慢又不确定）。段内的 fractions 位置也能指定。 */
  debug.gotoSeg = function (idx, frac) {
    if (!G) return null;
    var t = G.route.total;
    var i = ((idx | 0) % t + t) % t;
    G.position = i * TUNE.SEG_LEN + (frac || 0) * TUNE.SEG_LEN - G.playerZ;
    while (G.position < 0) G.position += G.route.length;
    G.position = G.position % G.route.length;
    updateNear(G);
    return { seg: i, position: Math.round(G.position) };
  };
  debug.guards = function () {
    if (!G) return [];
    var out = [];
    for (var i = 0; i < G.route.total; i++) if (G.route.segments[i].guard) out.push(i);
    return out;
  };
  debug.spawnDog = function () {
    if (!G) return null;
    var pd = G.position + G.playerZ;
    var idx = (findSegment(pd).index + 4) % G.route.total;
    var hz = { kind:"dog", seg:idx, z:idx * TUNE.SEG_LEN, x:G.playerX, tier:"hit", done:false };
    G.route.segments[idx].hazards.push(hz);
    G.route.hazards.push(hz);
    updateNear(G);            // 立刻重算提示状态：否则 hintDog 要等下一帧才变 true
    return hz;
  };
  debug.lifecycle = function () {
    return { running: running, busy: isBusy(), hasCanvas: !!cv, phase: G ? G.phase : null, raf: rafId > 0 };
  };

  /* ═════════════════ 导出 ═════════════════
     start / isBusy / dispose 用 function 声明（整份提升，所以在这里引用得到）；
     debug 是上面那个对象（属性在渲染层里逐个挂上，引用不变）。 */
  root.Delivery = {
    version: "1.0.0",
    start: start,
    isBusy: isBusy,
    dispose: dispose,
    TUNE: TUNE,
    MODES: MODES,
    rules: rules,
    debug: debug
  };

})(window);
