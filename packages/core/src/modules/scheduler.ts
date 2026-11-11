import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BrainError } from "@brain/shared";
import type { Tarefa, TarefaContext } from "@brain/module-sdk";
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
      out.push({
        tarefa: t.id, quando: t.quando, proxima: cron.next(this.agora()).toISOString(),
        ultimaOcorrencia: r?.ultimaOcorrencia, inicio: r?.inicio, fim: r?.fim, resultado: r?.resultado, erro: r?.erro,
        suspensa: r?.suspensa ?? false, errosSeguidos: r?.errosSeguidos ?? 0,
      });
    }
    return out;
  }

  /** Roda agora (ação humana). Sem `ocorrencia`: a última atendida, ou a mais recente prevista se não houver. */
  async runNow(id: string, tarefa: string, ocorrencia?: Date): Promise<ResultadoTarefa> {
    this.carregarSeVazio();
    const m = this.reg.get(id);
    const t = m?.def?.tarefas?.find((x) => x.id === tarefa);
    if (!m || m.status !== "ativo" || !m.ctx || !t) throw new BrainError("not_found", `tarefa "${id}/${tarefa}" não encontrada ou módulo inativo`);
    const cron = this.cronDe(id, t);
    if (!cron) throw new BrainError("invalid", `tarefa "${id}/${tarefa}" tem expressão cron inválida`);
    const chave = `${id}/${tarefa}`;
    if (this.emCurso.has(chave)) return { resultado: "erro", erro: "já em execução" };
    const r = this.registro(chave);
    const oc = ocorrencia ?? (r.ultimaOcorrencia ? new Date(r.ultimaOcorrencia) : cron.prev(this.agora()));
    r.suspensa = false;
    return this.executar(id, t, oc, false);
  }

  private tick(subida: boolean): void {
    if (this.parado) return;
    const agora = this.agora();
    const salto = this.ultimoTick !== undefined && agora.getTime() - this.ultimoTick > 3 * this.tickMs;
    this.ultimoTick = agora.getTime();
    const reaplicar = subida || salto;
    let sujo = false;
    for (const m of this.reg.list()) {
      if (m.status !== "ativo" || !m.ctx) continue;
      for (const t of m.def?.tarefas ?? []) {
        const cron = this.cronDe(m.id, t);
        if (!cron) continue;
        const chave = `${m.id}/${t.id}`;
        const prev = cron.prev(agora);
        const r = this.estado[chave];
        if (!r) { this.estado[chave] = { ultimaOcorrencia: prev.toISOString(), suspensa: false, errosSeguidos: 0 }; sujo = true; continue; }
        if (r.ultimaOcorrencia && prev.getTime() <= new Date(r.ultimaOcorrencia).getTime()) continue;
        // ocorrência pendente: roda, ou é só marcada como atendida (suspensa, sobreposição, subida sem recuperar)
        const pula = r.suspensa || this.emCurso.has(chave) || (reaplicar && !t.recuperar);
        if (pula) { r.ultimaOcorrencia = prev.toISOString(); sujo = true; continue; }
        void this.executar(m.id, t, prev, true);
      }
    }
    if (sujo) this.gravar();
  }

  private executar(id: string, t: Tarefa, ocorrencia: Date, automatica: boolean): Promise<ResultadoTarefa> {
    const chave = `${id}/${t.id}`;
    const ctl = new AbortController();
    const r = this.registro(chave);
    // atendida ao começar: marcador gravado ANTES de chamar rodar
    if (automatica || !r.ultimaOcorrencia) r.ultimaOcorrencia = ocorrencia.toISOString();
    r.inicio = this.agora().toISOString();
    r.fim = undefined; r.resultado = undefined; r.erro = undefined;
    this.gravar();
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
      const exec = (async () => {
        try { await t.rodar(tctx); return { resultado: "ok" } as ResultadoTarefa; }
        catch (e) { return { resultado: "erro", erro: (e instanceof Error ? e.message : String(e)).slice(0, 500), interna: e } as ResultadoTarefa & { interna: unknown }; }
      })();
      return await Promise.race([exec, limite]);
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
    this.gravar();
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
      this.crons.set(chave, { expr: t.quando, cron });
      return cron;
    } catch (e) {
      if (!this.invalidas.has(chave)) { this.invalidas.add(chave); this.reg.recordError(id, `tarefa:${t.id}`, e); }
      return undefined;
    }
  }

  private carregarSeVazio(): void { if (!this.timer && Object.keys(this.estado).length === 0) this.carregar(); }

  private carregar(): void {
    if (!existsSync(this.arq)) return;
    try {
      const v = JSON.parse(readFileSync(this.arq, "utf8")) as Record<string, Registro>;
      if (v && typeof v === "object") this.estado = v;
    } catch { /* arquivo corrompido: recomeça sem histórico (primeira subida não recupera) */ }
  }

  private gravar(): void {
    try {
      const tmp = `${this.arq}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.estado, null, 2), { mode: 0o600 });
      renameSync(tmp, this.arq);
    } catch { /* falha de disco não derruba o serve */ }
  }
}
