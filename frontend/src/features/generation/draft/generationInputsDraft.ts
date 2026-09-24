import { describeCapturedMedia, type GenerationCapturedMedia } from "../utils/capturedMedia";
import type {
  GenerationInputSnapshot,
  GenerationMediaItemSnapshot,
  GenerationSessionSnapshot,
  GenerationSessionTransaction,
} from "../services/generationSessionTypes";
import { isValidMediaItemId } from "../utils/mediaItemIds";

/**
 * One staged edit, as the editing surface performs it.
 *
 * These describe *gestures*, and they are deliberately not what gets written.
 * Replaying a gesture log commits the wrong thing as soon as one gesture
 * cancels another: attach B over A, then clear B, and a replay skips both and
 * leaves A in the panel — while the editor showed an empty slot. Positioned
 * batch attaches are worse, because a later `at` is meaningless once an
 * earlier staged item is gone.
 *
 * So the log drives the *projection*, and `compileDraftCommands` derives what
 * to write by diffing that projection against the panel. What the user sees is
 * then what gets committed, by construction.
 *
 * The vocabulary is still a constraint on the surface: an interaction with no
 * op here cannot be staged, and must be refused rather than dropped at commit.
 * Captures are staged as native in-memory values after extraction finishes.
 * External file drops still require an explicit ingest path.
 */
export type GenerationInputDraftOp =
  | { readonly kind: "captureMedia"; readonly inputId: string; readonly capture: GenerationCapturedMedia; readonly previewUrl: string; readonly at?: number; readonly itemId?: string; readonly itemOptions?: Readonly<Record<string, boolean>> }
  | { readonly kind: "setText"; readonly inputId: string; readonly value: string }
  | {
      /**
       * Appends to a batch, or fills a single slot (replacing what it holds,
       * as a drop on it would).
       *
       * There is deliberately no position here. An op that both appended and
       * inserted was read as "put it at this tile" by the surface and applied
       * as "insert before this tile" by the projection, which pushed the tile
       * the user dropped on along instead of overwriting it. Overwriting is
       * `replaceMedia`; nothing in the panel inserts between tiles.
       */
      readonly kind: "attachAsset";
      readonly inputId: string;
      readonly assetId: string;
      readonly itemOptions?: Readonly<Record<string, boolean>>;
      /**
       * The occurrence id the staged item carries, and keeps once committed.
       * The controller mints one at `stage` when the caller did not, so an
       * editor can refer to the item before it exists and the reference
       * survives the commit.
       */
      readonly itemId?: string;
    }
  | {
      /** Overwrites the filled slot at `at`, as a drop on that tile does. */
      readonly kind: "replaceMedia";
      readonly inputId: string;
      readonly assetId: string;
      readonly at: number;
      readonly itemOptions?: Readonly<Record<string, boolean>>;
      /** See `attachAsset`. A replacement is a new occurrence, never the old. */
      readonly itemId?: string;
    }
  | {
      readonly kind: "removeMedia";
      readonly inputId: string;
      readonly slotId: string;
    }
  | {
      /**
       * Holds a text input the caller will write itself at commit, without
       * staging a value for it.
       *
       * A composer resolves its prompt only once it knows the arrangement being
       * committed, so it has no string to stage — but it still edits the prompt,
       * and an edit made in the panel meanwhile must conflict rather than be
       * overwritten by `additionalWrites`. This captures that baseline.
       */
      readonly kind: "holdText";
      readonly inputId: string;
    }
  | {
      readonly kind: "moveMedia";
      readonly inputId: string;
      readonly fromOrdinal: number;
      readonly toOrdinal: number;
    }
  | {
      /**
       * A widget, not an input: the panel's `length` slider and its like are
       * node parameters, and the transaction writes them with `setWidget`.
       * Staged alongside inputs because a composer that derives text from a
       * duration has to see the duration the user is choosing, not the one the
       * panel still holds.
       */
      readonly kind: "setWidget";
      readonly nodeId: string;
      readonly param: string;
      readonly value: unknown;
    }
  | {
      readonly kind: "setMediaOption";
      readonly inputId: string;
      readonly slotId: string;
      readonly optionId: string;
      readonly value: boolean;
    };

/**
 * A slot id for media staged but not yet written.
 *
 * Real slot ids are the host's to mint, and an attach has none until the
 * transaction commits — the same reason `attachAsset` takes `itemOptions`
 * rather than expecting a follow-up `setMediaOption`. These stand in so the
 * projection can be addressed and re-edited before commit, and they never
 * reach a transaction: `toTransactionOps` replays the ops, not the projection.
 */
export const STAGED_SLOT_PREFIX = "staged:";

export function isStagedSlotId(slotId: string): boolean {
  return slotId.startsWith(STAGED_SLOT_PREFIX);
}

/**
 * How an attach will look once committed, for the input it lands on.
 *
 * Returns the host's own simulation rather than a description assembled here:
 * media type, `hasAudio` and the offered options all depend on the destination
 * input, and a draft that guessed them would show one thing and commit
 * another. `replaced` is the item a single-slot attach displaces.
 */
export type StagedAttachResolver = (
  input: GenerationInputSnapshot,
  assetId: string,
  replaced: GenerationMediaItemSnapshot | null,
) => GenerationMediaItemSnapshot | null;

/**
 * Ordinals are delivery positions and are **zero-based**, matching what the
 * panel publishes (`generationMediaSnapshot`) and what the transaction accepts
 * (`0..length-1`). A one-based projection would render correctly and then have
 * every reorder rejected or applied to the wrong item.
 */
function reindex(
  items: readonly GenerationMediaItemSnapshot[],
): GenerationMediaItemSnapshot[] {
  return items.map((item, index) => ({ ...item, ordinal: index }));
}

function applyToInput(
  input: GenerationInputSnapshot,
  op: Exclude<GenerationInputDraftOp, { kind: "setWidget" }>,
  resolveAsset: StagedAttachResolver,
  /**
   * This op's index in the draft log, which is what its staged slot id is
   * built from.
   *
   * Not a running counter of successful attaches: `resolveAsset` returns null
   * for an asset that has left the library mid-draft, and a counter would then
   * shift every *later* staged id down one — moving React keys and per-tile UI
   * state onto neighbouring tiles. An op's position in the log never moves.
   */
  opIndex: number,
): GenerationInputSnapshot {
  if (op.kind === "setText") {
    return { ...input, value: op.value };
  }
  if (op.kind === "holdText") return input;
  const media = input.media ?? [];
  if (op.kind === "attachAsset" || op.kind === "replaceMedia" || op.kind === "captureMedia") {
    const at = op.kind === "replaceMedia" || op.kind === "captureMedia" ? (op.at ?? null) : null;
    // A single slot always replaces; a batch replaces only where told to.
    const replaced = !input.repeatable
      ? (media[0] ?? null)
      : at !== null
        ? (media[at] ?? null)
        : null;
    if (at !== null && replaced === null) return input;
    // A batch that is full — or whose remaining slots are spoken for by media
    // still being produced — refuses an append, exactly as the transaction
    // would. Without this a draft can show an item it can never commit.
    if (
      at === null &&
      input.repeatable &&
      media.length + (input.reservedSlotIds?.length ?? 0) >=
        input.repeatable.max
    ) {
      return input;
    }
    const simulated = op.kind === "captureMedia"
      ? describeCapturedMedia(input, op.capture, op.previewUrl)
      : resolveAsset(input, op.assetId, replaced);
    if (!simulated) return input;
    const item: GenerationMediaItemSnapshot = {
      ...simulated,
      slotId: `${STAGED_SLOT_PREFIX}${opIndex}`,
      // Minted at stage; the fallback is only for a log built by hand, and is
      // still stable because it is derived from the op's fixed position.
      itemId: op.itemId ?? `${STAGED_SLOT_PREFIX}${opIndex}`,
      options: { ...simulated.options, ...(op.itemOptions ?? {}) },
    };
    if (!input.repeatable) return { ...input, media: reindex([item]) };
    const next = [...media];
    if (at === null) next.push(item);
    else next.splice(at, 1, item);
    return { ...input, media: reindex(next) };
  }
  if (op.kind === "removeMedia") {
    return {
      ...input,
      media: reindex(media.filter((item) => item.slotId !== op.slotId)),
    };
  }
  if (op.kind === "moveMedia") {
    const from = op.fromOrdinal;
    const to = op.toOrdinal;
    if (from < 0 || from >= media.length || to < 0 || to >= media.length) {
      return input;
    }
    const next = [...media];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return { ...input, media: reindex(next) };
  }
  return {
    ...input,
    media: media.map((item) =>
      item.slotId === op.slotId
        ? { ...item, options: { ...item.options, [op.optionId]: op.value } }
        : item,
    ),
  };
}

/**
 * The inputs as the panel would hold them if every staged op were applied.
 *
 * Recomputed from the live session on every read rather than kept as state, so
 * a change made in the panel underneath shows through everywhere the draft did
 * not touch. What the draft *did* touch is the user's uncommitted work and is
 * never silently rebased — see `hasConflict`.
 */
export function projectDraftInputs(
  session: GenerationSessionSnapshot,
  ops: readonly GenerationInputDraftOp[],
  resolveAsset: StagedAttachResolver,
): readonly GenerationInputSnapshot[] {
  if (ops.length === 0) return session.inputs;
  const byId = new Map(session.inputs.map((input) => [input.id, input]));
  ops.forEach((op, opIndex) => {
    if (op.kind === "setWidget") return;
    const input = byId.get(op.inputId);
    if (!input) return;
    byId.set(op.inputId, applyToInput(input, op, resolveAsset, opIndex));
  });
  return session.inputs.map((input) => byId.get(input.id) ?? input);
}

/** The input ids a draft has staged an edit against. */
export function draftedInputIds(
  ops: readonly GenerationInputDraftOp[],
): ReadonlySet<string> {
  return new Set(
    ops.flatMap((op) => (op.kind === "setWidget" ? [] : [op.inputId])),
  );
}

/** `nodeId:param`, the key both the panel and the transaction address by. */
export function widgetKey(nodeId: string, param: string): string {
  return `${nodeId}:${param}`;
}

/**
 * The staged value of every widget the draft has touched.
 *
 * Values only — the widget's own description (its control, bounds, options)
 * belongs to the panel and is read from there, the same division the inputs
 * follow after a projection tried to carry both and dropped half of it.
 */
export function projectDraftWidgets(
  ops: readonly GenerationInputDraftOp[],
): ReadonlyMap<string, unknown> {
  const staged = new Map<string, unknown>();
  for (const op of ops) {
    if (op.kind !== "setWidget") continue;
    staged.set(widgetKey(op.nodeId, op.param), op.value);
  }
  return staged;
}

/**
 * Whether the panel changed under a staged edit.
 *
 * Compared per input rather than per session: the panel republishes for every
 * keystroke elsewhere, and treating any of those as a conflict would make the
 * editor unusable. Only a change to an input the draft is holding is a real
 * disagreement — and it is reported rather than merged, because silently
 * rebasing a staged reorder onto a batch someone else changed loses work with
 * nothing on screen to explain it.
 */
export function findDraftConflicts(
  base: readonly GenerationInputSnapshot[],
  current: readonly GenerationInputSnapshot[],
  ops: readonly GenerationInputDraftOp[],
): readonly string[] {
  const drafted = draftedInputIds(ops);
  if (drafted.size === 0) return [];
  const baseById = new Map(base.map((input) => [input.id, input]));
  const currentById = new Map(current.map((input) => [input.id, input]));
  const conflicts: string[] = [];
  // An input the draft is holding that has left the panel entirely: the
  // workflow changed shape underneath, and the staged edit has nowhere to go.
  for (const inputId of drafted) {
    if (currentById.has(inputId)) continue;
    conflicts.push(baseById.get(inputId)?.label ?? inputId);
  }
  for (const input of current) {
    if (!drafted.has(input.id)) continue;
    const before = baseById.get(input.id);
    if (!before) {
      conflicts.push(input.label);
      continue;
    }
    const changed =
      before.value !== input.value ||
      // Preview hydration changes presentation, not the attachment being edited.
      JSON.stringify((before.media ?? []).map((item) => ({ ...item, thumbnail: undefined }))) !==
      JSON.stringify((input.media ?? []).map((item) => ({ ...item, thumbnail: undefined }))) ||
      // Capacity is part of the disagreement, not just contents. The
      // projection re-derives against the live session on every read, so a
      // slot reserved after an append was staged makes that append refuse —
      // the item vanishes from the editor, the commit compiles to nothing,
      // succeeds, and clears the draft. Silently losing the user's work is the
      // one outcome this whole design exists to prevent, so a capacity change
      // under a drafted input is reported like any other.
      JSON.stringify(before.reservedSlotIds ?? []) !==
        JSON.stringify(input.reservedSlotIds ?? []) ||
      before.repeatable?.max !== input.repeatable?.max;
    if (changed) conflicts.push(input.label);
  }
  return conflicts;
}

/**
 * The staged widgets whose panel value moved underneath, keyed `nodeId:param`.
 *
 * Widgets need this as much as inputs do, and for a worse reason:
 * `compileDraftCommands` writes every staged widget unconditionally — the
 * staged value *is* the target, so there is no diff to notice a disagreement.
 * Without a conflict check a draft holding a duration silently overwrites
 * whatever the user then chose in the panel, which for a composer means the
 * prose and the length stop agreeing.
 *
 * Keys rather than labels: a widget's label lives in the node catalogue, and
 * the caller already has it.
 */
export function findDraftWidgetConflicts(
  base: ReadonlyMap<string, unknown>,
  current: ReadonlyMap<string, unknown>,
  ops: readonly GenerationInputDraftOp[],
): readonly string[] {
  const conflicts: string[] = [];
  for (const key of projectDraftWidgets(ops).keys()) {
    if (!base.has(key)) continue;
    // Compared structurally: a widget value may be a small object, and the
    // panel republishes a fresh one for every keystroke elsewhere.
    if (JSON.stringify(base.get(key)) !== JSON.stringify(current.get(key))) {
      conflicts.push(key);
    }
  }
  return conflicts;
}


/**
 * Derives the writes that turn the panel's inputs into the projected ones.
 *
 * Diffing final states rather than replaying gestures is what makes "what you
 * see is what commits" true: a staged item the user then cleared simply is not
 * in the target, an attach that replaced another needs no knowledge of the
 * gesture that removed it, and positions are read off the target list instead
 * of an `at` computed against a list that no longer exists.
 *
 * The write order matters and is fixed: remove what is leaving, append what is
 * new, then reorder the result into place. Appending rather than attaching at
 * a position keeps every attach off the repack path — a positioned attach is
 * an append plus a reorder anyway — and leaves one reorder pass to express the
 * final arrangement, including where new items sit among old ones.
 */
export function compileDraftCommands(
  base: readonly GenerationInputSnapshot[],
  target: readonly GenerationInputSnapshot[],
  transaction: GenerationSessionTransaction,
  /**
   * Widget values to write, keyed `nodeId:param`. Passed rather than diffed:
   * a widget is a scalar the panel owns, so the staged value *is* the target
   * and there is no arrangement to reconstruct.
   */
  widgets: ReadonlyMap<string, unknown> = new Map(),
  captures: ReadonlyMap<string, GenerationCapturedMedia> = new Map(),
): void {
  for (const [key, value] of widgets) {
    const separator = key.lastIndexOf(":");
    if (separator <= 0) continue;
    // The transaction names the parameter `widget`, the panel names it
    // `param`; same thing, addressed by node id either way.
    transaction.setWidget(
      { nodeId: key.slice(0, separator), widget: key.slice(separator + 1) },
      value as never,
    );
  }
  const baseById = new Map(base.map((input) => [input.id, input]));
  for (const input of target) {
    const before = baseById.get(input.id);
    if (!before) continue;

    if (input.inputType === "text") {
      if (before.value !== input.value && typeof input.value === "string") {
        transaction.setTextInput(input.id, input.value);
      }
      continue;
    }

    const beforeMedia = before.media ?? [];
    const targetMedia = input.media ?? [];
    const targetSlots = new Set(targetMedia.map((item) => item.slotId));

    for (const item of beforeMedia) {
      if (!targetSlots.has(item.slotId)) {
        transaction.removeMedia(input.id, item.slotId);
      }
    }

    // Survivors keep their relative order for now; appends land after them.
    const survivors = beforeMedia.filter((item) => targetSlots.has(item.slotId));
    const appended = targetMedia.filter((item) => isStagedSlotId(item.slotId));
    for (const item of appended) {
      const capture = captures.get(item.itemId);
      // Only what differs from how the attach lands on its own. An asset's
      // defaults are not known here, so its switches are always sent.
      const initialOptions: Readonly<Record<string, boolean>> = capture
        ? describeCapturedMedia(input, capture).options
        : {};
      const options = Object.fromEntries(
        Object.entries(item.options).filter(([key, value]) => value !== initialOptions[key]),
      );
      const attachOptions = {
        ...(Object.keys(options).length > 0 ? { itemOptions: options } : {}),
        // The id the draft has been showing, so a reference made to the staged
        // item still names it once it is real.
        ...(isValidMediaItemId(item.itemId) ? { itemId: item.itemId } : {}),
      };
      if (capture) transaction.attachCapturedMedia(input.id, capture, attachOptions);
      else if (item.assetId) transaction.attachAsset(input.id, item.assetId, attachOptions);
      else throw new Error("The staged capture is no longer available.");
    }

    // Options on items that already existed; a new item carried its own.
    for (const item of targetMedia) {
      if (isStagedSlotId(item.slotId)) continue;
      const previous = beforeMedia.find(
        (candidate) => candidate.slotId === item.slotId,
      );
      if (!previous) continue;
      for (const [optionId, value] of Object.entries(item.options)) {
        if (previous.options[optionId] === value) continue;
        transaction.setMediaOption(item.slotId, optionId, value);
      }
    }

    // Selection sort over the post-append arrangement into the target order.
    // Only repeatable inputs can reorder; a single slot has nowhere to move.
    if (!input.repeatable) continue;
    const arrangement = [
      ...survivors.map((item) => item.slotId),
      ...appended.map((item) => item.slotId),
    ];
    const desired = targetMedia.map((item) => item.slotId);
    for (let index = 0; index < desired.length; index += 1) {
      const wanted = desired[index];
      const from = arrangement.indexOf(wanted);
      if (from === -1 || from === index) continue;
      transaction.moveMedia(input.id, from, index);
      const [moved] = arrangement.splice(from, 1);
      arrangement.splice(index, 0, moved);
    }
  }
}
