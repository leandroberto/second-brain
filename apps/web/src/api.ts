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
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(path, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${getToken()}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await r.text();
  let data: any; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!r.ok) throw new ApiError(r.status, data.error ?? "error", data.message ?? `HTTP ${r.status}`, data.details);
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
export interface ModuloInfo { id: string; nome: string; icone?: string; aba: boolean; badge: number; status: "ativo" | "falho" | "inativo" | "ausente"; causa?: string; versao?: string; sdk?: number; pasta: string; iaHojeUsd: number; tarefas: ModuloTarefa[]; erros: Array<{ em: string; onde: string; mensagem: string }> }
export interface ModulosResp { modulos: ModuloInfo[]; reiniciar: boolean }
