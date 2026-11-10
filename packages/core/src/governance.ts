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
    exTok.forEach((e, i) => { const c = containment(t, e); if (c > best) { best = c; bestIdx = i; } });
    const covered = containment(t, all);
    // número divergente em sentença que fala do mesmo assunto
    if (bestIdx >= 0 && best >= 0.5) {
      const ex = exSents[bestIdx]!;
      const a = numbersOf(s); const b = numbersOf(ex);
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

/** Classifica a nova informação. Heurística explicável; a decisão final é sempre humana (ou política explícita). */
export function classify(
  draft: DraftLike, matches: SimilarMatch[], getBody: (id: string) => { title: string; body: string } | undefined,
  cfg: BrainConfig["governance"], hint?: { intent?: "new" | "complement" | "update" | "replace"; target_id?: string },
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

  // alvo explicitamente indicado + intenção de substituir/atualizar: respeita a intenção do chamador
  if (hint?.target_id && top.id === hint.target_id && (hint.intent === "replace" || hint.intent === "update" || hint.intent === "complement")) {
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
export function mergeUpdate(existingBody: string, draftBody: string, stamp: string): { body: string; replaced: number; appended: number } {
  const lines = existingBody.split("\n");
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
      lines[bi] = bullet + s.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""); replaced++;
    } else if (!(bi >= 0 && best >= 0.85)) rest.push(s);
  }
  let body = lines.join("\n").trimEnd();
  if (rest.length) body += `\n\n## Atualização — ${stamp}\n\n${rest.join("\n")}`;
  return { body: body + "\n", replaced, appended: rest.length };
}
