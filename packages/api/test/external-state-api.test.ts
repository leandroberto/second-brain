import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Brain } from "@brain/core";
import { startApi, type ApiHandle } from "../src/index.js";

/** Vault com `state.external`: api-token, propostas pendentes e lock vivem no diretório de estado, nunca no vault. */
let dir: string; let vault: string; let state: string; let brain: Brain; let api: ApiHandle;
const saved = process.env.BRAIN_STATE_DIR;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-api-ext-"));
  vault = join(dir, "vault"); state = join(dir, "estado");
  mkdirSync(join(vault, ".brain"), { recursive: true });
  writeFileSync(join(vault, ".brain", "config.yaml"), "state:\n  external: true\n");
  process.env.BRAIN_STATE_DIR = state;
  brain = await Brain.init(vault);
  api = await startApi(brain, { port: 0, sessions: { file: join(dir, "sessions.json") } });
});
afterAll(async () => {
  await api.close(); brain.close();
  if (saved === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("API com estado externo", () => {
  it("startApi grava o api-token no estado, e propostas pendentes e lock ficam no estado", async () => {
    expect(readFileSync(join(state, "api-token"), "utf8").trim()).toBe(api.token);
    expect(existsSync(join(vault, ".brain", "api-token"))).toBe(false);
    // o agente da API propõe: a proposta pendente vai para o estado (política padrão never: fica na fila)
    const r = await fetch(`${api.url}/api/proposals`, {
      method: "POST", headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Rotina fictícia de backup", type: "fact", body: "O backup fictício roda às 3h da manhã." }),
    });
    expect(r.status).toBe(200);
    const { id } = await r.json() as { id: string };
    expect(readdirSync(join(state, "proposals", "pending"))).toContain(`${id}.json`);
    expect(existsSync(join(vault, ".brain", "proposals", "pending"))).toBe(false);
    // o lock de escrita mora no estado (a escrita acima o usou e liberou); nada de lock.d no vault
    expect(brain.vault.lockPath).toBe(join(state, "lock.d"));
    expect(existsSync(join(vault, ".brain", "lock.d"))).toBe(false);
    for (const proibido of [".git", "index.db", ".brain/index.db"]) expect(existsSync(join(vault, proibido))).toBe(false);
  });
});
