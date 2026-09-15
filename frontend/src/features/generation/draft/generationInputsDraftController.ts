import { copyCapturedMedia, type GenerationCapturedMedia } from "../utils/capturedMedia";
import { useAssetStore } from "../../userAssets";
import { generationSessionService } from "../services/GenerationSessionService";
import { simulateAttachedItem } from "../services/generationSessionValidation";
import { createMediaItemId } from "../utils/mediaItemIds";
import type {
  GenerationInputSnapshot,
  GenerationSessionSnapshot,
  GenerationSessionTransaction,
  GenerationTransactionResult,
} from "../services/generationSessionTypes";
import {
  compileDraftCommands,
  findDraftConflicts,
  findDraftWidgetConflicts,
  projectDraftInputs,
  projectDraftWidgets,
  widgetKey,
  type GenerationInputDraftOp,
} from "./generationInputsDraft";

/** One widget a draft may edit, addressed as the transaction addresses it. */
export interface GenerationDraftWidgetTarget {
  readonly nodeId: string;
  readonly param: string;
}

/** What a draft edits. Everything outside it stays the panel's alone. */
export interface GenerationInputsDraftRequest {
  readonly inputIds: readonly string[];
  readonly widgetTargets?: readonly GenerationDraftWidgetTarget[];
  /**
   * Text inputs held for conflict detection only: `holdText` may name them,
   * and a panel edit to them is a conflict, but the draft never shows them in
   * its reading, never renders a field for them, and never writes them. For a
   * caller that writes the text itself at commit — anything the draft offered
   * to edit there would be silently replaced by that write.
   */
  readonly holdInputIds?: readonly string[];
}

/**
 * Whether this draft can be edited at all, and if not, why.
 *
 * Separate from `canCommit`, `hasDraftChanges` and `hasConflict`, which all
 * describe a *working* draft. Those answer "what is in it"; this answers
 * "is there one". Without it `unavailable` and `disposed` are indistinguishable
 * — both read as an empty draft that refuses to commit for no stated reason,
 * which is how a renderer ends up drawing a blank panel with nothing to say.
 *
 * - `ready` — a session is mounted and this draft is live.
 * - `unavailable` — no generation session; the panel is not mounted. Transient,
 *   and it resolves itself when one arrives.
 * - `disposed` — this controller is finished and will never read anything
 *   again. Terminal, and always a caller bug: whoever owns it kept it past its
 *   own lifetime.
 */
export type GenerationDraftStatus = "ready" | "unavailable" | "disposed";

/** Everything a renderer or a package reads, as one immutable value. */
export interface GenerationDraftReading {
  /** Whether the draft is live, waiting for a session, or finished. */
  readonly status: GenerationDraftStatus;
  /** The addressed inputs as they would be after every staged edit. */
  readonly inputs: readonly GenerationInputSnapshot[];
  /**
   * The addressed widgets, keyed `nodeId:param`, as they would be after every
   * staged edit — the panel's committed value where the draft has not touched
   * one.
   */
  readonly widgetValues: ReadonlyMap<string, unknown>;
  /** The draft holds edits of its own. */
  readonly hasDraftChanges: boolean;
  /** The panel moved under an input or widget this draft is holding. */
  readonly hasConflict: boolean;
  /**
   * A transaction may be attempted. True with no staged edits, because a
   * caller may still have `additionalWrites` of its own to commit — a composer
   * writing only prompt text has nothing staged here and must not be blocked.
   */
  readonly canCommit: boolean;
  /** Why a commit is refused, or why the last one failed. */
  readonly error: string | null;
}

/**
 * The arrangement one commit writes, handed to `additionalWrites`
 * (docs/minimax-ref2v-prompt-composer-plan.md §3.3).
 *
 * A caller whose text depends on the media — a prompt numbering its reference
 * tags — must resolve that text against *this*, not against a reading it took
 * while rendering. It is computed from the session the transaction opens on,
 * after conflicts were checked, so the numbers the caller assigns and the
 * arrangement the transaction writes are one arrangement by construction.
 *
 * Staged items keep placeholder slot ids here: the reading describes what
 * the panel will hold, not where to write. Refer to items by `itemId`.
 */
export interface GenerationDraftCommitReading {
  /** The addressed inputs as this commit leaves them. */
  readonly inputs: readonly GenerationInputSnapshot[];
  /** The addressed widgets, keyed `nodeId:param`, as this commit leaves them. */
  readonly widgetValues: ReadonlyMap<string, unknown>;
  /** The workflow the commit is pinned to. */
  readonly workflow: {
    readonly revision: number;
    readonly fingerprint: string;
    readonly instanceId: string | null;
  };
}

/**
 * A staged editor over some of the generation panel's inputs.
 *
 * Edits are held, not written: the panel is untouched until `commit`, which
 * writes the whole edit through one transaction so it either lands or does
 * not. `additionalWrites` runs inside that same transaction, so a caller
 * composing a prompt writes its text and its keyframes together rather than
 * leaving the panel half-updated when the second write fails.
 *
 * Deliberately *not* a hook. A draft's lifetime belongs to whoever opened it —
 * an extension activation, a panel takeover, a component — and tying it to a
 * React render tree means it cannot be handed out through a scoped API, owned,
 * or disposed on demand. `useGenerationInputsDraft` is a thin subscription over
 * this for callers that are components.
 */
export interface GenerationInputsDraftController {
  getSnapshot(): GenerationDraftReading;
  subscribe(listener: () => void): () => void;
  /** Stages one edit. Ignored if it addresses something this draft is not editing. */
  stage(op: GenerationInputDraftOp): void;
  stageCapture(inputId: string, at: number, capture: GenerationCapturedMedia): void;
  revert(): void;
  commit(
    label: string,
    additionalWrites?: (
      transaction: GenerationSessionTransaction,
      reading: GenerationDraftCommitReading,
    ) => void,
  ): GenerationTransactionResult;
  /** Change what this draft addresses, keeping the edits it already holds. */
  address(request: GenerationInputsDraftRequest): void;
  dispose(): void;
}

/** The panel as it stood when editing began, for both halves of a draft. */
interface DraftBaseline {
  readonly inputs: readonly GenerationInputSnapshot[];
  readonly widgets: ReadonlyMap<string, unknown>;
}

/**
 * The draft, as one value.
 *
 * `base` is the panel as it stood **when editing began**, not when the draft
 * opened: a composer can sit open while the user works in the panel, and an
 * open-time baseline would make their first staged edit collide with their own
 * earlier panel edit. It is captured with the first op, so the two can never
 * disagree.
 *
 * `workflowRevision` is the workflow this was staged against. That one scalar
 * is the whole of workflow identity — `workflowChanged` treats `sourceId`,
 * `instanceId`, `fingerprint` and `mode` as identity and this bumps for any of
 * them, so a hand-assembled tuple would have to track that list forever. It is
 * also monotonic, which a fingerprint is not: switching A → B → A lands on a
 * *new* revision, so a draft staged against the first A cannot come back to
 * life against the second.
 */
interface DraftState {
  readonly workflowRevision: number | null;
  readonly base: DraftBaseline | null;
  readonly ops: readonly GenerationInputDraftOp[];
}

const EMPTY: DraftState = { workflowRevision: null, base: null, ops: [] };

/**
 * The reading of a draft that cannot be edited, in either terminal-ness.
 *
 * Exported as `INERT_DRAFT_READING` for the `unavailable` case, which is what
 * a component holds before the panel mounts. The `disposed` case is a distinct
 * value rather than a flag on this one, so the two can never be compared equal
 * by identity — `useSyncExternalStore` compares snapshots that way, and a
 * dispose that returned the same object would not re-render the component it
 * needs to inform.
 */
const inertReading = (
  status: Exclude<GenerationDraftStatus, "ready">,
): GenerationDraftReading => ({
  status,
  inputs: [],
  widgetValues: new Map(),
  hasDraftChanges: false,
  hasConflict: false,
  canCommit: false,
  error: null,
});

/** No session mounted. Transient; a session arriving replaces it. */
export const INERT_DRAFT_READING: GenerationDraftReading =
  inertReading("unavailable");

/** Finished. Terminal, and only ever seen through a controller kept too long. */
export const DISPOSED_DRAFT_READING: GenerationDraftReading =
  inertReading("disposed");

/**
 * The panel's committed values for the requested widget targets.
 *
 * Read from `editableWidgets`, **not** `workflow.nodes`. The two disagree by
 * design: `editableWidgets` is derived from the panel's live widget state and
 * moves the instant the user touches a control, while `workflow.nodes` is the
 * graph *catalogue* and only rebuilds when the synced workflow does. Reading
 * the catalogue means showing a value the panel has already moved past, and —
 * worse — comparing a staged widget against a baseline that never changes, so
 * a real panel edit looks like no edit at all and is silently overwritten on
 * commit. It is also the collection the transaction validates against
 * (`indexEditableWidgets`).
 */
function readCommittedWidgets(
  snapshot: GenerationSessionSnapshot | null,
  keys: ReadonlySet<string>,
): ReadonlyMap<string, unknown> {
  const values = new Map<string, unknown>();
  for (const widget of snapshot?.editableWidgets ?? []) {
    const key = widgetKey(widget.target.nodeId, widget.target.widget);
    if (keys.has(key)) values.set(key, widget.value);
  }
  return values;
}

/** `nodeId:param` → `param`, the only name a widget snapshot carries. */
function widgetLabel(key: string): string {
  return key.slice(key.lastIndexOf(":") + 1);
}

const WORKFLOW_MOVED =
  "The workflow changed while you were editing, so the staged edits were dropped.";

function describeConflicts(names: readonly string[]): string {
  return `${names.join(", ")} changed in the panel while you were editing. Revert to take the panel's version.`;
}

export function createGenerationInputsDraft(
  request: GenerationInputsDraftRequest,
): GenerationInputsDraftController {
  let selected = new Set(request.inputIds);
  let held = new Set(
    (request.holdInputIds ?? []).filter((id) => !selected.has(id)),
  );
  let widgetTargetKeys = new Set(
    (request.widgetTargets ?? []).map((target) =>
      widgetKey(target.nodeId, target.param),
    ),
  );
  let state: DraftState = EMPTY;
  let error: string | null = null;
  let reading: GenerationDraftReading | null = null;
  let disposed = false;
  /**
   * A draft was discarded because the workflow moved, and nobody has been told.
   *
   * Needed because the discard happens wherever the draft is next *read*, which
   * is usually a re-render triggered by the very publish that invalidated it —
   * long before anyone calls `commit`. Without this, commit would find nothing
   * staged, write only the caller's `additionalWrites`, and report success for
   * an edit that was thrown away. Cleared when the caller acts on it.
   */
  let droppedForWorkflowChange = false;
  const listeners = new Set<() => void>();
  const capturePreviews = new Set<string>();
  const releaseUnusedPreviews = () => {
    const session = generationSessionService.getSnapshot();
    const retainedIds = new Set(session
      ? projectDraftInputs(session, state.ops, resolveAttach).flatMap((input) => input.media?.map((item) => item.itemId) ?? [])
      : []);
    const retained = new Set(state.ops.flatMap((op) =>
      op.kind === "captureMedia" && op.itemId && retainedIds.has(op.itemId) ? [op.previewUrl] : []));
    for (const url of capturePreviews) {
      if (retained.has(url)) continue;
      URL.revokeObjectURL(url);
      capturePreviews.delete(url);
    }
  };

  const notify = () => {
    // Cached because `useSyncExternalStore` compares snapshot identity, and a
    // fresh object per read would loop forever.
    reading = null;
    for (const listener of [...listeners]) listener();
  };

  const unsubscribeSession = generationSessionService.subscribe(notify);
  const unsubscribeAssets = useAssetStore.subscribe(notify);

  /**
   * The draft as it currently applies, discarding it if the workflow moved.
   *
   * Discarded for real rather than shadowed: nothing here is React state, so
   * there is no render to be careful about — the stale ops are dropped the
   * first time anyone looks.
   */
  const liveState = (session: GenerationSessionSnapshot | null): DraftState => {
    const revision = session?.workflow.revision ?? null;
    if (
      state.workflowRevision !== null &&
      state.workflowRevision !== revision
    ) {
      // Said rather than swallowed: the edits are gone, and a surface that just
      // showed them empty out with no explanation looks broken.
      if (state.ops.length > 0) {
        droppedForWorkflowChange = true;
        error = WORKFLOW_MOVED;
      } else {
        error = null;
      }
      state = EMPTY;
      releaseUnusedPreviews();
    }
    return state;
  };

  /** Has the workflow moved out from under edits that were still staged? */
  const stagedAgainstAnotherWorkflow = (
    session: GenerationSessionSnapshot,
  ): boolean =>
    droppedForWorkflowChange ||
    (state.ops.length > 0 &&
      state.workflowRevision !== null &&
      state.workflowRevision !== session.workflow.revision);

  /**
   * How a staged attach will look once committed.
   *
   * The host's own attach derivation, not a copy: a video landing on an audio
   * slot delivers as `audio`, the audio switch is offered only where the input
   * offers it, and `hasAudio` is the asset's answer. Deriving these separately
   * is how a draft ends up showing one thing and committing another — and for
   * a reference batch, that difference moves every tag ordinal after it.
   */
  const resolveAttach = (
    input: GenerationInputSnapshot,
    assetId: string,
    replaced: Parameters<typeof simulateAttachedItem>[2],
  ) => {
    const asset = useAssetStore
      .getState()
      .assets.find((candidate) => candidate.id === assetId);
    return asset ? simulateAttachedItem(input, asset, replaced) : null;
  };

  /**
   * The ops addressing what this draft currently shows.
   *
   * Narrowing hides ops rather than deleting them, so this — not `state.ops` —
   * is what "has changes", conflicts, and the commit are about. Deleting them
   * would renumber the log, and a staged slot id is built from an op's position
   * in it: filtering `[attach A, attach B, remove staged:1]` down to B's ops
   * renumbers `attach B` to index 0, the removal stops matching, and the
   * attachment the user cleared comes back.
   */
  const addressedOps = (
    current: DraftState,
  ): readonly GenerationInputDraftOp[] =>
    current.ops.filter((op) =>
      op.kind === "setWidget"
        ? widgetTargetKeys.has(widgetKey(op.nodeId, op.param))
        : selected.has(op.inputId) ||
          (op.kind === "holdText" && held.has(op.inputId)),
    );

  /**
   * What the draft disagrees with the panel about, against a given snapshot.
   *
   * One implementation for both the published reading and the re-check inside
   * `commit`. Two would drift, and the whole point of the re-check is that it
   * agrees with the reading except for being newer.
   */
  const conflictsAgainst = (
    against: GenerationSessionSnapshot,
    current: DraftState,
  ): readonly string[] => {
    if (!current.base) return [];
    const ops = addressedOps(current);
    return [
      ...findDraftConflicts(current.base.inputs, against.inputs, ops),
      ...findDraftWidgetConflicts(
        current.base.widgets,
        readCommittedWidgets(against, widgetTargetKeys),
        ops,
      ).map(widgetLabel),
    ];
  };

  const read = (): GenerationDraftReading => {
    const session = generationSessionService.getSnapshot();
    const current = liveState(session);
    if (!session) {
      return { ...INERT_DRAFT_READING, error };
    }
    const projected = projectDraftInputs(session, current.ops, resolveAttach);
    const widgetValues = new Map(
      readCommittedWidgets(session, widgetTargetKeys),
    );
    for (const [key, value] of projectDraftWidgets(current.ops)) {
      if (widgetTargetKeys.has(key)) widgetValues.set(key, value);
    }
    const conflicts = conflictsAgainst(session, current);
    const conflictMessage =
      conflicts.length > 0 ? describeConflicts(conflicts) : null;
    return {
      status: "ready",
      inputs: projected.filter((input) => selected.has(input.id)),
      widgetValues,
      hasDraftChanges: addressedOps(current).length > 0,
      hasConflict: conflicts.length > 0,
      canCommit: conflicts.length === 0,
      error: error ?? conflictMessage,
    };
  };

  const controller: GenerationInputsDraftController = {
    getSnapshot: () => {
      if (disposed) return DISPOSED_DRAFT_READING;
      if (!reading) reading = read();
      return reading;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stage: (op) => {
      if (disposed) return;
      // A widget op names a node parameter rather than an input, so it is
      // gated on the requested widget targets instead.
      if (op.kind === "setWidget") {
        if (!widgetTargetKeys.has(widgetKey(op.nodeId, op.param))) return;
      } else if (
        !selected.has(op.inputId) &&
        !(op.kind === "holdText" && held.has(op.inputId))
      ) {
        return;
      }
      // Identity is minted once, here, and stored in the op: the projection is
      // recomputed on every read, so an id minted there would change each time.
      if (
        (op.kind === "attachAsset" || op.kind === "replaceMedia" || op.kind === "captureMedia") &&
        op.itemId === undefined
      ) {
        op = { ...op, itemId: createMediaItemId() };
      }
      const session = generationSessionService.getSnapshot();
      if (!session) {
        // Refused rather than held. With no panel there is no workflow to
        // record, and a `null` revision is indistinguishable from "not staged
        // yet" — so the op would sit invisible and then apply itself to
        // whatever workflow mounts next.
        error = "The generation panel is not mounted.";
        notify();
        return;
      }
      const current = liveState(session);
      droppedForWorkflowChange = false;
      const workflowRevision = session.workflow.revision;
      const fresh =
        current.workflowRevision === workflowRevision
          ? current
          : { ...EMPTY, workflowRevision };
      state = {
        workflowRevision,
        // Captured with the first op, so the baseline is what the panel held
        // when this edit started — both halves of it, because a staged widget
        // needs a baseline to disagree with as much as an input does.
        base:
          fresh.ops.length === 0
            ? {
                inputs: session.inputs,
                widgets: readCommittedWidgets(session, widgetTargetKeys),
              }
            : fresh.base,
        ops: [...fresh.ops, op],
      };
      releaseUnusedPreviews();
      error = null;
      notify();
    },
    stageCapture: (inputId, at, capture) => {
      if (disposed || !selected.has(inputId)) return;
      const snapshot = controller.getSnapshot();
      const input = snapshot.inputs.find((entry) => entry.id === inputId);
      if (snapshot.status !== "ready" || snapshot.hasConflict || !input || input.inputType === "text") return;
      const count = input.media?.length ?? 0;
      if (!Number.isInteger(at) || at < 0 || at > count || (at === count && count >= (input.repeatable?.max ?? 1))) return;
      const copied = copyCapturedMedia(capture);
      const previewUrl = URL.createObjectURL(copied.kind === "frame" ? copied.file : copied.thumbnailFile);
      capturePreviews.add(previewUrl);
      controller.stage({ kind: "captureMedia", inputId, capture: copied, previewUrl, ...(at < count ? { at } : {}) });
      releaseUnusedPreviews();
    },
    revert: () => {
      if (disposed) return;
      state = EMPTY;
      releaseUnusedPreviews();
      error = null;
      droppedForWorkflowChange = false;
      notify();
    },
    commit: (label, additionalWrites) => {
      if (disposed) {
        return {
          ok: false,
          code: "unavailable",
          message: "The staged editor has been closed.",
          label,
        };
      }
      const session = generationSessionService.getSnapshot();
      if (!session) {
        error = "The generation panel is not mounted.";
        notify();
        return { ok: false, code: "unavailable", message: error, label };
      }
      // Checked *before* `liveState`, which discards a draft staged against
      // another workflow. Discarding is right, but doing it silently here would
      // commit nothing and report success — telling the caller its edit landed
      // when it was actually thrown away.
      if (stagedAgainstAnotherWorkflow(session)) {
        state = EMPTY;
        releaseUnusedPreviews();
        // Reported once. Leaving it set would refuse every later commit,
        // including ones the caller staged fresh against the new workflow.
        droppedForWorkflowChange = false;
        error = WORKFLOW_MOVED;
        notify();
        return { ok: false, code: "workflow_changed", message: error, label };
      }
      const current = liveState(session);
      const conflicts = conflictsAgainst(session, current);
      if (conflicts.length > 0) {
        error = describeConflicts(conflicts);
        notify();
        return { ok: false, code: "unavailable", message: error, label };
      }
      // Projected from *every* op so staged slot ids stay put, then narrowed to
      // what this draft addresses: the compiler writes only the inputs in the
      // target it is given, so a hidden edit is never committed — and never
      // renumbered out of existence either.
      const projected = projectDraftInputs(session, current.ops, resolveAttach);
      const target = projected.filter((input) => selected.has(input.id));
      const widgets = new Map(
        [...projectDraftWidgets(current.ops)].filter(([key]) =>
          widgetTargetKeys.has(key),
        ),
      );
      const committedWidgets = new Map(
        readCommittedWidgets(session, widgetTargetKeys),
      );
      for (const [key, value] of widgets) committedWidgets.set(key, value);
      const commitReading: GenerationDraftCommitReading = Object.freeze({
        inputs: target,
        widgetValues: committedWidgets,
        workflow: Object.freeze({
          revision: session.workflow.revision,
          fingerprint: session.workflow.fingerprint,
          instanceId: session.workflow.instanceId,
        }),
      });
      const result = generationSessionService.transaction(
        label,
        (transaction) => {
          // Diffed against the session as it is *now*, so the writes describe
          // the panel being written rather than the one editing began against.
          compileDraftCommands(session.inputs, target, transaction, widgets,
            new Map(current.ops.flatMap((op) => op.kind === "captureMedia" && op.itemId ? [[op.itemId, op.capture] as const] : [])));
          // Returned, so an `additionalWrites` that turns out to be async is
          // still seen by the session and refused. Dropping it here would let
          // half a transaction commit and report success.
          return additionalWrites?.(transaction, commitReading);
        },
        // What the caller resolved against has to still be what is written.
        // A text-only `additionalWrites` stages no media, so without this the
        // session would not notice its inputs moving under the callback — and
        // the prompt would be numbered against an arrangement nobody commits.
        additionalWrites
          ? {
              dependsOnInputs: [...selected, ...held],
              // Widgets are in the reading too — a duration the prose cites —
              // so a widget moving under the callback is the same stale read.
              dependsOnWidgets: [...widgetTargetKeys].map((key) => {
                const separator = key.lastIndexOf(":");
                return {
                  nodeId: key.slice(0, separator),
                  widget: key.slice(separator + 1),
                };
              }),
            }
          : undefined,
      );
      if (!result.ok) {
        error = result.message;
        notify();
        return result;
      }
      // Cleared only now: a failed transaction leaves the panel untouched, so
      // dropping the draft would lose the edit and show a panel that never
      // took it.
      //
      // And only the ops this commit actually wrote. The target was narrowed to
      // the addressed inputs, so an op the draft is holding for something it no
      // longer shows was not committed — clearing it here would discard staged
      // work on the strength of a write that never touched it.
      const consumed = new Set(addressedOps(current));
      const remaining = current.ops.filter((op) => !consumed.has(op));
      state =
        remaining.length === 0 ? EMPTY : { ...current, ops: remaining };
      releaseUnusedPreviews();
      error = null;
      notify();
      return result;
    },
    address: (next) => {
      if (disposed) return;
      const nextSelected = new Set(next.inputIds);
      const nextHeld = new Set(
        (next.holdInputIds ?? []).filter((id) => !nextSelected.has(id)),
      );
      const nextWidgets = new Set(
        (next.widgetTargets ?? []).map((target) =>
          widgetKey(target.nodeId, target.param),
        ),
      );
      if (
        nextSelected.size === selected.size &&
        [...nextSelected].every((id) => selected.has(id)) &&
        nextHeld.size === held.size &&
        [...nextHeld].every((id) => held.has(id)) &&
        nextWidgets.size === widgetTargetKeys.size &&
        [...nextWidgets].every((key) => widgetTargetKeys.has(key))
      ) {
        return;
      }
      selected = nextSelected;
      held = nextHeld;
      widgetTargetKeys = nextWidgets;
      // The log is left intact. Everything downstream — the reading, the
      // conflicts, the commit target — is narrowed to what is addressed, so a
      // hidden edit is neither shown nor written, and re-addressing an input
      // brings its staged edit back rather than having silently lost it.
      notify();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribeSession();
      unsubscribeAssets();
      state = EMPTY;
      releaseUnusedPreviews();
      error = null;
      reading = null;
      /**
       * Told, not just dropped.
       *
       * Disposal changes what `getSnapshot` answers — `ready` becomes
       * `disposed` — and a subscriber that is never notified goes on rendering
       * the last live reading until something unrelated re-renders it. Clearing
       * the listeners without this is what makes a disposed draft look like a
       * working one, and the whole point of `status` is that a renderer can say
       * so. Notified *before* the set is cleared, and from a copy, so a listener
       * unsubscribing in response cannot mutate what is being iterated.
       */
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
  return controller;
}
