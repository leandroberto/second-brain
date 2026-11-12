import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { ConfigSchema, authorize, dumpConfig, loadConfig } from "../src/index.js";
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

  it("setModuleEntry com atualizador: recebe a entrada lida dentro do lock; erro dele cancela a gravação", async () => {
    const b = await tempBrain();
    await b.setModuleEntry("lembrete", { enabled: true, path: "/x/lembrete", ia_max_usd_dia: 2 }, human);
    // edição manual depois da última leitura da Brain: o atualizador vê a do disco
    const cfg = b.vault.configPath;
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("enabled: true", "enabled: false"), "utf8");
    const vistos: unknown[] = [];
    await b.setModuleEntry("lembrete", (atual) => { vistos.push(atual?.enabled); return { ...atual!, config: { horario: "09:00" } }; }, human);
    expect(vistos).toEqual([false]);
    expect(loadConfig(cfg).modules.lembrete).toMatchObject({ enabled: false, config: { horario: "09:00" } });
    const antes = readFileSync(cfg, "utf8");
    await expect(b.setModuleEntry("lembrete", () => { throw new Error("não"); }, human)).rejects.toThrow("não");
    expect(readFileSync(cfg, "utf8")).toBe(antes);
    await b.setModuleEntry("lembrete", () => null, human);
    expect(loadConfig(cfg).modules.lembrete).toBeUndefined();
  });

  it("setModuleEntry audita a ação semântica que vem da API (valor ou função da entrada antes/depois)", async () => {
    const b = await tempBrain();
    await b.setModuleEntry("lembrete", { enabled: true, ia_max_usd_dia: 2 }, human, "adicionar");
    await b.setModuleEntry("lembrete", (e) => ({ ...e!, enabled: false }), human, (antes, depois) => (antes?.enabled !== false && depois?.enabled === false ? "desligar" : "configurar"));
    await b.setModuleEntry("lembrete", (e) => ({ ...e!, host: "esta" }), human, "restringir_host");
    await b.setModuleEntry("lembrete", null, human, "remover");
    const acoes = b.db.activity({ action: "config_update" }).map((a) => (a.detail as { acao?: string }).acao).reverse();
    expect(acoes).toEqual(["adicionar", "desligar", "restringir_host", "remover"]);
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

  it("setModuleEntry não regrava um config.yaml inválido", async () => {
    const b = await tempBrain();
    const quebrado = "vault_name: [quebrado\n  modules: : :\n";
    writeFileSync(b.vault.configPath, quebrado, "utf8");
    await expect(b.setModuleEntry("lembrete", { enabled: true, ia_max_usd_dia: 2 }, human)).rejects.toMatchObject({ code: "invalid" });
    expect(readFileSync(b.vault.configPath, "utf8")).toBe(quebrado);
  });

  it("updateConfig não regrava um config.yaml inválido (a edição manual não se perde)", async () => {
    const b = await tempBrain();
    const quebrado = "vault_name: [quebrado\n  modules: : :\n";
    writeFileSync(b.vault.configPath, quebrado, "utf8");
    await expect(b.updateConfig({ vault_name: "X" }, human)).rejects.toMatchObject({ code: "invalid", message: "o .brain/config.yaml tem um erro de edição; corrija-o antes de salvar as configurações" });
    expect(readFileSync(b.vault.configPath, "utf8")).toBe(quebrado);
  });

  it("freshConfig com o config.yaml vazio ou ilegível mantém a config em memória (outro processo pode estar no meio da gravação)", async () => {
    const b = await tempBrain();
    await b.updateConfig({ vault_name: "Meu vault", governance: { stale_days: 7 } }, human);
    writeFileSync(b.vault.configPath, "", "utf8");
    expect(b.freshConfig()).toMatchObject({ vault_name: "Meu vault", governance: { stale_days: 7 } });
    writeFileSync(b.vault.configPath, "  \n", "utf8");
    expect(b.freshConfig()).toMatchObject({ vault_name: "Meu vault", governance: { stale_days: 7 } });
    rmSync(b.vault.configPath);
    expect(b.freshConfig()).toMatchObject({ vault_name: "Meu vault", governance: { stale_days: 7 } });
    // um arquivo legível continua valendo na hora
    writeFileSync(b.vault.configPath, stringify({ ...parse(dumpConfig(b.config)), vault_name: "Editado por fora" }), "utf8");
    expect(b.freshConfig().vault_name).toBe("Editado por fora");
    b.close();
  });
});
