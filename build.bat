@echo off
setlocal enabledelayedexpansion
title Synapse - local build

REM ---------------------------------------------------------------------------
REM  build.bat - build the Windows installer from this checkout.
REM
REM  Double-click it, or from a terminal:
REM      build.bat                 normal build
REM      build.bat /y              never stop to ask anything
REM      build.bat /skiptests      go straight to packaging
REM      build.bat /clean          reinstall dependencies from the lockfile
REM      build.bat /check          only report whether you are current, then stop
REM
REM  Output lands in dist\ .
REM ---------------------------------------------------------------------------

cd /d "%~dp0"

set "ASSUME_YES="
set "SKIP_TESTS="
set "CLEAN="
set "CHECK_ONLY="
:parseargs
if "%~1"=="" goto parsed
if /i "%~1"=="/y"          set "ASSUME_YES=1"
if /i "%~1"=="/yes"        set "ASSUME_YES=1"
if /i "%~1"=="/skiptests"  set "SKIP_TESTS=1"
if /i "%~1"=="/clean"      set "CLEAN=1"
if /i "%~1"=="/check"      set "CHECK_ONLY=1"
if /i "%~1"=="/?"          goto usage
shift
goto parseargs
:parsed

echo.
echo ===========================================================
echo   Synapse - local build
echo ===========================================================
echo.

REM --- 1. Node -----------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo   [X] Node.js was not found on your PATH.
  echo.
  echo       Install the LTS build from https://nodejs.org and run this again.
  goto fail
)
for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
echo   [ok] Node !NODEV!

where npm >nul 2>&1
if errorlevel 1 (
  echo   [X] npm was not found on your PATH, though Node was.
  echo       Reinstall Node.js so npm comes with it.
  goto fail
)

REM --- 2. Is this checkout current? --------------------------------------
echo.
echo   --- Checking this checkout against the repository ---
echo.

REM 2a. git: is the branch behind its remote?
set "GITOK="
where git >nul 2>&1
if not errorlevel 1 if exist ".git" set "GITOK=1"

if not defined GITOK (
  echo   [--] Not a git checkout ^(or git is not on PATH^) - skipping the branch check.
) else (
  set "BRANCH="
  for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
  echo   [..] Fetching from the remote...
  git fetch --quiet 2>nul
  set "BEHIND="
  for /f %%n in ('git rev-list --count HEAD..@{u} 2^>nul') do set "BEHIND=%%n"

  if "!BEHIND!"=="" (
    echo   [--] Branch "!BRANCH!" has no upstream - skipping the remote check.
  ) else if "!BEHIND!"=="0" (
    echo   [ok] Branch "!BRANCH!" is level with its remote.
  ) else (
    echo   [!] Branch "!BRANCH!" is !BEHIND! commit^(s^) behind its remote.
    echo       Run "git pull" if you meant to build the newest code.
    echo.
    if not defined ASSUME_YES (
      set /p "GO=      Build anyway? [y/N] "
      if /i not "!GO!"=="y" goto cancelled
      echo.
    )
  )
)

REM 2b. released version comparison
node tools\preflight.js
set "PRE=!errorlevel!"
echo.
if "!PRE!"=="2" (
  if not defined ASSUME_YES (
    set /p "GO=  Build this older version anyway? [y/N] "
    if /i not "!GO!"=="y" goto cancelled
    echo.
  )
)

if defined CHECK_ONLY (
  echo.
  echo   Check only - stopping before the build.
  goto done
)

REM --- 3. Dependencies ---------------------------------------------------
echo.
echo   --- Dependencies ---
echo.
if defined CLEAN (
  if exist node_modules (
    echo   Removing node_modules for a clean install...
    rmdir /s /q node_modules
  )
)

if not exist "node_modules\electron" (
  echo   Installing dependencies. The Electron download is large, so the first
  echo   run can take several minutes.
  echo.
  if exist package-lock.json (
    call npm ci
    if errorlevel 1 (
      echo.
      echo   [!] "npm ci" failed - falling back to "npm install".
      call npm install
      if errorlevel 1 goto npmfail
    )
  ) else (
    call npm install
    if errorlevel 1 goto npmfail
  )
) else (
  echo   [ok] Dependencies already installed.
)

REM electron-builder needs a real electron in node_modules to read its version
if not exist "node_modules\electron" (
  echo.
  echo   [X] Electron still is not in node_modules after installing.
  echo       Packaging cannot work without it. Try: build.bat /clean
  goto fail
)

REM --- 4. Tests ----------------------------------------------------------
if defined SKIP_TESTS (
  echo.
  echo   --- Tests skipped by request ---
) else (
  echo.
  echo   --- Tests ---
  echo.
  call npm test
  if errorlevel 1 (
    echo.
    echo   [!] Tests failed.
    if not defined ASSUME_YES (
      set /p "GO=      Package anyway? [y/N] "
      if /i not "!GO!"=="y" goto cancelled
    )
  ) else (
    echo.
    echo   [ok] Tests passed.
  )
)

REM --- 5. Build ----------------------------------------------------------
echo.
echo   --- Packaging the Windows installer ---
echo.
call npm run dist:win
if errorlevel 1 goto buildfail

REM --- 6. Report ---------------------------------------------------------
echo.
echo ===========================================================
echo   Build complete
echo ===========================================================
echo.
set "FOUND="
for %%f in ("dist\*.exe") do (
  echo   Installer : %%~ff
  echo   Size      : %%~zf bytes
  set "FOUND=1"
)
if not defined FOUND (
  echo   [!] No .exe turned up in dist\ - check the output above.
  goto fail
)
echo.
echo   Note: the installer is unsigned, so Windows SmartScreen will warn on
echo   first run. Choose "More info" then "Run anyway".
echo.
if not defined ASSUME_YES (
  set /p "OPENIT=  Open the dist folder? [Y/n] "
  if /i not "!OPENIT!"=="n" start "" "%~dp0dist"
)
goto done

:usage
echo   Usage: build.bat [/y] [/skiptests] [/clean] [/check]
echo.
echo     /y          assume yes to every prompt
echo     /skiptests  package without running the test suite
echo     /clean      delete node_modules and reinstall first
echo     /check      only report whether this checkout is current, then stop
goto done

:npmfail
echo.
echo   [X] Installing dependencies failed. Check your internet connection
echo       and any proxy settings, then try again.
goto fail

:buildfail
echo.
echo   [X] Packaging failed. The most common causes:
echo         - electron missing from node_modules  ^(try: build.bat /clean^)
echo         - antivirus locking files in dist\    ^(exclude this folder^)
echo         - a previous Synapse still running    ^(close it and retry^)
goto fail

:cancelled
echo.
echo   Cancelled - nothing was built.
goto done

:fail
echo.
if not defined ASSUME_YES pause
endlocal
exit /b 1

:done
echo.
if not defined ASSUME_YES pause
endlocal
exit /b 0
