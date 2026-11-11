import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Brain, coreDoctor } from "../src/index.js";
import { cleanup, human, tempBrain } from "./helpers.js";

const tmps: string[] = [];
const saved = { dir: process.env.BRAIN_STATE_DIR, home: process.env.HOME };
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "brain-ext-")); tmps.push(d); return d; };
const externalVault = (name?: string) => {
  const vault = join(tmp(), "vault");
  mkdirSync(join(vault, ".brain"), { recursive: true });
  writeFileSync(join(vault, ".brain", "config.yaml"), `${name ? `vault_name: ${name}\n` : ""}state:\n  external: true\n`);
  return vault;
};
const restore = (k: "BRAIN_STATE_DIR" | "HOME", v?: string) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
afterEach(() => {
  restore("BRAIN_STATE_DIR", saved.dir); restore("HOME", saved.home);
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  cleanup();
});

describe("estado externo ao vault", () => {
  it("init em vault external não cria .git nem index.db no vault", async () => {
    const state = join(tmp(), "state"); process.env.BRAIN_STATE_DIR = state;
    const vault = externalVault();
    const b = await Brain.init(vault); b.close();
    expect(existsSync(join(vault, ".git"))).toBe(false);
    expect(existsSync(join(vault, ".brain", "index.db"))).toBe(false);
    expect(existsSync(join(vault, ".brain", "api-token"))).toBe(false);
    expect(existsSync(join(vault, ".brain", "lock.d"))).toBe(false);
    expect(existsSync(join(state, "git", "HEAD"))).toBe(true);
    expect(existsSync(join(state, "index.db"))).toBe(true);
  });

  it("commit grava no git-dir externo", async () => {
    process.env.BRAIN_STATE_DIR = join(tmp(), "state");
    const vault = externalVault();
    const b = await Brain.init(vault);
    await b.createNote({ title: "Nota externa", type: "fact", body: "conteúdo fictício" }, human);
    expect((await b.git.log(undefined, 1))[0]!.subject).not.toBe("");
    expect(existsSync(join(vault, ".git"))).toBe(false);
    b.close();
  });

  it("aceita pasta já existente com arquivos, sem apagar nada", async () => {
    process.env.BRAIN_STATE_DIR = join(tmp(), "state");
    const vault = externalVault();
    writeFileSync(join(vault, "antigo.txt"), "fica");
    const b = await Brain.init(vault); b.close();
    expect(existsSync(join(vault, "antigo.txt"))).toBe(true);
  });

  it("abre vault external sem BRAIN_STATE_DIR usando o padrão", async () => {
    delete process.env.BRAIN_STATE_DIR;
    const home = tmp(); process.env.HOME = home;
    const vault = externalVault("Cérebro Ação 2");
    const b = await Brain.init(vault); b.close();
    expect(existsSync(join(home, ".local", "state", "second-brain", "cerebro-acao-2", "index.db"))).toBe(true);
    const again = await Brain.open(vault); again.close();
  });

  it("recusa quando o diretório de estado não é gravável", async () => {
    const file = join(tmp(), "arquivo"); writeFileSync(file, "x");
    const vault = externalVault();
    process.env.BRAIN_STATE_DIR = file;
    await expect(Brain.init(vault)).rejects.toMatchObject({ code: "state_unavailable" });
    process.env.BRAIN_STATE_DIR = join(tmp(), "ok");
    (await Brain.init(vault)).close();
    process.env.BRAIN_STATE_DIR = file;
    await expect(Brain.open(vault)).rejects.toMatchObject({ code: "state_unavailable" });
  });

  it("diretório de estado nasce com permissão 0700 e grava vault-path com o realpath do vault", async () => {
    const state = join(tmp(), "estado-novo"); process.env.BRAIN_STATE_DIR = state;
    const vault = externalVault();
    const b = await Brain.init(vault); b.close();
    expect(statSync(state).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(state, "vault-path"), "utf8").trim()).toBe(realpathSync(vault));
    (await Brain.open(vault)).close(); // o mesmo vault reabre normalmente
  });

  it("o mesmo diretório de estado para dois vaults diferentes é recusado", async () => {
    const state = join(tmp(), "estado-dividido"); process.env.BRAIN_STATE_DIR = state;
    const a = externalVault(); const outro = externalVault();
    (await Brain.init(a)).close();
    await expect(Brain.init(outro)).rejects.toMatchObject({ code: "state_unavailable", message: expect.stringMatching(/pertence a outro vault/) });
    await expect(Brain.open(a)).resolves.toBeTruthy();
    expect(existsSync(join(outro, ".git"))).toBe(false);
  });

  it("vault sem state.external continua em .brain", async () => {
    const b = await tempBrain();
    expect(existsSync(join(b.vault.root, ".brain", "index.db"))).toBe(true);
    expect(existsSync(join(b.vault.root, ".git"))).toBe(true);
    expect(b.vault.gitDir).toBeUndefined();
    expect(b.vault.tokenPath).toBe(join(b.vault.root, ".brain", "api-token"));
    b.close();
  });

  it(".gitignore inclui .brain/backup/", async () => {
    const b = await tempBrain();
    expect(await import("node:fs").then((f) => f.readFileSync(join(b.vault.root, ".gitignore"), "utf8"))).toContain(".brain/backup/");
    b.close();
  });

  it("doctor acusa .git dentro de vault external", async () => {
    process.env.BRAIN_STATE_DIR = join(tmp(), "state");
    const vault = externalVault();
    const b = await Brain.init(vault);
    expect((await coreDoctor(b)).find((c) => c.id === "external-state")?.status).toBe("ok");
    mkdirSync(join(vault, ".git"));
    const c = (await coreDoctor(b)).find((x) => x.id === "external-state");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain(".git");
    b.close();
  });
});

describe("cópias de conflito do OneDrive em Saúde", () => {
  const fato = (id: string, palavra: string) => `---\nid: ${id}\ntitle: ${id}\ntype: fact\n---\ncorpo ${palavra}\n`;
  const escreve = async (arquivos: Record<string, string>) => {
    const b = await tempBrain();
    const dir = join(b.vault.root, "knowledge/facts");
    mkdirSync(dir, { recursive: true });
    for (const [nome, conteudo] of Object.entries(arquivos)) writeFileSync(join(dir, nome), conteudo);
    await b.sync();
    return b;
  };

  it("cópia de conflito do OneDrive aparece em health.problems", async () => {
    const b = await escreve({ "fato-x.md": fato("fato-x", "palavraoriginal"), "fato-x-NOTEBOOK01.md": fato("fato-x-notebook01", "palavracopia") });
    const h = await b.health();
    const achados = h.details.sync_conflict_copies;
    expect(h.problems.sync_conflict_copies).toBe(1);
    expect(achados.some((p) => p.kind === "sync_conflict_copy" && p.path.endsWith("fato-x-NOTEBOOK01.md") && p.original.endsWith("fato-x.md"))).toBe(true);
    expect(achados[0]?.message).toBe(`cópia de conflito do OneDrive: junte em ${achados[0]?.original} (proponha um complemento)`);
    expect((await b.search("palavraoriginal")).length).toBe(1);
    expect((await b.search("palavracopia")).length).toBe(1);
    b.close();
  });

  it("sufixo numérico de colisão de id e arquivo sem original não são acusados", async () => {
    const b = await escreve({ "fato-x.md": fato("fato-x", "a"), "fato-x-2.md": fato("fato-x-2", "b"), "fato-x-123.md": fato("fato-x-123", "c"), "orfao-NOTEBOOK01.md": fato("orfao-notebook01", "d") });
    const h = await b.health();
    expect(h.problems.sync_conflict_copies).toBe(0);
    expect(h.details.sync_conflict_copies).toEqual([]);
    b.close();
  });

  it("id que estende outro id não é cópia de conflito", async () => {
    const b = await tempBrain();
    await b.createNote({ title: "Timeout do lote", type: "fact", body: "O lote tem timeout configurável no agendador." }, human);
    await b.createNote({ title: "Timeout do lote noturno", type: "fact", body: "O lote noturno usa outro agendador, com janela própria." }, human);
    const h = await b.health();
    expect(h.details.sync_conflict_copies).toEqual([]);
    expect((await b.dashboard()).health.ok).toBe(true);
    b.close();
  });

  it("cópia real (mesmo id no frontmatter, sufixo minúsculo) e cópia com sufixo de máquina em maiúscula são acusadas", async () => {
    const b = await escreve({
      "fato-y.md": fato("fato-y", "a"), "fato-y-notebook.md": fato("fato-y", "b"),
      "fato-z.md": fato("fato-z", "c"), "fato-z-DESKTOP-ABC12.md": fato("fato-z-outro", "d"),
      // nome que é o próprio id (minúsculo, id diferente do original): nota legítima
      "fato-z-extra.md": fato("fato-z-extra", "e"),
    });
    const h = await b.health();
    expect(h.details.sync_conflict_copies.map((c) => [c.path.slice(c.path.lastIndexOf("/") + 1), c.original.slice(c.original.lastIndexOf("/") + 1)]).sort())
      .toEqual([["fato-y-notebook.md", "fato-y.md"], ["fato-z-DESKTOP-ABC12.md", "fato-z.md"]]);
    b.close();
  });
});
