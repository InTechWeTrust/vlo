"""Shipped graph workflows must load into ComfyUI unchanged.

ComfyUI_frontend keeps node ids unique across the root graph and every
subgraph definition, and silently renumbers a subgraph node whose id is
already taken. vlo's bridge then sees a different graph from the one it
injected and fails with "did not become the active ComfyUI workflow".
"""

import json
from collections import Counter
from pathlib import Path

import pytest

CONFIG_DIR = Path(__file__).resolve().parents[1] / "assets" / ".config"
WORKFLOW_PATHS = sorted(
    path
    for mode in ("default_workflows", "high_vram_workflows")
    for path in (CONFIG_DIR / mode).rglob("*.json")
    if not path.name.endswith(".rules.json")
)


def _graph_node_ids(workflow: dict) -> list[str]:
    graphs = [workflow, *workflow.get("definitions", {}).get("subgraphs", [])]
    return [str(node["id"]) for graph in graphs for node in graph.get("nodes", [])]


@pytest.mark.parametrize(
    "path", WORKFLOW_PATHS, ids=lambda path: str(path.relative_to(CONFIG_DIR))
)
def test_node_ids_are_unique_across_root_and_subgraphs(path: Path):
    workflow = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(workflow.get("nodes"), list):
        pytest.skip("API-format workflow has no LiteGraph node ids")

    counts = Counter(_graph_node_ids(workflow))
    assert [node_id for node_id, count in counts.items() if count > 1] == []
