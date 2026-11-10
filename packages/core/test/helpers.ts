import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@brain/shared";
import { Brain, humanFromTerminal, principal } from "../src/index.js";

export const dirs: string[] = [];
export async function tempBrain(): Promise<Brain> {
  const d = mkdtempSync(join(tmpdir(), "brain-test-"));
  dirs.push(d);
  return Brain.init(join(d, "vault"));
}
export const cleanup = () => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); };
/**
 * Revisor humano de TESTE: a identidade humana só nasce de um terminal real (ou de uma sessão emitida por ele); aqui o TTY é
 * simulado só durante a cunhagem, com um armazenamento de sessões/frase-senha temporário (nunca o do usuário).
 */
export async function terminalHuman(name = "alice", sessions = { file: join(tmpdir(), `brain-test-sessions-${process.pid}-${Math.random().toString(36).slice(2)}.json`) }): Promise<Principal> {
  const prev = [Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), Object.getOwnPropertyDescriptor(process.stdout, "isTTY")];
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true }); Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try { return await humanFromTerminal({ ask: async () => "", user: name, sessions }, "teste"); }
  finally {
    for (const [i, stream] of [process.stdin, process.stdout].entries()) { const d = prev[i]; if (d) Object.defineProperty(stream, "isTTY", d); else delete (stream as { isTTY?: boolean }).isTTY; }
  }
}
// identidades CUNHADAS (como os adapters fazem): objetos literais não são aceitos pelo Core
export const human = await terminalHuman();
export const claude = principal("agent", "claude-code", "mcp");
export const codex = principal("agent", "codex", "mcp");
export const importer = principal("system", "import", "importer");
