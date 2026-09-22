/*
  png-read.cjs —— 极简 PNG 解码器（只依赖 Node 内置 zlib，不装任何依赖）。
  为什么自己写：仓库约束是"双击就能玩、零构建、不装 npm 包"，
  但 tools/dev/stage-preview.js 需要把 art/fight2/*.png 真画进样片里。
  于是自己解一层：非隔行 8 位、颜色类型 0/2/3/4/6 够覆盖 Lovart 出的图。

  返回：{ w, h, px:Uint8ClampedArray(RGBA, 非预乘) }
  用法：const { decodePng } = require("./png-read.cjs"); decodePng(fs.readFileSync(p));
*/
const zlib = require("zlib");

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/* 每个 filter 类型每条扫描线要往前看几个字节（bpp = 每像素字节数，最小 1） */
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.slice(0, 8).equals(SIG))
    throw new Error("不是 PNG（签名不匹配）");

  let off = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  let plte = null, trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === "PLTE") plte = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;                                  // len + type(4) + data + crc(4)
  }
  if (!w || !h) throw new Error("PNG 缺 IHDR");
  if (depth !== 8) throw new Error("只支持 8 位深（这张是 " + depth + " 位）");
  if (interlace) throw new Error("不支持隔行 PNG");
  const ch = CHANNELS[color];
  if (!ch) throw new Error("不支持的颜色类型 " + color);
  if (color === 3 && !plte) throw new Error("调色板 PNG 缺 PLTE");

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, ch);
  const stride = w * ch;
  if (raw.length < (stride + 1) * h) throw new Error("IDAT 数据不完整");

  /* ① 反 filter：逐扫描线还原成原始字节 */
  const img = Buffer.alloc(stride * h);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    const cur = img.slice(y * stride, (y + 1) * stride);
    raw.copy(cur, 0, rp, rp + stride); rp += stride;
    const prev = y > 0 ? img.slice((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      if (f === 1) cur[x] = (cur[x] + a) & 255;
      else if (f === 2) cur[x] = (cur[x] + b) & 255;
      else if (f === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) cur[x] = (cur[x] + paeth(a, b, c)) & 255;
      else if (f !== 0) throw new Error("未知 filter 类型 " + f);
    }
  }

  /* ② 转 RGBA */
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    let r, g, b, a = 255;
    if (color === 0) { r = g = b = img[i]; }
    else if (color === 4) { r = g = b = img[i * 2]; a = img[i * 2 + 1]; }
    else if (color === 2) { r = img[i * 3]; g = img[i * 3 + 1]; b = img[i * 3 + 2]; }
    else if (color === 6) { r = img[i * 4]; g = img[i * 4 + 1]; b = img[i * 4 + 2]; a = img[i * 4 + 3]; }
    else {                                            // 调色板
      const k = img[i];
      r = plte[k * 3]; g = plte[k * 3 + 1]; b = plte[k * 3 + 2];
      if (trns && k < trns.length) a = trns[k];
    }
    const o = i * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
  }
  return { w, h, px };
}

module.exports = { decodePng };
