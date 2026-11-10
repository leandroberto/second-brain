import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Brain } from "./brain.js";
import { integrationStatus } from "./integration.js";
import { revisionOf } from "./markdown.js";

export interface Check { id: string; name: string; status: "ok" | "warn" | "fail"; detail: string; fix?: string }

const c = (id: string, name: string, status: Check["status"], detail: string, fix?: string): Check => ({ id, name, status, detail, ...(fix ? { fix } : {}) });

/** Verificações do que o Core controla: vault, Git, SQLite, FTS e consistência índice × arquivos. */
export async function coreDoctor(b: Brain): Promise<Check[]> {
  const out: Check[] = [];
  const v = b.vault;
  out.push(v.exists() ? c("vault", "Vault", "ok", v.root) : c("vault", "Vault", "fail", `estrutura ausente em ${v.root}`, "brain init"));
  try { void b.config; out.push(c("config", "Config", "ok", `${v.configPath}`)); } catch (e) { out.push(c("config", "Config", "fail", (e as Error).message, "corrija .brain/config.yaml")); }

  // Git
  if (!(await b.git.isRepo())) out.push(c("git", "Git", "fail", "o vault não é um repositório Git", `git -C ${v.root} init`));
  else {
    const dirty = await b.git.dirty("knowledge"); const head = await b.git.head();
    out.push(!head ? c("git", "Git", "warn", "repositório sem commits", "brain commit")
      : dirty.length ? c("git", "Git", "warn", `${dirty.length} arquivo(s) de conhecimento sem commit (edições manuais?)`, "brain commit") : c("git", "Git", "ok", `HEAD ${head}, árvore limpa`));
  }

  // SQLite
  try {
    const q = (b.db.db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
    out.push(q === "ok" ? c("sqlite", "SQLite", "ok", `schema v${b.db.getMeta("schema_version")}, WAL`) : c("sqlite", "SQLite", "fail", `quick_check: ${q}`, "apague .brain/index.db* e rode: brain reindex"));
  } catch (e) { out.push(c("sqlite", "SQLite", "fail", (e as Error).message, "apague .brain/index.db* e rode: brain reindex")); }

  // FTS
  try {
    const notes = (b.db.db.prepare("SELECT COUNT(*) n FROM notes").get() as { n: number }).n;
    const fts = (b.db.db.prepare("SELECT COUNT(*) n FROM fts").get() as { n: number }).n;
    b.db.db.prepare("SELECT id FROM fts WHERE fts MATCH ? LIMIT 1").all('"x"*');
    out.push(notes === fts ? c("fts", "Busca FTS5", "ok", `${fts} documentos indexados`) : c("fts", "Busca FTS5", "fail", `fts=${fts} ≠ notas=${notes}`, "brain reindex"));
  } catch (e) { out.push(c("fts", "Busca FTS5", "fail", (e as Error).message, "brain reindex")); }

  // consistência índice × arquivos (somente leitura)
  const files = v.exists() ? v.listFiles() : [];
  const rows = b.db.allStat();
  const missing = files.filter((f) => !rows.has(f));
  const ghost = [...rows.keys()].filter((p) => !files.includes(p));
  let stale = 0;
  for (const f of files) { const r = rows.get(f); if (!r) continue; try { if (revisionOf(readFileSync(join(v.root, f), "utf8")) !== r.revision) stale++; } catch { /* arquivo some durante a verificação */ } }
  const dupes = (b.db.db.prepare("SELECT COUNT(*) n FROM dupes").get() as { n: number }).n;
  const bad = missing.length + ghost.length + stale;
  out.push(bad === 0 && dupes === 0 ? c("index", "Consistência do índice", "ok", `${files.length} arquivos = ${rows.size} linhas`)
    : c("index", "Consistência do índice", dupes ? "fail" : "warn", `${missing.length} não indexados, ${ghost.length} fantasmas, ${stale} desatualizados, ${dupes} ids duplicados`, dupes ? "resolva os ids duplicados (veja Configurações → Saúde) e rode brain reindex" : "brain reindex"));

  // embeddings
  const h = await b.health();
  out.push(h.embeddings.ok ? c("embeddings", "Embeddings", "ok", `${h.embeddings.provider} ${h.embeddings.covered}/${h.embeddings.total}${h.embeddings.external ? " (EXTERNO)" : " (local)"}`)
    : c("embeddings", "Embeddings", "warn", `${h.embeddings.covered}/${h.embeddings.total} cobertos (${h.embeddings.provider}); busca textual segue funcionando`, "brain reindex"));
  if (h.problems.notes_with_issues) out.push(c("notes", "Arquivos de conhecimento", "warn", `${h.problems.notes_with_issues} nota(s) com problemas de frontmatter`, "veja Configurações → Saúde"));
  if (h.problems.dangling_links) out.push(c("links", "Relações", "warn", `${h.problems.dangling_links} link(s) quebrados`, "corrija ou crie as notas alvo"));
  const lock = existsSync(b.vault.lockPath);
  if (lock) out.push(c("lock", "Lock de escrita", "warn", "lock presente (outra operação em andamento ou processo morto; locks velhos são limpos sozinhos em 30 s)"));
  return out;
}

/** Estado das integrações globais (Claude Code / Codex), lido dos arquivos de configuração — sem executar nada. */
export function integrationChecks(vault: string): Check[] {
  const st = integrationStatus(); const out: Check[] = [];
  for (const [key, label] of [["claude", "Claude Code"], ["codex", "Codex"]] as const) {
    const s = st[key]; const issues: string[] = [];
    if (!s.mcp) issues.push("MCP não registrado"); else {
      if (s.vault && s.vault !== vault) issues.push(`aponta para outro vault (${s.vault})`);
      const bp = (s.command ?? "").split(" ").find((x) => x.endsWith("bin.js"));
      if (bp && !existsSync(bp)) issues.push(`binário não existe: ${bp}`);
    }
    if (!s.policy) issues.push("política (AGENTS) ausente");
    if (!s.skill) issues.push("skill ausente");
    out.push(issues.length ? c(`int-${key}`, `Integração ${label}`, "warn", issues.join("; "), "brain integrate --apply") : c(`int-${key}`, `Integração ${label}`, "ok", "MCP + política + skill"));
  }
  return out;
}
