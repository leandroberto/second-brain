import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidId } from "@brain/shared";
import type { Brain } from "../brain.js";
import { CAPTURE_ID, type CaptureEntry } from "./captures.js";
import {
  ASK_SCHEMA, CAPTURE_ACTIONS, CAPTURE_SCHEMA, NOT_NOTED,
  type AskResult, type AssistantEngine, type AssistantError, type CaptureAction, type CaptureResult,
} from "./engine.js";

/**
 * Motor `claude` (spec §7.4), portado do `claude.ts` do app antigo: `claude -p` confinado às ferramentas `brain_*` do MCP do
 * próprio vault. Nenhuma ferramenta embutida (`--tools ""`), nenhum outro MCP (`--strict-mcp-config`); toda escrita passa
 * pelo `brain_propose`, ou seja, pela governança do core. O texto do usuário vai só por stdin.
 */

export interface SaidaProcesso { codigo: number | null; stdout: string; stderr: string; estourouTempo: boolean }

export type ExecutorClaude = (
  exe: string,
  args: string[],
  opcoes: { cwd: string; entrada: string; timeoutMs: number },
) => Promise<SaidaProcesso>;

export type ResultadoClaude<T> = { ok: true; dados: T } | AssistantError;

/** Como iniciar `brain mcp`: o adapter (serve) informa, o core não depende do pacote cli. */
export interface McpCommand { command: string; args: string[] }

export type AssistantMode = "capture" | "ask";

/** Prompts padrão; o vault sobrescreve com `<vault>/.brain/assistant/{capture,ask}.md`. */
export const ASSISTANT_TEMPLATES_DIR = fileURLToPath(new URL("../../../../templates/assistant/", import.meta.url));

/**
 * Todas as ferramentas que o MCP do second-brain registra (o teste do pacote mcp compara com `listTools`). O que um modo não
 * libera vai para `--disallowedTools`: negação vence pré-aprovação, então a restrição não depende de "não aprovado = negado".
 * Ferramenta nova no MCP fica negada até alguém liberá-la aqui.
 */
export const BRAIN_TOOLS = [
  "brain_search", "brain_context", "brain_get", "brain_recent", "brain_projects", "brain_similar",
  "brain_propose", "brain_commit", "brain_link", "brain_amend", "brain_supersede", "brain_health",
] as const;
type BrainTool = (typeof BRAIN_TOOLS)[number];
const mcpName = (t: BrainTool) => `mcp__second-brain__${t}`;
export const CAPTURE_TOOLS: readonly string[] = (["brain_search", "brain_similar", "brain_get", "brain_context", "brain_propose", "brain_link"] as const).map(mcpName);
export const ASK_TOOLS: readonly string[] = (["brain_search", "brain_get", "brain_context"] as const).map(mcpName);
const complement = (allowed: readonly string[]) => BRAIN_TOOLS.map(mcpName).filter((t) => !allowed.includes(t));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mensagens do claude para `--session-id` já usado e `--resume` de sessão que não existe (heurística por texto). */
const SESSAO_EM_USO = /already in use/i;
const SESSAO_INEXISTENTE = /no conversation found|session[^\n]*not found/i;

/** Diretório de trabalho estável das chamadas: no estado externo, ou em `.brain/` (ignorado pelo git, fora do indexer). */
export const assistantCwd = (brain: Brain): string => join(brain.vault.stateDir ?? join(brain.vault.root, ".brain"), "assistant-cwd");

export function montarArgs(o: {
  mode: AssistantMode; model: string; maxBudgetUsd: number; promptFile: string; mcpConfig: string;
  session?: { id: string; nova: boolean };
}): string[] {
  const args = [
    "-p",
    "--restricted",
    "--permission-prompts", "none",
    "--max-budget-usd", String(o.maxBudgetUsd),
    "--model", o.model,
    "--output-format", "json",
    "--append-system-prompt-file", o.promptFile,
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", o.mcpConfig,
    "--allowedTools", (o.mode === "capture" ? CAPTURE_TOOLS : ASK_TOOLS).join(","),
    "--disallowedTools", complement(o.mode === "capture" ? CAPTURE_TOOLS : ASK_TOOLS).join(","),
    "--json-schema", JSON.stringify(o.mode === "capture" ? CAPTURE_SCHEMA : ASK_SCHEMA),
  ];
  if (o.mode === "capture" || !o.session) args.push("--no-session-persistence");
  else args.push(o.session.nova ? "--session-id" : "--resume", o.session.id);
  return args;
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function montarPrompt(mode: AssistantMode, texto: string, hoje: Date = new Date()): string {
  return mode === "capture"
    ? `MODO: CAPTURA\nDATA: ${isoDay(hoje)}\nTEXTO:\n${texto}`
    : `MODO: PERGUNTA\nDATA: ${isoDay(hoje)}\nPERGUNTA:\n${texto}`;
}

export const executarProcesso: ExecutorClaude = (exe, args, { cwd, entrada, timeoutMs }) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let estourouTempo = false;
    let terminou = false;
    const fim = (codigo: number | null) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(relogio);
      resolve({ codigo, stdout, stderr, estourouTempo });
    };

    const filho = spawn(exe, args, { cwd, shell: false, windowsHide: true });
    filho.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    filho.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    filho.on("error", (e) => { stderr += e.message; fim(null); });
    filho.on("close", (codigo) => fim(codigo));
    filho.stdin.on("error", () => {}); // processo morreu antes de ler: o 'close' resolve
    filho.stdin.end(entrada, "utf8");

    const relogio = setTimeout(() => {
      estourouTempo = true;
      if (process.platform === "win32" && filho.pid) spawn("taskkill", ["/pid", String(filho.pid), "/T", "/F"], { windowsHide: true });
      else filho.kill("SIGKILL");
    }, timeoutMs);
  });

const PARECE_AUTH = /log ?in|auth|401|expired|token/i;
/** Texto do estouro de `--max-budget-usd` (o sinal principal é o subtype `error_max_budget_usd`). */
const PARECE_ORCAMENTO = /budget|orçamento/i;

/**
 * Traduz a saída do `claude -p --output-format json`. Orçamento é verificado ANTES de auth: a mensagem de estouro pode
 * citar "tokens". Só os campos de resultado são examinados (nunca o JSON inteiro, que sempre traz estatísticas como
 * `subagent_stats.refused.budget`).
 */
export function interpretarSaida<T>(s: SaidaProcesso): ResultadoClaude<T> {
  if (s.estourouTempo) return { ok: false, tipo: "timeout", mensagem: "O Claude demorou demais para responder." };

  let obj: { is_error?: boolean; subtype?: string; result?: string; errors?: unknown; terminal_reason?: string; structured_output?: T };
  try {
    obj = JSON.parse(s.stdout) as typeof obj;
    if (!obj || typeof obj !== "object") throw new Error("não é objeto");
  } catch {
    const detalhe = (s.stderr || s.stdout).trim() || `saída ${s.codigo}`;
    return { ok: false, tipo: PARECE_ORCAMENTO.test(detalhe) ? "orcamento" : "erro", mensagem: detalhe };
  }

  const errors = Array.isArray(obj.errors) ? obj.errors.filter((e): e is string => typeof e === "string").join("; ") : "";
  if (obj.subtype === "error_max_budget_usd" || PARECE_ORCAMENTO.test(obj.terminal_reason ?? "")) {
    return { ok: false, tipo: "orcamento", mensagem: `O limite de gasto da chamada (assistant.max_budget_usd) estourou.${errors ? ` ${errors}` : ""}` };
  }
  if (obj.is_error || s.codigo !== 0 || (obj.subtype && obj.subtype !== "success")) {
    const mensagem = (obj.result || errors || s.stderr || `saída ${s.codigo}`).trim();
    const tipo = PARECE_ORCAMENTO.test(mensagem) ? "orcamento" : PARECE_AUTH.test(mensagem) || PARECE_AUTH.test(s.stderr) ? "auth" : "erro";
    return { ok: false, tipo, mensagem };
  }
  if (obj.structured_output === undefined || obj.structured_output === null) {
    return { ok: false, tipo: "erro", mensagem: "O Claude respondeu sem o formato esperado." };
  }
  return { ok: true, dados: obj.structured_output };
}

const SEM_FORMATO: AssistantError = { ok: false, tipo: "erro", mensagem: "O Claude respondeu sem o formato esperado." };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function normalizeCapture(d: unknown): CaptureResult {
  if (!isObj(d) || !Array.isArray(d.notas) || typeof d.segredo_omitido !== "boolean" || !(d.texto_mascarado === null || typeof d.texto_mascarado === "string")) return SEM_FORMATO;
  const notas: Array<{ id: string; acao: CaptureAction }> = [];
  for (const n of d.notas) {
    if (!isObj(n) || typeof n.id !== "string" || !CAPTURE_ACTIONS.includes(n.acao as CaptureAction)) return SEM_FORMATO;
    // id fora do formato do core (nota ou proposta) não é registrado: o registro de capturas não aceita texto livre
    if (isValidId(n.id) && !notas.some((x) => x.id === n.id && x.acao === n.acao)) notas.push({ id: n.id, acao: n.acao as CaptureAction });
  }
  return { ok: true, notas, segredo_omitido: d.segredo_omitido, texto_mascarado: d.segredo_omitido ? d.texto_mascarado : null };
}

/**
 * `createClaudeEngine(brain, exec, mcpCommand)`: `exec` é trocado nos testes (nunca se chama o `claude` real); `mcpCommand`
 * inicia `brain mcp` (ex.: `{ command: process.execPath, args: [<bin.js do cli>, "mcp"] }`).
 */
export function createClaudeEngine(brain: Brain, exec: ExecutorClaude = executarProcesso, mcpCommand: McpCommand): AssistantEngine {
  /** conversa (id do cliente) → sessão do claude (o id muda se a sessão sumiu); `iniciada`: as próximas usam --resume */
  const sessoes = new Map<string, { id: string; iniciada: boolean }>();

  const promptFile = (mode: AssistantMode): string => {
    const own = join(brain.vault.root, ".brain", "assistant", `${mode}.md`);
    return existsSync(own) ? own : join(ASSISTANT_TEMPLATES_DIR, `${mode}.md`);
  };

  /** Escreve o `--mcp-config` temporário (o MCP do vault com a identidade do agente), roda e apaga. */
  async function run(mode: AssistantMode, agent: string, texto: string, session?: { id: string; nova: boolean }): Promise<ResultadoClaude<unknown>> {
    const cfg = brain.config.assistant;
    const prompt = promptFile(mode);
    if (!existsSync(prompt)) return { ok: false, tipo: "erro", mensagem: `prompt do assistente não encontrado: ${prompt}` };
    const dir = mkdtempSync(join(tmpdir(), "brain-assistant-"));
    try {
      const env: Record<string, string> = { BRAIN_VAULT: brain.vault.root, BRAIN_AGENT_NAME: agent };
      if (process.env.BRAIN_STATE_DIR) env.BRAIN_STATE_DIR = process.env.BRAIN_STATE_DIR;
      const mcpConfig = join(dir, "mcp.json");
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { "second-brain": { type: "stdio", command: mcpCommand.command, args: mcpCommand.args, env } } }), { mode: 0o600 });
      const args = montarArgs({ mode, model: cfg.model, maxBudgetUsd: cfg.max_budget_usd, promptFile: prompt, mcpConfig, session });
      // cwd ESTÁVEL e vazio: o claude guarda as sessões por diretório de projeto (o --resume precisa do mesmo cwd) e nenhum
      // CLAUDE.md ou settings de projeto entra na chamada. Fica no estado (externo) ou em .brain/, ignorado pelo git.
      const cwd = assistantCwd(brain);
      mkdirSync(cwd, { recursive: true });
      const saida = await exec(cfg.claude_path, args, { cwd, entrada: montarPrompt(mode, texto), timeoutMs: cfg.timeout_s * 1000 });
      return interpretarSaida<unknown>(saida);
    } catch (e) {
      return { ok: false, tipo: "erro", mensagem: (e as Error)?.message || String(e) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    async capture(entry: CaptureEntry): Promise<CaptureResult> {
      if (!CAPTURE_ID.test(entry.id)) return { ok: false, tipo: "erro", mensagem: `id de captura inválido: ${entry.id}` };
      const r = await run("capture", `assistant/${entry.id}`, entry.text);
      return r.ok ? normalizeCapture(r.dados) : r;
    },

    async ask(q: string, conversationId?: string): Promise<AskResult> {
      if (typeof q !== "string" || !q.trim()) return { ok: false, tipo: "erro", mensagem: "pergunta vazia" };
      if (conversationId !== undefined && !UUID.test(conversationId)) return { ok: false, tipo: "erro", mensagem: "conversationId inválido (use um UUID)" };
      let s = conversationId ? (sessoes.get(conversationId) ?? { id: conversationId, iniciada: false }) : undefined;
      const tentar = () => run("ask", "assistant/ask", q, s && { id: s.id, nova: !s.iniciada });
      let r = await tentar();
      if (s) {
        // a sessão já existe no claude (restart do serve, ou falha depois de criá-la): retoma o mesmo id
        if (!r.ok && !s.iniciada && SESSAO_EM_USO.test(r.mensagem)) { s = { id: s.id, iniciada: true }; r = await tentar(); }
        // a sessão sumiu (apagada, outro cwd): a conversa continua com uma sessão nova
        if (!r.ok && s.iniciada && SESSAO_INEXISTENTE.test(r.mensagem)) { s = { id: randomUUID(), iniciada: false }; r = await tentar(); }
      }
      if (!r.ok) return r;
      const d = r.dados;
      if (!isObj(d) || typeof d.resposta !== "string" || !Array.isArray(d.fontes)) return SEM_FORMATO;
      if (conversationId && s) sessoes.set(conversationId, { id: s.id, iniciada: true });
      // resposta sem fonte que exista no vault vira "Não está anotado.": o anti-objetivo de resposta inventada é do código
      await brain.sync({ maxAgeMs: 1000 });
      const fontes = [...new Set(d.fontes.filter((f): f is string => typeof f === "string" && isValidId(f) && !!brain.db.getRow(f)))];
      if (!fontes.length) return { ok: true, resposta: NOT_NOTED, fontes: [] };
      return { ok: true, resposta: d.resposta, fontes };
    },
  };
}
