import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Freshness } from "@brain/shared";
import { reconcile } from "./reconcile.js";
import { gitTopLevel, repoIndex, type RepoIndex, type RepoLimits } from "./repo.js";

export { reconcile, wantsHistory, type ReconcileInput } from "./reconcile.js";
export { repoIndex, clearRepoCache, safeGit, parseAdr, type RepoIndex } from "./repo.js";
export { anchorsOf, changeSide, sourceKindOf, isPlanLanguage } from "./semantics.js";

export interface BatchResult { results: Array<Freshness | undefined>; index?: RepoIndex; ms: number; repoMs?: number }

/**
 * Reconcilia um LOTE de candidatos da mesma fonte: UMA varredura do repositório (cacheada por HEAD) e N reconciliações baratas.
 * `scanRoot` é a raiz usada pelo importador; caminhos dos candidatos são relativos a ela e são convertidos para a raiz do git.
 * Somente leitura: nada no repositório importado é escrito ou executado.
 */
export async function reconcileBatch(items: Array<{ title: string; body: string; path?: string; heading?: string; origin?: "imported" | "agent" | "human"; asOf?: string }>, opts: { scanRoot?: string; ignore?: string[]; limits?: Partial<RepoLimits> } = {}): Promise<BatchResult> {
  const t0 = Date.now();
  let index: RepoIndex | undefined; let prefix = "";
  if (opts.scanRoot) {
    const top = await gitTopLevel(opts.scanRoot);
    if (top) { index = await repoIndex(top, opts.limits); prefix = relative(top, resolve(opts.scanRoot)); }
  }
  const repoMs = Date.now() - t0;
  const results: Array<Freshness | undefined> = [];
  for (const it of items) {
    const path = it.path && !/^commit /.test(it.path) && it.path !== "paste" ? (prefix ? `${prefix}/${it.path}` : it.path) : undefined;
    // fonte que não está no HEAD mas existe na árvore de trabalho (documento não versionado): lida só para semântica/crases
    const wt = index?.head && path && !index.headPaths.has(path) ? workingTreeDoc(index.root, path) : undefined;
    try { results.push(await reconcile({ ...it, path, ...(wt !== undefined ? { docText: wt, untracked: true } : {}) }, { index, ignore: opts.ignore })); } catch { results.push(undefined); }
  }
  return { results, index, ms: Date.now() - t0, repoMs };
}

/** Lê um documento da árvore de trabalho com as mesmas proteções do importador: sem symlink, dentro da raiz, ≤ 400 KB. */
function workingTreeDoc(root: string, rel: string): string | undefined {
  if (!/\.(md|mdx|markdown|txt)$/i.test(rel)) return undefined;
  try {
    const abs = join(root, rel); const st = lstatSync(abs);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 400_000) return undefined;
    const real = realpathSync(abs); if (!real.startsWith(realpathSync(root) + "/")) return undefined;
    return readFileSync(real, "utf8");
  } catch { return undefined; }
}
