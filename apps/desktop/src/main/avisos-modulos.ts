/**
 * Vigia dos avisos de módulo (spec §7.9): consulta `GET /api/notifications` a cada minuto, mostra notificação nativa
 * dos avisos novos e informa o total (para a bandeja). Erro de rede é silencioso: tenta no próximo intervalo.
 */

import type { ClienteApi } from './cliente-api';

/** Forma mínima do aviso gravado pelo servidor (não importa de `@brain/core`: o desktop é um pacote à parte). */
export interface AvisoModulo {
  id: string;
  modulo: string;
  titulo: string;
  corpo?: string;
  link?: string;
  chave?: string;
  criado: string;
  visto: boolean;
}

export const INTERVALO_AVISOS_MS = 60_000;
const MAX_NOTIFICACOES_POR_CICLO = 5;
const ID_MODULO = /^[a-z][a-z0-9-]{1,30}$/;

/** `link` vem do servidor: só vale como resto relativo da aba do módulo. */
function linkSeguro(link: unknown): string | null {
  if (typeof link !== 'string' || link === '' || link.length > 500) return null;
  if (link.includes('..') || link.includes(':') || link.includes('\\') || link.startsWith('/')) return null;
  return link;
}

/**
 * URL da aba do módulo. `null` se o módulo é inválido (nada a abrir). Link inválido cai na raiz do módulo.
 * Cada segmento do link é codificado, preservando `/`.
 */
export function montarUrlAviso(base: string, aviso: { modulo: string; link?: string }): string | null {
  if (typeof aviso.modulo !== 'string' || !ID_MODULO.test(aviso.modulo)) return null;
  const link = linkSeguro(aviso.link);
  const resto = link === null ? '' : link.split('/').map(encodeURIComponent).join('/');
  return `${base.replace(/\/+$/, '')}/#/m/${aviso.modulo}/${resto}`;
}

export interface OpcoesVigiaAvisos {
  cliente: Pick<ClienteApi, 'avisos' | 'marcarVisto'>;
  notificar: (n: { titulo: string; corpo: string; aoClicar: () => void }) => void;
  abrir: (url: string) => void;
  base: string;
  aoTotal: (n: number) => void;
  intervaloMs?: number;
}

export function criarVigiaAvisos(o: OpcoesVigiaAvisos): { iniciar(): void; parar(): void; agora(): Promise<void> } {
  let cursor: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let consultando: Promise<void> | null = null;
  const jaNotificados = new Set<string>();

  function aoClicar(aviso: AvisoModulo): void {
    const url = montarUrlAviso(o.base, aviso);
    try {
      if (url !== null) o.abrir(url);
    } catch (e) {
      console.error('[avisos]', e);
    }
    void Promise.resolve()
      .then(() => o.cliente.marcarVisto(aviso.id))
      .catch(() => undefined);
  }

  async function consultar(): Promise<void> {
    try {
      const r = await o.cliente.avisos(cursor);
      const novos = r.avisos
        .filter((a) => !a.visto && !jaNotificados.has(a.id))
        .sort((a, b) => (a.criado < b.criado ? 1 : a.criado > b.criado ? -1 : 0));
      for (const a of novos.slice(0, MAX_NOTIFICACOES_POR_CICLO)) {
        jaNotificados.add(a.id);
        o.notificar({ titulo: a.titulo, corpo: a.corpo ?? '', aoClicar: () => aoClicar(a) });
      }
      // os que passaram do limite só contam no total: não voltam como notificação nos ciclos seguintes
      for (const a of novos.slice(MAX_NOTIFICACOES_POR_CICLO)) jaNotificados.add(a.id);
      cursor = r.cursor;
      o.aoTotal(r.total);
    } catch {
      /* silencioso: tenta no próximo intervalo, com o mesmo cursor */
    }
  }

  /** Uma consulta por vez: se uma ainda corre, quem chama espera por ela. */
  function agora(): Promise<void> {
    consultando ??= consultar().finally(() => {
      consultando = null;
    });
    return consultando;
  }

  return {
    iniciar() {
      if (timer !== undefined) return;
      void agora();
      timer = setInterval(() => void agora(), o.intervaloMs ?? INTERVALO_AVISOS_MS);
    },
    parar() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    agora,
  };
}
