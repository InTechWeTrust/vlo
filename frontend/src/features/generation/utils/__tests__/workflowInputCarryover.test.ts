import { describe, expect, it } from "vitest";

import type { WorkflowInput } from "../../types";
import {
  carryOverMediaInputs,
  carryOverTextValues,
} from "../workflowInputCarryover";

function makeInput(overrides: Partial<WorkflowInput>): WorkflowInput {
  return {
    nodeId: "1",
    classType: "CLIPTextEncode",
    inputType: "text",
    param: "text",
    label: "Prompt",
    currentValue: "",
    origin: "inferred",
    ...overrides,
  };
}

function makeImageAsset(id: string) {
  return {
    kind: "asset" as const,
    asset: {
      id,
      hash: id,
      name: `${id}.png`,
      type: "image" as const,
      src: `assets/${id}.png`,
      createdAt: 1,
    },
  };
}

function makeVideoAsset(id: string) {
  return {
    kind: "asset" as const,
    asset: {
      id,
      hash: id,
      name: `${id}.mp4`,
      type: "video" as const,
      src: `assets/${id}.mp4`,
      createdAt: 1,
    },
  };
}

describe("workflowInputCarryover", () => {
  it.each([false, true])(
    "moves video-backed audio to another workflow only when prepared (%s)",
    (prepared) => {
      const previous = makeInput({
        nodeId: "85",
        inputType: "audio",
        classType: "LoadAudio",
        param: "audio",
        label: "Audio",
      });
      const next = { ...previous, nodeId: "95" };
      const value = {
        kind: "asset" as const,
        asset: {
          id: "video",
          hash: "video-hash",
          name: "video.mp4",
          type: "video" as const,
          src: "video.mp4",
          createdAt: 0,
        },
        isExtracting: !prepared,
        extractedAudioFile: prepared
          ? new File(["audio"], "audio.wav", { type: "audio/wav" })
          : null,
      };
      expect(carryOverMediaInputs(
        [previous], { "85:audio": value }, [next],
      )).toEqual(prepared ? { "95:audio": value } : {});
    },
  );

  it("carries prompt values across workflow switches by semantic label", () => {
    const previousInputs: WorkflowInput[] = [
      makeInput({
        nodeId: "11",
        label: "Positive Prompt",
        currentValue: "sunrise over a lake",
      }),
      makeInput({
        nodeId: "12",
        label: "Negative Prompt",
        currentValue: "blurry",
      }),
    ];

    const nextInputs: WorkflowInput[] = [
      makeInput({
        nodeId: "31",
        label: "Positive Prompt",
      }),
      makeInput({
        nodeId: "32",
        label: "Negative Prompt",
      }),
    ];

    expect(
      carryOverTextValues(
        previousInputs,
        {
          "11:text": "sunrise over a lake",
          "12:text": "blurry",
        },
        nextInputs,
      ),
    ).toEqual({
      "31:text": "sunrise over a lake",
      "32:text": "blurry",
    });
  });

  it("carries a single compatible image input between workflows", () => {
    const previousInputs: WorkflowInput[] = [
      makeInput({
        nodeId: "101",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Image",
        currentValue: null,
      }),
    ];

    const nextInputs: WorkflowInput[] = [
      makeInput({
        nodeId: "202",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Reference Image",
        currentValue: null,
      }),
    ];

    const assetValue = {
      kind: "asset" as const,
      asset: {
        id: "asset-1",
        hash: "hash-1",
        name: "frame.png",
        type: "video" as const,
        src: "assets/frame.png",
        createdAt: Date.now(),
      },
    };

    expect(
      carryOverMediaInputs(
        previousInputs,
        { "101:image": assetValue },
        nextInputs,
      ),
    ).toEqual({
      "202:image": assetValue,
    });
  });

  it("does not guess between multiple previous image inputs", () => {
    const previousInputs: WorkflowInput[] = [
      makeInput({
        nodeId: "401",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Start Frame",
        currentValue: null,
      }),
      makeInput({
        nodeId: "402",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "End Frame",
        currentValue: null,
      }),
    ];

    const nextInputs: WorkflowInput[] = [
      makeInput({
        nodeId: "501",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Reference Image",
        currentValue: null,
      }),
    ];

    expect(
      carryOverMediaInputs(
        previousInputs,
        {
          "401:image": {
            kind: "asset",
            asset: {
              id: "asset-start",
              hash: "hash-start",
              name: "start.png",
              type: "image",
              src: "assets/start.png",
              createdAt: Date.now(),
            },
          },
          "402:image": {
            kind: "asset",
            asset: {
              id: "asset-end",
              hash: "hash-end",
              name: "end.png",
              type: "image",
              src: "assets/end.png",
              createdAt: Date.now(),
            },
          },
        },
        nextInputs,
      ),
    ).toEqual({});
  });

  // The shipped MiniMax H3 pair, as their rule sidecars declare them. These two
  // are the reason batch carryover exists: same loaders and prompt either way,
  // and the inpaint side carries one extra input the other has no place for.
  const MINIMAX_R2V_INPUTS: WorkflowInput[] = [
    makeInput({
      nodeId: "136",
      classType: "vloMiniMaxH3ReferenceToVideoBatch",
      param: "prompt",
      label: "Prompt",
    }),
    makeInput({
      nodeId: "141",
      classType: "vloMemoryLoadImageBatch",
      inputType: "image",
      param: "images",
      label: "Image inputs",
      currentValue: null,
      presentation: { repeatable: { max: 9 } },
    }),
    makeInput({
      nodeId: "142",
      classType: "vloMemoryLoadVideoBatch",
      inputType: "video",
      param: "files",
      label: "Video inputs",
      currentValue: null,
      presentation: { repeatable: { max: 3, itemOptions: ["audio"] } },
    }),
    makeInput({
      nodeId: "143",
      classType: "vloMemoryLoadAudioBatch",
      inputType: "audio",
      param: "audios",
      label: "Audio inputs",
      currentValue: null,
      presentation: { repeatable: { max: 3 } },
    }),
  ];

  const MINIMAX_INPAINT_INPUTS: WorkflowInput[] = [
    makeInput({
      nodeId: "53",
      classType: "vloMemoryLoadVideo",
      inputType: "video",
      param: "file",
      label: "Source video",
      currentValue: null,
    }),
    { ...MINIMAX_R2V_INPUTS[0], nodeId: "81" },
    { ...MINIMAX_R2V_INPUTS[1], nodeId: "83" },
    { ...MINIMAX_R2V_INPUTS[2], nodeId: "84" },
    { ...MINIMAX_R2V_INPUTS[3], nodeId: "85" },
  ];

  it("lets labels win over node ids that another workflow reuses", () => {
    // Node ids are workflow-local: two workflows can hand the same ids to
    // different inputs, or swap them. Matching on the identifier would deliver
    // each value to the wrong field; only within one workflow is the
    // identifier evidence of identity.
    const character = (nodeId: string) =>
      makeInput({
        nodeId,
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Character image",
        currentValue: null,
      });
    const background = (nodeId: string) =>
      makeInput({
        nodeId,
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Background image",
        currentValue: null,
      });

    expect(
      carryOverMediaInputs(
        [character("5"), background("9")],
        {
          "5:image": makeImageAsset("hero"),
          "9:image": makeImageAsset("alley"),
        },
        [character("9"), background("5")],
        { sameWorkflow: false },
      ),
    ).toEqual({
      "9:image": makeImageAsset("hero"),
      "5:image": makeImageAsset("alley"),
    });
  });

  it("holds slot positions only within one workflow", () => {
    const batch = (nodeId: string) =>
      makeInput({
        nodeId,
        classType: "vloMemoryLoadImageBatch",
        inputType: "image",
        param: "images",
        label: "Image inputs",
        currentValue: null,
        presentation: { repeatable: { max: 9 } },
      });
    const sparse = {
      "141:images": makeImageAsset("first"),
      "141:images::repeat::2": makeImageAsset("third"),
    };

    // A reload of the same workflow leaves the batch exactly as it was.
    expect(
      carryOverMediaInputs([batch("141")], sparse, [batch("141")], {
        sameWorkflow: true,
      }),
    ).toEqual(sparse);

    // The same identifier in a different workflow is a coincidence, and the
    // batch arrives front-packed like any other carried batch.
    expect(
      carryOverMediaInputs([batch("141")], sparse, [batch("141")], {
        sameWorkflow: false,
      }),
    ).toEqual({
      "141:images": makeImageAsset("first"),
      "141:images::repeat::1": makeImageAsset("third"),
    });
  });

  it("routes prompts by label when another workflow swaps the node ids", () => {
    const positive = (nodeId: string) =>
      makeInput({ nodeId, label: "Positive prompt" });
    const negative = (nodeId: string) =>
      makeInput({ nodeId, label: "Negative prompt" });
    const values = { "5:text": "a comic book hero", "9:text": "blurry" };

    expect(
      carryOverTextValues(
        [positive("5"), negative("9")],
        values,
        [positive("9"), negative("5")],
        { sameWorkflow: false },
      ),
    ).toEqual({ "9:text": "a comic book hero", "5:text": "blurry" });

    // Within one workflow the identifier is the input, whatever it is labelled.
    expect(
      carryOverTextValues(
        [positive("5"), negative("9")],
        values,
        [positive("9"), negative("5")],
        { sameWorkflow: true },
      ),
    ).toEqual({ "9:text": "blurry", "5:text": "a comic book hero" });
  });

  it("carries full MiniMax H3 batches between r2v and inpaint", () => {
    expect(
      carryOverMediaInputs(
        MINIMAX_R2V_INPUTS,
        {
          "141:images": makeImageAsset("one"),
          "141:images::repeat::1": makeImageAsset("two"),
          "141:images::repeat::2": makeImageAsset("three"),
          "142:files": makeVideoAsset("clip"),
          "142:files::repeat::1": makeVideoAsset("other-clip"),
        },
        MINIMAX_INPAINT_INPUTS,
      ),
    ).toEqual({
      "83:images": makeImageAsset("one"),
      "83:images::repeat::1": makeImageAsset("two"),
      "83:images::repeat::2": makeImageAsset("three"),
      "84:files": makeVideoAsset("clip"),
      "84:files::repeat::1": makeVideoAsset("other-clip"),
    });
  });

  it("does not let inpaint's extra source video feed the reference batch", () => {
    // "Source video" has no counterpart in r2v. It must be dropped outright
    // rather than fall through to "Video inputs", which already has its own
    // value and its own delivery ordinals.
    expect(
      carryOverMediaInputs(
        MINIMAX_INPAINT_INPUTS,
        {
          "53:file": makeVideoAsset("source"),
          "84:files": makeVideoAsset("reference"),
        },
        MINIMAX_R2V_INPUTS,
      ),
    ).toEqual({ "142:files": makeVideoAsset("reference") });
  });

  it("carries a whole batch across workflows, re-packed from the front", () => {
    const previous = makeInput({
      nodeId: "141",
      classType: "vloMemoryLoadImageBatch",
      inputType: "image",
      param: "images",
      label: "Image inputs",
      currentValue: null,
      presentation: { repeatable: { max: 9 } },
    });
    // The same batch as the panel presents it one workflow over: a different
    // node, identical label/class/param.
    const next = { ...previous, nodeId: "83" };

    expect(
      carryOverMediaInputs(
        [previous],
        {
          "141:images": makeImageAsset("first"),
          "141:images::repeat::1": makeImageAsset("second"),
          "141:images::repeat::2": makeImageAsset("third"),
        },
        [next],
      ),
    ).toEqual({
      "83:images": makeImageAsset("first"),
      "83:images::repeat::1": makeImageAsset("second"),
      "83:images::repeat::2": makeImageAsset("third"),
    });
  });

  it("clamps a carried batch to the receiving input's slot count", () => {
    const previous = makeInput({
      nodeId: "142",
      classType: "vloMemoryLoadVideoBatch",
      inputType: "video",
      param: "files",
      label: "Video inputs",
      currentValue: null,
      presentation: { repeatable: { max: 3 } },
    });
    const next = {
      ...previous,
      nodeId: "84",
      presentation: { repeatable: { max: 2 } },
    };

    expect(
      carryOverMediaInputs(
        [previous],
        {
          "142:files": makeVideoAsset("first"),
          "142:files::repeat::1": makeVideoAsset("second"),
          "142:files::repeat::2": makeVideoAsset("third"),
        },
        [next],
      ),
    ).toEqual({
      "84:files": makeVideoAsset("first"),
      "84:files::repeat::1": makeVideoAsset("second"),
    });
  });

  it("matches a batch whose first slot is empty on the strength of its tail", () => {
    const previous = makeInput({
      nodeId: "141",
      classType: "vloMemoryLoadImageBatch",
      inputType: "image",
      param: "images",
      label: "Image inputs",
      currentValue: null,
      presentation: { repeatable: { max: 9 } },
    });
    const next = { ...previous, nodeId: "83" };

    expect(
      carryOverMediaInputs(
        [previous],
        { "141:images::repeat::2": makeImageAsset("only") },
        [next],
      ),
    ).toEqual({ "83:images": makeImageAsset("only") });
  });

  it("leaves an extracting item behind and closes the gap it would leave", () => {
    const previous = makeInput({
      nodeId: "142",
      classType: "vloMemoryLoadVideoBatch",
      inputType: "video",
      param: "files",
      label: "Video inputs",
      currentValue: null,
      presentation: { repeatable: { max: 3 } },
    });
    const next = { ...previous, nodeId: "84" };
    // Mid-extraction: its work writes back to the slot id it started on, so it
    // cannot follow the batch to a differently-identified input.
    const extracting = {
      kind: "timelineSelection" as const,
      mediaType: "video" as const,
      preparedVideoFile: null,
      isExtracting: true,
    } as unknown as Parameters<typeof carryOverMediaInputs>[1][string];

    expect(
      carryOverMediaInputs(
        [previous],
        {
          "142:files": makeVideoAsset("first"),
          "142:files::repeat::1": extracting,
          "142:files::repeat::2": makeVideoAsset("third"),
        },
        [next],
      ),
    ).toEqual({
      "84:files": makeVideoAsset("first"),
      "84:files::repeat::1": makeVideoAsset("third"),
    });
  });

  it("holds slot positions when the same input keeps its identifier", () => {
    const input = makeInput({
      nodeId: "141",
      classType: "vloMemoryLoadImageBatch",
      inputType: "image",
      param: "images",
      label: "Image inputs",
      currentValue: null,
      presentation: { repeatable: { max: 9 } },
    });

    // A re-read of the same workflow must not re-pack a batch the user left
    // with a hole in it, or tiles would shuffle under a mid-edit panel.
    expect(
      carryOverMediaInputs(
        [input],
        {
          "141:images": makeImageAsset("first"),
          "141:images::repeat::2": makeImageAsset("third"),
        },
        [input],
      ),
    ).toEqual({
      "141:images": makeImageAsset("first"),
      "141:images::repeat::2": makeImageAsset("third"),
    });
  });

  it("preserves ordered repeatable media values for the same workflow input", () => {
    const repeatableInput = makeInput({
      nodeId: "141",
      classType: "vloMemoryLoadImageBatch",
      inputType: "image",
      param: "images",
      label: "Image inputs",
      currentValue: null,
      presentation: { repeatable: { max: 9 } },
    });
    const first = {
      kind: "asset" as const,
      asset: {
        id: "first",
        hash: "first",
        name: "first.png",
        type: "image" as const,
        src: "assets/first.png",
        createdAt: 1,
      },
    };
    const second = {
      kind: "asset" as const,
      asset: {
        id: "second",
        hash: "second",
        name: "second.png",
        type: "image" as const,
        src: "assets/second.png",
        createdAt: 2,
      },
    };

    expect(
      carryOverMediaInputs(
        [repeatableInput],
        {
          "141:images": first,
          "141:images::repeat::1": second,
        },
        [repeatableInput],
      ),
    ).toEqual({
      "141:images": first,
      "141:images::repeat::1": second,
    });
  });
});
