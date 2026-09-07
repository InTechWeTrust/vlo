import { create } from "zustand";
import { mediaSecondsToTick, TICKS_PER_SECOND } from "../../core/time";
import { snapTickToGrid, ticksPerFrame } from "../../core/time/frameGrid";
import { getTicksPerFrame, snapSteppedRangeEdge } from "../timelineSelection";
import { normalizeRangeBounds } from "./utils/rangeBounds";
import type { RangeEditEdge } from "./utils/rangeBounds";
import type {
  EditorRangeMask,
  ResolvedEditorSource,
  MiniEditorEditSpec,
  MiniEditorOpenArgs,
  MiniEditorPresentation,
} from "./types";

export type MiniEditorStatus =
  | "preparing"
  | "ready"
  | "saving"
  | "extracting-range"
  | "extracting-frame"
  | "error";

export type MiniEditorExtractionMode = "range" | "frame" | null;

function isWorkingStatus(status: MiniEditorStatus): boolean {
  return (
    status === "saving" ||
    status === "extracting-range" ||
    status === "extracting-frame"
  );
}

/** Minimum trim/range width so handles never collapse onto each other. */
const MIN_SPAN_TICKS = mediaSecondsToTick(0.1);

interface MiniEditorInternal {
  previewMode: boolean;
  openerId: string | null;
  autoPlay: boolean;
  prepare: MiniEditorOpenArgs["prepare"] | null;
  onSave: MiniEditorOpenArgs["onSave"] | null;
  onExtractRange: MiniEditorOpenArgs["onExtractRange"] | null;
  onExtractFrame: MiniEditorOpenArgs["onExtractFrame"] | null;
  closeOnExtractionCancel: boolean;
  onClose: MiniEditorOpenArgs["onClose"] | null;
  onPrevious: MiniEditorOpenArgs["onPrevious"] | null;
  onNext: MiniEditorOpenArgs["onNext"] | null;
  hasPrevious: boolean;
  hasNext: boolean;
  /** Crop frame quantization (null = unconstrained, free dragging). */
  ticksPerFrame: number | null;
  frameStep: number;
  frameOffset: number;
  extractionSnapshot: {
    cropStartTicks: number;
    cropEndTicks: number;
    playheadTicks: number;
  } | null;
}

export interface MiniEditorState {
  isOpen: boolean;
  presentation: MiniEditorPresentation;
  title: string;
  status: MiniEditorStatus;
  error: string | null;
  notice: string | null;

  source: ResolvedEditorSource | null;
  durationTicks: number;
  /** Source pixel dimensions, measured from the <video> element once loaded. */
  sourceWidth: number;
  sourceHeight: number;

  cropStartTicks: number;
  cropEndTicks: number;
  ranges: EditorRangeMask[];
  selectedRangeId: string | null;

  playheadTicks: number;
  isPlaying: boolean;
  extractionMode: MiniEditorExtractionMode;
  controlsCollapsed: boolean;

  _internal: MiniEditorInternal;

  open: (args: MiniEditorOpenArgs) => Promise<void>;
  setNavigationState: (
    openerId: string,
    navigation: {
      onPrevious?: () => void;
      onNext?: () => void;
      hasPrevious: boolean;
      hasNext: boolean;
    },
  ) => void;
  close: () => void;
  setSourceDimensions: (width: number, height: number) => void;
  setCrop: (startTicks: number, endTicks: number, edge?: "start" | "end") => void;
  addRangeAtPlayhead: () => void;
  updateRange: (
    id: string,
    startTicks: number,
    endTicks: number,
    edge?: RangeEditEdge,
  ) => void;
  removeRange: (id: string) => void;
  toggleRange: (id: string) => void;
  selectRange: (id: string | null) => void;
  setPlayhead: (ticks: number) => void;
  setPlaying: (playing: boolean) => void;
  setControlsCollapsed: (collapsed: boolean) => void;
  save: () => Promise<void>;
  beginRangeExtraction: () => void;
  beginFrameExtraction: () => void;
  cancelExtractionSelection: () => void;
  extractRange: () => Promise<void>;
  extractFrame: () => Promise<void>;
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function sourceFrameTicks(
  source: ResolvedEditorSource | null,
  fallback: number | null,
): number | null {
  return source?.fps && Number.isFinite(source.fps) && source.fps > 0
    ? ticksPerFrame(source.fps)
    : fallback;
}

function revokeSource(source: ResolvedEditorSource | null) {
  if (source) {
    URL.revokeObjectURL(source.sourceUrl);
  }
}

const INITIAL: Omit<
  MiniEditorState,
  | "open"
  | "close"
  | "setNavigationState"
  | "setSourceDimensions"
  | "setCrop"
  | "addRangeAtPlayhead"
  | "updateRange"
  | "removeRange"
  | "toggleRange"
  | "selectRange"
  | "setPlayhead"
  | "setPlaying"
  | "setControlsCollapsed"
  | "save"
  | "beginRangeExtraction"
  | "beginFrameExtraction"
  | "cancelExtractionSelection"
  | "extractRange"
  | "extractFrame"
> = {
  isOpen: false,
  presentation: "modal",
  title: "Edit video",
  status: "preparing",
  error: null,
  notice: null,
  source: null,
  durationTicks: 0,
  sourceWidth: 0,
  sourceHeight: 0,
  cropStartTicks: 0,
  cropEndTicks: 0,
  ranges: [],
  selectedRangeId: null,
  playheadTicks: 0,
  isPlaying: false,
  extractionMode: null,
  controlsCollapsed: false,
  _internal: {
    previewMode: false,
    openerId: null,
    autoPlay: false,
    prepare: null,
    onSave: null,
    onExtractRange: null,
    onExtractFrame: null,
    closeOnExtractionCancel: false,
    onClose: null,
    onPrevious: null,
    onNext: null,
    hasPrevious: false,
    hasNext: false,
    ticksPerFrame: null,
    frameStep: 1,
    frameOffset: 1,
    extractionSnapshot: null,
  },
};

export const useMiniEditorStore = create<MiniEditorState>((set, get) => ({
  ...INITIAL,

  open: async (args) => {
    const previous = get();
    const openerId = args.openerId ?? null;
    const displacedOnClose =
      previous.isOpen && previous._internal.openerId !== openerId
        ? previous._internal.onClose
        : null;
    revokeSource(previous.source);
    set({
      ...INITIAL,
      isOpen: true,
      presentation: args.presentation ?? "modal",
      status: "preparing",
      title: args.title ?? "Edit video",
      controlsCollapsed: args.previewMode ?? false,
      ranges: args.initial?.ranges ?? [],
      _internal: {
        previewMode: args.previewMode ?? false,
        openerId,
        autoPlay: args.autoPlay ?? false,
        prepare: args.prepare,
        onSave: args.onSave ?? null,
        onExtractRange: args.onExtractRange ?? null,
        onExtractFrame: args.onExtractFrame ?? null,
        closeOnExtractionCancel: args.closeOnExtractionCancel ?? false,
        onClose: args.onClose ?? null,
        onPrevious: args.onPrevious ?? null,
        onNext: args.onNext ?? null,
        hasPrevious: args.hasPrevious ?? false,
        hasNext: args.hasNext ?? false,
        ticksPerFrame:
          args.frameConstraint && args.frameConstraint.fps > 0
            ? getTicksPerFrame(args.frameConstraint.fps)
            : null,
        frameStep: Math.max(
          1,
          Math.round(args.frameConstraint?.frameStep ?? 1),
        ),
        frameOffset: Math.max(
          1,
          Math.round(args.frameConstraint?.frameOffset ?? 1),
        ),
        extractionSnapshot: null,
      },
    });
    displacedOnClose?.();

    try {
      const source = await args.prepare();
      // A later open()/close() may have superseded this preparation.
      if (get()._internal.prepare !== args.prepare) {
        revokeSource(source);
        return;
      }
      const duration = source.durationTicks;
      const frameTicks = sourceFrameTicks(source, get()._internal.ticksPerFrame);
      const ranges = (args.initial?.ranges ?? []).flatMap((range) => {
        const bounds = normalizeRangeBounds(
          range.startSourceTicks,
          range.endSourceTicks,
          duration,
          frameTicks,
        );
        return bounds ? [{ ...range, ...bounds }] : [];
      });
      const cropStart = clamp(
        args.initial?.cropStartTicks ?? 0,
        0,
        Math.max(0, duration - MIN_SPAN_TICKS),
      );
      const cropEnd =
        duration > 0
          ? clamp(
              args.initial?.cropEndTicks ?? duration,
              cropStart + MIN_SPAN_TICKS,
              duration,
            )
          : 0;
      set({
        status: "ready",
        source,
        durationTicks: duration,
        ranges,
        cropStartTicks: cropStart,
        cropEndTicks: cropEnd,
        playheadTicks: cropStart,
      });
    } catch (error) {
      if (get()._internal.prepare !== args.prepare) return;
      set({
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Failed to prepare the video for editing",
      });
    }
  },

  close: () => {
    const onClose = get()._internal.onClose;
    revokeSource(get().source);
    set({ ...INITIAL });
    onClose?.();
  },

  setNavigationState: (openerId, navigation) => {
    const state = get();
    if (!state.isOpen || state._internal.openerId !== openerId) {
      return;
    }

    set({
      _internal: {
        ...state._internal,
        onPrevious: navigation.onPrevious ?? null,
        onNext: navigation.onNext ?? null,
        hasPrevious: navigation.hasPrevious,
        hasNext: navigation.hasNext,
      },
    });
  },

  setSourceDimensions: (width, height) => {
    if (width > 0 && height > 0) {
      set({ sourceWidth: width, sourceHeight: height });
    }
  },

  setCrop: (startTicks, endTicks, edge) => {
    const state = get();
    const { durationTicks } = state;
    const { ticksPerFrame, frameStep, frameOffset } = state._internal;

    let start = clamp(
      startTicks,
      0,
      Math.max(0, durationTicks - MIN_SPAN_TICKS),
    );
    let end = clamp(endTicks, start + MIN_SPAN_TICKS, durationTicks);

    if (ticksPerFrame && ticksPerFrame > 0) {
      // Anchor the endpoint the user is not dragging, then quantize the span.
      const startMoved = startTicks !== state.cropStartTicks;
      const endMoved = endTicks !== state.cropEndTicks;
      if (endMoved && !startMoved) {
        const snappedEnd = snapSteppedRangeEdge({
          edge: "end",
          proposedTick: end,
          fixedTick: start,
          ticksPerFrame,
          frameStep,
          frameOffset,
          maxTick: durationTicks,
        });
        // No grid-valid end fits between here and the source's end: leave the
        // crop where it was rather than committing an off-grid span.
        if (snappedEnd === null) return;
        end = snappedEnd;
      } else {
        const snappedStart = snapSteppedRangeEdge({
          edge: "start",
          proposedTick: start,
          fixedTick: end,
          ticksPerFrame,
          frameStep,
          frameOffset,
          minTick: 0,
          maxTick: durationTicks,
        });
        if (snappedStart === null) return;
        start = snappedStart;
      }
    }

    set({
      cropStartTicks: start,
      cropEndTicks: end,
      playheadTicks: edge
        ? edge === "start"
          ? start
          : end
        : clamp(get().playheadTicks, start, end),
      ...(edge ? { isPlaying: false } : {}),
    });
  },

  addRangeAtPlayhead: () => {
    const {
      playheadTicks, cropStartTicks, cropEndTicks, durationTicks, source, _internal,
    } = get();
    const anchor = clamp(playheadTicks, 0, durationTicks);
    const defaultLen = Math.min(TICKS_PER_SECOND, durationTicks);
    let start = clamp(anchor, 0, Math.max(0, durationTicks - defaultLen));
    let end = clamp(start + defaultLen, start + MIN_SPAN_TICKS, durationTicks);
    // Bias the seed toward the visible crop window when possible.
    if (cropEndTicks > cropStartTicks) {
      start = clamp(
        start,
        cropStartTicks,
        Math.max(cropStartTicks, cropEndTicks - MIN_SPAN_TICKS),
      );
      end = clamp(end, start + MIN_SPAN_TICKS, cropEndTicks);
    }
    const bounds = normalizeRangeBounds(
      start,
      end,
      durationTicks,
      sourceFrameTicks(source, _internal.ticksPerFrame),
    );
    if (!bounds) return;
    const range: EditorRangeMask = {
      id: `range_${crypto.randomUUID()}`,
      ...bounds,
      isActive: true,
    };
    set((state) => ({
      ranges: [...state.ranges, range],
      selectedRangeId: range.id,
    }));
  },

  updateRange: (id, startTicks, endTicks, edge) => {
    const { durationTicks, source, _internal } = get();
    const bounds = normalizeRangeBounds(
      startTicks,
      endTicks,
      durationTicks,
      sourceFrameTicks(source, _internal.ticksPerFrame),
      edge,
    );
    if (!bounds || !get().ranges.some((range) => range.id === id)) return;
    set((state) => ({
      ranges: state.ranges.map((range) =>
        range.id === id
          ? { ...range, ...bounds }
          : range,
      ),
      ...(edge
        ? {
            isPlaying: false,
            playheadTicks:
              edge === "end" ? bounds.endSourceTicks : bounds.startSourceTicks,
          }
        : {}),
    }));
  },

  removeRange: (id) =>
    set((state) => ({
      ranges: state.ranges.filter((range) => range.id !== id),
      selectedRangeId:
        state.selectedRangeId === id ? null : state.selectedRangeId,
    })),

  toggleRange: (id) =>
    set((state) => ({
      ranges: state.ranges.map((range) =>
        range.id === id ? { ...range, isActive: !range.isActive } : range,
      ),
    })),

  selectRange: (id) => set({ selectedRangeId: id }),

  setPlayhead: (ticks) => {
    const state = get();
    const clamped = clamp(ticks, 0, state.durationTicks);
    const frameTicks = sourceFrameTicks(
      state.source,
      state._internal.ticksPerFrame,
    );
    const playheadTicks = frameTicks
      ? clamp(
          snapTickToGrid(clamped, frameTicks),
          0,
          snapTickToGrid(state.durationTicks, frameTicks, "floor"),
        )
      : clamped;
    if (playheadTicks === state.playheadTicks) return;
    set({ playheadTicks });
  },

  setPlaying: (playing) => {
    if (playing === get().isPlaying) return;
    set({ isPlaying: playing });
  },

  setControlsCollapsed: (collapsed) => {
    if (isWorkingStatus(get().status)) return;
    if (collapsed) get().cancelExtractionSelection();
    set({ controlsCollapsed: collapsed });
  },

  save: async () => {
    const state = get();
    const { source } = state;
    const onSave = state._internal.onSave;
    if (!source || !onSave || isWorkingStatus(state.status)) return;

    set({ status: "saving", error: null, notice: null, isPlaying: false });
    const spec: MiniEditorEditSpec = {
      cropStartTicks: state.cropStartTicks,
      cropEndTicks: state.cropEndTicks,
      ranges: state.ranges,
    };
    try {
      await onSave(spec, source);
      // onSave succeeded; tear down (revokes the source URL).
      get().close();
    } catch (error) {
      set({
        status: "error",
        error:
          error instanceof Error ? error.message : "Failed to save the edit",
      });
    }
  },

  beginRangeExtraction: () => {
    const state = get();
    if (
      !state.source ||
      !state._internal.onExtractRange ||
      isWorkingStatus(state.status) ||
      state.extractionMode !== null
    ) {
      return;
    }

    set({
      extractionMode: "range",
      controlsCollapsed: false,
      error: null,
      notice: null,
      isPlaying: false,
      _internal: {
        ...state._internal,
        extractionSnapshot: {
          cropStartTicks: state.cropStartTicks,
          cropEndTicks: state.cropEndTicks,
          playheadTicks: state.playheadTicks,
        },
      },
    });
  },

  beginFrameExtraction: () => {
    const state = get();
    if (
      !state.source ||
      !state._internal.onExtractFrame ||
      isWorkingStatus(state.status) ||
      state.extractionMode !== null
    ) {
      return;
    }

    set({
      extractionMode: "frame",
      controlsCollapsed: false,
      error: null,
      notice: null,
      isPlaying: false,
      _internal: {
        ...state._internal,
        extractionSnapshot: {
          cropStartTicks: state.cropStartTicks,
          cropEndTicks: state.cropEndTicks,
          playheadTicks: state.playheadTicks,
        },
      },
    });
  },

  cancelExtractionSelection: () => {
    const state = get();
    if (state.extractionMode === null || isWorkingStatus(state.status)) {
      return;
    }

    const snapshot = state._internal.extractionSnapshot;
    set({
      extractionMode: null,
      ...(snapshot
        ? {
            cropStartTicks: snapshot.cropStartTicks,
            cropEndTicks: snapshot.cropEndTicks,
            playheadTicks: snapshot.playheadTicks,
          }
        : {}),
      error: null,
      _internal: {
        ...state._internal,
        extractionSnapshot: null,
      },
    });
  },

  extractRange: async () => {
    const state = get();
    const { source } = state;
    const onExtractRange = state._internal.onExtractRange;
    if (
      !source ||
      !onExtractRange ||
      isWorkingStatus(state.status) ||
      state.extractionMode !== "range"
    ) {
      return;
    }

    set({
      status: "extracting-range",
      error: null,
      notice: null,
      isPlaying: false,
    });
    try {
      const successNotice = await onExtractRange(
        {
          cropStartTicks: state.cropStartTicks,
          cropEndTicks: state.cropEndTicks,
          ranges: state.ranges,
        },
        source,
      );
      if (
        get().source === source &&
        get()._internal.onExtractRange === onExtractRange
      ) {
        set((current) => ({
          status: "ready",
          notice: successNotice ?? null,
          extractionMode: null,
          _internal: {
            ...current._internal,
            extractionSnapshot: null,
          },
        }));
      }
    } catch (error) {
      if (
        get().source !== source ||
        get()._internal.onExtractRange !== onExtractRange
      ) {
        return;
      }
      set({
        status: "error",
        error:
          error instanceof Error ? error.message : "Failed to extract range",
      });
    }
  },

  extractFrame: async () => {
    const state = get();
    const { source } = state;
    const onExtractFrame = state._internal.onExtractFrame;
    if (
      !source ||
      !onExtractFrame ||
      isWorkingStatus(state.status) ||
      state.extractionMode !== "frame"
    ) {
      return;
    }

    set({
      status: "extracting-frame",
      error: null,
      notice: null,
      isPlaying: false,
    });
    try {
      const successNotice = await onExtractFrame(state.playheadTicks, source);
      if (
        get().source === source &&
        get()._internal.onExtractFrame === onExtractFrame
      ) {
        set((current) => ({
          status: "ready",
          notice: successNotice ?? null,
          extractionMode: null,
          _internal: {
            ...current._internal,
            extractionSnapshot: null,
          },
        }));
      }
    } catch (error) {
      if (
        get().source !== source ||
        get()._internal.onExtractFrame !== onExtractFrame
      ) {
        return;
      }
      set({
        status: "error",
        error:
          error instanceof Error ? error.message : "Failed to extract frame",
      });
    }
  },
}));
