"""VLO owns state filing of its pinned Ruby imports; never writes Ruby files."""
import asyncio
from contextlib import ExitStack
from copy import deepcopy
from services.owned_workflow_moves import pinned_directory,opened_reader,rename_open_file
import json
from uuid import uuid4
import os
from pathlib import Path
import re
import time

from services.workflow_bundles import sidecar_name_for_workflow,how_to_name_for_workflow
from services.owned_library_imports import read_receipt, _publish

GROUPS={'active':'Active','lab':'Lab','old':'Old'}


class UnresolvedLibraryFiling(ValueError):
    pass


def assert_no_pending(workflows):
    pending=Path(workflows)/'.refile-pending'
    if pending.exists():
        with pinned_directory(pending):
            journals=sorted(pending.glob('*.json'))
            if journals:raise UnresolvedLibraryFiling('Unresolved Library filing; retained operation journals: '+', '.join(str(path) for path in journals))


def _retire_journal(reader,target):
    try:
        rename_open_file(reader,target)
    except OSError as error:
        raise UnresolvedLibraryFiling('Unresolved Library filing journal retirement; operation evidence retained, target: '+str(target)) from error


def _safe_name(name):
    if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*\.json',name) or '..' in name or '_ruby_' not in name:
        raise ValueError('Invalid owned Ruby workflow ID')
    return name


def _plain(path):
    # Refuse links before moving. Imported graph bytes remain pinned; source
    # metadata is returned separately and never overwrites a bound graph.
    for current in (path,*path.parents):
        if current.is_symlink() or getattr(current,'is_junction',lambda:False)():
            raise ValueError('Library filing cannot traverse links')
    return path


class LibraryRefiler:
    def __init__(self,workflows,receipts,*,clock=time.monotonic,ttl=60):
        self.workflows=Path(workflows);self.receipts=Path(receipts)
        self.clock=clock;self.ttl=ttl;self.checked_at=None;self.metadata={}
        self.lock=asyncio.Lock()

    async def refresh(self,fetch_catalogue,*,force=False):
        async with self.lock:
            assert_no_pending(self.workflows)
            if not force and self.checked_at is not None and self.clock()-self.checked_at<self.ttl:
                return deepcopy(self.metadata)
            entries=await fetch_catalogue()
            if not isinstance(entries,list):raise ValueError('Ruby state catalogue is not a list')
            by_owner={}
            for entry in entries:
                if not isinstance(entry,dict) or entry.get('owner_id') is None:raise ValueError('Invalid Library owner entry')
                key=str(entry['owner_id'])
                if key in by_owner:raise ValueError('Ambiguous Library owner entry')
                by_owner[key]=entry
            metadata={};plans=[];seen=set()
            if self.receipts.exists():
                _plain(self.receipts);_plain(self.workflows)
                for receipt_file in sorted(self.receipts.glob('*.json')):
                    _plain(receipt_file)
                    receipt=read_receipt(self.receipts,receipt_file.name.removesuffix('.json'))
                    name=_safe_name(receipt.get('workflow_id'))
                    if name in seen:raise ValueError('Duplicate owned workflow receipt')
                    seen.add(name)
                    source=by_owner.get(str(receipt.get('preset_id')))
                    if source is None:
                        metadata[name]={'source_missing':True,'stale':True}
                        continue
                    state=source.get('state')
                    if state not in GROUPS:raise ValueError('Ruby returned an unknown Library state')
                    group=GROUPS[state]
                    target_dir=self.workflows if state=='active' else self.workflows/group
                    locations=[self.workflows/name,self.workflows/'Lab'/name,self.workflows/'Old'/name]
                    found=[_plain(path) for path in locations if path.is_file()]
                    if len(found)!=1:raise ValueError(f'Owned workflow has missing or duplicate copies: {name}')
                    origin=found[0].parent
                    target_dir=_plain(target_dir)
                    moves=[]
                    for filename in (name,sidecar_name_for_workflow(name),how_to_name_for_workflow(name)):
                        old=_plain(origin/filename);new=_plain(target_dir/filename)
                        if old.is_file() and old!=new:
                            if new.exists():raise ValueError(f'Filing destination already exists: {filename}')
                            moves.append((old,new))
                    if moves:plans.append((target_dir,moves))
                    changed=source.get('content_hash')!=receipt.get('source_hash') or source.get('revision')!=receipt.get('source_revision')
                    metadata[name]={'group':group,'library_state':state,'stale':state=='active' and changed,
                        'source_revision':source.get('revision'),'source_hash':source.get('content_hash')}
            # Preflight every receipt before the first move. Acquire all
            # actual source leaves and deny ancestor replacement for the batch.
            completed=[]
            with ExitStack() as stack:
                readers=[]
                if plans:
                    stack.enter_context(pinned_directory(_plain(self.workflows)))
                    for target_dir,moves in plans:
                        target_dir.mkdir(parents=True,exist_ok=True)
                        stack.enter_context(pinned_directory(_plain(target_dir)))
                        for old,new in moves:
                            stack.enter_context(pinned_directory(_plain(old.parent)))
                            readers.append((stack.enter_context(opened_reader(_plain(old),rename=True)),old,new))
                journal_reader=None;completed_journal=None
                if readers:
                    pending=self.workflows/'.refile-pending';history=self.workflows/'.refile-history'
                    for directory in (pending,history):
                        directory.mkdir(exist_ok=True)
                        stack.enter_context(pinned_directory(directory))
                    journal_name=uuid4().hex+'.json'
                    _publish(pending,journal_name,{'moves':[{'old':str(old.relative_to(self.workflows)),
                        'new':str(new.relative_to(self.workflows))} for _,old,new in readers]})
                    journal_reader=stack.enter_context(opened_reader(pending/journal_name,rename=True))
                    completed_journal=history/journal_name
                try:
                    for reader,old,new in readers:
                        rename_open_file(reader,new);completed.append((reader,old,new))
                except Exception as forward_error:
                    unresolved=[]
                    for reader,old,new in reversed(completed):
                        try:
                            # NoReplace must refuse a competing original name.
                            rename_open_file(reader,old)
                        except Exception as undo_error:
                            unresolved.append({'old':str(old),'new':str(new),'reason':str(undo_error)})
                    if unresolved:
                        raise UnresolvedLibraryFiling('Incomplete Library filing rollback; original and relocated bytes retained: '+json.dumps(unresolved)) from forward_error
                    if journal_reader is not None:_retire_journal(journal_reader,completed_journal)
                    raise
                if journal_reader is not None:_retire_journal(journal_reader,completed_journal)
            self.metadata=metadata;self.checked_at=self.clock()
            return deepcopy(metadata)


def workflow_state_metadata(path,metadata):
    # Existing unregistered VLO built-ins keep their legacy Active behaviour;
    # registration debt is enumerated explicitly in the #185 PR inventory.
    group=path.parent.name if path.parent.name in {'Lab','Old'} else 'Active'
    return {'group':group,'library_state':group.lower(),**metadata.get(path.name,{})}
