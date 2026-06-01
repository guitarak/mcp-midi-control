@echo off
REM Mine the AxeEdit III opcode table via DumpFractalEditorOpcodeTable.java.
REM
REM Prereq: "Axe-Edit III.exe" must be auto-analyzed in
REM %USERPROFILE%\ghidra-axe-edit-3 (your Ghidra project name).
REM
REM Output: samples\captured\decoded\ghidra-axe-edit-iii-opcode-map.txt
REM (filename derived from the program name)
REM
REM Wall time: ~5-10 min idempotent run.

setlocal
for %%I in ("%~dp0..\..\..\..") do set "PROJECT_ROOT=%%~fI"

if "%GHIDRA_INSTALL_DIR%"=="" set GHIDRA_INSTALL_DIR=C:\tools\ghidra_12.0.4_PUBLIC

set HEADLESS=%GHIDRA_INSTALL_DIR%\support\analyzeHeadless.bat
if not exist "%HEADLESS%" (
    echo ERROR: analyzeHeadless.bat not found at "%HEADLESS%".
    exit /b 1
)

set PROJECT_DIR=%USERPROFILE%
set PROJECT_NAME=ghidra-axe-edit-3
set SCRIPT_DIR=%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra
set OUT_DIR=%PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "Axe-Edit III.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript DumpFractalEditorOpcodeTable.java

if errorlevel 1 (
    echo Ghidra headless exited with errors.
    exit /b 1
)

echo Done. Output: %OUT_DIR%\ghidra-axe-edit-iii-opcode-map.txt
endlocal
