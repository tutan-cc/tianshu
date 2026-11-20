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
 *   Map3D.setMode('orbit'|'top'|'walk')                 -> boolean
 *   Map3D.setStyle('abstract'|'realistic')              -> boolean
 *   Map3D.isReady()                                     -> boolean
 *   Map3D.dispose() / Map3D.info()                      （附加，非必需）
 *
 * mount 内部全程 try/catch：WebGL 不可用、THREE 缺失、数据非法……任何失败
 * 都返回 false，绝不抛错（调用方据此回落 2D 沙盘）。
 *
 * 设计要点：
 *   · 抽象墙体：2 种风格 × 3 档密度，每组按状态分批。写实街景按共享几何和材质合批。
 *   · 标签 = CanvasTexture + Sprite（256×56，仅在状态变化时重绘）
 *   · 相机 = OrthographicCamera，等距机位 (38,38,38) → lookAt 场景中心；setMode('top') 平滑俯视
 *   · 坐标 = PLACES 的 (x:0~800, y:0~520) 线性映射为 wx=(x-400)/40, wz=(y-260)/40
 *   · 小地图与地点标签由独立的 2D Canvas 绘制。
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

  var PICK_LAYER = 2;
  var MM_SIZE = 120, MM_MARGIN = 10, MM_HALF = 19;   // 小地图

  /* 氛围预设：雾 / 背景 / 光色温 / 环境光强度
   * 注意：主相机 8 字轨道半径 = |(38,38,38)| ≈ 65.8，场景沿视线深度约 54~78，
   *       因此 fogNear/fogFar 必须落在该区间之外，否则整个沙盘会被雾吃成全黑。
   * floor = 楼体最低亮度（自发光下限），保证夜间/暗场也能看清建筑轮廓。 */
  var MOODS = {
    calm:  { bg: 0x9eabaa, fog: 0xaeb4aa, fogNear: 95, fogFar: 180, amb: 0.23, hemi: 0.44, sun: 0xffe5be, sunI: 1.03, fill: 0xb8d5ef, fillI: 0.08, night: false, floor: 0.025 },
    city:  { bg: 0x99a8ab, fog: 0xa8b6b2, fogNear: 95, fogFar: 180, amb: 0.25, hemi: 0.44, sun: 0xffe9cd, sunI: 1.04, fill: 0xb1d7ed, fillI: 0.09, night: false, floor: 0.025 },
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
  function makeGroundCanvas(abstractStyle) {
    var cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    var g = cv.getContext("2d");
    if (!g) return null;
    g.fillStyle = abstractStyle ? "#171524" : "#718073"; g.fillRect(0, 0, 128, 128);
    for (var i = 0; i < 260; i++) {
      var v = 120 + (hash32("g" + i) % 100);
      g.fillStyle = "rgba(" + v + "," + (v - 20) + "," + (v + 40) + ",.16)";
      g.fillRect(hash32("x" + i) % 128, hash32("y" + i) % 128, 2, 2);
    }
    g.strokeStyle = abstractStyle ? "rgba(96,90,168,.30)" : "rgba(113,125,110,.04)"; g.lineWidth = 2;
    g.strokeRect(1, 1, 126, 126);
    g.strokeStyle = abstractStyle ? "rgba(96,90,168,.10)" : "rgba(113,125,110,.02)"; g.lineWidth = 1;
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
    sp.layers.set(PICK_LAYER);
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
    inst.shadowDirty=true;

    /* ── 光照 ── */
    inst.amb = new T.AmbientLight(0xb9c2e8, 0.36);
    scene.add(inst.amb);
    inst.hemi = new T.HemisphereLight(0xddeeff, 0x68705c, 0.30);
    scene.add(inst.hemi);
    inst.sun = new T.DirectionalLight(0xfff2d6, 0.62);
    inst.sun.position.set(-24, 39, -15);
    inst.sun.castShadow = true;
    var sc = inst.sun.shadow;
    sc.mapSize.width = 1024; sc.mapSize.height = 1024;
    sc.radius = 2;
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
    inst.districtGroundMap = gTex;

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
        im.layers.set(PICK_LAYER);
        im.castShadow = false;
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
        roof.layers.set(PICK_LAYER);
        roof.castShadow = false;
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
    pad.layers.set(PICK_LAYER);
    pad.receiveShadow = false;
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
    labelGroup.visible = false; // 始终由 Canvas 叠层绘制地点标签
    for (var li = 0; li < inst.order.length; li++) {
      var lp = inst.places[inst.order[li]];
      makeLabel(inst, lp);
      lp.label.position.set(lp.wx, lp.h + 0.55, lp.wz);
      labelGroup.add(lp.label);

      var ring = new T.Mesh(
        new T.RingGeometry(0.90, 1.00, 40),
        new T.MeshBasicMaterial({ color: lp.color, transparent: true, opacity: 0.0, side: T.DoubleSide, depthWrite: false, fog: false, blending: T.AdditiveBlending })
      );
      ring.layers.set(PICK_LAYER);
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
      beacon.layers.set(PICK_LAYER);
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
    var overlay=document.createElement("canvas");
    overlay.style.cssText="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2";
    inst.el.appendChild(overlay);
    inst.cityOverlay=overlay;
    inst.cityOverlayCtx=overlay.getContext("2d");
    inst.projectedLabel=new T.Vector3();
    inst.miniCanvas=document.createElement("canvas");
    inst.miniCanvas.width=inst.miniCanvas.height=MM_SIZE;
    inst.miniDirty=true;

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

  var STREET = {
    x:[-18,-12,-6,0,6,12,18], z:[-15,-9,-3,3,9,15,21],
    halfLane:.54, roadY:.054, curbY:.104, slope:.19, crossing:.77, corner:.24
  };
  var BUILDING_STYLES = {
    office:{bay:.40, upper:.48, door:.63, min:4,max:6},
    housing:{bay:.52, upper:.48, door:.60, min:3,max:5},
    civic:{bay:.46, upper:.48, door:.65, min:3,max:4},
    retail:{bay:.50, upper:.43, door:.70, min:1,max:2}
  };
  var CURBSIDE_PROPS = [
    [1.40,3.32,0,0],[-4.1,2.68,0,1],[7.9,-2.68,0,0],
    [-.32,-1.16,Math.PI/2,0],[6.32,.98,Math.PI/2,1],[-6.32,-7.4,Math.PI/2,0],
    [2.70,9.32,0,1],[-11.68,5.32,Math.PI/2,0],[13.3,3.32,0,0]
  ];
  var CITY_LAYOUT = {
    rent: [-9,-6,2.6,1.8,2.0], capital: [-3,-6,1.9,1.8,4.6],
    office: [-9,0,2.2,2.0,3.8], library: [-3,0,2.9,2.1,1.1],
    park: [3,0,4.4,4.4,0.03], boxing: [9,0,2.6,1.9,1.4],
    bar: [-3,6,2.5,1.7,1.0], ktv: [3,6,2.4,2.0,1.7], alley: [9,6,1.8,2.0,1.8]
  };
  var CITY_COLORS = {rent:0xd6c8ac,capital:0x8eabb9,office:0x779eaf,library:0xd7d5c9,park:0x55794b,boxing:0xc7b8a5,bar:0xb9b1a3,ktv:0xc8c4b8,alley:0xc1c2b8};

  /** Fine-scale material layers. Building openings and trim are modelled separately. */
  function citySurface(inst, kind) {
    var T=inst.T, cv=document.createElement("canvas"), size=256;
    cv.width=cv.height=size;
    var g=cv.getContext("2d"), seed=hash32("material:"+kind);
    function random(){ seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; }
    var colors={stone:[198,189,172],brick:[138,98,77],roof:[116,116,106],road:[133,132,123],
      paving:[178,172,153],grass:[112,132,80]};
    if(kind==="glass"){
      var sky=g.createLinearGradient(0,0,0,size);
      sky.addColorStop(0,"#809fb0"); sky.addColorStop(.56,"#52727f"); sky.addColorStop(.72,"#607c83"); sky.addColorStop(1,"#263a3e");
      g.fillStyle=sky; g.fillRect(0,0,size,size);
      for(var k=0;k<13;k++){
        var x=k*21, h=18+random()*65;
        g.fillStyle=k%2?"rgba(42,61,64,.23)":"rgba(30,45,47,.15)";
        g.fillRect(x,190-h,10+random()*12,h+68);
      }
      g.fillStyle="rgba(220,232,228,.09)";
      g.beginPath(); g.moveTo(0,198); g.lineTo(145,0); g.lineTo(185,0); g.lineTo(0,240); g.fill();
    }else{
      var rgb=colors[kind], data=g.createImageData(size,size);
      for(var y=0;y<size;y++)for(var x0=0;x0<size;x0++){
        var i=(y*size+x0)*4;
        var grain=(random()-.5)*(kind==="road"?22:20);
        var cloud=Math.cos(x0*Math.PI/64+Math.sin(y*Math.PI/64))*3 + Math.sin(y*Math.PI/32)*2;
        var seam=0;
        if(kind==="brick"){
          var xx=(x0+((y>>4)%2)*16)%32, yy=y%16;
          seam=xx<2||yy<2 ? 40 : (hash32((x0>>5)+":"+(y>>4))%16)-8;
        }else if(kind==="paving" && ((y%64)<2 || ((x0+(y>>6)%2*32)%64)<2)) seam=-22;
        else if(kind==="roof" && (y%64)<2) seam=-12;
        for(var c=0;c<3;c++) data.data[i+c]=rgb[c]+grain+cloud+seam+(seam>20 && c>0?15:0);
        data.data[i+3]=255;
      }
      g.putImageData(data,0,0);
    }
    var texture=newTex(T,cv,1,1);
    texture.encoding=T.sRGBEncoding;
    texture.anisotropy=aniso(inst.renderer);
    return texture;
  }

  function worldSurface(material,repeat) {
    material.onBeforeCompile=function(shader){
      shader.vertexShader="varying vec3 vCityWorld;\n"+shader.vertexShader.replace("#include <project_vertex>", [
        "vec4 cityPosition = vec4(transformed, 1.0);",
        "#ifdef USE_INSTANCING",
        "cityPosition = instanceMatrix * cityPosition;",
        "#endif",
        "vCityWorld = (modelMatrix * cityPosition).xyz;",
        "#include <project_vertex>"
      ].join("\n"));
      shader.fragmentShader="varying vec3 vCityWorld;\n"+shader.fragmentShader.replace("#include <map_fragment>",
        "diffuseColor *= texture2D(map, vCityWorld.xz * "+repeat.toFixed(3)+");");
    };
    material.customProgramCacheKey=function(){return "city-world-"+repeat;};
    return material;
  }

  /** Continuous city blocks with batched streets, architecture, planting and traffic. */
  function cityReflection(T) {
    var faces=[];
    for(var i=0;i<6;i++){
      var cv=document.createElement("canvas");cv.width=cv.height=32;
      var g=cv.getContext("2d"), sky=g.createLinearGradient(0,0,0,32);
      sky.addColorStop(0,i===2?"#e6e5d0":"#b9d2cb");
      sky.addColorStop(.58,"#779da0");sky.addColorStop(1,"#424e48");
      g.fillStyle=sky;g.fillRect(0,0,32,32);
      if(i!==2 && i!==3){
        g.fillStyle="#607067";
        for(var j=0;j<5;j++){
          var rise=3+hash32("reflect:"+i+":"+j)%10;
          g.fillRect(j*7,32-rise,5,rise);
        }
      }
      faces.push(cv);
    }
    var env=new T.CubeTexture(faces);
    env.encoding=T.sRGBEncoding;env.needsUpdate=true;
    return env;
  }

  function streetHeight(x,z) {
    var dx=Math.abs(x-Math.round(x/6)*6);
    var dz=Math.abs(z-(3+Math.round((z-3)/6)*6));
    var edge=Math.min(dx,dz);
    var crossing=STREET.crossing, near=Math.abs(dz-crossing)<.16 || Math.abs(dx-crossing)<.16;
    if(edge>STREET.halfLane)return STREET.curbY;
    if(near && edge>STREET.halfLane-STREET.slope)
      return STREET.curbY-(STREET.curbY-STREET.roadY-.008)*(STREET.halfLane-edge)/STREET.slope;
    return STREET.roadY+.008;
  }

  function buildCityDistrict(inst) {
    var T=inst.T, scene=new T.Group(), box=new T.BoxGeometry(1,1,1);
    inst.district=scene;
    inst.scene.add(scene);
    var buckets={}, meshes=[], shadowMatrices=[];
    var vegetation=global.CityVegetation ? global.CityVegetation.create(T) : null;
    var planted={palm:0,tree:0,fern:0,maxHeight:0};
    inst.planting=planted; inst.vegetation=vegetation;
    var stoneTex=citySurface(inst,"stone"), glassTex=citySurface(inst,"glass");
    var concrete=new T.MeshLambertMaterial({color:0xfff4dc,map:stoneTex});
    var roof=new T.MeshLambertMaterial({color:0xd2d4cb,map:citySurface(inst,"roof")});
    var dark=new T.MeshLambertMaterial({color:0x35464a});
    var frames=new T.MeshLambertMaterial({color:0x788580});
    var reflection=cityReflection(T);
    var glass=new T.MeshPhongMaterial({color:0xb8e1de,map:glassTex,envMap:reflection,reflectivity:.24,
      combine:T.MixOperation,shininess:74,specular:0x859dac});
    var glassPale=glass.clone(); glassPale.color.setHex(0xf2edcf);
    var masonry=new T.MeshLambertMaterial({color:0xf9f6e7,map:stoneTex});
    var brick=new T.MeshLambertMaterial({color:0xf4e6da,map:citySurface(inst,"brick")});
    var pale=new T.MeshLambertMaterial({color:0xd9ddd4,map:stoneTex});
    var asphalt=worldSurface(new T.MeshLambertMaterial({color:0xdfded8,map:citySurface(inst,"road")}),.67);
    var sidewalk=worldSurface(new T.MeshLambertMaterial({color:0xe4e1d4,map:citySurface(inst,"paving")}),.51);
    var white=new T.MeshLambertMaterial({color:0xe3dfc9});
    var yellow=new T.MeshLambertMaterial({color:0xd0bd70});
    var grass=worldSurface(new T.MeshLambertMaterial({color:0xcadbb9,map:citySurface(inst,"grass")}),.61);
    var bark=new T.MeshLambertMaterial({color:0x665e49});
    var soil=new T.MeshLambertMaterial({color:0x55513b});
    var water=new T.MeshPhongMaterial({color:0x4d8e91,shininess:70,specular:0xa3c8bf});
    var tealAwning=new T.MeshLambertMaterial({color:0x417d75});
    var ochreAwning=new T.MeshLambertMaterial({color:0xbaa569});
    var roundTower=new T.CylinderGeometry(.5,.5,1,18);
    var ventGeo=new T.CylinderGeometry(.5,.5,1,10);
    var obstacles=[{x:3.9,z:0.8,w:1.38,d:1.0}];
    inst.walkObstacles=obstacles;
    inst.streetHeight=streetHeight;
    var carMats=[0xece8da,0x637f8b].map(function(c){return new T.MeshLambertMaterial({color:c});});
    var sharedPlain=white.clone(); sharedPlain.color.setHex(0xffffff);
    var sharedStone=concrete.clone(); sharedStone.color.setHex(0xffffff);
    var sharedGlass=glass.clone(); sharedGlass.color.setHex(0xffffff);
    var plain=[dark,frames,white,yellow,bark,soil,tealAwning,ochreAwning].concat(carMats);
    var contact=document.createElement("canvas"); contact.width=contact.height=32;
    var ao=contact.getContext("2d"), feather=ao.createRadialGradient(16,16,3,16,16,16);
    feather.addColorStop(0,"rgba(36,31,22,.42)");feather.addColorStop(.52,"rgba(36,31,22,.20)");
    feather.addColorStop(1,"rgba(36,31,22,0)");
    ao.fillStyle=feather;ao.fillRect(0,0,32,32);
    var contactMat=new T.MeshBasicMaterial({map:new T.CanvasTexture(contact),transparent:true,depthWrite:false});
    var contactPlane=new T.PlaneGeometry(1,1); contactPlane.rotateX(-Math.PI/2);
    var rotationAxis=new T.Vector3(0,1,0);
    var tmpPosition=new T.Vector3(), tmpScale=new T.Vector3(), tmpRotation=new T.Quaternion();
    function part(parent,mat,x,y,z,w,h,d,geo,angle){
      geo=geo||box;
      if(parent!==scene){x+=parent.position.x;y+=parent.position.y;z+=parent.position.z;}
      var merged=mat.map===stoneTex?sharedStone:(mat.map===glassTex?sharedGlass:(plain.indexOf(mat)>=0?sharedPlain:mat));
      var key=merged.uuid+geo.uuid;
      var batch=buckets[key]||(buckets[key]={material:merged,geometry:geo,matrices:[],colors:[]});
      tmpRotation.setFromAxisAngle(rotationAxis,angle||0);
      batch.matrices.push(new T.Matrix4().compose(tmpPosition.set(x,y,z),tmpRotation,tmpScale.set(w,h,d)));
      batch.colors.push(merged!==mat?mat.color:null);
    }
    function plant(species,x,y,z,scale){
      if(!vegetation)return;
      var id=hash32(species+":"+x+":"+z);
      var height=vegetation.part(part,scene,species,id%3,x,y,z,scale,(id%628)*.01);
      planted[species]++;
      planted.maxHeight=Math.max(planted.maxHeight,height);
      if(species!=="fern"){
        obstacles.push({x:x,z:z,w:.12,d:.12});
        part(scene,contactMat,x,streetHeight(x,z)+.002,z,scale*.67,1,scale*.56,contactPlane);
      }
    }
    function planter(x,z,wide){
      part(scene,concrete,x,.095,z,wide,.07,.34);
      part(scene,soil,x,.135,z,wide-.07,.014,.27);
      for(var i=0;i<3;i++){
        var offset=(i-1)*wide*.29;
        plant("fern",x+offset,.143,z,.27+rand01(x+":"+z+":"+i)*.10);
      }
    }
    function rooftop(parent,x,z,w,d,top,style,seed){
      part(parent,roof,x,top,z,w,d > 1.8 ? .10 : .08,d);
      var edge=style==="retail"?ochreAwning:concrete;
      for(var side=-1;side<=1;side+=2){
        part(parent,edge,x,top+.10,z+side*(d/2-.028),w,.16,.056);
        part(parent,edge,x+side*(w/2-.028),top+.10,z,.056,.16,d);
      }
      part(parent,pale,x-w*.16,top+.19,z-d*.14,w*.34,.27,d*.33);
      part(parent,roof,x-w*.16,top+.34,z-d*.14,w*.39,.049,d*.38);
      if(w<1.1||d<1.1)return;
      var units=style==="office"?3:2;
      for(var n=0;n<units;n++){
        var ux=x+w*(.10+n*.095), uz=z+d*.21;
        part(parent,frames,ux,top+.107,uz,.115,.12,.22);
        part(parent,dark,ux,top+.174,uz,.083,.015,.083,ventGeo);
        part(parent,pale,ux,top+.186,uz,.022,.012,.113);
      }
      if(style==="office"||hash32(seed)%3===0){
        part(parent,dark,x+w*.28,top+.36,z-d*.29,.018,.65,.018);
        part(parent,frames,x+w*.28,top+.61,z-d*.29,.21,.016,.017);
      }
    }

    function building(parent,x,z,w,d,h,style,seed){
      var wx=x+(parent===scene?0:parent.position.x), wz=z+(parent===scene?0:parent.position.z);
      obstacles.push({x:wx,z:wz,w:w+.18,d:d+.22});
      var modern=style==="office", civic=style==="civic", retail=style==="retail";
      var outer=modern?dark:(retail?brick:(hash32(seed)%2?masonry:pale));
      // A recessed core leaves daylight between the glass plane and the projecting piers.
      var skin=.095, base=.07;
      part(parent,outer,x,base+h/2,z,Math.max(.3,w-skin*2),h,Math.max(.3,d-skin*2));
      part(scene,contactMat,wx,STREET.curbY+.004,wz,w+.65,1,d+.65,contactPlane);
      shadowMatrices.push(new T.Matrix4().compose(tmpPosition.set(wx,base+h/2,wz),tmpRotation.identity(),
        tmpScale.set(w-.06,h,d-.06)));
      part(parent,concrete,x,.082,z,w+.10,.10,d+.14);
      var plinth=Math.min(h*.43,civic ? .69 : .53);
      var recipe=BUILDING_STYLES[style];
      var floors=Math.max(1,Math.round((h-plinth)/recipe.upper)), storey=(h-plinth)/floors;
      for(var side=0;side<4;side++){
        var angle=side*Math.PI/2, sx=Math.sin(angle), sz=Math.cos(angle);
        var span=side%2?d:w, surface=(side%2?w:d)/2;
        var bays=Math.max(1,Math.round(span/recipe.bay));
        var bayWidth=span/bays, mullion=modern ? .035 : (civic ? .11 : .078);
        function facade(u,y,depth,width,height,thick,mat){
          part(parent,mat,x+sz*u+sx*(surface+depth),y,z-sx*u+sz*(surface+depth),width,height,thick,box,angle);
        }
        for(var f=0;f<=floors;f++){
          var y=base+plinth+f*storey;
          facade(0,y,0,span+.012,modern ? .048 : .074,.13,modern?frames:outer);
        }
        for(var j=0;j<=bays;j++){
          var u=-span/2+j*bayWidth;
          facade(u,base+(h+plinth)/2,.021,mullion,Math.max(.14,h-plinth),.135,modern?frames:outer);
        }
        for(var row=0;row<floors;row++)for(var bay=0;bay<bays;bay++){
          var cy=base+plinth+(row+.5)*storey, cx=-span/2+(bay+.5)*bayWidth;
          var pane=hash32(seed+":"+side+":"+row+":"+bay)%5===0?glassPale:glass;
          facade(cx,cy,-.066,bayWidth-mullion*.72,storey*.80,.018,pane);
          if(!modern||w>1.4)facade(cx,cy,-.031,.016,storey*.82,.021,frames);
          if(!modern)facade(cx,cy-storey*.36,.049,bayWidth*.78,.035,.116,concrete);
        }
        if(side===0 && span>1.1){
          var door=span*recipe.door, y0=base+plinth*.50;
          facade(0,y0,-.047,door,plinth*.80,.025,glassPale);
          for(var j2=-1;j2<=1;j2++)facade(j2*door/2,y0,.006,.030,plinth*.85,.05,dark);
          facade(0,base+plinth*.88,.16,door+.20,.055,.37,retail?tealAwning:concrete);
          facade(0,.089,.18,door+.27,.105,.36,concrete);
          facade(0,.063,.30,door+.34,.061,.22,concrete);
          if(civic){
            for(var col=-1;col<=1;col+=2)facade(col*door*.55,base+plinth*.45,.18,.10,plinth*.88,.11,concrete);
          }
        }else{
          facade(0,base+plinth*.52,.003,span-.035,plinth*.95,.15,outer);
        }
      }
      rooftop(parent,x,z,w+.07,d+.07,base+h,style,seed);
      if(modern && h>2.7 && w>=1.65){
        var radius=w*.43, towerX=x-w*.30,towerZ=z+d*.21;
        part(parent,glass,towerX,base+h*.42,towerZ,radius*2,h*.84,radius*2,roundTower);
        part(parent,concrete,towerX,base+h*.85,towerZ,radius*2+.07,.12,radius*2+.07,roundTower);
        for(var band=.50;band<h*.83;band+=.43)
          part(parent,frames,towerX,band,towerZ,radius*2+.031,.026,radius*2+.031,roundTower);
        for(var fin=0;fin<12;fin++){
          var ag=fin*Math.PI/6;
          part(parent,dark,towerX+Math.sin(ag)*radius*.98,base+h*.43,towerZ+Math.cos(ag)*radius*.98,
            .014,h*.79,.044,box,ag);
        }
        obstacles.push({x:wx-w*.30,z:wz+d*.21,w:radius*1.6,d:radius*1.6});
      }
    }
    // 道路、标线和铺装共用同一组路轴。
    var road=STREET, lineY=road.roadY+.012, half=road.halfLane;
    function stroke(x,z,w,d){
      part(scene,white,x,lineY,z,w,.003,d);
    }
    function nearAxis(value, origin) {
      return Math.abs(value-(origin+Math.round((value-origin)/6)*6));
    }
    for(var vi=0;vi<road.x.length;vi++){
      var vx=road.x[vi];
      part(scene,asphalt,vx,road.roadY-.005,3,half*2,.010,36);
      for(var vz=-14.8;vz<21;vz+=.65)if(nearAxis(vz,3)>1.05)stroke(vx,vz,.023,.24);
    }
    for(var hi=0;hi<road.z.length;hi++){
      var hz=road.z[hi];
      part(scene,asphalt,0,road.roadY-.004,hz,39,.010,half*2);
      for(var hx=-19.2;hx<19;hx+=.65)if(nearAxis(hx,0)>1.05)stroke(hx,hz,.24,.023);
    }
    var blockHalf=3-half, radius=road.corner;
    var outline=new T.Shape();
    outline.moveTo(-blockHalf+radius,-blockHalf);
    outline.lineTo(blockHalf-radius,-blockHalf);
    outline.quadraticCurveTo(blockHalf,-blockHalf,blockHalf,-blockHalf+radius);
    outline.lineTo(blockHalf,blockHalf-radius);
    outline.quadraticCurveTo(blockHalf,blockHalf,blockHalf-radius,blockHalf);
    outline.lineTo(-blockHalf+radius,blockHalf);
    outline.quadraticCurveTo(-blockHalf,blockHalf,-blockHalf,blockHalf-radius);
    outline.lineTo(-blockHalf,-blockHalf+radius);
    outline.quadraticCurveTo(-blockHalf,-blockHalf,-blockHalf+radius,-blockHalf);
    var curb=new T.ExtrudeGeometry(outline,{depth:road.curbY-.034,bevelEnabled:false,curveSegments:3});
    curb.rotateX(-Math.PI/2); curb.clearGroups();
    var ramp=new T.BufferGeometry();
    ramp.setAttribute("position",new T.Float32BufferAttribute([
      0,0,-.16,road.slope,road.curbY-road.roadY,-.16,
      0,0,.16,road.slope,road.curbY-road.roadY,.16],3));
    ramp.setAttribute("uv",new T.Float32BufferAttribute([0,0,1,0,0,1,1,1],2));
    ramp.setIndex([0,2,1,1,2,3]); ramp.computeVertexNormals();
    for(var i=0;i<road.x.length;i++)for(var j=0;j<road.z.length;j++){
      var ix=road.x[i], iz=road.z[j];
      for(var edge=-1;edge<=1;edge+=2){
        for(var k=-2;k<=2;k++){
          stroke(ix+k*.154,iz+edge*road.crossing,.079,.27);
          stroke(ix+edge*road.crossing,iz+k*.154,.27,.079);
        }
        stroke(ix,iz+edge*1.04,.88,.023);
        stroke(ix+edge*1.04,iz,.023,.88);
        for(var side=-1;side<=1;side+=2){
          part(scene,sidewalk,ix+side*(half-road.slope),road.roadY+.002,iz+edge*road.crossing,
            1,1,1,ramp,side>0?0:Math.PI);
          part(scene,sidewalk,ix+edge*road.crossing,road.roadY+.002,iz+side*(half-road.slope),
            1,1,1,ramp,side>0?-Math.PI/2:Math.PI/2);
        }
      }
    }
    for(var x=-15;x<=15;x+=6){for(var z=-12;z<=12;z+=6){
      var occupied=null; inst.order.forEach(function(id){var p=inst.places[id];if(Math.abs(p.wx-x)<0.2&&Math.abs(p.wz-z)<0.2)occupied=id;});
      part(scene,sidewalk,x,.034,z,1,1,1,curb);
      if(occupied==='park')continue;
      var seed=x+'block'+z;
      if(!occupied){
        var type=hash32(seed)%2?"office":"housing", rules=BUILDING_STYLES[type];
        var storeys=rules.min+hash32(seed+"floor")%(rules.max-rules.min+1);
        building(scene,x-1.0,z-.90,1.45,1.60,.51+(storeys-1)*rules.upper,type,seed);
        building(scene,x+.90,z+.85,1.75,1.45,.51+(Math.max(3,storeys-1)-1)*.48,"housing",seed+"-rear");
        building(scene,x+1.1,z-1.15,1.0,1.2,0.55+rand01(seed+'3')*0.9,"retail",seed+"-lane");
      }else{
        building(scene,x-1.35,z-1.6,1.1,0.72,0.65,"retail",seed+"-service");
        part(scene,dark,x+1.35,0.07,z-1.55,0.9,0.018,0.8);
        for(var pk=0;pk<3;pk++)part(scene,white,x+1.05+pk*0.25,0.084,z-1.55,0.018,0.005,0.7);
      }
      // Stagger small plants at block corners and leave most of the pavement clear.
      var landscaping=hash32(seed+"plant")%4;
      if(landscaping!==0)plant("tree",x-1.93,.085,z+1.94,.50+landscaping*.067);
      if(landscaping>=2)planter(x+.85,z+1.98,1.04);
    }}
    // 地标使用街区的可见几何，拾取沿用单独的建筑盒。
    inst.order.forEach(function(id){
      var p=inst.places[id], g=new T.Group();
      scene.add(g); p.detail=g; g.position.set(p.wx,0,p.wz);
      if(id==="park")return;
      var style=id==="library"?"civic":(id==="office"||id==="capital"?"office":(id==="rent"?"housing":"retail"));
      building(g,0,0,p.w,p.dp,p.h,style,id);
      if(id==="library"){
        part(g,dark,0,p.h+.169,-.08,p.w*.46,.09,.54);
        part(g,glass,0,p.h+.226,-.08,p.w*.39,.06,.47);
        for(var rib=-1;rib<=1;rib++)part(g,frames,rib*.29,p.h+.268,-.08,.025,.019,.48);
      }else if(id==="capital"){
        rooftop(g,0,-.1,p.w*.58,p.dp*.62,p.h+.54,"office",id+"-crown");
        part(g,glass,0,p.h+.27,-.1,p.w*.54,.48,p.dp*.56);
      }
    });
    // 街角便民店招牌使用原创字样，附在现有商铺体量上。
    var shopSign=document.createElement("canvas"); shopSign.width=256; shopSign.height=64;
    var lettering=shopSign.getContext("2d");
    lettering.fillStyle="#d6a635"; lettering.fillRect(0,0,256,64);
    lettering.fillStyle="#232821"; lettering.font="700 39px Microsoft YaHei,sans-serif";
    lettering.textAlign="center"; lettering.textBaseline="middle"; lettering.fillText("滨河便利",128,34);
    var signage=new T.MeshLambertMaterial({map:newTex(T,shopSign,1,1),color:0xfff2cd});
    part(scene,signage,7.65,.67,-1.22,.89,.195,.018);
    // Central garden: a looping promenade, pond, lawns, trees and seating.
    part(scene,grass,3,0.10,0,4.48,0.12,4.48);
    function path(points,half,material){
      var curve=new T.CatmullRomCurve3(points.map(function(p){return new T.Vector3(p[0],.165,p[1]);}));
      var vertices=[], indices=[], uv=[];
      for(var i=0;i<=64;i++){
        var a=curve.getPoint(i/64), dir=curve.getTangent(i/64);
        vertices.push(a.x-dir.z*half,a.y,a.z+dir.x*half,a.x+dir.z*half,a.y,a.z-dir.x*half);
        uv.push(0,i/8,1,i/8);
        if(i<64){var n=i*2; indices.push(n,n+2,n+1,n+1,n+2,n+3);}
      }
      var geo=new T.BufferGeometry();
      geo.setAttribute("position",new T.Float32BufferAttribute(vertices,3));
      geo.setAttribute("uv",new T.Float32BufferAttribute(uv,2));
      geo.setIndex(indices); geo.computeVertexNormals();
      var mesh=new T.Mesh(geo,material);
      mesh.receiveShadow=true; scene.add(mesh);
    }
    path([[1.4,-1.8],[2.1,-1],[3.5,-0.6],[4.4,0.2],[3.8,1.4],[2.2,1.65],[1.3,0.6],[1.4,-1.8]],.13,sidewalk);
    path([[0.8,0.0],[2,0.25],[3.2,-0.2],[4.2,-1],[5.2,-1]],.10,sidewalk);
    var pond=new T.Mesh(new T.CircleGeometry(0.70,48),water);pond.rotation.x=-Math.PI/2;pond.position.set(3.9,0.17,0.8);pond.scale.set(1,0.70,1);scene.add(pond);
    // Open lawn in the centre, with planted groups clear of the paths.
    [[1.22,-1.72],[4.85,-1.84],[4.91,1.21],[1.04,1.75],[4.62,1.76],[2.45,-1.84]].forEach(function(p,i){
      plant("tree",p[0],.17,p[1],.65+(i%3)*.075);
      plant("fern",p[0]+.20,.17,p[1]-.18,.39+(i%2)*.10);
      plant("fern",p[0]-.18,.17,p[1]+.12,.31+(i%3)*.06);
    });
    [[.91,1.98,1.01],[5.10,1.98,.88],[-.94,4.05,.90],[6.96,3.93,1.02],[-5.16,2.02,.95],[-.85,-1.94,.86]].forEach(function(p){
      plant("palm",p[0],.084,p[1],p[2]);
    });
    for(var bench=0;bench<4;bench++){part(scene,bark,1.4+bench*0.85,0.24,1.95,0.4,0.10,0.17);part(scene,dark,1.4+bench*0.85,0.15,1.95,0.3,0.18,0.04);}
    // 停放车辆朝向车道，路灯与候行区保持距离。
    CURBSIDE_PROPS.forEach(function(prop){
      var cx=prop[0],cz=prop[1],rt=prop[2],s=Math.sin(rt),c=Math.cos(rt);
      var paint=prop[3]?carMats[1]:carMats[0];
      part(scene,paint,cx,.137,cz,.49,.096,.236,box,rt);
      part(scene,glass,cx-.038*c,.213,cz+.038*s,.28,.078,.193,box,rt);
      part(scene,paint,cx-.042*c,.253,cz+.042*s,.208,.019,.177,box,rt);
      for(var wheel=-1;wheel<=1;wheel+=2)for(var tire=-1;tire<=1;tire+=2){
        part(scene,dark,cx+c*wheel*.148+s*tire*.106,.091,cz-s*wheel*.148+c*tire*.106,.077,.082,.035,box,rt);
      }
      part(scene,white,cx+c*.248,.153,cz-s*.248,.017,.028,.180,box,rt);
    });
    // 等距总览保留行人的尺度参照，步行视角继续使用原有动画人物。
    var pedestrianCoat=new T.MeshLambertMaterial({color:0x6d8077});
    plain.push(pedestrianCoat);
    [[-.83,1.77,.15],[1.20,2.29,.55],[5.17,-.94,.76],[-4.81,3.80,.43],
      [6.85,3.88,.31],[7.50,-2.17,.61],[-5.15,-2.21,.52]].forEach(function(person){
      var x=person[0],z=person[1],y=streetHeight(x,z),ang=person[2]*Math.PI;
      part(scene,pedestrianCoat,x,y+.282,z,.103,.18,.077,box,ang);
      part(scene,concrete,x,y+.403,z,.066,.070,.067,box,ang);
      for(var shoe=-1;shoe<=1;shoe+=2)
        part(scene,dark,x+Math.cos(ang)*shoe*.029,y+.103,z-Math.sin(ang)*shoe*.029,.045,.178,.047,box,ang);
    });
    for(var lx=-12;lx<=12;lx+=6)for(var lz=-9;lz<=15;lz+=6){
      part(scene,dark,lx+.82,.406,lz+1.17,.027,.65,.027);
      part(scene,dark,lx+.725,.722,lz+1.17,.204,.021,.028);
      part(scene,white,lx+.633,.705,lz+1.17,.065,.026,.063);
    }
    Object.keys(buckets).forEach(function(k){
      var b=buckets[k], mesh=new T.InstancedMesh(b.geometry,b.material,b.matrices.length);
      b.matrices.forEach(function(matrix,i){mesh.setMatrixAt(i,matrix);});
      if(b.colors.some(function(color){return !!color;})){
        var neutral=new T.Color(0xffffff);
        b.colors.forEach(function(color,i){mesh.setColorAt(i,color||neutral);});
      }
      mesh.receiveShadow=b.material!==contactMat; mesh.frustumCulled=false;
      if(b.material===contactMat){
        mesh.name="contact-shadow";
        mesh.renderOrder=2;
      } else if(b.material===asphalt)mesh.name="street-asphalt";
      else if(b.material===sidewalk && b.geometry===curb)mesh.name="street-curb";
      else if(b.material===sidewalk && b.geometry===ramp)mesh.name="street-ramp";
      else if(b.material===sharedPlain && b.geometry===box)mesh.name="street-markings-and-props";
      scene.add(mesh); meshes.push(mesh);
    });
    var shadowMaterial=new T.MeshBasicMaterial({colorWrite:false,depthWrite:false});
    var cityShadows=new T.InstancedMesh(box,shadowMaterial,shadowMatrices.length);
    shadowMatrices.forEach(function(matrix,i){cityShadows.setMatrixAt(i,matrix);});
    cityShadows.name="district-shadow-proxy";
    cityShadows.castShadow=true; cityShadows.frustumCulled=false;
    scene.add(cityShadows);
    inst.cityMeshes=meshes;
    // A compact district legend, outside the interaction layer.
    var legend=document.createElement('div');legend.setAttribute('data-map3d-hud','1');
    legend.style.cssText='position:absolute;left:24px;top:22px;pointer-events:none;color:#fff;text-shadow:0 2px 8px #243238;font-family:Microsoft YaHei,sans-serif;padding:12px 16px;background:linear-gradient(100deg,rgba(19,31,34,.70),rgba(19,31,34,0));border-left:2px solid #cfbf84';
    legend.innerHTML='<div style="font-size:11px;letter-spacing:4px;opacity:.8">RESTART · CITY DISTRICT</div><div style="font-size:25px;font-weight:700;letter-spacing:3px;margin:5px 0">重启人生 · 城市漫游</div><div style="font-size:11px;opacity:.85">● 金色标记可前往　 ·　拖拽旋转 / 滚轮缩放</div>';
    inst.el.appendChild(legend); inst.cityLegend = legend;
  }

  /** 恢复旧版剧情邻接线与网格材质，复用现有地点坐标和抽象楼体。 */
  function buildAbstractStyle(inst) {
    var T = inst.T;
    var groundMap = newTex(T, makeGroundCanvas(true), 9, 7);
    groundMap.anisotropy = aniso(inst.renderer);
    var edges = buildEdges(inst.opts.places, inst.opts.nodes);
    if (edges.length) {
      var road = new T.InstancedMesh(
        new T.BoxGeometry(1, 1, 1),
        new T.MeshLambertMaterial({ color: 0x24223c, emissive: 0x0b0b1c }),
        edges.length
      );
      road.name = "abstract-roads";
      road.layers.set(PICK_LAYER);
      road.frustumCulled = false;
      for (var i = 0; i < edges.length; i++) {
        var a = inst.places[edges[i][0]], b = inst.places[edges[i][1]];
        var dx = b.wx - a.wx, dz = b.wz - a.wz;
        _q0.setFromAxisAngle(_axisY, Math.atan2(-dz, dx));
        _m4.compose(_v3.set((a.wx + b.wx) / 2, 0.015, (a.wz + b.wz) / 2),
          _q0, _v3b.set(hypot(dx, dz) + 0.52, 0.05, 0.28));
        road.setMatrixAt(i, _m4);
      }
      road.instanceMatrix.needsUpdate = true;
      inst.scene.add(road);
    }
    inst.abstractEdges = edges;
    inst.abstractGroundMap = groundMap;
  }

  function setStyle(inst, style) {
    if (style !== "abstract" && style !== "realistic") return false;
    if (style === inst.style) return true;
    var abstractStyle = style === "abstract";
    if (abstractStyle && !inst.abstractGroundMap) buildAbstractStyle(inst);
    inst.style = style;
    inst.district.visible = !abstractStyle;
    inst.ground.material.map = abstractStyle ? inst.abstractGroundMap : inst.districtGroundMap;
    if (inst.edge) inst.edge.visible = abstractStyle;
    inst.streetHeight = abstractStyle ? abstractStreetHeight : streetHeight;
    syncStyleCamera(inst, inst.camera);
    if (inst.walk) syncStyleCamera(inst, inst.walk.camera);
    syncCityLegend(inst);
    inst.miniDirty = true;
    inst.shadowDirty = true;
    return true;
  }

  function abstractStreetHeight() { return 0.04; }

  function syncStyleCamera(inst, camera) {
    if (inst.style === "abstract") camera.layers.enable(PICK_LAYER);
    else camera.layers.disable(PICK_LAYER);
  }

  function syncCityLegend(inst) {
    if (inst.cityLegend) inst.cityLegend.hidden = inst.style === "abstract" || inst.mode === "walk";
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
    var dy = 0;
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
    return changed;
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
        var placeId = nd && inst.places[nd.loc] ? nd.loc : a;
        if (inst.places[placeId] && !availByPlace[placeId]) availByPlace[placeId] = a;
      }

      var batchesDirty = !inst.batchesBuilt;
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
        if (setPlaceState(inst, p, state, nid)) batchesDirty = true;
      }
      if(batchesDirty) inst.miniDirty=true;
      if (batchesDirty) {
        rebuildBatches(inst);
        inst.batchesBuilt = true;
      }
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
    if(inst.miniNight!==!!m.night){inst.miniNight=!!m.night;inst.miniDirty=true;}
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
      if(inst.cityOverlay){
        inst.overlayRatio=Math.min(global.devicePixelRatio || 1,2);
        inst.cityOverlay.width=Math.round(s.w*inst.overlayRatio);
        inst.cityOverlay.height=Math.round(s.h*inst.overlayRatio);
      }
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
      if (inst.walk) inst.walk.resize(s.w/s.h);
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
          if (inst.pinch.d > 6 && d > 6) {
            if (inst.mode === "walk") {
              inst.walk.zoom(-Math.log(d/inst.pinch.d)/0.0012);
              inst.pinch.d=d;
            } else setZoom(inst, inst.pinch.z * (d / inst.pinch.d));
          }
          return;
        }
        if (inst.drag && ev.pointerId === inst.drag.id) {
          var dx = ev.clientX - inst.drag.x, dy = ev.clientY - inst.drag.y;
          inst.drag.moved += Math.abs(dx) + Math.abs(dy);
          inst.drag.x = ev.clientX; inst.drag.y = ev.clientY;
          if (inst.mode === "walk") inst.walk.rotate(dx);
          else {
            inst.tYaw -= dx * 0.0062;
            inst.tPitch = clamp(inst.tPitch + dy * 0.0050, 0.20, TOP_PITCH);
          }
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
          if (ev.type === "pointerup" && wasDrag.moved < 8 && (nowMs() - wasDrag.t) < 700) pick(inst, ev.clientX, ev.clientY, true);
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
        if (inst.mode === "walk") inst.walk.zoom(d);
        else setZoom(inst, inst.tZoom * Math.exp(-d * 0.0012));
      } catch (e) {}
    }, { passive: false });

    on(global, "keydown", function (ev) {
      if (!inst.active || inst.mode !== "walk" || ev.ctrlKey || ev.metaKey || ev.altKey || ev.defaultPrevented) return;
      var el=ev.target;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (inst.walk.key(ev.code,true,ev.repeat)) ev.preventDefault();
    });
    on(global, "keyup", function (ev) { if (inst.walk) inst.walk.key(ev.code,false,false); });
    on(global, "blur", function () { if (inst.walk) inst.walk.release(); });
    on(global.document, "visibilitychange", function () { if (inst.walk && global.document.hidden) inst.walk.release(); });

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
      _ray.setFromCamera(_ndc, viewCamera(inst));
      var p = rayPlace(inst);
      if (click && inst.mode === "walk") {
        if (p && p.state==="avail") walkToPlace(inst,p);
        else inst.walk.click(_ray.ray);
        return;
      }
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
    _ray.layers.set(PICK_LAYER);
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
    if (!inst || inst.disposed || !inst.active) return;
    inst.raf = global.requestAnimationFrame(function (t) { tick(inst, t); });
    try {
      if (global.document && global.document.hidden) return;

      var t = (typeof now === "number" ? now : nowMs()) * 0.001;
      var elapsed = t - inst.t;
      var dt = clamp(elapsed, 0.0001, 0.05);
      inst.t = t;
      inst.frame++;

      // 兜底尺寸检查（display:none → block 时 ResizeObserver 偶有延迟）
      if ((inst.frame % 20) === 0) resize(inst, false);

      stepMood(inst, dt);
      if (inst.mode === "walk") inst.walk.tick(clamp(elapsed,0.0001,0.16), t);
      else updateCamera(inst, dt);

      // 悬停拾取（节流 1/3 帧，拖拽中跳过）
      if (inst.hoverEnabled && !inst.drag && !inst.pinch && inst.pointerNDC && (inst.frame % 3) === 0) {
        try {
          _ndc.set(inst.pointerNDC.x, inst.pointerNDC.y);
          _ray.setFromCamera(_ndc, viewCamera(inst));
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
          var walking=inst.mode==="walk";
          p.label.visible=!walking || p.state==="avail" || hypot(p.wx-inst.walk.x,p.wz-inst.walk.z)<5.6;
          var baseH = walking ? 0.41 : 0.62, baseW = LABEL_W / LABEL_H * baseH;
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

  function viewCamera(inst) { return inst.mode==="walk" ? inst.walk.camera : inst.camera; }

  function walkToPlace(inst,p) {
    if (!inst || !p || inst.mode!=="walk" || p.state!=="avail") return false;
    var node=p.nodeId;
    return inst.walk.goTo(p,function(){
      if (p.state==="avail" && p.nodeId===node && inst.active && inst.opts.onPick) inst.opts.onPick(p.id,node);
    });
  }

  function drawCityOverlay(inst,cam) {
    var g=inst.cityOverlayCtx;
    if(!g)return;
    var w=inst.size.w,h=inst.size.h, ratio=inst.overlayRatio || 1;
    g.setTransform(ratio,0,0,ratio,0,0);
    g.clearRect(0,0,w,h);
    for(var i=0;i<inst.order.length;i++){
      var p=inst.places[inst.order[i]], label=p.label;
      if(!label || !label.visible || !p.lblCanvas)continue;
      var point=inst.projectedLabel.copy(label.position).project(cam);
      if(point.z<-1||point.z>1)continue;
      var scale=cam.isPerspectiveCamera ?
        h*.5*cam.projectionMatrix.elements[5]/Math.max(.25,-inst.projectedLabel.copy(label.position).applyMatrix4(cam.matrixWorldInverse).z) :
        h*cam.zoom/(cam.top-cam.bottom);
      point.copy(label.position).project(cam);
      var bw=label.scale.x*scale, bh=label.scale.y*scale;
      if(p.state==="avail"){
        g.strokeStyle="#efc571";g.lineWidth=1.15;
        var gx=(point.x+1)*w*.5,gy=(1-point.y)*h*.5;
        g.globalAlpha=.48+.21*Math.sin(inst.t*3);
        g.beginPath();g.moveTo(gx,gy+bh*.30);g.lineTo(gx,gy+bh*.93);g.stroke();
      }
      g.globalAlpha=p.lblMat.opacity;
      g.drawImage(p.lblCanvas,(point.x+1)*w*.5-bw*.5,(1-point.y)*h*.5-bh*.5,bw,bh);
    }
    g.globalAlpha=1;
    if(w<=MM_SIZE+MM_MARGIN*2+40||h<=MM_SIZE+MM_MARGIN*2+20)return;
    if(inst.miniDirty){
      var mini=inst.miniCanvas.getContext("2d");
      mini.fillStyle=inst.miniNight?"#203339":"#686c60";
      mini.fillRect(0,0,MM_SIZE,MM_SIZE);
      var z0=MM_SIZE/2-3*3, x0=MM_SIZE/2;
      mini.fillStyle=inst.miniNight?"#31484f":"#3b4849";
      if (inst.style === "abstract") {
        mini.strokeStyle = "#77729c";
        mini.lineWidth = 1;
        mini.beginPath();
        inst.abstractEdges.forEach(function (edge) {
          var a = inst.places[edge[0]], b = inst.places[edge[1]];
          mini.moveTo(x0+a.wx*3,z0+a.wz*3);
          mini.lineTo(x0+b.wx*3,z0+b.wz*3);
        });
        mini.stroke();
      } else {
        for(var ix=0;ix<STREET.x.length;ix++)mini.fillRect(x0+STREET.x[ix]*3-1.5,0,3,MM_SIZE);
        for(var iz=0;iz<STREET.z.length;iz++)mini.fillRect(0,z0+STREET.z[iz]*3-1.5,MM_SIZE,3);
      }
      for(var id in inst.places){
        var p0=inst.places[id];
        mini.fillStyle=p0.state==="avail"?"#ffce64":(p0.id==="park"?"#76905b":"#bcc0ad");
        mini.fillRect(x0+p0.wx*3-2,z0+p0.wz*3-2,4,4);
      }
      inst.miniDirty=false;
    }
    var left=w-MM_SIZE-MM_MARGIN,top=h-MM_SIZE-MM_MARGIN;
    g.drawImage(inst.miniCanvas,left,top);
    if(inst.mode==="walk"){
      g.fillStyle="#88ffdc";g.beginPath();
      g.arc(left+MM_SIZE*.5+inst.walk.x*3,top+MM_SIZE*.5+(inst.walk.z-3)*3,2.7,0,Math.PI*2);g.fill();
    }
  }

  function render(inst) {
    var renderer=inst.renderer, scene=inst.scene, cam=viewCamera(inst);
    if(!renderer||!scene||!cam)return;
    var shadows=renderer.shadowMap;
    shadows.autoUpdate=false;
    if(inst.shadowDirty || (inst.mode==="walk" && inst.frame%3===0)){
      shadows.needsUpdate=true; inst.shadowDirty=false;
    }
    renderer.setViewport(0,0,inst.size.w,inst.size.h);
    renderer.render(scene,cam);
    drawCityOverlay(inst,cam);
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
      var inactiveGroundMap = inst.style === "abstract" ? inst.districtGroundMap : inst.abstractGroundMap;
      if (inactiveGroundMap) inactiveGroundMap.dispose();
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
      if(inst.cityOverlay&&inst.cityOverlay.parentNode)inst.cityOverlay.parentNode.removeChild(inst.cityOverlay);
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
        hoverId: null, hoverEnabled: true, active: false, raf: 0, ro: null,
        t: 0, frame: 0, size: { w: 0, h: 0 },
        moodKey: MOOD_FALLBACK, moodCur: null, moodTo: null, moodFrom: null, moodT: 1,
        style: "realistic", mode: "orbit", yaw: ISO_YAW, pitch: ISO_PITCH, zoom: 1,
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
      if (opts.style === "abstract") setStyle(inst, opts.style);
      bindEvents(inst);                       // 交互
      resize(inst, true);
      applyMood(inst, MOOD_FALLBACK, true);   // 初始氛围
      inst.ready = true;                      // refresh 需要 ready
      refresh(inst, { done: [], avail: null });

      current = inst;
      setActive(inst, opts.active !== false);
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

  function setActive(inst, active) {
    if (!inst || !inst.ready || inst.active === active) return false;
    inst.active = active;
    if (active) {
      inst.t = nowMs() * 0.001;
      resize(inst, false);
      inst.raf = global.requestAnimationFrame(function (t) { tick(inst, t); });
    } else {
      global.cancelAnimationFrame(inst.raf);
      inst.raf = 0;
      inst.hoverId = null;
      inst.pointerNDC = null;
      inst.drag = inst.pinch = null;
      inst.pointers = {};
      if (inst.walk) inst.walk.release();
    }
    return true;
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

    setStyle: function (style) {
      try {
        return !!(current && current.ready && setStyle(current, style));
      } catch (e) { return false; }
    },

    setActive: function (active) { return setActive(current, !!active); },

    resetView: function () {
      if (!current || !current.ready) return false;
      current.tZoom = 1;
      if (current.mode==="walk") { current.walk.resetView(); return true; }
      return Map3D.setMode(current.mode);
    },

    setMode: function (mode) {
      try {
        if (!current || !current.ready) return false;
        var m = String(mode === undefined || mode === null ? "" : mode).toLowerCase();
        if (m === "walk") {
          if (!global.CityWalk) return false;
          if (!current.walk) {
            current.walk=global.CityWalk.create(current,current.walkObstacles);
            current.walk.resize(current.size.w/current.size.h);
            syncStyleCamera(current, current.walk.camera);
          }
          current.mode="walk";
          current.walk.setEnabled(true);
          syncCityLegend(current);
          return true;
        }
        if (m === "top" || m === "plan" || m === "俯视") {
          if (current.walk) current.walk.setEnabled(false);
          current.mode = "top";
          syncCityLegend(current);
          current.tPitch = TOP_PITCH;
          current.tYaw = 0;
          return true;
        }
        if (m === "orbit" || m === "iso" || m === "3d" || m === "等距") {
          if (current.walk) current.walk.setEnabled(false);
          current.mode = "orbit";
          syncCityLegend(current);
          current.tPitch = ISO_PITCH;
          current.tYaw = ISO_YAW;
          return true;
        }
        return false;
      } catch (e) { return false; }
    },

    walkTo: function (placeId) { return current ? walkToPlace(current,current.places[placeId]) : false; },

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
          ready: true, version: VERSION, mood: current.moodKey, mode: current.mode, style: current.style,
          active: current.active, frame: current.frame, count: current.order.length, size: { w: current.size.w, h: current.size.h },
          batches: current.batches.length, states: states,
          player: current.walk ? current.walk.info() : null,
          planting: current.planting, plantTextures: current.vegetation ? current.vegetation.ready() : 0
        };
      } catch (e) { return { ready: false, version: VERSION }; }
    }
  };

  try { global.Map3D = Map3D; } catch (e) { /* 全局被冻结时静默 */ }

})(typeof window !== "undefined" ? window : this);
