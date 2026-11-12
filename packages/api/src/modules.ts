import type { ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { MODULE_ID_RE, bloqueioIaNoDia, compilarRota, gastoIaDoDia, safeResolve, validar, type AvisosStore, type LoadedModule, type ModuleRegistry, type RotaCompilada, type Scheduler } from "@brain/core";
import type { Chamador, Rota } from "@brain/module-sdk";
import { BrainError, type Principal } from "@brain/shared";

/** Peças de módulos que o `serve` entrega à API (spec de módulos §7.6, §7.8, §7.9). */
export interface ModulesApiOptions {
  registry: ModuleRegistry; scheduler?: Scheduler; avisos: AvisosStore;
  /** raiz do estado dos módulos (`modulesStateRoot`): de onde sai o gasto de IA do dia (`_ia.json`) */
  root: string;
  /** `true` quando o bloco `modules` do `config.yaml` em disco mudou desde a subida (o `serve` precisa reiniciar) */
  reiniciar?: () => boolean;
}

/** Tipo de credencial de uma requisição. A decisão fica concentrada em `negarAntesDoRoteamento`/`credencialDeModulo`. */
export type TipoCredencial = "sessao" | "desktop" | "api-token" | "pagina";
/** Credencial resolvida. O token de página (§7.7) carrega o id do módulo para o qual foi emitido. */
export type Credencial = { tipo: Exclude<TipoCredencial, "pagina"> } | { tipo: "pagina"; modulo: string };

/** `undefined` = credencial que não está na matriz (nega). O token de página não é um `Principal`: vem de `TokensDePagina`. */
export function credencialDoPrincipal(p: Principal): Credencial | undefined {
  if (p.kind === "human" && p.channel === "ui") return { tipo: "sessao" };
  if (p.kind === "human" && p.channel === "desktop") return { tipo: "desktop" };
  if (p.kind === "agent" && p.channel === "api") return { tipo: "api-token" };
  return undefined;
}

const PREFIXO = "/api/modules/";
const MCP_RE = /^\/api\/modules\/[^/]+\/_mcp\/[^/]+$/;
const ehMcp = (caminho: string) => MCP_RE.test(caminho);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** Sub-rotas tratadas pelo SB antes das do módulo; a página (token de página ou origem opaca) nunca as alcança. */
const RESERVADAS_DA_PAGINA = new Set(["ui-token", "_mcp", "_tarefas"]);

/** `/api/modules/<id>/<sub>` que a página do módulo pode chamar → `<id>`; `undefined` fora disso. */
export function moduloDaRotaDePagina(caminho: string): string | undefined {
  if (!caminho.startsWith(PREFIXO)) return undefined;
  const [id, ...segs] = caminho.slice(PREFIXO.length).split("/");
  if (!id || !MODULE_ID_RE.test(id) || !segs.length || RESERVADAS_DA_PAGINA.has(segs[0]!)) return undefined;
  return id;
}

const naoPrevista = (_c: never): undefined => undefined;

/**
 * `chamador` de uma rota sob `/api/modules/<id>/...`, decidido só pela credencial e pelo caminho (nunca por cabeçalho do
 * cliente). `undefined` = negado. Ponto único da matriz para rotas de módulo (§7.6).
 */
export function credencialDeModulo(cred: Credencial, metodo: string, caminho: string): Chamador | undefined {
  switch (cred.tipo) {
    case "sessao": return ehMcp(caminho) ? undefined : { via: "ui", humano: true };
    // o nome do agente não vem de cabeçalho: o api-token é sempre o agente fixo da API
    case "api-token": return metodo === "POST" && ehMcp(caminho) ? { via: "mcp", humano: false } : undefined;
    // só o próprio módulo, fora de ui-token/_mcp/_tarefas (rodar tarefa exige a sessão humana, §7.8)
    case "pagina": return moduloDaRotaDePagina(caminho) === cred.modulo ? { via: "pagina", humano: true } : undefined;
    case "desktop": return undefined; // nenhuma rota de módulo
    default: return naoPrevista(cred);
  }
}

const DESKTOP_MSG = "credencial do desktop só acessa o assistente";
const ehDesktopPermitido = (metodo: string, caminho: string) =>
  caminho.startsWith("/api/assistant/")
  || (metodo === "GET" && caminho === "/api/health")
  || (metodo === "GET" && caminho === "/api/notifications")
  || (metodo === "POST" && /^\/api\/notifications\/[^/]+\/visto$/.test(caminho));

const NAO_RECONHECIDA = "credencial não reconhecida";
const PAGINA_MSG = "o token de página só vale nas rotas do próprio módulo";

/**
 * Matriz de credenciais, aplicada ANTES do roteamento (rota nova nasce bloqueada para o desktop e para a página; o api-token
 * nunca chega a um lookup de módulo fora do `_mcp`). Devolve a mensagem do 403, ou `undefined` se a requisição segue.
 * Tipo de credencial fora do `switch` nega (o `never` obriga a tratar um tipo novo aqui).
 */
export function negarAntesDoRoteamento(cred: Credencial | undefined, metodo: string, caminho: string): string | undefined {
  if (!cred) return NAO_RECONHECIDA;
  switch (cred.tipo) {
    case "desktop": return ehDesktopPermitido(metodo, caminho) ? undefined : DESKTOP_MSG;
    case "pagina": return credencialDeModulo(cred, metodo, caminho) ? undefined : PAGINA_MSG;
    case "sessao": case "api-token": {
      if (caminho.startsWith("/api/notifications")) return cred.tipo === "sessao" ? undefined : "avisos só para a sessão humana e o desktop";
      if (caminho === "/api/modules") return cred.tipo === "sessao" || metodo === "GET" ? undefined : "o api-token só lê a lista de módulos";
      if (caminho.startsWith("/api/modules")) {
        if (credencialDeModulo(cred, metodo, caminho)) return undefined;
        return cred.tipo === "sessao" ? "_mcp é só para o api-token (processo MCP)" : "o api-token só acessa GET /api/modules e as ferramentas (_mcp) dos módulos";
      }
      return undefined; // rotas do core: inalteradas para a sessão e o api-token
    }
    default: return naoPrevista(cred) ?? NAO_RECONHECIDA;
  }
}

/** Única checagem de humano antes de todo handler de rota de módulo. `humano` não booleano mas verdadeiro também exige humano. */
export function podeChamar(rota: Rota, chamador: Chamador): boolean {
  return !rota.humano || chamador.humano === true;
}

const decodificar = (s: string): string => {
  try { return decodeURIComponent(s); } catch { throw new BrainError("invalid", "caminho com codificação inválida"); }
};

/** Rotas compiladas uma vez por objeto de rota (o `def` do módulo é imutável depois da carga). `null` = não compila. */
const compiladas = new WeakMap<object, RotaCompilada | null>();

function casar(rota: Rota, caminho: string): Record<string, string> | undefined {
  let c = compiladas.get(rota);
  if (c === undefined) { c = compilarRota(rota.caminho) ?? null; compiladas.set(rota, c); }
  const cruos = c?.casar(caminho);
  if (!cruos) return undefined;
  const params: Record<string, string> = {};
  for (const [n, v] of Object.entries(cruos)) params[n] = decodificar(v);
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

export interface ReqModulo {
  metodo: string; url: URL; body: unknown; cred: Credencial; paginas: TokensDePagina; res: ServerResponse;
  /** credencial apresentada (o `ui-token` guarda o hash da sessão emissora) */
  token: string;
}

/**
 * Rotas de módulo e de avisos. Devolve `false` se o caminho não é delas (segue para o 404 do core). A matriz já foi aplicada.
 * Ordem: módulo existe → (ui-token) → módulo ativo → rota casa → `podeChamar` → handler.
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
    return responder(res, 200, { modulos: o.registry.list().map((m) => resumo(o, m, badges[m.id] ?? 0)), reiniciar: o.reiniciar?.() ?? false });
  }
  if (!caminho.startsWith(PREFIXO)) return false;

  const resto = caminho.slice(PREFIXO.length);
  const barra = resto.indexOf("/");
  const id = barra < 0 ? resto : resto.slice(0, barra);
  const sub = barra < 0 ? "" : resto.slice(barra);
  if (!MODULE_ID_RE.test(id)) throw new BrainError("not_found", "módulo não encontrado");
  const m = o?.registry.get(id);
  if (!o || !m) throw new BrainError("not_found", `módulo "${id}" não encontrado`);
  const chamador = credencialDeModulo(r.cred, metodo, caminho);
  if (!chamador) throw new BrainError("forbidden", "credencial sem acesso a esta rota de módulo");
  const segs = sub.split("/").slice(1);

  // token da página (§7.7): só a sessão humana da UI, para um módulo que existe no registro
  if (segs[0] === "ui-token") {
    if (metodo !== "POST" || segs.length !== 1) throw new BrainError("not_found", `rota ${metodo} ${caminho}`);
    if (chamador.via !== "ui") throw new BrainError("forbidden", "o token de página só é emitido para a sessão humana da UI");
    return responder(res, 200, r.paginas.emitir(id, r.token));
  }
  if (m.status !== "ativo" || !m.def || !m.ctx) return responder(res, 503, { error: "module_unavailable", message: m.causa ?? "módulo indisponível" });
  const ctx = m.ctx;

  // nomes reservados: tratados antes das rotas do módulo (uma rota declarada com eles nunca é alcançada)
  if (segs[0] === "_mcp") {
    if (metodo !== "POST" || segs.length !== 2) throw new BrainError("not_found", `rota ${metodo} ${caminho}`);
    if (chamador.via !== "mcp") throw new BrainError("forbidden", "_mcp é só para o api-token (processo MCP)");
    const nome = decodificar(segs[1]!);
    const ferramenta = (Array.isArray(m.def.ferramentasMcp) ? m.def.ferramentasMcp : []).find((f) => f?.nome === nome);
    if (!ferramenta) throw new BrainError("not_found", `ferramenta "${id}_${nome}" não encontrada`);
    const v = await validar(ferramenta.entrada, (body as { args?: unknown } | null | undefined)?.args);
    // schema que lança é defeito do módulo (500 + Saúde); issues são entrada inválida (400)
    if (!v.ok) return v.lancou ? erroDoModulo(o, res, id, `mcp:${nome}`, v.erro) : responder(res, 400, { error: "invalid", message: v.mensagem });
    let texto: string | undefined;
    try { texto = serializar({ resultado: (await o.registry.executando(id, `mcp:${nome}`, () => ferramenta.rodar(v.value, ctx))) ?? null, chamador }); }
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
    const params = casar(rota, sub);
    if (!params) continue;
    if (!podeChamar(rota, chamador)) throw new BrainError("forbidden", "esta rota exige um humano");
    let texto: string | undefined;
    try { texto = serializar(await o.registry.executando(id, `rota:${metodo} ${rota.caminho}`, () => rota.rodar({ metodo, params, query: new URLSearchParams(url.search), body, chamador }, ctx))); }
    catch (e) { return erroDoModulo(o, res, id, `rota:${metodo} ${rota.caminho}`, e); }
    return texto === undefined ? responder(res, 204) : responder(res, 200, texto);
  }
  throw new BrainError("not_found", `rota ${metodo} ${caminho}`);
}

/**
 * Item de `GET /api/modules` (Saúde, §7.13). `pasta` é o caminho local do módulo: a rota só responde à sessão humana e ao
 * api-token (processos da própria máquina), nunca à página nem ao desktop.
 */
function resumo(o: ModulesApiOptions, m: LoadedModule, badge: number) {
  const bloqueio = bloqueioIaNoDia(o.root);
  return {
    id: m.id, nome: m.def?.nome ?? m.id, icone: m.def?.icone, aba: !!m.def?.aba,
    badge, status: m.status, causa: m.causa, versao: m.versao, sdk: m.def?.sdk, pasta: m.dir,
    iaHojeUsd: gastoIaDoDia(o.root, m.id),
    // registro de gasto de IA ilegível ou inacessível: a IA de todos os módulos fica bloqueada (o motivo diz até quando)
    iaBloqueada: !!bloqueio,
    iaBloqueio: bloqueio?.motivo,
    tarefas: o.scheduler?.status(m.id) ?? [],
    // os 10 mais recentes, em ordem cronológica (o último é o mais novo)
    erros: o.registry.errosRecentes(m.id, 10),
  };
}

// ---- Aba do módulo (§7.7): token de página, origem opaca e estático ----

const TTL_PAGINA_MS = 12 * 3600_000;
const hashDoToken = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * Tokens de página em memória do processo (reiniciar o `serve` invalida todos). Guarda só o SHA-256: a busca é pelo hash
 * do que o cliente apresentou, então o segredo nunca é comparado byte a byte. Cada emissão gera um token novo.
 * Cada token lembra o hash da sessão humana que o emitiu, e `sessaoViva` é consultada A CADA USO: sessão revogada
 * (`brain admin revoke-sessions`) ou expirada derruba na hora os tokens de página que ela emitiu.
 */
export class TokensDePagina {
  private readonly porHash = new Map<string, { modulo: string; expira: number; sessao: string }>();
  constructor(private readonly sessaoViva: (hashDaSessao: string) => boolean) {}

  emitir(modulo: string, sessaoEmissora: string): { token: string; expira: string } {
    const agora = Date.now();
    for (const [h, e] of this.porHash) if (e.expira <= agora) this.porHash.delete(h);
    const token = randomBytes(32).toString("base64url");
    const expira = agora + TTL_PAGINA_MS;
    this.porHash.set(hashDoToken(token), { modulo, expira, sessao: hashDoToken(sessaoEmissora) });
    return { token, expira: new Date(expira).toISOString() };
  }

  /** Id do módulo do token, ou `undefined` (desconhecido, expirado ou de uma sessão que já não está viva; é descartado). */
  modulo(token: string): string | undefined {
    if (!token) return undefined;
    const h = hashDoToken(token);
    const e = this.porHash.get(h);
    if (!e) return undefined;
    if (e.expira <= Date.now() || !this.sessaoViva(e.sessao)) { this.porHash.delete(h); return undefined; }
    return e.modulo;
  }
}

/**
 * Caminhos em que a origem opaca `null` (iframe da aba, sem `allow-same-origin`) é aceita: o estático `/modules/*` e
 * `/api/modules/<id>/*` fora de ui-token/_mcp/_tarefas. A segurança vem do token de página, não da origem.
 */
export const aceitaOrigemOpaca = (caminho: string): boolean => caminho.startsWith("/modules/") || moduloDaRotaDePagina(caminho) !== undefined;
export const CORS_OPACO = { "access-control-allow-origin": "null", vary: "Origin" } as const;
export const PREFLIGHT_OPACO = {
  ...CORS_OPACO, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE", "access-control-max-age": "600",
} as const;
/**
 * CSP do estático da aba. O `sandbox` (sem `allow-same-origin`) força a origem opaca mesmo quando a página é aberta como
 * documento de topo (link numa nota, favorito, URL digitada, um `.svg` da aba): sem ele, ela rodaria na origem real do SB e
 * leria o `localStorage` onde a UI guarda a sessão humana (anti-objetivo do §4). Os subrecursos de um documento sandboxed
 * mandam `Origin: null`, que é exatamente o CORS aceito nos prefixos de módulo.
 */
export const CSP_DA_ABA = "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'; form-action 'self'; sandbox allow-scripts allow-forms";

/** Caminho cru com segmento `.`/`..` (inclusive `%2e`, e `\` que a URL trata como `/`): a URL já normalizou, então recusa. */
export const temSegmentoDePonto = (bruto: string): boolean =>
  bruto.split(/[\\/]/).some((s) => { const d = s.replace(/%2e/gi, "."); return d === "." || d === ".."; });

/** `packages/module-sdk/static`, localizado pelo pacote (não pelo layout do repositório). */
export function pastaEstaticaDoSdk(): string | undefined {
  try { return join(dirname(createRequire(import.meta.url).resolve("@brain/module-sdk/package.json")), "static"); } catch { return undefined; }
}
const ARQUIVOS_DO_SDK = new Set(["base.css", "brain-module-client.js"]);

/**
 * Arquivo de `/modules/<id>/<arquivo>` (dentro de `<dir>/<aba.pasta>`, via `safeResolve`) ou de `/modules/_sdk/<arquivo>`.
 * `undefined` = 404: módulo inexistente, não ativo, sem aba, traversal, symlink para fora ou arquivo ausente.
 * `_sdk` não colide com módulo: o id sempre começa com letra.
 */
export function arquivoDaAba(o: ModulesApiOptions | undefined, pastaSdk: string | undefined, caminho: string): string | undefined {
  const resto = caminho.slice("/modules/".length);
  const barra = resto.indexOf("/");
  if (barra < 0) return undefined;
  const id = resto.slice(0, barra);
  let rel: string;
  try { rel = decodeURIComponent(resto.slice(barra + 1)); } catch { return undefined; }
  if (id === "_sdk") return pastaSdk && ARQUIVOS_DO_SDK.has(rel) ? join(pastaSdk, rel) : undefined;
  if (!MODULE_ID_RE.test(id)) return undefined;
  const m = o?.registry.get(id);
  const pasta = m?.def?.aba?.pasta;
  if (!m || m.status !== "ativo" || typeof pasta !== "string") return undefined;
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  try {
    const raiz = safeResolve(m.dir, pasta); // a pasta declarada também não sai da raiz do módulo
    const arq = safeResolve(raiz, rel);
    return statSync(arq).isFile() ? arq : undefined;
  } catch { return undefined; }
}
