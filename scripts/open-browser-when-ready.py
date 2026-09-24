"""Open the vlo UI in a browser once the backend is actually serving.

run.sh / run.bat start this in the background before uvicorn. Opening the tab
on a fixed delay raced the backend's import + lifespan startup, so the first
page load usually hit a refused connection. uvicorn only accepts connections
after lifespan startup completes, so any HTTP response means the app is ready.
"""

import argparse
import sys
import time
import urllib.error
import urllib.request
import webbrowser

POLL_INTERVAL_SECONDS = 0.5


def server_is_ready(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2):
            return True
    except urllib.error.HTTPError:
        # A 404 (e.g. frontend not built) still proves the server is up.
        return True
    except (urllib.error.URLError, OSError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args()

    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        if server_is_ready(args.url):
            webbrowser.open(args.url)
            return 0
        time.sleep(POLL_INTERVAL_SECONDS)

    # Startup failed or is unusually slow; the server log explains which, and
    # the URL is already printed, so stay quiet rather than open a dead tab.
    return 1


if __name__ == "__main__":
    sys.exit(main())
