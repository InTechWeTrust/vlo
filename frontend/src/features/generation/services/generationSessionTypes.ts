import type {
  GenerationEffectJsonValue,
  GenerationWidgetTarget,
} from "../pipeline/types";
import type { WidgetValueType } from "../types";
import type { Asset } from "../../../types/Asset";

/**
 * The owner-neutral generation session contract
 * (docs/generation-native-extension-seams-plan.md §3.1–§3.2).
 *
 * Nothing here knows about extensions: the generation feature mounts the
 * session, native panel controls write through it, and a trusted adapter may
 * later project it. Snapshots are immutable and detached — a consumer holding
 * one can never write back through it.
 */

export type GenerationSessionJsonValue = GenerationEffectJsonValue;
export type { GenerationWidgetTarget };

/** How the mounted workflow was obtained. */
export type GenerationWorkflowSourceMode = "catalogue" | "temporary" | "manual";

/** One widget-backed parameter of a node, as discovered from the graph. */
export interface GenerationWidgetSnapshot {
  readonly nodeId: string;
  readonly param: string;
  readonly valueType: WidgetValueType;
  /** Current value, or `null` when the graph carries nothing representable. */
  readonly value: GenerationSessionJsonValue | null;
  readonly defaultValue: GenerationSessionJsonValue | null;
  readonly options: readonly (string | number | boolean)[] | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly step: number | null;
  /** Fed by a node connection, so it carries no editable widget value. */
  readonly linked: boolean;
  /** Occupies a `[value, mode]` slot pair and can be randomized per run. */
  readonly controlAfterGenerate: boolean;
}

export interface GenerationNodeSnapshot {
  /** Execution id: `<id>`, or `<instanceId>:<innerId>` inside a subgraph. */
  readonly id: string;
  readonly classType: string;
  readonly title: string;
  /** LiteGraph node mode: 0 = always, 2 = muted, 4 = bypassed. */
  readonly mode: number;
  readonly widgets: readonly GenerationWidgetSnapshot[];
}

export interface GenerationWorkflowSnapshot {
  readonly sourceId: string | null;
  /**
   * The ComfyUI bridge's workflow instance id, or `null` before the iframe has
   * reported identity. (The plan sketches this as a bare `string`; the mounted
   * session can legitimately exist before the bridge has answered, and callers
   * that pin work to an instance must handle that.)
   */
  readonly instanceId: string | null;
  /** Bumps whenever workflow identity or the node catalogue changes. */
  readonly revision: number;
  readonly fingerprint: string;
  readonly mode: GenerationWorkflowSourceMode;
  readonly nodes: readonly GenerationNodeSnapshot[];
}

/** Where one attached media item's value came from. */
export type GenerationMediaItemSource = "asset" | "timeline-selection" | "frame";

/**
 * One occupied slot of a media input, as the graph will receive it.
 *
 * Detached: an asset is named by id, never handed over, and nothing here is a
 * `File`, an object URL, or a live store reference.
 */
export interface GenerationMediaItemSnapshot {
  /**
   * The address every media write takes — **positional, not an identity**.
   *
   * A repeatable input's slot ids are derived from position
   * (`buildRepeatableInputSlotId`: `142:images`, then `142:images::repeat::1`),
   * and the store front-packs the batch whenever the *arrangement* changes, so
   * removing or moving an item **reassigns the slot ids of everything after
   * it**. An append and an option write renumber nothing. The id here names the
   * item only for as long as the batch stands still.
   *
   * Within one transaction that is handled for you: the ids you read from a
   * snapshot keep naming the items you meant, and the transaction translates
   * them as its own commands renumber the batch. Across transactions they do
   * not — re-read the snapshot rather than storing a slot id and coming back
   * to it, and see `GenerationSessionTransaction` for what happens when the
   * panel moves underneath one.
   */
  readonly slotId: string;
  /**
   * Occurrence identity — **stable, not an address**
   * (docs/minimax-ref2v-prompt-composer-plan.md §3.1).
   *
   * Minted when the media is attached and kept through reorders, compaction,
   * option changes and preparation. Replacing the slot's media mints a new
   * one, and the same asset attached twice has two. Never a write address:
   * writes still take `slotId`, resolved against the transaction's snapshot.
   */
  readonly itemId: string;
  /**
   * Position among *filled* slots — the delivery position, and the number a
   * reference tag's ordinal counts. Never infer this from `slotId`.
   */
  readonly ordinal: number;
  readonly source: GenerationMediaItemSource;
  /** Library assets only; absent for a frame capture or a timeline selection. */
  readonly assetId?: string;
  readonly displayName: string;
  /** What the slot delivers: a video on an audio slot presents as `audio`. */
  readonly mediaType: "image" | "video" | "audio";
  /**
   * The item really carries a soundtrack. `null` where the host cannot yet
   * know — an unrendered timeline selection, or a video ingested before
   * `hasAudio` was probed.
   */
  readonly hasAudio: boolean | null;
  /** Per-item switches this input offers for this item, e.g. `audio`. */
  readonly options: Readonly<Record<string, boolean>>;
  /** Still rendering or extracting, so its value is not final. */
  readonly preparing: boolean;
}

/** A media input that holds an ordered batch rather than a single item. */
export interface GenerationInputRepeatableSnapshot {
  readonly max: number;
  /** Per-item switch ids this input offers, e.g. `["audio"]`. */
  readonly optionIds: readonly string[];
}

/** A panel input slot (prompt text or a media slot). */
export interface GenerationInputSnapshot {
  readonly id: string;
  readonly nodeId: string;
  readonly param: string;
  readonly label: string;
  readonly description?: string;
  readonly inputType: "text" | "image" | "video" | "audio";
  /** Present for text inputs only. */
  readonly value?: string;
  /** Repeatable (batch) media inputs only. */
  readonly repeatable?: GenerationInputRepeatableSnapshot;
  /** Media inputs only: the occupied slots, in delivery order. */
  readonly media?: readonly GenerationMediaItemSnapshot[];
  /**
   * Slots spoken for by work that has produced no value yet — a timeline
   * selection rendering, a frame being captured.
   *
   * They are not in `media` because there is nothing to describe and nothing
   * to deliver, but they are *taken*: an append skips them, exactly as the
   * panel's own batch strip does, or the value on its way would be overwritten
   * by the attach and then overwrite the attach in turn.
   */
  readonly reservedSlotIds?: readonly string[];
}

/**
 * A widget the mounted panel can actually write. The node catalogue is wider
 * than this: it describes everything in the graph, while only bound widgets
 * have a control whose value reaches the submitted prompt.
 */
export interface GenerationEditableWidgetSnapshot {
  readonly target: GenerationWidgetTarget;
  readonly valueType: WidgetValueType;
  readonly value: GenerationSessionJsonValue | null;
  readonly options: readonly (string | number | boolean)[] | null;
  readonly min: number | null;
  readonly max: number | null;
  /** Values a boolean widget serializes to, when the rules override them. */
  readonly trueValue: GenerationSessionJsonValue | null;
  readonly falseValue: GenerationSessionJsonValue | null;
}

export interface GenerationSessionReadiness {
  readonly isLoading: boolean;
  readonly isReady: boolean;
  /**
   * The mounted workflow failed to load. Distinct from "not ready yet": no
   * further readiness arrives without the user retrying or picking another
   * workflow, which a consumer waiting on the session has to be able to tell.
   */
  readonly hasError: boolean;
}

export interface GenerationSessionSubmission {
  readonly isBusy: boolean;
  readonly queuedCount: number;
  /**
   * The panel would accept a submission right now. Wider than readiness: it
   * also covers the ComfyUI connection and the workflow's required inputs, so
   * a consumer must not derive it from `readiness` alone.
   */
  readonly canSubmit: boolean;
}

export interface GenerationSessionSnapshot {
  /** Monotonic per-mount counter; bumps on every published change. */
  readonly revision: number;
  readonly workflow: GenerationWorkflowSnapshot;
  readonly inputs: readonly GenerationInputSnapshot[];
  readonly editableWidgets: readonly GenerationEditableWidgetSnapshot[];
  readonly readiness: GenerationSessionReadiness;
  readonly submission: GenerationSessionSubmission;
}

/** What the mounting feature publishes; the service derives revisions. */
export interface GenerationSessionPublication {
  readonly sourceId: string | null;
  readonly instanceId: string | null;
  readonly fingerprint: string;
  readonly mode: GenerationWorkflowSourceMode;
  /**
   * Stable identity matters: the service treats a new array identity as a
   * workflow-revision bump, so callers should memoize the catalogue.
   */
  readonly nodes: readonly GenerationNodeSnapshot[];
  readonly inputs: readonly GenerationInputSnapshot[];
  readonly editableWidgets: readonly GenerationEditableWidgetSnapshot[];
  readonly readiness: GenerationSessionReadiness;
  readonly submission: GenerationSessionSubmission;
}

export interface GenerationAttachAssetOptions {
  readonly at?: number;
  readonly itemOptions?: Readonly<Record<string, boolean>>;
  /**
   * The occurrence id the new item takes. For a caller that already named it
   * — a staged draft whose editor has been referring to the item before it
   * exists. Must not collide with an id the panel holds. Omitted, the host
   * mints one.
   */
  readonly itemId?: string;
}

/**
 * One atomic batch of panel writes.
 *
 * **Slot ids name the state the transaction opened on.** Media commands are
 * applied in order, and the ones that change the arrangement — a removal, a
 * move, a positioned attach — renumber the whole batch (see
 * `GenerationMediaItemSnapshot.slotId`). One of those is enough to invalidate
 * every id a later command was given, so the id a caller read is translated to
 * the slot that item currently occupies as the sequence advances. Removing
 * two items therefore means passing the two ids the snapshot showed, not
 * guessing what the first removal renamed the second to.
 *
 * Two limits follow from that:
 *
 * - A slot created *inside* this transaction cannot be addressed within it —
 *   the caller has no id for it, which is why `attachAsset` takes
 *   `itemOptions` rather than expecting a following `setMediaOption`.
 * - `moveMedia` ordinals are live positions, not opening ones. A position is a
 *   position; only ids are translated.
 *
 * If the panel republishes its inputs while the callback runs, the staged ids
 * describe a state nobody saw, and the whole transaction fails
 * `session_changed` rather than being applied to the wrong items.
 */
export interface GenerationSessionTransaction {
  setTextInput(inputId: string, value: string): void;
  setWidget(target: GenerationWidgetTarget, value: unknown): void;
  /**
   * Attach a library asset to a media input, at `at` among the filled slots
   * (default: after the last one). A single-slot input takes only position 0
   * and replaces what it holds, matching a drop on it. `itemOptions` sets
   * per-item switches on the item the attach creates, which has no slot id to
   * address until the transaction commits.
   */
  attachAsset(
    inputId: string,
    assetId: string,
    options?: GenerationAttachAssetOptions,
  ): void;
  /** Reorder within one repeatable input. Ordinals are delivery positions. */
  moveMedia(inputId: string, fromOrdinal: number, toOrdinal: number): void;
  removeMedia(inputId: string, slotId: string): void;
  /** Write one per-item switch the slot's snapshot lists in `options`. */
  setMediaOption(slotId: string, optionId: string, value: boolean): void;
}

export type GenerationTransactionFailureCode =
  | "invalid_label"
  | "unavailable"
  /** The mounted workflow changed while the transaction's callback ran. */
  | "workflow_changed"
  | "invalid_command"
  | "callback_failed"
  | "input_not_found"
  | "input_type_mismatch"
  | "widget_not_found"
  | "widget_not_editable"
  | "widget_value_invalid"
  /** A reorder was asked of an input that holds a single slot. */
  | "input_not_repeatable"
  | "asset_not_found"
  /** The asset exists but this slot would not accept it from a drag either. */
  | "asset_type_rejected"
  | "batch_full"
  | "ordinal_out_of_range"
  /** The addressed slot holds nothing, so there is nothing to change. */
  | "media_not_found"
  /**
   * The input holds a slot open for a value still being produced, and the
   * requested change would repack the batch underneath it. Retryable.
   */
  | "input_busy"
  | "option_not_available"
  /**
   * The panel republished its inputs while the callback ran, so the slot ids
   * the caller staged name items that have since moved. Refused rather than
   * translated: those ids describe a state the caller never saw. Retryable
   * after re-reading the session.
   */
  | "session_changed";

export type GenerationTransactionResult =
  | { readonly ok: true; readonly changed: boolean; readonly label: string }
  | {
      readonly ok: false;
      readonly code: GenerationTransactionFailureCode;
      readonly message: string;
      readonly label: string;
    };

export interface GenerationSessionWidgetCommit {
  readonly target: GenerationWidgetTarget;
  readonly value: GenerationSessionJsonValue;
}

/**
 * One validated media change, resolved down to the slot it acts on.
 *
 * Validation has already turned an ordinal into a slot id and checked the
 * asset against the input, so the commit side is a direct call into the store
 * actions the panel's own batch strip uses — it re-derives nothing.
 */
export type GenerationSessionMediaCommit =
  | {
      readonly kind: "attach";
      readonly inputId: string;
      /** The slot the asset lands in before any reorder. */
      readonly slotId: string;
      readonly assetId: string;
      /** The occurrence id the attached item takes, minted when not supplied. */
      readonly itemId: string;
      /** Set when the asset must then move up the batch to reach `at`. */
      readonly moveTo: number | null;
      /**
       * Per-item switches to apply to the item this attach creates. The
       * caller cannot name its slot — it does not exist yet — so they ride the
       * attach rather than needing a second, non-atomic transaction.
       */
      readonly itemOptions: readonly {
        readonly optionId: GenerationMediaItemOptionId;
        readonly value: boolean;
      }[];
    }
  | {
      readonly kind: "move";
      readonly inputId: string;
      readonly slotId: string;
      readonly toOrdinal: number;
    }
  | { readonly kind: "remove"; readonly inputId: string; readonly slotId: string }
  | {
      readonly kind: "set-option";
      readonly inputId: string;
      readonly slotId: string;
      readonly optionId: GenerationMediaItemOptionId;
      readonly value: boolean;
    };

/** Per-item switches the host knows how to write. */
export type GenerationMediaItemOptionId = "audio";

export interface GenerationSessionCommit {
  /** Canonical input id → value. Empty when the transaction wrote no text. */
  readonly textInputs: ReadonlyMap<string, string>;
  readonly widgets: readonly GenerationSessionWidgetCommit[];
  /** Applied in the order they were staged; each depends on the last. */
  readonly media: readonly GenerationSessionMediaCommit[];
}

/**
 * The asset fields validation needs to judge an attach. Deliberately a narrow
 * pick: the session never holds a live library asset, only enough of one to
 * apply the drop rules.
 */
export type GenerationSessionAssetCandidate = Pick<
  Asset,
  "id" | "name" | "type" | "file" | "src" | "hasAudio"
>;

/** The mounting feature's write side. Called at most once per transaction. */
export interface GenerationSessionHost {
  commit(update: GenerationSessionCommit): void;
  /**
   * Resolve a library asset for validation, or `null` when the library has no
   * such asset. Read-only: the host still owns the asset itself.
   */
  resolveAsset(assetId: string): GenerationSessionAssetCandidate | null;
}
