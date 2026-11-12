import type { Analysis, Proposal, NoteType, NoteStatus, SearchHit, ActivityEntry, Note, SimilarMatch } from "@brain/shared";

export type { Analysis, Proposal, NoteType, NoteStatus, SearchHit, ActivityEntry, Note, SimilarMatch };

const KEY = "second-brain.token";
export function captureToken(): void {
  const m = /token=([A-Za-z0-9_]+)/.exec(location.hash); // sessão humana (hs_…) ou api-token (hex)
  if (m) { try { localStorage.setItem(KEY, m[1]!); } catch { /* sem storage */ } history.replaceState(null, "", location.pathname + "#/"); }
}
export const getToken = (): string => { try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } };
export const setToken = (t: string) => { try { localStorage.setItem(KEY, t); } catch { /* */ } };

export class ApiError extends Error {
  /** `corpo`: a resposta de erro inteira (`erros`, `caminho`, `causas`... das rotas de gerenciar módulos). */
  constructor(public status: number, public code: string, message: string, public details?: unknown, public corpo?: Record<string, unknown>) { super(message); }
}
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(path, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${getToken()}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await r.text();
  let data: any; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!r.ok) throw new ApiError(r.status, data.error ?? "error", data.message ?? `HTTP ${r.status}`, data.details, data);
  return data as T;
}

type Listener = (ev: string) => void;
const listeners = new Set<Listener>();
let es: EventSource | undefined;
let opening = false;
/** Eventos em tempo real: a sessão nunca vai na URL; troca-se por um ticket curto e de uso único (e um novo a cada reconexão). */
function openEvents(): void {
  if (es || opening || !getToken()) return;
  opening = true;
  api<{ ticket: string }>("/api/events/ticket", { method: "POST" })
    .then(({ ticket }) => {
      es = new EventSource(`/api/events?ticket=${ticket}`);
      for (const ev of ["notes", "proposals", "module.badge", "module.notification"]) es.addEventListener(ev, () => listeners.forEach((f) => f(ev)));
      es.onerror = () => { es?.close(); es = undefined; setTimeout(openEvents, 3000); };
    })
    .catch(() => { setTimeout(openEvents, 5000); })
    .finally(() => { opening = false; });
}
/** Eventos que recarregam as consultas comuns (notas, propostas). `module.*` não: não mudam grafo nem notas. */
export const EVENTOS_PADRAO: readonly string[] = ["notes", "proposals"];
/** Eventos que só as consultas de módulos (menu, aba, seção Módulos) acompanham. */
export const EVENTOS_MODULOS: readonly string[] = ["module.badge", "module.notification"];
export const recarregaCom = (eventos: readonly string[], ev: string): boolean => eventos.includes(ev);

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  openEvents();
  return () => { listeners.delete(l); };
}

export interface NoteSummary { id: string; title: string; type: NoteType; status: NoteStatus; project?: string; tags: string[]; updated_at: string; created_at: string; summary: string }
export interface Dashboard {
  totals: { knowledge: number; projects: number; by_type: Record<string, number>; pending: number };
  today: { queries: number; added: number; updated: number; conflicts: number };
  projects: Array<{ id: string; title: string; notes: number; last_updated: string; by_type: Record<string, number> }>;
  recent: NoteSummary[];
  needs_review: { duplicates: number; conflicts: number; pending: number; stale: number; stale_items: NoteSummary[] };
  most_used: Array<{ id: string; title: string; n: number }>;
  agents: Array<{ name: string; kind: string; n: number; last: string; reads: number; writes: number }>;
  health: { ok: boolean; git_dirty: number; embeddings_ok: boolean; problems: { notes_with_issues: number; dangling_links: number; duplicate_ids: number; sync_conflict_copies?: number }; provider: string };
}
export interface Integrations { vault: string; claude: { mcp: boolean; policy: boolean; skill: boolean }; codex: { mcp: boolean; policy: boolean; skill: boolean } }
export interface NoteDetail {
  note: Note; backlinks: Array<{ src: string; type: string; title: string }>;
  outgoing: Array<{ dst: string; type: string; title?: string; exists: boolean }>;
  history: Array<{ hash: string; date: string; author: string; subject: string }>;
  similar: SimilarMatch[]; issues: string[];
  usage: { reads: number; last_read?: string }; activity: ActivityEntry[];
}

export interface RecentWrite { commit: string; date: string; agent: string; resolution: "create" | "complement"; note_id: string; title: string; capture_id?: string }
export type AssistantErrorKind = "auth" | "timeout" | "orcamento" | "erro";
export type CaptureAction = "criada" | "complementada" | "na_fila" | "ignorada";
export type CaptureOutcome =
  | { ok: true; notas: Array<{ id: string; acao: CaptureAction }>; segredo_omitido: boolean; texto_mascarado: string | null }
  | { ok: false; tipo: AssistantErrorKind; mensagem: string };
export interface CaptureResponse { capture_id: string; state: "pendente" | "processada" | "desfeita"; result: CaptureOutcome }
export type AskOutcome = { ok: true; resposta: string; fontes: string[] } | { ok: false; tipo: AssistantErrorKind; mensagem: string };

export interface ModuloTarefa { tarefa: string; quando: string; proxima: string; ultimaOcorrencia?: string; inicio?: string; fim?: string; resultado?: "ok" | "erro" | "timeout"; erro?: string; suspensa: boolean; errosSeguidos: number }
export interface ModuloInfo { id: string; nome: string; icone?: string; aba: boolean; badge: number; status: "ativo" | "falho" | "inativo" | "ausente"; causa?: string; versao?: string; sdk?: number; pasta: string; configJson?: Record<string, unknown>; iaHojeUsd: number; iaBloqueada?: boolean; iaBloqueio?: string; tarefas: ModuloTarefa[]; erros: Array<{ em: string; onde: string; mensagem: string }> }
export interface ModulosResp { modulos: ModuloInfo[]; reiniciar: boolean }

// ---- gerenciar módulos (`/api/modules/_gerenciar/*`, `/api/fs/pastas`) ----
export interface PastaListada { nome: string; caminho: string; provavelModulo: boolean }
export interface ListagemDePastas { caminho: string; pai?: string; pastas: PastaListada[] }
export interface ResumoModulo {
  id: string; nome: string; versao: string; sdk: number; aba?: { titulo: string };
  tarefas: Array<{ id: string; quando: string; quandoTexto: string }>;
  ferramentas: string[]; rotas: { total: number; humanas: number }; usaIa: boolean;
  configJson?: Record<string, unknown>;
}
export interface Conferencia { ok: boolean; causas: string[]; resumo?: ResumoModulo; caminho: string; ticket?: string }
export interface ErroDeCampo { campo: string; mensagem: string }
export interface RespostaGerenciar { mensagem: string; reiniciar?: boolean }
export interface EntradaDeModulo { enabled?: boolean; path?: string; host?: string; config?: Record<string, unknown> }

const GER = "/api/modules/_gerenciar";
export const listarPastas = (caminho?: string) => api<ListagemDePastas>(`/api/fs/pastas${caminho ? `?caminho=${encodeURIComponent(caminho)}` : ""}`);
export const inspecionarModulo = (caminho: string, fraseSenha?: string) => api<Conferencia>(`${GER}/inspecionar`, { method: "POST", body: { caminho, ...(fraseSenha ? { fraseSenha } : {}) } });
export const adicionarModulo = (b: { ticket: string; config: Record<string, unknown>; soNestaMaquina: boolean }) => api<RespostaGerenciar>(`${GER}/adicionar`, { method: "POST", body: b });
export const atualizarModulo = (id: string, b: { enabled?: boolean; config?: Record<string, unknown>; soNestaMaquina?: boolean; fraseSenha?: string }) => api<RespostaGerenciar>(`${GER}/${encodeURIComponent(id)}`, { method: "PUT", body: b });
export const removerModulo = (id: string) => api<RespostaGerenciar>(`${GER}/${encodeURIComponent(id)}`, { method: "DELETE" });
/** Se o vault tem (ou exige) a frase-senha: com ela, configurar um desligado grava sem validar pelo schema do módulo. */
export const ESTADO_GERENCIAR = `${GER}/estado`;
export const reiniciarServe = () => api<RespostaGerenciar>(`${GER}/reiniciar`, { method: "POST", body: {} });
