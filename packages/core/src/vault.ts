import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Note, NoteType } from "@brain/shared";
import { safeResolve, toPosix } from "./paths.js";
import { dumpConfig, ConfigSchema } from "./config.js";

export const TYPE_DIR: Record<NoteType, string> = {
  decision: "decisions", learning: "learnings", fact: "facts", preference: "preferences",
  pattern: "patterns", reference: "references", project: "projects", concept: "concepts",
  "open-question": "open-questions",
};

export class Vault {
  readonly knowledgeDir: string;
  constructor(readonly root: string) { this.knowledgeDir = join(root, "knowledge"); }

  get configPath() { return join(this.root, ".brain", "config.yaml"); }
  get dbPath() { return join(this.root, ".brain", "index.db"); }
  get lockPath() { return join(this.root, ".brain", "lock.d"); }
  get pendingDir() { return join(this.root, ".brain", "proposals", "pending"); }
  get decidedDir() { return join(this.root, ".brain", "proposals", "decided"); }

  exists(): boolean { return existsSync(this.configPath) && existsSync(this.knowledgeDir); }

  /** Caminho relativo canônico de uma nota. Nome do arquivo == id (links [[id]] funcionam no Obsidian). */
  pathFor(n: Pick<Note, "id" | "type" | "project" | "status">): string {
    if (n.status === "archived") return `knowledge/archive/${n.id}.md`;
    if (n.status === "proposed") return `knowledge/inbox/${n.id}.md`;
    if (n.project) return `knowledge/projects/${n.project}/${n.id}.md`;
    return `knowledge/${TYPE_DIR[n.type]}/${n.id}.md`;
  }

  listFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(toPosix(p.slice(this.root.length + 1)));
      }
    };
    if (existsSync(this.knowledgeDir)) walk(this.knowledgeDir);
    return out.sort();
  }

  stat(rel: string) { const s = statSync(safeResolve(this.root, rel)); return { mtime: s.mtimeMs, size: s.size }; }
  readRaw(rel: string): string { return readFileSync(safeResolve(this.root, rel), "utf8"); }
  fileExists(rel: string): boolean { try { return existsSync(safeResolve(this.root, rel)); } catch { return false; } }

  /** Escrita atômica (tmp + rename) — nunca deixa arquivo parcial. */
  writeAtomic(rel: string, content: string): void {
    const abs = safeResolve(this.root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, abs);
  }
  move(from: string, to: string): void {
    const a = safeResolve(this.root, from); const b = safeResolve(this.root, to);
    mkdirSync(dirname(b), { recursive: true });
    renameSync(a, b);
  }
  remove(rel: string): void { rmSync(safeResolve(this.root, rel), { force: true }); }

  ensureDirs(): void {
    for (const d of ["knowledge/inbox", "knowledge/projects", "knowledge/decisions", "knowledge/learnings", "knowledge/patterns",
      "knowledge/references", "knowledge/concepts", "knowledge/archive", ".brain/proposals/pending", ".brain/proposals/decided"]) {
      mkdirSync(join(this.root, d), { recursive: true });
    }
  }
  writeDefaultConfig(): void {
    if (!existsSync(this.configPath)) writeFileSync(this.configPath, dumpConfig(ConfigSchema.parse({})), "utf8");
  }
}
