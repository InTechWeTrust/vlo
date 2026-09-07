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
import { createMuiStubs } from "./minimaxHostStubs";
import type {
  LoadedPromptGuide,
  MinimaxPromptPackage,
} from "./minimaxPromptPackageLoader";

const EXTENSION_ID = "vlo.minimax-prompt";

/**
 * Phase 3A of docs/minimax-prompt-composer-extension-plan.md: the composer's
 * shell and its section model.
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
            widgets: [],
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

  return {
    commits,
    generation,
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

    expect(harness.commits).toEqual([
      {
        label: COMPOSE_TRANSACTION_LABEL,
        value:
          "subject_definitions:\n<Subject 1> is the person in <Picture 1>.\n\noverall_soundscape:\nWind, then a roar.",
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
