/* ═══════════════════════════════════════════════════════════════════════════
   mk_bf14c_jobs.js — bf-14 第三轮（一处测试脚手架的修正）
     tests ⑤ 里我把「盘被占」那一段接错了：trashStation 会把**锅和盘一起清**，
     清完盘就空了 —— 于是重下的那份能顺利起锅，验不到「盘被占 → 糊」。
     改成：第二份起锅进盘后**不再清列**，直接再下一份 → 盘被第二份占着 → 窗口走完糊。
   用法：node tools/bf/_patch/mk_bf14c_jobs.js
         node tools/bf/_patch/_bf14_preflight.js tools/bf/_patch/jobs_bf14c.json
         node tools/dev/patch-literal.js tools/bf/_patch/jobs_bf14c.json
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const T = [], jobs = [];
function job(name, file, from, to, text) {
  T.push({ name: name, text: text });
  jobs.push({ file: file, from: from, to: to || undefined, textFile: "tools/bf/_patch/bf14c_" + name + ".txt" });
}

job("serve_keeps_pan_fix", "tests/breakfast.test.cjs",
`  R.trashStation(st, col);                       // 清干净，回到后面「盘被占 → 糊」那条主线
  assert.equal(R.placeFood(st, "egg", null), true, "重新下料，继续验「盘被占 → 窗口走完 → 糊」");
  const po2 = pickOut(st, col);
  assert.equal(po2.why, "plate-occupied", "盘被占（这次是被出餐后重下的那份占着）");`,
null,
`  /* ⑤ 盘里又有了一份（第二份）：再下一份 → 熟了没地方放 → 窗口走完就糊（本轮主线）*/
  assert.equal(R.placeFood(st, "egg", null), true, "盘被第二份占着，照样能下料");
  const po2 = pickOut(st, col);
  assert.equal(po2.why, "plate-occupied", "盘被占（这次是第二份占着）");`);

const dir = path.join(OUT, "tools", "bf", "_patch");
for (const t of T) fs.writeFileSync(path.join(dir, "bf14c_" + t.name + ".txt"), t.text.replace(/\r\n/g, "\n"), "utf8");
fs.writeFileSync(path.join(dir, "jobs_bf14c.json"), JSON.stringify({ jobs: jobs }, null, 1), "utf8");
console.log("✓ 生成 " + T.length + " 个 job → tools/bf/_patch/jobs_bf14c.json");
T.forEach((t, i) => console.log("  job#" + (i + 1) + " · " + t.name + " · " + t.text.split("\n").length + " 行"));
