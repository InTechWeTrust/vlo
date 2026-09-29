import { useLayoutEffect, useRef } from "react";
import { liveParamStore } from "../../../core/liveParams/liveParamStore";

/**
 * Keep a control's DOM in step with the renderer's live-resolved value for a
 * parameter without re-rendering React on every frame.
 *
 * `apply` writes the model value straight to the DOM. It runs:
 * 1. before first paint on mount, so a remounted control never shows its
 *    React-held value (the clip-start value for animated parameters);
 * 2. on every renderer notification;
 * 3. after a re-render that left `renderedValue` unchanged, because React 19
 *    re-syncs a controlled input to its prop on each update, undoing the
 *    direct write. A render that changed `renderedValue` (slider drag, key
 *    step, committed edit) is left alone: the cached live value may still
 *    predate it.
 */
export function useLiveParamSync(
  transformId: string | undefined,
  paramName: string,
  renderedValue: number,
  apply: (modelValue: number) => void,
) {
  const applyRef = useRef(apply);
  useLayoutEffect(() => {
    applyRef.current = apply;
  });

  useLayoutEffect(() => {
    if (!transformId) return;
    return liveParamStore.subscribe(transformId, paramName, (value) =>
      applyRef.current(value),
    );
  }, [transformId, paramName]);

  const lastRenderedValueRef = useRef(renderedValue);
  useLayoutEffect(() => {
    if (lastRenderedValueRef.current !== renderedValue) {
      lastRenderedValueRef.current = renderedValue;
      return;
    }
    if (!transformId) return;
    const value = liveParamStore.peek(transformId, paramName);
    if (value !== undefined) applyRef.current(value);
  });
}
