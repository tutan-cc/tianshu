/* 临时：把 mj-browser.js 里的 HTA 字符串数组抽出来拼成真实 HTA 脚本，做一次 node --check
   （node --check 只查宿主 Node 文件，查不到「拼出来的浏览器脚本」——改内联胶水层必须补这一闸） */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..", "..");
const src = fs.readFileSync(path.join(ROOT, "tools/e2e/mj-browser.js"), "utf8");
const a = src.indexOf("const HTA = [");
const b = src.indexOf('].join("\\n");', a);
if (a < 0 || b < 0) { console.error("找不到 HTA 数组"); process.exit(2); }
const lit = src.slice(a + "const HTA = ".length, b + 1);
const arr = vm.runInNewContext(lit, {});
const js = arr.join("\n");
const out = path.join(__dirname, "_hta_extracted.js");
fs.writeFileSync(out, js, "utf8");
console.log("抽出 " + arr.length + " 行 / " + js.length + " 字符 → " + path.basename(out));
/* HTA 数组里既有 <head> 也有脚本：只把内联 <script language="JScript"> 那一段拿去编译 */
const s0 = js.indexOf('<script language="JScript">');
const s1 = js.lastIndexOf("</script>");
const code = js.slice(s0 + '<script language="JScript">'.length, s1);
console.log("内联 JScript 段：" + code.length + " 字符（" + code.split("\n").length + " 行）");
try {
  new vm.Script(code, { filename: "HTA" });
  console.log("· 拼出来的 HTA 脚本：语法 ✓（vm.Script 编译通过）");
} catch (e) {
  console.error("✗ HTA 脚本语法错误：" + String(e.stack || e.message).split("\n").slice(0, 6).join(" ▸ "));
  process.exit(1);
}
/* 再确认关键辅助函数都在、且调用点数量对得上 */
for (const k of ["mjDriveToHumanTurn", "mjRestartGame", "mjStOver", "mjStMine"]) {
  const n = js.split(k).length - 1;
  console.log("  " + k + "：出现 " + n + " 次");
}
console.log("  DRIVE 调试字段：" + (js.indexOf("driveChain") >= 0 && js.indexOf("driveHint") >= 0 && js.indexOf("driveVoice") >= 0 && js.indexOf("driveTenpai") >= 0 && js.indexOf("driveHintSet") >= 0 ? "5/5 已挂到 info" : "缺失"));
