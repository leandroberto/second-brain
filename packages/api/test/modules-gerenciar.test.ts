import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AvisosStore, Brain, ModuleRegistry, loadConfig, modulesStateRoot, setReviewerPassphrase, type ResumoDoModulo } from "@brain/core";
import type { ModuleDef } from "@brain/module-sdk";
import { issueHumanSession, startApi, type ApiHandle, type ModulesApiOptions } from "../src/index.js";
import { umaVezAoTerminar } from "../src/modules-gerenciar.js";
import { terminalHuman } from "../../core/test/helpers.js";

// Gerenciamento de módulos pela UI (spec gerenciar-modulos §7.2, §7.3, §7.5): só a sessão humana `full`, frase-senha para
// adicionar e ligar, ticket de conferência e o atalho de `PUT /api/settings` fechado.
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
  const sessions = { file: join(mkdtempSync(join(dir, "sess-")), "sessions.json") };
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
// os erros de frase-senha persistem no estado (sobrevivem ao reinício): cada teste começa sem eles
beforeEach(() => { rmSync(join(root, "_frase-erros.json"), { force: true }); });
afterAll(async () => {
  for (const a of abertas) await a.close();
  brain.close(); rmSync(dir, { recursive: true, force: true });
  if (savedState === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = savedState;
});

describe("matriz", () => {
  it("api-token, desktop e token de página → 403 nas 7 rotas; sessão full → não 403", async () => {
    gravarModulos({});
    const s = await subir({ reiniciarServe: async () => {} });
    const rotas: Array<[string, string, unknown?]> = [
      ["GET", `/api/fs/pastas?caminho=${encodeURIComponent(dir)}`],
      ["POST", `${G}/inspecionar`, { caminho: pasta }],
      ["POST", `${G}/adicionar`, { ticket: "x", config: {} }],
      ["PUT", `${G}/fantasma`, { enabled: false }],
      ["DELETE", `${G}/fantasma`],
      ["POST", `${G}/reiniciar`, {}],
      ["GET", `${G}/estado`],
    ];
    for (const [m, p, b] of rotas) {
      for (const t of [s.api.token, s.desk, s.pagina]) expect([m, p, (await call(s.api, t, m, p, b)).status]).toEqual([m, p, 403]);
      expect((await call(s.api, s.ui, m, p, b)).status, `${m} ${p}`).not.toBe(403);
    }
    // o api-token passa `_mcp` adiante: `_gerenciar` não é um módulo, nem com o sufixo `_mcp`
    expect((await call(s.api, s.api.token, "POST", `${G}/_mcp/x`, {})).status).toBe(403);
    expect((await call(s.api, s.api.token, "GET", "/api/fs/pastas")).status).toBe(403);
  });

  it("variações do caminho (`//`, `%2F`, maiúsculas, barra final) não abrem nada para api-token, desktop e página", async () => {
    gravarModulos({});
    let reinicios = 0;
    const s = await subir({ reiniciarServe: async () => { reinicios++; } });
    const fs = encodeURIComponent(dir);
    const variacoes: Array<[string, string]> = [
      ["POST", "/api/modules//_gerenciar/reiniciar"], ["POST", "/api/modules/_gerenciar//reiniciar"],
      ["POST", "/api/modules/_gerenciar%2Freiniciar"], ["POST", "/api/modules/%5Fgerenciar/reiniciar"],
      ["POST", "/api/modules/_GERENCIAR/reiniciar"], ["POST", "/api/modules/_gerenciar/reiniciar/"],
      ["POST", "/api/modules/_gerenciar/_mcp/reiniciar"], ["POST", "/api/modules/_gerenciar%2F_mcp%2Fx"],
      ["GET", `/api/fs/pastas/?caminho=${fs}`], ["GET", `/api/fs//pastas?caminho=${fs}`], ["GET", `/api//fs/pastas?caminho=${fs}`],
      ["GET", `/api/fs%2Fpastas?caminho=${fs}`], ["GET", `/api/FS/pastas?caminho=${fs}`], ["GET", `/API/fs/pastas?caminho=${fs}`],
    ];
    for (const [m, p] of variacoes) {
      for (const t of [s.api.token, s.desk, s.pagina]) {
        const r = await call(s.api, t, m, p, m === "POST" ? {} : undefined);
        const texto = await r.text();
        // nunca a resposta da rota: nem a listagem de pastas, nem o reinício
        expect([m, p, r.status === 200 && (texto.includes("pastas") || texto.includes("reiniciado"))]).toEqual([m, p, false]);
        if (p.startsWith("/api/")) expect([m, p, [403, 404].includes(r.status)]).toEqual([m, p, true]);
      }
    }
    await new Promise((ok) => setTimeout(ok, 50));
    expect(reinicios).toBe(0);
  });
});

describe("inspecionar e frase-senha", () => {
  it("inspecionar sem frase configurada: resumo e ticket", async () => {
    const s = await subir();
    const r = await inspecionar(s, pasta);
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
    expect(sem.corpo).toEqual({ error: "frase_senha", motivo: "exigida", message: "este vault exige a frase-senha do revisor" });
    const errada = await inspecionar(s, pasta, { fraseSenha: "nao e esta" });
    expect(errada.status).toBe(403);
    expect(errada.corpo).toEqual({ error: "frase_senha", motivo: "errada", message: "frase-senha incorreta" });
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

  it("estado: diz à tela se o vault tem (ou exige) a frase-senha", async () => {
    const sem = await subir();
    expect(await (await call(sem.api, sem.ui, "GET", `${G}/estado`)).json()).toEqual({ fraseSenha: false });
    const com = await subir({ frase: FRASE });
    expect(await (await call(com.api, com.ui, "GET", `${G}/estado`)).json()).toEqual({ fraseSenha: true });
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

  it("o limite sobrevive ao reinício, e com erro de frase na janela nada que amplie ou reinicie passa", async () => {
    gravarModulos({ lembrete: { path: pasta } });
    let agora = Date.now();
    let reinicios = 0;
    const s = await subir({ frase: FRASE, relogio: () => agora, reiniciarServe: async () => { reinicios++; } });
    expect((await inspecionar(s, pasta, { fraseSenha: "errada" })).status).toBe(403);
    // um erro na janela: as rotas que ampliam ou reiniciam com código novo respondem 429 (reiniciar não zera o limite)
    for (const [m, p, b] of [["POST", `${G}/reiniciar`, {}], ["PUT", `${G}/lembrete`, { config: { horario: "09:00" } }], ["POST", `${G}/adicionar`, { ticket: "x" }]] as const) {
      const r = await call(s.api, s.ui, m, p, b);
      expect([m, p, r.status, (await r.json()).error]).toEqual([m, p, 429, "tentativas"]);
    }
    expect(reinicios).toBe(0);
    expect(modulosEmDisco().lembrete).toBeDefined();
    for (let i = 0; i < 4; i++) await inspecionar(s, pasta, { fraseSenha: `errada ${i}` });
    // "reinício": outro processo (instância nova da API) com o mesmo estado, as mesmas sessões e a mesma frase
    const api2 = await startApi(brain, { port: 0, sessions: s.sessions, modules: { registry, avisos, root, conferir: conferirFalso(), relogio: () => agora } });
    abertas.push(api2);
    const depois = { ...s, api: api2 };
    expect((await inspecionar(depois, pasta, { fraseSenha: FRASE })).status).toBe(429);
    agora += 61_000;
    expect((await inspecionar(depois, pasta, { fraseSenha: FRASE })).status).toBe(200);
    expect((await call(depois.api, depois.ui, "POST", `${G}/reiniciar`, {})).status).toBe(200);
  });

  it("com erro de frase na janela, o que só restringe passa: desligar, restringir ao host e remover → 200; configurar e reiniciar → 429; ligar segue pedindo a frase", async () => {
    gravarModulos({ lembrete: { path: pasta, enabled: true }, outro: { path: pasta, enabled: true }, terceiro: { path: pasta, enabled: false } });
    let reinicios = 0;
    const s = await subir({ frase: FRASE, reiniciarServe: async () => { reinicios++; } });
    expect((await inspecionar(s, pasta, { fraseSenha: "errada" })).status).toBe(403);
    const status = async (m: string, p: string, b?: unknown) => (await call(s.api, s.ui, m, p, b)).status;
    expect(await status("PUT", `${G}/lembrete`, { enabled: false })).toBe(200);
    expect(modulosEmDisco().lembrete?.enabled).toBe(false);
    expect(await status("PUT", `${G}/outro`, { soNestaMaquina: true })).toBe(200);
    expect(modulosEmDisco().outro?.host).toBe(hostname());
    expect(await status("DELETE", `${G}/outro`)).toBe(200);
    expect(modulosEmDisco().outro).toBeUndefined();
    // desligar junto com uma config nova não é só restringir
    expect(await status("PUT", `${G}/lembrete`, { enabled: false, config: { horario: "09:00" } })).toBe(429);
    expect(await status("PUT", `${G}/lembrete`, { config: { horario: "09:00" } })).toBe(429);
    expect(await status("POST", `${G}/reiniciar`, {})).toBe(429);
    // ligar continua exigindo a frase (sem ela, 403); só a certa zera a janela
    expect(await status("PUT", `${G}/terceiro`, { enabled: true })).toBe(403);
    expect(modulosEmDisco().terceiro?.enabled).toBe(false);
    for (let n = 0; n < 50 && reinicios < 3; n++) await new Promise((ok) => setTimeout(ok, 20));
    expect(reinicios).toBe(3);
  });

  it("PUT sem efeito → 200 \"nada mudou\" sem gravar, sem auditar e sem reiniciar (também com erro de frase na janela)", async () => {
    let reinicios = 0;
    const s = await subir({ frase: FRASE, reiniciarServe: async () => { reinicios++; } });
    const casos: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ path: pasta, enabled: false }, { enabled: false }],
      [{ path: pasta, enabled: true, host: hostname() }, { soNestaMaquina: true }],
      [{ path: pasta, enabled: true, config: { horario: "09:00" } }, { config: { horario: "09:00" } }],
    ];
    for (const comErro of [false, true]) {
      if (comErro) expect((await inspecionar(s, pasta, { fraseSenha: "errada" })).status).toBe(403);
      for (const [entrada, put] of casos) {
        gravarModulos({ lembrete: entrada });
        const antes = readFileSync(brain.vault.configPath, "utf8");
        const desde = new Date().toISOString();
        const r = await call(s.api, s.ui, "PUT", `${G}/lembrete`, put);
        expect([comErro, put, r.status, await r.json()]).toEqual([comErro, put, 200, { mensagem: "nada mudou" }]);
        expect(readFileSync(brain.vault.configPath, "utf8")).toBe(antes);
        expect(brain.db.activity({ action: "config_update", since: desde })).toEqual([]);
      }
    }
    await new Promise((ok) => setTimeout(ok, 100));
    expect(reinicios).toBe(0);
  });

  it("a frase certa zera os erros: quem errou uma vez e acertou segue sem esperar", async () => {
    gravarModulos({ lembrete: { path: pasta, enabled: false } });
    const s = await subir({ frase: FRASE, reiniciarServe: async () => {} });
    expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { enabled: true, fraseSenha: "errada" })).status).toBe(403);
    expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { enabled: true, fraseSenha: FRASE })).status).toBe(200);
    expect(modulosEmDisco().lembrete?.enabled).toBe(true);
  });

  it("passphrase_required sem a frase nesta máquina: falha fechada", async () => {
    gravarModulos({ lembrete: { path: pasta, enabled: false } });
    const cfg = brain.vault.configPath;
    const bom = readFileSync(cfg, "utf8");
    expect(bom).toContain("passphrase_required: false");
    writeFileSync(cfg, bom.replace("passphrase_required: false", "passphrase_required: true"), "utf8");
    try {
      const s = await subir();
      const r = await inspecionar(s, pasta, { fraseSenha: "qualquer uma" });
      expect(r.status).toBe(403);
      expect(r.corpo).toEqual({ error: "frase_senha", motivo: "ausente", message: "este vault exige a frase-senha do revisor, mas ela não foi encontrada nesta máquina" });
      expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { enabled: true })).status).toBe(403);
    } finally { writeFileSync(cfg, bom, "utf8"); }
  });

  it("ligar nesta máquina pelo host (soNestaMaquina) é ligar: exige a frase", async () => {
    const s = await subir({ frase: FRASE, reiniciarServe: async () => {} });
    for (const soNestaMaquina of [true, false]) {
      gravarModulos({ lembrete: { path: pasta, enabled: true, host: "outra-maquina" } });
      const r = await call(s.api, s.ui, "PUT", `${G}/lembrete`, { soNestaMaquina });
      expect([soNestaMaquina, r.status]).toEqual([soNestaMaquina, 403]);
      expect(modulosEmDisco().lembrete?.host).toBe("outra-maquina");
      expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { soNestaMaquina, fraseSenha: FRASE })).status).toBe(200);
      expect(modulosEmDisco().lembrete?.host).toBe(soNestaMaquina ? hostname() : undefined);
    }
    // desligado com host de outra máquina: "só nesta máquina" não liga (continua desligado), então não pede a frase
    gravarModulos({ lembrete: { path: pasta, enabled: false, host: "outra-maquina" } });
    expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { soNestaMaquina: true })).status).toBe(200);
  });

  it("ampliar onde o módulo roda é ligar: desligado → ligado em qualquer host, tirar o host desta máquina; restringir não", async () => {
    const s = await subir({ frase: FRASE, reiniciarServe: async () => {} });
    const casos: Array<[Record<string, unknown>, Record<string, unknown>, number]> = [
      // desligado com host de outra máquina → ligado: no vault sincronizado roda lá
      [{ path: pasta, enabled: false, host: "outra-maquina" }, { enabled: true }, 403],
      // ligado só nesta máquina → sem host: passa a rodar nas outras máquinas do vault
      [{ path: pasta, enabled: true, host: hostname() }, { soNestaMaquina: false }, 403],
      // ligado em toda parte → só nesta máquina: restringe
      [{ path: pasta, enabled: true }, { soNestaMaquina: true }, 200],
    ];
    for (const [entrada, put, status] of casos) {
      gravarModulos({ lembrete: entrada });
      const r = await call(s.api, s.ui, "PUT", `${G}/lembrete`, put);
      expect([entrada, put, r.status]).toEqual([entrada, put, status]);
      if (status === 403) {
        expect(modulosEmDisco().lembrete).toMatchObject(entrada);
        expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { ...put, fraseSenha: FRASE })).status).toBe(200);
      }
    }
    expect(modulosEmDisco().lembrete?.host).toBe(hostname());
  });

  it("registro de tentativas que não dá para ler nem gravar: o limite falha fechado", async () => {
    gravarModulos({ lembrete: { path: pasta, enabled: true } });
    const s = await subir({ frase: FRASE, reiniciarServe: async () => {} });
    const arq = join(root, "_frase-erros.json");
    mkdirSync(arq); // diretório no lugar do arquivo: nem lê nem grava
    try {
      for (const fraseSenha of ["errada", FRASE]) {
        const r = await inspecionar(s, pasta, { fraseSenha });
        expect([fraseSenha, r.status, r.corpo.error]).toEqual([fraseSenha, 429, "tentativas"]);
      }
      expect((await call(s.api, s.ui, "POST", `${G}/reiniciar`, {})).status).toBe(429);
    } finally { rmSync(arq, { recursive: true, force: true }); }
    // ler funciona mas gravar não (disco cheio, sem permissão): a tentativa não é registrada, então a frase nem é conferida —
    // errada e certa respondem igual (sem oráculo nem tentativa sem limite)
    writeFileSync(arq, "[]", { mode: 0o600 });
    chmodSync(root, 0o500);
    try {
      if (process.getuid?.() !== 0) {
        for (const fraseSenha of ["errada", FRASE]) {
          const r = await inspecionar(s, pasta, { fraseSenha });
          expect([fraseSenha, r.status, r.corpo]).toEqual([fraseSenha, 429, { error: "tentativas", message: "não foi possível registrar a tentativa; tente mais tarde" }]);
        }
      }
    } finally { chmodSync(root, 0o700); }
    // gravação de volta: a certa passa e zera a janela (o registro fica vazio, nada bloqueia o reinício)
    expect((await inspecionar(s, pasta, { fraseSenha: FRASE })).status).toBe(200);
    expect(JSON.parse(readFileSync(arq, "utf8"))).toEqual([]);
    expect((await call(s.api, s.ui, "POST", `${G}/reiniciar`, {})).status).toBe(200);
  });

  it("no máximo 2 conferências ao mesmo tempo: a 3ª → 429", async () => {
    let soltar!: () => void;
    const portao = new Promise<void>((ok) => { soltar = ok; });
    const base = conferirFalso();
    let emCurso = 0;
    const s = await subir({ conferir: async (c, cfg) => { emCurso++; await portao; return base(c, cfg); } });
    const a = inspecionar(s, pasta); const b = inspecionar(s, pasta);
    for (let n = 0; n < 100 && emCurso < 2; n++) await new Promise((ok) => setTimeout(ok, 10));
    const terceira = await inspecionar(s, pasta);
    expect(terceira.status).toBe(429);
    expect(terceira.corpo.error).toBe("conferencias");
    soltar();
    expect((await a).status).toBe(200); expect((await b).status).toBe(200);
    expect((await inspecionar(s, pasta)).status).toBe(200);
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

  it("o mesmo ticket em dois adicionar simultâneos: um 200, o outro 409", async () => {
    gravarModulos({});
    let soltar!: () => void;
    const portao = new Promise<void>((ok) => { soltar = ok; });
    const base = conferirFalso();
    const s = await subir({ conferir: async (c, cfg) => { if (cfg !== undefined) await portao; return base(c, cfg); } });
    const t = (await inspecionar(s, pasta)).corpo.ticket;
    const a = call(s.api, s.ui, "POST", `${G}/adicionar`, { ticket: t, config: { horario: "07:00" } });
    const b = call(s.api, s.ui, "POST", `${G}/adicionar`, { ticket: t, config: { horario: "07:00" } });
    await new Promise((ok) => setTimeout(ok, 100));
    soltar();
    expect([(await a).status, (await b).status].sort()).toEqual([200, 409]);
  });

  it("o id mudou entre a conferência e o adicionar → 409 id_mudou; nada gravado; o ticket não volta", async () => {
    gravarModulos({});
    let id = "lembrete";
    const base = conferirFalso();
    const s = await subir({ conferir: async (c, cfg) => { const r = await base(c, cfg); return r.resumo ? { ...r, resumo: resumo(id) } : r; } });
    const t = (await inspecionar(s, pasta)).corpo.ticket;
    id = "outro-id";
    const r = await call(s.api, s.ui, "POST", `${G}/adicionar`, { ticket: t, config: {} });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "id_mudou" });
    expect(modulosEmDisco()).toEqual({});
    id = "lembrete";
    expect((await call(s.api, s.ui, "POST", `${G}/adicionar`, { ticket: t, config: {} })).status).toBe(409);
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

  it("configurar um desligado: valida pelo schema sem frase no vault ou ligando com a frase; com frase e sem ligar, só segredos", async () => {
    const chamadas: Array<[string, unknown]> = [];
    // sem frase configurada: a sessão basta para rodar o código na conferência
    gravarModulos({ lembrete: { path: pasta, enabled: false } });
    const sem = await subir({ conferir: conferirFalso(chamadas) });
    const r1 = await call(sem.api, sem.ui, "PUT", `${G}/lembrete`, { config: { horario: "x" } });
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toBe("config_invalida");
    expect(chamadas).toEqual([[pasta, { horario: "x" }]]);
    // com frase, só configurando o desligado: nada roda, grava (o loader valida quando ele for ligado)
    chamadas.length = 0;
    const com = await subir({ frase: FRASE, conferir: conferirFalso(chamadas) });
    expect((await call(com.api, com.ui, "PUT", `${G}/lembrete`, { config: { horario: "x" } })).status).toBe(200);
    expect(chamadas).toEqual([]);
    expect(modulosEmDisco().lembrete).toMatchObject({ enabled: false, config: { horario: "x" } });
    // com frase, ligando com a frase certa: valida
    const r3 = await call(com.api, com.ui, "PUT", `${G}/lembrete`, { enabled: true, config: { horario: "x" }, fraseSenha: FRASE });
    expect(r3.status).toBe(400);
    expect(chamadas).toEqual([[pasta, { horario: "x" }]]);
    expect(modulosEmDisco().lembrete?.enabled).toBe(false);
  });

  it("configurar e desligar ao mesmo tempo: o desligar não se perde (leitura dentro do lock)", async () => {
    gravarModulos({ lembrete: { path: pasta, enabled: true, config: { horario: "10:00" } } });
    const base = conferirFalso();
    // a conferência da config demora: o desligar grava no meio dela
    const s = await subir({ conferir: async (c, cfg) => { await new Promise((ok) => setTimeout(ok, 200)); return base(c, cfg); } });
    const configurar = call(s.api, s.ui, "PUT", `${G}/lembrete`, { config: { horario: "11:00" } });
    await new Promise((ok) => setTimeout(ok, 50));
    expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, { enabled: false })).status).toBe(200);
    expect((await configurar).status).toBe(200);
    expect(modulosEmDisco().lembrete).toMatchObject({ enabled: false, config: { horario: "11:00" } });
  });

  it("outra edição chega ao mesmo resultado durante a conferência: \"nada mudou\" (leitura dentro do lock), sem auditar nem reiniciar", async () => {
    gravarModulos({ lembrete: { path: pasta, enabled: true, config: { horario: "10:00" } } });
    const base = conferirFalso();
    let reinicios = 0;
    // no meio da conferência, a mesma config chega ao arquivo por fora (edição manual)
    const s = await subir({ reiniciarServe: async () => { reinicios++; }, conferir: async (c, cfg) => { gravarModulos({ lembrete: { path: pasta, enabled: true, config: { horario: "11:00" } } }); return base(c, cfg); } });
    const desde = new Date().toISOString();
    const r = await call(s.api, s.ui, "PUT", `${G}/lembrete`, { config: { horario: "11:00" } });
    expect([r.status, await r.json()]).toEqual([200, { mensagem: "nada mudou" }]);
    expect(brain.db.activity({ action: "config_update", since: desde })).toEqual([]);
    await new Promise((ok) => setTimeout(ok, 100));
    expect(reinicios).toBe(0);
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

  it("a auditoria registra a ação semântica de cada mudança", async () => {
    gravarModulos({});
    const s = await subir({ reiniciarServe: async () => {} });
    const desde = new Date().toISOString();
    const t = (await inspecionar(s, pasta)).corpo.ticket;
    expect((await call(s.api, s.ui, "POST", `${G}/adicionar`, { ticket: t, config: {} })).status).toBe(200);
    for (const b of [{ enabled: false }, { enabled: true }, { config: { horario: "09:00" } }, { soNestaMaquina: true }]) expect((await call(s.api, s.ui, "PUT", `${G}/lembrete`, b)).status).toBe(200);
    expect((await call(s.api, s.ui, "DELETE", `${G}/lembrete`)).status).toBe(200);
    const acoes = brain.db.activity({ action: "config_update", since: desde }).map((a) => (a.detail as { acao?: string }).acao).reverse();
    expect(acoes).toEqual(["adicionar", "desligar", "ligar", "configurar", "restringir_host", "remover"]);
  });

  it("o reinício dispara uma vez só, no fim da resposta ou no fechamento da conexão", () => {
    for (const eventos of [["finish", "close"], ["close"], ["close", "finish"]]) {
      const res = new EventEmitter();
      let n = 0;
      umaVezAoTerminar(res as unknown as ServerResponse, () => { n++; });
      for (const e of eventos) res.emit(e);
      expect([eventos, n]).toEqual([eventos, 1]);
    }
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

  it("settings grava só as chaves que a UI usa: o resto → 403 sem gravar nada", async () => {
    const s = await subir();
    const antes = readFileSync(brain.vault.configPath, "utf8");
    for (const corpo of [{ assistant: { claude_path: "/tmp/outro" } }, { state: { external: true } }, { limits: { max_chars: 1 } }, { git: { auto_commit: true }, assistant: {} }]) {
      const r = await call(s.api, s.ui, "PUT", "/api/settings", corpo);
      expect([corpo, r.status]).toEqual([corpo, 403]);
      expect(await r.json()).toMatchObject({ error: "forbidden", message: "esta configuração não se altera pela UI; use o config.yaml" });
    }
    expect(readFileSync(brain.vault.configPath, "utf8")).toBe(antes);
    for (const corpo of [{ vault_name: brain.config.vault_name }, { embeddings: { provider: "hash" } }, { agents: { can_link: true } }, { governance: { stale_days: brain.config.governance.stale_days } }, { retention: { activity_days: brain.config.retention.activity_days } }, {}]) {
      expect([corpo, (await call(s.api, s.ui, "PUT", "/api/settings", corpo)).status]).toEqual([corpo, 200]);
    }
  });

  it("settings: a lista de permitidas vale por subchave (api_key_env, dimensions, __proto__... → 403 sem gravar nada)", async () => {
    const s = await subir();
    // corpo cru: `__proto__` num literal de objeto não vira chave própria, num JSON recebido vira
    const cru = (corpo: string) => fetch(s.api.url + "/api/settings", { method: "PUT", headers: { authorization: `Bearer ${s.ui}`, "content-type": "application/json" }, body: corpo });
    const antes = readFileSync(brain.vault.configPath, "utf8");
    for (const corpo of [
      '{"embeddings":{"api_key_env":"QUALQUER_VAR"}}',
      '{"embeddings":{"provider":"openai-compatible","base_url":"https://externo.example","external_opt_in":true,"api_key_env":"QUALQUER_VAR"}}',
      '{"embeddings":{"dimensions":3}}',
      '{"embeddings":{"__proto__":{"api_key_env":"QUALQUER_VAR"}}}',
      '{"embeddings":{"constructor":{"prototype":{"x":1}}}}',
      '{"__proto__":{"embeddings":{"api_key_env":"QUALQUER_VAR"}}}',
      '{"constructor":{}}',
      '{"governance":{"keep_history_section":true}}',
      '{"git":{"auto_commit":true,"remoto":"x"}}',
      '{"retention":{"outra":1}}',
      '{"agents":{"per_type":{"inexistente":"auto"}}}',
      '{"agents":{"per_type":{"__proto__":"auto"}}}',
      '{"embeddings":null}', '{"embeddings":[]}', '{"agents":"all"}', '{"agents":{"per_type":["auto"]}}', '{"agents":{"per_type":null}}',
    ]) {
      const r = await cru(corpo);
      expect([corpo, r.status]).toEqual([corpo, 403]);
      expect(await r.json()).toMatchObject({ error: "forbidden", message: "esta configuração não se altera pela UI; use o config.yaml" });
      expect([corpo, readFileSync(brain.vault.configPath, "utf8")]).toEqual([corpo, antes]);
    }
    // valor fora de review|auto num tipo conhecido: inválido, nada gravado
    const ruim = await cru('{"agents":{"per_type":{"decision":"sim"}}}');
    expect(ruim.status).toBe(400);
    expect(readFileSync(brain.vault.configPath, "utf8")).toBe(antes);
    expect(brain.config.embeddings.api_key_env).toBe("OPENAI_API_KEY");
  });

  it("settings: toda gravação atual da tela de Configurações continua 200", async () => {
    const s = await subir();
    const c = brain.config;
    // os mesmos corpos de `apps/web/src/pages3.tsx` (com os valores atuais: trocar o embedder reembutiria tudo)
    for (const corpo of [
      { embeddings: { provider: c.embeddings.provider } }, { embeddings: { base_url: c.embeddings.base_url } }, { embeddings: { model: c.embeddings.model } }, { embeddings: { external_opt_in: false } },
      { git: { auto_commit: c.git.auto_commit } }, { git: { auto_commit_external: c.git.auto_commit_external } },
      { agents: { commit_policy: c.agents.commit_policy } }, { agents: { per_type: { decision: "review" } } }, { agents: { per_type: { "open-question": "auto" } } }, { agents: { can_link: c.agents.can_link } },
      { governance: { duplicate_threshold: c.governance.duplicate_threshold } }, { governance: { candidate_threshold: c.governance.candidate_threshold } }, { governance: { stale_days: c.governance.stale_days } },
      { retention: { activity_days: c.retention.activity_days } }, { vault_name: c.vault_name },
    ]) {
      expect([corpo, (await call(s.api, s.ui, "PUT", "/api/settings", corpo)).status]).toEqual([corpo, 200]);
    }
    expect(brain.config.agents.per_type).toMatchObject({ decision: "review", "open-question": "auto" });
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
