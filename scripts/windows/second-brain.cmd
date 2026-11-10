@echo off
rem Inicia o Second Brain no WSL e abre a UI no navegador do Windows.
set DISTRO=Ubuntu-24.04
set REPO=~/projetos/second-brain
start "Second Brain (WSL)" wsl.exe -d %DISTRO% -- bash -lc "cd %REPO% && ./scripts/start.sh"
timeout /t 4 >nul
for /f "usebackq delims=" %%U in (`wsl.exe -d %DISTRO% -- bash -lc "cd %REPO% && node packages/cli/dist/bin.js ui"`) do start "" "%%U"
