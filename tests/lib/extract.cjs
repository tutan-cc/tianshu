/*
  tests/lib/extract.cjs — 从 index.html 抽取真实实现来驱动测试的公共工具

  为什么要有这个文件（而不是每个测试里抄一份）：
  "把真实代码抽出来跑"这个套路在 audio-paths / fight-grade / fight-loop / judge-bar
  四个套件里都用到了，抽取器本身踩过一堆坑，抄四份必然会各自修各自的、慢慢分叉。
  这个抽取器的每一条限制都是踩出来的，改之前先读完注释：

  ① 抽具名函数**必须连参数列表一起抽** —— 只从 `{` 开始会编译出 `function f{`。
  ② 索引基准要**切到函数起点**再算花括号位置 —— 直接用全文索引会差出前面几万字符，
     报出来的却是"抽取失败"，看着像桩点丢了，其实是偏移错了。
  ③ 不能靠"数括号"找结尾 —— 字符串/模板串/注释里的大括号、以及对象方法简写
     （`setOwner(){...}`）都会把朴素计数带偏。所以：括号预筛缩小范围，再让**引擎**判定。
  ④ const 的 TDZ 很坑：`const hooked = ...` 如果在用到它的模板字符串之后才声明，
     报出来的现象会变成"帧记录空/抽取不对"这种毫不相关的错。计算要放在使用之前。
  ⑤ `JSON.stringify` 会把对象里的方法整个丢掉；`Function.prototype.toString()` 对
     方法简写又会丢掉 `function` 关键字。所以真身要么在沙箱里直接求值（evalLiteralIn），
     要么用 serialize 逐值还原（只对 function 写法有效）。
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HTML_PATH = path.join(__dirname, "..", "..", "index.html");

/** 读 index.html 源码（保留 BOM/换行原样，不要在这里做任何规范化） */
function readHtml() { return fs.readFileSync(HTML_PATH, "utf8"); }

/** 括号预筛：返回从 openIdx 起第一个配平处（够不到就返回一个上界，交给调用方收敛） */
function matchingEnd(src, openIdx, budget) {
  const open = src[openIdx];
  const close = open === "{" ? "}" : open === "(" ? ")" : "]";
  let depth = 0;
  const limit = Math.min(src.length, openIdx + (budget || 200000));
  for (let i = openIdx; i < limit; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < limit && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < limit && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < limit && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i + 1; }
  }
  return limit;
}

/** 取"第一个配平处"的片段 —— 只用于无歧义的小片段（参数列表、纯数据字面量） */
function grab(src, openIdx) { return src.slice(openIdx, matchingEnd(src, openIdx)); }

/** 抽具名函数，返回可直接拼进脚本的源码字符串 */
function grabFn(html, name) {
  const m = new RegExp("function\\s+" + name + "\\s*\\(").exec(html);
  if (!m) throw new Error("找不到 function " + name + "(");
  const src = html.slice(html.indexOf("(", m.index));   // ← 坑 ②：切到函数起点
  const params = grab(src, 0);
  if (src[params.length] !== "{") {
    throw new Error("函数 " + name + " 的体不在参数之后，实际是 " + JSON.stringify(src[params.length]));
  }
  const body = src.slice(params.length, matchingEnd(src, params.length));
  try { new vm.Script("function _t" + params + body); }
  catch (e) { throw new Error("函数 " + name + " 抽取结果编译不过：" + e.message.split("\n")[0]); }
  return "function " + name + params + body;
}

/** 在给定沙箱里求值一个字面量（对象/数组），**闭包完整、方法可用**。
    这是拿"真身"接口的首选方式 —— 不要试图把它序列化成文本（见坑 ⑤）。 */
function evalLiteralIn(src, openIdx, sandbox) {
  const lit = grab(src, openIdx);
  return new vm.Script("(" + lit + ")").runInNewContext(sandbox || {});
}

/** 抽一个 const 字面量（`const X = {...}` / `= [...]`）并求值 */
function evalConstIn(html, name, sandbox) {
  const m = new RegExp("const\\s+" + name + "\\s*=\\s*([\\[{])").exec(html);
  if (!m) throw new Error("找不到 const " + name);
  return evalLiteralIn(html, html.indexOf(m[1], m.index), sandbox);
}

/** 把 `Function.prototype.toString()` 的输出归一化成**函数表达式**。
    ⚠ 对象方法简写（`newPose(){...}`）的 toString() **不带 `function` 关键字**，
      直接包一层括号会得到 `(newPose(){...})` —— 非法语法（实测报 Unexpected token '{'）。
      这里把开头的方法名剥掉、补上 `function`，于是简写与普通写法都能安全序列化。 */
function fnSource(fn){
  const s = String(fn);
  if(/^\s*(async\s+)?function\b/.test(s)) return s;          // 已经是函数表达式
  const m = /^\s*(async\s+)?(?:get\s+|set\s+)?[A-Za-z_$][\w$]*\s*\(/.exec(s);
  if(m) return "function " + s.slice(m[0].length - 1);       // 保留 '(' 起的参数列表与函数体
  return s;
}

/** 深度还原一个值，**保留函数源码**（方法简写也能处理，见 fnSource）。
    这是"把 code 抽出来喂给沙箱"的主力；只有真身带闭包状态时才需要 evalLiteralIn。 */
function serialize(v, depth) {
  depth = depth || 0;
  if (depth > 6) return "null";
  if (v === null || v === undefined) return "null";
  const t = typeof v;
  if (t === "function") return "(" + fnSource(v) + ")";
  if (t === "number" || t === "boolean") return String(v);
  if (t === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => serialize(x, depth + 1)).join(",") + "]";
  return "{" + Object.keys(v).map((k) => JSON.stringify(k) + ":" + serialize(v[k], depth + 1)).join(",") + "}";
}

/** 抽一个 const 数据常量，序列化成源码字符串（含方法也能用） */
function grabConst(html, name) { return serialize(evalConstIn(html, name)); }

module.exports = { readHtml, matchingEnd, grab, grabFn, evalLiteralIn, evalConstIn, serialize, fnSource, grabConst, HTML_PATH };
