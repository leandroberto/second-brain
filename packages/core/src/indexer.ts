import type { Note } from "@brain/shared";
import type { IndexDb } from "./db.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { parseNote, extractWikilinks } from "./markdown.js";
import { redactSecrets, scanSecrets } from "./secrets.js";
import { plain } from "./text.js";
import type { Vault } from "./vault.js";

export interface SyncResult { added: string[]; changed: string[]; removed: string[]; duplicates: string[]; embedded: number }

/** Nota editada à mão com segredo: é indexada MASCARADA (nunca vai ao FTS/embeddings/agentes) e sinalizada para limpeza. */
function quarantine(note: Note, issues: string[]): void {
  const found = scanSecrets(`${note.title}\n${note.body}`);
  if (!found.length) return;
  issues.push(`segredo detectado (${[...new Set(found.map((f) => f.kind))].join(", ")}) — mascarado no índice e fora dos commits; remova do arquivo`);
  note.body = redactSecrets(note.body); note.title = redactSecrets(note.title);
}

export const embedText = (n: Pick<Note, "title" | "tags" | "body">): string =>
  `${n.title}\n${n.tags.join(" ")}\n${plain(n.body)}`.slice(0, 6000);

/** Só LÊ o Markdown e escreve no SQLite. Nunca escreve no vault => sem loop watcher->index->write. */
export class Indexer {
  private inflight?: Promise<SyncResult>;
  private lastSync = 0;
  constructor(private vault: Vault, private db: IndexDb, private embedder: () => EmbeddingProvider) {}

  async sync(opts: { force?: boolean; maxAgeMs?: number } = {}): Promise<SyncResult> {
    if (!opts.force && Date.now() - this.lastSync < (opts.maxAgeMs ?? 0)) return { added: [], changed: [], removed: [], duplicates: [], embedded: 0 };
    if (this.inflight) return this.inflight;
    this.inflight = this.doSync(opts.force ?? false).finally(() => { this.inflight = undefined; this.lastSync = Date.now(); });
    return this.inflight;
  }

  private async doSync(force: boolean): Promise<SyncResult> {
    const res: SyncResult = { added: [], changed: [], removed: [], duplicates: [], embedded: 0 };
    const known = this.db.allStat();
    const files = this.vault.listFiles();
    const seen = new Set(files);
    this.db.db.prepare("DELETE FROM dupes").run();
    for (const rel of files) {
      let st; try { st = this.vault.stat(rel); } catch { continue; }
      const prev = known.get(rel);
      if (!force && prev && prev.mtime === st.mtime && prev.size === st.size) continue;
      let raw: string; try { raw = this.vault.readRaw(rel); } catch { continue; }
      const { note, issues } = parseNote(raw, rel, new Date(st.mtime).toISOString());
      quarantine(note, issues);
      if (prev && prev.revision === note.revision && !force) {
        this.db.db.prepare("UPDATE notes SET mtime=?, size=? WHERE path=?").run(st.mtime, st.size, rel);
        continue;
      }
      const other = this.db.getRow(note.id);
      if (other && other.path !== rel && this.vault.fileExists(other.path)) {
        issues.push(`id duplicado também em ${other.path}`);
        this.db.db.prepare("INSERT OR REPLACE INTO dupes(path,id) VALUES(?,?)").run(rel, note.id);
        res.duplicates.push(rel);
        continue;
      }
      try {
        this.db.upsertNote(note, st, issues);
        const wl = extractWikilinks(note.body).map((d) => ({ dst: d, type: "link" }));
        if (wl.length) this.db.addLinks(note.id, wl);
        (prev ? res.changed : res.added).push(note.id);
      } catch (e) { console.error(`[brain] falha ao indexar ${rel}: ${(e as Error).message}`); }
    }
    for (const [path, r] of known) {
      if (seen.has(path)) continue;
      // renomeada/movida: o mesmo id já foi reindexado em outro caminho; não remover
      if (this.db.getRow(r.id)?.path !== path) continue;
      this.db.removeById(r.id); res.removed.push(r.id);
    }
    res.embedded = await this.embedMissing();
    return res;
  }

  /** Indexa um arquivo recém-escrito pelo próprio Core (evita esperar o próximo scan). */
  async indexPath(rel: string): Promise<Note> {
    const st = this.vault.stat(rel);
    const { note, issues } = parseNote(this.vault.readRaw(rel), rel, new Date(st.mtime).toISOString());
    quarantine(note, issues);
    this.db.upsertNote(note, st, issues);
    const wl = extractWikilinks(note.body).map((d) => ({ dst: d, type: "link" }));
    if (wl.length) this.db.addLinks(note.id, wl);
    await this.embedMissing();
    return note;
  }

  async embedMissing(): Promise<number> {
    const prov = this.embedder();
    const have = new Map(this.db.embeddings(prov.id).map((e) => [e.id, e.revision]));
    const todo = this.db.rows("1=1", [], "id", 100000).filter((r) => have.get(r.id) !== r.revision && !r.issues.includes("segredo"));
    if (!todo.length) return 0;
    let done = 0;
    for (let i = 0; i < todo.length; i += 32) {
      const batch = todo.slice(i, i + 32);
      let vecs: Float32Array[];
      // falha do provider (rede, chave, cota) NUNCA derruba uma escrita: a base segue funcionando por texto (FTS5)
      try { vecs = await prov.embed(batch.map((r) => embedText({ title: r.title, tags: JSON.parse(r.tags) as string[], body: r.body }))); }
      catch (e) { this.db.setMeta("embed_error", `${new Date().toISOString()} ${(e as Error).message}`.slice(0, 300)); console.error(`[brain] embeddings indisponíveis (${prov.id}): ${(e as Error).message}`); break; }
      this.db.tx(() => batch.forEach((r, k) => { this.db.setEmbedding(r.id, r.revision, prov.id, vecs[k]!); done++; }));
    }
    this.db.setMeta("emb_gen", String(Date.now()) + Math.random().toString(36).slice(2, 6));
    return done;
  }
}
