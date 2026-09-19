import { getAssets } from "../../features/userAssets/api";
import { getTimelineClips } from "../../features/timeline";
import { isAssetBackedClip } from "../../types/TimelineTypes";

/**
 * Waits until every asset referenced by the timeline is in the asset store.
 *
 * A project's clips are available as soon as the document loads, but its assets
 * hydrate asynchronously afterwards. A probe that snapshots the project in that
 * window renders from an empty asset list: nothing can be prepared for decode,
 * so frames encode blank. Waiting here keeps probes deterministic instead of
 * dependent on load timing.
 */
export async function waitForClipAssets(timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const available = new Set(getAssets().map((asset) => asset.id));
    const referenced = new Set<string>();
    for (const clip of getTimelineClips()) {
      if (isAssetBackedClip(clip) && clip.assetId) {
        referenced.add(clip.assetId);
      }
    }
    const missing = [...referenced].filter(
      (assetId) => !available.has(assetId),
    );

    if (missing.length === 0) {
      return;
    }
    if (performance.now() > deadline) {
      throw new Error(
        `Timed out waiting for timeline assets to hydrate: ${missing.join(", ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
