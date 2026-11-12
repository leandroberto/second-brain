import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AvisosStore, createModuleContext, type AvisosSink } from "../src/index.js";
import type { Brain } from "../src/brain.js";

const nova = () => mkdtempSync(join(tmpdir(), "brain-avisos-"));
const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4)}`;

describe("AvisosStore", () => {
  it("o índice fica em memória: listar e marcarVisto não releem o arquivo (o disco só é lido na construção)", async () => {
    const root = nova();
    const s = new AvisosStore(root);
    const a = await s.avisar("m", { titulo: "um" });
    const b = await s.avisar("m", { titulo: "dois" });
    writeFileSync(join(root, "_avisos.jsonl"), ""); // se listar relesse o disco, veria vazio
    expect(s.listar().avisos.map((x) => x.id)).toEqual([a.id, b.id]);
    s.marcarVisto(a.id);
    expect(s.listar().avisos.map((x) => x.id)).toEqual([b.id]);
    expect(s.listar(a.id).avisos.map((x) => x.id)).toEqual([b.id]);
    const c = await s.avisar("m", { titulo: "tres" });
    expect(s.listar().avisos.map((x) => x.id)).toEqual([b.id, c.id]);
  });

  it("as escritas chegam ao disco: uma instância nova vê vistos, avisos novos e a chave deduplicada", async () => {
    const root = nova();
    const s = new AvisosStore(root);
    const a = await s.avisar("m", { titulo: "um", chave: "k" });
    const b = await s.avisar("m", { titulo: "dois", chave: "k" }); // substitui `a`
    const c = await s.avisar("m", { titulo: "tres" });
    s.marcarVisto(c.id);
    expect(new AvisosStore(root).listar().avisos.map((x) => x.id)).toEqual([b.id]);
    expect(a.id).not.toBe(b.id);
  });

  it("listar devolve cópias: alterar o resultado não muda o índice", async () => {
    const s = new AvisosStore(nova());
    await s.avisar("m", { titulo: "um" });
    s.listar().avisos[0]!.titulo = "adulterado";
    expect(s.listar().avisos[0]!.titulo).toBe("um");
  });

  it("chave deduplica", async () => {
    const s = new AvisosStore(nova());
    await s.avisar("m", { titulo: "um", chave: "d1" });
    const b = await s.avisar("m", { titulo: "dois", chave: "d1" });
    const l = s.listar();
    expect(l.avisos.map((a) => a.id)).toEqual([b.id]);
    expect(l.avisos[0]!.titulo).toBe("dois");
  });

  it("mesma chave em módulos diferentes não deduplica", async () => {
    const s = new AvisosStore(nova());
    await s.avisar("a", { titulo: "x", chave: "k" });
    await s.avisar("b", { titulo: "y", chave: "k" });
    expect(s.listar().avisos).toHaveLength(2);
  });

  it("cursor devolve só o novo, ids ordenáveis", async () => {
    const s = new AvisosStore(nova());
    const a = await s.avisar("m", { titulo: "a" });
    const b = await s.avisar("m", { titulo: "b" });
    expect(b.id > a.id).toBe(true);
    const { cursor } = s.listar();
    expect(cursor).toBe(b.id);
    expect(s.listar(a.id).avisos.map((x) => x.id)).toEqual([b.id]);
    const c = await s.avisar("m", { titulo: "c" });
    const l = s.listar(cursor);
    expect(l.avisos.map((x) => x.id)).toEqual([c.id]);
    expect(l.cursor).toBe(c.id);
  });

  it("visto some da lista e persiste", async () => {
    const root = nova();
    const s = new AvisosStore(root);
    const a = await s.avisar("m", { titulo: "a" });
    s.marcarVisto(a.id);
    expect(s.listar().avisos).toEqual([]);
    expect(new AvisosStore(root).listar().avisos).toEqual([]);
  });

  it("total soma badges; negativo e NaN viram 0; persiste", () => {
    const root = nova();
    const s = new AvisosStore(root);
    s.badge("a", 2);
    s.badge("b", 3);
    expect(s.listar().total).toBe(5);
    s.badge("b", -1);
    expect(s.listar().badges).toEqual({ a: 2 });
    s.badge("a", Number.NaN);
    expect(s.listar().total).toBe(0);
    s.badge("a", 4.9);
    expect(new AvisosStore(root).listar().badges).toEqual({ a: 4 });
  });

  it("onChange emite", async () => {
    const evs: string[] = [];
    const s = new AvisosStore(nova(), (ev) => evs.push(ev));
    await s.avisar("m", { titulo: "a" });
    s.badge("m", 1);
    expect(evs).toEqual(["module.notification", "module.badge"]);
  });

  it("aoMudar: várias assinaturas, cancelar, e ouvinte que lança não quebra", async () => {
    const s = new AvisosStore(nova());
    const a: string[] = [], b: string[] = [];
    s.aoMudar(() => { throw new Error("defeito"); });
    const off1 = s.aoMudar((ev) => a.push(ev));
    s.aoMudar((ev) => b.push(ev));
    await s.avisar("m", { titulo: "x" });
    expect(a).toEqual(["module.notification"]);
    expect(b).toEqual(["module.notification"]);
    off1();
    s.badge("m", 2);
    expect(a).toEqual(["module.notification"]);
    expect(b).toEqual(["module.notification", "module.badge"]);
  });

  it("título, corpo, link e chave passam pelo scanSecrets, sem citar o valor", async () => {
    const s = new AvisosStore(nova());
    for (const a of [{ titulo: TOKEN }, { titulo: "t", corpo: `veja ${TOKEN}` }, { titulo: "t", link: TOKEN }, { titulo: "t", chave: TOKEN }]) {
      const e = await s.avisar("m", a).catch((x: unknown) => x as { code?: string; message: string });
      expect((e as { code?: string }).code).toBe("invalid");
      expect((e as Error).message).not.toContain(TOKEN);
    }
    expect(s.listar().avisos).toEqual([]);
  });

  it("valida tamanhos e link relativo", async () => {
    const s = new AvisosStore(nova());
    const ruim = [{ titulo: "" }, { titulo: "x".repeat(201) }, { titulo: "t", corpo: "x".repeat(2001) }, { titulo: "t", link: "x".repeat(501) },
      { titulo: "t", link: "/abs" }, { titulo: "t", link: "//host/x" }, { titulo: "t", link: "https://x" }, { titulo: "t", link: "javascript:1" }];
    for (const a of ruim) await expect(s.avisar("m", a)).rejects.toMatchObject({ code: "invalid" });
    await expect(s.avisar("m", { titulo: "ok", link: "itens/1?x=2" })).resolves.toMatchObject({ link: "itens/1?x=2" });
  });

  it("arquivo fica limitado, com reescrita atômica", async () => {
    const root = nova();
    const s = new AvisosStore(root);
    const avisos: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => { avisos.push(String(m)); });
    try { for (let i = 0; i < 1100; i++) await s.avisar("m", { titulo: `n${i}` }); } finally { spy.mockRestore(); }
    // só não vistos (mais de 500): mantém os 500 mais recentes e avisa no stderr
    expect(avisos.length).toBeGreaterThan(0);
    expect(avisos[0]).toMatch(/500 avisos não vistos/);
    expect(s.listar().avisos[0]!.titulo).toBe(`n${1100 - s.listar().avisos.length}`);
    const linhas = readFileSync(join(root, "_avisos.jsonl"), "utf8").trim().split("\n");
    expect(linhas.length).toBeLessThanOrEqual(1000);
    expect(s.listar().avisos.at(-1)!.titulo).toBe("n1099");
    expect(s.listar().avisos.length).toBeGreaterThanOrEqual(500);
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(join(root, "_badges.json"))).toBe(false);
  });
});

describe("AvisosStore: persistência", () => {
  it("a deduplicação por chave vale depois de reabrir o store", async () => {
    const root = nova();
    await new AvisosStore(root).avisar("m", { titulo: "um", chave: "k" });
    const reaberto = new AvisosStore(root);
    const b = await reaberto.avisar("m", { titulo: "dois", chave: "k" });
    expect(reaberto.listar().avisos.map((a) => a.id)).toEqual([b.id]);
    expect(new AvisosStore(root).listar().avisos.map((a) => [a.id, a.titulo])).toEqual([[b.id, "dois"]]);
  });

  it("a compactação preserva o visto: depois de reabrir, só o não visto aparece", async () => {
    const root = nova();
    const s = new AvisosStore(root);
    // cada aviso visto ocupa 2 linhas: passa de 1000 linhas e compacta no meio do laço
    for (let i = 0; i < 520; i++) { const a = await s.avisar("m", { titulo: `v${i}` }); s.marcarVisto(a.id); }
    const pendente = await s.avisar("m", { titulo: "pendente" });
    const linhas = readFileSync(join(root, "_avisos.jsonl"), "utf8").trim().split("\n");
    expect(linhas.length).toBeLessThan(1000); // compactou
    expect(new AvisosStore(root).listar().avisos.map((a) => a.id)).toEqual([pendente.id]);
  });

  it("linha corrompida no .jsonl é ignorada e as demais valem", async () => {
    const root = nova();
    const s = new AvisosStore(root);
    const a = await s.avisar("m", { titulo: "um" });
    const b = await s.avisar("m", { titulo: "dois" });
    const arq = join(root, "_avisos.jsonl");
    const [la, lb] = readFileSync(arq, "utf8").trim().split("\n");
    writeFileSync(arq, `${la}\n{"id":"truncada","titu\nnão é json\n\n${lb}\n{"id":"x"`, "utf8");
    const r = new AvisosStore(root);
    expect(r.listar().avisos.map((x) => x.id)).toEqual([a.id, b.id]);
    r.marcarVisto(a.id); // a escrita seguinte continua funcionando sobre o arquivo com lixo
    expect(new AvisosStore(root).listar().avisos.map((x) => x.id)).toEqual([b.id]);
  });

  it("marcarVisto com id desconhecido (ou já visto) não lança nem altera nada", async () => {
    const root = nova();
    const s = new AvisosStore(root);
    const a = await s.avisar("m", { titulo: "um" });
    s.marcarVisto(a.id);
    const arq = join(root, "_avisos.jsonl");
    const antes = readFileSync(arq, "utf8");
    expect(() => s.marcarVisto("nao-existe")).not.toThrow();
    expect(() => s.marcarVisto(a.id)).not.toThrow();
    expect(readFileSync(arq, "utf8")).toBe(antes);
    expect(s.listar().avisos).toEqual([]);
  });
});

describe("AvisosStore: falhas e casos de borda", () => {
  it("chave vazia ou só com espaços é inválida", async () => {
    const s = new AvisosStore(nova());
    for (const chave of ["", "   "]) await expect(s.avisar("m", { titulo: "t", chave })).rejects.toMatchObject({ code: "invalid" });
    expect(s.listar().avisos).toEqual([]);
  });

  it("compactação nunca descarta aviso não visto, por mais antigo que seja", async () => {
    const s = new AvisosStore(nova());
    const antigo = await s.avisar("m", { titulo: "antigo" });
    for (let i = 0; i < 1100; i++) { const a = await s.avisar("m", { titulo: `n${i}` }); s.marcarVisto(a.id); }
    const ultimo = await s.avisar("m", { titulo: "novo" });
    expect(s.listar().avisos.map((a) => a.id)).toEqual([antigo.id, ultimo.id]);
  });

  it("badge: falha ao gravar não altera a memória nem emite, e o erro é relançado", () => {
    const root = nova();
    const evs: string[] = [];
    const s = new AvisosStore(root, (ev) => evs.push(ev));
    s.badge("a", 1);
    rmSync(join(root, "_badges.json"));
    mkdirSync(join(root, "_badges.json", "x"), { recursive: true }); // rename do tmp sobre diretório não vazio falha
    expect(() => s.badge("a", 5)).toThrow();
    expect(() => s.badge("b", 2)).toThrow();
    expect(s.listar().badges).toEqual({ a: 1 });
    expect(s.listar().total).toBe(1);
    expect(evs).toEqual(["module.badge"]);
  });

  it("dedupe por chave: falha no meio dá duplicata, nunca perda", async () => {
    const s = new AvisosStore(nova());
    const um = await s.avisar("m", { titulo: "um", chave: "k" });
    const interno = s as unknown as { acrescentar(l: unknown): void };
    const original = interno.acrescentar.bind(s);
    let n = 0;
    // a 2ª gravação do avisar falha (seja ela a do aviso novo ou a marca de visto do anterior)
    interno.acrescentar = (l) => { if (n++ === 1) throw new Error("disco cheio"); original(l); };
    await expect(s.avisar("m", { titulo: "dois", chave: "k" })).rejects.toThrow("disco cheio");
    const ficou = s.listar().avisos;
    expect(ficou.map((a) => a.titulo)).toEqual(["um", "dois"]); // duplicata: o novo foi gravado e o anterior não foi apagado
    expect(ficou[0]!.id).toBe(um.id);
    interno.acrescentar = original;
    const tres = await s.avisar("m", { titulo: "tres", chave: "k" });
    expect(s.listar().avisos.map((a) => a.id)).toEqual([tres.id]);
  });
});

describe("createModuleContext normaliza o badge", () => {
  it("floor/max(0)/NaN/Infinity antes do sink", () => {
    const got: number[] = [];
    const sink: AvisosSink = { avisar: async () => undefined, badge: (_m, n) => { got.push(n); } };
    const brain = { vault: { stateDir: nova() }, config: { vault_name: "t" } } as unknown as Brain;
    const ctx = createModuleContext(brain, "mod", {}, { ia: {} as never, avisos: sink });
    for (const n of [2.9, -1, Number.NaN, Number.POSITIVE_INFINITY]) ctx.badge(n);
    expect(got).toEqual([2, 0, 0, 0]);
  });
});
