import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Brain, modulesStateRoot } from "@brain/core";
import { controleDeReinicio, esperarServeAnterior, reiniciarProcesso } from "../src/reinicio.js";
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
    const lidos: string[] = [];
    const lerProc = (c: string) => { lidos.push(c); return "systemd\n"; };
    await expect(reiniciarProcesso({ fechar: d.fechar, logPath: join(dir, "serve.log"), env: { INVOCATION_ID: "abc" }, ppid: 4321, lerProc, spawnFn: d.spawnFn, sair: d.sair }))
      .rejects.toThrow(Saiu);
    expect(d.ordem).toEqual(["fechar", "sair(75)"]);
    expect(d.chamadas).toHaveLength(0);
    expect(lidos).toEqual(["/proc/4321/comm"]);
    // pai pid 1 também é o gerenciador
    const d1 = dubles();
    await expect(reiniciarProcesso({ fechar: d1.fechar, logPath: join(dir, "serve.log"), env: { INVOCATION_ID: "abc" }, ppid: 1, lerProc: () => "init\n", spawnFn: d1.spawnFn, sair: d1.sair }))
      .rejects.toThrow(Saiu);
    expect(d1.ordem).toEqual(["fechar", "sair(75)"]);
  });

  it("INVOCATION_ID herdado sem o systemd como pai sobe cópia destacada", async () => {
    for (const lerProc of [() => "tmux: server\n", () => { throw new Error("ENOENT"); }]) {
      const d = dubles();
      await expect(reiniciarProcesso({ fechar: d.fechar, logPath: join(dir, "serve.log"), env: { INVOCATION_ID: "abc" }, ppid: 4321, lerProc, spawnFn: d.spawnFn, sair: d.sair }))
        .rejects.toThrow(Saiu);
      expect(d.ordem).toEqual(["spawn", "unref", "fechar", "sair(0)"]);
    }
  });

  it("sem systemd sobe cópia destacada e sai 0", async () => {
    const d = dubles();
    const logPath = join(dir, "serve.log");
    await expect(reiniciarProcesso({ fechar: d.fechar, logPath, env: { FOO: "bar" }, spawnFn: d.spawnFn, sair: d.sair })).rejects.toThrow(Saiu);
    expect(d.ordem).toEqual(["spawn", "unref", "fechar", "sair(0)"]);
    const [c] = d.chamadas;
    expect(c!.cmd).toBe(process.execPath);
    expect(c!.args).toEqual([...process.execArgv, ...process.argv.slice(1)]);
    expect(c!.opts).toMatchObject({ detached: true, cwd: process.cwd() });
    // exatamente o ambiente herdado + BRAIN_SERVE_ESPERAR_PID
    expect(c!.opts.env).toEqual({ FOO: "bar", BRAIN_SERVE_ESPERAR_PID: String(process.pid) });
    expect(Object.keys(c!.opts.env as object).sort()).toEqual(["BRAIN_SERVE_ESPERAR_PID", "FOO"]);
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

  it("fechar que não termina tem teto e sai assim mesmo", async () => {
    const d = dubles(); const avisos: string[] = [];
    const t0 = Date.now();
    await expect(reiniciarProcesso({ fechar: () => new Promise<void>(() => {}), logPath: join(dir, "serve.log"), env: {}, spawnFn: d.spawnFn, sair: d.sair, limiteFecharMs: 50, avisar: (m) => avisos.push(m) }))
      .rejects.toThrow(Saiu);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(d.ordem).toEqual(["spawn", "unref", "sair(0)"]);
    expect(avisos).toEqual([expect.stringContaining("saindo assim mesmo")]);
    // sob systemd também
    const s = dubles(); const avisosS: string[] = [];
    await expect(reiniciarProcesso({ fechar: () => new Promise<void>(() => {}), logPath: join(dir, "serve.log"), env: { INVOCATION_ID: "x" }, ppid: 1, spawnFn: s.spawnFn, sair: s.sair, limiteFecharMs: 50, avisar: (m) => avisosS.push(m) }))
      .rejects.toThrow(Saiu);
    expect(s.ordem).toEqual(["sair(75)"]);
    expect(avisosS).toHaveLength(1);
  });

  it("sinal antes do spawn cancela o reinício", async () => {
    // já encerrando ao pedir
    const d = dubles();
    await expect(reiniciarProcesso({ fechar: d.fechar, logPath: join(dir, "serve.log"), env: {}, spawnFn: d.spawnFn, sair: d.sair, cancelado: () => true }))
      .rejects.toThrow("encerrando");
    expect(d.ordem).toEqual([]);
    // sinal chega depois do pedido, antes do spawn
    const d2 = dubles(); let consultas = 0;
    await expect(reiniciarProcesso({ fechar: d2.fechar, logPath: join(dir, "serve.log"), env: {}, spawnFn: d2.spawnFn, sair: d2.sair, cancelado: () => ++consultas > 1 }))
      .rejects.toThrow("encerrando");
    expect(consultas).toBe(2);
    expect(d2.ordem).toEqual([]);
  });

  it("serve.log em 0600 e girado acima de 5 MB", async () => {
    const logPath = join(dir, "girar.log");
    writeFileSync(logPath, Buffer.alloc(5 * 1024 * 1024 + 1, 120), { mode: 0o644 });
    const d = dubles();
    await expect(reiniciarProcesso({ fechar: d.fechar, logPath, env: {}, spawnFn: d.spawnFn, sair: d.sair })).rejects.toThrow(Saiu);
    expect(statSync(`${logPath}.1`).size).toBe(5 * 1024 * 1024 + 1);
    expect(statSync(logPath).size).toBe(0);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    // log pequeno já existente com outro modo: não gira, mas passa a 0600
    const outro = join(dir, "modo.log");
    writeFileSync(outro, "antigo\n", { mode: 0o644 });
    const d2 = dubles();
    await expect(reiniciarProcesso({ fechar: d2.fechar, logPath: outro, env: {}, spawnFn: d2.spawnFn, sair: d2.sair })).rejects.toThrow(Saiu);
    expect(statSync(outro).mode & 0o777).toBe(0o600);
    expect(readFileSync(outro, "utf8")).toBe("antigo\n");
    expect(existsSync(`${outro}.1`)).toBe(false);
  });
});

describe("controleDeReinicio", () => {
  const opts = { fechar: async () => {}, logPath: join(tmpdir(), "nao-usado.log") };

  it("recusa enquanto sobe e depois de encerrar; um reinício por vez", async () => {
    const pedidos: { cancelado?: () => boolean }[] = [];
    let falhar = true;
    const reiniciar = async (o: { cancelado?: () => boolean }) => {
      pedidos.push(o); await new Promise((ok) => setImmediate(ok));
      if (falhar) throw new Error("spawn falhou");
    };
    const c = controleDeReinicio({ ...opts, reiniciar: reiniciar as never });
    await expect(c.reiniciarServe()).rejects.toThrow("ainda está subindo");
    expect(pedidos).toHaveLength(0);
    c.pronto();
    // dois pedidos simultâneos: um reinício só; a falha libera nova tentativa
    const [a, b] = [c.reiniciarServe(), c.reiniciarServe()];
    await expect(a).rejects.toThrow("spawn falhou"); await expect(b).rejects.toThrow("spawn falhou");
    expect(pedidos).toHaveLength(1);
    falhar = false;
    await c.reiniciarServe();
    expect(pedidos).toHaveLength(2);
    // o cancelado acompanha o encerramento
    expect(pedidos[1]!.cancelado!()).toBe(false);
    c.encerrando();
    expect(pedidos[1]!.cancelado!()).toBe(true);
  });

  it("encerrando recusa pedido novo", async () => {
    let chamadas = 0;
    const c = controleDeReinicio({ ...opts, reiniciar: (async () => { chamadas++; }) as never });
    c.pronto(); c.encerrando();
    await expect(c.reiniciarServe()).rejects.toThrow("encerrando");
    expect(chamadas).toBe(0);
  });
});

describe("esperarServeAnterior", () => {
  it("consome a variável e respeita o limite com pid que não sai", async () => {
    const env: NodeJS.ProcessEnv = { BRAIN_SERVE_ESPERAR_PID: String(process.ppid) };
    const t0 = Date.now();
    await esperarServeAnterior(env, 300);
    const gasto = Date.now() - t0;
    expect(gasto).toBeGreaterThanOrEqual(300);
    expect(gasto).toBeLessThan(1500);
    expect("BRAIN_SERVE_ESPERAR_PID" in env).toBe(false);
    // valor inválido: consumido e ignorado
    const inv: NodeJS.ProcessEnv = { BRAIN_SERVE_ESPERAR_PID: "abc" };
    await esperarServeAnterior(inv, 300);
    expect(inv).toEqual({});
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
