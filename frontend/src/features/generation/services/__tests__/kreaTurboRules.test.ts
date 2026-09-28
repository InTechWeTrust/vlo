import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { evaluateRewrites, type RewriteRule } from "../evaluateRewrites";
import { parseInputsFromGraphData } from "../workflowBridge";
import { resolvePresentedInputs } from "../workflowRules";
import type { InputNodeMap } from "../../constants/inputNodeMap";

/**
 * Krea-2 routes the user's prompt through a TextGenerate enhancer before it
 * reaches CLIPTextEncode, so both of those nodes carry dynamic-prompt STRING
 * inputs that input discovery picks up even though they are wired. Typing
 * into either would overwrite the wire and skip the enhancer (or its system
 * prompt), so the panel must show only the two prompt primitives.
 */
const CONFIG_DIR = resolve(
  __dirname,
  "../../../../../../backend/assets/.config",
);
const MODES = ["default_workflows", "high_vram_workflows"] as const;

// What object_info discovery yields for the dynamic-prompt nodes in this graph.
const INPUT_NODE_MAP: InputNodeMap = {
  CLIPTextEncode: [{ inputType: "text", param: "text", label: "Prompt" }],
  TextGenerate: [{ inputType: "text", param: "prompt", label: "Prompt" }],
};

function load(dir: string, file: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(CONFIG_DIR, dir, file), "utf-8"),
  ) as Record<string, unknown>;
}

describe.each(MODES)("vlo_krea2_turbo in %s", (dir) => {
  const graph = load(dir, "vlo_krea2_turbo.json");
  const rules = load(dir, "vlo_krea2_turbo.rules.json");

  it("presents exactly a positive then a negative prompt", () => {
    const inferred = parseInputsFromGraphData(graph, {
      inputNodeMap: INPUT_NODE_MAP,
    });
    const { inputs, presentationWarnings } = resolvePresentedInputs(
      inferred,
      rules,
    );

    expect(presentationWarnings).toEqual([]);
    expect(
      inputs.map(({ nodeId, param, label, inputType }) => ({
        nodeId,
        param,
        label,
        inputType,
      })),
    ).toEqual([
      {
        nodeId: "30:19",
        param: "value",
        label: "Positive prompt",
        inputType: "text",
      },
      {
        nodeId: "30:54",
        param: "value",
        label: "Negative prompt",
        inputType: "text",
      },
    ]);
  });

  it("keeps the negative zeroed until it has text", () => {
    const rewrites = rules.rewrites as RewriteRule[];

    expect(evaluateRewrites(rewrites, new Set()).bypass).toEqual([]);
    expect(
      evaluateRewrites(rewrites, new Set(["30:54", "30:54:value"])).bypass,
    ).toEqual(["30:13"]);
  });
});
