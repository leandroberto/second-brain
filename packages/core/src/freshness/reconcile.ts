import { basename } from "node:path";
import type { Confidence, Freshness, FreshnessEvidence, SourceKind } from "@brain/shared";
import { redactSecrets } from "../secrets.js";
import { fold } from "../text.js";
import { headGrep, parseAdr, pickaxe, type CommitInfo, type RepoIndex } from "./repo.js";
import { DESCRIPTION_KINDS, TECH, anchorsOf, canonicalIdent, changeSide, checkedTask, isPlanLanguage, pureChoice, selfDeprecation, sourceKindOf, type Anchor } from "./semantics.js";
import { CONDITIONAL, PRODUCTION_KEY, assignedInFile, productionStatement, stateClaims, toggleStatement } from "./propositions.js";

/**
 * Reconciliação com o estado atual (determinística, somente leitura, explicável).
 *
 * Duas perguntas SEPARADAS:
 *   intent          — a decisão/intenção registrada ainda vale? (ADR vigente, substituída, revertida)
 *   implementation  — o que o HEAD mostra? (código/config/dependências de PRODUÇÃO; testes só corroboram)
 * Código prova ESTADO, não INTENÇÃO; plano não prova implementação; repetir a afirmação em vários documentos não é evidência.
 * Toda conclusão carrega evidência rastreável (arquivo:linha, commit, ADR). Sem evidência suficiente → `uncertain`.
 */

export interface ReconcileInput {
  title: string; body: string; path?: string; heading?: string;
  /**
   * ORIGEM da afirmação — muda a estratégia:
   *   imported  trecho de documento: envelhece; documento posterior que descreve mudança o refuta
   *   agent / human  SÍNTESE (já resume várias evidências): termos parecidos noutro documento NÃO a refutam; só proposição
   *             incompatível, código/config atual, remoção no Git, revert ou documento/ADR POSTERIOR à data da síntese
   */
  origin?: "imported" | "agent" | "human";
  /** data a partir da qual uma evidência é "nova" para esta afirmação (temporal.as_of da nota, ou a data de criação) */
  asOf?: string;
  /** texto do documento de origem quando ele NÃO está no HEAD (arquivo não versionado), lido pela árvore de trabalho */
  docText?: string; untracked?: boolean;
}
export interface ReconcileContext { index?: RepoIndex; ignore?: string[]; now?: string }

interface Lookup { code: Array<{ path: string; line: number; legacy: boolean }>; tests: Array<{ path: string; line: number; weak: boolean }>; config: Array<{ path: string; line: number }>; dep?: string }

const SKIP_TEST = /\.skip\(|\bxit\(|\bxdescribe\(|\bxtest\(|@pytest\.mark\.(skip|xfail)|@unittest\.skip|\.todo\(|it\.only\.skip|pytest\.skip\(/;
const LEGACY_CTX = /legacy|legado|compat|deprecated|depreciad|backward|retrocompat|fallback|old_|_old\b|obsolete|migrat|migra[cç]/i;
const HIST_QUERY = /\b(historic|historico|history|evolu|por que mudou|why (did|was) .* change|antes|anterior|superseded|substituid|antig|legado|legacy|changed)\w*/;
const ADR_PROPOSED = /^(propost|proposed|draft|rascunho|em discuss|under discussion|pendente|pending|em an[aá]lise)/i;
const ADR_DEAD = /^(superseded|substitu[ií]d|replaced|deprecated|depreciad|obsolet|rejected|rejeitad|withdrawn|revogad)/i;
/** Mudança de estado/polaridade numa frase: a frase do adendo NÃO é a afirmação original se tem uma destas e a afirmação não. */
const CHANGE_CUE = /\b(nao|not|never|no longer|deixou|deixa de|nunca|jamais|substitu\w*|replac\w*|remov\w*|retir\w*|migr\w*|deprecat\w*|depreciad\w*|obsolet\w*|instead|em vez|revert\w*|abandon\w*)\b/g;

function lookup(idx: RepoIndex, a: Anchor): Lookup {
  const r: Lookup = { code: [], tests: [], config: [] };
  const keys: string[] = [];
  if (a.kind === "ident") keys.push(a.key);
  else if (a.kind === "path") {
    const p = a.key.slice(5);
    for (const [f, k] of idx.files) {
      if (k === "doc" || idx.vocab.has(f) || (f.toLowerCase() !== p && !f.toLowerCase().endsWith("/" + p))) continue;
      if (k === "test") r.tests.push({ path: f, line: 0, weak: false }); else if (k === "config") r.config.push({ path: f, line: 0 }); else r.code.push({ path: f, line: 0, legacy: false });
    }
    return r;
  } else if (a.kind === "tech") {
    const t = TECH.find((x) => `tech:${x.name}` === a.key)!;
    // aliases curtos ("pg") só contam como dependência declarada: como identificador seriam ambíguos
    for (const al of t.aliases) { if (al.length >= 3) { keys.push(`id:${canonicalIdent(al)}`); if (!/[^a-z0-9]/.test(al)) keys.push(`w:${al}`); } const d = idx.deps.get(al); if (d && !r.dep) r.dep = `${d} (${al})`; }
  } else keys.push(a.key);
  const seen = new Set<string>();
  for (const k of keys) for (const [path, line] of idx.ident.get(k) ?? []) {
    // arquivos-vocabulário (léxicos, listas de nomes, fixtures) não provam uso de NADA
    if (seen.has(path) || idx.vocab.has(path)) continue; seen.add(path);
    const kind = idx.files.get(path); const lines = idx.lines.get(path) ?? [];
    const ctx = lines.slice(Math.max(0, line - 3), line).join("\n");
    if (kind === "test") r.tests.push({ path, line, weak: SKIP_TEST.test(ctx) || LEGACY_CTX.test(lines[line - 1] ?? "") });
    else if (kind === "config") r.config.push({ path, line });
    else if (kind === "code") r.code.push({ path, line, legacy: line > 0 && LEGACY_CTX.test(lines[line - 1] ?? "") });
  }
  return r;
}

/** Implementação = código/config/dependência de PRODUÇÃO. Teste sozinho é corroboração (pode ser descrição, fixture ou legado). */
const production = (l: Lookup) => l.code.length + l.config.length + (l.dep ? 1 : 0) > 0;
function anywhereInHead(idx: RepoIndex, a: Anchor): boolean {
  const keys = a.kind === "tech" ? (TECH.find((x) => `tech:${x.name}` === a.key)?.aliases ?? []).filter((x) => x.length >= 3).flatMap((al) => [`id:${canonicalIdent(al)}`, `w:${al}`]) : [a.key];
  return keys.some((k) => (idx.ident.get(k)?.size ?? 0) > 0);
}
/** Variantes para `git grep -i`: texto, snake e compacta (camelCase casa com a compacta sem diferenciar maiúsculas). */
function variantsOf(a: Anchor): string[] {
  if (a.kind === "tech") return (TECH.find((x) => `tech:${x.name}` === a.key)?.aliases ?? []).filter((x) => x.length >= 3);
  if (a.kind === "path") return [basename(a.key.slice(5))];
  const canon = a.key.replace(/^\w+:/, "");
  return [a.text, canon, canon.replace(/_/g, "")];
}
/** Identificador vizinho: o mesmo nome sem o último segmento (≥ 2 segmentos restantes) presente em código. */
function nearIdent(idx: RepoIndex, canon: string): { name: string; hit: { path: string; line: number } } | undefined {
  const parts = canon.split("_"); if (parts.length < 3) return undefined;
  const name = parts.slice(0, -1).join("_");
  for (const [path, line] of idx.ident.get(`id:${name}`) ?? []) if (idx.files.get(path) === "code" && !idx.vocab.has(path)) return { name, hit: { path, line } };
  return undefined;
}
const loc = (h: { path: string; line: number }) => (h.line > 0 ? `${h.path}:${h.line}` : h.path);
const dateOf = (iso?: string) => iso?.slice(0, 10);
const fileDate = (p: string) => /(?:^|\/)((?:19|20)\d{2}-\d{2}-\d{2})/.exec(p)?.[1];
/** Datas do git vêm com fuso (%cI): comparar como instante, nunca como texto. */
const ts = (d?: string) => (d ? Date.parse(d.length === 10 ? `${d}T00:00:00Z` : d) : NaN);

/** Texto normalizado (sem acento, minúsculo) de cada documento, com segredos mascarados ANTES de normalizar/recortar. Uma vez por índice. */
function foldedDoc(idx: RepoIndex, p: string, t: string): string {
  let f = idx.docsFolded.get(p); if (f === undefined) { f = fold(redactSecrets(t)); idx.docsFolded.set(p, f); } return f;
}
/** Documentos que contêm o termo: índice de tokens → documentos (construído uma vez), depois confirmação por substring. */
function docsWithTerm(idx: RepoIndex, term: string): string[] {
  if (!idx.docPostings) {
    idx.docPostings = new Map();
    for (const [p, t] of idx.docs) for (const tok of new Set(foldedDoc(idx, p, t).match(/[a-z0-9_]{2,}/g) ?? [])) { let l = idx.docPostings.get(tok); if (!l) { l = []; idx.docPostings.set(tok, l); } l.push(p); }
  }
  const toks = term.match(/[a-z0-9_]{2,}/g) ?? []; if (!toks.length) return [];
  let cand: string[] | undefined;
  // interseção começando pela menor lista, com Set (linear)
  for (const t of [...toks].sort((a, b) => (idx.docPostings!.get(a)?.length ?? 0) - (idx.docPostings!.get(b)?.length ?? 0))) { const l = new Set(idx.docPostings.get(t) ?? []); cand = cand ? cand.filter((x) => l.has(x)) : [...l]; if (!cand.length) return []; }
  return (cand ?? []).filter((p) => foldedDoc(idx, p, idx.docs.get(p)!).includes(term));
}
/** Frases (de um documento já normalizado) que mencionam o termo. Limitado para não varrer documentos enormes inteiros. */
function sentencesWith(f: string, termFolded: string, max = 6): string[] {
  const out: string[] = []; let from = 0;
  while (out.length < max) {
    const i = f.indexOf(termFolded, from); if (i < 0) break;
    const start = Math.max(f.lastIndexOf(".", i) + 1, f.lastIndexOf("\n\n", i) + 1, i - 300);
    let end = f.indexOf(".", i + termFolded.length); if (end < 0 || end - i > 300) end = Math.min(f.length, i + 300);
    out.push(f.slice(start, end + 1).replace(/\s+/g, " ").trim()); from = end + 1;
  }
  return out;
}

export async function reconcile(c: ReconcileInput, ctx: ReconcileContext): Promise<Freshness | undefined> {
  const idx = ctx.index; const now = ctx.now ?? new Date().toISOString();
  const claim = `${c.title}\n${c.body}`.replace(/^Contexto:.*$/gm, "");
  const synth = c.origin === "agent" || c.origin === "human";
  const ev: FreshnessEvidence[] = [];
  const add = (e: FreshnessEvidence) => { if (!ev.some((x) => x.ref === e.ref && x.detail === e.detail)) ev.push(e); };

  // sem repositório (ou sem commits / falha ao ler o HEAD): só a semântica da fonte (plano nunca vira fato atual)
  if (!idx?.head) {
    const kind0: SourceKind = c.path ? sourceKindOf(c.path, c.docText ?? c.body) : "other";
    const planLike0 = kind0 === "plan" || (kind0 !== "adr" && kind0 !== "agents" && isPlanLanguage(claim));
    if (planLike0) return finish({ state: "planned", confidence: "medium", intent: "unknown", implementation: "unknown", summary: "Formulado como plano/trabalho futuro; sem repositório para verificar implementação.", srcKind: kind0 === "other" ? "plan" : kind0 });
    // havia repositório mas ele não pôde ser lido: a verificação FALHOU — nunca "sem verificação" (que libera o lote)
    if (idx) return finish({ state: "uncertain", confidence: "low", intent: "unknown", implementation: "unknown", summary: "Não foi possível ler o HEAD do repositório de origem (sem commits ou falha do git): atualidade não verificada.", srcKind: kind0 });
    return undefined;
  }

  // ---------- 0. origem: segue renomeações; distingue "fora do HEAD" de "não versionado" ----------
  let srcPath = c.path;
  if (srcPath && !idx.headPaths.has(srcPath)) {
    let p = srcPath; for (let i = 0; i < 10; i++) { const h = idx.history.get(p); if (!h?.renamedTo) break; p = h.renamedTo; }
    if (p !== srcPath && idx.headPaths.has(p)) { add({ kind: "git", stance: "context", ref: p, detail: `arquivo de origem foi renomeado de ${srcPath} para ${p}` }); srcPath = p; }
  }
  const inHead = !!srcPath && idx.headPaths.has(srcPath);
  const untracked = !inHead && !!c.untracked;
  const docText = (srcPath ? idx.docs.get(srcPath) : undefined) ?? c.docText;
  const kind: SourceKind = srcPath ? sourceKindOf(srcPath, docText ?? c.body) : "other";
  const planLike = kind === "plan" || (kind !== "adr" && kind !== "agents" && isPlanLanguage(claim));
  const hist = srcPath ? idx.history.get(srcPath) : undefined;
  const srcAdded = hist?.added?.date ?? (srcPath ? fileDate(srcPath) : undefined);
  const srcLast = hist?.modified?.date ?? srcAdded;
  const source: Freshness["source"] = { kind, ...(srcPath ? { path: srcPath } : {}), ...(hist?.modified ? { commit: hist.modified.sha, date: hist.modified.date } : srcAdded ? { date: srcAdded } : {}), in_head: inHead };
  if (srcPath && !inHead && !untracked) {
    // síntese de agente/humano cita a fonte como REFERÊNCIA (pode ser outra branch, memória local ou outro repositório): não refuta
    if (synth) add({ kind: "git", stance: "context", ref: srcPath, detail: hist?.deleted ? `a fonte citada foi removida do HEAD em ${dateOf(hist.deleted.date)} (a síntese não depende só dela)` : "a fonte citada não está no HEAD (outra branch, arquivo local ou outro repositório)" });
    else add({ kind: "git", stance: "contradicts", ref: hist?.deleted ? `commit ${hist.deleted.sha}` : srcPath, detail: hist?.deleted ? `arquivo de origem removido do HEAD em ${dateOf(hist.deleted.date)}` : "arquivo de origem não está no HEAD" });
  }
  if (synth) add({ kind: "vault", stance: "context", ref: c.origin === "agent" ? "síntese de agente" : "conhecimento humano", detail: `afirmação de síntese${c.asOf ? ` (válida em ${dateOf(c.asOf)})` : ""}: só é refutada por proposição incompatível, código/config atual, remoção/revert no Git ou documento/ADR posterior` });
  if (untracked) add({ kind: "git", stance: "context", ref: srcPath!, detail: "documento não versionado (só na árvore de trabalho): a afirmação é verificada contra o HEAD, mas a fonte em si não tem histórico" });

  // "posterior" = depois da última revisão da fonte; para SÍNTESE, depois da data em que a nota foi verificada (as_of/criação).
  // as_of só com DATA vale até o fim daquele dia (hora local): um documento do mesmo dia não é "posterior"
  const sinceTs = synth && c.asOf ? (c.asOf.length === 10 ? new Date(`${c.asOf}T23:59:59`).getTime() : ts(c.asOf)) : ts(srcLast);
  const newer = (p: string) => { const h = idx.history.get(p); const d = ts(h?.modified?.date ?? h?.added?.date ?? fileDate(p)); return Number.isFinite(d) && Number.isFinite(sinceTs) && d > sinceTs; };

  // ---------- 1. supersessão EXPLÍCITA e status da ADR ----------
  let explicit = false; let adrProposed = false;
  if (kind === "adr" && srcPath) {
    // ADR não versionada: o status/supersessão vem do texto da árvore de trabalho (não do índice do HEAD)
    const me = idx.adrs.find((a) => a.path === srcPath) ?? (untracked && docText ? parseAdr(srcPath, docText) : undefined);
    // síntese: a própria ADR só "morre" para a nota se o status/supersessão mudou DEPOIS da nota (antes, o autor já sabia)
    const meChanged = !synth || newer(srcPath);
    if (me?.status && ADR_DEAD.test(me.status) && meChanged) { explicit = true; add({ kind: "adr", stance: "contradicts", ref: srcPath, detail: `status da ADR: "${me.status}"` }); }
    if (me?.status && ADR_PROPOSED.test(me.status)) { adrProposed = true; add({ kind: "adr", stance: "context", ref: srcPath, detail: `ADR ainda não aceita (status: "${me.status.slice(0, 40)}"): implementação não prova que a decisão foi tomada` }); }
    if (me?.supersededBy.length && meChanged) { explicit = true; add({ kind: "adr", stance: "contradicts", ref: srcPath, detail: `ADR declara ser substituída pela ADR ${me.supersededBy.join(", ")}` }); }
    // síntese: só ADR que entrou DEPOIS da nota a substitui (uma substituição anterior já era conhecida por quem escreveu a nota)
    if (me?.num !== undefined) for (const o of idx.adrs) if (o.path !== srcPath && o.supersedes.includes(me.num) && (!synth || newer(o.path)) && !(o.status && ADR_PROPOSED.test(o.status))) { explicit = true; add({ kind: "adr", stance: "contradicts", ref: o.path, detail: `"${o.title.slice(0, 90)}" declara substituir a ADR ${me.num}` }); }
    if (!explicit && !adrProposed && me) add({ kind: "adr", stance: "supports", ref: srcPath, detail: `ADR no HEAD${me.status ? ` (status: ${me.status.slice(0, 40)})` : ""}, nenhuma ADR posterior declara substituí-la` });
  }
  if (docText && (!synth || (srcPath && newer(srcPath)))) { const d = selfDeprecation(docText); if (d) { explicit = true; add({ kind: "doc", stance: "contradicts", ref: srcPath!, detail: `o próprio documento se declara obsoleto: "${redactSecrets(d).slice(0, 100)}"` }); } }
  // (síntese: a "fonte" pode ser diretório/código; o nome dele em outro documento não é supersessão da AFIRMAÇÃO)
  if (srcPath && (!synth || /\.(md|mdx)$/i.test(srcPath))) {
    const base = fold(basename(srcPath).replace(/\.(md|mdx)$/i, ""));
    if (base.length >= 6) for (const p of docsWithTerm(idx, base)) {
      if (p === srcPath || (synth && !newer(p))) continue;
      for (const s of sentencesWith(foldedDoc(idx, p, idx.docs.get(p)!), base, 4)) if (/(supersed|substitu|replac|obsolet|deprecat|depreciad)/.test(s) && !CONDITIONAL.test(s) && changeSide(s, base) === "old") { explicit = true; add({ kind: "doc", stance: "contradicts", ref: p, detail: `"${s.slice(0, 140)}"` }); break; }
    }
  }

  // ---------- 2. evidência de implementação no HEAD ----------
  const anchors = anchorsOf(c.title, c.body, ctx.ignore ?? [idx.name]);
  // o extrator remove crases do corpo: o documento de origem diz se o nome era código (`IngestQueue`) ou prosa ("TypeScript")
  if (docText) for (const a of anchors) if (a.kind === "ident" && !a.explicit && docText.includes("`" + a.text)) a.explicit = true;
  // ADR: só a parte "Decisão" afirma o que foi escolhido; "Por quê/Consequências" citam alternativas e restrições → apoio, nunca contradição
  const decisionPart = /\*\*Decis[aã]o:\*\*/.test(c.body) ? (/\*\*Decis[aã]o:\*\*([\s\S]*?)(?=\*\*(?:Por qu[eê]|Consequ[eê]ncias):\*\*|$)/.exec(c.body)?.[1] ?? "") : undefined;
  const decisionKeys = decisionPart !== undefined ? new Set(anchorsOf(c.title, decisionPart, ctx.ignore ?? [idx.name]).map((a) => a.key)) : undefined;
  const strongPos = anchors.filter((a) => a.weight >= 3 && a.polarity === "pos").slice(0, 8);
  const strongNeg = anchors.filter((a) => a.weight >= 3 && a.polarity === "neg").slice(0, 6);
  const weak = anchors.filter((a) => a.weight < 3 && a.polarity === "pos");
  const truncated = idx.stats.truncated;
  if (truncated) add({ kind: "code", stance: "context", ref: `HEAD ${idx.head.short}`, detail: `índice parcial do repositório (${idx.stats.files} arquivos${idx.stats.skippedLarge ? `, ${idx.stats.skippedLarge} grande(s) ignorado(s)` : ""}): ausência é confirmada com git grep, não presumida` });
  let presentN = 0, legacyOnly = 0, testN = 0, depN = 0, ambiguous = 0, partialN = 0, unverified = 0;
  const codeFiles = new Set<string>(); const nearPaths = new Set<string>();
  const presentAnchors: Anchor[] = [];
  const absent: Anchor[] = []; const rivals: Array<{ a: Anchor; rival: string; where: string }> = [];
  const docOnly: Anchor[] = []; const unseen: Anchor[] = []; const absentSynth: Anchor[] = [];
  const GENERATED = /(^|\/)(dist|build|out|\.next|node_modules|coverage|target|\.venv)\//;
  /** Por que um nome citado por uma SÍNTESE não aparece no código (nenhum destes motivos é refutação). */
  const synthAbsence = (a: Anchor): { kind: "ref" | "generated" | "doc-only" | "nowhere"; ref?: string; detail: string } => {
    if (a.kind === "path") {
      const p = a.key.slice(5);
      if (GENERATED.test(p) || GENERATED.test("/" + p)) return { kind: "generated", detail: `"${a.text}" é artefato gerado (não versionado)` };
      const hit = [...idx.headPaths].find((f) => f.toLowerCase() === p || f.toLowerCase().endsWith("/" + p));
      if (hit) return { kind: "ref", ref: hit, detail: `"${a.text}" existe no HEAD como referência (documentação/arquivo de apoio)` };
      return { kind: "nowhere", detail: `"${a.text}" não está no HEAD (pode ser de outra branch ou repositório): não verificável aqui` };
    }
    // nome de arquivo sem diretório ("CURRENT_HANDOFF.md", "GEOLEDGER_AUTO_PROJECT_CONTEXT.md")
    const file = [...idx.headPaths].find((f) => fold(basename(f)).replace(/\.[a-z0-9]+$/, "") === fold(a.text));
    if (file) return { kind: "ref", ref: file, detail: `"${a.text}" é um arquivo do HEAD (${file})` };
    const docs = docsWithTerm(idx, fold(a.text));
    if (docs.length) return { kind: "doc-only", ref: docs[0], detail: `"${a.text}" aparece na documentação (${docs[0]}), mas não no código/config do HEAD` };
    return { kind: "nowhere", detail: `"${a.text}" não aparece no HEAD (pode estar noutra branch ou ter outro nome)` };
  };
  for (const a of strongPos) {
    const l = lookup(idx, a);
    const okTests = l.tests.filter((t) => !t.weak);
    if (production(l)) {
      presentN++; presentAnchors.push(a); l.code.forEach((h) => codeFiles.add(h.path)); testN += okTests.length; if (l.dep) depN++;
      const nonLegacy = l.code.filter((h) => !h.legacy).length;
      if (l.code.length && !nonLegacy && !l.config.length && !l.dep) { legacyOnly++; add({ kind: "code", stance: "context", ref: loc(l.code[0]!), detail: `"${a.text}" só aparece em contexto de legado/compatibilidade/fallback` }); continue; }
      const parts = [l.code.length && `${l.code.length} arquivo(s) de código`, okTests.length && `${okTests.length} teste(s)`, l.config.length && `${l.config.length} config`, l.dep && `dependência ${l.dep}`].filter(Boolean);
      const first = l.code.find((h) => !h.legacy) ?? l.config[0];
      add({ kind: l.code.length ? "code" : "config", stance: "supports", ref: first ? loc(first) : l.dep ?? a.text, detail: `"${a.text}" presente no HEAD: ${parts.join(", ")}${a.kind === "tech" && !pureChoice(decisionPart ?? c.body, a.text) ? " (tecnologia disponível; não prova o resto da afirmação)" : ""}` });
      const weakT = l.tests.filter((t) => t.weak);
      if (weakT.length) add({ kind: "test", stance: "context", ref: loc(weakT[0]!), detail: `${weakT.length} teste(s) com "${a.text}" estão pulados ou cobrem legado/compatibilidade (não contam)` });
      continue;
    }
    // tecnologia citada só em teste costuma ser fixture/dado: não conta nem como corroboração
    // caminho que existe mas é arquivo-vocabulário (lista de nomes): o arquivo existe, mas não prova a afirmação — parcial, nunca contradição
    if (a.kind === "path") { const p = a.key.slice(5); const v = [...idx.vocab].find((f) => f.toLowerCase() === p || f.toLowerCase().endsWith("/" + p)); if (v) { partialN++; add({ kind: "code", stance: "context", ref: v, detail: `"${a.text}" existe, mas é um arquivo de vocabulário/listas: não prova a afirmação` }); continue; } }
    if (okTests.length && a.kind !== "tech" && (a.kind !== "ident" || a.explicit)) { partialN++; add({ kind: "test", stance: "context", ref: loc(okTests[0]!), detail: `"${a.text}" só aparece em teste(s): corroboração, não prova implementação` }); continue; }
    // forma ambígua (PascalCase solto na prosa) ou citada só no porquê/contexto de uma ADR: ausência não é evidência de nada
    if ((a.kind === "ident" && !a.explicit) || (decisionKeys && !decisionKeys.has(a.key))) { ambiguous++; continue; }
    // nome próximo (sufixo de janela/versão: `x_ratio_7d` → `x_ratio`): implementado com outro nome? evidência PARCIAL, nunca contradição
    const near = a.kind === "ident" ? nearIdent(idx, a.key.slice(3)) : undefined;
    if (near) { partialN++; nearPaths.add(near.hit.path); add({ kind: "code", stance: "supports", ref: loc(near.hit), detail: `"${a.text}" não aparece, mas há o nome próximo "${near.name}" no código (evidência parcial)` }); continue; }
    // índice incompleto: a ausência só vale se o git grep no HEAD também não encontrar
    if (truncated) {
      const g = await headGrep(idx, variantsOf(a));
      if (g) { partialN++; add({ kind: "code", stance: "context", ref: g, detail: `"${a.text}" aparece fora do índice (${g}): presença não classificada` }); continue; }
      // não deu para verificar: a âncora CONTINUA no denominador (nunca some e deixa o resto "confirmar" sozinho)
      if (g === undefined) { unverified++; add({ kind: "code", stance: "context", ref: `HEAD ${idx.head.short}`, detail: `não foi possível verificar "${a.text}" (índice parcial, orçamento de git grep esgotado)` }); continue; }
    }
    if (synth) {
      // síntese: ausência de um NOME não refuta (pode ser referência a doc, branch, artefato gerado ou outro repositório)
      const why = synthAbsence(a);
      // o nome é afirmado no PRESENTE pela nota? ("tabela X futura", "se X…" não contam)
      const asserted = !CONDITIONAL.test(sentenceOf(claim, a.text));
      if (why.kind === "doc-only" && a.kind === "ident" && a.explicit && asserted) docOnly.push(a);
      else if (why.kind === "nowhere" && ((a.kind === "ident" && a.explicit) || a.kind === "path") && asserted) unseen.push(a);
      ambiguous++; add({ kind: why.kind === "doc-only" ? "doc" : "code", stance: "context", ref: why.ref ?? `HEAD ${idx.head.short}`, detail: why.detail });
      if (a.kind === "ident" && a.explicit) absentSynth.push(a);
      continue;
    }
    absent.push(a);
    if (a.kind === "tech" && a.category) for (const t of TECH.filter((x) => x.category === a.category && `tech:${x.name}` !== a.key)) {
      const rl = lookup(idx, { text: t.name, key: `tech:${t.name}`, kind: "tech", weight: 3, polarity: "pos", category: t.category });
      if (rl.dep || rl.code.length >= 1) { rivals.push({ a, rival: t.name, where: rl.dep ?? loc(rl.code[0]!) }); add({ kind: rl.dep ? "config" : "code", stance: "contradicts", ref: rl.dep ?? loc(rl.code[0]!), detail: `"${a.text}" não aparece no HEAD; a mesma função é exercida por ${t.name}${rl.tests.length ? ` (${rl.tests.length} teste(s))` : ""}` }); break; }
    }
    if (!rivals.some((r) => r.a === a)) add({ kind: "code", stance: "contradicts", ref: `HEAD ${idx.head.short}`, detail: `"${a.text}" não aparece em código, config ou dependências do HEAD` });
  }
  let negViolations = 0, negSatisfied = 0, negUnverified = 0;
  for (const a of strongNeg) {
    const l = lookup(idx, a);
    const live = l.code.filter((h) => !h.legacy).length + l.config.length + (l.dep ? 1 : 0);
    if (live) { negViolations++; add({ kind: l.dep ? "config" : "code", stance: "contradicts", ref: l.dep ?? loc(l.code.find((h) => !h.legacy) ?? l.config[0]!), detail: `a afirmação rejeita "${a.text}", mas ele está em uso no HEAD` }); continue; }
    if (truncated) { const g = await headGrep(idx, variantsOf(a)); if (g !== null) { negUnverified++; add({ kind: "code", stance: "context", ref: g ?? `HEAD ${idx.head.short}`, detail: `não foi possível confirmar a ausência de "${a.text}" (índice parcial)` }); continue; } }
    negSatisfied++; add({ kind: "code", stance: "supports", ref: `HEAD ${idx.head.short}`, detail: `"${a.text}" ausente do HEAD, como a afirmação diz` });
  }
  // palavras de conteúdo: só valem em CO-OCORRÊNCIA (≥ 2 no mesmo arquivo de código de produção)
  let weakFile: { path: string; n: number; words: string[] } | undefined;
  if (weak.length >= 2) {
    const per = new Map<string, Set<string>>();
    for (const a of weak.slice(0, 12)) for (const [p] of idx.ident.get(a.key) ?? []) { if (idx.files.get(p) !== "code" || idx.vocab.has(p)) continue; let s = per.get(p); if (!s) { s = new Set(); per.set(p, s); } s.add(a.text); }
    for (const [p, s] of per) if (s.size >= 2 && (!weakFile || s.size > weakFile.n)) weakFile = { path: p, n: s.size, words: [...s] };
    if (weakFile && weakFile.n >= Math.max(2, Math.ceil(weak.length * 0.4))) add({ kind: "code", stance: "supports", ref: weakFile.path, detail: `termos da afirmação co-ocorrem no código (${weakFile.words.slice(0, 4).join(", ")}) — evidência fraca` });
    else weakFile = undefined;
  }

  // ---------- 3. documentos POSTERIORES (à última alteração da fonte): migração/abandono descritos explicitamente ----------
  let migratedAway = 0, newerRelated = 0, amendedInSelf = 0;
  const claimFold = fold(claim); const claimTokens = new Set(claimFold.match(/[a-z0-9_]{3,}/g) ?? []); const claimCues = new Set(claimFold.match(CHANGE_CUE) ?? []);
  // documento posterior = revisado DEPOIS da última revisão da fonte (a frase de mudança pode ter entrado numa revisão, não na criação)
  for (const a of strongPos.slice(0, 6)) {
    // síntese: só nomes ESPECÍFICOS (identificador de código, caminho, tecnologia numa escolha pura) podem ser refutados por texto;
    // nome do produto/projeto ou palavra comum em outra frase não é a mesma proposição
    if (synth && !((a.kind === "ident" && a.explicit) || a.kind === "path" || (a.kind === "tech" && pureChoice(c.body, a.text)))) continue;
    const terms = a.kind === "ident" ? [...new Set([fold(a.text), a.key.slice(3)])] : [fold(a.text)];
    let found = 0;
    for (const term of terms) for (const p of docsWithTerm(idx, term)) {
      if (found >= 2) break;
      const self = p === srcPath; if ((!self || synth) && !newer(p)) continue;
      for (const s of sentencesWith(foldedDoc(idx, p, idx.docs.get(p)!), term, 8)) {
        if (self && isOwnClaim(s, claimTokens, claimCues)) continue; // a própria afirmação (mesma polaridade) não conta
        // plano/condição ("quando migrarmos de X…", "se X for removido…") não descreve uma mudança que aconteceu
        if (CONDITIONAL.test(s)) continue;
        if (changeSide(s.slice(0, 600), term) === "old") { migratedAway++; found++; if (self) amendedInSelf++; add({ kind: "doc", stance: "contradicts", ref: p, detail: `${self ? "adendo no próprio documento" : `documento posterior (${dateOf(idx.history.get(p)?.added?.date) ?? fileDate(p) ?? "?"})`} descreve mudança: "${around(s, term, 170)}"` }); break; }
      }
    }
  }
  if (srcLast) {
    const key = [...new Set(strongPos.map((a) => fold(a.text)))];
    if (key.length >= 2) {
      const hits = new Map<string, number>();
      for (const k of key) for (const p of docsWithTerm(idx, k)) if (p !== srcPath && newer(p)) hits.set(p, (hits.get(p) ?? 0) + 1);
      for (const [p, n] of hits) if (n >= 2 && n >= key.length * 0.6) { newerRelated++; if (newerRelated <= 2) add({ kind: "doc", stance: "context", ref: p, detail: `documento posterior trata do mesmo assunto (${dateOf(idx.history.get(p)?.added?.date) ?? fileDate(p)})` }); }
    }
  }

  // ---------- 4. Git: commits relacionados depois da fonte; reverts; termos que existiram e saíram ----------
  let reverted: { c: CommitInfo; by: CommitInfo; strong: boolean } | undefined; let removedBy: { short: string; date: string; subject: string; sha: string } | undefined;
  const strongTokens = new Set([...strongPos, ...strongNeg].flatMap((a) => a.kind === "tech" ? (TECH.find((x) => `tech:${x.name}` === a.key)?.aliases ?? []) : a.kind === "ident" ? [`id:${a.key.slice(3)}`] : []));
  const weakTokens = weak.map((a) => a.key.slice(2));
  const relation = (cm: CommitInfo): "strong" | "weak" | undefined => {
    for (const t of strongTokens) if (cm.tokens.has(t)) return "strong";
    const w = weakTokens.filter((t) => cm.tokens.has(t));
    if (w.length >= 2) return "weak";
    // uma palavra só conta quando é o NOME de um arquivo que o commit criou/removeu ("cache" → src/cache.ts)
    return w.some((t) => cm.files.some((f) => (f.status === "A" || f.status === "D") && basename(f.path).replace(/\.[a-z0-9]+$/i, "").toLowerCase() === t)) ? "weak" : undefined;
  };
  const after = Number.isFinite(ts(srcAdded)) ? idx.commits.filter((cm) => ts(cm.date) > ts(srcAdded)) : [];
  let relatedAfter = 0; let implCommit: CommitInfo | undefined; let lastRelated: CommitInfo | undefined;
  const exactIds = strongPos.filter((a) => a.kind === "ident" && a.explicit).map((a) => `id:${a.key.slice(3)}`);
  for (const cm of after) {
    // commit que implementa o nome exato: precisa tocar o arquivo onde está o nome próximo E não ser só documentação
    if (!implCommit && nearPaths.size && /^(feat|fix|refactor|perf)(\(|:|!)/i.test(cm.subject) && exactIds.some((t) => cm.tokens.has(t)) && !idx.revertedBy.has(cm.sha) && cm.files.some((f) => nearPaths.has(f.path)) && cm.files.some((f) => !/\.(md|mdx|txt)$/i.test(f.path))) implCommit = cm;
    const rel = relation(cm); if (!rel) continue; relatedAfter++; lastRelated = lastRelated ?? cm;
    const by = idx.revertedBy.get(cm.sha);
    if (by && !reverted) reverted = { c: cm, by, strong: rel === "strong" };
  }
  if (reverted) add({ kind: "git", stance: "contradicts", ref: `commit ${reverted.by.short}`, detail: `"${reverted.c.subject.slice(0, 80)}" (${reverted.c.short}, ${dateOf(reverted.c.date)}) foi revertido em ${dateOf(reverted.by.date)}` });
  // só CONTEXTO para o revisor: o assunto de um commit não prova implementação nem equivalência entre nomes
  if (implCommit) add({ kind: "git", stance: "context", ref: `commit ${implCommit.short}`, detail: `commit posterior altera o código do nome próximo e cita o nome exato: "${implCommit.subject.slice(0, 90)}" (${dateOf(implCommit.date)})` });
  if (relatedAfter && !reverted) add({ kind: "git", stance: "context", ref: `${relatedAfter} commit(s)`, detail: `${relatedAfter} commit(s) relacionados depois da fonte (o mais recente: "${lastRelated?.subject.slice(0, 70)}")` });
  for (const a of [...absent.filter((x) => x.kind === "ident" || x.kind === "tech"), ...absentSynth].slice(0, 3)) {
    // "existiu e saiu" só vale se o termo não existe em NENHUM arquivo do HEAD — nem vocabulário, nem comentário (git grep):
    // o pickaxe acha qualquer commit que mude a contagem, inclusive a ADIÇÃO de um comentário
    if (anywhereInHead(idx, a)) continue;
    const g = await headGrep(idx, variantsOf(a)); if (g !== null) continue;
    const term = a.kind === "tech" ? (TECH.find((x) => `tech:${x.name}` === a.key)?.aliases[0] ?? a.text) : a.text;
    const hits = await pickaxe(idx, term);
    if (hits?.length) {
      removedBy = hits[0]!; // mais recente: como o termo não está no HEAD, é a mudança que o tirou
      const rv = idx.commits.find((x) => x.sha === removedBy!.sha);
      if (rv?.reverts && !reverted) { const target = idx.commits.find((x) => rv.reverts!.startsWith("subject:") ? x.subject === rv.reverts!.slice(8) : x.sha.startsWith(rv.reverts!)); if (target) reverted = { c: target, by: rv, strong: true }; }
      add({ kind: "git", stance: "contradicts", ref: `commit ${removedBy.short}`, detail: `"${a.text}" existiu no código (${hits.length} commit(s) o alteraram); saiu em "${removedBy.subject.slice(0, 70)}" (${dateOf(removedBy.date)})` });
    }
  }
  if (planLike && checkedTask(c.body)) add({ kind: "plan", stance: "supports", ref: srcPath ?? "plano", detail: "tarefa marcada como concluída no plano (sinal fraco: precisa de código)" });

  // ---------- 4b. PROPOSIÇÕES de estado (produção, ligado/desligado): config/código do HEAD e documentos com afirmação explícita ----------
  let propContra = 0, propSupport = 0;
  for (const cl of stateClaims(claim).slice(0, 4)) {
    if (cl.prop === "enabled") {
      const keyCanon = canonicalIdent(cl.subject); const keys = [...new Set([cl.subject, keyCanon])];
      for (const [path] of idx.ident.get(`id:${keyCanon}`) ?? []) {
        const k = idx.files.get(path); if ((k !== "config" && k !== "code") || idx.vocab.has(path)) continue;
        const a = assignedInFile(idx.lines.get(path) ?? [], keys); if (!a) continue; // ausente ou ambíguo (valores conflitantes)
        if (a.value === cl.value) { propSupport++; add({ kind: "config", stance: "supports", ref: `${path}:${a.line}`, detail: `"${cl.subject}" = ${a.value ? "ligado" : "desligado"} no HEAD, como a nota afirma` }); }
        else { propContra++; add({ kind: "config", stance: "contradicts", ref: `${path}:${a.line}`, detail: `a nota diz que "${cl.subject}" está ${cl.value ? "ligado" : "desligado"}, mas o HEAD define ${a.value ? "ligado (true)" : "desligado (false)"}` }); }
      }
      // documentos POSTERIORES que afirmam o estado oposto (ADR/release/changelog); anteriores não refutam uma síntese
      for (const p of docsWithTerm(idx, fold(cl.subject)).slice(0, 8)) {
        if (!newer(p)) continue;
        // frases do texto ORIGINAL (a forma normalizada perde o camelCase do sujeito)
        const raw = redactSecrets(idx.docs.get(p)!); const low = raw.toLowerCase(); const sub = cl.subject.toLowerCase();
        const raws: string[] = []; for (let i = low.indexOf(sub); i >= 0 && raws.length < 4; i = low.indexOf(sub, i + sub.length)) { const a = Math.max(raw.lastIndexOf(".", i), raw.lastIndexOf("\n", i)) + 1; const e = [raw.indexOf(".", i), raw.indexOf("\n", i)].filter((x) => x >= 0); raws.push(raw.slice(a, e.length ? Math.min(...e) : raw.length)); }
        for (const s0 of raws) {
          const v = toggleStatement(s0, keyCanon, canonicalIdent); if (v === undefined || v === cl.value) continue;
          propContra++; add({ kind: "doc", stance: "contradicts", ref: p, detail: `documento posterior diz que "${cl.subject}" está ${v ? "ligado" : "desligado"}: "${s0.trim().slice(0, 150)}"` }); break;
        }
      }
    } else {
      // config: chaves de produção/lançamento (PRODUCTION_ENABLED=true, launched: true) — pré-indexadas uma vez por HEAD
      for (const a of productionAssignments(idx)) {
        if (a.value !== cl.value) { propContra++; add({ kind: "config", stance: "contradicts", ref: `${a.path}:${a.line}`, detail: `a nota diz que ${cl.value ? "está" : "NÃO está"} em produção; o HEAD tem "${a.key}" = ${a.value}` }); }
        else { propSupport++; add({ kind: "config", stance: "supports", ref: `${a.path}:${a.line}`, detail: `"${a.key}" = ${a.value} no HEAD, compatível com a nota` }); }
      }
      // documentos: só frases AFIRMATIVAS (não condicionais) sobre produção; posteriores à nota contradizem, anteriores são fonte velha
      const seenDoc = new Set<string>();
      for (const term of ["producao", "production", "lancamento", "launch", "go-live", "went live"]) for (const p of docsWithTerm(idx, term)) {
        if (seenDoc.has(p) || seenDoc.size >= 6) continue;
        for (const s0 of sentencesWith(foldedDoc(idx, p, idx.docs.get(p)!), term, 6)) {
          const v = productionStatement(s0); if (v === undefined || v === cl.value) continue;
          seenDoc.add(p);
          if (newer(p)) { propContra++; add({ kind: "doc", stance: "contradicts", ref: p, detail: `documento posterior${c.asOf ? ` a ${dateOf(c.asOf)}` : ""} afirma ${v ? "produção" : "pré-produção"}: "${around(s0, term, 160)}"` }); }
          else add({ kind: "doc", stance: "context", ref: p, detail: `documento ANTERIOR afirma ${v ? "produção" : "pré-produção"} (fonte possivelmente desatualizada — corrija a fonte): "${around(s0, term, 140)}"` });
          break;
        }
      }
    }
  }

  // ---------- 5. decisão ----------
  const strongN = strongPos.length - ambiguous; // âncoras fortes avaliadas (as não verificadas CONTAM)
  // confirmação exige uma âncora ESPECÍFICA presente: identificador/caminho de produção, ou tecnologia numa frase de ESCOLHA PURA
  // ("Usaremos SQLite como banco"). "We use Redis to encrypt every session" + Redis no package.json NÃO confirma o predicado.
  // ADR: a escolha pura é avaliada na parte "Decisão" (o porquê não é predicado sobre a implementação)
  const choiceText = decisionPart ?? c.body;
  const specific = presentAnchors.some((a) => a.kind === "ident" || a.kind === "path" || (a.kind === "tech" && pureChoice(choiceText, a.text)));
  let implementation: Freshness["implementation"];
  if (negViolations || (absent.length && rivals.length && presentN === 0)) implementation = "diverges";
  else if (strongN && (partialN || unverified) && presentN + partialN + unverified === strongN) implementation = "partial";
  else if (strongN && presentN === strongN && legacyOnly < presentN) implementation = specific && !negUnverified && (testN || codeFiles.size >= 2 || depN) ? "confirmed" : "partial";
  else if (strongN && presentN === 0 && !partialN && !unverified) implementation = legacyOnly ? "partial" : "absent";
  else if (!strongN && strongNeg.length) implementation = negSatisfied === strongNeg.length ? "confirmed" : "unknown"; // só afirmações negativas
  else if (strongN) implementation = "partial";
  else implementation = weakFile ? "partial" : "unknown";

  const isAdr = kind === "adr"; const isDesc = (DESCRIPTION_KINDS as SourceKind[]).includes(kind);
  const contradicting = ev.filter((e) => e.stance === "contradicts").length;
  const inForce: Freshness["intent"] = isAdr ? (adrProposed ? "unknown" : "in_force") : isDesc ? "n/a" : "unknown";
  const mk = (state: Freshness["state"], confidence: Confidence, intent: Freshness["intent"], summary: string, suggestion?: Freshness["suggestion"]) => finish({ state, confidence, intent, implementation, summary, srcKind: kind, source, ev, suggestion });

  if (synth) {
    // SÍNTESE: nunca vira "histórico" por si só — evidência nova e incompatível pede REVALIDAÇÃO humana (proposta), não rebaixa em silêncio
    if (explicit) return mk("superseded", "high", "superseded", "A fonte que a nota cita foi substituída explicitamente (ADR/documento): revalidar a nota.", "revalidate");
    if (propContra) return mk("conflict", propSupport ? "low" : "medium", "unknown", `Evidência nova incompatível com a proposição da nota (${propContra} sinal(is)): revalidar — não foi possível confirmar automaticamente.`, "revalidate");
    if (negViolations) return mk("conflict", "medium", "unknown", "A nota rejeita algo que está em uso no HEAD: revalidar.", "revalidate");
    if (reverted && implementation !== "confirmed") return mk("conflict", "medium", "unknown", `Mudança relacionada foi revertida (${reverted.by.short}) e o HEAD não confirma a nota: revalidar.`, "revalidate");
    if (removedBy && implementation !== "confirmed") return mk("conflict", "medium", "unknown", `"${removedBy.subject.slice(0, 60)}" removeu do código um nome que a nota cita: revalidar.`, "revalidate");
    if (migratedAway) return mk(implementation === "confirmed" ? "conflict" : "superseded", "medium", "unknown", implementation === "confirmed" ? "Documento posterior à nota descreve mudança, mas o código atual ainda sustenta a nota: revalidar." : "Documento posterior à nota descreve a mudança e o HEAD não sustenta mais a nota: revalidar.", "revalidate");
    // nome citado como código que só existe na documentação: a nota herdou o nome do doc (confirme o nome real no código)
    if (docOnly.length) return mk("uncertain", "low", "unknown", `Nome(s) citados como código aparecem só na documentação, não no código do HEAD (${docOnly.slice(0, 2).map((a) => a.text).join(", ")}): confirme o nome real.`, "confirm");
    // arquivo citado que não existe no HEAD (nem como artefato gerado): provavelmente outra branch ou outro repositório
    // nome explícito citado e ausente do HEAD: a afirmação INTEIRA não está confirmada, mesmo que outras partes estejam
    if (unseen.length) return mk("uncertain", "low", "unknown", `Citado(s) mas ausente(s) do HEAD (${unseen.slice(0, 2).map((a) => a.text).join(", ")}): pode estar noutra branch ou repositório; confirme.`, "confirm");
    if (implementation === "confirmed" || propSupport) return mk("current", testN || propSupport ? "high" : "medium", "in_force", "Síntese sustentada pelo HEAD (código/config/testes) e nenhuma evidência posterior a contradiz.");
    if (truncated && (unverified || ambiguous)) return mk("uncertain", "low", "unknown", "Índice parcial do repositório: parte dos nomes não pôde ser verificada; confirme.", "confirm");
    return mk("current", "low", "in_force", presentN ? "Síntese com evidência parcial no HEAD e nada a contradiz." : "Síntese não verificável no código; nada no HEAD ou em documentos posteriores a contradiz.");
  }

  if (explicit) return mk("superseded", "high", "superseded", `Substituída explicitamente${implementation === "confirmed" ? " (o código ainda contém partes dela: verifique se é resto ou transição)" : ""}.`);
  // revert só derruba a afirmação quando o HEAD NÃO a contém (um revert de melhoria relacionada não reverte o que continua implementado)
  if (reverted && (implementation === "absent" || (implementation === "unknown" && !unverified && !negUnverified))) return mk("reverted", reverted.strong || implementation === "absent" ? "high" : "medium", isDesc ? "n/a" : "reverted", `Implementada e depois revertida (${reverted.by.short}); o HEAD não a contém.`);
  if (migratedAway) {
    // adendo do PRÓPRIO documento é emenda explícita do autor: a afirmação original está substituída mesmo que o nome continue no código
    if (amendedInSelf) return mk("superseded", "medium", isDesc ? "n/a" : "superseded", `O próprio documento registra uma emenda posterior sobre isto${implementation === "confirmed" ? "; o nome citado ainda existe no código (verifique o que mudou: regra, meta ou limiar)" : ""}.`);
    if (implementation === "confirmed" && !rivals.length) return mk("conflict", "medium", isDesc ? "n/a" : "unknown", "Documento posterior descreve que isto mudou, mas o código atual ainda o usa: verificar se a migração terminou.");
    return mk("superseded", implementation === "absent" || implementation === "diverges" || legacyOnly ? "high" : "medium", isDesc ? "n/a" : "superseded", "Documento posterior descreve a mudança; o HEAD é compatível com o estado novo.");
  }
  if (srcPath && !inHead && !untracked && implementation !== "confirmed") return mk("historical", removedBy ? "high" : "medium", isDesc ? "n/a" : "unknown", "A fonte saiu do HEAD e o código não confirma a afirmação: registro histórico.");

  switch (implementation) {
    case "confirmed": {
      // alta só com testes E (duas âncoras fortes distintas OU afirmação curta e focada numa âncora); ADR não aceita nunca é alta
      const contentWords = weak.length + strongN + strongNeg.length;
      const strongConf: Confidence = !adrProposed && testN && (codeFiles.size || depN) && (presentN >= 2 || contentWords <= 10) ? "high" : "medium";
      if (adrProposed) return mk("current", "medium", "unknown", "O HEAD implementa o que a ADR descreve, mas ela ainda não foi aceita: estado atual confirmado, decisão não.");
      if (planLike) return mk("current", strongConf, "in_force", "Era plano/especificação e o HEAD mostra a implementação no código.");
      return mk("current", strongConf, inForce === "unknown" ? "in_force" : inForce, kind === "spec" ? "Especificação implementada: o HEAD sustenta a afirmação." : "O HEAD sustenta a afirmação (código/config/dependências).");
    }
    case "diverges":
      if (isDesc) return mk("conflict", testN || depN ? "high" : "medium", "n/a", "Documentação diz uma coisa; o código atual mostra outra: documentação provavelmente desatualizada.");
      // o HEAD usar outra coisa não cancela trabalho futuro nem prova que a decisão foi abandonada
      if (planLike) return mk("planned", "low", "unknown", "Planejado, não implementado; o HEAD usa outra solução hoje (o plano pode estar abandonado ou pendente).");
      return mk("uncertain", "medium", "unknown", "A implementação atual diverge da intenção registrada e nada no repositório explica a mudança: decisão de produto.");
    case "absent":
      if (removedBy) return mk("historical", "medium", isDesc ? "n/a" : "unknown", "Existiu no código e foi removido: registro histórico.");
      if (planLike || kind === "spec") return mk("planned", strongN >= 2 ? "medium" : "low", "unknown", "Planejado/especificado, mas nada disso aparece no código do HEAD.");
      if (isAdr) return mk("planned", "low", inForce, adrProposed ? "ADR ainda proposta e não implementada." : "ADR vigente, mas nada do que ela cita aparece no HEAD (não implementada ou adiada).");
      return mk("uncertain", "low", "n/a", "A documentação cita coisas que não aparecem no HEAD: desatualizada ou nomeada de outra forma.");
    case "partial":
      if (planLike) return mk(checkedTask(c.body) || relatedAfter ? "uncertain" : "planned", "low", "unknown", "Plano com evidência parcial de implementação: não é fato atual até confirmar.");
      if (contradicting) return mk("uncertain", "low", inForce, "Evidência mista: parte confirmada no HEAD, parte ausente.");
      if (unverified || negUnverified) return mk("uncertain", "low", inForce, "Parte da afirmação não pôde ser verificada (índice parcial do repositório): não confirmada.");
      if ((isAdr && !adrProposed) || kind === "agents") return mk("current", "low", inForce, "Fonte vigente no HEAD com evidência parcial no código.");
      return mk("uncertain", "low", inForce, "Evidência parcial: termos relacionados no código, sem confirmação direta.");
    default: // unknown: nada verificável no código (princípios, processo, produto)
      if (planLike) return mk("planned", "medium", "unknown", "Formulado como plano; nada verificável no HEAD.");
      if (isAdr && !adrProposed && !newerRelated) return mk("current", "low", "in_force", "ADR vigente e não substituída; a afirmação não é verificável no código.");
      if (kind === "agents" && (inHead || untracked)) return mk("current", "medium", "n/a", "Regra operacional (AGENTS/CLAUDE.md); não verificável no código.");
      if (kind === "readme" && inHead && !newerRelated) return mk("current", "low", "n/a", "README no HEAD; a afirmação não é verificável no código.");
      return mk("uncertain", "low", inForce, newerRelated ? "Não verificável no código e há documentos posteriores sobre o mesmo assunto." : "Não verificável no código; nada indica mudança, mas especificação não é prova de estado atual.");
  }

  function finish(o: { state: Freshness["state"]; confidence: Confidence; intent: Freshness["intent"]; implementation: Freshness["implementation"]; summary: string; srcKind: SourceKind; source?: Freshness["source"]; ev?: FreshnessEvidence[]; suggestion?: Freshness["suggestion"] }): Freshness {
    // trechos vêm de arquivos do repositório importado: segredos já mascarados na origem; aqui, defesa em profundidade
    const evidence = (o.ev ?? ev).slice().sort((a, b) => rank(a) - rank(b)).slice(0, 12).map((e) => ({ ...e, ref: redactSecrets(e.ref).slice(0, 200), detail: redactSecrets(e.detail).slice(0, 300) }));
    const contra = evidence.filter((e) => e.stance === "contradicts").length; const sup = evidence.filter((e) => e.stance === "supports").length;
    const suggestion: Freshness["suggestion"] = o.suggestion ??
      (o.state === "current" ? (o.confidence === "low" && !sup ? "confirm" : "accept_current")
        : o.state === "superseded" || o.state === "reverted" || o.state === "historical" ? "accept_historical"
          // plano sem implementação não é conhecimento atual; ADR VIGENTE ainda não implementada (adiada) é intenção válida: confirmar
          : o.state === "planned" ? (o.intent === "in_force" ? "confirm" : "ignore")
            : o.state === "conflict" && o.intent === "n/a" && o.confidence !== "low" ? "ignore"
              // não verificável e nada contradiz: o humano só confirma se ainda vale (não há o que investigar no repositório)
              : o.state === "uncertain" && !contra && (o.implementation === "unknown" || o.implementation === "partial") ? "confirm"
                : "investigate");
    let effort: Freshness["effort"];
    if (suggestion === "investigate") effort = "investigate";
    // revalidação já chega com a evidência nova e a sugestão pronta: o humano confirma/altera/ignora
    else if (suggestion === "revalidate") effort = "quick";
    else if (o.confidence === "high" && (sup || contra)) effort = "auto_clear";
    else effort = "quick";
    return {
      state: o.state, confidence: o.confidence, intent: o.intent, implementation: o.implementation,
      source: o.source ?? { kind: o.srcKind, ...(c.path ? { path: c.path } : {}), in_head: false },
      ...(idx?.head ? { against: { repo: idx.name, commit: idx.head.short, date: idx.head.date } } : {}),
      evidence, summary: o.summary, suggestion, effort, checked_at: now, ...(c.origin ? { origin: c.origin } : {}),
    };
  }
}
/**
 * A frase do documento É a própria afirmação (mesmo reformatada: crases/negrito removidos pelo extrator)? Só se tiver a MESMA
 * polaridade: "We use Redis" × "We no longer use Redis" compartilham quase todos os tokens, mas a segunda é uma reversão.
 */
function isOwnClaim(sentence: string, claimTokens: Set<string>, claimCues: Set<string>): boolean {
  const t = sentence.match(/[a-z0-9_]{3,}/g) ?? []; if (!t.length) return false;
  if ((sentence.match(CHANGE_CUE) ?? []).some((x) => !claimCues.has(x))) return false;
  let n = 0; for (const x of t) if (claimTokens.has(x)) n++;
  return n / t.length >= 0.7;
}
/** Trecho centrado no termo (a frase inteira pode ser longa e o termo ficar fora do recorte). */
function around(s: string, term: string, max: number): string {
  if (s.length <= max) return s;
  const i = Math.max(0, s.indexOf(term)); const start = Math.max(0, Math.min(i - Math.floor(max / 3), s.length - max));
  return `${start ? "…" : ""}${s.slice(start, start + max).trim()}${start + max < s.length ? "…" : ""}`;
}
/** Atribuições de chaves de produção/lançamento no config/código do HEAD (uma vez por índice; comentários e valores ambíguos fora). */
function productionAssignments(idx: RepoIndex): Array<{ path: string; line: number; key: string; value: boolean }> {
  const cache = idx as RepoIndex & { _prodAssign?: Array<{ path: string; line: number; key: string; value: boolean }> };
  if (cache._prodAssign) return cache._prodAssign;
  const out: Array<{ path: string; line: number; key: string; value: boolean }> = [];
  for (const [key, files] of idx.ident) {
    if (!key.startsWith("id:") || !PRODUCTION_KEY.test(key.slice(3))) continue;
    for (const [path] of files) {
      const k = idx.files.get(path); if ((k !== "config" && k !== "code") || idx.vocab.has(path)) continue;
      const a = assignedInFile(idx.lines.get(path) ?? [], [key.slice(3)]); if (a) out.push({ path, line: a.line, key: key.slice(3), value: a.value });
    }
  }
  return (cache._prodAssign = out);
}
/** A frase (normalizada) da afirmação que contém o termo. */
function sentenceOf(claim: string, term: string): string {
  const f = fold(claim).replace(/[`*]/g, ""); const t = fold(term); const i = f.indexOf(t); if (i < 0) return "";
  const start = Math.max(f.lastIndexOf(".", i), f.lastIndexOf("\n", i), f.lastIndexOf(";", i)) + 1;
  const ends = [f.indexOf(".", i + t.length), f.indexOf("\n", i + t.length), f.indexOf(";", i + t.length)].filter((x) => x >= 0);
  return f.slice(start, ends.length ? Math.min(...ends) : f.length);
}
const rank = (e: FreshnessEvidence) => (e.stance === "contradicts" ? 0 : e.stance === "supports" ? 1 : 2);

/** A consulta pede história/evolução? (brain_context inclui notas substituídas) */
export const wantsHistory = (q: string): boolean => HIST_QUERY.test(fold(q));
