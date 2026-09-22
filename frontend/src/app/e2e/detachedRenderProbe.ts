import { prepareBrushMasksForTimelineRender } from "../../features/masks/api";
import {
  probeRenderCapabilities,
  type RenderCapabilities,
} from "../../features/renderer/detached/capabilities";
import { bootstrapProjectRender } from "../../features/renderer/detached/projectRenderBootstrap";
import { runDetachedProjectRender } from "../../features/renderer/detached/runDetachedProjectRender";
import { buildProjectRenderInputs } from "../../features/renderer/services/projectFrameCapture";
import { createDetachedRenderDocument } from "../../features/renderer/utils/projectExportPreflight";
import { ensureAssetSourceLoaded, getAssets } from "../../features/userAssets/api";
import {
  sampleVideoColours,
  waitForReferencedAssets,
  type ProjectExportPixelProbeResult,
  type ProjectExportPixelSample,
} from "./projectExportPixelProbe";

/**
 * The detached half of the export parity check. Capture runs in the editor;
 * the render runs in a second page with no project open, which is a realm of
 * its own: its own module graph, stores and empty asset library, as a
 * separate render window would be. The document and asset bytes cross
 * between the two through the test, as data URLs.
 *
 * Capture here is deliberately minimal (phase 2 of docs/pip-render-plan.md
 * owns the real one): it exists to prove the render side needs nothing from
 * the editor's realm.
 */

export interface DetachedRenderProbeInput {
  document: unknown;
  /** Each document asset's bytes, by asset ID. */
  files: Record<string, string>;
}

export interface DetachedRenderProbeResult extends ProjectExportPixelProbeResult {
  /** The realm's asset library once the render has returned. */
  assetsAfterRender: number;
  /** Readiness as probed in this realm, before the render started. */
  capabilities: RenderCapabilities;
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("detached render probe: read failed"));
    reader.readAsDataURL(blob);
  });
}

export async function captureDetachedRenderProbeInput(): Promise<DetachedRenderProbeInput> {
  await waitForReferencedAssets();
  await prepareBrushMasksForTimelineRender();
  const { exportConfig, projectData } = buildProjectRenderInputs();
  const document = createDetachedRenderDocument({
    projectData,
    geometry: {
      logicalWidth: exportConfig.logicalWidth, logicalHeight: exportConfig.logicalHeight,
      outputWidth: exportConfig.outputWidth, outputHeight: exportConfig.outputHeight,
      backgroundAlpha: exportConfig.backgroundAlpha ?? 1,
    },
    encoding: { format: "mp4", includeAudio: true, keyFrameInterval: 1 },
  });
  const files: Record<string, string> = {};
  for (const { id } of document.assets) {
    const asset = await ensureAssetSourceLoaded(id);
    if (!asset) throw new Error(`detached render probe: asset ${id} is unavailable`);
    const blob = asset.file ?? await (await fetch(asset.src)).blob();
    files[id] = await toDataUrl(blob);
  }
  return { document, files };
}

export async function runDetachedRenderPixelProbe(request: {
  input: DetachedRenderProbeInput;
  samples: ProjectExportPixelSample[];
}): Promise<DetachedRenderProbeResult> {
  // What a render host does with the files it is handed: mint its own URLs.
  const urls = new Map<string, string>();
  try {
    for (const [id, dataUrl] of Object.entries(request.input.files)) {
      urls.set(id, URL.createObjectURL(await (await fetch(dataUrl)).blob()));
    }
    const render = bootstrapProjectRender(request.input.document, (asset) => {
      const url = urls.get(asset.id);
      if (!url) throw new Error(`detached render probe: no file for asset ${asset.id}`);
      return url;
    });
    // What a render host checks before it starts: this realm, this output.
    const capabilities = await probeRenderCapabilities({
      format: render.format, includeAudio: render.includeAudio,
      width: render.exportConfig.outputWidth, height: render.exportConfig.outputHeight,
    });
    if (!capabilities.ready) {
      throw new Error(`detached render probe: realm not ready: ${capabilities.blockers.join(" ")}`);
    }
    const result = await runDetachedProjectRender(render);
    if (!result.video) throw new Error("detached render probe: no video was produced");
    return {
      ...await sampleVideoColours(result.video, render.projectData.fps, request.samples),
      assetsAfterRender: getAssets().length,
      capabilities,
    };
  } finally {
    for (const url of urls.values()) URL.revokeObjectURL(url);
  }
}
