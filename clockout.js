/* ══════════════════════════════════════════════════════════════════════════════
   clockout.js —「准点下班」· 办公室潜行（俯视）

   自包含 IIFE，暴露全局 window.Clockout；ES5 风格，不使用 ES module，
   不依赖页面内变量（只读 opts / 挂载 hostEl）。**贴图优先、缺图回落**：
   art/clockout/ 下的本地 PNG（三关整张背景 + 玩家/坐姿/主管/老板）用 new Image()
   异步预加载，加载好了自动用上；任何一张缺失/失败都永久标记不可用，回落到现在
   这套程序化绘制（地板格 + 墙体矩形 + 角色色块），一局都不会少玩。

   一句话规格（V2 引擎 · 按 clockout-v2-spec.md 逐条实现）：3000×2000 连续世界里躲开
   主管/老板/保安的视野锥（**只有墙体矩形挡视线**），用工位坐姿伪装、用文件夹换 6 秒免疫、
   用咖啡机把主管钉在原地，三关之内走进电梯。**被看见立即失败**（整局冻结，重试本关时
   已通关的关卡保留）。地狱模式两层：一层电梯 → 换**下一张图** → 二层电梯 = 通关。

   对外 API（**签名与 debug 钩子保持不变**，浏览器验收脚本依赖它们）：
     window.Clockout.start(hostEl, opts) -> boolean   // 建局即开打：第一帧就已经是 playing
       opts:{ cash:()=>number, phys:()=>number, intel:()=>number,
              onSettle:(net,info)=>{}, onFinish:(result)=>{},
              practice:boolean, mode:"normal|extreme|hell", seed:number }
       info 至少含：{ grade, cleared, levels, ghost, timeUsed, timeLeft, pay, entry, net, why, caught }
       net = 赔付 − 入场（¥20）；练手局不调用 onSettle、不收费。
     window.Clockout.isBusy(), dispose()
     window.Clockout.debug = { state(), level(), patrols(), key(n,d), keyDown(k), tick(ms),
       freeze(on), unfreeze(), pause(), resume(), restart(opts), interact(), useFolder(),
       seek(x,y), levelDone(), nextLevel(), finishNow(), setTime(s), giveFolder(),
       placePatrol(i,x,y,deg), blindAll(on), lifecycle(), retry(),
       新增（只增不改，上面 22 个签名一个没动）：
       collisionOverlay(on), art(), artFail(on), view(mode) }
       ⚠ view(mode)：视角档位 "flat"（俯视，与改造前逐像素一致）/ "tilt"（倾斜 2.5D，
         默认）/ "deep"（强立体）；不带参数返回当前档。也可点画布右下角的小控件循环切换。
         **纯渲染层**：判定 / 状态机 / 经济一行都没动（见第 9.0 节）。
       ⚠ collisionOverlay(on)：细线描出 map.walls 的矩形，用来核对"看到的家具"与
         "实际的碰撞"是否对齐；不带参数 = 开关切换，默认关。
       ⚠ seek(x,y) / placePatrol(i,x,y,deg) 收的是**世界像素**（V1 是格坐标）：3000×2000 里
         直接给点，例如电梯 (2790,1650)、工位 (930,1110)。
       ⚠ state().phase 用规格状态机：intro / playing / paused / floor-intro / won / lost；
         V1 的 play/caught/levelclear/result 语义放进 state().status（老脚本可改读它）。
       ⚠ state().worldW/worldH 现在是**世界尺寸** 3000×2000；画布尺寸见 canvasW/canvasH。
       ⚠ g.npcs 的下标：0 主管 / 1 老板 / 2.. 保安 / **最后一个是同事**（同事不抓人也不绘制，
         所以 placePatrol(0..N-1) 摆的都是看得见、抓得到人的巡查）。

   附加（单测用，不属于规格）：window.Clockout.rules / window.Clockout.MAPS / .WORLD

   ── 设计要点（为什么这么做，改之前先读）────────────────────────────────────────
   1) **判定只有两条纯函数**：`walkable(x,y,r,map)`（矩形膨胀 + bounds 四条边）与
      `clearLine`（8px 步长采样、**不含两端点**、半径 0）。视野 = 距离 `>` 严格失败 ∧
      角度 `<` 严格通过 ∧ 中间没有墙。潜行游戏的 bug 几乎全在这里，所以它不碰 canvas，
      单测直接喂像素坐标验边界（正好等于 range 算看得见、正好等于半角算看不见）。

   2) **墙体是"实拍家具轮廓"的像素矩形**（规格 §6，三张图 20/20/22 面，坐标一字不改）。
      它们既挡人也挡视线 —— V2 **没有** V1 那种"挡视线但能走过"的半高隔板，
      所以"路线"来自绕行与时机，而不是贴边蹭过去。改动任何数字前先跑 validateLevel。

   3) **巡逻是随机目标 + 25px 网格 BFS 寻路**，不是固定航线：每次重试换 seed 就换一套
      走位（背板子没用，得读现场），但同 seed 必须完全可复现（状态在 `g.seed` 上自增哈希，
      用 imul 的 ES5 等价实现，连上游的随机序列都能逐位对上）。

   4) **咖啡机是唯一能改变棋盘的动作**，而且只对主管生效（原地转向、完全不动、连停顿
      计时都冻住）。同事不抓人、也不绘制，但会在 75px 内喊话并把主管的朝向扭向你 1.8 秒 ——
      这是"被发现"最隐形的一个来源，也是它存在的唯一理由。

   5) **失败即冻结**：`phase='lost'` 之后 tick / interact / useFile 全部短路，整个 g 对象
      字节级不变（规格契约）—— 所以**失败后 E 与空格也不再是重试键**（那会改动状态）；
      重试走画面点击或 debug.retry()。经济结算同时落地（onSettle 只调一次）；
      「重试」= 回到本关第一层 + 保留已通关记录 + 换新 seed，入口费按新一局再收一次。
      `state().seed` 是**实时随机状态**（会随巡逻推进），要判"这局用的哪个种子"读 seed0。
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";
  if (!root || root.Clockout) return;

  var doc = root.document;

  /* ═════════════════ 1. 世界常量（规格 §1 / §6 · 全部是**像素**，不是格子） ═════════════════
     V2 引擎在 3000×2000 的连续坐标里跑：玩家半径 18、速度 220 px/s（斜向不加速），
     墙体是可重叠的矩形数组，视线用 8px 步长采样，寻路用 25px 网格 BFS。
     改手感只动这一节；改判定之前先读第 2 节的注释。 */

  var WORLD_W = 3000, WORLD_H = 2000;      /* §1.1 世界尺寸（px） */
  var PLAYER_R = 18, PLAYER_SPEED = 220;   /* §1.2 / §1.4 玩家碰撞半径、速度 */
  var DT_MAX = 0.05;                       /* §1.3 单帧 dt 上限（s） */
  var SAMPLE_STEP = 8;                     /* §1.2 clearLine 采样间距（px，间距 ≤ 8） */
  var GRID_STEP = 25;                      /* §1.2 pathTo 网格步长（px，4 邻域 BFS） */
  var REACH = { lift:88, seat:76, printer:85, coffee:76 };   /* §1.2 交互半径（严格 <，且要 clearLine） */
  var FOV_NPC = 1.1, FOV_COWORKER = 1.5;   /* §1.8 视野锥：**弧度、整锥张角** */

  var TUNE = {
    ENTRY: 20,                /* 入场 ¥20（与刮刮乐/开窗/外卖同价） */

    /* ── 世界 / 移动（规格值）── */
    WORLD_W: WORLD_W, WORLD_H: WORLD_H,
    P_R: PLAYER_R,
    SPEED: PLAYER_SPEED,
    /* ⚠ 兼容键：V2 没有地格了，TILE 只表示寻路网格步长；PATROL_SPEED 是普通第 1 关的
       基础速度（真正生效的速度 = 关卡基础表 × 模式倍率，见 createGame）。 */
    TILE: GRID_STEP,
    PATROL_SPEED: 120,

    /* ── 视野锥 ── */
    FOV_DEG: 63.025357464,    /* = 1.1 rad（主管/老板/保安）；同事 1.5 rad = 85.94366927° */
    FOV_COWORKER: 85.94366927,
    RANGE: 280,               /* 兼容键：普通第 1 关的主管视距 */

    /* ⚠ 下面 4 个是 V1 地格版遗留：V2 的朝向是**瞬时**的，没有"停下扫视"状态机。
       留着键只是为了不让旧脚本/旧单测读到 undefined（读到 0 也一眼看得出没在用）。 */
    SCAN_SWEEP_DEG: 0, SCAN_TURN: 0, PATROL_TURN: 0, SCAN_HOLD: 0,

    /* ── 伪装（文件夹）── */
    DISGUISE_SEC: 6,          /* 普通模式 cover；变态 4 / 地狱 2.5 */
    DISGUISE_HELL: 2.5,
    FOLDER_PER_LEVEL: 1,      /* 每层一份（**换层会清空**：二层要重新去打印区拿） */

    /* ── 咖啡机（调虎离山）── */
    COFFEE_LURE_SEC: 8,       /* 普通第 1 关 lureDuration（变态/地狱按关卡表） */
    COFFEE_COOLDOWN: 0,       /* V2 没有冷却：lureUsed 一次性 */
    COFFEE_REACH: REACH.coffee,

    /* ── 电梯 ── */
    ELEV_WAIT: 3,             /* 普通第 1 关等待秒数（变态 +2 / 地狱 +4） */
    ELEV_REACH: REACH.lift,
    TIME_NORMAL: 150, TIME_HELL: 204,   /* 兼容键：三关各自时限的第 1 关裸值 */
    REVEAL_SEC: 1.15,         /* 兼容键：V2 失败即整局冻结，没有"定格后重开" */
    CAUGHT_TIME_COST: 0,      /* 兼容键：V2 没有额外罚时 */

    /* ── 计分（经济结算口径不变：net = 赔付 − 入场 ¥20）── */
    PER_LEVEL: 1200,          /* 每过一关 */
    PER_SECOND_LEFT: 10,      /* 每省下 1 秒（三关累计省时） */
    GHOST_BONUS: 800,         /* 全程零被发现 */
    SPEED_BONUS_MAX: 900      /* 用时奖励上限（防止刷时间） */
  };

  /* 得分登记表 —— 唯一的加分行数来源。
     刻意**没有**任何"被发现/被抓"的加分项：失败只能扣，不能变成收益。 */
  var SCORE_TABLE = {
    level: TUNE.PER_LEVEL,
    time: 1,
    ghost: TUNE.GHOST_BONUS
  };

  /* 难度表（规格 §1.6 逐字）。
     ⚠ `time` 是**倍率**不是秒数：V1 的 `time:215/195` 语义已废弃，每关自己的时限是
       `Math.round(LEVELS[i].time × MODES[m].time)`（普通 150/140/130、变态 125/116/108、
       地狱 204/190/177 —— 地狱更长是因为**两层共用**）。
     ⚠ `n` / `sub` / `levels` / `patrolMul` / `fovMul` / `disguise` 是兼容键：
       index.html 读 `.n`，旧单测读 `.levels`；新引擎真正用的是 speed/range/time/extra/wait/cover/pause/floors。 */
  var MODES = {
    normal:  { id:"normal",  name:"普通", n:"正常", sub:"三关 · 每层 2 名巡查 · 6 秒伪装", levels:3,
               speed:1,    range:1,    time:1,    extra:0, wait:0, cover:6,   pause:1,   floors:1,
               patrolMul:1, fovMul:1, disguise:6, description:"每层 2 名巡查 · 6 秒文件伪装" },
    extreme: { id:"extreme", name:"变态", n:"变态", sub:"三关 · 每层 3 名巡查 · 更快更广", levels:3,
               speed:1.22, range:1.13, time:.83,  extra:1, wait:2, cover:4,   pause:.65, floors:1,
               patrolMul:1.22, fovMul:1, disguise:4, description:"每层 3 名巡查 · 更快更广 · 4 秒伪装" },
    hell:    { id:"hell",    name:"地狱", n:"地狱", sub:"双层楼 · 每层 6 名巡查 · 2.5 秒伪装", levels:3,
               speed:1.42, range:1.26, time:1.36, extra:4, wait:4, cover:2.5, pause:.32, floors:2,
               patrolMul:1.42, fovMul:1, disguise:2.5, description:"双层楼 · 每层 6 名巡查 · 2.5 秒伪装" }
  };

  /* 赔付阶梯：每模式一条（单一阶梯会把某个模式变成印钞机 —— 切果那次踩过）。
     数值由 simulateRun 分布反推，见 tests/clockout.test.cjs 的不变量断言。
     ⚠ 门槛必须按"该模式能拿到的满分"定：变态/地狱每关时限更短 → 省时奖励更少，
       所以它们的门槛整体下移，否则难度越高给钱越少（那就没人打难的）。 */
  var PAYOUT = {
    normal:  [ {min:0,pay:0}, {min:1400,pay:3}, {min:2400,pay:9}, {min:3300,pay:17},
               {min:4100,pay:27}, {min:4700,pay:40}, {min:5200,pay:58} ],
    extreme: [ {min:0,pay:0}, {min:1300,pay:3}, {min:2200,pay:9}, {min:3000,pay:17},
               {min:3700,pay:27}, {min:4300,pay:40}, {min:4700,pay:58} ],
    hell:    [ {min:0,pay:0}, {min:1300,pay:3}, {min:2200,pay:9}, {min:3000,pay:16},
               {min:3700,pay:26}, {min:4300,pay:40}, {min:4800,pay:58} ]
  };

  /* ═════════════════ 2. 三张地图的真实几何（规格 §6 · 20/20/22 面墙） ═════════════════
     V2 的"家具"就是下面这些像素矩形：**既挡人也挡视线**，没有 V1 那种半高隔板中间态。
     坐标一字不改（来自三张定稿插画的实测轮廓）：动任何一个数字，玩法点都可能落进墙里，
     或者出生点不再安全 —— 所以改完必须跑 validateLevel，它会把这类错误直接报出来。
     bounds = [left, top, right, bottom]，walkable 用它在四条边上各内缩 r。 */
  var MAPS = [
    { id:1, name:"开放办公区", art:"office-open", caption:"工位区、茶水间、打印室与接待区",
      bounds:[150,260,2910,1780],
      walls:[
        [0,0,1080,540],      [1290,0,675,560],    [2070,0,450,500],    [2520,0,480,580],
        [0,540,255,500],     [360,600,465,480],   [840,600,465,460],   [1620,600,60,300],
        [1680,600,750,480],  [2430,700,120,380],  [2700,600,300,520],  [0,1150,750,660],
        [825,1160,495,480],  [825,1600,30,200],   [1680,1170,900,420], [1680,1540,39,100],
        [2190,1580,360,120], [2580,1110,420,120], [2580,1200,60,380],  [2910,1180,90,620]
      ],
      points:{ start:{x:300,y:1120}, printer:{x:1380,y:1460}, seat:{x:930,y:1110},
               distraction:{x:790,y:1410}, lift:{x:2790,y:1650} },
      spawns:[[1500,800],[2200,560],[1000,1120],[2680,1100],[1520,1600]] },

    { id:2, name:"会议中心", art:"office-meeting", caption:"大会议室、电话间、协作客厅与项目室",
      bounds:[170,270,2820,1790],
      walls:[
        [0,0,1290,600],      [1890,0,600,740],    [2490,0,510,300],    [2640,300,360,260],
        [1350,160,420,160],  [180,640,750,340],   [1515,420,180,320],  [1200,640,420,160],
        [1155,800,480,180],  [1500,900,300,240],  [1485,1080,75,140],  [1980,720,600,230],
        [2790,740,210,400],  [270,1120,960,320],  [225,1420,630,140],  [900,1480,330,200],
        [480,1680,600,120],  [1425,1380,510,240], [1950,1120,900,580], [0,980,120,820]
      ],
      points:{ start:{x:380,y:1700}, printer:{x:1670,y:1680}, seat:{x:1820,y:900},
               distraction:{x:1270,y:1570}, lift:{x:2710,y:650} },
      spawns:[[1250,1050],[1840,540],[1340,1500],[2700,1050],[1900,1250]] },

    { id:3, name:"行政楼层", art:"office-executive", caption:"行政办公室、档案库、前台与双电梯厅",
      bounds:[170,310,2820,1600],
      walls:[
        [0,0,990,560],       [300,560,600,80],    [1980,0,1020,560],   [2100,560,570,80],
        [1080,0,120,340],    [1740,0,180,340],    [0,620,330,180],     [2670,620,330,180],
        [30,780,840,900],    [1095,620,90,360],   [1185,530,630,60],   [1215,590,390,260],
        [1140,860,450,170],  [1095,980,300,60],   [1794,770,255,150],  [1800,640,255,40],
        [2040,770,30,220],   [2070,770,420,30],   [2445,800,45,140],   [855,1160,600,480],
        [1725,1080,1140,560],[2670,780,330,300]
      ],
      points:{ start:{x:1550,y:1550}, printer:{x:2070,y:1030}, seat:{x:1060,y:1100},
               distraction:{x:1500,y:1400}, lift:{x:1500,y:390} },
      spawns:[[950,700],[1500,460],[2100,1000],[2070,700],[950,1100]] }
  ];

  /* ⚠ 兼容键：V1 的地格语义表。V2 没有地格了，留一个表让旧脚本里
     `rules.TILE["#"].solid` 这类读法不至于炸掉。 */
  var TILE = {
    "#": { solid:true,  opaque:true,  n:"墙" },
    "D": { solid:true,  opaque:true,  n:"家具（V2：墙体矩形）" },
    "p": { solid:true,  opaque:true,  n:"隔断（V2 已并入墙体）" },
    ".": { solid:false, opaque:false, n:"地板" },
    "E": { solid:false, opaque:false, n:"出口电梯" },
    "C": { solid:false, opaque:false, n:"咖啡机" },
    "F": { solid:false, opaque:false, n:"文件夹" },
    "L": { solid:false, opaque:false, n:"茶水间" },
    "@": { solid:false, opaque:false, n:"出生点" }
  };

  /* ═════════════════ 3. 关卡基础表（规格 §1.5 逐字） ═════════════════ */

  /* 关卡基础表（规格 §1.5 逐字）。真正生效的 config 由 createGame 按模式算（规格 §1.7）：
       time = round(base.time × MODES[mode].time)、liftWait = base.liftWait + wait、
       bossDelay = 普通 ? base.bossDelay : 0、coverDuration = MODES[mode].cover。
     ⚠ V1 的构建器 API（makeBuilder / ASCII 地格 / w,h / parTime）随引擎一起删除：
       地格不见了、出口统一是电梯、时限改成**每关独立**（V1 是三关共用一个池子）。 */
  var LEVELS = [
    { id:1, name:"开放办公区", time:150, liftWait:3, bossDelay:12, lureDuration:8, speed:120, range:280, bossSpeed:100,
      description:"穿过工位、茶水间和打印区。走中央通道，或沿外侧绕开随机巡查。",
      hint:"出口在东侧中央，留意小地图。" },
    { id:2, name:"会议中心", time:140, liftWait:4, bossDelay:5, lureDuration:7, speed:130, range:300, bossSpeed:115,
      description:"错开的会议室遮挡视线，路线更曲折。穿过两翼通道，抵达东北侧电梯。",
      hint:"东北侧出口，会议室两侧都能绕行。" },
    { id:3, name:"行政楼层", time:130, liftWait:5, bossDelay:0, lureDuration:6, speed:140, range:320, bossSpeed:125,
      description:"中央前台阻断直线，两翼办公室提供掩护。随机巡视的老板守着最后一道关卡。",
      hint:"出口在北侧中央，从左翼或右翼绕行。" }
  ];
  /* 兼容键：V1 的页面/单测读过 LEVELS[i].sub / .elevator / .parTime。
     sub 取地图 caption；elevator 恒 true（三关出口都是电梯）；parTime = 本关裸时限。 */
  for (var LVI = 0; LVI < LEVELS.length; LVI++) {
    LEVELS[LVI].sub = MAPS[LVI].caption;
    LEVELS[LVI].mapId = MAPS[LVI].id;
    LEVELS[LVI].elevator = true;
    LEVELS[LVI].parTime = LEVELS[LVI].time;
  }


  /* ═════════════════ 4. 随机数与几何原语（纯规则层，无 DOM，可在 vm 里整局自跑） ═════════════════ */

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
  /* 摄像机夹取（规格 §1.1）：视野比世界还大时贴 0，否则夹在 [0, world-view]。 */
  function clampCam(v, world, view) { var m = world - view; if (m < 0) m = 0; return limit(v, 0, m); }
  function hyp(dx, dy) { return Math.sqrt(dx * dx + dy * dy); }
  function dist(a, b) { return hyp(a.x - b.x, a.y - b.y); }

  /* 32 位乘法 —— Math.imul 的 ES5 等价实现（仓库禁用 Math.imul）。
     只需要低 32 位正确，自增哈希随机数只用得到这一半；
     这样连上游引擎的随机序列都能逐位对上，排查"路线不一样"时可以直接拿它当参照。 */
  function imul(a, b) {
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff, bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
  }

  /* ═════════════════ 4.1 两个几何原语（规格 §1.2 / §3.3） ═════════════════
     `walkable` = 圆形碰撞盒（用"矩形向外膨胀 r"来近似，和上游一致：不是四角采样）+
     bounds 四条边。`clearLine` = 8px 步长采样、**不含两端点**、半径 0。
     这两条就是全部的空间判定：潜行游戏的 bug 几乎全在这里，所以它们必须是纯函数。 */

  /* 半径 r 的圆能不能站在 (x,y)。r=0 = 只看这个点（视线采样用）；
     越界一律 false —— 世界边界也算阻挡。 */
  function walkable(x, y, r, map) {
    map = map || MAPS[0];
    if (r === undefined || r === null) r = PLAYER_R;
    var b = map.bounds;
    if (x < b[0] + r || x > b[2] - r || y < b[1] + r || y > b[3] - r) return false;
    var w = map.walls;
    for (var i = 0; i < w.length; i++) {
      var a = w[i];
      if (x + r > a[0] && x - r < a[0] + a[2] && y + r > a[1] && y - r < a[1] + a[3]) return false;
    }
    return true;
  }

  /* 两点之间的视线通不通（规格 §3.3）：steps=ceil(dist/8)，只查 i=1..steps-1。
     ⚠ **不含两端点**：否则站在墙边的人永远"看不见"（自己挡住自己）。
     只使用 map.walls 与 bounds，不使用任何角色体积。 */
  function clearLine(a, b, map) {
    map = map || MAPS[0];
    var steps = Math.ceil(dist(a, b) / SAMPLE_STEP);
    for (var i = 1; i < steps; i++) {
      var t = i / steps;
      if (!walkable(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 0, map)) return false;
    }
    return true;
  }

  /* 线段能不能走人（半径 18）—— 只给 pathTo 用：**含两端点**，和 clearLine 不同。
     少了它，BFS 会规划出"擦着墙角过去"的格子，NPC 一走就卡住。 */
  function segmentWalkable(a, b, map) {
    var count = Math.ceil(dist(a, b) / SAMPLE_STEP);
    for (var i = 0; i <= count; i++) {
      var t = count ? i / count : 0;
      if (!walkable(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, PLAYER_R, map)) return false;
    }
    return true;
  }

  /* 视野锥的多边形（渲染用，规格 §1.1）：从 NPC 往外打 47 条射线（i=0..46），
     每条以 7px 步长推进到第一个挡视线的采样点。**裁剪是玩法的一部分**：
     不裁剪的扇形，玩家读不出"哪里是安全的" —— 机制还在，但玩不出来。 */
  function conePoly(n, map, opt) {
    opt = opt || {};
    var rays = opt.rays || 46, range = n.range;
    var pts = [{ x:n.x, y:n.y }];
    var a0 = n.angle - n.fov / 2, a1 = n.angle + n.fov / 2;
    for (var i = 0; i <= rays; i++) {
      var a = a0 + (a1 - a0) * (i / rays);
      var cx = Math.cos(a), cy = Math.sin(a), d = 7;
      while (d < range) {
        if (!walkable(n.x + cx * d, n.y + cy * d, 0, map)) break;
        d += 7;
      }
      if (d > range) d = range;
      pts.push({ x:n.x + cx * d, y:n.y + cy * d });
    }
    return pts;
  }

  /* ═════════════════ 5. 看见 / 被抓 / 四种角色（规格 §3 / §4） ═════════════════ */

  /* 自增哈希随机（规格 §5.1）：状态就在 g.seed 上自增，同 seed ⇒ 完全相同的序列。
     ⚠ 用 imul 的 ES5 等价实现而不是 Math.imul（仓库禁用），位级结果与上游一致。 */
  function random(g) {
    var t = (g.seed = (g.seed + 0x6D2B79F5) >>> 0);
    t = imul(t ^ (t >>> 15), t | 1);
    t = (t ^ (t + imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* 看不看得见（规格 §3.2），三步一条都不能少：
     ① 距离 `>` **严格**（正好等于 range 算看得见）
     ② clearLine 遮挡（8px 采样、不含端点）
     ③ 角度 `<` **严格**（正好等于半角算**看不见**）
     fov 是弧度整锥张角，不是倍数；角度差用 atan2(sin,cos) 归一化，跨 ±π 不会误判。 */
  function sees(n, p, map) {
    map = map || MAPS[0];
    if (dist(n, p) > n.range || !clearLine(n, p, map)) return false;
    var d = Math.atan2(p.y - n.y, p.x - n.x) - n.angle;
    return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) < n.fov / 2;
  }

  function isCoworker(n) { return n.id === "coworker"; }
  /* 老板到场了吗（规格 §4）：没到场就不动、不绘制、也抓不到人。 */
  function bossAwake(g) { return g.elapsed >= g.config.bossDelay; }
  function isDrawable(g, n) {
    if (isCoworker(n)) return false;                      /* 同事永不绘制 */
    if (n.id === "boss" && !bossAwake(g)) return false;   /* 老板没到场也不绘制 */
    return true;
  }
  function supervisorOf(g) {
    for (var i = 0; i < g.npcs.length; i++) if (g.npcs[i].id === "supervisor") return g.npcs[i];
    return null;
  }
  function coworkerOf(g) {
    for (var i = 0; i < g.npcs.length; i++) if (isCoworker(g.npcs[i])) return g.npcs[i];
    return null;
  }

  /* 谁能抓你（规格 §3.1）：**同事永远不能**；老板没到场不能；hidden / cover>0 完全免疫。
     ⚠ tick 里 cover 是**先递减后判定**，所以 cover 剩 0.01 的那一帧就已经不免疫了。 */
  function captureIfSeen(g) {
    if (g.hidden || g.cover > 0) return false;
    var w = null;
    for (var i = 0; i < g.npcs.length; i++) {
      var n = g.npcs[i];
      if (isCoworker(n)) continue;
      if (n.id === "boss" && !bossAwake(g)) continue;
      if (sees(n, g.player, g.map)) { w = n; break; }
    }
    if (!w) return false;
    g.caughtBy = w.id; g.suspicion = 100;
    fail(g, (w.id === "boss" ? "老板" : "主管") + "发现了你，下班行动失败。文件夹只能提前使用。");
    return true;
  }

  /* 巡逻者工厂（规格 §4）：i=0 主管 / 1 老板 / 2 同事 / ≥3 保安。
     差异只有三处（都在 createGame 里传）：同事速度固定 80、视距固定 100、fov 1.5；
     其余角色速度=关卡基础速度、视距=关卡基础视距、fov 1.1。 */
  function npc(id, x, y, route, speed, range, fov) {
    return { id:id, x:x, y:y, route:route || [], target:1, speed:speed,
             range:range, range0:range, fov:fov, angle:Math.PI / 2, pause:0, sees:false,
             lure:false };
  }
  function npcCount(difficulty) { return 3 + difficulty.extra; }

  /* ═════════════════ 6. 寻路与巡逻（规格 §5） ═════════════════ */

  /* 25px 网格 4 邻域 BFS（规格 §5.3）。
     cell() 会把落点吸附到 3×3 邻域里"合法且直线可走"的最近格子 —— 少了这一步，
     站在墙边的 NPC 因为自己不在网格中心，永远规划不出路线（表现为站着不动）。 */
  function pathTo(map, a, b) {
    map = map || MAPS[0];
    var step = GRID_STEP;
    function key(x, y) { return x + "," + y; }
    function cell(p) {
      var best = null, bestD = Infinity;
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          var x = Math.round(p.x / step) + dx, y = Math.round(p.y / step) + dy;
          var q = { x:x * step, y:y * step };
          if (!walkable(q.x, q.y, 20, map)) continue;
          if (!segmentWalkable(p, q, map)) continue;
          var d = dist(p, q);
          if (d < bestD) { bestD = d; best = [x, y]; }
        }
      }
      return best || [NaN, NaN];
    }
    var sc = cell(a), tc = cell(b);
    var sx = sc[0], sy = sc[1], tx = tc[0], ty = tc[1];
    if (!isFinite(sx) || !isFinite(tx)) return [];
    if (!walkable(tx * step, ty * step, 20, map) || !walkable(sx * step, sy * step, 20, map)) return [];
    var first = key(sx, sy), end = key(tx, ty);
    var queue = [[sx, sy]], prev = {}, head = 0, dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    prev[first] = null;
    while (head < queue.length) {
      var cur = queue[head++], x0 = cur[0], y0 = cur[1];
      if (key(x0, y0) === end) break;
      for (var i = 0; i < 4; i++) {
        var nx = x0 + dirs[i][0], ny = y0 + dirs[i][1], nk = key(nx, ny);
        if (prev[nk] !== undefined) continue;
        if (!walkable(nx * step, ny * step, 20, map)) continue;
        if (!segmentWalkable({ x:x0 * step, y:y0 * step }, { x:nx * step, y:ny * step }, map)) continue;
        prev[nk] = key(x0, y0); queue.push([nx, ny]);
      }
    }
    if (prev[end] === undefined) return [];
    var route = [], k = end;
    while (k !== null && k !== undefined) {
      var parts = k.split(",");
      route.push([(+parts[0]) * step, (+parts[1]) * step]);
      k = prev[k];
    }
    return route.reverse();
  }

  /* 随机挑一个远端目标（规格 §5.2）：候选网格 x=150+50*floor(r*54)、y=150+50*floor(r*34)，
     距自己 <250 直接丢弃，最多试 40 次；40 次全废 → 空路线（下一帧会重抽，不致命）。
     ⚠ 每次尝试消耗**两个**随机数（x 一个、y 一个），顺序不能反。 */
  function chooseRoute(n, g) {
    for (var i = 0; i < 40; i++) {
      var p = { x:150 + Math.floor(random(g) * 54) * 50, y:150 + Math.floor(random(g) * 34) * 50 };
      if (dist(n, p) < 250) continue;
      var route = pathTo(g.map, n, p);
      if (route.length > 1) { n.route = route; n.target = 0; return; }
    }
    n.route = []; n.target = 0;
  }

  /* 巡逻状态机（规格 §5.4），顺序不能改：
     ① 老板未到场：完全静止（连 pause 都不动）② 主管被咖啡机引诱：只转头、不移动、
     **pause 也不递减**（否则引诱结束的时间会漂）③ 停顿 ④ 需要新路线 → 重抽 + 一次停顿
     ⑤ 到达路点（容差 step+0.1）⑥ 朝向 = 移动方向（**瞬时**，没有转身速度）
     ⑦ 整步判定而不是轴分离 ⑧ 撞墙：清空路线 + pause=0.1（不受 pause 倍率影响）。 */
  function patrol(n, dt, g) {
    if (n.id === "boss" && !bossAwake(g)) return;
    n.lure = !!(n.id === "supervisor" && g.lure > 0);
    if (n.id === "supervisor" && g.lure > 0) {
      n.angle = Math.atan2(g.map.points.distraction.y - n.y, g.map.points.distraction.x - n.x);
      return;
    }
    if (n.pause > 0) { n.pause -= dt; return; }
    if (!n.route || !n.route.length || n.target >= n.route.length) {
      chooseRoute(n, g);
      n.pause = (0.3 + random(g) * 1.6) * g.difficulty.pause;
      return;
    }
    var q = n.route[n.target], dx = q[0] - n.x, dy = q[1] - n.y, d = hyp(dx, dy), step = n.speed * dt;
    if (d <= step + 0.1) {
      n.x = q[0]; n.y = q[1]; n.target++;
      if (n.target >= n.route.length) n.pause = (0.4 + random(g) * 1.5) * g.difficulty.pause;
      return;
    }
    n.angle = Math.atan2(dy, dx);
    var x = n.x + dx / d * step, y = n.y + dy / d * step;
    if (walkable(x, y, PLAYER_R, g.map)) { n.x = x; n.y = y; }
    else { n.route = []; n.pause = 0.1; }
  }

  /* ═════════════════ 7. 对局核心（规格 §2 / §3.4 / §7 逐条实现） ═════════════════ */

  function notify(g, text) { g.toast = text; g.toastTimer = 3.8; }

  /* 建局（规格 §2.2 的 createGame）。第 4 个参数是 seed、第 5 个是 floor：
       map = MAPS[(level+floor-2) % 3] —— **地狱第二层换的是下一张图**。 */
  function createGame(level, clearedTimes, mode, seed, floor) {
    level = level === undefined ? 1 : level;
    clearedTimes = clearedTimes || [];
    mode = mode === undefined ? "normal" : mode;
    seed = seed === undefined ? Math.floor(Math.random() * 4294967296) : seed;
    floor = floor === undefined ? 1 : floor;
    if (!LEVELS[level - 1] || !MODES[mode]) throw new RangeError("Unknown level or mode");
    var map = MAPS[(level + floor - 2) % MAPS.length];
    var difficulty = MODES[mode], base = LEVELS[level - 1], k;
    var config = {};
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) config[k] = base[k];
    config.time = Math.round(base.time * difficulty.time);
    config.liftWait = base.liftWait + difficulty.wait;
    config.bossDelay = mode === "normal" ? base.bossDelay : 0;   /* 变态/地狱一律 0 */
    config.coverDuration = difficulty.cover;

    var g = {
      level: level, floor: floor, floors: difficulty.floors, map: map, mapId: map.id,
      mode: mode, difficulty: difficulty, seed: seed >>> 0, seed0: seed >>> 0, config: config,
      clearedTimes: clearedTimes.slice(0), phase: "intro", time: config.time, elapsed: 0,
      player: { x:map.points.start.x, y:map.points.start.y, face:1, angle:-Math.PI / 2, step:0, moving:false },
      suspicion: 0, hidden: false, file: false, fileTaken: false, cover: 0,
      lift: "idle", liftTimer: 0, interacted: 0, lure: 0, lureUsed: false, shoutCooldown: 8,
      eventAt: config.bossDelay, eventText: "", eventTimer: 0,
      toast: "", toastTimer: 0, message: "", caughtBy: "", moves: 0, npcs: []
    };

    /* ── 造人（规格 §4）：数量 = 3 + extra（普通 3 / 变态 4 / 地狱 7）── */
    var total = npcCount(difficulty), i, j;
    for (i = 0; i < total; i++) {
      var id = i === 0 ? "supervisor" : i === 1 ? "boss" : i === 2 ? "coworker" : "guard" + i;
      var spawn = map.spawns[i];
      /* 出生点合法性（规格 §1.2）：不可走、或（保安 i>2）离玩家 <600px → 重选。
         重选网格 x=250..2750、y=350..1650，要求离玩家 >650、离其他 NPC >150 且有路。 */
      if (!spawn || !walkable(spawn[0], spawn[1], 24, map) ||
          (i > 2 && dist({ x:spawn[0], y:spawn[1] }, g.player) < 600)) {
        var cands = [];
        for (var cx = 250; cx < 2800; cx += 100) {
          for (var cy = 350; cy < 1750; cy += 100) {
            var cp = { x:cx, y:cy };
            if (dist(cp, g.player) <= 650) continue;
            if (!walkable(cx, cy, 24, map)) continue;
            var tooNear = false;
            for (j = 0; j < g.npcs.length; j++) if (dist(g.npcs[j], cp) <= 150) tooNear = true;
            if (!tooNear) cands.push([cx, cy]);
          }
        }
        spawn = null;
        while (cands.length) {
          var pick = cands.splice(Math.floor(random(g) * cands.length), 1)[0];
          if (pathTo(map, g.player, { x:pick[0], y:pick[1] }).length) { spawn = pick; break; }
        }
        if (!spawn) throw new Error("No safe patrol spawn");
      }
      /* 速度/视距的差别只有三处：同事固定 80、固定 100；其余 = 关卡基础表 × 模式倍率 */
      g.npcs.push(npc(id, spawn[0], spawn[1], [],
        (i === 2 ? 80 : i === 1 ? base.bossSpeed : base.speed) * difficulty.speed,
        (i === 2 ? 100 : base.range) * difficulty.range,
        i === 2 ? FOV_COWORKER : FOV_NPC));
      g.npcs[g.npcs.length - 1].angle = 0;
    }
    for (i = 0; i < g.npcs.length; i++) chooseRoute(g.npcs[i], g);
    /* ⚠ 数组顺序：引擎按规格以 i 造人（0 主管 / 1 老板 / 2 同事 / ≥3 保安），
       但**存进 g.npcs 时把同事挪到最后**。抓人判定与绘制本来就是"跳过 coworker"，
       所以顺序不影响规格；好处是 debug.placePatrol(0..N-1) 摆的都是看得见、抓得到人的
       巡查（同事摆在那儿既不绘制也不抓人，会让无头验收莫名其妙地"怎么都看不见我"）。 */
    var mates = [], others = [];
    for (i = 0; i < g.npcs.length; i++) (isCoworker(g.npcs[i]) ? mates : others).push(g.npcs[i]);
    g.npcs = others.concat(mates);
    return g;
  }

  /* 规格 §2.2 的 start(g)：只在 intro 上有效（在 lost 上调用无效 —— 测试契约 11）。 */
  function beginPlay(g) {
    if (g.phase !== "intro") return false;
    g.phase = "playing";
    notify(g, "第 " + g.level + " 关：" + g.config.hint);
    cue("ui-open");                     /* 载入音（上游 tone(620)） */
    return true;
  }

  /* 浮层上的"进入第二层"（规格 §2.3 enterFloor）：只在 floor-intro 上有效。 */
  function enterFloor(g) {
    if (g.phase !== "floor-intro") return false;
    g.phase = "playing";
    notify(g, "二层 · " + g.map.name + "：继续寻找绿色出口。");
    cue("ui-open");
    return true;
  }

  /* 交互点判定（规格 §7.2）：hidden 最高（**无视距离**）> 电梯 88 > 工位 76 >
     打印区 85 > 咖啡机 76；后四个都要 clearLine（隔着墙按不到）。 */
  function near(g) {
    var pts = g.map.points, p = g.player;
    if (g.hidden) return { id:"seat", label:"离开工位", key:"E" };
    if (dist(p, pts.lift) < REACH.lift && clearLine(p, pts.lift, g.map)) {
      return { id:"lift", key:"E", label: g.lift === "open"
        ? (g.floor < g.floors ? "搭电梯去二层" : "进入电梯")
        : (g.lift === "calling" ? "电梯到达中 " + Math.ceil(g.liftTimer) + "s" : "呼叫电梯") };
    }
    if (dist(p, pts.seat) < REACH.seat && clearLine(p, pts.seat, g.map)) return { id:"seat", label:"坐下伪装", key:"E" };
    if (!g.fileTaken && dist(p, pts.printer) < REACH.printer && clearLine(p, pts.printer, g.map)) return { id:"printer", label:"拿文件夹", key:"E" };
    if (!g.lureUsed && dist(p, pts.distraction) < REACH.coffee && clearLine(p, pts.distraction, g.map)) return { id:"coffee", label:"启动咖啡机", key:"E" };
    return null;
  }
  /* 给 HUD / debug.state() 用的富化版：带上交互点的**世界坐标**（老脚本读 kind/x/y）。 */
  function nearInfo(g) {
    var n = near(g);
    if (!n) return null;
    var pts = g.map.points;
    var w = n.id === "printer" ? pts.printer : n.id === "coffee" ? pts.distraction
          : n.id === "lift" ? pts.lift : pts.seat;
    return { id:n.id, kind:n.id, label:n.label, key:n.key, x:w.x, y:w.y };
  }

  /* 按 E（规格 §7.3）。⚠ 入口先做一次 captureIfSeen：在"已经被看见"的那一帧按 E
     也是先失败，而且**不消耗**任何东西（文件夹还在手上）。
     ⚠⚠ 失败后必须立刻走 settleIfLost：这条路径的 lost 不在 tick 驱动循环里产生，
        结算不能只挂在驱动循环上（否则 result 恒为 null、onSettle 不触发、
        而且结算面板会把失败画成"过关"）。 */
  function interactAt(g) {
    if (g.phase !== "playing" || captureIfSeen(g)) { settleIfLost(g); return false; }
    var p = near(g);
    if (!p) return false;
    if (p.id === "seat") {
      g.hidden = !g.hidden;
      if (g.hidden) { g.player.x = g.map.points.seat.x; g.player.y = g.map.points.seat.y; }
      g.player.moving = false;
      notify(g, g.hidden ? "假装加班中。按 E 起身，或移动离开。" : "继续下班行动。");
      cue("sfx-co-seat");                        /* 坐下 / 起身：一记很轻的闷响 */
      return true;
    }
    if (p.id === "printer") {
      g.file = true; g.fileTaken = true; g.interacted++;
      notify(g, "已拿文件夹：进入视野前按空格，伪装 " + g.config.coverDuration + " 秒。");
      cue("sfx-co-folder");                      /* 拿文件夹：交互音 + 纸张感 */
      return true;
    }
    if (p.id === "coffee") {
      g.lure = g.config.lureDuration; g.lureUsed = true; g.interacted++;
      notify(g, "咖啡机响了，主管转向茶水间。趁现在！");
      cue("sfx-co-coffee");                      /* 开咖啡机：按钮 + 低沉嗡鸣 */
      return true;
    }
    if (p.id === "lift" && g.lift === "idle") {
      g.lift = "calling"; g.liftTimer = g.config.liftWait;
      notify(g, "电梯正在下行，留意身后！");
      cue("sfx-co-liftcall");                    /* 呼叫电梯：按钮音 */
      return true;
    } else if (p.id === "lift" && g.lift === "open") {
      /* 上二层：换图（phase 仍是 playing，不走过关收口）→ 这里发"进电梯"的上行三音。
         ⚠ 最后一层进电梯不在这里发：那条路会打成 phase='won' 并被 syncWin 收口，
           声音统一由 syncWin 发一次，否则同一帧会叠两遍。 */
      if (g.floor < g.floors) { cue("sfx-co-clear"); changeFloor(g); return true; }
      g.phase = "won"; g.player.moving = false;
      g.message = "电梯门关上的那一刻，世界安静了。";
      return true;
    }
    /* 只剩一种落空：lift==='calling' 时按 E（规格 §7.3 规定什么都不发生、也不提示）。
       这是"撞不到的无效操作"，给一声短促的"无效"音，别让玩家以为是按键没生效。 */
    if (p.id === "lift") cue("sfx-co-invalid");
    return false;
  }

  /* 空格：用文件夹（规格 §7.4）。坐姿中也能用（没有 hidden 限制）。
     ⚠ 没拿文件夹时只提示、不消耗；被看见的当帧先失败、folder 保持 true。 */
  function useFile(g) {
    if (g.phase !== "playing" || captureIfSeen(g)) { settleIfLost(g); return false; }
    if (!g.file) { notify(g, "先去打印区拿文件夹。"); cue("ui-toast", 0.7); return false; }
    g.file = false; g.cover = g.config.coverDuration;
    g.suspicion = Math.max(0, g.suspicion - 35);
    g.interacted++;
    notify(g, "“我去送份材料。” " + g.config.coverDuration + " 秒内不会引起怀疑。");
    cue("sfx-co-disguise");                      /* 伪装生效：轻快上行两音 */
    return true;
  }

  function fail(g, reason) {
    g.phase = "lost"; g.message = reason; g.player.moving = false;
    /* 失败音挂在这里 —— fail() 是**唯一**的失败收口（captureIfSeen 的"被发现"与
       tick 的超时各走一次），所以一次失败一定只响一声：
       caughtBy 有值 = 被看见 → 警报；否则 = 到点超时 → 下行双音。
       结算面板不再另发失败音（同一帧，会叠）。 */
    cue(g.caughtBy ? "sfx-co-alert" : "sfx-co-timeout");
  }

  /* 应用层字段：引擎不认识它们，但换层 / 换关 / 重试时要跟着走（否则画布视图、
     练手局标记、已通关记录会在换层时被 createGame 覆盖掉）。 */
  var APP_FIELDS = ["practice", "frozen", "settled", "result", "clear", "clearedCount",
                    "counted", "caughtCount", "ghost", "savedTime", "view", "retryCount"];

  /* 换层（规格 §2.3 逐行）：**换下一张图**（MAPS[(level+floor-2)%3]）、剩余时间与
     elapsed 整段继承、玩家瞬移到新图 start、file/fileTaken/cover/hidden 清空、
     电梯回 idle、NPC 全重建、bossDelay 强制 0（二层老板立刻活动）。
     phase='floor-intro' —— 计时暂停，必须点"进入第二层"才继续。 */
  function changeFloor(g) {
    var saved = {}, i;
    for (i = 0; i < APP_FIELDS.length; i++) saved[APP_FIELDS[i]] = g[APP_FIELDS[i]];
    var next = createGame(g.level, g.clearedTimes, g.mode, g.seed, 2);
    next.time = g.time;
    next.elapsed = g.elapsed;
    next.eventAt = g.elapsed;                 /* 换层后第一个 playing 帧就弹老板横幅 */
    next.config.bossDelay = 0;
    next.phase = "floor-intro";
    next.message = "已抵达第二层。六名巡查重新布防，找到本层电梯才能离开。";
    for (var kk in next) if (Object.prototype.hasOwnProperty.call(next, kk)) g[kk] = next[kk];
    for (i = 0; i < APP_FIELDS.length; i++) g[APP_FIELDS[i]] = saved[APP_FIELDS[i]];
  }

  /* 重试本关（规格 §2.2 retryLevel）：**不传 seed**（换新随机）、floor 回到 1、
     保留 mode 与已通关记录、phase 回 'intro'（调用方随后 beginPlay）。 */
  function retryLevel(g) { return createGame(g.level, g.clearedTimes, g.mode); }

  /* 下一关（规格 §2.2 nextLevel）：只有 won 且还有下一关才有效；本关 elapsed 入账。 */
  function nextLevel(g) {
    if (g.phase !== "won" || g.level >= LEVELS.length) return null;
    return createGame(g.level + 1, g.clearedTimes.concat([g.elapsed]), g.mode);
  }

  function totalTime(g) {
    var sum = g.elapsed, i;
    for (i = 0; i < g.clearedTimes.length; i++) sum += g.clearedTimes[i];
    return sum;
  }

  /* 主循环（规格 §3.4 的 12 步，顺序不能动）。
     ⚠ 第一行就是"非 playing 直接 return"：失败/暂停/换层期间整个 g **字节级冻结**。 */
  function tick(g, dt, input) {
    input = input || { x:0, y:0 };
    if (g.phase !== "playing") return;
    dt = Math.min(dt, DT_MAX);
    g.time -= dt; g.elapsed += dt;
    var hadCover = g.cover > 0;                 /* 伪装到期的"跳变"判据（见下） */
    var decay = ["toastTimer", "cover", "eventTimer", "lure", "shoutCooldown"];
    for (var i = 0; i < decay.length; i++) g[decay[i]] = Math.max(0, g[decay[i]] - dt);
    /* 伪装到期：cover 从 >0 落到 0 的**那一帧**响一次（不是每帧 —— cover 归零后
       hadCover 就恒为 false）。这一声要能让玩家听出"保护没了"。 */
    if (hadCover && g.cover <= 0) cue("sfx-co-coverend");
    if (g.time <= 0) { g.time = 0; fail(g, "下班太晚了，被拉进了“只开五分钟”的会议。"); return; }
    if (captureIfSeen(g)) return;                    /* 判定 A：移动前 */
    var p = g.player, m = hyp(input.x, input.y);
    p.moving = m > 0.08;
    if (p.moving) {
      g.hidden = false;                              /* 一动就起身 */
      var dx = input.x / Math.max(1, m) * PLAYER_SPEED * dt;
      var dy = input.y / Math.max(1, m) * PLAYER_SPEED * dt;
      if (walkable(p.x + dx, p.y, PLAYER_R, g.map)) p.x += dx;   /* 轴分离：不卡墙角 */
      if (walkable(p.x, p.y + dy, PLAYER_R, g.map)) p.y += dy;
      if (Math.abs(dx) > 0.01) p.face = dx > 0 ? 1 : -1;
      p.angle = Math.atan2(dy, dx);
      p.step += dt * 10;
      g.moves += hyp(dx, dy);
    }
    for (i = 0; i < g.npcs.length; i++) patrol(g.npcs[i], dt, g);
    if (g.elapsed >= g.eventAt) {                    /* 老板到场横幅（只影响横幅，不影响判定） */
      g.eventAt = Infinity;                          /* 置成 Infinity → 横幅一辈子只弹一次 */
      g.eventText = "老板出门了：“大家都还在吧？”";
      g.eventTimer = 4;
      cue("ui-toast", 0.7);                           /* 对话/提示横幅出现 */
    }
    if (captureIfSeen(g)) return;                    /* 判定 B：NPC 移动后 */
    g.suspicion = 0;
    var mate = coworkerOf(g);
    if (mate && g.shoutCooldown <= 0 && dist(mate, p) < 75 && !g.hidden && g.cover <= 0) {
      g.shoutCooldown = 16;                          /* 16 秒冷却 → 不会每帧喊 */
      g.eventText = "同事：“你这么早就走啦？”";
      g.eventTimer = 3.5;
      cue("ui-toast", 0.7);                          /* 对话出现（同事喊话 = 最隐蔽的一次暴露源） */
      var sup = supervisorOf(g);                     /* 同事只喊话：主管转向玩家并停 1.8s */
      if (sup) { sup.angle = Math.atan2(p.y - sup.y, p.x - sup.x); sup.pause = 1.8; }
    }
    if (captureIfSeen(g)) return;                    /* 判定 C：主管被喊话转向后 */
    if (g.lift === "calling") {
      g.liftTimer = Math.max(0, g.liftTimer - dt);
      if (g.liftTimer === 0) {
        g.lift = "open";                             /* 状态跳变：从 calling 到 open 只发生一次 */
        notify(g, "电梯到了！靠近门口，按 E 进入。");
        cue("sfx-co-liftding");                      /* 电梯到达的上行"叮" —— 玩家在等的就是这一声 */
      }
    }
  }

  /* 建一局并**立刻开打**：对外 API（Clockout.start）一贯是"建局即开打"，
     所以第一帧起 phase 就是 playing（intro 只在 createGame 里短暂存在）。
     练手局标记、视图、经济计数都在这里落地。 */
  function startSession(opts) {
    opts = opts || {};
    var modeId = MODES[opts.mode] ? opts.mode : "normal";
    var seed = (opts.seed >>> 0) || ((Date.now() ^ 0x9E3779B9) >>> 0);
    var g = createGame(1, [], modeId, seed, 1);
    g.practice = !!opts.practice;
    g.frozen = false; g.settled = false; g.result = null; g.clear = null;
    g.clearedCount = 0; g.counted = false; g.caughtCount = 0;
    g.ghost = true; g.savedTime = 0; g.retryCount = 0;
    g.view = { scale:1, x:0, y:0, w:1200, h:700 };
    beginPlay(g);
    NEAR = nearInfo(g);
    return g;
  }
  /* 换关 / 重试时把应用层状态搬过去；每次新一局都重置 settled/result/clear。 */
  function carryApp(from, to) {
    var i;
    for (i = 0; i < APP_FIELDS.length; i++) to[APP_FIELDS[i]] = from[APP_FIELDS[i]];
    to.settled = false; to.result = null; to.clear = null;
    to.counted = false;
    to.retryCount = (from.retryCount || 0) + 1;
    return to;
  }

  /* ═════════════════ 8. 地图自检 + V1 兼容壳 + 经济层 + 模块状态 ═════════════════ */

  /* 地图自检：五个关键点都能站人、都从出生点走得到；每面墙的中心都挡得住人；
     五个巡逻出生点都可走。**改任何坐标之后必须跑它** —— 这类错误在画面上只表现为
     "这关好像过不去"，肉眼几乎看不出来（甚至可能只是拦不住人，完全看不出来）。 */
  function validateLevel(map) {
    map = mapOf(map);
    var probs = [], ids = ["start", "printer", "seat", "distraction", "lift"], i;
    for (i = 0; i < ids.length; i++) {
      var p = map.points[ids[i]];
      if (!p) { probs.push("[" + map.name + "] 缺关键点 " + ids[i]); continue; }
      if (!walkable(p.x, p.y, PLAYER_R, map)) probs.push("[" + map.name + "] 关键点 " + ids[i] + " 落在墙里：" + p.x + "," + p.y);
      else if (!pathTo(map, map.points.start, p).length) probs.push("[" + map.name + "] 关键点 " + ids[i] + " 从出生点走不到");
    }
    for (i = 0; i < map.walls.length; i++) {
      var a = map.walls[i];
      if (walkable(a[0] + a[2] / 2, a[1] + a[3] / 2, PLAYER_R, map)) {
        probs.push("[" + map.name + "] 第 " + i + " 面墙的中心能站人（太薄，挡不住人）：" + JSON.stringify(a));
      }
    }
    for (i = 0; i < map.spawns.length; i++) {
      var s = map.spawns[i];
      if (walkable(s[0], s[1], 24, map)) continue;
      /* 规格 §1.2 的出生点校验用的是 r=24（比 NPC 实际的 18 更保守），所以出生点表里
         本来就有"故意不可用"的点 —— 它们会被 createGame 从候选网格里重选掉。
         这里只确认**重选有解**，否则建局会直接抛 No safe patrol spawn。 */
      var solvable = false;
      for (var gx = 250; gx < 2800 && !solvable; gx += 100) {
        for (var gy = 350; gy < 1750; gy += 100) {
          if (walkable(gx, gy, 24, map) && pathTo(map, map.points.start, { x:gx, y:gy }).length) { solvable = true; break; }
        }
      }
      if (!solvable) probs.push("[" + map.name + "] 巡逻出生点 " + i + " 不可走且重选网格无解：" + s[0] + "," + s[1]);
    }
    return probs;
  }

  function mapOf(lv) {
    if (!lv) return MAPS[0];
    if (lv.map) return lv.map;
    if (lv.bounds && lv.walls) return lv;
    return MAPS[0];
  }
  /* ── V1 兼容壳：旧单测直接读这些名字，语义映射到世界像素（详见文件头注释）── */
  function buildLevelCompat(def, seed, modeId) {
    var idx = 0, i;
    for (i = 0; i < LEVELS.length; i++) {
      if (LEVELS[i] === def || LEVELS[i].id === def || LEVELS[i].name === def) idx = i;
    }
    var map = MAPS[idx];
    return { id:def && def.id, name:map.name, sub:map.caption, hint:(def && def.hint) || "",
             map:map, index:idx, w:Math.round(WORLD_W / GRID_STEP), h:Math.round(WORLD_H / GRID_STEP),
             bounds:map.bounds, walls:map.walls, points:map.points, spawns:map.spawns,
             spawn:{ x:map.points.start.x, y:map.points.start.y },
             exit:[map.points.lift], folders:[map.points.printer],
             patrols:[], patrolRoutes:[] };
  }
  function isSolidCompat(lv, x, y) { return !walkable(x, y, 0, mapOf(lv)); }
  function losCompat(lv, x0, y0, x1, y1) {
    return clearLine({ x:x0, y:y0 }, { x:x1, y:y1 }, mapOf(lv));
  }
  function canSeeCompat(lv, pat, px, py, opt) {
    opt = opt || {};
    if (opt.disguised) return false;
    var n = { x:pat.x, y:pat.y, angle:pat.angle || 0, range:pat.range,
              fov:(pat.halfFov === undefined ? (pat.fov || FOV_NPC) : pat.halfFov * 2) };
    return sees(n, { x:px, y:py }, mapOf(lv));
  }
  function anySeesCompat(lv, pats, px, py, opt) {
    for (var i = 0; i < pats.length; i++) if (canSeeCompat(lv, pats[i], px, py, opt)) return pats[i];
    return null;
  }
  function buildPatrolsCompat(lv, seed, modeId) {
    var map = mapOf(lv), out = [], i;
    for (i = 0; i < map.spawns.length; i++) {
      out.push(npc("guard" + i, map.spawns[i][0], map.spawns[i][1], [], 120, 280, FOV_NPC));
    }
    return out;
  }
  /* 旧签名 stepPatrol(lv, p, dt, now, opt) → 新 patrol(n, dt, g)（补一个假 g）。 */
  function stepPatrolCompat(lv, p, dt, now, opt) {
    var fake = { map:mapOf(lv), difficulty:{ pause:1 }, seed:12345, elapsed:1e9, lure:0,
                 config:{ bossDelay:0 } };
    patrol(p, dt, fake);
    return p;
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

  /* ── 省时分必须**按模式归一** ──
     地狱每关时限本来就长（204/190/177，因为两层共用），不归一的话"同样的相对效率"
     在地狱会白拿一大截省时分：实测普通 E[净]=3.4 而地狱 14.5，两档收益差 4 倍
     —— 那就没人打普通了。归一之后三档在同等效率下拿一样的分，
     真正的难度差回到"清零概率"上（这才是风险收益）。
     基准 420 = 普通三关裸时限之和 150+140+130。 */
  var TIME_BASELINE = 420;
  function modeBudget(modeId) {
    var m = MODES[modeId] || MODES.normal, sum = 0, i;
    for (i = 0; i < LEVELS.length; i++) sum += Math.round(LEVELS[i].time * m.time);
    return sum || TIME_BASELINE;
  }
  function timeScoreFor(modeId, saved, cleared) {
    var scaled = (saved || 0) * (TIME_BASELINE / modeBudget(modeId));
    return Math.round(Math.min(TUNE.SPEED_BONUS_MAX, scoreOf("time", scaled)) * (cleared / LEVELS.length));
  }

  /* ── 蒙卡：纯函数整局自跑 ──
     用途只有两个：给赔付阶梯定数、让"经济不变量"能被断言。
     关键纪律：得分必须走同一套 scoreOf，否则模拟与实机漂移。
     ⚠ V2 的时限是**每关独立**的（V1 是三关共用一个池子），所以模型跟着改了：
       逐关判定、**被抓即整局失败**（与实机一致：被看见就 lost，本轮结束）。 */
  function simulateRun(modeId, skill, seed) {
    var mode = MODES[modeId] || MODES.normal;
    var s = limit(+skill || 0, 0, 1);
    var rng = makeRng(((seed >>> 0) || 191) ^ 0x5BF03635);
    var st = {
      cleared:0, caught:0, timeUsed:0, remaining:0, saved:0, timeout:false,
      score:0, ghost:true, levelTimes:[], net:0, pay:0
    };
    for (var i = 0; i < mode.levels && i < LEVELS.length; i++) {
      var lv = LEVELS[i];
      var budget = Math.round(lv.time * mode.time);          /* 本关真实时限（规格 §1.7） */
      /* ⚠ 通关概率必须**收敛到"技术满级几乎必过"**：线性插值到 0.985，
         skill=0 时是基础难度，skill=1 时几乎必过，中间连续。 */
      var base = (0.20 - i * 0.04) * (modeId === "hell" ? 0.82 : 1);
      var pClear = limit(base + (0.985 - base) * s, 0.02, 0.985);
      /* 用时系数按**本关时限**折算：技术满级约用掉 80%（省 20%），技术垫底 115%（必然超时）。
         ⚠ V1 是拿 parTime 去比一个三关共用的池子，直接照搬会变成"skill<0.73 恒超时"，
         实测 E[净] 恒等于 −入场费，整条难度曲线是死的。 */
      var cost = budget * (1.15 - 0.35 * s);
      if (cost >= budget) {                                   /* 技术太差：这一关必然超时 */
        st.timeout = true; st.timeUsed += budget; break;
      }
      st.timeUsed += cost;
      if (rng() < pClear) {
        st.cleared++; st.levelTimes.push(+cost.toFixed(1));
        st.saved += Math.max(0, budget - cost);
        st.remaining = Math.max(0, budget - cost);
      } else {
        st.caught++; st.ghost = false; st.remaining = 0; break;   /* 被抓 = 整局结束 */
      }
    }
    st.timeUsed = +st.timeUsed.toFixed(1);
    st.remaining = +st.remaining.toFixed(1);
    /* 时间分按通关进度打折（否则"一关不过、原地躲到时间结束"也能拿满额时间分） */
    var timeScore = timeScoreFor(modeId, st.saved, st.cleared);
    st.score = st.cleared * scoreOf("level") + timeScore
      + ((st.ghost && st.cleared === mode.levels) ? scoreOf("ghost") : 0);
    st.pay = payoutOf(st.score, modeId);
    st.net = st.pay - TUNE.ENTRY;
    st.allClear = (st.cleared === mode.levels);
    /* 评级必须与实机 endRun 用**同一套阈值**（本地约定），否则统计分布对不上实际体验 */
    st.grade = st.allClear ? (st.ghost ? "S" : "A")
      : (st.cleared === mode.levels - 1 ? "B" : (st.cleared > 0 ? "C" : "D"));
    return st;
  }

  var rules = {
    /* ── V2 引擎（世界像素原语，规格 §1–§5）── */
    WORLD_W:WORLD_W, WORLD_H:WORLD_H, MAPS:MAPS, MODES:MODES, LEVELS:LEVELS, TUNE:TUNE,
    dist:dist, walkable:walkable, clearLine:clearLine, segmentWalkable:segmentWalkable,
    sees:sees, captureIfSeen:captureIfSeen, settleIfLost:settleIfLost, pathTo:pathTo, chooseRoute:chooseRoute,
    patrol:patrol, random:random, conePoly:conePoly, near:near, tick:tick,
    createGame:createGame, start:beginPlay, enterFloor:enterFloor, changeFloor:changeFloor,
    interact:interactAt, useFile:useFile, retryLevel:retryLevel, nextLevel:nextLevel,
    totalTime:totalTime, validateLevel:validateLevel, npcCount:npcCount,
    /* ── 经济层（结算口径：net = 赔付 − 入场 ¥20）── */
    makeRng:makeRng, scoreOf:scoreOf, payoutOf:payoutOf, simulateRun:simulateRun,
    SCORE_TABLE:SCORE_TABLE, PAYOUT:PAYOUT,
    /* ── V1 兼容壳：旧单测读这些名字，语义已映射到世界像素 ── */
    buildLevel:buildLevelCompat, isSolidW:isSolidCompat, isOpaqueW:isSolidCompat,
    losClear:losCompat, canSee:canSeeCompat, anySees:anySeesCompat,
    buildPatrols:buildPatrolsCompat, stepPatrol:stepPatrolCompat, TILE:TILE
  };
  /* ── 调试钩子容器：**必须在这里就建成对象**。
     若写成 `var debug = {…}` 放在文件后半段，导出赋值会先执行、捕获到 undefined
     —— var 只提升声明不提升赋值。（上一个玩法踩过这个坑。） ── */
  var debug = {};
  /* 模块级可变状态一律在这里声明：严格的 "use strict" 下，
     给未声明变量赋值会直接抛 ReferenceError，而且只有真跑起来才会发现。 */
  var G = null, hostEl = null, cv = null, ctx = null, W = 900, H = 560;
  var rafId = 0, lastTs = 0, running = false, opts0 = null;
  var keys = {}, NEAR = null;
  var collideOverlay = false;            /* debug.collisionOverlay(on)：墙体碰撞描边，默认关 */
  var HL = null;                         /* 本帧的 HUD 布局（render 每帧刷新，见 hudLayout） */

  /* ═════════════════ 8.5 贴图资源（art/clockout/**）：贴图优先、缺图回落 ═════════════════
     与音频层是同一套约定（breakfast.js 的 art 加载器也是这个口径）：
     模块初始化时用 new Image() 预加载本地 PNG，绘制处优先 drawImage；
     图片没就绪 / 加载失败 / 环境里根本没有 Image 构造器（无头单测、老浏览器）
     → 一律回落到本来的程序化画法（地板格 + 墙体矩形 + 角色色块）。
     所以规矩是：**只允许加载 art/clockout/ 下的本地图片，且每一处都必须有程序化回退**。

       bg     office-open / office-meeting / office-executive .png
              三关各自整张手绘插图，按世界坐标 (0,0)-(3000,2000) 铺满
              （源图 1536×1024，正好 3:2 = 3000:2000 等比，不裁不拉伸）
       bg     office.png   浮层（准备页 / 暂停 / 结算）底下的场景图（可缺）
       actor  player.png · player-seated.png · supervisor.png · boss.png
       ⚠ coworker.png **故意不注册**：规格 §4「同事永不绘制」，连请求都不发。
       ⚠ 保安（guard3…guard6，只在变态/地狱出现）上游没有贴图 → 保持程序化色块。

     尺寸与原点照规格 §1.1 逐字抄（App.jsx:25-28），不自己拍：
       玩家 111 · NPC 112 · 坐姿 105；原点 (-size/2, -size+8)，坐姿 (-size/2, -size+12)。
       size 是贴图**短边**在世界上占的像素数，方框 size×size 画在原点处。

     ⚠ 判定层（walkable / clearLine / sees / patrol / 状态机）**一个像素都不读这里**：
       贴图只影响"画什么"，不影响"怎么判"。 */

  var ART_DIR = "art/clockout/";         /* 相对页面目录 —— 不写盘符 / 协议 / data URI */
  var ART = {
    dir: ART_DIR, slots: [], bg: {}, actor: {},
    total: 0, loaded: 0, failed: 0,
    failAll: false                       /* 阴性对照用：强制按"一张图都没有"渲染 */
  };
  function mkArt(key, file, kind, size, dy) {
    var s = { key:key, file:file, kind:kind, size:size || 0, dy:dy || 0,
              src:ART_DIR + file, img:null, ok:false, failed:false };
    ART.slots.push(s);
    if (kind === "bg") ART.bg[key] = s; else ART.actor[key] = s;
    return s;
  }
  /* 三关背景（键 = map.art）+ 一张浮层场景图 */
  mkArt("office-open",      "office-open.png",      "bg");
  mkArt("office-meeting",   "office-meeting.png",   "bg");
  mkArt("office-executive", "office-executive.png", "bg");
  mkArt("office",           "office.png",           "bg");
  /* 角色贴图：size / dy 照规格 §1.1 的表 */
  mkArt("player",        "player.png",        "actor", 111, 8);
  mkArt("player-seated", "player-seated.png", "actor", 105, 12);
  mkArt("supervisor",    "supervisor.png",    "actor", 112, 8);
  mkArt("boss",          "boss.png",          "actor", 112, 8);

  function artLoad() {
    ART.total = ART.slots.length; ART.loaded = 0; ART.failed = 0;
    /* 没有 Image 构造器（vm 里的单测就是）→ 全部按缺图处理，一律程序化 */
    if (!root || !root.Image) { ART.failed = ART.total; return ART; }
    for (var i = 0; i < ART.slots.length; i++) {
      (function (s) {
        var img = null;
        try { img = new root.Image(); } catch (e) { img = null; }
        if (!img) { s.failed = true; ART.failed++; return; }
        s.img = img;
        /* ⚠ ok 是**唯一**的"可以画它"判据：onload 之前一次都不许 drawImage。 */
        img.onload = function () { if (!s.ok) { s.ok = true; ART.loaded++; } };
        /* ⚠ onerror = **永久**不可用：failed 一旦置位就再也不碰这张图，直接走程序化。
           任何一张图缺失都不影响玩法 —— 只是那一层退回矢量画法。 */
        img.onerror = function () { s.ok = false; s.failed = true; ART.failed++; };
        try { img.src = s.src; } catch (e) { s.failed = true; ART.failed++; }
        /* 命中缓存时个别浏览器不会补发 onload —— 补一次同步判定（带幂等守卫）。 */
        try {
          if (img.complete && (img.naturalWidth || img.width)) {
            if (!s.ok) { s.ok = true; ART.loaded++; }
          }
        } catch (e) {}
      })(ART.slots[i]);
    }
    return ART;
  }
  /* 能画吗：已 onload 且真的解出了像素；failAll 是给阴性对照用的总闸。 */
  function artReady(s) {
    if (!s || !s.ok || !s.img || ART.failAll) return false;
    return !!(s.img.naturalWidth || s.img.width);
  }
  function bgSlot(g) { return (g && g.map && g.map.art && ART.bg[g.map.art]) || null; }
  function bgReady(g) { return artReady(bgSlot(g)); }
  function npcArt(n) { return n ? (ART.actor[n.id] || null) : null; }
  artLoad();                             /* 建局前就开始加载；好了自动用上，不用重开一局 */

  /* ═════════════════ 9. 渲染（世界像素 + 摄像机跟随 + 小地图） ═════════════════
     坐标全部是**世界像素**：摄像机把世界平移到画布上（规格 §1.1 的夹取公式），
     文字与标签单独画在屏幕空间，免得被缩放糊掉。 */

  /* ═════════════════ 9.0 视角档位（纯渲染层：只改"世界 → 屏幕"这一步） ═════════════════
     三档运行时可切：debug.view("flat"|"tilt"|"deep")，或点画布右下角的小控件循环。
       flat 俯视    —— **改造之前的老路径**，逐像素一致（保底档）
       tilt 倾斜    —— 地面纵向压扁 TILT，家具挤出 WALL_H 的侧立面（默认档）
       deep 强立体  —— 压得更扁、挤得更高，家具向左下投一层柔和暗影 + 轻微描边
     ⚠ 三条铁律（改之前先读）：
       ① **判定层一个像素都不读这里**：walkable / clearLine / sees / captureIfSeen / patrol /
          tick / 状态机 / 结算 / 经济全部仍在世界坐标里算，投影只发生在"世界 → 屏幕"这一步；
       ② 贴地的东西（背景图 / 地板格 / 视野锥 / 地面标记 / 影子 / 选中环 / 电梯地光）一律走
          压缩变换 —— 少压一个，那一样东西就会"浮在空中"；
       ③ 立起来的东西（角色贴图、世界标签药丸、HUD / 小地图 / 浮层）**不压缩**：锚点用压缩后的
          地面坐标，贴图按原比例画，于是人"站"在地上，而不是"趴"在地上。
     ⚠ 镜头夹取必须跟着压缩后的视口高度走（见 camFollow）：压扁之后一屏装得下更多世界，
       不跟着改就会在上下露出黑边、或者视野跑到世界外面。 */
  var VIEW_ORDER = ["flat", "tilt", "deep"];
  var VIEW_DEF = {
    /* tilt：地面纵向压缩系数（1 = 俯视原样）；wallH：家具挤出高度（**世界像素**，乘缩放才是屏幕）；
       drop：deep 档的地面投影强度；edge：是否给挤出体加轻微描边 */
    flat: { id:"flat", label:"俯视",      tilt:1,   wallH:0,   drop:0, edge:false },
    tilt: { id:"tilt", label:"倾斜 2.5D", tilt:.68, wallH:64,  drop:0, edge:false },
    deep: { id:"deep", label:"强立体",    tilt:.55, wallH:118, drop:1, edge:true  }
  };
  var viewMode = "tilt";                 /* 默认档 = 倾斜 2.5D（flat 保底、deep 极限） */
  function viewCfg() { return VIEW_DEF[viewMode] || VIEW_DEF.flat; }
  function nextView() {
    for (var i = 0; i < VIEW_ORDER.length; i++) {
      if (VIEW_ORDER[i] === viewMode) return VIEW_ORDER[(i + 1) % VIEW_ORDER.length];
    }
    return VIEW_ORDER[0];
  }

  /* 世界 → 屏幕（画布像素）：**唯一的投影入口**。
       psx = (wx − camX) × scale
       psy = oy + ((wy − 可见带中心) × tilt + 视口高/2) × scale
     flat 档（tilt=1、oy=0）时 psy 正好退化成 (wy − camY) × scale —— 与老代码逐像素相同。 */
  function projX(v, wx) { return (wx - v.x) * v.scale; }
  function projY(v, wy) { return v.oy + ((wy - (v.y + v.eh / 2)) * v.ty + v.h / 2) * v.scale; }

  var COL = {
    floorA:"#1a1c26", floorB:"#171923", grid:"rgba(255,255,255,.030)",
    wall:"#2c3040", wallTop:"#3a4056", wallLine:"rgba(0,0,0,.35)", bound:"rgba(120,140,190,.28)",
    cone:"rgba(252,185,58,.23)", coneEdge:"rgba(240,170,48,.5)",
    coneHot:"rgba(226,88,65,.27)", coneHotEdge:"rgba(241,99,80,.7)",
    marker:"#ebce8d", lift:"#75f1cf", player:"#fff5d0", playerDark:"#23252f",
    collide:"rgba(255,86,116,.92)",      /* debug.collisionOverlay 的描边色 */
    shop:"#a14f42", boss:"#8f5a3c", guard:"#4a5a86", mate:"#3f5a4a",
    folder:"#e9e3d1", coffee:"#c96a2c", coffeeOn:"#ffb03c",
    alert:"#ff4d6d", hud:"#0b0a13", panel:"#f4efe2", ink:"#20222c"
  };

  /* ═════════════════ 9.1 HUD 布局常量表（屏幕空间，单位=画布像素） ═════════════════
     ⚠ 这里是 HUD 坐标 / 字号 / 行距 / 内边距的**唯一**来源，别再往绘制函数里塞魔法数字。
     为什么要有这张表：上一版把 22 / 46 / 68 / H-74 / H-40 / H-16 散在 drawHud 里，
     左上三行的行距只有 22px 而目标行字号 15px（净空 9px），三行读起来是一坨；
     世界标签又能随便飘进底部提示行 —— 于是出现"先找到电梯前往二层"压在
     "W A S D 移动"上。现在的三条硬规则：
       ① 每个块的行距 >= 该行字号（相邻两行的墨迹至少留 6px 净空，见 hudLayout）；
       ② hudLayout() 每帧算一次，绘制与**标签避让**读同一份矩形，不会各算各的；
       ③ 世界标签（tag）撞到任何一块就整体让开，HUD 文字与世界标签永不重叠。 */
  var HUD = {
    pad: 14,                            /* 画布四周安全边距 */
    plate: "rgba(11,10,19,.56)",        /* 底衬：半透明，下面的插图还看得见 */
    plateEdge: "rgba(255,255,255,.10)",
    radius: 8,
    ink: "rgba(6,5,12,.78)",            /* 文字描边色（压在亮插图上也不糊） */

    /* ── 左上：模式行 / 目标行 / 目标副行 ── */
    infoX: 12, infoY: 12, infoPadX: 10, infoPadY: 9,
    infoL1: 12.5, infoL2: 15, infoL3: 11.5,   /* 三行字号 */
    infoGap1: 28, infoGap2: 25,               /* 行1→2 / 行2→3 的中心距 */

    /* ── 右上：小地图（宽高按世界比例算，这里只给边距） ── */
    miniX: 16, miniY: 14, miniBox: 8, miniCap: 22, miniCapL: 11,

    /* ── 左下：怀疑度条 + 倒计时 ── */
    barW: 240, barH: 8, barLabelGap: 12, timeGap: 16,
    barLabelL: 12, timeL: 12.5, timeBig: 21,

    /* ── 底部：按键提示 + 脚注（都居中） ── */
    hintL: 12.5, footL: 11, hintGap: 26, footGap: 23, botPad: 10,

    /* ── 顶部中央：toast / 事件横幅（永远落在左上信息块下沿之下） ── */
    toastK: 0.18, toastMin: 112, bannerGap: 42, toastL: 15, bannerL: 16,

    /* ── 世界标签避让 HUD 时允许挪动的上限（px）：超过就干脆不画 ── */
    tagNudge: 72,
    /* ── 锚点离画布多远（px）就认为"人不在画面里"、连标签一起不画 ── */
    tagCull: 40,
    tagPillH: 25,                       /* 标签药丸高度（屏幕像素，见 tag / headGap） */

    /* ── 结算面板：高度按行数算，"净收益"与底部提示各有自己的固定槽位 ── */
    setW: 460, setHead: 120, setRowH: 21, setDiv: 18, setNetGap: 40, setFootPad: 20
  };

  /* 取音频层对象。⚠ 必须两条路都试，这是本仓库一个**真踩到的坑**：
     index.html 里写的是 `const AudioSys = {…}` —— const 声明出来的是**全局词法绑定，
     不是 window 的属性**，所以 `root.AudioSys`（= window.AudioSys）恒为 undefined。
     浏览器实测：`typeof AudioSys === "object"` 而 `window.AudioSys === undefined`。
     于是仓库里所有模块那种 `if (root.AudioSys && AudioSys.play) …` 守卫**一次都没进去过**
     —— 代码读起来有声音、真跑起来一声不响（本玩法原先那个 beep 也是这样哑的）。
     这里先试 root.AudioSys（哪天改成 window 属性也照样工作），再试裸标识符（当前真相）。
     ⚠ 只能用 `typeof 标识符` 判存在：它遇到未声明/尚未初始化都返回 "undefined" 而不抛错，
       所以没有 AudioSys 的 vm 单测里这条路同样是安全的。 */
  function audioSys() {
    try { if (root && root.AudioSys) return root.AudioSys; } catch (e) {}
    try { if (typeof AudioSys !== "undefined" && AudioSys) return AudioSys; } catch (e) {}
    return null;
  }
  function beep(f, d, t, g) {
    try { var A = audioSys(); if (A && A.blip) A.blip(f, d, t, g); } catch (e) {}
  }

  /* ═════════════════ 9.0b 音频接线：每个事件都「先试文件、缺失回落 blip」═════════════════
     与 index.html 的 AudioSys 三层（文件 / 程序化 / 环境音）同一套约定。三条纪律：
       ① `AudioSys.play(name)` 返回 false（文件缺失 **或** 还在异步探测）就必须回落 blip ——
          **不能因为素材没到位就静音**；
       ② 文件存在时也不能删掉兜底分支 —— 素材库一旦改名就会整片无声，而且不报错
          （这正是本仓库"1542 项断言全绿、牌桌上却完全没声音"那个坑的成因）；
       ③ 只在**事件发生的那一帧**发声：tick 里的四处（伪装到期 / 老板到场 / 同事喊话 /
          电梯到达）全部挂在"状态跳变"上，不是每帧触发。
     ⚠ 单测在 vm 沙箱里跑：没有 AudioSys、没有 AudioContext、**也没有 setTimeout**
       （tests/clockout.test.cjs 只给了 console），所以每次发声都先判存在，
       所有延迟发声一律走 later()，无声环境里整块音频接线是彻底的空操作。 */
  var FALLBACK = {
    /* 本玩法自己的 12 条事件音（audio/sfx/sfx-co-*.mp3）：缺失时的合成兜底。
       格式 = [频率Hz, 时长s, 波形, 增益, 延迟ms]；增益一律 ≤0.12（与仓库同量级）。 */
    "sfx-co-folder":   [[660, 0.05, "square", 0.06, 0], [1100, 0.07, "triangle", 0.07, 70]],
    "sfx-co-coffee":   [[150, 0.26, "sawtooth", 0.07, 0], [96, 0.30, "sine", 0.07, 40]],
    "sfx-co-liftcall": [[520, 0.06, "square", 0.07, 0]],
    "sfx-co-liftding": [[880, 0.12, "sine", 0.09, 0], [1320, 0.20, "sine", 0.09, 130]],
    "sfx-co-clear":    [[660, 0.13, "triangle", 0.09, 0], [880, 0.13, "triangle", 0.09, 110],
                        [1320, 0.20, "triangle", 0.09, 220]],
    "sfx-co-alert":    [[440, 0.26, "sawtooth", 0.09, 0], [220, 0.34, "sawtooth", 0.10, 260]],
    "sfx-co-timeout":  [[330, 0.22, "sine", 0.09, 0], [220, 0.34, "sine", 0.09, 240]],
    "sfx-co-disguise": [[880, 0.08, "triangle", 0.08, 0], [1174, 0.12, "triangle", 0.08, 90]],
    "sfx-co-coverend": [[880, 0.12, "square", 0.07, 0], [587, 0.18, "square", 0.07, 170]],
    "sfx-co-victory":  [[523, 0.14, "triangle", 0.09, 0], [659, 0.14, "triangle", 0.09, 110],
                        [784, 0.16, "triangle", 0.09, 220], [1046, 0.30, "triangle", 0.10, 330]],
    "sfx-co-seat":     [[180, 0.07, "sine", 0.05, 0]],
    "sfx-co-invalid":  [[150, 0.07, "square", 0.06, 0], [150, 0.07, "square", 0.05, 90]],
    /* 复用素材库里已有的通用 UI 音（同样留兜底，音频层改名也不会哑） */
    "ui-open":         [[620, 0.12, "sine", 0.07, 0]],
    "ui-toast":        [[660, 0.08, "sine", 0.08, 0], [990, 0.14, "sine", 0.08, 90]],
    "ui-tab":          [[520, 0.05, "square", 0.06, 0]],
    "ui-click":        [[880, 0.05, "square", 0.06, 0]],
    "ui-loss":         [[330, 0.16, "sawtooth", 0.08, 0], [247, 0.18, "sawtooth", 0.08, 120]]
  };
  /* 试播文件：true = 已播（或已排队播），false = 调用方必须回落合成音 */
  function sfx(name, vol) {
    try { var A = audioSys(); if (A && A.play) return A.play(name, vol) !== false; } catch (e) {}
    return false;
  }
  function later(f, d, t, g, ms) {
    if (!ms) { beep(f, d, t, g); return; }
    try { if (root.setTimeout) root.setTimeout(function () { beep(f, d, t, g); }, ms); } catch (e) {}
  }
  function blips(list) {
    for (var i = 0; list && i < list.length; i++) {
      later(list[i][0], list[i][1], list[i][2], list[i][3], list[i][4]);
    }
  }
  /* 一个事件一声：文件优先；play() 返回 false 就把这一声合成出来。
     vol 只作用于文件音量（0~1），兜底音的响度写在 FALLBACK 里。 */
  function cue(name, vol) {
    if (sfx(name, vol)) return true;
    blips(FALLBACK[name] || FALLBACK["ui-click"]);
    return false;
  }
  /* 三关全通：优先自己的胜利文件；缺了就退回 AudioSys.good()（它内部同样是"文件→合成"），
     连 AudioSys 都没有（无头单测）才自己合成 —— 三层都有声音，一层都不哑。 */
  function cueVictory() {
    if (sfx("sfx-co-victory")) return true;
    try {
      var A = audioSys();
      if (A && A.good) { A.good(); return false; }
    } catch (e) {}
    blips(FALLBACK["sfx-co-victory"]);
    return false;
  }
  /* 环境音：AudioSys.amb 是**全页独一份**的通道，进出玩法必须成对调用 ——
     只有 amb(null) 才会淡出并停掉，漏掉收工那一次，办公室环境音会跟着玩家回主游戏。 */
  function amb(loc) {
    try { var A = audioSys(); if (A && A.amb) A.amb(loc); } catch (e) {}
  }
  /* 预热素材探测（只在开局调一次）：
     AudioSys 的路径解析是**异步**的（resolveMedia 三态 pending/ready/bad），
     探测落定之前 play() 一律返回 false，本层就会回落到合成音 —— 也就是"进面板后
     每个**首次**事件都是 blip，第二次才听到真素材"。开局把 17 个候选路径先丢进探测队列
     （resolveMedia 只探测、不发声），玩家走到打印区那几秒里就全部就位了。
     ⚠ 只用 AudioSys 已有的公开方法，并且整体 try/catch：老版本没有 resolveMedia 就跳过。 */
  var CUE_NAMES = ["sfx-co-folder", "sfx-co-coffee", "sfx-co-liftcall", "sfx-co-liftding",
                   "sfx-co-clear", "sfx-co-alert", "sfx-co-timeout", "sfx-co-disguise",
                   "sfx-co-coverend", "sfx-co-victory", "sfx-co-seat", "sfx-co-invalid",
                   "ui-open", "ui-toast", "ui-tab", "ui-click", "ui-loss"];
  function warm() {
    try {
      var A = audioSys();
      if (!A || !A.resolveMedia) return;
      for (var i = 0; i < CUE_NAMES.length; i++) {
        A.resolveMedia("audio/sfx/" + CUE_NAMES[i] + ".mp3", "sfx-");
      }
    } catch (e) {}
  }
  function txt(s, x, y, size, color, align, weight) {
    ctx.font = (weight || "bold") + " " + size + "px 'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
    ctx.textAlign = align || "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }
  /* HUD 专用文字：先描一圈深色边再填色 —— 压在亮插图上也能读，且**什么都不遮**
     （比铺一整块底板轻）。结算面板是浅色底，那边继续用 txt()，描边反而脏。 */
  function txtOut(s, x, y, size, color, align, weight) {
    ctx.font = (weight || "bold") + " " + size + "px 'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
    ctx.textAlign = align || "left";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2.5, size * 0.34);
    ctx.strokeStyle = HUD.ink;
    ctx.strokeText(s, x, y);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }
  /* 文字实测宽度：底衬要按真实宽度裁，不能拍一个固定宽度（换地图名就露馅）。 */
  function textW(s, size, weight) {
    ctx.font = (weight || "bold") + " " + size + "px 'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
    return ctx.measureText(s).width;
  }
  /* HUD 底衬：一块半透明圆角板（提高可读性用，不吃掉下面的画面）。 */
  function plate(x, y, w, h) {
    if (!(w > 0) || !(h > 0)) return;
    ctx.fillStyle = HUD.plate;
    roundRect(ctx, x, y, w, h, HUD.radius); ctx.fill();
    ctx.strokeStyle = HUD.plateEdge; ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, HUD.radius); ctx.stroke();
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
  /* 世界里的一个标签：屏幕空间画，字号不随缩放变（规格 §1.1 的 tag 尺寸）。
     ⚠ 落点先过 tagPlace()：撞到 HUD 的块就整体让开 —— 上一版标签能直接飘到
     "W A S D 移动"那一行上，两行字压在一起谁也别想读。raw=true 是 HUD 自己的
     横幅（toast / 事件）用的：它本来就该在最上层，不参与避让。 */
  function tag(x, y, s, size, raw) {
    if (!s) return;
    var fs = size || 14;
    ctx.font = "bold " + fs + "px 'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
    var w = ctx.measureText(s).width + 16, h = HUD.tagPillH;
    if (!raw) {
      /* 锚点离画布太远（角色基本在画面外）就不画：不然夹回画布会让名字"贴"在
         边上，看着像画面里有个看不见的人。留 HUD.tagCull 的余量，给"半个身子
         还在画面里"的角色留名字。 */
      if (x < -HUD.tagCull || x > W + HUD.tagCull || y < -HUD.tagCull || y > H + HUD.tagCull) return;
      var p = tagPlace(x, y, w, h);
      if (!p) return;                    /* 让不开就不画（见 tagPlace 的注释） */
      x = p.x; y = p.y;
    }
    ctx.fillStyle = "rgba(11,10,19,.68)";
    roundRect(ctx, x - w / 2, y - h / 2 - 0.5, w, h, 9); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.10)"; ctx.lineWidth = 1;
    roundRect(ctx, x - w / 2, y - h / 2 - 0.5, w, h, 9); ctx.stroke();
    ctx.fillStyle = COL.player; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(s, x, y);
  }
  /* 标签落点：① 撞进 HUD 占用的矩形就沿**竖直**方向让开（选位移小的那一侧，
     要么挪到块上方、要么挪到块下方）；② 夹进画布，别被边缘切掉。
     只动 y 不动 x：标签是"头顶上的名字"，横着飞走反而找不到是谁。
     让不开就**不画**（返回 null）：角落里的角色本来就被 HUD 压着，
     与其把名字甩到半屏之外、或者被底衬盖掉一半，不如不画 —— minimap 上本来就有它的点。
     两遍是因为让开 A 之后可能撞上 B；HUD 的块互不重叠，两遍足够收敛。 */
  function tagPlace(x, y, w, h) {
    var hw = w / 2 + 4, hh = h / 2 + 4, rs = HL ? HL.rects : [], i, k, r, up, dn, y0 = y, canUp, canDn;
    for (k = 0; k < 2; k++) {
      for (i = 0; i < rs.length; i++) {
        r = rs[i];
        if (x + hw <= r.x || x - hw >= r.x + r.w || y + hh <= r.y || y - hh >= r.y + r.h) continue;
        up = r.y - hh;                     /* 挪到这块上面 */
        dn = r.y + r.h + hh;               /* 或下面 */
        canUp = up >= hh;                  /* 挪出去还得留在画布里，否则白挪（会被夹回来） */
        canDn = dn <= H - hh;
        if (canUp && canDn) y = (y - up <= dn - y) ? up : dn;
        else if (canUp) y = up;
        else if (canDn) y = dn;
        else return null;                  /* 上下都放不下：这一块彻底占住了这条竖带 */
        if (Math.abs(y - y0) > HUD.tagNudge) return null;
      }
      x = limit(x, hw, W - hw);
      y = limit(y, hh, H - hh);
    }
    return { x:x, y:y };
  }
  function dot(x, y, r, col) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }

  /* 画布尺寸：宽度贴着面板，高度给一个 5:3 的横向取景框。
     视野（view.w/h）是"画布里装得下多少世界像素"，相机再按规格夹在世界内。 */
  function fitCanvas() {
    if (!cv || !hostEl) return;
    if (!G || !G.view) return;
    var rect = hostEl.getBoundingClientRect ? hostEl.getBoundingClientRect() : null;
    var avail = Math.max(560, Math.round((rect && rect.width) || 900));
    W = Math.min(avail, 1000);
    H = Math.max(320, Math.round(W * 0.60));
    cv.width = W; cv.height = H;
    cv.style.width = "100%"; cv.style.height = H + "px";
    var vw = 1200;                       /* 一屏看到 1200 世界像素宽 */
    G.view.w = vw; G.view.h = H / (W / vw); G.view.scale = W / vw;
    /* ⚠ 纵向能装下多少世界**不在这里定**：tilt/deep 把地面压扁之后一屏装得下更多，
       压缩后的可见高度 v.eh 由 camFollow 按当前档位算（并据此夹取镜头，防黑边）。 */
  }
  /* 摄像机（规格 §1.1）：cx=clamp(0, 3000-vw, player.x-vw/2)。
     ⚠ 纵向按**压缩后**的视口高度 v.eh 夹取（tilt 时 eh = 视口高 / tilt，一屏能装更多世界）；
       flat 档 eh === v.h，与改造前逐字节相同。oy 是世界整个装得下时的上下居中偏移（防黑边）。 */
  function camFollow(g) {
    var v = g.view, c = viewCfg();
    v.ty = c.tilt;
    v.eh = v.h / c.tilt;
    if (v.eh > WORLD_H) {
      v.eh = WORLD_H;
      v.oy = (H - WORLD_H * c.tilt * v.scale) / 2;
    } else v.oy = 0;
    v.x = clampCam(g.player.x - v.w / 2, WORLD_W, v.w);
    v.y = clampCam(g.player.y - v.eh / 2, WORLD_H, v.eh);
  }
  function viewRect(g, pad) {
    pad = pad || 0;
    var v = g.view, vh = v.eh || v.h;          /* 压缩后真正能看见的世界高度 */
    return { x0:v.x - pad, y0:v.y - pad,
             x1:v.x + v.w + pad, y1:v.y + vh + pad };
  }

  function render() {
    if (!G || !ctx) return;
    var g = G, s = g.view.scale, c = viewCfg();
    camFollow(g);                 /* 里面按档位算好 ty/eh/oy，并把镜头夹在世界内 */
    HL = hudLayout(g);            /* 先算布局：下面画世界标签时要靠它避让 HUD 的块 */
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COL.hud; ctx.fillRect(0, 0, W, H);
    if (c.tilt === 1) {
      /* ── 档位 1「flat」：**改造之前的原路径**，一行没动（保底档）── */
      ctx.save();
      ctx.translate(-g.view.x * s, -g.view.y * s);
      ctx.scale(s, s);                         /* 之后一律用世界像素坐标画 */
      drawFloor(g);
      drawWalls(g);
      drawMarkers(g);
      drawCones(g);
      drawNpcs(g);
      drawPlayer(g);
      ctx.restore();
    } else {
      /* ── 档位 2/3：贴地层（压缩）→ 立体层（按世界 Y 排序，角色立牌不压缩）── */
      drawGround2p5(g);
      drawStanding2p5(g);
    }
    drawLabels(g);
    drawHud(g);
  }

  function drawFloor(g) {
    var b = g.map.bounds, v = viewRect(g, 80), x, y;
    /* ── 背景贴图优先（规格 §1.1）：按当前关的 map.art 取图，等比铺满世界矩形
       (0,0)-(3000,2000)。已经跟着摄像机的 translate/scale 走，所以这里直接给世界坐标。
       还没 onload / 加载失败 → 掉下去画程序化地板（**绝不黑屏**）。── */
    var bg = bgSlot(g);
    if (artReady(bg)) { ctx.drawImage(bg.img, 0, 0, WORLD_W, WORLD_H); return; }
    ctx.fillStyle = COL.floorA;
    ctx.fillRect(b[0] - 200, b[1] - 200, (b[2] - b[0]) + 400, (b[3] - b[1]) + 400);
    ctx.fillStyle = COL.floorB;
    var x0 = Math.max(b[0], Math.floor(v.x0 / 100) * 100), x1 = Math.min(b[2], v.x1);
    var y0 = Math.max(b[1], Math.floor(v.y0 / 100) * 100), y1 = Math.min(b[3], v.y1);
    for (y = y0; y < y1; y += 100) {
      for (x = x0; x < x1; x += 100) {
        if ((Math.round(x / 100) + Math.round(y / 100)) % 2 === 0) {
          ctx.fillRect(x, y, Math.min(100, b[2] - x), Math.min(100, b[3] - y));
        }
      }
    }
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    ctx.beginPath();
    for (x = Math.max(b[0], Math.floor(v.x0 / 200) * 200); x < Math.min(b[2], v.x1); x += 200) {
      ctx.moveTo(x, Math.max(b[1], v.y0)); ctx.lineTo(x, Math.min(b[3], v.y1));
    }
    for (y = Math.max(b[1], Math.floor(v.y0 / 200) * 200); y < Math.min(b[3], v.y1); y += 200) {
      ctx.moveTo(Math.max(b[0], v.x0), y); ctx.lineTo(Math.min(b[2], v.x1), y);
    }
    ctx.stroke();
    ctx.strokeStyle = COL.bound; ctx.lineWidth = 3;
    ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
  }

  function drawWalls(g) {
    var w = g.map.walls, v = viewRect(g, 100), i, a;
    /* ── 背景就绪时**不再**画程序化墙体色块：插图里已经画好了家具与隔断，
       再叠一层就是双重叠加（很脏）。碰撞本身一点没变，要核对"看到的家具 vs
       实际的碰撞"就开 debug.collisionOverlay(true)（细线描边，默认关）。── */
    if (!bgReady(g)) {
      for (i = 0; i < w.length; i++) {
        a = w[i];
        if (a[0] > v.x1 || a[0] + a[2] < v.x0 || a[1] > v.y1 || a[1] + a[3] < v.y0) continue;
        ctx.fillStyle = COL.wall; ctx.fillRect(a[0], a[1], a[2], a[3]);
        ctx.fillStyle = COL.wallTop; ctx.fillRect(a[0], a[1], a[2], Math.min(12, a[3] * 0.18));
        ctx.strokeStyle = COL.wallLine; ctx.lineWidth = 2;
        ctx.strokeRect(a[0] + 1, a[1] + 1, a[2] - 2, a[3] - 2);
      }
    }
    /* 调试描边：只描线、不填色，铺不铺背景都能开（两层叠加时就是"双重"的实证）。 */
    if (collideOverlay) {
      ctx.save();
      ctx.strokeStyle = COL.collide; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (i = 0; i < w.length; i++) {
        a = w[i];
        if (a[0] > v.x1 || a[0] + a[2] < v.x0 || a[1] > v.y1 || a[1] + a[3] < v.y0) continue;
        ctx.rect(a[0] + 0.75, a[1] + 0.75, Math.max(1, a[2] - 1.5), Math.max(1, a[3] - 1.5));
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  /* 五个关键点（规格 §6.5）：它们就是玩法全部的可交互物。 */
  function drawMarkers(g) {
    var p = g.map.points;
    /* 出生点：地面标记环 */
    ctx.strokeStyle = "rgba(99,213,195,.75)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(p.start.x, p.start.y, 23, 9, 0, 0, Math.PI * 2); ctx.stroke();
    /* 打印区 */
    ctx.fillStyle = g.fileTaken ? "#4a4f66" : COL.folder;
    roundRect(ctx, p.printer.x - 30, p.printer.y - 20, 60, 40, 6); ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,.28)"; ctx.fillRect(p.printer.x - 30, p.printer.y - 6, 60, 6);
    /* 工位 */
    ctx.fillStyle = g.hidden ? "#7fd6ba" : "#3b3f52";
    roundRect(ctx, p.seat.x - 30, p.seat.y - 20, 60, 40, 6); ctx.fill();
    ctx.fillStyle = g.hidden ? "rgba(255,255,255,.35)" : "#4a4f66";
    ctx.fillRect(p.seat.x - 24, p.seat.y - 14, 48, 12);
    /* 咖啡机 */
    ctx.fillStyle = g.lure > 0 ? COL.coffeeOn : COL.coffee;
    roundRect(ctx, p.distraction.x - 26, p.distraction.y - 22, 52, 44, 8); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.5)";
    ctx.fillRect(p.distraction.x - 16, p.distraction.y - 14, 32, 10);
    if (g.lure > 0) {
      ctx.fillStyle = "rgba(255,176,60,.16)";
      ctx.beginPath(); ctx.arc(p.distraction.x, p.distraction.y, 95, 0, Math.PI * 2); ctx.fill();
    }
    /* 电梯：open 时按规格画门口高亮 */
    var L = p.lift, open = g.lift === "open";
    if (open) { ctx.fillStyle = "rgba(63,243,211,.13)"; ctx.fillRect(L.x - 40, L.y - 90, 80, 110); }
    ctx.fillStyle = open ? "rgba(117,241,207,.34)" : "rgba(117,241,207,.12)";
    ctx.fillRect(L.x - 38, L.y - 38, 76, 76);
    ctx.strokeStyle = open ? COL.lift : "rgba(117,241,207,.55)"; ctx.lineWidth = 3;
    ctx.strokeRect(L.x - 38, L.y - 38, 76, 76);
  }

  /* 视野锥：按墙真实裁剪（conePoly 在几何层）。颜色按威胁切换（规格 §1.1）。 */
  function drawCones(g) {
    for (var i = 0; i < g.npcs.length; i++) {
      var n = g.npcs[i];
      if (!isDrawable(g, n)) continue;
      var pts = conePoly(n, g.map), k;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.closePath();
      var hot = !!n.sees || g.suspicion > 60;
      ctx.fillStyle = hot ? COL.coneHot : COL.cone;
      ctx.fill();
      ctx.strokeStyle = hot ? COL.coneHotEdge : COL.coneEdge;
      ctx.lineWidth = 2; ctx.stroke();
    }
  }

  function npcColor(id) { return id === "supervisor" ? COL.shop : id === "boss" ? COL.boss : COL.guard; }
  function npcLabel(id) { return id === "supervisor" ? "主管" : id === "boss" ? "老板" : id === "coworker" ? "" : "巡查员"; }

  function drawNpcs(g) {
    for (var i = 0; i < g.npcs.length; i++) {
      var n = g.npcs[i];
      if (!isDrawable(g, n)) continue;
      var r = n.id === "boss" ? 20 : 18;
      /* 脚下影子：贴图与色块两条路都画（它同时承载"这个巡查正看着你"的红色警示） */
      ctx.fillStyle = n.sees ? "rgba(255,77,109,.32)" : "rgba(0,0,0,.35)";
      ctx.beginPath(); ctx.ellipse(n.x, n.y + 7, r * 1.05, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
      /* ── 贴图优先：主管 / 老板 用贴图，尺寸 112、原点 (-size/2, -size+8)（规格 §1.1）。
         保安（guard3…，只在变态/地狱出现）上游没有贴图 → 落到下面的程序化色块。── */
      var art = npcArt(n);
      if (artReady(art)) {
        var size = art.size;
        ctx.drawImage(art.img, n.x - size / 2, n.y - size + art.dy, size, size);
      } else {
        ctx.fillStyle = n.sees ? COL.alert : npcColor(n.id);
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#f0d8c0";
        ctx.beginPath(); ctx.arc(n.x, n.y, r * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(n.x + Math.cos(n.angle) * r * 0.7, n.y + Math.sin(n.angle) * r * 0.7);
        ctx.lineTo(n.x + Math.cos(n.angle) * r * 1.5, n.y + Math.sin(n.angle) * r * 1.5);
        ctx.stroke();
      }
      if (n.lure) {                                   /* 被咖啡机钉住：给个"分心"气泡 */
        ctx.strokeStyle = COL.coffeeOn; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(n.x, n.y - r - 12, 7, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  function drawPlayer(g) {
    var p = g.player, R0 = PLAYER_R;
    if (!g.hidden) {
      ctx.fillStyle = "rgba(26,35,41,.19)";
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 6, 17, 6, 0, 0, Math.PI * 2); ctx.fill();
    }
    /* 选中环（规格 §1.1）：状态色不变，贴图与色块两条路都画 */
    ctx.strokeStyle = g.cover > 0 ? "#8ef0e1" : (g.hidden ? "#85cb9e" : "#ffda84");
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(p.x, p.y, 22, 8, 0, 0, Math.PI * 2); ctx.stroke();
    /* ── 贴图优先（规格 §1.1）：站着 111 / 坐着 105，原点 (-size/2, -size+8)，
       坐姿原点 (-size/2, -size+12)。hidden 状态用 player-seated.png。
       贴图没就绪 / 加载失败 → 落到下面的程序化小人（原来那套，一个像素没改）。── */
    var art = ART.actor[g.hidden ? "player-seated" : "player"];
    if (artReady(art)) {
      var size = art.size;
      ctx.drawImage(art.img, p.x - size / 2, p.y - size + art.dy, size, size);
    } else {
      ctx.fillStyle = g.cover > 0 ? "#bff0ff" : COL.player;
      ctx.beginPath(); ctx.arc(p.x, p.y - 4, R0 * 0.78, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COL.playerDark;
      ctx.beginPath(); ctx.arc(p.x, p.y - 4, R0 * 0.42, 0, Math.PI * 2); ctx.fill();
      var a = p.angle === undefined ? 0 : p.angle;
      ctx.strokeStyle = "#20222c"; ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 4);
      ctx.lineTo(p.x + Math.cos(a) * R0, p.y - 4 + Math.sin(a) * R0);
      ctx.stroke();
    }
    if (g.hidden) {                                  /* 坐姿：椅子（两条路都画） */
      ctx.fillStyle = "rgba(127,214,186,.55)";
      roundRect(ctx, p.x - 26, p.y + 8, 52, 16, 6); ctx.fill();
    }
  }

  /* ═════════════════ 9.3 档位 2/3 的 2.5D 绘制（tilt / deep） ═════════════════
     分两层画，顺序就是"从下往上"：
       ① 贴地层 drawGround2p5 —— 背景图 / 地板格 / 地面标记 / 视野锥 / 影子 / 选中环，
          全部在那一个"绕视口中心纵向压扁"的变换里画。少压一个就会浮在空中。
       ② 立体层 drawStanding2p5 —— 家具挤出体 + 角色立牌，**屏幕空间**画（贴图不压缩），
          按"地面接触 Y"（家具 = 矩形底边、角色 = 脚底）从小到大排序：近的压远的。
     ⚠ 排序必须稳定：Y 相同时再按 类型 / 下标 比，否则同样高的两样东西会逐帧换位、看起来在闪。
     ⚠ 角色贴图/程序化色块都**不压缩**（锚点用压缩后的脚底地面点，贴图按原比例向上画），
       所以人是"站"在地上的；影子/选中环留在地层里被压扁，正好贴在压缩后的地面上。 */

  /* 惰性建一次的"软边"渐变（单位盒，用时靠 CTM 缩放到位）：避免每帧给每个家具 new 一个渐变 */
  var gradDark = null, gradLight = null, gradFacade = null;
  function band(x, y, w, h, grad) {
    if (!(w > 0) || !(h > 0)) return;
    ctx.save(); ctx.translate(x, y); ctx.scale(w, h);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 1, 1); ctx.restore();
  }
  function initGrads() {
    if (gradDark) return;
    gradDark = ctx.createLinearGradient(0, 0, 1, 0);      /* 左→右：透 → 深（左投影带，靠墙最深） */
    gradDark.addColorStop(0, "rgba(6,7,13,0)");
    gradDark.addColorStop(1, "rgba(6,7,13,.34)");
    gradLight = ctx.createLinearGradient(0, 0, 0, 1);     /* 上→下：深 → 透（下投影带，靠墙最深） */
    gradLight.addColorStop(0, "rgba(6,7,13,.34)");
    gradLight.addColorStop(1, "rgba(6,7,13,0)");
    gradFacade = ctx.createLinearGradient(0, 0, 0, 1);    /* 侧立面：上沿略亮 → 落地最暗 */
    gradFacade.addColorStop(0, "rgba(26,30,46,.82)");
    gradFacade.addColorStop(1, "rgba(6,7,13,.95)");
  }

  /* 把"贴地的一层"整体绕视口中心纵向压扁：之后用世界像素坐标画，屏幕上自动是压过的。 */
  function pushGroundXform(v, c) {
    ctx.save();
    ctx.translate(0, v.oy);
    ctx.scale(v.scale, v.scale);
    ctx.translate(-v.x, v.h / 2 - (v.y + v.eh / 2) * c.tilt);
    ctx.scale(1, c.tilt);
  }

  /* deep 档：家具向左下投的一层柔和暗影（贴地，所以在压缩层里画、并被后面的家具本体盖住芯部）。
     没有模糊滤镜，用两条"由深到透"的渐变带（左 + 下）拼出来，交界处自然叠一点。 */
  var DROP_OFF = 26;
  function drawDrop2p5(g) {
    var w = g.map.walls, v = viewRect(g, 120), o = DROP_OFF, i, a;
    initGrads();
    for (i = 0; i < w.length; i++) {
      a = w[i];
      if (a[0] > v.x1 || a[0] + a[2] < v.x0 || a[1] > v.y1 || a[1] + a[3] < v.y0) continue;
      band(a[0] - o, a[1] + o * .5, o, a[3], gradDark);          /* 左侧一条 */
      band(a[0] - o, a[1] + a[3], a[2] + o, o, gradLight);       /* 下侧一条（含左下角） */
    }
  }

  /* 贴地的影子与选中环：**和 flat 档同一套数字**，区别只是外面套了压缩变换 ——
     于是它们自动贴在压缩后的地面上，不会"浮在空中"。 */
  function drawDecals2p5(g) {
    var i, n, r, p = g.player;
    for (i = 0; i < g.npcs.length; i++) {
      n = g.npcs[i];
      if (!isDrawable(g, n)) continue;
      r = n.id === "boss" ? 20 : 18;
      ctx.fillStyle = n.sees ? "rgba(255,77,109,.32)" : "rgba(0,0,0,.35)";
      ctx.beginPath(); ctx.ellipse(n.x, n.y + 7, r * 1.05, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (!g.hidden) {
      ctx.fillStyle = "rgba(26,35,41,.19)";
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 6, 17, 6, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = g.cover > 0 ? "#8ef0e1" : (g.hidden ? "#85cb9e" : "#ffda84");
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(p.x, p.y, 22, 8, 0, 0, Math.PI * 2); ctx.stroke();
  }

  function drawGround2p5(g) {
    var c = viewCfg();
    pushGroundXform(g.view, c);
    drawFloor(g);                            /* 背景贴图 / 程序化地板格（贴地） */
    if (c.drop) drawDrop2p5(g);              /* deep：家具的地面投影（贴地） */
    drawMarkers(g);                          /* 五个关键点：全在地上（电梯地光也在这里） */
    drawCones(g);                            /* 视野锥：贴地 */
    drawDecals2p5(g);                        /* 影子 / 选中环（贴地） */
    ctx.restore();
  }

  /* 家具/墙体挤出：**先把顶面抬起来，再补上从顶面到地面接触边之间的侧立面，
     最后给顶沿压一条亮边** —— 于是它看起来是"有高度的一块"，而不是"糊了一层"。
     顶面用的是这张插图自己的那一块像素（9 参数 drawImage 只取那一小块），
     所以家具仍然认得出原样，只是被整体抬高并加了一条暗色侧面。
     ⚠ 侧立面以"地面接触边"为界**上下各半**（上 hh/2 抬顶面，下 hh/2 落在地面接触边之下当裙边）。
       为什么不整段往上挤：整段上挤会让站在家具**后面**的角色被整个吞掉 —— deep 档实测，
       贴着家具站的人 84px 身高里被盖住 88px，等于隐身（潜行游戏里看不见自己 = 不能玩）。
       对半分之后最坏情况只盖住贴边角色的一半，而"顶面抬升 + 一整条暗色侧立面"的高度感
       一点没少（侧立面总高仍然是 WALL_H）。 */
  function drawWall2p5(g, a, c) {
    var v = g.view, s = v.scale, bg = bgSlot(g), img = bg && bg.img;
    var x0 = projX(v, a[0]), w = a[2] * s;
    var yb = projY(v, a[1] + a[3]);          /* 地面接触边（近侧底边） */
    var yt = projY(v, a[1]);                 /* 远侧边（未抬升） */
    var hh = c.wallH * s, up = hh / 2;       /* 侧立面总高 / 其中抬顶面的那一半 */
    var hRoof = yb - yt;
    if (!(w > 0) || !(hh > 0) || !(hRoof > 0)) return;
    /* ① 顶面（抬升 up） */
    if (artReady(bg)) {
      var bx = (img.naturalWidth || img.width) / WORLD_W;
      var by = (img.naturalHeight || img.height) / WORLD_H;
      ctx.drawImage(img, a[0] * bx, a[1] * by, a[2] * bx, a[3] * by,
                    x0, yt - up, w, hRoof);
    } else {
      ctx.fillStyle = COL.wall; ctx.fillRect(x0, yt - up, w, hRoof);
      ctx.fillStyle = COL.wallTop;
      ctx.fillRect(x0, yt - up, w, Math.max(2, Math.min(12 * s, hRoof * .5)));
    }
    /* ② 侧立面：整条 hh 高（顶部略亮、落地最暗 → 一眼看出是"立面"） */
    initGrads();
    band(x0, yb - up, w, hh, gradFacade);
    /* ③ 顶沿亮边（受光的那一条）+ deep 档的轻微描边 */
    ctx.strokeStyle = "rgba(255,237,200,.26)"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0 + .5, yb - up + .5); ctx.lineTo(x0 + w - .5, yb - up + .5);
    ctx.stroke();
    if (c.edge) {
      ctx.strokeStyle = "rgba(8,9,15,.40)"; ctx.lineWidth = 1;
      ctx.strokeRect(x0 + .5, yt - up + .5, w - 1, hRoof + hh - 1);
    }
  }

  /* 角色立牌：锚点 = 压缩后的**脚底**地面点，贴图按原比例（不压缩）向上画。
     贴图优先，缺图回落成"站起来的色块"（圆心抬到脚底上方一个半径），
     两条路的观感都是"立在地面上"而不是"趴在地上"。 */
  function npcTop2p5(n, s) {
    var art = npcArt(n);
    return artReady(art) ? (art.size - art.dy) * s : (n.id === "boss" ? 20 : 18) * 2 * s;
  }
  function drawNpc2p5(g, n) {
    var v = g.view, s = v.scale, X = projX(v, n.x), Y = projY(v, n.y);
    var r = (n.id === "boss" ? 20 : 18) * s, art = npcArt(n), top = npcTop2p5(n, s);
    if (artReady(art)) {
      var d = art.size * s;
      ctx.drawImage(art.img, X - d / 2, Y - (art.size - art.dy) * s, d, d);
    } else {
      var cy = Y - r;                        /* 程序化色块也"站"起来 */
      ctx.fillStyle = n.sees ? COL.alert : npcColor(n.id);
      ctx.beginPath(); ctx.arc(X, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#f0d8c0";
      ctx.beginPath(); ctx.arc(X, cy, r * 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(X + Math.cos(n.angle) * r * 0.7, cy + Math.sin(n.angle) * r * 0.7);
      ctx.lineTo(X + Math.cos(n.angle) * r * 1.5, cy + Math.sin(n.angle) * r * 1.5);
      ctx.stroke();
    }
    if (n.lure) {                            /* 被咖啡机钉住：给个"分心"气泡（抬到头顶） */
      ctx.strokeStyle = COL.coffeeOn; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X, Y - top - 12, 7, 0, Math.PI * 2); ctx.stroke();
    }
  }
  function drawPlayer2p5(g) {
    var v = g.view, s = v.scale, p = g.player, R0 = PLAYER_R;
    var X = projX(v, p.x), Y = projY(v, p.y);
    var art = ART.actor[g.hidden ? "player-seated" : "player"];
    if (artReady(art)) {
      var d = art.size * s;
      ctx.drawImage(art.img, X - d / 2, Y - (art.size - art.dy) * s, d, d);
    } else {
      var r = R0 * 0.78 * s, cy = Y - R0 * s;
      ctx.fillStyle = g.cover > 0 ? "#bff0ff" : COL.player;
      ctx.beginPath(); ctx.arc(X, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COL.playerDark;
      ctx.beginPath(); ctx.arc(X, cy, r * 0.54, 0, Math.PI * 2); ctx.fill();
      var a = p.angle === undefined ? 0 : p.angle;
      ctx.strokeStyle = "#20222c"; ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(X, cy);
      ctx.lineTo(X + Math.cos(a) * R0 * s, cy + Math.sin(a) * R0 * s);
      ctx.stroke();
    }
    if (g.hidden) {                          /* 坐姿：椅子（和 flat 一样画在人物之后，压住下半身） */
      ctx.fillStyle = "rgba(127,214,186,.55)";
      roundRect(ctx, projX(v, p.x - 26), projY(v, p.y + 8), 52 * s, 16 * v.ty * s, 6);
      ctx.fill();
    }
  }

  /* 碰撞描边（debug.collisionOverlay）在 2.5D 下改到"立体层最后"画：描的仍然是
     **地面碰撞矩形**（判定用的那个），于是"看到的高度"与"实际的碰撞"可以直接对照。 */
  function drawCollide2p5(g) {
    if (!collideOverlay) return;
    var w = g.map.walls, v = viewRect(g, 160), i, a, x0, y0, x1, y1;
    ctx.save();
    ctx.strokeStyle = COL.collide; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (i = 0; i < w.length; i++) {
      a = w[i];
      if (a[0] > v.x1 || a[0] + a[2] < v.x0 || a[1] > v.y1 || a[1] + a[3] < v.y0) continue;
      x0 = projX(g.view, a[0]); x1 = projX(g.view, a[0] + a[2]);
      y0 = projY(g.view, a[1]); y1 = projY(g.view, a[1] + a[3]);
      ctx.rect(x0 + .75, y0 + .75, Math.max(1, x1 - x0 - 1.5), Math.max(1, y1 - y0 - 1.5));
    }
    ctx.stroke();
    ctx.restore();
  }

  /* 立体层：屏幕空间画（贴图不压缩），按"地面接触 Y"排序 —— 角色与家具之间也正确遮挡。 */
  function drawStanding2p5(g) {
    var v = g.view, c = viewCfg(), vv = viewRect(g, 260), items = [], i, a, n;
    for (i = 0; i < g.map.walls.length; i++) {
      a = g.map.walls[i];
      if (a[0] > vv.x1 || a[0] + a[2] < vv.x0 || a[1] > vv.y1 || a[1] + a[3] < vv.y0) continue;
      items.push({ y:a[1] + a[3], k:0, i:i, a:a });            /* 家具：底边 */
    }
    for (i = 0; i < g.npcs.length; i++) {
      n = g.npcs[i];
      if (!isDrawable(g, n)) continue;
      items.push({ y:n.y, k:1, i:i, n:n });                    /* 角色：脚底 */
    }
    items.push({ y:g.player.y, k:2, i:0, n:null });
    items.sort(function (p, q) { return (p.y - q.y) || (p.k - q.k) || (p.i - q.i); });
    ctx.setTransform(1, 0, 0, 1, 0, 0);                        /* 之后一律屏幕像素 */
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.k === 0) drawWall2p5(g, it.a, c);
      else if (it.k === 1) drawNpc2p5(g, it.n);
      else drawPlayer2p5(g);
    }
    drawCollide2p5(g);
  }

  /* 文字标签：屏幕空间（字号不随摄像机缩放变），文案用规格 §7.6 原文。 */
  /* 标签要抬到**头顶**多高。两段口径别搞混：
       ① 贴图顶到脚底 = (size - dy) **世界像素**（111 高的贴图就是 103）；
       ② 标签药丸是**屏幕空间**的 25px 定高（字号不随摄像机缩放变，规格 §1.1）。
     所以头顶上还要留的世界像素 = (药丸半高 + 4px 呼吸) ÷ 缩放 —— 上一版这里写死
     16 世界像素：W=982 时刚好让开 0.6px，画布一窄（缩放变小）16 世界像素就换不到
     12.5 屏幕像素，药丸又压在角色头上（W=560 时压 5px）。没贴图时原样返回旧偏移 ——
     程序化小人本来就只有 ~14 世界像素半径，回落路径一个像素都不变。 */
  function headGap(art, fallback, s) {
    if (!artReady(art)) return fallback;
    return (art.size - art.dy) + (HUD.tagPillH / 2 + 4) / (s || 1);
  }
  function drawLabels(g) {
    var v = g.view, s = v.scale, p = g.map.points, i, n, isFlat = (viewCfg().tilt === 1);
    function X(wx) { return (wx - v.x) * s; }
    function Y(wy) { return (wy - v.y) * s; }
    /* ── 世界标签的锚点：flat 档与改造前逐像素相同；tilt/deep 档"锚点压缩、药丸不压缩" ──
       up/dn：锚点先投影到压缩后的地面点，再按**屏幕像素**抬 / 降 —— 药丸本身不会被压扁。
       head：人物的名字要抬到"立牌"头顶（贴图 (size−dy)×缩放、程序化 40×缩放），
             再留半个药丸 + 4px 呼吸；照老口径（世界偏移 × 缩放）会被压进人物身体里。 */
    function upY(wy, gap) { return isFlat ? Y(wy - gap) : projY(v, wy) - gap * s; }
    function dnY(wy, gap) { return isFlat ? Y(wy + gap) : projY(v, wy) + gap * s; }
    function headY(art, wy, fb) {
      if (isFlat) return Y(wy - headGap(art, fb, s));
      var top = artReady(art) ? (art.size - art.dy) * s : fb * s;
      return projY(v, wy) - top - (HUD.tagPillH / 2 + 4);
    }
    tag(X(p.printer.x), upY(p.printer.y, 42), g.fileTaken ? "已取文件" : "文件夹");
    tag(X(p.seat.x), upY(p.seat.y, 42), g.hidden ? "伪装中" : "空工位");
    tag(X(p.distraction.x), upY(p.distraction.y, 42), "咖啡机");
    tag(X(p.lift.x), upY(p.lift.y, 52),
      g.lift === "open" ? (g.floor < g.floors ? "前往二层" : "电梯已到")
        : g.lift === "calling" ? Math.ceil(g.liftTimer) + " 秒" : "换层电梯");
    for (i = 0; i < g.npcs.length; i++) {
      n = g.npcs[i];
      if (!isDrawable(g, n)) continue;
      tag(X(n.x), headY(npcArt(n), n.y, 40), npcLabel(n.id), 13);
    }
    var pl = g.player;
    var plArt = ART.actor[g.hidden ? "player-seated" : "player"];
    tag(X(pl.x), headY(plArt, pl.y, 46),
      g.hidden ? "正在假装工作" : (g.cover > 0 ? "送材料 " + Math.ceil(g.cover) + "s" : "你"), 13);
    if (NEAR) tag(X(NEAR.x), dnY(NEAR.y, 66), "E  " + NEAR.label, 15);
  }

  /* ── HUD（规格 §7.6 的原文，一个字没改）＋ 小地图（规格 §1.1 的尺寸与配色）── */

  /* HUD 的三行文案与怀疑度状态 —— 布局与绘制共用同一份，杜绝"量的是 A、画的是 B"。
     文案本身照抄规格 §7.6，这里只把它从 drawHud 里提出来。 */
  function hudLines(g) {
    var obj, sub, left, right, frac, danger = g.suspicion > 60;
    var coverDur = g.config.coverDuration || 1;
    if (g.lift === "open") obj = g.floor < g.floors ? "换层电梯到了，前往二层" : "电梯到了，快进去！";
    else if (g.lift === "calling") obj = "等待电梯，留意身后";
    else obj = "第 " + g.level + " / " + LEVELS.length + " 关 · " + g.map.name +
               (g.floors > 1 ? " · " + g.floor + "/2 层" : "");
    sub = g.lift === "idle"
      ? ((g.floor < g.floors ? "先找到电梯前往二层" : "绿色标记为本层出口") + " · 等待 " + g.config.liftWait + " 秒")
      : "靠近电梯门，按 E 进入";
    if (danger) { left = "已被发现"; right = "暴露"; frac = 1; }
    else if (g.hidden) { left = "伪装中"; right = "安全"; frac = 1; }
    else if (g.cover > 0) { left = "送材料中"; right = "伪装"; frac = limit(g.cover / coverDur, 0, 1); }
    else { left = "巡逻视线"; right = "安全"; frac = 0; }
    return {
      title: g.difficulty.name + "模式 / 第 " + g.level + " 关 · " + g.map.name +
             (g.floors > 1 ? "  F" + g.floor + "/2" : ""),
      obj: obj, sub: sub, left: left, right: right, frac: frac, danger: danger,
      time: Math.ceil(g.time), urgent: g.time <= 20,
      hint: "W A S D 移动 · E 互动 · 空格 使用文件",
      foot: "工作已完成，下班理直气壮。 躲开视线 · 临场应变 · 准点回家"
    };
  }

  /* 每帧一趟布局：把这一帧所有 HUD 块的位置 / 尺寸 / 基线算出来，并给出**占用矩形**。
     绘制（drawHud）与世界标签的避让（tagPlace）都读它 —— "谁在哪儿"只有这一个答案。
     所有数字来自 HUD 常量表；块与块之间按"从上往下 / 从下往上"的顺序排，不互相借位。 */
  function hudLayout(g) {
    var L = hudLines(g);

    /* ── 左上信息块：三行，中心距 28 / 25（字号 12.5 / 15 / 11.5 → 净空 12+px）── */
    var c1 = HUD.infoY + HUD.infoPadY + HUD.infoL1 / 2;
    var c2 = c1 + HUD.infoGap1, c3 = c2 + HUD.infoGap2;
    var iw = Math.ceil(Math.max(textW(L.title, HUD.infoL1),
                                textW(L.obj, HUD.infoL2),
                                textW(L.sub, HUD.infoL3, "normal")));
    var info = { x:HUD.infoX, y:HUD.infoY, tx:HUD.infoX + HUD.infoPadX,
                 w:iw + HUD.infoPadX * 2, h:(c3 + HUD.infoL3 / 2 + HUD.infoPadY) - HUD.infoY,
                 c1:c1, c2:c2, c3:c3 };

    /* ── 右上小地图：底衬比地图本身外扩一圈，外加底部说明行 ── */
    var mw = Math.min(230, W * 0.25), mh = mw * 2 / 3, mb = HUD.miniBox;
    var mini = { x:W - mw - HUD.miniX, y:HUD.miniY, w:mw, h:mh, k:mw / WORLD_W,
                 bx:W - mw - HUD.miniX - mb, by:HUD.miniY - mb,
                 bw:mw + mb * 2, bh:mh + mb + HUD.miniCap,
                 capY:HUD.miniY + mh + HUD.miniCap / 2 - 1 };

    /* ── 左下状态块 + 底部居中提示块：都从画布底边往上排，顺序固定 ── */
    var footY = H - HUD.botPad - HUD.footL / 2;
    var hintY = footY - HUD.footGap;
    var timeY = hintY - HUD.hintGap;
    var barW = Math.min(HUD.barW, W * 0.26);
    var barY = timeY - HUD.timeBig / 2 - HUD.timeGap - HUD.barH;
    var labY = barY - HUD.barLabelGap;
    var stat = { x:HUD.infoX, y:labY - HUD.barLabelL / 2 - 6,
                 w:barW + HUD.infoPadX * 2,
                 barX:HUD.infoX + HUD.infoPadX, barY:barY, barW:barW,
                 labY:labY, timeY:timeY };
    stat.h = (timeY + HUD.timeBig / 2 + 8) - stat.y;
    var hint = { y:hintY, footY:footY,
                 w:Math.max(textW(L.hint, HUD.hintL, "normal"),
                            textW(L.foot, HUD.footL, "normal")) + 24 };

    /* ── 顶部中央：toast / 事件横幅（恒定落在信息块下沿之下）── */
    var toastY = Math.max(HUD.toastMin, Math.round(H * HUD.toastK));

    /* ── 占用矩形：世界标签撞上任何一块都会让开（见 tagPlace）── */
    var rects = [
      { x:info.x - 3, y:info.y - 3, w:info.w + 6, h:info.h + 6 },
      { x:mini.bx, y:mini.by, w:mini.bw, h:mini.bh },
      { x:stat.x - 3, y:stat.y - 3, w:stat.w + 6, h:stat.h + 6 },
      { x:(W - hint.w) / 2, y:hint.y - 7, w:hint.w, h:(hint.footY - hint.y) + 20 }
    ];
    if (g.phase === "playing" && g.time > 0) {
      if (g.toastTimer > 0 && g.toast)
        rects.push({ x:(W - textW(g.toast, HUD.toastL) - 20) / 2, y:toastY - 14,
                     w:textW(g.toast, HUD.toastL) + 20, h:28 });
      if (g.eventTimer > 0 && g.eventText)
        rects.push({ x:(W - textW(g.eventText, HUD.bannerL) - 20) / 2, y:toastY + HUD.bannerGap - 14,
                     w:textW(g.eventText, HUD.bannerL) + 20, h:28 });
    }
    return { g:g, lines:L, info:info, mini:mini, stat:stat, hint:hint,
             toastY:toastY, rects:rects };
  }

  function drawHud(g) {
    var L = (HL && HL.g === g) ? HL : hudLayout(g);
    var ln = L.lines, st = L.stat;

    /* ── 左上信息块：三行 + 半透明底衬（压在亮插图上也能读）── */
    plate(L.info.x, L.info.y, L.info.w, L.info.h);
    txtOut(ln.title, L.info.tx, L.info.c1, HUD.infoL1, COL.lift);
    txtOut(ln.obj, L.info.tx, L.info.c2, HUD.infoL2, COL.marker);
    txtOut(ln.sub, L.info.tx, L.info.c3, HUD.infoL3, "rgba(233,227,209,.70)", "left", "normal");

    /* ── 左下：怀疑度条（规格 §7.6：danger / hidden / cover 三种颜色）+ 倒计时 ── */
    plate(st.x, st.y, st.w, st.h);
    txtOut(ln.left, st.barX, st.labY, HUD.barLabelL, ln.danger ? "#ed7964" : "rgba(233,227,209,.80)", "left", "normal");
    txtOut(ln.right, st.barX + st.barW, st.labY, HUD.barLabelL, ln.danger ? "#ed7964" : "#80d6ba", "right");
    ctx.fillStyle = "rgba(255,255,255,.10)";
    roundRect(ctx, st.barX, st.barY, st.barW, HUD.barH, 4); ctx.fill();
    ctx.fillStyle = ln.danger ? "#ed7964" : "#80d6ba";
    roundRect(ctx, st.barX, st.barY, Math.max(0, st.barW * ln.frac), HUD.barH, 4); ctx.fill();
    txtOut("剩余", st.barX, st.timeY, HUD.timeL, "rgba(233,227,209,.66)", "left", "normal");
    txtOut((ln.time < 10 ? "0" : "") + ln.time + " s", st.barX + HUD.timeBig * 1.7, st.timeY,
           HUD.timeBig, ln.urgent ? COL.alert : COL.player);

    /* ── 底部两行（居中）：只描边不铺底板 —— 画面正中下部最容易挡住角色 ── */
    txtOut(ln.hint, W / 2, L.hint.y, HUD.hintL, "rgba(233,227,209,.78)", "center", "normal");
    txtOut(ln.foot, W / 2, L.hint.footY, HUD.footL, "rgba(233,227,209,.46)", "center", "normal");

    drawMinimap(g, L);
    drawViewCtl(g);

    /* toast（3.8s）与事件横幅（4s / 3.5s）—— 只在 playing 且还有时间时显示。
       y 由布局表给：恒定在左上信息块下沿之下，不会和任何一行挤在一起。 */
    if (g.phase === "playing" && g.time > 0) {
      if (g.toastTimer > 0 && g.toast) {
        ctx.globalAlpha = Math.min(1, g.toastTimer * 1.4);
        tag(W / 2, L.toastY, g.toast, HUD.toastL, true);
        ctx.globalAlpha = 1;
      }
      if (g.eventTimer > 0 && g.eventText) {
        ctx.globalAlpha = Math.min(1, g.eventTimer);
        tag(W / 2, L.toastY + HUD.bannerGap, g.eventText, HUD.bannerL, true);
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawMinimap(g, L) {
    var m = L.mini, mx = m.x, my = m.y, mw = m.w, mh = m.h, k = m.k, i, p = g.map.points;
    ctx.fillStyle = "rgba(11,10,19,.72)";
    roundRect(ctx, m.bx, m.by, m.bw, m.bh, 10); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.16)"; ctx.lineWidth = 1;
    roundRect(ctx, m.bx, m.by, m.bw, m.bh, 10); ctx.stroke();
    ctx.fillStyle = "rgba(200,210,240,.30)";
    for (i = 0; i < g.map.walls.length; i++) {
      var a = g.map.walls[i];
      ctx.fillRect(mx + a[0] * k, my + a[1] * k, Math.max(1, a[2] * k), Math.max(1, a[3] * k));
    }
    var ids = ["start", "printer", "seat", "distraction"];
    for (i = 0; i < ids.length; i++) dot(mx + p[ids[i]].x * k, my + p[ids[i]].y * k, 2.5, COL.marker);
    dot(mx + p.lift.x * k, my + p.lift.y * k, 4, COL.lift);
    for (i = 0; i < g.npcs.length; i++) {
      var n = g.npcs[i];
      if (!isDrawable(g, n)) continue;
      dot(mx + n.x * k, my + n.y * k, 2.5, "rgba(255,214,90,.9)");
    }
    dot(mx + g.player.x * k, my + g.player.y * k, 4, COL.player);
    txtOut("F" + g.floor + "/" + g.floors + " · 白点你 / 绿点电梯", mx + mw / 2, m.capY,
           HUD.miniCapL, "rgba(233,227,209,.62)", "center", "normal");
  }

  /* ── 视角切换控件（画布右下角的小药丸，点一下换下一档）────────────────────────
     为什么放右下角：左上信息块 / 右上小地图 / 左下状态块 / 底部居中两行都够不着它
     （底部两行是居中的，最窄画布下也与它横向错开）。
     ⚠ 它**不进 HL.rects**：世界标签的避让口径必须与改造前逐像素一致（flat 档是保底档）。
       它在 drawLabels 之后才画，所以万一有标签路过这里，也是被药丸盖住，不会两层字叠一起。 */
  function viewCtlBox() {
    var w = 120, h = 26;
    return { x:W - HUD.pad - w, y:H - HUD.pad - h - 16, w:w, h:h };
  }
  function viewCtlHit(x, y) {
    var b = viewCtlBox();
    return x >= b.x - 6 && x <= b.x + b.w + 6 && y >= b.y - 6 && y <= b.y + b.h + 6;
  }
  function drawViewCtl(g) {
    var b = viewCtlBox(), c = viewCfg(), i, x, dot0 = b.x + 10;
    plate(b.x, b.y, b.w, b.h);
    for (i = 0; i < VIEW_ORDER.length; i++) {          /* 三格：亮 = 当前档 */
      x = dot0 + i * 11;
      ctx.fillStyle = (VIEW_ORDER[i] === viewMode) ? COL.lift : "rgba(233,227,209,.20)";
      roundRect(ctx, x, b.y + b.h / 2 - 3.5, 7, 7, 2); ctx.fill();
    }
    txtOut(c.label, dot0 + VIEW_ORDER.length * 11 + 3, b.y + b.h / 2 + .5, 12,
           "rgba(233,227,209,.88)", "left", "normal");
  }

  /* ═════════════════ 10. 对局逻辑（应用层：会话控制 + 结算） ═════════════════ */

  /* 应用层的一步：读输入 → 引擎 tick → 过关/失败判定。
     ⚠ 失败之后这里什么都不做：引擎 tick 会因为 phase!=='playing' 直接短路，
       本函数也不能再碰 g（规格契约：失败后整个 g 字节级不变）。 */
  function step(dt) {
    var g = G;
    if (!g) return;
    if (dt > 0.1) dt = 0.1;
    if (!(dt > 0)) dt = 0;                 /* rAF 时间戳回绕/切后台回来时别把时间倒着走 */
    if (g.phase === "playing") {
      var ax = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      var ay = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
      var was = g.phase;
      tick(g, dt, { x:ax, y:ay });
      if (g.phase === "playing") {
        NEAR = nearInfo(g);
        /* 视野锥染色：只在还在 playing 时更新（失败后不许再改 g 的任何字段） */
        for (var i = 0; i < g.npcs.length; i++) {
          var n = g.npcs[i];
          n.sees = !g.hidden && g.cover <= 0 && !isCoworker(n) && sees(n, g.player, g.map);
        }
      }
      /* 失败结算的统一收口（幂等）：任何把局面打成 lost 的地方都走它。
         ⚠ 原来这里用 `was==='playing' && phase==='lost'` 判断，但 interactAt/useFile
           入口自己会先 captureIfSeen —— 那是在进入本循环**之前**就把 playing 打成 lost 的，
           于是 was 永远不等于 'playing'，这条路径永远不结算（result 恒 null、onSettle 不触发、
           被抓计数不涨，结算面板还会把失败画成"这一关，顺利脱身"）。 */
      settleIfLost(g);
    }
    syncWin(g);
  }

  /* 走进电梯那一刻（phase 变 won）只结账一次：记进度、决定"过关"还是"整轮通关"。
     ⚠ 本关 elapsed 的入账是**规格 nextLevel 的职责**，这里不写 clearedTimes，
       只维护应用层的 clearedCount（评级用），免得同一关被记两次。 */
  function syncWin(g) {
    if (g.phase !== "won" || g.counted) return;
    g.counted = true;
    g.clearedCount = (g.clearedCount || 0) + 1;
    if (g.level >= LEVELS.length) { endRun(g, "allclear"); return; }
    g.clear = { level:g.level, last:false, name:g.map.name, used:totalTime(g),
                left:g.time, caught:g.caughtCount || 0, ghost:!!g.ghost };
    /* 省时奖励按**每关独立时限**累计（V1 是三关共用一个池子，口径已变） */
    g.savedTime = (g.savedTime || 0) + Math.max(0, g.config.time - g.elapsed);
    NEAR = null;
    /* 进电梯过关（还有下一关）：上行三音，对上游 beep(990) 的加强版。
       这是"过关"的唯一收口（g.counted 保证一关只响一次）。 */
    cue("sfx-co-clear");
  }

  /* 失败结算的**统一收口**（幂等，endRun 自身也判 settled）。
     为什么单独抽出来：被打成 lost 的地方有三处 —— tick 内的三次 captureIfSeen、
     以及 interactAt / useFile 入口各自的那一次。后者发生在驱动循环**之外**，
     只把结算挂在循环上会漏掉它们（见 interactAt 上方的注释）。 */
  function settleIfLost(g) {
    if (!g || g.phase !== "lost" || g.settled) return false;
    if (g.caughtBy) { g.caughtCount = (g.caughtCount || 0) + 1; g.ghost = false; }
    endRun(g, g.caughtBy ? "caught" : "timeout");
    return true;
  }

  /* 结算 —— **唯一**调用 onSettle 的地方。
     口径不变：net = 赔付 − 入场（¥20）；练手局不调用、不收费。
     评级（本地约定，上游没有）：三关全通且零被发现 = S、三关全通 = A、
     过 2 关 = B、过 1 关 = C、0 关 = D。 */
  function endRun(g, why) {
    if (g.settled) return g.result;
    var cleared = g.clearedCount || 0;
    var ghostRun = !!g.ghost && !(g.caughtCount > 0);          /* 一次都没被发现 */
    var timeScore = timeScoreFor(g.mode, g.savedTime || 0, cleared);
    var ghost = ghostRun && cleared === LEVELS.length;
    var score = cleared * scoreOf("level") + timeScore + (ghost ? scoreOf("ghost") : 0);
    var pay = payoutOf(score, g.mode);
    var entry = g.practice ? 0 : TUNE.ENTRY;
    var net = pay - entry;
    var grade = (cleared === LEVELS.length) ? (ghost ? "S" : "A")
      : (cleared === LEVELS.length - 1 ? "B" : (cleared > 0 ? "C" : "D"));
    g.result = {
      why: why, mode: g.mode, grade: grade, cleared: cleared, levels: LEVELS.length,
      caught: g.caughtCount || 0, ghost: ghost,
      timeUsed: Math.round(totalTime(g)), timeLeft: Math.round(g.time),
      levelScore: cleared * scoreOf("level"), timeScore: timeScore,
      ghostScore: ghost ? scoreOf("ghost") : 0, score: score,
      pay: pay, entry: entry, net: net, practice: !!g.practice, message: g.message
    };
    g.settled = true;
    if (!g.practice && opts0 && typeof opts0.onSettle === "function") {
      try { opts0.onSettle(net, g.result); } catch (e) {}
    }
    if (opts0 && typeof opts0.onFinish === "function") {
      try { opts0.onFinish(g.result); } catch (e) {}
    }
    /* 结算音（g.settled 保证只响一次）：
       · 三关全通 → 更强的胜利音（上游是 beep(1180)）；
       · caught / timeout → **不在这里发**：fail() 已经在同一帧发过警报/超时音了；
       · 其余（debug 直接结束）→ 一声中性的收尾。 */
    if (cleared === LEVELS.length) cueVictory();
    else if (why !== "caught" && why !== "timeout") cue("ui-loss");
    return g.result;
  }

  /* ── 会话控制：过一关 / 重试本关 / 重开整轮 ── */
  function advanceLevel() {
    var g = G;
    if (!g) return false;
    var next = nextLevel(g);                    /* 规格：只有 won 且有下一关才有效 */
    if (!next) return false;
    carryApp(g, next);
    G = next;
    beginPlay(next);
    NEAR = nearInfo(next);
    fitCanvas();
    return true;
  }
  function retryRun() {
    var g = G;
    if (!g) return false;
    var next = retryLevel(g);                    /* 回本关第一层 + 保留已通关 + 换新 seed */
    carryApp(g, next);
    G = next;
    beginPlay(next);
    NEAR = nearInfo(next);
    fitCanvas();
    return true;
  }
  function restartRun() {
    G = startSession(opts0);
    fitCanvas();
    return true;
  }
  function resumeRun() {
    if (G && G.phase === "paused") { G.phase = "playing"; NEAR = nearInfo(G); cue("ui-click"); }
    return true;
  }

  /* E：上下文互动（换层浮层 / 过关继续）。
     ⚠ **失败后（phase==='lost'）E 与空格一律无效** —— 规格契约：被看见之后整个
       g 对象字节级冻结，输入 / E / 空格都不能再改变任何字段。重试请用浮层上的
       鼠标点击、或 debug.retry() / debug.restart()。 */
  function actInteract() {
    var g = G;
    if (!g) return false;
    if (g.phase === "floor-intro") return enterFloor(g);
    if (g.phase === "won") return g.settled ? false : advanceLevel();
    if (g.phase === "lost") return false;
    if (g.phase === "paused") return resumeRun();
    var r = interactAt(g);
    if (g.phase === "playing") { NEAR = nearInfo(g); }
    else { NEAR = null; syncWin(g); }
    return r;
  }
  /* 空格：用文件夹（过关浮层上是"继续下一关"；失败后同样无效，见上） */
  function actSpace() {
    var g = G;
    if (!g) return false;
    if (g.phase === "floor-intro") return enterFloor(g);
    if (g.phase === "won") return g.settled ? false : advanceLevel();
    if (g.phase === "lost") return false;
    if (g.phase === "paused") return resumeRun();
    var r = useFile(g);
    if (g.phase === "playing") NEAR = nearInfo(g);
    return r;
  }
  /* P / Esc：暂停 ⇄ 继续（规格 §7.1；失焦也会走这里）。失败/通关后无效。 */
  function actPause() {
    var g = G;
    if (!g) return false;
    if (g.phase === "playing") { g.phase = "paused"; g.player.moving = false; cue("ui-click"); return true; }
    if (g.phase === "paused") return resumeRun();     /* 继续音在 resumeRun 里（那条路也走它） */
    return false;
  }
  /* 鼠标：失败后点画面 = 重试本关；过关浮层上点画面 = 继续下一关。
     加这一条是因为"失败后 E/空格全无效"是规格契约，键盘就不能再当重试键了。 */
  function onClick() {
    var g = G;
    if (!g) return;
    if (g.phase === "lost") retryRun();
    else if (g.phase === "won" && !g.settled) advanceLevel();
    else if (g.phase === "floor-intro") enterFloor(g);
  }
  /* 视角档位（纯渲染层，随时可切，不影响任何判定）。finish=true 时立刻重画一帧。 */
  function setView(m) {
    var was = viewMode;
    if (VIEW_DEF[m]) viewMode = m;
    if (G && ctx) { camFollow(G); render(); drawOverlay(); }
    if (viewMode !== was) cue("ui-tab");     /* 切档位（切换视角）= 换页音 */
    return viewMode;
  }
  /* 画布点击：先看是不是点在视角控件上（是就换档，**不**触发"点画面重试/继续"），
     其余位置照旧走 onClick —— 老行为一个字节没变。 */
  function onCanvasClick(e) {
    if (e && cv && cv.getBoundingClientRect) {
      var r = cv.getBoundingClientRect();
      var x = (e.clientX - r.left) * (W / (r.width || W));
      var y = (e.clientY - r.top) * (H / (r.height || H));
      if (viewCtlHit(x, y)) { setView(nextView()); return; }
    }
    onClick();
  }

  /* ── 浮层（规格 §7.7 的文案原文 + 本地结算数字）── */
  function panel(pw, ph) {
    var px = (W - pw) / 2, py = (H - ph) / 2;
    /* 准备页场景图（art/clockout/office.png，1672×941 = 画布比例）：垫在浮层底下
       当底图，再压原来的暗幕 —— 缺图时这一层直接不画，暗幕照旧。 */
    var scene = ART.bg.office;
    if (artReady(scene)) ctx.drawImage(scene.img, 0, 0, W, H);
    ctx.fillStyle = "rgba(11,10,19,.78)"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = COL.panel; roundRect(ctx, px, py, pw, ph, 8); ctx.fill();
    ctx.strokeStyle = "#c9a24a"; ctx.lineWidth = 2; roundRect(ctx, px, py, pw, ph, 8); ctx.stroke();
    return py;
  }
  function row(k, v, y, pw) {
    txt(k, W / 2 - pw / 2 + 22, y, 13, "#5b5646", "left", "normal");
    txt(v, W / 2 + pw / 2 - 22, y, 13.5, COL.ink, "right");
  }
  function divider(y, pw) {
    ctx.strokeStyle = "rgba(32,34,44,.22)"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W / 2 - pw / 2 + 22, y); ctx.lineTo(W / 2 + pw / 2 - 22, y);
    ctx.stroke();
  }
  function money(net) {
    return (net > 0 ? "+" : "") + "¥" + net;
  }
  function moneyColor(net) { return net > 0 ? "#1c7a4a" : (net < 0 ? "#b03a4a" : COL.ink); }

  function drawOverlay() {
    var g = G;
    if (!g) return;
    var i, y, pw;

    if (g.phase === "floor-intro") {
      pw = 460; y = panel(pw, 260);
      txt("地狱模式 · 第 " + g.level + " 关 · 二层", W / 2, y + 34, 12.5, "#8a836f", "center", "normal");
      txt(g.map.name, W / 2, y + 66, 24, COL.ink, "center");
      txt(g.message, W / 2, y + 108, 12.5, "#5b5646", "center", "normal");
      row("剩余时间", Math.ceil(g.time) + " 秒（两层共用）", y + 142, pw);
      row("本层巡查", (g.npcs.length - 1) + " 人", y + 166, pw);
      txt("【空格 / E】进入第二层 →", W / 2, y + 218, 15, "#1c7a4a", "center");
      return;
    }
    if (g.phase === "paused") {
      pw = 420; y = panel(pw, 180);
      txt("深呼吸，先观察一下。", W / 2, y + 40, 13, "#8a836f", "center", "normal");
      txt("行动暂停", W / 2, y + 76, 24, COL.ink, "center");
      txt("老板也暂时按下了暂停键。", W / 2, y + 110, 13, "#5b5646", "center", "normal");
      txt("【P / Esc】继续下班", W / 2, y + 146, 14, "#1c7a4a", "center");
      return;
    }
    if (g.settled && g.result) {                    /* 结算：被抓 / 超时 / 三关全通 / 调试 */
      var r = g.result, last_ = r.cleared === r.levels;
      /* 面板高度**按行数算**（"全程零被发现"会多一行），"净收益"与底部提示各有固定槽位。
         ⚠ 上一版高度写死 344、底部提示写死 y+322，而"净收益"随行数漂到 y+334 ——
         两行必然叠在一起（子代理用 debug.artFail(true) 做的 A/B 也复现了，与素材无关）。 */
      var rows = 5 + (r.ghostScore ? 1 : 0);
      var ph = Math.min(HUD.setHead + rows * HUD.setRowH + HUD.setDiv * 2 + HUD.setRowH * 2
                        + 6 + HUD.setNetGap + HUD.setFootPad, H - HUD.pad * 2);
      pw = HUD.setW; y = panel(pw, ph);
      txt(last_ ? "三关全通 · 下班成功" : "第 " + g.level + " 关 · 下班任务失败",
          W / 2, y + 28, 12.5, "#8a836f", "center", "normal");
      txt(last_ ? "终于，自由了。" : (g.caughtBy ? "被发现了，下班失败。" : "这会，真不止五分钟。"),
          W / 2, y + 58, 21, COL.ink, "center");
      txt(g.message, W / 2, y + 88, 12, "#5b5646", "center", "normal");
      if (!last_ && g.floors > 1) txt("本关将从第一层重试，已通关的关卡保留。", W / 2, y + 108, 12, "#8a836f", "center", "normal");
      i = y + HUD.setHead;
      divider(i, pw); i += HUD.setDiv;
      row("通关", r.cleared + " / " + r.levels + " 关", i, pw); i += HUD.setRowH;
      row("被抓次数", String(r.caught), i, pw); i += HUD.setRowH;
      row("三关总用时", r.timeUsed + " 秒", i, pw); i += HUD.setRowH;
      row("剩余时间", r.timeLeft + " 秒", i, pw); i += HUD.setRowH;
      row("关卡分 + 省时分", r.levelScore + " + " + r.timeScore, i, pw); i += HUD.setRowH;
      if (r.ghostScore) { row("全程零被发现", "+" + r.ghostScore, i, pw); i += HUD.setRowH; }
      divider(i, pw); i += HUD.setDiv;
      row("总分 / 评级", r.score + " · " + r.grade, i, pw); i += HUD.setRowH;
      row("赔付 − 入场", "¥" + r.pay + " − ¥" + r.entry, i, pw); i += HUD.setRowH + 6;
      txt("净收益  " + money(r.net), W / 2, i, 20, moneyColor(r.net), "center");
      /* 底部提示钉在面板**底边**上，与"净收益"恒定隔 40px —— 行数怎么变都不撞。 */
      txt(r.practice ? "练手局 · 不结算财富 · 点击画面重试第 " + g.level + " 关"
                     : "点击画面重试第 " + g.level + " 关",
          W / 2, y + ph - HUD.setFootPad, 12.5, "#8a836f", "center", "normal");
      return;
    }
    if (g.phase === "won" || g.phase === "lost") {  /* 过关（还有下一关） */
      pw = 420; y = panel(pw, 200);
      txt("第 " + g.level + " 关完成 · " + g.map.name, W / 2, y + 34, 12.5, "#8a836f", "center", "normal");
      txt("这一关，顺利脱身。", W / 2, y + 66, 21, COL.ink, "center");
      row("本关用时", Math.round(g.elapsed) + " 秒", y + 108, pw);
      row("剩余时间", Math.round(g.time) + " 秒", y + 132, pw);
      txt("【空格 / E】继续第 " + (g.level + 1) + " 关 →", W / 2, y + 168, 14, "#1c7a4a", "center");
    }
  }

  /* ═════════════════ 11. 输入 ═════════════════ */
  var KEYMAP = {
    ArrowLeft:"left", a:"left", A:"left",
    ArrowRight:"right", d:"right", D:"right",
    ArrowUp:"up", w:"up", W:"up",
    ArrowDown:"down", s:"down", S:"down"
  };
  function onKeyDown(e) {
    var g = G; if (!g) return;
    var k = KEYMAP[e.key];
    if (k) { keys[k] = true; if (e.preventDefault) e.preventDefault(); return; }
    var key = e.key;
    if (key === " " || key === "Spacebar" || e.code === "Space") {
      if (e.preventDefault) e.preventDefault();
      actSpace(); return;
    }
    if (key === "e" || key === "E" || key === "Enter") {
      if (e.preventDefault) e.preventDefault();
      actInteract(); return;
    }
    if (key === "p" || key === "P" || key === "Escape" || key === "Esc") {
      if (e.preventDefault) e.preventDefault();
      actPause(); return;
    }
  }
  function onKeyUp(e) { var k = KEYMAP[e.key]; if (k) keys[k] = false; }

  function frame(ts) {
    if (!running) return;
    rafId = root.requestAnimationFrame(frame);
    if (!lastTs) lastTs = ts;
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    /* frozen 是**只给调试钩子**的冻结：停掉时间推进但互动照常可用（无头验收靠它做确定性命中），
       与 paused（玩家按 P / Esc）不是一回事。 */
    if (G && !G.frozen) step(dt);
    render();
    drawOverlay();
  }

  /* ═════════════════ 12. start / dispose / isBusy ═════════════════ */
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
    warm();                                  /* 先把音效素材的异步探测排上队（见 warm 的说明） */
    G = startSession(opts0);
    gradDark = gradLight = gradFacade = null;   /* 渐变是建在 ctx 上的，换一局要重来 */
    fitCanvas();
    doc.addEventListener("keydown", onKeyDown, false);
    doc.addEventListener("keyup", onKeyUp, false);
    if (cv.addEventListener) cv.addEventListener("click", onCanvasClick, false);
    running = true; lastTs = 0;
    rafId = root.requestAnimationFrame(frame);
    /* 环境音：进玩法开办公室环境音（audio/amb/amb-office.mp3，缺失时 amb 层自己静默）。
       退出/收工在 dispose() 里 amb(null) 停掉 —— 必须成对，别把它留在主游戏里响。 */
    amb("office");
    return true;
  }
  function dispose() {
    running = false;
    amb(null);                                   /* 收工：停环境音（唯一停法） */
    if (rafId) { try { root.cancelAnimationFrame(rafId); } catch (e) {} rafId = 0; }
    if (doc) {
      doc.removeEventListener("keydown", onKeyDown, false);
      doc.removeEventListener("keyup", onKeyUp, false);
    }
    if (cv && cv.removeEventListener) cv.removeEventListener("click", onCanvasClick, false);
    if (hostEl) hostEl.innerHTML = "";
    cv = null; ctx = null; G = null; hostEl = null; opts0 = null; NEAR = null;
    gradDark = gradLight = gradFacade = null;
    keys.left = keys.right = keys.up = keys.down = false;
    return true;
  }
  function isBusy() { return running; }

  /* ═════════════════ 13. 调试钩子（浏览器验收脚本的接口，签名不变） ═════════════════ */
  function legacyStatus(g) {
    if (g.phase === "lost") return g.settled ? "result" : "caught";
    if (g.phase === "won") return g.level >= LEVELS.length ? "result" : "levelclear";
    return "play";
  }
  debug.state = function () {
    if (!G) return null;
    var g = G, mate = coworkerOf(g);
    return {
      /* ── 规格状态机 ── */
      phase: g.phase,
      status: legacyStatus(g),              /* V1 相位名（play/caught/levelclear/result）兼容 */
      paused: g.phase === "paused", frozen: !!g.frozen, settled: !!g.settled,
      mode: g.mode, level: g.level, levelName: g.map.name, levels: LEVELS.length,
      floor: g.floor, floors: g.floors, mapId: g.mapId,
      /* V2 三关的出口都是电梯（要呼叫、要等）—— 兼容键恒 true */
      elevator: true,
      /* ── 进度与经济 ── */
      cleared: g.clearedCount || 0, caught: g.caughtCount || 0, ghost: !!g.ghost,
      timeLeft: +g.time.toFixed(2), timeUsed: +totalTime(g).toFixed(2),
      savedTime: +(g.savedTime || 0).toFixed(2),
      /* ── 玩家 ── */
      px: +g.player.x.toFixed(1), py: +g.player.y.toFixed(1),
      suspicion: +g.suspicion.toFixed(1),
      hasFolder: !!g.file, folderTaken: !!g.fileTaken,
      disguised: g.cover > 0, disguiseLeft: +g.cover.toFixed(2), hidden: !!g.hidden,
      /* ── 机关 ── */
      coffeeActive: g.lure > 0, coffeeCd: 0, lureActive: g.lure > 0,
      bossActive: bossAwake(g), elev: g.lift, liftTimer: +g.liftTimer.toFixed(2),
      /* ── 世界 ── */
      near: NEAR ? { id:NEAR.id, kind:NEAR.kind, label:NEAR.label, key:NEAR.key,
                     x:+NEAR.x.toFixed(1), y:+NEAR.y.toFixed(1) } : null,
      patrols: g.npcs.length - (mate ? 1 : 0), npcs: g.npcs.length,
      lured: g.lure > 0 ? 1 : 0,
      seenBy: g.caughtBy || null,
      result: g.result, clear: g.clear, message: g.message,
      toast: g.toast, eventText: g.eventText, seed: g.seed, seed0: g.seed0,
      worldW: WORLD_W, worldH: WORLD_H,
      canvasW: W, canvasH: H,
      view: viewMode,                       /* 当前视角档位：flat | tilt | deep */
      camX: +(g.view ? g.view.x : 0).toFixed(1), camY: +(g.view ? g.view.y : 0).toFixed(1),
      viewW: +(g.view ? g.view.w : 0).toFixed(1), viewH: +(g.view ? g.view.h : 0).toFixed(1)
    };
  };
  debug.level = function () {
    if (!G) return null;
    var g = G, m = g.map;
    return { id:m.id, name:m.name, caption:m.caption, art:m.art, mapId:m.id, map:m,
             index:(g.level + g.floor - 2) % MAPS.length, floor:g.floor, floors:g.floors,
             w:WORLD_W, h:WORLD_H,
             gridW:Math.round(WORLD_W / GRID_STEP), gridH:Math.round(WORLD_H / GRID_STEP),
             bounds:m.bounds, walls:m.walls, points:m.points, spawns:m.spawns };
  };
  debug.patrols = function () {
    if (!G) return [];
    var g = G, out = [];
    for (var i = 0; i < g.npcs.length; i++) {
      var n = g.npcs[i];
      out.push({ i:i, id:n.id, x:+n.x.toFixed(1), y:+n.y.toFixed(1),
                 angle:+(n.angle * 180 / Math.PI).toFixed(1), mode:"walk",
                 sees:!!n.sees, lured:!!(n.id === "supervisor" && g.lure > 0),
                 active:isDrawable(g, n), pause:+n.pause.toFixed(2),
                 range:Math.round(n.range), halfFov:+(n.fov / 2 * 180 / Math.PI).toFixed(1),
                 route:n.route ? n.route.length : 0, target:n.target });
    }
    return out;
  };
  debug.key = function (name, down) { if (name in keys) keys[name] = !!down; };
  debug.keyDown = function (k) { onKeyDown({ key:k, code:(k === " " ? "Space" : ""), preventDefault:function () {} }); };
  debug.tick = function (ms) {
    var n = Math.max(1, Math.round((ms || 16) / 16)), i;
    for (i = 0; i < n; i++) step(0.016);
    if (G) syncWin(G);
    render(); drawOverlay();
  };
  debug.freeze = function (on) { if (G) G.frozen = (on !== false); };
  debug.unfreeze = function () { if (G) G.frozen = false; };
  debug.pause = function () { return actPause(); };
  debug.resume = function () { return resumeRun(); };
  debug.restart = function (opts) { if (opts) opts0 = opts; restartRun(); return G; };
  debug.retry = function () { return retryRun(); };
  debug.interact = function () { return actInteract(); };
  /* ⚠ useFolder 是**纯粹的"按空格用文件夹"**（旧语义），不做上下文判定；
     要模拟玩家按空格请用 keyDown(" ")。 */
  debug.useFolder = function () {
    var g = G;
    if (!g) return false;
    var r = useFile(g);
    if (g.phase === "playing") NEAR = nearInfo(g);
    return r;
  };
  /* 世界像素瞬移（无头验收要精确站到"咖啡机旁 / 电梯旁 / 某个巡逻者面前"）。
     ⚠ 失败后整局冻结，seek 不再移动（否则就破坏了"状态字节级不变"）。 */
  debug.seek = function (x, y) {
    if (!G) return null;
    var g = G;
    if (g.phase === "lost" || g.phase === "won") {
      return { x:+g.player.x.toFixed(1), y:+g.player.y.toFixed(1), frozen:true, near:NEAR ? NEAR.id : null };
    }
    g.player.x = x; g.player.y = y;
    NEAR = nearInfo(g);
    return { x:+g.player.x.toFixed(1), y:+g.player.y.toFixed(1), near:NEAR ? NEAR.id : null };
  };
  debug.levelDone = function () {
    var g = G;
    if (!g) return null;
    if (g.phase === "playing" || g.phase === "paused" || g.phase === "floor-intro") {
      g.phase = "won"; g.player.moving = false;
      g.message = "电梯门关上的那一刻，世界安静了。";
      syncWin(g);
    }
    render(); drawOverlay();
    return g.phase;
  };
  debug.nextLevel = function () { var ok = advanceLevel(); render(); drawOverlay(); return ok; };
  debug.finishNow = function () {
    var r = G ? endRun(G, "debug") : null;
    render(); drawOverlay();
    return r;
  };
  debug.setTime = function (sec) { if (G && G.phase !== "lost") G.time = sec; };
  debug.giveFolder = function () {
    if (!G) return null;
    G.file = true; G.fileTaken = true;
    if (G.phase === "playing") NEAR = nearInfo(G);
    return true;
  };
  /* 把某个 NPC 摆到世界坐标 (x,y)、朝向 deg（0=向右）。
     ⚠ 摆老板会顺手把 bossDelay 清零：否则它在普通模式前 12 秒**不动、不绘制、抓不到人**，
       无头验收会以为"摆了个人却怎么都看不见我"。 */
  debug.placePatrol = function (i, x, y, deg) {
    if (!G || !G.npcs[i]) return null;
    var g = G, n = g.npcs[i];
    if (g.phase === "lost") return null;
    n.x = x; n.y = y; n.route = []; n.target = 0; n.pause = 0;
    n.angle = (deg === undefined ? 0 : deg) * Math.PI / 180;
    if (n.id === "supervisor") g.lure = 0;        /* 被引诱的主管只认咖啡机，摆位会被覆盖 */
    if (n.id === "boss") { g.config.bossDelay = 0; g.eventAt = g.elapsed; }
    NEAR = nearInfo(g);
    return { i:i, id:n.id, x:+n.x.toFixed(1), y:+n.y.toFixed(1), deg:deg === undefined ? 0 : deg };
  };
  /* 全部致盲（视距归零）：验电梯/换层这类流程时先把潜行层隔离掉，
     否则"等待电梯的那几秒被抓"会把结论污染成"电梯坏了"。 */
  debug.blindAll = function (on) {
    if (!G) return null;
    for (var i = 0; i < G.npcs.length; i++) {
      var n = G.npcs[i];
      n.range = (on === false) ? n.range0 : 0;
    }
    return G.npcs.length;
  };
  debug.lifecycle = function () {
    return { running:running, busy:isBusy(), hasCanvas:!!cv,
             phase:G ? G.phase : null, raf:rafId > 0, frozen:G ? !!G.frozen : false };
  };

  /* ── 新增（只增不改，上面 22 个签名一个没动）───────────────────────────── */
  /* 碰撞描边：用细线把所有 map.walls 矩形描出来 —— 铺上背景插图后核对
     "看到的家具"与"实际的碰撞"是否对齐。不带参数 = 开关切换；默认关。 */
  debug.collisionOverlay = function (on) {
    collideOverlay = (on === undefined) ? !collideOverlay : !!on;
    render(); drawOverlay();
    return collideOverlay;
  };
  /* 贴图加载状态（诊断用）：每张图的 ok / failed / 解出的宽高 + 当前关背景是否就绪。 */
  debug.art = function () {
    var out = { dir:ART_DIR, total:ART.total, loaded:ART.loaded, failed:ART.failed,
                failAll:!!ART.failAll, collisionOverlay:!!collideOverlay,
                currentArt:(G && G.map) ? (G.map.art || null) : null,
                bgReady:G ? bgReady(G) : false, slots:[] };
    for (var i = 0; i < ART.slots.length; i++) {
      var s = ART.slots[i], im = s.img;
      out.slots.push({ key:s.key, src:s.src, kind:s.kind, size:s.size, dy:s.dy,
                       ok:!!s.ok, failed:!!s.failed, ready:artReady(s),
                       w:im ? (im.naturalWidth || im.width || 0) : 0,
                       h:im ? (im.naturalHeight || im.height || 0) : 0 });
    }
    return out;
  };
  /* 阴性对照用总闸：on=true 时所有贴图都按"不可用"渲染（程序化回退路径），
     但**不改**各 slot 的真实加载状态 —— 关掉就恢复，方便同一局里前后对比。 */
  debug.artFail = function (on) {
    ART.failAll = !!on;
    render(); drawOverlay();
    return ART.failAll;
  };
  /* 视角档位：view("flat"|"tilt"|"deep") 换档并返回当前档；不带参数 = 只读。
     ⚠ 纯渲染层开关：玩法状态（g）一个字段都不改，只是下一帧换一种画法。 */
  debug.view = function (m) {
    if (m === undefined || m === null || m === "") return viewMode;
    return setView(m);
  };

  /* ═════════════════ 导出 ═════════════════ */
  root.Clockout = {
    version: "2.0.0",
    start: start,
    isBusy: isBusy,
    dispose: dispose,
    TUNE: TUNE,
    MODES: MODES,
    LEVELS: LEVELS,
    MAPS: MAPS,
    WORLD: { W: WORLD_W, H: WORLD_H },
    rules: rules,
    debug: debug
  };

})(window);
