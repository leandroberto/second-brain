import { principal } from "../authz.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { BrainError, isValidId, slugify, type Analysis, type Classification, type Freshness, type FreshnessState } from "@brain/shared";
import { basename } from "node:path";
import { reconcileBatch } from "../freshness/index.js";
import { gitTopLevel } from "../freshness/repo.js";
import { redactSecrets } from "../secrets.js";
import type { Brain } from "../brain.js";
import { dedupeCandidates, docKind, extractCandidates, type Candidate, type Rejection } from "./extract.js";
import { assess } from "./quality.js";
import { readDoc, scanSource, type ScanOptions } from "./scan.js";

export { extractCandidates, scanSource, type Candidate };
const run = promisify(execFile);
const IMPORTER = principal("system", "import", "importer");
const RECONCILER = principal("system", "reconcile", "importer");

export interface ImportOptions {
  project?: string; loose?: boolean; dryRun?: boolean; max?: number; includeDuplicates?: boolean; gitLog?: boolean; scan?: Partial<ScanOptions>;
  /** reconciliar com o estado atual do repositório (padrão: sim quando a fonte é um repositório git) */
  reconcile?: boolean;
}
export type ItemStatus = "queued" | "dry-run" | "already-queued" | "duplicate-skipped" | "over-limit" | "rejected";
export interface ImportItem {
  candidate: Candidate; analysis: Analysis; status: ItemStatus; proposal_id?: string; reason?: string;
  source_ref: string;
}
export interface ImportReport {
  run: string; source: string; repo: string; project?: string; dry_run: boolean;
  files: number; skipped_files: Record<string, number>; skipped_sections: number; candidates: number; dropped_similar: number;
  counts: Partial<Record<Classification, number>>; queued: number; items: ImportItem[];
  /** candidatos descartados pelos filtros de qualidade (durabilidade/autocontenção/evidência), com o motivo */
  rejected: Rejection[];
  /** reconciliação com o estado atual: HEAD verificado, distribuição por estado e esforço de revisão, tempos */
  freshness?: FreshnessSummary;
}
export interface FreshnessSummary { against?: string; states: Partial<Record<FreshnessState, number>>; effort: Partial<Record<Freshness["effort"], number>>; ms: number; repo_ms?: number; files?: number; commits?: number; truncated?: boolean }

const cid = (c: { source: { path: string; heading?: string }; title: string }) => createHash("sha1").update(`${c.source.path}|${c.source.heading ?? ""}|${c.title}`).digest("hex").slice(0, 10);
const CONF = { high: 0, medium: 1, low: 2 } as const;

/** Raízes permitidas para importar por caminho (API/UI): a home do usuário. */
export function assertImportablePath(p: string, roots: string[] = [homedir()]): string {
  const abs = resolve(p);
  try { lstatSync(abs); } catch { throw new BrainError("not_found", `caminho não existe: ${p}`); }
  // canonicaliza (segue symlinks) tanto o alvo quanto as raízes: um link dentro da home que aponta para fora é recusado
  const real = realpathSync(abs);
  const inside = roots.some((r) => { let rr: string; try { rr = realpathSync(resolve(r)); } catch { return false; } const rel = relative(rr, real); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); });
  if (!inside) throw new BrainError("forbidden", `importação restrita a ${roots.join(", ")}`);
  return real;
}

async function gitHighlights(root: string, repo: string): Promise<Candidate[]> {
  try {
    const { stdout } = await run("git", ["-C", root, "log", "--max-count=400", "--format=%h%x1f%s%x1f%b%x1e"], { maxBuffer: 16 * 1024 * 1024 });
    const out: Candidate[] = [];
    for (const rec of stdout.split("\x1e")) {
      const [hash = "", subj = "", body = ""] = rec.trim().split("\x1f");
      if (!hash || !/(BREAKING CHANGE|^revert|\bdecid|\bADR\b|migrat|deprecat|workaround|root cause)/i.test(`${subj}\n${body}`)) continue;
      const text = (body.split(/\n\s*\n/)[0] ?? "").trim();
      const title = subj.replace(/^(feat|fix|refactor|chore|docs|revert)(\([^)]*\))?!?:\s*/i, "").slice(0, 120);
      out.push({ id: "", title, type: /^revert|root cause|workaround/i.test(subj + body) ? "learning" : "decision", body: `${subj}${text ? `\n\n${text.slice(0, 500)}` : ""}`, tags: ["git-history"], confidence: "low", rule: "git-log", evidence: subj, source: { path: `commit ${hash}`, heading: repo } });
      if (out.length >= 15) break;
    }
    return out;
  } catch { return []; }
}

/** Núcleo comum: candidatos → análise de governança → (opcional) fila de propostas. */
export async function processCandidates(brain: Brain, cands: Array<Candidate & { source_ref?: string }>, meta: { source: string; repo: string; project?: string; head?: string; files: number; skipped_files: Record<string, number>; skipped_sections: number; dropped_similar: number; rejected?: Rejection[]; freshness?: FreshnessSummary }, o: ImportOptions): Promise<ImportReport> {
  const runId = `imp-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${createHash("sha1").update(meta.source).digest("hex").slice(0, 4)}`;
  const started = new Date().toISOString();
  cands.forEach((c) => { c.id = cid(c); });
  const ordered = [...cands].sort((a, b) => CONF[a.confidence] - CONF[b.confidence]);
  const max = o.max ?? 30;
  const items: ImportItem[] = []; const counts: ImportReport["counts"] = {}; let queued = 0;
  for (const c of ordered) {
    // com reconciliação, a origem é gravada RELATIVA AO REPOSITÓRIO (import de subpasta continua reverificável por `brain reconcile`)
    const ref = c.source_ref ?? `${c.freshness?.source.path ?? c.source.path}${c.source.heading ? "#" + c.source.heading : ""}${meta.head ? `@${meta.head}` : ""}`;
    const draft = { title: c.title, type: c.type, body: c.body, project: meta.project, tags: c.tags, confidence: c.confidence, source: { type: "doc" as const, repository: meta.repo, ref } };
    let analysis: Analysis;
    try { analysis = await brain.analyze({ ...draft, intent: undefined }); }
    catch (e) {
      // candidato rejeitado por segredo NÃO pode ecoar o conteúdo no relatório (UI/CLI/JSON)
      const safe = e instanceof BrainError && e.code === "secret_detected" ? { ...c, title: redactSecrets(c.title), body: redactSecrets(c.body), evidence: redactSecrets(c.evidence) } : c;
      items.push({ candidate: safe, analysis: { classification: "new", confidence: "low", suggested_resolution: "create", matches: [], warnings: [] }, status: "rejected", reason: e instanceof BrainError ? `${e.code}: ${e.message}` : (e as Error).message, source_ref: ref }); continue;
    }
    counts[analysis.classification] = (counts[analysis.classification] ?? 0) + 1;
    if (c.freshness) c.freshness = withVault(c.freshness, analysis, brain.config.governance.candidate_threshold);
    const item: ImportItem = { candidate: c, analysis, status: "dry-run", source_ref: ref };
    if (analysis.classification === "duplicate" && !o.includeDuplicates) { item.status = "duplicate-skipped"; item.reason = `já coberto por "${analysis.matches[0]?.title}"`; items.push(item); continue; }
    if (queued >= max) { item.status = "over-limit"; items.push(item); continue; }
    if (o.dryRun) { items.push(item); queued++; continue; }
    try {
      const p = await brain.propose({ ...draft, ...(c.freshness ? { freshness: c.freshness, source: { ...draft.source, kind: c.freshness.source.kind } } : {}), reason: `import (${c.rule}) de ${ref}`, meta: { run: runId, rule: c.rule, evidence: c.evidence, source_path: c.source.path, ...(c.why?.length ? { why: c.why } : {}), ...(c.parent ? { parent: c.parent } : {}), ...(c.flags?.length ? { flags: c.flags } : {}) } }, IMPORTER);
      item.proposal_id = p.id; item.status = p.created_at < started ? "already-queued" : "queued"; if (item.status === "queued") queued++;
    } catch (e) {
      item.status = "rejected"; item.reason = e instanceof BrainError ? `${e.code}: ${e.message}` : (e as Error).message;
      if (e instanceof BrainError && e.code === "secret_detected") item.candidate = { ...c, title: redactSecrets(c.title), body: redactSecrets(c.body), evidence: redactSecrets(c.evidence) };
    }
    items.push(item);
  }
  brain.db.log(IMPORTER, o.dryRun ? "import_preview" : "import", null, { run: runId, source: meta.source, candidates: cands.length, queued, counts });
  return { run: runId, source: meta.source, repo: meta.repo, project: meta.project, dry_run: !!o.dryRun, files: meta.files, skipped_files: meta.skipped_files, skipped_sections: meta.skipped_sections, candidates: cands.length, dropped_similar: meta.dropped_similar, counts, queued, items, rejected: (meta.rejected ?? []).slice(0, 100).map((r) => ({ ...r, title: redactSecrets(r.title) })), ...(meta.freshness ? { freshness: meta.freshness } : {}) };
}

/**
 * Pergunta 4 da reconciliação: "já existe conhecimento relacionado na base?". Conhecimento histórico parecido com uma nota ATIVA
 * vira sugestão de anexar como histórico àquela nota (em vez de criar uma memória antiga solta).
 */
function withVault(f: Freshness, a: Analysis, threshold: number): Freshness {
  const top = a.matches.find((m) => m.similarity >= threshold);
  if (!top) return f;
  const evidence = [...f.evidence, { kind: "vault" as const, stance: "context" as const, ref: top.id, detail: `a base já tem conhecimento semelhante: "${top.title.slice(0, 80)}" (${top.status}, ${Math.round(top.similarity * 100)}%)` }].slice(0, 12);
  if (f.suggestion === "accept_historical" && top.status === "active") return { ...f, evidence, suggestion: "complement_current", suggestion_target: top.id };
  return { ...f, evidence };
}

/** Reconcilia candidatos de UMA fonte contra o estado atual (uma varredura do repositório; nunca escreve nele). */
export async function reconcileCandidates(cands: Candidate[], scanRoot: string | undefined, ignore: string[]): Promise<FreshnessSummary> { return attachFreshness(cands, scanRoot, ignore); }
async function attachFreshness(cands: Candidate[], scanRoot: string | undefined, ignore: string[]): Promise<FreshnessSummary> {
  const b = await reconcileBatch(cands.map((c) => ({ title: c.title, body: c.body, path: c.source.path, heading: c.source.heading })), { scanRoot, ignore });
  const states: FreshnessSummary["states"] = {}; const effort: FreshnessSummary["effort"] = {};
  cands.forEach((c, i) => { const f = b.results[i]; if (!f) return; c.freshness = f; states[f.state] = (states[f.state] ?? 0) + 1; effort[f.effort] = (effort[f.effort] ?? 0) + 1; });
  return { ...(b.index?.head ? { against: `${b.index.name}@${b.index.head.short}` } : {}), states, effort, ms: b.ms, ...(b.index ? { repo_ms: b.repoMs, files: b.index.stats.files, commits: b.index.stats.commits, truncated: b.index.stats.truncated } : {}) };
}

/** Importa um repositório, diretório ou arquivo Markdown. NADA entra na base: tudo vira proposta na Review Queue. */
export async function importPath(brain: Brain, input: string, o: ImportOptions = {}): Promise<ImportReport> {
  const scan = await scanSource(input, o.scan);
  const project = o.project ? (isValidId(o.project) ? o.project : slugify(o.project)) : (isValidId(slugify(scan.repoName)) ? slugify(scan.repoName) : undefined);
  let all: Candidate[] = []; let skippedSections = 0; const rejected: Rejection[] = [];
  for (const f of scan.files) {
    let md: string; try { md = readDoc(f); } catch { continue; }
    const r = extractCandidates(md, f.rel, { project, kind: docKind(f.rel), loose: o.loose });
    all.push(...r.candidates); skippedSections += r.skippedSections; rejected.push(...r.rejections);
  }
  if (o.gitLog) all.push(...(await gitHighlights(scan.root, scan.repoName)));
  // não propor visão geral de projeto se ele já existe
  if (project && brain.db.rows("type='project' AND project=?", [project], "updated_at DESC", 1).length) all = all.filter((c) => c.type !== "project");
  // títulos repetidos em documentos diferentes (ex.: "Known limitations") ganham o nome do arquivo para serem distinguíveis
  const byTitle = new Map<string, Candidate[]>();
  for (const c of all) byTitle.set(c.title, [...(byTitle.get(c.title) ?? []), c]);
  for (const [, g] of byTitle) if (g.length > 1) for (const c of g) { const f = c.source.path.split("/").pop()!.replace(/\.[a-z]+$/i, "").replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-design$/, ""); c.title = `${c.title} (${f})`.slice(0, 120); }
  const { kept, dropped } = dedupeCandidates(all);
  const freshness = o.reconcile !== false && scan.git ? await attachFreshness(kept, scan.root, [scan.repoName, ...(project ? [project] : [])]) : undefined;
  return processCandidates(brain, kept, { source: scan.root, repo: scan.repoName, project, head: scan.git?.head, files: scan.files.length, skipped_files: scan.skipped, skipped_sections: skippedSections, dropped_similar: dropped, rejected, freshness }, o);
}

/** Importa texto colado (Markdown ou notas soltas). */
export async function importText(brain: Brain, text: string, o: ImportOptions & { name?: string } = {}): Promise<ImportReport> {
  if (text.length > 400_000) throw new BrainError("too_large", "texto muito grande para importar (máx 400 KB)");
  const name = o.name ?? "texto colado";
  const r = extractCandidates(text.includes("\n#") || text.startsWith("#") ? text : `## ${name}\n\n${text}`, "paste.md", { project: o.project, kind: "generic", loose: o.loose });
  // texto colado SEM nenhum cabeçalho: um único candidato de baixa confiança, mas só se passar pela mesma avaliação de qualidade
  let cands = r.candidates; const rejections = [...r.rejections];
  const structured = /^#{1,6}[ \t]/m.test(text);
  if (!cands.length && !structured && text.trim().length >= 60) {
    const first = text.trim().split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 100);
    const body = text.trim().slice(0, 900); const title = first.length > 6 ? first : name;
    const a = assess({ title, body, heading: title, viaHeading: false, synthesizedTitle: true, enriched: false });
    if (a.verdict === "accept") cands = [{ id: "", title, type: "learning", body, tags: [], confidence: "low", rule: "paste:single", evidence: text.trim().slice(0, 240), source: { path: "paste" }, why: ["texto colado sem estrutura (um candidato, revisão obrigatória)", ...a.why], flags: [...a.flags, "unstructured"] }];
    else rejections.push({ title, reason: a.reason ?? "rejeitado", source: { path: "paste" } });
  }
  const { kept, dropped } = dedupeCandidates(cands);
  // sem repositório: só a semântica (texto formulado como plano nunca vira fato atual)
  const freshness = o.reconcile !== false ? await attachFreshness(kept, undefined, []) : undefined;
  return processCandidates(brain, kept, { freshness, source: "texto colado", repo: name, project: o.project, files: 1, skipped_files: {}, skipped_sections: r.skippedSections, dropped_similar: dropped, rejected: rejections }, o);
}

/** "docs/x.md#Cabeçalho@abc1234" → "docs/x.md" (caminho relativo ao repositório de origem). */
const refPath = (ref?: string): string | undefined => { const p = ref?.split("#")[0]?.replace(/@[0-9a-f]{7,40}$/, "").trim(); return p && !/^commit /.test(p) && !/[;\s]/.test(p) ? p : undefined; };

/**
 * Reverifica a atualidade de propostas PENDENTES vindas de um repositório (ex.: propostas criadas antes da reconciliação existir).
 * Padrão: somente leitura (relatório). Com `apply`, grava SÓ o campo `freshness` das propostas pendentes — nunca o rascunho,
 * nunca a decisão, nunca o repositório.
 */
export async function reconcilePending(brain: Brain, repoPath: string, o: { apply?: boolean; project?: string; ids?: string[] } = {}) {
  const top = await gitTopLevel(repoPath);
  if (!top) throw new BrainError("invalid", `não é um repositório git: ${repoPath}`);
  const name = basename(top);
  // só propostas IMPORTADAS desse repositório: aprendizados de agentes (conversa) não são afirmações sobre o estado do repositório
  const props = brain.listProposals("pending").filter((p) => (o.ids ? o.ids.includes(p.id) : p.draft.source?.repository === name && !!p.import) && (!o.project || p.draft.project === o.project));
  const cands = props.map((p) => ({ title: p.draft.title, body: p.draft.body, path: refPath(p.draft.source?.ref) ?? refPath(p.import?.source_path) }));
  const b = await reconcileBatch(cands, { scanRoot: top, ignore: [name, ...new Set(props.map((p) => p.draft.project).filter((x): x is string => !!x))] });
  const items = props.map((p, i) => ({ id: p.id, title: p.draft.title, path: cands[i]!.path, freshness: b.results[i] ? withVault(b.results[i]!, p.analysis, brain.config.governance.candidate_threshold) : undefined }));
  if (o.apply) await brain.attachFreshness(items.filter((x) => x.freshness).map((x) => ({ id: x.id, freshness: x.freshness! })), RECONCILER);
  return { repo: name, against: b.index?.head ? `${name}@${b.index.head.short}` : undefined, ms: b.ms, items, applied: !!o.apply };
}
