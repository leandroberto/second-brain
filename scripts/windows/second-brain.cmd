@echo off
rem Inicia o Second Brain no WSL e abre a UI no navegador do Windows.
rem Distro: SECOND_BRAIN_DISTRO; sem ela, o WSL usa a distro padrao (sem -d).
rem Clone:  SECOND_BRAIN_REPO (caminho no WSL); padrao ~/projetos/second-brain.
rem O desktop-install.ps1 grava -Distro e -RepoPath nas duas linhas "set" abaixo da copia instalada.
set "DISTRO="
set "REPO=~/projetos/second-brain"
if defined SECOND_BRAIN_DISTRO set "DISTRO=%SECOND_BRAIN_DISTRO%"
if defined SECOND_BRAIN_REPO set "REPO=%SECOND_BRAIN_REPO%"
set "WSLD="
if defined DISTRO set "WSLD=-d %DISTRO% "
start "Second Brain (WSL)" wsl.exe %WSLD%-- bash -lc "cd %REPO% && ./scripts/start.sh"
rem espera o servidor subir; ping em vez de timeout: o timeout falha quando o stdin nao e um console (chamada pelo desktop)
ping -n 5 127.0.0.1 >nul
for /f "usebackq delims=" %%U in (`wsl.exe %WSLD%-- bash -lc "cd %REPO% && node packages/cli/dist/bin.js ui"`) do start "" "%%U"
