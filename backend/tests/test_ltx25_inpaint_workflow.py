import json
from pathlib import Path

import pytest

from services import model_registry


WORKFLOW_ROOT = Path(__file__).parents[1] / "assets" / ".config"
LORA_NAME = "ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors"
LORA_REPO = "https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-In-Outpainting"


@pytest.fixture(params=["default_workflows", "high_vram_workflows"])
def workflow(request):
    return json.loads(
        (WORKFLOW_ROOT / request.param / "vlo_ltx2_5_inpaint.json").read_text()
    )


def _node(workflow, node_id):
    return next(node for node in workflow["nodes"] if node["id"] == node_id)


def _source(workflow, node_id, input_name):
    input_spec = next(
        item for item in _node(workflow, node_id)["inputs"]
        if item["name"] == input_name
    )
    link = next(link for link in workflow["links"] if link[0] == input_spec["link"])
    return tuple(link[1:3])


def test_inpaint_graph_links_are_consistent(workflow):
    nodes = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: link for link in workflow["links"]}
    assert len(nodes) == len(workflow["nodes"])
    assert len(links) == len(workflow["links"])
    assert max(nodes) <= workflow["last_node_id"]
    assert max(links) <= workflow["last_link_id"]
    for link_id, source, output, target, input_slot, _ in links.values():
        assert link_id in nodes[source]["outputs"][output]["links"]
        assert nodes[target]["inputs"][input_slot]["link"] == link_id
    for node in nodes.values():
        for slot, input_spec in enumerate(node.get("inputs", [])):
            if input_spec.get("link") is not None:
                assert links[input_spec["link"]][3:5] == [node["id"], slot]
        for slot, output_spec in enumerate(node.get("outputs", [])):
            for link_id in output_spec.get("links") or []:
                assert links[link_id][1:3] == [node["id"], slot]


def test_inpaint_guide_uses_green_frames_and_the_video_retake_mask(workflow):
    green = _node(workflow, 777)
    assert green["type"] == "EmptyImage"
    # One solid frame broadcasts over the source video's frame batch.
    assert green["widgets_values"][2:] == [1, 0x66FF00]
    for dimension, source in [("width", 750), ("height", 751)]:
        assert _source(workflow, 777, dimension) == (source, 0)
        assert _node(workflow, source)["widgets_values"] == [dimension]
    assert _node(workflow, 778)["type"] == "ImageCompositeMasked"
    assert _node(workflow, 778)["widgets_values"] == [0, 0, False]
    assert _source(workflow, 778, "destination") == (638, 0)
    assert _node(workflow, 638)["widgets_values"] == ["ref_video"]
    assert _source(workflow, 778, "source") == (777, 0)
    assert _source(workflow, 778, "mask") == (705, 0)
    assert _source(workflow, 703, "masks") == (705, 0)

    guide = _node(workflow, 779)
    assert guide["type"] == "LTXAddVideoICLoRAGuideAdvanced"
    assert guide["mode"] == 0
    assert guide["widgets_values"] == [0, 1, 1, "disabled", False, 256, 64, 1]
    assert _source(workflow, 779, "image") == (778, 0)
    assert _source(workflow, 779, "latent") == (545, 2)
    assert _source(workflow, 107, "positive") == (779, 0)
    assert _source(workflow, 107, "negative") == (779, 1)
    assert _source(workflow, 109, "video_latent") == (779, 2)
    assert _source(workflow, 569, "positive") == (576, 0)
    assert _node(workflow, 576)["widgets_values"] == ["positive"]
    assert _source(workflow, 224, "CONDITIONING") == (107, 0)


def test_inpaint_preserves_optional_audio_retake_and_raw_output(workflow):
    assert not any(
        node["type"] in {"LTXVSetAudioRefTokens", "LTXVLaplacianPyramidBlend"}
        for node in workflow["nodes"]
    )
    assert _source(workflow, 109, "audio_latent") == (758, 0)
    assert _source(workflow, 758, "on_false") == (702, 0)
    assert _source(workflow, 758, "on_true") == (757, 0)
    assert _source(workflow, 702, "masks") == (714, 0)
    assert _node(workflow, 714)["widgets_values"] == [False]
    assert _source(workflow, 527, "samples") == (569, 2)
    assert _node(workflow, 775)["type"] == "vloSaveVideo"
    assert _source(workflow, 775, "images") == (527, 0)
    assert _source(workflow, 775, "audio") == (425, 0)


def test_inpaint_lora_is_active_and_discoverable_for_download(workflow, tmp_path, monkeypatch):
    monkeypatch.setattr(model_registry, "get_comfyui_install_dir", lambda: tmp_path)
    loader = _node(workflow, 776)
    assert loader["type"] == "LTXICLoRALoaderModelOnly"
    assert loader["mode"] == 0
    assert loader["widgets_values"] == [LORA_NAME, 1]
    assert _source(workflow, 776, "model") == (474, 0)
    assert _source(workflow, 520, "model") == (776, 0)
    key = f"loras:{LORA_NAME}"
    models = model_registry.get_available_workflow_models("__temp__", workflow)
    model = next(model for model in models if model["key"] == key)
    assert model["gated"] is True
    assert model["gatedRepoUrl"] == LORA_REPO
    specs = model_registry.get_workflow_download_specs("__temp__", key, workflow)
    assert len(specs) == 1
    assert specs[0].url == f"{LORA_REPO}/resolve/main/{LORA_NAME}"
    assert Path(specs[0].dest_path) == tmp_path / "models" / "loras" / LORA_NAME
