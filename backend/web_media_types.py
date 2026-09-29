"""Media types for the web assets the backend serves to the browser.

Python's ``mimetypes`` merges the Windows registry into its table, and
third-party software commonly rewrites entries such as ``.js`` to
``text/plain``. Browsers enforce strict MIME checks for module scripts,
stylesheets and streaming WebAssembly, so a poisoned registry leaves the app
as a blank page. These types are pinned rather than guessed.
"""

from __future__ import annotations

import mimetypes
import os

WEB_MEDIA_TYPES: dict[str, str] = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".map": "application/json",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}


def guess_web_media_type(path: str | os.PathLike[str]) -> str | None:
    """Return the pinned type for browser-critical assets, else a guess."""
    suffix = os.path.splitext(os.fspath(path))[1].lower()
    return WEB_MEDIA_TYPES.get(suffix) or mimetypes.guess_type(os.fspath(path))[0]
