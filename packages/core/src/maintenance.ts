import { basename } from "node:path";
import { BrainError, type Freshness, type Note, type Proposal } from "@brain/shared";
import { principal } from "./authz.js";
import type { Brain } from "./brain.js";
import { reconcileBatch } from "./freshness/index.js";
import { gitTopLevel } from "./freshness/repo.js";
import { plain } from "./text.js";

/**
 * MANUTENÇÃO da base sem curadoria humana: o sistema encontra o problema, junta a evidência e deixa uma PROPOSTA pronta
 * (Confirmar · Alterar · Ignorar). Nunca altera nota em silêncio; nada aqui decide.
 */
const MAINTAINER = principal("system", "maintenance", "maintenance");
const today = () => new Date().toISOString().slice(0, 10);
// a origem é QUEM produziu a nota (agente = síntese); `source.kind` descreve a referência, não a autoria
const originOf = (n: Note): "imported" | "agent" | "human" => n.created_by?.kind === "agent" ? "agent" : n.verification ? "imported" : "human";
const firstPath = (ref = "") => ref.split(/[;,\s]/)[0]!.replace(/#.*$/, "").replace(/@[0-9a-f]{6,40}$/, "").replace(/:[\d,-]+$/, "") || undefined;
const pendingFor = (brain: Brain, id: string, kind: "revalidate" | "title") => brain.listProposals("pending").find((p) => p.maintenance?.kind === kind && p.target_id === id);

/** Notas ATIVAS ligadas a um repositório: pelo `source.repository` (com ou sem dono) ou pelo projeto de mesmo nome. */
function notesOfRepo(brain: Brain, repoName: string, project?: string): Note[] {
  const rows = brain.db.rows("status='active'", [], "updated_at DESC", Number.MAX_SAFE_INTEGER);
  const out: Note[] = [];
  for (const r of rows) {
    let n: Note; try { n = brain.loadNote(r.id); } catch { continue; }
    if (n.type === "project" && !n.temporal) continue; // visão geral: descritiva, revisada à parte
    const repo = n.source?.repository ? basename(n.source.repository) : undefined;
    // pelo repositório citado OU pelo projeto (checkout com outro nome, worktree): `--project` restringe/define a correspondência
    if (project ? n.project === project : (repo === repoName || n.project === repoName)) out.push(n);
  }
  return out;
}

export interface RevalidationItem { id: string; title: string; temporal: boolean; origin: string; freshness?: Freshness; needs: boolean; proposal?: string; skipped?: string }

/**
 * Revalidação de conhecimento APROVADO contra o HEAD atual (uma varredura por repositório, cache por HEAD). Uma nota precisa de
 * revalidação quando surge evidência nova e incompatível (sugestão `revalidate`) ou a fonte foi substituída. Com `apply`, cada
 * caso vira UMA proposta de manutenção (alvo = a nota; rascunho = o mesmo texto com a data de validade renovada).
 */
export async function revalidateNotes(brain: Brain, repoPath: string, o: { apply?: boolean; project?: string } = {}) {
  const top = await gitTopLevel(repoPath);
  if (!top) throw new BrainError("invalid", `não é um repositório git: ${repoPath}`);
  const name = basename(top);
  const notes = notesOfRepo(brain, name, o.project);
  const b = await reconcileBatch(notes.map((n) => ({ title: n.title, body: n.body, path: firstPath(n.source?.ref), origin: originOf(n), asOf: n.temporal?.as_of ?? n.created_at })), { scanRoot: top, ignore: [name, ...new Set(notes.map((n) => n.project).filter((x): x is string => !!x))] });
  const items: RevalidationItem[] = [];
  for (const [i, n] of notes.entries()) {
    const f = b.results[i];
    const needs = !!f && (f.suggestion === "revalidate" || (originOf(n) === "imported" && ["superseded", "reverted", "historical", "conflict"].includes(f.state)));
    const it: RevalidationItem = { id: n.id, title: n.title, temporal: !!n.temporal, origin: originOf(n), ...(f ? { freshness: f } : {}), needs };
    if (needs && o.apply) {
      const dup = pendingFor(brain, n.id, "revalidate");
      if (dup) it.skipped = `já há revalidação pendente (${dup.id})`;
      else {
        const p = await brain.propose({
          title: n.title, type: n.type, body: n.body, project: n.project, tags: n.tags, source: n.source,
          ...(n.temporal ? { temporal: n.temporal } : {}), // a nova data de validade é a do ACEITE (calculada no resolve)
          intent: "update", target_id: n.id, reason: `Revalidação: ${f!.summary}`, freshness: f,
          maintenance: { kind: "revalidate", reason: `${f!.summary} Confirmar = continua valendo${n.temporal ? ` (validade renovada para ${today()})` : ""}; Alterar = edite o texto para o estado novo; Ignorar = mantém como está.`, evidence: f!.evidence.filter((e) => e.stance !== "supports").slice(0, 4).map((e) => `${e.ref}: ${e.detail}`.slice(0, 240)) },
        }, MAINTAINER);
        it.proposal = p.id;
      }
    }
    items.push(it);
  }
  return { repo: name, against: b.index?.head ? `${name}@${b.index.head.short}` : undefined, ms: b.ms, items, applied: !!o.apply };
}

// ---------------- qualidade de títulos ----------------
// título que COMEÇA pelo nome do arquivo ("CLAUDE.md: Architecture", "README › Setup"); citar CLAUDE.md no meio de uma afirmação é legítimo
const FILE_TITLE = /^\s*(?:[\w./-]+\.(?:md|mdx)|claude|readme|agents|progress|changelog|contributing|handoff)(?:\.md)?\s*[:›>-]/i;
const META_HEAD = /^(decis(?:ões|oes|ão|ao)(?:\s+(?:fechadas|aprovadas|já aprovadas|futuras|tomadas))?|notas?|resumo|summary|overview|vis[aã]o geral|arquitetura|architecture|references?|refer[eê]ncias|known limitations|limita[cç][oõ]es(?: conhecidas)?|selected approach|abordagem(?: escolhida)?|contexto|context|status|misc|geral|introdu[cç][aã]o|introduction|decision|decisions|considera[cç][oõ]es|observa[cç][oõ]es|pontos? (?:importantes|de aten[cç][aã]o))\b/i;
const DOC_REF = /\b(neste documento|deste documento|this document|nesta se[cç][aã]o|this section|abaixo|below|acima|above)\b/i;

export interface TitleIssue { id: string; title: string; project?: string; issues: string[]; suggestion: string; evidence: string }

/** Títulos que não se sustentam fora do documento de origem (dependem do nome do arquivo, são só organizacionais ou sem sujeito). */
export function titleIssues(n: Pick<Note, "title" | "type" | "project" | "body">, projectTitle?: string): string[] {
  if (n.type === "project") return [];
  const t = n.title.trim(); const rest = t.replace(/^[^:]{2,40}:\s*/, ""); const issues: string[] = [];
  if (FILE_TITLE.test(t)) issues.push("depende do nome do arquivo");
  if (META_HEAD.test(rest) && rest.split(/\s+/).length <= 5) issues.push("organizacional (cabeçalho de seção, não afirmação)");
  if (DOC_REF.test(t)) issues.push("refere-se ao documento de origem");
  const words = rest.split(/\s+/).filter((w) => w.length > 2);
  if (words.length < 3 || (projectTitle && rest.toLowerCase() === projectTitle.toLowerCase())) issues.push("sem sujeito/afirmação (pouco recuperável)");
  return [...new Set(issues)];
}

/** Sugestão determinística: a primeira afirmação do corpo, prefixada pelo projeto (o revisor pode editar antes de aceitar). */
export function suggestTitle(n: Pick<Note, "title" | "body" | "project">, projectTitle?: string): { title: string; evidence: string } {
  const lines = n.body.split("\n").map((l) => l.trim()).filter((l) => l && !/^#/.test(l) && !/^_?status no adr/i.test(l));
  // limpeza leve: tira marcação Markdown, mas preserva identificadores (app.run_watcher, NOTIFICATION_MODE)
  const clean = (l: string) => l.replace(/^[-*]\s+(\[[ xX]\]\s+)?/, "").replace(/^\*\*[^*]{2,30}:\*\*\s*/, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
  // lista de referências ("Nome: https://…"): o título vira "Referências: A, B, C"
  const refs = lines.filter((l) => /^[-*]\s+[^:]{3,60}:\s*https?:\/\//.test(l)).map((l) => clean(l).split(":")[0]!.trim());
  if (refs.length >= 2 && refs.length >= lines.length * 0.6) {
    const t = `${projectTitle ? `${projectTitle}: ` : ""}referências — ${[...new Set(refs)].slice(0, 3).join(", ")}`.slice(0, 200);
    return { title: t, evidence: `lista de ${refs.length} referências externas no corpo` };
  }
  const first = lines.map(clean).find((l) => l.split(" ").length >= 4) ?? plain(n.body).slice(0, 120);
  let s = first.split(/(?<=[.;])\s/)[0]!.replace(/[.;:]+$/, "");
  if (s.length > 90) {
    const colon = s.indexOf(": "); // "X faz Y: detalhe…" → a afirmação termina antes dos dois-pontos
    s = colon > 30 && colon <= 90 ? s.slice(0, colon) : s.slice(0, s.slice(0, 90).lastIndexOf(" ")).replace(/[,(–-]\s*$/, "");
  }
  s = s.charAt(0).toUpperCase() + s.slice(1);
  const prefix = projectTitle && !s.toLowerCase().includes(projectTitle.toLowerCase()) ? `${projectTitle}: ` : "";
  const t = `${prefix}${s}`.slice(0, 200); // sem rebaixar a inicial: costuma ser nome próprio (Telegram, Telethon)
  return { title: t, evidence: `primeira afirmação do corpo: "${first.slice(0, 140)}"` };
}

export async function auditTitles(brain: Brain, o: { apply?: boolean; project?: string } = {}) {
  await brain.sync({ maxAgeMs: 1000 });
  const projTitle = (p?: string) => (p ? brain.db.rows("type='project' AND project=?", [p], "updated_at DESC", 1)[0]?.title : undefined);
  const out: Array<TitleIssue & { proposal?: string; skipped?: string }> = [];
  for (const r of brain.db.rows(o.project ? "status='active' AND project=?" : "status='active'", o.project ? [o.project] : [], "updated_at DESC", Number.MAX_SAFE_INTEGER)) {
    let n: Note; try { n = brain.loadNote(r.id); } catch { continue; }
    const pt = projTitle(n.project); const issues = titleIssues(n, pt);
    if (!issues.length) continue;
    const s = suggestTitle(n, pt);
    const item: TitleIssue & { proposal?: string; skipped?: string } = { id: n.id, title: n.title, project: n.project, issues, suggestion: s.title, evidence: s.evidence };
    if (o.apply) {
      const dup = pendingFor(brain, n.id, "title");
      if (dup) item.skipped = `já há sugestão pendente (${dup.id})`;
      else item.proposal = (await brain.propose({ title: s.title, type: n.type, body: n.body, project: n.project, tags: n.tags, source: n.source, intent: "update", target_id: n.id, reason: `Título pouco recuperável (${issues.join("; ")})`, maintenance: { kind: "title", reason: `Título atual "${n.title}": ${issues.join("; ")}. Sugestão derivada do conteúdo; Confirmar renomeia (mesmo id e arquivo), Alterar permite editar o título, Ignorar mantém.`, evidence: [s.evidence] } }, MAINTAINER)).id;
    }
    out.push(item);
  }
  return { items: out, applied: !!o.apply };
}

// ---------------- saúde da base (somente leitura) ----------------
export async function knowledgeAudit(brain: Brain) {
  await brain.sync({ maxAgeMs: 1000 });
  const rows = brain.db.rows("1=1", [], "updated_at DESC", Number.MAX_SAFE_INTEGER);
  const notes = rows.flatMap((r) => { try { return [brain.loadNote(r.id)]; } catch { return []; } });
  const count = <T,>(xs: T[], f: (x: T) => string | undefined) => xs.reduce<Record<string, number>>((a, x) => { const k = f(x); if (k) a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const active = notes.filter((n) => n.status === "active");
  const linked = new Set((brain.db.db.prepare("SELECT src,dst FROM links").all() as Array<{ src: string; dst: string }>).flatMap((l) => [l.src, l.dst]));
  const projTitle = (p?: string) => (p ? notes.find((x) => x.type === "project" && x.project === p)?.title : undefined);
  const dupes: Array<{ a: string; b: string; similarity: number }> = [];
  for (const n of active) {
    for (const m of await brain.searcher.similar({ title: n.title, body: n.body, project: n.project, type: n.type }, { exclude: n.id, limit: 2, minScore: 0.6 })) {
      if (m.status === "active" && n.id < m.id && m.similarity >= 0.6) dupes.push({ a: n.id, b: m.id, similarity: Math.round(m.similarity * 100) / 100 });
    }
  }
  const verification = count(active, (n) => n.verification?.state ?? "sem verificação");
  return {
    total: notes.length,
    by_status: count(notes, (n) => n.status),
    current: active.filter((n) => !n.verification || n.verification.state === "current").length,
    historical: notes.filter((n) => n.status === "superseded" || n.verification?.state === "historical").length,
    superseded: notes.filter((n) => n.status === "superseded").length,
    temporal: active.filter((n) => !!n.temporal).length,
    uncertain: active.filter((n) => n.verification && ["uncertain", "conflict", "planned"].includes(n.verification.state)).length,
    verification, generic_titles: active.filter((n) => titleIssues(n, projTitle(n.project)).length).map((n) => ({ id: n.id, title: n.title })),
    without_project: active.filter((n) => !n.project).map((n) => n.id),
    orphans: active.filter((n) => !n.project && !linked.has(n.id)).map((n) => n.id),
    explicit_relations: (brain.db.db.prepare("SELECT COUNT(*) n FROM links").get() as { n: number }).n,
    possible_duplicates: dupes,
    pending_maintenance: count(brain.listProposals("pending").filter((p: Proposal) => !!p.maintenance), (p) => p.maintenance!.kind),
  };
}
