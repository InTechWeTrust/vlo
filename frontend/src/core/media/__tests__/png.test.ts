import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeRgbaPng } from "../png";

/** jsdom's Blob has no arrayBuffer(); FileReader reads it. */
function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

interface PngChunk {
  type: string;
  data: Uint8Array;
}

function readChunks(bytes: Uint8Array): PngChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

/** Undoes the Sub filter the encoder writes on every scanline. */
function decodeScanlines(
  filtered: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const stride = width * 4;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const rowIn = y * (stride + 1);
    expect(filtered[rowIn]).toBe(1);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      pixels[y * stride + x] = (filtered[rowIn + 1 + x] + left) & 0xff;
    }
  }
  return pixels;
}

describe("encodeRgbaPng", () => {
  it("round-trips straight RGBA, keeping colour under zero alpha", async () => {
    const width = 3;
    const height = 2;
    // prettier-ignore
    const pixels = new Uint8Array([
      255, 0, 0, 255,    10, 200, 30, 0,    0, 0, 255, 128,
      1, 2, 3, 4,        250, 251, 252, 0,  90, 80, 70, 255,
    ]);

    const blob = await encodeRgbaPng(pixels, width, height);
    expect(blob.type).toBe("image/png");
    const bytes = await readBlobBytes(blob);

    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const chunks = readChunks(bytes);
    expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);

    const header = new DataView(
      chunks[0].data.buffer,
      chunks[0].data.byteOffset,
      chunks[0].data.byteLength,
    );
    expect(header.getUint32(0)).toBe(width);
    expect(header.getUint32(4)).toBe(height);
    expect(chunks[0].data[8]).toBe(8);
    expect(chunks[0].data[9]).toBe(6);

    const decoded = decodeScanlines(
      new Uint8Array(inflateSync(chunks[1].data)),
      width,
      height,
    );
    expect([...decoded]).toEqual([...pixels]);
  });

  it("rejects a buffer that does not match the dimensions", async () => {
    await expect(encodeRgbaPng(new Uint8Array(4), 2, 1)).rejects.toThrow(
      /needs 8/,
    );
  });
});
