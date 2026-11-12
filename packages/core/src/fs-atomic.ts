import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * Escrita atômica de arquivo de estado: grava num tmp único na MESMA pasta e troca por `rename` (quem lê nunca vê um arquivo
 * vazio ou parcial). Em qualquer falha o tmp é apagado e o erro relançado. `mode` vale para o arquivo final (padrão 0600).
 */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode });
    try { chmodSync(tmp, mode); } catch { /* fs sem chmod */ }
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * Tira do caminho um arquivo de estado ilegível, preservando-o como `<arquivo>.corrompido-<AAAAMMDDTHHMMSS>-<sufixo>` para
 * diagnóstico. Devolve o novo caminho, ou `undefined` se o arquivo já não existia (outro processo o preservou antes).
 */
export function preservarCorrompido(path: string): string | undefined {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const destino = `${path}.corrompido-${ts}-${randomBytes(3).toString("hex")}`;
  try { renameSync(path, destino); return destino; } catch { return undefined; }
}
