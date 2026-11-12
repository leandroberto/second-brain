import { api } from "./api";

/** Um campo de formulário derivado do JSON Schema da config do módulo (`ModuleDef.configJson`). */
export interface Campo {
  nome: string;
  tipo: "texto" | "numero" | "booleano" | "opcoes";
  rotulo: string;
  descricao?: string;
  obrigatorio: boolean;
  opcoes?: string[];
  padrao?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Campos do formulário para um schema de objeto raso (só string, number, integer, boolean e enum de strings). `undefined` para
 * qualquer outra forma (objeto aninhado, array, anyOf, $ref...): a tela cai no editor JSON. O servidor valida de qualquer jeito;
 * `pattern`, limites e afins não viram regra no formulário.
 */
export function camposDoSchema(schema: unknown): Campo[] | undefined {
  if (!isObj(schema) || schema.type !== "object") return undefined;
  const props = schema.properties;
  if (props !== undefined && !isObj(props)) return undefined;
  const obrigatorios = Array.isArray(schema.required) ? schema.required : [];
  const campos: Campo[] = [];
  for (const [nome, def] of Object.entries(props ?? {})) {
    if (!isObj(def)) return undefined;
    let tipo: Campo["tipo"]; let opcoes: string[] | undefined;
    if (def.enum !== undefined) {
      if (!Array.isArray(def.enum) || !def.enum.length || !def.enum.every((o) => typeof o === "string")) return undefined;
      tipo = "opcoes"; opcoes = def.enum as string[];
    } else if (def.type === "string") tipo = "texto";
    else if (def.type === "number" || def.type === "integer") tipo = "numero";
    else if (def.type === "boolean") tipo = "booleano";
    else return undefined;
    campos.push({
      nome, tipo,
      rotulo: typeof def.title === "string" && def.title ? def.title : nome,
      ...(typeof def.description === "string" && def.description ? { descricao: def.description } : {}),
      obrigatorio: obrigatorios.includes(nome),
      ...(opcoes ? { opcoes } : {}),
      ...(def.default !== undefined ? { padrao: def.default } : {}),
    });
  }
  return campos;
}

/** Valor de cada campo: o da config existente, senão o padrão do schema (sem padrão, o campo fica de fora). */
export function valoresIniciais(campos: Campo[], config?: Record<string, unknown>): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const c of campos) {
    const x = config?.[c.nome] !== undefined ? config[c.nome] : c.padrao;
    if (x !== undefined) v[c.nome] = x;
  }
  return v;
}

/**
 * Config a enviar: números digitados viram número (texto que não é número segue como está, o servidor recusa com o erro do
 * campo) e texto vazio sai (campo não preenchido). Com `atual` (Configurar um módulo já instalado), as chaves dela que o
 * formulário não mostra (fora de `properties`) seguem como estão: salvar pelo formulário não as apaga.
 */
export function configDoFormulario(campos: Campo[], valores: Record<string, unknown>, atual?: Record<string, unknown>): Record<string, unknown> {
  const nomes = new Set(campos.map((c) => c.nome));
  const cfg: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(atual ?? {})) if (!nomes.has(k)) cfg[k] = v;
  for (const c of campos) {
    const v = valores[c.nome];
    if (v === undefined || v === "") continue;
    cfg[c.nome] = c.tipo === "numero" && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
  }
  return cfg;
}

export const AVISO_SEM_VALIDAR = "Não foi possível validar agora: a configuração será conferida quando o módulo voltar a carregar.";

/**
 * Aviso de Configurar quando o servidor grava sem validar pelo schema do módulo (só o detector de segredos): o módulo não
 * carrega (falho sem schema, ausente) ou não roda nesta máquina (desligado, inativo) num vault com frase-senha, onde o código
 * dele só roda para conferir depois da frase. `status` indefinido = o serve não conhece o módulo (desligado). `fraseSenha`
 * indefinido = `GET _gerenciar/estado` falhou ou ainda não respondeu: pode haver frase, então o aviso aparece (é só texto;
 * quem decide é o servidor).
 */
export function avisoDeValidacao(m: { status?: "ativo" | "falho" | "inativo" | "ausente"; temSchema: boolean; desligado: boolean; fraseSenha?: boolean }): string | undefined {
  if (!m.temSchema && (m.status === "falho" || m.status === "ausente")) return AVISO_SEM_VALIDAR;
  if (m.fraseSenha !== false && (m.desligado || m.status === "inativo")) return AVISO_SEM_VALIDAR;
  return undefined;
}

const dorme = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const consultarServe = () => api<{ pid: number }>("/api/serve").catch(() => undefined);

/**
 * Espera o `brain serve` reiniciar: consulta `GET /api/serve` até o `pid` mudar. Falha de rede (o serve caído) é esperada e
 * só tenta de novo. Sem `pidAntigo` (a consulta antes da ação falhou), vale qualquer resposta depois de ao menos uma falha.
 * Passado o limite (60 s), `"tempo"`.
 */
export async function esperarReinicio(
  pidAntigo: number | undefined,
  o: { buscar?: () => Promise<{ pid: number } | undefined>; intervaloMs?: number; limiteMs?: number } = {},
): Promise<"ok" | "tempo"> {
  const buscar = o.buscar ?? consultarServe; const intervalo = o.intervaloMs ?? 1000; const limite = o.limiteMs ?? 60_000;
  const fim = Date.now() + limite;
  let falhou = false;
  while (Date.now() < fim) {
    await dorme(intervalo);
    try {
      const r = await buscar();
      if (!r) falhou = true;
      else if (pidAntigo === undefined ? falhou : r.pid !== pidAntigo) return "ok";
    } catch { falhou = true; /* serve reiniciando */ }
  }
  return "tempo";
}
