import type { Confidence, Freshness, NoteType } from "@brain/shared";
import { NEGATIONS, fold, jaccard, numbersOf, plain, tokenize } from "../text.js";
import { assess, hasStrongCue, isAssertion, isDeictic, isGenericHeading, isImplementationDetail, leadClause, resolveDeictic, sentencesOf, stripNumbering } from "./quality.js";

export interface Candidate {
  id: string; title: string; type: NoteType; body: string; tags: string[];
  confidence: Confidence; rule: string; evidence: string;
  source: { path: string; heading?: string };
  /** por que virou proposta (mostrado na revisão) */
  why?: string[];
  /** caminho de cabeçalhos pai */
  parent?: string;
  /** heading-based | enriched | title-synthesized | split | group */
  flags?: string[];
  /** reconciliação com o estado atual do repositório (preenchida pelo importador quando há git) */
  freshness?: Freshness;
}
export interface Rejection { title: string; reason: string; source: { path: string; heading?: string } }

interface Section { level: number; heading: string; path: string[]; text: string }

const IGNORE_HEADINGS = /^(install(ation|ação)?|instalação|setup|usage|uso|license|licen[cç]a|contribut|scripts?|comandos?|commands?|estrutura|structure|getting started|in[ií]cio r[aá]pido|quick ?start|[ií]ndice|table of contents|toc|badges?|sum[aá]rio|desenvolvimento e verifica|development|build|test(es|s)?|run|executar|pr[eé]-?requisit|requisitos?( de sistema)?|requirements? \(setup\)|exemplos?|examples?|changelog|agradecimentos|credits|faq)\b/i;
const stripNum = stripNumbering;
const SKIP_HEADING = /^(task|step|passo|etapa|fase|phase|milestone|sprint)\s*\d+/i;

/** Sinais ANCORADOS no início do cabeçalho (sem numeração): "Decisão de validação" conta; "Motor de decisão" não. */
const HEAD_SIGNALS: Array<{ type: NoteType; tag?: string; re: RegExp }> = [
  { type: "open-question", re: /^((perguntas?|quest(õ|o)es|pontos?|itens?|riscos?|decis(õ|o)es|temas?)\b.*\b(em aberto|abertas?|pendentes?)|open (questions?|issues?|risks?)|pend(ê|e)ncias|unresolved|questions)\b/i },
  { type: "decision", re: /^(decis(ão|ões|ao|oes)|decisions?|trade-?offs?|alternativas (consideradas|rejeitadas|descartadas)|alternatives (considered|rejected)|why not|por ?qu(e|ê)|why\b|princ(í|i)pios|principles|premissas|assumptions|selected approach|abordagem escolhida|escolha|rationale|justificativa)/i },
  { type: "decision", tag: "constraint", re: /^(restri(ç|c)(ã|a|õ|o)(o|es)|constraints?|invariantes?|invariants?|hard rules?|requisitos n(ã|a)o funcionais|non-?functional)/i },
  { type: "learning", re: /^(li(ç|c)(ã|a|õ|o)(o|es)|learnings?|lessons?|armadilhas?|pitfalls?|gotchas?|caveats?|known (issues?|limitations?)|limita(ç|c)(ã|a|õ|o)(o|es)|problemas conhecidos|cuidados?|aten(ç|c)(ã|a)o|warnings?)/i },
  { type: "pattern", re: /^(padr(õ|o)es?|patterns?|conven(ç|c)(õ|o)es|conventions?|boas pr(á|a)ticas|best practices|abordagem|approach|workflow)/i },
  { type: "reference", re: /^(refer(ê|e)ncias|references|see also|veja tamb(é|e)m|links? (ú|u)teis|leitura)/i },
  { type: "concept", tag: "architecture", re: /^(architecture|arquitetura|how it works|como funciona|vis(ã|a)o (geral )?da arquitetura)/i },
];
/** Sinais no corpo (somente com --loose). */
const BODY_SIGNALS: Array<{ type: NoteType; re: RegExp }> = [
  { type: "decision", re: /(decid(imos|iu|ido)|we (chose|decided|picked|adopted)|optamos|escolhemos|adotamos|em vez de|instead of|rejeit(ado|amos)|rejected|trade-?off)/i },
  { type: "learning", re: /(learn(ed|ing)s?|li[cç][aã]o|aprendemos|gotcha|pitfall|armadilha|caveat|root cause|causa raiz|workaround)/i },
  { type: "pattern", re: /(pattern|padr[aã]o|convention|conven[cç][aã]o|best practices?)/i },
];

/** Cabeçalho ATX em tempo linear (sem regex com backtracking). */
function parseHeading(ln: string): { level: number; text: string } | undefined {
  if (ln.length > 2000) ln = ln.slice(0, 2000);
  let i = 0; while (i < ln.length && ln[i] === "#") i++;
  if (i < 1 || i > 6 || (ln[i] !== " " && ln[i] !== "\t")) return undefined;
  let end = ln.length; while (end > i && (ln[end - 1] === " " || ln[end - 1] === "\t" || ln[end - 1] === "#")) end--;
  const text = ln.slice(i, end).trim();
  return text ? { level: i, text } : undefined;
}

/** Divide por cabeçalhos ATX, ignorando blocos de código. */
export function sections(md: string): Section[] {
  const out: Section[] = []; const stack: Array<{ level: number; h: string }> = [];
  let cur: Section | undefined; let fence = false; let front = false;
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() === "---") { const e = lines.indexOf("---", 1); if (e > 0) { lines.splice(0, e + 1); front = true; } }
  void front;
  const intro: Section = { level: 0, heading: "", path: [], text: "" };
  cur = intro; out.push(intro);
  for (const ln of lines) {
    if (/^\s*(```|~~~)/.test(ln)) { fence = !fence; cur.text += ln + "\n"; continue; }
    const m = !fence ? parseHeading(ln) : null;
    if (m) {
      const level = m.level; const h = m.text.replace(/[*_`]/g, "").trim();
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, h });
      cur = { level, heading: h, path: stack.map((s) => s.h), text: "" };
      out.push(cur);
    } else cur.text += ln + "\n";
  }
  return out.filter((s) => s.text.trim() || s.heading);
}

const stripCode = (t: string): string => {
  // remove blocos cercados em tempo linear
  const out: string[] = []; let fence = false;
  for (const ln of t.split("\n")) { if (/^\s{0,3}(```|~~~)/.test(ln)) { fence = !fence; continue; } if (!fence) out.push(ln.length > 4000 ? ln.slice(0, 4000) : ln); }
  return out.join("\n");
};

/** Corta em fronteira de sentença (nunca no meio de uma frase, salvo uma única frase gigante). */
function cutSentences(text: string, max: number): string {
  if (text.length <= max) return text;
  const ss = sentencesOf(text); let out = "";
  for (const x of ss) { if ((out + " " + x).trim().length > max) break; out = (out + " " + x).trim(); }
  if (out) return out;
  if (text.length <= max * 1.5) return text; // uma única frase longa: preferível inteira a cortada no meio
  return text.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

/** Resumo extrativo curto: lista (até 6 itens) ou prosa (até 3 sentenças), ≤ max caracteres, sempre em fronteira de item/sentença. */
export function summarize(text: string, max = 620, opts: { preferProse?: boolean } = {}): string {
  const t = stripCode(text.replace(/\[\[/g, "[").replace(/\]\]/g, "]")).replace(/^[ \t]*\|.*$/gm, " ").trim();
  const bullets = t.split("\n").filter((l) => /^\s*([-*]|\d+\.)\s+\S/.test(l)).map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim());
  // com UM só item de lista, ele é o conteúdo (não pode ser descartado); com ≥ 2 a lista é tratada como lista
  const para = t.split(/\n[ \t]*\n/).map((p) => (bullets.length >= 2 ? p.replace(/^[ \t]*([-*]|\d+\.)[ \t]+.*$/gm, " ") : p.replace(/^[ \t]*(?:[-*]|\d+\.)[ \t]+/gm, "")).replace(/\n/g, " ").replace(/\s+/g, " ").trim()).filter((p) => p.length > 20 && !/^[>#|]/.test(p));
  const prose = () => cutSentences(sentencesOf(para.join(" ")).slice(0, 3).map(clean).join(" "), max);
  if (opts.preferProse && para.length) return prose();
  if (bullets.length >= 2) {
    let out = ""; const items: string[] = [];
    for (const b of bullets.slice(0, 6)) { const line = `- ${clean(b)}`; if ((out + "\n" + line).length > max && items.length) break; items.push(line); out = items.join("\n"); }
    return out;
  }
  return prose();
}
const clean = (s: string) => s.slice(0, 4000).replace(/\[([^\]\n]{1,200})\]\([^)\n]{1,500}\)/g, "$1").replace(/\*\*([^*\n]{1,200})\*\*/g, "$1").replace(/`([^`\n]{1,200})`/g, "$1").replace(/\s+/g, " ").trim();

export const shortTitle = (t: string): string => {
  const x = t.replace(/\s+/g, " ").trim();
  if (x.length <= 90) return x;
  const cut = x.slice(0, 90); const paren = cut.lastIndexOf(" (");
  return (paren > 40 ? cut.slice(0, paren) : cut.replace(/\s+\S*$/, "")).trim();
};
const slugTag = (s: string) => fold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);

function adrFrom(md: string, path: string): Candidate | undefined {
  const secs = sections(md);
  const h1 = secs.find((s) => s.level === 1);
  if (!h1) return undefined;
  const title = h1.heading.replace(/^(adr[\s-]*)?\d+\s*[—–:.-]\s*/i, "").replace(/^adr[\s-]*\d*\s*[—–:.-]?\s*/i, "").trim() || h1.heading;
  const pick = (re: RegExp) => secs.find((s) => s.level >= 2 && re.test(fold(s.heading)));
  const dec = pick(/^(decis|decision|resolution|orienta|recomenda|escolha|chosen)/); const why = pick(/^(por que|why|contexto|context|rationale|motivo|razao|justificativa)/); const cons = pick(/^(consequen|consequences|trade)/);
  const parts: string[] = [];
  const status = /status\s*:\s*([^\n·|]+)/i.exec(h1.text)?.[1]?.trim();
  if (dec) parts.push(`**Decisão:** ${summarize(dec.text, 520)}`);
  if (why) parts.push(`**Por quê:** ${summarize(why.text, 420)}`);
  if (cons) parts.push(`**Consequências:** ${summarize(cons.text, 320)}`);
  if (!parts.length) { const all = summarize(secs.filter((x) => x.level >= 2).map((x) => x.text).join("\n\n"), 600); if (all.length < 60) return undefined; parts.push(all); }
  const body = parts.join("\n\n") + (status ? `\n\n_Status no ADR: ${status}._` : "");
  const a = assess({ title: shortTitle(title), body, heading: title, viaHeading: false, synthesizedTitle: false, enriched: false, strongSource: dec ? "adr-decision" : undefined });
  if (a.verdict === "reject") return undefined;
  return {
    id: "", title: shortTitle(title), type: "decision", body, tags: ["adr"], confidence: a.confidence, rule: "adr", why: a.why, flags: a.flags,
    evidence: clean(stripCode((dec ?? why ?? h1).text)).slice(0, 240), source: { path, heading: shortTitle(h1.heading) },
  };
}

function classify(sec: Section, loose: boolean): { type: NoteType; rule: string; tag?: string } | undefined {
  const head = stripNum(sec.heading); const fhead = fold(head);
  if (SKIP_HEADING.test(fhead)) return undefined;
  const body = stripCode(sec.text);
  // links dominantes => reference
  const links = (body.match(/\]\(https?:\/\//g) ?? []).length;
  const lines = body.split("\n").filter((l) => l.trim()).length;
  if (lines > 0 && links >= 3 && links / lines > 0.5) return { type: "reference", rule: "links" };
  if (/^(TBD|TODO)\b/.test(head)) return { type: "open-question", rule: "heading:open-question" };
  for (const s of HEAD_SIGNALS) if (s.re.test(fhead)) return { type: s.type, rule: `heading:${s.type}`, tag: s.tag };
  if (/(^|\n)\s*(?:[-*]\s+)?(?:TBD|TODO)\b\s*[:\-—]?/.test(body.slice(0, 300))) return { type: "open-question", rule: "body:todo" };
  if (!loose) return undefined; // precisão > recall: sinais só no corpo exigem --loose
  for (const s of BODY_SIGNALS) { if ((body.match(new RegExp(s.re.source, "gi"))?.length ?? 0) >= 3) return { type: s.type, rule: `body:${s.type}` }; }
  return undefined;
}

export interface ExtractOptions { loose?: boolean; project?: string; kind?: "generic" | "agents" | "readme" | "adr" | "skill" | "plan" }

export function docKind(path: string): NonNullable<ExtractOptions["kind"]> {
  const l = path.toLowerCase();
  if (/(^|\/)(plans?|planos?|roadmaps?|todos?|tasks?|reviews?)\//.test(l)) return "plan";
  if (/(^|\/)skill\.md$/.test(l)) return "skill";
  if (/(^|\/)(agents|claude)\.md$/.test(l)) return "agents";
  if (/(^|\/)(adr|adrs|decisions?)\//.test(l) || /(^|\/)(?!(19|20)\d{2}-\d{2}-\d{2})\d{2,4}-[^/]+\.md$/.test(l)) return "adr";
  if (/(^|\/)readme(\.[a-z]+)?\.md$/.test(l)) return "readme";
  return "generic";
}

const BULLET_RE = /^[ \t]*(?:[-*]|\d+\.)[ \t]+(?:\[[ xX]\][ \t]*)?(\S.*)$/;
/** Tipos cujas listas são conjuntos de itens INDEPENDENTES (vale separar); listas de limitações/perguntas/referências são coesas (ficam juntas). */
const SPLITTABLE: NoteType[] = ["decision", "pattern", "preference"];
const MAX_SPLIT = 3;           // por seção: poucos e bons
const MAX_PER_DOC = 6;         // por documento

/** Assunto do documento: H1 (parte antes do travessão) — ou o nome do projeto quando o H1 é um nome de arquivo (README/CLAUDE.md). */
function subjectOf(h1: string | undefined, project?: string): string {
  const head = (h1 ?? "").split(/\s+[—–:-]\s+/)[0]!.trim();
  if (!head || /^(claude|agents|readme)(\.md)?$/i.test(head)) return (project ?? "").split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return head;
}

function listItems(text: string): string[] {
  const items: string[] = [];
  for (const ln of stripCode(text).split("\n")) {
    const m = BULLET_RE.exec(ln);
    if (m) items.push(m[1]!.trim());
    else if (items.length && /^\s{2,}\S/.test(ln)) items[items.length - 1] += " " + ln.trim(); // continuação de item
  }
  return items;
}

interface Ctx { path: string; h1?: string; subject: string; commitless?: boolean }

function refine(sec: Section, hint: { type: NoteType; rule: string; tag?: string }, ctx: Ctx, loose: boolean): { cands: Candidate[]; rejections: Rejection[] } {
  const cands: Candidate[] = []; const rejections: Rejection[] = [];
  const heading = stripNum(sec.heading); const generic = isGenericHeading(heading);
  const parent = sec.path.slice(0, -1).map(stripNum).join(" › ");
  const src = { path: ctx.path, heading: shortTitle(sec.path.map(stripNum).join(" › ")) };
  const rej = (title: string, reason: string) => rejections.push({ title: shortTitle(title), reason, source: src });
  const baseTitle = ctx.subject && generic && fold(ctx.subject) !== fold(heading) ? `${ctx.subject}: ${heading}` : (heading.split(/\s+/).length < 4 && ctx.subject && fold(ctx.subject) !== fold(heading) ? `${ctx.subject}: ${heading}` : heading);
  const ctxLine = `Contexto: ${(sec.path.length ? sec.path.map(stripNum) : [ctx.subject]).join(" › ")}.`;
  const tags = [...new Set([hint.tag, ...(sec.path.length > 1 ? [slugTag(sec.path[0]!)] : [])].filter((x): x is string => !!x && x.length > 2))].slice(0, 4);
  /** Monta e AVALIA um candidato (não adiciona). Rejeições são registradas com o motivo. */
  const build = (title: string, body: string, type: NoteType, evidence: string, extra: { synthesized: boolean; enriched?: boolean; split?: boolean; group?: boolean }): Candidate | undefined => {
    // lista de links sem prosa descritiva é derivável por busca: não é conhecimento
    const urls = (body.match(/https?:\/\/\S+/g) ?? []).length;
    if (urls >= 3 && body.replace(/https?:\/\/\S+/g, "").replace(/[-*:\s]/g, "").length < 40 * urls) { rej(title, "lista de links sem descrição própria (derivável por busca)"); return undefined; }
    // abertura deítica cujo antecedente é o cabeçalho informativo ("Estas decisões…" sob "Decisões futuras"): reformula com o cabeçalho
    const firstLine = sentencesOf(body.replace(/^[ \t]*[-*][ \t]+/gm, ""))[0] ?? "";
    if (isDeictic(firstLine) && !generic && !extra.split) {
      const r = resolveDeictic(body, heading);
      if (r) { body = r; title = leadClause(sentencesOf(r)[0] ?? title); if (ctx.subject && !fold(title).includes(fold(ctx.subject)) && ctx.subject.length + 2 + title.length <= 90) title = `${ctx.subject}: ${title}`; extra = { ...extra, synthesized: true, enriched: true }; }
    }
    const a = assess({ title, body, heading, viaHeading: hint.rule.startsWith("heading"), synthesizedTitle: extra.synthesized, enriched: !!extra.enriched, group: extra.group, question: type === "open-question" });
    if (a.verdict === "reject") { rej(title, a.reason ?? "rejeitado"); return undefined; }
    if (a.confidence === "low" && !loose) { rej(title, "evidência fraca (confiança baixa)"); return undefined; }
    const flags = [...a.flags, ...(extra.split ? ["split"] : []), ...(extra.group ? ["group"] : [])];
    const withCtx = a.needsContext ? `${ctxLine}\n\n${body}` : body;
    return { id: "", title: shortTitle(title), type, body: withCtx, tags, confidence: a.confidence, rule: hint.rule, evidence: clean(evidence).slice(0, 240), source: src, why: a.why, parent: parent || undefined, flags };
  };

  const items = listItems(sec.text);
  // item "rico": frase completa e autocontida o bastante para virar conhecimento sozinha
  const rich = (i: string) => isAssertion(i) && /[.!?]["')\]]?$/.test(i.trim()) && ((i.trim().length >= 60 && tokenize(i, { stem: false }).length >= 7) || (hasStrongCue(i) && i.trim().length >= 45 && tokenize(i, { stem: false }).length >= 6));
  // ATOMICIDADE: lista de itens independentes em seção de decisão/regra → um candidato por item. TODOS são avaliados ANTES do limite por seção.
  if (SPLITTABLE.includes(hint.type) && items.length >= 2 && !loose) {
    const accepted: Array<{ c: Candidate; score: number; idx: number }> = []; let short = 0, detail = 0, nocue = 0, failed = 0;
    items.forEach((it, idx) => {
      if (!rich(it)) { short++; return; }
      if (isImplementationDetail(it)) { detail++; return; }
      if (!hasStrongCue(it)) { nocue++; return; }
      const lead = leadClause(it); const subj = ctx.subject;
      const titled = subj && !fold(lead).includes(fold(subj)) && subj.length + 2 + lead.length <= 90 ? `${subj}: ${lead}` : lead; // assunto no título melhora a recuperação
      const c = build(titled, `${clean(it)}\n\n${ctxLine}`, hint.type, it, { synthesized: true, split: true });
      if (c) accepted.push({ c, score: (hasRationaleLike(it) ? 1 : 0) + Math.min(2, it.length / 120), idx }); else failed++;
    });
    const keep = [...accepted].sort((x, y) => y.score - x.score).slice(0, MAX_SPLIT).sort((x, y) => x.idx - y.idx);
    cands.push(...keep.map((k) => k.c));
    const over = accepted.length - keep.length;
    const parts = [short && `${short} curto(s)/sem contexto próprio`, detail && `${detail} detalhe(s) de implementação`, nocue && `${nocue} sem marcador normativo explícito`, failed && `${failed} reprovado(s) na autocontenção/durabilidade`, over > 0 && `${over} acima do limite de ${MAX_SPLIT} por seção`].filter(Boolean);
    if (parts.length) rej(heading, `${items.length - keep.length} de ${items.length} itens da lista não propostos: ${parts.join(", ")}`);
    return { cands, rejections };
  }
  // seção coesa → UM candidato; título sintetizado do conteúdo quando o cabeçalho é organizacional
  const summary = summarize(sec.text);
  if (summary.length < 35) { rej(baseTitle, "conteúdo curto demais"); return { cands, rejections }; }
  const sents = sentencesOf(stripCode(sec.text).replace(/^[ \t]*[-*][ \t]+/gm, ""));
  const lead = sents.find((x) => isAssertion(x, hint.type === "open-question"));
  const synth = generic && !!lead && items.length < 2; // parágrafo sob cabeçalho genérico: o título vem da afirmação
  const title = synth ? leadClause(lead!) : baseTitle;
  let type = hint.type;
  if (/^(known (issues?|limitations?)|limita)/i.test(fold(heading))) type = "fact"; // limitações são fatos do projeto, não lições
  const c = build(title, summary, type, stripCode(sec.text), { synthesized: synth, group: items.length >= 2 });
  if (c) cands.push(c);
  return { cands, rejections };
}
const hasRationaleLike = (s: string): boolean => /\b(porque|pois|because|since|para que|so that)\b/i.test(s);

/** Extrai candidatos a conhecimento durável de UM documento. Pipeline: seção → durabilidade → autocontenção → atomicidade → evidência → candidato. */
export function extractCandidates(md: string, path: string, opts: ExtractOptions = {}): { candidates: Candidate[]; skippedSections: number; rejections: Rejection[] } {
  const kind = opts.kind ?? docKind(path);
  const out: Candidate[] = []; const rejections: Rejection[] = []; let skipped = 0;
  if (kind === "plan" || kind === "skill") return { candidates: [], skippedSections: 0, rejections }; // efêmeros / já versionados
  if (kind === "adr") {
    const a = adrFrom(md, path);
    if (a) return { candidates: [a], skippedSections: 0, rejections };
  }
  const all = sections(md);
  const secs = all.filter((s) => s.level >= 2 || (kind === "readme" && s.level <= 1));
  const h1 = all.find((s) => s.level === 1)?.heading;
  const ctx: Ctx = { path, h1, subject: subjectOf(h1, opts.project) };
  for (const sec of secs) {
    const heading = sec.heading || h1 || path;
    // seções de comandos/instalação em CLAUDE.md/AGENTS.md são deriváveis (build/test): só aí o filtro é incondicional
    if (kind === "agents" && sec.level >= 2 && IGNORE_HEADINGS.test(fold(sec.heading))) { skipped++; continue; }
    const txt = stripCode(sec.text).trim();
    if (txt.length < 35) { skipped++; continue; }

    if (kind === "readme" && sec.level <= 1) {
      // visão geral: primeiro parágrafo em prosa (não a lista de princípios)
      const summary = summarize(sec.text, 480, { preferProse: true });
      const a = assess({ title: h1 ?? heading, body: summary, heading: h1 ?? heading, viaHeading: false, synthesizedTitle: false, enriched: false });
      if (a.verdict === "accept") out.push({ id: "", title: h1 ?? heading, type: "project", body: summary, tags: ["overview"], confidence: a.confidence === "high" ? "medium" : a.confidence, rule: "readme:overview", evidence: clean(summary).slice(0, 240), source: { path, heading: h1 }, why: ["visão geral do projeto (primeiro parágrafo do README)", ...a.why.slice(0, 1)], flags: a.flags });
      else rejections.push({ title: h1 ?? heading, reason: a.reason ?? "rejeitado", source: { path, heading: h1 } });
      continue;
    }
    if (kind === "agents") {
      const items = listItems(sec.text);
      if (items.length >= 2) {
        const body = summarize(sec.text, 760);
        const a = assess({ title: sec.heading, body, heading: sec.heading, viaHeading: false, synthesizedTitle: false, enriched: false, strongSource: "agents-rules" });
        if (a.verdict === "accept") { out.push({ id: "", title: shortTitle(sec.heading), type: "preference", body, tags: ["agent-rules"], confidence: a.confidence, rule: "agents:rules", evidence: clean(txt).slice(0, 240), source: { path, heading: sec.heading }, why: a.why, parent: ctx.subject, flags: a.flags }); continue; }
        rejections.push({ title: sec.heading, reason: a.reason ?? "rejeitado", source: { path, heading: sec.heading } }); continue;
      }
    }
    const c = classify(sec, !!opts.loose);
    if (!c) { skipped++; continue; }
    const r = refine(sec, c, ctx, !!opts.loose);
    out.push(...r.cands); rejections.push(...r.rejections);
  }
  if (out.length > MAX_PER_DOC) {
    const rank = (c: Candidate) => (c.confidence === "high" ? 2 : 1);
    const keep = new Set([...out].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_PER_DOC));
    for (const c of out) if (!keep.has(c)) rejections.push({ title: c.title, reason: `acima do limite de ${MAX_PER_DOC} candidatos por documento`, source: c.source });
    return { candidates: out.filter((c) => keep.has(c)), skippedSections: skipped, rejections };
  }
  return { candidates: out, skippedSections: skipped, rejections };
}

/** Mesma polaridade e mesmos números: "deve permitir" × "não deve permitir" ou "3 s" × "5 s" NÃO são o mesmo conhecimento. */
const sameFacets = (a: string, b: string): boolean => NEGATIONS.test(fold(a)) === NEGATIONS.test(fold(b)) && numbersOf(a).join(",") === numbersOf(b).join(",");
/** Fração de `a` coberta por `b` (direcional). */
const coverage = (a: Set<string>, b: Set<string>): number => { if (!a.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / a.size; };

/**
 * Remove redundância DENTRO da mesma importação: (1) candidatos praticamente idênticos (preservando polaridade e números);
 * (2) listas coesas (limitações etc.) que repetem itens já mantidos em outra lista do mesmo tipo — os itens repetidos saem;
 * a lista sobrevive com os itens restantes. Itens só são "vistos" depois que o candidato é mantido.
 */
export function dedupeCandidates(list: Candidate[]): { kept: Candidate[]; dropped: number } {
  const kept: Candidate[] = []; const keptText: string[] = []; const sets: Array<Set<string>> = []; let dropped = 0;
  const seenItems: Array<{ type: string; text: string; set: Set<string> }> = [];
  for (const c0 of list) {
    let c = c0;
    let lines: string[] = [];
    if (c.flags?.includes("group")) {
      lines = c.body.split("\n").filter((l) => l.startsWith("- "));
      const fresh = lines.filter((l) => { const t = new Set(tokenize(plain(l))); return !seenItems.some((k) => k.type === c.type && jaccard(k.set, t) >= 0.6 && sameFacets(k.text, l)); });
      if (fresh.length === 0) { dropped++; continue; }
      if (fresh.length < lines.length) {
        const single = fresh.length === 1;
        c = { ...c, body: single ? fresh[0]!.replace(/^- /, "") : fresh.join("\n"), flags: single ? (c.flags ?? []).filter((f) => f !== "group") : c.flags, why: [...(c.why ?? []), `${lines.length - fresh.length} item(ns) repetido(s) de outra lista foram removidos`] };
        lines = fresh;
      }
    }
    const text = `${c.title} ${c.body}`; const s = new Set(tokenize(plain(text)));
    const dup = sets.findIndex((k, i) => sameFacets(keptText[i]!, text) && (jaccard(k, s) >= 0.7 || (Math.min(k.size, s.size) >= 6 && coverage(s, k) >= 0.85 && coverage(k, s) >= 0.6)));
    if (dup >= 0) { dropped++; continue; }
    kept.push(c); keptText.push(text); sets.push(s);
    for (const l of lines) seenItems.push({ type: c.type, text: l, set: new Set(tokenize(plain(l))) });
  }
  return { kept, dropped };
}
