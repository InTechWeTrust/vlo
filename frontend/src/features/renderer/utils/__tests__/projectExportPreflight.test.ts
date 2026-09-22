import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assetIndexDocumentSchema, projectManifestDocumentSchema, timelineDocumentSchema,
} from "../../../project/schemas/projectPersistenceSchemas";
import {
  createDetachedRenderDocument, inspectProjectRenderInputs, ProjectExportPreflightError,
  findDetachedRenderBlockers,
} from "../projectExportPreflight";
import { detachedRenderDocumentSchema } from "../../schemas/projectRenderSnapshot";

const root = resolve(process.cwd(), "../shared/fixtures/render");

function savedProject(hydrated = true, fixture = "saved-media-project.json") {
  const bundle: { manifest: unknown; timeline: unknown; assets: unknown } = JSON.parse(readFileSync(resolve(root, fixture), "utf8"));
  const manifest = projectManifestDocumentSchema.parse(bundle.manifest);
  const timeline = timelineDocumentSchema.parse(bundle.timeline);
  const index = assetIndexDocumentSchema.parse(bundle.assets);
  return {
    tracks: timeline.tracks, clips: timeline.clips, transitions: timeline.transitions,
    assets: Object.values(index.assets).map((asset) => ({ ...asset,
      ...(asset.metadataRef ? { metadataLoaded: hydrated } : {}),
    })),
    duration: 576_000, fps: manifest.config.fps!,
  };
}

function expectedDocument() {
  return detachedRenderDocumentSchema.parse(JSON.parse(readFileSync(resolve(root, "detached-render-document.json"), "utf8")));
}

function options() {
  const expected = expectedDocument();
  return { projectData: savedProject(), geometry: expected.geometry, encoding: expected.encoding };
}

describe("project export preflight", () => {
  it("keeps a spline left after its keyframes were removed, as the animation it still is", () => {
    // `collapseConstantSpline` keeps single-point splines; the renderer
    // evaluates them to their one value, so they are carried, not refused.
    const value = savedProject();
    const position = value.clips[0].transformations.find((transform) => transform.type === "position")!;
    position.keyframeTimes = [];
    position.parameters.x = { type: "spline", points: [{ time: 0, value: 12 }] };
    const clip = inspectProjectRenderInputs(value).clips[0];
    expect(clip.transformations.find((transform) => transform.type === "position")?.parameters)
      .toMatchObject({ x: { type: "spline", points: [{ time: 0, value: 12 }] } });
  });

  it("creates the detached document from current saved project documents", () => {
    const input = options();
    const result = createDetachedRenderDocument(input);
    expect(result).toEqual(expectedDocument());
    // Assets are named by ID; no locator, live URL or editor hash crosses over.
    expect(JSON.stringify(result)).not.toMatch(/editor-xxhash|metadataRef|assets\/|blob:|sourcePath/);
    input.projectData.clips[0].offset = 0;
    expect(result.clips[0].offset).toBe(96_000);
  });

  it("requires lazy metadata to be hydrated before capture", () => {
    expect(() => inspectProjectRenderInputs(savedProject(false))).toThrow(ProjectExportPreflightError);
    try { inspectProjectRenderInputs(savedProject(false)); } catch (error) {
      expect((error as ProjectExportPreflightError).issues[0]).toMatchObject({ code: "asset-not-ready", path: "assets.movie" });
    }
  });

  it("rejects unsupported fields before projecting the document", () => {
    const value = savedProject();
    Object.assign(value.clips[0], { futureRenderDependency: "asset" });
    expect(() => inspectProjectRenderInputs(value)).toThrow(/futureRenderDependency/);
  });

  it("rejects hidden composite/mask/extension dependencies too", () => {
    for (const field of ["compositeId", "extensionPayload", "effectMask"]) {
      const value = savedProject();
      value.tracks[1].isVisible = false;
      Object.assign(value.clips[0], { [field]: "unsupported" });
      expect(() => inspectProjectRenderInputs(value)).toThrow(ProjectExportPreflightError);
    }
  });

  it("names unsupported features as the user knows them, counted, not as schema paths", () => {
    const value = savedProject() as ReturnType<typeof savedProject> & Record<string, unknown>;
    const [first, second] = value.clips;
    const loose = value as unknown as { tracks: unknown[]; clips: unknown[]; transitions: unknown[] };
    loose.clips.push({ id: "t1", type: "text", trackId: first.trackId });
    Object.assign(second, { compositeId: "nested" });
    first.transformations.push(
      { id: "glow", type: "filter", filterName: "GlowFilter", isEnabled: true, parameters: {} } as never,
      { id: "speed", type: "speed", isEnabled: true, parameters: { factor: 2 } } as never,
      { id: "eq", type: "audioEq", isEnabled: true, parameters: {} } as never,
    );
    loose.transitions.push({ id: "fade" });

    const messages = findDetachedRenderBlockers(value).map((issue) => issue.message);
    expect(messages).toEqual(expect.arrayContaining([
      "Text clips (1)", "Composites (1)", "The Glow effect (1)", "Speed changes (1)",
      "The audioEq transform (1)", "Transitions (1)",
    ]));
    // One readable sentence, and a way forward, instead of a wall of paths.
    expect(() => inspectProjectRenderInputs(value)).toThrow(
      /^A separate render window doesn't support these yet: .*Text clips \(1\).*Export in the editor instead\.$/);
  });

  it("does not count masks, grades, keyframes or adjustment layers as blockers", () => {
    expect(findDetachedRenderBlockers(savedProject(true, "saved-mask-grade-project.json"))).toEqual([]);
  });

  it("does not let an empty track of an unsupported type block the export", () => {
    const value = savedProject();
    (value.tracks as unknown[]).unshift(
      { id: "prompts", type: "prompt", label: "Prompts", isVisible: true, isMuted: false, isLocked: false });
    expect(findDetachedRenderBlockers(value)).toEqual([]);
    const document = createDetachedRenderDocument({ ...options(), projectData: value });
    // Left out rather than refused; the tracks that render keep their order.
    expect(document.tracks.map((track) => track.id)).toEqual(savedProject().tracks.map((track) => track.id));
  });

  it("fails missing assets and invalid topology before reading any asset", () => {
    const missing = savedProject();
    missing.assets = missing.assets.filter((asset) => asset.id !== "movie");
    expect(() => inspectProjectRenderInputs(missing)).toThrow(/Referenced asset is missing/);
    const overlap = savedProject();
    overlap.clips[1].start = 0;
    expect(() => inspectProjectRenderInputs(overlap)).toThrow(/Same-track overlap/);
    const wrongTrack = savedProject();
    wrongTrack.clips[0].trackId = "absent";
    expect(() => inspectProjectRenderInputs(wrongTrack)).toThrow(/Missing clip track/);
  });

  it("collects referenced original assets once and ignores unused library content", () => {
    const value = savedProject();
    const result = inspectProjectRenderInputs({ ...value, composites: [{ id: "unused" }],
      assets: [...value.assets, { id: "unused-lut", type: "lut", futureMetadata: {} }] });
    expect(result.dependencies.map((asset) => asset.id)).toEqual(["movie", "image", "audio"]);
    expect(result.dependencies[0]).not.toHaveProperty("src");
  });

  it("rounds full-project output duration up to the same frame grid as ExportRenderer", () => {
    const result = inspectProjectRenderInputs({ ...savedProject(), duration: 576_001 });
    expect(result.durationTicks).toBe(579_200);
  });
});

describe("masks, grading and adjustment layers", () => {
  const masked = () => savedProject(true, "saved-mask-grade-project.json");
  type LooseClip = Record<string, unknown> & { id: string; components?: Record<string, unknown>[] };
  const clip = (value: ReturnType<typeof masked>, id: string) =>
    (value.clips as unknown as LooseClip[]).find((candidate) => candidate.id === id)!;

  it("hands over every asset a frame reads: clip media, each mask's source and the grade's LUT", () => {
    const result = inspectProjectRenderInputs(masked());
    expect(result.dependencies.map((asset) => [asset.id, asset.type, asset.duration]).sort()).toEqual([
      ["audio", "audio", 10], ["brush-png", "image", null], ["image", "image", null],
      ["look", "lut", null], ["movie", "video", 10], ["sam-mask", "video", 10],
    ]);
  });

  it("drops SAM2 prompts and markers, which make masks rather than draw them", () => {
    const result = inspectProjectRenderInputs(masked());
    const text = JSON.stringify(result.clips);
    expect(text).not.toMatch(/maskPoints|sam2GeneratedPointsHash|sam2LastGeneratedAt|"markers"/);
    // The mask itself, its grow and its active window are render input and stay.
    expect(result.clips.find((candidate) => candidate.id === "trimmed::mask::sam"))
      .toMatchObject({ sam2MaskAssetId: "sam-mask", sam2GrowAmount: 2,
        activeRange: { startSourceTicks: 96_000, endSourceTicks: 288_000 } });
  });

  it("hands over only the asset a mask draws from, not ids left from an earlier mask type", () => {
    const value = masked();
    Object.assign(clip(value, "trimmed::mask::circle"), { generationMaskAssetId: "stale-generation" });
    expect(inspectProjectRenderInputs(value).dependencies.map((asset) => asset.id)).not.toContain("stale-generation");
  });

  it("refuses a mask whose generated asset is missing rather than rendering the clip unmasked", () => {
    const value = masked();
    value.assets = value.assets.filter((asset) => asset.id !== "sam-mask");
    expect(() => inspectProjectRenderInputs(value)).toThrow(/Referenced asset is missing/);
  });

  it("refuses a LUT that is not a LUT, and a grade naming a LUT that is gone", () => {
    const wrongType = masked();
    Object.assign(wrongType.assets.find((asset) => asset.id === "look")!, { type: "image" });
    expect(() => inspectProjectRenderInputs(wrongType)).toThrow(/not a type its use accepts/);
    const missing = masked();
    missing.assets = missing.assets.filter((asset) => asset.id !== "look");
    expect(() => inspectProjectRenderInputs(missing)).toThrow(/Referenced asset is missing/);
  });

  it.each([
    ["a mask its parent does not reference", (value: ReturnType<typeof masked>) => {
      clip(value, "trimmed").components = clip(value, "trimmed").components!.filter((component) => component.id !== "ref-sam");
    }, /not attached to its parent/],
    ["an expression naming another clip's mask", (value: ReturnType<typeof masked>) => {
      const composition = clip(value, "still").components!.find((component) => component.type === "mask_composition")!;
      (composition.parameters as Record<string, unknown>).expression = { kind: "mask_ref", maskId: "circle" };
    }, /does not own/],
    ["an effect mask naming a mask the clip does not own", (value: ReturnType<typeof masked>) => {
      const blur = (clip(value, "trimmed").transformations as Record<string, unknown>[]).find((transform) => transform.id === "blur")!;
      blur.effectMask = { enabled: true, expression: { kind: "mask_ref", maskId: "brush" }, mode: "composite" };
    }, /does not own/],
    ["a mask on another track", (value: ReturnType<typeof masked>) => {
      clip(value, "trimmed::mask::circle").trackId = "overlay";
    }, /not on its parent clip's track/],
    ["an unknown grade parameter", (value: ReturnType<typeof masked>) => {
      const grade = (clip(value, "trimmed").transformations as Record<string, unknown>[]).find((transform) => transform.id === "grade")!;
      (grade.parameters as Record<string, unknown>).futureControl = 1;
    }, /Unsupported or invalid/],
    ["an unknown mask field", (value: ReturnType<typeof masked>) => {
      clip(value, "trimmed::mask::circle").futureMaskOption = true;
    }, /Unsupported or invalid/],
  ])("refuses %s", (_name, mutate, message) => {
    const value = masked();
    mutate(value);
    expect(() => inspectProjectRenderInputs(value)).toThrow(message);
  });

  it.each([true, false])("carries an adjustment layer's mute state (%s) rather than refusing it", (isMuted) => {
    const value = masked();
    clip(value, "hsl-layer").isMuted = isMuted;
    const layer = inspectProjectRenderInputs(value).clips.find((candidate) => candidate.id === "hsl-layer");
    expect(layer).toMatchObject({ isMuted });
  });

  it("drops markers from an adjustment layer, leaving nothing that renders", () => {
    const value = masked();
    clip(value, "hsl-layer").components = [
      { id: "beats", type: "markers", parameters: { markers: [{ id: "m1", sourceTimeTicks: 0 }] } },
    ];
    const layer = inspectProjectRenderInputs(value).clips.find((candidate) => candidate.id === "hsl-layer");
    expect(JSON.stringify(layer)).not.toMatch(/markers/);
  });

  it("still refuses a render component on an adjustment layer", () => {
    const value = masked();
    clip(value, "hsl-layer").components = [
      { id: "range", type: "range_mask", parameters: { startSourceTicks: 0, endSourceTicks: 1, isActive: true } },
    ];
    expect(() => inspectProjectRenderInputs(value)).toThrow(/Unsupported or invalid/);
  });

  it("keeps masks on their parent's track without calling it an overlap", () => {
    const result = inspectProjectRenderInputs(masked());
    expect(result.clips.filter((candidate) => candidate.trackId === "main").map((candidate) => candidate.id))
      .toEqual(expect.arrayContaining(["trimmed", "cut", "trimmed::mask::circle", "trimmed::mask::sam"]));
  });
});
