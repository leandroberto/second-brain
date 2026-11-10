import { createHash } from "node:crypto";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  FrontmatterSchema, ID_PATTERN, NOTE_TYPES, RELATION_TYPES, STATUSES, slugify,
  type Note, type NoteType, type RelationType,
} from "@brain/shared";

export const revisionOf = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex").slice(0, 12);

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface ParseResult {
  note: Note;
  /** problemas não fatais (nota continua indexável com defaults) */
  issues: string[];
}

const KNOWN = new Set([
  "id", "title", "type", "status", "project", "tags", "created_at", "updated_at",
  "source", "created_by", "confidence", "relations", "verification", "temporal",
]);

const asIso = (v: unknown, fallback: string): string => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return new Date(v).toISOString();
  return fallback;
};

/** "[[id]]", "[[id|alias]]", "id" -> "id" */
export const unlink = (s: string): string =>
  s.replace(/^\s*\[\[/, "").replace(/\]\]\s*$/, "").split("|")[0]!.split("#")[0]!.trim();

export const WIKILINK_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;

export function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  // como no Obsidian: [[x]] dentro de bloco/trecho de código é texto, não link
  const text = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  for (const m of text.matchAll(WIKILINK_RE)) out.add(m[1]!.trim());
  return [...out];
}

/** Parser leniente: nunca lança por conteúdo editado à mão no Obsidian. */
export function parseNote(raw: string, path: string, mtimeIso: string): ParseResult {
  const issues: string[] = [];
  const base = path.split("/").pop()!.replace(/\.md$/i, "");
  let fm: Record<string, unknown> = {};
  let body = raw;
  const m = FM_RE.exec(raw);
  if (m) {
    body = raw.slice(m[0].length).replace(/^\r?\n/, "");
    try {
      const parsed = yamlParse(m[1]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
      else issues.push("frontmatter não é um mapa YAML");
    } catch (e) {
      issues.push(`frontmatter YAML inválido: ${(e as Error).message.split("\n")[0]}`);
    }
  } else issues.push("sem frontmatter");

  let id = typeof fm.id === "string" ? fm.id : "";
  if (!ID_PATTERN.test(id)) {
    if (id) issues.push(`id inválido "${id}"`);
    else issues.push("sem id");
    id = slugify(base) || `nota-${revisionOf(raw).slice(0, 6)}`;
    if (!ID_PATTERN.test(id)) id = `nota-${revisionOf(raw).slice(0, 8)}`;
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = (typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : heading ?? base).slice(0, 200);
  const type: NoteType = (NOTE_TYPES as readonly string[]).includes(String(fm.type)) ? (fm.type as NoteType) : "concept";
  if (type !== fm.type) issues.push(`type ausente/inválido (usando "${type}")`);
  const status = (STATUSES as readonly string[]).includes(String(fm.status)) ? (fm.status as Note["status"]) : "active";
  const tags = (Array.isArray(fm.tags) ? fm.tags.map(String).filter(Boolean) : []).map((t) => t.slice(0, 60)).slice(0, 50);
  const project = typeof fm.project === "string" && ID_PATTERN.test(fm.project) ? fm.project : undefined;

  const relations: Note["relations"] = {};
  const rel = fm.relations;
  if (rel && typeof rel === "object" && !Array.isArray(rel)) {
    for (const [k, v] of Object.entries(rel as Record<string, unknown>)) {
      if (!(RELATION_TYPES as readonly string[]).includes(k)) { issues.push(`relação desconhecida "${k}"`); continue; }
      const list = (Array.isArray(v) ? v : [v]).map((x) => unlink(String(x))).filter(Boolean);
      if (list.length) relations[k as RelationType] = [...new Set(list)];
    }
  }
  const candidate = {
    id, title, type, status, project, tags,
    created_at: asIso(fm.created_at, mtimeIso), updated_at: asIso(fm.updated_at, mtimeIso),
    source: fm.source, created_by: fm.created_by,
    confidence: fm.confidence, relations,
    ...(fm.verification !== undefined ? { verification: fm.verification } : {}),
    ...(fm.temporal !== undefined ? { temporal: fm.temporal } : {}),
  };
  let parsed = FrontmatterSchema.safeParse(candidate);
  if (!parsed.success) {
    issues.push(`campos inválidos: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    parsed = FrontmatterSchema.safeParse({ ...candidate, source: undefined, created_by: undefined, confidence: undefined, verification: undefined, temporal: undefined });
  }
  const data = parsed.success ? parsed.data : FrontmatterSchema.parse({ ...candidate, source: undefined, created_by: undefined, confidence: undefined, verification: undefined, temporal: undefined, tags: [] });
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) if (!KNOWN.has(k)) extra[k] = v;
  const note: Note = {
    ...data, body, path, revision: revisionOf(raw),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
  return { note, issues };
}

/** Serialização determinística; preserva chaves desconhecidas e o corpo exato. */
export function serializeNote(n: Note): string {
  const rel: Record<string, string[]> = {};
  for (const t of RELATION_TYPES) {
    const l = n.relations[t];
    if (l?.length) rel[t] = l.map((id) => `[[${id}]]`);
  }
  const fm: Record<string, unknown> = {
    id: n.id, title: n.title, type: n.type, status: n.status,
    ...(n.project ? { project: n.project } : {}),
    created_at: n.created_at, updated_at: n.updated_at,
    ...(n.tags.length ? { tags: n.tags } : {}),
    ...(n.source ? { source: n.source } : {}),
    ...(n.created_by ? { created_by: n.created_by } : {}),
    ...(n.confidence ? { confidence: n.confidence } : {}),
    ...(n.verification ? { verification: n.verification } : {}),
    ...(n.temporal ? { temporal: n.temporal } : {}),
    ...(Object.keys(rel).length ? { relations: rel } : {}),
    ...(n.extra ?? {}),
  };
  const y = yamlStringify(fm, { lineWidth: 0 }).trimEnd();
  const body = n.body.endsWith("\n") ? n.body : `${n.body}\n`;
  return `---\n${y}\n---\n\n${body}`;
}
