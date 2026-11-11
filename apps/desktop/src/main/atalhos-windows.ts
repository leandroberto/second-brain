import { app, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Atalho no Menu Iniciar, sem admin. Aponta para o electron.exe com a pasta do
 * app, então ele sobe sem janela de console. O AUMID e o CLSID permitem que o
 * Windows entregue ao app os cliques nas notificações. O atalho de inicialização
 * do Windows é criado só pelo scripts/windows/desktop-install.ps1.
 */

export const TOAST_CLSID = '{B7D2E4A1-5C3F-4A68-9E0B-7F1C2D8A6E35}';

export function garantirAtalhos(aumid: string): void {
  if (process.platform !== 'win32') return;
  const programas = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const raiz = app.getAppPath();
  for (const lnk of [join(programas, 'Second Brain Desktop.lnk')]) {
    const ok = shell.writeShortcutLink(lnk, existsSync(lnk) ? 'replace' : 'create', {
      target: process.execPath,
      args: `"${raiz}"`,
      cwd: raiz,
      description: 'Second Brain: anotar e perguntar',
      appUserModelId: aumid,
      toastActivatorClsid: TOAST_CLSID,
    });
    if (!ok) console.error('[atalhos] não consegui gravar', lnk);
  }
}
