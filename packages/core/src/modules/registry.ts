import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ModuleContext, ModuleDef } from "@brain/module-sdk";
import { scanSecrets } from "../secrets.js";

export type ModuleStatus = "ativo" | "falho" | "inativo" | "ausente";

export interface LoadedModule {
  id: string;
  def?: ModuleDef;
  dir: string;
  status: ModuleStatus;
  causa?: string;
  ctx?: ModuleContext;
  versao?: string;
}

export interface ModuleError { em: string; onde: string; mensagem: string }

/** Uma execução de código de módulo em curso, como gravada em `<root>/_executando.json`. */
export interface Execucao { id: string; onde: string; desde: string }

const MAX_ERROS = 50;
const MARCADOR = "_executando.json";
const MAX_MENSAGEM = 300;

/**
 * Higiene de toda mensagem de módulo que sai do processo (API, UI, doctor): truncada em 300 caracteres e trocada por
 * "[mensagem omitida: possível segredo]" se ela (inteira ou truncada) parecer conter segredo.
 */
export function mensagemSegura(mensagem: string): string {
  const t = mensagem.slice(0, MAX_MENSAGEM);
  return scanSecrets(mensagem).length || scanSecrets(t).length ? "[mensagem omitida: possível segredo]" : t;
}

/** Módulos carregados + erros de execução (rotas, tarefas, ferramentas), gravados em `<root>/_erros.jsonl` (50 últimos por módulo). */
export class ModuleRegistry {
  private readonly modules = new Map<string, LoadedModule>();
  private readonly emCurso = new Map<number, Execucao>();
  private seq = 0;
  /** `false` quando outro serve (vivo ou que não respondeu) é o dono do marcador: este registro não o grava nem apaga */
  private donoDoMarcador = true;
  constructor(private readonly root?: string) {}

  /** @internal usado pelo carregador */
  add(m: LoadedModule): void { this.modules.set(m.id, m); }
  list(): LoadedModule[] { return [...this.modules.values()]; }
  get(id: string): LoadedModule | undefined { return this.modules.get(id); }

  recordError(id: string, onde: string, e: unknown): void {
    const mensagem = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    if (!this.root) return;
    const arq = join(this.root, "_erros.jsonl");
    const linha = JSON.stringify({ id, em: new Date().toISOString(), onde, mensagem });
    try {
      appendFileSync(arq, `${linha}\n`, { mode: 0o600 });
      this.compactar(arq);
    } catch { /* erro ao registrar erro nunca derruba o módulo nem o serve */ }
  }

  errors(id: string): ModuleError[] {
    return this.ler().filter((l) => l.id === id).map(({ em, onde, mensagem }) => ({ em, onde, mensagem }));
  }

  /**
   * Os `n` erros mais recentes, em ordem cronológica (o último é o mais novo), prontos para sair do processo (API, doctor):
   * mensagem truncada em 300 caracteres e omitida se parecer conter segredo.
   */
  errosRecentes(id: string, n = 10): ModuleError[] {
    return this.errors(id).slice(-n).map((e) => ({ ...e, mensagem: mensagemSegura(e.mensagem) }));
  }

  /**
   * Roda código de módulo (handler de rota, ferramenta `_mcp`, `iniciar`, tarefa) com o marcador `<root>/_executando.json`
   * gravado antes e atualizado no fim (spec §7.12). Execuções concorrentes: o marcador guarda a LISTA das que estão em curso
   * (`[{ id, onde, desde }]`) e some quando a lista esvazia. Se o processo cair no meio (laço infinito, `process.exit`), o
   * marcador fica e a próxima subida o converte em erro (`recuperarExecucoesInterrompidas`).
   */
  async executando<T>(id: string, onde: string, fn: () => Promise<T> | T): Promise<T> {
    if (!this.root) return fn();
    const n = ++this.seq;
    this.emCurso.set(n, { id, onde, desde: new Date().toISOString() });
    this.gravarMarcador();
    try { return await fn(); }
    finally { this.emCurso.delete(n); this.gravarMarcador(); }
  }

  /** Na subida do `serve`: cada execução que ficou no marcador vira erro do módulo ("o serve caiu enquanto…") e o arquivo é apagado. */
  recuperarExecucoesInterrompidas(): void {
    if (!this.root || !this.donoDoMarcador) return;
    const arq = join(this.root, MARCADOR);
    if (!existsSync(arq)) return;
    let v: unknown;
    try { v = JSON.parse(readFileSync(arq, "utf8")); } catch { v = []; }
    for (const e of Array.isArray(v) ? v : [v]) {
      const { id, onde } = (e ?? {}) as Partial<Execucao>;
      if (typeof id === "string" && typeof onde === "string") this.recordError(id, onde, new Error(`o serve caiu enquanto ${id} executava ${onde}`));
    }
    try { rmSync(arq, { force: true }); } catch { /* best effort */ }
  }

  /** Outro serve ainda pode estar vivo: as execuções deste registro não tocam no `_executando.json` dele. */
  desligarMarcador(): void { this.donoDoMarcador = false; }

  /** Desligamento ordenado: o que ainda roda (tarefa que estourou o tempo e não respeitou o sinal) não é queda; apaga o marcador. */
  encerrarExecucoes(): void {
    this.emCurso.clear();
    this.gravarMarcador();
  }

  private gravarMarcador(): void {
    if (!this.root || !this.donoDoMarcador) return;
    const arq = join(this.root, MARCADOR);
    try {
      if (!this.emCurso.size) { rmSync(arq, { force: true }); return; }
      const tmp = `${arq}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.emCurso.values()]), { mode: 0o600 });
      renameSync(tmp, arq);
    } catch { /* o marcador é diagnóstico: falha de disco nunca impede a execução */ }
  }

  private ler(): Array<ModuleError & { id: string }> {
    if (!this.root) return [];
    const arq = join(this.root, "_erros.jsonl");
    if (!existsSync(arq)) return [];
    const out: Array<ModuleError & { id: string }> = [];
    for (const l of readFileSync(arq, "utf8").split("\n")) {
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch { /* linha parcial */ }
    }
    return out;
  }

  /** mantém só os 50 últimos de cada módulo (reescreve só quando passa do limite) */
  private compactar(arq: string): void {
    const todas = this.ler();
    const cont = new Map<string, number>();
    for (const l of todas) cont.set(l.id, (cont.get(l.id) ?? 0) + 1);
    if (![...cont.values()].some((n) => n > MAX_ERROS)) return;
    const resto = new Map(cont);
    const mantidas = todas.filter((l) => { const n = resto.get(l.id)!; resto.set(l.id, n - 1); return n <= MAX_ERROS; });
    writeFileSync(arq, mantidas.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
  }
}
