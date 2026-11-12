import { describe, expect, it } from "vitest";
import { EVENTOS_MODULOS, EVENTOS_PADRAO, recarregaCom } from "./api";

describe("eventos que recarregam uma consulta", () => {
  it("as consultas comuns reagem a notes e proposals e ignoram module.*", () => {
    expect(recarregaCom(EVENTOS_PADRAO, "notes")).toBe(true);
    expect(recarregaCom(EVENTOS_PADRAO, "proposals")).toBe(true);
    expect(recarregaCom(EVENTOS_PADRAO, "module.badge")).toBe(false);
    expect(recarregaCom(EVENTOS_PADRAO, "module.notification")).toBe(false);
  });
  it("as consultas de módulos reagem só a module.*", () => {
    expect(recarregaCom(EVENTOS_MODULOS, "module.badge")).toBe(true);
    expect(recarregaCom(EVENTOS_MODULOS, "module.notification")).toBe(true);
    expect(recarregaCom(EVENTOS_MODULOS, "notes")).toBe(false);
    expect(recarregaCom(EVENTOS_MODULOS, "proposals")).toBe(false);
  });
});
