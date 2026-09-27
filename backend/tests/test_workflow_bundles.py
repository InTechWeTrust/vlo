import asyncio
import json
import os
import re
from pathlib import Path

import pytest

from routers import comfyui
from services import workflow_bundles, workflow_modes
from services.workflow_bundles import (
    build_how_to_document,
    find_how_to,
    find_sidecar,
    find_workflow,
    iter_root_workflows,
    resolve_confined_file,
    resolve_user_write_path,
)
from services.workflow_rules import load_rules_model_for_workflow


PNG_BYTES = b"\x89PNG\r\n\x1a\n"


class DummyRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


class DummyUploadFile:
    def __init__(self, filename: str, payload: bytes):
        self.filename = filename
        self._payload = payload

    async def read(self):
        return self._payload


def _write_json(path: Path, payload: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _write_text(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _rules(name: str) -> dict:
    return {"version": 3, "name": name}


@pytest.fixture
def roots(tmp_path, monkeypatch):
    user = tmp_path / "workflows"
    packaged = tmp_path / "default_workflows"
    user.mkdir()
    packaged.mkdir()
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", user)
    monkeypatch.setattr(comfyui, "DEFAULT_WORKFLOWS_DIR", packaged)
    monkeypatch.setattr(comfyui, "get_packaged_workflows_dir", lambda: packaged)
    monkeypatch.setattr(
        comfyui, "WORKFLOW_MENU_CONFIG_PATH", tmp_path / "no_menu.json"
    )
    monkeypatch.setattr(
        comfyui, "CUSTOM_WORKFLOW_MENU_PATH", tmp_path / "no_custom_menu.json"
    )
    return user, packaged


# ---------------------------------------------------------------------------
# Loose wf.json + wf.rules.json keep working exactly as before
# ---------------------------------------------------------------------------

def test_loose_workflow_and_sidecar_resolve_without_bundles(roots):
    user, packaged = roots
    loose = _write_json(packaged / "wf.json", {})
    sidecar = _write_json(packaged / "wf.rules.json", _rules("Loose"))

    assert find_workflow([user, packaged], "wf.json") == loose
    assert find_sidecar([user, packaged], "wf.json") == sidecar
    rules, warnings = load_rules_model_for_workflow(
        user, "wf.json", fallback_dirs=[packaged]
    )
    assert warnings == []
    assert rules.name == "Loose"


def test_loose_files_win_over_bundled_copies_in_the_same_root(roots):
    user, _ = roots
    loose = _write_json(user / "wf.json", {})
    loose_sidecar = _write_json(user / "wf.rules.json", _rules("Loose"))
    _write_json(user / "bundle" / "wf.json", {})
    _write_json(user / "bundle" / "wf.rules.json", _rules("Bundled"))

    assert find_workflow([user], "wf.json") == loose
    assert find_sidecar([user], "wf.json") == loose_sidecar


def test_user_loose_sidecar_still_overrides_packaged_bundle(roots):
    user, packaged = roots
    _write_json(packaged / "bundle" / "wf.json", {})
    _write_json(packaged / "bundle" / "wf.rules.json", _rules("Packaged"))
    _write_json(user / "wf.rules.json", _rules("User"))

    rules, _ = load_rules_model_for_workflow(user, "wf.json", fallback_dirs=[packaged])
    assert rules.name == "User"


def test_list_response_for_loose_workflows_is_unchanged(roots):
    user, packaged = roots
    _write_json(packaged / "wf.json", {})
    _write_json(packaged / "wf.rules.json", _rules("Loose"))

    workflows = asyncio.run(comfyui.list_workflows())

    assert workflows == [{"id": "wf.json", "name": "Loose"}]


def test_save_and_upload_of_new_workflows_stay_loose(roots):
    user, _ = roots

    asyncio.run(comfyui.save_workflow_content("new.json", DummyRequest({"a": 1})))
    asyncio.run(
        comfyui.upload_workflow_files(
            [DummyUploadFile("new.rules.json", json.dumps(_rules("New")).encode())]
        )
    )

    assert (user / "new.json").is_file()
    assert (user / "new.rules.json").is_file()


# ---------------------------------------------------------------------------
# Bundles
# ---------------------------------------------------------------------------

def test_bundled_workflow_and_sidecar_are_found(roots):
    user, packaged = roots
    workflow = _write_json(packaged / "klein" / "wf.json", {})
    sidecar = _write_json(packaged / "klein" / "wf.rules.json", _rules("Bundled"))

    assert find_workflow([user, packaged], "wf.json") == workflow
    assert find_sidecar([user, packaged], "wf.json") == sidecar
    rules, _ = load_rules_model_for_workflow(user, "wf.json", fallback_dirs=[packaged])
    assert rules.name == "Bundled"


def test_user_loose_copy_of_bundled_workflow_keeps_packaged_rules(roots):
    # Saving from the ComfyUI editor writes a loose user copy; its rules must
    # still come from the packaged bundle, as they do for loose sidecars.
    user, packaged = roots
    _write_json(packaged / "klein" / "wf.json", {})
    _write_json(packaged / "klein" / "wf.rules.json", _rules("Bundled"))
    user_copy = _write_json(user / "wf.json", {"edited": True})

    assert find_workflow([user, packaged], "wf.json") == user_copy
    rules, _ = load_rules_model_for_workflow(user, "wf.json", fallback_dirs=[packaged])
    assert rules.name == "Bundled"


def test_underscore_hidden_dirs_and_manifest_are_not_workflows(roots):
    _, packaged = roots
    _write_json(packaged / "_shared" / "lib" / "a.json", {})
    _write_json(packaged / ".hidden" / "b.json", {})
    _write_json(packaged / "bundle" / "bundle.json", {})
    _write_json(packaged / "bundle" / "c.json", {})
    _write_json(packaged / "bundle" / "c.rules.json", _rules("C"))
    _write_json(packaged / "bundle" / "assets" / "nested.json", {})

    names = [path.name for path in iter_root_workflows(packaged)]

    assert names == ["c.json"]


def test_list_includes_bundled_workflows_once(roots):
    user, packaged = roots
    _write_json(packaged / "loose.json", {})
    _write_json(packaged / "a_bundle" / "dup.json", {})
    _write_json(packaged / "a_bundle" / "dup.rules.json", _rules("First"))
    _write_json(packaged / "b_bundle" / "dup.json", {})
    _write_json(user / "mine" / "own.json", {})

    workflows = asyncio.run(comfyui.list_workflows())

    by_id = {item["id"]: item for item in workflows}
    assert set(by_id) == {"loose.json", "dup.json", "own.json"}
    assert by_id["dup.json"]["name"] == "First"


def test_saves_and_uploads_write_back_into_the_user_bundle(roots):
    user, _ = roots
    bundled = _write_json(user / "mine" / "wf.json", {"v": 1})

    asyncio.run(comfyui.save_workflow_content("wf.json", DummyRequest({"v": 2})))
    asyncio.run(
        comfyui.upload_workflow_files(
            [DummyUploadFile("wf.rules.json", json.dumps(_rules("Up")).encode())]
        )
    )

    assert json.loads(bundled.read_text()) == {"v": 2}
    assert (user / "mine" / "wf.rules.json").is_file()
    assert not (user / "wf.json").exists()
    assert not (user / "wf.rules.json").exists()


def test_write_path_prefers_an_existing_loose_file(tmp_path):
    _write_json(tmp_path / "wf.json", {})
    _write_json(tmp_path / "mine" / "wf.json", {})

    assert resolve_user_write_path(tmp_path, "wf.json") == tmp_path / "wf.json"


# ---------------------------------------------------------------------------
# How-to discovery
# ---------------------------------------------------------------------------

def test_how_to_prefers_workflow_specific_doc_over_bundle_readme(tmp_path):
    _write_json(tmp_path / "b" / "wf.json", {})
    _write_text(tmp_path / "b" / "README.md", "readme")
    specific = _write_text(tmp_path / "b" / "wf.howto.md", "specific")

    location = find_how_to([tmp_path], "wf.json")

    assert location is not None
    assert location.document == specific
    assert location.bundle_dir == tmp_path / "b"


def test_loose_how_to_has_no_bundle(tmp_path):
    _write_json(tmp_path / "wf.json", {})
    doc = _write_text(tmp_path / "wf.howto.md", "loose")

    location = find_how_to([tmp_path], "wf.json")

    assert location == workflow_bundles.HowToLocation(document=doc, bundle_dir=None)


def test_how_to_falls_back_from_user_copy_to_packaged_bundle(roots):
    user, packaged = roots
    _write_json(packaged / "b" / "wf.json", {})
    doc = _write_text(packaged / "b" / "README.md", "packaged")
    _write_json(user / "wf.json", {})

    location = find_how_to(comfyui._how_to_roots(), "wf.json")

    assert location is not None and location.document == doc


def test_high_vram_mode_uses_default_set_how_to(tmp_path, monkeypatch):
    default = tmp_path / "default_workflows"
    high_vram = tmp_path / "high_vram_workflows"
    _write_json(default / "wf.json", {})
    doc = _write_text(default / "wf.howto.md", "shared across modes")
    _write_json(high_vram / "wf.json", {})
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path / "workflows")
    monkeypatch.setattr(comfyui, "DEFAULT_WORKFLOWS_DIR", default)
    monkeypatch.setattr(comfyui, "get_packaged_workflows_dir", lambda: high_vram)

    location = find_how_to(comfyui._how_to_roots(), "wf.json")

    assert location is not None and location.document == doc


def test_list_marks_only_workflows_with_a_how_to(roots):
    _, packaged = roots
    _write_json(packaged / "plain.json", {})
    _write_json(packaged / "b" / "documented.json", {})
    _write_text(packaged / "b" / "README.md", "# How to")

    workflows = asyncio.run(comfyui.list_workflows())

    by_id = {item["id"]: item for item in workflows}
    assert by_id["documented.json"]["has_how_to"] is True
    assert "has_how_to" not in by_id["plain.json"]


# ---------------------------------------------------------------------------
# Includes
# ---------------------------------------------------------------------------

def test_includes_resolve_shared_and_bundle_docs_with_their_own_base(tmp_path):
    bundle = tmp_path / "b"
    _write_json(bundle / "wf.json", {})
    _write_text(
        bundle / "README.md",
        'Intro\n::include{src="shared:inpainting/masks.md"}\n'
        '::include{src="docs/extra.md"}\nOutro\n',
    )
    _write_text(tmp_path / "_shared" / "inpainting" / "masks.md", "Masks ![m](m.png)\n")
    _write_text(bundle / "docs" / "extra.md", "Extra\n")
    location = find_how_to([tmp_path], "wf.json")
    assert location is not None

    fragments = build_how_to_document(location, shared_roots=[tmp_path])

    assert fragments == [
        {"kind": "markdown", "markdown": "Intro\n", "base": "bundle:"},
        {"kind": "markdown", "markdown": "Masks ![m](m.png)\n", "base": "shared:inpainting/"},
        {"kind": "markdown", "markdown": "Extra\n", "base": "bundle:docs/"},
        {"kind": "markdown", "markdown": "Outro\n", "base": "bundle:"},
    ]


def test_user_shared_library_overrides_packaged(tmp_path):
    user = tmp_path / "user"
    packaged = tmp_path / "packaged"
    _write_json(packaged / "wf.json", {})
    _write_text(packaged / "wf.howto.md", '::include{src="shared:lib/a.md"}\n')
    _write_text(packaged / "_shared" / "lib" / "a.md", "packaged\n")
    _write_text(user / "_shared" / "lib" / "a.md", "user\n")
    location = find_how_to([user, packaged], "wf.json")
    assert location is not None

    fragments = build_how_to_document(location, shared_roots=[user, packaged])

    assert fragments[0]["markdown"] == "user\n"


def test_missing_nested_and_escaping_includes_become_placeholders(tmp_path):
    _write_json(tmp_path / "b" / "wf.json", {})
    _write_text(
        tmp_path / "b" / "README.md",
        '::include{src="shared:lib/outer.md"}\n'
        '::include{src="shared:lib/absent.md"}\n'
        '::include{src="../escape.md"}\n'
        '::include{src="shared:lib/image.png"}\n',
    )
    _write_text(tmp_path / "escape.md", "outside\n")
    _write_text(
        tmp_path / "_shared" / "lib" / "outer.md",
        'Outer\n::include{src="inner.md"}\n',
    )
    _write_text(tmp_path / "_shared" / "lib" / "inner.md", "Inner\n")
    (tmp_path / "_shared" / "lib" / "image.png").write_bytes(PNG_BYTES)
    location = find_how_to([tmp_path], "wf.json")
    assert location is not None

    fragments = build_how_to_document(location, shared_roots=[tmp_path])

    assert fragments == [
        {"kind": "markdown", "markdown": "Outer\n", "base": "shared:lib/"},
        {"kind": "missing", "src": "inner.md", "reason": "nested_include"},
        {"kind": "missing", "src": "shared:lib/absent.md", "reason": "not_found"},
        {"kind": "missing", "src": "../escape.md", "reason": "not_found"},
        {"kind": "missing", "src": "shared:lib/image.png", "reason": "not_found"},
    ]


def test_include_directives_inside_code_fences_stay_text(tmp_path):
    _write_json(tmp_path / "b" / "wf.json", {})
    text = '```md\n::include{src="shared:lib/a.md"}\n```\n'
    _write_text(tmp_path / "b" / "README.md", text)
    location = find_how_to([tmp_path], "wf.json")
    assert location is not None

    fragments = build_how_to_document(location, shared_roots=[tmp_path])

    assert fragments == [{"kind": "markdown", "markdown": text, "base": "bundle:"}]


def test_loose_how_to_cannot_include_relative_docs(tmp_path):
    _write_json(tmp_path / "wf.json", {})
    _write_text(tmp_path / "wf.howto.md", '::include{src="other.howto.md"}\n')
    _write_text(tmp_path / "other.howto.md", "other\n")
    location = find_how_to([tmp_path], "wf.json")
    assert location is not None

    fragments = build_how_to_document(location, shared_roots=[tmp_path])

    assert fragments == [
        {"kind": "missing", "src": "other.howto.md", "reason": "not_found"}
    ]


# ---------------------------------------------------------------------------
# Confinement and endpoints
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "ref",
    ["../x.png", "/etc/passwd", "a\\b.png", ".hidden/x.png", "a//b.png", "", "c:x.png"],
)
def test_unsafe_refs_are_rejected(tmp_path, ref):
    assert resolve_confined_file(tmp_path, ref) is None


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlinks unsupported")
def test_symlink_escaping_the_bundle_is_rejected(tmp_path):
    outside = tmp_path / "secret.png"
    outside.write_bytes(PNG_BYTES)
    bundle = tmp_path / "b"
    bundle.mkdir()
    (bundle / "link.png").symlink_to(outside)

    assert resolve_confined_file(bundle, "link.png") is None


def test_how_to_endpoint_returns_fragments_and_404s(roots):
    _, packaged = roots
    _write_json(packaged / "b" / "wf.json", {})
    _write_text(packaged / "b" / "README.md", "# Hello\n")
    _write_json(packaged / "plain.json", {})

    found = asyncio.run(comfyui.get_workflow_how_to("wf.json"))
    missing = asyncio.run(comfyui.get_workflow_how_to("plain.json"))
    unsafe = asyncio.run(comfyui.get_workflow_how_to("../wf.json"))

    assert found == {
        "workflow_id": "wf.json",
        "fragments": [{"kind": "markdown", "markdown": "# Hello\n", "base": "bundle:"}],
    }
    assert missing.status_code == 404
    assert unsafe.status_code == 400


def test_asset_endpoints_serve_allowlisted_media_only(roots):
    _, packaged = roots
    _write_json(packaged / "b" / "wf.json", {})
    _write_text(packaged / "b" / "README.md", "doc")
    (packaged / "b" / "assets").mkdir()
    (packaged / "b" / "assets" / "shot.png").write_bytes(PNG_BYTES)
    _write_json(packaged / "b" / "assets" / "data.json", {})
    _write_text(packaged / "b" / "assets" / "vector.svg", "<svg/>")
    (packaged / "_shared" / "lib").mkdir(parents=True)
    (packaged / "_shared" / "lib" / "clip.webm").write_bytes(b"webm")

    image = asyncio.run(comfyui.get_workflow_how_to_asset("wf.json", "assets/shot.png"))
    shared = asyncio.run(comfyui.get_workflow_shared_asset("lib/clip.webm"))
    json_asset = asyncio.run(
        comfyui.get_workflow_how_to_asset("wf.json", "assets/data.json")
    )
    svg_asset = asyncio.run(
        comfyui.get_workflow_how_to_asset("wf.json", "assets/vector.svg")
    )
    escape = asyncio.run(comfyui.get_workflow_how_to_asset("wf.json", "../wf.json"))
    workflow_file = asyncio.run(comfyui.get_workflow_shared_asset("../b/README.md"))

    assert image.media_type == "image/png"
    assert image.headers["x-content-type-options"] == "nosniff"
    assert Path(image.path).name == "shot.png"
    assert shared.media_type == "video/webm"
    for response in (json_asset, svg_asset, escape, workflow_file):
        assert response.status_code == 404


def test_loose_how_to_has_no_bundle_assets(roots):
    _, packaged = roots
    _write_json(packaged / "wf.json", {})
    _write_text(packaged / "wf.howto.md", "doc")
    (packaged / "shot.png").write_bytes(PNG_BYTES)

    response = asyncio.run(comfyui.get_workflow_how_to_asset("wf.json", "shot.png"))

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Packaged how-tos stay intact
# ---------------------------------------------------------------------------

_IMAGE_REF = re.compile(r"!\[[^\]]*\]\(([^)\s]+)")


def _packaged_how_to_workflow_ids() -> list[str]:
    default = workflow_modes.DEFAULT_WORKFLOWS_DIR
    return sorted(
        path.name
        for path in iter_root_workflows(default)
        if find_how_to([default], path.name) is not None
    )


def test_packaged_workflows_ship_how_tos():
    assert {
        "vlo_VACE_inpaint.json",
        "vlo_ltx2_5_inpaint.json",
        "vlo_minimax_h3_inpaint.json",
        "vlo_minimax_h3_inpaint_flf2va.json",
        "vlo_minimax_h3_ttm.json",
        "vlo_minimax_h3_i2v.json",
        "vlo_minimax_h3_masked_guide.json",
        "vlo_minimax_h3_r2v.json",
        "vlo_minimax_h3_fun_controlnet_union.json",
    } <= set(_packaged_how_to_workflow_ids())


@pytest.mark.parametrize(
    "packaged_dir",
    [workflow_modes.DEFAULT_WORKFLOWS_DIR, workflow_modes.HIGH_VRAM_WORKFLOWS_DIR],
    ids=["default", "high_vram"],
)
@pytest.mark.parametrize("workflow_id", _packaged_how_to_workflow_ids())
def test_packaged_how_tos_resolve_every_include_and_image(
    tmp_path, monkeypatch, packaged_dir, workflow_id
):
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path / "workflows")
    monkeypatch.setattr(
        comfyui, "DEFAULT_WORKFLOWS_DIR", workflow_modes.DEFAULT_WORKFLOWS_DIR
    )
    monkeypatch.setattr(comfyui, "get_packaged_workflows_dir", lambda: packaged_dir)

    document = asyncio.run(comfyui.get_workflow_how_to(workflow_id))

    fragments = document["fragments"]
    assert [f for f in fragments if f["kind"] == "missing"] == []
    for fragment in fragments:
        base = fragment["base"]
        for ref in _IMAGE_REF.findall(fragment["markdown"]):
            if ref.startswith("shared:"):
                scope, path = "shared", ref[len("shared:"):]
            else:
                assert base is not None, f"{workflow_id}: {ref} needs a bundle"
                scope, directory = base.split(":", 1)
                path = f"{directory}{ref}"
            response = asyncio.run(
                comfyui.get_workflow_shared_asset(path)
                if scope == "shared"
                else comfyui.get_workflow_how_to_asset(workflow_id, path)
            )
            assert response.status_code == 200, ref
            assert response.media_type is not None, ref
