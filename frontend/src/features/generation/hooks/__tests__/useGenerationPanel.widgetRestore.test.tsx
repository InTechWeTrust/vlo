import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGenerationPanel } from "../useGenerationPanel";
import { useGenerationStore } from "../../useGenerationStore";
import { resetZustandStore } from "../../../../testUtils/zustand";
import { buildFrontendStateValueKey } from "../../services/frontendRuleState";
import { createDefaultWorkflowRules } from "../../services/workflowRules";
import type { WorkflowReplayPanelState } from "../../store/types";

const LENGTH_KEY = buildFrontendStateValueKey({ nodeId: "136", widget: "length" });
const LORA_KEY = buildFrontendStateValueKey({ nodeId: "4", widget: "lora_name" });

const WORKFLOW = {
  "136": { class_type: "EmptyLatentVideo", inputs: { length: 124, seed: 7 } },
  "4": {
    class_type: "LoraLoaderModelOnly",
    inputs: { lora_name: "base.safetensors" },
  },
};

const OBJECT_INFO = {
  LoraLoaderModelOnly: {
    input: {
      required: {
        lora_name: [["base.safetensors", "detail.safetensors"], {}],
      },
    },
    input_order: { required: ["lora_name"] },
  },
};

const RULES = {
  ...createDefaultWorkflowRules(),
  nodes: {
    "136": {
      widgets: {
        length: { label: "Length", value_type: "int" as const, default: 124 },
        seed: {
          label: "Seed",
          value_type: "int" as const,
          control_after_generate: true,
        },
      },
    },
  },
};

function replay(
  overrides: Partial<WorkflowReplayPanelState> = {},
): WorkflowReplayPanelState {
  return {
    textValues: {},
    widgetValues: { [LENGTH_KEY]: "311", [LORA_KEY]: "detail.safetensors" },
    widgetModes: {},
    derivedWidgetValues: {},
    ...overrides,
  };
}

function mountPanel(options: { objectInfo?: boolean } = {}) {
  useGenerationStore.setState({
    selectedWorkflowId: "wf.json",
    activeWorkflowRules: RULES,
    syncedWorkflow: WORKFLOW,
    syncedGraphData: {},
    rawObjectInfo: options.objectInfo === false ? null : OBJECT_INFO,
  });
  return renderHook(() => useGenerationPanel());
}

function hydrate(state: WorkflowReplayPanelState) {
  act(() => {
    useGenerationStore.setState({ pendingReplayPanelState: state });
  });
}

/** What `loadWorkflow` does to the store across a reload. */
function reloadSameWorkflow() {
  act(() => {
    useGenerationStore.setState({
      isWorkflowLoading: true,
      syncedWorkflow: null,
      syncedGraphData: null,
    });
  });
  act(() => {
    useGenerationStore.setState({ syncedWorkflow: WORKFLOW, syncedGraphData: {} });
  });
  act(() => {
    useGenerationStore.setState({ isWorkflowLoading: false });
  });
}

function published() {
  return useGenerationStore.getState().panelValues;
}

beforeEach(() => {
  resetZustandStore(useGenerationStore);
  vi.spyOn(useGenerationStore.getState(), "connect").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  resetZustandStore(useGenerationStore);
});

describe("useGenerationPanel widget restore", () => {
  it("keeps restored widget values across a reload of the same workflow", () => {
    const hook = mountPanel();
    hydrate(replay());
    expect(hook.result.current.widgetValues["136"]?.length).toBe(311);

    act(() => {
      useGenerationStore.setState({
        isWorkflowLoading: true,
        syncedWorkflow: null,
        syncedGraphData: null,
      });
    });
    // Nothing is published while the widgets are away, so a save in the gap
    // cannot record the panel as empty.
    expect(published().frontendStateWidgetValues[LENGTH_KEY]).toBe(311);

    act(() => {
      useGenerationStore.setState({ syncedWorkflow: WORKFLOW, syncedGraphData: {} });
    });
    act(() => {
      useGenerationStore.setState({ isWorkflowLoading: false });
    });

    expect(hook.result.current.widgetValues["136"]?.length).toBe(311);
    expect(hook.result.current.widgetValues["4"]?.lora_name).toBe(
      "detail.safetensors",
    );
    expect(published().frontendStateWidgetValues[LENGTH_KEY]).toBe(311);
  });

  it("keeps a bypassed LoRA bypassed across a reload of the same workflow", () => {
    const hook = mountPanel();
    hydrate(replay({ bypassNodeIds: ["4"] }));
    expect(published().bypassNodeIds).toEqual(["4"]);

    reloadSameWorkflow();

    expect(hook.result.current.bypassedWidgetTargets.size).toBe(1);
    expect(published().bypassNodeIds).toEqual(["4"]);
  });

  it("still lets go of widget values when switching to another workflow", () => {
    const hook = mountPanel();
    hydrate(replay());

    act(() => {
      useGenerationStore.setState({
        selectedWorkflowId: "other.json",
        isWorkflowLoading: true,
        syncedWorkflow: null,
        syncedGraphData: null,
      });
    });
    act(() => {
      useGenerationStore.setState({ syncedWorkflow: WORKFLOW, syncedGraphData: {} });
    });

    expect(hook.result.current.widgetValues["136"]?.length).toBe(124);
  });

  it("restores a LoRA whose widget only appears once object info arrives", () => {
    const hook = mountPanel({ objectInfo: false });
    hydrate(replay());
    expect(hook.result.current.widgetValues["4"]).toBeUndefined();
    // Until the widget exists, its saved value is still what gets saved.
    expect(published().frontendStateWidgetValues[LORA_KEY]).toBe(
      "detail.safetensors",
    );

    act(() => {
      useGenerationStore.setState({ rawObjectInfo: OBJECT_INFO });
    });

    expect(hook.result.current.widgetValues["4"]?.lora_name).toBe(
      "detail.safetensors",
    );
    expect(hook.result.current.widgetValues["136"]?.length).toBe(311);
    expect(published().frontendStateWidgetValues[LORA_KEY]).toBe(
      "detail.safetensors",
    );
  });

  it("restores the bypass choice of a LoRA that appears late", () => {
    const hook = mountPanel({ objectInfo: false });
    hydrate(replay({ bypassNodeIds: ["4"] }));
    expect(published().bypassNodeIds).toEqual(["4"]);

    act(() => {
      useGenerationStore.setState({ rawObjectInfo: OBJECT_INFO });
    });

    expect(hook.result.current.bypassedWidgetTargets.size).toBe(1);
    expect(published().bypassNodeIds).toEqual(["4"]);
  });

  it("does not overwrite a late widget the user has since edited", () => {
    const hook = mountPanel({ objectInfo: false });
    hydrate(replay());
    act(() => {
      useGenerationStore.setState({ rawObjectInfo: OBJECT_INFO });
    });
    act(() => {
      hook.result.current.handleWidgetChange("4", "lora_name", "base.safetensors");
    });

    reloadSameWorkflow();
    act(() => {
      useGenerationStore.setState({ rawObjectInfo: { ...OBJECT_INFO } });
    });

    expect(hook.result.current.widgetValues["4"]?.lora_name).toBe(
      "base.safetensors",
    );
  });

  it("does not roll newer edits back to what a submission carried", () => {
    const hook = mountPanel();
    act(() => {
      hook.result.current.handleWidgetChange("136", "length", 311);
    });

    act(() => {
      useGenerationStore.setState({
        lastAppliedWidgetValues: {
          "136:length": "124",
          "4:lora_name": "base.safetensors",
        },
      });
    });

    expect(hook.result.current.widgetValues["136"]?.length).toBe(311);
    expect(published().frontendStateWidgetValues[LENGTH_KEY]).toBe(311);
  });

  it("shows the seed the backend picked for a randomized widget", () => {
    const hook = mountPanel();
    expect(hook.result.current.randomizeToggles["136:seed"]).toBe(true);

    act(() => {
      useGenerationStore.setState({
        lastAppliedWidgetValues: { "136:seed": "9007199254740993" },
      });
    });

    // Past Number.MAX_SAFE_INTEGER, so it stays a string rather than rounding.
    expect(hook.result.current.widgetValues["136"]?.seed).toBe(
      "9007199254740993",
    );

    act(() => {
      hook.result.current.handleToggleRandomize("136", "seed");
    });
    act(() => {
      useGenerationStore.setState({
        lastAppliedWidgetValues: { "136:seed": "42" },
      });
    });
    expect(hook.result.current.widgetValues["136"]?.seed).toBe(
      "9007199254740993",
    );
  });
});
