/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/_patch/build_jobs_bf9_e2e.js — 真浏览器验收（tools/bf/e2e-audio.js）的作业单

   改两类：
     ① 旧断言跟着走：素材清单 5 → 17 个；happy 变体正则 3 → 6。
     ② **新增两段真浏览器用例**（用户这轮要求：要在真 Chrome 里验证）：
          ⑥ 点果汁 / 点煎蛋 → 真的播了 cook_juice.mp3 / cook_egg.mp3
             （用**真实 MouseEvent** 点在画布的食材桶上，不是 debug API）
             + 同一食材 300ms 节流
          ⑦ 3 位都要煎蛋、耐心摆成 30 / 12 / 5 → 真实点专属盘必定送给耐心 5 那位，
             并且给他 +3.5s 部分上餐耐心

   ⚠⚠ 本文件全部用 **String.raw**：e2e-audio.js 里的被测代码本身就是「模板字符串里再写正则」，
      所以文件里会出现 `\\.` 这种**双反斜杠**；普通模板字符串会把它吃成单反斜杠，
      锚点就永远匹配不上（第一次就是这么挂的）。String.raw 里写什么就是什么。
      （嵌套模板字符串用 TICK 这个变量拼：String.raw 里没法直接写反引号。）
   ⚠ e2e-audio.js 是纯 LF；锚点按 LF 写，落盘前再逐个核对一次行尾。

   用法：
     node tools/bf/_patch/build_jobs_bf9_e2e.js
     node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf9_e2e.json --fresh-bak
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..", "..");
const FILE = "tools/bf/e2e-audio.js";
const BT = String.fromCharCode(96);          // 反引号（生成的文件里要用它包住注入页面的代码）
const jobs = [];
const crlf = s => String(s).replace(/\r?\n/g, "\r\n");
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}
function J(from, text) { jobs.push({ file: FILE, from, to: null, text }); }

/* ── ① 素材清单：5 → 17 ───────────────────────────────────────────────── */
J(String.raw`const FILES = ["tick.mp3", "happy.mp3", "happy2.mp3", "happy3.mp3", "slow.mp3"];`,
String.raw`/* bf-9：欢呼换成 6 条新录音（实测上扬），另加 9 条「下锅那一刻」的烹饪音效 */
const FILES = ["tick.mp3", "slow.mp3",
               "happy_v1.mp3", "happy_v2.mp3", "happy_v3.mp3",
               "happy_v4.mp3", "happy_v5.mp3", "happy_v6.mp3",
               "cook_congee.mp3", "cook_milk.mp3", "cook_soup.mp3", "cook_egg.mp3",
               "cook_bacon.mp3", "cook_sandwich.mp3", "cook_bun.mp3",
               "cook_salad.mp3", "cook_juice.mp3"];`);

J(String.raw`  A(FILES.every(f => fs.existsSync(path.join(OUT, "audio", "bf", f))), "五个素材文件在磁盘上（" + FILES.length + " 个）");`,
String.raw`  A(FILES.every(f => fs.existsSync(path.join(OUT, "audio", "bf", f))), "全部素材文件在磁盘上（" + FILES.length + " 个）");`);

J(String.raw`  A(String(decode).indexOf("EXC:") !== 0 && bad.length === 0, "五个素材在真 Chrome 里都能解码播放", String(decode));`,
String.raw`  A(String(decode).indexOf("EXC:") !== 0 && bad.length === 0,
    FILES.length + " 个素材在真 Chrome 里都能解码播放", String(decode));`);

/* ── ② happy 变体：3 → 6 ──────────────────────────────────────────────── */
J(String.raw`    return JSON.stringify({ served: served, n: plays.filter(function(p){ return /happy(2|3)?\\.mp3$/.test(p.url); }).length, plays: plays });`,
String.raw`    return JSON.stringify({ served: served, n: plays.filter(function(p){ return /happy_v[1-6]\\.mp3$/.test(p.url); }).length, plays: plays });`);

J(String.raw`  A(jh.n === 1, "上餐成功 → 恰好播一条「呜呼」（三个变体之一）",
    JSON.stringify((jh.plays || []).map(p => p.url)));`,
String.raw`  A(jh.n === 1, "上餐成功 → 恰好播一条欢呼（六个变体之一）",
    JSON.stringify((jh.plays || []).map(p => p.url)));
  A((jh.plays || []).some(p => /happy_v[1-6]\.mp3$/.test(p.url) && p.volume >= 0.3 && p.volume <= 0.8),
    "欢呼的音量与规格一致（0.55）",
    JSON.stringify((jh.plays || []).filter(p => /happy_v/.test(p.url)).map(p => p.url + "@" + p.volume)));`);

/* ── ③ 新增：真浏览器里的下锅音效 + 上餐选人 ───────────────────────────── */
const COOK_BODY = String.raw`(async function(){
    var d = window.__cs2.bf;
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    function ensureRunning(){
      if (d.state().running) return "running";
      try { window.Breakfast.dispose(); } catch (e) {}
      window.Breakfast.start(document.getElementById("bfGameHost"),
        { target:{ id:"su", name:"苏晚晴", bond:40 }, duration:999, goal:99, onFinish:function(){} });
      return "restarted";
    }
    function clickBox(b){
      var cv = document.querySelector("canvas.bf-cv");
      if (!cv) return "no-canvas";
      var r = cv.getBoundingClientRect();
      var V = window.Breakfast.ui.VIEW;
      cv.dispatchEvent(new MouseEvent("mousedown",
        { clientX: r.left + ((b.x + b.w / 2) / V.w) * r.width,
          clientY: r.top + ((b.y + b.h / 2) / V.h) * r.height,
          bubbles: true, cancelable: true, view: window }));
      return "clicked";
    }
    var mode = ensureRunning();
    for (var i = 0; i < 9; i++) d.trashCol(i);          // 清空 9 列，保证点得下去
    d.setSound(true);
    d.clearAudio();
    var r1 = clickBox(d.bucketBox(8));                  // 果汁机那一桶
    await sleep(150);
    var juice = d.audio().plays.filter(function(p){ return /cook_juice\.mp3$/.test(p.url); });
    var juiceFood = d.stations()[8].food;
    await sleep(320);                                   // 离开 300ms 节流窗口
    var r2 = clickBox(d.bucketBox(3));                  // 煎蛋那一桶
    await sleep(150);
    var egg = d.audio().plays.filter(function(p){ return /cook_egg\.mp3$/.test(p.url); });
    var eggFood = d.stations()[3].food;
    /* 节流：清掉果汁列 → 同一时刻连点两下，第二下必须被 300ms 窗口挡住 */
    d.trashCol(8);
    var n0 = d.audio().plays.filter(function(p){ return /cook_juice\.mp3$/.test(p.url); }).length;
    clickBox(d.bucketBox(8));                            // 这一下响
    d.trashCol(8);
    clickBox(d.bucketBox(8));                            // 紧接着再点 → 节流，不响
    await sleep(80);
    var n1 = d.audio().plays.filter(function(p){ return /cook_juice\.mp3$/.test(p.url); }).length;
    var thr = d.audio().log.filter(function(r){ return r.why === "throttle"; }).length;
    return JSON.stringify({ mode: mode, rc:[r1, r2], juice: juice.length, juiceFood: juiceFood,
                            egg: egg.length, eggFood: eggFood, n0: n0, n1: n1, throttle: thr,
                            cooks: d.state().cooks, gap: d.audio().cookGap, max: d.audio().cookMax,
                            plays: d.audio().plays.map(function(p){ return p.url; }) });
  })()`;

const PICK_BODY = String.raw`(async function(){
    var d = window.__cs2.bf;
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    function clickBox(b){
      var cv = document.querySelector("canvas.bf-cv");
      var r = cv.getBoundingClientRect();
      var V = window.Breakfast.ui.VIEW;
      cv.dispatchEvent(new MouseEvent("mousedown",
        { clientX: r.left + ((b.x + b.w / 2) / V.w) * r.width,
          clientY: r.top + ((b.y + b.h / 2) / V.h) * r.height,
          bubbles: true, cancelable: true, view: window }));
    }
    if (!d.state().running) return JSON.stringify({ err: "not-running" });
    for (var i = 0; i < 9; i++) d.trashCol(i);
    d.orders().forEach(function(o){ d.setPatience(o.id, 0); });   // 先让场上的人走光
    await sleep(500);
    /* 耐心上限 = (10 + 7.5×订单长度) × 难度系数（单局最多 ≈32.5s），
       所以摆 30 / 12 / 5 三档（40s 在游戏里摆不出来）。 */
    var a = d.pushCustomer(["egg", "bacon", "salad"]);     // 先来的（长单，上限最高）
    var b = d.pushCustomer(["egg", "congee"]);
    var c = d.pushCustomer(["egg", "juice"]);              // 最后来的 → 要摆成最急
    function abs(id, want){
      var o = d.orders().filter(function(x){ return x.id === id; })[0];
      if (!o) return null;
      d.setPatience(id, want / o.patienceMax);
      return d.orders().filter(function(x){ return x.id === id; })[0].patience;
    }
    var col = d.columnOf("egg");
    if (!d.stations()[col].plate && !d.stations()[col].food) d.drop("egg", col);
    var t0 = Date.now();
    while (Date.now() - t0 < 8000 && !d.stations()[col].plate) await sleep(70);
    var plated = !!d.stations()[col].plate;
    /* 摆耐心放在「点击前一刻」：等煎蛋熟的这几秒里耐心一直在掉 */
    d.orders().forEach(function(o){ if (o.id !== a && o.id !== b && o.id !== c) d.setPatience(o.id, 0.98); });
    var pA = abs(a, 30), pB = abs(b, 12), pC = abs(c, 5);
    var pick = d.pickFor("egg");
    d.clearAudio();
    clickBox(d.plateBox(col));                              // ← 真实鼠标点这一列的专属盘
    await sleep(150);
    var os = d.orders();
    var got = os.filter(function(o){ return o.done.indexOf("egg") >= 0; }).map(function(o){ return o.id; });
    var hurry = os.filter(function(o){ return o.id === c; })[0];
    var others = os.filter(function(o){ return o.id === a || o.id === b; })
                    .map(function(o){ return o.id + ":" + (o.done.indexOf("egg") >= 0 ? "拿到了" : "没拿到"); });
    return JSON.stringify({ plated: plated, pA: pA, pB: pB, pC: pC, pick: pick, want: c, got: got,
                            patience: hurry ? hurry.patience : null, max: hurry ? hurry.patienceMax : null,
                            partialServes: d.state().partialServes, partialBonus: d.state().partialBonus,
                            happy: d.audio().plays.filter(function(p){ return /happy_v[1-6]\.mp3$/.test(p.url); }).length,
                            others: others });
  })()`;

J(String.raw`  /* ── 收尾 ── */
  await ev("(function(){ try{ window.__cs2.bf.close(); }catch(e){} return 1; })()");`,
String.raw`  /* ── ⑥ 下锅音效（bf-9）：真浏览器里点食材 → 真的播了对应音效 ──
     用**真实 MouseEvent** 点在画布上的食材桶（坐标由 debug.bucketBox + 画布 rect 换算），
     不是调 debug API —— 证明的是「玩家的手点下去会响」，而不是「函数调用会响」。 */
  const cookRun = await ev(` + BT + COOK_BODY + BT + String.raw`);
  let jc = {};
  try { jc = JSON.parse(cookRun); } catch (e) { jc = { err: String(cookRun) }; }
  A(jc.juice === 1, "真浏览器：点「果汁」桶 → 真的播了 audio/bf/cook_juice.mp3",
    "juice=" + jc.juice + " · 锅里=" + jc.juiceFood + " · " + JSON.stringify(jc.plays || []));
  A(jc.juiceFood === "juice", "点果汁确实把果汁放进了第 8 列（触发点就是下锅那一刻）", String(jc.juiceFood));
  A(jc.egg === 1, "真浏览器：点「煎蛋」桶 → 真的播了 audio/bf/cook_egg.mp3",
    "egg=" + jc.egg + " · 锅里=" + jc.eggFood);
  A(jc.eggFood === "egg", "点煎蛋确实把煎蛋放进了第 3 列", String(jc.eggFood));
  A(jc.n1 === jc.n0 + 1 && jc.throttle >= 1,
    "真浏览器：同一食材 300ms 内连点 → 只多响一声（被节流的那次留了记录）",
    "juice " + jc.n0 + " → " + jc.n1 + " · throttle=" + jc.throttle);
  A(jc.gap === 0.3 && jc.max === 2, "真浏览器里读到的节流 / 并发常量与规格一致",
    jc.gap + "s / " + jc.max + " 条");
  A(jc.cooks >= 3, "下锅音效的台账在真浏览器里也记数（state().cooks）", String(jc.cooks));

  /* ── ⑦ 上餐选人 + 部分上餐（bf-9）：真实点专属盘送给「耐心最低」那位 ── */
  const pickRun = await ev(` + BT + PICK_BODY + BT + String.raw`);
  let jp2 = {};
  try { jp2 = JSON.parse(pickRun); } catch (e) { jp2 = { err: String(pickRun) }; }
  A(jp2.plated === true && Math.abs(jp2.pC - 5) < 0.2 && Math.abs(jp2.pB - 12) < 0.3,
    "真浏览器：3 位都要煎蛋，耐心摆成 30 / 12 / 5（煎蛋已落到专属盘）",
    "30→" + jp2.pA + " · 12→" + jp2.pB + " · 5→" + jp2.pC);
  A(jp2.pick === jp2.want, "真浏览器：规则层挑中耐心 5 那位（不是第一位）",
    "pick → #" + jp2.pick + " · 期望 #" + jp2.want);
  A((jp2.got || []).indexOf(jp2.want) >= 0 && (jp2.got || []).length === 1,
    "真浏览器：真实鼠标点盘 → 煎蛋落在耐心 5 那位头上（另外两位没被越位送）",
    "拿到煎蛋 #" + (jp2.got || []).join("/") + " · 别人 " + JSON.stringify(jp2.others || []));
  A(jp2.patience > 5 && jp2.patience < 9 && jp2.partialServes === 1 && jp2.partialBonus === 3.5,
    "真浏览器：他还缺一样 → 部分上餐回 +3.5s 耐心（5 → " + jp2.patience + "，上限 " + jp2.max + "）",
    JSON.stringify({ patience: jp2.patience, max: jp2.max, serves: jp2.partialServes, bonus: jp2.partialBonus }));
  A(jp2.happy === 1, "真浏览器：这一次上餐照样播了一条欢呼（6 条变体之一）", String(jp2.happy));

  /* ── 收尾 ── */
  await ev("(function(){ try{ window.__cs2.bf.close(); }catch(e){} return 1; })()");`);

/* ── 落盘：锚点行尾逐个核对 ───────────────────────────────────────────── */
const src = fs.readFileSync(path.join(OUT, FILE), "utf8");
jobs.forEach((job, i) => {
  if (countOcc(src, job.from) === 1) return;
  const c = crlf(job.from), ct = crlf(job.text);
  if (countOcc(src, c) === 1) { job.from = c; job.text = ct; return; }
  console.error("✗ job#" + (i + 1) + " 锚点出现 " + countOcc(src, job.from) + " 次（CRLF 版 " +
    countOcc(src, c) + " 次）");
  console.error("  锚首 90 字：" + JSON.stringify(job.from.slice(0, 90)));
  process.exit(1);
});
fs.writeFileSync(path.join(__dirname, "jobs_bf9_e2e.json"),
  JSON.stringify({ jobs }, null, 1), "utf8");
console.log("✔ 生成 jobs_bf9_e2e.json：" + jobs.length + " 个 job");
