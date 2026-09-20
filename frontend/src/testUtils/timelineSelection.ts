import { inferSelectionTracks } from "../features/timeline/time";
import type { LegacyTimelineSelection, TimelineSelection } from "../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../core/time/constants";
import { projectTimelineSelection } from "../features/timeline/time";

/** Abstract-tick fixtures use a one-tick frame grid unless a test supplies its own. */
export function makeTimelineSelection(selection: LegacyTimelineSelection, fps = TICKS_PER_SECOND): TimelineSelection {
  return projectTimelineSelection(selection, {
    clips: selection.clips, tracks: inferSelectionTracks(selection), fps,
  });
}
