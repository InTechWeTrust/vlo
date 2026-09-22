import type { RenderResult } from "../services/ExportRenderer";
import {
  renderProjectToOutput,
  type RenderProjectToOutputOptions,
} from "../services/renderProjectToOutput";
import { installDetachedAssetRuntime } from "./detachedAssetRuntime";
import type { DetachedProjectRender } from "./projectRenderBootstrap";

export type RunDetachedProjectRenderOptions = Omit<
  RenderProjectToOutputOptions,
  "exportConfig" | "projectData" | "format" | "keyFrameInterval" | "includeAudio"
> & {
  /** Where the single output goes; without it the result carries a Blob. */
  outputTarget?: RenderProjectToOutputOptions["exportConfig"]["outputTarget"];
};

/**
 * Renders a bootstrapped document in the realm that calls it, through the
 * editor's own whole-project export. The asset runtime is installed for the
 * render and torn down on every exit path, so a render host has one call to
 * make and nothing to forget.
 */
export async function runDetachedProjectRender(
  render: DetachedProjectRender,
  { outputTarget, ...options }: RunDetachedProjectRenderOptions = {},
): Promise<RenderResult> {
  const disposeAssets = installDetachedAssetRuntime(render.projectData.assets);
  try {
    return await renderProjectToOutput({
      ...options,
      exportConfig: { ...render.exportConfig, ...(outputTarget ? { outputTarget } : {}) },
      projectData: render.projectData,
      format: render.format,
      keyFrameInterval: render.keyFrameInterval,
      includeAudio: render.includeAudio,
    });
  } finally {
    disposeAssets();
  }
}
