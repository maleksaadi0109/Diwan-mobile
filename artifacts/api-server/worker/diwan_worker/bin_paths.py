"""Resolves paths to external binaries (ffmpeg/ffprobe) the worker shells out to.

`DIWAN_FFMPEG_PATH` and `DIWAN_FFPROBE_PATH` may override the binaries'
locations; otherwise they are resolved through PATH.

Always import `ffmpeg_path()` / `ffprobe_path()` instead of hardcoding
"ffmpeg"/"ffprobe", so every call site uses the configured executable.
"""
from __future__ import annotations
import os
from typing import Optional


def ffmpeg_path() -> str:
    return os.environ.get("DIWAN_FFMPEG_PATH") or "ffmpeg"


def ffprobe_path() -> str:
    return os.environ.get("DIWAN_FFPROBE_PATH") or "ffprobe"


def ffmpeg_dir() -> Optional[str]:
    """Directory containing a configured ffmpeg/ffprobe binary, if any.

    Used for yt-dlp's `ffmpeg_location` option so its own postprocessors
    (audio extraction/remux) also use the configured binaries instead of
    searching PATH.
    """
    p = os.environ.get("DIWAN_FFMPEG_PATH")
    return os.path.dirname(p) if p else None


def subprocess_creation_flags() -> int:
    """Returns CREATE_NO_WINDOW on Windows so child processes (ffmpeg/ffprobe)
    never open or flash a console window.
    """
    import sys
    import subprocess
    if sys.platform == "win32":
        return getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    return 0

