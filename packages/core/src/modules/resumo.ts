import type { ModuleDef } from "@brain/module-sdk";
import { z } from "zod";
import { scanSecrets } from "../secrets.js";
import { validar } from "./schema.js";

/** O que a tela e o `brain modules check --json` mostram de um módulo: só o que o autor declarou, sem rodar nada dele. */
export interface ResumoDoModulo {
  id: string; nome: string; versao: string; sdk: number;
  aba?: { titulo: string };
  tarefas: Array<{ id: string; quando: string; quandoTexto: string }>;
  /** nome MCP completo: `<id>_<nome>` */
  ferramentas: string[];
  rotas: { total: number; humanas: number };
  /** declaração do autor (`ModuleDef.usaIa`) */
  usaIa: boolean;
  configJson?: Record<string, unknown>;
}

const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const hhmm = (h: string, m: string) => `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;

/** Descrição curta em pt-BR dos padrões simples de cron (`M H * * *`, `M H * * 1-5`, `M H * * D`); o resto volta como veio. */
export function descreverCron(expr: string): string {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-7])$/.exec(expr.trim());
  if (!m) return expr;
  const [, min = "", h = "", dia = ""] = m;
  if (Number(min) > 59 || Number(h) > 23) return expr;
  const hora = hhmm(h, min);
  if (dia === "*") return `todo dia às ${hora}`;
  if (dia === "1-5") return `dias úteis às ${hora}`;
  return `${DIAS[Number(dia) % 7]} às ${hora}`;
}

export function resumirModulo(def: ModuleDef): ResumoDoModulo {
  const rotas = def.rotas ?? [];
  return {
    id: def.id, nome: def.nome, versao: def.versao, sdk: def.sdk,
    ...(def.aba ? { aba: { titulo: def.aba.titulo } } : {}),
    tarefas: (def.tarefas ?? []).map((t) => ({ id: t.id, quando: t.quando, quandoTexto: descreverCron(t.quando) })),
    ferramentas: (def.ferramentasMcp ?? []).map((f) => `${def.id}_${f.nome}`),
    rotas: { total: rotas.length, humanas: rotas.filter((r) => r.humano === true).length },
    usaIa: def.usaIa === true,
    ...(def.configJson ? { configJson: def.configJson } : {}),
  };
}

export type ResultadoConfig = { ok: true } | { ok: false; erros: Array<{ campo: string; mensagem: string }> };

const MSG_SEGREDO = "use variável de ambiente ou o cofre do sistema; o módulo lê a credencial por conta própria";
/** A mensagem de um schema pode citar o valor recebido: com possível segredo, é omitida. */
const semSegredo = (m: string) => (scanSecrets(m).length ? "[mensagem omitida: possível segredo]" : m);

/** Folhas de texto da config com o caminho de cada uma (para apontar o campo que guarda o segredo). */
function folhas(v: unknown, caminho: string, out: Array<[string, string]>): void {
  if (typeof v === "string") out.push([caminho, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => folhas(x, caminho ? `${caminho}.${i}` : String(i), out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) folhas(x, caminho ? `${caminho}.${k}` : k, out);
}

/**
 * Valida a config pelo `configSchema` do módulo (Standard Schema) e recusa segredo em qualquer valor de texto. A mensagem de
 * segredo nunca repete o valor.
 */
export async function validarConfigDoModulo(def: ModuleDef, config: unknown): Promise<ResultadoConfig> {
  const erros: Array<{ campo: string; mensagem: string }> = [];
  if (def.configSchema) {
    const v = await validar(def.configSchema, config);
    if (!v.ok) {
      if (v.lancou) return { ok: false, erros: [{ campo: "", mensagem: semSegredo(v.mensagem) }] };
      for (const i of v.issues) erros.push({ campo: i.campo, mensagem: semSegredo(i.mensagem) });
    }
  }
  const textos: Array<[string, string]> = [];
  folhas(config, "", textos);
  const comSegredo = new Set<string>();
  for (const [campo, valor] of textos) {
    const ultimo = campo.split(".").pop() ?? "";
    if (scanSecrets(valor).length || scanSecrets(`${ultimo}: ${valor}`).length) comSegredo.add(campo);
  }
  for (const campo of comSegredo) {
    // o segredo substitui a mensagem do schema para o mesmo campo: nada do valor volta
    const i = erros.findIndex((e) => e.campo === campo);
    if (i >= 0) erros.splice(i, 1);
    erros.push({ campo, mensagem: MSG_SEGREDO });
  }
  return erros.length ? { ok: false, erros } : { ok: true };
}

const ErroDeCampo = z.object({ campo: z.string(), mensagem: z.string() });
/** Forma do `brain modules check --json` lida pelo pai da conferência (o filho roda código do módulo: nada é confiado sem checar). */
const ResultadoDaConferenciaSchema = z.object({
  ok: z.boolean(),
  causas: z.array(z.string()),
  resumo: z.object({
    id: z.string(), nome: z.string(), versao: z.string(), sdk: z.number(),
    aba: z.object({ titulo: z.string() }).optional(),
    tarefas: z.array(z.object({ id: z.string(), quando: z.string(), quandoTexto: z.string() })),
    ferramentas: z.array(z.string()),
    rotas: z.object({ total: z.number(), humanas: z.number() }),
    usaIa: z.boolean(),
    configJson: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  config: z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), erros: z.array(ErroDeCampo) })]).optional(),
});
export type ResultadoDaConferencia = { ok: boolean; causas: string[]; resumo?: ResumoDoModulo; config?: ResultadoConfig };

/** Valida o resultado de uma conferência; `undefined` se a forma não confere. */
export function lerResultadoDaConferencia(valor: unknown): ResultadoDaConferencia | undefined {
  const r = ResultadoDaConferenciaSchema.safeParse(valor);
  return r.success ? r.data as ResultadoDaConferencia : undefined;
}
