import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireServeLock, serveEstado, vaultFingerprint, writeServeInfo } from "../src/index.js";

/** `root` é a pasta `modules/` do estado; `serve.json` e `serve.lock` ficam ao lado dela. */
function montar() {
  const base = mkdtempSync(join(tmpdir(), "brain-serve-"));
  const root = join(base, "modules"); mkdirSync(root);
  const vault = { root: join(base, "vault"), tokenPath: join(base, "api-token") };
  mkdirSync(vault.root);
  return { base, root, vault, lock: join(base, "serve.lock") };
}
const sobras = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));
const servidores: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servidores.splice(0).map((s) => new Promise<void>((ok) => { s.close(() => ok()); s.closeAllConnections(); })));
});
async function responder(status: number, corpo: string): Promise<string> {
  const s = createServer((_q, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(corpo); });
  servidores.push(s);
  const porta = await new Promise<number>((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as { port: number }).port)));
  return `http://127.0.0.1:${porta}`;
}

describe("serveEstado", () => {
  it("200 com corpo que não é JSON (outro programa na porta) é morto", async () => {
    const { root, vault } = montar();
    writeFileSync(vault.tokenPath, "tok");
    writeServeInfo(root, { url: await responder(200, "<html>outro programa</html>"), pid: process.pid, iniciado: "" });
    expect(await serveEstado(root, vault)).toEqual({ estado: "morto" });
  });

  it("200 com JSON sem pid/vault é morto; com o pid e o vault certos é vivo", async () => {
    const { root, vault } = montar();
    writeFileSync(vault.tokenPath, "tok");
    writeServeInfo(root, { url: await responder(200, JSON.stringify({ ok: true })), pid: process.pid, iniciado: "" });
    expect(await serveEstado(root, vault)).toEqual({ estado: "morto" });
    const url = await responder(200, JSON.stringify({ pid: process.pid, vault: vaultFingerprint(vault.root) }));
    writeServeInfo(root, { url, pid: process.pid, iniciado: "" });
    expect(await serveEstado(root, vault)).toEqual({ estado: "vivo", url, pid: process.pid });
  });
});

describe("serve.lock", () => {
  it("nasce já com o conteúdo (tmp + link) e não deixa tmp, na aquisição e na recusa", async () => {
    const { base, root, vault, lock } = montar();
    const l = await acquireServeLock(root, vault);
    expect(JSON.parse(readFileSync(lock, "utf8"))).toMatchObject({ pid: process.pid, nonce: expect.any(String) });
    await expect(acquireServeLock(root, vault)).rejects.toMatchObject({ code: "locked" });
    expect(sobras(base)).toEqual([]);
    l.liberar();
    expect(readdirSync(base).filter((f) => f.startsWith("serve.lock"))).toEqual([]);
  });

  it("o serve vivo renova o mtime da trava a cada 60 s; liberar para a renovação", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { root, vault, lock } = montar();
    const l = await acquireServeLock(root, vault);
    const velho = new Date(Date.now() - 30 * 60_000);
    utimesSync(lock, velho, velho);
    vi.advanceTimersByTime(60_000);
    expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(10_000);
    expect(vi.getTimerCount()).toBe(1);
    l.liberar();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("trava com mtime anterior ao último boot é velha, mesmo com o pid vivo e serve.json desse pid", async () => {
    const { root, vault, lock } = montar();
    // pid vivo alheio e serve.json dele, sem api-token para confirmar: indeterminado (recusa)...
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, nonce: "antes-do-boot", desde: "" }));
    writeServeInfo(root, { url: "http://127.0.0.1:9", pid: process.ppid, iniciado: "" });
    await expect(acquireServeLock(root, vault)).rejects.toMatchObject({ code: "locked" });
    // ...a menos que a trava seja de antes do boot: o pid foi reaproveitado
    const antesDoBoot = new Date(Date.now() - uptime() * 1000 - 5 * 60_000);
    utimesSync(lock, antesDoBoot, antesDoBoot);
    const l = await acquireServeLock(root, vault);
    expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
    l.liberar();
  });
});

describe("serve.lock vazio ou ilegível (criação por wx no meio da escrita)", () => {
  it("recente: recusa (outro serve pode estar escrevendo); mais velho que 10 min: retomado", async () => {
    const { root, vault, lock } = montar();
    writeFileSync(lock, "");
    await expect(acquireServeLock(root, vault)).rejects.toThrow(/lock vazio ou ilegível/);
    expect(readFileSync(lock, "utf8")).toBe("");
    const velho = new Date(Date.now() - 11 * 60_000);
    utimesSync(lock, velho, velho);
    const l = await acquireServeLock(root, vault);
    expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
    l.liberar();
  });
});

describe("serve.lock: a hora do boot nunca anula um serve confirmado vivo", () => {
  it("trava 'anterior ao boot' (salto de relógio) com o serve dela respondendo vivo: recusa", async () => {
    const { root, vault, lock } = montar();
    writeFileSync(vault.tokenPath, "tok");
    const url = await responder(200, JSON.stringify({ pid: process.ppid, vault: vaultFingerprint(vault.root) }));
    writeServeInfo(root, { url, pid: process.ppid, iniciado: "" });
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, nonce: "vivo", desde: "" }));
    const antesDoBoot = new Date(Date.now() - uptime() * 1000 - 5 * 60_000);
    utimesSync(lock, antesDoBoot, antesDoBoot);
    await expect(acquireServeLock(root, vault)).rejects.toThrow(/já há um brain serve rodando para este vault/);
    expect(JSON.parse(readFileSync(lock, "utf8")).nonce).toBe("vivo");
  });
});

describe("vaultFingerprint", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

  it("FS que diferencia maiúsculas: hash do caminho real como está", () => {
    const d = join(mkdtempSync(join(tmpdir(), "brain-fp-")), "Cofre");
    mkdirSync(d);
    expect(vaultFingerprint(d)).toBe(sha(realpathSync.native(d)));
  });

  it("FS que não diferencia maiúsculas (o nome com a caixa trocada é o mesmo arquivo): hash do caminho em minúsculas", () => {
    const base = mkdtempSync(join(tmpdir(), "brain-fp-"));
    const d = join(base, "Cofre");
    mkdirSync(d);
    symlinkSync(d, join(base, "cOFRE")); // simula /mnt/c ou macOS: a outra caixa resolve para o mesmo ino/dev
    expect(vaultFingerprint(d)).toBe(sha(realpathSync.native(d).toLowerCase()));
  });
});
