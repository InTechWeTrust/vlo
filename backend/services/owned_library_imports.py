"""Immutable bound graphs and append-only consultation receipts owned by VLO.

The first receipt stays at its legacy filename for compatibility. Subsequent
imports are appended under a hidden history directory; all readers select the
latest completed consultation while preserving the original binding evidence.
"""
from contextlib import ExitStack
import json
import os
from pathlib import Path
from uuid import uuid4

from services.owned_workflow_moves import pinned_directory,owned_directory,opened_reader,created_writer,rename_open_file
from services.workflow_bundles import find_workflow


def _read(path):
    with pinned_directory(path.parent),opened_reader(path) as reader:
        return json.loads(reader.read().decode('utf-8'))


def _publish(parent,name,payload):
    # A failed write remains hidden and retained, never a partial visible JSON.
    with pinned_directory(parent):
        temporary=parent/('.import-pending-'+uuid4().hex)
        with created_writer(temporary) as writer:
            writer.write(json.dumps(payload,ensure_ascii=False).encode('utf-8'))
            writer.flush();os.fsync(writer.fileno())
            rename_open_file(writer,parent/name)


def read_receipt(receipts,workflow_id):
    if Path(workflow_id).name!=workflow_id or '..' in workflow_id:raise ValueError('Invalid workflow ID')
    receipts=Path(receipts)
    original=_read(receipts/(workflow_id+'.json'))
    history=receipts/'.history'/workflow_id
    if not history.exists():return original
    with pinned_directory(history):
        candidates=sorted(history.glob('*.json'))
        latest=_read(candidates[-1]) if candidates else original
    for field in ('workflow_id','preset_id','source_hash','bound_graph_sha256'):
        if latest.get(field)!=original.get(field):raise ValueError('Consultation history changed the immutable binding')
    return latest


def publish_import(runtime,workflow_id,graph,manifest,graph_hash):
    runtime=Path(runtime)
    if Path(workflow_id).name!=workflow_id or '..' in workflow_id:raise ValueError('Invalid workflow ID')
    workflows=runtime/'workflows';receipts=runtime/'library_receipts'
    with ExitStack() as stack:
        stack.enter_context(owned_directory(runtime))
        for directory in (workflows,receipts):
            directory.mkdir(exist_ok=True)
            stack.enter_context(pinned_directory(directory))
        existing=find_workflow([workflows],workflow_id)
        if existing is None:
            _publish(workflows,workflow_id,graph)
        elif graph_hash(_read(existing))!=manifest['bound_graph_sha256']:
            raise ValueError('Pinned workflow ID already has different graph bytes; existing project kept')
        original=receipts/(workflow_id+'.json')
        if original.exists():
            first=_read(original)
            for field in ('workflow_id','preset_id','source_hash','bound_graph_sha256'):
                if first.get(field)!=manifest.get(field):raise ValueError('Pinned receipt binding differs; existing evidence kept')
        else:
            _publish(receipts,original.name,manifest)
        history_parent=receipts/'.history';history_parent.mkdir(exist_ok=True)
        stack.enter_context(pinned_directory(history_parent))
        history=history_parent/workflow_id;history.mkdir(exist_ok=True)
        stack.enter_context(pinned_directory(history))
        with created_writer(history/('.import-pending-'+uuid4().hex)) as writer:
            writer.write(json.dumps(manifest,ensure_ascii=False).encode('utf-8'))
            writer.flush();os.fsync(writer.fileno())
            while True:
                sequences=[int(path.stem) for path in history.glob('*.json') if path.stem.isdigit()]
                sequence=max(sequences,default=0)+1
                try:
                    rename_open_file(writer,history/f'{sequence:020d}.json')
                    break
                except OSError as error:
                    if error.errno not in {80,183}:raise
