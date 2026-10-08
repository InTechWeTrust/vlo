"""Windows acquired-leaf moves for VLO-owned workflow families.

Uses the same deny-delete directory and deny-write source sharing contract as
Ruby's media_library and quality_sources, without importing the app/database.
"""
from contextlib import contextmanager
import os
from pathlib import Path
import stat


def _api():
    import ctypes
    from ctypes import wintypes as w
    api=ctypes.WinDLL('kernel32',use_last_error=True)
    api.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,w.LPVOID,w.DWORD,w.DWORD,w.HANDLE]
    api.CreateFileW.restype=w.HANDLE
    api.GetFinalPathNameByHandleW.argtypes=[w.HANDLE,w.LPWSTR,w.DWORD,w.DWORD]
    api.CloseHandle.argtypes=[w.HANDLE]
    api.SetFileInformationByHandle.argtypes=[w.HANDLE,w.DWORD,w.LPVOID,w.DWORD]
    api.SetFileInformationByHandle.restype=w.BOOL
    return api,ctypes,w


def is_link(path):
    try: return bool(path.lstat().st_file_attributes & 0x400)
    except FileNotFoundError:return False


def _final(api,ctypes,handle):
    buffer=ctypes.create_unicode_buffer(32768)
    count=api.GetFinalPathNameByHandleW(handle,buffer,len(buffer),0)
    if not count or count>=len(buffer):raise OSError('Cannot resolve native file handle')
    value=buffer.value
    value='\\\\'+value[8:] if value.startswith('\\\\?\\UNC\\') else value.removeprefix('\\\\?\\')
    return Path(value)


@contextmanager
def pinned_directory(path):
    if os.name!='nt':raise OSError('Retained native writers require the reviewed Windows handle adapter')
    path=Path(path).absolute()
    api,ctypes,w=_api();handles=[]
    try:
        for current in reversed((path,*path.parents)):
            if is_link(current):raise OSError('Native writer cannot pin a reparse point')
            handle=api.CreateFileW(str(current),0x80000000,3,None,3,0x02000000,None)
            if handle==w.HANDLE(-1).value:raise OSError(ctypes.get_last_error(),'Cannot pin native writer directory')
            handles.append(handle)
            if _final(api,ctypes,handle)!=current or is_link(current):raise OSError('Native directory handle changed')
        yield path
    finally:
        for handle in reversed(handles):api.CloseHandle(handle)


@contextmanager
def opened_reader(path,*,rename=False):
    if os.name!='nt':raise OSError('Retained native sources require the reviewed Windows handle adapter')
    import msvcrt
    path=Path(path).absolute();api,ctypes,w=_api()
    if is_link(path):raise OSError('Native source cannot be a reparse point')
    handle=api.CreateFileW(str(path),0x80000000|(0x10000 if rename else 0),1,None,3,0x00200000,None)
    if handle==w.HANDLE(-1).value:raise OSError(ctypes.get_last_error(),'Cannot pin native source')
    try:
        if _final(api,ctypes,handle)!=path or is_link(path):raise OSError('Native source handle changed')
        descriptor=msvcrt.open_osfhandle(handle,os.O_RDONLY|os.O_BINARY);handle=None
        with os.fdopen(descriptor,'rb') as stream:
            before=os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1:raise OSError('Native source must be a single-link file')
            yield stream
            after=os.fstat(stream.fileno())
            if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):
                raise OSError('Native source changed while reading')
    finally:
        if handle is not None:api.CloseHandle(handle)


def rename_open_file(stream,target):
    """Rename the acquired leaf itself, failing on any existing destination."""
    import msvcrt
    api,ctypes,w=_api()
    class RenameInfo(ctypes.Structure):
        _fields_=[('ReplaceIfExists',w.BOOL),('RootDirectory',w.HANDLE),
                  ('FileNameLength',w.DWORD),('FileName',w.WCHAR*1)]
    encoded=str(Path(target).absolute()).encode('utf-16-le')
    size=RenameInfo.FileName.offset+len(encoded)
    buffer=ctypes.create_string_buffer(max(size+2,ctypes.sizeof(RenameInfo)))
    info=RenameInfo.from_buffer(buffer)
    info.ReplaceIfExists=False;info.RootDirectory=None;info.FileNameLength=len(encoded)
    ctypes.memmove(ctypes.addressof(buffer)+RenameInfo.FileName.offset,encoded,len(encoded))
    if not api.SetFileInformationByHandle(msvcrt.get_osfhandle(stream.fileno()),3,buffer,len(buffer)):
        raise OSError(ctypes.get_last_error(),'Cannot publish acquired native file without replacement',str(target))


@contextmanager
def created_writer(path):
    """Acquire a fresh leaf without truncation or path-based publication."""
    import msvcrt
    path=Path(path).absolute();api,ctypes,w=_api()
    handle=api.CreateFileW(str(path),0xC0010000,1,None,1,0x00200000,None)
    if handle==w.HANDLE(-1).value:raise OSError(ctypes.get_last_error(),'Cannot create owned workflow file')
    try:
        if _final(api,ctypes,handle)!=path or is_link(path):raise OSError('Owned writer handle changed')
        descriptor=msvcrt.open_osfhandle(handle,os.O_RDWR|os.O_BINARY);handle=None
        with os.fdopen(descriptor,'w+b') as stream:
            if os.fstat(stream.fileno()).st_nlink!=1:raise OSError('Owned writer must be a single-link file')
            yield stream
    finally:
        if handle is not None:api.CloseHandle(handle)


@contextmanager
def owned_directory(path):
    """Create missing children only while their admitted ancestors stay pinned."""
    from contextlib import ExitStack
    path=Path(path).absolute();missing=[];existing=path
    while not existing.exists():
        missing.append(existing);existing=existing.parent
    with ExitStack() as stack:
        stack.enter_context(pinned_directory(existing))
        for child in reversed(missing):
            child.mkdir(exist_ok=True)
            stack.enter_context(pinned_directory(child))
        yield path
