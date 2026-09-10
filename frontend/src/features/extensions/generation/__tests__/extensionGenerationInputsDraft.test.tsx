import { afterEach, describe, expect, it, vi } from "vitest";

import { createScopedInputsDraft } from "../extensionGenerationInputsDraft";
import {
  mountGenerationSession,
  type MountedGenerationSession,
} from "../../../../testUtils/generationSession";
import type { GenerationInputSnapshot } from "../../../generation/services/generationSessionTypes";
import type {
  ExtensionApiScope,
  ExtensionGenerationInputsDraft,
  ExtensionGenerationTransaction,
} from "../../types";

const TEXT_INPUT = {
  id: "6:text",
  nodeId: "6",
  param: "text",
  label: "Prompt",
  inputType: "text",
  value: "before",
} as unknown as GenerationInputSnapshot;

let mounted: MountedGenerationSession | null = null;

afterEach(() => {
  for (const resource of owned.splice(0)) resource.dispose();
  abort = null;
  mounted?.unmount();
  mounted = null;
});

let abort: AbortController | null = null;
const owned: { dispose(): void }[] = [];

function createScope(): ExtensionApiScope {
  abort = new AbortController();
  return {
    extension: { id: "example.draft", version: "1.0.0" },
    signal: abort.signal,
    own: (resource: { dispose(): void }) => {
      owned.push(resource);
      return resource;
    },
    report: vi.fn(),
  } as unknown as ExtensionApiScope;
}

/** Open a draft the way `api.generation.createInputsDraft` does. */
function openDraft(): ExtensionGenerationInputsDraft {
  const draft = createScopedInputsDraft(createScope(), {
    inputIds: ["6:text"],
  });
  if (!draft) throw new Error("the draft was refused");
  return draft;
}

describe("api.generation.createInputsDraft", () => {
  /**
   * The async-refusal contract crosses three layers, and each one can drop it:
   * the session inspects its callback's return value, the host controller
   * returns `additionalWrites`', and this wrapper returns the controller's. The
   * hook test covers the middle layer; this covers the extension-facing path
   * end to end, which is the one a package actually uses.
   */
  it("refuses an async additionalWrites without committing its early writes", () => {
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const controller = openDraft();

    // `(tx) => void` accepts an async function in TypeScript, so this is what a
    // package can hand over by accident.
    const outcome = controller.commit("Compose", (async (transaction: {
      setTextInput(inputId: string, value: string): void;
    }) => {
      transaction.setTextInput("6:text", "written before the await");
      await Promise.resolve();
    }) as unknown as Parameters<typeof controller.commit>[1]);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("invalid_command");
    // The pre-`await` write must not survive: a transaction either lands whole
    // or not at all.
    expect(mounted.commit).not.toHaveBeenCalled();
  });

  it("commits a synchronous additionalWrites through the extension port", () => {
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const controller = openDraft();

    const outcome = controller.commit(
      "Compose",
      (transaction: ExtensionGenerationTransaction) => {
        transaction.setTextInput("6:text", "after");
      },
    );

    expect(outcome).toMatchObject({ ok: true, changed: true });
    expect(mounted.commit).toHaveBeenCalledTimes(1);
  });

  it("bounds a staged text value exactly as a direct write does", () => {
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const controller = openDraft();

    // Staging compiles into the same `setTextInput` the port bounds, so a
    // limit enforced only on the direct path would let the draft show and
    // commit a value the direct write refuses.
    expect(() =>
      controller.stage({
        kind: "setText",
        inputId: "6:text",
        value: "x".repeat(1_000_001),
      }),
    ).toThrow(/at most/);
    expect(controller.getState().hasDraftChanges).toBe(false);
  });

  it("detaches a staged payload from the caller's object", () => {
    mounted = mountGenerationSession({
      inputs: [TEXT_INPUT],
      editableWidgets: [
        {
          target: { nodeId: "9", widget: "length" },
          valueType: "int",
          value: 48,
          options: null,
          min: 1,
          max: 240,
          trueValue: null,
          falseValue: null,
        },
      ],
    });
    const draft = createScopedInputsDraft(createScope(), {
      inputIds: ["6:text"],
      widgetTargets: [{ nodeId: "9", widget: "length" }],
    });
    if (!draft) throw new Error("the draft was refused");

    const payload = { frames: 96 };
    draft.stage({ kind: "setWidget", nodeId: "9", param: "length", value: payload });
    // Mutating what was handed over must not change what commits: nothing
    // notified, and nothing on screen would show it moved.
    payload.frames = 720;
    expect(draft.getState().widgetValues.get("9:length")).toEqual({ frames: 96 });
  });

  it("hands over a widget map the package cannot mutate", () => {
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const controller = openDraft();

    const values = controller.getState().widgetValues as unknown as Map<
      string,
      unknown
    >;
    // `ReadonlyMap` is a compile-time claim only, so the published map refuses
    // the write outright rather than letting a package change what the
    // renderer draws.
    expect(() => values.set("9:length", 999)).toThrow(/read-only/);
    expect(controller.getState().widgetValues.has("9:length")).toBe(false);
  });

  it("refuses to open a draft once the activation has ended", () => {
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const scope = createScope();
    abort?.abort();
    expect(createScopedInputsDraft(scope, { inputIds: ["6:text"] })).toBeNull();
  });

  it("refuses a write from a draft retained past its activation", () => {
    // The check `runtime.generationUi` could not have supported. A package can
    // hold a draft it opened, and nothing stops it calling `commit` after
    // deactivation — so the guard has to be on the write, not only on the open.
    // Aborted without disposing, which is exactly what a retained reference is.
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const controller = openDraft();
    controller.stage({ kind: "setText", inputId: "6:text", value: "staged" });
    expect(controller.getState().hasDraftChanges).toBe(true);

    abort?.abort();

    expect(controller.getState().canCommit).toBe(false);
    expect(
      controller.commit("Compose", (transaction) => {
        transaction.setTextInput("6:text", "after the activation ended");
      }),
    ).toMatchObject({ ok: false, code: "unavailable" });
    expect(mounted.commit).not.toHaveBeenCalled();

    // Staging is refused too, so a retained draft cannot keep accumulating
    // work that a later host bug might flush.
    controller.stage({ kind: "setText", inputId: "6:text", value: "more" });
    expect(controller.getState().inputs[0]?.value).not.toBe("more");
  });

  it("reports a bad write from the port as a failure, not a raw throw", () => {
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const controller = openDraft();

    // The port bounds ids and values; a violation must roll the staged commit
    // back with a translated failure rather than escaping to package code.
    const outcome = controller.commit(
      "Compose",
      (transaction: ExtensionGenerationTransaction) => {
        transaction.setTextInput("6:text", "x".repeat(1_000_001));
      },
    );

    expect(outcome.ok).toBe(false);
    expect(mounted.commit).not.toHaveBeenCalled();
  });
});
