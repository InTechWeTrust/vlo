import { vi } from "vitest";
import { generationSessionService } from "../features/generation/services/GenerationSessionService";
import { applyMediaCommitToSnapshot } from "../features/generation/services/generationSessionValidation";
import type {
  GenerationInputSnapshot,
  GenerationSessionAssetCandidate,
  GenerationSessionCommit,
  GenerationSessionPublication,
  GenerationSessionSnapshot,
} from "../features/generation/services/generationSessionTypes";

/**
 * A complete `GenerationSessionPublication` with plausible defaults.
 *
 * The publication grows as the session surface widens, and a fixture that
 * spells out every field has to be edited each time for reasons unrelated to
 * what it tests. Override the fields the test is actually about.
 */
export function createGenerationPublication(
  overrides: Partial<GenerationSessionPublication> = {},
): GenerationSessionPublication {
  return {
    sourceId: "workflow-1",
    instanceId: "instance-1",
    fingerprint: "fingerprint-1",
    mode: "catalogue",
    nodes: [],
    inputs: [],
    editableWidgets: [],
    readiness: { isLoading: false, isReady: true, hasError: false },
    submission: { isBusy: false, queuedCount: 0, canSubmit: true },
    ...overrides,
  };
}

/**
 * Apply one committed transaction the way the mounting panel does.
 *
 * Folds the commit through the session's *own* `applyMediaCommitToSnapshot`
 * rather than a hand-written model of the panel. That is the whole point: the
 * interesting part of a media write is what the host does to the slots it was
 * not asked about. `withMedia({ renumber: true })` rewrites **every** `slotId`
 * in a repeatable batch on each remove and move, because slot ids are
 * positional addresses (`buildRepeatableInputSlotId`), not identities. A model
 * that removes by id and leaves the others alone describes a host that does
 * not exist, and silently hides every bug that depends on renumbering — which
 * is exactly how one shipped (docs/staged-generation-editor-plan.md §2.4).
 */
export function applyGenerationCommit(
  inputs: readonly GenerationInputSnapshot[],
  commit: GenerationSessionCommit,
  assets: ReadonlyMap<string, GenerationSessionAssetCandidate> = new Map(),
): readonly GenerationInputSnapshot[] {
  let snapshot = { inputs } as GenerationSessionSnapshot;
  // Sequential and order-dependent, as the service stages them: each command
  // was validated against the state the one before it produced.
  for (const media of commit.media) {
    const asset =
      media.kind === "attach" ? (assets.get(media.assetId) ?? null) : null;
    snapshot = applyMediaCommitToSnapshot(snapshot, media, asset);
  }
  return snapshot.inputs.map((input) =>
    commit.textInputs.has(input.id)
      ? { ...input, value: commit.textInputs.get(input.id) }
      : input,
  );
}

export interface MountedGenerationSession {
  readonly commit: ReturnType<typeof vi.fn>;
  /** Stub library; add assets to it to let an `attachAsset` resolve. */
  readonly assets: Map<string, GenerationSessionAssetCandidate>;
  publish(overrides?: Partial<GenerationSessionPublication>): void;
  /**
   * The inputs the panel holds after every commit since the last `publish`.
   *
   * The round trip a media test actually cares about: transaction → host
   * commit → panel. Rebased on each `publish`, so a test that republishes is
   * asking about the new baseline rather than replaying history onto it.
   */
  panelInputs(): readonly GenerationInputSnapshot[];
  unmount(): void;
}

/** Mount the session with a spy host and publish one snapshot. */
export function mountGenerationSession(
  overrides: Partial<GenerationSessionPublication> = {},
): MountedGenerationSession {
  const commit = vi.fn<(update: GenerationSessionCommit) => void>();
  const assets = new Map<string, GenerationSessionAssetCandidate>();
  const unmount = generationSessionService.mount({
    commit,
    resolveAsset: (assetId) => assets.get(assetId) ?? null,
  });
  let baseline: readonly GenerationInputSnapshot[] = [];
  let committedBefore = 0;
  const publishOne = (next: Partial<GenerationSessionPublication>) => {
    const publication = createGenerationPublication(next);
    baseline = publication.inputs;
    committedBefore = commit.mock.calls.length;
    generationSessionService.publish(publication);
  };
  publishOne(overrides);
  return {
    commit,
    assets,
    publish: (next: Partial<GenerationSessionPublication> = {}) =>
      publishOne(next),
    panelInputs: () =>
      commit.mock.calls
        .slice(committedBefore)
        .reduce(
          (inputs, [update]) =>
            applyGenerationCommit(
              inputs,
              update as GenerationSessionCommit,
              assets,
            ),
          baseline,
        ),
    unmount,
  };
}
