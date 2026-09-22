import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ticksPerFrame } from "../../../../core/time";
import {
  assetIndexDocumentSchema, projectManifestDocumentSchema, timelineDocumentSchema,
} from "../../../project/schemas/projectPersistenceSchemas";
import type { AspectRatio } from "../../../project/useProjectStore";
import { getProjectDimensions, resolveRenderOutputDimensions } from "../dimensions";
import { createDetachedRenderDocument, findDetachedRenderBlockers } from "../projectExportPreflight";

const project = resolve(process.cwd(), "e2e/fixtures/project_mask_grade/.vloproject");
const read = (name: string): unknown => JSON.parse(readFileSync(resolve(project, name), "utf8"));

/** The project the editor opens in the export parity spec, as saved. */
function savedProjectData() {
  const manifest = projectManifestDocumentSchema.parse(read("project.json"));
  const timeline = timelineDocumentSchema.parse(read("timeline.json"));
  const assets = assetIndexDocumentSchema.parse(read("assets.json"));
  const aspectRatio = manifest.config.aspectRatio as AspectRatio;
  return {
    aspectRatio,
    outputResolution: manifest.config.outputResolution,
    projectData: {
      tracks: timeline.tracks, clips: timeline.clips, transitions: timeline.transitions,
      assets: Object.values(assets.assets),
      duration: Math.max(...timeline.clips.map((clip) => clip.start + clip.timelineDuration)),
      fps: manifest.config.fps!,
    },
  };
}

describe("export parity fixture", () => {
  // The parity spec holds every host to one set of expectations, so the
  // project must be one a separate render window can take at all.
  it("captures into a detached render document without blockers", () => {
    const { aspectRatio, outputResolution, projectData } = savedProjectData();
    expect(findDetachedRenderBlockers(projectData)).toEqual([]);
    const logical = getProjectDimensions(aspectRatio);
    const output = resolveRenderOutputDimensions(aspectRatio, outputResolution);
    const document = createDetachedRenderDocument({
      projectData,
      geometry: {
        logicalWidth: logical.width, logicalHeight: logical.height,
        outputWidth: output.width, outputHeight: output.height, backgroundAlpha: 0,
      },
      encoding: { format: "mp4", includeAudio: false, keyFrameInterval: 1 },
    });
    const expectations = JSON.parse(readFileSync(
      resolve(process.cwd(), "../shared/fixtures/export-parity/mask-grade-expectations.json"), "utf8",
    )) as { fps: number; frames: number; width: number; height: number };
    expect(document.fps).toBe(expectations.fps);
    expect(document.durationTicks / ticksPerFrame(document.fps)).toBe(expectations.frames);
    expect([document.geometry.outputWidth, document.geometry.outputHeight])
      .toEqual([expectations.width, expectations.height]);
    expect(document.assets.map((asset) => asset.type)).toEqual(expect.arrayContaining(["lut", "video", "image"]));
  });
});
