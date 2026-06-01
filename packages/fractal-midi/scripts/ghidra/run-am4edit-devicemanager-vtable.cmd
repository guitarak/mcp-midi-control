@echo off
REM Dump AM4DeviceManager::vftable + pre-registry setup + workflow
REM base-class constructor. Follow-up to MapAM4EditWorkflowDispatch.
REM
REM Output:
REM   %PROJECT_ROOT%\samples\captured\decoded\ghidra-am4-edit-devicemanager-vtable.txt

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

copy /Y "%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\DumpAM4DeviceManagerVtable.java" "%SCRIPT_DIR%\DumpAM4DeviceManagerVtable.java" >nul

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "AM4-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript DumpAM4DeviceManagerVtable.java

if errorlevel 1 (
    echo Ghidra headless exited with errors.
    exit /b 1
)

echo Done. Output: %OUT_DIR%\ghidra-am4-edit-devicemanager-vtable.txt
endlocal
