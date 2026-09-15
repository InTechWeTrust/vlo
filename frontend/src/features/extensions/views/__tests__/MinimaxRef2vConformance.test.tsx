import { useGenerationPanel } from "../../../generation/hooks/useGenerationPanel";
import { useExtractStore } from "../../../../core/extract/useExtractStore";
import { useTimelineSelectionStore } from "../../../timelineSelection";
import { useAssetStore } from "../../../userAssets";
import type { Asset } from "../../../../types/Asset";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionApiScope,
  ExtensionGenerationInputSnapshot,
  ExtensionGenerationInputsDraft,
  ExtensionGenerationInputsDraftRequest,
  ExtensionResource,
  VloExtensionApi,
} from "../../types";
import { createVloExtensionApi } from "../../services/FrontendExtensionRuntime";
import {
  mountGenerationSession,
  type MountedGenerationSession,
} from "../../../../testUtils/generationSession";
import type {
  GenerationInputSnapshot,
  GenerationMediaItemSnapshot,
  GenerationNodeSnapshot,
} from "../../../generation/services/generationSessionTypes";
import type {
  LoadedInlineDocument,
  LoadedInlineNodeInput,
  LoadedRetentionEntry,
  MinimaxRef2vPackage,
} from "./minimaxRef2vLoader";
import { useGenerationStore } from "../../../generation";
import type { WorkflowInput } from "../../../generation";
import { resetZustandStore } from "../../../../testUtils/zustand";

/**
 * R1 of docs/minimax-ref2v-prompt-composer-plan.md: the bound reference
 * document, its catalogue, the prompt-object view, the package's own inline
 * editor, and the composer committing all of it.
 *
 * The exit gate is behavioural: text authored once still refers to the same
 * inputs after a staged reorder — before and after any text edit — and an
 * audio toggle; commit/reopen works with no authoring cache; the held prompt is
 * never offered as a field; the editor's keyboard, clipboard, history and IME
 * paths hold. The pure half runs against the package's codec; the view half
 * runs the real extension API, the real staged draft and the real session.
 *
 * The editor and the object view are extension-owned (plan §4.1), so this suite
 * is their only automated coverage, in jsdom. Chromium verification with the
 * installed package is a release step (R3), not something this proves.
 *
 * Skips wholesale when the optional package is absent, like the other MiniMax
 * suites.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const packagePresent = existsSync(
  resolve(
    REPO_ROOT,
    "extensions/installed/vlo.minimax-prompt/frontend/src/PromptObjectView.ts",
  ),
);

type Ref2vLoader = typeof import("./minimaxRef2vLoader");

async function loadLoader(): Promise<Ref2vLoader> {
  return import("./minimaxRef2vLoader");
}

async function loadPackage(): Promise<MinimaxRef2vPackage> {
  return (await loadLoader()).minimaxRef2vPackage;
}

// --- Fixtures ---------------------------------------------------------------

function item(
  inputId: string,
  index: number,
  overrides: Partial<GenerationMediaItemSnapshot> & { itemId: string },
): GenerationMediaItemSnapshot {
  return {
    slotId: index === 0 ? inputId : `${inputId}::repeat::${index}`,
    ordinal: index,
    source: "asset",
    assetId: overrides.itemId.replace(/^media-/, ""),
    displayName: `${overrides.itemId.replace(/^media-/, "")}`,
    mediaType: "image",
    hasAudio: false,
    options: {},
    preparing: false,
    ...overrides,
  };
}

function batch(
  id: string,
  inputType: "image" | "video" | "audio",
  media: readonly GenerationMediaItemSnapshot[],
  extra: Partial<GenerationInputSnapshot> = {},
): GenerationInputSnapshot {
  return {
    id,
    nodeId: id.split(":")[0],
    param: id.split(":")[1],
    label: id,
    inputType,
    repeatable: { max: 8, optionIds: inputType === "video" ? ["audio"] : [] },
    media,
    ...extra,
  };
}

const IMAGES = "141:images";
const VIDEOS = "142:videos";
const AUDIOS = "143:audio";
const PROMPT = "136:prompt";
const REFERENCE_IDS = [IMAGES, VIDEOS, AUDIOS];

/** The deep dive's worked example (§3.1), with occurrence ids. */
function workedExample(options: { v1HasAudio?: boolean | null } = {}) {
  return [
    batch(IMAGES, "image", [
      item(IMAGES, 0, { itemId: "media-A" }),
      item(IMAGES, 1, { itemId: "media-B" }),
    ]),
    batch(VIDEOS, "video", [
      item(VIDEOS, 0, {
        itemId: "media-V1",
        mediaType: "video",
        hasAudio: options.v1HasAudio === undefined ? false : options.v1HasAudio,
        options: { audio: true },
      }),
      item(VIDEOS, 1, {
        itemId: "media-V2",
        mediaType: "video",
        hasAudio: true,
        options: { audio: true },
      }),
      item(VIDEOS, 2, {
        itemId: "media-V3",
        mediaType: "video",
        hasAudio: true,
        options: { audio: true },
      }),
    ]),
    batch(AUDIOS, "audio", [
      item(AUDIOS, 0, { itemId: "media-S1", mediaType: "audio", hasAudio: true }),
      item(AUDIOS, 1, { itemId: "media-S2", mediaType: "audio", hasAudio: true }),
    ]),
  ] as unknown as readonly ExtensionGenerationInputSnapshot[];
}

const asExtension = (inputs: readonly GenerationInputSnapshot[]) =>
  inputs as unknown as readonly ExtensionGenerationInputSnapshot[];

describe.skipIf(!packagePresent)("minimax ref2v: catalogue", () => {
  it("assigns the worked example's labels by occurrence, silent first video included", async () => {
    const { buildReferenceCatalogue } = await loadPackage();
    const catalogue = buildReferenceCatalogue(workedExample(), REFERENCE_IDS);

    expect(catalogue.objects.map((object) => [object.label, object.itemId])).toEqual([
      ["<Picture 1>", "media-A"],
      ["<Picture 2>", "media-B"],
      ["<Video 1>", "media-V1"],
      ["<Audio 1>", "media-V2"],
      ["<Video 2>", "media-V2"],
      ["<Audio 2>", "media-V3"],
      ["<Video 3>", "media-V3"],
      ["<Audio 3>", "media-S1"],
      ["<Audio 4>", "media-S2"],
    ]);
    // The video's soundtrack is its own object, beside the video.
    expect(catalogue.byLabel.get("<Audio 1>")?.id).toBe("audio:media-V2");
    expect(catalogue.byLabel.get("<Video 2>")?.id).toBe("visual:media-V2");
    // Switch on, no soundtrack: nothing to insert, and it is said out loud.
    expect(catalogue.silentSoundtracks.map((entry) => entry.itemId)).toEqual([
      "media-V1",
    ]);
  });

  it("marks every audio number after an undecidable soundtrack as not final", async () => {
    const { buildReferenceCatalogue } = await loadPackage();
    const catalogue = buildReferenceCatalogue(
      workedExample({ v1HasAudio: null }),
      REFERENCE_IDS,
    );
    const states = Object.fromEntries(
      catalogue.objects.map((object) => [object.label, object.state]),
    );
    expect(states["<Picture 1>"]).toBe("resolved");
    expect(states["<Video 3>"]).toBe("resolved");
    expect(
      catalogue.objects
        .filter((object) => object.kind === "Audio")
        .map((object) => object.state),
    ).toEqual(["uncertain", "uncertain", "uncertain", "uncertain", "uncertain"]);
  });

  it("counts a video delivered to an audio input as audio, and a preparing item as pending", async () => {
    const { buildReferenceCatalogue } = await loadPackage();
    const catalogue = buildReferenceCatalogue(
      asExtension([
        batch(AUDIOS, "audio", [
          item(AUDIOS, 0, {
            itemId: "media-clip",
            mediaType: "audio",
            hasAudio: true,
            preparing: true,
          }),
        ]),
      ]),
      REFERENCE_IDS,
    );
    expect(catalogue.objects).toMatchObject([
      { label: "<Audio 1>", id: "audio:media-clip", state: "pending" },
    ]);
  });

  it("refuses to guess between two reference nodes", async () => {
    const { referenceTargeting } = await loadPackage();
    const node = { classType: "vloMiniMaxH3ReferenceToVideoBatch", mode: 0 };
    expect(referenceTargeting({ nodes: [node] })).toBe("single");
    expect(referenceTargeting({ nodes: [node, node] })).toBe("ambiguous");
    expect(referenceTargeting({ nodes: [{ ...node, mode: 4 }, node] })).toBe("single");
  });
});

describe.skipIf(!packagePresent)("minimax ref2v: bound document", () => {
  const PROMPT_TEXT = [
    "subject_definitions:",
    "<Subject 1> is the woman in <Picture 1>, whose voice is <Audio 1>.",
    "",
    "summary:",
    "[reference generation] <Subject 1> walks past <Picture 2>.",
    "",
    "retention_analysis:",
    "<Picture 1> ([Shot 1] first frame): fully_preserved - the frame layout is retained.",
    "",
    "detailed_description:",
    "Warm, handheld, late afternoon.",
    "[Shot 1] <Subject 1> steps into frame.",
    "[Shot 2] At 00:02.000, she turns back to where [Shot 1] began.",
    "",
    "overall_soundscape:",
    "Traffic, then <Audio 1> speaking.",
    "",
    "non_diegetic_music:",
    "N/A",
  ].join("\n");

  async function imported() {
    const pkg = await loadPackage();
    const catalogue = pkg.buildReferenceCatalogue(workedExample(), REFERENCE_IDS);
    const result = pkg.importReferencePrompt(PROMPT_TEXT, catalogue);
    if (!result.ok) throw new Error(`import failed: ${JSON.stringify(result)}`);
    return { pkg, catalogue, document: result.document, unbound: result.unbound };
  }

  it("binds every recognised label and round-trips the prompt exactly", async () => {
    const { pkg, catalogue, document, unbound } = await imported();

    expect(unbound).toEqual([]);
    expect(document.subjects).toHaveLength(1);
    expect(document.shots).toHaveLength(2);
    expect(document.styleOpening.nodes).toEqual([
      { kind: "text", text: "Warm, handheld, late afternoon." },
    ]);
    // The retention citation of a shot is a role-derived scope, not a
    // boundary: Picture 1 is not defined with a role here, so the scope is
    // authored text that cites the shot.
    expect(document.retention).toMatchObject([
      {
        kind: "retention",
        targetId: "visual:media-A",
        marker: "fully_preserved",
        scope: {
          mode: "custom",
          text: {
            nodes: [
              { kind: "reference", targetId: pkg.shotTarget(document.shots[0].id) },
              { kind: "text", text: " first frame" },
            ],
          },
        },
      },
    ]);

    const resolution = pkg.resolveReferenceDocument(document, catalogue);
    expect(resolution).toEqual(expect.objectContaining({ ok: true, text: PROMPT_TEXT }));
  });

  it("renumbers citations when references are reordered, never retargets them", async () => {
    const { pkg, document } = await imported();
    const example = workedExample() as unknown as GenerationInputSnapshot[];
    const [images, videos, audios] = example;
    const reordered = asExtension([
      { ...images, media: [...images.media!].reverse() },
      // V1 gets a real soundtrack switched on: every audio number moves up one.
      {
        ...videos,
        media: videos.media!.map((entry) =>
          entry.itemId === "media-V1" ? { ...entry, hasAudio: true } : entry,
        ),
      },
      audios,
    ]);

    const resolution = pkg.resolveReferenceDocument(
      document,
      pkg.buildReferenceCatalogue(reordered, REFERENCE_IDS),
    );
    if (!resolution.ok) throw new Error("expected to resolve");
    expect(resolution.text).toContain(
      "<Subject 1> is the woman in <Picture 2>, whose voice is <Audio 2>.",
    );
    expect(resolution.text).toContain("walks past <Picture 1>.");
    expect(resolution.text).toContain("<Picture 2> ([Shot 1] first frame)");
  });

  it("refuses, rather than renumbers, a citation whose reference is gone", async () => {
    const { pkg, document } = await imported();
    const [images, videos, audios] = workedExample() as unknown as GenerationInputSnapshot[];
    const withoutA = asExtension([
      { ...images, media: images.media!.filter((entry) => entry.itemId !== "media-A") },
      videos,
      audios,
    ]);

    const resolution = pkg.resolveReferenceDocument(
      document,
      pkg.buildReferenceCatalogue(withoutA, REFERENCE_IDS),
    );
    // `<Picture 2>` did not slide into `<Picture 1>`'s sentences.
    expect(resolution).toEqual({
      ok: false,
      missing: ["visual:media-A"],
      uncertain: [],
      ambiguousShots: [],
      incompleteRoles: [],
    });
  });

  it("refuses a citation whose number depends on an undecidable soundtrack", async () => {
    const { pkg, document } = await imported();
    const uncertain = pkg.buildReferenceCatalogue(
      workedExample({ v1HasAudio: null }),
      REFERENCE_IDS,
    );
    const resolution = pkg.resolveReferenceDocument(document, uncertain);
    expect(resolution.ok).toBe(false);
    expect(!resolution.ok && resolution.uncertain).toEqual(["audio:media-V2"]);
  });

  it("follows shots by identity: reorder relabels citations, removal leaves them missing", async () => {
    const { pkg, catalogue, document } = await imported();
    const [first, second] = document.shots;

    const swapped = pkg.moveShot(document, second.id, -1);
    const resolved = pkg.resolveReferenceDocument(swapped, catalogue);
    if (!resolved.ok) throw new Error("expected to resolve");
    expect(resolved.text).toContain(
      "[Shot 1] At 00:02.000, she turns back to where [Shot 2] began.\n[Shot 2] <Subject 1> steps into frame.",
    );
    // The authored cut time is text, and stays where it was written.
    expect(resolved.text).toContain("<Picture 1> ([Shot 2] first frame)");

    const removed = pkg.removeShot(document, first.id);
    expect(pkg.resolveReferenceDocument(removed, catalogue)).toEqual({
      ok: false,
      missing: [pkg.shotTarget(first.id)],
      uncertain: [],
      ambiguousShots: [],
      incompleteRoles: [],
    });
  });

  it("numbers subjects by composer order and creates every number a prompt uses", async () => {
    const pkg = await loadPackage();
    const catalogue = pkg.buildReferenceCatalogue(workedExample(), REFERENCE_IDS);
    const result = pkg.importReferencePrompt(
      "subject_definitions:\n<Subject 2> is the dog.",
      catalogue,
    );
    if (!result.ok) throw new Error("import failed");
    expect(result.document.subjects.map((subject) => subject.id)).toEqual([
      "subject-1",
      "subject-2",
    ]);

    const withCat = pkg.addSubject(result.document, { id: "subject-cat", name: "Cat" });
    const catFirst = pkg.moveSubject(
      pkg.moveSubject(withCat, "subject-cat", -1),
      "subject-cat",
      -1,
    );
    const text = pkg.setSummaryBody(
      catFirst,
      pkg.inlineDocument([
        { kind: "reference", targetId: pkg.subjectTarget("subject-cat") },
        { kind: "text", text: " chases " },
        { kind: "reference", targetId: pkg.subjectTarget("subject-2") },
      ]),
    );
    const resolved = pkg.resolveReferenceDocument(text, catalogue);
    if (!resolved.ok) throw new Error("expected to resolve");
    expect(resolved.text).toContain("subject_definitions:\n<Subject 3> is the dog.");
    expect(resolved.text).toContain("summary:\n<Subject 1> chases <Subject 3>");
  });

  it("commits a typed label and an inserted chip identically, and leaves unknown labels as text", async () => {
    const { pkg, catalogue, document } = await imported();
    const labeller = pkg.createReferenceLabeller(document, catalogue);

    const typed = pkg.bindReferenceText("see <Video 2> and <Video 9>", labeller.target);
    const inserted = pkg.inlineDocument([
      { kind: "text", text: "see " },
      { kind: "reference", targetId: "visual:media-V2" },
      { kind: "text", text: " and <Video 9>" },
    ]);
    expect(typed).toEqual(inserted);

    const withUnknown = pkg.setSummaryBody(document, typed);
    expect(pkg.collectUnbound(withUnknown)).toEqual(["<Video 9>"]);
  });

  it("keeps every shot body intact through reorder, serialize and reopen, forward citations included", async () => {
    const { pkg, catalogue, document } = await imported();
    // Shot 2 cites shot 1; moved first, that citation now names a *later*
    // shot, and a mid-line `[Shot 2]` must not read back as a boundary.
    const swapped = pkg.moveShot(document, document.shots[1].id, -1);
    const written = pkg.resolveReferenceDocument(swapped, catalogue);
    if (!written.ok) throw new Error(`expected to resolve: ${JSON.stringify(written)}`);

    const reopened = pkg.importReferencePrompt(written.text, catalogue);
    if (!reopened.ok) throw new Error("reopen failed");
    expect(reopened.document.shots).toHaveLength(2);
    const bodyText = (shots: typeof swapped.shots, labelFor: (id: string) => string) =>
      shots.map((shot) =>
        shot.body.nodes
          .map((node) => (node.kind === "text" ? node.text : labelFor(node.targetId)))
          .join(""),
      );
    const before = pkg.createReferenceLabeller(swapped, catalogue);
    const after = pkg.createReferenceLabeller(reopened.document, catalogue);
    expect(bodyText(reopened.document.shots, (id) => after.label(id) ?? "?")).toEqual(
      bodyText(swapped.shots, (id) => before.label(id) ?? "?"),
    );
    // And the forward citation came back as a citation of the right shot.
    expect(reopened.document.shots[0].body.nodes).toContainEqual({
      kind: "reference",
      targetId: pkg.shotTarget(reopened.document.shots[1].id),
    });
    // Re-resolving the reopened document writes the same prompt.
    expect(pkg.resolveReferenceDocument(reopened.document, catalogue)).toEqual(
      expect.objectContaining({ ok: true, text: written.text }),
    );
  });

  it("refuses a shot whose line opens with the next shot's marker, rather than splitting it on reopen", async () => {
    const { pkg, catalogue, document } = await imported();
    const [first, second] = document.shots;
    const ambiguous = pkg.setShotBody(
      document,
      first.id,
      pkg.inlineDocument([
        { kind: "text", text: "She stops.\n" },
        { kind: "reference", targetId: pkg.shotTarget(second.id) },
        { kind: "text", text: " is where she turns." },
      ]),
    );
    expect(pkg.resolveReferenceDocument(ambiguous, catalogue)).toEqual({
      ok: false,
      missing: [],
      uncertain: [],
      ambiguousShots: [1, 2],
      incompleteRoles: [],
    });
  });

  it("keeps a style opening over an untouched shot an opening on reopen", async () => {
    const pkg = await loadPackage();
    const catalogue = pkg.buildReferenceCatalogue([], REFERENCE_IDS);
    const result = pkg.importReferencePrompt("", catalogue);
    if (!result.ok) throw new Error("import failed");
    const styled = { ...result.document, styleOpening: pkg.textDocument("Warm light.") };

    const written = pkg.resolveReferenceDocument(styled, catalogue);
    if (!written.ok) throw new Error("expected to resolve");
    const reopened = pkg.importReferencePrompt(written.text, catalogue);
    expect(reopened.ok && reopened.document.styleOpening.nodes).toEqual([
      { kind: "text", text: "Warm light." },
    ]);
  });

  it("leaves an absurd subject number as unbound text instead of allocating it", async () => {
    const pkg = await loadPackage();
    const catalogue = pkg.buildReferenceCatalogue([], REFERENCE_IDS);
    const result = pkg.importReferencePrompt(
      "subject_definitions:\n<Subject 999999999999> and <Subject 2> walk.",
      catalogue,
    );
    if (!result.ok) throw new Error("import failed");
    expect(result.document.subjects).toHaveLength(2);
    expect(result.unbound).toEqual(["<Subject 999999999999>"]);
    expect(
      pkg.importReferencePrompt(
        `subject_definitions:\n<Subject ${pkg.MAX_IMPORTED_SUBJECTS + 1}> waits.`,
        catalogue,
      ),
    ).toMatchObject({ ok: true, document: { subjects: [] } });
  });

  it("leaves a prompt it cannot structure to the whole-prompt editor", async () => {
    const pkg = await loadPackage();
    const catalogue = pkg.buildReferenceCatalogue([], REFERENCE_IDS);
    expect(
      pkg.importReferencePrompt("summary:\nA\n\nsubject_definitions:\nB", catalogue),
    ).toEqual({ ok: false, failure: { kind: "sections", reason: "out-of-order" } });
    expect(
      pkg.importReferencePrompt(
        "detailed_description:\n[Shot 2] begins in the middle.",
        catalogue,
      ),
    ).toEqual({ ok: false, failure: { kind: "shots", reason: "out-of-order" } });
    // No marker at all: one shot, and no guess at where a style opening ends.
    const plain = pkg.importReferencePrompt(
      "detailed_description:\nWarm light. A woman walks.",
      catalogue,
    );
    expect(plain.ok && plain.document.styleOpening.nodes).toEqual([]);
    expect(plain.ok && plain.document.shots).toHaveLength(1);
  });
});

// --- The composer, against the real session and draft -----------------------

const REFERENCE_NODES: readonly GenerationNodeSnapshot[] = Object.freeze([
  {
    id: "136",
    classType: "vloMiniMaxH3ReferenceToVideoBatch",
    title: "Reference",
    mode: 0,
    widgets: [],
  },
]);

let session: MountedGenerationSession | null = null;
const resources: ExtensionResource[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    if (typeof resource === "function") await resource();
    else await resource.dispose();
  }
  session?.unmount();
  session = null;
});

function createScope(): ExtensionApiScope {
  return {
    extension: { id: "vlo.minimax-prompt", version: "0.4.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => {
      resources.push(resource);
      return resource;
    },
    report: vi.fn(),
  };
}

const INITIAL_PROMPT = [
  "subject_definitions:",
  "<Subject 1> is the woman in <Picture 1>.",
  "",
  "detailed_description:",
  "[Shot 1] <Subject 1> walks past <Picture 2>, and <Audio 1> plays.",
  "",
  "non_diegetic_music:",
  "N/A",
].join("\n");

function panelInputs(prompt: string): GenerationInputSnapshot[] {
  return [
    {
      id: PROMPT,
      nodeId: "136",
      param: "prompt",
      label: "Prompt",
      inputType: "text",
      value: prompt,
    },
    batch(IMAGES, "image", [
      item(IMAGES, 0, { itemId: "media-hero" }),
      item(IMAGES, 1, { itemId: "media-city" }),
    ]),
    batch(VIDEOS, "video", [
      item(VIDEOS, 0, {
        itemId: "media-talk",
        mediaType: "video",
        hasAudio: true,
        options: { audio: false },
      }),
    ]),
    batch(AUDIOS, "audio", [
      item(AUDIOS, 0, { itemId: "media-song", mediaType: "audio", hasAudio: true }),
    ]),
  ];
}

async function mount(
  pkg: MinimaxRef2vPackage,
  composerSession?: unknown,
  options: { readonly withoutFields?: boolean; readonly strict?: boolean } = {},
) {
  const real = createVloExtensionApi(createScope());
  const drafts: ExtensionGenerationInputsDraft[] = [];
  const requests: ExtensionGenerationInputsDraftRequest[] = [];
  // Everything real. The draft factory is observed, not replaced, so a test can
  // stage against the very draft the composer holds. The API is frozen, so the
  // observer is an own property over it rather than a proxy.
  const generation = Object.create(real.generation) as VloExtensionApi["generation"];
  Object.defineProperty(generation, "createInputsDraft", {
    value: (request: ExtensionGenerationInputsDraftRequest) => {
      requests.push(request);
      const draft = real.generation.createInputsDraft(request);
      if (draft) drafts.push(draft);
      return draft;
    },
  });
  const api = {
    ...real,
    generation,
    ...(options.withoutFields
      ? { runtime: { ...real.runtime, generationUi: undefined } }
      : {}),
  } as unknown as VloExtensionApi;
  const heldSession = composerSession ?? pkg.createComposerSession();
  const View = pkg.createComposerView({
    api,
    session: heldSession,
    react: React,
  } as never) as React.FunctionComponent<Record<string, unknown>>;
  const view = render(
    React.createElement(options.strict ? React.StrictMode : React.Fragment, null, React.createElement(View, { viewId: "v", region: "editor-overlay", active: true })),
  );
  return { view, drafts, requests, session: heldSession };
}

function chipLabels(field: string): string[] {
  return [
    ...screen
      .getByRole("textbox", { name: field })
      .querySelectorAll("[data-reference-id]"),
  ].map((chip) => chip.textContent ?? "");
}

/** The object view's rows, in order, with the labels each offers. */
function objectRows(): Array<[string, string[]]> {
  return [
    ...screen.getByTestId("prompt-object-view").querySelectorAll("[data-reference-item]"),
  ].map((row) => [
    row.getAttribute("data-reference-item") ?? "",
    [...row.querySelectorAll("button")]
      .map((button) => button.getAttribute("aria-label") ?? "")
      .filter((name) => name.startsWith("Insert "))
      .map((name) => name.slice("Insert ".length)),
  ]);
}

describe.skipIf(!packagePresent)("minimax ref2v: composer", () => {
  it("keeps authored references on their items through a staged reorder and an audio toggle, and commits them atomically", async () => {
    const { replaceReferenceText } = await loadLoader();
    const pkg = await loadPackage();
    session = mountGenerationSession({
      nodes: REFERENCE_NODES,
      inputs: panelInputs(INITIAL_PROMPT),
    });
    const { drafts } = await mount(pkg);

    // `<Audio 1>` is the song until the talking video's soundtrack is switched
    // on, at which point the song becomes `<Audio 2>` and the prose follows.
    expect(chipLabels("Shot 1")).toEqual(["<Subject 1>", "<Picture 2>", "<Audio 1>"]);

    replaceReferenceText(
      screen.getByRole("textbox", { name: "Summary" }),
      "[reference generation] A walk.",
    );

    const draft = drafts.at(-1)!;
    const talk = draft.getState().inputs.find((input) => input.id === VIDEOS)!.media![0];
    act(() => {
      draft.stage({ kind: "moveMedia", inputId: IMAGES, fromOrdinal: 1, toOrdinal: 0 });
      draft.stage({
        kind: "setMediaOption",
        inputId: VIDEOS,
        slotId: talk.slotId,
        optionId: "audio",
        value: true,
      });
    });

    expect(chipLabels("Definition of <Subject 1>")).toEqual(["<Picture 2>"]);
    expect(chipLabels("Shot 1")).toEqual(["<Subject 1>", "<Picture 1>", "<Audio 2>"]);
    // The talking video now emits a soundtrack of its own, beside its video.
    expect(objectRows()).toContainEqual(["media-talk", ["<Audio 1>", "<Video 1>"]]);
    expect(session.commit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Commit to prompt" }));

    expect(session.commit).toHaveBeenCalledOnce();
    const panel = session.panelInputs();
    expect(panel.find((input) => input.id === PROMPT)?.value).toBe(
      [
        "subject_definitions:",
        "<Subject 1> is the woman in <Picture 2>.",
        "",
        "summary:",
        "[reference generation] A walk.",
        "",
        "detailed_description:",
        "[Shot 1] <Subject 1> walks past <Picture 1>, and <Audio 2> plays.",
        "",
        "non_diegetic_music:",
        "N/A",
      ].join("\n"),
    );
    expect(
      panel.find((input) => input.id === IMAGES)?.media?.map((entry) => entry.itemId),
    ).toEqual(["media-city", "media-hero"]);
  });

  it("moves the labels, not the meaning, when media is reordered before any text is edited", async () => {
    const pkg = await loadPackage();
    session = mountGenerationSession({
      nodes: REFERENCE_NODES,
      inputs: panelInputs(INITIAL_PROMPT),
    });
    const { drafts } = await mount(pkg);
    expect(chipLabels("Definition of <Subject 1>")).toEqual(["<Picture 1>"]);

    // No text has been touched: the document is still the prompt, read back.
    act(() => {
      drafts.at(-1)!.stage({
        kind: "moveMedia",
        inputId: IMAGES,
        fromOrdinal: 1,
        toOrdinal: 0,
      });
    });

    // The hero is now second, and the sentence about the hero says so.
    expect(chipLabels("Definition of <Subject 1>")).toEqual(["<Picture 2>"]);
    expect(chipLabels("Shot 1")).toEqual(["<Subject 1>", "<Picture 1>", "<Audio 1>"]);

    fireEvent.click(screen.getByRole("button", { name: "Commit to prompt" }));
    expect(session.panelInputs().find((input) => input.id === PROMPT)?.value).toContain(
      "<Subject 1> is the woman in <Picture 2>.",
    );
  });

  it("never offers the prompt it writes as an editable field, with the host's staged fields present or absent", async () => {
    const pkg = await loadPackage();
    // The real fields draw the panel's own input definitions from the store,
    // so seed them as the mounted panel would: without these they would render
    // nothing, and the assertions below would pass for the wrong reason.
    const definition = (
      id: string,
      inputType: WorkflowInput["inputType"],
      repeatable: boolean,
    ): WorkflowInput => ({
      id,
      nodeId: id.split(":")[0],
      param: id.split(":")[1],
      classType: "Fixture",
      inputType,
      label: id === PROMPT ? "Prompt" : id,
      currentValue: null,
      origin: "rule",
      ...(repeatable ? { presentation: { repeatable: { max: 8 } } } : {}),
    });
    useGenerationStore.setState({
      workflowInputs: [
        definition(PROMPT, "text", false),
        definition(IMAGES, "image", true),
        definition(VIDEOS, "video", true),
        definition(AUDIOS, "audio", true),
      ],
    });

    for (const withoutFields of [false, true]) {
      session = mountGenerationSession({
        nodes: REFERENCE_NODES,
        inputs: panelInputs(INITIAL_PROMPT),
      });
      const { view, requests } = await mount(pkg, undefined, { withoutFields });

      // Held for conflict detection, never addressed as an editable input.
      expect(requests.at(-1)).toMatchObject({
        inputIds: REFERENCE_IDS,
        holdInputIds: [PROMPT],
      });
      // The composer draws its references as prompt objects; the host's fields
      // are not drawn beside them, and neither is a missing-seam error.
      expect(screen.getByTestId("prompt-object-view")).toBeInTheDocument();
      expect(screen.queryByTestId("generation-inputs-draft")).toBeNull();
      expect(screen.queryByText(/does not provide the staged inputs editor/)).toBeNull();
      expect(screen.queryByPlaceholderText("Enter prompt...")).toBeNull();
      expect(
        screen.queryAllByRole("textbox").map((element) => element.getAttribute("aria-label")),
      ).not.toContain("Prompt");

      view.unmount();
      session.unmount();
      session = null;
    }
    resetZustandStore(useGenerationStore);
  });

  it("reopens a closed composer with both the authored text and the staged media it cites", async () => {
    const { replaceReferenceText, readReferenceText } = await loadLoader();
    const pkg = await loadPackage();
    session = mountGenerationSession({
      nodes: REFERENCE_NODES,
      inputs: panelInputs(INITIAL_PROMPT),
    });
    const first = await mount(pkg);
    replaceReferenceText(screen.getByRole("textbox", { name: "Summary" }), "Kept while closed.");
    act(() => {
      first.drafts.at(-1)!.stage({
        kind: "moveMedia",
        inputId: IMAGES,
        fromOrdinal: 1,
        toOrdinal: 0,
      });
    });
    first.view.unmount();

    const second = await mount(pkg, first.session);

    // The session's draft, not a new one.
    expect(second.requests).toHaveLength(0);
    expect(readReferenceText(screen.getByRole("textbox", { name: "Summary" }))).toBe(
      "Kept while closed.",
    );
    // Still the staged arrangement: the hero is second.
    expect(chipLabels("Definition of <Subject 1>")).toEqual(["<Picture 2>"]);
    (first.session as { dispose(): void }).dispose();
  });

  it("turns a panel edit to the prompt after editing began into a conflict, not an overwrite", async () => {
    const { replaceReferenceText } = await loadLoader();
    const pkg = await loadPackage();
    const inputs = panelInputs(INITIAL_PROMPT);
    session = mountGenerationSession({ nodes: REFERENCE_NODES, inputs });
    await mount(pkg);

    replaceReferenceText(screen.getByRole("textbox", { name: "Summary" }), "Mine.");
    act(() => {
      session!.publish({
        nodes: REFERENCE_NODES,
        inputs: inputs.map((input) =>
          input.id === PROMPT ? { ...input, value: "typed in the panel" } : input,
        ),
      });
    });

    expect(screen.getByRole("button", { name: "Commit to prompt" })).toBeDisabled();
    expect(screen.getByText(/Prompt changed in the panel/)).toBeInTheDocument();
    expect(session.commit).not.toHaveBeenCalled();
  });

  it("will not commit a citation whose number is not final, and says what to do", async () => {
    const pkg = await loadPackage();
    const inputs = panelInputs("detailed_description:\n[Shot 1] <Audio 2> plays.").map(
      (input) =>
        input.id === VIDEOS
          ? {
              ...input,
              media: input.media!.map((entry) => ({
                ...entry,
                hasAudio: null,
                options: { audio: true },
              })),
            }
          : input,
    );
    session = mountGenerationSession({ nodes: REFERENCE_NODES, inputs });
    await mount(pkg);

    expect(screen.getByRole("button", { name: "Commit to prompt" })).toBeDisabled();
    expect(screen.getByText(/Turn that video's audio switch off/)).toBeInTheDocument();
  });
});

describe.skipIf(!packagePresent)("minimax ref2v: prompt-object view", () => {
  it.each([[IMAGES, "image"], [VIDEOS, "video"], [AUDIOS, "audio"]] as const)("opens the native %s selection from + under StrictMode", async (inputId, type) => {
    const pkg = await loadPackage();
    session = mountGenerationSession({ nodes: REFERENCE_NODES, inputs: panelInputs(INITIAL_PROMPT) });
    const native = renderHook(() => useGenerationPanel());
    const { view } = await mount(pkg, undefined, { strict: true });
    try {
      const add = view.container.querySelector(`[data-reference-list="${inputId}"] [data-drop-slot-id$="-add"]`);
      expect(add).not.toBeNull();
      fireEvent.click(add!);
      expect(useExtractStore.getState().frameSelectionMode).toBe(type === "image");
      expect(useTimelineSelectionStore.getState().selectionMode).toBe(type !== "image");
      expect(useExtractStore.getState().onConfirmSelection).toBeTypeOf("function");
      expect(screen.getByRole("button", { name: "Cancel capture" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Cancel capture" }));
      expect(useExtractStore.getState().frameSelectionMode).toBe(false);
      expect(useTimelineSelectionStore.getState().selectionMode).toBe(false);
    } finally {
      view.unmount();
      native.unmount();
    }
  });

  it("shows library video previews and previews from timeline captures", async () => {
    const pkg = await loadPackage();
    const inputs = panelInputs(INITIAL_PROMPT);
    const video = inputs.find((input) => input.id === VIDEOS)!;
    const assetId = video.media![0].assetId!;
    const previousAssets = useAssetStore.getState().assets;
    useAssetStore.setState({ assets: [{ id: assetId, name: "talk", type: "video", thumbnail: "blob:video-preview", src: "blob:video-source" } as Asset] });
    session = mountGenerationSession({ nodes: REFERENCE_NODES, inputs: inputs.map((input) => input.id === VIDEOS ? {
      ...input, media: [...input.media!, item(VIDEOS, 1, { itemId: "capture", source: "timeline-selection", assetId: undefined, mediaType: "video", thumbnail: "blob:range-preview" })],
    } : input) });
    try {
      const { view } = await mount(pkg);
      const previews = [...view.container.querySelectorAll(`[data-reference-list="${VIDEOS}"] img`)].map((img) => img.getAttribute("src"));
      expect(previews).toEqual(["blob:video-preview", "blob:range-preview"]);
      view.unmount();
    } finally { useAssetStore.setState({ assets: previousAssets }); }
  });

  it("lists exactly what the staged reading holds, in emission order, with current labels", async () => {
    const pkg = await loadPackage();
    const [prompt, images, videos, audios] = panelInputs(INITIAL_PROMPT);
    session = mountGenerationSession({
      nodes: REFERENCE_NODES,
      // Published audio-first: the view follows the node's emission order,
      // not the panel's input order.
      inputs: [
        prompt,
        audios,
        {
          ...videos,
          media: videos.media!.map((entry) => ({ ...entry, options: { audio: true } })),
        },
        {
          ...images,
          media: [
            ...images.media!,
            item(IMAGES, 2, {
              itemId: "media-range",
              source: "timeline-selection",
              assetId: undefined,
              displayName: "Timeline 00:01-00:03",
            }),
          ],
        },
      ],
    });
    await mount(pkg);

    expect(objectRows()).toEqual([
      ["media-hero", ["<Picture 1>"]],
      ["media-city", ["<Picture 2>"]],
      ["media-range", ["<Picture 3>"]],
      // The soundtrack is its own label, emitted before its video's.
      ["media-talk", ["<Audio 1>", "<Video 1>"]],
      ["media-song", ["<Audio 2>"]],
    ]);
    // Existing timeline captures retain their labels and keep provenance in help.
    const range = screen
      .getByTestId("prompt-object-view")
      .querySelector('[data-reference-item="media-range"]')!;
    fireEvent.click(within(range as HTMLElement).getByRole("button", { name: "About Timeline 00:01-00:03" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Captured from a timeline range.");
  });

  it("reorders within a list through the draft, relabelling chips without retargeting them", async () => {
    const pkg = await loadPackage();
    session = mountGenerationSession({
      nodes: REFERENCE_NODES,
      inputs: panelInputs(INITIAL_PROMPT),
    });
    const { drafts } = await mount(pkg);
    expect(chipLabels("Definition of <Subject 1>")).toEqual(["<Picture 1>"]);

    act(() => drafts[0].stage({ kind: "moveMedia", inputId: IMAGES, fromOrdinal: 1, toOrdinal: 0 }));

    // Staged, not written: the panel is untouched until commit.
    expect(session.commit).not.toHaveBeenCalled();
    expect(objectRows().slice(0, 2)).toEqual([
      ["media-city", ["<Picture 1>"]],
      ["media-hero", ["<Picture 2>"]],
    ]);
    expect(chipLabels("Definition of <Subject 1>")).toEqual(["<Picture 2>"]);
    expect(screen.queryByRole("button", { name: "Move city earlier" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Commit to prompt" }));
    const panel = session.panelInputs();
    expect(panel.find((input) => input.id === IMAGES)?.media?.map((entry) => entry.itemId)).toEqual([
      "media-city",
      "media-hero",
    ]);
    expect(panel.find((input) => input.id === PROMPT)?.value).toContain(
      "<Subject 1> is the woman in <Picture 2>.",
    );
  });

  it("inserts a label at the caret the author left in the prose", async () => {
    const { typeReferenceText, readReferenceText } = await loadLoader();
    const pkg = await loadPackage();
    session = mountGenerationSession({
      nodes: REFERENCE_NODES,
      inputs: panelInputs(INITIAL_PROMPT),
    });
    await mount(pkg);
    const summary = screen.getByRole("textbox", { name: "Summary" });

    typeReferenceText(summary, "Ends on ");
    typeReferenceText(summary, ".");
    // Back between "on " and "." — then focus leaves for the button.
    typeReferenceText(summary, "", "Ends on ".length);
    act(() => {
      summary.blur();
    });
    fireEvent.click(screen.getByRole("button", { name: "Insert <Audio 1>" }));

    expect(readReferenceText(summary)).toBe("Ends on <Audio 1>.");
    expect(chipLabels("Summary")).toEqual(["<Audio 1>"]);
  });

  it("refuses rearranging a list the panel is holding slots open in", async () => {
    const pkg = await loadPackage();
    const inputs = panelInputs(INITIAL_PROMPT).map((input) =>
      input.id === IMAGES ? { ...input, reservedSlotIds: [`${IMAGES}::repeat::2`] } : input,
    );
    session = mountGenerationSession({ nodes: REFERENCE_NODES, inputs });
    await mount(pkg);

    expect(screen.queryByRole("button", { name: "Move city earlier" })).toBeNull();
    expect(screen.getByText(/1 more is being prepared in the generation panel/)).toBeInTheDocument();
  });
});

// --- The package's inline reference editor ----------------------------------

interface FakeClipboard {
  readonly data: Map<string, string>;
  getData(type: string): string;
  setData(type: string, value: string): void;
}

function clipboard(entries: Record<string, string> = {}): FakeClipboard {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getData: (type) => data.get(type) ?? "",
    setData: (type, value) => {
      data.set(type, value);
    },
  };
}

function clipboardEvent(type: "copy" | "cut" | "paste", data: FakeClipboard): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: data });
  return event;
}

const REFS = [
  { id: "ref-hero", label: "[Ref 1]", kind: "Picture", description: "hero.png", state: "resolved" as const },
  { id: "ref-city", label: "[Ref 2]", kind: "Picture", description: "city.png", state: "resolved" as const },
];

async function mountEditor(
  options: {
    readonly initial?: readonly LoadedInlineNodeInput[];
    readonly disabled?: boolean;
    readonly strict?: boolean;
  } = {},
) {
  const loader = await loadLoader();
  const pkg = loader.minimaxRef2vPackage;
  const real = createVloExtensionApi(createScope());
  const ui = pkg.createHostBindings(
    { runtime: { mui: real.runtime.mui, panelUi: {} } } as never,
    React as never,
  );
  const Editor = pkg.createReferenceTextInput(ui as never) as React.FunctionComponent<
    Record<string, unknown>
  >;
  const changes: LoadedInlineDocument[] = [];
  const handle: { current: { insertReference(id: string): void; openPicker(): void } | null } = {
    current: null,
  };
  const byLabel = new Map(REFS.map((entry) => [entry.label, entry.id]));
  const controls: { setDisabled: (next: boolean) => void } = { setDisabled: () => undefined };
  function Harness() {
    const [value, setValue] = React.useState(() =>
      pkg.createInlineDocument(options.initial ?? []),
    );
    const [disabled, setDisabled] = React.useState(options.disabled ?? false);
    controls.setDisabled = setDisabled;
    return React.createElement(Editor, {
      value,
      references: REFS,
      disabled,
      "aria-label": "Prose",
      ref: handle,
      onChange: (next: LoadedInlineDocument) => {
        changes.push(next);
        setValue(next);
      },
      promoteTypedReference: (before: string) => {
        const match = /\[Ref \d+\]$/.exec(before);
        const targetId = match ? byLabel.get(match[0]) : undefined;
        return match && targetId ? { length: match[0].length, targetId } : null;
      },
      parsePastedText: (text: string) =>
        text.split(/(\[Ref \d+\])/).map((part) =>
          byLabel.has(part)
            ? { kind: "reference" as const, targetId: byLabel.get(part)! }
            : { kind: "text" as const, text: part },
        ),
    });
  }
  const element = React.createElement(Harness);
  render(options.strict ? React.createElement(React.StrictMode, null, element) : element);
  const root = screen.getByRole("textbox", { name: "Prose" });
  const last = () => changes.at(-1)?.nodes ?? [];
  const setDisabled = (next: boolean) =>
    act(() => {
      controls.setDisabled(next);
    });
  return { loader, pkg, root, changes, last, handle, setDisabled };
}

describe.skipIf(!packagePresent)("minimax ref2v: inline reference editor", () => {
  it("promotes a typed label as its own undo step, so Undo is the literal-text escape", async () => {
    const { loader, root, last } = await mountEditor({ strict: true });

    loader.typeReferenceText(root, "See [Ref 2]");
    expect(last()).toEqual([
      { kind: "text", text: "See " },
      { kind: "reference", targetId: "ref-city" },
    ]);
    // StrictMode mounts listeners twice; one keystroke is still one insert.
    expect(loader.readReferenceText(root)).toBe("See [Ref 2]");

    fireEvent.keyDown(root, { key: "z", ctrlKey: true });
    expect(last()).toEqual([{ kind: "text", text: "See [Ref 2]" }]);

    fireEvent.keyDown(root, { key: "z", ctrlKey: true, shiftKey: true });
    expect(last()).toEqual([
      { kind: "text", text: "See " },
      { kind: "reference", targetId: "ref-city" },
    ]);
  });

  it("treats a chip as one unit for deletion, word deletion and caret placement", async () => {
    const { loader, root, last } = await mountEditor({
      initial: [
        { kind: "text", text: "a " },
        { kind: "reference", targetId: "ref-hero" },
        { kind: "reference", targetId: "ref-city" },
      ],
    });
    // Past the end: after both chips.
    loader.typeReferenceText(root, "!");
    expect(last()).toEqual([
      { kind: "text", text: "a " },
      { kind: "reference", targetId: "ref-hero" },
      { kind: "reference", targetId: "ref-city" },
      { kind: "text", text: "!" },
    ]);

    loader.dispatchInput(root, { inputType: "deleteContentBackward" });
    loader.dispatchInput(root, { inputType: "deleteContentBackward" });
    expect(last()).toEqual([
      { kind: "text", text: "a " },
      { kind: "reference", targetId: "ref-hero" },
    ]);
    // A word deletion that reaches a chip takes the chip and stops.
    loader.dispatchInput(root, { inputType: "deleteWordBackward" });
    expect(last()).toEqual([{ kind: "text", text: "a " }]);

    // A caret between two chips is a real position: type there.
    const pkg = loader.minimaxRef2vPackage;
    const between = pkg.createInlineDocument([
      { kind: "reference", targetId: "ref-hero" },
      { kind: "reference", targetId: "ref-city" },
    ]);
    expect(pkg.previousInlineBoundary(between, 2, "character")).toBe(1);
    expect(pkg.nextInlineBoundary(between, 0, "word")).toBe(1);
  });

  it("keeps a document through native IME composition, chips included", async () => {
    const { loader, root, last, changes } = await mountEditor({
      initial: [
        { kind: "reference", targetId: "ref-hero" },
        { kind: "text", text: " caf" },
      ],
    });
    act(() => {
      root.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    // The browser edits the DOM itself mid-composition; the editor stays out
    // of the way until it ends.
    const beforeinput = loader.dispatchInput(root, { inputType: "insertCompositionText", data: "é" });
    expect(beforeinput.defaultPrevented).toBe(false);
    const text = [...root.childNodes].find(
      (node) => node.nodeType === Node.TEXT_NODE && (node as Text).data.includes("caf"),
    ) as Text;
    text.data = `${text.data}é`;
    expect(changes).toHaveLength(0);

    act(() => {
      root.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    expect(last()).toEqual([
      { kind: "reference", targetId: "ref-hero" },
      { kind: "text", text: " café" },
    ]);
  });

  it("copies chips as chips within the editor and as current labels in plain text", async () => {
    const { loader, root, last } = await mountEditor({
      initial: [
        { kind: "text", text: "x " },
        { kind: "reference", targetId: "ref-city" },
      ],
    });
    const pkg = loader.minimaxRef2vPackage;
    act(() => {
      root.focus();
      pkg.writeInlineSelection(root, { start: 0, end: 3 });
    });
    const copied = clipboard();
    act(() => {
      root.dispatchEvent(clipboardEvent("copy", copied));
    });
    expect(copied.getData("text/plain")).toBe("x [Ref 2]");
    // Never private placeholder syntax in plain text.
    expect(copied.getData("text/plain")).not.toContain("ref-city");

    // Pasted back at the end, the structured payload keeps the chip.
    act(() => {
      pkg.writeInlineSelection(root, { start: 3, end: 3 });
      root.dispatchEvent(clipboardEvent("paste", copied));
    });
    expect(last()).toEqual([
      { kind: "text", text: "x " },
      { kind: "reference", targetId: "ref-city" },
      { kind: "text", text: "x " },
      { kind: "reference", targetId: "ref-city" },
    ]);
  });

  it("pastes an unknown id as its visible text, binds labels in plain text, and never reads HTML", async () => {
    const { loader, root, last } = await mountEditor();
    const pkg = loader.minimaxRef2vPackage;
    const foreign = clipboard({
      [pkg.INLINE_DOCUMENT_CLIPBOARD_TYPE]: JSON.stringify({
        version: 1,
        nodes: [{ kind: "reference", targetId: "elsewhere" }],
        labels: { elsewhere: "<Picture 9>" },
      }),
      "text/plain": "<Picture 9>",
    });
    act(() => {
      root.focus();
      root.dispatchEvent(clipboardEvent("paste", foreign));
    });
    expect(last()).toEqual([{ kind: "text", text: "<Picture 9>" }]);

    act(() => {
      root.dispatchEvent(
        clipboardEvent(
          "paste",
          clipboard({ "text/html": "<b>bold</b> [Ref 1]", "text/plain": " then [Ref 1]" }),
        ),
      );
    });
    expect(last()).toEqual([
      { kind: "text", text: "<Picture 9> then " },
      { kind: "reference", targetId: "ref-hero" },
    ]);
    expect(root.querySelector("b")).toBeNull();
  });

  it("inserts from the keyboard picker at the caret", async () => {
    const { loader, root, last } = await mountEditor({
      initial: [{ kind: "text", text: "ab" }],
    });
    loader.typeReferenceText(root, "", 1);
    fireEvent.keyDown(root, { key: "k", ctrlKey: true });
    const search = screen.getByRole("combobox", { name: "Find a reference" });
    fireEvent.change(search, { target: { value: "city" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "[Ref 2]Picture · city.png",
    ]);
    fireEvent.keyDown(search, { key: "Enter" });

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(last()).toEqual([
      { kind: "text", text: "a" },
      { kind: "reference", targetId: "ref-city" },
      { kind: "text", text: "b" },
    ]);
    expect(
      screen.getByRole("img", { name: "Picture reference [Ref 2], city.png" }),
    ).toBeInTheDocument();
  });

  it("refuses input and history while disabled", async () => {
    const { loader, root, changes, handle, setDisabled } = await mountEditor({
      initial: [{ kind: "text", text: "fixed" }],
    });
    // Real history to refuse: an edit made while enabled.
    loader.typeReferenceText(root, "!");
    expect(changes).toHaveLength(1);
    setDisabled(true);
    expect(root.getAttribute("aria-disabled")).toBe("true");

    const typed = loader.dispatchInput(root, { inputType: "insertText", data: "x" });
    expect(typed.defaultPrevented).toBe(true);
    loader.dispatchInput(root, { inputType: "historyUndo" });
    fireEvent.keyDown(root, { key: "z", ctrlKey: true });
    act(() => {
      handle.current?.insertReference("ref-hero");
    });
    expect(changes).toHaveLength(1);
    expect(loader.readReferenceText(root)).toBe("fixed!");

    // Enabled again, the history is still there.
    setDisabled(false);
    fireEvent.keyDown(root, { key: "z", ctrlKey: true });
    expect(loader.readReferenceText(root)).toBe("fixed");
  });
});

// --- R2: structured definitions, summary, retention and scope -----------------

/** The guide's complete example (VIDEO_PROMPT_WRITING_GUIDE_ref_en.md §7). */
const GUIDE_EXAMPLE = [
  "subject_definitions:",
  "<Subject 1> is the coffee-shop environment in <Picture 1>, featuring an exposed brick wall, an orange tufted sofa with patterned pillows, a neon sign, and a wooden coffee table.",
  "<Subject 2> is the fluffy white Samoyed in <Picture 2>, <Picture 3>, and <Picture 4>, with thick white fur, pointed ears, a dark nose, and a curved tail.",
  "<Subject 3> is the young blonde woman in <Video 1>, with long blonde hair and a light-pink button-down shirt with rolled-up sleeves.",
  "<Subject 4> is the young man in <Video 2>, with short wavy brown hair and a dark-grey hoodie with drawstrings.",
  "<Audio 1> is the voice-timbre reference for <Subject 3> (S1), containing a spoken English vocal layer.",
  "",
  "summary:",
  "[reference generation + audio reference] The target video shows <Subject 3> eating a cookie in <Subject 1>. <Subject 4> enters with <Subject 2>, which lunges toward the cookie. The three-shot exchange uses <Audio 1> as the voice-timbre reference for <Subject 3> and ends with a canned audience laugh.",
  "",
  "retention_analysis:",
  "<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - the exposed brick wall, orange tufted sofa, patterned pillows, neon sign, and wooden coffee table are retained.",
  "<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - the Samoyed's thick white fur, pointed ears, dark nose, and curved tail are retained.",
  "<Subject 3> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - the blonde woman's identity, long hair, and light-pink shirt are retained.",
  "<Subject 4> (appears in [Shot 1], [Shot 2]): fully_preserved - the young man's short wavy brown hair and dark-grey hoodie are retained.",
  "<Audio 1>: reference - its vocal timbre guides the dialogue delivery of <Subject 3> without copying the original signal.",
  "",
  "detailed_description:",
  "The target video uses a realistic multi-camera sitcom style with warm indoor lighting.",
  "[Shot 1] A medium shot establishes <Subject 1>, the coffee shop. <Subject 3> (S1) sits on the sofa. From the left, <Subject 4> enters holding the leash of <Subject 2>. <Subject 3> (S1) exclaims, <d>[English] Hey! Watch your dog!</d>",
  "[Shot 2] At 00:03.000, the shot cuts to a close-up of <Subject 4> (S2) sitting beside <Subject 3> and holding <Subject 2>. <Subject 4> (S2) says, <d>[English] He just likes cookies more than me.</d>",
  "[Shot 3] At 00:05.000, the shot cuts to a close-up of <Subject 3> (S1). She replies, <d>[English] Well, he has good taste at least.</d>",
  "",
  "overall_soundscape:",
  "Soft indoor coffee-shop room tone continues throughout the scene.",
  "",
  "non_diegetic_music:",
  "N/A",
].join("\n");

function guideExampleInputs() {
  return asExtension([
    batch(IMAGES, "image", [1, 2, 3, 4].map((n) => item(IMAGES, n - 1, { itemId: `media-P${n}` }))),
    batch(VIDEOS, "video", [1, 2].map((n) =>
      item(VIDEOS, n - 1, { itemId: `media-V${n}`, mediaType: "video", hasAudio: true }),
    )),
    batch(AUDIOS, "audio", [item(AUDIOS, 0, { itemId: "media-S1", mediaType: "audio", hasAudio: true })]),
  ]);
}

/** A document made from `prompt` against `inputs`, and what it resolves to. */
async function structured(prompt: string, inputs = workedExample()) {
  const pkg = await loadPackage();
  const catalogue = pkg.buildReferenceCatalogue(inputs, REFERENCE_IDS);
  const result = pkg.importReferencePrompt(prompt, catalogue);
  if (!result.ok) throw new Error(`import failed: ${JSON.stringify(result)}`);
  const resolve = (document: typeof result.document, against = catalogue) => {
    const resolution = pkg.resolveReferenceDocument(document, against);
    if (!resolution.ok) throw new Error(`expected to resolve: ${JSON.stringify(resolution)}`);
    return resolution.text;
  };
  return { pkg, catalogue, document: result.document, resolve };
}

type LoadedRetentionRow = Extract<LoadedRetentionEntry, { kind: "retention" }>;

function retentionRows(document: {
  readonly retention: readonly LoadedRetentionEntry[];
}): LoadedRetentionRow[] {
  return document.retention.filter((entry): entry is LoadedRetentionRow => entry.kind === "retention");
}

describe.skipIf(!packagePresent)("minimax ref2v: structured sections", () => {
  it("reads the guide's complete example into structure and writes it back byte for byte", async () => {
    const { document, resolve } = await structured(GUIDE_EXAMPLE, guideExampleInputs());

    expect(document.definitions.map((entry) => entry.kind)).toEqual([
      "definition", "definition", "definition", "definition", "definition",
    ]);
    expect(document.summary.categories).toEqual(["reference generation", "audio reference"]);
    // Scope that matches the shots is derived and will follow them; scope the
    // shots do not bear out (Subject 1 is only cited in Shot 1) is the author's.
    expect(
      retentionRows(document).map((entry) => [entry.targetId, entry.marker, entry.scope.mode]),
    ).toEqual([
      ["subject:subject-1", "fully_preserved", "custom"],
      ["subject:subject-2", "fully_preserved", "derived"],
      ["subject:subject-3", "fully_preserved", "derived"],
      ["subject:subject-4", "fully_preserved", "derived"],
      ["audio:media-S1", "reference", "none"],
    ]);
    expect(resolve(document)).toBe(GUIDE_EXAMPLE);
  });

  it("parses picture roles only in the guide's own phrasing, and keeps anything else as prose", async () => {
    const prompt = [
      "subject_definitions:",
      "<Picture 1> is the first frame of [Shot 1] and a keyframe of [Shot 2] and [Shot 3], showing a woman seated by a window.",
      "<Picture 2> is the opening frame of [Shot 1].",
      "<Video 1> is the source video for the target video edit.",
      "A note that is not a definition.",
      "",
      "detailed_description:",
      "[Shot 1] One.",
      "[Shot 2] At 00:01.000, two.",
      "[Shot 3] At 00:02.000, three.",
    ].join("\n");
    const { document, resolve } = await structured(prompt);
    const [first, second, video, note] = document.definitions as readonly LoadedDefinitionShape[];

    expect(first).toMatchObject({
      kind: "definition",
      targetId: "visual:media-A",
      roles: [
        { kind: "first-frame", shotIds: ["shot-1"] },
        { kind: "keyframe", shotIds: ["shot-2", "shot-3"] },
      ],
    });
    expect(second).toMatchObject({ kind: "definition", targetId: "visual:media-B", roles: [] });
    expect(video).toMatchObject({ kind: "definition", targetId: "visual:media-V1", roles: [] });
    expect(note.kind).toBe("raw");
    expect(resolve(document)).toBe(prompt);

    // Out of shot order is not the phrasing this codec writes, so it is prose.
    const reordered = await structured(prompt.replace("[Shot 2] and [Shot 3]", "[Shot 3] and [Shot 2]"));
    expect((reordered.document.definitions[0] as LoadedDefinitionShape).roles).toEqual([]);
    expect(reordered.resolve(reordered.document)).toContain("a keyframe of [Shot 3] and [Shot 2]");
  });

  it("drafts one editable retention line for a frame role, and follows role changes without losing edits", async () => {
    const { pkg, document, resolve } = await structured("detailed_description:\n[Shot 1] One.\n[Shot 2] At 00:01.000, two.");
    const withDefinition = pkg.addDefinition(document, {
      kind: "definition",
      id: "def-B",
      targetId: "visual:media-B",
      roles: [],
      body: pkg.inlineDocument([]),
    });
    const firstFrame = { id: "role-1", kind: "first-frame", shotIds: ["shot-1"] };
    const framed = pkg.setPictureRoles(withDefinition, "def-B", [firstFrame]);

    // The plan's own example (§5.1), exactly.
    expect(resolve(framed)).toContain(
      "retention_analysis:\n<Picture 2> ([Shot 1] first frame): fully_preserved - the frame layout is retained.",
    );
    expect(retentionRows(framed)).toMatchObject([{ fromFrameRole: true, edited: false }]);

    // More roles, and a role moved to another shot, never add a second line.
    const more = pkg.setPictureRoles(framed, "def-B", [
      { ...firstFrame, shotIds: ["shot-2"] },
      { id: "role-2", kind: "last-frame", shotIds: ["shot-2"] },
    ]);
    expect(retentionRows(more)).toHaveLength(1);
    expect(resolve(more)).toContain("<Picture 2> ([Shot 2] first frame, [Shot 2] last frame): fully_preserved");

    // An untouched drafted line goes when the last frame role goes...
    expect(retentionRows(pkg.setPictureRoles(more, "def-B", []))).toEqual([]);
    // ...and a storyboard is not a frame anchor, so it drafts nothing.
    const storyboard = pkg.setPictureRoles(more, "def-B", [{ id: "role-3", kind: "storyboard", shotIds: ["shot-1"] }]);
    expect(retentionRows(storyboard)).toEqual([]);

    // An edited one stays, marker and all, for review.
    const row = retentionRows(more)[0];
    const partial = pkg.setRetentionMarker(more, row.id, "partially_preserved");
    const cleared = pkg.setPictureRoles(partial, "def-B", []);
    expect(retentionRows(cleared)).toMatchObject([{ marker: "partially_preserved", edited: true }]);
    expect(pkg.retentionReview(retentionRows(cleared)[0] as never, cleared)).toMatch(/frame role that has since been removed/);
  });

  it("remembers a deleted drafted line until the author restores it", async () => {
    const { pkg, document } = await structured("detailed_description:\n[Shot 1] One.");
    const framed = pkg.setPictureRoles(
      pkg.addDefinition(document, {
        kind: "definition",
        id: "def-A",
        targetId: "visual:media-A",
        roles: [],
        body: pkg.inlineDocument([]),
      }),
      "def-A",
      [{ id: "role-1", kind: "keyframe", shotIds: ["shot-1"] }],
    );
    const deleted = pkg.removeRetention(framed, retentionRows(framed)[0].id);
    expect(deleted.suppressedRetention).toEqual(["visual:media-A"]);

    // Another role edit does not bring it back...
    const edited = pkg.setPictureRoles(deleted, "def-A", [
      { id: "role-1", kind: "keyframe", shotIds: ["shot-1"] },
      { id: "role-2", kind: "last-frame", shotIds: ["shot-1"] },
    ]);
    expect(retentionRows(edited)).toEqual([]);
    // ...restoring does.
    expect(retentionRows(pkg.restoreSuggestedRetention(edited, "visual:media-A"))).toMatchObject([
      { targetId: "visual:media-A", marker: "fully_preserved", fromFrameRole: true },
    ]);
  });

  it("keeps markers within their family, and accepts retention that covers only some objects", async () => {
    const { pkg, document, resolve } = await structured(
      [
        "subject_definitions:",
        "<Subject 1> is the woman in <Picture 1>.",
        "",
        "retention_analysis:",
        "<Audio 1>: fully_preserved - a visual marker on a soundtrack.",
        "<Picture 2>: fully_copy - an audio marker on a picture.",
        "<Video 2> (cut and pacing structure): weak_reference - only the rhythm.",
        "",
        "detailed_description:",
        "[Shot 1] <Subject 1> walks past <Video 3>.",
      ].join("\n"),
    );
    expect(pkg.markersFor("Audio")).toEqual(["fully_copy", "partially_copy", "reference", "weak_reference"]);
    expect(pkg.markersFor("Picture")).toEqual([
      "fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference",
    ]);
    // The wrong family is not a retention line; it is kept, verbatim, as text.
    expect(document.retention.map((entry) => entry.kind)).toEqual(["raw", "retention"]);
    expect(retentionRows(document)[0]).toMatchObject({ targetId: "visual:media-V2", scope: { mode: "custom" } });

    // Subject 1 and Video 3 have no line, and that is a valid prompt.
    expect(() => resolve(document)).not.toThrow();
    const labeller = pkg.createReferenceLabeller(document, pkg.buildReferenceCatalogue(workedExample(), REFERENCE_IDS));
    expect(pkg.availableForRetention(document, labeller).map((entry) => entry.targetId)).toEqual([
      "subject:subject-1",
      "visual:media-V3",
    ]);
  });

  it("recovers scope from the shots when the parentheses were deleted outside the composer, through reorders", async () => {
    const committed = [
      "subject_definitions:",
      "<Subject 1> is the woman in <Picture 1>.",
      "",
      "retention_analysis:",
      "<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - the blue coat is retained.",
      "",
      "detailed_description:",
      "[Shot 1] <Subject 1> enters.",
      "[Shot 2] At 00:02.000, <Picture 2> fills the frame.",
      "[Shot 3] At 00:04.000, <Subject 1> leaves.",
    ].join("\n");
    const first = await structured(committed);
    expect(retentionRows(first.document)[0].scope.mode).toBe("derived");
    expect(first.resolve(first.document)).toBe(committed);

    // Parentheses deleted in the main panel, then reopened with no cache.
    const edited = committed.replace(" (appears in [Shot 1], [Shot 3])", "");
    const { pkg, document } = await structured(edited);
    const [row] = retentionRows(document);
    expect(row.scope.mode).toBe("none");

    // Reorder subjects and media, then commit: every reference still resolves,
    // and the annotation stays as optional as the author left it.
    const withSecond = pkg.createSubject(document, {
      id: "subject-dog",
      name: "Dog",
      description: "a dog",
      sourceIds: [],
      definitionId: "def-dog",
    });
    const dogFirst = pkg.moveSubject(withSecond, "subject-dog", -1);
    const [images, videos, audios] = workedExample() as unknown as GenerationInputSnapshot[];
    const reordered = pkg.buildReferenceCatalogue(
      asExtension([{ ...images, media: [...images.media!].reverse() }, videos, audios]),
      REFERENCE_IDS,
    );
    const resolution = pkg.resolveReferenceDocument(dogFirst, reordered);
    if (!resolution.ok) throw new Error(JSON.stringify(resolution));
    expect(resolution.text).toContain("<Subject 2> is the woman in <Picture 2>.");
    expect(resolution.text).toContain("<Subject 2>: fully_preserved - the blue coat is retained.");
    expect(resolution.text).toContain("[Shot 2] At 00:02.000, <Picture 1> fills the frame.");

    // "Use derived scope" bakes it back, from the shots as they now stand.
    const baked = pkg.setRetentionScope(pkg.moveShot(dogFirst, "shot-3", -1), row.id, { mode: "derived" });
    const bakedText = pkg.resolveReferenceDocument(baked, reordered);
    expect(bakedText.ok && bakedText.text).toContain(
      "<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - the blue coat is retained.",
    );

    // And with the retention line removed outright, the subject is offered
    // back with its scope rather than silently re-added.
    const noRow = await structured(
      edited.replace("<Subject 1>: fully_preserved - the blue coat is retained.\n", ""),
    );
    expect(noRow.document.retention).toEqual([]);
    const labeller = pkg.createReferenceLabeller(noRow.document, noRow.catalogue);
    const offered = pkg.availableForRetention(noRow.document, labeller);
    expect(offered.map((entry) => entry.targetId)).toEqual(["subject:subject-1", "visual:media-B"]);
  });

  it("toggles task types without reshuffling an imported order, and suggests only from roles", async () => {
    const { pkg, document, resolve } = await structured(
      "summary:\n[audio reuse + video editing] The target video is an edited version of <Video 1>.",
    );
    expect(document.summary.categories).toEqual(["audio reuse", "video editing"]);
    const added = pkg.toggleSummaryCategory(document, "keyframe completion");
    expect(resolve(added)).toContain("summary:\n[audio reuse + video editing + keyframe completion] The target");
    expect(resolve(pkg.toggleSummaryCategory(added, "audio reuse"))).toContain(
      "summary:\n[video editing + keyframe completion] The target",
    );

    const unknown = await structured("summary:\n[image editing] A still is retouched.");
    expect(unknown.document.summary.categories).toEqual([]);
    expect(unknown.resolve(unknown.document)).toBe("summary:\n[image editing] A still is retouched.");

    // Attached media alone suggests nothing; a frame role does.
    const plain = await structured("detailed_description:\n[Shot 1] One.");
    expect(pkg.suggestedCategories(plain.document)).toEqual([]);
    const framed = pkg.setPictureRoles(
      pkg.addDefinition(plain.document, {
        kind: "definition", id: "d", targetId: "visual:media-A", roles: [], body: pkg.inlineDocument([]),
      }),
      "d",
      [{ id: "r", kind: "first-frame", shotIds: ["shot-1"] }],
    );
    expect(pkg.suggestedCategories(framed)).toEqual(["keyframe completion"]);
    expect(pkg.suggestedCategories(pkg.dismissSummarySuggestion(framed, "keyframe completion"))).toEqual([]);

    const opened = pkg.insertEditingOpener(plain.document, "visual:media-V2");
    expect(plain.resolve(opened)).toContain("summary:\nThe target video is an edited version of <Video 2>.");
  });

  it("refuses a picture role with no shot, and gives guide checks without blocking", async () => {
    const { pkg, document, catalogue } = await structured(
      [
        "summary:",
        "<Video 1> is shown.",
        "",
        "retention_analysis:",
        "<Picture 1>: fully_preserved - a.",
        "<Picture 1>: weak_reference - b.",
        "",
        "detailed_description:",
        "[Shot 1] At 00:01.000, she says <d>hello</d>.",
        "[Shot 2] Then a cut with no time.",
        "",
        "overall_soundscape:",
        "<d>[English] Hi.</d>",
      ].join("\n"),
    );
    const labeller = pkg.createReferenceLabeller(document, catalogue);
    expect(pkg.guideHints(document, labeller).map((hint) => hint.id)).toEqual([
      "timestamp-shot-1",
      "timestamp-shot-2",
      "dialogue-language",
      "dialogue-placement",
      "summary-labels",
      "retention-duplicate-visual:media-A",
    ]);
    // Advice only: it still resolves.
    expect(pkg.resolveReferenceDocument(document, catalogue).ok).toBe(true);

    const unanchored = pkg.setPictureRoles(
      pkg.addDefinition(document, {
        kind: "definition", id: "d", targetId: "visual:media-B", roles: [], body: pkg.inlineDocument([]),
      }),
      "d",
      [{ id: "role-x", kind: "composition", shotIds: [] }],
    );
    expect(pkg.resolveReferenceDocument(unanchored, catalogue)).toMatchObject({
      ok: false,
      incompleteRoles: ["role-x"],
    });
  });
});

interface LoadedDefinitionShape {
  readonly kind: "definition" | "raw";
  readonly targetId?: string;
  readonly roles?: readonly { readonly kind: string; readonly shotIds: readonly string[] }[];
}

describe.skipIf(!packagePresent)("minimax ref2v: structured controls", () => {
  function selectOption(name: string, value: string) {
    fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
  }

  function speakingInputs(prompt: string): GenerationInputSnapshot[] {
    return panelInputs(prompt).map((input) =>
      input.id === VIDEOS
        ? { ...input, media: input.media!.map((entry) => ({ ...entry, options: { audio: true } })) }
        : input,
    );
  }

  it("authors the plan's completion example and commits it resolved against the reordered media", async () => {
    const { replaceReferenceText, typeReferenceText } = await loadLoader();
    const pkg = await loadPackage();
    session = mountGenerationSession({ nodes: REFERENCE_NODES, inputs: speakingInputs("") });
    const { drafts } = await mount(pkg);

    // A local subject from the portrait and the speaking video's soundtrack.
    fireEvent.click(screen.getByRole("button", { name: "Add definition" }));
    selectOption("Definition type", "subject");
    const form = screen.getByRole("group", { name: "New subject" });
    fireEvent.change(within(form).getByLabelText("Subject name"), { target: { value: "Mara" } });
    fireEvent.change(within(form).getByLabelText("What it is"), {
      target: { value: "the woman with a red scarf" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "<Picture 1>" }));
    fireEvent.click(within(form).getByRole("button", { name: "<Audio 1>" }));
    fireEvent.click(within(form).getByRole("button", { name: "Create subject" }));
    expect(chipLabels("Definition of <Subject 1>")).toEqual(["<Picture 1>", "<Audio 1>"]);

    // The other picture is Shot 1's first frame, which drafts its retention.
    fireEvent.click(screen.getByRole("button", { name: "Add definition" }));
    selectOption("Definition type", "visual:media-city");
    fireEvent.click(screen.getByRole("button", { name: "Add role to <Picture 2>" }));
    const drafted = screen
      .getByTestId("retention-section")
      .querySelector('[data-retention="visual:media-city"]') as HTMLElement;
    expect(drafted.textContent).not.toContain("Added from a frame role.");
    // Scope is derived from the role and shown, not chosen: there is no
    // control for it in the composer.
    expect(drafted.textContent).toContain("[Shot 1] first frame");
    expect(within(drafted).queryByRole("combobox", { name: /Scope/ })).toBeNull();

    // Task types, from the suggestions the roles raised.
    fireEvent.click(screen.getByRole("button", { name: "Add suggested keyframe completion" }));
    fireEvent.click(screen.getByRole("button", { name: "Add suggested reference generation" }));
    replaceReferenceText(screen.getByRole("textbox", { name: "Summary" }), "Mara walks past the window.");

    // A style opening, and the subject in two shots.
    replaceReferenceText(screen.getByRole("textbox", { name: "Style opening" }), "Warm, handheld.");
    const shot1 = screen.getByRole("textbox", { name: "Shot 1" });
    typeReferenceText(shot1, "The shot begins as ");
    typeReferenceText(shot1, "<Subject 1>");
    typeReferenceText(shot1, " enters.");
    fireEvent.click(screen.getByRole("button", { name: "Add shot" }));
    const shot2 = screen.getByRole("textbox", { name: "Shot 2" });
    typeReferenceText(shot2, "At 00:02.000, ");
    typeReferenceText(shot2, "<Subject 1>");
    typeReferenceText(shot2, " turns.");

    // Offered, not imposed: the subject is available for retention with its
    // derived scope, and added with an explicit relationship.
    fireEvent.click(screen.getByRole("button", { name: "Add retention" }));
    selectOption("Add retention for another reference", (screen.getByRole("option", { name: /<Subject 1>/ }) as HTMLOptionElement).value);
    selectOption("Relationship for new retention", "fully_preserved");
    replaceReferenceText(
      screen.getByRole("textbox", { name: "Retention of <Subject 1>" }),
      "the red scarf is retained.",
    );

    // Reverse the pictures: labels move, targets stay.
    act(() => drafts[0].stage({ kind: "moveMedia", inputId: IMAGES, fromOrdinal: 1, toOrdinal: 0 }));
    expect(chipLabels("Definition of <Subject 1>")).toEqual(["<Picture 2>", "<Audio 1>"]);
    expect(
      within(screen.getByTestId("retention-section")).getByRole("combobox", {
        name: "Relationship for <Picture 1>",
      }),
    ).toBeInTheDocument();
    expect(session.commit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Commit to prompt" }));
    expect(session.commit).toHaveBeenCalledOnce();
    expect(session.panelInputs().find((input) => input.id === PROMPT)?.value).toBe(
      [
        "subject_definitions:",
        "<Subject 1> is the woman with a red scarf from <Picture 2> and <Audio 1>.",
        "<Picture 1> is the first frame of [Shot 1].",
        "",
        "summary:",
        "[keyframe completion + reference generation] Mara walks past the window.",
        "",
        "retention_analysis:",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - the frame layout is retained.",
        "<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - the red scarf is retained.",
        "",
        "detailed_description:",
        "Warm, handheld.",
        "[Shot 1] The shot begins as <Subject 1> enters.",
        "[Shot 2] At 00:02.000, <Subject 1> turns.",
        "",
        "non_diegetic_music:",
        "N/A",
      ].join("\n"),
    );
    expect(
      session.panelInputs().find((input) => input.id === IMAGES)?.media?.map((entry) => entry.itemId),
    ).toEqual(["media-city", "media-hero"]);
  });

  it("offers the shots' scope back after the parentheses were deleted in the panel, and audio only audio markers", async () => {
    const pkg = await loadPackage();
    const prompt = [
      "subject_definitions:",
      "<Subject 1> is the woman in <Picture 1>.",
      "",
      "retention_analysis:",
      "<Subject 1>: fully_preserved - the scarf is retained.",
      "",
      "detailed_description:",
      "[Shot 1] <Subject 1> enters.",
      "[Shot 2] At 00:02.000, <Picture 2> fills the frame and <Audio 1> plays.",
      "[Shot 3] At 00:04.000, <Subject 1> leaves.",
    ].join("\n");
    session = mountGenerationSession({ nodes: REFERENCE_NODES, inputs: panelInputs(prompt) });
    const { drafts } = await mount(pkg);

    const retention = screen.getByTestId("retention-section");
    // Read from the prompt as it stands — no parentheses — and shown, with the
    // one way back to the shots rather than a scope editor.
    expect(retention.textContent).toContain("No scope written in the prompt.");
    expect(
      within(retention).getByRole("button", { name: "Scope <Subject 1> by its shots" }),
    ).toHaveTextContent("Use shots: (appears in [Shot 1], [Shot 3])");
    fireEvent.click(screen.getByRole("button", { name: "Add retention" }));
    selectOption("Add retention for another reference", "audio:media-song");
    expect(
      [...within(retention).getByRole("combobox", { name: "Relationship for new retention" }).querySelectorAll("option")]
        .map((option) => option.getAttribute("value")),
    ).toEqual(["", "fully_copy", "partially_copy", "reference", "weak_reference"]);

    act(() => drafts[0].stage({ kind: "moveMedia", inputId: IMAGES, fromOrdinal: 1, toOrdinal: 0 }));
    fireEvent.click(screen.getByRole("button", { name: "Scope <Subject 1> by its shots" }));
    fireEvent.click(screen.getByRole("button", { name: "Commit to prompt" }));

    const written = session.panelInputs().find((input) => input.id === PROMPT)?.value as string;
    expect(written).toContain("<Subject 1> is the woman in <Picture 2>.");
    expect(written).toContain(
      "<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - the scarf is retained.",
    );
    expect(written).toContain("[Shot 2] At 00:02.000, <Picture 1> fills the frame and <Audio 1> plays.");
  });
});
