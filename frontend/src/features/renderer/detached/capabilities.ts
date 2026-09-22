import { canEncodeAudio, canEncodeVideo } from "mediabunny";
import {
  outputEncodingSettings,
  type OutputVideoFormat,
} from "../services/TextureOutputEncoder";
import { ensureAacEncoder, type AacEncoderSource } from "../services/aacEncoderFallback";

const ACCELERATION_PREFERENCES = ["no-preference", "prefer-hardware", "prefer-software"] as const;

/** The output a render host is about to produce, as its document asks. */
export interface RenderReadinessRequest {
  format: OutputVideoFormat;
  includeAudio: boolean;
  width: number;
  height: number;
}

export interface RenderAudioReadiness {
  required: boolean;
  codec: "aac" | "opus";
  /** Effective support, after any fallback the encoder itself would register. */
  supported: boolean | null;
  /** Which encoder the export will use; null when not required or unsupported. */
  encoder: AacEncoderSource | null;
  error?: string;
}

async function check(probe: () => Promise<boolean>): Promise<boolean | string> {
  try {
    return await probe();
  } catch (error) {
    return String(error);
  }
}

/**
 * Audio as the encoder will actually get it. AAC goes through the same
 * `ensureAacEncoder` the encoder calls, so a browser with no native AAC
 * (Linux Chrome) reports the WASM fallback as supported instead of refusing
 * an export that would work. Registration is realm-wide and permanent, which
 * is fine here: this realm is about to encode anyway.
 */
async function probeAudio(
  request: RenderReadinessRequest,
  audio: ReturnType<typeof outputEncodingSettings>["audio"],
): Promise<RenderAudioReadiness> {
  const base = { required: request.includeAudio, codec: audio.codec };
  if (!request.includeAudio) return { ...base, supported: null, encoder: null };
  const config = { bitrate: audio.bitrate, sampleRate: 48_000, numberOfChannels: 2 };
  try {
    const encoder: AacEncoderSource = audio.codec === "aac"
      ? await ensureAacEncoder(audio.bitrate)
      : "native";
    // Asked again after registration, so the answer covers the fallback too.
    const supported = await canEncodeAudio(audio.codec, config);
    return { ...base, supported, encoder: supported ? encoder : null };
  } catch (error) {
    return { ...base, supported: false, encoder: null, error: String(error) };
  }
}

/**
 * Probes the realm a render will run in for the output its document asks
 * for: WebGL2, the video encoder with the encoder's own settings, and audio
 * after fallback. `ready` is the decision; the rest is diagnostics, including
 * the hardware and software preferences the encoder never asks for.
 */
export async function probeRenderCapabilities(request: RenderReadinessRequest) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  const debug = gl?.getExtension("WEBGL_debug_renderer_info");
  const renderer = gl
    ? String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER))
    : null;
  const vendor = gl
    ? String(gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR))
    : null;
  gl?.getExtension("WEBGL_lose_context")?.loseContext();

  const { video, audio } = outputEncodingSettings(request.format);
  const { codec, ...videoOptions } = video;
  const videoSupport: Record<string, boolean | string> = {};
  for (const hardwareAcceleration of ACCELERATION_PREFERENCES) {
    videoSupport[hardwareAcceleration] = await check(() => canEncodeVideo(codec, {
      ...videoOptions, width: request.width, height: request.height, hardwareAcceleration,
    }));
  }
  const audioReadiness = await probeAudio(request, audio);

  const blockers: string[] = [];
  if (!gl) blockers.push("WebGL2 is unavailable.");
  // The encoder itself always asks for `no-preference`.
  if (videoSupport["no-preference"] !== true) {
    blockers.push(`${request.format.toUpperCase()} video (${codec}) cannot be encoded at ${request.width}x${request.height}.`);
  }
  if (audioReadiness.required && !audioReadiness.supported) {
    blockers.push(`${audio.codec.toUpperCase()} audio cannot be encoded.`);
  }

  return {
    ready: blockers.length === 0,
    blockers,
    request,
    userAgent: navigator.userAgent,
    secureContext: globalThis.isSecureContext,
    webgl: { available: gl !== null, renderer, vendor,
      software: renderer !== null && /swiftshader|llvmpipe|softpipe|software/i.test(renderer) },
    video: { settings: video, support: videoSupport },
    audio: { settings: audio, ...audioReadiness },
    // Support checks are diagnostic, not proof of the encoder selected.
    hardwareEncodingVerified: false,
  };
}

export type RenderCapabilities = Awaited<ReturnType<typeof probeRenderCapabilities>>;
