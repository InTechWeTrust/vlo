import json
from pathlib import Path
from urllib.parse import urlparse

import pytest


WORKFLOW_ROOT = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_NAMES = (
    "vlo_ltx2_5.json",
    "vlo_ltx2_5_ic_edit.json",
    "vlo_ltx2_5_clean_plate.json",
    "vlo_ltx2_5_inpaint.json",
)


@pytest.mark.parametrize("profile", ("default_workflows", "high_vram_workflows"))
@pytest.mark.parametrize("workflow_name", WORKFLOW_NAMES)
def test_ltx_workflows_use_official_ltx25_models(profile: str, workflow_name: str):
    workflow = json.loads((WORKFLOW_ROOT / profile / workflow_name).read_text())
    nodes = workflow["nodes"]
    official_models = [
        (node, model)
        for node in nodes
        for model in node.get("properties", {}).get("models", [])
        if model["url"].startswith("https://huggingface.co/Lightricks/LTX-2.5/")
    ]

    expected_count = 5 if workflow_name == "vlo_ltx2_5.json" else 4
    assert len(official_models) == expected_count

    for node, model in official_models:
        assert Path(urlparse(model["url"]).path).name == model["name"]
        assert model["name"] in node["widgets_values"]

    clip_loaders = [
        node
        for node in nodes
        if node.get("properties", {}).get("Node name for S&R") == "CLIPLoader"
        and any(
            "gemma4-12b-with-proj-ltx-2.5" in model["name"]
            for model in node.get("properties", {}).get("models", [])
        )
    ]
    assert len(clip_loaders) == 1
    assert clip_loaders[0]["type"] == "CLIPLoader"
    assert clip_loaders[0]["widgets_values"][1:] == ["ltxv", "default"]


@pytest.mark.parametrize("profile", ("default_workflows", "high_vram_workflows"))
@pytest.mark.parametrize("workflow_name", WORKFLOW_NAMES)
def test_ltx_workflows_encode_prompts_without_the_prompt_enhancer(
    profile: str, workflow_name: str
):
    workflow = json.loads((WORKFLOW_ROOT / profile / workflow_name).read_text())

    # The Gemma prompt-enhancer subgraph was retired; prompts go straight into
    # CLIPTextEncode so vlo exposes them as ordinary text inputs.
    assert "definitions" not in workflow
    text_encoders = [node for node in workflow["nodes"] if node["type"] == "CLIPTextEncode"]
    assert text_encoders
    for node in text_encoders:
        text_input = next(
            (entry for entry in node.get("inputs", []) if entry["name"] == "text"),
            None,
        )
        assert text_input is None or text_input.get("link") is None
