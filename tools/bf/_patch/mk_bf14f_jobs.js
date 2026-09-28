/* ═══════════════════════════════════════════════════════════════════════════
   mk_bf14f_jobs.js — bf-14 第十轮（出图排版 + 糊锅小字 + 倒计时环断言）
     ① breakfast.js：底排右侧说明太长，与左侧「食材 · 点一下…」压字 → 收短
        （「双击丢弃再用锅」这句由图例第 ④ 条「糊了必须双击才清」承担，语义不丢）
     ② breakfast.js：糊锅的锅顶小字从「在烧」改成「不能再下料 · 双击丢」（新规则下这句更准确）
     ③ headless：补一条「起锅窗口画出**橙色**倒计时环」的断言（PAL.steelHot #ffb347）
   用法：node tools/bf/_patch/mk_bf14f_jobs.js
         node tools/bf/_patch/_bf14_preflight.js tools/bf/_patch/jobs_bf14f.json
         node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf14f.json
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const T = [], jobs = [];
function job(name, file, from, to, text) {
  T.push({ name: name, text: text });
  jobs.push({ file: file, from: from, to: to || undefined, textFile: "tools/bf/_patch/bf14f_" + name + ".txt" });
}

job("bottom_text", "breakfast.js",
`      g.fillText("9 列 × 每列 1 锅 1 专属盘 · 锅里熟了要在 " + SERVE_WINDOW + "s 内点锅起锅；盘被占了就只能糊掉（双击丢弃再用锅）· 盘上永久保鲜",
                 W - LAY.buckets.x0, LAY.buckets.y + LAY.bucketLabelDy);`,
null,
`      g.fillText("9 列 × 每列 1 锅 1 专属盘 · 熟了 " + SERVE_WINDOW + "s 内点锅起锅 · 盘被占了就只能糊掉",
                 W - LAY.buckets.x0, LAY.buckets.y + LAY.bucketLabelDy);`);

job("burnt_sub", "breakfast.js",
`      } else {
        g.font = fontOf(FONT.micro, false); g.fillStyle = "rgba(255,255,255,.34)";
        g.fillText(busy ? "盘里还有一份" : (fd ? "在烧" : "空着 · 点食材"), cx, b.y + 29);
      }`,
null,
`      } else if (s.state === "burnt") {
        /* bf-14：糊锅不再「在烧」——它现在是**占死**这口锅的那份，必须双击才清 */
        g.font = fontOf(FONT.micro, true); g.fillStyle = "#ffd0d8";
        g.fillText("不能再下料 · 双击丢", cx, b.y + 29);
      } else {
        g.font = fontOf(FONT.micro, false); g.fillStyle = "rgba(255,255,255,.34)";
        g.fillText(busy ? "盘里还有一份" : (fd ? "在烧" : "空着 · 点食材"), cx, b.y + 29);
      }`);

job("ring_assert", "tools/bf/headless.js",
`  /* bf-14 新 UI：锅内「恰好」→ 画「起锅」提示 + 窗口倒计时（t6p）*/
  d6b.canvas()._m.texts.length = 0;
  d6b.pump(1);
  const t6p = d6b.canvas()._m.texts;`,
null,
`  /* bf-14 新 UI：锅内「恰好」→ 画「起锅」提示 + 窗口倒计时环（t6p）*/
  d6b.canvas()._m.texts.length = 0;
  const strokesBeforeRing = Object.assign({}, d6b.canvas()._m.strokes);
  d6b.pump(1);
  const t6p = d6b.canvas()._m.texts;
  /* 倒计时环的颜色 = PAL.steelHot（橙 #ffb347）——「橙 → 最后一秒红闪 → 走完焦黑」的第一步 */
  A((d6b.canvas()._m.strokes["#ffb347"] || 0) > (strokesBeforeRing["#ffb347"] || 0),
    "起锅窗口画出**橙色倒计时环**（#ffb347 = PAL.steelHot；火候环那四档语义一个字没改）",
    "#ffb347 " + (strokesBeforeRing["#ffb347"] || 0) + " → " + (d6b.canvas()._m.strokes["#ffb347"] || 0));`);

const dir = path.join(OUT, "tools", "bf", "_patch");
for (const t of T) fs.writeFileSync(path.join(dir, "bf14f_" + t.name + ".txt"), t.text.replace(/\r\n/g, "\n"), "utf8");
fs.writeFileSync(path.join(dir, "jobs_bf14f.json"), JSON.stringify({ jobs: jobs }, null, 1), "utf8");
console.log("✓ 生成 " + T.length + " 个 job → tools/bf/_patch/jobs_bf14f.json");
T.forEach((t, i) => console.log("  job#" + (i + 1) + " · " + t.name + " · " + t.text.split("\n").length + " 行"));
