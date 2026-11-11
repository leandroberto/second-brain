import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify, parse } from "yaml";
import { loadModules, modulesStateRoot, resolveModuleDir, stopModules, validar, type Brain } from "../src/index.js";
import { claude, cleanup, tempBrain } from "./helpers.js";

const FIX = resolve(import.meta.dirname, "fixtures/modules");
const saved = { dir: process.env.BRAIN_STATE_DIR, home: process.env.HOME };
const restaurar = (k: "BRAIN_STATE_DIR" | "HOME", v?: string) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
// sem BRAIN_STATE_DIR e com HOME temporário: cada vault de teste ganha o próprio estado padrão (`<slug>-<impressão do vault>`)
beforeAll(() => { delete process.env.BRAIN_STATE_DIR; process.env.HOME = mkdtempSync(join(tmpdir(), "brain-modstate-")); });
afterAll(() => { cleanup(); restaurar("BRAIN_STATE_DIR", saved.dir); restaurar("HOME", saved.home); });

/** brain com `modules` na config (como o usuário faria no config.yaml) */
async function comModulos(modules: Record<string, unknown>): Promise<Brain> {
  const b = await tempBrain();
  const atual = parse(readFileSync(b.vault.configPath, "utf8")) ?? {};
  writeFileSync(b.vault.configPath, stringify({ ...atual, modules }), "utf8");
  b.reloadConfig();
  return b;
}
const mod = (nome: string, extra: Record<string, unknown> = {}) => ({ path: join(FIX, nome), ...extra });

describe("loadModules", () => {
  it("carrega módulo ok e propõe como module/<id>", async () => {
    const b = await comModulos({ ok: mod("ok") });
    const reg = await loadModules(b, { modo: "serve" });
    const m = reg.get("ok")!;
    expect(m.status).toBe("ativo");
    expect(m.versao).toBe("1.2.3");
    const r = await m.ctx!.brain.propose({ title: "Nota do módulo ok sobre fornos", type: "learning", body: "Fornos de convecção distribuem calor de modo mais uniforme que os estáticos." });
    const p = b.getProposal((r as { id: string }).id);
    expect(p.proposed_by.name).toBe("module/ok");
  });

  it("ctx.brain.amend corrige a própria proposta; não expõe write/decide/assist", async () => {
    const b = await comModulos({ ok: mod("ok") });
    const reg = await loadModules(b, { modo: "serve" });
    const brain = reg.get("ok")!.ctx!.brain;
    const r = await brain.propose({ title: "Titulo provisório de teste", type: "learning", body: "Corpo original sobre a manutenção de bombas centrífugas em ambientes úmidos." }) as { id: string };
    await brain.amend(r.id, { title: "Titulo corrigido pelo módulo" });
    expect(b.getProposal(r.id).draft.title).toBe("Titulo corrigido pelo módulo");
    expect(Object.keys(brain).sort()).toEqual(["amend", "context", "get", "propose", "search", "similar"]);
    for (const k of ["write", "decide", "assist", "resolve", "link"]) expect(k in brain).toBe(false);
    // proposta de outro agente: o módulo não corrige
    const alheia = await b.propose({ title: "Proposta de outro agente", type: "learning", body: "Conteúdo sobre o descarte correto de baterias de lítio em oficinas pequenas." }, claude);
    await expect(brain.amend(alheia.id, { title: "Sequestrada pelo módulo" })).rejects.toThrow();
  });

  it("sdk incompatível, id divergente, pasta ausente, host de outra máquina", async () => {
    const b = await comModulos({
      sdk2: mod("sdk2"),
      "id-errado": mod("id-errado"),
      sumido: { path: join(FIX, "nao-existe") },
      remoto: mod("ok", { host: "outra-maquina" }),
    });
    const reg = await loadModules(b, { modo: "serve", hostname: "esta-maquina" });
    expect(reg.get("sdk2")).toMatchObject({ status: "falho" });
    expect(reg.get("sdk2")!.causa).toContain("sdk");
    expect(reg.get("id-errado")).toMatchObject({ status: "falho" });
    expect(reg.get("sumido")!.status).toBe("ausente");
    expect(reg.get("remoto")).toMatchObject({ status: "inativo", causa: "inativo nesta máquina" });
  });

  it("pasta relativa deixa o módulo ausente com a causa clara", async () => {
    const antes = process.env.BRAIN_MODULES_DIR;
    process.env.BRAIN_MODULES_DIR = "modulos-relativos";
    try {
      const b = await comModulos({ rel: { path: "./mods/rel" }, padrao: {}, remoto: { path: "rel", host: "outra-maquina" } });
      const reg = await loadModules(b, { modo: "serve", hostname: "esta-maquina" });
      expect(reg.get("rel")).toMatchObject({ status: "ausente" });
      expect(reg.get("rel")!.causa).toContain("modules.rel.path deve ser absoluto");
      expect(reg.get("padrao")).toMatchObject({ status: "ausente" });
      expect(reg.get("padrao")!.causa).toContain("BRAIN_MODULES_DIR deve ser absoluto");
      expect(reg.get("remoto")).toMatchObject({ status: "inativo" }); // de outra máquina: o caminho é de lá
    } finally { if (antes === undefined) delete process.env.BRAIN_MODULES_DIR; else process.env.BRAIN_MODULES_DIR = antes; }
  });

  it("enabled: false é ignorado (não aparece)", async () => {
    const b = await comModulos({ ok: mod("ok", { enabled: false }) });
    const reg = await loadModules(b, { modo: "serve" });
    expect(reg.list()).toEqual([]);
  });

  it("aba declarada sem pasta/index.html fica falho", async () => {
    const b = await comModulos({ "sem-aba": mod("sem-aba") });
    const reg = await loadModules(b, { modo: "serve" });
    expect(reg.get("sem-aba")!.status).toBe("falho");
    expect(reg.get("sem-aba")!.causa).toContain("index.html");
  });

  it("aba.pasta na raiz do módulo, absoluta ou fora dele fica falho", async () => {
    const raiz = mkdtempSync(join(tmpdir(), "brain-mod-aba-"));
    const criar = (id: string, pasta: string) => {
      const d = join(raiz, id);
      mkdirSync(join(d, "ui"), { recursive: true });
      writeFileSync(join(d, "package.json"), JSON.stringify({ name: `fixture-${id}`, version: "1.0.0", type: "module", exports: { ".": "./index.js" } }));
      writeFileSync(join(d, "index.js"), `export default { sdk: 1, id: ${JSON.stringify(id)}, nome: "A", versao: "1.0.0", aba: { titulo: "A", pasta: ${JSON.stringify(pasta)} } };\n`);
      // index.html em todo lugar: a recusa vem da pasta, não da falta do arquivo
      for (const f of [join(d, "index.html"), join(d, "ui", "index.html"), join(raiz, "index.html")]) writeFileSync(f, "<!doctype html>");
      return { path: d };
    };
    const b = await comModulos({ "aba-raiz": criar("aba-raiz", "."), "aba-abs": criar("aba-abs", join(raiz, "aba-abs", "ui")), "aba-fora": criar("aba-fora", ".."), "aba-boa": criar("aba-boa", "ui") });
    const reg = await loadModules(b, { modo: "serve" });
    for (const id of ["aba-raiz", "aba-abs", "aba-fora"]) {
      expect(reg.get(id)!.status, id).toBe("falho");
      expect(reg.get(id)!.causa, id).toContain("aba.pasta deve ser uma subpasta do módulo");
    }
    expect(reg.get("aba-boa")!.status).toBe("ativo");
    rmSync(raiz, { recursive: true, force: true });
  });

  it("config inválida pelo schema do módulo cita o caminho do campo", async () => {
    const b = await comModulos({ cfg: mod("cfg", { config: { horario: 5 } }) });
    const reg = await loadModules(b, { modo: "serve" });
    expect(reg.get("cfg")!.status).toBe("falho");
    expect(reg.get("cfg")!.causa).toContain("horario");
    const b2 = await comModulos({ cfg: mod("cfg", { config: { horario: "10:00" } }) });
    const reg2 = await loadModules(b2, { modo: "serve" });
    expect(reg2.get("cfg")!.status).toBe("ativo");
    expect(reg2.get("cfg")!.ctx!.config).toEqual({ horario: "10:00" });
  });

  it("segredo na config bloqueia sem citar o valor", async () => {
    const b = await comModulos({ ok: mod("ok", { config: { token: "ghp_" + "a".repeat(36) } }) });
    const reg = await loadModules(b, { modo: "serve" });
    const m = reg.get("ok")!;
    expect(m.status).toBe("falho");
    expect(m.causa).toContain("segredo na configuração do módulo ok");
    expect(m.causa).not.toContain("ghp_");
  });

  it("iniciar que lança deixa o módulo falho e os demais ativos", async () => {
    const b = await comModulos({ lanca: mod("lanca"), ok: mod("ok") });
    const reg = await loadModules(b, { modo: "serve" });
    expect(reg.get("lanca")!.status).toBe("falho");
    expect(reg.get("lanca")!.causa).toContain("falha proposital");
    expect(reg.get("ok")!.status).toBe("ativo");
    expect(reg.errors("lanca")[0]).toMatchObject({ onde: "iniciar" });
  });

  it("iniciar que estoura o tempo", async () => {
    const b = await comModulos({ lento: mod("lento") });
    const reg = await loadModules(b, { modo: "serve", iniciarTimeoutMs: 50 });
    expect(reg.get("lento")!.status).toBe("falho");
    expect(reg.get("lento")!.causa).toContain("tempo");
  });

  it("import que lança deixa o módulo falho (pacote sem entrada)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-modbad-"));
    writeFileSync(join(dir, "package.json"), '{"type":"module","exports":{".":"./index.js"}}');
    writeFileSync(join(dir, "index.js"), 'throw new Error("explode no import");');
    const b = await comModulos({ ok: { path: dir } });
    const reg = await loadModules(b, { modo: "serve" });
    expect(reg.get("ok")!.status).toBe("falho");
    expect(reg.get("ok")!.causa).toContain("explode no import");
  });

  it("causa de import/iniciar sai truncada em 300 e sem possível segredo (mesma higiene dos erros recentes)", async () => {
    const pastas: string[] = [];
    const pacote = (id: string, corpo: string) => {
      const d = mkdtempSync(join(tmpdir(), `brain-modcausa-${id}-`)); pastas.push(d);
      writeFileSync(join(d, "package.json"), '{"type":"module","exports":{".":"./index.js"}}');
      writeFileSync(join(d, "index.js"), corpo);
      return { path: d };
    };
    const segredo = `ghp_${"a".repeat(36)}`;
    const b = await comModulos({
      longo: pacote("longo", `export default { sdk: 1, id: "longo", nome: "L", async iniciar() { throw new Error("${"x".repeat(400)}"); } };`),
      chave: pacote("chave", `export default { sdk: 1, id: "chave", nome: "C", async iniciar() { throw new Error("token ${segredo} recusado"); } };`),
      importa: pacote("importa", `throw new Error("no import: ${segredo}");`),
    });
    const reg = await loadModules(b, { modo: "serve" });
    const longo = reg.get("longo")!.causa!;
    expect(longo.length).toBe(300);
    expect(longo.startsWith("iniciar falhou: xxx")).toBe(true);
    expect(reg.get("chave")!.causa).toBe("[mensagem omitida: possível segredo]");
    expect(reg.get("importa")!.causa).toBe("[mensagem omitida: possível segredo]");
    expect(JSON.stringify(reg.list().map((m) => m.causa))).not.toContain("ghp_");
    for (const d of pastas) rmSync(d, { recursive: true, force: true });
  });

  it("estado fora do vault: grava e lê o mesmo valor", async () => {
    const b = await comModulos({ ok: mod("ok") });
    const reg = await loadModules(b, { modo: "serve" });
    const { estado } = reg.get("ok")!.ctx!;
    expect(estado.dir.startsWith(b.vault.root)).toBe(false);
    estado.gravarJson("dados", { a: 1, b: [2] });
    expect(estado.lerJson("dados")).toEqual({ a: 1, b: [2] });
    expect(estado.lerJson("inexistente")).toBeUndefined();
    expect(() => estado.gravarJson("../fuga", 1)).toThrow();
    expect(await estado.lock("x", async () => 7)).toBe(7);
    expect(modulesStateRoot(b).startsWith(b.vault.root)).toBe(false);
  });

  it("dois vaults com o mesmo vault_name nunca dividem o estado dos módulos", async () => {
    const home = mkdtempSync(join(tmpdir(), "brain-modhome-"));
    const a = await tempBrain(); const b = await tempBrain();
    expect(a.config.vault_name).toBe(b.config.vault_name);
    const ra = modulesStateRoot(a, { HOME: home }); const rb = modulesStateRoot(b, { HOME: home });
    expect(ra).not.toBe(rb);
    expect(modulesStateRoot(a, { HOME: home })).toBe(ra);
    expect(readFileSync(join(ra, "..", "vault-path"), "utf8").trim()).toBe(realpathSync(a.vault.root));
    // BRAIN_STATE_DIR sem state.external: a mesma garantia de dono do estado da máquina
    const dividido = { HOME: home, BRAIN_STATE_DIR: join(home, "estado") };
    expect(modulesStateRoot(a, dividido)).toBe(join(home, "estado", "modules"));
    expect(() => modulesStateRoot(b, dividido)).toThrow(/pertence a outro vault/);
    rmSync(home, { recursive: true, force: true });
  });

  it("modo definicoes não inicia nem cria contexto", async () => {
    const g = globalThis as { __fixtureOkIniciar?: number };
    g.__fixtureOkIniciar = 0;
    const b = await comModulos({ ok: mod("ok") });
    const reg = await loadModules(b, { modo: "definicoes" });
    expect(reg.get("ok")).toMatchObject({ status: "ativo" });
    expect(reg.get("ok")!.ctx).toBeUndefined();
    expect(reg.get("ok")!.def?.nome).toBe("Ok");
    expect(g.__fixtureOkIniciar).toBe(0);
  });

  it("sem deps: ia indisponível e avisos no-op; com deps: delega com o id", async () => {
    const b = await comModulos({ ok: mod("ok") });
    const reg = await loadModules(b, { modo: "serve" });
    const ctx = reg.get("ok")!.ctx!;
    expect(await ctx.ia.completar({ prompt: "x" })).toEqual({ ok: false, tipo: "erro", mensagem: "IA indisponível" });
    await expect(ctx.avisar({ titulo: "t" })).resolves.toBeUndefined();
    const chamadas: unknown[] = [];
    const reg2 = await loadModules(b, { modo: "serve", deps: {
      iaPara: (id) => ({ completar: async () => ({ ok: true, dados: id }) }),
      avisos: { avisar: async (m, a) => { chamadas.push(["avisar", m, a.titulo]); }, badge: (m, n) => { chamadas.push(["badge", m, n]); } },
    } });
    const c2 = reg2.get("ok")!.ctx!;
    expect(await c2.ia.completar({ prompt: "x" })).toEqual({ ok: true, dados: "ok" });
    await c2.avisar({ titulo: "olá" }); c2.badge(3);
    expect(chamadas).toEqual([["avisar", "ok", "olá"], ["badge", "ok", 3]]);
  });

  it("stopModules chama parar e tolera erro", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-modstop-"));
    writeFileSync(join(dir, "package.json"), '{"type":"module","exports":{".":"./index.js"}}');
    writeFileSync(join(dir, "index.js"), 'export default { sdk: 1, id: "para", nome: "P", versao: "1", async parar() { throw new Error("nao para"); } };');
    const b = await comModulos({ para: { path: dir } });
    const reg = await loadModules(b, { modo: "serve" });
    await stopModules(reg, 100);
    expect(reg.errors("para")[0]).toMatchObject({ onde: "parar", mensagem: "nao para" });
  });
});

describe("registry de erros", () => {
  it("mantém só os 50 últimos de cada módulo", async () => {
    const b = await comModulos({});
    const reg = await loadModules(b, { modo: "serve" });
    for (let i = 0; i < 60; i++) reg.recordError("a", "rota", new Error(`e${i}`));
    reg.recordError("b", "rota", new Error("b0"));
    const a = reg.errors("a");
    expect(a).toHaveLength(50);
    expect(a[0]!.mensagem).toBe("e10");
    expect(a[49]!.mensagem).toBe("e59");
    expect(reg.errors("b")).toHaveLength(1);
  });
});

describe("resolveModuleDir e validar", () => {
  it("ordem: path (~/$VAR), BRAIN_MODULES_DIR, padrão", () => {
    const env = { HOME: "/h", BRAIN_MODULES_DIR: "/mods", X: "/x" } as NodeJS.ProcessEnv;
    expect(resolveModuleDir("m", { path: "~/a/$X/b" }, env)).toBe("/h/a//x/b");
    expect(resolveModuleDir("m", {}, env)).toBe("/mods/m");
    expect(resolveModuleDir("m", {}, { HOME: "/h" } as NodeJS.ProcessEnv)).toBe("/h/.local/share/second-brain/modules/m");
  });

  it("caminho relativo é recusado (o cwd do serve e o do MCP divergem)", () => {
    expect(() => resolveModuleDir("m", {}, { HOME: "/h", BRAIN_MODULES_DIR: "mods" } as NodeJS.ProcessEnv)).toThrow("BRAIN_MODULES_DIR deve ser absoluto");
    expect(() => resolveModuleDir("m", { path: "./mods/m" }, { HOME: "/h" } as NodeJS.ProcessEnv)).toThrow("modules.m.path deve ser absoluto");
    // relativo DEPOIS da expansão: variável ausente vira vazio
    expect(() => resolveModuleDir("m", { path: "$NAO_TEM/m" }, { HOME: "/h" } as NodeJS.ProcessEnv)).not.toThrow(); // "/m": absoluto
    expect(() => resolveModuleDir("m", { path: "${REL}/m" }, { HOME: "/h", REL: "rel" } as NodeJS.ProcessEnv)).toThrow("deve ser absoluto");
    expect(resolveModuleDir("m", { path: "$BASE/m" }, { HOME: "/h", BASE: "/b" } as NodeJS.ProcessEnv)).toBe("/b/m");
  });

  it("validar junta path: message e aceita schema sem instanceof", async () => {
    const s = { "~standard": { version: 1 as const, vendor: "t", validate: () => ({ issues: [{ message: "ruim", path: ["a", { key: "b" }] }, { message: "geral" }] }) } };
    expect(await validar(s, {})).toEqual({ ok: false, mensagem: "a.b: ruim; geral" });
    expect(await validar({ "~standard": { version: 1 as const, vendor: "t", validate: async (v) => ({ value: v }) } }, 3)).toEqual({ ok: true, value: 3 });
  });
});
