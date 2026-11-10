/**
 * Projetos: nome curto para exibição e ligações ENTRE projetos derivadas das próprias notas.
 * Nada é gravado: a ligação é calculada a cada leitura, sempre com as notas que a evidenciam (não é similaridade).
 */

/** Nome curto: o título da visão geral até o primeiro ":" ou travessão ("Delivery SaaS: plataforma…" → "Delivery SaaS"). */
export function projectName(title: string | undefined, id: string): string {
  const head = (title ?? "").split(/:\s|\s[—–]\s/)[0]!.replace(/\s*\([^)]*\)\s*$/, "").trim(); // "Promo Watcher (demo)" → "Promo Watcher"
  return head.length >= 2 && head.length <= 40 ? head : id;
}

/** Uma nota que sustenta a ligação: quem cita (`from`), quem é citado (`to`) e o trecho onde a citação aparece. */
export interface LinkEvidence { id: string; title: string; from: string; to: string; snippet: string }
/** `evidence` = até `maxEvidence` exemplos com trecho (mais recentes primeiro); `evidence_ids` = TODAS as notas que sustentam a ligação. */
export interface ProjectLink { a: string; b: string; weight: number; evidence: LinkEvidence[]; evidence_ids: string[] }

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Palavras comuns demais para identificar um projeto ("web", "api"…): como alias, ligariam qualquer nota que as use. */
const GENERIC = new Set(["web", "api", "app", "apps", "site", "core", "docs", "doc", "lib", "cli", "server", "client", "backend", "frontend", "mobile", "admin", "infra", "shared", "common", "utils", "test", "tests", "demo", "main", "dev"]);

/**
 * Ligações entre projetos: uma nota do projeto A que cita o NOME ou o slug do projeto B liga A–B. O peso é o número de notas
 * distintas que citam o outro lado (nos dois sentidos). Vale a citação mais longa ("Promo Watcher Site" cita o site, não o
 * Promo Watcher): pré-filtro com includes e regex só nos aliases presentes; as citações mais longas reservam o trecho. Aliases genéricos
 * ou de mais de um projeto (ambíguos) são descartados. Notas sem projeto não geram ligação.
 */
export function projectLinks(
  notes: Array<{ id: string; project?: string | null; title: string; body: string; updated_at?: string }>,
  projects: Array<{ id: string; name: string }>,
  maxEvidence = 5,
): ProjectLink[] {
  const owners = new Map<string, Set<string>>();
  for (const p of projects) for (const a of new Set([fold(p.name), fold(p.id)])) if (a.length >= 3 && !GENERIC.has(a)) owners.set(a, (owners.get(a) ?? new Set()).add(p.id));
  const alias = new Map([...owners].filter(([, ps]) => ps.size === 1).map(([a, ps]) => [a, [...ps][0]!]));
  if (!alias.size) return [];
  // pré-filtro barato (includes nativo) e regex só para os aliases que aparecem literalmente na nota
  const res = [...alias.keys()].map((a) => ({ a, project: alias.get(a)!, re: new RegExp(`(?<![\\p{L}\\p{N}-])${escape(a)}(?![\\p{L}\\p{N}-])`, "gu") }));
  const pairs = new Map<string, Map<string, LinkEvidence & { at: string }>>();
  for (const n of notes) {
    if (!n.project) continue;
    const raw = `${n.title}\n${n.body}`; const text = fold(raw);
    const hits: Array<{ s: number; e: number; project: string }> = [];
    for (const r of res) { if (!text.includes(r.a)) continue; for (const m of text.matchAll(r.re)) hits.push({ s: m.index, e: m.index + m[0].length, project: r.project }); }
    if (!hits.length) continue;
    // vale a citação mais longa: as mais compridas reservam o trecho; as contidas nelas são descartadas
    hits.sort((x, y) => y.e - y.s - (x.e - x.s) || x.s - y.s);
    const taken: Array<[number, number]> = []; const cited = new Map<string, number>(); // projeto → posição da 1ª citação válida
    for (const h of hits) {
      if (taken.some(([ts, te]) => h.s < te && h.e > ts)) continue;
      taken.push([h.s, h.e]);
      if (h.project !== n.project && (!cited.has(h.project) || h.s < cited.get(h.project)!)) cited.set(h.project, h.s);
    }
    for (const [other, at] of cited) {
      const key = [n.project, other].sort().join("\u0000");
      const ev = pairs.get(key) ?? pairs.set(key, new Map()).get(key)!;
      if (!ev.has(n.id)) ev.set(n.id, { id: n.id, title: n.title, from: n.project, to: other, snippet: snippetAt(raw, at), at: n.updated_at ?? "" });
    }
  }
  return [...pairs.entries()]
    .map(([key, ev]) => {
      const [a, b] = key.split("\u0000") as [string, string];
      const all = [...ev.values()].sort((x, y) => y.at.localeCompare(x.at) || x.id.localeCompare(y.id)); // mais recentes primeiro
      return { a, b, weight: all.length, evidence: all.slice(0, maxEvidence).map(({ at: _at, ...e }) => e), evidence_ids: all.map((e) => e.id) };
    })
    .sort((x, y) => y.weight - x.weight || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}

/**
 * A frase em volta da posição da citação (no texto original; a dobra sem acentos preserva as posições na prática), sem a
 * marcação Markdown que atrapalha a leitura, com no máximo ~200 caracteres.
 */
function snippetAt(raw: string, at: number): string {
  // fim de frase = quebra de linha, ou pontuação seguida de espaço ("app.run_watcher" e "acme.com.br" não terminam frase)
  const PUNCT = ".!?;"; const WS = " \t\r\n";
  const endsAt = (i: number) => raw[i] === "\n" || (PUNCT.includes(raw[i] ?? "x") && (i + 1 >= raw.length || WS.includes(raw[i + 1]!)));
  const lo = Math.max(0, at - 300); const hi = Math.min(raw.length, at + 300); // frase gigante sem pontuação: corta numa janela
  let s = at; while (s > lo && !endsAt(s - 1) && !(raw[s - 1] === " " && endsAt(s - 2))) s--;
  let e = at; while (e < hi && !endsAt(e)) e++;
  if (e < raw.length && raw[e] !== "\n") e++; // inclui a pontuação final
  let part = raw.slice(s, e).replace(/`|\*\*/g, "").replace(/^[ \t]*(?:#+|>|[-*]|\d+\.)[ \t]+/, "").trim();
  if (part.length > 200) {
    const rel = Math.max(0, Math.min(at - s - 80, part.length - 200));
    part = `${rel > 0 ? "…" : ""}${part.slice(rel, rel + 200).trim()}…`;
  }
  return part;
}
