import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join, normalize, sep } from "node:path";
import { Brain, principal, humanFromSession, isHumanReviewer, type SessionStoreOptions, assertImportablePath, coreDoctor, integrationChecks, integrationStatus, importPath, importText, processCandidates, reconcileCandidates, rowSummary, watchVault, type Candidate, type FreshnessSummary } from "@brain/core";
import { BrainError, NOTE_TYPES, RELATION_TYPES, STATUSES, type Principal } from "@brain/shared";
export { issueHumanSession, isHumanSession, revokeHumanSessions, hasReviewerPassphrase, setReviewerPassphrase, checkReviewerPassphrase, defaultSessionsFile, type SessionStoreOptions } from "@brain/core";
import { homedir } from "node:os";

export interface ApiOptions { port?: number; host?: string; webRoot?: string; userName?: string; sessions?: SessionStoreOptions; build?: { commit?: string; id?: string } }
export interface ApiHandle { url: string; token: string; port: number; close(): Promise<void> }

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json",
};
const STATUS_OF: Record<string, number> = {
  not_found: 404, invalid: 400, secret_detected: 422, too_large: 413, conflict_revision: 409, forbidden: 403,
  duplicate_id: 409, locked: 503, git_error: 500, path_escape: 400, policy: 403,
};

type Ctx = { brain: Brain; actor: Principal; url: URL; body: any; params: string[]; emit: (ev: string, data?: unknown) => void };
type Handler = (c: Ctx) => Promise<unknown> | unknown;

export function tokenPath(root: string) { return join(root, ".brain", "api-token"); }
export function loadOrCreateToken(root: string): string {
  const f = tokenPath(root);
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  mkdirSync(join(root, ".brain"), { recursive: true });
  const t = randomBytes(24).toString("hex");
  writeFileSync(f, t, { mode: 0o600 });
  return t;
}

export async function startApi(brain: Brain, opts: ApiOptions = {}): Promise<ApiHandle> {
  const host = opts.host ?? "127.0.0.1";
  const token = loadOrCreateToken(brain.vault.root);
  const userName = opts.userName ?? process.env.BRAIN_USER ?? process.env.USER ?? "user";
  /**
   * Identidade por REQUISIÇÃO, decidida aqui (adapter) e nunca pelo corpo/cabeçalhos do cliente:
   *   sessão humana válida (emitida num terminal interativo) → humano, canal "ui" (pode revisar)
   *   api-token do vault (legível por qualquer processo local) → AGENTE, canal "api" (lê e propõe; não decide)
   * O nome do agente da API é FIXO ("api-client"): um cabeçalho declarado pelo cliente não pode se passar pela autoria de outro
   * agente (ex.: corrigir propostas do claude-code).
   */
  const API_AGENT = principal("agent", "api-client", "api");
  const identify = (tok: string): Principal | undefined => {
    const h = humanFromSession(brain.vault.root, tok, userName, opts.sessions); if (h) return h;
    if (safeEq(tok, token)) return API_AGENT;
    return undefined;
  };
  // EventSource não envia Authorization: em vez de pôr a sessão na URL, o cliente troca o token por um TICKET curto e de uso único
  const tickets = new Map<string, number>();
  const clients = new Set<ServerResponse>();
  let watching = false; let listenPort = 0;
  const emit = (ev: string, data: unknown = {}) => { for (const c of clients) c.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };

  const routes: Array<[string, RegExp, Handler]> = [];
  const r = (m: string, p: string, h: Handler) => routes.push([m, new RegExp(`^${p.replace(/:[a-z]+/g, "([^/]+)")}$`), h]);
  const q = (u: URL, k: string) => u.searchParams.get(k) ?? undefined;

  r("GET", "/api/health", async ({ brain }) => ({ ...(await brain.health()), api: { watcher: watching, port: listenPort, build: opts.build } }));
  r("GET", "/api/integrations", ({ brain }) => ({ ...integrationStatus(), vault: brain.vault.root }));
  r("GET", "/api/doctor", async ({ brain }) => [...(await coreDoctor(brain)), ...integrationChecks(brain.vault.root)]);
  r("GET", "/api/dashboard", ({ brain }) => brain.dashboard());
  r("GET", "/api/search", async ({ brain, url, actor }) => brain.search(q(url, "q") ?? "", {
    project: q(url, "project"), type: q(url, "type") as never, tags: q(url, "tags")?.split(",").filter(Boolean),
    since: q(url, "since"), until: q(url, "until"), created_by: q(url, "by"),
    status: q(url, "status")?.split(",") as never, include_inactive: q(url, "inactive") === "1",
  }, Number(q(url, "limit") ?? 20), actor));
  r("GET", "/api/notes", async ({ brain, url }) => {
    await brain.sync({ maxAgeMs: 1000 });
    const w = ["1=1"]; const p: string[] = [];
    if (q(url, "project")) { w.push("project=?"); p.push(q(url, "project")!); }
    if (q(url, "type")) { w.push("type=?"); p.push(q(url, "type")!); }
    if (q(url, "status")) { w.push("status=?"); p.push(q(url, "status")!); } else w.push("status!='archived'");
    return brain.db.rows(w.join(" AND "), p, "updated_at DESC", Number(q(url, "limit") ?? 200)).map(rowSummary);
  });
  r("GET", "/api/notes/:id", ({ brain, params, actor }) => brain.get(decodeURIComponent(params[0]!), actor));
  r("POST", "/api/notes", ({ brain, body, actor }) => brain.createNote(body, actor));
  r("PATCH", "/api/notes/:id", ({ brain, params, body, actor }) => brain.updateNote(decodeURIComponent(params[0]!), body, actor));
  r("POST", "/api/notes/:id/links", ({ brain, params, body, actor }) => {
    if (!RELATION_TYPES.includes(body.type)) throw new BrainError("invalid", "tipo de relação inválido");
    return brain.link(decodeURIComponent(params[0]!), body.to, body.type, actor);
  });
  r("POST", "/api/notes/:id/status", ({ brain, params, body, actor }) => {
    if (!STATUSES.includes(body.status)) throw new BrainError("invalid", "status inválido");
    return brain.updateNote(decodeURIComponent(params[0]!), { status: body.status, expected_revision: body.expected_revision, reason: body.reason }, actor);
  });
  r("GET", "/api/projects", ({ brain }) => brain.projects());
  r("POST", "/api/projects", ({ brain, body, actor }) => brain.createProject(body.slug, body.title, body.summary ?? "", actor));
  r("GET", "/api/projects/:id", async ({ brain, params }) => {
    const id = decodeURIComponent(params[0]!);
    await brain.sync({ maxAgeMs: 1000 });
    const rows = brain.db.rows("project=? AND status!='archived'", [id], "updated_at DESC", 500).map(rowSummary);
    const overview = brain.db.rows("project=? AND type='project'", [id], "updated_at DESC", 1)[0];
    const pending = brain.listProposals().filter((p) => p.draft.project === id);
    return { id, overview_id: overview?.id, notes: rows, pending, history: await brain.git.log(`knowledge/projects/${id}`, 15), graph: await brain.graph({ project: id }) };
  });
  r("GET", "/api/recent", ({ brain, url }) => brain.recent({ limit: Number(q(url, "limit") ?? 15), project: q(url, "project") }));
  r("POST", "/api/analyze", ({ brain, body }) => brain.analyze(body));
  r("GET", "/api/proposals", ({ brain, url }) => brain.listProposals((q(url, "which") as never) ?? "pending"));
  r("GET", "/api/inbox", ({ brain }) => brain.inbox());
  r("GET", "/api/review", ({ brain }) => brain.reviewQueue());
  r("POST", "/api/proposals", async ({ brain, body, actor, emit }) => {
    // só campos de RASCUNHO: veredito de atualidade, metadados de importação e manutenção nunca vêm do cliente
    const p = await brain.propose({ title: body.title, type: body.type, body: body.body, project: str(body.project), tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 20) : undefined, confidence: ["low", "medium", "high"].includes(body.confidence) ? body.confidence : undefined, source: body.source && typeof body.source === "object" ? body.source : undefined, reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined, intent: body.intent, target_id: str(body.target_id), temporal: temporalOf(body.temporal) }, actor);
    emit("proposals"); return p;
  });
  r("GET", "/api/proposals/:id", ({ brain, params }) => brain.proposalView(params[0]!));
  r("GET", "/api/proposals/:id/preview", ({ brain, params, url }) => brain.preview(params[0]!, q(url, "resolution") as never, q(url, "target")));
  r("POST", "/api/proposals/approve-many", async ({ brain, body, actor, emit }) => {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const out = await brain.approveMany(ids, actor); emit("proposals"); emit("notes"); return out;
  });
  r("POST", "/api/proposals/ignore-many", async ({ brain, body, actor, emit }) => {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const out = await brain.ignoreMany(ids, typeof body.note === "string" ? body.note.slice(0, 300) : undefined, actor); emit("proposals"); return out;
  });
  r("PATCH", "/api/proposals/:id", async ({ brain, params, body, actor, emit }) => {
    const p = await brain.editProposal(params[0]!, { title: str(body.title), body: typeof body.body === "string" ? body.body.slice(0, 8000) : undefined, tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 20) : undefined, type: body.type, project: typeof body.project === "string" ? body.project.trim().slice(0, 100) : undefined, temporal: temporalOf(body.temporal), clear_temporal: body.clear_temporal === true }, actor);
    emit("proposals"); return p;
  });
  r("POST", "/api/proposals/:id/reanalyze", async ({ brain, params, actor, emit }) => { const p = await brain.reanalyze(params[0]!, actor); emit("proposals"); return p; });
  r("POST", "/api/proposals/:id/resolve", async ({ brain, params, body, actor, emit }) => {
    // só os campos da DECISÃO; qualquer "actor"/"decided_by" no corpo é ignorado
    const out = await brain.resolve(params[0]!, { resolution: body.resolution, target_id: str(body.target_id), final_body: typeof body.final_body === "string" ? body.final_body : undefined, note: typeof body.note === "string" ? body.note.slice(0, 300) : undefined, as_historical: typeof body.as_historical === "boolean" ? body.as_historical : undefined }, actor); emit("proposals"); emit("notes"); return out;
  });
  // ---- Import Assistant: preview (nada grava) → submit (cria PROPOSTAS, nunca notas) ----
  r("POST", "/api/import/preview", async ({ brain, body }) => {
    const o = { dryRun: true, max: 200, includeDuplicates: true, project: str(body.project), gitLog: !!body.gitLog };
    if (body.kind === "text") return importText(brain, String(body.text ?? ""), { ...o, name: str(body.name) });
    if (body.kind === "path") return importPath(brain, assertImportablePath(String(body.path ?? ""), [homedir()]), o);
    throw new BrainError("invalid", "kind deve ser text ou path");
  });
  r("POST", "/api/import/submit", async ({ brain, body, emit }) => {
    const list = Array.isArray(body.candidates) ? body.candidates.slice(0, 200) : [];
    const cands: Array<Candidate & { source_ref?: string }> = list.map((c: any) => {
      if (!c || typeof c.title !== "string" || typeof c.body !== "string" || !NOTE_TYPES.includes(c.type)) throw new BrainError("invalid", "candidato inválido");
      return { id: "", title: c.title.slice(0, 200), body: c.body.slice(0, 8000), type: c.type, tags: Array.isArray(c.tags) ? c.tags.map(String).slice(0, 8) : [], confidence: ["low", "medium", "high"].includes(c.confidence) ? c.confidence : "low", rule: String(c.rule ?? "manual").slice(0, 40), evidence: String(c.evidence ?? "").slice(0, 300), source: { path: String(c.source?.path ?? "import").slice(0, 300), heading: c.source?.heading ? String(c.source.heading).slice(0, 200) : undefined }, source_ref: c.source_ref ? String(c.source_ref).slice(0, 400) : undefined };
    });
    if (!cands.length) throw new BrainError("invalid", "nenhum candidato selecionado");
    // a atualidade NUNCA vem do cliente: é recalculada aqui contra o repositório de origem (somente leitura; cache por HEAD)
    let freshness: FreshnessSummary | undefined;
    const src = typeof body.source === "string" ? body.source : "";
    if (src.startsWith("/")) { try { freshness = await reconcileCandidates(cands, assertImportablePath(src, [homedir()]), [str(body.repo), str(body.project)].filter((x): x is string => !!x)); } catch { /* fonte fora da home ou removida: segue sem atualidade */ } }
    else if (src === "texto colado") freshness = await reconcileCandidates(cands, undefined, []);
    const rep = await processCandidates(brain, cands, { source: String(body.source ?? "ui").slice(0, 300), repo: String(body.repo ?? "import").slice(0, 100), project: str(body.project), head: undefined, files: 0, skipped_files: {}, skipped_sections: 0, dropped_similar: 0, freshness }, { includeDuplicates: true, max: 200 });
    emit("proposals"); return rep;
  });
  r("GET", "/api/timeline", ({ brain, url }) => brain.timeline({ limit: Number(q(url, "limit") ?? 100), actor: q(url, "actor") }));
  r("GET", "/api/agents", async ({ brain }) => (await brain.dashboard()).agents);
  r("GET", "/api/graph", ({ brain, url }) => brain.graph({ project: q(url, "project") }));
  r("GET", "/api/notes/:id/local", ({ brain, params, url }) => brain.localGraph(decodeURIComponent(params[0]!), Number(q(url, "depth") ?? 1)));
  r("GET", "/api/notes/:id/suggestions", ({ brain, params }) => brain.relationSuggestions(decodeURIComponent(params[0]!)));
  r("GET", "/api/settings", ({ brain }) => ({ config: brain.config, vault: brain.vault.root, embedder: { id: brain.embedder.id, external: brain.embedder.external } }));
  r("PUT", "/api/settings", async ({ brain, body, actor }) => ({ config: await brain.updateConfig(body, actor) }));
  r("POST", "/api/reindex", async ({ brain, emit }) => { const x = await brain.reindex(true); emit("notes"); return { added: x.added.length, changed: x.changed.length, removed: x.removed.length, embedded: x.embedded }; });
  r("POST", "/api/git/commit", async ({ brain, body, actor }) => brain.commitPending(body?.message, actor));
  r("GET", "/api/git/dirty", async ({ brain }) => brain.git.dirty("knowledge"));
  r("GET", "/api/git/log", async ({ brain, url }) => brain.git.log(q(url, "path"), Number(q(url, "limit") ?? 30)));
  r("POST", "/api/git/revert", async ({ brain, body, actor, emit }) => { const c = await brain.revertCommit(body.rev, actor); emit("notes"); return { commit: c }; });
  r("GET", "/api/obsidian/:id", async ({ brain, params }) => {
    const note = brain.loadNote(decodeURIComponent(params[0]!));
    const abs = join(brain.vault.root, note.path);
    let win: string | undefined;
    try { win = execFileSync("wslpath", ["-w", abs], { encoding: "utf8", timeout: 2000 }).trim(); } catch { /* fora do WSL */ }
    const vaultWin = (() => { try { return execFileSync("wslpath", ["-w", brain.vault.root], { encoding: "utf8", timeout: 2000 }).trim(); } catch { return undefined; } })();
    return { path: abs, windows_path: win, vault: brain.vault.root, vault_windows_path: vaultWin, uri: `obsidian://open?path=${encodeURIComponent(win ?? abs)}` };
  });
  r("GET", "/api/meta", ({ actor }) => ({ note_types: NOTE_TYPES, relation_types: RELATION_TYPES, statuses: STATUSES, user: { kind: actor.kind, name: actor.name }, principal: { kind: actor.kind, name: actor.name, channel: actor.channel }, can_review: isHumanReviewer(actor) }));

  const allowedHosts = new Set<string>();
  const server: Server = createServer(async (req, res) => {
    try { await handle(req, res); } catch (e) { send(res, e); }
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const hostHdr = (req.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(hostHdr)) return plain(res, 403, "host não permitido");
    const url = new URL(req.url ?? "/", `http://${hostHdr}`);
    const method = req.method ?? "GET";
    if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);

    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(new URL(origin).host.toLowerCase())) return plain(res, 403, "origem não permitida");
    if (url.pathname === "/api/events") {
      const t = url.searchParams.get("ticket") ?? ""; const exp = tickets.get(t); tickets.delete(t);
      if (!exp || exp < Date.now()) return plain(res, 401, "ticket inválido ou expirado");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("retry: 3000\n\n"); clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    const hdr = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const who = identify(hdr);
    if (!who) return plain(res, 401, "token inválido");
    if (url.pathname === "/api/events/ticket" && method === "POST") {
      const t = randomBytes(18).toString("hex"); const now = Date.now();
      for (const [k, e] of tickets) if (e < now) tickets.delete(k);
      tickets.set(t, now + 30_000); return json(res, 200, { ticket: t });
    }
    const body = ["POST", "PUT", "PATCH"].includes(method) ? await readJson(req) : undefined;
    for (const [m, re, h] of routes) {
      if (m !== method) continue;
      const mt = re.exec(url.pathname);
      if (!mt) continue;
      const data = await h({ brain, actor: who, url, body, params: mt.slice(1), emit });
      return json(res, 200, data ?? { ok: true });
    }
    json(res, 404, { error: "not_found", message: `rota ${method} ${url.pathname}` });
  }

  const webRoot = opts.webRoot;
  function serveStatic(pathname: string, res: ServerResponse) {
    if (!webRoot || !existsSync(webRoot)) return plain(res, 200, "Second Brain API ativa. Frontend não compilado (rode: pnpm build).");
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    if (rel.split(sep).includes("..")) return plain(res, 400, "caminho inválido");
    let file = join(webRoot, rel);
    if (!rel || !existsSync(file) || !statSync(file).isFile()) file = join(webRoot, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" });
    res.end(readFileSync(file));
  }

  // watchers: edições externas (Obsidian) e propostas pendentes de agentes
  watching = true;
  const vw = watchVault(brain, (s) => emit("notes", { added: s.added, changed: s.changed, removed: s.removed }));
  let pw: FSWatcher | undefined; let pt: NodeJS.Timeout | undefined;
  try { mkdirSync(brain.vault.pendingDir, { recursive: true }); pw = watch(brain.vault.pendingDir, () => { clearTimeout(pt); pt = setTimeout(() => emit("proposals"), 250); }); } catch { /* polling no cliente cobre */ }

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 3737, host, () => resolve((server.address() as { port: number }).port));
  });
  listenPort = port;
  for (const h of [host, "localhost", "127.0.0.1"]) allowedHosts.add(`${h}:${port}`);
  return {
    url: `http://${host}:${port}`, token, port,
    close: () => new Promise<void>((res) => { vw.close(); pw?.close(); for (const c of clients) c.end(); server.close(() => res()); server.closeAllConnections?.(); }),
  };
}

const temporalOf = (v: any) => (v && typeof v === "object" ? { as_of: String(v.as_of ?? ""), ...(v.revalidate_when ? { revalidate_when: String(v.revalidate_when).slice(0, 200) } : {}) } : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined);
const safeEq = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
function plain(res: ServerResponse, status: number, msg: string) { res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }); res.end(msg); }
function send(res: ServerResponse, e: unknown) {
  if (res.headersSent) return res.end();
  if (e instanceof BrainError) return json(res, STATUS_OF[e.code] ?? 400, { error: e.code, message: e.message, details: e.code === "secret_detected" ? undefined : e.details });
  console.error("[api]", e);
  json(res, 500, { error: "internal", message: "erro interno (veja o log do servidor)" });
}
async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > 1_000_000) throw new BrainError("too_large", "corpo > 1MB"); chunks.push(c as Buffer); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new BrainError("invalid", "JSON inválido"); }
}
