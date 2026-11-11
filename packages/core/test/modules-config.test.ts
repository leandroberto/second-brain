import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { authorize, loadConfig } from "../src/index.js";
import { modulePrincipal } from "../src/modules/identity.js";
import { cleanup, human, tempBrain } from "./helpers.js";

afterAll(cleanup);

describe("config modules e identidade module/<id>", () => {
  it("config sem modules vira {}", () => {
    const f = join(mkdtempSync(join(tmpdir(), "brain-modcfg-")), "config.yaml");
    writeFileSync(f, "", "utf8");
    expect(loadConfig(f).modules).toEqual({});
  });

  it("aplica os padrões de cada módulo e preserva chaves extras", () => {
    const f = join(mkdtempSync(join(tmpdir(), "brain-modcfg-")), "config.yaml");
    writeFileSync(f, "modules:\n  lembrete:\n    extra: 1\n", "utf8");
    expect(loadConfig(f).modules.lembrete).toEqual({ enabled: true, ia_max_usd_dia: 2, extra: 1 });
  });

  it("updateConfig preserva modules", async () => {
    const b = await tempBrain();
    const atual = parse(readFileSync(b.vault.configPath, "utf8"));
    writeFileSync(b.vault.configPath, stringify({ ...atual, modules: { lembrete: { enabled: true, config: { horario: "10:00" } } } }), "utf8");
    await b.updateConfig({ vault_name: "X" }, human);
    const lido = parse(readFileSync(b.vault.configPath, "utf8"));
    expect(lido.vault_name).toBe("X");
    expect(lido.modules.lembrete.config).toEqual({ horario: "10:00" });
    expect(loadConfig(b.vault.configPath).modules.lembrete?.config).toEqual({ horario: "10:00" });
  });

  it("modulePrincipal", () => {
    expect(modulePrincipal("lembrete")).toMatchObject({ kind: "agent", name: "module/lembrete", channel: "module" });
    expect(() => modulePrincipal("Lembrete")).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(() => modulePrincipal("a")).toThrow();
  });

  it("módulo não escreve nem decide", () => {
    const cfg = loadConfig(join(tmpdir(), "inexistente-config.yaml"));
    const m = modulePrincipal("x1");
    for (const op of ["write", "assist", "decide", "admin"] as const) expect(() => authorize(m, op, { config: cfg })).toThrow();
    expect(authorize(m, "propose", { config: cfg })).toBe(m);
  });
});
