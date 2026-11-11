import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Brain, ModuleRegistry, clearServeInfo, isHumanSession, issueHumanSession, loadModules, modulesStateRoot, readServeInfo, revokeHumanSession, serveEstado, serveVivo, vaultFingerprint, writeServeInfo } from "@brain/core";
import { startServe } from "../src/serve.js";
import { dispararTarefa, modulesChecks } from "../src/modules.js";
import { terminalHuman } from "../../core/test/helpers.js";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const API_FIX = resolve(import.meta.dirname, "../../api/test/fixtures/modules");
const CORE_FIX = resolve(import.meta.dirname, "../../core/test/fixtures/modules");
const savedState = process.env.BRAIN_STATE_DIR;

let dir: string; let brain: Brain; let root: string; let semServe: string;
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
  // URL de uma porta onde ninguém escuta (conexão recusada)
  const s = createServer(); await new Promise<void>((ok) => s.listen(0, "127.0.0.1", () => ok()));
  semServe = `http://127.0.0.1:${(s.address() as { port: number }).port}`; await new Promise<void>((ok) => s.close(() => ok()));
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

describe("liveness do serve e serve duplicado", () => {
  it("pid vivo alheio com URL sem serve conta como morto e o marcador é recuperado", async () => {
    // pid que existe (o processo pai do teste) mas não é um serve: só o kill(pid, 0) diria "vivo"
    writeServeInfo(root, { url: semServe, pid: process.ppid, iniciado: new Date().toISOString() });
    expect(readServeInfo(root)).toEqual({ url: semServe, pid: process.ppid });
    expect(await serveEstado(root, brain.vault)).toEqual({ estado: "morto" });
    expect(await serveVivo(root, brain.vault)).toBeUndefined();
    writeFileSync(join(root, "_executando.json"), JSON.stringify([{ id: "ok", onde: "rota:GET /eco", desde: new Date().toISOString() }]));
    const reg = await loadModules(brain, { modo: "serve" });
    expect(existsSync(join(root, "_executando.json"))).toBe(false);
    expect(reg.errors("ok").at(-1)).toMatchObject({ onde: "rota:GET /eco", mensagem: "o serve caiu enquanto ok executava rota:GET /eco" });
    rmSync(join(root, "..", "serve.json"), { force: true });
  });

  it("segundo brain serve no mesmo vault é recusado e não mexe no vivo", async () => {
    const s = await startServe(brain, { port: 0, sessions: sessions() });
    try {
      expect(await serveVivo(root, brain.vault)).toEqual({ url: s.url, pid: process.pid });
      writeFileSync(join(root, "_executando.json"), "[]"); // marcador "do vivo": o recusado não pode apagá-lo
      const r = await run(process.execPath, [BIN, "serve", "--port", "0", "--vault", brain.vault.root], { env: env(), timeout: 30_000 }).catch((e) => e as { code: number; stderr: string });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`já há um brain serve rodando para este vault em ${s.url}`);
      expect(readServeInfo(root)).toEqual({ url: s.url, pid: process.pid });
      expect(existsSync(join(root, "_executando.json"))).toBe(true);
      rmSync(join(root, "_executando.json"));
    } finally { await s.close(); }
  });
});

describe("serve que não responde e lock do serve", () => {
  it("serve anunciado que aceita a conexão e nunca responde: indeterminado, nada destrutivo acontece", async () => {
    const mudo = createServer(() => { /* nunca responde: event loop do serve travado */ });
    const porta = await new Promise<number>((ok) => mudo.listen(0, "127.0.0.1", () => ok((mudo.address() as { port: number }).port)));
    // pid vivo de verdade e diferente deste processo (o pai do teste), como o de um serve travado
    writeServeInfo(root, { url: `http://127.0.0.1:${porta}`, pid: process.ppid, iniciado: new Date().toISOString() });
    const marcador = JSON.stringify([{ id: "ok", onde: "tarefa:diaria", desde: new Date().toISOString() }]);
    try {
      expect(await serveEstado(root, brain.vault)).toMatchObject({ estado: "indeterminado", pid: process.ppid });
      await expect(startServe(brain, { port: 0, sessions: sessions() })).rejects.toThrow(/não respondeu.*encerre-o/);
      expect(existsSync(join(root, "..", "serve.lock"))).toBe(false); // a recusa libera o lock
      writeFileSync(join(root, "_executando.json"), marcador);
      const antes = new ModuleRegistry(root).errors("ok").length;
      await loadModules(brain, { modo: "serve" });
      expect(readFileSync(join(root, "_executando.json"), "utf8")).toBe(marcador); // não recuperou nem apagou (nem o iniciar mexeu)
      expect(new ModuleRegistry(root).errors("ok")).toHaveLength(antes);
    } finally {
      rmSync(join(root, "_executando.json"), { force: true }); rmSync(join(root, "..", "serve.json"), { force: true });
      await new Promise<void>((ok) => { mudo.close(() => ok()); mudo.closeAllConnections(); });
    }
  });

  it("dois startServe concorrentes: um recusa; lock de pid morto é retomado", async () => {
    const r = await Promise.allSettled([startServe(brain, { port: 0, sessions: sessions() }), startServe(brain, { port: 0, sessions: sessions() })]);
    const ok = r.filter((x) => x.status === "fulfilled");
    const recusado = r.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(recusado).toHaveLength(1);
    expect(String(recusado[0]!.reason)).toMatch(/já há um brain serve/);
    await (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof startServe>>>).value.close();
    expect(existsSync(join(root, "..", "serve.lock"))).toBe(false);
    writeFileSync(join(root, "..", "serve.lock"), JSON.stringify({ pid: 2 ** 22 + 54321, nonce: "x", desde: new Date().toISOString() }));
    const s = await startServe(brain, { port: 0, sessions: sessions() });
    await s.close();
    expect(existsSync(join(root, "..", "serve.lock"))).toBe(false);
  });
});

describe("lock do serve depois de uma queda (pid reaproveitado)", () => {
  const lock = () => join(root, "..", "serve.lock");
  const queda = (pid: number) => {
    // sobras de um SIGKILL/queda de energia: lock e serve.json com o mesmo pid, que renasceu em outro processo
    writeFileSync(lock(), JSON.stringify({ pid, nonce: "de-um-processo-anterior", desde: new Date(Date.now() - 60_000).toISOString() }));
    writeServeInfo(root, { url: semServe, pid, iniciado: new Date().toISOString() });
  };

  it("lock e serve.json com o pid deste processo (nonce desconhecido): o serve sobe", async () => {
    queda(process.pid);
    const s = await startServe(brain, { port: 0, sessions: sessions() });
    try { expect(readServeInfo(root)).toEqual({ url: s.url, pid: process.pid }); } finally { await s.close(); }
    expect(existsSync(lock())).toBe(false);
  });

  it("lock e serve.json com um pid vivo alheio e URL fechada: serveEstado morto, o serve sobe", async () => {
    queda(process.ppid);
    const s = await startServe(brain, { port: 0, sessions: sessions() });
    await s.close();
    expect(existsSync(lock())).toBe(false);
  });

  it("lock vivo de outro processo ainda subindo (sem serve.json dele): recusa citando o lock", async () => {
    writeFileSync(lock(), JSON.stringify({ pid: process.ppid, nonce: "x", desde: new Date().toISOString() }));
    rmSync(join(root, "..", "serve.json"), { force: true });
    try { await expect(startServe(brain, { port: 0, sessions: sessions() })).rejects.toThrow(`já há um brain serve subindo para este vault (pid ${process.ppid})`); }
    finally { rmSync(lock(), { force: true }); }
    expect(String(await startServe(brain, { port: 0, sessions: sessions() }).then(async (s) => { await s.close(); return "subiu"; }))).toBe("subiu");
  });

  it("retomada concorrente de um lock velho: só um vence, o lock do vencedor não é apagado", async () => {
    writeFileSync(lock(), JSON.stringify({ pid: 2 ** 22 + 777, nonce: "morto", desde: new Date().toISOString() }));
    const r = await Promise.allSettled([startServe(brain, { port: 0, sessions: sessions() }), startServe(brain, { port: 0, sessions: sessions() })]);
    const ok = r.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof startServe>>> => x.status === "fulfilled");
    expect(ok).toHaveLength(1);
    expect(String((r.find((x) => x.status === "rejected") as PromiseRejectedResult).reason)).toContain(`(lock: ${lock()})`);
    expect(existsSync(lock())).toBe(true); // o do vencedor
    await ok[0]!.value.close();
    expect(existsSync(lock())).toBe(false);
  });

  it("lock velho retomado por outro processo entre a avaliação e o rename: o lock novo é devolvido, não apagado", async () => {
    let chamadas = 0;
    // durante a 1ª checagem HTTP (lock avaliado como de um serve que caiu), "outro processo" retoma o lock com nonce "novo"
    // e passa a responder como o serve vivo deste vault
    const srv = createServer((_q, res) => {
      chamadas++;
      if (chamadas === 1) {
        writeFileSync(lock(), JSON.stringify({ pid: process.ppid, nonce: "novo", desde: new Date().toISOString() }));
        res.writeHead(404); res.end("{}"); return;
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ pid: process.ppid, vault: vaultFingerprint(brain.vault.root) }));
    });
    const porta = await new Promise<number>((ok) => srv.listen(0, "127.0.0.1", () => ok((srv.address() as { port: number }).port)));
    writeFileSync(lock(), JSON.stringify({ pid: process.ppid, nonce: "velho", desde: new Date().toISOString() }));
    writeServeInfo(root, { url: `http://127.0.0.1:${porta}`, pid: process.ppid, iniciado: new Date().toISOString() });
    try {
      await expect(startServe(brain, { port: 0, sessions: sessions() })).rejects.toThrow("já há um brain serve rodando para este vault");
      expect(JSON.parse(readFileSync(lock(), "utf8")).nonce).toBe("novo");
    } finally {
      rmSync(lock(), { force: true }); rmSync(join(root, "..", "serve.json"), { force: true });
      await new Promise<void>((ok) => { srv.close(() => ok()); srv.closeAllConnections(); });
    }
  });

  it("serve.json apontando para outro servidor (404) é morto; 5xx é indeterminado", async () => {
    let status = 404;
    const outro = createServer((_q, res) => { res.writeHead(status); res.end("{}"); });
    const porta = await new Promise<number>((ok) => outro.listen(0, "127.0.0.1", () => ok((outro.address() as { port: number }).port)));
    writeServeInfo(root, { url: `http://127.0.0.1:${porta}`, pid: process.ppid, iniciado: new Date().toISOString() });
    try {
      expect(await serveEstado(root, brain.vault)).toEqual({ estado: "morto" });
      status = 503;
      expect(await serveEstado(root, brain.vault)).toMatchObject({ estado: "indeterminado", motivo: "respondeu HTTP 503" });
    } finally { rmSync(join(root, "..", "serve.json"), { force: true }); await new Promise<void>((ok) => { outro.close(() => ok()); outro.closeAllConnections(); }); }
  });

  it("falha ao gravar o serve.json depois do listen: API, agendador e módulos desfeitos e lock liberado", async () => {
    const livre = createServer();
    const porta = await new Promise<number>((ok) => livre.listen(0, "127.0.0.1", () => ok((livre.address() as { port: number }).port)));
    await new Promise<void>((ok) => livre.close(() => ok()));
    mkdirSync(join(root, "..", "serve.json"), { recursive: true }); // rename do tmp sobre um diretório falha
    try {
      await expect(startServe(brain, { port: porta, sessions: sessions() })).rejects.toThrow();
      expect(existsSync(lock())).toBe(false);
      // a porta voltou a ficar livre: a API foi fechada
      const de_novo = createServer();
      await new Promise<void>((ok, err) => { de_novo.once("error", err); de_novo.listen(porta, "127.0.0.1", () => ok()); });
      await new Promise<void>((ok) => de_novo.close(() => ok()));
    } finally { rmSync(join(root, "..", "serve.json"), { recursive: true, force: true }); }
  });
});

describe("doctor: erros recentes dos módulos", () => {
  it("mostra os erros recentes e um erro nas últimas 24 h vira warn", async () => {
    const reg = new ModuleRegistry(root);
    reg.recordError("ok", "tarefa:diaria", new Error("o serve caiu enquanto ok executava tarefa:diaria"));
    const checks = await modulesChecks(brain, 1);
    const ok = checks.find((c) => c.id === "module-ok")!;
    expect(ok.status).toBe("warn");
    expect(ok.detail).toContain("tarefa:diaria: o serve caiu enquanto ok executava tarefa:diaria");
    expect(checks.find((c) => c.id === "modules")!.status).toBe("warn");
  });

  it("via serve usa os erros de GET /api/modules", async () => {
    const s = await startServe(brain, { port: 0, sessions: sessions() });
    try {
      s.registry.recordError("ok", "mcp:eco", new Error("falha registrada pelo serve"));
      const ok = (await modulesChecks(brain)).find((c) => c.id === "module-ok")!;
      expect(ok.detail).toContain("mcp:eco: falha registrada pelo serve");
      expect(ok.status).toBe("warn");
    } finally { await s.close(); }
  });
});

describe("brain modules run: a sessão curta é sempre revogada", () => {
  const base = () => {
    const revogadas: string[] = []; const saidas: number[] = [];
    return { revogadas, saidas, o: { url: "http://127.0.0.1:1", id: "ok", tarefa: "diaria", emitir: () => "hs_sessao", revogar: (t: string) => { revogadas.push(t); }, sinais: new EventEmitter(), sair: (c: number) => { saidas.push(c); } } };
  };
  const resposta = (status: number, corpo: unknown) => (async () => new Response(JSON.stringify(corpo), { status })) as unknown as typeof fetch;

  const falhaDeRede = (code: string) => (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) }); }) as unknown as typeof fetch;

  it("erro de rede: conexão recusada (nada saiu) e conexão caída (a tarefa pode ter começado)", async () => {
    const t = base();
    expect(await dispararTarefa({ ...t.o, fetch: falhaDeRede("ECONNREFUSED") })).toMatchObject({ codigo: 1, erro: expect.stringContaining("não está rodando") });
    expect(await dispararTarefa({ ...t.o, fetch: falhaDeRede("ECONNRESET") })).toEqual({ codigo: 1, erro: "a conexão com o brain serve caiu durante a execução; confira o resultado em brain modules list" });
    expect(t.revogadas).toEqual(["hs_sessao", "hs_sessao"]);
  });

  it("HTTP ≠ 2xx", async () => {
    const t = base();
    const r = await dispararTarefa({ ...t.o, fetch: resposta(403, { message: "rodar tarefa exige a sessão humana da UI" }) });
    expect(r).toMatchObject({ codigo: 1, erro: expect.stringContaining("403") });
    expect(t.revogadas).toEqual(["hs_sessao"]);
  });

  it("resultado ok e resultado de erro", async () => {
    const t = base();
    expect(await dispararTarefa({ ...t.o, fetch: resposta(200, { resultado: "ok" }) })).toEqual({ codigo: 0, saida: "ok/diaria: ok" });
    expect(await dispararTarefa({ ...t.o, fetch: resposta(200, { resultado: "erro", erro: "boom" }) })).toMatchObject({ codigo: 1, saida: "ok/diaria: erro — boom" });
    expect(t.revogadas).toEqual(["hs_sessao", "hs_sessao"]);
  });

  it("Ctrl+C durante a execução revoga e sai com 130; handlers removidos no fim", async () => {
    const t = base();
    let liberar!: () => void;
    const pendente = (async () => { await new Promise<void>((ok) => { liberar = ok; }); return new Response(JSON.stringify({ resultado: "ok" }), { status: 200 }); }) as unknown as typeof fetch;
    const p = dispararTarefa({ ...t.o, fetch: pendente });
    await new Promise((ok) => setImmediate(ok));
    t.o.sinais.emit("SIGINT");
    expect(t.revogadas).toEqual(["hs_sessao"]);
    expect(t.saidas).toEqual([130]);
    liberar(); await p;
    expect(t.revogadas).toEqual(["hs_sessao"]); // não revoga duas vezes
    expect(t.o.sinais.listenerCount("SIGINT") + t.o.sinais.listenerCount("SIGTERM")).toBe(0);
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
