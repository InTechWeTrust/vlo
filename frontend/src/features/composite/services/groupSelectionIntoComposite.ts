import { projectTimelineSelection } from "../../timeline/time";
import type {
  TimelineSelection,
  VideoTimelineClip,
} from "../../../types/TimelineTypes";
import {
  renamespaceCompositeContentTracks,
  selectionToCompositeContent,
} from "../../timelineSelection";
import {
  getTimelineTracks,
  getTimelineClips,
  getTimelineClipsInPresentationRange,
  getTimelineTransitions,
  groupTimelineClipsIntoComposite,
} from "../../timeline/api";
import { prepareBrushMasksForTimelineRender } from "../../masks/api";
import { useProjectStore } from "../../project/useProjectStore";
import { createCompositeTimelineClipFromAsset } from "../utils/createCompositeClip";
import { useCompositeLibraryStore } from "../useCompositeLibraryStore";

export interface GroupSelectionOptions {
  name?: string;
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
}

/**
 * Chooses the track the composite clip should occupy: the highest (earliest in
 * track order) track that contains a non-mask clip in the selection, falling
 * back to the first selected clip's track, then the first project track.
 */
function pickTargetTrackId(selection: TimelineSelection): string | null {
  const tracks = selection.region.tracks ?? getTimelineTracks();
  const occupiedTrackIds = new Set(
    selection.region.clips
      .filter((clip) => clip.type !== "mask")
      .map((clip) => clip.trackId),
  );
  const ordered = tracks.find((track) => occupiedTrackIds.has(track.id));
  if (ordered) {
    return ordered.id;
  }
  return (
    selection.region.clips.find((clip) => clip.type !== "mask")?.trackId ??
    tracks[0]?.id ??
    null
  );
}

/**
 * Captures a timeline selection as a Composite clip: normalize the region to
 * local zero, commit its canonical asset, then atomically swap the selection's
 * clips for a single live-renderable composite clip anchored at the selection
 * start. Cache baking continues independently after this function returns.
 *
 * Returns the created clip, or null if the selection had no placeable track.
 */
export async function groupSelectionIntoComposite(
  selection: TimelineSelection,
  options: GroupSelectionOptions = {},
): Promise<VideoTimelineClip | null> {
  await prepareBrushMasksForTimelineRender();
  const presentationContextClips = getTimelineClips();
  const selectedClips = getTimelineClipsInPresentationRange(
    selection.anchor,
    (selection.anchor + selection.durationTicks),
  );
  const selectedClipIds = new Set(selectedClips.map((clip) => clip.id));
  const transitions = getTimelineTransitions().filter(
    (transition) =>
      selectedClipIds.has(transition.outgoingClipId) &&
      selectedClipIds.has(transition.incomingClipId),
  );
  const capturedSelection = projectTimelineSelection({
    ...selection,
    start: selection.anchor,
    end: selection.anchor + selection.durationTicks,
    clips: selectedClips,
    transitions,
  }, { tracks: getTimelineTracks(), clips: presentationContextClips, fps: useProjectStore.getState().config.fps });
  const trackId = pickTargetTrackId(capturedSelection);
  if (!trackId) {
    return null;
  }

  // Re-namespace the captured tracks so the composite's content never shares
  // track ids with the parent timeline it was cut from. selectionToCompositeContent
  // clones the parent's tracks verbatim, which would otherwise leave the content
  // colliding with the live timeline and cause cross-talk in any trackId-keyed
  // lookup.
  const content = renamespaceCompositeContentTracks(
    selectionToCompositeContent(capturedSelection),
  );
  const compositeAsset = await useCompositeLibraryStore
    .getState()
    .createCompositeAsset({
      name: options.name,
      content,
      signal: options.signal,
      onProgress: options.onProgress,
    });

  const compositeClip = createCompositeTimelineClipFromAsset(compositeAsset, {
    trackId,
    start: selection.anchor,
  });

  const sourceClipIds = capturedSelection.region.clips.map((clip) => clip.id);
  const didCommit = groupTimelineClipsIntoComposite(
    sourceClipIds,
    compositeClip,
    { start: selection.anchor, end: selection.anchor + selection.durationTicks },
  );

  if (!didCommit) {
    await useCompositeLibraryStore
      .getState()
      .deleteCompositeAsset(compositeAsset.id);
  }

  return didCommit ? compositeClip : null;
}
