/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_headless.js — 无头验收（tools/bf/headless.js）的作业单

   两类改动：
     ① 5 处**受改动影响的旧断言**：
          · setCook(3, 3.2) 已不在新表的完美窗口里（煎蛋 2.2+0.7=2.9 出窗口）
          · 列头小字写死了「白粥 · 汤锅 · 5.0s」→ 3.4s
          · audio/bf 素材清单从 5 个变 17 个（6 条欢呼 + 9 条下锅音效）
          · happy 变体从 3 条变 6 条（正则 + 计数）
     ② **新增一整段 runBf9()**：用户这四条改动的无头证据链 ——
          全部走**真实鼠标事件** + **假 Audio 的调用序列**（不是读内部变量）：
          · 点 9 个食材桶 → 各自 new Audio("audio/bf/cook_*.mp3")（9×3 条断言）
          · 同一食材 300ms 节流 / 不同食材同时最多 2 条
          · 开关关掉 → 一条都不播（台账留 off）
          · 3 位都要同一份（耐心 5/20/40）→ 真实点盘必定送给耐心 5 那位
          · 「不再只能给第一位」：第一位秒数更少但进度条更长 → 给进度条短的那位
          · 部分上餐 +3.5s 且不超过初始耐心

   ⚠ 行尾：headless.js 是 CRLF 为主、夹少数 LF —— 锚点两种都试，哪种恰好 1 次用哪种。

   用法：
     node tools/bf/_patch/build_jobs_bf9_headless.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_headless.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/bf/headless.js";
const jobs = [];
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function J(from, text) { jobs.push({ file: FILE, from, to: null, text }); }

/* ── ① setCook：煎蛋的完美窗口变成 [2.2, 2.9) ─────────────────────────── */
J(`  B.debug.setCook(3, 3.2); pump(2); const sPerf = strokesAt();`,
  `  B.debug.setCook(3, 2.5); pump(2); const sPerf = strokesAt();   // 新表：煎蛋 2.2s 熟 / 2.9s 出窗口`);

J(`  B.debug.place("congee", 0);                    // 白粥：5.0s 恰好 / 7.8s 糊`,
  `  B.debug.place("congee", 0);                    // 白粥：3.4s 恰好 / 5.6s 糊（bf-9 新表）`);

/* ── ② 列头小字里的时长 ───────────────────────────────────────────────── */
J(`  A(t6.some(x => /白粥 · 汤锅 · 5\\.0s/.test(x)), "列头小字：食材 · 厨具 · 时长", (t6.filter(x => /汤锅/.test(x))[0] || ""));`,
  `  A(t6.some(x => /白粥 · 汤锅 · 3\\.4s/.test(x)), "列头小字：食材 · 厨具 · 时长（新表：白粥 3.4s）", (t6.filter(x => /汤锅/.test(x))[0] || ""));`);

/* ── ③ audio/bf 素材清单：5 个 → 17 个 ────────────────────────────────── */
J(`  const FILES = ["tick.mp3", "happy.mp3", "happy2.mp3", "happy3.mp3", "slow.mp3"];`,
`  /* bf-9：欢呼换成 6 条新录音（都是实测上扬的），另加 9 条「下锅那一刻」的烹饪音效 */
  const FILES = ["tick.mp3", "slow.mp3",
                 "happy_v1.mp3", "happy_v2.mp3", "happy_v3.mp3",
                 "happy_v4.mp3", "happy_v5.mp3", "happy_v6.mp3",
                 "cook_congee.mp3", "cook_milk.mp3", "cook_soup.mp3", "cook_egg.mp3",
                 "cook_bacon.mp3", "cook_sandwich.mp3", "cook_bun.mp3",
                 "cook_salad.mp3", "cook_juice.mp3"];`);

J(`  A(missing.length === 0, "audio/bf 五个素材都在磁盘上且非空",
    missing.length ? "缺：" + missing.join(",") : FILES.join(" · "));`,
`  A(missing.length === 0, "audio/bf " + FILES.length + " 个素材都在磁盘上且非空",
    missing.length ? "缺：" + missing.join(",") : FILES.length + " 个都齐");`);

J(`  const voices = ["happy.mp3", "happy2.mp3", "happy3.mp3", "slow.mp3"].map(f => mp3.mp3Info(path.join(bfDir, f)));
  A(voices.every(i => i.sampleRate === 48000 && i.channels === 1), "四条语音都是 48kHz / 单声道",
    voices.map(i => i.duration.toFixed(2)).join("s / ") + "s");
  A(voices.every(i => i.decoded > 0.4), "四条语音都有实际内容（>0.4s，不是空文件）",
    voices.map(i => (i.decoded * 1000).toFixed(0) + "ms").join(" · "));`,
`  const voices = ["happy_v1.mp3", "happy_v2.mp3", "happy_v3.mp3", "happy_v4.mp3",
                  "happy_v5.mp3", "happy_v6.mp3", "slow.mp3"].map(f => mp3.mp3Info(path.join(bfDir, f)));
  A(voices.every(i => i.sampleRate === 48000 && i.channels === 1), "七条语音都是 48kHz / 单声道",
    voices.map(i => i.duration.toFixed(2)).join("s / ") + "s");
  A(voices.every(i => i.decoded > 0.4), "七条语音都有实际内容（>0.4s，不是空文件）",
    voices.map(i => (i.decoded * 1000).toFixed(0) + "ms").join(" · "));
  A(voices.every(i => i.decoded <= 3.0), "六条欢呼每条 ≤ 3s（边做边喊不至于叠成一片）",
    voices.map(i => i.decoded.toFixed(2)).join(" / "));
  /* 9 条下锅音效都是「短促的一声」：0.2s < 时长 ≤ 0.8s */
  const cookInfos = FILES.filter(f => /^cook_/.test(f)).map(f => mp3.mp3Info(path.join(bfDir, f)));
  A(cookInfos.length === 9 && cookInfos.every(i => i.decoded > 0.2 && i.decoded <= 0.8),
    "9 条下锅音效都是短促一声（0.2~0.8s）",
    cookInfos.map(i => (i.decoded * 1000).toFixed(0)).join("/") + "ms");
  A(cookInfos.every(i => i.sampleRate === 48000 && i.channels === 1), "9 条下锅音效规格与别的素材一致（48kHz / 单声道）");`);

/* ── ④ happy 变体：3 条 → 6 条 ────────────────────────────────────────── */
J(`  const happyCalls = () => rec.audio.filter(c => /audio\\/bf\\/happy(2|3)?\\.mp3$/.test(c.src));`,
  `  const happyCalls = () => rec.audio.filter(c => /audio\\/bf\\/happy_v[1-6]\\.mp3$/.test(c.src));`);

J(`  A(a0.files.happy.length === 3 && a0.files.tick.length === 1 && a0.files.slow.length === 1,
    "词表：滴答 1 条 · 呜呼 3 个变体 · 哼 1 条",
    "tick=" + a0.files.tick.join(",") + " happy=" + a0.files.happy.join(","));`,
`  A(a0.files.happy.length === 6 && a0.files.tick.length === 1 && a0.files.slow.length === 1,
    "词表：滴答 1 条 · 欢呼 6 个变体（bf-9 重做）· 哼 1 条",
    "tick=" + a0.files.tick.join(",") + " happy=" + a0.files.happy.join(","));
  const cookKeys = Object.keys(a0.cookFiles || {});
  A(cookKeys.length === 9 && cookKeys.every(f => (a0.files["cook_" + f] || []).length === 1),
    "词表：9 样食材各有一条下锅音效，且都挂进同一张素材表（开关 / 回落 / 台账复用）",
    cookKeys.map(f => f + "→" + ((a0.files["cook_" + f] || [])[0] || "无")).join(" "));
  A(a0.cookGap === 0.3 && a0.cookMax === 2,
    "下锅音效的纪律：同食材 300ms 节流 · 同时最多 2 条",
    a0.cookGap + "s / " + a0.cookMax + " 条");`);

J(`  A(!!happyCalls()[0] && /^audio\\/bf\\/happy(2|3)?\\.mp3$/.test(happyCalls()[0].src),
    "播的是三个变体之一：" + ((happyCalls()[0] || {}).src || "无"));`,
`  A(!!happyCalls()[0] && /^audio\\/bf\\/happy_v[1-6]\\.mp3$/.test(happyCalls()[0].src),
    "播的是六个变体之一：" + ((happyCalls()[0] || {}).src || "无"));`);

/* ── ⑤ 新增 runBf9()：四条改动的无头证据链 ────────────────────────────── */
const RUNBF9 = `/* ═══════════════════════════════════════════════════════════════════════════
   bf-9 四条改动（用户实测后提的）—— 全部走**真实鼠标事件** + **假 Audio 的调用序列**：
     ① 新时长表：9 列各自在自己的时刻熟（最长 3.4s，白粥不再拖垮节奏）
     ② 下锅音效：点哪样响哪样（9 样一对一）、同食材 300ms 节流、同时最多 2 条、开关能关掉
     ③ 上餐选人：3 位都要同一份（耐心 5/20/40）→ 必定送给耐心 5 那位；
        以及「不再只能给第一位」—— 第一位秒数更少但进度条更长时，给进度条短的那位
     ④ 部分上餐：真实点盘送一样 → 耐心 +3.5s，且**不超过他的初始耐心**
   ═══════════════════════════════════════════════════════════════════════════ */
function runBf9() {
  const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const CANON = { congee:"白粥", milk:"热牛奶", soup:"清汤", egg:"煎蛋", bacon:"培根",
                  sandwich:"三明治", bun:"包子", salad:"沙拉", juice:"果汁" };
  /** 开一局 + 拿到画布（真实鼠标事件要往画布上 dispatch）*/
  function newGame(goal) {
    const g = boot();
    A(g.B.start(g.host, { target: { id: "su", name: "苏晚晴", bond: 40 },
                          duration: 999, goal: goal || 99, onFinish() {} }) === true,
      "bf-9：新开一局（duration 999 / goal " + (goal || 99) + "）");
    return { g: g, B: g.B, d: g.B.debug, rec: g.record, cv: g.canvas() };
  }
  const click = (cv, pt) => cv.dispatch("mousedown", { clientX: pt.x, clientY: pt.y, preventDefault() {} });

  /* ── ① 下锅音效：真实鼠标点 9 个食材桶 ── */
  {
    const G = newGame();
    const B = G.B, d = G.d, rec = G.rec, cv = G.cv;
    const cookCalls = f => rec.audio.filter(c => c.src === "audio/bf/cook_" + f + ".mp3");
    A(d.audio().cookFiles && Object.keys(d.audio().cookFiles).length === 9,
      "下锅音效映射表有 9 条（食材 → 文件）", JSON.stringify(d.audio().cookFiles));
    const seen = [];
    for (let i = 0; i < 9; i++) {
      const f = B.FOOD_IDS[i], bp = center(B.bucketBox(i));
      const n0 = rec.audio.length;
      click(cv, bp);                                     // ← 真实鼠标点「第 i 个食材桶」
      const got = cookCalls(f);
      seen.push((got[0] || {}).src || "");
      A(got.length === 1, "点「" + CANON[f] + "」桶 → new Audio(audio/bf/cook_" + f + ".mp3)",
        got.length + " 条：" + rec.audio.slice(n0).map(c => c.src.replace("audio/bf/", "")).join(","));
      A(got.length === 1 && got[0].volume >= 0.3 && got[0].volume <= 0.6,
        "「" + CANON[f] + "」下锅音量落在 0.3~0.6（不吵）", got[0] ? String(got[0].volume) : "无");
      A(d.state().cooks === i + 1, "台账记下锅次数（" + CANON[f] + " → " + (i + 1) + "）",
        String(d.state().cooks));
      d.tick(0.75);                                      // 让这一条播完（不同食材也受并发上限约束）
    }
    A(new Set(seen).size === 9 && seen.every(s => /^audio\\/bf\\/cook_\\w+\\.mp3$/.test(s)),
      "9 个桶点到的是 9 个**互不相同**的文件", seen.map(s => s.replace("audio/bf/", "")).join(" "));
    /* 落盘 / 上餐不响下锅音效 */
    const nBefore = cookCalls("egg").length;
    for (let k = 0; k < 200 && !d.stations()[3].plate; k++) d.tick(1 / 60);
    A(!!d.stations()[3].plate, "煎蛋熟了自动落到专属盘（不响下锅音效的前提）");
    A(cookCalls("egg").length === nBefore, "出锅 / 落盘不响下锅音效（只在下锅那一刻响）",
      cookCalls("egg").length + " 条");
    G.B.dispose();
  }

  /* ── ② 同一食材 300ms 节流（真实连点同一个桶）── */
  {
    const G = newGame();
    const d = G.d, rec = G.rec, cv = G.cv;
    const jp = center(G.B.bucketBox(8));                 // 第 8 桶 = 果汁
    const juice = () => rec.audio.filter(c => /cook_juice\\.mp3$/.test(c.src));
    d.tick(0.4);                                         // 先离开上一局残留的窗口（新局其实没有，保险）
    rec.audio.length = 0;
    click(cv, jp);
    A(juice().length === 1, "第一次点果汁 → 响一条", juice().length + " 条");
    d.trashCol(8);                                       // 清空这一列，马上再点（时间不推进）
    click(cv, jp);
    A(juice().length === 1, "300ms 内连点同一样 → 不叠第二声（COOK_MIN_GAP）", juice().length + " 条");
    A(d.audio().log.filter(r => r.why === "throttle").length === 1, "被节流的那次留了 throttle 记录（可诊断）",
      d.audio().log.filter(r => r.why).map(r => r.why).join(","));
    A(d.audio().plays.filter(p => p.name === "cook_juice").length === 1, "被节流的不算「播成功」");
    d.trashCol(8); d.tick(0.35);                         // 过 300ms 窗口
    click(cv, jp);
    A(juice().length === 2, "过了 300ms → 再点能响（不是「一局只响一次」）", juice().length + " 条");
    G.B.dispose();
  }

  /* ── ③ 不同食材可叠，但同一时刻最多 2 条 ── */
  {
    const G = newGame();
    const d = G.d, rec = G.rec, cv = G.cv;
    rec.audio.length = 0;
    [0, 1, 3, 7].forEach(i => click(cv, center(G.B.bucketBox(i))));   // 白粥 / 牛奶 / 煎蛋 / 沙拉，同一时刻
    const n = rec.audio.filter(c => /cook_/.test(c.src)).length;
    A(n === 2, "同时点 4 样不同食材 → 只响 2 条（并发上限 2，不糊成一片）", n + " 条");
    A(d.audio().log.filter(r => r.why === "busy").length === 2, "被并发上限挡下的 2 次留了 busy 记录",
      d.audio().log.filter(r => r.why).map(r => r.why).join(","));
    A(d.state().cooks === 2, "台账只记 2 次下锅音效", String(d.state().cooks));
    G.B.dispose();
  }

  /* ── ④ 开关关掉 → 下锅音效一条都不播 ── */
  {
    const G = newGame();
    const d = G.d, rec = G.rec, cv = G.cv;
    A(d.setSound(false) === false, "关掉音效开关（与滴答 / 语音同一个开关）");
    rec.audio.length = 0;
    click(cv, center(G.B.bucketBox(8)));
    click(cv, center(G.B.bucketBox(3)));
    A(rec.audio.length === 0, "关掉之后点食材下锅：一条都不播（没有 new Audio）", rec.audio.length + " 次调用");
    const log = d.audio().log.filter(r => /^cook_/.test(r.name));
    A(log.length >= 2 && log.every(r => r.why === "off"),
      "但台账留了 off 记录（可诊断）", log.map(r => r.name + ":" + r.why).join(","));
    d.setSound(true);
    G.B.dispose();
  }

  /* ── ⑤ 上餐选人 + 部分上餐（真实鼠标点专属盘）── */
  {
    const G = newGame();
    const B = G.B, d = G.d, cv = G.cv;
    A(d.state().partialBonusPer === 3.5 && d.state().serveDangerSec === 6,
      "新常量暴露给验收：部分上餐 +3.5s · 救命档 6s",
      d.state().partialBonusPer + " / " + d.state().serveDangerSec);
    const idLate = d.pushCustomer(["egg", "congee"]);      // 先来的
    const idMid = d.pushCustomer(["egg", "salad"]);
    const idHurry = d.pushCustomer(["egg", "juice"]);      // 最后来的
    const abs = (id, want) => {                            // 按绝对值摆耐心（返回摆好后的值）
      const o = d.orders().filter(x => x.id === id)[0];
      if (!o) return null;
      d.setPatience(id, want / o.patienceMax);
      return d.orders().filter(x => x.id === id)[0].patience;
    };
    /* 先把煎蛋煮好落到盘上（这一段耐心会掉，所以摆值放在点击前一刻）*/
    d.drop("egg", null);
    for (let k = 0; k < 200 && !d.stations()[3].plate; k++) d.tick(1 / 60);
    A(!!d.stations()[3].plate, "煎蛋已经落在第 3 列的专属盘上");
    const pLate = abs(idLate, 40), pMid = abs(idMid, 20), pHurry = abs(idHurry, 5);
    A(Math.abs(pLate - 40) < 0.05 && Math.abs(pMid - 20) < 0.05 && Math.abs(pHurry - 5) < 0.05,
      "3 位顾客的耐心分别摆成 40 / 20 / 5", pLate + " / " + pMid + " / " + pHurry);
    A(d.pickFor("egg") === idHurry, "规则层：正需要这份的 3 位里挑耐心最少的（#" + idHurry + "）",
      "pickFor → #" + d.pickFor("egg"));
    click(cv, center(B.plateBox(3)));                      // ← 真实鼠标单击第 3 列的专属盘
    const after = d.orders();
    const got = after.filter(o => o.done.indexOf("egg") >= 0).map(o => o.id);
    A(got.length === 1 && got[0] === idHurry,
      "真实点盘 → 煎蛋送给耐心 5 那位（不是第一位）", "拿到煎蛋的是 #" + got.join("/"));
    const hurry = after.filter(o => o.id === idHurry)[0];
    A(!!hurry && Math.abs(hurry.patience - 8.5) < 0.1,
      "他还缺 juice → 部分上餐给他回 +3.5s 耐心（5 → 8.5）", hurry ? String(hurry.patience) : "无");
    A(d.state().partialServes === 1 && d.state().partialBonus === 3.5,
      "台账：部分上餐 1 次 / 一共回了 3.5s", d.state().partialServes + " 次 / " + d.state().partialBonus + "s");

    /* 上限：耐心已经顶到初始值 → 再送一样只加余量（不越过初始耐心）*/
    const idFull = d.pushCustomer(["congee", "bacon"]);
    const oFull = d.orders().filter(x => x.id === idFull)[0];
    d.drop("congee", null);
    for (let k = 0; k < 300 && !d.stations()[0].plate; k++) d.tick(1 / 60);
    d.setPatience(idFull, 1.0);                            // = 初始耐心（满）
    const full0 = d.orders().filter(x => x.id === idFull)[0].patience;
    A(Math.abs(full0 - oFull.patienceMax) < 0.05, "把这位摆成「满耐心」（= 初始耐心）", String(full0));
    click(cv, center(B.plateBox(0)));
    const full1 = d.orders().filter(x => x.id === idFull)[0];
    A(!!full1 && Math.abs(full1.patience - oFull.patienceMax) < 0.05,
      "满耐心时再收一样 → 顶到初始耐心就停（不能靠上餐无限续命）",
      full1 ? full1.patience + " / 上限 " + full1.patienceMax : "无");

    /* 不再「只能给第一位」：第一位秒数更少、但进度条更长 → 给进度条短的那位 */
    d.tick(0.4);
    const idFirst = d.pushCustomer(["egg", "bacon"]);       // 先来（短单）
    const idOther = d.pushCustomer(["egg", "congee", "soup"]); // 后来（长单）
    d.drop("egg", null);
    for (let k = 0; k < 300 && !d.stations()[3].plate; k++) d.tick(1 / 60);
    const fAbs = abs(idFirst, 8), oAbs = abs(idOther, 9);
    const os = d.orders();
    const fO = os.filter(o => o.id === idFirst)[0], oO = os.filter(o => o.id === idOther)[0];
    A(Math.abs(fAbs - 8) < 0.05 && Math.abs(oAbs - 9) < 0.05, "第一位 8s / 第二位 9s（第一位绝对秒数更少）",
      fAbs + " / " + oAbs);
    A(fO.patience / fO.patienceMax > oO.patience / oO.patienceMax,
      "但第一位的进度条更长（" + (fO.patience / fO.patienceMax).toFixed(2) + " > " +
      (oO.patience / oO.patienceMax).toFixed(2) + "）→ 只比秒数的旧规则会给他");
    A(d.pickFor("egg") === idOther, "新规则给进度条最短的那位（不再「只能给第一位」）",
      "pickFor → #" + d.pickFor("egg") + "（第一位是 #" + idFirst + "）");
    click(cv, center(B.plateBox(3)));
    const got2 = d.orders().filter(o => o.done.indexOf("egg") >= 0).map(o => o.id);
    A(got2.indexOf(idOther) >= 0 && got2.indexOf(idFirst) < 0,
      "真实点盘 → 落在进度条最短那位头上", "拿到煎蛋的是 #" + got2.join("/"));
    G.B.dispose();
  }
}

runMain();
runAudio();          // 音效 / 顾客语音（bf-audio-1）
runBf9();            // bf-9：用户实测后的四条改动
`;

J(`runMain();
runAudio();          // 音效 / 顾客语音（bf-audio-1）`,
  RUNBF9);

/* ── 落盘：锚点行尾逐个核对 ───────────────────────────────────────────── */
const src = fs.readFileSync(path.join(OUT, FILE), "utf8");
jobs.forEach((job, i) => {
  if (countOcc(src, job.from) === 1) return;
  const c = crlf(job.from), ct = crlf(job.text);
  if (countOcc(src, c) === 1) { job.from = c; job.text = ct; return; }
  console.error("✗ job#" + (i + 1) + " 锚点出现 " + countOcc(src, job.from) + " 次（CRLF 版 " +
    countOcc(src, c) + " 次）");
  console.error("  锚首 80 字：" + JSON.stringify(job.from.slice(0, 80)));
  process.exit(1);
});
fs.writeFileSync(path.join(__dirname, "jobs_bf9_headless.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_headless.json：" + jobs.length + " 个 job");
