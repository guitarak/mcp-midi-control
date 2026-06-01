@echo off
REM HOP 4 Phase 1.5: locate the AM4-Edit firmware-update emitter and
REM its bit-packing loop. The outer SysEx envelope of
REM samples/factory/AM4_firmware_v2p00.syx is fully decoded
REM (fn=0x7D/0x7E/0x7F three-frame, parallel to preset 0x77/0x78/0x79
REM shape), but the inner packing format that reconstructs the high
REM bits is unidentified. Find the C++ emitter that builds the wire
REM bytes; the packing loop will be inline.
REM
REM Output:
REM   %PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded\
REM     ghidra-am4-edit-firmware-emitter.txt

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
REM Isolation subdir per the UTF-8 / em-dash workaround pattern.
set SCRIPT_DIR=%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\find-firmware-emitter
set OUT_DIR=%PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
if not exist "%SCRIPT_DIR%" mkdir "%SCRIPT_DIR%"

copy /Y "%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\FindAM4EditFirmwareEmitter.java" "%SCRIPT_DIR%\FindAM4EditFirmwareEmitter.java" >nul

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "AM4-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript FindAM4EditFirmwareEmitter.java

if errorlevel 1 (
    echo Ghidra headless exited with errors.
    exit /b 1
)

echo Done. Output: %OUT_DIR%\ghidra-am4-edit-firmware-emitter.txt
endlocal
