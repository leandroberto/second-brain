import { realpathSync, lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { BrainError } from "@brain/shared";

/** Resolve `rel` dentro de `root`; rejeita traversal, caminhos absolutos e symlinks que escapam. */
export function safeResolve(root: string, rel: string): string {
  if (!rel || rel.includes("\0") || isAbsolute(rel)) throw new BrainError("path_escape", `caminho inválido: ${rel}`);
  const rootReal = realpathSync(root);
  const abs = resolve(rootReal, rel);
  const r = relative(rootReal, abs);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) throw new BrainError("path_escape", `caminho fora do vault: ${rel}`);
  // verifica symlinks nos segmentos existentes
  let cur = rootReal;
  for (const seg of r.split(sep)) {
    cur = resolve(cur, seg);
    try {
      if (lstatSync(cur).isSymbolicLink()) {
        const real = realpathSync(cur);
        const rr = relative(rootReal, real);
        if (rr.startsWith("..") || isAbsolute(rr)) throw new BrainError("path_escape", `symlink escapa do vault: ${rel}`);
      }
    } catch (e) {
      if (e instanceof BrainError) throw e;
      break; // segmento ainda não existe
    }
  }
  return abs;
}

export const toPosix = (p: string): string => p.split(sep).join("/");
