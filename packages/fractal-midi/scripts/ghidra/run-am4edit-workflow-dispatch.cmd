@echo off
REM Headless run of MapAM4EditWorkflowDispatch.java. Three-anchor
REM mining for the AM4-Edit workflow dispatch/receive side
REM (FindAM4EditPresetParser surfaced the WRITE side at FUN_1402d83d0;
REM this script chases the READ side).
REM
REM Output:
REM   %PROJECT_ROOT%\samples\captured\decoded\ghidra-am4-edit-workflow-dispatch.txt

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
set SCRIPT_DIR=%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\find-preset-parser
set OUT_DIR=%PROJECT_ROOT%\samples\captured\decoded

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
if not exist "%SCRIPT_DIR%" mkdir "%SCRIPT_DIR%"

copy /Y "%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\MapAM4EditWorkflowDispatch.java" "%SCRIPT_DIR%\MapAM4EditWorkflowDispatch.java" >nul

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "AM4-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript MapAM4EditWorkflowDispatch.java

if errorlevel 1 (
    echo Ghidra headless exited with errors.
    exit /b 1
)

echo Done. Output: %OUT_DIR%\ghidra-am4-edit-workflow-dispatch.txt
endlocal
