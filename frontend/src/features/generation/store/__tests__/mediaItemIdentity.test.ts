import { makeTimelineSelection } from "../../../../testUtils/timelineSelection";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useGenerationStore } from "../../useGenerationStore";
import { resetZustandStore } from "../../../../testUtils/zustand";
import type { Asset } from "../../../../types/Asset";
import type { TimelineSelection } from "../../../../types/TimelineTypes";
import type { WorkflowInput } from "../../types";
import {
  buildGenerationPanelSnapshot,
  EMPTY_GENERATION_PANEL_VALUES,
  parseGenerationPanelSnapshot,
} from "../../persistence/generationPanelSnapshot";
import { buildGeneratedCreationInputs } from "../metadata";

/**
 * Occurrence identity (docs/minimax-ref2v-prompt-composer-plan.md §3.1).
 *
 * An item id names one attachment: it survives everything that rearranges or
 * re-prepares that attachment, and nothing that replaces it.
 */

const BATCH_ID = "142:files";
const SINGLE_ID = "12:image";

const BATCH_INPUT: WorkflowInput = {
  id: BATCH_ID,
  nodeId: "142",
  classType: "vloMemoryLoadVideoBatch",
  inputType: "video",
  param: "files",
  label: "Video inputs",
  currentValue: null,
  origin: "rule",
  presentation: { repeatable: { max: 3, itemOptions: ["audio"] } },
};

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

function video(id: string): Asset {
  return {
    id,
    hash: id,
    name: `${id}.mp4`,
    type: "video",
    src: `blob:${id}`,
    createdAt: 1,
    hasAudio: true,
  } as Asset;
}

function image(id: string): Asset {
  return {
    id,
    hash: id,
    name: `${id}.png`,
    type: "image",
    src: `blob:${id}`,
    createdAt: 1,
  } as Asset;
}

const slot = (index: number) =>
  index === 0 ? BATCH_ID : `${BATCH_ID}::repeat::${index}`;

function store() {
  return useGenerationStore.getState();
}

function idAt(inputId: string): string | undefined {
  return store().mediaInputs[inputId]?.itemId;
}

function selection(start: number, end: number): TimelineSelection {
  return makeTimelineSelection({ start, end, clips: [] }) as unknown as TimelineSelection;
}

function thumbnail(): File {
  return new File(["x"], "thumb.png", { type: "image/png" });
}

beforeEach(() => {
  resetZustandStore(useGenerationStore);
  useGenerationStore.setState({
    workflowInputs: [BATCH_INPUT, SINGLE_INPUT],
    mediaInputs: {},
  });
  globalThis.URL.createObjectURL ??= () => "blob:thumb";
  globalThis.URL.revokeObjectURL ??= () => undefined;
});

afterEach(() => {
  resetZustandStore(useGenerationStore);
});

describe("media item identity", () => {
  it("mints a distinct id for every attachment, even of the same asset", () => {
    store().setMediaInputAsset(slot(0), video("clip"));
    store().setMediaInputAsset(slot(1), video("clip"));

    expect(idAt(slot(0))).toMatch(/^media-/);
    expect(idAt(slot(1))).toMatch(/^media-/);
    expect(idAt(slot(0))).not.toBe(idAt(slot(1)));
  });

  it("keeps each id with its media through a reorder", () => {
    store().setMediaInputAsset(slot(0), video("a"));
    store().setMediaInputAsset(slot(1), video("b"));
    store().setMediaInputAsset(slot(2), video("c"));
    const [a, b, c] = [idAt(slot(0)), idAt(slot(1)), idAt(slot(2))];

    store().moveMediaInput(slot(2), 0);

    expect([idAt(slot(0)), idAt(slot(1)), idAt(slot(2))]).toEqual([c, a, b]);
  });

  it("keeps the survivors' ids when a removal compacts the batch", () => {
    store().setMediaInputAsset(slot(0), video("a"));
    store().setMediaInputAsset(slot(1), video("b"));
    store().setMediaInputAsset(slot(2), video("c"));
    const [, b, c] = [idAt(slot(0)), idAt(slot(1)), idAt(slot(2))];

    store().clearMediaInput(slot(0));

    expect([idAt(slot(0)), idAt(slot(1))]).toEqual([b, c]);
    expect(idAt(slot(2))).toBeUndefined();
  });

  it("keeps the id through an option change and a preparation rewrite", () => {
    store().setMediaInputAsset(slot(0), video("a"), { isExtracting: true });
    const id = idAt(slot(0));

    store().setMediaInputItemOption(slot(0), "audio", true);
    store().setMediaInputAsset(slot(0), video("a"), { isExtracting: false });

    expect(idAt(slot(0))).toBe(id);
    expect(store().mediaInputs[slot(0)]).toMatchObject({
      includeEmbeddedAudio: true,
    });
  });

  it("keeps a selection's id while it renders, and mints one for a new range", () => {
    const range = selection(0, 48);
    store().setMediaInputTimelineSelection(slot(0), range, thumbnail(), {
      isExtracting: true,
      extractionRequestId: 1,
    });
    const id = idAt(slot(0));

    store().setMediaInputTimelineSelection(slot(0), range, thumbnail(), {
      isExtracting: false,
      extractionRequestId: 1,
    });
    expect(idAt(slot(0))).toBe(id);

    store().setMediaInputTimelineSelection(
      slot(0),
      selection(12, 48),
      thumbnail(),
      { extractionRequestId: 2 },
    );
    expect(idAt(slot(0))).not.toBe(id);
  });

  it("keeps the id across an edit that names it, as the mini editor does", () => {
    store().setMediaInputTimelineSelection(slot(0), selection(0, 48), thumbnail());
    const id = idAt(slot(0));

    store().setMediaInputTimelineSelection(
      slot(0),
      selection(12, 36),
      thumbnail(),
      { extractionRequestId: 2, itemId: id },
    );

    expect(idAt(slot(0))).toBe(id);
  });

  it("gives replacement media a new id", () => {
    store().setMediaInputAsset(SINGLE_ID, image("first"));
    const first = idAt(SINGLE_ID);

    store().setMediaInputAsset(SINGLE_ID, image("second"));

    expect(idAt(SINGLE_ID)).toMatch(/^media-/);
    expect(idAt(SINGLE_ID)).not.toBe(first);
  });

  it("does not repair a removed occurrence by re-attaching its asset", () => {
    store().setMediaInputAsset(slot(0), video("a"));
    const removed = idAt(slot(0));

    store().clearMediaInput(slot(0));
    store().setMediaInputAsset(slot(0), video("a"));

    expect(idAt(slot(0))).not.toBe(removed);
  });

  it("names a slot's occurrence on request, but never aliases another slot's", () => {
    store().setMediaInputAsset(slot(0), video("a"));
    store().setMediaInputAsset(slot(1), video("b"));
    const held = idAt(slot(1));

    store().setMediaInputItemId(slot(0), "media-chosen");
    expect(idAt(slot(0))).toBe("media-chosen");

    store().setMediaInputItemId(slot(0), held!);
    expect(idAt(slot(0))).toBe("media-chosen");

    store().setMediaInputItemId(slot(0), "not a valid id!");
    expect(idAt(slot(0))).toBe("media-chosen");
  });

  it("refuses an explicit id another slot holds on a value write", () => {
    store().setMediaInputAsset(slot(0), video("a"));
    const held = idAt(slot(0))!;

    store().setMediaInputTimelineSelection(slot(1), selection(0, 24), thumbnail(), {
      itemId: held,
    });

    expect(idAt(slot(1))).toMatch(/^media-/);
    expect(idAt(slot(1))).not.toBe(held);
    expect(idAt(slot(0))).toBe(held);
  });
});

describe("media item identity across persistence", () => {
  function buildSnapshot() {
    const state = store();
    return buildGenerationPanelSnapshot({
      workflowId: "wf.json",
      workflowRules: null,
      workflowInputs: state.workflowInputs,
      mediaInputs: state.mediaInputs,
      targetResolution: 1024,
      targetResolutionIsCustom: false,
      exactAspectRatio: false,
      aspectRatioSelection: "auto" as never,
      maskCropMode: "crop",
      maskCropDilation: 0,
      values: EMPTY_GENERATION_PANEL_VALUES,
    });
  }

  it("saves ids into the project's panel state and reads them back", () => {
    store().setMediaInputAsset(slot(0), video("a"));
    store().setMediaInputAsset(slot(1), video("a"));
    const ids = [idAt(slot(0)), idAt(slot(1))];

    const parsed = parseGenerationPanelSnapshot(
      JSON.parse(JSON.stringify(buildSnapshot())),
    );

    expect(parsed?.inputs.map((input) => input.itemId)).toEqual(ids);
  });

  it("drops a malformed saved id rather than the attachment", () => {
    const parsed = parseGenerationPanelSnapshot({
      version: 1,
      workflowId: "wf.json",
      inputs: [
        {
          nodeId: "142",
          inputId: BATCH_ID,
          kind: "draggedAsset",
          parentAssetId: "a",
          itemId: "has spaces",
        },
      ],
    });

    expect(parsed?.inputs).toEqual([
      {
        nodeId: "142",
        inputId: BATCH_ID,
        kind: "draggedAsset",
        parentAssetId: "a",
      },
    ]);
  });

  it("leaves ids out of generated-asset metadata, so a replay is a new scope", () => {
    store().setMediaInputAsset(slot(0), video("a"));

    const inputs = buildGeneratedCreationInputs(
      store().workflowInputs,
      store().mediaInputs,
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toHaveProperty("itemId");
  });
});
