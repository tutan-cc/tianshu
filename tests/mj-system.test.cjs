// 集成测试：index.html 的麻将系统胶水层（S 结构 / 旧档兼容 / 情报联动 / 与 mahjong.js 规则层对接）
// 运行：node tests/mj-system.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
const MJSRC = fs.readFileSync(path.join(ROOT, "mahjong.js"), "utf8");

/* ── mahjong.js（规则层）：真的加载同一份生产文件 ── */
function loadMahjong() {
  const mkEl = () => ({
    id: "", className: "", style: {}, dataset: {}, childNodes: [], children: [], innerHTML: "", textContent: "",
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    appendChild() {}, removeChild() {}, addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    getContext() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }
  });
  const doc = {
    createElement: mkEl, getElementById() { return null; }, querySelector() { return null; },
    querySelectorAll() { return []; }, addEventListener() {}, head: mkEl(), body: mkEl()
  };
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, Math, Date, JSON,
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    document: doc, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 900,
    localStorage: { getItem: () => null, setItem() {} }
  });
  vm.runInContext(MJSRC, ctx, { filename: "mahjong.js" });
  return ctx.Mahjong;
}

/* ── index.html（数据段 + 状态层 + 麻将系统胶水层）── */
function loadPage() {
  const data = SCRIPT.slice(SCRIPT.indexOf("const PLACES"), SCRIPT.indexOf("/* ═══════════════ 音频层"));
  const state = SCRIPT.slice(SCRIPT.indexOf("const ITEMS = {"), SCRIPT.indexOf("/* ═══════════════ UI 工具"));
  const glue = SCRIPT.slice(SCRIPT.indexOf("/* ═══════════════ 麻将系统（赌注"), SCRIPT.indexOf("/* ═══════════════ 刮彩票"));
  assert.ok(glue.length > 1000, "能从 index.html 抽出麻将系统胶水层");
  const toasts = [];
  const els = new Map();
  const el = (id) => {
    const e = {
      id: id || "", className: "", style: {}, dataset: {}, innerHTML: "", textContent: "", onclick: null,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } },
      addEventListener(t, fn) { this["on" + t] = fn; }, appendChild() {}, querySelectorAll() { return []; }
    };
    return e;
  };
  const $stub = (id) => {
    if (!els.has(id)) els.set(id, el(id));
    return els.get(id);
  };
  const after = [];
  const ctx = vm.createContext({
    console, Math, Date, JSON, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {} },
    toast: (h) => toasts.push(String(h)),
    AudioSys: { good() {}, bad() {}, ding() {}, click() {}, init() {} },
    $: $stub,
    document: { createElement: el, getElementById: (id) => $stub(id), querySelectorAll: () => [] },
    checkAchv() {}, save() {}, render() {},
    afterInter(r, why) { after.push({ r, why }); }, applyFx() {}
  });
  ctx.window = ctx;
  ctx.__toasts = toasts;
  ctx.__after = after;
  ctx.__els = els;
  ctx.Mahjong = loadMahjong();
  ctx.window.__cs2 = { debug: null, mjLast: null };
  vm.runInContext(data + "\n" + state + "\n" + glue +
    "\n;globalThis.__P={newState,restore,NODES,ACHV,BONDS,mjRecord,mjRecordHtml,mjShowReport," +
    "startMahjong,startFreeMahjong,startInviteGame,runMjGame,openMjLobby,mjMaybeInvite,hideMjInvite,mjChapterNow," +
    "setS:function(v){S=v;},getS:function(){return S;}};", ctx);
  return ctx;
}

/* ═══════════════ 1. S 结构：新字段与默认值 ═══════════════ */
test("newState 带上麻将系统字段（战绩 / 口碑 / 连胡 / 邀约）", () => {
  const P = loadPage();
  const s = P.__P.newState();
  assert.equal(s.mjWins, 0, "mjWins 初始 0");
  assert.equal(s.mjLosses, 0, "mjLosses 初始 0");
  assert.equal(s.mjNet, 0, "mjNet 初始 0");
  assert.equal(s.mjRep, 50, "mjRep 初始 50");
  assert.equal(s.mjStreak, 0, "mjStreak 初始 0");
  assert.equal(Object.keys(s.mjInvites).length, 0, "mjInvites 初始为空表");
});

/* ═══════════════ 2. restore：旧档必须能读，坏档仍然拒绝 ═══════════════ */
test("旧档（无任何 mj* 字段）自动补默认值，不被判成坏档", () => {
  const P = loadPage();
  const legacy = P.__P.newState();
  delete legacy.mjWins; delete legacy.mjLosses; delete legacy.mjNet;
  delete legacy.mjRep; delete legacy.mjStreak; delete legacy.mjInvites;
  const back = P.__P.restore(JSON.stringify(legacy));
  assert.ok(back, "旧档必须能读回来（不能因为缺 mj* 判坏档）");
  assert.equal(back.mjWins, 0);
  assert.equal(back.mjLosses, 0);
  assert.equal(back.mjNet, 0);
  assert.equal(back.mjRep, 50, "缺 mjRep → 补 50");
  assert.equal(back.mjStreak, 0);
  assert.equal(Object.keys(back.mjInvites).length, 0);
  const older = JSON.parse(JSON.stringify(legacy));
  older.version = 1;
  assert.ok(P.__P.restore(JSON.stringify(older)), "version 1 的旧档同样能读");
});

test("麻将字段越界 / 脏数据被清洗，坏档仍然拒绝", () => {
  const P = loadPage();
  const s = P.__P.newState();
  s.mjWins = 7.6; s.mjLosses = -3; s.mjNet = "abc"; s.mjRep = 999; s.mjStreak = 100000;
  s.mjInvites = { hong: { t: 1234, mode: "accepted" }, man: { t: "x", mode: "nope" }, guo: 500, zhao: { t: 1, mode: "accepted" } };
  const back = P.__P.restore(JSON.stringify(s));
  assert.ok(back, "脏数据不当成坏档，而是清洗");
  assert.equal(back.mjWins, 8, "小数四舍五入");
  assert.equal(back.mjLosses, 0, "负数夹到 0");
  assert.equal(back.mjNet, 0, "非数字回落默认 0");
  assert.equal(back.mjRep, 100, "mjRep 夹到 0~100 上限");
  assert.equal(back.mjStreak, 999, "连胡计数夹到上限");
  assert.equal(Object.keys(back.mjInvites).sort().join(","), "guo,hong,man", "只认已知邀约 id（zhao 丢弃）");
  assert.equal(back.mjInvites.hong.mode, "accepted");
  assert.equal(back.mjInvites.man.mode, "declined", "未知 mode 一律回落 declined");
  assert.equal(back.mjInvites.guo.t, 500, "旧格式（纯时间戳）也能迁移");
  const bad = P.__P.newState(); bad.stats.cash = -5;
  assert.equal(P.__P.restore(JSON.stringify(bad)), null, "负财富仍然是坏档");
  const badNode = P.__P.newState(); badNode.done = ["不存在的节点"];
  assert.equal(P.__P.restore(JSON.stringify(badNode)), null, "未知节点仍然是坏档");
  assert.equal(P.__P.restore("not json"), null, "非 JSON 仍然是坏档");
});

/* ═══════════════ 3. 成就表与规则层一致 ═══════════════ */
test("四枚麻将成就都在 ACHV 白名单里，且与 mahjong.js 的成就 id 对得上", () => {
  const P = loadPage();
  const MJ = P.Mahjong;
  const ACHV = P.__P.ACHV;
  for (const id of ["mjWin", "mjStreak3", "mjPayer", "mjRival"]) {
    assert.ok(ACHV[id] && ACHV[id].n, "ACHV 里有 " + id + "（" + (ACHV[id] && ACHV[id].n) + "）");
  }
  assert.equal(ACHV.mjStreak3.n, "三连胡");
  assert.equal(ACHV.mjPayer.n, "包赔三家");
  assert.equal(ACHV.mjWin.n, "牌桌老千", "原有成就保留");
  assert.equal(ACHV.mjRival.n, "冤家");
  const R = MJ.rules;
  const EV = (o) => Object.assign({ draw: false, win: false, seat: -1, style: "serious", stake: 10, net: 0, per: 0, totalWin: 0, tier: "small", tierName: "小胡", robKong: false, kongDraw: false, payerOnly: false, payerSeat: -1, playerRobbed: false, playerRobKong: false, npcWon: false, npcSeat: -1, winTooMuch: false, loseBig: false }, o);
  const ids = new Set([
    ...R.achvOf(EV({ win: true }), 3),
    ...R.achvOf(EV({ playerRobbed: true, payerOnly: true, payerSeat: 0 }), 0),
    ...R.achvOf(EV({ loseBig: true }), 0),
  ]);
  assert.equal(ids.size, 4, "四种事件覆盖四枚成就");
  for (const id of ids) assert.ok(ACHV[id], "achvOf 产出的 " + id + " 必须在 ACHV 表里");
});

/* ═══════════════ 4. 牌桌情报 → 现有节点 hidden 选项 ═══════════════ */
test("情报 flag 与现有节点联动（needFlag 选项 + 谈判隐藏杀招）", () => {
  const P = loadPage();
  const NODES = P.__P.NODES;
  const MJ = P.Mahjong;
  const intel = MJ.rules;
  assert.equal(intel.intelOfSeat(1), "金老板的软肋");
  assert.equal(intel.intelOfSeat(2), "红姐的铺面情报");
  assert.equal(intel.intelOfSeat(3), "顾曼的底线");
  assert.equal(intel.intelById("zhao"), "赵家的资金链", "赵家资金链映射预留给后续章节");
  const barOpts = NODES.bar.inter.opts;
  const barFlag = barOpts.filter((o) => o.needFlag === "红姐的铺面情报");
  assert.equal(barFlag.length, 1, "bar 节点有 1 条需要「红姐的铺面情报」的隐藏选项");
  assert.ok(barFlag[0].r.cash > 15, "隐藏选项收益更高（财富 " + barFlag[0].r.cash + " > 原 15）");
  assert.ok(barFlag[0].r.bond.hong >= 10, "并且涨红姐羁绊");
  const fo = NODES.negotiate.inter.flagOpt;
  assert.ok(fo, "negotiate 有 flagOpt 隐藏杀招");
  assert.equal(fo.needFlag, "金老板的软肋", "解锁条件 = 牌桌上赢下金老板");
  assert.ok(fo.r && fo.r.cash > 0 && fo.r.bond.hong > 0, "摊牌额外收益更好（财富 +" + fo.r.cash + " · 红姐 +" + fo.r.bond.hong + "）");
  const ev = intel.eventsOf({ win: true, seat: 0, draw: false, stake: 10, netCash: 20, payPerHouse: 20, totalWin: 60, tier: "small", tierName: "小胡" }, "serious");
  const flags = intel.intelUnlocked(ev);
  assert.ok(flags.includes(fo.needFlag), "赢下这一桌会解锁 negotiate 需要的 flag");
  assert.ok(flags.includes(barFlag[0].needFlag), "也会解锁 bar 隐藏选项需要的 flag");
});

/* ═══════════════ 5. 页面接线（入口 / 面板宿主 / 调试钩子） ═══════════════ */
test("侧栏入口、开局面板宿主、邀约条宿主、调试钩子都已接线", () => {
  const need = [
    ['id="mjFreeBtn"', "侧栏「🀄 找人打两圈」按钮"],
    ['id="mjRec"', "侧栏战绩显示位"],
    ['id="mjLobby"', "开局面板覆盖层"],
    ['id="mjLobbyHost"', "开局面板宿主（mahjong.js 渲染）"],
    ['id="mjInviteWrap"', "邀约条宿主"],
    ['id="talkFlag"', "谈判「摊牌（牌桌情报）」按钮"],
  ];
  for (const [txt, why] of need) assert.ok(HTML.includes(txt), why + " 存在（" + txt + "）");
  const P = loadPage();
  assert.equal(typeof P.__P.mjRecord, "function", "mjRecord 存在");
  assert.equal(typeof P.__P.mjRecordHtml, "function", "mjRecordHtml 存在");
  assert.equal(typeof P.__P.mjShowReport, "function", "mjShowReport 存在");
});

test("侧栏战绩文案：胜负数 / 净收支 / 口碑 / 连胡", () => {
  const P = loadPage();
  const s = P.__P.newState();
  s.mjWins = 3; s.mjLosses = 2; s.mjNet = 420; s.mjRep = 56; s.mjStreak = 2;
  P.__P.setS(s);
  const rec = P.__P.mjRecord();
  assert.equal([rec.wins, rec.losses, rec.net, rec.rep, rec.streak].join("/"), "3/2/420/56/2");
  const html = P.__P.mjRecordHtml();
  assert.ok(html.includes("3 胜 2 负"), "战绩文案含胜负：" + html.replace(/<[^>]*>/g, " "));
  assert.ok(html.includes("+¥420"), "含净收支");
  assert.ok(html.includes("56"), "含口碑");
  assert.ok(html.includes("2"), "含连胡");
});

/* ═══════════════ 6. 跨模块：真·S + 真·规则层 ═══════════════ */
test("真实 S 对象与 mahjong.js 规则层可直接对接（邀约 / 结算落地 / 保底）", () => {
  const P = loadPage();
  const MJ = P.Mahjong;
  const s = P.__P.newState();
  s.stats.cash = 2000;
  s.bonds.hong = 20; s.bonds.man = 19; s.bonds.guo = 20; s.per = 2;
  const list = MJ.rules.inviteList(s);
  assert.equal(list.map((x) => x.id).join("/"), "hong/guo", "用真实 S 判定邀约：红姐（夜/¥200）+ 妹妹（¥50），顾曼羁绊不足");
  assert.equal(list[0].stake, 200);
  assert.equal(list[0].ok, true, "财富 2000 → 可以接受 ¥200 的局");
  s.mjInvites.hong = { t: Date.now(), mode: "accepted" };
  assert.equal(MJ.rules.inviteList(s).map((x) => x.id).join("/"), "guo", "接受过之后不再弹同一条");
  s.stats.cash = 100;
  const res = { win: false, seat: 2, draw: false, tier: "small", tierName: "小胡", stake: 200,
    payPerHouse: 400, totalWin: 1200, netCash: -400, payerOnly: false, from: -1, style: "gentle" };
  const rep = MJ.rules.applyOutcome(s, res, { style: "gentle", invite: list[0], applyCash: true });
  assert.equal(s.stats.cash, 0, "财富 100 输 400 → 保底 0（不破产、不给负）");
  assert.equal(rep.cash.delta, -100, "实际扣款 −100");
  assert.equal(s.bonds.hong, 26, "红姐 20 → 26（放水让对方胡 +6）");
  assert.ok(s.flags.includes("红姐的铺面情报"), "放水到对家胡 → 解锁她的情报");
  assert.equal(s.mjWins, 0);
  assert.equal(s.mjLosses, 1, "记 1 负");
  assert.equal(s.mjNet, -400, "累计净收支 −400");
  assert.equal(s.mjRep, 47, "口碑 50 −2（放水）−1（大亏）= 47");
  const legacy = P.__P.newState();
  delete legacy.mjRep; delete legacy.mjStreak; delete legacy.mjInvites;
  const back = P.__P.restore(JSON.stringify(legacy));
  assert.equal(MJ.rules.inviteList(back).length, 0, "旧档升级后邀约判定正常（羁绊为 0 不约）");
  const rep2 = MJ.rules.applyOutcome(back, { win: true, seat: 0, draw: false, tier: "small", tierName: "小胡",
    stake: 50, payPerHouse: 100, totalWin: 300, netCash: 300, payerOnly: false, from: -1, style: "serious" }, { style: "serious" });
  assert.equal(back.mjRep, 56, "旧档补的 50 口碑从 50 起算（胡 +3 / 赢太多 +3）");
  assert.equal(back.mjWins, 1);
  assert.equal(rep2.cash.after, 310, "旧档财富 10 + 300 = 310");
});

/* ═══════════════ 7. 胶水层三条落地路径（剧情局 / 自由局 / 邀约局） ═══════════════ */
const WIN_RES = { win: true, selfDraw: true, draw: false, seat: 0, tier: "small", tierName: "小胡",
  stake: 200, perPlayer: 400, payPerHouse: 400, totalWin: 1200, netCash: 1200, payerOnly: false,
  from: -1, style: "serious", fan: 1, fanName: "小胡", score: 1200, winner: "你", log: [] };

test("自由局：结算只动财富，并写战绩 + toast", () => {
  const P = loadPage();
  const s = P.__P.newState();
  s.stats.cash = 500;
  P.__P.setS(s);
  let opt = null;
  P.Mahjong.start = (host, o) => { opt = o; o.onFinish(WIN_RES); return true; };
  P.__P.startFreeMahjong({ stake: 200, style: "serious" });
  assert.ok(opt, "mahjong.js 的 start 被调用");
  assert.equal(opt.stake, 200, "透传注码 200");
  assert.equal(opt.style, "serious", "透传打法");
  assert.equal(opt.state, s, "把 S 交给规则层（结算面板预演用）");
  assert.equal(s.stats.cash, 1700, "财富 500 + 1200");
  assert.equal(s.mjWins, 1);
  assert.equal(s.mjNet, 1200);
  assert.equal(s.mjRep, 56, "认真赢太多 → 口碑 50 + 6");
  assert.ok(s.flags.includes("金老板的软肋"), "赢下牌桌 → 解锁情报");
  assert.ok(P.__toasts.some((t) => t.includes("牌桌情报")), "情报 toast 已弹出：" + P.__toasts.join(" | "));
  assert.ok(P.__toasts.some((t) => t.includes("自由局")), "自由局开场 toast");
  assert.equal(P.__els.get("mj").classList.contains("on"), false, "结算后牌桌覆盖层关闭");
});

test("剧情局（金色年华）：走节点奖励、不额外扣财富，仍然解锁情报与成就", () => {
  const P = loadPage();
  const s = P.__P.newState();
  s.stats.cash = 30;
  P.__P.setS(s);
  let opt = null;
  P.Mahjong.start = (host, o) => { opt = o; o.onFinish(WIN_RES); return true; };
  const it = { perfect: { cash: 30, int: 8, bond: { hong: 4 } }, ok: { cash: 10 }, miss: { cash: 3 } };
  P.__P.startMahjong(it);
  assert.equal(opt.stake, 10, "剧情局沿用 ¥10 基准（旧行为不变）");
  assert.equal(opt.style, "serious", "剧情局默认认真");
  assert.equal(s.stats.cash, 30, "剧情局的财富由节点奖励给（这里走 afterInter），胶水层不直接改财富");
  assert.equal(s.mjWin, true, "原有 S.mjWin 标记保留");
  assert.equal(s.mjWins, 1, "剧情局也计入胜负场次（三连胡可在剧情局累计）");
  assert.equal(s.mjNet, 0, "但剧情局不计净收支（避免战绩与实际财富对不上）");
  assert.equal(P.__after.length, 1, "结算后进入 afterInter（节点奖励流程）");
  assert.equal(P.__after[0].r.cash, 30 + 1200, "节点奖励 = perfect.cash + 本局 score（旧公式不变）");
  assert.ok(s.flags.includes("金老板的软肋"), "剧情局赢金老板也能解锁「金老板的软肋」→ negotiate 隐藏选项可用");
});

test("邀约局：接受 → 直接开对应赌注的牌局 → 羁绊按打法变化", () => {
  const P = loadPage();
  const s = P.__P.newState();
  s.stats.cash = 2000;
  s.bonds.hong = 20; s.bonds.man = 0; s.bonds.guo = 0; s.per = 2;
  P.__P.setS(s);
  /* 邀约条：捕获回调（真实调用 mahjong.js 的 showInvite，这里只截回调） */
  let cap = null;
  P.Mahjong.showInvite = (el, inv, cbs) => { cap = { el, inv, cbs }; return true; };
  let opt = null;
  P.Mahjong.start = (host, o) => { opt = o; o.onFinish(WIN_RES); return true; };
  const inv = P.__P.mjMaybeInvite();
  assert.ok(inv && inv.id === "hong", "回到沙盘时弹出红姐的邀约：" + (inv && inv.id));
  assert.ok(cap && cap.inv.stake === 200, "邀约注码 ¥200");
  assert.equal(P.__els.get("mjInviteWrap").style.display, "block", "邀约条显示出来");
  cap.cbs.onDecline();
  assert.equal(s.mjInvites.hong.mode, "declined", "「改天」→ 记入 S.mjInvites（20 分钟冷却）");
  assert.equal(P.__els.get("mjInviteWrap").style.display, "none", "「改天」后邀约条收起");
  /* 重新弹一次并接受 */
  delete s.mjInvites.hong;
  const inv2 = P.__P.mjMaybeInvite("hong");
  assert.ok(inv2 && inv2.id === "hong", "冷却前可以用调试接口强制再弹");
  let opted = null;
  P.Mahjong.start = (host, o) => { opted = o; o.onFinish(WIN_RES); return true; };
  cap.cbs.onAccept();
  assert.equal(s.mjInvites.hong.mode, "accepted", "「接受」→ 记入 S.mjInvites");
  assert.ok(opted, "接受后直接开牌局");
  assert.equal(opted.stake, 200, "按邀约注码开局");
  assert.ok(opted.invite && opted.invite.id === "hong", "把邀约对象交给规则层（结算按角色改羁绊）");
  assert.equal(s.mjWins, 1, "邀约局同样计入战绩");
  assert.equal(s.mjNet, 1200);
  assert.equal(s.bonds.hong, 16, "认真赢太多（1200 = 6×注码）→ 红姐好感 20 −4 = 16");
  assert.ok(P.__toasts.some((t) => t.includes("红姐") && t.includes("好感")), "羁绊变化 toast：" + P.__toasts.join(" | "));
});

test("开局面板：侧栏入口把财富与战绩交给面板，开局回调直接开桌", () => {
  const P = loadPage();
  const s = P.__P.newState();
  s.stats.cash = 60; s.mjWins = 2; s.mjLosses = 1; s.mjNet = 180; s.mjRep = 56;
  P.__P.setS(s);
  let lob = null, opt = null;
  P.Mahjong.openLobby = (host, o) => { lob = { host, o }; return true; };
  P.Mahjong.start = (h2, o) => { opt = o; o.onFinish(WIN_RES); return true; };
  P.__P.openMjLobby();
  assert.ok(lob, "调用了 mahjong.js 的 openLobby");
  assert.equal(lob.o.cash, 60, "把当前财富交给面板（用于置灰判定）");
  assert.equal(lob.o.record.wins + "/" + lob.o.record.losses + "/" + lob.o.record.net + "/" + lob.o.record.rep, "2/1/180/56",
    "把战绩交给面板显示");
  assert.equal(P.__els.get("mjLobby").classList.contains("on"), true, "开局面板覆盖层打开");
  lob.o.onStart({ stake: 50, style: "gentle" });
  assert.equal(P.__els.get("mjLobby").classList.contains("on"), false, "点开始后关闭面板");
  assert.ok(opt && opt.stake === 50 && opt.style === "gentle", "按面板选择开局（¥50 · 放水）");
});

/* ═══════════════ 8. 打法的剧情后果：flag → 节点隐藏选项 / 冷淡分支 ═══════════════ */
test("剧情后果 flag 在节点里落地：顾曼的赏识 / 金老板的信任（筹码 +4）/ 牌桌结梁子冷淡分支", () => {
  const P = loadPage();
  const NODES = P.__P.NODES;
  const R = P.Mahjong.rules;
  /* ① 顾曼局放水 → 「顾曼的赏识」→ investor 多一条隐藏选项（优于现有选项：现金 + 智力） */
  const inv = NODES.investor.inter;
  assert.ok(inv.pre && inv.pre.length >= 1, "investor 节点有 pre 隐藏选项插叙");
  const gu = inv.pre.find((p) => p.needFlag === "顾曼的赏识");
  assert.ok(gu, "隐藏选项 needFlag = 顾曼的赏识");
  assert.ok(gu.r && gu.r.cash > 0 && gu.r.int > 0, `隐藏选项效果优于常规（财富 +${gu.r.cash} · 智慧 +${gu.r.int}）`);
  assert.ok(gu.r.cash > (inv.win.cash || 0), "财富收益高于「全胜」常规奖励（" + gu.r.cash + " > " + inv.win.cash + "）");
  assert.ok(gu.r.int > (inv.win.int || 0), "智力收益高于常规（" + gu.r.int + " > " + (inv.win.int || 0) + "）");
  assert.ok(String(gu.t).includes("牌桌上那半句实话"), "文案就是「把牌桌上那半句实话摆出来」：" + gu.t.slice(0, 24));
  /* ② 金老板局放水 → 「金老板的信任」→ negotiate 开局筹码 +4 + 隐藏选项 */
  const tl = NODES.negotiate.inter;
  assert.ok(tl.startChips && tl.startChips.needFlag === "金老板的信任", "negotiate 有 startChips（金老板的信任）");
  assert.equal(tl.startChips.chips, 4, "开局筹码 +4");
  assert.ok(Array.isArray(tl.flagOpts) && tl.flagOpts.some((o) => o.needFlag === "顾曼的赏识"),
    "negotiate 有 flagOpts 隐藏选项（顾曼的赏识）");
  assert.ok(tl.flagOpt.needFlag === "金老板的软肋", "原有 flagOpt（金老板的软肋）保留");
  /* ③ 剧情节点的 needFlag 选项用的都是规则层会产出的 flag */
  const suOpt = NODES.park.inter.opts.find((o) => o.needFlag === "她的旧伤");
  const linOpt = NODES.office.inter.opts.find((o) => o.needFlag === "公司的人事风声");
  assert.ok(suOpt && suOpt.r.bond.su >= 15, "park 有「她的旧伤」隐藏选项（苏晚晴 +" + suOpt.r.bond.su + "）");
  assert.ok(linOpt && linOpt.r.bond.lin >= 15, "office 有「公司的人事风声」隐藏选项（林溪 +" + linOpt.r.bond.lin + "）");
  /* ④ 冷淡分支：牌桌结梁子 → 该角色节点多一条冷话分支 */
  const cold = NODES.park.inter.cold;
  assert.ok(cold && cold.needFlag === "牌桌结梁子：红姐", "park 有冷淡分支（牌桌结梁子：红姐）");
  assert.ok(String(cold.t).includes("红姐") && String(cold.t).length > 8, "冷淡台词可见：" + cold.t);
  const cold2 = NODES.library.inter.cold;
  assert.ok(cold2 && cold2.needFlag === "牌桌结梁子：温阮", "library 有冷淡分支（牌桌结梁子：温阮）");
  /* ⑤ 规则层真的会产出这三条 flag，且 flag 名与节点 needFlag 完全一致 */
  const evGentle = R.eventsOf({ win: false, seat: 3, draw: false, tier: "small", tierName: "小胡", stake: 1000, netCash: -2000, payPerHouse: 2000, totalWin: 6000, payerOnly: false, from: -1, style: "gentle" }, "gentle");
  assert.deepEqual(Array.from(R.consequenceFlags(evGentle, R.inviteDef("man"))), ["顾曼的赏识"], "顾曼局放水 → 顾曼的赏识");
  assert.deepEqual(Array.from(R.consequenceFlags(evGentle, { id: "jin", name: "金老板", cname: "金老板" })), ["金老板的信任"],
    "金老板局放水 → 金老板的信任");
  const evHard = R.eventsOf({ win: true, seat: 0, draw: false, tier: "small", tierName: "小胡", stake: 200, netCash: 1200, payPerHouse: 400, totalWin: 1200, payerOnly: false, from: -1, style: "serious" }, "serious");
  assert.deepEqual(Array.from(R.consequenceFlags(evHard, R.inviteDef("hong"))), ["牌桌结梁子：红姐"], "认真赢太狠 → 牌桌结梁子：红姐");
  assert.deepEqual(Array.from(R.consequenceFlags(evHard, R.inviteDef("wen"))), ["牌桌结梁子：温阮"], "认真赢太狠 → 牌桌结梁子：温阮");
});

test("新增 5 条情报：解锁映射写进 S.flags，并接进节点 needFlag 选项", () => {
  const P = loadPage();
  const R = P.Mahjong.rules;
  const NODES = P.__P.NODES;
  const NEW = { lin: "公司的人事风声", su: "她的旧伤", wen: "她错的那道题", lei: "馆里的旧账", lu: "急诊室的秘密" };
  for (const [id, name] of Object.entries(NEW)) {
    assert.equal(R.intelById(id), name, "情报映射 " + id + " → " + name);
    assert.equal(R.inviteDef(id).intel, name, "邀约表 " + id + " 的 intel = " + name);
    assert.equal(R.inviteIdByIntel(name), id, "反查：" + name + " → " + id);
    const s = P.__P.newState();
    s.stats.cash = 5000;
    const d = R.inviteDef(id);
    const res = { win: true, seat: 0, draw: false, tier: "small", tierName: "小胡", stake: d.stake,
      payPerHouse: d.stake * 2, totalWin: d.stake * 6, netCash: d.stake * 2, payerOnly: false, from: -1, style: "serious" };
    const rep = R.applyOutcome(s, res, { style: "serious", invite: { id: d.id, name: d.name, cname: d.cname, bond: d.bond, seat: -1, stake: d.stake, pureBond: false } });
    assert.ok(s.flags.includes(name), "赢下 " + d.name + " 的邀约局 → S.flags 含「" + name + "」");
    assert.ok(rep.flags.includes(name), "报告 flags 含「" + name + "」");
  }
  /* 其中 2 条真的接进了现有节点的隐藏选项 */
  assert.ok(NODES.park.inter.opts.some((o) => o.needFlag === "她的旧伤"), "「她的旧伤」→ park 隐藏选项");
  assert.ok(NODES.office.inter.opts.some((o) => o.needFlag === "公司的人事风声"), "「公司的人事风声」→ office 隐藏选项");
  /* 另外 3 条至少写进 S.flags（可在后续章节节点继续接） */
  for (const name of ["她错的那道题", "馆里的旧账", "急诊室的秘密"]) {
    assert.ok(Object.values(R.INTEL_BY_ID).includes(name), name + " 已在 INTEL_BY_ID 映射表里");
  }
});

/* ═══════════════ 9. 旧档兼容 + 邀约章节上下文 ═══════════════ */
test("旧档兼容：新 flag / 新邀约 id / 新字段都不判坏档；新 id 可存档", () => {
  const P = loadPage();
  const R = P.Mahjong.rules;
  /* 旧档（只有老三样邀约记录、没有新 flag）必须能读 */
  const legacy = P.__P.newState();
  legacy.mjInvites = { hong: { t: 1, mode: "declined" }, guo: 700 };
  delete legacy.mjWins; delete legacy.mjRep; delete legacy.mjStreak;
  const back = P.__P.restore(JSON.stringify(legacy));
  assert.ok(back, "旧档能读回来");
  assert.equal(back.mjRep, 50, "mjRep 补默认");
  assert.equal(Object.keys(back.mjInvites).sort().join(","), "guo,hong", "旧格式邀约记录迁移正常");
  /* 新角色的邀约记录能存能读（白名单已扩到 8 位） */
  const s2 = P.__P.newState();
  s2.mjInvites = { lin: { t: 5, mode: "accepted" }, lu: { t: 6, mode: "declined" }, zhao: { t: 7, mode: "accepted" } };
  const back2 = P.__P.restore(JSON.stringify(s2));
  assert.ok(back2, "含新邀约 id 的存档能读");
  assert.equal(Object.keys(back2.mjInvites).sort().join(","), "lin,lu", "新 id（lin/lu）保留，未知 id（zhao）丢弃");
  assert.equal(back2.mjInvites.lin.mode, "accepted");
  /* 后果 flag 是普通字符串 flag，旧 flag 数组不会被判坏档 */
  const s3 = P.__P.newState();
  s3.flags = ["顾曼的赏识", "金老板的信任", "牌桌结梁子：红姐", "街面情报"];
  const back3 = P.__P.restore(JSON.stringify(s3));
  assert.ok(back3, "带剧情后果 flag 的存档能读");
  assert.equal(back3.flags.length, 4, "四个 flag 全部保留");
  /* 章节上下文：mjChapterNow 在未知章节时返回 0，邀约判定仍可用 */
  assert.equal(typeof P.__P.mjChapterNow, "function", "胶水层暴露 mjChapterNow（邀约优先级用）");
  const ch = P.__P.mjChapterNow();
  assert.ok(ch === 0 || ch === null, "空存档 → 章节 0 或 null（交给规则层兜底），实际 " + ch);
  /* 规则层：章节 2 时本章专属角色优先于通用兜底 */
  const B = { hong: 20, man: 20, guo: 20, lin: 20, su: 20, wen: 20, lei: 20, lu: 20 };
  const mk = (o) => Object.assign({ bonds: Object.assign({}, B), per: 2, stats: { cash: 5000 }, mjInvites: {} }, o);
  assert.equal(R.pickInvite(mk({ ch: 2 }), 1000).id, "lin", "章节 2 → 本章专属最高优先（林溪）");
  assert.equal(R.pickInvite(mk({ ch: 3 }), 1000).id, "hong", "章节 3 → 通用兜底角色（红姐）");
  assert.equal(R.inviteList(mk({ ch: 2 }), 1000).length, 6, "章节 2：6 条候选（5 个 ch:2 + 红姐，陈果被时段挡住）");
  /* 同一次只弹一条 */
  assert.ok(R.pickInvite(mk({ ch: 2 }), 1000) !== null, "pickInvite 只返回一条");
  /* 财富不足仍列出但禁用 */
  const poor = R.inviteList(mk({ ch: 2, stats: { cash: 30 } }), 1000);
  assert.ok(poor.length > 0 && poor.every((x) => x.ok === false), "财富 30：全部禁用");
  assert.ok(poor[0].reason.includes("财富不足"), "禁用原因写明财富不足");
});


test("AI 明杠玩家打出的發：摸牌墙尾，再由同一座位出牌", () => {
  const { Engine, createWall, tileAudit } = loadMahjong().test;
  for (const seat of [1, 3]) {
    const game = new Engine(10, { honors: true });
    const wall = createWall(true);
    const take = tile => {
      const index = wall.indexOf(tile);
      assert.ok(index >= 0, tile);
      return wall.splice(index, 1)[0];
    };
    game.P[0].hand = ["發", "1万", "2万", "4万", "6万", "8万", "9万", "1筒", "4筒", "7筒", "2条", "6条", "东", "南"].map(take);
    game.P[seat].hand = ["發", "發", "發", "1万", "3万", "5万", "8万", "1筒", "4筒", "7筒", "1条", "5条", "西"].map(take);
    const tail = take("北");
    for (let other = 1; other < 4; other++) {
      if (other !== seat) game.P[other].hand = wall.splice(0, 13);
    }
    wall.push(tail);
    game.wall = wall;
    const front = wall[0], initialCount = wall.length;
    game.setTurn(0);

    assert.equal(game.discard(0, 0), true);
    assert.equal(game.aiStep(), "gang");
    assert.equal(game.cur, seat);
    assert.equal(game.P[0].discards.length, 0);
    assert.equal(game.P[seat].drawn, tail);
    assert.equal(game.P[seat].hand.length, 11);
    assert.equal(game.P[seat].melds[0].tiles.length, 4);
    assert.equal(game.wall[0], front);
    assert.equal(game.wall.length, initialCount - 1);
    assert.equal(game.log[2].source, "kong");
    assert.equal(game.aiStep(), "discard");
    assert.equal(game.P[seat].hand.length, 10);
    assert.equal(game.log[3].seat, seat);
    assert.equal(game.log[3].tile, game.P[seat].discards[0]);
    assert.equal(tileAudit(game).ok, true);
  }
});
