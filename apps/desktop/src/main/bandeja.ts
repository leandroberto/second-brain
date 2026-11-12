import { Menu, nativeImage, Tray, type NativeImage } from 'electron';

/** Ícone perto do relógio (spec §8.9), com estado de erro (spec §7.7). */

const TAMANHO = 32;

/** Desenha um círculo cheio (BGRA), sem precisar de arquivo de imagem. */
function circulo(rgb: [number, number, number]): NativeImage {
  const buf = Buffer.alloc(TAMANHO * TAMANHO * 4);
  const centro = (TAMANHO - 1) / 2;
  const raio = TAMANHO / 2 - 2;
  for (let y = 0; y < TAMANHO; y++) {
    for (let x = 0; x < TAMANHO; x++) {
      const d = Math.hypot(x - centro, y - centro);
      const alfa = Math.max(0, Math.min(1, raio + 0.5 - d)); // borda suavizada
      const i = (y * TAMANHO + x) * 4;
      buf[i] = rgb[2];
      buf[i + 1] = rgb[1];
      buf[i + 2] = rgb[0];
      buf[i + 3] = Math.round(alfa * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: TAMANHO, height: TAMANHO });
}

const ICONE_NORMAL = (): NativeImage => circulo([58, 91, 217]);
const ICONE_ERRO = (): NativeImage => circulo([224, 86, 107]);

export interface AcoesBandeja {
  abrir(): void;
  organizarPendentes(): void;
  desfazerUltimo(): void;
  parear(): void;
  iniciarSecondBrain(): void;
  abrirQuarentena(): void;
  sair(): void;
}

export function criarBandeja(acoes: AcoesBandeja): {
  definirErro(erro: boolean, motivo?: string): void;
  definirQuarentena(n: number): void;
  /** Total de avisos de módulo pendentes: o Windows não tem badge numérico para Tray, então vai no tooltip. */
  definirTotalAvisos(n: number): void;
} {
  const bandeja = new Tray(ICONE_NORMAL());
  bandeja.setToolTip('Second Brain');
  let quarentena = 0;
  let erro: string | null = null;
  let totalAvisos = 0;

  function atualizarTooltip(): void {
    const partes = ['Second Brain'];
    if (erro !== null) partes.push(erro);
    if (totalAvisos > 0) partes.push(`${totalAvisos} aviso(s) de módulos`);
    bandeja.setToolTip(partes.join(' — '));
  }

  function montarMenu(): void {
    bandeja.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir', click: acoes.abrir },
        { label: 'Organizar pendentes', click: acoes.organizarPendentes },
        { label: 'Desfazer último', click: acoes.desfazerUltimo },
        { label: 'Parear (colar token da área de transferência)', click: acoes.parear },
        { label: 'Iniciar second-brain', click: acoes.iniciarSecondBrain },
        ...(quarentena > 0
          ? [{ label: `${quarentena} em quarentena (abrir arquivo)`, click: acoes.abrirQuarentena }]
          : []),
        { type: 'separator' },
        { label: 'Sair', click: acoes.sair },
      ]),
    );
  }
  montarMenu();
  bandeja.on('click', acoes.abrir);

  return {
    definirErro(temErro, motivo) {
      bandeja.setImage(temErro ? ICONE_ERRO() : ICONE_NORMAL());
      erro = temErro ? (motivo ?? 'há anotações pendentes') : null;
      atualizarTooltip();
    },
    definirTotalAvisos(n) {
      totalAvisos = n;
      atualizarTooltip();
    },
    definirQuarentena(n) {
      if (n === quarentena) return;
      quarentena = n;
      montarMenu();
    },
  };
}
