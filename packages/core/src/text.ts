const STOP = new Set(
  ("a o os as um uma uns umas de do da dos das em no na nos nas por para com sem sobre entre e ou mas que se é eh foi ser são era como ao aos à às já não nao " +
   "the an of in on at to for with without about between and or but that is are was were be been it its this these those as by from if then so not no " +
   "atual atualmente projeto").split(/\s+/),
);

export const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Tokens normalizados (sem acento, sem stopwords, plural simples removido). Mantém números/versões. */
export function tokenize(s: string, opts: { keepStop?: boolean; stem?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const raw of fold(s).match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) ?? []) {
    if (raw.length < 2 && !/\d/.test(raw)) continue;
    if (!opts.keepStop && STOP.has(raw)) continue;
    out.push(opts.stem === false ? raw : stem(raw));
  }
  return out;
}

function stem(w: string): string {
  if (/\d/.test(w) || w.length < 5) return w;
  if (w.endsWith("coes")) return w.slice(0, -4) + "cao";
  if (w.endsWith("oes")) return w.slice(0, -3) + "ao";
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Remove markdown irrelevante para comparação. */
export function plain(md: string): string {
  const noCode: string[] = []; let fence = false;
  for (const ln of md.slice(0, 400_000).split("\n")) { if (/^\s{0,3}(```|~~~)/.test(ln)) { fence = !fence; continue; } if (!fence) noCode.push(ln.length > 4000 ? ln.slice(0, 4000) : ln); }
  return noCode.join("\n")
    .replace(/\[\[([^\]|\n]{1,200})(?:\|([^\]\n]{1,200}))?\]\]/g, (_m, a: string, b?: string) => b ?? a)
    .replace(/\[([^\]\n]{1,200})\]\([^)\n]{1,500}\)/g, "$1")
    .replace(/[#>*_`~|-]+/g, " ");
}

export function sentences(md: string): string[] {
  return plain(md).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 3);
}

export const NUMBER_RE = /\d+(?:[._-]\d+)*/g;
export const numbersOf = (s: string): string[] => fold(s).match(NUMBER_RE) ?? [];

export const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let i = 0; for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
};
/** fração do menor conjunto contida no outro */
export const containment = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let i = 0; for (const x of a) if (b.has(x)) i++;
  return i / Math.min(a.size, b.size);
};

export const NEGATIONS = /\b(nao|nunca|never|not|no longer|deixou de|sem|jamais|n't|disabled|desativad[oa]|proibid[oa])\b/;
