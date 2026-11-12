import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { caminhoRealDePasta, listarPastas } from "../src/index.js";

describe("listarPastas e caminho real", () => {
  it("listarPastas e caminho real com espaço, acento e symlink", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "brain-pastas-")));
    const proj = join(home, "projetos");
    const mod = join(proj, "módulo horas");
    mkdirSync(mod, { recursive: true });
    writeFileSync(join(mod, "package.json"), JSON.stringify({ dependencies: { "@brain/module-sdk": "*" } }));
    mkdirSync(join(proj, ".oculta"));
    writeFileSync(join(proj, "arquivo.txt"), "x");
    symlinkSync(mod, join(proj, "link"));

    const r = listarPastas(undefined, { home });
    expect(r.caminho).toBe(proj);
    expect(r.pai).toBe(home);
    expect(r.pastas.map((p) => p.nome)).toEqual(["link", "módulo horas"]);
    expect(r.pastas.every((p) => p.provavelModulo)).toBe(true);
    expect(r.pastas.find((p) => p.nome === "link")?.caminho).toBe(realpathSync(mod));
    expect(listarPastas(proj, { home, mostrarOcultas: true }).pastas.map((p) => p.nome)).toContain(".oculta");
    expect(caminhoRealDePasta(join(proj, "link"))).toBe(realpathSync(mod));
  });

  it("sem projetos usa a home; sem SDK não é provável módulo", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "brain-pastas-")));
    mkdirSync(join(home, "a"));
    writeFileSync(join(home, "a", "package.json"), JSON.stringify({ dependencies: { outro: "1" } }));
    const r = listarPastas(undefined, { home });
    expect(r.caminho).toBe(home);
    expect(r.pastas).toEqual([{ nome: "a", caminho: join(home, "a"), provavelModulo: false }]);
  });

  it("relativo e arquivo", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "brain-pastas-")));
    const arq = join(home, "f.txt");
    writeFileSync(arq, "x");
    expect(() => listarPastas("projetos", { home })).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(() => caminhoRealDePasta(arq)).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(() => caminhoRealDePasta(join(home, "nao-existe"))).toThrowError(expect.objectContaining({ code: "invalid" }));
  });
});
