import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import { extractAudioTrackToWav } from "../../../core/media";
import { mediaSecondsToTick, tickToMediaSeconds } from "../../../core/time";
import { renderTimelineSelectionToMp4 } from "./inputSelection";
import { throwIfAborted } from "../pipeline/utils/abort";

function toPositiveInt(
  value: number | null | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.round(value));
}

export function createAudioSelectionPlaceholderFile(): File {
  return new File(
    ["audio-selection-thumbnail-placeholder"],
    "generation-audio-selection-placeholder.txt",
    {
      type: "text/plain",
      lastModified: Date.now(),
    },
  );
}

/**
 * The one audio conversion this feature runs: whole file or a window of it,
 * always out as WAV. Null rather than a throw for "there was nothing to
 * convert" — no audio track, a conversion this browser cannot run, or an empty
 * result — which is how every caller reads a missing soundtrack.
 */
async function convertAudioToWav(
  file: File,
  options: { trim?: { start: number; end: number }; signal?: AbortSignal },
): Promise<File | null> {
  throwIfAborted(options.signal);
  return extractAudioTrackToWav(file, {
    ...(options.trim ? { trim: options.trim } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    filenamePrefix: "generation-audio",
  });
}

/** Pulls a video's whole soundtrack out as WAV. */
export async function extractAudioFromVideo(
  file: File,
  options: { signal?: AbortSignal } = {},
): Promise<File | null> {
  return convertAudioToWav(file, { signal: options.signal });
}

/** Reads an audio file's duration without decoding the whole track. */
export async function probeAudioDurationTicks(file: File): Promise<number> {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });

  try {
    const seconds = await input.computeDuration();
    return Number.isFinite(seconds) && seconds > 0
      ? mediaSecondsToTick(seconds)
      : 0;
  } finally {
    input.dispose();
  }
}

/** Cuts `file` down to `[startTicks, endTicks)`. */
export async function trimAudioFile(
  file: File,
  startTicks: number,
  endTicks: number,
  options: { signal?: AbortSignal } = {},
): Promise<File | null> {
  throwIfAborted(options.signal);
  const start = tickToMediaSeconds(startTicks);
  const end = tickToMediaSeconds(endTicks);
  if (!(end > start)) return null;
  return convertAudioToWav(file, { trim: { start, end }, signal: options.signal });
}

export async function extractAudioFromSelection(
  selection: TimelineSelection,
  options: { exportFps?: number; signal?: AbortSignal } = {},
): Promise<File | null> {
  throwIfAborted(options.signal);
  // Current implementation renders the selection once and extracts audio from the result.
  // A future iteration can move this to a direct audio-only render path.
  const normalizedSelection: TimelineSelection = { ...selection };
  const exportFps = toPositiveInt(options.exportFps, -1);
  if (exportFps > 0) {
    if (
      typeof normalizedSelection.fps !== "number" ||
      !Number.isFinite(normalizedSelection.fps) ||
      normalizedSelection.fps <= 0
    ) {
      normalizedSelection.fps = exportFps;
    }
  }
  const renderedVideo = await renderTimelineSelectionToMp4(normalizedSelection, {
    signal: options.signal,
  });
  throwIfAborted(options.signal);
  return extractAudioFromVideo(renderedVideo, { signal: options.signal });
}
