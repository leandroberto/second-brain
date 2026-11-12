import { z } from "zod";
import { parse, stringify } from "yaml";
import { existsSync, readFileSync } from "node:fs";

export const ConfigSchema = z.object({
  vault_name: z.string().default("Second Brain"),
  embeddings: z.object({
    provider: z.enum(["hash", "openai-compatible"]).default("hash"),
    /** envio de texto a servidor externo exige opt-in explícito */
    external_opt_in: z.boolean().default(false),
    base_url: z.string().default("https://api.openai.com/v1"),
    model: z.string().default("text-embedding-3-small"),
    dimensions: z.number().int().positive().default(1536),
    api_key_env: z.string().default("OPENAI_API_KEY"),
  }).default({ provider: "hash", external_opt_in: false, base_url: "https://api.openai.com/v1", model: "text-embedding-3-small", dimensions: 1536, api_key_env: "OPENAI_API_KEY" }),
  governance: z.object({
    duplicate_threshold: z.number().default(0.78),
    candidate_threshold: z.number().default(0.42),
    stale_days: z.number().int().default(180),
    /** Update aprovado move a linha antiga para "## Histórico" em vez de apagá-la (vault "nunca apague nada"). */
    keep_history_section: z.boolean().default(false),
  }).default({ duplicate_threshold: 0.78, candidate_threshold: 0.42, stale_days: 180, keep_history_section: false }),
  agents: z.object({
    /** never | new_only (somente classificação "new") | additive (new/complement/duplicate gravados no próprio propose,
     *  ADR 0014) | all */
    commit_policy: z.enum(["never", "new_only", "additive", "all"]).default("never"),
    can_link: z.boolean().default(true),
    /** Por tipo de conhecimento: "review" (padrão) ou "auto". "auto" só vale se commit_policy também permitir.
     *  Sob `additive`, um tipo sem entrada vale "auto"; "review" explícito continua mandando para a fila. */
    per_type: z.partialRecord(z.enum(["decision", "learning", "fact", "preference", "pattern", "reference", "project", "concept", "open-question"]), z.enum(["review", "auto"])).default({}),
  }).default({ commit_policy: "never", can_link: true, per_type: {} }),
  git: z.object({
    auto_commit: z.boolean().default(true),
    /** commita edições manuais (Obsidian) automaticamente após o watcher detectar */
    auto_commit_external: z.boolean().default(false),
  }).default({ auto_commit: true, auto_commit_external: false }),
  limits: z.object({
    max_chars: z.number().int().default(8000),
    max_code_lines: z.number().int().default(40),
  }).default({ max_chars: 8000, max_code_lines: 40 }),
  retention: z.object({ activity_days: z.number().int().default(365) }).default({ activity_days: 365 }),
  /** revisão humana: com `passphrase_required`, a prova de humano no terminal EXIGE a frase-senha do revisor — se o arquivo dela
   *  sumir (ou o processo apontar outro HOME/armazenamento), a ação é NEGADA em vez de cair para "só TTY" */
  review: z.object({ passphrase_required: z.boolean().default(false) }).default({ passphrase_required: false }),
  /** `external`: SQLite, lock, fila pendente, api-token e git-dir ficam fora do vault (ver state.ts) */
  state: z.object({ external: z.boolean().default(false) }).default({ external: false }),
  /** motor de assistente (captura e pergunta, spec §7.4): `claude -p` só com as ferramentas brain_* do MCP do vault */
  assistant: z.object({
    engine: z.enum(["claude"]).default("claude"),
    model: z.string().default("sonnet"),
    max_budget_usd: z.number().default(0.5),
    timeout_s: z.number().int().default(120),
    claude_path: z.string().default("claude"),
  }).default({ engine: "claude", model: "sonnet", max_budget_usd: 0.5, timeout_s: 120, claude_path: "claude" }),
  /** módulos de outros repositórios, por id (spec de módulos): só entram aqui; o SB nunca importa um módulo pelo nome */
  modules: z.record(z.string(), z.object({
    enabled: z.boolean().default(true),
    path: z.string().optional(),
    host: z.string().optional(),
    ia_max_usd_dia: z.number().default(2),
    config: z.unknown().optional(),
  }).passthrough()).default({}),
});
export type BrainConfig = z.infer<typeof ConfigSchema>;
/** Entrada de um módulo em `config.modules[id]`. */
export type ModuleEntry = BrainConfig["modules"][string];

export function loadConfig(path: string): BrainConfig {
  const raw = existsSync(path) ? parse(readFileSync(path, "utf8")) ?? {} : {};
  return ConfigSchema.parse(raw);
}
export const dumpConfig = (c: BrainConfig): string => stringify(c, { lineWidth: 0 });
