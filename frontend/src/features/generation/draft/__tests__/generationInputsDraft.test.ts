import { describe, expect, it, vi } from "vitest";
import {
  findDraftConflicts,
  isStagedSlotId,
  projectDraftInputs,
  replayDraftOps,
  type GenerationInputDraftOp,
} from "../generationInputsDraft";
import type {
  GenerationInputSnapshot,
  GenerationSessionSnapshot,
  GenerationSessionTransaction,
} from "../../services/generationSessionTypes";

function mediaItem(slotId: string, assetId: string, ordinal: number) {
  return {
    slotId,
    ordinal,
    source: "asset" as const,
    assetId,
    displayName: `${assetId}.png`,
    mediaType: "image" as const,
    hasAudio: false,
    options: {},
    preparing: false,
  };
}

function session(
  inputs: readonly GenerationInputSnapshot[],
): GenerationSessionSnapshot {
  return {
    workflow: {
      sourceId: "w",
      instanceId: null,
      revision: 1,
      fingerprint: "fp",
      mode: "catalogue",
      nodes: [],
    },
    status: "ready",
    inputs,
    canSubmit: true,
    busy: false,
  } as unknown as GenerationSessionSnapshot;
}

const TEXT_INPUT: GenerationInputSnapshot = {
  id: "136:prompt",
  nodeId: "136",
  param: "prompt",
  label: "Prompt",
  inputType: "text",
  value: "before",
} as unknown as GenerationInputSnapshot;

const SINGLE_IMAGE: GenerationInputSnapshot = {
  id: "141:image",
  nodeId: "141",
  param: "image",
  label: "Start frame",
  inputType: "image",
  media: [],
} as unknown as GenerationInputSnapshot;

const BATCH: GenerationInputSnapshot = {
  id: "142:images",
  nodeId: "142",
  param: "images",
  label: "Image inputs",
  inputType: "image",
  repeatable: { max: 9, optionIds: [] },
  media: [mediaItem("slot-a", "asset-a", 1), mediaItem("slot-b", "asset-b", 2)],
} as unknown as GenerationInputSnapshot;

const resolveAsset = (assetId: string) => ({
  displayName: `${assetId}.png`,
  mediaType: "image" as const,
  hasAudio: false,
});

function recordTransaction() {
  const calls: string[] = [];
  const transaction = {
    setTextInput: (inputId: string, value: string) =>
      calls.push(`setText ${inputId} ${value}`),
    setWidget: () => calls.push("setWidget"),
    attachAsset: (
      inputId: string,
      assetId: string,
      options?: { at?: number; itemOptions?: Record<string, boolean> },
    ) =>
      calls.push(
        `attach ${inputId} ${assetId} at=${options?.at ?? "end"} opts=${JSON.stringify(options?.itemOptions ?? {})}`,
      ),
    moveMedia: (inputId: string, from: number, to: number) =>
      calls.push(`move ${inputId} ${from}->${to}`),
    removeMedia: (inputId: string, slotId: string) =>
      calls.push(`remove ${inputId} ${slotId}`),
    setMediaOption: (slotId: string, optionId: string, value: boolean) =>
      calls.push(`option ${slotId} ${optionId}=${value}`),
  } as unknown as GenerationSessionTransaction;
  return { calls, transaction };
}

describe("generation inputs draft", () => {
  it("projects staged edits without touching the session", () => {
    const base = session([TEXT_INPUT, SINGLE_IMAGE, BATCH]);
    const ops: GenerationInputDraftOp[] = [
      { kind: "setText", inputId: "136:prompt", value: "after" },
      { kind: "attachAsset", inputId: "141:image", assetId: "asset-k" },
      { kind: "moveMedia", inputId: "142:images", fromOrdinal: 2, toOrdinal: 1 },
    ];
    const projected = projectDraftInputs(base, ops, resolveAsset);

    expect(projected[0].value).toBe("after");
    // A single-slot input replaces what it holds, as a drop on it would.
    expect(projected[1].media?.map((item) => item.assetId)).toEqual(["asset-k"]);
    expect(projected[2].media?.map((item) => item.assetId)).toEqual([
      "asset-b",
      "asset-a",
    ]);
    // Ordinals are delivery positions, so they renumber with the list.
    expect(projected[2].media?.map((item) => item.ordinal)).toEqual([1, 2]);
    // The session itself is untouched: the panel has not been written.
    expect(base.inputs[0].value).toBe("before");
    expect(base.inputs[2].media?.map((item) => item.assetId)).toEqual([
      "asset-a",
      "asset-b",
    ]);
  });

  it("replays staged ops as transaction commands, in order", () => {
    const { calls, transaction } = recordTransaction();
    replayDraftOps(
      [
        { kind: "setText", inputId: "136:prompt", value: "after" },
        { kind: "removeMedia", inputId: "142:images", slotId: "slot-a" },
        {
          kind: "attachAsset",
          inputId: "142:images",
          assetId: "asset-k",
          at: 0,
        },
        { kind: "setMediaOption", inputId: "142:images", slotId: "slot-b", optionId: "audio", value: true },
      ],
      transaction,
    );

    expect(calls).toEqual([
      "setText 136:prompt after",
      "remove 142:images slot-a",
      "attach 142:images asset-k at=0 opts={}",
      "option slot-b audio=true",
    ]);
  });

  it("folds edits to staged media into the attach that created it", () => {
    const { calls, transaction } = recordTransaction();
    // A slot staged in this draft has no id the host has ever seen, so an
    // option set on it cannot be written by id — it rides the attach.
    replayDraftOps(
      [
        { kind: "attachAsset", inputId: "142:images", assetId: "asset-k" },
        {
          kind: "setMediaOption",
          inputId: "142:images",
          slotId: "staged:1",
          optionId: "audio",
          value: true,
        },
      ],
      transaction,
    );
    expect(calls).toEqual([
      'attach 142:images asset-k at=end opts={"audio":true}',
    ]);
  });

  it("writes nothing for media staged and then removed before commit", () => {
    const { calls, transaction } = recordTransaction();
    replayDraftOps(
      [
        { kind: "attachAsset", inputId: "142:images", assetId: "asset-k" },
        { kind: "removeMedia", inputId: "142:images", slotId: "staged:1" },
      ],
      transaction,
    );
    expect(calls).toEqual([]);
    expect(isStagedSlotId("staged:1")).toBe(true);
    expect(isStagedSlotId("slot-a")).toBe(false);
  });

  it("reports a conflict only on an input the draft is holding", () => {
    const base = [TEXT_INPUT, BATCH];
    const ops: GenerationInputDraftOp[] = [
      { kind: "setText", inputId: "136:prompt", value: "after" },
    ];

    // The panel republishes constantly; a change somewhere the draft is not
    // touching is not a disagreement.
    const elsewhere = [
      TEXT_INPUT,
      { ...BATCH, media: [mediaItem("slot-a", "asset-a", 1)] },
    ];
    expect(findDraftConflicts(base, elsewhere, ops)).toEqual([]);

    // A change to the drafted input is, and it is named rather than merged.
    const collided = [{ ...TEXT_INPUT, value: "typed in the panel" }, BATCH];
    expect(findDraftConflicts(base, collided, ops)).toEqual(["Prompt"]);
  });

  it("stages nothing for an unresolvable asset", () => {
    const base = session([SINGLE_IMAGE]);
    const projected = projectDraftInputs(
      base,
      [{ kind: "attachAsset", inputId: "141:image", assetId: "gone" }],
      vi.fn(() => null),
    );
    expect(projected[0].media).toEqual([]);
  });
});
