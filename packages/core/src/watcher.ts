import { watch, type FSWatcher } from "node:fs";
import type { Brain } from "./brain.js";
import type { SyncResult } from "./indexer.js";

/**
 * Observa `knowledge/` e reindexa edições manuais (Obsidian). O indexador só lê arquivos e grava no SQLite,
 * portanto não há realimentação: a escrita do Core gera um evento cujo sync resulta em no-op (mesma revision).
 */
export function watchVault(brain: Brain, onSync: (r: SyncResult) => void, debounceMs = 400): { close(): void } {
  let timer: NodeJS.Timeout | undefined; let w: FSWatcher | undefined;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const r = await brain.sync({ force: false });
        if (r.added.length || r.changed.length || r.removed.length) {
          for (const id of [...r.added, ...r.changed]) brain.db.log({ kind: "human", name: "external-edit" }, "external_edit", id);
          if (brain.config.git.auto_commit_external) await brain.commitExternalEdits();
          onSync(r);
        }
      } catch (e) { console.error("[brain] watcher sync falhou:", (e as Error).message); }
    }, debounceMs);
  };
  try { w = watch(brain.vault.knowledgeDir, { recursive: true }, (_e, name) => { if (!name || String(name).endsWith(".md") || !String(name).includes(".")) run(); }); }
  catch (e) { console.error("[brain] fs.watch indisponível; usando polling:", (e as Error).message); }
  const poll = setInterval(run, 5000); // rede de segurança (ex.: eventos perdidos)
  return { close() { clearTimeout(timer); clearInterval(poll); w?.close(); } };
}
