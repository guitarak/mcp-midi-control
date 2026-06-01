@echo off
REM HOP 4 Phase 1.5 probe: is Fractal-Bot (the firmware-update tool)
REM integrated into AM4-Edit.exe or shipped/launched separately?
REM
REM The first FindAM4EditFirmwareEmitter run found ZERO occurrences of
REM the firmware header magic, both firmware envelope prefixes
REM (F0 00 01 74 15 7D / 7E), and 3 of 4 mined SysEx-builder
REM candidates have zero references. Test whether the firmware emitter
REM lives in this binary at all before going deeper.
REM
REM Output:
REM   packages\fractal-midi\samples\captured\decoded\
REM     ghidra-am4-edit-fractal-bot-probe.txt

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
set SCRIPT_DIR=%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\find-firmware-emitter

if not exist "%SCRIPT_DIR%" mkdir "%SCRIPT_DIR%"

copy /Y "%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\ProbeAM4EditFractalBot.java" "%SCRIPT_DIR%\ProbeAM4EditFractalBot.java" >nul

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "AM4-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript ProbeAM4EditFractalBot.java

if errorlevel 1 (
    echo Ghidra headless exited with errors.
    exit /b 1
)

echo Done.
endlocal
