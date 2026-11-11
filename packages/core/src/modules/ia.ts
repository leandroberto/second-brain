import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ModuleIa } from "@brain/module-sdk";
import type { AssistantEngine } from "../assistant/engine.js";
import type { BrainConfig } from "../config.js";

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

function ler(arquivo: string): Gastos {
  try {
    const v = JSON.parse(readFileSync(arquivo, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Gastos) : {};
  } catch { return {}; }
}

function gravar(arquivo: string, g: Gastos): void {
  const tmp = `${arquivo}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(g), { mode: 0o600 });
  renameSync(tmp, arquivo);
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

      const gasto = () => ler(arquivo)[id]?.[dia] ?? 0;
      const somar = (usd: number) => serializado(arquivo, () => {
        const g = ler(arquivo);
        const meu = { ...(g[id] ?? {}) };
        meu[dia] = (meu[dia] ?? 0) + usd;
        g[id] = Object.fromEntries(Object.keys(meu).sort().slice(-DIAS_GUARDADOS).map((d) => [d, meu[d]!]));
        gravar(arquivo, g);
      });

      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        if (await serializado(arquivo, gasto) >= teto) return { ok: false, tipo: "orcamento", mensagem: `teto diário de IA do módulo ${id} atingido` };
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
