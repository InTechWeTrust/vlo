/**
 * Canvas, bitmap, and visual media resize utilities for the generation pipeline.
 */

import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  BufferTarget,
} from "mediabunny";
import type { AspectRatioProcessingMetadata } from "../../types";
import { getOutputMediaKindFromFile } from "../../constants/mediaKinds";
import {
  extensionForMimeType,
  renameWithExtension,
} from "./files";
import { toPositiveInteger } from "./fps";
import { PROJECT_ASPECT_RATIOS } from "../../../project";

// ---------------------------------------------------------------------------
// Resize target resolution
// ---------------------------------------------------------------------------

export interface ResizeTarget {
  width: number;
  height: number;
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(Math.round(a));
  let right = Math.abs(Math.round(b));

  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }

  return left || 1;
}

function formatAspectRatio(width: number, height: number): string | null {
  const normalizedWidth = toPositiveInteger(width);
  const normalizedHeight = toPositiveInteger(height);
  if (normalizedWidth === null || normalizedHeight === null) return null;

  const divisor = greatestCommonDivisor(normalizedWidth, normalizedHeight);
  return `${normalizedWidth / divisor}:${normalizedHeight / divisor}`;
}

function parseAspectRatio(
  value: string,
): { width: number; height: number; ratio: number } | null {
  const raw = value.trim();
  if (!raw) return null;

  const separator = raw.includes(":") ? ":" : raw.includes("/") ? "/" : null;
  if (!separator) return null;

  const [widthText, heightText] = raw.split(separator, 2);
  const width = Number.parseFloat(widthText.trim());
  const height = Number.parseFloat(heightText.trim());
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  return {
    width,
    height,
    ratio: width / height,
  };
}

function nearlyEqual(left: number, right: number, epsilon = 1e-6): boolean {
  return Math.abs(left - right) <= epsilon;
}

/** Largest per-axis trim still treated as "already at the target ratio". */
const ASPECT_RATIO_CROP_TOLERANCE_PX = 2;

function resolveAspectRatioCropTarget(
  sourceWidth: number,
  sourceHeight: number,
  targetAspectRatio: string,
  options: { evenDimensions?: boolean } = {},
): ResizeTarget | null {
  const normalizedWidth = toPositiveInteger(sourceWidth);
  const normalizedHeight = toPositiveInteger(sourceHeight);
  const parsedAspectRatio = parseAspectRatio(targetAspectRatio);
  if (
    normalizedWidth === null ||
    normalizedHeight === null ||
    parsedAspectRatio === null
  ) {
    return null;
  }

  const sourceRatio = normalizedWidth / normalizedHeight;
  if (nearlyEqual(sourceRatio, parsedAspectRatio.ratio)) {
    return {
      width: normalizedWidth,
      height: normalizedHeight,
    };
  }

  let targetWidth = normalizedWidth;
  let targetHeight = normalizedHeight;

  if (sourceRatio > parsedAspectRatio.ratio) {
    targetWidth = Math.max(
      1,
      Math.round(normalizedHeight * parsedAspectRatio.ratio),
    );
  } else {
    targetHeight = Math.max(
      1,
      Math.round(normalizedWidth / parsedAspectRatio.ratio),
    );
  }

  // A trim this small is rounding, not a different ratio: renders pin the
  // short edge and round the long edge to even (480p 16:9 is 854x480, not
  // 853.33x480). Cropping it would buy a lossy video re-encode for 1-2px.
  if (
    normalizedWidth - targetWidth <= ASPECT_RATIO_CROP_TOLERANCE_PX &&
    normalizedHeight - targetHeight <= ASPECT_RATIO_CROP_TOLERANCE_PX
  ) {
    return {
      width: normalizedWidth,
      height: normalizedHeight,
    };
  }

  if (options.evenDimensions) {
    if (targetWidth > 1 && targetWidth % 2 !== 0) {
      targetWidth -= 1;
    }
    if (targetHeight > 1 && targetHeight % 2 !== 0) {
      targetHeight -= 1;
    }
  }

  return {
    width: Math.max(1, targetWidth),
    height: Math.max(1, targetHeight),
  };
}

export function normalizeToSupportedProjectAspectRatio(
  aspectRatio: string,
  extraCandidates: readonly string[] = [],
): string | null {
  const parsedAspectRatio = parseAspectRatio(aspectRatio);
  if (!parsedAspectRatio) {
    return null;
  }

  const candidates = [...PROJECT_ASPECT_RATIOS, ...extraCandidates];
  let closestAspectRatio = candidates[0] ?? null;
  let closestDelta = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const parsedCandidate = parseAspectRatio(candidate);
    if (!parsedCandidate) {
      continue;
    }

    const delta = Math.abs(parsedAspectRatio.ratio - parsedCandidate.ratio);
    if (delta < closestDelta) {
      closestDelta = delta;
      closestAspectRatio = candidate;
    }
  }

  return closestAspectRatio;
}

export function resolveResizeTarget(
  metadata: AspectRatioProcessingMetadata | null | undefined,
): ResizeTarget | null {
  if (!metadata || metadata.enabled !== true) return null;
  const postprocess = metadata.postprocess;
  if (!postprocess || postprocess.enabled !== true) return null;
  if (postprocess.mode !== "stretch_exact") return null;
  if (postprocess.apply_to !== "all_visual_outputs") return null;
  const width = toPositiveInteger(postprocess.target_width);
  const height = toPositiveInteger(postprocess.target_height);
  if (width === null || height === null) return null;
  return { width, height };
}

/**
 * True only when the workflow itself emitted *every* visual output at the
 * delivered size, so the browser resize — a full decode plus a second lossy
 * encode — can be skipped.
 *
 * Fail-closed on purpose: this reads the backend's explicit verdict, never the
 * length of `applied_nodes`. A stage that declares two resize nodes and writes
 * one has covered only some outputs, and the rest still need resizing here.
 */
export function didWorkflowSizeAllVisualOutputs(
  metadata: AspectRatioProcessingMetadata | null | undefined,
): boolean {
  return metadata?.postprocess?.all_visual_outputs_handled === true;
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

export function createOutputCanvas(
  width: number,
  height: number,
): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function isCanvas2DContext(
  value: OffscreenCanvasRenderingContext2D | RenderingContext | null,
): value is OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  return (
    value !== null &&
    typeof (value as { drawImage?: unknown }).drawImage === "function" &&
    typeof (value as { clearRect?: unknown }).clearRect === "function"
  );
}

export async function convertCanvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mimeType: string,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    if (mimeType === "image/jpeg" || mimeType === "image/webp") {
      return canvas.convertToBlob({ type: mimeType, quality: 0.95 });
    }
    return canvas.convertToBlob({ type: mimeType });
  }
  return new Promise<Blob>((resolve, reject) => {
    const onBlob = (blob: Blob | null) => {
      if (!blob) {
        reject(new Error("Canvas conversion returned an empty blob"));
        return;
      }
      resolve(blob);
    };
    if (mimeType === "image/jpeg" || mimeType === "image/webp") {
      canvas.toBlob(onBlob, mimeType, 0.95);
      return;
    }
    canvas.toBlob(onBlob, mimeType);
  });
}

// ---------------------------------------------------------------------------
// MIME type resolution
// ---------------------------------------------------------------------------

export function resolveImageOutputMimeType(input: File): string {
  const type = input.type.toLowerCase();
  if (
    type === "image/png" ||
    type === "image/jpeg" ||
    type === "image/webp" ||
    type === "image/bmp"
  ) {
    return type;
  }
  return "image/png";
}

export function resolveVideoOutputContainer(
  input: File,
): {
  mimeType: "video/mp4";
  format: Mp4OutputFormat;
} {
  void input;
  return {
    mimeType: "video/mp4",
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
  };
}

// ---------------------------------------------------------------------------
// Input media probing
// ---------------------------------------------------------------------------

export async function probeVisualFileAspectRatio(
  file: File,
): Promise<string | null> {
  const mediaKind = getOutputMediaKindFromFile(file);
  if (mediaKind === "image") {
    const bitmap = await createImageBitmap(file);
    try {
      return formatAspectRatio(bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }

  if (mediaKind !== "video") {
    return null;
  }

  const probeBlob = file.slice(0, 1);
  if (typeof probeBlob.arrayBuffer !== "function") {
    return null;
  }

  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) return null;
    return formatAspectRatio(videoTrack.displayWidth, videoTrack.displayHeight);
  } finally {
    input.dispose();
  }
}

// ---------------------------------------------------------------------------
// Image / video resize
// ---------------------------------------------------------------------------

export async function resizeImageToExactDimensions(
  file: File,
  target: ResizeTarget,
): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width === target.width && bitmap.height === target.height) {
      return file;
    }

    const canvas = createOutputCanvas(target.width, target.height);
    const context2dRaw = canvas.getContext("2d");
    if (!isCanvas2DContext(context2dRaw)) {
      throw new Error("Failed to acquire 2D context for image resize");
    }
    context2dRaw.clearRect(0, 0, target.width, target.height);
    context2dRaw.drawImage(bitmap, 0, 0, target.width, target.height);

    const outputMimeType = resolveImageOutputMimeType(file);
    const outputBlob = await convertCanvasToBlob(canvas, outputMimeType);
    const outputName = renameWithExtension(
      file.name,
      extensionForMimeType(outputMimeType),
    );
    return new File([outputBlob], outputName, {
      type: outputMimeType,
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}

export async function cropImageToAspectRatio(
  file: File,
  targetAspectRatio: string,
): Promise<File> {
  if (typeof createImageBitmap !== "function") {
    return file;
  }

  const bitmap = await createImageBitmap(file);
  try {
    const cropTarget = resolveAspectRatioCropTarget(
      bitmap.width,
      bitmap.height,
      targetAspectRatio,
    );
    if (
      !cropTarget ||
      (cropTarget.width === bitmap.width && cropTarget.height === bitmap.height)
    ) {
      return file;
    }

    const offsetX = Math.max(0, Math.floor((bitmap.width - cropTarget.width) / 2));
    const offsetY = Math.max(
      0,
      Math.floor((bitmap.height - cropTarget.height) / 2),
    );

    const canvas = createOutputCanvas(cropTarget.width, cropTarget.height);
    const context2dRaw = canvas.getContext("2d");
    if (!isCanvas2DContext(context2dRaw)) {
      throw new Error("Failed to acquire 2D context for image crop");
    }

    context2dRaw.clearRect(0, 0, cropTarget.width, cropTarget.height);
    context2dRaw.drawImage(
      bitmap,
      offsetX,
      offsetY,
      cropTarget.width,
      cropTarget.height,
      0,
      0,
      cropTarget.width,
      cropTarget.height,
    );

    const outputMimeType = resolveImageOutputMimeType(file);
    const outputBlob = await convertCanvasToBlob(canvas, outputMimeType);
    const outputName = renameWithExtension(
      file.name,
      extensionForMimeType(outputMimeType),
    );
    return new File([outputBlob], outputName, {
      type: outputMimeType,
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}

/**
 * Generated video is re-encoded here only to undo the strided generation
 * canvas, so this pass sits on top of ComfyUI's own encode and feeds an asset
 * that gets encoded a third time on export. Favour fidelity over size: the
 * clips are seconds long. Matches the generation feature's other
 * fidelity-first re-encodes (see `MASK_CROP_VIDEO_BITRATE`).
 *
 * Deliberately an explicit rate rather than mediabunny's `QUALITY_HIGH`, which
 * resolves to ~2.8 Mbps for AVC at 1280x720 and would visibly degrade output.
 */
export const ASPECT_RATIO_RESIZE_VIDEO_BITRATE = 20_000_000;

export async function resizeVideoToExactDimensions(
  file: File,
  target: ResizeTarget,
): Promise<File> {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (
      videoTrack &&
      videoTrack.displayWidth === target.width &&
      videoTrack.displayHeight === target.height
    ) {
      return file;
    }

    const { mimeType, format } = resolveVideoOutputContainer(file);
    const outputTarget = new BufferTarget();
    const output = new Output({
      format,
      target: outputTarget,
    });
    const conversion = await Conversion.init({
      input,
      output,
      video: {
        width: target.width,
        height: target.height,
        fit: "fill",
        bitrate: ASPECT_RATIO_RESIZE_VIDEO_BITRATE,
        // `no-preference`, not `prefer-hardware`: mediabunny fails closed on
        // `isConfigSupported`, so preferring hardware throws where software
        // encode would have worked — and the callers here swallow that into a
        // silently unprocessed output. See TextureOutputEncoder for the rationale.
        hardwareAcceleration: "no-preference",
      },
    });
    await conversion.execute();
    if (!outputTarget.buffer) {
      throw new Error("Video resize output buffer is empty");
    }
    const outputName = renameWithExtension(
      file.name,
      extensionForMimeType(mimeType),
    );
    return new File([outputTarget.buffer], outputName, {
      type: mimeType,
      lastModified: Date.now(),
    });
  } finally {
    input.dispose();
  }
}

export async function cropVideoToAspectRatio(
  file: File,
  targetAspectRatio: string,
): Promise<File> {
  const probeBlob = file.slice(0, 1);
  if (typeof probeBlob.arrayBuffer !== "function") {
    return file;
  }

  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      return file;
    }

    const cropTarget = resolveAspectRatioCropTarget(
      videoTrack.displayWidth,
      videoTrack.displayHeight,
      targetAspectRatio,
      { evenDimensions: true },
    );
    if (
      !cropTarget ||
      (cropTarget.width === videoTrack.displayWidth &&
        cropTarget.height === videoTrack.displayHeight)
    ) {
      return file;
    }

    const { mimeType, format } = resolveVideoOutputContainer(file);
    const outputTarget = new BufferTarget();
    const output = new Output({
      format,
      target: outputTarget,
    });
    const conversion = await Conversion.init({
      input,
      output,
      video: {
        width: cropTarget.width,
        height: cropTarget.height,
        fit: "cover",
        // `no-preference`, not `prefer-hardware`: mediabunny fails closed on
        // `isConfigSupported`, so preferring hardware throws where software
        // encode would have worked — and the callers here swallow that into a
        // silently unprocessed output. See TextureOutputEncoder for the rationale.
        hardwareAcceleration: "no-preference",
      },
    });
    await conversion.execute();
    if (!outputTarget.buffer) {
      throw new Error("Video crop output buffer is empty");
    }

    const outputName = renameWithExtension(
      file.name,
      extensionForMimeType(mimeType),
    );
    return new File([outputTarget.buffer], outputName, {
      type: mimeType,
      lastModified: Date.now(),
    });
  } finally {
    input.dispose();
  }
}

export async function maybeResizeVisualFile(
  file: File,
  target: ResizeTarget | null,
): Promise<File> {
  if (!target) return file;
  const mediaKind = getOutputMediaKindFromFile(file);
  if (mediaKind === "image") {
    try {
      return await resizeImageToExactDimensions(file, target);
    } catch (error) {
      console.warn("[Generation] Failed to resize image output", error);
      return file;
    }
  }
  if (mediaKind === "video") {
    try {
      return await resizeVideoToExactDimensions(file, target);
    } catch (error) {
      console.warn("[Generation] Failed to resize video output", error);
      return file;
    }
  }
  return file;
}

export async function maybeCropVisualFileToAspectRatio(
  file: File,
  targetAspectRatio: string,
): Promise<File> {
  const mediaKind = getOutputMediaKindFromFile(file);
  if (mediaKind === "image") {
    try {
      return await cropImageToAspectRatio(file, targetAspectRatio);
    } catch (error) {
      console.warn("[Generation] Failed to crop image input", error);
      return file;
    }
  }

  if (mediaKind === "video") {
    try {
      return await cropVideoToAspectRatio(file, targetAspectRatio);
    } catch (error) {
      console.warn("[Generation] Failed to crop video input", error);
      return file;
    }
  }

  return file;
}
