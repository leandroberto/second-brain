import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrainError } from "@brain/shared";
import type { Brain } from "../brain.js";
import { redactSecrets } from "../secrets.js";

/**
 * Registro de capturas (spec §7.4): todo texto ditado é gravado em `<vault>/.brain/captures/AAAA-MM.md` ANTES de qualquer
 * chamada ao motor, no formato do `_entrada` do app antigo:
 *
 *     ### 20261110-153012-a1b2 · processada → nota-a, nota-b
 *     origem: desktop
 *     ~~~~
 *     texto exatamente como foi ditado
 *     ~~~~
 *
 * A cerca cresce quando o texto tem uma linha começando com `~~~~`. Entradas migradas do `_entrada` (sem a linha `origem:`,
 * às vezes com linha em branco antes da cerca, ids como caminhos `pasta/nota.md`) continuam legíveis; sem `origem:`, a
 * entrada veio do atalho desktop antigo. Toda gravação acontece sob o lock de escrita do vault e é commitada.
 */
export type CaptureState = "pendente" | "processada" | "desfeita";
export type CaptureOrigin = "desktop" | "ui";
export interface CaptureEntry { id: string; text: string; origin: CaptureOrigin; state: CaptureState; ids: string[] }

export const CAPTURES_DIR = ".brain/captures";
/** Marcador de segredo omitido (mesmo texto que as regras do assistente usam). */
export const SECRET_MASK = "[SENHA OMITIDA]";
export const CAPTURE_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

const STATES: readonly CaptureState[] = ["pendente", "processada", "desfeita"];
const ORIGINS: readonly CaptureOrigin[] = ["desktop", "ui"];
const HEADER = /^### (\d{8}-\d{6}-[0-9a-f]{4}) · (pendente|processada|desfeita)(?: → (.*))?$/;
const ORIGIN_LINE = /^origem: (desktop|ui)$/;
const FENCE = /^(~{4,})$/;
/** Um id no cabeçalho não pode quebrar o formato (vírgula separa, quebra de linha forjaria outro bloco). */
const SAFE_REF = /^[^\s,]{1,200}$/;

const two = (n: number) => String(n).padStart(2, "0");

/** `AAAAMMDD-HHMMSS-xxxx`, na hora local (como o `_entrada`). */
export function newCaptureId(now: Date = new Date()): string {
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}-${randomBytes(2).toString("hex")}`;
}

const fileOf = (id: string) => `${CAPTURES_DIR}/${id.slice(0, 4)}-${id.slice(4, 6)}.md`;

function fenceFor(text: string): string {
  let longest = 0;
  for (const line of text.split("\n")) longest = Math.max(longest, /^~*/.exec(line)![0].length);
  return "~".repeat(Math.max(4, longest + 1));
}

function blockLines(e: CaptureEntry): string[] {
  const fence = fenceFor(e.text);
  return [`### ${e.id} · ${e.ids.length ? `${e.state} → ${e.ids.join(", ")}` : e.state}`, `origem: ${e.origin}`, fence, ...e.text.split("\n"), fence];
}

/** Valida os argumentos de uma marcação; devolve os ids normalizados (ou `undefined` para manter os atuais). */
function checkMark(id: string, state: CaptureState, ids?: string[]): string[] | undefined {
  if (!STATES.includes(state)) throw new BrainError("invalid", `estado inválido: ${String(state)}`);
  const refs = ids?.map((s) => s.trim()).filter(Boolean);
  if (refs?.some((r) => !SAFE_REF.test(r))) throw new BrainError("invalid", "id inválido para o registro de capturas");
  if (!CAPTURE_ID.test(id)) throw new BrainError("not_found", `captura ${id} não existe`);
  return refs;
}

interface Located { entry: CaptureEntry; start: number; end: number }

function parse(content: string): { lines: string[]; blocks: Located[] } {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: Located[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = HEADER.exec(lines[i]!);
    if (!head) continue;
    let j = i + 1;
    const skipBlank = () => { while (j < lines.length && lines[j]!.trim() === "") j++; };
    skipBlank();
    const origin = ORIGIN_LINE.exec(lines[j] ?? "");
    if (origin) { j++; skipBlank(); }
    const open = FENCE.exec(lines[j] ?? "");
    if (!open) continue;
    let k = j + 1;
    while (k < lines.length && lines[k] !== open[1]) k++;
    if (k >= lines.length) break; // bloco sem fechamento: ignora o resto
    blocks.push({
      entry: {
        id: head[1]!, state: head[2] as CaptureState, origin: (origin?.[1] as CaptureOrigin | undefined) ?? "desktop",
        ids: head[3] ? head[3].split(",").map((s) => s.trim()).filter(Boolean) : [],
        text: lines.slice(j + 1, k).join("\n"),
      },
      start: i, end: k,
    });
    i = k;
  }
  return { lines, blocks };
}

export class CaptureLog {
  constructor(private readonly brain: Brain) {}

  private read(rel: string): string | undefined {
    try { return readFileSync(join(this.brain.vault.root, rel), "utf8"); } catch { return undefined; }
  }

  private async commit(rel: string, message: string): Promise<void> {
    if (!this.brain.config.git.auto_commit) return;
    await this.brain.git.commitPaths([rel], message);
  }

  /**
   * Grava o texto como `pendente` e commita. Segredos que o filtro do core reconhece viram `[SENHA OMITIDA]` antes de
   * tocar o disco: o registro é versionado e o texto também vai ao motor.
   */
  async append(text: string, origin: CaptureOrigin): Promise<CaptureEntry> {
    if (typeof text !== "string" || !text.trim()) throw new BrainError("invalid", "texto da captura vazio");
    if (!ORIGINS.includes(origin)) throw new BrainError("invalid", `origem inválida: ${String(origin)}`);
    const clean = redactSecrets(text.replace(/\r\n/g, "\n"), SECRET_MASK);
    return this.brain.withWriteLock(async () => {
      let id = newCaptureId();
      while (this.get(id)) id = newCaptureId();
      const entry: CaptureEntry = { id, text: clean, origin, state: "pendente", ids: [] };
      const rel = fileOf(id);
      const current = (this.read(rel) ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
      this.brain.vault.writeAtomic(rel, `${current ? `${current}\n\n` : ""}${blockLines(entry).join("\n")}\n`);
      await this.commit(rel, `brain: capture ${id} (pendente)\n\nBrain-Capture: ${id}`);
      return entry;
    });
  }

  /** Muda o estado (e, se informados, os ids) de uma entrada, preservando o resto do arquivo. Sem `ids`, mantém os atuais. */
  async mark(id: string, state: CaptureState, ids?: string[]): Promise<CaptureEntry> {
    const refs = checkMark(id, state, ids);
    return this.brain.withWriteLock(() => this.write(id, state, refs));
  }

  /**
   * Como `mark`, mas só se a entrada ainda estiver em `from` (conferido e gravado sob o lock). Senão devolve a entrada como
   * está, sem gravar: o motor não sobrescreve uma captura `desfeita` enquanto ele rodava.
   */
  async markIf(id: string, from: CaptureState, state: CaptureState, ids?: string[]): Promise<CaptureEntry> {
    const refs = checkMark(id, state, ids);
    return this.brain.withWriteLock(async () => {
      const cur = this.get(id);
      if (!cur) throw new BrainError("not_found", `captura ${id} não existe`);
      return cur.state === from ? this.write(id, state, refs) : cur;
    });
  }

  /** Como `mark`, para quem JÁ segura o lock de escrita do vault (ex.: `Brain.undoCapture`; o lock não é reentrante). */
  markLocked(id: string, state: CaptureState, ids?: string[]): Promise<CaptureEntry> {
    return this.write(id, state, checkMark(id, state, ids));
  }

  private async write(id: string, state: CaptureState, refs: string[] | undefined): Promise<CaptureEntry> {
    const rel = fileOf(id);
    const { lines, blocks } = parse(this.read(rel) ?? "");
    const found = blocks.find((b) => b.entry.id === id);
    if (!found) throw new BrainError("not_found", `captura ${id} não existe`);
    const next: CaptureEntry = { ...found.entry, state, ids: refs ?? found.entry.ids };
    this.brain.vault.writeAtomic(rel, [...lines.slice(0, found.start), ...blockLines(next), ...lines.slice(found.end + 1)].join("\n"));
    await this.commit(rel, `brain: capture ${id} → ${state}\n\nBrain-Capture: ${id}`);
    return next;
  }

  get(id: string): CaptureEntry | undefined {
    if (!CAPTURE_ID.test(id)) return undefined;
    const content = this.read(fileOf(id));
    return content === undefined ? undefined : parse(content).blocks.find((b) => b.entry.id === id)?.entry;
  }

  /** Entradas `pendente`, da mais antiga para a mais nova. */
  pending(): CaptureEntry[] {
    let names: string[];
    try { names = readdirSync(join(this.brain.vault.root, CAPTURES_DIR)); } catch { return []; }
    const out: CaptureEntry[] = [];
    for (const name of names.filter((n) => /^\d{4}-\d{2}\.md$/.test(n)).sort()) {
      const content = this.read(`${CAPTURES_DIR}/${name}`);
      if (content !== undefined) out.push(...parse(content).blocks.map((b) => b.entry).filter((e) => e.state === "pendente"));
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
}
