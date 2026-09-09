import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionHost } from "../../ExtensionHost";
import { createVloExtensionApi } from "../../services/FrontendExtensionRuntime";
import type { ExtensionModule, VloExtensionApi } from "../../types";
import { hostViewRegistry } from "../../../../core/shell/viewRegistry";
import { hostCommandTable } from "../../../../core/shell/commandTable";
import { declareHostMenus } from "../../../../core/shell/hostMenus";
import { extensionMenuPlacementRegistry } from "../../menus/ExtensionMenuPlacementRegistry";
import { generationPanelSectionRegistry } from "../../../generation/services/GenerationPanelSectionRegistry";
import { extensionUiSlotRegistry } from "../../ui/publicApi";
import { panelTakeovers } from "../../../../core/shell/panelTakeovers";
import { declareRightSidebarHostViews } from "../../../../app/layout/rightSidebarHostViews";
import { createMuiStubs } from "./minimaxHostStubs";
import type {
  LoadedPromptGuide,
  MinimaxPromptPackage,
} from "./minimaxPromptPackageLoader";

const EXTENSION_ID = "vlo.minimax-prompt";

/**
 * Phases 3A and 3B of docs/minimax-prompt-composer-extension-plan.md: the
 * composer's shell and section model, and the keyframe-derived instruction
 * line.
 *
 * Same optionality as the Subjects suite — the package lives in the git-ignored
 * runtime extension root, so this skips wholesale when it is absent — and the
 * same honest limits: it imports the package's TypeScript source and calls
 * `activate` directly, so discovery, digest approval and the built bundle are
 * still Phase 4's to cover.
 */
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../..",
);
const PACKAGE_ENTRY_PATH = resolve(
  REPO_ROOT,
  "extensions/installed",
  EXTENSION_ID,
  "frontend/src/index.ts",
);
const packagePresent = existsSync(PACKAGE_ENTRY_PATH);

async function loadPackage(): Promise<MinimaxPromptPackage> {
  return (await import("./minimaxPromptPackageLoader")).minimaxPromptPackage;
}

/** The prompt a shipped workflow seeds its H3 node's widget with. */
async function shippedPrompt(workflow: string): Promise<string> {
  const path = resolve(
    REPO_ROOT,
    "backend/assets/.config/default_workflows",
    `${workflow}.json`,
  );
  const graph = JSON.parse(await readFile(path, "utf8")) as {
    nodes: { widgets_values_named?: Record<string, unknown> }[];
  };
  for (const node of graph.nodes) {
    const prompt = node.widgets_values_named?.prompt;
    if (typeof prompt === "string") return prompt;
  }
  throw new Error(`No prompt widget in ${workflow}`);
}

/**
 * A generation panel holding one text input, standing in for the host store.
 *
 * The composer only ever reads the published projection and writes through the
 * labelled transaction, so a fake at that boundary exercises everything this
 * phase owns. What the real transaction does with the write is covered by
 * `generationSessionMediaParity`, natively and through the adapter.
 */
function createGenerationHarness(options: {
  prompt: string;
  classTypes: readonly string[];
  fingerprint?: string;
  /** Single-slot image inputs, as the keyframe workflows publish them. */
  keyframes?: readonly { label: string; filled: boolean }[];
  /** The base node's `length` widget: a frame count, or null for linked. */
  length?: number | null;
}) {
  const commits: { label: string; value: string }[] = [];
  const listeners = new Set<() => void>();
  let text = options.prompt;
  let revision = 0;
  let snapshot: unknown = null;
  let snapshotRevision = -1;

  const read = () => {
    if (snapshotRevision !== revision) {
      snapshotRevision = revision;
      snapshot = {
        workflow: {
          sourceId: "workflow-1",
          instanceId: null,
          revision: 1,
          fingerprint: options.fingerprint ?? "fingerprint-1",
          mode: "catalogue",
          nodes: options.classTypes.map((classType, index) => ({
            id: `${100 + index}`,
            classType,
            title: classType,
            mode: 0,
            widgets:
              classType === "MiniMaxH3ImageToVideo" &&
              options.length !== undefined
                ? [
                    {
                      nodeId: `${100 + index}`,
                      param: "length",
                      valueType: "int",
                      value: options.length,
                      defaultValue: 124,
                      options: null,
                      min: 22,
                      max: 719,
                      step: 17,
                      linked: options.length === null,
                      editable: true,
                    },
                  ]
                : [],
          })),
        },
        status: "ready",
        inputs: [
          {
            id: "136:prompt",
            nodeId: "136",
            param: "prompt",
            label: "Prompt",
            inputType: "text",
            value: text,
          },
          ...(options.keyframes ?? []).map((keyframe, index) => ({
            id: `${141 + index}:image`,
            nodeId: `${141 + index}`,
            param: "image",
            label: keyframe.label,
            inputType: "image",
            media: keyframe.filled
              ? [
                  {
                    slotId: `slot-${index}`,
                    ordinal: 1,
                    source: "asset",
                    assetId: `asset-${index}`,
                    displayName: keyframe.label,
                    mediaType: "image",
                    hasAudio: false,
                    options: {},
                    preparing: false,
                  },
                ]
              : [],
          })),
        ],
        canSubmit: true,
        busy: false,
      };
    }
    return snapshot;
  };

  const generation = {
    getSession: read,
    listInputs: () => (read() as { inputs: unknown[] }).inputs,
    getRevision: () => revision,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    transaction: (
      label: string,
      callback: (transaction: {
        setTextInput(inputId: string, value: string): void;
      }) => void,
    ) => {
      let next = text;
      callback({
        setTextInput: (_inputId, value) => {
          next = value;
        },
      });
      const changed = next !== text;
      commits.push({ label, value: next });
      if (changed) {
        text = next;
        revision += 1;
        for (const listener of [...listeners]) listener();
      }
      return { ok: true as const, changed, label };
    },
  };

  const staged: { current: readonly unknown[] } = { current: [] };
  return {
    commits,
    generation,
    /** Inputs as a staged editor would show them, overriding the session's. */
    get stagedInputs() {
      return staged.current as readonly { id: string }[];
    },
    stage(inputs: readonly unknown[]) {
      staged.current = inputs;
    },
    get text() {
      return text;
    },
    setText(next: string) {
      text = next;
      revision += 1;
      for (const listener of [...listeners]) listener();
    },
  };
}

function mountComposer(
  createComposerView: (deps: never) => unknown,
  session: unknown,
  harness: ReturnType<typeof createGenerationHarness>,
): ReturnType<typeof render> {
  const api = {
    generation: harness.generation,
    runtime: {
      react: React,
      mui: createMuiStubs(),
      panelUi: {},
      // Stands in for the host's staged editor: it renders nothing of its own
      // and hands the composer a controller over the inputs it asked for, so
      // the composer's *use* of a draft is exercised without the panel.
      generationUi: {
        InputsDraft: ({
          inputIds,
          children,
        }: {
          inputIds: readonly string[];
          children?: (controller: unknown) => unknown;
        }) =>
          children?.({
            inputs: (harness.stagedInputs ?? []).filter((entry) =>
              inputIds.includes(entry.id),
            ),
            canCommit: true,
            error: null,
            commit: (label: string, writes?: (tx: unknown) => void) =>
              harness.generation.transaction(label, writes as never),
            revert: () => undefined,
          }) ?? null,
      },
    },
  };
  const View = createComposerView({
    api: api as unknown as VloExtensionApi,
    session,
    react: React as never,
  } as never) as unknown as React.FunctionComponent<{
    viewId: string;
    region: string;
    active: boolean;
  }>;
  return render(
    React.createElement(View, {
      viewId: "v",
      region: "editor-overlay",
      active: true,
    }),
  );
}

function textAreaFor(label: string): HTMLTextAreaElement {
  return screen.getByLabelText(label) as HTMLTextAreaElement;
}

function type(label: string, value: string): void {
  act(() => {
    fireEvent.change(textAreaFor(label), { target: { value } });
  });
}

function click(name: string): void {
  const button = screen
    .getAllByRole("button")
    .find((element) => element.textContent === name);
  if (!button) throw new Error(`No button labelled '${name}'`);
  act(() => {
    fireEvent.click(button);
  });
}

let activeHost: ExtensionHost<VloExtensionApi> | undefined;

afterEach(async () => {
  if (activeHost) {
    await activeHost.deactivate(EXTENSION_ID);
    activeHost = undefined;
  }
});

describe.skipIf(!packagePresent)("minimax composer conformance fixture", () => {
  // 3A — the shell: where the composer lives and how it is reached.
  it("registers a floating composer, a command, a menu item and a workflow section", async () => {
    declareHostMenus();
    const {
      activate,
      COMPOSER_VIEW_ID,
      COMPOSER_COMMAND_ID,
      COMPOSER_SECTION_ID,
      COMPOSER_MENU_ID,
    } = await loadPackage();
    const composerId = `${EXTENSION_ID}/${COMPOSER_VIEW_ID}`;
    const commandId = `${EXTENSION_ID}/${COMPOSER_COMMAND_ID}`;

    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: "1.21.0",
      createApi: createVloExtensionApi,
    });
    activeHost = host;
    await host.activate(
      { id: EXTENSION_ID, version: "0.2.0" },
      { activate: activate as ExtensionModule["activate"] },
    );

    // Floating, not docked: the generation panel it writes has to stay
    // visible behind it, and 3D's subject drag needs the editor's drag
    // context — which the modal host is outside of.
    expect(hostViewRegistry.get(composerId)?.defaultRegion).toBe(
      "editor-overlay",
    );
    // A floating panel takes no tab and cannot be moved into one: the SDK
    // refuses `allowedRegions` on this region outright.
    expect(hostViewRegistry.get(composerId)?.allowedRegions).toEqual([]);

    expect(hostCommandTable.has(commandId)).toBe(true);
    expect(
      extensionMenuPlacementRegistry
        .listForMenu(COMPOSER_MENU_ID)
        .map((placement) => placement.definition.commandId),
    ).toContain(commandId);
    expect(
      generationPanelSectionRegistry.get(EXTENSION_ID, COMPOSER_SECTION_ID),
    ).not.toBeNull();

    await host.deactivate(EXTENSION_ID);
    activeHost = undefined;
    expect(hostViewRegistry.get(composerId)).toBeUndefined();
    expect(hostCommandTable.has(commandId)).toBe(false);
    expect(
      extensionMenuPlacementRegistry.listForMenu(COMPOSER_MENU_ID),
    ).toHaveLength(0);
    expect(
      generationPanelSectionRegistry.get(EXTENSION_ID, COMPOSER_SECTION_ID),
    ).toBeNull();
  });

  it("puts its button at the Prompts anchor, only for a MiniMax workflow", async () => {
    declareHostMenus();
    const { activate, COMPOSER_ANCHOR_SLOT, WORKFLOW_SUPPORTED_CONTEXT_KEY } =
      await loadPackage();
    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: "1.21.0",
      createApi: createVloExtensionApi,
    });
    activeHost = host;
    await host.activate(
      { id: EXTENSION_ID, version: "0.2.0" },
      { activate: activate as ExtensionModule["activate"] },
    );

    // The anchor is a family target: no rules file names it, and it reaches
    // every workflow whose Prompts section the panel renders.
    expect(COMPOSER_ANCHOR_SLOT).toBe("generation.section.prompts.after");
    const contributions = extensionUiSlotRegistry.list(COMPOSER_ANCHOR_SLOT);
    const button = contributions.find(
      (entry) => entry.id === `${EXTENSION_ID}/open-composer-button`,
    );
    expect(button).toBeDefined();
    // Gated declaratively, so an unsupported workflow mounts nothing at all —
    // a component that merely returned null would still cost the slot's
    // padded wrapper under every non-MiniMax prompt.
    expect((button?.definition as { when?: unknown }).when).toEqual({
      key: `extension.${EXTENSION_ID}.${WORKFLOW_SUPPORTED_CONTEXT_KEY}`,
    });

    await host.deactivate(EXTENSION_ID);
    activeHost = undefined;
    expect(extensionUiSlotRegistry.list(COMPOSER_ANCHOR_SLOT)).toHaveLength(0);
  });

  it("takes over the generation panel, and hands it back", async () => {
    declareHostMenus();
    const {
      activate,
      COMPOSER_TAKEOVER_ID,
      COMPOSER_TAKEOVER_TARGET,
      COMPOSER_COMMAND_ID,
    } = await loadPackage();
    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: "1.24.0",
      createApi: createVloExtensionApi,
    });
    activeHost = host;
    await host.activate(
      { id: EXTENSION_ID, version: "0.3.0" },
      { activate: activate as ExtensionModule["activate"] },
    );

    const takeoverId = `${EXTENSION_ID}/${COMPOSER_TAKEOVER_ID}`;
    expect(panelTakeovers.getActive(COMPOSER_TAKEOVER_TARGET)).toBeNull();

    // The panel is declared by the module that renders it, and the editor
    // loads lazily — so a package always activates *before* its target
    // exists. Declaring it only now is the real order, and a package that
    // read the target list at activation would never register at all.
    declareRightSidebarHostViews();

    // The command prefers the panel over the floating window.
    hostCommandTable.executeCommand(`${EXTENSION_ID}/${COMPOSER_COMMAND_ID}`, {
      source: "menu",
    });
    expect(panelTakeovers.getActive(COMPOSER_TAKEOVER_TARGET)?.id).toBe(
      takeoverId,
    );

    // The user's dismissal is the host's to perform, and it always works.
    panelTakeovers.close(takeoverId, true);
    expect(panelTakeovers.getActive(COMPOSER_TAKEOVER_TARGET)).toBeNull();

    // Deactivation cannot leave a body rendering in a panel it no longer owns.
    panelTakeovers.open(takeoverId);
    await host.deactivate(EXTENSION_ID);
    activeHost = undefined;
    expect(panelTakeovers.getActive(COMPOSER_TAKEOVER_TARGET)).toBeNull();
  });

  it("declares the capability the prompt write needs", async () => {
    const packageRoot = dirname(dirname(PACKAGE_ENTRY_PATH));
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, "../manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    // The composer writes a panel input through the labelled transaction.
    expect(manifest.capabilities).toContain("generation.write");
  });

  // 3A — which guide a workflow is written against.
  it("reads the guide from the node class, not from the inputs", async () => {
    const { guideForNodeClasses, BASE_GUIDE, REFERENCE_GUIDE } =
      await loadPackage();

    expect(guideForNodeClasses(["MiniMaxH3ImageToVideo"])).toBe(BASE_GUIDE);
    expect(
      guideForNodeClasses(["vloMiniMaxH3ReferenceToVideoBatch"]),
    ).toBe(REFERENCE_GUIDE);
    // The reference node is the one that emits <Picture N>/<Video N>/<Audio N>
    // labels, so its format wins wherever both appear.
    expect(
      guideForNodeClasses([
        "MiniMaxH3ImageToVideo",
        "vloMiniMaxH3ReferenceToVideoBatch",
      ]),
    ).toBe(REFERENCE_GUIDE);
    expect(guideForNodeClasses(["KSampler", "CLIPTextEncode"])).toBeNull();
  });

  // 3A — the section model, which is the phase's gate.
  it("splits and rebuilds a full-reference prompt", async () => {
    const { parsePrompt, serializePrompt, REFERENCE_GUIDE } = await loadPackage();
    const prompt = [
      "subject_definitions:",
      "<Subject 1> is the person in <Picture 1>.",
      "",
      "summary:",
      "[video editing + audio reuse] Recut the rooftop scene.",
      "",
      "detailed_description:",
      "[Shot 1] The boy looks up.",
      "[Shot 2] At 00:03.500, the mech roars.",
      "",
      "overall_soundscape:",
      "Wind, then a roar.",
    ].join("\n");

    const parsed = parsePrompt(prompt, REFERENCE_GUIDE);
    expect(parsed.unstructured).toBeNull();
    expect(parsed.preamble).toBe("");
    expect(
      parsed.sections.map((section) => [section.id, section.text]),
    ).toEqual([
      ["subject_definitions", "<Subject 1> is the person in <Picture 1>."],
      ["summary", "[video editing + audio reuse] Recut the rooftop scene."],
      // Present but empty: a section the prompt does not mention is still one
      // of the guide's, and the composer offers a box for it.
      ["retention_analysis", ""],
      [
        "detailed_description",
        "[Shot 1] The boy looks up.\n[Shot 2] At 00:03.500, the mech roars.",
      ],
      ["overall_soundscape", "Wind, then a roar."],
      ["non_diegetic_music", ""],
    ]);
    // Guide order, empty sections dropped: the labels are ordinary text to the
    // tokenizer, so a bare one is prompt the user pays for and learns nothing
    // from.
    expect(serializePrompt(parsed)).toBe(prompt);
  });

  it("commits and reopens to identical sections", async () => {
    const { parsePrompt, serializePrompt, BASE_GUIDE, REFERENCE_GUIDE } =
      await loadPackage();

    const roundTrips = (text: string, guide: LoadedPromptGuide): void => {
      const once = parsePrompt(text, guide);
      const twice = parsePrompt(serializePrompt(once), guide);
      expect(twice).toEqual(once);
    };

    // The shipped defaults, read from the workflows themselves: the label-only
    // skeleton the base guide seeds, and a hand-written freeform prompt.
    roundTrips(await shippedPrompt("vlo_minimax_h3_i2v"), BASE_GUIDE);
    roundTrips(await shippedPrompt("vlo_minimax_h3_r2v"), REFERENCE_GUIDE);

    roundTrips("", BASE_GUIDE);
    roundTrips("summary:\nOne line.", REFERENCE_GUIDE);
    roundTrips(
      "Use the first frame as the opening composition.\n\noverall_soundscape:\nRain.",
      BASE_GUIDE,
    );
  });

  it("seeds an empty prompt with the guide's sections rather than a banner", async () => {
    const { parsePrompt, REFERENCE_GUIDE } = await loadPackage();
    const parsed = parsePrompt("   \n\n", REFERENCE_GUIDE);
    expect(parsed.unstructured).toBeNull();
    expect(parsed.sections).toHaveLength(REFERENCE_GUIDE.sections.length);
    expect(parsed.sections.every((section) => section.text === "")).toBe(true);
  });

  it("keeps the instruction line ahead of the sections", async () => {
    const { parsePrompt, serializePrompt, BASE_GUIDE } = await loadPackage();
    // Phase 3B derives this line from the filled keyframe slots. Until it
    // does, a prompt that already has one must survive a round trip rather
    // than lose it.
    const prompt =
      "The first frame of the video is <Picture 1>.\n\nintegrated_multimodal_description:\nA slow push in.";
    const parsed = parsePrompt(prompt, BASE_GUIDE);
    expect(parsed.preamble).toBe("The first frame of the video is <Picture 1>.");
    expect(serializePrompt(parsed)).toBe(prompt);
  });

  it("leaves a prompt it cannot split whole, with a reason", async () => {
    const { parsePrompt, serializePrompt, REFERENCE_GUIDE } = await loadPackage();

    const freeform = "Bold comic-book ink style. Use <Picture 2> as a reference.";
    const noLabels = parsePrompt(freeform, REFERENCE_GUIDE);
    expect(noLabels.unstructured).toBe("no-labels");
    expect(noLabels.sections).toHaveLength(1);
    // Byte-identical: an unrecognised prompt is carried, not rewritten.
    expect(serializePrompt(noLabels)).toBe(freeform);

    // Splitting these would have to guess, and re-serializing in guide order
    // would silently rewrite someone's prompt.
    expect(
      parsePrompt("summary:\nOne.\n\nsummary:\nTwo.", REFERENCE_GUIDE)
        .unstructured,
    ).toBe("duplicate-label");
    expect(
      parsePrompt(
        "summary:\nOne.\n\nsubject_definitions:\n<Subject 1> is a boy.",
        REFERENCE_GUIDE,
      ).unstructured,
    ).toBe("out-of-order");
  });

  it("treats a colon inside prose as prose", async () => {
    const { parsePrompt, REFERENCE_GUIDE } = await loadPackage();
    const parsed = parsePrompt(
      "summary:\n[video editing] He says: get ready.\nnot_a_label: still prose.",
      REFERENCE_GUIDE,
    );
    expect(parsed.unstructured).toBeNull();
    expect(parsed.sections[1].text).toBe(
      "[video editing] He says: get ready.\nnot_a_label: still prose.",
    );
  });

  // 3A — the draft, which exists because the floating panel unmounts.
  it("holds one draft per prompt, not one draft", async () => {
    const { createComposerSession, composerDraftKey, parsePrompt, BASE_GUIDE } =
      await loadPackage();
    const session = createComposerSession();
    const first = composerDraftKey("fingerprint-1", "136:prompt");
    const second = composerDraftKey("fingerprint-2", "136:prompt");
    const rain = parsePrompt("overall_soundscape:\nRain.", BASE_GUIDE);
    const wind = parsePrompt("overall_soundscape:\nWind.", BASE_GUIDE);

    expect(session.getDraft(first)).toBeNull();
    session.setDraft(first, rain);
    // A different workflow is a different prompt, possibly a different guide;
    // its sections must not inherit this one's text.
    expect(session.getDraft(second)).toBeNull();

    // And writing that one must not overwrite the first. A single slot passes
    // the lookup assertions above and still loses half-written sections here.
    session.setDraft(second, wind);
    expect(session.getDraft(first)).toEqual(rain);
    expect(session.getDraft(second)).toEqual(wind);

    // Clearing is keyed too: a commit or a Revert in one workflow leaves the
    // other's draft alone.
    session.clear(second);
    expect(session.getDraft(second)).toBeNull();
    expect(session.getDraft(first)).toEqual(rain);
    session.clear(first);
    expect(session.getDraft(first)).toBeNull();
  });

  it("keeps each workflow's uncommitted sections across a switch", async () => {
    const { createComposerView, createComposerSession } = await loadPackage();
    const session = createComposerSession();
    const first = createGenerationHarness({
      prompt: "",
      classTypes: ["vloMiniMaxH3ReferenceToVideoBatch"],
      fingerprint: "workflow-a",
    });
    const second = createGenerationHarness({
      prompt: "",
      classTypes: ["vloMiniMaxH3ReferenceToVideoBatch"],
      fingerprint: "workflow-b",
    });

    // Half a sentence in A, then away to B — closing the composer unmounts it,
    // which is the whole reason the draft lives in the session.
    let view = mountComposer(createComposerView, session, first);
    type("Summary", "Half a thought about A");
    view.unmount();

    view = mountComposer(createComposerView, session, second);
    expect(textAreaFor("Summary").value).toBe("");
    type("Summary", "About B");
    // Committing in B must not take A's draft with it.
    click("Commit to prompt");
    view.unmount();

    view = mountComposer(createComposerView, session, first);
    expect(textAreaFor("Summary").value).toBe("Half a thought about A");
    view.unmount();
  });

  // 3A — the shell, driven.
  it("writes the sections back as one labelled prompt", async () => {
    const { createComposerView, createComposerSession, COMPOSE_TRANSACTION_LABEL } =
      await loadPackage();
    const harness = createGenerationHarness({
      prompt: "",
      classTypes: ["vloMiniMaxH3ReferenceToVideoBatch"],
    });
    const view = mountComposer(
      createComposerView,
      createComposerSession(),
      harness,
    );

    type("Subject definitions", "<Subject 1> is the person in <Picture 1>.");
    type("Overall soundscape", "Wind, then a roar.");
    click("Commit to prompt");

    // `non_diegetic_music` carries its authoring default: most generations
    // have no score, and the guide wants the field answered rather than absent.
    expect(harness.commits).toEqual([
      {
        label: COMPOSE_TRANSACTION_LABEL,
        value:
          "subject_definitions:\n<Subject 1> is the person in <Picture 1>.\n\noverall_soundscape:\nWind, then a roar.\n\nnon_diegetic_music:\nN/A",
      },
    ]);
    // Committing drops the draft, so what is on screen afterwards is the
    // committed prompt read back through the parser — the round trip, visible.
    expect(textAreaFor("Subject definitions").value).toBe(
      "<Subject 1> is the person in <Picture 1>.",
    );
    expect(textAreaFor("Summary").value).toBe("");
    view.unmount();
  });

  it("shows a prompt edited elsewhere, until something is typed", async () => {
    const { createComposerView, createComposerSession } = await loadPackage();
    const harness = createGenerationHarness({
      prompt: "summary:\nFrom the panel.",
      classTypes: ["vloMiniMaxH3ReferenceToVideoBatch"],
    });
    const view = mountComposer(
      createComposerView,
      createComposerSession(),
      harness,
    );

    expect(textAreaFor("Summary").value).toBe("From the panel.");
    act(() => harness.setText("summary:\nChanged in the panel."));
    // No draft yet, so the live prompt is the state: the panel is not a second
    // copy of it.
    expect(textAreaFor("Summary").value).toBe("Changed in the panel.");

    type("Summary", "Mine now.");
    act(() => harness.setText("summary:\nAnd changed again."));
    // Once there are uncommitted edits, they are not thrown away by a change
    // underneath. Reverting is the user's own gesture.
    expect(textAreaFor("Summary").value).toBe("Mine now.");
    click("Revert");
    expect(textAreaFor("Summary").value).toBe("And changed again.");
    view.unmount();
  });

  it("does not call the workflow's own skeleton an uncommitted edit", async () => {
    const { createComposerView, createComposerSession } = await loadPackage();
    // The shipped base-guide default: bare labels with no bodies. Committing
    // drops them, so the prompt *would* change — but the user has typed
    // nothing, and saying otherwise misattributes the change.
    const harness = createGenerationHarness({
      prompt: await shippedPrompt("vlo_minimax_h3_i2v"),
      classTypes: ["MiniMaxH3ImageToVideo"],
    });
    const view = mountComposer(
      createComposerView,
      createComposerSession(),
      harness,
    );

    expect(screen.queryByText("Uncommitted changes.")).toBeNull();
    expect(
      screen.getByText("Committing rewrites this prompt in guide form."),
    ).toBeTruthy();
    // Nothing to revert until something is typed.
    expect(
      screen.getAllByRole("button").map((element) => element.textContent),
    ).not.toContain("Revert");

    type("Overall soundscape", "Rain on a window.");
    expect(screen.getByText("Uncommitted changes.")).toBeTruthy();
    view.unmount();
  });

  it("carries a prompt it cannot split rather than restructuring it", async () => {
    const { createComposerView, createComposerSession, UNSTRUCTURED_REASON_TEXT } =
      await loadPackage();
    const freeform = "Bold comic-book ink style. Use <Picture 2> as a reference.";
    const harness = createGenerationHarness({
      prompt: freeform,
      classTypes: ["vloMiniMaxH3ReferenceToVideoBatch"],
    });
    const view = mountComposer(
      createComposerView,
      createComposerSession(),
      harness,
    );

    expect(screen.getByRole("alert").textContent).toBe(
      UNSTRUCTURED_REASON_TEXT["no-labels"],
    );
    // One box holding the whole prompt, and no section fields to restructure
    // it into.
    expect(textAreaFor("Prompt").value).toBe(freeform);
    expect(screen.queryByLabelText("Summary")).toBeNull();

    type("Prompt", `${freeform} And <Video 1>.`);
    click("Commit to prompt");
    expect(harness.commits[0].value).toBe(`${freeform} And <Video 1>.`);
    view.unmount();
  });

  it("says so rather than composing against a workflow with no guide", async () => {
    const { createComposerView, createComposerSession } = await loadPackage();
    const harness = createGenerationHarness({
      prompt: "anything",
      classTypes: ["KSampler"],
    });
    const view = mountComposer(
      createComposerView,
      createComposerSession(),
      harness,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "not a MiniMax H3 workflow",
    );
    expect(screen.queryByLabelText("Summary")).toBeNull();
    view.unmount();
  });

  // 3B — keyframe modes. The instruction strings come from MiniMax's
  // VIDEO_PROMPT_WRITING_GUIDE_base_en.md §2.1 and must match it character for
  // character, em dash included — with one deliberate deviation: the guide's
  // FL2VA line writes its tags bare, and we bracket them. See the reasoning on
  // `instructionLine`; a tag binds by literal string equality with the emitted
  // label (deep dive §2.1), so the bare form has nothing to bind to.
  it("writes the guide's instruction line for each keyframe combination", async () => {
    const { instructionLine } = await loadPackage();

    expect(
      instructionLine({ mode: "t2va", seconds: 5.17, finalShot: 1 }),
    ).toBeNull();

    expect(instructionLine({ mode: "i2va", seconds: 5.17, finalShot: 3 })).toBe(
      "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
    );

    // Bracketed, unlike the guide. Everything else in the sentence is the
    // guide's, so a change to the wording still fails here.
    expect(instructionLine({ mode: "fl2va", seconds: 8, finalShot: 4 })).toBe(
      "How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 0.00-second mark of the target video; <Picture 2> (from [Shot 4]) aligns with the 8.00-second mark of the target video.",
    );
    // The deviation is those brackets and nothing else: dropping them gives
    // the guide's line back, exactly.
    expect(
      instructionLine({ mode: "fl2va", seconds: 8, finalShot: 4 })!
        .replace(/<(Picture \d)>/g, "$1")
        .replace(/\[(Shot \d)\]/g, "$1"),
    ).toBe(
      "How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 4) aligns with the 8.00-second mark of the target video.",
    );

    // A last-frame-only run says <Picture 1>: `images` is built as
    // [first?, last?], so the only picture present takes ordinal 1.
    expect(
      instructionLine({ mode: "l2va", seconds: 5.166666666666667, finalShot: 1 }),
    ).toBe(
      "How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 5.17-second mark of the target video.",
    );
  });

  it("snaps the duration the way the node snaps it", async () => {
    const { alignFrameCount, effectiveDurationSeconds, formatDuration } =
      await loadPackage();

    // align_frame_count: the first n >= length with n % 17 == 5.
    expect(alignFrameCount(124)).toBe(124);
    expect(alignFrameCount(130)).toBe(141);
    expect(alignFrameCount(141)).toBe(141);
    expect(alignFrameCount(192)).toBe(192);
    // temporal_shape applies max(5, length) before snapping.
    expect(alignFrameCount(1)).toBe(5);

    // S.SS is the *effective* duration, so an off-grid length reports the
    // longer video the model will actually make.
    expect(formatDuration(effectiveDurationSeconds(124))).toBe("5.17");
    expect(formatDuration(effectiveDurationSeconds(130))).toBe("5.88");
    expect(formatDuration(effectiveDurationSeconds(192))).toBe("8.00");
    // Exactly two decimals, never one.
    expect(formatDuration(6)).toBe("6.00");
  });

  it("reads the final shot index from the description being written", async () => {
    const { finalShotIndex } = await loadPackage();
    // The guide's N is "the index of the actual final shot", which lives in
    // the authored description rather than anywhere the panel knows.
    expect(finalShotIndex("")).toBe(1);
    expect(finalShotIndex("A single unmarked shot.")).toBe(1);
    expect(
      finalShotIndex("[Shot 1] The boy looks up.\n[Shot 2] At 00:03.500, a roar."),
    ).toBe(2);
    // Out of order, and case-insensitive, because this is prose.
    expect(finalShotIndex("[Shot 3] Later.\n[shot 2] Before.")).toBe(3);
  });

  it("reads the keyframe slots from the panel, not from the graph", async () => {
    const { readKeyframeSlots, keyframeMode } = await loadPackage();
    const image = (
      label: string,
      filled: boolean,
      extra: Record<string, unknown> = {},
    ) => ({
      id: label,
      nodeId: "1",
      param: "image",
      label,
      inputType: "image",
      media: filled ? [{ slotId: "s", ordinal: 1 }] : [],
      ...extra,
    });

    // Both shipped vocabularies: i2v says Start/End, inpaint_flf2va says
    // First/Last.
    expect(
      readKeyframeSlots([image("Start frame", true), image("End frame", true)]),
    ).toEqual({ first: true, last: true, unresolved: [] });
    expect(
      readKeyframeSlots([image("First frame", true), image("Last frame", false)]),
    ).toEqual({ first: true, last: false, unresolved: [] });

    // A repeatable image input is a reference batch, not a keyframe.
    expect(
      readKeyframeSlots([
        image("Image inputs", true, { repeatable: { max: 9, optionIds: [] } }),
      ]),
    ).toEqual({ first: false, last: false, unresolved: [] });

    // A slot whose role the label does not settle is reported, not guessed.
    expect(readKeyframeSlots([image("Anchor", true)]).unresolved).toEqual([
      "Anchor",
    ]);

    expect(keyframeMode({ first: false, last: false })).toBe("t2va");
    expect(keyframeMode({ first: true, last: false })).toBe("i2va");
    expect(keyframeMode({ first: true, last: true })).toBe("fl2va");
    expect(keyframeMode({ first: false, last: true })).toBe("l2va");
  });

  it("declines to guess a duration it cannot read", async () => {
    const { readLengthFrames, deriveInstruction } = await loadPackage();
    const node = (widgets: unknown[]) => ({
      id: "136",
      classType: "MiniMaxH3ImageToVideo",
      title: "MiniMax",
      mode: 0,
      widgets,
    });
    const lengthWidget = (extra: Record<string, unknown>) => ({
      nodeId: "136",
      param: "length",
      valueType: "int",
      value: 124,
      defaultValue: 124,
      options: null,
      min: 22,
      max: 719,
      step: 17,
      linked: false,
      editable: true,
      ...extra,
    });

    expect(readLengthFrames([node([lengthWidget({})])])).toBe(124);
    // Fed by a connection, so it carries no readable value.
    expect(
      readLengthFrames([node([lengthWidget({ linked: true, value: null })])]),
    ).toBeNull();
    expect(readLengthFrames([])).toBeNull();

    const keyframe = {
      id: "142:image",
      nodeId: "142",
      param: "image",
      label: "End frame",
      inputType: "image",
      media: [{ slotId: "s", ordinal: 1 }],
    };
    // L2VA needs S.SS. With no duration it says nothing rather than inventing
    // a number and putting it in the prompt.
    const noDuration = deriveInstruction({
      inputs: [keyframe],
      nodes: [node([lengthWidget({ linked: true, value: null })])],
      description: "",
    });
    expect(noDuration.mode).toBe("l2va");
    expect(noDuration.line).toBeNull();

    // I2VA's line has no placeholders, so it survives the same gap.
    const firstFrameOnly = deriveInstruction({
      inputs: [{ ...keyframe, label: "Start frame" }],
      nodes: [node([lengthWidget({ linked: true, value: null })])],
      description: "",
    });
    expect(firstFrameOnly.line).toContain("is fully referenced.");

    // An unresolved slot suppresses the suggestion entirely: the mode decides
    // the whole line.
    const unresolved = deriveInstruction({
      inputs: [{ ...keyframe, label: "Anchor" }],
      nodes: [node([lengthWidget({})])],
      description: "",
    });
    expect(unresolved.unresolved).toEqual(["Anchor"]);
    expect(unresolved.line).toBeNull();
  });

  it("derives the instruction line and keeps it read-only until asked", async () => {
    const { createComposerView, createComposerSession } = await loadPackage();
    const harness = createGenerationHarness({
      prompt: "",
      classTypes: ["MiniMaxH3ImageToVideo"],
      keyframes: [
        { label: "Start frame", filled: true },
        { label: "End frame", filled: true },
      ],
      length: 124,
    });
    const view = mountComposer(
      createComposerView,
      createComposerSession(),
      harness,
    );

    // Derived from the panel with no gesture at all, and greyed: the value is
    // a pure function of which slots are filled and how long the video is.
    const instruction = () => textAreaFor("Instruction line");
    expect(instruction().disabled).toBe(true);
    expect(instruction().value).toBe(
      "How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 0.00-second mark of the target video; <Picture 2> (from [Shot 1]) aligns with the 5.17-second mark of the target video.",
    );
    expect(screen.getByText("FL2VA (start and end frames): matches the guide.")).toBeTruthy();

    // It tracks its inputs: the final shot index comes from the description
    // being written, so the line follows it without being re-applied.
    type("Integrated multimodal description", "[Shot 1] A push in.\n[Shot 2] A roar.");
    expect(instruction().value).toContain("(from [Shot 2]) aligns with the 5.17-second mark");

    // First line, then one blank line, then the core fields.
    click("Commit to prompt");
    expect(harness.commits[0].value).toBe(
      "How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 0.00-second mark of the target video; <Picture 2> (from [Shot 2]) aligns with the 5.17-second mark of the target video.\n\nintegrated_multimodal_description:\n[Shot 1] A push in.\n[Shot 2] A roar.\n\nnon_diegetic_music:\nN/A",
    );
    view.unmount();
  });

  it("rewrites the instruction line from a keyframe staged but not committed", async () => {
    const { createComposerView, createComposerSession } = await loadPackage();
    const harness = createGenerationHarness({
      prompt: "",
      classTypes: ["MiniMaxH3ImageToVideo"],
      keyframes: [{ label: "Start frame", filled: false }],
      length: 124,
    });
    const view = mountComposer(
      createComposerView,
      createComposerSession(),
      harness,
    );
    const instruction = () => textAreaFor("Instruction line");

    // Nothing attached: text-to-video takes no instruction.
    expect(instruction().value).toBe("");
    expect(
      screen.getByText("T2VA (no keyframes): the guide asks for no instruction line."),
    ).toBeTruthy();

    // Staged in the composer, *not* committed to the panel. The line describes
    // the keyframes, so it has to follow the ones on screen rather than the
    // ones the panel happens to hold.
    act(() => {
      harness.stage([
        {
          id: "141:image",
          nodeId: "141",
          param: "image",
          label: "Start frame",
          inputType: "image",
          media: [
            {
              slotId: "staged:1",
              ordinal: 0,
              source: "asset",
              assetId: "asset-k",
              displayName: "Start frame",
              mediaType: "image",
              hasAudio: false,
              options: {},
              preparing: false,
            },
          ],
        },
      ]);
      harness.setText("");
    });

    expect(instruction().value).toBe(
      "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
    );
    expect(screen.getByText("I2VA (start frame): matches the guide.")).toBeTruthy();

    // And it is what commits, in the same transaction as the staged keyframe.
    click("Commit to prompt");
    expect(harness.commits[0].value).toContain("is fully referenced.");
    view.unmount();
  });

  it("hands the instruction line over on Edit, and takes it back on Use derived", async () => {
    const { createComposerView, createComposerSession } = await loadPackage();
    const harness = createGenerationHarness({
      prompt: "",
      classTypes: ["MiniMaxH3ImageToVideo"],
      keyframes: [{ label: "Start frame", filled: true }],
      length: 124,
    });
    const view = mountComposer(
      createComposerView,
      createComposerSession(),
      harness,
    );
    const instruction = () => textAreaFor("Instruction line");

    click("Edit");
    // Handed over with the derived text in it, not emptied.
    expect(instruction().disabled).toBe(false);
    expect(instruction().value).toBe(
      "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
    );

    type("Instruction line", "My own wording.");
    expect(instruction().value).toBe("My own wording.");
    click("Commit to prompt");
    expect(harness.commits[0].value).toContain("My own wording.\n\n");

    // And back: the hand-written wording goes, the derivation resumes.
    click("Use derived");
    expect(instruction().disabled).toBe(true);
    expect(instruction().value).toBe(
      "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
    );
    view.unmount();
  });

  it("does not silently replace an instruction the prompt already carries", async () => {
    const { createComposerView, createComposerSession } = await loadPackage();
    const harness = createGenerationHarness({
      prompt:
        "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\noverall_soundscape:\nRain.",
      classTypes: ["MiniMaxH3ImageToVideo"],
      keyframes: [{ label: "Start frame", filled: false }],
      length: 124,
    });
    const view = mountComposer(
      createComposerView,
      createComposerSession(),
      harness,
    );
    const instruction = () => textAreaFor("Instruction line");

    // The keyframe was cleared in the panel, so the derivation says T2VA takes
    // no line — but that text is in the prompt, and authored text is never
    // dropped without being asked. It starts unlocked, showing what is there.
    expect(instruction().disabled).toBe(false);
    expect(instruction().value).toContain("is fully referenced.");
    expect(
      screen.getByText(
        "Edited by hand. T2VA (no keyframes): the guide asks for no instruction line.",
      ),
    ).toBeTruthy();

    click("Use derived");
    expect(instruction().value).toBe("");
    click("Commit to prompt");
    expect(harness.commits[0].value).toBe(
      "overall_soundscape:\nRain.\n\nnon_diegetic_music:\nN/A",
    );
    view.unmount();
  });

  it("fills non-diegetic music with N/A without touching what is written", async () => {
    const { createComposerView, createComposerSession, parsePrompt, REFERENCE_GUIDE } =
      await loadPackage();
    // The codec still reports the section as empty, because that is what the
    // prompt says; the default is an authoring convenience the view applies.
    expect(
      parsePrompt("", REFERENCE_GUIDE).sections.find(
        (section) => section.id === "non_diegetic_music",
      )?.text,
    ).toBe("");

    const harness = createGenerationHarness({
      prompt: "non_diegetic_music:\nSlow piano throughout.",
      classTypes: ["vloMiniMaxH3ReferenceToVideoBatch"],
    });
    const view = mountComposer(
      createComposerView,
      createComposerSession(),
      harness,
    );
    // A section that says something keeps saying it.
    expect(textAreaFor("Non-diegetic music").value).toBe("Slow piano throughout.");
    view.unmount();

    const empty = createGenerationHarness({
      prompt: "",
      classTypes: ["vloMiniMaxH3ReferenceToVideoBatch"],
    });
    const second = mountComposer(
      createComposerView,
      createComposerSession(),
      empty,
    );
    expect(textAreaFor("Non-diegetic music").value).toBe("N/A");
    second.unmount();
  });

  // 3B/wiring — which of the panel's inputs the composer offers to edit.
  it("offers the guide's own inputs to edit, never the prompt box", async () => {
    const { keyframeInputIds, referenceInputIds } = await loadPackage();
    const inputs = [
      { id: "136:prompt", inputType: "text", label: "Prompt" },
      { id: "141:image", inputType: "image", label: "Start frame" },
      { id: "142:image", inputType: "image", label: "End frame" },
      { id: "143:mask", inputType: "image", label: "Mask" },
      {
        id: "144:images",
        inputType: "image",
        label: "Image inputs",
        repeatable: { max: 9, optionIds: [] },
      },
      {
        id: "145:videos",
        inputType: "video",
        label: "Video inputs",
        repeatable: { max: 3, optionIds: ["audio"] },
      },
    ];

    // The base guide edits the keyframes: they are what the instruction line
    // is derived from. A single-slot image that is not a keyframe is not one.
    expect(keyframeInputIds(inputs)).toEqual(["141:image", "142:image"]);
    // The reference guide edits the reference lists, because the ordinals its
    // prose cites are positions in them.
    expect(referenceInputIds(inputs)).toEqual(["144:images", "145:videos"]);
    // Neither offers the prompt: the composer *is* the prompt's editor, and
    // showing the panel's box inside it would be two places to write one value.
    expect(keyframeInputIds(inputs)).not.toContain("136:prompt");
    expect(referenceInputIds(inputs)).not.toContain("136:prompt");
  });

  it("picks the prompt input rather than the first text input", async () => {
    const { promptInput } = await loadPackage();
    const session = {
      inputs: [
        { id: "a", param: "negative_prompt", inputType: "text" },
        { id: "b", param: "prompt", inputType: "text" },
        { id: "c", param: "images", inputType: "image" },
      ],
    };
    expect(promptInput(session)?.id).toBe("b");
    expect(promptInput({ inputs: [] })).toBeNull();
    expect(promptInput(null)).toBeNull();
  });
});
