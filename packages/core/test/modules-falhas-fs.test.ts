import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Falhas de sistema de arquivos difíceis de provocar de verdade: a preservação do arquivo ilegível falha com EACCES e o
// `link` do serve.lock falha como num FS sem hard link (FAT, compartilhamento de rede).
vi.mock("../src/fs-atomic.js", async (original) => ({
  ...(await original<typeof import("../src/fs-atomic.js")>()),
  preservarCorrompido: () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); },
}));
const erroDoLink = { code: "" };
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, linkSync: (...a: Parameters<typeof fs.linkSync>) => { if (erroDoLink.code) throw Object.assign(new Error(`${erroDoLink.code}: link`), { code: erroDoLink.code }); return fs.linkSync(...a); } };
});

const { ConfigSchema, ModuleRegistry, Scheduler, acquireServeLock, createModuleIa } = await import("../src/index.js");

describe("preservação que falha", () => {
  it("_ia.json ilegível que não pôde ser preservado: nada é gravado por cima, a IA fica bloqueada e o stderr avisa", async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-falha-"));
    writeFileSync(join(root, "_ia.json"), "{ trunc");
    let chamou = false;
    const engine = { complete: async () => { chamou = true; return { ok: true as const, dados: "x", custoUsd: 0.01 }; }, capture: async () => { throw new Error("n/a"); }, ask: async () => { throw new Error("n/a"); } };
    const ia = createModuleIa(engine, ConfigSchema.parse({ modules: { x: {} } }), root, "x");
    const avisos: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => { avisos.push(String(m)); });
    try {
      expect(await ia.completar({ prompt: "p" })).toMatchObject({ ok: false, tipo: "orcamento", mensagem: `registro de gasto de IA ilegível; IA do módulo x bloqueada até corrigir: não foi possível guardar o registro ilegível em ${root}; confira as permissões` });
    } finally { spy.mockRestore(); }
    expect(chamou).toBe(false);
    expect(readFileSync(join(root, "_ia.json"), "utf8")).toBe("{ trunc");
    expect(readdirSync(root)).toEqual(["_ia.json"]);
    expect(avisos.join("\n")).toMatch(/não foi possível guardá-lo \(EACCES/);
  });
});

describe("preservação do _scheduler.json que falha", () => {
  it("o agendador não grava por cima do ilegível não preservado; nada roda e o erro vai ao stderr e às tarefas", async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-falha-"));
    writeFileSync(join(root, "_scheduler.json"), "{ trunc");
    const reg = new ModuleRegistry(root);
    let n = 0;
    reg.add({ id: "mod", def: { sdk: 1, id: "mod", nome: "m", versao: "1", tarefas: [{ id: "t", quando: "0 8 * * *", rodar: async () => { n++; } }] }, dir: root, status: "ativo", ctx: {} as never });
    const s = new Scheduler(reg, root, { agora: () => new Date(2026, 10, 11, 9), tickMs: 10 });
    const avisos: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => { avisos.push(String(m)); });
    try {
      s.start();
      expect((await s.runNow("mod", "t")).resultado).toBe("erro");
    } finally { await s.stop(); spy.mockRestore(); }
    expect(n).toBe(0);
    expect(readFileSync(join(root, "_scheduler.json"), "utf8")).toBe("{ trunc");
    expect(avisos.join("\n")).toMatch(/não pôde ser preservado/);
    expect(reg.errors("mod").map((e) => e.mensagem)).toEqual(expect.arrayContaining(["estado do agendador inválido para t; reiniciado", expect.stringMatching(/falha ao gravar _scheduler\.json: o _scheduler\.json ilegível não pôde ser preservado/)]));
  });
});

describe("serve.lock em FS sem hard link", () => {
  for (const code of ["EPERM", "ENOTSUP", "EXDEV"]) {
    it(`${code} no link vira erro claro de estado fora de disco local`, async () => {
      const base = mkdtempSync(join(tmpdir(), "brain-falha-"));
      const root = join(base, "modules"); mkdirSync(root);
      erroDoLink.code = code;
      try {
        await expect(acquireServeLock(root, { root: base, tokenPath: join(base, "t") })).rejects.toMatchObject({
          code: "state_unavailable", message: "o estado do second-brain precisa ficar em disco local (ext4/NTFS); este sistema de arquivos não suporta hard links",
        });
      } finally { erroDoLink.code = ""; }
      expect(readdirSync(base)).toEqual(["modules"]); // nem lock nem tmp
    });
  }
});
