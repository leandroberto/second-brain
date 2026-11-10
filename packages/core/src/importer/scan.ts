import { execFile } from "node:child_process";
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ScanOptions { maxFiles: number; maxFileBytes: number; maxTotalBytes: number }
export const DEFAULT_SCAN: ScanOptions = { maxFiles: 300, maxFileBytes: 200_000, maxTotalBytes: 3_000_000 };

export interface ScannedFile { rel: string; abs: string; size: number }
export interface ScanResult {
  root: string; repoName: string; files: ScannedFile[];
  skipped: Record<string, number>; git?: { head?: string; remote?: string };
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "venv", ".venv", "env", "__pycache__", "target", "vendor", "coverage", ".cache", ".turbo", ".pnpm-store", "site-packages", ".idea", ".vscode", ".obsidian", "tmp", "temp"]);
const DOC_EXT = /\.(md|mdx|markdown|txt)$/i;
const SKIP_NAMES = /^(changelog|agent-handoff|handoff|overnight-report|release-notes|license|licence|code_of_conduct|security|notice|authors|contributors|package-lock|pnpm-lock|yarn\.lock)(\.|$)/i;
const SECRET_NAMES = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_rsa.*|credentials.*|secrets?\..*)$/i;

/** prioridade de leitura: o que mais costuma conter decisões vem primeiro */
export function priority(rel: string): number {
  const l = rel.toLowerCase();
  if (/(^|\/)(agents|claude)\.md$/.test(l)) return 0;
  if (/(^|\/)(adr|adrs|decisions?)\//.test(l) || /(^|\/)(?!(19|20)\d{2}-\d{2}-\d{2})\d{2,4}-[^/]+\.md$/.test(l)) return 1;
  if (/(^|\/)readme(\.[a-z]+)?\.md$/.test(l) && !l.includes("/", l.indexOf("/") + 1)) return 2;
  if (l.startsWith("docs/") || l.includes("/docs/")) return 3;
  if (/(^|\/)readme/.test(l)) return 4;
  return 5;
}

async function gitFiles(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await run("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.split("\0").filter(Boolean);
  } catch { return undefined; }
}

function walk(root: string, dir: string, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 50_000) return;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) walk(root, p, out, depth + 1); }
    else if (e.isFile()) out.push(relative(root, p));
  }
}

function isBinary(abs: string): boolean {
  const fd = openSync(abs, "r");
  try { const b = Buffer.alloc(2048); const n = readSync(fd, b, 0, 2048, 0); return b.subarray(0, n).includes(0); } finally { closeSync(fd); }
}

/**
 * Descobre arquivos de documentação respeitando .gitignore (via git) ou uma lista de pastas ignoradas.
 * Nunca segue symlinks, nunca lê arquivos de segredo, nem binários/enormes; limites duros de quantidade e bytes.
 */
export async function scanSource(input: string, opts: Partial<ScanOptions> = {}): Promise<ScanResult> {
  const o = { ...DEFAULT_SCAN, ...opts };
  const root = resolve(input);
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const st = lstatSync(root);
  const single = st.isFile();
  const base = single ? resolve(root, "..") : root;
  let rels: string[];
  if (single) rels = [basename(root)];
  else rels = ((await gitFiles(root)) ?? (() => { const l: string[] = []; walk(root, root, l); return l; })()).slice(0, 50_000);
  const realBase = realpathSync(base);

  const cand: ScannedFile[] = [];
  for (const rel of rels) {
    const parts = rel.split("/");
    if (parts.some((p) => IGNORE_DIRS.has(p))) { skip("pasta ignorada"); continue; }
    if (!DOC_EXT.test(rel)) continue;
    if (SKIP_NAMES.test(basename(rel))) { skip("changelog/licença"); continue; }
    if (SECRET_NAMES.test(rel)) { skip("possível segredo"); continue; }
    if (/\.txt$/i.test(rel) && !/(^|\/)(docs?|adr|decisions?)\//i.test(rel)) { skip(".txt fora de docs/"); continue; }
    const abs = join(base, rel);
    let s; try { s = lstatSync(abs); } catch { continue; }
    if (s.isSymbolicLink() || !s.isFile()) { skip("symlink"); continue; }
    try { const rp = realpathSync(abs); if (rp !== realBase && !rp.startsWith(realBase + "/")) { skip("symlink"); continue; } } catch { continue; }
    if (s.size > o.maxFileBytes) { skip("arquivo grande"); continue; }
    if (s.size === 0) continue;
    try { if (isBinary(abs)) { skip("binário"); continue; } } catch { continue; }
    cand.push({ rel, abs, size: s.size });
  }
  cand.sort((a, b) => priority(a.rel) - priority(b.rel) || a.rel.localeCompare(b.rel));
  const files: ScannedFile[] = []; let total = 0;
  for (const f of cand) {
    if (files.length >= o.maxFiles) { skip("limite de arquivos"); continue; }
    if (total + f.size > o.maxTotalBytes) { skip("limite de bytes"); continue; }
    files.push(f); total += f.size;
  }
  let repoName = basename(single ? resolve(root, "..") : root);
  let git: ScanResult["git"];
  try {
    const top = (await run("git", ["-C", base, "rev-parse", "--show-toplevel"])).stdout.trim();
    repoName = basename(top);
    const head = (await run("git", ["-C", base, "rev-parse", "--short", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
    git = { head: head || undefined };
  } catch { /* não é repositório */ }
  return { root: base, repoName, files, skipped, git };
}

/** Relê com teto de bytes: o arquivo pode ter crescido depois do scan. */
export function readDoc(f: ScannedFile): string { return readFileSync(f.abs, "utf8").slice(0, 400_000); }
