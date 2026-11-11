import { readFileSync } from "node:fs";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { BRAIN_TOOLS, Brain, MODULE_TOOL_RE, loadModules, modulesStateRoot, principal, serveUrl, type LoadedModule, type ModuleRegistry } from "@brain/core";
import { BrainError, NOTE_TYPES, RELATION_TYPES, RESOLUTIONS, type Principal } from "@brain/shared";

const VERSION = "0.1.0";

export const INSTRUCTIONS = `Second Brain: base de conhecimento compartilhada (Markdown+Git), neutra de fornecedor.
Antes de trabalho substancial: brain_context (projeto/tópico/tarefa) e, se preciso, brain_search + brain_get. Recupere só o relevante.
Ao descobrir conhecimento DURÁVEL (decisão, preferência, aprendizado, regra, fato de projeto): brain_similar e depois brain_propose. Nunca sobrescreva em silêncio. Se o retorno do brain_propose trouxer o campo auto, o vault gravou direto (política additive); sem auto, a proposta aguarda revisão humana.
Nunca envie segredos, tokens, logs grandes ou código copiado; prefira referências (repo/PR/commit/arquivo:linha).`;

type Ok = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (v: unknown): Ok => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });
const fail = (e: unknown): Ok => {
  if (e instanceof BrainError) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: e.code, message: e.message, ...(e.code === "secret_detected" ? {} : e.details ? { details: e.details } : {}) }) }] };
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "internal", message: (e as Error).message }) }] };
};

const Source = z.object({
  type: z.enum(["git", "pr", "issue", "doc", "conversation", "manual", "other"]),
  repository: z.string().optional(), ref: z.string().optional(), url: z.string().optional(),
}).describe("Origem do conhecimento: prefira repo/PR/commit/arquivo:linha em vez de copiar código");

const Draft = {
  title: z.string().min(3).max(200).describe("Título curto e específico (vira o nome do conhecimento)"),
  type: z.enum(NOTE_TYPES).describe("decision|learning|fact|preference|pattern|reference|project|concept|open-question"),
  body: z.string().min(10).describe("Markdown conciso. Sem segredos, sem dumps, sem código longo."),
  project: z.string().optional().describe("slug do projeto (ex.: promo-watcher), se aplicável"),
  tags: z.array(z.string()).optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  source: Source.optional(),
  temporal: z.object({
    as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("data em que a afirmação foi verificada (AAAA-MM-DD)"),
    revalidate_when: z.string().min(3).max(200).optional().describe("evento que obriga a revalidar (ex.: \"status de produção mudar\")"),
  }).optional().describe("Só para conhecimento TEMPORAL (verdade hoje, pode deixar de ser): ex. \"ainda não está em produção\", \"flag X desligada\""),
};

const AGENT_NAME = /^[a-z0-9/_-]{1,80}$/;

/**
 * Nome do agente definido por quem INICIA o processo MCP (o motor de assistente usa `assistant/<captureId>`), lido do
 * ambiente e não de argumento de ferramenta. Ausente (ou vazio): `undefined`, e vale a identificação pelo cliente. Inválido:
 * "claude-code", com aviso no stderr (stdout é do protocolo).
 */
export function agentNameFromEnv(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = (m) => console.error(m)): string | undefined {
  const raw = env.BRAIN_AGENT_NAME;
  if (raw === undefined || raw === "") return undefined;
  if (AGENT_NAME.test(raw)) return raw;
  warn(`[brain] BRAIN_AGENT_NAME inválido (${JSON.stringify(raw.slice(0, 80))}); usando "claude-code"`);
  return "claude-code";
}

const MODULE_AGENT = /^module\/[a-z][a-z0-9-]{1,30}$/;

/**
 * Canal do agente, definido por quem INICIA o processo (`BRAIN_AGENT_CHANNEL`). Só `module` é aceito, e só com nome
 * `module/<id>`; qualquer outro valor (inclusive canais humanos como `ui`) é ignorado com aviso no stderr: continua `mcp`.
 */
export function agentChannelFromEnv(env: NodeJS.ProcessEnv, name: string | undefined, warn: (m: string) => void = (m) => console.error(m)): "mcp" | "module" {
  const raw = env.BRAIN_AGENT_CHANNEL;
  if (raw === undefined || raw === "") return "mcp";
  if (raw === "module" && name !== undefined && MODULE_AGENT.test(name)) return "module";
  warn(`[brain] BRAIN_AGENT_CHANNEL ignorado (${JSON.stringify(raw.slice(0, 40))} com agente ${JSON.stringify((name ?? "").slice(0, 80))}); usando "mcp"`);
  return "mcp";
}

/**
 * Problema que impede registrar a ferramenta de módulo no MCP, ou `undefined` se ela é registrável: nome fora de
 * `MODULE_TOOL_RE`, sem descrição, `entrada` que não é Standard Schema, ou `entradaJson` que não é um JSON Schema de objeto
 * que o SDK do MCP compile. Usado no registro e no `brain modules check`.
 */
export function problemaDaFerramenta(f: unknown): string | undefined {
  const x = (f ?? {}) as Partial<FerramentaMcp>;
  if (typeof x.nome !== "string" || !MODULE_TOOL_RE.test(x.nome)) return `nome de ferramenta inválido: "${String(x.nome)}" (use ${MODULE_TOOL_RE.source})`;
  if (typeof x.descricao !== "string" || !x.descricao.trim()) return `ferramenta ${x.nome}: descricao ausente`;
  if (typeof (x.entrada as { "~standard"?: { validate?: unknown } } | undefined)?.["~standard"]?.validate !== "function") return `ferramenta ${x.nome}: entrada não é um Standard Schema (use zod 4)`;
  if (typeof x.rodar !== "function") return `ferramenta ${x.nome}: rodar ausente`;
  const j = x.entradaJson as { type?: unknown } | undefined;
  if (!j || typeof j !== "object" || Array.isArray(j) || j.type !== "object") return `ferramenta ${x.nome}: entradaJson deve ser um JSON Schema com type "object"`;
  try { fromJsonSchema(j as Parameters<typeof fromJsonSchema>[0]); }
  catch (e) { return `ferramenta ${x.nome}: entradaJson inválido (${(e as Error).message})`; }
  return undefined;
}

type FerramentaMcp = NonNullable<NonNullable<LoadedModule["def"]>["ferramentasMcp"]>[number];

/** Tempo máximo de uma chamada de ferramenta de módulo no serve. */
const TIMEOUT_FERRAMENTA_MS = 5 * 60_000;

/**
 * `BRAIN_MCP_SEM_MODULOS=1` (posto pelo motor do assistente no mcp.json que ele gera): o processo não importa módulos nem
 * registra ferramentas deles, que o assistente não pode usar.
 */
export function moduleToolsEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BRAIN_MCP_SEM_MODULOS !== "1";
}

const textoDeErro = (texto: string): Ok => ({ isError: true, content: [{ type: "text", text: texto }] });

/**
 * Executa a ferramenta de módulo no `serve` (§7.10): `POST <serve>/api/modules/<id>/_mcp/<nome>` com o api-token do vault.
 * O estado do módulo tem um único dono (o `serve`); aqui só se repassa a entrada e o `resultado`. Nenhuma mensagem leva o token.
 */
async function executarNoServe(brain: Brain, id: string, nome: string, args: unknown): Promise<Ok> {
  const ferramenta = `${id}_${nome}`;
  const foraDoAr = textoDeErro(`o brain serve não está rodando; a ferramenta ${ferramenta} precisa dele`);
  let token: string;
  try { token = readFileSync(brain.vault.tokenPath, "utf8").trim(); } catch { return foraDoAr; }
  if (!token) return foraDoAr;
  const limpar = (t: string) => t.split(token).join("***");
  const url = await serveUrl(modulesStateRoot(brain), brain.vault);
  let r: Response;
  try {
    r = await fetch(`${url}/api/modules/${encodeURIComponent(id)}/_mcp/${encodeURIComponent(nome)}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ args: args ?? {} }),
      signal: AbortSignal.timeout(TIMEOUT_FERRAMENTA_MS),
    });
  } catch (e) {
    if ((e as Error)?.name === "TimeoutError") return textoDeErro(`a ferramenta ${ferramenta} não respondeu em ${TIMEOUT_FERRAMENTA_MS / 60_000} min (o brain serve pode seguir com ela)`);
    return foraDoAr;
  }
  let corpo: { resultado?: unknown; message?: unknown } = {};
  try { corpo = await r.json() as typeof corpo; } catch { /* corpo vazio ou não JSON */ }
  if (r.ok) return ok(corpo.resultado ?? null);
  const detalhe = typeof corpo.message === "string" && corpo.message ? `: ${limpar(corpo.message).slice(0, 300)}` : "";
  const porStatus: Record<number, string> = {
    400: `entrada inválida para ${ferramenta}${detalhe}`,
    401: `o brain serve em ${url} recusou o api-token deste vault (é de outro vault?)`,
    403: `o brain serve negou a ferramenta ${ferramenta}${detalhe}`,
    404: `${ferramenta} não existe no brain serve em execução${detalhe}; se o módulo foi adicionado agora, reinicie o brain serve`,
    500: `a ferramenta ${ferramenta} falhou no módulo ${id}; o erro foi registrado (veja brain doctor ou a Saúde na UI)`,
    503: `o módulo ${id} está indisponível no brain serve${detalhe}`,
  };
  return textoDeErro(limpar(porStatus[r.status] ?? `o brain serve respondeu ${r.status} para ${ferramenta}${detalhe}`));
}

/**
 * Registra `<id>_<nome>` para cada ferramenta dos módulos carregados (só os que têm definição). Nunca substitui uma do core:
 * todo o espaço `brain_*` é reservado a ele, e nome repetido ou inválido é ignorado. Avisos vão para o stderr (stdout é do protocolo).
 */
function registrarFerramentasDeModulos(server: McpServer, brain: Brain, modulos: ModuleRegistry, ocupados: Set<string>, warn: (m: string) => void): void {
  for (const m of modulos.list()) {
    if (!m.def || m.status !== "ativo") continue;
    for (const f of Array.isArray(m.def.ferramentasMcp) ? m.def.ferramentasMcp : []) {
      const nomeMcp = `${m.id}_${String((f as Partial<FerramentaMcp> | undefined)?.nome)}`;
      const problema = problemaDaFerramenta(f);
      if (problema) { warn(`[brain] módulo ${m.id}: ferramenta ignorada: ${problema}`); continue; }
      if (nomeMcp.startsWith("brain_")) { warn(`[brain] módulo ${m.id}: ferramenta ${nomeMcp} ignorada (o prefixo brain_ é das ferramentas do core)`); continue; }
      if (ocupados.has(nomeMcp)) { warn(`[brain] módulo ${m.id}: ferramenta ${nomeMcp} ignorada (nome repetido)`); continue; }
      ocupados.add(nomeMcp);
      server.registerTool(nomeMcp, {
        title: `${m.def.nome ?? m.id}: ${f.nome}`,
        description: f.descricao,
        inputSchema: fromJsonSchema(f.entradaJson as Parameters<typeof fromJsonSchema>[0]),
      }, async (args: unknown) => {
        try { return await executarNoServe(brain, m.id, f.nome, args); }
        catch (e) { return textoDeErro(`falha ao chamar o brain serve para ${nomeMcp}: ${(e as Error)?.message ?? String(e)}`); }
      });
    }
  }
}

/**
 * Cria o servidor MCP. `brain` é compartilhado com nenhum outro processo: cada cliente (Claude, Codex) tem o seu, coordenados por lock de arquivo.
 * Síncrono: `modulos` (definições já carregadas, sem `iniciar`) vem de quem chama (`runStdio`).
 */
export function createServer(brain: Brain, opts: { agentOverride?: string; modulos?: ModuleRegistry } = {}): McpServer {
  const server = new McpServer({ name: "second-brain", version: VERSION }, { instructions: INSTRUCTIONS });
  const fromEnv = agentNameFromEnv();
  const channel = agentChannelFromEnv(process.env, fromEnv);
  // a identidade é do ADAPTER: todo cliente MCP é um agente (canal mcp); nenhum argumento de ferramenta muda isso
  const actor = (): Principal => {
    if (fromEnv) return principal("agent", fromEnv, channel);
    const raw = (opts.agentOverride ?? server.server.getClientVersion()?.name ?? "unknown-agent").toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    // nomes de cliente variam (ex.: "codex-mcp-client"); normaliza para a auditoria agrupar por agente
    const name = /^codex/.test(raw) ? "codex" : /^claude/.test(raw) ? "claude-code" : raw;
    return principal("agent", name, "mcp");
  };
  const guard = <A>(fn: (a: A) => Promise<unknown>) => async (args: A): Promise<Ok> => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };
  const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool("brain_search", {
    title: "Buscar conhecimento",
    description: "Busca híbrida (texto FTS + semântica) na base. Retorna trechos, não notas inteiras. Notas substituídas/históricas/arquivadas ficam fora por padrão (include_inactive=true para história). Resultado com `freshness` (planned/uncertain/conflict) NÃO foi confirmado como estado atual.",
    inputSchema: z.object({
      query: z.string().min(1), project: z.string().optional(), type: z.enum(NOTE_TYPES).optional(),
      tags: z.array(z.string()).optional(), since: z.string().optional().describe("ISO date: apenas alterados desde"),
      include_inactive: z.boolean().optional(), limit: z.number().int().min(1).max(25).optional(),
    }),
    annotations: RO,
  }, guard(async (a) => brain.search(a.query, { project: a.project, type: a.type, tags: a.tags, since: a.since, include_inactive: a.include_inactive }, a.limit ?? 8, actor())));

  server.registerTool("brain_context", {
    title: "Pacote de contexto",
    description: "Retorna um pacote pequeno e relevante (visão do projeto, decisões/preferências ATUAIS, resultados do tópico) para iniciar uma tarefa. Use ANTES de trabalho substancial. `items` = estado atual (item com `freshness` não foi confirmado: verifique). `history` = conhecimento substituído/histórico que casou com o tópico (\"X substituído por Y\"): explica a evolução, NÃO é o estado atual. Peça histórico no tópico (\"por que mudou\", \"histórico\") para receber resumos.",
    inputSchema: z.object({ project: z.string().optional(), topic: z.string().optional(), task: z.string().optional(), max_items: z.number().int().min(1).max(15).optional() }),
    annotations: RO,
  }, guard(async (a) => brain.context(a, actor())));

  server.registerTool("brain_get", {
    title: "Ler conhecimento",
    description: "Obtém uma nota completa (conteúdo, metadados, relações, histórico Git, semelhantes) ou uma proposta (id prop-...).",
    inputSchema: z.object({ id: z.string(), max_chars: z.number().int().min(500).max(20000).optional() }),
    annotations: RO,
  }, guard(async (a) => {
    if (a.id.startsWith("prop-")) return brain.getProposal(a.id);
    const r = await brain.get(a.id, actor());
    const body = r.note.body.length > (a.max_chars ?? 8000) ? r.note.body.slice(0, a.max_chars ?? 8000) + "\n…[truncado]" : r.note.body;
    return { ...r.note, body, backlinks: r.backlinks, outgoing: r.outgoing, history: r.history.slice(0, 5), similar: r.similar, issues: r.issues };
  }));

  server.registerTool("brain_recent", {
    title: "Mudanças recentes", description: "Conhecimento criado/alterado recentemente.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional(), since: z.string().optional(), project: z.string().optional() }),
    annotations: RO,
  }, guard(async (a) => brain.recent(a)));

  server.registerTool("brain_projects", {
    title: "Projetos conhecidos", description: "Lista projetos com contagem de conhecimento.", inputSchema: z.object({}), annotations: RO,
  }, guard(async () => brain.projects()));

  server.registerTool("brain_similar", {
    title: "Detectar semelhantes",
    description: "Antes de propor: classifica o conteúdo (new|duplicate|complement|update|replace|conflict) e lista notas semelhantes. Não grava nada.",
    inputSchema: z.object({ title: z.string(), body: z.string(), project: z.string().optional(), type: z.enum(NOTE_TYPES).optional() }),
    annotations: RO,
  }, guard(async (a) => brain.similar(a, actor())));

  server.registerTool("brain_propose", {
    title: "Propor conhecimento",
    description: "Propõe conhecimento durável: cria uma proposta classificada (new/duplicate/complement/update/replace/conflict). Por padrão ela entra na Review Queue e nada é gravado. Se o vault usa a política additive, nota nova e complemento são gravados direto e duplicata é ignorada: o retorno traz o campo `auto` (resolution, note_id), e é por ele que você sabe que gravou. Atualização, substituição e conflito vão sempre para a fila. Segredos e dumps são rejeitados.",
    inputSchema: z.object({
      ...Draft,
      reason: z.string().optional().describe("Por que isto é durável e útil"),
      intent: z.enum(["new", "complement", "update", "replace"]).optional(),
      target_id: z.string().optional().describe("id existente que esta proposta complementa/atualiza/substitui"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async (a) => {
    const p = await brain.propose(a, actor());
    const AUTO_NEXT = { create: "nota criada", complement: "nota existente complementada", ignore: "duplicata ignorada, nenhuma nota nova" } as const;
    return { proposal_id: p.id, state: p.state, classification: p.analysis.classification, suggested_resolution: p.analysis.suggested_resolution, target_id: p.analysis.target_id, similar: p.analysis.matches.slice(0, 3).map((m) => ({ id: m.id, title: m.title, similarity: m.similarity })), warnings: p.analysis.warnings,
      ...(p.auto ? { auto: p.auto } : {}),
      next: p.auto
        ? `gravado direto (política additive): ${AUTO_NEXT[p.auto.resolution]}${p.auto.note_id ? ` (${p.auto.note_id})` : ""}. Não chame brain_commit.`
        : "Aguardando revisão humana na Review Queue (a menos que a política permita brain_commit)." };
  }));

  server.registerTool("brain_commit", {
    title: "Persistir decisão",
    description: "Persiste uma proposta com a resolução escolhida. Negado por padrão: a política é aplicada no Core para qualquer adapter (o Core reclassifica a proposta antes de autorizar. Sob a política additive, o agente só decide as próprias propostas aditivas (new, complement, duplicate); atualização, substituição, conflito e manutenção sempre exigem humano). Em vault com additive o brain_propose já grava direto, então brain_commit não é necessário.",
    inputSchema: z.object({ proposal_id: z.string(), resolution: z.enum(RESOLUTIONS), target_id: z.string().optional(), final_body: z.string().optional(), note: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guard(async (a) => {
    const r = await brain.resolve(a.proposal_id, { resolution: a.resolution, target_id: a.target_id, final_body: a.final_body, note: a.note }, actor());
    return { id: r.note?.id, commit: r.commit, state: r.proposal.state };
  }));

  server.registerTool("brain_link", {
    title: "Relacionar conhecimentos",
    description: "Adiciona relação tipada entre duas notas existentes (aditivo; não altera conteúdo).",
    inputSchema: z.object({ from: z.string(), to: z.string(), type: z.enum(RELATION_TYPES) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async (a) => { const n = await brain.link(a.from, a.to, a.type, actor()); return { id: n.id, relations: n.relations }; }));

  server.registerTool("brain_amend", {
    title: "Corrigir a própria proposta",
    description: "Corrige uma proposta PENDENTE criada por este mesmo agente (título mais específico, texto mais seguro, metadados temporais) antes da revisão humana. Não aprova nada; propostas de outros agentes/humanos não podem ser alteradas.",
    inputSchema: z.object({
      proposal_id: z.string(), title: z.string().min(3).max(200).optional(), body: z.string().min(10).optional(), tags: z.array(z.string()).optional(),
      temporal: Draft.temporal, clear_temporal: z.boolean().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async (a) => {
    const p = await brain.editProposal(a.proposal_id, { title: a.title, body: a.body, tags: a.tags, temporal: a.temporal, clear_temporal: a.clear_temporal }, actor());
    return { proposal_id: p.id, state: p.state, title: p.draft.title, temporal: p.draft.temporal, classification: p.analysis.classification, next: "Aguardando revisão humana." };
  }));

  server.registerTool("brain_supersede", {
    title: "Substituir conhecimento",
    description: "Propõe que uma nota seja substituída por novo conteúdo. O antigo é preservado (status superseded + superseded_by). Vai para revisão.",
    inputSchema: z.object({ old_id: z.string(), ...Draft, reason: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async (a) => {
    const { old_id, reason, ...draft } = a;
    const p = await brain.supersede({ old_id, draft, reason }, actor());
    return { proposal_id: p.id, classification: p.analysis.classification, warnings: p.analysis.warnings, next: "Aguardando revisão humana." };
  }));

  server.registerTool("brain_health", {
    title: "Saúde da base", description: "Status de Git, índice SQLite, embeddings, busca e problemas da base.", inputSchema: z.object({}), annotations: RO,
  }, guard(async () => { const h = await brain.health(); return { ...h, details: undefined, problems: h.problems }; }));

  if (opts.modulos) registrarFerramentasDeModulos(server, brain, opts.modulos, new Set<string>(BRAIN_TOOLS), (m) => console.error(m));
  return server;
}

/** Entrada stdio: stdout é exclusivo do protocolo; logs vão para stderr. */
export async function runStdio(vaultRoot: string, agentOverride?: string): Promise<void> {
  const brain = await Brain.open(vaultRoot);
  // só as definições (sem `iniciar`): a execução é no serve. Sem módulos na config, nada muda (nem a pasta de estado é criada)
  let modulos: ModuleRegistry | undefined;
  if (Object.keys(brain.config.modules).length && moduleToolsEnabledFromEnv()) {
    try { modulos = await loadModules(brain, { modo: "definicoes" }); }
    catch (e) { console.error(`[brain] módulos não carregados no MCP: ${(e as Error)?.message ?? String(e)}`); }
  }
  const server = createServer(brain, { agentOverride, modulos });
  await server.connect(new StdioServerTransport());
  const shutdown = () => { brain.close(); process.exit(0); };
  process.stdin.on("end", shutdown); process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}
