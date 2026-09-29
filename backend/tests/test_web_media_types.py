from __future__ import annotations

import mimetypes
from pathlib import Path

import pytest
import starlette.responses

import main
from web_media_types import guess_web_media_type


@pytest.fixture
def poisoned_host_mimetypes(monkeypatch):
    """Simulate a Windows registry that maps every extension to text/plain."""

    def poisoned_guess_type(url, strict=True):
        del url, strict
        return ("text/plain", None)

    monkeypatch.setattr(mimetypes, "guess_type", poisoned_guess_type)
    # FileResponse imported guess_type by name, so patch its binding too.
    monkeypatch.setattr(starlette.responses, "guess_type", poisoned_guess_type)


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("assets/index-abc123.js", "text/javascript"),
        ("assets/worker.mjs", "text/javascript"),
        ("assets/index-abc123.css", "text/css"),
        ("assets/decoder.wasm", "application/wasm"),
        ("vite.svg", "image/svg+xml"),
        ("index.html", "text/html"),
        (r"C:\vlo\frontend\dist\assets\INDEX.JS", "text/javascript"),
    ],
)
def test_browser_critical_types_ignore_the_host_table(
    poisoned_host_mimetypes,
    path,
    expected,
):
    assert guess_web_media_type(path) == expected


def test_unpinned_types_fall_back_to_the_host_table(monkeypatch):
    host_table = {"clip.mp4": "video/x-host-guess"}
    monkeypatch.setattr(
        mimetypes,
        "guess_type",
        lambda url, strict=True: (host_table.get(url), None),
    )

    assert guess_web_media_type("clip.mp4") == "video/x-host-guess"
    assert guess_web_media_type("no-extension") is None


def test_frontend_bundle_is_served_as_javascript_despite_host_table(
    poisoned_host_mimetypes,
    tmp_path: Path,
):
    bundle = tmp_path / "index-abc123.js"
    bundle.write_text("export {};\n", encoding="utf-8")

    response = main._frontend_file_response(bundle)

    assert response.headers["content-type"].startswith("text/javascript")
