import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AvisosStore, Brain, ModuleRegistry, loadConfig, modulesStateRoot, setReviewerPassphrase, type ResumoDoModulo } from "@brain/core";
import type { ModuleDef } from "@brain/module-sdk";
import { issueHumanSession, startApi, type ApiHandle, type ModulesApiOptions } from "../src/index.js";
import { conferirEmProcessoFilho } from "../../cli/src/modules.js";
import { terminalHuman } from "../../core/test/helpers.js";

// Gerenciamento de módulos pela UI (spec gerenciar-modulos §7.2, §7.3, §7.5): só a sessão humana `full`, frase-senha para
// adicionar e ligar, ticket de conferência e o atalho de `PUT /api/settings` fechado.
const LEMBRETE = resolve(import.meta.dirname, "../../../examples/modules/lembrete");
const CLI_BIN = fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url));
const MENSAGEM = "Módulo adicionado. O brain serve será reiniciado para aplicar as alterações.";
const FRASE = "frase certa do revisor";
const savedState = process.env.BRAIN_STATE_DIR;

let dir: string; let brain: Brain; let root: string;
/** pasta de módulo com espaço e acento e um symlink para ela */
let pasta: string; let link: string;
let registry: ModuleRegistry; let avisos: AvisosStore;
const abertas: ApiHandle[] = [];

const resumo = (id = "lembrete"): ResumoDoModulo => ({ id, nome: "Lembrete", versao: "0.1.0", sdk: 1, tarefas: [], ferramentas: [], rotas: { total: 0, humanas: 0 }, usaIa: false });
type Conferir = NonNullable<ModulesApiOptions["conferir"]>;
/** `conferir` falso: módulo = pasta com package.json; `{ horario: "x" }` é config inválida. */
function conferirFalso(chamadas: Array<[string, unknown]> = []): Conferir {
  return async (caminho, config) => {
    chamadas.push([caminho, config]);
    if (!existsSync(join(caminho, "package.json"))) {
      return { ok: false, causas: [`não é um pacote de módulo (sem package.json): ${caminho}`], ...(config !== undefined ? { config: { ok: false as const, erros: [{ campo: "", mensagem: "módulo não conferido" }] } } : {}) };
    }
    const cfg = config === undefined ? undefined
      : (config as { horario?: unknown } | null)?.horario === "x" ? { ok: false as const, erros: [{ campo: "horario", mensagem: "horário inválido" }] }
      : { ok: true as const };
    return { ok: true, causas: [], resumo: resumo(), ...(cfg ? { config: cfg } : {}) };
  };
}

/** Escreve `modules` no config.yaml como o usuário faria (JSON é YAML válido). */
function gravarModulos(modules: Record<string, unknown>) {
  const cfg = brain.vault.configPath;
  writeFileSync(cfg, `${readFileSync(cfg, "utf8").replace(/^modules:.*$/m, "").trimEnd()}\nmodules: ${JSON.stringify(modules)}\n`, "utf8");
}
const modulosEmDisco = () => loadConfig(brain.vault.configPath).modules;

interface Subida { api: ApiHandle; ui: string; ui2: string; desk: string; pagina: string; sessions: { file: string } }
async function subir(o: Partial<ModulesApiOptions> & { frase?: string } = {}): Promise<Subida> {
  const sdir = mkdtempSync(join(dir, "sess-"));
  const sessions = { file: join(sdir, "sessions.json") };
  const proof = await terminalHuman("alice", sessions);
  if (o.frase) setReviewerPassphrase(o.frase, proof, sessions);
  const { frase: _f, ...mods } = o;
  const api = await startApi(brain, { port: 0, sessions, modules: { registry, avisos, root, conferir: conferirFalso(), ...mods } });
  abertas.push(api);
  const ui = issueHumanSession(brain.vault.root, proof, sessions);
  const ui2 = issueHumanSession(brain.vault.root, proof, sessions);
  const desk = issueHumanSession(brain.vault.root, proof, { ...sessions, scope: "desktop", label: "desktop" });
  const r = await fetch(`${api.url}/api/modules/lembrete/ui-token`, { method: "POST", headers: { authorization: `Bearer ${ui}` } });
  const pagina = ((await r.json()) as { token: string }).token;
  return { api, ui, ui2, desk, pagina, sessions };
}

const call = (api: ApiHandle, t: string, method: string, p: string, body?: unknown) =>
  fetch(api.url + p, { method, headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const G = "/api/modules/_gerenciar";

async function inspecionar(s: Subida, caminho: string, extra: Record<string, unknown> = {}, token = s.ui) {
  const r = await call(s.api, token, "POST", `${G}/inspecionar`, { caminho, ...extra });
  return { status: r.status, corpo: await r.json() as { ok?: boolean; causas?: string[]; resumo?: ResumoDoModulo; ticket?: string; error?: string; message?: string } };
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "brain-gerenciar-")));
  process.env.BRAIN_STATE_DIR = join(dir, "state");
  brain = await Brain.init(join(dir, "vault"));
  root = modulesStateRoot(brain);
  pasta = join(dir, "projetos", "módulo horas");
  mkdirSync(pasta, { recursive: true });
  writeFileSync(join(pasta, "package.json"), JSON.stringify({ name: "horas", version: "1.0.0", type: "module" }));
  link = join(dir, "link-horas");
  symlinkSync(pasta, link);
  avisos = new AvisosStore(root);
  registry = new ModuleRegistry(root);
  // o `lembrete` carregado neste serve (o token de página e o "configurar módulo que carrega" dependem dele)
  registry.add({ id: "lembrete", dir: pasta, status: "ativo", def: { sdk: 1, id: "lembrete", nome: "Lembrete", versao: "0.1.0" } as ModuleDef, versao: "0.1.0" });
});
afterAll(async () => {
  for (const a of abertas) await a.close();
  brain.close(); rmSync(dir, { recursive: true, force: true });
  if (savedState === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = savedState;
});

describe("matriz", () => {
  it("api-token, desktop e token de página → 403 nas 6 rotas; sessão full → não 403", async () => {
    gravarModulos({});
    const s = await subir({ reiniciarServe: async () => {} });
    const rotas: Array<[string, string, unknown?]> = [
      ["GET", `/api/fs/pastas?caminho=${encodeURIComponent(dir)}`],
      ["POST", `${G}/inspecionar`, { caminho: pasta }],
      ["POST", `${G}/adicionar`, { ticket: "x", config: {} }],
      ["PUT", `${G}/fantasma`, { enabled: false }],
      ["DELETE", `${G}/fantasma`],
      ["POST", `${G}/reiniciar`, {}],
    ];
    for (const [m, p, b] of rotas) {
      for (const t of [s.api.token, s.desk, s.pagina]) expect([m, p, (await call(s.api, t, m, p, b)).status]).toEqual([m, p, 403]);
      expect((await call(s.api, s.ui, m, p, b)).status, `${m} ${p}`).not.toBe(403);
    }
    // o api-token passa `_mcp` adiante: `_gerenciar` não é um módulo, nem com o sufixo `_mcp`
    expect((await call(s.api, s.api.token, "POST", `${G}/_mcp/x`, {})).status).toBe(403);
    expect((await call(s.api, s.api.token, "GET", "/api/fs/pastas")).status).toBe(403);
  });
});

describe("inspecionar e frase-senha", () => {
  it("inspecionar sem frase configurada: conferência real do lembrete, com ticket", async () => {
    const s = await subir({ conferir: (c, cfg) => conferirEmProcessoFilho(c, cfg, { bin: CLI_BIN }) });
    const r = await inspecionar(s, LEMBRETE);
    expect(r.status).toBe(200);
    expect(r.corpo.ok).toBe(true);
    expect(r.corpo.resumo?.id).toBe("lembrete");
    expect(r.corpo.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("pasta que não é módulo: sem ticket; caminho relativo → 400", async () => {
    const s = await subir();
    const vazia = mkdtempSync(join(dir, "vazia-"));
    const r = await inspecionar(s, vazia);
    expect(r.status).toBe(200);
    expect(r.corpo).toMatchObject({ ok: false });
    expect(r.corpo.causas?.[0]).toContain("package.json");
    expect(r.corpo.ticket).toBeUndefined();
    expect((await inspecionar(s, "projetos/x")).status).toBe(400);
  });

  it("frase-senha: exigida para inspecionar e para ligar; configurar um ligado não exige", async () => {
    gravarModulos({ lembrete: { path: pasta, enabled: false } });
    const s = await subir({ frase: FRASE, reiniciarServe: async () => {} });
    const sem = await inspecionar(s, pasta);
    expect(sem.status).toBe(403);
    expect(sem.corpo).toEqual({ error: "frase_senha", message: "este vault exige a frase-senha do revisor" });
    const errada = await inspecionar(s, pasta, { fraseSenha: "nao e esta" });
    expect(errada.status).toBe(403);
    expect(errada.corpo).toEqual({ error: "frase_senha", message: "frase-senha incorreta" });
    expect((await inspecionar(s, pasta, { fraseSenha: FRASE })).status).toBe(200);

    expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { enabled: true })).status).toBe(403);
    expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { enabled: true, config: { horario: "09:00" } })).status).toBe(403);
    expect(modulosEmDisco().lembrete?.enabled).toBe(false);
    expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { enabled: true, fraseSenha: FRASE })).status).toBe(200);
    expect(modulosEmDisco().lembrete?.enabled).toBe(true);
    // já ligado: mudar só a config (ou desligar) é só sessão
    expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { config: { horario: "09:00" } })).status).toBe(200);
    expect(modulosEmDisco().lembrete?.config).toEqual({ horario: "09:00" });
    expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { enabled: false })).status).toBe(200);
    expect(modulosEmDisco().lembrete?.enabled).toBe(false);
  });

  it("limite de tentativas da frase-senha: 5 erradas → a 6ª (mesmo certa) → 429 até a janela passar", async () => {
    let agora = Date.now();
    const s = await subir({ frase: FRASE, relogio: () => agora });
    for (let i = 0; i < 5; i++) expect((await inspecionar(s, pasta, { fraseSenha: `errada ${i}` })).status).toBe(403);
    const bloqueada = await inspecionar(s, pasta, { fraseSenha: FRASE });
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.corpo.error).toBe("tentativas");
    agora += 59_000;
    expect((await inspecionar(s, pasta, { fraseSenha: FRASE })).status).toBe(429);
    agora += 2_000;
    expect((await inspecionar(s, pasta, { fraseSenha: FRASE })).status).toBe(200);
  });
});

describe("adicionar", () => {
  it("adicionar grava path real (via symlink), host só com soNestaMaquina, e reinicia depois de responder", async () => {
    gravarModulos({});
    const chamadas: Array<[string, unknown]> = [];
    let reinicios = 0;
    const s: { api?: ApiHandle } = {};
    // como o reinício real: fecha a API (e todas as conexões); se viesse antes da resposta, o fetch falharia
    const sub = await subir({ conferir: conferirFalso(chamadas), reiniciarServe: async () => { reinicios++; abertas.splice(abertas.indexOf(s.api!), 1); await s.api!.close(); } });
    s.api = sub.api;
    const i = await inspecionar(sub, link);
    expect(i.status).toBe(200);
    expect(chamadas[0]).toEqual([pasta, undefined]);
    const r = await call(sub.api, sub.ui, "POST", `${G}/adicionar`, { ticket: i.corpo.ticket, config: { horario: "08:30" }, soNestaMaquina: false });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ mensagem: MENSAGEM });
    expect(chamadas[1]).toEqual([pasta, { horario: "08:30" }]);
    expect(modulosEmDisco().lembrete).toMatchObject({ enabled: true, path: pasta, config: { horario: "08:30" } });
    expect(modulosEmDisco().lembrete?.host).toBeUndefined();
    for (let n = 0; n < 50 && !reinicios; n++) await new Promise((ok) => setTimeout(ok, 20));
    expect(reinicios).toBe(1);

    // de novo, com "só nesta máquina" e sem reiniciarServe: `reiniciar: true` na resposta
    gravarModulos({});
    const s2 = await subir();
    const t2 = (await inspecionar(s2, pasta)).corpo.ticket;
    const r2 = await call(s2.api, s2.ui, "POST", `${G}/adicionar`, { ticket: t2, config: { horario: "08:30" }, soNestaMaquina: true });
    expect(await r2.json()).toEqual({ mensagem: MENSAGEM, reiniciar: true });
    expect(modulosEmDisco().lembrete).toMatchObject({ path: pasta, host: hostname() });
    // o ticket é consumido
    gravarModulos({});
    expect((await call(s2.api, s2.ui, "POST", `${G}/adicionar`, { ticket: t2, config: {} })).status).toBe(409);
  });

  it("ticket de outro processo ou expirado → 409", async () => {
    gravarModulos({});
    let agora = Date.now();
    const s = await subir({ relogio: () => agora });
    const inventado = await call(s.api, s.ui, "POST", `${G}/adicionar`, { ticket: "A".repeat(43), config: {} });
    expect(inventado.status).toBe(409);
    expect((await inventado.json()).error).toBe("ticket_invalido");
    // ticket emitido por outro serve (outro processo): não existe neste
    const outro = await subir();
    const deOutro = (await inspecionar(outro, pasta)).corpo.ticket;
    expect((await call(s.api, s.ui, "POST", `${G}/adicionar`, { ticket: deOutro, config: {} })).status).toBe(409);
    // ticket de outra sessão
    const t = (await inspecionar(s, pasta)).corpo.ticket;
    const outraSessao = await call(s.api, s.ui2, "POST", `${G}/adicionar`, { ticket: t, config: {} });
    expect(outraSessao.status).toBe(409);
    expect((await outraSessao.json()).error).toBe("ticket_invalido");
    // expirado: 15 min + 1 s
    agora += 15 * 60_000 + 1000;
    expect((await call(s.api, s.ui, "POST", `${G}/adicionar`, { ticket: t, config: {} })).status).toBe(409);
    expect(modulosEmDisco()).toEqual({});
  });

  it("id já configurado → 409 com o caminho; config inalterada", async () => {
    gravarModulos({ lembrete: { path: "/outra/pasta/lembrete" } });
    const antes = readFileSync(brain.vault.configPath, "utf8");
    const s = await subir();
    const t = (await inspecionar(s, pasta)).corpo.ticket;
    const r = await call(s.api, s.ui, "POST", `${G}/adicionar`, { ticket: t, config: {} });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "id_existente", caminho: "/outra/pasta/lembrete" });
    expect(readFileSync(brain.vault.configPath, "utf8")).toBe(antes);
  });

  it("config inválida → 400 com os erros por campo; nada gravado; o ticket continua valendo", async () => {
    gravarModulos({});
    const s = await subir();
    const t = (await inspecionar(s, pasta)).corpo.ticket;
    const r = await call(s.api, s.ui, "POST", `${G}/adicionar`, { ticket: t, config: { horario: "x" } });
    expect(r.status).toBe(400);
    const j = await r.json() as { error: string; erros: Array<{ campo: string }> };
    expect(j.error).toBe("config_invalida");
    expect(j.erros[0]!.campo).toBe("horario");
    expect(modulosEmDisco()).toEqual({});
    // segredo na config: recusado mesmo que a conferência deixe passar
    const seg = await call(s.api, s.ui, "POST", `${G}/adicionar`, { ticket: t, config: { token: "ghp_" + "a".repeat(36) } });
    expect(seg.status).toBe(400);
    expect(JSON.stringify(await seg.json())).not.toContain("ghp_");
    expect(modulosEmDisco()).toEqual({});
    expect((await call(s.api, s.ui, "POST", `${G}/adicionar`, { ticket: t, config: { horario: "07:00" } })).status).toBe(200);
  });
});

describe("configurar, remover e reiniciar", () => {
  it("remover não apaga a pasta nem o estado", async () => {
    gravarModulos({ lembrete: { path: pasta } });
    mkdirSync(join(root, "lembrete"), { recursive: true });
    writeFileSync(join(root, "lembrete", "dados.json"), "{}");
    let reinicios = 0;
    const s = await subir({ reiniciarServe: async () => { reinicios++; } });
    const r = await call(s.api, s.ui, "DELETE", `${G}/lembrete`);
    expect(r.status).toBe(200);
    expect(existsSync(join(pasta, "package.json"))).toBe(true);
    expect(existsSync(join(root, "lembrete", "dados.json"))).toBe(true);
    expect(modulosEmDisco().lembrete).toBeUndefined();
    expect((await call(s.api, s.ui, "DELETE", `${G}/lembrete`)).status).toBe(404);
    for (let n = 0; n < 50 && !reinicios; n++) await new Promise((ok) => setTimeout(ok, 20));
    expect(reinicios).toBe(1);
  });

  it("módulo falho: configurar sem schema mas com scanSecrets", async () => {
    gravarModulos({ quebrado: { path: join(dir, "nao-existe") } });
    const chamadas: Array<[string, unknown]> = [];
    const s = await subir({ conferir: conferirFalso(chamadas) });
    expect((await call(s.api, s.ui, "PUT", `${G}/quebrado`, { config: { a: 1 } })).status).toBe(200);
    expect(modulosEmDisco().quebrado?.config).toEqual({ a: 1 });
    const seg = await call(s.api, s.ui, "PUT", `${G}/quebrado`, { config: { token: "ghp_" + "b".repeat(36) } });
    expect(seg.status).toBe(400);
    expect(JSON.stringify(await seg.json())).not.toContain("ghp_");
    expect(modulosEmDisco().quebrado?.config).toEqual({ a: 1 });
    expect(chamadas).toEqual([]); // não carrega: nada da pasta roda
    expect((await call(s.api, s.ui, "PUT", `${G}/fantasma`, { config: {} })).status).toBe(404);
  });

  it("configurar um módulo que carrega: valida no processo filho; soNestaMaquina grava e tira o host", async () => {
    gravarModulos({ lembrete: { path: pasta, config: { horario: "10:00" } } });
    const chamadas: Array<[string, unknown]> = [];
    const s = await subir({ conferir: conferirFalso(chamadas) });
    const r = await call(s.api, s.ui, "PUT", `${G}/lembrete`, { config: { horario: "x" } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("config_invalida");
    expect(chamadas).toEqual([[pasta, { horario: "x" }]]);
    expect(modulosEmDisco().lembrete?.config).toEqual({ horario: "10:00" });
    expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { soNestaMaquina: true })).status).toBe(200);
    expect(modulosEmDisco().lembrete?.host).toBe(hostname());
    expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { soNestaMaquina: false })).status).toBe(200);
    expect(modulosEmDisco().lembrete?.host).toBeUndefined();
    expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, {})).status).toBe(400);
    expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { enabled: "sim" })).status).toBe(400);
  });

  it("config.yaml com erro de edição: 400 com a mensagem do Brain", async () => {
    gravarModulos({ quebrado: { path: join(dir, "nao-existe") } });
    const s = await subir();
    const cfg = brain.vault.configPath;
    const bom = readFileSync(cfg, "utf8");
    writeFileSync(cfg, `${bom}\nisto: [nao fecha\n`, "utf8");
    try {
      const r = await call(s.api, s.ui, "PUT", `${G}/quebrado`, { enabled: false });
      expect(r.status).toBe(400);
      expect((await r.json()).message).toContain("erro de edição");
    } finally { writeFileSync(cfg, bom, "utf8"); }
  });

  it("reiniciar: dispara o reinício depois da resposta", async () => {
    let reinicios = 0;
    const s = await subir({ reiniciarServe: async () => { reinicios++; } });
    const r = await call(s.api, s.ui, "POST", `${G}/reiniciar`, {});
    expect(r.status).toBe(200);
    for (let n = 0; n < 50 && !reinicios; n++) await new Promise((ok) => setTimeout(ok, 20));
    expect(reinicios).toBe(1);
    // sem reiniciarServe: a resposta pede o reinício
    const s2 = await subir();
    expect(await (await call(s2.api, s2.ui, "POST", `${G}/reiniciar`, {})).json()).toMatchObject({ reiniciar: true });
  });
});

describe("rotas do core", () => {
  it("settings recusa modules e review", async () => {
    const s = await subir();
    const m = await call(s.api, s.ui, "PUT", "/api/settings", { modules: {} });
    expect(m.status).toBe(403);
    expect(await m.json()).toMatchObject({ error: "forbidden", message: "use Configurações › Módulos" });
    const rv = await call(s.api, s.ui, "PUT", "/api/settings", { review: { passphrase_required: false } });
    expect(rv.status).toBe(403);
    expect(await rv.json()).toMatchObject({ error: "forbidden", message: "a frase-senha se configura no terminal (brain admin passphrase)" });
    expect((await call(s.api, s.ui, "PUT", "/api/settings", { git: { auto_commit: false } })).status).toBe(200);
  });

  it("fs/pastas: relativo → 400; sessão → lista; api-token → 403", async () => {
    const s = await subir();
    expect((await call(s.api, s.ui, "GET", "/api/fs/pastas?caminho=projetos")).status).toBe(400);
    const r = await call(s.api, s.ui, "GET", `/api/fs/pastas?caminho=${encodeURIComponent(join(dir, "projetos"))}`);
    expect(r.status).toBe(200);
    expect((await r.json()).pastas).toEqual([{ nome: "módulo horas", caminho: pasta, provavelModulo: false }]);
    expect((await call(s.api, s.api.token, "GET", `/api/fs/pastas?caminho=${encodeURIComponent(dir)}`)).status).toBe(403);
    const semPermissao = join(dir, "trancada");
    mkdirSync(semPermissao, { mode: 0o000 });
    try {
      const t = await call(s.api, s.ui, "GET", `/api/fs/pastas?caminho=${encodeURIComponent(semPermissao)}`);
      // root lê qualquer pasta: o 403 só vale para quem não tem permissão
      if (process.getuid?.() !== 0) { expect(t.status).toBe(403); expect((await t.json()).message).toContain("sem permissão"); }
    } finally { chmodSync(semPermissao, 0o700); rmSync(semPermissao, { recursive: true, force: true }); }
  });
});
