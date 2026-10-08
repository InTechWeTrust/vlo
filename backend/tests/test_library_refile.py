import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from services.library_refile import LibraryRefiler,workflow_state_metadata
from services.workflow_bundles import find_workflow,sidecar_name_for_workflow,how_to_name_for_workflow


@pytest.fixture
def anyio_backend():return 'asyncio'


@pytest.fixture
def owned(tmp_path):
    workflows=tmp_path/'workflows';receipts=tmp_path/'library_receipts'
    workflows.mkdir();receipts.mkdir()
    name='vlo_minimax_h3_ruby_pinned.json'
    graph=b'{"1":{"class_type":"MiniMaxH3","inputs":{}}}'
    (workflows/name).write_bytes(graph)
    (workflows/sidecar_name_for_workflow(name)).write_text('{"version":3}')
    (workflows/how_to_name_for_workflow(name)).write_text('How to use this pinned graph')
    (receipts/(name+'.json')).write_text(json.dumps({'preset_id':'test','workflow_id':name,'source_hash':'hash','source_revision':8}))
    return LibraryRefiler(workflows,receipts),name,graph


@pytest.mark.anyio
async def test_refile_all_states_preserves_ids_bound_graph_rules_and_howto(owned):
    service,name,graph=owned
    for state,folder in [('lab','Lab'),('old','Old'),('active','')]:
        fetch=AsyncMock(return_value=[{'owner_id':'test','state':state,'content_hash':'hash','revision':8}])
        metadata=await service.refresh(fetch,force=True)
        expected=service.workflows/folder/name
        assert find_workflow([service.workflows],name)==expected
        assert expected.read_bytes()==graph
        assert (expected.parent/sidecar_name_for_workflow(name)).read_text()=='{"version":3}'
        assert (expected.parent/how_to_name_for_workflow(name)).read_text()=='How to use this pinned graph'
        assert metadata[name]['group']==state.title()
        assert metadata[name]['stale'] is False


@pytest.mark.anyio
async def test_stale_active_is_flagged_without_overwriting_bound_graph(owned):
    service,name,graph=owned
    metadata=await service.refresh(AsyncMock(return_value=[{'owner_id':'test','state':'active','content_hash':'new','revision':9}]),force=True)
    assert metadata[name]['stale'] is True
    assert (service.workflows/name).read_bytes()==graph


@pytest.mark.anyio
async def test_refresh_cache_is_sixty_seconds_and_force_refreshes(owned):
    service,name,graph=owned;now=[0];service.clock=lambda:now[0]
    fetch=AsyncMock(return_value=[{'owner_id':'test','state':'active','content_hash':'hash','revision':8}])
    await service.refresh(fetch);now[0]=59;await service.refresh(fetch)
    assert fetch.await_count==1
    now[0]=60;await service.refresh(fetch)
    assert fetch.await_count==2
    await service.refresh(fetch,force=True)
    assert fetch.await_count==3


@pytest.mark.anyio
async def test_collision_refuses_without_discarding_either_graph_or_sidecar(owned):
    service,name,graph=owned
    (service.workflows/'Lab').mkdir();other=service.workflows/'Lab'/sidecar_name_for_workflow(name)
    other.write_bytes(b'other')
    with pytest.raises(ValueError,match='already exists'):
        await service.refresh(AsyncMock(return_value=[{'owner_id':'test','state':'lab','content_hash':'hash','revision':8}]),force=True)
    assert (service.workflows/name).read_bytes()==graph
    assert other.read_bytes()==b'other'
    assert (service.workflows/sidecar_name_for_workflow(name)).exists()


@pytest.mark.anyio
async def test_saved_filename_resolves_after_lab_move(owned):
    service,name,graph=owned
    project={'generation':{'workflow_id':name}}
    await service.refresh(AsyncMock(return_value=[{'owner_id':'test','state':'lab','content_hash':'hash','revision':8}]),force=True)
    assert find_workflow([service.workflows],project['generation']['workflow_id']).read_bytes()==graph


@pytest.mark.anyio
async def test_workflow_list_groups_sorts_and_hides_old(owned,monkeypatch,tmp_path):
    from routers import comfyui,local_machine
    service,name,graph=owned
    (service.workflows/'Lab').mkdir();(service.workflows/'Old').mkdir()
    (service.workflows/'Lab'/'vlo_minimax_h3_lab.json').write_bytes(graph)
    (service.workflows/'Old'/'vlo_minimax_h3_old.json').write_bytes(graph)
    defaults=tmp_path/'defaults';defaults.mkdir()
    monkeypatch.setattr(comfyui,'WORKFLOWS_DIR',service.workflows)
    monkeypatch.setattr(comfyui,'get_packaged_workflows_dir',lambda:defaults)
    monkeypatch.setattr(comfyui,'_how_to_roots',lambda:[service.workflows])
    monkeypatch.setattr(comfyui,'_load_workflow_menu_metadata',lambda:{})
    monkeypatch.setattr(comfyui,'load_rules_model_for_workflow',lambda *a,**k:(type('Rules',(),{'name':None})(),None))
    monkeypatch.setattr(local_machine,'refile_library_workflows',AsyncMock(return_value={name:{'stale':True}}))
    monkeypatch.setattr(comfyui,'machine_workflow_allowed',lambda name:True)
    default=await comfyui.list_workflows()
    assert [item['group'] for item in default]==['Active','Lab']
    assert default[0]['stale'] is True
    all_items=await comfyui.list_workflows(show_old=True)
    assert [item['group'] for item in all_items]==['Active','Lab','Old']


@pytest.mark.anyio
async def test_unknown_state_refuses_before_moving_any_owned_bytes(owned):
    service,name,graph=owned
    with pytest.raises(ValueError,match='unknown Library state'):
        await service.refresh(AsyncMock(return_value=[{'owner_id':'test','state':'inactive'}]),force=True)
    assert (service.workflows/name).read_bytes()==graph


@pytest.mark.anyio
async def test_later_invalid_receipt_refuses_before_first_workflow_family_moves(owned):
    service,name,graph=owned
    (service.receipts/'zzz-invalid.json').write_text(json.dumps({'workflow_id':'../escape.json','preset_id':'other'}))
    with pytest.raises(ValueError,match='Invalid owned'):
        await service.refresh(AsyncMock(return_value=[{'owner_id':'test','state':'lab'}]),force=True)
    assert (service.workflows/name).read_bytes()==graph
    assert not (service.workflows/'Lab'/name).exists()


@pytest.mark.anyio
async def test_later_failed_move_rolls_back_all_acquired_source_leaves(owned,monkeypatch):
    from services import library_refile
    service,name,graph=owned;original=library_refile.rename_open_file
    def fail_sidecar(reader,target):
        if target.parent.name=='Lab' and target.name.endswith('.rules.json'):raise OSError('injected sidecar failure')
        return original(reader,target)
    monkeypatch.setattr(library_refile,'rename_open_file',fail_sidecar)
    with pytest.raises(OSError,match='injected'):
        await service.refresh(AsyncMock(return_value=[{'owner_id':'test','state':'lab'}]),force=True)
    assert (service.workflows/name).read_bytes()==graph
    assert (service.workflows/sidecar_name_for_workflow(name)).exists()
    assert not (service.workflows/'Lab'/name).exists()


@pytest.mark.anyio
async def test_cached_metadata_is_detached_from_api_callers(owned):
    service,name,graph=owned
    fetch=AsyncMock(return_value=[{'owner_id':'test','state':'active','content_hash':'new','revision':9}])
    result=await service.refresh(fetch);result[name]['stale']=False
    again=await service.refresh(fetch)
    assert again[name]['stale'] is True
    assert fetch.await_count==1


@pytest.mark.anyio
async def test_reimport_keeps_first_receipt_graph_and_all_consultations_then_refiles(tmp_path):
    from services.owned_library_imports import publish_import,read_receipt
    import hashlib
    def digest(graph):return hashlib.sha256(json.dumps(graph,sort_keys=True).encode()).hexdigest()
    runtime=tmp_path/'runtime';runtime.mkdir()
    name='vlo_minimax_h3_ruby_bound.json';graph={'1':{'class_type':'MiniMaxH3','inputs':{}}}
    first={'preset_id':'test','workflow_id':name,'source_hash':'hash','source_revision':8,
        'bound_graph_sha256':digest(graph),'consultation':{'library_use_id':'first'}}
    publish_import(runtime,name,graph,first,digest)
    original=(runtime/'library_receipts'/(name+'.json')).read_bytes()
    graph_bytes=(runtime/'workflows'/name).read_bytes()
    second={**first,'source_revision':9,'consultation':{'library_use_id':'second'}}
    publish_import(runtime,name,graph,second,digest)
    assert (runtime/'library_receipts'/(name+'.json')).read_bytes()==original
    assert read_receipt(runtime/'library_receipts',name)==second
    assert len(list((runtime/'library_receipts'/'.history'/name).glob('*.json')))==2
    service=LibraryRefiler(runtime/'workflows',runtime/'library_receipts')
    for state in ('lab','old','active'):
        metadata=await service.refresh(AsyncMock(return_value=[{'owner_id':'test','state':state,'content_hash':'hash','revision':9}]),force=True)
        assert metadata[name]['group']==state.title()
        assert metadata[name]['stale'] is False
        assert find_workflow([service.workflows],name).read_bytes()==graph_bytes
    metadata=await service.refresh(AsyncMock(return_value=[{'owner_id':'test','state':'active','content_hash':'changed','revision':10}]),force=True)
    assert metadata[name]['stale'] is True
    assert read_receipt(runtime/'library_receipts',name)==second


def test_import_rejects_changed_bound_bytes_and_keeps_original_receipt(tmp_path):
    from services.owned_library_imports import publish_import,read_receipt
    runtime=tmp_path/'runtime';runtime.mkdir();name='vlo_minimax_h3_ruby_bound.json'
    manifest={'preset_id':'test','workflow_id':name,'source_hash':'hash','source_revision':1,'bound_graph_sha256':'same'}
    publish_import(runtime,name,{'old':1},manifest,lambda _graph:'same')
    with pytest.raises(ValueError,match='different graph bytes'):
        publish_import(runtime,name,{'new':2},manifest,lambda _graph:'different')
    assert json.loads((runtime/'workflows'/name).read_text())=={'old':1}
    assert read_receipt(runtime/'library_receipts',name)==manifest


def test_incomplete_receipt_publication_preserves_all_previous_evidence(tmp_path,monkeypatch):
    from services import owned_library_imports as imports
    runtime=tmp_path/'runtime';runtime.mkdir();name='vlo_minimax_h3_ruby_bound.json'
    first={'preset_id':'test','workflow_id':name,'source_hash':'hash','source_revision':1,'bound_graph_sha256':'same'}
    imports.publish_import(runtime,name,{'old':1},first,lambda _graph:'same')
    def refuse(_stream,_target):raise OSError('injected publication failure')
    monkeypatch.setattr(imports,'rename_open_file',refuse)
    with pytest.raises(OSError,match='injected publication failure'):
        imports.publish_import(runtime,name,{'old':1},{**first,'source_revision':2},lambda _graph:'same')
    assert imports.read_receipt(runtime/'library_receipts',name)==first
    assert len(list((runtime/'library_receipts'/'.history'/name).glob('.import-pending-*')))==1
    assert json.loads((runtime/'workflows'/name).read_text())=={'old':1}


@pytest.mark.anyio
async def test_rollback_attempts_every_member_and_pending_journal_blocks_later_refresh(owned,monkeypatch):
    from services import library_refile
    service,name,graph=owned;original=library_refile.rename_open_file;attempts=[]
    def failure(reader,target):
        attempts.append(str(target))
        if target.parent.name=='Lab' and target.name.endswith('.howto.md'):raise OSError('forward third-member failure')
        if target.parent==service.workflows and target.name.endswith('.rules.json'):raise OSError('rollback first-member failure')
        return original(reader,target)
    monkeypatch.setattr(library_refile,'rename_open_file',failure)
    with pytest.raises(library_refile.UnresolvedLibraryFiling,match='original and relocated bytes retained'):
        await service.refresh(AsyncMock(return_value=[{'owner_id':'test','state':'lab'}]),force=True)
    assert str(service.workflows/name) in attempts  # Graph undo still attempted after rules undo failed.
    assert (service.workflows/name).read_bytes()==graph
    assert (service.workflows/'Lab'/sidecar_name_for_workflow(name)).exists()
    assert (service.workflows/how_to_name_for_workflow(name)).exists()
    journals=list((service.workflows/'.refile-pending').glob('*.json'))
    assert len(journals)==1
    assert len(json.loads(journals[0].read_text())['moves'])==3
    fresh=LibraryRefiler(service.workflows,service.receipts)
    fetch=AsyncMock(return_value=[{'owner_id':'test','state':'active'}])
    with pytest.raises(library_refile.UnresolvedLibraryFiling,match='retained operation journals'):
        await fresh.refresh(fetch,force=True)
    fetch.assert_not_awaited()


@pytest.mark.anyio
async def test_unresolved_filing_does_not_fall_back_to_cached_picker_state(monkeypatch,tmp_path):
    from routers import local_machine
    from services.library_refile import UnresolvedLibraryFiling
    from services import workflow_modes
    import config
    monkeypatch.setattr(local_machine,'ENABLED',True)
    monkeypatch.setattr(workflow_modes,'WORKFLOWS_DIR',tmp_path/'workflows')
    monkeypatch.setattr(config,'RUNTIME_ROOT',tmp_path)
    service=LibraryRefiler(workflow_modes.WORKFLOWS_DIR,tmp_path/'receipts')
    service.refresh=AsyncMock(side_effect=UnresolvedLibraryFiling('retained operation journals'))
    monkeypatch.setattr(local_machine,'_library_refiler',service)
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        await local_machine.refile_library_workflows(strict=False)
    assert error.value.status_code==503
    assert 'retained operation journals' in error.value.detail


def test_import_creates_missing_runtime_under_pinned_ancestor(tmp_path):
    from services.owned_library_imports import publish_import,read_receipt
    runtime=tmp_path/'new'/'runtime';name='vlo_minimax_h3_ruby_bound.json'
    manifest={'preset_id':'test','workflow_id':name,'source_hash':'hash','source_revision':1,'bound_graph_sha256':'same'}
    publish_import(runtime,name,{'graph':1},manifest,lambda _graph:'same')
    assert read_receipt(runtime/'library_receipts',name)==manifest


@pytest.mark.anyio
@pytest.mark.parametrize('forward_failure',[False,True])
async def test_actual_soft_picker_refresh_refuses_journal_retirement_failure(owned,monkeypatch,forward_failure):
    from routers import local_machine
    from services import library_refile,workflow_modes
    from fastapi import HTTPException
    import config
    service,name,graph=owned;original=library_refile.rename_open_file
    service.metadata={name:{'group':'Active','stale':False}}
    async def refresh(_catalogue,**options):
        return await LibraryRefiler.refresh(service,AsyncMock(return_value=[{'owner_id':'test','state':'lab'}]),force=True)
    monkeypatch.setattr(service,'refresh',refresh)
    monkeypatch.setattr(local_machine,'ENABLED',True)
    monkeypatch.setattr(local_machine,'_library_refiler',service)
    monkeypatch.setattr(workflow_modes,'WORKFLOWS_DIR',service.workflows)
    monkeypatch.setattr(config,'RUNTIME_ROOT',service.workflows.parent)
    def failure(reader,target):
        if forward_failure and target.parent.name=='Lab' and target.name.endswith('.rules.json'):
            raise OSError('injected forward failure')
        if target.parent.name=='.refile-history':raise OSError('injected journal retirement failure')
        return original(reader,target)
    monkeypatch.setattr(library_refile,'rename_open_file',failure)
    with pytest.raises(HTTPException) as error:
        await local_machine.refile_library_workflows(strict=False)
    assert error.value.status_code==503
    assert 'journal retirement' in error.value.detail
    graph_path=service.workflows/name if forward_failure else service.workflows/'Lab'/name
    assert graph_path.read_bytes()==graph
    assert len(list((service.workflows/'.refile-pending').glob('*.json')))==1
    assert service.metadata[name]['group']=='Active'  # Not returned as a successful picker result.
    with pytest.raises(HTTPException) as retry:
        await local_machine.refile_library_workflows(strict=False)
    assert retry.value.status_code==503
    assert 'retained operation journals' in retry.value.detail
