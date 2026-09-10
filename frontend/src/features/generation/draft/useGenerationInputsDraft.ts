import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  createGenerationInputsDraft,
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

export function useGenerationInputsDraft(
  inputIds: readonly string[],
  widgetTargets: readonly GenerationDraftWidgetTarget[] = [],
): GenerationInputsDraftHandle {
  // One draft for the component's lifetime, so a caller whose addressed inputs
  // change keeps the edits it has already staged — `address` narrows what is
  // shown instead of throwing the draft away. `useState`'s lazy initializer
  // rather than a ref: the value is read during render, which is what a ref is
  // not for.
  const [controller] = useState<GenerationInputsDraftController>(() =>
    createGenerationInputsDraft({ inputIds, widgetTargets }),
  );

  useEffect(() => () => controller.dispose(), [controller]);

  // Compared by value: callers build these arrays inline, so identity changes
  // on every render while the addressed set usually does not.
  const addressKey = JSON.stringify([inputIds, widgetTargets]);
  useEffect(() => {
    controller.address({ inputIds, widgetTargets });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, addressKey]);

  const reading = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return useMemo(
    () => ({
      ...reading,
      commit: controller.commit,
      revert: controller.revert,
      stage: controller.stage,
    }),
    [reading, controller],
  );
}
