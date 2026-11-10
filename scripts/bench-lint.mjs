// Lint de qualidade INDEPENDENTE do extrator (não se auto-avalia). Usado por import-bench.mjs.
const DEICTIC = /^\s*(est[aeo]s?|ess[aeo]s?|isso|isto|nest[aeo]s?|aquel[aeo]s?|ela|ele|elas|eles|these|this|those|they|it|such)\b/i;
const META = /\b(este documento|esta spec|nesta spec|neste documento|nesta se[cç][aã]o|neste plano|this document|this spec|this section)\b/i;
const TRANSIENT = /\b(amanh[ãa]|hoje|ontem|reuni[ãa]o|tomorrow|yesterday|meeting|agenda)\b/i;
const STOP = new Set("a o os as um uma de do da dos das em no na nos nas por para com sem e ou que se ao à the of in on to for and or is are".split(" "));
const toks = (s) => (s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t) && t.length > 1);

export function lint(c) {
  const flags = [];
  const body = c.body.replace(/^\*\*[^*]+:\*\*\s*/gm, "").replace(/^Contexto:.*$/gm, "").trim();
  const first = body.replace(/^[-*\s]+/, "").split(/(?<=[.!?])\s+/)[0] ?? "";
  if (c.type !== "project" && toks(c.title).length <= 2) flags.push("weak-title");
  if (DEICTIC.test(first)) flags.push("dangling-opener");
  if (META.test(body)) flags.push("meta-document");
  const bullets = body.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l));
  if (bullets.filter((b) => b.trim().length > 40 && /[.]$/.test(b.trim())).length >= 4) flags.push("bundle");
  if (TRANSIENT.test(body)) flags.push("transient");
  if (c.type === "reference" && (body.match(/https?:\/\//g) ?? []).length >= 3 && body.replace(/https?:\/\/\S+/g, "").length < 200) flags.push("link-list");
  if (/…$/.test(body) || /[,;:]$/.test(body)) flags.push("truncated");
  return flags;
}

