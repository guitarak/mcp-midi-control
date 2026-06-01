@echo off
REM Headless run of FindAM4EditPresetParser.java against AM4-Edit.exe.
REM Magic-immediate scoring + step-5 ground-truth anchor offsets to
REM locate AM4-Edit's inbound preset-binary parser. Modeled on
REM FindAxeEditIIPresetParser.java; see that script for the
REM methodological lineage.
REM
REM Output:
REM   %PROJECT_ROOT%\samples\captured\decoded\ghidra-am4-edit-preset-parser.txt

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
REM Per run-am4edit-paramtables.cmd's 2026-05-22 note: other .java
REM files in scripts/ghidra/ have UTF-8/em-dash decoding issues that
REM break headless compile when batched. Isolate this script in its
REM own scriptPath subdir so the loader only sees one file.
set SCRIPT_DIR=%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\find-preset-parser
set OUT_DIR=%PROJECT_ROOT%\samples\captured\decoded

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
if not exist "%SCRIPT_DIR%" mkdir "%SCRIPT_DIR%"

REM Copy the script into the isolated dir on every run so it stays in
REM sync with the canonical version in scripts/ghidra/.
copy /Y "%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\FindAM4EditPresetParser.java" "%SCRIPT_DIR%\FindAM4EditPresetParser.java" >nul

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "AM4-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript FindAM4EditPresetParser.java

if errorlevel 1 (
    echo Ghidra headless exited with errors.
    exit /b 1
)

echo Done. Output: %OUT_DIR%\ghidra-am4-edit-preset-parser.txt
endlocal
