"""Print the optional profiles an earlier install already chose, one per line.

install.sh and install.bat run this with the backend venv's Python so a rerun,
including every update, keeps the profiles the user picked the first time
instead of asking again with a default of "no". A profile counts as chosen when
the last installer run recorded it as requested (even if that install failed,
so it is retried), or when its package is already importable, which also covers
profiles installed later from inside the app.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys

PROFILE_MODULES = {
    "sam2": "sam2",
    "sam-audio": "sam_audio",
}


def recorded_profiles(marker_path: str) -> dict[str, object]:
    try:
        with open(marker_path, encoding="utf-8") as marker:
            profiles = json.load(marker).get("profiles", {})
    except (OSError, ValueError, AttributeError):
        return {}
    return profiles if isinstance(profiles, dict) else {}


def main() -> None:
    # A source checkout such as backend/sam2 in the working directory would
    # otherwise look installed without being in the venv.
    cwd = os.getcwd()
    sys.path[:] = [entry for entry in sys.path if entry not in ("", cwd)]

    profiles = recorded_profiles(sys.argv[1]) if len(sys.argv) > 1 else {}
    for profile, module in PROFILE_MODULES.items():
        entry = profiles.get(profile)
        requested = isinstance(entry, dict) and entry.get("requested") is True
        if requested or importlib.util.find_spec(module) is not None:
            print(profile)


if __name__ == "__main__":
    main()
