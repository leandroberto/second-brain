import { accessSync, constants, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * Chaves de `_ia.json`: `_ilegivel` é o dia local em que o arquivo anterior foi achado ilegível (nesse dia a IA de TODOS os
 * módulos fica bloqueada; fail-closed: sem o registro, o gasto do dia é desconhecido e conta como igual ao teto) e `_guardado`
 * é onde o registro ilegível foi guardado. Não colidem com ids de módulo (que começam por letra minúscula).
 */
const ILEGIVEL = "_ilegivel";
const GUARDADO = "_guardado";

const objeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Motivos do bloqueio (o texto começa por "bloqueada"): a mensagem da chamada, Saúde, `modules list` e o doctor usam os mesmos. */
const motivoGuardado = (guardado: unknown) => typeof guardado === "string" && guardado
  ? `bloqueada até amanhã; o registro ilegível foi guardado em ${guardado}`
  : "bloqueada até amanhã (registro de gasto ilegível)";
const MOTIVO_A_GUARDAR = "bloqueada: registro de gasto ilegível (será guardado na próxima chamada)";
const motivoSemGuardar = (pasta: string) => `bloqueada até corrigir: não foi possível guardar o registro ilegível em ${pasta}; confira as permissões`;

/** Bloqueio da IA dos módulos no dia, para exibição: o motivo e o que fazer. */
export interface BloqueioIa { motivo: string; correcao: string }

type Leitura = { v: Record<string, unknown>; ilegivel?: false; inacessivel?: string } | { v: Record<string, unknown>; ilegivel: true };

/** Leitura sem efeito colateral: ausente dá `{}`; `ilegivel` se não é um objeto JSON; `inacessivel` (código) se a leitura falhou. */
function ler(arquivo: string): Leitura {
  let bruto: string;
  try { bruto = readFileSync(arquivo, "utf8"); }
  catch (e) { const code = (e as NodeJS.ErrnoException).code; return code === "ENOENT" ? { v: {} } : { v: {}, inacessivel: code ?? "erro" }; }
  try {
    const v = JSON.parse(bruto) as unknown;
    return objeto(v) ? { v } : { v: {}, ilegivel: true };
  } catch { return { v: {}, ilegivel: true }; }
}

/**
 * Leitura para cobrar: arquivo ausente é `{}`; ilegível (JSON inválido ou que não é objeto) é guardado como
 * `_ia.json.corrompido-<timestamp>`, avisado no stderr e substituído por um registro novo só com o bloqueio de hoje e onde o
 * ilegível foi guardado (os dias anteriores se perdem). Se não der para guardá-lo (por motivo que não seja o arquivo já ter
 * sumido), nada é gravado por cima: a IA fica bloqueada até corrigir (`gravavel: false`) e o stderr avisa. `bloqueio` é o
 * motivo, quando a IA está bloqueada hoje.
 */
function lerParaCobrar(arquivo: string, dia: string): { gastos: Gastos; bloqueio?: string; guardado?: string; gravavel: boolean } {
  let bruto: string;
  try { bruto = readFileSync(arquivo, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { gastos: {}, gravavel: true }; throw e; }
  let v: unknown;
  try { v = JSON.parse(bruto); } catch { v = undefined; }
  if (!objeto(v)) {
    let destino: string | undefined;
    try { destino = preservarCorrompido(arquivo); }
    catch (e) {
      console.error(`[brain] registro de gasto de IA ilegível (${arquivo}) e não foi possível guardá-lo (${(e as Error)?.message || "erro"}): a IA dos módulos fica bloqueada até corrigir`);
      return { gastos: {}, bloqueio: motivoSemGuardar(dirname(arquivo)), gravavel: false };
    }
    writeFileAtomic(arquivo, JSON.stringify(destino ? { [ILEGIVEL]: dia, [GUARDADO]: destino } : { [ILEGIVEL]: dia }));
    console.error(`[brain] registro de gasto de IA ilegível (${arquivo})${destino ? `, guardado em ${destino}` : ""}: a IA dos módulos fica bloqueada até amanhã`);
    return { gastos: {}, bloqueio: motivoGuardado(destino), guardado: destino, gravavel: true };
  }
  const { [ILEGIVEL]: marca, [GUARDADO]: guardado, ...gastos } = v;
  if (marca !== dia) return { gastos: gastos as Gastos, gravavel: true };
  return { gastos: gastos as Gastos, bloqueio: motivoGuardado(guardado), guardado: typeof guardado === "string" ? guardado : undefined, gravavel: true };
}

function gravar(arquivo: string, g: Gastos, bloqueadaHoje: { dia: string; guardado?: string } | undefined): void {
  const marca = bloqueadaHoje ? { [ILEGIVEL]: bloqueadaHoje.dia, ...(bloqueadaHoje.guardado ? { [GUARDADO]: bloqueadaHoje.guardado } : {}) } : {};
  writeFileAtomic(arquivo, JSON.stringify({ ...marca, ...g }));
}

/** Gasto de IA do módulo no dia local (de `<root>/_ia.json`), em US$. Para o doctor e a lista de módulos (sem efeito colateral). */
export function gastoIaDoDia(root: string, id: string, dia: Date = new Date()): number {
  const g = ler(join(root, "_ia.json")).v[id];
  const v: unknown = objeto(g) ? g[diaLocal(dia)] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Bloqueio da IA de todos os módulos no dia, para o doctor, `modules list` e Saúde (sem efeito colateral): registro ilegível já
 * guardado (marca do dia), ilegível ainda não tocado (a próxima chamada o guarda), ilegível numa pasta onde não dá para
 * guardá-lo, ou registro inacessível. `undefined` = não bloqueada.
 */
export function bloqueioIaNoDia(root: string, dia: Date = new Date()): BloqueioIa | undefined {
  const arquivo = join(root, "_ia.json");
  const l = ler(arquivo);
  if (!l.ilegivel && l.inacessivel) return { motivo: `bloqueada: registro de gasto inacessível (${l.inacessivel})`, correcao: `confira as permissões de ${arquivo}` };
  if (l.ilegivel) {
    let gravavel = true;
    try { accessSync(root, constants.W_OK | constants.X_OK); } catch { gravavel = false; }
    return gravavel
      ? { motivo: MOTIVO_A_GUARDAR, correcao: "a próxima chamada de IA guarda o registro ilegível; a IA volta no dia seguinte" }
      : { motivo: motivoSemGuardar(root), correcao: `confira as permissões de ${root}` };
  }
  if (l.v[ILEGIVEL] === diaLocal(dia)) return { motivo: motivoGuardado(l.v[GUARDADO]), correcao: "a IA dos módulos volta amanhã" };
  return undefined;
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
        const { gastos: g, bloqueio, guardado, gravavel } = lerParaCobrar(arquivo, dia);
        if (!gravavel) throw new Error("registro de gasto de IA ilegível e não guardado");
        const meu = { ...(g[id] ?? {}) };
        meu[dia] = (meu[dia] ?? 0) + usd;
        g[id] = Object.fromEntries(Object.keys(meu).sort().slice(-DIAS_GUARDADOS).map((d) => [d, meu[d]!]));
        gravar(arquivo, g, bloqueio ? { dia, guardado } : undefined);
      });

      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const { gastos, bloqueio } = await serializado(arquivo, () => lerParaCobrar(arquivo, dia));
        if (bloqueio) return { ok: false, tipo: "orcamento", mensagem: `registro de gasto de IA ilegível; IA do módulo ${id} ${bloqueio}` };
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
