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
  const inClip = (x, y) => !clip || (x >= clip.x0 && x <= clip.x1 && y >= clip.y0 && y <= clip.y1);

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
    beginPath() { path.length = 0; arc = null; ell = null; rectP = null; },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    rect(x, y, w, h) { rectP = [x, y, w, h]; },
    arc(x, y, r) { arc = [x, y, r]; ell = null; },
    ellipse(x, y, rx, ry) { ell = [x, y, rx, ry]; arc = null; },
    closePath() { },
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
      if (arc) {
        const [ax, ay] = tf(arc[0], arc[1]);
        const rr = arc[2] * Math.abs(M.m[0]);
        const step = Math.max(0.006, 1.3 / Math.max(2, rr));
        for (let t = 0; t < Math.PI * 2; t += step)
          for (let o = -w / 2; o <= w / 2; o += 0.8) setPx(ax + Math.cos(t) * (rr + o), ay + Math.sin(t) * (rr + o), c, ctx.globalAlpha);
        return;
      }
      const pt = path.map(([x, y]) => tf(x, y));
      for (let i = 0; i < pt.length - 1; i++) {                       // ② 沿法线铺宽度
        const [x0, y0] = pt[i], [x1, y1] = pt[i + 1];
        const len = Math.hypot(x1 - x0, y1 - y0); if (len < 0.01) continue;
        const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
        const steps = Math.max(1, Math.ceil(len));
        for (let s = 0; s <= steps; s++) {
          const bx = x0 + (x1 - x0) * s / steps, by = y0 + (y1 - y0) * s / steps;
          for (let o = -w / 2; o <= w / 2; o += 0.9) setPx(bx + nx * o, by + ny * o, c, ctx.globalAlpha);
        }
      }
    },
    fill() {
      const c = styleOf(ctx.fillStyle);
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
        return;
      }
      const pt = path.map(([x, y]) => tf(x, y));
      if (pt.length < 3) return;
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
    },
    fillText(t, x, y) {
      const c = styleOf(ctx.fillStyle);
      const size = ((/(\d+)px/.exec(ctx.font) || [0, 16])[1] | 0) * Math.abs(M.m[0]);
      const [cx, cy] = tf(x, y);
      const w = Math.max(3, String(t).length * size * 0.62), h = size * 0.92;
      for (let yy = -h / 2; yy <= h / 2; yy++) for (let xx = -w / 2; xx <= w / 2; xx++) setPx(cx + xx, cy + yy, c, ctx.globalAlpha * 0.95);
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
  return { ctx, px, amax };
}

module.exports = { makeSink, styleOf };
