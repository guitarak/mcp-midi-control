@echo off
setlocal
for %%I in ("%~dp0..\..\..\..") do set "PROJECT_ROOT=%%~fI"
if "%GHIDRA_INSTALL_DIR%"=="" set GHIDRA_INSTALL_DIR=C:\tools\ghidra_12.0.4_PUBLIC
"%GHIDRA_INSTALL_DIR%\support\analyzeHeadless.bat" "%USERPROFILE%" "ghidra-axe-edit" ^
    -process "Axe-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra" ^
    -postScript FindAxeEditIIVtableUsers.java
echo Done.
endlocal
