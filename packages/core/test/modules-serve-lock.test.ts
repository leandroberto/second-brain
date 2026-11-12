import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Sequências da trava do serve difíceis de provocar de verdade: o uptime da máquina (relógio do WSL depois de o host dormir)
// e outros processos agindo no meio de uma retomada (ganchos antes do `link`, do `mkdir` do mutex e da remoção do mutex velho).
// `eventos` registra a ordem de `fsync` e `link` (o conteúdo do lock vai a disco antes de o lock aparecer).
const relogio = { uptimeS: undefined as number | undefined };
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, uptime: () => relogio.uptimeS ?? os.uptime() };
});
type Gancho = ((...caminhos: string[]) => void) | undefined;
const ganchos = { antesDoLink: undefined as Gancho, antesDoMkdir: undefined as Gancho, antesDeRemoverMutex: undefined as Gancho };
const eventos: string[] = [];
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const ehMutex = (p: unknown) => String(p).endsWith(".retomando");
  return {
    ...fs,
    linkSync: (...a: Parameters<typeof fs.linkSync>) => { ganchos.antesDoLink?.(String(a[0]), String(a[1])); eventos.push(`link ${String(a[1])}`); return fs.linkSync(...a); },
    fsyncSync: (...a: Parameters<typeof fs.fsyncSync>) => { eventos.push("fsync"); return fs.fsyncSync(...a); },
    mkdirSync: ((...a: Parameters<typeof fs.mkdirSync>) => { if (ehMutex(a[0])) ganchos.antesDoMkdir?.(String(a[0])); return fs.mkdirSync(...a); }) as typeof fs.mkdirSync,
    renameSync: (...a: Parameters<typeof fs.renameSync>) => { if (ehMutex(a[0])) ganchos.antesDeRemoverMutex?.(String(a[0])); return fs.renameSync(...a); },
    rmdirSync: (...a: Parameters<typeof fs.rmdirSync>) => { if (ehMutex(a[0])) ganchos.antesDeRemoverMutex?.(String(a[0])); return fs.rmdirSync(...a); },
  };
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
  relogio.uptimeS = undefined; ganchos.antesDoLink = undefined; ganchos.antesDoMkdir = undefined; ganchos.antesDeRemoverMutex = undefined; eventos.length = 0;
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

  it("mutex de retomada recente (outra retomada em curso): não retoma, não apaga o mutex e a mensagem diz o que fazer", async () => {
    const { root, vault, lock, mutex } = montar();
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 4242, nonce: "morto", desde: "" }));
    mkdirSync(mutex);
    await expect(acquireServeLock(root, vault)).rejects.toMatchObject({
      code: "locked",
      message: `outra subida está retomando o lock (serve.lock.retomando); espere até 30 s e tente de novo, ou apague ${mutex} se nenhum brain serve estiver subindo`,
    });
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

  it("mutex velho: dois processos o acham velho; quem chega depois não apaga o mutex novo do outro", async () => {
    const { root, vault, lock, mutex } = montar();
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 4242, nonce: "morto", desde: "" }));
    mkdirSync(mutex);
    const velho = new Date(Date.now() - 31_000);
    utimesSync(mutex, velho, velho);
    // entre a avaliação (velho) e a remoção, o outro processo removeu o velho e criou o seu (está retomando agora)
    let inoDoOutro = 0;
    ganchos.antesDeRemoverMutex = (m) => {
      ganchos.antesDeRemoverMutex = undefined;
      rmdirSync(m); mkdirSync(m); inoDoOutro = statSync(m).ino;
    };
    await expect(acquireServeLock(root, vault)).rejects.toThrow(/outra subida está retomando o lock/);
    expect(statSync(mutex).ino).toBe(inoDoOutro); // o mutex do outro continua no lugar
    expect(nonceDe(lock)).toBe("morto"); // e só ele retoma
  });
});

describe("serve.lock: identidade do lock avaliado (FS sem hard link: lock vazio não tem nonce)", () => {
  it("B avaliou um lock velho vazio; A o retomou e criou o seu, ainda vazio (wx): B não remove o lock de A", async () => {
    const { root, vault, lock } = montar();
    writeFileSync(lock, "");
    utimesSync(lock, minutosAtras(11), minutosAtras(11));
    let inoDeA = 0;
    ganchos.antesDoMkdir = () => { // B entra no mutex depois de A ter retomado o velho e criado o novo
      ganchos.antesDoMkdir = undefined;
      rmSync(lock); writeFileSync(lock, ""); inoDeA = statSync(lock).ino;
    };
    await expect(acquireServeLock(root, vault)).rejects.toThrow(/lock vazio ou ilegível recente/);
    expect(statSync(lock).ino).toBe(inoDeA);
  });
});

describe("serve.lock: conteúdo em disco antes de o lock aparecer", () => {
  it("o tmp passa por fsync antes do link", async () => {
    const { root, vault, lock } = montar();
    const l = await acquireServeLock(root, vault);
    const iLink = eventos.indexOf(`link ${lock}`);
    expect(iLink).toBeGreaterThan(0);
    expect(eventos.slice(0, iLink)).toContain("fsync");
    l.liberar();
  });
});
