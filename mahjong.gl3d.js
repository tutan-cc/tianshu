/* ═══════════════════════════════════════════════════════════════════════════
   mahjong.gl3d.js — 真 3D 麻将桌面（three.js）
   只负责渲染与交互，不改 mahjong.js / index.html / 现有测试。
   入口：mj3d.html
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";
  var THREE = root.THREE;
  if (!THREE) { console.error("[MJ3D] 缺少 three.js"); return; }

  /* ── 尺寸（沿用 Godot 版比例）────────────────────────────── */
  var W = 34, H = 44, T = 19;
  var HW = 52, HH = 74, HT = 24;
  var TW = 1200, TD = 1000;
  var RINX = 440, RINY = 350;
  var HAND_Z = 410, HAND_X = 476, HAND_STEP = 56;
  var WALL_LONG = 44;
var RIV = 42;          // 牌河牌边长（比手牌小）
var RIV_PITCH = 46;    // 牌河格距
var RIV_ROW_MAX = 430; // 一行最多占用的宽度
var RIV_PER_ROW = 9;   // = floor(430 / 46)
var RIV_START = -184;  // -(9-1)*46/2
  var FACE_DIR = "reference/mj-godot3d/faces/";

/* ── 节奏（对齐 Godot：AI_DRAW_DELAY 1.0 / AI_THINK 1.3 / CLAIM_DELAY 1.0）── */
var DRAW_DELAY = 200;     // AI 摸牌前的等待
var THINK_DELAY = 700;   // AI 出牌前的思考时间（够念完牌名）
var CLAIM_DELAY = 200;    // 出牌后到下一次行动的缓冲
var AI_STEP_MS = 700;     // AI 每一步的间隔

  var SEAT_NAMES = ["你", "下家", "对家", "上家"];

  var FACE_KEYS = [];
  (function () {
    var i;
    for (i = 1; i <= 9; i++) FACE_KEYS.push("wan_" + i);
    for (i = 1; i <= 9; i++) FACE_KEYS.push("tong_" + i);
    for (i = 1; i <= 9; i++) FACE_KEYS.push("tiao_" + i);
    FACE_KEYS.push("feng_dong", "feng_nan", "feng_xi", "feng_bei");
    FACE_KEYS.push("jian_zhong", "jian_fa", "jian_bai");
  })();

  /* ── 材质 ───────────────────────────────────────────────── */
  var texCache = {}, matCache = {};
  var matIvory, matGreen, matFelt, matRim, matGold;

  function makeMaterials() {
    matIvory = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.62, metalness: 0.02 });
    matGreen = new THREE.MeshStandardMaterial({ color: 0x1a8452, roughness: 0.55, metalness: 0.02 });
    matFelt  = new THREE.MeshStandardMaterial({ color: 0x14514a, roughness: 0.96, metalness: 0.0 });
    matRim   = new THREE.MeshStandardMaterial({ color: 0x2e1b10, roughness: 0.55, metalness: 0.15 });
    matGold  = new THREE.MeshStandardMaterial({ color: 0xb8912e, roughness: 0.32, metalness: 0.8 });
  }

  function faceMat(kind) {
    var key = FACE_KEYS[kind % 34];
    if (!key) return matIvory;
    if (matCache[key]) return matCache[key];
    var tex = texCache[key];
    if (!tex) {
      tex = new THREE.TextureLoader().load(FACE_DIR + key + ".png");
      if ("colorSpace" in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      else if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;   // r149 及更早
      tex.anisotropy = 4;
      texCache[key] = tex;
    }
    var m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.02 });
    matCache[key] = m;
    return m;
  }

  function tileMesh(w, h, t, kind, opts) {
    opts = opts || {};
    var geo = new THREE.BoxGeometry(w, h, t);
    var front = (kind == null || opts.backOnly) ? matIvory : faceMat(kind);
    var mats = [matIvory, matIvory, matIvory, matIvory, front, matGreen];
    var mesh = new THREE.Mesh(geo, mats);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /* 平放牌：牌面直接贴在顶面（+Y），不依赖旋转 */
  function flatTile(kind, size) {
    var s = size || HW;
    var h = Math.max(12, s * 0.28);
    var geo = new THREE.BoxGeometry(s, h, s);
    var front = faceMat(kind);
    var mats = [matIvory, matIvory, front, matIvory, matIvory, matIvory];
    var m = new THREE.Mesh(geo, mats);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData = { flat: true, size: s };
    return m;
  }

  function wallSlab() {
    var geo = new THREE.BoxGeometry(WALL_LONG, T, W);
    var mats = [matIvory, matIvory, matGreen, matIvory, matIvory, matIvory];
    var m = new THREE.Mesh(geo, mats);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  /* ── 场景 ───────────────────────────────────────────────── */
  var renderer, scene, camera, groupBoard;
  var tileGroupHand, tileGroupWall, tileGroupDisc;
  var cam = { yaw: 0, pitch: 0.34, dist: 1360, target: new THREE.Vector3(0, 55, 55) };
  var anims = [];
  var raycaster = null;

  function init(el) {
    makeMaterials();
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setClearColor(0x000000, 1);
    if ("outputColorSpace" in renderer && THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
    else if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;  // r149
    if (THREE.ACESFilmicToneMapping) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
    }
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if ("useLegacyLights" in renderer) renderer.useLegacyLights = true;
    renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
    renderer.setSize(el.clientWidth || 1240, el.clientHeight || 860);
    renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0f10);

    camera = new THREE.PerspectiveCamera(43, (el.clientWidth || 1240) / (el.clientHeight || 860), 10, 6000);
    applyCamera();

    scene.add(new THREE.HemisphereLight(0xa8c4bd, 0x2a1a12, 0.72));
    var key = new THREE.DirectionalLight(0xfff3e0, 1.25);
    key.position.set(420, 900, 620);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.6;
    key.shadow.camera.left = -900; key.shadow.camera.right = 900;
    key.shadow.camera.top = 900; key.shadow.camera.bottom = -900;
    scene.add(key);
    var fill = new THREE.DirectionalLight(0x9fd0ff, 0.22);
    fill.position.set(-600, 500, -400);
    scene.add(fill);

    groupBoard = new THREE.Group();
    scene.add(groupBoard);

    buildTable();
    tileGroupHand = new THREE.Group(); groupBoard.add(tileGroupHand);
    tileGroupWall = new THREE.Group(); groupBoard.add(tileGroupWall);
    tileGroupDisc = new THREE.Group(); groupBoard.add(tileGroupDisc);

    raycaster = new THREE.Raycaster();
    bindOrbit(renderer.domElement);
    bindPick(renderer.domElement);
    newDeal();
    root.addEventListener("resize", onResize);
    renderer.setAnimationLoop(frame);
    return renderer.domElement;
  }

  function applyCamera() {
    var p = cam.pitch, d = cam.dist;
    camera.position.set(
      Math.sin(cam.yaw) * Math.cos(p) * d,
      Math.sin(p) * d,
      Math.cos(cam.yaw) * Math.cos(p) * d
    ).add(cam.target);
    camera.lookAt(cam.target);
  }

  function bindOrbit(dom) {
    var drag = false, lx = 0, ly = 0, moved = 0;
    dom.addEventListener("mousedown", function (e) { drag = true; moved = 0; lx = e.clientX; ly = e.clientY; });
    root.addEventListener("mouseup", function () { drag = false; });
    dom.addEventListener("mousemove", function (e) {
      if (!drag) return;
      var dx = e.clientX - lx, dy = e.clientY - ly;
      moved += Math.abs(dx) + Math.abs(dy);
      cam.yaw -= dx * 0.006;
      cam.pitch += dy * 0.004;
      cam.pitch = Math.max(0.18, Math.min(1.35, cam.pitch));
      lx = e.clientX; ly = e.clientY;
      applyCamera();
    });
    dom.addEventListener("wheel", function (e) {
      e.preventDefault();
      cam.dist = Math.max(700, Math.min(2600, cam.dist + e.deltaY * 0.9));
      applyCamera();
    }, { passive: false });
    dom.addEventListener("click", function () { if (moved > 6) dom.__skipPick = true; });
  }

  /* ── 点牌出牌 ───────────────────────────────────────────── */
  function bindPick(dom) {
    dom.addEventListener("click", function (e) {
      if (dom.__skipPick) { dom.__skipPick = false; return; }
      if (state.busy) return;
      var r = dom.getBoundingClientRect();
      var pt = new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1
      );
      raycaster.setFromCamera(pt, camera);
      var hits = raycaster.intersectObjects(tileGroupHand.children, false);
      for (var i = 0; i < hits.length; i++) {
        var o = hits[i].object;
        if (o.userData && o.userData.seat === 0 && typeof o.userData.index === "number") {
          discard(o.userData.index);
          return;
        }
      }
    });
  }

  /* ── 桌面 ───────────────────────────────────────────────── */
  function buildTable() {
    var rim = new THREE.Mesh(new THREE.BoxGeometry(TW + 180, 60, TD + 180), matRim);
    rim.position.y = -40; rim.receiveShadow = true; groupBoard.add(rim);

    var felt = new THREE.Mesh(new THREE.BoxGeometry(TW, 34, TD), matFelt);
    felt.position.y = -12; felt.receiveShadow = true; groupBoard.add(felt);

    var lw = 6, gh = 2;
    var g1 = new THREE.Mesh(new THREE.BoxGeometry(TW - 40, gh, lw), matGold);
    g1.position.set(0, 6, TD / 2 - 40); groupBoard.add(g1);
    var g2 = g1.clone(); g2.position.z = -(TD / 2 - 40); groupBoard.add(g2);
    var g3 = new THREE.Mesh(new THREE.BoxGeometry(lw, gh, TD - 40), matGold);
    g3.position.set(TW / 2 - 40, 6, 0); groupBoard.add(g3);
    var g4 = g3.clone(); g4.position.x = -(TW / 2 - 40); groupBoard.add(g4);

    var disc = new THREE.Mesh(new THREE.CylinderGeometry(56, 56, 6, 48),
      new THREE.MeshStandardMaterial({ color: 0x14211c, roughness: 0.5 }));
    disc.position.y = 4; groupBoard.add(disc);
    var ring = new THREE.Mesh(new THREE.TorusGeometry(78, 5, 12, 48), matGold);
    ring.rotation.x = Math.PI / 2; ring.position.y = 8; groupBoard.add(ring);
  }

  /* ── 牌墙 ───────────────────────────────────────────────── */
  function buildWall(remain) {
    clearGroup(tileGroupWall);
    var slots = [], i;
    var pitch = WALL_LONG + 2, span = (17 - 1) * pitch, half = span / 2;
    for (i = 0; i < 17; i++) slots.push({ x: -half + i * pitch, z: -RINY, ry: 0 });
    for (i = 0; i < 17; i++) slots.push({ x: RINX, z: -half + i * pitch, ry: Math.PI / 2 });
    for (i = 0; i < 17; i++) slots.push({ x: half - i * pitch, z: RINY, ry: 0 });
    for (i = 0; i < 17; i++) slots.push({ x: -RINX, z: half - i * pitch, ry: Math.PI / 2 });

    var stacks = Math.ceil(remain / 2);
    var use = slots.slice(Math.max(0, slots.length - stacks));
    for (i = 0; i < use.length; i++) {
      var s = use[i];
      var layers = (remain % 2 === 1 && i === 0) ? 1 : 2;
      for (var k = 0; k < layers; k++) {
        var m = wallSlab();
        m.position.set(s.x, T / 2 + k * (T + 1), s.z);
        m.rotation.y = s.ry;
        tileGroupWall.add(m);
      }
    }
  }

  function clearGroup(g) {
    while (g.children.length) g.remove(g.children[g.children.length - 1]);
  }

  /* ── 座位坐标 ───────────────────────────────────────────── */
  function seatSlot(seat, i, n) {
    var half = (n - 1) * HAND_STEP / 2;
    var along = -half + i * HAND_STEP;
    if (seat === 0) return { x: along, z: HAND_Z, ry: 0 };
    if (seat === 2) return { x: -along, z: -HAND_Z, ry: Math.PI };
    if (seat === 1) return { x: HAND_X, z: -along, ry: Math.PI / 2 };
    return { x: -HAND_X, z: along, ry: -Math.PI / 2 };
  }

  function buildHands(hands) {
    clearGroup(tileGroupHand);
    for (var seat = 0; seat < 4; seat++) {
      var arr = hands[seat], n = arr.length;
      for (var i = 0; i < n; i++) {
        var sl = seatSlot(seat, i, n);
        var up = tileMesh(HW, HH, HT, seat === 0 ? arr[i] : null, { backOnly: seat !== 0 });
        up.position.set(sl.x, HH / 2, sl.z);
        up.rotation.y = sl.ry;
        if (seat === 0) up.rotation.x = -cam.pitch + 0.06;   // 牌面正对相机
        up.userData = { seat: seat, index: i };
        tileGroupHand.add(up);
      }
    }
  }

  /* ── 牌河 ───────────────────────────────────────────────── */
  function discSlot(seat, i) {
    var r = Math.floor(i / RIV_PER_ROW), c = i % RIV_PER_ROW;
    var along = RIV_START + c * RIV_PITCH, depth = 132 + r * RIV_PITCH;
    if (seat === 0) return { x: along, z: depth, ry: 0 };
    if (seat === 2) return { x: -along, z: -depth, ry: Math.PI };
    if (seat === 1) return { x: depth, z: -along, ry: Math.PI / 2 };
    return { x: -depth, z: along, ry: -Math.PI / 2 };
  }

  function buildDiscards(disc) {
    clearGroup(tileGroupDisc);
    for (var seat = 0; seat < 4; seat++) {
      var arr = disc[seat];
      for (var i = 0; i < arr.length; i++) {
        var sl = discSlot(seat, i);
        var m = flatTile(arr[i], RIV);
        var holder = new THREE.Group();
        holder.add(m);
        holder.position.set(sl.x, 12, sl.z);
        holder.rotation.y = sl.ry;
        holder.userData = { seat: seat, index: i, last: i === arr.length - 1 };
        tileGroupDisc.add(holder);
      }
    }
  }

  /* ── 牌局状态（本地演示，暂不接规则）───────────────────── */
  /* ══════════ 播报（Web Speech）══════════ */
var speakOn = true;

function tileName(kind) {
  kind = kind | 0;
  var n = (kind % 9) + 1;
  if (kind < 9) return n + "万";
  if (kind < 18) return n + "筒";
  if (kind < 27) return n + "条";
  return ["东风", "南风", "西风", "北风", "红中", "发财", "白板"][kind - 27] || "";
}

function speak(text) {
  if (!speakOn || !text || !root.speechSynthesis) return;
  try {
    if (root.speechSynthesis.cancel) root.speechSynthesis.cancel();
    var u = new root.SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.rate = 1.15;
    root.speechSynthesis.speak(u);
  } catch (e) { /* 忽略 */ }
}
/* ══════════ 牌局：由 mahjong.js 的 Engine 驱动（规则全部复用）══════════ */
var E = null;                 // Mahjong.test.Engine
var state = { wallArr: [], hands: [[], [], [], []], disc: [[], [], [], []],
              melds: [[], [], [], []], handIdx: [[], [], [], []], busy: false, turn: 0, over: false, pending: null };

/* 牌名 → 贴图索引（0-8 万 / 9-17 筒 / 18-26 条 / 27-33 字）*/
function tileKind(t) {
  if (typeof t === "number") return t;
  var s = String(t), n = parseInt(s, 10), suit = s.slice(-1);
  if (suit === "万") return n - 1;
  if (suit === "筒") return 9 + n - 1;
  if (suit === "条") return 18 + n - 1;
  var h = ["东", "南", "西", "北", "中", "发", "白"];
  var i = h.indexOf(s);
  if (i >= 0) return 27 + i;
  if (s === "东风") return 27; if (s === "南风") return 28;
  if (s === "西风") return 29; if (s === "北风") return 30;
  if (s === "红中") return 31; if (s === "发财") return 32; if (s === "白板") return 33;
  return 0;
}

function canUseEngine() {
  return !!(root.Mahjong && root.Mahjong.test && root.Mahjong.test.Engine);
}

function syncFromEngine() {
  if (!E) return;
  state.handIdx[0] = [];
  for (var s = 0; s < 4; s++) {
    var p = E.P[s];
    var list = [];
    for (var i = 0; i < p.hand.length; i++) {
      list.push({ k: tileKind(p.hand[i]), i: i, drawn: (s === 0 && p.drawn && p.hand[i] === p.drawn && i === p.hand.length - 1) ? 1 : 0 });
    }
    // 摸到的牌排最后，其余按花色+点数从小到大
    list.sort(function (a, b) { return (a.drawn - b.drawn) || (a.k - b.k); });
    state.hands[s] = list.map(function (x) { return x.k; });
    if (s === 0) state.handIdx[0] = list.map(function (x) { return x.i; });
    state.disc[s] = p.discards.map(tileKind);
    state.melds[s] = p.melds || [];
  }
  state.wallArr = new Array(E.wall.length);
  state.turn = E.cur;
  state.over = E.phase === "over";
  state.pending = (E.phase === "claim" && E.pending) ? E.pending : null;
}

function newDeal() {
  if (!canUseEngine()) { console.error("[MJ3D] 未找到 Mahjong.test.Engine"); return; }
  E = new root.Mahjong.test.Engine(10);
  E.P[0].isHuman = true;              // 座位 0 由玩家操作
  E.deal();
  syncFromEngine();
  state.busy = false;
  refresh();
  if (E.phase === "turn" && E.cur !== 0) pumpAI();
}

/* 玩家出牌：点哪张打哪张 */
function discard(i) {
  if (!E || state.over || state.busy) return;
  if (E.phase !== "turn" || E.cur !== 0) return;
  if (i < 0 || i >= state.handIdx[0].length) return;
  var ei = state.handIdx[0][i];
  var t = E.P[0].hand[ei];
  var ok = E.discard(0, ei);
  if (!ok) return;
  speak(tileName(tileKind(t)));
  syncFromEngine();
  refresh();
  dropIn(0, state.disc[0].length - 1);
  setTimeout(function () { afterHumanAction(); }, CLAIM_DELAY);
}

function afterHumanAction() {
  if (!E) return;
  if (E.phase === "over") { onOver(); return; }
  if (E.phase === "claim" && E.pending && E.pending.seat === 0) { showClaim(); return; }
  pumpAI();
}

/* 推进 AI 直到轮到玩家 / 需要玩家表态 / 结束 */
function pumpAI() {
  if (!E || state.over) return;
  if (E.phase === "over") { onOver(); return; }
  if (E.phase === "claim" && E.pending && E.pending.seat === 0) { showClaim(); return; }
  if (E.phase === "turn" && E.cur === 0) { state.busy = false; syncFromEngine(); refresh(); return; }
  state.busy = true;
  var r = E.aiStep();
  syncFromEngine();
  refresh();
  if (r === "discard") {
    var seat = E.log.length ? E.log[E.log.length - 1].seat : 0;
    var d = E.P[seat].discards;
    if (d.length) { speak(tileName(tileKind(d[d.length - 1]))); dropIn(seat, d.length - 1); }
  }
  setTimeout(function () {
    if (!E || E.phase === "over") { onOver(); return; }
    pumpAI();
  }, AI_STEP_MS);
}

/* 碰杠按钮 */
function showClaim() {
  var pend = E.pending;
  var bar = root.document.getElementById("claimBar");
  if (!bar) return;
  var acts = (pend.actions || []).slice();
  var html = "";
  for (var i = 0; i < acts.length; i++) {
    var a = acts[i];
    var lab = a === "peng" ? "碰" : a === "gang" ? "杠" : a === "hu" ? "胡" : a;
    html += '<button class="btn" data-act="' + a + '">' + lab + "</button>";
  }
  html += '<button class="btn" data-act="pass">过</button>';
  bar.innerHTML = html;
  bar.style.display = "flex";
  var btns = bar.querySelectorAll("button");
  for (var k = 0; k < btns.length; k++) {
    btns[k].onclick = function () {
      var act = this.getAttribute("data-act");
      bar.style.display = "none";
      E.claim(0, act);
      syncFromEngine();
      refresh();
      speak(act === "peng" ? "碰" : act === "gang" ? "杠" : "");
      setTimeout(function () { afterHumanAction(); }, CLAIM_DELAY);
    };
  }
}

function onOver() {
  state.over = true;
  settleUI();
}

/* 结算提示（结果文案来自引擎的 settle）*/
function settleUI() {
  var el = root.document.getElementById("resultBar");
  if (!el) return;
  var r = E && E.result;
  var txt = "本局结束";
  if (r) {
    var who = (r.seat === 0) ? "你" : SEAT_NAMES[r.seat];
    txt = who + " 胡了 · " + (r.tierName || r.name || "") + (r.total ? (" · 共 " + r.total + " 分") : "");
  }
  el.textContent = txt;
  el.style.display = "block";
}
/* ── 动画：落河 / 摸牌 ─────────────────────────────────── */
  function dropIn(seat, idx) {
    var g = null;
    for (var i = 0; i < tileGroupDisc.children.length; i++) {
      var o = tileGroupDisc.children[i];
      if (o.userData && o.userData.seat === seat && o.userData.index === idx) { g = o; break; }
    }
    if (!g) return;
    anims.length = 0;               // 清掉指向旧网格的动画，避免重复下落
    g.position.y = 150;
    anims.push({
      obj: g, t: 0, dur: 260,
      from: 150, to: 12,
      done: function () { g.position.y = 12; }
    });
  }

  function popIn(idx) {
    var n = tileGroupHand.children.length;
    var mesh = null;
    for (var i = 0; i < n; i++) {
      var o = tileGroupHand.children[i];
      if (o.userData && o.userData.seat === 0 && o.userData.index === idx) { mesh = o; break; }
    }
    if (!mesh) return;
    var baseY = HH / 2;
    mesh.position.y = baseY + 70;
    anims.push({ obj: mesh, t: 0, dur: 220, from: baseY + 70, to: baseY, done: function () { mesh.position.y = baseY; } });
  }

  function stepAnims(dt) {
    for (var i = anims.length - 1; i >= 0; i--) {
      var a = anims[i];
      a.t += dt;
      var k = Math.min(1, a.t / a.dur);
      var e = 1 - Math.pow(1 - k, 3);
      a.obj.position.y = a.from + (a.to - a.from) * e;
      if (k >= 1) { if (a.done) a.done(); anims.splice(i, 1); }
    }
  }

  function refresh() {
    buildWall(state.wallArr.length);
    buildHands(state.hands);
    buildDiscards(state.disc);
    syncHud();
  }

  function syncHud() {
    var el = root.document && root.document.getElementById("info");
    if (el) el.textContent = "牌墙 " + state.wallArr.length + " 张 · 手牌 " + state.hands[0].length + " 张 · 点手牌即可打出";
  }

  var lastT = 0;
  /* 手牌倾角随相机变化，保证始终"正视" */
  function syncHandTilt() {
    if (!tileGroupHand) return;
    var tilt = -cam.pitch + 0.06;
    for (var i = 0; i < tileGroupHand.children.length; i++) {
      var o = tileGroupHand.children[i];
      if (o.userData && o.userData.seat === 0) o.rotation.x = tilt;
    }
  }

  function frame(now) {
    var t = now || 0;
    var dt = lastT ? Math.min(60, t - lastT) : 16;
    lastT = t;
    stepAnims(dt);
    syncHandTilt();
    renderer.render(scene, camera);
  }

  /* 窗口自适应：改尺寸时同步相机宽高比，否则画面会被拉伸 */
  function onResize() {
    var el = renderer.domElement.parentElement;
    if (!el) return;
    var w = el.clientWidth || root.innerWidth || 1240;
    var h = el.clientHeight || root.innerHeight || 860;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function diag() {
    return {
      revision: THREE.REVISION || "?",
      webgl2: !!(renderer && renderer.capabilities && renderer.capabilities.isWebGL2),
      lights: scene ? scene.children.filter(function (o) { return o.isLight; }).length : 0,
      feltColor: matFelt ? "#" + matFelt.color.getHexString() : "-",
      feltType: matFelt ? matFelt.type : "-",
      wallTiles: tileGroupWall ? tileGroupWall.children.length : 0,
      handTiles: tileGroupHand ? tileGroupHand.children.length : 0,
      discTiles: tileGroupDisc ? tileGroupDisc.children.length : 0,
      boardChildren: groupBoard ? groupBoard.children.length : 0
    };
  }

  root.MJ3D = {
    diag: diag,
    hasEngine: function () { return canUseEngine(); },
    debug: {
      discard: function (i) { discard(i); },
      tileName: tileName,
      state: function () { return state; }
    },
    init: init,
    reset: newDeal,
    state: function () { return state; }
  };
})(window);
