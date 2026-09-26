"""Shared helpers for the MiniMax H3 packaged-workflow tests.

The two VRAM profiles ship the same graph against different weights of the same
checkpoints: the default profile loads the pruned int8 files and the int8 video
VAE, the high-VRAM profile the pruned bf16 ones and the fp16 video VAE. The
parity tests therefore compare the high-VRAM copy with its weight filenames
mapped back to the default ones, so any *other* drift between the profiles
still fails.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_DIRS = (
    ASSETS_DIR / "default_workflows",
    ASSETS_DIR / "high_vram_workflows",
)

# MiniMax H3 task -> (default weights, high-VRAM weights). A workflow may load
# either checkpoint, or both (inpaint runs ref2va and fl2va in one graph).
H3_DIFFUSION_WEIGHTS = {
    "fl2va": (
        "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        "minimax_h3_fl2va_pruned_bf16.safetensors",
    ),
    "ref2va": (
        "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        "minimax_h3_ref2va_pruned_bf16.safetensors",
    ),
}

# Every H3 workflow loads the video VAE: (default weights, high-VRAM weights).
H3_VIDEO_VAE_WEIGHTS = (
    "minimax_h3_video_vae_int8_convrot.safetensors",
    "minimax_h3_video_vae_fp16.safetensors",
)

# Model patches layered on the H3 checkpoint: (default weights, high-VRAM
# weights). Only workflows that load the patch are checked for it.
H3_MODEL_PATCH_WEIGHTS = (
    (
        "minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors",
        "minimax_h3_fun_controlnet_union_2.0_pruned_bf16.safetensors",
    ),
)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def assert_profiles_agree_apart_from_weights(workflow_name: str) -> None:
    """Both profiles ship this workflow, differing only in the H3 weights."""
    default_text = (WORKFLOW_DIRS[0] / workflow_name).read_text(encoding="utf-8")
    high_vram_text = (WORKFLOW_DIRS[1] / workflow_name).read_text(encoding="utf-8")

    normalized = high_vram_text
    tasks = []
    for task, (default_weights, high_vram_weights) in H3_DIFFUSION_WEIGHTS.items():
        if default_weights not in default_text:
            continue
        tasks.append(task)
        assert high_vram_weights in high_vram_text
        assert high_vram_weights not in default_text
        assert default_weights not in high_vram_text
        normalized = normalized.replace(high_vram_weights, default_weights)

    assert tasks, f"{workflow_name} loads no known MiniMax H3 checkpoint"

    default_vae, high_vram_vae = H3_VIDEO_VAE_WEIGHTS
    assert default_vae in default_text
    assert high_vram_vae in high_vram_text
    assert high_vram_vae not in default_text
    assert default_vae not in high_vram_text
    normalized = normalized.replace(high_vram_vae, default_vae)

    for default_patch, high_vram_patch in H3_MODEL_PATCH_WEIGHTS:
        if default_patch not in default_text:
            continue
        assert high_vram_patch in high_vram_text
        assert high_vram_patch not in default_text
        assert default_patch not in high_vram_text
        normalized = normalized.replace(high_vram_patch, default_patch)

    assert json.loads(normalized) == json.loads(default_text)
