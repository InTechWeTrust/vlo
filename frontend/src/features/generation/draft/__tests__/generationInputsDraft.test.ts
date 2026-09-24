import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findDraftConflicts,
  findDraftWidgetConflicts,
  projectDraftInputs,
  compileDraftCommands,
  type GenerationInputDraftOp,
} from "../generationInputsDraft";
import { generationSessionService } from "../../services/GenerationSessionService";
import { simulateAttachedItem } from "../../services/generationSessionValidation";
import { buildRepeatableInputSlotId } from "../../utils/workflowInputs";
import {
  mountGenerationSession,
  type MountedGenerationSession,
} from "../../../../testUtils/generationSession";
import type {
  GenerationInputSnapshot,
  GenerationSessionAssetCandidate,
  GenerationSessionSnapshot,
  GenerationSessionTransaction,
  GenerationTransactionResult,
} from "../../services/generationSessionTypes";

/**
 * Slot ids are built the way the host builds them, never invented.
 *
 * `buildRepeatableInputSlotId` derives a repeatable slot id from its *index*
 * (`142:images`, then `142:images::repeat::1`), and the host renumbers the
 * whole batch on every remove and move. A fixture using stable labels like
 * `"slot-a"` describes a host that does not exist and cannot see any bug that
 * depends on renumbering — see docs/staged-generation-editor-plan.md §2.4.
 */
const BATCH_KEY = { id: "142:images", nodeId: "142", param: "images" };
const CLIPS_KEY = { id: "143:clips", nodeId: "143", param: "clips" };

const batchSlot = (index: number) => buildRepeatableInputSlotId(BATCH_KEY, index);
/**
 * A staged item's slot id, which is built from the op's index in the draft log
 * — not a count of attaches, so a skipped op cannot shift the ones after it.
 * Real surfaces read this off the projection; only tests construct it.
 */
const stagedSlot = (opIndex: number) => `staged:${opIndex}`;
const clipSlot = (index: number) => buildRepeatableInputSlotId(CLIPS_KEY, index);

function imageAsset(id: string): GenerationSessionAssetCandidate {
  return {
    id,
    name: `${id}.png`,
    type: "image",
    file: null,
    src: `/library/${id}.png`,
    hasAudio: false,
  } as unknown as GenerationSessionAssetCandidate;
}

function videoAsset(id: string): GenerationSessionAssetCandidate {
  return {
    id,
    name: `${id}.mp4`,
    type: "video",
    file: null,
    src: `/library/${id}.mp4`,
    hasAudio: true,
  } as unknown as GenerationSessionAssetCandidate;
}

function mediaItem(slotId: string, assetId: string, ordinal: number) {
  return {
    slotId,
    itemId: `item-${assetId}`,
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

function clipItem(slotId: string, assetId: string, ordinal: number) {
  return {
    slotId,
    itemId: `item-${assetId}`,
    ordinal,
    source: "asset" as const,
    assetId,
    displayName: `${assetId}.mp4`,
    mediaType: "video" as const,
    hasAudio: true,
    options: { audio: false },
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
  ...BATCH_KEY,
  label: "Image inputs",
  inputType: "image",
  repeatable: { max: 9, optionIds: [] },
  media: [
    mediaItem(batchSlot(0), "asset-a", 0),
    mediaItem(batchSlot(1), "asset-b", 1),
  ],
} as unknown as GenerationInputSnapshot;

/** Three items, so a second removal has somewhere wrong to land. */
const BATCH_OF_THREE: GenerationInputSnapshot = {
  ...BATCH,
  media: [
    mediaItem(batchSlot(0), "asset-a", 0),
    mediaItem(batchSlot(1), "asset-b", 1),
    mediaItem(batchSlot(2), "asset-c", 2),
  ],
} as unknown as GenerationInputSnapshot;

/** A video batch that offers the per-item audio switch. */
const CLIPS: GenerationInputSnapshot = {
  ...CLIPS_KEY,
  label: "Clips",
  inputType: "video",
  repeatable: { max: 9, optionIds: ["audio"] },
  media: [
    clipItem(clipSlot(0), "clip-a", 0),
    clipItem(clipSlot(1), "clip-b", 1),
    clipItem(clipSlot(2), "clip-c", 2),
  ],
} as unknown as GenerationInputSnapshot;

const LIBRARY = new Map<string, GenerationSessionAssetCandidate>([
  ["asset-a", imageAsset("asset-a")],
  ["asset-b", imageAsset("asset-b")],
  ["asset-c", imageAsset("asset-c")],
  ["asset-k", imageAsset("asset-k")],
  ["clip-a", videoAsset("clip-a")],
  ["clip-b", videoAsset("clip-b")],
  ["clip-c", videoAsset("clip-c")],
]);

/** The host's own attach derivation, as `useGenerationInputsDraft` uses it. */
const resolveAsset = (
  input: GenerationInputSnapshot,
  assetId: string,
  replaced: Parameters<typeof simulateAttachedItem>[2],
) => {
  const asset = LIBRARY.get(assetId);
  return asset ? simulateAttachedItem(input, asset, replaced) : null;
};

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

let mounted: MountedGenerationSession | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/**
 * Stage `ops`, compile them, and commit through the **real** session.
 *
 * Nothing here models the panel: the transaction validates and sequences the
 * commands itself, and `panelInputs()` folds the resulting commit back through
 * the host's own apply. What comes out is what the panel would really hold.
 */
function commitDraft(
  inputs: readonly GenerationInputSnapshot[],
  ops: readonly GenerationInputDraftOp[],
): {
  readonly target: readonly GenerationInputSnapshot[];
  readonly result: GenerationTransactionResult;
  readonly panel: readonly GenerationInputSnapshot[];
} {
  mounted = mountGenerationSession({ inputs });
  for (const [id, asset] of LIBRARY) mounted.assets.set(id, asset);

  const snapshot = generationSessionService.getSnapshot();
  if (!snapshot) throw new Error("the session did not mount");
  const target = projectDraftInputs(snapshot, ops, resolveAsset);
  const result = generationSessionService.transaction("draft", (transaction) => {
    compileDraftCommands(snapshot.inputs, target, transaction);
  });
  return { target, result, panel: mounted.panelInputs() };
}

const assetIds = (inputs: readonly GenerationInputSnapshot[], index = 0) =>
  (inputs[index].media ?? []).map((item) => item.assetId);

const audioFlags = (inputs: readonly GenerationInputSnapshot[], index = 0) =>
  (inputs[index].media ?? []).map((item) => item.options.audio === true);

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
      media: [mediaItem("141:image", "asset-a", 0)],
    } as unknown as GenerationInputSnapshot;
    const base = session([withA]);
    const target = projectDraftInputs(
      base,
      [
        { kind: "attachAsset", inputId: "141:image", assetId: "asset-b" },
        { kind: "removeMedia", inputId: "141:image", slotId: stagedSlot(0) },
      ],
      resolveAsset,
    );
    expect(target[0].media).toEqual([]);

    const { calls, transaction } = recordTransaction();
    compileDraftCommands(base.inputs, target, transaction);
    expect(calls).toEqual(["remove 141:image 141:image"]);
  });

  it("appends then reorders rather than attaching at a stale position", () => {
    const base = session([BATCH]);
    const target = projectDraftInputs(
      base,
      [
        { kind: "attachAsset", inputId: "142:images", assetId: "asset-k" },
        { kind: "moveMedia", inputId: "142:images", fromOrdinal: 2, toOrdinal: 0 },
        { kind: "removeMedia", inputId: "142:images", slotId: batchSlot(0) },
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
      `remove 142:images ${batchSlot(0)}`,
      "attach 142:images asset-k at=end opts={}",
      "move 142:images 1->0",
    ]);
  });

  it("carries an option set on staged media into its own attach", () => {
    const base = session([CLIPS]);
    const target = projectDraftInputs(
      base,
      [
        { kind: "attachAsset", inputId: "143:clips", assetId: "clip-a" },
        {
          kind: "setMediaOption",
          inputId: "143:clips",
          slotId: stagedSlot(0),
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
    expect(calls).toEqual(['attach 143:clips clip-a at=end opts={"audio":true}']);
  });

  it("writes nothing when the projection matches the panel", () => {
    const base = session([TEXT_INPUT, BATCH]);
    const { calls, transaction } = recordTransaction();
    compileDraftCommands(base.inputs, base.inputs, transaction);
    expect(calls).toEqual([]);
  });

  it("allows thumbnail hydration while media changes remain staged", () => {
    const hydrated = { ...BATCH, media: BATCH.media!.map((item) => ({ ...item, thumbnail: "blob:new-preview" })) };
    const ops: GenerationInputDraftOp[] = [{ kind: "moveMedia", inputId: BATCH.id, fromOrdinal: 0, toOrdinal: 1 }];
    expect(findDraftConflicts([BATCH], [hydrated], ops)).toEqual([]);
    const replaced = { ...hydrated, media: hydrated.media.map((item) => ({ ...item, itemId: "replacement" })) };
    expect(findDraftConflicts([BATCH], [replaced], ops)).toEqual([BATCH.label]);
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
      { ...BATCH, media: [mediaItem(batchSlot(0), "asset-a", 0)] },
    ];
    expect(findDraftConflicts(base, elsewhere, ops)).toEqual([]);

    // A change to the drafted input is, and it is named rather than merged.
    const collided = [{ ...TEXT_INPUT, value: "typed in the panel" }, BATCH];
    expect(findDraftConflicts(base, collided, ops)).toEqual(["Prompt"]);
  });

  it("overwrites the tile a replace names, rather than inserting before it", () => {
    const base = session([BATCH]);
    const projected = projectDraftInputs(
      base,
      [
        {
          kind: "replaceMedia",
          inputId: "142:images",
          assetId: "asset-k",
          at: 0,
        },
      ],
      resolveAsset,
    );
    // Dropping onto an occupied tile replaces it. Inserting would push the tile
    // the user aimed at along and grow the batch.
    expect(projected[0].media?.map((item) => item.assetId)).toEqual([
      "asset-k",
      "asset-b",
    ]);
  });

  it("stages nothing for a replace onto an empty position", () => {
    const base = session([BATCH]);
    const projected = projectDraftInputs(
      base,
      [
        {
          kind: "replaceMedia",
          inputId: "142:images",
          assetId: "asset-k",
          at: 5,
        },
      ],
      resolveAsset,
    );
    expect(projected[0].media?.map((item) => item.assetId)).toEqual([
      "asset-a",
      "asset-b",
    ]);
  });

  it("refuses an append past the batch's capacity", () => {
    // A projection that overfills shows the user an item the transaction will
    // refuse, leaving a draft that cannot be committed at all.
    const full = {
      ...BATCH,
      repeatable: { max: 2, optionIds: [] },
    } as unknown as GenerationInputSnapshot;
    const projected = projectDraftInputs(
      session([full]),
      [{ kind: "attachAsset", inputId: "142:images", assetId: "asset-k" }],
      resolveAsset,
    );
    expect(projected[0].media?.map((item) => item.assetId)).toEqual([
      "asset-a",
      "asset-b",
    ]);
  });

  it("counts reserved slots against capacity", () => {
    // A slot held open for a render in flight is taken, as `findFreeSlotId`
    // treats it.
    const reserved = {
      ...BATCH,
      repeatable: { max: 3, optionIds: [] },
      reservedSlotIds: [batchSlot(2)],
    } as unknown as GenerationInputSnapshot;
    const projected = projectDraftInputs(
      session([reserved]),
      [{ kind: "attachAsset", inputId: "142:images", assetId: "asset-k" }],
      resolveAsset,
    );
    expect(projected[0].media?.map((item) => item.assetId)).toEqual([
      "asset-a",
      "asset-b",
    ]);
  });

  it("keeps staged slot ids stable when an earlier op resolves to nothing", () => {
    // The asset for the first attach has left the library. A counter of
    // successful attaches would renumber the second one, moving React keys and
    // per-tile state onto a neighbouring tile.
    const projected = projectDraftInputs(
      session([BATCH]),
      [
        { kind: "attachAsset", inputId: "142:images", assetId: "gone" },
        { kind: "attachAsset", inputId: "142:images", assetId: "asset-k" },
      ],
      resolveAsset,
    );
    const staged = (projected[0].media ?? []).filter((item) =>
      item.slotId.startsWith("staged:"),
    );
    expect(staged.map((item) => item.slotId)).toEqual([stagedSlot(1)]);
  });

  it("reports a conflict on a staged widget the panel then changed", () => {
    const ops: GenerationInputDraftOp[] = [
      { kind: "setWidget", nodeId: "9", param: "length", value: 96 },
    ];
    const base = new Map<string, unknown>([["9:length", 48]]);

    // Untouched underneath: the draft simply wins.
    expect(findDraftWidgetConflicts(base, new Map([["9:length", 48]]), ops)).toEqual(
      [],
    );
    // Changed underneath: `compileDraftCommands` writes staged widgets
    // unconditionally, so without this the panel's choice is overwritten with
    // nothing on screen to say so.
    expect(
      findDraftWidgetConflicts(base, new Map([["9:length", 120]]), ops),
    ).toEqual(["9:length"]);
  });

  it("reports a conflict when a slot is reserved under a staged append", () => {
    // The projection re-derives capacity against the live session, so a
    // reservation appearing after an append was staged makes that append
    // refuse. Without a conflict the item just vanishes from the editor, the
    // commit compiles to nothing, reports success, and clears the draft.
    const ops: GenerationInputDraftOp[] = [
      { kind: "attachAsset", inputId: "142:images", assetId: "asset-k" },
    ];
    const before = [BATCH];
    const busy = [
      {
        ...BATCH,
        reservedSlotIds: [batchSlot(2)],
      } as unknown as GenerationInputSnapshot,
    ];
    expect(findDraftConflicts(before, busy, ops)).toEqual(["Image inputs"]);
  });

  it("reports a conflict when the batch's capacity shrinks under a draft", () => {
    const ops: GenerationInputDraftOp[] = [
      { kind: "attachAsset", inputId: "142:images", assetId: "asset-k" },
    ];
    const smaller = [
      {
        ...BATCH,
        repeatable: { max: 2, optionIds: [] },
      } as unknown as GenerationInputSnapshot,
    ];
    expect(findDraftConflicts([BATCH], smaller, ops)).toEqual(["Image inputs"]);
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

/**
 * The invariant the compiler exists to hold: whatever the editor shows is what
 * the panel holds afterwards. Every case here runs the compiled commands
 * through the real session transaction and the host's own apply, so a command
 * addressing a slot the host has renumbered fails here rather than passing
 * against a model that never renumbers.
 */
describe("a committed draft matches what the editor showed", () => {
  it("clears a staged replacement without touching the panel", () => {
    const { target, result, panel } = commitDraft(
      [BATCH],
      [
        { kind: "attachAsset", inputId: "142:images", assetId: "asset-k" },
        { kind: "removeMedia", inputId: "142:images", slotId: stagedSlot(0) },
      ],
    );
    expect(result.ok).toBe(true);
    expect(assetIds(panel)).toEqual(assetIds(target));
    expect(assetIds(panel)).toEqual(["asset-a", "asset-b"]);
  });

  it("moves a staged item to the front and removes an original", () => {
    const { target, result, panel } = commitDraft(
      [BATCH],
      [
        { kind: "attachAsset", inputId: "142:images", assetId: "asset-k" },
        { kind: "moveMedia", inputId: "142:images", fromOrdinal: 2, toOrdinal: 0 },
        { kind: "removeMedia", inputId: "142:images", slotId: batchSlot(0) },
      ],
    );
    expect(result.ok).toBe(true);
    expect(assetIds(panel)).toEqual(assetIds(target));
    expect(assetIds(panel)).toEqual(["asset-k", "asset-b"]);
  });

  it("reorders around a staged item", () => {
    const { target, result, panel } = commitDraft(
      [BATCH],
      [
        { kind: "attachAsset", inputId: "142:images", assetId: "asset-k" },
        { kind: "moveMedia", inputId: "142:images", fromOrdinal: 2, toOrdinal: 0 },
        { kind: "moveMedia", inputId: "142:images", fromOrdinal: 2, toOrdinal: 1 },
      ],
    );
    expect(result.ok).toBe(true);
    expect(assetIds(panel)).toEqual(assetIds(target));
    expect(assetIds(panel)).toEqual(["asset-k", "asset-b", "asset-a"]);
  });

  it("removes a single item", () => {
    const { target, result, panel } = commitDraft(
      [BATCH_OF_THREE],
      [{ kind: "removeMedia", inputId: "142:images", slotId: batchSlot(1) }],
    );
    expect(result.ok).toBe(true);
    expect(assetIds(panel)).toEqual(assetIds(target));
    expect(assetIds(panel)).toEqual(["asset-a", "asset-c"]);
  });
});

/**
 * Sequences that spend more than one slot id.
 *
 * These are the cases the compiler got wrong while slot ids were taken at face
 * value: every remove and move renumbers the batch, so the second id in a
 * sequence named a different item than the caller meant — or none at all. The
 * transaction now translates caller ids against the arrangement it opened on
 * (docs/staged-generation-editor-plan.md §3.1), and the compiler is unchanged.
 */
describe("a committed draft matches what the editor showed: multi-command", () => {
  it("removes the two items the editor removed", () => {
    const { target, result, panel } = commitDraft(
      [BATCH_OF_THREE],
      [
        { kind: "removeMedia", inputId: "142:images", slotId: batchSlot(0) },
        { kind: "removeMedia", inputId: "142:images", slotId: batchSlot(1) },
      ],
    );
    expect(result.ok).toBe(true);
    expect(assetIds(target)).toEqual(["asset-c"]);
    // The second removal addresses `::repeat::1`, which the first removal
    // renamed onto asset-c. Untranslated it takes asset-c and leaves asset-b.
    expect(assetIds(panel)).toEqual(["asset-c"]);
  });

  it("sets the option on the item the editor switched", () => {
    const { target, result, panel } = commitDraft(
      [CLIPS],
      [
        { kind: "removeMedia", inputId: "143:clips", slotId: clipSlot(0) },
        {
          kind: "setMediaOption",
          inputId: "143:clips",
          slotId: clipSlot(1),
          optionId: "audio",
          value: true,
        },
      ],
    );
    expect(result.ok).toBe(true);
    expect(assetIds(target)).toEqual(["clip-b", "clip-c"]);
    expect(audioFlags(target)).toEqual([true, false]);
    // Untranslated the switch lands on clip-c.
    expect(assetIds(panel)).toEqual(["clip-b", "clip-c"]);
    expect(audioFlags(panel)).toEqual([true, false]);
  });

  it("commits a staged mute over the audio-on default", () => {
    const { target, result, panel } = commitDraft(
      [CLIPS],
      [
        { kind: "attachAsset", inputId: "143:clips", assetId: "clip-a" },
        { kind: "attachAsset", inputId: "143:clips", assetId: "clip-b" },
        {
          kind: "setMediaOption",
          inputId: "143:clips",
          slotId: stagedSlot(1),
          optionId: "audio",
          value: false,
        },
      ],
    );
    expect(result.ok).toBe(true);
    expect(audioFlags(target).slice(3)).toEqual([true, false]);
    expect(audioFlags(panel).slice(3)).toEqual([true, false]);
  });

  it("empties a batch the editor emptied", () => {
    // With two items the second removal addresses a slot that, untranslated,
    // no longer exists at all — a `media_not_found` refusal of the whole
    // transaction rather than a silent wrong write.
    const { result, panel } = commitDraft(
      [BATCH],
      [
        { kind: "removeMedia", inputId: "142:images", slotId: batchSlot(0) },
        { kind: "removeMedia", inputId: "142:images", slotId: batchSlot(1) },
      ],
    );
    expect(result.ok).toBe(true);
    expect(assetIds(panel)).toEqual([]);
  });
});

/**
 * The compiler's whole contract, asserted over sequences nobody chose.
 *
 * The fixed examples above each pin one shape of edit; this pins the invariant
 * they are examples of — whatever the editor shows is what the panel holds
 * afterwards — across randomly generated op sequences. That is what the
 * addressing bugs violated, and an example-only suite can only catch the shapes
 * someone thought to write down.
 *
 * Ops are generated against the *projection so far*, exactly as a real surface
 * stages them: a slot id or ordinal is only offered while it names something.
 * Seeded, so a failure names the sequence that produced it.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32: small, deterministic, and good enough to shuffle op choices.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function generateOps(
  random: () => number,
  session: GenerationSessionSnapshot,
  count: number,
): readonly GenerationInputDraftOp[] {
  const ops: GenerationInputDraftOp[] = [];
  const assetIdPool = ["asset-a", "asset-b", "asset-c", "asset-k"];
  const pick = <T,>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)];

  for (let index = 0; index < count; index += 1) {
    // Against what the editor currently shows, so every id and ordinal is live.
    const projected = projectDraftInputs(session, ops, resolveAsset);
    const media = projected[0].media ?? [];
    const kinds: GenerationInputDraftOp["kind"][] = ["attachAsset"];
    if (media.length > 0) kinds.push("removeMedia", "replaceMedia");
    if (media.length > 1) kinds.push("moveMedia");

    switch (pick(kinds)) {
      case "attachAsset":
        ops.push({
          kind: "attachAsset",
          inputId: BATCH_KEY.id,
          assetId: pick(assetIdPool),
        });
        break;
      case "removeMedia":
        ops.push({
          kind: "removeMedia",
          inputId: BATCH_KEY.id,
          slotId: pick(media).slotId,
        });
        break;
      case "replaceMedia":
        ops.push({
          kind: "replaceMedia",
          inputId: BATCH_KEY.id,
          assetId: pick(assetIdPool),
          at: Math.floor(random() * media.length),
        });
        break;
      case "moveMedia":
        ops.push({
          kind: "moveMedia",
          inputId: BATCH_KEY.id,
          fromOrdinal: Math.floor(random() * media.length),
          toOrdinal: Math.floor(random() * media.length),
        });
        break;
      default:
        break;
    }
  }
  return ops;
}

describe("a committed draft matches what the editor showed: any sequence", () => {
  it("commits the projection for 200 generated op sequences", () => {
    const random = seededRandom(0x5eed);
    const base = [BATCH_OF_THREE];

    for (let trial = 0; trial < 200; trial += 1) {
      const opening = session(base);
      const ops = generateOps(random, opening, 1 + Math.floor(random() * 6));
      const { target, result, panel } = commitDraft(base, ops);
      const detail = JSON.stringify(ops);

      if (result.ok) {
        // The invariant the compiler exists to hold.
        expect(assetIds(panel), detail).toEqual(assetIds(target));
      } else {
        // A refusal writes nothing: the panel is exactly as it was.
        expect(assetIds(panel), detail).toEqual(assetIds(base));
      }
      mounted?.unmount();
      mounted = null;
    }
  });
});
