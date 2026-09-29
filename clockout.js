/* ══════════════════════════════════════════════════════════════════════════════
   clockout.js —「准点下班」· 办公室潜行（俯视）

   自包含 IIFE，暴露全局 window.Clockout；ES5 风格，不使用 ES module，
   不依赖页面内变量（只读 opts / 挂载 hostEl）。零素材：工位、隔板、咖啡机、
   巡逻者、视野锥全部用 canvas 图元程序化绘制。

   一句话规格：俯视办公楼里躲开主管的黄色视野锥，用工位和隔板当掩体，捡文件夹伪装，
   按咖啡机把巡逻引开，三关之内搭电梯溜走。被发现立即失败（本关重来，已过关保留）。

   对外 API（规格）：
     window.Clockout.start(hostEl, opts) -> boolean
       opts:{ cash:()=>number, phys:()=>number, intel:()=>number,
              onSettle:(net,info)=>{}, onFinish:(sum)=>{},
              practice:boolean, mode:"normal|hell", seed:number }
     window.Clockout.isBusy(), dispose()
     window.Clockout.debug = { state(), level(), patrols(), press(key), seek(x,y),
                               tick(ms), freeze(on), restart(opts), winLevel(),
                               finishNow(), lifecycle() }

   附加（单测用，不属于规格）：window.Clockout.rules = { buildLevel, isSolid,
     blocksSight, losClear, canSee, anySees, buildPatrols, stepPatrol, validateLevel,
     simulateRun, payoutOf, scoreOf, LEVELS, TUNE, MODES }

   ── 设计要点（为什么这么做，改之前先读）────────────────────────────────────────
   1) **视线判定是纯函数，也是整个玩法的心脏**。`视线内 = 距离 ≤ range
      && |角度差| ≤ 半个 FOV && 连线上没有挡视线格`。它不碰 canvas，单测直接喂坐标
      验边界（正好半 FOV 处含等号、隔板挡视线但能走过）。潜行游戏的 bug 几乎全在这里，
      把它抽出来才验得动。

   2) **掩体分两级**：工位 `D` 挡人也挡视线，半高隔板 `p` 只挡视线、人能走过。
      这是本作唯一在原型之外加的东西，也是让"路线"有得算的关键 ——
      沿隔板背面走成了可执行的技巧，而不是"离得远就行"。

   3) **关卡用构建器 API 描述，不手数 ASCII**。手数字符宽度必然出错、而且改不动；
      构建器还能顺手让 validateLevel 去断言"出口和文件夹都可达"
      （关卡不可能通关是潜行游戏最恶心的 bug，而且画面上完全看不出来）。

   4) **每次重试重新随机巡逻**（原作 `每次重试随机巡逻`）：背板子没用，得读现场。
      但同一 seed 必须完全可复现，否则 bug 复现不了、蒙卡也测不了。

   5) **咖啡机是唯一能改变棋盘的动作**：把巡逻引去茶水间，那条路线就空出来。
      没有它，游戏退化成纯躲避。
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";
  if (!root || root.Clockout) return;

  var doc = root.document;

  /* ═════════════════ 1. 调参区（改手感只动这里） ═════════════════ */

  var TUNE = {
    ENTRY: 20,                // 入场 ¥20（与刮刮乐/开窗/外卖同价）

    /* ── 网格与移动 ── */
    TILE: 40,                 // 每格边长（世界像素）
    P_R: 11,                  // 玩家碰撞半径
    SPEED: 172,               // 玩家速度 px/s
    PATROL_SPEED: 96,         // 巡逻者速度 px/s

    /* ── 视野锥（玩法的心脏，改之前先跑 tests/clockout.test.cjs）── */
    FOV_DEG: 74,              // 视野锥总张角
    RANGE: 320,               // 视距（世界像素）= 8 格
    SCAN_SWEEP_DEG: 62,       // 停下扫视时左右各摆多少度
    SCAN_TURN: 70,            // 扫视角速度（度/秒）
    PATROL_TURN: 200,         // 行走转向角速度（度/秒）
    SCAN_HOLD: 1.5,           // 每个航点扫视多少秒

    /* ── 伪装（文件夹）── */
    DISGUISE_SEC: 6.5,        // 按空格后免疫被发现的秒数
    DISGUISE_HELL: 4.0,
    FOLDER_PER_LEVEL: 1,      // 每关一份（不放多，多了就变成"一路按过去"）

    /* ── 咖啡机（调虎离山）── */
    COFFEE_LURE_SEC: 7.0,     // 被引开多久
    COFFEE_COOLDOWN: 3.0,     // 冷却，防止连按把巡逻永远钉在茶水间
    COFFEE_REACH: 2.0,        // 多远内能按到（格）

    /* ── 电梯 ── */
    ELEV_WAIT: 5.0,           // 呼叫后要等几秒（这段时间必须活着）
    ELEV_REACH: 1.8,          // 多远内能按到（格）

    /* ── 时限：**三关共用**（原作是两层共用）──
       时间不会因为你被抓住而重置，所以"被发现一次"的真实代价是时间。 */
    /* ⚠ 时限必须 ≥ 最快可达时间，否则这一档在数学上不可能通关。
       最快 = Σ(每关 parTime) × 0.92（skill 1.0 时的用时系数）= (52+60+68)×0.92 ≈ 166 秒。
       第一版给 hell 定 150 秒 —— 比理论最快还短 16 秒，实测超时率恒为 100%，
       也就是"这一档永远拿不到全通"。现在 195 秒：够全通，但几乎没有容错。 */
    TIME_NORMAL: 215,
    TIME_HELL: 195,

    /* ── 失败定格 ── */
    REVEAL_SEC: 1.15,         // 被发现后定格多久再重开本关
    CAUGHT_TIME_COST: 0,      // 额外罚时（0=只损失已经走过的时间，够疼了）

    /* ── 计分 ── */
    PER_LEVEL: 1200,          // 每过一关
    PER_SECOND_LEFT: 10,      // 每剩 1 秒
    GHOST_BONUS: 800,         // 全程零被发现
    SPEED_BONUS_MAX: 900      // 用时奖励上限（防止刷时间）
  };

  /* 得分登记表 —— 唯一的加分行数来源。
     刻意**没有**任何"被发现/被抓"的加分项：失败只能扣，不能变成收益。 */
  var SCORE_TABLE = {
    level: TUNE.PER_LEVEL,
    time: 1,
    ghost: TUNE.GHOST_BONUS
  };

  var MODES = {
    normal: { id:"normal", n:"正常", sub:"三关，215 秒共用", levels:3, time:TUNE.TIME_NORMAL, patrolMul:1.0, fovMul:1.0, disguise:TUNE.DISGUISE_SEC },
    hell:   { id:"hell",   n:"地狱", sub:"巡逻更快更广，150 秒", levels:3, time:TUNE.TIME_HELL,   patrolMul:1.35, fovMul:1.18, disguise:TUNE.DISGUISE_HELL }
  };

  /* 赔付阶梯：每模式一条（单一阶梯会把某个模式变成印钞机 —— 切果那次踩过）。
     数值由 simulateRun 分布反推，见 tests/clockout.test.cjs 的不变量断言。 */
  var PAYOUT = {
    normal: [ {min:0,pay:0}, {min:1400,pay:3}, {min:2400,pay:9}, {min:3300,pay:17},
              {min:4100,pay:27}, {min:4700,pay:40}, {min:5200,pay:58} ],
    hell:   [ {min:0,pay:0}, {min:1300,pay:3}, {min:2200,pay:9}, {min:3000,pay:16},
              {min:3700,pay:26}, {min:4300,pay:40}, {min:4800,pay:58} ]
  };

  /* ═════════════════ 2. 地格语义 ═════════════════
     solid = 挡人（走不过去）; opaque = 挡视线。两者**故意分开**：
     半高隔板挡视线但能走过，这是"路线"这件事的全部来源。 */
  var TILE = {
    "#": { solid:true,  opaque:true,  n:"墙" },
    "D": { solid:true,  opaque:true,  n:"工位" },
    "p": { solid:false, opaque:true,  n:"隔板" },
    ".": { solid:false, opaque:false, n:"地板" },
    "E": { solid:false, opaque:false, n:"出口" },
    "C": { solid:true,  opaque:false, n:"咖啡机" },
    "F": { solid:false, opaque:false, n:"文件夹" },
    "L": { solid:false, opaque:false, n:"茶水间" },
    "@": { solid:false, opaque:false, n:"出生点" }
  };

  /* ═════════════════ 3. 关卡（构建器 API 描述，不手数 ASCII） ═════════════════ */

  function makeBuilder(w, h) {
    var g = [];
    var i, j;
    for (j = 0; j < h; j++) { g.push([]); for (i = 0; i < w; i++) g[j].push("."); }
    var routes = [];
    return {
      w: w, h: h, grid: g, routes: routes,
      put: function (x, y, ch) { if (x >= 0 && y >= 0 && x < w && y < h) g[y][x] = ch; return this; },
      fill: function (x, y, ww, hh, ch) {
        for (var yy = y; yy < y + hh; yy++) for (var xx = x; xx < x + ww; xx++) this.put(xx, yy, ch);
        return this;
      },
      border: function () {
        for (var x = 0; x < w; x++) { this.put(x, 0, "#"); this.put(x, h - 1, "#"); }
        for (var y = 0; y < h; y++) { this.put(0, y, "#"); this.put(w - 1, y, "#"); }
        return this;
      },
      /* 用墙围出一个房间，并在指定边开一个门 */
      room: function (x, y, ww, hh, doorSide, doorAt) {
        this.fill(x, y, ww, 1, "#"); this.fill(x, y + hh - 1, ww, 1, "#");
        this.fill(x, y, 1, hh, "#"); this.fill(x + ww - 1, y, 1, hh, "#");
        var d = doorAt === undefined ? Math.floor(ww / 2) : doorAt;
        if (doorSide === "n") this.put(x + d, y, ".");
        else if (doorSide === "s") this.put(x + d, y + hh - 1, ".");
        else if (doorSide === "w") this.put(x, y + d, ".");
        else this.put(x + ww - 1, y + d, ".");
        return this;
      },
      /* 一条巡逻航线（航点数组）。每次重试会按新 seed 抖动重排 —— `每次重试随机巡逻`。 */
      patrol: function (route) { routes.push(route); return this; }
    };
  }

  var LEVELS = [
    {
      id: "open", name: "开放办公区", sub: "工位区 · 茶水间 · 打印室 · 接待区",
      hint: "出口在北侧中央，从左翼或右翼绕行。先去打印区拿文件夹。",
      w: 32, h: 20, elevator: false, parTime: 52,
      build: function () {
        var g = makeBuilder(32, 20);
        g.border();
        /* 出口：北侧中央的门（两格宽） */
        g.put(15, 1, "E"); g.put(16, 1, "E");
        /* 茶水间（左上）：咖啡机 + 引诱目标点 */
        g.room(1, 2, 7, 4, "s", 4);
        g.put(6, 3, "C"); g.put(6, 5, "L");
        /* 打印室（右上）：文件夹 */
        g.room(24, 2, 7, 4, "s", 3);
        g.put(27, 4, "F");
        /* 工位阵列：三列 × 两排（实心，要绕） */
        g.fill(3, 7, 5, 3, "D");
        g.fill(12, 7, 5, 3, "D");
        g.fill(21, 7, 5, 3, "D");
        g.fill(3, 13, 5, 3, "D");
        g.fill(12, 13, 5, 3, "D");
        g.fill(21, 13, 5, 3, "D");
        /* 半高隔板：横贯中部（挡视线、能走过）—— 沿它背面走是这一关的核心技巧 */
        g.fill(9, 10, 14, 1, "p");
        /* 出生点：自己在工位后面 */
        g.put(16, 17, "@");
        /* 巡逻航线：四条，覆盖左右翼与中央通道 */
        g.patrol([[9, 4], [9, 17]]);
        g.patrol([[19, 4], [19, 17]]);
        /* ⚠ 横向航线必须走**没有工位**的空带：工位占 y=7..9 与 y=13..15，
           走 y=9 会一头顶在工位上卡死（validateLevel 会报"航线中间被实心格挡住"）。 */
        g.patrol([[2, 6], [29, 6]]);
        g.patrol([[2, 16], [29, 16]]);
        return g;
      }
    },
    {
      id: "meeting", name: "会议中心", sub: "大会议室 · 电话间 · 协作客厅 · 项目室",
      hint: "出口在东侧中央的换层电梯，留意小地图。呼叫电梯后要等它到。",
      w: 34, h: 20, elevator: true, parTime: 60,
      build: function () {
        var g = makeBuilder(34, 20);
        g.border();
        /* 换层电梯：东侧中央（两格高） */
        g.put(32, 9, "E"); g.put(32, 10, "E");
        /* 大会议室（左上，门朝南开） */
        g.room(1, 1, 11, 8, "s", 5);
        g.fill(3, 3, 7, 3, "D");
        /* 电话间（中上，两间小格子） */
        g.room(14, 1, 5, 5, "s", 2);
        g.room(20, 1, 5, 5, "s", 2);
        /* 茶水间 + 咖啡机（右下角） */
        g.room(26, 14, 7, 5, "n", 4);
        g.put(31, 16, "C"); g.put(31, 17, "L");
        /* 项目室（左下，门朝东开） */
        g.room(1, 12, 9, 7, "e", 3);
        g.fill(3, 14, 5, 3, "D");
        /* 协作客厅：中部开阔区，摆沙发（用隔板表示半高隔断） */
        g.fill(13, 9, 12, 1, "p");
        g.fill(13, 15, 12, 1, "p");
        g.fill(15, 11, 3, 2, "D");
        g.fill(21, 11, 3, 2, "D");
        /* 文件夹：电话间里（要绕进去拿） */
        g.put(21, 3, "F");
        /* 出生点：协作客厅南侧 */
        g.put(18, 17, "@");
        g.patrol([[12, 7], [12, 16]]);        // 中部竖廊（会议室与项目室之间）
        g.patrol([[24, 7], [24, 16]]);        // 东侧竖廊
        g.patrol([[2, 10], [30, 10]]);        // 横贯上层（y=10 是唯一没有房间的横带）
        g.patrol([[11, 17], [25, 17]]);       // 南部横带
        /* 电话间两条：只能各自进出一次（原来写成一条横穿两间的 4 点环线，
           中间隔着两道隔墙，巡逻者会卡在墙上） */
        g.patrol([[16, 3], [16, 7]]);
        g.patrol([[22, 3], [22, 7]]);
        return g;
      }
    },
    {
      id: "admin", name: "行政楼层", sub: "行政办公室 · 档案库 · 前台 · 双电梯厅",
      hint: "电梯在东北侧。档案库的柜子多、视线碎，穿过去比绕外面快。",
      w: 34, h: 22, elevator: true, parTime: 68,
      build: function () {
        var g = makeBuilder(34, 22);
        g.border();
        /* 双电梯厅：东北侧（本关终点） */
        g.room(26, 1, 7, 6, "s", 3);
        g.put(30, 3, "E"); g.put(30, 4, "E");
        /* 行政办公室（左上，门朝南） */
        g.room(1, 1, 10, 7, "s", 4);
        g.fill(3, 3, 3, 3, "D"); g.fill(7, 3, 2, 3, "D");
        /* 档案库（中下大间）：密集排架 —— 视线碎，穿过去快但风险高 */
        g.room(9, 11, 16, 10, "n", 7);
        /* ⚠ 排架从 y=13 每 2 格一排，只放 4 排：写 5 排会落到 y=21 = 底边外墙，
           把外墙写穿（validateLevel 的"外墙封闭"检查就是逮这个的）。 */
        var i;
        for (i = 0; i < 4; i++) g.fill(11, 13 + i * 2, 12, 1, "D");
        /* 前台（中上） */
        g.fill(13, 2, 8, 1, "D");
        g.put(16, 4, "C"); g.put(16, 5, "L");
        /* 文件夹：档案库最里侧（要钻进去） */
        g.put(22, 18, "F");
        /* 半高隔板：前台两侧的通道隔断 */
        g.fill(11, 8, 4, 1, "p");
        g.fill(19, 8, 4, 1, "p");
        /* 出生点：西南角工位 */
        g.put(3, 19, "@");
        g.patrol([[2, 9], [2, 20]]);          // 左走廊
        g.patrol([[31, 7], [31, 20]]);         // 右走廊
        g.patrol([[5, 9], [28, 9]]);           // 上层横向
        g.patrol([[5, 10], [24, 10]]);         // 次层横向
        /* 档案库内部两条：必须沿**没有排架**的行/列走
           （排架在 y=13/15/17/19 且横跨 x=11..22，所以走 x=23 的竖列与 y=18 的横行） */
        g.patrol([[23, 12], [23, 19]]);
        g.patrol([[11, 18], [22, 18]]);
        return g;
      }
    }
  ];

  /* ═════════════════ 4. 纯规则层（无 DOM，可在 vm 里整局自跑） ═════════════════ */

  /* xorshift32：确定性随机。**不用 Math.imul**（仓库要求兼容 IE11）。
     ⚠ 必须预热 8 轮：xorshift32 的第一个输出对相近种子几乎不变
     （上一个玩法实测 300 个相邻种子的首值全挤在 0.658–0.685）。 */
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
  function deg2rad(d) { return d * Math.PI / 180; }
  function normAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  /* ── 构建器结果 → 关卡对象 ── */
  function buildLevel(def, patrolsSeed, modeId) {
    var b = def.build();
    var grid = b.grid, w = b.w, h = b.h;
    var lv = {
      id: def.id, name: def.name, sub: def.sub, hint: def.hint,
      w: w, h: h, grid: grid, elevator: !!def.elevator, parTime: def.parTime,
      spawn: null, exit: [], folders: [], coffee: [], lounge: [], patrolRoutes: b.routes || []
    };
    var x, y, ch;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        ch = grid[y][x];
        if (ch === "@") lv.spawn = { x:x, y:y };
        else if (ch === "E") lv.exit.push({ x:x, y:y });
        else if (ch === "F") lv.folders.push({ x:x, y:y, taken:false });
        else if (ch === "C") lv.coffee.push({ x:x, y:y });
        else if (ch === "L") lv.lounge.push({ x:x, y:y });
      }
    }
    /* 地格索引：把字符换成属性表，省掉每帧的字符串比较 */
    lv.solid = []; lv.opaque = [];
    for (y = 0; y < h; y++) {
      lv.solid.push([]); lv.opaque.push([]);
      for (x = 0; x < w; x++) {
        var t = TILE[grid[y][x]] || TILE["."];
        lv.solid[y].push(t.solid ? 1 : 0);
        lv.opaque[y].push(t.opaque ? 1 : 0);
      }
    }
    lv.patrols = buildPatrols(lv, patrolsSeed, modeId || "normal");
    return lv;
  }

  function tileAt(lv, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= lv.w || ty >= lv.h) return "#";
    return lv.grid[ty][tx];
  }
  /* 世界坐标（像素）→ 是否实心 / 是否挡视线 */
  function isSolidW(lv, px, py) {
    var tx = Math.floor(px / TUNE.TILE), ty = Math.floor(py / TUNE.TILE);
    if (tx < 0 || ty < 0 || tx >= lv.w || ty >= lv.h) return true;
    return !!lv.solid[ty][tx];
  }
  function isOpaqueW(lv, px, py) {
    var tx = Math.floor(px / TUNE.TILE), ty = Math.floor(py / TUNE.TILE);
    if (tx < 0 || ty < 0 || tx >= lv.w || ty >= lv.h) return true;
    return !!lv.opaque[ty][tx];
  }

  /* ── 视线：1/4 格步长采样 ──
     比 Bresenham 简单，在 40px 格子下精度绰绰有余。
     起终点本身**不参与遮挡判定**（否则站在墙边的人永远"看不见"）。 */
  function losClear(lv, x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return true;
    var steps = Math.ceil(dist / (TUNE.TILE * 0.25));
    for (var i = 1; i < steps; i++) {
      var t = i / steps;
      if (isOpaqueW(lv, x0 + dx * t, y0 + dy * t)) return false;
    }
    return true;
  }

  /* ── 视野锥：距离 + 张角 + 遮挡，三条全过才看得见 ──
     ⚠ 张角边界含等号（正好在半 FOV 上算"看得见"）—— 边界行为必须写死并测住，
     否则调参时会莫名其妙多出一堆"擦边看不见"。 */
  function canSee(lv, pat, px, py, opt) {
    opt = opt || {};
    if (opt.disguised) return false;                 // 伪装期间一律看不见
    var dx = px - pat.x, dy = py - pat.y;
    var d2 = dx * dx + dy * dy;
    var range = pat.range * (opt.rangeMul || 1);
    if (d2 > range * range) return false;
    if (d2 < 1) return true;                         // 贴脸
    var diff = Math.abs(normAngle(Math.atan2(dy, dx) - pat.angle));
    if (diff > pat.halfFov + 1e-9) return false;
    return losClear(lv, pat.x, pat.y, px, py);
  }
  /* 返回第一个看见玩家的巡逻者（没看见返回 null） */
  function anySees(lv, pats, px, py, opt) {
    for (var i = 0; i < pats.length; i++) {
      if (canSee(lv, pats[i], px, py, opt)) return pats[i];
    }
    return null;
  }

  /* ── 巡逻者 ── */
  function mkPatrol(route, seed, mode, idx) {
    var rng = makeRng(seed ^ (idx * 0x9E3779B1));
    var T = TUNE.TILE;
    var wps = [];
    for (var i = 0; i < route.length; i++) {
      /* 每次重试航线都要抖一下（原作"每次重试随机巡逻"），但抖完仍要是可走的格 */
      var jx = Math.round((rng() - 0.5) * 2.4), jy = Math.round((rng() - 0.5) * 2.4);
      wps.push({ x: (route[i][0] + jx + 0.5) * T, y: (route[i][1] + jy + 0.5) * T });
    }
    var p = {
      i: idx, wps: wps, wp: 0, x: wps[0].x, y: wps[0].y,
      angle: rng() * Math.PI * 2,
      range: TUNE.RANGE * mode.fovMul,
      halfFov: deg2rad(TUNE.FOV_DEG * mode.fovMul) / 2,
      speed: TUNE.PATROL_SPEED * mode.patrolMul,
      mode: "walk",           // walk | scan | lure
      timer: 0,
      scanFrom: 0, scanDir: (rng() < 0.5 ? -1 : 1),
      lure: null, lureUntil: 0,
      sees: false
    };
    return p;
  }
  function buildPatrols(lv, seed, modeId) {
    var mode = MODES[modeId] || MODES.normal;
    var routes = lv.patrolRoutes || [];
    var out = [];
    for (var i = 0; i < routes.length; i++) out.push(mkPatrol(routes[i], (seed >>> 0) || 7, mode, i));
    return out;
  }

  /* 巡逻状态机：walk（走向下一航点）→ scan（原地左右扫视）→ walk …
     返回是否发生了转向（供渲染层决定要不要画"警觉"提示）。 */
  function stepPatrol(lv, p, dt, now, opt) {
    opt = opt || {};
    var T = TUNE.TILE;
    /* 被咖啡机引开：目标改到茶水间 */
    var target = null, isLure = false;
    if (p.lure && now < p.lureUntil) { target = p.lure; isLure = true; }
    else {
      if (p.lure) { p.lure = null; p.mode = "walk"; }     // 引诱结束，回原航线
      target = p.wps[p.wp];
    }
    var dx = target.x - p.x, dy = target.y - p.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var arrive = isLure ? T * 1.2 : T * 0.5;

    if (dist > arrive) {
      /* 走：朝目标移动，同时把朝向平滑转过去 */
      p.mode = "walk";
      var want = Math.atan2(dy, dx);
      var turn = deg2rad(TUNE.PATROL_TURN) * dt;
      var d = normAngle(want - p.angle);
      p.angle = normAngle(p.angle + limit(d, -turn, turn));
      var step = Math.min(dist, p.speed * dt);
      var nx = p.x + (dx / dist) * step, ny = p.y + (dy / dist) * step;
      /* 轴向分离：不让人卡在墙角 */
      if (!isSolidW(lv, nx, p.y)) p.x = nx;
      if (!isSolidW(lv, p.x, ny)) p.y = ny;
    } else {
      /* 到了：停下扫视（紧张感的全部来源 —— 玩家必须读出他什么时候会转过来） */
      if (p.mode !== "scan") { p.mode = "scan"; p.timer = 0; p.scanFrom = p.angle; }
      p.timer += dt;
      var sweep = deg2rad(TUNE.SCAN_SWEEP_DEG);
      var turn2 = deg2rad(TUNE.SCAN_TURN) * dt * p.scanDir;
      p.angle = normAngle(p.angle + turn2);
      if (Math.abs(normAngle(p.angle - p.scanFrom)) > sweep) p.scanDir = -p.scanDir;
      if (p.timer >= TUNE.SCAN_HOLD && !isLure) {
        p.mode = "walk"; p.wp = (p.wp + 1) % p.wps.length;
        p.scanDir = (p.timer % 2 < 1) ? -p.scanDir : p.scanDir;
      }
    }
    return p;
  }

  /* ── 关卡自检：出口和文件夹都必须可达 ──
     关卡不可能通关是潜行游戏最恶心的 bug（画面上完全看不出来，只能玩到才发现），
     所以让它在单测里直接红。同时顺手查"外墙封闭"与"唯一的出生点"。 */
  function validateLevel(lv) {
    var problems = [];
    if (!lv.spawn) problems.push("没有出生点 @");
    if (!lv.exit.length) problems.push("没有出口 E");
    if (!lv.folders.length) problems.push("没有文件夹 F");
    var i, x, y;
    for (y = 0; y < lv.h; y++) {
      if (lv.grid[y].length !== lv.w) problems.push("第 " + y + " 行宽度 " + lv.grid[y].length + " ≠ " + lv.w);
    }
    for (x = 0; x < lv.w; x++) {
      if (lv.grid[0][x] !== "#") problems.push("顶边第 " + x + " 格不是墙：" + lv.grid[0][x]);
      if (lv.grid[lv.h - 1][x] !== "#") problems.push("底边第 " + x + " 格不是墙：" + lv.grid[lv.h - 1][x]);
    }
    for (y = 0; y < lv.h; y++) {
      if (lv.grid[y][0] !== "#") problems.push("左边第 " + y + " 行不是墙");
      if (lv.grid[y][lv.w - 1] !== "#") problems.push("右边第 " + y + " 行不是墙");
    }
    if (!lv.spawn) return problems;
    /* 从出生点 BFS（只走非 solid），看出口与文件夹是否都在可达集合里 */
    var seen = {}, q = [[lv.spawn.x, lv.spawn.y]];
    seen[lv.spawn.x + "," + lv.spawn.y] = 1;
    while (q.length) {
      var cur = q.shift();
      var dirs = [[1,0],[-1,0],[0,1],[0,-1]];
      for (i = 0; i < 4; i++) {
        var nx = cur[0] + dirs[i][0], ny = cur[1] + dirs[i][1];
        if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
        if (lv.solid[ny][nx]) continue;
        var k = nx + "," + ny;
        if (seen[k]) continue;
        seen[k] = 1; q.push([nx, ny]);
      }
    }
    for (i = 0; i < lv.exit.length; i++) {
      if (!seen[lv.exit[i].x + "," + lv.exit[i].y]) problems.push("出口 (" + lv.exit[i].x + "," + lv.exit[i].y + ") 从出生点走不到");
    }
    for (i = 0; i < lv.folders.length; i++) {
      if (!seen[lv.folders[i].x + "," + lv.folders[i].y]) problems.push("文件夹 (" + lv.folders[i].x + "," + lv.folders[i].y + ") 从出生点走不到");
    }
    for (i = 0; i < lv.patrolRoutes.length; i++) {
      var route = lv.patrolRoutes[i];
      for (var j = 0; j < route.length; j++) {
        var wx = route[j][0], wy = route[j][1];
        if (wx < 0 || wy < 0 || wx >= lv.w || wy >= lv.h) { problems.push("巡逻航点越界 " + wx + "," + wy); continue; }
        if (lv.solid[wy][wx]) problems.push("巡逻航点 (" + wx + "," + wy + ") 落在实心格里");
        if (!seen[wx + "," + wy]) problems.push("巡逻航点 (" + wx + "," + wy + ") 不在可达区");
        /* ⚠ 还要检查**相邻航点之间的直线**：巡逻者是直线走向下一个航点的，不做寻路。
           如果两点之间有墙，它会一头顶在墙上原地卡死 —— 画面上只是"这个保安站着不动"，
           非常难联想到是关卡数据的问题。 */
        var nx2 = route[(j + 1) % route.length], steps2, k2;
        var segLen = Math.sqrt(Math.pow(nx2[0] - wx, 2) + Math.pow(nx2[1] - wy, 2));
        steps2 = Math.max(2, Math.ceil(segLen / 0.25));
        for (k2 = 1; k2 < steps2; k2++) {
          var tt = k2 / steps2;
          var sx = Math.floor(wx + (nx2[0] - wx) * tt), sy = Math.floor(wy + (nx2[1] - wy) * tt);
          if (sy >= 0 && sy < lv.h && sx >= 0 && sx < lv.w && lv.solid[sy][sx]) {
            problems.push("巡逻航线 (" + wx + "," + wy + ")→(" + nx2[0] + "," + nx2[1] + ") 中间被实心格 (" + sx + "," + sy + ") 挡住，巡逻者会卡死");
            break;
          }
        }
      }
    }
    return problems;
  }

  function scoreOf(kind, extra) {
    if (!Object.prototype.hasOwnProperty.call(SCORE_TABLE, kind)) return 0;
    if (kind === "time") return Math.max(0, Math.round((extra || 0) * TUNE.PER_SECOND_LEFT));
    return SCORE_TABLE[kind];
  }

  function payoutOf(score, modeId) {
    var lad = PAYOUT[modeId] || PAYOUT.normal;
    var pay = 0;
    for (var i = 0; i < lad.length; i++) if (score >= lad[i].min) pay = lad[i].pay;
    return pay;
  }

  /* ── 蒙卡：纯函数整局自跑 ──
     用途只有两个：给赔付阶梯定数、让"经济不变量"能被断言。
     关键纪律：得分必须走同一套 scoreOf，否则模拟与实机漂移。 */
  function simulateRun(modeId, skill, seed, opt) {
    opt = opt || {};
    var mode = MODES[modeId] || MODES.normal;
    var s = limit(+skill || 0, 0, 1);
    var rng = makeRng(((seed >>> 0) || 191) ^ 0x5BF03635);
    var st = {
      cleared:0, caught:0, timeUsed:0, remaining:0, timeout:false,
      score:0, ghost:true, levelTimes:[], net:0, pay:0
    };
    var timeLeft = mode.time;
    for (var i = 0; i < mode.levels && i < LEVELS.length; i++) {
      var lv = LEVELS[i];
      var attempts = 0, cleared = false;
      /* ⚠ 通关概率必须**收敛到"技术满级几乎必过"**：
         第一版写成 `base × (0.30 + 0.70×skill)`，skill=1.0 时也只等于 base
         （0.86/0.75/0.64）—— 满级玩家仍有一半概率在第一关翻车、反复罚时，
         实测 skill 1.0 的超时率还有 10%。现在线性插值到 0.985：
         skill=0 时是基础难度，skill=1 时几乎必过，中间连续。 */
      var base = (0.20 - i * 0.04) * (modeId === "hell" ? 0.82 : 1);
      while (!cleared) {
        attempts++;
        var pClear = limit(base + (0.985 - base) * s, 0.02, 0.985);
        var cost = lv.parTime * (1.22 - 0.30 * s);
        if (rng() < pClear) {
          cleared = true; st.cleared++; st.levelTimes.push(+cost.toFixed(1));
        } else {
          st.caught++; st.ghost = false;
          cost = lv.parTime * 0.34;                  // 被抓一次白跑一段
        }
        timeLeft -= cost; st.timeUsed += cost;
        if (timeLeft <= 0) { st.timeout = true; timeLeft = 0; break; }
        /* 防呆：技能极低时不无限循环。⚠ 这里必须**判定为超时并结束整轮**，
           不能只是 break 出 while 就继续下一关 —— 那样"第一关没过"也会被算成过关，
           实测会出现"0 关却拿到时间分"和"关卡跳着过"的假数据。 */
        if (attempts > 24) { st.timeout = true; st.stuck = true; break; }
      }
      if (st.timeout) break;
    }
    st.remaining = Math.max(0, Math.round(timeLeft * 10) / 10);
    st.score = st.cleared * scoreOf("level")
      + Math.min(TUNE.SPEED_BONUS_MAX, scoreOf("time", st.remaining))
      + (st.ghost && st.cleared === mode.levels ? scoreOf("ghost") : 0);
    st.pay = payoutOf(st.score, modeId);
    st.net = st.pay - TUNE.ENTRY;
    st.allClear = (st.cleared === mode.levels);
    /* 评级必须与实机 endRun 用**同一套阈值**，否则统计出来的分布对不上实际体验 */
    st.grade = st.allClear ? (st.ghost ? "S" : "A")
      : (st.cleared === mode.levels - 1 ? "B" : (st.cleared > 0 ? "C" : "D"));
    return st;
  }

  var rules = {
    makeRng: makeRng, buildLevel: buildLevel, tileAt: tileAt,
    isSolidW: isSolidW, isOpaqueW: isOpaqueW, losClear: losClear,
    canSee: canSee, anySees: anySees, buildPatrols: buildPatrols,
    stepPatrol: stepPatrol, validateLevel: validateLevel,
    simulateRun: simulateRun, payoutOf: payoutOf, scoreOf: scoreOf,
    SCORE_TABLE: SCORE_TABLE, PAYOUT: PAYOUT, LEVELS: LEVELS,
    TUNE: TUNE, MODES: MODES, TILE: TILE
  };

  /* ── 调试钩子容器：**必须在这里就建成对象**。
     若写成 var debug = {…} 放在文件后半段，导出赋值会先执行、捕获到 undefined
     —— var 只提升声明不提升赋值。（上一个玩法踩过这个坑。） ── */
  var debug = {};
  /* 模块级可变状态一律在这里声明：严格的 "use strict" 下，
     给未声明变量赋值会直接抛 ReferenceError，而且只有真跑起来才会发现。 */
  var G = null, hostEl = null, cv = null, ctx = null, W = 900, H = 560;
  var rafId = 0, lastTs = 0, running = false, opts0 = null;
  var keys = {};

  /* ═════════════════ 5. 视野锥的多边形（纯几何，可单测） ═════════════════
     从巡逻者往外打一把射线，每条射线在**第一个挡视线格**停下，把落点连成多边形。
     为什么非要做真实裁剪：掩体挡视线是这个玩法的核心机制，
     如果视野锥画成一个不裁剪的扇形，玩家就**看不出哪里是安全的** ——
     机制还在，但读不出来，等于没有。 */
  function conePoly(lv, pat, opt) {
    opt = opt || {};
    var rays = opt.rays || 30;
    var range = pat.range * (opt.rangeMul || 1);
    var step = TUNE.TILE * 0.34;
    var pts = [{ x: pat.x, y: pat.y }];
    var a0 = pat.angle - pat.halfFov, a1 = pat.angle + pat.halfFov;
    for (var i = 0; i <= rays; i++) {
      var a = a0 + (a1 - a0) * (i / rays);
      var cx = Math.cos(a), cy = Math.sin(a);
      var d = step;
      while (d < range) {
        if (isOpaqueW(lv, pat.x + cx * d, pat.y + cy * d)) break;
        d += step;
      }
      d = Math.min(d, range);
      pts.push({ x: pat.x + cx * d, y: pat.y + cy * d });
    }
    return pts;
  }

  /* ═════════════════ 6. 渲染 + 对局 ═════════════════ */

  var COL = {
    floorA:"#1a1c26", floorB:"#171923", grid:"rgba(255,255,255,.028)",
    wall:"#2c3040", wallTop:"#3a4056",
    desk:"#3b3f52", deskTop:"#4a4f66",
    part:"#5a5f78",
    coffee:"#c96a2c", coffeeOn:"#ffb03c",
    folder:"#e9e3d1", exit:"#5dffa0",
    cone:"rgba(255,214,90,.21)", coneEdge:"rgba(255,214,90,.46)",
    alert:"#ff4d6d",
    player:"#e9e3d1", playerDark:"#23252f",
    hud:"#0b0a13"
  };

  function beep(f, d, t, g) { try { if (root.AudioSys && root.AudioSys.blip) root.AudioSys.blip(f, d, t, g); } catch (e) {} }
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
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  function newGame(opts) {
    opts = opts || {};
    var mode = MODES[opts.mode] || MODES.normal;
    var seed = (opts.seed >>> 0) || ((Date.now() ^ 0x9E3779B9) >>> 0);
    var g = {
      mode: mode, modeId: mode.id, seed: seed,
      runSeed: seed, retry: 0,
      levelIndex: 0, lv: null, patrols: [],
      player: { x:0, y:0, r: TUNE.P_R, face: -Math.PI / 2, moving:false, step:0 },
      timeLeft: mode.time, timeUsed: 0,
      cleared: 0, caught: 0, ghost: true,
      hasFolder: false, folderTaken: false, disguiseUntil: -99,
      coffeeCd: 0, coffeeUntil: 0, coffeeActive: false,
      elev: { state: "idle", at: 0 },
      phase: "play", frozen: false, paused: false,
      revealUntil: 0, caughtBy: null,
      near: null, seenBy: null,
      practice: !!opts.practice,
      toast: [], clear: null, result: null,
      view: { scale: 1, ox: 0, oy: 0 }
    };
    loadLevel(g, 0, true);
    return g;
  }

  function loadLevel(g, idx, fresh) {
    var def = LEVELS[idx];
    var seed = (g.runSeed ^ ((idx + 1) * 0x85EBCA6B) ^ (g.retry * 0x27D4EB2F)) >>> 0;
    g.lv = buildLevel(def, seed, g.modeId);
    g.levelIndex = idx;
    g.patrols = g.lv.patrols;
    g.player.x = (g.lv.spawn.x + 0.5) * TUNE.TILE;
    g.player.y = (g.lv.spawn.y + 0.5) * TUNE.TILE;
    g.player.face = -Math.PI / 2;
    g.hasFolder = false; g.folderTaken = false;
    g.disguiseUntil = -99;
    g.coffeeCd = 0; g.coffeeActive = false;
    g.elev = { state: g.lv.elevator ? "idle" : "open", at: 0 };
    g.phase = "play";
    g.seenBy = null; g.near = null;
    g.clear = null;
    if (fresh) { g.timeLeft = g.mode.time; g.timeUsed = 0; g.cleared = 0; g.caught = 0; g.ghost = true; }
  }

  function pushToast(g, s, col) { g.toast.push({ s:s, col: col || COL.exit, t: 1.8 }); if (g.toast.length > 4) g.toast.shift(); }

  /* ── 画布尺寸：按关卡宽高比铺满面板 ── */
  function fitCanvas() {
    if (!cv || !hostEl || !G || !G.lv) return;
    var rect = hostEl.getBoundingClientRect ? hostEl.getBoundingClientRect() : null;
    var avail = Math.max(560, Math.round((rect && rect.width) || 900));
    var lv = G.lv;
    W = Math.min(avail, 980);
    H = Math.round(W * lv.h / lv.w);
    if (H > 640) { H = 640; W = Math.round(H * lv.w / lv.h); }
    cv.width = W; cv.height = H;
    cv.style.width = "100%"; cv.style.height = H + "px";
    var s = Math.min(W / (lv.w * TUNE.TILE), H / (lv.h * TUNE.TILE));
    G.view.scale = s;
    G.view.ox = (W - lv.w * TUNE.TILE * s) / 2;
    G.view.oy = (H - lv.h * TUNE.TILE * s) / 2;
  }

  function render() {
    if (!G || !ctx || !G.lv) return;
    var g = G, lv = g.lv, T = TUNE.TILE, s = g.view.scale, ox = g.view.ox, oy = g.view.oy;
    var i, x, y;
    ctx.fillStyle = COL.hud; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(ox, oy); ctx.scale(s, s);

    /* 地板 */
    for (y = 0; y < lv.h; y++) {
      for (x = 0; x < lv.w; x++) {
        var ch = lv.grid[y][x];
        if (ch === "#") continue;
        ctx.fillStyle = ((x + y) % 2 === 0) ? COL.floorA : COL.floorB;
        ctx.fillRect(x * T, y * T, T, T);
      }
    }
    /* 出口：绿色出口的地面光 */
    for (i = 0; i < lv.exit.length; i++) {
      var ex = lv.exit[i];
      var pulse = 0.25 + 0.18 * Math.sin(g.timeUsed * 3 + i);
      ctx.fillStyle = "rgba(93,255,160," + pulse.toFixed(3) + ")";
      ctx.fillRect(ex.x * T, ex.y * T, T, T);
      if (g.elev.state === "arrived") {
        ctx.strokeStyle = COL.exit; ctx.lineWidth = 2.5;
        ctx.strokeRect(ex.x * T + 1, ex.y * T + 1, T - 2, T - 2);
      }
    }
    /* 茶水间目标点 */
    for (i = 0; i < lv.lounge.length; i++) {
      var lg = lv.lounge[i];
      ctx.fillStyle = "rgba(77,216,255,.10)";
      ctx.fillRect(lg.x * T, lg.y * T, T, T);
    }
    /* 咖啡机 */
    for (i = 0; i < lv.coffee.length; i++) {
      var cf = lv.coffee[i];
      ctx.fillStyle = g.coffeeActive ? COL.coffeeOn : COL.coffee;
      roundRect(ctx, cf.x * T + T * 0.14, cf.y * T + T * 0.14, T * 0.72, T * 0.72, T * 0.12);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.fillRect(cf.x * T + T * 0.3, cf.y * T + T * 0.24, T * 0.4, T * 0.16);
      if (g.coffeeActive) {
        ctx.fillStyle = "rgba(255,176,60,.16)";
        ctx.beginPath(); ctx.arc(cf.x * T + T / 2, cf.y * T + T / 2, T * 1.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    /* 文件夹 */
    for (i = 0; i < lv.folders.length; i++) {
      var fd = lv.folders[i];
      if (fd.taken) continue;
      ctx.fillStyle = COL.folder;
      ctx.save();
      ctx.translate(fd.x * T + T / 2, fd.y * T + T / 2);
      ctx.rotate(-0.18);
      ctx.fillRect(-T * 0.26, -T * 0.32, T * 0.52, T * 0.64);
      ctx.fillStyle = "#c9a24a";
      ctx.fillRect(-T * 0.26, -T * 0.32, T * 0.52, T * 0.13);
      ctx.restore();
      ctx.fillStyle = "rgba(233,227,209,.10)";
      ctx.beginPath(); ctx.arc(fd.x * T + T / 2, fd.y * T + T / 2, T * 0.9, 0, Math.PI * 2); ctx.fill();
    }
    /* 工位 / 隔板 / 墙 */
    for (y = 0; y < lv.h; y++) {
      for (x = 0; x < lv.w; x++) {
        var c2 = lv.grid[y][x];
        if (c2 === "D") {
          ctx.fillStyle = COL.desk; ctx.fillRect(x * T + 2, y * T + 2, T - 4, T - 4);
          ctx.fillStyle = COL.deskTop; ctx.fillRect(x * T + 4, y * T + 4, T - 8, T * 0.34);
          ctx.fillStyle = "rgba(0,0,0,.30)"; ctx.fillRect(x * T + 4, y * T + T * 0.62, T - 8, T * 0.24);
        } else if (c2 === "p") {
          /* 半高隔板：画成一条带阴影的窄条，视觉上就"能看过去但挡住视线" */
          ctx.fillStyle = COL.part; ctx.fillRect(x * T + 1, y * T + T * 0.3, T - 2, T * 0.28);
          ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fillRect(x * T + 1, y * T + T * 0.58, T - 2, T * 0.1);
        } else if (c2 === "#") {
          ctx.fillStyle = COL.wall; ctx.fillRect(x * T, y * T, T, T);
          ctx.fillStyle = COL.wallTop; ctx.fillRect(x * T, y * T, T, T * 0.16);
        }
      }
    }

    /* 视野锥：**按掩体真实裁剪**（见 conePoly 的注释） */
    for (i = 0; i < g.patrols.length; i++) {
      var p = g.patrols[i];
      var pts = conePoly(lv, p);
      var hot = !!p.sees;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.closePath();
      ctx.fillStyle = hot ? "rgba(255,77,109,.30)" : COL.cone;
      ctx.fill();
      ctx.strokeStyle = hot ? "rgba(255,77,109,.6)" : COL.coneEdge;
      ctx.lineWidth = 1.6; ctx.stroke();
    }

    /* 巡逻者 */
    for (i = 0; i < g.patrols.length; i++) {
      var q = g.patrols[i];
      var r = T * 0.30;
      ctx.fillStyle = "rgba(0,0,0,.35)";
      ctx.beginPath(); ctx.ellipse(q.x, q.y + r * 0.5, r * 1.05, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = q.sees ? COL.alert : "#8a3b4a";
      ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#f0d8c0";
      ctx.beginPath(); ctx.arc(q.x, q.y, r * 0.52, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(q.x + Math.cos(q.angle) * r * 0.7, q.y + Math.sin(q.angle) * r * 0.7);
      ctx.lineTo(q.x + Math.cos(q.angle) * r * 1.5, q.y + Math.sin(q.angle) * r * 1.5);
      ctx.stroke();
    }

    /* 玩家 */
    var pl = g.player;
    var pr = T * 0.32;
    var disg = g.timeUsed < g.disguiseUntil;
    ctx.fillStyle = "rgba(0,0,0,.4)";
    ctx.beginPath(); ctx.ellipse(pl.x, pl.y + pr * 0.5, pr * 1.05, pr * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    /* 走路的上下摆动：一眼能看出"在动" */
    var bob = pl.moving ? Math.sin(pl.step * 11) * pr * 0.10 : 0;
    ctx.save();
    ctx.translate(pl.x, pl.y + bob);
    ctx.rotate(pl.face + Math.PI / 2);
    ctx.fillStyle = disg ? "#4dd8ff" : COL.playerDark;
    roundRect(ctx, -pr * 0.62, -pr * 0.5, pr * 1.24, pr * 1.5, pr * 0.4); ctx.fill();
    ctx.fillStyle = disg ? "#bff0ff" : COL.player;
    ctx.beginPath(); ctx.arc(0, -pr * 0.62, pr * 0.52, 0, Math.PI * 2); ctx.fill();
    if (disg) {
      /* 伪装中：手里举着文件夹挡脸 */
      ctx.fillStyle = COL.folder;
      ctx.fillRect(-pr * 0.62, -pr * 1.35, pr * 1.24, pr * 0.72);
      ctx.fillStyle = "#c9a24a";
      ctx.fillRect(-pr * 0.62, -pr * 1.35, pr * 1.24, pr * 0.16);
    }
    ctx.restore();
    if (disg) {
      ctx.strokeStyle = "rgba(77,216,255,.55)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pl.x, pl.y, pr * 1.9, 0, Math.PI * 2); ctx.stroke();
    }

    /* 可交互高亮 */
    if (g.near) {
      ctx.strokeStyle = "rgba(255,215,110,.9)"; ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(g.near.x * T + 1, g.near.y * T + 1, T - 2, T - 2);
      ctx.setLineDash([]);
    }
    ctx.restore();

    drawHud();
  }

  /* ── HUD + 小地图 ── */
  function drawHud() {
    var g = G, lv = g.lv, pad = 10;
    /* 时间条：三关共用，倒计时 */
    var frac = limit(g.timeLeft / g.mode.time, 0, 1);
    var bw = Math.round(W * 0.46), bx = Math.round((W - bw) / 2), by = pad;
    ctx.fillStyle = "rgba(255,255,255,.10)"; roundRect(ctx, bx, by, bw, 9, 4); ctx.fill();
    ctx.fillStyle = frac > 0.35 ? COL.exit : COL.alert;
    roundRect(ctx, bx, by, Math.max(2, bw * frac), 9, 4); ctx.fill();
    txt("剩余 " + Math.ceil(g.timeLeft) + " 秒 · 三关共用", W / 2, by + 22, 12.5,
        frac > 0.35 ? "rgba(233,227,209,.85)" : COL.alert, "center", "normal");

    txt("第 " + (g.levelIndex + 1) + " / " + LEVELS.length + " 关 · " + lv.name, pad, pad + 10, 14, COL.exit);
    txt("已过 " + g.cleared + " 关" + (g.caught ? " · 被抓 " + g.caught + " 次" : " · 还没被发现"), pad, pad + 30, 12, "rgba(233,227,209,.62)", "left", "normal");

    var disg = g.timeUsed < g.disguiseUntil;
    var st = disg ? ("伪装中 " + (g.disguiseUntil - g.timeUsed).toFixed(1) + "s")
      : (g.hasFolder ? "空格 使用文件夹" : (g.folderTaken ? "文件夹已用完" : "去打印区拿文件夹"));
    txt(st, W - pad, pad + 10, 13, disg ? "#4dd8ff" : (g.hasFolder ? COL.folder : "rgba(233,227,209,.55)"), "right");

    /* 电梯状态 */
    var el = lv.elevator ? {
      idle: "E 呼叫电梯", calling: "电梯到达中… " + Math.max(0, TUNE.ELEV_WAIT - (g.timeUsed - g.elev.at)).toFixed(1) + "s",
      arrived: "电梯到了！靠近门口按 E", open: "E 进入电梯"
    }[g.elev.state] : "走到绿色出口即下班";
    txt(el, W - pad, pad + 30, 12.5, g.elev.state === "arrived" ? COL.exit : "rgba(233,227,209,.62)", "right", "normal");

    /* 小地图（原作 `绿色标记为本层出口`）*/
    var mw = 118, mh = Math.round(mw * lv.h / lv.w), mx = W - mw - pad, my = H - mh - pad - 22;
    ctx.fillStyle = "rgba(11,10,19,.72)"; roundRect(ctx, mx - 4, my - 4, mw + 8, mh + 8, 4); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.14)"; ctx.lineWidth = 1;
    roundRect(ctx, mx - 4, my - 4, mw + 8, mh + 8, 4); ctx.stroke();
    var cs = mw / lv.w;
    for (var y = 0; y < lv.h; y++) {
      for (var x = 0; x < lv.w; x++) {
        var ch = lv.grid[y][x];
        if (ch === "." || ch === "@" || ch === "F" || ch === "L") continue;
        ctx.fillStyle = (ch === "#" || ch === "D") ? "rgba(200,210,240,.22)" : "rgba(200,210,240,.12)";
        ctx.fillRect(mx + x * cs, my + y * cs, Math.ceil(cs), Math.ceil(cs));
      }
    }
    for (var i = 0; i < lv.exit.length; i++) {
      ctx.fillStyle = COL.exit;
      ctx.fillRect(mx + lv.exit[i].x * cs, my + lv.exit[i].y * cs, Math.ceil(cs) + 1, Math.ceil(cs) + 1);
    }
    for (i = 0; i < g.patrols.length; i++) {
      ctx.fillStyle = "rgba(255,214,90,.9)";
      ctx.fillRect(mx + (g.patrols[i].x / TUNE.TILE) * cs - 1, my + (g.patrols[i].y / TUNE.TILE) * cs - 1, 3, 3);
    }
    ctx.fillStyle = "#fff";
    ctx.fillRect(mx + (g.player.x / TUNE.TILE) * cs - 1.5, my + (g.player.y / TUNE.TILE) * cs - 1.5, 4, 4);

    /* 提示行 */
    var hint = null;
    if (g.near && g.near.kind === "coffee") hint = "【E】启动咖啡机 —— 把巡逻引去茶水间";
    else if (g.near && g.near.kind === "folder") hint = "【E】拿文件夹";
    else if (g.near && g.near.kind === "exit") hint = lv.elevator
      ? (g.elev.state === "idle" ? "【E】呼叫电梯" : (g.elev.state === "arrived" ? "【E】进电梯" : "电梯还在下来…"))
      : "【E】下班！";
    else if (g.phase === "play") hint = lv.hint;
    if (hint) txt(hint, W / 2, H - 12, 13, COL.exit, "center");

    /* 弹出提示 */
    for (i = 0; i < g.toast.length; i++) {
      ctx.globalAlpha = Math.min(1, g.toast[i].t * 1.5);
      txt(g.toast[i].s, W / 2, H * 0.24 + i * 22, 16, g.toast[i].col, "center");
      ctx.globalAlpha = 1;
    }
  }

  /* ═════════════════ 7. 对局逻辑 ═════════════════ */

  /* 玩家碰撞：轴分离 + 四角检测。轴分离是为了不卡在墙角（贴墙滑行是潜行的基本手感）。 */
  function canStand(lv, x, y, r) {
    return !isSolidW(lv, x - r, y - r) && !isSolidW(lv, x + r, y - r) &&
           !isSolidW(lv, x - r, y + r) && !isSolidW(lv, x + r, y + r);
  }

  function updateNear(g) {
    var lv = g.lv, pl = g.player, T = TUNE.TILE;
    var best = null, bestD = 1e9;
    function consider(tx, ty, kind, extra) {
      var d = Math.sqrt(Math.pow(pl.x - (tx + 0.5) * T, 2) + Math.pow(pl.y - (ty + 0.5) * T, 2)) / T;
      if (d > (extra || TUNE.COFFEE_REACH)) return;
      if (d < bestD) { bestD = d; best = { x:tx, y:ty, kind:kind }; }
    }
    var i;
    for (i = 0; i < lv.coffee.length; i++) consider(lv.coffee[i].x, lv.coffee[i].y, "coffee");
    for (i = 0; i < lv.folders.length; i++) if (!lv.folders[i].taken) consider(lv.folders[i].x, lv.folders[i].y, "folder", 1.5);
    for (i = 0; i < lv.exit.length; i++) consider(lv.exit[i].x, lv.exit[i].y, "exit", TUNE.ELEV_REACH);
    g.near = best;
  }

  function step(dt) {
    var g = G;
    if (!g || !g.lv) return;
    if (dt > 0.1) dt = 0.1;
    var i, lv = g.lv;

    /* 被发现后的定格：什么都不动，只等定格结束再重开本关 */
    if (g.phase === "caught") {
      g.timeUsed += dt;
      if (g.timeUsed >= g.revealUntil) {
        g.retry++;
        loadLevel(g, g.levelIndex, false);      // 本关重来，**时限不重置**，已过关保留
        pushToast(g, "本关重来（时限继续走）", COL.alert);
      }
      return;
    }
    if (g.phase !== "play") return;

    /* ── 玩家移动 ── */
    var ax = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    var ay = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    var len = Math.sqrt(ax * ax + ay * ay);
    var pl = g.player;
    pl.moving = len > 0;
    if (pl.moving) {
      ax /= len; ay /= len;
      pl.face = Math.atan2(ay, ax);
      pl.step += dt;
      var sp = TUNE.SPEED * dt;
      var nx = pl.x + ax * sp, ny = pl.y + ay * sp;
      if (canStand(lv, nx, pl.y, pl.r)) pl.x = nx;
      if (canStand(lv, pl.x, ny, pl.r)) pl.y = ny;
      pl.x = limit(pl.x, pl.r, lv.w * TUNE.TILE - pl.r);
      pl.y = limit(pl.y, pl.r, lv.h * TUNE.TILE - pl.r);
    }

    /* ── 时间：三关共用，不会因为被抓而重置 ── */
    g.timeUsed += dt;
    g.timeLeft -= dt;
    if (g.coffeeCd > 0) g.coffeeCd = Math.max(0, g.coffeeCd - dt);
    if (g.coffeeActive && g.timeUsed > g.coffeeUntil) {
      g.coffeeActive = false;
      for (i = 0; i < g.patrols.length; i++) if (g.patrols[i].lure) g.patrols[i].lure = null;
    }

    /* ── 巡逻 ── */
    for (i = 0; i < g.patrols.length; i++) stepPatrol(lv, g.patrols[i], dt, g.timeUsed, {});

    /* ── 电梯计时 ── */
    if (g.elev.state === "calling" && g.timeUsed - g.elev.at >= TUNE.ELEV_WAIT) {
      g.elev.state = "arrived";
      pushToast(g, "电梯到了！靠近门口按 E", COL.exit);
      beep(880, 0.16, "triangle", 0.09);
    }

    /* ── 看见判定 ── */
    var disguised = g.timeUsed < g.disguiseUntil;
    var seen = anySees(lv, g.patrols, pl.x, pl.y, { disguised: disguised });
    for (i = 0; i < g.patrols.length; i++) g.patrols[i].sees = (g.patrols[i] === seen);
    g.seenBy = seen;
    if (seen) {
      /* 被发现：**立即失败**（原作就是即时失败，这是紧张感的全部来源） */
      g.phase = "caught";
      g.caught++; g.ghost = false;
      g.revealUntil = g.timeUsed + TUNE.REVEAL_SEC;
      beep(140, 0.32, "square", 0.10);
      return;
    }

    if (g.timeLeft <= 0) { g.timeLeft = 0; endRun(g, "timeout"); return; }

    updateNear(g);

    /* 弹出提示寿命 */
    for (i = g.toast.length - 1; i >= 0; i--) {
      g.toast[i].t -= dt;
      if (g.toast[i].t <= 0) g.toast.splice(i, 1);
    }
  }

  /* ── E 互动 ── */
  function interact(g) {
    /* ⚠ 这里**不能**判 g.frozen：freeze 是只给调试钩子的"停住时间"，
       不是暂停。把互动一起挡掉会让无头验收完全没法用（点不动 E/空格），
       而且和玩家按 P 的语义混在一起了。 */
    if (!g || g.phase !== "play" || g.paused) return false;
    var n = g.near;
    if (!n) return false;
    if (n.kind === "folder") {
      var i;
      for (i = 0; i < g.lv.folders.length; i++) {
        if (g.lv.folders[i].x === n.x && g.lv.folders[i].y === n.y && !g.lv.folders[i].taken) {
          g.lv.folders[i].taken = true; g.hasFolder = true; g.folderTaken = true;
          pushToast(g, "拿到文件夹 —— 进入视野前按空格伪装", COL.folder);
          beep(660, 0.12, "triangle", 0.08);
          updateNear(g);
          return true;
        }
      }
      return false;
    }
    if (n.kind === "coffee") {
      if (g.coffeeCd > 0) { pushToast(g, "咖啡机还在响，等它凉一下", COL.alert); return false; }
      /* 调虎离山：把巡逻引到茶水间（这是唯一能改变棋盘的动作） */
      var lg = g.lv.lounge[0];
      if (!lg) return false;
      g.coffeeActive = true; g.coffeeUntil = g.timeUsed + TUNE.COFFEE_LURE_SEC;
      g.coffeeCd = TUNE.COFFEE_LURE_SEC + TUNE.COFFEE_COOLDOWN;
      var lured = 0;
      for (var j = 0; j < g.patrols.length; j++) {
        g.patrols[j].lure = { x: (lg.x + 0.5) * TUNE.TILE, y: (lg.y + 0.5) * TUNE.TILE };
        g.patrols[j].lureUntil = g.coffeeUntil;
        lured++;
      }
      pushToast(g, "咖啡机响了，主管转向茶水间。趁现在！", COL.coffeeOn);
      beep(520, 0.18, "sine", 0.08);
      return true;
    }
    if (n.kind === "exit") {
      if (g.lv.elevator) {
        if (g.elev.state === "idle") {
          g.elev.state = "calling"; g.elev.at = g.timeUsed;
          pushToast(g, "呼叫电梯 —— 等 " + TUNE.ELEV_WAIT + " 秒，留意身后", COL.exit);
          beep(440, 0.16, "triangle", 0.08);
          return true;
        }
        if (g.elev.state === "arrived") { finishLevel(g); return true; }
        pushToast(g, "电梯还在下来…", COL.alert);
        return false;
      }
      finishLevel(g);
      return true;
    }
    return false;
  }

  /* ── 空格：用文件夹伪装（限时免疫，不是隐身）── */
  function useFolder(g) {
    if (!g || g.phase !== "play" || g.paused) return false;   // 同样不判 frozen
    if (!g.hasFolder) { pushToast(g, "还没有文件夹（打印区可拾取）", COL.alert); return false; }
    if (g.timeUsed < g.disguiseUntil) return false;
    g.hasFolder = false;
    g.disguiseUntil = g.timeUsed + g.mode.disguise;
    pushToast(g, "伪装中 " + g.mode.disguise.toFixed(1) + " 秒 —— 主管不会起疑", "#4dd8ff");
    beep(760, 0.16, "triangle", 0.09);
    return true;
  }

  function finishLevel(g) {
    g.cleared++;
    var last = (g.levelIndex >= LEVELS.length - 1);
    g.phase = "levelclear";
    g.clear = {
      level: g.levelIndex + 1, last: last, name: g.lv.name,
      used: g.timeUsed, left: g.timeLeft, caught: g.caught, ghost: g.ghost
    };
    beep(990, 0.22, "triangle", 0.09);
    if (last) endRun(g, "allclear");
  }

  function nextLevel() {
    var g = G;
    if (!g || g.phase !== "levelclear" || !g.clear || g.clear.last) return;
    loadLevel(g, g.levelIndex + 1, false);
    pushToast(g, "第 " + (g.levelIndex + 1) + " 关 · " + g.lv.name, COL.exit);
  }

  function endRun(g, why) {
    var mode = g.mode;
    /* ⚠ 时间分必须**按通关进度打折**：全额给的话，"一关不过、在原地躲到时间结束"
       也能拿到满额时间分（实测 0 关却有 900 分），那就成了一个不动就赚钱的漏洞。 */
    var progress = g.cleared / LEVELS.length;
    var timeScore = Math.round(Math.min(TUNE.SPEED_BONUS_MAX, scoreOf("time", g.timeLeft)) * progress);
    var ghost = (g.ghost && g.cleared === LEVELS.length);
    var score = g.cleared * scoreOf("level") + timeScore + (ghost ? scoreOf("ghost") : 0);
    var pay = payoutOf(score, g.modeId);
    var entry = g.practice ? 0 : TUNE.ENTRY;
    var net = pay - entry;
    var grade = (g.cleared === LEVELS.length) ? (ghost ? "S" : "A")
      : (g.cleared === LEVELS.length - 1 ? "B" : (g.cleared > 0 ? "C" : "D"));
    g.result = {
      why: why, mode: g.modeId, grade: grade,
      cleared: g.cleared, levels: LEVELS.length, caught: g.caught, ghost: ghost,
      timeUsed: Math.round(g.timeUsed), timeLeft: Math.round(g.timeLeft),
      levelScore: g.cleared * scoreOf("level"), timeScore: timeScore,
      ghostScore: ghost ? scoreOf("ghost") : 0,
      score: score, pay: pay, entry: entry, net: net,
      practice: g.practice
    };
    g.phase = "result";
    if (!g.practice && opts0 && typeof opts0.onSettle === "function") {
      try { opts0.onSettle(net, g.result); } catch (e) {}
    }
    if (opts0 && typeof opts0.onFinish === "function") {
      try { opts0.onFinish(g.result); } catch (e) {}
    }
    beep(ghost ? 1180 : 620, 0.3, "triangle", 0.09);
  }

  /* ── 结算面板 ── */
  function drawOverlay() {
    var g = G;
    if (!g) return;
    if (g.phase === "caught") {
      ctx.fillStyle = "rgba(180,20,50,.30)"; ctx.fillRect(0, 0, W, H);
      txt("被 发 现 了", W / 2, H / 2 - 14, 34, "#ff8fa3", "center");
      txt("下班行动失败 —— 本关重来，时限继续走", W / 2, H / 2 + 26, 15, "rgba(255,255,255,.8)", "center", "normal");
      return;
    }
    if (g.phase === "levelclear" && g.clear && !g.clear.last) {
      panel(W, H, 380, 190);
      var c = g.clear, y = H / 2 - 52;
      txt("第 " + c.level + " 关 通过", W / 2, y, 20, "#5dffa0", "center");
      row("关卡", c.name, W, y + 34);
      row("累计用时", Math.round(c.used) + " 秒", W, y + 58);
      row("剩余时间", Math.round(c.left) + " 秒", W, y + 82);
      txt("【空格 / E】继续下一关", W / 2, y + 122, 14, "#20222c", "center");
      return;
    }
    if (g.phase === "result" && g.result) {
      var r = g.result;
      panel(W, H, 420, 300);
      var yy = H / 2 - 118;
      txt("下 班 结 算", W / 2, yy, 20, "#20222c", "center");
      yy += 30;
      line(W, yy);
      yy += 22;
      row("通关", r.cleared + " / " + r.levels + " 关", W, yy); yy += 24;
      row("被抓次数", String(r.caught), W, yy); yy += 24;
      row("总用时", r.timeUsed + " 秒", W, yy); yy += 24;
      row("剩余时间", r.timeLeft + " 秒", W, yy); yy += 24;
      row("关卡分 + 时间分", r.levelScore + " + " + r.timeScore, W, yy); yy += 24;
      if (r.ghostScore) { row("全程零被发现", "+" + r.ghostScore, W, yy); yy += 24; }
      line(W, yy); yy += 22;
      row("总分 / 评级", r.score + " · " + r.grade, W, yy); yy += 24;
      row("赔付 − 入场", "¥" + r.pay + " − ¥" + r.entry, W, yy); yy += 30;
      txt("净收益  " + (r.net > 0 ? "+" : "") + "¥" + r.net, W / 2, yy + 4, 20,
          r.net > 0 ? "#1c7a4a" : (r.net < 0 ? "#b03a4a" : "#20222c"), "center");
      txt(r.practice ? "练手局 · 不结算财富" : "【空格】再来一次 · Esc 关闭",
          W / 2, H / 2 + 128, 13, "#8a836f", "center", "normal");
    }
  }
  function panel(w, h, pw, ph) {
    var px = (w - pw) / 2, py = (h - ph) / 2;
    ctx.fillStyle = "rgba(11,10,19,.78)"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#f4efe2"; roundRect(ctx, px, py, pw, ph, 6); ctx.fill();
    ctx.strokeStyle = "#c9a24a"; ctx.lineWidth = 2; roundRect(ctx, px, py, pw, ph, 6); ctx.stroke();
  }
  function row(k, v, w, y) {
    txt(k, w / 2 - 150, y, 13, "#5b5646", "left", "normal");
    txt(v, w / 2 + 150, y, 13.5, "#20222c", "right");
  }
  function line(w, y) {
    ctx.strokeStyle = "rgba(32,34,44,.22)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w / 2 - 160, y); ctx.lineTo(w / 2 + 160, y); ctx.stroke();
  }

  /* ═════════════════ 8. 输入 ═════════════════ */
  var KEYMAP = {
    ArrowLeft:"left", a:"left", A:"left",
    ArrowRight:"right", d:"right", D:"right",
    ArrowUp:"up", w:"up", W:"up",
    ArrowDown:"down", s:"down", S:"down"
  };
  function onKeyDown(e) {
    var g = G; if (!g) return;
    var k = KEYMAP[e.key];
    if (k) { keys[k] = true; e.preventDefault(); return; }
    if (e.key === " " || e.key === "Spacebar" || e.code === "Space") {
      e.preventDefault();
      if (g.phase === "levelclear" && g.clear && !g.clear.last) { nextLevel(); return; }
      if (g.phase === "result") { restart(); return; }
      useFolder(g); return;
    }
    if (e.key === "e" || e.key === "E") { e.preventDefault(); interact(g); return; }
    if (e.key === "p" || e.key === "P") { g.paused = !g.paused; e.preventDefault(); return; }
    if (e.key === "Escape" && g.phase === "levelclear") nextLevel();
  }
  function onKeyUp(e) { var k = KEYMAP[e.key]; if (k) keys[k] = false; }

  function frame(ts) {
    if (!running) return;
    rafId = root.requestAnimationFrame(frame);
    if (!lastTs) lastTs = ts;
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    /* frozen 是**只给调试钩子**的冻结：停掉 rAF 推进但互动照常可用，
       与 paused（玩家按 P）不是一回事。无头验收靠它做确定性命中。 */
    if (G && !G.paused && !G.frozen) step(dt);
    render();
    drawOverlay();
    if (G && G.paused) {
      ctx.fillStyle = "rgba(11,10,19,.66)"; ctx.fillRect(0, 0, W, H);
      txt("已暂停", W / 2, H / 2 - 10, 28, COL.exit, "center");
      txt("P 继续 · Esc 关闭", W / 2, H / 2 + 24, 14, "rgba(233,227,209,.7)", "center", "normal");
    }
  }

  function restart() { G = newGame(opts0); fitCanvas(); return G; }

  /* ═════════════════ 9. start / dispose / isBusy ═════════════════ */
  function start(host, opts) {
    if (!root || !doc) return false;
    if (running) dispose();
    hostEl = host;
    if (!hostEl) return false;
    opts0 = opts || {};
    var c = doc.createElement("canvas");
    c.style.display = "block"; c.style.borderRadius = "4px";
    c.style.background = COL.hud; c.style.touchAction = "none";
    hostEl.innerHTML = "";
    hostEl.appendChild(c);
    cv = c; ctx = c.getContext("2d");
    if (!ctx) { hostEl.innerHTML = ""; return false; }
    G = newGame(opts0);
    fitCanvas();
    doc.addEventListener("keydown", onKeyDown, false);
    doc.addEventListener("keyup", onKeyUp, false);
    running = true; lastTs = 0;
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
    if (hostEl) hostEl.innerHTML = "";
    cv = null; ctx = null; G = null; hostEl = null; opts0 = null;
    keys.left = keys.right = keys.up = keys.down = false;
    return true;
  }
  function isBusy() { return running; }

  /* ═════════════════ 10. 调试钩子 ═════════════════ */
  debug.state = function () {
    if (!G) return null;
    var g = G;
    return {
      phase: g.phase, mode: g.modeId, level: g.levelIndex + 1, levelName: g.lv.name,
      levels: LEVELS.length, elevator: !!g.lv.elevator,
      cleared: g.cleared, caught: g.caught, ghost: g.ghost,
      timeLeft: +g.timeLeft.toFixed(2), timeUsed: +g.timeUsed.toFixed(2),
      px: +g.player.x.toFixed(1), py: +g.player.y.toFixed(1),
      hasFolder: g.hasFolder, folderTaken: g.folderTaken,
      disguised: g.timeUsed < g.disguiseUntil,
      disguiseLeft: +Math.max(0, g.disguiseUntil - g.timeUsed).toFixed(2),
      coffeeActive: g.coffeeActive, coffeeCd: +g.coffeeCd.toFixed(2),
      elev: g.elev.state,
      near: g.near ? { kind: g.near.kind, x: g.near.x, y: g.near.y } : null,
      patrols: g.patrols.length, lured: g.patrols.filter(function (p) { return !!p.lure; }).length,
      seenBy: g.seenBy ? g.seenBy.i : null,
      result: g.result, clear: g.clear,
      worldW: W, worldH: H
    };
  };
  debug.level = function () { return G ? G.lv : null; };
  debug.patrols = function () {
    if (!G) return [];
    return G.patrols.map(function (p) {
      return { i:p.i, x:+p.x.toFixed(1), y:+p.y.toFixed(1),
               angle:+(p.angle * 180 / Math.PI).toFixed(1), mode:p.mode,
               sees:!!p.sees, lured:!!p.lure,
               range:Math.round(p.range), halfFov:+(p.halfFov * 180 / Math.PI).toFixed(1) };
    });
  };
  debug.key = function (name, down) { if (name in keys) keys[name] = !!down; };
  debug.keyDown = function (k) { onKeyDown({ key:k, preventDefault:function () {} }); };
  debug.tick = function (ms) {
    var n = Math.max(1, Math.round((ms || 16) / 16)), i;
    for (i = 0; i < n; i++) step(0.016);
    render(); drawOverlay();
  };
  debug.freeze = function (on) { if (G) G.frozen = (on !== false); };
  debug.unfreeze = function () { if (G) G.frozen = false; };
  debug.pause = function () { if (G) G.paused = true; };
  debug.resume = function () { if (G) G.paused = false; };
  debug.restart = function (opts) { if (opts) opts0 = opts; return restart(); };
  debug.interact = function () { return interact(G); };
  debug.useFolder = function () { return useFolder(G); };
  /* 把玩家瞬移到某格中心（无头验收要精确站到"咖啡机旁/电梯旁/某个巡逻者的视野里"）*/
  debug.seek = function (tx, ty) {
    if (!G) return null;
    G.player.x = (tx + 0.5) * TUNE.TILE;
    G.player.y = (ty + 0.5) * TUNE.TILE;
    updateNear(G);
    return { x:+G.player.x.toFixed(1), y:+G.player.y.toFixed(1), near:G.near ? G.near.kind : null };
  };
  debug.levelDone = function () { if (G) { finishLevel(G); render(); drawOverlay(); } };
  debug.nextLevel = function () { nextLevel(); render(); drawOverlay(); };
  debug.finishNow = function () { if (G) { endRun(G, "debug"); render(); drawOverlay(); } };
  debug.setTime = function (sec) { if (G) G.timeLeft = sec; };
  debug.giveFolder = function () { if (G) { G.hasFolder = true; G.folderTaken = true; } };
  /* 把某个巡逻者摆到指定格、朝向指定角度 —— 用来精确构造"看得见 / 看不见"的场面 */
  debug.placePatrol = function (i, tx, ty, deg) {
    if (!G || !G.patrols[i]) return null;
    var p = G.patrols[i];
    p.x = (tx + 0.5) * TUNE.TILE; p.y = (ty + 0.5) * TUNE.TILE;
    p.lure = null; p.mode = "scan"; p.timer = 0; p.scanFrom = deg2rad(deg); p.angle = deg2rad(deg);
    return { i:i, x:+p.x.toFixed(1), y:+p.y.toFixed(1), deg:deg };
  };
  /* 把所有巡逻者暂时致盲（视距归零）—— 无头验收要单独验"电梯/出口"这类流程机制时，
     得先把潜行层隔离掉：否则等待电梯的那几秒里被巡逻抓到，本关重开会把电梯状态复位，
     测出来的失败是"被抓"而不是"电梯坏了"。 */
  debug.blindAll = function (on) {
    if (!G) return null;
    for (var i = 0; i < G.patrols.length; i++) {
      G.patrols[i].range = (on === false) ? (TUNE.RANGE * G.mode.fovMul) : 0;
    }
    return G.patrols.length;
  };
  debug.lifecycle = function () {
    return { running: running, busy: isBusy(), hasCanvas: !!cv, phase: G ? G.phase : null, raf: rafId > 0 };
  };
  rules.conePoly = conePoly;

  /* ═════════════════ 导出 ═════════════════ */
  root.Clockout = {
    version: "1.0.0",
    start: start,
    isBusy: isBusy,
    dispose: dispose,
    TUNE: TUNE,
    MODES: MODES,
    LEVELS: LEVELS,
    rules: rules,
    debug: debug
  };

})(window);
