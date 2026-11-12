/**
 * SDK de módulos do Second Brain: só tipos e `defineModule`. Não importa `@brain/core` nem `@brain/shared` (um módulo, de outro
 * repositório, depende apenas deste pacote). O `zod` (v4) é peer: o SB valida schemas pela interface Standard Schema, nunca por
 * `instanceof`.
 */

/** Versão do contrato do SDK que o core entende; `ModuleDef.sdk` precisa ser igual. */
export const SDK_VERSION = 1;

export type StdResult<T> =
  | { value: T }
  | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> };

/** Subconjunto da Standard Schema (https://standardschema.dev) que o SB usa: qualquer biblioteca compatível serve. */
export interface StandardSchema<T = unknown> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    validate(v: unknown): StdResult<T> | Promise<StdResult<T>>;
  };
}

export type Chamador = { via: "ui" | "pagina"; humano: true } | { via: "mcp"; humano: false };

export interface RotaReq {
  metodo: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  chamador: Chamador;
}

export interface Rota {
  metodo: "GET" | "POST" | "PUT" | "DELETE";
  /** com `:param`, ex.: `/itens/:id` */
  caminho: string;
  /** `true`: só humano (UI/página); recusa o api-token local */
  humano?: boolean;
  rodar(req: RotaReq, ctx: ModuleContext): Promise<unknown>;
}

export interface Tarefa {
  id: string;
  quando: string;
  recuperar?: boolean;
  timeoutS?: number;
  rodar(ctx: TarefaContext): Promise<void>;
}

export type TarefaContext = ModuleContext & { ocorrencia: Date; sinal: AbortSignal };

export interface FerramentaMcp {
  nome: string;
  descricao: string;
  entrada: StandardSchema<unknown>;
  entradaJson: Record<string, unknown>;
  rodar(args: unknown, ctx: ModuleContext): Promise<unknown>;
}

export interface ModuleDef {
  sdk: 1;
  id: string;
  nome: string;
  versao: string;
  icone?: string;
  configSchema?: StandardSchema<unknown>;
  aba?: { titulo: string; pasta: string };
  rotas?: Rota[];
  tarefas?: Tarefa[];
  ferramentasMcp?: FerramentaMcp[];
  iniciar?(ctx: ModuleContext): Promise<void>;
  parar?(): Promise<void>;
}

export interface Aviso {
  titulo: string;
  corpo?: string;
  link?: string;
  chave?: string;
}

/**
 * Fachada de conhecimento do módulo: as operações de `Brain` (search, context, get, similar, propose, editProposal) SEM o parâmetro
 * de ator, que o core fixa em `module/<id>`. O SDK não pode importar o core, então os tipos aqui são estruturais e mínimos
 * (`Record<string, unknown>`/`unknown`); o core garante a compatibilidade com a assinatura real de `Brain`.
 */
export interface ModuleBrain {
  search(query: string, filters?: Record<string, unknown>, limit?: number): Promise<unknown[]>;
  context(input: { project?: string; topic?: string; task?: string; max_items?: number; budget_chars?: number }): Promise<unknown>;
  get(id: string): Promise<unknown>;
  similar(draft: { title: string; body: string; project?: string; type?: string }): Promise<unknown>;
  propose(input: Record<string, unknown>): Promise<unknown>;
  /** corrige a PRÓPRIA proposta pendente (`Brain.editProposal`) */
  amend(id: string, patch: Record<string, unknown>): Promise<unknown>;
}

export interface ModuleState {
  dir: string;
  /**
   * Lê `<dir>/<nome>.json`. `undefined` só quando o arquivo não existe; JSON corrompido lança (erro `invalid`) e o arquivo
   * fica intacto, para o módulo não gravar por cima sem saber.
   */
  lerJson<T>(nome: string): T | undefined;
  /** Grava `<dir>/<nome>.json` de forma atômica (tmp + rename). */
  gravarJson(nome: string, v: unknown): void;
  lock<T>(nome: string, fn: () => Promise<T>): Promise<T>;
}

export interface ModuleIa {
  completar(p: { prompt: string; schemaJson?: Record<string, unknown>; modelo?: string; orcamentoUsd?: number; timeoutS?: number; comNotas?: boolean }): Promise<
    { ok: true; dados: unknown; custoUsd?: number } | { ok: false; tipo: "auth" | "timeout" | "orcamento" | "erro"; mensagem: string }
  >;
}

export interface ModuleContext {
  id: string;
  config: unknown;
  brain: ModuleBrain;
  estado: ModuleState;
  ia: ModuleIa;
  avisar(a: Aviso): Promise<void>;
  badge(n: number): void;
  log: { info(m: string): void; erro(m: string, e?: unknown): void };
}

/** Identidade: só dá inferência e checagem de tipo ao declarar o módulo. */
export function defineModule<T extends ModuleDef>(d: T): T {
  return d;
}
