import type {
  GenerationInputSnapshot,
  GenerationMediaItemSnapshot,
  GenerationSessionSnapshot,
  GenerationSessionTransaction,
} from "../services/generationSessionTypes";

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
 * External file drops, timeline capture and frame capture are the notable
 * absences — they start real work and produce values no id can name yet.
 */
export type GenerationInputDraftOp =
  | { readonly kind: "setText"; readonly inputId: string; readonly value: string }
  | {
      readonly kind: "attachAsset";
      readonly inputId: string;
      readonly assetId: string;
      /** Position among filled slots; omitted appends. */
      readonly at?: number;
      readonly itemOptions?: Readonly<Record<string, boolean>>;
    }
  | {
      readonly kind: "removeMedia";
      readonly inputId: string;
      readonly slotId: string;
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
  stagedSlotSeq: { value: number },
): GenerationInputSnapshot {
  if (op.kind === "setText") {
    return { ...input, value: op.value };
  }
  const media = input.media ?? [];
  if (op.kind === "attachAsset") {
    const replaced = input.repeatable ? null : (media[0] ?? null);
    const simulated = resolveAsset(input, op.assetId, replaced);
    if (!simulated) return input;
    stagedSlotSeq.value += 1;
    const item: GenerationMediaItemSnapshot = {
      ...simulated,
      slotId: `${STAGED_SLOT_PREFIX}${stagedSlotSeq.value}`,
      options: { ...simulated.options, ...(op.itemOptions ?? {}) },
    };
    // A single-slot input replaces what it holds, exactly as a drop on it
    // would; a batch inserts at the position or appends.
    if (!input.repeatable) return { ...input, media: reindex([item]) };
    const next = [...media];
    const at = op.at ?? next.length;
    next.splice(Math.max(0, Math.min(at, next.length)), 0, item);
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
  const stagedSlotSeq = { value: 0 };
  const byId = new Map(session.inputs.map((input) => [input.id, input]));
  for (const op of ops) {
    if (op.kind === "setWidget") continue;
    const input = byId.get(op.inputId);
    if (!input) continue;
    byId.set(op.inputId, applyToInput(input, op, resolveAsset, stagedSlotSeq));
  }
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
      JSON.stringify(before.media ?? []) !== JSON.stringify(input.media ?? []);
    if (changed) conflicts.push(input.label);
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
      if (!item.assetId) continue;
      const options = Object.fromEntries(
        Object.entries(item.options).filter(([, value]) => value === true),
      );
      transaction.attachAsset(input.id, item.assetId, {
        ...(Object.keys(options).length > 0 ? { itemOptions: options } : {}),
      });
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
