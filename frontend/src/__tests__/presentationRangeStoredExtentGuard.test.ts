import { describe, expect, it } from "vitest";

/**
 * Ratchet: presentation-time ranges must not be compared against stored clip
 * extents.
 *
 * Selections, span prompts and the playhead are PRESENTATION ticks — where the
 * timeline draws a clip. `clip.start` / `clip.start + clip.timelineDuration`
 * are STORED ticks. They agree until an adjustment retimes the track: a ripple
 * adjustment shifts every later clip, a static one offsets the source mapping
 * of the clip it covers. Code that clamps or intersects a presentation range
 * with the stored extent silently works on unretimed timelines and lands on
 * the wrong frames under retiming (the timelineSelection / range-mask / SAM
 * span bugs this guard was written for).
 *
 * Use the boundary helpers instead:
 * - `clipPresentationFootprint(ctx, clip)` — where the clip is shown;
 * - `presentationToClipSourceTime` / `clipSourceTimeToPresentation` — map
 *   between the playhead/range and source-owned data (range masks, keyframes);
 * - `createTimelinePlacementMapper` — multi-step work on one snapshot;
 * - `collectTimelineRegionClips` / `getTimelineSelectionClips` — the clips a
 *   detached selection must carry (range clips + the retiming that places
 *   them).
 *
 * Scope: production files that handle presentation-time ranges (they mention a
 * selection, span selection, the playback clock or a presentation tick). In
 * those, each stored-extent read (`x.start + x.timelineDuration`) or stored
 * tick derived from source time (`x.start + clipSourceTimeToVisual(...)`) is
 * counted against a per-file budget. A new file, or a higher count, fails.
 * Lower a budget when you migrate a site; never raise one without a reason
 * recorded next to it.
 *
 * This guard matches expressions, so it cannot see an omission — a selection
 * built without the adjustments that place its clips. That is covered by
 * `selectionBuilderRegistryGuard` (every selection builder is registered) and
 * the selection builder contract test (every capture builder is checked
 * against retiming scenarios).
 */

const RAW_FILES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PRESENTATION_RANGE_VOCABULARY =
  /\bTimelineSelection\b|\bselectionStartTick\b|\bSpanSelection\b|\bplaybackClock\.time\b|\bpresentationTick\b/;

const STORED_EXTENT =
  /\b[A-Za-z_]+\.start\s*\+\s*(?:[A-Za-z_]+\.timelineDuration\b|(?:mapSourceTimeToVisualTime|clipSourceTimeToVisual)\s*\()/g;

const BUDGET: Record<string, number> = {
  // Boundary modules: they own the stored <-> presentation conversion, and a
  // stored extent is their input or their no-presentation fallback.
  "features/timeline/utils/timelinePlacementMapper.ts": 3,
  "features/timeline/utils/clipPresentation.ts": 1,
  "features/transformations/utils/clipTimeDomains.ts": 1,
  "features/renderer/utils/deriveAdjustmentGroups.ts": 1,
  "types/TimelineTypes.ts": 1,
  // Stored-domain code: works on effective/stored ticks after presentation has
  // already been resolved (renderer), or cuts at a stored tick (split).
  "features/renderer/utils/clipLookup.ts": 1,
  "features/renderer/services/CompositeAudioResolver.ts": 1,
  "features/renderer/services/TrackAudioRenderer.ts": 1,
  "features/renderer/services/TrackRenderEngine.ts": 2,
  "features/timeline/useTimelineStore.ts": 1,
  "features/timeline/model/playheadPlacement.ts": 1,
  // Fallback for a clip missing from the mapper snapshot (unreachable in
  // practice; the mapper is built from the same clips).
  "features/generation/utils/miniEditorEdit.ts": 2,
  "features/timelineSelection/utils/createTimelineSelection.ts": 1,
  // Detached, self-consistent snapshots: the selection holds only these clips,
  // so stored and presentation ticks coincide inside it.
  "features/timeline/utils/clipAudioExtraction.ts": 1,
  "features/renderer/utils/buildSelectionProjectData.ts": 1,
  // Legacy repair heuristic for saved selections that lost their clip list.
  "features/timelineSelection/utils/timelineSelection.ts": 1,
  // KNOWN DEBT — keyframe authoring clamps the playhead (presentation) to the
  // stored extent before mapping to source time, so under a ripple retime
  // keyframes land at the wrong source time. Migrate to
  // `clipPresentationFootprint` and lower these to 0.
  "features/player/hooks/interaction/useTransformInteractionController.ts": 5,
  "features/transformations/hooks/useTransformationController.ts": 2,
  "features/transformations/hooks/useGroupKeyframeManager.ts": 1,
};

function normalize(globKey: string): string {
  return globKey.replace(/^\.\.\//, "");
}

function isProductionSource(path: string): boolean {
  return !path.includes("__tests__") && !path.includes(".test.");
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

describe("presentation range stored-extent guard", () => {
  it("keeps stored-extent reads in presentation-range code within budget", () => {
    const overBudget: string[] = [];
    const counts = new Map<string, number>();

    for (const [globKey, source] of Object.entries(RAW_FILES)) {
      const path = normalize(globKey);
      if (!isProductionSource(path)) continue;
      const stripped = stripCommentsAndStrings(source);
      if (!PRESENTATION_RANGE_VOCABULARY.test(stripped)) continue;
      const count = stripped.match(STORED_EXTENT)?.length ?? 0;
      if (count === 0) continue;
      counts.set(path, count);
      const budget = BUDGET[path] ?? 0;
      if (count > budget) {
        overBudget.push(`${path}: ${count} stored-extent reads (budget ${budget})`);
      }
    }

    expect(
      overBudget,
      "Compare presentation ranges against clipPresentationFootprint / the placement mapper, not clip.start + clip.timelineDuration",
    ).toEqual([]);

    // Ratchet down: a budget above the real count must be lowered so the
    // headroom cannot be spent by new code.
    const stale = Object.entries(BUDGET)
      .filter(([path, budget]) => (counts.get(path) ?? 0) < budget)
      .map(([path, budget]) => `${path}: budget ${budget}, now ${counts.get(path) ?? 0}`);
    expect(stale, "Lower these budgets to the current count").toEqual([]);
  });

  it("builds detached selections from the region topology, not the range query", () => {
    // `getTimelineClipsInPresentationRange` returns exactly the clips inside a
    // range. A selection rendered detached also needs the retiming
    // adjustments that place them — `getTimelineSelectionClips`. Only callers
    // that act on the in-range clips themselves (and pass the full timeline as
    // presentation context separately) may use the range query.
    const allowed = new Set([
      "features/composite/services/groupSelectionIntoComposite.ts",
    ]);
    const offenders = Object.entries(RAW_FILES)
      .map(([globKey, source]) => [normalize(globKey), source] as const)
      .filter(
        ([path, source]) =>
          isProductionSource(path) &&
          !path.startsWith("features/timeline/") &&
          !allowed.has(path) &&
          /\bgetTimelineClipsInPresentationRange\s*\(/.test(
            stripCommentsAndStrings(source),
          ),
      )
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});
