import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Brain, issueHumanSession, modulesStateRoot } from "@brain/core";
import { startServe, type ServeHandle } from "../src/serve.js";
import { terminalHuman } from "../../core/test/helpers.js";

const LEMBRETE = resolve(import.meta.dirname, "../../../examples/modules/lembrete");
const savedState = process.env.BRAIN_STATE_DIR;

let dir: string; let brain: Brain; let serve: ServeHandle; let sessao: string;
const sessions = () => ({ file: join(dir, "sessions.json") });

type Opts = { method?: string; body?: unknown; origin?: string };
const call = (token: string, path: string, o: Opts = {}) => {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.origin !== undefined) headers.origin = o.origin;
  return fetch(`${serve.url}${path}`, { method: o.method ?? "GET", headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
};
const json = async (r: Response) => (await r.json()) as any;
const rodarDiario = async () => json(await call(sessao, "/api/modules/lembrete/_tarefas/diario/rodar", { method: "POST", body: {} }));
const avisos = async () => json(await call(sessao, "/api/notifications"));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-mod-e2e-"));
  process.env.BRAIN_STATE_DIR = join(dir, "state");
  brain = await Brain.init(join(dir, "vault"));
  const atual = readFileSync(brain.vault.configPath, "utf8").replace(/^modules:.*$/m, "");
  const modules = { lembrete: { enabled: true, path: LEMBRETE, config: { horario: "10:00" } } };
  writeFileSync(brain.vault.configPath, `${atual.trimEnd()}\nmodules: ${JSON.stringify(modules)}\n`, "utf8");
  (brain as unknown as { reloadConfig(): void }).reloadConfig();
  // sem `engine`: a IA dos módulos responde "IA indisponível". Sem o agendador automático: perto das 10:00 locais o tick
  // competiria com `rodarDiario` (o teste roda a tarefa só pelo "rodar agora")
  serve = await startServe(brain, { port: 0, sessions: sessions(), agendador: false });
  sessao = issueHumanSession(brain.vault.root, await terminalHuman("alice", sessions()), sessions());
});
afterAll(async () => {
  await serve.close(); brain.close(); rmSync(dir, { recursive: true, force: true });
  if (savedState === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = savedState;
});

describe("módulo de exemplo lembrete, ponta a ponta", () => {
  it("o módulo sobe ativo", async () => {
    const r = await json(await call(serve.token, "/api/modules"));
    expect(r.modulos.map((m: { id: string; status: string }) => [m.id, m.status])).toEqual([["lembrete", "ativo"]]);
    // nenhum tick automático rodou (a subida do agendador gravaria o estado das tarefas)
    expect(existsSync(join(modulesStateRoot(brain), "_scheduler.json"))).toBe(false);
  });

  let itemId = "";
  let pagina = "";

  it("a tarefa diária cria o item, avisa e acende o contador", async () => {
    expect((await rodarDiario()).resultado).toBe("ok");
    const n = await avisos();
    expect(n.avisos).toHaveLength(1);
    expect(n.avisos[0]).toMatchObject({ modulo: "lembrete", titulo: "Lembrete do dia", visto: false });
    expect(n.avisos[0].chave).toMatch(/^dia-\d{4}-\d{2}-\d{2}$/);
    expect(n.avisos[0].link).toMatch(/^item\/dia-\d{4}-\d{2}-\d{2}$/);
    expect(n.total).toBe(1);
    expect(n.badges.lembrete).toBe(1);
    itemId = n.avisos[0].link.slice("item/".length);
  });

  it("a página lista e marca como feito com o token de página; o contador vai a 0", async () => {
    const t = await call(sessao, "/api/modules/lembrete/ui-token", { method: "POST", body: {} });
    expect(t.status).toBe(200);
    pagina = (await t.json()).token;
    const lista = await call(pagina, "/api/modules/lembrete/itens", { origin: "null" });
    expect(lista.status).toBe(200);
    expect(lista.headers.get("access-control-allow-origin")).toBe("null");
    expect((await lista.json()).itens).toEqual([expect.objectContaining({ id: itemId, feito: false })]);

    const feito = await call(pagina, `/api/modules/lembrete/itens/${itemId}/feito`, { method: "POST", origin: "null" });
    expect(feito.status).toBe(200);
    expect((await feito.json()).ok).toBe(true);
    const n = await avisos();
    expect(n.badges.lembrete ?? 0).toBe(0);
    expect(n.total).toBe(0);
  });

  it("item inexistente não é marcado", async () => {
    const r = await json(await call(pagina, "/api/modules/lembrete/itens/nao-existe/feito", { method: "POST", origin: "null" }));
    expect(r.ok).toBe(false);
  });

  it("rodar de novo com a mesma ocorrência não cria um segundo item", async () => {
    expect((await rodarDiario()).resultado).toBe("ok");
    const lista = await json(await call(pagina, "/api/modules/lembrete/itens", { origin: "null" }));
    expect(lista.itens).toHaveLength(1);
    expect(lista.itens[0].feito).toBe(true);
    const n = await avisos();
    expect(n.avisos).toHaveLength(1);
    expect(n.badges.lembrete ?? 0).toBe(0);
  });

  it("POST _mcp/listar com o api-token devolve a lista", async () => {
    const r = await call(serve.token, "/api/modules/lembrete/_mcp/listar", { method: "POST", body: { args: {} } });
    expect(r.status).toBe(200);
    const corpo = await r.json();
    expect(corpo.chamador).toEqual({ via: "mcp", humano: false });
    expect(corpo.resultado.itens).toEqual([expect.objectContaining({ id: itemId })]);
    const so = await json(await call(serve.token, "/api/modules/lembrete/_mcp/listar", { method: "POST", body: { args: { pendentes: true } } }));
    expect(so.resultado.itens).toEqual([]);
  });

  it("o api-token não aciona a rota de ação humana", async () => {
    const r = await call(serve.token, `/api/modules/lembrete/itens/${itemId}/feito`, { method: "POST", body: {} });
    expect(r.status).toBe(403);
  });

  it("a aba é servida com CSP sandbox", async () => {
    const r = await fetch(`${serve.url}/modules/lembrete/index.html`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-forms");
    const html = await r.text();
    expect(html).toContain("app.js");
    const app = await fetch(`${serve.url}/modules/lembrete/app.js`);
    expect(app.status).toBe(200);
  });
});

describe("lembrete: IA opcional", () => {
  // a tarefa isolada, com um ctx falso que conta as chamadas à IA
  const rodar = async (config: unknown) => {
    const mod = (await import(resolve(LEMBRETE, "dist/index.js"))).default;
    let chamadas = 0; const avisosGravados: Array<{ corpo?: string }> = []; let gravado: unknown;
    const ctx = {
      config, ocorrencia: new Date(2026, 10, 11, 10), sinal: new AbortController().signal,
      estado: { lerJson: () => gravado, gravarJson: (_n: string, v: unknown) => { gravado = v; }, lock: <T>(_n: string, fn: () => Promise<T>) => fn() },
      ia: { completar: async () => { chamadas++; return { ok: true, dados: "vamos" }; } },
      avisar: async (a: { corpo?: string }) => { avisosGravados.push(a); }, badge: () => {},
    };
    await mod.tarefas[0].rodar(ctx);
    return { chamadas, avisosGravados };
  };
  it("sem ia: true o motor não é chamado", async () => {
    for (const config of [{ horario: "10:00" }, { horario: "10:00", ia: false }]) {
      const r = await rodar(config);
      expect(r.chamadas).toBe(0);
      expect(r.avisosGravados[0]?.corpo).toBeUndefined();
    }
  });
  it("com ia: true o corpo do aviso vem da IA", async () => {
    const r = await rodar({ horario: "10:00", ia: true });
    expect(r.chamadas).toBe(1);
    expect(r.avisosGravados[0]?.corpo).toBe("vamos");
  });
});
