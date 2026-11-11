import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Brain, clearServeInfo, isHumanSession, issueHumanSession, modulesStateRoot, readServeInfo, revokeHumanSession, writeServeInfo } from "@brain/core";
import { startServe } from "../src/serve.js";
import { terminalHuman } from "../../core/test/helpers.js";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const API_FIX = resolve(import.meta.dirname, "../../api/test/fixtures/modules");
const CORE_FIX = resolve(import.meta.dirname, "../../core/test/fixtures/modules");
const savedState = process.env.BRAIN_STATE_DIR;

let dir: string; let brain: Brain; let root: string;
const sessions = () => ({ file: join(dir, "sessions.json") });
const env = () => ({ ...process.env, HOME: dir, BRAIN_VAULT: "", BRAIN_STATE_DIR: join(dir, "state"), BRAIN_SESSIONS_FILE: sessions().file });
const brainCli = (args: string[]) => run(process.execPath, [BIN, ...args, "--vault", brain.vault.root], { env: env(), timeout: 60_000 });

/** Grava `modules` no config.yaml como o usuário faria (JSON é YAML válido). */
function gravarModulos(modules: Record<string, unknown>) {
  const atual = readFileSync(brain.vault.configPath, "utf8").replace(/^modules:.*$/m, "");
  writeFileSync(brain.vault.configPath, `${atual.trimEnd()}\nmodules: ${JSON.stringify(modules)}\n`, "utf8");
  (brain as unknown as { reloadConfig(): void }).reloadConfig();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-mod-cli-"));
  process.env.BRAIN_STATE_DIR = join(dir, "state");
  brain = await Brain.init(join(dir, "vault"));
  gravarModulos({ ok: { path: join(API_FIX, "ok"), config: { cor: "azul" } } });
  root = modulesStateRoot(brain);
});
afterAll(() => {
  brain.close(); rmSync(dir, { recursive: true, force: true });
  if (savedState === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = savedState;
});

describe("serve com módulos", () => {
  it("serve.json some no desligamento", async () => {
    const s = await startServe(brain, { port: 0, sessions: sessions() });
    try {
      expect(readServeInfo(root)).toEqual({ url: s.url, pid: process.pid });
      const arq = join(root, "..", "serve.json");
      expect(JSON.parse(readFileSync(arq, "utf8")).iniciado).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // o serve sobe os módulos: a rota do módulo responde
      const r = await fetch(`${s.url}/api/modules`, { headers: { authorization: `Bearer ${s.token}` } });
      expect((await r.json()).modulos.map((m: { id: string; status: string }) => [m.id, m.status])).toEqual([["ok", "ativo"]]);
    } finally { await s.close(); }
    expect(existsSync(join(root, "..", "serve.json"))).toBe(false);
  });

  it("serve.json: pid morto não conta e outro processo não apaga o arquivo", () => {
    writeServeInfo(root, { url: "http://127.0.0.1:1", pid: 2 ** 22 + 12345, iniciado: new Date().toISOString() });
    expect(readServeInfo(root)).toBeUndefined();
    clearServeInfo(root); // não é deste processo: fica
    expect(existsSync(join(root, "..", "serve.json"))).toBe(true);
    writeServeInfo(root, { url: "http://127.0.0.1:1", pid: process.pid, iniciado: new Date().toISOString() });
    clearServeInfo(root);
    expect(existsSync(join(root, "..", "serve.json"))).toBe(false);
  });

  it("marcador de execução vira erro na subida", async () => {
    writeFileSync(join(root, "_executando.json"), JSON.stringify([{ id: "ok", onde: "tarefa:diaria", desde: new Date().toISOString() }]));
    const s = await startServe(brain, { port: 0, sessions: sessions() });
    try {
      expect(existsSync(join(root, "_executando.json"))).toBe(false);
      expect(s.registry.errors("ok").map((e) => [e.onde, e.mensagem])).toContainEqual(["tarefa:diaria", "o serve caiu enquanto ok executava tarefa:diaria"]);
      // durante uma execução o marcador existe e lista a execução; no fim, some
      let visto: unknown;
      await s.registry.executando("ok", "mcp:eco", async () => { visto = JSON.parse(readFileSync(join(root, "_executando.json"), "utf8")); });
      expect(visto).toEqual([expect.objectContaining({ id: "ok", onde: "mcp:eco" })]);
      expect(existsSync(join(root, "_executando.json"))).toBe(false);
    } finally { await s.close(); }
  });

  it("config alterada pede reinício", async () => {
    const s = await startServe(brain, { port: 0, sessions: sessions() });
    const lista = async () => (await (await fetch(`${s.url}/api/modules`, { headers: { authorization: `Bearer ${s.token}` } })).json()) as { reiniciar: boolean };
    const original = readFileSync(brain.vault.configPath, "utf8");
    try {
      expect((await lista()).reiniciar).toBe(false);
      writeFileSync(brain.vault.configPath, original.replace('"cor":"azul"', '"cor":"verde"'), "utf8");
      expect((await lista()).reiniciar).toBe(true);
    } finally { writeFileSync(brain.vault.configPath, original, "utf8"); await s.close(); }
  });
});

describe("sessão humana curta", () => {
  it("sessão curta revogada depois do run", async () => {
    const proof = await terminalHuman("alice", sessions());
    const curta = issueHumanSession(brain.vault.root, proof, { ...sessions(), ttlMinutes: 5, label: "brain modules run" });
    const outra = issueHumanSession(brain.vault.root, proof, sessions());
    const st = JSON.parse(readFileSync(sessions().file, "utf8")) as Record<string, Array<{ label: string; created_at: string; expires_at: string }>>;
    const e = Object.values(st).flat().find((x) => x.label === "brain modules run")!;
    expect(Date.parse(e.expires_at) - Date.parse(e.created_at)).toBe(5 * 60_000);
    expect(isHumanSession(brain.vault.root, curta, sessions())).toBe(true);
    revokeHumanSession(brain.vault.root, curta, sessions());
    expect(isHumanSession(brain.vault.root, curta, sessions())).toBe(false);
    expect(isHumanSession(brain.vault.root, outra, sessions())).toBe(true);
  });

  it("revokeHumanSession de token inexistente não lança", () => {
    expect(() => revokeHumanSession(brain.vault.root, `hs_${"0".repeat(64)}`, sessions())).not.toThrow();
    expect(() => revokeHumanSession(brain.vault.root, "qualquer", { file: join(dir, "nao-existe.json") })).not.toThrow();
  });
});

describe("brain modules (processo real)", () => {
  it("modules run sem TTY recusa", async () => {
    await expect(brainCli(["modules", "run", "ok", "diaria"])).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/terminal interativo/) });
  });

  it("modules check aponta sdk errado", async () => {
    const r = await brainCli(["modules", "check", join(CORE_FIX, "sdk2")]).catch((e) => e as { code: number; stdout: string });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("sdk");
  });

  it("modules check aceita um módulo válido", async () => {
    const r = await brainCli(["modules", "check", join(API_FIX, "ok")]);
    expect(r.stdout).toMatch(/ok/);
  });

  it("modules list sem serve monta a lista pelo disco", async () => {
    const r = await brainCli(["modules", "list", "--port", "1"]);
    expect(r.stdout).toMatch(/ok\s+ativo/);
    expect(r.stdout).toContain("diaria");
  });
});
