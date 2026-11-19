/* ═══════════════════════════════════════════════════════════════════════════
 * map3d.js — 《天枢原型 · 重启人生》3D 等距沙盘模块（自包含 / 零构建 / 全局脚本）
 *
 * 依赖：同目录 three.min.js（r149 UMD）已先加载，使用全局 `THREE`。
 * 暴露：window.Map3D
 *
 * 对外接口（与 index.html 中已写好的接入代码一一对应）：
 *   Map3D.mount(el, { places, nodes, onPick })          -> true | false
 *   Map3D.refresh({ done:[nodeId], avail:nodeId|null }) -> boolean
 *   Map3D.setMood('calm'|'city'|'tense'|'night'|'dark') -> boolean
 *   Map3D.setMode('orbit'|'top')                        -> boolean
 *   Map3D.isReady()                                     -> boolean
 *   Map3D.dispose() / Map3D.info()                      （附加，非必需）
 *
 * mount 内部全程 try/catch：WebGL 不可用、THREE 缺失、数据非法……任何失败
 * 都返回 false，绝不抛错（调用方据此回落 2D 沙盘）。
 *
 * 设计要点：
 *   · 建筑按「几何 + 材质」InstancedMesh 合批（2 种墙面风格 × 3 档层数密度 ≤ 6 个批次）
 *   · 标签 = CanvasTexture + Sprite（256×56，仅在状态变化时重绘）
 *   · 相机 = OrthographicCamera，等距机位 (38,38,38) → lookAt 场景中心；setMode('top') 平滑俯视
 *   · 坐标 = PLACES 的 (x:0~800, y:0~520) 线性映射为 wx=(x-400)/40, wz=(y-260)/40
 *   · 小地图 = 第二个正交相机 + scissor 视口（右下角 120×120）+ DOM 外框
 * ═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  var VERSION = "2.0.0";

  /* ───────────────────────────── 常量 ───────────────────────────── */

  var MAP_W = 800, MAP_H = 520;     // 2D 沙盘坐标范围
  var SX = 40, SZ = 40;             // 像素 → 世界单位 的比例
  var CX = MAP_W / 2, CY = MAP_H / 2;

  var ISO_YAW = 0.12;                        // 等距 yaw = 45°
  var ISO_PITCH = 0.88;        // 等距 pitch = 35.264°
  var TOP_PITCH = 1.5454;                           // 俯视 pitch ≈ 88.5°（不取 90° 以免 lookAt 退化）
  var CAM_DIST = 68;                                // 相机轨道半径
  var CAM_TARGET_Y = 1.1;

  var MM_SIZE = 120, MM_MARGIN = 10, MM_HALF = 19;   // 小地图

  /* 氛围预设：雾 / 背景 / 光色温 / 环境光强度
   * 注意：主相机 8 字轨道半径 = |(38,38,38)| ≈ 65.8，场景沿视线深度约 54~78，
   *       因此 fogNear/fogFar 必须落在该区间之外，否则整个沙盘会被雾吃成全黑。
   * floor = 楼体最低亮度（自发光下限），保证夜间/暗场也能看清建筑轮廓。 */
  var MOODS = {
    calm:  { bg: 0x869eab, fog: 0x9eaeb0, fogNear: 95, fogFar: 180, amb: 0.30, hemi: 0.45, sun: 0xffeed8, sunI: 0.85, fill: 0xb8d5ef, fillI: 0.25, night: false, floor: 0.025 },
    city:  { bg: 0x849daa, fog: 0xa2b8c2, fogNear: 95, fogFar: 180, amb: 0.32, hemi: 0.46, sun: 0xfff5e8, sunI: 0.85, fill: 0xb1d7ed, fillI: 0.28, night: false, floor: 0.025 },
    tense: { bg: 0x7b767a, fog: 0xa39491, fogNear: 90, fogFar: 170, amb: 0.55, hemi: 0.52, sun: 0xffc49a, sunI: 0.9, fill: 0xaab9cf, fillI: 0.22, night: false, floor: 0.045 },
    night: { bg: 0x142533, fog: 0x203b50, fogNear: 95, fogFar: 165, amb: 0.42, hemi: 0.42, sun: 0xa9c9ec, sunI: 0.55, fill: 0xffc38b, fillI: 0.18, night: true, floor: 0.08 },
    dark:  { bg: 0x101b2b, fog: 0x1d2d43, fogNear: 90, fogFar: 160, amb: 0.32, hemi: 0.35, sun: 0xa9bada, sunI: 0.48, fill: 0xd4b498, fillI: 0.16, night: true, floor: 0.09 }
  };
  var MOOD_FALLBACK = "calm";

  var LABEL_W = 256, LABEL_H = 56;

  /* ───────────────────────────── 小工具 ───────────────────────────── */

  function isFn(v) { return typeof v === "function"; }
  function isObj(v) { return v !== null && typeof v === "object"; }
  function num(v, d) { v = +v; return isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function hypot(a, b) { return Math.sqrt(a * a + b * b); }

  /** FNV-1a 32bit —— 确定性哈希（同一 id 永远得同一结果） */
  function hash32(s) {
    s = String(s);
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rand01(s) { return hash32(s) / 4294967296; }

  /** 由 id 决定建筑高度：确定性落在 1.6~4.2 */
  function heightOf(id) { return 1.6 + (hash32(id + "|h") % 5) * 0.65; }

  /** #rrggbb / #rgb / number → 数字色；失败返回 fb */
  function toHex(c, fb) {
    if (typeof c === "number" && isFinite(c)) return c >>> 0;
    if (typeof c === "string") {
      var m = c.trim();
      if (m.charAt(0) === "#") m = m.slice(1);
      if (m.length === 3) m = m[0] + m[0] + m[1] + m[1] + m[2] + m[2];
      if (/^[0-9a-fA-F]{6}$/.test(m)) return parseInt(m, 16);
    }
    return fb;
  }

  /** 自绘圆角矩形（不依赖 ctx.roundRect） */
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /* ─────────────────────── WebGL 探测（64×64 离屏试渲染） ─────────────────────── */

  function webglProbe() {
    try {
      var cv = document.createElement("canvas");
      cv.width = 64; cv.height = 64;
      var gl = null, o = { failIfMajorPerformanceCaveat: false, preserveDrawingBuffer: false };
      try { gl = cv.getContext("webgl2", o); } catch (e) { gl = null; }
      if (!gl) { try { gl = cv.getContext("webgl", o); } catch (e1) { gl = null; } }
      if (!gl) { try { gl = cv.getContext("experimental-webgl", o); } catch (e2) { gl = null; } }
      if (!gl || !isFn(gl.getParameter)) return false;
      if (!gl.getParameter(gl.VERSION)) return false;

      // 真跑一遍完整管线（着色器编译 + 链接 + 绘制），排除空壳 context
      var vs = gl.createShader(gl.VERTEX_SHADER);
      var fs = gl.createShader(gl.FRAGMENT_SHADER);
      if (!vs || !fs) return false;
      gl.shaderSource(vs, "attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}");
      gl.shaderSource(fs, "precision mediump float;void main(){gl_FragColor=vec4(0.2,0.8,0.4,1.0);}");
      gl.compileShader(vs); gl.compileShader(fs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) return false;
      var pr = gl.createProgram();
      if (!pr) return false;
      gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return false;
      gl.useProgram(pr);
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(pr, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, 64, 64);
      gl.clearColor(0.04, 0.04, 0.07, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      var err = isFn(gl.getError) ? gl.getError() : 0;
      var lose = isFn(gl.getExtension) ? gl.getExtension("WEBGL_lose_context") : null;
      if (lose && isFn(lose.loseContext)) { try { lose.loseContext(); } catch (e3) {} }
      return !err;
    } catch (e) { return false; }
  }

  /* ───────────────────────────── 程序化贴图 ───────────────────────────── */

  function newTex(T, cv, repeatX, repeatY) {
    var tex = new T.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.repeat.set(repeatX || 1, repeatY || 1);
    tex.magFilter = T.LinearFilter;
    tex.minFilter = T.LinearMipmapLinearFilter || T.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 1;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * 墙面贴图（128×128 = 一层楼），上下可无缝平铺。
   *  style 0 → 砖墙 + 窗（老城区）
   *  style 1 → 玻璃幕墙（现代）
   */
  function makeWallCanvas(style) {
    var cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    var g = cv.getContext("2d");
    if (!g) return null;
    var seed = style === 0 ? 20250917 : 19980504;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) / 8388608; }

    if (style === 0) {
      /* ── 砖墙 ──（中性灰，最终颜色 = 贴图明度 × 地点主题色） */
      g.fillStyle = "#8d8d8d"; g.fillRect(0, 0, 128, 128);
      for (var y = 0; y < 128; y += 8) {
        var off = ((y / 8) % 2) ? 8 : 0;
        for (var x = -16; x < 128; x += 16) {
          var r = 120 + (rnd() * 44 | 0);
          g.fillStyle = "rgb(" + r + "," + r + "," + r + ")";
          g.fillRect(x + off + 1, y + 1, 14, 6);
        }
      }
      g.fillStyle = "rgba(30,30,30,.55)";
      for (var y2 = 0; y2 < 128; y2 += 8) g.fillRect(0, y2, 128, 1);

      /* 楼层腰线（贴图顶部，保证垂直平铺时形成连续楼层分隔） */
      g.fillStyle = "#5c5c5c"; g.fillRect(0, 0, 128, 13);
      g.fillStyle = "rgba(255,255,255,.10)"; g.fillRect(0, 2, 128, 2);
      g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(0, 13, 128, 2);

      /* 窗 */
      var wx = 26, wy = 30, ww = 76, wh = 68;
      g.fillStyle = "#3a3a3a"; g.fillRect(wx - 4, wy - 4, ww + 8, wh + 8);      // 窗框
      var grd = g.createLinearGradient(wx, wy, wx + ww, wy + wh);
      grd.addColorStop(0, "#3c3c3c"); grd.addColorStop(0.55, "#787878"); grd.addColorStop(1, "#2e2e2e");
      g.fillStyle = grd; g.fillRect(wx, wy, ww, wh);
      g.fillStyle = "rgba(255,255,255,.13)";                                    // 玻璃反光
      g.beginPath(); g.moveTo(wx, wy + wh); g.lineTo(wx + ww * 0.5, wy); g.lineTo(wx + ww * 0.72, wy); g.lineTo(wx + ww * 0.22, wy + wh); g.closePath(); g.fill();
      g.strokeStyle = "#2e2e2e"; g.lineWidth = 3;                               // 窗棂
      g.beginPath(); g.moveTo(wx + ww / 2, wy); g.lineTo(wx + ww / 2, wy + wh); g.stroke();
      g.beginPath(); g.moveTo(wx, wy + wh * 0.45); g.lineTo(wx + ww, wy + wh * 0.45); g.stroke();
      g.fillStyle = "#b4b4b4"; g.fillRect(wx - 6, wy + wh + 3, ww + 12, 5);      // 窗台
      g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(wx - 6, wy + wh + 8, ww + 12, 3);
    } else {
      /* ── 玻璃幕墙 ──（中性灰） */
      var bg = g.createLinearGradient(0, 0, 128, 128);
      bg.addColorStop(0, "#6e6e6e"); bg.addColorStop(0.5, "#9a9a9a"); bg.addColorStop(1, "#5c5c5c");
      g.fillStyle = bg; g.fillRect(0, 0, 128, 128);
      for (var cy = 0; cy < 128; cy += 42) {
        for (var cx = 0; cx < 128; cx += 32) {
          g.fillStyle = "rgba(255,255,255," + (0.04 + rnd() * 0.22).toFixed(2) + ")";
          g.fillRect(cx + 3, cy + 3, 26, 36);
        }
      }
      g.strokeStyle = "rgba(28,28,28,.9)"; g.lineWidth = 3;
      for (var mx = 0; mx <= 128; mx += 32) { g.beginPath(); g.moveTo(mx, 0); g.lineTo(mx, 128); g.stroke(); }
      for (var my = 0; my <= 128; my += 42) { g.beginPath(); g.moveTo(0, my); g.lineTo(128, my); g.stroke(); }
      g.fillStyle = "#4a4a4a"; g.fillRect(0, 0, 128, 7);                          // 楼层横梁
      g.fillStyle = "rgba(255,255,255,.14)"; g.fillRect(0, 1, 128, 2);
      g.fillStyle = "rgba(255,255,255,.10)";                                      // 斜向高光
      g.beginPath(); g.moveTo(0, 128); g.lineTo(70, 0); g.lineTo(100, 0); g.lineTo(30, 128); g.closePath(); g.fill();
    }
    return cv;
  }

  /** 屋顶贴图（128×128） */
  function makeRoofCanvas() {
    var cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    var g = cv.getContext("2d");
    if (!g) return null;
    var seed = 777;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) / 8388608; }
    g.fillStyle = "#6a6a6a"; g.fillRect(0, 0, 128, 128);
    for (var i = 0; i < 1400; i++) {
      var v = 84 + (rnd() * 66 | 0);
      g.fillStyle = "rgba(" + v + "," + v + "," + v + ",.55)";
      g.fillRect(rnd() * 128, rnd() * 128, 3, 3);
    }
    g.strokeStyle = "rgba(30,30,30,.85)"; g.lineWidth = 7; g.strokeRect(3.5, 3.5, 121, 121);
    g.strokeStyle = "rgba(255,255,255,.10)"; g.lineWidth = 2; g.strokeRect(7, 7, 114, 114);
    for (var k = 0; k < 6; k++) {
      var bx = 14 + rnd() * 76, by = 14 + rnd() * 76, bw = 16 + rnd() * 22, bh = 13 + rnd() * 18;
      g.fillStyle = "#838383"; g.fillRect(bx, by, bw, bh);
      g.fillStyle = "rgba(255,255,255,.16)"; g.fillRect(bx, by, bw, 3);
      g.strokeStyle = "rgba(24,24,24,.9)"; g.lineWidth = 2; g.strokeRect(bx, by, bw, bh);
    }
    return cv;
  }

  /** 地面网格（128×128，RepeatWrapping，repeat 在材质上调） */
  function makeGroundCanvas() {
    var cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    var g = cv.getContext("2d");
    if (!g) return null;
    g.fillStyle = "#718073"; g.fillRect(0, 0, 128, 128);
    for (var i = 0; i < 260; i++) {
      var v = 120 + (hash32("g" + i) % 100);
      g.fillStyle = "rgba(" + v + "," + (v - 20) + "," + (v + 40) + ",.16)";
      g.fillRect(hash32("x" + i) % 128, hash32("y" + i) % 128, 2, 2);
    }
    g.strokeStyle = "rgba(113,125,110,.04)"; g.lineWidth = 2;
    g.strokeRect(1, 1, 126, 126);
    g.strokeStyle = "rgba(113,125,110,.02)"; g.lineWidth = 1;
    for (var k = 32; k < 128; k += 32) {
      g.beginPath(); g.moveTo(k, 0); g.lineTo(k, 128); g.stroke();
      g.beginPath(); g.moveTo(0, k); g.lineTo(128, k); g.stroke();
    }
    return cv;
  }

  /* ───────────────────────────── 标签（CanvasTexture + Sprite） ───────────────────────────── */

  function drawLabel(p) {
    var g=p.lblCtx; if(!g) return;
    var avail=p.state==='avail', done=p.state==='done';
    g.clearRect(0,0,LABEL_W,LABEL_H);
    g.shadowColor='rgba(0,0,0,.35)'; g.shadowBlur=5;
    rr(g,6,4,244,43,21); g.fillStyle='rgba(14,22,28,.94)'; g.fill(); g.shadowBlur=0;
    g.beginPath(); g.moveTo(24,45);g.lineTo(34,55);g.lineTo(43,45);g.fill();
    g.beginPath();g.arc(32,25,15,0,Math.PI*2);g.fillStyle=avail?'#f6bf41':(done?'#7aab94':'#e3e9ec');g.fill();
    g.fillStyle=avail?'#202b31':'#253740'; g.font='bold 20px sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillText(avail?'!':(done?'✓':'•'),32,26);
    var txt=String(p.name||p.id),size=23;
    g.textAlign='left';g.font='700 '+size+'px "Microsoft YaHei",sans-serif';
    while(size>14 && g.measureText(txt).width>185){size--;g.font='700 '+size+'px "Microsoft YaHei",sans-serif';}
    g.fillStyle='#f5f5ef';g.fillText(txt,56,25);
    if(p.lblTex)p.lblTex.needsUpdate=true;
  }

  function makeLabel(inst, p) {
    var T = inst.T;
    var cv = document.createElement("canvas");
    cv.width = LABEL_W; cv.height = LABEL_H;
    var ctx = cv.getContext("2d");
    var tex = new T.CanvasTexture(cv);
    tex.minFilter = T.LinearFilter;
    tex.magFilter = T.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    var mat = new T.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false, opacity: 1
    });
    var sp = new T.Sprite(mat);
    sp.scale.set(LABEL_W / LABEL_H * 0.62, 0.62, 1);
    sp.renderOrder = 20;
    p.lblCanvas = cv; p.lblCtx = ctx; p.lblTex = tex; p.lblMat = mat; p.label = sp;
    drawLabel(p);
  }

  function disposeLabel(p) {
    if (p.lblTex && isFn(p.lblTex.dispose)) p.lblTex.dispose();
    if (p.lblMat && isFn(p.lblMat.dispose)) p.lblMat.dispose();
    p.label = null; p.lblTex = null; p.lblMat = null; p.lblCtx = null; p.lblCanvas = null;
  }

  /* ───────────────────────────── 复用临时对象 ───────────────────────────── */

  var _m4 = null, _v3 = null, _v3b = null, _q0 = null, _axisY = null, _ray = null, _ndc = null;

  function lazyTmp(T) {
    if (!_m4) {
      _m4 = new T.Matrix4(); _v3 = new T.Vector3(); _v3b = new T.Vector3();
      _q0 = new T.Quaternion(); _axisY = new T.Vector3(0, 1, 0);
      _ray = new T.Raycaster(); _ndc = new T.Vector2();
    }
  }

  /* ───────────────────────────── 边（道路） ───────────────────────────── */

  /** 从 NODES.next 推导地点邻接；NODES 缺失/无 next 时退回 PLACES 声明顺序 */
  function buildEdges(places, nodes) {
    var seen = {}, out = [];
    function add(a, b) {
      if (!a || !b || a === b || !places[a] || !places[b]) return;
      var k = a < b ? a + "|" + b : b + "|" + a;
      if (seen[k]) return;
      seen[k] = 1; out.push([a, b]);
    }
    if (isObj(nodes)) {
      for (var id in nodes) {
        var nd = nodes[id];
        if (!nd || !nd.next || !nd.next.length) continue;
        for (var i = 0; i < nd.next.length; i++) {
          var nx = nodes[nd.next[i]];
          if (nx) add(nd.loc, nx.loc);
        }
      }
    }
    if (!out.length) {
      var ks = []; for (var k2 in places) ks.push(k2);
      for (var j = 0; j < ks.length - 1; j++) add(ks[j], ks[j + 1]);
    }
    return out;
  }

  /* ───────────────────────────── 场景构建 ───────────────────────────── */

  function scaleUV(geo, ur, vr) {
    var uv = geo.attributes.uv;
    if (!uv) return;
    var a = uv.array;
    for (var i = 0; i < a.length; i += 2) { a[i] *= ur; a[i + 1] *= vr; }
    uv.needsUpdate = true;
  }

  function buildScene(inst) {
    var T = inst.T, opts = inst.opts, places = opts.places, nodes = opts.nodes;
    var renderer = inst.renderer;

    var scene = new T.Scene();
    scene.background = new T.Color(0x07070c);
    scene.fog = new T.Fog(0x121026, 24, 86);
    inst.scene = scene;

    /* ── 光照 ── */
    inst.amb = new T.AmbientLight(0xb9c2e8, 0.36);
    scene.add(inst.amb);
    inst.hemi = new T.HemisphereLight(0xddeeff, 0x68705c, 0.30);
    scene.add(inst.hemi);
    inst.sun = new T.DirectionalLight(0xfff2d6, 0.62);
    inst.sun.position.set(26, 46, 18);
    inst.sun.castShadow = true;
    var sc = inst.sun.shadow;
    sc.mapSize.width = 1024; sc.mapSize.height = 1024;
    sc.camera.left = -27; sc.camera.right = 27;
    sc.camera.top = 27; sc.camera.bottom = -27;
    sc.camera.near = 1; sc.camera.far = 140;
    sc.bias = -0.0012;
    sc.normalBias = 0.02;
    scene.add(inst.sun);
    scene.add(inst.sun.target);
    inst.fill = new T.DirectionalLight(0x6d7cff, 0.20);
    inst.fill.position.set(-24, 16, -20);
    scene.add(inst.fill);

    /* ── 主相机：正交 + 等距机位 ── */
    var cam = new T.OrthographicCamera(-12, 12, 8, -8, 0.1, 420);
    cam.up.set(0, 1, 0);
    cam.zoom = 1;
    cam.position.set(38, 38, 38);
    cam.lookAt(0, CAM_TARGET_Y, 0);
    cam.updateProjectionMatrix();
    inst.camera = cam;

    /* ── 天空（渐变球，纯装饰） ── */
    try {
      var skyCv = document.createElement("canvas");
      skyCv.width = 8; skyCv.height = 160;
      var sg = skyCv.getContext("2d");
      if (sg) {
        var grd = sg.createLinearGradient(0, 0, 0, 160);
        grd.addColorStop(0, "#152c43"); grd.addColorStop(0.5, "#071421"); grd.addColorStop(1, "#04040a");
        sg.fillStyle = grd; sg.fillRect(0, 0, 8, 160);
        var skyTex = new T.CanvasTexture(skyCv); skyTex.needsUpdate = true;
        var sky = new T.Mesh(
          new T.SphereGeometry(200, 24, 16),
          new T.MeshBasicMaterial({ map: skyTex, side: T.BackSide, fog: false, depthWrite: false })
        );
        sky.renderOrder = -10;
        sky.frustumCulled = false;
        scene.add(sky);
        inst.sky = sky; sky.visible = false;
      }
    } catch (eSky) { inst.sky = null; }

    /* ── 地面（圆角矩形，贴合 800×520 映射范围；Shape 的 y 经 rotateX(-90°) 落到 -z，故取对称范围） ── */
    var gCv = makeGroundCanvas();
    if (!gCv) throw new Error("ground canvas unavailable");
    var gTex = newTex(T, gCv, 9, 7);
    gTex.anisotropy = aniso(renderer);
    var minX = -36, maxX = 36, minZ = -28, maxZ = 28, rad = 0.2;
    var shape = new T.Shape();
    shape.moveTo(minX + rad, minZ);
    shape.lineTo(maxX - rad, minZ); shape.quadraticCurveTo(maxX, minZ, maxX, minZ + rad);
    shape.lineTo(maxX, maxZ - rad); shape.quadraticCurveTo(maxX, maxZ, maxX - rad, maxZ);
    shape.lineTo(minX + rad, maxZ); shape.quadraticCurveTo(minX, maxZ, minX, maxZ - rad);
    shape.lineTo(minX, minZ + rad); shape.quadraticCurveTo(minX, minZ, minX + rad, minZ);
    var gGeo = new T.ShapeGeometry(shape, 10);
    gGeo.rotateX(-Math.PI / 2);
    var ground = new T.Mesh(gGeo, new T.MeshLambertMaterial({ map: gTex, color: 0xffffff }));
    ground.position.y = -0.03;
    ground.receiveShadow = true;
    scene.add(ground);
    inst.ground = ground;

    // 地块发光描边
    try {
      var pts = shape.getPoints(56), v3 = [];
      for (var pi = 0; pi < pts.length; pi++) v3.push(new T.Vector3(pts[pi].x, 0.012, -pts[pi].y));
      var edge = new T.LineLoop(
        new T.BufferGeometry().setFromPoints(v3),
        new T.LineBasicMaterial({ color: 0x38dce8, transparent: true, opacity: 0.75, fog: false })
      );
      edge.frustumCulled = false;
      scene.add(edge);
      inst.edge = edge; edge.visible = false;
    } catch (eEdge) { inst.edge = null; }

    /* ── 地点 → 世界坐标 + 分组（几何 + 材质 合批） ── */
    var keys = [];
    for (var ik in places) if (isObj(places[ik])) keys.push(ik);

    var groups = {};
    for (var i = 0; i < keys.length; i++) {
      var id = keys[i], d = places[id];
      var layout = CITY_LAYOUT[id];
      var h = layout ? layout[4] : heightOf(id);
      var p = {
        id: id, data: d,
        name: d && d.n ? String(d.n) : id,
        color: toHex(d && d.c, 0x8fa0ff),
        wx: layout ? layout[0] : (num(d.x, CX) - CX) / SX,
        wz: layout ? layout[1] : (num(d.y, CY) - CY) / SZ,
        h: h,
        w: layout ? layout[2] : 1.4,
        dp: layout ? layout[3] : 1.4,
        style: (id === "office" || id === "capital") ? 1 : 0,
        bucket: h <= 3 ? 0 : (h === 4 ? 1 : 2),
        state: "locked", nodeId: null, tintHex: undefined,
        lift: 0, raise: 0, raiseT: 0, shakeAmp: 0, phase: rand01(id + "|p") * 6.283,
        batch: null, idx: 0, roofBatch: null, roofIdx: 0, gkey: 0, padIdx: 0, ring: null, beacon: null
      };
      inst.places[id] = p;
      inst.order.push(id);
      // 一层贴图 = 一层楼，按高度选密度档
      p.rep = Math.max(1, Math.round(p.h * 2.5));
      var gk = p.style * 3 + p.bucket;
      if (!groups[gk]) groups[gk] = { style: p.style, bucket: p.bucket, rep: p.rep, list: [] };
      groups[gk].list.push(p);
    }
    if (!inst.order.length) throw new Error("no places");
    inst.groups = groups;

    /* ── 墙面材质：风格(2) × 状态(3) 共 6 套 ──
     *   贴图为中性灰，实际楼体颜色 = 贴图明度 × 该地点主题色（instanceColor）
     *   normal : 常规        done : 保持实体轮廓，通过色彩区分完成状态
     *   avail  : 自发光 emissiveIntensity 0.35（emissive 取该地点主题色，色系一致）
     */
    var wallMats = [], wallTex = [];
    for (var s = 0; s < 2; s++) {
      var wcv = makeWallCanvas(s);
      if (!wcv) throw new Error("wall canvas unavailable");
      var wt = newTex(T, wcv, 1, 1);
      wt.anisotropy = aniso(renderer);
      wallTex.push(wt);
      wallMats.push({
        normal: new T.MeshLambertMaterial({ map: wt, color: 0xffffff }),
        done: new T.MeshLambertMaterial({ map: wt, color: 0xffffff, transparent: true, opacity: 1 }),
        avail: new T.MeshLambertMaterial({ map: wt, color: 0xffffff, emissive: 0x8fa0ff, emissiveIntensity: 0.06 })
      });
    }
    inst.wallMats = wallMats;
    inst.wallTex = wallTex;

    /* ── 建筑：按「几何 + 材质 + 状态」InstancedMesh 合批 ── */
    var BSTATES = ["normal", "done", "avail"];
    var pickables = [];
    var gkKeys = Object.keys(groups);
    for (var bi = 0; bi < gkKeys.length; bi++) {
      var grp = groups[gkKeys[bi]];
      grp.key = gkKeys[bi];
      var geo = new T.BoxGeometry(1, 1, 1);
      scaleUV(geo, 3, grp.rep);                    // 竖向平铺 rep 层
      grp.geo = geo;
      grp.batches = {};
      for (var si = 0; si < BSTATES.length; si++) {
        var stName = BSTATES[si];
        var cap = grp.list.length;
        var im = new T.InstancedMesh(geo, wallMats[grp.style][stName], cap);
        im.castShadow = (stName === "normal");
        im.receiveShadow = true;
        im.frustumCulled = false;
        im.count = 0;
        im.visible = false;
        im.userData = { kind: "wall", state: stName, used: 0, group: grp.key };
        if (T.DynamicDrawUsage) im.instanceMatrix.setUsage(T.DynamicDrawUsage);
        for (var z = 0; z < cap; z++) { try { im.setColorAt(z, new T.Color(0xffffff)); } catch (eC) {} }
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        scene.add(im);
        grp.batches[stName] = im;
        inst.batches.push(im);
        pickables.push(im);
      }
      for (var j = 0; j < grp.list.length; j++) grp.list[j].gkey = gkKeys[bi];
    }

    /* ── 屋顶板（同样按状态分 3 批，保证 done 实体 / avail 发光一致） ── */
    var rCv = makeRoofCanvas();
    if (rCv) {
      var rTex = newTex(T, rCv, 1, 1);
      rTex.anisotropy = aniso(renderer);
      inst.roofMat = new T.MeshLambertMaterial({ map: rTex, color: 0xffffff });
      inst.roofBatches = {};      for (var rs = 0; rs < BSTATES.length; rs++) {
        var rst = BSTATES[rs];
        var rmat = new T.MeshLambertMaterial({
          map: rTex, color: 0xffffff,
          transparent: false, opacity: 1,
          emissive: (rst === "avail" ? 0x8fa0ff : 0x000000), emissiveIntensity: (rst === "avail" ? 0.35 : 0)
        });
        var roof = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), rmat, inst.order.length);
        roof.castShadow = false;          // 屋顶不投影（省一次深度绘制）
        roof.receiveShadow = true;
        roof.frustumCulled = false;
        roof.count = 0;
        roof.visible = false;
        roof.userData = { kind: "roof", state: rst, used: 0 };
        if (T.DynamicDrawUsage) roof.instanceMatrix.setUsage(T.DynamicDrawUsage);
        for (var rr2 = 0; rr2 < inst.order.length; rr2++) { try { roof.setColorAt(rr2, new T.Color(0xffffff)); } catch (eR) {} }
        if (roof.instanceColor) roof.instanceColor.needsUpdate = true;
        scene.add(roof);
        inst.roofBatches[rst] = roof;
        inst.batches.push(roof);
      }
    }

    /* ── 地点基座（方垫，主题色微光） ── */
    var pad = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), new T.MeshLambertMaterial({ color: 0xffffff }), inst.order.length);
    pad.receiveShadow = true;
    pad.frustumCulled = false;
    for (var k3 = 0; k3 < inst.order.length; k3++) {
      var pq = inst.places[inst.order[k3]];
      pq.padIdx = k3;
      try { pad.setColorAt(k3, new T.Color(pq.color).multiplyScalar(0.13)); } catch (eP) {}
    }
    if (pad.instanceColor) pad.instanceColor.needsUpdate = true;
    scene.add(pad);
    inst.pad = pad;
    inst.padMat = pad.material;
    buildCityDistrict(inst);

    /* ── 标签 Sprite + avail 光环 + 光柱 ── */
    var labelGroup = new T.Group();
    for (var li = 0; li < inst.order.length; li++) {
      var lp = inst.places[inst.order[li]];
      makeLabel(inst, lp);
      lp.label.position.set(lp.wx, lp.h + 0.55, lp.wz);
      labelGroup.add(lp.label);

      var ring = new T.Mesh(
        new T.RingGeometry(0.90, 1.00, 40),
        new T.MeshBasicMaterial({ color: lp.color, transparent: true, opacity: 0.0, side: T.DoubleSide, depthWrite: false, fog: false, blending: T.AdditiveBlending })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(lp.wx, 0.05, lp.wz);
      ring.visible = false;
      ring.renderOrder = 5;
      ring.frustumCulled = false;
      scene.add(ring);
      lp.ring = ring;

      var beacon = new T.Mesh(
        new T.CylinderGeometry(0.075, 0.075, 1, 8),
        new T.MeshBasicMaterial({ color: lp.color, transparent: true, opacity: 0.0, depthWrite: false, fog: false, blending: T.AdditiveBlending })
      );
      beacon.position.set(lp.wx, lp.h + 0.95, lp.wz);
      beacon.visible = false;
      beacon.renderOrder = 6;
      beacon.frustumCulled = false;
      scene.add(beacon);
      lp.beacon = beacon;
    }
    scene.add(labelGroup);
    inst.labelGroup = labelGroup;

    /* ── 夜景窗光（night / dark 时点亮） ── */
    var winList = [];
    for (var wi = 0; wi < inst.order.length; wi++) {
      var wp = inst.places[inst.order[wi]];
      var cnt = 7 + (hash32(wp.id + "|win") % 6);
      for (var q = 0; q < cnt; q++) {
        var sd = wp.id + "|" + q;
        winList.push({
          p: wp,
          face: hash32(sd + "f") % 4,
          y: 0.5 + rand01(sd + "y") * Math.max(0.4, wp.h - 1.2),
          lat: (rand01(sd + "x") - 0.5) * 0.62
        });
      }
    }
    if (winList.length) {
      var win = new T.InstancedMesh(
        new T.PlaneGeometry(1, 1),
        new T.MeshBasicMaterial({ color: 0xffdf9a, transparent: true, opacity: 0.92, fog: false, depthWrite: false, side: T.DoubleSide }),
        winList.length
      );
      win.frustumCulled = false;
      win.visible = false;
      for (var wj = 0; wj < winList.length; wj++) {
        var o = winList[wj], op = o.p;
        var px, pz, rot;
        if (o.face === 0) { px = op.wx + op.w / 2 + 0.014; pz = op.wz + o.lat * op.dp; rot = Math.PI / 2; }
        else if (o.face === 1) { px = op.wx - op.w / 2 - 0.014; pz = op.wz + o.lat * op.dp; rot = -Math.PI / 2; }
        else if (o.face === 2) { px = op.wx + o.lat * op.w; pz = op.wz + op.dp / 2 + 0.014; rot = 0; }
        else { px = op.wx + o.lat * op.w; pz = op.wz - op.dp / 2 - 0.014; rot = Math.PI; }
        _q0.setFromAxisAngle(_axisY, rot);
        _m4.compose(_v3.set(px, o.y, pz), _q0, _v3b.set(0.18, 0.14, 1));
        win.setMatrixAt(wj, _m4);
      }
      win.instanceMatrix.needsUpdate = true;
      scene.add(win);
      inst.winMesh = win;
    }

    /* 基座矩阵（建筑/屋顶矩阵由 refresh 分配批次时写入） */
    for (var mx2 = 0; mx2 < inst.order.length; mx2++) {
      var mp = inst.places[inst.order[mx2]];
      _m4.compose(_v3.set(mp.wx, -0.015, mp.wz), _q0b, _v3b.set(mp.w + 0.5, 0.06, mp.dp + 0.5));
      inst.pad.setMatrixAt(mp.padIdx, _m4);
    }
    inst.pad.instanceMatrix.needsUpdate = true;
    inst.pickables = pickables;

    /* ── 小地图相机（第二个正交相机，俯视全区）
     *     刻意贴近地面（y=30）以避开雾区，否则小地图会被雾整片糊掉 ── */
    var mmCam = new T.OrthographicCamera(-MM_HALF, MM_HALF, MM_HALF, -MM_HALF, 0.1, 300);
    mmCam.position.set(0, 30, 0);
    mmCam.up.set(0, 0, -1);                 // 世界 +Z ↦ 屏幕下方，与 2D 沙盘方向一致
    mmCam.lookAt(0, 0, 0);
    mmCam.updateProjectionMatrix();
    inst.mm = mmCam;

    /* ── 小地图外框（DOM，pointer-events:none） ── */
    try {
      if (global.getComputedStyle) {
        var cs = global.getComputedStyle(inst.el);
        if (cs && cs.position === "static") inst.el.style.position = "relative";
      }
      var frame = document.createElement("div");
      frame.setAttribute("data-map3d-hud", "1");
      var fst = frame.style;
      fst.position = "absolute";
      fst.right = (MM_MARGIN - 1) + "px";
      fst.bottom = (MM_MARGIN - 1) + "px";
      fst.width = MM_SIZE + "px";
      fst.height = MM_SIZE + "px";
      fst.border = "1px solid rgba(140,150,230,.55)";
      fst.boxShadow = "0 0 14px rgba(60,70,160,.5) inset";
      fst.borderRadius = "3px";
      fst.pointerEvents = "none";
      fst.zIndex = "3";
      fst.background = "rgba(5,5,12,.35)";
      var tag = document.createElement("div");
      tag.textContent = "全 区 图";
      tag.style.cssText = "position:absolute;left:0;top:-14px;font:600 9px/1 'Noto Sans SC','Microsoft YaHei',sans-serif;color:rgba(162,170,232,.85);letter-spacing:1px";
      frame.appendChild(tag);
      var hint = document.createElement("div");
      hint.textContent = "拖拽旋转 · 滚轮缩放";
      hint.style.cssText = "position:absolute;left:-20px;bottom:-15px;width:160px;text-align:center;font:500 9px/1 'Noto Sans SC','Microsoft YaHei',sans-serif;color:rgba(130,136,190,.7)";
      frame.appendChild(hint);
      inst.el.appendChild(frame);
      inst.mmFrame = frame;
    } catch (eFrame) { inst.mmFrame = null; }
  }

  var _q0b = null;

  var CITY_LAYOUT = {
    rent: [-9,-6,2.6,1.8,2.0], capital: [-3,-6,1.9,1.8,4.6],
    office: [-9,0,2.2,2.0,3.8], library: [-3,0,2.9,2.1,1.1],
    park: [3,0,4.4,4.4,0.03], boxing: [9,0,2.6,1.9,1.4],
    bar: [-3,6,2.5,1.7,1.0], ktv: [3,6,2.4,2.0,1.7], alley: [9,6,1.8,2.0,1.8]
  };
  var CITY_COLORS = {rent:0xd6c8ac,capital:0x8eabb9,office:0x779eaf,library:0xd7d5c9,park:0x55794b,boxing:0xc7b8a5,bar:0xb9b1a3,ktv:0xc8c4b8,alley:0xc1c2b8};

  /** Continuous city blocks with batched streets, architecture, planting and traffic. */
  function buildCityDistrict(inst) {
    var T=inst.T, scene=inst.scene, box=new T.BoxGeometry(1,1,1);
    var foliageGeo=new T.IcosahedronGeometry(1,2), buckets={}, meshes=[];
    var concrete=new T.MeshLambertMaterial({color:0x8f948c});
    var roof=new T.MeshLambertMaterial({color:0x777f7c});
    var dark=new T.MeshLambertMaterial({color:0x3d5159});
    var glass=new T.MeshLambertMaterial({color:0x819ca5,map:inst.wallTex[1]});
    var masonry=new T.MeshLambertMaterial({color:0xcac4b6,map:inst.wallTex[0]});
    var brick=new T.MeshLambertMaterial({color:0xae9b85,map:inst.wallTex[0]});
    var pale=new T.MeshLambertMaterial({color:0xc0c5bd,map:inst.wallTex[0]});
    var asphalt=new T.MeshLambertMaterial({color:0x454d50});
    var sidewalk=new T.MeshLambertMaterial({color:0x8f958c});
    var white=new T.MeshLambertMaterial({color:0xe3dfc9});
    var yellow=new T.MeshLambertMaterial({color:0xd0bd70});
    var grass=new T.MeshLambertMaterial({color:0x4e713e});
    var bark=new T.MeshLambertMaterial({color:0x665e49});
    var leaves=[0x35553a,0x526d3b,0x426538].map(function(c){return new T.MeshLambertMaterial({color:c});});
    var water=new T.MeshPhongMaterial({color:0x669baf,shininess:65,specular:0xa3c8cc});
    var carMats=[0xe5dbbc,0x637f8b,0xb8624e,0x303c44].map(function(c){return new T.MeshLambertMaterial({color:c});});
    function part(parent,mat,x,y,z,w,h,d,geo,angle){
      geo=geo||box; var key=parent.uuid+mat.uuid+geo.uuid;
      var batch=buckets[key]||(buckets[key]={parent:parent,material:mat,geometry:geo,matrices:[]});
      var q=new T.Quaternion();if(angle)q.setFromAxisAngle(new T.Vector3(0,1,0),angle);
      batch.matrices.push(new T.Matrix4().compose(new T.Vector3(x,y,z),q,new T.Vector3(w,h,d)));
    }
    function tree(x,z,scale){
      scale=scale||1;part(scene,bark,x,0.32*scale,z,0.06*scale,0.65*scale,0.06*scale);
      part(scene,leaves[hash32(x+'t'+z)%3],x,0.79*scale,z,0.38*scale,0.48*scale,0.38*scale,foliageGeo);
      part(scene,leaves[hash32(z+'b'+x)%3],x+0.15*scale,0.73*scale,z+0.12*scale,0.28*scale,0.32*scale,0.28*scale,foliageGeo);
    }
    function building(parent,x,z,w,d,h,style,seed){
      var mat=style?glass:([masonry,brick,pale][hash32(seed)%3]);
      part(parent,mat,x,h/2+0.08,z,w,h,d);
      part(parent,roof,x,h+0.1,z,w+0.1,0.14,d+0.1);
      part(parent,concrete,x,0.12,z,w+0.15,0.20,d+0.15);
      // Setback rooftop floor, mechanical equipment and parapets.
      part(parent,dark,x+0.15,h+0.27,z-0.13,w*0.45,0.22,d*0.40);
      for(var a=0;a<3;a++) part(parent,concrete,x-w*0.28+a*w*0.22,h+0.24,z+d*0.25,0.21,0.15,0.23);
      part(parent,concrete,x,h+0.20,z-d/2,w+0.06,0.14,0.05);
      part(parent,concrete,x,h+0.20,z+d/2,w+0.06,0.14,0.05);
      if(style && h>2.3){
        part(parent,glass,x,h+0.34,z,w*0.72,0.6,d*0.72);
        part(parent,roof,x,h+0.68,z,w*0.75,0.07,d*0.75);
      }
      if(!style && h<2.0){
        part(parent,dark,x,0.28,z+d/2+0.035,w*0.70,0.32,0.055);
        part(parent,seed.length%2?brick:white,x,0.49,z+d/2+0.14,w*0.8,0.075,0.26);
      }
      // Floor bands give residential and commercial blocks a readable scale.
      for(var floor=0.45;floor<h;floor+=0.46)part(parent,style?dark:concrete,x,floor,z,w+0.025,0.035,d+0.025);
    }
    // Roads extend beyond the viewport, with curbs, centre lines and crossings.
    for(var axis=-18;axis<=18;axis+=6){
      part(scene,sidewalk,axis,0.008,0,1.48,0.08,36);
      part(scene,asphalt,axis,0.055,0,1.05,0.015,36);
      part(scene,sidewalk,0,0.009,axis,40,0.08,1.48);
      part(scene,asphalt,0,0.057,axis,40,0.015,1.05);
      for(var lane=-19;lane<20;lane+=0.65){
        if(Math.abs((lane+3)%6-3)<0.85)continue;
        part(scene,yellow,axis,0.068,lane,0.025,0.007,0.28);
        part(scene,white,lane,0.071,axis,0.28,0.007,0.025);
      }
      for(var cross=-18;cross<=18;cross+=6){
        for(var stripe=-0.36;stripe<=0.36;stripe+=0.14){
          part(scene,white,axis+stripe,0.077,cross+0.72,0.08,0.008,0.28);
          part(scene,white,axis+0.72,0.077,cross+stripe,0.28,0.008,0.08);
        }
      }
    }
    // Neighbourhood blocks: the playable landmarks occupy real plots among other buildings.
    // Street grid shifted in Z so landmarks are at block centres.
    // Landmarks use Z=-6,0,6; shift the road batches three units in Z below.
    Object.keys(buckets).forEach(function(k){var b=buckets[k];if(b.material===asphalt||b.material===sidewalk||b.material===yellow||b.material===white)b.matrices.forEach(function(m){m.elements[14]+=3;});});
    for(var x=-15;x<=15;x+=6){for(var z=-12;z<=12;z+=6){
      var occupied=null; inst.order.forEach(function(id){var p=inst.places[id];if(Math.abs(p.wx-x)<0.2&&Math.abs(p.wz-z)<0.2)occupied=id;});
      part(scene,sidewalk,x,0.012,z,4.54,0.08,4.54);
      if(occupied==='park')continue;
      var seed=x+'block'+z;
      if(!occupied){
        building(scene,x-1.0,z-0.9,1.45,1.60,1.3+rand01(seed)*2.2,hash32(seed)%2,seed);
        building(scene,x+0.9,z+0.85,1.75,1.45,1.1+rand01(seed+'2')*1.8,hash32(seed+'2')%2,seed);
        building(scene,x+1.1,z-1.15,1.0,1.2,0.55+rand01(seed+'3')*0.9,0,seed);
      }else{
        building(scene,x-1.35,z-1.6,1.1,0.72,0.65,0,seed);
        part(scene,dark,x+1.35,0.07,z-1.55,0.9,0.018,0.8);
        for(var pk=0;pk<3;pk++)part(scene,white,x+1.05+pk*0.25,0.084,z-1.55,0.018,0.005,0.7);
      }
      for(var ti=0;ti<3;ti++){tree(x-1.85+ti*1.75,z+2.05,0.65);}
      tree(x-2.05,z-1.25,0.8);
      part(scene,grass,x-2.02,0.069,z,0.20,0.07,3.6);
      part(scene,grass,x,0.069,z+2.07,3.65,0.07,0.22);
      for(var shrubs=0;shrubs<6;shrubs++)part(scene,leaves[1],x-1.8+shrubs*0.66,0.16,z+2.08,0.28,0.15,0.13,foliageGeo);
    }}
    // Landmark-specific forms follow original hover/state movement.
    inst.order.forEach(function(id){
      var p=inst.places[id],g=new T.Group();scene.add(g);p.detail=g;g.position.set(p.wx,0,p.wz);
      if(id==='park')return;
      part(g,roof,0,p.h+0.16,0,p.w+0.13,0.14,p.dp+0.13);
      part(g,dark,0,p.h+0.34,0,p.w*0.40,0.25,p.dp*0.38);
      for(var j=0;j<3;j++)part(g,concrete,-p.w*0.28+j*0.25,p.h+0.29,p.dp*0.25,0.18,0.12,0.22);
      part(g,concrete,0,0.12,0,p.w+0.18,0.22,p.dp+0.18);
      for(var floor=0.5;floor<p.h;floor+=0.46)part(g,(id==='capital'||id==='office')?dark:concrete,0,floor,0,p.w+0.03,0.035,p.dp+0.03);
      part(g,dark,0,0.35,p.dp/2+0.04,p.w*0.40,0.43,0.08);
      if(id==='office')building(g,1.3,-0.2,0.7,1.5,p.h*0.63,1,id);
      if(id==='capital')part(g,glass,0,p.h+0.5,0,p.w*0.72,0.7,p.dp*0.72);
      if(id==='library'){part(g,concrete,0,0.3,p.dp/2+0.3,p.w+0.4,0.2,0.5);for(var c=-1;c<=1;c++)part(g,concrete,c*0.9,0.6,p.dp/2+0.22,0.10,0.8,0.1);}
      if(id==='bar'||id==='ktv')part(g,yellow,0,0.65,p.dp/2+0.08,p.w*0.64,0.18,0.06);
    });
    // Central garden: a looping promenade, pond, lawns, trees and seating.
    part(scene,grass,3,0.10,0,4.48,0.12,4.48);
    function path(points,width,material,y){
      var curve=new T.CatmullRomCurve3(points.map(function(p){return new T.Vector3(p[0],y,p[1]);}));
      var mesh=new T.Mesh(new T.TubeGeometry(curve,80,width,6,false),material);scene.add(mesh);mesh.receiveShadow=true;
    }
    path([[1.4,-1.8],[2.1,-1],[3.5,-0.6],[4.4,0.2],[3.8,1.4],[2.2,1.65],[1.3,0.6],[1.4,-1.8]],0.11,white,0.15);
    path([[0.8,0.0],[2,0.25],[3.2,-0.2],[4.2,-1],[5.2,-1]],0.09,white,0.15);
    var pond=new T.Mesh(new T.CircleGeometry(0.70,48),water);pond.rotation.x=-Math.PI/2;pond.position.set(3.9,0.17,0.8);pond.scale.set(1,0.70,1);scene.add(pond);
    for(var t=0;t<35;t++){var tx=1.05+rand01('parkx'+t)*3.9,tz=-2+rand01('parkz'+t)*4;if(hypot(tx-3.9,tz-0.8)<0.9)continue;tree(tx,tz,0.75+rand01('parks'+t)*0.45);}
    for(var bench=0;bench<4;bench++){part(scene,bark,1.4+bench*0.85,0.24,1.95,0.4,0.10,0.17);part(scene,dark,1.4+bench*0.85,0.15,1.95,0.3,0.18,0.04);}
    // Cars and street lights introduce a human scale.
    for(var car=0;car<30;car++){
      var axis=-12+(car%5)*6, along=-14+rand01('car'+car)*28;
      var mat=carMats[car%4];
      if(car%2){part(scene,mat,axis+0.27,0.16,along,0.22,0.18,0.46);part(scene,dark,axis+0.27,0.27,along,0.20,0.09,0.24);}
      else{part(scene,mat,along,0.16,axis+3.27,0.46,0.18,0.22);part(scene,dark,along,0.27,axis+3.27,0.24,0.09,0.20);}
    }
    for(var lx=-12;lx<=12;lx+=6)for(var lz=-10;lz<14;lz+=3){part(scene,dark,lx+0.65,0.45,lz,0.035,0.9,0.035);part(scene,white,lx+0.57,0.91,lz,0.19,0.055,0.08);}
    Object.keys(buckets).forEach(function(k){var b=buckets[k],m=new T.InstancedMesh(b.geometry,b.material,b.matrices.length);b.matrices.forEach(function(matrix,i){m.setMatrixAt(i,matrix);});m.castShadow=b.material!==asphalt&&b.material!==sidewalk&&b.material!==white&&b.material!==yellow;m.receiveShadow=true;m.frustumCulled=false;b.parent.add(m);meshes.push(m);});
    inst.cityMeshes=meshes;
    // A compact district legend, outside the interaction layer.
    var legend=document.createElement('div');legend.setAttribute('data-map3d-hud','1');
    legend.style.cssText='position:absolute;left:24px;top:22px;pointer-events:none;color:#fff;text-shadow:0 2px 8px #243238;font-family:Microsoft YaHei,sans-serif;padding:12px 16px;background:linear-gradient(100deg,rgba(19,31,34,.70),rgba(19,31,34,0));border-left:2px solid #cfbf84';
    legend.innerHTML='<div style="font-size:11px;letter-spacing:4px;opacity:.8">RESTART · CITY DISTRICT</div><div style="font-size:25px;font-weight:700;letter-spacing:3px;margin:5px 0">重启人生 · 城市漫游</div><div style="font-size:11px;opacity:.85">● 金色标记可前往　 ·　拖拽旋转 / 滚轮缩放</div>';
    inst.el.appendChild(legend); inst.cityLegend = legend;
  }

  function aniso(renderer) {
    try {
      if (renderer && renderer.capabilities && isFn(renderer.capabilities.getMaxAnisotropy)) {
        return Math.min(4, renderer.capabilities.getMaxAnisotropy());
      }
    } catch (e) {}
    return 1;
  }

  /** 写建筑实例矩阵（含 avail 抬高 / 悬停微抬 / 非 avail 抖动） */
  function writeBuildingMatrix(inst, p) {
    if (!p.batch) return;
    var sx = 0, sz = 0;
    if (p.shakeAmp > 0.001) {
      sx = Math.sin(inst.t * 47) * 0.11 * p.shakeAmp;
      sz = Math.cos(inst.t * 39) * 0.06 * p.shakeAmp;
    }
    var dy = p.id === "park" ? 0 : p.raise + p.lift * 0.06;
    if (p.detail) p.detail.position.set(p.wx + sx, dy, p.wz + sz);             // raise：avail 整体抬高 0.35
    _q0.identity();
    _m4.compose(
      _v3.set(p.wx + sx, p.h / 2 + dy, p.wz + sz),
      _q0,
      _v3b.set(p.w, p.h, p.dp)
    );
    p.batch.setMatrixAt(p.idx, _m4);
    p.batch.instanceMatrix.needsUpdate = true;

    if (p.roofBatch) {
      _m4.compose(_v3.set(p.wx + sx, p.h + 0.045 + dy, p.wz + sz), _q0, _v3b.set(p.w + 0.06, 0.11, p.dp + 0.06));
      p.roofBatch.setMatrixAt(p.roofIdx, _m4);
      p.roofBatch.instanceMatrix.needsUpdate = true;
    }
  }

  /** 楼体颜色：地点主题色，降饱和 ~20% + 按状态压暗/提亮（提亮后裁顶，避免色相偏移） */
  function placeTint(T, p, state) {
    var c = new T.Color(CITY_COLORS[p.id] || 0xb7b6b0);
    var l = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    c.lerp(new T.Color(l, l, l), 0.20);          // 降饱和 20%（15%~30% 区间内）
    if (state === "done") c.multiplyScalar(0.88);      // done：压暗
    else if (state === "locked") c.multiplyScalar(0.82); // locked：灰暗
    else c.multiplyScalar(1.02);                        // avail：提亮
    return capColor(c);
  }

  /** 屋顶描边颜色：同色系（更暗更灰，避免抢主体） */
  function roofTint(T, p, state) {
    var c = new T.Color(CITY_COLORS[p.id] || 0xb7b6b0);
    var l = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    c.lerp(new T.Color(l, l, l), 0.32);
    if (state === "done") c.multiplyScalar(0.62);
    else if (state === "locked") c.multiplyScalar(0.70);
    else c.multiplyScalar(1.02);
    return capColor(c);
  }

  /** 单通道超过 1 时整体等比缩回，保持色相不变 */
  function capColor(c) {
    var m = Math.max(c.r, c.g, c.b);
    if (m > 1) { c.r /= m; c.g /= m; c.b /= m; }
    return c;
  }

  /* ───────────────────────────── 状态 / refresh ───────────────────────────── */

  function setPlaceState(inst, p, state, nodeId) {
    var changed = (p.state !== state || p.nodeId !== nodeId);
    p.state = state;
    p.nodeId = nodeId || null;
    p.raiseT = 0;     // 可玩地点整体抬高 0.35
    if (changed) drawLabel(p);
    var on = state === "avail";
    if (p.ring) p.ring.visible = on || state === "done";
    if (p.beacon) p.beacon.visible = on;
  }

  /** 按状态把每个实例分配进对应批次，并刷新颜色 / 自发光色 */
  function rebuildBatches(inst) {
    var T = inst.T, k;
    for (k = 0; k < inst.batches.length; k++) inst.batches[k].userData.used = 0;

    var availColorByStyle = {}, availColorRoof = null;
    for (k = 0; k < inst.order.length; k++) {
      var p = inst.places[inst.order[k]];
      var grp = inst.groups[p.gkey];
      if (!grp || !grp.batches) continue;

      var b = grp.batches[p.state] || grp.batches.normal;
      var idx = b.userData.used++;
      p.batch = b; p.idx = idx;
      writeBuildingMatrix(inst, p);
      var tint = placeTint(T, p, p.state);
      p.tintHex = tint.getHex();
      try { b.setColorAt(idx, tint); } catch (e1) {}

      if (inst.roofBatches) {
        var rb = inst.roofBatches[p.state] || inst.roofBatches.normal;
        var ridx = rb.userData.used++;
        p.roofBatch = rb; p.roofIdx = ridx;
        _q0.identity();
        _m4.compose(_v3.set(p.wx, p.h + 0.045 + p.raise, p.wz), _q0, _v3b.set(p.w + 0.06, 0.11, p.dp + 0.06));
        rb.setMatrixAt(ridx, _m4);
        try { rb.setColorAt(ridx, roofTint(T, p, p.state)); } catch (e2) {}
      }

      if (p.state === "avail") {
        if (!availColorByStyle[p.style]) availColorByStyle[p.style] = p.color;
        if (availColorRoof === null) availColorRoof = p.color;
      }
    }

    // avail 批次的自发光取该风格第一个可玩地点的主题色（同色系）
    for (var s = 0; s < inst.wallMats.length; s++) {
      var am = inst.wallMats[s].avail;
      if (am && am.emissive) am.emissive.setHex(0x314653);
    }
    if (inst.roofBatches && inst.roofBatches.avail && inst.roofBatches.avail.material.emissive) {
      inst.roofBatches.avail.material.emissive.setHex(0x314653);
    }

    // 提交：count / visible / 脏标记
    for (k = 0; k < inst.batches.length; k++) {
      var bt = inst.batches[k];
      bt.count = bt.userData.used;
      bt.visible = bt.count > 0;
      bt.instanceMatrix.needsUpdate = true;
      if (bt.instanceColor) bt.instanceColor.needsUpdate = true;
    }
  }

  function refresh(inst, st) {
    if (inst === undefined || inst === null) inst = current;
    if (!inst || !inst.ready) return false;
    try {
      st = isObj(st) ? st : {};
      var nodes = isObj(inst.opts.nodes) ? inst.opts.nodes : null;

      var doneArr = st.done;
      if (typeof doneArr === "string" || typeof doneArr === "number") doneArr = [doneArr];
      if (!(doneArr instanceof Array)) doneArr = [];
      var doneSet = {}, i;
      for (i = 0; i < doneArr.length; i++) {
        if (doneArr[i] === null || doneArr[i] === undefined) continue;
        doneSet[String(doneArr[i])] = 1;
      }

      var av = st.avail;
      if (typeof av === "string" || typeof av === "number") av = [av];
      if (!(av instanceof Array)) av = [];
      var availByPlace = {};
      for (i = 0; i < av.length; i++) {
        var a = av[i];
        if (a === null || a === undefined || a === "") continue;
        a = String(a);
        var nd = nodes ? nodes[a] : null;
        if (nd && nd.loc && inst.places[nd.loc]) availByPlace[nd.loc] = a;
        else if (inst.places[a]) availByPlace[a] = a;   // 兼容：直接传 placeId
      }

      for (var k = 0; k < inst.order.length; k++) {
        var p = inst.places[inst.order[k]];
        var state = "locked", nid = null;
        if (availByPlace[p.id]) { state = "avail"; nid = availByPlace[p.id]; }
        else if (doneSet[p.id]) { state = "done"; }      // 兼容：done 里直接给 placeId
        else if (nodes) {
          var anyNode = false, anyDone = false;
          for (var id in nodes) {
            var nd2 = nodes[id];
            if (!nd2 || nd2.loc !== p.id) continue;
            anyNode = true;
            if (doneSet[id]) anyDone = true;
          }
          state = (anyNode && anyDone) ? "done" : "locked";
        }
        setPlaceState(inst, p, state, nid);
      }
      rebuildBatches(inst);
      return true;
    } catch (e) {
      try { if (global.console) global.console.warn("[Map3D] refresh failed:", e); } catch (e2) {}
      return false;
    }
  }

  /* ───────────────────────────── 氛围 setMood ───────────────────────────── */

  function snapshotMood(inst) {
    var m = MOODS[inst.moodKey] || MOODS[MOOD_FALLBACK];
    var T = inst.T;
    return {
      bg: new T.Color(m.bg), fog: new T.Color(m.fog),
      fogNear: m.fogNear, fogFar: m.fogFar,
      amb: m.amb, hemi: m.hemi,
      sun: new T.Color(m.sun), sunI: m.sunI,
      fill: new T.Color(m.fill), fillI: m.fillI,
      night: m.night, floor: (m.floor === undefined ? 0.05 : m.floor)
    };
  }

  function cloneMood(inst, m) {
    return {
      bg: m.bg.clone(), fog: m.fog.clone(), fogNear: m.fogNear, fogFar: m.fogFar,
      amb: m.amb, hemi: m.hemi, sun: m.sun.clone(), sunI: m.sunI,
      fill: m.fill.clone(), fillI: m.fillI, night: m.night,
      floor: (m.floor === undefined ? 0.05 : m.floor)
    };
  }

  function applyMood(inst, mood, hard) {
    try {
      var key = (typeof mood === "string" && MOODS[mood]) ? mood : MOOD_FALLBACK;
      inst.moodKey = key;
      inst.moodTo = snapshotMood(inst);
      if (hard) {
        inst.moodCur = cloneMood(inst, inst.moodTo);
        inst.moodFrom = cloneMood(inst, inst.moodTo);
        inst.moodT = 1;
        applyMoodValues(inst, inst.moodCur);
      } else {
        inst.moodFrom = inst.moodCur ? cloneMood(inst, inst.moodCur) : cloneMood(inst, inst.moodTo);
        inst.moodT = 0;
      }
      return true;
    } catch (e) { return false; }
  }

  function lerpC(out, a, b, k) {
    out.r = a.r + (b.r - a.r) * k;
    out.g = a.g + (b.g - a.g) * k;
    out.b = a.b + (b.b - a.b) * k;
    return out;
  }

  function applyMoodValues(inst, m) {
    var scene = inst.scene;
    if (!scene) return;
    if (scene.background && scene.background.isColor) scene.background.copy(m.bg);
    else scene.background = m.bg.clone();
    if (scene.fog) { scene.fog.color.copy(m.fog); scene.fog.near = m.fogNear; scene.fog.far = m.fogFar; }
    if (inst.amb) inst.amb.intensity = m.amb;
    if (inst.hemi) inst.hemi.intensity = m.hemi;
    if (inst.sun) { inst.sun.color.copy(m.sun); inst.sun.intensity = m.sunI; }
    if (inst.fill) { inst.fill.color.copy(m.fill); inst.fill.intensity = m.fillI; }
    if (inst.sky && inst.sky.material) {
      var c = inst.sky.material.color;
      c.setRGB(0.30 + m.fog.r * 0.85, 0.32 + m.fog.g * 0.85, 0.45 + m.fog.b * 0.85);
    }
    if (inst.winMesh) inst.winMesh.visible = !!m.night;
    if (inst.edge && inst.edge.material) inst.edge.material.opacity = m.night ? 0.8 : 0.5;
    applyLightFloor(inst, m);
  }

  /** 楼体最低亮度：以自发光下限抬黑，保证夜间/暗场建筑仍有轮廓（不动 avail 的主题色辉光） */
  function applyLightFloor(inst, m) {
    try {
      var fl = (m.floor === undefined) ? 0.05 : m.floor;
      var c = inst._floorCol || (inst._floorCol = new inst.T.Color());
      c.setRGB(fl, fl, fl * 1.15);
      var s;
      for (s = 0; s < inst.wallMats.length; s++) {
        if (inst.wallMats[s].normal) inst.wallMats[s].normal.emissive.copy(c);
        if (inst.wallMats[s].done) inst.wallMats[s].done.emissive.copy(c);
      }
      if (inst.roofBatches) {
        if (inst.roofBatches.normal) inst.roofBatches.normal.material.emissive.copy(c);
        if (inst.roofBatches.done) inst.roofBatches.done.material.emissive.copy(c);
      }
    } catch (e) {}
  }

  function stepMood(inst, dt) {
    if (!inst.moodFrom || !inst.moodTo || inst.moodT >= 1) return;
    inst.moodT = clamp(inst.moodT + dt / 0.7, 0, 1);
    var k = inst.moodT < 0.5 ? 2 * inst.moodT * inst.moodT : 1 - Math.pow(-2 * inst.moodT + 2, 2) / 2;
    var a = inst.moodFrom, b = inst.moodTo;
    var m = inst.moodCur || cloneMood(inst, a);
    lerpC(m.bg, a.bg, b.bg, k);
    lerpC(m.fog, a.fog, b.fog, k);
    m.fogNear = a.fogNear + (b.fogNear - a.fogNear) * k;
    m.fogFar = a.fogFar + (b.fogFar - a.fogFar) * k;
    m.amb = a.amb + (b.amb - a.amb) * k;
    m.hemi = a.hemi + (b.hemi - a.hemi) * k;
    lerpC(m.sun, a.sun, b.sun, k);
    m.sunI = a.sunI + (b.sunI - a.sunI) * k;
    lerpC(m.fill, a.fill, b.fill, k);
    m.fillI = a.fillI + (b.fillI - a.fillI) * k;
    m.night = k < 0.5 ? a.night : b.night;
    m.floor = (a.floor === undefined ? 0.05 : a.floor) + ((b.floor === undefined ? 0.05 : b.floor) - (a.floor === undefined ? 0.05 : a.floor)) * k;
    inst.moodCur = m;
    applyMoodValues(inst, m);
  }

  /* ───────────────────────────── 尺寸 / 相机 ───────────────────────────── */

  function measure(inst) {
    var el = inst.el, w = 0, h = 0;
    try { w = el.clientWidth || 0; h = el.clientHeight || 0; } catch (e) {}
    if ((!w || !h) && el.parentElement) {
      try { w = w || el.parentElement.clientWidth || 0; h = h || el.parentElement.clientHeight || 0; } catch (e2) {}
    }
    if (!w || !h) { w = w || MAP_W; h = h || MAP_H; }
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  function resize(inst, force) {
    try {
      var s = measure(inst);
      if (!force && s.w === inst.size.w && s.h === inst.size.h) return;
      inst.size = s;
      inst.renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
      inst.renderer.setSize(s.w, s.h, false);
      var cam = inst.camera;
      if (cam) {
        var aspect = s.w / s.h;
        // 同时容纳世界 X 全宽（±11）与 Z 全高（±8.2）
        var halfH = Math.max(10.4, 15.5 / aspect);
        var halfW = halfH * aspect;
        cam.left = -halfW; cam.right = halfW; cam.top = halfH; cam.bottom = -halfH;
        cam.updateProjectionMatrix();
      }
      if (inst.mm) inst.mm.updateProjectionMatrix();
    } catch (e) {}
  }

  function updateCamera(inst, dt) {
    var cam = inst.camera;
    if (!cam) return;
    var k = 1 - Math.exp(-dt * 9);
    inst.yaw += (inst.tYaw - inst.yaw) * k;
    inst.pitch += (inst.tPitch - inst.pitch) * k;
    inst.zoom += (inst.tZoom - inst.zoom) * k;
    if (Math.abs(inst.tYaw - inst.yaw) < 1e-4) inst.yaw = inst.tYaw;
    if (Math.abs(inst.tPitch - inst.pitch) < 1e-4) inst.pitch = inst.tPitch;
    if (Math.abs(inst.tZoom - inst.zoom) < 1e-4) inst.zoom = inst.tZoom;

    var cp = Math.cos(inst.pitch), sp = Math.sin(inst.pitch);
    cam.position.set(CAM_DIST * cp * Math.sin(inst.yaw), CAM_DIST * sp, CAM_DIST * cp * Math.cos(inst.yaw));
    cam.up.set(0, 1, 0);
    cam.lookAt(0, CAM_TARGET_Y, 0);
    if (Math.abs(cam.zoom - inst.zoom) > 1e-4) { cam.zoom = inst.zoom; cam.updateProjectionMatrix(); }
  }

  /* ───────────────────────────── 交互 ───────────────────────────── */

  function nowMs() {
    return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
  }

  function bindEvents(inst) {
    var cvs = inst.renderer.domElement;
    inst.handlers = [];
    inst.pointers = {};
    inst.drag = null;
    inst.pinch = null;
    inst.hoverEnabled = true;

    function on(target, type, fn, opt) {
      target.addEventListener(type, fn, opt || false);
      inst.handlers.push([target, type, fn, opt || false]);
    }

    on(cvs, "pointerdown", function (ev) {
      try {
        if (ev.button === 2 || ev.button === 1) return;
        inst.pointers[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
        var ids = Object.keys(inst.pointers);
        if (ids.length === 1) {
          inst.drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: nowMs(), moved: 0 };
          if (isFn(cvs.setPointerCapture)) { try { cvs.setPointerCapture(ev.pointerId); } catch (e) {} }
        } else if (ids.length === 2) {
          var a = inst.pointers[ids[0]], b = inst.pointers[ids[1]];
          inst.pinch = { d: hypot(a.x - b.x, a.y - b.y), z: inst.tZoom };
          inst.drag = null;
        }
        inst.hoverEnabled = false;
      } catch (e) {}
    });

    on(cvs, "pointermove", function (ev) {
      try {
        var pt = inst.pointers[ev.pointerId];
        if (pt) { pt.x = ev.clientX; pt.y = ev.clientY; }
        var ids = Object.keys(inst.pointers);
        if (inst.pinch && ids.length >= 2) {
          var a = inst.pointers[ids[0]], b = inst.pointers[ids[1]];
          var d = hypot(a.x - b.x, a.y - b.y);
          if (inst.pinch.d > 6) setZoom(inst, inst.pinch.z * (d / inst.pinch.d));
          return;
        }
        if (inst.drag && ev.pointerId === inst.drag.id) {
          var dx = ev.clientX - inst.drag.x, dy = ev.clientY - inst.drag.y;
          inst.drag.moved += Math.abs(dx) + Math.abs(dy);
          inst.drag.x = ev.clientX; inst.drag.y = ev.clientY;
          inst.tYaw -= dx * 0.0062;
          inst.tPitch = clamp(inst.tPitch + dy * 0.0050, 0.20, TOP_PITCH);
          inst.hoverId = null;
          return;
        }
        var r = cvs.getBoundingClientRect();
        if (!r.width || !r.height) return;
        inst.pointerNDC = {
          x: ((ev.clientX - r.left) / r.width) * 2 - 1,
          y: -((ev.clientY - r.top) / r.height) * 2 + 1
        };
      } catch (e) {}
    });

    function endPointer(ev) {
      try {
        var wasDrag = (inst.drag && inst.drag.id === ev.pointerId) ? inst.drag : null;
        delete inst.pointers[ev.pointerId];
        if (Object.keys(inst.pointers).length < 2) inst.pinch = null;
        if (wasDrag) {
          inst.drag = null;
          if (isFn(cvs.releasePointerCapture)) { try { cvs.releasePointerCapture(ev.pointerId); } catch (e) {} }
          // 轻点（位移小 + 时间短）→ 拾取
          if (wasDrag.moved < 8 && (nowMs() - wasDrag.t) < 700) pick(inst, ev.clientX, ev.clientY, true);
          inst.hoverEnabled = true;
        }
      } catch (e) {}
    }
    on(cvs, "pointerup", endPointer);
    on(cvs, "pointercancel", endPointer);
    on(cvs, "lostpointercapture", function (ev) {
      try { delete inst.pointers[ev.pointerId]; inst.drag = null; inst.pinch = null; } catch (e) {}
    });
    on(cvs, "pointerenter", function () { inst.hoverEnabled = true; });
    on(cvs, "pointerleave", function () {
      inst.hoverId = null;
      for (var id in inst.places) inst.places[id].lift = 0;
    });
    on(cvs, "contextmenu", function (ev) { try { ev.preventDefault(); } catch (e) {} });

    on(cvs, "wheel", function (ev) {
      try {
        ev.preventDefault();
        var d = num(ev.deltaY, 0);
        if (ev.deltaMode === 1) d *= 16;
        setZoom(inst, inst.tZoom * Math.exp(-d * 0.0012));
      } catch (e) {}
    }, { passive: false });

    if (global.ResizeObserver) {
      try {
        inst.ro = new global.ResizeObserver(function () { resize(inst, false); });
        inst.ro.observe(inst.el);
        if (inst.el.parentElement) inst.ro.observe(inst.el.parentElement);
      } catch (e) { inst.ro = null; }
    }
    on(global, "resize", function () { resize(inst, false); });
    on(global, "orientationchange", function () { global.setTimeout(function () { resize(inst, true); }, 220); });
  }

  function setZoom(inst, z) { inst.tZoom = clamp(num(z, 1), 0.45, 4.5); }

  /** 射线拾取（click=true 时触发 onPick / 抖动反馈） */
  function pick(inst, clientX, clientY, click) {
    try {
      var r = inst.renderer.domElement.getBoundingClientRect();
      if (!r.width || !r.height) return;
      _ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      _ray.setFromCamera(_ndc, inst.camera);
      var p = rayPlace(inst);
      if (!click) { inst.hoverId = p ? p.id : null; return; }
      if (!p) return;
      if (p.state === "avail") {
        if (isFn(inst.opts.onPick)) inst.opts.onPick(p.id, p.nodeId || null);
      } else {
        p.shakeAmp = 1;   // 非 avail：轻微抖动反馈
      }
    } catch (e) {}
  }

  /** 返回射线命中的 place（无命中返回 null） */
  function rayPlace(inst) {
    var hits = _ray.intersectObjects(inst.pickables, false);
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (!h || h.instanceId === undefined || h.instanceId === null) continue;
      for (var k = 0; k < inst.order.length; k++) {
        var c = inst.places[inst.order[k]];
        if (c.batch === h.object && c.idx === h.instanceId) return c;
      }
    }
    return null;
  }

  /* ───────────────────────────── 主循环 ───────────────────────────── */

  function tick(inst, now) {
    if (!inst || inst.disposed) return;
    inst.raf = global.requestAnimationFrame(function (t) { tick(inst, t); });
    try {
      if (global.document && global.document.hidden) return;

      var t = (typeof now === "number" ? now : nowMs()) * 0.001;
      var dt = clamp(t - inst.t, 0.0001, 0.05);
      inst.t = t;
      inst.frame++;

      // 兜底尺寸检查（display:none → block 时 ResizeObserver 偶有延迟）
      if ((inst.frame % 20) === 0) resize(inst, false);

      stepMood(inst, dt);
      updateCamera(inst, dt);

      // 悬停拾取（节流 1/3 帧，拖拽中跳过）
      if (inst.hoverEnabled && !inst.drag && !inst.pinch && inst.pointerNDC && (inst.frame % 3) === 0) {
        try {
          _ndc.set(inst.pointerNDC.x, inst.pointerNDC.y);
          _ray.setFromCamera(_ndc, inst.camera);
          var hp = rayPlace(inst);
          inst.hoverId = hp ? hp.id : null;
        } catch (eH) {}
      }

      for (var m = 0; m < inst.order.length; m++) {
        var p = inst.places[inst.order[m]];
        var oldLift = p.lift, oldRaise = p.raise;
        p.lift += (((inst.hoverId === p.id) ? 1 : 0) - p.lift) * (1 - Math.exp(-dt * 12));
        p.raise += (p.raiseT - p.raise) * (1 - Math.exp(-dt * 10));   // avail 抬高 0.35 的平滑过渡
        if (Math.abs(p.raise - p.raiseT) < 0.0015) p.raise = p.raiseT;
        var needWrite = Math.abs(p.lift - oldLift) > 0.0008 || Math.abs(p.raise - oldRaise) > 0.0008;
        if (p.shakeAmp > 0.001) { p.shakeAmp = Math.max(0, p.shakeAmp - dt * 1.6); needWrite = true; }
        else if (p.shakeAmp !== 0) { p.shakeAmp = 0; needWrite = true; }
        if (needWrite) writeBuildingMatrix(inst, p);

        // —— 标签三态：avail 放大 1.15 + 0.6→1.0 呼吸 / done 灰绿 / locked 0.82 透明度 ——
        var mat = p.lblMat;
        if (mat) {
          var baseW = LABEL_W / LABEL_H * 0.62, baseH = 0.62;
          if (p.state === "avail") {
            var pulse = 0.5 + 0.5 * Math.sin(inst.t * 3.1 + p.phase);
            mat.opacity = 1;
            var s1 = 1.15 + 0.05 * pulse + p.lift * 0.10;
            p.label.scale.set(baseW * s1, baseH * s1, 1);
            var br = 1.0 + 0.45 * pulse + p.lift * 0.45;
            mat.color.setRGB(br, br, br);
          } else if (p.state === "done") {
            mat.opacity = 1;
            var br2 = 1.0 + (inst.hoverId === p.id ? 0.35 : 0);
            mat.color.setRGB(br2, br2, br2);
            var s2 = 1 + p.lift * 0.10;
            p.label.scale.set(baseW * s2, baseH * s2, 1);
          } else {
            mat.opacity = 1;                                  // locked：0.82 不透明度
            var br3 = 1.0 + (inst.hoverId === p.id ? 0.75 : 0);
            mat.color.setRGB(br3, br3, br3);
            var s3 = 1 + p.lift * 0.10;
            p.label.scale.set(baseW * s3, baseH * s3, 1);
          }
          p.label.position.set(p.wx, p.h + 0.55 + p.raise + p.lift * 0.22, p.wz);
        }

        // —— avail 光环 / 光柱 ——
        if (p.ring && p.ring.visible && p.ring.material) {
          var av = p.state === "avail";
          var pu = 0.5 + 0.5 * Math.sin(inst.t * 2.4 + p.phase);
          p.ring.material.opacity = av ? (0.30 + 0.55 * (1 - pu)) : 0.10;
          var s4 = av ? (1 + 0.45 * pu) : 1;
          p.ring.scale.set(s4, s4, 1);
          if (p.beacon && p.beacon.material) p.beacon.material.opacity = av ? (0.18 + 0.40 * pu) : 0;
        }
      }

      render(inst);
    } catch (e) {
      try { if (global.console) global.console.warn("[Map3D] frame error:", e); } catch (e2) {}
    }
  }

  function render(inst) {
    var renderer = inst.renderer, scene = inst.scene, cam = inst.camera;
    if (!renderer || !scene || !cam) return;
    var w = inst.size.w, h = inst.size.h;

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.render(scene, cam);

    // ── 右下角 120×120 小地图：第二个正交相机 + scissor ──
    if (inst.mm && w > MM_SIZE + MM_MARGIN * 2 + 40 && h > MM_SIZE + MM_MARGIN * 2 + 20) {
      var mx = Math.max(0, w - MM_SIZE - MM_MARGIN);
      var my = MM_MARGIN;                                     // GL 坐标自下而上
      var lg = inst.labelGroup, lgVis = lg ? lg.visible : false;
      var skyVis = inst.sky ? inst.sky.visible : false;
      if (lg) lg.visible = false;
      if (inst.sky) inst.sky.visible = false;
      try {
        renderer.setScissorTest(true);
        renderer.setViewport(mx, my, MM_SIZE, MM_SIZE);
        renderer.setScissor(mx, my, MM_SIZE, MM_SIZE);
        renderer.setClearColor(0x05050c, 1);
        renderer.clear();
        renderer.render(scene, inst.mm);
      } finally {
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, w, h);
        if (lg) lg.visible = lgVis;
        if (inst.sky) inst.sky.visible = true;
        var bg = inst.moodCur ? inst.moodCur.bg : null;
        if (bg) renderer.setClearColor(bg, 1);
      }
    }
  }

  /* ───────────────────────────── 卸载 ───────────────────────────── */

  function disposeInstance(inst) {
    if (inst && inst.cityLegend && inst.cityLegend.parentNode) inst.cityLegend.parentNode.removeChild(inst.cityLegend);
    try {
      inst.disposed = true;
      inst.ready = false;
      if (inst.raf) { try { global.cancelAnimationFrame(inst.raf); } catch (e) {} inst.raf = 0; }
      if (inst.ro) { try { inst.ro.disconnect(); } catch (e) {} inst.ro = null; }
      if (inst.handlers) {
        for (var i = 0; i < inst.handlers.length; i++) {
          var hd = inst.handlers[i];
          try { hd[0].removeEventListener(hd[1], hd[2], hd[3]); } catch (e) {}
        }
        inst.handlers = null;
      }
      for (var id in inst.places) disposeLabel(inst.places[id]);
      if (inst.scene) {
        inst.scene.traverse(function (o) {
          try {
            if (o.geometry && isFn(o.geometry.dispose)) o.geometry.dispose();
            var mats = !o.material ? [] : (o.material.length ? o.material : [o.material]);
            for (var k = 0; k < mats.length; k++) {
              var mt = mats[k];
              if (!mt) continue;
              for (var key in mt) {
                var v = mt[key];
                if (v && v.isTexture && isFn(v.dispose)) v.dispose();
              }
              if (isFn(mt.dispose)) mt.dispose();
            }
          } catch (e) {}
        });
      }
      if (inst.mmFrame && inst.mmFrame.parentNode) inst.mmFrame.parentNode.removeChild(inst.mmFrame);
      var cvs = inst.renderer ? inst.renderer.domElement : null;
      if (cvs && cvs.parentNode) cvs.parentNode.removeChild(cvs);
      if (inst.renderer) {
        if (isFn(inst.renderer.dispose)) inst.renderer.dispose();
        if (isFn(inst.renderer.forceContextLoss)) { try { inst.renderer.forceContextLoss(); } catch (e) {} }
      }
      inst.renderer = null; inst.scene = null; inst.camera = null;
    } catch (e) {}
  }

  /* ───────────────────────────── 模块状态 ───────────────────────────── */

  var current = null;

  /* ───────────────────────────── mount ───────────────────────────── */

  function mount(el, opts) {
    var pending = null;
    try {
      if (current) { disposeInstance(current); current = null; }

      // ── 前置校验：任一不满足即 false，绝不抛错 ──
      if (!el || el.nodeType !== 1) return false;
      var T = global.THREE;
      if (typeof T === "undefined" || !T) return false;
      if (!isFn(T.WebGLRenderer) || !isFn(T.OrthographicCamera) || !isFn(T.Scene) || !isFn(T.Mesh)) return false;
      if (!isObj(opts) || !isObj(opts.places)) return false;
      var any = false;
      for (var kk in opts.places) if (isObj(opts.places[kk])) { any = true; break; }
      if (!any) return false;
      if (!webglProbe()) return false;

      lazyTmp(T);
      _q0b = new T.Quaternion();

      pending = {
        el: el, opts: opts, T: T, ready: false, disposed: false,
        places: {}, order: [], state: "avail", done: {}, avail: {},
        batches: [], pickables: [], labels: null,
        hoverId: null, hoverEnabled: true, raf: 0, ro: null,
        t: 0, frame: 0, size: { w: 0, h: 0 },
        moodKey: MOOD_FALLBACK, moodCur: null, moodTo: null, moodFrom: null, moodT: 1,
        mode: "orbit", yaw: ISO_YAW, pitch: ISO_PITCH, zoom: 1,
        tYaw: ISO_YAW, tPitch: ISO_PITCH, tZoom: 1,
        pointers: {}, drag: null, pinch: null, pointerNDC: null,
        mm: null, mmFrame: null
      };
      var inst = pending;

      var renderer = new T.WebGLRenderer({
        antialias: true, alpha: false, stencil: false,
        powerPreference: "high-performance", preserveDrawingBuffer: false
      });
      if (!renderer || !renderer.domElement) throw new Error("WebGLRenderer unavailable");
      inst.renderer = renderer;
      renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = T.PCFSoftShadowMap || T.PCFShadowMap;
      renderer.setClearColor(0x07070c, 1);
      renderer.toneMapping = T.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.93;

      var cvs = renderer.domElement;
      cvs.style.display = "block";
      cvs.style.width = "100%";
      cvs.style.height = "100%";
      cvs.style.touchAction = "none";
      cvs.style.outline = "none";
      el.appendChild(cvs);

      buildScene(inst);                       // 场景 / 光照 / 相机 / 建筑 / 道路 / 标签 / 小地图
      bindEvents(inst);                       // 交互
      resize(inst, true);
      applyMood(inst, MOOD_FALLBACK, true);   // 初始氛围
      inst.ready = true;                      // refresh 需要 ready
      refresh(inst, { done: [], avail: null });

      current = inst;
      inst.t = nowMs() * 0.001;
      inst.raf = global.requestAnimationFrame(function (t) { tick(inst, t); });
      return true;
    } catch (e) {
      try {
        if (global.console && global.console.warn) {
          global.console.warn("[Map3D] mount failed:", (e && e.message) ? e.message : e);
        }
      } catch (e2) {}
      try { if (pending) disposeInstance(pending); } catch (e3) {}
      if (current === pending) current = null;
      return false;
    }
  }

  /* ───────────────────────────── 公开 API ───────────────────────────── */

  var Map3D = {
    version: VERSION,

    mount: function (el, opts) {
      try { if (global.THREE) lazyTmp(global.THREE); } catch (e) {}
      return mount(el, opts);
    },

    refresh: function (st) {
      try { return refresh(null, st); } catch (e) { return false; }
    },

    setMood: function (mood) {
      try {
        if (!current || !current.ready) return false;
        return applyMood(current, mood, false);
      } catch (e) { return false; }
    },

    setMode: function (mode) {
      try {
        if (!current || !current.ready) return false;
        var m = String(mode === undefined || mode === null ? "" : mode).toLowerCase();
        if (m === "top" || m === "plan" || m === "俯视") {
          current.mode = "top";
          current.tPitch = TOP_PITCH;
          current.tYaw = 0;
          return true;
        }
        if (m === "orbit" || m === "iso" || m === "3d" || m === "等距") {
          current.mode = "orbit";
          current.tPitch = ISO_PITCH;
          current.tYaw = ISO_YAW;
          return true;
        }
        return false;
      } catch (e) { return false; }
    },

    isReady: function () { return !!(current && current.ready); },

    dispose: function () {
      try { if (current) disposeInstance(current); } catch (e) {}
      current = null;
      return true;
    },

    /** 调试辅助（非必需接口）：读取当前运行状态 */
    info: function () {
      try {
        if (!current || !current.ready) return { ready: false, version: VERSION };
        var states = {};
        for (var i = 0; i < current.order.length; i++) {
          var p = current.places[current.order[i]];
          states[p.id] = {
            state: p.state, node: p.nodeId, h: p.h, rep: p.rep,
            lift: p.lift, shake: p.shakeAmp, raise: p.raise, raiseT: p.raiseT,
            tint: (p.tintHex === undefined ? null : "#" + ("000000" + p.tintHex.toString(16)).slice(-6)),
            theme: "#" + ("000000" + (p.color >>> 0).toString(16)).slice(-6),
            labelOpacity: p.lblMat ? p.lblMat.opacity : null,
            labelScale: p.label ? +p.label.scale.x.toFixed(3) : null
          };
        }
        return {
          ready: true, version: VERSION, mood: current.moodKey, mode: current.mode,
          count: current.order.length, size: { w: current.size.w, h: current.size.h },
          batches: current.batches.length, states: states
        };
      } catch (e) { return { ready: false, version: VERSION }; }
    }
  };

  try { global.Map3D = Map3D; } catch (e) { /* 全局被冻结时静默 */ }

})(typeof window !== "undefined" ? window : this);
