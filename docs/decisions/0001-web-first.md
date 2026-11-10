# ADR 0001 — Web First; desktop opcional (substitui a preferência inicial por Electron)

Status: aceito · Data: 2026-10-14

## Contexto
O prompt original sugeria Electron; o ajuste posterior tornou **Web First** o padrão: Core → API local → React/Vite no navegador; desktop só com requisito concreto.

## Decisão
V1 entrega apenas navegador. Nenhum Electron/Tauri/Rust na V1. A UI não contém regras (ESLint proíbe importar Core/Node) e fala só com a API local, de modo que o mesmo frontend possa ser embrulhado depois (Tauri, Electron, PWA).

## Consequências
+ Menos superfície (sem empacotamento, IPC, auto-update); desenvolvimento e testes E2E no navegador (Playwright).
+ Funciona igual no Windows (navegador) apontando para a API no WSL.
− Sem bandeja/atalho global/janela quick-access até existir o shell (ver ADR 0009 e FUTURE).
