import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { prepareBrushMasksForTimelineRender } from "../../features/masks/api";
import { maskAssetId } from "../../features/masks/renderContract";
import { buildProjectRenderInputs } from "../../features/renderer/services/projectFrameCapture";
import { renderProjectToOutput } from "../../features/renderer/services/renderProjectToOutput";
import { transformAssetIds } from "../../features/transformations/renderContract";
import { getTimelineClips } from "../../features/timeline";
import { getAssets } from "../../features/userAssets/api";

/**
 * The editor half of the export parity check (docs/pip-render-plan.md). It
 * renders the open project through `renderProjectToOutput`, the function the
 * export dialog and a detached render host both call, with the editor's own
 * live inputs, decodes the file, and reports each sample rectangle's mean
 * colour. A detached render of the same project is held to the same
 * expectations.
 */

export interface ProjectExportPixelSample {
  frame: number;
  /** Output pixels: left, top, right, bottom (exclusive). */
  rect: [number, number, number, number];
}

export interface ProjectExportPixelProbeResult {
  frames: number;
  width: number;
  height: number;
  /** Mean RGB of each requested sample, in request order. */
  colours: [number, number, number][];
}

let probeInFlight = false;

/** Every asset a frame reads: clip media, each mask's active source and LUTs. */
function referencedAssetIds(): Set<string> {
  const ids = new Set<string>();
  for (const clip of getTimelineClips()) {
    if (clip.type === "mask") {
      const id = maskAssetId(clip);
      if (id) ids.add(id);
    } else if ("assetId" in clip && clip.assetId) {
      ids.add(clip.assetId);
    }
    for (const transform of clip.transformations ?? []) {
      for (const id of transformAssetIds(transform)) ids.add(id);
    }
  }
  return ids;
}

async function waitForReferencedAssets(timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const available = new Set(getAssets().map((asset) => asset.id));
    const missing = [...referencedAssetIds()].filter((id) => !available.has(id));
    if (missing.length === 0) return;
    if (performance.now() > deadline) {
      throw new Error(`project export pixel probe: assets never loaded: ${missing.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function meanColour(
  context: CanvasRenderingContext2D,
  [left, top, right, bottom]: ProjectExportPixelSample["rect"],
): [number, number, number] {
  const { data } = context.getImageData(left, top, right - left, bottom - top);
  const sum = [0, 0, 0];
  for (let index = 0; index < data.length; index += 4) {
    sum[0] += data[index];
    sum[1] += data[index + 1];
    sum[2] += data[index + 2];
  }
  const count = data.length / 4;
  return [sum[0] / count, sum[1] / count, sum[2] / count];
}

export async function runProjectExportPixelProbe(request: {
  samples: ProjectExportPixelSample[];
}): Promise<ProjectExportPixelProbeResult> {
  if (probeInFlight) throw new Error("project export pixel probe: a probe is already running");
  probeInFlight = true;
  try {
    await waitForReferencedAssets();
    // What the export dialog does before it snapshots the project.
    await prepareBrushMasksForTimelineRender();
    const { exportConfig, projectData } = buildProjectRenderInputs();
    const result = await renderProjectToOutput({
      exportConfig, projectData, format: "mp4", includeAudio: false, keyFrameInterval: 1,
    });
    if (!result.video) throw new Error("project export pixel probe: no video was produced");

    const input = new Input({ source: new BlobSource(result.video), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("project export pixel probe: output has no video track");
      const frames = (await track.computePacketStats()).packetCount;
      const sink = new CanvasSink(track, { poolSize: 1 });
      const colours: [number, number, number][] = [];
      for (const sample of request.samples) {
        // Mid-frame, so the sample cannot land on a neighbouring frame's edge.
        const wrapped = await sink.getCanvas((sample.frame + 0.5) / projectData.fps);
        if (!wrapped || !(wrapped.canvas instanceof HTMLCanvasElement)) {
          throw new Error(`project export pixel probe: frame ${sample.frame} is unavailable`);
        }
        const context = wrapped.canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("project export pixel probe: no 2D context");
        colours.push(meanColour(context, sample.rect));
      }
      return { frames, width: track.codedWidth, height: track.codedHeight, colours };
    } finally {
      input.dispose();
    }
  } finally {
    probeInFlight = false;
  }
}
