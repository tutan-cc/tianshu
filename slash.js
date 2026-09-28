/* ═══════════════════════════════════════════════════════════════════════════
   slash.js — 「一刀两断」· 街机切果
   自包含 IIFE，暴露全局 window.Slash；ES5 风格，不使用 ES module，
   不依赖页面内变量（只读 opts / 挂载 hostEl）。

   一句话规格：夜市摊上的切果机 —— 挥刀切开满天水果，别碰炸弹。

   对外 API（规格）：
     window.Slash.start(hostEl, opts) -> boolean
       opts:{ cash:()=>number, phys:()=>number, intel:()=>number,
              onSettle:(net,info)=>{}, onFinish:(sum)=>{},
              practice:boolean, mode:"classic|arcade|zen", diff:0|1|2 }
       practice=true → **练手局**：不收入场费、不结算奖金（与开窗的练手局同款约定）
     window.Slash.isBusy(), dispose()
     window.Slash.debug = { state(), items(), swipe(x,y), release(), startRun(m,d),
                            tick(ms), pause(), resume(), finishNow(), lifecycle() }

   附加（单测用，不属于规格）：window.Slash.rules = { makeRng, spawnWave, segHit,
     fastEnough, cutScore, payoutOf, simulateGame, MODES, DIFFS, FRUITS, TUNE }
     —— 纯函数、无 DOM，可在 vm 里整局自动跑（simulateGame 不开浏览器就能出分数分布）。

   ── 设计要点（为什么这么做，改之前先读）──────────────────────────────────
   1) **三模式共用一套引擎**，模式只是配置（计时 vs 命数、有无炸弹/特殊果）。
      加模式 = 往 MODES 里加一行，不要复制粘贴一套逻辑。
   2) **"太慢切不开"是核心手感**：判定同时要求 轨迹∩水果 且 滑动速度 ≥ 阈值。
      去掉速度门槛就退化成"点一下就切"，整个玩法的手感立刻没了。
   3) **经济不变量**（tests/slash.test.cjs 用 simulateGame 蒙特卡洛断言）：
        · 乱切必亏：低命中、无连击的长期期望 < 0
        · 手熟能赚但不失控：高命中 + 连击的期望 > 0 且封顶
      改 TUNE.PAYOUT / DIFFS / 计分权重后必须重跑那条测试。
   4) **水果按"皮壳风格 + 果肉风格"两张配方表复用绘制例程**：10 种水果若各写
      「整颗 + 切开」两个函数就是 20 个函数；现在皮壳 8 种风格、果肉 6 种风格，
      新水果只是往 FRUITS 里加一行配置。
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";
  if (!root || root.Slash) return;

  var doc = root.document;

  /* ═══════════════ 1. 调参区（改手感只动这里） ═══════════════ */

  var TUNE = {
    ENTRY: 20,               // 入场费（与刮刮乐、开窗小料同价）
    GRAVITY: 1500,           // px/s²
    SLASH_MIN_SPEED: 340,    // px/s —— 低于此速切不开（"动作太慢"）
    BLADE_R: 22,             // 刀刃判定半径（体魄加宽）
    BLADE_R_PER_PHY: 1.6,    // 每点体魄 +1.6px
    BLADE_R_MAX: 46,
    CRIT_ZONE: 0.40,         // 命中点距中心 < r×0.40 算"正中"
    CRIT_SPEED: 820,         // 且刀速 ≥ 此值 → 暴击 +10
    CRIT_SCORE: 10,
    COMBO_MIN: 3,            // 一刀 ≥3 个算连击
    COMBO_SCORE: 3,          // 连击额外分
    /* 「定身」：按空格把时间流速压下来，次数由智慧给 */
    FIX_BASE: 1, FIX_PER_INT: 25, FIX_MAX: 3, FIX_MS: 3000, FIX_SCALE: 0.45,
    /* 特殊果（仅街机） */
    FREEZE_MS: 5000, FREEZE_SCALE: 0.45,
    DOUBLE_MS: 10000,
    FRENZY_MS: 10000, FRENZY_GAP: 0.45,
    /* 派彩阶梯：分数 → 奖金，**每个模式一套**。
       为什么必须分模式：三模式的分数尺度差一个数量级（同样 55% 命中率，实测
       经典 ≈10 分、街机 ≈220 分、禅意 ≈404 分 —— 经典有命数会提前结束，计时模式
       则是一路累积）。用一套阶梯的结果是：禅意变刷钱机（+¥380/局），经典永远亏。
       定标目标（tests/slash.test.cjs 的经济不变量按这四条断言）：
         命中率 25% → 期望 ≈ −20（几乎全亏掉入场费）
         命中率 55% → 期望 ≈ 0（打平区）
         命中率 85% → 期望 +60…+130（手熟明显赚）
         命中率 95% → 期望 ≤ +300（封顶，不失控） */
    PAYOUT: {
      classic: [
        { min: 0, cash: 0 }, { min: 3, cash: 2 }, { min: 6, cash: 8 }, { min: 10, cash: 18 },
        { min: 16, cash: 32 }, { min: 24, cash: 55 }, { min: 34, cash: 85 }, { min: 48, cash: 120 },
        { min: 70, cash: 165 }, { min: 110, cash: 220 }, { min: 170, cash: 280 }
      ],
      arcade: [
        { min: 0, cash: 0 }, { min: 40, cash: 2 }, { min: 120, cash: 8 }, { min: 220, cash: 20 },
        { min: 320, cash: 45 }, { min: 440, cash: 90 }, { min: 560, cash: 140 }, { min: 700, cash: 195 },
        { min: 900, cash: 260 }, { min: 1150, cash: 330 }
      ],
      zen: [
        { min: 0, cash: 0 }, { min: 140, cash: 2 }, { min: 280, cash: 8 }, { min: 380, cash: 18 },
        { min: 500, cash: 35 }, { min: 650, cash: 60 }, { min: 800, cash: 95 }, { min: 990, cash: 140 },
        { min: 1200, cash: 200 }, { min: 1500, cash: 270 }
      ]
    },
    /* 成就门槛（index.html 的成就文案从这儿读） */
    ACHV_SINGLE: 5,          // 【一刀两断】单刀切 ≥5 个
    ACHV_SCORE: 300,         // 【刀客】单局 ≥300 分
    WAVE_MAX: 4              // 一波最多几个
  };

  var VIEW = { W: 900, H: 560 };        // 逻辑尺寸
  var GROUND = VIEW.H + 40;             // 掉出画面的判定线

  /* 三模式：差异只有 胜负条件 / 炸弹 / 特殊果 / 时长 */
  var MODES = [
    { id: "classic", n: "经典",     lives: 3, ms: 0,     bombs: true,  special: false, desc: "3 条命 · 碰到炸弹即结束" },
    { id: "arcade",  n: "街机 60秒", lives: 0, ms: 60000, bombs: true,  special: true,  desc: "特殊香蕉 · 炸弹扣 10 分" },
    { id: "zen",     n: "禅意 90秒", lives: 0, ms: 90000, bombs: false, special: false, desc: "没有炸弹 · 静心切果" }
  ];

  /* 三难度：抛出节奏 / 同屏上限 / 炸弹比例 / 初速 */
  var DIFFS = [
    { id: "easy",   n: "简单", gapMin: 0.95, gapMax: 1.55, aliveMax: 4, bombP: 0.05, specialP: 0.07, vMin: 830,  vMax: 960 },
    { id: "normal", n: "普通", gapMin: 0.68, gapMax: 1.12, aliveMax: 5, bombP: 0.10, specialP: 0.08, vMin: 900,  vMax: 1060 },
    { id: "hard",   n: "困难", gapMin: 0.44, gapMax: 0.80, aliveMax: 7, bombP: 0.16, specialP: 0.09, vMin: 980,  vMax: 1160 }
  ];

  /* 10 种水果：皮壳风格 8 种、果肉风格 6 种 —— 绘制例程按风格复用（见文件头 4） */
  var FRUITS = [
    { id: "wm", n: "西瓜", rx: 54, ry: 50, skin: { s: "stripes", c1: "#4faa3c", c2: "#1a5a1e", mark: "#123f16" },
      flesh: { s: "seeds", c1: "#ff5a63", c2: "#d81b2c", rim: "#a7dc72", pith: "#f3f6d6", seed: "#1c120b", n: 9 } },
    { id: "or", n: "橙子", rx: 42, ry: 42, skin: { s: "dimple", c1: "#ffb454", c2: "#e07a10", mark: "#c8670a" },
      flesh: { s: "wedges", c1: "#ffc45a", c2: "#ff9a1f", pith: "#fff0cf", rim: "#f0870e", n: 8 } },
    { id: "ap", n: "苹果", rx: 42, ry: 44, skin: { s: "smooth", c1: "#ff7a6a", c2: "#c0181f", leaf: true },
      flesh: { s: "core", c1: "#fffdf2", c2: "#f3dfa0", pit: "#caa865", seed: "#4a2a12" } },
    { id: "pa", n: "菠萝", rx: 40, ry: 50, skin: { s: "grid", c1: "#f0c04a", c2: "#a4690f", mark: "#6a3806", leaf: true },
      flesh: { s: "plain", c1: "#ffe98a", c2: "#f0b425", eyes: true } },
    { id: "ba", n: "香蕉", rx: 54, ry: 26, skin: { s: "banana", c1: "#ffe45a", c2: "#d8a406" },
      flesh: { s: "plain", c1: "#fffdf0", c2: "#fff0b8" } },
    { id: "st", n: "草莓", rx: 38, ry: 42, skin: { s: "seedsOut", c1: "#ff6a78", c2: "#c8102a", mark: "#ffe27c", calyx: true },
      flesh: { s: "rays", c1: "#fff2f0", c2: "#ff8f9e", core: "#fff8f6", seed: "#ffd34a", n: 14 } },
    { id: "ki", n: "猕猴桃", rx: 46, ry: 38, skin: { s: "fuzz", c1: "#a97c4e", c2: "#6b4325" },
      flesh: { s: "rays", c1: "#d6f57a", c2: "#7fc42e", core: "#fbffe6", seed: "#15100a", n: 22 } },
    { id: "co", n: "椰子", rx: 46, ry: 46, skin: { s: "fiber", c1: "#8a5f38", c2: "#3a2210" },
      flesh: { s: "rings", c1: "#fffefa", c2: "#e3d8bf", water: "#dff2f8" } },
    { id: "pe", n: "桃子", rx: 46, ry: 46, skin: { s: "smooth", c1: "#ffc48a", c2: "#e87e56", blush: true, leaf: true },
      flesh: { s: "core", c1: "#ffe0a8", c2: "#f5a44c", pit: "#8a4416" } },
    { id: "le", n: "柠檬", rx: 46, ry: 34, skin: { s: "dimple", c1: "#fff08a", c2: "#d8b400", mark: "#b89a00" },
      flesh: { s: "wedges", c1: "#fffbd0", c2: "#ffe23a", pith: "#fffbe8", rim: "#efc81a", n: 8 } }
  ];
  var FRUIT_BY_ID = {};
  FRUITS.forEach(function (f) { FRUIT_BY_ID[f.id] = f; });

  /* 特殊果（仅街机出现）：冰冻 / 双倍 / 狂热 —— 用香蕉的形状 + 各自配色 */
  var SPECIALS = [
    { id: "freeze", n: "冰冻", ms: TUNE.FREEZE_MS,  c1: "#8fe0ff", c2: "#2a86c8" },
    { id: "double", n: "双倍", ms: TUNE.DOUBLE_MS,  c1: "#ffe98a", c2: "#c07e00" },
    { id: "frenzy", n: "狂热", ms: TUNE.FRENZY_MS,  c1: "#ff9a6a", c2: "#b01e0a" }
  ];
  var SPECIAL_BY_ID = {};
  SPECIALS.forEach(function (s) { SPECIAL_BY_ID[s.id] = s; });

  /* ═══════════════ 2. 纯规则（无 DOM，可整局自动跑） ═══════════════ */

  var imul = Math.imul || function (a, b) {
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff, bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return (al * bl + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
  };
  function makeRng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = imul(a ^ (a >>> 15), 1 | a);
      t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
  function rr(rng, a, b) { return a + rng() * (b - a); }

  /**
   * 抛一波。返回本波要生成的东西（相对时间 0 的初始状态）。
   * mode/diff 决定数量、炸弹与特殊果的比例 —— 三模式的差异都在这里体现。
   */
  function spawnWave(rng, mode, diff) {
    var n = 1 + Math.floor(rng() * TUNE.WAVE_MAX);
    var out = [], i;
    for (i = 0; i < n; i++) {
      var type = "fruit", kind = null;
      if (mode.bombs && rng() < diff.bombP) type = "bomb";
      else if (mode.special && rng() < diff.specialP) { type = "special"; kind = pick(rng, SPECIALS).id; }
      else kind = pick(rng, FRUITS).id;
      var x = rr(rng, VIEW.W * 0.14, VIEW.W * 0.86);
      /* 向上抛：顶点大约在画面上半部，落回来要 ~1.4–1.9 秒（够挥两刀） */
      var vy = -rr(rng, diff.vMin, diff.vMax);
      var vx = (x < VIEW.W / 2 ? 1 : -1) * rr(rng, 20, 90);
      out.push({ type: type, kind: kind, x: x, y: GROUND - 30, vx: vx, vy: vy, rot: rr(rng, 0, 6.283), spin: rr(rng, -1.6, 1.6) });
    }
    return out;
  }

  /** 点到线段距离的平方 */
  function segPointD2(ax, ay, bx, by, px, py) {
    var dx = bx - ax, dy = by - ay;
    var l2 = dx * dx + dy * dy;
    if (l2 < 1e-6) { var ux = px - ax, uy = py - ay; return ux * ux + uy * uy; }
    var t = ((px - ax) * dx + (py - ay) * dy) / l2;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var qx = ax + t * dx, qy = ay + t * dy;
    var ex = px - qx, ey = py - qy;
    return ex * ex + ey * ey;
  }

  /**
   * 刀光线段是否切到某个椭圆。
   * 做法：把线段与椭圆一起按 (rx,ry) 归一化成单位圆，再比距离 —— 比逐点采样快且准。
   */
  function segHit(seg, e, bladeR) {
    var rx = e.rx + (bladeR || 0), ry = e.ry + (bladeR || 0);
    if (rx <= 0 || ry <= 0) return false;
    var ax = (seg.x1 - e.x) / rx, ay = (seg.y1 - e.y) / ry;
    var bx = (seg.x2 - e.x) / rx, by = (seg.y2 - e.y) / ry;
    return segPointD2(ax, ay, bx, by, 0, 0) <= 1;
  }

  /** 刀速够不够（"动作太慢切不开"） */
  function fastEnough(seg, dtMs, minSpeed) {
    if (dtMs <= 0) return false;
    var dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
    var speed = Math.sqrt(dx * dx + dy * dy) / (dtMs / 1000);
    return speed >= (minSpeed === undefined ? TUNE.SLASH_MIN_SPEED : minSpeed);
  }

  /** 命中点是否算"正中"（决定暴击） */
  function isCrit(e, hx, hy, speed) {
    var dx = (hx - e.x) / (e.rx || 1), dy = (hy - e.y) / (e.ry || 1);
    return Math.sqrt(dx * dx + dy * dy) <= TUNE.CRIT_ZONE && speed >= TUNE.CRIT_SPEED;
  }

  /** 单个水果的分（不含连击/暴击加成，那两项由调用方叠加） */
  function baseScore() { return 1; }

  /** 一刀计分：n 个水果 + 是否暴击 + 是否连击 */
  function cutScore(n, critCount, doubled) {
    var s = n * baseScore() + (critCount || 0) * TUNE.CRIT_SCORE;
    if (n >= TUNE.COMBO_MIN) s += TUNE.COMBO_SCORE;
    if (doubled) s *= 2;
    return s;
  }

  /** 分数 → 奖金（**按模式取阶梯**）。改这里必须重跑经济不变量测试 */
  function payoutOf(score, modeId) {
    var ladder = TUNE.PAYOUT[modeId] || TUNE.PAYOUT.arcade;
    var cash = 0, i;
    for (i = 0; i < ladder.length; i++) if (score >= ladder[i].min) cash = ladder[i].cash;
    return cash;
  }

  /**
   * 整局自动跑（**不开浏览器**就能出分数分布，经济标定靠它）。
   * skill 0..1：0 = 随手乱挥，1 = 刀刀不落。
   * 说明：这是**计分模型**的模拟，不模拟抛物线与像素 —— 标定经济只需要分数分布，
   * 而分数规则的唯一实现在 cutScore/payoutOf 里，所以这里不会与真实玩法脱节。
   */
  function simulateGame(opts) {
    opts = opts || {};
    var rng = makeRng(opts.seed || 1);
    var mode = MODES[opts.mode === undefined ? 1 : opts.mode];
    var diff = DIFFS[opts.diff === undefined ? 1 : opts.diff];
    var skill = opts.skill === undefined ? 0.5 : opts.skill;
    var duration = mode.ms ? mode.ms / 1000 : 120;      // 经典模式按 2 分钟上限估
    var lives = mode.lives;
    var score = 0, cut = 0, missed = 0, bombs = 0, bestCombo = 0, streak = 0, longest = 0, over = false;
    var t = 0, next = 0.5;

    while (t < duration && !over) {
      t += next;
      if (t >= duration) break;
      var gap = rr(rng, diff.gapMin, diff.gapMax);
      next = gap;
      var wave = spawnWave(rng, mode, diff);
      var cutThisSwipe = 0, crits = 0, i;
      for (i = 0; i < wave.length; i++) {
        var it = wave[i];
        if (it.type === "bomb") {
          /* 炸弹：看得越准越不会碰到；手滑的人有概率撞上 */
          if (rng() < (1 - skill) * 0.35) {
            bombs++;
            if (mode.lives) { over = true; break; }     // 经典：立即结束
            score = Math.max(0, score - 10);            // 街机：扣 10 分
          }
          continue;
        }
        if (rng() < skill) {                            // 切中
          cutThisSwipe++;
          cut++;
          streak++;
          if (streak > longest) longest = streak;
          if (rng() < skill * 0.30) crits++;
        } else {                                        // 漏掉
          missed++;
          streak = 0;
          if (mode.lives) { lives--; if (lives <= 0) { over = true; break; } }
        }
      }
      if (cutThisSwipe > 0) {
        score += cutScore(cutThisSwipe, crits, false);
        if (cutThisSwipe > bestCombo) bestCombo = cutThisSwipe;
      }
      /* 特殊果的收益：狂热让果潮更密（等价于缩短间隔），双倍在真实游戏里翻分。
         模型里用"期望加成"表达，避免把渲染层的时序抄一遍。 */
      if (mode.special && rng() < diff.specialP) score += 1;
    }
    return { score: score, cut: cut, missed: missed, bombs: bombs, bestCombo: bestCombo,
             longestStreak: longest, over: over, survived: t };
  }

  /* ═══════════════ 3. 渲染（全部程序化 Canvas） ═══════════════ */

  /** 皮壳：8 种风格 */
  function drawSkin(g, f, r) {
    var sk = f.skin, rx = f.rx, ry = f.ry;
    var grd = g.createRadialGradient(-rx * 0.34, -ry * 0.38, r * 0.12, 0, 0, r * 1.16);
    grd.addColorStop(0, sk.c1); grd.addColorStop(1, sk.c2);

    if (sk.s === "banana") {                       // 香蕉：月牙
      g.beginPath();
      g.moveTo(-rx, -ry * 0.25);
      g.quadraticCurveTo(0, ry * 1.35, rx, -ry * 0.35);
      g.quadraticCurveTo(0, ry * 0.55, -rx, -ry * 0.25);
      g.closePath(); g.fillStyle = grd; g.fill();
      g.strokeStyle = "rgba(120,80,0,.45)"; g.lineWidth = 2; g.stroke();
      g.fillStyle = "rgba(255,255,255,.35)";
      g.beginPath(); g.ellipse(-rx * 0.5, -ry * 0.05, rx * 0.3, ry * 0.12, -0.25, 0, 6.283); g.fill();
      g.fillStyle = "#5a4210";
      g.beginPath(); g.arc(-rx, -ry * 0.25, 3.4, 0, 6.283); g.fill();
      return;
    }
    g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, 6.283); g.fillStyle = grd; g.fill();

    var i;
    if (sk.s === "stripes") {                      // 西瓜：深色条纹
      g.save(); g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, 6.283); g.clip();
      g.strokeStyle = sk.mark; g.lineWidth = rx * 0.13;
      for (i = -2; i <= 2; i++) {
        g.beginPath();
        g.moveTo(i * rx * 0.36, -ry);
        g.quadraticCurveTo(i * rx * 0.5, 0, i * rx * 0.36, ry);
        g.stroke();
      }
      g.restore();
    } else if (sk.s === "dimple") {                // 橙/柠檬：细密毛孔
      g.fillStyle = sk.mark;
      for (i = 0; i < 46; i++) {
        var a = i * 2.399, rr2 = Math.sqrt(i / 46) * 0.94;
        g.globalAlpha = 0.30;
        g.beginPath(); g.arc(Math.cos(a) * rr2 * rx, Math.sin(a) * rr2 * ry, 1.5, 0, 6.283); g.fill();
      }
      g.globalAlpha = 1;
    } else if (sk.s === "grid") {                  // 菠萝：菱形网格 + 眼
      g.save(); g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, 6.283); g.clip();
      g.strokeStyle = sk.mark; g.globalAlpha = 0.55; g.lineWidth = 1.6;
      for (i = -6; i <= 6; i++) {
        g.beginPath(); g.moveTo(i * 12 - 60, -ry); g.lineTo(i * 12 + 60, ry); g.stroke();
        g.beginPath(); g.moveTo(i * 12 + 60, -ry); g.lineTo(i * 12 - 60, ry); g.stroke();
      }
      g.globalAlpha = 1; g.restore();
    } else if (sk.s === "seedsOut") {               // 草莓：外部籽 + 萼
      g.fillStyle = sk.mark;
      for (i = 0; i < 26; i++) {
        var aa = i * 2.399, rr3 = Math.sqrt((i % 13) / 13) * 0.86;
        g.save();
        g.translate(Math.cos(aa) * rr3 * rx, Math.sin(aa) * rr3 * ry);
        g.rotate(aa);
        g.beginPath(); g.ellipse(0, 0, 1.9, 1.1, 0, 0, 6.283); g.fill();
        g.restore();
      }
    } else if (sk.s === "fuzz") {                   // 猕猴桃：绒毛
      g.strokeStyle = "rgba(60,40,20,.5)"; g.lineWidth = 1;
      for (i = 0; i < 64; i++) {
        var a2 = i * 2.399, r4 = Math.sqrt(i / 64) * 0.96;
        var px = Math.cos(a2) * r4 * rx, py = Math.sin(a2) * r4 * ry;
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a2) * 3.4, py + Math.sin(a2) * 3.4); g.stroke();
      }
    } else if (sk.s === "fiber") {                  // 椰子：纤维弧
      g.strokeStyle = "rgba(255,235,200,.28)"; g.lineWidth = 1.6;
      for (i = 0; i < 14; i++) {
        g.beginPath();
        g.ellipse(0, 0, rx * (0.35 + i * 0.045), ry * (0.35 + i * 0.045), i * 0.4, 0, 3.2);
        g.stroke();
      }
    }
    /* 通用高光 */
    g.fillStyle = "rgba(255,255,255,.30)";
    g.beginPath(); g.ellipse(-rx * 0.36, -ry * 0.40, rx * 0.28, ry * 0.17, -0.5, 0, 6.283); g.fill();
    if (sk.blush) {                                  // 桃子的腮红
      var bg = g.createRadialGradient(rx * 0.35, ry * 0.2, 2, rx * 0.35, ry * 0.2, rx * 0.66);
      bg.addColorStop(0, "rgba(232,64,84,.5)"); bg.addColorStop(1, "rgba(232,64,84,0)");
      g.fillStyle = bg; g.beginPath(); g.ellipse(rx * 0.34, ry * 0.2, rx * 0.6, ry * 0.6, 0, 0, 6.283); g.fill();
    }
    if (sk.leaf) {                                   // 叶子/冠
      g.fillStyle = "#4fae2e";
      g.beginPath(); g.ellipse(rx * 0.2, -ry * 0.92, rx * 0.26, ry * 0.14, -0.7, 0, 6.283); g.fill();
      g.strokeStyle = "#7a4a1a"; g.lineWidth = 3; g.lineCap = "round";
      g.beginPath(); g.moveTo(0, -ry * 0.9); g.lineTo(0, -ry * 1.16); g.stroke();
    }
    if (sk.calyx) {                                  // 草莓萼
      g.fillStyle = "#3f9a34";
      for (i = 0; i < 5; i++) {
        g.save(); g.rotate(i * 1.256);
        g.beginPath(); g.ellipse(0, -ry * 0.86, rx * 0.16, ry * 0.26, 0, 0, 6.283); g.fill();
        g.restore();
      }
    }
  }

  /** 果肉（切开面）：6 种风格 */
  function drawFlesh(g, f, r) {
    var fl = f.flesh, rx = f.rx, ry = f.ry, i;
    var grd = g.createRadialGradient(0, 0, r * 0.1, 0, 0, r);
    grd.addColorStop(0, fl.c1); grd.addColorStop(1, fl.c2);
    g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, 6.283); g.fillStyle = grd; g.fill();

    if (fl.s === "seeds") {                          // 西瓜：绿皮 + 白瓤 + 红肉 + 籽
      g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, 6.283);
      g.lineWidth = Math.max(4, rx * 0.12); g.strokeStyle = fl.rim; g.stroke();
      g.beginPath(); g.ellipse(0, 0, rx * 0.9, ry * 0.9, 0, 0, 6.283);
      g.lineWidth = 2.5; g.strokeStyle = fl.pith; g.stroke();
      g.fillStyle = fl.seed;
      for (i = 0; i < fl.n; i++) {
        var a = i * 2.399, rr2 = Math.sqrt((i + 0.6) / fl.n) * 0.74;
        g.save();
        g.translate(Math.cos(a) * rr2 * rx * 0.9, Math.sin(a) * rr2 * ry * 0.9);
        g.rotate(a + 1.57);
        g.beginPath(); g.ellipse(0, 0, 2.1, 3.4, 0, 0, 6.283); g.fill();
        g.restore();
      }
    } else if (fl.s === "wedges") {                  // 橙/柠檬：瓣
      g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, 6.283);
      g.lineWidth = Math.max(4, rx * 0.1); g.strokeStyle = fl.rim; g.stroke();
      g.beginPath(); g.ellipse(0, 0, rx * 0.86, ry * 0.86, 0, 0, 6.283);
      g.lineWidth = 3; g.strokeStyle = fl.pith; g.stroke();
      g.fillStyle = fl.c2;
      for (i = 0; i < fl.n; i++) {
        g.save(); g.rotate(i * (6.283 / fl.n) + 0.2);
        g.beginPath(); g.moveTo(0, 0);
        g.ellipse(rx * 0.42, 0, rx * 0.40, ry * 0.14, 0, 0, 6.283);
        g.fill(); g.restore();
      }
      g.fillStyle = fl.pith;
      g.beginPath(); g.arc(0, 0, rx * 0.1, 0, 6.283); g.fill();
    } else if (fl.s === "core") {                    // 苹果/桃：果核
      g.beginPath(); g.ellipse(0, 0, rx * 0.94, ry * 0.94, 0, 0, 6.283);
      g.fillStyle = fl.c1; g.fill();
      g.strokeStyle = fl.pit || "#caa865"; g.lineWidth = 2;
      g.beginPath(); g.ellipse(0, 0, rx * 0.34, ry * 0.42, 0, 0, 6.283);
      g.fillStyle = fl.pit || "#f3dfa0"; g.fill(); g.stroke();
      g.fillStyle = fl.seed || "#4a2a12";
      g.beginPath(); g.ellipse(-rx * 0.1, -ry * 0.12, 2.4, 3.6, 0.3, 0, 6.283); g.fill();
      g.beginPath(); g.ellipse(rx * 0.1, ry * 0.12, 2.4, 3.6, -0.3, 0, 6.283); g.fill();
    } else if (fl.s === "rays") {                    // 猕猴桃/草莓：中心射线 + 籽
      g.beginPath(); g.ellipse(0, 0, rx * 0.94, ry * 0.94, 0, 0, 6.283);
      g.fillStyle = fl.c1; g.fill();
      g.strokeStyle = fl.core; g.lineWidth = 1.2;
      for (i = 0; i < fl.n; i++) {
        var a2 = i * (6.283 / fl.n);
        g.beginPath(); g.moveTo(Math.cos(a2) * rx * 0.34, Math.sin(a2) * ry * 0.34);
        g.lineTo(Math.cos(a2) * rx * 0.9, Math.sin(a2) * ry * 0.9); g.stroke();
      }
      g.fillStyle = fl.seed;
      for (i = 0; i < fl.n; i++) {
        var a3 = i * (6.283 / fl.n) + 0.14;
        g.beginPath();
        g.ellipse(Math.cos(a3) * rx * 0.62, Math.sin(a3) * ry * 0.62, 1.7, 1.2, a3, 0, 6.283);
        g.fill();
      }
      g.fillStyle = fl.core;
      g.beginPath(); g.ellipse(0, 0, rx * 0.3, ry * 0.3, 0, 0, 6.283); g.fill();
    } else if (fl.s === "rings") {                    // 椰子：白肉 + 水
      g.beginPath(); g.ellipse(0, 0, rx * 0.96, ry * 0.96, 0, 0, 6.283);
      g.fillStyle = fl.c1; g.fill();
      g.beginPath(); g.ellipse(0, 0, rx * 0.7, ry * 0.7, 0, 0, 6.283);
      g.fillStyle = fl.c2; g.fill();
      g.beginPath(); g.ellipse(0, 0, rx * 0.5, ry * 0.5, 0, 0, 6.283);
      g.fillStyle = fl.water; g.fill();
      g.fillStyle = "rgba(255,255,255,.55)";
      g.beginPath(); g.ellipse(-rx * 0.16, -ry * 0.16, rx * 0.16, ry * 0.09, -0.5, 0, 6.283); g.fill();
    } else {                                          // plain：菠萝/香蕉
      g.beginPath(); g.ellipse(0, 0, rx * 0.94, ry * 0.94, 0, 0, 6.283);
      g.fillStyle = fl.c1; g.fill();
      if (fl.eyes) {
        g.strokeStyle = fl.c2; g.lineWidth = 1.6;
        for (i = 0; i < 6; i++) {
          g.beginPath(); g.ellipse((i % 3 - 1) * rx * 0.42, (Math.floor(i / 3) - 0.5) * ry * 0.6, rx * 0.14, ry * 0.14, 0, 0, 6.283); g.stroke();
        }
      }
    }
  }

  /** 炸弹 */
  function drawBomb(g, t) {
    var grd = g.createRadialGradient(-14, -14, 4, 0, 0, 44);
    grd.addColorStop(0, "#8a8a9c"); grd.addColorStop(0.5, "#26262f"); grd.addColorStop(1, "#050507");
    g.beginPath(); g.arc(0, 0, 40, 0, 6.283); g.fillStyle = grd; g.fill();
    g.fillStyle = "#1a1a22";
    g.beginPath(); g.arc(0, 0, 40, 0, 6.283); g.lineWidth = 2; g.strokeStyle = "#55556a"; g.stroke();
    g.strokeStyle = "#caa66a"; g.lineWidth = 4.5; g.lineCap = "round";
    g.beginPath(); g.moveTo(2, -38); g.quadraticCurveTo(10, -56, 20, -60); g.stroke();
    /* 引线火花：随时间跳动（不改判定的纯装饰） */
    var s = 0.7 + Math.abs(Math.sin((t || 0) / 90)) * 0.9;
    var sg = g.createRadialGradient(20, -60, 1, 20, -60, 16 * s);
    sg.addColorStop(0, "#fff6c0"); sg.addColorStop(0.4, "#ffa53a"); sg.addColorStop(1, "rgba(255,122,26,0)");
    g.fillStyle = sg; g.beginPath(); g.arc(20, -60, 16 * s, 0, 6.283); g.fill();
    g.fillStyle = "rgba(255,255,255,.16)";
    g.beginPath(); g.ellipse(-13, -14, 11, 6, -0.6, 0, 6.283); g.fill();
  }

  /** 特殊果：香蕉形状 + 各自配色 + 角标字 */
  function drawSpecial(g, sp, t) {
    var rx = 54, ry = 26;
    var grd = g.createLinearGradient(0, -ry, 0, ry);
    grd.addColorStop(0, sp.c1); grd.addColorStop(1, sp.c2);
    g.beginPath();
    g.moveTo(-rx, -ry * 0.25);
    g.quadraticCurveTo(0, ry * 1.35, rx, -ry * 0.35);
    g.quadraticCurveTo(0, ry * 0.55, -rx, -ry * 0.25);
    g.closePath(); g.fillStyle = grd; g.fill();
    g.strokeStyle = "rgba(0,0,0,.35)"; g.lineWidth = 2; g.stroke();
    var pulse = 0.75 + Math.abs(Math.sin((t || 0) / 260)) * 0.5;
    var ag = g.createRadialGradient(0, 0, 4, 0, 0, 74 * pulse);
    ag.addColorStop(0, sp.c1); ag.addColorStop(0.7, "rgba(255,255,255,.10)"); ag.addColorStop(1, "rgba(255,255,255,0)");
    g.globalAlpha = 0.45; g.fillStyle = ag;
    g.beginPath(); g.arc(0, 0, 74 * pulse, 0, 6.283); g.fill();
    g.globalAlpha = 1;
    g.fillStyle = "rgba(20,12,6,.75)";
    g.font = "bold 20px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(sp.n, 0, 2);
    g.textAlign = "start"; g.textBaseline = "alphabetic";
  }

  /** 刀光：一条随时间淡出的渐细折线 */
  function drawBlade(g, trail) {
    if (!trail || trail.length < 2) return;
    var i;
    for (i = 1; i < trail.length; i++) {
      var a = trail[i - 1], b = trail[i];
      var age = 1 - (trail[trail.length - 1].t - b.t) / 220;
      if (age <= 0) continue;
      g.strokeStyle = "rgba(255,80,120," + (0.85 * age).toFixed(2) + ")";
      g.lineWidth = 14 * age; g.lineCap = "round";
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      g.strokeStyle = "rgba(255,255,255," + (0.95 * age).toFixed(2) + ")";
      g.lineWidth = 4.5 * age;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
  }

  /* ═══════════════ 4. 运行时 ═══════════════ */

  var ST = null, CV = null, G = null, RAF = 0, LAST = 0, ACC = 0;
  var STYLE_ID = "slashStyle";
  var LIFECYCLE = { rafCancelled: 0, disposed: 0 };

  function nowMs() { return (root.performance && root.performance.now) ? root.performance.now() : Date.now(); }
  function num(v, d) { return (typeof v === "number" && isFinite(v)) ? v : d; }

  function injectStyle() {
    if (!doc || doc.getElementById(STYLE_ID)) return;
    var css = [
      ".sl-wrap{position:relative;font-family:var(--f,'PingFang SC','Microsoft YaHei',sans-serif);color:#eceaf4}",
      ".sl-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px;font-size:12px;color:#8a87a3}",
      ".sl-bar b{color:#ffd76e;font-variant-numeric:tabular-nums}",
      ".sl-timer{flex:1;height:5px;background:#191624;border-radius:3px;overflow:hidden;min-width:80px}",
      ".sl-timer i{display:block;height:100%;width:100%;background:linear-gradient(90deg,#ff7d9c,#ffd76e,#5dffa0)}",
      ".sl-stage{position:relative;background:radial-gradient(ellipse at 50% 18%,#2a1420,#0a060c 76%);border:1px solid #232335;border-radius:6px;overflow:hidden}",
      ".sl-stage canvas{display:block;width:100%;height:auto;touch-action:none;cursor:crosshair}",
      ".sl-tip{margin-top:8px;font-size:11.5px;color:#8a87a3;line-height:1.85;min-height:32px}",
      ".sl-tip b{color:#eceaf4}",
      ".sl-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}",
      ".sl-btn{padding:9px 16px;border:1px solid #3a3752;background:#14121d;color:#eceaf4;font-size:12.5px;letter-spacing:1px;border-radius:3px}",
      ".sl-btn:hover{border-color:#ffd76e;color:#ffd76e}",
      ".sl-btn.primary{border-color:#5dffa0;color:#5dffa0;background:rgba(93,255,160,.06)}",
      ".sl-btn.ghost{border-color:#2a2840;color:#8a87a3}",
      ".sl-btn[disabled]{opacity:.45;cursor:not-allowed}",
      ".sl-menu{margin-top:6px}",
      ".sl-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}",
      ".sl-lab{font-size:11px;color:#8a87a3;letter-spacing:2px;min-width:44px}",
      ".sl-card{min-width:170px;text-align:left}",
      ".sl-card .n{font-size:14px;letter-spacing:2px;color:#eceaf4}",
      ".sl-card .d{font-size:10.5px;color:#8a87a3;margin-top:3px;line-height:1.6}",
      ".sl-card[aria-pressed='true']{border-color:#ffd76e;background:rgba(255,215,110,.08)}",
      ".sl-card[aria-pressed='true'] .n{color:#ffd76e}",
      ".sl-res{margin-top:10px;padding:12px 14px;border:1px dashed #3a3752;background:#0d0c14;border-radius:4px;font-size:12.5px;line-height:2}",
      ".sl-res .big{font-size:26px;font-weight:800;color:#ffe6ac}",
      ".sl-res .up{color:#5dffa0} .sl-res .down{color:#ff4d6d}",
      ".sl-hint{font-size:11px;color:#8a87a3;margin-top:6px}"
    ].join("");
    var s = doc.createElement("style");
    s.id = STYLE_ID; s.type = "text/css"; s.appendChild(doc.createTextNode(css));
    (doc.head || doc.documentElement).appendChild(s);
  }

  function el(tag, cls, html) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined && html !== null) e.innerHTML = html;
    return e;
  }

  function start(hostEl, opts) {
    try {
      if (!hostEl || typeof hostEl.appendChild !== "function") return false;
      if (ST) dispose();
      opts = opts || {};
      injectStyle();
      ST = {
        host: hostEl, cfg: opts, practice: !!opts.practice,
        phase: "menu",                 // menu | play | pause | result
        mode: MODES[findMode(opts.mode)],
        diffIdx: clampInt(opts.diff, 0, DIFFS.length - 1, 1),
        items: [], halves: [], parts: [], trail: [],
        score: 0, cut: 0, missed: 0, bombed: 0, lives: 0, bestCombo: 0, streak: 0, longest: 0,
        t: 0, timeLeft: 0, spawnIn: 0.6, pointerDown: false, swipeCount: 0,
        fixLeft: 0, fixT: 0, freezeT: 0, doubleT: 0, frenzyT: 0,
        over: false, done: false, last: null, bladeR: 0, seedBase: (Date.now() & 0x7fffffff)
      };
      ST.rng = makeRng(ST.seedBase);
      ST.bladeR = bladeRadius();
      ST.fixLeft = fixCharges();
      buildDom();
      paintUi();
      LAST = nowMs(); ACC = 0;
      if (typeof root.requestAnimationFrame === "function") RAF = root.requestAnimationFrame(loop);
      else RAF = root.setTimeout(function () { loop(nowMs()); }, 16);
      return true;
    } catch (e) {
      try { if (root.console && console.warn) console.warn("[Slash] start 失败", e); } catch (e2) {}
      return false;
    }
  }

  function findMode(id) {
    var i;
    for (i = 0; i < MODES.length; i++) if (MODES[i].id === id) return i;
    return 0;
  }
  function clampInt(v, lo, hi, d) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return d;
    return n < lo ? lo : (n > hi ? hi : n);
  }
  function bladeRadius() {
    var phy = 0;
    try { phy = ST && ST.cfg.phys ? (+ST.cfg.phys() || 0) : 0; } catch (e) { phy = 0; }
    return Math.min(TUNE.BLADE_R_MAX, TUNE.BLADE_R + phy * TUNE.BLADE_R_PER_PHY);
  }
  function fixCharges() {
    var intel = 0;
    try { intel = ST && ST.cfg.intel ? (+ST.cfg.intel() || 0) : 0; } catch (e) { intel = 0; }
    return Math.min(TUNE.FIX_MAX, TUNE.FIX_BASE + Math.floor(intel / TUNE.FIX_PER_INT));
  }

  /* ── DOM ── */
  function buildDom() {
    var host = ST.host;
    host.innerHTML = "";
    host.classList.add("on");
    var wrap = el("div", "sl-wrap");
    wrap.id = "slWrap";

    var bar = el("div", "sl-bar");
    bar.innerHTML = '<span id="slMode"></span><span>得分 <b id="slScore">0</b></span>' +
      '<span id="slLivesWrap">命 <b id="slLives">3</b></span>' +
      '<span class="sl-timer" id="slTimerWrap"><i id="slTimer"></i></span>' +
      '<span id="slStreak">连斩 <b>0</b></span>' +
      '<span id="slPower"></span>';

    var stage = el("div", "sl-stage");
    var cv = doc.createElement("canvas");
    cv.id = "slCv"; cv.width = VIEW.W; cv.height = VIEW.H;
    stage.appendChild(cv);
    var tip = el("div", "sl-tip"); tip.id = "slTip";
    var res = el("div", "sl-res"); res.id = "slRes"; res.style.display = "none";
    var btns = el("div", "sl-btns"); btns.id = "slBtns";

    wrap.appendChild(bar); wrap.appendChild(stage); wrap.appendChild(tip);
    wrap.appendChild(res); wrap.appendChild(btns);
    host.appendChild(wrap);
    CV = cv; G = cv.getContext("2d");
    bindInput(cv);
  }

  function bindInput(cv) {
    function toLocal(e) {
      var r = cv.getBoundingClientRect();
      var cx = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
      var cy = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
      return [(cx - r.left) / r.width * VIEW.W, (cy - r.top) / r.height * VIEW.H];
    }
    function down(e) { if (e.preventDefault) e.preventDefault(); if (ST.phase !== "play") return;
      var p = toLocal(e); ST.pointerDown = true; ST.swipeCount = 0; ST.lastPt = { x: p[0], y: p[1], t: ST.t, n: 0 }; }
    function move(e) { if (!ST.pointerDown || ST.phase !== "play") return;
      if (e.preventDefault) e.preventDefault();
      var p = toLocal(e); swipe(p[0], p[1]); }
    function up() { if (ST.pointerDown && ST.swipeCount >= TUNE.COMBO_MIN) awardCombo(ST.swipeCount);
      ST.pointerDown = false; ST.lastPt = null; }
    cv.addEventListener("mousedown", down);
    cv.addEventListener("mousemove", move);
    root.addEventListener("mouseup", up);
    cv.addEventListener("touchstart", down, { passive: false });
    cv.addEventListener("touchmove", move, { passive: false });
    cv.addEventListener("touchend", up);
    cv.oncontextmenu = function (e) { e.preventDefault(); };
    ST._detach = function () {
      cv.removeEventListener("mousedown", down); cv.removeEventListener("mousemove", move);
      root.removeEventListener("mouseup", up);
      cv.removeEventListener("touchstart", down); cv.removeEventListener("touchmove", move);
      cv.removeEventListener("touchend", up);
    };
  }

  /** 一次挥刀采样：更新刀光 + 判定所有相交的水果 */
  function swipe(x, y) {
    if (!ST || ST.phase !== "play" || !ST.lastPt) return null;
    var seg = { x1: ST.lastPt.x, y1: ST.lastPt.y, x2: x, y2: y };
    var dt = Math.max(8, ST.t - ST.lastPt.t);            // ms
    ST.lastPt = { x: x, y: y, t: ST.t };
    ST.trail.push({ x: x, y: y, t: nowMs() });
    if (ST.trail.length > 24) ST.trail.shift();
    if (!fastEnough(seg, dt)) return { slow: true };

    var speed = Math.sqrt((seg.x2 - seg.x1) * (seg.x2 - seg.x1) + (seg.y2 - seg.y1) * (seg.y2 - seg.y1)) / (dt / 1000);
    var hits = 0, crits = 0, i;
    for (i = ST.items.length - 1; i >= 0; i--) {
      var it = ST.items[i];
      if (it.type === "bomb") {
        if (segHit(seg, it, ST.bladeR)) { hitBomb(it); }
        continue;
      }
      if (segHit(seg, it, ST.bladeR)) {
        var crit = isCrit(it, x, y, speed);
        if (crit) crits++;
        sliceItem(it, seg, crit);
        ST.items.splice(i, 1);
        hits++;
        ST.swipeCount++;
      }
    }
    if (hits > 0) {
      var gain = cutScore(hits, crits, ST.doubleT > 0);
      ST.score += gain;
      ST.cut += hits;
      ST.streak += hits;
      if (ST.streak > ST.longest) ST.longest = ST.streak;
      if (hits > ST.bestCombo) ST.bestCombo = hits;
      ST.lastCut = { n: hits, crit: crits, gain: gain, streak: ST.streak };
      sfx(hits >= TUNE.COMBO_MIN ? "sfx-stock-up" : "sfx-fight-hit");
      paintUi();
    }
    return { hits: hits, crits: crits };
  }

  /** 一刀结束时的连击额外分（与 cutScore 里的连击项二选一，避免重复计分） */
  function awardCombo(n) {
    if (n >= TUNE.COMBO_MIN) { /* 分数已在 swipe 里按 cutScore 计入 */ }
  }

  function sliceItem(it, seg, crit) {
    var ang = Math.atan2(seg.y2 - seg.y1, seg.x2 - seg.x1);
    var f = FRUIT_BY_ID[it.kind] || FRUITS[0];
    var i;
    for (i = 0; i < 2; i++) {
      var side = i ? 1 : -1;
      ST.halves.push({
        kind: it.kind, x: it.x, y: it.y, rx: f.rx, ry: f.ry,
        vx: it.vx + Math.cos(ang + 1.5708) * side * 150,
        vy: it.vy + Math.sin(ang + 1.5708) * side * 150 - 40,
        rot: it.rot, spin: it.spin + side * 2.4, ang: ang, side: side, t: 0
      });
    }
    var col = (f.flesh && (f.flesh.c1 || f.flesh.c2)) || "#ff8f9e";
    for (i = 0; i < 14; i++) {
      var a = ang + (Math.random() - 0.5) * 2.6, sp = 60 + Math.random() * 220;
      ST.parts.push({ x: it.x, y: it.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
                      r: 2 + Math.random() * 4, col: col, life: 0.5 + Math.random() * 0.5, t: 0 });
    }
    if (crit) {
      ST.parts.push({ x: it.x, y: it.y, ring: true, r: 6, col: "#fff6c0", life: 0.32, t: 0, vx: 0, vy: 0 });
      toastless(crit ? "暴击 +" + TUNE.CRIT_SCORE : "");
    }
  }
  function toastless(txt) { ST.flash = { txt: txt, t: 0 }; }

  function hitBomb(it) {
    ST.items.splice(ST.items.indexOf(it), 1);
    ST.bombed++;
    var i;
    for (i = 0; i < 26; i++) {
      var a = Math.random() * 6.283, sp = 80 + Math.random() * 320;
      ST.parts.push({ x: it.x, y: it.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                      r: 2 + Math.random() * 5, col: i % 2 ? "#ffa53a" : "#ff5a1a", life: 0.6 + Math.random() * 0.5, t: 0 });
    }
    ST.parts.push({ x: it.x, y: it.y, ring: true, r: 10, col: "#ffd8a0", life: 0.45, t: 0, vx: 0, vy: 0 });
    ST.shake = 1;
    sfx("sfx-fight-lose");
    if (ST.mode.lives) { endRun("炸弹"); return; }
    ST.score = Math.max(0, ST.score - 10);
    ST.flash = { txt: "炸弹 −10", t: 0, bad: true };
    paintUi();
  }

  /** 切到特殊果：立刻生效 */
  function applySpecial(sp) {
    if (sp.id === "freeze") ST.freezeT = TUNE.FREEZE_MS;
    else if (sp.id === "double") ST.doubleT = TUNE.DOUBLE_MS;
    else if (sp.id === "frenzy") ST.frenzyT = TUNE.FRENZY_MS;
    sfx("sfx-stock-up");
    ST.flash = { txt: sp.n + "！", t: 0 };
    paintUi();
  }

  function sfx(name) { try { if (root.AudioSys && AudioSys.play) AudioSys.play(name); } catch (e) {} }

  /* ── 循环 ── */
  function loop() {
    if (!ST) return;
    var t = nowMs(), dt = t - LAST; LAST = t;
    if (dt > 200) dt = 200;
    ACC += dt;
    var steps = 0;
    while (ACC >= 16.7 && steps < 8) { step(16.7); ACC -= 16.7; steps++; }
    render();
    if (typeof root.requestAnimationFrame === "function") RAF = root.requestAnimationFrame(loop);
    else RAF = root.setTimeout(function () { loop(nowMs()); }, 16);
  }

  function timeScale() {
    var s = 1;
    if (ST.freezeT > 0) s *= TUNE.FREEZE_SCALE;
    if (ST.fixT > 0) s *= TUNE.FIX_SCALE;
    return s;
  }

  function step(dtMs) {
    if (!ST) return;
    var dt = dtMs / 1000;
    if (ST.flash) { ST.flash.t += dtMs; if (ST.flash.t > 900) ST.flash = null; }
    if (ST.shake > 0) ST.shake = Math.max(0, ST.shake - dtMs / 320);
    if (ST.freezeT > 0) ST.freezeT = Math.max(0, ST.freezeT - dtMs);
    if (ST.doubleT > 0) ST.doubleT = Math.max(0, ST.doubleT - dtMs);
    if (ST.frenzyT > 0) ST.frenzyT = Math.max(0, ST.frenzyT - dtMs);
    if (ST.fixT > 0) ST.fixT = Math.max(0, ST.fixT - dtMs);
    if (ST.phase !== "play") return;

    var sdt = dt * timeScale();
    ST.t += sdt * 1000;
    if (ST.mode.ms) {
      ST.timeLeft -= sdt * 1000;
      if (ST.timeLeft <= 0) { ST.timeLeft = 0; endRun("时间到"); return; }
    }
    /* 抛出 */
    ST.spawnIn -= sdt;
    if (ST.spawnIn <= 0) {
      var diff = DIFFS[ST.diffIdx];
      var gap = rr(ST.rng, diff.gapMin, diff.gapMax);
      if (ST.frenzyT > 0) gap *= TUNE.FRENZY_GAP;
      ST.spawnIn = gap;
      if (aliveFruits() < diff.aliveMax) {
        var wave = spawnWave(ST.rng, ST.mode, diff), i;
        for (i = 0; i < wave.length; i++) {
          var f = wave[i].kind ? FRUIT_BY_ID[wave[i].kind] : null;
          wave[i].rx = wave[i].type === "bomb" ? 40 : (f ? f.rx : 54);
          wave[i].ry = wave[i].type === "bomb" ? 40 : (f ? f.ry : 26);
          ST.items.push(wave[i]);
        }
      }
    }
    /* 物理 */
    var i;
    for (i = ST.items.length - 1; i >= 0; i--) {
      var it = ST.items[i];
      it.vy += TUNE.GRAVITY * sdt;
      it.x += it.vx * sdt; it.y += it.vy * sdt; it.rot += it.spin * sdt;
      if (it.y > GROUND) {
        ST.items.splice(i, 1);
        if (it.type === "bomb") continue;                 // 炸弹掉下去 = 好事
        ST.missed++; ST.streak = 0;
        if (ST.mode.lives) { ST.lives--; if (ST.lives <= 0) { endRun("漏光了"); return; } }
        paintUi();
      }
    }
    for (i = ST.halves.length - 1; i >= 0; i--) {
      var h = ST.halves[i];
      h.vy += TUNE.GRAVITY * sdt; h.x += h.vx * sdt; h.y += h.vy * sdt;
      h.rot += h.spin * sdt; h.t += dtMs;
      if (h.y > GROUND) ST.halves.splice(i, 1);
    }
    for (i = ST.parts.length - 1; i >= 0; i--) {
      var p = ST.parts[i];
      p.t += dt;
      if (!p.ring) { p.vy += 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
      if (p.t >= p.life) ST.parts.splice(i, 1);
    }
    /* 刀光淡出 */
    var now = nowMs();
    while (ST.trail.length && now - ST.trail[0].t > 220) ST.trail.shift();
    if (ST.pointerDown && ST.lastPt) ST.lastPt.t = ST.t;   // 按住不动时不累积假速度
    paintHud();
  }

  function aliveFruits() {
    var n = 0, i;
    for (i = 0; i < ST.items.length; i++) if (ST.items[i].type !== "bomb") n++;
    return n;
  }

  /* ── 渲染 ── */
  function render() {
    if (!G || !ST) return;
    var g = G;
    g.clearRect(0, 0, VIEW.W, VIEW.H);
    /* 背景：夜市摊的木桌 + 暖光 */
    var bg = g.createLinearGradient(0, 0, 0, VIEW.H);
    bg.addColorStop(0, "#2a1420"); bg.addColorStop(1, "#0a060c");
    g.fillStyle = bg; g.fillRect(0, 0, VIEW.W, VIEW.H);
    g.fillStyle = "rgba(255,176,74,.06)";
    g.beginPath(); g.arc(VIEW.W * 0.5, -40, 330, 0, 6.283); g.fill();
    g.strokeStyle = "rgba(255,255,255,.05)"; g.lineWidth = 2;
    var i;
    for (i = 1; i < 6; i++) { g.beginPath(); g.moveTo(0, i * 100); g.lineTo(VIEW.W, i * 100); g.stroke(); }

    g.save();
    if (ST.shake > 0) g.translate((Math.random() - 0.5) * 10 * ST.shake, (Math.random() - 0.5) * 10 * ST.shake);

    /* 两半 */
    for (i = 0; i < ST.halves.length; i++) {
      var h = ST.halves[i], f = FRUIT_BY_ID[h.kind] || FRUITS[0];
      g.save();
      g.translate(h.x, h.y); g.rotate(h.ang);
      g.beginPath();
      if (h.side > 0) g.rect(-h.rx * 1.4, 0, h.rx * 2.8, h.ry * 1.6);
      else g.rect(-h.rx * 1.4, -h.ry * 1.6, h.rx * 2.8, h.ry * 1.6);
      g.clip();
      g.rotate(-h.ang + h.rot - h.rot);
      g.rotate(h.rot);
      drawFlesh(g, f, Math.max(f.rx, f.ry));
      g.restore();
    }
    /* 完整物 */
    for (i = 0; i < ST.items.length; i++) {
      var it = ST.items[i];
      g.save();
      g.translate(it.x, it.y); g.rotate(it.rot);
      if (it.type === "bomb") drawBomb(g, ST.t);
      else if (it.type === "special") drawSpecial(g, SPECIAL_BY_ID[it.kind] || SPECIALS[0], ST.t);
      else drawSkin(g, FRUIT_BY_ID[it.kind] || FRUITS[0], Math.max(it.rx, it.ry));
      g.restore();
    }
    /* 粒子 */
    for (i = 0; i < ST.parts.length; i++) {
      var p = ST.parts[i], k = 1 - p.t / p.life;
      g.globalAlpha = Math.max(0, k);
      if (p.ring) {
        g.strokeStyle = p.col; g.lineWidth = 3 * k;
        g.beginPath(); g.arc(p.x, p.y, p.r + (1 - k) * 46, 0, 6.283); g.stroke();
      } else {
        g.fillStyle = p.col;
        g.beginPath(); g.arc(p.x, p.y, p.r * k, 0, 6.283); g.fill();
      }
      g.globalAlpha = 1;
    }
    drawBlade(g, ST.trail);
    /* 暴击/特殊果的大字提示 */
    if (ST.flash) {
      var a = 1 - ST.flash.t / 900;
      g.globalAlpha = Math.max(0, a);
      g.fillStyle = ST.flash.bad ? "#ff6a7d" : "#ffe6ac";
      g.font = "bold 30px sans-serif"; g.textAlign = "center";
      g.fillText(ST.flash.txt, VIEW.W / 2, 120 - (1 - a) * 26);
      g.textAlign = "start"; g.globalAlpha = 1;
    }
    g.restore();
    /* 定身/冰冻的全屏色调 */
    if (ST.fixT > 0 || ST.freezeT > 0) {
      g.fillStyle = ST.freezeT > 0 ? "rgba(140,220,255,.10)" : "rgba(255,215,110,.08)";
      g.fillRect(0, 0, VIEW.W, VIEW.H);
    }
  }

  /* ── UI ── */
  function paintHud() {
    if (!ST || !doc) return;
    var set = function (id, html) { var e = doc.getElementById(id); if (e) e.innerHTML = html; };
    set("slScore", String(ST.score));
    set("slLives", String(Math.max(0, ST.lives)));
    set("slStreak", "连斩 <b>" + ST.streak + "</b>");
    var lw = doc.getElementById("slLivesWrap");
    if (lw) lw.style.display = ST.mode.lives ? "" : "none";
    var tw = doc.getElementById("slTimerWrap");
    if (tw) tw.style.display = ST.mode.ms ? "" : "none";
    if (ST.mode.ms) {
      var bar = doc.getElementById("slTimer");
      if (bar) bar.style.width = Math.max(0, ST.timeLeft / ST.mode.ms * 100).toFixed(1) + "%";
    }
    var pw = [];
    if (ST.freezeT > 0) pw.push('❄ 冰冻 ' + (ST.freezeT / 1000).toFixed(1) + "s");
    if (ST.doubleT > 0) pw.push('×2 双倍 ' + (ST.doubleT / 1000).toFixed(1) + "s");
    if (ST.frenzyT > 0) pw.push('🔥 狂热 ' + (ST.frenzyT / 1000).toFixed(1) + "s");
    if (ST.fixT > 0) pw.push('⏳ 定身 ' + (ST.fixT / 1000).toFixed(1) + "s");
    pw.push("🩸 定身可用 " + ST.fixLeft);
    set("slPower", pw.join(" · "));
  }

  function paintUi() {
    if (!ST || !doc) return;
    var tip = doc.getElementById("slTip"), res = doc.getElementById("slRes"), btns = doc.getElementById("slBtns");
    if (!tip || !res || !btns) return;
    paintHud();
    var i;
    if (ST.phase === "menu") {
      tip.innerHTML = "选模式和难度，然后开始。<b>按住鼠标划过水果</b>即可切开 —— 动作太慢切不开；" +
        "一刀切 3 个以上有连击分，正中快切有暴击。";
      res.style.display = "none";
      btns.innerHTML = "";
      var row1 = el("div", "sl-row"), row2 = el("div", "sl-row");
      row1.appendChild(el("span", "sl-lab", "模式"));
      for (i = 0; i < MODES.length; i++) {
        (function (k) {
          var b = el("button", "sl-btn sl-card", '<span class="n">' + MODES[k].n + '</span><span class="d">' + MODES[k].desc + "</span>");
          b.setAttribute("aria-pressed", ST.mode.id === MODES[k].id ? "true" : "false");
          b.onclick = function () { ST.mode = MODES[k]; ST.lives = ST.mode.lives; paintUi(); };
          row1.appendChild(b);
        })(i);
      }
      row2.appendChild(el("span", "sl-lab", "难度"));
      for (i = 0; i < DIFFS.length; i++) {
        (function (k) {
          var b = el("button", "sl-btn", DIFFS[k].n);
          b.setAttribute("aria-pressed", ST.diffIdx === k ? "true" : "false");
          if (ST.diffIdx === k) b.classList.add("primary");
          b.onclick = function () { ST.diffIdx = k; paintUi(); };
          row2.appendChild(b);
        })(i);
      }
      btns.appendChild(row1); btns.appendChild(row2);
      var go = el("button", "sl-btn primary", "开始切果" + (ST.practice ? "（练手局）" : " · ¥" + TUNE.ENTRY));
      go.onclick = function () { beginRun(); };
      var row3 = el("div", "sl-row"); row3.appendChild(go); btns.appendChild(row3);
      var best = (ST.cfg.best ? ST.cfg.best(ST.mode.id) : 0) || 0;
      var ladder = TUNE.PAYOUT[ST.mode.id] || TUNE.PAYOUT.arcade;
      var txt = ladder.filter(function (r) { return r.cash > 0; })
        .map(function (r) { return r.min + " 分 ¥" + r.cash; }).join(" · ");
      var hint = el("div", "sl-hint", "本模式最高分 <b>" + best + "</b> · 奖金阶梯：" + txt);
      btns.appendChild(hint);
    } else if (ST.phase === "pause") {
      tip.innerHTML = "已暂停。";
      btns.innerHTML = "";
      var rb = el("button", "sl-btn primary", "继续"); rb.onclick = function () { resume(); };
      var qb = el("button", "sl-btn ghost", "收摊（结束本局）"); qb.onclick = function () { endRun("主动收摊"); };
      btns.appendChild(rb); btns.appendChild(qb);
    } else if (ST.phase === "result") {
      var r = ST.last || {};
      var net = r.net || 0;
      res.innerHTML = '<div class="big">' + ST.score + " 分</div>" +
        "切开 <b>" + ST.cut + "</b> 个 · 漏掉 <b>" + ST.missed + "</b> · 炸弹 <b>" + ST.bombed + "</b><br>" +
        "最佳连击 <b>" + ST.bestCombo + "</b> · 最长连斩 <b>" + ST.longest + "</b> · 结束原因：" + (r.why || "—") + "<br>" +
        (ST.practice ? '<span class="sl-hint">练手局 · 本局收支不计入财富</span>'
                     : "入场 <b>¥" + r.entry + "</b> · 奖金 <b>¥" + r.payout + "</b> · 净收支 <b class=\"" +
                       (net >= 0 ? "up" : "down") + "\">" + (net >= 0 ? "+" : "") + net + "</b>");
      res.style.display = "";
      btns.innerHTML = "";
      var again = el("button", "sl-btn primary", "再来一局");
      again.onclick = function () { ST.phase = "menu"; ST.items = []; ST.halves = []; ST.parts = []; ST.trail = [];
        ST.score = 0; ST.cut = 0; ST.missed = 0; ST.bombed = 0; ST.bestCombo = 0; ST.streak = 0; ST.longest = 0;
        ST.last = null; ST.lives = ST.mode.lives; paintUi(); };
      var back = el("button", "sl-btn ghost", "换个模式");
      back.onclick = function () { again.onclick(); };
      btns.appendChild(again); btns.appendChild(back);
    }
  }

  /* ── 局流程 ── */
  function beginRun() {
    if (!ST) return false;
    if (!ST.practice) {
      var cash = 0;
      try { cash = ST.cfg.cash ? (+ST.cfg.cash() || 0) : 0; } catch (e) { cash = 0; }
      if (cash < TUNE.ENTRY) return false;                      // 由宿主决定是否转练手局
    }
    ST.phase = "play";
    ST.items = []; ST.halves = []; ST.parts = []; ST.trail = [];
    ST.score = 0; ST.cut = 0; ST.missed = 0; ST.bombed = 0; ST.bestCombo = 0;
    ST.streak = 0; ST.longest = 0; ST.t = 0; ST.spawnIn = 0.5;
    ST.lives = ST.mode.lives;
    ST.timeLeft = ST.mode.ms;
    ST.freezeT = ST.doubleT = ST.frenzyT = ST.fixT = 0;
    ST.over = false; ST.last = null;
    ST.bladeR = bladeRadius(); ST.fixLeft = fixCharges();
    ST.rng = makeRng((ST.seedBase = (ST.seedBase + 7919) >>> 0));
    sfx("ui-open");
    paintUi();
    return true;
  }

  function endRun(why) {
    if (!ST || ST.over) return false;
    ST.over = true;
    ST.phase = "result";
    var payout = payoutOf(ST.score, ST.mode.id);
    var entry = ST.practice ? 0 : TUNE.ENTRY;
    var net = payout - entry;
    ST.last = { why: why, score: ST.score, entry: entry, payout: payout, net: net,
                cut: ST.cut, missed: ST.missed, bombs: ST.bombed, bestCombo: ST.bestCombo,
                longest: ST.longest, mode: ST.mode.id, practice: !!ST.practice };
    try { if (ST.cfg.onSettle) ST.cfg.onSettle(net, ST.last); } catch (e) {}
    sfx(net > 0 ? "sfx-stock-up" : "sfx-fight-lose");
    paintUi();
    return ST.last;
  }

  function pause() { if (ST && ST.phase === "play") { ST.phase = "pause"; paintUi(); return true; } return false; }
  function resume() { if (ST && ST.phase === "pause") { ST.phase = "play"; paintUi(); return true; } return false; }

  function dispose() {
    if (RAF) {
      if (typeof root.cancelAnimationFrame === "function") root.cancelAnimationFrame(RAF);
      else root.clearTimeout(RAF);
      LIFECYCLE.rafCancelled++;
    }
    RAF = 0;
    try { if (ST && ST._detach) ST._detach(); } catch (e) {}
    if (ST && ST.host) { try { ST.host.innerHTML = ""; ST.host.classList.remove("on"); } catch (e) {} }
    try { if (ST && ST.cfg.onFinish) ST.cfg.onFinish({ score: ST.score, cut: ST.cut, missed: ST.missed,
      bombs: ST.bombed, bestCombo: ST.bestCombo, longest: ST.longest, mode: ST.mode.id,
      net: ST.last ? ST.last.net : 0, practice: !!ST.practice, done: ST.over }); } catch (e) {}
    ST = null; CV = null; G = null;
    LIFECYCLE.disposed++;
    return true;
  }

  /* ═══════════════ 5. 对外 API ═══════════════ */
  var rules = {
    TUNE: TUNE, VIEW: VIEW, MODES: MODES, DIFFS: DIFFS, FRUITS: FRUITS, SPECIALS: SPECIALS,
    makeRng: makeRng, spawnWave: spawnWave, segHit: segHit, fastEnough: fastEnough,
    isCrit: isCrit, cutScore: cutScore, payoutOf: payoutOf, simulateGame: simulateGame,
    segPointD2: segPointD2
  };

  root.Slash = {
    version: "slash-1.0",
    TUNE: TUNE, VIEW: VIEW, MODES: MODES, DIFFS: DIFFS,
    start: start, isBusy: function () { return !!ST; }, dispose: dispose, pause: pause, resume: resume,
    rules: rules,
    debug: {
      state: function () {
        if (!ST) return null;
        return { phase: ST.phase, mode: ST.mode.id, diff: DIFFS[ST.diffIdx].id,
          score: ST.score, cut: ST.cut, missed: ST.missed, bombs: ST.bombed,
          lives: ST.lives, timeLeft: Math.round(ST.timeLeft), items: ST.items.length,
          halves: ST.halves.length, streak: ST.streak, longest: ST.longest,
          bestCombo: ST.bestCombo, bladeR: ST.bladeR, fixLeft: ST.fixLeft,
          freeze: Math.round(ST.freezeT), double: Math.round(ST.doubleT), frenzy: Math.round(ST.frenzyT),
          over: ST.over, last: ST.last, practice: !!ST.practice };
      },
      items: function () {
        if (!ST) return [];
        return ST.items.map(function (it) {
          return { type: it.type, kind: it.kind, x: Math.round(it.x), y: Math.round(it.y),
                   rx: it.rx, ry: it.ry, vy: Math.round(it.vy) };
        });
      },
      setMode: function (m) { if (!ST) return false; ST.mode = MODES[findMode(m)]; ST.lives = ST.mode.lives; paintUi(); return true; },
      setDiff: function (d) { if (!ST) return false; ST.diffIdx = clampInt(d, 0, DIFFS.length - 1, 1); paintUi(); return true; },
      beginRun: function () { return beginRun(); },
      spawn: function (type, kind) {                       // 验收用：手摆一个目标
        if (!ST) return null;
        var f = kind ? FRUIT_BY_ID[kind] : FRUITS[0];
        var it = { type: type || "fruit", kind: kind || "wm", x: VIEW.W / 2, y: VIEW.H * 0.55,
                   vx: 0, vy: -20, rot: 0, spin: 0,
                   rx: type === "bomb" ? 40 : (f ? f.rx : 54), ry: type === "bomb" ? 40 : (f ? f.ry : 26) };
        ST.items.push(it);
        return it;
      },
      swipe: function (x1, y1, x2, y2) {                   // 验收用：直接给一条刀光
        if (!ST) return null;
        ST.lastPt = { x: x1, y: y1, t: ST.t - 30 };
        return swipe(x2, y2);
      },
      tick: function (ms) { if (!ST) return false; var n = Math.max(1, Math.round(ms / 16.7)), i; for (i = 0; i < n; i++) step(16.7); render(); return true; },
      pause: pause, resume: resume,
      setFix: function (n) { if (!ST) return false; ST.fixLeft = n; return true; },
      useFix: function () { if (!ST || ST.fixLeft <= 0 || ST.phase !== "play") return false; ST.fixLeft--; ST.fixT = TUNE.FIX_MS; paintUi(); return true; },
      finishNow: function () { if (!ST) return false; return endRun("调试结束"); },
      payout: function (s, m) { return payoutOf(s, m); },
      lifecycle: function () { return { rafCancelled: LIFECYCLE.rafCancelled, disposed: LIFECYCLE.disposed }; }
    }
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
