import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrainError } from "@brain/shared";
import { Brain, VaultGit, bundleHistory } from "../src/index.js";
import { cleanup, human, tempBrain } from "./helpers.js";

const tmps: string[] = [];
const saved = process.env.BRAIN_STATE_DIR;
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "brain-bkp-")); tmps.push(d); return d; };
afterEach(() => {
  if (saved === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = saved;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  cleanup();
});

const externalBrain = async () => {
  process.env.BRAIN_STATE_DIR = join(tmp(), "state");
  const vault = join(tmp(), "vault");
  mkdirSync(join(vault, ".brain"), { recursive: true });
  writeFileSync(join(vault, ".brain", "config.yaml"), "state:\n  external: true\n");
  return Brain.init(vault);
};
const commits = (bundle: string) => {
  const dir = join(tmp(), "clone");
  execFileSync("git", ["clone", "-q", bundle, dir]);
  return execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" }).split("\n").filter(Boolean).length;
};

for (const [nome, make] of [["vault comum", tempBrain], ["estado externo", externalBrain]] as const) {
  describe(`backup do histórico (${nome})`, () => {
    it("bundle restaura o histórico", async () => {
      const b = await make();
      await b.createNote({ title: "Nota um", type: "fact", body: "conteúdo fictício um" }, human);
      await b.createNote({ title: "Nota dois", type: "fact", body: "conteúdo fictício dois" }, human);
      const r = await bundleHistory(b);
      expect(r.skipped).toBe(false);
      expect(r.path).toBe(join(b.vault.root, ".brain", "backup", "history.bundle"));
      expect(existsSync(r.path)).toBe(true);
      expect(commits(r.path)).toBeGreaterThanOrEqual(2);
      b.close();
    });

    it("segundo bundle sem commit novo é pulado", async () => {
      const b = await make();
      await b.createNote({ title: "Nota um", type: "fact", body: "conteúdo fictício um" }, human);
      expect((await bundleHistory(b)).skipped).toBe(false);
      expect((await bundleHistory(b)).skipped).toBe(true);
      await b.createNote({ title: "Nota três", type: "fact", body: "conteúdo fictício três" }, human);
      expect((await bundleHistory(b)).skipped).toBe(false);
      b.close();
    });

    it("bundle apagado é refeito mesmo com o HEAD igual", async () => {
      const b = await make();
      await b.createNote({ title: "Nota um", type: "fact", body: "conteúdo fictício um" }, human);
      const r = await bundleHistory(b);
      unlinkSync(r.path);
      const again = await bundleHistory(b);
      expect(again.skipped).toBe(false);
      expect(existsSync(again.path)).toBe(true);
      b.close();
    });

    it(".brain/backup/ nunca entra no histórico", async () => {
      const b = await make();
      await b.createNote({ title: "Nota um", type: "fact", body: "conteúdo fictício um" }, human);
      await bundleHistory(b);
      await b.createNote({ title: "Nota dois", type: "fact", body: "conteúdo fictício dois" }, human);
      const gd = b.vault.gitDir;
      const git = (...a: string[]) => execFileSync("git", [...(gd ? [`--git-dir=${gd}`, `--work-tree=${b.vault.root}`] : ["-C", b.vault.root]), ...a], { encoding: "utf8", cwd: b.vault.root });
      expect(git("ls-files")).not.toContain(".brain/backup/");
      expect(git("log", "--all", "--name-only", "--format=")).not.toContain(".brain/backup/");
      expect(git("status", "--porcelain", "-uall")).not.toContain(".brain/backup/");
      b.close();
    });

  });
}

describe("backup do histórico: erro real de git", () => {
  it("repositório sem commits é pulado (não é erro)", async () => {
    const b = await tempBrain();
    const root = join(tmp(), "vazio");
    mkdirSync(root);
    const git = new VaultGit(root);
    await git.init();
    const empty = { vault: { root }, db: b.db, git } as unknown as Brain;
    expect((await bundleHistory(empty)).skipped).toBe(true);
    expect(existsSync(join(root, ".brain", "backup", "history.bundle"))).toBe(false);
    b.close();
  });

  it("git-dir inválido lança BrainError em vez de pular", async () => {
    const b = await tempBrain();
    await b.createNote({ title: "Nota um", type: "fact", body: "conteúdo fictício um" }, human);
    const broken = { vault: b.vault, db: b.db, git: new VaultGit(b.vault.root, undefined, join(tmp(), "inexistente")) } as unknown as Brain;
    await expect(bundleHistory(broken)).rejects.toBeInstanceOf(BrainError);
    b.close();
  });
});
