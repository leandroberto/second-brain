import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Repositório git sintético com datas controladas (para testar atualidade/histórico sem depender de repositório real). */
export interface Step { date: string; msg: string; files?: Record<string, string | null>; revert?: number }

const made: string[] = [];
export function gitRepo(steps: Step[], name = "proj"): { root: string; shas: string[] } {
  const base = mkdtempSync(join(tmpdir(), "brain-fresh-")); made.push(base);
  const root = join(base, name); mkdirSync(root, { recursive: true });
  const git = (args: string[], date?: string) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", root, ...args], { env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  git(["init", "-q", "-b", "main"]);
  const shas: string[] = [];
  for (const s of steps) {
    if (s.revert !== undefined) git(["revert", "--no-edit", shas[s.revert]!], s.date);
    else {
      for (const [p, c] of Object.entries(s.files ?? {})) {
        const abs = join(root, p);
        if (c === null) rmSync(abs, { force: true });
        else { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, c); }
      }
      git(["add", "-A"]); git(["commit", "-q", "--allow-empty", "-m", s.msg], s.date);
    }
    shas.push(git(["rev-parse", "HEAD"]));
  }
  return { root, shas };
}
export const cleanupRepos = () => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); };
