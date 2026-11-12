import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { ModuleDef } from "@brain/module-sdk";
import { descreverCron, resumirModulo, validarConfigDoModulo } from "../src/index.js";

const LEMBRETE = resolve(import.meta.dirname, "../../../examples/modules/lembrete/dist/index.js");
const carregar = async () => (await import(pathToFileURL(LEMBRETE).href)).default as ModuleDef;

describe("resumirModulo", () => {
  it("resumo do lembrete", async () => {
    const r = resumirModulo(await carregar());
    expect(r).toMatchObject({
      id: "lembrete", aba: { titulo: expect.any(String) }, usaIa: true,
      tarefas: [{ id: "diario", quando: "0 10 * * *", quandoTexto: "todo dia às 10:00" }],
      ferramentas: ["lembrete_listar"], rotas: { total: 2, humanas: 1 },
    });
    expect(r.configJson).toHaveProperty("properties.horario");
  });
});

describe("descreverCron", () => {
  it("padrões simples em português", () => {
    expect(descreverCron("30 17 * * 1-5")).toBe("dias úteis às 17:30");
    expect(descreverCron("0 10 * * *")).toBe("todo dia às 10:00");
    expect(descreverCron("0 18 * * 5")).toBe("sexta às 18:00");
  });
  it("fora dos padrões devolve a expressão", () => {
    expect(descreverCron("*/15 * * * *")).toBe("*/15 * * * *");
  });
});

describe("validarConfigDoModulo", () => {
  it("horário inválido aponta o campo, válido passa", async () => {
    const def = await carregar();
    const ruim = await validarConfigDoModulo(def, { horario: "25:00" });
    expect(ruim.ok).toBe(false);
    if (!ruim.ok) expect(ruim.erros.map((e) => e.campo)).toContain("horario");
    expect(await validarConfigDoModulo(def, { horario: "10:00" })).toEqual({ ok: true });
  });
  it("segredo vira erro no campo sem repetir o valor", async () => {
    const r = await validarConfigDoModulo(await carregar(), { horario: "10:00", token: "ghp_" + "a".repeat(36) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e = r.erros.find((x) => x.campo === "token")!;
      expect(e).toBeDefined();
      expect(JSON.stringify(r.erros)).not.toContain("ghp_");
    }
  });
});
