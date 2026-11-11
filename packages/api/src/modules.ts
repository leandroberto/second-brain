import type { ServerResponse } from "node:http";
import { MODULE_ID_RE, validar, type AvisosStore, type LoadedModule, type ModuleRegistry, type Scheduler } from "@brain/core";
import type { Chamador, Rota } from "@brain/module-sdk";
import { BrainError, type Principal } from "@brain/shared";

/** Peças de módulos que o `serve` entrega à API (spec de módulos §7.6, §7.8, §7.9). */
export interface ModulesApiOptions { registry: ModuleRegistry; scheduler?: Scheduler; avisos: AvisosStore }

/**
 * Tipo de credencial de uma requisição. A Tarefa 7 acrescenta aqui o token de página (`{ via: "pagina" }`, só
 * `/api/modules/<id>/*` do próprio id), e a decisão continua concentrada em `negarAntesDoRoteamento`/`credencialDeModulo`.
 */
export type TipoCredencial = "sessao" | "desktop" | "api-token";

/** `undefined` = credencial que não está na matriz (nega). */
export function tipoCredencial(p: Principal): TipoCredencial | undefined {
  if (p.kind === "human" && p.channel === "ui") return "sessao";
  if (p.kind === "human" && p.channel === "desktop") return "desktop";
  if (p.kind === "agent" && p.channel === "api") return "api-token";
  return undefined;
}

const PREFIXO = "/api/modules/";
const MCP_RE = /^\/api\/modules\/[^/]+\/_mcp\/[^/]+$/;
const ehMcp = (caminho: string) => MCP_RE.test(caminho);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * `chamador` de uma rota sob `/api/modules/<id>/...`, decidido só pela credencial e pelo caminho (nunca por cabeçalho do
 * cliente). `undefined` = negado. Ponto único da matriz para rotas de módulo (§7.6).
 */
export function credencialDeModulo(tipo: TipoCredencial, metodo: string, caminho: string): Chamador | undefined {
  if (tipo === "sessao") return ehMcp(caminho) ? undefined : { via: "ui", humano: true };
  // o nome do agente não vem de cabeçalho: o api-token é sempre o agente fixo da API
  if (tipo === "api-token") return metodo === "POST" && ehMcp(caminho) ? { via: "mcp", humano: false } : undefined;
  return undefined; // desktop: nenhuma rota de módulo
}

const DESKTOP_MSG = "credencial do desktop só acessa o assistente";
const ehDesktopPermitido = (metodo: string, caminho: string) =>
  caminho.startsWith("/api/assistant/")
  || (metodo === "GET" && caminho === "/api/health")
  || (metodo === "GET" && caminho === "/api/notifications")
  || (metodo === "POST" && /^\/api\/notifications\/[^/]+\/visto$/.test(caminho));

/**
 * Matriz de credenciais, aplicada ANTES do roteamento (rota nova nasce bloqueada para o desktop; o api-token nunca chega a
 * um lookup de módulo fora do `_mcp`). Devolve a mensagem do 403, ou `undefined` se a requisição segue.
 */
export function negarAntesDoRoteamento(tipo: TipoCredencial | undefined, metodo: string, caminho: string): string | undefined {
  if (!tipo) return "credencial não reconhecida";
  if (tipo === "desktop") return ehDesktopPermitido(metodo, caminho) ? undefined : DESKTOP_MSG;
  if (caminho.startsWith("/api/notifications")) return tipo === "sessao" ? undefined : "avisos só para a sessão humana e o desktop";
  if (caminho === "/api/modules") return tipo === "sessao" || metodo === "GET" ? undefined : "o api-token só lê a lista de módulos";
  if (caminho.startsWith("/api/modules")) {
    if (credencialDeModulo(tipo, metodo, caminho)) return undefined;
    return tipo === "sessao" ? "_mcp é só para o api-token (processo MCP)" : "o api-token só acessa GET /api/modules e as ferramentas (_mcp) dos módulos";
  }
  return undefined; // rotas do core: inalteradas
}

/** Única checagem de humano antes de todo handler de rota de módulo. */
export function podeChamar(rota: Rota, chamador: Chamador): boolean {
  return rota.humano !== true || chamador.humano === true;
}

const decodificar = (s: string): string => {
  try { return decodeURIComponent(s); } catch { throw new BrainError("invalid", "caminho com codificação inválida"); }
};

/** `caminho` declarado (com `:param`) → regex; partes literais escapadas. */
function casar(declarado: string, caminho: string): Record<string, string> | undefined {
  const nomes: string[] = [];
  const fonte = declarado.split(/(:[A-Za-z_][A-Za-z0-9_]*)/).map((parte) => {
    if (parte.startsWith(":")) { nomes.push(parte.slice(1)); return "([^/]+)"; }
    return parte.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  const mt = new RegExp(`^${fonte}$`).exec(caminho);
  if (!mt) return undefined;
  const params: Record<string, string> = {};
  nomes.forEach((n, i) => { params[n] = decodificar(mt[i + 1]!); });
  return params;
}

function responder(res: ServerResponse, status: number, data?: unknown): true {
  if (data === undefined) { res.writeHead(status, { "cache-control": "no-store" }); res.end(); return true; }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(typeof data === "string" ? data : JSON.stringify(data));
  return true;
}

/** Erro de código do módulo: nunca vaza a mensagem; vai para `_erros.jsonl`. */
function erroDoModulo(o: ModulesApiOptions, res: ServerResponse, id: string, onde: string, e: unknown): true {
  o.registry.recordError(id, onde, e);
  return responder(res, 500, { error: "module_error" });
}

/** Serializa dentro do `try` do módulo: valor não serializável é erro do módulo, não da API. */
const serializar = (v: unknown): string | undefined => (v === undefined ? undefined : JSON.stringify(v));

export interface ReqModulo { metodo: string; url: URL; body: unknown; tipo: TipoCredencial; res: ServerResponse }

/**
 * Rotas de módulo e de avisos. Devolve `false` se o caminho não é delas (segue para o 404 do core). A matriz já foi aplicada.
 * Ordem: módulo existe → módulo ativo → rota casa → `podeChamar` → handler.
 */
export async function tratarModulos(o: ModulesApiOptions | undefined, r: ReqModulo): Promise<boolean> {
  const { metodo, url, body, res } = r;
  const caminho = url.pathname;

  if (caminho === "/api/notifications" && metodo === "GET") {
    return responder(res, 200, o ? o.avisos.listar(url.searchParams.get("depois") ?? undefined) : { avisos: [], cursor: "", badges: {}, total: 0 });
  }
  const visto = /^\/api\/notifications\/([^/]+)\/visto$/.exec(caminho);
  if (visto && metodo === "POST") {
    o?.avisos.marcarVisto(decodificar(visto[1]!));
    return responder(res, 204);
  }
  if (caminho === "/api/modules" && metodo === "GET") {
    if (!o) return responder(res, 200, { modulos: [], reiniciar: false });
    const { badges } = o.avisos.listar();
    return responder(res, 200, { modulos: o.registry.list().map((m) => resumo(o, m, badges[m.id] ?? 0)), reiniciar: false });
  }
  if (!caminho.startsWith(PREFIXO)) return false;

  const resto = caminho.slice(PREFIXO.length);
  const barra = resto.indexOf("/");
  const id = barra < 0 ? resto : resto.slice(0, barra);
  const sub = barra < 0 ? "" : resto.slice(barra);
  if (!MODULE_ID_RE.test(id)) throw new BrainError("not_found", "módulo não encontrado");
  const m = o?.registry.get(id);
  if (!o || !m) throw new BrainError("not_found", `módulo "${id}" não encontrado`);
  if (m.status !== "ativo" || !m.def || !m.ctx) return responder(res, 503, { error: "module_unavailable", message: m.causa ?? "módulo indisponível" });
  const chamador = credencialDeModulo(r.tipo, metodo, caminho);
  if (!chamador) throw new BrainError("forbidden", "credencial sem acesso a esta rota de módulo");
  const ctx = m.ctx;
  const segs = sub.split("/").slice(1);

  // nomes reservados: tratados antes das rotas do módulo (uma rota declarada com eles nunca é alcançada)
  if (segs[0] === "_mcp") {
    if (metodo !== "POST" || segs.length !== 2) throw new BrainError("not_found", `rota ${metodo} ${caminho}`);
    if (chamador.via !== "mcp") throw new BrainError("forbidden", "_mcp é só para o api-token (processo MCP)");
    const nome = decodificar(segs[1]!);
    const ferramenta = (Array.isArray(m.def.ferramentasMcp) ? m.def.ferramentasMcp : []).find((f) => f?.nome === nome);
    if (!ferramenta) throw new BrainError("not_found", `ferramenta "${id}_${nome}" não encontrada`);
    const v = await validar(ferramenta.entrada, (body as { args?: unknown } | null | undefined)?.args);
    if (!v.ok) return responder(res, 400, { error: "invalid", message: v.mensagem });
    let texto: string | undefined;
    try { texto = serializar({ resultado: (await ferramenta.rodar(v.value, ctx)) ?? null, chamador }); }
    catch (e) { return erroDoModulo(o, res, id, `mcp:${nome}`, e); }
    return responder(res, 200, texto);
  }
  if (segs[0] === "_tarefas") {
    if (metodo !== "POST" || segs.length !== 3 || segs[2] !== "rodar") throw new BrainError("not_found", `rota ${metodo} ${caminho}`);
    if (chamador.via !== "ui") throw new BrainError("forbidden", "rodar tarefa exige a sessão humana da UI");
    if (!o.scheduler) throw new BrainError("state_unavailable", "agendador não disponível neste servidor (suba com `brain serve`)");
    const raw = (body as { ocorrencia?: unknown } | null | undefined)?.ocorrencia;
    let ocorrencia: Date | undefined;
    if (raw !== undefined) {
      ocorrencia = typeof raw === "string" && ISO_RE.test(raw) ? new Date(raw) : new Date(NaN);
      if (Number.isNaN(ocorrencia.getTime())) throw new BrainError("invalid", "ocorrencia deve ser uma data ISO");
    }
    const out = await o.scheduler.runNow(id, decodificar(segs[1]!), ocorrencia);
    return responder(res, 200, out);
  }

  const rotas = Array.isArray(m.def.rotas) ? m.def.rotas : [];
  for (const rota of rotas) {
    if (rota?.metodo !== metodo || typeof rota.caminho !== "string") continue;
    const params = casar(rota.caminho, sub);
    if (!params) continue;
    if (!podeChamar(rota, chamador)) throw new BrainError("forbidden", "esta rota exige um humano");
    let texto: string | undefined;
    try { texto = serializar(await rota.rodar({ metodo, params, query: new URLSearchParams(url.search), body, chamador }, ctx)); }
    catch (e) { return erroDoModulo(o, res, id, `rota:${metodo} ${rota.caminho}`, e); }
    return texto === undefined ? responder(res, 204) : responder(res, 200, texto);
  }
  throw new BrainError("not_found", `rota ${metodo} ${caminho}`);
}

function resumo(o: ModulesApiOptions, m: LoadedModule, badge: number) {
  return {
    id: m.id, nome: m.def?.nome ?? m.id, icone: m.def?.icone, aba: !!m.def?.aba,
    badge, status: m.status, causa: m.causa, versao: m.versao,
    tarefas: o.scheduler?.status(m.id) ?? [],
  };
}
