import { registerPreSaveHook } from "../../../core/persistence/preSaveHooks";
import { registerProjectClosingHook } from "../../../core/project/projectLifecycleHooks";
import { projectPersistenceService } from "../../project";
import type {
  PersistedCompositeSession,
  TimelineSnapshot,
} from "../../project";
import {
  flushPendingTimelinePersistence,
  getTimelineModelRevisionSource,
  getTimelineSnapshot,
} from "../../timeline/api";
import { useCompositeTimelineStore } from "../useCompositeTimelineStore";

/**
 * How long subtimeline edits settle before the open session is written. Short,
 * because the whole point of the document is surviving a close that arrives
 * without warning; the write is small next to a timeline commit either way.
 */
const WRITE_DEBOUNCE_MS = 750;

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingWrite: Promise<void> = Promise.resolve();
/**
 * What the session document is believed to hold, or null when that is unknown
 * (no project open, or one whose document has not been read yet). Unknown is
 * not the same as empty: it means writes must not be skipped as redundant.
 */
let lastWritten: string | null = null;
/**
 * Set while the session is being swapped into or out of the editor wholesale —
 * reopened on load, or left behind on close. The store and timeline updates
 * that causes are not edits, and must not be written back over the document
 * they came from.
 */
let isSwappingSession = false;

function toPersistedSnapshot(snapshot: TimelineSnapshot) {
  return {
    tracks: structuredClone(snapshot.tracks),
    clips: structuredClone(snapshot.clips),
    transitions: structuredClone(snapshot.transitions ?? []),
  };
}

/**
 * The open subtimeline edit as it stands, or null when there is nothing worth
 * keeping.
 */
function readCurrentSession(): PersistedCompositeSession | null {
  const { stack } = useCompositeTimelineStore.getState();
  if (stack.length === 0) return null;

  const current = getTimelineSnapshot();
  const top = stack[stack.length - 1];
  // A new scene that still holds nothing is not an edit: returning to the main
  // timeline discards it too. Any frame underneath means real work is stacked
  // below, so only a lone empty scene is dropped.
  if (
    stack.length === 1 &&
    typeof top.ownerCompositeAssetId !== "string" &&
    current.clips.length === 0
  ) {
    return null;
  }

  return {
    stack: stack.map((frame) => ({
      ...frame,
      previousSnapshot: toPersistedSnapshot(frame.previousSnapshot),
    })),
    current: toPersistedSnapshot(current),
  };
}

function cancelScheduledWrite(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

function writeNow(): Promise<void> {
  cancelScheduledWrite();
  if (isSwappingSession) return pendingWrite;

  // An exit in flight is a half-torn-down stack over a parent timeline that has
  // already been put back: recording it would save an edit whose content is the
  // timeline it was opened from. The exit writes its own outcome when it lands.
  if (useCompositeTimelineStore.getState().isBusy) return pendingWrite;

  const session = readCurrentSession();
  const serialized = JSON.stringify(session);
  if (serialized === lastWritten) return pendingWrite;
  lastWritten = serialized;

  pendingWrite = pendingWrite
    .catch(() => undefined)
    .then(async () => {
      if (session === null) {
        // Clearing recovery says the edit is safely published — but the
        // placement it belongs to was rewritten through the timeline store and
        // is still inside its persist debounce. A fork remaps the placement to
        // a new composite, and nothing relinks it on load, so a crash between
        // the two documents would leave the placement on pre-edit content.
        await flushPendingTimelinePersistence();
      }
      await projectPersistenceService.writeCompositeSession(session);
    })
    .catch((error: unknown) => {
      console.warn("[Composite] Failed to save the open subtimeline", error);
      // Let the next change try again rather than trusting the cache.
      lastWritten = null;
    });

  return pendingWrite;
}

function scheduleWrite(): void {
  if (isSwappingSession) return;
  const { stack, isBusy } = useCompositeTimelineStore.getState();
  if (isBusy) return;
  // Clearing is never debounced: once an edit has committed, a session
  // document left behind would reopen the project inside an edit that is
  // already published.
  if (stack.length === 0) {
    void writeNow();
    return;
  }

  cancelScheduledWrite();
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void writeNow();
  }, WRITE_DEBOUNCE_MS);
}

/**
 * Waits for an exit that is already under way to finish publishing, so a close
 * that lands mid-commit records the outcome instead of a stack being torn down.
 * Bounded, because a commit that never settles must not hold the project open.
 */
function waitForCompositeExit(timeoutMs = 5_000): Promise<void> {
  if (!useCompositeTimelineStore.getState().isBusy) return Promise.resolve();

  return new Promise((resolve) => {
    const settle = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(settle, timeoutMs);
    const unsubscribe = useCompositeTimelineStore.subscribe((state) => {
      if (!state.isBusy) settle();
    });
  });
}

/**
 * Records what the document already holds, so the first write can tell a
 * redundant one from a real change.
 */
async function primeLastWritten(): Promise<void> {
  try {
    const document = await projectPersistenceService.readCompositeSession();
    // A write that landed while this read was in flight knows better.
    if (lastWritten === null) {
      lastWritten = JSON.stringify(document.session);
    }
  } catch (error) {
    console.warn("[Composite] Failed to read the saved subtimeline", error);
  }
}

/**
 * Reopens the subtimeline edit the project was last left inside, if any.
 *
 * Call after the composite library has loaded — the session names the
 * composites its frames belong to — and after the project's own timeline has
 * been applied, which this replaces for the duration of the edit.
 */
export async function restoreCompositeEditSession(): Promise<boolean> {
  cancelScheduledWrite();
  isSwappingSession = true;
  try {
    const document = await projectPersistenceService.readCompositeSession();
    lastWritten = JSON.stringify(document.session);
    if (!document.session) return false;

    const restored = useCompositeTimelineStore
      .getState()
      .restoreSession(document.session);
    if (!restored) {
      // Either the editor is already inside an edit of its own — in which case
      // the document still describes it — or the session cannot be replayed at
      // all. Only the unusable one is cleared.
      if (useCompositeTimelineStore.getState().stack.length === 0) {
        console.warn(
          "[Composite] Discarding a saved subtimeline edit that cannot be reopened",
        );
        lastWritten = JSON.stringify(null);
        pendingWrite = pendingWrite
          .catch(() => undefined)
          .then(() => projectPersistenceService.writeCompositeSession(null))
          .then(() => undefined);
        await pendingWrite;
      }
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Composite] Failed to read the saved subtimeline", error);
    lastWritten = null;
    return false;
  } finally {
    isSwappingSession = false;
  }
}

/**
 * Keeps the open subtimeline edit with the project as it changes.
 *
 * Composite edits are published to the library only when the editor returns to
 * the main timeline, and the timeline's own persistence is suspended for the
 * duration, so without this nothing about an open edit reaches disk: closing
 * the project mid-edit would lose every change made inside the composite. The
 * bake still happens on return to the main timeline and nowhere else — what is
 * saved here is the edit in progress, not a published composite.
 */
export function installCompositeSessionPersistence(): () => void {
  cancelScheduledWrite();
  lastWritten = null;
  // What disk holds decides whether there is anything to clear, so a project
  // that was left on the main timeline is not handed a document saying so the
  // first time a scene is opened.
  void primeLastWritten();

  const timelineModel = getTimelineModelRevisionSource();

  const unsubscribeTimeline = timelineModel.subscribe(() => {
    if (isSwappingSession) return;
    if (useCompositeTimelineStore.getState().stack.length === 0) return;
    scheduleWrite();
  });

  let wasEditing = useCompositeTimelineStore.getState().stack.length > 0;
  let wasBusy = useCompositeTimelineStore.getState().isBusy;
  const unsubscribeComposite = useCompositeTimelineStore.subscribe((state) => {
    const isEditing = state.stack.length > 0;
    // An exit runs as several updates: the stack empties while it is still
    // busy, so the write that clears the document is the one that follows it
    // settling. Both flags are tracked on every update, never only on the ones
    // that write, or the settling edge is missed.
    const settled = wasBusy && !state.isBusy;
    const startedOrStoppedEditing = isEditing !== wasEditing;
    wasEditing = isEditing;
    wasBusy = state.isBusy;
    if (!startedOrStoppedEditing && !settled) return;
    scheduleWrite();
  });

  const unregisterPreSave = registerPreSaveHook(() => writeNow());

  const unregisterClosing = registerProjectClosingHook(async () => {
    await waitForCompositeExit();
    await writeNow();
    // The edit belongs to the project being closed. It stays on disk and the
    // editor leaves it, rather than carrying a stack that points at the
    // outgoing project's timeline into whatever opens next — which would also
    // leave timeline persistence suspended over the new project. Leaving is
    // not committing, so it must not clear what was just saved.
    isSwappingSession = true;
    try {
      useCompositeTimelineStore.getState().abandonSession();
    } finally {
      isSwappingSession = false;
    }
    lastWritten = null;
  });

  const flushBeforeUnload = () => {
    void writeNow();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", flushBeforeUnload);
  }

  return () => {
    cancelScheduledWrite();
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", flushBeforeUnload);
    }
    unregisterClosing();
    unregisterPreSave();
    unsubscribeComposite();
    unsubscribeTimeline();
  };
}
