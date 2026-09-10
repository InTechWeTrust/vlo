import { useEffect, useMemo, useState } from "react";
import { useSyncExternalStore } from "react";
import {
  createGenerationInputsDraft,
  INERT_DRAFT_READING,
  type GenerationDraftReading,
  type GenerationDraftWidgetTarget,
  type GenerationInputsDraftController,
} from "./generationInputsDraftController";
import type { GenerationInputDraftOp } from "./generationInputsDraft";
import type {
  GenerationSessionTransaction,
  GenerationTransactionResult,
} from "../services/generationSessionTypes";

export type { GenerationDraftWidgetTarget };

/**
 * A staged editor over some of the generation panel's inputs, for a component.
 *
 * The draft itself is `createGenerationInputsDraft` — a plain controller with
 * no React in it, so it can also be handed to an extension and owned by its
 * activation. This is the subscription: one draft per mounted component,
 * disposed with it.
 */
export interface GenerationInputsDraftHandle extends GenerationDraftReading {
  commit(
    label: string,
    additionalWrites?: (transaction: GenerationSessionTransaction) => void,
  ): GenerationTransactionResult;
  revert(): void;
  /** Stages one edit. Ignored if it addresses something this draft is not editing. */
  stage(op: GenerationInputDraftOp): void;
}

const NO_SUBSCRIBE = () => () => undefined;
const READ_INERT = () => INERT_DRAFT_READING;

export function useGenerationInputsDraft(
  inputIds: readonly string[],
  widgetTargets: readonly GenerationDraftWidgetTarget[] = [],
): GenerationInputsDraftHandle {
  /**
   * Owned by an effect, not created in a `useState` initializer or a `useMemo`.
   *
   * The controller subscribes to the session and the asset store on creation
   * and unsubscribes on `dispose`, which makes it an external resource with a
   * lifecycle — and StrictMode runs setup → cleanup → setup. A draft created
   * once outside an effect is disposed by that first cleanup and never
   * replaced: staging silently does nothing and `canCommit` stays false for as
   * long as the component lives. A discarded `useState` initializer would also
   * leave its subscriptions behind with nothing left to dispose them. The
   * create-in-setup / dispose-in-cleanup shape yields a fresh live controller
   * on the second setup, and the instance lives in state so it reaches the
   * renderer. Same reasoning as `Player`'s live-frame-graph coordinator.
   */
  const [controller, setController] =
    useState<GenerationInputsDraftController | null>(null);

  useEffect(() => {
    const created = createGenerationInputsDraft({ inputIds, widgetTargets });
    // Own an external resource's lifecycle, not derived state — the setState
    // publishes the freshly created controller to this component's tree.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setController(created);
    return () => {
      created.dispose();
      setController((current) => (current === created ? null : current));
    };
    // Created once for the component's lifetime; a changed request is applied
    // through `address` below rather than by discarding staged edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compared by value: callers build these arrays inline, so identity changes
  // on every render while the addressed set usually does not.
  const addressKey = JSON.stringify([inputIds, widgetTargets]);
  useEffect(() => {
    controller?.address({ inputIds, widgetTargets });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, addressKey]);

  const reading = useSyncExternalStore(
    controller ? controller.subscribe : NO_SUBSCRIBE,
    controller ? controller.getSnapshot : READ_INERT,
    controller ? controller.getSnapshot : READ_INERT,
  );

  return useMemo(
    () => ({
      ...reading,
      commit: (label, additionalWrites) =>
        controller?.commit(label, additionalWrites) ?? {
          ok: false,
          code: "unavailable",
          message: "The staged editor is not ready.",
          label,
        },
      revert: () => controller?.revert(),
      stage: (op) => controller?.stage(op),
    }),
    [reading, controller],
  );
}
