"""Constrained local-machine I/O and acknowledged native-editor automation."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, ConfigDict
from typing import Literal
from services.local_machine import ROOTS, ENABLED, MACHINE_URL, editor_transport, resolve_path

router = APIRouter(prefix="/api/machine")
COMMANDS = ["state", "project.create", "project.open", "project.save", "project.configure", "assets.import", "timeline.insert", "timeline.remove", "timeline.split", "timeline.move", "generation.load", "generation.configure", "generation.start", "generation.cancel", "export.start", "export.status", "export.cancel", "host.execute"]

@router.get("/status")
def status():
    return {"enabled": ENABLED, "roots": {k: str(v) for k,v in ROOTS.items()}, "machine_url": MACHINE_URL,
            "editor_connected": bool(editor_transport.session and __import__('time').monotonic()-editor_transport.seen < 15)}

@router.get("/capabilities")
def capabilities():
    import os
    return {"commands": COMMANDS, "requires_browser_editor": True, "storage": "shared E media roots", "units": "timeline canonical ticks", "workflow_prefixes": [prefix.strip() for prefix in os.environ.get("VLO_ENABLED_WORKFLOW_PREFIXES", "vlo_minimax_h3_,vlo_qwen_image_2_1_").split(",") if prefix.strip()],"library":{"catalogue":"GET /api/machine/library/presets","schema":"GET /api/machine/library/presets/{preset_id}/schema","import":"POST /api/machine/library/workflow","validate":"GET /api/machine/library/workflows/{workflow_id}/validate","refile":"POST /api/machine/library/refile"}}

class Command(BaseModel):
    command: str
    args: dict = Field(default_factory=dict)

@router.post("/commands", status_code=202)
def submit(body: Command):
    if body.command not in COMMANDS:
        raise HTTPException(422, "Unknown command; inspect /api/machine/capabilities")
    if len(json.dumps(body.args)) > 262144:
        raise HTTPException(413, "Command payload exceeds 256 KB")
    return editor_transport.submit(body.command, body.args)

@router.get("/commands/{job_id}")
def command_status(job_id: str):
    job = editor_transport.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Command not found")
    if job["status"] in {"pending", "running"}:
        try:
            editor_transport.require_session(job["session"])
        except HTTPException:
            job.update(status="failed", error="Editor disconnected; outcome unknown, inspect native state before retrying")
    return job

class Heartbeat(BaseModel):
    session: str = Field(min_length=1, max_length=100)

class Result(Heartbeat):
    id: str
    result: object = None
    error: str | None = None

@router.post("/editor/heartbeat")
def heartbeat(body: Heartbeat):
    editor_transport.heartbeat(body.session)
    return {"ok": True}

@router.get("/editor/next")
def next_command(session: str):
    return editor_transport.next(session)

@router.post("/editor/result")
def result(body: Result):
    return editor_transport.finish(body.session, body.id, body.result, body.error)

@router.get("/fs/stat")
def stat(root: str, path: str = ""):
    target = resolve_path(root, path)
    if not target.exists():
        raise HTTPException(404, "Entry not found")
    return {"kind": "directory" if target.is_dir() else "file", "name": target.name}

@router.get("/fs/list")
def listing(root: str, path: str = ""):
    target = resolve_path(root, path)
    if not target.is_dir():
        raise HTTPException(404, "Directory not found")
    return [{"name": e.name, "kind": "directory" if e.is_dir() else "file"} for e in target.iterdir() if not e.is_symlink()]

@router.get("/fs/file")
def read(root: str, path: str):
    target = resolve_path(root, path)
    if not target.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(target)

@router.put("/fs/file")
async def write(request: Request, root: str, path: str, position: int | None = None, truncate: int | None = None):
    target = resolve_path(root, path, write=True)
    if not path or target == ROOTS[root]:
        raise HTTPException(400, "A file path is required")
    data = await request.body()
    if len(data) > 128 * 1024 * 1024:
        raise HTTPException(413, "Write in chunks smaller than 128 MB")
    if position is not None and (position < 0 or position > 64*1024**3):
        raise HTTPException(422, "Invalid write offset")
    if truncate is not None and (truncate < 0 or truncate > 64*1024**3):
        raise HTTPException(422, "Invalid file size")
    target.parent.mkdir(parents=True, exist_ok=True)
    if position is None:
        temporary = target.with_name(target.name + ".writing")
        temporary.write_bytes(data)
        os.replace(temporary, target)
    else:
        with target.open("r+b" if target.exists() else "w+b") as stream:
            stream.seek(position)
            stream.write(data)
            if truncate is not None:
                stream.truncate(truncate)
    return {"ok": True}

@router.post("/fs/directory")
def mkdir(root: str, path: str):
    resolve_path(root, path, write=True).mkdir(parents=True, exist_ok=True)
    return {"ok": True}

@router.post("/fs/move")
def move(root: str, source: str, destination: str):
    source_path = resolve_path(root, source, write=True)
    target = resolve_path(root, destination, write=True)
    if not source or not destination or source_path == ROOTS[root] or target == ROOTS[root] or not source_path.is_file():
        raise HTTPException(400, "Only file moves inside one storage root are allowed")
    target.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source_path, target)
    return {"ok": True}

@router.delete("/fs/entry")
def delete(root: str, path: str, recursive: bool = False):
    target = resolve_path(root, path, write=True)
    if target == ROOTS[root] or not path:
        raise HTTPException(403, "Cannot delete a shared root")
    if not target.exists():
        return {"ok": True}
    if target.is_dir():
        if recursive:
            # Never follow junctions/symlinks during recursive deletion.
            for base, directories, files in os.walk(target, followlinks=False):
                for name in directories + files:
                    candidate = (Path(base)/name).resolve()
                    if candidate != target and target not in candidate.parents:
                        raise HTTPException(403, "Recursive deletion cannot follow links outside its target")
            import shutil
            shutil.rmtree(target)
        else:
            target.rmdir()
    else:
        target.unlink()
    return {"ok": True}

@router.api_route("/bridge/{path:path}", methods=["GET", "POST"])
async def bridge(path: str, request: Request):
    if not (path in {"status", "v1/models", "v1/chat/completions"} or path.startswith("library")) or ".." in path:
        raise HTTPException(404, "Machine bridge route unavailable")
    async with httpx.AsyncClient(timeout=600) as client:
        try:
            upstream = await client.request(request.method, f"{MACHINE_URL}/{path}", params=request.query_params, content=await request.body(), headers={"content-type": "application/json", "X-Machine-App":"vlo"})
        except httpx.HTTPError:
            raise HTTPException(503, "Huobao machine bridge unavailable; start both apps")
    return Response(upstream.content, status_code=upstream.status_code, media_type=upstream.headers.get("content-type", "application/json"))

# One owner-neutral host service supplies explicit refresh and picker refresh.
_library_refiler = None

async def refile_library_workflows(*,force=False,strict=True):
    global _library_refiler
    if not ENABLED:return {}
    from config import RUNTIME_ROOT
    from services.library_refile import LibraryRefiler,UnresolvedLibraryFiling
    from services.workflow_modes import WORKFLOWS_DIR
    if _library_refiler is None or _library_refiler.workflows!=WORKFLOWS_DIR:
        _library_refiler=LibraryRefiler(WORKFLOWS_DIR,RUNTIME_ROOT/'library_receipts')
    async def catalogue():
        async with httpx.AsyncClient(timeout=30,headers={'X-Machine-App':'vlo'}) as client:
            response=await client.get(f'{MACHINE_URL}/library',params={'kind':'preset','state':'all'})
        if response.status_code!=200:raise HTTPException(503,'Ruby all-state catalogue unavailable')
        return response.json().get('entries',[])
    try:
        return await _library_refiler.refresh(catalogue,force=force)
    except UnresolvedLibraryFiling as error:
        raise HTTPException(503,str(error)) from error
    except (httpx.HTTPError,OSError,ValueError,HTTPException) as error:
        if strict:raise HTTPException(503,'Library refile refused; existing workflow bytes kept') from error
        return {key:{**value,'source_unconfirmed':True,'stale':True} for key,value in _library_refiler.metadata.items()}

@router.post('/library/refile')
async def refresh_library_workflows():
    return {'entries':await refile_library_workflows(force=True)}

class OwnerShot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: Literal["comfyui"] = "comfyui"
    prompt: str = ""
    duration_s: float = Field(default=5, gt=0)
    aspect: str = "auto"
    resolution: str = "480p"
    mode: str = "text"
    first_frame: str | None = None
    last_frame: str | None = None
    mask: str | None = None
    references: list[str] = Field(default_factory=list, max_length=32)
    shot_frames: list[dict] = Field(default_factory=list, max_length=32)
    extend_from: str | None = None
    extend_kind: Literal["", "picture", "motion"] = ""
    audio_enabled: bool | None = None
    audio: dict | None = None
    subtitles: dict | None = None
    count: int = Field(default=1, ge=1, le=4)
    steps: int | None = None
    seed: int | None = None
    advanced: dict = Field(default_factory=dict)
    element_ids: list[int] = Field(default_factory=list)
    prompt_output_adapter: dict | str | None = None

class LibraryWorkflow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preset_id: str = Field(min_length=1, max_length=200)
    ruby_project: str = Field(default="vlo", min_length=1, max_length=200)
    shot: OwnerShot | None = None
    expected_source_hash: str | None = None

@router.post("/library/workflow")
async def import_library_workflow(body: LibraryWorkflow):
    """Read the Active owner catalogue and preserve Ruby's consultation receipt."""
    from config import RUNTIME_ROOT
    from urllib.parse import quote
    async with httpx.AsyncClient(timeout=30, headers={"X-Machine-App":"vlo"}) as client:
        try:
            entry_response = await client.get(f"{MACHINE_URL}/library/preset/{quote(body.preset_id, safe='')}")
            if entry_response.status_code != 200:
                raise HTTPException(entry_response.status_code, "Ruby Active preset unavailable")
            entry = entry_response.json()
            if entry.get("state","active")!="active":raise HTTPException(409,"Only an Active Library preset can be imported")
            if body.expected_source_hash and entry.get("content_hash") != body.expected_source_hash:
                raise HTTPException(409, "Selected Library controls changed; refresh the card before importing")
            payload = entry.get("body", entry.get("data", {}).get("body", {}))
            graph_text = payload.get("graph", "")
            card = payload.get("card", {})
            graph = json.loads(graph_text) if isinstance(graph_text, str) else graph_text
            if not isinstance(graph, dict) or not graph:
                raise HTTPException(422, "Ruby preset has no executable ComfyUI graph")
            from services.workflow_modes import machine_graph_family
            family = machine_graph_family(graph)
            if family is None:
                raise HTTPException(422, "This preset is outside the enabled H3/Qwen Image 2.1 model set")
            requires_source = bool(card.get("bindings", {}).get("extend_from"))
            if requires_source and (not body.shot or not body.shot.extend_from):
                raise HTTPException(422, "This preset requires its actual source clip; configure and bind it before importing")
            preview = None
            canonical_companion_family = None
            source_hash = entry.get("content_hash")
            if body.shot:
                from services.ruby_owner import RUBY_URL, source_card
                preview_response = await client.post(f"{RUBY_URL}/api/shots/preview", json={**body.shot.model_dump(exclude_none=True), "preset":body.preset_id,"project":body.ruby_project}, headers={"X-Ruby-Origin":"vlo","X-Ruby-Session":"vlo"})
                if preview_response.status_code != 200:
                    raise HTTPException(preview_response.status_code, preview_response.json().get("detail", "Ruby refused the native shot preview"))
                preview = preview_response.json()
                if preview.get("preset") != body.preset_id or not isinstance(preview.get("values"), dict):
                    raise HTTPException(502, "Ruby returned an invalid native Bound response")
                notes = preview.get("notes", [])
                if any(isinstance(note, dict) and (note.get("severity") == "blocked" or note.get("status") == "blocked") for note in notes):
                    raise HTTPException(422, {"message":"Native Ruby preview blocked this configuration; resolve its original control or project policy", "notes":notes})
                owner_card = source_card(body.preset_id, source_hash)
            session_response = await client.post(f"{MACHINE_URL}/library-use/sessions", json={"project":body.ruby_project,"proposed_card":body.preset_id})
            if session_response.status_code not in {200,201}:
                raise HTTPException(session_response.status_code, "Ruby refused the Library consultation; check the project and policy")
            receipt = session_response.json()
            if not receipt.get("library_use_id"):
                raise HTTPException(502, "Ruby consultation returned no receipt")
            if preview is not None:
                from services.ruby_owner import build_bound_graph, source_card
                graph = await build_bound_graph(owner_card, preview["values"], receipt["library_use_id"])
                source_card(body.preset_id, source_hash)
                from services.ruby_owner import bound_graph_family
                if bound_graph_family(owner_card, graph) != family:
                    raise HTTPException(422, "Bound graph changed its approved model family")
                if machine_graph_family(graph) is None:
                    canonical_companion_family = family
        except (httpx.HTTPError, ValueError) as error:
            raise HTTPException(503, "Ruby Library graph/receipt unavailable") from error
    import hashlib
    from services.ruby_owner import graph_hash
    bound_hash = graph_hash(graph)
    suffix = hashlib.sha256(f"{body.preset_id}:{source_hash}:{bound_hash}".encode()).hexdigest()[:16]
    workflow_id = f"vlo_{family}_ruby_{suffix}.json"
    manifest = {"preset_id":body.preset_id,"workflow_id":workflow_id,"source_hash":source_hash,"source_revision":entry.get("revision"),"source_graph_sha256":payload.get("sha256"),"bound_graph_sha256":bound_hash,"consultation":receipt,"preview":preview}
    if canonical_companion_family is not None:
        manifest["canonical_companion_family"] = canonical_companion_family
    from services.owned_library_imports import publish_import
    try:
        publish_import(RUNTIME_ROOT,workflow_id,graph,manifest,graph_hash)
    except (OSError,ValueError) as error:
        raise HTTPException(409,"Pinned workflow/receipt could not be published; existing evidence kept") from error
    if _library_refiler is not None:_library_refiler.checked_at=None
    return {"workflow_id":workflow_id,"library_use_id":receipt["library_use_id"],"receipt":receipt,"card":card,"preview":preview,"source_hash":source_hash,"source_revision":entry.get("revision"),"bound_graph_sha256":bound_hash}

@router.get("/library/presets/{preset_id}/schema")
async def library_preset_schema(preset_id: str):
    from urllib.parse import quote
    from services.ruby_owner import RUBY_URL
    async with httpx.AsyncClient(timeout=30, headers={"X-Ruby-Origin":"vlo","X-Ruby-Session":"vlo","X-Machine-App":"vlo"}) as client:
        active = await client.get(f"{MACHINE_URL}/library/preset/{quote(preset_id,safe='')}")
        if active.status_code != 200:
            raise HTTPException(active.status_code, "Refresh the Active Library selection")
        schema = await client.get(f"{RUBY_URL}/api/presets/{quote(preset_id,safe='')}/schema")
        if schema.status_code != 200:
            raise HTTPException(schema.status_code, "Native Ruby preset schema unavailable")
        capabilities_response = await client.get(f"{RUBY_URL}/api/shots/capabilities")
        if capabilities_response.status_code != 200:
            raise HTTPException(capabilities_response.status_code,"Native Ruby shot capability unavailable")
        return {"entry":active.json(),"schema":schema.json(),"capability":capabilities_response.json().get("capabilities",{}).get(preset_id,{})}

@router.get("/library/presets")
async def library_enabled_presets(state: Literal["active","lab","old","all"]="active"):
    """Current catalogue with usable families verified from actual owner graphs."""
    from urllib.parse import quote
    from services.workflow_modes import machine_graph_family
    async with httpx.AsyncClient(timeout=30,headers={"X-Machine-App":"vlo"}) as client:
        catalogue = await client.get(f"{MACHINE_URL}/library",params={"kind":"preset","state":state})
        if catalogue.status_code != 200:
            raise HTTPException(catalogue.status_code,"Ruby Active catalogue unavailable")
        result = catalogue.json()
        enabled = []
        for entry in result.get("entries",[]):
            if state!="all" and entry.get("state")!=state:continue
            response = await client.get(f"{MACHINE_URL}/library/preset/{quote(entry['owner_id'],safe='')}",params={'state':'all'})
            if response.status_code != 200: continue
            current = response.json()
            graph = current.get("body",{}).get("graph")
            try:
                graph = json.loads(graph) if isinstance(graph,str) else graph
            except ValueError: continue
            family = machine_graph_family(graph)
            if family:
                enabled.append({key:current.get(key) for key in ("owner_id","title","summary","state","revision","content_hash")} | {"detail":{"machine_family":family}})
        return {"entries":enabled,"enabled_count":len(enabled),"policy_revision":result.get("policy_revision")}

@router.get("/library/workflows/{workflow_id}/validate")
async def validate_library_import(workflow_id: str):
    from services.ruby_import_validation import validate_import
    return await validate_import(workflow_id)

async def local_machine_guard(request: Request, call_next):
    if request.url.path.startswith("/api/machine"):
        if not ENABLED:
            return Response("Local-machine mode is disabled", status_code=404)
        client = request.client.host if request.client else ""
        origin = request.headers.get("origin")
        if client not in {"127.0.0.1", "::1", "testclient"} or (origin and urlsplit(origin).hostname not in {"localhost", "127.0.0.1", "::1"}):
            return Response("Local-machine API requires a loopback client and origin", status_code=403)
    return await call_next(request)
