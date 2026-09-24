@echo off
setlocal EnableExtensions DisableDelayedExpansion

:: A Git update can replace update.bat while it runs, and cmd.exe reads a batch
:: file a line at a time from a saved offset. Run from a temporary copy, and
:: start it without `call` so cmd.exe never comes back to read this file.
set "SELF_NAME=%~n0"
if /I "%SELF_NAME:~0,18%"=="vlo-update-runner-" goto :update
set "VLO_UPDATE_ROOT=%~dp0"
set "UPDATE_RUNNER=%TEMP%\vlo-update-runner-%RANDOM%%RANDOM%.bat"
copy /y "%~f0" "%UPDATE_RUNNER%" >nul
if errorlevel 1 (
    echo [ERROR] Could not create the temporary update runner.
    exit /b 1
)
"%UPDATE_RUNNER%" %*
:: Only reached if the copy could not be started at all.
echo [ERROR] Could not start the temporary update runner.
exit /b 1

:update
:: `shift` below also moves %0, so remember this copy's own path first.
set "RUNNER_PATH=%~f0"
set "SCRIPT_DIR=%VLO_UPDATE_ROOT%"
set "VLO_UPDATE_ROOT="
set "PROJECT_DIR=%SCRIPT_DIR:~0,-1%"
set "DEFAULT_REPOSITORY=https://github.com/PxTicks/vlo.git"
set "DEFAULT_BRANCH=main"
if not defined VLO_UPDATE_REPOSITORY set "VLO_UPDATE_REPOSITORY=%DEFAULT_REPOSITORY%"
if not defined VLO_UPDATE_BRANCH set "VLO_UPDATE_BRANCH=%DEFAULT_BRANCH%"
set "RC=0"
set "CONFIRM_ZIP_CONVERSION="
set "INSTALL_ARGS="

:: Keep the updater's own option; everything else goes to install.bat. cmd
:: splits `--profiles sam2,sam-audio` at the comma, and install.bat accepts
:: the values as separate arguments.
:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="-h" goto :usage
if /I "%~1"=="--help" goto :usage
if /I "%~1"=="--confirm-zip-conversion" (
    set "CONFIRM_ZIP_CONVERSION=-Confirmed"
) else (
    set "INSTALL_ARGS=%INSTALL_ARGS% %1"
)
shift
goto :parse_args
:args_done

echo [INFO]  VLO Updater
echo.

where git >nul 2>&1
if errorlevel 1 goto :git_missing
git --version >nul 2>&1
if errorlevel 1 goto :git_missing

if not exist "%SCRIPT_DIR%install.bat" goto :not_installation
if not exist "%SCRIPT_DIR%package.json" goto :not_installation

if exist "%SCRIPT_DIR%.git" goto :update_checkout
goto :convert_zip

:update_checkout
git -C "%PROJECT_DIR%" rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo [ERROR] The .git entry exists but is not a usable Git checkout.
    goto :failed
)

set "STATUS_FILE=%TEMP%\vlo-update-status-%RANDOM%-%RANDOM%.txt"
git -C "%PROJECT_DIR%" status --porcelain --untracked-files=no > "%STATUS_FILE%"
if errorlevel 1 (
    del /q "%STATUS_FILE%" >nul 2>&1
    echo [ERROR] Git could not inspect this checkout.
    goto :failed
)
for %%F in ("%STATUS_FILE%") do set "STATUS_SIZE=%%~zF"
if not "%STATUS_SIZE%"=="0" (
    echo [ERROR] Tracked source files have local changes. Commit or remove them before updating.
    type "%STATUS_FILE%"
    del /q "%STATUS_FILE%" >nul 2>&1
    goto :failed
)
del /q "%STATUS_FILE%" >nul 2>&1

echo [INFO]  Fetching updates for the existing Git checkout...
git -C "%PROJECT_DIR%" pull --ff-only
if errorlevel 1 (
    echo [ERROR] Git could not fast-forward this checkout. Resolve its branch or upstream configuration, then rerun the updater.
    goto :failed
)
goto :rebuild

:convert_zip
:: The converter lists every local file it would replace or move and asks
:: before touching any of them; see scripts\convert-zip-install.ps1.
if not exist "%SCRIPT_DIR%scripts\convert-zip-install.ps1" goto :not_installation
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\convert-zip-install.ps1" -Root "%PROJECT_DIR%" -Repository "%VLO_UPDATE_REPOSITORY%" -Branch "%VLO_UPDATE_BRANCH%" %CONFIRM_ZIP_CONVERSION%
if errorlevel 1 goto :failed
goto :rebuild

:rebuild
echo.
echo [INFO]  Rebuilding VLO with the updated installer...
call "%SCRIPT_DIR%install.bat"%INSTALL_ARGS%
set "RC=%errorlevel%"
goto :finish

:not_installation
echo [ERROR] This script must remain in the root of a VLO installation.
goto :failed

:git_missing
echo [ERROR] Git is required to update VLO. Install it from:
echo [ERROR] https://git-scm.com/downloads
echo [ERROR] Then open a new terminal and rerun this script.
goto :failed

:usage
echo Usage: update.bat [--confirm-zip-conversion] [installer options]
echo.
echo Fetch the latest VLO source, then rerun install.bat to update dependencies
echo and rebuild the frontend. Installer options such as --profiles and
echo --update-node are passed through unchanged.
echo.
echo Tracked local changes must be committed or removed before updating a Git
echo checkout.
echo.
echo A folder downloaded as a GitHub ZIP is converted into a Git checkout. If
echo that would replace or move any local file, the updater lists those files
echo and asks first; each one is saved under .vlo-update-backups\ before it is
echo touched.
echo.
echo   --confirm-zip-conversion  Approve those changes without asking. Required
echo                             when the updater cannot prompt.
goto :finish

:failed
set "RC=1"
echo.
echo [INFO]  The updater stopped before completion.
pause
goto :finish

:finish
:: Delete this temporary copy on the way out. `(goto)` ends the batch context
:: first; the rest of the line was already parsed, so it still runs.
(goto) 2>nul & del /q "%RUNNER_PATH%" & cmd /d /c exit %RC%
