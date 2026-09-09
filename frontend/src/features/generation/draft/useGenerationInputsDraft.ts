import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useAssetStore } from "../../userAssets";
import { generationSessionService } from "../services/GenerationSessionService";
import { simulateAttachedItem } from "../services/generationSessionValidation";
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
  type StagedAttachResolver,
} from "./generationInputsDraft";

/**
 * A staged editor over some of the generation panel's inputs.
 *
 * Edits are held, not written: the panel is untouched until `commit`, which
 * writes the whole edit through one transaction so it either lands or does
 * not. `additionalWrites` runs inside that same transaction, so a caller
 * composing a prompt writes its text and its keyframes together rather than
 * leaving the panel half-updated when the second write fails.
 */
export interface GenerationInputsDraftController {
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
  commit(
    label: string,
    additionalWrites?: (transaction: GenerationSessionTransaction) => void,
  ): GenerationTransactionResult;
  revert(): void;
  /** Stages one edit. Ignored if it addresses an input this draft is not editing. */
  apply(op: GenerationInputDraftOp): void;
}

/** The panel as it stood when editing began, for both halves of a draft. */
interface DraftBaseline {
  readonly inputs: readonly GenerationInputSnapshot[];
  readonly widgets: ReadonlyMap<string, unknown>;
}

/**
 * The draft, as one value.
 *
 * `base` is the panel as it stood **when editing began**, not when the hook
 * mounted: a composer can sit open while the user works in the panel, and a
 * mount-time baseline would make their first staged edit collide with their
 * own earlier panel edit. It is captured on the empty-to-dirty transition, in
 * the same update that records the first op, so the two can never disagree.
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

/** One widget a draft may edit, addressed as the transaction addresses it. */
export interface GenerationDraftWidgetTarget {
  readonly nodeId: string;
  readonly param: string;
}

/**
 * The panel's committed values for the requested widget targets.
 *
 * Read from `editableWidgets`, **not** `workflow.nodes`. The two disagree by
 * design: `editableWidgets` is derived from the panel's live widget state
 * (`widgetValues[nodeId][param] ?? currentValue`) and moves the instant the
 * user touches a control, while `workflow.nodes` is the graph *catalogue* and
 * only rebuilds when the synced workflow does. Reading the catalogue means
 * showing a value the panel has already moved past, and — worse — comparing a
 * staged widget against a baseline that never changes, so a real panel edit
 * looks like no edit at all and is silently overwritten on commit.
 *
 * It is also the collection the transaction validates against
 * (`indexEditableWidgets`), so this is the value a commit will actually be
 * judged against.
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

export function useGenerationInputsDraft(
  inputIds: readonly string[],
  widgetTargets: readonly GenerationDraftWidgetTarget[] = [],
): GenerationInputsDraftController {
  const snapshot = useSyncExternalStore(
    (listener) => generationSessionService.subscribe(listener),
    () => generationSessionService.getSnapshot(),
    () => generationSessionService.getSnapshot(),
  );
  const assets = useAssetStore((state) => state.assets);
  const [draft, setDraft] = useState<DraftState>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const workflowRevision = snapshot?.workflow.revision ?? null;
  // A different workflow is a different set of inputs; edits addressed the old
  // ones and can mean nothing against the new.
  const stale =
    draft.workflowRevision !== null &&
    draft.workflowRevision !== workflowRevision;
  const live: DraftState = stale ? EMPTY : draft;
  // Discarded for real, not merely shadowed: a hidden draft would sit in state
  // for the rest of the session. Adjusted during render rather than in an
  // effect — React re-runs the component immediately without painting the
  // intermediate state, where an effect would commit a wasted render first.
  // `live` above is what makes this safe to do late: this render already reads
  // the empty draft, so the reset only catches state up to what it drew.
  if (stale) {
    setDraft(EMPTY);
    setError(null);
  }

  /**
   * How a staged attach will look once committed.
   *
   * The host's own attach derivation, not a copy: a video landing on an audio
   * slot delivers as `audio`, the audio switch is offered only where the input
   * offers it, and `hasAudio` is the asset's answer. Deriving these separately
   * is how a draft ends up showing one thing and committing another — and for
   * a reference batch, that difference moves every tag ordinal after it.
   */
  const resolveAttach = useCallback<StagedAttachResolver>(
    (input, assetId, replaced) => {
      const asset = assets.find((candidate) => candidate.id === assetId);
      if (!asset) return null;
      return simulateAttachedItem(input, asset, replaced);
    },
    [assets],
  );

  const selected = useMemo(() => new Set(inputIds), [inputIds]);
  const widgetTargetKeys = useMemo(
    () => new Set(widgetTargets.map((t) => widgetKey(t.nodeId, t.param))),
    [widgetTargets],
  );

  const widgetValues = useMemo(() => {
    const values = new Map(readCommittedWidgets(snapshot, widgetTargetKeys));
    for (const [key, value] of projectDraftWidgets(live.ops)) {
      if (widgetTargetKeys.has(key)) values.set(key, value);
    }
    return values;
  }, [snapshot, live.ops, widgetTargetKeys]);

  const projectedAll = useMemo(
    () => (snapshot ? projectDraftInputs(snapshot, live.ops, resolveAttach) : []),
    [snapshot, live.ops, resolveAttach],
  );
  const inputs = useMemo(
    () => projectedAll.filter((input) => selected.has(input.id)),
    [projectedAll, selected],
  );

  /**
   * What the draft disagrees with the panel about, against a given snapshot.
   *
   * One implementation for both the render-time reading and the re-check inside
   * `commit`. Two would drift, and the whole point of the re-check is that it
   * agrees with the render except for being newer.
   */
  const conflictsAgainst = useCallback(
    (
      against: GenerationSessionSnapshot,
      state: DraftState,
    ): readonly string[] => {
      if (!state.base) return [];
      return [
        ...findDraftConflicts(state.base.inputs, against.inputs, state.ops),
        ...findDraftWidgetConflicts(
          state.base.widgets,
          readCommittedWidgets(against, widgetTargetKeys),
          state.ops,
        ).map(widgetLabel),
      ];
    },
    [widgetTargetKeys],
  );

  const conflicts = useMemo(
    () => (snapshot ? conflictsAgainst(snapshot, live) : []),
    [snapshot, live, conflictsAgainst],
  );

  const apply = useCallback(
    (op: GenerationInputDraftOp) => {
      // A widget op names a node parameter rather than an input, so it is
      // gated on the requested widget targets instead.
      if (op.kind === "setWidget") {
        if (!widgetTargetKeys.has(widgetKey(op.nodeId, op.param))) return;
      } else if (!selected.has(op.inputId)) {
        return;
      }
      setError(null);
      setDraft((current) => {
        const fresh =
          current.workflowRevision === workflowRevision
            ? current
            : { ...EMPTY, workflowRevision };
        const opening = generationSessionService.getSnapshot();
        return {
          workflowRevision,
          // Captured with the first op, so the baseline is what the panel held
          // when this edit started — both halves of it, because a staged widget
          // needs a baseline to disagree with as much as an input does.
          base:
            fresh.ops.length === 0
              ? {
                  inputs: opening?.inputs ?? [],
                  widgets: readCommittedWidgets(opening, widgetTargetKeys),
                }
              : fresh.base,
          ops: [...fresh.ops, op],
        };
      });
    },
    [workflowRevision, selected, widgetTargetKeys],
  );

  const revert = useCallback(() => {
    setDraft(EMPTY);
    setError(null);
  }, []);

  const describeConflicts = (names: readonly string[]) =>
    `${names.join(", ")} changed in the panel while you were editing. Revert to take the panel's version.`;

  const conflictMessage =
    conflicts.length > 0 ? describeConflicts(conflicts) : null;

  const commit = useCallback(
    (
      label: string,
      additionalWrites?: (transaction: GenerationSessionTransaction) => void,
    ): GenerationTransactionResult => {
      const current = generationSessionService.getSnapshot();
      if (!current) {
        const message = "The generation panel is not mounted.";
        setError(message);
        return { ok: false, code: "unavailable", message, label };
      }
      // Re-checked against the snapshot being written, not the one the last
      // render read. The panel can publish between that render and this call —
      // a commit fired from the same tick as a publish would otherwise consult
      // a decision made before it and overwrite the intervening edit.
      if (
        live.ops.length > 0 &&
        live.workflowRevision !== current.workflow.revision
      ) {
        const message =
          "The workflow changed while you were editing. Revert to start again.";
        setError(message);
        return { ok: false, code: "workflow_changed", message, label };
      }
      const fresh = conflictsAgainst(current, live);
      if (fresh.length > 0) {
        const message = describeConflicts(fresh);
        setError(message);
        return { ok: false, code: "unavailable", message, label };
      }
      const target = projectDraftInputs(current, live.ops, resolveAttach);
      const result = generationSessionService.transaction(label, (transaction) => {
        // Diffed against the session as it is *now*, so the writes describe
        // the panel being written rather than the one editing began against.
        compileDraftCommands(
          current.inputs,
          target,
          transaction,
          projectDraftWidgets(live.ops),
        );
        // Returned, so an `additionalWrites` that turns out to be async is
        // still seen by the session and refused. Dropping it here would let
        // half a transaction commit and report success.
        return additionalWrites?.(transaction);
      });
      if (!result.ok) {
        setError(result.message);
        return result;
      }
      // Cleared only now: a failed transaction leaves the panel untouched, so
      // dropping the draft would lose the edit and show a panel that never
      // took it.
      setDraft(EMPTY);
      setError(null);
      return result;
    },
    [live, conflictsAgainst, resolveAttach],
  );

  return {
    inputs,
    widgetValues,
    hasDraftChanges: live.ops.length > 0,
    hasConflict: conflicts.length > 0,
    canCommit: snapshot !== null && conflicts.length === 0,
    error: error ?? conflictMessage,
    commit,
    revert,
    apply,
  };
}
