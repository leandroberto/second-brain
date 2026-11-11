import { BrowserWindow, screen } from 'electron';
import type { Modo } from './tipos';

/** Janela do atalho (spec §7.2): pequena, sem moldura, por cima de tudo. */

const LARGURA = 640;
const ALTURA_MAXIMA = 600;

export function criarJanela(preload: string, html: string): BrowserWindow {
  const janela = new BrowserWindow({
    width: LARGURA,
    height: 140,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#1f2430',
    webPreferences: { preload, sandbox: false, contextIsolation: true, nodeIntegration: false },
  });
  janela.setAlwaysOnTop(true, 'screen-saver');
  janela.on('blur', () => janela.hide());
  // Erros da janela vão para o log do processo principal (diagnóstico).
  janela.webContents.on('console-message', (e) => {
    const { level, message, sourceId, lineNumber } = e as unknown as {
      level: string; message: string; sourceId: string; lineNumber: number;
    };
    console.log(`[janela:${level}] ${message} (${sourceId}:${lineNumber})`);
  });
  janela.webContents.on('preload-error', (_e, caminho, erro) => console.error('[preload]', caminho, erro));
  void janela.loadFile(html);
  return janela;
}

export function ajustarAltura(janela: BrowserWindow, altura: number): void {
  janela.setContentSize(LARGURA, Math.max(60, Math.min(altura, ALTURA_MAXIMA)));
}

export function mostrarJanela(
  janela: BrowserWindow,
  dados: { modo: Modo; texto?: string; aviso?: string },
): void {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  janela.setPosition(Math.round(area.x + (area.width - LARGURA) / 2), Math.round(area.y + area.height / 5));
  janela.webContents.send('mostrar', dados);
  janela.show();
  janela.focus();
}
