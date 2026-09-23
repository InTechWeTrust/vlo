import { useMemo, useSyncExternalStore } from "react";
import {
  useTimelineClipMuteOverlay,
  useTimelineMarkersClipOverlay,
  useTimelineReverseStatusOverlay,
} from "../../features/timeline/ui";
import type { TimelineClipOverlayDefinition } from "../../features/timeline";
import { useTimelineKeyframeClipOverlay } from "../../features/transformations";
import { useTimelineAssetRevealClipOverlay } from "../../features/userAssets";
import {
  useTimelineCompositeRevealClipOverlay,
  useTimelineCompositeRenderStatusOverlay,
} from "../../features/composite";
import { extensionClipOverlayRegistry } from "../../features/extensions/timeline/ExtensionClipOverlayRegistry";

let extensionOverlaySnapshot: {
  revision: number;
  overlays: readonly TimelineClipOverlayDefinition[];
} = { revision: -1, overlays: [] };

// useSyncExternalStore needs a referentially stable snapshot, so the adapted
// overlay list is cached per registry revision.
function getExtensionOverlays(): readonly TimelineClipOverlayDefinition[] {
  const revision = extensionClipOverlayRegistry.getRevision();
  if (extensionOverlaySnapshot.revision !== revision) {
    extensionOverlaySnapshot = {
      revision,
      overlays: extensionClipOverlayRegistry
        .list()
        .map((contribution) => contribution.definition.overlay),
    };
  }
  return extensionOverlaySnapshot.overlays;
}

function subscribeExtensionOverlays(listener: () => void): () => void {
  return extensionClipOverlayRegistry.subscribe(listener);
}

export function useEditorClipOverlays(): readonly TimelineClipOverlayDefinition[] {
  const keyframeClipOverlay = useTimelineKeyframeClipOverlay();
  const assetRevealClipOverlay = useTimelineAssetRevealClipOverlay();
  const muteClipOverlay = useTimelineClipMuteOverlay();
  const markersClipOverlay = useTimelineMarkersClipOverlay();
  const reverseStatusClipOverlay = useTimelineReverseStatusOverlay();
  const compositeRenderStatusClipOverlay =
    useTimelineCompositeRenderStatusOverlay();
  const compositeRevealClipOverlay = useTimelineCompositeRevealClipOverlay();

  // Extension-registered overlays share the same hot render path as built-in
  // overlays; re-derive when the owner-scoped registry changes.
  const extensionOverlays = useSyncExternalStore(
    subscribeExtensionOverlays,
    getExtensionOverlays,
    getExtensionOverlays,
  );

  return useMemo(
    () => [
      keyframeClipOverlay,
      assetRevealClipOverlay,
      compositeRevealClipOverlay,
      muteClipOverlay,
      markersClipOverlay,
      reverseStatusClipOverlay,
      compositeRenderStatusClipOverlay,
      ...extensionOverlays,
    ],
    [
      assetRevealClipOverlay,
      compositeRevealClipOverlay,
      compositeRenderStatusClipOverlay,
      keyframeClipOverlay,
      markersClipOverlay,
      muteClipOverlay,
      reverseStatusClipOverlay,
      extensionOverlays,
    ],
  );
}
