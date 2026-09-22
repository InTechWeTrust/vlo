import { create } from "zustand";
import type { CompositeContent } from "../../types/TimelineTypes";
import { isCompositeClip } from "../../types/TimelineTypes";
import type {
  PersistedCompositeSession,
  TimelineSnapshot,
} from "../project/types/ProjectDocument";
import { playbackClock } from "../../core/playback/PlaybackClock";
import { projectMutationGuard } from "../../core/project/projectMutationGuard";
import {
  createEmptyTimelineSnapshot,
  getTimelineClipById,
  getTimelineCompositeContent,
  getTimelineCompositePlacementIds,
  getTimelineSnapshot,
  remapTimelineCompositePlacement,
  replaceTimelineSnapshot,
  setTimelinePersistenceSuspended,
} from "../timeline/api";
import { useCompositeLibraryStore } from "./useCompositeLibraryStore";
import { resolveCompositeRevision } from "./utils/compositeBakeValidity";

interface CompositeTimelineFrame {
  previousSnapshot: TimelineSnapshot;
  ownerCompositeAssetId?: string | null;
  name: string;
  ownerClipId?: string | null;
  insertStartTick?: number;
  initialContentSnapshot?: string;
}

interface CompositeTimelineState {
  stack: CompositeTimelineFrame[];
  isBusy: boolean;
  lastError: string | null;
  startBlankCompositeAsset: () => boolean;
  startBlankSubtimeline: () => boolean;
  openCompositeAsset: (compositeAssetId: string) => boolean;
  openCompositeClip: (clipId: string) => boolean;
  exitToMainTimeline: () => Promise<boolean>;
  restoreSession: (session: PersistedCompositeSession) => boolean;
  abandonSession: () => void;
  clearLastError: () => void;
}

function cloneTimelineSnapshot(snapshot: TimelineSnapshot): TimelineSnapshot {
  return {
    tracks: structuredClone(snapshot.tracks),
    clips: structuredClone(snapshot.clips),
    transitions: structuredClone(snapshot.transitions ?? []),
  };
}

function getCurrentTimelineSnapshot(): TimelineSnapshot {
  return getTimelineSnapshot();
}

function getSnapshotForCompositeContent(content: CompositeContent): TimelineSnapshot {
  return {
    tracks:
      content.tracks && content.tracks.length > 0
        ? structuredClone(content.tracks)
        : createEmptyTimelineSnapshot().tracks,
    clips: structuredClone(content.clips),
    transitions: structuredClone(content.transitions ?? []),
  };
}

function getCurrentCompositeContent(): CompositeContent {
  return getTimelineCompositeContent();
}

function isEmptyNewSceneContent(content: CompositeContent): boolean {
  return content.clips.length === 0;
}

function serializeCompositeContent(content: CompositeContent): string {
  return JSON.stringify(content);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Composite timeline update failed.";
}

export const useCompositeTimelineStore = create<CompositeTimelineState>(
  (set, get) => ({
    stack: [],
    isBusy: false,
    lastError: null,

    startBlankCompositeAsset: () => {
      const state = get();
      if (state.isBusy) return false;

      // Blank composites are browser-only: they create a top-level asset and
      // never place a clip. Starting one while already inside a subtimeline
      // edit would push a frame whose content `exitToMainTimeline` saves as a
      // fresh asset the parent composite never references — orphaning it. The
      // UI hides this entry point during subtimeline editing
      // (CompositePanel gates on stack depth), but guard here too so the store
      // stays self-consistent regardless of caller.
      if (state.stack.length > 0) return false;

      const previousSnapshot = getCurrentTimelineSnapshot();
      setTimelinePersistenceSuspended(true);
      replaceTimelineSnapshot(createEmptyTimelineSnapshot());
      playbackClock.setTime(0);

      set({
        stack: [
          ...state.stack,
          {
            previousSnapshot,
            ownerCompositeAssetId: null,
            name: "Scene",
          },
        ],
        lastError: null,
      });
      return true;
    },

    startBlankSubtimeline: () => get().startBlankCompositeAsset(),

    openCompositeAsset: (compositeAssetId) => {
      const state = get();
      if (state.isBusy) return false;

      const timelineSnapshot = getCurrentTimelineSnapshot();
      const compositeAsset = useCompositeLibraryStore
        .getState()
        .composites.find(
          (candidate) => candidate.id === compositeAssetId,
        );
      if (!compositeAsset) {
        return false;
      }

      setTimelinePersistenceSuspended(true);
      replaceTimelineSnapshot(getSnapshotForCompositeContent(compositeAsset.content));
      playbackClock.setTime(0);
      const initialContentSnapshot = serializeCompositeContent(
        getCurrentCompositeContent(),
      );

      set({
        stack: [
          ...state.stack,
          {
            previousSnapshot: timelineSnapshot,
            ownerCompositeAssetId: compositeAsset.id,
            name: compositeAsset.name,
            initialContentSnapshot,
          },
        ],
        lastError: null,
      });
      return true;
    },

    openCompositeClip: (clipId) => {
      const clip = getTimelineClipById(clipId);
      if (!isCompositeClip(clip)) {
        return false;
      }
      if (!get().openCompositeAsset(clip.compositeId)) return false;
      const stack = [...get().stack];
      const frame = stack[stack.length - 1];
      stack[stack.length - 1] = { ...frame, ownerClipId: clip.id };
      set({ stack });
      return true;
    },

    exitToMainTimeline: async () => {
      const state = get();
      if (state.isBusy || state.stack.length === 0) return false;

      // Publishing awaits the composite library between the commits that
      // remap its placement. Counted as one change for the whole run, so an
      // export waits for it instead of freezing the project between steps.
      let releaseMutation: () => void;
      try {
        releaseMutation = projectMutationGuard.beginMutation();
      } catch (error) {
        set({ lastError: getErrorMessage(error) });
        return false;
      }

      set({ isBusy: true, lastError: null });

      // The content of the frame currently being committed. A commit that
      // fails leaves its frame on the stack, so the editor has to be put back
      // inside it rather than left showing the parent restored on the way to a
      // publication that never landed.
      let editedSnapshot: TimelineSnapshot | null = null;

      try {
        let stack = [...get().stack];
        let contentToSave = getCurrentCompositeContent();

        while (stack.length > 0) {
          const frame = stack[stack.length - 1];
          stack = stack.slice(0, -1);
          editedSnapshot = getCurrentTimelineSnapshot();

          const shouldCommitFrame =
            (typeof frame.ownerCompositeAssetId === "string" &&
              serializeCompositeContent(contentToSave) !==
                frame.initialContentSnapshot) ||
            (typeof frame.ownerCompositeAssetId !== "string" &&
              !isEmptyNewSceneContent(contentToSave));

          // Restore the parent timeline BEFORE committing. The canonical edit
          // immediately advances every parent placement's revision, while the
          // background bake may relink its cache later. Both mutations must run
          // against the parent timeline, not the subtimeline just captured.
          replaceTimelineSnapshot(cloneTimelineSnapshot(frame.previousSnapshot));

          const returningToMainTimeline = stack.length === 0;
          if (returningToMainTimeline) {
            setTimelinePersistenceSuspended(false);
          }

          if (shouldCommitFrame) {
            if (typeof frame.ownerCompositeAssetId === "string") {
              const placementIds = getTimelineCompositePlacementIds([
                frame.ownerCompositeAssetId,
              ]);
              const shouldForkPlacement =
                typeof frame.ownerClipId === "string" &&
                placementIds.length > 1;

              if (shouldForkPlacement) {
                const fork = await useCompositeLibraryStore
                  .getState()
                  .createCompositeAsset({
                    name: frame.name,
                    content: contentToSave,
                  });
                const didRemap = remapTimelineCompositePlacement(
                  frame.ownerClipId!,
                  frame.ownerCompositeAssetId,
                  fork.id,
                  resolveCompositeRevision(fork),
                );
                if (!didRemap) {
                  await useCompositeLibraryStore
                    .getState()
                    .deleteCompositeAsset(fork.id);
                  throw new Error(
                    "The edited composite placement no longer exists.",
                  );
                }
              } else {
                await useCompositeLibraryStore
                  .getState()
                  .updateCompositeAssetContent(frame.ownerCompositeAssetId, {
                    content: contentToSave,
                  });
              }
            } else {
              await useCompositeLibraryStore.getState().createCompositeAsset({
                name: frame.name,
                content: contentToSave,
              });
            }
          }

          set({ stack });

          if (stack.length > 0) {
            contentToSave = getCurrentCompositeContent();
          }
        }

        set({ isBusy: false, lastError: null });
        return true;
      } catch (error) {
        const message = getErrorMessage(error);
        const isStillEditing = get().stack.length > 0;
        // Suspend before restoring: the failed frame may have queued parent
        // timeline patches (a fork remaps its placement before the step that
        // threw), and those describe the parent that is still in the store.
        setTimelinePersistenceSuspended(isStillEditing);
        if (isStillEditing && editedSnapshot) {
          // Without this the store would claim an open subtimeline while
          // holding that subtimeline's own parent — a state the recovery
          // document would then record as the edit itself.
          replaceTimelineSnapshot(editedSnapshot);
        }
        set({ isBusy: false, lastError: message });
        console.error("Failed to save composite subtimeline", error);
        return false;
      } finally {
        releaseMutation();
      }
    },

    /**
     * Puts the editor back inside a subtimeline edit that a previous session
     * left open (see the composite edit session document). Composite content
     * only reaches the library when the editor returns to the main timeline,
     * so a project closed mid-edit is reopened where it was left rather than
     * losing the edit.
     *
     * Declines when an edit is already open: the editor can remount inside one
     * project, and what the store already holds is the live edit.
     */
    restoreSession: (session) => {
      const state = get();
      if (state.isBusy || state.stack.length > 0) return false;
      if (session.stack.length === 0) return false;

      // A frame whose composite is gone can never be committed, and the frames
      // below it are only reachable through it, so the session as a whole is
      // unusable rather than partly recoverable.
      const composites = useCompositeLibraryStore.getState().composites;
      const everyOwnerExists = session.stack.every(
        (frame) =>
          typeof frame.ownerCompositeAssetId !== "string" ||
          composites.some(
            (candidate) => candidate.id === frame.ownerCompositeAssetId,
          ),
      );
      if (!everyOwnerExists) return false;

      setTimelinePersistenceSuspended(true);
      replaceTimelineSnapshot(cloneTimelineSnapshot(session.current));
      playbackClock.setTime(0);

      set({
        stack: session.stack.map((frame) => ({
          ...frame,
          previousSnapshot: cloneTimelineSnapshot(frame.previousSnapshot),
        })),
        lastError: null,
      });
      return true;
    },

    /**
     * Drops an open edit without committing it, restoring the main timeline the
     * editor entered from. For closing a project: the edit itself survives in
     * the session document, so it is resumed the next time the project opens
     * rather than published against a library that is going away.
     */
    abandonSession: () => {
      const { stack } = get();
      if (stack.length === 0) return;

      replaceTimelineSnapshot(cloneTimelineSnapshot(stack[0].previousSnapshot));
      setTimelinePersistenceSuspended(false);
      set({ stack: [], isBusy: false, lastError: null });
    },

    clearLastError: () => set({ lastError: null }),
  }),
);
