import type { SourceKind } from "@brain/shared";
import { fold } from "../text.js";

/**
 * Semântica da origem e extração de ÂNCORAS verificáveis de uma afirmação.
 * Determinístico e explicável: nada aqui "entende" código; só aponta o que dá para conferir no HEAD
 * (identificadores, caminhos, tecnologias, nomes próprios e, com peso baixo, palavras de conteúdo).
 */

/** Tipo semântico da fonte a partir do caminho (e, para planos disfarçados, do conteúdo). */
export function sourceKindOf(path: string, text = ""): SourceKind {
  const l = path.toLowerCase();
  if (/^commit /.test(l)) return "commit";
  if (/(^|\/)(agents|claude|gemini)\.md$/.test(l)) return "agents";
  if (/(^|\/)(changelog|history|release[-_ ]?notes)[^/]*\.md$/.test(l)) return "changelog";
  if (/(^|\/)(plans?|planos?|roadmaps?|todos?|tasks?|tarefas)\//.test(l) || /(^|\/)[^/]*(implementation-plan|plano-de-implementacao|roadmap|todo)[^/]*\.md$/.test(l)) return "plan";
  if (/(^|\/)(adr|adrs|decisions?|decisoes)\//.test(l) || /(^|\/)adr[-_ ]?\d+[^/]*\.md$/.test(l)) return "adr";
  if (/(^|\/)(specs?|rfcs?|designs?|proposals?)\//.test(l) || /(^|\/)[^/]*[-_](design|spec|rfc)(-[^/]*)?\.md$/.test(l)) return "spec";
  if (/(^|\/)readme(\.[a-z]+)?\.md$/.test(l)) return "readme";
  if (/(^|\/)issues?\//.test(l)) return "issue";
  if (/\.(md|mdx|markdown|txt)$/.test(l)) {
    // documento genérico cujo conteúdo é uma lista de tarefas → é plano, não descrição
    const f = fold(text.slice(0, 4000));
    if ((f.match(/^\s*[-*]\s+\[[ x]\]/gm)?.length ?? 0) >= 3 || /^#{1,3}\s+(task|tarefa|step|passo)\s+\d+/m.test(f)) return "plan";
    return "docs";
  }
  if (/(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/.test(l)) return "test";
  if (/\.[a-z0-9]+$/.test(l)) return "code";
  return "other";
}

/** Fontes que registram INTENÇÃO (o porquê / o que se pretendia) versus fontes que DESCREVEM o estado. */
export const INTENT_KINDS: SourceKind[] = ["adr", "spec", "plan", "issue"];
export const DESCRIPTION_KINDS: SourceKind[] = ["readme", "docs", "agents", "changelog"];

/** Afirmação formulada como trabalho futuro ("Implementaremos X", "will add", "- [ ] Task") — plano, não fato. */
// "todo" em português é "inteiro/cada": TODO só conta em MAIÚSCULAS (verificado no texto original)
const PLAN_LANGUAGE = /\b(implementaremos|vamos (implementar|adicionar|migrar|usar|criar)|iremos|pretendemos|planejad[oa]s?|a implementar|sera implementad[oa]|serao implementad[oa]s|will (implement|add|introduce|migrate|use|build|create)|we plan to|planned|to be implemented|to-do|task \d+|tarefa \d+|proximos passos|next steps)\b/;
export const isPlanLanguage = (s: string): boolean => PLAN_LANGUAGE.test(fold(s)) || /\bTODO\b/.test(s) || /^\s*[-*]\s+\[ \]/m.test(s);
export const checkedTask = (s: string): boolean => /^\s*[-*]\s+\[[xX]\]/m.test(s);

/** Categorias de tecnologias MUTUAMENTE EXCLUSIVAS (escolhe-se uma). Vocabulário genérico de domínio, não específico de projeto. */
export const TECH: Array<{ category: string; name: string; aliases: string[] }> = [
  ...["sqlite:sqlite,sqlite3,better-sqlite3,node:sqlite,aiosqlite", "postgres:postgres,postgresql,psycopg,psycopg2,asyncpg,pg-promise,postgis,pg", "mysql:mysql,mysql2,mariadb,pymysql", "mongodb:mongodb,mongo,mongoose,pymongo", "dynamodb:dynamodb", "firestore:firestore", "cassandra:cassandra", "duckdb:duckdb"].map((s) => tech("database", s)),
  ...["redis:redis,ioredis,aioredis", "memcached:memcached,pymemcache"].map((s) => tech("cache", s)),
  ...["rest:rest,restful", "grpc:grpc,grpcio,grpc-js,protobuf", "graphql:graphql,apollo", "trpc:trpc", "soap:soap"].map((s) => tech("api-style", s)),
  ...["kafka:kafka,kafkajs", "rabbitmq:rabbitmq,amqp,amqplib,pika", "sqs:sqs", "nats:nats", "celery:celery", "bullmq:bullmq,bull"].map((s) => tech("queue", s)),
  ...["electron:electron", "tauri:tauri"].map((s) => tech("desktop-shell", s)),
  ...["react:react", "vue:vue,vuejs", "svelte:svelte,sveltekit", "angular:angular", "solid:solid-js,solidjs"].map((s) => tech("ui-framework", s)),
  ...["prisma:prisma", "drizzle:drizzle,drizzle-orm", "typeorm:typeorm", "sequelize:sequelize", "sqlalchemy:sqlalchemy", "django-orm:django"].map((s) => tech("orm", s)),
  ...["telethon:telethon", "pyrogram:pyrogram", "aiogram:aiogram", "python-telegram-bot:python-telegram-bot,telegram.ext"].map((s) => tech("telegram-lib", s)),
  ...["jest:jest", "vitest:vitest", "mocha:mocha", "pytest:pytest", "unittest:unittest"].map((s) => tech("test-runner", s)),
  ...["webpack:webpack", "vite:vite", "esbuild:esbuild", "rollup:rollup", "parcel:parcel", "turbopack:turbopack"].map((s) => tech("bundler", s)),
  ...["ollama:ollama", "openai:openai", "anthropic:anthropic"].map((s) => tech("llm-provider", s)),
];
function tech(category: string, spec: string) { const i = spec.indexOf(":"); return { category, name: spec.slice(0, i), aliases: spec.slice(i + 1).split(",") }; }
const TECH_BY_ALIAS = new Map<string, (typeof TECH)[number]>();
for (const t of TECH) for (const a of t.aliases) TECH_BY_ALIAS.set(a, t);
export const techByAlias = (a: string) => TECH_BY_ALIAS.get(a.toLowerCase());
/** Aliases curtos demais ou ambíguos só valem como dependência declarada, nunca como palavra solta do texto. */
const TECH_TEXT_SKIP = new Set(["rest", "vue", "solid", "pg", "mongo", "bull", "sqs", "nats", "soap", "apollo", "protobuf", "django", "anthropic", "openai", "pika", "amqp"]);

export interface Anchor {
  /** forma original no texto */
  text: string;
  /** chave normalizada de consulta no índice do repositório */
  key: string;
  kind: "ident" | "path" | "tech" | "proper" | "word";
  /** peso como evidência (ident/path/tech = forte) */
  weight: number;
  /** pos = a afirmação diz que existe/é usado; neg = diz que NÃO se usa / foi substituído (ambíguas são descartadas) */
  polarity: "pos" | "neg";
  category?: string;
  /** forma inequivocamente de código (entre crases, snake_case, camelCase, CONSTANTE, caminho): só estas contradizem quando ausentes */
  explicit?: boolean;
}

/** Divide identificador (snake/camel/kebab/dotted) em subtokens minúsculos. */
export function identParts(id: string): string[] {
  return id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).map((x) => x.toLowerCase()).filter((x) => x.length >= 2);
}
/** Forma canônica de um identificador: snake_case minúsculo (camelCase e snake_case colapsam na mesma chave). */
export const canonicalIdent = (id: string): string => identParts(id).join("_");

const STOPWORDS = new Set(("para pela pelo pelos pelas com sem sobre entre como quando onde porque pois mais menos muito muita todo toda todos todas cada outro outra outros outras mesmo mesma " +
  "deve devem pode podem sera serao fica ficam esta este estes estas isso isto essa esse aqui ainda apenas somente sempre nunca tambem entao assim depois antes durante " +
  "usar usamos usado usada usa usam uso utilizar adotar adotamos escolhemos optamos manter mantem fazer feito feita ter tem temos sendo seja sejam existe existem " +
  "with without from into over under when where because since must should shall will would could have has had using used uses use adopt chosen choose keep only also than then there their these those which while being every each other another such " +
  "projeto project sistema system decisao decision regra rule caso casos forma modo parte ponto pontos tipo tipos versao version valor valores nova novo novas novos primeira primeiro " +
  "contexto context status consequencias consequences porque motivo razao objetivo objetivos").split(/\s+/));
/** Palavras capitalizadas comuns em início de frase/título que NÃO são nomes próprios. */
const NOT_PROPER = new Set(("Status Contexto Decisão Decisao Consequências Consequencias Por Porque Para Com Sem Quando Uma Um Os As Ele Ela Este Esta Esse Essa Isso Nunca Sempre Toda Todo Cada " +
  "The This These That When With Without Because Each Every Never Always All Some Only Also Decision Context Consequences Fase Phase Task Tarefa Step Passo Known Selected Approach " +
  "Second Brain Review Queue Markdown Git").split(/\s+/));

// janelas curtas e sem atravessar vírgula/pontuação: precisão > recall.
// REJEIÇÃO exige verbo de escolha ("não usaremos X", "evitar X", "rejeitamos X"); negação sem ele ("o serviço não conhece X",
// "sem X") descreve outra coisa (camadas, condições) e torna a ocorrência AMBÍGUA — não vira evidência em nenhum sentido.
const CHOICE_VERB = "(?:usar|usaremos|usamos|usa|usam|utiliz\\w*|adot\\w+|depend\\w*|inclu\\w+|adicion\\w+|instal\\w+|introduz\\w*|use|using|uses|used|adopt\\w*|rely on|relies on|introduc\\w+|add|adding|install\\w*|ship|shipping)";
const NEG_CHOICE = new RegExp(`\\b(?:nao|nunca|jamais|never|not|no longer|evitar|evite|avoid|avoiding|don't|do not|nao vamos|nao iremos)\\b(?:\\s+[^\\s.;:,]+){0,2}?\\s+${CHOICE_VERB}\\b(?:\\s+[^\\s.;:,]+){0,2}?\\s*$|\\b(?:evitar|evite|avoid|avoiding)\\s+(?:o |a |os |as |the )?$|\\b(?:rejeit\\w+|descart\\w+|abandon\\w+|rejected|dropped|ditched)\\s+(?:o |a |os |as |the )?$`);
const NEGATOR = /\b(nao|sem|nunca|jamais|nenhum|nenhuma|never|not|without|nor|no)\b[^.;:,]{0,30}$/;
/** Entre a locução e o termo só cabem artigos/verbos de uso: "em vez de usar X" conta; "em vez de mockar X" não (o substituído é o mock). */
const ALT_GAP = "((?:\\s+(?:usar|use|using|utilizar|o|a|os|as|the|um|uma|an|de|do|da))*)\\s*$";
const ALT_CUE = new RegExp(`\\b(em vez de|ao inves de|no lugar de|instead of|rather than|(?:migr|mud|switch|mov)\\w*\\b[^.;:]{0,30}?\\b(?:de|from|away from))${ALT_GAP}`);
const SUBST_CUE = /\b(substitui(?:u|ndo|r|mos)?|replac(?:e|es|ing))\b([^.;:]{0,30})$/;
// particípio em português é passivo por natureza ("X substituído/removido/desligado"); em inglês o verbo precisa de auxiliar
// ("X was replaced") — "Redis replaced Memcached" é voz ATIVA (Redis é o novo). Negação no meio ("não foi substituído") anula.
const NEG_AFTER_PT = /^[^.;:,]{0,15}?\b(?:(?:foi|e|esta|sera|fica|ficou|sao|foram)\s+)?(?:rejeitad|descartad|removid|retirad|abandonad|depreciad|obsolet|substituid|descontinuad|legado|desligad|desativad)/;
const NEG_AFTER_EN = /^[^.;:,]{0,15}?\b(?:(?:was|were|is|are|has been|have been|got|been|being)\s+(?:rejected|dropped|removed|deprecated|replaced|superseded|disabled|abandoned|turned off|switched off)|(?:is\s+)?(?:deprecated|obsolete|legacy)\b)/;
export const NEG_IN = /\b(nao|not|never|nunca|jamais|n't)\b/;
/**
 * Frase de ESCOLHA PURA de uma tecnologia: "Usaremos SQLite como banco local", "Usar gRPC para a API pública", "O cache é Redis".
 * Só nela a presença da tecnologia confirma a afirmação inteira; "We use Redis to encrypt every session" afirma um predicado
 * ("criptografar") que uma dependência não prova — fica parcial.
 */
export function pureChoice(claim: string, techText: string): boolean {
  const x = fold(techText).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // papel depois de "como/as/for/para": 1–3 SUBSTANTIVOS — "para criptografar" (infinitivo) e "to encrypt" são predicados, não papel
  const re = new RegExp(`^(?:(?:o|a|os|as|nosso|nossa|our|the|we|nos)\\s+)?(?:[\\w-]+\\s+){0,2}?(?:usaremos|usamos|usar|usa|usam|use|uses|will use|adotar|adotamos|adotaremos|escolhemos|optamos por|chose|choose|adopt|adopted|e|is|sera|will be)\\s+(?:o |a |the )?${x}(?:\\s+(?:como|as|for|para)(?:\\s+(?![\\w-]*(?:ar|er|ir)\\b)[\\w-]+){1,3})?\\s*[.!]?$`);
  const text = fold(claim).replace(/\*\*[^*\n]{1,40}:\*\*/g, " ").replace(/\s+/g, " ").trim();
  const sents = text.split(/[.;\n]+/).map((s) => s.trim()).filter(Boolean);
  const words = (s: string) => s.match(/[a-z0-9_-]{2,}/g)?.length ?? 0;
  const total = words(text);
  // a frase de escolha precisa SER a afirmação (≥ 80% do conteúdo): "We use Redis. Every session is encrypted…" não é escolha pura
  return sents.some((s) => s.length <= 140 && re.test(s) && words(s) >= total * 0.8);
}

/** Polaridade de UMA ocorrência: o texto ao redor diz que a coisa NÃO é usada / foi substituída? */
export function polarityAt(folded: string, idx: number, len: number): "pos" | "neg" | "amb" {
  const before = folded.slice(Math.max(0, idx - 60), idx); const after = folded.slice(idx + len, idx + len + 50);
  const na = NEG_AFTER_PT.exec(after) ?? NEG_AFTER_EN.exec(after);
  if (NEG_CHOICE.test(before) || (na && !NEG_IN.test(na[0]))) return "neg";
  if (NEGATOR.test(before)) return "amb";
  if (ALT_CUE.test(before)) return "neg";
  const sub = SUBST_CUE.exec(before);
  // "substituir X por Y": Y é o NOVO (positivo) — exceto "substitui a preferência/opção por Y" (por = "for": Y é o antigo)
  if (sub && (!/\b(por|with|by|para|to)\b/.test(sub[2] ?? "") || /\b(preferencias?|opcao|opcoes|escolha|interesse|preference|choice) (inicial |original |anterior )?(por|for)\s+$/.test(sub[2] ?? ""))) return "neg";
  return "pos";
}

const PATH_RE = /(?:^|[\s(`"'])((?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|cs|sql|json|ya?ml|toml|md|sh|css|html))(?=$|[\s)`"',.;:])/g;
const IDENT_RE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/g;
const PROPER_RE = /(?<=[^.!?:\n]\s)([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç0-9]{3,}(?:[A-Z][a-z0-9]+)*)\b/g;

/**
 * Âncoras verificáveis de uma afirmação. Remove metadados do importador ("Contexto: …", "_Status no ADR…_") e blocos de
 * código antes de extrair. Uma mesma chave com polaridades opostas no texto vira contexto (ignorada): ambígua não é evidência.
 */
export function anchorsOf(title: string, body: string, ignore: string[] = []): Anchor[] {
  const text = `${title}\n${body}`.replace(/^Contexto:.*$/gm, "").replace(/^_Status no ADR:.*$/gm, "").replace(/```[\s\S]*?```/g, " ").slice(0, 6000);
  const folded = fold(text);
  // nome do projeto/repositório aparece em todo lugar do código: não é evidência de nada
  const skip = new Set(ignore.flatMap((x) => [...identParts(x), fold(x), canonicalIdent(x)]));
  const out = new Map<string, Anchor & { pols: Set<string> }>();
  const add = (a: Omit<Anchor, "polarity">, idx: number, len: number) => {
    if (skip.has(a.key.replace(/^\w+:/, ""))) return;
    const pol = polarityAt(folded, idx, len);
    const prev = out.get(a.key);
    if (prev) { prev.pols.add(pol); prev.weight = Math.max(prev.weight, a.weight); return; }
    out.set(a.key, { ...a, polarity: pol === "neg" ? "neg" : "pos", pols: new Set([pol]) });
  };
  // caminhos para documentação não provam implementação (só código/config contam)
  for (const m of text.matchAll(PATH_RE)) { const p = m[1]!.replace(/^\.\//, ""); if (/\.(md|mdx)$/i.test(p)) continue; add({ text: p, key: `path:${p.toLowerCase()}`, kind: "path", weight: 3, explicit: true }, m.index! + m[0].indexOf(m[1]!), m[1]!.length); }
  const ticked = new Set([...text.matchAll(/`([^`\n]{2,80})`/g)].map((m) => m[1]!));
  for (const m of text.matchAll(IDENT_RE)) {
    const id = m[1]!; const parts = identParts(id);
    if (parts.length < 2 || id.length < 5) continue;
    // PascalCase solto na prosa costuma ser nome de produto ("TypeScript", "GitHub"): vale como apoio, nunca como contradição
    const explicit = ticked.has(id) || /[_]/.test(id) || /^[a-z]/.test(id);
    add({ text: id, key: `id:${canonicalIdent(id)}`, kind: "ident", weight: 3, explicit }, m.index!, id.length);
  }
  for (const m of text.matchAll(/`([A-Za-z_][\w.-]{2,60})`/g)) { // identificador simples entre crases (`resolver`, `pydantic`)
    const id = m[1]!; if (out.has(`id:${canonicalIdent(id)}`)) continue;
    const t = techByAlias(id); if (t) { add({ text: id, key: `tech:${t.name}`, kind: "tech", weight: 3, category: t.category }, m.index!, m[0].length); continue; }
    // arquivo citado pelo nome (`app.py`) e identificadores com "_" inicial (`_shutdown_runtime`) que o padrão geral não pega
    if (/^[\w-]+\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|rb|cs|sql|sh|ya?ml|toml|json)$/i.test(id)) { add({ text: id, key: `path:${id.toLowerCase()}`, kind: "path", weight: 3, explicit: true }, m.index!, m[0].length); continue; }
    if (identParts(id).length >= 2 && /^[A-Za-z_][\w]*$/.test(id)) { add({ text: id, key: `id:${canonicalIdent(id)}`, kind: "ident", weight: 3, explicit: true }, m.index!, m[0].length); continue; }
    if (/^[a-z][a-z0-9]{3,}$/.test(id) && !STOPWORDS.has(id)) add({ text: id, key: `id:${id}`, kind: "ident", weight: 2, explicit: true }, m.index!, m[0].length);
  }
  for (const m of folded.matchAll(/\b([a-z][a-z0-9.:-]{1,24}[a-z0-9])\b/g)) {
    const w = m[1]!; const t = techByAlias(w);
    if (!t || TECH_TEXT_SKIP.has(w)) continue;
    add({ text: w, key: `tech:${t.name}`, kind: "tech", weight: 3, category: t.category }, m.index!, w.length);
  }
  // REST só como sigla maiúscula (palavra "rest" em inglês é comum demais)
  for (const m of text.matchAll(/\b(REST(?:ful)?|gRPC|GraphQL|Vue(?:\.js)?)\b/g)) { const t = techByAlias(m[1]!.replace(/\.js$/, "").toLowerCase()); if (t) add({ text: m[1]!, key: `tech:${t.name}`, kind: "tech", weight: 3, category: t.category }, m.index!, m[1]!.length); }
  for (const m of text.matchAll(PROPER_RE)) {
    const w = m[1]!; if (NOT_PROPER.has(w) || techByAlias(w) || STOPWORDS.has(fold(w))) continue;
    add({ text: w, key: `w:${fold(w)}`, kind: "proper", weight: 1.5 }, m.index!, w.length);
  }
  // palavras de conteúdo (fracas): só contam em co-ocorrência no mesmo arquivo
  const words = new Map<string, number>();
  for (const m of folded.matchAll(/\b([a-z]{5,20})\b/g)) { const w = m[1]!; if (STOPWORDS.has(w) || /(remos|ariam|aria|ando|endo)$/.test(w) || out.has(`w:${w}`) || out.has(`tech:${techByAlias(w)?.name}`)) continue; if (!words.has(w)) words.set(w, m.index!); }
  for (const [w, idx] of [...words.entries()].slice(0, 12)) add({ text: w, key: `w:${w}`, kind: "word", weight: 1 }, idx, w.length);
  // negação só é confiável para ESCOLHAS de tecnologia ("não usaremos Electron"); para identificadores ("sem `external_opt_in`")
  // costuma ser condição, não rejeição: identificador negado é descartado (ambíguo), nunca vira contradição
  return [...out.values()].filter((a) => a.pols.size === 1 && !a.pols.has("amb") && !(a.polarity === "neg" && a.kind !== "tech")).map(({ pols: _p, ...a }) => a);
}

/**
 * Lado "antigo" numa frase de mudança: "migrar de X para Y", "Y em vez de X", "X foi substituído por Y", "X deixou de…",
 * "substituir X por Y", "X is deprecated". Retorna "old"/"new" para a âncora, ou undefined se a frase não fala de mudança.
 */
export function changeSide(sentenceFolded: string, anchorFolded: string): "old" | "new" | undefined {
  const s = sentenceFolded; const a = anchorFolded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = s.search(new RegExp(`(^|[^a-z0-9_])${a}($|[^a-z0-9_])`));
  if (at < 0) return undefined;
  const R = (src: string) => new RegExp(src.replace(/A/g, a));
  // negação perto da mudança ("não foi substituído", "was not replaced", "never migrated") anula a regra
  // (as regras de DESCONTINUAÇÃO — "não usamos mais X", "X não é mais", "no longer" — contêm a negação de propósito: ficam fora da guarda)
  const DISCONT = /\b(nao (usamos|usa|usam|utiliza\w*) mais|deixamos de usar|no longer|deixou de|deixa de|nao e mais|is no longer)\b/;
  // "não deixou de ser usado", "não é mais obsoleto", "não é verdade que não usamos mais": negação ANTES da descontinuação a anula
  const NEG_DISCONT = /\b(nao|not|never|nunca|jamais|n't)\b[^.;]{0,25}\b(deixou de|deixa de|nao (usamos|usa|usam) mais|no longer)\b|\b(nao e mais|is no longer)\s+(obsolet|depreciad|deprecated|legad|legacy|descontinuad|abandonad)/;
  const hit = (re: RegExp) => {
    const m = re.exec(s); if (!m) return false;
    const span = s.slice(Math.max(0, m.index - 30), m.index + m[0].length);
    if (DISCONT.test(m[0])) return !NEG_DISCONT.test(span) && !NEG_DISCONT.test(s);
    return !NEG_IN.test(span);
  };
  const OLD = [
    R("\\b(migr\\w*|mov\\w*|mud\\w*|switch\\w*|transi\\w*)\\b[^.;]{0,30}?\\b(de|from)\\s+[^.;]{0,30}?A[^.;]{0,40}?\\b(para|to)\\b"),
    R("\\b(migr\\w*|mov\\w*|switch\\w*)\\s+(away from|para longe de)\\s+[^.;]{0,30}?A"),
    R("\\b(em vez de|ao inves de|no lugar de|instead of|rather than)(?:\\s+(?:usar|use|using|utilizar|o|a|os|as|the|um|uma|an))*\\s+A"),
    R("A[^.;]{0,40}?\\b(?:(?:foi|e|sera|fica|ficou|esta|foram)\\s+)?(substituid\\w*|depreciad\\w*|obsolet\\w*|removid\\w*|retirad\\w*|abandonad\\w*|descontinuad\\w*)"),
    R("A[^.;]{0,40}?\\b(?:was|were|is|are|will be|has been|have been|got|being)\\s+(?:replaced|superseded|deprecated|removed|dropped|abandoned|retired)"),
    R("A[^.;]{0,20}?\\b(?:is\\s+)?(?:deprecated|obsolete)\\b"),
    R("\\b(?:substituiu|substituimos|replaced|superseded)\\s+(?:o |a |os |as |the )?A"),
    R("\\b(substitui(?:r|mos|u|ndo)?|replac(?:e|ing|ed)|supersed(?:e|ing))\\s+(?:o |a |os |as |the )?[^.;]{0,25}?A[^.;]{0,40}\\b(por|with|by)\\b"),
    R("\\b(nao (usamos|usa|usam|utiliza\\w*) mais|deixamos de usar|no longer (use|uses|used|relies on))\\s+[^.;]{0,25}?A"),
    R("A[^.;]{0,30}?\\b(deixou de|deixa de|no longer|nao e mais|is no longer)\\b"),
  ];
  const NEW = [
    R("\\b(migr\\w*|mov\\w*|mud\\w*|switch\\w*)\\b[^.;]{0,30}?\\b(de|from)\\b[^.;]{0,50}?\\b(para|to)\\s+[^.;]{0,20}?A"),
    R("A[^.;]{0,30}?\\b(em vez de|ao inves de|no lugar de|instead of|rather than)\\b"),
    R("A[^.;]{0,20}?\\b(substitui|substituiu|replaces|replaced|supersedes|superseded)\\b(?!\\s+(?:by|por|pel))"),
    R("\\b(substituid\\w*|replaced|superseded)\\s+(por|by|with)\\s+[^.;]{0,25}?A"),
  ];
  // "substituir X por Y": X antigo, Y novo — testar NEW por "por/with Y" antes de OLD genérico evita inverter Y
  if (hit(R("\\b(substitui\\w*|replac\\w*)\\s+[^.;]{0,40}\\b(por|with|by)\\s+[^.;]{0,15}?A"))) return "new";
  if (NEW.some(hit)) return "new";
  if (OLD.some(hit)) return "old";
  return undefined;
}

/** Marcador de supersessão/obsolescência no PRÓPRIO documento (cabeçalho/status). */
export function selfDeprecation(doc: string): string | undefined {
  const head = doc.split("\n").slice(0, 25).join("\n");
  const m = /^\s*(?:>\s*)?(?:\*\*)?status(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(superseded|deprecated|obsolete|obsolet[oa]|substitu[ií]d[oa]|depreciad[oa]|replaced|archived|arquivad[oa]|hist[oó]ric[oa]|abandoned|abandonad[oa]|rejected|rejeitad[oa])\b[^\n]*/im.exec(head)
    ?? /^\s*>\s*(?:\*\*|⚠️\s*)?(deprecated|obsolete|obsoleto|superseded|substitu[ií]do)\b[^\n]*/im.exec(head);
  return m ? m[0].trim().slice(0, 160) : undefined;
}
