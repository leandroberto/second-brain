import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AvisosStore, BRAIN_TOOLS, Brain, clearServeInfo, loadModules, modulesStateRoot, vaultFingerprint, writeServeInfo } from "@brain/core";
import { moduleToolsEnabledFromEnv } from "../src/index.js";
import { loadOrCreateToken, startApi, type ApiHandle } from "@brain/api";

const BIN = fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url));
const API_FIX = resolve(import.meta.dirname, "../../api/test/fixtures/modules");
const FIX = resolve(import.meta.dirname, "fixtures/modules");
const savedState = process.env.BRAIN_STATE_DIR;

let dir: string; let vault: string; let root: string; let portaLivre: number; let token: string;
let stderr = "";
const clients: Client[] = [];

async function connect(extra: Record<string, string> = {}): Promise<Client> {
  const c = new Client({ name: "claude-code", version: "1.0.0" });
  const t = new StdioClientTransport({
    command: process.execPath, args: [BIN, "mcp"], stderr: "pipe",
    env: { ...(process.env as Record<string, string>), BRAIN_VAULT: vault, BRAIN_STATE_DIR: join(dir, "state"), BRAIN_PORT: String(portaLivre), ...extra },
  });
  t.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
  await c.connect(t);
  clients.push(c);
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
  const text = r.content[0]!.text;
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { ...r, text, data };
};
const ouvir = (s: Server) => new Promise<number>((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as { port: number }).port)));
const fechar = (s: Server) => new Promise<void>((ok) => { s.close(() => ok()); s.closeAllConnections?.(); });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-mod-mcp-"));
  process.env.BRAIN_STATE_DIR = join(dir, "state");
  vault = join(dir, "vault");
  const b = await Brain.init(vault);
  const modules = { ok: { path: join(API_FIX, "ok") }, brain: { path: join(FIX, "brain") }, repete: { path: join(FIX, "repete") } };
  const atual = readFileSync(b.vault.configPath, "utf8").replace(/^modules:.*$/m, "");
  writeFileSync(b.vault.configPath, `${atual.trimEnd()}\nmodules: ${JSON.stringify(modules)}\n`, "utf8");
  root = modulesStateRoot(b);
  token = loadOrCreateToken(b.vault);
  b.close();
  // porta sem ninguém escutando: o fallback BRAIN_PORT não pode achar um serve de verdade da máquina
  const s = createServer(); portaLivre = await ouvir(s); await fechar(s);
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  rmSync(dir, { recursive: true, force: true });
  if (savedState === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = savedState;
});

describe("ferramentas MCP de módulo", () => {
  it("registra ferramenta com prefixo", async () => {
    const c = await connect();
    const tools = (await c.listTools()).tools;
    const nomes = tools.map((t) => t.name);
    expect(nomes).toEqual(expect.arrayContaining(["ok_eco", "ok_quebra", "repete_eco"]));
    expect(tools.find((t) => t.name === "ok_eco")!.inputSchema).toMatchObject({ type: "object", properties: { texto: { type: "string" } }, required: ["texto"] });
    expect(tools.find((t) => t.name === "repete_eco")!.description).toBe("primeira");
    expect(nomes.filter((n) => n === "repete_eco")).toHaveLength(1);
    expect(nomes.some((n) => /Invalido|repete_lista/.test(n))).toBe(false);
    expect(stderr).toMatch(/repete_eco.*repetid/);
  });

  it("conflito com brain_* é ignorado", async () => {
    const c = await connect();
    const nomes = (await c.listTools()).tools.map((t) => t.name);
    expect(nomes.filter((n) => n === "brain_search")).toHaveLength(1);
    expect(stderr).toMatch(/brain_search/);
    // continua sendo a ferramenta do core
    const r = await call(c, "brain_search", { query: "qualquer" });
    expect(r.isError).toBeFalsy();
    expect(Array.isArray(r.data)).toBe(true);
  });

  it("BRAIN_MCP_SEM_MODULOS=1 (MCP do assistente) não registra ferramentas de módulo", async () => {
    expect(moduleToolsEnabledFromEnv({ BRAIN_MCP_SEM_MODULOS: "1" })).toBe(false);
    expect(moduleToolsEnabledFromEnv({})).toBe(true);
    expect(moduleToolsEnabledFromEnv({ BRAIN_MCP_SEM_MODULOS: "0" })).toBe(true);
    const c = await connect({ BRAIN_MCP_SEM_MODULOS: "1" });
    const nomes = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(nomes).toEqual([...BRAIN_TOOLS].sort());
  });

  it("serve.json com pid reusado apontando para outro processo: tratado como fora do ar", async () => {
    // na URL anunciada responde outra coisa (pid e vault diferentes): só o kill(pid, 0) diria "vivo"
    const outro = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/api/serve" ? { pid: 1, vault: "outro-vault" } : { resultado: "sequestro" }));
    });
    const porta = await ouvir(outro);
    writeServeInfo(root, { url: `http://127.0.0.1:${porta}`, pid: process.ppid, iniciado: new Date().toISOString() });
    try {
      const c = await connect();
      const r = await call(c, "ok_eco", { texto: "oi" });
      expect(r.isError).toBe(true);
      expect(r.text).toBe("o brain serve não está rodando; a ferramenta ok_eco precisa dele");
    } finally { rmSync(join(dir, "state", "serve.json"), { force: true }); await fechar(outro); }
  });

  it("serve anunciado que não responde: erro claro, sem cair no fallback", async () => {
    const mudo = createServer(() => { /* aceita a conexão e nunca responde */ });
    const porta = await ouvir(mudo);
    writeServeInfo(root, { url: `http://127.0.0.1:${porta}`, pid: process.ppid, iniciado: new Date().toISOString() });
    try {
      const c = await connect();
      const r = await call(c, "ok_eco", { texto: "oi" });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(new RegExp(`^o brain serve em http://127\\.0\\.0\\.1:${porta} \\(pid ${process.ppid}\\) não respondeu .*; a ferramenta ok_eco precisa dele$`));
      expect(r.text).not.toContain(token);
    } finally { rmSync(join(dir, "state", "serve.json"), { force: true }); await fechar(mudo); }
  });

  it("sem serve devolve erro claro", async () => {
    clearServeInfo(root);
    const c = await connect();
    const r = await call(c, "ok_eco", { texto: "oi" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("o brain serve não está rodando; a ferramenta ok_eco precisa dele");
  });

  it("executa via serve", async () => {
    const b = await Brain.open(vault);
    const avisos = new AvisosStore(root);
    const registry = await loadModules(b, { modo: "serve", deps: { avisos } });
    const api: ApiHandle = await startApi(b, { port: 0, sessions: { file: join(dir, "sessions.json") }, modules: { registry, avisos, root } });
    writeServeInfo(root, { url: api.url, pid: process.pid, iniciado: new Date().toISOString() });
    try {
      const c = await connect();
      const r = await call(c, "ok_eco", { texto: "oi" });
      expect(r.isError).toBeFalsy();
      expect(r.data).toEqual({ eco: "oi" });
      // schema com defeito no módulo: o serve responde 500 e a ferramenta devolve erro, sem detalhe interno
      const q = await call(c, "ok_quebra", {});
      expect(q.isError).toBe(true);
      expect(q.text).toMatch(/ok_quebra falhou/);
    } finally { clearServeInfo(root); await api.close(); b.close(); }
  });

  it("serve respondendo 403 ou 500 vira erro da ferramenta sem o token", async () => {
    let status = 403;
    // serve falso que ecoa a credencial na mensagem: o MCP não pode repassá-la. Responde /api/serve como o serve do vault
    const falso = createServer((req, res) => {
      if (req.url === "/api/serve") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ pid: process.pid, vault: vaultFingerprint(vault) })); return; }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "x", message: `negado para ${req.headers.authorization}` }));
    });
    const porta = await ouvir(falso);
    writeServeInfo(root, { url: `http://127.0.0.1:${porta}`, pid: process.pid, iniciado: new Date().toISOString() });
    try {
      const c = await connect();
      const r403 = await call(c, "ok_eco", { texto: "oi" });
      expect(r403.isError).toBe(true);
      expect(r403.text).toMatch(/negou a ferramenta ok_eco/);
      expect(r403.text).not.toContain(token);
      status = 500;
      const r500 = await call(c, "ok_eco", { texto: "oi" });
      expect(r500.isError).toBe(true);
      expect(r500.text).toMatch(/ok_eco falhou/);
      expect(r500.text).not.toContain(token);
    } finally { clearServeInfo(root); await fechar(falso); }
  });
});
