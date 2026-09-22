import type { ExportDiagnostic } from "../services/exportDiagnostics";

interface TimingSummary {
  count: number;
  totalMilliseconds: number;
  lastMilliseconds: number;
  maxMilliseconds: number;
}

function emptyTiming(): TimingSummary {
  return { count: 0, totalMilliseconds: 0, lastMilliseconds: 0, maxMilliseconds: 0 };
}

function addTiming(summary: TimingSummary, milliseconds: number): void {
  summary.count++;
  summary.totalMilliseconds += milliseconds;
  summary.lastMilliseconds = milliseconds;
  summary.maxMilliseconds = Math.max(summary.maxMilliseconds, milliseconds);
}

/** Bounded aggregates, with immediate stage transitions for timeout diagnosis. */
export class RenderTimingReporter {
  private readonly timings = {
    lastFrameIndex: -1,
    render: emptyTiming(),
    output: emptyTiming(),
    submissionToPacket: emptyTiming(),
    packets: 0,
    packetBytes: 0,
    encoderConfigs: {} as Record<string, VideoEncoderConfig>,
    finishing: {} as Record<string, Extract<ExportDiagnostic, { kind: "finishing" }>>,
  };
  private lastReportAt = -Infinity;
  private readonly send: (value: object) => void;
  private readonly now: () => number;

  constructor(
    send: (value: object) => void,
    now: () => number = () => performance.now(),
  ) {
    this.send = send;
    this.now = now;
  }

  record(event: ExportDiagnostic): void {
    switch (event.kind) {
      case "frame":
        this.timings.lastFrameIndex = event.frameIndex;
        addTiming(this.timings.render, event.renderMilliseconds);
        addTiming(this.timings.output, event.outputMilliseconds);
        break;
      case "video-packet":
        this.timings.packets++;
        this.timings.packetBytes += event.bytes;
        if (event.submissionToPacketMilliseconds !== null) {
          addTiming(this.timings.submissionToPacket, event.submissionToPacketMilliseconds);
        }
        break;
      case "encoder-config":
        this.timings.encoderConfigs[event.outputId] = event.config;
        break;
      case "finishing":
        this.timings.finishing[`${event.stage}:${event.outputId ?? "all"}`] = event;
        break;
    }
    if (event.kind === "finishing" || event.kind === "encoder-config"
      || this.now() - this.lastReportAt >= 1000) this.flush();
  }

  flush(): void {
    this.lastReportAt = this.now();
    // Reports are queued asynchronously: freeze values at observation time.
    this.send({ kind: "timings", timings: structuredClone(this.timings) });
  }
}
