/* ═══════════════════════════════════════════════════════════════════════════
   mk_bf14_headless.js — bf-14 第四轮：tools/bf/headless.js 按新口径改写 + 新增断言
   用法：node tools/bf/_patch/mk_bf14_headless.js
         node tools/bf/_patch/_bf14_preflight.js tools/bf/_patch/jobs_bf14_headless.json
         node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf14_headless.json
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/bf/headless.js";
const T = [], jobs = [];
function job(name, from, to, text) {
  T.push({ name: name, text: text });
  jobs.push({ file: FILE, from: from, to: to || undefined, textFile: "tools/bf/_patch/bf14h_" + name + ".txt" });
}

/* ── ① ⑤ 段：单击锅起锅（第 3 列） ─────────────────────────────────────── */
job("mouse_pick", `  /* 单击盘 → 自动送给正在需要这份、且耐心最少的顾客 */
  for (let i = 0; i < 300 && !B.debug.stations()[3].plate; i++) B.debug.tick(1 / 60);
  A(B.debug.stations()[3].plate === "egg", "熟了自动落到本列专属盘（第 3 列）", String(B.debug.stations()[3].plate));
  A(B.debug.stations()[3].food === null, "落盘后锅位立刻空出来");`,
null,
`  /* bf-14：熟了**不再自动落盘** → 进「起锅窗口」；真实鼠标**单击锅** = 起锅 */
  for (let i = 0; i < 300 && !B.debug.stations()[3].windowOpen; i++) B.debug.tick(1 / 60);
  A(B.debug.stations()[3].windowOpen === true, "熟了进入起锅窗口（原断言：同一帧自动落到盘上）",
    "state=" + B.debug.stations()[3].state + " · 剩 " + B.debug.stations()[3].serveWin + "s");
  A(B.debug.stations()[3].plate === null, "还没起锅 → 盘上是空的（原断言：已经自动落盘）");
  const POT3 = center(B.stationBox(3));
  cv.dispatch("mousedown", { clientX: POT3.x, clientY: POT3.y, preventDefault() {} });
  A(B.debug.stations()[3].plate === "egg", "真实鼠标单击锅 → 起锅落到本列专属盘（第 3 列）", String(B.debug.stations()[3].plate));
  A(B.debug.stations()[3].food === null, "起锅后锅位立刻空出来");
  A(B.debug.stations()[3].tier === "hot", "入盘即最高档（热乎）", String(B.debug.stations()[3].tier));`);

job("plate_age_flow", `  B.debug.drop("egg", null);
  for (let i = 0; i < 300 && !B.debug.stations()[3].plate; i++) B.debug.tick(1 / 60);
  A(B.debug.stations()[3].plate === "egg", "再做一份，等着它落盘");`,
null,
`  B.debug.drop("egg", null);
  for (let i = 0; i < 300 && !B.debug.stations()[3].windowOpen; i++) B.debug.tick(1 / 60);
  A(B.debug.takeOut(3).ok === true, "再做一份：窗口内起锅（bf-14：不再等它自动落盘）");
  A(B.debug.stations()[3].plate === "egg", "再做一份，起锅进盘");`);

/* ── ② ⑥.5 口径断言 ────────────────────────────────────────────────────── */
job("d4_consts", `  A(d4.state().autoPlate === true, "页面开局默认打开「熟了自动落到本列专属盘」");
  A(d4.state().platesTotal === 9 && d4.state().columns === 9, "9 列 × 每列 1 个专属盘（不再限量 3 盘）");
  A(!isFinite(d4.state().plateLife) && d4.state().plateKeep === true && d4.state().serveWindow === 4.5,
    "盘上永久保鲜：plateLife = Infinity（无倒计时）/ plateKeep = true；锅内窗口常量仍是 4.5（兼容层）",
    "plateLife=" + d4.state().plateLife + " plateKeep=" + d4.state().plateKeep);`,
null,
`  A(d4.state().autoPlate === false, "bf-14：页面开局默认**关闭**自动落盘（原断言：默认打开）");
  A(d4.state().panWindow === 4.5 && d4.state().panBurntSticky === true && d4b.B.SERVE_WARN_SEC === 1.0,
    "锅内限时起锅：起锅窗口 4.5s（可调常量）/ 糊锅粘住必须双击 / 最后一秒红闪阈值 1.0s",
    "panWindow=" + d4.state().panWindow + " · sticky=" + d4.state().panBurntSticky);
  A(d4b.B.PAN_PICK_TEXT === "恰好 · 起锅" && d4b.B.PAN_BLOCKED_TEXT === "盘占着 · 没地方放" && d4b.B.PAN_BURNT_TEXT === "糊了 · 双击丢掉",
    "锅内三句状态文案与规则层同源（UI 不可能与行为不一致）");
  A(d4.state().platesTotal === 9 && d4.state().columns === 9, "9 列 × 每列 1 个专属盘（不再限量 3 盘）");
  A(!isFinite(d4.state().plateLife) && d4.state().plateKeep === true && d4.state().serveWindow === 4.5,
    "盘上永久保鲜：plateLife = Infinity（无倒计时）/ plateKeep = true；serveWindow 仍是 4.5",
    "plateLife=" + d4.state().plateLife + " plateKeep=" + d4.state().plateKeep);`);

/* ── ③ ⑥.5：起锅 + 盘被占 → 继续计时 → 糊 → 双击才清 ──────────────────── */
job("d4_pick", `  /* 熟了自动落到本列专属盘 */
  for (let i = 0; i < 320 && !d4.stations()[0].plate; i++) d4.tick(1 / 60);
  A(d4.stations()[0].plate === "congee", "熟了自动落到第 0 列的专属盘（不用手动出锅）", JSON.stringify(d4.plates()));
  A(d4.stations()[0].phase === "plated", "状态机走到 plated（cooking → plated）", d4.stations()[0].phase);
  A(d4.stations()[0].food === null, "落盘后锅位立刻空出来");`,
null,
`  /* bf-14：熟了**不落盘** → 停在「恰好」等起锅；单击锅才起锅 */
  for (let i = 0; i < 320 && !d4.stations()[0].windowOpen; i++) d4.tick(1 / 60);
  A(d4.stations()[0].plate === null, "熟了**没有**自动落盘（原断言：不用手动出锅就落到盘上）", JSON.stringify(d4.plates()));
  A(d4.stations()[0].state === "perfect" && d4.stations()[0].windowOpen === true,
    "停在「恰好」并开着起锅窗口", "剩 " + d4.stations()[0].serveWin + "s");
  A(d4.stations()[0].phase === "window", "状态机：cooking → window（还没 plated）", d4.stations()[0].phase);
  const pick0 = d4.takeOut(0);
  A(pick0.ok === true && pick0.kind === "plated", "单击锅 → 起锅", String(pick0.why));
  A(d4.stations()[0].plate === "congee", "起锅后落到第 0 列的专属盘", JSON.stringify(d4.plates()));
  A(d4.stations()[0].phase === "plated", "状态机走到 plated（cooking → window → plated）", d4.stations()[0].phase);
  A(d4.stations()[0].food === null, "起锅后锅位立刻空出来");`);

job("d4_occupied", `  /* 盘占用 / 锅忙 → 明确原因码 */
  const rej = d4.placeEx("congee", null);
  A(rej.ok === false && rej.why === "plate-occupied", "盘里有东西时拒绝下料（原因码 plate-occupied）", rej.why);
  A(/盘里还有一份/.test(rej.hint || ""), "提示语：盘里还有一份，先送出去", rej.hint);`,
null,
`  /* bf-14：盘里有东西**也能下料**（用户原话「餐盘可以一直放着，锅里也可以同时煮着」）——
     原因码 plate-occupied 从「下料被拒」搬到「起锅被拒」：这份熟了没地方放，窗口走完就糊。 */
  const rej = d4.placeEx("congee", null);
  A(rej.ok === true, "盘里有东西时**照样能下料**（原断言：plate-occupied 拦在下料这一步）", rej.why);
  for (let i = 0; i < 320 && !d4.stations()[0].windowOpen; i++) d4.tick(1 / 60);
  const rej2 = d4.takeOut(0);
  A(rej2.ok === false && rej2.why === "plate-occupied", "起锅被拒：盘里还有一份，没地方放", rej2.why);
  A(/盘里还有一份/.test(rej2.hint || ""), "提示语：盘里还有一份，先送出去", rej2.hint);
  A(d4.stations()[0].windowOpen === true, "被拒之后窗口**继续走**（没被重置、也没暂停）",
    "剩 " + d4.stations()[0].serveWin + "s");
  A(d4.plates().length === 1 && d4.stations()[0].plate === "congee", "盘上那份没被动过");
  /* 把盘上那份送出去 → 盘一空，窗口内再点锅就能起锅（顺带验「出餐不会清锅」，真机修复过） */
  d4.pushCustomer(["congee"]);
  A(d4.serveCol(0).ok === true, "盘上那份送给顾客");
  A(d4.plates().length === 0, "盘空了");
  A(d4.stations()[0].food === "congee" && d4.stations()[0].windowOpen === true,
    "出餐**没有**把锅里那份清掉（bf-14 真机修复：以前点盘会把等起锅的那份抹掉）");
  A(d4.takeOut(0).ok === true, "盘一空，窗口内点锅 → 起锅成功");
  A(d4.stations()[0].plate === "congee" && d4.stations()[0].food === null, "第二份进盘、锅位空出来");
  /* 窗口超时 → 糊 + 记账 + 不自动清（必须双击） */
  d4.trash(0);
  A(d4.placeEx("congee", null).ok === true, "重新下一份白粥");
  for (let i = 0; i < 400 && d4.stations()[0].state !== "burnt"; i++) d4.tick(1 / 60);
  A(d4.stations()[0].state === "burnt", "没人起锅 → 窗口走完那份**糊在锅里**（本轮唯一的报废来源）");
  A(d4.state().burnt === 1 && d4.state().expire === 1, "记账：burnt=1 / expire=1（忘起锅）",
    "burnt=" + d4.state().burnt + " expire=" + d4.state().expire);
  A(d4.placeEx("congee", null).why === "station-occupied", "糊着的时候不能再下料（station-occupied）");
  d4.tick(20);
  A(d4.stations()[0].state === "burnt" && d4.stations()[0].food === "congee",
    "糊残骸**不会自动清**（bf-14：以前 14 秒自己消失）—— 必须双击", d4.stations()[0].state);
  const scToss = d4.state().score;
  A(d4.trashCol(0) === true, "双击第 0 列 → 丢掉糊的（锅 + 盘）");
  A(d4.state().score === scToss, "丢垃圾桶不扣分");
  A(d4.stations()[0].food === null, "锅清空");
  A(d4.placeEx("congee", null).ok === true, "丢掉后这一列马上能再用");
  d4.trash(0);`);

/* ── ④ ⑥.5 没人要那份：等窗口 → 起锅 ──────────────────────────────────── */
job("d4_nowant", `      d4.drop(f, null);
      for (let i = 0; i < 340 && !d4.stations()[col].plate; i++) d4.tick(1 / 60);
      if (d4.stations()[col].plate !== f) continue;`,
null,
`      d4.drop(f, null);
      for (let i = 0; i < 340 && !d4.stations()[col].windowOpen; i++) d4.tick(1 / 60);   // bf-14：等起锅窗口
      if (d4.stations()[col].food !== f) continue;
      d4.takeOut(col);                                                                   // 单击锅 → 起锅进盘
      if (d4.stations()[col].plate !== f) continue;`);

/* ── ⑤ ⑥.6：起锅 + 盘占着也能下料 ──────────────────────────────────────── */
job("d5_pick", `  A(d5.drop("egg", null) === true, "煎蛋下到第 3 列");
  for (let i = 0; i < 300 && !d5.stations()[3].plate; i++) d5.tick(1 / 60);
  A(d5.stations()[3].plate === "egg", "熟了自动落到第 3 列的专属盘");`,
null,
`  A(d5.drop("egg", null) === true, "煎蛋下到第 3 列");
  for (let i = 0; i < 300 && !d5.stations()[3].windowOpen; i++) d5.tick(1 / 60);
  A(d5.stations()[3].plate === null && d5.stations()[3].windowOpen === true,
    "熟了停在起锅窗口里（原断言：自动落到第 3 列的专属盘）");
  A(d5.takeOut(3).ok === true && d5.stations()[3].plate === "egg", "单击锅 → 起锅落到第 3 列的专属盘");`);

job("d5_place", `  A(d5.placeEx("egg", null).why === "plate-occupied", "盘占着这一列 → 下料被拒（但这是占位，不是报废）");
  A(d5.trashCol(3) === true && d5.placeEx("egg", null).ok === true, "双击丢掉后才能再用");`,
null,
`  A(d5.placeEx("egg", null).ok === true, "盘占着**也能下料**（bf-14 新口径；原断言：plate-occupied）");
  A(d5.takeOut(3).why === "raw", "刚下锅那份起锅被拒（raw —— 不是盘的问题）");
  A(d5.trashCol(3) === true && d5.placeEx("egg", null).ok === true, "双击丢掉后才能再用");`);

/* ── ⑥ ⑥.7 渲染：起锅提示 + 倒计时；盘被占文案；图例 / 底排说明 ────────── */
job("d6_render", `  d6.drop("egg", null);
  for (let i = 0; i < 300 && !d6.stations()[3].plate; i++) d6.tick(1 / 60);
  d6b.canvas()._m.texts.length = 0;
  d6b.pump(1);`,
null,
`  d6.drop("egg", null);
  for (let i = 0; i < 300 && !d6.stations()[3].windowOpen; i++) d6.tick(1 / 60);
  /* bf-14 新 UI：锅内「恰好」→ 画「起锅」提示 + 窗口倒计时（t6p）*/
  d6b.canvas()._m.texts.length = 0;
  d6b.pump(1);
  const t6p = d6b.canvas()._m.texts;
  A(t6p.some(x => /起锅/.test(x)), "锅里熟了 → 画出「起锅」提示", (t6p.filter(x => /起锅/.test(x))[0] || ""));
  A(t6p.some(x => /恰好 · 起锅 \d+\.\d+s/.test(x)), "同时画出窗口倒计时环的秒数（恰好 · 起锅 N.Ns）",
    (t6p.filter(x => /恰好 · 起锅/.test(x))[0] || ""));
  A(t6p.some(x => /点锅起锅/.test(x)), "图例②写明「熟了 4.5s 内点锅起锅」",
    (t6p.filter(x => /点锅起锅/.test(x))[0] || ""));
  A(t6p.some(x => /盘被占了就只能糊掉/.test(x)), "底排说明写明「盘被占了就只能糊掉（双击丢弃再用锅）」",
    (t6p.filter(x => /盘被占/.test(x))[0] || ""));
  A(!t6p.some(x => /自动落盘/.test(x)) && !t6p.some(x => /内送出/.test(x)),
    "画面上没有任何「自动落盘 / N.Ns 内送出」这类旧文案");
  /* 盘被占 → 锅上明说「没地方放」（红字）*/
  d6.takeOut(3);
  d6.drop("egg", null);
  for (let i = 0; i < 300 && !d6.stations()[3].windowOpen; i++) d6.tick(1 / 60);
  d6b.canvas()._m.texts.length = 0;
  d6b.pump(1);
  const t6q = d6b.canvas()._m.texts;
  A(t6q.some(x => /盘占着 · 没地方放/.test(x)), "盘被占 → 锅上画「盘占着 · 没地方放」",
    (t6q.filter(x => /没地方放/.test(x))[0] || ""));
  /* 回到「盘上永久保鲜」那条渲染线：把第 3 列清干净，重新起锅一份 */
  d6.trash(3);
  d6.drop("egg", null);
  for (let i = 0; i < 300 && !d6.stations()[3].windowOpen; i++) d6.tick(1 / 60);
  d6.takeOut(3);
  d6b.canvas()._m.texts.length = 0;
  d6b.pump(1);`);

/* ── ⑦ 通过路径机器人 ─────────────────────────────────────────────────── */
job("win_bot", `  let guard = 0;
  while (!d2.state().over && guard++ < 4000) {
    const os = d2.orders();
    for (const c of os) for (const f of c.order) {
      if (c.done.indexOf(f) >= 0) continue;
      if (d2.stations().some(s => s.food === f)) continue;
      if (d2.plates().some(p => p.food === f && p.state !== "burnt")) continue;   // 这一列盘上已有
      d2.drop(f, null);                                                            // 食材只进它自己那一列（自动落盘）
    }
    for (let n = 0; n < 60 && !d2.state().over; n++) { d2.tick(1 / 60); if (d2.plates().some(p => p.state === "perfect")) break; }
    if (d2.state().over) break;
    /* 单击每一列的专属盘 → 自动送给「正在需要 + 耐心最少」的顾客（新玩法的连做节奏） */
    d2.stations().forEach((s, i) => { if (s.plate && s.plateState !== "burnt") d2.serveCol(i); });
    /* 糊的 / 没人要的存货清掉，别堵着某一列 */
    d2.stations().forEach((s, i) => {
      if (s.state === "burnt" || s.plateState === "burnt") { d2.trash(i); return; }
      if (s.plate) { const r = d2.serveCol(i); if (!r.ok && r.why === "no-want") d2.trash(i); }
    });
    d2.tick(0.15);
  }`,
null,
`  let guard = 0;
  while (!d2.state().over && guard++ < 4000) {
    /* ① 起锅：锅里进窗口的那份 → 单击锅（盘被占就先点盘把旧的送出去）（bf-14）*/
    d2.stations().forEach((s, i) => {
      if (s.state === "perfect" && s.windowOpen) {
        if (s.plate) { const r = d2.serveCol(i); if (!r.ok) d2.trash(i); }
        else d2.takeOut(i);
      }
    });
    /* ② 盘上的存货 → 单击盘送给要的人；糊的 / 没人要的丢掉，别堵着某一列 */
    d2.stations().forEach((s, i) => {
      if (s.state === "burnt" || s.plateState === "burnt") { d2.trash(i); return; }
      if (s.plate) { const r = d2.serveCol(i); if (!r.ok && r.why === "no-want") d2.trash(i); }
    });
    /* ③ 看单下料（每样只进自己那一列）*/
    for (const c of d2.orders()) for (const f of c.order) {
      if (c.done.indexOf(f) >= 0) continue;
      if (d2.stations().some(s => s.food === f)) continue;
      if (d2.plates().some(p => p.food === f && p.state !== "burnt")) continue;
      d2.drop(f, null);
    }
    for (let n = 0; n < 60 && !d2.state().over; n++) {
      d2.tick(1 / 60);
      if (d2.stations().some(s => s.windowOpen)) break;
    }
    if (d2.state().over) break;
    d2.tick(0.15);
  }`);

job("win_assert", `  A(win.win === true, "拿到 win:true", "served " + win.served + "/" + win.goal);
  A(win.served >= 8, "服务满 8 位顾客", win.served + " 位");`,
null,
`  A(win.win === true, "拿到 win:true", "served " + win.served + "/" + win.goal);
  A(win.served >= 8, "服务满 8 位顾客", win.served + " 位");
  A(win.burnt === 0, "全程按新规则点锅起锅 → 一份都没糊（bf-14：限时起锅是能做到的）", "burnt=" + win.burnt);`);

/* ── ⑧ driveWin（胶水层真打赢一局）────────────────────────────────────── */
job("drivewin", `/** 真打赢一局（看单下料 → 熟了自动落盘 → 单击盘出餐） */
function driveWin(B) {
  const d = B.debug;
  let guard = 0;
  while (!d.state().over && guard++ < 6000) {
    for (const c of d.orders()) for (const f of c.order) {
      if (c.done.indexOf(f) >= 0) continue;
      if (d.stations().some(s => s.food === f)) continue;
      if (d.plates().some(p => p.food === f && p.state !== "burnt")) continue;
      d.drop(f, null);
    }
    for (let n = 0; n < 60 && !d.state().over; n++) { d.tick(1 / 60); if (d.plates().some(p => p.state === "perfect")) break; }
    if (d.state().over) break;
    d.stations().forEach((s, i) => { if (s.plate && s.plateState !== "burnt") d.serveCol(i); });
    d.stations().forEach((s, i) => {
      if (s.state === "burnt" || s.plateState === "burnt") { d.trash(i); return; }
      if (s.plate) { const r = d.serveCol(i); if (!r.ok && r.why === "no-want") d.trash(i); }
    });
    d.tick(0.15);`,
null,
`/** 真打赢一局（看单下料 → 锅里熟了**在窗口内点锅起锅** → 单击盘出餐）*/
function driveWin(B) {
  const d = B.debug;
  let guard = 0;
  while (!d.state().over && guard++ < 6000) {
    d.stations().forEach((s, i) => {                     // ① 起锅（bf-14）
      if (s.state === "perfect" && s.windowOpen) {
        if (s.plate) { const r = d.serveCol(i); if (!r.ok) d.trash(i); }
        else d.takeOut(i);
      }
    });
    d.stations().forEach((s, i) => {                     // ② 盘上的存货送出去 / 清掉
      if (s.state === "burnt" || s.plateState === "burnt") { d.trash(i); return; }
      if (s.plate) { const r = d.serveCol(i); if (!r.ok && r.why === "no-want") d.trash(i); }
    });
    for (const c of d.orders()) for (const f of c.order) {   // ③ 看单下料
      if (c.done.indexOf(f) >= 0) continue;
      if (d.stations().some(s => s.food === f)) continue;
      if (d.plates().some(p => p.food === f && p.state !== "burnt")) continue;
      d.drop(f, null);
    }
    for (let n = 0; n < 60 && !d.state().over; n++) {
      d.tick(1 / 60);
      if (d.stations().some(s => s.windowOpen)) break;
    }
    if (d.state().over) break;
    d.tick(0.15);`);

/* ── ⑨ 音效段：落盘不响 ───────────────────────────────────────────────── */
job("audio_plate", `    const nBefore = cookCalls("egg").length;
    for (let k = 0; k < 200 && !d.stations()[3].plate; k++) d.tick(1 / 60);
    A(!!d.stations()[3].plate, "煎蛋熟了自动落到专属盘（不响下锅音效的前提）");`,
null,
`    const nBefore = cookCalls("egg").length;
    for (let k = 0; k < 200 && !d.stations()[3].windowOpen; k++) d.tick(1 / 60);
    A(d.takeOut(3).ok === true && !!d.stations()[3].plate, "煎蛋窗口内点锅起锅 → 落到专属盘（不响下锅音效的前提）");`);

/* ── ⑩ bf-9 段：两处等落盘 ─────────────────────────────────────────────── */
job("bf9_plate", `    d.drop("egg", null);
    for (let k = 0; k < 200 && !d.stations()[3].plate; k++) d.tick(1 / 60);
    A(!!d.stations()[3].plate, "煎蛋已经落在第 3 列的专属盘上");`,
null,
`    d.drop("egg", null);
    for (let k = 0; k < 200 && !d.stations()[3].windowOpen; k++) d.tick(1 / 60);
    A(d.takeOut(3).ok === true && !!d.stations()[3].plate, "煎蛋已经落在第 3 列的专属盘上（窗口内点锅起锅）");`);

job("bf9_congee", `    d.drop("congee", null);
    for (let k = 0; k < 300 && !d.stations()[0].plate; k++) d.tick(1 / 60);
    d.setPatience(idFull, 1.0);                            // = 初始耐心（满）`,
null,
`    d.drop("congee", null);
    for (let k = 0; k < 300 && !d.stations()[0].windowOpen; k++) d.tick(1 / 60);
    d.takeOut(0);                                          // bf-14：点锅起锅才进盘
    d.setPatience(idFull, 1.0);                            // = 初始耐心（满）`);

job("bf9_egg2", `    d.drop("egg", null);
    for (let k = 0; k < 300 && !d.stations()[3].plate; k++) d.tick(1 / 60);
    const fAbs = abs(idFirst, 8), oAbs = abs(idOther, 9);`,
null,
`    d.drop("egg", null);
    for (let k = 0; k < 300 && !d.stations()[3].windowOpen; k++) d.tick(1 / 60);
    d.takeOut(3);                                          // bf-14：点锅起锅才进盘
    const fAbs = abs(idFirst, 8), oAbs = abs(idOther, 9);`);

const dir = path.join(OUT, "tools", "bf", "_patch");
for (const t of T) fs.writeFileSync(path.join(dir, "bf14h_" + t.name + ".txt"), t.text.replace(/\r\n/g, "\n"), "utf8");
fs.writeFileSync(path.join(dir, "jobs_bf14_headless.json"), JSON.stringify({ jobs: jobs }, null, 1), "utf8");
console.log("✓ 生成 " + T.length + " 个 job → tools/bf/_patch/jobs_bf14_headless.json");
T.forEach((t, i) => console.log("  job#" + (i + 1) + " · " + t.name + " · " + t.text.split("\n").length + " 行"));
