import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ExtensionGenerationInputsDraft,
  type ExtensionGenerationInputsDraftController,
} from "../ExtensionGenerationInputsDraft";
import {
  mountGenerationSession,
  type MountedGenerationSession,
} from "../../../../testUtils/generationSession";
import type { GenerationInputSnapshot } from "../../../generation/services/generationSessionTypes";

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
  mounted?.unmount();
  mounted = null;
});

/** Render the wrapper and capture the controller it hands package code. */
function mountDraft(): ExtensionGenerationInputsDraftController {
  let captured: ExtensionGenerationInputsDraftController | null = null;
  render(
    <ExtensionGenerationInputsDraft inputIds={["6:text"]}>
      {(controller) => {
        captured = controller;
        return null;
      }}
    </ExtensionGenerationInputsDraft>,
  );
  if (!captured) throw new Error("the draft did not render its children");
  return captured;
}

describe("ExtensionGenerationInputsDraft", () => {
  /**
   * The async-refusal contract crosses three layers, and each one can drop it:
   * the session inspects its callback's return value, the host controller
   * returns `additionalWrites`', and this wrapper returns the controller's. The
   * hook test covers the middle layer; this covers the extension-facing path
   * end to end, which is the one a package actually uses.
   */
  it("refuses an async additionalWrites without committing its early writes", () => {
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const controller = mountDraft();

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
    const controller = mountDraft();

    const outcome = controller.commit("Compose", (transaction) => {
      transaction.setTextInput("6:text", "after");
    });

    expect(outcome).toMatchObject({ ok: true, changed: true });
    expect(mounted.commit).toHaveBeenCalledTimes(1);
  });

  it("reports a bad write from the port as a failure, not a raw throw", () => {
    mounted = mountGenerationSession({ inputs: [TEXT_INPUT] });
    const controller = mountDraft();

    // The port bounds ids and values; a violation must roll the staged commit
    // back with a translated failure rather than escaping to package code.
    const outcome = controller.commit("Compose", (transaction) => {
      transaction.setTextInput("6:text", "x".repeat(1_000_001));
    });

    expect(outcome.ok).toBe(false);
    expect(mounted.commit).not.toHaveBeenCalled();
  });
});
