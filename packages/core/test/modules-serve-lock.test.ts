import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Sequências da trava do serve difíceis de provocar de verdade: o uptime da máquina (relógio do WSL depois de o host dormir)
// e um terceiro processo criando o lock no meio de uma retomada (gancho antes do `link`).
const relogio = { uptimeS: undefined as number | undefined };
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, uptime: () => relogio.uptimeS ?? os.uptime() };
});
const ganchos = { antesDoLink: undefined as ((origem: string, destino: string) => void) | undefined };
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, linkSync: (...a: Parameters<typeof fs.linkSync>) => { ganchos.antesDoLink?.(String(a[0]), String(a[1])); return fs.linkSync(...a); } };
});

const { acquireServeLock, writeServeInfo } = await import("../src/index.js");

function montar() {
  const base = mkdtempSync(join(tmpdir(), "brain-trava-"));
  const root = join(base, "modules"); mkdirSync(root);
  const vault = { root: join(base, "vault"), tokenPath: join(base, "api-token") };
  mkdirSync(vault.root);
  return { base, root, vault, lock: join(base, "serve.lock"), mutex: join(base, "serve.lock.retomando") };
}
const minutosAtras = (m: number) => new Date(Date.now() - m * 60_000);
const nonceDe = (arq: string) => (JSON.parse(readFileSync(arq, "utf8")) as { nonce: string }).nonce;

const servidores: Server[] = [];
afterEach(async () => {
  relogio.uptimeS = undefined; ganchos.antesDoLink = undefined;
  await Promise.all(servidores.splice(0).map((s) => new Promise<void>((ok) => { s.close(() => ok()); s.closeAllConnections(); })));
});

describe("serve.lock: 'anterior ao boot' só vale para lock sem renovação há mais de 10 min (relógio do WSL)", () => {
  it("lock renovado há 3 min que parece anterior ao boot (uptime de 1 min), serve não confirmado: recusa", async () => {
    const { root, vault, lock } = montar();
    relogio.uptimeS = 60; // o relógio de parede saltou com o sono do host; o uptime não
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, nonce: "renovado", desde: "" }));
    utimesSync(lock, minutosAtras(3), minutosAtras(3));
    writeServeInfo(root, { url: "http://127.0.0.1:9", pid: process.ppid, iniciado: "" }); // sem api-token: indeterminado
    await expect(acquireServeLock(root, vault)).rejects.toThrow(/que não respondeu/);
    expect(nonceDe(lock)).toBe("renovado");
  });

  it("sem serve.json do pid: lock de 3 min 'anterior ao boot' ainda é de um serve subindo (recusa)", async () => {
    const { root, vault, lock } = montar();
    relogio.uptimeS = 60;
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, nonce: "subindo", desde: "" }));
    utimesSync(lock, minutosAtras(3), minutosAtras(3));
    await expect(acquireServeLock(root, vault)).rejects.toThrow(/subindo para este vault/);
    expect(nonceDe(lock)).toBe("subindo");
  });

  it("anterior ao boot e sem renovação há mais de 10 min: velho, retomado", async () => {
    const { root, vault, lock } = montar();
    relogio.uptimeS = 60;
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, nonce: "antigo", desde: "" }));
    utimesSync(lock, minutosAtras(11), minutosAtras(11));
    writeServeInfo(root, { url: "http://127.0.0.1:9", pid: process.ppid, iniciado: "" });
    const l = await acquireServeLock(root, vault);
    expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
    l.liberar();
  });
});

describe("serve.lock: retomadas serializadas por serve.lock.retomando", () => {
  it("três processos: B avaliou o lock velho, A já o retomou (LA); B não tira LA do lugar, mesmo com C criando LC", async () => {
    const { root, vault, lock } = montar();
    writeFileSync(vault.tokenPath, "tok");
    // L0: pid vivo (1) com serve.json dele; a confirmação (o await de B) é o ponto em que A retoma e cria LA
    const s = createServer((_q, res) => {
      writeFileSync(lock, JSON.stringify({ pid: process.ppid, nonce: "LA", desde: new Date().toISOString() })); // A venceu
      res.writeHead(404); res.end(); // L0 é de um pid reaproveitado: morto
    });
    servidores.push(s);
    const porta = await new Promise<number>((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as { port: number }).port)));
    writeFileSync(lock, JSON.stringify({ pid: 1, nonce: "L0", desde: "" }));
    writeServeInfo(root, { url: `http://127.0.0.1:${porta}`, pid: 1, iniciado: "" });
    // C cria o seu lock assim que o caminho fica livre, antes de B conseguir devolver LA
    ganchos.antesDoLink = (origem, destino) => {
      if (destino === lock && origem.endsWith(".velho")) writeFileSync(lock, JSON.stringify({ pid: process.ppid, nonce: "LC", desde: "" }));
    };
    await expect(acquireServeLock(root, vault)).rejects.toThrow(/subindo para este vault/);
    expect(nonceDe(lock)).toBe("LA"); // o lock de A continua no lugar
  });

  it("mutex de retomada recente (outra retomada em curso): não retoma e não apaga o mutex", async () => {
    const { root, vault, lock, mutex } = montar();
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 4242, nonce: "morto", desde: "" }));
    mkdirSync(mutex);
    await expect(acquireServeLock(root, vault)).rejects.toMatchObject({ code: "locked" });
    expect(nonceDe(lock)).toBe("morto");
    expect(existsSync(mutex)).toBe(true);
  });

  it("mutex de retomada com mais de 30 s (dono caiu no meio): removido, o lock velho é retomado e o mutex não fica", async () => {
    const { root, vault, lock, mutex } = montar();
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 4242, nonce: "morto", desde: "" }));
    mkdirSync(mutex);
    const velho = new Date(Date.now() - 31_000);
    utimesSync(mutex, velho, velho);
    const l = await acquireServeLock(root, vault);
    expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
    expect(existsSync(mutex)).toBe(false);
    l.liberar();
  });
});
