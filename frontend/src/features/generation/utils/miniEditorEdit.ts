import type { Asset } from "../../../types/Asset";
import type { RangeMaskComponent } from "../../../types/Components";
import type {
  TimelineClip,
  TimelineSelection,
  TimelineTrack,
  VideoTimelineClip,
} from "../../../types/TimelineTypes";
import type { ExportConfig, ProjectData } from "../../renderer";
import type {
  DerivedMaskSourceVideoTreatment,
  DerivedMaskType,
} from "../pipeline/types";
import {
  createClipFromAsset,
  createTimelinePlacementMapper,
  presentationTick,
  storedTrackTick,
  timelineTimeValue,
} from "../../timeline";
import { tickToMediaSeconds } from "../../../core/time";
import {
  clipSourceTimeToVisual,
  clipVisualToSourceTime,
} from "../../transformations";
import { getTicksPerFrame, snapTickToFrame } from "../../timelineSelection";
import { useProjectStore } from "../../project";
import type {
  EditorRangeMask,
  ResolvedEditorSource,
  MiniEditorEditSpec,
} from "../../miniEditor";
import {
  renderTimelineSelectionToMaskOutput,
  renderTimelineSelectionToMp4,
  renderTimelineSelectionToMp4WithMask,
  type DerivedMaskRenderKey,
} from "./inputSelection";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Where a selection's clips appear, resolved against the selection's own
 * snapshot. Selection bounds and editor ranges are presentation ticks; a clip's
 * `start` is a stored tick, and the two differ under adjustment retiming (a
 * ripple adjustment ahead of the clip shifts it, a static one over its head
 * offsets its source mapping). Range masks are converted through this so they
 * land on the source frames the editor showed.
 */
export interface SelectionClipPlacement {
  footprint(clip: TimelineClip): { start: number; end: number };
  /** Presentation tick (clamped to the clip's footprint) → source-media ticks. */
  presentationToSourceTime(clip: TimelineClip, tick: number): number;
  /** Source-media ticks → the presentation tick showing them. */
  sourceTimeToPresentation(clip: TimelineClip, sourceTicks: number): number;
}

export function createSelectionClipPlacement(
  selection: Pick<TimelineSelection, "clips" | "tracks">,
): SelectionClipPlacement {
  // Presentation quantizes on the project grid, like the renderer, whatever
  // fps the selection itself renders at.
  const mapper = createTimelinePlacementMapper({
    tracks: selection.tracks ?? [],
    clips: selection.clips,
    fps: Math.max(1, useProjectStore.getState().config.fps),
  });
  const footprint = (clip: TimelineClip) =>
    mapper.getPresentationFootprint(clip.id) ?? {
      start: clip.start,
      end: clip.start + clip.timelineDuration,
    };
  return {
    footprint,
    presentationToSourceTime(clip, tick) {
      const { start, end } = footprint(clip);
      const stored =
        mapper.mapPresentationTickToStoredTick(
          clip.id,
          presentationTick(clamp(tick, start, end)),
        ) ?? storedTrackTick(clamp(tick, start, end));
      const clipOffset = clamp(
        timelineTimeValue(stored) - clip.start,
        0,
        clip.timelineDuration,
      );
      return Math.max(0, clipVisualToSourceTime(clip, clipOffset));
    },
    sourceTimeToPresentation(clip, sourceTicks) {
      const stored = storedTrackTick(
        clip.start + clipSourceTimeToVisual(clip, sourceTicks),
      );
      const mapped = mapper.mapStoredTickToPresentationTick(clip.id, stored);
      return mapped === null
        ? timelineTimeValue(stored)
        : timelineTimeValue(mapped);
    },
  };
}

interface SelectionEditorRange {
  clipId: string;
  componentId: string;
  range: EditorRangeMask;
}

function collectSelectionEditorRanges(
  selection: TimelineSelection,
): SelectionEditorRange[] {
  const placement = createSelectionClipPlacement(selection);
  return selection.clips.flatMap((clip) => {
    if (clip.type === "mask" || clip.type === "audio") return [];
    const footprint = placement.footprint(clip);
    const start = Math.max(selection.start, footprint.start);
    const end = Math.min(selection.end ?? footprint.end, footprint.end);
    return (clip.components ?? []).flatMap((component) => {
      if (component.type !== "range_mask") return [];
      const a = placement.sourceTimeToPresentation(
        clip,
        component.parameters.startSourceTicks,
      );
      const b = placement.sourceTimeToPresentation(
        clip,
        component.parameters.endSourceTicks,
      );
      const rangeStart = Math.max(start, Math.min(a, b));
      const rangeEnd = Math.min(end, Math.max(a, b));
      if (rangeEnd <= rangeStart) return [];
      return [
        {
          clipId: clip.id,
          componentId: component.id,
          range: {
            ...component.parameters,
            isActive:
              component.isEnabled !== false && component.parameters.isActive,
            // Component ids need only be unique within their owning clip.
            id: JSON.stringify([clip.id, component.id]),
            startSourceTicks: Math.round(rangeStart - selection.start),
            endSourceTicks: Math.round(rangeEnd - selection.start),
          },
        },
      ];
    });
  });
}

function removeSelectionEditorRanges(
  selection: TimelineSelection,
  entries: SelectionEditorRange[],
): TimelineSelection {
  return {
    ...selection,
    clips: selection.clips.map((clip) => {
      if (clip.type === "mask") return clip;
      const ids = new Set(
        entries
          .filter((entry) => entry.clipId === clip.id)
          .map((entry) => entry.componentId),
      );
      if (ids.size === 0) return clip;
      return {
        ...clip,
        components: clip.components?.filter(
          (component) => !ids.has(component.id),
        ),
      };
    }),
  };
}

/** Restore editable ranges and preview the underlying video without baking them in. */
export function getTimelineSelectionEditorState(selection: TimelineSelection) {
  const entries = collectSelectionEditorRanges(selection);
  return {
    ranges: entries.map((entry) => entry.range),
    previewSelection: removeSelectionEditorRanges(selection, entries),
  };
}

/**
 * Adds range_mask components to every clip that intersects each range.
 *
 * Ranges are expressed in editor-local ticks (0 == the start of the rendered
 * selection); `selectionStartTicks` shifts them back onto the global
 * (presentation) timeline. For each clip we intersect the global range with
 * the clip's presentation footprint and convert the overlap into the clip's
 * source-tick domain via `placement` — which clamps to the clip's bounds, so a
 * range that straddles a clip edge (or overruns the clip) is split cleanly
 * across the clips it touches rather than producing an out-of-range window.
 * `placement` defaults to the clips' own snapshot with no tracks, i.e. no
 * adjustment retiming; pass the selection's placement when there is one.
 *
 * The function is non-mutating: clips that gain a mask are returned as fresh
 * objects with a new components array; untouched clips are returned as-is.
 */
export function addRangeMasksToClips(
  clips: TimelineClip[],
  ranges: EditorRangeMask[],
  selectionStartTicks: number,
  placement: SelectionClipPlacement = createSelectionClipPlacement({ clips }),
): TimelineClip[] {
  const validRanges = ranges.filter(
    (range) => range.endSourceTicks > range.startSourceTicks,
  );
  if (validRanges.length === 0) {
    return clips;
  }

  return clips.map((clip) => {
    // Spatial mask clips carry no range_mask; audio is not part of the visual
    // matte, so masking it would be a no-op.
    if (clip.type === "mask" || clip.type === "audio") {
      return clip;
    }

    const { start: clipStart, end: clipEnd } = placement.footprint(clip);
    const newComponents: RangeMaskComponent[] = [];

    for (const range of validRanges) {
      const globalStart = selectionStartTicks + range.startSourceTicks;
      const globalEnd = selectionStartTicks + range.endSourceTicks;
      const overlapStart = Math.max(clipStart, globalStart);
      const overlapEnd = Math.min(clipEnd, globalEnd);
      if (overlapEnd <= overlapStart) {
        continue;
      }

      const a = placement.presentationToSourceTime(clip, overlapStart);
      const b = placement.presentationToSourceTime(clip, overlapEnd);
      const startSourceTicks = Math.round(Math.min(a, b));
      const endSourceTicks = Math.round(Math.max(a, b));
      if (endSourceTicks <= startSourceTicks) {
        continue;
      }

      newComponents.push({
        id: `range_${crypto.randomUUID()}`,
        type: "range_mask",
        parameters: {
          startSourceTicks,
          endSourceTicks,
          isActive: range.isActive,
          ...(range.name === undefined ? {} : { name: range.name }),
        },
      });
    }

    if (newComponents.length === 0) {
      return clip;
    }

    return {
      ...clip,
      components: [...(clip.components ?? []), ...newComponents],
    };
  });
}

/**
 * Derives a new, true TimelineSelection from the one already attached to a
 * generation video input:
 *  - the crop window narrows the selection's [start, end];
 *  - range masks are written as range_mask components onto the intersecting
 *    clips (a non-mutating edit of the stored selection's clips).
 *
 * The result renders through the normal selection pipeline, so the original
 * spatial masks, transforms and metadata are preserved and the derived mask
 * is recomputed from real transparency — no baked-in re-render or mask OR.
 */
export function buildEditedTimelineSelection(
  source: TimelineSelection,
  spec: MiniEditorEditSpec,
): TimelineSelection {
  const base = source.start;
  const sourceDuration = Math.max(0, (source.end ?? base) - base);

  const fps =
    typeof source.fps === "number" && source.fps > 0 ? source.fps : null;
  const ticksPerFrame = fps ? getTicksPerFrame(fps) : null;
  const snap = (tick: number) =>
    ticksPerFrame ? snapTickToFrame(tick, ticksPerFrame) : tick;

  const cropStart = clamp(spec.cropStartTicks, 0, sourceDuration);
  const cropEnd = clamp(spec.cropEndTicks, cropStart, sourceDuration);
  const newStart = base + snap(cropStart);
  const newEnd = Math.max(newStart + 1, base + snap(cropEnd));

  // Replace the ranges exposed by the editor, including deletions. Existing
  // ranges remain scoped to their clip; newly added ranges span the selection.
  const entries = collectSelectionEditorRanges(source);
  const owners = new Map(entries.map((entry) => [entry.range.id, entry.clipId]));
  const editableSource = removeSelectionEditorRanges(source, entries);
  const placement = createSelectionClipPlacement(source);
  const clips = editableSource.clips.flatMap((clip) =>
    addRangeMasksToClips(
      [clip],
      spec.ranges.filter(
        (range) => !owners.has(range.id) || owners.get(range.id) === clip.id,
      ),
      base,
      placement,
    ),
  );

  return {
    ...source,
    start: newStart,
    end: newEnd,
    clips,
  };
}

interface EditedRenderInputs {
  exportConfig: ExportConfig;
  projectData: ProjectData;
  selection: TimelineSelection;
}

/**
 * One matte the workflow asks of this source, keyed exactly as the timeline
 * path keys its derived-mask renders so the two stay interchangeable.
 */
export interface SyntheticEditedMaskRequest {
  key: DerivedMaskRenderKey;
  maskType: DerivedMaskType;
  sourceVideoTreatment?: DerivedMaskSourceVideoTreatment;
}

export interface SyntheticEditedRenderResult {
  /** Cropped video (full frames; mp4 has no alpha so masks live in the matte). */
  video: File;
  /** One matte per requested render key; empty when none was requested. */
  masks: Partial<Record<DerivedMaskRenderKey, File>>;
  /** False for a matte that came back entirely black. */
  maskContentByKey: Partial<Record<DerivedMaskRenderKey, boolean>>;
}

function toEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Builds an in-memory single-track, single-clip project for an editable video
 * *asset* (one that is not backed by the timeline): a synthetic video asset
 * trimmed to the crop window with range_mask components for the masked
 * windows. Used only for the asset path, where there is no real selection to
 * rebuild. Touches no global store.
 */
function buildSyntheticRenderInputs(
  spec: MiniEditorEditSpec,
  source: ResolvedEditorSource,
  dims: { width: number; height: number; fps?: number },
): EditedRenderInputs {
  const durationTicks = Math.max(0, Math.round(source.durationTicks));
  const cropStart = clamp(spec.cropStartTicks, 0, durationTicks);
  const cropEnd = clamp(spec.cropEndTicks, cropStart, durationTicks);
  const cropLen = Math.max(1, cropEnd - cropStart);

  // Keep the library asset's own id when the source came from one: the export
  // renderer resolves clip audio through the global asset store by id, so a
  // synthetic id renders the video silently.
  const asset: Asset = {
    id: source.assetId ?? `mini_editor_source_${crypto.randomUUID()}`,
    hash: "mini-editor-source",
    name: source.sourceFile.name || "edited-video",
    type: "video",
    src: source.sourceUrl,
    file: source.sourceFile,
    duration: tickToMediaSeconds(durationTicks),
    createdAt: Date.now(),
  };

  const baseClip = createClipFromAsset(asset);
  // The synthetic clip plays the asset's own timebase, so range ticks (which
  // are editor-local / asset-relative) are already in the clip's source domain.
  const components: RangeMaskComponent[] = spec.ranges.map((range) => ({
    id: range.id,
    type: "range_mask",
    parameters: {
      startSourceTicks: Math.round(range.startSourceTicks),
      endSourceTicks: Math.round(range.endSourceTicks),
      isActive: range.isActive,
    },
  }));

  const clip: VideoTimelineClip = {
    ...baseClip,
    type: "video",
    assetId: asset.id,
    trackId: "mini_editor_track",
    start: 0,
    offset: cropStart,
    sourceDuration: durationTicks,
    timelineDuration: cropLen,
    croppedSourceDuration: cropLen,
    transformedOffset: cropStart,
    transformedDuration: durationTicks,
    components,
  };

  const track: TimelineTrack = {
    id: "mini_editor_track",
    type: "visual",
    label: "Video",
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };

  const exportConfig: ExportConfig = {
    logicalWidth: dims.width,
    logicalHeight: dims.height,
    outputWidth: toEven(dims.width),
    outputHeight: toEven(dims.height),
    backgroundAlpha: 0,
  };

  const fps = Math.max(1, dims.fps ?? useProjectStore.getState().config.fps);
  const projectData: ProjectData = {
    tracks: [track],
    clips: [clip],
    assets: [asset],
    duration: cropLen,
    fps,
  };

  const selection: TimelineSelection = {
    start: 0,
    end: cropLen,
    clips: [clip],
    tracks: [track],
    fps,
  };

  return { exportConfig, projectData, selection };
}

/**
 * Collapses duplicate render keys and rejects a set the pair renderer could not
 * satisfy: the source video is rendered once, so its treatment must be agreed.
 */
function dedupeMaskRequests(
  requests: readonly SyntheticEditedMaskRequest[],
): SyntheticEditedMaskRequest[] {
  const byKey = new Map<DerivedMaskRenderKey, SyntheticEditedMaskRequest>();
  const treatments = new Set<DerivedMaskSourceVideoTreatment>();
  for (const request of requests) {
    treatments.add(request.sourceVideoTreatment ?? "remove_transparency");
    if (!byKey.has(request.key)) {
      byKey.set(request.key, request);
    }
  }
  if (treatments.size > 1) {
    throw new Error(
      "Derived masks for a single source requested conflicting source video treatments",
    );
  }
  return [...byKey.values()];
}

/**
 * Bakes an edit of a plain video asset (no backing timeline selection) into the
 * files the generation pipeline consumes: a cropped video that keeps the
 * asset's own soundtrack, plus — when the workflow has a derived-mask input —
 * a separate matte for the masked windows, derived from their transparency.
 */
export async function renderSyntheticEditedOutputs(
  spec: MiniEditorEditSpec,
  source: ResolvedEditorSource,
  dims: { width: number; height: number; fps?: number },
  options: {
    signal?: AbortSignal;
    /**
     * The mattes the workflow's derived-mask mappings ask for, deduplicated by
     * render key. Every one of them is rendered — an empty matte included,
     * since the bake is the only render this input will ever get. With none
     * requested the ranges have nowhere separate to go and are baked into the
     * video instead, exactly as a timeline-selection input does when the
     * workflow has no derived-mask node.
     */
    maskRequests?: readonly SyntheticEditedMaskRequest[];
  } = {},
): Promise<SyntheticEditedRenderResult> {
  const { exportConfig, projectData, selection } = buildSyntheticRenderInputs(
    spec,
    source,
    dims,
  );
  const renderInputs = {
    exportConfig,
    projectData,
    brushMasksPrepared: true as const,
  };

  const maskRequests = dedupeMaskRequests(options.maskRequests ?? []);
  if (maskRequests.length === 0) {
    const video = await renderTimelineSelectionToMp4(selection, {
      signal: options.signal,
      renderInputs,
    });
    return { video, masks: {}, maskContentByKey: {} };
  }

  // The first request renders the pair — the source video's treatment is a
  // property of the pair render, so it comes from that request; conflicting
  // treatments are rejected the same way the timeline path rejects them.
  const [primary, ...secondary] = maskRequests;
  const { video, mask, maskHasVisibleContent } =
    await renderTimelineSelectionToMp4WithMask(selection, primary.maskType, {
      signal: options.signal,
      sourceVideoTreatment: primary.sourceVideoTreatment,
      renderInputs,
    });

  const masks: Partial<Record<DerivedMaskRenderKey, File>> = {
    [primary.key]: mask,
  };
  const maskContentByKey: Partial<Record<DerivedMaskRenderKey, boolean>> = {
    [primary.key]: maskHasVisibleContent,
  };

  // Remaining flavours reuse the same synthetic project, so they land frame
  // for frame on the video already rendered above.
  for (const request of secondary) {
    const { file, hasVisibleContent } = await renderTimelineSelectionToMaskOutput(
      selection,
      request.maskType,
      {
        signal: options.signal,
        trackRenderedMaskContent: true,
        renderInputs,
      },
    );
    masks[request.key] = file;
    maskContentByKey[request.key] = hasVisibleContent;
  }

  return { video, masks, maskContentByKey };
}
