@echo off
REM Headless run of SeekParamTables64.java against AM4-Edit.exe.
REM Cross-validates the dispatcher-mined catalog (Session 82) via the
REM direct-pattern-scan technique that broke open Axe-Edit II.

setlocal
for %%I in ("%~dp0..\..\..\..") do set "PROJECT_ROOT=%%~fI"

if "%GHIDRA_INSTALL_DIR%"=="" set GHIDRA_INSTALL_DIR=C:\tools\ghidra_12.0.4_PUBLIC

set HEADLESS=%GHIDRA_INSTALL_DIR%\support\analyzeHeadless.bat
if not exist "%HEADLESS%" (
    echo ERROR: analyzeHeadless.bat not found at "%HEADLESS%".
    exit /b 1
)

set PROJECT_DIR=%USERPROFILE%
set PROJECT_NAME=ghidra-am4-edit
REM 2026-05-22: -scriptPath isolated to scripts/ghidra/seek-paramtables/
REM Other Ghidra scripts in scripts/ghidra/ have encoding/parse errors
REM (mis-decoded UTF-8 em-dashes, double-encoded BOMs) that prevent the
REM headless loader from compiling SeekParamTables64.java when both
REM live in the same scriptPath. The seek-paramtables/ subdir contains
REM only SeekParamTables64.java + SeekParamTablesII.java (copies — the
REM originals stay in scripts/ghidra/ for whatever else reads them).
set SCRIPT_DIR=%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\seek-paramtables
set OUT_DIR=%PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "AM4-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript SeekParamTables64.java

if errorlevel 1 (
    echo Ghidra headless exited with errors.
    exit /b 1
)

echo Done.
endlocal
