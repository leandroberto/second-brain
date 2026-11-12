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
 * campo) e texto vazio sai (campo não preenchido).
 */
export function configDoFormulario(campos: Campo[], valores: Record<string, unknown>): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  for (const c of campos) {
    const v = valores[c.nome];
    if (v === undefined || v === "") continue;
    cfg[c.nome] = c.tipo === "numero" && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
  }
  return cfg;
}

const dorme = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const consultarServe = () => api<{ pid: number }>("/api/serve").catch(() => undefined);

/**
 * Espera o `brain serve` reiniciar: consulta `GET /api/serve` até o `pid` mudar. Falha de rede (o serve caído) é esperada e
 * só tenta de novo. Passado o limite (60 s), `"tempo"`.
 */
export async function esperarReinicio(
  pidAntigo: number,
  o: { buscar?: () => Promise<{ pid: number } | undefined>; intervaloMs?: number; limiteMs?: number } = {},
): Promise<"ok" | "tempo"> {
  const buscar = o.buscar ?? consultarServe; const intervalo = o.intervaloMs ?? 1000; const limite = o.limiteMs ?? 60_000;
  const fim = Date.now() + limite;
  while (Date.now() < fim) {
    await dorme(intervalo);
    try { const r = await buscar(); if (r && r.pid !== pidAntigo) return "ok"; } catch { /* serve reiniciando */ }
  }
  return "tempo";
}
