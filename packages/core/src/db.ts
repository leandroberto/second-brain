import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ActivityEntry, Actor, Note, NoteType, NoteStatus } from "@brain/shared";

const SCHEMA_VERSION = 2; // 2: coluna freshness (verification.state)

export interface NoteRow {
  id: string; path: string; title: string; type: NoteType; status: NoteStatus; project: string | null;
  tags: string; created_at: string; updated_at: string; body: string; revision: string;
  created_by: string | null; issues: string; mtime: number; size: number;
  /** verification.state da nota (null = sem verificação = tratada como atual) */
  freshness: string | null;
}

/** Índice derivado (reconstruível a partir do Markdown). Nunca é fonte de verdade. */
export class IndexDb {
  readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
    this.migrate();
  }
  close(): void { this.db.close(); }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const v = Number(this.getMeta("schema_version") ?? 0);
    if (v === SCHEMA_VERSION) return;
    // índice é descartável: em qualquer mudança de versão, recria tudo.
    this.db.exec(`
      DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS links;
      DROP TABLE IF EXISTS embeddings; DROP TABLE IF EXISTS dupes;
      CREATE TABLE notes(
        id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL,
        status TEXT NOT NULL, project TEXT, tags TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, body TEXT NOT NULL, revision TEXT NOT NULL, created_by TEXT,
        issues TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, freshness TEXT);
      CREATE INDEX notes_project ON notes(project); CREATE INDEX notes_type ON notes(type);
      CREATE INDEX notes_updated ON notes(updated_at);
      CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, title, tags, body, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE links(src TEXT NOT NULL, dst TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY(src,dst,type));
      CREATE INDEX links_dst ON links(dst);
      CREATE TABLE embeddings(id TEXT PRIMARY KEY, revision TEXT NOT NULL, provider TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL);
      CREATE TABLE dupes(path TEXT PRIMARY KEY, id TEXT NOT NULL);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity(
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor_kind TEXT NOT NULL,
        actor_name TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT, detail TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts);
      CREATE INDEX IF NOT EXISTS activity_target ON activity(target_id);
    `);
    this.setMeta("schema_version", String(SCHEMA_VERSION));
  }

  getMeta(k: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(k) as { value: string } | undefined;
    return r?.value;
  }
  setMeta(k: string, v: string): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.db.exec("COMMIT"); return r; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  upsertNote(n: Note, st: { mtime: number; size: number }, issues: string[]): void {
    this.tx(() => {
      const old = this.db.prepare("SELECT id FROM notes WHERE path=?").get(n.path) as { id: string } | undefined;
      if (old && old.id !== n.id) this.removeById(old.id);
      this.db.prepare(`INSERT INTO notes(id,path,title,type,status,project,tags,created_at,updated_at,body,revision,created_by,issues,mtime,size,freshness)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET path=excluded.path,title=excluded.title,type=excluded.type,status=excluded.status,
          project=excluded.project,tags=excluded.tags,created_at=excluded.created_at,updated_at=excluded.updated_at,
          body=excluded.body,revision=excluded.revision,created_by=excluded.created_by,issues=excluded.issues,mtime=excluded.mtime,size=excluded.size,freshness=excluded.freshness`)
        .run(n.id, n.path, n.title, n.type, n.status, n.project ?? null, JSON.stringify(n.tags), n.created_at, n.updated_at,
          n.body, n.revision, n.created_by ? JSON.stringify(n.created_by) : null, JSON.stringify(issues), st.mtime, st.size, n.verification?.state ?? null);
      this.db.prepare("DELETE FROM fts WHERE id=?").run(n.id);
      this.db.prepare("INSERT INTO fts(id,title,tags,body) VALUES(?,?,?,?)").run(n.id, n.title, n.tags.join(" "), n.body);
      this.db.prepare("DELETE FROM links WHERE src=?").run(n.id);
      const ins = this.db.prepare("INSERT OR IGNORE INTO links(src,dst,type) VALUES(?,?,?)");
      for (const [t, ids] of Object.entries(n.relations)) for (const d of ids ?? []) ins.run(n.id, d, t);
    });
  }

  addLinks(src: string, links: Array<{ dst: string; type: string }>): void {
    const ins = this.db.prepare("INSERT OR IGNORE INTO links(src,dst,type) VALUES(?,?,?)");
    for (const l of links) ins.run(src, l.dst, l.type);
  }

  removeById(id: string): void {
    this.db.prepare("DELETE FROM notes WHERE id=?").run(id);
    this.db.prepare("DELETE FROM fts WHERE id=?").run(id);
    this.db.prepare("DELETE FROM links WHERE src=?").run(id);
    this.db.prepare("DELETE FROM embeddings WHERE id=?").run(id);
  }

  allStat(): Map<string, { id: string; mtime: number; size: number; revision: string }> {
    const rows = this.db.prepare("SELECT path,id,mtime,size,revision FROM notes").all() as Array<{ path: string; id: string; mtime: number; size: number; revision: string }>;
    return new Map(rows.map((r) => [r.path, r]));
  }

  getRow(id: string): NoteRow | undefined {
    return this.db.prepare("SELECT * FROM notes WHERE id=?").get(id) as NoteRow | undefined;
  }
  rows(where = "1=1", params: Array<string | number> = [], order = "updated_at DESC", limit = 500): NoteRow[] {
    return this.db.prepare(`SELECT * FROM notes WHERE ${where} ORDER BY ${order} LIMIT ${limit}`).all(...params) as unknown as NoteRow[];
  }

  setEmbedding(id: string, revision: string, provider: string, v: Float32Array): void {
    this.db.prepare("INSERT INTO embeddings(id,revision,provider,dim,vec) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,provider=excluded.provider,dim=excluded.dim,vec=excluded.vec")
      .run(id, revision, provider, v.length, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  embeddings(provider: string): Array<{ id: string; revision: string; vec: Float32Array }> {
    const rows = this.db.prepare("SELECT id,revision,vec FROM embeddings WHERE provider=?").all(provider) as Array<{ id: string; revision: string; vec: Uint8Array }>;
    return rows.map((r) => ({ id: r.id, revision: r.revision, vec: new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)) }));
  }

  // ---- atividade operacional (não vai para o Git) ----
  log(actor: Actor, action: string, target: string | null, detail: Record<string, unknown> = {}): void {
    this.db.prepare("INSERT INTO activity(ts,actor_kind,actor_name,action,target_id,detail) VALUES(?,?,?,?,?,?)")
      .run(new Date().toISOString(), actor.kind, actor.name, action, target, JSON.stringify(detail));
  }
  activity(opts: { limit?: number; since?: string; action?: string; target?: string; actor?: string } = {}): ActivityEntry[] {
    const w: string[] = []; const p: Array<string | number> = [];
    if (opts.since) { w.push("ts>=?"); p.push(opts.since); }
    if (opts.action) { w.push("action=?"); p.push(opts.action); }
    if (opts.target) { w.push("target_id=?"); p.push(opts.target); }
    if (opts.actor) { w.push("actor_name=?"); p.push(opts.actor); }
    const rows = this.db.prepare(`SELECT * FROM activity ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY id DESC LIMIT ${opts.limit ?? 100}`).all(...p) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...(r as unknown as ActivityEntry), detail: JSON.parse(String(r.detail)) as Record<string, unknown> }));
  }
  pruneActivity(days: number): void {
    this.db.prepare("DELETE FROM activity WHERE ts < ?").run(new Date(Date.now() - days * 864e5).toISOString());
  }
}
