import { contextBridge, ipcRenderer } from 'electron';
import { acaoDaTecla } from '../renderer/teclado';

/** Ponte entre a janela e o processo principal (exposta como window.cerebro). */
contextBridge.exposeInMainWorld('cerebro', {
  acaoDaTecla,
  anotar: (texto: string) => ipcRenderer.invoke('anotar', texto),
  perguntar: (texto: string) => ipcRenderer.invoke('perguntar', texto),
  abrirNota: (caminho: string) => ipcRenderer.invoke('abrir-nota', caminho),
  mudouModo: (modo: string) => ipcRenderer.send('mudou-modo', modo),
  ajustarAltura: (altura: number) => ipcRenderer.send('ajustar-altura', altura),
  fechar: () => ipcRenderer.send('fechar'),
  aoMostrar: (cb: (dados: unknown) => void) => ipcRenderer.on('mostrar', (_e, dados) => cb(dados)),
});
