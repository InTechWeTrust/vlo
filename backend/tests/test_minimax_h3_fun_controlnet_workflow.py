from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from minimax_h3_profiles import assert_profiles_agree_apart_from_weights
from services.workflow_rules.schema import ResolvedWorkflowRules


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_NAME = "vlo_minimax_h3_fun_controlnet_union.json"
RULES_NAME = "vlo_minimax_h3_fun_controlnet_union.rules.json"
WORKFLOW_DIRS = (
    ASSETS_DIR / "default_workflows",
    ASSETS_DIR / "high_vram_workflows",
)
TURBO_LORA_NODE_ID = 99
BYPASS_MODE = 4


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _node(workflow: dict[str, Any], node_id: int) -> dict[str, Any]:
    return next(node for node in workflow["nodes"] if node["id"] == node_id)


def test_fun_controlnet_workflow_is_packaged_in_both_modes():
    default_rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    high_vram_rules = _load_json(WORKFLOW_DIRS[1] / RULES_NAME)

    # The high-VRAM profile swaps in bf16 checkpoint and ControlNet weights;
    # the graph itself and the rules are shared.
    assert_profiles_agree_apart_from_weights(WORKFLOW_NAME)
    assert high_vram_rules == default_rules
    ResolvedWorkflowRules.model_validate(default_rules)


def test_fun_controlnet_workflow_loads_the_v2_controlnet():
    for workflow_dir in WORKFLOW_DIRS:
        workflow = _load_json(workflow_dir / WORKFLOW_NAME)
        (loader,) = [
            node for node in workflow["nodes"] if node["type"] == "ModelPatchLoader"
        ]
        (patch_name,) = loader["widgets_values"]
        assert patch_name.startswith("minimax_h3_fun_controlnet_union_2.0_")
        assert loader["properties"]["models"] == [
            {
                "name": patch_name,
                "url": (
                    "https://huggingface.co/Kijai/MiniMax-H3-experimental/"
                    f"resolve/main/model_patches/{patch_name}"
                ),
                "directory": "model_patches",
            }
        ]


def test_fun_controlnet_turbo_lora_starts_bypassed():
    # The loader ships bypassed so ComfyUI does not report the optional LoRA
    # missing; the rules opt it back into discovery and seed "None (bypass)".
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    lora_rule = rules["nodes"][str(TURBO_LORA_NODE_ID)]["widgets"]["lora_name"]
    assert lora_rule["discover_when_bypassed"] is True
    assert lora_rule["default_node_bypass"] is True

    for workflow_dir in WORKFLOW_DIRS:
        workflow = _load_json(workflow_dir / WORKFLOW_NAME)
        lora = _node(workflow, TURBO_LORA_NODE_ID)
        assert lora["type"] == "LoraLoaderModelOnly"
        assert lora["mode"] == BYPASS_MODE
