import { canEncodeAudio, canEncodeVideo } from "mediabunny";
import {
  outputEncodingSettings,
  type OutputVideoFormat,
} from "../services/TextureOutputEncoder";

const ACCELERATION_PREFERENCES = ["no-preference", "prefer-hardware", "prefer-software"] as const;

async function check(probe: () => Promise<boolean>): Promise<boolean | string> {
  try {
    return await probe();
  } catch (error) {
    return String(error);
  }
}

/**
 * Checks each output format with the encoder's own settings, through the same
 * Mediabunny checks the encoder applies before configuring WebCodecs.
 */
async function probeFormat(format: OutputVideoFormat, width: number, height: number) {
  const { video, audio } = outputEncodingSettings(format);
  const { codec, ...videoOptions } = video;
  const videoSupport: Record<string, boolean | string> = {};
  for (const hardwareAcceleration of ACCELERATION_PREFERENCES) {
    // The encoder itself always asks for `no-preference`; the other two
    // preferences are diagnostics for hardware/software availability.
    videoSupport[hardwareAcceleration] = await check(() =>
      canEncodeVideo(codec, { ...videoOptions, width, height, hardwareAcceleration }));
  }
  return {
    settings: { video, audio },
    video: videoSupport,
    audio: await check(() => canEncodeAudio(audio.codec, {
      bitrate: audio.bitrate, sampleRate: 48_000, numberOfChannels: 2,
    })),
  };
}

export async function probeRenderCapabilities(width: number, height: number) {
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

  return {
    userAgent: navigator.userAgent,
    secureContext: globalThis.isSecureContext,
    webgl: { available: gl !== null, renderer, vendor,
      software: renderer !== null && /swiftshader|llvmpipe|softpipe|software/i.test(renderer) },
    encoding: {
      mp4: await probeFormat("mp4", width, height),
      webm: await probeFormat("webm", width, height),
    },
    // Support checks are diagnostic, not proof of the encoder selected.
    hardwareEncodingVerified: false,
  };
}
