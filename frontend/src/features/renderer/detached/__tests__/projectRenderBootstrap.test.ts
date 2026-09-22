import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assetIndexDocumentSchema, projectManifestDocumentSchema, timelineDocumentSchema,
} from "../../../project/schemas/projectPersistenceSchemas";
import { createDetachedRenderDocument } from "../../utils/projectExportPreflight";
import {
  detachedRenderDocumentSchema, type DetachedRenderAsset,
} from "../../schemas/projectRenderSnapshot";
import { getEntryForTransform } from "../../../transformations/catalogue/TransformationRegistry";
import { bootstrapProjectRender, DetachedRenderBootstrapError } from "../projectRenderBootstrap";

vi.mock("../../../transformations/catalogue/TransformationRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../transformations/catalogue/TransformationRegistry")>();
  return { ...actual, getEntryForTransform: vi.fn(actual.getEntryForTransform) };
});

const root = resolve(process.cwd(), "../shared/fixtures/render");
const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(root, name), "utf8"));
/** Loose enough to corrupt a document the way a bad producer would. */
interface MutableDocument {
  version: unknown;
  renderer: Record<string, unknown>;
  clips: Record<string, unknown>[];
  assets: Record<string, unknown>[];
}
const url = (asset: DetachedRenderAsset) => `blob:http://host.test/${asset.id}`;

/** The editor's own ProjectData for the shared saved project, hydrated. */
function editorProjectData(name = "saved-media-project.json") {
  const bundle = fixture(name) as { manifest: unknown; timeline: unknown; assets: unknown };
  const manifest = projectManifestDocumentSchema.parse(bundle.manifest);
  const timeline = timelineDocumentSchema.parse(bundle.timeline);
  const index = assetIndexDocumentSchema.parse(bundle.assets);
  return {
    tracks: timeline.tracks, clips: timeline.clips, transitions: timeline.transitions,
    assets: Object.values(index.assets).map((asset) => ({
      ...asset, ...(asset.metadataRef ? { metadataLoaded: true } : {}),
    })),
    duration: 576_000, fps: manifest.config.fps!,
  };
}

function capturedDocument(name = "saved-media-project.json") {
  const expected = detachedRenderDocumentSchema.parse(fixture("detached-render-document.json"));
  return createDetachedRenderDocument({
    projectData: editorProjectData(name), geometry: expected.geometry, encoding: expected.encoding,
  });
}

/** The mask/grade fixture, captured the way the editor would. */
function capturedMaskGradeDocument() {
  return capturedDocument("saved-mask-grade-project.json");
}

describe("detached project render bootstrap", () => {
  it("hands masks, grades, LUTs and adjustment layers to the renderer intact", () => {
    const render = bootstrapProjectRender(JSON.parse(JSON.stringify(capturedMaskGradeDocument())), url);
    const byId = new Map(render.projectData.clips.map((clip) => [clip.id, clip]));
    expect(byId.get("trimmed::mask::sam")).toMatchObject({ type: "mask", maskType: "sam2", sam2MaskAssetId: "sam-mask" });
    expect(byId.get("trimmed::mask::sam")).not.toHaveProperty("maskPoints");
    expect(byId.get("hsl-layer")).toMatchObject({ type: "adjustment", depth: "all" });
    expect(byId.get("trimmed")?.transformations.find((transform) => transform.id === "grade")?.parameters)
      .toMatchObject({ lutAssetId: "look", exposure: { type: "spline" } });
    const look = render.projectData.assets.find((asset) => asset.id === "look");
    expect(look).toMatchObject({ type: "lut", src: "blob:http://host.test/look" });
    expect(look).not.toHaveProperty("duration");
    expect(render.projectData.tracks.find((track) => track.id === "overlay")).not.toHaveProperty("type");
  });

  it("resolves mask edge operations against the catalogue before the first frame", () => {
    const document = capturedMaskGradeDocument();
    const lookup = vi.mocked(getEntryForTransform);
    lookup.mockClear();
    bootstrapProjectRender(document, url);
    expect(lookup.mock.calls.map(([transform]) => transform.type)).toEqual(expect.arrayContaining(["feather", "position"]));
  });

  it("hands the renderer every field the editor's own project export would", () => {
    const editor = editorProjectData();
    const render = bootstrapProjectRender(JSON.parse(JSON.stringify(capturedDocument())), url);

    // Capture may add schema defaults, but may not drop or alter anything the
    // editor would have rendered with.
    for (const clip of editor.clips) {
      const detached = render.projectData.clips.find((candidate) => candidate.id === clip.id);
      expect(detached).toMatchObject(JSON.parse(JSON.stringify(clip)));
    }
    expect(render.projectData.tracks).toEqual(editor.tracks);
    expect(render.projectData.fps).toBe(editor.fps);
    expect(render.projectData.transitions).toEqual([]);
  });

  it("carries source frame rates and leaves still images without a duration", () => {
    const render = bootstrapProjectRender(capturedDocument(), url);
    const byId = new Map(render.projectData.assets.map((asset) => [asset.id, asset]));
    // A 24 fps movie in a 30 fps project decodes on its own frame grid.
    expect(byId.get("movie")).toMatchObject({ type: "video", fps: 24, duration: 10 });
    expect(byId.get("image")).not.toHaveProperty("duration");
    expect(byId.get("image")).not.toHaveProperty("fps");
    expect(byId.get("audio")).not.toHaveProperty("fps");
    for (const asset of render.projectData.assets) {
      // Bound through the host's resolver, by editor ID, never an editor URL.
      expect(asset.src).toBe(`blob:http://host.test/${asset.id}`);
      expect(asset.hash).toBe(asset.id);
    }
  });

  it("encodes at the output size over the logical stage the timeline lays out on", () => {
    const document = capturedDocument();
    const render = bootstrapProjectRender(document, url);
    expect(render.exportConfig).toEqual({
      logicalWidth: document.geometry.logicalWidth, logicalHeight: document.geometry.logicalHeight,
      outputWidth: document.geometry.outputWidth, outputHeight: document.geometry.outputHeight,
      backgroundAlpha: document.geometry.backgroundAlpha,
    });
    expect(render).toMatchObject({
      format: document.encoding.format,
      keyFrameInterval: document.encoding.keyFrameInterval,
      includeAudio: document.encoding.includeAudio,
    });
    expect(render.projectData.duration).toBe(document.durationTicks);
  });

  it.each([
    ["an unknown render field", (doc: MutableDocument) => { doc.clips[0].speed = 2; }],
    ["another document version", (doc: MutableDocument) => { doc.version = 2; }],
    ["a content digest", (doc: MutableDocument) => { doc.assets[0].digest = `sha256:${"a".repeat(64)}`; }],
    ["an unsupported contract", (doc: MutableDocument) => { doc.renderer.contract = "media-v2"; }],
    ["a frame rate on audio", (doc: MutableDocument) => { doc.assets[2].fps = 30; }],
  ])("refuses %s rather than rendering as if it were absent", (_name, mutate) => {
    const document = JSON.parse(JSON.stringify(capturedDocument())) as MutableDocument;
    mutate(document);
    expect(() => bootstrapProjectRender(document, url)).toThrow(DetachedRenderBootstrapError);
  });

  it("fails before the first frame when a transform has no renderer", () => {
    vi.mocked(getEntryForTransform).mockReturnValueOnce(undefined);
    expect(() => bootstrapProjectRender(capturedDocument(), url))
      .toThrow(/No renderer is available for transform/);
  });
});
