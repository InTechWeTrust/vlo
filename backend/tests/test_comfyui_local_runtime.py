import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from services import runtime_settings
from services.comfyui import local_runtime
from services.comfyui.local_runtime import (
    COMFYUI_REPOSITORY_URL,
    MANAGED_CUSTOM_NODE_REPOSITORY_URLS,
    ComfyuiPythonEnvironmentRequired,
    ComfyuiLocalRuntime,
    DirectoryPickerBusyError,
    _environment_python,
    verify_comfyui_install,
)


@pytest.fixture(autouse=True)
def _git_on_path(monkeypatch):
    """Keep the git preflight deterministic regardless of the host machine."""

    real_which = shutil.which
    monkeypatch.setattr(
        local_runtime.shutil,
        "which",
        lambda cmd, *args, **kwargs: (
            "/usr/bin/git" if cmd == "git" else real_which(cmd, *args, **kwargs)
        ),
    )


_REAL_TORCH_HAS_CUDA = ComfyuiLocalRuntime._torch_has_cuda


@pytest.fixture(autouse=True)
def _cuda_torch_already_present(monkeypatch):
    """Keep install-worker tests from executing the stub venv interpreter."""

    monkeypatch.setattr(
        ComfyuiLocalRuntime,
        "_torch_has_cuda",
        lambda self, python, cwd: True,
    )


@pytest.fixture(autouse=True)
def _isolated_launch_log(tmp_path_factory, monkeypatch) -> Path:
    """Keep launch tests from appending to the real backend/runtime log."""

    runtime_root = tmp_path_factory.mktemp("vlo-runtime")
    monkeypatch.setattr(local_runtime, "RUNTIME_ROOT", runtime_root)
    return runtime_root


def _without_git(monkeypatch) -> None:
    monkeypatch.setattr(
        local_runtime.shutil,
        "which",
        lambda cmd, *args, **kwargs: None if cmd == "git" else shutil.which(cmd),
    )


def _write_comfyui_checkout(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "comfy").mkdir(exist_ok=True)
    (path / "main.py").write_text(
        "import comfy.options\n"
        "from comfy.cli_args import args\n"
        "import execution\n"
        "server.PromptServer()\n",
        encoding="utf-8",
    )
    for filename in ("nodes.py", "server.py", "folder_paths.py"):
        (path / filename).write_text("", encoding="utf-8")
    (path / "requirements.txt").write_text("aiohttp\n", encoding="utf-8")


def test_managed_custom_nodes_match_readme_except_wan_video_wrapper() -> None:
    readme = (Path(__file__).parents[2] / "README.md").read_text(encoding="utf-8")
    custom_nodes_block = readme.split(
        "<!-- comfyui-custom-nodes:start -->",
        1,
    )[1].split("<!-- comfyui-custom-nodes:end -->", 1)[0]
    readme_urls = re.findall(
        r"^- (https://github\.com/\S+)$",
        custom_nodes_block,
        re.MULTILINE,
    )

    expected_urls = [
        url for url in readme_urls if not url.endswith("/ComfyUI-WanVideoWrapper")
    ]
    assert not any(
        url.endswith("/ComfyUI-SeedVR2_VideoUpscaler") for url in readme_urls
    )
    assert not any(
        url.endswith("/ComfyUI-SeedVR2_VideoUpscaler")
        for url in MANAGED_CUSTOM_NODE_REPOSITORY_URLS
    )
    assert (
        "https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3"
        in MANAGED_CUSTOM_NODE_REPOSITORY_URLS
    )
    assert list(MANAGED_CUSTOM_NODE_REPOSITORY_URLS) == expected_urls


def test_verification_accepts_nested_portable_layout(tmp_path: Path) -> None:
    checkout = tmp_path / "ComfyUI_windows_portable" / "ComfyUI"
    _write_comfyui_checkout(checkout)

    verification = verify_comfyui_install(checkout.parent)

    assert verification["valid"] is True
    assert verification["installPath"] == str(checkout.resolve())
    assert "argument parser" in verification["sourceMarkers"]
    assert "nodes.py" in verification["layoutMarkers"]


def test_verification_rejects_unrelated_main_py(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("print('not ComfyUI')", encoding="utf-8")

    verification = verify_comfyui_install(tmp_path)

    assert verification["valid"] is False
    assert verification["mainPyPresent"] is True
    assert verification["sourceMarkers"] == []


def test_installer_clones_creates_venv_installs_and_persists(
    tmp_path: Path,
    monkeypatch,
) -> None:
    manager = ComfyuiLocalRuntime()
    target = tmp_path / "ComfyUI"
    commands: list[tuple[list[str], Path | None]] = []
    persisted: list[dict[str, object]] = []

    def fake_run(command: list[str], cwd: Path | None = None) -> None:
        commands.append((command, cwd))
        if command[:4] == ["git", "clone", "--depth", "1"]:
            clone_target = Path(command[-1])
            if clone_target == target:
                _write_comfyui_checkout(target)
            else:
                clone_target.mkdir(parents=True)
                (clone_target / "requirements.txt").write_text(
                    f"{clone_target.name}-dependency\n",
                    encoding="utf-8",
                )
        if command[1:3] == ["-m", "venv"]:
            python = target / ".venv" / "bin" / "python"
            python.parent.mkdir(parents=True)
            python.write_text("", encoding="utf-8")

    monkeypatch.setattr(manager, "_run_install_command", fake_run)
    monkeypatch.setattr(
        runtime_settings,
        "update_runtime_settings",
        lambda **kwargs: persisted.append(kwargs),
    )

    manager._install_worker(target)

    status = manager.get_install_status()
    assert status["phase"] == "complete"
    assert status["running"] is False
    assert commands[0][0] == [
        "git",
        "clone",
        "--depth",
        "1",
        COMFYUI_REPOSITORY_URL,
        str(target),
    ]
    custom_node_clone_urls = [
        command[0][4]
        for command in commands
        if command[0][:4] == ["git", "clone", "--depth", "1"]
        and command[0][4] != COMFYUI_REPOSITORY_URL
    ]
    assert custom_node_clone_urls == list(MANAGED_CUSTOM_NODE_REPOSITORY_URLS)
    assert all("WanVideoWrapper" not in url for url in custom_node_clone_urls)
    custom_node_requirement_installs = [
        command
        for command, _cwd in commands
        if command[:4] == [
            str(target / ".venv" / "bin" / "python"),
            "-m",
            "pip",
            "install",
        ]
        and Path(command[-1]).parent.parent.name == "custom_nodes"
    ]
    assert len(custom_node_requirement_installs) == len(
        MANAGED_CUSTOM_NODE_REPOSITORY_URLS
    )
    assert persisted == [
        {
            "comfyui_install_dir": str(target.resolve()),
            "comfyui_install_dir_prompt_status": "accepted",
        }
    ]


def test_install_reports_a_missing_git_before_starting_work(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _without_git(monkeypatch)
    manager = ComfyuiLocalRuntime()

    with pytest.raises(ValueError, match="git is required"):
        manager.start_install(tmp_path)

    assert manager.get_install_status()["phase"] == "idle"
    assert manager.get_install_status()["running"] is False
    assert list(tmp_path.iterdir()) == []


def test_environment_setup_reports_a_missing_git_before_starting_work(
    tmp_path: Path,
    monkeypatch,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    _without_git(monkeypatch)
    manager = ComfyuiLocalRuntime()

    with pytest.raises(ValueError, match="git is required"):
        manager.start_environment_setup(checkout)

    assert manager.get_install_status()["running"] is False
    assert not (checkout / ".venv").exists()


def test_install_refuses_to_mutate_an_existing_checkout(tmp_path: Path) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    manager = ComfyuiLocalRuntime()

    with pytest.raises(ValueError, match="already installed"):
        manager.start_install(tmp_path)


def test_environment_setup_skips_clone_for_existing_checkout(
    tmp_path: Path,
    monkeypatch,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    commands: list[list[str]] = []
    manager = ComfyuiLocalRuntime()

    def fake_run(command: list[str], cwd: Path | None = None) -> None:
        del cwd
        commands.append(command)
        if command[1:3] == ["-m", "venv"]:
            python = checkout / ".venv" / "bin" / "python"
            python.parent.mkdir(parents=True)
            python.write_text("", encoding="utf-8")
        if command[:4] == ["git", "clone", "--depth", "1"]:
            Path(command[-1]).mkdir(parents=True)

    monkeypatch.setattr(manager, "_run_install_command", fake_run)
    monkeypatch.setattr(runtime_settings, "update_runtime_settings", lambda **_kwargs: None)

    manager._install_worker(
        checkout,
        clone_checkout=False,
        completion_message="Environment ready.",
    )

    assert all(
        command[:5]
        != ["git", "clone", "--depth", "1", COMFYUI_REPOSITORY_URL]
        for command in commands
    )
    assert [
        command[4]
        for command in commands
        if command[:4] == ["git", "clone", "--depth", "1"]
    ] == list(MANAGED_CUSTOM_NODE_REPOSITORY_URLS)
    assert commands[0][1:3] == ["-m", "venv"]
    assert manager.get_install_status()["message"] == "Environment ready."


def _install_with_stubbed_commands(
    manager: ComfyuiLocalRuntime,
    target: Path,
    monkeypatch,
    *,
    fail_cuda_torch: bool = False,
    torch_has_cuda: tuple[bool, ...] = (True,),
    manager_requirements: bool = False,
) -> list[list[str]]:
    commands: list[list[str]] = []
    checks = list(torch_has_cuda)

    def fake_run(command: list[str], cwd: Path | None = None) -> None:
        del cwd
        commands.append(command)
        if command[:4] == ["git", "clone", "--depth", "1"]:
            clone_target = Path(command[-1])
            if clone_target == target:
                _write_comfyui_checkout(target)
                if manager_requirements:
                    (target / local_runtime.MANAGER_REQUIREMENTS_FILENAME).write_text(
                        "comfyui_manager==4.2.2\n",
                        encoding="utf-8",
                    )
            else:
                clone_target.mkdir(parents=True)
        if command[1:3] == ["-m", "venv"]:
            python = target / ".venv" / "bin" / "python"
            python.parent.mkdir(parents=True)
            python.write_text("", encoding="utf-8")
        if fail_cuda_torch and local_runtime.TORCH_CUDA_INDEX_URL in command:
            raise subprocess.CalledProcessError(1, command)

    def fake_torch_has_cuda(python: Path, cwd: Path) -> bool:
        del python, cwd
        commands.append(["<torch cuda check>"])
        return checks.pop(0) if len(checks) > 1 else checks[0]

    monkeypatch.setattr(manager, "_run_install_command", fake_run)
    monkeypatch.setattr(manager, "_torch_has_cuda", fake_torch_has_cuda)
    monkeypatch.setattr(runtime_settings, "update_runtime_settings", lambda **_kwargs: None)
    manager._install_worker(target)
    return commands


def _index_of(commands: list[list[str]], predicate) -> int:
    return next(index for index, command in enumerate(commands) if predicate(command))


def test_installer_installs_the_bundled_manager_after_comfyui_requirements(
    tmp_path: Path,
    monkeypatch,
) -> None:
    manager = ComfyuiLocalRuntime()
    target = tmp_path / "ComfyUI"

    commands = _install_with_stubbed_commands(
        manager,
        target,
        monkeypatch,
        manager_requirements=True,
    )

    requirements_index = _index_of(
        commands, lambda command: command[-2:] == ["-r", "requirements.txt"]
    )
    manager_index = _index_of(
        commands,
        lambda command: command[-2:]
        == ["-r", local_runtime.MANAGER_REQUIREMENTS_FILENAME],
    )
    assert requirements_index < manager_index
    assert commands[manager_index][:4] == [
        str(target / ".venv" / "bin" / "python"),
        "-m",
        "pip",
        "install",
    ]
    assert manager.get_install_status()["phase"] == "complete"


def test_installer_skips_the_manager_for_checkouts_without_it(
    tmp_path: Path,
    monkeypatch,
) -> None:
    manager = ComfyuiLocalRuntime()
    target = tmp_path / "ComfyUI"

    commands = _install_with_stubbed_commands(manager, target, monkeypatch)

    assert not any(
        command[-2:] == ["-r", local_runtime.MANAGER_REQUIREMENTS_FILENAME]
        for command in commands
    )
    assert manager.get_install_status()["phase"] == "complete"


def test_cuda_torch_policy_does_not_depend_on_detecting_a_gpu() -> None:
    assert local_runtime._installs_cuda_torch_first(platform_name="nt") is True
    assert local_runtime._installs_cuda_torch_first(platform_name="posix") is False
    assert local_runtime._requires_cuda_torch(platform_name="win32") is True
    assert local_runtime._requires_cuda_torch(platform_name="linux") is True
    assert local_runtime._requires_cuda_torch(platform_name="darwin") is False


@pytest.mark.parametrize(("cuda_version", "expected"), [('"13.0"', True), ("None", False)])
def test_torch_cuda_check_reads_the_environments_torch_build(
    tmp_path: Path,
    cuda_version: str,
    expected: bool,
) -> None:
    # `python -c` puts the working directory first on sys.path, so this stand-in
    # is the torch the check imports.
    (tmp_path / "torch.py").write_text(
        f"class version:\n    cuda = {cuda_version}\n",
        encoding="utf-8",
    )

    assert (
        _REAL_TORCH_HAS_CUDA(
            ComfyuiLocalRuntime(),
            Path(local_runtime.sys.executable),
            tmp_path,
        )
        is expected
    )


def test_installer_installs_cuda_torch_before_comfyui_requirements(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(local_runtime, "_installs_cuda_torch_first", lambda: True)
    manager = ComfyuiLocalRuntime()
    target = tmp_path / "ComfyUI"

    commands = _install_with_stubbed_commands(manager, target, monkeypatch)

    cuda_index = _index_of(
        commands, lambda command: local_runtime.TORCH_CUDA_INDEX_URL in command
    )
    requirements_index = _index_of(
        commands, lambda command: command[-2:] == ["-r", "requirements.txt"]
    )
    assert cuda_index < requirements_index
    assert commands[cuda_index][2:] == [
        "pip",
        "install",
        *local_runtime.TORCH_CUDA_PACKAGES,
        "--index-url",
        local_runtime.TORCH_CUDA_INDEX_URL,
    ]
    assert manager.get_install_status()["phase"] == "complete"


def test_failed_cuda_torch_install_fails_the_installation(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(local_runtime, "_installs_cuda_torch_first", lambda: True)
    manager = ComfyuiLocalRuntime()
    target = tmp_path / "ComfyUI"

    commands = _install_with_stubbed_commands(
        manager,
        target,
        monkeypatch,
        fail_cuda_torch=True,
    )

    assert not any(command[-2:] == ["-r", "requirements.txt"] for command in commands)
    status = manager.get_install_status()
    assert status["phase"] == "failed"
    assert local_runtime.TORCH_CUDA_INDEX_URL in (status["error"] or "")


def test_installer_verifies_cuda_torch_after_custom_node_requirements(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(local_runtime, "_installs_cuda_torch_first", lambda: False)
    monkeypatch.setattr(local_runtime, "_requires_cuda_torch", lambda: True)
    manager = ComfyuiLocalRuntime()
    target = tmp_path / "ComfyUI"

    commands = _install_with_stubbed_commands(manager, target, monkeypatch)

    last_custom_node_clone = max(
        index
        for index, command in enumerate(commands)
        if command[:4] == ["git", "clone", "--depth", "1"]
    )
    assert commands[-1] == ["<torch cuda check>"]
    assert len(commands) - 1 > last_custom_node_clone
    assert all(
        local_runtime.TORCH_CUDA_INDEX_URL not in command for command in commands
    )
    assert manager.get_install_status()["phase"] == "complete"


def test_installer_replaces_a_cpu_torch_build_with_the_cuda_build(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(local_runtime, "_installs_cuda_torch_first", lambda: False)
    monkeypatch.setattr(local_runtime, "_requires_cuda_torch", lambda: True)
    manager = ComfyuiLocalRuntime()
    target = tmp_path / "ComfyUI"

    commands = _install_with_stubbed_commands(
        manager,
        target,
        monkeypatch,
        torch_has_cuda=(False, True),
    )

    first_check = _index_of(commands, lambda command: command == ["<torch cuda check>"])
    assert commands[first_check + 1][2:] == [
        "pip",
        "uninstall",
        "-y",
        *local_runtime.TORCH_CUDA_PACKAGES,
    ]
    assert local_runtime.TORCH_CUDA_INDEX_URL in commands[first_check + 2]
    assert commands[first_check + 3] == ["<torch cuda check>"]
    assert manager.get_install_status()["phase"] == "complete"


def test_installer_fails_when_torch_still_lacks_cuda_after_repair(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(local_runtime, "_installs_cuda_torch_first", lambda: False)
    monkeypatch.setattr(local_runtime, "_requires_cuda_torch", lambda: True)
    manager = ComfyuiLocalRuntime()
    target = tmp_path / "ComfyUI"

    _install_with_stubbed_commands(
        manager,
        target,
        monkeypatch,
        torch_has_cuda=(False,),
    )

    status = manager.get_install_status()
    assert status["phase"] == "failed"
    assert status["error"] == local_runtime._CPU_TORCH_ERROR


def test_installer_skips_cuda_torch_where_no_cuda_build_exists(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(local_runtime, "_installs_cuda_torch_first", lambda: False)
    monkeypatch.setattr(local_runtime, "_requires_cuda_torch", lambda: False)
    manager = ComfyuiLocalRuntime()
    target = tmp_path / "ComfyUI"

    commands = _install_with_stubbed_commands(
        manager,
        target,
        monkeypatch,
        torch_has_cuda=(False,),
    )

    assert ["<torch cuda check>"] not in commands
    assert all(
        local_runtime.TORCH_CUDA_INDEX_URL not in command for command in commands
    )
    assert manager.get_install_status()["phase"] == "complete"


class _NoopThread:
    def __init__(self, *args, **kwargs) -> None:
        del args, kwargs

    def start(self) -> None:
        pass


def test_install_commands_publish_their_latest_line_and_still_echo_it(
    tmp_path: Path,
    capsys,
) -> None:
    manager = ComfyuiLocalRuntime()
    manager._set_install_status(
        phase="installing_requirements", running=True, target_path=tmp_path
    )

    manager._run_install_command(
        [
            sys.executable,
            "-c",
            "import sys; print('Collecting torch'); "
            "print('Installing collected packages: torch', file=sys.stderr)",
        ],
        cwd=tmp_path,
    )

    assert manager.get_install_status()["logLine"] == (
        "Installing collected packages: torch"
    )
    echoed = capsys.readouterr().out
    assert "Collecting torch" in echoed
    assert "Installing collected packages: torch" in echoed

    # A new step keeps the last line until its command prints one.
    manager._set_install_status(
        phase="installing_requirements", running=True, target_path=tmp_path
    )
    assert manager.get_install_status()["logLine"] == (
        "Installing collected packages: torch"
    )


def test_a_failing_install_command_raises_with_its_last_line_kept(
    tmp_path: Path,
) -> None:
    manager = ComfyuiLocalRuntime()

    with pytest.raises(subprocess.CalledProcessError):
        manager._run_install_command(
            [
                sys.executable,
                "-c",
                "print('ERROR: No matching distribution'); raise SystemExit(1)",
            ],
            cwd=tmp_path,
        )

    assert manager.get_install_status()["logLine"] == "ERROR: No matching distribution"


def test_pip_download_progress_is_only_enabled_for_a_pip_that_supports_it(
    tmp_path: Path,
) -> None:
    fake_python = tmp_path / "python"

    def pip_reporting(version: str) -> bool:
        fake_python.write_text(f"#!/bin/sh\necho {version}\n", encoding="utf-8")
        fake_python.chmod(0o755)
        return local_runtime._pip_supports_raw_progress(fake_python, tmp_path)

    assert pip_reporting("24.1") is True
    assert pip_reporting("25.2.1") is True
    assert pip_reporting("23.0.1") is False
    assert pip_reporting("not-a-version") is False
    assert (
        local_runtime._pip_supports_raw_progress(tmp_path / "missing", tmp_path)
        is False
    )


def test_a_new_install_clears_the_previous_log_line(
    tmp_path: Path, monkeypatch
) -> None:
    manager = ComfyuiLocalRuntime()
    manager._publish_install_log_line("from the last install")
    manager._install_environment = {"PIP_PROGRESS_BAR": "raw"}
    monkeypatch.setattr(local_runtime.threading, "Thread", _NoopThread)

    status = manager.start_install(tmp_path)

    assert status["logLine"] is None
    assert manager._install_environment is None


def test_windows_environment_discovery_uses_scripts_python(tmp_path: Path) -> None:
    python = tmp_path / "ComfyUI" / "venv" / "Scripts" / "python.exe"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")

    assert _environment_python(
        tmp_path / "ComfyUI",
        platform_name="nt",
    ) == python


def test_launch_requires_an_explicit_choice_without_a_python_environment(
    tmp_path: Path,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)

    with pytest.raises(ComfyuiPythonEnvironmentRequired):
        ComfyuiLocalRuntime().launch(checkout, "http://127.0.0.1:8188")


def test_launch_uses_system_python_only_when_explicitly_requested(
    tmp_path: Path,
    monkeypatch,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 4320

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        captured["command"] = command
        return FakeProcess()

    monkeypatch.setattr(local_runtime.subprocess, "Popen", fake_popen)

    ComfyuiLocalRuntime().launch(
        checkout,
        "http://127.0.0.1:8188",
        use_system_python=True,
    )

    assert captured["command"][0] == local_runtime.sys.executable


def test_launch_uses_install_venv_and_requested_local_port(
    tmp_path: Path,
    monkeypatch,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    python = checkout / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 4321

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return FakeProcess()

    monkeypatch.setattr("services.comfyui.local_runtime.subprocess.Popen", fake_popen)
    manager = ComfyuiLocalRuntime()

    result = manager.launch(checkout, "http://127.0.0.1:8299")

    assert result["started"] is True
    assert captured["command"] == [
        str(python),
        str(checkout / "main.py"),
        "--port",
        "8299",
        "--disable-auto-launch",
    ]
    assert captured["kwargs"]["start_new_session"] is True
    assert captured["kwargs"]["stdout"].closed is True


def test_launch_seeds_frontend_defaults_before_starting_comfyui(
    tmp_path: Path,
    monkeypatch,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    (checkout / "custom_nodes" / "ComfyUI-VideoHelperSuite").mkdir(parents=True)
    python = checkout / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")
    settings_path = checkout / "user" / "default" / "comfy.settings.json"

    class FakeProcess:
        pid = 4323

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        del command, kwargs
        # The frontend only reads its settings once ComfyUI is serving them.
        assert settings_path.is_file()
        return FakeProcess()

    monkeypatch.setattr(local_runtime.subprocess, "Popen", fake_popen)

    ComfyuiLocalRuntime().launch(checkout, "http://127.0.0.1:8188")

    settings = json.loads(settings_path.read_text(encoding="utf-8"))
    assert settings["VHS.LatentPreview"] is True


def _write_cli_args(checkout: Path, flags: tuple[str, ...]) -> None:
    parser_source = "\n".join(
        f'parser.add_argument("{flag}", action="store_true")' for flag in flags
    )
    (checkout / "comfy").mkdir(parents=True, exist_ok=True)
    (checkout / "comfy" / "cli_args.py").write_text(parser_source, encoding="utf-8")


def test_launch_passes_manager_and_latent2rgb_previews_when_supported(
    tmp_path: Path,
    monkeypatch,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    _write_cli_args(checkout, ("--enable-manager", "--preview-method"))
    python = checkout / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 4322

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        del kwargs
        captured["command"] = command
        return FakeProcess()

    monkeypatch.setattr(local_runtime.subprocess, "Popen", fake_popen)

    ComfyuiLocalRuntime().launch(checkout, "http://127.0.0.1:8188")

    assert captured["command"] == [
        str(python),
        str(checkout / "main.py"),
        "--port",
        "8188",
        "--disable-auto-launch",
        "--enable-manager",
        "--preview-method",
        "latent2rgb",
    ]


def test_launch_omits_arguments_an_older_checkout_would_reject(
    tmp_path: Path,
    monkeypatch,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    _write_cli_args(checkout, ("--preview-method",))
    python = checkout / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 4323

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        del kwargs
        captured["command"] = command
        return FakeProcess()

    monkeypatch.setattr(local_runtime.subprocess, "Popen", fake_popen)

    ComfyuiLocalRuntime().launch(checkout, "http://127.0.0.1:8188")

    assert "--enable-manager" not in captured["command"]
    assert captured["command"][-2:] == ["--preview-method", "latent2rgb"]


def test_launch_arguments_are_dropped_without_a_readable_cli_args(
    tmp_path: Path,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)

    assert local_runtime._supported_launch_arguments(checkout) == []


def test_launch_uses_windows_portable_python_flags(
    tmp_path: Path,
    monkeypatch,
) -> None:
    portable_root = tmp_path / "ComfyUI_windows_portable"
    checkout = portable_root / "ComfyUI"
    _write_comfyui_checkout(checkout)
    python = portable_root / "python_embeded" / "python.exe"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 4322

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return FakeProcess()

    monkeypatch.setattr(local_runtime.subprocess, "Popen", fake_popen)

    result = ComfyuiLocalRuntime().launch(
        checkout,
        "http://127.0.0.1:8188",
    )

    assert result["started"] is True
    assert captured["command"] == [
        str(python),
        "-s",
        str(checkout / "main.py"),
        "--port",
        "8188",
        "--disable-auto-launch",
        "--windows-standalone-build",
    ]
    assert captured["kwargs"]["stdout"].closed is True


def test_launch_status_is_idle_before_any_launch() -> None:
    assert ComfyuiLocalRuntime().get_launch_status() == {
        "state": "idle",
        "pid": None,
        "exitCode": None,
        "logPath": None,
        "logTail": [],
    }


def test_launch_status_reports_an_early_exit_with_this_launchs_log_tail(
    tmp_path: Path,
    monkeypatch,
    _isolated_launch_log: Path,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    python = checkout / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")
    log_path = _isolated_launch_log / "comfyui.log"
    log_path.write_text("Traceback from an older launch\n", encoding="utf-8")
    exit_code: list[int | None] = [None]
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 4323

        def poll(self):
            return exit_code[0]

    def fake_popen(command, **kwargs):
        captured["env"] = kwargs["env"]
        kwargs["stdout"].write(
            b"Traceback (most recent call last):\n"
            b"AssertionError: Torch not compiled with CUDA enabled\n"
        )
        return FakeProcess()

    monkeypatch.setattr(local_runtime.subprocess, "Popen", fake_popen)
    manager = ComfyuiLocalRuntime()
    manager.launch(checkout, "http://127.0.0.1:8188")

    assert manager.get_launch_status()["state"] == "running"

    exit_code[0] = 1
    status = manager.get_launch_status()

    assert status["state"] == "exited"
    assert status["exitCode"] == 1
    assert status["pid"] == 4323
    assert status["logPath"] == str(log_path)
    assert status["logTail"][0].startswith("=== vlo launched ComfyUI at ")
    assert status["logTail"][-1] == (
        "AssertionError: Torch not compiled with CUDA enabled"
    )
    assert "Traceback from an older launch" not in status["logTail"]
    assert captured["env"]["PYTHONIOENCODING"] == "utf-8"
    assert captured["env"]["PYTHONUNBUFFERED"] == "1"


def test_launch_log_tail_is_bounded(tmp_path: Path) -> None:
    log_path = tmp_path / "comfyui.log"
    log_path.write_text(
        "".join(f"line {index}\n" for index in range(5000)),
        encoding="utf-8",
    )

    tail = local_runtime._read_log_tail(log_path, 0)

    assert len(tail) == local_runtime._LAUNCH_LOG_TAIL_LINES
    assert tail[-1] == "line 4999"


def test_launch_log_tail_strips_terminal_colours(tmp_path: Path) -> None:
    log_path = tmp_path / "comfyui.log"
    log_path.write_bytes(b"\x1b[32m[INFO]\x1b[0m Checkpoint files will always be loaded safely.\n")

    assert local_runtime._read_log_tail(log_path, 0) == [
        "[INFO] Checkpoint files will always be loaded safely."
    ]


def test_directory_picker_is_single_flight() -> None:
    local_runtime._DIRECTORY_PICKER_LOCK.acquire()
    try:
        with pytest.raises(DirectoryPickerBusyError):
            local_runtime.pick_directory("Choose ComfyUI")
    finally:
        local_runtime._DIRECTORY_PICKER_LOCK.release()
