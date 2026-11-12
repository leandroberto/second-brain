import type { ModuleDef } from "@brain/module-sdk";
import { scanSecrets } from "../secrets.js";

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
const campoDe = (path: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined) =>
  (path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join(".");

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
    let r;
    try { r = await def.configSchema["~standard"].validate(config); }
    catch (e) { return { ok: false, erros: [{ campo: "", mensagem: `validação lançou: ${e instanceof Error ? e.message : String(e)}` }] }; }
    if ("issues" in r && r.issues) for (const i of r.issues) erros.push({ campo: campoDe(i.path), mensagem: i.message });
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
