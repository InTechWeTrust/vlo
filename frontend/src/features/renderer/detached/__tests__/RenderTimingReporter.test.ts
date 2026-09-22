import { describe, expect, it, vi } from "vitest";
import { RenderTimingReporter } from "../RenderTimingReporter";

describe("RenderTimingReporter", () => {
  it("aggregates every frame while throttling immutable reports", () => {
    let now = 0;
    const send = vi.fn();
    const reporter = new RenderTimingReporter(send, () => now);
    reporter.record({ kind: "frame", frameIndex: 0, renderMilliseconds: 10, outputMilliseconds: 2 });
    reporter.record({ kind: "frame", frameIndex: 1, renderMilliseconds: 30, outputMilliseconds: 6 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].timings.render.count).toBe(1);
    now = 1000;
    reporter.record({ kind: "video-packet", outputId: "video", timestamp: 0, bytes: 100, submissionToPacketMilliseconds: 40 });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ timings: expect.objectContaining({
      lastFrameIndex: 1,
      render: { count: 2, totalMilliseconds: 40, lastMilliseconds: 30, maxMilliseconds: 30 },
      output: { count: 2, totalMilliseconds: 8, lastMilliseconds: 6, maxMilliseconds: 6 },
      submissionToPacket: { count: 1, totalMilliseconds: 40, lastMilliseconds: 40, maxMilliseconds: 40 },
      packets: 1, packetBytes: 100,
    }) }));
  });

  it("immediately reports finishing and retains an unfinished stage on late packets", () => {
    const send = vi.fn();
    const reporter = new RenderTimingReporter(send, () => 0);
    reporter.record({ kind: "finishing", stage: "encoder-drain", state: "started" });
    reporter.record({ kind: "video-packet", outputId: "video", timestamp: 0, bytes: 42, submissionToPacketMilliseconds: null });
    expect(send).toHaveBeenCalledTimes(1);
    reporter.flush();
    expect(send.mock.lastCall?.[0].timings).toMatchObject({
      packets: 1, submissionToPacket: { count: 0 },
      finishing: { "encoder-drain:all": { state: "started" } },
    });
    reporter.record({ kind: "finishing", stage: "encoder-drain", state: "completed", elapsedMilliseconds: 2500 });
    expect(send.mock.lastCall?.[0].timings.finishing["encoder-drain:all"])
      .toMatchObject({ state: "completed", elapsedMilliseconds: 2500 });
  });
});
