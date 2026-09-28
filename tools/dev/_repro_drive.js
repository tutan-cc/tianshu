/* ═══════════════════════════════════════════════════════════════════════════
   tools/dev/_repro_drive.js（临时复现探针 · 跑完删除）
   目的：把「驱动的辅助函数太脆」这件事**确定性地**复现出来，并证明新辅助函数能自愈。
     · 机制①：摆的 13 张是听牌型（123456789万 + 1234条 单吊 4条），
              把牌墙首张换成 4条 → act("draw") 当场自摸结算 → 实测 over/0/14
     · 机制②：把牌墙清空 → act("draw") → Engine.turn 开头 drawGame() → 实测 over/0/13
   两份驱动用的都是**真代码**：
     · 旧写法 = 旧辅助函数的原样片段（同步 for 循环 + 兜底 setHand）
     · 新写法 = 从 tools/e2e/mj-browser.js 的 HTA 字符串里抽出来的 mjDriveToHumanTurn（一字未改）
   ═══════════════════════════════════════════════════════════════════════════ */
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "mahjong.js"), "utf8");

/* ① DOM stub 直接借 mahjong-logic.js 那一份（语义边界切片，不复制粘贴，避免抄错） */
const logic = fs.readFileSync(path.join(ROOT, "tools/test/mahjong-logic.js"), "utf8");
const a = logic.indexOf("/* ── 最小 DOM stub ──");
const b = logic.indexOf("const ctx = vm.createContext(windowStub);");
if (a < 0 || b < 0) { console.error("取不到 DOM stub 片段"); process.exit(2); }
const stubs = new Function(logic.slice(a, b) + "\nreturn { documentStub: documentStub, windowStub: windowStub };")();

/* ② 把 HTA 里的 JScript 抽出来，取出新辅助函数（真代码） */
const browser = fs.readFileSync(path.join(ROOT, "tools/e2e/mj-browser.js"), "utf8");
const h0 = browser.indexOf("const HTA = [");
const h1 = browser.indexOf('].join("\\n");', h0);
const htaAll = vm.runInNewContext(browser.slice(h0 + "const HTA = ".length, h1 + 1), {}).join("\n");
const js0 = htaAll.indexOf('<script language="JScript">');
const js1 = htaAll.lastIndexOf("</script>");
const HTAJS = htaAll.slice(js0 + '<script language="JScript">'.length, js1);

const ctx = vm.createContext(stubs.windowStub);
ctx.__DIR__ = "";                                      // HTA 里的占位符（真跑时由 Node 侧替换成目录）
vm.runInContext(SRC, ctx, { filename: "mahjong.js" });
/* HTA 的 HTML 里有 <div id="mj"></div>，这个 stub 不会自动建它 —— 不登记的话
   mjRestartGame() 里的 document.getElementById("mj") 会是 null，start() 直接返回 false
   （这是探针环境的问题，不是被验证代码的问题）。 */
stubs.documentStub.body.innerHTML = '<div id="mj"></div>';
const MJ = ctx.Mahjong;
if (!MJ) { console.error("mahjong.js 未导出 Mahjong"); process.exit(2); }
vm.runInContext(HTAJS, ctx, { filename: "hta-inline.js" });
if (typeof ctx.mjDriveToHumanTurn !== "function") { console.error("HTA 里没有 mjDriveToHumanTurn"); process.exit(2); }

const HAND13 = ["1万", "2万", "3万", "4万", "5万", "6万", "7万", "8万", "9万", "1条", "2条", "3条", "4条"];
const HOST = stubs.documentStub.getElementById("mj") || stubs.documentStub.createElement("div");
function newGame() { MJ.dispose(); return MJ.start(HOST, { onFinish: function () {} }); }
function wallSwapHead(tile) {
  const E = MJ.debug.engine(); if (!E || !E.wall) return false;
  for (let i = 1; i < E.wall.length; i++) if (E.wall[i] === tile) {
    const t = E.wall[0]; E.wall[0] = E.wall[i]; E.wall[i] = t; return true;
  }
  return false;
}
function wallAvoidHead(tile) {
  const E = MJ.debug.engine(); if (!E || !E.wall || E.wall[0] !== tile) return;
  for (let i = 1; i < E.wall.length; i++) if (E.wall[i] !== tile) {
    const t = E.wall[0]; E.wall[0] = E.wall[i]; E.wall[i] = t; return;
  }
}
/** 旧写法：旧辅助函数里那段「同步 for 循环 + 兜底 setHand」的原样搬运 */
function oldDrive(hand13) {
  MJ.debug.setHand(hand13, [], null);
  let st = MJ.debug.state();
  for (let i = 0; i < 60; i++) {
    st = MJ.debug.state();
    if (!st) break;
    if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2) break;
    if (st.phase === "claim" && st.pending && st.pending.seat === 0) { MJ.debug.act("pass"); continue; }
    if (st.phase === "rob" && st.pending && st.pending.seat === 0) { MJ.debug.act("pass"); continue; }
    if (st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 1) { MJ.debug.act("draw"); continue; }
    break;
  }
  st = MJ.debug.state();
  return st;
}
const shown = st => st && (st.phase + "/" + st.cur + "/" + st.handCount);
const mine = st => !!(st && st.phase === "turn" && st.cur === 0 && st.handCount % 3 === 2);

console.log("══ 机制①：摸到的那张正好成胡（这副牌单吊 4条）→ 自摸结算 ══");
newGame();
MJ.debug.setHand(HAND13, [], null);
wallSwapHead("4条");
console.log("  牌墙首张 = " + MJ.debug.engine().wall[0]);
let st = oldDrive(HAND13);
console.log("  旧写法实测 = " + shown(st) + " → ready_for_hint " + (mine(st) ? "过" : "✗ 红（这就是历史日志里的 over/0/14）"));
/* 新写法：把 setHand 钩一下，保证重开后的那局不会又摸到 4条（复现要确定性，不是靠运气） */
const origSetHand = MJ.debug.setHand;
MJ.debug.setHand = function (h, m, d) { const ok = origSetHand(h, m, d); wallAvoidHead("4条"); return ok; };
let r = ctx.mjDriveToHumanTurn(HAND13, true, 3);
console.log("  新辅助实测 = " + shown(r.st) + " · ok=" + r.ok + " games=" + r.games + " restarts=" + r.restarts + " drew=" + r.drew + " trace=" + JSON.stringify(r.trace));
console.log("  → ready_for_hint " + (mine(r.st) && r.ok && r.drew ? "过 ✓（自动重开第 " + r.games + " 局后拿到人类回合，且确实真摸了一张）" : "✗ 仍然红"));

console.log("\n══ 机制②：牌墙摸完 → Engine.turn 直接 drawGame() 流局 ══");
newGame();
MJ.debug.setHand(HAND13, [], null);
MJ.debug.engine().wall.length = 0;
st = oldDrive(HAND13);
console.log("  旧写法实测 = " + shown(st) + " → ready_for_hint " + (mine(st) ? "过" : "✗ 红（over/0/13：流局后 cur 仍是 0）"));
r = ctx.mjDriveToHumanTurn(HAND13, true, 3);
console.log("  新辅助实测 = " + shown(r.st) + " · ok=" + r.ok + " games=" + r.games + " restarts=" + r.restarts + " drew=" + r.drew + " trace=" + JSON.stringify(r.trace));
console.log("  → ready_for_hint " + (mine(r.st) && r.ok ? "过 ✓（本局结束 → 自动重开一局重试）" : "✗ 仍然红"));

(async () => {
  console.log("\n══ 机制③：本局在进辅助函数之前就已彻底结束（结算面板走完 → finishGame() 把 G.finished 置真）══");
  newGame();
  MJ.debug.setHand(HAND13, [], null);
  MJ.debug.engine().wall.length = 0;
  MJ.debug.act("draw");                       // 流局 → E.result
  MJ.debug.showResult();                      // 弹结算面板 → 8s 兜底自动 continue → finishGame()
  await new Promise(res => setTimeout(res, 8400));   // AUTO_FINISH_MS = 8000
  console.log("  本局状态 = " + shown(MJ.debug.state()) + " · finished=" + MJ.debug.state().finished);
  st = oldDrive(HAND13);
  console.log("  旧写法实测 = " + shown(st) + " · finished=" + MJ.debug.state().finished + " → ready_for_hint " + (mine(st) ? "过" : "✗ 红（dbgAct 第一行就 return false，怎么摆都动不了）"));
  r = ctx.mjDriveToHumanTurn(HAND13, true, 3);
  console.log("  新辅助实测 = " + shown(r.st) + " · finished=" + r.st.finished + " · ok=" + r.ok + " games=" + r.games + " restarts=" + r.restarts + " drew=" + r.drew);
  console.log("  → ready_for_hint " + (mine(r.st) && r.ok ? "过 ✓（终态②识别 finished → dispose+start 重开一局）" : "✗ 仍然红"));
  console.log("\n（探针结束）");
  process.exit(0);
})();
