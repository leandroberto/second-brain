

/**
 * Contradição no nível da PROPOSIÇÃO (não de palavras parecidas). Cobre os estados que mais aparecem em conhecimento temporal:
 *   produção/lançamento do projeto  ("ainda não está em produção" × "production launch completed")
 *   chave ligada/desligada          ("FEATURE_X está desligada" × `FEATURE_X=true` no config do HEAD)
 * Uma frase só conta como evidência se for AFIRMATIVA no presente/passado: "quando entrar em produção…", "se X for ligado…",
 * "unless…", "after launch we will…" são planos/condições e nunca contradizem. Sem sinal claro → nada (o chamador fica em uncertain).
 * Limitações conhecidas: o SUJEITO de "em produção" é presumido o projeto do repositório (um serviço externo "em produção" num
 * documento pode ser lido como o projeto); dupla negação ("não é verdade que não…") não é tratada.
 */
export interface StateClaim { prop: "production" | "enabled"; subject: string; value: boolean; text: string }

const NEG = String.raw`(?:nao|ainda nao|not|not yet|never|nunca)`;
/** condição de verdade ("se o X…", "if", "caso", "unless", "quando"): a oração não afirma o estado atual */
const COND_STRONG = /\b(quando|caso|if|when|unless|a menos que|exceto se|desde que|whenever)\b|\bse (?:o|a|os|as|um|uma|nao|houver|for|forem|tiver|estiver|esta|entrar|ligar|ativar|desligar|lancar|chover)\b/;
/** frase futura ou de plano (não descreve o estado atual) */
const FUTURE = /\b(apos|antes de|assim que|ate que|uma vez que|once|after|before|until|will|shall|vai|vamos|ira|irao|devera|deverao|planej\w*|futur\w*|previst\w*|pretend\w*|roadmap)\b/;
export const CONDITIONAL = new RegExp(`${COND_STRONG.source}|${FUTURE.source}`);

// "não está em produção", "não foi lançado", "pré-produção", "até o lançamento" (este último só sem afirmação positiva na mesma frase)
const PROD_NEG = new RegExp(String.raw`\b(?:${NEG}\s+(?:\w+\s+){0,2}?(?:esta|estao|estiver|estiverem|esteja|estejam|is|are|entrou|entrar|went|foi)\s+(?:\w+(?:ndo|ing|ad[oa]|ed)\s+)?(?:em|in|live in|para|to)\s+(?:producao|production)|pre-?\s?(?:producao|production)|${NEG}\s+(?:\w+\s+){0,1}?(?:foi\s+)?lancad\w*|${NEG}\s+(?:\w+\s+){0,1}?(?:yet\s+)?launched|ate o lancamento|antes do lancamento)\b`);
const PROD_POS = new RegExp(String.raw`\b(?:(?:esta|estao|entrou|is|are|went|now|ja esta|already)\s+(?:em|in|live in)\s+(?:producao|production)|em producao desde|in production since|(?:production\s+)?launch(?:ed)?\s+(?:completed|concluid\w*|done)|lancamento\s+(?:em producao\s+)?(?:concluid\w*|realizad\w*)|(?:plataforma|sistema|produto|aplicacao|servico|platform|system|product|service)\b(?:(?!\b(?:nao|not|nunca|never|sem|without)\b)[^.;:]){0,80}?\bem producao\b|(?:platform|system|product|service)\b(?:(?!\b(?:not|never|without)\b)[^.;:]){0,80}?\bin production\b|went live|is live|go-live (?:concluid\w*|realizad\w*|completed|done)|foi lancad\w* em producao|lancad\w* em producao)\b`);

const OFF = String.raw`(?:desligad\w*|desativad\w*|desabilitad\w*|off|disabled|false|inativ\w*)`;
const ON = String.raw`(?:ligad\w*|ativad\w*|habilitad\w*|on|enabled|true|ativ[oa])`;
// sujeito com a GRAFIA original (camelCase preservado: `featureEnabled` canonicaliza para feature_enabled)
const TOGGLE = new RegExp(String.raw`([A-Za-z][A-Za-z0-9_.-]{2,60})\s+(?:\(\w+\)\s+)?(?:esta|fica|ficou|segue|continua|permanece|is|stays|remains|=|:)\s*(?:ainda\s+|still\s+)?(${OFF}|${ON})\b`, "gi");
const ONLY_ON = new RegExp(`^${ON}$`, "i");

/** Sem acento, MESMA caixa (o sujeito precisa da grafia original); para os padrões de frase usa-se a versão minúscula. */
const deaccent = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const sentences = (s: string) => s.split(/(?<=[.;!?])\s+|\n+/).filter(Boolean);


/** Estado de produção afirmado numa frase (minúscula, sem acento), ou undefined (condição/plano/ambíguo). */
export function productionStatement(s: string): boolean | undefined {
  if (COND_STRONG.test(s)) return undefined;
  // a parte negada ("não está em produção") não pode contar como afirmação positiva da mesma frase
  const neg = PROD_NEG.test(s); const pos = PROD_POS.test(s.replace(new RegExp(PROD_NEG.source, "g"), " "));
  if (neg && pos) return undefined; // "até o lançamento da v2, o sistema está em produção": ambíguo
  // "ainda não está em produção / pré-produção / até o lançamento" descrevem o estado ATUAL mesmo com cue de futuro na frase
  if (neg) return false;
  if (FUTURE.test(s)) return undefined; // "after launch, the system is in production": plano
  return pos ? true : undefined;
}

/** Afirmações de estado da nota. */
export function stateClaims(text: string): StateClaim[] {
  const out: StateClaim[] = [];
  for (const raw of sentences(deaccent(text).replace(/[`*]/g, ""))) { // crases/negrito não separam sujeito e estado
    const s = raw.toLowerCase();
    const p = productionStatement(s);
    if (p !== undefined) out.push({ prop: "production", subject: "*", value: p, text: s.slice(0, 160) });
    if (CONDITIONAL.test(s)) continue;
    for (const m of raw.matchAll(TOGGLE)) {
      const subj = m[1]!.replace(/[.:]+$/, ""); if (/^(que|isso|ele|ela|this|that|it)$/i.test(subj)) continue;
      out.push({ prop: "enabled", subject: subj, value: ONLY_ON.test(m[2]!), text: s.slice(0, 160) });
    }
  }
  return out;
}

/** Afirmação de ligado/desligado sobre UM sujeito numa frase de documento (para confrontar notas com docs posteriores). */
export function toggleStatement(sentence: string, subjectCanon: string, canon: (x: string) => string): boolean | undefined {
  const s = deaccent(sentence).replace(/[`*]/g, "");
  if (CONDITIONAL.test(s.toLowerCase())) return undefined;
  for (const m of s.matchAll(TOGGLE)) if (canon(m[1]!.replace(/[.:]+$/, "")) === subjectCanon) return ONLY_ON.test(m[2]!);
  return undefined;
}

const COMMENT = /^\s*(\/\/|#|\*|\/\*|--|;)/;
/** Valor booleano atribuído a uma chave numa linha de config/código: FEATURE_X=true, feature_x: off, "featureX": false. Comentário não conta. */
export function assignedBool(line: string, key: string): boolean | undefined {
  if (COMMENT.test(line)) return undefined;
  line = line.replace(/\s(?:\/\/|#).*$/, "").replace(/\/\*.*?\*\//g, ""); // comentário no fim da linha também não conta
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(String.raw`["']?\b${k}\b["']?\s*[:=]\s*["']?(true|false|on|off|yes|no|1|0|enabled|disabled)\b`, "i").exec(line);
  if (!m) return undefined;
  return /^(true|on|yes|1|enabled)$/i.test(m[1]!);
}
/** Todas as atribuições da chave num arquivo: um valor único conclui; valores conflitantes = ambíguo (undefined). */
export function assignedInFile(lines: string[], keys: string[]): { value: boolean; line: number } | undefined {
  let found: { value: boolean; line: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    let v: boolean | undefined; for (const k of keys) { v = assignedBool(lines[i]!, k); if (v !== undefined) break; }
    if (v === undefined) continue;
    if (found && found.value !== v) return undefined;
    found ??= { value: v, line: i + 1 };
  }
  return found;
}
/** Chaves de config que dizem se o projeto está em produção/lançado (PRODUCTION_ENABLED=true, launched: true, go_live=on). */
export const PRODUCTION_KEY = /^(?:[a-z0-9_]*_)?(?:production|prod_launch|launched|go_live|golive|live_mode|is_live)(?:_[a-z0-9_]*)?$/i;
