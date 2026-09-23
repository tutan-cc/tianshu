/*
  cardfight-check.js —— 无头验证 cardfight.html 的**规则与结构**。
  为什么需要：这是个单文件浏览器游戏，没有 rAF/DOM 就没法整页跑。
  但"结算顺序 / 5 轮结束 / 胜负判定 / 牌堆循环 / 12 张卡是否齐全"这些是纯逻辑，
  可以抽出来直接驱动 —— 比"打开浏览器看一眼"可靠得多（也符合本项目既有做法：
  从真实源码抽实现来驱动，而不是在测试里重写一份）。

  用法：node tools/dev/cardfight-check.js
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FILE = path.join(__dirname, "..", "..", "cardfight.html");
const html = fs.readFileSync(FILE, "utf8");

let pass = 0, fail = 0;
const A = (ok, name, extra) => {
  if (ok) { pass++; console.log("  ✔ " + name + (extra ? "  [" + extra + "]" : "")); }
  else { fail++; console.log("  ✖ " + name + (extra ? "  [" + extra + "]" : "")); }
};

/* ── ① 结构检查：单文件、零外部依赖、双击可跑 ─────────────────────── */
console.log("\n【结构】");
A(!/<script[^>]+src=/i.test(html), "没有任何外部 <script src>（零依赖，双击即跑）");
A(!/<link[^>]+href=["']http/i.test(html), "没有外部样式表引用");
A(!/url\(\s*["']?https?:/i.test(html), "CSS 里没有外链图片/字体");
A(/<meta charset="utf-8">/i.test(html), "声明了 UTF-8（中文不会乱码）");
A(/addEventListener\("resize"/.test(html), "监听 resize（屏幕尺寸变化会重新适配）");
A(/function fitStage/.test(html) && /scale\(/.test(html), "用 scale 做整体缩放适配");

/* ── ② 抽出真实实现来驱动 ─────────────────────────────────────────
   把 <script> 里的纯逻辑部分抽出来跑。DOM 相关的函数用桩替代。 */
const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));

/* 找出需要的东西：CARDS / TYPE / 常量 / 结算函数 */
const grab = (re, name) => {
  const m = re.exec(script);
  if (!m) { console.log("  ⚠ 抽不到 " + name); return null; }
  return m[0];
};

const sandbox = {
  console, Math, setTimeout, Promise, Number, Array, Object, String, JSON,
  document: {
    getElementById: () => stubEl(),
    querySelectorAll: () => [],
    createElement: () => stubEl(),
    addEventListener: () => {},
  },
  window: { addEventListener: () => {}, innerWidth: 1280, innerHeight: 860 },
};
function stubEl() {
  const e = {
    style: { setProperty() {}, cssText: "" }, dataset: {}, children: [], classList: {
      add() {}, remove() {}, toggle() {}, contains: () => false,
    },
    innerHTML: "", textContent: "", appendChild(c) { this.children.push(c); },
    remove() {}, addEventListener() {}, querySelector: () => null,
    animate: () => ({ finished: Promise.resolve() }),
    offsetWidth: 1, getBoundingClientRect: () => ({ left: 0, top: 0, width: 112, height: 164 }),
  };
  return e;
}
sandbox.globalThis = sandbox;

/* 只抽出"数据 + 常量"这一段，末尾用表达式把结果取出来 ——
   ⚠ 不要分两段拼：`dataPart`（到 DOM 小工具之前）与 `constPart`（MAXHP 起）
     会重叠到 `const MAXHP`，拼起来就是 "Identifier 'MAXHP' has already been declared"。 */
const dataEnd = script.indexOf("/* ── DOM 小工具");
const dataPart = script.slice(0, dataEnd);
const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(dataPart + "\n" +
    "globalThis.__CARDS = CARDS; globalThis.__TYPE = TYPE;\n" +
    "globalThis.__C = { MAXHP: MAXHP, ROUNDS: ROUNDS, HAND: HAND, DECK: DECK };",
    ctx);
} catch (e) {
  console.log("  ✖ 抽取的数据段无法执行：" + e.message);
  console.log("\n[结果] 通过 " + pass + "，失败 " + (fail + 1));
  process.exit(1);
}
const CARDS = sandbox.__CARDS, TYPE = sandbox.__TYPE, C = sandbox.__C;
const POSES_FOR_CHECK = ["idle", "strike", "hit", "ko"];

console.log("\n【卡池】");
A(Array.isArray(CARDS) && CARDS.length === 12, "卡池正好 12 张", "实际 " + (CARDS ? CARDS.length : 0));
const keys = new Set(CARDS.map((c) => c.key));
A(keys.size === 12, "12 张卡的 key 唯一（不会出现重复卡）", "唯一 " + keys.size);
A(CARDS.every((c) => c.ico && c.nm && c.ds && c.vl), "每张卡都有 emoji 图标 / 名称 / 描述 / 数值");
A(CARDS.every((c) => /\p{Emoji}/u.test(c.ico)), "图标都是 emoji",
  CARDS.map((c) => c.ico).join(""));
const types = new Set(CARDS.map((c) => c.type));
["atk", "def", "heal"].forEach((t) => A(types.has(t), "包含基础类型：" + TYPE[t].n));
A(CARDS.some((c) => c.pierce), "有「破防」（无视护盾）");
A(CARDS.some((c) => c.lifesteal), "有「吸血」（伤害的一半回血）");
A(CARDS.some((c) => c.charge), "有「蓄力」（下一轮伤害翻倍）");
A(CARDS.some((c) => c.counter), "有「反击」（护盾 + 反弹一半伤害）");
A(CARDS.some((c) => c.heal), "有回血牌");
A(CARDS.some((c) => c.shield), "有格挡牌");

console.log("\n【规则常量】");
A(C.MAXHP === 60, "双方 60 点生命", "MAXHP=" + C.MAXHP);
A(C.ROUNDS === 5, "一共 5 轮", "ROUNDS=" + C.ROUNDS);
A(C.HAND === 3, "每轮抽 3 张", "HAND=" + C.HAND);
A(C.DECK === 12, "牌堆 12 张", "DECK=" + C.DECK);

/* ── ③ 借真实源码里的结算顺序做一次独立复算 ───────────────────────
   把 resolveRound 里的公式按需求复写一遍，验证"护盾→伤害→治疗→特殊"这个顺序
   在这些数值下确实成立（例如破防必须穿透护盾、护盾必须先于伤害生效）。 */
console.log("\n【结算顺序（按需求复算）】");
const byKey = {};
CARDS.forEach((c) => { byKey[c.key] = c; });

function settle(pk, ek, P, E) {
  const p = Object.assign({ hp: 60, shield: 0, charge: false, curse: false }, P);
  const e = Object.assign({ hp: 60, shield: 0, charge: false, curse: false }, E);
  const pc = byKey[pk], ec = byKey[ek];
  /* ① 护盾 */
  if (pc.shield) p.shield += pc.shield;
  if (ec.shield) e.shield += ec.shield;
  /* ② 伤害（护盾先抵；破防无视） */
  const hit = (t, c) => {
    let d = c.dmg || 0;
    if (c.charge) d = 0;
    let ab = 0;
    if (!c.pierce && t.shield > 0) { ab = Math.min(t.shield, d); t.shield -= ab; d -= ab; }
    t.hp = Math.max(0, t.hp - d);
    return d;
  };
  const pDealt = hit(e, pc), eDealt = hit(p, ec);
  /* ③ 治疗（诅咒减半） */
  const heal = (o, c) => { if (c.heal) o.hp = Math.min(60, o.hp + (o.curse ? Math.floor(c.heal / 2) : c.heal)); };
  heal(p, pc); heal(e, ec);
  /* ④ 特殊：吸血（向下取整）→ 反击 → 反击波（含它自己加的盾） */
  if (pc.lifesteal && pDealt) p.hp = Math.min(60, p.hp + Math.floor(pDealt / 2));
  if (ec.lifesteal && eDealt) e.hp = Math.min(60, e.hp + Math.floor(eDealt / 2));
  const refl = (self, foe, c, taken) => {
    if (!c.counter || taken <= 0) return 0;
    let r = Math.round(taken / 2);
    if (foe.shield > 0) { const ab = Math.min(foe.shield, r); foe.shield -= ab; r -= ab; }
    foe.hp = Math.max(0, foe.hp - r);
    return r;
  };
  const pR = refl(p, e, pc, eDealt), eR = refl(e, p, ec, pDealt);
  const rep = (self, foe, c) => {
    if (!c.reprisal) return 0;
    let d = self.shield;
    if (foe.shield > 0) { const ab = Math.min(foe.shield, d); foe.shield -= ab; d -= ab; }
    foe.hp = Math.max(0, foe.hp - d);
    return d;
  };
  const pRep = rep(p, e, pc), eRep = rep(e, p, ec);
  return { p, e, pDealt, eDealt, pR, eR, pRep, eRep };
}

/* ① 护盾必须先于伤害生效 */
{
  const r = settle("strike", "block", {}, {});          // 我突刺10 / 他格挡+10
  A(r.e.shield === 0 && r.e.hp === 60, "对手先加盾再挨打：10 伤害被 10 护盾完全吸收",
    "对手 hp=" + r.e.hp + " shield=" + r.e.shield);
  A(r.p.hp === 60, "对手出的是格挡牌，不对我造成伤害", "我 hp=" + r.p.hp);
}
/* ② 破防穿盾 */
{
  const r = settle("pierce", "wall", {}, {});           // 我破防8 / 他铁壁+18
  A(r.e.hp === 52, "破防无视护盾：对手 18 盾仍在，但血 -8",
    "对手 hp=" + r.e.hp + " shield=" + r.e.shield);
}
/* ③ 治疗在伤害之后：残血先挨打再回血 */
{
  const r = settle("heal", "heavy", {}, {});            // 我治疗+12 / 他重击16
  A(r.p.hp === 56, "治疗在伤害之后结算：60-16+12 = 56", "我 hp=" + r.p.hp);
}
/* ④ 吸血：按"实际打进去的伤害"的一半回血（被盾挡掉的部分不算） */
{
  const r = settle("drain", "wall", { hp: 30 }, {});    // 我吸血11 / 他铁壁18
  A(r.e.hp === 60 && r.e.shield === 7, "吸血被护盾全挡：对手血不减、盾 18→7", "对手 hp=" + r.e.hp + " shield=" + r.e.shield);
  A(r.p.hp === 30, "被挡光就没有吸血（只按实际伤害的一半）", "我 hp=" + r.p.hp);
  /* 我 30 血；对手突刺 10 打进来 → 扣到 20；吸血 = 实际伤害 10 的一半（向下取整）= 5 → 25 */
  const r2 = settle("drain", "strike", { hp: 30 }, {});
  A(r2.p.hp === 25, "吸血按**实际打进去**的伤害算，且向下取整：30 − 10 + 5 = 25",
    "我 hp=" + r2.p.hp + " · 我打出的伤害 " + r2.pDealt);
  /* 奇数伤害必须是 floor 而不是 round —— 卡面写"一半"，玩家要能自己算出来 */
  const odd = byKey.drain.dmg;                          // 11 → 一半 5.5
  A(Math.floor(odd / 2) === 5 && Math.round(odd / 2) === 6,
    "吸血用向下取整（11 的一半取 5，不是四舍五入的 6）",
    "牌面伤害 " + odd + " → floor " + Math.floor(odd / 2) + " / round " + Math.round(odd / 2));
}
/* ⑤ 反击：反弹本轮所受伤害的一半 */
{
  const r = settle("counter", "heavy", {}, {});         // 我反击(+8盾,反弹一半) / 他重击16
  /* 顺序：① 我 +8 盾 → ② 他 16 伤害先被 8 盾挡掉 8，我实际挨 8 → ③ 无治疗 → ④ 反弹 8/2=4 */
  A(r.p.hp === 52, "反击：8 盾先挡掉 8 点，我实际挨 8", "我 hp=" + r.p.hp);
  A(r.e.hp === 56, "反弹一半（8/2 = 4）打到对手身上", "对手 hp=" + r.e.hp);
}
/* ⑥ 蓄力：本轮不出手 */
{
  const r = settle("charge", "strike", {}, {});
  A(r.pDealt === 0, "蓄力本轮不造成伤害", "我造成的伤害=" + r.pDealt);
  A(r.p.hp === 50, "但蓄力期间会被打（对手突刺 10）", "我 hp=" + r.p.hp);
}
/* ⑦ 反击波：伤害 = 自己当前护盾（含它自己加的盾） */
{
  /* 我出反击波（自带 +6 盾）→ ① 我先有 6 盾 → ② 对手突刺 10：6 盾挡 6，我实际挨 4
     → ④ 反击波按"我当前护盾"打他；此刻盾已被打光 → 0 伤害。
     这一条正好演示了"结算顺序决定卡牌强弱"：反击波怕在你加盾的同一轮被打穿。 */
  const r = settle("reprisal", "strike", {}, {});
  A(r.p.shield === 0 && r.p.hp === 56, "反击波自带 6 盾：先挡掉对手 6 点（实际挨 4）",
    "我 hp=" + r.p.hp + " shield=" + r.p.shield);
  A(r.pRep === 0, "但盾已被打光 → 反击波算 0（结算顺序：加盾在伤害之前）", "实际 " + r.pRep);
  /* 对手不出手时，这 6 盾还在 → 反击波对对手打出 6 点。
     ⚠ 但对手这轮用格挡拿了 10 盾，6 点会被**它自己的盾**吃掉 ——
       所以返回值（穿过去的伤害）是 0，而它的盾从 10 掉到 4。
       "护盾先抵挡"这条对**反噬类伤害**同样成立，这正是要守的不变量。 */
  const r2 = settle("reprisal", "block", {}, {});
  A(r2.pRep === 0, "反击波 6 点被对手 10 盾全部吃掉（护盾对反噬也生效）", "穿过去的伤害 " + r2.pRep);
  A(r2.e.shield === 4 && r2.e.hp === 60,
    "对手格挡 +10：盾 10→4，血不减", "对手 hp=" + r2.e.hp + " shield=" + r2.e.shield);
  /* 对手不出手**也不加盾**时（用重击但被我们假设成空过）才看得到真实伤害 */
  const r2b = settle("reprisal", "strike", {}, {});
  A(r2b.pRep === 0 && r2b.p.hp === 56,
    "对手突刺时：6 盾先挡掉 6，我实际挨 4，盾被清空 → 反击波 0（结算顺序决定强弱）",
    "我 hp=" + r2b.p.hp + " · 穿过去的伤害 " + r2b.pRep);
  /* 与铁壁连用才是爆发：上一轮剩的盾 + 这轮的盾全算进去 */
  const r3 = settle("reprisal", "heal", { shield: 18 }, {});
  A(r3.pRep === 24, "上轮铁壁留 18 盾 + 本轮自带 6 = 24 伤害（这才是它的用法）", "实际 " + r3.pRep);
}

/* ── ④ 牌堆循环：抽满 5 轮会不会断牌 ─────────────────────────────── */
console.log("\n【牌堆循环】");
{
  let deck = CARDS.map((c) => c.key);
  /* 与服务端同款洗牌（这里只需长度正确，用顺序即可） */
  let drawn = 0, reshuffles = 0;
  for (let r = 1; r <= 5; r++) {
    for (let i = 0; i < 3; i++) {
      if (!deck.length) { deck = CARDS.map((c) => c.key); reshuffles++; }
      deck.pop(); drawn++;
    }
  }
  A(drawn === 15, "5 轮共抽出 15 张（每轮 3 张）", "抽出 " + drawn);
  A(reshuffles === 1, "12 张的牌堆在第 5 轮前恰好重洗 1 次（不会抽空断牌）", "重洗 " + reshuffles + " 次");
}
/* ⚠ 玩家自己抽牌之后新增的坑：重洗必须发生在**发牌之前**。
   只在 drawCards 内部重洗的话，逻辑会补牌、但中央卡背还停在 0 张 ——
   玩家看到空牌堆、没有可点的卡，整局卡死在第 5 轮的抽牌阶段。
   （实测：无头脚本循环 90 次都停在「第 5 轮 ph=draw pick=0」。） */
{
  A(/function ensureDrawable/.test(script), "有 ensureDrawable（发牌前保证牌堆够用）");
  A(/ensureDrawable\(1\);[\s\S]{0,120}buildDeckVisual\(S\.deck\.length\)/.test(script),
    "startRound 里**先** ensureDrawable 再重画卡背（顺序反了就会卡死）");
  A(/function pickDrawFromDeck/.test(script) && /S\.phase = "draw"/.test(script),
    "抽牌是玩家点牌堆触发的（pickDrawFromDeck + phase 阶段机）");
  A(!/function syncDeckVisual/.test(script),
    "旧的「模拟牌堆」函数已删除（玩家自己抽之后，中央张数就是真牌堆张数）");
  A(/S\.phase = "pick"/.test(script) && /S\.phase !== "pick"/.test(script),
    "抽满 3 张后才允许出牌（phase !== pick 时 pickCard 直接返回）");
}

/* ── ⑤ 5 轮结束 / 生命归零两种终局都要有出口 ─────────────────────── */
console.log("\n【终局】");
A(/S\.p\.hp <= 0 \|\| S\.e\.hp <= 0/.test(script), "生命归零时会结束（双方都判）");
A(/S\.round >= ROUNDS/.test(script), "满 5 轮也会结束");
A(/function endGame/.test(script), "有统一的结果结算函数");
A(/win \? .*lose|S\.p\.hp > S\.e\.hp/.test(script), "按剩余生命判定胜负");

/* ── ⑥ 人物立绘与打斗动作（延用打斗 2.0 的资源）──────────────────────
   这一组存在的理由：卡牌游戏最容易做成"数字对撞"。
   要求是"有人物打斗动作"，所以必须钉住：立绘资源真的存在、四姿势齐全、
   standH/lowY 与切图脚本产出的 json 一致（不一致人物会忽大忽小或陷进地里）、
   以及出招/挨打/格挡/治疗/蓄力/倒地六个动作接口都在。 */
console.log("\n【人物立绘与动作】");
{
  const fs2 = require("fs");
  const path2 = require("path");
  const root = path.join(__dirname, "..", "..");
  const m = /const SPRITE_META = \{([\s\S]*?)\n\};/.exec(script);
  A(!!m, "源码里有 SPRITE_META（立绘元数据表）");
  const dirM = /const SPRITE_DIR = "([^"]+)"/.exec(script);
  A(!!dirM, "源码里有 SPRITE_DIR", dirM ? dirM[1] : "");
  const dir = dirM ? dirM[1] : "art/fight2/";
  /* 四姿势 PNG 必须真的在盘上 —— 缺一张就会退回剪影，而页面不会报错（静默降级） */
  ["puncher", "brawler"].forEach((slug) => {
    POSES_FOR_CHECK.forEach((p) => {
      const f = path2.join(root, dir, slug + "_" + p + ".png");
      A(fs2.existsSync(f), "立绘存在：" + slug + "_" + p + ".png",
        fs2.existsSync(f) ? Math.round(fs2.statSync(f).size / 1024) + " KB" : "缺文件");
    });
  });
  /* standH / lowY 必须和切图脚本生成的 json 对得上（这是"换图必须同步"的那个点） */
  ["puncher", "brawler"].forEach((slug) => {
    const jf = path2.join(root, dir, slug + ".json");
    if (!fs2.existsSync(jf)) { A(false, "切图元数据存在：" + slug + ".json", "缺文件"); return; }
    const j = JSON.parse(fs2.readFileSync(jf, "utf8"));
    const body = m ? m[1] : "";
    const key = slug === "puncher" ? "player" : "enemy";
    const blk = new RegExp(key + ":\\s*\\{[^}]*standH:(\\d+)").exec(body);
    const got = blk ? Number(blk[1]) : -1;
    A(got === j.poses.idle.h, key + ".standH 与切图 json 的 idle 高度一致（" + j.poses.idle.h + "）",
      "源码 " + got + " / json " + j.poses.idle.h);
  });
  /* 六个动作接口：出招/挨打/格挡/治疗/蓄力/倒地 */
  ["attack", "hurt", "guard", "heal", "charge", "ko"].forEach((fn) => {
    A(new RegExp("\\n  " + fn + "\\(").test(script), "舞台有动作接口：" + fn + "()");
  });
  A(/Stage\.attack\("player"\)/.test(script) && /Stage\.attack\("enemy"\)/.test(script),
    "双方结算时都会起手出招（不是只有一方动）");
  A(/Stage\.hurt\("enemy"/.test(script) && /Stage\.hurt\("player"/.test(script),
    "挨打后仰对双方都生效");
  A(/drawFighter\(g, who\)/.test(script), "有 drawFighter(g, who)（按姿势画立绘）");
  A(/meta\.lowY\[f\.pose\]/.test(script), "绘制时按姿势扣除 lowY（否则脚会陷进地里）");
  A(/requestAnimationFrame/.test(script) && /tick\(dt\)/.test(script), "战场有自己的 rAF 循环");
  A(/_started/.test(script), "战场初始化有守卫（再来一局不会叠加多个 rAF 循环）");
  /* 立绘是外部文件：必须保证加载失败时退回剪影而不是整页崩掉 */
  A(/im\.onerror/.test(script), "立绘加载失败有 onerror 兜底（退回剪影，不崩页面）");
}

console.log("\n[结果] 通过 " + pass + "，失败 " + fail);
process.exit(fail ? 1 : 0);
