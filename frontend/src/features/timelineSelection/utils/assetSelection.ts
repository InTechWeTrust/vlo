import type { Asset } from "../../../types/Asset";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import { normalizeDetachedTimelineSelection } from "./timelineSelection";

/**
 * Resolves a TimelineSelection from an asset's creation metadata.
 * Returns the first timelineSelection found in the asset's inputs,
 * or from extracted metadata.
 *
 * Selections are stripped from the asset index, so this answers `null` for an
 * asset whose metadata sidecar has not been hydrated. Callers that only need
 * the selection's placement should use
 * {@link getTimelineSelectionStartFromAsset}, which survives the strip.
 */
export function getTimelineSelectionFromAsset(
  asset: Asset,
): TimelineSelection | null {
  const meta = asset.creationMetadata;
  if (!meta) return null;

  if (meta.source === "extracted" && meta.timelineSelection) {
    return normalizeDetachedTimelineSelection(meta.timelineSelection);
  }

  if (meta.source === "generated") {
    for (const input of meta.inputs) {
      if (input.kind === "timelineSelection" && input.timelineSelection) {
        return normalizeDetachedTimelineSelection(input.timelineSelection);
      }
    }
  }

  return null;
}

/**
 * The start tick of the asset's first timeline selection, or `null` when it has
 * none. Unlike {@link getTimelineSelectionFromAsset} this reads the abridged
 * index copy too, so "Send to Timeline" stays offered — and lands in the right
 * place — without paying to hydrate every asset the browser renders.
 */
export function getTimelineSelectionStartFromAsset(
  asset: Asset,
): number | null {
  const meta = asset.creationMetadata;
  if (!meta) return null;

  if (meta.source === "extracted") {
    return meta.timelineSelection?.start ?? meta.timelineSelectionStart ?? null;
  }

  if (meta.source === "generated") {
    for (const input of meta.inputs) {
      if (input.kind !== "timelineSelection") continue;
      const start = input.timelineSelection?.start ?? input.timelineSelectionStart;
      if (start !== undefined) return start;
    }
  }

  return null;
}
