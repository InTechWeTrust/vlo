import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Application, Texture } from "pixi.js";
import {
  TextureOutputEncoder,
  type OutputVideoDefinition,
} from "../TextureOutputEncoder";

/**
 * Each CanvasSource.add() returns a manually-resolvable promise so a test can
 * observe encoder backpressure: real mediabunny resolves this once the encoder
 * is ready for more frames. The VideoSample snapshot is synchronous in
 * production, so deferring this promise is safe — these tests assert the
 * encoder defers it (pipelining) but still bounds + drains the queue.
 */
interface DeferredAdd {
  resolve: () => void;
  reject: (reason: unknown) => void;
  promise: Promise<void>;
}
interface ColorTaggedVideoEncoderConfig extends VideoEncoderConfig {
  colorSpace?: VideoColorSpaceInit;
}
const addCalls: DeferredAdd[] = [];
const mp4Options: Array<{ fastStart: false | "in-memory" }> = [];
const outputs: Array<{ finalize: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }> = [];
const canvasSourceConfigs: Array<{
  codec?: string;
  alpha?: "discard" | "keep";
  keyFrameInterval?: number;
  onEncoderConfig?: (config: VideoEncoderConfig) => void;
  onEncodedPacket?: (
    packet: unknown,
    metadata: EncodedVideoChunkMetadata | undefined,
  ) => void;
}> = [];

vi.mock("pixi.js", () => ({
  Container: class {
    addChild = vi.fn();
    destroy = vi.fn();
  },
  Sprite: class {
    anchor = { set: vi.fn() };
  },
}));

vi.mock("../../utils/outputTransformStack", () => ({
  applyOutputTransformStack: vi.fn(),
}));

vi.mock("mediabunny", () => ({
  Output: class {
    constructor() { outputs.push(this); }
    addVideoTrack = vi.fn();
    addAudioTrack = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    cancel = vi.fn().mockResolvedValue(undefined);
    finalize = vi.fn().mockResolvedValue(undefined);
  },
  Mp4OutputFormat: class {
    constructor(options: { fastStart: false | "in-memory" }) { mp4Options.push(options); }
  },
  WebMOutputFormat: class {},
  BufferTarget: class {
    buffer = new ArrayBuffer(1);
  },
  StreamTarget: class {},
  CanvasSource: class {
    constructor(_canvas: HTMLCanvasElement, config: (typeof canvasSourceConfigs)[number]) {
      canvasSourceConfigs.push(config);
    }
    add = vi.fn(() => {
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      addCalls.push({ resolve, reject, promise });
      return promise;
    });
    close = vi.fn().mockResolvedValue(undefined);
  },
  AudioBufferSource: class {
    add = vi.fn();
    close = vi.fn();
  },
}));

const flushMicrotasks = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Resolves true once `promise` settles, false if it is still pending. */
function settled(promise: Promise<unknown>): { isDone: () => boolean } {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  return { isDone: () => done };
}

describe("TextureOutputEncoder encode backpressure window", () => {
  const app = {
    canvas: {} as HTMLCanvasElement,
    renderer: { render: vi.fn() },
  } as unknown as Application;
  const texture = {} as unknown as Texture;
  const definition: OutputVideoDefinition = { id: "video", format: "mp4" };

  beforeEach(() => {
    addCalls.length = 0;
    mp4Options.length = 0;
    outputs.length = 0;
    canvasSourceConfigs.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function fileDestination() {
    const stream = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const fileHandle = { createWritable: vi.fn().mockResolvedValue(stream) } as unknown as FileSystemFileHandle;
    return { stream, fileHandle };
  }

  it("streams disk MP4 and reports a file output only after commit", async () => {
    const { stream, fileHandle } = fileDestination();
    const phases: string[] = [];
    const encoder = new TextureOutputEncoder(app, 30, [{ ...definition, fileHandle }], {
      onPhaseChange: (phase) => phases.push(phase),
    });
    await encoder.start();
    expect(mp4Options[0].fastStart).toBe(false);
    expect(stream.close).not.toHaveBeenCalled();
    const result = await encoder.finalize();
    expect(result.blobs).toEqual({});
    expect(result.files).toEqual({ video: fileHandle });
    expect(stream.close).toHaveBeenCalledOnce();
    expect(phases).toEqual(["finalizing", "saving"]);
    encoder.dispose();
    expect(stream.abort).not.toHaveBeenCalled();
  });

  it("discards earlier files when a later destination fails to open", async () => {
    const { stream, fileHandle } = fileDestination();
    const badHandle = { createWritable: vi.fn().mockRejectedValue(new Error("Permission lost")) } as unknown as FileSystemFileHandle;
    const encoder = new TextureOutputEncoder(app, 30, [
      { ...definition, fileHandle }, { id: "other", fileHandle: badHandle },
    ]);
    await expect(encoder.start()).rejects.toThrow("Permission lost");
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.close).not.toHaveBeenCalled();
    expect(outputs[0].cancel).toHaveBeenCalledOnce();
    encoder.dispose();
  });

  it("discards a file created after cancellation was requested", async () => {
    const { stream, fileHandle } = fileDestination();
    let opened!: (stream: FileSystemWritableFileStream) => void;
    vi.mocked(fileHandle.createWritable).mockImplementationOnce(() => new Promise((resolve) => { opened = resolve; }));
    const encoder = new TextureOutputEncoder(app, 30, [{ ...definition, fileHandle }]);
    const starting = encoder.start();
    await encoder.abort();
    opened(stream as unknown as FileSystemWritableFileStream);
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.close).not.toHaveBeenCalled();
    encoder.dispose();
  });

  it("cancels while waiting for the encoder drain without committing", async () => {
    const { stream, fileHandle } = fileDestination();
    const encoder = new TextureOutputEncoder(app, 30, [{ ...definition, fileHandle }]);
    await encoder.start();
    await encoder.addTextureFrame(texture, 0, 1 / 30);
    const finalizing = encoder.finalize();
    const rejected = expect(finalizing).rejects.toMatchObject({ name: "AbortError" });
    await encoder.abort();
    await rejected;
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.close).not.toHaveBeenCalled();
    expect(outputs[0].cancel).toHaveBeenCalledOnce();
    addCalls[0].resolve();
    encoder.dispose();
  });

  it("does not commit when mux finalization fails", async () => {
    const { stream, fileHandle } = fileDestination();
    const encoder = new TextureOutputEncoder(app, 30, [{ ...definition, fileHandle }]);
    await encoder.start();
    outputs[0].finalize.mockRejectedValueOnce(new Error("Write failed"));
    await expect(encoder.finalize()).rejects.toThrow("Write failed");
    await encoder.abort();
    expect(stream.close).not.toHaveBeenCalled();
    expect(stream.abort).toHaveBeenCalledOnce();
    encoder.dispose();
  });

  it("propagates a failed file commit", async () => {
    const { stream, fileHandle } = fileDestination();
    const encoder = new TextureOutputEncoder(app, 30, [{ ...definition, fileHandle }]);
    await encoder.start();
    stream.close.mockRejectedValueOnce(new Error("Disk full"));
    await expect(encoder.finalize()).rejects.toThrow("Disk full");
    await encoder.abort();
    expect(stream.abort).toHaveBeenCalledOnce();
    encoder.dispose();
  });

  it("does not block while in-flight frames fit the window", async () => {
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      encodeQueueSize: 2,
    });
    await encoder.start();

    const f0 = settled(encoder.addTextureFrame(texture, 0, 1 / 30));
    const f1 = settled(encoder.addTextureFrame(texture, 1, 1 / 30));
    await flushMicrotasks();

    // Window of 2 (single output) → first two submissions never await their
    // own encode promise, so both addTextureFrame calls settle immediately.
    expect(f0.isDone()).toBe(true);
    expect(f1.isDone()).toBe(true);
    expect(addCalls).toHaveLength(2);
  });

  it("configures WebM caches to retain alpha side data", async () => {
    const encoder = new TextureOutputEncoder(
      app,
      30,
      [
        {
          id: "composite",
          format: "webm",
          includeAudio: false,
          keyFrameInterval: 1,
        },
      ],
      { encodeQueueSize: 1 },
    );

    await encoder.start();

    expect(canvasSourceConfigs[0]).toMatchObject({
      codec: "vp9",
      alpha: "keep",
      keyFrameInterval: 1,
    });
    encoder.dispose();
  });

  it("requests no-preference hardware acceleration for both VP9 and AVC", async () => {
    // `prefer-hardware` is not a hint as far as mediabunny is concerned: it
    // fails closed on `isConfigSupported`, so a machine with no hardware
    // encoder for the codec gets a hard export failure instead of the software
    // encoder. Hardware VP9 encode is uncommon, so this broke WebM composite
    // bakes while the H.264 path kept working and hid it.
    const webmEncoder = new TextureOutputEncoder(app, 30, [
      { id: "composite", format: "webm", includeAudio: false },
    ]);
    await webmEncoder.start();
    expect(canvasSourceConfigs[0]).toMatchObject({
      codec: "vp9",
      hardwareAcceleration: "no-preference",
    });
    webmEncoder.dispose();

    canvasSourceConfigs.length = 0;

    const mp4Encoder = new TextureOutputEncoder(app, 30, [definition]);
    await mp4Encoder.start();
    expect(canvasSourceConfigs[0]).toMatchObject({
      codec: "avc",
      hardwareAcceleration: "no-preference",
    });
    mp4Encoder.dispose();
  });

  it("tags AVC encoder and MP4 decoder metadata as BT.709/sRGB", async () => {
    const encoder = new TextureOutputEncoder(app, 30, [definition]);
    await encoder.start();

    const config = {} as ColorTaggedVideoEncoderConfig;
    canvasSourceConfigs[0].onEncoderConfig?.(config);
    expect(config.colorSpace).toEqual({
      primaries: "bt709",
      transfer: "iec61966-2-1",
      matrix: "bt709",
      fullRange: false,
    });

    const metadata = {
      decoderConfig: {},
    } as EncodedVideoChunkMetadata;
    canvasSourceConfigs[0].onEncodedPacket?.({}, metadata);
    expect(metadata.decoderConfig?.colorSpace).toEqual(config.colorSpace);
  });

  it("throttles once the window is full and resumes when the oldest drains", async () => {
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      encodeQueueSize: 2,
    });
    await encoder.start();

    void encoder.addTextureFrame(texture, 0, 1 / 30);
    void encoder.addTextureFrame(texture, 1, 1 / 30);
    const f2 = settled(encoder.addTextureFrame(texture, 2, 1 / 30));
    await flushMicrotasks();

    // Third frame exceeds the window of 2 → it awaits the oldest encode.
    expect(f2.isDone()).toBe(false);

    addCalls[0].resolve();
    await flushMicrotasks();

    expect(f2.isDone()).toBe(true);
  });

  it("finalize() awaits every outstanding encode before closing", async () => {
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      encodeQueueSize: 4,
    });
    await encoder.start();

    void encoder.addTextureFrame(texture, 0, 1 / 30);
    void encoder.addTextureFrame(texture, 1, 1 / 30);
    await flushMicrotasks();

    const fin = settled(encoder.finalize());
    await flushMicrotasks();

    // Two encodes still in flight → finalize must not resolve yet.
    expect(fin.isDone()).toBe(false);

    addCalls.forEach((call) => call.resolve());
    await flushMicrotasks();

    expect(fin.isDone()).toBe(true);
  });

  it("finalize observes every encode before re-throwing the first failure", async () => {
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      encodeQueueSize: 4,
    });
    await encoder.start();

    // Three in flight (within the window, so no backpressure await).
    void encoder.addTextureFrame(texture, 0, 1 / 30);
    void encoder.addTextureFrame(texture, 1, 1 / 30);
    void encoder.addTextureFrame(texture, 2, 1 / 30);
    await flushMicrotasks();

    // The OLDEST encode fails first. A sequential `for await` drain would throw
    // here and abandon the still-pending later encodes; the all-settled drain
    // must instead keep waiting until every encode has settled.
    addCalls[0].reject(new Error("encode-0 boom"));

    let state: "pending" | "fulfilled" | "rejected" = "pending";
    let caught: unknown;
    const fin = encoder.finalize().then(
      () => {
        state = "fulfilled";
      },
      (error: unknown) => {
        state = "rejected";
        caught = error;
      },
    );
    await flushMicrotasks();
    // Encodes 1 & 2 are still in flight, so the drain must not have settled.
    expect(state).toBe("pending");

    // Settling the later encodes lets the drain complete and re-surface the
    // oldest failure — proving none were abandoned when the oldest rejected.
    addCalls[1].resolve();
    addCalls[2].resolve();
    await fin;
    expect(state).toBe("rejected");
    expect((caught as Error).message).toBe("encode-0 boom");
  });

  it("backpressure re-surfaces the failure of the oldest encode", async () => {
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      encodeQueueSize: 1,
    });
    await encoder.start();

    void encoder.addTextureFrame(texture, 0, 1 / 30);
    await flushMicrotasks();

    // Oldest encode fails; the next frame trips backpressure and must rethrow.
    addCalls[0].reject(new Error("oldest boom"));
    await flushMicrotasks();

    await expect(encoder.addTextureFrame(texture, 1, 1 / 30)).rejects.toThrow(
      "oldest boom",
    );
  });
});
