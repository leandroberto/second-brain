import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { watchVault } from "../src/index.js";
import { cleanup, human, tempBrain } from "./helpers.js";

afterAll(cleanup);
const base = { title: "Nota para watcher", type: "learning" as const, body: "Conteúdo original sobre girassóis e abelhas." };

describe("edição externa (Obsidian) → índice", () => {
  it("rename: a nota continua indexada (mesmo id), com o novo caminho", async () => {
    const b = await tempBrain();
    const n = await b.createNote(base, human);
    const novo = "knowledge/learnings/renomeada-no-obsidian.md";
    renameSync(join(b.vault.root, n.path), join(b.vault.root, novo));
    const r = await b.sync();
    expect(r.removed).toEqual([]);
    expect(b.db.getRow(n.id)?.path).toBe(novo);
    expect((await b.search("girassóis")).map((h) => h.id)).toContain(n.id);
    expect((await b.health()).problems.duplicate_ids).toBe(0);
    b.close();
  });
  it("delete: some do índice e da busca", async () => {
    const b = await tempBrain();
    const n = await b.createNote(base, human);
    rmSync(join(b.vault.root, n.path));
    const r = await b.sync();
    expect(r.removed).toEqual([n.id]);
    expect(await b.search("girassóis")).toEqual([]);
    expect(() => b.loadNote(n.id)).toThrow(/não existe/);
    b.close();
  });
  it("alterações rápidas em sequência: o índice converge para o último conteúdo", async () => {
    const b = await tempBrain();
    const n = await b.createNote(base, human);
    const f = join(b.vault.root, n.path);
    for (let i = 1; i <= 5; i++) { writeFileSync(f, readFileSync(f, "utf8").replace(/versão \d+|original/, `versão ${i}`)); await b.sync(); }
    expect((await b.search("versão 5")).length).toBe(1);
    expect(b.db.getRow(n.id)!.body).toContain("versão 5");
    b.close();
  });
  it("arquivos inválidos não quebram nem corrompem o vault", async () => {
    const b = await tempBrain();
    const ok = await b.createNote(base, human);
    const dir = join(b.vault.root, "knowledge/inbox");
    writeFileSync(join(dir, "vazio.md"), "");
    writeFileSync(join(dir, "binario.md"), Buffer.from([0, 1, 2, 255, 254, 0, 0]));
    writeFileSync(join(dir, "yaml-quebrado.md"), "---\nid: [oops\ntitle: x: y: z\n---\ncorpo do yaml quebrado palavraunica\n");
    writeFileSync(join(dir, "sem-frontmatter.md"), "# Só um título\n\nTexto solto de alguém no Obsidian palavrasolta.\n");
    writeFileSync(join(dir, "id-injetado.md"), "---\nid: ../../etc/passwd\ntitle: Injeção\ntype: fact\n---\ncorpo injetado\n");
    writeFileSync(join(dir, "tipo-estranho.md"), "---\nid: tipo-estranho\ntype: banana\nstatus: qualquer\ntags: 12\n---\ncorpo\n");
    const r = await b.sync();
    expect(r.added.length).toBeGreaterThanOrEqual(4);
    expect((await b.search("palavraunica")).length).toBe(1);
    expect((await b.search("palavrasolta")).length).toBe(1);
    expect(b.db.getRow("etc-passwd")?.path ?? b.db.rows("title='Injeção'")[0]?.path).toMatch(/^knowledge\/inbox\//); // id inválido nunca vira caminho
    expect(b.loadNote(ok.id).title).toBe(base.title); // nota válida intacta
    const h = await b.health();
    expect(h.problems.notes_with_issues).toBeGreaterThanOrEqual(4);
    // o Core nunca reescreveu os arquivos inválidos
    expect(readFileSync(join(dir, "yaml-quebrado.md"), "utf8")).toContain("id: [oops");
    b.close();
  });
  it("id duplicado (cópia no Obsidian) é sinalizado, não sobrescreve o original", async () => {
    const b = await tempBrain();
    const n = await b.createNote(base, human);
    mkdirSync(join(b.vault.root, "knowledge/inbox"), { recursive: true });
    copyFileSync(join(b.vault.root, n.path), join(b.vault.root, "knowledge/inbox/copia.md"));
    await b.sync();
    const h = await b.health();
    expect(h.problems.duplicate_ids).toBe(1);
    expect(b.db.getRow(n.id)?.path).toBe(n.path);
    b.close();
  });
  it("watchVault: edição manual aparece na busca sem chamada explícita de sync e sem loop", async () => {
    const b = await tempBrain();
    const n = await b.createNote(base, human);
    let events = 0;
    const w = watchVault(b, () => { events++; }, 100);
    const f = join(b.vault.root, n.path);
    writeFileSync(f, readFileSync(f, "utf8") + "\nParágrafo novo sobre colibris zzcolibri.\n");
    await vi.waitFor(() => expect(b.db.rows("body LIKE '%zzcolibri%'").length).toBe(1), { timeout: 8000, interval: 150 });
    await new Promise((r) => setTimeout(r, 1200));
    expect(events).toBe(1); // um único ciclo: a indexação não gera nova escrita/evento
    expect(readFileSync(f, "utf8")).toContain("zzcolibri");
    w.close(); b.close();
  });
});
