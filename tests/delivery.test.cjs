// 「您好，您的外卖」· 小区送餐 —— 纯逻辑单测
// 运行：node tests/delivery.test.cjs
//
// 测什么、为什么不测别的：
//   这个玩法的风险全在两处，UI 反而不会出错：
//     ① **伪 3D 投射数学**。这类 bug 肉眼极难定位（"精灵飘在空中""山坡穿模"
//        到底是投射错了还是精灵尺寸错了？），只有把 project() 抽成纯函数才验得动。
//     ② **数值**。逆行如果偷偷给分、或者赔付阶梯把某个模式变成印钞机，
//        游戏的立意就塌了 —— 而这两种错误都不会让画面出任何问题。
//   所以这里一条像素都不测，只锁：
//     ① 投射数学（路中心、景深反比、近平面丢弃）
//     ② 路线生成的确定性、规模、以及"订单/红灯柜/危险"的位置约束
//     ③ 投递判定的三条轴（灯色 / 时机 / 身位）在**边界值**上的行为
//     ④ 计分表的结构：没有 violation 这一项 —— 逆行在结构上就加不了分
//     ⑤ 经济不变量（相对 E[value]，绝不写死元数）
//   改 delivery.js 的 TUNE / PAYOUT / MODES / HAZARDS / buildRoute / judgeDeliver
//   之后**必须**重跑本文件。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "delivery.js"), "utf8");

function load() {
  const ctx = vm.createContext({ console: console });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInContext(SRC, ctx);
  return ctx.Delivery;
}
const D = load();
const R = D.rules;
const T = R.TUNE;

/* ── 工具 ── */
function meanNet(mode, skill, opt, n, seed0) {
  let sum = 0;
  n = n || 150; seed0 = seed0 || 90000;   // 采样量：断言之间的分离度很大（−16 vs +29），150 局足够区分
  for (let i = 0; i < n; i++) sum += R.simulateShift(mode, skill, seed0 + i, opt).net;
  return sum / n;
}
function meanScore(mode, skill, opt, n, seed0) {
  let sum = 0;
  n = n || 150; seed0 = seed0 || 90000;   // 采样量：断言之间的分离度很大（−16 vs +29），150 局足够区分
  for (let i = 0; i < n; i++) sum += R.simulateShift(mode, skill, seed0 + i, opt).scoreNoSpeed;
  return sum / n;
}

/* ═══════════════ ① 模块形状与投射数学 ═══════════════ */

test("模块对外形状符合规格", () => {
  assert.equal(typeof D.start, "function");
  assert.equal(typeof D.isBusy, "function");
  assert.equal(typeof D.dispose, "function");
  assert.equal(typeof D.version, "string");
  assert.equal(typeof D.debug.state, "function");
  assert.equal(typeof D.debug.act, "function");
  assert.equal(typeof D.debug.tick, "function");
  assert.equal(typeof D.debug.aimAt, "function");
  assert.equal(typeof D.debug.lifecycle, "function");
  assert.equal(typeof T.ENTRY, "number");
  assert.ok(Object.keys(R.MODES).length >= 3, "至少三种模式");
  assert.ok(Object.keys(R.PAYOUT).length === Object.keys(R.MODES).length, "每个模式都要有自己的赔付阶梯");
});

test("投射：路中心永远投在屏幕正中，且 w 与相机深度严格成反比", () => {
  const depth = 1 / Math.tan((T.FOV / 2) * Math.PI / 180);
  const W = 800, H = 450;
  const mk = (z) => ({ world: { x: 0, y: 0, z: z }, camera: {}, screen: {} });

  // 路中心（x=0 且相机也在路中心）→ screen.x 必须正好是 W/2
  const a = mk(2000);
  assert.equal(R.project(a, 0, T.CAM_H, 1000, depth, W, H, T.ROAD_W), true);
  assert.equal(a.screen.x, W / 2, "路中心必须在屏幕正中");

  // 距离翻倍（camera.z 1000 → 2000）→ w 减半
  const b = mk(3000);
  R.project(b, 0, T.CAM_H, 1000, depth, W, H, T.ROAD_W);
  assert.equal(Math.round(a.screen.w / 2), b.screen.w, "camera.z 翻倍则路面宽度减半");

  // w 的定义必须与 scale 自洽：w = scale × roadWidth × W/2
  assert.equal(a.screen.w, Math.round(a.screen.scale * T.ROAD_W * W / 2));

  // 近平面：camera.z <= cameraDepth 必须丢弃（否则会出现除以极小值、路面炸到满屏）
  const c = mk(1000.5);
  assert.equal(R.project(c, 0, T.CAM_H, 1000, depth, W, H, T.ROAD_W), false, "相机后面的点必须丢弃");

  // 横向偏移的方向：x 变大 → screen.x 变大（右）
  const e = mk(2000); e.world.x = 1000;
  R.project(e, 0, T.CAM_H, 1000, depth, W, H, T.ROAD_W);
  assert.ok(e.screen.x > W / 2, "世界坐标偏右必须投到屏幕右半边");
});

/* ═══════════════ ② 路线生成 ═══════════════ */

test("路线：同种子逐段完全相同（截图、复现 bug、蒙卡都靠这个）", () => {
  const a = R.buildRoute(3, 4242, "week");
  const b = R.buildRoute(3, 4242, "week");
  assert.equal(a.total, b.total);
  for (let i = 0; i < a.total; i++) {
    assert.equal(a.segments[i].curve, b.segments[i].curve, "第 " + i + " 段弯度不一致");
    assert.equal(a.segments[i].p2.world.y, b.segments[i].p2.world.y, "第 " + i + " 段高度不一致");
  }
  const c = R.buildRoute(3, 4243, "week");
  let same = (a.total === c.total);
  if (same) {
    same = true;
    for (let i = 0; i < a.total; i++) if (a.segments[i].curve !== c.segments[i].curve) { same = false; break; }
  }
  assert.equal(same, false, "换种子必须换路线");
});

test("路线：赛道长度必须远大于绘制距离（否则会看到赛道自己接上）", () => {
  for (let d = 1; d <= 7; d++) {
    const r = R.buildRoute(d, 777, "week");
    assert.ok(r.total > T.DRAW_DIST * 3,
      "第 " + d + " 天只有 " + r.total + " 段，不足 DRAW_DIST(" + T.DRAW_DIST + ") 的 3 倍");
    // 段是首尾相接的闭合环线：z 必须严格递增且首尾刚好差一段
    assert.equal(r.segments[0].p1.world.z, 0);
    assert.equal(r.segments[r.total - 1].p2.world.z, r.length);
    assert.equal(r.length, r.total * T.SEG_LEN);
  }
});

test("路线：环线必须在**垂直方向**闭合（否则骑过终点线路面会整块消失）", () => {
  /* 这条是截图里逮到的真 bug：赛道是环形的，但生成时没把高度收回起点，
     末端 world.y 攒到 ±2000 而第 0 段仍是 0 —— 骑过终点线后前方所有段都比相机低一大截，
     投影落到屏幕下方被 maxy 全部剔除，表现为"路面整块消失、只剩最近一段"，
     看起来像骑进虚空。逻辑层完全测不出来（分数、判位、经济全都正常）。
     闭合条件：最后一段的终点高度必须回到第一段的起点高度。 */
  for (let d = 1; d <= 7; d++) {
    for (const modeId of Object.keys(R.MODES)) {
      const r = R.buildRoute(d, 909, modeId);
      const y0 = r.segments[0].p1.world.y;
      const yN = r.segments[r.total - 1].p2.world.y;
      assert.ok(Math.abs(yN - y0) < 1,
        "第 " + d + " 天（" + modeId + "）环线高度不闭合：起点 " + y0 + " → 终点 " + yN);
      // 收尾的坡不能太陡：40 段内落差超过 400 单位就成了断崖
      let maxDrop = 0;
      for (let i = 1; i < r.total; i++) {
        if (i > r.total - 80) {
          maxDrop = Math.max(maxDrop, Math.abs(r.segments[i].p2.world.y - r.segments[i - 1].p2.world.y));
        }
      }
      assert.ok(maxDrop < 400, "收尾处单段落差 " + maxDrop.toFixed(0) + " 单位，太陡");
      // 环线接缝处也不该有横向折角：接缝那一段的弯度必须接近 0
      const seamCurve = Math.abs(r.segments[r.total - 1].curve) + Math.abs(r.segments[0].curve);
      assert.ok(seamCurve < 6, "环线接缝处弯度 " + seamCurve.toFixed(1) + " 太大，接缝会看出折角");
    }
  }
});

test("路线：每天的订单数按模式表来，危险密度随天递增", () => {
  const mode = R.MODES.week;
  let prevHaz = -1;
  for (let d = 1; d <= 7; d++) {
    const r = R.buildRoute(d, 31337, "week");
    assert.equal(r.orders.length, mode.orders[d - 1], "第 " + d + " 天订单数不符");
    const perSeg = r.hazards.length / r.total;
    assert.ok(perSeg > prevHaz, "第 " + d + " 天的危险密度没有比前一天更密");
    prevHaz = perSeg;
  }
});

test("路线：所有目标/危险都落在赛道内，红灯柜不与订单挤在一起", () => {
  for (const modeId of Object.keys(R.MODES)) {
    for (let d = 1; d <= 7; d++) {
      const r = R.buildRoute(d, 5150, modeId);
      const seen = new Set();
      for (const o of r.orders) {
        assert.ok(o.seg >= 0 && o.seg < r.total, "订单越界");
        assert.ok(!seen.has(o.seg), "同一段上挤了两张订单（准星环会打架）");
        seen.add(o.seg);
        assert.ok(o.side === -1 || o.side === 1, "订单必须有左右侧");
        assert.ok(o.kind === "locker" || o.kind === "handoff");
        assert.equal(o.state, "pending");
      }
      for (const dc of r.decoys) {
        assert.equal(dc.lit, "red", "红灯柜必须是红灯");
        assert.ok(dc.seg >= 0 && dc.seg < r.total);
        /* 红灯柜与任何订单都必须隔开**至少一个投掷窗口**：
           否则两者会同时进入投掷窗口，"投哪一个"就取决于谁离得近，
           而不是取决于玩家有没有读灯 —— 这条判断轴就废了。 */
        for (const o of r.orders) {
          assert.ok(Math.abs(o.seg - dc.seg) >= T.APPROACH,
            "红灯柜与订单 #" + o.n + " 只差 " + Math.abs(o.seg - dc.seg) + " 段（< 窗口 " + T.APPROACH + "），读灯判断被模糊掉");
        }
      }
      for (const hz of r.hazards) {
        assert.ok(hz.seg >= 0 && hz.seg < r.total, "危险越界");
        assert.ok(R.HAZARDS[hz.kind], "未登记的危险种类 " + hz.kind);
        assert.equal(hz.tier, R.HAZARDS[hz.kind].tier, "两级归类必须来自危险表");
        assert.ok(Math.abs(hz.x) <= 1, "危险横向偏移越界");
      }
      assert.ok(r.items.filter((i) => i.t === "pickup").length >= 3, "补餐点太少，保温箱会见底");
      assert.ok(r.helps.length >= 2, "帮带点太少");
      assert.ok(r.parTime > 0);
    }
  }
});

/* ═══════════════ ③ 投递判定的三条轴 ═══════════════ */

test("判定·时机：窗口内外与甜区上下沿的边界行为", () => {
  const order = { z: 100000, side: 1 };
  const win = T.APPROACH * T.SEG_LEN;
  const at = (t) => R.judgeDeliver(order, order.z - (1 - t) * win, 0.6, false);

  // 还没进窗口
  const before = at(-0.01);
  assert.equal(before.t, -2, "未进窗口应返回哨兵 -2");
  assert.equal(before.ok, false);

  // 甜区正中
  const mid = at(T.SWEET);
  assert.equal(mid.ok, true);
  assert.equal(mid.perfect, true);

  // 甜区上沿（含等号）
  assert.equal(at(T.SWEET + T.SWEET_TOL).perfect, true, "甜区上沿应算精准（闭区间）");
  assert.equal(at(T.SWEET - T.SWEET_TOL).perfect, true, "甜区下沿应算精准（闭区间）");
  // 刚出甜区：还算命中，但不再精准
  assert.equal(at(T.SWEET + T.SWEET_TOL + 0.01).perfect, false);
  assert.equal(at(T.SWEET + T.SWEET_TOL + 0.01).ok, true);

  // 甜区必须完整落在窗口内（否则"甜区"会有一段永远够不到）
  assert.ok(T.SWEET + T.SWEET_TOL <= 1, "甜区上沿越出了窗口：那一段永远投不到精准");
  assert.ok(T.SWEET - T.SWEET_TOL >= 0, "甜区下沿越出了窗口");
  /* 命中区的上沿贴着窗口末端：SWEET+HIT_TOL 已经 >1（= 过了目标点），
     所以命中区实际是 [SWEET−HIT_TOL, 1.0] —— 这是对的，
     "已经骑过头"本来就不该还能投中。 */
  assert.equal(at(1).ok, true, "窗口末端（刚骑到）必须还能命中");
  assert.equal(at(1).perfect, false, "窗口末端不该算精准");
  assert.equal(at(T.SWEET + T.HIT_TOL).t, -1, "超出窗口末端 = 已经骑过去了");
  assert.equal(at(T.SWEET + T.HIT_TOL).ok, false, "骑过头不能还算命中");

  // 命中区下沿（含等号）：SWEET−HIT_TOL 仍在窗口内，是"命中但不精准"的下界
  assert.equal(at(T.SWEET - T.HIT_TOL).ok, true, "命中区下沿应算命中（闭区间）");
  assert.equal(at(T.SWEET - T.HIT_TOL).perfect, false);
  assert.equal(at(T.SWEET - T.HIT_TOL - 0.02).ok, false, "出了命中区下沿就不该算");
  assert.equal(at(0).ok, false, "刚进窗口就投 = 投早了");

  // 已经过去了
  const after = at(1.3);
  assert.equal(after.t, -1, "已过目标应返回哨兵 -1");
  assert.equal(after.ok, false);
});

test("判定·身位：必须骑在同一侧，边界含等号", () => {
  const order = { z: 100000, side: 1 };
  const pd = order.z - (1 - T.SWEET) * T.APPROACH * T.SEG_LEN;
  const side = (x) => R.judgeDeliver(order, pd, x, false);

  assert.equal(side(0.9).ok, true, "同侧应该够得着");
  assert.equal(side(-0.9).ok, false, "对侧不该够得着");
  assert.equal(side(-0.9).why, "wrongside");
  assert.equal(side(T.LATERAL + 0.001).ok, true);
  assert.equal(side(T.LATERAL - 0.001).ok, false, "身位边界必须严格 —— 否则可以隔着半条路投");
  assert.ok(T.LATERAL > 0, "身位容差必须为正，否则站中间就能左右通吃");

  // 左侧目标镜像对称
  const left = { z: 100000, side: -1 };
  assert.equal(R.judgeDeliver(left, pd, -0.9, false).ok, true);
  assert.equal(R.judgeDeliver(left, pd, 0.9, false).ok, false);
});

test("判定·窗口：擦身递餐的窗口必须比投柜更短（这是两套投递手感的分界）", () => {
  assert.ok(T.APPROACH_HAND < T.APPROACH, "擦身窗口必须更窄，否则「擦身」就不成立");
  const order = { z: 100000, side: 1 };
  /* 取一个"对柜单已在窗口内、对擦身单还没进窗口"的距离：
     擦身窗口更窄，所以窄窗口外的距离上擦身单根本够不着。 */
  const d = (T.APPROACH_HAND + T.APPROACH) / 2 * T.SEG_LEN;
  const pd = order.z - d;
  assert.ok(R.judgeDeliver(order, pd, 0.6, false).t >= 0, "对柜单：这个距离应该在窗口内");
  assert.equal(R.judgeDeliver(order, pd, 0.6, true).t, -2, "对擦身单：同一距离还没进窗口");
  /* 擦身窗口的中段必须能递出去 —— 否则窄窗口就窄成了"永远递不到" */
  const mid = order.z - (1 - T.SWEET) * T.APPROACH_HAND * T.SEG_LEN;
  assert.equal(R.judgeDeliver(order, mid, 0.6, true).perfect, true, "擦身窗口正中必须算精准");
});

/* ═══════════════ ④ 计分表的结构：逆行加不了分 ═══════════════ */

test("计分：连送倍率在 5 倍封顶，且低于 1 连按 1 连算", () => {
  const base = R.SCORE_TABLE.deliver;
  assert.equal(R.scoreOf("deliver", 1), base);
  assert.equal(R.scoreOf("deliver", 2), base * 2);
  assert.equal(R.scoreOf("deliver", T.STREAK_CAP), base * T.STREAK_CAP);
  assert.equal(R.scoreOf("deliver", T.STREAK_CAP + 9), base * T.STREAK_CAP, "超过封顶不再增长");
  assert.equal(R.scoreOf("deliver", 0), base, "0 连也要给基础分");
  assert.equal(R.scoreOf("deliver", -5), base, "负数不能变成倒扣");
});

test("计分：SCORE_TABLE 里**没有** violation 这一项（逆行在结构上就加不了分）", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(R.SCORE_TABLE, "violation"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(R.SCORE_TABLE, "wrongway"), false);
  assert.equal(R.scoreOf("violation"), 0, "未登记的事件一律 0 分");
  assert.equal(R.scoreOf("wrongway"), 0);
  assert.equal(R.scoreOf("任何没登记的名字"), 0);
  // 已登记的事件都要给正分（否则等于白写一行配置）
  for (const k of Object.keys(R.SCORE_TABLE)) {
    if (k === "speed") continue;
    assert.ok(R.scoreOf(k) > 0, k + " 的分值应为正");
  }
});

test("逆行隔离：全程逆行与全程顺行的**分数完全相同**（只差时间与罚款）", () => {
  for (const modeId of Object.keys(R.MODES)) {
    for (const skill of [0.3, 0.7, 0.95]) {
      /* 这一条断言的是"完全相等"，不是统计量，所以 60 局就够 —— 而且它是全套里最贵的一项
         （9 个模式×技能组合 × 2 种跑法），采样量必须压住。 */
      const normal = meanScore(modeId, skill, { wrongway: false }, 60);
      const wrong  = meanScore(modeId, skill, { wrongway: true  }, 60);
      assert.equal(wrong, normal,
        modeId + " 模式 skill=" + skill + "：逆行改变了分数（" + normal + " → " + wrong + "），违规被偷偷奖励了");
    }
  }
  // 逆行确实换到了时间 —— 否则这个机制毫无意义
  let tN = 0, tW = 0, fN = 0, fW = 0, N = 100;
  for (let i = 0; i < N; i++) {
    const a = R.simulateShift("shift", 0.7, 4200 + i, { wrongway: false });
    const b = R.simulateShift("shift", 0.7, 4200 + i, { wrongway: true });
    tN += a.time; tW += b.time; fN += a.fines; fW += b.fines;
  }
  assert.ok(tW < tN, "逆行必须真的省时间，否则玩家没有理由冒这个险");
  assert.ok(fW > fN, "逆行必须真的吃罚款，否则代价是假的");
});

/* ═══════════════ ⑤ 评级与赔付阶梯 ═══════════════ */

test("评级：S/A/B/C 的阈值边界（阈值照抄原作）", () => {
  assert.equal(R.gradeOf(true, 10, 10), "S", "全送达且零失误 = S");
  assert.equal(R.gradeOf(true, 1, 10), "S", "per 由调用方判定，gradeOf 只看这一位");
  assert.equal(R.gradeOf(false, 8, 10), "A", "送达率正好 0.8 = A");
  assert.equal(R.gradeOf(false, 79, 100), "B", "0.79 掉到 B");
  assert.equal(R.gradeOf(false, 5, 10), "B", "送达率正好 0.5 = B");
  assert.equal(R.gradeOf(false, 49, 100), "C", "0.49 = C");
  assert.equal(R.gradeOf(false, 0, 10), "C");
  assert.equal(R.gradeOf(false, 0, 0), "C", "一单都没有不能算 S");
});

test("赔付：阶梯单调不减、0 分不给钱、封顶取最高档", () => {
  for (const modeId of Object.keys(R.PAYOUT)) {
    const lad = R.PAYOUT[modeId];
    assert.equal(R.payoutOf(0, modeId), 0, modeId + "：0 分不该给钱");
    assert.equal(R.payoutOf(-100, modeId), 0, modeId + "：负分不给钱");
    let prev = -1;
    for (let sc = 0; sc <= lad[lad.length - 1].min + 5000; sc += 137) {
      const p = R.payoutOf(sc, modeId);
      assert.ok(p >= prev, modeId + "：分数涨了赔付却降了（" + sc + "）");
      assert.ok(p <= lad[lad.length - 1].pay, modeId + "：赔付超过最高档");
      prev = p;
    }
    for (let i = 1; i < lad.length; i++) assert.ok(lad[i].min > lad[i - 1].min, modeId + "：阶梯门槛必须递增");
    assert.equal(lad[0].min, 0, modeId + "：第一档必须从 0 分开始");
  }
});

/* ═══════════════ ⑥ 经济不变量（相对 E[value]，不写死元数） ═══════════════ */

test("经济：瞎送必亏（低技能长期期望为负）", () => {
  for (const modeId of Object.keys(R.MODES)) {
    const e = meanNet(modeId, 0.05);
    assert.ok(e < 0, modeId + "：乱送居然能赚钱（E[净] = " + e.toFixed(2) + "），这玩法就没有难度了");
    assert.ok(e <= -T.ENTRY * 0.5, modeId + "：低技能亏损太浅，容错过高");
  }
});

test("经济：手熟能赚，且技术越好赚得越多（单调）", () => {
  for (const modeId of Object.keys(R.MODES)) {
    const lo = meanNet(modeId, 0.05);
    const mid = meanNet(modeId, 0.6);
    const hi = meanNet(modeId, 0.95);
    assert.ok(hi > 0, modeId + "：练熟了还不赚钱，玩家没有理由练");
    assert.ok(hi > mid, modeId + "：0.95 与 0.6 的期望收益没拉开（" + mid.toFixed(2) + " → " + hi.toFixed(2) + "）");
    assert.ok(mid > lo, modeId + "：0.6 与 0.05 的期望收益没拉开");
  }
});

test("经济：不能是印钞机（高技能期望收益有上限，且相对入场费有界）", () => {
  for (const modeId of Object.keys(R.MODES)) {
    const hi = meanNet(modeId, 1.0);
    const cap = R.PAYOUT[modeId][R.PAYOUT[modeId].length - 1].pay - T.ENTRY;
    assert.ok(hi <= cap + 1e-9, modeId + "：期望收益超过了最高档赔付 − 入场费");
    /* 相对上界：一周档是长线模式（跑七天），允许的倍数比单班高，但都必须有界。
       写成"入场费的 N 倍"而不是写死元数 —— 调 ENTRY 时这条断言不会变成假绿灯。 */
    const mult = (modeId === "week") ? 12 : 4;
    assert.ok(hi < T.ENTRY * mult,
      modeId + "：E[净] = " + hi.toFixed(1) + " 超过入场费的 " + mult + " 倍，属于印钞机");
  }
});

test("经济：最高分有天花板（分数不能随局数无限膨胀）", () => {
  for (const modeId of Object.keys(R.MODES)) {
    const mode = R.MODES[modeId];
    let maxScore = 0;
    for (let i = 0; i < 120; i++) {
      const st = R.simulateShift(modeId, 1.0, 61000 + i);
      if (st.score > maxScore) maxScore = st.score;
    }
    // 理论天花板：每单都能拿"5 连封顶送达 + 精准"，再加打赏/帮带/引狗/零失误/时间奖励
    let orders = 0, helps = 0, dogs = 0, parTime = 0;
    for (let d = 1; d <= mode.days; d++) {
      const r = R.buildRoute(d, 61000, modeId);
      orders += r.orders.length; helps += r.helps.length; parTime += r.parTime;
      dogs += r.hazards.filter((h) => h.kind === "dog").length;
    }
    const ceil = orders * (T.BASE_DELIVER * T.STREAK_CAP + T.PERFECT)
      + Math.ceil(orders / 3) * T.TIP
      + helps * T.HELP + dogs * T.DOG
      + mode.days * T.CLEAN
      + Math.ceil(parTime * T.SPEED_RATE);
    assert.ok(maxScore <= ceil, modeId + "：实测最高分 " + maxScore + " 超过理论上限 " + ceil);
    assert.ok(ceil < 1e7, modeId + "：理论上限本身就不合理（" + ceil + "）");
  }
});

test("经济：三种模式的期望收益量级可比（不能有哪一档明显更划算）", () => {
  const nets = Object.keys(R.MODES).map((m) => meanNet(m, 0.95));
  const lo = Math.min(...nets), hi = Math.max(...nets);
  assert.ok(lo > 0, "有模式在高技能下仍然不赚钱");
  // 一周档跑七天，收益高是应该的；但不能高出一个数量级
  assert.ok(hi / lo < 10, "各模式的收益量级差得太多（" + lo.toFixed(1) + " … " + hi.toFixed(1) + "）");
});

/* ═══════════════ ⑦ 回归：规则真的会触发 ═══════════════ */

test("回归：每张订单都必须能在**不逆行**的前提下送达（两条规则不能打架）", () => {
  /* 这条是截图里看出来的真缺陷：一开始把"左半幅路面"整个划成对向车道
     （WRONGWAY_X = −0.15），而送左侧订单要求 playerX < −LATERAL = −0.10 ——
     于是送左侧单必然违规，"要不要违规"从一个选择变成了强制的，
     而那正是这个玩法立意上最不能出错的地方。
     几何条件：左侧订单需要 playerX ∈ [WRONGWAY_X, −LATERAL]，
     非空当且仅当 −LATERAL > WRONGWAY_X，即 LATERAL < −WRONGWAY_X。 */
  assert.ok(T.LATERAL < -T.WRONGWAY_X,
    "身位容差 " + T.LATERAL + " ≥ 逆行线到路边的距离 " + (-T.WRONGWAY_X) +
    "：左侧订单在合法区内没有可站的位置，只能靠违规去送");
  // 合法区内左右两侧都要有实际可用的宽度（不能只是"数学上非空"）
  const legalLeft = -T.LATERAL - T.WRONGWAY_X;      // 左侧合法可站宽度
  assert.ok(legalLeft >= 0.25, "左侧合法身位只有 " + legalLeft.toFixed(2) + " 宽，太窄没法骑");
  const legalRight = 1 - T.LATERAL;
  assert.ok(legalRight >= 0.5, "右侧合法身位只有 " + legalRight.toFixed(2) + " 宽");
  // 逐张订单确认：存在一个不违规的身位能命中
  for (let d = 1; d <= 7; d++) {
    const r = R.buildRoute(d, 2024, "week");
    for (const o of r.orders) {
      const lo = (o.side < 0) ? T.WRONGWAY_X : T.LATERAL;
      const hi = (o.side < 0) ? -T.LATERAL : 1;
      assert.ok(hi > lo, "第 " + d + " 天订单 #" + o.n + "（side=" + o.side + "）没有合法身位");
      const mid = (lo + hi) / 2;
      const j = R.judgeDeliver(o, o.z - (1 - T.SWEET) * (o.kind === "handoff" ? T.APPROACH_HAND : T.APPROACH) * T.SEG_LEN, mid, o.kind === "handoff");
      assert.equal(j.ok, true, "第 " + d + " 天订单 #" + o.n + " 在合法身位 " + mid.toFixed(2) + " 上投不中");
      assert.ok(mid >= T.WRONGWAY_X, "算出来的合法身位本身就在逆行区里");
    }
  }
});

test("回归：狗的扫描范围必须真的等于 DOG_RANGE（不能有硬编码上界挡着）", () => {
  /* 真事：nearDog 的循环上界原来写死成 `k <= 8`，于是把 DOG_RANGE 从 10 调到 45
     完全没有效果 —— 实际窗口仍是 8 段（0.3 秒）。常量与实现自相矛盾，
     而且画面上一点异常都看不出来。现在扫描逻辑提到了纯函数层，这条断言直接验边界。 */
  const range = T.DOG_RANGE;
  // 造一条只有一只狗的干净赛道，放到指定距离上
  function routeWithDogAt(segsAhead) {
    const total = range + 40;
    const segs = [];
    for (let i = 0; i < total; i++) segs.push({ index:i, hazards:[], p1:{world:{}}, p2:{world:{}} });
    const pd = T.SEG_LEN * 10 + 100;                 // 玩家落在第 10 段内
    const idx = (10 + segsAhead) % total;
    segs[idx].hazards.push({ kind:"dog", z: idx * T.SEG_LEN + 1, x:0, done:false, tier:"hit" });
    return { total: total, segments: segs, pd: pd };
  }
  // range 之内（留 2 段余量）：必须找得到
  const inside = routeWithDogAt(range - 2);
  assert.ok(R.findDogNear(inside, inside.pd, range), "range 内的狗找不到 —— 扫描范围被截短了");
  // range 之外：必须找不到（否则等于全图自动引狗）
  const outside = routeWithDogAt(range + 8);
  assert.equal(R.findDogNear(outside, outside.pd, range), null, "range 外的狗也算进来了，窗口比 DOG_RANGE 大");
  // 已经被引开（done）的不该再被找到
  const used = routeWithDogAt(Math.round(range / 2));
  used.segments.forEach(s => s.hazards.forEach(h => { h.done = true; }));
  assert.equal(R.findDogNear(used, used.pd, range), null, "已被引开的狗不该再触发");
  // 换更小的 range，同一个位置就该找不到了 —— 证明 range 真的在起作用
  assert.equal(R.findDogNear(inside, inside.pd, Math.round(range / 4)), null,
    "缩小 range 后仍能找到，说明扫描范围与 range 无关（又写死回去了）");
});

test("回归：TUNE 里被代码引用的常量必须全部存在且是有限数", () => {
  /* 这条是**真事**换来的：DOG_RANGE 一开始忘了写进 TUNE，
     nearDog() 里 `d < TUNE.DOG_RANGE * SEG_LEN` 就成了 `d < NaN` —— 永远为假，
     「扔备餐引开狗」这条机制整个是死的，而页面不报任何错、画面也完全正常。
     只有浏览器验收去按那一下才会发现。这类"缺常量"必须用断言挡住。 */
  const REQUIRED = [
    "ENTRY","SEG_LEN","RUMBLE_LEN","ROAD_W","FOV","CAM_H","DRAW_DIST","FOG","CENTRIFUGAL",
    "MAX_SPEED","ACCEL","BRAKE","DECEL","OFFROAD_DECEL","OFFROAD_LIMIT","CRUISE",
    "APPROACH","APPROACH_HAND","SWEET","SWEET_TOL","HIT_TOL","LATERAL","DECOY_PENALTY","DOG_RANGE",
    "BAG_BASE","MISTAKES_MAX",
    "WRONGWAY_X","WRONGWAY_SPEED_MUL","WRONGWAY_SPAWN","FINE","GUARD_HOLD",
    "BASE_DELIVER","STREAK_CAP","PERFECT","TIP","DOG","HELP","CLEAN","SPEED_RATE",
  ];
  const missing = REQUIRED.filter((k) => !Number.isFinite(T[k]));
  assert.deepEqual(missing, [], "TUNE 里缺这些常量（代码引用了但它们不存在）：" + missing.join(", "));
  // 尺寸类常量必须是正的，否则整条投射/判定链会静默失效
  for (const k of ["SEG_LEN","ROAD_W","CAM_H","DRAW_DIST","MAX_SPEED","APPROACH","APPROACH_HAND","DOG_RANGE","MISTAKES_MAX"]) {
    assert.ok(T[k] > 0, k + " 必须为正");
  }
  assert.ok(T.HIT_TOL > T.SWEET_TOL, "命中区必须比甜区宽，否则两档没有区别");
});

test("回归：弯道累积横移必须有界（否则远处路面会被推出屏幕）", () => {
  /* 这是"路面整块消失"的第二层原因（第一层是环线高度没闭合）。
     render() 里横移是逐段累加的：`x += dx; dx += seg.curve`，
     所以一个持续 n 段的弯会把 x 推到 ≈ curve × n²/2，而且**同向弯会叠加**。
     实测：第一版（curve 到 ±8、单段长 180、不交替）x 冲到 12.9 万单位 = 路半宽的 92 倍，
     远端路面的屏幕偏移远超一个屏宽，画面上就是"前方空掉"。
     现在缓弯（≤±2）+ 单段 ≤140 + 方向强制交替，实测落在 20–23 倍。
     这条断言就是那个根因的守卫：调弯道参数后如果冲过 30 倍，画面一定会坏。 */
  const LIMIT = 30 * T.ROAD_W;
  let worst = 0, worstAt = "";
  for (let d = 1; d <= 7; d++) {
    const r = R.buildRoute(d, 1234, "week");
    for (let k = 0; k < 24; k++) {
      const pos = Math.floor(r.length * k / 24);
      const base = Math.floor(pos / T.SEG_LEN) % r.total;
      const basePct = (pos % T.SEG_LEN) / T.SEG_LEN;
      let x = 0, dx = -(r.segments[base].curve * basePct);
      for (let n = 0; n < T.DRAW_DIST; n++) {
        x += dx; dx += r.segments[(base + n) % r.total].curve;
        if (Math.abs(x) > worst) { worst = Math.abs(x); worstAt = "第" + d + "天 seg" + (base + n); }
      }
    }
  }
  assert.ok(worst < LIMIT,
    "弯道累积横移最大 " + worst.toFixed(0) + " 单位 = 路半宽的 " + (worst / T.ROAD_W).toFixed(1) +
    " 倍（上限 " + (LIMIT / T.ROAD_W) + " 倍，出现在 " + worstAt + "）—— 远处路面会被推出屏幕");
  // 同时要保证弯道不是"几乎没有"：整条赛道得有实际的方向变化
  const r = R.buildRoute(3, 1234, "week");
  let signChanges = 0, prev = 0;
  for (const s of r.segments) {
    const sg = Math.sign(s.curve);
    if (sg !== 0 && prev !== 0 && sg !== prev) signChanges++;
    if (sg !== 0) prev = sg;
  }
  assert.ok(signChanges >= 4, "整条赛道只有 " + signChanges + " 次转向变化，太平了");
});

test("回归：引开恶犬的动作窗口必须够人反应（按反应时间倒推，不是凭手感）", () => {
  /* 1 段 = SEG_LEN 世界单位；巡航速度 = MAX_SPEED × CRUISE。
     窗口时长 = DOG_RANGE × SEG_LEN ÷ 巡航速度，必须 ≥ 1 秒 ——
     低于这个数，"看到狗 → 判断 → 按空格"这条链路在物理上就走不完，
     机制等于不存在（第一版 10 段只有 0.37 秒，满速时 0.2 秒）。 */
  const cruise = T.MAX_SPEED * T.CRUISE;
  const winSec = T.DOG_RANGE * T.SEG_LEN / cruise;
  assert.ok(winSec >= 1.0, "引狗窗口只有 " + winSec.toFixed(2) + " 秒，人的反应时间不够");
  // 也不能大到"随便按都能引开"，那就没有判断了
  assert.ok(winSec <= 6, "引狗窗口 " + winSec.toFixed(2) + " 秒过长，等于自动引开");
});

test("回归：订单的投递窗口也要够反应时间", () => {
  const cruise = T.MAX_SPEED * T.CRUISE;
  for (const [name, segs] of [["投柜", T.APPROACH], ["擦身递餐", T.APPROACH_HAND]]) {
    const winSec = segs * T.SEG_LEN / cruise;
    assert.ok(winSec >= 0.8, name + " 的窗口只有 " + winSec.toFixed(2) + " 秒，按不出来");
  }
  // 甜区本身也要有可操作宽度（不是"必须精确到帧"）
  const sweetSec = T.APPROACH * T.SEG_LEN * T.SWEET_TOL * 2 / cruise;
  assert.ok(sweetSec >= 0.06, "甜区只有 " + (sweetSec * 1000).toFixed(0) + " 毫秒宽，等于随机");
});

test("回归：「3 次失误当班结束」在单日模式下必须真的能触发", () => {
  /* 这条是回归测试。第一版模拟里碰撞是"一天掷一次"，单日最多吃 1 次失误，
     而 MISTAKES_MAX 是 3 —— 于是这条规则在单班/高峰模式下永远触发不了，
     等于写了没用。改成按危险点数量算期望碰撞数之后才成立。 */
  let over = 0;
  const N = 200;
  for (let i = 0; i < N; i++) if (R.simulateShift("shift", 0.05, 88000 + i).gameOver) over++;
  assert.ok(over / N > 0.05,
    "低技能跑 200 局只有 " + over + " 局因失误结束 —— MISTAKES_MAX 形同虚设");
  // 反过来：高手几乎不该被失误打断
  let overHi = 0;
  for (let i = 0; i < N; i++) if (R.simulateShift("shift", 0.98, 88000 + i).gameOver) overHi++;
  assert.equal(overHi, 0, "高技能也会因失误结束，撞车判定过严");
});

test("回归：危险表两级归类完整，且两级都会被吃到", () => {
  const tiers = new Set();
  for (const k of Object.keys(R.HAZARDS)) {
    tiers.add(R.HAZARDS[k].tier);
    assert.ok(R.HAZARDS[k].w > 0 && R.HAZARDS[k].h > 0, k + " 缺少世界单位尺寸");
    assert.ok(typeof R.HAZARDS[k].why === "string" && R.HAZARDS[k].why.length > 0, k + " 缺少文案");
  }
  assert.ok(tiers.has("hit"), "没有碰撞类危险 → 失误永远不会发生");
  assert.ok(tiers.has("bump"), "没有颠簸类危险 → 洒汤永远不会发生");
  const st = R.simulateShift("shift", 0.2, 111);
  assert.ok(st.spilled >= 0);
});

test("回归：一周档的失误会真的截断这一周（不是跑满七天）", () => {
  let truncated = 0;
  const N = 120;
  for (let i = 0; i < N; i++) {
    const st = R.simulateShift("week", 0.1, 33000 + i);
    if (st.days < R.MODES.week.days) truncated++;
  }
  assert.ok(truncated / N > 0.3, "低技能跑一周居然大多能跑满七天，失误惩罚不起作用");
});
