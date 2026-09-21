/* 生成 e2e 的 3 个正则替换 job。
   锚直接从文件里按**行号**取（不手抄、不猜缩进、不猜反斜杠个数、不算下标）。
   用法： node tools/bf/_patch/_mke2ejobs.js            # 生成 jobs json
          node tools/bf/_patch/_mke2ejobs.js --show     # 只打印，不写文件 */
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "..", "..", "..");
const f = path.join(OUT, "tools", "bf", "e2e-audio.js");
const src = fs.readFileSync(f, "utf8");
const lines = src.split(/\r\n|\n/);

/* 在**整行**上做一次替换：只换 "happy_v[1-6]" 这 12 个字符，
   后面的 "\.mp3$/" 原样保留（有几个反斜杠都不管）。 */
const KEY = "happy_v[1-6]";
const NEW = "happy_(?:v[1-6]|alt[23])";

function lineNo(sub) {
  const i = lines.findIndex(l => l.indexOf(sub) >= 0);
  if (i < 0) throw new Error("找不到：" + sub);
  if (lines.filter(l => l.indexOf(sub) >= 0).length !== 1) throw new Error("不唯一：" + sub);
  return i;
}

const jobs = [];
for (const sub of [
  "n: plays.filter(function(p){ return /happy_v[1-6]",
  "A((jh.plays || []).some(p => /happy_v[1-6]",
  "happy: d.audio().plays.filter(function(p){ return /happy_v[1-6]",
]) {
  const i = lineNo(sub);
  const line = lines[i];
  let hits = 0;
  const to = line.split(KEY).map((part, k) => (k === 0 ? part : (hits++, NEW + part))).join("");
  if (hits !== 1) throw new Error("第 " + (i + 1) + " 行里 " + KEY + " 出现 " + hits + " 次");
  if (to === line) throw new Error("第 " + (i + 1) + " 行替换前后一样");
  if (to.length !== line.length + (NEW.length - KEY.length))
    throw new Error("第 " + (i + 1) + " 行长度不对：" + line.length + " → " + to.length +
      "（预期 +" + (NEW.length - KEY.length) + "）");
  console.log("行 " + (i + 1) + ":\n  from=" + JSON.stringify(line) + "\n  to  =" + JSON.stringify(to));
  jobs.push({ file: "tools/bf/e2e-audio.js", from: line, text: to });
}
if (process.argv.indexOf("--show") >= 0) process.exit(0);
const out = path.join(OUT, "tools", "bf", "_patch", "jobs_bf10_e2e_re.json");
fs.writeFileSync(out, JSON.stringify({ jobs: jobs }, null, 2) + "\n");
console.log("→ " + out + "（" + jobs.length + " 个 job）");
