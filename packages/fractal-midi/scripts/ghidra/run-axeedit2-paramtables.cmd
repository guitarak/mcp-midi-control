@echo off
REM Headless run of SeekParamTablesII.java against Axe-Edit.exe
REM (II generation, 32-bit). Scans the binary for ParamDescriptor
REM struct patterns directly, bypassing the failed dispatcher-xref
REM technique that Session 87 cont ruled out.
REM
REM Output:
REM   %PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded\ghidra-axeedit2-paramtables.txt
REM   %PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded\ghidra-axeedit2-paramtables.json

setlocal
for %%I in ("%~dp0..\..\..\..") do set "PROJECT_ROOT=%%~fI"

if "%GHIDRA_INSTALL_DIR%"=="" set GHIDRA_INSTALL_DIR=C:\tools\ghidra_12.0.4_PUBLIC

set HEADLESS=%GHIDRA_INSTALL_DIR%\support\analyzeHeadless.bat
if not exist "%HEADLESS%" (
    echo ERROR: analyzeHeadless.bat not found at "%HEADLESS%".
    exit /b 1
)

set PROJECT_DIR=%USERPROFILE%
set PROJECT_NAME=ghidra-axe-edit
REM 2026-05-22: -scriptPath isolated to scripts/ghidra/seek-paramtables/
REM Same reason as run-am4edit-paramtables.cmd — other Ghidra scripts
REM in scripts/ghidra/ have parse errors (UTF-8 em-dashes mis-decoded)
REM that prevent the headless loader from compiling our target script.
set SCRIPT_DIR=%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\seek-paramtables
set OUT_DIR=%PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "Axe-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript SeekParamTablesII.java

if errorlevel 1 (
    echo Ghidra headless exited with errors.
    exit /b 1
)

echo Done.
endlocal
