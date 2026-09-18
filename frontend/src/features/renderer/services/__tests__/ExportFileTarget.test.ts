// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ALL_FORMATS,
  BufferSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  type StreamTargetChunk,
} from "mediabunny";
import { ExportFileTarget } from "../ExportFileTarget";

function createDestination() {
  const writes: StreamTargetChunk[] = [];
  const stream = {
    write: vi.fn(async (chunk: StreamTargetChunk) => { writes.push(chunk); }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  return {
    writes,
    stream,
    destination: new ExportFileTarget(stream as unknown as FileSystemWritableFileStream),
  };
}

async function loadFixture(format: "mp4" | "webm") {
  const name = format === "mp4" ? "vace_00003.mp4" : "composite-1784584066262.webm";
  const input = new Input({
    source: new BufferSource(await readFile(new URL(`../../../../../e2e/fixtures/project_current/${name}`, import.meta.url))),
    formats: ALL_FORMATS,
  });
  const track = await input.getPrimaryVideoTrack();
  if (!track?.codec) throw new Error("Missing video fixture");
  const decoderConfig = await track.getDecoderConfig();
  if (!decoderConfig) throw new Error("Missing decoder configuration");
  const packets: EncodedPacket[] = [];
  for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
  input.dispose();
  return { codec: track.codec, decoderConfig, packets };
}

describe("ExportFileTarget with the real muxer", () => {
  async function pendingMp4(destination: ExportFileTarget) {
    const { codec, decoderConfig, packets } = await loadFixture("mp4");
    const output = new Output({
      target: destination.target,
      format: new Mp4OutputFormat({ fastStart: false }),
    });
    const source = new EncodedVideoPacketSource(codec);
    output.addVideoTrack(source);
    await output.start();
    for (const packet of packets) await source.add(packet, { decoderConfig });
    return output;
  }

  it("surfaces an actual stream write failure without committing", async () => {
    const { destination, stream } = createDestination();
    stream.write.mockRejectedValueOnce(new Error("Write denied"));
    const output = await pendingMp4(destination);
    await expect(output.finalize()).rejects.toThrow("Write denied");
    await destination.abort();
    expect(stream.close).not.toHaveBeenCalled();
    expect(stream.abort).toHaveBeenCalledOnce();
  });

  it("waits for queued writes before committing", async () => {
    const { destination, stream } = createDestination();
    let writeStarted!: () => void;
    let releaseWrite!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    stream.write.mockImplementationOnce(() => {
      writeStarted();
      return new Promise<void>((resolve) => { releaseWrite = resolve; });
    });
    const output = await pendingMp4(destination);
    const saving = output.finalize().then(() => destination.commit());
    await started;
    expect(stream.close).not.toHaveBeenCalled();
    releaseWrite();
    await saving;
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it.each(["mp4", "webm"] as const)("streams and patches a valid %s before explicit commit", async (format) => {
    const { writes, stream, destination } = createDestination();
    const { codec, decoderConfig, packets } = await loadFixture(format);
    const output = new Output({
      target: destination.target,
      format: format === "mp4" ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
    });
    const source = new EncodedVideoPacketSource(codec);
    output.addVideoTrack(source);
    await output.start();
    // Exceed the production 1 MiB write chunk without needing a browser encoder.
    const repeats = Math.max(2, Math.ceil(3 * 1024 * 1024 / packets.reduce((sum, p) => sum + p.byteLength, 0)));
    const duration = Math.max(...packets.map((packet) => packet.timestamp + packet.duration));
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const packet of packets) {
        await source.add(new EncodedPacket(packet.data, packet.type, packet.timestamp + repeat * duration, packet.duration, -1, undefined, packet.sideData), { decoderConfig });
      }
    }
    expect(writes.length).toBeGreaterThan(0);
    expect(stream.close).not.toHaveBeenCalled();
    await output.finalize();
    expect(stream.close).not.toHaveBeenCalled();
    expect(writes.some((chunk, index) => index > 0 && chunk.position < writes[index - 1].position)).toBe(true);

    const bytes = new Uint8Array(Math.max(...writes.map((chunk) => chunk.position + chunk.data.length)));
    for (const chunk of writes) bytes.set(chunk.data, chunk.position);
    const result = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
    try {
      const track = await result.getPrimaryVideoTrack();
      if (!track) throw new Error("Muxer produced no video track");
      let count = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        expect(Buffer.from(packet.data).equals(Buffer.from(packets[count % packets.length].data))).toBe(true);
        count += 1;
      }
      expect(count).toBe(packets.length * repeats);
    } finally {
      result.dispose();
    }
    await destination.commit();
    await destination.abort();
    expect(stream.close).toHaveBeenCalledOnce();
    expect(stream.abort).not.toHaveBeenCalled();
  });

  it("discards the temporary file when the muxer cancels and closes its writer", async () => {
    const { destination, stream } = createDestination();
    const output = new Output({ target: destination.target, format: new Mp4OutputFormat({ fastStart: false }) });
    output.addVideoTrack(new EncodedVideoPacketSource("avc"));
    await output.start();
    await destination.abort();
    await output.cancel();
    await destination.abort();
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.close).not.toHaveBeenCalled();
    await expect(destination.commit()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("propagates close failure and permits discarding the failed file", async () => {
    const { destination, stream } = createDestination();
    stream.close.mockRejectedValueOnce(new Error("Disk full"));
    await expect(destination.commit()).rejects.toThrow("Disk full");
    await destination.abort();
    expect(stream.abort).toHaveBeenCalledOnce();
  });

  it("waits for a slow close and does not report cancellation after commit begins", async () => {
    const { destination, stream } = createDestination();
    let finish!: () => void;
    stream.close.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    let saved = false;
    const saving = destination.commit().then(() => { saved = true; });
    await destination.abort();
    expect(saved).toBe(false);
    expect(stream.abort).not.toHaveBeenCalled();
    finish();
    await saving;
    expect(saved).toBe(true);
  });
});
