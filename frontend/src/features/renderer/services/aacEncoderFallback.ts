import { canEncodeAudio } from "mediabunny";

export type AacEncoderSource = "native" | "wasm";

let registration: Promise<AacEncoderSource> | null = null;
let resolvedSource: AacEncoderSource | null = null;

/**
 * Makes AAC encodable. Chrome only exposes AAC through platform encoders, so
 * Linux (including backend render workers) has none. There, register
 * Mediabunny's WASM build of FFmpeg's AAC encoder. It is loaded on first need,
 * keeping ~1 MB out of the editor bundle where native AAC exists.
 *
 * Registration is process-wide and permanent, so the answer is cached; later
 * support checks would otherwise see the registered encoder, not the browser.
 */
export function ensureAacEncoder(bitrate: number): Promise<AacEncoderSource> {
  registration ??= (async () => {
    const native = await canEncodeAudio("aac", {
      bitrate,
      sampleRate: 48_000,
      numberOfChannels: 2,
    });
    if (native) return "native" as const;
    const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
    registerAacEncoder();
    return "wasm" as const;
  })().then(
    (source) => (resolvedSource = source),
    (error: unknown) => {
      // A failed chunk load must not poison later exports.
      registration = null;
      throw error;
    },
  );
  return registration;
}

/** Which AAC encoder this page uses, once an AAC output has been started. */
export function getAacEncoderSource(): AacEncoderSource | null {
  return resolvedSource;
}
