import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useGenerationInputsDraft } from "../useGenerationInputsDraft";
import { createGenerationInputsDraft } from "../generationInputsDraftController";
import { useAssetStore } from "../../../userAssets";
import {
  mountGenerationSession,
  type MountedGenerationSession,
} from "../../../../testUtils/generationSession";
import type {
  GenerationEditableWidgetSnapshot,
  GenerationInputSnapshot,
} from "../../services/generationSessionTypes";

const TEXT_INPUT = {
  id: "6:text",
  nodeId: "6",
  param: "text",
  label: "Prompt",
  inputType: "text",
  value: "before",
} as unknown as GenerationInputSnapshot;

const OTHER_TEXT_INPUT = {
  ...TEXT_INPUT,
  id: "7:text",
  nodeId: "7",
  label: "Negative",
} as unknown as GenerationInputSnapshot;

const LENGTH_TARGET = { nodeId: "9", param: "length" };

const IMAGE_A = {
  id: "141:image",
  nodeId: "141",
  param: "image",
  label: "Start frame",
  inputType: "image",
  media: [],
} as unknown as GenerationInputSnapshot;

const IMAGE_B = {
  ...IMAGE_A,
  id: "142:image",
  nodeId: "142",
  label: "End frame",
} as unknown as GenerationInputSnapshot;

function libraryAsset(id: string) {
  return { id, name: `${id}.png`, type: "image", hasAudio: false };
}

/**
 * The panel's live widget value.
 *
 * `editableWidgets`, not `workflow.nodes`: the panel derives this from its own
 * widget state, so it moves the moment the user touches a control, while the
 * node catalogue only rebuilds when the synced workflow does. A test that
 * moved the catalogue instead would be exercising a collection a panel edit
 * never touches — and would pass while the real edit went unnoticed.
 */
function lengthWidget(value: number): GenerationEditableWidgetSnapshot {
  return {
    target: { nodeId: "9", widget: "length" },
    valueType: "int",
    value,
    options: null,
    min: 1,
    max: 240,
    trueValue: null,
    falseValue: null,
  } as unknown as GenerationEditableWidgetSnapshot;
}

let mounted: MountedGenerationSession | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  useAssetStore.setState({ assets: [] as never });
});

describe("useGenerationInputsDraft lifetime", () => {
  it("survives StrictMode's setup-cleanup-setup replay", () => {
    // The app mounts under root `React.StrictMode`, which runs an effect's
    // setup, cleanup, then setup again. A controller created outside an effect
    // is disposed by that first cleanup and never replaced — staging silently
    // does nothing and `canCommit` stays false for the component's whole life.
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const { result } = renderHook(() => useGenerationInputsDraft(["6:text"]), {
      wrapper: StrictMode,
    });

    act(() => {
      result.current.stage({
        kind: "setText",
        inputId: "6:text",
        value: "drafted",
      });
    });

    expect(result.current.hasDraftChanges).toBe(true);
    expect(result.current.canCommit).toBe(true);
    expect(result.current.inputs[0]?.value).toBe("drafted");
    expect(result.current.commit("Compose").ok).toBe(true);
  });


  it("discards a draft when the workflow changes, and does not resurrect it", () => {
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const { result } = renderHook(() => useGenerationInputsDraft(["6:text"]));

    act(() => {
      result.current.stage({
        kind: "setText",
        inputId: "6:text",
        value: "drafted",
      });
    });
    expect(result.current.hasDraftChanges).toBe(true);

    // A different workflow: the staged edit addressed inputs that are gone.
    act(() => {
      mounted?.publish({
        fingerprint: "fingerprint-2",
        inputs: [TEXT_INPUT],
      });
    });
    expect(result.current.hasDraftChanges).toBe(false);

    // Back to the first workflow. `workflow.revision` is monotonic, so this is
    // a *third* revision rather than a return to the first, and the discarded
    // draft cannot come back with it.
    act(() => {
      mounted?.publish({
        fingerprint: "fingerprint-1",
        inputs: [TEXT_INPUT],
      });
    });
    expect(result.current.hasDraftChanges).toBe(false);
  });

  it("keeps a draft across an ordinary republish of the same workflow", () => {
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const { result } = renderHook(() => useGenerationInputsDraft(["6:text"]));

    act(() => {
      result.current.stage({
        kind: "setText",
        inputId: "6:text",
        value: "drafted",
      });
    });
    // Another input changing is not this draft's business — the panel
    // republishes for every keystroke elsewhere.
    act(() => {
      mounted?.publish({
        inputs: [
          TEXT_INPUT,
          {
            ...TEXT_INPUT,
            id: "7:text",
            nodeId: "7",
            value: "elsewhere",
          } as unknown as GenerationInputSnapshot,
        ],
      });
    });
    expect(result.current.hasDraftChanges).toBe(true);
    expect(result.current.hasConflict).toBe(false);
  });
});

describe("createGenerationInputsDraft addressing", () => {
  it("hides an edit it no longer addresses, and never writes it", () => {
    mounted = mountGenerationSession({
      inputs: [TEXT_INPUT, OTHER_TEXT_INPUT],
    });
    const draft = createGenerationInputsDraft({ inputIds: ["6:text"] });

    draft.stage({ kind: "setText", inputId: "6:text", value: "drafted" });
    expect(draft.getSnapshot().hasDraftChanges).toBe(true);

    // Re-pointed at a different input. `commit` used to compile every op it
    // held, so the hidden edit was still written; the log is now narrowed at
    // the boundaries instead of being deleted.
    draft.address({ inputIds: ["7:text"] });
    expect(draft.getSnapshot().hasDraftChanges).toBe(false);
    expect(draft.commit("Compose")).toMatchObject({ ok: true, changed: false });
    expect(mounted.commit).not.toHaveBeenCalled();

    // Deleting the ops would be the other way to stop the write, and it loses
    // work the user staged: re-addressing brings the edit back.
    draft.address({ inputIds: ["6:text"] });
    expect(draft.getSnapshot().hasDraftChanges).toBe(true);
    expect(draft.getSnapshot().inputs[0]?.value).toBe("drafted");
    draft.dispose();
  });

  it("keeps staged slot ids stable when the addressed set narrows", () => {
    // Staged slot ids are built from an op's position in the log, so *deleting*
    // ops on narrowing renumbers the survivors: filtering
    // `[attach A, attach B, remove B's staged]` down to B's ops moved
    // `attach B` to index 0, the removal stopped matching it, and the
    // attachment the user had cleared came back.
    useAssetStore.setState({ assets: [libraryAsset("asset-k")] as never });
    mounted = mountGenerationSession({ inputs: [IMAGE_A, IMAGE_B] });
    const draft = createGenerationInputsDraft({
      inputIds: ["141:image", "142:image"],
    });

    draft.stage({ kind: "attachAsset", inputId: "141:image", assetId: "asset-k" });
    draft.stage({ kind: "attachAsset", inputId: "142:image", assetId: "asset-k" });
    const stagedOnB = draft
      .getSnapshot()
      .inputs.find((input) => input.id === "142:image")?.media?.[0]?.slotId;
    expect(stagedOnB).toBeDefined();
    draft.stage({
      kind: "removeMedia",
      inputId: "142:image",
      slotId: stagedOnB as string,
    });

    const mediaOnB = () =>
      draft.getSnapshot().inputs.find((input) => input.id === "142:image")
        ?.media ?? [];
    expect(mediaOnB()).toHaveLength(0);

    draft.address({ inputIds: ["142:image"] });
    expect(mediaOnB()).toHaveLength(0);
    draft.dispose();
  });

  it("refuses to stage without a mounted panel", () => {
    // A `null` workflow revision is indistinguishable from "nothing staged
    // yet", so an op recorded now would sit invisible and then apply itself to
    // whatever workflow mounts next.
    const draft = createGenerationInputsDraft({ inputIds: ["6:text"] });
    draft.stage({ kind: "setText", inputId: "6:text", value: "drafted" });
    expect(draft.getSnapshot().hasDraftChanges).toBe(false);

    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    expect(draft.getSnapshot().hasDraftChanges).toBe(false);
    expect(draft.commit("Compose")).toMatchObject({ ok: true, changed: false });
    expect(mounted.commit).not.toHaveBeenCalled();
    draft.dispose();
  });
});

describe("useGenerationInputsDraft commit", () => {
  it("re-checks conflicts against the snapshot it is writing", () => {
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const { result } = renderHook(() => useGenerationInputsDraft(["6:text"]));

    act(() => {
      result.current.stage({
        kind: "setText",
        inputId: "6:text",
        value: "drafted",
      });
    });
    expect(result.current.hasConflict).toBe(false);

    // Published *without* letting React re-render, so the controller in hand
    // still carries the render's "no conflict" reading. A commit that trusted
    // it would overwrite the panel edit that just landed.
    mounted.publish({
      inputs: [
        { ...TEXT_INPUT, value: "typed in the panel" } as GenerationInputSnapshot,
      ],
    });

    const outcome = result.current.commit("Compose");
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain(
      "changed in the panel",
    );
    expect(mounted.commit).not.toHaveBeenCalled();
  });

  it("refuses when the workflow changed under the commit", () => {
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const { result } = renderHook(() => useGenerationInputsDraft(["6:text"]));

    act(() => {
      result.current.stage({
        kind: "setText",
        inputId: "6:text",
        value: "drafted",
      });
    });
    mounted.publish({ fingerprint: "fingerprint-9", inputs: [TEXT_INPUT] });

    expect(result.current.commit("Compose")).toMatchObject({
      ok: false,
      code: "workflow_changed",
    });
    expect(mounted.commit).not.toHaveBeenCalled();
  });

  it("refuses an async additionalWrites instead of committing half of it", () => {
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const { result } = renderHook(() => useGenerationInputsDraft(["6:text"]));

    // Typed `=> void`, which TypeScript lets an async function satisfy. The
    // session refuses a promise-returning callback, but only if the value
    // travels back out through the controller.
    const outcome = result.current.commit("Compose", (async (
      transaction: { setTextInput(id: string, value: string): void },
    ) => {
      transaction.setTextInput("6:text", "written before the await");
      await Promise.resolve();
    }) as unknown as Parameters<typeof result.current.commit>[1]);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain("synchronous");
    expect(mounted.commit).not.toHaveBeenCalled();
  });

  it("reports a staged widget the panel changed underneath", () => {
    mounted = mountGenerationSession({
      inputs: [TEXT_INPUT],
      editableWidgets: [lengthWidget(48)],
    });
    const { result } = renderHook(() =>
      useGenerationInputsDraft(["6:text"], [LENGTH_TARGET]),
    );

    act(() => {
      result.current.stage({
        kind: "setWidget",
        nodeId: "9",
        param: "length",
        value: 96,
      });
    });
    expect(result.current.widgetValues.get("9:length")).toBe(96);
    expect(result.current.hasConflict).toBe(false);

    // The user picks a different length in the panel. Staged widgets are
    // written unconditionally, so this has to be reported rather than silently
    // overwritten.
    act(() => {
      // The catalogue deliberately stays empty throughout: a panel widget edit
      // never touches it, so a conflict check reading it would see nothing.
      mounted?.publish({
        inputs: [TEXT_INPUT],
        editableWidgets: [lengthWidget(120)],
      });
    });

    expect(result.current.hasConflict).toBe(true);
    expect(result.current.error).toContain("length");
    expect(result.current.commit("Compose").ok).toBe(false);
    expect(mounted.commit).not.toHaveBeenCalled();
  });
});
