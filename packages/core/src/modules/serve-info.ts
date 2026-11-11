import { chmodSync, linkSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { BrainError } from "@brain/shared";

/**
 * Endereço do `brain serve` vivo (spec de módulos §7.10): `<stateDir>/serve.json` (`{ url, pid, iniciado }`), ao lado da pasta
 * `modules/` (`root` aqui é sempre a raiz de `modulesStateRoot`). O MCP, a CLI e o doctor leem esse arquivo.
 */
const arquivo = (root: string) => join(dirname(root), "serve.json");

export interface ServeInfo { url: string; pid: number; iniciado: string }

/** Escrita atômica (tmp + rename), modo 0600. Só depois de a API estar escutando. */
export function writeServeInfo(root: string, info: ServeInfo): void {
  const alvo = arquivo(root);
  const tmp = `${alvo}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* fs sem chmod */ }
  renameSync(tmp, alvo);
}

const vivo = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } // existe, mas é de outro usuário
};

function ler(root: string): ServeInfo | undefined {
  try {
    const v = JSON.parse(readFileSync(arquivo(root), "utf8")) as Partial<ServeInfo>;
    if (typeof v?.url !== "string" || !Number.isInteger(v.pid) || (v.pid as number) <= 0) return undefined;
    return { url: v.url, pid: v.pid as number, iniciado: typeof v.iniciado === "string" ? v.iniciado : "" };
  } catch { return undefined; }
}

/**
 * `{ url, pid }` do `serve` se o arquivo existe e o pid ainda existe; senão `undefined`. É só um PRÉ-FILTRO barato: o pid pode
 * ter sido reusado (reboot) ou ser de outro usuário. Para decidir que há um serve deste vault, use `serveVivo`.
 */
export function readServeInfo(root: string): { url: string; pid: number } | undefined {
  const i = ler(root);
  return i && vivo(i.pid) ? { url: i.url, pid: i.pid } : undefined;
}

/** Apaga o `serve.json`, mas só se ele for deste processo (outro `serve` que subiu depois continua anunciado). */
export function clearServeInfo(root: string): void {
  const i = ler(root);
  if (i && i.pid !== process.pid) return;
  try { rmSync(arquivo(root), { force: true }); } catch { /* best effort */ }
}

/** Identificador não sensível do vault (sha256 curto do caminho real), devolvido por `GET /api/serve`. */
export function vaultFingerprint(vaultRoot: string): string {
  let p: string; try { p = realpathSync(vaultRoot); } catch { p = resolve(vaultRoot); }
  return createHash("sha256").update(p).digest("hex").slice(0, 16);
}

/**
 * Estado do `serve` anunciado no `serve.json`, para este vault:
 * - `vivo`: `GET <url>/api/serve` com o api-token respondeu 200 com o MESMO pid do arquivo e a impressão do MESMO vault;
 * - `morto`: sem `serve.json`, pid inexistente (ESRCH), conexão recusada, 4xx que não é de credencial (404: outro servidor na
 *   porta) ou resposta de outro pid/vault;
 * - `indeterminado`: o pid existe mas não deu para confirmar (timeout, outro erro de rede, 5xx, 401/403, sem api-token). Um
 *   serve com o event loop travado (laço síncrono de módulo, indexação pesada) cai aqui. O `serve.json` mora no estado deste
 *   vault (com dono, ver `modulesStateRoot`), então 401/403 não vem de outro vault: é o próprio serve com um api-token
 *   trocado em disco depois que ele subiu, e não pode ser tratado como morto.
 * Quem DESTRÓI estado (recusar um segundo serve, recuperar o marcador) trata `indeterminado` como vivo; quem ENVIA credencial
 * trata como não confirmado.
 */
export type EstadoServe =
  | { estado: "vivo"; url: string; pid: number }
  | { estado: "indeterminado"; url: string; pid: number; motivo: string }
  | { estado: "morto" };

const codigoDeRede = (e: unknown): string | undefined => {
  const c = (e as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof c === "string" ? c : undefined;
};

export async function serveEstado(root: string, vault: { root: string; tokenPath: string }, o: { timeoutMs?: number } = {}): Promise<EstadoServe> {
  const i = readServeInfo(root);
  if (!i) return { estado: "morto" };
  const indeterminado = (motivo: string): EstadoServe => ({ estado: "indeterminado", url: i.url, pid: i.pid, motivo });
  let token = "";
  try { token = readFileSync(vault.tokenPath, "utf8").trim(); } catch { /* sem token */ }
  if (!token) return indeterminado("sem api-token para confirmar");
  const ms = o.timeoutMs ?? 1500;
  let r: Response;
  try {
    r = await fetch(`${i.url}/api/serve`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (codigoDeRede(e) === "ECONNREFUSED") return { estado: "morto" };
    return indeterminado((e as Error)?.name === "TimeoutError" ? `não respondeu em ${ms} ms` : `erro de rede (${codigoDeRede(e) ?? (e as Error)?.message ?? "desconhecido"})`);
  }
  // 5xx: pode ser o brain com problema. 401/403: o serve deste vault com outro api-token. Demais 4xx (404 = outro servidor na
  // porta): não é este serve
  if (r.status >= 500) return indeterminado(`respondeu HTTP ${r.status}`);
  if (r.status === 401 || r.status === 403) return indeterminado(`recusou o api-token em disco (HTTP ${r.status})`);
  if (!r.ok) return { estado: "morto" };
  let j: { vault?: unknown; pid?: unknown };
  try { j = await r.json() as typeof j; } catch { return indeterminado("resposta ilegível"); }
  return j.pid === i.pid && j.vault === vaultFingerprint(vault.root) ? { estado: "vivo", url: i.url, pid: i.pid } : { estado: "morto" };
}

/** `{ url, pid }` só quando o serve está CONFIRMADO vivo (`serveEstado` = `vivo`). */
export async function serveVivo(root: string, vault: { root: string; tokenPath: string }, o: { timeoutMs?: number } = {}): Promise<{ url: string; pid: number } | undefined> {
  const e = await serveEstado(root, vault, o);
  return e.estado === "vivo" ? { url: e.url, pid: e.pid } : undefined;
}

/** Fallback de §7.10 quando não há `serve.json`: `http://127.0.0.1:<BRAIN_PORT ou 3737>`. Nunca para enviar sessão humana. */
export function serveFallbackUrl(env: NodeJS.ProcessEnv = process.env): string {
  const porta = Number(env.BRAIN_PORT);
  return `http://127.0.0.1:${Number.isInteger(porta) && porta > 0 ? porta : 3737}`;
}

// ---- lock exclusivo do serve: a recusa de um segundo serve é atômica ----

const arquivoLock = (root: string) => join(dirname(root), "serve.lock");
/** Lock de pid vivo mas sem serve anunciado por esse pid há mais que isso: pid reusado (reboot), retomado. */
const LOCK_VELHO_MS = 10 * 60_000;

const pidExiste = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/** Nonces dos locks adquiridos por ESTE processo: lock com o nosso pid e nonce desconhecido é de um processo anterior (pid reusado). */
const noncesDoProcesso = new Set<string>();

const lerLock = (arq: string): { pid: number; nonce?: string } => {
  try {
    const v = JSON.parse(readFileSync(arq, "utf8")) as { pid?: unknown; nonce?: unknown };
    return { pid: Number.isInteger(v.pid) ? (v.pid as number) : 0, nonce: typeof v.nonce === "string" ? v.nonce : undefined };
  } catch { return { pid: 0 }; }
};

/**
 * Lock exclusivo `<stateDir>/serve.lock` (`{ pid, nonce, desde }`, criado com `wx`), adquirido no começo do `startServe`, antes
 * de carregar qualquer coisa. Quando o lock existe:
 * - pid deste processo: só é válido se o nonce for de uma aquisição deste processo (outro `startServe` aqui); senão é velho;
 * - pid inexistente: velho;
 * - pid vivo e `serve.json` desse pid: `serveEstado` decide (`morto` = pid reusado depois de uma queda, velho; `vivo` ou
 *   `indeterminado` = recusa);
 * - pid vivo sem `serve.json` dele (o dono ainda está subindo): recusa, a menos que o lock tenha mais de 10 min (velho).
 * Lock velho é retomado com `rename` para um nome único (atômico: entre dois concorrentes só um vence; o outro recomeça) e
 * só então o novo é criado com `wx`. `liberar()` só apaga o lock se ele ainda for desta aquisição.
 */
export async function acquireServeLock(root: string, vault: { root: string; tokenPath: string }): Promise<{ liberar(): void }> {
  const alvo = arquivoLock(root);
  const nonce = randomBytes(8).toString("hex");
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    try {
      writeFileSync(alvo, JSON.stringify({ pid: process.pid, nonce, desde: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      noncesDoProcesso.add(nonce);
      return {
        liberar() {
          noncesDoProcesso.delete(nonce);
          try { if (lerLock(alvo).nonce === nonce) rmSync(alvo, { force: true }); } catch { /* já não existe */ }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const dono = lerLock(alvo);
    const recusar = (motivo: string) => new BrainError("locked", `${motivo} (lock: ${alvo})`);
    // cada ramo que não recusa conclui que o lock é velho (dono morto, pid reusado, ou lock ilegível)
    if (dono.pid === process.pid) {
      if (dono.nonce && noncesDoProcesso.has(dono.nonce)) throw recusar("já há um brain serve subindo ou rodando neste processo para este vault");
    } else if (dono.pid && pidExiste(dono.pid)) {
      if (ler(root)?.pid === dono.pid) {
        const e = await serveEstado(root, vault);
        if (e.estado === "vivo") throw recusar(`já há um brain serve rodando para este vault em ${e.url}`);
        if (e.estado === "indeterminado") throw recusar(`há um brain serve para este vault em ${e.url} (pid ${e.pid}) que não respondeu (${e.motivo}); encerre-o (kill ${e.pid}) antes de subir outro`);
      } else {
        let idade: number; try { idade = Date.now() - statSync(alvo).mtimeMs; } catch { continue; } // sumiu: recomeça
        if (idade <= LOCK_VELHO_MS) throw recusar(`já há um brain serve subindo para este vault (pid ${dono.pid}); se esse processo não é um brain serve, apague o lock`);
      }
    }
    retomar(alvo, dono.nonce);
  }
  throw new BrainError("locked", `não foi possível obter o lock do brain serve (${alvo})`);
}

/** Tira o lock velho do caminho por `rename` (atômico). Se o arquivo já não é o avaliado (outro processo o retomou), devolve-o. */
function retomar(alvo: string, nonceAvaliado: string | undefined): void {
  const fora = `${alvo}.${randomBytes(6).toString("hex")}.velho`;
  try { renameSync(alvo, fora); } catch { return; } // ENOENT: outro venceu; recomeça a aquisição
  if (lerLock(fora).nonce !== nonceAvaliado) {
    // pegamos um lock NOVO de quem retomou antes: devolve sem sobrescrever (link falha se já houver outro lock no lugar)
    try { linkSync(fora, alvo); } catch { /* já há outro lock: ele decide */ }
  }
  try { rmSync(fora, { force: true }); } catch { /* best effort */ }
}

/** JSON com chaves ordenadas (a ordem das chaves no YAML não muda o hash). */
function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonico((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** sha256 do bloco `modules` da config (já normalizado pelo schema): muda quando um módulo é ligado, desligado ou reconfigurado. */
export function modulesConfigHash(modules: unknown): string {
  return createHash("sha256").update(canonico(modules ?? {})).digest("hex");
}
