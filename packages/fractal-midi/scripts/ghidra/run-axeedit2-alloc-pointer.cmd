@echo off
setlocal
for %%I in ("%~dp0..\..\..\..") do set "PROJECT_ROOT=%%~fI"
if "%GHIDRA_INSTALL_DIR%"=="" set GHIDRA_INSTALL_DIR=C:\tools\ghidra_12.0.4_PUBLIC
set HEADLESS=%GHIDRA_INSTALL_DIR%\support\analyzeHeadless.bat
set PROJECT_DIR=%USERPROFILE%
set PROJECT_NAME=ghidra-axe-edit
set SCRIPT_DIR=%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra
set OUT_DIR=%PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "Axe-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript FindAxeEditIIAllocPointer.java
echo Done.
endlocal
