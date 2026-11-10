# ADR 0009 — Shell desktop futuro: critérios Tauri 2 × Electron (decisão adiada)

Status: aceito · Data: 2026-10-14

## Estado
Não implementado (ADR 0001). Versões em 2026-10-14: Tauri CLI 2.12, Electron 44.

## Critérios (para decidir quando surgir requisito concreto)
| Critério | Tauri 2 | Electron |
|---|---|---|
| Recursos / tamanho | WebView do sistema (WebView2 no Windows); binário pequeno | embute Chromium+Node; maior |
| Integração Node | nenhuma (Rust); precisaria de sidecar Node | Node completo no processo principal |
| Windows+WSL | cliente HTTP do `localhost`; spawn de `wsl.exe` via plugin/comando Rust | idem via Node `child_process` (mais fácil) |
| Segurança | modelo de permissões/capabilities por padrão | exige disciplina (contextIsolation, CSP) |
| DX / equipe | exige Rust para APIs nativas | só TypeScript |
| Necessidade real | tray, atalho global, janela Spotlight, notificações: todos suportados | idem |

## Orientação
Como o cliente é fino (só HTTP), **Tauri** é candidato natural; **Electron** vence se surgir integração Node profunda no próprio shell. Decidir por requisito, não por preferência. O Core e a UI não mudam em nenhum dos casos.
