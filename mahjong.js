/* ═══════════════════════════════════════════════════════════════════════════
   mahjong.js — 赣麻（江西麻将）· 4 家（你 + 3 位 AI）· 真实麻将桌渲染
   自包含 IIFE，暴露全局 window.Mahjong；不使用 ES module，不依赖页面内变量。

   牌张表示：字符串 "1万".."9万" / "1条".."9条" / "1筒".."9筒"，共 108 张（无字牌）。
   对外 API：
     window.Mahjong.start(hostEl, opts) -> boolean
     window.Mahjong.isBusy()            -> boolean
     window.Mahjong.dispose()
     window.Mahjong.debug = { hand(), wall(), seats(), act(action, tileId), ... }
   附加（单测用，不属于规格）：window.Mahjong.test = { ...纯逻辑... }

   ── 赣麻规则（按用户文档实现，不自作主张）──────────────────────────────
   1) 没有吃，只有 碰 / 杠 / 胡；没有字牌、没有百搭（鬼牌）、不看清一色
   2) 没有点炮：只能自摸胡（他人打出的牌不能胡）
   3) 抢杠胡：可抢「直杠（大明杠）」与「碰后回头杠（补杠）」；暗杠不可抢
   4) 杠开：杠后补摸的牌自摸 → 小胡升为大胡；已是「大胡及以上」则番数翻两倍
   5) 档位（打 10 元基准；一张牌 = 10 元）：
        小胡   = 顺子×n + 对子(+0..n 杠)          每家 2 张 = 20，  共收 60
        大胡   = 杠/刻×n + 对子（无顺子，碰碰胡）  每家 8 张 = 80，  共收 240
        大大胡 = 大吊车（手中仅剩 1 张单调成对）或 七对
                                                  每家 12 张 = 120， 共收 360
        最大胡 = 龙七对（七对中含 4 张暗杠）        每家 24 张 = 240， 共收 720
      对子必须且只能有一对（七对 / 龙七对除外）
   6) 抢杠胡由杠牌一家包赔三家（文档「由杠牌一家承担」，见报告中的不确定点）
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";
  if (!root || root.Mahjong) return;
  var doc = root.document;
  /** ES5 版 Object.assign（保持 IE11/老引擎可跑） */
  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (!s) continue;
      for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
    }
    return t;
  }

  /* ═══════════════ 0. 贴图（本批 Lovart 素材）═══════════════════════════════
     统一加载器：预加载 art/icons/mj/*.png + art/bg/mahjong.png，绘制处优先 drawImage，
     图片没就绪 / 加载失败 / 环境里没有 Image（无头单测、老浏览器）→ 一律回退原来的
     程序化画法（卡面 drawHonorFace/drawWanFace…、牌背斜纹、绿绒桌面）。
     所以规格是：**只允许加载 art/ 下的本地图片（相对页面目录），且每一处都有矢量回退**。
     ⚠ 本批只改「画什么」，不碰任何规则 / AI / 提示算法。                            */
  var ART_DIR = "art/";
  var MJ_ICON = { key: "mj", dir: "art/icons/mj/", ext: ".png", base: "", map: {}, loaded: 0, failed: 0,
                  ids: ["tile_white", "tile_fa", "dice", "chip_blue", "chip_red", "chip_gold", "tile_back", "ruler", "ashtray"] };
  var MJ_BG = { dir: "art/bg/", name: "mahjong.png", img: null, loaded: 0, failed: 0 };
  /** 页面所在目录（带结尾 /）；取不到就返回空串 → 相对路径照样能用 */
  function pageDir() {
    var loc = root.location, href = "";
    if (loc) {
      if (typeof loc.href === "string" && loc.href) href = loc.href;
      else if (typeof loc.pathname === "string" && loc.pathname) href = loc.pathname;
    }
    if (!href) return "";
    href = href.replace(/\\/g, "/");
    var i = href.lastIndexOf("/");
    return i >= 0 ? href.slice(0, i + 1) : href;
  }
  function initArt() {
    MJ_ICON.base = pageDir() + MJ_ICON.dir;
    MJ_ICON.map = {}; MJ_ICON.loaded = 0; MJ_ICON.failed = 0;
    MJ_BG.img = null; MJ_BG.loaded = 0; MJ_BG.failed = 0;
    if (!root.Image) return;                                    // 无 Image → 全矢量，功能一点不少
    var i, img;
    for (i = 0; i < MJ_ICON.ids.length; i++) {
      (function (id) {
        var im = null;
        try { im = new root.Image(); } catch (e) { im = null; }
        if (!im) { MJ_ICON.failed++; return; }
        MJ_ICON.map[id] = im;
        im.onload = function () { MJ_ICON.loaded++; };
        im.onerror = function () { MJ_ICON.failed++; };
        try { im.src = MJ_ICON.base + id + MJ_ICON.ext; } catch (e) { MJ_ICON.failed++; }
      })(MJ_ICON.ids[i]);
    }
    try { img = new root.Image(); } catch (e2) { img = null; }
    if (img) {
      MJ_BG.img = img;
      img.onload = function () { MJ_BG.loaded++; };
      img.onerror = function () { MJ_BG.failed++; };
      try { img.src = pageDir() + MJ_BG.dir + MJ_BG.name; } catch (e3) { MJ_BG.failed++; }
    } else MJ_BG.failed++;
  }
  /** 本帧可用（真解码完成）的贴图；否则返回 null → 调用方回退矢量 */
  function artOf(id) {
    var img = MJ_ICON.map[id];
    if (!img) return null;
    var nw = img.naturalWidth || 0;
    return (nw > 0 && img.complete !== false) ? img : null;
  }
  function bgArt() {
    var img = MJ_BG.img;
    if (!img) return null;
    var nw = img.naturalWidth || 0;
    return (nw > 0 && img.complete !== false) ? img : null;
  }
  initArt();


  var SUITS = ["万", "条", "筒"];
  var KINDS = (function () {                    // 27 种序数牌，顺序：万1..9 条1..9 筒1..9
    var a = [], si, n;
    for (si = 0; si < 3; si++) for (n = 1; n <= 9; n++) a.push(n + SUITS[si]);
    return a;
  })();
  /* ── 字牌（东南西北中發白）──────────────────────────────────────────────
     规则只用「一个常量」控制：INCLUDE_HONORS
       true （默认，用户已确认的规则）= 136 张（万条筒 1-9 + 东南西北中發白 各 4 张）
       false                          = 108 张（退回旧赣麻牌组，仅序数牌）
     字牌只能作 刻子 / 对子 / 七对里的对子，永远不能组顺子；字牌杠不可被抢杠胡。 */
  var HONORS = ["东", "南", "西", "北", "中", "發", "白"];
  var INCLUDE_HONORS = true;
  var KINDS_ALL = KINDS.concat(HONORS);                                   // 34 种（查表用，恒定）
  var KIDX = (function () { var m = {}, i; for (i = 0; i < KINDS_ALL.length; i++) m[KINDS_ALL[i]] = i; return m; })();
  /** 实战牌墙用的牌种：honors=true → 34 种（136 张），false → 27 种（108 张） */
  function kindsFor(honors) { return (honors === undefined ? INCLUDE_HONORS : !!honors) ? KINDS_ALL : KINDS; }
  function deckSize(honors) { return (honors === undefined ? INCLUDE_HONORS : !!honors) ? 136 : 108; }
  /** 牌的分组序号：万0 条1 筒2 字牌3 */
  function tileGroup(t) { var i = SUITS.indexOf(suitOf(t)); return i < 0 ? SUITS.length : i; }
  function isHonor(t) { return tileGroup(t) === SUITS.length; }
  function honorIdx(t) { return HONORS.indexOf(t); }
  var SUIT_CLS = { "万": "wan", "条": "tiao", "筒": "tong" };

  var SEAT_DEF = [
    { name: "你", human: true },
    { name: "金老板", human: false },
    { name: "红姐", human: false },
    { name: "顾曼", human: false }
  ];
  /** 赣麻档位：tiles = 每家赔付张数（打 10 元基准） */
  var TIER = {
    small:   { key: "small",   name: "小胡",   tiles: 2,  per: 20,  total: 60  },
    big:     { key: "big",     name: "大胡",   tiles: 8,  per: 80,  total: 240 },
    bigger:  { key: "bigger",  name: "大大胡", tiles: 12, per: 120, total: 360 },
    biggest: { key: "biggest", name: "最大胡", tiles: 24, per: 240, total: 720 }
  };
  var STAKE_DEFAULT = 10;
  /** 杠的种类 → 能否被抢杠胡（暗杠不能抢） */
  var KONG_ROBBABLE = { an: false, ming: true, bu: true };

  /* ═══════════════ 1b. 赌注 / 打法 / 邀约 / 口碑 / 情报（系统层，纯逻辑、无 DOM） ═══════════════
     把「一个节点里的麻将」升级成「一套系统」：三档注码 + 自由局 + NPC 邀约 + 牌友口碑 + 牌桌情报。
     本层所有函数都是纯函数（不碰 DOM / 不读全局状态），既能被 index.html 调用，
     也能被单测与浏览器探针直接验证。 */

  var STAKE_TIERS = [50, 200, 1000];                  // 自由局三档注码（¥50 / ¥200 / ¥1000）
  var STYLE_DEF = {
    serious: { key: "serious", name: "认真", label: "认真打",   hint: true,  desc: "智脑提示全开 · AI 正常 · 赢面大" },
    gentle:  { key: "gentle",  name: "放水", label: "放水陪玩", hint: false, desc: "智脑提示关闭 · 出牌温和 · 涨好感" }
  };
  var REP_INIT = 50, REP_MIN = 0, REP_MAX = 100;      // 牌友口碑 0~100，初始 50
  var INVITE_COOLDOWN_MS = 20 * 60 * 1000;            // 「改天」之后 20 分钟内不再骚扰
  var INVITE_MSG = {
    hong: "三缺一，来不来？",
    man:  "今晚有个局，你来不来？",
    guo:  "哥，陪我打两圈嘛，就两圈。"
  };
  /** 座位号 → 角色 id（第 0 位是玩家自己；zhao 留给后续章节的赵家） */
  var SEAT_IDS = ["me", "jin", "hong", "man"];
  var INTEL_BY_ID = {
    jin:  "金老板的软肋",
    hong: "红姐的铺面情报",
    man:  "顾曼的底线",
    zhao: "赵家的资金链",
    /* ── 第二 / 三章角色的牌桌情报（随邀约局解锁）── */
    lin:  "公司的人事风声",
    su:   "她的旧伤",
    wen:  "她错的那道题",
    lei:  "馆里的旧账",
    lu:   "急诊室的秘密"
  };
  /** 成就中文名（与 index.html 的 ACHV 表一致；面板上给人看的） */
  var ACHV_NAME = { mjWin: "牌桌老千", mjStreak3: "三连胡", mjPayer: "包赔三家", mjRival: "冤家" };

  /* ═══ 邀约表（唯一一份，数据驱动） ═══════════════════════════════════════
     INVITES：每条 = 一个可邀约角色。字段：
       id        角色键（S.mjInvites / S.bonds / 情报的键；存档白名单要用）
       name/cname 显示名 / 牌后 flag 里用的角色名（牌桌结梁子：<cname>）
       bond/min  兼容旧字段：羁绊键 + 触发阈值（等价 bonds:[{key,min}] 的第一条）
       bonds     触发条件表：[{ key 羁绊键, min 阈值, pri 优先级(数值越大越优先), gain 本局产出 }]
                 逐个生效：达到 min 的才算「合格」，取 pri 最高的那条做排序与收益
       per       限定时段（0 上午 / 1 下午 / 2 晚上 / null 不限）
       ch        限定章节：state.ch（当前章节）≥ ch 才可能被约；null = 不限
       where     地点
       stake     注码（必须 ∈ STAKE_TIERS）
       seat      该角色在牌桌上的座位（-1 = 不上桌）
       pureBond  纯涨羁绊局（妹妹局）
       msg       邀约条开场白（角色口吻）
       openLine  开局 toast
       settle    结算台词（角色口吻）
       intel     本局可解锁的情报 flag
       note      面板上「本局可能获得」的可见文案（情报名不剧透）
     ═════════════════════════════════════════════════════════════════════ */
  var INVITE_TRIGGER_ORDER = ["hong", "man", "guo", "lin", "su", "wen", "lei", "lu"];
  var INVITE_DEF = [
    /* ── 第一 / 二章原有三人（字段与规则保持原样，不回归）── */
    { id: "hong", name: "红姐", cname: "红姐", bond: "hong", min: 20, bonds: [{ key: "hong", min: 20, pri: 20, gain: { int: 3 } }],
      per: 2, ch: null, stake: 200, seat: 2, pureBond: false, where: "金色年华 · 后巷",
      msg: "三缺一，来不来？", openLine: "红姐把牌一推：「坐，别磨蹭。」", settle: "红姐弹了弹烟灰：「你手上有东西——我记住了。」",
      intel: "红姐的铺面情报", note: "她铺面的事，也许能问出点什么" },
    { id: "man", name: "顾曼", cname: "顾曼", bond: "man", min: 20, bonds: [{ key: "man", min: 20, pri: 20, gain: { int: 6 } }],
      per: null, ch: 2, stake: 1000, seat: 3, pureBond: false, where: "投资大厦 · 顶层",
      msg: "今晚有个局，你来不来？", openLine: "顾曼推过来一副新牌：「让我看看你会不会算。」", settle: "顾曼收牌的手停了一下：「第二圈开始，你就不像个新手了。」",
      intel: "顾曼的底线", note: "她的底线在哪，也许能问出点什么" },
    { id: "guo", name: "陈果", cname: "陈果", bond: "guo", min: 20, bonds: [{ key: "guo", min: 20, pri: 20, gain: { cha: 3 } }],
      per: null, ch: null, stake: 50, seat: -1, pureBond: true, where: "出租屋 · 客厅",
      msg: "哥，陪我打两圈嘛，就两圈。", openLine: "陈果把牌摊了一桌：「我教你打，我可是很厉害的。」", settle: "陈果数着筹码笑：「哥，你刚刚是不是故意输给我的？」",
      intel: null, note: "她的心事，也许能问出点什么" },
    /* ── 本次新增：第二 / 三章的 5 位可邀约角色 ── */
    { id: "lin", name: "林溪", cname: "林溪", bond: "lin", min: 20, bonds: [{ key: "lin", min: 20, pri: 30, gain: { int: 5 } }],
      per: 2, ch: 2, stake: 50, seat: -1, pureBond: false, where: "公司 · 加班后的走廊",
      msg: "加班到现在……楼下那家宵夜摊还开着，打两圈？", openLine: "林溪把工牌塞进包里：「说好了，输的人明天替对方写周报。」", settle: "林溪把最后一张牌扣下：「你这人，牌品比平时靠谱。」",
      intel: "公司的人事风声", note: "公司最近的风声，也许能问出点什么" },
    { id: "su", name: "苏晚晴", cname: "苏晚晴", bond: "su", min: 20, bonds: [{ key: "su", min: 20, pri: 25, gain: { cha: 5 } }],
      per: 1, ch: 2, stake: 200, seat: -1, pureBond: false, where: "滨河公园 · 江边茶座",
      msg: "周末下午没事——江边那家茶座有牌，敢不敢来？", openLine: "苏晚晴把运动外套系在腰上：「先说好，我手气一向很好。」", settle: "苏晚晴托着腮看你：「你不像在打牌，像在算计什么。」",
      intel: "她的旧伤", note: "她腿上的旧伤，也许能问出点什么" },
    { id: "wen", name: "温阮", cname: "温阮", bond: "wen", min: 20, bonds: [{ key: "wen", min: 20, pri: 25, gain: { int: 8 } }],
      per: 2, ch: 2, stake: 50, seat: -1, pureBond: false, where: "图书馆 · 闭馆后的侧门",
      msg: "闭馆了……管理员要锁门了，打两圈再走？", openLine: "温阮把错题本垫在牌下面：「输的人，明天给我讲那道题。」", settle: "温阮盯着你出的最后一张牌：「你连打牌都像在解题。」",
      intel: "她错的那道题", note: "她一直错的那道题，也许能问出点什么" },
    { id: "lei", name: "雷姐", cname: "雷姐", bond: "lei", min: 20, bonds: [{ key: "lei", min: 20, pri: 28, gain: { phy: 6 } }],
      per: 2, ch: 2, stake: 200, seat: -1, pureBond: false, where: "拳击馆 · 拳台边",
      msg: "输的人请一周的饭，敢不敢？", openLine: "雷姐把缠手带一解：「牌桌上我也不放水。」", settle: "雷姐拍了下桌子：「痛快。明天上台，我给你加两组。」",
      intel: "馆里的旧账", note: "馆里那笔旧账，也许能问出点什么" },
    { id: "lu", name: "白露", cname: "白露", bond: "lu", min: 20, bonds: [{ key: "lu", min: 20, pri: 26, gain: { spi: 5, cha: 3 } }],
      per: 2, ch: 2, stake: 50, seat: -1, pureBond: false, where: "市一院 · 急诊楼后门",
      msg: "值完班的手气最好——陪我打两圈，输了我请你吃早饭。", openLine: "白露把护腕往上推了推：「我上夜班，手可凉。」", settle: "白露打了个哈欠笑：「你这手气，比我们急诊的排班还准。」",
      intel: "急诊室的秘密", note: "急诊室那一晚的事，也许能问出点什么" }
  ];
  /** 邀约表按 id 索引（调试接口 / 单测 / 文案查找共用） */
  var INVITE_BY_ID = (function () { var m = {}, i; for (i = 0; i < INVITE_DEF.length; i++) m[INVITE_DEF[i].id] = INVITE_DEF[i]; return m; })();
  function inviteDef(id) { return INVITE_BY_ID[id] || null; }

  /* ═══ 打法的剧情后果（放水 / 认真不是只有数值） ═══════════════════════════
     consequenceOf(ev, invite) → 事件数组（纯函数，规则层唯一实现）：
       { kind:"赏识"|"信任"|"结梁子", role, cname, id, flag, text }
     结算面板的「本局影响」行、applyOutcome 的 flag 落地都读它，所以文案与真实规则同源。
     · 放水给顾曼（牌局注码顶档）→ 她反而欣赏你（她胡 / 她赢 / 你小输）
     · 放水给金老板 → 他把你当自己人（同上）
     · 认真赢太狠（净胜 > 2×注码）→ 结梁子；其余按角色给一段结语 ═════════════════════════ */
  var CONSEQ_ROLE = { man: "a", jin: "t" };
  function conseqOf(ev, invite) {
    var out = [], id, cname, gentle, soft, rival;
    if (!ev || !invite || invite.pureBond) return out;
    id = invite.id; cname = invite.cname || invite.name || id;
    gentle = ev.style === "gentle";
    /* 「她/他看到了你让的那一手」：流局不算（只写一条中性结语，不落 flag） */
    soft = !ev.draw && !ev.win && (ev.npcWon || ev.net < 0);
    if (ev.draw) {
      return [{ kind: "陪", role: id === "man" ? "gu" : (id === "jin" ? "jin" : "other"), cname: cname, id: id, flag: "",
        text: cname + "：「这局谁也没成——再来一圈？」" }];
    }
    if (id === "man") {
      out.push(gentle && soft
        ? { kind: "赏识", role: "gu", cname: cname, id: id, flag: "顾曼的赏识", text: "顾曼：「你明明能赢，却把牌留给了我。」" }
        : { kind: "赏识", role: "gu", cname: cname, id: id, flag: "", text: "顾曼：「这一桌，你打得很认真——我记下了。」" });
    } else if (id === "jin") {
      out.push(gentle && soft
        ? { kind: "信任", role: "jin", cname: cname, id: id, flag: "金老板的信任", text: "金老板：「小陈，你这人——够意思。」" }
        : { kind: "信任", role: "jin", cname: cname, id: id, flag: "", text: "金老板：「牌品见人品。这一局，我看清楚了。」" });
    } else {
      out.push(gentle
        ? { kind: "赏识", role: "other", cname: cname, id: id, flag: "", text: cname + "：「跟你打牌，是这几天最放松的时候。」" }
        : (ev.win
          ? { kind: "信任", role: "other", cname: cname, id: id, flag: "", text: cname + "：「行啊，手气不错。」" }
          : { kind: "信任", role: "other", cname: cname, id: id, flag: "", text: cname + "：「没事，下把赢回来。」" }));
    }
    rival = ev.style === "serious" && ev.winTooMuch;
    if (rival) out.push({ kind: "结梁子", role: "riv", cname: cname, id: id, flag: "牌桌结梁子：" + cname, text: cname + "：「你今天……赢得很不留情。」" });
    return out;
  }
  /** 牌局后果 → 三条 flag（顾曼的赏识 / 金老板的信任 / 牌桌结梁子：<角色>）；纯函数，单测直接用 */
  function consequenceFlags(ev, invite) {
    var c = conseqOf(ev, invite), f = [], i;
    for (i = 0; i < c.length; i++) if (c[i].flag) f.push(c[i].flag);
    return f;
  }
  /** 找到本局对应角色的那条「事件」（本局影响文案 / 结算台词查找用） */
  function consequenceRoleOf(ev, invite) {
    var c = conseqOf(ev, invite), i;
    for (i = 0; i < c.length; i++) if (c[i].role === "gu" || c[i].role === "jin") return c[i];
    return c.length ? c[0] : null;
  }
  /* 情报前缀 → 角色 id（「本局影响」行里反查角色用；也可被 UI 复用） */
  var INTEL_ID_BY_NAME = (function () {
    var m = {}, k;
    for (k in INTEL_BY_ID) if (Object.prototype.hasOwnProperty.call(INTEL_BY_ID, k)) m[INTEL_BY_ID[k]] = k;
    return m;
  })();
  function inviteIdByIntel(name) { return INTEL_ID_BY_NAME[name] || null; }
  /**
   * 结算亮牌板的「本局影响」行（纯函数，唯一实现）：
   *   放水陪玩 · 顾曼好感 +3 · 已获得可用的把柄
   *   认真打满 · 顾曼好感 −3 · 牌桌结梁子：顾曼
   *   放水陪玩 · 顾曼好感 +6 · 她看到了你想让她看到的东西
   * 结构：{ text, label, kind, parts:[...], bond:{name,delta}, flag, note }
   * parts 由调用方（applyOutcome）填好「本局真实变化」，所以面板与落地永远一致。
   */
  var STYLE_TAG = { gentle: "放水陪玩", serious: "认真打满" };
  function impactInfo(ev, invite, parts) {
    var role, flagTxt = "", note, label;
    if (!ev || !invite) return null;
    if (invite.pureBond) {
      note = invite.settle || (invite.name + "：「今天这样就很好。」");
      return { text: [STYLE_TAG[ev.style] || ev.style].concat([note]).join(" · "),
        label: STYLE_TAG[ev.style] || ev.style, kind: "陪", parts: parts || [], flag: "", note: note };
    }
    role = consequenceRoleOf(ev, invite);
    label = STYLE_TAG[ev.style] || ev.style;
    if (role && role.flag) {
      flagTxt = "已获得可用的把柄";
    } else if (ev.style === "gentle" && role) {
      flagTxt = "她看到了你想让她看到的东西";
    } else if (ev.style === "serious" && ev.winTooMuch) {
      flagTxt = "牌桌结梁子：" + (invite.cname || invite.name);
    } else if (role && role.kind === "信任") {
      flagTxt = "他记住了这一局";
    } else {
      flagTxt = "——";
    }
    note = (role && role.text) || invite.settle || "";
    return {
      text: [label].concat(parts || []).concat([flagTxt]).join(" · "),
      label: label, kind: role ? role.kind : "", parts: parts || [],
      bond: null, flag: (role && role.flag) || "", note: note
    };
  }
  /** 只出文案（单测 / 面板都走它，保证同源） */
  function impactText(ev, invite, parts) { var o = impactInfo(ev, invite, parts); return o ? o.text : ""; }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function styleOf(s) { return STYLE_DEF[s] ? s : "serious"; }
  function styleName(s) { return STYLE_DEF[styleOf(s)].name; }
  function styleDef(s) { return STYLE_DEF[styleOf(s)]; }
  function stakeOf(v) { var n = +v; return n > 0 && isFinite(n) ? n : STAKE_DEFAULT; }
  function repClamp(v) { return Math.max(REP_MIN, Math.min(REP_MAX, Math.round(+v || 0))); }
  /** 座位 → 情报名；未配置返回 null（不硬塞未定义的线索） */
  function intelOfSeat(seat) { return INTEL_BY_ID[SEAT_IDS[seat]] || null; }
  function intelById(id) { return INTEL_BY_ID[id] || null; }
  /** 三档注码的档位信息（给开局面板用；财富不足的档位仍然列出，只是置灰） */
  function stakeTierList(cash) {
    var out = [], i, st;
    for (i = 0; i < STAKE_TIERS.length; i++) {
      st = STAKE_TIERS[i];
      out.push({
        stake: st, tiles: TIER.small.tiles, per: st * TIER.small.tiles,
        total: st * TIER.small.tiles * 3, cash: +cash || 0,
        ok: (+cash || 0) >= st,
        reason: (+cash || 0) >= st ? "" : ("财富不足（需要 ¥" + st + "，当前 ¥" + (+cash || 0) + "）")
      });
    }
    return out;
  }
  /** 邀约候选上下文：章节（state.ch / ctx.ch）/ 当前时段 / 现金 —— 缺省从 state 兜，保持旧调用可用 */
  function inviteCtx(state, now, ctx) {
    state = state || {}; ctx = ctx || {};
    var ch = ctx.ch !== undefined && ctx.ch !== null ? +ctx.ch : (state.ch !== undefined && state.ch !== null ? +state.ch : null);
    return {
      ch: (isNum(ch) ? ch : null),
      per: ctx.per !== undefined && ctx.per !== null ? +ctx.per : state.per,
      cash: ctx.cash !== undefined && ctx.cash !== null ? +ctx.cash : ((state.stats && state.stats.cash) || 0),
      now: now !== undefined && now !== null ? +now : Date.now()
    };
  }
  /** 取该角色「合格」的羁绊条件（阈值达标且 pri 最高那条）；不合格返回 null */
  function bondMatchOf(d, bonds) {
    var list = d.bonds && d.bonds.length ? d.bonds : [{ key: d.bond, min: d.min, pri: 0, gain: null }];
    var best = null, i, b, v;
    for (i = 0; i < list.length; i++) {
      b = list[i];
      v = +bonds[b.key] || 0;
      if (v < (+b.min || 0)) continue;
      if (!best || (+b.pri || 0) > (+best.pri || 0)) best = b;
    }
    return best;
  }
  /**
   * 邀约候选（纯函数）：state 传 S 本身即可（只读 bonds / per / ch / stats.cash / mjInvites）。
   * 规则：章节达标 + 羁绊达标 + 时段匹配 + 未接受过；「改天」后 20 分钟内不再出现。
   * 优先级（同一次只弹一条，由调用方取 out[0]）：章节 > 羁绊高（收益优先级 pri，再比实际羁绊值）> 时段匹配。
   * 同一「时段槽位」（slot）里只保留优先级最高的那一条：同一次不会既是雷姐又是白露。
   * ctx（可选）：{ ch 当前章节, per 时段, cash 财富 } —— 不传则从 state 里读。
   */
  function inviteList(state, now, ctx) {
    state = state || {};
    var bonds = state.bonds || {}, seen = state.mjInvites || {};
    var C = inviteCtx(state, now, ctx);
    var t = C.now, out = [], i, d, rec, mode, at, m, cap, ok, slotBest = {};
    for (i = 0; i < INVITE_DEF.length; i++) {
      d = INVITE_DEF[i];
      rec = seen[d.id];
      mode = rec && typeof rec === "object" ? String(rec.mode || "") : (rec ? "declined" : "");
      at = rec && typeof rec === "object" ? (+rec.t || 0) : (+rec || 0);
      if (mode === "accepted") continue;                                   // 本轮人生里接受过 → 不再弹
      if (mode === "declined" && t - at < INVITE_COOLDOWN_MS) continue;    // 冷却中
      if (d.ch !== null && d.ch !== undefined && (C.ch === null || C.ch < +d.ch)) continue;   // 章节未到 / 已过
      m = bondMatchOf(d, bonds);
      if (!m) continue;                                                    // 羁绊不达标
      if (d.per !== null && d.per !== undefined && +C.per !== d.per) continue;   // 时段不匹配
      cap = Math.max(0, Math.min(1, Math.min(+C.cash || 0, +d.stake) / (+d.stake || 1)));   // 情义折算系数（不破产的高兴程度）
      ok = (+C.cash || 0) >= d.stake;
      var bv = +bonds[m.key] || 0, bmin = +m.min || 0;
      out.push({
        id: d.id, name: d.name, cname: d.cname || d.name, seat: d.seat, bond: m.key, bondKey: m.key, stake: d.stake,
        pureBond: !!d.pureBond, min: bmin, pri: +m.pri || 0, bondValue: bv,
        bondRank: bmin > 0 ? bv / bmin : bv,                                // 羁绊优先级：实际值 ÷ 触发阈值
        ch: d.ch === undefined ? null : d.ch, where: d.where, msg: d.msg || "来打两圈？",
        openLine: d.openLine || "", settle: d.settle || "", intel: d.intel || null, note: d.note || "也许能问出点什么",
        gain: (m && m.gain) ? assign({}, m.gain) : {},
        cap: ok ? cap : 0,
        perMatch: (d.per === null || d.per === undefined) ? 0 : 1,
        slot: d.id === "lei" || d.id === "lu" ? "night-lei-lu" : d.id,
        order: i,
        ok: ok, reason: ok ? "" : ("财富不足（需要 ¥" + d.stake + "，当前 ¥" + C.cash + "）")
      });
    }
    /* ── 优先级排序（同一次只弹一条，由 pickInvite 取 out[0]）──────────────────
       规格（父 agent 精确定义）：
         ① 章节匹配（invite.ch === 当前章节）最高；
         ② ch:null = 通用兜底（任何章节都可用，但排在「本章专属」之后）；
         ③ 同档内：羁绊值高者先（先比收益优先级 pri，再比实际羁绊值）；
         ④ 仍相同：时段匹配（该角色限定时段命中）者先；
         ⑤ 最后：表中声明顺序（稳定，保证确定性）。
       例：当前章节 2 → 顾曼(ch:2) 第一；当前章节 3 → 本章无专属角色，通用角色（红姐/陈果）先于
       已过章的顾曼；当前章节 2 → 新增的 5 位（ch:2）优先于通用角色。 */
    function rankOf(C, d) {
      return C.ch !== null && d.ch !== null && d.ch !== undefined && +C.ch === +d.ch ? 1 : 0;
    }
    function unboundedOf(d) { return d.ch === null || d.ch === undefined ? 1 : 0; }
    out.sort(function (a, b) {
      var ar = rankOf(C, INVITE_DEF[a.order]), br = rankOf(C, INVITE_DEF[b.order]);
      if (ar !== br) return br - ar;                                     // ① 章节匹配优先
      var au = unboundedOf(INVITE_DEF[a.order]), bu = unboundedOf(INVITE_DEF[b.order]);
      if (au !== bu) return bu - au;                                     // ② 通用兜底次之
      if (a.pri !== b.pri) return b.pri - a.pri;                         // ③ 收益优先级
      if (a.bondRank !== b.bondRank) return b.bondRank - a.bondRank;     // ③ 羁绊（实际 ÷ 阈值）
      if (a.bondValue !== b.bondValue) return b.bondValue - a.bondValue; // ③ 羁绊实际值
      if (a.perMatch !== b.perMatch) return b.perMatch - a.perMatch;     // ④ 时段匹配
      return a.order - b.order;                                          // ⑤ 声明顺序
    });
    /* 同一槽位只留一条（不重复骚扰同一个「场子」） */
    var filtered = [], j, sl;
    for (i = 0; i < out.length; i++) {
      sl = out[i].slot;
      if (slotBest[sl]) continue;
      slotBest[sl] = 1; filtered.push(out[i]);
    }
    for (i = 0; i < filtered.length; i++) {
      j = INVITE_TRIGGER_ORDER.indexOf(filtered[i].id);
      filtered[i].rank = i + 1;
      filtered[i].priority = j < 0 ? 99 : j;
    }
    return filtered;
  }
  /** 同一次只弹一条：取优先级最高的那条邀约（页面回到沙盘时调用） */
  function pickInvite(state, now, ctx) { var l = inviteList(state, now, ctx); return l.length ? l[0] : null; }
  /** 单测 / 面板用：一条邀约的「本局可能获得」可见文案（情报名不剧透） */
  function inviteGainText(inv) {
    if (!inv) return "";
    var g = inv.gain || {}, parts = [], k, nm = { cash: "财富", cha: "魅力", phy: "体魄", int: "智慧", spi: "精神" };
    for (k in g) if (Object.prototype.hasOwnProperty.call(g, k) && g[k]) parts.push((nm[k] || k) + " +" + g[k]);
    var head = inv.pureBond ? ("羁绊 +4（本局不输赢财富）") : (parts.join(" · ") || "陪她打两圈");
    return head + " · " + (inv.note || "也许能问出点什么");
  }
  /** 把一场牌局压成「发生了什么」（纯函数）：后续口碑 / 羁绊 / 情报 / 成就都基于它 */
  function eventsOf(res, style) {
    res = res || {};
    var ev = {};
    ev.draw = !!res.draw;
    ev.win = res.win === true;                                  // 玩家（座位 0）胡牌
    ev.seat = typeof res.seat === "number" ? res.seat : -1;
    ev.style = styleOf(res.style || style);
    ev.stake = stakeOf(res.stake);
    ev.net = +res.netCash || 0;                                 // 你的净收支（已按注码换算）
    ev.per = +res.payPerHouse || 0;
    ev.totalWin = +res.totalWin || 0;
    ev.tier = res.tier || "";
    ev.tierName = res.tierName || (ev.draw ? "流局" : "");
    ev.tiles = +res.tiles || (TIER[ev.tier] ? TIER[ev.tier].tiles : 0);
    ev.robKong = !!res.robKong;
    ev.kongDraw = !!res.kongDraw;
    ev.payerOnly = !!res.payerOnly;
    ev.payerSeat = typeof res.from === "number" ? res.from : -1;
    ev.playerRobbed = !!(ev.payerOnly && ev.payerSeat === 0);   // 你杠 → 被抢 → 包赔三家
    ev.playerRobKong = !!(ev.robKong && ev.win);
    ev.npcWon = !ev.win && !ev.draw;
    ev.npcSeat = ev.npcWon ? ev.seat : -1;
    ev.winTooMuch = !!(ev.win && ev.net > 2 * ev.stake);        // 认真模式下「赢太多」
    ev.loseBig = !!(!ev.win && !ev.draw && ev.net <= -2 * ev.stake);
    return ev;
  }
  function streakAfter(prev, ev) { return ev.win ? ((+prev || 0) + 1) : 0; }
  /** 牌友口碑增减规则（纯函数，逐条对应验收要求：连胡 / 被抢杠 / 包赔 / 放水 / 认真赢太多） */
  function repDeltaOf(ev, streak) {
    var d = 0;
    if (ev.win) d += 3;                                          // 胡牌 +3
    if ((+streak || 0) >= 3) d += 4;                             // 三连胡 +4
    if (ev.playerRobbed) d -= 5;                                 // 杠被抢、包赔三家 −5
    if (ev.playerRobKong) d += 2;                                // 抢杠胡成功 +2
    if (ev.kongDraw) d += 1;                                     // 杠上开花 +1
    if (ev.style === "gentle") d -= 2;                           // 放水 −2
    if (ev.style === "serious" && ev.winTooMuch) d += 3;         // 认真且赢太多 +3
    if (ev.loseBig) d -= 1;                                      // 单局大亏 −1
    return d;
  }
  /**
   * 羁绊增减（纯函数）：只有「邀约局」才动羁绊。
   * 认真：赢太多 −2~−4（赢得越狠扣得越多）；小赢 +1；输 −1；流局 0
   * 放水：+3（对家胡 +6）；妹妹局（pureBond）恒定 +4
   */
  function bondDeltaOf(ev, invite) {
    if (!invite) return 0;
    if (invite.pureBond) return 4;
    if (ev.style === "gentle") return (invite.seat >= 0 && ev.npcSeat === invite.seat) ? 6 : 3;
    if (ev.winTooMuch) {
      var over = Math.floor((ev.net - 2 * ev.stake) / (2 * ev.stake));
      return -(2 + Math.max(0, Math.min(2, over)));
    }
    if (ev.draw) return 0;
    return ev.win ? 1 : -1;
  }
  /** 牌桌情报：① 邀约局 → 该角色专属情报（赢了就有）；② 赢下这一桌 → 三家对手的线索；③ 放水让对方胡 → 对方那条线索 */
  function intelUnlocked(ev, invite) {
    var out = [], i, push, d;
    push = function (v) { if (v && out.indexOf(v) < 0) out.push(v); };
    if (invite) {
      d = invite.intel ? invite : inviteDef(invite.id);            // 邀约对象可能只带 id（从 showInvite 回调回来）
      if (d && d.intel) push(d.intel);                             // 邀约局：该角色的专属情报
    }
    if (ev.win) {
      for (i = 1; i < SEAT_IDS.length; i++) push(intelOfSeat(i));  // 赢下这一桌 → 三家对手的线索
    } else if (ev.npcWon && ev.style === "gentle") {
      push(intelOfSeat(ev.npcSeat));                              // 放水到对家胡 → 对方那条线索
    }
    return out;
  }
  /** 成就（返回 id 数组；id 与 index.html 的 ACHV 表一致） */
  function achvOf(ev, streak) {
    var out = [];
    if (ev.win) out.push("mjWin");                               // 牌桌老千（保留）
    if ((+streak || 0) >= 3) out.push("mjStreak3");               // 三连胡
    if (ev.playerRobbed) out.push("mjPayer");                     // 包赔三家
    if (ev.loseBig) out.push("mjRival");                          // 冤家（单局输光所选注码）
    return out;
  }
  /** 空状态（state 缺字段时的兜底；也用于「预演」） */
  function blankState(state) {
    var s = state || {};
    return {
      stats: { cash: (s.stats && +s.stats.cash) || 0 },
      bonds: s.bonds || {},
      flags: s.flags ? s.flags.slice() : [],
      achv: s.achv ? s.achv.slice() : [],
      mjRep: isNum(s.mjRep) ? s.mjRep : REP_INIT,
      mjStreak: +s.mjStreak || 0,
      mjWins: +s.mjWins || 0, mjLosses: +s.mjLosses || 0, mjNet: +s.mjNet || 0
    };
  }
  /**
   * 结算落地（纯函数，唯一实现）：把牌局结果写进「S 形状」的状态对象，返回改动报告。
   * opts: { style, invite, applyCash(默认 true), countRecord(默认 true), now }
   * 返回：{ ev, cash:{before,delta,after,net}, rep:{before,delta,after}, bond, flags:[新增], achv:[新增],
   *         streak, lines:[面板文案], cashText, styleText, bondText, repText, intelText, achvText }
   * 说明：面板文案与状态改动同源，所以结算板上写的数字一定等于真正落地的数字。
   */
  function applyOutcome(state, res, opts) {
    opts = opts || {};
    var st = state || {};
    if (!st.stats) st.stats = { cash: 0 };
    if (!st.bonds) st.bonds = {};
    if (!st.flags) st.flags = [];
    if (!st.achv) st.achv = [];
    if (!isNum(st.mjRep)) st.mjRep = REP_INIT;
    var ev = eventsOf(res, opts.style);
    var prevStreak = +st.mjStreak || 0;
    var streak = streakAfter(prevStreak, ev);
    var repD = repDeltaOf(ev, streak);
    var repBefore = st.mjRep, repAfter = repClamp(repBefore + repD);
    var cashBefore = +st.stats.cash || 0;
    var net = ev.net;
    var cashAfter = (opts.applyCash === false) ? cashBefore : Math.max(0, cashBefore + net);
    var cashDelta = cashAfter - cashBefore;
    st.stats.cash = cashAfter;
    st.mjRep = repAfter;
    st.mjStreak = streak;
    if (opts.countRecord !== false) {
      if (ev.win) st.mjWins = (+st.mjWins || 0) + 1;
      else if (!ev.draw) st.mjLosses = (+st.mjLosses || 0) + 1;
      /* 剧情局（财富由节点奖励给）只计胜负、不计净收支，避免战绩与实际财富对不上 */
      if (opts.countNet !== false) st.mjNet = (+st.mjNet || 0) + net;
    }
    var bond = null;
    if (opts.invite) {
      var bid = opts.invite.bond;
      var bd = bondDeltaOf(ev, opts.invite);
      var bb = +st.bonds[bid] || 0;
      st.bonds[bid] = Math.max(0, bb + bd);
      bond = { id: bid, name: opts.invite.name || bid, delta: bd, before: bb, after: st.bonds[bid] };
    }
    var intel = intelUnlocked(ev, opts.invite), newFlags = [], i, f;
    for (i = 0; i < intel.length; i++) {
      f = intel[i];
      if (st.flags.indexOf(f) < 0) { st.flags.push(f); newFlags.push(f); }
    }
    /* ── 打法的剧情后果：放水/认真留下的 flag（顾曼的赏识 / 金老板的信任 / 牌桌结梁子：<角色>）── */
    var conseq = opts.invite ? conseqOf(ev, opts.invite) : [], conseqNew = [];
    for (i = 0; i < conseq.length; i++) {
      f = conseq[i].flag;
      if (!f) continue;
      if (st.flags.indexOf(f) < 0) { st.flags.push(f); newFlags.push(f); conseqNew.push(f); }
      else conseqNew.push(f);
    }
    var achv = achvOf(ev, streak), newAchv = [];
    for (i = 0; i < achv.length; i++) {
      f = achv[i];
      if (st.achv.indexOf(f) < 0) { st.achv.push(f); newAchv.push(f); }
    }
    var stake = ev.stake;
    var netTxt = net > 0 ? ("+¥" + net) : (net < 0 ? ("−¥" + Math.abs(net)) : "¥0");
    var cashText = ev.draw
      ? ("注码 ¥" + stake + " · 流局不结算（四家都没胡）")
      : ("注码 ¥" + stake + " · " + (ev.tierName || "") + " " + ev.tiles +
         " 张 → 每家 ¥" + ev.per + " · 胡家共收 ¥" + ev.totalWin + " · 你的净收支 " + netTxt +
         (ev.payerOnly && ev.payerSeat === 0 ? "（杠家包赔三家）" : ""));
    var styleText = "打法：" + styleName(ev.style) + (ev.style === "gentle" ? " · 智脑提示关闭" : " · 智脑提示全开");
    var repText = "牌友口碑 " + (repD >= 0 ? "+" : "−") + Math.abs(repD) + "（" + repBefore + " → " + repAfter + "）";
    var bondText = bond
      ? (bond.name + " 好感 " + (bond.delta >= 0 ? "+" : "−") + Math.abs(bond.delta) + "（" + bond.before + " → " + bond.after + "）")
      : "";
    var intelText = newFlags.length ? ("🀄 牌桌情报：" + newFlags.join(" / ")) : "";
    var achvNames = [];
    for (i = 0; i < newAchv.length; i++) achvNames.push(ACHV_NAME[newAchv[i]] || newAchv[i]);
    var achvText = newAchv.length ? ("🏆 本局成就：" + achvNames.join(" / ")) : "";
    /* ── 结算亮牌板的「本局影响」行（与上面的落地完全同源：数字都取自刚算出的真实变化）── */
    var impactParts = [];
    if (bond && bond.delta) impactParts.push(bond.name + "好感 " + (bond.delta > 0 ? "+" : "−") + Math.abs(bond.delta));
    if (repD) impactParts.push("口碑 " + (repD > 0 ? "+" : "−") + Math.abs(repD));
    var impact = opts.invite ? impactInfo(ev, opts.invite, impactParts) : null;
    var impactText = impact ? impact.text : "";
    var lines = [cashText, styleText];
    if (bondText) lines.push("（" + styleName(ev.style) + "陪玩）" + bondText);
    lines.push(repText);
    if (impactText) lines.push("本局影响：" + impactText);
    if (intelText) lines.push(intelText);
    if (achvText) lines.push(achvText);
    return {
      ev: ev, cash: { before: cashBefore, delta: cashDelta, net: net, after: cashAfter },
      rep: { before: repBefore, delta: repD, after: repAfter }, bond: bond,
      flags: newFlags, achv: newAchv, streak: streak, lines: lines,
      cashText: cashText, styleText: styleText, bondText: bondText, repText: repText,
      intelText: intelText, achvText: achvText,
      consequence: conseq, consequenceFlags: conseqNew, impact: impact, impactText: impactText,
      report: { stake: stake, style: ev.style, styleName: styleName(ev.style), net: net, per: ev.per, total: ev.totalWin,
                impactText: impactText, impactNote: impact ? impact.note : "" }
    };
  }
  /** 预演（不改真实状态）：结算面板先按它把「打法 / 羁绊 / 口碑 / 情报」写在亮牌板上 */
  function previewOutcome(state, res, opts) {
    var clone = blankState(state);
    if (state && state.bonds) { clone.bonds = {}; for (var k in state.bonds) clone.bonds[k] = state.bonds[k]; }
    return applyOutcome(clone, res, opts);
  }

  /** 牌墙：默认 136 张（含 28 张字牌）；createWall(false) → 旧 108 张 */
  function createWall(honors) {
    if (honors === undefined) honors = INCLUDE_HONORS;
    var d = [], si, n, k;
    for (si = 0; si < SUITS.length; si++)
      for (n = 1; n <= 9; n++)
        for (k = 0; k < 4; k++) d.push(n + SUITS[si]);
    if (honors) for (si = 0; si < HONORS.length; si++) for (k = 0; k < 4; k++) d.push(HONORS[si]);
    return d;
  }
  function shuffle(a) {
    var i, j, t;
    for (i = a.length - 1; i > 0; i--) { j = Math.floor(Math.random() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function suitOf(t) { return t.slice(1); }
  function numOf(t) { return +t.charAt(0); }
  function cmpTile(a, b) {
    var ga = tileGroup(a), gb = tileGroup(b), d = ga - gb;         // 先按花色（万→条→筒→字）分组
    if (d !== 0) return d;
    if (ga === SUITS.length) return honorIdx(a) - honorIdx(b);     // 字牌：东南西北中發白
    return numOf(a) - numOf(b);                                    // 序数牌：数字升序
  }
  function sortTiles(a) { return a.slice().sort(cmpTile); }
  function counts(tiles) {
    var c = Object.create(null), i;
    for (i = 0; i < tiles.length; i++) c[tiles[i]] = (c[tiles[i]] || 0) + 1;
    return c;
  }
  function countIn(hand, t) { var n = 0, i; for (i = 0; i < hand.length; i++) if (hand[i] === t) n++; return n; }
  /** 去掉 n 张 t（可重复牌），不够返回 null */
  function removeN(hand, t, n) {
    if (countIn(hand, t) < n) return null;
    var out = hand.slice(), i, k = 0;
    for (i = out.length - 1; i >= 0 && k < n; i--) if (out[i] === t) { out.splice(i, 1); k++; }
    return out;
  }
  function removeOne(hand, t) { return removeN(hand, t, 1); }
  function uniqTiles(hand) { var c = counts(hand), k = Object.keys(c); return sortTiles(k); }

  /**
   * 手牌整理（只影响「摆放 / 展示」，不改任何规则）：
   *   1) 暗手按「花色 万 → 条 → 筒，同花色数字从小到大」排序
   *   2) 刚摸到的那张（p.drawn）不参与排序，固定留在手牌最右侧（下次摸牌/打出后才并入）
   *   3) 副露组内按牌面排序；组与组之间也按牌面（万<条<筒、数字升序）固定先后
   *   每次摸牌 / 出牌 / 碰 / 杠 / 抢杠后调用，保证手牌随时都是整齐的。
   */
  function normalizeHand(p) {
    if (!p || !p.hand) return p;
    var core = p.hand.slice(), i, k = -1;
    if (p.drawn !== null && p.drawn !== undefined) {
      for (i = core.length - 1; i >= 0; i--) if (core[i] === p.drawn) { k = i; break; }
      if (k >= 0) core.splice(k, 1);        // 摸到的先抽出来，不参与排序
      else p.drawn = null;                  // 摸的牌已经不在手里（被杠掉 / 打出）
    }
    p.hand = sortTiles(core);
    if (k >= 0) p.hand.push(p.drawn);       // 摸到的那张固定在最右
    if (p.melds && p.melds.length) {
      for (i = 0; i < p.melds.length; i++) {
        if (p.melds[i] && p.melds[i].tiles) p.melds[i].tiles = sortTiles(p.melds[i].tiles);
      }
      if (p.melds.length > 1) {
        p.melds.sort(function (a, b) { return cmpTile(a.tiles[0], b.tiles[0]); });
      }
    }
    return p;
  }
  /** 手牌是否已按规则排好（摸到的牌除外）—— 渲染与自测共用 */
  function handIsSorted(p) {
    if (!p || !p.hand) return true;
    var n = p.hand.length, core = n, i;
    if (p.drawn !== null && p.drawn !== undefined && n > 0 && p.hand[n - 1] === p.drawn) core = n - 1;
    for (i = 1; i < core; i++) if (cmpTile(p.hand[i - 1], p.hand[i]) > 0) return false;
    return true;
  }
  /** 副露是否已按固定顺序（组内 + 组间）排好 */
  function meldsAreSorted(p) {
    if (!p || !p.melds || !p.melds.length) return true;
    var i, j;
    for (i = 0; i < p.melds.length; i++) {
      var t = p.melds[i].tiles;
      for (j = 1; j < t.length; j++) if (cmpTile(t[j - 1], t[j]) > 0) return false;
      if (i > 0 && cmpTile(p.melds[i - 1].tiles[0], p.melds[i].tiles[0]) > 0) return false;
    }
    return true;
  }

  /** 递归拆面子：每一步只需尝试当前最小的那张牌（它必须被用掉） */
  function decomposeMelds(c, need) {
    var keys = Object.keys(c).sort(cmpTile), k, i, n, k2, k3, nc, num, suit;
    for (i = 0; i < keys.length; i++) if (c[keys[i]] > 0) { k = keys[i]; break; }
    if (k === undefined) return need === 0;
    if (need === 0) return false;
    if (c[k] >= 3) {                                   // 刻子
      nc = assign({}, c); nc[k] -= 3; if (nc[k] === 0) delete nc[k];
      if (decomposeMelds(nc, need - 1)) return true;
    }
    suit = suitOf(k); num = numOf(k);                  // 顺子（牌面格式：数字在前、花色在后）
    if (!isHonor(k) && num <= 7) {                     // 字牌永远不能组顺子
      k2 = (num + 1) + suit; k3 = (num + 2) + suit;
      if (c[k2] > 0 && c[k3] > 0) {
        nc = assign({}, c);
        nc[k]--; nc[k2]--; nc[k3]--;
        if (nc[k] === 0) delete nc[k];
        if (nc[k2] === 0) delete nc[k2];
        if (nc[k3] === 0) delete nc[k3];
        if (decomposeMelds(nc, need - 1)) return true;
      }
    }
    return false;
  }

  /** 标准型（含副露）是否成牌：暗手 + 3×副露 共 14 张、恰好一对将 + 面子 */
  function isStandardWin(concealed, meldCount) {
    concealed = concealed || []; meldCount = meldCount || 0;
    if (concealed.length + meldCount * 3 !== 14) return false;
    var need = (concealed.length - 2) / 3;
    if (need < 0) return false;
    var c = counts(concealed), keys = Object.keys(c), i, k, nc;
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      if (c[k] >= 2) {
        nc = assign({}, c); nc[k] -= 2; if (nc[k] === 0) delete nc[k];
        if (decomposeMelds(nc, need)) return true;
      }
    }
    return false;
  }
  /** 七对（无副露、14 张、每种偶数张） */
  function isSevenPairs(concealed) {
    if (!concealed || concealed.length !== 14) return false;
    var c = counts(concealed), keys = Object.keys(c), i;
    for (i = 0; i < keys.length; i++) if (c[keys[i]] % 2 !== 0) return false;
    return true;
  }
  /** 龙七对：七对中有一个是 4 张（暗杠） */
  function isDragonSevenPairs(concealed) {
    if (!isSevenPairs(concealed)) return false;
    var c = counts(concealed), keys = Object.keys(c), i;
    for (i = 0; i < keys.length; i++) if (c[keys[i]] === 4) return true;
    return false;
  }
  /** 碰碰胡：副露全是刻/杠，暗手全刻子 + 一对将 */
  function isAllTriplets(concealed, melds) {
    melds = melds || [];
    var i, m;
    for (i = 0; i < melds.length; i++) {
      m = melds[i];
      if (m.type !== "peng" && m.type !== "gang") return false;
    }
    if (concealed.length !== 14 - melds.length * 3) return false;
    var c = counts(concealed), keys = Object.keys(c), triplets = 0, pairs = 0;
    for (i = 0; i < keys.length; i++) {
      if (c[keys[i]] === 3) triplets++;
      else if (c[keys[i]] === 2) pairs++;
      else return false;
    }
    return pairs === 1 && triplets + melds.length === 4;
  }

  /**
   * 牌型判定（纯函数）。返回 null 或 { tier, name, seven, dragon, bigHand }
   * 优先级：龙七对 > 七对 > 大吊车 > 大胡(碰碰胡) > 小胡
   */
  function evaluate(concealed, melds) {
    concealed = concealed || []; melds = melds || [];
    var n = concealed.length, m = melds.length;
    if (n + m * 3 !== 14) return null;
    if (m === 0 && isSevenPairs(concealed)) {
      var dragon = isDragonSevenPairs(concealed);
      return { tier: dragon ? "biggest" : "bigger", name: dragon ? "七对 · 龙七对" : "七对", seven: true, dragon: dragon };
    }
    if (!isStandardWin(concealed, m)) return null;
    if (n === 2 && m === 4) return { tier: "bigger", name: "大吊车", bigHand: true };
    if (isAllTriplets(concealed, melds)) return { tier: "big", name: "碰碰胡" };
    return { tier: "small", name: "小胡" };
  }

  /**
   * 赔付（纯函数）
   * ctx: { kongDraw:bool, robKong:bool, stake:number }
   * 返回 { tier, tierName, tiles, per, total, fan, fanName, kongDraw, robKong, payerOnly }
   */
  function scoreOf(baseTier, ctx) {
    ctx = ctx || {};
    var stake = ctx.stake || STAKE_DEFAULT;
    var t = TIER[baseTier] || TIER.small;
    var tier = t.key, tiles = t.tiles, note = [];
    if (ctx.kongDraw) {
      note.push("杠开");
      if (t.key === "small") { tier = "big"; tiles = TIER.big.tiles; }   // 杠开：小胡升大胡
      else tiles = t.tiles * 2;                                          // 其余翻两倍
    }
    if (ctx.robKong) note.push("抢杠");
    var per = tiles * stake;                                             // 每家赔付
    var total = per * 3;                                                 // 三家合计
    var fan = tiles / 2;                                                 // 倍数（小胡基准 = 2 张/家 = 1）
    var tname = TIER[tier].name;
    return {
      tier: tier, tierName: tname, tiles: tiles, per: per, total: total,
      fan: fan, fanName: tname + (note.length ? " · " + note.join(" · ") : ""),
      kongDraw: !!ctx.kongDraw, robKong: !!ctx.robKong, payerOnly: !!ctx.robKong, stake: stake
    };
  }

  /** 听牌：返回能成牌的所有牌（hand 需为 13-3m 张）；honors=true 时连字牌一起试 */
  function waitsFor(concealed, melds, honors) {
    concealed = concealed || []; melds = melds || [];
    var out = [], i, t, used, j, kinds = kindsFor(honors);
    if ((concealed.length + melds.length * 3) % 3 !== 1) return out;
    for (i = 0; i < kinds.length; i++) {
      t = kinds[i];
      used = countIn(concealed, t);
      for (j = 0; j < melds.length; j++) used += countIn(melds[j].tiles, t);
      if (used >= 4) continue;
      if (evaluate(concealed.concat([t]), melds)) out.push(t);
    }
    return out;
  }
  function isTenpai(concealed, melds, honors) { return waitsFor(concealed, melds, honors).length > 0; }
  /** 抢杠胡判定（能被抢的杠种类） */
  function canRobKong(kind) { return KONG_ROBBABLE[kind] === true; }

  /* ═══════════════ 2. 向听数与 AI（纯函数） ═══════════════ */

  /**
   * 标准型向听数（含副露 meldCount 组）。
   * 模型：M 组面子、T 组搭子、P 组将，M+T ≤ 4；
   *       剩牌 L = 手牌数 - 3·Mc - 2·T - 2·P（Mc 为暗手内面子数）。
   *       need = T'(成搭子各补 1) + seeds·2 + (余位)·3 + 将牌差额
   *       shanten = need - 1
   */
  function stdShanten(hand, meldCount) {
    meldCount = meldCount || 0;
    var N = KINDS_ALL.length, c = new Array(N), i;         // 27 序数牌 + 7 字牌（无字牌时恒为 0）
    for (i = 0; i < N; i++) c[i] = 0;
    for (i = 0; i < hand.length; i++) c[KIDX[hand[i]]]++;
    var total = hand.length, best = 8;
    function leaf(Mc, T, P) {
      var M = Mc + meldCount;
      if (M > 4) return;
      var L = total - 3 * Mc - 2 * T - 2 * P;
      if (L < 0) return;
      var slots = 4 - M;
      var Tp = Math.min(T, slots);
      var slotsLeft = slots - Tp;
      var pairSeed = P ? 0 : (L >= 1 ? 1 : 0);
      var L2 = L - pairSeed;
      var seeds = Math.min(slotsLeft, L2);
      var need = Tp * 1 + seeds * 2 + (slotsLeft - seeds) * 3 + (P ? 0 : (pairSeed ? 1 : 2));
      var s = need - 1;
      if (s < best) best = s;
    }
    function rec(i, Mc, T, P) {
      if (Mc + meldCount + T > 4) return;
      if (i >= N) { leaf(Mc, T, P); return; }
      var num = i < KINDS.length ? (i % 9) + 1 : 0;   // 字牌 num=0 → 所有顺子分支自动跳过
      if (c[i] >= 3) { c[i] -= 3; rec(i, Mc + 1, T, P); c[i] += 3; }                       // 刻子
      if (num > 0 && num <= 7 && c[i] && c[i + 1] && c[i + 2]) {                            // 顺子（字牌不进）
        c[i]--; c[i + 1]--; c[i + 2]--; rec(i, Mc + 1, T, P); c[i]++; c[i + 1]++; c[i + 2]++;
      }
      if (c[i] >= 2) { c[i] -= 2; rec(i, Mc, T + 1, P); c[i] += 2; }                        // 对子（当搭子）
      if (c[i] >= 2 && !P) { c[i] -= 2; rec(i, Mc, T, 1); c[i] += 2; }                       // 对子（当将）
      if (num > 0 && num <= 8 && c[i] && c[i + 1]) { c[i]--; c[i + 1]--; rec(i, Mc, T + 1, P); c[i]++; c[i + 1]++; }  // 两面/边张（字牌不进）
      if (num > 0 && num <= 7 && c[i] && c[i + 2]) { c[i]--; c[i + 2]--; rec(i, Mc, T + 1, P); c[i]++; c[i + 2]++; }  // 坎张（字牌不进）
      rec(i + 1, Mc, T, P);                                                                  // 弃掉这一种
    }
    rec(0, 0, 0, 0);
    return best;
  }
  /** 七对向听（仅无副露时） */
  function sevenPairsShanten(hand) {
    if (hand.length !== 13 && hand.length !== 14) return 99;
    var c = counts(hand), keys = Object.keys(c), pairs = 0, kinds = keys.length, i;
    for (i = 0; i < keys.length; i++) if (c[keys[i]] >= 2) pairs++;
    return 6 - pairs + Math.max(0, 7 - kinds);
  }
  /** 任意手牌（3k+1 或 3k+2 张）的最佳向听 */
  function bestShanten(hand, meldCount) {
    meldCount = meldCount || 0;
    var best = stdShanten(hand, meldCount);
    if (meldCount === 0) {
      if (hand.length % 3 === 1) best = Math.min(best, sevenPairsShanten(hand));
      else {
        var uniq = uniqTiles(hand), i, r;
        for (i = 0; i < uniq.length; i++) {
          r = removeOne(hand, uniq[i]);
          best = Math.min(best, stdShanten(r, 0), sevenPairsShanten(r));
        }
      }
    }
    if (hand.length % 3 === 2) {
      var u2 = uniqTiles(hand), j, r2;
      for (j = 0; j < u2.length; j++) { r2 = removeOne(hand, u2[j]); best = Math.min(best, stdShanten(r2, meldCount)); }
    }
    return best;
  }

  /** 孤张度：越小越孤（越该打） */
  function isolation(hand, t) {
    var s = suitOf(t), n = numOf(t), w = 0, i, u, d;
    if (isHonor(t)) return 3 * countIn(hand, t);        // 字牌只与同种牌成对/刻
    for (i = 0; i < hand.length; i++) {
      u = hand[i];
      if (u === t) { w += 3; continue; }
      if (isHonor(u) || suitOf(u) !== s) continue;
      d = Math.abs(numOf(u) - n);
      if (d === 1) w += 2;
      else if (d === 2) w += 0.9;
    }
    return w;
  }
  function termScore(t) { if (isHonor(t)) return 1; var n = numOf(t); return n <= 2 || n >= 8 ? 0 : 1; }  // 幺九次优先打

  /**
   * AI 出牌：孤张优先；已听牌时优先打安全张（别人打过的），且不破坏听牌
   * seen: { tile: 张数 } 其他三家已打出的牌
   */
  function aiDiscard(hand, melds, seen, honors) {
    seen = seen || {};
    melds = melds || [];
    var tenpai = isTenpai(hand, melds, honors);
    var uniq = uniqTiles(hand), i, t, rest, opts = [];
    for (i = 0; i < uniq.length; i++) {
      t = uniq[i];
      rest = removeOne(hand, t);
      opts.push({
        tile: t,
        keepTenpai: waitsFor(rest, melds, honors).length > 0,
        shanten: stdShanten(rest, melds.length),
        safe: seen[t] || 0,
        iso: isolation(hand, t),
        term: termScore(t)
      });
    }
    if (tenpai) {
      var keep = [], j;
      for (j = 0; j < opts.length; j++) if (opts[j].keepTenpai) keep.push(opts[j]);
      if (keep.length) opts = keep;
    }
    opts.sort(function (a, b) {
      if (tenpai && b.safe !== a.safe) return b.safe - a.safe;      // 听牌 → 安全张
      if (a.shanten !== b.shanten) return a.shanten - b.shanten;    // 向听优先
      if (a.iso !== b.iso) return a.iso - b.iso;                    // 孤张优先
      return a.term - b.term;
    });
    return opts.length ? opts[0].tile : hand[0];
  }

  /** 碰：不破坏顺子结构（向听数不变差）才碰 */
  function aiWantPeng(hand, melds, tile) {    melds = melds || [];
    var cur = stdShanten(hand, melds.length);
    var rest = removeN(hand, tile, 2);
    if (rest === null) return false;
    var after = bestShanten(rest, melds.length + 1);   // 碰后还要打一张
    return after <= cur;
  }
  /** 碰/杠的响应决策：能杠则杠（直杠），否则按 aiWantPeng */
  function aiWantClaim(p, pend) {
    if (pend.actions.indexOf("gang") >= 0) return "gang";
    if (pend.actions.indexOf("peng") >= 0) return aiWantPeng(p.hand, p.melds, pend.tile) ? "peng" : "pass";
    return "pass";
  }

  /**
   * 放水出牌（纯函数）：故意给出「次优解」——同样不让自己变远（向听不变差），
   * 但优先打掉有效进张最少的那张（拆搭 / 打孤张的温和版），把赢面让出去。
   * 只在「打法 = 放水」时使用：人类挂机自动出牌、以及放水局里被 AI 接管时的兜底。
   * 返回：{ tile, shanten, ukeire, best:{tile,ukeire}, same:bool }（便于单测核对「确实不是最优解」）
   */
  function gentleCalc(hand, melds, seen, honors) {
    seen = seen || {}; melds = melds || [];
    var honor = honors === undefined ? INCLUDE_HONORS : !!honors;
    var mk = melds.length, u = uniqTiles(hand), i, t, rest, cands = [];
    for (i = 0; i < u.length; i++) {
      t = u[i];
      rest = removeOne(hand, t);
      cands.push({
        tile: t, shanten: totalShanten(rest, mk),
        ukeire: ukeireOf(rest, mk, seen, honor, melds),
        keep: waitsFor(rest, melds, honor).length > 0,
        iso: isolation(hand, t), term: termScore(t)
      });
    }
    if (!cands.length) return { tile: hand[0], shanten: 99, ukeire: 0, best: null, same: true };
    /* 最优解 = 向听最小 + 进张最多（与 hintCalc 的取向一致） */
    var best = cands.slice().sort(function (a, b) {
      if (b.keep !== a.keep) return (b.keep ? 1 : 0) - (a.keep ? 1 : 0);
      if (a.shanten !== b.shanten) return a.shanten - b.shanten;
      if (b.ukeire !== a.ukeire) return b.ukeire - a.ukeire;
      return a.term - b.term;
    })[0];
    /* 放水解 = 向听不变差的前提下，进张最少的那张（宁可拆搭、打孤张，也不往前冲） */
    var mild = cands.slice().sort(function (a, b) {
      if (a.shanten !== b.shanten) return a.shanten - b.shanten;
      if (a.ukeire !== b.ukeire) return a.ukeire - b.ukeire;
      if (a.term !== b.term) return a.term - b.term;
      return a.iso - b.iso;
    })[0];
    if (mild.shanten > best.shanten) mild = best;             // 兜底：绝不比自己最优解更远
    return { tile: mild.tile, shanten: mild.shanten, ukeire: mild.ukeire, best: best, same: mild.tile === best.tile };
  }
  function gentleDiscard(hand, melds, seen, honors) { return gentleCalc(hand, melds, seen, honors).tile; }


  /* ═══════════════ 2b. 向听校验 / 剩余张数 / 有效进张 / 智脑提示 / 结算亮牌 ═══════════════ */

  /**
   * 标准型向听的「暴力拆解」实现（与 stdShanten 的 DP 完全独立，用于交叉验证）。
   * 手牌里每种牌 0~4 张（base-5 表示），按花色逐位贪心拆：刻子 / 顺子 / 对子 / 双面 / 坎张，
   * 最后套标准公式 shanten = need - 1。字牌不能组顺子（顺序表里字牌排在 27..33，顺子只允许前 27 位）。
   */
  function stdShantenBrute(hand, meldCount) {
    meldCount = meldCount || 0;
    var groups = [[], [], [], []], i, k, g;                 // 0/1/2 = 万/条/筒(位 0..8)，3 = 字牌(位 0..6)
    for (i = 0; i < 4; i++) for (k = 0; k < 9; k++) groups[i].push(0);
    for (i = 0; i < hand.length; i++) {
      var gi = tileGroup(hand[i]);
      if (gi < 3) groups[gi][numOf(hand[i]) - 1]++; else groups[gi][honorIdx(hand[i])]++;
    }
    var TOT = (meldCount > 4 ? 4 : meldCount);
    var best = 8;
    function leaf(Mc, T, P) {
      var M = Mc + TOT;
      if (M > 4) return;
      var L = hand.length - 3 * Mc - 2 * T - 2 * P;
      if (L < 0) return;
      var slots = 4 - M;
      var Tp = T < slots ? T : slots;
      var free = slots - Tp;
      var seed = P ? 0 : (L >= 1 ? 1 : 0);                  // 还没将 → 先留一张当将
      var L2 = L - seed;
      var seeds = L2 < free ? L2 : free;
      var need = Tp + seeds * 2 + (free - seeds) * 3 + (P ? 0 : (seed ? 1 : 2));
      if (need - 1 < best) best = need - 1;
    }
    function rec(g, i, Mc, T, P) {
      if (Mc + TOT + T > 4) return;
      if (g >= 4) { leaf(Mc, T, P); return; }
      if (i >= 9) { rec(g + 1, 0, Mc, T, P); return; }
      var a = groups[g][i];
      if (a === 0) { rec(g, i + 1, Mc, T, P); return; }
      if (a >= 3) { groups[g][i] -= 3; rec(g, i, Mc + 1, T, P); groups[g][i] += 3; }                    // 刻子
      if (g < 3 && i <= 6 && groups[g][i + 1] > 0 && groups[g][i + 2] > 0) {                            // 顺子
        groups[g][i]--; groups[g][i + 1]--; groups[g][i + 2]--;
        rec(g, i, Mc + 1, T, P);
        groups[g][i]++; groups[g][i + 1]++; groups[g][i + 2]++;
      }
      if (a >= 2) { groups[g][i] -= 2; rec(g, i, Mc, T + 1, P); groups[g][i] += 2; }                    // 对子当搭子
      if (a >= 2 && !P) { groups[g][i] -= 2; rec(g, i, Mc, T, 1); groups[g][i] += 2; }                  // 对子当将（雀头，占 2 张不算面子/搭子）
      if (g < 3 && i <= 7 && groups[g][i + 1] > 0) {                                                    // 双面 / 边张
        groups[g][i]--; groups[g][i + 1]--; rec(g, i, Mc, T + 1, P); groups[g][i]++; groups[g][i + 1]++;
      }
      if (g < 3 && i <= 6 && groups[g][i + 2] > 0) {                                                    // 坎张
        groups[g][i]--; groups[g][i + 2]--; rec(g, i, Mc, T + 1, P); groups[g][i]++; groups[g][i + 2]++;
      }
      groups[g][i]--; rec(g, i, Mc, T, P); groups[g][i]++;                                              // 弃掉这一张
    }
    rec(0, 0, 0, 0, 0);
    return best;
  }
  /* 向听 DP 记忆化。提示一次要试上千手（14 个打法 × 34 种进张 × 再枚举打法），
     所以这里做三层缓存 + 一个「已排序手牌串」：
       key(w) = w + "|" + mc，w 是手牌按牌面排序后用 "|" 连接的串（排序只在必要时做一次）
       S3[k]  → 3k+1 手牌：{ std, seven }
       S2[k]  → 3k+2 手牌：{ std, seven, total }
     有了 S3 之后枚举「打哪一张」只是字符串截取 + 查表，单帧内不产生任何数组分配。 */
  var SH_CACHE = Object.create(null), SH_CACHE_N = 0, SH_CACHE_MAX = 120000, SH_KEYS = 0;
  function shSorted(hand) {
    var s = hand.join("|"), r = sortTiles(hand).join("|");
    return s <= r ? s : r;                                    // 字符串比较等价于按牌面序比较（同长度分隔串）
  }
  function shPut(k, v) {
    if (SH_CACHE_N >= SH_CACHE_MAX) { SH_CACHE = Object.create(null); SH_CACHE_N = 0; }
    SH_CACHE[k] = v; SH_CACHE_N++;
    return v;
  }
  /** 3k+1 手牌：{ std, seven }（标准型 + 七对） */
  function sh13(w, mc) {
    var k = "3|" + mc + "|" + w, e = SH_CACHE[k], a = w.split("|"), sv;
    if (e !== undefined) return e;
    sv = sevenPairsShanten(a);
    return shPut(k, { std: stdShanten(a, mc), seven: sv });
  }
  /** 3k+2 手牌：{ std, seven, total } */
  function sh14(w, mc) {
    var k = "2|" + mc + "|" + w, e = SH_CACHE[k], a, parts, i, p, sub, best = 9;
    if (e !== undefined) return e;
    a = w.split("|");
    if (evaluate(a, []) || (mc > 0 && stdShanten(a, mc) <= 0)) best = -1;   // 13/14 张已成牌
    if (best >= 0 && mc === 0 && sevenPairsShanten(a) < 0) best = -1;
    if (best >= 0) {
      parts = w.split("|");
      for (i = 0; i < parts.length; i++) {
        sub = parts.slice(0, i).concat(parts.slice(i + 1)).join("|");
        p = sh13(sub, mc);
        if (p.std < best) best = p.std;
        if (mc === 0 && p.seven < best) best = p.seven;
      }
    }
    return shPut(k, { std: stdShanten(a, mc), seven: sevenPairsShanten(a), total: best });
  }
  /** 综合向听（提示 / 单测的统一入口） */
  function dpBest(hand, mc) {
    mc = mc || 0;
    var k = shSorted(hand);
    if (hand.length % 3 === 2) return sh14(k, mc).total;
    var e = sh13(k, mc);
    return e.seven < e.std ? e.seven : e.std;
  }

  /**
   * 综合向听 = min(标准型, 七对)（有副露时不算七对）；14 张手牌按「打一张后的最好结果」算。
   * 成牌 = -1（与 stdShanten 口径一致，单测的已知向听表按这个约定）。
   */
  function totalShanten(hand, meldCount) {
    hand = hand || []; meldCount = meldCount || 0;
    if (hand.length % 3 === 2) {
      // 3k+2 张：先看整手是不是已经成牌（-1），否则取「打一张后」的最小值
      return dpBest(hand, meldCount);
    }
    var e = sh13(shSorted(hand), meldCount);
    return e.seven < e.std ? e.seven : e.std;
  }
  /** 剩余可用张数 = 4 − 自己暗手 − 已见（其他三家弃牌 + 四家副露） */
  function remainingOf(tile, hand, seen) {
    hand = hand || []; seen = seen || {};
    var n = 4 - countIn(hand, tile) - (seen[tile] || 0);
    return n < 0 ? 0 : n;
  }
  /**
   * 这张牌有没有可能让手牌向听 −1（纯剪枝，用于把 34 种牌的穷举缩小到十几张）：
   *   字牌：只有手里已有同种字牌才可能成对/成刻 → 否则永远不可能降向听；
   *   序数牌：同花色里 2 位以内有牌才可能组顺子/对子 → 否则是纯孤张，加了也没用。
   */
  function nearHand(hand, t) {
    var c = {}, i, u, s, n, d, off;
    for (i = 0; i < hand.length; i++) c[hand[i]] = (c[hand[i]] || 0) + 1;
    if (isHonor(t)) return (c[t] || 0) > 0;
    s = suitOf(t); n = numOf(t);
    for (d = -2; d <= 2; d++) {
      off = n + d;
      if (off < 1 || off > 9) continue;
      if (c[off + s]) return true;
    }
    return false;
  }
  /**
   * 有效进张（唯一实现）：加入后总向听 −1 的牌 + 剩余张数；返回 { list, n }。
   * 已听牌时进张就是「听的那几张」（waitsFor 内部用 evaluate，比向听 DP 便宜得多）。
   * 其余手牌先按 nearHand 剪枝（纯孤张加了不可能降向听），再逐个精确求向听。
   */
  function ukeireSet(hand, meldCount, seen, honors, base, melds) {
    hand = hand || []; meldCount = meldCount || 0; melds = melds || [];
    if (base === undefined || base === null) base = totalShanten(hand, meldCount);
    if (base < 0) return { list: [], n: 0 };
    var out = [], n = 0, i, t, left, s2, w;
    if (base === 0 && hand.length % 3 === 1) {
      w = waitsFor(hand, melds, honors);
      for (i = 0; i < w.length; i++) { left = remainingOf(w[i], hand, seen); if (left > 0) out.push({ tile: w[i], left: left, shanten: -1 }); }
    } else {
      var kinds = kindsFor(honors);
      for (i = 0; i < kinds.length; i++) {
        t = kinds[i];
        left = remainingOf(t, hand, seen);
        if (left <= 0 || !nearHand(hand, t)) continue;
        s2 = totalShanten(hand.concat([t]), meldCount);
        if (s2 === base - 1) out.push({ tile: t, left: left, shanten: s2 });
      }
    }
    out.sort(function (a, b) { return b.left - a.left || cmpTile(a.tile, b.tile); });
    for (i = 0; i < out.length; i++) n += out[i].left;
    return { list: out, n: n };
  }
  function gainsOf(hand, meldCount, seen, honors, base, melds) {
    return ukeireSet(hand, meldCount, seen, honors, base, melds).list;
  }
  /** 有效进张张数合计（= 所有能改善手牌、且牌墙里还有的牌的张数） */
  function ukeireOf(hand, meldCount, seen, honors, melds) {
    return ukeireSet(hand, meldCount, seen, honors, undefined, melds).n;
  }

  var HINT_CACHE = Object.create(null), HINT_CACHE_N = 0;
  var HINT_STAT = { calcCount: 0, cacheHits: 0, lastMs: 0, worstMs: 0 };
  var HINT_CACHE_MAX = 400;
  var HINT_IMPROVE_MAX = 5;
  function hintCacheClear() {
    HINT_CACHE = Object.create(null); HINT_CACHE_N = 0; HINT_STAT.cacheHits = 0;
    SH_CACHE = Object.create(null); SH_CACHE_N = 0;
    return true;
  }
  function hintCacheStats() { return { size: HINT_CACHE_N, hits: HINT_STAT.cacheHits, calcCount: HINT_STAT.calcCount, lastMs: HINT_STAT.lastMs, worstMs: HINT_STAT.worstMs }; }

  /**
   * 智脑提示（纯函数）：穷举手牌算向听，给出「建议打哪张 / 听什么 / 有效进张」。
   * arg: { hand:[...], melds:[...], seen:{tile:n}, honors:bool }
   * 返回：{ discard, discardIdx, hand:[打完后的手牌], shanten, tenpaiNow, tenpaiAfter,
   *        waits:[...], waitsLeft, ukeire, improve:[{tile,left}], improveKinds, options:[...] }
   */
  function hintCalc(arg) {
    arg = arg || {};
    var honor = arg.honors === undefined ? true : !!arg.honors;
    var melds = arg.melds || [], seen = arg.seen || {};
    var hand = sortTiles(arg.hand || []);
    var mk = melds.length;
    var sig = hand.join(",") + "|" + mk + "|" + (honor ? 1 : 0) + "|";
    for (var si = 0; si < melds.length; si++) sig += sortTiles(melds[si].tiles || []).join("") + ";";
    sig += "|" + sortTiles(Object.keys(seen)).map(function (k) { return k + seen[k]; }).join("");
    if (HINT_CACHE[sig]) { HINT_STAT.cacheHits++; return HINT_CACHE[sig]; }

    var t0 = Date.now();
    HINT_STAT.calcCount++;
    /* 手牌张数决定语义：
       3k+2 张（含刚摸到的那张）→ 先算「建议打哪张」，打完之后再看听牌 / 进张；
       3k+1 张                → 已经在等下一张，直接看是否已听。 */
    var needDiscard = hand.length % 3 === 2;
    var base = needDiscard ? removeOne(hand, hand[hand.length - 1]) : hand.slice();   // base 恒为 3k+1
    var shBase = totalShanten(base, mk);
    var tenpaiNow = waitsFor(base, melds, honor);
    var opt = [], opt0 = [], i, t, rest, w, uke;

    if (needDiscard) {
      var u = uniqTiles(hand);
      /* 第一趟：只求「打哪张后向听最小」（dpTotal 已缓存，后续 15 张求值全部命中） */
      var opt0 = [];
      for (i = 0; i < u.length; i++) {
        t = u[i];
        rest = normalizeHand({ hand: removeOne(hand, t), melds: melds, drawn: null }).hand;
        opt0.push({
          discard: t, tile: t, hand: rest, shanten: totalShanten(rest, mk),
          iso: isolation(hand, t), safe: seen[t] || 0, term: termScore(t)
        });
      }
      opt0.sort(function (a, b) {
        if (a.shanten !== b.shanten) return a.shanten - b.shanten;
        if (b.safe !== a.safe) return b.safe - a.safe;
        if (a.iso !== b.iso) return a.iso - b.iso;
        return a.term - b.term;
      });
      var shMin = opt0.length ? opt0[0].shanten : 0;
      var cands = [], c0;
      for (i = 0; i < opt0.length; i++) if (opt0[i].shanten === shMin) cands.push(opt0[i]);
      /* 第二趟：只给「向听最小」的那几张算有效进张（其余反正不会被选中）。
         有效进张是重活（每张候选要试 34 种进张），所以：
           · 打完成听 → 进张就是「听的那几张」，用 waitsFor 便宜；
           · 便宜键（安全张 / 孤张度 / 幺九）能分出胜负时，只给最好的那张算一次；
           · 只有真正并列时才逐张算（加个上限兜底，避免极端手牌退化）。 */
      var cheap = shMin <= 0;
      var ties = [], k;
      for (i = 0; i < cands.length; i++) {
        c0 = cands[i];
        if (i === 0 || (c0.safe === cands[0].safe && c0.iso === cands[0].iso && c0.term === cands[0].term)) ties.push(c0);
      }
      if (!cheap && ties.length > 4) ties = ties.slice(0, 4);
      for (k = 0; k < ties.length; k++) {
        c0 = ties[k];
        w = waitsFor(c0.hand, melds, honor);
        c0.waits = w;
        c0.waitsLeft = sumLeft(w, c0.hand, seen);
        c0.tenpai = w.length > 0;
        c0.ukeire = cheap ? c0.waitsLeft : ukeireOf(c0.hand, mk, seen, honor, melds);
      }
      for (i = 0; i < cands.length; i++) if (cands[i].ukeire === undefined) cands[i].ukeire = 0;
      cands.sort(function (a, b) {
        if (b.ukeire !== a.ukeire) return b.ukeire - a.ukeire;
        if (b.safe !== a.safe) return b.safe - a.safe;
        if (a.iso !== b.iso) return a.iso - b.iso;
        return a.term - b.term;
      });
      /* 打一张就成听 → 已经是最好的结果，剩下的候选不用再比（省掉最贵的那部分） */
      if (shMin <= 0) cands = cands.slice(0, 1);
      opt = opt0;                                                // options 暴露全部打法（便于单测核对最优性）
      opt0 = cands;                                              // 候选（已按最优排序）
    }
    var pick = opt0.length ? opt0[0] : null;
    var after = pick ? pick.hand : base;
    var shRef = pick ? pick.shanten : shBase;
    var waitsAfter = pick ? pick.waits : tenpaiNow;
    var waitsLeftAfter = pick ? pick.waitsLeft : sumLeft(tenpaiNow, base, seen);
    // 有效进张：从「当前 3k+1 的那手牌」出发，加入后向听 −1 的牌（唯一实现，供面板 + 选牌评分共用）
    var us = ukeireSet(base, mk, seen, honor, shBase, melds);
    var list = us.list;
    var improve = [];
    for (i = 0; i < list.length && improve.length < HINT_IMPROVE_MAX; i++) improve.push({ tile: list[i].tile, left: list[i].left });
    var hint = {
      hand: hand, base: base, melds: melds, seen: seen, honors: honor,
      discard: pick ? pick.discard : null,
      discardIdx: pick ? indexOfTile(arg.hand || [], pick.discard) : -1,   // 用调用方传进来的原始手牌下标（渲染高亮要对得上）
      shanten: shRef, shantenNow: shBase, tenpaiNow: tenpaiNow.length > 0, tenpaiAfter: !!(pick && pick.tenpai),
      waits: waitsAfter, waitsLeft: waitsLeftAfter,
      ukeire: pick ? pick.ukeire : ukeireOf(base, mk, seen, honor),
      improve: improve, improveKinds: list.length, options: opt
    };
    var ms = Date.now() - t0;
    HINT_STAT.lastMs = ms; if (ms > HINT_STAT.worstMs) HINT_STAT.worstMs = ms;
    if (HINT_CACHE_N >= HINT_CACHE_MAX) hintCacheClear();
    HINT_CACHE[sig] = hint; HINT_CACHE_N++;
    return hint;
  }
  function indexOfTile(hand, t) { for (var i = 0; i < hand.length; i++) if (hand[i] === t) return i; return -1; }
  function sumLeft(waits, hand, seen) {
    var n = 0, i;
    for (i = 0; i < (waits || []).length; i++) n += remainingOf(waits[i], hand, seen);
    return n;
  }
  function listTiles(a) { return (a || []).join("/"); }
  /** 三行提示文案：① 建议 / 已听 ② 有效牌 ③ 说明 */
  function hintLines(h) {
    if (!h) return null;
    var l1, l2, l3;
    if (h.discard) l1 = "打 " + h.discard + (h.tenpaiAfter ? " → 听 " + listTiles(h.waits) + "（剩 " + h.waitsLeft + " 张）" : " → " + h.shanten + " 向听");
    else if (h.tenpaiNow) l1 = "已听：" + listTiles(h.waits) + "（剩 " + h.waitsLeft + " 张）";
    else l1 = "向听 " + h.shanten + " · 无有效进张";
    l2 = h.improveKinds ? "有效牌：" + h.improve.map(function (x) { return x.tile + "×" + x.left; }).join(" ") : "有效牌：无";
    if (h.discard) l3 = "有效进张 " + h.ukeire + " 张 · 共 " + h.options.length + " 种打法";
    else if (h.tenpaiNow) l3 = "已听牌 · 共 " + h.waits.length + " 种听牌";
    else l3 = "可改善 " + h.improveKinds + " 种";
    return { l1: l1, l2: l2, l3: l3 };
  }

  /* ── 结算亮牌：数据结构（纯函数，供面板 HTML 与单测共用） ── */
  function meldLabel(t) {
    if (t === "peng") return "碰";
    if (t === "gang") return "杠";
    return String(t || "");
  }
  function meldLabelOf(m) {
    if (!m) return "";
    if (m.type === "peng") return "碰";
    if (m.type === "gang") return m.an === true ? "暗杠" : (m.kind === "bu" ? "补杠" : "明杠");
    return meldLabel(m.type);
  }
  /** 赣麻四档 × 注码：per = 张数 × 注码，total = 三家之和（默认注码 10 → 20/60 与旧版一致） */
  function tierList(stake) {
    var st = stakeOf(stake), i, src = [TIER.small, TIER.big, TIER.bigger, TIER.biggest], out = [], t;
    for (i = 0; i < src.length; i++) {
      t = src[i];
      out.push({ key: t.key, name: t.name, tiles: t.tiles, per: t.tiles * st, total: t.tiles * st * 3, stake: st });
    }
    return out;
  }
  /** 胡牌来源文案：自摸 / 抢杠 / 杠开 */
  function howText(res) {
    if (!res) return "";
    if (res.how) return res.how;
    return res.robKong ? "抢杠胡" : (res.kongDraw ? "杠上开花" : "自摸");
  }
  /**
   * 结算亮牌：四家完整手牌（排好序）+ 副露（标注类型）+ 听牌/胡牌 + 赔付明细 + 注码/打法/羁绊/口碑/情报。
   * engine：Engine 实例；result：engine.result（或外部传入的等价对象）；
   * o（可选）：{ state, invite, style, applyCash } —— 面板文案与真正落地的状态改动同源。
   */
  function buildResultView(engine, result, o) {
    var res = result || (engine && engine.result) || {};
    var E = engine, honors = E && E.honors !== undefined ? E.honors : INCLUDE_HONORS;
    var ro = o || (E && E.opts) || {};
    var style = styleOf(res.style || ro.style);
    var stake = stakeOf(res.stake);
    var rep = previewOutcome(ro.state, res, { style: style, invite: ro.invite || null, applyCash: ro.applyCash !== false });
    var draw = !!res.draw, winSeat = res.win === true && typeof res.seat === "number" ? res.seat : (draw ? -1 : (typeof res.seat === "number" ? res.seat : -1));
    var per = res.perPlayer || 0;
    var payerOnly = !!res.payerOnly, payerSeat = res.from !== undefined && res.from !== null ? res.from : -1;
    var winTile = res.hand && res.hand.length ? res.hand[res.hand.length - 1] : (res.winTile || null);
    var seats = [], i, j, p, hm, melds, meldTxt, wt, wi, pay, net;
    for (i = 0; i < 4; i++) {
      p = E.P[i];
      hm = sortTiles(p.hand || []).slice();
      melds = [];
      for (j = 0; j < (p.melds || []).length; j++) {
        melds.push({ type: p.melds[j].type, kind: p.melds[j].kind, an: !!p.melds[j].an, tiles: sortTiles(p.melds[j].tiles || []), label: meldLabelOf(p.melds[j]) });
      }
      meldTxt = melds.map(function (m) { return m.label + (m.tiles.length ? m.tiles[0] : ""); }).join(" / ");
      wt = i === winSeat ? winTile : null;
      wi = wt ? indexOfTile(hm, wt) : -1;
      var core = hm.slice();
      if (p.drawn !== null && p.drawn !== undefined && core.length % 3 === 2) core.pop();
      var wts = waitsFor(core, p.melds || [], honors);
      pay = draw ? 0 : (i === winSeat ? 0 : (payerOnly ? (i === payerSeat ? per * 3 : 0) : per));
      net = draw ? 0 : (i === winSeat ? per * 3 : -pay);
      seats.push({
        seat: i, name: p.name || SEAT_DEF[i].name, isHuman: !!p.isHuman,
        hand: hm, melds: melds, meldTxt: meldTxt,
        win: i === winSeat, winTile: wt, winTileIdx: wi, how: i === winSeat ? howText(res) : "",
        tierName: i === winSeat ? (res.tierName || "") : "",
        tenpai: wts.length > 0, waits: wts, waitsLeft: sumLeft(wts, core, {}),
        pay: pay, net: net
      });
    }
    var mine = seats[0].net;
    var tiers = tierList(stake);
    for (i = 0; i < tiers.length; i++) tiers[i].cur = (tiers[i].key === res.tier);
    var payers = [];
    for (i = 0; i < 4; i++) if (i !== winSeat && seats[i].pay > 0) payers.push({ seat: i, name: seats[i].name, amount: seats[i].pay });
    var head = draw ? ("流局 · " + (res.why || "四家都没胡")) : (seats[winSeat] ? seats[winSeat].name : "") + (seats[winSeat] && seats[winSeat].how ? " · " + seats[winSeat].how : "");
    var stakeTail = " · 注码 ¥" + stake;
    var payText1, payText2;
    if (draw) {
      payText1 = "赔付明细：流局原因 " + (res.why || "四家都没胡") + " · 四家都不付" + stakeTail;
      payText2 = "你的净收支 " + (mine > 0 ? "+" : "") + mine;
    } else if (payerOnly) {
      var pn = (seats[payerSeat] && seats[payerSeat].name) || "杠家";
      payText1 = "赔付明细：" + pn + " 包赔三家 " + per * 3 + "（" + (res.tierName || "") + " 每家 " + per + "）" + stakeTail;
      payText2 = "你的净收支 " + (mine > 0 ? "+" : "") + mine;
    } else {
      var parts = [];
      for (i = 0; i < payers.length; i++) parts.push((payers[i].seat === 0 ? "你" : payers[i].name) + " 付 " + payers[i].amount);
      payText1 = "赔付明细：" + (parts.join(" · ") || "无人需付") + "（共 " + per * 3 + "）" + stakeTail;
      payText2 = "你的净收支 " + (mine > 0 ? "+" : "") + mine;
    }
    var handTotal = 0, meldTotal = 0;
    for (i = 0; i < 4; i++) { handTotal += seats[i].hand.length; for (j = 0; j < seats[i].melds.length; j++) meldTotal += seats[i].melds[j].tiles.length; }
    return {
      draw: draw, win: !!res.win, winSeat: winSeat, tier: res.tier || "", tierName: res.tierName || (draw ? "流局" : ""),
      fan: res.fan || 0, fanName: res.fanName || "", per: per, total: per * 3, mine: mine,
      payers: payers, payerOnly: payerOnly, payerSeat: payerSeat, payer: res.payer || "",
      why: draw ? (res.why || "四家都没胡") : "", head: head, seats: seats, tiers: tiers,
      payText1: payText1, payText2: payText2, handTotal: handTotal, meldTotal: meldTotal,
      winTile: winTile, how: howText(res), names: seats.map(function (s) { return s.name; }).join("/"),
      /* ── 赌注 / 打法 / 羁绊 / 口碑 / 情报（面板新行与状态改动同源） ── */
      stake: stake, style: style, styleName: styleName(style), invite: ro.invite || null,
      netCash: res.netCash !== undefined ? res.netCash : mine, cashText: rep.cashText,
      styleText: rep.styleText, bondText: rep.bondText, repText: rep.repText,
      intelText: rep.intelText, achvText: rep.achvText, report: rep,
      /* 「本局影响」行：打法带来的剧情后果（与落地 flag 同源，规则层直出） */
      impactText: rep.impactText || "", impact: rep.impact || null,
      impactNote: rep.impact ? rep.impact.note : "", impactFlag: rep.impact ? rep.impact.flag : ""
    };
  }
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function rtileHtml(t, cls, tag) {
    return "<" + (tag || "i") + ' class="mjm-rtile' + (cls ? " " + cls : "") + '">' + escHtml(t) + "</" + (tag || "i") + ">";
  }
  /** 副露：类型标签与第一张牌同格显示（如 碰5筒），便于一眼看清 */
  function rmeldHtml(md) {
    var h = '<span class="rh-meld">', q;
    for (q = 0; q < md.tiles.length; q++) {
      if (q === 0) h += '<b class="mjm-rtile meld first">' + escHtml(md.label + md.tiles[q]) + "</b>";
      else h += rtileHtml(md.tiles[q], "meld", "b");
    }
    return h + "</span>";
  }
  /**
   * 结算面板 HTML：四家完整手牌 + 副露 + 听牌/胡牌标注 + 赔付明细 + 赣麻四档 + 继续按钮。
   * 保留原有的 opts.onFinish(result) 契约与 #mjmGo 按钮 id。
   */
  function resultHtml(view, result) {
    var v = view || {};
    var res = result || {};
    var h = '<div class="mjm-card wide" id="mjmResCard">';
    h += '<div class="k">' + (v.draw ? "DRAW" : (v.win ? "YOU WIN" : "YOU LOSE")) + "</div>";
    h += '<div class="t' + (v.win && !v.draw ? "" : " lose") + '">' + escHtml(v.draw ? "流 局" : (v.tierName || "")) + "</div>";
    h += '<div class="n">' + escHtml(v.draw ? (v.why || "四家都没胡，本局作废") : v.head) + "</div>";
    h += '<div id="mjmResHands" class="mjm-rhands">';
    for (var i = 0; i < (v.seats || []).length; i++) {
      var s = v.seats[i];
      var tcls = (i === 0 ? " me" : "") + (s.win ? " win" : "");
      h += '<div class="mjm-rhand' + tcls + '">';
      h += '<div class="rh-h"><b>' + escHtml(s.name) + "</b>";
      if (s.win) h += '<em class="rh-win">胡 · ' + escHtml(s.how) + (s.tierName ? " · " + escHtml(s.tierName) : "") + "</em>";
      else if (s.tenpai) h += '<em class="rh-tp">听 ' + escHtml(listTiles(s.waits)) + "（剩 " + s.waitsLeft + " 张）</em>";
      else h += '<em class="rh-no">未听</em>';
      if (!v.draw) h += '<i class="rh-pay' + (s.net < 0 ? " minus" : "") + '">' + (s.net > 0 ? "+" : "") + s.net + "</i>";
      h += "</div>";
      h += '<div class="rh-tiles">';
      for (var j = 0; j < s.hand.length; j++) h += rtileHtml(s.hand[j], j === s.winTileIdx ? "win" : "");
      h += "</div>";
      if (s.melds.length) {
        h += '<div class="rh-melds"><span class="rh-mlabel">副露</span>';
        for (var m = 0; m < s.melds.length; m++) h += rmeldHtml(s.melds[m]);
        h += "</div>";
      }
      h += "</div>";
    }
    h += "</div>";
    h += '<div id="mjmResPay" class="mjm-rpay">';
    h += '<div class="rp-1">' + escHtml(v.payText1) + "</div>";
    h += '<div class="rp-2">' + escHtml(v.payText2) + "</div>";
    h += '<div class="rp-tiers">';
    for (var k = 0; k < (v.tiers || []).length; k++) {
      var tt = v.tiers[k];
      h += '<span class="rp-tier' + (tt.cur ? " cur" : "") + '">' + escHtml(tt.name) + "<b>" + tt.total + "</b></span>";
    }
    h += "</div>";
    /* ── 赌注系统：注码 / 净收支 / 打法 / 本局影响 / 羁绊 / 口碑 / 情报 / 成就 ── */
    h += '<div class="rp-sys" id="mjmResSys">';
    h += '<div class="rs-cash" id="mjmResCash">' + escHtml(v.cashText || "") + "</div>";
    h += '<div class="rs-style" id="mjmResStyle">' + escHtml(v.styleText || "") + "</div>";
    if (v.impactText) h += '<div class="rs-impact" id="mjmResImpact">🏮 本局影响 · ' + escHtml(v.impactText) + "</div>";
    if (v.bondText) h += '<div class="rs-bond" id="mjmResBond">' + escHtml(v.bondText) + "</div>";
    if (v.repText) h += '<div class="rs-rep" id="mjmResRep">' + escHtml(v.repText) + "</div>";
    if (v.intelText) h += '<div class="rs-intel" id="mjmResIntel">' + escHtml(v.intelText) + "</div>";
    if (v.achvText) h += '<div class="rs-achv" id="mjmResAchv">' + escHtml(v.achvText) + "</div>";
    h += "</div>";
    h += "</div>";
    h += '<div class="lg">' + (res.log || []).slice(-6).map(escHtml).join("<br>") + "</div>";
    h += '<button id="mjmGo">继 续</button></div>';
    return h;
  }

  /* ═══════════════ 3. 引擎（无 DOM，可整局自动跑） ═══════════════ */

  function mkPlayer(idx, isHuman) {
    return {
      idx: idx, name: SEAT_DEF[idx].name, isHuman: !!isHuman,
      hand: [], melds: [], discards: [], drawn: null, kongDraw: false
    };
  }

  /**
   * 引擎。opts.honors 可单独决定本局是否带字牌：
   *   不传 → 用常量 INCLUDE_HONORS（默认 false = 108 张赣麻规则）
   *   true → 136 张（万条筒 + 东南西北中發白）
   */
  function Engine(stake, opts) {
    opts = opts || {};
    this.stake = stake || STAKE_DEFAULT;
    this.style = styleOf(opts.style);
    this.honors = opts.honors !== undefined ? !!opts.honors : INCLUDE_HONORS;
    this.wall = shuffle(createWall(this.honors));
    this.P = [mkPlayer(0, false), mkPlayer(1, false), mkPlayer(2, false), mkPlayer(3, false)];
    this.dealer = 0;
    this.cur = 0;
    this.turnNo = 1;
    this.phase = "idle";        // idle | turn | claim | rob | over
    this.pending = null;
    this.log = [];              // [{seat, kind, text}]
    this.result = null;
  }
  Engine.prototype.push = function (seat, kind, text, tile) {
    this.log.push({ seat: seat, kind: kind, text: text, tile: tile || "" });
    if (this.log.length > 400) this.log.shift();
    return text;
  };
  Engine.prototype.nameOf = function (seat) { return this.P[seat].name; };
  /** 其他三家已打出的牌（安全张参考） */
  Engine.prototype.seenBy = function (seat) {
    var out = Object.create(null), i, j, p;
    for (i = 0; i < 4; i++) {
      if (i === seat) continue;
      p = this.P[i];
      for (j = 0; j < p.discards.length; j++) out[p.discards[j]] = (out[p.discards[j]] || 0) + 1;
    }
    return out;
  };
  function kongOptions(p) {
    var an = [], add = [], c = counts(p.hand), t, i, m;
    for (t in c) if (c[t] === 4) an.push(t);
    an = sortTiles(an);
    for (i = 0; i < p.melds.length; i++) {
      m = p.melds[i];
      if (m.type === "peng" && countIn(p.hand, m.tiles[0]) >= 1) add.push(m.tiles[0]);
    }
    return { anGangs: an, addGangs: sortTiles(add) };
  }
  Engine.prototype.setTurn = function (seat) {
    var k = kongOptions(this.P[seat]);
    this.cur = seat;
    this.phase = "turn";
    this.pending = { type: "turn", seat: seat, anGangs: k.anGangs, addGangs: k.addGangs };
  };
  Engine.prototype.deal = function () {
    var i, k, p;
    for (k = 0; k < 13; k++) {
      for (i = 0; i < 4; i++) this.P[i].hand.push(this.wall.shift());
    }
    for (i = 0; i < 4; i++) normalizeHand(this.P[i]);        // 起手就按牌型排序
    this.push(this.dealer, "deal", "发牌完毕 · 庄家 " + this.nameOf(this.dealer));
    this.turn(this.dealer);
    return this;
  };
  Engine.prototype.turn = function (seat) {
    var p = this.P[seat];
    if (this.wall.length === 0) { this.drawGame("牌墙摸完（无人成牌）"); return; }
    var t = this.wall.shift();
    p.hand.push(t); p.drawn = t; p.kongDraw = false;
    normalizeHand(p);                                       // 摸到的牌不排序，留在最右
    this.push(seat, "draw", this.nameOf(seat) + " 摸牌");
    var ev = evaluate(p.hand, p.melds);
    if (ev) { this.settle(seat, { selfDraw: true, kongDraw: false }, ev); return; }
    this.setTurn(seat);
  };
  Engine.prototype.drawGame = function (why) {
    this.phase = "over";
    this.push(this.cur, "draw", "流局 · " + why);
    this.result = {
      win: false, selfDraw: false, robKong: false, kongDraw: false, draw: true,
      fan: 0, fanName: "流局", score: 0, winner: "", seat: -1, tier: "",
      payerOnly: false, perPlayer: 0, tiles: 0, stake: this.stake,
      /* ── 赌注系统新增字段（流局不结算，全部为 0）── */
      payPerHouse: 0, totalWin: 0, netCash: 0, payerSeat: -1, style: styleOf(this.style),
      why: why, log: this.log.map(function (e) { return e.text; })
    };
  };
  Engine.prototype.discard = function (seat, idx) {
    if (this.phase !== "turn" || this.cur !== seat) return false;
    var p = this.P[seat];
    if (p.hand.length % 3 !== 2) return false;
    if (typeof idx !== "number" || idx < 0 || idx >= p.hand.length) return false;
    var t = p.hand[idx];
    p.hand.splice(idx, 1);
    p.drawn = null;
    normalizeHand(p);                                       // 打完之后立刻整理（摸到的牌并入排序）
    p.discards.push(t);
    this.push(seat, "discard", this.nameOf(seat) + " 打出 " + t, t);
    this.afterDiscard(seat, t);
    return true;
  };
  /** 弃牌后：只有 碰 / 杠（没有吃、没有点炮胡） */
  Engine.prototype.afterDiscard = function (from, tile) {
    var cands = [], k, s, p, cnt;
    for (k = 1; k <= 3; k++) {
      s = (from + k) % 4; p = this.P[s];
      cnt = countIn(p.hand, tile);
      if (cnt >= 3) cands.push({ seat: s, actions: ["gang", "peng"] });
      else if (cnt >= 2) cands.push({ seat: s, actions: ["peng"] });
    }
    if (!cands.length) { this.next(); return; }
    cands.sort(function (a, b) { return b.actions.length - a.actions.length; });
    var best = cands[0];
    this.pending = { type: "claim", seat: best.seat, tile: tile, from: from, actions: best.actions, all: cands };
    this.phase = "claim";
  };
  Engine.prototype.takeFromPool = function (fromSeat, tile) {
    var d = this.P[fromSeat].discards, i;
    for (i = d.length - 1; i >= 0; i--) if (d[i] === tile) { d.splice(i, 1); return true; }
    return false;
  };
  Engine.prototype.claim = function (seat, action) {
    if (this.phase !== "claim" || this.pending.seat !== seat) return false;
    var pend = this.pending, t = pend.tile, from = pend.from, p = this.P[seat];
    if (action === "pass" || !action) {
      this.push(seat, "pass", this.nameOf(seat) + " 过");
      this.pending = null;
      this.next();
      return true;
    }
    if (pend.actions.indexOf(action) < 0) return false;
    this.takeFromPool(from, t);
    if (action === "peng") {
      var h2 = removeN(p.hand, t, 2);
      if (h2 === null) return false;
      p.hand = h2;
      p.drawn = null;
      p.melds.push({ type: "peng", tiles: [t, t, t], from: from, an: false, kind: "ming" });
      normalizeHand(p);                                     // 碰完 → 副露与手牌立刻归位
      this.push(seat, "peng", this.nameOf(seat) + " 碰 " + t, t);
      this.pending = null;
      this.setTurn(seat);                 // 碰后直接出牌（不摸牌）
      return true;
    }
    if (action === "gang") {
      var h3 = removeN(p.hand, t, 3);
      if (h3 === null) return false;
      p.hand = h3;
      p.drawn = null;
      p.melds.push({ type: "gang", tiles: [t, t, t, t], from: from, an: false, kind: "ming" });
      normalizeHand(p);
      this.push(seat, "gang", this.nameOf(seat) + " 直杠 " + t, t);
      this.pending = null;
      this.openKong(seat, t, "ming", from);
      return true;
    }
    return false;
  };
  /** 自己回合的暗杠 / 补杠 */
  Engine.prototype.turnGang = function (seat, tile, kind) {
    if (this.phase !== "turn" || this.cur !== seat) return false;
    var p = this.P[seat], i, m;
    if (kind === "an") {
      var rest = removeN(p.hand, tile, 4);
      if (rest === null) return false;
      p.hand = rest;
      p.drawn = null;
      p.melds.push({ type: "gang", tiles: [tile, tile, tile, tile], from: -1, an: true, kind: "an" });
      normalizeHand(p);
      this.push(seat, "gang", this.nameOf(seat) + " 暗杠 " + tile, tile);
      this.pending = null;
      this.openKong(seat, tile, "an");
      return true;
    }
    for (i = 0; i < p.melds.length; i++) {
      m = p.melds[i];
      if (m.type === "peng" && m.tiles[0] === tile) {
        var r2 = removeOne(p.hand, tile);
        if (r2 === null) return false;
        p.hand = r2;
        p.drawn = null;
        p.melds[i] = { type: "gang", tiles: [tile, tile, tile, tile], from: m.from, an: false, kind: "bu", promoted: true };
        normalizeHand(p);
        this.push(seat, "gang", this.nameOf(seat) + " 补杠（回头杠）" + tile, tile);
        this.pending = null;
        this.openKong(seat, tile, "bu");
        return true;
      }
    }
    return false;
  };
  /** 杠之后：先给别家抢杠胡的机会（暗杠不可抢 · 字牌杠也不可抢），否则补摸一张 */
  Engine.prototype.openKong = function (seat, tile, kind, fromSeat) {
    if (canRobKong(kind) && !isHonor(tile)) {                // 「东南西北中發白抢不了」
      var robbers = [], k, s, q, ev;
      for (k = 1; k <= 3; k++) {
        s = (seat + k) % 4; q = this.P[s];
        if (fromSeat != null && s === fromSeat) continue;      // 打出这张牌的人不能抢自己的杠
        ev = evaluate(q.hand.concat([tile]), q.melds);
        if (ev) robbers.push(s);
      }
      if (robbers.length) {
        this.pending = { type: "rob", from: seat, tile: tile, kind: kind, seats: robbers };
        this.phase = "rob";
        this.push(seat, "rob", "有人可以抢杠胡 " + tile + "（" + this.nameOf(robbers[0]) + " 等）");
        return;
      }
    }
    this.kongDraw(seat);
  };
  Engine.prototype.rob = function (seat) {
    if (this.phase !== "rob") return false;
    var pend = this.pending, q = this.P[seat], kp = this.P[pend.from];
    if (pend.seats.indexOf(seat) < 0) return false;
    var ev = evaluate(q.hand.concat([pend.tile]), q.melds);
    if (!ev) return false;
    // 抢杠成功 → 撤销这次杠：补杠退回「碰」，直杠退回手里；被抢的那张归抢杠家
    var i, m, reverted = false;
    for (i = kp.melds.length - 1; i >= 0; i--) {
      m = kp.melds[i];
      if (m.type === "gang" && m.tiles[0] === pend.tile && !m.an && m.kind === pend.kind) {
        if (pend.kind === "bu") { m.type = "peng"; m.tiles = [pend.tile, pend.tile, pend.tile]; m.kind = "ming"; delete m.promoted; }
        else { kp.hand = kp.hand.concat([pend.tile, pend.tile, pend.tile]); kp.melds.splice(i, 1); }
        reverted = true;
        break;
      }
    }
    if (!reverted && pend.kind === "ming") kp.hand = kp.hand.concat([pend.tile, pend.tile, pend.tile]);
    q.hand.push(pend.tile);
    q.drawn = pend.tile;
    normalizeHand(q);                                       // 抢到的那张固定在最右
    normalizeHand(kp);                                      // 被抢的杠退回后重新整理
    this.push(seat, "rob", this.nameOf(seat) + " 抢杠胡 " + pend.tile + "（杠家 " + this.nameOf(pend.from) + " 包赔）");
    this.pending = null;
    this.settle(seat, { selfDraw: true, robKong: true, from: pend.from, winTile: pend.tile }, ev);
    return true;
  };
  Engine.prototype.passRob = function (seat) {
    if (this.phase !== "rob") return false;
    var pend = this.pending, i = pend.seats.indexOf(seat);
    if (i < 0) return false;
    pend.seats.splice(i, 1);
    if (!pend.seats.length) { this.pending = null; this.kongDraw(pend.from); }
    return true;
  };
  /** 杠后补摸（从牌墙尾摸，牌墙尽则流局）；补摸成牌即「杠开」 */
  Engine.prototype.kongDraw = function (seat) {
    if (!this.wall.length) { this.drawGame("杠后无牌可摸"); return; }
    var p = this.P[seat], t = this.wall.pop();
    p.hand.push(t); p.drawn = t; p.kongDraw = true;
    normalizeHand(p);
    this.push(seat, "draw", this.nameOf(seat) + " 杠后补牌");
    var ev = evaluate(p.hand, p.melds);
    if (ev) { this.settle(seat, { selfDraw: true, kongDraw: true }, ev); return; }
    this.setTurn(seat);
  };
  Engine.prototype.next = function () {
    var s = (this.cur + 1) % 4;
    if (s === this.dealer) this.turnNo++;
    this.turn(s);
  };
  Engine.prototype.settle = function (seat, ctx, ev) {
    var p = this.P[seat];
    ev = ev || evaluate(p.hand, p.melds);
    if (!ev) { this.drawGame("成牌判定失败"); return; }
    var sc = scoreOf(ev.tier, { kongDraw: ctx.kongDraw, robKong: ctx.robKong, stake: this.stake });
    this.phase = "over";
    this.pending = null;
    var how = ctx.robKong ? "抢杠胡" : (ctx.kongDraw ? "杠上开花" : "自摸");
    var fromSeat = (ctx.from === undefined || ctx.from === null) ? -1 : ctx.from;
    /* 你的净收支（座位 0 视角）：
       你胡 → +共收；别人胡且杠家包赔 → 你是杠家就 −共收，否则 0；普通自摸 → −每家应付 */
    var netCash = (seat === 0) ? sc.total : (sc.payerOnly ? (fromSeat === 0 ? -sc.total : 0) : -sc.per);
    this.push(seat, "win", this.nameOf(seat) + " " + how + " · " + sc.fanName +
      " · 每家 " + sc.per + "，共收 " + sc.total);
    this.result = {
      win: seat === 0, selfDraw: true, robKong: !!ctx.robKong, kongDraw: !!ctx.kongDraw, draw: false,
      from: fromSeat,                                                      // 抢杠时 = 杠牌那家（包赔三家）
      fan: sc.fan, fanName: sc.fanName, score: sc.total, winner: p.name, seat: seat, tier: sc.tier,
      tierName: sc.tierName, tiles: sc.tiles, perPlayer: sc.per, payerOnly: sc.payerOnly, stake: this.stake,
      /* ── 赌注系统新增字段 ── */
      payPerHouse: sc.per, totalWin: sc.total, netCash: netCash, payerSeat: sc.payerOnly ? fromSeat : -1,
      style: styleOf(this.style),
      payer: ctx.robKong ? this.nameOf(ctx.from) : "", how: how,
      hand: p.hand.slice(), melds: p.melds.slice(),
      log: this.log.map(function (e) { return e.text; })
    };
    return this.result;
  };
  /** 引擎单步：自动处理 AI 的决策；轮到人类则返回 "wait" */
  Engine.prototype.aiStep = function () {
    if (this.phase === "over") return "over";
    var pend = this.pending;
    if (this.phase === "turn") {
      var p = this.P[this.cur];
      if (p.isHuman) return "wait";
      if (pend && pend.anGangs.length) { this.turnGang(this.cur, pend.anGangs[0], "an"); return "angang"; }
      if (pend && pend.addGangs.length) { this.turnGang(this.cur, pend.addGangs[0], "bu"); return "addgang"; }
      var t = aiDiscard(p.hand, p.melds, this.seenBy(this.cur), this.honors);
      var idx = p.hand.indexOf(t);
      if (idx < 0) idx = p.hand.length - 1;
      this.discard(this.cur, idx);
      return "discard";
    }
    if (this.phase === "claim") {
      var s = pend.seat, q = this.P[s];
      if (q.isHuman) return "wait";
      var act = aiWantClaim(q, pend);
      this.claim(s, act);
      return act;
    }
    if (this.phase === "rob") {
      var i, hs = null;
      for (i = 0; i < pend.seats.length; i++) if (this.P[pend.seats[i]].isHuman) { hs = pend.seats[i]; break; }
      if (hs !== null) return "wait";
      this.rob(pend.seats[0]);
      return "rob";
    }
    return "none";
  };
  /** 整局纯 AI 自动跑（单测 / 回归用）；honors=true 可跑带字牌的 136 张 */
  function autoPlay(maxSteps, honors) {
    var e = new Engine(STAKE_DEFAULT, honors === undefined ? null : { honors: !!honors }), steps = 0;
    e.deal();
    while (e.phase !== "over" && steps < (maxSteps || 4000)) { e.aiStep(); steps++; }
    return { result: e.result, steps: steps, engine: e };
  }

  /* ═══════════════ 4. 渲染层（canvas · 真牌面 / 真牌桌） ═══════════════ */

  var W = 1240, H = 860;
  var CN_NUM = { 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七", 8: "八", 9: "九" };
  var FONT_CN = "'KaiTi','STKaiti','Kaiti SC','Microsoft YaHei','SimHei',serif";
  /* 牌面配色（照标准麻将牌）：红 / 绿 / 蓝 / 墨 */
  var C_RED = "#c62828", C_GREEN = "#1f7a34", C_BLUE = "#12539c", C_INK = "#182236";
  /** 手牌 56×78（放大到看得清牌面），牌与牌之间 6px 间隙；对手手牌 / 牌墙按同比例缩放 */
  var LAYOUT = {
    felt: { x: 14, y: 14, w: W - 28, h: H - 28, r: 26 },
    hand: { y: 762, tw: 56, th: 78, step: 62, gap: 12, lift: 7, drawnLift: 12 },
    meld0: { x: 1057, y: 711, tw: 34, th: 46, gap: 4, groupGap: 14, avail: 620 },
    back: { wide: 26, depth: 30, step: 26 },
    meldSide: { tw: 34, th: 30, gap: 3, groupGap: 12 },
    meldTop: { tw: 34, th: 30, gap: 4, groupGap: 14 },
    disc: { tw: 36, th: 48, sx: 38, sy: 50 },
    /* 牌墙一墩 = **上下两枚立牌**（照放大参考图）：单枚牌背深 tileDepth，一墩两枚 = stackDepth。
       stackDepth 46 = 旧的「双层 22 + 缝 2 + 22」→ 方环占位没变，同心几何与装饰安全区都不用重算。*/
    wall: { tw: 30, tileDepth: 23, stackDepth: 46, side: { tw: 23, th: 30 }, step: 30 },
    center: { x: 620, y: 380, w: 118, h: 118 }
  };
  /* 尺寸纪律（用户 2025 追加要求）：**同一副露组内所有牌尺寸完全一致**。
       · 正立牌 = meld0/meldTop/meldSide 的 tw × th（本组内统一）
       · 横置牌 = 同一张牌**绕中心旋转 90°**，绝不缩放 → 外接框 = th × tw
       · 整组统一行高（垂直于行的方向）= max(tw, th)，所有牌按它居中 → 顶边 / 底边齐平
       · 牌墙：同一侧的牌背尺寸一致（横向 30×22 / 纵向 22×30），双层叠放两排同尺寸
     e2e 与 tools/mj/check-geometry.js 会断言「同组内 (w,h) 只有一种、rot ∈ {0,90}」。 */
  /** ── 同心三层布局的骨架常量（照参考图 2 重排）───────────────────────────────
      由中心向外：① 圆形指示盘（LAYOUT.center）→ ② 牌河（DISC_ZONE）
      → ③ 牌墙方环（WALL_GEO，内表面到中心恒为 rIn）→ ④ 四家手牌 / 副露 / 座位牌。
      rIn 由「牌墙外沿 + 余量 ≤ 玩家副露上沿（LAYOUT.meld0.y = 690）」定死：
        cy + rIn + 22(内层深) + 2(缝) + 22(外层深) = 402 + rIn + 46 ≤ 670  →  rIn ≤ 222。
      取 rIn = 222（满值），牌河带宽 = 222 − 54(指示盘半径) = 168px → 放得下 4 行（24 张/家）。 */
  /** ── 同心三层布局的骨架常量（照参考图 2 量出来后重排）─────────────────────────
      量图结论（2868×1320 → 归一化）：牌墙方环外沿占**桌面宽度的 64.5%**、高度的 81.5%，
      中央圆盘在画面正中（归一化 0.497 / 0.398）。旧实现方环只占桌面宽 44% → 明显偏小。
      由中心向外：① 圆形指示盘（LAYOUT.center）→ ② 牌河（DISC_ZONE）
      → ③ 牌墙方环（WALL_GEO，内表面到中心恒为 rIn）→ ④ 四家手牌 / 副露 / 座位牌。
      rIn 由「牌墙外沿 + 余量 ≤ 玩家副露上沿（LAYOUT.meld0.y = 694）」定死：
        cy + rIn + 46(整墩深) + 8(余量) ≤ 694，cy = 400  →  rIn ≤ 240。 */
  /** ── 同心三层布局骨架（照参考图量测：方环占桌面宽 64.5% / 高 81.5%）──────────────
      用户验收要求：方环外接框 **宽 ≥0.60 × 桌面宽、高 ≥0.78 × 桌面高**。
      绒面 1212×832 → 目标外接框 ≥728 × ≥649。方环做成**略微扁的矩形**（728×650），
      因为画布是 1240×860（1.44:1），正方形方环不可能同时满足两个比例。
      由中心向外：① 圆形指示盘 → ② 牌河 → ③ 牌墙方环 → ④ 四家手牌 / 副露 / 座位牌。 */
  var RING = { cx: 620, cy: 380, rInX: 318, rInY: 279, gap: 2, depth: 22 };
  /** 弃牌区（牌河）：**紧贴指示盘外圈**、朝心排列、每行 6 张、牌牌紧密。
      牌河带宽：竖 279−58 = 221px（4 行 × 50）· 横 318−58 = 260px（4 列 × 38）。 */
  var DISC_ZONE = {
    0: { x: 507, y: 609, perRow: 6, dir: "up" },
    1: { x: 680, y: 231, perRow: 6, dir: "right" },
    2: { x: 507, y: 103, perRow: 6, dir: "down" },
    3: { x: 524, y: 231, perRow: 6, dir: "left" }
  };
  /** 门风：你(下) / 金老板(右) / 红姐(上) / 顾曼(左)
      同心重排后：三家座位牌一律贴在自己**副露的外侧**（朝方环反向），三家对称。 */
  /** 门风：你(下) / 金老板(右) / 红姐(上) / 顾曼(左)
      同心重排后：三家座位牌一律贴在自己**副露的外侧**（朝方环反向），三家对称。 */
  /** 门风：你(下) / 金老板(右) / 红姐(上) / 顾曼(左)
      方环放大后：三家座位牌一律贴在自己**副露的外侧**，三家对称。 */
  var SEAT_POS = {
    0: { x: 62, y: 762, align: "left" },
    1: { x: 1070, y: 365, align: "left" },
    2: { x: 810, y: 20, align: "left" },
    3: { x: 40, y: 365, align: "left" }
  };

  /* ── 牌面几何（严格照「麻将零基础教学」标准参考图） ──
     筒：圆点「双圈 + 描边」，大小一致 / 间距均匀；条：竹节圆头竖条；
     坐标均为「牌面内」0~1 比例，(x, y) 是点心 / 棒心。 */
  var DOT_POS = {
    1: [[.50, .50]],
    2: [[.50, .27], [.50, .73]],                                                    // 上下两圆（上绿 / 下墨）
    3: [[.26, .24], [.50, .50], [.74, .76]],                                        // 斜排三圆（绿 → 红 → 墨）
    4: [[.29, .29], [.71, .29], [.29, .71], [.71, .71]],                            // 2×2：左上 / 右下绿，右上 / 左下墨
    5: [[.24, .225], [.76, .225], [.50, .50], [.24, .775], [.76, .775]],            // 四角绿(左上/右下)+墨(右上/左下) + 中心红
    6: [[.28, .215], [.72, .215], [.28, .545], [.72, .545], [.28, .855], [.72, .855]],  // 上排 2 红 + 下 2×2 绿
    7: [[.22, .30], [.50, .215], [.78, .13], [.29, .60], [.71, .60], [.29, .875], [.71, .875]],  // 上 3 斜排红（右高）+ 下 2×2 绿
    8: [[.30, .135], [.70, .135], [.30, .385], [.70, .385], [.30, .635], [.70, .635], [.30, .885], [.70, .885]],  // 2 列 × 4 行（墨）
    9: [[.245, .205], [.50, .205], [.755, .205], [.245, .50], [.50, .50], [.755, .50], [.245, .795], [.50, .795], [.755, .795]]  // 3×3：上绿 / 中红 / 下墨
  };
  /* 筒的配色严格照参考图 1：2 上绿下墨 · 3 绿红墨斜排 · 4 对角绿墨 · 5 四角绿墨 + 中心红 ·
     6 上 2 红 + 下 4 绿 · 7 上 3 红斜排 + 下 4 绿 · 8 全墨 2×4 · 9 上绿中红下墨 */
  var DOT_COL = {
    1: [C_RED],
    2: [C_GREEN, C_INK],
    3: [C_GREEN, C_RED, C_INK],
    4: [C_GREEN, C_INK, C_INK, C_GREEN],
    5: [C_GREEN, C_INK, C_RED, C_INK, C_GREEN],
    6: [C_RED, C_RED, C_GREEN, C_GREEN, C_GREEN, C_GREEN],
    7: [C_RED, C_RED, C_RED, C_GREEN, C_GREEN, C_GREEN, C_GREEN],
    8: [C_INK, C_INK, C_INK, C_INK, C_INK, C_INK, C_INK, C_INK],
    9: [C_GREEN, C_GREEN, C_GREEN, C_RED, C_RED, C_RED, C_INK, C_INK, C_INK]
  };
  /** 圆点半径（牌面短边比例）：1 筒大靶心，2 筒大圆，其余按行列数收敛（保证双圈 + 靶心不糊） */
  var DOT_R = { 1: .360, 2: .215, 3: .160, 4: .165, 5: .120, 6: .135, 7: .120, 8: .115, 9: .120 };
  var TIAO_POS = {
    /* 条：竹节竖条几何（照参考图 1 逐张对齐）。坐标是「牌面内」0~1 比例：(x, y) = 单根竹节的心。
       sw = 单根宽 / 牌面宽，sh = 单根高 / 牌面高；red = 染红的那些根的下标。
       纪律（写死在这里，改表时一起看）：
         · 单根宽 ≤ 牌面宽 1/5：sw 最大 .175 → 手牌 56×78（牌面 47.6 宽）下单根 8.3px ≤ 9.5px ✔
         · 相邻两根的净缝（手牌 56×78 / 牌面 47.6×69.6 下）：最小 2.78px（5 条上下角↔心），
           其次 9 条行间 3.13px · 8 条列间 4.06px · 6 条列间 4.95px —— 都分得开
         · 行列数严格照参考图：2=1列×2行 · 3=上1下2 · 4=2×2 · 5=四角4+中心红1 ·
           6=3列×2行 · 7=上1红+下2行×3列绿 · 8=4列×2行 · 9=3×3（中列红） */
    2: { p: [[.50, .275], [.50, .725]], sw: .175, sh: .400 },
    3: { p: [[.50, .255], [.28, .745], [.72, .745]], sw: .175, sh: .320 },
    4: { p: [[.285, .29], [.715, .29], [.285, .71], [.715, .71]], sw: .175, sh: .320 },
    5: { p: [[.265, .225], [.735, .225], [.50, .50], [.265, .775], [.735, .775]], sw: .160, sh: .235, red: [2] },
    6: { p: [[.24, .28], [.50, .28], [.76, .28], [.24, .72], [.50, .72], [.76, .72]], sw: .155, sh: .300 },
    7: { p: [[.50, .145], [.24, .47], [.50, .47], [.76, .47], [.24, .815], [.50, .815], [.76, .815]], sw: .155, sh: .245, red: [0] },
    8: { p: [[.185, .285], [.395, .285], [.605, .285], [.815, .285], [.185, .715], [.395, .715], [.605, .715], [.815, .715]], sw: .125, sh: .330 },
    9: { p: [[.205, .22], [.50, .22], [.795, .22], [.205, .50], [.50, .50], [.795, .50], [.205, .78], [.50, .78], [.795, .78]], sw: .160, sh: .235, red: [1, 4, 7] }
  };
  /** 字牌配色：东南西北 黑 / 中 红 / 發 绿 / 白 墨色双线（参考图 1 的白板即黑色双线空框，不是蓝框）*/

  var HONOR_COL = { "东": C_INK, "南": C_INK, "西": C_INK, "北": C_INK, "中": C_RED, "發": C_GREEN, "白": C_INK };  /* 白板画成墨色双线空框，见 drawHonorFace */
  /* 牌面「墨线」色：细深色描边（参考图是扁平清爽风，不用厚 3D 斜切） */
  var C_LINE = "#4a4237", C_IVORY = "#fffdf7";
  /* 总览图行标签：下标同 tileGroup（万=0 / 条=1 / 筒=2 / 字=3） */
  var SUIT_ROW_LABEL = ["万", "条", "筒", "字牌"];


  function rr(g, x, y, w, h, r) {
    if (r > w / 2) r = w / 2;
    if (r > h / 2) r = h / 2;
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }
  function fontPx(px) { return "bold " + Math.max(5, px).toFixed(1) + "px " + FONT_CN; }

  /* ── 真牌面：万 / 筒 / 条 / 字牌（严格照标准参考图） ── */
  /** 万：上半 黑色汉字数字（端正居中偏上） + 下半 大号鲜红「萬」（几乎占满下半张牌） */
  function drawWanFace(g, n, x, y, w, h) {
    var cx = x + w / 2;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = C_INK;
    g.font = fontPx(Math.min(h * .30, w * .78));
    g.fillText(CN_NUM[n], cx, y + h * .22);
    g.fillStyle = C_RED;
    g.font = fontPx(Math.min(h * .50, w * .96));
    g.fillText("萬", cx, y + h * .73);
  }
  /**
   * 筒的一个圆点：标准「双圈 + 描边 + 靶心」——彩色外环 → 白圈 → 彩色内环 → 白圈 → 实心点。
   * 小尺寸下投影成两层空心环，缩到副露 / 牌河尺寸仍是「一个点」；线宽 ≥0.95px 保证不糊。
   */
  /**
   * 筒的一个圆点：标准「双圈 + 描边 + 靶心」——彩色外环 → 白圈 → 彩色内环 → 白圈 → 实心点。
   * 线宽按半径走（r*.30），缩到副露 / 牌河尺寸时内环与靶心自动退化，仍读作「一个点」。
   */
  function drawDot(g, cx, cy, r, col) {
    var lw = Math.max(r * .30, 1.05), r2 = Math.max(.7, r - lw / 2);
    g.beginPath(); g.arc(cx, cy, r2, 0, Math.PI * 2);
    g.lineWidth = lw; g.strokeStyle = col; g.stroke();
    g.beginPath(); g.arc(cx, cy, Math.max(r * .55, .9), 0, Math.PI * 2);
    g.lineWidth = Math.max(lw * .80, .95); g.strokeStyle = col; g.stroke();
    if (r >= 5) {                                        // 靶心（太小时省略，避免糊成实心团）
      g.beginPath(); g.arc(cx, cy, Math.max(r * .20, .85), 0, Math.PI * 2);
      g.fillStyle = col; g.fill();
    }
  }

  /** 一筒：大靶心（深绿外环 + 白色花瓣圈 + 红心白十字）——照参考图 1 的画法 */
  function drawTong1(g, cx, cy, R) {
    var i, a, n = 16, ring = Math.max(R * .12, .8), pr = Math.max(R * .175, .7), prr = R * .655;
    g.beginPath(); g.arc(cx, cy, Math.max(R - ring / 2, .8), 0, Math.PI * 2);
    g.lineWidth = ring; g.strokeStyle = "#1c4f33"; g.stroke();
    for (i = 0; i < n; i++) {                            // 白花瓣圈（16 瓣）
      a = i / n * Math.PI * 2;
      g.beginPath(); g.arc(cx + Math.cos(a) * prr, cy + Math.sin(a) * prr, pr, 0, Math.PI * 2);
      g.fillStyle = "#fdfbf4"; g.fill();
      g.lineWidth = Math.max(R * .035, .55); g.strokeStyle = "#1c4f33"; g.stroke();
    }
    g.beginPath(); g.arc(cx, cy, Math.max(R * .45, .9), 0, Math.PI * 2);
    g.fillStyle = C_RED; g.fill();
    g.lineWidth = Math.max(R * .05, .7); g.strokeStyle = "#7d1717"; g.stroke();
    g.strokeStyle = "#fdfbf4"; g.lineWidth = Math.max(R * .10, .9);
    g.beginPath();
    g.moveTo(cx - R * .34, cy); g.lineTo(cx + R * .34, cy);
    g.moveTo(cx, cy - R * .34); g.lineTo(cx, cy + R * .34);
    g.stroke();
  }
  function drawTongFace(g, n, x, y, w, h) {
    var pos = DOT_POS[n], col = DOT_COL[n], i;
    var r = DOT_R[n] * Math.min(w, h * .96);
    if (n === 1) { drawTong1(g, x + pos[0][0] * w, y + pos[0][1] * h, r); return; }
    for (i = 0; i < pos.length; i++) {
      drawDot(g, x + pos[i][0] * w, y + pos[i][1] * h, r, col[i]);
    }
  }

  /**
   * 一根竹节（照参考图 1 的画法）：圆头长条 + 中段内收的「节纹」 + 白色细长内芯。
   * 为什么这么画：原来画成「两段实心圆头 + 一条节纹」，缩小后连成珠串，数不出条数。
   * 现在每根都是**一条独立、细长、带白芯的竖条**：白芯把相邻两根的绿分开，
   * 手牌 56×78 下单根 8.3×22px、净缝 ≥3px，一眼能数。
   */
  function drawStick(g, cx, cy, w, h, col) {
    var hw = w / 2, t = cy - h / 2, b = cy + h / 2;
    var r = Math.min(hw, h * .42);                 // 圆头半径
    var ny = h * .085, nw = hw * .62;              // 节纹：半高 / 节处半宽
    g.beginPath();
    g.moveTo(cx - hw + r, t);
    g.lineTo(cx + hw - r, t);
    g.quadraticCurveTo(cx + hw, t, cx + hw, t + r);
    g.lineTo(cx + hw, cy - ny);
    g.quadraticCurveTo(cx + hw, cy, cx + nw, cy);           // 内收（节纹上半）
    g.quadraticCurveTo(cx + hw, cy, cx + hw, cy + ny);      // 外扩
    g.lineTo(cx + hw, b - r);
    g.quadraticCurveTo(cx + hw, b, cx + hw - r, b);
    g.lineTo(cx - hw + r, b);
    g.quadraticCurveTo(cx - hw, b, cx - hw, b - r);
    g.lineTo(cx - hw, cy + ny);
    g.quadraticCurveTo(cx - hw, cy, cx - nw, cy);
    g.quadraticCurveTo(cx - hw, cy, cx - hw, cy - ny);
    g.lineTo(cx - hw, t + r);
    g.quadraticCurveTo(cx - hw, t, cx - hw + r, t);
    g.closePath();
    g.fillStyle = col; g.fill();
    var iw = w * .44, ih = h * .64;                // 白色内芯（细长圆头槽）
    if (h >= 7 && w >= 3) {
      rr(g, cx - iw / 2, cy - ih / 2, iw, ih, Math.min(iw / 2, ih * .30));
      g.fillStyle = "#fdfbf4"; g.fill();
    }
  }
  /**
   * 一条：工笔绿鸟（照参考图 1）——绿冠 / 白眼红瞳 / 绿身白腹 / 胸羽三笔 / 下垂长尾 / 右侧圆点。
   * 参考图是手绘工笔，这里用矢量按同一构图重画：色块 + 描边，缩到副露尺寸仍认得出是「鸟」。
   */
  /**
   * 一条：工笔绿鸟（照参考图 1 的构图：绿冠 / 白眼红瞳 / 黄喙 / 绿身白翅 / 胸羽三笔 /
   * 下垂长尾 / 双爪 / 右侧圆点）。参考图是手绘工笔，这里用矢量按同一构图重画，
   * 缩到副露 34×46 仍认得出是「鸟」而不是一团绿。
   */
  function drawBird(g, cx, cy, s) {
    var X = cx, Y = cy, i;
    var DK = "#17583a", MD = "#2f7d4f", LT = "#e9f3e8";
    var lw = Math.max(s * .020, .7);
    g.lineJoin = "round"; g.lineCap = "round";
    /* ① 长尾：从身体往左下甩出、尾端收细（参考图最抢眼的一笔，直落到牌面下部） */
    g.beginPath();
    g.moveTo(X + s * .02, Y + s * .10);
    g.quadraticCurveTo(X - s * .16, Y + s * .26, X - s * .21, Y + s * .50);
    g.quadraticCurveTo(X - s * .05, Y + s * .40, X + s * .09, Y + s * .20);
    g.closePath();
    g.fillStyle = LT; g.fill();
    g.strokeStyle = DK; g.lineWidth = lw * 1.3; g.stroke();
    g.beginPath();                                       // 尾羽内两笔
    g.moveTo(X - s * .02, Y + s * .17); g.lineTo(X - s * .10, Y + s * .40);
    g.moveTo(X + s * .06, Y + s * .15); g.lineTo(X - s * .01, Y + s * .35);
    g.lineWidth = Math.max(lw * .9, .5); g.stroke();
    /* ② 身体：向右下微倾的圆身（绿底 + 深绿描边） */
    g.beginPath();
    if (g.ellipse) g.ellipse(X + s * .01, Y + s * .03, s * .255, s * .250, -.12, 0, Math.PI * 2);
    else g.arc(X + s * .01, Y + s * .03, s * .25, 0, Math.PI * 2);
    g.fillStyle = MD; g.fill();
    g.strokeStyle = DK; g.lineWidth = lw * 1.3; g.stroke();
    /* ③ 头：左上方的圆头（与身体连成一体） */
    g.beginPath();
    if (g.ellipse) g.ellipse(X - s * .145, Y - s * .225, s * .175, s * .172, 0, 0, Math.PI * 2);
    else g.arc(X - s * .145, Y - s * .225, s * .17, 0, Math.PI * 2);
    g.fillStyle = MD; g.fill(); g.stroke();
    /* ④ 喙：朝左的小三角（参考图的黄喙） */
    g.beginPath();
    g.moveTo(X - s * .295, Y - s * .245);
    g.lineTo(X - s * .465, Y - s * .175);
    g.lineTo(X - s * .285, Y - s * .125);
    g.closePath();
    g.fillStyle = "#d9a24a"; g.fill();
    g.strokeStyle = DK; g.lineWidth = Math.max(lw * 1.1, .6); g.stroke();
    /* ⑤ 冠羽：头顶向右上甩出的一钩（参考图的标志性造型） */
    g.beginPath();
    g.moveTo(X - s * .235, Y - s * .345);
    g.quadraticCurveTo(X - s * .05, Y - s * .545, X + s * .175, Y - s * .40);
    g.quadraticCurveTo(X - s * .02, Y - s * .42, X - s * .13, Y - s * .285);
    g.closePath();
    g.fillStyle = DK; g.fill();
    /* ⑥ 胸羽三笔（眼睛下方的深绿短竖线） */
    g.strokeStyle = DK; g.lineWidth = Math.max(lw * 1.6, .85);
    for (i = 0; i < 3; i++) {
      g.beginPath();
      g.moveTo(X - s * .245 + i * s * .085, Y - s * .055);
      g.lineTo(X - s * .225 + i * s * .085, Y + s * .085);
      g.stroke();
    }
    /* ⑦ 翅：身体上的一道浅色弧 */
    g.beginPath();
    g.moveTo(X + s * .02, Y - s * .10);
    g.quadraticCurveTo(X + s * .21, Y + s * .02, X + s * .07, Y + s * .21);
    g.strokeStyle = LT; g.lineWidth = Math.max(lw * 1.8, 1); g.stroke();
    /* ⑧ 白眼 + 红瞳（参考图：白眼球 / 深绿描边 / 红心瞳） */
    g.beginPath(); g.arc(X - s * .16, Y - s * .235, Math.max(s * .120, 1.2), 0, Math.PI * 2);
    g.fillStyle = "#fdfbf4"; g.fill();
    g.strokeStyle = DK; g.lineWidth = Math.max(lw * 1.4, .75); g.stroke();
    g.beginPath(); g.arc(X - s * .175, Y - s * .235, Math.max(s * .052, .8), 0, Math.PI * 2);
    g.fillStyle = "#cf5a5a"; g.fill();
    /* ⑨ 右侧圆点（参考图身体右侧的小白圈） */
    g.beginPath(); g.arc(X + s * .315, Y + s * .075, Math.max(s * .070, .75), 0, Math.PI * 2);
    g.fillStyle = "#fdfbf4"; g.fill();
    g.strokeStyle = DK; g.lineWidth = Math.max(lw * 1.1, .6); g.stroke();
    /* ⑩ 双爪 */
    g.strokeStyle = DK; g.lineWidth = Math.max(lw * 1.5, .8);
    g.beginPath();
    g.moveTo(X - s * .075, Y + s * .255); g.lineTo(X - s * .125, Y + s * .40);
    g.moveTo(X + s * .075, Y + s * .255); g.lineTo(X + s * .045, Y + s * .40);
    g.stroke();
  }


  function drawTiaoFace(g, n, x, y, w, h) {
    if (n === 1) { drawBird(g, x + w * .5, y + h * .50, Math.min(w, h * .96) * 1.10); return; }
    var t = TIAO_POS[n], i, p, col;
    var sw = t.sw * w, sh = t.sh * h;
    for (i = 0; i < t.p.length; i++) {
      p = t.p[i];
      col = (t.red && t.red.indexOf(i) >= 0) ? C_RED : C_GREEN;
      drawStick(g, x + p[0] * w, y + p[1] * h, sw, sh, col);
    }
  }
  /** 字牌：东南西北 黑色大字（占满牌面）/ 中 红 / 發 绿 / 白 墨色双线空心框（照参考图 1） */

  function drawHonorFace(g, t, x, y, w, h) {
    var m = Math.min(w, h);
    if (t === "白") {
      /* 参考图 1 的白板 = 墨色双线空心框：外框粗、内框细、内框四角带斜切小三角 */
      var pad = m * .13, bw = Math.min(m, w) - pad * 2, bh = h - pad * 2;
      var bx = x + (w - Math.min(m, w)) / 2 + pad;
      g.strokeStyle = C_INK;
      g.lineWidth = Math.max(m * .095, 1.8);
      rr(g, bx, y + pad, bw, bh, Math.max(m * .05, 2)); g.stroke();
      var ip = Math.max(m * .13, 2.2), ix = bx + ip, iy = y + pad + ip;
      var iw = bw - ip * 2, ih = bh - ip * 2;
      if (iw > 1 && ih > 1) {
        g.lineWidth = Math.max(m * .040, .9);
        rr(g, ix, iy, iw, ih, Math.max(m * .03, 1.2)); g.stroke();
        var k = Math.max(m * .075, 1.6);                 // 四角斜切小三角
        g.beginPath();
        g.moveTo(ix, iy + k); g.lineTo(ix + k, iy); g.lineTo(ix + k * 1.7, iy);
        g.lineTo(ix, iy + k * 1.7); g.closePath();
        g.moveTo(ix + iw, iy + k); g.lineTo(ix + iw - k, iy); g.lineTo(ix + iw - k * 1.7, iy);
        g.lineTo(ix + iw, iy + k * 1.7); g.closePath();
        g.moveTo(ix, iy + ih - k); g.lineTo(ix + k, iy + ih); g.lineTo(ix + k * 1.7, iy + ih);
        g.lineTo(ix, iy + ih - k * 1.7); g.closePath();
        g.moveTo(ix + iw, iy + ih - k); g.lineTo(ix + iw - k, iy + ih); g.lineTo(ix + iw - k * 1.7, iy + ih);
        g.lineTo(ix + iw, iy + ih - k * 1.7); g.closePath();
        g.fillStyle = C_INK; g.fill();
      }
      return;
    }
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = HONOR_COL[t] || C_INK;
    g.font = fontPx(Math.min(h * .82, w * (t.length > 1 ? .46 : .96)));
    g.fillText(t, x + w / 2, y + h * .54);
  }


  /**
   * 画一张牌正面：扁平清爽风（象牙白打底 + 细深色描边 + 小圆角 ≈ 牌宽 8%），
   * 不做厚重 3D 斜切，只留 1px 落影把牌「贴」在绿绒上。
   * o: { hl:金描边, alpha, gw:牌面绘制宽度, tilt:顶部内收像素(0=不倾斜，默认 0) }
   */
  function drawTileFace(g, t, x, y, w, h, o) {
    o = o || {};
    var m = Math.min(w, h);
    var r = Math.max(2, w * .08);                                 // 圆角半径 ≈ 牌宽 8%
    var ins = o.tilt || 0;
    function path(px, py, pw, ph, pr) { if (ins) tiltPath(g, px, py, pw, ph, pr, ins); else rr(g, px, py, pw, ph, pr); }
    g.save();
    if (o.alpha != null) g.globalAlpha = o.alpha;
    // ① 极轻落影（不是厚 3D）：让白牌在绿绒上有轮廓，不发灰
    g.save();
    g.shadowColor = "rgba(0,0,0,.42)";
    g.shadowBlur = Math.max(1.5, w * .07);
    g.shadowOffsetX = 0; g.shadowOffsetY = Math.max(1, h * .014);
    g.fillStyle = "#8a8378";
    path(x, y, w, h, r); g.fill();
    g.restore();
    // ② 牌身：象牙白 → 米白（很浅的纵向渐变，保持扁平）
    var grd = g.createLinearGradient(x, y, x, y + h);
    grd.addColorStop(0, "#fffefa"); grd.addColorStop(.55, "#fbf7ee"); grd.addColorStop(1, "#f1ead9");
    g.fillStyle = grd;
    path(x, y, w, h, r); g.fill();
    // ③ 内侧高光（一条，极淡）
    if (m >= 22) {
      g.save();
      path(x, y, w, h, r); g.clip();
      g.strokeStyle = "rgba(255,255,255,.95)"; g.lineWidth = Math.max(1, m * .045);
      g.beginPath(); g.moveTo(x + r, y + m * .035); g.lineTo(x + w - r, y + m * .035); g.stroke();
      g.restore();
    }
    // ④ 细深色描边（≥1.6px：绿绒上轮廓清晰）
    g.strokeStyle = C_LINE; g.lineWidth = Math.max(1.6, m * .045);
    path(x + .8, y + .8, w - 1.6, h - 1.6, r); g.stroke();
    // ⑤ 金色描边（刚摸到 / 最近打出）
    if (o.hl) {
      g.save();
      g.shadowColor = "rgba(255,208,86,.85)"; g.shadowBlur = Math.max(6, w * .30);
      g.strokeStyle = "#ffd76e"; g.lineWidth = Math.max(2, w * .055);
      path(x + 1.2, y + 1.2, w - 2.4, h - 2.4, r); g.stroke();
      g.restore();
    }
    // ⑥ 牌面
    var pad = Math.max(1.4, m * .075);
    var full = w - pad * 2;
    var gw = o.gw ? Math.min(o.gw, full) : full;
    var gx = x + (gw < full ? Math.max(1, (w - gw) * .22) : pad);
    var gy = y + pad, gh = h - pad * 2;
    if (isHonor(t)) drawHonorFace(g, t, gx, gy, gw, gh);
    else {
      var s = suitOf(t), n = numOf(t);
      if (s === "万") drawWanFace(g, n, gx, gy, gw, gh);
      else if (s === "筒") drawTongFace(g, n, gx, gy, gw, gh);
      else drawTiaoFace(g, n, gx, gy, gw, gh);
    }
    g.restore();
  }
  /** 3D 立牌牌背的几何 / 配色常量（照放大参考图：一面绿、一面象牙白、右下有厚度暗面）
      edge  = 象牙白棱边厚 / 牌深（参考图 绿 44 : 白 18 → 白占 0.29，取 0.28）
      line  = 绿面与白棱之间的细阴影线 / 牌深（也是「两张牌」之间的分界）
      thick = 右下暗面（牌厚）/ 短边
      r     = 圆角半径 / 短边 */
  var BACK3D = {
    edge: .28, edgeThin: .24, line: .05, thick: .11, r: .20,
    /* 绿面（上亮下暗，饱满绿）*/
    greenA: "#4cb87c", greenM: "#3a9d63", greenB: "#2b7d4a",
    greenDimA: "#3d9765", greenDimM: "#2f8151", greenDimB: "#22663c",
    /* 象牙白棱边（外亮内暗）*/
    ivoryA: "#faf6ec", ivoryB: "#d6d0c0",
    ivoryDimA: "#ded8c9", ivoryDimB: "#b9b3a3",
    /* 绿面 / 白棱 之间的分界阴影线；右下暗面（牌厚）*/
    lineC: "#0d3a22",
    darkA: "#1d5c39", darkB: "#123f26",
    darkDimA: "#17502f", darkDimB: "#0e3520",
    rim: "rgba(9,38,24,.55)"
  };
  /**
   * 牌背：**立起来的 3D 麻将牌**（照放大参考图）—— 一面绿、一面象牙白。
   *   · 绿面主面（朝桌心 / 朝我们）：饱满绿色竖向渐变（上亮下暗），占 (1 − edge − line) 牌深
   *   · 象牙白棱边：牌体的厚度那一面，紧贴绿面、在牌的**外侧**那一边
   *     —— 对家手牌 / 上下牌墙在顶（底）边，左右侧牌墙与左右家在侧棱（用户原话「一面绿一面白」）
   *   · 绿面与白棱之间一条细阴影线；两张牌叠放时它也充当两枚之间的分界
   *   · 右下留出深绿暗面 = 牌的厚度 + 落影；圆角 + 细描边
   *   · **没有任何斜纹 / 花纹**（用户明确要求：不要斜杠）
   *   · 同一套画法用在三处：① 牌墙每一枚（一墩两枚）② 三家对家手牌背面 ③ 暗杠盖着的那两张
   *   · 尺寸只由调用方给的 (w,h) 与 o.edge 决定 —— 同组内每枚尺寸完全一致（只旋转不缩放）
   * ⚠ art/icons/mj/tile_back.png 是「深蓝 + 鱼鳞纹」的一版素材，与「纯色、无花纹」冲突，
   *   按用户指示改为纯色矢量画法，该素材**故意不接**（与 tile_white / tile_fa 同理）。
   * o: { edge: "top"|"right"|"bottom"|"left"（象牙白棱边所在那一边，默认 top）,
   *      dim:  true = 整体压暗（下张牌「被上张压住」的层次） }
   */
  function drawTileBack(g, x, y, w, h, o) {
    o = o || {};
    var B = BACK3D, side = o.edge || "top", dim = !!o.dim;
    var vert = (side === "left" || side === "right");          // 棱边在左右 → 沿 x 切分
    var m = Math.min(w, h);
    var r = Math.max(1.6, m * B.r);                            // 圆角
    var tk = Math.max(1.1, m * B.thick);                       // 右下暗面（牌厚）
    var fx = x, fy = y, fw = w - tk, fh = h - tk;              // 顶面（其余留给右下暗面）
    var fr = Math.max(1.2, r * .62);
    var along = vert ? fw : fh;                                // 顶面沿「切分轴」的长度
    /* 象牙白棱边厚：牌墙「外枚」用 thin（窄白棱压在本段外沿）；牌墙「内枚」用 noEdge（不画白棱，
       只靠分界阴影线区分两枚）→ 整段看起来是**一条连续绿带 + 上沿一条白棱**，而不是一圈白条纹。*/
    var e = o.noEdge ? 0 : Math.max(2, along * (o.thin ? B.edgeThin : B.edge));
    var ln = Math.max(1, along * B.line);                      // 绿面 / 白棱 之间的细阴影线
    var gd = Math.max(2, along - e - ln);                      // 绿面厚
    var gA = g.createLinearGradient(fx, fy, fx, fy + fh);
    var iA = g.createLinearGradient(fx, fy, fx, fy + fh);
    /* a / b 是从「棱边反向那一端」起算的坐标 → 同一段代码支持四个朝向 */
    function seg(a, b, grad, col) {
      var sx, sy, sw, sh;
      if (vert) { sx = fx + (side === "left" ? (along - b) : a); sy = fy; sw = b - a; sh = fh; }
      else { sx = fx; sy = fy + (side === "top" ? (along - b) : a); sw = fw; sh = b - a; }
      g.fillStyle = grad || col;
      g.fillRect(sx, sy, sw, sh);
    }
    gA.addColorStop(0, dim ? B.greenDimA : B.greenA);
    gA.addColorStop(.55, dim ? B.greenDimM : B.greenM);
    gA.addColorStop(1, dim ? B.greenDimB : B.greenB);
    iA.addColorStop(0, dim ? B.ivoryDimA : B.ivoryA);
    iA.addColorStop(1, dim ? B.ivoryDimB : B.ivoryB);
    g.save();
    /* ① 落影 */
    g.save();
    g.shadowColor = "rgba(0,0,0,.45)"; g.shadowBlur = Math.max(2, m * .19);
    g.shadowOffsetX = 0; g.shadowOffsetY = Math.max(1, m * .06);
    g.fillStyle = "#0e2c1d"; rr(g, x, y, w, h, r); g.fill();
    g.restore();
    /* ② 厚度暗面：整块先铺深绿，顶面内缩后**右下**露出来就是牌厚 */
    var gs = g.createLinearGradient(x, y, x + w * .30, y + h);
    gs.addColorStop(0, dim ? B.darkDimA : B.darkA);
    gs.addColorStop(1, dim ? B.darkDimB : B.darkB);
    g.fillStyle = gs; rr(g, x, y, w, h, r); g.fill();
    /* ③ 顶面 = 绿面 + 细阴影线 + 象牙白棱边（三段切分）*/
    g.save();
    rr(g, fx, fy, fw, fh, fr); g.clip();
    seg(0, gd, gA);
    seg(gd, gd + ln, null, B.lineC);
    seg(gd + ln, along, iA);
    /* 绿面远端高光（光源左上，与棱边相反那一侧）→ 立体感；仍然零花纹 */
    var hl = Math.max(1, m * .065), hp = Math.max(1.2, along * .10), hx, hy;
    g.strokeStyle = "rgba(226,255,238,.28)"; g.lineWidth = hl;
    g.beginPath();
    if (vert) { hx = (side === "left" ? fx + fw - hp : fx + hp); g.moveTo(hx, fy + fh * .12); g.lineTo(hx, fy + fh * .88); }
    else { hy = (side === "top" ? fy + fh - hp : fy + hp); g.moveTo(fx + fw * .12, hy); g.lineTo(fx + fw * .88, hy); }
    g.stroke();
    g.restore();
    /* ④ 细描边：整块轮廓 + 顶面轮廓（小尺寸下也看得出「这是一枚牌」）*/
    g.strokeStyle = B.rim; g.lineWidth = Math.max(1, m * .05);
    rr(g, x + .6, y + .6, w - 1.2, h - 1.2, r); g.stroke();
    g.strokeStyle = "rgba(9,38,24,.42)"; g.lineWidth = 1;
    rr(g, fx + .4, fy + .4, fw - .8, fh - .8, fr); g.stroke();
    g.restore();
    if (G.stat) {
      G.stat.backSolid = (G.stat.backSolid || 0) + 1;
      G.stat.backGreen = (G.stat.backGreen || 0) + 1;        // 绿面块数（取证）
      G.stat.backIvory = (G.stat.backIvory || 0) + 1;        // 象牙白棱边块数（取证）
    }
    G.tileBackSolid = (G.tileBackSolid || 0) + 1;
  }

  function drawGlowPlate(g, x, y, w, h, r, color, blur) {
    g.save();
    g.shadowColor = color; g.shadowBlur = blur;
    g.strokeStyle = color; g.lineWidth = 2;
    rr(g, x, y, w, h, r); g.stroke();
    g.restore();
  }

  /* ── 桌面 / 牌墙 ── */
  /** 包间背景贴图（art/bg/mahjong.png）：等比 cover 铺满整块画布、水平居中。
      贴图不可用 → 返回 false，调用方回退原来的程序化绿绒。 */
  function drawRoomBg(g) {
    var img = bgArt();
    if (!img) return false;
    var nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
    if (!(nw > 0) || !(nh > 0)) return false;
    var arImg = nw / nh, arView = W / H, sw, sh;
    if (Math.abs(arImg - arView) / arView <= 0.02) { sw = nw; sh = nh; }
    else if (arImg > arView) { sh = nh; sw = nh * arView; } else { sw = nw; sh = nw / arView; }
    g.drawImage(img, (nw - sw) / 2, (nh - sh) / 2, sw, sh, 0, 0, W, H);
    return true;
  }
  function noisePattern(g) {
    if (G.noise) return G.noise;
    var c = doc.createElement("canvas"); c.width = c.height = 96;
    var cg = c.getContext("2d"), i, x, y;
    cg.fillStyle = "rgba(0,0,0,0)"; cg.fillRect(0, 0, 96, 96);
    for (i = 0; i < 2600; i++) {
      x = Math.random() * 96; y = Math.random() * 96;
      var v = Math.random();
      cg.fillStyle = v > .5 ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.07)";
      cg.fillRect(x, y, 1, 1);
    }
    G.noise = g.createPattern(c, "repeat");
    return G.noise;
  }
  function drawFelt(g) {
    /* 最底层：本批 Lovart 的「中式茶室包间」背景（深绿绒布方桌留空 + 四把木椅 + 暖光吊灯）。
       贴图不可用 → 回退程序化绿绒（下面的径向渐变），功能一点不少。
       铺完再压一层轻微暗场：牌面 / 金框 / 提示在照片背景上仍然读得清。 */
    var roomBg = false;
    try { roomBg = drawRoomBg(g); } catch (e) { roomBg = false; }
    G.roomBg = roomBg;
    if (roomBg) {
      g.fillStyle = "rgba(6,10,8,.34)"; g.fillRect(0, 0, W, H);
      g.fillStyle = "rgba(255,215,110,.05)";
      rr(g, LAYOUT.felt.x, LAYOUT.felt.y, LAYOUT.felt.w, LAYOUT.felt.h, LAYOUT.felt.r); g.fill();
    } else {
      g.fillStyle = "#08070c"; g.fillRect(0, 0, W, H);
      var grd = g.createRadialGradient(W / 2, H * .46, 80, W / 2, H * .5, W * .70);
      grd.addColorStop(0, "#22704d"); grd.addColorStop(.5, "#175a3e"); grd.addColorStop(1, "#0b3524");
      g.fillStyle = grd;
      rr(g, LAYOUT.felt.x, LAYOUT.felt.y, LAYOUT.felt.w, LAYOUT.felt.h, LAYOUT.felt.r); g.fill();
    }
    var pat = noisePattern(g);
    if (pat) { g.save(); g.globalAlpha = .55; g.fillStyle = pat; rr(g, LAYOUT.felt.x, LAYOUT.felt.y, LAYOUT.felt.w, LAYOUT.felt.h, LAYOUT.felt.r); g.fill(); g.restore(); }
    // 中央深色绒面圈 + 金线
    g.fillStyle = "rgba(6,32,22,.45)";
    rr(g, 250, 240, W - 500, H - 480, 26); g.fill();
    g.strokeStyle = "rgba(0,0,0,.35)"; g.lineWidth = 8; rr(g, 250, 240, W - 500, H - 480, 26); g.stroke();
    g.strokeStyle = "rgba(255,215,110,.15)"; g.lineWidth = 2; rr(g, 254, 244, W - 508, H - 488, 24); g.stroke();
    // 外缘木框
    g.strokeStyle = "#3a2a18"; g.lineWidth = 14;
    rr(g, LAYOUT.felt.x, LAYOUT.felt.y, LAYOUT.felt.w, LAYOUT.felt.h, LAYOUT.felt.r); g.stroke();
    g.strokeStyle = "rgba(255,215,110,.22)"; g.lineWidth = 2;
    rr(g, LAYOUT.felt.x + 8, LAYOUT.felt.y + 8, LAYOUT.felt.w - 16, LAYOUT.felt.h - 16, LAYOUT.felt.r - 6); g.stroke();
  }
  /* ── 牌桌静态装饰：骰子 / 筹码 / 牌尺 / 烟灰缸（纯装饰，不参与任何规则）───────────
     本批 art/icons/mj/ 里早有 dice / chip_blue / chip_red / chip_gold / ruler / ashtray，
     之前只有 tile_back 接进了渲染。这里把它们点缀到牌桌上，**只增加「画什么」**：
     不碰赣麻规则、不碰 AI、不碰智脑提示算法、不碰结算逻辑、不碰点击热区、不碰牌河布局。

     位置纪律（每一块都按「会变的东西」的保守外接矩形验算过，零相交；见 decorCheck()）——
      本轮**同心三层**重排后，各块保守外接框是：
        · 牌墙方环（双层）：内层内表面四面全等 = 中心 ±222，外层到中心 ±246
            上 x485..755 y134..180 · 下 x485..755 y624..670
            左 x352..398 y267..507 · 右 x842..888 y267..507
        · 四家手牌：下 x186..1054 y752..830（14 张最宽）/ 右 x896..926 y220..584
                    上 x438..802 y96..126          / 左 x314..344 y220..584
        · 副露：下 x437..1057 y690..736 / 右 x932..966  y212..592
                上 x270..970  y56..90   / 左 x274..308 y212..592
        · 牌河（全在方环内侧）：下 x525..715 y456..622 / 上 x525..715 y182..348
                右 x676..802 y277..527 / 左 x438..564 y277..527
        · 中央圆形指示盘 x566..674 y348..456（LAYOUT.center，半径 54）
        · 结算亮牌板铺满 18..W-18 × 18..H-18 —— **结算分支根本不画装饰**（见 renderTable），
          所以结构上不可能被结算面板遮住，也不可能遮住它
        · DOM 覆盖层：智脑提示在左上（1.2%/1.0%）、HUD 在顶部一条、牌局记录 + 按钮在右下
      于是剩下两块空地（都在方环**外面**的空档里，且留 8px 以上余量）：
        A x 1057..1226 y 524..752 —— 玩家右手边：两枚骰子（dice.png 素材本身就是两枚）
                                     + 一摞金筹码 + 红 / 蓝筹码各一枚
        B x 77..213   y 527..733 —— 桌子左侧窄条（在左家副露更外侧，智脑面板下方）：牌尺 + 烟灰缸
     ⚠ tile_white / tile_fa 故意**不接**：立着的白板 / 发财与牌河里打出去的牌长得一模一样，
        摆上去就是凭空多两张「假弃牌」，直接破坏牌河与手牌的可读性 —— 明确不做（报告里写明）。

     回退（规格「贴图优先 + 矢量 / 不画 回退」三档都实现）：
       · 骰子：贴图不可用 → 矢量两枚骰子（点数写成常量 FACE，不随机 → 出图 / 截图可复现）
       · 筹码：贴图不可用 → 矢量圆片（同色外圈 + 白内环；金筹码画 4 片表示一摞）
       · 牌尺 / 烟灰缸：贴图不可用 → **不画**（纯点缀，少一件玩法一点不受影响）
     载入器仍是 artOf()（预加载 + naturalWidth > 0 + complete !== false），
     路径仍由 pageDir() + art/icons/mj/ 拼出来 —— 无盘符 / 无协议 / 无 data URI。 */
  var DECOR = {
    /* dice.png 素材本身就是「两枚骰子」一版画 → 只画一次就是桌上两枚，避免四枚的怪画面 */
    /* dice.png 素材本身就是「两枚骰子」一版画 → 只画一次就是桌上两枚，避免四枚的怪画面。
       同心重排后装饰整体挪到方环**外侧**的空地：右下角（骰子）+ 右侧空档（三枚筹码）。*/
    /* 同心重排后装饰让到方环**外侧**两条竖条空地：左 x14..178（牌尺 + 烟灰缸）、右 x1062..1226（骰子 + 三枚筹码）。
       dice.png 素材本身就是「两枚骰子」一版画 → 只画一次就是桌上两枚，避免四枚的怪画面。*/
    dice:    { x: 1144, y: 300, s: 100, rot: -0.10, id: "dice" },
    /* chip_gold.png 本身就是一摞四片；红 / 蓝是单片 → 三件摆成一小簇 */
    chips:   [ { x: 1140, y: 460, s: 72, id: "chip_gold", color: "#e0a92e", n: 4 },
               { x: 1090, y: 566, s: 46, id: "chip_red",  color: "#c0392b", n: 1 },
               { x: 1146, y: 566, s: 46, id: "chip_blue", color: "#2a6bb5", n: 1 } ],
    ruler:   { x: 96, y: 300, s: 126, id: "ruler" },
    ashtray: { x: 96, y: 560, s: 66,  id: "ashtray" }
  };

  /** 贴图装饰：以 (cx,cy) 为中心等比画 s 宽（可按 rot 旋转）→ 返回是否真的画了 */
  function decorTex(g, id, cx, cy, s, rot) {
    var img = artOf(id);
    if (!img) return false;
    var nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
    if (!(nw > 0) || !(nh > 0)) return false;
    var w = s, h = s * (nh / nw);
    g.save();
    if (rot) { g.translate(cx, cy); g.rotate(rot); g.drawImage(img, -w / 2, -h / 2, w, h); }
    else g.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    g.restore();
    return true;
  }
  /** 骰子点数在牌面内的 3×3 位置（比例）；与矢量兜底共用 */
  var DICE_PIP = [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72], [0.50, 0.50]];
  /** 矢量骰子（兜底）：两枚白方 + 红点；点数是常量（不随机），出图 / 截图可复现 */
  function decorDiceVector(g, cx, cy, s) {
    var FACE = [[0, 1, 4, 2, 3], [0, 4, 3]];              // 第 1 枚 5 点 / 第 2 枚 3 点
    var d = s * 0.46, k, j, x, y, px, py;
    for (k = 0; k < 2; k++) {
      x = cx - s * 0.50 + k * (s * 0.54);
      y = cy - d / 2 + (k ? s * 0.07 : -s * 0.07);
      g.save();
      g.fillStyle = "#f6efe0"; g.strokeStyle = "rgba(84,54,34,.85)"; g.lineWidth = Math.max(1, s * 0.018);
      rr(g, x, y, d, d, d * 0.20); g.fill(); g.stroke();
      g.fillStyle = "#c0392b";
      for (j = 0; j < FACE[k].length; j++) {
        px = x + d * DICE_PIP[FACE[k][j]][0]; py = y + d * DICE_PIP[FACE[k][j]][1];
        g.beginPath(); g.arc(px, py, d * 0.085, 0, Math.PI * 2); g.fill();
      }
      g.restore();
    }
  }
  /** 矢量筹码（兜底）：同色外圈 + 白内环；n 片叠成一摞 */
  function decorChipVector(g, cx, cy, s, color, n) {
    var r = s / 2, step = s * 0.15, i, yy;
    g.save();
    for (i = 0; i < n; i++) {
      yy = cy + (n - 1) * step / 2 - i * step;
      g.fillStyle = color; g.strokeStyle = "rgba(40,24,12,.6)"; g.lineWidth = Math.max(1, s * 0.035);
      if (g.ellipse) { g.beginPath(); g.ellipse(cx, yy, r, r * 0.62, 0, 0, Math.PI * 2); g.fill(); g.stroke(); }
      else { g.beginPath(); g.arc(cx, yy, r * 0.8, 0, Math.PI * 2); g.fill(); g.stroke(); }
      g.strokeStyle = "rgba(255,255,255,.8)"; g.lineWidth = Math.max(1, s * 0.05);
      if (g.ellipse) { g.beginPath(); g.ellipse(cx, yy, r * 0.60, r * 0.36, 0, 0, Math.PI * 2); g.stroke(); }
      else { g.beginPath(); g.arc(cx, yy, r * 0.48, 0, Math.PI * 2); g.stroke(); }
    }
    g.restore();
  }
  /** 每个装饰框（中心 + 边长；旋转的按 1.24 倍外接方框保守放大）*/
  function decorFrames() {
    var out = [], i, d, die = DECOR.dice, chips = DECOR.chips;
    out.push({ name: "dice", x: die.x - die.s * 0.62, y: die.y - die.s * 0.62, w: die.s * 1.24, h: die.s * 1.24 });
    for (i = 0; i < chips.length; i++) {
      d = chips[i];
      out.push({ name: "chip" + i, x: d.x - d.s / 2, y: d.y - d.s / 2, w: d.s, h: d.s });
    }
    out.push({ name: "ruler", x: DECOR.ruler.x - DECOR.ruler.s / 2, y: DECOR.ruler.y - DECOR.ruler.s / 2, w: DECOR.ruler.s, h: DECOR.ruler.s });
    out.push({ name: "ashtray", x: DECOR.ashtray.x - DECOR.ashtray.s / 2, y: DECOR.ashtray.y - DECOR.ashtray.s / 2, w: DECOR.ashtray.s, h: DECOR.ashtray.s });
    return out;
  }
  /** 牌桌上「会变的东西」的保守外接矩形（宁可估大也不能漏；与 layout_a 的常量一一对应）*/
  function decorReserved() {
    var out = [], i, s, slots = wallSlots(), d = LAYOUT.disc;
    /* 牌墙：满墙 34 墩 × 双层 = 68 块，逐块进保留框（最保守） */
    for (i = 0; i < slots.length; i++) { s = slots[i]; out.push({ name: "wall", side: s.side, x: s.x, y: s.y, w: s.w, h: s.h }); }
    /* 四家手牌：下 186..1054（14 张最宽）· 右 x992..1022 · 上 x438..802 · 左 x218..248
       （三家背面一律贴在方环**外表面之外**，间距只有 5~8px → 方环才放得大）*/
    out.push({ name: "hand0", x: 186, y: LAYOUT.hand.y, w: 868, h: LAYOUT.hand.th });
    out.push({ name: "hand1", x: 992, y: 198, w: 30, h: 364 });
    out.push({ name: "hand2", x: 438, y: 20, w: 364, h: 30 });
    out.push({ name: "hand3", x: 218, y: 198, w: 30, h: 364 });
    /* 副露：下（右对齐 x1057 · y711..757）/ 右 x1028..1062 / 上（移到对家手牌**左侧**）x30..430 / 左 x178..212 */
    out.push({ name: "melds0", x: 437, y: LAYOUT.meld0.y, w: 620, h: LAYOUT.meld0.th });
    out.push({ name: "melds1", x: 1028, y: 190, w: 34, h: 380 });
    out.push({ name: "melds2", x: 30, y: 16, w: 400, h: 34 });
    out.push({ name: "melds3", x: 178, y: 190, w: 34, h: 380 });
    /* 牌河：四家统一每行 6 张，全部落在方环**内表面之内**、紧贴指示盘外圈；
       行 / 列组数按「一轮长局最多 4 组」保守估（均由 DISC_ZONE 推出，不写死）*/
    out.push({ name: "disc0", x: DISC_ZONE[0].x, y: DISC_ZONE[0].y - 3 * d.sy, w: 5 * d.sx + d.tw, h: 3 * d.sy + d.th });
    out.push({ name: "disc2", x: DISC_ZONE[2].x, y: DISC_ZONE[2].y, w: 5 * d.sx + d.tw, h: 3 * d.sy + d.th });
    out.push({ name: "disc1", x: DISC_ZONE[1].x, y: DISC_ZONE[1].y, w: 3 * d.sx + d.tw, h: 5 * d.sy + d.th });
    out.push({ name: "disc3", x: DISC_ZONE[3].x - 3 * d.sx, y: DISC_ZONE[3].y, w: 3 * d.sx + d.tw, h: 5 * d.sy + d.th });

    out.push({ name: "center", x: LAYOUT.center.x - LAYOUT.center.w / 2, y: LAYOUT.center.y - LAYOUT.center.h / 2,
               w: LAYOUT.center.w, h: LAYOUT.center.h });
    return out;
  }
  function decorOverlap(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  }
  /** 装饰安全区自检（纯几何、不依赖 canvas）：每个装饰框 ①落在牌桌绒面内 ②与保留区零相交 */
  function decorCheck() {
    var fr = decorFrames(), rv = decorReserved(), hits = [], i, j, f = null, r = null, felt = LAYOUT.felt;
    for (i = 0; i < fr.length; i++) {
      f = fr[i];
      if (f.x < felt.x || f.y < felt.y || f.x + f.w > felt.x + felt.w || f.y + f.h > felt.y + felt.h)
        hits.push(f.name + "≠felt");
      for (j = 0; j < rv.length; j++) { r = rv[j]; if (decorOverlap(f, r)) hits.push(f.name + "×" + r.name); }
    }
    return { ok: hits.length === 0, hits: hits, frames: fr, reserved: rv.length,
             note: "结算亮牌板铺满整屏 → 结算分支不画装饰（结构上不可能互相遮挡）" };
  }
  /** 装饰绘制统计（每帧 renderTable 归零；无头断言 / 出图脚本都读它）*/
  function decorStat() {
    var d = G.decor || {}, ck = decorCheck();
    return { dice: d.dice || 0, chips: d.chips || 0, ruler: d.ruler || 0, ashtray: d.ashtray || 0,
             vecDice: d.vecDice || 0, vecChip: d.vecChip || 0, skipped: d.skipped || 0,
             safe: ck.ok, hits: ck.hits };
  }
  /** 每帧画一遍（drawFelt 之后、牌墙 / 手牌 / 牌河 / 中央面板之前 → 永远被压在下面，挡不住任何东西）*/
  function drawTableDecor(g) {
    var i, d, chips = DECOR.chips, ok;
    if (!G.decor) G.decor = { dice: 0, chips: 0, ruler: 0, ashtray: 0, vecDice: 0, vecChip: 0, skipped: 0 };
    d = DECOR.dice;
    if (decorTex(g, d.id, d.x, d.y, d.s, d.rot)) G.decor.dice++;
    else { decorDiceVector(g, d.x, d.y, d.s); G.decor.vecDice++; }
    for (i = 0; i < chips.length; i++) {
      d = chips[i];
      if (decorTex(g, d.id, d.x, d.y, d.s, 0)) G.decor.chips++;
      else { decorChipVector(g, d.x, d.y, d.s, d.color, d.n); G.decor.vecChip++; }
    }
    if (decorTex(g, DECOR.ruler.id, DECOR.ruler.x, DECOR.ruler.y, DECOR.ruler.s, 0)) G.decor.ruler++;
    else G.decor.skipped++;
    if (decorTex(g, DECOR.ashtray.id, DECOR.ashtray.x, DECOR.ashtray.y, DECOR.ashtray.s, 0)) G.decor.ashtray++;
    else G.decor.skipped++;
  }
  /**
   * 牌墙（照参考图 2 的**同心三层**结构重排）：四面牌墙紧密围成一个方环「□」，
   * 贴住中央指示盘外侧，**再也不是贴在屏幕四边**。
   *   · 方环内表面到中心的距离四面**全等**（RING.rIn = 222）→「四段成环」可断言
   *   · 每边**一墩两枚、上下叠放**（照放大参考图）：外枚垫在下面、内枚盖在上面，
   *     每枚都是「绿面 + 象牙白棱边」的 3D 立牌，棱边一律朝**外**（背离桌心）。
   *   · 随剩余张数各自从两端同时变短（缺口留在正中）；**余牌不足时外枚先消失** → 只剩单层。
   *   · 横向边：每枚 30×23（wall.tw × wall.tileDepth）· 纵向边：每枚 23×30
   *   · 整墩占位 = stackDepth 46 = 2 × tileDepth 23（与旧「双层 22 + 缝 2 + 22」同占位）
   * 34 墩（136 张）的分配照方环均分：上 9 / 右 8 / 下 9 / 左 8 —— 合计 34。
   *   （照参考图：方环四角本来就留缺口，四段不必首尾相接；每段各自从中点向两端生长。）
   */
  var WALL_SHARE = [
    { side: "top", n: 9 }, { side: "right", n: 8 }, { side: "bottom", n: 9 }, { side: "left", n: 8 }
  ];
  /* 每边只给「内表面」坐标（朝桌心那一面）—— 一墩沿**背离桌心**方向长出 stackDepth。
     内表面到中心的距离四面都等于 RING.rIn = 222（「四段成环」就靠这条断言）。*/
  /* 每边只给「内表面」坐标（朝桌心那一面）—— 一墩沿**背离桌心**方向长出 stackDepth。
     内表面到中心的距离四面都等于 RING.rIn = 240（「四段成环」就靠这条断言）。*/
  /* 每边只给「内表面」坐标（朝桌心那一面）—— 一墩沿**背离桌心**方向长出 stackDepth。
     内表面到中心的距离：上/下 = RING.rInY = 279，左/右 = RING.rInX = 318
     → 方环外接框 x 256..984（728 = 桌面宽 60.1%）· y 55..705（650 = 桌面高 78.1%）。*/
  var WALL_GEO = {
    top: { horiz: true, cx: 620, inner: 101 },
    bottom: { horiz: true, cx: 620, inner: 659 },
    left: { horiz: false, cy: 380, inner: 302 },
    right: { horiz: false, cy: 380, inner: 938 }
  };
  /** 牌墙墩数分配：按各边上限等比缩小，最后一边吃掉余数，保证总数恰好 = stacks */
  function wallCounts(stacks) {
    var out = {}, acc = 0, i, want, max;
    for (i = 0; i < WALL_SHARE.length; i++) {
      max = WALL_SHARE[i].n;
      want = (i === WALL_SHARE.length - 1) ? (stacks - acc) : Math.round(stacks * max / 34);
      if (want > max) want = max;
      if (want < 0) want = 0;
      out[WALL_SHARE[i].side] = want;
      acc += want;
    }
    return out;
  }
  /** 一墩 = 上下两枚立牌（照放大参考图）。整墩占位 = stackDepth（沿「背离桌心」方向），
      两枚都是**同一尺寸**的单枚牌背（tileDepth），象牙白棱边一律朝**外**（背离桌心）。
      tiles[0] = 外枚（先画、垫在下面、整体压暗）；tiles[1] = 内枚（后画、盖在上面）。
      余牌不足时**外枚先消失** → 只剩内枚单层，与「余 N 张」对得上。 */
  function makeStack(side, geo, off, tw) {
    var D = LAYOUT.wall.tileDepth, SD = LAYOUT.wall.stackDepth;
    var out = { side: side, x: 0, y: 0, w: 0, h: 0, tiles: [] }, oy, iy, ox, ix;
    if (side === "top" || side === "bottom") {
      out.x = geo.cx + off - tw / 2; out.w = tw; out.h = SD;
      out.y = (side === "top") ? (geo.inner - SD) : geo.inner;
      oy = (side === "top") ? out.y : (out.y + SD - D);                  // 外枚贴「外」那一端
      iy = (side === "top") ? (out.y + SD - D) : out.y;                  // 内枚贴「内表面」那一端
      out.tiles.push({ x: out.x, y: oy, w: tw, h: D, edge: side, dim: true, thin: true });
      out.tiles.push({ x: out.x, y: iy, w: tw, h: D, edge: side, dim: false, noEdge: true });
    } else {
      out.y = geo.cy + off - tw / 2; out.h = tw; out.w = SD;
      out.x = (side === "left") ? (geo.inner - SD) : geo.inner;
      ox = (side === "left") ? out.x : (out.x + SD - D);
      ix = (side === "left") ? (out.x + SD - D) : out.x;
      out.tiles.push({ x: ox, y: out.y, w: D, h: tw, edge: side, dim: true, thin: true });
      out.tiles.push({ x: ix, y: out.y, w: D, h: tw, edge: side, dim: false, noEdge: true });
    }
    return out;
  }
  /** 牌墙的落点。
      ① 不给 counts（满墙 34 墩 = 68 枚）→ 装饰安全区 / ringInfo / wallClear 按它取**保守外接框**；
      ② 给了 counts → 按当前墩数摆：每边以**本侧中点**为中心对称排布，
         缺口自动留在正中（偶数墩也不会偏半块 —— 旧写法 0,+1,-1,+2,-2… 在 n 为偶数时整段偏 15px）。
      任意「居中子段」都含在「居中满段」里 → ① 仍是 ② 的保守超集，安全区纪律不破。 */
  function wallSlots(counts) {
    if (!counts && G.wallSlots) return G.wallSlots;
    var out = [], s, k, side, geo, maxN, n, tw, off;
    for (s = 0; s < WALL_SHARE.length; s++) {
      side = WALL_SHARE[s].side; geo = WALL_GEO[side]; maxN = WALL_SHARE[s].n;
      n = counts ? Math.max(0, Math.min(maxN, counts[side] || 0)) : maxN;
      tw = geo.horiz ? LAYOUT.wall.tw : LAYOUT.wall.side.th;   // 墩与墩之间的步距（沿墙长条）
      for (k = 0; k < n; k++) {
        off = (k - (n - 1) / 2) * tw;                          // 以本侧中点为中心对称
        out.push(makeStack(side, geo, off, tw));
      }
    }
    if (!counts) G.wallSlots = out;
    return out;
  }
  /** 一组牌墙墩的四面跨度（lo / hi / mid / want / n = 墩数）——「缺口留在正中」可断言：
      本侧已画段的中点 mid 必须落回本侧中点 want（上/下看 x，左/右看 y）。 */
  function wallSpan(stacks) {
    var out = {}, i, s, k;
    for (i = 0; i < stacks.length; i++) {
      s = stacks[i]; k = s.side;
      if (!out[k]) out[k] = { lo: Infinity, hi: -Infinity, mid: 0, n: 0,
                              want: (k === "top" || k === "bottom") ? RING.cx : RING.cy };
      if (k === "top" || k === "bottom") {
        out[k].lo = Math.min(out[k].lo, s.x); out[k].hi = Math.max(out[k].hi, s.x + s.w);
      } else {
        out[k].lo = Math.min(out[k].lo, s.y); out[k].hi = Math.max(out[k].hi, s.y + s.h);
      }
      out[k].n++;                                              // n = 本侧已画墩数
    }
    for (k in out) if (out.hasOwnProperty(k)) out[k].mid = (out[k].lo + out[k].hi) / 2;
    return out;
  }
  /** 画牌墙：**一墩两枚**；余牌不足时**外枚先消失**（只剩内枚单层）→ 画出枚数与「余 N 张」对得上。 */
  function drawWall(g, remaining) {
    var stacks = Math.ceil(remaining / 4), need = wallCounts(stacks), slots;
    var vis = Math.ceil(remaining / 2);             // 可见枚数：每枚代表 2 张（一墩两枚 = 4 张）
    var i, s, t, drawn = 0, want, drawnStacks = [];
    G.stat.wallStacks = stacks;
    slots = wallSlots(need);                        // 按当前墩数摆（不是「满墙取前缀」）
    for (i = 0; i < slots.length && drawn < vis; i++) {
      s = slots[i];
      want = Math.min(2, vis - drawn);
      if (want === 2) {                             // 外枚：垫在下面、压暗
        t = s.tiles[0]; drawTileBack(g, t.x, t.y, t.w, t.h, t); drawn++;
      }
      t = s.tiles[1]; drawTileBack(g, t.x, t.y, t.w, t.h, t); drawn++;   // 内枚：盖在上面
      drawnStacks.push(s);
    }
    G.stat.wallTiles = drawn;                       // 画出枚数（应 = ceil(余牌 / 2)）
    G.stat.wallDrawnStacks = drawnStacks.length;    // 画出墩数（每墩 1~2 枚）
    G.wallSpan = wallSpan(drawnStacks);             // 本帧真实画出去的四段跨度（取证用）
  }
  /** ①「四段成环」取证（纯几何）：四面牌墙的**内表面到中心的距离**是否四面全等、
      四段是否各自落在自己那一侧、每段是否都有牌。用户 2025 明确要求
      「牌墙要紧密围成一个方环、不能再放在屏幕四边」→ 这条可断言。
      dIn = 一墩内表面（朝桌心那一面）到中心的距离，恒等于 RING.rIn；
      dOut = 整墩外沿到中心的距离，恒等于 rIn + stackDepth。 */
  function ringInfo() {
    var c = LAYOUT.center, r = RING, slots = wallSlots(), keys = ["top", "right", "bottom", "left"];
    var want = { top: r.rInY, bottom: r.rInY, left: r.rInX, right: r.rInX };
    var SD = LAYOUT.wall.stackDepth, f = LAYOUT.felt;
    var out = { cx: c.x, cy: c.y, rIn: r.rInY, rInX: r.rInX, rInY: r.rInY,
                rOutX: r.rInX + SD, rOutY: r.rInY + SD, want: want,
                n: {}, dIn: {}, dOut: {}, span: {}, sameSide: true, equal: true, ok: false };
    var i, k, s, d, d2;
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      out.n[k] = 0; out.dIn[k] = null; out.dOut[k] = null;
      out.span[k] = { lo: Infinity, hi: -Infinity };
    }
    for (i = 0; i < slots.length; i++) {
      s = slots[i]; k = s.side;
      if (k === "top") {
        d = c.y - (s.y + s.h); d2 = c.y - s.y;
        if (s.y + s.h > c.y) out.sameSide = false;
        out.span[k].lo = Math.min(out.span[k].lo, s.x); out.span[k].hi = Math.max(out.span[k].hi, s.x + s.w);
      } else if (k === "bottom") {
        d = s.y - c.y; d2 = (s.y + s.h) - c.y;
        if (s.y < c.y) out.sameSide = false;
        out.span[k].lo = Math.min(out.span[k].lo, s.x); out.span[k].hi = Math.max(out.span[k].hi, s.x + s.w);
      } else if (k === "left") {
        d = c.x - (s.x + s.w); d2 = c.x - s.x;
        if (s.x + s.w > c.x) out.sameSide = false;
        out.span[k].lo = Math.min(out.span[k].lo, s.y); out.span[k].hi = Math.max(out.span[k].hi, s.y + s.h);
      } else {
        d = s.x - c.x; d2 = (s.x + s.w) - c.x;
        if (s.x < c.x) out.sameSide = false;
        out.span[k].lo = Math.min(out.span[k].lo, s.y); out.span[k].hi = Math.max(out.span[k].hi, s.y + s.h);
      }
      out.n[k]++;                                   // n = 本侧墩数
      if (out.dIn[k] === null || d < out.dIn[k]) out.dIn[k] = d;
      if (out.dOut[k] === null || d2 > out.dOut[k]) out.dOut[k] = d2;
    }
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      if (out.n[k] <= 0 || out.dIn[k] !== want[k]) out.equal = false;
    }
    out.ok = out.equal && out.sameSide;
    /* 方环占桌面比例（用户验收：宽 ≥0.60 · 高 ≥0.78）*/
    out.box = { x: c.x - out.rOutX, y: c.y - out.rOutY, w: out.rOutX * 2, h: out.rOutY * 2 };
    out.ratio = { w: out.box.w / f.w, h: out.box.h / f.h };
    out.ratioOK = out.ratio.w >= 0.60 && out.ratio.h >= 0.78;
    /* ③ 同心顺序取证（用 decorReserved() 同一份口径，两处不打架）：
          ① 指示盘 × 四家牌河零相交  ② 四家牌河整体落在方环内表面之内
          ③ 三家手牌背面整体落在方环外表面之外 */
    var disc = { x: c.x - c.w / 2, y: c.y - c.h / 2, w: c.w, h: c.h };
    var inn = { x: c.x - r.rInX, y: c.y - r.rInY, w: r.rInX * 2, h: r.rInY * 2 };
    var out2 = out.box;
    var rv = decorReserved(), hits = [], b, o = { disc: true, riverInside: true, backOutside: true };
    for (i = 0; i < rv.length; i++) {
      b = rv[i];
      if (b.name.indexOf("disc") === 0) {
        if (decorOverlap(b, disc)) { o.disc = false; hits.push(b.name + "×center"); }
        if (!(b.x >= inn.x && b.y >= inn.y && b.x + b.w <= inn.x + inn.w && b.y + b.h <= inn.y + inn.h)) {
          o.riverInside = false; hits.push(b.name + "⊄方环内表面");
        }
      } else if (b.name.indexOf("hand") === 0 && b.name !== "hand0") {
        if (decorOverlap(b, out2)) { o.backOutside = false; hits.push(b.name + "∩方环外表面"); }
      }
    }
    o.ok = o.disc && o.riverInside && o.backOutside;
    o.hits = hits;
    out.order = o;
    return out;
  }
  /** ② 牌墙 × 其它保留框（牌河 / 手牌 / 副露 / 中央盘）的零相交取证 ——
      保留框与 decorCheck() 走同一份 decorReserved()，不会两处口径打架。 */
  function wallClear() {
    var slots = wallSlots(), rv = decorReserved(), hits = [], seen = {}, i, j, k;
    for (i = 0; i < slots.length; i++) {
      for (j = 0; j < rv.length; j++) {
        if (rv[j].name === "wall") continue;
        if (decorOverlap(slots[i], rv[j])) {
          k = slots[i].side + "×" + rv[j].name;
          if (!seen[k]) { seen[k] = 1; hits.push(k); }
        }
      }
    }
    return { ok: hits.length === 0, hits: hits, wall: slots.length, others: rv.length - slots.length };
  }


  /* ── 各家手牌 / 副露 / 弃牌 ── */
  function playerHandCount(p) { return p.isHuman ? p.hand.length : Math.max(0, p.hand.length); }
  /* ── 三家对家手牌：背面朝上、整齐一横排（或按方位一竖排），紧贴方环**外表面之外**（同心外圈）──
     尺寸统一：横向每张 back.wide × back.depth = 26×30、步距 26；纵向 30×26、步距 26。
     全部同尺寸同色调（不再给「刚摸的那张」单独提亮，避免一排里出现大小/明暗不一）。*/
  function drawBackRowV(g, cx, cy, n, vertical, edge) {
    var b = LAYOUT.back, i, x, y, total = (n - 1) * b.step + b.wide;
    for (i = 0; i < n; i++) {
      if (vertical) { x = cx - b.depth / 2; y = cy - total / 2 + i * b.step; drawTileBack(g, x, y, b.depth, b.wide, { edge: edge || "right" }); }
      else { x = cx - total / 2 + i * b.step; y = cy - b.depth / 2; drawTileBack(g, x, y, b.wide, b.depth, { edge: edge || "top" }); }
    }
  }

  /* ── 副露：位置固定 · 组内按牌面排序 · 碰/明杠有一张横置表示来源 ── */
  /** 调试：每家塞 4 组示范副露（暗杠 / 明杠 / 碰 / 补杠），只影响渲染，不动牌局 */
  function demoMeldsFor(seat) {
    return [
      { type: "gang", tiles: ["7万", "7万", "7万", "7万"], from: -1, an: true, kind: "an" },
      { type: "gang", tiles: ["5条", "5条", "5条", "5条"], from: (seat + 1) % 4, an: false, kind: "ming" },
      { type: "peng", tiles: ["3筒", "3筒", "3筒"], from: (seat + 2) % 4, an: false, kind: "ming" },
      { type: "gang", tiles: ["中", "中", "中", "中"], from: (seat + 3) % 4, an: false, kind: "bu" }
    ];
  }
  /** 横置（表示来源）那张牌的下标；暗杠不横置 */
  function meldSideIdx(meld, seat) {
    if (meld.an) return -1;
    var from = (meld.from == null || meld.from < 0) ? seat : meld.from;
    var rel = (from - seat + 8) % 4;                       // 3=上家(横置在左) 2=对家(中) 1=下家(右)
    if (meld.type === "peng") return rel === 3 ? 0 : (rel === 1 ? 2 : 1);
    if (meld.kind === "bu") return 3;                      // 回头杠：第 4 张横置
    return rel === 3 ? 0 : (rel === 1 ? 3 : 2);            // 明杠
  }
  /** 一组副露沿主轴的每张牌偏移（横置那张占 th，其余占 tw） */
  function meldSlots(meld, tw, th, gap, seat, dir) {
    var n = meld.tiles.length, side = meldSideIdx(meld, seat), out = [], off = 0, i, w;
    for (i = 0; i < n; i++) {
      w = (i === side) ? (dir === "h" ? th : tw) : (dir === "h" ? tw : th);
      out.push({ off: off, side: i === side });
      off += w + gap;
    }
    return { slots: out, len: Math.max(0, off - gap) };
  }
  function meldLen(meld, cfg, seat, dir) {
    var s = meldSlots(meld, cfg.tw, cfg.th, cfg.gap, seat, dir);
    return s.len;
  }
  /** 副露整体布局：空间不够时按比例缩小，保证不越界 */
  function meldLayout(melds, cfg, seat, dir, avail) {
    var n = melds.length, i, gaps = Math.max(0, n - 1) * cfg.groupGap;
    var tw = cfg.tw, th = cfg.th, gap = cfg.gap, total = 0, k;
    for (i = 0; i < n; i++) total += meldLen(melds[i], { tw: tw, th: th, gap: gap }, seat, dir);
    if (total + gaps > avail && total > 0) {
      k = Math.max(.55, (avail - gaps) / total);
      tw *= k; th *= k; gap = Math.max(.5, gap * k);
    }
    return { tw: tw, th: th, gap: gap, groupGap: cfg.groupGap };
  }
  function drawMeldGroup(g, meld, x, y, cfg, dir, hl, seat) {
    var tiles = meld.tiles, s = meldSlots(meld, cfg.tw, cfg.th, cfg.gap, seat, dir), i, tx, ty, w, h, sl;
    var cross = Math.max(cfg.tw, cfg.th);          // 整组统一行高（垂直行长条那个方向）
    for (i = 0; i < tiles.length; i++) {
      sl = s.slots[i];
      w = sl.side ? cfg.th : cfg.tw;               // 行内占位 = 该牌的外接框（横置牌恰好是 th 宽）
      h = sl.side ? cfg.tw : cfg.th;
      if (dir === "h") { tx = x + sl.off; ty = y + (cross - h) / 2; }
      else { tx = x + (cross - w) / 2; ty = y + sl.off; }
      /* 尺寸取证：同组内所有牌都是 cfg.tw × cfg.th，横置只是 rot=90（绕中心旋转），
         绝不缩放 —— tools/mj/check-geometry.js 与 e2e 都按这个记帐断言。 */
      if (G.stat.meldRects) {
        G.stat.meldRects.push({ seat: seat, type: meld.type + (meld.an ? "-an" : ""), gi: i,
                                w: cfg.tw, h: cfg.th, rot: sl.side ? 90 : 0, x: tx, y: ty });
      }
      if (meld.an && i < 2) {
        drawTileBack(g, tx, ty, w, h, { edge: (dir === "h" ? "top" : (seat === 1 ? "right" : "left")), dim: true });                 // 暗杠：两张盖两张（背牌同尺寸）
      } else if (sl.side) {
        /* 横置牌：同一张牌**绕中心旋转 90°** 画（牌面仍是 cfg.tw × cfg.th）—— 只旋转、不缩放 */
        g.save();
        g.translate(tx + w / 2, ty + h / 2);
        g.rotate(Math.PI / 2);
        drawTileFace(g, tiles[i], -cfg.tw / 2, -cfg.th / 2, cfg.tw, cfg.th, { hl: hl });
        g.restore();
      } else {
        drawTileFace(g, tiles[i], tx, ty, cfg.tw, cfg.th, { hl: hl });
      }
    }
    G.stat.meldTiles += tiles.length;
    return s.len;
  }

  function drawDiscards(g, seat) {
    var p = G.E.P[seat], zone = DISC_ZONE[seat], d = LAYOUT.disc, i, pos, last = p.discards.length - 1, out = [];
    for (i = 0; i < p.discards.length; i++) {
      pos = discardPos(seat, i);
      drawTileFace(g, p.discards[i], pos.x, pos.y, d.tw, d.th, { hl: i === last });
      out.push({ x: pos.x, y: pos.y, w: d.tw, h: d.th });
    }
    G.stat.discards += p.discards.length;
    return out;
  }
  function discardPos(seat, i) {
    var z = DISC_ZONE[seat], d = LAYOUT.disc, r, c;
    if (seat === 0) { r = Math.floor(i / z.perRow); c = i % z.perRow; return { x: z.x + c * d.sx, y: z.y - r * d.sy }; }
    if (seat === 2) { r = Math.floor(i / z.perRow); c = i % z.perRow; return { x: z.x + c * d.sx, y: z.y + r * d.sy }; }
    c = Math.floor(i / z.perRow); r = i % z.perRow;
    if (seat === 3) return { x: z.x - c * d.sx, y: z.y + r * d.sy };
    return { x: z.x + c * d.sx, y: z.y + r * d.sy };
  }
  function drawSeatPlate(g, seat, label, sub, active) {
    var pos = SEAT_POS[seat], pw = seat === 0 ? 118 : 124, ph = 30, x = pos.x, y = pos.y;
    g.save();
    g.fillStyle = active ? "rgba(255,215,110,.16)" : "rgba(6,10,16,.62)";
    rr(g, x, y, pw, ph, 6); g.fill();
    g.strokeStyle = active ? "#ffd76e" : "rgba(255,255,255,.18)";
    g.lineWidth = active ? 2 : 1;
    if (active) { g.shadowColor = "rgba(255,215,110,.9)"; g.shadowBlur = 14; }
    rr(g, x, y, pw, ph, 6); g.stroke();
    g.shadowBlur = 0;
    g.fillStyle = active ? "#ffd76e" : "#dfe6f2";
    g.font = "bold 15px " + FONT_CN; g.textAlign = "left"; g.textBaseline = "middle";
    g.fillText(label, x + 10, y + ph / 2);
    g.fillStyle = "rgba(255,255,255,.55)"; g.font = "11px 'Microsoft YaHei',sans-serif";
    g.textAlign = "right";
    g.fillText(sub, x + pw - 8, y + ph / 2 + 1);
    g.restore();
  }
  function drawSeat(g, seat) {
    var E = G.E, p = E.P[seat], active = (E.phase !== "over" && ((E.phase === "turn" && E.cur === seat) ||
      (E.phase !== "turn" && E.pending && E.pending.seat === seat))) ? true : false;
    var melds = G.demo ? demoMeldsFor(seat) : p.melds;
    var i, x, y, res, backN, m0, m2, mS, j, tot, cen;
    if (seat === 0) {
      /* 副露：手牌上方一行、右对齐到 meld0.x，按牌面（万→条→筒→字，数字升序）排列 */
      m0 = meldLayout(melds, LAYOUT.meld0, 0, "h", LAYOUT.meld0.avail);
      y = LAYOUT.meld0.y;
      tot = 0;
      for (j = 0; j < melds.length; j++) tot += meldLen(melds[j], m0, 0, "h") + (j ? m0.groupGap : 0);
      x = LAYOUT.meld0.x - tot;
      for (j = 0; j < melds.length; j++) {
        res = drawMeldGroup(g, melds[j], x, y, m0, "h", false, 0);
        x += res + m0.groupGap;
      }
    } else if (seat === 2) {
      /* 对家（上）：手牌背面整齐一横排，紧贴方环**外表面之外**；副露横排在手牌更外侧 */
      backN = p.hand.length;
      drawBackRowV(g, 620, 35, backN, false, "top");
      G.stat.backs += backN;
      m2 = meldLayout(melds, LAYOUT.meldTop, 2, "h", 700);
      tot = 0;
      for (j = 0; j < melds.length; j++) tot += meldLen(melds[j], m2, 2, "h") + (j ? m2.groupGap : 0);
      x = 230 - tot / 2;
      y = 16;
      for (j = 0; j < melds.length; j++) {
        res = drawMeldGroup(g, melds[j], x, y, m2, "h", false, 2);
        x += res + m2.groupGap;
      }
    } else if (seat === 1) {
      /* 右家：手牌背面一竖排，副露竖排在手牌**外侧**（更靠右边）*/
      backN = p.hand.length;
      drawBackRowV(g, 1007, 380, backN, true, "right");
      G.stat.backs += backN;
      mS = meldLayout(melds, LAYOUT.meldSide, 1, "v", 380);
      tot = 0;
      for (j = 0; j < melds.length; j++) tot += meldLen(melds[j], mS, 1, "v") + (j ? mS.groupGap : 0);
      y = 380 - tot / 2;
      for (j = 0; j < melds.length; j++) {
        res = drawMeldGroup(g, melds[j], 1028, y, mS, "v", false, 1);
        y += res + mS.groupGap;
      }
    } else {
      /* 左家：手牌背面一竖排，副露竖排在手牌**外侧**（更靠左边）*/
      backN = p.hand.length;
      drawBackRowV(g, 233, 380, backN, true, "left");
      G.stat.backs += backN;
      mS = meldLayout(melds, LAYOUT.meldSide, 3, "v", 380);
      tot = 0;
      for (j = 0; j < melds.length; j++) tot += meldLen(melds[j], mS, 3, "v") + (j ? mS.groupGap : 0);
      y = 380 - tot / 2;
      for (j = 0; j < melds.length; j++) {
        res = drawMeldGroup(g, melds[j], 178, y, mS, "v", false, 3);
        y += res + mS.groupGap;
      }
    }
    if (seat !== 0) {

      drawSeatPlate(g, seat, p.name + (active ? " ●" : ""), p.hand.length + " 张", active);
    } else {
      drawSeatPlate(g, 0, "你" + (active ? " ● 出牌" : ""), p.hand.length + " 张", active);
    }
  }

  /* ── 我的手牌（正面 / 摸牌单独放最右并留 12px 空隙 + 金边微抬 / 悬停抬升） ── */
  function layoutHand(p) {
    var out = [], n = p.hand.length, hasDrawn = (p.drawn !== null && p.drawn !== undefined && n % 3 === 2), i, x;
    var step = LAYOUT.hand.step, tw = LAYOUT.hand.tw, gap = LAYOUT.hand.gap;
    var core = hasDrawn ? n - 1 : n;
    // 核心牌：相邻 step（= tw + 6px 间隙）；摸到的牌：前面单独留 gap(12px)
    var totalW = (core > 0 ? (core - 1) * step + tw : 0) + (hasDrawn ? gap + tw : 0);
    var x0 = 620 - totalW / 2;
    for (i = 0; i < n; i++) {
      if (hasDrawn && i === n - 1) x = (core > 0 ? x0 + (core - 1) * step + tw : x0) + gap;
      else x = x0 + i * step;
      out.push({ idx: i, tile: p.hand[i], x: x, y: LAYOUT.hand.y, w: tw, h: LAYOUT.hand.th, drawn: hasDrawn && i === n - 1 });
    }
    return out;
  }
  function drawMyHand(g) {
    var p = G.E.P[0], rects = layoutHand(p), now = Date.now(), i, r, lift;
    G.handRects = rects;
    G.stat.faces += rects.length;
    var turnStart = G.anim.drawAt || 0, slide = 0;
    if (turnStart && now - turnStart < 280) slide = (1 - (now - turnStart) / 280) * 46;
    // 牌墙式阴影带（手牌下方）
    if (rects.length) {
      g.save();
      g.fillStyle = "rgba(0,0,0,.24)";
      rr(g, rects[0].x - 10, LAYOUT.hand.y + LAYOUT.hand.th + 2,
        rects[rects.length - 1].x + rects[rects.length - 1].w - rects[0].x + 20, 10, 5); g.fill();
      g.restore();
    }
    for (i = 0; i < rects.length; i++) {
      r = rects[i];
      lift = 0;
      if (r.drawn) lift = LAYOUT.hand.drawnLift;
      if (G.hover === i && !r.drawn) lift = LAYOUT.hand.lift;
      var dx = r.drawn ? slide : 0;
      g.save();
      g.translate(dx, -lift);                    // 悬停抬升 / 摸牌抬起
      if (r.drawn) {                             // 刚摸到的牌：金色描边 + 光晕
        g.save();
        g.shadowColor = "rgba(255,215,110,.95)"; g.shadowBlur = 20;
        g.fillStyle = "rgba(255,215,110,.20)";
        rr(g, r.x - 2, r.y - 2, r.w + 4, r.h + 4, 7); g.fill();
        g.restore();
      }
      drawTileFace(g, r.tile, r.x, r.y, r.w, r.h, { hl: r.drawn });
      if (i === G.hintIdx && G.hintOn) {              // 智脑建议打出的那张：金色脉动边框
        var pulse = .5 + .5 * Math.sin(now / 190);
        g.save();
        g.shadowColor = "rgba(255,215,110," + (.62 + .38 * pulse).toFixed(3) + ")";
        g.shadowBlur = 10 + 18 * pulse;
        g.strokeStyle = "rgba(255,215,110," + (.72 + .28 * pulse).toFixed(3) + ")";
        g.lineWidth = 3 + pulse;
        rr(g, r.x - 3, r.y - 3, r.w + 6, r.h + 6, 9); g.stroke();
        g.restore();
      }
      if (G.hover === i) { drawGlowPlate(g, r.x, r.y, r.w, r.h, Math.max(2, r.w * .12), "rgba(255,255,255,.8)", 12); }
      g.restore();
    }
  }

  /* ── 结算亮牌板：四家完整手牌 + 副露 + 听牌/胡牌标注 + 胡牌张金边 ── */
  function drawResultBoard(g, view) {
    if (!view || !view.seats) return;
    var i, j, m, q, t, x, y, tw = 28, th = 38, gap = 2, mgap = 3;
    g.save();
    g.fillStyle = "rgba(3,5,10,.88)";
    rr(g, 18, 18, W - 36, H - 36, 20); g.fill();
    g.strokeStyle = "rgba(255,215,110,.35)"; g.lineWidth = 1.5;
    rr(g, 18, 18, W - 36, H - 36, 20); g.stroke();
    g.textBaseline = "middle";
    g.fillStyle = "#ffd76e"; g.font = "bold 22px " + FONT_CN; g.textAlign = "center";
    g.fillText(view.draw ? "流 局 · 四家亮牌" : (view.tierName + " · " + view.head), W / 2, 48);
    g.font = "bold 12px " + FONT_CN; g.textAlign = "left";
    for (i = 0; i < view.seats.length; i++) {
      var s = view.seats[i];
      x = 56; y = 92 + i * 176;
      g.fillStyle = s.win ? "#7dffc0" : "#ffd76e";
      g.font = "bold 17px " + FONT_CN;
      g.fillText(s.name, x, y + 12);
      g.fillStyle = "rgba(203,214,230,.78)"; g.font = "11px " + FONT_CN;
      g.fillText(s.win ? ("胡 · " + s.how + " · " + s.tierName) : (s.tenpai ? ("听 " + s.waits.join("/") + "（剩 " + s.waitsLeft + " 张）") : "未听"), x + 76, y + 12);
      if (!view.draw) {
        g.fillStyle = s.net < 0 ? "#ff7d9c" : "#7dffc0";
        g.fillText((s.net > 0 ? "+" : "") + s.net, x + 400, y + 12);
      }
      for (j = 0; j < s.hand.length; j++) {
        t = s.hand[j];
        if (j === s.winTileIdx) { g.save(); g.shadowColor = "rgba(255,215,110,.95)"; g.shadowBlur = 16; g.restore(); }
        drawTileFace(g, t, x + j * (tw + gap), y + 24, tw, th, j === s.winTileIdx ? { hl: true } : {});
        G.stat.resHandTiles++;
      }
      var mx = x + s.hand.length * (tw + gap) + 16;
      for (m = 0; m < s.melds.length; m++) {
        var md = s.melds[m];
        g.fillStyle = "rgba(255,215,110,.85)"; g.font = "10px " + FONT_CN;
        g.fillText(md.label, mx, y + 30);
        for (q = 0; q < md.tiles.length; q++) {
          drawTileFace(g, md.tiles[q], mx + q * (22 + mgap), y + 38, 22, 30, {});
          G.stat.resHandTiles++;
        }
        mx += md.tiles.length * (22 + mgap) + 8;
      }
      G.stat.resHands++;
    }
    g.textAlign = "center"; g.fillStyle = "rgba(203,214,230,.55)"; g.font = "12px " + FONT_CN;
    g.fillText("智脑提示：四家手牌已全部亮出（排序：万→条→筒→字）", W / 2, H - 32);
    g.restore();
  }
  /* ── 中央信息盘（照参考图 2 的圆形指示盘，仍全部用矢量画）── */
  function drawCenter(g) {
    var c = LAYOUT.center, E = G.E, R = Math.min(c.w, c.h) / 2;
    g.save();
    /* 圆盘：深绿底 + 金外环 + 内圈细金线 */
    var grd = g.createRadialGradient(c.x, c.y - R * .32, R * .12, c.x, c.y, R);
    grd.addColorStop(0, "rgba(26,48,36,.96)"); grd.addColorStop(1, "rgba(4,12,9,.94)");
    g.beginPath(); g.arc(c.x, c.y, R, 0, Math.PI * 2); g.fillStyle = grd; g.fill();
    g.strokeStyle = "rgba(255,215,110,.46)"; g.lineWidth = 2; g.stroke();
    g.beginPath(); g.arc(c.x, c.y, R * .84, 0, Math.PI * 2);
    g.strokeStyle = "rgba(255,215,110,.16)"; g.lineWidth = 1; g.stroke();
    /* 四向指示箭头（当前行动方金色），贴在圆盘外的四个方位 */
    var marks = [[0, 1], [1, 0], [0, -1], [-1, 0]], i, mx, my, act;
    for (i = 0; i < 4; i++) {
      mx = c.x + marks[i][0] * (R + 15); my = c.y + marks[i][1] * (R + 13);
      act = (E.phase === "turn" && E.cur === i) || (E.phase !== "turn" && E.pending && E.pending.seat === i);
      g.fillStyle = act ? "#ffd76e" : "rgba(255,255,255,.22)";
      g.beginPath();
      g.moveTo(mx, my - 7); g.lineTo(mx + 7, my + 5); g.lineTo(mx - 7, my + 5); g.closePath(); g.fill();
    }
    /* 盘心数字 */
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = "#ffd76e"; g.font = "bold 21px " + FONT_CN;
    g.fillText("余 " + E.wall.length, c.x, c.y - 12);
    g.fillStyle = "rgba(223,230,242,.88)"; g.font = "12px 'Microsoft YaHei',sans-serif";
    g.fillText("张 · 第 " + E.turnNo + " 巡", c.x, c.y + 12);
    g.restore();
  }

  function faceSheetRows() {
    /* tileGroup: 万=0 / 条=1 / 筒=2 / 字=3（SUITS 顺序）；参考图分组顺序是 万→筒→条→字 */
    var order = [0, 1, 2, 3];   /* 0=万 1=条 2=筒 3=字：KINDS 本身即 万→条→筒→字 */
    var rows = [], r, si, k;
    for (r = 0; r < order.length; r++) {
      si = order[r];
      var tiles = [];
      for (k = 0; k < KINDS.length; k++) if (tileGroup(KINDS[k]) === si) tiles.push(KINDS[k]);
      if (si === 3) for (k = 0; k < HONORS.length; k++) tiles.push(HONORS[k]);
      rows.push({ label: SUIT_ROW_LABEL[si], suit: si, tiles: tiles });
    }
    return rows;
  }
  function drawFaceSheet(g, sheet) {
    var rows = faceSheetRows();
    if (sheet && sheet.honors === false) {         // 无字牌：只画万筒条
      rows = rows.filter(function (rr) { return rr.suit !== 3; });
    }
    var n = 0, i;
    for (i = 0; i < rows.length; i++) n += rows[i].tiles.length;
    var cols = 9, tw = 112, th = 146, gx = 13, gy = 15, padX = 74;
    var totW = cols * tw + (cols - 1) * gx;
    var totH = rows.length * th + (rows.length - 1) * gy;
    var x0 = Math.max(padX, (W - totW) / 2), y0 = Math.max(96, (H - totH) / 2 + 14);
    var grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, "#1d6647"); grd.addColorStop(1, "#0c3524");
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = "#ffd76e"; g.font = "bold 26px " + FONT_CN;
    g.fillText("牌 面 对 照 总 览 · " + n + " 种 · " + (n > 27 ? "136 张" : "108 张"), W / 2, 44);
    g.fillStyle = "rgba(255,255,255,.66)"; g.font = "14px 'Microsoft YaHei',sans-serif";
    g.fillText("分组顺序 万 → 筒 → 条 → 字牌（照标准参考图）· 平地铺开 1:1 便于逐张比对", W / 2, 74);
    var r, c, idx, t;
    for (r = 0; r < rows.length; r++) {
      g.textAlign = "right"; g.fillStyle = "rgba(255,215,110,.95)"; g.font = "bold 17px " + FONT_CN;
      g.fillText(rows[r].label, x0 - 18, y0 + r * (th + gy) + th / 2);
      for (c = 0; c < rows[r].tiles.length; c++) {
        t = rows[r].tiles[c];
        drawTileFace(g, t, x0 + c * (tw + gx), y0 + r * (th + gy), tw, th, {});
        G.stat.faces++;
        G.sheetTiles = G.sheetTiles || [];
        G.sheetTiles.push({ tile: t, x: x0 + c * (tw + gx), y: y0 + r * (th + gy), w: tw, h: th });
      }
    }
    g.textAlign = "center";
  }

  /** 整桌渲染（每帧调用） */
  function renderTable() {
    var g = G.ctx;
    if (!g) return;
    g.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    try {                                                   // 高清清晰度：不插值糊边
      if ("imageSmoothingEnabled" in g) g.imageSmoothingEnabled = true;
      if ("mozImageSmoothingEnabled" in g) g.mozImageSmoothingEnabled = true;
      if ("webkitImageSmoothingEnabled" in g) g.webkitImageSmoothingEnabled = true;
      g.lineCap = "round"; g.lineJoin = "round";
    } catch (e) {}
    g.clearRect(0, 0, W, H);
    G.stat = { faces: 0, backs: 0, discards: 0, meldTiles: 0, wallStacks: 0, wallTiles: 0, wallDrawnStacks: 0, backSolid: 0, backGreen: 0, backIvory: 0, resHands: 0, resHandTiles: 0, meldRects: [] };
    G.decor = { dice: 0, chips: 0, ruler: 0, ashtray: 0, vecDice: 0, vecChip: 0, skipped: 0 };
    if (G.sheet) { G.sheetTiles = []; drawFaceSheet(g, G.sheet); G.stat.sheetTiles = G.sheetTiles.length; G.stat.frame = (G.stat.frame || 0) + 1; return G.stat; }
    updateHint();                                            // 先算提示 → drawMyHand 用的 G.hintIdx 与金框一致
    if (G.E && G.E.phase === "over") {                       // 结算 → 直接在牌桌上亮四家牌
      drawFelt(g);
      G.view = G.view || buildResultView(G.E, G.result || G.E.result);
      drawResultBoard(g, G.view);
      G.stat.frame = (G.stat.frame || 0) + 1;
      G.stat.handCount = G.E.P[0].hand.length;
      return G.stat;
    }
    drawFelt(g);
    drawTableDecor(g);            // 静态装饰：骰子 / 筹码 / 牌尺 / 烟灰缸（每张图块都验算过不遮任何会变的东西）
    drawWall(g, G.E.wall.length);
    drawSeat(g, 2); drawSeat(g, 3); drawSeat(g, 1);
    drawDiscards(g, 2); drawDiscards(g, 3); drawDiscards(g, 1); drawDiscards(g, 0);
    drawSeat(g, 0);
    drawMyHand(g);
    drawCenter(g);
    G.stat.frame = (G.stat.frame || 0) + 1;
    G.stat.handCount = G.E.P[0].hand.length;
    G.stat.hintIdx = G.hintIdx;
    refreshHint();
    return G.stat;
  }

  /** 每帧兜底：需要时算提示、刷面板、摆金框（同手牌不重算，保证不卡帧） */
  function refreshHint() {
    if (!G.on || !G.E || !G.ctx) return;
    updateHint();
    renderBrain();
    updateHintMark();
  }

  /* ═══════════════ 5. 运行时（DOM / 交互 / 节奏） ═══════════════ */

  var G = {
    on: false, busy: false, finished: false, over: false,
    host: null, cv: null, ctx: null, dpr: 1,
    E: null, opts: null, timers: [], raf: 0,
    hover: -1, handRects: [], wallSlots: null, noise: null, stat: null, tickTimer: 0, frames: 0,
    roomBg: false, tileBackTex: 0, tileBackSolid: 0, decor: null,
    anim: { drawAt: 0 }, win: null, uiLock: 0, logRendered: 0,
    idleTimer: 0, winTimer: 0, result: null, resultShown: false, noiseCv: null, sheet: null, demo: null,
    hintOn: true, hint: null, hintIdx: -1, hintKey: "", hintPane: "", hintCalcN: 0, hintLastMs: 0, hintWorstMs: 0,
    hintLocked: false, style: "serious", stake: STAKE_DEFAULT, invite: null, stateRef: null,
    view: null, glow: 0,
    voiceOn: true, voiceN: 0, ting: [false, false, false, false]
  };
  /* ── 智脑提示：开关（localStorage 持久化） / 计算（每回合缓存） / 面板 / 金框 ── */
  var LS_KEY = "mjmHintOn";
  function HINT_LABEL(on) { return on ? "开" : "关"; }
  /** 开关文字：放水局锁死为「锁」（提示不可开启） */
  function hintLabel() { return G.hintLocked ? "锁" : HINT_LABEL(G.hintOn); }
  function loadHintPref() {
    try {
      var v = root.localStorage ? root.localStorage.getItem(LS_KEY) : null;
      if (v === "0") return false;
      if (v === "1") return true;
    } catch (e) { /* 无 localStorage（HTA / 隐私模式）不影响玩法 */ }
    return true;
  }
  function saveHintPref(on) {
    try { if (root.localStorage) root.localStorage.setItem(LS_KEY, on ? "1" : "0"); } catch (e) {}
  }
  G.hintOn = loadHintPref();
  var AI_MIN_MS = 500, AI_MAX_MS = 800;      // AI 行动节奏
  var RESPONSE_MS = 3000;                    // 碰/杠/抢杠 响应倒计时（自动「过」）
  var HUMAN_IDLE_MS = 15000;                 // 人类长时间不动 → 自动打一张（防挂死）
  var AUTO_FINISH_MS = 8000;                 // 结算面板兜底自动继续
  var STYLE_ID = "mjmGanmaStyle";

  function mkEl(tag, cls, html) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function byId(id) { try { return doc.getElementById(id); } catch (e) { return null; } }
  function later(fn, ms) {
    var id = root.setTimeout(function () {
      var i = G.timers.indexOf(id); if (i >= 0) G.timers.splice(i, 1);
      if (G.on || ms === 0) { try { fn(); } catch (e) { if (root.console) root.console.error("[mahjong]", e); } }
    }, ms);
    G.timers.push(id);
    return id;
  }
  function clearTimers() {
    for (var i = 0; i < G.timers.length; i++) root.clearTimeout(G.timers[i]);
    G.timers = [];
    G.idleTimer = 0; G.winTimer = 0;
  }
  function sfx(k) {
    try {
      var A = root.AudioSys; if (!A) return;
      if (k === "good" && A.good) A.good();
      else if (k === "bad" && A.bad) A.bad();
      else if (k === "ding" && A.ding) A.ding();
      else if (k === "click" && A.click) A.click();
      else if (k === "blip" && A.blip) A.blip();
    } catch (e) { /* 无音频层也不影响玩法 */ }
  }

  /* ═══════ 语音播报层（audio/mj/*.mp3，文件名即触发词；不阻塞牌局逻辑） ═══════ */
  var VOICE_KEY = "mjVoiceOn";                       // 与 🎯 提示开关并列的持久化键
  var VOICE_AI_DELAY = 170;                          // AI 出牌略慢一点，避免抢话
  var VOICE_AI_VOL = 0.82;                           // AI 出牌音量略低
  var VOICE_VOL = 1;
  /* 字牌：**牌面字符 → 素材词**（用户要求：打「中」必须念「红中」、打「白」念「白板」、
     打「东」念「东风」，南/西/北同理）。单念一个「中/白/东」在牌桌上太含糊 ——
     听不出是风牌还是箭牌。万/条/筒 保持「一万…九筒」的读法。
     ⚠ 这里分成两张表：VOICE_HONOR_WORDS 是「牌面字符 → 念出来的词」，
       VOICE_NAMES 是「念出来的词 → 有素材」。合起来就等于「牌面 → 文件」。
       别把它压成一张表 —— 牌面是「發」(U+767C)，念法是「发财」，两者都不等于文件名以外的任何东西。 */
  var VOICE_HONOR_WORDS = (function () {
    var m = {};
    m[String.fromCharCode(0x4E1C)] = "东风";
    m[String.fromCharCode(0x5357)] = "南风";
    m[String.fromCharCode(0x897F)] = "西风";
    m[String.fromCharCode(0x5317)] = "北风";
    m[String.fromCharCode(0x4E2D)] = "红中";
    m[String.fromCharCode(0x767C)] = "发财";
    m[String.fromCharCode(0x767D)] = "白板";
    return m;
  })();
  var VOICE_NAMES = (function () {
    var m = {}, i, k;
    for (i = 1; i <= 9; i++) { m[i + "万"] = 1; m[i + "条"] = 1; m[i + "筒"] = 1; }
    for (k in VOICE_HONOR_WORDS) if (VOICE_HONOR_WORDS.hasOwnProperty(k)) m[VOICE_HONOR_WORDS[k]] = 1;
    /* ⚠ 这里**不要**加「暗杠」「补杠」：它们不喊牌、出牌碰实音（见 gangClack）。
       曾把它们登记进来，导致每个座位都去请求不存在的 seatN/暗杠.mp3，
       四次 404 且完全无声（AudioSys 不会因为一次失败请求报错，测试也测不出来）。 */
    var acts = "碰 杠 胡 自摸 抢杠 杠开 听 过 流局".split(" ");
    for (i = 0; i < acts.length; i++) m[acts[i]] = 1;
    return m;
  })();
  var VOICE_BASE = null;                             // "audio/mj/" 或绝对 file:// 前缀
  /* 座位专属播报：座位 N 的牌名/喊话优先取 audio/mj/seatN/<词>.mp3，缺失则回落共用目录。
     座位 0（你/主角）直接用共用目录，不建子目录 —— 少 45 个文件。
     本表由 tools/gen_mj_by_seat.py 生成后同步维护；列在这里是为了**同步判断**能否用座位目录，
     不必等 404 再回落（省一次失败请求，预加载路径也可预测）。 */
  var VOICE_SEATS = { 1: "seat1", 2: "seat2", 3: "seat3" };
  var VOICE_CACHE = Object.create(null);             // 缓存键 → Audio（预加载 / 复用）
  var VOICE_STAT = { plays: 0, misses: 0, last: "", lastUrl: "", lastSeat: -1, lastAt: 0, errors: 0,
                     queued: 0, started: 0, dropped: 0, maxQueue: 0, list: [], uniq: Object.create(null) };
  /* ═══════ 播报队列（用户要求：一条播完再播下一条；出牌不得打断喊话） ═══════
     改之前是「同一时刻只播一条，后一条 pause + currentTime=0 打断前一条」——
     下家出牌的报牌会把正在播的「碰/杠/胡/自摸」拦腰砍断，牌桌上就是在抢话。

     现在的三条规则（缺一不可）：
       ① 串行：同一时刻只播一条，只有它 ended（或出错/超时兜底）才轮到下一条；
       ② 优先级只决定**排队顺序**：喊话（碰/杠/杠开/抢杠/胡/自摸/流局）插到报牌前面，
          同优先级一律 FIFO（先来先播）；
       ③ **绝不抢占正在播的那条** —— 这就是「出牌不要打断喊话」的硬保证。
          想「插队抢占」就得在 voiceStart 里 pause 掉 VOICE_PLAYING，那等于把这条要求作废。

     为什么还要上限和间隔：疯狂出牌时（四家连着打）队列会越排越长，
     喊话要等五六秒才响，听起来像对不上牌局 —— 所以队列封顶 6 条，
     满了丢**最旧的低优先级**项；两条之间留 120ms，避免连成一片听不清。 */
  var VOICE_Q = [];                       // 待播队列（正在播的那条已从队列摘出）
  var VOICE_Q_MAX = 6;                    // 队列上限
  var VOICE_GAP = 120;                    // 两条之间的最小间隔（ms）
  var VOICE_PRI_TILE = 1, VOICE_PRI_CALL = 2;
  /* 喊话白名单：用户点名的「碰/杠/暗杠/补杠/杠开/抢杠/胡/自摸」。
     暗杠/补杠**不在词表里**（它们不喊牌、出牌碰实音，见 VOICE_NAMES 的说明），
     登记它们只是表明「这类动作属于高优先级」；流局是整局收尾，也算喊话。 */
  var VOICE_CALLS = "碰 杠 暗杠 补杠 杠开 抢杠 胡 自摸 流局".split(" ");
  var VOICE_CALL_SET = (function () { var m = {}, i; for (i = 0; i < VOICE_CALLS.length; i++) m[VOICE_CALLS[i]] = 1; return m; })();
  var VOICE_PLAYING = null;                // 正在播的那条（队列里已摘掉）
  var VOICE_CUR = null, VOICE_GAP_TIMER = 0, VOICE_WATCH = 0;

  /** 牌面 / 动作 -> 语音文件名（"1筒" -> "1筒.mp3"；"中" -> "红中.mp3"；"發" -> "发财.mp3"）；无效名返回 "" */
  function voiceFile(name) {
    var s = (name === undefined || name === null) ? "" : String(name).replace(/\.mp3$/i, "").trim();
    if (!s) return "";
    /* 字牌先换成**念出来的词**：东→东风 / 南→南风 / 西→西风 / 北→北风 / 中→红中 / 發→发财 / 白→白板。
       词表 VOICE_NAMES 的键就是素材文件基名（"红中.mp3" 的键是 "红中"），
       所以这里换成词之后直接拼 .mp3 即可，不存在「词与文件名两套写法」。
       ⚠ 别再写成 `if (s.charCodeAt(0) === 0x767C) return "发.mp3";` 那种**直接返回**：
         它会把「發财」也截成「发.mp3」，而旧文件已经删掉了 —— 这类"看到首字就返回"的
         写法还有个更隐蔽的毛病：绕过 VOICE_NAMES，词表里有没有这条都不再被检查。 */
    if (VOICE_HONOR_WORDS[s]) s = VOICE_HONOR_WORDS[s];
    return VOICE_NAMES[s] ? (s + ".mp3") : "";
  }
  /** 语音目录：index.html 里取 "audio/mj/"；HTA(mshta) 里取 mahjong.js 同级的绝对 file:// 目录 */
  function voiceRelBase() {
    var el = null, i, list;
    try {
      list = doc.getElementsByTagName ? doc.getElementsByTagName("script") : [];
      for (i = 0; list && i < list.length; i++) {
        if (String(list[i].src || "").indexOf("mahjong.js") >= 0) { el = list[i]; break; }
      }
    } catch (e) { el = null; }
    var s = el && el.src ? String(el.src) : "";
    if (!s) {
      try { s = doc.currentScript && doc.currentScript.src ? String(doc.currentScript.src) : ""; } catch (e2) { s = ""; }
    }
    if (!s) return "audio/mj/";
    s = s.replace(/\\/g, "/").replace(/[?#].*$/, "");
    var k = s.lastIndexOf("/");
    return (k >= 0 ? s.slice(0, k + 1) : "") + "audio/mj/";
  }
  function voiceBase() { if (VOICE_BASE === null) VOICE_BASE = voiceRelBase(); return VOICE_BASE; }
  /** 相对路径 + 基址 → URL（含 file:// 绝对基址时不要再加 "./"） */
  /** 座位 → 相对路径（座位 0 或无专属目录时用共用目录） */
  function voiceRelFor(rel, seat) {
    var sub = VOICE_SEATS[seat];
    return sub ? (sub + "/" + rel) : rel;
  }
  /** 相对路径 + 基址 → URL（含 file:// 绝对基址时不要再加 "./"） */
  function voiceUrlOf(rel) {
    var b = voiceBase();
    return /^[a-zA-Z]+:/.test(b) ? (b + rel) : ("./" + b + rel);
  }
  /** 牌名 → URL。带 seat 时返回座位专属目录的 URL。
   *  ⚠ 这里**只解析路径，不判断文件是否存在**（浏览器无法同步查询）。
   *     座位目录缺某个词时（如「暗杠」「补杠」只有音效没有喊牌），
   *     由 voiceAudio() 的 error 兜底换回共用目录。别在这里假设文件一定在。 */
  function voiceUrl(name, seat) {
    var f = voiceFile(name);
    return f ? voiceUrlOf(voiceRelFor(f, seat)) : "";
  }
  function voiceAudio(rel, seat) {
    var key = voiceRelFor(rel, seat);
    var a = VOICE_CACHE[key];
    if (a || !key) return a || null;
    try {
      a = new root.Audio(voiceUrlOf(key));
      try { a.preload = "auto"; } catch (e) {}
      a.volume = VOICE_VOL;
      /* 座位专属文件缺失 → 回落共用目录。
         为什么不能只靠「构造时猜路径」：浏览器无法同步判断文件是否存在，
         而座位目录里确实有不存在的词 —— 「暗杠」「补杠」按设计只有牌碰音效、
         没有喊牌语音（gen_mj_by_seat_tts.py 的 SILENT 常量），
         于是 seat1/2/3 的这两个 URL 必然 404。
         实测不装这个兜底时，Audio 直接 error、播不出来，而 say() 只看 Audio 对象
         非空就认为成功，于是**静默丢弃**，牌桌上这两个动作没有任何声音。
         修法：error 事件里把 src 换成共用目录版本并重新播（只回落一次，避免死循环）。 */
      if (VOICE_SEATS[seat]) {
        a.addEventListener("error", function () {
          var shared = voiceUrlOf(rel);
          if (!shared || a.src === shared) return;
          VOICE_STAT.fallbacks = (VOICE_STAT.fallbacks || 0) + 1;
          try { a.src = shared; a.load(); } catch (e) {}
        });
      }
      VOICE_CACHE[key] = a;
    } catch (e) { a = null; VOICE_STAT.errors++; }
    return a;
  }
  /** 预加载 43 条（只创建 Audio 对象，不播放；素材缺失时静默跳过）
   *  ⚠ 必须走 voiceFile()：字牌的词是「东风/红中/发财…」，直接拼 k + ".mp3"
   *    会去请求根本不存在的 东.mp3 / 中.mp3（改名后就是 404 死链，
   *    而且 AudioSys 不会因为一次失败请求报错，测试也测不出来）。 */
  function voicePreload() {
    for (var k in VOICE_NAMES) if (VOICE_NAMES.hasOwnProperty(k)) { var f = voiceFile(k); if (f) voiceAudio(f); }
    return { cached: Object.keys(VOICE_CACHE).length, total: Object.keys(VOICE_NAMES).length };
  }
  /** 队列里排一条。返回是否真的入队（队满且自己优先级最低时会被丢）。 */
  function voicePush(it) {
    if (VOICE_Q.length >= VOICE_Q_MAX) {
      /* 队满：丢**最旧的低优先级**项。
         若新来的这条比队列里所有项都低（典型场景：轮到喊话了，下家还在疯狂出牌），
         就直接丢它自己 —— 绝不能为了报一张牌把已排队的「碰/杠/胡」挤掉。 */
      var lo = 99, i;
      for (i = 0; i < VOICE_Q.length; i++) if (VOICE_Q[i].pri < lo) lo = VOICE_Q[i].pri;
      if (it.pri < lo) { VOICE_STAT.dropped++; return false; }
      for (i = 0; i < VOICE_Q.length; i++) {
        if (VOICE_Q[i].pri === lo) { VOICE_Q.splice(i, 1); VOICE_STAT.dropped++; break; }
      }
    }
    /* 插队：插到第一个**优先级更低**的项之前；同级一律排在同级之后（FIFO） */
    var at = VOICE_Q.length, j;
    for (j = 0; j < VOICE_Q.length; j++) if (VOICE_Q[j].pri < it.pri) { at = j; break; }
    VOICE_Q.splice(at, 0, it);
    VOICE_STAT.queued++;
    if (VOICE_Q.length > VOICE_STAT.maxQueue) VOICE_STAT.maxQueue = VOICE_Q.length;
    voicePump();
    return true;
  }
  /** 空闲就取下一条开播。间隔取「VOICE_GAP」与「该条自带 delay」的较大者。 */
  function voicePump() {
    if (VOICE_PLAYING || !VOICE_Q.length) return;
    var it = VOICE_Q.shift();
    /* ⚠ 必须**立刻**占住播放位，不能等到 voiceStart 里再占。
       因为中间要等 VOICE_GAP（或该条的 delay），这段窗口里 VOICE_PLAYING 若还是 null，
       下一次 say() 就会再走一遍 voicePump()，它 clearTimeout 掉上一个定时器 ——
       上一条**凭空消失**（实测：连说三条只有最后一条能响，前两条谁都没播过，
       而且 plays 计数、队列长度看起来都正常，不写时序断言根本抓不到）。 */
    VOICE_PLAYING = it;
    var wait = Math.max(VOICE_GAP, it.delay || 0);
    if (VOICE_GAP_TIMER) { root.clearTimeout(VOICE_GAP_TIMER); VOICE_GAP_TIMER = 0; }
    if (wait > 0) {
      VOICE_GAP_TIMER = root.setTimeout(function () {
        VOICE_GAP_TIMER = 0;
        if (VOICE_PLAYING === it) voiceStart(it);    // 间隔里被 voiceStopAll 取消 → 不再播
      }, wait);
    } else voiceStart(it);
  }
  /** 真正开播一条；ended / error / 超时三个出口都要把队列往前推，少一个就会卡死。 */
  function voiceStart(it) {
    if (VOICE_PLAYING !== it) return;                // 已被取消（关语音开关 / 重开一局）
    VOICE_CUR = it.audio;
    VOICE_STAT.started++;
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      try { it.audio.removeEventListener("ended", finish); } catch (e) {}
      try { it.audio.removeEventListener("error", finish); } catch (e2) {}
      if (VOICE_WATCH) { root.clearTimeout(VOICE_WATCH); VOICE_WATCH = 0; }
      if (VOICE_PLAYING === it) { VOICE_PLAYING = null; VOICE_CUR = null; }
      voicePump();
    }
    try {
      it.audio.addEventListener("ended", finish);
      it.audio.addEventListener("error", finish);
      it.audio.currentTime = 0;
      var p = it.audio.play();
      if (p && typeof p["catch"] === "function") p["catch"](function () { VOICE_STAT.errors++; finish(); });
      /* 兜底：ended 不来时（解码失败 / 宿主挂起播放）也必须让队列继续走。
         队列一旦卡死，后面排的「胡」永远轮不到 —— 比少播一条严重得多。
         duration 取不到时按 3 秒算（远大于任何一个报牌词，不会误杀正常播放）。 */
      var d = 0;
      try { d = it.audio.duration; } catch (e3) { d = 0; }
      if (!(d > 0) || !isFinite(d)) d = 3;
      VOICE_WATCH = root.setTimeout(finish, Math.round(d * 1000) + 1500);
    } catch (e4) { VOICE_STAT.errors++; finish(); }
  }
  /** 清空队列 + 停掉正在播的那条（关语音开关 / 收尾 / 重开一局时用） */
  function voiceStopAll() {
    if (VOICE_GAP_TIMER) { root.clearTimeout(VOICE_GAP_TIMER); VOICE_GAP_TIMER = 0; }
    if (VOICE_WATCH) { root.clearTimeout(VOICE_WATCH); VOICE_WATCH = 0; }
    if (VOICE_Q.length) VOICE_Q.length = 0;
    VOICE_PLAYING = null;
    if (VOICE_CUR) { try { VOICE_CUR.pause(); } catch (e) {} VOICE_CUR = null; }
  }
  /**
   * 播一条喊话：**入队**，一条播完再播下一条；绝不打断正在播的那条。
   * 关掉开关 / 素材缺失 / 无 Audio 时静默跳过，不抛异常、不阻塞牌局（Audio.play() 为异步）。
   * 返回解析出的 URL（素材缺失时也返回 URL，另有 misses 计数）。
   */
  function say(name, o) {
    o = o || {};
    if (!G.voiceOn) return "";
    var f = voiceFile(name);
    if (!f) return "";
    var seat = o.seat === undefined ? -1 : o.seat;
    var url = voiceUrlOf(voiceRelFor(f, seat));
    /* 先记账：只要「开关开 + 名字可映射」就算一次播报请求（素材缺失另记 misses） */
    VOICE_STAT.plays++; VOICE_STAT.last = f; VOICE_STAT.lastUrl = url;
    VOICE_STAT.lastSeat = seat; VOICE_STAT.lastAt = Date.now();
    VOICE_STAT.list.push(f); if (VOICE_STAT.list.length > 24) VOICE_STAT.list.shift();
    VOICE_STAT.uniq[f] = 1;
    try {
      var a = voiceAudio(f, seat);
      if (!a) { VOICE_STAT.misses++; return url; }   // 素材/Audio 缺失：静默跳过，不报错
      a.volume = o.vol === undefined ? VOICE_VOL : o.vol;
      var word = f.replace(/\.mp3$/i, "");
      voicePush({ file: f, url: url, audio: a, delay: o.delay || 0,
                  pri: VOICE_CALL_SET[word] ? VOICE_PRI_CALL : VOICE_PRI_TILE });
    } catch (e) { VOICE_STAT.errors++; }
    return url;
  }
  function loadVoicePref() {
    try {
      var v = root.localStorage ? root.localStorage.getItem(VOICE_KEY) : null;
      if (v === "0") return false;
      if (v === "1") return true;
    } catch (e) { /* 无 localStorage（HTA / 隐私模式）不影响玩法 */ }
    return true;
  }
  function saveVoicePref(on) {
    try { if (root.localStorage) root.localStorage.setItem(VOICE_KEY, on ? "1" : "0"); } catch (e) {}
  }
  function voiceToggle(on) {
    G.voiceOn = (on === undefined) ? !G.voiceOn : !!on;
    saveVoicePref(G.voiceOn);
    /* 关掉语音：正在播的那条 + 整个队列一起清 —— 否则关掉之后还会把排队的念完 */
    if (!G.voiceOn) voiceStopAll();
    renderVoiceToggle();
    return G.voiceOn;
  }
  function renderVoiceToggle() {
    var el = byId("mjmVoiceToggle");
    if (!el) return;
    el.className = "mjm-tg on" + (G.voiceOn ? "" : " off");
    el.setAttribute("data-voice-on", G.voiceOn ? "1" : "0");
    el.innerHTML = "\uD83D\uDD0A 语音 " + (G.voiceOn ? "开" : "关");
  }
  /** 自己打出的牌：清掉上一局播报状态，播「该牌牌名」 */
  function voiceSelfDiscard(tile) { say(tile, { seat: 0 }); }
  /** 暗杠 / 补杠的实音（不喊牌）：audio/sfx/mj-clack.mp3，缺失时静默不报错 */
  function gangClack() {
    try {
      var A = root.AudioSys;
      if (A && A.sfxFile) A.sfxFile("mj-clack", 0.9);
    } catch (e) { /* 无音频层不影响玩法 */ }
  }
  /** 牌局记录 → 语音（每个事件只触发一次，用 G.voiceN 游标记录进度） */
  function voiceTingOf(p, honors) {
    if (!p || p.hand.length % 3 !== 1) return false;
    try { return waitsFor(p.hand, p.melds, honors).length > 0; } catch (e) { return false; }
  }
  function voiceHook() {
    var E = G.E;
    if (!E || !E.log) return;
    if (G.voiceN > E.log.length) G.voiceN = E.log.length;
    var i, ev, kind, seat, tile, txt;
    for (i = G.voiceN; i < E.log.length; i++) {
      ev = E.log[i];
      if (!ev) continue;
      kind = ev.kind; seat = ev.seat; tile = ev.tile || "";
      txt = String(ev.text || "");
      if (kind === "discard") {
        if (seat === 0) { /* 自己出牌：在点击处即时播，这里不重复 */ }
        else say(tile, { seat: seat, vol: VOICE_AI_VOL, delay: VOICE_AI_DELAY });
      } else if (kind === "peng") {
        say("碰", { seat: seat });
      } else if (kind === "gang") {
        /* 「暗杠」「补杠」不喊牌，出**牌碰实音** —— 与素材侧一致：
           gen_mj_by_seat_tts.py 的 SILENT 常量把它们排除在语音之外，理由是
           「手上动作，用牌碰声表现」。之前这里却调 say("暗杠")，
           而四个座位目录都没有这个文件 => 必然 404 => 静默无声。
           现在改成明确播放 sfx-mj-clack，不再走语音层。 */
        if (txt.indexOf("暗杠") >= 0 || txt.indexOf("补杠") >= 0) gangClack();
        else say("杠", { seat: seat });
      } else if (kind === "rob") {
        if (txt.indexOf("有人可以") < 0) say("抢杠", { seat: seat });    // 真抢杠胡（排除「有人可以抢杠」提示）
      } else if (kind === "draw") {
        if (txt.indexOf("杠后补牌") >= 0) {
          say("杠开", { seat: seat });
          G.ting[seat] = false;                     // 补牌后必然未听，允许再次播「听」
        }
      } else if (kind === "win") {
        var sc = E.P && E.P[seat];
        var after = sc ? voiceTingOf(sc, E.honors) : false;
        G.ting[seat] = after;
        if (txt.indexOf("流局") >= 0 || txt.indexOf("荒庄") >= 0) {
          say("流局", { seat: seat });
        } else if (txt.indexOf("抢杠") >= 0) {
          say("抢杠", { seat: seat });
        } else if (txt.indexOf("杠上开花") >= 0 || txt.indexOf("杠开") >= 0) {
          say("杠开", { seat: seat });
        } else if (seat === 0) {
          say(txt.indexOf("自摸") >= 0 ? "自摸" : "胡", { seat: seat });
        } else {
          say("胡", { seat: seat });
        }
      } else if (kind === "turn" && seat === 0 && E.P && E.P[0]) {
        // 自己「听牌」提示：只在没听 → 听牌 的那一刻播一次，绝不重复
        var cur = voiceTingOf(E.P[0], E.honors);
        if (cur && !G.ting[0]) say("听", { seat: 0 });
        G.ting[0] = cur;
      }
    }
    G.voiceN = E.log.length;
  }

  var CSS = [
    ".mjm-wrap{position:relative;line-height:0;filter:drop-shadow(0 22px 54px rgba(0,0,0,.8))}",
    ".mjm-cv{display:block;width:min(94vw,1180px);height:auto;border-radius:16px;cursor:default}",
    ".mjm-cv.pick{cursor:pointer}",
    ".mjm-hud{position:absolute;left:0;right:0;top:1.1%;display:flex;justify-content:space-between;align-items:center;",
    "  padding:0 2.4%;font:12px/1.5 'Microsoft YaHei',sans-serif;color:#cbd6e6;pointer-events:none;",
    "  text-shadow:0 1px 3px #000,0 0 10px rgba(0,0,0,.9)}",
    ".mjm-hud b{color:#ffd76e;font-variant-numeric:tabular-nums}",
    ".mjm-hud-c{font-weight:700;letter-spacing:1px;color:#ffd76e}",
    ".mjm-acts{position:absolute;left:50%;transform:translateX(-50%);bottom:16.5%;display:flex;flex-direction:column;",
    "  align-items:center;gap:6px;font-family:'Microsoft YaHei',sans-serif}",
    ".mjm-btns{display:flex;gap:10px;align-items:center}",
    ".mjm-btn{min-width:74px;padding:9px 14px;border-radius:8px;border:1px solid rgba(255,215,110,.5);",
    "  background:linear-gradient(180deg,rgba(40,32,16,.96),rgba(18,14,26,.96));color:#ffd76e;font-size:15px;",
    "  letter-spacing:3px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.6)}",
    ".mjm-btn:hover{background:linear-gradient(180deg,rgba(80,62,24,.98),rgba(30,22,40,.98));transform:translateY(-1px)}",
    ".mjm-btn.pass{border-color:rgba(255,255,255,.28);color:#a9b4c6}",
    ".mjm-btn.hu{border-color:#5dffa0;color:#5dffa0;box-shadow:0 0 18px rgba(93,255,160,.45)}",
    ".mjm-bar{width:150px;height:4px;border-radius:2px;background:rgba(255,255,255,.16);overflow:hidden;display:none}",
    ".mjm-bar i{display:block;height:100%;width:100%;background:linear-gradient(90deg,#ff7d9c,#ffd76e)}",
    ".mjm-bar.on{display:block}",
    ".mjm-ct{font-size:10.5px;color:#ffd76e;letter-spacing:1px}",
    ".mjm-log{position:absolute;right:1.2%;bottom:2.2%;width:150px;border-radius:8px;overflow:hidden;",
    "  background:rgba(6,8,14,.72);border:1px solid rgba(255,255,255,.14);font:11px/1.65 'Microsoft YaHei',sans-serif;color:#9fabbe}",
    ".mjm-log-h{cursor:pointer;padding:4px 9px;color:#ffd76e;letter-spacing:2px;border-bottom:1px solid rgba(255,255,255,.08);",
    "  user-select:none;display:flex;justify-content:space-between}",
    ".mjm-log-b{padding:4px 9px;max-height:112px;overflow-y:auto}",
    ".mjm-log.min .mjm-log-b{display:none}",
    ".mjm-res{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;",
    "  background:rgba(4,3,8,.66);border-radius:16px;font-family:'Microsoft YaHei',sans-serif}",
    ".mjm-card{width:min(430px,86%);background:rgba(14,12,22,.97);border:1px solid rgba(255,215,110,.34);",
    "  border-radius:12px;padding:20px 22px;text-align:center;color:#eceaf4;box-shadow:0 20px 60px rgba(0,0,0,.8);line-height:1.6}",
    ".mjm-card .k{font-size:10px;letter-spacing:5px;color:#8a87a3}",
    ".mjm-card .t{font-size:26px;letter-spacing:6px;margin:6px 0 2px;color:#ffd76e}",
    ".mjm-card .t.lose{color:#ff7d9c}",
    ".mjm-card .n{font-size:13px;color:#cbd6e6;margin-bottom:10px}",
    ".mjm-card .r{display:flex;justify-content:space-around;gap:8px;margin:12px 0;font-size:12px;color:#8a87a3}",
    ".mjm-card .r b{display:block;font-size:17px;color:#ffd76e;margin-top:3px;font-variant-numeric:tabular-nums}",
    ".mjm-card .r b.minus{color:#ff7d9c}",
    ".mjm-card .lg{text-align:left;max-height:120px;overflow-y:auto;font-size:11px;line-height:1.7;color:#8a87a3;",
    "  border-top:1px solid rgba(255,255,255,.1);padding-top:8px;margin-top:6px}",
    ".mjm-card button{margin-top:14px;width:100%;padding:11px;border-radius:8px;border:1px solid rgba(255,215,110,.5);",
    "  background:linear-gradient(180deg,rgba(40,32,16,.96),rgba(18,14,26,.96));color:#ffd76e;font-size:14px;letter-spacing:4px;cursor:pointer}",
    ".mjm-rule{position:absolute;left:1.6%;bottom:1.0%;font:11px/1.7 'Microsoft YaHei',sans-serif;color:rgba(203,214,230,.5)}",
    ".mjm-rule b{color:rgba(255,215,110,.75)}",
    /* ── 智脑提示 ── */
    ".mjm-brain{position:absolute;left:1.2%;top:1.0%;width:min(300px,32%);border-radius:10px;overflow:hidden;",
    "  background:linear-gradient(180deg,rgba(10,12,20,.88),rgba(6,8,14,.80));border:1px solid rgba(255,215,110,.32);",
    "  color:#cbd6e6;font:12px/1.7 'Microsoft YaHei',sans-serif;box-shadow:0 8px 26px rgba(0,0,0,.5)}",
    ".mjm-brain.off{opacity:.45}",
    ".mjm-brain-h{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 9px;",
    "  border-bottom:1px solid rgba(255,255,255,.08)}",
    ".mjm-brain-t{letter-spacing:2px;color:#ffd76e;font-weight:700;font-size:12px}",
    ".mjm-brain-t::before{content:'\\\\25C6';margin-right:5px;color:#8ef2c0}",
    ".mjm-tg{cursor:pointer;user-select:none;font-size:11px;padding:2px 8px;border-radius:999px;",
    "  border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);color:#cbd6e6}",
    ".mjm-tg.on{border-color:rgba(90,240,170,.65);color:#7dffc0;box-shadow:0 0 10px rgba(90,240,170,.28)}",
    ".mjm-tg{font-size:11px;padding:2px 8px;border-radius:999px}",
    ".mjm-tg.off{border-color:rgba(255,255,255,.18);color:#8a93a3;box-shadow:none}",
    ".mjm-tgs{display:flex;gap:6px;align-items:center}",
    ".mjm-ting{position:absolute;left:1.2%;top:9.4%;display:none;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;",
    "  background:linear-gradient(180deg,rgba(10,12,20,.88),rgba(6,8,14,.80));border:1px solid rgba(120,255,190,.55);",
    "  color:#8ef2c0;font:12px/1.5 'Microsoft YaHei',sans-serif;letter-spacing:1px;box-shadow:0 6px 18px rgba(0,0,0,.45)}",
    ".mjm-ting.on{display:flex}",
    ".mjm-brain-b{padding:6px 10px 7px;max-height:96px;overflow:hidden}",
    ".mjm-brain-b .l1{color:#eef3fb;font-weight:700}",
    ".mjm-brain-b .l1.hit{color:#7dffc0;text-shadow:0 0 10px rgba(90,240,170,.35)}",
    ".mjm-brain-b .l2{color:#ffd76e}",
    ".mjm-brain-b .l3{color:#8a96ab;font-size:11px}",
    ".mjm-hintmark{position:absolute;display:none;box-sizing:border-box;border:3px solid #ffd76e;border-radius:9px;",
    "  pointer-events:none;z-index:6;box-shadow:0 0 14px rgba(255,215,110,.85),inset 0 0 10px rgba(255,215,110,.35)}",
    ".mjm-hintmark.on{display:block;animation:mjmPulse 1.05s ease-in-out infinite}",
    "@keyframes mjmPulse{0%,100%{opacity:.50;box-shadow:0 0 8px rgba(255,215,110,.45)}50%{opacity:1;box-shadow:0 0 24px rgba(255,215,110,1)}}",
    /* ── 结算亮牌 ── */
    ".mjm-card.wide{width:min(712px,95%);max-height:min(94%,calc(100vh - 56px));overflow-y:auto;padding:16px 18px}",
    /* 结算出口兜底：四家手牌 + 赔付明细比视口高时，卡自己滚，「继 续」钉在卡底部始终可见 */
    ".mjm-card.wide #mjmGo{position:sticky;bottom:0;z-index:4;box-shadow:0 -14px 18px -10px rgba(6,4,10,.95)}",
    ".mjm-rhands{display:flex;flex-direction:column;gap:7px;margin:10px 0}",
    ".mjm-rhand{text-align:left;border:1px solid rgba(255,255,255,.10);border-radius:10px;padding:7px 9px;",
    "  background:rgba(255,255,255,.025)}",
    ".mjm-rhand.win{border-color:rgba(255,215,110,.62);background:rgba(255,215,110,.08);box-shadow:inset 0 0 18px rgba(255,215,110,.10)}",
    ".rh-h{display:flex;align-items:center;gap:9px;margin-bottom:5px;font-size:12px}",
    ".rh-h b{color:#ffd76e;letter-spacing:1px}",
    ".rh-h em{font-style:normal;font-size:11px;color:#8a96ab}",
    ".rh-h em.rh-win{color:#7dffc0}",
    ".rh-h em.rh-tp{color:#ffd76e}",
    ".rh-h i{margin-left:auto;font-style:normal;font-size:12px;color:#7dffc0;font-variant-numeric:tabular-nums}",
    ".rh-h i.minus{color:#ff7d9c}",
    ".rh-tiles{display:flex;flex-wrap:wrap;gap:2px}",
    ".rh-melds{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:4px}",
    ".rh-mlabel{font-size:10px;color:#8a96ab;letter-spacing:1px}",
    ".rh-meld{display:flex;align-items:center;gap:1px}",
    ".mj-mtag{font-style:normal;font-size:10px;color:#ffd76e;margin-right:2px}",
    ".mjm-rtile{display:inline-flex;align-items:center;justify-content:center;width:25px;height:34px;",
    "  font-style:normal;font-family:'KaiTi','Microsoft YaHei',serif;font-size:14px;line-height:1;",
    "  border-radius:3px;background:linear-gradient(180deg,#fdfaf0,#e4dcc4);color:#182236;",
    "  box-shadow:0 1px 0 rgba(0,0,0,.35);border:1px solid rgba(0,0,0,.25)}",
    ".mjm-rtile.meld{border-color:#c9a24a;background:linear-gradient(180deg,#f6efd8,#ddd0ac)}",
    ".mjm-rtile.win{border-color:#ffd76e;box-shadow:0 0 0 2px #ffd76e,0 0 14px rgba(255,215,110,.92)}",
    ".mjm-rpay{margin:6px 0 2px;font-size:12px;color:#cbd6e6}",
    ".rp-1{font-weight:700}",
    ".rp-2{color:#ffd76e;font-variant-numeric:tabular-nums}",
    ".rp-tiers{display:flex;justify-content:center;gap:6px;flex-wrap:wrap;margin-top:7px}",
    ".rp-tier{border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:3px 8px;font-size:11px;color:#8a96ab}",
    ".rp-tier b{display:block;color:#ffd76e;font-size:14px;font-variant-numeric:tabular-nums}",
    ".rp-tier.cur{border-color:rgba(255,215,110,.75);color:#ffd76e;box-shadow:0 0 12px rgba(255,215,110,.30)}",
    /* ── 赌注系统：结算板新增行 ── */
    ".mjm-rpay .rp-sys{margin-top:8px;padding-top:7px;border-top:1px dashed rgba(255,255,255,.16);font-size:11.5px;line-height:1.75}",
    ".rp-sys .rs-cash{color:#ffd76e;font-weight:700;font-variant-numeric:tabular-nums}",
    ".rp-sys .rs-style{color:#8a96ab}",
    /* 「本局影响」行：打法带来的剧情后果（独立高亮，一眼看到） */
    ".rp-sys .rs-impact{color:#ffb86e;font-weight:700;padding:3px 7px;margin:3px 0;border-radius:6px;",
    "  background:linear-gradient(90deg,rgba(255,184,110,.14),rgba(255,184,110,0));border-left:2px solid #ffb86e}",
    ".rp-sys .rs-bond{color:#5dffa0}",
    ".rp-sys .rs-rep{color:#a9c8ff}",
    ".rp-sys .rs-intel{color:#b07dff}",
    ".rp-sys .rs-achv{color:#ffd76e}",
    /* ── 自由局开局面板 ── */
    ".mjm-lobby,.mjm-inv{font-family:'Microsoft YaHei',sans-serif;line-height:1.6}",
    ".mjm-card.mjm-lobby{width:min(560px,92%);text-align:left}",
    ".ml-sec{font-size:11px;letter-spacing:3px;color:#8a87a3;margin:12px 0 6px}",
    ".ml-tiers,.ml-styles{display:flex;gap:8px;flex-wrap:wrap}",
    ".ml-tier,.ml-style{flex:1 1 140px;min-width:120px;padding:10px 12px;border-radius:9px;cursor:pointer;text-align:left;",
    "  border:1px solid rgba(255,255,255,.18);background:rgba(12,12,20,.92);color:#cbd6e6;font-size:12.5px}",
    ".ml-tier b{display:block;font-size:19px;color:#ffd76e;font-variant-numeric:tabular-nums}",
    ".ml-tier s,.ml-style s{display:block;text-decoration:none;font-size:10.5px;color:#8a87a3;margin-top:2px}",
    ".ml-tier:hover,.ml-style:hover{border-color:rgba(255,215,110,.6)}",
    ".ml-tier.cur,.ml-style.cur{border-color:#ffd76e;box-shadow:0 0 14px rgba(255,215,110,.32);background:rgba(40,32,16,.72)}",
    ".ml-tier.off,.ml-style.off{opacity:.42;cursor:not-allowed;border-style:dashed}",
    ".ml-tier.off s{color:#ff7d9c}",
    ".ml-rec{margin-top:12px;padding:8px 10px;border-radius:8px;background:rgba(8,10,16,.8);",
    "  border:1px solid rgba(255,255,255,.12);font-size:11.5px;color:#8a96ab}",
    ".ml-rec b{color:#ffd76e}",
    ".ml-btns{display:flex;gap:10px;margin-top:14px}",
    ".ml-btns button{flex:1;padding:11px;border-radius:8px;cursor:pointer;font-size:13.5px;letter-spacing:3px;",
    "  border:1px solid rgba(255,215,110,.5);background:linear-gradient(180deg,rgba(40,32,16,.96),rgba(18,14,26,.96));color:#ffd76e}",
    ".ml-btns button.ghost{border-color:rgba(255,255,255,.22);color:#a9b4c6;background:rgba(12,12,20,.9)}",
    /* ── NPC 邀约条（手机消息） ── */
    ".mjm-inv{width:min(340px,90vw);display:flex;gap:10px;padding:11px 12px;border-radius:14px;",
    "  background:linear-gradient(180deg,rgba(16,14,26,.97),rgba(10,9,16,.97));border:1px solid rgba(255,215,110,.4);",
    "  box-shadow:0 14px 40px rgba(0,0,0,.7);color:#cbd6e6}",
    ".mjm-inv .iv-av{width:38px;height:38px;flex:0 0 38px;border-radius:50%;display:flex;align-items:center;justify-content:center;",
    "  background:linear-gradient(180deg,#3a2a12,#191426);color:#ffd76e;font-size:17px;border:1px solid rgba(255,215,110,.5)}",
    ".mjm-inv .iv-body{flex:1;min-width:0}",
    ".mjm-inv .iv-name{font-size:12px;color:#ffd76e;letter-spacing:1px}",
    ".mjm-inv .iv-name span{color:#8a87a3;font-size:10px;margin-left:6px}",
    ".mjm-inv .iv-msg{font-size:13.5px;color:#eceaf4;margin:3px 0 2px}",
    ".mjm-inv .iv-meta{font-size:10.5px;color:#8a87a3}",
    ".mjm-inv .iv-gain{font-size:10.5px;color:#ffb86e;margin-top:3px;padding-left:6px;border-left:2px solid rgba(255,184,110,.6)}",
    ".mjm-inv .iv-btns{display:flex;gap:8px;margin-top:9px}",
    ".mjm-inv .iv-btns button{flex:1;padding:7px;border-radius:7px;cursor:pointer;font-size:12px;letter-spacing:2px;",
    "  border:1px solid rgba(255,215,110,.5);background:rgba(40,32,16,.9);color:#ffd76e}",
    ".mjm-inv .iv-btns button.no{border-color:rgba(255,255,255,.2);color:#a9b4c6;background:rgba(12,12,20,.9)}",
    ".mjm-inv .iv-btns button[disabled]{opacity:.45;cursor:not-allowed}"
  ].join("");

  function injectStyle() {
    if (byId(STYLE_ID)) return;
    var s = mkEl("style"); s.id = STYLE_ID; s.textContent = CSS;
    (doc.head || doc.body).appendChild(s);
  }

  function buildDom(host) {
    host.innerHTML = "";
    var wrap = mkEl("div", "mjm-wrap");
    var cv = mkEl("canvas", "mjm-cv");
    // 高清位图：devicePixelRatio 至少 2x（牌面细线/圆点才不糊）
    G.dpr = Math.max(2, Math.min(3, root.devicePixelRatio || 1));
    cv.width = Math.round(W * G.dpr); cv.height = Math.round(H * G.dpr);
    // 显式 CSS 尺寸：IE11 不认 CSS 的 min()，否则会把 2480px 的位图按原尺寸铺出来
    var cssW = Math.max(320, Math.min(1180, Math.round((root.innerWidth || W) * .94)));
    cv.style.width = cssW + "px";
    cv.style.height = Math.round(cssW * H / W) + "px";
    cv.style.maxWidth = "100%";
    wrap.appendChild(cv);

    var hud = mkEl("div", "mjm-hud");
    hud.innerHTML =
      '<div class="mjm-hud-l">剩余 <b id="mjmWall">–</b> 张 · 第 <b id="mjmTurn">1</b> 巡</div>' +
      '<div class="mjm-hud-c" id="mjmActor">开局</div>' +
      '<div class="mjm-hud-r" id="mjmHint">–</div>';
    wrap.appendChild(hud);

    var brain = mkEl("div", "mjm-brain" + (G.hintOn ? "" : " off"));
    brain.innerHTML = '<div class="mjm-brain-h"><span class="mjm-brain-t">智脑提示</span>' +
      '<span class="mjm-tgs"><span class="mjm-tg' + (G.voiceOn ? " on" : " off") + '" id="mjmVoiceToggle" title="打牌语音播报开关，状态保存在本地">\uD83D\uDD0A 语音 ' + (G.voiceOn ? "开" : "关") + '</span>' +
      '<span class="mjm-tg' + (G.hintOn ? " on" : "") + (G.hintLocked ? " lock" : "") + '" id="mjmHintToggle" title="' +
      (G.hintLocked ? "放水模式：本局智脑提示不可开启" : "") + '">' + hintLabel() + '</span></span></div>' +
      '<div class="mjm-brain-b" id="mjmBrainB"><div class="l1">—</div></div>';
    brain.id = "mjmBrain";
    wrap.appendChild(brain);
    var mark = mkEl("div", "mjm-hintmark");
    mark.id = "mjmHintMark";
    wrap.appendChild(mark);
    var ting = mkEl("div", "mjm-ting");
    ting.id = "mjmTing";
    ting.innerHTML = "\uD83D\uDD0A 已听牌";
    wrap.appendChild(ting);

    var acts = mkEl("div", "mjm-acts");
    acts.innerHTML = '<div class="mjm-bar" id="mjmBar"><i id="mjmCd"></i></div>' +
      '<div class="mjm-ct" id="mjmCt"></div><div class="mjm-btns" id="mjmBtns"></div>';
    wrap.appendChild(acts);

    var log = mkEl("div", "mjm-log");
    log.innerHTML = '<div class="mjm-log-h" id="mjmLogH"><span>牌 局 记 录</span><span id="mjmLogT">▾</span></div>' +
      '<div class="mjm-log-b" id="mjmLogB"></div>';
    wrap.appendChild(log);

    var rule = mkEl("div", "mjm-rule");
    rule.id = "mjmRule";
    rule.innerHTML = '<b>赣麻</b> 无吃 · 无点炮 · 只能自摸<br>碰 / 杠 / 抢杠胡（暗杠不可抢）<br>' +
      (G.E ? deckSize(G.E.honors) : deckSize(INCLUDE_HONORS)) + ' 张（万条筒 + 东南西北中發白）<br>' +
      '注码 <b>¥' + (G.stake || STAKE_DEFAULT) + '</b> · 打法 <b>' + styleName(G.style) + '</b>' +
      (G.hintLocked ? '（智脑关闭）' : '');
    wrap.appendChild(rule);

    wrap.appendChild(mkEl("div", "mjm-res", "")); var res = wrap.lastChild;
    res.id = "mjmRes"; res.style.display = "none";
    host.appendChild(wrap);
    G.cv = cv; G.ctx = cv.getContext("2d");
    return cv;
  }

  /* ── 坐标 / 命中 ── */
  function toLogical(e) {
    var r = G.cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
  }
  function hitHand(x, y) {
    var rects = G.handRects, i, r;
    for (i = 0; i < rects.length; i++) {
      r = rects[i];
      var lift = r.drawn ? LAYOUT.hand.drawnLift : (G.hover === i ? LAYOUT.hand.lift : 0);
      if (x >= r.x && x <= r.x + r.w && y >= r.y - lift && y <= r.y + r.h) return i;
    }
    return -1;
  }
  function canHumanDiscard() {
    var E = G.E;
    return !!(G.on && !G.finished && !G.result && E && E.phase === "turn" && E.cur === 0 && Date.now() >= G.uiLock);
  }
  function onMove(e) {
    if (!G.cv) return;
    var p = toLogical(e), i = canHumanDiscard() ? hitHand(p.x, p.y) : -1;
    if (i !== G.hover) { G.hover = i; G.cv.className = "mjm-cv" + (i >= 0 ? " pick" : ""); }
  }
  function onClick(e) {
    if (!canHumanDiscard()) return;
    var p = toLogical(e), i = hitHand(p.x, p.y);
    if (i < 0) return;
    var ok = G.E.discard(0, i);
    if (ok) { sfx("click"); voiceSelfDiscard(G.E.P[0].discards[G.E.P[0].discards.length - 1]); afterHuman(); }
  }

  /* ── 日志 / HUD ── */
  function renderLog() {
    var E = G.E, box = byId("mjmLogB");
    if (!box || !E) return;
    for (var i = G.logRendered; i < E.log.length; i++) {
      var d = mkEl("div");
      d.textContent = E.log[i].text;
      var k = E.log[i].kind;
      if (k === "win") d.style.color = "#5dffa0";
      else if (k === "gang" || k === "peng") d.style.color = "#ffd76e";
      box.appendChild(d);
    }
    G.logRendered = E.log.length;
    while (box.children.length > 140) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  function playNewSfx() {
    var E = G.E; if (!E) return;
    while (G.sfxN < E.log.length) {
      var ev = E.log[G.sfxN];
      if (ev.kind === "win") sfx("good");
      else if (ev.kind === "peng" || ev.kind === "gang") sfx("ding");
      else if (ev.kind === "discard") sfx("click");
      else sfx("blip");
      G.sfxN++;
    }
    G.sfxN = E.log.length;
    voiceHook();
    renderLog();
  }
  function humanHint() {
    var p = G.E.P[0], hand = p.hand.slice();
    if (p.drawn !== null && hand.length % 3 === 2) hand.pop();
    if (hand.length % 3 !== 1) return "–";
    var waits = waitsFor(hand, p.melds, G.E.honors);
    if (waits.length) {
      var n = 0, i, used;
      for (i = 0; i < waits.length; i++) n += 4 - countIn(hand, waits[i]);
      return "已听牌 · 听 " + waits.join(" / ") + "（" + n + " 张）";
    }
    var s = bestShanten(hand, p.melds.length);
    return "未听牌 · " + s + " 向听" + (G.E.phase === "turn" && G.E.cur === 0 ? "（建议打 " + aiDiscard(hand, p.melds, G.E.seenBy(0), G.E.honors) + "）" : "");
  }
  function updateHud() {
    var E = G.E; if (!E) return;
    var el;
    el = byId("mjmTing");
    if (el) {
      var tp = (E.phase === "turn" || E.phase === "claim" || E.phase === "rob") && voiceTingOf(E.P[0], E.honors);
      el.className = "mjm-ting" + (tp ? " on" : "");
    }
    el = byId("mjmWall"); if (el) el.textContent = E.wall.length;
    el = byId("mjmTurn"); if (el) el.textContent = E.turnNo;
    el = byId("mjmHint"); if (el) el.textContent = humanHint();
    el = byId("mjmActor");
    if (el) {
      if (E.phase === "over") el.textContent = "本局结束";
      else if (E.phase === "turn") el.textContent = E.cur === 0 ? "你的回合 · 点手牌打出" : E.P[E.cur].name + " 思考中…";
      else if (E.phase === "claim") el.textContent = E.pending.seat === 0 ? "可以碰 / 杠" : E.P[E.pending.seat].name + " 考虑中…";
      else if (E.phase === "rob") el.textContent = E.pending.seats.indexOf(0) >= 0 ? "可以抢杠胡！" : "有人想抢杠…";
    }
  }

  /* ── 行动窗口（碰 / 杠 / 抢杠胡 / 过） ── */
  function renderActs() {
    var btns = byId("mjmBtns"), bar = byId("mjmBar"), ct = byId("mjmCt");
    if (!btns) return;
    btns.innerHTML = "";
    var w = G.win;
    if (!w || !w.items.length) { if (bar) bar.className = "mjm-bar"; if (ct) ct.textContent = ""; return; }
    for (var i = 0; i < w.items.length; i++) {
      (function (it) {
        var b = mkEl("button", "mjm-btn" + (it.cls ? " " + it.cls : ""), it.label);
        b.setAttribute("data-act", it.act);
        b.onclick = function () { resolveAct(it.act); };
        btns.appendChild(b);
      })(w.items[i]);
    }
    if (bar) bar.className = "mjm-bar" + (w.deadline ? " on" : "");
  }
  function closeWin() {
    if (G.winTimer) { root.clearTimeout(G.winTimer); G.winTimer = 0; }
    G.win = null;
    renderActs();
  }
  function openWin(items, ms, onTimeout) {
    closeWin();
    G.win = { items: items, deadline: ms ? Date.now() + ms : 0, total: ms || 0, timeout: onTimeout };
    renderActs();
    if (ms) {
      G.winTimer = later(function () {
        G.winTimer = 0;
        var w = G.win; G.win = null; renderActs();
        if (w && w.timeout) w.timeout();
      }, ms);
    }
  }
  function tickWin() {
    if (!G.win || !G.win.deadline) return;
    var left = Math.max(0, G.win.deadline - Date.now());
    var bar = byId("mjmCd"), ct = byId("mjmCt");
    if (bar) bar.style.width = (G.win.total ? left / G.win.total * 100 : 0) + "%";
    if (ct) ct.textContent = "自动「过」 " + (left / 1000).toFixed(1) + "s";
  }

  /** 「智脑提示」计算入参：手牌 + 副露 + 全桌已见（三家弃牌 + 四家副露） */
  function hintSeen(seat) {
    var E = G.E; if (!E) return {};
    var seen = {}, i, j, p;
    for (i = 0; i < 4; i++) {
      p = E.P[i];
      if (i !== seat) for (j = 0; j < p.discards.length; j++) seen[p.discards[j]] = (seen[p.discards[j]] || 0) + 1;
      for (j = 0; j < p.melds.length; j++) {
        var mt = p.melds[j].tiles || [];
        for (var q = 0; q < mt.length; q++) seen[mt[q]] = (seen[mt[q]] || 0) + 1;
      }
    }
    return seen;
  }
  /** 该不该算提示：轮到自己出牌 / 响应窗口 / 已结算都不算 */
  function hintShouldCalc() {
    var E = G.E;
    return !!(G.on && !G.finished && !G.result && E && E.phase === "turn" && E.cur === 0 && E.P[0].hand.length % 3 === 2);
  }
  function calcHint() {
    var p = G.E.P[0];
    var t0 = Date.now();
    var h = null;
    try {
      h = hintCalc({ hand: p.hand, melds: p.melds, seen: hintSeen(0), honors: G.E.honors });
      G.hintErr = "";
    } catch (e) { h = null; G.hintErr = "hintCalc:" + (e && e.message || e); }   // 提示算失败不能让整桌渲染挂掉
    G.hintCalcN++;
    G.hintLastMs = Date.now() - t0;
    if (G.hintLastMs > G.hintWorstMs) G.hintWorstMs = G.hintLastMs;
    return h;
  }
  /** 每回合刷新一次（同手牌不重算）：返回当前提示 */
  function updateHint() {
    if (!G.E) return null;
    if (!G.hintOn || !hintShouldCalc()) { G.hint = null; G.hintIdx = -1; G.hintKey = ""; return null; }
    var p = G.E.P[0], h = G.E.honors, sc = hintSeen(0);
    var key = sortTiles(p.hand).join(",") + "|" + p.melds.length + "|" + (h ? 1 : 0) + "|" +
      sortTiles(Object.keys(sc)).map(function (k) { return k + sc[k]; }).join("");
    if (key !== G.hintKey) { G.hintKey = key; G.hint = calcHint(); }
    G.hintIdx = G.hint && typeof G.hint.discardIdx === "number" ? G.hint.discardIdx : -1;
    return G.hint;
  }
  function brainHTML(h) {
    if (G.hintLocked) return '<div class="l3">放水模式 · 智脑提示已关闭（本局不可开启）</div>';
    if (!G.hintOn) return '<div class="l3">智脑提示已关闭（点右上角开关恢复）</div>';
    if (!h) return '<div class="l1">—</div><div class="l3">轮到你出牌时给出建议</div>';
    var L = hintLines(h);
    return '<div class="l1' + (h.tenpaiNow || h.tenpaiAfter ? " hit" : "") + '">' + L.l1 + '</div>' +
      '<div class="l2">' + L.l2 + '</div><div class="l3">' + L.l3 + '</div>';
  }
  function renderBrain() {
    var box = byId("mjmBrainB"), tg = byId("mjmHintToggle"), brain = byId("mjmBrain");
    if (box) box.innerHTML = brainHTML(G.hint);
    if (tg) {
      tg.innerHTML = hintLabel();
      tg.className = "mjm-tg" + (G.hintOn ? " on" : "") + (G.hintLocked ? " lock" : "");
      tg.title = G.hintLocked ? "放水模式：本局智脑提示不可开启" : "";
    }
    if (brain) brain.className = "mjm-brain" + (G.hintOn ? "" : " off");
  }
  /** 更新「被建议的牌」的金框位置（CSS 像素，盖在画布同一张牌上） */
  function updateHintMark() {
    var m = byId("mjmHintMark");
    if (!m) return;
    if (!G.hintOn || G.hintIdx < 0 || !G.handRects || !G.handRects[G.hintIdx] || !G.cv) { m.className = "mjm-hintmark"; m.style.display = "none"; return; }
    var t = G.handRects[G.hintIdx], cr = G.cv.getBoundingClientRect(), sx = cr.width / W, sy = cr.height / H;
    var lift = t.drawn ? LAYOUT.hand.drawnLift : 0;
    m.className = "mjm-hintmark on";
    m.style.display = "block";
    m.style.left = ((t.x - 3) * sx).toFixed(1) + "px";
    m.style.top = ((t.y - 3 - lift) * sy).toFixed(1) + "px";
    m.style.width = ((t.w + 6) * sx).toFixed(1) + "px";
    m.style.height = ((t.h + 6) * sy).toFixed(1) + "px";
  }
  function hintToggle(on) {
    /* 放水模式：智脑提示锁死为关，且本局不允许打开（验收要求：面板关闭且不可开） */
    if (G.hintLocked && on !== false) { renderBrain(); updateHintMark(); return false; }
    G.hintOn = (on === undefined) ? !G.hintOn : !!on;
    saveHintPref(G.hintOn);
    G.hintKey = "";
    updateHint(); renderBrain(); updateHintMark();
    return G.hintOn;
  }
  /** 人类操作结束后的统一收尾 */
  function afterHuman() {
    closeWin();
    playNewSfx(); updateHud();
    refreshHint();
    if (G.idleTimer) { root.clearTimeout(G.idleTimer); G.idleTimer = 0; }
    if (!G.on || G.finished) return;
    if (G.E.phase === "over") { later(showResult, 620); return; }
    later(pump, 260 + Math.random() * 200);
  }
  function resolveAct(act) {
    var E = G.E, i, ok = false;
    if (!E) return;
    if (act === "peng") ok = E.claim(0, "peng");
    else if (act === "gang") ok = E.claim(0, "gang");
    else if (act === "pass") ok = (E.phase === "rob") ? E.passRob(0) : E.claim(0, "pass");
    else if (act === "hu") ok = E.rob(0);
    else if (act.indexOf("angang:") === 0) ok = E.turnGang(0, act.slice(7), "an");
    else if (act.indexOf("bugang:") === 0) ok = E.turnGang(0, act.slice(7), "bu");
    if (ok) sfx("ding");
    afterHuman();
  }

  /** 轮到人类：给按钮 / 等待点牌 */
  function showHumanUI() {
    var E = G.E, pend = E.pending, items;
    if (E.phase === "turn" && E.cur === 0) {
      refreshHint();
      items = [];
      var k = kongOptions(E.P[0]), i;
      for (i = 0; i < k.anGangs.length; i++) items.push({ label: "暗杠 " + k.anGangs[i], act: "angang:" + k.anGangs[i], cls: "" });
      for (i = 0; i < k.addGangs.length; i++) items.push({ label: "补杠 " + k.addGangs[i], act: "bugang:" + k.addGangs[i], cls: "" });
      G.anim.drawAt = Date.now();
      G.uiLock = Date.now() + 300;
      if (items.length) openWin(items, 0, null);
      else { closeWin(); }
      if (G.idleTimer) root.clearTimeout(G.idleTimer);
      G.idleTimer = later(function () {
        G.idleTimer = 0;
        if (!G.on || G.finished || G.E.phase !== "turn" || G.E.cur !== 0) return;
        var p = G.E.P[0];
        /* 放水局：挂机自动出牌也走「温和版」策略（拆搭 / 打孤张），不偷偷替玩家赢牌 */
        var t = (G.style === "gentle")
          ? gentleDiscard(p.hand, p.melds, G.E.seenBy(0), G.E.honors)
          : aiDiscard(p.hand, p.melds, G.E.seenBy(0), G.E.honors);
        var idx = p.hand.indexOf(t); if (idx < 0) idx = p.hand.length - 1;
        G.E.discard(0, idx);
        voiceSelfDiscard(G.E.P[0].discards[G.E.P[0].discards.length - 1]);
        if (G.E.log.length) G.E.push(0, "discard", "（超时自动出牌）");
        afterHuman();
      }, HUMAN_IDLE_MS);
      return;
    }
    if (E.phase === "claim" && pend && pend.seat === 0) {
      items = [];
      if (pend.actions.indexOf("gang") >= 0) items.push({ label: "杠 " + pend.tile, act: "gang" });
      if (pend.actions.indexOf("peng") >= 0) items.push({ label: "碰 " + pend.tile, act: "peng" });
      items.push({ label: "过", act: "pass", cls: "pass" });
      openWin(items, RESPONSE_MS, function () { G.E.claim(0, "pass"); afterHuman(); });
      return;
    }
    if (E.phase === "rob" && pend && pend.seats.indexOf(0) >= 0) {
      items = [{ label: "抢杠胡 " + pend.tile, act: "hu", cls: "hu" }, { label: "过", act: "pass", cls: "pass" }];
      openWin(items, RESPONSE_MS, function () { G.E.passRob(0); afterHuman(); });
      return;
    }
    closeWin();
  }

  /** 主循环：AI 走一步 → 等待人类 → 下一拍 */
  function pump() {
    if (!G.on || G.finished || G.result) return;
    var E = G.E;
    if (E.phase === "over") { later(showResult, 400); return; }
    var r = E.aiStep();
    playNewSfx(); updateHud();
    if (r === "wait") { showHumanUI(); return; }
    if (E.phase === "over") { later(showResult, 620); return; }
    if (r === "none") { later(pump, 300); return; }
    later(pump, AI_MIN_MS + Math.random() * (AI_MAX_MS - AI_MIN_MS));
  }

  /* ── 结算面板 ── */
  function showResult() {
    if (G.resultShown || !G.on) return;
    G.resultShown = true;
    var E = G.E, res = E.result;
    if (!res) return;
    G.result = res;
    closeWin();
    var box = byId("mjmRes"); if (!box) return;
    G.view = buildResultView(E, res);                 // 四家亮牌 + 赔付明细（纯函数，单测共用）
    box.innerHTML = resultHtml(G.view, res);
    box.style.display = "flex";
    var go = byId("mjmGo"); if (go) go.onclick = function () { finishGame(); };
    later(function () {
      if (!G.finished) { if (!G.result.log.length) G.result.log.push("（自动继续）"); finishGame(); }
    }, AUTO_FINISH_MS);
  }
  function finishGame() {
    if (G.finished) return;
    G.finished = true;
    clearTimers();
    var res = G.result || {
      win: false, selfDraw: false, fan: 0, fanName: "流局", score: 0, winner: "", log: []
    };
    /* 赌注系统：onFinish(result) 的字段一定要齐（含 stake / payPerHouse / totalWin / netCash） */
    res.stake = stakeOf(res.stake);
    res.payPerHouse = +res.payPerHouse || 0;
    res.totalWin = +res.totalWin || 0;
    res.netCash = +res.netCash || 0;
    res.style = styleOf(res.style || G.style);
    res.invite = G.invite || null;
    if (!G.view) { try { G.view = buildResultView(G.E, res); } catch (e) {} }
    if (G.view && G.view.report) res.report = G.view.report;
    if (G.opts && typeof G.opts.onFinish === "function") {
      try { G.opts.onFinish(res); } catch (e) { if (root.console) root.console.error(e); }
    }
  }

  /* ── 装配 / 销毁 ── */
  /** 单帧：画桌面 + 倒计时 + 结算兜底 */
  function frame() {
    if (!G.on) return;
    G.frames = (G.frames || 0) + 1; try { renderTable(); tickWin(); G.lastErr = ""; }
    catch (e) { G.lastErr = "render:" + (e && e.message || e); if (root.console) root.console.error("[mahjong render]", e); }
    // 兜底：无论从哪条路径结算（自摸 / 抢杠 / 调试造胡），结算面板一定会出现
    try {
      if (G.E && G.E.phase === "over" && !G.resultShown) {
        if (!G.overAt) G.overAt = Date.now();
        if (Date.now() - G.overAt > 700) showResult();
      } else if (G.E && G.E.phase !== "over") G.overAt = 0;
    } catch (e) {}
  }
  function loop() {
    if (!G.on) return;
    frame();
    G.raf = root.requestAnimationFrame(loop);
  }

  function start(hostEl, opts) {
    if (!hostEl || typeof hostEl !== "object") return false;
    if (G.on) dispose();                       // 重入 → 先收尾上一局
    opts = opts || {};
    /* 赌注 / 打法要在建 DOM 之前定下来（规则面板 + 智脑锁都要读） */
    G.style = styleOf(opts.style);
    G.stake = stakeOf(opts.stake);
    G.invite = opts.invite || null;
    G.stateRef = opts.state || null;
    G.hintLocked = !styleDef(G.style).hint;
    injectStyle();
    var cv = buildDom(hostEl);
    if (!cv || typeof cv.getContext !== "function") return false;

    G.on = true; G.busy = true; G.finished = false; G.resultShown = false; G.result = null;
    G.opts = opts; G.host = hostEl; G.hover = -1; G.handRects = []; G.wallSlots = null; G.wallSpan = null; G.noise = null;
    G.logRendered = 0; G.sfxN = 0; G.uiLock = 0; G.anim.drawAt = 0; G.stat = null; G.overAt = 0; G.lastErr = ""; G.sheet = null; G.demo = null;
    G.hint = null; G.hintIdx = -1; G.hintKey = ""; G.hintCalcN = 0; G.hintLastMs = 0; G.hintWorstMs = 0; G.view = null;
    /* 赌注 / 打法：放水 → 智脑提示本局关闭且不可开启；stake 默认 10（不传即旧行为） */
    G.style = styleOf(opts.style);
    G.invite = opts.invite || null;
    G.stateRef = opts.state || null;
    G.hintLocked = !styleDef(G.style).hint;
    G.hintOn = G.hintLocked ? false : loadHintPref();
    G.result = null;
    G.voiceOn = loadVoicePref(); G.voiceN = 0; G.ting = [false, false, false, false];
    VOICE_BASE = null; VOICE_STAT.plays = 0; VOICE_STAT.misses = 0; VOICE_STAT.last = ""; VOICE_STAT.lastUrl = "";
    VOICE_STAT.list = []; VOICE_STAT.uniq = Object.create(null);
    VOICE_STAT.queued = 0; VOICE_STAT.started = 0; VOICE_STAT.dropped = 0; VOICE_STAT.maxQueue = 0;
    voiceStopAll();                                  // 上一局没念完的喊话不许漏进新一局
    if (hostEl.classList) hostEl.classList.add("on");     // 保留宿主的 on class（index.html 靠它显示）
    try { G.cv.getContext("2d").setTransform(G.dpr, 0, 0, G.dpr, 0, 0); } catch (e) {}

    G.E = new Engine(opts.stake || STAKE_DEFAULT, { honors: opts.honors, style: G.style });
    G.E.opts = opts;                          // 供结算面板预演（state / invite / style）
    G.E.P[0].isHuman = true;
    var names = opts.names || [];
    for (var i = 0; i < 4; i++) if (names[i]) G.E.P[i].name = names[i];

    cv.addEventListener("mousemove", onMove);
    cv.addEventListener("mouseleave", function () { if (G.hover !== -1) { G.hover = -1; cv.className = "mjm-cv"; } });
    cv.addEventListener("click", onClick);

    var h = byId("mjmLogH");
    if (h) h.onclick = function () {
      var box = h.parentNode, min = box.className.indexOf("min") >= 0;
      box.className = "mjm-log" + (min ? "" : " min");
      var t = byId("mjmLogT"); if (t) t.textContent = min ? "▾" : "▸";
    };

    var tg = byId("mjmHintToggle");
    if (tg) tg.onclick = function () { hintToggle(); };
    var vtg = byId("mjmVoiceToggle");
    if (vtg) vtg.onclick = function () { voiceToggle(); };
    renderVoiceToggle();
    renderBrain();
    voicePreload();

    G.E.deal();
    playNewSfx(); updateHud();
    renderTable();
    refreshHint();
    if (typeof root.requestAnimationFrame === "function") G.raf = root.requestAnimationFrame(loop);
    // 兜底帧：某些宿主（HTA / 后台标签 / 无 rAF）不触发 rAF，靠定时器保证倒计时与结算不被卡住
    root.clearInterval(G.tickTimer);
    G.tickTimer = root.setInterval(frame, 200);
    later(pump, 520);
    return true;
  }

  function dispose() {
    G.on = false; G.busy = false;
    clearTimers();
    if (G.tickTimer) { root.clearInterval(G.tickTimer); G.tickTimer = 0; }
    if (G.raf && root.cancelAnimationFrame) root.cancelAnimationFrame(G.raf);
    G.raf = 0;
    closeWin();
    if (G.host) { try { G.host.innerHTML = ""; } catch (e) {} }   // 不动宿主的 on class
    /* 收掉正在播的喊话 + 清空播报队列。（VOICE_TIMER 已被队列的 gap/watch 两个定时器取代） */
    voiceStopAll();
    G.host = null; G.cv = null; G.ctx = null; G.handRects = []; G.E = null;
    G.win = null; G.resultShown = false; G.hint = null; G.hintIdx = -1; G.hintKey = ""; G.view = null;
    return true;
  }

  /* ═══════════════ 5b. 自由局开局面板 / NPC 邀约条（系统层 UI，独立于牌桌） ═══════════════ */

  /**
   * 自由局开局面板：① 选注码（财富不足的档位置灰 + 说明原因）② 选打法（认真 / 放水）③ 开局。
   * opts: { cash, stake, style, record:{wins,losses,net,rep}, onStart({stake,style}), onCancel() }
   */
  function openLobby(hostEl, opts) {
    if (!hostEl || typeof hostEl.appendChild !== "function") return false;
    opts = opts || {};
    injectStyle();
    var cash = +opts.cash || 0;
    var tiers = stakeTierList(cash);
    var style = styleOf(opts.style);
    var rec = opts.record || {};
    var wrap = mkEl("div", "mjm-card mjm-lobby");
    wrap.id = "mjmLobbyCard";
    var i, t, picked = null;
    for (i = 0; i < tiers.length; i++) if (tiers[i].ok && picked === null) picked = tiers[i];
    var h = '<div class="k">FREE PLAY · 三缺一</div><div class="t">找人打两圈</div>' +
      '<div class="n">赣麻 · ' + deckSize(INCLUDE_HONORS) + ' 张 · 只能自摸 · 无人成牌则流局</div>';
    h += '<div class="ml-sec">① 选注码（每家应付 = 张数 × 注码）</div><div class="ml-tiers" id="mjmLobbyTiers">';
    for (i = 0; i < tiers.length; i++) {
      t = tiers[i];
      h += '<button class="ml-tier' + (t.ok ? "" : " off") + '" id="mjmStake' + t.stake + '" data-stake="' + t.stake + '"' +
        (t.ok ? "" : ' disabled="disabled"') + '><b>¥' + t.stake + '</b>' +
        '<s>小胡 每家 ¥' + t.per + ' · 共收 ¥' + t.total + '</s>' +
        '<s>' + escHtml(t.ok ? "可开局" : t.reason) + '</s></button>';
    }
    h += '</div><div class="ml-sec">② 选打法</div><div class="ml-styles" id="mjmLobbyStyles">' +
      '<button class="ml-style" id="mjmStyleSerious" data-style="serious"><b>' + STYLE_DEF.serious.label + '</b><s>' +
      escHtml(STYLE_DEF.serious.desc) + '</s></button>' +
      '<button class="ml-style" id="mjmStyleGentle" data-style="gentle"><b>' + STYLE_DEF.gentle.label + '</b><s>' +
      escHtml(STYLE_DEF.gentle.desc) + '</s></button></div>';
    h += '<div class="ml-rec" id="mjmLobbyRec">战绩：<b>' + (+rec.wins || 0) + ' 胜 ' + (+rec.losses || 0) + ' 负</b>' +
      ' · 净收支 <b>' + ((+rec.net || 0) > 0 ? "+" : "") + '¥' + (+rec.net || 0) + '</b>' +
      ' · 牌友口碑 <b>' + (isNum(rec.rep) ? rec.rep : REP_INIT) + '</b> · 当前财富 <b>¥' + cash + '</b></div>';
    h += '<div class="ml-btns"><button id="mjmLobbyGo">开 局</button>' +
      '<button class="ghost" id="mjmLobbyCancel">再 想 想</button></div>';
    wrap.innerHTML = h;
    hostEl.innerHTML = "";
    hostEl.appendChild(wrap);

    var state = { stake: picked ? picked.stake : 0, style: style, ok: !!picked, cash: cash, tiers: tiers };
    function sync() {
      var j, el, tt, a, b, go;
      for (j = 0; j < tiers.length; j++) {
        tt = tiers[j];
        el = byId("mjmStake" + tt.stake);
        if (el) el.className = "ml-tier" + (tt.ok ? "" : " off") + (tt.stake === state.stake ? " cur" : "");
      }
      a = byId("mjmStyleSerious"); b = byId("mjmStyleGentle");
      if (a) a.className = "ml-style" + (state.style === "serious" ? " cur" : "");
      if (b) b.className = "ml-style" + (state.style === "gentle" ? " cur" : "");
      go = byId("mjmLobbyGo");
      if (go) {
        go.disabled = !state.ok;
        go.innerHTML = state.ok ? "开 局" : ("财富不足（至少 ¥" + STAKE_TIERS[0] + "）");
        go.className = state.ok ? "" : "off";
      }
      G.lobby = state;
    }
    function pickStake(v) {
      var j, tt = null;
      for (j = 0; j < tiers.length; j++) if (tiers[j].stake === v) tt = tiers[j];
      if (!tt) return false;
      if (!tt.ok) { sfx("bad"); return false; }             // 置灰档位：点不动
      state.stake = v; sync(); sfx("ding");
      return true;
    }
    for (i = 0; i < tiers.length; i++) (function (tt) {
      var el = byId("mjmStake" + tt.stake);
      if (el) el.onclick = function () { return pickStake(tt.stake); };
    })(tiers[i]);
    if (byId("mjmStyleSerious")) byId("mjmStyleSerious").onclick = function () { state.style = "serious"; sync(); };
    if (byId("mjmStyleGentle")) byId("mjmStyleGentle").onclick = function () { state.style = "gentle"; sync(); };
    if (byId("mjmLobbyGo")) byId("mjmLobbyGo").onclick = function () {
      if (!state.ok) { sfx("bad"); return false; }
      if (typeof opts.onStart === "function") opts.onStart({ stake: state.stake, style: state.style });
      return true;
    };
    if (byId("mjmLobbyCancel")) byId("mjmLobbyCancel").onclick = function () {
      if (typeof opts.onCancel === "function") opts.onCancel();
      return true;
    };
    G.lobby = state;
    sync();
    return true;
  }
  /** 邀约条（手机消息风格）：接受 → 直接开对应赌注的牌局；改天 → 记冷却 */
  function showInvite(hostEl, inv, opts) {
    if (!hostEl || typeof hostEl.appendChild !== "function" || !inv) return false;
    opts = opts || {};
    injectStyle();
    var st = stakeOf(inv.stake), ok = inv.ok !== false;
    var gainTxt = inv.gainText || inviteGainText(inv);
    var card = mkEl("div", "mjm-inv");
    card.id = "mjmInviteCard";
    card.innerHTML = '<div class="iv-av">' + escHtml(String(inv.name || "?").charAt(0)) + '</div>' +
      '<div class="iv-body"><div class="iv-name">' + escHtml(inv.name || "") + '<span>刚刚</span></div>' +
      '<div class="iv-msg" id="mjmInviteMsg">' + escHtml(inv.msg || "来打两圈？") + '</div>' +
      '<div class="iv-meta" id="mjmInviteMeta">注码 ¥' + st + ' · ' + escHtml(inv.where || "") +
      (ok ? "" : ' · <b style="color:#ff7d9c">' + escHtml(inv.reason || "财富不足") + '</b>') + '</div>' +
      '<div class="iv-gain" id="mjmInviteGain">本局可能获得：' + escHtml(gainTxt) + '</div>' +
      '<div class="iv-btns"><button id="mjmInviteYes"' + (ok ? "" : ' disabled="disabled"') + '>接 受</button>' +
      '<button class="no" id="mjmInviteNo">改 天</button></div></div>';
    hostEl.innerHTML = "";
    hostEl.appendChild(card);
    G.inv = { open: true, id: inv.id, name: inv.name, stake: st, ok: ok, msg: inv.msg || "", gainText: gainTxt,
      intel: inv.intel || null, accepted: false, declined: false };
    var yes = byId("mjmInviteYes"), no = byId("mjmInviteNo");
    if (yes) yes.onclick = function () {
      if (!ok) { sfx("bad"); return false; }
      G.inv = { open: false, id: inv.id, name: inv.name, stake: st, ok: true, accepted: true, declined: false, gainText: gainTxt, intel: inv.intel || null };
      if (typeof opts.onAccept === "function") opts.onAccept(inv);
      return true;
    };
    if (no) no.onclick = function () {
      G.inv = { open: false, id: inv.id, name: inv.name, stake: st, ok: true, accepted: false, declined: true, gainText: gainTxt, intel: inv.intel || null };
      if (typeof opts.onDecline === "function") opts.onDecline(inv);
      return true;
    };
    return true;
  }
  function hideInvite(hostEl) {
    if (hostEl && typeof hostEl === "object") { try { hostEl.innerHTML = ""; } catch (e) {} }
    G.inv = null;
    return true;
  }

  /* ═══════════════ 6. 调试 API（自动化测试用） ═══════════════ */

  function dbgHand() { return G.E ? G.E.P[0].hand.slice() : []; }
  function dbgWall() { var n = G.E ? G.E.wall.length : 0; return { count: n, length: n, tiles: G.E ? G.E.wall.slice() : [] }; }
  function dbgSeats() {
    if (!G.E) return [];
    return G.E.P.map(function (p) {
      return {
        idx: p.idx, name: p.name, isHuman: p.isHuman, handCount: p.hand.length,
        hand: p.isHuman ? p.hand.slice() : undefined,
        drawn: p.drawn,
        melds: p.melds.map(function (m) { return { type: m.type, tiles: m.tiles.slice(), an: !!m.an, from: m.from, kind: m.kind }; }),
        discards: p.discards.slice(),
        tenpai: waitsFor(p.hand.slice(0, p.hand.length - (p.drawn !== null ? 1 : 0)), p.melds, G.E.honors)
      };
    });
  }
  function dbgState() {
    var E = G.E; if (!E) return null;
    return {
      on: G.on, busy: G.busy, finished: G.finished, phase: E.phase, cur: E.cur, turnNo: E.turnNo,
      wall: E.wall.length, hand: E.P[0].hand.slice(), handCount: E.P[0].hand.length,
      drawn: E.P[0].drawn, melds: E.P[0].melds.length, honors: !!E.honors,
      handSorted: handIsSorted(E.P[0]), meldsSorted: meldsAreSorted(E.P[0]),
      discards: [0, 1, 2, 3].map(function (i) { return E.P[i].discards.length; }),
      pending: E.pending ? { type: E.pending.type, seat: E.pending.seat, tile: E.pending.tile, actions: E.pending.actions || null } : null,
      window: G.win ? G.win.items.map(function (x) { return x.act; }) : null,
      windowLeft: G.win && G.win.deadline ? Math.max(0, G.win.deadline - Date.now()) : -1,
      frames: G.frames || 0, logLen: E.log.length, lastErr: G.lastErr || "", result: E.result ? { win: E.result.win, fanName: E.result.fanName, score: E.result.score, winner: E.result.winner } : null,
      render: G.stat, tenpai: waitsFor(E.P[0].hand.slice(0, E.P[0].hand.length - (E.P[0].drawn !== null ? 1 : 0)), E.P[0].melds, E.honors)
    };
  }
  /** 手牌屏幕坐标（CSS 像素，供 CDP 真实鼠标点击） */
  function dbgHandRects() {
    if (!G.cv || !G.handRects.length) return [];
    var r = G.cv.getBoundingClientRect(), sx = r.width / W, sy = r.height / H;
    return G.handRects.map(function (t, i) {
      return {
        idx: i, tile: t.tile, drawn: !!t.drawn, x: t.x, y: t.y, logW: t.w, logH: t.h,
        gapBefore: i > 0 ? +(t.x - (G.handRects[i - 1].x + G.handRects[i - 1].w)).toFixed(2) : 0,
        cx: r.left + (t.x + t.w / 2) * sx, cy: r.top + (t.y + t.h / 2 - (t.drawn ? LAYOUT.hand.drawnLift : 0)) * sy,
        w: t.w * sx, h: t.h * sy
      };
    });
  }
  function dbgLog() { return G.E ? G.E.log.map(function (e) { return e.text; }) : []; }
  function dbgAct(action, tileId) {
    var E = G.E;
    if (!E || G.finished) return false;
    var act = String(action || "");
    if (act === "draw") {
      if (E.phase !== "turn" || E.cur !== 0 || E.P[0].hand.length % 3 !== 1) return false;
      E.turn(0); playNewSfx(); updateHud(); return true;
    }
    if (act === "discard") {
      if (E.phase !== "turn" || E.cur !== 0 || E.P[0].hand.length % 3 !== 2) return false;
      var idx = -1;
      if (typeof tileId === "number") idx = tileId;
      else if (tileId != null) {
        var s = String(tileId);
        idx = E.P[0].hand.indexOf(s);
        if (idx < 0) { var n = parseInt(s, 10); if (!isNaN(n) && n >= 0 && n < E.P[0].hand.length) idx = n; }
      } else idx = E.P[0].hand.length - 1;
      if (idx < 0 || idx >= E.P[0].hand.length) return false;
      var ok = E.discard(0, idx);
      if (ok) { voiceSelfDiscard(E.P[0].discards[E.P[0].discards.length - 1]); afterHuman(); }
      return ok;
    }
    if (act === "peng" || act === "gang" || act === "kong" || act === "hu" || act === "pass" || act === "skip") {
      var a = act === "kong" ? "gang" : (act === "skip" ? "pass" : act);
      if (E.phase === "claim" && E.pending.seat === 0) {
        if (a === "hu") return false;
        if (a !== "pass" && E.pending.actions.indexOf(a) < 0) return false;
        var ok2 = E.claim(0, a);
        if (ok2) afterHuman();
        return ok2;
      }
      if (E.phase === "rob" && E.pending.seats.indexOf(0) >= 0) {
        var ok3 = (a === "hu") ? E.rob(0) : E.passRob(0);
        if (ok3) afterHuman();
        return ok3;
      }
      if (E.phase === "turn" && E.cur === 0 && (a === "gang" || a === "kong")) {
        var k = kongOptions(E.P[0]);
        if (k.anGangs.length) { var ok4 = E.turnGang(0, k.anGangs[0], "an"); if (ok4) afterHuman(); return ok4; }
        if (k.addGangs.length) { var ok5 = E.turnGang(0, k.addGangs[0], "bu"); if (ok5) afterHuman(); return ok5; }
        return false;
      }
      if (a === "pass" && E.phase === "turn" && E.cur === 0) return true;
      return false;
    }
    if (act === "finish" || act === "settle") { if (E.result) { showResult(); return true; } return false; }
    return false;
  }
  /**
   * 调试：把全部牌面（含字牌）铺成一张大图，便于截图人眼验收牌面清晰度。
   * on=false 关闭回到正常牌桌。
   */
  function dbgFaceSheet(on, honors) {
    G.sheet = on === false ? null : { honors: honors === false ? false : true };
    try { renderTable(); } catch (e) {}
    return !!G.sheet;
  }
  /** 调试：每家塞 4 组示范副露（暗杠/明杠/碰/补杠）便于人眼检查副露排版；只影响渲染 */
  function dbgDemoMelds(on) {
    G.demo = on === false ? null : true;
    try { renderTable(); } catch (e) {}
    return !!G.demo;
  }
  /** 调试：弹出一次「碰/杠 + 过」响应窗口（3 秒倒计时自动过），仅用于 UI 自动化验证 */  function dbgWindow(kind) {
    var E = G.E;
    if (!E || G.finished) return false;
    var tile = E.P[0].hand.length ? E.P[0].hand[0] : "1万";
    var items = kind === "gang"
      ? [{ label: "杠 " + tile, act: "gang" }, { label: "过", act: "pass", cls: "pass" }]
      : [{ label: "碰 " + tile, act: "peng" }, { label: "过", act: "pass", cls: "pass" }];
    openWin(items, RESPONSE_MS, function () { closeWin(); });
    return true;
  }
  /**
   * 调试：用「指定结果」直接弹出结算亮牌板（不发牌、不改手牌）。
   * 用途：浏览器探针要确定性地验证结算面板上任意一种打法/结果组合（含「本局影响」行）。
   */
  function dbgShowResult(res) {
    var E = G.E;
    if (!E) return false;
    var r = res || {};
    r.win = r.win === true;
    r.draw = !!r.draw;
    r.stake = stakeOf(r.stake === undefined ? G.stake : r.stake);
    r.style = styleOf(r.style || G.style);
    r.tier = r.tier || (r.draw ? "" : "small");
    r.tierName = r.tierName || (r.draw ? "流局" : "小胡");
    r.payPerHouse = +r.payPerHouse || 0;
    r.totalWin = +r.totalWin || 0;
    r.netCash = +r.netCash || 0;
    r.from = r.from === undefined ? -1 : r.from;
    r.payerOnly = !!r.payerOnly;
    r.log = r.log || [];
    E.result = r;
    E.phase = "over";
    G.finished = false; G.resultShown = false; G.result = r; G.view = null; G.overAt = 0;
    showResult();
    return true;
  }
  /** 调试：点结算板的「继续」（收尾 → 触发 onFinish）；探针需要确定性地跑完一局 */
  function dbgContinue() {
    if (!G.E || !G.view) return false;
    finishGame();
    return true;
  }
  /** 调试：强行替换自己手牌（测提示 / 亮牌；hand 传 null 只改副露） */
  function dbgSetHand(hand, melds, drawn) {
    var E = G.E; if (!E) return false;
    var p = E.P[0];
    p.hand = (hand || []).slice();
    if (melds !== undefined && melds !== null) p.melds = melds.slice();
    if (hand && hand.length) p.drawn = drawn === undefined ? null : drawn;
    normalizeHand(p);
    /* 调试摆牌 = 回到可玩局面：清掉上一局的结算态（含 phase="over"），否则提示 / 出牌都会被「已结算」挡住 */
    E.result = null;
    E.phase = "turn";
    E.cur = 0;
    E.pending = { type: "turn", seat: 0, anGangs: [], addGangs: [] };
    if (G.result || G.resultShown) { G.result = null; G.resultShown = false; G.overAt = 0; }
    var rbox = byId("mjmRes");
    if (rbox) rbox.style.display = "none";
    G.hintKey = "";
    try { renderTable(); } catch (e) {}
    refreshHint();
    return true;
  }
  function dbgHint() {
    var h = updateHint();
    renderBrain(); updateHintMark();
    return h ? { discard: h.discard, discardIdx: h.discardIdx, shanten: h.shanten, tenpaiNow: h.tenpaiNow, tenpaiAfter: h.tenpaiAfter, waits: h.waits.slice(), waitsLeft: h.waitsLeft, ukeire: h.ukeire, improve: h.improve.slice(), improveKinds: h.improveKinds } : null;
  }
  function dbgBrainText() {
    var box = byId("mjmBrainB"), tg = byId("mjmHintToggle"), m = byId("mjmHintMark");
    return {
      on: G.hintOn, toggle: hintLabel(), locked: !!G.hintLocked,
      panel: box ? box.innerHTML : "", text: box ? String(box.textContent || "").replace(/\s+/g, " ").trim() : "",
      brain: !!byId("mjmBrain"), markClass: m ? m.className : "", markDisplay: m ? (m.style.display || "") : "",
      markLeft: m ? (m.style.left || "") : "", markTop: m ? (m.style.top || "") : "",
      markWidth: m ? (m.style.width || "") : "", markHeight: m ? (m.style.height || "") : "",
      toggleDom: tg ? String(tg.innerHTML || "") : "", hintIdx: G.hintIdx
    };
  }
  function dbgHintStats() {
    return { calcCount: G.hintCalcN, lastMs: G.hintLastMs, worstMs: G.hintWorstMs, cache: hintCacheStats(), on: G.hintOn };
  }
  function dbgResultView() {
    if (!G.E) return null;
    var res = G.result || G.E.result;
    if (!res) return null;
    if (!G.view) G.view = buildResultView(G.E, res);
    return G.view;
  }
  /** 调试：把某家做成「小胡」自摸直接结算（测结算分支） */
  function dbgForceWin(seat) {
    var E = G.E; if (!E || E.phase === "over") return false;
    seat = seat || 0;
    var p = E.P[seat];
    var hand = ["1万", "2万", "3万", "4万", "5万", "6万", "7万", "8万", "9万", "1条", "2条", "3条", "9条", "9条"];
    var oldCount = p.hand.length;
    p.hand = hand.slice();
    p.melds = [];
    p.drawn = hand[hand.length - 1];
    normalizeHand(p);
    E.cur = seat; E.phase = "turn";
    E.pending = { type: "turn", seat: seat, anGangs: [], addGangs: [] };
    var ev = evaluate(p.hand, p.melds);
    if (!ev) { p.drawn = null; return false; }
    E.push(seat, "win", p.name + " 自摸 · " + ev.name + "（调试）");
    E.settle(seat, { selfDraw: true }, ev);
    voiceHook(); playNewSfx(); updateHud();
    return true;
  }

  /* ═══════════════ 7. 导出 ═══════════════ */

  root.Mahjong = {
    start: function (hostEl, opts) { try { return start(hostEl, opts) === true; } catch (e) { if (root.console) root.console.error("[mahjong start]", e); return false; } },
    isBusy: function () { return !!G.busy && !G.finished; },
    dispose: dispose,
    /* ── 系统层：自由局开局面板 / 邀约条 / 纯规则 ── */
    openLobby: function (hostEl, opts) { try { return openLobby(hostEl, opts) === true; } catch (e) { if (root.console) root.console.error("[mahjong lobby]", e); return false; } },
    showInvite: function (hostEl, inv, opts) { try { return showInvite(hostEl, inv, opts) === true; } catch (e) { if (root.console) root.console.error("[mahjong invite]", e); return false; } },
    hideInvite: hideInvite,
    rules: {
      STAKE_TIERS: STAKE_TIERS, STYLE_DEF: STYLE_DEF, INVITE_DEF: INVITE_DEF, INVITES: INVITE_DEF,
      REP_INIT: REP_INIT, REP_MIN: REP_MIN, REP_MAX: REP_MAX, INVITE_COOLDOWN_MS: INVITE_COOLDOWN_MS,
      INTEL_BY_ID: INTEL_BY_ID, SEAT_IDS: SEAT_IDS,
      styleOf: styleOf, styleName: styleName, stakeOf: stakeOf,
      stakeTierList: stakeTierList, inviteList: inviteList, pickInvite: pickInvite, inviteDef: inviteDef,
      inviteGainText: inviteGainText, inviteCtx: inviteCtx, bondMatchOf: bondMatchOf,
      eventsOf: eventsOf, repDeltaOf: repDeltaOf, bondDeltaOf: bondDeltaOf,
      intelOfSeat: intelOfSeat, intelById: intelById, intelUnlocked: intelUnlocked, achvOf: achvOf,
      inviteIdByIntel: inviteIdByIntel,
      conseqOf: conseqOf, consequenceFlags: consequenceFlags, consequenceRoleOf: consequenceRoleOf,
      impactInfo: impactInfo, impactText: impactText, STYLE_TAG: STYLE_TAG,
      applyOutcome: applyOutcome, previewOutcome: previewOutcome,
      gentleCalc: gentleCalc, gentleDiscard: gentleDiscard
    },
    debug: {
      hand: dbgHand, wall: dbgWall, seats: dbgSeats, act: dbgAct,
      state: dbgState, log: dbgLog, handRects: dbgHandRects,
      renderStats: function () { return G.stat || null; },
      faceSheet: dbgFaceSheet,
      faceSheetRows: function () { return faceSheetRows().map(function (rr) { return { label: rr.label, suit: rr.suit, tiles: rr.tiles.slice() }; }); },
      faceTiles: function () { return (G.sheetTiles || []).map(function (s) { return { tile: s.tile, x: s.x, y: s.y, w: s.w, h: s.h }; }); },
      demoMelds: dbgDemoMelds,
      /** 副露尺寸取证（本帧真实画出去的每一张）：同组内 (w,h) 只许一种、rot ∈ {0,90}。
          用户 2025 明确要求「碰了的牌高度大小要统一，横置那张不许更小」→ 这条是可断言的。 */
      meldRects: function () { return (G.stat && G.stat.meldRects) ? G.stat.meldRects.slice() : []; },
      /** 本帧四面牌墙的实际跨度（lo / hi / mid / want）——「缺口留在正中」取证 */
      wallSpan: function () { return G.wallSpan || null; },
      /** 同心方环取证（①四段成环 ③牌河在内 / 手牌在外的同心顺序）*/
      ring: ringInfo,
      /** 牌墙满墙 68 块 与 牌河 / 手牌 / 副露 / 中央盘 的零相交取证（②）*/
      wallClear: wallClear,
      /** 保留框清单（decorCheck / wallClear / ringInfo.order 共用同一份口径）*/
      reserved: decorReserved,
      /** 牌墙取证：**一墩两枚**、同一侧牌背尺寸是否一致 + 当前各边墩数（满墙 34 墩 = 68 枚）*/
      wallInfo: function () {
        var slots = wallSlots(), sizes = {}, i, k, t, key;
        var out = { total: 0, stacks: slots.length, perStack: 2, sizes: [], counts: null,
                    tileDepth: LAYOUT.wall.tileDepth, stackDepth: LAYOUT.wall.stackDepth,
                    tiles: (G.stat && G.stat.wallTiles) || 0,
                    drawnStacks: (G.stat && G.stat.wallDrawnStacks) || 0 };
        for (i = 0; i < slots.length; i++) {
          for (k = 0; k < slots[i].tiles.length; k++) {
            t = slots[i].tiles[k]; key = t.w + "x" + t.h;
            sizes[key] = (sizes[key] || 0) + 1; out.total++;
          }
        }
        for (k in sizes) if (sizes.hasOwnProperty(k)) out.sizes.push({ size: k, n: sizes[k] });
        if (G.E && G.E.wall) out.counts = wallCounts(Math.ceil(G.E.wall.length / 4));
        return out;
      },
      layout: function () { return JSON.parse(JSON.stringify(LAYOUT)); },
      dpr: function () { return G.dpr; },
      /** 本批贴图的加载与使用状态（无头 / 浏览器验收都读它）*/
      art: function () {
        var out = [], i, im, nw;
        for (i = 0; i < MJ_ICON.ids.length; i++) {
          im = MJ_ICON.map[MJ_ICON.ids[i]];
          nw = im ? (im.naturalWidth || 0) : 0;
          out.push({ id: MJ_ICON.ids[i], has: !!im, ready: !!(nw > 0 && im.complete !== false),
                     src: (im && typeof im.src === "string") ? im.src : "", naturalWidth: nw });
        }
        var bimg = MJ_BG.img, bnw = bimg ? (bimg.naturalWidth || 0) : 0;
        return { dir: MJ_ICON.dir, ids: MJ_ICON.ids.slice(), icons: out,
                 ready: (function () { var n = 0; for (var k = 0; k < out.length; k++) if (out[k].ready) n++; return n; })(),
                 loaded: MJ_ICON.loaded, failed: MJ_ICON.failed,
                 bg: { dir: MJ_BG.dir, name: MJ_BG.name, file: MJ_BG.dir + MJ_BG.name,
                       ready: !!(bnw > 0 && bimg.complete !== false), naturalWidth: bnw,
                       loaded: MJ_BG.loaded, failed: MJ_BG.failed },
                 roomBg: !!G.roomBg, tileBackTex: G.tileBackTex || 0, tileBackSolid: G.tileBackSolid || 0,
                 tileBackGreen: (G.stat && G.stat.backGreen) || 0,
                 tileBackIvory: (G.stat && G.stat.backIvory) || 0,
      /* tileBackTex 恒为 0：tile_back.png 是「深蓝 + 鱼鳞纹」，与用户「纯色无花纹」要求冲突，
         按指示改用纯色矢量（drawTileBack）；tileBackSolid 是本帧画出的纯色牌背张数。*/
                 decor: decorStat(),
                 fallback: ["tile_back-texture", "procedural-stripe", "procedural-felt",
                            "dice-texture>vector-dice", "chip-texture>vector-chip",
                            "ruler/ashtray-texture>（不画）", "tile_white/tile_fa>（故意不接：会伪造牌河）"] };
      },
      /** 牌桌装饰的安全区自检（纯几何，不依赖 canvas）：无头断言 / 出图脚本直接读 */
      decor: decorCheck,
      decorStat: decorStat,
      forceWin: dbgForceWin,
      showResult: dbgShowResult,
      continueGame: dbgContinue,
      window: dbgWindow,
      setHand: dbgSetHand,
      hint: dbgHint,
      hintNow: dbgHint,
      brainText: dbgBrainText,
      hintToggle: hintToggle,
      hintDiag: function () {
        var E = G.E;
        return { on: G.on, finished: G.finished, hasResult: !!G.result, hintOn: G.hintOn, should: hintShouldCalc(),
                 phase: E ? E.phase : "", cur: E ? E.cur : -1, handLen: E ? E.P[0].hand.length : -1,
                 hint: !!G.hint, hintKey: G.hintKey, hintErr: G.hintErr || "", calcN: G.hintCalcN, lastMs: G.hintLastMs };
      },
      /* 语音播报（本地素材，静态映射，可单测） */
      say: say,
      voiceFile: voiceFile,
      voiceUrl: voiceUrl,
      voiceBase: voiceBase,
      voiceToggle: voiceToggle,
      voiceRelBase: voiceRelBase,
      voiceStats: function () {
        return { on: G.voiceOn, plays: VOICE_STAT.plays, misses: VOICE_STAT.misses, errors: VOICE_STAT.errors,
                 last: VOICE_STAT.last, lastUrl: VOICE_STAT.lastUrl, lastSeat: VOICE_STAT.lastSeat, lastAt: VOICE_STAT.lastAt,
                 list: VOICE_STAT.list.slice(), uniq: Object.keys(VOICE_STAT.uniq),
                 cached: Object.keys(VOICE_CACHE).length, total: Object.keys(VOICE_NAMES).length,
                 queued: VOICE_STAT.queued, started: VOICE_STAT.started, dropped: VOICE_STAT.dropped,
                 maxQueue: VOICE_STAT.maxQueue, gapMs: VOICE_GAP, qMax: VOICE_Q_MAX,
                 playing: VOICE_PLAYING ? VOICE_PLAYING.file : "", queue: VOICE_Q.map(function (x) { return x.file; }),
                 base: voiceBase(), names: Object.keys(VOICE_NAMES).slice(), ting: G.ting.slice(),                 els: { toggle: !!byId("mjmVoiceToggle"), ting: !!byId("mjmTing") } };
      },
      hintStats: dbgHintStats,
      resultView: dbgResultView,
      /* ── 赌注系统调试接口 ── */
      stakeTiers: function (cash) { return stakeTierList(cash === undefined ? 0 : cash); },
      style: function () { return { style: G.style, name: styleName(G.style), hintLocked: !!G.hintLocked, hintOn: !!G.hintOn }; },
      lobbyState: function () {
        var L = G.lobby;
        return L ? {
          open: !!byId("mjmLobbyCard"), stake: L.stake, style: L.style, ok: !!L.ok, cash: L.cash,
          tiers: L.tiers.map(function (t) { return { stake: t.stake, ok: !!t.ok, cur: t.stake === L.stake, reason: t.reason }; })
        } : null;
      },
      inviteState: function () {
        var v = G.inv;
        return v ? { open: !!v.open, id: v.id, name: v.name, stake: v.stake, ok: !!v.ok, msg: v.msg,
          gainText: v.gainText || "", intel: v.intel || null, accepted: !!v.accepted, declined: !!v.declined } : null;
      },
      invites: function (state, now, ctx) { return inviteList(state, now, ctx); },
      pick: function (state, now, ctx) { return pickInvite(state, now, ctx); },
      inviteGain: function (inv) { return inviteGainText(inv); },
      outcomes: function (ev, invite) { return conseqOf(ev, invite); },
      impact: function (ev, invite, parts) { return impactInfo(ev, invite, parts); },
      outcome: function (state, res, opts) { return applyOutcome(state, res, opts); },
      preview: function (state, res, opts) { return previewOutcome(state, res, opts); },
      gentle: function (hand, melds, seen, honors) { return gentleCalc(hand || [], melds || [], seen || {}, honors); },
      gentleDiscard: function (hand, melds, seen, honors) { return gentleDiscard(hand || [], melds || [], seen || {}, honors); },
      render: function () { try { renderTable(); } catch (e) {} return G.stat; },
      canWin: function () { var E = G.E; return !!(E && evaluate(E.P[0].hand, E.P[0].melds)); },
      isBusy: function () { return !!G.busy && !G.finished; }
    },
    test: {
      /* 牌与判定 */
      createWall: createWall, shuffle: shuffle, counts: counts, countIn: countIn, sortTiles: sortTiles,
      suitOf: suitOf, numOf: numOf, cmpTile: cmpTile, KINDS: KINDS, SUITS: SUITS, TIER: TIER,
      /* 手牌整理（渲染 / 展示，不改规则） */
      normalizeHand: normalizeHand, handIsSorted: handIsSorted, meldsAreSorted: meldsAreSorted,
      /* 字牌（INCLUDE_HONORS 开关；默认 false = 108 张） */
      HONORS: HONORS, KINDS_ALL: KINDS_ALL, INCLUDE_HONORS: INCLUDE_HONORS,
      isHonor: isHonor, tileGroup: tileGroup, kindsFor: kindsFor, deckSize: deckSize,
      isStandardWin: isStandardWin, isSevenPairs: isSevenPairs, isDragonSevenPairs: isDragonSevenPairs,
      isAllTriplets: isAllTriplets, evaluate: evaluate, scoreOf: scoreOf,
      waitsFor: waitsFor, isTenpai: isTenpai, canRobKong: canRobKong, robbable: KONG_ROBBABLE,
      /* AI */
      stdShanten: stdShanten, sevenPairsShanten: sevenPairsShanten, bestShanten: bestShanten,
      totalShanten: totalShanten, stdShantenBrute: stdShantenBrute,
      isolation: isolation, aiDiscard: aiDiscard, aiWantPeng: aiWantPeng, aiWantClaim: aiWantClaim,
      /* 智脑提示 / 剩余张数 / 进张 / 结算亮牌 */
      remainingOf: remainingOf, gainsOf: gainsOf,
      hintCalc: hintCalc, hintLines: hintLines, hintCacheClear: hintCacheClear, hintCacheStats: hintCacheStats,
      HINT_IMPROVE_MAX: HINT_IMPROVE_MAX, howText: howText, meldLabelOf: meldLabelOf,
      buildResultView: buildResultView, resultHtml: resultHtml,
      /* 引擎 */
      Engine: Engine, autoPlay: autoPlay, STAKE: STAKE_DEFAULT,
      /* 赌注系统（纯逻辑，单测用） */
      STAKE_TIERS: STAKE_TIERS, STYLE_DEF: STYLE_DEF, INVITE_DEF: INVITE_DEF, INVITES: INVITE_DEF, REP_INIT: REP_INIT,
      stakeTierList: stakeTierList, inviteList: inviteList, pickInvite: pickInvite, inviteDef: inviteDef,
      inviteGainText: inviteGainText, bondMatchOf: bondMatchOf, eventsOf: eventsOf,
      repDeltaOf: repDeltaOf, bondDeltaOf: bondDeltaOf, intelOfSeat: intelOfSeat, intelUnlocked: intelUnlocked,
      inviteIdByIntel: inviteIdByIntel, conseqOf: conseqOf, consequenceFlags: consequenceFlags,
      consequenceRoleOf: consequenceRoleOf, impactInfo: impactInfo, impactText: impactText,
      achvOf: achvOf, applyOutcome: applyOutcome, previewOutcome: previewOutcome,
      gentleCalc: gentleCalc, gentleDiscard: gentleDiscard, tierList: tierList,
      /* 语音映射 + 播报队列（纯函数/内部状态，单测用） */
      voiceFile: voiceFile, VOICE_NAMES: VOICE_NAMES, VOICE_KEY: VOICE_KEY,
      VOICE_HONOR_WORDS: VOICE_HONOR_WORDS, VOICE_CALLS: VOICE_CALLS, VOICE_CALL_SET: VOICE_CALL_SET,
      VOICE_Q_MAX: VOICE_Q_MAX, VOICE_GAP: VOICE_GAP, VOICE_PRI_TILE: VOICE_PRI_TILE, VOICE_PRI_CALL: VOICE_PRI_CALL,
      voiceQueue: function () { return VOICE_Q.map(function (x) { return x.file; }); },
      voiceCurrent: function () { return VOICE_PLAYING ? VOICE_PLAYING.file : ""; }
    }
  };
  root.Mahjong.version = "ganma-2.0";

})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
