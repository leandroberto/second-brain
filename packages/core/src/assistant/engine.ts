import type { CaptureEntry } from "./captures.js";

/**
 * Motor de assistente (spec §7.4): organiza uma captura em notas e responde perguntas com base nas notas. A implementação
 * `claude` roda `claude -p` só com as ferramentas `brain_*` do MCP do próprio second-brain; um motor futuro (ex.: copilot)
 * implementa a mesma interface.
 */
export type AssistantErrorKind = "auth" | "timeout" | "orcamento" | "erro";
/** `custoUsd`: custo informado pelo claude mesmo na falha (só o motor preenche; os modos atuais o ignoram). */
export type AssistantError = { ok: false; tipo: AssistantErrorKind; mensagem: string; custoUsd?: number };

export type CaptureAction = "criada" | "complementada" | "na_fila" | "ignorada";
export const CAPTURE_ACTIONS: readonly CaptureAction[] = ["criada", "complementada", "na_fila", "ignorada"];

export type CaptureResult =
  | { ok: true; notas: Array<{ id: string; acao: CaptureAction }>; segredo_omitido: boolean; texto_mascarado: string | null }
  | AssistantError;

export type AskResult = { ok: true; resposta: string; fontes: string[] } | AssistantError;

/** Chamada genérica (módulos): o prompt vai inteiro pela entrada padrão; sem `schemaJson`, `dados` é o texto da resposta. */
export interface CompleteParams {
  /** identidade do chamador (ex.: `module/<id>`); vai em `BRAIN_AGENT_NAME` quando `comNotas` */
  agente: string;
  prompt: string;
  schemaJson?: object;
  modelo?: string;
  orcamentoUsd: number;
  timeoutS: number;
  /** libera as ferramentas de leitura do MCP do vault (as mesmas do `ask`); sem isso, nenhuma ferramenta */
  comNotas: boolean;
}
export type CompleteResult = { ok: true; dados: unknown; custoUsd?: number } | AssistantError;

export interface AssistantEngine {
  capture(entry: CaptureEntry): Promise<CaptureResult>;
  ask(q: string, conversationId?: string): Promise<AskResult>;
  complete(p: CompleteParams): Promise<CompleteResult>;
}

/** Resposta padrão quando nada nas notas sustenta a resposta. */
export const NOT_NOTED = "Não está anotado.";

/** Contratos de saída do `claude -p --json-schema`. */
export const CAPTURE_SCHEMA = {
  type: "object",
  properties: {
    notas: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, acao: { type: "string", enum: [...CAPTURE_ACTIONS] } },
        required: ["id", "acao"],
        additionalProperties: false,
      },
    },
    segredo_omitido: { type: "boolean" },
    texto_mascarado: { type: ["string", "null"] },
  },
  required: ["notas", "segredo_omitido", "texto_mascarado"],
  additionalProperties: false,
} as const;

export const ASK_SCHEMA = {
  type: "object",
  properties: {
    resposta: { type: "string" },
    fontes: { type: "array", items: { type: "string" } },
  },
  required: ["resposta", "fontes"],
  additionalProperties: false,
} as const;
