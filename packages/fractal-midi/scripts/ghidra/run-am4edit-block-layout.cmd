@echo off
setlocal
for %%I in ("%~dp0..\..\..\..") do set "PROJECT_ROOT=%%~fI"
if "%GHIDRA_INSTALL_DIR%"=="" set GHIDRA_INSTALL_DIR=C:\tools\ghidra_12.0.4_PUBLIC
set HEADLESS=%GHIDRA_INSTALL_DIR%\support\analyzeHeadless.bat
"%HEADLESS%" %USERPROFILE% ghidra-am4-edit ^
    -process "AM4-Edit.exe" -noanalysis -readOnly ^
    -scriptPath %PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra ^
    -postScript ProbeBlockLayout.java
endlocal
