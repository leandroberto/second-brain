import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

/** Código de saída sob systemd: ≠ 0, então a unit (`Restart=on-failure`) sobe o serve de novo (ver scripts/second-brain.service). */
export const CODIGO_REINICIO_SYSTEMD = 75;
/** Limite da espera do processo anterior; passado, a aquisição normal do `serve.lock` decide (recusa se ainda houver serve vivo). */
const ESPERA_PID_MS = 30_000;
const INTERVALO_ESPERA_MS = 100;

export interface ReiniciarOptions {
  /** fecha o serve pelo mesmo caminho do SIGTERM (`h.close()` + `b.close()`) */
  fechar: () => Promise<void>;
  /** saída da cópia destacada (`<diretório de estado>/serve.log`) */
  logPath: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  sair?: (codigo: number) => never;
}

/**
 * Reinicia o `brain serve` (spec de gerenciar módulos §7.1) sem depender de como ele foi iniciado:
 * - sob systemd (`INVOCATION_ID`): fecha e sai com `CODIGO_REINICIO_SYSTEMD`; a unit sobe o serve de novo;
 * - senão: sobe uma cópia destacada de si mesmo (mesmo executável, `execArgv`, `argv`, ambiente e diretório, saída no
 *   `serve.log`) que espera este pid sumir antes de pegar o `serve.lock` (`BRAIN_SERVE_ESPERAR_PID`), e só depois de a cópia
 *   ter subido fecha e sai 0. Se a cópia não sobe, rejeita sem fechar: o serve atual continua.
 */
export async function reiniciarProcesso(o: ReiniciarOptions): Promise<void> {
  const env = o.env ?? process.env;
  const sair = o.sair ?? ((codigo: number) => process.exit(codigo));
  if (env.INVOCATION_ID) {
    try { await o.fechar(); } finally { sair(CODIGO_REINICIO_SYSTEMD); }
    return;
  }
  const spawnFn = o.spawnFn ?? spawn;
  const fd = openSync(o.logPath, "a", 0o600);
  try {
    const filho = spawnFn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...env, BRAIN_SERVE_ESPERAR_PID: String(process.pid) },
      cwd: process.cwd(),
    });
    await new Promise<void>((ok, erro) => { filho.once("spawn", () => ok()); filho.once("error", erro); });
    filho.unref();
  } finally { closeSync(fd); } // a cópia tem o seu próprio descritor do log
  if (process.stdout.isTTY) console.log(`brain serve reiniciado em segundo plano; saída em ${o.logPath}`);
  try { await o.fechar(); } finally { sair(0); }
}

const pidExiste = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } // EPERM: existe
};

/**
 * Lado da cópia nova: espera o pid de `BRAIN_SERVE_ESPERAR_PID` (o serve que pediu o reinício) sumir, até 30 s. Chamado no
 * `startServe` antes de `acquireServeLock`; não substitui nenhuma proteção: passado o limite, a aquisição normal recusa se o
 * serve antigo ainda estiver vivo. A variável é consumida (os processos filhos do serve não a herdam).
 */
export async function esperarServeAnterior(env: NodeJS.ProcessEnv = process.env, limiteMs = ESPERA_PID_MS): Promise<void> {
  const valor = env.BRAIN_SERVE_ESPERAR_PID;
  delete env.BRAIN_SERVE_ESPERAR_PID;
  const pid = Number(valor);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  const fim = Date.now() + limiteMs;
  while (pidExiste(pid) && Date.now() < fim) await new Promise((ok) => setTimeout(ok, INTERVALO_ESPERA_MS));
}
