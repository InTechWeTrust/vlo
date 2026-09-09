import { describe, expect, it } from "vitest";
import { createExtensionTransactionPort } from "../extensionGenerationTransactionPort";
import type { GenerationSessionTransaction } from "../../../generation/services/generationSessionTypes";

function nativeTransaction() {
  const calls: string[] = [];
  const session = {
    setTextInput: (inputId: string, value: string) =>
      calls.push(`setText ${inputId} ${value}`),
    setWidget: () => calls.push("setWidget"),
    attachAsset: (inputId: string, assetId: string) =>
      calls.push(`attach ${inputId} ${assetId}`),
    moveMedia: (inputId: string, from: number, to: number) =>
      calls.push(`move ${inputId} ${from}->${to}`),
    removeMedia: (inputId: string, slotId: string) =>
      calls.push(`remove ${inputId} ${slotId}`),
    setMediaOption: (slotId: string, optionId: string, value: boolean) =>
      calls.push(`option ${slotId} ${optionId}=${value}`),
  } as unknown as GenerationSessionTransaction;
  return { calls, session };
}

/**
 * The port is what every extension write crosses — `api.generation.transaction`
 * and the staged editor's `additionalWrites` both build it. Its job is to
 * refuse before the store sees anything, so a bad write rolls the batch back
 * rather than half-applying it.
 */
describe("extension generation transaction port", () => {
  it("passes a valid write through to the session", () => {
    const { calls, session } = nativeTransaction();
    const port = createExtensionTransactionPort(session);
    port.setTextInput("136:prompt", "a prompt");
    port.attachAsset("142:images", "asset-a");
    expect(calls).toEqual([
      "setText 136:prompt a prompt",
      "attach 142:images asset-a",
    ]);
  });

  it("refuses malformed ids and values before the session sees them", () => {
    const { calls, session } = nativeTransaction();
    const port = createExtensionTransactionPort(session);

    // TypeScript does not constrain what a package actually passes.
    expect(() => port.setTextInput("", "value")).toThrow();
    expect(() =>
      port.setTextInput("136:prompt", 42 as unknown as string),
    ).toThrow();
    expect(() => port.attachAsset("142:images", "")).toThrow();
    expect(() =>
      port.setMediaOption("slot-a", "audio", "yes" as unknown as boolean),
    ).toThrow();

    // Nothing reached the store, so the transaction rolls back whole.
    expect(calls).toEqual([]);
  });

  it("bounds an oversize text value rather than handing it on", () => {
    const { calls, session } = nativeTransaction();
    const port = createExtensionTransactionPort(session);
    expect(() =>
      port.setTextInput("136:prompt", "x".repeat(1_000_001)),
    ).toThrow();
    expect(calls).toEqual([]);
  });
});

/*
 * Not covered here: that `ExtensionGenerationInputsDraft` actually hands this
 * port to `additionalWrites`. It holds by construction — the wrapper imports
 * this module and nothing else builds a transaction — but asserting it needs a
 * mounted generation session, so it belongs with the composer wiring rather
 * than a source-shape check that would pass for the wrong reasons.
 */
