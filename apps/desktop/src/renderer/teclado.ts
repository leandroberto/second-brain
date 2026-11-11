/** Mapa de teclas da janela (spec §7.2, §8.10). Carregado pelo preload. */

export type AcaoTecla = 'alternar' | 'enviar' | 'quebrar-linha' | 'fechar' | null;

export function acaoDaTecla(e: { key: string; shiftKey: boolean }): AcaoTecla {
  switch (e.key) {
    case 'Tab':
      return 'alternar';
    case 'Enter':
      return e.shiftKey ? 'quebrar-linha' : 'enviar';
    case 'Escape':
      return 'fechar';
    default:
      return null;
  }
}
