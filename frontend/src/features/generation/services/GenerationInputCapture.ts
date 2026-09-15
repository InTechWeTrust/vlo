import { generationSessionService } from "./GenerationSessionService";
import { useExtractStore } from "../../../core/extract/useExtractStore";
import { useTimelineSelectionStore } from "../../timelineSelection";
import type { GenerationCapturedMedia } from "../utils/capturedMedia";
import type { GenerationInputsDraftController } from "../draft/generationInputsDraftController";

export interface GenerationCaptureDestination {
  complete(capture: GenerationCapturedMedia): Promise<void>;
  fail(message: string): void;
  active(): boolean;
}

type CaptureHandler = (inputId: string, type: "image" | "video" | "audio", destination: GenerationCaptureDestination) => void;
let handler: CaptureHandler | null = null;

/** The mounted panel supplies its ordinary selection and extraction flow. */
export function registerGenerationInputCapture(next: CaptureHandler): () => void {
  handler = next;
  return () => { if (handler === next) handler = null; };
}

/** Hold native captured media in the draft until its atomic panel commit. */
export function captureGenerationDraftInput(
  controller: GenerationInputsDraftController,
  inputId: string,
  at: number,
  onDone: (error: string | null) => void,
): () => void {
  const reading = controller.getSnapshot();
  const workflow = generationSessionService.getSnapshot()?.workflow;
  const input = reading.inputs.find((entry) => entry.id === inputId);
  const extract = useExtractStore.getState();
  if (!handler || reading.status !== "ready" || reading.hasConflict || !input || input.inputType === "text" ||
    !Number.isInteger(at) || at < 0 || at > (input.media?.length ?? 0) ||
    (input.reservedSlotIds?.length ?? 0) > 0 ||
    (at === (input.media?.length ?? 0) && at >= (input.repeatable?.max ?? 1))) {
    onDone("This reference cannot be captured right now.");
    return () => undefined;
  }
  if (extract.frameSelectionMode || extract.isProcessing || useTimelineSelectionStore.getState().selectionMode) {
    onDone("Finish the current timeline selection first.");
    return () => undefined;
  }
  let live = true;
  const initialItems = input.media?.map((item) => item.itemId).join("|") ?? "";
  const stillCurrent = () => {
    const next = controller.getSnapshot();
    const currentWorkflow = generationSessionService.getSnapshot()?.workflow;
    const sameWorkflow = currentWorkflow?.revision === workflow?.revision;
    const current = next.inputs.find((entry) => entry.id === inputId);
    return live && sameWorkflow && (!reading.hasDraftChanges || next.hasDraftChanges) && next.status === "ready" && !next.hasConflict && current !== undefined &&
      (current.media?.map((item) => item.itemId).join("|") ?? "") === initialItems;
  };
  const finish = (error: string | null) => {
    if (!live) return;
    live = false;
    unsubscribe();
    onDone(error);
  };
  const unsubscribe = controller.subscribe(() => {
    if (!stillCurrent()) cancel();
  });
  const provider = handler;
  provider(inputId, input.inputType, {
    active: stillCurrent,
    fail: finish,
    complete: async (capture) => {
      if (!stillCurrent()) return;
      // Unsubscribe before our own stage changes the arrangement.
      unsubscribe();
      controller.stageCapture(inputId, at, capture);
      finish(controller.getSnapshot().error);
    },
  });
  const confirm = useExtractStore.getState().onConfirmSelection;
  function cancel() {
    if (!live) return;
    if (useExtractStore.getState().onConfirmSelection === confirm) {
      useExtractStore.getState().exitFrameSelectionMode();
      useExtractStore.getState().setOnConfirmSelection(null);
      useTimelineSelectionStore.getState().exitSelectionMode();
      useTimelineSelectionStore.getState().clearSelectionRecommendations();
    }
    finish(null);
  }
  useExtractStore.getState().setOnCancelSelection(cancel);
  return cancel;
}
