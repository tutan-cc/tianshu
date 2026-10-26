/* ═══════════════════════════════════════════════════════════════════════════
   mahjong.gl3d.js — 真 3D 麻将桌面（three.js）
   只负责渲染，不改 mahjong.js、不改 index.html、不影响现有测试。
   通过 mj3d.html 单独打开。
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";
  var THREE = root.THREE;
  if (!THREE) { console.error("[MJ3D] 缺少 three.js"); return; }

  /* ── 尺寸（沿用 Godot 版比例）────────────────────────────── */
  var W = 34, H = 44, T = 19;          // 牌墙牌
  var HW = 52, HH = 74, HT = 24;       // 手牌
  var TW = 1200, TD = 1000;            // 桌面绒面
  var RINX = 440, RINY = 350;          // 牌墙环
  var HAND_Z = 410, HAND_X = 476, HAND_STEP = 56;
  var FACE_DIR = "reference/mj-godot3d/faces/";

  var SEATS = [
    { name: "你",   hand: [0, 0],  pos: "bottom" },
    { name: "下家", hand: [0, 0],  pos: "right"  },
    { name: "对家", hand: [0, 0],  pos: "top"    },
    { name: "上家", hand: [0, 0],  pos: "left"   }
  ];

  var FACE_KEYS = [];
  (function () {
    var i;
    for (i = 1; i <= 9; i++) FACE_KEYS.push("wan_" + i);
    for (i = 1; i <= 9; i++) FACE_KEYS.push("tong_" + i);
    for (i = 1; i <= 9; i++) FACE_KEYS.push("tiao_" + i);
    FACE_KEYS.push("feng_dong", "feng_nan", "feng_xi", "feng_bei");
    FACE_KEYS.push("jian_zhong", "jian_fa", "jian_bai");
  })();

  /* ── 材质缓存 ───────────────────────────────────────────── */
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
      tex.colorSpace = tex.colorSpace || THREE.SRGBColorSpace;
      texCache[key] = tex;
    }
    var m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.02 });
    matCache[key] = m;
    return m;
  }

  /* ── 单张牌：六面材质 [右,左,上,下,前,后] ───────────────── */
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

  /* ── 场景 ───────────────────────────────────────────────── */
  var renderer, scene, camera, groupBoard;
  var tileGroupHand, tileGroupWall, tileGroupDisc;
  var cam = { yaw: 0, pitch: 0.62, dist: 1430, target: new THREE.Vector3(0, 0, 40) };

  function init(el) {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setClearColor(0x000000, 1);
    if ("outputColorSpace" in renderer && THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
    if ("useLegacyLights" in renderer) renderer.useLegacyLights = true;
    renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
    renderer.setSize(el.clientWidth || 1240, el.clientHeight || 860);
    renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);

    makeMaterials();
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0f10);

    camera = new THREE.PerspectiveCamera(43, (el.clientWidth || 1240) / (el.clientHeight || 860), 10, 6000);
    applyCamera();

    /* 灯光 */
    scene.add(new THREE.HemisphereLight(0xa8c4bd, 0x2a1a12, 0.72));
    var key = new THREE.DirectionalLight(0xfff3e0, 1.05);
    key.position.set(420, 900, 620);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
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

    bindOrbit(renderer.domElement);
    dealDemo();
    animate();
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
    var drag = false, lx = 0, ly = 0;
    dom.addEventListener("mousedown", function (e) { drag = true; lx = e.clientX; ly = e.clientY; });
    root.addEventListener("mouseup", function () { drag = false; });
    dom.addEventListener("mousemove", function (e) {
      if (!drag) return;
      cam.yaw -= (e.clientX - lx) * 0.006;
      cam.pitch += (e.clientY - ly) * 0.004;
      cam.pitch = Math.max(0.18, Math.min(1.35, cam.pitch));
      lx = e.clientX; ly = e.clientY;
      applyCamera();
    });
    dom.addEventListener("wheel", function (e) {
      e.preventDefault();
      cam.dist = Math.max(700, Math.min(2600, cam.dist + e.deltaY * 0.9));
      applyCamera();
    }, { passive: false });
  }

  /* ── 桌面 ───────────────────────────────────────────────── */
  function buildTable() {
    var rim = new THREE.Mesh(new THREE.BoxGeometry(TW + 180, 60, TD + 180), matRim);
    rim.position.y = -40;
    rim.receiveShadow = true;
    groupBoard.add(rim);

    var felt = new THREE.Mesh(new THREE.BoxGeometry(TW, 34, TD), matFelt);
    felt.position.y = -12;
    felt.receiveShadow = true;
    groupBoard.add(felt);

    /* 金线 */
    var lw = 6, gh = 2;
    var g1 = new THREE.Mesh(new THREE.BoxGeometry(TW - 40, gh, lw), matGold);
    g1.position.set(0, 6, TD / 2 - 40); groupBoard.add(g1);
    var g2 = g1.clone(); g2.position.z = -(TD / 2 - 40); groupBoard.add(g2);
    var g3 = new THREE.Mesh(new THREE.BoxGeometry(lw, gh, TD - 40), matGold);
    g3.position.set(TW / 2 - 40, 6, 0); groupBoard.add(g3);
    var g4 = g3.clone(); g4.position.x = -(TW / 2 - 40); groupBoard.add(g4);

    /* 中央圆盘 */
    var disc = new THREE.Mesh(new THREE.CylinderGeometry(56, 56, 6, 48), new THREE.MeshStandardMaterial({ color: 0x14211c, roughness: 0.5 }));
    disc.position.y = 4; groupBoard.add(disc);
    var ring = new THREE.Mesh(new THREE.TorusGeometry(78, 5, 12, 48), matGold);
    ring.rotation.x = Math.PI / 2; ring.position.y = 8; groupBoard.add(ring);
  }

  /* ── 牌墙：横躺扁牌，44 沿排 / 19 高 / 34 纵深，绿面朝上 ── */
  var WALL_LONG = 44;
  function wallSlab() {
    var geo = new THREE.BoxGeometry(WALL_LONG, T, W);
    var mats = [matIvory, matIvory, matGreen, matIvory, matIvory, matIvory];
    var m = new THREE.Mesh(geo, mats);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  function buildWall(remain) {
    while (tileGroupWall.children.length) tileGroupWall.remove(tileGroupWall.children[0]);
    var slots = [];
    var i, p;
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

  /* ── 手牌 ───────────────────────────────────────────────── */
  function seatSlot(seat, i, n) {
    var half = (n - 1) * HAND_STEP / 2;
    var along = -half + i * HAND_STEP;
    if (seat === 0) return { x: along, z: HAND_Z, ry: 0 };
    if (seat === 2) return { x: -along, z: -HAND_Z, ry: Math.PI };
    if (seat === 1) return { x: HAND_X, z: -along, ry: Math.PI / 2 };
    return { x: -HAND_X, z: along, ry: -Math.PI / 2 };
  }

  function buildHands(hands) {
    while (tileGroupHand.children.length) tileGroupHand.remove(tileGroupHand.children[0]);
    for (var seat = 0; seat < 4; seat++) {
      var arr = hands[seat], n = arr.length;
      for (var i = 0; i < n; i++) {
        var sl = seatSlot(seat, i, n);
        var upright = tileMesh(HW, HH, HT, seat === 0 ? arr[i] : null, { backOnly: seat !== 0 });
        upright.position.set(sl.x, HH / 2, sl.z);
        upright.rotation.y = sl.ry;
        if (seat === 0) upright.rotation.x = -0.16;
        tileGroupHand.add(upright);
      }
    }
  }

  /* ── 牌河 ───────────────────────────────────────────────── */
  function buildDiscards(disc) {
    while (tileGroupDisc.children.length) tileGroupDisc.remove(tileGroupDisc.children[0]);
    for (var seat = 0; seat < 4; seat++) {
      var arr = disc[seat];
      for (var i = 0; i < arr.length; i++) {
        var r = Math.floor(i / 6), c = i % 6;
        var along = -103 + c * 41, depth = 160 + r * 41;
        var x, z, ry;
        if (seat === 0) { x = along; z = depth; ry = 0; }
        else if (seat === 2) { x = -along; z = -depth; ry = Math.PI; }
        else if (seat === 1) { x = depth; z = -along; ry = Math.PI / 2; }
        else { x = -depth; z = along; ry = -Math.PI / 2; }
        var m = tileMesh(HW * 0.78, 19, HW * 0.78, arr[i]);
        m.rotation.x = Math.PI / 2;
        m.rotation.z = 0;
        var holder = new THREE.Group();
        holder.add(m);
        holder.position.set(x, 12, z);
        holder.rotation.y = ry;
        tileGroupDisc.add(holder);
      }
    }
  }

  /* ── 演示牌局（本地状态，先不接规则）───────────────────── */
  var state = { wall: 0, hands: [[], [], [], []], disc: [[], [], [], []] };

  function dealDemo() {
    var all = [];
    for (var k = 0; k < 34; k++) for (var c = 0; c < 4; c++) all.push(k);
    for (var i = all.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = all[i]; all[i] = all[j]; all[j] = tmp;
    }
    for (var s = 0; s < 4; s++) {
      state.hands[s] = [];
      state.disc[s] = [];
      for (var d = 0; d < (s === 0 ? 14 : 13); d++) state.hands[s].push(all.pop());
    }
    state.wall = all.length;
    refresh();
  }

  function refresh() {
    buildWall(state.wall);
    buildHands(state.hands);
    buildDiscards(state.disc);
  }

  function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
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
    init: init,
    reset: dealDemo,
    state: function () { return state; }
  };
})(window);
