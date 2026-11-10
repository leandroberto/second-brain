import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { BrainError } from "@brain/shared";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Owner { pid: number; at: number; token: string }

/**
 * Lock exclusivo entre processos (MCP do Claude, MCP do Codex, API) via mkdir atômico.
 * - O dono renova um heartbeat; um lock só é considerado órfão se o PID morreu OU se o heartbeat parou por > staleMs.
 *   Um dono vivo e ativo nunca perde o lock só por demorar.
 * - A liberação só remove o lock se ele ainda pertence a este dono (token), então nunca apaga o lock de um sucessor.
 */
export async function withFileLock<T>(
  lockDir: string, fn: () => Promise<T> | T,
  opts: { timeoutMs?: number; staleMs?: number; heartbeatMs?: number } = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? 15_000;
  const stale = opts.staleMs ?? 30_000;
  const beat = opts.heartbeatMs ?? 3_000;
  const start = Date.now();
  const token = randomBytes(8).toString("hex");
  mkdirSync(dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeOwner(lockDir, { pid: process.pid, at: Date.now(), token });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (isStale(lockDir, stale)) { steal(lockDir, token, stale); continue; }
      if (Date.now() - start > timeout) throw new BrainError("locked", "vault ocupado por outra operação (timeout do lock)");
      await sleep(15 + Math.random() * 35);
    }
  }
  const hb = setInterval(() => { if (readOwner(lockDir)?.token === token) writeOwner(lockDir, { pid: process.pid, at: Date.now(), token }); }, beat);
  hb.unref?.();
  try { return await fn(); }
  finally {
    clearInterval(hb);
    if (readOwner(lockDir)?.token === token) rmSync(lockDir, { recursive: true, force: true });
  }
}

/** Publicação atômica (tmp + rename): quem lê nunca vê um JSON parcial. */
function writeOwner(lockDir: string, o: Owner) { try { const t = `${lockDir}/owner.${o.token}.tmp`; writeFileSync(t, JSON.stringify(o)); renameSync(t, `${lockDir}/owner`); } catch { /* lock removido por terceiro */ } }
function readOwner(lockDir: string): Owner | undefined {
  for (let i = 0; i < 3; i++) { try { return JSON.parse(readFileSync(`${lockDir}/owner`, "utf8")) as Owner; } catch { /* tenta de novo: pode estar sendo renomeado */ } }
  return undefined;
}

/** Roubo seguro: re-checa e usa rename (só UM concorrente vence); depois apaga a cópia morta. */
function steal(lockDir: string, token: string, staleMs: number): void {
  if (!isStale(lockDir, staleMs)) return;
  const dead = `${lockDir}.dead.${token}`;
  try { renameSync(lockDir, dead); } catch { return; } // outro já roubou/liberou
  rmSync(dead, { recursive: true, force: true });
}

function isStale(lockDir: string, staleMs: number): boolean {
  const o = readOwner(lockDir);
  if (!o) { try { return Date.now() - statSync(lockDir).mtimeMs > 2_000; } catch { return false; } }
  try { process.kill(o.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return true; }
  return Date.now() - o.at > staleMs; // heartbeat parado: dono travado
}
