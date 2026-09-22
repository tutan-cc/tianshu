const fs = require("fs");
const t = fs.readFileSync("tools/test/mahjong-logic.js", "utf8");
const i = t.indexOf("21. 智脑提示");
const a = t.indexOf("console.log(\"通过 \"");
const s = t.slice(i, a);
const calls = s.match(/\b(ok|eq)\(/g) || [];
console.log("section21 断言调用数 =", calls.length);
const strs = s.match(/"[^"\n]*"/g) || [];
const seen = new Set();
for (const x of strs) {
  const v = x.slice(1, -1);
  if (/^[①②③④⑤⑥⑦⑧⑨]/.test(v) || /^(tile|melds|drawn|副露|听|面板|金框|确定|时序|缓存|三处|base)/.test(v)) {
    if (!seen.has(v)) { seen.add(v); console.log("  " + v); }
  }
}
console.log("唯一断言标签 =", seen.size);
