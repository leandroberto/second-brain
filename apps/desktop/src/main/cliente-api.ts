/**
 * Cliente fino da API local do second-brain. É a única porta do desktop para as notas: só chama as rotas que a
 * credencial de escopo `desktop` pode usar (`/api/assistant/*`, `GET /api/health`, `GET /api/notifications` e
 * `POST /api/notifications/<id>/visto`). As operações do assistente e a saúde nunca lançam: erro de rede, de pareamento
 * e de HTTP voltam como valores, para a janela decidir o que mostrar. Os avisos de módulo (`avisos`, `marcarVisto`)
 * lançam `Error` em qualquer falha: o vigia de avisos (`avisos-modulos.ts`) trata a exceção (a consulta tenta de novo no
 * próximo intervalo; marcar como visto que falha é ignorado).
 */

import { Agent } from 'undici';
import type { AvisoModulo } from './avisos-modulos';

export const MENSAGEM_PAREAMENTO = 'Rode `brain pair-desktop` no WSL e cole o token.';
export const MENSAGEM_INCERTO =
  'Não sei se foi registrado; confira as pendentes (bandeja → Organizar pendentes) antes de reenviar.';

/** Maior que o timeout do motor (`claude -p`): o desktop não desiste antes do servidor. */
export const TIMEOUT_API_MS = 15 * 60 * 1000;
const agente = new Agent({ headersTimeout: TIMEOUT_API_MS, bodyTimeout: TIMEOUT_API_MS });
const fetchPadrao: typeof fetch = (url, init) => fetch(url, { ...init, dispatcher: agente } as RequestInit);

/** Falhas de conexão em que o pedido NUNCA foi aceito pelo servidor: só estas são "offline" (e vão para a fila). */
const CODIGOS_OFFLINE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']);
function ehOffline(e: unknown): boolean {
  const x = e as { code?: string; cause?: { code?: string } } | undefined;
  return CODIGOS_OFFLINE.has(String(x?.cause?.code ?? x?.code));
}

export type TipoErroMotor = 'auth' | 'timeout' | 'orcamento' | 'erro';
export type ErroMotor = { ok: false; tipo: TipoErroMotor; mensagem: string };
export type AcaoNota = 'criada' | 'complementada' | 'na_fila' | 'ignorada';
export type ResultadoCaptura =
  | { ok: true; notas: Array<{ id: string; acao: AcaoNota }>; segredo_omitido: boolean; texto_mascarado: string | null }
  | ErroMotor;

/** Falhas do lado do cliente (a API não respondeu como esperado). */
export type FalhaCliente =
  | { ok: false; tipo: 'offline' }
  | { ok: false; tipo: 'pareamento'; mensagem: string }
  /** Erro depois do envio (timeout, 5xx em anotar): o servidor pode ter gravado. NÃO reenviar sem conferir. */
  | { ok: false; tipo: 'incerto'; mensagem: string }
  | { ok: false; tipo: 'http'; status: number; mensagem: string };

export type RespostaAnotar =
  | { ok: true; capture_id: string; state: string; result: ResultadoCaptura }
  | FalhaCliente;
export type RespostaPerguntar = { ok: true; resposta: string; fontes: string[] } | ErroMotor | FalhaCliente;
export type RespostaDesfazer =
  | { ok: true; reverted: string[] }
  | { ok: false; tipo: 'ocupado' | 'inexistente'; mensagem: string }
  | FalhaCliente;
export type RespostaOrganizar = { ok: true; retried: number; restantes: number } | FalhaCliente;
export type RespostaRenovar = { ok: true; token: string } | FalhaCliente;
export type EstadoApi = 'ok' | 'offline' | 'pareamento';
export type RespostaAvisos = { avisos: AvisoModulo[]; cursor: string; total: number };

export interface ClienteApi {
  anotar(texto: string): Promise<RespostaAnotar>;
  perguntar(q: string, conversa?: string): Promise<RespostaPerguntar>;
  desfazer(captureId: string): Promise<RespostaDesfazer>;
  organizarPendentes(): Promise<RespostaOrganizar>;
  saude(): Promise<boolean>;
  estado(): Promise<EstadoApi>;
  /** Troca a credencial desktop por outra com validade nova (o servidor revoga a atual). */
  renovar(): Promise<RespostaRenovar>;
  /** Avisos de módulo desde o cursor. Diferente dos demais, LANÇA em falha: quem chama (o vigia) trata em silêncio. */
  avisos(depois?: string): Promise<RespostaAvisos>;
  /** Marca o aviso como visto. Lança em falha. */
  marcarVisto(id: string): Promise<void>;
}

type Bruto = { status: number; corpo: any };

export function criarClienteApi(base = 'http://localhost:3737', token: string, f: typeof fetch = fetchPadrao): ClienteApi {
  const raiz = base.replace(/\/+$/, '');

  /** Devolve a resposta HTTP ou uma falha do cliente (rede, 401/403). */
  async function chamar(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown): Promise<Bruto | FalhaCliente> {
    let r: Response;
    try {
      r = await f(raiz + caminho, {
        method: metodo,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
      });
    } catch (e) {
      return ehOffline(e) ? { ok: false, tipo: 'offline' } : { ok: false, tipo: 'incerto', mensagem: MENSAGEM_INCERTO };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, tipo: 'pareamento', mensagem: MENSAGEM_PAREAMENTO };
    const texto = await r.text().catch(() => '');
    let json: any;
    try {
      json = texto ? JSON.parse(texto) : undefined;
    } catch {
      json = undefined;
    }
    return { status: r.status, corpo: json ?? { message: texto } };
  }

  const falhou = (r: Bruto | FalhaCliente): r is FalhaCliente => 'ok' in r;
  const http = (r: Bruto): FalhaCliente => ({
    ok: false,
    tipo: 'http',
    status: r.status,
    mensagem: String(r.corpo?.message ?? `erro HTTP ${r.status}`),
  });

  async function estado(): Promise<EstadoApi> {
    const r = await chamar('GET', '/api/health');
    if (falhou(r)) return r.tipo === 'pareamento' ? 'pareamento' : 'offline';
    return r.status === 200 ? 'ok' : 'offline';
  }

  return {
    async anotar(texto) {
      const r = await chamar('POST', '/api/assistant/capture', { text: texto });
      if (falhou(r)) return r;
      if (r.status >= 500) return { ok: false, tipo: 'incerto', mensagem: MENSAGEM_INCERTO };
      if (r.status !== 200) return http(r);
      const { capture_id, state, result } = r.corpo;
      return { ok: true, capture_id, state, result };
    },

    async perguntar(q, conversa) {
      const r = await chamar('POST', '/api/assistant/ask', {
        question: q,
        ...(conversa === undefined ? {} : { conversation_id: conversa }),
      });
      if (falhou(r)) return r;
      return r.status === 200 ? (r.corpo as RespostaPerguntar) : http(r);
    },

    async desfazer(captureId) {
      const r = await chamar('POST', `/api/assistant/captures/${encodeURIComponent(captureId)}/undo`);
      if (falhou(r)) return r;
      if (r.status === 200) return { ok: true, reverted: Array.isArray(r.corpo?.reverted) ? r.corpo.reverted : [] };
      const mensagem = String(r.corpo?.message ?? `erro HTTP ${r.status}`);
      if (r.status === 503) return { ok: false, tipo: 'ocupado', mensagem };
      if (r.status === 404) return { ok: false, tipo: 'inexistente', mensagem };
      return http(r);
    },

    async organizarPendentes() {
      const r = await chamar('POST', '/api/assistant/captures/retry');
      if (falhou(r)) return r;
      if (r.status !== 200) return http(r);
      const p = await chamar('GET', '/api/assistant/captures?state=pendente');
      const restantes = !falhou(p) && p.status === 200 && Array.isArray(p.corpo) ? p.corpo.length : 0;
      return { ok: true, retried: Number(r.corpo?.retried ?? 0), restantes };
    },

    estado,

    async renovar() {
      const r = await chamar('POST', '/api/assistant/session/renew');
      if (falhou(r)) return r;
      const token = r.corpo?.token;
      if (r.status === 200 && typeof token === 'string' && /^hs_[0-9a-f]{64}$/.test(token)) return { ok: true, token };
      return http(r.status === 200 ? { status: r.status, corpo: { message: 'resposta de renovação sem token' } } : r);
    },

    async avisos(depois) {
      const q = depois === undefined ? '' : `?depois=${encodeURIComponent(depois)}`;
      const r = await chamar('GET', `/api/notifications${q}`);
      if (falhou(r)) throw new Error(`avisos indisponíveis (${r.tipo})`);
      const c = r.corpo;
      if (r.status !== 200 || !Array.isArray(c?.avisos) || typeof c.cursor !== 'string' || typeof c.total !== 'number') {
        throw new Error(`resposta de avisos inválida (HTTP ${r.status})`);
      }
      return { avisos: c.avisos, cursor: c.cursor, total: c.total };
    },

    async marcarVisto(id) {
      const r = await chamar('POST', `/api/notifications/${encodeURIComponent(id)}/visto`);
      if (falhou(r)) throw new Error(`não marquei o aviso como visto (${r.tipo})`);
      if (r.status !== 204 && r.status !== 200) throw new Error(`não marquei o aviso como visto (HTTP ${r.status})`);
    },

    async saude() {
      return (await estado()) === 'ok';
    },
  };
}
