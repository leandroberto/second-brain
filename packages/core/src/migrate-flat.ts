import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { BrainError, ID_PATTERN, NOTE_TYPES, slugify, type NoteType, type Principal } from "@brain/shared";
import { authorize } from "./authz.js";
import type { Brain } from "./brain.js";
import { withFileLock } from "./lock.js";

export interface MigrationItem { from: string; to: string; id: string; type: NoteType; inferred: boolean; project?: string; tags: string[] }
export interface MigrationPlan { items: MigrationItem[]; captures: string[]; discarded: string[]; commit?: string }

export const MIGRATION_COMMIT_MESSAGE = "migração do SB do trabalho";

/** Pasta de tema do vault antigo → tipo sugerido (o usuário corrige no dry-run com --type id=tipo). */
const TYPE_BY_FOLDER: Record<string, NoteType> = {
  "regras-de-negocio": "fact", processos: "pattern", ambiente: "learning", sistemas: "concept",
};
/** Itens da raiz que pertencem ao second-brain/editor (qualquer `.x` também é ignorado). */
const OWN_TOP = new Set(["knowledge", "_legado", "skills", "AGENTS.md", "README.md", ".gitignore"]);
const FM_RE =/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SEE_ALSO_RE = /^## Ver também[ \t]*\r?$/m;
const LINK_RE = /\[([^\]\n]*)\]\(([^)\s]+)\)/g;

const toPosix = (p: string) => p.split(sep).join("/");
/** `child` é `parent` ou está dentro dele. */
const isInside = (parent: string, child: string) => { const r = relative(parent, child); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

function walk(root: string, skip: (rel: string, isDir: boolean) => boolean): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const abs = join(dir, e.name); const rel = toPosix(relative(root, abs));
      if (skip(rel, e.isDirectory())) continue;
      if (e.isDirectory()) rec(abs); else if (e.isFile()) out.push(rel);
    }
  };
  rec(root);
  return out;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); // ignoreBOM: mantém o U+FEFF no texto
/** Lê como UTF-8 estrito: arquivo em latin1/cp1252 é recusado em vez de migrar texto corrompido. */
function readUtf8(abs: string, rel: string): string {
  try { return UTF8.decode(readFileSync(abs)); }
  catch { throw new BrainError("invalid", `${rel} não é UTF-8 válido (provavelmente latin1/cp1252); converta o arquivo para UTF-8 antes de migrar. Nada foi alterado.`); }
}

const normId =(name: string): string => {
  const s = slugify(name.replace(/\.md$/i, ""), 80);
  if (!s) return "nota";
  return s.length < 3 ? `nota-${s}` : s;
};
const asIso = (v: unknown, fallback: string): string => {
  if (v instanceof Date) return v.toISOString();
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return fallback;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s;
};

/** Converte os links relativos para .md de DENTRO de `## Ver também`; todo o resto do corpo fica intacto. */
function convertSeeAlso(body: string, fromRel: string, idByRel: Map<string, string>): string {
  const m = SEE_ALSO_RE.exec(body);
  if (!m) return body;
  const start = m.index;
  const after = start + m[0].length;
  const next = /^## /m.exec(body.slice(after));
  const end = next ? after + next.index : body.length;
  const block = body.slice(start, end).replace(LINK_RE, (whole, _t: string, target: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || !/\.md(#.*)?$/i.test(target)) return whole;
    let path = target.replace(/#.*$/, "");
    try { path = decodeURIComponent(path); } catch { /* mantém o texto */ }
    const id = idByRel.get(posix.normalize(posix.join(posix.dirname(fromRel), path)));
    return id ? `[[${id}]]` : whole;
  });
  return body.slice(0, start) + block + body.slice(end);
}

interface Parsed { rel: string; fm: Record<string, unknown>; body: string; folder: string; project?: string; id: string }

/**
 * Migração de uso único (spec §7.2): NÃO usa o importador, porque o texto tem de ser preservado byte a byte.
 * O corpo vira exatamente o do original; só os links de `## Ver também` mudam. `apply: false` não escreve nada.
 */
export async function migrateFlat(
  brain: Brain, srcDir: string, who: Principal,
  opts: { apply: boolean; typeOverrides?: Record<string, NoteType> },
): Promise<MigrationPlan> {
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) throw new BrainError("not_found", `pasta de origem não encontrada: ${srcDir}`);
  const src = realpathSync(resolve(srcDir));
  const root = realpathSync(resolve(brain.vault.root));
  // uso real: a migração é feita NO LUGAR (a pasta antiga já é o vault). Origem fora do vault também funciona.
  const inPlace = src === root;
  if (!inPlace && (isInside(root, src) || isInside(src, root))) throw new BrainError("invalid", "a pasta de origem deve ser a raiz do vault (migração no lugar) ou ficar fora dele; subpasta do vault ou pasta que o contém não serve");
  for (const [id, t] of Object.entries(opts.typeOverrides ?? {})) {
    if (!(NOTE_TYPES as readonly string[]).includes(t)) throw new BrainError("invalid", `tipo inválido para "${id}": ${t} (use um de ${NOTE_TYPES.join(", ")})`);
  }

  // notas: tudo que é .md fora de pastas ocultas (.obsidian, .desfazer…) e de _entrada
  const files = walk(src, (rel, isDir) => {
    const parts = rel.split("/");
    // no lugar, o que é do second-brain ou do editor não é nota antiga
    if (inPlace && OWN_TOP.has(parts[0]!)) return true;
    return parts.some((s) => s.startsWith(".")) || parts[0] === "_entrada" || (!isDir && !rel.toLowerCase().endsWith(".md"));
  });
  const captures = existsSync(join(src, "_entrada")) ? walk(join(src, "_entrada"), (rel, isDir) => !isDir && !rel.toLowerCase().endsWith(".md")).map((r) => `_entrada/${r}`) : [];
  const discarded = existsSync(join(src, ".desfazer")) ? walk(join(src, ".desfazer"), () => false).map((r) => `.desfazer/${r}`) : [];

  // ids já usados no vault de destino + os deste lote (colisão ganha -2, -3…)
  for (const c of captures) readUtf8(join(src, c), c); // capturas também só migram se forem UTF-8 válido
  const taken = new Set(brain.vault.listFiles().map((f) => posix.basename(f).replace(/\.md$/i, "")));
  const parsed: Parsed[] = files.map((rel) => {
    const raw = readUtf8(join(src, rel), rel);
    // o BOM só é reconhecido para achar o cabeçalho; o arquivo novo começa com o cabeçalho novo, então o corpo não leva o BOM
    const text = raw.startsWith("﻿") ? raw.slice(1) : raw;
    const m = FM_RE.exec(text);
    let fm: Record<string, unknown> = {};
    let bodyStart = -1; // só é cabeçalho se o YAML for um mapa; senão (ex.: régua horizontal) o arquivo inteiro é corpo
    if (m) {
      let y: unknown;
      try { y = yamlParse(m[1]!); } catch { throw new BrainError("invalid", `cabeçalho YAML inválido em ${rel}`); }
      if (y && typeof y === "object" && !Array.isArray(y)) { fm = y as Record<string, unknown>; bodyStart = m[0].length; }
    }
    const parts = rel.split("/");
    const base = normId(parts[parts.length - 1]!);
    let id = base; for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    const folder = parts.length > 1 ? parts[0]! : "";
    const project = folder === "sistemas" && parts.length > 2 ? slugify(parts[1]!) || undefined : undefined;
    return { rel, fm, body: bodyStart >= 0 ? text.slice(bodyStart) : raw, folder, project, id };
  });
  const idByRel = new Map(parsed.map((p) => [p.rel, p.id]));

  const built = parsed.map((p) => {
    if (!ID_PATTERN.test(p.id)) throw new BrainError("invalid", `id inválido gerado para ${p.rel}: ${p.id}`);
    const override = opts.typeOverrides?.[p.id];
    const type = override ?? TYPE_BY_FOLDER[p.folder] ?? "concept";
    const oldTags = Array.isArray(p.fm.tags) ? p.fm.tags.map(String).filter(Boolean) : [];
    const folderTag = p.folder && p.folder !== "sistemas" ? slugify(p.folder) : "";
    const tags = [...new Set([...oldTags, ...(folderTag ? [folderTag] : [])])].map((t) => t.slice(0, 60));
    const mtime = new Date(statSync(join(src, p.rel)).mtimeMs).toISOString();
    const title = (typeof p.fm.titulo === "string" && p.fm.titulo.trim() ? p.fm.titulo.trim() : /^#\s+(.+)$/m.exec(p.body)?.[1]?.trim() ?? posix.basename(p.rel, ".md")).slice(0, 200);
    const item: MigrationItem = {
      from: p.rel, id: p.id, type, inferred: !override, tags,
      to: brain.vault.pathFor({ id: p.id, type, project: p.project, status: "active" }),
      ...(p.project ? { project: p.project } : {}),
    };
    const fm: Record<string, unknown> = {
      id: p.id, title, type, status: "active", ...(p.project ? { project: p.project } : {}),
      created_at: asIso(p.fm.criado, mtime), updated_at: asIso(p.fm.atualizado, mtime),
      ...(tags.length ? { tags } : {}),
      source: { type: "manual" }, created_by: { kind: "human", name: who.name },
    };
    const content = `---\n${yamlStringify(fm, { lineWidth: 0 }).trimEnd()}\n---\n\n${convertSeeAlso(p.body, p.rel, idByRel)}`;
    return { item, content };
  });
  const plan: MigrationPlan = { items: built.map((b) => b.item), captures, discarded };
  if (!opts.apply) return plan;
  if (!built.length && !captures.length && !discarded.length) return plan; // segunda execução no lugar: nada a migrar

  authorize(who, "write", { config: brain.config });
  const v = brain.vault;
  const capDest = (c: string) => `.brain/captures/${c.slice("_entrada/".length)}`;
  const dests = [...built.map((b) => b.item.to), ...files.map((f) => `_legado/${f}`), ...captures.map(capDest)];
  const clash = dests.find((d) => v.fileExists(d));
  if (clash) throw new BrainError("duplicate_id", `destino já existe, nada foi migrado: ${clash}`);

  plan.commit = await withFileLock(v.lockPath, async () => {
    for (const b of built) v.writeAtomic(b.item.to, b.content);
    const gone = [...files, ...captures, ...discarded];
    if (inPlace) {
      // no lugar: mover dentro do vault; o .desfazer é descartado
      for (const f of files) v.move(f, `_legado/${f}`);
      for (const c of captures) v.move(c, capDest(c));
      for (const d of discarded) v.remove(d);
    } else {
      // origem fora do vault: copia (tudo gravado) e só então remove da origem
      // (os arquivos já foram validados como UTF-8, então a ida e volta é exata; mesmo assim confere os bytes antes de apagar)
      const copies: Array<[string, string]> = [...files.map((f): [string, string] => [f, `_legado/${f}`]), ...captures.map((c): [string, string] => [c, capDest(c)])];
      for (const [from, to] of copies) v.writeAtomic(to, readUtf8(join(src, from), from));
      for (const [from, to] of copies) {
        if (!readFileSync(join(src, from)).equals(readFileSync(join(v.root, to)))) throw new BrainError("invalid", `a cópia de ${from} em ${to} difere do original; nada foi removido da origem`);
      }
      for (const rel of gone) rmSync(join(src, rel), { force: true });
    }
    for (const rel of gone) for (let d = dirname(rel); d && d !== "."; d = dirname(d)) { try { rmdirSync(join(src, d)); } catch { break; } }
    // no lugar, os caminhos antigos que o Git rastreava (init os commitou) saem no mesmo commit; os não rastreados nem aparecem
    const goneSet = new Set(gone);
    const oldTracked = inPlace ? (await brain.git.dirty(".")).filter((p) => goneSet.has(p)) : [];
    const paths = [...built.map((b) => b.item.to), ...(files.length ? ["_legado"] : []), ...(captures.length ? [".brain/captures"] : []), ...oldTracked];
    try { return await brain.git.commitPaths(paths, MIGRATION_COMMIT_MESSAGE); }
    catch (e) {
      // com estado externo o repositório não está em <vault>/.git: o comando de recuperação aponta o git-dir do estado
      const git = v.gitDir ? `git --git-dir="${v.gitDir}" --work-tree="${v.root}"` : `git -C "${v.root}"`;
      throw new BrainError("git_error", `os arquivos já foram gravados/movidos, mas o commit falhou (${(e as Error).message}). Pendente no vault ${v.root}: ${paths.join(", ")}. Para concluir: ${git} add -A -- ${paths.map((p) => `"${p}"`).join(" ")} && ${git} commit -m "${MIGRATION_COMMIT_MESSAGE}"`);
    }
  });
  await brain.reindex();
  return plan;
}
