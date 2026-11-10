import type { Confidence } from "@brain/shared";
import { fold, tokenize } from "../text.js";

/**
 * Critérios de qualidade do Import Assistant (heurísticos, determinísticos, explicáveis).
 * Princípio: PRECISÃO > RECALL. Um candidato só vira proposta se for durável, autocontido, atômico e sustentado pela fonte.
 *
 * Todos os padrões abaixo são aplicados sobre texto NORMALIZADO (`fold`: sem acentos, minúsculo) e escritos em ASCII:
 * `\\b` do JavaScript não reconhece letras acentuadas, então "será" × "sera" daria resultados diferentes.
 */

/** Palavras estruturais comuns em títulos: SINAL FRACO. Nunca decide sozinho; só ajuda a reconhecer que o título descreve organização, não conteúdo. */
const GENERIC = new Set(("decisao decisoes decision decisions arquitetura architecture fase fases phase phases implementacao implementation validacao validation testes tests escopo scope objetivos goals " +
  "overview visao geral contexto context background conclusao consideracoes limitacoes limitations referencias references abordagem approach selected escolha " +
  "documento secao principal notas notes resumo summary detalhes details design proximos passos next steps pontos aberto abertas neste").split(/\s+/));

export const stripNumbering = (h: string): string => h.replace(/^\s*(?:\d+(?:\.\d+)*[.)]?|[ivx]+\.|[a-z]\))\s+/i, "").replace(/[\s—–:-]+$/, "").trim();

/** Título que descreve organização do documento, não o conteúdo: poucos termos de conteúdo OU só palavras estruturais. */
export function isGenericHeading(h: string): boolean {
  const t = tokenize(stripNumbering(h), { stem: false }).filter((x) => !/^\d+$/.test(x)); // numerais não são conteúdo
  if (t.length <= 1) return true;
  return t.every((x) => GENERIC.has(fold(x))) || (t.length <= 2 && t.some((x) => GENERIC.has(fold(x))));
}

/** Sinais normativos/decisórios fortes (pt/en), em ASCII para uso sobre texto normalizado. */
export const STRONG_CUE_FOLDED = /\b(\w{3,}remos|deve(m)?( ser)?|nao deve(m)?|sera|serao|fica(m)? definid[oa]s?|decidimos|decidiu-se|adotamos|nao faremos|a estrategia e|foi escolhid[oa]|em vez de|ao inves de|nunca|sempre|obrigatori[oa]s?|proibid[oa]s?|nao pode(m)?|must( not)?|should( not)?|shall|never|always|will|we (chose|decided|use|adopt)|instead of|rather than|prefer(s|red)?|usa(m|mos)?|apenas|somente|nenhum[a]?|exatamente|rejeitad[oa]s?|only|none|exactly|rejected|passa(m)? por|persiste|nao e |e determin\w+|nega por padrao)\b/;
export const hasStrongCue = (s: string): boolean => STRONG_CUE_FOLDED.test(fold(s));
/** compat: uso com texto bruto (aplica fold). */
export const STRONG_CUE = { test: hasStrongCue };

const DEICTIC_OPENER = /^\s*(as duas|os dois|as dois|the two|est[aeo]s?|ess[aeo]s?|isso|isto|nest[aeo]s?|aquel[aeo]s?|ela|ele|elas|eles|these|this|those|they|it|such|the above|o acima|os acima)\b/;
/** "Both X and Y require…" é explícito; só "Both are/Ambos devem…" (pronome) depende de contexto. */
const DEICTIC_BOTH = /^\s*(both|ambos|ambas)\s+(are|were|must|should|will|can|do|have|devem|sao|serao|podem|tem)\b/;
const META_DOC = /\b(este documento|esta spec|esta especificacao|nesta spec|neste documento|nesta secao|neste plano|this document|this spec|this section|this plan)\b/;
/** Referência a outras seções do MESMO documento; citação externa ("RFC 9110 section 9.2") não conta. */
const DOC_INTERNAL_REF = /(?:\b(secao|section|capitulo|chapter|item|apendice|appendix)\s+\d+(?:\.\d+)*\b|§\s*\d)/;
const EXTERNAL_CITE = /\b(rfc|iso|iec|pep|nist|owasp|w3c|ieee|gdpr|lgpd|pci|sox|hipaa)[\s-]*[\w.-]*\s*,?\s*(?:secao|section|§)\s*\d+(?:\.\d+)*/g;
/** Conteúdo transitório (agenda, status, logística): não é conhecimento durável. */
const TRANSIENT = /\b(amanha|hoje|ontem|esta semana|semana que vem|proxima semana|reuniao|agenda|standup|stand-up|tomorrow|yesterday|today|next week|this week|meeting|sprint planning|daily)\b/;
const RATIONALE = /\b(porque|pois|ja que|para que|por isso|because|since|so that|therefore|so we)\b/;
const QUESTION = /\?\s*$/;

export function documentInternalRef(text: string): boolean { return DOC_INTERNAL_REF.test(fold(text).replace(EXTERNAL_CITE, " ")); }
export const isMetaDocument = (s: string): boolean => META_DOC.test(fold(s));
export const isTransient = (s: string): boolean => TRANSIENT.test(fold(s));
export const hasRationale = (s: string): boolean => RATIONALE.test(fold(s));
export const isDeictic = (s: string): boolean => { const f = fold(s); return DEICTIC_OPENER.test(f) && !DEICTIC_BOTH.test(f) || DEICTIC_BOTH.test(f); };

export const sentencesOf = (text: string): string[] => text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9"'([])/).map((s) => s.trim()).filter(Boolean);

/** Frase afirmativa autocontida o bastante para carregar conhecimento: tamanho mínimo, termos de conteúdo, não é pergunta nem rótulo. */
export function isAssertion(s: string, allowQuestion = false): boolean {
  const x = s.replace(/^[ \t]*(?:[-*]|\d+\.)[ \t]+(?:\[[ xX]\][ \t]*)?/, "").trim();
  if (x.length < 35 || (!allowQuestion && QUESTION.test(x)) || /[:：]$/.test(x)) return false;
  return tokenize(x, { stem: false }).length >= 5;
}

export interface Assessment {
  verdict: "accept" | "reject";
  reason?: string;            // motivo da rejeição (para relatório)
  confidence: Confidence;
  why: string[];              // por que virou proposta (mostrado na revisão)
  flags: string[];            // heading-based | enriched | title-synthesized ...
  needsContext: boolean;      // abertura deítica que precisa de contexto adicional
}

export interface UnitInput {
  title: string; body: string; heading: string; viaHeading: boolean; /* tipo veio de sinal de cabeçalho */
  synthesizedTitle: boolean; enriched: boolean; group?: boolean; question?: boolean; /* tipo open-question: perguntas são evidência */
  strongSource?: "adr-decision" | "agents-rules";
}

/** Durabilidade + autocontenção + evidência → veredito e confiança. */
export function assess(u: UnitInput): Assessment {
  const flags: string[] = []; const why: string[] = [];
  const clean = u.body.replace(/^Contexto:.*$/gm, "").replace(/\*\*[^*]+:\*\*/g, " ");
  const text = clean.replace(/\s+/g, " ").trim();
  const sents = sentencesOf(clean.replace(/^[ \t]*[-*][ \t]+/gm, ""));
  const assertions = sents.filter((x) => isAssertion(x, !!u.question));
  const strong = assertions.filter(hasStrongCue);
  const first = sents[0] ?? "";

  const minLen = strong.length ? 35 : 60; // uma frase decisória explícita ("Usaremos X em vez de Y") pode ser curta
  if (text.length < minLen) return rej("conteúdo curto demais para ser conhecimento");
  if (!assertions.length) return rej("só cabeçalho: o texto não traz afirmação sustentando o título");
  if (isMetaDocument(first) && !strong.length) return rej("texto descreve o documento (meta), não o assunto");
  if (isTransient(text)) return rej("conteúdo transitório (agenda/status/logística), não conhecimento durável");
  if (documentInternalRef(text)) return rej("depende de outras seções do documento original (referência interna)");
  const dangling = isDeictic(first.replace(/^[ \t]*[-*][ \t]+/, ""));
  if (dangling && u.synthesizedTitle) return rej("depende de contexto anterior que o título não fornece (referência deítica)");
  if (dangling && isGenericHeading(u.heading)) return rej("depende de contexto anterior e o título é apenas organizacional");

  if (u.viaHeading) flags.push("heading-based");
  if (u.synthesizedTitle) flags.push("title-synthesized");
  if (u.enriched || dangling) flags.push("enriched");
  const needsContext = dangling;

  let confidence: Confidence;
  if (u.strongSource === "adr-decision" || u.strongSource === "agents-rules") {
    // estrutura explícita (ADR/regras) ainda precisa de ao menos UMA afirmação normativa para ser "alta"
    confidence = !dangling && strong.length ? "high" : "medium";
    why.push(u.strongSource === "adr-decision" ? "ADR com seção de decisão explícita" : "seção de regras de agente (lista normativa)");
    if (!strong.length) why.push("sem marcador normativo explícito: confiança limitada a média");
  } else if (strong.length && !dangling && !u.synthesizedTitle && text.length >= 60 && text.length <= 900) { confidence = "high"; why.push(`${strong.length} afirmação(ões) normativa(s) explícita(s) e contexto claro`); }
  else { confidence = "medium"; why.push(`${assertions.length} afirmação(ões) sustentando o título${strong.length ? "" : " (sem marcador normativo explícito)"}`); }
  if (u.group && confidence === "high") { confidence = "medium"; why.push("lista coesa de itens: confiança limitada a média"); }
  if (u.enriched && confidence === "high") { confidence = "medium"; why.push("texto reformulado com o contexto do título: confiança limitada a média"); }
  if (needsContext) { confidence = "medium"; why.push("abertura dependia do título; contexto do cabeçalho foi anexado"); }
  if (u.synthesizedTitle) why.push("título derivado do conteúdo (o cabeçalho original era organizacional)");
  if (u.viaHeading && !u.synthesizedTitle) why.push("tipo sugerido pelo cabeçalho; conteúdo confirmou");
  return { verdict: "accept", confidence, why, flags, needsContext };

  function rej(reason: string): Assessment { return { verdict: "reject", reason, confidence: "low", why: [], flags, needsContext: false }; }
}

/**
 * Cláusula inicial utilizável como título: sem marcadores; corta só em pontuação forte (; : —), nunca em locuções que
 * carregam ressalvas ("…, mas somente após…"); ≤ 90 caracteres, sem terminar em artigo/preposição. O corpo guarda a frase inteira.
 */
export function leadClause(sentence: string): string {
  let s = sentence.replace(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s*)?/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim();
  for (const m of s.matchAll(/;|:|\s[—–]\s/g)) { if ((m.index ?? 0) >= 28 && (m.index ?? 0) <= 90) { s = s.slice(0, m.index); break; } }
  s = s.replace(/[.,;:]+$/, "");
  if (s.length > 90) { const cut = s.slice(0, 90); const comma = cut.lastIndexOf(", "); s = comma >= 45 ? cut.slice(0, comma) : cut.replace(/\s+\S*$/, ""); }
  s = s.replace(/(?:\s+(?:de|da|do|das|dos|a|o|as|os|e|ou|para|por|com|em|no|na|que|the|of|and|or|to|for|with|in|on|an|but|mas|nao|not))+$/i, "").replace(/[,;:]+$/, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Detalhe de implementação: texto denso em identificadores de código (snake_case, CamelCase, CONSTANTES, `x.y`, setas).
 * Derivável do código/spec. Identificadores são contados UMA vez (formatação em backticks não duplica). Com justificativa
 * explícita ("porque…") a densidade é evidência fraca: o limiar sobe.
 */
export function implementationDensity(text: string): number {
  const t = text.replace(/`/g, "").replace(/\s+/g, " ");
  const pats = [/\b[a-z]+(?:_[a-z0-9]+)+\b/g, /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g, /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/g, /\b\w+\.\w+\(?\)?/g, /->|=>/g];
  const seen = new Set<string>();
  for (const re of pats) for (const m of t.matchAll(re)) seen.add(m[0].toLowerCase());
  return seen.size;
}
export const isImplementationDetail = (text: string): boolean => implementationDensity(text) >= (hasRationale(text) ? 3 : 2);

/**
 * Resolve uma abertura deítica ("Estas decisões…", "This section…") substituindo o sintagma demonstrativo pelo CABEÇALHO que o define —
 * apenas quando o substantivo da abertura aparece no cabeçalho. É reformulação, não invenção: nenhum fato novo entra.
 * Retorna undefined se não for resolvível (aí o candidato é descartado).
 */
export function resolveDeictic(body: string, heading: string): string | undefined {
  const m = /^(\s*)(?:est[aeo]s?|ess[aeo]s?|nest[aeo]s?|these|those|this)\s+(\p{L}+)/iu.exec(body);
  if (!m) return undefined;
  const noun = fold(m[2]!); const stem = noun.length > 4 ? noun.slice(0, -1) : noun;
  if (!fold(heading).includes(stem)) return undefined;
  const head = stripNumbering(heading).split(/[,:;—–(]/)[0]!.trim();
  if (!head) return undefined;
  return `${m[1]}${head}${body.slice(m[0].length)}`;
}
