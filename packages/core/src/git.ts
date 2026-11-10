import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrainError } from "@brain/shared";

const run = promisify(execFile);

export class VaultGit {
  constructor(private root: string, private identity = { name: "Second Brain", email: "brain@localhost" }) {}

  private async git(args: string[], allowFail = false): Promise<string> {
    try {
      const { stdout } = await run("git", ["-C", this.root, ...args], { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" } });
      return stdout;
    } catch (e) {
      if (allowFail) return "";
      throw new BrainError("git_error", `git ${args[0]} falhou: ${((e as { stderr?: string }).stderr ?? (e as Error).message).trim()}`);
    }
  }

  async isRepo(): Promise<boolean> {
    return (await this.git(["rev-parse", "--is-inside-work-tree"], true)).trim() === "true";
  }
  async init(): Promise<void> { await this.git(["init", "-q", "-b", "main"]); }

  /** Caminhos sujos (modificados ou não rastreados) dentro de `prefix`. */
  async dirty(prefix = "knowledge"): Promise<string[]> {
    const out = await this.git(["status", "--porcelain", "--no-renames", "-uall", "-z", "--", prefix], true);
    return out.split("\0").filter(Boolean).map((l) => l.slice(3));
  }

  /** Commit apenas dos caminhos informados (nunca pega alterações alheias já staged). */
  async commitPaths(paths: string[], message: string, author?: { name: string; email?: string }): Promise<string | undefined> {
    if (!paths.length) return undefined;
    await this.git(["add", "-A", "--", ...paths]);
    const staged = await this.git(["diff", "--cached", "--name-only", "--", ...paths]);
    if (!staged.trim()) return undefined;
    const id = this.identity;
    const a = author ? `${author.name} <${author.email ?? "agent@localhost"}>` : undefined;
    await this.git([
      "-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`,
      "commit", "-q", "--no-verify", ...(a ? ["--author", a] : []), "-m", message, "--only", "--", ...paths,
    ]);
    return (await this.git(["rev-parse", "--short", "HEAD"])).trim();
  }

  async log(path: string | undefined, limit = 20): Promise<Array<{ hash: string; date: string; author: string; subject: string }>> {
    const args = ["log", `-n${limit}`, "--format=%h%x1f%aI%x1f%an%x1f%s", ...(path ? ["--", path] : [])];
    const out = await this.git(args, true);
    return out.split("\n").filter(Boolean).map((l) => {
      const [hash = "", date = "", author = "", subject = ""] = l.split("\x1f");
      return { hash, date, author, subject };
    });
  }

  async fileAt(rev: string, path: string): Promise<string | undefined> {
    const o = await this.git(["show", `${rev}:${path}`], true);
    return o || undefined;
  }

  /** Reverte um commit (rollback seguro, preserva histórico). `rev` é validado e resolvido para um hash de commit. */
  async revert(rev: string): Promise<string> {
    if (!/^[0-9a-f]{4,40}$/i.test(rev)) throw new BrainError("invalid", "revisão inválida (use o hash do commit)");
    rev = (await this.git(["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`])).trim();
    const id = this.identity;
    await this.git(["-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`, "revert", "--no-edit", rev]);
    return (await this.git(["rev-parse", "--short", "HEAD"])).trim();
  }

  async head(): Promise<string | undefined> {
    return (await this.git(["rev-parse", "--short", "HEAD"], true)).trim() || undefined;
  }
}
