import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkflowWidgetInput } from "../../types";
import { buildGenerationNodeCatalogue } from "../../services/workflowNodeCatalogue";
import { resolveWidgetInputs } from "../../services/workflowRules";
import {
  LORA_BYPASS_CHOICE,
  LORA_LOADERS_SECTION_ID,
  collectBypassDiscoveryDiagnostics,
  collectBypassDiscoveryNodeIds,
  mergeAutodiscoveredLoraWidgetInputs,
  resolveAutodiscoveredLoraWidgetInputs,
} from "../loraLoaderWidgets";
import type { WorkflowRules } from "../../services/workflowRules";

const LORA_OBJECT_INFO = {
  LoraLoaderModelOnly: {
    input: {
      required: {
        model: ["MODEL"],
        lora_name: [["base.safetensors", "detail.safetensors"], {}],
        strength_model: ["FLOAT", { default: 1 }],
      },
    },
    input_order: {
      required: ["model", "lora_name", "strength_model"],
    },
  },
};

function discoverLoraWidgets(
  workflow: Record<string, unknown> | null,
  objectInfo: Record<string, unknown> | null,
  graphData: Record<string, unknown> | null,
  bypassDiscoveryNodeIds?: ReadonlySet<string>,
) {
  return resolveAutodiscoveredLoraWidgetInputs(
    buildGenerationNodeCatalogue(workflow, objectInfo, graphData),
    bypassDiscoveryNodeIds,
  );
}

const OPTIONAL_LORA_WORKFLOW = {
  "4": {
    class_type: "LoraLoaderModelOnly",
    inputs: { lora_name: "detail.safetensors", strength_model: 1 },
    _meta: { title: "Optional detail" },
  },
};

function optionalLoraGraph(mode: number) {
  return {
    nodes: [
      {
        id: 4,
        type: "LoraLoaderModelOnly",
        title: "Optional detail",
        mode,
        widgets_values: ["detail.safetensors", 1],
      },
    ],
  };
}

function rulesWithBypassDiscovery(nodeId: string): WorkflowRules {
  return {
    nodes: {
      [nodeId]: {
        widgets: { lora_name: { discover_when_bypassed: true } },
      },
    },
  } as unknown as WorkflowRules;
}

describe("autodiscovered LoRA widget inputs", () => {
  it("creates ordinary widget inputs for active root and scoped loaders", () => {
    const subgraphId = "lora-definition";
    const widgets = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoaderModelOnly",
          inputs: {
            model: ["1", 0],
            lora_name: "detail.safetensors",
            strength_model: 0.8,
          },
          _meta: { title: "Portrait detail" },
        },
      },
      LORA_OBJECT_INFO,
      {
        nodes: [
          {
            id: 4,
            type: "LoraLoaderModelOnly",
            title: "Portrait detail",
            widgets_values: ["detail.safetensors", 0.8],
          },
          { id: 12, type: subgraphId, inputs: [] },
        ],
        definitions: {
          subgraphs: [
            {
              id: subgraphId,
              name: "Nested LoRA",
              inputs: [],
              nodes: [
                {
                  id: 6,
                  type: "LoraLoaderModelOnly",
                  widgets_values: ["base.safetensors", 1],
                },
              ],
              links: [],
            },
          ],
        },
      },
    );

    expect(
      widgets.map((widget) => [widget.nodeId, widget.param]),
    ).toEqual([
      ["4", "lora_name"],
      ["4", "strength_model"],
      ["12:6", "lora_name"],
      ["12:6", "strength_model"],
    ]);
    expect(widgets[0]).toMatchObject({
      param: "lora_name",
      currentValue: "detail.safetensors",
      config: {
        label: "Model",
        groupTitle: "Portrait detail",
        sectionId: LORA_LOADERS_SECTION_ID,
        options: ["base.safetensors", "detail.safetensors"],
        nodeBypassOption: {
          value: LORA_BYPASS_CHOICE,
          label: "None (bypass)",
        },
      },
    });
  });

  it("presents each loader's weight beside its model, with no bypass choice", () => {
    const [, strength] = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoaderModelOnly",
          inputs: {
            model: ["1", 0],
            lora_name: "detail.safetensors",
            strength_model: 0.8,
          },
          _meta: { title: "Portrait detail" },
        },
      },
      {
        LoraLoaderModelOnly: {
          input: {
            required: {
              model: ["MODEL"],
              lora_name: [["base.safetensors", "detail.safetensors"], {}],
              strength_model: [
                "FLOAT",
                { default: 1, min: -100, max: 100, step: 0.01 },
              ],
            },
          },
        },
      },
      null,
    );

    expect(strength).toMatchObject({
      nodeId: "4",
      param: "strength_model",
      currentValue: 0.8,
      config: {
        label: "Strength",
        valueType: "float",
        defaultValue: 1,
        min: -100,
        max: 100,
        step: 0.01,
        sectionId: LORA_LOADERS_SECTION_ID,
        // Same group as the dropdown, so the panel renders one loader block.
        groupId: "lora-loader:4",
      },
    });
    // Bypassing is the dropdown's job; a second "None" would be ambiguous.
    expect(strength?.config.nodeBypassOption).toBeUndefined();
  });

  it("labels both weights apart on loaders that carry a CLIP strength", () => {
    const widgets = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoader",
          inputs: {
            lora_name: "base.safetensors",
            strength_model: 1,
            strength_clip: 0.5,
          },
        },
      },
      {
        LoraLoader: {
          input: {
            required: {
              lora_name: [["base.safetensors"], {}],
              strength_model: ["FLOAT", { default: 1 }],
              strength_clip: ["FLOAT", { default: 1 }],
            },
          },
        },
      },
      null,
    );

    expect(
      widgets.map((widget) => [widget.param, widget.config.label]),
    ).toEqual([
      ["lora_name", "Model"],
      ["strength_model", "Model strength"],
      ["strength_clip", "CLIP strength"],
    ]);
  });

  it("skips a weight the graph feeds from a link", () => {
    const widgets = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: "base.safetensors", strength_model: ["9", 0] },
        },
      },
      LORA_OBJECT_INFO,
      null,
    );

    expect(widgets.map((widget) => widget.param)).toEqual(["lora_name"]);
  });

  it("skips linked, muted, and non-LoRA nodes", () => {
    const widgets = discoverLoraWidgets(
      {
        linked: {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: ["upstream", 0] },
        },
        muted: {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: "base.safetensors" },
        },
        other: {
          class_type: "CheckpointLoaderSimple",
          inputs: { ckpt_name: "model.safetensors" },
        },
      },
      LORA_OBJECT_INFO,
      {
        nodes: [
          {
            id: "linked",
            type: "LoraLoaderModelOnly",
            inputs: [{ name: "lora_name", link: 1 }],
            widgets_values: ["base.safetensors", 1],
          },
          {
            id: "muted",
            type: "LoraLoaderModelOnly",
            mode: 2,
            widgets_values: ["base.safetensors", 1],
          },
          { id: "other", type: "CheckpointLoaderSimple" },
        ],
      },
    );

    expect(widgets).toEqual([]);
  });

  it("preserves an unavailable workflow model instead of clamping to the first installed model", () => {
    const widgets = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: "missing.safetensors" },
        },
      },
      LORA_OBJECT_INFO,
      null,
    );

    expect(widgets[0]).toMatchObject({
      currentValue: "missing.safetensors",
      config: {
        options: ["base.safetensors", "detail.safetensors"],
      },
    });
  });

  it("lends the runtime enum to a sidecar that only labels the widget", () => {
    // `options` is the user's installed LoRA files, which no sidecar author can
    // state. Without inheritance a minimal entry renders as a text box.
    const explicit: WorkflowWidgetInput = {
      nodeId: "4",
      param: "lora_name",
      currentValue: "base.safetensors",
      config: { label: "Style adapter", controlAfterGenerate: false },
    };
    const discovered = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: "base.safetensors" },
        },
      },
      LORA_OBJECT_INFO,
      null,
    );

    const [merged] = mergeAutodiscoveredLoraWidgetInputs([explicit], discovered);
    expect(merged?.config.valueType).toBe("enum");
    expect(merged?.config.options).toEqual([
      "base.safetensors",
      "detail.safetensors",
    ]);
    expect(merged?.config.label).toBe("Style adapter");
  });

  it("lets a sidecar that states its own enum win", () => {
    const explicit: WorkflowWidgetInput = {
      nodeId: "4",
      param: "lora_name",
      currentValue: "base.safetensors",
      config: {
        label: "Style adapter",
        controlAfterGenerate: false,
        valueType: "enum",
        options: ["base.safetensors"],
      },
    };
    const discovered = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: "base.safetensors" },
        },
      },
      LORA_OBJECT_INFO,
      null,
    );

    const [merged] = mergeAutodiscoveredLoraWidgetInputs([explicit], discovered);
    expect(merged?.config.options).toEqual(["base.safetensors"]);
  });

  it("keeps a sidecar's default_node_bypass alongside the injected choice", () => {
    const explicit: WorkflowWidgetInput = {
      nodeId: "4",
      param: "lora_name",
      currentValue: "base.safetensors",
      config: {
        label: "Style adapter",
        controlAfterGenerate: false,
        valueType: "enum",
        options: ["base.safetensors", "detail.safetensors"],
        defaultNodeBypass: true,
      },
    };
    const discovered = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: "base.safetensors" },
        },
      },
      LORA_OBJECT_INFO,
      null,
    );

    const [merged] = mergeAutodiscoveredLoraWidgetInputs([explicit], discovered);
    expect(merged?.config.defaultNodeBypass).toBe(true);
    expect(merged?.config.nodeBypassOption?.value).toBe(LORA_BYPASS_CHOICE);
  });

  it("enhances an explicitly presented widget without replacing its metadata", () => {
    const explicit: WorkflowWidgetInput = {
      nodeId: "4",
      param: "lora_name",
      currentValue: "base.safetensors",
      config: {
        label: "Style adapter",
        controlAfterGenerate: false,
        valueType: "enum",
        options: ["base.safetensors", "detail.safetensors"],
        sectionId: "models",
        groupTitle: "Custom models",
      },
    };
    const discovered = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: "base.safetensors" },
        },
      },
      LORA_OBJECT_INFO,
      null,
    );

    const [model, strength] = mergeAutodiscoveredLoraWidgetInputs(
      [explicit],
      discovered,
    );
    expect(model).toEqual({
      ...explicit,
      config: {
        ...explicit.config,
        nodeBypassOption: {
          value: LORA_BYPASS_CHOICE,
          label: "None (bypass)",
        },
        nodeShipsBypassed: undefined,
        defaultNodeBypass: undefined,
      },
    });
    // The weight follows the dropdown's placement rather than opening a
    // second block off in the LoRA section.
    expect(strength).toMatchObject({
      param: "strength_model",
      config: {
        sectionId: "models",
        groupId: "4",
        groupTitle: "Custom models",
      },
    });
  });

  it("keeps a sidecar's own strength widget exactly as written", () => {
    const explicit: readonly WorkflowWidgetInput[] = [
      {
        nodeId: "4",
        param: "lora_name",
        currentValue: "base.safetensors",
        config: { label: "Style adapter", controlAfterGenerate: false },
      },
      {
        nodeId: "4",
        param: "strength_model",
        currentValue: 0.6,
        config: {
          label: "Intensity",
          controlAfterGenerate: false,
          valueType: "float",
          control: "slider",
          min: 0,
          max: 2,
          step: 0.05,
        },
      },
    ];
    const discovered = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: "base.safetensors", strength_model: 0.6 },
        },
      },
      LORA_OBJECT_INFO,
      null,
    );

    const merged = mergeAutodiscoveredLoraWidgetInputs(explicit, discovered);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toEqual(explicit[1]);
  });

  it("keeps a hidden loader hidden, weight included", () => {
    const explicit: WorkflowWidgetInput = {
      nodeId: "4",
      param: "lora_name",
      currentValue: "base.safetensors",
      config: {
        label: "Style adapter",
        controlAfterGenerate: false,
        hidden: true,
      },
    };
    const discovered = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: "base.safetensors", strength_model: 1 },
        },
      },
      LORA_OBJECT_INFO,
      null,
    );

    const [, strength] = mergeAutodiscoveredLoraWidgetInputs(
      [explicit],
      discovered,
    );
    expect(strength?.config.hidden).toBe(true);
  });
});

describe("loaders the workflow ships bypassed", () => {
  it("stays hidden without a rule opting the node in", () => {
    expect(
      discoverLoraWidgets(
        OPTIONAL_LORA_WORKFLOW,
        LORA_OBJECT_INFO,
        optionalLoraGraph(4),
      ),
    ).toEqual([]);
  });

  it("surfaces an opted-in loader, off by default", () => {
    const [widget] = discoverLoraWidgets(
      OPTIONAL_LORA_WORKFLOW,
      LORA_OBJECT_INFO,
      optionalLoraGraph(4),
      collectBypassDiscoveryNodeIds(rulesWithBypassDiscovery("4")),
    );

    expect(widget?.config).toMatchObject({
      sectionId: LORA_LOADERS_SECTION_ID,
      nodeBypassOption: { value: LORA_BYPASS_CHOICE },
      nodeShipsBypassed: true,
      // The panel opens on "None" whatever stale filename the file carries.
      defaultNodeBypass: true,
    });
    expect(widget?.config.options).toEqual([
      "base.safetensors",
      "detail.safetensors",
    ]);
  });

  it("leaves an opted-in loader that ships active exactly as before", () => {
    const [widget] = discoverLoraWidgets(
      OPTIONAL_LORA_WORKFLOW,
      LORA_OBJECT_INFO,
      optionalLoraGraph(0),
      collectBypassDiscoveryNodeIds(rulesWithBypassDiscovery("4")),
    );

    expect(widget?.config.nodeShipsBypassed).toBeUndefined();
    expect(widget?.config.defaultNodeBypass).toBeUndefined();
  });

  it("never reaches a muted node, whose outputs are gone either way", () => {
    expect(
      discoverLoraWidgets(
        OPTIONAL_LORA_WORKFLOW,
        LORA_OBJECT_INFO,
        optionalLoraGraph(2),
        collectBypassDiscoveryNodeIds(rulesWithBypassDiscovery("4")),
      ),
    ).toEqual([]);
  });

  it("reports an opt-in the workflow was re-saved out of", () => {
    const nodes = buildGenerationNodeCatalogue(
      OPTIONAL_LORA_WORKFLOW,
      LORA_OBJECT_INFO,
      optionalLoraGraph(0),
    );
    const optedIn = collectBypassDiscoveryNodeIds(
      rulesWithBypassDiscovery("4"),
    );

    expect(collectBypassDiscoveryDiagnostics(nodes, optedIn)).toEqual([
      expect.stringContaining("ships active"),
    ]);
  });

  it("says nothing while the node still ships bypassed", () => {
    const nodes = buildGenerationNodeCatalogue(
      OPTIONAL_LORA_WORKFLOW,
      LORA_OBJECT_INFO,
      optionalLoraGraph(4),
    );

    expect(
      collectBypassDiscoveryDiagnostics(
        nodes,
        collectBypassDiscoveryNodeIds(rulesWithBypassDiscovery("4")),
      ),
    ).toEqual([]);
  });
});

/**
 * The shipped MiniMax workflows present `lora_name` themselves, so their
 * strength widget only exists through the merge — and only lands beside the
 * dropdown if it adopts the sidecar's section and group.
 */
describe("shipped MiniMax LoRA loaders", () => {
  const CONFIG_DIR = resolve(
    __dirname,
    "../../../../../../backend/assets/.config",
  );
  const SHIPPED = [
    ["vlo_minimax_h3_i2v", "150"],
    ["vlo_minimax_h3_r2v", "148"],
    ["vlo_minimax_h3_ttm", "23"],
  ] as const;

  // object_info is runtime data; only the loader's shape matters here.
  const OBJECT_INFO = {
    LoraLoaderModelOnly: {
      input: {
        required: {
          model: ["MODEL"],
          lora_name: [["base.safetensors"], {}],
          strength_model: [
            "FLOAT",
            { default: 1, min: -100, max: 100, step: 0.01 },
          ],
        },
      },
      input_order: { required: ["model", "lora_name", "strength_model"] },
    },
  };

  it.each(SHIPPED)(
    "gives %s's loader a weight beside its model",
    (name, nodeId) => {
      const dir = resolve(CONFIG_DIR, "default_workflows");
      const graphData = JSON.parse(
        readFileSync(resolve(dir, `${name}.json`), "utf-8"),
      ) as Record<string, unknown>;
      const rules = JSON.parse(
        readFileSync(resolve(dir, `${name}.rules.json`), "utf-8"),
      ) as Record<string, unknown>;

      const widgets = mergeAutodiscoveredLoraWidgetInputs(
        resolveWidgetInputs(null, rules, { graphData, objectInfo: OBJECT_INFO }),
        resolveAutodiscoveredLoraWidgetInputs(
          buildGenerationNodeCatalogue(null, OBJECT_INFO, graphData),
          collectBypassDiscoveryNodeIds(rules as unknown as WorkflowRules),
        ),
      );

      const model = widgets.find(
        (widget) => widget.nodeId === nodeId && widget.param === "lora_name",
      );
      const strength = widgets.find(
        (widget) =>
          widget.nodeId === nodeId && widget.param === "strength_model",
      );
      expect(model?.config.sectionId).toBe(LORA_LOADERS_SECTION_ID);
      expect(strength?.config.label).toBe("Strength");
      // Same section and group as the dropdown: one loader block, not two.
      expect(strength?.config.sectionId).toBe(model?.config.sectionId);
      expect(strength?.config.groupId).toBe(model?.config.groupId);
    },
  );
});
