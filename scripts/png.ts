// Minimal PNG writer for debugging renders (Node only).
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const crcTable = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
const crc32 = (bytes: Uint8Array): number => { let c = 0xffffffff; for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length); const view = new DataView(out.buffer);
  view.setUint32(0, data.length); for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8); view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
}

export function writePng(path: string, width: number, height: number, rgba: Uint8ClampedArray | Uint8Array): void {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) { raw[y * (width * 4 + 1)] = 0; raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1); }
  const header = new Uint8Array(13); const view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0); const file = new Uint8Array(total); let at = 0;
  for (const part of parts) { file.set(part, at); at += part.length; }
  writeFileSync(path, file);
}

/** Tile RGBA images (all the same size) into a grid, scaling each by an integer factor. */
export function montage(images: { rgba: Uint8ClampedArray; width: number; height: number }[], columns: number, scale: number, gap = 4): { rgba: Uint8ClampedArray; width: number; height: number } {
  const w = images[0].width * scale, h = images[0].height * scale; const rows = Math.ceil(images.length / columns);
  const width = columns * (w + gap) + gap, height = rows * (h + gap) + gap; const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = 24; out[i + 1] = 28; out[i + 2] = 36; out[i + 3] = 255; }
  images.forEach((image, index) => {
    const ox = gap + (index % columns) * (w + gap), oy = gap + Math.floor(index / columns) * (h + gap);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const s = (Math.floor(y / scale) * image.width + Math.floor(x / scale)) * 4; const d = ((oy + y) * width + ox + x) * 4;
      out[d] = image.rgba[s]; out[d + 1] = image.rgba[s + 1]; out[d + 2] = image.rgba[s + 2]; out[d + 3] = 255;
    }
  });
  return { rgba: out, width, height };
}
