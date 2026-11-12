import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createModuleState } from "../src/index.js";

describe("ctx.estado", () => {
  it("lerJson: undefined só quando o arquivo não existe", () => {
    const st = createModuleState(mkdtempSync(join(tmpdir(), "brain-estado-")), "mod");
    expect(st.lerJson("itens")).toBeUndefined();
    st.gravarJson("itens", [1, 2]);
    expect(st.lerJson("itens")).toEqual([1, 2]);
  });

  it("lerJson de JSON corrompido lança invalid citando nome e módulo, e o arquivo fica intacto", () => {
    const st = createModuleState(mkdtempSync(join(tmpdir(), "brain-estado-")), "mod");
    writeFileSync(join(st.dir, "itens.json"), "{trunc");
    expect(() => st.lerJson("itens")).toThrowError(expect.objectContaining({ code: "invalid", message: "estado itens do módulo mod está corrompido" }));
    expect(readFileSync(join(st.dir, "itens.json"), "utf8")).toBe("{trunc");
  });

  it("lerJson: erro de leitura que não é ausência é relançado (não vira undefined)", () => {
    const st = createModuleState(mkdtempSync(join(tmpdir(), "brain-estado-")), "mod");
    mkdirSync(join(st.dir, "pasta.json"));
    expect(() => st.lerJson("pasta")).toThrow(/EISDIR/);
  });
});
