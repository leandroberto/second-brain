import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { Brain, principal } from "@brain/core";
import { BrainError, NOTE_TYPES, RELATION_TYPES, RESOLUTIONS, type Principal } from "@brain/shared";

const VERSION = "0.1.0";

export const INSTRUCTIONS = `Second Brain: base de conhecimento compartilhada (Markdown+Git), neutra de fornecedor.
Antes de trabalho substancial: brain_context (projeto/tópico/tarefa) e, se preciso, brain_search + brain_get. Recupere só o relevante.
Ao descobrir conhecimento DURÁVEL (decisão, preferência, aprendizado, regra, fato de projeto): brain_similar e depois brain_propose. Nunca sobrescreva em silêncio; propostas vão para revisão humana.
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

/** Cria o servidor MCP. `brain` é compartilhado com nenhum outro processo: cada cliente (Claude, Codex) tem o seu, coordenados por lock de arquivo. */
export function createServer(brain: Brain, opts: { agentOverride?: string } = {}): McpServer {
  const server = new McpServer({ name: "second-brain", version: VERSION }, { instructions: INSTRUCTIONS });
  // a identidade é do ADAPTER: todo cliente MCP é um agente (canal mcp); nenhum argumento de ferramenta muda isso
  const actor = (): Principal => {
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
    description: "Propõe conhecimento durável. NÃO persiste: cria uma proposta classificada (new/duplicate/complement/update/replace/conflict) que entra na Review Queue. Segredos e dumps são rejeitados.",
    inputSchema: z.object({
      ...Draft,
      reason: z.string().optional().describe("Por que isto é durável e útil"),
      intent: z.enum(["new", "complement", "update", "replace"]).optional(),
      target_id: z.string().optional().describe("id existente que esta proposta complementa/atualiza/substitui"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async (a) => {
    const p = await brain.propose(a, actor());
    return { proposal_id: p.id, state: p.state, classification: p.analysis.classification, suggested_resolution: p.analysis.suggested_resolution, target_id: p.analysis.target_id, similar: p.analysis.matches.slice(0, 3).map((m) => ({ id: m.id, title: m.title, similarity: m.similarity })), warnings: p.analysis.warnings, next: "Aguardando revisão humana na Review Queue (a menos que a política permita brain_commit)." };
  }));

  server.registerTool("brain_commit", {
    title: "Persistir decisão",
    description: "Persiste uma proposta com a resolução escolhida. Negado por padrão: a política é aplicada no Core para qualquer adapter (agentes só criam conhecimento \"new\" de tipos liberados explicitamente no vault; atualização, substituição, conflito e manutenção sempre exigem humano).",
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

  return server;
}

/** Entrada stdio: stdout é exclusivo do protocolo; logs vão para stderr. */
export async function runStdio(vaultRoot: string, agentOverride?: string): Promise<void> {
  const brain = await Brain.open(vaultRoot);
  const server = createServer(brain, { agentOverride });
  await server.connect(new StdioServerTransport());
  const shutdown = () => { brain.close(); process.exit(0); };
  process.stdin.on("end", shutdown); process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}
