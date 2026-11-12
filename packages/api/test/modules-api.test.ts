import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AvisosStore, Brain, Scheduler, loadModules, modulesStateRoot, vaultFingerprint, type ModuleRegistry } from "@brain/core";
import type { Chamador, ModuleContext, Rota } from "@brain/module-sdk";
import { issueHumanSession, startApi, type ApiHandle } from "../src/index.js";
import { podeChamar } from "../src/modules.js";
import { terminalHuman } from "../../core/test/helpers.js";

const FIX = resolve(import.meta.dirname, "fixtures/modules");
const savedState = process.env.BRAIN_STATE_DIR;

let dir: string; let brain: Brain; let api: ApiHandle; let semModulos: ApiHandle;
let registry: ModuleRegistry; let avisos: AvisosStore;
let uiToken: string; let deskToken: string;
const sessions = () => ({ file: join(dir, "sessions.json") });
const call = (t: string, method: string, p: string, body?: unknown, base = () => api.url) =>
  fetch(base() + p, { method, headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const okCtx = () => (globalThis as { __apiOkCtx?: ModuleContext }).__apiOkCtx!;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-mod-api-"));
  process.env.BRAIN_STATE_DIR = join(dir, "state");
  brain = await Brain.init(join(dir, "vault"));
  // `modules` no config.yaml, como o usuário faria; o registro sai do carregador real
  const modules = { ok: { path: join(FIX, "ok") }, lanca: { path: join(FIX, "lanca") }, sumido: { path: join(FIX, "nao-existe") } };
  const atual = readFileSync(brain.vault.configPath, "utf8").replace(/^modules:.*$/m, "");
  writeFileSync(brain.vault.configPath, `${atual}\nmodules: ${JSON.stringify(modules)}\n`, "utf8"); // JSON é YAML válido
  brain.reloadConfig();
  const root = modulesStateRoot(brain);
  avisos = new AvisosStore(root);
  registry = await loadModules(brain, { modo: "serve", deps: { avisos } });
  const scheduler = new Scheduler(registry, root);
  api = await startApi(brain, { port: 0, sessions: sessions(), modules: { registry, scheduler, avisos, root } });
  semModulos = await startApi(brain, { port: 0, sessions: sessions() });
  const proof = await terminalHuman("alice", sessions());
  uiToken = issueHumanSession(brain.vault.root, proof, sessions());
  deskToken = issueHumanSession(brain.vault.root, proof, { ...sessions(), scope: "desktop", label: "desktop" });
});
afterAll(async () => {
  await api.close(); await semModulos.close(); brain.close(); rmSync(dir, { recursive: true, force: true });
  if (savedState === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = savedState;
});

describe("rotas de módulo", () => {
  it("sessão humana chama rota e recebe chamador ui humano", async () => {
    const r = await call(uiToken, "GET", "/api/modules/ok/eco");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ chamador: { via: "ui", humano: true } });
  });

  it("params decodificados, query e resposta vazia vira 204", async () => {
    expect(await (await call(uiToken, "GET", "/api/modules/ok/itens/a%20b?q=xyz")).json()).toEqual({ id: "a b", q: "xyz" });
    expect((await call(uiToken, "GET", "/api/modules/ok/itens/%E0%A4%A")).status).toBe(400);
    const v = await call(uiToken, "DELETE", "/api/modules/ok/vazio");
    expect(v.status).toBe(204);
    expect(await v.text()).toBe("");
    expect(await (await call(uiToken, "POST", "/api/modules/ok/acao", { x: 1 })).json()).toEqual({ feito: true, body: { x: 1 } });
  });

  it("rota inexistente, módulo inexistente e id inválido dão 404", async () => {
    expect((await call(uiToken, "GET", "/api/modules/ok/nao-tem")).status).toBe(404);
    expect((await call(uiToken, "POST", "/api/modules/ok/eco")).status).toBe(404); // método errado
    expect((await call(uiToken, "GET", "/api/modules/fantasma/eco")).status).toBe(404);
    expect((await call(uiToken, "GET", "/api/modules/Inv%C3%A1lido/eco")).status).toBe(404);
    expect((await call(uiToken, "GET", "/api/modules/x/eco")).status).toBe(404); // curto demais para a regex
  });

  it("api-token só acessa _mcp e GET /api/modules", async () => {
    expect((await call(api.token, "GET", "/api/modules/ok/eco")).status).toBe(403);
    expect((await call(api.token, "POST", "/api/modules/ok/acao", {})).status).toBe(403);
    expect((await call(api.token, "POST", "/api/modules/ok/_tarefas/diaria/rodar", {})).status).toBe(403);
    // 403 antes de qualquer lookup: módulo inexistente e id inválido também
    expect((await call(api.token, "GET", "/api/modules/fantasma/eco")).status).toBe(403);
    expect((await call(api.token, "GET", "/api/modules/Inv%C3%A1lido/eco")).status).toBe(403);
    expect((await call(api.token, "POST", "/api/modules", {})).status).toBe(403);
    expect((await call(api.token, "GET", "/api/modules/ok/_mcp/eco")).status).toBe(403);
    const m = await call(api.token, "POST", "/api/modules/ok/_mcp/eco", { args: { texto: "oi" } });
    expect(m.status).toBe(200);
    const b = await m.json() as any;
    expect(b.chamador.via).toBe("mcp");
    expect(b.chamador.humano).toBe(false);
    expect(b.resultado).toEqual({ eco: "oi" });
    expect((await call(api.token, "GET", "/api/modules")).status).toBe(200);
    // rotas do core que o api-token já acessava continuam iguais
    expect((await call(api.token, "GET", "/api/health")).status).toBe(200);
    expect((await call(api.token, "GET", "/api/search?q=x")).status).toBe(200);
  });

  it("_mcp: só api-token; ferramenta inexistente 404; rota do módulo com nome reservado nunca é chamada", async () => {
    expect((await call(uiToken, "POST", "/api/modules/ok/_mcp/eco", { args: { texto: "oi" } })).status).toBe(403);
    expect((await call(deskToken, "POST", "/api/modules/ok/_mcp/eco", { args: { texto: "oi" } })).status).toBe(403);
    expect((await call(api.token, "POST", "/api/modules/ok/_mcp/nao-tem", { args: {} })).status).toBe(404);
    expect((await call(api.token, "POST", "/api/modules/fantasma/_mcp/eco", { args: {} })).status).toBe(404);
    const b = await (await call(api.token, "POST", "/api/modules/ok/_mcp/eco", { args: { texto: "a" } })).json() as any;
    expect(b.sequestrada).toBeUndefined();
  });

  it("_mcp valida entrada", async () => {
    const r = await call(api.token, "POST", "/api/modules/ok/_mcp/eco", { args: { texto: 42 } });
    expect(r.status).toBe(400);
    const b = await r.json() as any;
    expect(b.error).toBe("invalid");
    expect(b.message).toContain("texto obrigatório");
    expect((await call(api.token, "POST", "/api/modules/ok/_mcp/eco", {})).status).toBe(400);
  });

  it("rota humano:true recusa api-token", () => {
    const rota: Rota = { metodo: "POST", caminho: "/acao", humano: true, rodar: async () => undefined };
    const mcp: Chamador = { via: "mcp", humano: false };
    expect(podeChamar(rota, mcp)).toBe(false);
    expect(podeChamar(rota, { via: "pagina", humano: true })).toBe(true);
    expect(podeChamar(rota, { via: "ui", humano: true })).toBe(true);
    expect(podeChamar({ ...rota, humano: undefined }, mcp)).toBe(true);
  });

  it("credencial do desktop acessa notifications e nada de módulo", async () => {
    const n = await call(deskToken, "GET", "/api/notifications");
    expect(n.status).toBe(200);
    expect(await n.json()).toMatchObject({ avisos: expect.any(Array), badges: expect.any(Object), total: expect.any(Number) });
    expect((await call(deskToken, "POST", "/api/notifications/abc/visto")).status).toBe(204);
    expect((await call(deskToken, "GET", "/api/modules")).status).toBe(403);
    expect((await call(deskToken, "GET", "/api/modules/ok/eco")).status).toBe(403);
    expect((await call(deskToken, "POST", "/api/modules/ok/_tarefas/diaria/rodar", {})).status).toBe(403);
    // só GET na lista e POST no visto
    expect((await call(deskToken, "POST", "/api/notifications", {})).status).toBe(403);
    expect((await call(deskToken, "GET", "/api/notifications/abc/visto")).status).toBe(403);
    // o resto continua barrado como antes
    expect((await call(deskToken, "GET", "/api/settings")).status).toBe(403);
  });

  it("api-token não acessa notifications", async () => {
    expect((await call(api.token, "GET", "/api/notifications")).status).toBe(403);
    expect((await call(api.token, "POST", "/api/notifications/x/visto")).status).toBe(403);
  });

  it("módulo falho responde 503", async () => {
    const r = await call(uiToken, "GET", "/api/modules/lanca/eco");
    expect(r.status).toBe(503);
    const b = await r.json() as any;
    expect(b.error).toBe("module_unavailable");
    expect(b.message).toContain("falha proposital no iniciar");
    expect((await call(uiToken, "GET", "/api/modules/sumido/eco")).status).toBe(503);
  });

  it("handler que lança responde 500 e registra erro", async () => {
    const r = await call(uiToken, "GET", "/api/modules/ok/lanca");
    expect(r.status).toBe(500);
    const texto = await r.text();
    expect(JSON.parse(texto)).toEqual({ error: "module_error" });
    expect(texto).not.toContain("detalhe interno");
    const erros = registry.errors("ok");
    expect(erros.at(-1)).toMatchObject({ onde: "rota:GET /lanca", mensagem: "detalhe interno que não pode vazar" });
  });

  it("GET /api/modules lista todos os módulos, inclusive falhos e ausentes", async () => {
    await okCtx().badge(3);
    const b = await (await call(uiToken, "GET", "/api/modules")).json() as any;
    expect(b.reiniciar).toBe(false);
    const por = Object.fromEntries(b.modulos.map((m: any) => [m.id, m]));
    expect(por.ok).toMatchObject({ id: "ok", nome: "Ok", icone: "sino", aba: true, badge: 3, status: "ativo", versao: "1.2.3" });
    expect(por.ok.tarefas).toEqual([expect.objectContaining({ tarefa: "diaria", quando: "0 9 * * *" })]);
    expect(por.lanca).toMatchObject({ status: "falho", badge: 0, tarefas: [] });
    expect(por.lanca.causa).toContain("iniciar falhou");
    expect(por.sumido).toMatchObject({ id: "sumido", nome: "sumido", status: "ausente", aba: false });
    okCtx().badge(0);
  });

  it("GET /api/modules traz sdk, pasta e o gasto de IA do dia (Saúde, §7.13)", async () => {
    const d = new Date(); const hoje = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    writeFileSync(join(modulesStateRoot(brain), "_ia.json"), JSON.stringify({ ok: { [hoje]: 0.37, "2000-01-01": 9 } }));
    try {
      for (const t of [uiToken, api.token]) {
        const b = await (await call(t, "GET", "/api/modules")).json() as any;
        const por = Object.fromEntries(b.modulos.map((m: any) => [m.id, m]));
        expect(por.ok).toMatchObject({ sdk: 1, pasta: join(FIX, "ok"), iaHojeUsd: 0.37 });
        expect(por.lanca).toMatchObject({ pasta: join(FIX, "lanca"), iaHojeUsd: 0 });
        expect(por.sumido).toMatchObject({ pasta: join(FIX, "nao-existe"), iaHojeUsd: 0 });
        expect(por.sumido.sdk).toBeUndefined();
        expect(por.ok.iaBloqueada).toBe(false);
      }
    } finally { rmSync(join(modulesStateRoot(brain), "_ia.json"), { force: true }); }
  });

  it("GET /api/modules marca iaBloqueada quando o registro de gasto de IA está ilegível (sem mexer no arquivo)", async () => {
    const arq = join(modulesStateRoot(brain), "_ia.json");
    writeFileSync(arq, "{ trunc");
    try {
      const b = await (await call(api.token, "GET", "/api/modules")).json() as any;
      for (const m of b.modulos) expect(m, m.id).toMatchObject({ iaBloqueada: true, iaBloqueio: "bloqueada: registro de gasto ilegível (será guardado na próxima chamada)", iaHojeUsd: 0 });
      expect(readFileSync(arq, "utf8")).toBe("{ trunc");
    } finally { rmSync(arq, { force: true }); }
  });

  it("GET /api/modules traz os 10 erros mais recentes, truncados e sem possível segredo", async () => {
    for (let i = 0; i < 11; i++) registry.recordError("ok", `rota:GET /x${i}`, new Error(`falha ${i}`));
    registry.recordError("ok", "rota:GET /longa", new Error("x".repeat(400)));
    registry.recordError("ok", "rota:GET /segredo", new Error(`chave ghp_${"a".repeat(36)} vazou`));
    const b = await (await call(api.token, "GET", "/api/modules")).json() as any;
    const erros = b.modulos.find((m: any) => m.id === "ok").erros as Array<{ em: string; onde: string; mensagem: string }>;
    expect(erros).toHaveLength(10);
    expect(erros.at(-1)).toMatchObject({ onde: "rota:GET /segredo", mensagem: "[mensagem omitida: possível segredo]" });
    expect(erros.at(-2)!.mensagem).toBe("x".repeat(300));
    expect(erros[0]!.onde).toBe("rota:GET /x3");
    expect(Object.keys(erros[0]!).sort()).toEqual(["em", "mensagem", "onde"]);
    expect(JSON.stringify(b)).not.toContain("ghp_");
  });

  it("GET /api/serve identifica o processo e o vault sem segredo", async () => {
    const r = await (await call(api.token, "GET", "/api/serve")).json();
    expect(r).toEqual({ pid: process.pid, vault: vaultFingerprint(brain.vault.root) });
    expect((await call(deskToken, "GET", "/api/serve")).status).toBe(403);
  });

  it("rodar tarefa exige sessão humana", async () => {
    expect((await call(api.token, "POST", "/api/modules/ok/_tarefas/diaria/rodar", {})).status).toBe(403);
    const r = await call(uiToken, "POST", "/api/modules/ok/_tarefas/diaria/rodar", { ocorrencia: "2026-11-10T09:00:00.000Z" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ resultado: "ok" });
    expect((globalThis as { __apiOkOcorrencia?: string }).__apiOkOcorrencia).toBe("2026-11-10T09:00:00.000Z");
    expect((await call(uiToken, "POST", "/api/modules/ok/_tarefas/diaria/rodar", { ocorrencia: "ontem" })).status).toBe(400);
    expect((await call(uiToken, "POST", "/api/modules/ok/_tarefas/nao-tem/rodar", {})).status).toBe(404);
    expect((await call(uiToken, "GET", "/api/modules/ok/_tarefas/diaria/rodar")).status).toBe(404);
    expect((await call(uiToken, "POST", "/api/modules/lanca/_tarefas/diaria/rodar", {})).status).toBe(503);
  });

  it("notifications lista avisos e marca visto", async () => {
    await okCtx().avisar({ titulo: "Lembrete de teste", link: "itens/1" });
    const l = await (await call(uiToken, "GET", "/api/notifications")).json() as any;
    const aviso = l.avisos.find((a: any) => a.titulo === "Lembrete de teste");
    expect(aviso).toMatchObject({ modulo: "ok", link: "itens/1", visto: false });
    const depois = await (await call(uiToken, "GET", `/api/notifications?depois=${encodeURIComponent(l.cursor)}`)).json() as any;
    expect(depois.avisos).toEqual([]);
    expect((await call(uiToken, "POST", `/api/notifications/${aviso.id}/visto`)).status).toBe(204);
    const l2 = await (await call(uiToken, "GET", "/api/notifications")).json() as any;
    expect(l2.avisos.some((a: any) => a.id === aviso.id)).toBe(false);
  });

  it("aviso chega no SSE", async () => {
    const { ticket } = await (await call(uiToken, "POST", "/api/events/ticket")).json() as any;
    const ctl = new AbortController();
    const res = await fetch(`${api.url}/api/events?ticket=${ticket}`, { signal: ctl.signal });
    const reader = res.body!.getReader(); let seen = "";
    const pronto = (async () => { const dec = new TextDecoder(); try { for (;;) { const { value, done } = await reader.read(); if (done) break; seen += dec.decode(value); if (seen.includes("retry:")) break; } } catch { /* abortado */ } })();
    await Promise.race([pronto, new Promise((r) => setTimeout(r, 2000))]);
    const lendo = (async () => { const dec = new TextDecoder(); try { for (;;) { const { value, done } = await reader.read(); if (done) break; seen += dec.decode(value); if (seen.includes("event: module.notification")) break; } } catch { /* abortado */ } })();
    await okCtx().avisar({ titulo: "Aviso pelo SSE" });
    await Promise.race([lendo, new Promise((r) => setTimeout(r, 4000))]);
    ctl.abort();
    expect(seen).toContain("event: module.notification");
    expect(seen).toContain("Aviso pelo SSE");
  });

  it("sem módulos configurados: listas vazias e nenhuma rota de módulo", async () => {
    const base = () => semModulos.url;
    expect(await (await call(uiToken, "GET", "/api/modules", undefined, base)).json()).toEqual({ modulos: [], reiniciar: false });
    expect(await (await call(uiToken, "GET", "/api/notifications", undefined, base)).json()).toEqual({ avisos: [], cursor: "", badges: {}, total: 0 });
    expect(await (await call(deskToken, "GET", "/api/notifications", undefined, base)).json()).toEqual({ avisos: [], cursor: "", badges: {}, total: 0 });
    expect((await call(uiToken, "GET", "/api/modules/ok/eco", undefined, base)).status).toBe(404);
    expect((await call(uiToken, "POST", "/api/modules/ok/_tarefas/diaria/rodar", {}, base)).status).toBe(404);
  });

  it("sem módulos, marcar aviso como visto responde 404 not_found (nada foi marcado)", async () => {
    const base = () => semModulos.url;
    for (const t of [uiToken, deskToken]) {
      const r = await call(t, "POST", "/api/notifications/qualquer/visto", undefined, base);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "not_found" });
    }
  });
});
