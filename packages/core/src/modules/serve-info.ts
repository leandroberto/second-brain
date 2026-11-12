import { linkSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { BrainError } from "@brain/shared";
import { writeFileAtomic } from "../fs-atomic.js";

/**
 * Endereço do `brain serve` vivo (spec de módulos §7.10): `<stateDir>/serve.json` (`{ url, pid, iniciado }`), ao lado da pasta
 * `modules/` (`root` aqui é sempre a raiz de `modulesStateRoot`). O MCP, a CLI e o doctor leem esse arquivo.
 */
const arquivo = (root: string) => join(dirname(root), "serve.json");

export interface ServeInfo { url: string; pid: number; iniciado: string }

/** Escrita atômica (tmp + rename), modo 0600. Só depois de a API estar escutando. */
export function writeServeInfo(root: string, info: ServeInfo): void {
  writeFileAtomic(arquivo(root), JSON.stringify(info));
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
 * ter sido reusado (reboot) ou ser de outro usuário. Para decidir que há um serve deste vault, use `serveEstado`.
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

/** Sonda "o FS deste caminho real não diferencia maiúsculas?" (injetável nos testes). */
export type SondaCaixa = (caminhoReal: string) => boolean;

const caminhoReal = (vaultRoot: string): string => { try { return realpathSync.native(vaultRoot); } catch { return resolve(vaultRoot); } };

/**
 * Regra de caixa do FS do vault: num FS que não diferencia maiúsculas (/mnt/c, macOS) o mesmo vault pode ser aberto com caixas
 * diferentes, e caminhos desse FS são comparados em minúsculas; nos demais, como estão. A impressão do vault e o `vault-path`
 * da pasta de estado dos módulos usam esta mesma regra.
 */
export function normalizadorDeCaixa(vaultRoot: string, sonda: SondaCaixa = semDiferencaDeCaixa): (caminho: string) => string {
  return sonda(caminhoReal(vaultRoot)) ? (p) => p.toLowerCase() : (p) => p;
}

/**
 * Identificador não sensível do vault (sha256 curto do caminho real, normalizado por `normalizadorDeCaixa`), devolvido por
 * `GET /api/serve` e usado no nome da pasta de estado.
 */
export function vaultFingerprint(vaultRoot: string, sonda?: SondaCaixa): string {
  return createHash("sha256").update(normalizadorDeCaixa(vaultRoot, sonda)(caminhoReal(vaultRoot))).digest("hex").slice(0, 16);
}

/** Sonda o FS do vault: o nome da pasta com a caixa trocada resolve para o mesmo arquivo (mesmo `ino`/`dev`)? */
function semDiferencaDeCaixa(p: string): boolean {
  const nome = basename(p);
  const trocado = [...nome].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
  if (trocado === nome) return false; // sem letras: não dá para sondar
  try {
    const a = statSync(p); const b = statSync(join(dirname(p), trocado));
    return a.ino === b.ino && a.dev === b.dev;
  } catch { return false; }
}

/**
 * Estado do `serve` anunciado no `serve.json`, para este vault:
 * - `vivo`: `GET <url>/api/serve` com o api-token respondeu 200 com o MESMO pid do arquivo e a impressão do MESMO vault;
 * - `morto`: sem `serve.json`, pid inexistente (ESRCH), conexão recusada, 4xx que não é de credencial (404: outro servidor na
 *   porta), 200 que não é JSON ou resposta de outro pid/vault;
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
  // 200 sem JSON, ou JSON sem o pid e o vault deste serve: outro programa na porta
  let j: { vault?: unknown; pid?: unknown } | null;
  try { j = await r.json() as typeof j; } catch { return { estado: "morto" }; }
  return j?.pid === i.pid && j?.vault === vaultFingerprint(vault.root) ? { estado: "vivo", url: i.url, pid: i.pid } : { estado: "morto" };
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
/** O serve vivo renova o mtime do lock nesse intervalo (um lock que deixou de ser renovado envelhece). */
const RENOVAR_LOCK_MS = 60_000;
/** Folga na comparação com a hora do boot (o uptime e o relógio não batem ao milissegundo). */
const MARGEM_BOOT_MS = 60_000;
/** Lock gravado antes do último boot: o processo dono não sobreviveu ao reboot, mesmo que o pid exista de novo. */
const antesDoBoot = (mtimeMs: number): boolean => mtimeMs < Date.now() - uptime() * 1000 - MARGEM_BOOT_MS;

/** Erros de `link` de um sistema de arquivos sem hard link (FAT/exFAT, compartilhamento de rede). */
const SEM_HARD_LINK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

/**
 * Cria o lock já com o conteúdo: tmp + `link` (atômico, falha com EEXIST se já houver lock). `false` = já existe. FS sem hard
 * link vira `state_unavailable` com a orientação (o estado precisa ficar em disco local).
 */
function criarLock(alvo: string, conteudo: string): boolean {
  const tmp = `${alvo}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, conteudo, { mode: 0o600 });
    linkSync(tmp, alvo);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code && SEM_HARD_LINK.has(code)) throw new BrainError("state_unavailable", "o estado do second-brain precisa ficar em disco local (ext4/NTFS); este sistema de arquivos não suporta hard links");
    throw e;
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

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
 * Lock exclusivo `<stateDir>/serve.lock` (`{ pid, nonce, desde }`, criado já com o conteúdo por tmp + `link`), adquirido no
 * começo do `startServe`, antes de carregar qualquer coisa, e com o mtime renovado a cada 60 s enquanto o serve vive.
 * Quando o lock existe:
 * - pid deste processo: só é válido se o nonce for de uma aquisição deste processo (outro `startServe` aqui); senão é velho;
 * - pid inexistente: velho;
 * - mtime anterior ao último boot, sem serve confirmado vivo: velho (o pid pode ter renascido em outro processo);
 * - pid vivo e `serve.json` desse pid: `serveEstado` decide (`morto` = pid reusado depois de uma queda, velho; `vivo` ou
 *   `indeterminado` = recusa);
 * - pid vivo sem `serve.json` dele (o dono ainda está subindo): recusa, a menos que o lock tenha mais de 10 min (velho).
 * Lock velho é retomado com `rename` para um nome único (atômico: entre dois concorrentes só um vence; o outro recomeça) e
 * só então o novo é criado. `liberar()` para a renovação e só apaga o lock se ele ainda for desta aquisição.
 */
export async function acquireServeLock(root: string, vault: { root: string; tokenPath: string }): Promise<{ liberar(): void }> {
  const alvo = arquivoLock(root);
  const nonce = randomBytes(8).toString("hex");
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    if (criarLock(alvo, JSON.stringify({ pid: process.pid, nonce, desde: new Date().toISOString() }))) {
      noncesDoProcesso.add(nonce);
      const renovacao = setInterval(() => {
        try { if (lerLock(alvo).nonce === nonce) { const t = new Date(); utimesSync(alvo, t, t); } } catch { /* lock removido por terceiro */ }
      }, RENOVAR_LOCK_MS);
      renovacao.unref();
      return {
        liberar() {
          clearInterval(renovacao);
          noncesDoProcesso.delete(nonce);
          try { if (lerLock(alvo).nonce === nonce) rmSync(alvo, { force: true }); } catch { /* já não existe */ }
        },
      };
    }
    const dono = lerLock(alvo);
    let mtimeMs: number; try { mtimeMs = statSync(alvo).mtimeMs; } catch { continue; } // sumiu: recomeça
    const recusar = (motivo: string) => new BrainError("locked", `${motivo} (lock: ${alvo})`);
    // cada ramo que não recusa conclui que o lock é velho (dono morto, pid reusado, ou lock ilegível)
    if (dono.pid === process.pid) {
      if (dono.nonce && noncesDoProcesso.has(dono.nonce)) throw recusar("já há um brain serve subindo ou rodando neste processo para este vault");
    } else if (dono.pid && pidExiste(dono.pid)) {
      // lock anterior ao último boot: o dono não existe mais, mesmo que o pid tenha renascido. Só vale quando a vivacidade NÃO
      // foi confirmada: um salto de relógio (NTP, WSL retomando) move a hora do boot, e um serve que responde vivo nunca é velho
      if (ler(root)?.pid === dono.pid) {
        const e = await serveEstado(root, vault);
        if (e.estado === "vivo") throw recusar(`já há um brain serve rodando para este vault em ${e.url}`);
        if (e.estado === "indeterminado" && !antesDoBoot(mtimeMs)) throw recusar(`há um brain serve para este vault em ${e.url} (pid ${e.pid}) que não respondeu (${e.motivo}); encerre-o (kill ${e.pid}) antes de subir outro`);
      } else if (!antesDoBoot(mtimeMs) && Date.now() - mtimeMs <= LOCK_VELHO_MS) {
        throw recusar(`já há um brain serve subindo para este vault (pid ${dono.pid}); se esse processo não é um brain serve, apague o lock`);
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
