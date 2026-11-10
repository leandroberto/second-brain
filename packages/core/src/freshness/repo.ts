import { execFile, spawn } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { SourceKind } from "@brain/shared";
import { redactSecrets } from "../secrets.js";
import { fold } from "../text.js";
import { TECH, canonicalIdent, identParts, sourceKindOf } from "./semantics.js";

const run = promisify(execFile);

/**
 * git SOMENTE LEITURA e endurecido: sem hooks, sem fsmonitor (que executa programa configurado no repo), sem diff externo/
 * textconv, sem locks opcionais (não reescreve o index do repositório inspecionado), sem prompt de credencial.
 * Argumentos sempre em array (nunca shell); o conteúdo do repositório nunca é interpretado como comando.
 */
// quotePath=false: caminhos com acento saem crus (senão "operação.md" vira "opera\303\247\303\243o.md" e renomeações não casam)
const HARDEN = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", "-c", "log.showSignature=false", "-c", "diff.noprefix=false", "-c", "core.quotePath=false"];
const GIT_ENV = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_EXTERNAL_DIFF: "", LC_ALL: "C" });
export async function safeGit(root: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await run("git", [...HARDEN, "-C", root, ...args], { timeout: opts.timeout ?? 20_000, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, env: GIT_ENV() });
  return stdout;
}

/**
 * Conteúdo de vários blobs numa única chamada (`git cat-file --batch`), com timeout e teto de bytes no próprio stream.
 * Saída não-zero rejeita (o chamador marca o índice como incompleto); blob com payload menor que o anunciado é descartado.
 */
function catFileBatch(root: string, shas: string[], maxBytes: number, timeoutMs = 60_000): Promise<Map<string, Buffer>> {
  return new Promise((resolveP, rejectP) => {
    const p = spawn("git", [...HARDEN, "-C", root, "cat-file", "--batch"], { env: GIT_ENV(), stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = []; let total = 0; let over = false;
    const timer = setTimeout(() => { p.kill("SIGKILL"); rejectP(new Error("cat-file timeout")); }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => { total += d.length; if (total > maxBytes) { over = true; p.kill("SIGKILL"); return; } chunks.push(d); });
    p.on("error", (e) => { clearTimeout(timer); rejectP(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (over) return rejectP(new Error("cat-file: saída acima do teto"));
      if (code !== 0) return rejectP(new Error(`cat-file saiu com ${code}`));
      const buf = Buffer.concat(chunks); const out = new Map<string, Buffer>(); let i = 0;
      while (i < buf.length) {
        const nl = buf.indexOf(10, i); if (nl < 0) break;
        const [sha = "", type = "", size = ""] = buf.subarray(i, nl).toString().split(" ");
        if (type === "missing" || !size) { i = nl + 1; continue; }
        const n = Number(size); const body = buf.subarray(nl + 1, nl + 1 + n);
        if (body.length === n) out.set(sha, body); // incompleto: fica de fora (e o índice vira incompleto)
        i = nl + 1 + n + 1;
      }
      resolveP(out);
    });
    p.stdin.on("error", () => { /* git encerrou antes de ler tudo: o que chegou é usado */ });
    p.stdin.end(shas.join("\n") + "\n");
  });
}

export type FileKind = "code" | "test" | "config" | "doc";
export interface CommitInfo {
  sha: string; short: string; date: string; subject: string; body: string;
  files: Array<{ status: string; path: string; from?: string }>;
  /** sha (ou assunto) do commit que este commit reverte */
  reverts?: string;
  tokens: Set<string>;
}
export interface PathHistory { added?: { sha: string; date: string }; modified?: { sha: string; date: string }; deleted?: { sha: string; date: string }; renamedTo?: string; renamedFrom?: string; commits: number }
export interface AdrInfo { path: string; num?: number; title: string; status?: string; supersedes: number[]; supersededBy: number[] }
export interface Hit { path: string; line: number }

export interface RepoIndex {
  root: string; name: string;
  head?: { sha: string; short: string; date: string };
  /** arquivos INDEXADOS do HEAD (código/teste/config/doc) — a árvore de trabalho nunca é evidência do HEAD */
  files: Map<string, FileKind>;
  /** todos os caminhos de blobs do HEAD (para "a fonte ainda está no HEAD?") */
  headPaths: Set<string>;
  /** chave (id:<canônico> | w:<subtoken> | b:<bigrama>) → arquivo → primeira linha */
  ident: Map<string, Map<string, number>>;
  lines: Map<string, string[]>;
  commits: CommitInfo[];            // mais novo primeiro
  revertedBy: Map<string, CommitInfo>;
  history: Map<string, PathHistory>;
  docs: Map<string, string>;        // docs .md no HEAD (texto) — para supersessão/migração
  docsFolded: Map<string, string>;  // cache: texto normalizado (sem acento, minúsculo, segredos mascarados) por doc
  docPostings?: Map<string, string[]>; // cache: token → docs que o contêm (busca de termos sem varrer o corpus por candidato)
  adrs: AdrInfo[];
  deps: Map<string, string>;        // dependência declarada → manifesto
  pickaxeBudget: { left: number; cache: Map<string, Array<{ short: string; date: string; subject: string; sha: string }>> };
  /** arquivos-vocabulário (listas de tecnologias, fixtures): citam muitas tecnologias e não provam uso de nenhuma */
  vocab: Set<string>;
  /** truncated: limites de arquivos/bytes atingidos ou arquivo de código grande demais ignorado → ausência NÃO é prova */
  stats: { files: number; bytes: number; commits: number; ms: number; truncated: boolean; skippedLarge: number };
  grepBudget: { left: number; cache: Map<string, string | null> };
}

export interface RepoLimits { maxFiles: number; maxBytes: number; maxFileBytes: number; maxCommits: number; maxDocs: number; pickaxe: number; grep: number }
export const DEFAULT_REPO_LIMITS: RepoLimits = { maxFiles: 4000, maxBytes: 30_000_000, maxFileBytes: 400_000, maxCommits: 3000, maxDocs: 400, pickaxe: 12, grep: 30 };

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|cs|php|swift|scala|sql|sh|bash|vue|svelte|ex|exs|clj|lua|dart|c|h|cc|cpp|hpp)$/i;
const CONFIG_EXT = /(\.(json|ya?ml|toml|ini|cfg|conf|properties)$|(^|\/)(dockerfile|docker-compose[^/]*|makefile|procfile|\.env\.example|\.env\.sample)$)/i;
const DOC_EXT = /\.(md|mdx|markdown)$/i;
const LOCKFILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|poetry\.lock|cargo\.lock|composer\.lock|gemfile\.lock|uv\.lock|go\.sum|bun\.lockb)$/i;
const IGNORE_DIRS = /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|venv|\.venv|__pycache__|target|vendor|coverage|\.cache|\.turbo|site-packages|\.git)\//;
const SECRET_FILE = /(^|\/)(\.env(\.[^/]*)?|[^/]*\.(pem|key|p12|pfx)|id_rsa[^/]*|credentials[^/]*|secrets?\.[^/]*)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|e2e|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|(^|\/)conftest\.py$/i;

const cache = new Map<string, Promise<RepoIndex>>();

/** Raiz do repositório git que contém `dir` (ou undefined). */
export async function gitTopLevel(dir: string): Promise<string | undefined> {
  try { return (await safeGit(dir, ["rev-parse", "--show-toplevel"], { timeout: 5000 })).trim() || undefined; } catch { return undefined; }
}

/**
 * Índice derivado e reconstruível de UM repositório, lido dos BLOBS DO HEAD (não da árvore de trabalho: alterações não commitadas
 * nunca são atribuídas ao HEAD). Como o HEAD é imutável, o cache em memória por (raiz, sha do HEAD, limites) é sempre correto.
 */
export async function repoIndex(root: string, limits: Partial<RepoLimits> = {}): Promise<RepoIndex> {
  const l = { ...DEFAULT_REPO_LIMITS, ...limits };
  let head = ""; try { head = (await safeGit(root, ["rev-parse", "HEAD"], { timeout: 5000 })).trim(); } catch { /* sem commits */ }
  const key = `${root}|${head}|${JSON.stringify(l)}`;
  let p = cache.get(key);
  if (!p) { p = buildIndex(root, head, l); cache.set(key, p); if (cache.size > 8) cache.delete(cache.keys().next().value!); p.catch(() => cache.delete(key)); }
  return p;
}
export const clearRepoCache = () => cache.clear();

async function buildIndex(root: string, headSha: string, l: RepoLimits): Promise<RepoIndex> {
  const t0 = Date.now();
  const idx: RepoIndex = {
    root, name: basename(root), files: new Map(), headPaths: new Set(), grepBudget: { left: l.grep, cache: new Map() }, ident: new Map(), lines: new Map(), commits: [], revertedBy: new Map(), history: new Map(),
    docs: new Map(), docsFolded: new Map(), adrs: [], deps: new Map(), vocab: new Set(), pickaxeBudget: { left: l.pickaxe, cache: new Map() }, stats: { files: 0, bytes: 0, commits: 0, ms: 0, truncated: false, skippedLarge: 0 },
  };
  if (headSha) {
    try {
      const out = await safeGit(root, ["log", "-1", "--format=%H%x1f%h%x1f%cI", headSha], { timeout: 5000 });
      const [sha = "", short = "", date = ""] = out.trim().split("\x1f"); idx.head = { sha, short, date };
    } catch { /* ignore */ }
  }
  // 1) blobs do HEAD (ls-tree): sem symlinks (120000) nem submódulos; filtros de segredo/lockfile/pastas geradas
  const want: Array<{ sha: string; path: string; kind: FileKind; size: number }> = [];
  if (headSha) {
    // SEMPRE o sha resolvido (nunca "HEAD"): um checkout durante a indexação não mistura commits nem envenena o cache
    let out = ""; let listed = true;
    try { out = await safeGit(root, ["ls-tree", "-r", "-z", "--long", "--full-tree", headSha], { timeout: 30_000 }); } catch { listed = false; }
    // sem a lista de arquivos o índice NÃO serve como prova de nada (nem de ausência): a reconciliação cai para semântica pura
    if (!listed) { idx.stats.truncated = true; idx.head = undefined; }
    let bytes = 0;
    for (const rec of out.split("\0")) {
      const tab = rec.indexOf("\t"); if (tab < 0) continue;
      const [mode = "", type = "", sha = "", size = ""] = rec.slice(0, tab).trim().split(/\s+/); const rel = rec.slice(tab + 1);
      if (type !== "blob" || mode === "120000") continue;
      idx.headPaths.add(rel);
      if (IGNORE_DIRS.test(rel) || SECRET_FILE.test(rel) || LOCKFILE.test(rel)) continue;
      const kind: FileKind | undefined = DOC_EXT.test(rel) ? "doc" : CODE_EXT.test(rel) ? (TEST_PATH.test(rel) ? "test" : "code") : CONFIG_EXT.test(rel) ? "config" : undefined;
      if (!kind) continue;
      const n = Number(size) || 0;
      if (n === 0) continue;
      if (n > l.maxFileBytes) { if (kind !== "doc") { idx.stats.skippedLarge++; idx.stats.truncated = true; } continue; }
      if (kind === "doc" && want.filter((w) => w.kind === "doc").length >= l.maxDocs) continue;
      if (want.length >= l.maxFiles || bytes + n > l.maxBytes) { idx.stats.truncated = true; continue; }
      want.push({ sha, path: rel, kind, size: n }); bytes += n;
    }
  }
  let blobs = new Map<string, Buffer>();
  try { blobs = await catFileBatch(root, [...new Set(want.map((w) => w.sha))], l.maxBytes + 1_000_000); } catch { idx.stats.truncated = true; }
  for (const w of want) {
    const b = blobs.get(w.sha); if (!b || b.length !== w.size) { idx.stats.truncated = true; continue; }
    if (b.subarray(0, 1024).includes(0)) continue; // binário
    const text = b.toString("utf8");
    idx.files.set(w.path, w.kind); idx.stats.bytes += w.size;
    if (w.kind === "doc") { idx.docs.set(w.path, text); continue; }
    indexLines(idx, w.path, text, w.kind);
    if (w.kind === "config") readDeps(idx, w.path, text);
  }
  idx.stats.files = idx.files.size;
  // 2) UMA passada de histórico: datas por arquivo, renomeações, exclusões, reverts
  if (headSha) {
    try {
      const out = await safeGit(root, ["log", headSha, `--max-count=${l.maxCommits}`, "--name-status", "-M", "--no-ext-diff", "--no-textconv", "--format=%x1e%H%x1f%h%x1f%cI%x1f%s%x1f%b%x1f"], { timeout: 30_000 });
      for (const rec of out.split("\x1e")) {
        if (!rec.trim()) continue;
        const [sha = "", short = "", date = "", rawSubject = "", rawBody = "", rest = ""] = rec.split("\x1f");
        // mensagens de commit aparecem como evidência: segredos são mascarados na ORIGEM (antes de qualquer recorte)
        const subject = redactSecrets(rawSubject); const body = redactSecrets(rawBody.slice(0, 4000));
        const files: CommitInfo["files"] = [];
        for (const ln of rest.split("\n")) {
          const m = /^([AMDRCT])\d*\t([^\t]+)(?:\t([^\t]+))?$/.exec(ln.trim());
          if (!m) continue;
          files.push(m[1] === "R" || m[1] === "C" ? { status: m[1]!, path: m[3]!, from: m[2]! } : { status: m[1]!, path: m[2]! });
        }
        const rv = /^Revert "(.+)"$/.exec(subject)?.[1];
        const rvSha = /This reverts commit ([0-9a-f]{7,40})/.exec(body)?.[1] ?? (/^revert(\([^)]*\))?!?:/i.test(subject) ? /\b([0-9a-f]{7,40})\b/.exec(body)?.[1] : undefined);
        const c: CommitInfo = { sha, short, date, subject, body: body.slice(0, 2000), files, ...(rvSha || rv ? { reverts: rvSha ?? `subject:${rv}` } : {}), tokens: commitTokens(subject, files) };
        idx.commits.push(c);
      }
    } catch { idx.stats.truncated = true; }
    idx.stats.commits = idx.commits.length;
    // histórico por caminho (do mais antigo para o mais novo)
    for (const c of [...idx.commits].reverse()) for (const f of c.files) {
      const h = idx.history.get(f.path) ?? { commits: 0 }; h.commits++;
      if (f.status === "A" && !h.added) h.added = { sha: c.short, date: c.date };
      if (f.status === "R" && f.from) { const old = idx.history.get(f.from); if (old) { old.renamedTo = f.path; h.added = h.added ?? old.added; } h.renamedFrom = f.from; }
      if (f.status === "D") h.deleted = { sha: c.short, date: c.date }; else { h.modified = { sha: c.short, date: c.date }; delete h.deleted; }
      if (!h.added) h.added = { sha: c.short, date: c.date };
      idx.history.set(f.path, h);
    }
    for (const c of idx.commits) if (c.reverts) {
      const target = c.reverts.startsWith("subject:") ? idx.commits.find((x) => x.subject === c.reverts!.slice(8) && x.date <= c.date) : idx.commits.find((x) => x.sha.startsWith(c.reverts!));
      if (target) idx.revertedBy.set(target.sha, c);
    }
  }
  // 2b) arquivos que citam ≥ 6 tecnologias distintas são vocabulário, não uso
  const techPerFile = new Map<string, Set<string>>();
  for (const t of TECH) for (const al of t.aliases) { if (al.length < 3) continue; for (const k of [`id:${canonicalIdent(al)}`, `w:${al}`]) for (const [p] of idx.ident.get(k) ?? []) { let st = techPerFile.get(p); if (!st) { st = new Set(); techPerFile.set(p, st); } st.add(t.name); } }
  for (const [p, st] of techPerFile) if (st.size >= 6) idx.vocab.add(p);
  // 3) ADRs no HEAD: número, status, quem substitui quem
  for (const [p, text] of idx.docs) if (sourceKindOf(p, text) === "adr") idx.adrs.push(parseAdr(p, text));
  idx.stats.ms = Date.now() - t0;
  return idx;
}


const COMMENT_ONLY = /^\s*(\/\/|#(?!include|!)|\*|\/\*|--\s)/;
function indexLines(idx: RepoIndex, rel: string, text: string, kind: FileKind): void {
  const lines = text.split("\n"); idx.lines.set(rel, lines);
  const put = (k: string, line: number) => { let m = idx.ident.get(k); if (!m) { m = new Map(); idx.ident.set(k, m); } if (!m.has(rel)) m.set(rel, line); };
  // o caminho do arquivo também é evidência ("src/cache.ts", "catalog_identity.py")
  for (const part of rel.split("/")) { const base = part.replace(/\.[a-z0-9]+$/i, ""); const ps = identParts(base); if (ps.length) { put(`id:${ps.join("_")}`, 0); for (const w of ps) put(`w:${w}`, 0); } }
  for (let i = 0; i < lines.length; i++) {
    let ln = lines[i]!; if (ln.length > 2000) ln = ln.slice(0, 2000);
    if (kind !== "config" && COMMENT_ONLY.test(ln)) continue; // comentário não é implementação
    for (const m of ln.matchAll(/[A-Za-z_][A-Za-z0-9_]{1,63}/g)) {
      const parts = identParts(m[0]); if (!parts.length) continue;
      if (parts.length > 1) put(`id:${parts.join("_")}`, i + 1);
      for (let j = 0; j < parts.length; j++) { if (parts[j]!.length >= 3) put(`w:${parts[j]}`, i + 1); if (j > 0) put(`b:${parts[j - 1]}_${parts[j]}`, i + 1); }
      if (parts.length === 1) put(`id:${parts[0]}`, i + 1);
    }
    void kind;
  }
}

function readDeps(idx: RepoIndex, rel: string, text: string): void {
  const name = rel.split("/").pop()!.toLowerCase();
  const add = (d: string) => { const n = d.trim().toLowerCase(); if (n && n.length <= 80 && !idx.deps.has(n)) idx.deps.set(n, rel); const tail = n.split("/").pop()!; if (tail !== n && !idx.deps.has(tail)) idx.deps.set(tail, rel); };
  try {
    if (name === "package.json") {
      const j = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) for (const d of Object.keys(j[k] ?? {})) add(d);
    } else if (name === "pyproject.toml" || name === "cargo.toml") {
      let inArr = false; let inTable = false;
      for (const ln of text.split("\n")) {
        const t = ln.trim();
        if (/^\[/.test(t)) { inTable = /dependencies\]$/.test(t); inArr = false; continue; }
        if (/^(dependencies|requires|dev|test|optional-dependencies)\s*=\s*\[/.test(t) || /^[\w-]+\s*=\s*\[/.test(t) && /dependencies/.test(t)) inArr = true;
        if (inArr) { for (const m of t.matchAll(/["']([A-Za-z][A-Za-z0-9_.-]*)/g)) add(m[1]!); if (t.includes("]")) inArr = false; continue; }
        if (inTable) { const m = /^([A-Za-z][A-Za-z0-9_.-]*)\s*=/.exec(t); if (m) add(m[1]!); }
      }
    } else if (/^requirements[^/]*\.txt$/.test(name)) {
      for (const ln of text.split("\n")) { const m = /^\s*([A-Za-z][A-Za-z0-9_.-]*)/.exec(ln); if (m && !ln.trim().startsWith("#")) add(m[1]!); }
    } else if (name === "go.mod") {
      for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\/[^\s]+)\s+v\d/gm)) add(m[1]!);
    }
  } catch { /* manifesto inválido: ignora */ }
}

function commitTokens(subject: string, files: CommitInfo["files"]): Set<string> {
  const s = new Set<string>();
  for (const w of fold(subject).match(/[a-z][a-z0-9_]{2,}/g) ?? []) { s.add(w); for (const p of identParts(w)) s.add(p); s.add(`id:${canonicalIdent(w)}`); }
  for (const f of files) for (const part of f.path.split("/")) { const ps = identParts(part.replace(/\.[a-z0-9]+$/i, "")); for (const p of ps) s.add(p); if (ps.length > 1) s.add(`id:${ps.join("_")}`); }
  return s;
}

const ADR_NUM = /(?:adr[\s_-]*)?0*(\d{1,4})\b/i;
export function parseAdr(path: string, text: string): AdrInfo {
  const num = Number(/(^|\/)(?:adr[-_]?)?0*(\d{1,4})[-_]/i.exec(path)?.[2] ?? NaN);
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? path;
  const head = text.split("\n").slice(0, 40).join("\n");
  const status = /^\s*(?:[-*]\s*)?(?:\*\*)?status(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*([^\n]+)/im.exec(head)?.[1]?.replace(/\*\*/g, "").trim()
    ?? /^##\s*status\s*\n+\s*([^\n]+)/im.exec(text)?.[1]?.trim();
  const refs = (re: RegExp) => [...text.matchAll(re)].map((m) => Number(ADR_NUM.exec(m[2] ?? "")?.[1] ?? NaN)).filter((n) => Number.isFinite(n) && n !== num);
  const supersedes = refs(/\b(supersedes|substitui|replaces|substitui a|supersede)\s*[:：]?\s*((?:a\s+)?(?:adr[\s_-]*)?0*\d{1,4})/gi);
  const supersededBy = refs(/\b(superseded by|substitu[ií]d[ao] (?:pela|por)|replaced by)\s*[:：]?\s*((?:a\s+)?(?:adr[\s_-]*)?0*\d{1,4})/gi);
  return { path, ...(Number.isFinite(num) ? { num } : {}), title: redactSecrets(title), ...(status ? { status: redactSecrets(status).slice(0, 120) } : {}), supersedes: [...new Set(supersedes)], supersededBy: [...new Set(supersededBy)] };
}

/**
 * Pickaxe limitado (`git log -S`): commits que mudaram o número de ocorrências do termo FORA de docs. Orçamento por índice
 * (não por candidato) e timeout curto: evita análise histórica combinatória em repositórios grandes.
 */
export async function pickaxe(idx: RepoIndex, term: string): Promise<Array<{ short: string; date: string; subject: string; sha: string }> | undefined> {
  if (idx.pickaxeBudget.cache.has(term)) return idx.pickaxeBudget.cache.get(term);
  if (idx.pickaxeBudget.left <= 0 || !idx.head || !/^[A-Za-z0-9_.:-]{3,64}$/.test(term)) return undefined;
  idx.pickaxeBudget.left--;
  try {
    const out = await safeGit(idx.root, ["log", idx.head.sha, "--max-count=20", "--no-ext-diff", "--no-textconv", `-S${term}`, "--format=%H%x1f%h%x1f%cI%x1f%s", "--", ".", ":(exclude)*.md", ":(exclude)*.mdx", ":(exclude)*.txt"], { timeout: 6000 });
    // assunto vira evidência: mascarado antes de qualquer recorte
    const r = out.trim().split("\n").filter(Boolean).map((ln) => { const [sha = "", short = "", date = "", subject = ""] = ln.split("\x1f"); return { sha, short, date, subject: redactSecrets(subject) }; });
    idx.pickaxeBudget.cache.set(term, r); return r;
  } catch { idx.pickaxeBudget.cache.set(term, []); return undefined; }
}

export function fileHistory(idx: RepoIndex, path: string): PathHistory | undefined { return idx.history.get(path); }
export function kindOfDoc(path: string, text?: string): SourceKind { return sourceKindOf(path, text); }

/**
 * `git grep` no HEAD (fora de docs), para quando o índice está INCOMPLETO ou para confirmar que um termo não existe em lugar
 * nenhum (nem em comentário). Variantes snake/compacta com -i cobrem camelCase. Orçamento por índice; resultado em cache.
 */
export async function headGrep(idx: RepoIndex, variants: string[]): Promise<string | null | undefined> {
  const vs = [...new Set(variants.filter((v) => /^[A-Za-z0-9_.:@/-]{3,64}$/.test(v)))].slice(0, 16); // todas as variantes/aliases
  if (!vs.length || !idx.head) return undefined;
  const key = vs.join("|");
  if (idx.grepBudget.cache.has(key)) return idx.grepBudget.cache.get(key);
  if (idx.grepBudget.left <= 0) return undefined;
  idx.grepBudget.left--;
  const pattern = vs.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  try {
    const out = await safeGit(idx.root, ["grep", "--no-textconv", "-I", "-l", "-i", "-E", "-e", pattern, idx.head.sha, "--", ".", ":(exclude)*.md", ":(exclude)*.mdx", ":(exclude)*.txt"], { timeout: 6000 });
    const first = out.split("\n").find(Boolean)?.replace(/^[0-9a-f]+:/, "") ?? null;
    idx.grepBudget.cache.set(key, first); return first;
  } catch (e) {
    // código 1 = nenhuma ocorrência (não é erro)
    if ((e as { code?: number }).code === 1) { idx.grepBudget.cache.set(key, null); return null; }
    return undefined;
  }
}
