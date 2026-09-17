"""Aspect-ratio postprocess targets deliver through vloSaveVideo.

The save node resizes each frame while encoding, so no resized IMAGE batch is
ever held in memory. These checks pin the settings every packaged workflow
relies on: a plain bicubic stretch and a temp-folder preview save.
"""

import json
from pathlib import Path

import pytest


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
RULES_PATHS = sorted(ASSETS_DIR.glob("*/*.rules.json"))
WIDGET_ORDER = [
    "fps",
    "filename_prefix",
    "save_output",
    "width",
    "height",
    "upscale_method",
    "crop",
    "format",
    "codec",
    "crf",
    "bit_depth",
    "color_space",
]


def _postprocess(rules):
    for stage in rules.get("pipeline", []):
        postprocess = (stage.get("config") or {}).get("postprocess")
        if postprocess:
            return postprocess
    return None


POSTPROCESS_CASES = [
    pytest.param(path, id=f"{path.parent.name}/{path.name}")
    for path in RULES_PATHS
    if _postprocess(json.loads(path.read_text(encoding="utf-8")))
]


def test_postprocess_workflows_are_discovered():
    assert len(POSTPROCESS_CASES) >= 26


@pytest.mark.parametrize("rules_path", POSTPROCESS_CASES)
def test_postprocess_targets_a_preview_bicubic_save(rules_path):
    rules = json.loads(rules_path.read_text(encoding="utf-8"))
    workflow_path = rules_path.with_name(rules_path.name.replace(".rules.json", ".json"))
    workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
    nodes = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: link for link in workflow["links"]}

    # Bypassed debug previews (mode 4) may stay; no active legacy save may.
    assert not any(
        node["type"] in {"VHS_VideoCombine", "SaveVideo"} and node["mode"] != 4
        for node in workflow["nodes"]
    )

    for target in _postprocess(rules)["targets"]:
        node_id = int(target["width"]["node_id"])
        assert int(target["height"]["node_id"]) == node_id
        assert (target["width"]["param"], target["height"]["param"]) == ("width", "height")

        node = nodes[node_id]
        assert node["type"] == "vloSaveVideo"
        assert node["mode"] == 0
        values = dict(zip(WIDGET_ORDER, node["widgets_values"], strict=True))
        assert values["save_output"] is False
        assert values["upscale_method"] == "bicubic"
        assert values["crop"] == "disabled"

        by_name = {spec["name"]: spec for spec in node["inputs"]}
        assert by_name["width"]["link"] is None
        assert by_name["height"]["link"] is None
        assert by_name["images"]["link"] is not None
        for slot, spec in enumerate(node["inputs"]):
            if spec["link"] is not None:
                assert links[spec["link"]][3:5] == [node_id, slot]

    # Every link agrees with both of its endpoints.
    for link_id, origin, origin_slot, target, target_slot, _ in workflow["links"]:
        assert link_id in nodes[origin]["outputs"][origin_slot]["links"]
        assert nodes[target]["inputs"][target_slot]["link"] == link_id
