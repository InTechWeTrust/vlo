"""CPU canonical voice-companion boundaries; no render, models or real services."""
import copy
import hashlib
import json
import os
from pathlib import Path
import httpx
import pytest
from fastapi import HTTPException
from services import ruby_owner, ruby_import_validation, workflow_modes
from routers import local_machine
RUBY_ROOT = Path(os.environ.get("VLO_TEST_RUBY_REPO", "D:/Other-projects/rubyapp-videogenerator"))

@pytest.fixture
def canonical(tmp_path, monkeypatch):
    expected=os.environ.get("VLO_TEST_EXPECTED_BACKEND")
    if expected:assert Path(ruby_owner.__file__).resolve().parents[1]==Path(expected).resolve()
    directory=tmp_path/"Preset"/"seed_hunter_combo"
    directory.mkdir(parents=True)
    (directory/"preset.json").write_bytes((RUBY_ROOT/"server/presets/seed_hunter_combo/preset.json").read_bytes())
    (directory/"workflow.json").write_bytes((RUBY_ROOT/"tools/h3_combo/workflows/Seed_Hunter_Combo.api.json").read_bytes())
    monkeypatch.setattr(ruby_owner,"OWNER_SOURCE",RUBY_ROOT/"server/app")
    monkeypatch.setattr(ruby_owner,"LIBRARY_ROOT",tmp_path)
    identity=hashlib.sha256(":".join(hashlib.sha256((directory/name).read_bytes()).hexdigest() for name in ("preset.json","workflow.json")).encode()).hexdigest()
    card=ruby_owner.source_card("seed_hunter_combo",identity)
    monkeypatch.setattr(workflow_modes,"LOCAL_MACHINE_MODE",True)
    import config
    runtime=tmp_path/"state";runtime.mkdir()
    monkeypatch.setattr(config,"RUNTIME_ROOT",runtime)
    monkeypatch.setattr(ruby_import_validation,"RUNTIME_ROOT",runtime)
    spec={"project":"codex-185-vlo-synthetic","label":"codex-185-vlo-synthetic","scene":1,"resolution":"720P","upscale":"off","check":False,
          "segments":[{"text":"An empty room.","seconds":2,"seed":101+i} for i in range(3)],
          "audio":{"speech":"off","sfx":True,"music":False},
          "voice":{"engine":"voxcpm2","lufs":-18,"lines":[{"text":"Synthetic line "+str(i),"at":i*2+.1,"seed":201+i,
          "clone":{"audio":"codex-185-vlo-synthetic/combo/voice_"+str(i)+".wav","text":"Synthetic reference "+str(i)}} for i in range(3)]}}
    entry={"owner_id":card.id,"state":"active","revision":12,"content_hash":identity,
           "body":{"card":card.as_dict(),"graph":json.loads((directory/"workflow.json").read_text())}}
    values={"spec_json":json.dumps(spec)}
    calls=[]
    def reply(request):
        calls.append((request.method,request.url.path))
        if request.url.path.endswith("/shots/preview"):
            return httpx.Response(200,json={"preset":card.id,"values":values,"notes":[]})
        if request.url.path.endswith("/library-use/sessions"):
            return httpx.Response(201,json={"library_use_id":"synthetic-consultation"})
        return httpx.Response(200,json=entry)
    original=httpx.AsyncClient
    monkeypatch.setattr(httpx,"AsyncClient",lambda **kwargs:original(transport=httpx.MockTransport(reply),**kwargs))
    return card, identity, runtime, spec, values, entry, calls

@pytest.mark.anyio
@pytest.mark.parametrize("kind",["clone","tts"])
async def test_actual_owner_compiler_import_and_pinned_submission_accept_companions(canonical,kind,monkeypatch):
    card,identity,runtime,spec,values,entry,calls=canonical
    if kind=="tts":
        for line in spec["voice"]["lines"]:line.pop("clone")
        values["spec_json"]=json.dumps(spec)
    result=await local_machine.import_library_workflow(local_machine.LibraryWorkflow(preset_id=card.id,
           shot={"prompt":"Synthetic CPU scene"},expected_source_hash=identity,ruby_project=spec["project"]))
    workflow=json.loads((runtime/"workflows"/result["workflow_id"]).read_text())
    expected="VoxCPM2_Clone" if kind=="clone" else "VoxCPM2_TTS"
    assert sum(n["class_type"]==expected for n in workflow.values())==3
    assert workflow_modes.machine_graph_family(workflow) is None
    assert not workflow_modes.machine_submission_allowed(result["workflow_id"],workflow)
    proof=await ruby_import_validation.validate_import(result["workflow_id"])
    assert proof["current"] and proof["preset_id"]==card.id
    assert workflow_modes.machine_submission_allowed(result["workflow_id"],workflow,validated_import=proof)
    # Reach the real /generate admission without any render: the next existing
    # malformed-rules guard is the deliberate stopping point after admission.
    from routers import comfyui
    monkeypatch.setattr(comfyui,"LOCAL_MACHINE_MODE",True)
    async def fake_client():return object()
    monkeypatch.setattr(comfyui,"get_http_client",fake_client)
    form={"workflow_id":result["workflow_id"],"project_id":"synthetic","delivery_context":"{}",
          "workflow":json.dumps(workflow),"workflow_rules":"[]","validated_import":json.dumps(proof)}
    class Request:
        async def form(self):return form
    admitted=await comfyui.generate(Request())
    assert admitted.status_code==400 and b"invalid_workflow_rules_payload" in admitted.body
    form["workflow_id"]=None
    refused=await comfyui.generate(Request())
    assert refused.status_code==403 and b"workflow_disabled" in refused.body
    form["workflow_id"]=result["workflow_id"]
    manifest=json.loads((runtime/"library_receipts"/(result["workflow_id"]+".json")).read_text())
    assert manifest["canonical_companion_family"]=="minimax_h3"
    assert manifest["bound_graph_sha256"]==ruby_owner.graph_hash(workflow)
    assert manifest["source_hash"]==identity
    changed=copy.deepcopy(workflow)
    voice=next(n for n in changed.values() if n["class_type"]==expected)
    voice["inputs"]["seed"]+=1
    assert not workflow_modes.machine_submission_allowed(result["workflow_id"],changed,validated_import=proof)
    form["workflow"]=json.dumps(changed)
    refused=await comfyui.generate(Request())
    assert refused.status_code==403 and b"workflow_disabled" in refused.body
    form["workflow"]=json.dumps(workflow)
    entry["content_hash"]="f"*64
    with pytest.raises(HTTPException) as stale:await ruby_import_validation.validate_import(result["workflow_id"])
    assert stale.value.status_code==409
    refused=await comfyui.generate(Request())
    assert refused.status_code==409 and b"library_import_stale" in refused.body
    assert not any("/prompt"==path for _,path in calls)

@pytest.mark.parametrize("node",[
    {"class_type":"VoxCPM2_Clone","inputs":{"model_name":"foreign"}},
    {"class_type":"VoxCPM2_TTS","inputs":{"model_name":"VoxCPM2","ckpt_name":"sdxl.safetensors"}},
    {"class_type":"SomeVoiceLoader","inputs":{"model_name":"VoxCPM2"}},
    {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"sdxl.safetensors"}},
    {"class_type":"UltralyticsDetectorProvider","inputs":{"model_name":"bbox/foreign.pt"}},
    {"class_type":"OtherDetectorProvider","inputs":{"model_name":"bbox/face_yolov8m.pt"}},
    {"class_type":"UltralyticsDetectorProvider","inputs":{"model_name":"bbox/face_yolov8m.pt","ckpt_name":"sdxl.safetensors"}},
])
def test_foreign_or_untyped_mixtures_remain_refused(canonical,node):
    card,_,_,_,_,_,_=canonical
    graph={"1":{"class_type":"UNETLoader","inputs":{"unet_name":"minimax_h3_ref2va.safetensors"}},"2":node}
    assert workflow_modes.machine_graph_family(graph) is None
    assert ruby_owner.bound_graph_family(card,graph) is None
    assert not workflow_modes.machine_submission_allowed("vlo_minimax_h3_ruby_fake.json",graph)

def test_noncanonical_owner_cannot_authorize_voice_exception(canonical):
    card,_,_,_,_,_,_=canonical
    graph={"1":{"class_type":"MiniMaxH3","inputs":{}},"2":{"class_type":"VoxCPM2_Clone","inputs":{"model_name":"VoxCPM2"}}}
    card.provenance={}
    assert ruby_owner.bound_graph_family(card,graph) is None
    card.provenance={"canonical_graph":"seed-hunter-combo-v1"};card.id="other"
    assert ruby_owner.bound_graph_family(card,graph) is None

@pytest.mark.anyio
async def test_current_receipt_without_companion_attestation_does_not_admit_voice(canonical):
    card,identity,runtime,_,values,entry,_=canonical
    graph=card.build(values);name="vlo_minimax_h3_ruby_unattested.json"
    from services.owned_library_imports import publish_import
    manifest={"preset_id":card.id,"workflow_id":name,"source_hash":identity,"source_revision":12,
              "bound_graph_sha256":ruby_owner.graph_hash(graph)}
    publish_import(runtime,name,graph,manifest,ruby_owner.graph_hash)
    proof=await ruby_import_validation.validate_import(name)
    assert proof["current"]
    assert not workflow_modes.machine_submission_allowed(name,graph,validated_import=proof)
    (runtime/"workflows"/name).write_text(json.dumps({"1":{"class_type":"MiniMaxH3","inputs":{}}}))
    with pytest.raises(HTTPException) as changed: await ruby_import_validation.validate_import(name)
    assert changed.value.status_code==409



@pytest.mark.anyio
async def test_consultation_history_cannot_change_canonical_companion_proof(canonical):
    card,identity,runtime,spec,_,_,_=canonical
    result=await local_machine.import_library_workflow(local_machine.LibraryWorkflow(preset_id=card.id,
           shot={"prompt":"Synthetic CPU scene"},expected_source_hash=identity))
    from services.owned_library_imports import read_receipt, publish_import
    name=result["workflow_id"]
    first=read_receipt(runtime/"library_receipts",name)
    workflow=json.loads((runtime/"workflows"/name).read_text())
    altered={**first,"canonical_companion_family":None}
    with pytest.raises(ValueError,match="Pinned receipt binding differs"):
        publish_import(runtime,name,workflow,altered,ruby_owner.graph_hash)
    assert read_receipt(runtime/"library_receipts",name)==first
    again=await local_machine.import_library_workflow(local_machine.LibraryWorkflow(preset_id=card.id,
           shot={"prompt":"Synthetic CPU scene"},expected_source_hash=identity))
    assert again["workflow_id"]==name
    assert read_receipt(runtime/"library_receipts",name)["canonical_companion_family"]=="minimax_h3"


@pytest.mark.anyio
@pytest.mark.parametrize("with_voice",[True,False])
async def test_actual_full_r2_104_and_foley_without_voice_keep_pinned_admission(canonical,with_voice):
    card,identity,runtime,spec,values,entry,calls=canonical
    # Synthetic public inputs reproduce the approved actual104 R2 structure:
    # three first-frame Pictures, three references, three Clone lines,
    # original Foley/face detector, current int8 checking, no private payload.
    spec.pop("audio")
    project=spec["project"]
    spec["images"]=[{"file":project+"/combo/picture_"+str(i)+".png","label":"Synthetic picture "+str(i),
                     **({"role":"frame"} if i<3 else {})} for i in range(6)]
    for i,segment in enumerate(spec["segments"]):
        segment.update(seconds=[5.5,5.5,4][i],sound="Quiet synthetic room sound.",
                       frames=[{"picture":i+1,"at":"start"}])
    spec["foley"]={"engine":"h3","prompt":"Two synthetic taps. No speech, voices or music.","seed":6332}
    spec["auto_prompt"]={"engine":"off"}
    spec["check"]=True
    if not with_voice:
        spec.pop("voice")
        spec["audio"]={"speech":"drive","drive":project+"/combo/dialogue.wav"}
    values["spec_json"]=json.dumps(spec)
    compiled=card.build(values)
    if with_voice:assert len(compiled)==104
    result=await local_machine.import_library_workflow(local_machine.LibraryWorkflow(preset_id=card.id,
           shot={"prompt":"Synthetic full R2"},expected_source_hash=identity,ruby_project=project))
    graph=json.loads((runtime/"workflows"/result["workflow_id"]).read_text())
    if with_voice:assert len(graph)==104
    assert sum(n["class_type"]=="VoxCPM2_Clone" for n in graph.values())==(3 if with_voice else 0)
    detector=[n for n in graph.values() if n["class_type"]=="UltralyticsDetectorProvider"]
    assert len(detector)==1 and detector[0]["inputs"]=={"model_name":"bbox/face_yolov8m.pt"}
    assert workflow_modes.machine_graph_family(graph) is None
    proof=await ruby_import_validation.validate_import(result["workflow_id"])
    assert workflow_modes.machine_submission_allowed(result["workflow_id"],graph,validated_import=proof)
    changed=copy.deepcopy(graph)
    next(n for n in changed.values() if n["class_type"]=="UltralyticsDetectorProvider")["inputs"]["model_name"]="bbox/foreign.pt"
    assert not workflow_modes.machine_submission_allowed(result["workflow_id"],changed,validated_import=proof)
    assert not any(path=="/prompt" for _,path in calls)
