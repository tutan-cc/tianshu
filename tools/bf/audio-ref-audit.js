/* 临时：以**运行时真实引用**为准算出 audio/bf 的「保留 / 归档」清单。
   默认 dry-run；加 --move 才真的搬。用完即删。 */
const fs = require("fs"), path = require("path"), vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const BF_DIR = path.join(ROOT, "audio", "bf");
const UNUSED = path.join(BF_DIR, "_unused");
const DO_MOVE = process.argv.indexOf("--move") >= 0;

/* ① 运行时真源：把 breakfast.js 装进 vm，直接读它的音频表 */
const SRC = fs.readFileSync(path.join(ROOT, "breakfast.js"), "utf8");
const ctx = vm.createContext({ console, Math, Date, isFinite, Number, String, Object, Array });
ctx.window = ctx;
vm.runInContext(SRC + "\n;globalThis.__BF = window.Breakfast;", ctx);
const A = ctx.__BF.rules.audio;

const referenced = new Set();
A.NAMES.forEach(n => (A.FILES[n] || []).forEach(f => referenced.add(f)));
Object.keys(A.COOK_FILES).forEach(k => referenced.add(A.COOK_FILES[k]));

/* ② 磁盘上真实存在的 mp3 */
const onDisk = fs.readdirSync(BF_DIR).filter(f => /\.mp3$/i.test(f)).sort();

const keep = onDisk.filter(f => referenced.has(f));
const move = onDisk.filter(f => !referenced.has(f));
/* 代码点名但盘上没有 → 静默 404，必须单独吼一声 */
const missing = [...referenced].filter(f => !fs.existsSync(path.join(BF_DIR, f)));

console.log("── 代码里点名的通道 ──");
A.NAMES.forEach(n => console.log("   " + n + " → " + A.FILES[n].join(", ")));
console.log("   cook_* → " + Object.keys(A.COOK_FILES).map(k => A.COOK_FILES[k]).join(", "));
console.log("\n── 保留（盘上 " + keep.length + " 个，全部被代码引用）──");
keep.forEach(f => console.log("   ✔ " + f));
console.log("\n── 归档（盘上 " + move.length + " 个，代码一个字都没引用）──");
move.forEach(f => console.log("   → " + f));
if (missing.length) {
  console.log("\n✗ 代码点名但盘上缺（静默 404）：" + missing.join(", "));
  process.exit(1);
}
const kept = new Set(keep);
const unexpected = [...referenced].filter(f => !kept.has(f));
console.log("\n核对：代码引用的 " + referenced.size + " 个文件全部在保留清单里 → " + (unexpected.length === 0));
console.log("核对：保留 " + keep.length + " + 归档 " + move.length + " = 盘上 " + onDisk.length + " 个 mp3");

if (!DO_MOVE) { console.log("\n（dry-run —— 没动任何文件；加 --move 才搬）"); process.exit(0); }

fs.mkdirSync(UNUSED, { recursive: true });
const manifest = [];
move.forEach(f => {
  const from = path.join(BF_DIR, f), to = path.join(UNUSED, f);
  if (fs.existsSync(to)) throw new Error("目标已存在，拒绝覆盖：" + to);
  fs.renameSync(from, to);
  manifest.push({ from: "audio/bf/" + f, to: "audio/bf/_unused/" + f, bytes: fs.statSync(to).size });
});
fs.writeFileSync(path.join(UNUSED, "_MANIFEST.json"), JSON.stringify({
  note: "bf-12 仓库清理：这些是「当前池子/通道没有引用」的旧件，从 audio/bf/ 下划线归档。" +
        "文件一个都没删；_ 前缀目录被 .gitignore 的 audio/**/_* 排除（不入库、不分发），与 audio/mj/_bak_pre_wopeng/ 同一做法。",
  movedAt: new Date().toISOString(),
  keptInPlace: keep, moved: manifest,
}, null, 1), "utf8");
console.log("\n已搬 " + manifest.length + " 个 → audio/bf/_unused/（清单：_unused/_MANIFEST.json）");
