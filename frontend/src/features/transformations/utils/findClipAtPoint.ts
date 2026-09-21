import type {
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { getTimelineTime, presentationTick } from "../../timeline/time/index";

interface FindClipAtPointInput {
  tracks: readonly TimelineTrack[];
  clips: readonly TimelineClip[];
  fps: number;
  trackId: string;
  tick: number;
}

export function findClipAtPoint({
  tracks,
  clips,
  fps,
  trackId,
  tick,
}: FindClipAtPointInput): TimelineClip | null {
  const time = getTimelineTime({ tracks, clips, fps });
  // "Which clip is drawn here" is the clock's own question: half-open
  // [start, end) against the quantized footprint, masks excluded. Ordered by
  // where the clips are drawn so an overlap resolves to the earlier one, as
  // the previous hand-rolled scan did.
  const matches = time
    .clipsAt(presentationTick(tick), {
      trackIds: [trackId],
      includeMaskChildren: false,
    })
    .sort(
      (left, right) =>
        (time.footprint(left.id)?.start ?? 0) -
        (time.footprint(right.id)?.start ?? 0),
    );

  return matches[0] ?? null;
}
