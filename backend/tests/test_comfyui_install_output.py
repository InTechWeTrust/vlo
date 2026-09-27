from services.comfyui.install_output import InstallOutputTracker


def test_latest_is_the_last_non_blank_line_without_colour() -> None:
    tracker = InstallOutputTracker()

    echoed = tracker.feed(b"Collecting torch\n\x1b[33mwarning\x1b[0m\n\n")

    assert tracker.latest == "warning"
    assert echoed == "Collecting torch\n\x1b[33mwarning\x1b[0m\n\n"


def test_a_line_split_across_chunks_is_reported_once_complete() -> None:
    tracker = InstallOutputTracker()

    tracker.feed(b"Collecting to")
    assert tracker.latest is None

    assert tracker.feed(b"rch\n") == "Collecting torch\n"
    assert tracker.latest == "Collecting torch"


def test_a_multibyte_character_split_across_chunks_survives() -> None:
    tracker = InstallOutputTracker()
    encoded = "Installing … done\n".encode()
    split = encoded.index("…".encode()) + 1

    tracker.feed(encoded[:split])
    tracker.feed(encoded[split:])

    assert tracker.latest == "Installing … done"


def test_carriage_return_redraws_count_as_lines() -> None:
    tracker = InstallOutputTracker()

    tracker.feed(b"Receiving objects:  10%\rReceiving objects:  55%\r")

    assert tracker.latest == "Receiving objects:  55%"


def test_final_flushes_an_unterminated_tail() -> None:
    tracker = InstallOutputTracker()
    tracker.feed(b"Successfully installed torch")

    assert tracker.feed(b"", final=True) == "Successfully installed torch"
    assert tracker.latest == "Successfully installed torch"


def test_raw_pip_progress_becomes_a_percentage_on_its_download() -> None:
    tracker = InstallOutputTracker()

    echoed = tracker.feed(
        b"Downloading torch-2.12.0-cp314-cp314-linux_x86_64.whl (900.0 MB)\n"
        b"Progress 0 of 1000\n"
        b"Progress 437 of 1000\n"
    )

    assert tracker.latest == "Downloading torch-2.12.0 (900.0 MB) — 43%"
    # The terminal keeps the human line, not the machine-readable ones.
    assert "Progress" not in echoed

    tracker.feed(b"Installing collected packages: torch\n")
    assert tracker.latest == "Installing collected packages: torch"


def test_a_download_url_is_labelled_by_its_package() -> None:
    tracker = InstallOutputTracker()

    tracker.feed(
        b"Downloading https://download.pytorch.org/whl/cu130/"
        b"torch-2.12.0%2Bcu130-cp314-cp314-win_amd64.whl (2.5 GB)\n"
        b"Progress 1 of 4\n"
    )

    assert tracker.latest == "Downloading torch-2.12.0+cu130 (2.5 GB) — 25%"
