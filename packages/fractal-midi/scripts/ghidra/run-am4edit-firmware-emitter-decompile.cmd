@echo off
REM HOP 4 Phase 1.5 step 2: decompile the firmware-emitter candidates
REM identified by ProbeAM4EditFractalBot. Primary target FUN_1401bf340
REM (Firmware string xref + 0xF0/0x7E both present). Plus 6 secondary
REM candidates from the string-xref set.
REM
REM Output:
REM   packages\fractal-midi\samples\captured\decoded\
REM     ghidra-am4-edit-firmware-emitter-decompile.txt

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

copy /Y "%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\DecompileAM4EditFirmwareEmitter.java" "%SCRIPT_DIR%\DecompileAM4EditFirmwareEmitter.java" >nul

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "AM4-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript DecompileAM4EditFirmwareEmitter.java

if errorlevel 1 (
    echo Ghidra headless exited with errors.
    exit /b 1
)

echo Done.
endlocal
