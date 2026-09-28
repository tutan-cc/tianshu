/* ═══════════════════════════════════════════════════════════════════════════
   mk_bf14_panel.js — bf-14 第八轮：出图脚本 tools/bf/shots/panel.js 按新口径改写 + 新增 bf_pan_window.png
     ① bot()：熟了要**点锅起锅**（不再自动落盘）
     ② bf_game.png：5 盘保鲜 + 1 口糊锅 + 2 口正等起锅
     ③ bf_columns.png：三列摆成「等在起锅窗口 / 刚起锅落盘 / 还在烧」
     ④ bf_plates_nocountdown.png：9 份改成「窗口内点锅起锅」落盘
     ⑤ 新增 ②c bf_pan_window.png：起锅窗口 + 倒计时环 + 已糊锅 + 盘占着
   用法：node tools/bf/_patch/mk_bf14_panel.js
         node tools/bf/_patch/_bf14_preflight.js tools/bf/_patch/jobs_bf14_panel.json
         node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf14_panel.json
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/bf/shots/panel.js";
const T = [], jobs = [];
function job(name, from, to, text) {
  T.push({ name: name, text: text });
  jobs.push({ file: FILE, from: from, to: to || undefined, textFile: "tools/bf/_patch/bf14p_" + name + ".txt" });
}

/* ── ① bot()：点锅起锅 ─────────────────────────────────────────────────── */
job("bot", `/** 机器人：看单下料（每样只进自己那一列）+ 熟了自动落盘 + 单击盘出餐（把「通过路径」真跑出来） */
function bot(B, maxSteps) {
  const d = B.debug;
  let guard = 0;
  while (!d.state().over && guard++ < (maxSteps || 5000)) {
    for (const c of d.orders()) for (const f of c.order) {
      if (c.done.indexOf(f) >= 0) continue;
      if (d.stations().some(s => s.food === f)) continue;
      if (d.plates().some(p => p.food === f && p.state !== "burnt")) continue;
      d.drop(f, null);
    }
    for (let n = 0; n < 60 && !d.state().over; n++) {
      d.tick(1 / 60);
      if (d.plates().some(p => p.state === "perfect")) break;      // 有东西落到盘上了
    }
    if (d.state().over) break;
    d.stations().forEach((s, i) => { if (s.plate && s.plateState !== "burnt") d.serveCol(i); });   // 单击盘出餐
    d.stations().forEach((s, i) => {
      if (s.state === "burnt" || s.plateState === "burnt") { d.trash(i); return; }
      if (s.plate) { const r = d.serveCol(i); if (!r.ok && r.why === "no-want") d.trash(i); }
    });
    d.tick(0.12);
  }
}`,
null,
`/** 机器人：看单下料（每样只进自己那一列）+ 锅里熟了**在窗口内点锅起锅** + 单击盘出餐
    （bf-14：熟了不再自动落盘；盘被占就先点盘把旧的送出去）*/
function bot(B, maxSteps) {
  const d = B.debug;
  let guard = 0;
  while (!d.state().over && guard++ < (maxSteps || 5000)) {
    d.stations().forEach((s, i) => {                              // ① 起锅
      if (s.state === "perfect" && s.windowOpen) {
        if (s.plate) { const r = d.serveCol(i); if (!r.ok) d.trash(i); }
        else d.takeOut(i);
      }
    });
    d.stations().forEach((s, i) => {                              // ② 盘上的送出去 / 清掉
      if (s.state === "burnt" || s.plateState === "burnt") { d.trash(i); return; }
      if (s.plate) { const r = d.serveCol(i); if (!r.ok && r.why === "no-want") d.trash(i); }
    });
    for (const c of d.orders()) for (const f of c.order) {        // ③ 看单下料
      if (c.done.indexOf(f) >= 0) continue;
      if (d.stations().some(s => s.food === f)) continue;
      if (d.plates().some(p => p.food === f && p.state !== "burnt")) continue;
      d.drop(f, null);
    }
    for (let n = 0; n < 60 && !d.state().over; n++) {
      d.tick(1 / 60);
      if (d.stations().some(s => s.windowOpen)) break;            // 有锅进起锅窗口了
    }
    if (d.state().over) break;
    d.tick(0.12);
  }
}`);

/* ── ② bf_game.png：重摆局面 ───────────────────────────────────────────── */
job("game", `  adv(d, 4.2);                                        // 逻辑推进（不渲染）：顾客进门、订单卡出来
  /* 五列先各做一份（熟了各自落到本列专属盘）*/
  d.drop("milk", null); d.drop("sandwich", null); d.drop("salad", null);
  d.drop("bun", null); d.drop("soup", null);
  { let g = 0; while (g++ < 600 && d.plates().length < 5) d.tick(1 / 60); }
  /* 再让两列正在烧：0 列白粥（3.4s）、3 列煎蛋（2.2s）—— 画面里能看到火候进度环 */
  d.drop("congee", null); d.drop("egg", null);
  adv(d, 0.7);`,
null,
`  adv(d, 4.2);                                        // 逻辑推进（不渲染）：顾客进门、订单卡出来
  /* ① 五列各做一份 → **窗口内点锅起锅** → 落到各自专属盘上（bf-14：不再自动落盘）*/
  d.drop("milk", null); d.drop("sandwich", null); d.drop("salad", null);
  d.drop("bun", null); d.drop("soup", null);
  { let g = 0;
    while (g++ < 900 && d.plates().length < 5) {
      d.stations().forEach(s => { if (s.state === "perfect" && s.windowOpen && !s.plate) d.takeOut(s.i); });
      d.tick(1 / 60);
    } }
  /* ② 一口锅（第 4 列培根）**没人起锅** → 窗口走完自己糊：焦黑锅体 + 红叉 +「糊了 · 双击丢掉」*/
  d.drop("bacon", null);
  { let g = 0; while (g++ < 700 && d.stations()[4].state !== "burnt") d.tick(1 / 60); }
  /* ③ 两口锅正**等在起锅窗口**里（锅上「起锅！点一下这口锅」+ 窗口倒计时环）*/
  d.drop("congee", null); d.drop("egg", null);
  { let g = 0;
    while (g++ < 400 && !(d.stations()[0].state === "perfect" && d.stations()[0].windowOpen &&
                          d.stations()[3].state === "perfect" && d.stations()[3].windowOpen)) d.tick(1 / 60); }
  d.tick(0.55);                                       // 让「熟了 · 起锅！」飘字播完，出图干净`);

job("game_caption", `  save(b.canvas, "bf_game.png", b.texts,
    "进行中：9 列列对齐（底部食材 → 中列锅 → 上列专属盘）+ 2 列在烧 + 盘上 5 份（盘龄 0.4~90s）全部「热乎」+「∞ 可一直放着」（bf-13 永久保鲜：没有倒计时）");
  const st = d.state();
  console.log("    [进行中] 顾客 " + d.orders().length + " 位 · 锅里 " + d.stations().filter(s => s.food).length +
              " 样 · 盘上 " + d.plates().length + "/9 份 " + JSON.stringify(d.plates().map(p => p.food + ":" + (p.state === "burnt" ? "糊" : p.tier) + "@" + p.age + "s")) +
              " · 糊 " + st.burnt + " 份 · 分 " + st.score +
              " · 盘上「内送出」文案 " + b.texts.filter(t => /内送出/.test(t.text)).length + " 处");`,
null,
`  save(b.canvas, "bf_game.png", b.texts,
    "进行中（bf-14）：9 列列对齐 + 盘上 5 份（盘龄 0.4~90s）全部「热乎」+「∞ 可一直放着」+ " +
    "锅里 2 口正等起锅（「恰好 · 起锅 N.Ns」+ 窗口倒计时环）+ 1 口没人起锅已经糊（焦黑 + 红叉 +「糊了 · 双击丢掉」）");
  const st = d.state();
  const pickN = d.stations().filter(s => s.windowOpen).length;
  console.log("    [进行中] 顾客 " + d.orders().length + " 位 · 锅里 " + d.stations().filter(s => s.food).length +
              " 样（等起锅 " + pickN + " · 已糊 " + d.stations().filter(s => s.state === "burnt").length + "）· 盘上 " + d.plates().length + "/9 份 " +
              JSON.stringify(d.plates().map(p => p.food + ":" + (p.state === "burnt" ? "糊" : p.tier) + "@" + p.age + "s")) +
              " · 糊 " + st.burnt + " 份（忘起锅 " + st.expire + "）· 分 " + st.score +
              " · 盘上「内送出」文案 " + b.texts.filter(t => /内送出/.test(t.text)).length + " 处" +
              " · 锅内「起锅」文案 " + b.texts.filter(t => /起锅/.test(t.text)).length + " 处");`);

/* ── ③ bf_columns.png：三列三态 ────────────────────────────────────────── */
job("columns", `  /* 三列摆出三种状态：煎蛋在烧、培根熟了刚落盘（热乎）、三明治在烧 */
  d.drop("egg", null); d.drop("bacon", null); d.drop("sandwich", null);
  { let g = 0; while (g++ < 260 && !d.stations()[4].plate) d.tick(1 / 60); }
  d.tick(1 / 60);
  adv(d, 1.0);                                           // 让「熟了 · 落到专属盘」飘字播完再出图
  d.setPlateAge(4, 0.4);                                 // 培根那份 → 热乎档（14 分）`,
null,
`  /* 三列摆出三种状态（bf-14）：煎蛋**等在起锅窗口**、培根**刚起锅落盘**（热乎）、三明治还在烧 */
  d.drop("egg", null); d.drop("bacon", null);
  { let g = 0; while (g++ < 400 && !d.stations()[4].windowOpen) d.tick(1 / 60); }
  d.takeOut(4);                                          // 培根：窗口内点锅 → 起锅落盘（热乎）
  d.drop("sandwich", null);                              // 三明治随后下锅 → 还在烧
  adv(d, 1.05);                                          // 飘字播完（煎蛋那口锅仍在窗口里）
  d.setPlateAge(4, 0.4);                                 // 培根那份 → 热乎档（14 分）`);

job("columns_band", `  put("操作：① 点食材 → 自动进它正上方那一列的锅　　② 点上方专属盘 → 送给正在等的顾客（优先最急的）",
    20, bandY + 48, 27, "#f6efe2");
  put("③ 双击盘 → 丢垃圾桶（不扣分）　　盘上永久保鲜（bf-13）：没有倒计时 / 不会凉 / 不会糊，放多久都能上",
    20, bandY + 104, 27, "#5dffa0");`,
null,
`  put("操作：① 点食材 → 自动进它正上方那一列的锅　　② 锅里熟了 → 4.5s 内点一下锅起锅（落到本列专属盘）",
    20, bandY + 48, 27, "#f6efe2");
  put("③ 点专属盘 → 送给正在等的顾客　　④ 双击盘 / 锅 → 丢垃圾桶；盘被占了就只能糊掉，糊了必须双击才清",
    20, bandY + 104, 27, "#5dffa0");`);

/* ── ④ bf_plates_nocountdown.png：9 份改成点锅起锅 ─────────────────────── */
job("nocountdown", `  /* 9 列各做一份 → 9 份全部落到各自的专属盘上（一锅一盘，列对齐） */
  b.B.FOOD_IDS.forEach(function (f) { d.drop(f, null); });
  { let g = 0; while (g++ < 900 && d.plates().length < 9) d.tick(1 / 60); }
  /* 盘龄梯度：0.4s → 300s。旧口径下这张表几乎每一行都会被判「糊掉 / 只能丢」。 */
  adv(d, 1.2);                                           // 让「熟了 · 落到专属盘」飘字播完，出图干净`,
null,
`  /* 9 列各做一份 → 各自窗口内**点锅起锅** → 9 份全部落到各自的专属盘上（一锅一盘，列对齐）
     （bf-14：熟了不再自动落盘；这一步就是玩家真实要做的操作）*/
  b.B.FOOD_IDS.forEach(function (f) { d.drop(f, null); });
  { let g = 0;
    while (g++ < 1200 && d.plates().length < 9) {
      d.stations().forEach(function (s) { if (s.state === "perfect" && s.windowOpen && !s.plate) d.takeOut(s.i); });
      d.tick(1 / 60);
    } }
  /* 盘龄梯度：0.4s → 300s。旧口径下这张表几乎每一行都会被判「糊掉 / 只能丢」。 */
  adv(d, 1.2);                                           // 让「熟了 · 起锅！」飘字播完，出图干净`);

job("nocountdown_code", `  put("锅内一个字没改：生 → 恰好 → 过火 → 糊（autoPlate 默认开时一到「恰好」就落盘，锅里那段时间窗口本来就极短）",
      24, codeY + 34, 24, "#cbd6e6");`,
null,
`  put("锅内（bf-14）：生 → 恰好 → **起锅窗口（4.5s，火候暂停）** → 糊。本图这 9 份都是「窗口内点锅起锅」落盘的 —— 不再自动落盘",
      24, codeY + 34, 24, "#cbd6e6");`);

/* ── ⑤ 新增 ②c：bf_pan_window.png ─────────────────────────────────────── */
job("panwindow", `/* ══════════ ③ 通过结算 ══════════ */`,
null,
`/* ══════════ ②c 锅内限时起锅特写（bf-14 · bf_pan_window.png） ══════════
   用户要求：「锅里熟了要在规定时间内起锅；如果备用餐盘里放着，锅里要起锅的没地方放就只能糊掉；
             想再使用锅，就要双击扔掉里面的食物」。
   同一帧里摆出三种锅内状态（都是 breakfast.js 真跑出来的）：
     · 第 3 列 煎蛋   = **起锅窗口**：绿环 +「起锅！点一下这口锅」+「恰好 · 起锅 N.Ns」倒计时
     · 第 4 列 培根   = 没人起锅 → **已糊**：焦黑锅体 + 红叉 +「糊了 · 双击丢掉」
     · 第 5 列 三明治 = 盘里已经有一份 → 起锅**没地方放**：红字「盘占着 · 没地方放」（窗口还在走）
   底部注解带写清交互与后果，并打出本帧实测计数。 */
{
  const SC = 2.2;
  const CY0 = 312, CH = 312;                             // 逻辑 y：盘带顶（328-16）→ 锅底（608+16）
  const TOP = 210, BAND = 452;                           // 设备像素：上标题带 / 下注解带
  const H0 = TOP + Math.round(CH * SC) + BAND;
  const b = boot(SC, 1180, H0 / SC);
  b.B.start(b.host, { target: { id: "su", name: "苏晚晴", bond: 40 }, duration: 999, goal: 99, onFinish: () => {} });
  const d = b.B.debug;
  adv(d, 1.2);
  const calm = () => d.orders().forEach(o => d.setPatience(o.id, 0.99));   // 这一段别让谁跑单（会飘红字）
  /* ① 第 4 列（培根）：下锅后**没人起锅** → 窗口走完自己糊 */
  d.drop("bacon", null);
  { let g = 0; while (g++ < 800 && d.stations()[4].state !== "burnt") { calm(); d.tick(1 / 60); } }
  /* ② 第 5 列（三明治）：先起锅一份进盘 → 再下一份 → 盘占着 → 锅上「盘占着 · 没地方放」*/
  d.drop("sandwich", null);
  { let g = 0; while (g++ < 500 && !d.stations()[5].windowOpen) { calm(); d.tick(1 / 60); } }
  d.takeOut(5);                                          // 第一份 → 专属盘（盘上永久保鲜）
  d.drop("sandwich", null);                              // 第二份接着下锅
  /* ③ 第 3 列（煎蛋）：下锅 → 进起锅窗口（绿环 +「起锅！点一下这口锅」）*/
  d.drop("egg", null);
  { let g = 0;
    while (g++ < 700 && !(d.stations()[5].windowOpen && d.stations()[3].windowOpen)) { calm(); d.tick(1 / 60); } }
  d.tick(0.4);                                           // 让「熟了 · 起锅！」飘字淡掉，画面干净
  const S3 = d.stations()[3], S4 = d.stations()[4], S5 = d.stations()[5];
  const P5 = d.plates().filter(p => p.station === 5)[0];
  /* ── 回放这一帧（只取盘带 + 锅带那一段）── */
  b.canvas.setTransform(SC, 0, 0, SC, 0, TOP - CY0 * SC);
  b.texts.length = 0;
  b.pump(1, 16);
  const W0 = Math.round(1180 * SC);
  const keep = b.texts.filter(t => t.y >= TOP - 4 && t.y <= TOP + CH * SC + 4);
  b.texts.length = 0; keep.forEach(t => b.texts.push(t));
  const panTexts = keep.map(t => t.text);
  const cntPick = panTexts.filter(x => /起锅！点一下这口锅/.test(x)).length;
  const cntRing = panTexts.filter(x => /恰好 · 起锅 \\d+\\.\\d+s/.test(x)).length;
  const cntBurnt = panTexts.filter(x => /糊了 · 双击丢掉/.test(x)).length;
  const cntBlocked = panTexts.filter(x => /盘占着 · 没地方放/.test(x)).length;
  const cntKeep = panTexts.filter(x => /可一直放着/.test(x)).length;
  b.canvas.setTransform(1, 0, 0, 1, 0, 0);
  const W = W0, H = H0;
  const put = (t, x, y, px, color, align, bold) => {
    b.canvas.fillStyle = color;
    b.canvas.font = ((bold === undefined ? px >= 26 : bold) ? "bold " : "") + px + "px 'Microsoft YaHei',sans-serif";
    b.canvas.textAlign = align || "left"; b.canvas.textBaseline = "middle";
    b.canvas.fillText(t, x, y);
    b.canvas.textAlign = "left";
  };
  /* ── 顶部标题带（4 行）── */
  b.canvas.fillStyle = "rgba(9,6,11,.97)"; b.canvas.fillRect(0, 0, W, TOP);
  b.canvas.strokeStyle = "rgba(255,214,110,.45)"; b.canvas.lineWidth = 4;
  b.canvas.beginPath(); b.canvas.moveTo(0, TOP - 1); b.canvas.lineTo(W, TOP - 1); b.canvas.stroke();
  put("锅内限时起锅（bf-14）：锅里熟了要在 4.5s 内点一下锅起锅；盘被占了就只能糊掉", 20, 34, 40, "#ffd76e");
  put("下图是 breakfast.js 真发出的 Canvas2D 指令画出来的盘区 + 锅区（同一帧里的三种锅内状态）", 20, 84, 26, "#b0a08c");
  put("① 第 3 列 煎蛋 = 起锅窗口（绿环 + 倒计时）　② 第 4 列 培根 = 没人起锅 → 已糊（焦黑 + 红叉）　" +
      "③ 第 5 列 三明治 = 盘里已有一份 →「盘占着 · 没地方放」", 20, 128, 24, "#cfe8ff");
  put("窗口内**火候暂停**：这 4.5 秒是玩家真正能用的时间（否则会被 0.6~1.0s 的完美窗口提前吃掉）",
      20, 166, 23, "#a9a2bd");
  /* ── 底部注解带（交互表 + 后果 + 实测）── */
  const bandY = TOP + Math.round(CH * SC);
  b.canvas.fillStyle = "rgba(9,6,11,.97)"; b.canvas.fillRect(0, bandY, W, BAND);
  b.canvas.strokeStyle = "rgba(255,214,110,.45)"; b.canvas.lineWidth = 4;
  b.canvas.beginPath(); b.canvas.moveTo(0, bandY + 1); b.canvas.lineTo(W, bandY + 1); b.canvas.stroke();
  put("交互（一句话）：单击锅 = 起锅（落进该列专属盘）｜ 单击盘 = 送给耐心最少的顾客 ｜ 双击锅 / 盘 = 丢垃圾桶（不扣分）",
      24, bandY + 44, 28, "#f6efe2");
  put("盘被占了 → 起锅被拒（plate-occupied，提示「盘里还有一份，先送出去」），**窗口继续走** → 走完就糊；" +
      "糊了口锅被占死（下料被拒 station-occupied），**必须双击丢掉**才能再用（糊残骸不再自动消失）",
      24, bandY + 92, 26, "#ffd0d8");
  put("盘上永久保鲜（bf-13 保持不变）：不会凉 / 不会糊 / 不会消失，盘下永远写着「∞ 可一直放着」——" +
      " 压力只在锅里，不在盘上", 24, bandY + 136, 26, "#d8ffe8");
  put("本帧实测：起锅提示 " + cntPick + " 口 · 窗口倒计时 " + cntRing + " 口（煎蛋剩 " + (S3.serveWin || 0).toFixed(1) + "s）· " +
      "已糊 " + cntBurnt + " 口（培根 · burnt=" + d.state().burnt + "）· 盘占着 " + cntBlocked + " 口（三明治）· " +
      "盘上 " + cntKeep + " 份（三明治·热乎）",
      24, bandY + 186, 26, "#ffd76e");
  put("对照：旧口径（bf-13）默认「一到恰好就自动落盘」，锅内窗口恒不触发 —— 本图这一天起，锅里必须由玩家起锅",
      24, bandY + 228, 24, "#cbd6e6");
  put("运行：node tools/bf/shots/panel.js ｜ 画面 = breakfast.js 真发出的 Canvas2D 指令经 tools/lib/raster.js 软件光栅化（非浏览器截图）",
      24, bandY + 268, 22, "#8a8296");
  save(b.canvas, "bf_pan_window.png", b.texts,
    "锅内限时起锅（bf-14）：同一帧三种锅内状态 —— 起锅窗口（绿环 + 起锅提示 + 倒计时）/ 没人起锅已糊（焦黑 + 红叉 + 双击丢掉）/" +
    "盘占着没地方放（红字，窗口继续走）；底部写清单击 / 双击各做什么与后果");
  console.log("    [锅内起锅] 起锅提示 " + cntPick + " 口 · 倒计时 " + cntRing + " 口 · 已糊 " + cntBurnt +
              " 口 · 盘占着 " + cntBlocked + " 口 · 盘上保鲜文案 " + cntKeep + " 处 · burnt=" + d.state().burnt);
  console.log("    [锅内起锅] 第三列 " + S3.state + " 剩 " + (S3.serveWin || 0).toFixed(2) + "s / 第四列 " + S4.state +
              " / 第五列 " + S5.state + " 盘=" + (P5 ? P5.food + "@" + P5.tier : "空"));
}

/* ══════════ ③ 通过结算 ══════════ */`);

/* ── ⑥ 面板文案：忘取 → 忘起锅 ─────────────────────────────────────────── */
job("kv_expire", `    ["烧糊份数", String(R.burnt) + (R.expire ? ("（忘取 " + R.expire + "）") : "")],`,
null,
`    ["烧糊份数", String(R.burnt) + (R.expire ? ("（忘起锅 " + R.expire + "）") : "")],`);

/* ── ⑦ 文件头产物清单 ─────────────────────────────────────────────────── */
job("head", `   产物：测试截图/bf_game.png   放大后的进行中画面（1770×1185，1080p 级别）
        测试截图/bf_plates.png 灶位 + 专属盘特写（2360×580，其中几盘已备好、一盘糊了）`,
null,
`   产物：测试截图/bf_game.png   放大后的进行中画面（1770×1185，1080p 级别）
        测试截图/bf_pan_window.png 锅内限时起锅特写（起锅窗口 + 倒计时环 + 已糊锅 + 盘占着）
        测试截图/bf_plates.png 灶位 + 专属盘特写（2360×580，其中几盘已备好、一盘糊了）`);

const dir = path.join(OUT, "tools", "bf", "_patch");
for (const t of T) fs.writeFileSync(path.join(dir, "bf14p_" + t.name + ".txt"), t.text.replace(/\r\n/g, "\n"), "utf8");
fs.writeFileSync(path.join(dir, "jobs_bf14_panel.json"), JSON.stringify({ jobs: jobs }, null, 1), "utf8");
console.log("✓ 生成 " + T.length + " 个 job → tools/bf/_patch/jobs_bf14_panel.json");
T.forEach((t, i) => console.log("  job#" + (i + 1) + " · " + t.name + " · " + t.text.split("\n").length + " 行"));
