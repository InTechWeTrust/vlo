import { copyCapturedMedia, type GenerationCapturedMedia } from "../utils/capturedMedia";
import {
  applyMediaCommitToSnapshot,
  indexEditableWidgets,
  validateAttachAssetCommand,
  validateAttachCapturedMediaCommand,
  validateMoveMediaCommand,
  validateRemoveMediaCommand,
  validateSetMediaOptionCommand,
  validateTextInputCommand,
  validateWidgetCommand,
  widgetKey,
  widgetValueMatchesSnapshot,
  type ValidationResult,
} from "./generationSessionValidation";
import { createMediaItemId } from "../utils/mediaItemIds";
import type {
  GenerationAttachAssetOptions,
  GenerationEditableWidgetSnapshot,
  GenerationInputRepeatableSnapshot,
  GenerationInputSnapshot,
  GenerationMediaItemSnapshot,
  GenerationSessionAssetCandidate,
  GenerationSessionHost,
  GenerationSessionJsonValue,
  GenerationSessionMediaCommit,
  GenerationSessionPublication,
  GenerationSessionSnapshot,
  GenerationSessionTransaction,
  GenerationSessionWidgetCommit,
  GenerationTransactionFailureCode,
  GenerationTransactionOptions,
  GenerationTransactionResult,
  GenerationWidgetTarget,
} from "./generationSessionTypes";

/**
 * The generation-owned session service
 * (docs/generation-native-extension-seams-plan.md §3.2).
 *
 * It is mounted and unmounted by the generation feature and knows nothing
 * about extensions: no owner binding, no activation lifecycle, no SDK limits.
 * Native panel controls and the trusted extension adapter reach state changes
 * through the same `transaction` implementation, so both get the same
 * validation, the same atomicity, and the same failure codes.
 */

const MAX_LABEL_LENGTH = 120;

interface StagedTextCommand {
  readonly kind: "text";
  readonly inputId: string;
  readonly value: string;
}

interface StagedWidgetCommand {
  readonly kind: "widget";
  readonly target: GenerationWidgetTarget;
  readonly value: unknown;
}

interface StagedAttachCommand {
  readonly kind: "attach";
  readonly inputId: string;
  readonly assetId: string;
  readonly at?: number;
  readonly itemOptions?: Readonly<Record<string, boolean>>;
  readonly itemId?: string;
}

interface StagedMoveCommand {
  readonly kind: "move";
  readonly inputId: string;
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
}

interface StagedRemoveCommand {
  readonly kind: "remove";
  readonly inputId: string;
  readonly slotId: string;
}

interface StagedMediaOptionCommand {
  readonly kind: "media-option";
  readonly slotId: string;
  readonly optionId: string;
  readonly value: boolean;
}

type StagedMediaCommand =
  | StagedAttachCommand
  | (Omit<StagedAttachCommand, "kind" | "assetId"> & { readonly kind: "attach-capture"; readonly capture: GenerationCapturedMedia })
  | StagedMoveCommand
  | StagedRemoveCommand
  | StagedMediaOptionCommand;

type StagedCommand =
  | StagedTextCommand
  | StagedWidgetCommand
  | StagedMediaCommand;

function normalizeAttachOptions(options?: GenerationAttachAssetOptions): GenerationAttachAssetOptions {
  const at = options?.at;
  if (at !== undefined && !Number.isInteger(at)) {
    throw new Error("Generation attach positions must be integers.");
  }
  const itemOptions = options?.itemOptions;
  if (itemOptions !== undefined) {
    for (const [optionId, value] of Object.entries(itemOptions)) {
      if (optionId.trim().length === 0) {
        throw new Error("Generation option IDs must be non-empty strings.");
      }
      if (typeof value !== "boolean") {
        throw new Error("Generation media options take boolean values.");
      }
    }
  }
  const itemId = options?.itemId;
  if (itemId !== undefined && typeof itemId !== "string") {
    throw new Error("Generation media item IDs must be strings.");
  }
  return { at, itemId, itemOptions: itemOptions ? { ...itemOptions } : undefined };
}

function failure(
  label: string,
  code: GenerationTransactionFailureCode,
  message: string,
): GenerationTransactionResult {
  return { ok: false, code, message, label };
}

/**
 * Slot ids as the transaction opened on them, per input.
 *
 * Slot ids are positional, and every remove and move renumbers the batch
 * (`applyMediaCommitToSnapshot`). A caller can only address items by the ids it
 * read, so a sequence like "remove A, remove B" hands over two ids that were
 * valid together but never valid *in turn* — by the time the second is read,
 * the first removal has renamed it onto a different item. Left untranslated
 * that writes to the wrong asset, or fails `media_not_found`, with nothing to
 * tell the caller which.
 *
 * So the opening ids are kept in a list parallel to the working media and
 * advanced by the same structural moves. Position is the durable thing here:
 * entry *i* of this list is whatever the caller called item *i*, and the
 * working snapshot says what that item is called now. `null` marks a slot
 * minted inside this transaction, which the caller has no name for.
 */
type SlotAddressBook = Map<string, (string | null)[]>;

function openSlotAddressBook(
  snapshot: GenerationSessionSnapshot,
): SlotAddressBook {
  return new Map(
    snapshot.inputs.map((input) => [
      input.id,
      (input.media ?? []).map((item) => item.slotId),
    ]),
  );
}

/**
 * The slot a caller-supplied id names *now*, or `null` when it names nothing
 * the transaction opened on.
 *
 * `null` must not fall back to the raw id. Slot ids are positional and get
 * reused: after removing slot 0 of `[A, B]`, the id that named A now names B,
 * so passing it through would let a repeated removal silently take a second
 * item instead of failing, and would let a caller guess its way onto a slot
 * this transaction created — the one thing the contract says it cannot
 * address. An id absent from the address book was never addressable, which is
 * exactly `media_not_found`.
 *
 * Searched across inputs because `setMediaOption` addresses a slot without an
 * input id. Slot ids are derived from the input id, so they are unique panel-
 * wide and the search cannot be ambiguous.
 */
function resolveOpeningSlotId(
  addresses: SlotAddressBook,
  working: GenerationSessionSnapshot,
  slotId: string,
): string | null {
  for (const [inputId, opening] of addresses) {
    const index = opening.indexOf(slotId);
    if (index === -1) continue;
    const input = working.inputs.find((candidate) => candidate.id === inputId);
    return input?.media?.[index]?.slotId ?? null;
  }
  return null;
}

/**
 * Mirror one commit's structural change onto the address book.
 *
 * Must run against the working snapshot *before* the commit is applied to it,
 * so the affected index is still the one the commit named.
 */
function advanceSlotAddressBook(
  addresses: SlotAddressBook,
  working: GenerationSessionSnapshot,
  commit: GenerationSessionMediaCommit,
): void {
  const opening = addresses.get(commit.inputId);
  if (!opening) return;
  const input = working.inputs.find(
    (candidate) => candidate.id === commit.inputId,
  );
  if (!input) return;
  const media = input.media ?? [];
  switch (commit.kind) {
    case "attach":
    case "attach-capture":
      // A single-slot input replaces what it holds, so every previous address
      // is gone; a batch inserts where the commit says it lands.
      if (!input.repeatable) {
        opening.length = 0;
        opening.push(null);
        return;
      }
      opening.splice(commit.moveTo ?? media.length, 0, null);
      return;
    case "remove": {
      const at = media.findIndex((item) => item.slotId === commit.slotId);
      if (at >= 0) opening.splice(at, 1);
      return;
    }
    case "move": {
      const from = media.findIndex((item) => item.slotId === commit.slotId);
      if (from < 0) return;
      const [moved] = opening.splice(from, 1);
      opening.splice(commit.toOrdinal, 0, moved);
      return;
    }
    case "set-option":
      // Values only; the arrangement is untouched.
      return;
  }
}

/**
 * Is every slot id still naming what it named, across all inputs?
 *
 * Deliberately narrower than `sameInputs`, which also compares labels,
 * descriptions and text values. None of those can invalidate a slot id, and
 * refusing a media write because an unrelated prompt changed under the
 * callback would be a spurious failure the caller cannot act on.
 *
 * Two things matter, and only two: the ordered slot ids, which are the
 * addresses themselves, and the asset in each slot — a swap in place keeps the
 * address valid while changing what the caller was pointing at, and "remove
 * this slot" meant "remove that item".
 */
function sameMediaArrangement(
  left: readonly GenerationInputSnapshot[],
  right: readonly GenerationInputSnapshot[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((input, index) => {
    const other = right[index];
    if (input.id !== other.id) return false;
    const before = input.media ?? [];
    const after = other.media ?? [];
    return (
      before.length === after.length &&
      before.every(
        (item, slot) =>
          item.slotId === after[slot].slotId &&
          item.itemId === after[slot].itemId &&
          item.assetId === after[slot].assetId,
      )
    );
  });
}

/** Commands that address media, and so depend on slot ids holding still. */
function isMediaCommand(command: StagedCommand): command is StagedMediaCommand {
  return (
    command.kind === "attach" ||
    command.kind === "attach-capture" ||
    command.kind === "move" ||
    command.kind === "remove" ||
    command.kind === "media-option"
  );
}

/**
 * Would this command leave the panel exactly as it found it?
 *
 * Only the two commands that can genuinely address their own current state: a
 * reorder onto the position an item already holds (which `moveMediaInput`
 * itself early-returns on) and a switch written to the value it already has.
 * An attach always rewrites its slot's value — re-attaching the same asset
 * restarts extraction — and a remove is only planned for a slot that holds
 * something, so neither can be inert.
 */
function isMediaNoOp(
  snapshot: GenerationSessionSnapshot,
  commit: GenerationSessionMediaCommit,
): boolean {
  const input = snapshot.inputs.find(
    (candidate) => candidate.id === commit.inputId,
  );
  const item = (input?.media ?? []).find(
    (candidate) => candidate.slotId === commit.slotId,
  );
  if (commit.kind === "move") return item?.ordinal === commit.toOrdinal;
  if (commit.kind === "set-option") {
    return item?.options[commit.optionId] === commit.value;
  }
  return false;
}

function requireId(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${what} must be non-empty strings.`);
  }
  return value.trim();
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function sameOptions(
  left: readonly (string | number | boolean)[] | null,
  right: readonly (string | number | boolean)[] | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((option, index) => Object.is(option, right[index]));
}

/**
 * Every field validation reads has to take part in this comparison — a widget
 * whose constraints changed but whose value did not must still republish, or
 * `transaction` keeps judging writes against the old constraints.
 */
function sameEditableWidgets(
  left: readonly GenerationEditableWidgetSnapshot[],
  right: readonly GenerationEditableWidgetSnapshot[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((widget, index) => {
    const other = right[index];
    return (
      widget.target.nodeId === other.target.nodeId &&
      widget.target.widget === other.target.widget &&
      widget.valueType === other.valueType &&
      Object.is(widget.value, other.value) &&
      widget.min === other.min &&
      widget.max === other.max &&
      Object.is(widget.trueValue, other.trueValue) &&
      Object.is(widget.falseValue, other.falseValue) &&
      sameOptions(widget.options, other.options)
    );
  });
}

function sameMediaItems(
  left: readonly GenerationMediaItemSnapshot[] | undefined,
  right: readonly GenerationMediaItemSnapshot[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    const optionIds = Object.keys(item.options);
    return (
      item.slotId === other.slotId &&
      item.itemId === other.itemId &&
      item.ordinal === other.ordinal &&
      item.source === other.source &&
      item.assetId === other.assetId &&
      item.displayName === other.displayName &&
      item.mediaType === other.mediaType &&
      item.hasAudio === other.hasAudio &&
      item.preparing === other.preparing &&
      optionIds.length === Object.keys(other.options).length &&
      optionIds.every((id) => item.options[id] === other.options[id])
    );
  });
}

function sameSlotIds(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true;
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every((slotId, index) => slotId === right?.[index]);
}

function sameRepeatable(
  left: GenerationInputRepeatableSnapshot | undefined,
  right: GenerationInputRepeatableSnapshot | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.max === right.max &&
    left.optionIds.length === right.optionIds.length &&
    left.optionIds.every((id, index) => id === right.optionIds[index])
  );
}

function sameInputs(
  left: readonly GenerationInputSnapshot[],
  right: readonly GenerationInputSnapshot[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((input, index) => {
    const other = right[index];
    return (
      input.id === other.id &&
      input.nodeId === other.nodeId &&
      input.param === other.param &&
      input.label === other.label &&
      input.description === other.description &&
      input.inputType === other.inputType &&
      input.value === other.value &&
      sameRepeatable(input.repeatable, other.repeatable) &&
      // Attaching, reordering, clearing, or toggling a reference has to
      // republish: the media projection is the only thing that carries it, and
      // every other field can sit still through all four. So does a slot being
      // reserved or released, which decides where the next attach lands.
      sameMediaItems(input.media, other.media) &&
      sameSlotIds(input.reservedSlotIds, other.reservedSlotIds)
    );
  });
}

function pickInputs(
  inputs: readonly GenerationInputSnapshot[],
  ids: readonly string[],
): readonly GenerationInputSnapshot[] {
  const wanted = new Set(ids);
  return inputs.filter((input) => wanted.has(input.id));
}

function pickWidgets(
  widgets: readonly GenerationEditableWidgetSnapshot[],
  targets: readonly GenerationWidgetTarget[],
): readonly GenerationEditableWidgetSnapshot[] {
  const wanted = new Set(targets.map(widgetKey));
  return widgets.filter((widget) => wanted.has(widgetKey(widget.target)));
}

function samePublication(
  snapshot: GenerationSessionSnapshot,
  next: GenerationSessionPublication,
): boolean {
  return (
    snapshot.workflow.sourceId === next.sourceId &&
    snapshot.workflow.instanceId === next.instanceId &&
    snapshot.workflow.fingerprint === next.fingerprint &&
    snapshot.workflow.mode === next.mode &&
    snapshot.workflow.nodes === next.nodes &&
    sameInputs(snapshot.inputs, next.inputs) &&
    sameEditableWidgets(snapshot.editableWidgets, next.editableWidgets) &&
    snapshot.readiness.isLoading === next.readiness.isLoading &&
    snapshot.readiness.isReady === next.readiness.isReady &&
    snapshot.readiness.hasError === next.readiness.hasError &&
    snapshot.submission.isBusy === next.submission.isBusy &&
    snapshot.submission.queuedCount === next.submission.queuedCount &&
    snapshot.submission.canSubmit === next.submission.canSubmit
  );
}

/**
 * Has the *mounted workflow* changed, as opposed to a value inside it?
 *
 * Deliberately fingerprint-based rather than node-array-identity based: a
 * re-sync rebuilds the catalogue whenever graph data is replaced, and a widget
 * value moving is not a new workflow. The session revision still advances for
 * those, so a subscriber sees the fresh values either way.
 */
function workflowChanged(
  snapshot: GenerationSessionSnapshot,
  next: GenerationSessionPublication,
): boolean {
  return (
    snapshot.workflow.sourceId !== next.sourceId ||
    snapshot.workflow.instanceId !== next.instanceId ||
    snapshot.workflow.fingerprint !== next.fingerprint ||
    snapshot.workflow.mode !== next.mode
  );
}

export class GenerationSessionService {
  private host: GenerationSessionHost | null = null;
  private snapshot: GenerationSessionSnapshot | null = null;
  private revision = 0;
  private workflowRevision = 0;
  private readonly listeners = new Set<() => void>();

  /**
   * Mount the session. The returned disposer clears the snapshot and notifies
   * subscribers, so a consumer that kept a snapshot can tell it went stale.
   */
  mount(host: GenerationSessionHost): () => void {
    this.host = host;
    return () => {
      if (this.host !== host) return;
      this.host = null;
      if (this.snapshot === null) return;
      this.snapshot = null;
      // Losing the session is a revision change like any other: a
      // `useSyncExternalStore` consumer that snapshots `getRevision` must see
      // a new value here, or it keeps rendering the unmounted session.
      this.revision += 1;
      this.notify();
    };
  }

  isMounted(): boolean {
    return this.host !== null;
  }

  /** Publish the mounted feature's current view. Ignored while unmounted. */
  publish(publication: GenerationSessionPublication): void {
    if (!this.host) return;

    const current = this.snapshot;
    if (current && samePublication(current, publication)) return;

    if (!current || workflowChanged(current, publication)) {
      this.workflowRevision += 1;
    }
    this.revision += 1;

    this.snapshot = Object.freeze({
      revision: this.revision,
      workflow: Object.freeze({
        sourceId: publication.sourceId,
        instanceId: publication.instanceId,
        revision: this.workflowRevision,
        fingerprint: publication.fingerprint,
        mode: publication.mode,
        nodes: publication.nodes,
      }),
      inputs: Object.freeze([...publication.inputs]),
      editableWidgets: Object.freeze([...publication.editableWidgets]),
      readiness: Object.freeze({ ...publication.readiness }),
      submission: Object.freeze({ ...publication.submission }),
    }) as GenerationSessionSnapshot;

    this.notify();
  }

  getSnapshot(): GenerationSessionSnapshot | null {
    return this.snapshot;
  }

  /** Monotonic per-mount revision; changes whenever the snapshot changes. */
  getRevision(): number {
    return this.revision;
  }

  /** Payload-free notification, matching `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Stage commands, validate every one against the current snapshot, then
   * commit them in a single host write. If any command is invalid, none apply.
   */
  transaction(
    label: string,
    callback: (transaction: GenerationSessionTransaction) => void,
    options: GenerationTransactionOptions = {},
  ): GenerationTransactionResult {
    if (typeof label !== "string") {
      return failure("", "invalid_label", "Generation labels must be strings.");
    }
    const normalizedLabel = label.trim();
    if (
      normalizedLabel.length === 0 ||
      normalizedLabel.length > MAX_LABEL_LENGTH
    ) {
      return failure(
        normalizedLabel,
        "invalid_label",
        `Generation labels must contain 1-${MAX_LABEL_LENGTH} characters.`,
      );
    }

    // Pin the transaction to the session it started against. The callback is
    // arbitrary code: it can unmount the panel, remount another one, or switch
    // workflows, and a write staged against one workflow must never land on
    // another — least of all one that happens to reuse the same node ids.
    const host = this.host;
    const startSnapshot = this.snapshot;
    if (!host || !startSnapshot) {
      return failure(
        normalizedLabel,
        "unavailable",
        "The generation panel is not mounted.",
      );
    }

    const staged: StagedCommand[] = [];
    let isOpen = true;
    const transaction: GenerationSessionTransaction = {
      setTextInput: (inputId, value) => {
        if (!isOpen) throw new Error("The generation transaction is closed.");
        if (typeof inputId !== "string" || inputId.trim().length === 0) {
          throw new Error("Generation input IDs must be non-empty strings.");
        }
        if (typeof value !== "string") {
          throw new Error("Generation text values must be strings.");
        }
        staged.push({ kind: "text", inputId: inputId.trim(), value });
      },
      setWidget: (target, value) => {
        if (!isOpen) throw new Error("The generation transaction is closed.");
        const nodeId =
          typeof target?.nodeId === "string" ? target.nodeId.trim() : "";
        const widget =
          typeof target?.widget === "string" ? target.widget.trim() : "";
        if (nodeId.length === 0 || widget.length === 0) {
          throw new Error(
            "Generation widget targets need a node id and a widget name.",
          );
        }
        staged.push({ kind: "widget", target: { nodeId, widget }, value });
      },
      attachAsset: (inputId, assetId, options) => {
        if (!isOpen) throw new Error("The generation transaction is closed.");
        const normalizedInputId = requireId(inputId, "Generation input IDs");
        const normalizedAssetId = requireId(assetId, "Asset IDs");
        const { at, itemOptions, itemId } = normalizeAttachOptions(options);
        staged.push({
          kind: "attach",
          inputId: normalizedInputId,
          assetId: normalizedAssetId,
          ...(at === undefined ? {} : { at }),
          ...(itemOptions === undefined ? {} : { itemOptions }),
          ...(itemId === undefined ? {} : { itemId }),
        });
      },
      attachCapturedMedia: (inputId, capture, options) => {
        if (!isOpen) throw new Error("The generation transaction is closed.");
        const normalizedInputId = requireId(inputId, "Generation input IDs");
        const { at, itemOptions, itemId } = normalizeAttachOptions(options);
        staged.push({
          kind: "attach-capture",
          inputId: normalizedInputId,
          capture: copyCapturedMedia(capture),
          ...(at === undefined ? {} : { at }),
          ...(itemOptions === undefined ? {} : { itemOptions }),
          ...(itemId === undefined ? {} : { itemId }),
        });
      },
      moveMedia: (inputId, fromOrdinal, toOrdinal) => {
        if (!isOpen) throw new Error("The generation transaction is closed.");
        const normalizedInputId = requireId(inputId, "Generation input IDs");
        if (!Number.isInteger(fromOrdinal) || !Number.isInteger(toOrdinal)) {
          throw new Error("Generation media ordinals must be integers.");
        }
        staged.push({
          kind: "move",
          inputId: normalizedInputId,
          fromOrdinal,
          toOrdinal,
        });
      },
      removeMedia: (inputId, slotId) => {
        if (!isOpen) throw new Error("The generation transaction is closed.");
        staged.push({
          kind: "remove",
          inputId: requireId(inputId, "Generation input IDs"),
          slotId: requireId(slotId, "Generation slot IDs"),
        });
      },
      setMediaOption: (slotId, optionId, value) => {
        if (!isOpen) throw new Error("The generation transaction is closed.");
        if (typeof value !== "boolean") {
          throw new Error("Generation media options take boolean values.");
        }
        staged.push({
          kind: "media-option",
          slotId: requireId(slotId, "Generation slot IDs"),
          optionId: requireId(optionId, "Generation option IDs"),
          value,
        });
      },
    };

    try {
      const callbackResult = callback(transaction);
      if (isPromiseLike(callbackResult)) {
        return failure(
          normalizedLabel,
          "invalid_command",
          "Generation transactions must be synchronous.",
        );
      }
    } catch (error) {
      return failure(
        normalizedLabel,
        "callback_failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      isOpen = false;
    }

    const snapshot = this.snapshot;
    if (this.host !== host || !snapshot) {
      return failure(
        normalizedLabel,
        "unavailable",
        "The generation panel was unmounted while the transaction ran.",
      );
    }
    if (snapshot.workflow.revision !== startSnapshot.workflow.revision) {
      return failure(
        normalizedLabel,
        "workflow_changed",
        "The mounted workflow changed while the transaction ran.",
      );
    }
    // A media change under the same workflow does not bump the workflow
    // revision — `workflowChanged` compares identity, not values — so the
    // check above does not catch the panel republishing its inputs under the
    // callback. It has to be caught here, because every staged slot id names
    // the arrangement the transaction opened on: translating them against
    // inputs the caller never saw is exactly the silent wrong-target write
    // this addressing model exists to prevent.
    if (
      staged.some(isMediaCommand) &&
      !sameMediaArrangement(startSnapshot.inputs, snapshot.inputs)
    ) {
      return failure(
        normalizedLabel,
        "session_changed",
        "The panel's inputs changed while the transaction ran; re-read the session and try again.",
      );
    }

    // A caller that read inputs to decide what to write — prompt text numbered
    // against a media arrangement — is refused on any change to them, not just
    // a slot renumbering: a toggled soundtrack or an edited prompt invalidates
    // what it resolved as surely as a reorder does.
    if (
      (options.dependsOnInputs &&
        !sameInputs(
          pickInputs(startSnapshot.inputs, options.dependsOnInputs),
          pickInputs(snapshot.inputs, options.dependsOnInputs),
        )) ||
      (options.dependsOnWidgets &&
        !sameEditableWidgets(
          pickWidgets(startSnapshot.editableWidgets, options.dependsOnWidgets),
          pickWidgets(snapshot.editableWidgets, options.dependsOnWidgets),
        ))
    ) {
      return failure(
        normalizedLabel,
        "session_changed",
        "The inputs or widgets this write depends on changed while it was prepared; re-read the session and try again.",
      );
    }

    // Same workflow, so validate against the snapshot as it stands now: values
    // may have moved under the callback, and the freshest ones are the ones
    // the commit has to agree with.
    const editableIndex = indexEditableWidgets(snapshot.editableWidgets);

    const textInputs = new Map<string, string>();
    const widgetCommits = new Map<string, GenerationSessionWidgetCommit>();
    const mediaCommits: GenerationSessionMediaCommit[] = [];
    // Media changes are sequential and each depends on the last, so they are
    // judged against a snapshot that advances with them rather than the one
    // the transaction opened on. Text and widget writes are independent of
    // media, so they keep reading the published snapshot.
    let working = snapshot;
    // Seeded from the same snapshot `working` starts at, so the two describe
    // one arrangement. Seeding from `startSnapshot` instead would pair a list
    // taken before the callback with media read after it.
    const addresses = openSlotAddressBook(snapshot);

    for (const command of staged) {
      if (command.kind === "text") {
        const result = validateTextInputCommand(snapshot, command.inputId);
        if (!result.ok) {
          return failure(
            normalizedLabel,
            result.failure.code,
            result.failure.message,
          );
        }
        textInputs.set(result.value, command.value);
        continue;
      }

      if (command.kind === "widget") {
        const result = validateWidgetCommand(
          snapshot,
          editableIndex,
          command.target,
          command.value,
        );
        if (!result.ok) {
          return failure(
            normalizedLabel,
            result.failure.code,
            result.failure.message,
          );
        }
        // Later writes to the same target win, matching the graph bridge's
        // sequential apply order.
        widgetCommits.set(widgetKey(command.target), {
          target: command.target,
          value: result.value,
        });
        continue;
      }

      // Translated before validation, so every validator keeps reading a slot
      // id that is live in `working` and none of them has to know that the
      // caller's ids are one arrangement behind.
      const addressed = this.readdressMediaCommand(addresses, working, command);
      if (!addressed.ok) {
        return failure(
          normalizedLabel,
          addressed.failure.code,
          addressed.failure.message,
        );
      }
      const planned = this.planMediaCommand(working, host, addressed.value);
      if (!planned.ok) {
        return failure(
          normalizedLabel,
          planned.failure.code,
          planned.failure.message,
        );
      }
      // A command that validates but moves nothing is dropped rather than
      // committed, the way an unchanged text write is: `changed` is what an
      // extension gates follow-up work on, so it has to mean something moved.
      if (isMediaNoOp(working, planned.value.commit)) continue;
      mediaCommits.push(planned.value.commit);
      advanceSlotAddressBook(addresses, working, planned.value.commit);
      working = applyMediaCommitToSnapshot(
        working,
        planned.value.commit,
        planned.value.asset,
      );
    }

    const changedTextInputs = new Map<string, string>();
    for (const [inputId, value] of textInputs) {
      const input = snapshot.inputs.find(
        (candidate) => candidate.id === inputId,
      );
      if (input?.value !== value) changedTextInputs.set(inputId, value);
    }

    const widgets = [...widgetCommits.values()];
    const changedWidgets = widgets.filter(
      (commit) =>
        !widgetValueMatchesSnapshot(
          editableIndex,
          commit.target,
          commit.value as GenerationSessionJsonValue,
        ),
    );

    if (
      changedTextInputs.size === 0 &&
      widgets.length === 0 &&
      mediaCommits.length === 0
    ) {
      return { ok: true, changed: false, label: normalizedLabel };
    }

    // Widget writes always reach the host, even when the snapshot already
    // shows the value: the panel owns the live value and dedupes it there,
    // and the snapshot can trail a keystroke by a render.
    host.commit({
      textInputs: changedTextInputs,
      widgets,
      media: mediaCommits,
    });
    return {
      ok: true,
      changed:
        changedTextInputs.size > 0 ||
        changedWidgets.length > 0 ||
        // No-ops were dropped above, so anything left here moves something.
        mediaCommits.length > 0,
      label: normalizedLabel,
    };
  }

  /**
   * Restate one staged command in the working snapshot's own slot ids.
   *
   * Only the id-addressed commands need it. `attach` names an input, and
   * `move` names ordinals — a position stays a position however the batch was
   * renumbered, so translating one would be wrong rather than merely
   * unnecessary.
   */
  private readdressMediaCommand(
    addresses: SlotAddressBook,
    working: GenerationSessionSnapshot,
    command: StagedMediaCommand,
  ): ValidationResult<StagedMediaCommand> {
    if (command.kind !== "remove" && command.kind !== "media-option") {
      return { ok: true, value: command };
    }
    const slotId = resolveOpeningSlotId(addresses, working, command.slotId);
    if (slotId === null) {
      // Worded as the validators word it, so a caller cannot tell whether the
      // slot was never there or has already been consumed — from the caller's
      // side those are the same mistake, and the same repair.
      return {
        ok: false,
        failure: {
          code: "media_not_found",
          message:
            command.kind === "remove"
              ? `Input '${command.inputId}' has nothing attached at slot '${command.slotId}'.`
              : `No generation input has media attached at slot '${command.slotId}'.`,
        },
      };
    }
    return {
      ok: true,
      value: slotId === command.slotId ? command : { ...command, slotId },
    };
  }

  /**
   * Validate one staged media command against the working snapshot, resolving
   * the asset an attach names through the host's library.
   */
  private planMediaCommand(
    working: GenerationSessionSnapshot,
    host: GenerationSessionHost,
    command: StagedMediaCommand,
  ): ValidationResult<{
    readonly commit: GenerationSessionMediaCommit;
    readonly asset: GenerationSessionAssetCandidate | null;
  }> {
    switch (command.kind) {
      case "attach": {
        const asset = host.resolveAsset(command.assetId);
        // Minted here rather than by the store so the working snapshot, the
        // commit, and the item the panel ends up holding all carry one id.
        const result = validateAttachAssetCommand(working, asset, {
          ...command,
          itemId: command.itemId ?? createMediaItemId(),
        });
        if (!result.ok) return result;
        return {
          ok: true,
          value: {
            commit: { kind: "attach", ...result.value },
            asset,
          },
        };
      }
      case "attach-capture": {
        const result = validateAttachCapturedMediaCommand(working, command.capture, {
          ...command,
          itemId: command.itemId ?? createMediaItemId(),
        });
        if (!result.ok) return result;
        return {
          ok: true, value: {
            commit: { kind: "attach-capture", ...result.value, capture: command.capture },
            asset: null,
          }
        };
      }
      case "move": {
        const result = validateMoveMediaCommand(
          working,
          command.inputId,
          command.fromOrdinal,
          command.toOrdinal,
        );
        if (!result.ok) return result;
        return {
          ok: true,
          value: { commit: { kind: "move", ...result.value }, asset: null },
        };
      }
      case "remove": {
        const result = validateRemoveMediaCommand(
          working,
          command.inputId,
          command.slotId,
        );
        if (!result.ok) return result;
        return {
          ok: true,
          value: { commit: { kind: "remove", ...result.value }, asset: null },
        };
      }
      case "media-option": {
        const result = validateSetMediaOptionCommand(
          working,
          command.slotId,
          command.optionId,
          command.value,
        );
        if (!result.ok) return result;
        return {
          ok: true,
          value: {
            commit: { kind: "set-option", ...result.value },
            asset: null,
          },
        };
      }
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

/** The single mounted generation session. */
export const generationSessionService = new GenerationSessionService();
