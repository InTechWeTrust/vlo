import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Output,
  WavOutputFormat,
} from "mediabunny";

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Audio extraction cancelled");
  error.name = "AbortError";
  throw error;
}

export interface ExtractAudioTrackOptions {
  /** Window of the source to keep, in seconds. Whole track when omitted. */
  trim?: { start: number; end: number };
  signal?: AbortSignal;
  /** Base name for the produced File; the extension is appended. */
  filenamePrefix?: string;
}

/**
 * Pulls a media file's primary audio track out as WAV — whole file or a window
 * of it. Null rather than a throw for "there was nothing to convert" (no audio
 * track, a conversion this browser cannot run, or an empty result), which is
 * how callers read a missing soundtrack.
 *
 * Lives in core because both the generation slots and the timeline's
 * audio-only extraction need it, and neither feature may import the other.
 */
export async function extractAudioTrackToWav(
  file: File,
  options: ExtractAudioTrackOptions = {},
): Promise<File | null> {
  throwIfAborted(options.signal);
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });

  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    throwIfAborted(options.signal);
    if (!audioTrack) return null;

    const target = new BufferTarget();
    const output = new Output({
      format: new WavOutputFormat(),
      target,
    });

    const conversion = await Conversion.init({
      input,
      output,
      ...(options.trim ? { trim: options.trim } : {}),
      video: { discard: true },
    });
    if (!conversion.isValid) return null;
    await conversion.execute();
    throwIfAborted(options.signal);

    if (!target.buffer) return null;
    const prefix = options.filenamePrefix ?? "audio";
    return new File([target.buffer], `${prefix}-${Date.now()}.wav`, {
      type: "audio/wav",
      lastModified: Date.now(),
    });
  } finally {
    input.dispose();
  }
}
