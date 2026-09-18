import { useEffect, useLayoutEffect } from "react";
import { registerPreSaveHook } from "../../core/persistence/preSaveHooks";
import { revealShellView } from "../../core/shell/shellViewPlacement";
import type { Asset } from "../../types/Asset";
import {
  canRegenerateFromAssetMetadata,
  installGenerationPanelPersistence,
  useGenerationStore,
} from "../../features/generation";
import { installCompositeSessionPersistence } from "../../features/composite";
import { flushAllBrushMaskCommits } from "../../features/masks/api";
import {
  selectIsLocalModelWorkHoldingGpu,
  useModelWorkStore,
} from "../../features/modelWork";
import { useProjectStore } from "../../features/project";
import {
  flushPendingTimelinePersistence,
  replaceTimelineSnapshot,
} from "../../features/timeline/api";
import { registerAssetRegenerator } from "../../features/userAssets";
import type { ProjectTimelineSnapshotRequest } from "../../features/project";
import { GENERATE_VIEW_ID } from "../layout/hostViewIds";

function applyTimelineSnapshotRequest(
  request: ProjectTimelineSnapshotRequest | null,
): void {
  if (!request) {
    return;
  }

  replaceTimelineSnapshot(request.snapshot);
  useProjectStore.getState().acknowledgeTimelineSnapshotRequest(request.id);
}

export function useEditorOrchestration(): void {
  useEffect(
    () =>
      registerAssetRegenerator({
        canRegenerate: (asset: Asset) =>
          canRegenerateFromAssetMetadata(asset.creationMetadata),
        regenerate: (asset: Asset) => {
          // Revealed before the load starts, so the user watches the replay
          // land (or fail) in the panel. It also has to precede the ComfyUI
          // editor opening for in-editor assets: the editor overlay lives
          // inside the Generate view, and a deselected view is display:none.
          revealShellView(GENERATE_VIEW_ID);
          return useGenerationStore
            .getState()
            .loadWorkflowFromAssetMetadata(asset);
        },
      }),
    [],
  );

  // The generation panel's workflow and inputs belong to the project, so they
  // are saved with it and handed back when it reopens.
  useEffect(() => installGenerationPanelPersistence(), []);

  useEffect(() => {
    const unregisterBrushMaskFlush = registerPreSaveHook(
      flushAllBrushMaskCommits,
    );
    const unregisterTimelineFlush = registerPreSaveHook(
      flushPendingTimelinePersistence,
    );

    return () => {
      unregisterTimelineFlush();
      unregisterBrushMaskFlush();
    };
  }, []);

  // A subtimeline edit reaches the composite library only when the editor
  // returns to the main timeline, so an edit still open is saved with the
  // project and resumed when it reopens.
  //
  // Installed after the flush hooks above, and so registered after them:
  // pre-save hooks run in registration order, and painting inside a
  // subtimeline leaves brush pixels that only become an asset id on the clip
  // when `flushAllBrushMaskCommits` materializes them. Capturing the session
  // first would save the edit as it stood before its own masks existed.
  useEffect(() => installCompositeSessionPersistence(), []);

  useEffect(() => {
    // The model-work ledger is operational state, not panel state: the
    // generation queue's admission gate reads it whether or not the Queue panel
    // is open, and a hidden panel must not take the socket down with it.
    const { connect, disconnect } = useModelWorkStore.getState();
    connect();

    // Resume the generation queue the moment vlo's own models hand the GPU
    // back. Owned here rather than inside the generation store so it is
    // disposed with the editor instead of outliving it.
    const unsubscribe = useModelWorkStore.subscribe((state, previous) => {
      if (
        selectIsLocalModelWorkHoldingGpu(previous) &&
        !selectIsLocalModelWorkHoldingGpu(state)
      ) {
        useGenerationStore.getState().resumeGenerationQueueAfterGpuRelease();
      }
    });

    return () => {
      unsubscribe();
      disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    applyTimelineSnapshotRequest(
      useProjectStore.getState().timelineSnapshotRequest,
    );

    return useProjectStore.subscribe((state, previousState) => {
      if (
        state.timelineSnapshotRequest !==
        previousState.timelineSnapshotRequest
      ) {
        applyTimelineSnapshotRequest(state.timelineSnapshotRequest);
      }
    });
  }, []);
}
