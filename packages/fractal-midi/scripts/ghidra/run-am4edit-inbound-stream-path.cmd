@echo off
REM HOP 3 of the AM4-Edit parser-side decode arc.
REM Decompiles + classifies the inbound-stream path callees downstream
REM of the dispatcher pinned in HOP 2 (FUN_1402ddb80). Targets the
REM stream-end handler (FUN_1402da830, the predicted AM4 analog of
REM III's FUN_1401f4390 workflow state-machine executor) plus the
REM status classifier and per-fn-byte first-level callees.
REM
REM Output:
REM   %PROJECT_ROOT%\samples\captured\decoded\ghidra-am4-edit-inbound-stream-path.txt

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
set SCRIPT_DIR=%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\find-preset-parser
set OUT_DIR=%PROJECT_ROOT%\samples\captured\decoded

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
if not exist "%SCRIPT_DIR%" mkdir "%SCRIPT_DIR%"

copy /Y "%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra\DecompileAM4InboundStreamPath.java" "%SCRIPT_DIR%\DecompileAM4InboundStreamPath.java" >nul

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "AM4-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript DecompileAM4InboundStreamPath.java

if errorlevel 1 (
    echo Ghidra headless exited with errors.
    exit /b 1
)

echo Done. Output: %OUT_DIR%\ghidra-am4-edit-inbound-stream-path.txt
endlocal
