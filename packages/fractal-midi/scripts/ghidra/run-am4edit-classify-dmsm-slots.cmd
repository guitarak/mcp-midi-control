@echo off
REM Headless run of DecompileAndClassifyDMSMSlots.java against
REM AM4-Edit.exe. Classifies the 6 unverified DeviceMgrStateMachine
REM vtable slots + 7 AM4DeviceManager vtable slots (3..10) against
REM parser / negative signatures so the chunk-1 SysEx parser slot can
REM be pinned in one mining pass.
REM
REM Predecessor: run-am4edit-dmsm-vtable.cmd (dumped the vtable).
REM
REM Output:
REM   %PROJECT_ROOT%\samples\captured\decoded\ghidra-am4-edit-classify-dmsm-slots.txt

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

REM Copy the canonical script into the isolated dir on every run.
copy /Y "%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\DecompileAndClassifyDMSMSlots.java" "%SCRIPT_DIR%\DecompileAndClassifyDMSMSlots.java" >nul

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "AM4-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript DecompileAndClassifyDMSMSlots.java

if errorlevel 1 (
    echo Ghidra headless exited with errors.
    exit /b 1
)

echo Done. Output: %OUT_DIR%\ghidra-am4-edit-classify-dmsm-slots.txt
endlocal
