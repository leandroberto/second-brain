import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Brain, modulesStateRoot } from "@brain/core";
import { reiniciarProcesso } from "../src/reinicio.js";
import { startServe } from "../src/serve.js";

const savedState = process.env.BRAIN_STATE_DIR;
let dir: string; let brain: Brain; let root: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-reinicio-"));
  process.env.BRAIN_STATE_DIR = join(dir, "state");
  const vault = join(dir, "vault");
  (await Brain.init(vault)).close();
  brain = await Brain.open(vault);
  root = modulesStateRoot(brain);
});
afterAll(() => {
  brain.close(); rmSync(dir, { recursive: true, force: true });
  if (savedState === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = savedState;
  delete process.env.BRAIN_SERVE_ESPERAR_PID;
});

/** `sair` falso: registra o código em vez de encerrar o processo do teste. */
class Saiu extends Error { constructor(readonly codigo: number) { super(`sair(${codigo})`); } }

/** Dublês de `spawn`, `fechar` e `sair`, registrando a ordem das chamadas. */
function dubles(o: { falhar?: boolean } = {}) {
  const ordem: string[] = [];
  const chamadas: { cmd: string; args: readonly string[]; opts: Record<string, unknown> }[] = [];
  const spawnFn = ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    ordem.push("spawn"); chamadas.push({ cmd, args, opts });
    const filho = Object.assign(new EventEmitter(), { unref: () => { ordem.push("unref"); } });
    setImmediate(() => (o.falhar ? filho.emit("error", new Error("ENOENT simulado")) : filho.emit("spawn")));
    return filho;
  }) as unknown as typeof spawn;
  const fechar = async () => { ordem.push("fechar"); };
  const sair = ((codigo: number) => { ordem.push(`sair(${codigo})`); throw new Saiu(codigo); }) as (codigo: number) => never;
  return { ordem, chamadas, spawnFn, fechar, sair };
}

describe("reiniciarProcesso", () => {
  it("systemd fecha e sai 75", async () => {
    const d = dubles();
    await expect(reiniciarProcesso({ fechar: d.fechar, logPath: join(dir, "serve.log"), env: { INVOCATION_ID: "abc" }, spawnFn: d.spawnFn, sair: d.sair }))
      .rejects.toThrow(Saiu);
    expect(d.ordem).toEqual(["fechar", "sair(75)"]);
    expect(d.chamadas).toHaveLength(0);
  });

  it("sem systemd sobe cópia destacada e sai 0", async () => {
    const d = dubles();
    const logPath = join(dir, "serve.log");
    await expect(reiniciarProcesso({ fechar: d.fechar, logPath, env: { FOO: "bar" }, spawnFn: d.spawnFn, sair: d.sair })).rejects.toThrow(Saiu);
    expect(d.ordem).toEqual(["spawn", "unref", "fechar", "sair(0)"]);
    const [c] = d.chamadas;
    expect(c!.cmd).toBe(process.execPath);
    expect(c!.args).toEqual([...process.execArgv, ...process.argv.slice(1)]);
    expect(c!.opts).toMatchObject({ detached: true, cwd: process.cwd(), env: { FOO: "bar", BRAIN_SERVE_ESPERAR_PID: String(process.pid) } });
    const stdio = c!.opts.stdio as unknown[];
    expect(stdio[0]).toBe("ignore");
    expect(typeof stdio[1]).toBe("number");
    expect(stdio[2]).toBe(stdio[1]);
    expect(existsSync(logPath)).toBe(true); // a saída da cópia vai para o serve.log
  });

  it("falha ao subir a cópia mantém o atual", async () => {
    const d = dubles({ falhar: true });
    await expect(reiniciarProcesso({ fechar: d.fechar, logPath: join(dir, "serve.log"), env: {}, spawnFn: d.spawnFn, sair: d.sair }))
      .rejects.toThrow("ENOENT simulado");
    expect(d.ordem).toEqual(["spawn"]);
  });
});

describe("startServe com BRAIN_SERVE_ESPERAR_PID", () => {
  it("processo novo espera o pid antigo", async () => {
    const filho = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((ok, erro) => { filho.once("spawn", ok); filho.once("error", erro); });
    let saiuEm = 0;
    const saida = new Promise<void>((ok) => filho.once("exit", () => { saiuEm = Date.now(); ok(); }));
    process.env.BRAIN_SERVE_ESPERAR_PID = String(filho.pid);
    const s = await startServe(brain, { port: 0, sessions: { file: join(dir, "sessions.json") }, agendador: false });
    try {
      await saida;
      // o lock (`desde`) só foi adquirido depois de o pid antigo sumir
      const lock = JSON.parse(readFileSync(join(root, "..", "serve.lock"), "utf8")) as { desde: string };
      expect(saiuEm).toBeGreaterThan(0);
      expect(Date.parse(lock.desde)).toBeGreaterThanOrEqual(saiuEm);
    } finally { await s.close(); }

    // pid inexistente: segue na hora
    process.env.BRAIN_SERVE_ESPERAR_PID = String(2 ** 22 + 12345);
    const t0 = Date.now();
    const s2 = await startServe(brain, { port: 0, sessions: { file: join(dir, "sessions.json") }, agendador: false });
    // bem abaixo do limite de 30 s da espera
    try { expect(Date.now() - t0).toBeLessThan(5000); } finally { await s2.close(); }
  });
});
