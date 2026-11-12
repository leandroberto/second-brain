import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrainError } from "@brain/shared";
import type { Tarefa, TarefaContext } from "@brain/module-sdk";
import { preservarCorrompido, writeFileAtomic } from "../fs-atomic.js";
import { parseCron, type Cron } from "./cron.js";
import type { ModuleRegistry } from "./registry.js";

export type ResultadoTarefa = { resultado: "ok" | "erro" | "timeout"; erro?: string };

export type StatusTarefa = {
  tarefa: string; quando: string; proxima: string;
  ultimaOcorrencia?: string; inicio?: string; fim?: string;
  resultado?: "ok" | "erro" | "timeout"; erro?: string;
  suspensa: boolean; errosSeguidos: number;
};

interface Registro {
  ultimaOcorrencia?: string; inicio?: string; fim?: string;
  resultado?: "ok" | "erro" | "timeout"; erro?: string;
  suspensa: boolean; errosSeguidos: number;
}

const MAX_ERROS_SEGUIDOS = 5;
const TIMEOUT_PADRAO_S = 300;

const dataValida = (v: unknown): boolean => v === undefined || (typeof v === "string" && !Number.isNaN(Date.parse(v)));
/** Entrada do `_scheduler.json` com tipos e datas válidos (campo errado deixaria a tarefa parada em silêncio: NaN, Invalid Date). */
function registroValido(v: unknown): v is Registro {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return dataValida(r.ultimaOcorrencia) && dataValida(r.inicio) && dataValida(r.fim)
    && (r.resultado === undefined || r.resultado === "ok" || r.resultado === "erro" || r.resultado === "timeout")
    && (r.erro === undefined || typeof r.erro === "string")
    && typeof r.suspensa === "boolean" && Number.isInteger(r.errosSeguidos) && (r.errosSeguidos as number) >= 0;
}

/** Data e hora LOCAIS (AAAA-MM-DD HH:MM): a mesma ocorrência local nunca roda duas vezes, nem na volta do horário de verão. */
const chaveLocal = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/**
 * Agendador de tarefas de módulo (só no `serve`). Uma ocorrência conta como atendida quando a execução COMEÇA (marcador gravado
 * antes de `rodar`): falha, timeout ou queda não geram nova tentativa automática (spec §7.8).
 */
export class Scheduler {
  private readonly agora: () => Date;
  private readonly tickMs: number;
  private readonly arq: string;
  private estado: Record<string, Registro> = {};
  private timer?: ReturnType<typeof setInterval>;
  private ultimoTick?: number;
  private parado = false;
  /** falha de gravação do `_scheduler.json` já avisada neste ciclo: no stderr e por módulo afetado */
  private gravacaoAvisadaNoStderr = false;
  private readonly gravacaoAvisadaPara = new Set<string>();
  /** último erro registrado por tarefa (`<id>/<tarefa>` → mensagem): o mesmo erro não se repete a cada ciclo */
  private readonly errosDeTarefa = new Map<string, string>();
  /** tarefas cujo estado inválido já foi registrado */
  private readonly estadoInvalidoAvisado = new Set<string>();
  private readonly emCurso = new Map<string, { ctl: AbortController; fim: Promise<ResultadoTarefa> }>();
  private readonly crons = new Map<string, { expr: string; cron: Cron }>();
  private readonly invalidas = new Set<string>();

  constructor(private readonly reg: ModuleRegistry, private readonly root: string, o: { agora?: () => Date; tickMs?: number } = {}) {
    this.agora = o.agora ?? (() => new Date());
    this.tickMs = o.tickMs ?? 30_000;
    this.arq = join(root, "_scheduler.json");
  }

  start(): void {
    if (this.timer) return;
    this.parado = false;
    this.carregar();
    // reinício reativa tarefas suspensas
    for (const r of Object.values(this.estado)) { r.suspensa = false; r.errosSeguidos = 0; }
    this.tick(true);
    this.timer = setInterval(() => this.tick(false), this.tickMs);
  }

  async stop(): Promise<void> {
    this.parado = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    const pend = [...this.emCurso.values()];
    for (const e of pend) e.ctl.abort();
    await Promise.allSettled(pend.map((e) => e.fim));
  }

  status(id: string): StatusTarefa[] {
    this.carregarSeVazio();
    const out: StatusTarefa[] = [];
    for (const t of this.reg.get(id)?.def?.tarefas ?? []) {
      const cron = this.cronDe(id, t);
      if (!cron) continue;
      const r = this.estado[`${id}/${t.id}`];
      let proxima: string;
      try { proxima = cron.next(this.agora()).toISOString(); }
      catch (e) { this.erroDeTarefa(id, t.id, e); continue; }
      out.push({
        tarefa: t.id, quando: t.quando, proxima,
        ultimaOcorrencia: r?.ultimaOcorrencia, inicio: r?.inicio, fim: r?.fim, resultado: r?.resultado, erro: r?.erro,
        suspensa: r?.suspensa ?? false, errosSeguidos: r?.errosSeguidos ?? 0,
      });
    }
    return out;
  }

  /**
   * Roda agora (ação humana). Sem `ocorrencia`: a última atendida, ou a mais recente prevista se não houver. Nunca muda a
   * última atendida a partir da data pedida; sem registro, ela começa como na primeira subida (a ocorrência mais recente).
   */
  async runNow(id: string, tarefa: string, ocorrencia?: Date): Promise<ResultadoTarefa> {
    this.carregarSeVazio();
    const m = this.reg.get(id);
    const t = m?.def?.tarefas?.find((x) => x.id === tarefa);
    if (!m || m.status !== "ativo" || !m.ctx || !t) throw new BrainError("not_found", `tarefa "${id}/${tarefa}" não encontrada ou módulo inativo`);
    const cron = this.cronDe(id, t);
    if (!cron) throw new BrainError("invalid", `tarefa "${id}/${tarefa}" tem expressão cron inválida`);
    const chave = `${id}/${tarefa}`;
    if (this.emCurso.has(chave)) return { resultado: "erro", erro: "já em execução" };
    this.novoCiclo();
    const r = this.registro(chave);
    r.ultimaOcorrencia ??= cron.prev(this.agora()).toISOString();
    const oc = ocorrencia ?? new Date(r.ultimaOcorrencia);
    r.suspensa = false;
    return this.executar(id, t, oc, false);
  }

  private tick(subida: boolean): void {
    if (this.parado) return;
    const agora = this.agora();
    const salto = this.ultimoTick !== undefined && agora.getTime() - this.ultimoTick > 3 * this.tickMs;
    this.ultimoTick = agora.getTime();
    const reaplicar = subida || salto;
    const afetados = new Set<string>();
    this.novoCiclo();
    for (const m of this.reg.list()) {
      if (m.status !== "ativo" || !m.ctx) continue;
      for (const t of m.def?.tarefas ?? []) {
       try {
        const cron = this.cronDe(m.id, t);
        if (!cron) continue;
        const chave = `${m.id}/${t.id}`;
        const prev = cron.prev(agora);
        this.errosDeTarefa.delete(chave); // o erro anterior desta tarefa (se houve) já não persiste
        const r = this.estado[chave];
        if (!r) { this.estado[chave] = { ultimaOcorrencia: prev.toISOString(), suspensa: false, errosSeguidos: 0 }; afetados.add(m.id); continue; }
        const ultima = r.ultimaOcorrencia ? new Date(r.ultimaOcorrencia) : undefined;
        if (ultima && (prev.getTime() <= ultima.getTime() || chaveLocal(prev) === chaveLocal(ultima))) continue;
        // ocorrência pendente: roda, ou é só marcada como atendida (suspensa, sobreposição, subida sem recuperar)
        const pula = r.suspensa || this.emCurso.has(chave) || (reaplicar && !t.recuperar);
        if (pula) { r.ultimaOcorrencia = prev.toISOString(); afetados.add(m.id); continue; }
        void this.executar(m.id, t, prev, true);
       } catch (e) { this.erroDeTarefa(m.id, t.id, e); }
      }
    }
    if (afetados.size) this.gravar(afetados);
  }

  private novoCiclo(): void { this.gravacaoAvisadaNoStderr = false; this.gravacaoAvisadaPara.clear(); }

  /** Registra o erro de uma tarefa, mas não o mesmo de novo enquanto ele persistir (um cron que lança falharia a cada ciclo). */
  private erroDeTarefa(id: string, tarefa: string, e: unknown): void {
    const chave = `${id}/${tarefa}`;
    const msg = e instanceof Error ? e.message : String(e);
    if (this.errosDeTarefa.get(chave) === msg) return;
    this.errosDeTarefa.set(chave, msg);
    this.reg.recordError(id, `tarefa:${tarefa}`, e);
  }

  private executar(id: string, t: Tarefa, ocorrencia: Date, automatica: boolean): Promise<ResultadoTarefa> {
    const chave = `${id}/${t.id}`;
    const ctl = new AbortController();
    const r = this.registro(chave);
    // atendida ao começar: marcador gravado ANTES de chamar rodar (a execução manual não mexe na última atendida)
    if (automatica) r.ultimaOcorrencia = ocorrencia.toISOString();
    r.inicio = this.agora().toISOString();
    r.fim = undefined; r.resultado = undefined; r.erro = undefined;
    const falha = this.gravar([id], `tarefa:${t.id}`);
    if (falha) {
      // sem marcador persistido a garantia "atendida ao começar" não vale: não roda
      const erro = `não foi possível gravar o marcador da ocorrência: ${falha}`;
      r.fim = this.agora().toISOString(); r.resultado = "erro"; r.erro = erro;
      return Promise.resolve({ resultado: "erro", erro });
    }
    const fim = this.rodar(id, t, ocorrencia, ctl).then((res) => this.concluir(id, t, chave, res));
    this.emCurso.set(chave, { ctl, fim });
    void fim.finally(() => this.emCurso.delete(chave)).catch(() => undefined);
    return fim;
  }

  private async rodar(id: string, t: Tarefa, ocorrencia: Date, ctl: AbortController): Promise<ResultadoTarefa & { interna?: unknown; interrompida?: boolean }> {
    const ctx = this.reg.get(id)?.ctx;
    if (!ctx) return { resultado: "erro", erro: "módulo sem contexto" };
    const ms = (t.timeoutS ?? TIMEOUT_PADRAO_S) * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const limite = new Promise<ResultadoTarefa & { interrompida?: boolean }>((resolve) => {
      timer = setTimeout(() => { resolve({ resultado: "timeout", erro: `excedeu ${t.timeoutS ?? TIMEOUT_PADRAO_S}s` }); ctl.abort(); }, ms);
      onAbort = () => resolve({ resultado: "erro", erro: "interrompida pelo encerramento", interrompida: true });
      ctl.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const tctx: TarefaContext = { ...ctx, ocorrencia, sinal: ctl.signal };
      // marcador de execução (§7.12) gravado antes de chamar `rodar`; sai no fim, no timeout ou na interrupção
      return await this.reg.executando(id, `tarefa:${t.id}`, () => {
        const exec = (async () => {
          try { await t.rodar(tctx); return { resultado: "ok" } as ResultadoTarefa; }
          catch (e) { return { resultado: "erro", erro: (e instanceof Error ? e.message : String(e)).slice(0, 500), interna: e } as ResultadoTarefa & { interna: unknown }; }
        })();
        return Promise.race([exec, limite]);
      });
    } finally {
      clearTimeout(timer);
      if (onAbort) ctl.signal.removeEventListener("abort", onAbort);
    }
  }

  private concluir(id: string, t: Tarefa, chave: string, res: ResultadoTarefa & { interna?: unknown; interrompida?: boolean }): ResultadoTarefa {
    const r = this.registro(chave);
    r.fim = this.agora().toISOString();
    r.resultado = res.resultado;
    r.erro = res.erro;
    if (res.resultado === "ok") r.errosSeguidos = 0;
    else if (!res.interrompida) {
      r.errosSeguidos += 1;
      if (r.errosSeguidos >= MAX_ERROS_SEGUIDOS) r.suspensa = true;
      this.reg.recordError(id, `tarefa:${t.id}`, res.interna ?? new Error(res.erro ?? res.resultado));
    }
    this.gravar([id], `tarefa:${t.id}`);
    return res.erro === undefined ? { resultado: res.resultado } : { resultado: res.resultado, erro: res.erro };
  }

  private registro(chave: string): Registro {
    return (this.estado[chave] ??= { suspensa: false, errosSeguidos: 0 });
  }

  private cronDe(id: string, t: Tarefa): Cron | undefined {
    const chave = `${id}/${t.id}`;
    const c = this.crons.get(chave);
    if (c && c.expr === t.quando) return c.cron;
    try {
      const cron = parseCron(t.quando);
      // expressão válida mas impossível (ex.: 31 de fevereiro) só falha ao buscar ocorrência
      const agora = this.agora();
      cron.next(agora); cron.prev(agora);
      this.crons.set(chave, { expr: t.quando, cron });
      return cron;
    } catch (e) {
      if (!this.invalidas.has(chave)) { this.invalidas.add(chave); this.reg.recordError(id, `tarefa:${t.id}`, e); }
      return undefined;
    }
  }

  private carregarSeVazio(): void { if (!this.timer && Object.keys(this.estado).length === 0) this.carregar(); }

  /**
   * Carrega o `_scheduler.json`. Entrada inválida (tipos, datas) é descartada: a tarefa recomeça como na primeira subida (a
   * ocorrência mais recente conta como atendida, nada roda) e o erro é registrado uma vez. Arquivo ilegível (JSON inválido ou
   * que não é objeto) é preservado como `_scheduler.json.corrompido-<timestamp>` e vale o mesmo para todas as tarefas.
   */
  private carregar(): void {
    if (!existsSync(this.arq)) return;
    let v: unknown;
    let corrompido = false;
    try { v = JSON.parse(readFileSync(this.arq, "utf8")); }
    catch (e) { corrompido = e instanceof SyntaxError; v = undefined; } // erro de leitura (EISDIR, EACCES): sem histórico, arquivo intocado
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      if (corrompido || v !== undefined) preservarCorrompido(this.arq);
      this.estado = {};
      for (const m of this.reg.list()) for (const t of m.def?.tarefas ?? []) this.estadoInvalido(m.id, t.id);
      return;
    }
    const estado: Record<string, Registro> = {};
    for (const [chave, r] of Object.entries(v)) {
      if (registroValido(r)) { estado[chave] = r; continue; }
      const i = chave.indexOf("/");
      if (i > 0) this.estadoInvalido(chave.slice(0, i), chave.slice(i + 1));
    }
    this.estado = estado;
  }

  private estadoInvalido(id: string, tarefa: string): void {
    const chave = `${id}/${tarefa}`;
    if (this.estadoInvalidoAvisado.has(chave)) return;
    this.estadoInvalidoAvisado.add(chave);
    this.reg.recordError(id, "agendador", new Error(`estado do agendador inválido para ${tarefa}; reiniciado`));
  }

  /**
   * Devolve a mensagem de erro (ou `undefined` se gravou). Falha de disco nunca lança: vai para o stderr e para cada módulo
   * `afetados` (os que tiveram estado alterado), no máximo uma vez por ciclo.
   */
  private gravar(afetados: Iterable<string>, onde = "scheduler"): string | undefined {
    try {
      writeFileAtomic(this.arq, JSON.stringify(this.estado, null, 2));
      return undefined;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const erro = new Error(`falha ao gravar _scheduler.json: ${msg}`);
      if (!this.gravacaoAvisadaNoStderr) { this.gravacaoAvisadaNoStderr = true; console.error(`[brain] agendador: ${erro.message}`); }
      for (const id of afetados) {
        if (this.gravacaoAvisadaPara.has(id)) continue;
        this.gravacaoAvisadaPara.add(id);
        this.reg.recordError(id, onde, erro);
      }
      return msg;
    }
  }
}
