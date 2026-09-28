/*
  canvas-sink.cjs —— 一个"够用的最小 canvas 2D"，把真实 Fight2Stage 的绘制调用落到像素缓冲上。
  从 tools/dev/stage-preview.js 里抽出来共用：MP4 样片和立绘贴图预览都需要它。

  ⚠ 这不是像素级还原，定位是"近似预览"：渐变按分段近似、文字用色块占位、没有抗锯齿。
     它存在的唯一理由是：无头环境没有 canvas，而"机制真的驱动了画面"必须能被看到。

  踩过的坑（都曾伪造出并不存在的设计问题）：
    ① fillStyle 可能是**渐变对象**而不是字符串 —— 不处理会回落成白色，整个天幕被刷白；
    ② 粗线段要**沿法线铺宽度** —— 只按 y 偏移画的话，粗手臂会退化成 2px 细线，人物"没有身体"；
    ③ drawImage 要支持 translate+scale（含镜像）的完整仿射 —— 立绘的倒影是 scale(1,-0.42) 画的，
       只按缩放算会画到天上；采样用**前向映射**（逐源像素打到目标），做缩小时不会漏采样。
*/
const { styleOf } = (() => {
  function styleOf(s) {
    if (s && typeof s === "object" && typeof s.at === "function") return s.at(0.5);
    if (typeof s !== "string") return [255, 255, 255, 1];
    const t = s.trim();
    if (t[0] === "#") {
      let h = t.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0, 1];
    }
    const m = /rgba?\(([^)]+)\)/.exec(t);
    if (m) {
      const a = m[1].split(",").map((x) => parseFloat(x));
      return [a[0] || 0, a[1] || 0, a[2] || 0, a.length > 3 ? a[3] : 1];
    }
    if (t === "white") return [255, 255, 255, 1];
    if (t === "black") return [0, 0, 0, 1];
    return [255, 255, 255, 1];
  }
  return { styleOf };
})();

/**
 * 5×7 点阵字体（只有 ASCII）。
 * 为什么需要：最小 canvas 没有字体，原先 fillText 用"实心色块"占位 ——
 * 那让所有预览图里的文字都变成砖头（卡牌名、血量、KO 文案全糊成方块）。
 * 有了它，预览图里的英文与数字能认出来；**中文仍然是色块**（点阵表不可能覆盖汉字），
 * 实机走浏览器字体不受影响。
 */
const FONT5x7 = {
  "0":"01110 10001 10011 10101 11001 10001 01110", "1":"00100 01100 00100 00100 00100 00100 01110",
  "2":"01110 10001 00001 00010 00100 01000 11111", "3":"11111 00010 00100 00010 00001 10001 01110",
  "4":"00010 00110 01010 10010 11111 00010 00010", "5":"11111 10000 11110 00001 00001 10001 01110",
  "6":"00110 01000 10000 11110 10001 10001 01110", "7":"11111 00001 00010 00100 01000 01000 01000",
  "8":"01110 10001 10001 01110 10001 10001 01110", "9":"01110 10001 10001 01111 00001 00010 01100",
  A:"01110 10001 10001 11111 10001 10001 10001", B:"11110 10001 10001 11110 10001 10001 11110",
  C:"01110 10001 10000 10000 10000 10001 01110", D:"11110 10001 10001 10001 10001 10001 11110",
  E:"11111 10000 10000 11110 10000 10000 11111", F:"11111 10000 10000 11110 10000 10000 10000",
  G:"01110 10001 10000 10111 10001 10001 01111", H:"10001 10001 10001 11111 10001 10001 10001",
  I:"01110 00100 00100 00100 00100 00100 01110", J:"00111 00010 00010 00010 00010 10010 01100",
  K:"10001 10010 10100 11000 10100 10010 10001", L:"10000 10000 10000 10000 10000 10000 11111",
  M:"10001 11011 10101 10101 10001 10001 10001", N:"10001 11001 10101 10011 10001 10001 10001",
  O:"01110 10001 10001 10001 10001 10001 01110", P:"11110 10001 10001 11110 10000 10000 10000",
  Q:"01110 10001 10001 10001 10101 10010 01101", R:"11110 10001 10001 11110 10100 10010 10001",
  S:"01111 10000 10000 01110 00001 00001 11110", T:"11111 00100 00100 00100 00100 00100 00100",
  U:"10001 10001 10001 10001 10001 10001 01110", V:"10001 10001 10001 10001 10001 01010 00100",
  W:"10001 10001 10001 10101 10101 11011 10001", X:"10001 10001 01010 00100 01010 10001 10001",
  Y:"10001 10001 01010 00100 00100 00100 00100", Z:"11111 00001 00010 00100 01000 10000 11111",
  "+":"00000 00100 00100 11111 00100 00100 00000", "-":"00000 00000 00000 11111 00000 00000 00000",
  "!":"00100 00100 00100 00100 00100 00000 00100",
  ".":"00000 00000 00000 00000 00000 01100 01100", ":":"00000 01100 01100 00000 01100 01100 00000",
  "/":"00001 00010 00010 00100 01000 01000 10000", "%":"11001 11010 00010 00100 01000 01011 10011",
  "(":"00010 00100 01000 01000 01000 00100 00010", ")":"01000 00100 00010 00010 00010 00100 01000",
  " ":"00000 00000 00000 00000 00000 00000 00000",
};
const glyph = (ch) => FONT5x7[ch] || FONT5x7[String(ch).toUpperCase()] || null;

/** @param {number} W 画布宽 @param {number} H 画布高 @param {number} scale 全局显示缩放
 *  @param {{alphaTrack?:boolean}} [opts] alphaTrack：额外维护一份"每像素被写过的最大 alpha"。
 *    立绘对照图必须靠它把**地面倒影**（globalAlpha 0.18 画的）从量测里排除 ——
 *    倒影会让内容的像素范围一路向下延伸，直接量最低点会得出"人物低于地面 182px"的假结论。 */
function makeSink(W, H, scale = 1, opts = {}) {
  const px = Buffer.alloc(W * H * 3, 0);
  const amax = opts.alphaTrack ? new Float32Array(W * H) : null;
  /* 开关：背景/地面线是**全不透明**填的，若把它们的 alpha 也记进 amax，
     整块画布都会变成"实心"，量测就失去意义。所以只在画人物那一遍打开它。 */
  let alphaOn = !!opts.alphaTrack;
  /* 真正"落笔"的像素包围盒（设备坐标、已过裁剪）。
     与 PIX（记录**调用参数**的变换后坐标、不过裁剪）不同：
     世界本来就比屏幕宽，用调用坐标去断言"没溢出屏幕"必然误报 —— 要看的是落笔。 */
  const paint = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, n: 0 };
  const paintBox = () => (paint.n ? { minX: paint.minX, maxX: paint.maxX, minY: paint.minY, maxY: paint.maxY, n: paint.n } : null);
  const paintReset = () => { paint.minX = paint.minY = Infinity; paint.maxX = paint.maxY = -Infinity; paint.n = 0; };
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

  const mkGrad = () => {
    const stops = [];
    return {
      stops,
      addColorStop: (p, c) => stops.push([p, styleOf(c)]),
      at: (p) => {
        if (!stops.length) return [0, 0, 0, 1];
        let a = stops[0], b = stops[stops.length - 1];
        for (let i = 0; i < stops.length - 1; i++)
          if (p >= stops[i][0] && p <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
        const span = (b[0] - a[0]) || 1, k = Math.max(0, Math.min(1, (p - a[0]) / span));
        return [0, 1, 2, 3].map((i) => a[1][i] + (b[1][i] - a[1][i]) * k);
      },
    };
  };

  const setPx = (x, y, rgba, alpha) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    if (!inClip(x, y)) return;
    const a = rgba[3] * alpha; if (a <= 0) return;
    if (amax && alphaOn) { const k = y * W + x; if (a > amax[k]) amax[k] = a; }
    if (x < paint.minX) paint.minX = x;
    if (x > paint.maxX) paint.maxX = x;
    if (y < paint.minY) paint.minY = y;
    if (y > paint.maxY) paint.maxY = y;
    paint.n++;
    const i = (y * W + x) * 3;
    px[i] = px[i] * (1 - a) + rgba[0] * a;
    px[i + 1] = px[i + 1] * (1 - a) + rgba[1] * a;
    px[i + 2] = px[i + 2] * (1 - a) + rgba[2] * a;
  };

  const M = { m: [scale, 0, 0, scale, 0, 0], st: [] };
  const tf = (x, y) => { const m = M.m; return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; };
  const path = [];
  let arc = null;
  let ell = null;
  let rectP = null;
  /* 裁剪矩形（设备坐标）。街机机身要求"世界只画在 CRT 屏内"，
     所以 clip() 必须真的生效 —— 否则相机推近时屏外内容会盖住机壳。
     只支持矩形裁剪（stage 只用到 rect），与 save/restore 一起进出栈。 */
  let clip = null;
  const inClip = (x, y) => {
    if (!clip) return true;
    return x >= clip.x0 && x <= clip.x1 && y >= clip.y0 && y <= clip.y1;
  };

  const ctx = {
    canvas: { width: W, height: H },
    globalAlpha: 1, fillStyle: "#000", strokeStyle: "#000", lineWidth: 1,
    lineCap: "butt", lineJoin: "miter", font: "", textAlign: "left", textBaseline: "alphabetic",
    imageSmoothingEnabled: true,
    save() { M.st.push([M.m.slice(), ctx.globalAlpha, ctx.fillStyle, ctx.strokeStyle, ctx.lineWidth, clip]); },
    restore() {
      const s = M.st.pop();
      if (s) { M.m = s[0]; ctx.globalAlpha = s[1]; ctx.fillStyle = s[2];
               ctx.strokeStyle = s[3]; ctx.lineWidth = s[4]; clip = s[5]; }
    },
    setTransform(a, b, c, d, e, f) { M.m = [a, b, c, d, e, f]; },
    /** 调试用：当前变换矩阵（tools/dev/sprite-sheet.js 的 SHEET_DEBUG 会读它） */
    __m() { return M.m.slice(); },
    /** alphaTrack 开关：画背景/地面线时关、画人物时开 */
    __alphaTrack(on) { alphaOn = !!on; },
    resetTransform() { M.m = [1, 0, 0, 1, 0, 0]; },
    translate(x, y) { const m = M.m; M.m = [m[0], m[1], m[2], m[3], m[4] + m[0] * x + m[2] * y, m[5] + m[1] * x + m[3] * y]; },
    scale(x, y) { const m = M.m; M.m = [m[0] * x, m[1] * x, m[2] * y, m[3] * y, m[4], m[5]]; },
    clearRect() { px.fill(0); if (amax) amax.fill(0); },
    createLinearGradient() { return mkGrad(); },
    createRadialGradient() { return mkGrad(); },
    fillRect(x, y, w, h) {
      const sty = ctx.fillStyle, isGrad = sty && typeof sty === "object" && typeof sty.at === "function";
      const p0 = tf(x, y), p1 = tf(x + w, y + h);
      const x0 = Math.min(p0[0], p1[0]), x1 = Math.max(p0[0], p1[0]);
      const y0 = Math.min(p0[1], p1[1]), y1 = Math.max(p0[1], p1[1]);
      const bands = isGrad ? 20 : 1;
      for (let b = 0; b < bands; b++) {
        const c = isGrad ? sty.at(b / Math.max(1, bands - 1)) : styleOf(sty);
        const by0 = y0 + (y1 - y0) * (b / bands), by1 = y0 + (y1 - y0) * ((b + 1) / bands);
        for (let yy = Math.max(0, Math.floor(by0)); yy < Math.min(H, Math.ceil(by1)); yy++)
          for (let xx = Math.max(0, Math.floor(x0)); xx < Math.min(W, Math.ceil(x1)); xx++) setPx(xx, yy, c, ctx.globalAlpha);
      }
    },
    strokeRect(x, y, w, h) {
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h); ctx.lineTo(x, y); ctx.stroke();
    },
    /** 路径：moveTo / lineTo / arc / ellipse 都往这里**采样成多边形点**。
        ⚠ 为什么必须采样而不是只记"最后一个 arc"：卡牌的圆角矩形是
          `moveTo/lineTo/arc×4/closePath + fill` 拼出来的，
          只认最后一个 arc 的话整张卡底都画不出来（实测预览图里卡只剩几个小圆弧）。 */
    beginPath() { path.length = 0; arc = null; ell = null; rectP = null; pathClosed = false; },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    rect(x, y, w, h) {
      rectP = [x, y, w, h];
      path.push([x, y], [x + w, y], [x + w, y + h], [x, y + h]);   // 也进路径，便于 fill
      pathClosed = true;
    },
    arc(x, y, r, a0, a1) {
      arc = [x, y, r]; ell = null;
      const s = (a0 === undefined ? 0 : a0), e2 = (a1 === undefined ? Math.PI * 2 : a1);
      const steps = Math.max(6, Math.ceil(Math.abs(e2 - s) / (Math.PI / 16)));
      for (let i = 0; i <= steps; i++) {
        const t = s + (e2 - s) * (i / steps);
        path.push([x + Math.cos(t) * r, y + Math.sin(t) * r]);
      }
    },
    ellipse(x, y, rx, ry, rot, a0, a1) {
      ell = [x, y, rx, ry]; arc = null;
      const s = (a0 === undefined ? 0 : a0), e2 = (a1 === undefined ? Math.PI * 2 : a1);
      const steps = Math.max(6, Math.ceil(Math.abs(e2 - s) / (Math.PI / 16)));
      for (let i = 0; i <= steps; i++) {
        const t = s + (e2 - s) * (i / steps);
        path.push([x + Math.cos(t) * rx, y + Math.sin(t) * ry]);
      }
    },
    closePath() { pathClosed = true; },
    /** 矩形裁剪：与已有裁剪求交（只支持矩形，够 stage 用） */
    clip() {
      if (!rectP) return;
      const a = tf(rectP[0], rectP[1]), b = tf(rectP[0] + rectP[2], rectP[1] + rectP[3]);
      const r = { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]),
                  x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
      clip = clip ? { x0: Math.max(clip.x0, r.x0), y0: Math.max(clip.y0, r.y0),
                      x1: Math.min(clip.x1, r.x1), y1: Math.min(clip.y1, r.y1) } : r;
    },
    stroke() {
      const c = styleOf(ctx.strokeStyle), w = num(ctx.lineWidth) || 1;
      const pt0 = path.map(([x, y]) => tf(x, y));
      /* 路径优先（圆角矩形/多边形都走这条）；路径太短才回落到单独的圆 */
      if (pt0.length >= 2) {
        const pt = pathClosed && pt0.length > 2 ? pt0.concat([pt0[0]]) : pt0;
        for (let i = 0; i < pt.length - 1; i++) {                       // 沿法线铺宽度
          const [x0, y0] = pt[i], [x1, y1] = pt[i + 1];
          const len = Math.hypot(x1 - x0, y1 - y0); if (len < 0.01) continue;
          const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
          const steps = Math.max(1, Math.ceil(len));
          for (let s = 0; s <= steps; s++) {
            const bx = x0 + (x1 - x0) * s / steps, by = y0 + (y1 - y0) * s / steps;
            for (let o = -w / 2; o <= w / 2; o += 0.9) setPx(bx + nx * o, by + ny * o, c, ctx.globalAlpha);
          }
        }
        return;
      }
      if (arc) {
        const [ax, ay] = tf(arc[0], arc[1]);
        const rr = arc[2] * Math.abs(M.m[0]);
        const step = Math.max(0.006, 1.3 / Math.max(2, rr));
        for (let t = 0; t < Math.PI * 2; t += step)
          for (let o = -w / 2; o <= w / 2; o += 0.8) setPx(ax + Math.cos(t) * (rr + o), ay + Math.sin(t) * (rr + o), c, ctx.globalAlpha);
      }
    },
    fill() {
      const c = styleOf(ctx.fillStyle);
      /* 路径优先：扫描线填充多边形（圆角矩形、三角、任意路径都能画） */
      if (path.length >= 3) {
        const pt = path.map(([x, y]) => tf(x, y));
        let minY = 1e9, maxY = -1e9;
        pt.forEach((p) => { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
        for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
          const xs = [];
          for (let i = 0; i < pt.length; i++) {
            const [x1, y1] = pt[i], [x2, y2] = pt[(i + 1) % pt.length];
            if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
          }
          xs.sort((a, b) => a - b);
          for (let k = 0; k + 1 < xs.length; k += 2)
            for (let x = Math.floor(xs[k]); x <= Math.ceil(xs[k + 1]); x++) setPx(x, y, c, ctx.globalAlpha);
        }
        return;
      }
      if (arc) {
        const [ax, ay] = tf(arc[0], arc[1]);
        const rr = arc[2] * Math.abs(M.m[0]);
        for (let yy = -rr; yy <= rr; yy++) for (let xx = -rr; xx <= rr; xx++)
          if (xx * xx + yy * yy <= rr * rr) setPx(ax + xx, ay + yy, c, ctx.globalAlpha);
        return;
      }
      if (ell) {
        const [ax, ay] = tf(ell[0], ell[1]);
        const rx = Math.abs(ell[2] * M.m[0]), ry = Math.abs(ell[3] * M.m[3]);
        if (rx < 0.5 || ry < 0.5) return;
        for (let yy = -ry; yy <= ry; yy++) for (let xx = -rx; xx <= rx; xx++)
          if ((xx * xx) / (rx * rx) + (yy * yy) / (ry * ry) <= 1) setPx(ax + xx, ay + yy, c, ctx.globalAlpha);
      }
    },
    fillText(t, x, y) {
      const c = styleOf(ctx.fillStyle);
      const size = ((/(\d+)px/.exec(ctx.font) || [0, 16])[1] | 0) * Math.abs(M.m[0]);
      const [cx, cy] = tf(x, y);
      const str = String(t);
      /* 有字模就点阵绘制（能认出字），没有的字符（汉字）才回落到色块 */
      const px0 = Math.max(1, Math.round(size / 9));          // 点阵单元边长
      const adv = 6 * px0;                                    // 5 列 + 1 列间距
      const total = str.length * adv;
      const al = ctx.textAlign || "left";
      /* 尊重 textAlign：Canvas 里 left/center/right 的 x 含义不同，
         全按中心算的话所有左对齐文字会整体偏到反方向（实测血量标签错位）。 */
      let ox = al === "center" ? -total / 2 : al === "right" ? -total : 0;
      let drew = false;
      for (const ch of str) {
        const gm = glyph(ch);
        if (gm) {
          const rows = gm.split(" ");
          for (let r = 0; r < 7; r++) for (let col = 0; col < 5; col++) {
            if (rows[r][col] !== "1") continue;
            for (let dy = 0; dy < px0; dy++) for (let dx = 0; dx < px0; dx++)
              setPx(cx + ox + col * px0 + dx, cy - 3.5 * px0 + r * px0 + dy, c, ctx.globalAlpha);
          }
          drew = true;
        } else {
          /* 汉字：仍然用色块占位（点阵表不可能覆盖汉字）。
             宽度按 1 个字约 5 个单元算，让排版不至于挤在一起。 */
          for (let yy = -3.5 * px0; yy <= 3.5 * px0; yy++)
            for (let xx = 0; xx < 5 * px0; xx++) setPx(cx + ox + xx, cy + yy, c, ctx.globalAlpha * 0.92);
          drew = true;
        }
        ox += adv;
      }
      if (!drew) return;
    },
    strokeText(t, x, y) { ctx.fillText(t, x, y); },
    measureText(t) { return { width: String(t).length * 8 }; },
    /* ③ drawImage：只实现 5 参形式（dx,dy,dw,dh），这是 Fight2Stage 唯一用到的。
       采样走**前向映射**：遍历源像素，把它中心打到目标空间去。缩小（源 423px → 屏 420px 左右
       其实接近 1:1；但取样片时缩放到 0.5 就是缩小）不会漏采样，代价是同一目标像素可能被写多次 ——
       对"看方向对不对"足够。 */
    drawImage(img, dx, dy, dw, dh) {
      if (!img || !img.px || !img.w || !img.h) return;
      if (arguments.length === 3) { dw = img.w; dh = img.h; }
      const sw = img.w, sh = img.h;
      const alpha = ctx.globalAlpha;
      for (let sy = 0; sy < sh; sy++) {
        for (let sx = 0; sx < sw; sx++) {
          const o = (sy * sw + sx) * 4;
          const a = img.px[o + 3]; if (!a) continue;
          const [X, Y] = tf(dx + (sx + 0.5) * dw / sw, dy + (sy + 0.5) * dh / sh);
          setPx(X, Y, [img.px[o], img.px[o + 1], img.px[o + 2], a / 255], alpha);
        }
      }
    },
  };
  return { ctx, px, amax, paintBox, paintReset, clipNow: () => clip };
}

module.exports = { makeSink, styleOf };
