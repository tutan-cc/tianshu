/* ═══════════════════════════════════════════════════════════════════════════
   jade.js — 「开窗」· 赌石（找茬开盲盒）
   自包含 IIFE，暴露全局 window.Jade；ES5 风格，不使用 ES module，
   不依赖页面内变量（只读 opts / 挂载 hostEl）。

   一句话规格：在夜市地摊上相玉 —— 拖放大镜在皮壳上**找茬**（找裂 / 找注胶 /
   看松花蟒带）→ 出价 → 一刀切开见分晓。

   对外 API（规格）：
     window.Jade.start(hostEl, opts) -> boolean
       opts:{ cash:()=>number, intel:()=>number, onSettle:(net,info)=>{}, onFinish:(sum)=>{}, run:{stones} }
     window.Jade.isBusy(), dispose()
     window.Jade.debug = { state(), stone(), found(), tap(x,y), lens(x,y), hint(),
                           bid(i), walk(), skip(), finishNow(), lifecycle() }

   附加（单测用，不属于规格）：window.Jade.rules = { genStone, trueValueOf,
     estimateOf, settle, PRICES, SPEC }  —— 纯函数，无 DOM，可在 vm 里单独注入。

   ── 设计要点（为什么这么做，改之前先读）──────────────────────────────────
   1) **找茬 = 唯一的信息来源**：出价时你只知道"你找到的"。未发现的垮特征
      （裂 / 绺 / 注胶 / 假皮）照样在切开后按比例扣钱 —— 眼力直接换算成钱。
      这条因果是整个玩法的地基，任何"自动提示全部特征"的改动都会摧毁它。
   2) **经济不变量**（tests/jade.test.cjs 用蒙特卡洛断言）：
        · 乱买必亏：不做找茬、每块无脑出中档 → 长期期望净收益 < 0
        · 眼力能赚但不失控：完全信息策略 → 期望净收益 > 0 且有上限
      改 TUNE / SPEC / QUALITY / COLOR / FLAWS 里的任何数字，都要重跑那条测试。
   3) **每块切开即结算**（不等一局结束）：中途退出不吃亏也不占便宜，
      与刮刮乐的即时结算保持一致。
   4) 皮壳与特征由种子 PRNG 生成，**同一块石头每帧重绘完全一致**（可复现、
      可截图、可单测）；生成后烘焙到离屏 canvas，放大镜只是把同一张纹理放大。
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";
  if (!root || root.Jade) return;

  var doc = root.document;

  /* ═══════════════ 1. 调参区（改手感只动这里） ═══════════════ */

  var TUNE = {
    /* 相玉（找茬）阶段 */
    SEARCH_MS:      25000,   // 每块石头的观察时间
    MISS_PENALTY_MS: 2000,   // 空点代价：扣时 + 放大镜抖一下（防乱点）
    LENS_R:         62,      // 放大镜半径（逻辑像素）
    LENS_ZOOM:      2.2,     // 放大倍数（找茬的关键：1× 看不清，2.2× 才看得见）
    HIT_R:          30,      // 打标判定半径
    HINT_BASE:      1,       // 「照一照」基础次数
    HINT_PER_INT:   20,      // 每 20 点智慧 +1 次
    HINT_MAX:       3,       // 上限（防止智慧流无限提示）
    HINT_MS:        950,     // 探照高亮持续
    /* 一局 */
    STONES_PER_RUN: 3,
    /* 三档出价。定标依据是**实测的真实价值分布**（80000 块蒙特卡洛）：
         E[价值] = 198 · p50 = 80 · p75 = 200 · p90 = 460 · p99 = 2080 · max = 47100
         E[价值 | 蟒带] = 258 · | 松花 = 241 · | 蟒+松 = 369 · | 蟒+松+无裂 = 813
       ¥250 —— 首档贴着 E[价值]：盲出小亏（−52），**看出一个信号就能下场**（蟒+松 → +119）
       ¥450 —— 强读档：蟒+松 369 还差点意思（−81），要"双sign 且没发现裂"才赚（813 → +363）
       ¥800 —— 全押档：只有完美读料才勉强打平（813 → +13），**靠尾巴翻身**（p99 2080 / max 4.7 万）
       ⚠ 三条踩过的坑，别再踩：
         · 首档不能高于 E 太多：试过 ¥280，出价率掉到 1–5%，玩家 95% 时间只能"走人"
         · 全押档不能定到完美读也够不着（试过 ¥1200 → 完美读仍 −519，成了死按钮）
         · 三档都要 > E[价值]，否则盲出就是正期望（刷钱机）
       改这里必须重跑 tests/jade.test.cjs 的经济不变量。 */
    PRICES:         [250, 450, 800],
    /* 切石动画 */
    CUT_MS:         1000
  };

  /* 皮壳（只影响长相与底价微调，不影响种水） */
  var SKINS = [
    { id:"huangsha", n:"黄沙皮", base:"#b98a4e", dark:"#7d5626", speck:"#dcb87c", tint:1.00 },
    { id:"heiwusha", n:"黑乌沙", base:"#4a443c", dark:"#282420", speck:"#7d7466", tint:1.12 },
    { id:"shuipi",   n:"水皮",   base:"#8d9aa0", dark:"#5b666c", speck:"#c6cfd3", tint:0.94 },
    { id:"huangli",  n:"黄梨皮", base:"#c9a24a", dark:"#8f7029", speck:"#e8cd80", tint:1.06 }
  ];

  /* 垮特征：找到才能避开；**没找到的照样扣钱** */
  var FLAWS = {
    lie:  { id:"lie",  n:"裂",   mul:0.35, pen:"−65%", why:"贯穿裂，最致命" },
    liu:  { id:"liu",  n:"绺",   mul:0.80, pen:"−20%", why:"浅绺，影响不大" },
    jiao: { id:"jiao", n:"注胶", mul:0.60, pen:"−40%", why:"注过胶，行家不收" },
    jia:  { id:"jia",  n:"假皮", mul:0.05, pen:"−95%", why:"皮是假的，里面什么都没有" }
  };
  var FLAW_IDS = ["lie", "liu", "jiao", "jia"];

  /* 涨特征：只影响"人怎么看"，不直接改变真实价值（真实价值由种水色决定） */
  var GOODS = {
    songhua: { id:"songhua", n:"松花", why:"有松花，内部多半有色" },
    mangdai: { id:"mangdai", n:"蟒带", why:"蟒带缠身，色带概率高" }
  };
  var GOOD_IDS = ["songhua", "mangdai"];

  /* 种 / 色：真实价值的两个乘数（也是"开窗"那一刻的看点）
     ⚠ pUncond 是无条件概率，pMangdai / pSonghua 是**看到对应涨特征之后**的概率。
     这组条件概率是"看松花蟒带"这件事有意义的唯一原因 —— 若把涨特征改成与种水色
     无关的纯噪音，¥1000 档就变成没有技术含量的送钱档，整个玩法的前提就塌了。
     末档（玻璃种 / 帝王绿）是**高货**：平时几乎见不到，只有"蟒带 + 松花"双sign
     的石头才够得着 —— 这是"一刀富"这个说法在数值上的落点，也是 ¥1000 档能靠
     读料撑起来的唯一原因（实测：没有这一档时，读对的期望只有 250，1000 档永远亏）。 */
  var QUALITY = [
    { id:"dou",    n:"豆种",   p:0.600, pMangdai:0.18, mul:1.0,  col:"#9fae9f", inner:"#8d9b8d" },
    { id:"nuo",    n:"糯种",   p:0.300, pMangdai:0.40, mul:2.0,  col:"#d3e3d6", inner:"#c2d6c8" },
    { id:"bing",   n:"冰种",   p:0.095, pMangdai:0.32, mul:5.0,  col:"#e4f3f7", inner:"#cfeaf2" },
    { id:"boli",   n:"玻璃种", p:0.005, pMangdai:0.025, mul:20.0, col:"#f2fbff", inner:"#e2f4fa" }
  ];
  var COLOR = [
    { id:"wu",      n:"无色",   p:0.650, pSonghua:0.25, mul:1.0, col:"#e8eef0" },
    { id:"piaohua", n:"飘花",   p:0.250, pSonghua:0.35, mul:1.6, col:"#7fd6a8" },
    { id:"yanglv",  n:"阳绿",   p:0.095, pSonghua:0.28, mul:3.5, col:"#39d97a" },
    { id:"diwang",  n:"帝王绿", p:0.005, pSonghua:0.03, mul:15.0, col:"#12c95f" }
  ];

  var BASE_MIN = 40, BASE_MAX = 150;      // 底价区间（皮壳 tint 会再微调）
  /* ⚠ 底价区间与 TUNE.PRICES 是一对：调了涨特征→种水色的条件概率之后（E[种×色] 被抬高），
     这里必须同步缩一档，否则"无脑出中档"就变成正期望 —— 实测过，E[价值] 265 时乱买
     每块赚 65，等于刷钱机。改动后请重跑 tests/jade.test.cjs 的两条经济不变量。 */
  var FLAW_COUNT_P = [0.25, 0.35, 0.22, 0.12, 0.06];   // 0..4 条垮特征
  var GOOD_COUNT_P = [0.30, 0.50, 0.20];               // 0..2 条涨特征

  /* 玩家的"先验"：对一块**没看过的**原石的期望与区间。
     这两个数是 estimateOf 的基准，也是"估价不读隐藏信息"这条纪律的落点。
     PRIOR_MID 必须等于总体 E[价值]（实测 226）—— 改分布要重测，否则先验就偏了。 */
  var PRIOR_MID = 216;
  var PRIOR_LO_MUL = 0.35, PRIOR_HI_MUL = 2.6;

  var VIEW = { W: 640, H: 440 };          // 逻辑尺寸
  var TEX = 2;                            // 离屏纹理倍率（放大镜下才不糊）

  /* ═══════════════ 2. 纯规则（无 DOM，可单测） ═══════════════ */

  /** ES5 版 Math.imul（IE11 没有）—— 种子 PRNG 需要它 */
  var imul = Math.imul || function (a, b) {
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff,
        bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return (al * bl + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
  };

  /** mulberry32：小、快、可复现。同一 seed 永远同一块石头 */
  function makeRng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = imul(a ^ (a >>> 15), 1 | a);
      t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pick(rng, list) {
    var r = rng(), acc = 0, i;
    for (i = 0; i < list.length; i++) { acc += list[i].p; if (r <= acc) return list[i]; }
    return list[list.length - 1];
  }
  /** 条件抽样：给了 key（如 "pMangdai"）就用该组概率，否则用无条件 p */
  function pickCond(rng, list, key) {
    var r = rng(), acc = 0, tot = 0, i;
    for (i = 0; i < list.length; i++) tot += (key && list[i][key] !== undefined) ? list[i][key] : list[i].p;
    for (i = 0; i < list.length; i++) {
      acc += ((key && list[i][key] !== undefined) ? list[i][key] : list[i].p) / tot;
      if (r <= acc) return list[i];
    }
    return list[list.length - 1];
  }
  function pickCount(rng, probs) {
    var r = rng(), acc = 0, i;
    for (i = 0; i < probs.length; i++) { acc += probs[i]; if (r <= acc) return i; }
    return probs.length - 1;
  }
  function rand(rng, a, b) { return a + rng() * (b - a); }
  function round10(v) { return Math.round(v / 10) * 10; }

  /** 石头外形：半径随角度轻微起伏（不是正圆，看着才像原石） */
  function shapeR(theta, k) {
    return 1 + 0.13 * Math.sin(3 * theta + k.p1) + 0.07 * Math.sin(5 * theta + k.p2) + 0.04 * Math.sin(7 * theta + k.p3);
  }
  function insideStone(x, y, geo) {
    var dx = x - geo.cx, dy = y - geo.cy;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1) return true;
    var th = Math.atan2(dy, dx);
    return d <= geo.rx * shapeR(th, geo.k) * 0.9;
  }
  function stoneEdge(geo) { return geo.rx * 1.25; }

  /**
   * 造一块石头。
   * seed 相同 → 结果逐字段相同（可复现、可单测、可截图）。
   */
  function genStone(seed) {
    var rng = makeRng(seed);
    var geo = {
      cx: VIEW.W / 2 + rand(rng, -14, 14),
      cy: VIEW.H / 2 + rand(rng, -12, 12),
      rx: rand(rng, 190, 215),
      k: { p1: rand(rng, 0, 6.283), p2: rand(rng, 0, 6.283), p3: rand(rng, 0, 6.283) }
    };
    var skin = SKINS[Math.floor(rng() * SKINS.length) % SKINS.length];

    /* 先定涨特征，再让它决定种水色的分布 —— 这是"看松花蟒带"有意义的唯一原因。
       ⚠ 两个涨特征**不重复**取（不抽到两条蟒带）：一来"蟒带+松花"的双sign 才是
       设计里的强读，重复取会让估价把同一个乘数乘两次（虚高）；二来皮壳上出现两条
       一模一样的蟒带本身就假。 */
    var i, goodKinds = [];
    var nGood = pickCount(rng, GOOD_COUNT_P);
    var pool = GOOD_IDS.slice();
    for (i = 0; i < nGood && pool.length; i++) {
      var gi = Math.floor(rng() * pool.length) % pool.length;
      goodKinds.push(pool[gi]);
      pool.splice(gi, 1);
    }
    var hasMangdai = goodKinds.indexOf("mangdai") >= 0;
    var hasSonghua = goodKinds.indexOf("songhua") >= 0;
    var quality = pickCond(rng, QUALITY, hasMangdai ? "pMangdai" : null);
    var color = pickCond(rng, COLOR, hasSonghua ? "pSonghua" : null);
    var base = Math.round(rand(rng, BASE_MIN, BASE_MAX) * skin.tint);

    /* 特征埋点：拒绝采样保证互不重叠、且都在石头里 */
    var feats = [], minGap = 74;
    var nFlaw = pickCount(rng, FLAW_COUNT_P);
    function place(kind, isFlaw) {
      var tries = 0;
      while (tries++ < 60) {
        var th = rand(rng, 0, 6.283);
        var rr = Math.sqrt(rng()) * geo.rx * 0.72 * shapeR(th, geo.k);
        var x = geo.cx + Math.cos(th) * rr, y = geo.cy + Math.sin(th) * rr;
        if (!insideStone(x, y, geo)) continue;
        var ok = true, j;
        for (j = 0; j < feats.length; j++) {
          var dx = feats[j].x - x, dy = feats[j].y - y;
          if (Math.sqrt(dx * dx + dy * dy) < minGap) { ok = false; break; }
        }
        if (!ok) continue;
        return { id: kind, isFlaw: isFlaw, x: x, y: y, rot: rand(rng, 0, 6.283),
                 len: rand(rng, 56, 132), r: rand(rng, 18, 32) };
      }
      return null;
    }
    for (i = 0; i < nFlaw; i++) {
      var fk = FLAW_IDS[Math.floor(rng() * FLAW_IDS.length) % FLAW_IDS.length];
      var f = place(fk, true);
      if (f) { f.kind = fk; feats.push(f); }
    }
    for (i = 0; i < goodKinds.length; i++) {
      var g = place(goodKinds[i], false);
      if (g) { g.kind = goodKinds[i]; feats.push(g); }
    }

    var st = {
      seed: seed >>> 0,
      geo: geo,
      skin: skin,
      quality: quality,
      color: color,
      base: base,
      feats: feats
    };
    st.trueValue = trueValueOf(st);
    return st;
  }

  /**
   * 真实价值：底价 × 种 × 色 × 每条垮特征的惩罚（**全部**特征都算，
   * 不区分玩家有没有找到 —— 这就是"眼力=钱"的因果）。
   */
  function trueValueOf(st) {
    var v = st.base * st.quality.mul * st.color.mul, i;
    for (i = 0; i < st.feats.length; i++) {
      var f = st.feats[i];
      if (f.isFlaw) v *= FLAWS[f.kind].mul;
    }
    return round10(v);
  }

  function flawsOf(st) {
    var out = [], i;
    for (i = 0; i < st.feats.length; i++) if (st.feats[i].isFlaw) out.push(st.feats[i]);
    return out;
  }
  function goodsOf(st) {
    var out = [], i;
    for (i = 0; i < st.feats.length; i++) if (!st.feats[i].isFlaw) out.push(st.feats[i]);
    return out;
  }

  /** 玩家可见的「料单」：找到的涨/垮特征 */
  function listOf(st, foundIdx) {
    var flaws = [], goods = [], i;
    for (i = 0; i < st.feats.length; i++) {
      if (foundIdx.indexOf(i) < 0) continue;
      (st.feats[i].isFlaw ? flaws : goods).push(st.feats[i].kind);
    }
    return { flaws: flaws, goods: goods, n: flaws.length + goods.length };
  }

  /**
   * 估价区间：玩家按"**他看到的**"给出的估值。
   * ⚠ 这里**绝不能读 st.base / st.quality / st.trueValue** —— 那些是隐藏信息。
   *   早期版本用了真实底价当基准，结果估价准得离谱：照它出价稳赚，直接变刷钱机
   *   （实测"命中率 0%"的策略每块还能赚 105）。现在的基准是一个**先验常数**
   *   （总体期望，见 PRIOR_MID），只被"找到的特征"修正 —— 也就是说：
   *   你的判断只可能来自你的眼睛。
   *
   * 乘数取的是**实测的条件期望比值**（E[价值|sign]/E[价值]），不是拍脑袋：
   *   蟒带 1.342 · 松花 1.292（80000 块样本）。改种水色分布要重测这两个数 + PRIOR_MID ——
   *   tests/jade.test.cjs 的「先验常数与实测期望一致」就是为这件事上的一道保险：
   *   改了分布忘了重标，它会红（实测抓到过一次：涨特征去重后 E 从 198 涨到 216）。
   */
  function estimateOf(st, foundIdx) {
    var mid = PRIOR_MID, i;
    for (i = 0; i < foundIdx.length; i++) {
      var f = st.feats[foundIdx[i]];
      if (!f) continue;
      if (f.isFlaw) mid *= FLAWS[f.kind].mul;          // 找到的垮特征：确定要打折
      else if (f.kind === "songhua") mid *= 1.292;     // 松花 → 有色概率高
      else if (f.kind === "mangdai") mid *= 1.342;     // 蟒带 → 种老概率高
    }
    /* 找到的越多越有把握 → 区间收窄；但永远收不成一个点（底价看不见） */
    var seen = foundIdx.length;
    var shrink = Math.max(0.42, 1 - seen * 0.13);
    var lo = mid - mid * (1 - PRIOR_LO_MUL) * shrink;
    var hi = mid + mid * (PRIOR_HI_MUL - 1) * shrink;
    return { mid: round10(mid), low: round10(Math.max(0, lo)), high: round10(hi), seen: seen };
  }

  /** 结算：净收益 = 真实价值 − 出价。切开即算，不等一局结束 */
  function settle(st, bid) {
    var v = st.trueValue;
    return { value: v, bid: bid, net: v - bid, jackpot: (v - bid) >= 3000 };
  }

  /* ═══════════════ 3. 渲染 ═══════════════ */

  /** 石头轮廓路径（皮壳裁剪、断面裁剪、边缘描边共用一套，避免三处各画一遍走形） */
  function stonePath(g, geo, mul) {
    var steps = 90, i;
    mul = (mul === undefined) ? 1 : mul;
    g.beginPath();
    for (i = 0; i <= steps; i++) {
      var th = i / steps * Math.PI * 2;
      var R = geo.rx * shapeR(th, geo.k) * mul;
      var x = geo.cx + Math.cos(th) * R, y = geo.cy + Math.sin(th) * R;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  }

  /** 把一块石头烘焙到离屏 canvas（TEX 倍），主视图与放大镜共用这一张 */
  function bakeStone(st) {
    var cv = doc.createElement("canvas");
    cv.width = VIEW.W * TEX; cv.height = VIEW.H * TEX;
    var g = cv.getContext("2d");
    g.save(); g.scale(TEX, TEX);
    var geo = st.geo, rng = makeRng(st.seed ^ 0x9e3779b9);

    /* 皮壳底色（用石头形状裁剪） */
    g.save();
    stonePath(g, geo, 1);
    g.clip();

    var grd = g.createRadialGradient(geo.cx - 60, geo.cy - 70, 30, geo.cx, geo.cy, geo.rx * 1.25);
    grd.addColorStop(0, st.skin.speck);
    grd.addColorStop(0.45, st.skin.base);
    grd.addColorStop(1, st.skin.dark);
    g.fillStyle = grd; g.fillRect(0, 0, VIEW.W, VIEW.H);

    /* 颗粒噪点 + 深浅斑块：**找茬的干扰项**。
       噪点太淡 = 皮壳像塑料，裂纹也没有藏身之处；太强 = 真裂被淹没。
       实测 0.16/0.12 是"放大镜下能分辨、1× 下看不见"的甜点。 */
    var i;
    for (i = 0; i < 1100; i++) {
      var px = rand(rng, 0, VIEW.W), py = rand(rng, 0, VIEW.H);
      if (!insideStone(px, py, geo)) continue;
      g.fillStyle = rng() > 0.5 ? "rgba(0,0,0,.16)" : "rgba(255,255,255,.12)";
      g.fillRect(px, py, rand(rng, 1, 2.8), rand(rng, 1, 2.8));
    }
    for (i = 0; i < 18; i++) {
      var bx = rand(rng, 0, VIEW.W), by = rand(rng, 0, VIEW.H);
      if (!insideStone(bx, by, geo)) continue;
      var br = rand(rng, 26, 74);
      var bg = g.createRadialGradient(bx, by, 2, bx, by, br);
      bg.addColorStop(0, "rgba(0,0,0,.22)"); bg.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = bg; g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.fill();
    }

    /* 特征 */
    for (i = 0; i < st.feats.length; i++) drawFeature(g, st.feats[i], rng);

    /* 皮壳边缘的暗边（立体感） */
    g.lineWidth = 10; g.strokeStyle = "rgba(0,0,0,.45)";
    stonePath(g, geo, 0.985); g.stroke();
    g.restore();
    g.restore();
    return cv;
  }

  function drawFeature(g, f, rng) {
    var i;
    if (f.kind === "lie" || f.kind === "liu") {
      /* 裂 / 绺：带分叉的细折线。裂更长更深，绺短而浅 */
      var isLie = f.kind === "lie";
      var segs = isLie ? 5 : 3;
      var len = isLie ? f.len : f.len * 0.55;
      g.save();
      g.translate(f.x, f.y); g.rotate(f.rot);
      g.strokeStyle = isLie ? "rgba(24,16,10,.92)" : "rgba(40,30,20,.55)";
      g.lineWidth = isLie ? 1.6 : 1.1;
      g.beginPath(); g.moveTo(-len / 2, 0);
      for (i = 1; i <= segs; i++) {
        var sx = -len / 2 + len * (i / segs);
        g.lineTo(sx, rand(rng, -7, 7) * (isLie ? 1 : 0.6));
      }
      g.stroke();
      if (isLie) {
        /* 分叉：裂的辨识特征（放大镜下才明显） */
        g.beginPath();
        var bx = len * 0.1;
        g.moveTo(bx, 0);
        g.lineTo(bx + len * 0.22, rand(rng, -14, -6));
        g.stroke();
      }
      g.restore();
    } else if (f.kind === "jiao") {
      /* 注胶：半透明胶斑，边缘比周围"干净"（少了颗粒感） */
      g.save();
      var jr = f.r;
      var jg = g.createRadialGradient(f.x, f.y, jr * 0.2, f.x, f.y, jr);
      jg.addColorStop(0, "rgba(210,225,215,.42)");
      jg.addColorStop(0.75, "rgba(200,215,205,.26)");
      jg.addColorStop(1, "rgba(200,215,205,0)");
      g.fillStyle = jg;
      g.beginPath(); g.arc(f.x, f.y, jr, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "rgba(235,245,238,.35)"; g.lineWidth = 1;
      g.beginPath(); g.arc(f.x, f.y, jr * 0.86, 0, Math.PI * 2); g.stroke();
      g.restore();
    } else if (f.kind === "jia") {
      /* 假皮：色界生硬的多边形补丁（真皮的色是渐变的） */
      g.save();
      g.translate(f.x, f.y); g.rotate(f.rot);
      var n = 6, pr = f.r * 1.55;
      g.beginPath();
      for (i = 0; i < n; i++) {
        var a = i / n * Math.PI * 2;
        var rr = pr * (0.72 + ((i * 37) % 10) / 26);
        var xx = Math.cos(a) * rr, yy = Math.sin(a) * rr * 0.72;
        if (i === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
      }
      g.closePath();
      g.fillStyle = "rgba(238,222,170,.30)"; g.fill();
      g.strokeStyle = "rgba(255,246,210,.55)"; g.lineWidth = 1.2; g.stroke();
      g.restore();
    } else if (f.kind === "songhua") {
      /* 松花：一簇绿点（越密越"有色"） */
      g.save();
      var dots = 16;
      for (i = 0; i < dots; i++) {
        var th = rand(rng, 0, 6.283), rr2 = Math.sqrt(rng()) * f.r * 1.15;
        var dx = Math.cos(th) * rr2, dy = Math.sin(th) * rr2 * 0.8;
        g.fillStyle = "rgba(46,190,110," + (0.30 + rng() * 0.45).toFixed(2) + ")";
        g.beginPath(); g.arc(f.x + dx, f.y + dy, 1.4 + rng() * 2.4, 0, Math.PI * 2); g.fill();
      }
      g.restore();
    } else if (f.kind === "mangdai") {
      /* 蟒带：一条起伏的带状纹（比松花更"成片"） */
      g.save();
      g.translate(f.x, f.y); g.rotate(f.rot);
      g.beginPath();
      var L = f.len * 1.25, amp = 10;
      g.moveTo(-L / 2, 0);
      for (i = 1; i <= 12; i++) g.lineTo(-L / 2 + L * (i / 12), Math.sin(i * 0.9) * amp);
      g.strokeStyle = "rgba(60,205,125,.42)"; g.lineWidth = 6; g.stroke();
      g.strokeStyle = "rgba(150,255,190,.30)"; g.lineWidth = 2; g.stroke();
      g.restore();
    }
  }

  /* ═══════════════ 4. 运行时 ═══════════════ */

  var ST = null;                 // 当前局（null = 没在玩）
  var CV = null, G = null;       // 主 canvas / 上下文
  var RAF = 0, LAST = 0, ACC = 0;
  var BAKED = null;              // 当前石头的烘焙纹理
  var LIFECYCLE = { rafCancelled: 0, disposed: 0, escBound: 0, escRemoved: 0 };
  var STYLE_ID = "jadeStyle";

  function nowMs() { return (root.performance && root.performance.now) ? root.performance.now() : Date.now(); }

  /** CSS：模块自带（与 mahjong.js 同策略），不与宿主样式耦合 */
  function injectStyle() {
    if (!doc || doc.getElementById(STYLE_ID)) return;
    var css = [
      ".jd-wrap{position:relative;font-family:var(--f,'PingFang SC','Microsoft YaHei',sans-serif);color:#eceaf4}",
      ".jd-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;font-size:12px;color:#8a87a3}",
      ".jd-bar b{color:#ffd76e;font-variant-numeric:tabular-nums}",
      ".jd-timer{flex:1;height:4px;background:#191624;border-radius:2px;overflow:hidden;min-width:90px}",
      ".jd-timer i{display:block;height:100%;width:100%;background:linear-gradient(90deg,#4dd8ff,#5dffa0)}",
      ".jd-timer.low i{background:linear-gradient(90deg,#ff4d6d,#ffd76e)}",
      ".jd-stage{position:relative;background:radial-gradient(ellipse at 50% 40%,#1b1622,#0a0910 78%);border:1px solid #232335;border-radius:6px;overflow:hidden}",
      ".jd-stage canvas{display:block;width:100%;height:auto;cursor:none;touch-action:none}",
      ".jd-tip{margin-top:8px;font-size:11.5px;color:#8a87a3;line-height:1.8;min-height:34px}",
      ".jd-tip b{color:#eceaf4}",
      ".jd-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}",
      ".jd-btn{padding:9px 18px;border:1px solid #3a3752;background:#14121d;color:#eceaf4;font-size:12.5px;letter-spacing:1px;border-radius:3px}",
      ".jd-btn:hover{border-color:#ffd76e;color:#ffd76e}",
      ".jd-btn.primary{border-color:#5dffa0;color:#5dffa0;background:rgba(93,255,160,.06)}",
      ".jd-btn.ghost{border-color:#2a2840;color:#8a87a3}",
      ".jd-btn[disabled]{opacity:.45;cursor:not-allowed}",
      ".jd-btn[disabled]:hover{border-color:#3a3752;color:#eceaf4}",
      ".jd-list{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}",
      ".jd-chip{font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid #3a3752;color:#c6c2da;background:#12101a}",
      ".jd-chip.bad{border-color:#ff4d6d;color:#ff9db1}",
      ".jd-chip.good{border-color:#5dffa0;color:#a8ffcb}",
      ".jd-res{margin-top:10px;padding:11px 13px;border:1px dashed #3a3752;background:#0d0c14;font-size:12.5px;line-height:1.95;border-radius:4px}",
      ".jd-res .big{font-size:17px;font-weight:800}",
      ".jd-res .up{color:#5dffa0} .jd-res .down{color:#ff4d6d}",
      ".jd-hint{font-size:11px;color:#8a87a3;margin-top:6px}",
      ".jd-note{font-size:11px;color:#8a87a3;margin-top:8px;line-height:1.8}"
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

  /** 开一局。host 由宿主给（宿主只负责容器与现金结算） */
  function start(hostEl, opts) {
    try {
      if (!hostEl || typeof hostEl.appendChild !== "function") return false;
      if (ST) dispose();
      opts = opts || {};
      injectStyle();

      var n = (opts.run && opts.run.stones) || TUNE.STONES_PER_RUN;
      ST = {
        host: hostEl,
        cfg: opts,
        stones: [],
        idx: 0,
        phase: "search",           // search | bid | cut | result | summary
        found: [],
        lens: { x: VIEW.W / 2, y: VIEW.H / 2, on: false },
        miss: 0, timeLeft: TUNE.SEARCH_MS, phaseT: 0,
        shake: 0, hintLeft: 0, hintT: 0,
        spend: 0, payout: 0, ups: 0, downs: 0, best: 0, bids: [],
        cutT: 0, last: null, over: false, done: false
      };
      ST.hintLeft = hintCap();
      var i;
      for (i = 0; i < n; i++) ST.stones.push(genStone((Date.now() + i * 7919 + Math.floor(Math.random() * 1e6)) >>> 0));
      loadStone(0);
      buildDom();
      render();
      LAST = nowMs(); ACC = 0;
      if (typeof root.requestAnimationFrame === "function") RAF = root.requestAnimationFrame(loop);
      else RAF = root.setTimeout(function () { loop(nowMs()); }, 16);
      return true;
    } catch (e) {
      try { if (root.console && console.warn) console.warn("[Jade] start 失败", e); } catch (e2) {}
      return false;
    }
  }

  function hintCap() {
    var intel = 0;
    try { intel = ST && ST.cfg.intel ? (+ST.cfg.intel() || 0) : 0; } catch (e) { intel = 0; }
    return Math.min(TUNE.HINT_MAX, TUNE.HINT_BASE + Math.floor(intel / TUNE.HINT_PER_INT));
  }

  function cashNow() {
    try { return ST && ST.cfg.cash ? (+ST.cfg.cash() || 0) : 99999; } catch (e) { return 0; }
  }

  function loadStone(i) {
    ST.idx = i;
    ST.cur = ST.stones[i];
    ST.found = [];
    ST.phase = "search";
    ST.timeLeft = TUNE.SEARCH_MS;
    ST.phaseT = 0;
    ST.miss = 0;
    ST.hintLeft = hintCap();
    ST.hintT = 0;
    ST.lens.x = VIEW.W / 2; ST.lens.y = VIEW.H / 2;
    BAKED = bakeStone(ST.cur);
  }

  function buildDom() {
    var host = ST.host;
    host.innerHTML = "";
    host.classList.add("on");
    var wrap = el("div", "jd-wrap");
    wrap.id = "jdWrap";

    var bar = el("div", "jd-bar");
    bar.innerHTML = '<span>第 <b id="jdIdx">1</b>/<b id="jdTotal">3</b> 块</span>' +
                    '<span>剩余 <b id="jdTime">25.0</b>s</span>' +
                    '<span class="jd-timer" id="jdTimer"><i></i></span>' +
                    '<span>财富 <b id="jdCash">0</b></span>' +
                    '<span id="jdHintWrap">照一照 <b id="jdHint">1</b></span>';

    var stage = el("div", "jd-stage");
    var cv = doc.createElement("canvas");
    cv.className = "jd-cv";
    cv.width = VIEW.W; cv.height = VIEW.H;
    stage.appendChild(cv);

    var tip = el("div", "jd-tip", "");
    tip.id = "jdTip";
    var list = el("div", "jd-list");
    list.id = "jdList";
    var res = el("div", "jd-res");
    res.id = "jdRes"; res.style.display = "none";
    var btns = el("div", "jd-btns");
    btns.id = "jdBtns";

    wrap.appendChild(bar); wrap.appendChild(stage);
    wrap.appendChild(tip); wrap.appendChild(list);
    wrap.appendChild(res); wrap.appendChild(btns);
    host.appendChild(wrap);

    CV = cv; G = cv.getContext("2d");
    bindInput(cv);
    paintUi();
  }

  function bindInput(cv) {
    function toLocal(e) {
      var r = cv.getBoundingClientRect();
      var cx = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
      var cy = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
      return [(cx - r.left) / r.width * VIEW.W, (cy - r.top) / r.height * VIEW.H];
    }
    cv.onmousemove = function (e) { var p = toLocal(e); ST.lens.x = p[0]; ST.lens.y = p[1]; ST.lens.on = true; };
    cv.onmouseleave = function () { ST.lens.on = false; };
    cv.onmousedown = function (e) { e.preventDefault(); var p = toLocal(e); ST.lens.x = p[0]; ST.lens.y = p[1]; ST.lens.on = true; tap(p[0], p[1]); };
    cv.ontouchstart = function (e) { e.preventDefault(); var p = toLocal(e); ST.lens.x = p[0]; ST.lens.y = p[1]; ST.lens.on = true; tap(p[0], p[1]); };
    cv.ontouchmove = function (e) { e.preventDefault(); var p = toLocal(e); ST.lens.x = p[0]; ST.lens.y = p[1]; ST.lens.on = true; };
    cv.ontouchend = function () { ST.lens.on = false; };
    cv.oncontextmenu = function (e) { e.preventDefault(); };
  }

  /** 打标：命中特征就记入料单；空点扣时 + 抖一下 */
  function tap(x, y) {
    if (!ST || ST.phase !== "search") return null;
    var i, best = -1, bestD = 1e9;
    for (i = 0; i < ST.cur.feats.length; i++) {
      if (ST.found.indexOf(i) >= 0) continue;
      var f = ST.cur.feats[i];
      var d = Math.sqrt((f.x - x) * (f.x - x) + (f.y - y) * (f.y - y));
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && bestD <= TUNE.HIT_R) {
      ST.found.push(best);
      sfx(ST.cur.feats[best].isFlaw ? "sfx-stock-down" : "sfx-stock-up");
      paintUi();
      return { hit: true, kind: ST.cur.feats[best].kind, isFlaw: ST.cur.feats[best].isFlaw, d: Math.round(bestD) };
    }
    ST.miss++;
    ST.timeLeft = Math.max(0, ST.timeLeft - TUNE.MISS_PENALTY_MS);
    ST.shake = 1;
    sfx("sfx-fight-whiff");
    paintUi();
    return { hit: false, d: Math.round(bestD) };
  }

  /** 照一照：在随机位置闪一次探照；附近有未发现的特征就高亮它 */
  function hint() {
    if (!ST || ST.phase !== "search") return false;
    if (ST.hintLeft <= 0) return false;
    ST.hintLeft--;
    var un = [], i;
    for (i = 0; i < ST.cur.feats.length; i++) if (ST.found.indexOf(i) < 0) un.push(i);
    var pickIdx = un.length ? un[Math.floor(Math.random() * un.length)] : -1;
    ST.hintT = TUNE.HINT_MS;
    ST.hintAt = pickIdx >= 0 ? { x: ST.cur.feats[pickIdx].x, y: ST.cur.feats[pickIdx].y } : null;
    sfx("sfx-quiz-tick");
    paintUi();
    return true;
  }

  function bid(tier) {
    if (!ST || ST.phase !== "bid") return false;
    var price = TUNE.PRICES[tier];
    if (price === undefined) return false;
    if (price > cashNow() - ST.spend) return false;     // 本金不够，本档不可选
    ST.spend += price;
    ST.bids.push(price);
    ST.phase = "cut";
    ST.cutT = 0;
    ST.pendingBid = price;
    sfx("sfx-mj-chip");
    paintUi();
    return true;
  }

  function walkAway() {
    if (!ST || ST.phase !== "bid") return false;
    ST.phase = "result";
    ST.last = { value: ST.cur.trueValue, bid: 0, net: 0, walked: true };
    sfx("sfx-talk-break");
    paintUi();
    return true;
  }

  function commitCut() {
    var r = settle(ST.cur, ST.pendingBid);
    ST.payout += r.value;
    ST.last = r;
    if (r.net > 0) ST.ups++; else if (r.net < 0) ST.downs++;
    if (r.net > ST.best) ST.best = r.net;
    ST.phase = "result";
    sfx(r.net > 0 ? "sfx-stock-up" : "sfx-stock-down");
    if (r.net > 0) { try { if (root.AudioSys && AudioSys.good) AudioSys.good(); } catch (e) {} }
    try { if (ST.cfg.onSettle) ST.cfg.onSettle(r.net, { value: r.value, bid: r.bid, stone: ST.idx, jackpot: r.jackpot }); } catch (e) {}
    paintUi();
  }

  function nextStone() {
    if (!ST) return false;
    if (ST.idx + 1 < ST.stones.length) { loadStone(ST.idx + 1); paintUi(); return true; }
    ST.phase = "summary"; ST.over = true;
    paintUi();
    return true;
  }

  function finishRun() {
    if (!ST || ST.done) return false;
    ST.done = true;
    var sum = {
      stones: ST.idx + 1, spend: ST.spend, payout: ST.payout, net: ST.payout - ST.spend,
      ups: ST.ups, downs: ST.downs, best: ST.best, bids: ST.bids.slice()
    };
    try { if (ST.cfg.onFinish) ST.cfg.onFinish(sum); } catch (e) {}
    return sum;
  }

  function sfx(name) {
    try { if (root.AudioSys && AudioSys.play) AudioSys.play(name); } catch (e) {}
  }

  /* ── 每帧 ── */
  function loop() {
    if (!ST) return;
    var t = nowMs(), dt = t - LAST; LAST = t;
    if (dt > 200) dt = 200;
    ACC += dt;
    var steps = 0;
    while (ACC >= 16.7 && steps < 6) { step(16.7); ACC -= 16.7; steps++; }
    render();
    if (typeof root.requestAnimationFrame === "function") RAF = root.requestAnimationFrame(loop);
    else RAF = root.setTimeout(function () { loop(nowMs()); }, 16);
  }

  function step(dt) {
    if (!ST) return;
    if (ST.shake > 0) ST.shake = Math.max(0, ST.shake - dt / 260);
    if (ST.hintT > 0) ST.hintT = Math.max(0, ST.hintT - dt);
    if (ST.phase === "search") {
      ST.timeLeft -= dt;
      if (ST.timeLeft <= 0) { ST.timeLeft = 0; ST.phase = "bid"; paintUi(); }
      else if (Math.floor(ST.timeLeft / 1000) !== ST._lastSec) { ST._lastSec = Math.floor(ST.timeLeft / 1000); paintUi(); }
    } else if (ST.phase === "cut") {
      ST.cutT += dt;
      if (ST.cutT >= TUNE.CUT_MS && !ST.last) commitCut();
    }
  }

  /* ── 绘制 ── */
  function render() {
    if (!G || !ST) return;
    var g = G;
    g.clearRect(0, 0, VIEW.W, VIEW.H);
    g.save();
    if (ST.shake > 0) {
      var s = ST.shake * 6;
      g.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    if (BAKED) {
      if (ST.phase === "cut") drawCut(g);
      else {
        g.drawImage(BAKED, 0, 0, VIEW.W, VIEW.H);
        drawFoundMarks(g);
        drawHintFlash(g);
        if (ST.phase === "search") drawLens(g);
      }
    }
    g.restore();
    drawVignette(g);
  }

  function drawFoundMarks(g) {
    var i;
    for (i = 0; i < ST.found.length; i++) {
      var f = ST.cur.feats[ST.found[i]];
      if (!f) continue;
      g.save();
      g.strokeStyle = f.isFlaw ? "rgba(255,77,109,.95)" : "rgba(93,255,160,.95)";
      g.lineWidth = 1.6;
      g.beginPath(); g.arc(f.x, f.y, 15, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(f.x - 20, f.y - 20); g.lineTo(f.x - 9, f.y - 9); g.stroke();
      g.fillStyle = f.isFlaw ? "rgba(255,77,109,.95)" : "rgba(93,255,160,.95)";
      g.font = "bold 11px sans-serif";
      g.fillText((f.isFlaw ? FLAWS[f.kind].n : GOODS[f.kind].n), f.x + 19, f.y - 16);
      g.restore();
    }
  }

  function drawHintFlash(g) {
    if (ST.hintT <= 0 || !ST.hintAt) return;
    var a = ST.hintT / TUNE.HINT_MS;
    g.save();
    g.strokeStyle = "rgba(77,216,255," + (0.85 * a).toFixed(2) + ")";
    g.lineWidth = 2;
    g.beginPath(); g.arc(ST.hintAt.x, ST.hintAt.y, 26 + (1 - a) * 16, 0, Math.PI * 2); g.stroke();
    g.restore();
  }

  function drawLens(g) {
    if (!ST.lens.on) return;
    var lx = ST.lens.x, ly = ST.lens.y, R = TUNE.LENS_R;
    g.save();
    /* 视野外压暗：注意力集中在镜内。
       0.55 压得太狠 —— 实测截图里整块皮壳黑成一片，玩家连"该把镜子挪到哪"都看不出来。
       0.38 是"镜内明显更清楚、镜外仍看得出质地走向"的分界。 */
    g.beginPath(); g.rect(0, 0, VIEW.W, VIEW.H);
    g.arc(lx, ly, R, 0, Math.PI * 2, true);
    g.fillStyle = "rgba(4,4,8,.38)"; g.fill();
    /* 镜内：同一张纹理放大 LENS_ZOOM 倍 */
    g.save();
    g.beginPath(); g.arc(lx, ly, R, 0, Math.PI * 2); g.clip();
    g.translate(lx, ly); g.scale(TUNE.LENS_ZOOM, TUNE.LENS_ZOOM); g.translate(-lx, -ly);
    g.drawImage(BAKED, 0, 0, VIEW.W, VIEW.H);
    g.restore();
    /* 镜框 + 十字线 */
    g.strokeStyle = "rgba(236,234,244,.75)"; g.lineWidth = 2;
    g.beginPath(); g.arc(lx, ly, R, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = "rgba(236,234,244,.22)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(lx - 8, ly); g.lineTo(lx + 8, ly);
    g.moveTo(lx, ly - 8); g.lineTo(lx, ly + 8); g.stroke();
    g.restore();
  }

  function drawVignette(g) {
    var vg = g.createRadialGradient(VIEW.W / 2, VIEW.H / 2, VIEW.H * 0.32, VIEW.W / 2, VIEW.H / 2, VIEW.H * 0.78);
    vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,.55)");
    g.fillStyle = vg; g.fillRect(0, 0, VIEW.W, VIEW.H);
  }

  /** 切石动画：切割线扫过 → 断面分开 → 露出种水与内部裂纹
      ⚠ 顺序很关键：**先画断面（内部），再把两半皮壳盖上去**。
        反过来画的话，断面会糊在皮壳外面，看着像"贴了张白纸"（实测截图确认过）。 */
  function drawCut(g) {
    var t = Math.min(1, ST.cutT / TUNE.CUT_MS);
    var geo = ST.cur.geo;
    var split = Math.max(0, (t - 0.45) / 0.55) * 26;
    g.save();
    /* 断面：裁在石头轮廓内，随两半分开而露出中间那一条 */
    g.save();
    stonePath(g, geo, 1); g.clip();
    drawInner(g, geo, t);
    g.restore();
    /* 两半皮壳（各裁自己的半平面，再朝相反方向分开） */
    g.save();
    g.beginPath(); g.rect(0, 0, VIEW.W, geo.cy);
    g.clip(); g.translate(0, -split); g.drawImage(BAKED, 0, 0, VIEW.W, VIEW.H); g.restore();
    g.save();
    g.beginPath(); g.rect(0, geo.cy, VIEW.W, VIEW.H - geo.cy);
    g.clip(); g.translate(0, split); g.drawImage(BAKED, 0, 0, VIEW.W, VIEW.H); g.restore();
    /* 切割线（前半程扫过） */
    if (t < 0.5) {
      var p = t / 0.5;
      var y = geo.cy - geo.rx + geo.rx * 2 * p;
      g.strokeStyle = "rgba(255,255,255,.9)"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(geo.cx - geo.rx, y); g.lineTo(geo.cx + geo.rx, y); g.stroke();
      g.strokeStyle = "rgba(77,216,255,.5)"; g.lineWidth = 6; g.stroke();
    }
    g.restore();
  }

  function drawInner(g, geo, t) {
    var q = ST.cur.quality, c = ST.cur.color;
    g.save();
    /* 整个轮廓内部都是"肉"（切面就是这个颜色），而不是中间画一个椭圆 ——
       两半分开时露出来的那条缝才读得成"切开面"。 */
    var grd = g.createRadialGradient(geo.cx - 40, geo.cy - 30, 20, geo.cx, geo.cy, geo.rx * 1.1);
    grd.addColorStop(0, q.col); grd.addColorStop(0.7, q.inner); grd.addColorStop(1, "#39443f");
    g.fillStyle = grd;
    stonePath(g, geo, 1); g.fill();
    /* 色：阳绿/飘花在内部可见 */
    if (c.id !== "wu") {
      g.fillStyle = c.col; g.globalAlpha = c.id === "yanglv" ? 0.55 : 0.35;
      var i;
      for (i = 0; i < (c.id === "yanglv" ? 5 : 8); i++) {
        var a = i * 1.7, rr = geo.rx * (0.18 + (i % 4) * 0.16);
        g.beginPath();
        g.ellipse(geo.cx + Math.cos(a) * rr * 0.6, geo.cy + Math.sin(a) * rr * 0.4,
                  geo.rx * 0.22, geo.rx * 0.12, a, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    }
    /* 内部裂纹：**未发现的**垮特征在这里显形（教学点） */
    var i2;
    for (i2 = 0; i2 < ST.cur.feats.length; i2++) {
      var f = ST.cur.feats[i2];
      if (!f.isFlaw || ST.found.indexOf(i2) >= 0) continue;
      g.strokeStyle = "rgba(20,12,8,.85)"; g.lineWidth = f.kind === "lie" ? 2.2 : 1.2;
      g.beginPath();
      g.moveTo(f.x - f.len / 2, f.y);
      g.lineTo(f.x - f.len * 0.1, f.y + 5);
      g.lineTo(f.x + f.len / 2, f.y - 4);
      g.stroke();
    }
    g.restore();
  }

  /* ── UI 文本 ── */
  function paintUi() {
    if (!ST || !doc) return;
    var wrap = doc.getElementById("jdWrap");
    if (!wrap) return;
    var set = function (id, html) { var e = doc.getElementById(id); if (e) e.innerHTML = html; };
    set("jdIdx", String(ST.idx + 1));
    set("jdTotal", String(ST.stones.length));
    /* 只有相玉阶段才有倒计时；切开/结算阶段显示"—"（否则会出现"正在切石却还剩 25 秒"的怪象） */
    var searching = ST.phase === "search";
    set("jdTime", searching ? (ST.timeLeft / 1000).toFixed(1) : "—");
    set("jdCash", String(cashNow() - ST.spend));
    set("jdHint", String(ST.hintLeft));
    var tm = doc.getElementById("jdTimer");
    if (tm) {
      var r = searching ? Math.max(0, ST.timeLeft / TUNE.SEARCH_MS) : 0;
      tm.firstChild.style.width = (r * 100).toFixed(1) + "%";
      tm.className = "jd-timer" + (searching && r < 0.3 ? " low" : "");
    }
    var hw = doc.getElementById("jdHintWrap");
    if (hw) hw.style.opacity = ST.phase === "search" ? "1" : ".45";

    var tip = doc.getElementById("jdTip");
    var list = doc.getElementById("jdList");
    var res = doc.getElementById("jdRes");
    var btns = doc.getElementById("jdBtns");
    if (!tip || !list || !res || !btns) return;

    var l = listOf(ST.cur, ST.found);
    var est = estimateOf(ST.cur, ST.found);
    var chips = [];
    var i;
    for (i = 0; i < l.goods.length; i++) chips.push('<span class="jd-chip good">' + GOODS[l.goods[i]].n + "</span>");
    for (i = 0; i < l.flaws.length; i++) chips.push('<span class="jd-chip bad">' + FLAWS[l.flaws[i]].n + "</span>");
    list.innerHTML = chips.length ? chips.join("") : '<span class="jd-chip">料单还是空的</span>';

    if (ST.phase === "search") {
      tip.innerHTML = '拖动鼠标用<b>放大镜</b>看皮壳（镜内 ' + TUNE.LENS_ZOOM + "× 放大），点一下打标 —— " +
        '<b>找裂、找注胶、看松花蟒带</b>。空点扣 ' + (TUNE.MISS_PENALTY_MS / 1000) + "s。";
      res.style.display = "none";
      btns.innerHTML = "";
      var hb = el("button", "jd-btn" + (ST.hintLeft ? "" : " ghost"), "🔍 照一照（" + ST.hintLeft + "）");
      hb.disabled = !ST.hintLeft;
      hb.onclick = function () { hint(); };
      btns.appendChild(hb);
      var nb = el("button", "jd-btn ghost", "看不准，直接出价 ▸");
      nb.onclick = function () { ST.phase = "bid"; paintUi(); };
      btns.appendChild(nb);
      if (ST.miss) tip.innerHTML += ' <span style="color:#ff7d9c">空点 ' + ST.miss + " 次</span>";
    } else if (ST.phase === "bid") {
      tip.innerHTML = "你的判断：<b>¥" + est.low + " – ¥" + est.high + "</b>（找到 " + est.seen + " 处特征）。" +
        "出价买下它，切开才见分晓 —— <b>没找到的裂，切开后照样扣钱</b>。";
      res.style.display = "none";
      btns.innerHTML = "";
      var cash = cashNow() - ST.spend;
      for (i = 0; i < TUNE.PRICES.length; i++) {
        (function (k) {
          var p = TUNE.PRICES[k];
          var ok = p <= cash;
          var b = el("button", "jd-btn" + (k === 1 ? " primary" : ""), "出价 ¥" + p);
          b.disabled = !ok;
          b.title = ok ? "" : "财富不足（需 ¥" + p + "，可用 ¥" + cash + "）";
          b.onclick = function () { bid(k); };
          btns.appendChild(b);
        })(i);
      }
      var wb = el("button", "jd-btn ghost", "不买，走人");
      wb.onclick = function () { walkAway(); };
      btns.appendChild(wb);
    } else if (ST.phase === "cut") {
      tip.innerHTML = "一刀下去……";
      res.style.display = "none";
      btns.innerHTML = "";
    } else if (ST.phase === "result") {
      var r = ST.last;
      if (r.walked) {
        tip.innerHTML = "你放下了这块料。摊主哼了一声：「看不上？回头别后悔。」";
        res.innerHTML = '<div class="jd-hint">这块料的真实价值是 <b>¥' + r.value + "</b></div>";
      } else {
        var gain = r.net >= 0;
        var missed = [];
        for (i = 0; i < ST.cur.feats.length; i++) {
          var f = ST.cur.feats[i];
          if (f.isFlaw && ST.found.indexOf(i) < 0) missed.push(FLAWS[f.kind].n);
        }
        res.innerHTML =
          '<div class="big">开窗：<b style="color:' + ST.cur.quality.col + '">' + ST.cur.quality.n + "</b> · " +
          '<b style="color:' + ST.cur.color.col + '">' + ST.cur.color.n + "</b></div>" +
          "真实价值 <b>¥" + r.value + "</b> · 出价 <b>¥" + r.bid + "</b> · " +
          '<span class="' + (gain ? "up" : "down") + '">' + (gain ? "涨" : "垮") + " <b>" +
          (gain ? "+" : "") + r.net + "</b></span>" +
          (missed.length ? '<div class="jd-hint" style="color:#ff7d9c">没找到的 ' + missed.join("、") +
            "：切开后照样按比例扣钱 —— 这就是眼力的价钱。</div>" : '<div class="jd-hint" style="color:#5dffa0">该看的都看到了。</div>') +
          (r.jackpot ? '<div class="jd-hint" style="color:#ffd76e">✦ 一刀富</div>' : "");
        tip.innerHTML = "第 " + (ST.idx + 1) + " 块切完了。";
      }
      res.style.display = "";
      btns.innerHTML = "";
      var has = ST.idx + 1 < ST.stones.length;
      var nb2 = el("button", "jd-btn primary", has ? "下一块 ▸" : "收摊看账 ▸");
      nb2.onclick = function () { if (ST.phase === "result") { ST.last = null; nextStone(); } };
      btns.appendChild(nb2);
    } else if (ST.phase === "summary") {
      var net = ST.payout - ST.spend;
      tip.innerHTML = "收摊。";
      res.innerHTML =
        '<div class="big">本局净收支 <span class="' + (net >= 0 ? "up" : "down") + '">' +
        (net >= 0 ? "+" : "") + net + "</span></div>" +
        "开出 " + ST.idx + 1 + " 块 · 投入 ¥" + ST.spend + " · 回收 ¥" + ST.payout + "<br>" +
        "涨 " + ST.ups + " · 垮 " + ST.downs + " · 最好的一块 " + (ST.best > 0 ? "+¥" + ST.best : "—");
      res.style.display = "";
      btns.innerHTML = "";
      var fb = el("button", "jd-btn primary", "收摊");
      fb.onclick = function () { finishRun(); };
      btns.appendChild(fb);
    }
  }

  /* ── 收尾 ── */
  function dispose() {
    if (RAF) {
      if (typeof root.cancelAnimationFrame === "function") root.cancelAnimationFrame(RAF);
      else root.clearTimeout(RAF);
      LIFECYCLE.rafCancelled++;
    }
    RAF = 0;
    if (ST && ST.host) {
      try { ST.host.innerHTML = ""; ST.host.classList.remove("on"); } catch (e) {}
    }
    ST = null; CV = null; G = null; BAKED = null;
    LIFECYCLE.disposed++;
    return true;
  }

  /* ═══════════════ 5. 对外 API ═══════════════ */
  var rules = {
    TUNE: TUNE, VIEW: VIEW, SPEC: { SKINS: SKINS, FLAWS: FLAWS, GOODS: GOODS, QUALITY: QUALITY, COLOR: COLOR,
      BASE_MIN: BASE_MIN, BASE_MAX: BASE_MAX, FLAW_COUNT_P: FLAW_COUNT_P, GOOD_COUNT_P: GOOD_COUNT_P,
      PRIOR_MID: PRIOR_MID, PRIOR_LO_MUL: PRIOR_LO_MUL, PRIOR_HI_MUL: PRIOR_HI_MUL },
    PRICES: TUNE.PRICES,
    makeRng: makeRng, genStone: genStone, trueValueOf: trueValueOf,
    flawsOf: flawsOf, goodsOf: goodsOf, listOf: listOf, estimateOf: estimateOf, settle: settle,
    insideStone: insideStone, shapeR: shapeR
  };

  root.Jade = {
    version: "jade-1.0",
    TUNE: TUNE, VIEW: VIEW,
    start: start, isBusy: function () { return !!ST; }, dispose: dispose,
    rules: rules,
    debug: {
      state: function () {
        if (!ST) return null;
        return {
          running: true, phase: ST.phase, idx: ST.idx, total: ST.stones.length,
          timeLeft: Math.round(ST.timeLeft), miss: ST.miss, hintLeft: ST.hintLeft,
          found: ST.found.slice(), foundKinds: ST.found.map(function (i) { return ST.cur.feats[i].kind; }),
          lensOn: !!ST.lens.on, spend: ST.spend, payout: ST.payout,
          net: ST.payout - ST.spend, ups: ST.ups, downs: ST.downs, best: ST.best,
          last: ST.last, over: ST.over, done: ST.done
        };
      },
      stone: function (i) {
        if (!ST) return null;
        var st = (i === undefined) ? ST.cur : ST.stones[i];
        if (!st) return null;
        return {
          seed: st.seed, skin: st.skin.id, quality: st.quality.id, color: st.color.id,
          base: st.base, trueValue: st.trueValue,
          feats: st.feats.map(function (f) { return { kind: f.kind, isFlaw: f.isFlaw, x: Math.round(f.x), y: Math.round(f.y) }; }),
          flawCount: flawsOf(st).length, goodCount: goodsOf(st).length
        };
      },
      found: function () {
        if (!ST) return [];
        return ST.found.map(function (i) {
          var f = ST.cur.feats[i];
          return { kind: f.kind, isFlaw: f.isFlaw, x: Math.round(f.x), y: Math.round(f.y) };
        });
      },
      list: function () { return ST ? listOf(ST.cur, ST.found) : null; },
      estimate: function () { return ST ? estimateOf(ST.cur, ST.found) : null; },
      lens: function (x, y) { if (!ST) return false; ST.lens.x = x; ST.lens.y = y; ST.lens.on = true; return true; },
      tap: function (x, y) { return tap(x, y); },
      hint: function () { return hint(); },
      bid: function (i) { return bid(i); },
      walk: function () { return walkAway(); },
      skipSearch: function () { if (ST && ST.phase === "search") { ST.phase = "bid"; paintUi(); return true; } return false; },
      /* 把切石动画直接推到终点并结算。**给无头验收用**：headless 里 rAF 推进很慢，
         等 1 秒动画会把整个验收拖垮（实测 --virtual-time-budget 30s 都截在动画中途）。
         与 breakfast 的 debug.finishNow 同一用途，不属于规格。 */
      cutNow: function () {
        if (!ST || ST.phase !== "cut") return false;
        ST.cutT = TUNE.CUT_MS;
        if (!ST.last) commitCut();
        paintUi(); render();
        return true;
      },
      next: function () { if (ST && ST.phase === "result") { ST.last = null; return nextStone(); } return false; },
      finishRun: function () { return finishRun(); },
      finishNow: function () { if (!ST) return false; if (ST.phase === "cut") commitCut(); return finishRun(); },
      cash: function () { return cashNow() - (ST ? ST.spend : 0); },
      lifecycle: function () { return { rafCancelled: LIFECYCLE.rafCancelled, disposed: LIFECYCLE.disposed }; }
    }
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
