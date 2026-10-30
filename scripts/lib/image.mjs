// Minimal RGBA image helpers for scripts/generate-icons.mjs: PNG decode and
// encode, Lanczos resampling, and the ICO and ICNS containers. Node built-ins
// only (zlib), so icon generation needs no native image tool.

import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Width and height from a PNG's IHDR, without decoding pixels. */
export function pngSize(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Decode an 8-bit, non-interlaced grey/RGB/grey-alpha/RGBA PNG to RGBA. */
export function decodePng(buf) {
  const { width, height } = pngSize(buf);
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (bitDepth !== 8 || !channels || interlace !== 0) {
    throw new Error(`unsupported PNG (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[dst + x - channels] : 0;
      const b = y > 0 ? pixels[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[dst - stride + x - channels] : 0;
      const v = raw[src + x];
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b
        : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : NaN;
      if (Number.isNaN(predictor)) throw new Error(`bad PNG filter ${filter}`);
      pixels[dst + x] = (v + predictor) & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    if (channels === 4) {
      data.set(pixels.subarray(s, s + 4), i * 4);
    } else if (channels === 3) {
      data.set(pixels.subarray(s, s + 3), i * 4);
      data[i * 4 + 3] = 255;
    } else {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = pixels[s];
      data[i * 4 + 3] = channels === 2 ? pixels[s + 1] : 255;
    }
  }
  return { width, height, data };
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode RGBA pixels as an 8-bit RGBA PNG, choosing a filter per row. */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const row = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    let best = null;
    let bestScore = Infinity;
    for (let filter = 0; filter < 5; filter++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const i = y * stride + x;
        const a = x >= 4 ? data[i - 4] : 0;
        const b = y > 0 ? data[i - stride] : 0;
        const c = x >= 4 && y > 0 ? data[i - stride - 4] : 0;
        const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b
          : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (data[i] - predictor) & 0xff;
        row[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = Buffer.concat([Buffer.from([filter]), row]);
      }
    }
    best.copy(raw, y * (stride + 1));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Smallest rectangle holding every pixel with non-zero alpha. */
export function opaqueBounds({ width, height, data }) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) throw new Error('image is fully transparent');
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function lanczos3(x) {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

// Per output index: first source index and normalised weights for the span
// [start, start + length) of the source axis mapped onto `size` outputs.
function weights(start, length, size, limit) {
  const scale = length / size;
  const filterScale = Math.max(scale, 1);
  const support = 3 * filterScale;
  const out = [];
  for (let i = 0; i < size; i++) {
    const center = start + (i + 0.5) * scale;
    const first = Math.max(0, Math.floor(center - support));
    const last = Math.min(limit - 1, Math.ceil(center + support));
    const w = [];
    let sum = 0;
    for (let j = first; j <= last; j++) {
      const v = lanczos3((j + 0.5 - center) / filterScale);
      w.push(v);
      sum += v;
    }
    out.push({ first, w: w.map((v) => v / sum) });
  }
  return out;
}

/**
 * Resample the `rect` region of `image` to a square `size` x `size` image,
 * centred, with a Lanczos-3 filter on premultiplied alpha.
 */
export function resizeSquare(image, rect, size) {
  const side = Math.max(rect.width, rect.height);
  const sx = rect.x + (rect.width - side) / 2;
  const sy = rect.y + (rect.height - side) / 2;
  const { width, height, data } = image;
  if (side === size && Number.isInteger(sx) && Number.isInteger(sy) && sx >= 0 && sy >= 0
    && sx + side <= width && sy + side <= height) {
    const out = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      out.set(data.subarray(((sy + y) * width + sx) * 4, ((sy + y) * width + sx + size) * 4), y * size * 4);
    }
    return { width: size, height: size, data: out };
  }
  const pre = new Float64Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3] / 255;
    pre[i * 4] = data[i * 4] * a;
    pre[i * 4 + 1] = data[i * 4 + 1] * a;
    pre[i * 4 + 2] = data[i * 4 + 2] * a;
    pre[i * 4 + 3] = data[i * 4 + 3];
  }
  const wx = weights(sx, side, size, width);
  const wy = weights(sy, side, size, height);
  const rowsFrom = wy[0].first;
  const rowsTo = wy[size - 1].first + wy[size - 1].w.length;
  const horiz = new Float64Array((rowsTo - rowsFrom) * size * 4);
  for (let y = rowsFrom; y < rowsTo; y++) {
    for (let i = 0; i < size; i++) {
      const { first, w } = wx[i];
      const o = ((y - rowsFrom) * size + i) * 4;
      for (let k = 0; k < w.length; k++) {
        const s = (y * width + first + k) * 4;
        horiz[o] += pre[s] * w[k];
        horiz[o + 1] += pre[s + 1] * w[k];
        horiz[o + 2] += pre[s + 2] * w[k];
        horiz[o + 3] += pre[s + 3] * w[k];
      }
    }
  }
  const out = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    const { first, w } = wy[j];
    for (let i = 0; i < size; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < w.length; k++) {
        const s = ((first + k - rowsFrom) * size + i) * 4;
        r += horiz[s] * w[k];
        g += horiz[s + 1] * w[k];
        b += horiz[s + 2] * w[k];
        a += horiz[s + 3] * w[k];
      }
      const alpha = Math.min(255, Math.max(0, a));
      const o = (j * size + i) * 4;
      const ra = Math.round(alpha);
      out[o + 3] = ra;
      if (ra === 0) continue;
      const unpremul = 255 / alpha;
      out[o] = Math.min(255, Math.max(0, Math.round(r * unpremul)));
      out[o + 1] = Math.min(255, Math.max(0, Math.round(g * unpremul)));
      out[o + 2] = Math.min(255, Math.max(0, Math.round(b * unpremul)));
    }
  }
  return { width: size, height: size, data: out };
}

// 32-bit BGRA DIB with a 1-bit AND mask, the classic ICO entry format.
function icoBitmap({ width, height, data }) {
  const maskStride = Math.ceil(width / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8); // colour rows + mask rows
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel
  header.writeUInt32LE(width * height * 4 + maskStride * height, 20);
  const colour = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(maskStride * height);
  for (let y = 0; y < height; y++) {
    const row = height - 1 - y; // bottom-up
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = (row * width + x) * 4;
      colour[d] = data[s + 2];
      colour[d + 1] = data[s + 1];
      colour[d + 2] = data[s];
      colour[d + 3] = data[s + 3];
      if (data[s + 3] === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, colour, mask]);
}

/**
 * Build a Windows .ico from square RGBA images. Entries of 256 px and above
 * are stored as PNG, smaller ones as 32-bit bitmaps.
 */
export function encodeIco(images) {
  const entries = images.map((img) => (img.width >= 256 ? encodePng(img) : icoBitmap(img)));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const e = 6 + 16 * i;
    header[e] = img.width >= 256 ? 0 : img.width;
    header[e + 1] = img.height >= 256 ? 0 : img.height;
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(entries[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += entries[i].length;
  });
  return Buffer.concat([header, ...entries]);
}

/** Decode every entry of an .ico (PNG or 32-bit bitmap) to RGBA. */
export function decodeIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO file');
  const count = buf.readUInt16LE(4);
  const images = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const size = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    const entry = buf.subarray(offset, offset + size);
    const dirWidth = buf[e] || 256;
    const dirHeight = buf[e + 1] || 256;
    let image;
    if (entry.subarray(0, 8).equals(PNG_SIGNATURE)) {
      image = decodePng(entry);
    } else {
      const width = entry.readInt32LE(4);
      const height = entry.readInt32LE(8) / 2;
      if (entry.readUInt16LE(14) !== 32) throw new Error('only 32-bit ICO bitmaps are supported');
      const data = new Uint8Array(width * height * 4);
      const base = entry.readUInt32LE(0);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const s = base + ((height - 1 - y) * width + x) * 4;
          const d = (y * width + x) * 4;
          data[d] = entry[s + 2];
          data[d + 1] = entry[s + 1];
          data[d + 2] = entry[s];
          data[d + 3] = entry[s + 3];
        }
      }
      image = { width, height, data };
    }
    if (image.width !== dirWidth || image.height !== dirHeight) {
      throw new Error(`ICO entry ${i} is ${image.width}x${image.height} but the directory says ${dirWidth}x${dirHeight}`);
    }
    images.push(image);
  }
  return images;
}

// ICNS run-length coding used by the ARGB entries (ic04, ic05): a control
// byte below 0x80 copies the next n+1 bytes; 0x80 and above repeats the next
// byte n-0x80+3 times.
function packIcnsChannel(bytes) {
  const out = [];
  let literal = [];
  const flush = () => {
    while (literal.length) {
      const part = literal.splice(0, 128);
      out.push(part.length - 1, ...part);
    }
  };
  for (let i = 0; i < bytes.length;) {
    let run = 1;
    while (i + run < bytes.length && run < 130 && bytes[i + run] === bytes[i]) run++;
    if (run >= 3) {
      flush();
      out.push(0x80 + run - 3, bytes[i]);
      i += run;
    } else {
      literal.push(bytes[i]);
      i++;
    }
  }
  flush();
  return Buffer.from(out);
}

function unpackIcnsChannels(buf, count, channels) {
  const out = new Uint8Array(count * channels);
  let o = 0;
  for (let i = 0; i < buf.length && o < out.length;) {
    const c = buf[i++];
    if (c < 0x80) {
      for (let k = 0; k <= c; k++) out[o++] = buf[i++];
    } else {
      const v = buf[i++];
      for (let k = 0; k < c - 0x80 + 3; k++) out[o++] = v;
    }
  }
  if (o !== out.length) throw new Error('truncated ICNS ARGB entry');
  return out;
}

function icnsArgb({ width, height, data }) {
  const count = width * height;
  const planes = [3, 0, 1, 2].map((ch) => {
    const plane = new Uint8Array(count);
    for (let i = 0; i < count; i++) plane[i] = data[i * 4 + ch];
    return packIcnsChannel(plane);
  });
  return Buffer.concat([Buffer.from('ARGB', 'latin1'), ...planes]);
}

/**
 * Build a macOS .icns from [type, image] pairs. ic04 and ic05 use the ARGB
 * encoding, every other type embeds a PNG.
 */
export function encodeIcns(entries) {
  const chunks = entries.map(([type, img]) => {
    const body = type === 'ic04' || type === 'ic05' ? icnsArgb(img) : encodePng(img);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(body.length + 8, 4);
    return Buffer.concat([head, body]);
  });
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...chunks]);
}

const ARGB_SIZES = { ic04: 16, ic05: 32 };

/** Decode the PNG and ARGB entries of an .icns to [type, RGBA image] pairs. */
export function decodeIcns(buf) {
  if (buf.toString('latin1', 0, 4) !== 'icns') throw new Error('not an ICNS file');
  const entries = [];
  for (let off = 8; off < buf.length;) {
    const type = buf.toString('latin1', off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    const body = buf.subarray(off + 8, off + len);
    if (body.subarray(0, 8).equals(PNG_SIGNATURE)) {
      entries.push([type, decodePng(body)]);
    } else if (type in ARGB_SIZES && body.toString('latin1', 0, 4) === 'ARGB') {
      const size = ARGB_SIZES[type];
      const planes = unpackIcnsChannels(body.subarray(4), size * size, 4);
      const data = new Uint8Array(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        data[i * 4 + 3] = planes[i];
        data[i * 4] = planes[size * size + i];
        data[i * 4 + 1] = planes[2 * size * size + i];
        data[i * 4 + 2] = planes[3 * size * size + i];
      }
      entries.push([type, { width: size, height: size, data }]);
    }
    off += len;
  }
  return entries;
}
