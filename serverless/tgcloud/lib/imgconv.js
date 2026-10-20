// imgconv.js — JPEG → PNG conversion for duck.ai image parts.
//
// Why: duck.ai's /duckchat/v1/chat rejects `image/jpeg` parts with
// ERR_BAD_REQUEST (verified live 2026-10-16). The duck.ai web frontend only
// ever sends PNG (canvas) or WebP (canvas @0.9) — JPEG bytes are refused no
// matter how they are wrapped (wrong label, file part, raw b64 — all 400).
// Telegram photos always arrive as JPEG, so we re-encode: decode with a
// vendored jpeg-js, box-downscale, encode a zlib PNG with vendored pako.
//
// jpeg-js (MIT) + pako (MIT) are pre-bundled as ES modules next to this file.

import jpegJs from './jpegdec.js';
import { deflate } from './pakodef.js';

// --- CRC32 for PNG chunks ---------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function pngChunk(type, data) {
  const len = u32(data.length);
  const body = new Uint8Array(type.length + data.length);
  body.set(type, 0); body.set(data, type.length);
  const crc = u32(crc32(body));
  const out = new Uint8Array(len.length + body.length + 4);
  out.set(len, 0); out.set(body, 4); out.set(crc, 4 + body.length);
  return out;
}

// --- PNG encode (8-bit RGB, color type 2) ------------------------------------
export function encodePng(pixels, width, height) {
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // scanlines with filter byte 0
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflate(raw, { level: 6 });

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    sig,
    pngChunk(new Uint8Array([0x49, 0x48, 0x44, 0x52]), ihdr),                       // IHDR
    pngChunk(new Uint8Array([0x49, 0x44, 0x41, 0x54]), idat),                       // IDAT
    pngChunk(new Uint8Array([0x49, 0x45, 0x4e, 0x44]), new Uint8Array(0)),          // IEND
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// --- Box downscale (RGB) -------------------------------------------------------
function downscale(src, sw, sh, dw, dh) {
  const dst = new Uint8Array(dw * dh * 3);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yr), y1 = Math.max(y0 + 1, Math.floor((y + 1) * yr));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xr), x1 = Math.max(x0 + 1, Math.floor((x + 1) * xr));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy++) {
        let i = (yy * sw + x0) * 3;
        for (let xx = x0; xx < x1 && xx < sw; xx++, i += 3) {
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
      }
      const o = (y * dw + x) * 3;
      dst[o] = r / n; dst[o + 1] = g / n; dst[o + 2] = b / n;
    }
  }
  return dst;
}

export function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return null;
}

// Decode JPEG bytes → PNG bytes (downscaled to maxSide on the long edge).
export function jpegToPng(bytes, maxSide = 640) {
  const img = jpegJs.decode(bytes, { useTArray: true, formatAsRGBA: false });
  let { width: w, height: h, data } = img;
  const long = Math.max(w, h);
  if (long > maxSide) {
    const k = maxSide / long;
    const dw = Math.max(1, Math.round(w * k));
    const dh = Math.max(1, Math.round(h * k));
    data = downscale(data, w, h, dw, dh);
    w = dw; h = dh;
  }
  return { png: encodePng(data, w, h), width: w, height: h };
}

// JPEG bytes → data URL accepted by duck.ai ('data:image/png;base64,…').
const B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64Encode(bytes) {
  let out = '';
  const CH = 3 * 0x4000; // decode in ~48KB input chunks
  for (let s = 0; s < bytes.length; s += CH) {
    const end = Math.min(s + CH, bytes.length);
    for (let i = s; i < end; i += 3) {
      const b0 = bytes[i], b1 = i + 1 < end ? bytes[i + 1] : undefined, b2 = i + 2 < end ? bytes[i + 2] : undefined;
      out += B64C[b0 >> 2] +
        B64C[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)] +
        (b1 === undefined ? '=' : B64C[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)]) +
        (b2 === undefined ? '=' : B64C[b2 & 63]);
    }
  }
  return out;
}

export function jpegToPngDataUrl(bytes, maxSide = 640) {
  const { png } = jpegToPng(bytes, maxSide);
  return 'data:image/png;base64,' + b64Encode(png);
}
