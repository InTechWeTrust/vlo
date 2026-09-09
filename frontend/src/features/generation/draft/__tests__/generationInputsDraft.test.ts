import { describe, expect, it, vi } from "vitest";
import {
  findDraftConflicts,
  projectDraftInputs,
  compileDraftCommands,
  type GenerationInputDraftOp,
} from "../generationInputsDraft";
import type {
  GenerationInputSnapshot,
  GenerationMediaItemSnapshot,
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
  media: [mediaItem("slot-a", "asset-a", 0), mediaItem("slot-b", "asset-b", 1)],
} as unknown as GenerationInputSnapshot;

const resolveAsset = (
  _input: GenerationInputSnapshot,
  assetId: string,
): GenerationMediaItemSnapshot =>
  ({
    slotId: "",
    ordinal: 0,
    source: "asset",
    assetId,
    displayName: `${assetId}.png`,
    mediaType: "image",
    hasAudio: false,
    options: {},
    preparing: false,
  }) as unknown as GenerationMediaItemSnapshot;

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
      { kind: "moveMedia", inputId: "142:images", fromOrdinal: 1, toOrdinal: 0 },
    ];
    const projected = projectDraftInputs(base, ops, resolveAsset);

    expect(projected[0].value).toBe("after");
    // A single-slot input replaces what it holds, as a drop on it would.
    expect(projected[1].media?.map((item) => item.assetId)).toEqual(["asset-k"]);
    expect(projected[2].media?.map((item) => item.assetId)).toEqual([
      "asset-b",
      "asset-a",
    ]);
    // Delivery positions, zero-based: what the panel publishes and what the
    // transaction accepts.
    expect(projected[2].media?.map((item) => item.ordinal)).toEqual([0, 1]);
    // The session itself is untouched: the panel has not been written.
    expect(base.inputs[0].value).toBe("before");
    expect(base.inputs[2].media?.map((item) => item.assetId)).toEqual([
      "asset-a",
      "asset-b",
    ]);
  });

  it("commits what the editor shows, not the gestures that produced it", () => {
    // The regression this compiler exists for: attach B over A, then clear B.
    // A gesture replay skips both commands and leaves A in the panel while the
    // editor shows an empty slot.
    const withA: GenerationInputSnapshot = {
      ...SINGLE_IMAGE,
      media: [mediaItem("slot-a", "asset-a", 0)],
    } as unknown as GenerationInputSnapshot;
    const base = session([withA]);
    const target = projectDraftInputs(
      base,
      [
        { kind: "attachAsset", inputId: "141:image", assetId: "asset-b" },
        { kind: "removeMedia", inputId: "141:image", slotId: "staged:1" },
      ],
      resolveAsset,
    );
    expect(target[0].media).toEqual([]);

    const { calls, transaction } = recordTransaction();
    compileDraftCommands(base.inputs, target, transaction);
    expect(calls).toEqual(["remove 141:image slot-a"]);
  });

  it("appends then reorders rather than attaching at a stale position", () => {
    const base = session([BATCH]);
    const target = projectDraftInputs(
      base,
      [
        { kind: "attachAsset", inputId: "142:images", assetId: "asset-k", at: 0 },
        { kind: "removeMedia", inputId: "142:images", slotId: "slot-a" },
      ],
      resolveAsset,
    );
    expect(target[0].media?.map((item) => item.assetId)).toEqual([
      "asset-k",
      "asset-b",
    ]);

    const { calls, transaction } = recordTransaction();
    compileDraftCommands(base.inputs, target, transaction);
    // Remove what is leaving, append what is new, then one reorder pass — a
    // positioned attach is an append plus a reorder anyway, and this keeps the
    // attach off the repack path.
    expect(calls).toEqual([
      "remove 142:images slot-a",
      "attach 142:images asset-k at=end opts={}",
      "move 142:images 1->0",
    ]);
  });

  it("carries an option set on staged media into its own attach", () => {
    const base = session([BATCH]);
    const target = projectDraftInputs(
      base,
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
      resolveAsset,
    );
    const { calls, transaction } = recordTransaction();
    compileDraftCommands(base.inputs, target, transaction);
    // A staged slot has no id the host has seen, so the option rides the
    // attach that creates it.
    expect(calls).toEqual([
      'attach 142:images asset-k at=end opts={"audio":true}',
    ]);
  });

  it("writes nothing when the projection matches the panel", () => {
    const base = session([TEXT_INPUT, BATCH]);
    const { calls, transaction } = recordTransaction();
    compileDraftCommands(base.inputs, base.inputs, transaction);
    expect(calls).toEqual([]);
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
      { ...BATCH, media: [mediaItem("slot-a", "asset-a", 0)] },
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

  /**
   * The invariant the compiler exists to hold: whatever the editor shows is
   * what the panel holds afterwards. Applies the compiled commands to a naive
   * model of the panel and compares, ignoring the staged-versus-real slot ids
   * that necessarily differ.
   */
  it.each([
    [
      "clearing a staged replacement",
      [
        { kind: "attachAsset", inputId: "142:images", assetId: "asset-k" },
        { kind: "removeMedia", inputId: "142:images", slotId: "staged:1" },
      ],
    ],
    [
      "inserting at the front and removing an original",
      [
        { kind: "attachAsset", inputId: "142:images", assetId: "asset-k", at: 0 },
        { kind: "removeMedia", inputId: "142:images", slotId: "slot-a" },
      ],
    ],
    [
      "reordering around a staged item",
      [
        { kind: "attachAsset", inputId: "142:images", assetId: "asset-k" },
        { kind: "moveMedia", inputId: "142:images", fromOrdinal: 2, toOrdinal: 0 },
        { kind: "moveMedia", inputId: "142:images", fromOrdinal: 2, toOrdinal: 1 },
      ],
    ],
    [
      "removing everything",
      [
        { kind: "removeMedia", inputId: "142:images", slotId: "slot-a" },
        { kind: "removeMedia", inputId: "142:images", slotId: "slot-b" },
      ],
    ],
  ] as [string, GenerationInputDraftOp[]][])(
    "commits a projection the panel then matches: %s",
    (_name, ops) => {
      const base = session([BATCH]);
      const target = projectDraftInputs(base, ops, resolveAsset);

      // A panel that applies the commands the way the real one does.
      let panel = (base.inputs[0].media ?? []).map((item) => ({ ...item }));
      let staged = 0;
      compileDraftCommands(base.inputs, target, {
        setTextInput: () => undefined,
        setWidget: () => undefined,
        attachAsset: (_inputId: string, assetId: string) => {
          staged += 1;
          panel.push({ ...mediaItem(`real-${staged}`, assetId, 0) });
        },
        removeMedia: (_inputId: string, slotId: string) => {
          panel = panel.filter((item) => item.slotId !== slotId);
        },
        moveMedia: (_inputId: string, from: number, to: number) => {
          const [moved] = panel.splice(from, 1);
          panel.splice(to, 0, moved);
        },
        setMediaOption: (slotId: string, optionId: string, value: boolean) => {
          panel = panel.map((item) =>
            item.slotId === slotId
              ? { ...item, options: { ...item.options, [optionId]: value } }
              : item,
          );
        },
      } as unknown as GenerationSessionTransaction);

      expect(panel.map((item) => item.assetId)).toEqual(
        (target[0].media ?? []).map((item) => item.assetId),
      );
    },
  );
});
