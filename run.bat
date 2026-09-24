@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "HOST=127.0.0.1"
set "PORT=6332"
set "NO_BROWSER=0"
set "PYTHON_BIN=%SCRIPT_DIR%backend\.venv\Scripts\python.exe"

:: Parse arguments
:parse_args
if "%~1"=="" goto :done_args
if "%~1"=="--no-browser" set "NO_BROWSER=1"
if "%~1"=="--host" (set "HOST=%~2" & shift)
if "%~1"=="--port" (set "PORT=%~2" & shift)
shift
goto :parse_args
:done_args

:: Verify installation. A double-clicked window closes the moment we exit, so
:: hold it open long enough to read why.
if not exist "%PYTHON_BIN%" (
    echo.
    echo [ERROR] VLO is not installed yet.
    echo [INFO]  Run install.bat first, then start VLO with run.bat.
    echo.
    pause
    exit /b 1
)
if not exist "%SCRIPT_DIR%frontend\dist\index.html" (
    echo Warning: Frontend not built. Run install.bat or npm run build.
)

:: A wildcard bind address is not something a browser can connect to.
set "BROWSER_HOST=%HOST%"
if "%BROWSER_HOST%"=="0.0.0.0" set "BROWSER_HOST=127.0.0.1"

:: Open the browser once the server answers, not on a fixed delay.
if "%NO_BROWSER%"=="0" (
    start "" /b "%PYTHON_BIN%" "%SCRIPT_DIR%scripts\open-browser-when-ready.py" "http://%BROWSER_HOST%:%PORT%"
)

echo Starting VLO at http://%HOST%:%PORT%
echo Press Ctrl+C to stop.
echo.

cd /d "%SCRIPT_DIR%backend"
"%PYTHON_BIN%" -m uvicorn main:app --host %HOST% --port %PORT%

endlocal
