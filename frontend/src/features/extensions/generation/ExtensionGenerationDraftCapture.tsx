import { useEffect, useLayoutEffect, useRef } from "react";
import { captureGenerationDraftInput } from "../../generation/services/GenerationInputCapture";
import { nativeDraftFor } from "./extensionGenerationInputsDraft";

interface ExtensionGenerationDraftCaptureProps {
  controller: unknown;
  inputId: string;
  at: number;
  onDone: (error: string | null) => void;
}

export function ExtensionGenerationDraftCapture({ controller, inputId, at, onDone }: ExtensionGenerationDraftCaptureProps) {
  const callback = useRef(onDone);
  useLayoutEffect(() => { callback.current = onDone; }, [onDone]);
  useEffect(() => {
    const native = nativeDraftFor(controller);
    if (!native) { callback.current("This draft is no longer available."); return; }
    let mounted = true;
    const cancel = captureGenerationDraftInput(native, inputId, at, (error) => {
      if (mounted) callback.current(error);
    });
    return () => {
      // StrictMode replays setup/cleanup. Cleanup cancels this selection, but
      // must not dismiss the owner's capture request before the next setup.
      mounted = false;
      cancel();
    };
  }, [controller, inputId, at]);
  return null;
}
