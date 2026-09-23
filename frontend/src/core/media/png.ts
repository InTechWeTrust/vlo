/**
 * Minimal RGBA PNG encoder.
 *
 * Exists because canvas encoders (`toBlob`, `convertToBlob`) go through a
 * premultiplied backing store, which discards the colour of every fully
 * transparent pixel. Writing straight-alpha pixels ourselves is the only way
 * to ship a PNG whose colour survives underneath zero alpha.
 */

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const COLOR_TYPE_RGBA = 6;
const BYTES_PER_PIXEL = 4;
const FILTER_SUB = 1;

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) {
    chunk[4 + i] = type.charCodeAt(i);
  }
  chunk.set(data, 8);
  // The CRC covers the type and the data, not the length.
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** Scanlines with the Sub filter: cheap, and it compresses flat regions well. */
function filterScanlines(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const stride = width * BYTES_PER_PIXEL;
  const filtered = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const rowIn = y * stride;
    const rowOut = y * (stride + 1);
    filtered[rowOut] = FILTER_SUB;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= BYTES_PER_PIXEL ? pixels[rowIn + x - BYTES_PER_PIXEL] : 0;
      filtered[rowOut + 1 + x] = (pixels[rowIn + x] - left) & 0xff;
    }
  }
  return filtered;
}

async function zlibCompress(
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  // CompressionStream's "deflate" format is zlib-wrapped, which is what IDAT
  // requires.
  const compressed = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  }).pipeThrough(new CompressionStream("deflate"));

  const parts: Uint8Array[] = [];
  let length = 0;
  const reader = compressed.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    length += value.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Encodes straight (non-premultiplied) 8-bit RGBA pixels as a PNG.
 */
export async function encodeRgbaPng(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Blob> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(`Invalid PNG dimensions ${width}x${height}`);
  }
  if (pixels.length !== width * height * BYTES_PER_PIXEL) {
    throw new Error(
      `PNG pixel buffer holds ${pixels.length} bytes; ${width}x${height} RGBA needs ${width * height * BYTES_PER_PIXEL}`,
    );
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = COLOR_TYPE_RGBA;
  // Bytes 10-12: deflate compression, adaptive filtering, no interlace.

  const imageData = await zlibCompress(filterScanlines(pixels, width, height));

  const parts: Uint8Array[] = [
    PNG_SIGNATURE,
    createChunk("IHDR", header),
    createChunk("IDAT", imageData),
    createChunk("IEND", new Uint8Array(0)),
  ];
  return new Blob(parts as BlobPart[], { type: "image/png" });
}
