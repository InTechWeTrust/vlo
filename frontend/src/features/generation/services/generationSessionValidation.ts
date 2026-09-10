import { serializeFiniteJson } from "../utils/finiteJson";
import { assetMatchesType } from "../../../shared/utils/assetTypeDetection";
import { isVideoAssetWithAudio } from "../utils/audioSlotAssets";
import { canAttachAssetToMediaInput } from "../utils/mediaInputAssets";
import { buildRepeatableInputSlotId } from "../utils/workflowInputs";
import type {
  GenerationEditableWidgetSnapshot,
  GenerationInputSnapshot,
  GenerationMediaItemOptionId,
  GenerationMediaItemSnapshot,
  GenerationSessionMediaCommit,
  GenerationSessionAssetCandidate,
  GenerationSessionJsonValue,
  GenerationSessionSnapshot,
  GenerationTransactionFailureCode,
  GenerationWidgetTarget,
} from "./generationSessionTypes";
import type { WidgetValueType, WorkflowInput } from "../types";

/**
 * Deterministic validation for session transactions
 * (docs/generation-native-extension-seams-plan.md §3.2). Pure: a command is
 * judged against a published snapshot only, so the same command validates the
 * same way for a native control and for a trusted adapter.
 */

export interface ValidationFailure {
  readonly code: GenerationTransactionFailureCode;
  readonly message: string;
}

export type ValidationResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly failure: ValidationFailure };

function failure(
  code: GenerationTransactionFailureCode,
  message: string,
): ValidationResult<never> {
  return { ok: false, failure: { code, message } };
}

export function widgetKey(target: GenerationWidgetTarget): string {
  return JSON.stringify([target.nodeId, target.widget]);
}

export function describeWidgetTarget(target: GenerationWidgetTarget): string {
  return `${target.nodeId}.${target.widget}`;
}

/** Editable widgets indexed by target; a key may bind more than one control. */
export function indexEditableWidgets(
  widgets: readonly GenerationEditableWidgetSnapshot[],
): Map<string, GenerationEditableWidgetSnapshot[]> {
  const index = new Map<string, GenerationEditableWidgetSnapshot[]>();
  for (const widget of widgets) {
    const key = widgetKey(widget.target);
    const existing = index.get(key);
    if (existing) {
      existing.push(widget);
    } else {
      index.set(key, [widget]);
    }
  }
  return index;
}

function catalogueHasTarget(
  snapshot: GenerationSessionSnapshot,
  target: GenerationWidgetTarget,
): boolean {
  return snapshot.workflow.nodes.some(
    (node) =>
      node.id === target.nodeId &&
      node.widgets.some((widget) => widget.param === target.widget),
  );
}

const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/;
const NUMERIC_TEXT = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;

// Slider tracks and float widgets both produce values built from `step`
// arithmetic, which lands a hair outside an exact bound often enough to matter.
const RANGE_EPSILON = 1e-9;

function withinRange(
  value: number,
  widget: Pick<GenerationWidgetConstraints, "min" | "max">,
): boolean {
  if (widget.min !== null && value < widget.min - RANGE_EPSILON) return false;
  if (widget.max !== null && value > widget.max + RANGE_EPSILON) return false;
  return true;
}

function matchesOption(
  value: GenerationSessionJsonValue,
  options: readonly (string | number | boolean)[],
): boolean {
  return options.some(
    (option) =>
      option === value ||
      (typeof value !== "object" && String(option) === String(value)),
  );
}

/**
 * The constraints a value is judged against, shared by the two callers that
 * have them from different places: a panel binding (the transaction path) and
 * the node catalogue (a submission effect, which addresses the graph and so
 * cannot be limited to widgets the panel renders a control for).
 */
export interface GenerationWidgetConstraints {
  readonly valueType: WidgetValueType;
  readonly options: readonly (string | number | boolean)[] | null;
  readonly min: number | null;
  readonly max: number | null;
  /** Panel bindings only; the catalogue has no boolean serialization. */
  readonly trueValue?: GenerationSessionJsonValue | null;
  readonly falseValue?: GenerationSessionJsonValue | null;
}

/**
 * Is `value` acceptable for one set of constraints?
 *
 * Numeric widgets also accept text, because that is what the panel's own
 * numeric fields emit: an in-progress or cleared field is the raw string, and
 * seeds beyond `Number.MAX_SAFE_INTEGER` stay strings on purpose so their
 * precision survives the round trip. Text that parses to a number is still
 * range-checked; text that does not parse at all is rejected.
 */
export function checkWidgetValue(
  widget: GenerationWidgetConstraints,
  value: GenerationSessionJsonValue,
  describe: string,
): ValidationFailure | null {
  switch (widget.valueType) {
    case "enum": {
      if (!widget.options || widget.options.length === 0) {
        return typeof value === "object"
          ? {
              code: "widget_value_invalid",
              message: `Widget '${describe}' takes a scalar value.`,
            }
          : null;
      }
      return matchesOption(value, widget.options)
        ? null
        : {
            code: "widget_value_invalid",
            message: `Widget '${describe}' does not offer the option ${JSON.stringify(
              value,
            )}.`,
          };
    }
    case "boolean": {
      if (typeof value === "boolean") return null;
      if (value === "true" || value === "false") return null;
      if (widget.trueValue != null && value === widget.trueValue) return null;
      if (widget.falseValue != null && value === widget.falseValue) {
        return null;
      }
      return {
        code: "widget_value_invalid",
        message: `Widget '${describe}' takes a boolean value.`,
      };
    }
    case "int":
    case "float": {
      const isInt = widget.valueType === "int";
      if (typeof value === "number") {
        if (isInt && !Number.isInteger(value)) {
          return {
            code: "widget_value_invalid",
            message: `Widget '${describe}' takes a whole number.`,
          };
        }
        return withinRange(value, widget)
          ? null
          : {
              code: "widget_value_invalid",
              message: `Widget '${describe}' takes values between ${
                widget.min ?? "-∞"
              } and ${widget.max ?? "∞"}.`,
            };
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0) return null;
        if (isInt ? !INTEGER_TEXT.test(value) : !NUMERIC_TEXT.test(value)) {
          return {
            code: "widget_value_invalid",
            message: `Widget '${describe}' takes a ${
              isInt ? "whole number" : "number"
            }.`,
          };
        }
        const parsed = Number(trimmed);
        // Text that overflows to an infinity is not a large number the widget
        // can hold, it is an unrepresentable one: `1e9999` would otherwise
        // skip the range check entirely, since an infinity is neither inside
        // nor outside a finite bound.
        if (!Number.isFinite(parsed)) {
          return {
            code: "widget_value_invalid",
            message: `Widget '${describe}' takes a finite ${
              isInt ? "whole number" : "number"
            }.`,
          };
        }
        return withinRange(parsed, widget)
          ? null
          : {
              code: "widget_value_invalid",
              message: `Widget '${describe}' takes values between ${
                widget.min ?? "-∞"
              } and ${widget.max ?? "∞"}.`,
            };
      }
      return {
        code: "widget_value_invalid",
        message: `Widget '${describe}' takes a number.`,
      };
    }
    case "string": {
      return typeof value === "string"
        ? null
        : {
            code: "widget_value_invalid",
            message: `Widget '${describe}' takes a string.`,
          };
    }
    default:
      // An undeclared widget kind (no object_info, custom class): the graph
      // bridge is the only thing that can judge the value.
      return null;
  }
}

/**
 * Resolve an input id. Panel controls address an input by its bare node id
 * whenever that node has exactly one input — the same alias rule
 * `buildWorkflowInputLookup` applies — so the session accepts both forms and
 * commits the canonical `<nodeId>:<param>` id.
 */
function resolveInput(
  snapshot: GenerationSessionSnapshot,
  inputId: string,
): GenerationSessionSnapshot["inputs"][number] | null {
  const exact = snapshot.inputs.find((candidate) => candidate.id === inputId);
  if (exact) return exact;
  const byNodeId = snapshot.inputs.filter(
    (candidate) => candidate.nodeId === inputId,
  );
  return byNodeId.length === 1 ? byNodeId[0] : null;
}

export function validateTextInputCommand(
  snapshot: GenerationSessionSnapshot,
  inputId: string,
): ValidationResult<string> {
  const input = resolveInput(snapshot, inputId);
  if (!input) {
    return failure(
      "input_not_found",
      `Generation input '${inputId}' was not found.`,
    );
  }
  if (input.inputType !== "text") {
    return failure(
      "input_type_mismatch",
      `Generation input '${inputId}' is not a text input.`,
    );
  }
  return { ok: true, value: input.id };
}

export function validateWidgetCommand(
  snapshot: GenerationSessionSnapshot,
  editableIndex: ReadonlyMap<string, GenerationEditableWidgetSnapshot[]>,
  target: GenerationWidgetTarget,
  value: unknown,
): ValidationResult<GenerationSessionJsonValue> {
  const serialized = serializeFiniteJson(value);
  if (serialized === null) {
    return failure(
      "widget_value_invalid",
      `Widget '${describeWidgetTarget(
        target,
      )}' takes a value representable as finite JSON.`,
    );
  }
  const normalized = JSON.parse(serialized) as GenerationSessionJsonValue;

  const bindings = editableIndex.get(widgetKey(target));
  if (!bindings || bindings.length === 0) {
    return catalogueHasTarget(snapshot, target)
      ? failure(
          "widget_not_editable",
          `Widget '${describeWidgetTarget(
            target,
          )}' exists in the workflow but the generation panel exposes no control for it.`,
        )
      : failure(
          "widget_not_found",
          `Widget '${describeWidgetTarget(
            target,
          )}' was not found in the mounted workflow.`,
        );
  }

  // The same target can back more than one control (a raw widget and a derived
  // one, say). Accept when any binding accepts; report the first refusal
  // otherwise, so the message names a real constraint.
  let firstFailure: ValidationFailure | null = null;
  for (const binding of bindings) {
    const rejection = checkWidgetValue(
      binding,
      normalized,
      describeWidgetTarget(binding.target),
    );
    if (!rejection) {
      return { ok: true, value: normalized };
    }
    firstFailure ??= rejection;
  }
  return {
    ok: false,
    failure: firstFailure ?? {
      code: "widget_value_invalid",
      message: `Widget '${describeWidgetTarget(target)}' rejected the value.`,
    },
  };
}

/** Does the snapshot already hold this widget value? */
export function widgetValueMatchesSnapshot(
  editableIndex: ReadonlyMap<string, GenerationEditableWidgetSnapshot[]>,
  target: GenerationWidgetTarget,
  value: GenerationSessionJsonValue,
): boolean {
  const bindings = editableIndex.get(widgetKey(target));
  if (!bindings || bindings.length === 0) return false;
  const serialized = serializeFiniteJson(value);
  return bindings.every(
    (binding) => serializeFiniteJson(binding.value) === serialized,
  );
}

/**
 * Media validation
 * (docs/minimax-prompt-composer-extension-plan.md §4, 1B).
 *
 * Judged against the published snapshot and the drop predicates the panel
 * itself uses, so a write cannot place an asset a drag could not, and cannot
 * address a slot the batch strip does not show.
 */

/** A snapshot input reduced to what the slot-id helpers need. */
function slotKey(
  input: GenerationInputSnapshot,
): Pick<WorkflowInput, "id" | "nodeId" | "param"> {
  return { id: input.id, nodeId: input.nodeId, param: input.param };
}

function resolveMediaInput(
  snapshot: GenerationSessionSnapshot,
  inputId: string,
): ValidationResult<GenerationInputSnapshot> {
  const input = resolveInput(snapshot, inputId);
  if (!input) {
    return failure(
      "input_not_found",
      `Generation input '${inputId}' was not found.`,
    );
  }
  if (input.inputType === "text" || !input.media) {
    return failure(
      "input_type_mismatch",
      `Generation input '${inputId}' is not a media input.`,
    );
  }
  return { ok: true, value: input };
}

/** Slots this input may occupy at all, which a single-slot input caps at one. */
function inputCapacity(input: GenerationInputSnapshot): number {
  return input.repeatable ? input.repeatable.max : 1;
}

export interface AttachAssetCommand {
  readonly inputId: string;
  readonly assetId: string;
  readonly at?: number;
  /** Per-item switches to apply to the item this attach creates. */
  readonly itemOptions?: Readonly<Record<string, boolean>>;
}

export interface AttachAssetPlan {
  readonly inputId: string;
  readonly slotId: string;
  readonly assetId: string;
  readonly moveTo: number | null;
  readonly itemOptions: readonly {
    readonly optionId: GenerationMediaItemOptionId;
    readonly value: boolean;
  }[];
}

/**
 * Refuse a change that would repack the batch while a slot is held open.
 *
 * Repacking (`writeRepeatableSlotValues`, and the tail-shift in
 * `clearMediaInput`) rewrites slots densely, which moves some *other* item
 * into the slot a producer is holding. Nothing cancels or rebases that
 * producer: both paths that reserve a slot — a frame capture and a timeline
 * selection confirm — write to the slot id they captured when they started,
 * unconditionally, seconds later. The item that got moved there would be
 * silently destroyed.
 *
 * So this is refused rather than reconciled. It is retryable and the caller
 * can see exactly when: `reservedSlotIds` is published, and the session
 * republishes when it changes.
 *
 * An *append* is not repacking — it writes one free slot and disturbs nothing —
 * so it stays allowed, which is what keeps the common case working while the
 * user is confirming a selection somewhere else in the batch.
 */
function refuseWhileReserved(
  input: GenerationInputSnapshot,
  what: string,
): ValidationResult<never> | null {
  const reserved = input.reservedSlotIds ?? [];
  if (reserved.length === 0) return null;
  return failure(
    "input_busy",
    `Input '${input.id}' cannot ${what} while ${reserved.length} slot${
      reserved.length === 1 ? " is" : "s are"
    } held open for media still being produced.`,
  );
}

/**
 * The slot an append lands in, or `null` when the input has none free.
 *
 * The same scan the batch strip's `slotIdAt` runs, and for the same reason:
 * slot ids are positional but occupancy is not the filled *count*. A slot the
 * panel is holding open for a value in flight is taken, and a batch can hold a
 * transient gap, so the count and the first free index can disagree.
 */
function findFreeSlotId(input: GenerationInputSnapshot): string | null {
  const key = slotKey(input);
  const taken = new Set<string>([
    ...(input.media ?? []).map((item) => item.slotId),
    ...(input.reservedSlotIds ?? []),
  ]);
  const max = inputCapacity(input);
  for (let index = 0; index < max; index += 1) {
    const slotId = buildRepeatableInputSlotId(key, index);
    if (!taken.has(slotId)) return slotId;
  }
  return null;
}

/**
 * Plan an attach.
 *
 * Position is expressed in ordinals, never in slot ids: the caller asks for a
 * delivery position and the host works out which slot that is, because the two
 * only agree while the batch is gapless and the panel is what keeps it so.
 */
export function validateAttachAssetCommand(
  snapshot: GenerationSessionSnapshot,
  asset: GenerationSessionAssetCandidate | null,
  command: AttachAssetCommand,
): ValidationResult<AttachAssetPlan> {
  const resolved = resolveMediaInput(snapshot, command.inputId);
  if (!resolved.ok) return resolved;
  const input = resolved.value;
  const media = input.media ?? [];

  if (!asset) {
    return failure(
      "asset_not_found",
      `Asset '${command.assetId}' is not in the project library.`,
    );
  }
  if (!canAttachAssetToMediaInput(input.inputType, asset)) {
    return failure(
      "asset_type_rejected",
      `Input '${input.id}' does not accept the ${asset.type} asset '${asset.name}'.`,
    );
  }

  // A single-slot input replaces rather than fills up, exactly as a drop on an
  // occupied slot does; only a batch can actually run out of room.
  const slotId = input.repeatable
    ? findFreeSlotId(input)
    : buildRepeatableInputSlotId(slotKey(input), 0);
  if (slotId === null) {
    return failure(
      "batch_full",
      `Input '${input.id}' has no free slot; it holds ${media.length} item${
        media.length === 1 ? "" : "s"
      } and its remaining slots are reserved.`,
    );
  }

  const appendAt = input.repeatable ? media.length : 0;
  const at = command.at ?? appendAt;
  if (!Number.isInteger(at) || at < 0 || at > appendAt) {
    return failure(
      "ordinal_out_of_range",
      `Input '${input.id}' takes an attach position between 0 and ${appendAt}.`,
    );
  }

  // Judged against the item this attach will create, so a caller can switch on
  // a reference it is attaching in the same breath — it cannot name the slot,
  // because the slot has no item in it yet.
  const offered = simulateAttachedItem(
    input,
    asset,
    input.repeatable ? null : (media[0] ?? null),
  ).options;
  const itemOptions: { optionId: GenerationMediaItemOptionId; value: boolean }[] =
    [];
  for (const [optionId, value] of Object.entries(command.itemOptions ?? {})) {
    if (!(optionId in offered)) {
      return failure(
        "option_not_available",
        `Input '${input.id}' does not offer the option '${optionId}' for '${asset.name}'.`,
      );
    }
    if (optionId !== "audio") {
      return failure(
        "option_not_available",
        `Option '${optionId}' has no host writer.`,
      );
    }
    itemOptions.push({ optionId, value });
  }

  // Only a *positioned* attach repacks: it is an append followed by a reorder.
  const moveTo = at === appendAt ? null : at;
  if (moveTo !== null) {
    const busy = refuseWhileReserved(input, "insert at a position");
    if (busy) return busy;
  }

  return {
    ok: true,
    value: {
      inputId: input.id,
      slotId,
      assetId: asset.id,
      moveTo,
      itemOptions,
    },
  };
}

export interface MoveMediaPlan {
  readonly inputId: string;
  readonly slotId: string;
  readonly toOrdinal: number;
}

export function validateMoveMediaCommand(
  snapshot: GenerationSessionSnapshot,
  inputId: string,
  fromOrdinal: number,
  toOrdinal: number,
): ValidationResult<MoveMediaPlan> {
  const resolved = resolveMediaInput(snapshot, inputId);
  if (!resolved.ok) return resolved;
  const input = resolved.value;
  if (!input.repeatable) {
    return failure(
      "input_not_repeatable",
      `Input '${input.id}' holds a single slot, so there is nothing to reorder.`,
    );
  }
  const busy = refuseWhileReserved(input, "reorder");
  if (busy) return busy;
  const media = input.media ?? [];
  const inRange = (ordinal: number) =>
    Number.isInteger(ordinal) && ordinal >= 0 && ordinal < media.length;
  if (!inRange(fromOrdinal) || !inRange(toOrdinal)) {
    return failure(
      "ordinal_out_of_range",
      `Input '${input.id}' holds ${media.length} items; ordinals run 0 to ${
        media.length - 1
      }.`,
    );
  }
  const item = media[fromOrdinal];
  return {
    ok: true,
    value: { inputId: input.id, slotId: item.slotId, toOrdinal },
  };
}

export interface RemoveMediaPlan {
  readonly inputId: string;
  readonly slotId: string;
}

export function validateRemoveMediaCommand(
  snapshot: GenerationSessionSnapshot,
  inputId: string,
  slotId: string,
): ValidationResult<RemoveMediaPlan> {
  const resolved = resolveMediaInput(snapshot, inputId);
  if (!resolved.ok) return resolved;
  const input = resolved.value;
  const item = (input.media ?? []).find(
    (candidate) => candidate.slotId === slotId,
  );
  if (!item) {
    return failure(
      "media_not_found",
      `Input '${input.id}' has nothing attached at slot '${slotId}'.`,
    );
  }
  // Clearing a repeatable slot shifts every later one down, which is repacking.
  if (input.repeatable) {
    const busy = refuseWhileReserved(input, "remove an item");
    if (busy) return busy;
  }
  return { ok: true, value: { inputId: input.id, slotId: item.slotId } };
}

export interface SetMediaOptionPlan {
  readonly inputId: string;
  readonly slotId: string;
  readonly optionId: GenerationMediaItemOptionId;
  readonly value: boolean;
}

/**
 * Resolve a per-item switch write.
 *
 * Addressed by slot alone because slot ids are unique across the panel, and
 * because the caller that wants to toggle a reference has the item, not the
 * input it happens to sit in.
 *
 * The gate is the item's own published `options`: the panel offers the switch
 * only where the rules declare it *and* the value can deliver a soundtrack, so
 * reading it back is exactly "would the strip render this control".
 */
export function validateSetMediaOptionCommand(
  snapshot: GenerationSessionSnapshot,
  slotId: string,
  optionId: string,
  value: boolean,
): ValidationResult<SetMediaOptionPlan> {
  for (const input of snapshot.inputs) {
    const item = (input.media ?? []).find(
      (candidate) => candidate.slotId === slotId,
    );
    if (!item) continue;
    if (!(optionId in item.options)) {
      return failure(
        "option_not_available",
        `Slot '${slotId}' does not offer the option '${optionId}'.`,
      );
    }
    if (optionId !== "audio") {
      return failure(
        "option_not_available",
        `Option '${optionId}' has no host writer.`,
      );
    }
    return {
      ok: true,
      value: { inputId: input.id, slotId, optionId, value },
    };
  }
  return failure(
    "media_not_found",
    `No generation input has media attached at slot '${slotId}'.`,
  );
}

/**
 * Replay one validated media change onto a snapshot.
 *
 * A transaction may stage several media changes, and each is judged against
 * the state the ones before it left — attaching twice must not plan the same
 * slot twice. Rather than teach the validators about a pending queue, the
 * service advances this working snapshot between them, so every validator
 * stays a pure function of one snapshot.
 *
 * Slot ids are positional: the store front-packs a batch whenever its
 * arrangement changes, so the item at ordinal *i* occupies slot *i*.
 * Renumbering after a removal, a move, or a positioned attach is what keeps the
 * simulation honest about the ids a later command may address; an append and an
 * option write leave the arrangement, and so the ids, alone.
 */
export function applyMediaCommitToSnapshot(
  snapshot: GenerationSessionSnapshot,
  commit: GenerationSessionMediaCommit,
  asset: GenerationSessionAssetCandidate | null,
): GenerationSessionSnapshot {
  const input = snapshot.inputs.find(
    (candidate) => candidate.id === commit.inputId,
  );
  if (!input) return snapshot;
  const media = [...(input.media ?? [])];

  switch (commit.kind) {
    case "attach": {
      if (!asset) return snapshot;
      const replaced = input.repeatable ? null : (media[0] ?? null);
      const base = simulateAttachedItem(input, asset, replaced);
      const item: GenerationMediaItemSnapshot = {
        ...base,
        slotId: commit.slotId,
        options: commit.itemOptions.reduce<Record<string, boolean>>(
          (options, option) => ({ ...options, [option.optionId]: option.value }),
          { ...base.options },
        ),
      };
      if (!input.repeatable) {
        return withMedia(snapshot, input, [item], { renumber: false });
      }
      media.splice(commit.moveTo ?? media.length, 0, item);
      // An append writes one slot and leaves every other alone, reservations
      // included. Only the reorder that follows a positioned attach rewrites
      // the batch, and `writeRepeatableSlotValues` front-packs when it does.
      return withMedia(snapshot, input, media, {
        renumber: commit.moveTo !== null,
      });
    }
    case "move": {
      const from = media.findIndex((item) => item.slotId === commit.slotId);
      if (from < 0) return snapshot;
      const [moved] = media.splice(from, 1);
      media.splice(commit.toOrdinal, 0, moved);
      return withMedia(snapshot, input, media, { renumber: true });
    }
    case "remove": {
      const at = media.findIndex((item) => item.slotId === commit.slotId);
      if (at < 0) return snapshot;
      media.splice(at, 1);
      return withMedia(snapshot, input, media, { renumber: true });
    }
    case "set-option":
      return withMedia(
        snapshot,
        input,
        media.map((item) =>
          item.slotId === commit.slotId
            ? {
                ...item,
                options: { ...item.options, [commit.optionId]: commit.value },
              }
            : item,
        ),
        { renumber: false },
      );
  }
}

/**
 * Replace one input's media list.
 *
 * `renumber` mirrors what the store does: a reorder or a clear rewrites the
 * whole batch front-packed, so slot ids move; a plain attach writes a single
 * slot and disturbs nothing else.
 *
 * A repacking commit is only ever planned for an input with no reservations
 * (see {@link refuseWhileReserved}), so the empty `reservedSlotIds` below is a
 * restatement of that precondition, not a claim that the commit cancelled a
 * producer — nothing here can.
 */
function withMedia(
  snapshot: GenerationSessionSnapshot,
  input: GenerationInputSnapshot,
  media: readonly GenerationMediaItemSnapshot[],
  { renumber }: { readonly renumber: boolean },
): GenerationSessionSnapshot {
  const next = media.map((item, index) => ({
    ...item,
    ...(renumber
      ? { slotId: buildRepeatableInputSlotId(slotKey(input), index) }
      : {}),
    ordinal: index,
  }));
  return {
    ...snapshot,
    inputs: snapshot.inputs.map((candidate) =>
      candidate.id === input.id
        ? {
            ...candidate,
            media: next,
            ...(renumber ? { reservedSlotIds: [] } : {}),
          }
        : candidate,
    ),
  };
}

/**
 * The item an attach will produce, as the store would build it.
 *
 * `slotId` and `ordinal` are placeholders — {@link withMedia} assigns the real
 * ones. What matters here is `options`, so that attaching a reference and
 * toggling its audio in the same transaction validates: the switch is offered
 * on exactly the terms the batch strip offers it, and a fresh attach starts
 * off unless the store's carry-forward rule applies.
 */
/**
 * The item an attach would create, as the panel will hold it.
 *
 * Shared with the staged draft editor so a projected attach and the committed
 * one agree: media type flips to `audio` for a video on an audio slot, the
 * audio switch is offered only where the input offers it, and `hasAudio` is
 * the asset's own answer rather than a guess. A draft deriving these itself
 * would show one thing and commit another.
 */
export function simulateAttachedItem(
  input: GenerationInputSnapshot,
  asset: GenerationSessionAssetCandidate,
  replaced: GenerationMediaItemSnapshot | null,
): GenerationMediaItemSnapshot {
  const deliversAudio =
    input.inputType === "audio" && assetMatchesType(asset, "video");
  const offersAudioOption =
    input.inputType === "video" &&
    input.repeatable?.optionIds.includes("audio") === true &&
    isVideoAssetWithAudio(asset);
  // Replacing a slot with the same asset keeps its switches, matching
  // `carryForwardItemOptions` in the store.
  const carried =
    replaced?.assetId === asset.id ? replaced.options.audio === true : false;
  return {
    slotId: "",
    ordinal: 0,
    source: "asset",
    assetId: asset.id,
    displayName: asset.name,
    mediaType: deliversAudio
      ? "audio"
      : asset.type === "video" || asset.type === "audio"
        ? asset.type
        : "image",
    hasAudio: assetMatchesType(asset, "audio")
      ? true
      : assetMatchesType(asset, "video")
        ? (asset.hasAudio ?? null)
        : false,
    options: offersAudioOption ? { audio: carried } : {},
    // A video landing on an audio slot starts extracting immediately.
    preparing: deliversAudio,
  };
}
