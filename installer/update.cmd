@echo off
rem UTF-8 console so non-ASCII glyphs render correctly. Without this,
rem cmd.exe interprets UTF-8 multi-byte sequences via the legacy code
rem page (CP437/CP1252) and produces mojibake for any multi-byte char.
chcp 65001 >nul
setlocal

rem MCP MIDI Control -update script.
rem
rem Checks GitHub Releases for a newer version of the bundle and, if
rem one exists, downloads it, extracts side-by-side, and re-runs the
rem new setup.cmd so Claude Desktop picks up the new install. Idempotent
rem -safe to run repeatedly.
rem
rem Channel behavior is auto-detected from the installed semver:
rem   - If installed version has a pre-release suffix (e.g.
rem     0.1.0-alpha.7), this includes pre-releases when picking the
rem     newest matching release. That covers the alpha-testing flow.
rem   - If installed version is plain stable (e.g. 0.1.0), only stable
rem     releases are considered.
rem Override with --prerelease, --stable, or --any.
rem
rem Flags:
rem   --check        Just report what's available, don't download.
rem   --force        Re-install even if you're already on the latest.
rem   --prerelease   Force pre-release channel.
rem   --stable       Force stable-only channel.
rem   --any          Consider both channels regardless.

set "INSTALL_DIR=%~dp0"
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"

if not exist "%INSTALL_DIR%\install\check-for-update.ps1" (
    echo UPDATE FAILED -helper script not found.
    echo.
    echo Expected:
    echo   %INSTALL_DIR%\install\check-for-update.ps1
    echo.
    echo Your install bundle looks incomplete. Re-download the ZIP and
    echo extract it again.
    echo.
    pause
    exit /b 1
)

rem Translate user-friendly cmd flags into PowerShell parameters.
set "PS_ARGS="
set "CHANNEL_OVERRIDE="
:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--check"      ( set "PS_ARGS=%PS_ARGS% -CheckOnly" & shift & goto parse_args )
if /I "%~1"=="--force"      ( set "PS_ARGS=%PS_ARGS% -Force"     & shift & goto parse_args )
if /I "%~1"=="--prerelease" ( set "CHANNEL_OVERRIDE=prerelease"  & shift & goto parse_args )
if /I "%~1"=="--stable"     ( set "CHANNEL_OVERRIDE=stable"      & shift & goto parse_args )
if /I "%~1"=="--any"        ( set "CHANNEL_OVERRIDE=any"         & shift & goto parse_args )
echo Unknown flag: %~1
echo Valid flags: --check --force --prerelease --stable --any
exit /b 1
:args_done

if defined CHANNEL_OVERRIDE set "PS_ARGS=%PS_ARGS% -Channel %CHANNEL_OVERRIDE%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_DIR%\install\check-for-update.ps1" -InstallDir "%INSTALL_DIR%"%PS_ARGS%
set "RC=%ERRORLEVEL%"

echo.
pause
exit /b %RC%
