import type { NoteStatus, NoteType, SearchHit, SimilarMatch } from "@brain/shared";
import type { IndexDb, NoteRow } from "./db.js";
import { cosine, type EmbeddingProvider } from "./embeddings.js";
import { containment, fold, jaccard, plain, tokenize } from "./text.js";

export interface SearchFilters {
  project?: string; type?: NoteType; tags?: string[]; status?: NoteStatus[];
  since?: string; until?: string; created_by?: string; include_inactive?: boolean;
}

const ACTIVE_STATUSES: NoteStatus[] = ["active", "proposed", "deprecated"];

export class Searcher {
  private cache?: { gen: string; provider: string; items: Array<{ id: string; vec: Float32Array }> };
  constructor(private db: IndexDb, private embedder: () => EmbeddingProvider) {}

  private vectors() {
    const gen = this.db.getMeta("emb_gen") ?? "0";
    const prov = this.embedder().id;
    if (!this.cache || this.cache.gen !== gen || this.cache.provider !== prov) {
      this.cache = { gen, provider: prov, items: this.db.embeddings(prov).map((e) => ({ id: e.id, vec: e.vec })) };
    }
    return this.cache.items;
  }

  /** FTS5 (bm25) -> map id -> score 0..1 */
  /** `statuses`: filtra DENTRO da consulta (antes do LIMIT) — senão 80 ativas melhor ranqueadas esconderiam a substituída buscada. */
  private fts(tokens: string[], limit: number, statuses?: NoteStatus[]): Map<string, { score: number; snippet: string }> {
    const out = new Map<string, { score: number; snippet: string }>();
    if (!tokens.length) return out;
    const q = [...new Set(tokens)].slice(0, 16).map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
    let rows: Array<{ id: string; r: number; sn: string }> = [];
    try {
      rows = (statuses?.length
        ? this.db.db.prepare(`SELECT fts.id AS id, bm25(fts, 0, 6.0, 2.0, 1.0) AS r, snippet(fts, 3, '«', '»', '…', 24) AS sn FROM fts JOIN notes n ON n.id = fts.id WHERE fts MATCH ? AND n.status IN (${statuses.map(() => "?").join(",")}) ORDER BY r LIMIT ?`).all(q, ...statuses, limit)
        : this.db.db.prepare(`SELECT id, bm25(fts, 0, 6.0, 2.0, 1.0) AS r, snippet(fts, 3, '«', '»', '…', 24) AS sn FROM fts WHERE fts MATCH ? ORDER BY r LIMIT ?`).all(q, limit)) as typeof rows;
    } catch { return out; }
    if (!rows.length) return out;
    const best = rows[0]!.r; const worst = rows[rows.length - 1]!.r;
    for (const r of rows) {
      const norm = best === worst ? 1 : 0.35 + 0.65 * ((worst - r.r) / (worst - best));
      out.set(r.id, { score: norm, snippet: r.sn });
    }
    return out;
  }

  async search(query: string, f: SearchFilters = {}, limit = 10): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const ftsTokens = tokenize(q, { stem: false });
    const text = this.fts(ftsTokens.length ? ftsTokens : tokenize(q, { keepStop: true, stem: false }), 80, f.status);

    const sem = new Map<string, number>();
    const items = this.vectors();
    if (items.length) {
      let qv: Float32Array | undefined;
      try { [qv] = await this.embedder().embed([q]); } catch { /* provider fora do ar: segue só com FTS */ }
      if (qv) for (const it of items) { const c = cosine(qv, it.vec); if (c > 0.12) sem.set(it.id, Math.min(1, (c - 0.1) / 0.6)); }
    }
    const ids = new Set([...text.keys(), ...sem.keys()]);
    const qTokens = new Set(tokenize(q));
    const hits: SearchHit[] = [];
    for (const id of ids) {
      const row = this.db.getRow(id);
      if (!row || !this.passes(row, f)) continue;
      const t = text.get(id)?.score ?? 0; const s = sem.get(id) ?? 0;
      // só-semântico precisa de evidência forte: o embedder offline gera cossenos baixos espúrios por trigramas
      if (!t && s < 0.38) continue;
      let score = 0.62 * t + 0.38 * s;
      if (qTokens.size && jaccard(qTokens, new Set(tokenize(row.title))) > 0.25) score += 0.12;
      if (row.status === "deprecated") score *= 0.6;
      if (row.status === "superseded" || row.status === "archived") score *= 0.4;
      // ativa mas sem atualidade confirmada (planejada/incerta/em conflito): não compete de igual com o que foi verificado
      const fresh = row.freshness && row.freshness !== "current" ? (row.freshness as SearchHit["freshness"]) : undefined;
      if (fresh && row.status === "active") score *= 0.85;
      hits.push({
        id, title: row.title, type: row.type, status: row.status, project: row.project ?? undefined,
        tags: JSON.parse(row.tags) as string[], snippet: text.get(id)?.snippet ?? headSnippet(row.body),
        score: Math.round(score * 1000) / 1000, updated_at: row.updated_at,
        match: { ...(t ? { text: round(t) } : {}), ...(s ? { semantic: round(s) } : {}) },
        ...(fresh ? { freshness: fresh } : {}),
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private passes(r: NoteRow, f: SearchFilters): boolean {
    const statuses = f.status ?? (f.include_inactive ? undefined : ACTIVE_STATUSES);
    if (statuses && !statuses.includes(r.status)) return false;
    if (f.project && r.project !== f.project) return false;
    if (f.type && r.type !== f.type) return false;
    if (f.since && r.updated_at < f.since) return false;
    if (f.until && r.updated_at > f.until) return false;
    if (f.tags?.length) { const t = JSON.parse(r.tags) as string[]; if (!f.tags.every((x) => t.includes(x))) return false; }
    if (f.created_by) { const c = r.created_by ? (JSON.parse(r.created_by) as { name: string }).name : ""; if (c !== f.created_by) return false; }
    return true;
  }

  /** Conteúdo candidato -> notas existentes semelhantes (base da deduplicação). */
  async similar(draft: { title: string; body: string; project?: string; type?: NoteType; tags?: string[] }, opts: { limit?: number; exclude?: string; minScore?: number } = {}): Promise<SimilarMatch[]> {
    const text = `${draft.title}\n${draft.body}`;
    const dTokens = new Set(tokenize(plain(text)));
    const tTokens = new Set(tokenize(draft.title));
    const cand = new Set<string>();
    let qv: Float32Array | undefined;
    try { [qv] = await this.embedder().embed([text]); } catch { /* provider fora do ar: similaridade só lexical/FTS */ }
    const cos = new Map<string, number>();
    if (qv) for (const it of this.vectors()) { const c = cosine(qv, it.vec); cos.set(it.id, c); }
    [...cos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([id]) => cand.add(id));
    const rare = [...dTokens].sort((a, b) => b.length - a.length).slice(0, 14);
    for (const id of this.fts(rare.map(fold), 15).keys()) cand.add(id);

    const out: SimilarMatch[] = [];
    for (const id of cand) {
      if (id === opts.exclude) continue;
      const row = this.db.getRow(id);
      if (!row || row.status === "archived") continue;
      const nTokens = new Set(tokenize(plain(`${row.title}\n${row.body}`)));
      const c = Math.max(0, cos.get(id) ?? 0);
      const cont = containment(dTokens, nTokens);
      const titleSim = jaccard(tTokens, new Set(tokenize(row.title)));
      let sim = 0.45 * c + 0.35 * cont + 0.2 * titleSim;
      const reasons: string[] = [];
      if (c > 0.5) reasons.push(`vetor ${c.toFixed(2)}`);
      if (cont > 0.5) reasons.push(`cobertura lexical ${(cont * 100).toFixed(0)}%`);
      if (titleSim > 0.4) reasons.push("título semelhante");
      if (draft.project && row.project === draft.project) { sim += 0.05; reasons.push("mesmo projeto"); }
      if (draft.type && row.type === draft.type) { sim += 0.02; }
      sim = Math.min(1, sim);
      if (sim < (opts.minScore ?? 0.2)) continue;
      out.push({
        id, title: row.title, type: row.type, status: row.status, project: row.project ?? undefined,
        similarity: round(sim), reasons, revision: row.revision, updated_at: row.updated_at,
      });
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, opts.limit ?? 5);
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const headSnippet = (b: string) => plain(b).replace(/\s+/g, " ").trim().slice(0, 180);
