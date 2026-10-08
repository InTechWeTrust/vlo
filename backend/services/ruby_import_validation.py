"""New submissions must use the current Active source; queued graphs are pinned."""
import json
import re
from urllib.parse import quote
import httpx
from fastapi import HTTPException
from config import RUNTIME_ROOT
from services.local_machine import MACHINE_URL
from services.ruby_owner import graph_hash

async def validate_import(workflow_id):
    if "_ruby_" not in workflow_id:
        return {"imported":False}
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+\.json", workflow_id):
        raise HTTPException(422, "Invalid imported workflow ID")
    try:
        from services.owned_library_imports import read_receipt, _read
        manifest = read_receipt(RUNTIME_ROOT / "library_receipts", workflow_id)
        from services.workflow_bundles import find_workflow
        graph_path=find_workflow([RUNTIME_ROOT/"workflows"],workflow_id)
        if graph_path is None:raise ValueError("Pinned workflow not found")
        graph = _read(graph_path)
    except (OSError, ValueError):
        raise HTTPException(409, "This Library import has no current pinned receipt; refresh and reimport")
    if graph_hash(graph) != manifest.get("bound_graph_sha256"):
        raise HTTPException(409, "The imported graph bytes changed; refresh and reimport the owner card")
    async with httpx.AsyncClient(timeout=30, headers={"X-Machine-App":"vlo"}) as client:
        try:
            current = await client.get(f"{MACHINE_URL}/library/preset/{quote(manifest['preset_id'],safe='')}")
        except httpx.HTTPError as error:
            raise HTTPException(503, "Cannot confirm the current Active Library source; submission stopped") from error
    if current.status_code != 200:
        raise HTTPException(409, "The Library preset is no longer Active/available; refresh and reimport")
    entry = current.json()
    if entry.get("state","active")!="active":raise HTTPException(409,"The Library preset is no longer Active")
    if entry.get("content_hash") != manifest.get("source_hash") or entry.get("revision") != manifest.get("source_revision"):
        raise HTTPException(409, "The Library preset changed after import; refresh and reimport before a new submission")
    return {"imported":True,"current":True,"preset_id":manifest["preset_id"],"source_hash":manifest["source_hash"],"source_revision":manifest["source_revision"],"bound_graph_sha256":manifest["bound_graph_sha256"],"canonical_companion_family":manifest.get("canonical_companion_family")}
