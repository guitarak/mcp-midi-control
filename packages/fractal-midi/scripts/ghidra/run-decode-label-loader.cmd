@echo off
REM Headless run of DecodeLabelLoader.java against the existing
REM ghidra-am4-edit project. No GUI clicks needed.
REM
REM Output:
REM   %PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded\ghidra-label-loader.txt
REM
REM Usage:
REM   scripts\ghidra\run-decode-label-loader.cmd
REM
REM Override Ghidra install location if needed:
REM   set GHIDRA_INSTALL_DIR=C:\path\to\ghidra_X.Y.Z_PUBLIC
REM   scripts\ghidra\run-decode-label-loader.cmd

setlocal
for %%I in ("%~dp0..\..\..\..") do set "PROJECT_ROOT=%%~fI"

if "%GHIDRA_INSTALL_DIR%"=="" set GHIDRA_INSTALL_DIR=C:\tools\ghidra_12.0.4_PUBLIC

set HEADLESS=%GHIDRA_INSTALL_DIR%\support\analyzeHeadless.bat
if not exist "%HEADLESS%" (
    echo ERROR: analyzeHeadless.bat not found at "%HEADLESS%".
    echo Set GHIDRA_INSTALL_DIR to your Ghidra install root and re-run.
    exit /b 1
)

set PROJECT_DIR=%USERPROFILE%
set PROJECT_NAME=ghidra-am4-edit
set SCRIPT_DIR=%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra
set OUT_DIR=%PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

REM -process restricts to the AM4-Edit.exe program in the project.
REM -noanalysis keeps the existing analysis (don't reanalyze).
REM -scriptPath tells Ghidra where to find DecodeLabelLoader.java.
REM -postScript runs the script after (no) analysis.

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "AM4-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript DecodeLabelLoader.java

if errorlevel 1 (
    echo.
    echo Ghidra headless exited with errors. See output above.
    exit /b 1
)

echo.
echo Done. Output:
echo   %OUT_DIR%\ghidra-label-loader.txt
endlocal
