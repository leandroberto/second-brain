import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AvisosStore, Brain, Scheduler, loadModules, modulesStateRoot, revokeHumanSession, type ModuleRegistry } from "@brain/core";
import type { Chamador, ModuleContext, Rota } from "@brain/module-sdk";
import { issueHumanSession, startApi, type ApiHandle } from "../src/index.js";
import { negarAntesDoRoteamento, podeChamar } from "../src/modules.js";
import { MAX_TOKENS_POR_MODULO, TokensDePagina } from "../src/modules-aba.js";
import { terminalHuman } from "../../core/test/helpers.js";

// Aba de módulo (spec de módulos §7.7): estático em /modules/<id>/, token de página, CORS só para a origem opaca `null`.
const FIX = resolve(import.meta.dirname, "fixtures/modules");
const savedState = process.env.BRAIN_STATE_DIR;
const CSP_MODULO = "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'; form-action 'self'; sandbox allow-scripts allow-forms";

let dir: string; let brain: Brain; let api: ApiHandle;
let registry: ModuleRegistry;
let uiToken: string; let deskToken: string; let paginaOk: string;
const sessions = () => ({ file: join(dir, "sessions.json") });
const okCtx = () => (globalThis as { __apiOkCtx?: ModuleContext }).__apiOkCtx!;

/** `fetch` com credencial e cabeçalhos extras; `t` vazio = sem Authorization. */
const call = (t: string, method: string, p: string, o: { body?: unknown; origin?: string } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (t) headers.authorization = `Bearer ${t}`;
  if (o.origin !== undefined) headers.origin = o.origin;
  return fetch(api.url + p, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
};

/** Requisição com o caminho CRU (o `fetch` normaliza `..` e `%2e%2e` antes de enviar). */
const bruto = (caminho: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: Record<string, unknown>; texto: string }>((ok, falha) => {
  const u = new URL(api.url);
  const req = request({ host: u.hostname, port: u.port, path: caminho, method: "GET", headers }, (res) => {
    let texto = ""; res.setEncoding("utf8");
    res.on("data", (c) => { texto += c; });
    res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, texto }));
  });
  req.on("error", falha); req.end();
});

/** Cliente SSE que acumula tudo o que chega até `fechar()`. */
async function abrirSse(token: string) {
  const { ticket } = await (await call(token, "POST", "/api/events/ticket")).json() as { ticket: string };
  const ctl = new AbortController();
  const res = await fetch(`${api.url}/api/events?ticket=${ticket}`, { signal: ctl.signal });
  const reader = res.body!.getReader(); const dec = new TextDecoder();
  let texto = "";
  void (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; texto += dec.decode(value); } } catch { /* abortado */ } })();
  const ate = async (trecho: string, ms = 4000) => { const fim = Date.now() + ms; while (!texto.includes(trecho) && Date.now() < fim) await new Promise((r) => setTimeout(r, 20)); return texto.includes(trecho); };
  await ate("retry:");
  return { texto: () => texto, ate, fechar: () => ctl.abort() };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-mod-ui-"));
  process.env.BRAIN_STATE_DIR = join(dir, "state");
  brain = await Brain.init(join(dir, "vault"));
  // cópia do `ok` com um symlink na pasta da aba apontando para fora dela
  const okDir = join(dir, "mod-ok");
  cpSync(join(FIX, "ok"), okDir, { recursive: true });
  writeFileSync(join(dir, "segredo.txt"), "fora da aba", "utf8");
  symlinkSync(join(dir, "segredo.txt"), join(okDir, "ui", "fora.txt"));
  const modules = { ok: { path: okDir }, outro: { path: join(FIX, "outro") }, lanca: { path: join(FIX, "lanca") } };
  const atual = readFileSync(brain.vault.configPath, "utf8").replace(/^modules:.*$/m, "");
  writeFileSync(brain.vault.configPath, `${atual}\nmodules: ${JSON.stringify(modules)}\n`, "utf8");
  brain.reloadConfig();
  const root = modulesStateRoot(brain);
  const avisos = new AvisosStore(root);
  registry = await loadModules(brain, { modo: "serve", deps: { avisos } });
  const webRoot = join(dir, "web");
  mkdirSync(webRoot); writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>SB</title>", "utf8");
  api = await startApi(brain, { port: 0, sessions: sessions(), webRoot, modules: { registry, scheduler: new Scheduler(registry, root), avisos, root } });
  const proof = await terminalHuman("alice", sessions());
  uiToken = issueHumanSession(brain.vault.root, proof, sessions());
  deskToken = issueHumanSession(brain.vault.root, proof, { ...sessions(), scope: "desktop", label: "desktop" });
  paginaOk = ((await (await call(uiToken, "POST", "/api/modules/ok/ui-token")).json()) as { token: string }).token;
});
afterAll(async () => {
  await api.close(); brain.close(); rmSync(dir, { recursive: true, force: true });
  if (savedState === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = savedState;
});

describe("token de página", () => {
  it("ui-token só para sessão humana", async () => {
    expect((await call(api.token, "POST", "/api/modules/ok/ui-token")).status).toBe(403);
    expect((await call(deskToken, "POST", "/api/modules/ok/ui-token")).status).toBe(403);
    expect((await call(paginaOk, "POST", "/api/modules/ok/ui-token")).status).toBe(403);
    expect((await call(uiToken, "POST", "/api/modules/fantasma/ui-token")).status).toBe(404);
    expect((await call(uiToken, "GET", "/api/modules/ok/ui-token")).status).toBe(404);
    const antes = Date.now();
    const r = await call(uiToken, "POST", "/api/modules/ok/ui-token");
    expect(r.status).toBe(200);
    const b = await r.json() as { token: string; expira: string };
    expect(b.token).toMatch(/^[A-Za-z0-9_-]{43,}$/); // ≥ 32 bytes em base64url
    expect(b.token).not.toBe(paginaOk); // cada emissão gera um token novo
    const ttl = new Date(b.expira).getTime() - antes;
    expect(ttl).toBeGreaterThan(12 * 3600_000 - 60_000);
    expect(ttl).toBeLessThanOrEqual(12 * 3600_000 + 5_000);
  });

  it("token de página só no próprio módulo", async () => {
    const r = await call(paginaOk, "GET", "/api/modules/ok/eco");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ chamador: { via: "pagina", humano: true } });
    // a página é humana: rota humano:true aceita
    expect((await call(paginaOk, "POST", "/api/modules/ok/acao", { body: { x: 1 } })).status).toBe(200);
    expect((await call(paginaOk, "GET", "/api/modules/outro/eco")).status).toBe(403);
    expect((await call(paginaOk, "GET", "/api/notes")).status).toBe(403);
    expect((await call(paginaOk, "POST", "/api/modules/ok/_tarefas/diaria/rodar", { body: {} })).status).toBe(403);
    expect((await call(paginaOk, "POST", "/api/modules/ok/_mcp/eco", { body: { args: { texto: "a" } } })).status).toBe(403);
    expect((await call(paginaOk, "GET", "/api/modules")).status).toBe(403);
    expect((await call(paginaOk, "POST", "/api/events/ticket")).status).toBe(403);
    expect((await call(paginaOk, "GET", "/api/notifications")).status).toBe(403);
    expect((await call(paginaOk, "GET", "/api/health")).status).toBe(403);
  });

  it("token de página com Origin null funciona e leva os cabeçalhos de CORS", async () => {
    const r = await call(paginaOk, "GET", "/api/modules/ok/eco", { origin: "null" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { chamador: Chamador }).chamador.via).toBe("pagina");
    expect(r.headers.get("access-control-allow-origin")).toBe("null");
    expect(r.headers.get("vary")).toBe("Origin");
    // erros desses prefixos também (senão a página não lê a resposta)
    const paginaLanca = ((await (await call(uiToken, "POST", "/api/modules/lanca/ui-token")).json()) as { token: string }).token;
    for (const [t, p, st] of [[paginaOk, "/api/modules/ok/nao-tem", 404], [paginaOk, "/api/modules/ok/lanca", 500], [paginaLanca, "/api/modules/lanca/eco", 503], [paginaOk, "/api/modules/lanca/eco", 403]] as const) {
      const e = await call(t, "GET", p, { origin: "null" });
      expect(e.status).toBe(st);
      expect(e.headers.get("access-control-allow-origin")).toBe("null");
      expect(e.headers.get("vary")).toBe("Origin");
    }
    const semToken = await call("", "GET", "/api/modules/ok/eco", { origin: "null" });
    expect(semToken.status).toBe(401);
    expect(semToken.headers.get("access-control-allow-origin")).toBe("null");
  });

  it("token de página morre junto com a sessão humana que o emitiu (revogada ou expirada)", async () => {
    const proof = await terminalHuman("alice", sessions());
    const emissora = issueHumanSession(brain.vault.root, proof, sessions());
    const t = ((await (await call(emissora, "POST", "/api/modules/ok/ui-token")).json()) as { token: string }).token;
    expect((await call(t, "GET", "/api/modules/ok/eco")).status).toBe(200);
    expect((await call(t, "POST", "/api/modules/ok/acao", { body: {} })).status).toBe(200);
    revokeHumanSession(brain.vault.root, emissora, sessions()); // o que `brain admin revoke-sessions` faz, só com esta
    expect((await call(t, "GET", "/api/modules/ok/eco")).status).toBe(401);
    expect((await call(t, "POST", "/api/modules/ok/acao", { body: {} })).status).toBe(401);
    expect((await call(t, "GET", "/api/modules/ok/eco", { origin: "null" })).status).toBe(401);
    // o de outra sessão viva continua valendo
    expect((await call(paginaOk, "GET", "/api/modules/ok/eco")).status).toBe(200);
    // sessão expirada: idem
    const curta = issueHumanSession(brain.vault.root, proof, { ...sessions(), ttlMinutes: 1 });
    const t2 = ((await (await call(curta, "POST", "/api/modules/ok/ui-token")).json()) as { token: string }).token;
    expect((await call(t2, "GET", "/api/modules/ok/eco")).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * 60_000);
      expect((await call(t2, "GET", "/api/modules/ok/eco")).status).toBe(401);
    } finally { vi.useRealTimers(); }
  });

  it("token expirado é recusado", async () => {
    const t = ((await (await call(uiToken, "POST", "/api/modules/ok/ui-token")).json()) as { token: string }).token;
    expect((await call(t, "GET", "/api/modules/ok/eco")).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 12 * 3600_000 + 1000);
      expect((await call(t, "GET", "/api/modules/ok/eco")).status).toBe(401);
    } finally { vi.useRealTimers(); }
  });
});

describe("origem", () => {
  it("Origin null fora do prefixo do módulo é 403", async () => {
    const r = await call(uiToken, "GET", "/api/notes", { origin: "null" });
    expect(r.status).toBe(403);
    expect(await r.text()).toBe("origem não permitida");
    for (const [m, p] of [["POST", "/api/modules/ok/ui-token"], ["POST", "/api/modules/ok/_mcp/eco"], ["POST", "/api/modules/ok/_tarefas/diaria/rodar"], ["GET", "/api/modules"], ["POST", "/api/events/ticket"], ["GET", "/api/events"], ["GET", "/"]] as const) {
      expect((await call(paginaOk, m, p, { origin: "null" })).status, `${m} ${p}`).toBe(403);
    }
    expect((await call(api.token, "POST", "/api/modules/ok/_mcp/eco", { body: { args: { texto: "a" } }, origin: "null" })).status).toBe(403);
  });

  it("sessão humana com Origin null é recusada até no prefixo do módulo", async () => {
    expect((await call(uiToken, "GET", "/api/modules/ok/eco", { origin: "null" })).status).toBe(403);
    expect((await call(api.token, "GET", "/api/modules/ok/eco", { origin: "null" })).status).toBe(403);
    // sem Origin ou com a origem do próprio SB, a sessão continua valendo
    expect((await call(uiToken, "GET", "/api/modules/ok/eco", { origin: api.url })).status).toBe(200);
  });

  it("origem estrangeira ou malformada é 403", async () => {
    for (const origin of ["http://evil.example", "http://[::1", "%%%", "Null", "file://"]) {
      for (const p of ["/api/modules/ok/eco", "/api/notes", "/modules/ok/index.html"]) {
        expect((await call(paginaOk, "GET", p, { origin })).status, `${origin} ${p}`).toBe(403);
      }
    }
  });

  it("Origin null não gera 500", async () => {
    const casos: Array<[string, string, string]> = [];
    for (const t of [uiToken, deskToken, api.token, paginaOk, "lixo", ""]) {
      for (const [m, p] of [["GET", "/api/health"], ["GET", "/api/notes"], ["GET", "/api/modules"], ["GET", "/api/modules/ok/eco"], ["POST", "/api/modules/ok/acao"],
        ["GET", "/api/modules/fantasma/eco"], ["GET", "/api/modules/Inv%C3%A1lido/eco"], ["POST", "/api/modules/ok/ui-token"], ["GET", "/api/events?ticket=x"],
        ["GET", "/"], ["GET", "/modules/ok/index.html"], ["GET", "/modules/_sdk/base.css"], ["GET", "/modules/fantasma/"], ["OPTIONS", "/api/modules/ok/eco"], ["OPTIONS", "/api/notes"]]) {
        casos.push([t, m!, p!]);
      }
    }
    for (const [t, m, p] of casos) {
      const r = await call(t, m, p, { origin: "null", body: m === "POST" ? {} : undefined });
      expect(r.status, `${m} ${p}`).not.toBe(500);
    }
  });

  it("preflight", async () => {
    for (const p of ["/api/modules/ok/eco", "/api/modules/ok/acao", "/modules/ok/index.html"]) {
      const r = await call("", "OPTIONS", p, { origin: "null" });
      expect(r.status, p).toBe(204);
      expect(r.headers.get("access-control-allow-origin")).toBe("null");
      expect(r.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
      expect(r.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, DELETE");
      expect(r.headers.get("vary")).toBe("Origin");
    }
    expect((await call("", "OPTIONS", "/api/notes", { origin: "null" })).status).toBe(403);
    expect((await call("", "OPTIONS", "/api/modules/ok/_mcp/eco", { origin: "null" })).status).toBe(403);
    expect((await call("", "OPTIONS", "/api/modules/ok/ui-token", { origin: "null" })).status).toBe(403);
    expect((await call("", "OPTIONS", "/api/modules/ok/_tarefas/diaria/rodar", { origin: "null" })).status).toBe(403);
  });
});

describe("estático do módulo", () => {
  it("serve a aba com a CSP do §7.7 e CORS para a origem opaca", async () => {
    for (const p of ["/modules/ok/index.html", "/modules/ok/"]) {
      const r = await call("", "GET", p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("content-security-policy")).toBe(CSP_MODULO);
      expect(r.headers.get("access-control-allow-origin")).toBe("null");
      expect(r.headers.get("vary")).toBe("Origin");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await r.text()).toContain("aba do módulo ok");
    }
    expect((await call("", "GET", "/modules/ok/index.html", { origin: "null" })).status).toBe(200);
  });

  it("traversal, symlink para fora e módulo sem aba são negados", async () => {
    for (const p of ["/modules/ok/../../package.json", "/modules/ok/%2e%2e/%2e%2e/package.json", "/modules/ok/..%2f..%2fpackage.json", "/modules/ok/ui/../../index.js", "/modules/ok/%2e%2e/index.js"]) {
      const r = await bruto(p);
      expect([403, 404], p).toContain(r.status);
      expect(r.texto).not.toContain("fixture-api-ok");
    }
    const link = await call("", "GET", "/modules/ok/fora.txt");
    expect([403, 404]).toContain(link.status);
    expect(await link.text()).not.toContain("fora da aba");
    expect((await call("", "GET", "/modules/ok/nao-existe.js")).status).toBe(404);
    expect((await call("", "GET", "/modules/outro/index.html")).status).toBe(404); // sem aba
    expect((await call("", "GET", "/modules/lanca/index.html")).status).toBe(404); // falho
    expect((await call("", "GET", "/modules/fantasma/index.html")).status).toBe(404);
    expect((await call("", "GET", "/modules/ok/%E0%A4%A")).status).toBe(404);
  });

  it("todo o estático da aba força origem opaca (sandbox sem allow-same-origin), até aberto como documento de topo", async () => {
    for (const p of ["/modules/ok/index.html", "/modules/ok/", "/modules/_sdk/base.css", "/modules/_sdk/brain-module-client.js"]) {
      const csp = (await call("", "GET", p)).headers.get("content-security-policy") ?? "";
      const sandbox = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("sandbox"));
      expect(sandbox, p).toBe("sandbox allow-scripts allow-forms");
      expect(csp, p).not.toContain("allow-same-origin");
    }
    // subrecursos do documento sandboxed chegam com Origin: null e são aceitos com CORS
    const js = await call("", "GET", "/modules/_sdk/brain-module-client.js", { origin: "null" });
    expect(js.status).toBe(200);
    expect(js.headers.get("access-control-allow-origin")).toBe("null");
  });

  it("respostas de erro sob /modules/ também levam a CSP da aba e nosniff", async () => {
    const respostas = [
      await call("", "GET", "/modules/fantasma/index.html"), // 404
      await call("", "GET", "/modules/ok/nao-existe.html"), // 404
      await call("", "POST", "/modules/ok/index.html"), // 405
      await call("", "GET", "/modules/ok/index.html", { origin: "http://outra-origem.example" }), // 403
    ];
    expect(respostas.map((r) => r.status)).toEqual([404, 404, 405, 403]);
    for (const r of respostas) {
      expect(r.headers.get("content-security-policy")).toBe(CSP_MODULO);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    }
    // segmento `..` cru (a URL do fetch normalizaria): também 404 com a CSP
    const u = new URL(api.url);
    const crua = await new Promise<{ status?: number; csp?: string | string[] }>((ok, ko) => {
      const rq = request({ host: u.hostname, port: u.port, path: "/modules/ok/../x", method: "GET" }, (res) => { res.resume(); ok({ status: res.statusCode, csp: res.headers["content-security-policy"] }); });
      rq.on("error", ko); rq.end();
    });
    expect(crua).toEqual({ status: 404, csp: CSP_MODULO });
    // forma absoluta da URL (`GET http://host/modules/...`): mesmo critério do pathname
    const absoluta = await new Promise<{ status?: number; csp?: string | string[] }>((ok, ko) => {
      const rq = request({ host: u.hostname, port: u.port, path: `${api.url}/modules/fantasma/x.html`, method: "GET" }, (res) => { res.resume(); ok({ status: res.statusCode, csp: res.headers["content-security-policy"] }); });
      rq.on("error", ko); rq.end();
    });
    expect(absoluta).toEqual({ status: 404, csp: CSP_MODULO });
    // fora de /modules/ a CSP da aba não vale
    expect((await call("", "GET", "/")).headers.get("content-security-policy")).not.toContain("sandbox");
  });

  it("tokens de página: teto de vivos por módulo, descartando os mais antigos", () => {
    const t = new TokensDePagina(() => true);
    const outro = t.emitir("outro", "s").token;
    const emitidos = Array.from({ length: MAX_TOKENS_POR_MODULO + 5 }, () => t.emitir("ok", "s").token);
    expect(emitidos.slice(0, 5).map((x) => t.modulo(x))).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(emitidos.slice(5).every((x) => t.modulo(x) === "ok")).toBe(true);
    expect(t.modulo(outro)).toBe("outro"); // o teto é por módulo
  });

  it("arquivos do SDK em /modules/_sdk", async () => {
    const css = await call("", "GET", "/modules/_sdk/base.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("access-control-allow-origin")).toBe("null");
    expect(await css.text()).toContain("--bg");
    const js = await call("", "GET", "/modules/_sdk/brain-module-client.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("export function conectar");
    expect((await call("", "GET", "/modules/_sdk/package.json")).status).toBe(404);
    expect((await call("", "GET", "/modules/_sdk/")).status).toBe(404);
  });

  it("CSP do SB tem frame-src 'self'", async () => {
    const r = await call("", "GET", "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("frame-src 'self'");
  });
});

describe("correções da matriz (herdadas da Tarefa 6)", () => {
  it("tipo de credencial desconhecido é negado em toda rota", () => {
    for (const p of ["/api/notes", "/api/health", "/api/modules/ok/eco", "/api/notifications"]) {
      expect(negarAntesDoRoteamento({ tipo: "novo" } as never, "GET", p), p).toBeTruthy();
    }
    expect(negarAntesDoRoteamento({ tipo: "pagina", modulo: "ok" }, "GET", "/api/notes")).toBeTruthy();
    expect(negarAntesDoRoteamento({ tipo: "pagina", modulo: "ok" }, "GET", "/api/modules/ok/eco")).toBeUndefined();
  });

  it("podeChamar trata humano truthy não booleano como exigência de humano", () => {
    const mcp: Chamador = { via: "mcp", humano: false };
    for (const humano of [1, "true", "sim"]) {
      const rota = { metodo: "POST", caminho: "/acao", humano, rodar: async () => undefined } as unknown as Rota;
      expect(podeChamar(rota, mcp), String(humano)).toBe(false);
      expect(podeChamar(rota, { via: "ui", humano: true })).toBe(true);
    }
  });

  it("SSE: module.* só para a sessão humana", async () => {
    const humano = await abrirSse(uiToken);
    const agente = await abrirSse(api.token);
    try {
      await okCtx().avisar({ titulo: "Aviso só para humano" });
      expect(await humano.ate("event: module.notification")).toBe(true);
      // o agente segue recebendo os demais eventos
      expect((await call(api.token, "POST", "/api/proposals", { body: { title: "Evento de teste do SSE", type: "learning", body: "Corpo da proposta usada para disparar o evento proposals no SSE." } })).status).toBe(200);
      expect(await agente.ate("event: proposals")).toBe(true);
      expect(agente.texto()).not.toContain("module.");
      expect(agente.texto()).not.toContain("Aviso só para humano");
    } finally { humano.fechar(); agente.fechar(); }
  });

  it("_mcp: schema que lança é erro do módulo; issues são entrada inválida", async () => {
    const r = await call(api.token, "POST", "/api/modules/ok/_mcp/quebra", { body: { args: {} } });
    expect(r.status).toBe(500);
    const texto = await r.text();
    expect(JSON.parse(texto)).toEqual({ error: "module_error" });
    expect(texto).not.toContain("schema quebrado");
    expect(registry.errors("ok").at(-1)).toMatchObject({ onde: "mcp:quebra", mensagem: "schema quebrado por dentro" });
    const i = await call(api.token, "POST", "/api/modules/ok/_mcp/eco", { body: { args: { texto: 1 } } });
    expect(i.status).toBe(400);
    expect(await i.json()).toMatchObject({ error: "invalid" });
  });
});
