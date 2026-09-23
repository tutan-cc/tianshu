/* ═══════════════════════════════════════════════════════════════════════════
   mk_bf14d_jobs.js — bf-14 第六轮（收口 8 条失败）
     ① breakfast.js：顶栏文案「双击锅 / 盘」→「双击盘 / 锅」（老断言 /双击盘/ 仍然成立）
     ② headless：等糊的帧数 400 → 600（白粥 3.4s 熟 + 4.5s 窗口 = 7.9s）
     ③ headless：`\d`/`\.` 在生成器的模板字符串里被吃掉了 → 修成 /恰好 · 起锅 \d+\.\d+s/
     ④ headless：盘面「不画糊」的老断言改精确（用「煎蛋·糊了 / 只能丢」而不是裸 /糊了/ ——
        图例里本来就有「糊了必须双击才清」这句规则说明）
     ⑤ headless：音效段 ⑥ 的机器人补「点锅起锅」（bf-14 起不再自动落盘）
     ⑥ headless：糊盘渲染断言同样改精确（/煎蛋·糊了/）
   用法：node tools/bf/_patch/mk_bf14d_jobs.js
         node tools/bf/_patch/_bf14_preflight.js tools/bf/_patch/jobs_bf14d.json
         node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf14d.json
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const T = [], jobs = [];
function job(name, file, from, to, text) {
  T.push({ name: name, text: text });
  jobs.push({ file: file, from: from, to: to || undefined, textFile: "tools/bf/_patch/bf14d_" + name + ".txt" });
}

/* ① 顶栏 tip：双击盘 / 锅 */
job("tip_order", "breakfast.js",
`      "④ 双击锅 / 盘 → 丢垃圾桶（不扣分）；**糊了必须双击丢掉才能再用这口锅** ｜ " +`,
null,
`      "④ 双击盘 / 锅 → 丢垃圾桶（不扣分）；**糊了必须双击丢掉才能再用这口锅** ｜ " +`);

/* ② 等糊帧数 */
job("burn_frames", "tools/bf/headless.js",
`  for (let i = 0; i < 400 && d4.stations()[0].state !== "burnt"; i++) d4.tick(1 / 60);
  A(d4.stations()[0].state === "burnt", "没人起锅 → 窗口走完那份**糊在锅里**（本轮唯一的报废来源）");`,
null,
`  for (let i = 0; i < 600 && d4.stations()[0].state !== "burnt"; i++) d4.tick(1 / 60);
  A(d4.stations()[0].state === "burnt", "没人起锅 → 窗口走完那份**糊在锅里**（本轮唯一的报废来源）",
    "用了 " + (600 / 60) + "s 上限（白粥 3.4s 熟 + 4.5s 窗口）");`);

/* ③ 正则修复（生成器模板字符串里 \d 会变成 d） */
job("regex_fix", "tools/bf/headless.js",
`  A(t6p.some(x => /恰好 · 起锅 d+.d+s/.test(x)), "同时画出窗口倒计时环的秒数（恰好 · 起锅 N.Ns）",`,
null,
`  A(t6p.some(x => /恰好 · 起锅 \\d+\\.\\d+s/.test(x)), "同时画出窗口倒计时环的秒数（恰好 · 起锅 N.Ns）",`);

/* ④ 盘面不画糊：断言改精确 */
job("plate_noburn", "tools/bf/headless.js",
`  A(!t6b2.some(x => /糊了/.test(x)) && !t6b2.some(x => /只能丢/.test(x)),
    "放 90 秒也不会画出「糊了 · 只能丢」（旧断言：超时 4.5s 就画糊了）");`,
null,
`  A(!t6b2.some(x => /煎蛋·糊了/.test(x)) && !t6b2.some(x => /只能丢/.test(x)),
    "放 90 秒也不会把盘画成糊盘（「煎蛋·糊了 / 只能丢」一个都不出现；旧断言：超时 4.5s 就画糊了）");`);

/* ⑤ 音效段 ⑥：机器人补点锅起锅 */
job("audio_serve", "tools/bf/headless.js", `    if (!s.food && !s.plate) d.drop(want, col);
    d.tick(1 / 60);
    const s2 = d.stations()[col];
    if (s2.plate && s2.plateState !== "burnt") { const r = d.serveCol(col); if (r.ok) served = true; }`,
null,
`    if (!s.food && !s.plate) d.drop(want, col);
    d.tick(1 / 60);
    const s2 = d.stations()[col];
    /* bf-14：熟了要**点锅起锅**才进盘（不再自动落盘） */
    if (s2.state === "perfect" && s2.windowOpen && !s2.plate) d.takeOut(col);
    const s3 = d.stations()[col];
    if (s3.plate && s3.plateState !== "burnt") { const r = d.serveCol(col); if (r.ok) served = true; }`);

/* ⑥ 糊盘渲染断言改精确 */
job("panburn_precise", "tools/bf/headless.js",
`  A(t6c.some(x => /糊了/.test(x)) && t6c.some(x => /只能丢/.test(x)), "糊了的盘画出「糊了 · 只能丢（双击）」",`,
null,
`  A(t6c.some(x => /煎蛋·糊了/.test(x)) && t6c.some(x => /只能丢/.test(x)), "糊了的盘画出「煎蛋·糊了 / 只能丢（双击）」",`);

const dir = path.join(OUT, "tools", "bf", "_patch");
for (const t of T) fs.writeFileSync(path.join(dir, "bf14d_" + t.name + ".txt"), t.text.replace(/\r\n/g, "\n"), "utf8");
fs.writeFileSync(path.join(dir, "jobs_bf14d.json"), JSON.stringify({ jobs: jobs }, null, 1), "utf8");
console.log("✓ 生成 " + T.length + " 个 job → tools/bf/_patch/jobs_bf14d.json");
T.forEach((t, i) => console.log("  job#" + (i + 1) + " · " + t.name + " · " + t.text.split("\n").length + " 行"));
