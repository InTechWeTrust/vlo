import { create } from "zustand";
import type { ExportPhase } from "../export/exportProgress";

export type DialogView =
  | "choose"
  | "export"
  | "extracting-frame"
  | "extracting-selection";

export interface ExtractState {
  // Dialog
  dialogOpen: boolean;
  dialogView: DialogView;
  openDialog: () => void;
  closeDialog: () => void;
  setDialogView: (view: DialogView) => void;

  // Frame Selection mode
  frameSelectionMode: boolean;
  enterFrameSelectionMode: () => void;
  exitFrameSelectionMode: () => void;

  // Callback set by Player.tsx, invoked by SelectionOverlay on confirm
  onConfirmSelection: (() => void) | null;
  setOnConfirmSelection: (cb: (() => void) | null) => void;
  onCancelSelection: (() => void) | null;
  setOnCancelSelection: (cb: (() => void) | null) => void;

  // Processing progress (shared)
  isProcessing: boolean;
  progress: number;
  phase: ExportPhase | null;
  error: string | null;
  setPhase: (phase: ExportPhase) => void;
  setError: (error: string) => void;
  setProgress: (p: number) => void;
  setIsProcessing: (v: boolean) => void;
}

export const useExtractStore = create<ExtractState>((set) => ({
  dialogOpen: false,
  dialogView: "choose",
  openDialog: () => set({ dialogOpen: true, dialogView: "choose", error: null, phase: null }),
  closeDialog: () =>
    set({
      dialogOpen: false,
      dialogView: "choose",
      isProcessing: false,
      progress: 0,
      phase: null,
      error: null,
  }),
  setDialogView: (view) => set({ dialogView: view }),

  frameSelectionMode: false,
  enterFrameSelectionMode: () => set({ frameSelectionMode: true }),
  exitFrameSelectionMode: () => set({ frameSelectionMode: false }),

  onConfirmSelection: null,
  // Arming a confirm handler begins a new selection flow, so it also clears any
  // cancel handler left over from a previous flow. Only the ComfyUI editor arms
  // a cancel handler (to reopen itself); without this reset it could outlive a
  // takeover by another flow and fire on that flow's unrelated cancel. A flow
  // that wants both handlers (the editor) must set confirm first, then cancel.
  setOnConfirmSelection: (cb) =>
    set({ onConfirmSelection: cb, onCancelSelection: null }),
  onCancelSelection: null,
  setOnCancelSelection: (cb) => set({ onCancelSelection: cb }),

  isProcessing: false,
  progress: 0,
  phase: null,
  error: null,
  setPhase: (phase) => set({ phase }),
  setError: (error) => set({ error, isProcessing: false }),
  // Whole percentages only, and no update when that does not change: every
  // update redraws the progress UI, in the dialog and the progress PiP, and
  // on-screen change during an export slows it down (pip-render-plan.md,
  // phase 1). Renderers report far more often than a person can read.
  setProgress: (p) =>
    set((state) => {
      const progress = Math.floor(p);
      return progress === state.progress ? state : { progress };
    }),
  setIsProcessing: (v) => set(v ? { isProcessing: true, phase: "preparing", error: null } : { isProcessing: false }),
}));
