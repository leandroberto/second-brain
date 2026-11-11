import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AvisosStore, createModuleContext, type AvisosSink } from "../src/index.js";
import type { Brain } from "../src/brain.js";

const nova = () => mkdtempSync(join(tmpdir(), "brain-avisos-"));
const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4)}`;

describe("AvisosStore", () => {
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
    for (let i = 0; i < 1100; i++) await s.avisar("m", { titulo: `n${i}` });
    const linhas = readFileSync(join(root, "_avisos.jsonl"), "utf8").trim().split("\n");
    expect(linhas.length).toBeLessThanOrEqual(1000);
    expect(s.listar().avisos.at(-1)!.titulo).toBe("n1099");
    expect(s.listar().avisos.length).toBeGreaterThanOrEqual(500);
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(join(root, "_badges.json"))).toBe(false);
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
