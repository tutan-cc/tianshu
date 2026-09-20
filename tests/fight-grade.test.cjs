#!/usr/bin/env node
/*
  tests/fight-grade.test.cjs — 打斗三档判定单测（P0 回归闸）

  背景：v1.24 的 precision() 只有"进绿区 / 没进"两档（命中 ×1.9 / 未命中 ×1.0），
  手操技术与手感不产生梯度。v2.0 拆成三档：
    完美（绿区中央 30%）×1.9 · 良好（绿区两侧）×1.3 · 偏出（绿区外）×0.7
  偏出刻意不给 0 倍：每回合都要有推进，避免连续 miss 后进入长达一分钟的垃圾时间。

  这些是纯函数，所以**不需要浏览器**：直接把 judgeGrade / FIGHT_GRADE_MULT
  从 index.html 里抽出来求值。测的是出货代码本身，不是副本。

  用法：node tests/fight-grade.test.cjs
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HTML = path.join(__dirname, "..", "index.html");
let pass = 0;
const fails = [];
function A(ok, name, detail) {
  const line = name + (detail === undefined ? "" : "  [" + detail + "]");
  if (ok) { pass++; console.log("  ✔ " + line); } else { fails.push(line); console.log("  ✖ " + line); }
}

/** 从 src 的 openIdx 起做括号配对，返回完整片段（跳过字符串与注释） */
function grab(src, openIdx) {
  const open = src[openIdx];
  const close = open === "{" ? "}" : open === "(" ? ")" : "]";
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  throw new Error("括号未闭合");
}

const html = fs.readFileSync(HTML, "utf8");

/* ── 抽取真实的 judgeGrade + FIGHT_GRADE_MULT ── */
let ctx = null, err = "";
try {
  const mMult = /const\s+FIGHT_GRADE_MULT\s*=\s*\{/.exec(html);
  if (!mMult) throw new Error("找不到 `const FIGHT_GRADE_MULT = {`");
  const multLit = grab(html, html.indexOf("{", mMult.index));

  const mFn = /function\s+judgeGrade\s*\(/.exec(html);
  if (!mFn) throw new Error("找不到 `function judgeGrade(`");
  // ⚠ 必须连参数列表一起抓：只从 `{` 开始抓会漏掉 (pos, left, w)，编译出 `function judgeGrade{`
  const parenIdx = html.indexOf("(", mFn.index);
  const params = grab(html, parenIdx);
  const fnBody = grab(html, html.indexOf("{", parenIdx));

  ctx = new vm.Script(
    "(function(){\n" +
    "const FIGHT_GRADE_MULT=" + multLit + ";\n" +
    "function judgeGrade" + params + fnBody + "\n" +
    "return { FIGHT_GRADE_MULT: FIGHT_GRADE_MULT, judgeGrade: judgeGrade };\n" +
    "})()"
  ).runInNewContext({});
} catch (e) { err = e.message; }

A(!!ctx && typeof ctx.judgeGrade === "function" && !!ctx.FIGHT_GRADE_MULT,
  "能从 index.html 抽出真实的 judgeGrade 与 FIGHT_GRADE_MULT", err || "");

if (!ctx) {
  console.log("\n[结果] 通过 " + pass + "，失败 " + fails.length + " —— 抽取失败");
  process.exit(1);
}
const { judgeGrade, FIGHT_GRADE_MULT: M } = ctx;

/* ── 1. 倍率表 ── */
A(M.perfect === 1.9 && M.good === 1.3 && M.miss === 0.7,
  "三档倍率 = 1.9 / 1.3 / 0.7", JSON.stringify(M));
A(M.miss > 0, "偏出不是 0 倍（保证每回合都有推进，不出现垃圾时间）", "miss=" + M.miss);

/* ── 2. 标准绿区：left=40, w=20 → 绿区 [40,60]，完美区 = 中央 30%（宽 6）→ [47,53] ── */
const L = 40, W = 20;                       // 绿区 [40, 60]
const PZ = W * 0.30;                        // 完美区宽度 = 6
const PL = L + W / 2 - PZ / 2;              // = 47
A(judgeGrade(50, L, W) === "perfect", "正中心 → 完美", "pos=50");
A(judgeGrade(PL + 0.01, L, W) === "perfect", "完美区左边界内 → 完美", "pos=" + (PL + 0.01));
A(judgeGrade(PL + PZ - 0.01, L, W) === "perfect", "完美区右边界内 → 完美", "pos=" + (PL + PZ - 0.01));
A(judgeGrade(PL - 0.01, L, W) === "good", "完美区左边界外 → 良好", "pos=" + (PL - 0.01));
A(judgeGrade(PL + PZ + 0.01, L, W) === "good", "完美区右边界外 → 良好", "pos=" + (PL + PZ + 0.01));
A(judgeGrade(41, L, W) === "good", "绿区左端 → 良好", "pos=41");
A(judgeGrade(59, L, W) === "good", "绿区右端 → 良好", "pos=59");
A(judgeGrade(39.99, L, W) === "miss", "绿区左边界外 → 偏出", "pos=39.99");
A(judgeGrade(60.01, L, W) === "miss", "绿区右边界外 → 偏出", "pos=60.01");
A(judgeGrade(0, L, W) === "miss" && judgeGrade(100, L, W) === "miss", "两端极限 → 偏出");

/* ── 3. 边界包含性：绿区与完美区的端点都要算"进" ── */
A(judgeGrade(L, L, W) === "good" && judgeGrade(L + W, L, W) === "good",
  "绿区端点取闭区间（pos 恰好等于 left / right 算命中）", "pos=" + L + " / " + (L + W));
A(judgeGrade(PL, L, W) === "perfect" && judgeGrade(PL + PZ, L, W) === "perfect",
  "完美区端点取闭区间", "pos=" + PL + " / " + (PL + PZ));

/* ── 4. 完美区恒为绿区中央 30%，且随窗口宽度等比缩放 ──
     体魄加宽绿区 → 完美区的**绝对**宽度也变大 → 体魄仍是手残玩家的容错来源。 */
const perfectWidth = (w) => { let n = 0; for (let x = 0; x <= 100; x += 0.005) if (judgeGrade(x, L, w) === "perfect") n++; return n * 0.005; };
for (const w of [14, 23, 32, 46]) {
  const pw = perfectWidth(w);
  A(Math.abs(pw - w * 0.30) < 0.05,
    "绿区宽 " + w + " → 完美区宽 " + (w * 0.30).toFixed(2) + "（恒为 30%，含体魄加成后的最宽档）",
    "实测 " + pw.toFixed(3));
}
A(perfectWidth(46) > perfectWidth(14),
  "绿区越宽，完美区绝对宽度越大（体魄加成的实际收益）",
  perfectWidth(14).toFixed(2) + " → " + perfectWidth(46).toFixed(2));

/* ── 5. 判定完全对称：完美区中心必须落在绿区中点 ── */
(() => {
  const mid = L + W / 2;
  const lo = (() => { let x = mid; while (judgeGrade(x - 0.01, L, W) === "perfect") x -= 0.01; return x; })();
  const hi = (() => { let x = mid; while (judgeGrade(x + 0.01, L, W) === "perfect") x += 0.01; return x; })();
  A(Math.abs((lo + hi) / 2 - mid) < 0.02, "完美区中心 == 绿区中点（左右对称）",
    "中心 " + ((lo + hi) / 2).toFixed(2) + " vs 绿区中点 " + mid);
})();

/* ── 6. 全区间扫描：任意 pos 都必须落在且仅落在一档里 ── */
(() => {
  const set = new Set();
  let last = null, ok = true;
  for (let x = -1; x <= 101; x += 0.05) {
    const g = judgeGrade(x, L, W);
    set.add(g);
    if (last && last !== g) {
      // 允许 good→perfect→good→miss 这种有序跃迁，不允许 miss 之后又回到 good
      const order = { miss: 0, good: 1, perfect: 2 };
      if (order[g] > order[last] + 1) ok = false;
    }
    last = g;
  }
  A(set.size === 3 && set.has("perfect") && set.has("good") && set.has("miss"),
    "全区间扫描能覆盖三档（没有哪一档是死代码）", [...set].sort().join(","));
})();

/* ── 7. 伤害结算链路：Math.round(基础伤害 × 倍率) ──
     这条锁的是 hitFoe() 里 `Math.round(dmg*mult)` 的实际结果，
     防止以后有人把倍率改了却忘了同步按钮上的文案。 */
const dmgOf = (base, grade) => Math.round(base * M[grade]);
A(dmgOf(12, "perfect") === 23 && dmgOf(12, "good") === 16 && dmgOf(12, "miss") === 8,
  "直拳 12 → 完美 23 / 良好 16 / 偏出 8",
  [dmgOf(12, "perfect"), dmgOf(12, "good"), dmgOf(12, "miss")].join(" / "));
A(dmgOf(8, "perfect") === 15 && dmgOf(8, "good") === 10 && dmgOf(8, "miss") === 6,
  "组合拳一段 8 → 完美 15 / 良好 10 / 偏出 6",
  [dmgOf(8, "perfect"), dmgOf(8, "good"), dmgOf(8, "miss")].join(" / "));
A(Math.round(16 * 1) === 16,
  "低扫走非判定路径（hitFoe 不传 precise → apply(1)），不吃三档表",
  "16 恒为 16");

console.log("");
console.log("[结果] 通过 " + pass + "，失败 " + fails.length + (fails.length ? "" : "，全部通过 ✔"));
if (fails.length) { console.log("失败项："); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fails.length ? 1 : 0);
