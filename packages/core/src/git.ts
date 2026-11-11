import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrainError } from "@brain/shared";

const run = promisify(execFile);

export class VaultGit {
  constructor(private root: string, private identity = { name: "Second Brain", email: "brain@localhost" }, private gitDir?: string) {}

  private async git(args: string[], allowFail = false): Promise<string> {
    try {
      const { stdout } = await run("git", [...(this.gitDir ? [`--git-dir=${this.gitDir}`, `--work-tree=${this.root}`] : ["-C", this.root]), ...args], { cwd: this.gitDir ? this.root : undefined, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" } });
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

  /**
   * Commits alcançáveis a partir de HEAD gravados pelo `author` (nome exato, `%an`) e em que, para ALGUM dos pares
   * `[key, value]`, o PRIMEIRO trailer `key:` do bloco final (último parágrafo da mensagem) vale exatamente `value`. Um só
   * `git log`, do mais novo para o mais antigo, com o hash completo. O `--grep` é só o filtro grosso (substring): texto livre
   * (título, nota) que caia na mensagem não basta para casar, porque o autor vem do principal cunhado e o trailer verdadeiro
   * vem antes de qualquer texto livre no bloco final.
   */
  async commitsByTrailer(trailers: Array<[key: string, value: string]>, author: string): Promise<string[]> {
    if (!trailers.length || [author, ...trailers.flat()].some((s) => !s || ["\r", "\n", "\x1e", "\x1f"].some((c) => s.includes(c)))) throw new BrainError("invalid", "busca de trailer inválida");
    const out = await this.git(["log", "--fixed-strings", ...trailers.map(([k, v]) => `--grep=${k}: ${v}`), "--format=%H%x1f%an%x1f%B%x1e"]);
    return out.split("\x1e").flatMap((rec) => {
      const [hash = "", an = "", body = ""] = rec.replace(/^\s+/, "").split("\x1f");
      if (!hash || an !== author) return [];
      const last = (body.replace(/\r\n/g, "\n").trim().split(/\n[ \t]*\n/).pop() ?? "").split("\n");
      const hit = trailers.some(([key, value]) => last.find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim() === value);
      return hit ? [hash.trim()] : [];
    });
  }

  /**
   * Reverte os commits na ordem dada como UMA operação do git (sequência de `git revert`). Se algum falhar (ex.: conflito porque
   * o arquivo mudou depois), `git revert --abort` volta ao estado de antes da sequência — inclusive os reverts que já tinham
   * passado — e lança `git_error` com os caminhos em conflito em `details.conflicted`.
   */
  async revertAll(revs: string[]): Promise<void> {
    if (!revs.length) return;
    if (revs.some((r) => !/^[0-9a-f]{40}$/.test(r))) throw new BrainError("invalid", "revisão inválida (use o hash completo do commit)");
    const id = this.identity;
    try {
      await this.git(["-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`, "revert", "--no-edit", ...revs]);
    } catch (e) {
      const conflicted = (await this.git(["diff", "--name-only", "--diff-filter=U", "-z"], true)).split("\0").filter(Boolean);
      await this.git(["revert", "--abort"], true);
      throw new BrainError("git_error", (e as Error).message, { conflicted });
    }
  }

  /** Grava um bundle com todo o histórico em `dest` (funciona com ou sem git-dir externo). */
  async bundle(dest: string): Promise<void> { await this.git(["bundle", "create", "-q", dest, "--all"]); }

  async head(): Promise<string | undefined> {
    return (await this.git(["rev-parse", "--short", "HEAD"], true)).trim() || undefined;
  }
}
