import { createPointTimelineSelection } from "../../../timelineSelection";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionGenerationDraftCapture } from "../ExtensionGenerationDraftCapture";
import { createScopedInputsDraft } from "../extensionGenerationInputsDraft";
import { createGenerationInputsDraft } from "../../../generation/draft/generationInputsDraftController";
import { captureGenerationDraftInput, registerGenerationInputCapture, type GenerationCaptureDestination } from "../../../generation/services/GenerationInputCapture";
import { mountGenerationSession } from "../../../../testUtils/generationSession";
import { useExtractStore } from "../../../../core/extract/useExtractStore";
import { useTimelineSelectionStore } from "../../../timelineSelection";
import { useAssetStore } from "../../../userAssets";
import type { ExtensionApiScope } from "../../types";
import type { GenerationInputSnapshot } from "../../../generation/services/generationSessionTypes";
import type { Asset } from "../../../../types/Asset";

const INPUT: GenerationInputSnapshot = { id: "image", nodeId: "1", param: "image", label: "Picture", inputType: "image", media: [], repeatable: { max: 3, optionIds: [] } };
const ASSET = { id: "captured", type: "image", name: "capture.png", src: "blob:capture" } as Asset;
function capture() { return { kind: "frame" as const, file: new File(["image"], "capture.png"), timelineSelection: createPointTimelineSelection(42) }; }
const originalIngest = useAssetStore.getState().addLocalAsset;
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).reverse().forEach((dispose) => dispose());
  useExtractStore.getState().setOnConfirmSelection(null);
  useExtractStore.getState().exitFrameSelectionMode();
  useTimelineSelectionStore.getState().exitSelectionMode();
  vi.restoreAllMocks();
  useAssetStore.setState({ addLocalAsset: originalIngest, assets: [] });
});

function setup() {
  const mounted = mountGenerationSession({ inputs: [INPUT] });
  disposers.push(mounted.unmount);
  mounted.assets.set(ASSET.id, ASSET);
  const ingest = vi.spyOn(useAssetStore.getState(), "addLocalAsset").mockImplementation(async () => {
    useAssetStore.setState({ assets: [ASSET] });
    return ASSET;
  });
  let destination: GenerationCaptureDestination | null = null;
  disposers.push(registerGenerationInputCapture((_inputId, _type, target) => {
    destination = target;
    useExtractStore.getState().enterFrameSelectionMode();
    useExtractStore.getState().setOnConfirmSelection(() => undefined);
  }));
  return { mounted, ingest, destination: () => {
    if (!destination) throw new Error("capture did not start");
    return destination;
  } };
}

function scope(): ExtensionApiScope {
  return { extension: { id: "example.capture", version: "1" }, signal: new AbortController().signal,
    own: (resource) => { if (typeof resource !== "function") disposers.push(() => { void resource.dispose(); }); return resource; }, report: vi.fn() };
}

describe.each(["native", "SDK"] as const)("%s draft capture", (entryPoint) => {
  function open(onDone = vi.fn()) {
    if (entryPoint === "native") {
      const draft = createGenerationInputsDraft({ inputIds: [INPUT.id] });
      disposers.push(draft.dispose);
      const cancel = captureGenerationDraftInput(draft, INPUT.id, 0, onDone);
      disposers.push(cancel);
      return { reading: draft.getSnapshot, commit: draft.commit, cancel, dispose: draft.dispose };
    }
    const draft = createScopedInputsDraft(scope(), { inputIds: [INPUT.id] });
    if (!draft) throw new Error("draft unavailable");
    const view = render(<ExtensionGenerationDraftCapture controller={draft} inputId={INPUT.id} at={0} onDone={onDone} />);
    disposers.push(view.unmount);
    return { reading: draft.getState, commit: draft.commit, cancel: view.unmount, dispose: draft.dispose };
  }

  it("stages a finished capture without changing the panel until commit", async () => {
    const fixture = setup();
    const draft = open();
    await act(async () => { await fixture.destination().complete(capture()); });
    expect(draft.reading().inputs[0].media?.[0]).toMatchObject({ source: "frame", displayName: "capture.png" });
    expect(draft.reading().inputs[0].media?.[0].assetId).toBeUndefined();
    expect(fixture.ingest).not.toHaveBeenCalled();
    expect(useAssetStore.getState().assets).toEqual([]);
    expect(fixture.mounted.commit).not.toHaveBeenCalled();
    expect(draft.commit("Capture").ok).toBe(true);
    expect(fixture.mounted.panelInputs()[0].media?.[0].source).toBe("frame");
    expect(fixture.mounted.panelInputs()[0].media?.[0].assetId).toBeUndefined();
    expect(fixture.ingest).not.toHaveBeenCalled();
  });

  it("ignores a render that finishes after cancellation", async () => {
    const fixture = setup();
    const draft = open();
    draft.cancel();
    await fixture.destination().complete(capture());
    expect(fixture.ingest).not.toHaveBeenCalled();
    expect(draft.reading().hasDraftChanges).toBe(false);
    expect(useExtractStore.getState().frameSelectionMode).toBe(false);
  });

  it("ignores a result after the draft owner is disposed", async () => {
    const fixture = setup();
    const draft = open();
    act(() => draft.dispose());
    await fixture.destination().complete(capture());
    expect(fixture.ingest).not.toHaveBeenCalled();
    expect(fixture.mounted.commit).not.toHaveBeenCalled();
  });

  it("preserves another active selection", () => {
    setup();
    const confirm = vi.fn();
    useExtractStore.getState().enterFrameSelectionMode();
    useExtractStore.getState().setOnConfirmSelection(confirm);
    const onDone = vi.fn();
    open(onDone);
    expect(onDone).toHaveBeenCalledWith("Finish the current timeline selection first.");
    expect(useExtractStore.getState().onConfirmSelection).toBe(confirm);
  });

  it("does not deliver into a different workflow", async () => {
    const fixture = setup();
    const draft = open();
    act(() => fixture.mounted.publish({ fingerprint: "another-workflow", instanceId: "another-instance" }));
    await fixture.destination().complete(capture());
    expect(fixture.ingest).not.toHaveBeenCalled();
    draft.dispose();
    expect(fixture.mounted.commit).not.toHaveBeenCalled();
  });
});
