import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { ConfigSchema, authorize, loadConfig } from "../src/index.js";
import { modulePrincipal } from "../src/modules/identity.js";
import { claude, cleanup, human, tempBrain } from "./helpers.js";

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
    const cfg = ConfigSchema.parse({});
    const m = modulePrincipal("x1");
    for (const op of ["write", "assist", "decide", "admin"] as const) expect(() => authorize(m, op, { config: cfg })).toThrow();
    expect(authorize(m, "propose", { config: cfg })).toBe(m);
  });

  it("setModuleEntry adiciona, atualiza, remove e audita", async () => {
    const b = await tempBrain();
    const lido = () => parse(readFileSync(b.vault.configPath, "utf8"));
    await b.setModuleEntry("lembrete", { enabled: true, path: "/x/lembrete", ia_max_usd_dia: 2, config: { horario: "10:00" } }, human);
    await b.setModuleEntry("outro", { enabled: true, ia_max_usd_dia: 2 }, human);
    expect(lido().modules.lembrete).toMatchObject({ enabled: true, path: "/x/lembrete", config: { horario: "10:00" } });
    expect(loadConfig(b.vault.configPath).modules.lembrete?.path).toBe("/x/lembrete");

    await b.setModuleEntry("lembrete", { ...b.config.modules.lembrete!, enabled: false }, human);
    expect(lido().modules.lembrete).toMatchObject({ enabled: false, config: { horario: "10:00" } });

    const cfg = await b.setModuleEntry("lembrete", null, human);
    expect(Object.keys(cfg.modules)).toEqual(["outro"]);
    expect(Object.keys(lido().modules)).toEqual(["outro"]);

    const acts = b.db.activity({ action: "config_update" }).map((a) => a.detail);
    expect(acts).toEqual(expect.arrayContaining([
      expect.objectContaining({ modulo: "lembrete", acao: "adicionar" }),
      expect.objectContaining({ modulo: "lembrete", acao: "atualizar" }),
      expect.objectContaining({ modulo: "lembrete", acao: "remover" }),
    ]));
  });

  it("setModuleEntry recusa agente", async () => {
    const b = await tempBrain();
    await expect(b.setModuleEntry("lembrete", { enabled: true, ia_max_usd_dia: 2 }, claude)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("setModuleEntry valida o id e não usa o protótipo", async () => {
    const b = await tempBrain();
    for (const id of ["__proto__", "Lembrete"]) {
      await expect(b.setModuleEntry(id, { enabled: true, ia_max_usd_dia: 2 }, human)).rejects.toMatchObject({ code: "invalid" });
    }
    expect(Object.keys(b.config.modules)).toEqual([]);
    // "constructor" passa na regex: vale como id comum e conta como "adicionar" (não existe como chave própria)
    await b.setModuleEntry("constructor", { enabled: true, ia_max_usd_dia: 2 }, human);
    expect(Object.keys(b.config.modules)).toEqual(["constructor"]);
    expect(b.db.activity({ action: "config_update" })[0]?.detail).toMatchObject({ modulo: "constructor", acao: "adicionar" });
    expect(({} as Record<string, unknown>).enabled).toBeUndefined();
  });

  it("setModuleEntry preserva edição externa do config.yaml feita após a subida", async () => {
    const b = await tempBrain();
    const atual = parse(readFileSync(b.vault.configPath, "utf8"));
    writeFileSync(b.vault.configPath, stringify({ ...atual, vault_name: "Editado por fora" }), "utf8");
    await b.setModuleEntry("lembrete", { enabled: true, ia_max_usd_dia: 2 }, human);
    const lido = parse(readFileSync(b.vault.configPath, "utf8"));
    expect(lido.vault_name).toBe("Editado por fora");
    expect(lido.modules.lembrete.enabled).toBe(true);
  });
});
