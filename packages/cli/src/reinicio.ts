import { spawn } from "node:child_process";
import { closeSync, fchmodSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { BrainError } from "@brain/shared";

/** Código de saída sob systemd: ≠ 0, então a unit (`Restart=on-failure`) sobe o serve de novo (ver scripts/second-brain.service). */
export const CODIGO_REINICIO_SYSTEMD = 75;
/** Limite da espera do processo anterior; passado, a aquisição normal do `serve.lock` decide (recusa se ainda houver serve vivo). */
const ESPERA_PID_MS = 30_000;
const INTERVALO_ESPERA_MS = 100;
/** Teto do fechamento no reinício (o `scheduler.stop()` espera as tarefas em andamento sem limite próprio). */
const LIMITE_FECHAR_MS = 20_000;
/** `serve.log` maior que isso vira `serve.log.1` (substituindo o anterior) antes de a cópia nova escrever nele. */
const LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface ReiniciarOptions {
  /** fecha o serve pelo mesmo caminho do SIGTERM (`h.close()` + `b.close()`) */
  fechar: () => Promise<void>;
  /** saída da cópia destacada (`<diretório de estado>/serve.log`) */
  logPath: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  sair?: (codigo: number) => never;
  /** `true` = o serve começou a encerrar (sinal): não sobe a cópia */
  cancelado?: () => boolean;
  /** pai do serve capturado na subida (padrão: `PAI_NA_SUBIDA`); decide se o pai é o systemd */
  pai?: PaiDoServe;
  /** teto do `fechar` (padrão 20 s); estourou, sai assim mesmo e a cópia retoma o lock do dono morto */
  limiteFecharMs?: number;
  /** mensagens operacionais (padrão: stderr e `serve.log`) */
  avisar?: (mensagem: string) => void;
}

/** Pai do processo e o `comm` dele (`/proc/<ppid>/comm`; `undefined` fora do Linux ou sem leitura). */
export interface PaiDoServe { ppid: number; comm?: string }

export function paiDoServe(ppid: number = process.ppid, lerProc: (caminho: string) => string = (c) => readFileSync(c, "utf8")): PaiDoServe {
  try { return { ppid, comm: lerProc(`/proc/${ppid}/comm`).trim() }; } catch { return { ppid }; }
}

/**
 * Pai capturado na carga deste módulo, isto é, na subida do `brain serve` (o `bin.ts` o importa ao iniciar). Lido na hora do
 * reinício, o pai podia já ser outro: se o pai original morreu, o serve é adotado pelo pid 1 ou pelo `systemd --user`, e um
 * serve iniciado à mão com `INVOCATION_ID` herdado sairia com 75 sem ninguém para subi-lo.
 */
export const PAI_NA_SUBIDA: PaiDoServe = paiDoServe();

/**
 * Sob systemd = `INVOCATION_ID` E o pai na subida era o gerenciador (pid 1 ou `comm` = `systemd`). Só a variável não basta:
 * ela é herdada por descendentes de uma unit (tmux como serviço, `systemd-run --pty`), e um serve iniciado à mão ali sairia
 * com 75 sem ninguém para subi-lo de novo.
 */
function sobSystemd(env: NodeJS.ProcessEnv, pai: PaiDoServe): boolean {
  return !!env.INVOCATION_ID && (pai.ppid === 1 || pai.comm === "systemd");
}

/** `fechar` com teto: estourado, avisa e resolve (quem chama segue para `sair`). Erro do `fechar` continua propagando. */
async function fecharComTeto(fechar: () => Promise<void>, limiteMs: number, avisar: (m: string) => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const teto = new Promise<void>((ok) => {
    timer = setTimeout(() => { avisar(`fechamento passou de ${Math.round(limiteMs / 1000)} s; saindo assim mesmo`); ok(); }, limiteMs);
  });
  try { await Promise.race([fechar(), teto]); } finally { clearTimeout(timer); }
}

/** Abre o `serve.log` para append em 0600 (também se já existia com outro modo), girando-o para `.1` acima de 5 MB. */
function abrirLog(logPath: string): number {
  try { if (statSync(logPath).size > LOG_MAX_BYTES) renameSync(logPath, `${logPath}.1`); } catch { /* sem log ainda */ }
  const fd = openSync(logPath, "a", 0o600);
  try { fchmodSync(fd, 0o600); } catch (e) { closeSync(fd); throw e; }
  return fd;
}

/** Aviso padrão: stderr e uma linha datada no `serve.log` (aberto por `abrirLog`: 0600 e rotação). */
function avisoPadrao(logPath: string): (m: string) => void {
  return (m) => {
    console.error(m);
    try {
      const fd = abrirLog(logPath);
      try { writeSync(fd, `[${new Date().toISOString()}] ${m}\n`); } finally { closeSync(fd); }
    } catch { /* best effort */ }
  };
}

const encerrandoErro = () => new BrainError("state_unavailable", "o brain serve está encerrando");

/**
 * Reinicia o `brain serve` (spec de gerenciar módulos §7.1) sem depender de como ele foi iniciado:
 * - sob systemd (ver `sobSystemd`): fecha e sai com `CODIGO_REINICIO_SYSTEMD`; a unit sobe o serve de novo;
 * - senão: sobe uma cópia destacada de si mesmo (mesmo executável, `execArgv`, `argv`, ambiente e diretório, saída no
 *   `serve.log`) que espera este pid sumir antes de pegar o `serve.lock` (`BRAIN_SERVE_ESPERAR_PID`), e só depois de a cópia
 *   ter subido fecha e sai 0. Se a cópia não sobe, rejeita sem fechar: o serve atual continua.
 * O fechamento tem teto (`limiteFecharMs`). Com `cancelado()` (sinal recebido) antes do spawn, rejeita sem subir a cópia.
 */
export async function reiniciarProcesso(o: ReiniciarOptions): Promise<void> {
  const env = o.env ?? process.env;
  const sair = o.sair ?? ((codigo: number) => process.exit(codigo));
  const avisar = o.avisar ?? avisoPadrao(o.logPath);
  const fechar = () => fecharComTeto(o.fechar, o.limiteFecharMs ?? LIMITE_FECHAR_MS, avisar);
  if (o.cancelado?.()) throw encerrandoErro();
  if (sobSystemd(env, o.pai ?? PAI_NA_SUBIDA)) {
    try { await fechar(); } finally { sair(CODIGO_REINICIO_SYSTEMD); }
    return;
  }
  const spawnFn = o.spawnFn ?? spawn;
  const fd = abrirLog(o.logPath);
  try {
    if (o.cancelado?.()) throw encerrandoErro();
    const filho = spawnFn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...env, BRAIN_SERVE_ESPERAR_PID: String(process.pid) },
      cwd: process.cwd(),
    });
    await new Promise<void>((ok, erro) => { filho.once("spawn", () => ok()); filho.once("error", erro); });
    filho.unref();
  } finally { closeSync(fd); } // a cópia tem o seu próprio descritor do log
  // daqui em diante a cópia existe: um sinal no meio não a desfaz, só fecha este processo (o `fechar` é o mesmo)
  if (process.stdout.isTTY) console.log(`brain serve reiniciado em segundo plano; saída em ${o.logPath}`);
  try { await fechar(); } finally { sair(0); }
}

export interface ControleDeReinicio {
  /** o `reiniciarServe` repassado à API: recusa enquanto o serve sobe ou encerra; um reinício por vez */
  reiniciarServe(): Promise<void>;
  /** o `startServe` terminou (o handle existe e o `fechar` libera lock e `serve.json`) */
  pronto(): void;
  /** sinal recebido: recusa reinícios novos e cancela o que ainda não subiu a cópia */
  encerrando(): void;
}

/**
 * Estado do reinício no `bin.ts`. Antes de `pronto()` a API já escuta (dentro do `startServe`), mas o `fechar` ainda não teria
 * o handle para liberar o lock e o `serve.json`: recusa. Depois de `encerrando()`, recusa (e `cancelado` impede o spawn de um
 * reinício já pedido). Um segundo pedido recebe a mesma promise; falha libera nova tentativa.
 */
export function controleDeReinicio(o: Omit<ReiniciarOptions, "cancelado"> & { reiniciar?: typeof reiniciarProcesso }): ControleDeReinicio {
  const reiniciar = o.reiniciar ?? reiniciarProcesso;
  let subiu = false; let parando = false;
  let emCurso: Promise<void> | undefined;
  return {
    async reiniciarServe() {
      if (parando) throw encerrandoErro();
      if (!subiu) throw new BrainError("state_unavailable", "o brain serve ainda está subindo; tente de novo em instantes");
      return (emCurso ??= reiniciar({ ...o, cancelado: () => parando }).catch((e: unknown) => { emCurso = undefined; throw e; }));
    },
    pronto() { subiu = true; },
    encerrando() { parando = true; },
  };
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
