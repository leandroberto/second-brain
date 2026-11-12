import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  BrainError, isValidId, slugify,
  type Actor, type Analysis, type Confidence, type Freshness, type FreshnessState, type Note, type NoteStatus, type NoteType, type Principal, type Proposal, type ProposeResult,
  type RelationType, type Resolution, type SearchHit, type Source, type Temporal,
} from "@brain/shared";
import { ADDITIVE_RESOLUTION, INTERNAL_READER, authorize, isHumanReviewer, isPrincipal, principal } from "./authz.js";
const WATCHER = principal("system", "watcher", "internal");
import { wantsHistory } from "./freshness/index.js";
import { NOTE_TYPES, RELATION_TYPES, STATUSES } from "@brain/shared";
import { ConfigSchema, dumpConfig, loadConfig, type AcaoDeModulo, type BrainConfig, type ModuleEntry } from "./config.js";
import { MODULE_ID_RE } from "./modules/identity.js";
import { IndexDb } from "./db.js";
import { HashEmbedder, OpenAICompatibleEmbedder, chaveDeEmbeddings, isLocalUrl, type EmbeddingProvider } from "./embeddings.js";
import { VaultGit } from "./git.js";
import { CAPTURE_ID, CaptureLog } from "./assistant/captures.js";
import { classify, mergeUpdate } from "./governance.js";
import { Indexer, type SyncResult } from "./indexer.js";
import { withFileLock } from "./lock.js";
import { parseNote, revisionOf, serializeNote } from "./markdown.js";
import { ProposalStore, newProposalId } from "./proposals.js";
import { Searcher, type SearchFilters } from "./search.js";
import { redactSecrets, scanBulk, scanSecrets } from "./secrets.js";
import { jaccard, plain, tokenize } from "./text.js";
import { projectLinks, projectName } from "./projects.js";
import { Vault } from "./vault.js";
import { resolveStateDir } from "./state.js";

export interface DraftInput {
  title: string; type: NoteType; body: string; project?: string; tags?: string[];
  confidence?: Confidence; source?: Source; temporal?: Temporal;
}
export interface ProposeInput extends DraftInput {
  reason?: string; intent?: "new" | "complement" | "update" | "replace"; target_id?: string;
  meta?: Proposal["import"];
  /** reconciliação com o estado atual (Import Assistant) */
  freshness?: Freshness;
  /** manutenção gerada pelo sistema (revalidação / título) — só canal de manutenção */
  maintenance?: Proposal["maintenance"];
}
export interface ResolveInput {
  resolution: Resolution; target_id?: string; final_body?: string; note?: string;
  /** criar como HISTÓRICO (status superseded: fora do contexto/busca padrão). Padrão: o que a reconciliação concluiu. */
  as_historical?: boolean;
}

/** Estados de atualidade que NÃO representam o estado atual (viram histórico ao aprovar). */
export const HISTORICAL_STATES: FreshnessState[] = ["superseded", "reverted", "historical"];
const isHistorical = (f?: Freshness) => !!f && (HISTORICAL_STATES.includes(f.state) || (!!f.stale_from && HISTORICAL_STATES.includes(f.stale_from)));

/** Erros que o `resolve` levanta ANTES de qualquer escrita: na gravação automática, a proposta só fica na fila. */
const PRE_WRITE_ERRORS: ReadonlySet<string> = new Set(["secret_detected", "duplicate_id", "conflict_revision", "not_found", "invalid"]);

const now = () => new Date().toISOString();
const day = () => now().slice(0, 10);
/**
 * Texto livre (título, nota da decisão) numa mensagem de commit vira UMA linha: uma quebra de linha permitiria forjar trailers
 * (`Brain-Decided-By: …`), que o desfazer captura usa para achar os commits do agente.
 */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

export class Brain {
  readonly vault: Vault;
  config: BrainConfig;
  readonly db: IndexDb;
  readonly git: VaultGit;
  readonly indexer: Indexer;
  readonly searcher: Searcher;
  readonly proposals: ProposalStore;
  private _embedder: EmbeddingProvider;

  /** quem aparece nos logs de LEITURA quando o chamador não se identifica (nunca escreve) */
  readonly defaultActor: Actor = INTERNAL_READER;

  private constructor(root: string) {
    // a config vive no vault: lê ANTES de construir Vault/IndexDb/VaultGit, que dependem do diretório de estado
    this.config = loadConfig(new Vault(root).configPath);
    this.vault = new Vault(root, resolveStateDir(root, this.config));
    this.db = new IndexDb(this.vault.dbPath);
    this.git = new VaultGit(root, undefined, this.vault.gitDir);
    this._embedder = this.makeEmbedder();
    this.indexer = new Indexer(this.vault, this.db, () => this._embedder);
    this.searcher = new Searcher(this.db, () => this._embedder);
    this.proposals = new ProposalStore(this.vault);
  }

  /** Abre um vault existente. */
  static async open(root: string): Promise<Brain> {
    const v = new Vault(root);
    if (!v.exists()) throw new BrainError("not_found", `vault não encontrado em ${root} (rode "brain init")`);
    const b = new Brain(root);
    await b.indexer.sync();
    // retenção da atividade operacional (no máximo 1×/dia)
    if (Date.now() - Number(b.db.getMeta("last_prune") ?? 0) > 864e5) { b.db.pruneActivity(b.config.retention.activity_days); b.db.setMeta("last_prune", String(Date.now())); }
    return b;
  }

  /** Cria (ou completa) a estrutura de um vault. Idempotente. */
  static async init(root: string, opts: { name?: string; agentsMd?: string; skillMd?: string; readme?: string } = {}): Promise<Brain> {
    mkdirSync(join(root, ".brain"), { recursive: true });
    new Vault(root).writeDefaultConfig();
    const v = new Vault(root, resolveStateDir(root, loadConfig(new Vault(root).configPath)));
    v.ensureDirs();
    const put = (rel: string, content?: string) => { const p = join(root, rel); if (content && !existsSync(p)) { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, content); } };
    put("AGENTS.md", opts.agentsMd); put("README.md", opts.readme); put("skills/second-brain/SKILL.md", opts.skillMd);
    const engine = v.stateDir ? "" : ".brain/index.db*\n.brain/api-token\n.brain/lock.d/\n.brain/proposals/pending/\n";
    put(".gitignore", `${engine}.brain/backup/\n.brain/assistant-cwd/\n.obsidian/workspace*.json\n.obsidian/cache\n.trash/\n`);
    put(".obsidian/app.json", JSON.stringify({ newFileLocation: "folder", newFileFolderPath: "knowledge/inbox", useMarkdownLinks: false, alwaysUpdateLinks: true }, null, 2));
    for (const d of ["inbox", "archive"]) put(`knowledge/${d}/.gitkeep`, "");
    const git = new VaultGit(root, undefined, v.gitDir);
    if (!(await git.isRepo())) await git.init();
    if (!(await git.head())) await git.commitPaths(["."], "brain: initialize vault");
    return Brain.open(root);
  }

  close(): void { this.db.close(); }

  // ---------- infra ----------
  private makeEmbedder(): EmbeddingProvider {
    const e = this.config.embeddings;
    if (e.provider === "openai-compatible") {
      const local = isLocalUrl(e.base_url);
      if (!local && !e.external_opt_in) {
        console.error("[brain] embeddings externos sem external_opt_in=true; usando provider local 'hash'");
        return new HashEmbedder();
      }
      // a chave só sai para os hosts de `api_key_hosts` (o embedder confere): fora deles roda sem credencial
      return new OpenAICompatibleEmbedder({ baseUrl: e.base_url, model: e.model, dim: e.dimensions, apiKey: process.env[e.api_key_env], apiKeyHosts: e.api_key_hosts });
    }
    return new HashEmbedder();
  }

  /** Aviso (sem o valor) quando há chave definida em `api_key_env` e o embedder em uso não a envia ao host de `base_url`. */
  private avisoDaChaveDeEmbeddings(): string | undefined {
    const e = this.config.embeddings;
    if (!(this._embedder instanceof OpenAICompatibleEmbedder) || !process.env[e.api_key_env]) return undefined;
    const c = chaveDeEmbeddings(e.base_url, e.api_key_hosts);
    if (c.envia) return undefined;
    // URL inválida: texto fixo, nunca a `base_url` (gravável pela UI, pode levar caracteres de controle ao terminal do doctor)
    if (c.motivo === "url_invalida") return "a chave de embeddings não é enviada: embeddings.base_url inválida";
    const motivo = { credenciais_na_url: "embeddings.base_url não pode ter usuário/senha", protocolo: "embeddings.base_url precisa ser https",
      sem_https: "use https em embeddings.base_url", fora_da_lista: "adicione-o em embeddings.api_key_hosts no .brain/config.yaml" }[c.motivo];
    return `a chave de embeddings não é enviada${c.host ? ` para ${c.host}` : ""}: ${motivo}`; // `file:`, `mailto:`... não têm host
  }
  get embedder(): EmbeddingProvider { return this._embedder; }

  sync(opts?: { force?: boolean; maxAgeMs?: number }): Promise<SyncResult> { return this.indexer.sync(opts); }

  /** Serializa escritas entre processos (Claude MCP, Codex MCP, API) e re-sincroniza o índice dentro do lock. */
  private async write<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.vault.lockPath, async () => { this.reloadConfig(); await this.indexer.sync({ force: false }); return fn(); });
  }

  /**
   * O mesmo lock de escrita do vault, para módulos do core que gravam fora das propostas (registro de capturas). Não é
   * reentrante: nunca chame métodos de escrita da Brain dentro de `fn`, nem segure o lock enquanto outro processo (MCP) grava.
   */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T> { return this.write(fn); }

  /**
   * A config como está no disco agora (edição manual, outro processo), para quem só lê, como a tela de Configurações: sem isso,
   * depois de um "nada mudou" do gerenciamento de módulos (decidido pelo disco) a tela seguiria mostrando a cópia da memória.
   */
  freshConfig(): BrainConfig { this.reloadConfig(); return this.config; }

  /** Política/config podem ter sido alteradas por outro processo (UI, outro MCP): sempre reler sob o lock. */
  private reloadConfig(): void {
    try {
      const next = loadConfig(this.vault.configPath);
      const changed = JSON.stringify(next.embeddings) !== JSON.stringify(this.config.embeddings);
      this.config = next; // atribui ANTES: makeEmbedder lê this.config (revogar o opt-in externo precisa valer já)
      if (changed) this._embedder = this.makeEmbedder();
    } catch { /* config inválida: mantém a última válida */ }
  }

  private log(actor: Actor, action: string, target: string | null, detail: Record<string, unknown> = {}) {
    let safe: Record<string, unknown>;
    try { safe = JSON.parse(redactSecrets(JSON.stringify(detail))) as Record<string, unknown>; } catch { safe = { redacted: true }; }
    this.db.log(actor, action, target, safe);
  }

  // ---------- leitura ----------
  /** Lê a nota do ARQUIVO (fonte de verdade), não do índice. */
  loadNote(id: string): Note {
    const row = this.db.getRow(id);
    if (!row) throw new BrainError("not_found", `conhecimento "${id}" não existe`);
    if (!this.vault.fileExists(row.path)) throw new BrainError("not_found", `arquivo de "${id}" sumiu; reindexe`);
    const raw = this.vault.readRaw(row.path);
    return parseNote(raw, row.path, row.updated_at).note;
  }

  async get(id: string, actor: Actor = this.defaultActor) {
    await this.sync({ maxAgeMs: 1000 });
    const note = this.loadNote(id);
    const backlinks = (this.db.db.prepare("SELECT src,type FROM links WHERE dst=?").all(id) as Array<{ src: string; type: string }>)
      .map((l) => ({ ...l, title: this.db.getRow(l.src)?.title ?? l.src })).filter((l) => this.db.getRow(l.src));
    const outgoing = (this.db.db.prepare("SELECT dst,type FROM links WHERE src=?").all(id) as Array<{ dst: string; type: string }>)
      .map((l) => ({ ...l, title: this.db.getRow(l.dst)?.title, exists: !!this.db.getRow(l.dst) }));
    const history = await this.git.log(note.path, 15);
    const touches = this.db.activity({ target: id, limit: 50 });
    const row = this.db.getRow(id)!;
    this.log(actor, "read", id);
    if (actor.kind === "agent") { note.body = redactSecrets(note.body); }
    const similar = (await this.searcher.similar({ title: note.title, body: note.body, project: note.project, type: note.type }, { exclude: id, limit: 4, minScore: this.config.governance.candidate_threshold }));
    return {
      note, backlinks, outgoing, history, similar, issues: JSON.parse(row.issues) as string[],
      usage: { reads: touches.filter((t) => t.action === "read" || t.action === "retrieved").length, last_read: touches.find((t) => t.action === "read" || t.action === "retrieved")?.ts },
      activity: touches.slice(0, 15),
    };
  }

  async search(query: string, filters: SearchFilters = {}, limit = 10, actor: Actor = this.defaultActor): Promise<SearchHit[]> {
    query = redactSecrets(query); // consulta com segredo: nem vai ao embedder nem ao log
    await this.sync({ maxAgeMs: 1000 });
    const hits = await this.searcher.search(query, filters, limit);
    this.log(actor, "search", null, { query, filters, results: hits.length });
    for (const h of hits.slice(0, 5)) this.log(actor, "retrieved", h.id, { via: "search" });
    return hits;
  }

  /**
   * Pacote pequeno e relevante de contexto para iniciar uma tarefa. ATUAL primeiro: notas substituídas/históricas nunca competem
   * com as atuais; aparecem em `history` (ponteiro "X foi substituído por Y") quando casam com a consulta, e com resumo quando a
   * consulta pede evolução/histórico. Notas ativas cuja atualidade não foi confirmada (planejado/incerto/conflito) vêm rotuladas.
   */
  async context(input: { project?: string; topic?: string; task?: string; max_items?: number; budget_chars?: number }, actor: Actor = this.defaultActor) {
    input = { ...input, topic: input.topic && redactSecrets(input.topic), task: input.task && redactSecrets(input.task) };
    await this.sync({ maxAgeMs: 1000 });
    const max = input.max_items ?? 8; const budget = input.budget_chars ?? 6000;
    type Item = { id: string; title: string; type: NoteType; status: NoteStatus; project?: string; why: string; summary: string; updated_at: string; score?: number; freshness?: FreshnessState; supersedes?: Array<{ id: string; title: string }>; temporal?: Temporal };
    const items: Item[] = [];
    const history: Array<{ id: string; title: string; status: NoteStatus; freshness?: FreshnessState; superseded_by?: { id: string; title: string }; why: string; summary?: string }> = [];
    const seen = new Set<string>();
    const rel = (id: string, type: string) => (this.db.db.prepare("SELECT dst FROM links WHERE src=? AND type=?").all(id, type) as Array<{ dst: string }>).map((l) => this.db.getRow(l.dst)).filter((r): r is NonNullable<typeof r> => !!r);
    const push = (id: string, why: string, score?: number) => {
      if (seen.has(id) || items.length >= max) return;
      const r = this.db.getRow(id); if (!r || r.status === "superseded" || r.status === "archived") return;
      seen.add(id);
      const sup = rel(id, "supersedes").map((o) => ({ id: o.id, title: o.title }));
      // conhecimento TEMPORAL vem com a data de validade e o evento que obriga a revalidar (não é verdade permanente)
      let temporal: Temporal | undefined; try { temporal = this.loadNote(id).temporal; } catch { /* arquivo sumiu: segue sem */ }
      items.push({ id, title: r.title, type: r.type, status: r.status, project: r.project ?? undefined, why, summary: summarize(r.body), updated_at: r.updated_at, ...(score !== undefined ? { score } : {}), ...(r.freshness && r.freshness !== "current" ? { freshness: r.freshness as FreshnessState } : {}), ...(sup.length ? { supersedes: sup } : {}), ...(temporal ? { temporal } : {}) });
    };
    const q = [input.topic, input.task].filter(Boolean).join(" ");
    // 1. visão geral do projeto (sempre — exceto quando o pacote é minúsculo e há um tópico: aí o relevante tem prioridade)
    const roomy = !q || max > 2;
    if (input.project && roomy) { const ov = this.db.rows("type='project' AND project=? AND status='active'", [input.project], "updated_at DESC", 1)[0]; if (ov) push(ov.id, "visão geral do projeto"); }
    // 2. preferências globais (como o usuário quer trabalhar): poucas e baratas
    if (roomy) for (const r of this.db.rows("project IS NULL AND status='active' AND type='preference'", [], "updated_at DESC", 3)) push(r.id, "preferência global");
    if (q) {
      // 3. o que é RELEVANTE ao tópico/tarefa; decisões e restrições pesam mais; atualidade não confirmada pesa menos
      const W: Partial<Record<NoteType, number>> = { decision: 1.2, preference: 1.15, pattern: 1.1, reference: 0.9 };
      const scoped = input.project ? await this.searcher.search(q, { project: input.project }, 10) : [];
      const global = await this.searcher.search(q, {}, 10);
      // com projeto informado, nota de OUTRO projeto só entra se citar o projeto pedido (evidência de menção); notas globais
      // (sem projeto) sempre podem entrar. Sem isso, decisões de outros projetos com vocabulário parecido ocupavam o pacote.
      const citers = input.project ? await this.projectCiters(input.project) : undefined;
      const inScope = (h: SearchHit) => !input.project || !h.project || h.project === input.project || citers!.has(h.id);
      const ranked = [...new Map([...scoped.map((h) => ({ ...h, score: h.score * 1.1 })), ...global.filter(inScope)].map((h) => [h.id, h])).values()]
        .map((h) => ({ ...h, score: h.score * (W[h.type] ?? 1) })).sort((a, b) => b.score - a.score);
      const top = ranked[0]?.score ?? 0;
      // 3b. substituídas/arquivadas que casam com a consulta: busca SEPARADA (não disputam o limite com as ativas). O ATUAL que as
      // substituiu entra no ranking ANTES do corte (mesmo sem casar com o vocabulário antigo); a antiga vira ponteiro em `history`.
      const histWanted = wantsHistory(q);
      const inactive = await this.searcher.search(q, { status: ["superseded", "archived"], ...(input.project ? { project: input.project } : {}) }, 10);
      const succ: Array<{ id: string; score: number; why: string }> = []; const histCand: Array<{ h: SearchHit; succ?: { id: string; title: string } }> = [];
      for (const h of inactive) {
        const raw = h.score / 0.4; // a busca rebaixa substituídas/arquivadas em 0,4
        if (!histWanted && raw < Math.max(top, 0.01) * 0.6) continue;
        const s0 = rel(h.id, "superseded_by").find((r) => r.status === "active");
        if (s0) succ.push({ id: s0.id, score: raw * (W[s0.type] ?? 1), why: `substitui "${h.title.slice(0, 60)}" (conhecimento atual sobre o assunto)` });
        histCand.push({ h, ...(s0 ? { succ: { id: s0.id, title: s0.title } } : {}) });
      }
      const succIds = new Set(succ.map((x) => x.id));
      const merged = [...ranked.filter((h) => h.score >= top * 0.4 || succIds.has(h.id)).map((h) => ({ id: h.id, score: h.score, why: `relevante para "${q.slice(0, 60)}"` })), ...succ].sort((a, b) => b.score - a.score);
      for (const m of merged) push(m.id, m.why, Math.round(m.score * 100) / 100);
      for (const { h, succ: s0 } of histCand.slice(0, histWanted ? 5 : 2)) {
        const row = this.db.getRow(h.id)!;
        history.push({ id: h.id, title: h.title, status: h.status, ...(row.freshness ? { freshness: row.freshness as FreshnessState } : {}), ...(s0 ? { superseded_by: s0 } : {}), why: s0 ? `substituído por "${s0.title.slice(0, 60)}" — não é o estado atual` : `histórico (${row.freshness ?? h.status}) — não é o estado atual`, ...(histWanted ? { summary: summarize(row.body) } : {}) });
      }
    } else if (input.project) {
      // sem tópico: o essencial do projeto (decisões/preferências mais recentes) — única situação em que volume sem relevância é aceitável
      for (const r of this.db.rows("project=? AND status='active' AND type IN ('decision','preference') AND (freshness IS NULL OR freshness='current')", [input.project], "updated_at DESC", 4)) push(r.id, `${r.type} ativa do projeto`);
    }
    if (input.project) for (const r of this.db.rows("project=? AND status='active' AND type='open-question'", [input.project], "updated_at DESC", 2)) if (!q || items.length < 3) push(r.id, "pergunta em aberto");
    let used = 0; const out = [];
    for (const it of items) { const cost = it.summary.length + it.title.length + 80; if (used + cost > budget && out.length) break; used += cost; out.push(it); }
    // o histórico também consome o orçamento: primeiro perde o resumo, depois sai (o atual tem prioridade)
    const hist: typeof history = []; let histCut = false;
    for (const h of history) {
      const cost = h.title.length + h.why.length + (h.superseded_by?.title.length ?? 0) + 60;
      if (used + cost > budget) { histCut = true; break; }
      used += cost;
      if (h.summary && used + h.summary.length > budget) { histCut = true; hist.push({ ...h, summary: undefined }); continue; }
      used += h.summary?.length ?? 0; hist.push(h);
    }
    for (const it of out) this.log(actor, "retrieved", it.id, { via: "context" });
    this.log(actor, "context", null, { project: input.project, topic: input.topic, task: input.task, items: out.length, history: hist.length });
    return {
      items: out, ...(hist.length ? { history: hist.map((h) => (h.summary === undefined ? (({ summary: _s, ...r }) => r)(h) : h)) } : {}), truncated: out.length < items.length || histCut,
      hint: `Use brain_get com o id para ler a nota completa. Não carregue tudo.${out.some((i) => i.freshness) ? " Itens com `freshness` não foram confirmados como estado atual (planned/uncertain/conflict): verifique antes de agir." : ""}${out.some((i) => i.temporal) ? " Itens com `temporal` eram verdade na data `as_of` e podem ter deixado de ser: revalide com o usuário antes de qualquer ação destrutiva ou irreversível." : ""}${hist.length ? " `history` = conhecimento substituído/histórico: explica a evolução, NÃO é o estado atual." : ""}`,
    };
  }

  async recent(opts: { limit?: number; since?: string; project?: string } = {}) {
    await this.sync({ maxAgeMs: 1000 });
    const w = ["status NOT IN ('archived')"]; const p: string[] = [];
    if (opts.since) { w.push("updated_at>=?"); p.push(opts.since); }
    if (opts.project) { w.push("project=?"); p.push(opts.project); }
    return this.db.rows(w.join(" AND "), p, "updated_at DESC", opts.limit ?? 15).map(rowSummary);
  }

  /**
   * Gravações automáticas de agentes (política `additive`) nos últimos `days` dias (padrão 7), das mais novas às mais antigas,
   * no máximo `limit` (padrão 50), para a visão "Entrou recentemente". Só `create` e `complement` decididos por um agente.
   * Some o que já não está no vault (nota apagada ou criação desfeita), notas arquivadas e as capturas do assistente marcadas
   * como `desfeita`. Um `git revert` do commit da decisão leva o JSON junto, então o item também some. `capture_id` sai do
   * nome `assistant/<id>` do agente; nesses itens não se consulta o git (o desfazer usa a captura, não o commit).
   */
  async recentAgentWrites(opts: { days?: number; agent?: string; limit?: number } = {}): Promise<Array<{ commit: string; date: string; agent: string; resolution: "create" | "complement"; note_id: string; title: string; capture_id?: string }>> {
    await this.sync({ maxAgeMs: 1000 });
    const since = new Date(Date.now() - (opts.days ?? 7) * 86_400_000).toISOString();
    const limit = Math.max(1, opts.limit ?? 50);
    const captures = new CaptureLog(this);
    const found: Array<{ id: string; item: { commit: string; date: string; agent: string; resolution: "create" | "complement"; note_id: string; title: string; capture_id?: string } }> = [];
    for (const p of this.proposals.list("decided")) {
      const d = p.decided;
      if (!d || d.by.kind !== "agent" || (d.resolution !== "create" && d.resolution !== "complement") || d.at < since) continue;
      if (opts.agent && d.by.name !== opts.agent) continue;
      const noteId = d.result_id ?? d.target_id;
      const row = noteId ? this.db.getRow(noteId) : undefined;
      if (!noteId || !row || row.status === "archived") continue;
      const m = /^assistant\/(.+)$/.exec(d.by.name);
      const captureId = m && CAPTURE_ID.test(m[1]!) ? m[1] : undefined;
      if (captureId && captures.get(captureId)?.state === "desfeita") continue;
      found.push({ id: p.id, item: { commit: d.commit ?? "", date: d.at, agent: d.by.name, resolution: d.resolution, note_id: noteId, title: row.title, ...(captureId ? { capture_id: captureId } : {}) } });
    }
    found.sort((x, y) => y.item.date.localeCompare(x.item.date));
    const top = found.slice(0, limit);
    // o commit não fica no JSON (nasce junto com ele): só para os itens devolvidos e sem capture_id, pelo histórico do arquivo da decisão
    for (const t of top) if (!t.item.commit && !t.item.capture_id) t.item.commit = (await this.git.log(`.brain/proposals/decided/${t.id}.json`, 1).catch(() => []))[0]?.hash ?? "";
    return top.map((t) => t.item);
  }

  async projects() {
    await this.sync({ maxAgeMs: 1000 });
    const rows = this.db.db.prepare(`SELECT project, COUNT(*) n, MAX(updated_at) last FROM notes WHERE project IS NOT NULL AND status NOT IN ('archived') GROUP BY project ORDER BY last DESC`).all() as Array<{ project: string; n: number; last: string }>;
    return rows.map((r) => {
      const ov = this.db.rows("type='project' AND project=? AND status!='archived'", [r.project], "updated_at DESC", 1)[0];
      const byType = Object.fromEntries((this.db.db.prepare("SELECT type, COUNT(*) n FROM notes WHERE project=? AND status!='archived' GROUP BY type").all(r.project) as Array<{ type: string; n: number }>).map((x) => [x.type, x.n]));
      return { id: r.project, name: projectName(ov?.title, r.project), title: ov?.title ?? r.project, overview_id: ov?.id, notes: r.n, last_updated: r.last, by_type: byType };
    });
  }

  async createProject(slug: string, title: string, summary: string, actor: Principal): Promise<Note> {
    const s = slugify(slug, 60);
    if (!isValidId(s)) throw new BrainError("invalid", "slug de projeto inválido");
    return this.createNote({ title, type: "project", project: s, body: `# ${title}\n\n${summary}\n`, tags: [] }, actor, { id: `project-${s}` });
  }

  // ---------- validação ----------
  private validateDraft(d: DraftInput, extra: string[] = []): void {
    if (!d.title?.trim() || !d.body?.trim()) throw new BrainError("invalid", "título e corpo são obrigatórios");
    if (d.title.length > 200) throw new BrainError("invalid", "título muito longo (máx 200 caracteres)");
    if (d.project && (!isValidId(d.project) || d.project.length > 60)) throw new BrainError("invalid", "slug de projeto inválido (a-z, 0-9, hífen; até 60 caracteres)");
    if ((d.tags?.length ?? 0) > 20 || (d.tags ?? []).some((t) => typeof t !== "string" || !t.trim() || t.length > 60)) throw new BrainError("invalid", "tags inválidas (máx 20, até 60 caracteres cada)");
    const secrets = scanSecrets(`${d.title}\n${d.body}\n${(d.tags ?? []).join(" ")}\n${JSON.stringify(d.source ?? {})}\n${extra.join("\n")}`);
    if (secrets.length) throw new BrainError("secret_detected", `possível segredo detectado (${secrets.map((s) => `${s.kind}@L${s.line}`).join(", ")}); remova antes de armazenar`, secrets);
    const bulk = scanBulk(d.body, { maxChars: this.config.limits.max_chars, maxCodeLines: this.config.limits.max_code_lines });
    if (bulk.length) throw new BrainError("too_large", bulk.join("; "));
  }

  private uniqueId(base: string): string {
    let id = base.slice(0, 100).replace(/-+$/g, ""); let n = 2;
    while (this.db.getRow(id) || this.vault.fileExists(`knowledge/inbox/${id}.md`)) id = `${base.slice(0, 96)}-${n++}`;
    return id;
  }
  private idFor(d: DraftInput): string {
    if (d.type === "project" && d.project && d.project.length <= 60 && !this.db.getRow(`project-${d.project}`)) return `project-${d.project}`;
    // usa a primeira oração do título ("Web First; desktop opcional (…)" → "web-first"), cortando em fronteira de palavra
    const head = d.title.split(/\s*[;:(]\s*|\s+[—–]\s+/)[0]!.trim();
    let slug = slugify(head.length >= 6 ? head : d.title, 80);
    if (slug.length > 52) slug = slug.slice(0, 52).replace(/-[^-]*$/, "");
    return this.uniqueId(slugify(`${d.type}-${d.project && !slug.includes(d.project) ? d.project + "-" : ""}${slug}`, 80));
  }

  // ---------- análise ----------
  async analyze(d: DraftInput & { intent?: ProposeInput["intent"]; target_id?: string }): Promise<Analysis> {
    this.validateDraft(d); // antes de qualquer embedding: um segredo nunca é enviado a um provider (externo ou não)
    await this.sync({ maxAgeMs: 1000 });
    const matches = await this.searcher.similar(d, { limit: 5, minScore: 0.2 });
    if (d.target_id && !matches.some((m) => m.id === d.target_id)) {
      const r = this.db.getRow(d.target_id);
      if (r) matches.unshift({ id: r.id, title: r.title, type: r.type, status: r.status, project: r.project ?? undefined, similarity: 0, reasons: ["alvo indicado explicitamente"], revision: r.revision, updated_at: r.updated_at });
    }
    // sob `additive` o agente grava sozinho o que é aditivo: a dica dele (intent/target_id) só pode escalar, nunca rebaixar (ADR 0014)
    const a = classify(d, matches, (id) => { const r = this.db.getRow(id); return r ? { title: r.title, body: r.body } : undefined; }, this.config.governance, { intent: d.intent, target_id: d.target_id }, { trustHint: this.config.agents.commit_policy !== "additive" });
    if (a.matches.some((m) => m.status === "deprecated") && a.classification === "new") a.warnings.push("há conhecimento depreciado semelhante");
    return a;
  }

  async similar(d: Pick<DraftInput, "title" | "body" | "project"> & { type?: NoteType }, actor: Actor = this.defaultActor) {
    const a = await this.analyze({ ...d, type: d.type ?? "learning", tags: [] });
    this.log(actor, "similar", null, { title: d.title, top: a.matches[0]?.id });
    return a;
  }

  // ---------- propostas ----------
  /**
   * Cria uma proposta classificada. Sob `commit_policy: additive` (ADR 0014), quando o autor é um AGENTE, o que é aditivo é
   * decidido ali mesmo, dentro do mesmo lock e pelo mesmo caminho do `resolve` (autorização, trailers, decided/): `new` → create,
   * `complement` → complement, `duplicate` → ignore. O resto (update, replace, conflict, tipos "review") fica pendente.
   */
  async propose(input: ProposeInput, who: Principal): Promise<ProposeResult> {
    const actor = authorize(who, "propose", { config: this.config });
    // veredito de atualidade e manutenção só vêm do sistema (importador/manutenção): ninguém injeta um "current" ou uma revalidação
    if (input.maintenance && !(actor.kind === "system" && actor.channel === "maintenance")) throw new BrainError("forbidden", "propostas de manutenção só são geradas pelo sistema");
    if (input.temporal) TemporalOk(input.temporal);
    this.validateDraft(input, [input.reason ?? "", input.meta?.evidence ?? "", input.temporal?.revalidate_when ?? ""]);
    return this.write(async () => {
      // a análise (e as revisions registradas) acontece DENTRO do lock: descreve exatamente o snapshot que será validado depois
      let analysis = await this.analyze(input);
      // manutenção (revalidar/título) é SOBRE uma nota existente: o rascunho repete o texto dela de propósito — não é duplicata
      if (input.maintenance && input.target_id && this.db.getRow(input.target_id)) analysis = { ...analysis, classification: "update", suggested_resolution: "update", target_id: input.target_id, warnings: analysis.warnings.filter((w) => !/duplicat/i.test(w)) };
      // outras propostas pendentes (de outro agente) sobre o mesmo assunto: avisa o revisor
      const myTok = new Set(tokenize(plain(`${input.title} ${input.body}`)));
      for (const o of this.proposals.list("pending")) {
        const sim = jaccard(myTok, new Set(tokenize(plain(`${o.draft.title} ${o.draft.body}`))));
        if (sim >= 0.45) analysis.warnings.push(`há outra proposta pendente muito parecida (${o.id}, de ${o.proposed_by.name}): decida uma e reanalise a outra`);
      }
      const sig = revisionOf(`${tokenize(plain(input.title + " " + input.body)).join(" ")}|${input.project ?? ""}`);
      // manutenção: no máximo UMA pendente por (alvo, tipo) — verificado dentro do lock (execuções concorrentes não duplicam)
      const dup = input.maintenance
        ? this.proposals.list("pending").find((p) => p.maintenance?.kind === input.maintenance!.kind && p.target_id === input.target_id)
        : this.proposals.list("pending").find((p) => !p.maintenance && revisionOf(`${tokenize(plain(p.draft.title + " " + p.draft.body)).join(" ")}|${p.draft.project ?? ""}`) === sig);
      if (dup) { this.log(actor, "propose_dedup", dup.id); return dup; }
      const target = analysis.target_id ?? input.target_id;
      const p: Proposal = {
        id: newProposalId(), state: "pending", created_at: now(), proposed_by: { kind: actor.kind, name: actor.name }, reason: input.reason, intent: input.intent,
        draft: { title: input.title.trim(), type: input.type, project: input.project, tags: dedupe(input.tags ?? []), body: input.body.trim() + "\n", confidence: input.confidence, source: input.source, ...(input.temporal ? { temporal: input.temporal } : {}) },
        // atualidade só vem do reconciliador do sistema (importador/manutenção): humano/agente/API nunca injeta um veredito
        analysis, target_id: target, ...(input.meta ? { import: input.meta } : {}), ...(input.freshness && actor.kind === "system" ? { freshness: input.freshness } : {}),
        ...(input.maintenance ? { maintenance: input.maintenance } : {}),
        target_revision: target ? this.db.getRow(target)?.revision : undefined,
      };
      this.proposals.savePending(p);
      this.log(actor, "propose", p.id, { title: p.draft.title, classification: analysis.classification, target });
      return this.autoResolve(p, actor);
    });
  }

  /**
   * Política `additive`: aplica a resolução aditiva de uma proposta de AGENTE recém-criada. Roda DENTRO do `write()` do propose
   * (o lock não é reentrante: chama `resolveLocked`, não `resolve`). Quem permite ou nega é `authorize(…, "decide", …)`, como em
   * qualquer decisão: negada (tipo "review", alvo que não é o da análise…), a proposta simplesmente continua na fila. Uma
   * validação que o `resolve` faz ANTES de escrever (segredo no corpo resultante, colisão de arquivo…) também deixa a proposta na
   * fila, com aviso para o revisor; falha depois da escrita (git) é propagada, como no `resolve`.
   */
  private async autoResolve(p: Proposal, actor: Principal): Promise<ProposeResult> {
    if (this.config.agents.commit_policy !== "additive" || actor.kind !== "agent") return p;
    const resolution = ADDITIVE_RESOLUTION[p.analysis.classification];
    if (!resolution) return p;
    try {
      const r = await this.resolveLocked(p, { resolution, ...(resolution === "complement" ? { target_id: p.analysis.target_id } : {}) }, actor, { freshAnalysis: true });
      return { ...r.proposal, auto: { resolution, ...(r.note ? { note_id: r.note.id } : {}), ...(r.commit ? { commit: r.commit } : {}) } };
    } catch (e) {
      if (!(e instanceof BrainError)) throw e;
      if (e.code === "forbidden") return p;
      if (!PRE_WRITE_ERRORS.has(e.code)) throw e;
      p.analysis.warnings.push(`gravação automática (política additive) não aplicada: ${e.message}`);
      this.proposals.savePending(p);
      return p;
    }
  }

  /** Substituição explícita pedida por agente/usuário: vira proposta `replace` para revisão. */
  async supersede(input: { old_id: string; draft: DraftInput; reason?: string }, who: Principal): Promise<Proposal> {
    if (!this.db.getRow(input.old_id)) throw new BrainError("not_found", `"${input.old_id}" não existe`);
    return this.propose({ ...input.draft, reason: input.reason, intent: "replace", target_id: input.old_id }, who);
  }

  listProposals(which: "pending" | "decided" | "all" = "pending") { return this.proposals.list(which); }
  getProposal(id: string): Proposal { const p = this.proposals.get(id); if (!p) throw new BrainError("not_found", `proposta ${id} não existe`); return p; }
  /** Para exibição: preenche o commit da decisão a partir do histórico do arquivo decidido (o JSON não guarda o próprio hash). */
  async proposalView(id: string): Promise<Proposal> {
    const p = this.getProposal(id);
    if (p.decided && !p.decided.commit) { const [c] = await this.git.log(`.brain/proposals/decided/${p.id}.json`, 1).catch(() => []); if (c) p.decided.commit = c.hash; }
    return p;
  }

  /** O revisor corrige o rascunho (título, corpo, tags, tipo, projeto) ANTES de decidir; a análise é refeita. */
  async editProposal(id: string, patch: Partial<Pick<DraftInput, "title" | "body" | "tags" | "type" | "project" | "temporal">> & { clear_temporal?: boolean }, who: Principal): Promise<Proposal> {
    return this.write(async () => {
      const p = this.getProposal(id);
      const actor = authorize(who, "amend", { config: this.config, proposal: p });
      if (p.state !== "pending" && p.state !== "stale") throw new BrainError("invalid", "proposta já decidida");
      const next = { ...p.draft, ...omitUndef({ title: patch.title?.trim(), body: patch.body === undefined ? undefined : patch.body.trim() + "\n", tags: patch.tags ? dedupe(patch.tags) : undefined, type: patch.type, project: patch.project === "" ? undefined : patch.project, temporal: patch.temporal }) };
      if (patch.project === "") next.project = undefined;
      if (patch.clear_temporal) delete next.temporal;
      if (next.temporal) TemporalOk(next.temporal);
      if (patch.type && !(NOTE_TYPES as readonly string[]).includes(patch.type)) throw new BrainError("invalid", "tipo inválido");
      this.validateDraft(next, [p.reason ?? "", p.import?.evidence ?? "", next.temporal?.revalidate_when ?? ""]);
      // a verificação valia para o texto ANTERIOR: editar título/corpo a invalida (continua presente, rebaixada — nunca some,
      // para não cair na exceção "sem verificação" da aprovação em lote)
      if (p.freshness && (next.title !== p.draft.title || next.body !== p.draft.body)) p.freshness = staleFreshness(p.freshness);
      p.draft = next; p.edited = { at: now(), by: { kind: actor.kind, name: actor.name } };
      p.analysis = await this.analyze({ ...next, intent: p.intent, target_id: p.target_id && this.db.getRow(p.target_id) ? p.target_id : undefined });
      p.target_id = p.analysis.target_id ?? p.target_id;
      p.target_revision = p.target_id ? this.db.getRow(p.target_id)?.revision : undefined;
      p.state = "pending";
      this.proposals.savePending(p);
      this.log(actor, "proposal_edit", p.id, { title: p.draft.title });
      return p;
    });
  }

  /** Grava SÓ a reconciliação de atualidade em propostas pendentes (rascunho, análise e decisão ficam intactos). */
  async attachFreshness(updates: Array<{ id: string; freshness: Freshness }>, who: Principal): Promise<number> {
    const actor = authorize(who, "verify", { config: this.config });
    return this.write(async () => {
      let n = 0;
      for (const u of updates) { const p = this.proposals.get(u.id); if (!p || (p.state !== "pending" && p.state !== "stale")) continue; p.freshness = u.freshness; this.proposals.savePending(p); n++; }
      if (n) this.log(actor, "proposal_reverify", null, { count: n });
      return n;
    });
  }

  /** Re-executa a análise (após mudança concorrente no alvo) e limpa o estado `stale`. */
  async reanalyze(id: string, who: Principal): Promise<Proposal> {
    authorize(who, "read", { config: this.config });
    return this.write(async () => {
      const p = this.getProposal(id);
      if (p.state !== "pending" && p.state !== "stale") throw new BrainError("invalid", "proposta já decidida");
      p.analysis = await this.analyze({ ...p.draft, intent: p.intent, target_id: p.target_id });
      p.target_id = p.analysis.target_id ?? p.target_id;
      p.target_revision = p.target_id ? this.db.getRow(p.target_id)?.revision : undefined;
      p.state = "pending";
      this.proposals.savePending(p);
      return p;
    });
  }

  /** Prévia do resultado de uma resolução (sem escrever). */
  async preview(id: string, resolution: Resolution, targetId?: string): Promise<{ before?: string; after: string; notes: string[] }> {
    const p = this.getProposal(id);
    const tid = targetId ?? p.target_id ?? p.analysis.target_id;
    if (resolution === "complement" || resolution === "update") {
      if (!tid) throw new BrainError("invalid", `${resolution} requer alvo`);
      const t = this.loadNote(tid);
      if (resolution === "complement") return { before: t.body, after: complementBody(t.body, p, isHistorical(p.freshness)), notes: [] };
      if (p.maintenance) { const same = p.draft.body.trim() === t.body.trim(); return { before: t.body, after: same ? t.body : p.draft.body, notes: [same ? `corpo mantido${p.maintenance.kind === "title" ? `; título: "${t.title}" → "${p.draft.title}"` : "; validade renovada na data do aceite"}` : "corpo substituído pelo rascunho editado"] }; }
      const m = mergeUpdate(t.body, p.draft.body, `${day()} (${p.proposed_by.name})`, { keepHistory: this.config.governance.keep_history_section });
      return { before: t.body, after: m.body, notes: [`${m.replaced} linha(s) substituída(s), ${m.appended} sentença(s) nova(s) anexada(s)`] };
    }
    return { after: p.draft.body, notes: [] };
  }

  /** Aplica a decisão do revisor. Única porta de escrita para conhecimento vindo de propostas. */
  async resolve(id: string, input: ResolveInput, who: Principal): Promise<{ proposal: Proposal; note?: Note; commit?: string }> {
    if (!isPrincipal(who)) authorize(who, "decide", { config: this.config }); // falha cedo, antes do lock
    return this.write(async () => this.resolveLocked(this.getProposal(id), input, who));
  }

  /**
   * Miolo do `resolve`, para quem JÁ está dentro do `write()` (o lock não é reentrante). `freshAnalysis`: a análise de `p` acabou
   * de ser feita sob a política atual (gravação automática do propose), então não precisa ser refeita para autorizar.
   */
  private async resolveLocked(p: Proposal, input: ResolveInput, who: Principal, opts: { freshAnalysis?: boolean } = {}): Promise<{ proposal: Proposal; note?: Note; commit?: string }> {
    const tid = input.target_id ?? p.target_id ?? p.analysis.target_id;
    const trow = tid ? this.db.getRow(tid) : undefined;
    // `additive`: a decisão de um agente é autorizada contra uma classificação SEM confiança na dica, refeita agora. A análise
    // gravada pode ser de quando o vault confiava na dica (ex.: sob `never`, `intent: complement` mascarava um valor divergente).
    // Só a autorização usa a reclassificação: a proposta (e a revision registrada, que detecta mudança concorrente) fica intacta.
    let authzView = p;
    if (!opts.freshAnalysis && isPrincipal(who) && who.kind === "agent" && this.config.agents.commit_policy === "additive" && (p.state === "pending" || p.state === "stale")) {
      authzView = { ...p, analysis: await this.analyze({ ...p.draft, intent: p.intent, target_id: p.target_id && this.db.getRow(p.target_id) ? p.target_id : undefined }) };
    }
    // a política vale para QUALQUER adapter: quem decide é a identidade (ator + canal), não um parâmetro do chamador
    const actor = authorize(who, "decide", { config: this.config, proposal: authzView, resolution: input.resolution, ...(trow ? { target: { id: trow.id, type: trow.type } } : {}) });
    const via = actor.kind === "agent" ? "agent" : "review";
    if (p.state === "accepted" || p.state === "ignored") throw new BrainError("invalid", "proposta já decidida");
    if (input.note && scanSecrets(input.note).length) throw new BrainError("secret_detected", "a nota da decisão contém possível segredo");
    // corpo final escrito à mão é edição do revisor: nunca de agente (complemento/atualização calculados só pelo Core)
    if (input.final_body !== undefined && !isHumanReviewer(actor)) throw new BrainError("forbidden", "final_body é exclusivo do revisor humano");
    const r = input.resolution;
    // conhecimento HISTÓRICO não pode reescrever/substituir conhecimento ATUAL sem o revisor declarar explicitamente que ele é atual
    // (alvo já histórico/arquivado não tem o que proteger)
    const targetActive = !!tid && this.db.getRow(tid)?.status === "active";
    if ((r === "update" || r === "replace") && targetActive && (input.as_historical === true || (isHistorical(p.freshness) && input.as_historical !== false)))
      throw new BrainError("invalid", `a verificação indica que esta proposta é histórica (${p.freshness?.stale_from ?? p.freshness?.state ?? "histórica"}): use "complementar" (anexa como Histórico) ou "criar" como histórico; para usá-la como estado atual, envie as_historical=false`);
    const paths: string[] = [];
    let result: Note | undefined; let msg: string;
    if (r === "ignore") { msg = `brain: ignore proposal "${p.draft.title}"`; }
    else {
      if (["complement", "update", "replace"].includes(r)) {
        if (!tid) throw new BrainError("invalid", `${r} requer target_id`);
        const cur = this.db.getRow(tid);
        if (!cur) throw new BrainError("not_found", `alvo ${tid} não existe`);
        const expected = tid === p.target_id ? p.target_revision : p.analysis.matches.find((m) => m.id === tid)?.revision;
        if (expected && expected !== cur.revision) {
          p.state = "stale"; this.proposals.savePending(p);
          throw new BrainError("conflict_revision", `"${tid}" mudou desde a análise (${expected} → ${cur.revision}); reanalise a proposta`, { expected, actual: cur.revision });
        }
      }
      switch (r) {
        case "create": case "keep_separate": {
          const n = this.buildNote(p, actor, via, input.as_historical ?? isHistorical(p.freshness));
          if (r === "keep_separate" && tid && this.db.getRow(tid)) n.relations = { related_to: [tid] };
          paths.push(...this.persistNew(n)); result = n; msg = `brain: add ${n.type} "${n.title}"`; break;
        }
        case "complement": case "update": {
          const t = this.loadNote(tid!);
          // manutenção não faz merge heurístico: corpo igual = mantém; corpo editado pelo revisor ("Alterar") = substitui o corpo
          const maint = !!p.maintenance && r === "update";
          const body = input.final_body ?? (maint ? (p.draft.body.trim() === t.body.trim() ? t.body : p.draft.body) : r === "complement" ? complementBody(t.body, p, input.as_historical ?? isHistorical(p.freshness)) : mergeUpdate(t.body, p.draft.body, `${day()} (${p.proposed_by.name})`, { keepHistory: this.config.governance.keep_history_section }).body);
          this.assertBodySafe(body);
          const upd: Note = { ...t, body, tags: dedupe([...t.tags, ...p.draft.tags]), updated_at: now(), source: t.source ?? p.draft.source,
            // manutenção: título melhor (mesmo id/arquivo) e revalidação do conhecimento temporal (nova data de validade)
            ...(p.maintenance?.kind === "title" && r === "update" ? { title: p.draft.title } : {}),
            // revalidação confirmada: a validade passa a ser a data do ACEITE (não a da proposta)
            ...(p.draft.temporal && r === "update" ? { temporal: p.maintenance?.kind === "revalidate" ? { ...p.draft.temporal, as_of: day() } : p.draft.temporal } : {}) };
          paths.push(...this.persistExisting(t, upd)); result = upd; msg = `brain: ${r} ${t.type} "${t.title}"`; break;
        }
        case "replace": {
          const old = this.loadNote(tid!);
          const n = this.buildNote(p, actor, via, false);
          n.project = n.project ?? old.project; n.relations = { supersedes: [old.id] };
          const upd: Note = { ...old, status: "superseded", updated_at: now(), relations: addRel(old.relations, "superseded_by", n.id) };
          this.preflight(old, upd); // valida a nota antiga ANTES de gravar a nova (sem efeito parcial)
          paths.push(...this.persistNew(n), ...this.persistExisting(old, upd));
          result = n; msg = `brain: replace "${old.title}" with "${n.title}"`; break;
        }
        default: throw new BrainError("invalid", `resolução desconhecida: ${r as string}`);
      }
    }
    p.state = r === "ignore" ? "ignored" : "accepted";
    p.decided = { at: now(), by: { kind: actor.kind, name: actor.name }, resolution: r, target_id: tid, result_id: result?.id, note: input.note };
    paths.push(this.proposals.saveDecided(p));
    // texto livre (título no assunto, nomes, nota) sempre em uma linha: não pode forjar trailers (ver oneLine)
    const trailers = `\n\nBrain-Proposal: ${p.id}\nBrain-Proposed-By: ${p.proposed_by.kind}/${oneLine(p.proposed_by.name)}\nBrain-Decided-By: ${actor.kind}/${oneLine(actor.name)}\nBrain-Channel: ${actor.channel}\nBrain-Resolution: ${r}${input.note ? `\nBrain-Note: ${oneLine(input.note)}` : ""}`;
    // o hash NÃO é regravado no JSON decidido: um commit não pode conter o próprio hash, e regravar deixava o arquivo sujo no
    // vault depois de toda decisão. A UI obtém o commit pelo git log do arquivo (proposalView).
    p.decided.commit = await this.commit(paths, oneLine(msg!) + trailers, actor);
    for (const f of new Set(paths)) if (f.endsWith(".md") && this.vault.fileExists(f)) await this.indexer.indexPath(f);
    this.log(actor, "resolve", result?.id ?? tid ?? p.id, { proposal: p.id, resolution: r, via, channel: actor.channel, commit: p.decided.commit });
    if (result) await this.refreshPending(result, p.id);
    return { proposal: p, note: result, commit: p.decided.commit };
  }

  /** Elegível para aprovação em lote: classe new + confiança alta + sem semelhantes. */
  static bulkEligible(p: Proposal, candidateThreshold = 0.42): boolean {
    return p.state === "pending" && p.analysis.classification === "new" && p.draft.confidence === "high" && !p.analysis.matches.some((m) => m.similarity >= candidateThreshold) && freshForBulk(p.freshness);
  }

  /** Aprova em lote propostas classificadas como "new" (sem semelhantes): cria cada nota e faz UM commit. Qualquer outra classe é recusada. */
  async approveMany(ids: string[], who: Principal): Promise<{ created: Array<{ id: string; title: string }>; skipped: Array<{ id: string; reason: string }>; commit?: string }> {
    // lote é SEMPRE humano: nem a política opcional por tipo libera aprovação em lote para agentes
    const actor = authorize(who, "admin", { config: this.config });
    return this.write(async () => {
      const paths: string[] = []; const created: Array<{ id: string; title: string }> = []; const skipped: Array<{ id: string; reason: string }> = [];
      let failure: unknown;
      try {
      for (const id of ids.slice(0, 200)) {
        const p = this.proposals.get(id);
        if (!p) { skipped.push({ id, reason: "não existe" }); continue; }
        if (p.state !== "pending") { skipped.push({ id, reason: `estado ${p.state}` }); continue; }
        if (p.analysis.classification !== "new") { skipped.push({ id, reason: `classe ${p.analysis.classification}: decida individualmente` }); continue; }
        if (p.maintenance) { skipped.push({ id, reason: "manutenção (revalidação/título): decida individualmente" }); continue; }
        // proteção da aprovação em lote: só confiança ALTA e nenhum candidato semelhante (mesmo abaixo do limiar de duplicata)
        if (p.draft.confidence !== "high") { skipped.push({ id, reason: `confiança ${p.draft.confidence ?? "não declarada"}: revise individualmente (lote exige confiança alta)` }); continue; }
        if (p.analysis.matches.some((m) => m.similarity >= this.config.governance.candidate_threshold)) { skipped.push({ id, reason: "há conhecimento semelhante: decida individualmente" }); continue; }
        // atualidade incerta/histórica nunca entra em lote: a extração pode ser alta e a afirmação estar desatualizada
        if (!freshForBulk(p.freshness)) { skipped.push({ id, reason: `atualidade ${p.freshness!.state} (confiança ${p.freshness!.confidence}): revise individualmente` }); continue; }
        // reanalisa contra o índice ATUAL (notas criadas neste mesmo lote contam): impede near-duplicatas aprovadas juntas
        const fresh = await this.analyze({ ...p.draft, intent: p.intent });
        if (fresh.classification !== "new") { p.analysis = fresh; p.target_id = fresh.target_id ?? p.target_id; p.target_revision = p.target_id ? this.db.getRow(p.target_id)?.revision : undefined; this.proposals.savePending(p); skipped.push({ id, reason: `agora é ${fresh.classification} de "${fresh.matches[0]?.title ?? "?"}": decida individualmente` }); continue; }
        const n = this.buildNote(p, actor, "review", false);
        paths.push(...this.persistNew(n));
        await this.indexer.indexPath(n.path); // garante unicidade de ids dentro do lote
        p.state = "accepted"; p.decided = { at: now(), by: { kind: actor.kind, name: actor.name }, resolution: "create", result_id: n.id, note: "aprovação em lote" };
        paths.push(this.proposals.saveDecided(p)); created.push({ id: n.id, title: n.title });
        this.log(actor, "resolve", n.id, { proposal: p.id, resolution: "create", via: "bulk" });
      }
      } catch (e) { failure = e; } // o que já foi gravado precisa ser commitado/indexado mesmo assim (sem arquivos órfãos)
      const commit = created.length ? await this.commit(paths, `brain: add ${created.length} note${created.length > 1 ? "s" : ""} (bulk approve)\n\n${created.map((c) => `- ${oneLine(c.title)}`).join("\n")}\n\nBrain-Decided-By: ${actor.kind}/${oneLine(actor.name)}\nBrain-Channel: ${actor.channel}\nBrain-Resolution: create`, actor) : undefined;
      if (failure) { skipped.push({ id: "(lote)", reason: `interrompido: ${(failure as Error).message}` }); }
      return { created, skipped, commit };
    });
  }

  /** Ignora várias propostas pendentes em UMA operação (um commit). Útil para duplicatas vindas de importação. */
  async ignoreMany(ids: string[], note: string | undefined, who: Principal): Promise<{ ignored: number; commit?: string }> {
    const actor = authorize(who, "admin", { config: this.config });
    if (note && scanSecrets(note).length) throw new BrainError("secret_detected", "a nota da decisão contém possível segredo");
    return this.write(async () => {
      const paths: string[] = []; let n = 0;
      for (const id of ids.slice(0, 500)) {
        const p = this.proposals.get(id);
        if (!p || (p.state !== "pending" && p.state !== "stale")) continue;
        p.state = "ignored"; p.decided = { at: now(), by: { kind: actor.kind, name: actor.name }, resolution: "ignore", note };
        paths.push(this.proposals.saveDecided(p)); n++;
        this.log(actor, "resolve", p.id, { proposal: p.id, resolution: "ignore", via: "bulk" });
      }
      const commit = n ? await this.commit(paths, `brain: ignore ${n} proposal${n > 1 ? "s" : ""}\n\nBrain-Decided-By: ${actor.kind}/${oneLine(actor.name)}\nBrain-Channel: ${actor.channel}\nBrain-Resolution: ignore${note ? `\nBrain-Note: ${oneLine(note)}` : ""}`, actor) : undefined;
      return { ignored: n, commit };
    });
  }

  /** Depois que o conhecimento muda, propostas pendentes sobre o mesmo assunto ganham análise nova (ex.: a 2ª proposta idêntica vira "duplicate"). */
  private async refreshPending(changed: Note, except: string): Promise<void> {
    const ct = new Set(tokenize(plain(`${changed.title} ${changed.body}`)));
    for (const o of this.proposals.list("pending").slice(0, 200)) {
      if (o.id === except || o.state !== "pending") continue;
      // proposta cujo ALVO acabou de mudar: não avançamos a revision (isso anularia a proteção). Fica stale até reanálise explícita.
      if (o.target_id === changed.id) { o.state = "stale"; this.proposals.savePending(o); continue; }
      const touches = o.target_id === changed.id || o.analysis.matches.some((m) => m.id === changed.id) || jaccard(ct, new Set(tokenize(plain(`${o.draft.title} ${o.draft.body}`)))) >= 0.35;
      if (!touches) continue;
      const hadTarget = !!(o.target_id && this.db.getRow(o.target_id));
      o.analysis = await this.analyze({ ...o.draft, intent: o.intent, target_id: hadTarget ? o.target_id : undefined });
      if (!hadTarget) { o.target_id = o.analysis.target_id ?? o.target_id; o.target_revision = o.target_id ? this.db.getRow(o.target_id)?.revision : undefined; }
      this.proposals.savePending(o);
    }
  }

  private buildNote(p: Proposal, actor: Principal, via: string, historical = false): Note {
    const d = p.draft;
    const id = this.idFor(d);
    const f = p.freshness;
    const n: Note = {
      id, title: d.title, type: d.type, status: historical ? "superseded" : "active", project: d.project, tags: d.tags,
      created_at: now(), updated_at: now(), source: d.source, confidence: d.confidence,
      ...(f ? { verification: { state: historical && !HISTORICAL_STATES.includes(f.state) ? "historical" : f.state, confidence: f.confidence, ...(f.against ? { against: `${f.against.repo}@${f.against.commit}` } : {}), checked_at: f.checked_at.slice(0, 10) } } : {}),
      ...(d.temporal ? { temporal: d.temporal } : {}),
      created_by: p.proposed_by.kind === "system" ? { kind: actor.kind, name: actor.name } : p.proposed_by, relations: {},
      body: d.body, path: "", revision: "",
    };
    n.path = this.vault.pathFor(n);
    void via;
    return n;
  }

  private assertBodySafe(body: string) {
    const s = scanSecrets(body);
    if (s.length) throw new BrainError("secret_detected", `possível segredo detectado (${s.map((x) => x.kind).join(", ")})`, s);
  }

  private persistNew(n: Note): string[] {
    n.path = this.vault.pathFor(n);
    if (this.vault.fileExists(n.path)) throw new BrainError("duplicate_id", `arquivo já existe: ${n.path}`);
    this.vault.writeAtomic(n.path, serializeNote(n));
    return [n.path];
  }
  /** Checagens que precisam passar ANTES de qualquer escrita (colisão de destino e segredo). */
  private preflight(before: Note, after: Note): void {
    const newPath = this.vault.pathFor(after);
    if (newPath !== before.path && this.vault.fileExists(newPath)) throw new BrainError("duplicate_id", `já existe outro arquivo em ${newPath}; nada foi alterado`);
    const sec = scanSecrets(serializeNote(after));
    if (sec.length) throw new BrainError("secret_detected", `a nota "${after.id}" contém possível segredo (${[...new Set(sec.map((x) => x.kind))].join(", ")}); remova do arquivo antes de alterá-la`, sec);
  }
  private persistExisting(before: Note, after: Note): string[] {
    const newPath = this.vault.pathFor(after);
    this.preflight(before, after);
    this.vault.writeAtomic(before.path, serializeNote(after));
    const paths = [before.path];
    if (newPath !== before.path) { this.vault.move(before.path, newPath); paths.push(newPath); after.path = newPath; }
    return paths;
  }

  private async commit(paths: string[], message: string, actor: Actor | Principal): Promise<string | undefined> {
    if (!this.config.git.auto_commit) return undefined;
    return this.git.commitPaths(paths, message, actor.kind === "agent" ? { name: actor.name, email: `${slugify(actor.name)}@agents.local` } : undefined);
  }

  // ---------- escrita direta (humano / UI / CLI) ----------
  async createNote(d: DraftInput, who: Principal, opts: { id?: string; relations?: Note["relations"] } = {}): Promise<Note> {
    const actor = authorize(who, "write", { config: this.config });
    this.assertSeedOnlyInDemo(actor);
    if (d.temporal) TemporalOk(d.temporal);
    this.validateDraft(d);
    return this.write(async () => {
      const id = opts.id ? this.uniqueIdOrFail(opts.id) : this.idFor(d);
      const n: Note = { id, title: d.title.trim(), type: d.type, status: "active", project: d.project, tags: dedupe(d.tags ?? []), created_at: now(), updated_at: now(), source: d.source ?? { type: "manual" }, confidence: d.confidence, ...(d.temporal ? { temporal: d.temporal } : {}), created_by: { kind: actor.kind, name: actor.name }, relations: opts.relations ?? {}, body: d.body.trim() + "\n", path: "", revision: "" };
      const paths = this.persistNew(n);
      const commit = await this.commit(paths, `brain: add ${n.type} "${oneLine(n.title)}"\n\nBrain-Actor: ${actor.kind}/${oneLine(actor.name)}`, actor);
      const saved = await this.indexer.indexPath(n.path);
      this.log(actor, "create", n.id, { commit });
      return saved;
    });
  }
  private uniqueIdOrFail(id: string): string {
    if (!isValidId(id)) throw new BrainError("invalid", `id inválido: ${id}`);
    if (this.db.getRow(id)) throw new BrainError("duplicate_id", `id já existe: ${id}`);
    return id;
  }

  /** Edição manual com concorrência otimista: `expected_revision` é obrigatório. */
  async updateNote(id: string, patch: Partial<Pick<Note, "title" | "body" | "tags" | "status" | "project" | "confidence">> & { expected_revision: string; reason?: string }, who: Principal): Promise<Note> {
    const actor = authorize(who, "write", { config: this.config });
    this.assertSeedOnlyInDemo(actor);
    if (patch.title !== undefined && (!patch.title.trim() || patch.title.length > 200)) throw new BrainError("invalid", "título inválido (1–200 caracteres)");
    if (patch.project !== undefined && patch.project !== "" && (!isValidId(patch.project) || patch.project.length > 60)) throw new BrainError("invalid", "slug de projeto inválido");
    if (patch.tags !== undefined && (!Array.isArray(patch.tags) || patch.tags.length > 20 || patch.tags.some((t) => typeof t !== "string" || !t.trim() || t.length > 60))) throw new BrainError("invalid", "tags inválidas");
    if (patch.status !== undefined && !(STATUSES as readonly string[]).includes(patch.status)) throw new BrainError("invalid", "status inválido");
    return this.write(async () => {
      const cur = this.loadNote(id);
      if (cur.revision !== patch.expected_revision) throw new BrainError("conflict_revision", `"${id}" foi alterada por outra pessoa/agente (${patch.expected_revision} → ${cur.revision})`, { expected: patch.expected_revision, actual: cur.revision });
      const next: Note = { ...cur, ...omitUndef({ title: patch.title?.trim(), body: patch.body, tags: patch.tags?.map((t) => t.trim()), status: patch.status, project: patch.project === "" ? undefined : patch.project, confidence: patch.confidence }), updated_at: now() };
      if (patch.project === "") next.project = undefined;
      this.assertBodySafe(`${next.title}\n${next.body}`);
      const paths = this.persistExisting(cur, next);
      const commit = await this.commit(paths, `brain: update ${next.type} "${oneLine(next.title)}"${patch.reason ? `\n\n${patch.reason}` : ""}\n\nBrain-Actor: ${actor.kind}/${oneLine(actor.name)}`, actor);
      const saved = await this.indexer.indexPath(next.path);
      if (cur.path !== next.path) this.db.db.prepare("DELETE FROM notes WHERE path=? AND id!=?").run(cur.path, id);
      this.log(actor, "update", id, { commit, status: patch.status });
      return saved;
    });
  }

  /** Adiciona relação (aditivo). Inverso de supersedes/superseded_by é mantido. */
  async link(src: string, dst: string, type: RelationType, who: Principal): Promise<Note> {
    authorize(who, "link", { config: this.config }); // falha cedo
    if (!(RELATION_TYPES as readonly string[]).includes(type)) throw new BrainError("invalid", `relação inválida: ${type}`);
    if (src === dst) throw new BrainError("invalid", "não relacione uma nota consigo mesma");
    // supersedes muda o STATUS de outra nota (tira do contexto): mesmo com can_link, agente só propõe (brain_supersede)
    if (who.kind === "agent" && (type === "supersedes" || type === "superseded_by")) throw new BrainError("forbidden", "substituição exige revisão humana: use brain_supersede (vira proposta)");
    return this.write(async () => {
      // reautoriza DENTRO do lock, com a política recém-relida (revogar can_link noutro processo vale já)
      const actor = authorize(who, "link", { config: this.config });
      this.assertSeedOnlyInDemo(actor);
      if (!this.db.getRow(dst)) throw new BrainError("not_found", `destino "${dst}" não existe`);
      const a = this.loadNote(src);
      if (a.relations[type]?.includes(dst)) return a;
      const next: Note = { ...a, relations: addRel(a.relations, type, dst), updated_at: now() };
      let other: { b: Note; nb: Note } | undefined;
      if (type === "supersedes") { const b = this.loadNote(dst); other = { b, nb: { ...b, status: "superseded", relations: addRel(b.relations, "superseded_by", src), updated_at: now() } }; }
      this.preflight(a, next); if (other) this.preflight(other.b, other.nb); // nada é gravado se qualquer lado falhar
      const paths = this.persistExisting(a, next);
      if (other) paths.push(...this.persistExisting(other.b, other.nb));
      // o desfazer captura acha este commit pelo autor + primeiro `Brain-Actor` do bloco final: nenhum texto livre em várias linhas
      const commit = await this.commit(paths, `${oneLine(`brain: link ${src} ${type} ${dst}`)}\n\nBrain-Actor: ${actor.kind}/${oneLine(actor.name)}`, actor);
      for (const p of paths) await this.indexer.indexPath(p);
      this.log(actor, "link", src, { dst, type, commit });
      return this.loadNote(src);
    });
  }

  /** Atualiza config.yaml (validado). Trocar de provider invalida vetores e reembute. */
  async updateConfig(patch: Record<string, unknown>, who: Principal): Promise<BrainConfig> {
    const actor = authorize(who, "admin", { config: this.config });
    return this.write(async () => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new BrainError("invalid", "a configuração deve ser um objeto");
      const merged = deepMerge(this.config as unknown as Record<string, unknown>, patch);
      const r = ConfigSchema.safeParse(merged);
      // o campo e o tipo esperado, nunca o valor recebido (a mensagem volta para a UI)
      if (!r.success) throw new BrainError("invalid", `configuração inválida: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`).join("; ")}`);
      const next = r.data;
      writeFileSync(this.vault.configPath, dumpConfig(next), "utf8");
      const providerChanged = JSON.stringify(next.embeddings) !== JSON.stringify(this.config.embeddings);
      this.config = next;
      if (providerChanged) { this._embedder = this.makeEmbedder(); await this.indexer.embedMissing(); }
      this.log(actor, "config_update", null, { keys: Object.keys(patch) });
      return next;
    });
  }

  /**
   * Grava (ou remove, com `null`) uma entrada do bloco `modules`. Substitui o bloco inteiro: o `deepMerge` do updateConfig não
   * remove chaves. Com uma função, ela recebe a entrada atual lida DENTRO do lock (edições concorrentes não se perdem) e devolve a
   * nova (ou `null`); um erro lançado por ela cancela a gravação e propaga. `acao` é o rótulo da auditoria (`config_update`)
   * que a API conhece (ligar, desligar...); uma função o decide pela entrada antes e depois, lidas dentro do lock. Sem ela, o
   * rótulo genérico (`adicionar`, `atualizar`, `remover`). Numa atualização, a auditoria diz também se a config e o host
   * mudaram (um rótulo só perderia a config de um "ligar com config nova").
   */
  async setModuleEntry(id: string, entry: ModuleEntry | null | ((atual: ModuleEntry | undefined) => ModuleEntry | null), who: Principal, acao?: AcaoDeModulo | ((antes: ModuleEntry | undefined, depois: ModuleEntry | null) => AcaoDeModulo)): Promise<BrainConfig> {
    const actor = authorize(who, "admin", { config: this.config });
    if (!MODULE_ID_RE.test(id)) throw new BrainError("invalid", `id de módulo inválido: "${id}"`);
    return this.write(async () => {
      // `write` já relê o config.yaml do disco dentro do lock: edições manuais posteriores à subida são preservadas.
      // Mas o reload engole config inválido e mantém a antiga: regravar a partir dela apagaria a edição do usuário.
      try { loadConfig(this.vault.configPath); }
      catch { throw new BrainError("invalid", "o .brain/config.yaml tem um erro de edição; corrija-o antes de mudar os módulos"); }
      const modules = new Map(Object.entries(this.config.modules));
      const antes = modules.get(id);
      const proxima = typeof entry === "function" ? entry(antes) : entry;
      const rotulo = typeof acao === "function" ? acao(antes, proxima) : acao ?? (proxima === null ? "remover" : antes ? "atualizar" : "adicionar");
      if (proxima === null) modules.delete(id); else modules.set(id, proxima);
      const next = ConfigSchema.parse({ ...this.config, modules: Object.fromEntries(modules) });
      writeFileSync(this.vault.configPath, dumpConfig(next), "utf8");
      this.config = next;
      this.log(actor, "config_update", null, { modulo: id, acao: rotulo, ...(antes && proxima ? mudancasDaEntrada(antes, proxima) : {}) });
      return next;
    });
  }

  // ---------- Git ----------
  async commitPending(message: string | undefined, who: Principal) {
    return this.commitDirty(message, authorize(who, "admin", { config: this.config }));
  }
  /** Edições manuais (Obsidian) detectadas pelo watcher, quando o humano ligou `git.auto_commit_external`: o gatilho é o sistema de
   *  arquivos, não um chamador — por isso não há identidade a autorizar (e nada além de knowledge/ sujo é commitado). */
  async commitExternalEdits() {
    this.reloadConfig();
    if (!this.config.git.auto_commit_external) throw new BrainError("forbidden", "git.auto_commit_external está desligado: edições manuais são commitadas pelo revisor (brain admin commit)");
    return this.commitDirty("brain: sync manual edits", WATCHER, true);
  }
  /** O canal "seed" só escreve num vault DEMO (marcador criado por `brain seed`): nunca no vault real. */
  private assertSeedOnlyInDemo(who: Principal) {
    if (who.channel === "seed" && !existsSync(join(this.vault.root, ".brain", "DEMO"))) throw new BrainError("forbidden", "o seed só escreve em vault DEMO");
  }
  private async commitDirty(message: string | undefined, actor: Principal, requireExternalOptIn = false) {
    return this.write(async () => {
      // o revisor pode ter desligado o opt-in enquanto esperávamos o lock: a config é relida dentro do lock
      if (requireExternalOptIn && !this.config.git.auto_commit_external) throw new BrainError("forbidden", "git.auto_commit_external foi desligado");
      const all = await this.git.dirty("knowledge");
      // nunca commitar (e portanto nunca versionar/propagar) arquivos editados à mão que contenham segredo
      const flagged = new Set<string>();
      for (const f of all) { try { if (f.endsWith(".md") && scanSecrets(this.vault.readRaw(f)).length) flagged.add(f); } catch { /* arquivo sumiu */ } }
      const dirty = all.filter((f) => !flagged.has(f)); const skipped = all.filter((f) => flagged.has(f));
      if (!dirty.length) return { commit: undefined, files: [] as string[], skipped };
      const commit = await this.git.commitPaths(dirty, message ?? `brain: sync manual edits (${dirty.length} file${dirty.length > 1 ? "s" : ""})`);
      this.log(actor, "git_commit", null, { files: dirty.length, commit, skipped: skipped.length });
      return { commit, files: dirty, skipped };
    });
  }
  async revertCommit(rev: string, who: Principal) {
    const actor = authorize(who, "admin", { config: this.config });
    return this.write(async () => { const c = await this.git.revert(rev); await this.indexer.sync({ force: true }); this.log(actor, "git_revert", null, { rev, commit: c }); return c; });
  }

  /**
   * Desfaz uma captura do assistente: reverte (do mais novo para o mais antigo, como uma operação só) os commits das decisões
   * automáticas do agente da captura, achados pelo trailer `Brain-Decided-By: agent/assistant/<id>` que o `resolve` grava, e
   * as relações que ele criou com `brain_link` (trailer `Brain-Actor: agent/assistant/<id>`), e marca a entrada como `desfeita`. O humano do desktop (canal `desktop`) só desfaz capturas feitas pelo desktop; o revisor,
   * qualquer uma. Propostas da captura que ficaram na fila NÃO são apagadas aqui (seguem para a revisão). Se uma nota foi
   * alterada depois da captura, nada é revertido e a captura continua como estava.
   */
  async undoCapture(captureId: string, who: Principal): Promise<{ reverted: string[] }> {
    const actor = authorize(who, "assist", { config: this.config });
    if (typeof captureId !== "string" || !CAPTURE_ID.test(captureId)) throw new BrainError("not_found", `captura ${String(captureId)} não existe`);
    const captures = new CaptureLog(this);
    return this.write(async () => {
      const entry = captures.get(captureId);
      if (!entry) throw new BrainError("not_found", `captura ${captureId} não existe`);
      if (actor.channel === "desktop" && entry.origin !== "desktop") throw new BrainError("forbidden", "o atalho desktop só desfaz capturas feitas pelo desktop; esta veio da UI (desfaça pela revisão)");
      if (entry.state === "desfeita") return { reverted: [] };
      // `pendente` = o motor ainda pode estar gravando (ou vai reprocessar): reverter agora disputaria com ele
      if (entry.state === "pendente") throw new BrainError("locked", "captura ainda em processamento; tente de novo em instantes");
      // sem commits automáticos não há o que reverter, e marcar `desfeita` mentiria: as notas continuariam no vault
      if (!this.config.git.auto_commit) throw new BrainError("invalid", "desfazer captura exige git.auto_commit ligado (o desfazer reverte os commits da captura)");
      // só commits cujo AUTOR é o agente da captura (o `commit()` grava o nome do principal cunhado como autor) e cujo trailer
      // verdadeiro (o primeiro do bloco final) é o dele; texto livre na mensagem não basta
      const agent = `assistant/${captureId}`;
      // decisões automáticas (`Brain-Decided-By`) e relações criadas com brain_link (`Brain-Actor`): um só log, do mais novo ao mais antigo
      const commits = await this.git.commitsByTrailer([["Brain-Decided-By", `agent/${agent}`], ["Brain-Actor", `agent/${agent}`]], agent);
      try { await this.git.revertAll(commits); }
      catch (e) {
        const conflicted = ((e as BrainError).details as { conflicted?: string[] } | undefined)?.conflicted ?? [];
        if (!conflicted.length) throw new BrainError("git_error", `não foi possível desfazer a captura ${captureId}: ${(e as Error).message}`);
        const names = conflicted.map((p) => (p.startsWith("knowledge/") && p.endsWith(".md") ? p.slice(p.lastIndexOf("/") + 1, -3) : p));
        throw new BrainError("conflict_revision", names.length > 1
          ? `as notas ${names.join(", ")} foram alteradas depois; desfaça pela revisão`
          : `a nota ${names[0]} foi alterada depois; desfaça pela revisão`, { conflicted });
      }
      if (commits.length) await this.indexer.sync({ force: true });
      await captures.markLocked(captureId, "desfeita");
      this.log(actor, "capture_undo", null, { capture: captureId, reverted: commits, channel: actor.channel });
      return { reverted: commits };
    });
  }

  async reindex(force = true) { const r = await this.indexer.sync({ force }); this.log(this.defaultActor, "reindex", null, { ...counts(r) }); return r; }

  // ---------- visões agregadas ----------
  /**
   * Cópias de conflito do OneDrive: `<base>-<SUFIXO>.md` ao lado de `<base>.md` (sufixo só de dígitos é colisão de id, não
   * conflito). Um id que estende outro (`fact-timeout-do-lote-noturno` ao lado de `fact-timeout-do-lote`) é nota legítima: só é
   * acusada (a) a cópia com o MESMO `id` no frontmatter que a original (é o que o OneDrive copia), ou (b) o arquivo cujo nome
   * não é o próprio id e cujo sufixo tem letra maiúscula (nome de máquina; um id válido nunca tem maiúscula).
   */
  private syncConflictCopies(): Array<{ kind: "sync_conflict_copy"; path: string; original: string; message: string }> {
    const files = this.vault.listFiles();
    const byLower = new Map(files.map((f) => [f.toLowerCase(), f]));
    const ids = new Map<string, string | undefined>();
    const idOf = (path: string) => {
      if (!ids.has(path)) { let id: string | undefined; try { id = frontmatterId(this.vault.readRaw(path)); } catch { /* sumiu */ } ids.set(path, id); }
      return ids.get(path);
    };
    const out: Array<{ kind: "sync_conflict_copy"; path: string; original: string; message: string }> = [];
    for (const path of files) {
      const slash = path.lastIndexOf("/");
      const dir = path.slice(0, slash + 1);
      const name = path.slice(slash + 1, -3);
      for (let i = name.lastIndexOf("-"); i > 0; i = name.lastIndexOf("-", i - 1)) {
        const suffix = name.slice(i + 1);
        if (!/^[A-Za-z0-9_-]{2,40}$/.test(suffix) || /^[0-9]+$/.test(suffix)) continue;
        const original = byLower.get(`${dir}${name.slice(0, i)}.md`.toLowerCase());
        if (!original) continue;
        const own = idOf(path);
        const sameId = own !== undefined && own === idOf(original);
        const machine = own !== name && /[A-Z]/.test(suffix);
        if (!sameId && !machine) continue;
        out.push({ kind: "sync_conflict_copy", path, original, message: `cópia de conflito do OneDrive: junte em ${original} (proponha um complemento)` });
        break;
      }
    }
    return out;
  }

  async health() {
    await this.sync({ maxAgeMs: 1000 });
    const total = (this.db.db.prepare("SELECT COUNT(*) n FROM notes").get() as { n: number }).n;
    const withEmb = (this.db.db.prepare("SELECT COUNT(*) n FROM embeddings WHERE provider=?").get(this._embedder.id) as { n: number }).n;
    const issues = (this.db.db.prepare("SELECT id,path,issues FROM notes WHERE issues != '[]'").all() as Array<{ id: string; path: string; issues: string }>).map((r) => ({ id: r.id, path: r.path, issues: JSON.parse(r.issues) as string[] }));
    const dangling = (this.db.db.prepare("SELECT l.src,l.dst,l.type FROM links l LEFT JOIN notes n ON n.id=l.dst WHERE n.id IS NULL").all() as Array<{ src: string; dst: string; type: string }>);
    const dupes = this.db.db.prepare("SELECT path,id FROM dupes").all() as Array<{ path: string; id: string }>;
    const repo = await this.git.isRepo();
    const dirty = repo ? await this.git.dirty("knowledge") : [];
    const conflictCopies = this.syncConflictCopies();
    const avisoDaChave = this.avisoDaChaveDeEmbeddings();
    return {
      vault: this.vault.root, git: { repo, head: repo ? await this.git.head() : undefined, dirty_files: dirty.length, auto_commit: this.config.git.auto_commit },
      index: { notes: total, db: this.vault.dbPath, schema: this.db.getMeta("schema_version") },
      embeddings: { provider: this._embedder.id, external: this._embedder.external, covered: withEmb, total, ok: withEmb >= total, ...(avisoDaChave ? { aviso: avisoDaChave } : {}) },
      search: { fts5: true, semantic: withEmb > 0 },
      problems: { notes_with_issues: issues.length, dangling_links: dangling.length, duplicate_ids: dupes.length, sync_conflict_copies: conflictCopies.length },
      details: { issues: issues.slice(0, 50), dangling: dangling.slice(0, 50), duplicate_ids: dupes, sync_conflict_copies: conflictCopies.slice(0, 50) },
      pending_proposals: this.proposals.list("pending").length,
      ok: repo && dupes.length === 0,
    };
  }

  async dashboard() {
    await this.sync({ maxAgeMs: 1000 });
    const today = day();
    const total = (this.db.db.prepare("SELECT COUNT(*) n FROM notes WHERE status!='archived'").get() as { n: number }).n;
    const byType = Object.fromEntries((this.db.db.prepare("SELECT type,COUNT(*) n FROM notes WHERE status!='archived' GROUP BY type").all() as Array<{ type: string; n: number }>).map((r) => [r.type, r.n]));
    const pending = this.proposals.list("pending");
    const staleCut = new Date(Date.now() - this.config.governance.stale_days * 864e5).toISOString();
    const stale = this.db.rows("status='active' AND type IN ('fact','decision','learning','pattern') AND updated_at<?", [staleCut], "updated_at ASC", 20).map(rowSummary);
    const act = this.db.activity({ since: today, limit: 2000 });
    const used = this.db.db.prepare(`SELECT target_id id, COUNT(*) n FROM activity WHERE action IN ('retrieved','read') AND ts>=? AND target_id IS NOT NULL GROUP BY target_id ORDER BY n DESC LIMIT 8`).all(new Date(Date.now() - 30 * 864e5).toISOString()) as Array<{ id: string; n: number }>;
    const agents = this.db.db.prepare(`SELECT actor_name name, actor_kind kind, COUNT(*) n, MAX(ts) last, SUM(action IN ('search','context','retrieved','read')) reads, SUM(action IN ('propose','resolve','create','update','link')) writes FROM activity GROUP BY actor_name, actor_kind ORDER BY last DESC`).all();
    const projects = (await this.projects()).slice(0, 8);
    return {
      totals: { knowledge: total, projects: (await this.projects()).length, by_type: byType, pending: pending.length },
      today: {
        queries: act.filter((a) => a.action === "search" || a.action === "context").length,
        added: this.db.rows("created_at>=?", [today], "created_at DESC", 1000).length,
        updated: act.filter((a) => ["update", "resolve", "link"].includes(a.action)).length,
        conflicts: pending.filter((p) => p.analysis.classification === "conflict").length,
      },
      projects, recent: (await this.recent({ limit: 8 })),
      needs_review: {
        duplicates: pending.filter((p) => p.analysis.classification === "duplicate").length,
        conflicts: pending.filter((p) => p.analysis.classification === "conflict").length,
        pending: pending.length, stale: stale.length, stale_items: stale.slice(0, 5),
      },
      most_used: used.map((u) => ({ ...u, title: this.db.getRow(u.id)?.title ?? u.id })),
      agents, health: await this.healthSummary(),
    };
  }

  private async healthSummary() {
    const h = await this.health();
    const p = h.problems;
    return { ok: h.ok && p.notes_with_issues + p.dangling_links + p.duplicate_ids + p.sync_conflict_copies === 0, git_dirty: h.git.dirty_files, embeddings_ok: h.embeddings.ok, problems: p, provider: h.embeddings.provider };
  }

  timeline(opts: { limit?: number; since?: string; actor?: string } = {}) {
    return this.db.activity({ limit: opts.limit ?? 100, since: opts.since, actor: opts.actor }).filter((a) => !["retrieved"].includes(a.action));
  }

  /** Inbox = pendentes sem semelhantes (aprovação rápida). Revisão = TODAS as pendentes (filtráveis por classe na UI). */
  inbox() { return this.proposals.list("pending").filter((p) => p.analysis.classification === "new"); }
  reviewQueue() { return this.proposals.list("pending"); }

  async graph(opts: { project?: string } = {}) {
    await this.sync({ maxAgeMs: 1000 });
    const rows = this.db.rows(opts.project ? "project=? AND status!='archived'" : "status!='archived'", opts.project ? [opts.project] : [], "updated_at DESC", 400);
    const ids = new Set(rows.map((r) => r.id));
    const links = this.allLinks().filter((l) => ids.has(l.src) && ids.has(l.dst));
    const { projects, project_links } = await this.projectGraph();
    return { nodes: rows.map(rowSummary), edges: links, projects, project_links: project_links.filter((l) => !opts.project || l.a === opts.project || l.b === opts.project).map((l) => ({ ...l, evidence: l.evidence.slice(0, 5) })) };
  }

  private allLinks() { return this.db.db.prepare("SELECT src,dst,type FROM links").all() as Array<{ src: string; dst: string; type: string }>; }

  /**
   * Projetos (nome curto, visão geral) e ligações entre eles citadas nas notas, com evidência. `confirmed` = já existe relação
   * explícita entre as visões gerais dos dois projetos (em qualquer sentido); sem ela, a ligação é só derivada (sugestão).
   */
  private pgCache?: { key: string; value: Awaited<ReturnType<Brain["computeProjectGraph"]>> };
  /** Recalcula só quando o índice muda (assinatura barata: contagem, mtime/tamanho somados, status e relações). */
  private async projectGraph() {
    await this.sync({ maxAgeMs: 1000 });
    const sig = this.db.db.prepare("SELECT COUNT(*) n, MAX(mtime) m, SUM(size) z, SUM(LENGTH(status)) st, (SELECT COUNT(*) FROM links) l FROM notes").get() as Record<string, number>;
    const key = JSON.stringify(sig);
    if (this.pgCache?.key !== key) this.pgCache = { key, value: await this.computeProjectGraph() };
    return this.pgCache.value;
  }
  private async computeProjectGraph() {
    const projects = (await this.projects()).map((p) => ({ id: p.id, name: p.name, title: p.title, overview_id: p.overview_id }));
    const live = this.db.rows("status NOT IN ('archived','superseded','deprecated')", [], "updated_at DESC", 5000);
    const ov = new Map(projects.map((p) => [p.id, p.overview_id]));
    const rels = this.allLinks();
    const project_links = projectLinks(live, projects, 1000).map((l) => {
      const a = ov.get(l.a); const b = ov.get(l.b);
      const r = a && b ? rels.find((x) => (x.src === a && x.dst === b) || (x.src === b && x.dst === a)) : undefined;
      return { ...l, overview: { a, b }, confirmed: r?.type };
    });
    return { projects, project_links };
  }

  /** Notas de OUTROS projetos que citam `project` (nome ou slug) — as únicas de fora que entram no contexto do projeto. */
  private async projectCiters(project: string): Promise<Set<string>> {
    const { project_links } = await this.projectGraph(); const out = new Set<string>();
    for (const l of project_links) if (l.a === project || l.b === project) for (const id of l.evidence_ids) if (this.db.getRow(id)?.project !== project) out.add(id);
    return out;
  }

  /**
   * Grafo LOCAL de uma nota (vizinhança até `depth` passos). Arestas: `member` (nota ↔ visão geral do seu projeto),
   * `mention` (nota → visão geral do projeto que ela cita, com o trecho) e `relation` (relações explícitas). Limitado a 150 nós.
   */
  async localGraph(id: string, depth = 1) {
    await this.sync({ maxAgeMs: 1000 });
    if (!this.db.getRow(id)) throw new BrainError("not_found", `nota "${id}" não existe`);
    const D = Math.max(1, Math.min(3, Math.trunc(depth) || 1));
    const { projects, project_links } = await this.projectGraph();
    const rows = this.db.rows("status!='archived'", [], "updated_at DESC", 5000); const byId = new Map(rows.map((r) => [r.id, r]));
    if (!byId.has(id)) byId.set(id, this.db.getRow(id)!); // nota arquivada aberta direto: vira o centro mesmo assim
    const ov = new Map(projects.map((p) => [p.id, p.overview_id]));
    type E = { src: string; dst: string; kind: "member" | "mention" | "relation"; type?: string; snippet?: string };
    const edges: E[] = [];
    for (const r of byId.values()) { const o = r.project ? ov.get(r.project) : undefined; if (o && o !== r.id && byId.has(o)) edges.push({ src: r.id, dst: o, kind: "member" }); }
    for (const l of project_links) for (const e of l.evidence) { const o = ov.get(e.to); if (o && byId.has(e.id) && byId.has(o) && o !== e.id) edges.push({ src: e.id, dst: o, kind: "mention", snippet: e.snippet }); }
    for (const l of this.allLinks()) if (byId.has(l.src) && byId.has(l.dst)) edges.push({ src: l.src, dst: l.dst, kind: "relation", type: l.type });
    const adj = new Map<string, string[]>();
    for (const e of edges) { (adj.get(e.src) ?? adj.set(e.src, []).get(e.src)!).push(e.dst); (adj.get(e.dst) ?? adj.set(e.dst, []).get(e.dst)!).push(e.src); }
    const dist = new Map([[id, 0]]); let frontier = [id];
    for (let d = 1; d <= D && dist.size < 150; d++) {
      const next: string[] = [];
      for (const x of frontier) for (const y of adj.get(x) ?? []) if (!dist.has(y) && dist.size < 150) { dist.set(y, d); next.push(y); }
      frontier = next;
    }
    const nodes = [...dist.entries()].map(([nid, d]) => ({ ...rowSummary(byId.get(nid)!), depth: d }));
    const seen = new Set<string>();
    // uma linha por par: A→B e B→A do mesmo tipo (ou supersedes/superseded_by) seriam linhas sobrepostas
    const local = edges.filter((e) => dist.has(e.src) && dist.has(e.dst)).filter((e) => { const pair = e.kind === "relation" ? [e.src, e.dst].sort().join("|") : `${e.src}|${e.dst}`; const k = `${pair}|${e.kind}|${(e.type ?? "").replace("superseded_by", "supersedes")}`; return !seen.has(k) && seen.add(k); });
    return { center: id, depth: D, nodes, edges: local, projects };
  }

  /**
   * Sugestões de relação (nada é gravado): a nota cita outro projeto mas não tem relação explícita com a visão geral dele;
   * ou, se a nota É a visão geral de um projeto, ligações do projeto ainda não registradas. Quem registra é o revisor (`link`).
   */
  async relationSuggestions(id: string) {
    await this.sync({ maxAgeMs: 1000 });
    const row = this.db.getRow(id); if (!row) throw new BrainError("not_found", `nota "${id}" não existe`);
    const { projects, project_links } = await this.projectGraph();
    const ov = new Map(projects.map((p) => [p.id, p])); const rels = this.allLinks();
    const related = (a: string, b: string) => rels.some((x) => (x.src === a && x.dst === b) || (x.src === b && x.dst === a));
    const out: Array<{ src: string; dst: string; dst_title: string; type: RelationType; reason: string; snippet: string; weight: number }> = [];
    for (const l of project_links) for (const e of l.evidence) {
      if (e.id !== id) continue;
      const p = ov.get(e.to); if (!p?.overview_id || p.overview_id === id || related(id, p.overview_id)) continue;
      out.push({ src: id, dst: p.overview_id, dst_title: p.name, type: "references", reason: `esta nota cita ${p.name}`, snippet: e.snippet, weight: 1 });
    }
    if (row.type === "project" && row.project && ov.get(row.project)?.overview_id === id) { // só a visão geral ATUAL do projeto
      for (const l of project_links) {
        if (l.confirmed || (l.a !== row.project && l.b !== row.project)) continue;
        const other = ov.get(l.a === row.project ? l.b : l.a); if (!other?.overview_id || other.overview_id === id) continue;
        out.push({ src: id, dst: other.overview_id, dst_title: other.name, type: "related_to", reason: `${l.weight} nota(s) ligam os dois projetos`, snippet: l.evidence[0]?.snippet ?? "", weight: l.weight });
      }
    }
    // um alvo, uma sugestão (na visão geral, a de projeto vence a de citação)
    const best = new Map<string, (typeof out)[number]>();
    for (const x of out.sort((p, q) => q.weight - p.weight || (p.type === "related_to" ? -1 : 1))) if (!best.has(x.dst)) best.set(x.dst, x);
    return [...best.values()];
  }
}

// ---------- helpers ----------
function TemporalOk(t: Temporal): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.as_of ?? "") || Number.isNaN(Date.parse(t.as_of))) throw new BrainError("invalid", "temporal.as_of deve ser uma data AAAA-MM-DD");
  if (t.revalidate_when !== undefined && (typeof t.revalidate_when !== "string" || t.revalidate_when.trim().length < 3 || t.revalidate_when.length > 200)) throw new BrainError("invalid", "temporal.revalidate_when: 3–200 caracteres");
}
/** O que mudou numa entrada de módulo além do rótulo: `config: true` e `host: "definido" | "removido"`. */
function mudancasDaEntrada(antes: ModuleEntry, depois: ModuleEntry): { config?: true; host?: "definido" | "removido" } {
  return {
    ...(!isDeepStrictEqual(antes.config, depois.config) ? { config: true as const } : {}),
    ...(depois.host && depois.host !== antes.host ? { host: "definido" as const } : antes.host && !depois.host ? { host: "removido" as const } : {}),
  };
}
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof a[k] === "object" && a[k] !== null ? deepMerge(a[k] as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}
function dedupe(a: string[]): string[] { return [...new Set(a.map((x) => x.trim()).filter(Boolean))]; }
/** `id:` do frontmatter (sem parse completo: basta para comparar cópias), ou undefined. */
function frontmatterId(raw: string): string | undefined {
  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1];
  const id = fm && /^id:[ \t]*(.*?)[ \t]*$/m.exec(fm)?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
  return id || undefined;
}
function omitUndef<T extends object>(o: T): Partial<T> { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>; }
function addRel(r: Note["relations"], t: RelationType, id: string): Note["relations"] { return { ...r, [t]: [...new Set([...(r[t] ?? []), id])] }; }
function counts(r: SyncResult) { return { added: r.added.length, changed: r.changed.length, removed: r.removed.length }; }
function summarize(body: string): string {
  const t = plain(body).replace(/\s+/g, " ").trim();
  return t.length > 280 ? t.slice(0, 277) + "…" : t;
}
function complementBody(existing: string, p: Proposal, historical = false): string {
  const src = p.draft.source;
  const srcLine = src ? `\n> Fonte: ${src.type}${src.repository ? ` ${src.repository}` : ""}${src.ref ? ` ${src.ref}` : ""}${src.url ? ` ${src.url}` : ""}` : "";
  // conhecimento histórico anexado a uma nota atual: rotulado como histórico, com a conclusão da verificação
  const verdict = historical && p.freshness ? `\n> Verificado contra ${p.freshness.against ? `${p.freshness.against.repo}@${p.freshness.against.commit}` : "o repositório"}: ${p.freshness.state} — ${p.freshness.summary}` : "";
  return `${existing.trimEnd()}\n\n## ${historical ? "Histórico" : "Complemento"} — ${day()} (${p.proposed_by.name})\n\n${p.draft.body.trim()}${srcLine}${verdict}\n`;
}
/** Lote só com atualidade comprovada (ou proposta sem reconciliação, como as de agentes): `current` com confiança média/alta. */
function freshForBulk(f?: Freshness): boolean { return !f || (f.state === "current" && f.confidence !== "low"); }
/** Verificação de um rascunho que foi editado depois: rebaixada a "incerta", com o motivo como primeira evidência. */
function staleFreshness(f: Freshness): Freshness {
  if (f.summary.startsWith("Rascunho editado")) return f;
  return { ...f, stale_from: f.stale_from ?? f.state, state: "uncertain", confidence: "low", suggestion: "confirm", effort: "quick", summary: "Rascunho editado depois da verificação de atualidade: o veredito anterior não vale mais (reverifique com brain reconcile).", evidence: [{ kind: "vault" as const, stance: "context" as const, ref: "edição", detail: `veredito anterior: ${f.state}/${f.confidence} — ${f.summary}`.slice(0, 300) }, ...f.evidence].slice(0, 12) };
}
export function rowSummary(r: { id: string; title: string; type: NoteType; status: NoteStatus; project: string | null; updated_at: string; created_at: string; tags: string; body: string }) {
  return { id: r.id, title: r.title, type: r.type, status: r.status, project: r.project ?? undefined, tags: JSON.parse(r.tags) as string[], updated_at: r.updated_at, created_at: r.created_at, summary: summarize(r.body) };
}
