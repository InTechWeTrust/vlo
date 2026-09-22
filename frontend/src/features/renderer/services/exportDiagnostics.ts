/** Opt-in host diagnostics; timings are wall time, not isolated GPU/codec time. */
export type ExportDiagnostic =
  | {
      kind: "frame";
      frameIndex: number;
      renderMilliseconds: number;
      /** Output transforms, submission and encoder backpressure. */
      outputMilliseconds: number;
    }
  | {
      kind: "video-packet";
      outputId: string;
      timestamp: number;
      bytes: number;
      /** Includes queueing, readback and alpha work; can overlap other frames. */
      submissionToPacketMilliseconds: number | null;
    }
  | {
      kind: "encoder-config";
      outputId: string;
      /** Mediabunny's actual candidate, after host color metadata is applied. */
      config: VideoEncoderConfig;
    }
  | {
      kind: "finishing";
      stage: "encoder-drain" | "video-close" | "mux-finalize" | "output-commit";
      outputId?: string;
      state: "started" | "completed";
      elapsedMilliseconds?: number;
    };
