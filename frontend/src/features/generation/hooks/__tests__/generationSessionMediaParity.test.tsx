import { createGenerationInputsDraft } from "../../draft/generationInputsDraftController";
import { createPointTimelineSelection, createTimelineSelection } from "../../../timelineSelection";
import type { GenerationCapturedMedia } from "../../utils/capturedMedia";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionGenerationApi } from "../../../extensions/generation/ExtensionGenerationBridge";
import type { ExtensionApiScope, ExtensionResource } from "../../../extensions";
import { resetGenerationSessionProjectionCache } from "../../../extensions/generation/generationSessionProjection";
import { useGenerationStore } from "../../useGenerationStore";
import { useAssetStore } from "../../../userAssets";
import { useMediaInputPreparationStore } from "../../store/useMediaInputPreparationStore";
import { buildRepeatableInputSlotId } from "../../utils/workflowInputs";
import { resetZustandStore } from "../../../../testUtils/zustand";
import type { Asset } from "../../../../types/Asset";
import type { WorkflowInput } from "../../types";
import { canAttachAssetToMediaInput } from "../../utils/mediaInputAssets";
import { useGenerationSessionMount } from "../useGenerationSessionMount";

/**
 * The 1B pairing gate
 * (docs/minimax-prompt-composer-extension-plan.md §4).
 *
 * A native drop and an SDK `attachAsset` must leave the store in the same
 * state and refuse the same things, because they are the same seam: the panel
 * hands its own media handlers to the session mount, and the adapter reaches
 * those handlers through the transaction rather than around them.
 */

const REFERENCE_ID = "10:images";
const AUDIO_ID = "11:audio";

const REFERENCE_INPUT: WorkflowInput = {
  id: REFERENCE_ID,
  nodeId: "10",
  classType: "VloBatchMemoryLoader",
  inputType: "video",
  param: "images",
  label: "Reference videos",
  currentValue: null,
  origin: "rule",
  presentation: { repeatable: { max: 4, itemOptions: ["audio"] } },
};

const AUDIO_INPUT: WorkflowInput = {
  id: AUDIO_ID,
  nodeId: "11",
  classType: "VloBatchMemoryLoader",
  inputType: "audio",
  param: "audio",
  label: "Reference audio",
  currentValue: null,
  origin: "rule",
  presentation: { repeatable: { max: 4 } },
};

/** A single-slot input: it replaces rather than fills, and cannot reorder. */
const SINGLE_ID = "12:image";
const SINGLE_INPUT: WorkflowInput = {
  id: SINGLE_ID,
  nodeId: "12",
  classType: "LoadImage",
  inputType: "image",
  param: "image",
  label: "Start frame",
  currentValue: null,
  origin: "rule",
};

const workflowInputs: WorkflowInput[] = [
  REFERENCE_INPUT,
  AUDIO_INPUT,
  SINGLE_INPUT,
];

function asset(overrides: Partial<Asset> & Pick<Asset, "id">): Asset {
  return {
    name: `${overrides.id}.mp4`,
    type: "video",
    src: `blob:${overrides.id}`,
    ...overrides,
  } as Asset;
}

const LOUD_VIDEO = asset({ id: "vid-loud", hasAudio: true });
const SILENT_VIDEO = asset({ id: "vid-silent", hasAudio: false });
const SECOND_VIDEO = asset({ id: "vid-second", hasAudio: true });

const LIBRARY = new Map<string, Asset>(
  [LOUD_VIDEO, SILENT_VIDEO, SECOND_VIDEO].map((entry) => [entry.id, entry]),
);

function createScope(): ExtensionApiScope {
  return {
    extension: { id: "example.composer", version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: () => undefined,
  };
}

/**
 * Mount the session the way `GenerationPanel` does: the media handlers it
 * passes are the store actions its own drop, reorder, clear, and switch
 * controls call, so anything reaching them has taken the native path.
 */
function mountPanel() {
  const rendered = renderHook(() =>
    useGenerationSessionMount({
      workflowInputs,
      textValues: {},
      widgetInputs: [],
      widgetValues: {},
      selectedWorkflowId: "wf.json",
      hasWorkflowError: false,
      canSubmit: true,
      commitTextInputs: vi.fn(),
      applyWidgetValue: vi.fn(),
      attachAssetToSlot: (slotId, assetId) => {
        const resolved = LIBRARY.get(assetId);
        if (resolved) {
          useGenerationStore.getState().setMediaInputAsset(slotId, resolved);
        }
      },
      moveMediaItem: (slotId, toOrdinal) =>
        useGenerationStore.getState().moveMediaInput(slotId, toOrdinal),
      removeMediaItem: (slotId) =>
        useGenerationStore.getState().clearMediaInput(slotId),
      setMediaItemId: (slotId, itemId) =>
        useGenerationStore.getState().setMediaInputItemId(slotId, itemId),
      setMediaItemOption: (slotId, optionId, value) =>
        useGenerationStore
          .getState()
          .setMediaInputItemOption(slotId, optionId, value),
      resolveAsset: (assetId) => LIBRARY.get(assetId) ?? null,
    }),
  );
  return rendered;
}

/**
 * Where a native drop would land, by the batch strip's own rule: the first
 * slot that holds nothing and is not being prepared.
 */
function slotIdForNativeDrop(from: number): string {
  const mediaInputs = useGenerationStore.getState().mediaInputs;
  const preparing =
    useMediaInputPreparationStore.getState().preparingInputIds;
  for (let index = from; index < 4; index += 1) {
    const slotId = buildRepeatableInputSlotId(REFERENCE_INPUT, index);
    if (!mediaInputs[slotId] && !preparing.has(slotId)) return slotId;
  }
  return buildRepeatableInputSlotId(REFERENCE_INPUT, 3);
}

function readMediaInputs() {
  return useGenerationStore.getState().mediaInputs;
}

/**
 * The store state with occurrence ids set aside. Each attach mints its own id,
 * so two separate attaches of the same asset are *meant* to differ there; the
 * parity being asserted is everything else about the value.
 */
function withoutItemIds(
  mediaInputs: ReturnType<typeof readMediaInputs>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(mediaInputs).map(([key, value]) => {
      if (!value) return [key, value];
      const { itemId: _itemId, ...rest } = value;
      return [key, rest];
    }),
  );
}

/**
 * The reference list as an extension sees it — through the published
 * projection, not the host snapshot, so the read path is under test too.
 */
function readReferences(api: ReturnType<typeof createExtensionGenerationApi>) {
  const input = api
    .getSession()
    ?.inputs.find((entry) => entry.id === REFERENCE_ID);
  return input?.media ?? [];
}

function readAttachedIds(
  api: ReturnType<typeof createExtensionGenerationApi>,
): string[] {
  return readReferences(api).map((item) => item.assetId ?? "?");
}

describe("generation media writes: native drop vs SDK attach", () => {
  beforeEach(() => {
    resetZustandStore(useGenerationStore);
    resetZustandStore(useMediaInputPreparationStore);
    resetGenerationSessionProjectionCache();
    useGenerationStore.setState({ workflowInputs, mediaInputs: {} });
  });

  afterEach(() => {
    resetZustandStore(useGenerationStore);
    resetZustandStore(useMediaInputPreparationStore);
    resetGenerationSessionProjectionCache();
  });

  it.each(["image", "video", "audio"] as const)("commits a draft %s capture as the same native value, without a library asset", (type) => {
    let urlCount = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:capture-${++urlCount}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const ingest = vi.spyOn(useAssetStore.getState(), "addLocalAsset");
    const libraryBefore = useAssetStore.getState().assets;
    const inputId = type === "image" ? SINGLE_ID : type === "video" ? REFERENCE_ID : AUDIO_ID;
    const selection = type === "image" ? createPointTimelineSelection(42) : createTimelineSelection(42, 142);
    const file = new File(["captured media"], `capture.${type === "image" ? "png" : type === "video" ? "mp4" : "wav"}`);
    const thumbnail = new File(["thumbnail"], "thumbnail.png");
    const mask = new File(["mask"], "mask.mp4");
    const capture: GenerationCapturedMedia = type === "image"
      ? { kind: "frame", file, timelineSelection: selection }
      : {
        kind: "timelineSelection", timelineSelection: selection, thumbnailFile: thumbnail,
        options: {
          mediaType: type, extractionRequestId: 17, isExtracting: false,
          ...(type === "video" ? { preparedVideoFile: file, preparedMaskFile: mask, preparedDerivedMaskSignature: "mask-signature" } : { preparedAudioFile: file })
        }
      };
    const panel = mountPanel();
    // The native setters are the reference, including their option defaults.
    act(() => {
      const store = useGenerationStore.getState();
      if (capture.kind === "frame") store.setMediaInputFrameWithSelection(inputId, file, selection);
      else store.setMediaInputTimelineSelection(inputId, selection, thumbnail, capture.options);
    });
    const nativeValue = readMediaInputs()[inputId]!;
    act(() => useGenerationStore.getState().clearMediaInput(inputId));
    const draft = createGenerationInputsDraft({ inputIds: [inputId] });
    act(() => draft.stageCapture(inputId, 0, capture));
    const staged = draft.getSnapshot().inputs[0].media![0];
    expect(staged.assetId).toBeUndefined();
    expect(readMediaInputs()[inputId]).toBeUndefined();
    if (type !== "audio") expect(staged.thumbnail).toBeTruthy();
    expect(ingest).not.toHaveBeenCalled();

    // Another invalid write must not partially commit the capture.
    act(() => {
      expect(draft.commit("Invalid prompt", (transaction) => transaction.setTextInput("missing", "prompt")).ok).toBe(false);
    });
    expect(readMediaInputs()[inputId]).toBeUndefined();
    expect(draft.getSnapshot().hasDraftChanges).toBe(true);
    if (staged.thumbnail) expect(revoke).not.toHaveBeenCalledWith(staged.thumbnail);

    act(() => { expect(draft.commit("Captured reference").ok).toBe(true); });
    const committed = readMediaInputs()[inputId]!;
    // Each holder owns its URL and occurrence identity; everything else is identical.
    const { itemId: _nativeId, ...nativeFields } = nativeValue;
    const { itemId: _committedId, ...committedFields } = committed;
    if ("previewUrl" in nativeFields && "previewUrl" in committedFields) {
      expect(committedFields.previewUrl).not.toBe(staged.thumbnail);
      nativeFields.previewUrl = committedFields.previewUrl;
    }
    if ("thumbnailUrl" in nativeFields && "thumbnailUrl" in committedFields) {
      nativeFields.thumbnailUrl = committedFields.thumbnailUrl;
    }
    expect(committedFields).toEqual(nativeFields);
    expect(committed.itemId).toBe(staged.itemId);
    if (staged.thumbnail) expect(revoke).toHaveBeenCalledWith(staged.thumbnail);
    expect(useAssetStore.getState().assets).toBe(libraryBefore);
    expect(ingest).not.toHaveBeenCalled();
    draft.dispose();
    expect(readMediaInputs()[inputId]).toBe(committed);
    panel.unmount();
    vi.restoreAllMocks();
  });

  it("releases discarded capture previews and commits only the final reordered captures", () => {
    let urlCount = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:capture-${++urlCount}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const panel = mountPanel();
    const draft = createGenerationInputsDraft({ inputIds: [REFERENCE_ID] });
    const makeCapture = (name: string): GenerationCapturedMedia => ({
      kind: "timelineSelection", timelineSelection: createTimelineSelection(0, 100),
      thumbnailFile: new File([name], `${name}.png`),
      options: { mediaType: "video", preparedVideoFile: new File([name], `${name}.mp4`) },
    });
    act(() => draft.stageCapture(REFERENCE_ID, 0, makeCapture("discarded")));
    const discardedUrl = draft.getSnapshot().inputs[0].media![0].thumbnail;
    act(() => draft.revert());
    expect(revoke).toHaveBeenCalledWith(discardedUrl);
    expect(readMediaInputs()).toEqual({});
    act(() => {
      draft.stageCapture(REFERENCE_ID, 0, makeCapture("first"));
      draft.stageCapture(REFERENCE_ID, 1, makeCapture("second"));
      draft.stageCapture(REFERENCE_ID, 0, makeCapture("replacement"));
      draft.stage({ kind: "moveMedia", inputId: REFERENCE_ID, fromOrdinal: 1, toOrdinal: 0 });
    });
    const staged = draft.getSnapshot().inputs[0].media!;
    act(() => { expect(draft.commit("Reorder captures").ok).toBe(true); });
    const values = Object.values(readMediaInputs());
    expect(values.map((value) => value?.itemId)).toEqual(staged.map((item) => item.itemId));
    expect(values.map((value) => value?.kind === "timelineSelection" && value.mediaType === "video" ? value.preparedVideoFile?.name : null)).toEqual(["second.mp4", "replacement.mp4"]);
    act(() => draft.stageCapture(REFERENCE_ID, 2, makeCapture("disposed")));
    const disposedUrl = draft.getSnapshot().inputs[0].media![2].thumbnail;
    draft.dispose();
    expect(revoke).toHaveBeenCalledWith(disposedUrl);
    panel.unmount();
    vi.restoreAllMocks();
  });

  it("leaves the same store state as the drop it stands in for", () => {
    const native = mountPanel();
    act(() => {
      useGenerationStore
        .getState()
        .setMediaInputAsset(REFERENCE_ID, LOUD_VIDEO);
    });
    const afterDrop = readMediaInputs();
    native.unmount();

    resetZustandStore(useGenerationStore);
    useGenerationStore.setState({ workflowInputs, mediaInputs: {} });
    const viaSdk = mountPanel();
    const api = createExtensionGenerationApi(createScope());
    let result;
    act(() => {
      result = api.transaction("Attach reference", (transaction) => {
        transaction.attachAsset(REFERENCE_ID, LOUD_VIDEO.id);
      });
    });
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(withoutItemIds(readMediaInputs())).toEqual(withoutItemIds(afterDrop));
    // Both paths name the occurrence, and the SDK sees the id the store holds.
    expect(afterDrop[REFERENCE_ID]?.itemId).toMatch(/^media-/);
    expect(readReferences(api)[0]?.itemId).toBe(
      readMediaInputs()[REFERENCE_ID]?.itemId,
    );
    viaSdk.unmount();
  });

  it("refuses a silent video on an audio slot, as a drag would", () => {
    const rendered = mountPanel();
    const api = createExtensionGenerationApi(createScope());

    let rejected;
    act(() => {
      rejected = api.transaction("Attach silent", (transaction) => {
        transaction.attachAsset(AUDIO_ID, SILENT_VIDEO.id);
      });
    });
    expect(rejected).toMatchObject({ ok: false, code: "asset_type_rejected" });
    expect(readMediaInputs()).toEqual({});
    // The same predicate the drop target is built from says the same thing.
    expect(canAttachAssetToMediaInput("audio", SILENT_VIDEO)).toBe(false);
    expect(canAttachAssetToMediaInput("audio", LOUD_VIDEO)).toBe(true);

    // It is still a legitimate *video* reference, and the projection says
    // plainly that it carries no soundtrack — the off-by-one trap the tag
    // catalogue warns about.
    act(() => {
      api.transaction("Attach silent as video", (transaction) => {
        transaction.attachAsset(REFERENCE_ID, SILENT_VIDEO.id);
      });
    });
    expect(readReferences(api)[0]).toMatchObject({
      assetId: SILENT_VIDEO.id,
      hasAudio: false,
      // No switch is offered at all, because it could deliver nothing.
      options: {},
    });
    rendered.unmount();
  });

  it("stages several media changes against the state the last one left", () => {
    const rendered = mountPanel();
    const api = createExtensionGenerationApi(createScope());

    let result;
    act(() => {
      result = api.transaction("Attach a subject", (transaction) => {
        transaction.attachAsset(REFERENCE_ID, LOUD_VIDEO.id);
        // Judged against the batch the first attach filled, so it takes the
        // next slot rather than planning the same one twice.
        transaction.attachAsset(REFERENCE_ID, SECOND_VIDEO.id);
      });
    });
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(readAttachedIds(api)).toEqual([LOUD_VIDEO.id, SECOND_VIDEO.id]);

    act(() => {
      api.transaction("Reorder", (transaction) => {
        transaction.moveMedia(REFERENCE_ID, 1, 0);
      });
    });
    expect(readAttachedIds(api)).toEqual([SECOND_VIDEO.id, LOUD_VIDEO.id]);
    rendered.unmount();
  });

  it("rejects the whole transaction when one media command fails", () => {
    const rendered = mountPanel();
    const api = createExtensionGenerationApi(createScope());

    let result;
    act(() => {
      result = api.transaction("Attach then overreach", (transaction) => {
        transaction.attachAsset(REFERENCE_ID, LOUD_VIDEO.id);
        transaction.moveMedia(REFERENCE_ID, 0, 5);
      });
    });
    expect(result).toMatchObject({
      ok: false,
      code: "ordinal_out_of_range",
    });
    // Atomic: the attach that validated is not applied either.
    expect(readMediaInputs()).toEqual({});
    rendered.unmount();
  });

  it("writes a per-item switch only where the panel offers one", () => {
    const rendered = mountPanel();
    const api = createExtensionGenerationApi(createScope());

    act(() => {
      api.transaction("Attach", (transaction) => {
        transaction.attachAsset(REFERENCE_ID, LOUD_VIDEO.id);
      });
    });
    const attached = readReferences(api)[0];
    expect(attached).toMatchObject({
      slotId: REFERENCE_ID,
      ordinal: 0,
      source: "asset",
      assetId: LOUD_VIDEO.id,
      mediaType: "video",
      hasAudio: true,
      // The switch is offered because the rules declare it and the asset can
      // deliver a soundtrack; it starts off.
      options: { audio: false },
      preparing: false,
    });
    const slotId = attached.slotId;

    let toggled;
    act(() => {
      toggled = api.transaction("Include audio", (transaction) => {
        transaction.setMediaOption(slotId, "audio", true);
      });
    });
    expect(toggled).toMatchObject({ ok: true, changed: true });
    expect(readReferences(api)[0].options).toEqual({ audio: true });

    // Writing the value it already holds moves nothing, and must say so: an
    // extension gates follow-up work on `changed`.
    let inert;
    act(() => {
      inert = api.transaction("Include audio again", (transaction) => {
        transaction.setMediaOption(slotId, "audio", true);
      });
    });
    expect(inert).toMatchObject({ ok: true, changed: false });
    const stored = readMediaInputs()[REFERENCE_ID];
    expect(stored).toMatchObject({ includeEmbeddedAudio: true });

    // A switch the rules never declared is not writable by any id.
    let refused;
    act(() => {
      refused = api.transaction("Unknown switch", (transaction) => {
        transaction.setMediaOption(slotId, "subtitles", true);
      });
    });
    expect(refused).toMatchObject({ ok: false, code: "option_not_available" });
    rendered.unmount();
  });

  it("attaches and switches a reference in one transaction", () => {
    const rendered = mountPanel();
    const api = createExtensionGenerationApi(createScope());

    // The Phase 3D shape: a subject's assets and their switches land together
    // or not at all. The caller cannot name the new item's slot — it does not
    // exist yet — so the switch rides the attach.
    let result;
    act(() => {
      result = api.transaction("Attach subject", (transaction) => {
        transaction.attachAsset(REFERENCE_ID, LOUD_VIDEO.id, {
          itemOptions: { audio: true },
        });
        transaction.attachAsset(REFERENCE_ID, SECOND_VIDEO.id);
      });
    });
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(readReferences(api).map((item) => item.options)).toEqual([
      { audio: true },
      { audio: false },
    ]);

    // A switch the asset cannot deliver is refused, not silently dropped.
    let refused;
    act(() => {
      refused = api.transaction("Silent with audio", (transaction) => {
        transaction.attachAsset(REFERENCE_ID, SILENT_VIDEO.id, {
          itemOptions: { audio: true },
        });
      });
    });
    expect(refused).toMatchObject({ ok: false, code: "option_not_available" });
    expect(readReferences(api)).toHaveLength(2);
    rendered.unmount();
  });

  it("skips a slot the panel is holding open for a value in flight", () => {
    const rendered = mountPanel();
    const api = createExtensionGenerationApi(createScope());

    // A timeline selection confirmed on the first slot: the panel has reserved
    // it and is rendering, so there is no value there yet and `media` is empty.
    act(() => {
      useMediaInputPreparationStore
        .getState()
        .beginMediaInputPreparation(REFERENCE_ID);
    });
    expect(readReferences(api)).toHaveLength(0);

    act(() => {
      api.transaction("Attach beside it", (transaction) => {
        transaction.attachAsset(REFERENCE_ID, LOUD_VIDEO.id);
      });
    });

    // The attach must land on the *second* slot. Landing on the first would be
    // overwritten seconds later by the selection it was holding.
    const stored = readMediaInputs();
    expect(stored[REFERENCE_ID]).toBeUndefined();
    expect(readReferences(api)[0]).toMatchObject({
      assetId: LOUD_VIDEO.id,
      slotId: `${REFERENCE_ID}::repeat::1`,
    });
    // The same rule the batch strip applies when it picks a drop target.
    expect(
      slotIdForNativeDrop(readReferences(api).length),
    ).toBe(`${REFERENCE_ID}::repeat::2`);
    rendered.unmount();
  });

  it("refuses to repack a batch while a slot is held open", () => {
    const rendered = mountPanel();
    const api = createExtensionGenerationApi(createScope());

    act(() => {
      api.transaction("Fill", (transaction) => {
        transaction.attachAsset(REFERENCE_ID, LOUD_VIDEO.id);
        transaction.attachAsset(REFERENCE_ID, SECOND_VIDEO.id);
      });
    });
    // A third slot is now held open by a timeline selection being rendered.
    act(() => {
      useMediaInputPreparationStore
        .getState()
        .beginMediaInputPreparation(`${REFERENCE_ID}::repeat::2`);
    });

    // Repacking would move an existing item into slot 2, and the render that
    // owns it writes there unconditionally when it finishes — the item would
    // be destroyed. Nothing here can cancel or rebase that render, so the
    // write is refused instead of reconciled.
    for (const [label, run] of [
      ["reorder", (t: Parameters<Parameters<typeof api.transaction>[1]>[0]) =>
        t.moveMedia(REFERENCE_ID, 1, 0)],
      ["remove", (t: Parameters<Parameters<typeof api.transaction>[1]>[0]) =>
        t.removeMedia(REFERENCE_ID, REFERENCE_ID)],
      ["insert", (t: Parameters<Parameters<typeof api.transaction>[1]>[0]) =>
        t.attachAsset(REFERENCE_ID, SILENT_VIDEO.id, { at: 0 })],
    ] as const) {
      let outcome;
      act(() => {
        outcome = api.transaction(`Repack by ${label}`, run);
      });
      expect(outcome, label).toMatchObject({ ok: false, code: "input_busy" });
    }
    // Nothing moved, and the reserved slot is still empty and still reserved.
    expect(readAttachedIds(api)).toEqual([LOUD_VIDEO.id, SECOND_VIDEO.id]);
    expect(readMediaInputs()[`${REFERENCE_ID}::repeat::2`]).toBeUndefined();

    // Appending is not repacking: it writes one free slot and disturbs
    // nothing, so it stays available while the render is in flight.
    let appended;
    act(() => {
      appended = api.transaction("Append beside it", (transaction) => {
        transaction.attachAsset(REFERENCE_ID, SILENT_VIDEO.id);
      });
    });
    expect(appended).toMatchObject({ ok: true, changed: true });
    expect(readReferences(api)[2]).toMatchObject({
      assetId: SILENT_VIDEO.id,
      slotId: `${REFERENCE_ID}::repeat::3`,
    });

    // And it recovers on its own once the media lands.
    act(() => {
      useMediaInputPreparationStore
        .getState()
        .endMediaInputPreparation(`${REFERENCE_ID}::repeat::2`);
    });
    let recovered;
    act(() => {
      recovered = api.transaction("Reorder now", (transaction) => {
        transaction.moveMedia(REFERENCE_ID, 1, 0);
      });
    });
    expect(recovered).toMatchObject({ ok: true, changed: true });
    rendered.unmount();
  });

  it("refuses to overfill a batch and to reorder a single slot", () => {
    const rendered = mountPanel();
    const api = createExtensionGenerationApi(createScope());

    act(() => {
      api.transaction("Fill", (transaction) => {
        for (let index = 0; index < 4; index += 1) {
          transaction.attachAsset(REFERENCE_ID, LOUD_VIDEO.id);
        }
      });
    });
    expect(readAttachedIds(api)).toHaveLength(4);

    let full;
    act(() => {
      full = api.transaction("One too many", (transaction) => {
        transaction.attachAsset(REFERENCE_ID, SECOND_VIDEO.id);
      });
    });
    expect(full).toMatchObject({ ok: false, code: "batch_full" });

    // A reorder onto the position an item already holds is inert.
    let inert;
    act(() => {
      inert = api.transaction("Move nowhere", (transaction) => {
        transaction.moveMedia(REFERENCE_ID, 1, 1);
      });
    });
    expect(inert).toMatchObject({ ok: true, changed: false });

    let single;
    act(() => {
      single = api.transaction("Reorder a single slot", (transaction) => {
        transaction.moveMedia(SINGLE_ID, 0, 0);
      });
    });
    expect(single).toMatchObject({ ok: false, code: "input_not_repeatable" });
    rendered.unmount();
  });
  it("keeps a staged SDK item's id once the draft commits it to the store", () => {
    // The ref2v composer binds prose to `itemId` while an attach is still only
    // staged, so the id it saw has to be the one the panel ends up holding —
    // through the real store, not a model of it (plan §3.1, §3.3).
    useAssetStore.setState({ assets: [LOUD_VIDEO, SECOND_VIDEO] as never });
    const rendered = mountPanel();
    const api = createExtensionGenerationApi(createScope());
    const draft = api.createInputsDraft({ inputIds: [REFERENCE_ID] });
    expect(draft).not.toBeNull();

    act(() => {
      draft!.stage({
        kind: "attachAsset",
        inputId: REFERENCE_ID,
        assetId: LOUD_VIDEO.id,
      });
      draft!.stage({
        kind: "attachAsset",
        inputId: REFERENCE_ID,
        assetId: SECOND_VIDEO.id,
      });
      draft!.stage({
        kind: "moveMedia",
        inputId: REFERENCE_ID,
        fromOrdinal: 1,
        toOrdinal: 0,
      });
    });
    const stagedIds = draft!
      .getState()
      .inputs[0]!.media!.map((item) => item.itemId);

    let readingIds: string[] = [];
    let result;
    act(() => {
      result = draft!.commit("Attach references", (_transaction, reading) => {
        readingIds = reading.inputs[0]!.media!.map((item) => item.itemId);
        // Frozen: the reading is what the caller numbers from.
        expect(Object.isFrozen(reading)).toBe(true);
      });
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(readingIds).toEqual(stagedIds);
    expect(readReferences(api).map((item) => item.itemId)).toEqual(stagedIds);
    expect(readAttachedIds(api)).toEqual([SECOND_VIDEO.id, LOUD_VIDEO.id]);
    draft!.dispose();
    rendered.unmount();
    useAssetStore.setState({ assets: [] as never });
  });
});
