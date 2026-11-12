import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleIa } from "@brain/module-sdk";
import type { AssistantEngine } from "../assistant/engine.js";
import type { BrainConfig } from "../config.js";
import { preservarCorrompido, writeFileAtomic } from "../fs-atomic.js";

/** Quantos dias de gasto ficam gravados por módulo em `_ia.json`. */
const DIAS_GUARDADOS = 31;

/** Teto do timeout de uma chamada (setTimeout estoura acima de ~2.147.483 s). */
const MAX_TIMEOUT_S = 3600;

type Gastos = Record<string, Record<string, number>>;

/** Data local AAAA-MM-DD (o teto diário vira com o dia do usuário, não com o UTC). */
const diaLocal = (d: Date = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Filas por arquivo, no processo: leitura+soma+gravação de um mesmo `_ia.json` nunca se intercalam. */
const filas = new Map<string, Promise<unknown>>();
function serializado<T>(arquivo: string, fn: () => T | Promise<T>): Promise<T> {
  const run = (filas.get(arquivo) ?? Promise.resolve()).then(fn, fn);
  const cauda = run.catch(() => undefined);
  filas.set(arquivo, cauda);
  void cauda.then(() => { if (filas.get(arquivo) === cauda) filas.delete(arquivo); });
  return run;
}

/**
 * Chave de `_ia.json` com o dia local em que o arquivo anterior foi achado ilegível. Nesse dia a IA de TODOS os módulos fica
 * bloqueada (fail-closed: sem o registro, o gasto do dia é desconhecido e é tratado como igual ao teto). Não colide com
 * nenhum id de módulo (que começa por letra minúscula).
 */
const ILEGIVEL = "_ilegivel";

const objeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Leitura tolerante, só para exibição (doctor, Saúde): arquivo ausente ou ilegível dá `{}`, sem efeito colateral. */
function ler(arquivo: string): Gastos {
  try {
    const v = JSON.parse(readFileSync(arquivo, "utf8")) as unknown;
    return objeto(v) ? (v as Gastos) : {};
  } catch { return {}; }
}

/**
 * Leitura para cobrar: arquivo ausente é `{}`; ilegível (JSON inválido ou que não é objeto) é preservado como
 * `_ia.json.corrompido-<timestamp>`, avisado no stderr e substituído por um registro novo só com o bloqueio de hoje (os dias
 * anteriores se perdem). Devolve os gastos e se a IA está bloqueada hoje.
 */
function lerParaCobrar(arquivo: string, dia: string): { gastos: Gastos; bloqueada: boolean } {
  let bruto: string;
  try { bruto = readFileSync(arquivo, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { gastos: {}, bloqueada: false }; throw e; }
  let v: unknown;
  try { v = JSON.parse(bruto); } catch { v = undefined; }
  if (!objeto(v)) {
    const destino = preservarCorrompido(arquivo);
    writeFileAtomic(arquivo, JSON.stringify({ [ILEGIVEL]: dia }));
    console.error(`[brain] registro de gasto de IA ilegível (${arquivo})${destino ? `, preservado em ${destino}` : ""}: a IA dos módulos fica bloqueada até amanhã`);
    return { gastos: {}, bloqueada: true };
  }
  const { [ILEGIVEL]: marca, ...gastos } = v;
  return { gastos: gastos as Gastos, bloqueada: marca === dia };
}

function gravar(arquivo: string, g: Gastos, bloqueadaHoje: string | undefined): void {
  writeFileAtomic(arquivo, JSON.stringify(bloqueadaHoje ? { [ILEGIVEL]: bloqueadaHoje, ...g } : g));
}

/** Gasto de IA do módulo no dia local (de `<root>/_ia.json`), em US$. Para o doctor e a lista de módulos (sem efeito colateral). */
export function gastoIaDoDia(root: string, id: string, dia: Date = new Date()): number {
  const v: unknown = ler(join(root, "_ia.json"))[id]?.[diaLocal(dia)];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

const valido = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * IA de um módulo (spec §7.11): `complete` do motor com orçamento por chamada limitado pelo do assistente e teto diário
 * (`modules.<id>.ia_max_usd_dia`) gravado em `<root>/_ia.json`. O teto é conferido ANTES de rodar; o gasto é somado depois,
 * pelo custo informado pelo claude ou, na falta dele, pelo orçamento da chamada.
 */
export function createModuleIa(engine: AssistantEngine, cfg: BrainConfig, root: string, id: string): ModuleIa {
  const arquivo = join(root, "_ia.json");
  const max = cfg.assistant.max_budget_usd;
  return {
    async completar(p) {
      if (typeof p?.prompt !== "string" || !p.prompt.trim()) return { ok: false, tipo: "erro", mensagem: "prompt vazio" };
      if (p.orcamentoUsd !== undefined && !valido(p.orcamentoUsd)) return { ok: false, tipo: "erro", mensagem: "orcamentoUsd inválido (use um número maior que zero)" };
      if (p.timeoutS !== undefined && !valido(p.timeoutS)) return { ok: false, tipo: "erro", mensagem: "timeoutS inválido (use um número maior que zero)" };
      const orcamentoUsd = Math.min(p.orcamentoUsd ?? max, max);
      const timeoutS = Math.min(p.timeoutS ?? cfg.assistant.timeout_s, MAX_TIMEOUT_S);
      const teto = cfg.modules[id]?.ia_max_usd_dia ?? 2;
      const dia = diaLocal();

      const somar = (usd: number) => serializado(arquivo, () => {
        const { gastos: g, bloqueada } = lerParaCobrar(arquivo, dia);
        const meu = { ...(g[id] ?? {}) };
        meu[dia] = (meu[dia] ?? 0) + usd;
        g[id] = Object.fromEntries(Object.keys(meu).sort().slice(-DIAS_GUARDADOS).map((d) => [d, meu[d]!]));
        gravar(arquivo, g, bloqueada ? dia : undefined);
      });

      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const { gastos, bloqueada } = await serializado(arquivo, () => lerParaCobrar(arquivo, dia));
        if (bloqueada) return { ok: false, tipo: "orcamento", mensagem: `registro de gasto de IA ilegível; IA do módulo ${id} bloqueada até amanhã` };
        if ((gastos[id]?.[dia] ?? 0) >= teto) return { ok: false, tipo: "orcamento", mensagem: `teto diário de IA do módulo ${id} atingido` };
      } catch (e) {
        return { ok: false, tipo: "erro", mensagem: (e as Error)?.message || String(e) };
      }

      let r;
      try {
        r = await engine.complete({ agente: `module/${id}`, prompt: p.prompt, schemaJson: p.schemaJson, modelo: p.modelo, orcamentoUsd, timeoutS, comNotas: p.comNotas === true });
      } catch (e) {
        r = { ok: false as const, tipo: "erro" as const, mensagem: (e as Error)?.message || String(e) };
      }
      // sem custo informado, conta o orçamento da chamada (teto conservador); falhas sem custo não contam
      // orcamento e timeout gastaram até o limite da chamada; auth e erro sem custo informado não contam
      const informado = r.custoUsd !== undefined && Number.isFinite(r.custoUsd) && r.custoUsd >= 0 ? r.custoUsd : undefined;
      const custo = informado ?? (r.ok || r.tipo === "orcamento" || r.tipo === "timeout" ? orcamentoUsd : 0);
      if (custo > 0) {
        try { await somar(custo); }
        catch (e) { console.error(`[brain] módulo ${id}: não foi possível gravar o gasto de IA (${(e as Error)?.message || "erro"}); o teto diário não vale para esta chamada`); }
      }
      return r;
    },
  };
}
