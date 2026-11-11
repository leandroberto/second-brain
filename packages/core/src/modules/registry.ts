import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleContext, ModuleDef } from "@brain/module-sdk";

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

const MAX_ERROS = 50;

/** Módulos carregados + erros de execução (rotas, tarefas, ferramentas), gravados em `<root>/_erros.jsonl` (50 últimos por módulo). */
export class ModuleRegistry {
  private readonly modules = new Map<string, LoadedModule>();
  constructor(private readonly root?: string) {}

  /** @internal usado pelo carregador */
  add(m: LoadedModule): void { this.modules.set(m.id, m); }
  list(): LoadedModule[] { return [...this.modules.values()]; }
  get(id: string): LoadedModule | undefined { return this.modules.get(id); }

  markFailed(id: string, causa: string): void {
    const m = this.modules.get(id);
    if (m) { m.status = "falho"; m.causa = causa; }
  }

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
