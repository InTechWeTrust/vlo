import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionGenerationApi } from "../../../extensions/generation/ExtensionGenerationBridge";
import type { ExtensionApiScope, ExtensionResource } from "../../../extensions";
import { generationTextInputClaims } from "../GenerationTextInputClaims";
import {
  createGenerationPublication,
  mountGenerationSession,
} from "../../../../testUtils/generationSession";

/**
 * The 1C seam (docs/minimax-prompt-composer-extension-plan.md §4).
 *
 * The registry is owner-neutral, so it is exercised on its own terms first and
 * then through the adapter, which is what adds activation ownership and the
 * public failure codes.
 */

function createScope(
  controller = new AbortController(),
): ExtensionApiScope & { readonly disposables: ExtensionResource[] } {
  const disposables: ExtensionResource[] = [];
  return {
    extension: { id: "example.composer", version: "1.0.0" },
    signal: controller.signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => {
      disposables.push(resource);
      return resource;
    },
    report: () => undefined,
    disposables,
  };
}

/** A prompt box aliased by its bare node id, as the panel publishes one. */
const TEXT_INPUT = {
  id: "6:text",
  nodeId: "6",
  param: "text",
  label: "Prompt",
  inputType: "text",
  value: "",
} as const;

describe("generation text-input claims", () => {
  let session: ReturnType<typeof mountGenerationSession>;

  beforeEach(() => {
    generationTextInputClaims.reset();
    session = mountGenerationSession({ inputs: [TEXT_INPUT] });
  });

  afterEach(() => {
    session.unmount();
    generationTextInputClaims.reset();
  });

  it("admits one claim per input and refuses the second", () => {
    const first = generationTextInputClaims.claim({
      inputId: "6:text",
      reason: "The composer owns this prompt.",
      ownerLabel: "example.composer",
    });
    expect(first.ok).toBe(true);
    expect(generationTextInputClaims.getClaim("6:text")?.reason).toBe(
      "The composer owns this prompt.",
    );

    const second = generationTextInputClaims.claim({
      inputId: "6:text",
      reason: "Someone else's turn.",
      ownerLabel: "example.other",
    });
    expect(second).toMatchObject({ ok: false, code: "input_already_claimed" });
    // The first claim still stands: a refused second must not displace it.
    expect(generationTextInputClaims.getClaim("6:text")?.ownerLabel).toBe(
      "example.composer",
    );
  });

  it("tells the holder when the user takes the input back", () => {
    const onRevoked = vi.fn();
    const claimed = generationTextInputClaims.claim({
      inputId: "6:text",
      reason: "Composed elsewhere.",
      ownerLabel: "example.composer",
      onRevoked,
    });

    generationTextInputClaims.revoke("6:text");
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(generationTextInputClaims.getClaim("6:text")).toBeNull();

    // Releasing a revoked claim is a no-op, not a second revocation, and must
    // not drop a claim taken over the same input in the meantime.
    generationTextInputClaims.claim({
      inputId: "6:text",
      reason: "Now mine.",
      ownerLabel: "example.other",
    });
    if (claimed.ok) claimed.registration.release();
    expect(generationTextInputClaims.getClaim("6:text")?.ownerLabel).toBe(
      "example.other",
    );
  });

  it("resolves the alias id a write to the same input would take", () => {
    const api = createExtensionGenerationApi(createScope());
    // The publication's text input is `6:text`, aliased by its bare node id.
    const claimed = api.claimTextInput("6", {
      reason: "The composer owns this prompt.",
    });
    expect(claimed.ok).toBe(true);
    expect(generationTextInputClaims.getClaim("6:text")).not.toBeNull();
  });

  it("refuses a media input and an unknown one", () => {
    const api = createExtensionGenerationApi(createScope());
    session.publish(
      createGenerationPublication({
        inputs: [
          {
            id: "10:image",
            nodeId: "10",
            param: "image",
            label: "Image",
            inputType: "image",
            media: [],
          },
        ],
      }),
    );

    expect(api.claimTextInput("10:image", { reason: "Mine." })).toMatchObject({
      ok: false,
      code: "input_type_mismatch",
    });
    expect(api.claimTextInput("nope", { reason: "Mine." })).toMatchObject({
      ok: false,
      code: "input_not_found",
    });
    expect(api.claimTextInput("10:image", { reason: "  " })).toMatchObject({
      ok: false,
      code: "invalid_reason",
    });
  });

  it("gives the claim to the activation, so it cannot outlive it", () => {
    const scope = createScope();
    const api = createExtensionGenerationApi(scope);
    const claimed = api.claimTextInput("6:text", { reason: "Composed." });
    expect(claimed.ok).toBe(true);

    // What `own` collected is what the host disposes when activation ends.
    expect(scope.disposables).toHaveLength(1);
    for (const resource of scope.disposables) {
      (resource as { dispose: () => void }).dispose();
    }
    expect(generationTextInputClaims.getClaim("6:text")).toBeNull();
  });
});
