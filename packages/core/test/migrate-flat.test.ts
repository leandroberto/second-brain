import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Brain, migrateFlat, parseNote } from "../src/index.js";
import { claude, cleanup, dirs, human, tempBrain } from "./helpers.js";

afterAll(cleanup);

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "flat-vault");

function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(root, p).split("\\").join("/")] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(root);
  return out;
}
/** cópia da fixture num diretório temporário (o apply move os originais) */
function copyFixture(): string {
  const d = mkdtempSync(join(tmpdir(), "brain-flat-")); dirs.push(d);
  const dst = join(d, "antigo");
  cpSync(FIXTURE, dst, { recursive: true });
  return dst;
}
const FM = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const origBody = (rel: string) => { const raw = readFileSync(join(FIXTURE, rel), "utf8"); return raw.slice(FM.exec(raw)![0].length); };
const stripSee = (body: string) => body.replace(/^## Ver também[\s\S]*?(?=^## |(?![\s\S]))/m, "");

describe("brain migrate-flat", () => {
  it("dry-run não altera nada", async () => {
    const b = await tempBrain();
    const before = hashTree(FIXTURE);
    const vaultBefore = hashTree(b.vault.root);
    const plan = await migrateFlat(b, FIXTURE, human, { apply: false });
    expect(hashTree(FIXTURE)).toEqual(before);
    expect(hashTree(b.vault.root)).toEqual(vaultBefore);
    expect(plan.items.length).toBe(3);
    expect(plan.commit).toBeUndefined();
    const byId = Object.fromEntries(plan.items.map((i) => [i.id, i]));
    expect(byId["regra-x"]).toMatchObject({ type: "fact", inferred: true, from: "regras-de-negocio/regra-x.md", tags: ["financeiro", "desconto", "regras-de-negocio"] });
    expect(byId["modulo-y"]).toMatchObject({ type: "concept", project: "sisa", to: "knowledge/projects/sisa/modulo-y.md" });
    expect(byId["config-z"]).toMatchObject({ type: "learning" });
    expect(plan.captures).toEqual(["_entrada/2026-11.md"]);
    expect(plan.discarded).toEqual([".desfazer/a.json"]);
  });

  it("typeOverrides vence a inferência", async () => {
    const b = await tempBrain();
    const plan = await migrateFlat(b, FIXTURE, human, { apply: false, typeOverrides: { "regra-x": "decision" } });
    const it0 = plan.items.find((i) => i.id === "regra-x")!;
    expect(it0.type).toBe("decision"); expect(it0.inferred).toBe(false);
  });

  it("apply exige o revisor humano", async () => {
    const b = await tempBrain();
    await expect(migrateFlat(b, copyFixture(), claude, { apply: true })).rejects.toThrow(/humano|revisor/);
  });

  it("apply preserva o corpo fora dos links", async () => {
    const b = await tempBrain();
    const plan = await migrateFlat(b, copyFixture(), human, { apply: true });
    expect(plan.items.length).toBe(3);
    for (const it of plan.items) {
      const migrated = parseNote(readFileSync(join(b.vault.root, it.to), "utf8"), it.to, new Date().toISOString());
      expect(migrated.issues).toEqual([]);
      expect(stripSee(migrated.note.body)).toBe(stripSee(origBody(it.from)));
    }
  });

  it("preserva o Histórico, inclusive links dentro dele", async () => {
    const b = await tempBrain();
    await migrateFlat(b, copyFixture(), human, { apply: true });
    const body = b.loadNote("config-z").body;
    expect(body).toContain("ver [Módulo de cálculo](../sistemas/sisA/modulo-y.md).");
  });

  it("Ver também vira wikilink", async () => {
    const b = await tempBrain();
    await migrateFlat(b, copyFixture(), human, { apply: true });
    const x = b.loadNote("regra-x").body;
    expect(x).toContain("[[modulo-y]]");
    expect(x).toContain("[[config-z]]");
    expect(x).toContain("[Documento externo](https://exemplo.invalid/doc.md)");
    expect(x).not.toContain("../sistemas");
    // alvo inexistente: o link original é mantido
    expect(b.loadNote("modulo-y").body).toContain("[outra nota do mesmo sistema](modulo-w.md)");
    expect(b.loadNote("modulo-y").body).toContain("[[regra-x]]");
  });

  it("sistemas vira project", async () => {
    const b = await tempBrain();
    await migrateFlat(b, copyFixture(), human, { apply: true });
    const y = b.loadNote("modulo-y");
    expect(y.project).toBe("sisa");
    expect(y.path).toBe("knowledge/projects/sisa/modulo-y.md");
    expect(y.created_by).toEqual({ kind: "human", name: human.name });
    expect(y.source).toEqual({ type: "manual" });
    expect(y.created_at).toBe("2026-10-02T00:00:00.000Z");
    expect(y.updated_at).toBe("2026-10-20T00:00:00.000Z");
    expect(b.loadNote("config-z").tags).toEqual(["ambiente", "homologacao"]);
  });

  it("um único commit", async () => {
    const b = await tempBrain();
    const before = (await b.git.log(undefined, 50)).length;
    const plan = await migrateFlat(b, copyFixture(), human, { apply: true });
    const log = await b.git.log(undefined, 50);
    expect(log.length).toBe(before + 1);
    expect(log[0]!.subject).toBe("migração do SB do trabalho");
    expect(plan.commit).toBeTruthy();
  });

  it("originais em _legado e _entrada em captures", async () => {
    const b = await tempBrain();
    const src = copyFixture();
    const orig = readFileSync(join(src, "regras-de-negocio/regra-x.md"));
    const obsidian = hashTree(join(src, ".obsidian"));
    const plan = await migrateFlat(b, src, human, { apply: true });
    const r = b.vault.root;
    expect(readFileSync(join(r, "_legado/regras-de-negocio/regra-x.md")).equals(orig)).toBe(true);
    expect(existsSync(join(r, "_legado/sistemas/sisA/modulo-y.md"))).toBe(true);
    expect(existsSync(join(r, "_legado/ambiente/config-z.md"))).toBe(true);
    expect(readFileSync(join(r, ".brain/captures/2026-11.md"), "utf8")).toContain("20261106-154437-a1b2");
    expect(plan.captures).toEqual(["_entrada/2026-11.md"]);
    // originais saem da origem; .desfazer é descartado; .obsidian não é tocado
    expect(existsSync(join(src, "regras-de-negocio/regra-x.md"))).toBe(false);
    expect(existsSync(join(src, "_entrada/2026-11.md"))).toBe(false);
    expect(existsSync(join(src, ".desfazer"))).toBe(false);
    expect(hashTree(join(src, ".obsidian"))).toEqual(obsidian);
    expect(statSync(join(r, ".obsidian/app.json")).isFile()).toBe(true);
    expect(existsSync(join(r, ".desfazer"))).toBe(false);
  });

  it("colisão de id ganha -2 e a nota entra no índice", async () => {
    const b = await tempBrain();
    const src = copyFixture();
    mkdirSync(join(src, "processos")); cpSync(join(src, "ambiente/config-z.md"), join(src, "processos/Config Z.md"), { recursive: true });
    const plan = await migrateFlat(b, src, human, { apply: true });
    expect(plan.items.map((i) => i.id).sort()).toEqual(["config-z", "config-z-2", "modulo-y", "regra-x"]);
    expect(plan.items.find((i) => i.id === "config-z-2")!.type).toBe("pattern");
    await b.reindex();
    expect(b.loadNote("config-z-2").title).toContain("homologação");
  });

  /** uso real: a pasta antiga JÁ é o vault (init aceita pasta existente sem apagar nada) */
  async function inPlaceBrain(): Promise<{ b: Brain; dir: string }> {
    const dir = copyFixture();
    const b = await Brain.init(dir);
    return { b, dir };
  }

  it("no lugar (srcDir === vault.root): preserva o corpo, move para _legado, não toca .obsidian/.brain/config, um commit", async () => {
    const { b, dir } = await inPlaceBrain();
    const obsidian = hashTree(join(dir, ".obsidian"));
    const cfg = readFileSync(join(dir, ".brain/config.yaml"), "utf8");
    const origs = Object.fromEntries(["regras-de-negocio/regra-x.md", "sistemas/sisA/modulo-y.md", "ambiente/config-z.md"].map((r) => [r, readFileSync(join(dir, r))]));
    const before = (await b.git.log(undefined, 50)).length;
    const plan = await migrateFlat(b, dir, human, { apply: true });
    expect(plan.items.map((i) => i.id).sort()).toEqual(["config-z", "modulo-y", "regra-x"]); // AGENTS/README/knowledge etc. não entram
    for (const it of plan.items) {
      const migrated = parseNote(readFileSync(join(dir, it.to), "utf8"), it.to, new Date().toISOString());
      expect(stripSee(migrated.note.body)).toBe(stripSee(origBody(it.from)));
    }
    for (const [r, buf] of Object.entries(origs)) {
      expect(readFileSync(join(dir, "_legado", r)).equals(buf)).toBe(true);
      expect(existsSync(join(dir, r))).toBe(false);
    }
    expect(existsSync(join(dir, ".desfazer"))).toBe(false);
    expect(existsSync(join(dir, "_entrada"))).toBe(false);
    expect(readFileSync(join(dir, ".brain/captures/2026-11.md"), "utf8")).toContain("20261106-154437-a1b2");
    expect(hashTree(join(dir, ".obsidian"))).toEqual(obsidian);
    expect(readFileSync(join(dir, ".brain/config.yaml"), "utf8")).toBe(cfg);
    const log = await b.git.log(undefined, 50);
    expect(log.length).toBe(before + 1);
    expect(log[0]!.subject).toBe("migração do SB do trabalho");
    expect(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
    const inCommit = execFileSync("git", ["-C", dir, "show", "--name-status", "--format=", "HEAD"], { encoding: "utf8" });
    expect(inCommit).toContain("_legado/regras-de-negocio/regra-x.md");
    expect(inCommit).toMatch(/(D|R\d+)\s+regras-de-negocio\/regra-x\.md/);
    expect(inCommit).toContain(".brain/captures/2026-11.md");
  });

  it("no lugar: git revert do commit restaura a pasta antiga (o init a rastreou)", async () => {
    const { b, dir } = await inPlaceBrain();
    const orig = readFileSync(join(dir, "regras-de-negocio/regra-x.md"));
    await migrateFlat(b, dir, human, { apply: true });
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "revert", "--no-edit", "HEAD"], { encoding: "utf8" });
    expect(readFileSync(join(dir, "regras-de-negocio/regra-x.md")).equals(orig)).toBe(true);
    expect(existsSync(join(dir, "knowledge/facts/regra-x.md"))).toBe(false);
  });

  it("no lugar: segunda execução é inofensiva (nada a migrar, sem commit)", async () => {
    const { b, dir } = await inPlaceBrain();
    await migrateFlat(b, dir, human, { apply: true });
    const log1 = await b.git.log(undefined, 50);
    const again = await migrateFlat(b, dir, human, { apply: true });
    expect(again.items.length).toBe(0);
    expect(again.captures).toEqual([]); expect(again.discarded).toEqual([]);
    expect(again.commit).toBeUndefined();
    expect((await b.git.log(undefined, 50)).length).toBe(log1.length);
  });

  it("origem dentro do vault que não é a raiz é recusada", async () => {
    const { b, dir } = await inPlaceBrain();
    await expect(migrateFlat(b, join(dir, "knowledge"), human, { apply: false })).rejects.toThrow(/raiz do vault/);
  });

  /** pasta de origem temporária só com os arquivos informados */
  function srcWith(files: Record<string, string | Buffer>): string {
    const d = mkdtempSync(join(tmpdir(), "brain-flat-")); dirs.push(d);
    const dst = join(d, "antigo");
    for (const [rel, content] of Object.entries(files)) { mkdirSync(dirname(join(dst, rel)), { recursive: true }); writeFileSync(join(dst, rel), content); }
    return dst;
  }

  it("nota com BOM e cabeçalho válido migra título, tags e datas; corpo igual ao original sem o cabeçalho", async () => {
    const body = "# Nota com BOM\n\nTexto da nota.\n";
    const b = await tempBrain();
    const src = srcWith({ "ambiente/com-bom.md": `\uFEFF---\ntitulo: Título com BOM\ntags: [um, dois]\ncriado: 2026-08-01\natualizado: 2026-08-02\n---\n${body}` });
    await migrateFlat(b, src, human, { apply: true });
    const n = b.loadNote("com-bom");
    expect(n.title).toBe("Título com BOM");
    expect(n.tags).toEqual(["um", "dois", "ambiente"]);
    expect(n.created_at).toBe("2026-08-01T00:00:00.000Z");
    expect(n.updated_at).toBe("2026-08-02T00:00:00.000Z");
    expect(n.body).toBe(body);
  });

  it("nota sem cabeçalho (texto puro) e nota que começa com régua horizontal preservam o corpo inteiro", async () => {
    const puro = "# Só texto\n\nSem cabeçalho nenhum.\n";
    const regua = "---\ntexto entre réguas\n---\nmais texto\n";
    const b = await tempBrain();
    const src = srcWith({ "processos/texto-puro.md": puro, "processos/com-regua.md": regua });
    await migrateFlat(b, src, human, { apply: true });
    expect(b.loadNote("texto-puro").body).toBe(puro);
    expect(b.loadNote("com-regua").body).toBe(regua);
  });

  it("lote só com _entrada (sem nenhuma nota) migra e commita sem erro", async () => {
    const b = await tempBrain();
    const src = srcWith({ "_entrada/2026-12.md": "### 20261201-100000-aaaa · pendente\n\n~~~~\ntexto\n~~~~\n" });
    const before = (await b.git.log(undefined, 50)).length;
    const plan = await migrateFlat(b, src, human, { apply: true });
    expect(plan.items).toEqual([]);
    expect(plan.commit).toBeTruthy();
    expect((await b.git.log(undefined, 50)).length).toBe(before + 1);
    expect(existsSync(join(b.vault.root, ".brain/captures/2026-12.md"))).toBe(true);
  });

  it("nota com finais de linha CRLF preserva o corpo byte a byte", async () => {
    const body = "# Nota do Windows\r\n\r\nPrimeira linha.\r\nSegunda linha com acentuação.\r\n";
    const original = `---\r\ntitulo: Nota CRLF\r\ntags: [um]\r\n---\r\n${body}`;
    const b = await tempBrain();
    const src = srcWith({ "ambiente/nota-crlf.md": original });
    const plan = await migrateFlat(b, src, human, { apply: true });
    const to = plan.items.find((i) => i.id === "nota-crlf")!.to;
    const gravado = readFileSync(join(b.vault.root, to));
    expect(gravado.subarray(gravado.length - Buffer.byteLength(body)).equals(Buffer.from(body, "utf8"))).toBe(true);
    expect(b.loadNote("nota-crlf").title).toBe("Nota CRLF");
    expect(readFileSync(join(b.vault.root, "_legado/ambiente/nota-crlf.md")).equals(Buffer.from(original, "utf8"))).toBe(true);
  });

  it("commit que falha com estado externo: a recuperação usa --git-dir/--work-tree (não git -C)", async () => {
    const saved = process.env.BRAIN_STATE_DIR;
    const base = mkdtempSync(join(tmpdir(), "brain-flat-ext-")); dirs.push(base);
    const vault = join(base, "vault"); const state = join(base, "estado");
    mkdirSync(join(vault, ".brain"), { recursive: true });
    writeFileSync(join(vault, ".brain", "config.yaml"), "state:\n  external: true\n");
    process.env.BRAIN_STATE_DIR = state;
    try {
      const b = await Brain.init(vault);
      const src = srcWith({ "ambiente/nota-ext.md": "# Nota externa\n\nTexto fictício.\n" });
      vi.spyOn(b.git, "commitPaths").mockRejectedValueOnce(new Error("falha simulada"));
      const err = await migrateFlat(b, src, human, { apply: true }).catch((e: Error) => e);
      expect((err as { code?: string }).code).toBe("git_error");
      const msg = (err as Error).message;
      expect(msg).toContain(`git --git-dir="${join(state, "git")}" --work-tree="${vault}" add -A -- `);
      expect(msg).toContain(`git --git-dir="${join(state, "git")}" --work-tree="${vault}" commit -m "`);
      expect(msg).not.toContain("git -C");
      b.close();
    } finally {
      if (saved === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = saved;
    }
  });

  it("arquivo .md que não é UTF-8 válido é recusado no plano e o original fica intacto", async () => {
    const latin1 = Buffer.concat([Buffer.from("---\ntitulo: Nota latina\n---\nAção: "), Buffer.from([0xe7, 0xe3, 0x6f, 0x0a])]);
    const src = srcWith({ "ambiente/latina.md": latin1 });
    const b = await tempBrain();
    await expect(migrateFlat(b, src, human, { apply: false })).rejects.toThrow(/UTF-8/);
    await expect(migrateFlat(b, src, human, { apply: true })).rejects.toThrow(/UTF-8/);
    expect(readFileSync(join(src, "ambiente/latina.md")).equals(latin1)).toBe(true);
    expect(existsSync(join(b.vault.root, "_legado"))).toBe(false);
  });
});
