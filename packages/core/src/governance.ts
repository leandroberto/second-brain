import type { Analysis, Classification, Resolution, SimilarMatch } from "@brain/shared";
import type { BrainConfig } from "./config.js";
import { NEGATIONS, containment, fold, jaccard, numbersOf, plain, sentences, tokenize } from "./text.js";

export interface DraftLike { title: string; body: string }

export interface Comparison {
  novelRatio: number; contradictions: string[]; changedValues: string[]; novelSentences: string[];
}

const NEG_WORDS = new Set(["nao", "nunca", "never", "not", "jamais", "sem", "no", "longer", "deixou"]);
/** Mesmo assunto = conjuntos de tokens (sem palavras de negação) quase idênticos; evita acusar conflito quando só há mais detalhe. */
function sameSubject(a: string, b: string): boolean {
  const ta = new Set(tokenize(a).filter((t) => !NEG_WORDS.has(t))); const tb = new Set(tokenize(b).filter((t) => !NEG_WORDS.has(t)));
  return jaccard(ta, tb) >= 0.75;
}

/** Compara o rascunho com o corpo de uma nota existente, sentença a sentença. */
export function compare(draft: DraftLike, existing: { title: string; body: string }): Comparison {
  const exSents = sentences(`${existing.title}. ${existing.body}`);
  const exTok = exSents.map((s) => new Set(tokenize(s)));
  const all = new Set(tokenize(plain(`${existing.title} ${existing.body}`)));
  const drafts = sentences(`${draft.title}. ${draft.body}`);
  const novel: string[] = []; const contradictions: string[] = []; const changed: string[] = [];
  for (const s of drafts) {
    const t = new Set(tokenize(s));
    if (t.size < 2) continue;
    let bestIdx = -1; let best = 0;
    // melhor sentença existente que TAMBÉM traz número: a de maior cobertura costuma ser o título ("Timeout do lote", contido
    // inteiro em "Timeout do lote é 60 s"), e comparar números só com ela deixava o valor divergente da linha "… é 30 s" passar
    // como sentença já coberta (ou complemento)
    const a = numbersOf(s);
    let numIdx = -1; let numBest = 0;
    exTok.forEach((e, i) => {
      const c = containment(t, e);
      if (c > best) { best = c; bestIdx = i; }
      if (a.length && c > numBest && numbersOf(exSents[i]!).length) { numBest = c; numIdx = i; }
    });
    const covered = containment(t, all);
    // número divergente em sentença que fala do mesmo assunto
    if (bestIdx >= 0 && best >= 0.5) {
      const ex = exSents[bestIdx]!;
      const b = numbersOf(numIdx >= 0 && numBest >= 0.5 ? exSents[numIdx]! : ex);
      const onlyA = a.filter((x) => !b.includes(x)); const onlyB = b.filter((x) => !a.includes(x));
      const negA = NEGATIONS.test(fold(s)); const negB = NEGATIONS.test(fold(ex));
      if (negA !== negB && best >= 0.55 && sameSubject(s, ex)) contradictions.push(`"${s}" vs "${ex}"`);
      else if (onlyA.length && onlyB.length) changed.push(`${onlyB.join(",")} → ${onlyA.join(",")}`);
      else if (best < 0.8) novel.push(s);
    } else if (covered < 0.7) novel.push(s);
  }
  const total = drafts.filter((s) => tokenize(s).length >= 2).length || 1;
  return { novelRatio: novel.length / total, contradictions, changedValues: changed, novelSentences: novel };
}

type Hint = { intent?: "new" | "complement" | "update" | "replace"; target_id?: string };
/** Classes que a política `additive` aplica sem humano; qualquer outra vai para a fila. */
const ADDITIVE = new Set<Classification>(["new", "complement", "duplicate"]);

/**
 * Classifica a nova informação. Heurística explicável; a decisão final é sempre humana (ou política explícita).
 *
 * `trustHint: false` (política `additive`, ADR 0014): a dica do agente (`intent`/`target_id`) só pode ESCALAR. Se a heurística
 * independente achar contradição ou valor divergente — contra o alvo declarado ou contra a nota semelhante que ela mesma
 * escolheria sem a dica —, prevalece a heurística: um "complemento" declarado nunca rebaixa `update` ou `conflict`. E um
 * complemento sobre um alvo declarado sem relação (fora dos candidatos relevantes e diferente do que a heurística escolheria)
 * cede à classificação independente (tipicamente `new`).
 */
export function classify(
  draft: DraftLike, matches: SimilarMatch[], getBody: (id: string) => { title: string; body: string } | undefined,
  cfg: BrainConfig["governance"], hint?: Hint, opts: { trustHint?: boolean } = {},
): Analysis {
  const trust = opts.trustHint !== false;
  const a = classifyWith(draft, matches, getBody, cfg, hint, trust);
  if (trust || !hint || (!hint.intent && !hint.target_id) || !ADDITIVE.has(a.classification)) return a;
  // a dica pode ter apontado outro alvo: a heurística SEM dica (melhor candidato real) também tem voto para escalar
  const indep = classifyWith(draft, matches, getBody, cfg, undefined, true);
  const merged = (w: string[] = []) => ({ ...indep, warnings: [...new Set([...a.warnings, ...w, ...indep.warnings])] });
  if (!ADDITIVE.has(indep.classification)) return merged();
  // complemento sobre um alvo DECLARADO só vale se o alvo for um candidato relevante ou o mesmo que a heurística escolheria
  // sozinha; senão o rascunho seria anexado a uma nota arbitrária (o alvo declarado entra nos candidatos com similaridade 0)
  if (a.classification === "complement" && a.target_id && a.target_id === hint.target_id && a.target_id !== indep.target_id) {
    const sim = matches.find((m) => m.id === a.target_id)?.similarity ?? 0;
    if (sim < cfg.candidate_threshold) return merged([`alvo indicado ${a.target_id} não tem relação suficiente com o rascunho; vale a classificação independente`]);
  }
  return a;
}

function classifyWith(
  draft: DraftLike, matches: SimilarMatch[], getBody: (id: string) => { title: string; body: string } | undefined,
  cfg: BrainConfig["governance"], hint: Hint | undefined, trustHint: boolean,
): Analysis {
  const warnings: string[] = [];
  const relevant = matches.filter((m) => m.similarity >= cfg.candidate_threshold);
  const top = hint?.target_id ? matches.find((m) => m.id === hint.target_id) ?? relevant[0] : relevant[0];
  if (hint?.target_id && !top) warnings.push(`alvo ${hint.target_id} não encontrado entre as notas semelhantes`);
  if (!top) {
    return { classification: "new", confidence: relevant.length === 0 ? "high" : "medium", suggested_resolution: "create", matches, warnings };
  }
  const ex = getBody(top.id);
  const cmp = ex ? compare(draft, ex) : { novelRatio: 1, contradictions: [], changedValues: [], novelSentences: [] };
  let classification: Classification; let resolution: Resolution; let confidence: Analysis["confidence"] = "medium";

  // alvo explicitamente indicado + intenção de substituir/atualizar: respeita a intenção do chamador — exceto, sem confiança na
  // dica, quando o alvo contradiz o rascunho ou tem valor divergente: aí decide a heurística abaixo (conflict/update/replace)
  const escalates = !trustHint && (cmp.contradictions.length > 0 || cmp.changedValues.length > 0);
  if (!escalates && hint?.target_id && top.id === hint.target_id && (hint.intent === "replace" || hint.intent === "update" || hint.intent === "complement")) {
    if (top.status === "superseded") warnings.push(`"${top.title}" já foi substituída; considere o sucessor`);
    const c = ex ? compare(draft, ex) : undefined;
    if (c?.contradictions.length) warnings.push(`possível contradição: ${c.contradictions[0]}`);
    return { classification: hint.intent, confidence: "medium", suggested_resolution: hint.intent, target_id: top.id, matches, warnings };
  }

  if (top.status === "superseded") warnings.push(`"${top.title}" já foi substituída; considere o sucessor`);
  if (cmp.contradictions.length) {
    classification = "conflict"; resolution = hint?.intent === "replace" ? "replace" : "keep_separate"; confidence = "low";
    warnings.push(`possível contradição: ${cmp.contradictions[0]}`);
  } else if (top.similarity >= cfg.duplicate_threshold && cmp.novelRatio <= 0.2 && !cmp.changedValues.length) {
    classification = "duplicate"; resolution = "ignore"; confidence = "high";
  } else if (cmp.changedValues.length) {
    classification = hint?.intent === "replace" ? "replace" : "update";
    resolution = hint?.intent === "replace" ? "replace" : "update"; confidence = "medium";
    warnings.push(`valor divergente (${cmp.changedValues.join("; ")}): confirme se é atualização, substituição ou conflito`);
  } else if (hint?.intent === "replace") { classification = "replace"; resolution = "replace"; }
  else if (hint?.intent === "update") { classification = "update"; resolution = "update"; }
  else if (cmp.novelRatio > 0.2) { classification = "complement"; resolution = "complement"; }
  else { classification = "duplicate"; resolution = "ignore"; confidence = "medium"; }

  return { classification, confidence, suggested_resolution: resolution, target_id: top.id, matches, warnings };
}

/**
 * Merge heurístico para "update": linhas existentes cujo assunto coincide com uma sentença do rascunho
 * (mas com valores diferentes) são substituídas; sentenças realmente novas entram numa seção ao final.
 * O resultado é apenas uma PRÉVIA — o revisor pode editar antes de confirmar.
 */
export function mergeUpdate(existingBody: string, draftBody: string, stamp: string, opts: { keepHistory?: boolean } = {}): { body: string; replaced: number; appended: number } {
  let lines = existingBody.split("\n");
  // keepHistory: a seção "## Histórico" existente sai do corpo durante o merge e volta ao final, depois das novas seções.
  // A data vem do próprio stamp ("AAAA-MM-DD (autor)"), sem relógio aqui, para o resultado ser determinístico.
  let history: string[] | null = null; // bloco existente literal (cabeçalho incluso), só sem brancos finais
  const added: string[] = [];
  const day = /^\d{4}-\d{2}-\d{2}/.exec(stamp)?.[0] ?? stamp;
  if (opts.keepHistory) {
    const h = lines.findIndex((l) => /^##\s+Histórico\s*$/.test(l));
    if (h >= 0) {
      const n = lines.findIndex((l, i) => i > h && /^##\s/.test(l));
      const e = n < 0 ? lines.length : n;
      history = lines.slice(h, e).join("\n").trimEnd().split("\n");
      lines = [...lines.slice(0, h), ...lines.slice(e)];
    }
  }
  const lineTok = lines.map((l) => new Set(tokenize(plain(l))));
  let replaced = 0; const rest: string[] = [];
  for (const s of draftBody.split("\n").flatMap((l) => (l.trim() ? [l.trim()] : []))) {
    const t = new Set(tokenize(plain(s)));
    if (t.size < 2) continue;
    let bi = -1; let best = 0;
    lineTok.forEach((e, i) => { if (!lines[i]!.trim() || /^\s*#/.test(lines[i]!)) return; const c = containment(t, e); if (c > best) { best = c; bi = i; } });
    const differs = bi >= 0 && fold(lines[bi]!).trim() !== fold(s).trim();
    if (bi >= 0 && best >= 0.5 && differs && numbersOf(s).some((n) => !numbersOf(lines[bi]!).includes(n))) {
      const bullet = /^(\s*(?:[-*]|\d+\.)\s+)/.exec(lines[bi]!)?.[1] ?? "";
      if (opts.keepHistory) added.push(`- ${lines[bi]!.trim().replace(/^(?:[-*]|\d+\.)\s+/, "")} (deixou de valer em ${day})`);
      lines[bi] = bullet + s.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""); replaced++;
    } else if (!(bi >= 0 && best >= 0.85)) rest.push(s);
  }
  let body = lines.join("\n").trimEnd();
  if (rest.length) body += `\n\n## Atualização — ${stamp}\n\n${rest.join("\n")}`;
  if (history || added.length) {
    const block = history ?? ["## Histórico"];
    if (added.length && block.length === 1) block.push("");
    body += `\n\n${[...block, ...added].join("\n")}`;
  }
  return { body: body + "\n", replaced, appended: rest.length };
}
