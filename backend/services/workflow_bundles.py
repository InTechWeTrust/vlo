"""Workflow discovery across loose files and bundle folders.

A workflows root holds two shapes side by side:

- **Loose** workflows: ``wf.json`` with an optional ``wf.rules.json`` sidecar
  directly in the root. This is the original layout and is always checked
  first, so a root without bundle folders behaves exactly as it did before
  bundles existed.
- **Bundles**: any direct subfolder (not starting with ``_`` or ``.``) whose
  top-level ``*.json`` files are workflows. A bundle keeps a workflow, its
  sidecar, its how-to document and its assets together so the folder can be
  shared as a unit. The workflow id stays the bare filename, so moving a
  workflow into a bundle never changes persisted ids.

``_shared/`` in a root holds libraries any how-to may reference with a
``shared:`` prefix (e.g. ``shared:inpainting/mask-inputs.md``).

Every lookup takes its roots explicitly so callers keep ownership of the
user-then-packaged precedence (and tests can patch the directories).
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

logger = logging.getLogger(__name__)

SHARED_DIR_NAME = "_shared"
# Reserved for a future bundle manifest so it is never listed as a workflow.
BUNDLE_MANIFEST_NAME = "bundle.json"
RULES_SUFFIX = ".rules.json"
HOW_TO_SUFFIX = ".howto.md"
BUNDLE_HOW_TO_NAME = "README.md"
SHARED_REF_PREFIX = "shared:"

# Media a how-to may embed. SVG is excluded because it can carry script.
ASSET_CONTENT_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
}

_INCLUDE_LINE = re.compile(r'^\s*::include\{src="([^"]+)"\}\s*$')
_FENCE_LINE = re.compile(r"^\s*(`{3,}|~{3,})")


# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------

def sidecar_name_for_workflow(workflow_filename: str) -> str:
    workflow_path = Path(workflow_filename)
    if workflow_path.suffix.lower() == ".json":
        return f"{workflow_path.stem}{RULES_SUFFIX}"
    return f"{workflow_path.name}{RULES_SUFFIX}"


def how_to_name_for_workflow(workflow_filename: str) -> str:
    workflow_path = Path(workflow_filename)
    if workflow_path.suffix.lower() == ".json":
        return f"{workflow_path.stem}{HOW_TO_SUFFIX}"
    return f"{workflow_path.name}{HOW_TO_SUFFIX}"


def workflow_id_for_sidecar(sidecar_filename: str) -> str:
    stem = sidecar_filename[: -len(RULES_SUFFIX)]
    return stem if stem.lower().endswith(".json") else f"{stem}.json"


def _is_bundle_workflow_filename(name: str) -> bool:
    lowered = name.lower()
    return (
        lowered.endswith(".json")
        and not lowered.endswith(RULES_SUFFIX)
        and name != BUNDLE_MANIFEST_NAME
    )


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

def iter_bundle_dirs(root: Path) -> list[Path]:
    """Bundle folders directly under ``root``, in deterministic order."""
    if not root.is_dir():
        return []
    return sorted(
        (
            child
            for child in root.iterdir()
            if child.is_dir() and not child.name.startswith(("_", "."))
        ),
        key=lambda child: child.name,
    )


def iter_root_workflows(root: Path) -> Iterator[Path]:
    """Every workflow file in ``root``: loose files first, then bundles.

    Loose discovery is kept identical to the pre-bundle listing (every
    non-sidecar ``*.json`` in the root).
    """
    if not root.exists():
        return
    for path in root.glob("*.json"):
        if path.name.endswith(RULES_SUFFIX):
            continue
        yield path
    for bundle_dir in iter_bundle_dirs(root):
        for path in sorted(bundle_dir.glob("*.json"), key=lambda p: p.name):
            if _is_bundle_workflow_filename(path.name):
                yield path


def _find_in_bundles(root: Path, workflow_id: str) -> Path | None:
    matches = [
        bundle_dir / workflow_id
        for bundle_dir in iter_bundle_dirs(root)
        if (bundle_dir / workflow_id).is_file()
    ]
    if len(matches) > 1:
        logger.warning(
            "[workflow_bundles] %s appears in several bundles under %s; using %s",
            workflow_id,
            root,
            matches[0].parent.name,
        )
    return matches[0] if matches else None


def find_workflow_in_root(root: Path, workflow_id: str) -> Path | None:
    loose = root / workflow_id
    if loose.exists():
        return loose
    if not _is_bundle_workflow_filename(workflow_id):
        return None
    return _find_in_bundles(root, workflow_id)


def find_workflow(roots: Sequence[Path], workflow_id: str) -> Path | None:
    for root in roots:
        path = find_workflow_in_root(root, workflow_id)
        if path is not None:
            return path
    return None


def find_sidecar_in_root(root: Path, workflow_id: str) -> Path | None:
    loose = root / sidecar_name_for_workflow(workflow_id)
    if loose.exists():
        return loose
    bundled_workflow = _find_in_bundles(root, workflow_id)
    if bundled_workflow is None:
        return None
    candidate = bundled_workflow.parent / sidecar_name_for_workflow(workflow_id)
    return candidate if candidate.exists() else None


def find_sidecar(roots: Sequence[Path], workflow_id: str) -> Path | None:
    for root in roots:
        path = find_sidecar_in_root(root, workflow_id)
        if path is not None:
            return path
    return None


def resolve_user_write_path(root: Path, filename: str) -> Path:
    """Where a save or upload of ``filename`` into ``root`` should land.

    An existing loose file is overwritten in place; a workflow (or sidecar)
    that already lives in a bundle is written back into that bundle; anything
    else is written loose, as before bundles existed.
    """
    loose = root / filename
    if loose.exists():
        return loose
    workflow_id = (
        workflow_id_for_sidecar(filename)
        if filename.lower().endswith(RULES_SUFFIX)
        else filename
    )
    bundled_workflow = _find_in_bundles(root, workflow_id)
    if bundled_workflow is not None:
        return bundled_workflow.parent / filename
    return loose


# ---------------------------------------------------------------------------
# Path confinement
# ---------------------------------------------------------------------------

def normalize_relative_ref(ref: str) -> PurePosixPath | None:
    """A safe relative path, or ``None`` for anything that could escape."""
    if not ref or "\\" in ref or "\x00" in ref or ref.startswith("/"):
        return None
    parts = ref.split("/")
    if any(part in ("", ".", "..") or part.startswith(".") for part in parts):
        return None
    if ":" in parts[0]:
        return None
    return PurePosixPath(*parts)


def resolve_confined_file(base_dir: Path, ref: str) -> Path | None:
    relative = normalize_relative_ref(ref)
    if relative is None or not base_dir.is_dir():
        return None
    base_resolved = base_dir.resolve()
    candidate = (base_dir / relative).resolve()
    # resolve() follows symlinks, so a link pointing outside is rejected too.
    if not candidate.is_relative_to(base_resolved) or not candidate.is_file():
        return None
    return candidate


def asset_content_type(path: Path) -> str | None:
    return ASSET_CONTENT_TYPES.get(path.suffix.lower())


def resolve_shared_file(roots: Sequence[Path], ref: str) -> Path | None:
    """First match for a ``_shared``-relative ref, user roots before packaged."""
    for root in roots:
        path = resolve_confined_file(root / SHARED_DIR_NAME, ref)
        if path is not None:
            return path
    return None


# ---------------------------------------------------------------------------
# How-to documents
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class HowToLocation:
    document: Path
    # ``None`` for a loose ``<stem>.howto.md``: it may use ``shared:`` refs but
    # has no bundle of its own to resolve relative assets against.
    bundle_dir: Path | None


def find_how_to(roots: Sequence[Path], workflow_id: str) -> HowToLocation | None:
    how_to_name = how_to_name_for_workflow(workflow_id)
    for root in roots:
        loose = root / how_to_name
        if loose.is_file():
            return HowToLocation(document=loose, bundle_dir=None)
        bundled_workflow = _find_in_bundles(root, workflow_id)
        if bundled_workflow is None:
            continue
        bundle_dir = bundled_workflow.parent
        for name in (how_to_name, BUNDLE_HOW_TO_NAME):
            candidate = bundle_dir / name
            if candidate.is_file():
                return HowToLocation(document=candidate, bundle_dir=bundle_dir)
    return None


def _markdown_fragment(markdown: str, base: str | None) -> dict[str, Any]:
    return {"kind": "markdown", "markdown": markdown, "base": base}


def _missing_fragment(src: str, reason: str) -> dict[str, Any]:
    return {"kind": "missing", "src": src, "reason": reason}


def _base_for(prefix: str, relative: PurePosixPath) -> str:
    parent = relative.parent.as_posix()
    return prefix if parent == "." else f"{prefix}{parent}/"


def _resolve_include(
    src: str,
    *,
    base: str | None,
    bundle_dir: Path | None,
    shared_roots: Sequence[Path],
) -> tuple[Path, str] | None:
    """The included file and the base its own relative refs resolve against."""
    if src.startswith(SHARED_REF_PREFIX):
        ref = src[len(SHARED_REF_PREFIX):]
        relative = normalize_relative_ref(ref)
        if relative is None:
            return None
        path = resolve_shared_file(shared_roots, ref)
        return (path, _base_for(SHARED_REF_PREFIX, relative)) if path else None

    if base is None or bundle_dir is None or not base.startswith("bundle:"):
        return None
    joined = f"{base[len('bundle:'):]}{src}"
    relative = normalize_relative_ref(joined)
    if relative is None:
        return None
    path = resolve_confined_file(bundle_dir, joined)
    return (path, _base_for("bundle:", relative)) if path else None


def _split_includes(markdown: str) -> list[tuple[str, str]]:
    """Split into ("markdown", text) and ("include", src) parts.

    Include directives inside fenced code blocks are left as text.
    """
    parts: list[tuple[str, str]] = []
    buffer: list[str] = []
    fence: str | None = None
    for line in markdown.splitlines(keepends=True):
        fence_match = _FENCE_LINE.match(line)
        if fence_match:
            marker = fence_match.group(1)
            if fence is None:
                fence = marker[0] * len(marker)
            elif marker.startswith(fence):
                fence = None
        include_match = _INCLUDE_LINE.match(line) if fence is None else None
        if include_match:
            if buffer:
                parts.append(("markdown", "".join(buffer)))
                buffer = []
            parts.append(("include", include_match.group(1)))
        else:
            buffer.append(line)
    if buffer:
        parts.append(("markdown", "".join(buffer)))
    return parts


def build_how_to_document(
    location: HowToLocation,
    *,
    shared_roots: Sequence[Path],
) -> list[dict[str, Any]]:
    """Resolve a how-to into render fragments.

    Each fragment carries the base its relative refs resolve against, so an
    included shared document's images resolve inside its own library rather
    than the bundle that included it. Includes are one level deep: an include
    inside an included document renders as a missing placeholder.
    """
    root_base = "bundle:" if location.bundle_dir is not None else None
    fragments: list[dict[str, Any]] = []
    text = location.document.read_text(encoding="utf-8")
    for kind, value in _split_includes(text):
        if kind == "markdown":
            fragments.append(_markdown_fragment(value, root_base))
            continue
        resolved = _resolve_include(
            value,
            base=root_base,
            bundle_dir=location.bundle_dir,
            shared_roots=shared_roots,
        )
        if resolved is None or resolved[0].suffix.lower() != ".md":
            fragments.append(_missing_fragment(value, "not_found"))
            continue
        included_path, included_base = resolved
        for inner_kind, inner_value in _split_includes(
            included_path.read_text(encoding="utf-8")
        ):
            if inner_kind == "markdown":
                fragments.append(_markdown_fragment(inner_value, included_base))
            else:
                fragments.append(_missing_fragment(inner_value, "nested_include"))
    return fragments


__all__ = [
    "ASSET_CONTENT_TYPES",
    "BUNDLE_HOW_TO_NAME",
    "BUNDLE_MANIFEST_NAME",
    "HOW_TO_SUFFIX",
    "HowToLocation",
    "SHARED_DIR_NAME",
    "SHARED_REF_PREFIX",
    "asset_content_type",
    "build_how_to_document",
    "find_how_to",
    "find_sidecar",
    "find_sidecar_in_root",
    "find_workflow",
    "find_workflow_in_root",
    "how_to_name_for_workflow",
    "iter_bundle_dirs",
    "iter_root_workflows",
    "normalize_relative_ref",
    "resolve_confined_file",
    "resolve_shared_file",
    "resolve_user_write_path",
    "sidecar_name_for_workflow",
    "workflow_id_for_sidecar",
]
