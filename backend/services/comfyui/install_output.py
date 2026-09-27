"""The one line of an install command's output worth showing the user."""

from __future__ import annotations

import codecs
import re
from urllib.parse import unquote

# Captured so each line keeps its own terminator when echoed. A lone "\r" is a
# line too: progress meters redraw in place with it.
_LINE_BREAK = re.compile(r"(\r\n|\r|\n)")
# ComfyUI colours its log levels even when writing to a file.
_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
# `pip --progress-bar raw`: one machine-readable line per chunk of a download.
_PIP_RAW_PROGRESS = re.compile(r"^Progress (\d+) of (\d+)$")
# Older pips print the URL rather than the file name.
_PIP_DOWNLOAD = re.compile(r"^Downloading (?:\S*/)?(\S+?)(?: \((.+)\))?$")
_MAX_LINE_CHARS = 500
# A redraw with no terminator at all would otherwise grow without bound.
_MAX_PENDING_CHARS = 16 * 1024


class InstallOutputTracker:
    """Follow an install command's output as it streams in.

    ``latest`` is the most recent non-blank line, except that pip's raw
    progress lines become a percentage on the download they belong to.
    """

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._pending = ""
        self._download: str | None = None
        self.latest: str | None = None

    def feed(self, chunk: bytes, *, final: bool = False) -> str:
        """Consume a chunk and return the text to echo to the terminal.

        Raw progress lines are left out of the echo: they are the machine
        form of a bar that pip would otherwise not draw into a pipe at all.
        """

        text = self._pending + self._decoder.decode(chunk, final=final)
        parts = _LINE_BREAK.split(text)
        # split() alternates segment, terminator, ..., with the unterminated
        # tail last.
        tail = parts.pop()
        if final or len(tail) > _MAX_PENDING_CHARS:
            parts.extend([tail, ""])
            tail = ""
        self._pending = tail

        echo: list[str] = []
        for segment, terminator in zip(parts[::2], parts[1::2]):
            line = _ANSI_ESCAPE.sub("", segment).strip()
            progress = _PIP_RAW_PROGRESS.match(line)
            if progress:
                self._show_progress(int(progress[1]), int(progress[2]))
                continue
            echo.append(segment + terminator)
            if not line:
                continue
            download = _PIP_DOWNLOAD.match(line)
            if download:
                self._download = _download_label(download[1], download[2])
            self.latest = line[:_MAX_LINE_CHARS]
        return "".join(echo)

    def _show_progress(self, done: int, total: int) -> None:
        if total <= 0:
            return
        percent = min(100, done * 100 // total)
        self.latest = f"{self._download or 'Downloading'} — {percent}%"[:_MAX_LINE_CHARS]


def _download_label(filename: str, size: str | None) -> str:
    """Short enough that the percentage after it survives the UI's ellipsis.

    A wheel's name carries its tags after the version
    (``torch-2.12.0+cu130-cp314-cp314-win_amd64.whl``); the first two fields
    are the part a person recognises.
    """

    filename = unquote(filename)
    if filename.endswith(".whl"):
        filename = "-".join(filename.split("-")[:2])
    return f"Downloading {filename}" + (f" ({size})" if size else "")
