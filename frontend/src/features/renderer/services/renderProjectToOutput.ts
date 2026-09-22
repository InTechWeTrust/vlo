import { projectTimelineSelection } from "../../timeline/time";
import type { ExportConfig, ProjectData, RenderResult } from "./ExportRenderer";
import {
  renderSelectionToOutput,
  type RenderSelectionToVideoFileOptions,
} from "./renderSelectionToVideoFile";

export interface RenderProjectToOutputOptions
  extends Pick<
    RenderSelectionToVideoFileOptions,
    | "signal"
    | "onProgress"
    | "onPhaseChange"
    | "onDiagnostic"
    | "format"
    | "keyFrameInterval"
    | "includeAudio"
    | "onRendererCreated"
  > {
  exportConfig: ExportConfig;
  /** Captured with brush masks already materialized. */
  projectData: ProjectData;
}

/**
 * A whole-project export, from tick zero to the end of the timeline. The
 * editor's export dialog and a detached render host both come through here,
 * so the two execution paths cannot disagree about which selection, output
 * definition or normalization a project export means.
 */
export function renderProjectToOutput({
  exportConfig,
  projectData,
  ...options
}: RenderProjectToOutputOptions): Promise<RenderResult> {
  return renderSelectionToOutput(
    projectTimelineSelection({
      start: 0,
      end: projectData.duration,
      clips: projectData.clips,
      tracks: projectData.tracks,
      transitions: projectData.transitions,
      fps: projectData.fps,
    }, projectData),
    {
      ...options,
      renderInputs: { exportConfig, projectData, brushMasksPrepared: true },
      // The selection above is already the detached whole timeline.
      skipNormalize: true,
      debugLabel: "project export",
    },
  );
}
