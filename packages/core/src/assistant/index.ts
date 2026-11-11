import type { Brain } from "../brain.js";
import { CaptureLog, type CaptureEntry, type CaptureOrigin } from "./captures.js";
import type { AskResult, AssistantEngine, CaptureResult } from "./engine.js";

export * from "./captures.js";
export * from "./engine.js";
export * from "./claude-engine.js";

/**
 * Assistente (spec §7.4): a captura é gravada no registro ANTES de chamar o motor, e as capturas rodam uma por vez (fila em
 * memória). O lock de escrita do vault NÃO é segurado durante o motor: o MCP filho precisa dele para gravar as notas.
 * Perguntas não entram na fila e podem rodar em paralelo.
 */
export class Assistant {
  readonly captures: CaptureLog;
  private tail: Promise<unknown> = Promise.resolve();
  /** capturas na fila ou rodando: `retryPending` não as processa de novo */
  private readonly busy = new Set<string>();

  constructor(brain: Brain, private readonly engine: AssistantEngine) {
    this.captures = new CaptureLog(brain);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Grava (fora da fila: o texto nunca espera para ser salvo) e processa na vez dele. Em erro, a entrada fica `pendente`. */
  async capture(text: string, origin: CaptureOrigin): Promise<{ capture: CaptureEntry; result: CaptureResult }> {
    const entry = await this.captures.append(text, origin);
    this.busy.add(entry.id);
    try { return await this.serial(() => this.process(entry)); }
    finally { this.busy.delete(entry.id); }
  }

  private async process(entry: CaptureEntry): Promise<{ capture: CaptureEntry; result: CaptureResult }> {
    let result: CaptureResult;
    try { result = await this.engine.capture(entry); }
    catch (e) { result = { ok: false, tipo: "erro", mensagem: (e as Error)?.message || String(e) }; }
    if (!result.ok) return { capture: this.captures.get(entry.id) ?? entry, result };
    // só sai de `pendente`: se a captura foi desfeita enquanto o motor rodava, o estado dela não é sobrescrito
    const capture = await this.captures.markIf(entry.id, "pendente", "processada", result.notas.map((n) => n.id));
    return { capture, result };
  }

  /** Reprocessa as capturas `pendente` (uma por vez). Devolve quantas viraram `processada`. Para no primeiro erro de auth. */
  async retryPending(): Promise<number> {
    let done = 0;
    for (const e of this.captures.pending()) {
      if (this.busy.has(e.id)) continue;
      this.busy.add(e.id);
      try {
        const r = await this.serial(async () => {
          const cur = this.captures.get(e.id); // pode ter mudado enquanto esperava a vez
          return cur?.state === "pendente" ? this.process(cur) : undefined;
        });
        if (r?.result.ok) done++;
        else if (r && !r.result.ok && r.result.tipo === "auth") break; // sem login, as demais falhariam igual
      } finally { this.busy.delete(e.id); }
    }
    return done;
  }

  ask(q: string, conversationId?: string): Promise<AskResult> {
    return this.engine.ask(q, conversationId);
  }
}
