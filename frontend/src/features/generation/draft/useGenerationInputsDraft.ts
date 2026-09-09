import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useAssetStore } from "../../userAssets";
import { generationSessionService } from "../services/GenerationSessionService";
import { simulateAttachedItem } from "../services/generationSessionValidation";
import type {
  GenerationInputSnapshot,
  GenerationSessionTransaction,
  GenerationTransactionResult,
} from "../services/generationSessionTypes";
import {
  compileDraftCommands,
  findDraftConflicts,
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
  /** The panel moved under an input this draft is holding. */
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

/**
 * The draft, as one value.
 *
 * `base` is the panel as it stood **when editing began**, not when the hook
 * mounted: a composer can sit open while the user works in the panel, and a
 * mount-time baseline would make their first staged edit collide with their
 * own earlier panel edit. It is captured on the empty-to-dirty transition, in
 * the same update that records the first op, so the two can never disagree.
 */
interface DraftState {
  readonly fingerprint: string | null;
  readonly base: readonly GenerationInputSnapshot[] | null;
  readonly ops: readonly GenerationInputDraftOp[];
}

const EMPTY: DraftState = { fingerprint: null, base: null, ops: [] };

/** One widget a draft may edit, addressed as the transaction addresses it. */
export interface GenerationDraftWidgetTarget {
  readonly nodeId: string;
  readonly param: string;
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

  const fingerprint = snapshot?.workflow.fingerprint ?? null;
  // A different workflow is a different set of inputs; edits addressed the old
  // ones and can mean nothing against the new. Read during render rather than
  // written: the stale draft is simply not used, and the next edit replaces it.
  const live: DraftState =
    draft.fingerprint === fingerprint ? draft : EMPTY;

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

  /**
   * Committed widget values for the requested targets, overlaid with staged
   * ones. Read from the workflow snapshot rather than the panel's own widget
   * state so the two halves of a draft — inputs and widgets — come from one
   * source.
   */
  const widgetValues = useMemo(() => {
    const values = new Map<string, unknown>();
    for (const node of snapshot?.workflow.nodes ?? []) {
      for (const widget of node.widgets) {
        const key = widgetKey(node.id, widget.param);
        if (!widgetTargetKeys.has(key)) continue;
        values.set(key, widget.value);
      }
    }
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

  const conflicts = useMemo(
    () =>
      snapshot && live.base
        ? findDraftConflicts(live.base, snapshot.inputs, live.ops)
        : [],
    [snapshot, live.base, live.ops],
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
          current.fingerprint === fingerprint ? current : { ...EMPTY, fingerprint };
        return {
          fingerprint,
          // Captured with the first op, so the baseline is what the panel held
          // when this edit started.
          base:
            fresh.ops.length === 0
              ? (generationSessionService.getSnapshot()?.inputs ?? null)
              : fresh.base,
          ops: [...fresh.ops, op],
        };
      });
    },
    [fingerprint, selected, widgetTargetKeys],
  );

  const revert = useCallback(() => {
    setDraft(EMPTY);
    setError(null);
  }, []);

  const conflictMessage =
    conflicts.length > 0
      ? `${conflicts.join(", ")} changed in the panel while you were editing. Revert to take the panel's version.`
      : null;

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
      if (conflicts.length > 0) {
        const message = conflictMessage ?? "The panel changed underneath.";
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
        additionalWrites?.(transaction);
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
    [conflicts.length, conflictMessage, live.ops, resolveAttach],
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
