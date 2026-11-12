import { chmodSync, lstatSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

/**
 * Destino real da escrita: se `path` é um symlink, o arquivo para onde ele aponta (o `rename` sobre o link o trocaria por um
 * arquivo regular). Link pendente (alvo ainda inexistente): o alvo resolvido a partir da pasta do link.
 */
function destinoReal(path: string): string {
  let link: boolean;
  try { link = lstatSync(path).isSymbolicLink(); } catch { return path; } // não existe: grava no próprio caminho
  if (!link) return path;
  try { return realpathSync(path); } catch { return resolve(dirname(path), readlinkSync(path)); }
}

/**
 * Escrita atômica de arquivo de estado: grava num tmp único na MESMA pasta do destino real e troca por `rename` (quem lê nunca
 * vê um arquivo vazio ou parcial). Se `path` é um symlink, o alvo dele é que é substituído e o link continua link. Em qualquer
 * falha o tmp é apagado e o erro relançado. `mode` vale para o arquivo final (padrão 0600).
 */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const alvo = destinoReal(path);
  const tmp = `${alvo}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode });
    try { chmodSync(tmp, mode); } catch { /* fs sem chmod */ }
    renameSync(tmp, alvo);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * Tira do caminho um arquivo de estado ilegível, preservando-o como `<arquivo>.corrompido-<AAAAMMDDTHHMMSS>-<sufixo>` para
 * diagnóstico. Devolve o novo caminho, ou `undefined` se o arquivo já não existia (outro processo o preservou antes). Qualquer
 * outra falha LANÇA: quem chama não pode gravar por cima de um arquivo que não foi preservado.
 */
export function preservarCorrompido(path: string): string | undefined {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const destino = `${path}.corrompido-${ts}-${randomBytes(3).toString("hex")}`;
  try { renameSync(path, destino); return destino; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
