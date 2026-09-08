import type {
  GenerationInputSnapshot,
  GenerationMediaItemSnapshot,
  GenerationSessionSnapshot,
  GenerationSessionTransaction,
} from "../services/generationSessionTypes";

/**
 * A staged edit to the generation panel's inputs.
 *
 * Stored as *commands*, not as mutated values, for one reason: every command
 * here is one the session transaction can replay verbatim on commit. A draft
 * that held edited values instead would have to reverse-engineer the commands
 * at commit time, and the media ones — attach at a position, replace the only
 * slot, move by delivery ordinal — are not recoverable from a before/after
 * pair.
 *
 * That constraint is also the whole editing vocabulary: an interaction with no
 * command here cannot be staged, and the editor refuses to offer it rather
 * than letting a user make a change that would be dropped on commit. External
 * file drops, timeline capture and frame capture are the notable absences —
 * they start real work and produce values no id can name yet.
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

/** How a staged attach is described while it has no real slot. */
export interface StagedAssetResolution {
  readonly displayName: string;
  readonly mediaType: "image" | "video" | "audio";
  readonly hasAudio: boolean | null;
}

function reindex(
  items: readonly GenerationMediaItemSnapshot[],
): GenerationMediaItemSnapshot[] {
  return items.map((item, index) => ({ ...item, ordinal: index + 1 }));
}

function applyToInput(
  input: GenerationInputSnapshot,
  op: GenerationInputDraftOp,
  resolveAsset: (assetId: string) => StagedAssetResolution | null,
  stagedSlotSeq: { value: number },
): GenerationInputSnapshot {
  if (op.kind === "setText") {
    return { ...input, value: op.value };
  }
  const media = input.media ?? [];
  if (op.kind === "attachAsset") {
    const resolved = resolveAsset(op.assetId);
    if (!resolved) return input;
    stagedSlotSeq.value += 1;
    const item: GenerationMediaItemSnapshot = {
      slotId: `${STAGED_SLOT_PREFIX}${stagedSlotSeq.value}`,
      ordinal: 0,
      source: "asset",
      assetId: op.assetId,
      displayName: resolved.displayName,
      mediaType: resolved.mediaType,
      hasAudio: resolved.hasAudio,
      options: op.itemOptions ? { ...op.itemOptions } : {},
      preparing: false,
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
    const from = op.fromOrdinal - 1;
    const to = op.toOrdinal - 1;
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
  resolveAsset: (assetId: string) => StagedAssetResolution | null,
): readonly GenerationInputSnapshot[] {
  if (ops.length === 0) return session.inputs;
  const stagedSlotSeq = { value: 0 };
  const byId = new Map(session.inputs.map((input) => [input.id, input]));
  for (const op of ops) {
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
  return new Set(ops.map((op) => op.inputId));
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
  const conflicts: string[] = [];
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
 * Replays the staged ops onto a transaction.
 *
 * Ops carry staged slot ids, which the host has never seen; only ops naming a
 * *real* slot are replayed by id. An op addressing a staged slot is one the
 * user performed on media that does not exist yet, so its effect is already
 * folded into the attach that created it — `attachAsset` carries the item
 * options, and a staged item removed before commit leaves nothing to write.
 */
export function replayDraftOps(
  ops: readonly GenerationInputDraftOp[],
  transaction: GenerationSessionTransaction,
): void {
  const stagedRemoved = new Set<string>();
  for (const op of ops) {
    if (op.kind === "removeMedia" && isStagedSlotId(op.slotId)) {
      stagedRemoved.add(op.slotId);
    }
  }
  // Options set on a staged item ride its own attach, so they are collected
  // first rather than replayed as separate writes against an id that does not
  // exist.
  const stagedOptions = new Map<string, Record<string, boolean>>();
  let stagedSeq = 0;
  const attachSlotIds: string[] = [];
  for (const op of ops) {
    if (op.kind !== "attachAsset") continue;
    stagedSeq += 1;
    attachSlotIds.push(`${STAGED_SLOT_PREFIX}${stagedSeq}`);
  }
  for (const op of ops) {
    if (op.kind !== "setMediaOption" || !isStagedSlotId(op.slotId)) continue;
    const existing = stagedOptions.get(op.slotId) ?? {};
    stagedOptions.set(op.slotId, { ...existing, [op.optionId]: op.value });
  }

  let attachIndex = 0;
  for (const op of ops) {
    switch (op.kind) {
      case "setText":
        transaction.setTextInput(op.inputId, op.value);
        break;
      case "attachAsset": {
        const slotId = attachSlotIds[attachIndex];
        attachIndex += 1;
        if (stagedRemoved.has(slotId)) break;
        const options = {
          ...(op.itemOptions ?? {}),
          ...(stagedOptions.get(slotId) ?? {}),
        };
        transaction.attachAsset(op.inputId, op.assetId, {
          ...(op.at === undefined ? {} : { at: op.at }),
          ...(Object.keys(options).length > 0 ? { itemOptions: options } : {}),
        });
        break;
      }
      case "removeMedia":
        if (isStagedSlotId(op.slotId)) break;
        transaction.removeMedia(op.inputId, op.slotId);
        break;
      case "moveMedia":
        transaction.moveMedia(op.inputId, op.fromOrdinal, op.toOrdinal);
        break;
      case "setMediaOption":
        if (isStagedSlotId(op.slotId)) break;
        transaction.setMediaOption(op.slotId, op.optionId, op.value);
        break;
    }
  }
}
