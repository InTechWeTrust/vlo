import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAssetStore } from "../../userAssets";
import { generationSessionService } from "../services/GenerationSessionService";
import type {
  GenerationInputSnapshot,
  GenerationSessionTransaction,
  GenerationTransactionResult,
} from "../services/generationSessionTypes";
import {
  findDraftConflicts,
  projectDraftInputs,
  replayDraftOps,
  type GenerationInputDraftOp,
  type StagedAssetResolution,
} from "./generationInputsDraft";

/**
 * A staged editor over some of the generation panel's inputs.
 *
 * Edits are held, not written: the panel is untouched until `commit`, which
 * replays every staged op through one transaction so the whole edit either
 * lands or does not. `additionalWrites` runs inside that same transaction, so
 * a caller composing a prompt can write its text and its keyframes together
 * rather than leaving the panel half-updated if the second write fails.
 */
export interface GenerationInputsDraftController {
  /** The addressed inputs as they would be after every staged op. */
  readonly inputs: readonly GenerationInputSnapshot[];
  readonly isDirty: boolean;
  readonly canCommit: boolean;
  /** Why a commit is refused, or why the last one failed. */
  readonly error: string | null;
  commit(
    label: string,
    additionalWrites?: (transaction: GenerationSessionTransaction) => void,
  ): GenerationTransactionResult;
  revert(): void;
  /** Stages one op. Rejected silently if it addresses an input not being edited. */
  apply(op: GenerationInputDraftOp): void;
}

const NO_SESSION: GenerationTransactionResult = {
  ok: false,
  code: "unavailable",
  message: "The generation panel is not mounted.",
  label: "",
};

export function useGenerationInputsDraft(
  inputIds: readonly string[],
): GenerationInputsDraftController {
  const snapshot = useSyncExternalStore(
    (listener) => generationSessionService.subscribe(listener),
    () => generationSessionService.getSnapshot(),
    () => generationSessionService.getSnapshot(),
  );
  const assets = useAssetStore((state) => state.assets);
  const [ops, setOps] = useState<readonly GenerationInputDraftOp[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * The inputs as they were when the draft was started.
   *
   * Kept in a ref rather than state because it is the *baseline for
   * comparison*, not something rendered: a change to it must not re-render,
   * and it must not move under the ops it is being compared against.
   */
  const baseRef = useRef<readonly GenerationInputSnapshot[] | null>(null);
  const fingerprintRef = useRef<string | null>(null);

  const fingerprint = snapshot?.workflow.fingerprint ?? null;
  // A different workflow is a different set of inputs; staged edits addressed
  // the old ones and cannot mean anything against the new.
  if (fingerprintRef.current !== fingerprint) {
    fingerprintRef.current = fingerprint;
    if (ops.length > 0) setOps([]);
    baseRef.current = null;
    if (error !== null) setError(null);
  }
  if (baseRef.current === null && snapshot) {
    baseRef.current = snapshot.inputs;
  }

  const resolveAsset = useCallback(
    (assetId: string): StagedAssetResolution | null => {
      const asset = assets.find((candidate) => candidate.id === assetId);
      if (!asset) return null;
      const mediaType =
        asset.type === "video" || asset.type === "audio" ? asset.type : "image";
      return {
        displayName: asset.name,
        mediaType,
        hasAudio: asset.type === "video" ? null : false,
      };
    },
    [assets],
  );

  const selected = useMemo(() => new Set(inputIds), [inputIds]);

  const projected = useMemo(
    () =>
      snapshot
        ? projectDraftInputs(snapshot, ops, resolveAsset).filter((input) =>
            selected.has(input.id),
          )
        : [],
    [snapshot, ops, resolveAsset, selected],
  );

  const conflicts = useMemo(
    () =>
      snapshot && baseRef.current
        ? findDraftConflicts(baseRef.current, snapshot.inputs, ops)
        : [],
    [snapshot, ops],
  );

  const apply = useCallback(
    (op: GenerationInputDraftOp) => {
      if (!selected.has(op.inputId)) return;
      setError(null);
      setOps((current) => [...current, op]);
    },
    [selected],
  );

  const revert = useCallback(() => {
    setOps([]);
    setError(null);
    baseRef.current = generationSessionService.getSnapshot()?.inputs ?? null;
  }, []);

  const isDirty = ops.length > 0;
  const conflictMessage =
    conflicts.length > 0
      ? `${conflicts.join(", ")} changed in the panel while you were editing. Revert to take the panel's version.`
      : null;

  const commit = useCallback(
    (
      label: string,
      additionalWrites?: (transaction: GenerationSessionTransaction) => void,
    ): GenerationTransactionResult => {
      if (!generationSessionService.getSnapshot()) return NO_SESSION;
      if (conflicts.length > 0) {
        const message = conflictMessage ?? "The panel changed underneath.";
        setError(message);
        return { ok: false, code: "unavailable", message, label };
      }
      const result = generationSessionService.transaction(label, (transaction) => {
        replayDraftOps(ops, transaction);
        additionalWrites?.(transaction);
      });
      if (!result.ok) {
        setError(result.message);
        return result;
      }
      // Cleared only now: a failed transaction leaves the panel untouched, so
      // dropping the draft would lose the user's edit and show them a panel
      // that never took it.
      setOps([]);
      setError(null);
      baseRef.current = generationSessionService.getSnapshot()?.inputs ?? null;
      return result;
    },
    [conflicts.length, conflictMessage, ops],
  );

  return {
    inputs: projected,
    isDirty,
    canCommit: isDirty && conflicts.length === 0 && snapshot !== null,
    error: error ?? conflictMessage,
    commit,
    revert,
    apply,
  };
}
