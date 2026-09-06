import { useCallback, useSyncExternalStore } from "react";
import {
  generationTextInputClaims,
  type GenerationTextInputClaim,
} from "../services/GenerationTextInputClaims";

/**
 * The claim standing over one text input, or `null` when it is free.
 *
 * Revision-based rather than value-based: the service hands out frozen claim
 * objects and only replaces one when it really changes, so subscribing to the
 * revision is enough and the snapshot stays referentially stable between
 * changes — which `useSyncExternalStore` requires.
 */
export function useGenerationTextInputClaim(
  inputId: string,
): GenerationTextInputClaim | null {
  const subscribe = useCallback(
    (listener: () => void) => generationTextInputClaims.subscribe(listener),
    [],
  );
  const getSnapshot = useCallback(
    () => generationTextInputClaims.getClaim(inputId),
    [inputId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
