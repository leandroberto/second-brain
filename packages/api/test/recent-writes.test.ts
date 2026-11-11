import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Brain, principal } from "@brain/core";
import { issueHumanSession, startApi, type ApiHandle } from "../src/index.js";
import { human, terminalHuman } from "../../core/test/helpers.js";

let dir: string; let brain: Brain; let api: ApiHandle; let uiToken: string; let deskToken: string;
const sessions = () => ({ file: join(dir, "sessions.json") });
const get = (t: string, p: string) => fetch(api.url + p, { headers: { authorization: `Bearer ${t}` } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-recent-api-"));
  brain = await Brain.init(join(dir, "vault"));
  await brain.updateConfig({ agents: { commit_policy: "additive" } }, human);
  await brain.propose({ title: "Observação inédita sobre lontras", type: "learning", body: "Lontras de rio dão as patas para não se separarem enquanto dormem." }, principal("agent", "claude-code", "mcp"));
  api = await startApi(brain, { port: 0, sessions: sessions() });
  const proof = await terminalHuman("alice", sessions());
  uiToken = issueHumanSession(brain.vault.root, proof, sessions());
  deskToken = issueHumanSession(brain.vault.root, proof, { ...sessions(), scope: "desktop", label: "desktop" });
});
afterAll(async () => { await api.close(); brain.close(); rmSync(dir, { recursive: true, force: true }); });

describe("GET /api/recent-writes", () => {
  it("sessão ui lista as gravações automáticas dos agentes", async () => {
    const r = await get(uiToken, "/api/recent-writes?days=7");
    expect(r.status).toBe(200);
    const w = await r.json() as any[];
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ agent: "claude-code", resolution: "create", title: "Observação inédita sobre lontras" });
    expect(w[0].commit).toBeTruthy();
    expect(await (await get(uiToken, "/api/recent-writes?days=0")).json()).toEqual([]);
    expect(await (await get(uiToken, "/api/recent-writes?agent=codex")).json()).toEqual([]);
  });
  it("token de agente lê (como nas demais rotas de leitura)", async () => {
    expect((await get(api.token, "/api/recent-writes")).status).toBe(200);
  });
  it("sessão desktop é barrada pela allowlist", async () => {
    expect((await get(deskToken, "/api/recent-writes")).status).toBe(403);
  });
  it("days inválido dá 400", async () => {
    expect((await get(uiToken, "/api/recent-writes?days=abc")).status).toBe(400);
  });
});

describe("GET /api/recent-writes: limites", () => {
  it("days acima de 90 e limit fora de 1..200 dão 400; limit válido dá 200", async () => {
    expect((await get(uiToken, "/api/recent-writes?days=91")).status).toBe(400);
    expect((await get(uiToken, "/api/recent-writes?days=90")).status).toBe(200);
    expect((await get(uiToken, "/api/recent-writes?limit=0")).status).toBe(400);
    expect((await get(uiToken, "/api/recent-writes?limit=201")).status).toBe(400);
    expect((await get(uiToken, "/api/recent-writes?limit=abc")).status).toBe(400);
    expect((await get(uiToken, "/api/recent-writes?limit=1")).status).toBe(200);
    expect(await (await get(uiToken, "/api/recent-writes?limit=1")).json()).toHaveLength(1);
  });
});
