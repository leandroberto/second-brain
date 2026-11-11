import { z } from "zod";

export const NOTE_TYPES = [
  "decision", "learning", "fact", "preference", "pattern",
  "reference", "project", "concept", "open-question",
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const STATUSES = ["proposed", "active", "deprecated", "superseded", "archived"] as const;
export type NoteStatus = (typeof STATUSES)[number];

export const RELATION_TYPES = [
  "related_to", "depends_on", "supersedes", "superseded_by",
  "derived_from", "applies_to", "contradicts", "implements", "references",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export const CONFIDENCE = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

/** Decisões humanas possíveis na Review Queue. */
export const RESOLUTIONS = ["create", "complement", "update", "replace", "keep_separate", "ignore"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** Classificação sugerida pelo motor de governança. */
export const CLASSIFICATIONS = ["new", "duplicate", "complement", "update", "replace", "conflict"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/;
export const isValidId = (s: string): boolean => ID_PATTERN.test(s);

/** Converte texto livre em slug ASCII estável (sem acentos). */
export function slugify(input: string, max = 80): string {
  const s = input
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/g, "");
}

export const ActorSchema = z.object({
  kind: z.enum(["human", "agent", "system"]),
  name: z.string().min(1).max(80),
});
export type Actor = z.infer<typeof ActorSchema>;

/**
 * Canal pelo qual a ação chegou ao Core. A IDENTIDADE confiável é ator + canal, e quem a define é o adapter (MCP, API, CLI),
 * nunca o cliente: um corpo HTTP com {kind:"human"} não vira humano. Só `ui` (sessão humana) e `cli-admin` (terminal interativo
 * com confirmação) são canais humanos de revisão. `desktop` é o humano do atalho desktop (sessão com escopo restrito): anota,
 * pergunta, reprocessa e desfaz as próprias capturas, mas não revisa.
 */
export const CHANNELS = ["ui", "cli-admin", "cli", "mcp", "api", "importer", "maintenance", "seed", "internal", "desktop"] as const;
export type Channel = (typeof CHANNELS)[number];
export interface Principal extends Actor { readonly channel: Channel }

/** Conhecimento TEMPORAL: verdade numa data, que pode deixar de ser verdade (por um evento, não por idade). */
export const TemporalSchema = z.object({
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** evento que obriga a revalidar (ex.: "status de produção do GeoLedger mudar") */
  revalidate_when: z.string().min(3).max(200).optional(),
});
export type Temporal = z.infer<typeof TemporalSchema>;

/**
 * Semântica da ORIGEM (não confundir com `Source.type`, que diz o meio): uma ADR registra intenção; um plano, trabalho
 * pretendido (NÃO prova de implementação); README/docs descrevem e envelhecem; código/testes mostram o estado atual.
 */
export const SOURCE_KINDS = ["adr", "spec", "plan", "docs", "readme", "agents", "changelog", "issue", "commit", "code", "test", "conversation", "other"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SourceSchema = z.object({
  type: z.enum(["git", "pr", "issue", "doc", "conversation", "manual", "other"]),
  repository: z.string().max(200).optional(),
  ref: z.string().max(300).optional(), // branch/commit/PR/URL/path:linha
  url: z.string().max(500).optional(),
  kind: z.enum(SOURCE_KINDS).optional(),
});
export type Source = z.infer<typeof SourceSchema>;

/**
 * Atualidade (freshness): "esta afirmação ainda representa o estado atual?" — independente da confiança de EXTRAÇÃO
 * ("entendemos o que a fonte diz?"). `implemented` não é um estado à parte: é `current` vindo de plano/spec.
 */
export const FRESHNESS_STATES = ["current", "planned", "historical", "superseded", "reverted", "uncertain", "conflict"] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

/** O que fica gravado na nota aprovada: o mínimo para a recuperação saber se é atual. A evidência completa fica na proposta decidida. */
export const VerificationSchema = z.object({
  state: z.enum(FRESHNESS_STATES),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  against: z.string().max(120).optional(), // repo@commit verificado
  checked_at: z.string().max(40).optional(),
});
export type Verification = z.infer<typeof VerificationSchema>;

export interface FreshnessEvidence {
  /** de onde veio a evidência */
  kind: "code" | "test" | "config" | "doc" | "adr" | "git" | "plan" | "vault";
  stance: "supports" | "contradicts" | "context";
  /** arquivo:linha, commit, ADR — rastreável */
  ref: string;
  detail: string;
}

export interface Freshness {
  state: FreshnessState;
  confidence: Confidence;
  /** WHY: a decisão/intenção registrada ainda vale? (n/a para descrições) */
  intent: "in_force" | "superseded" | "reverted" | "unknown" | "n/a";
  /** WHAT IS TRUE NOW: o que o HEAD mostra sobre a afirmação */
  implementation: "confirmed" | "partial" | "absent" | "diverges" | "unknown";
  source: { kind: SourceKind; path?: string; commit?: string; date?: string; in_head: boolean };
  against?: { repo: string; commit: string; date?: string };
  evidence: FreshnessEvidence[];
  /** conclusão em uma frase, sempre derivada das evidências */
  summary: string;
  /** accept_current: criar como atual · accept_historical: guardar como histórico (fora do contexto padrão) · complement_current: anexar como
   *  histórico a uma nota atual · confirm: não verificável, nada contradiz — o humano confirma se ainda vale · investigate: evidência
   *  conflitante/insuficiente · ignore: plano sem implementação ou documentação desatualizada */
  suggestion: "accept_current" | "accept_historical" | "complement_current" | "confirm" | "investigate" | "ignore" | "revalidate";
  /** origem da afirmação: muda a estratégia (documento importado é refutável por documento posterior; síntese de agente/humano só por
   *  proposição incompatível, código/config atual ou ADR posterior explícita) */
  origin?: "imported" | "agent" | "human";
  /** nota da base que a sugestão "complementar" usaria */
  suggestion_target?: string;
  /** métrica de UX/governança (NUNCA usada para auto-aprovar) */
  effort: "auto_clear" | "quick" | "investigate";
  checked_at: string;
  /** veredito anterior quando o rascunho foi editado depois da verificação (preserva a proteção de conhecimento histórico) */
  stale_from?: FreshnessState;
}

export const FrontmatterSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  title: z.string().min(1).max(200),
  type: z.enum(NOTE_TYPES),
  status: z.enum(STATUSES).default("active"),
  project: z.string().regex(ID_PATTERN).optional(),
  tags: z.array(z.string().min(1).max(60)).default([]),
  created_at: z.string(),
  updated_at: z.string(),
  source: SourceSchema.optional(),
  created_by: ActorSchema.optional(),
  confidence: z.enum(CONFIDENCE).optional(),
  /** atualidade verificada contra o repositório (só notas vindas de importação reconciliada) */
  verification: VerificationSchema.optional(),
  /** conhecimento temporal (válido em `as_of`; revalidar quando `revalidate_when` acontecer) */
  temporal: TemporalSchema.optional(),
  /** relation type -> lista de ids alvo (gravados como "[[id]]" para o Obsidian). */
  relations: z.partialRecord(z.enum(RELATION_TYPES), z.array(z.string())).default({}),
});
export type Frontmatter = z.infer<typeof FrontmatterSchema>;

export interface Note extends Frontmatter {
  body: string;
  /** caminho relativo à raiz do vault */
  path: string;
  /** hash do arquivo (12 hex) — token de concorrência otimista */
  revision: string;
  extra?: Record<string, unknown>;
}

export interface SearchHit {
  id: string; title: string; type: NoteType; status: NoteStatus; project?: string;
  tags: string[]; snippet: string; score: number; updated_at: string;
  match: { text?: number; semantic?: number };
  /** presente só quando a nota NÃO é verificada como atual (planned/uncertain/conflict/historical…) */
  freshness?: FreshnessState;
}

export interface SimilarMatch {
  id: string; title: string; type: NoteType; status: NoteStatus; project?: string;
  similarity: number; reasons: string[]; revision: string; updated_at: string;
}

export interface Analysis {
  classification: Classification;
  confidence: "low" | "medium" | "high";
  suggested_resolution: Resolution;
  target_id?: string;
  matches: SimilarMatch[];
  warnings: string[];
}

export type ProposalState = "pending" | "accepted" | "ignored" | "stale";

export interface Proposal {
  id: string;
  state: ProposalState;
  created_at: string;
  proposed_by: Actor;
  reason?: string;
  /** conteúdo proposto para a nota (nova ou para complementar/atualizar) */
  draft: {
    title: string; type: NoteType; project?: string; tags: string[]; body: string;
    confidence?: Confidence; source?: Source; temporal?: Temporal;
  };
  /** dica do agente: o que ele acredita ser */
  intent?: "new" | "complement" | "update" | "replace";
  analysis: Analysis;
  /** origem de importação (Import Assistant): regra que gerou o candidato e evidência */
  import?: { run: string; rule: string; evidence: string; source_path: string; why?: string[]; parent?: string; flags?: string[] };
  /** reconciliação com o estado atual do repositório de origem (Import Assistant) */
  freshness?: Freshness;
  /** proposta de MANUTENÇÃO gerada pelo sistema sobre uma nota existente (revalidar conhecimento temporal, melhorar título) */
  maintenance?: { kind: "revalidate" | "title"; reason: string; evidence?: string[] };
  /** edição do rascunho pelo revisor antes de decidir */
  edited?: { at: string; by: Actor };
  /** alvo explícito quando o agente pede supersede/update */
  target_id?: string;
  target_revision?: string;
  decided?: { at: string; by: Actor; resolution: Resolution; target_id?: string; result_id?: string; commit?: string; note?: string };
}

/** O que a política `additive` (ADR 0014) gravou dentro do próprio propose: nota criada, alvo complementado ou duplicata ignorada. */
export interface ProposeAuto { resolution: "create" | "complement" | "ignore"; note_id?: string; commit?: string }
/** Retorno do propose: a proposta (pendente, ou já decidida quando `auto` está presente). */
export type ProposeResult = Proposal & { auto?: ProposeAuto };

export interface ActivityEntry {
  id: number; ts: string; actor_kind: Actor["kind"]; actor_name: string;
  action: string; target_id: string | null; detail: Record<string, unknown>;
}

export class BrainError extends Error {
  constructor(public code: BrainErrorCode, message: string, public details?: unknown) {
    super(message);
    this.name = "BrainError";
  }
}
export type BrainErrorCode =
  | "not_found" | "invalid" | "secret_detected" | "conflict_revision" | "forbidden"
  | "duplicate_id" | "locked" | "git_error" | "path_escape" | "policy" | "too_large" | "state_unavailable";

export const todayISO = (d = new Date()): string => d.toISOString();
