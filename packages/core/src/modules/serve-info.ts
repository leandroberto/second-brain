import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, opendirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, utimesSync, writeSync, type Stats } from "node:fs";
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

/** Resultado da sonda por caminho real (a sonda faz `stat`/`readdir`; o FS de um caminho não muda durante o processo). */
const cacheDaSonda = new Map<string, boolean>();
const temLetras = (nome: string): boolean => nome.toLowerCase() !== nome.toUpperCase();
const caixaTrocada = (nome: string): string => [...nome].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");

/** A pasta `dir` não diferencia caixa: a entrada `nome` (com letras) com a caixa trocada é o mesmo arquivo (mesmo `ino`/`dev`)? */
function pastaSemDiferencaDeCaixa(dir: string, nome: string): boolean {
  try {
    const a = statSync(join(dir, nome)); const b = statSync(join(dir, caixaTrocada(nome)));
    return a.ino === b.ino && a.dev === b.dev;
  } catch { return false; }
}

/** Primeira entrada com letras de `dir` que dá para sondar (`stat` ok; entre as primeiras 200), ou `undefined`. */
function entradaComLetras(dir: string): string | undefined {
  const sondavel = (nome: string): boolean => { try { statSync(join(dir, nome)); return true; } catch { return false; } };
  try {
    const d = opendirSync(dir);
    try { for (let i = 0, e = d.readSync(); e && i < 200; i++, e = d.readSync()) if (temLetras(e.name) && sondavel(e.name)) return e.name; }
    finally { d.closeSync(); }
  } catch { /* sem leitura: não dá para sondar por aqui */ }
  return undefined;
}

/**
 * Sonda o FS do vault (caminho real `p`): o FS não diferencia caixa? Testa a pasta que contém o vault pelo nome do vault ou,
 * se ele não tiver letras (`C:\2024`), por outra entrada com letras dessa pasta; sem nenhuma, sobe pelos componentes do
 * caminho até o primeiro com letras, sem sair do sistema de arquivos do vault. Nada a sondar: diferencia. Em cache por caminho.
 */
function semDiferencaDeCaixa(p: string): boolean {
  const memo = cacheDaSonda.get(p);
  if (memo !== undefined) return memo;
  const r = sondar(p);
  cacheDaSonda.set(p, r);
  return r;
}

function sondar(p: string): boolean {
  const pai = dirname(p);
  if (temLetras(basename(p))) return pastaSemDiferencaDeCaixa(pai, basename(p));
  const irmao = entradaComLetras(pai);
  if (irmao) return pastaSemDiferencaDeCaixa(pai, irmao);
  let dev: number; try { dev = statSync(pai).dev; } catch { return false; }
  for (let c = pai; dirname(c) !== c; c = dirname(c)) {
    let mesmoFs = false; try { mesmoFs = statSync(dirname(c)).dev === dev; } catch { /* sem acesso */ }
    if (!mesmoFs) return false; // a pasta acima é de outro FS: a caixa dela não diz nada sobre a do vault
    if (temLetras(basename(c))) return pastaSemDiferencaDeCaixa(dirname(c), basename(c));
  }
  return false;
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
/**
 * Lock gravado antes do último boot: o processo dono não sobreviveu ao reboot, mesmo que o pid exista de novo. Só vale para lock
 * também sem renovação há mais de `LOCK_VELHO_MS`: no WSL2, depois de o host dormir, o relógio de parede salta e o uptime não,
 * e um lock renovado antes do sono parece anterior ao boot.
 */
const velhoDeAntesDoBoot = (mtimeMs: number): boolean =>
  Date.now() - mtimeMs > LOCK_VELHO_MS && mtimeMs < Date.now() - uptime() * 1000 - MARGEM_BOOT_MS;

/** Erros de `link` de um sistema de arquivos sem hard link (FAT/exFAT, compartilhamento de rede). */
const SEM_HARD_LINK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

/**
 * Cria o lock já com o conteúdo: tmp + `link` (atômico, falha com EEXIST se já houver lock). `false` = já existe. Num FS sem
 * hard link (FAT/exFAT, compartilhamento de rede) cai para a criação exclusiva com `wx` e o conteúdo escrito logo em seguida:
 * nesse intervalo o lock existe vazio, e o leitor trata lock vazio/ilegível recente como de um serve subindo (não como livre).
 */
function criarLock(alvo: string, conteudo: string): boolean {
  const tmp = `${alvo}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    gravarEmDisco(tmp, conteudo, "w");
    linkSync(tmp, alvo);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code && SEM_HARD_LINK.has(code)) return criarLockSemHardLink(alvo, conteudo);
    throw e;
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

function criarLockSemHardLink(alvo: string, conteudo: string): boolean {
  try { gravarEmDisco(alvo, conteudo, "wx"); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
}

/**
 * Abre (`w` ou `wx`), escreve e faz `fsync` antes de fechar: uma queda de energia/VM logo depois de o lock aparecer não o deixa
 * vazio (lock vazio recusa por 10 min).
 */
function gravarEmDisco(arq: string, conteudo: string, flag: "w" | "wx"): void {
  const fd = openSync(arq, flag, 0o600);
  try { writeSync(fd, conteudo); fsyncSync(fd); } finally { closeSync(fd); }
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
 * Lock exclusivo `<stateDir>/serve.lock` (`{ pid, nonce, desde }`, criado já com o conteúdo por tmp + `link`, ou por `wx` num
 * FS sem hard link, ver `criarLock`), adquirido no começo do `startServe`, antes de carregar qualquer coisa, e com o mtime
 * renovado a cada 60 s enquanto o serve vive.
 * Quando o lock existe:
 * - vazio ou ilegível: recusa, a menos que tenha mais de 10 min sem mudar (velho);
 * - pid deste processo: só é válido se o nonce for de uma aquisição deste processo (outro `startServe` aqui); senão é velho;
 * - pid inexistente: velho;
 * - mtime anterior ao último boot e sem renovação há mais de 10 min, sem serve confirmado vivo: velho (o pid pode ter
 *   renascido em outro processo);
 * - pid vivo e `serve.json` desse pid: `serveEstado` decide (`morto` = pid reusado depois de uma queda, velho; `vivo` ou
 *   `indeterminado` = recusa);
 * - pid vivo sem `serve.json` dele (o dono ainda está subindo): recusa, a menos que o lock tenha mais de 10 min (velho).
 * Lock velho é retomado com `rename` para um nome único e só então o novo é criado. As retomadas são serializadas pelo mutex
 * `serve.lock.retomando` (ver `retomar`): entre concorrentes só um retoma; os outros recomeçam e reavaliam o lock novo.
 * `liberar()` para a renovação e só apaga o lock se ele ainda for desta aquisição.
 */
export async function acquireServeLock(root: string, vault: { root: string; tokenPath: string }): Promise<{ liberar(): void }> {
  const alvo = arquivoLock(root);
  const nonce = randomBytes(8).toString("hex");
  let mutexOcupado = false;
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
    // stat ANTES da leitura: se o arquivo mudar depois (lock novo, ou o conteúdo do `wx` chegando), a identidade avaliada já
    // não bate na retomada, que então recomeça
    let avaliado: Stats; try { avaliado = statSync(alvo); } catch { continue; } // sumiu: recomeça
    const dono = lerLock(alvo);
    const { mtimeMs } = avaliado;
    const recusar = (motivo: string) => new BrainError("locked", `${motivo} (lock: ${alvo})`);
    // cada ramo que não recusa conclui que o lock é velho (dono morto, pid reusado, ou lock ilegível)
    if (!dono.pid) {
      // vazio ou ilegível: pode ser um serve criando o lock por `wx` (FS sem hard link) que ainda não escreveu o conteúdo
      if (Date.now() - mtimeMs <= LOCK_VELHO_MS) throw recusar("lock vazio ou ilegível recente: outro brain serve pode estar subindo para este vault; se nenhum está, apague o lock");
    } else if (dono.pid === process.pid) {
      if (dono.nonce && noncesDoProcesso.has(dono.nonce)) throw recusar("já há um brain serve subindo ou rodando neste processo para este vault");
    } else if (pidExiste(dono.pid)) {
      // lock anterior ao último boot (e sem renovação há mais de 10 min): o dono não existe mais, mesmo que o pid tenha
      // renascido. Só vale quando a vivacidade NÃO foi confirmada: um salto de relógio (NTP, WSL retomando) move a hora do boot,
      // e um serve que responde vivo nunca é velho. Sem serve.json do pid, só a idade decide
      if (ler(root)?.pid === dono.pid) {
        const e = await serveEstado(root, vault);
        if (e.estado === "vivo") throw recusar(`já há um brain serve rodando para este vault em ${e.url}`);
        if (e.estado === "indeterminado" && !velhoDeAntesDoBoot(mtimeMs)) throw recusar(`há um brain serve para este vault em ${e.url} (pid ${e.pid}) que não respondeu (${e.motivo}); encerre-o (kill ${e.pid}) antes de subir outro`);
      } else if (Date.now() - mtimeMs <= LOCK_VELHO_MS) {
        throw recusar(`já há um brain serve subindo para este vault (pid ${dono.pid}); se esse processo não é um brain serve, apague o lock`);
      }
    }
    mutexOcupado = (await retomar(alvo, { nonce: dono.nonce, stat: avaliado })) === "mutex ocupado";
  }
  if (mutexOcupado) throw new BrainError("locked", `outra subida está retomando o lock (serve.lock.retomando); espere até 30 s e tente de novo, ou apague ${alvo}.retomando se nenhum brain serve estiver subindo`);
  throw new BrainError("locked", `não foi possível obter o lock do brain serve (${alvo})`);
}

/** Mutex de retomada com mais que isso: o dono caiu no meio da retomada (que dura milissegundos); pode ser removido. */
const MUTEX_VELHO_MS = 30_000;
/** Espera de quem encontra outra retomada em curso, antes de recomeçar a aquisição. */
const ESPERA_MUTEX_MS = 100;

/**
 * Cria o mutex de retomada (`mkdir` atômico). Mutex velho (dono caiu) sai por `rename` para um nome único (atômico: entre dois
 * que o acharam velho só um vence) e só então é apagado; a criação é tentada de novo, uma vez. Se o que foi renomeado já não é
 * o mutex avaliado (outro o removeu e criou o seu entre o `stat` e o `rename`), ele volta para o lugar e quem chegou depois
 * espera.
 */
function entrarNoMutex(mutex: string): boolean {
  for (let i = 0; i < 2; i++) {
    try { mkdirSync(mutex, { mode: 0o700 }); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    let visto: Stats; try { visto = statSync(mutex); } catch { continue; } // sumiu: tenta de novo
    if (Date.now() - visto.mtimeMs <= MUTEX_VELHO_MS) return false;
    const fora = `${mutex}.${randomBytes(6).toString("hex")}.velho`;
    try { renameSync(mutex, fora); } catch { return false; } // outro venceu a remoção: espera e recomeça
    let tirado: Stats | undefined; try { tirado = statSync(fora); } catch { /* sumiu */ }
    // o `ino` sozinho não basta (um mutex apagado e recriado pode reaproveitá-lo): o mtime do recriado é recente
    if (tirado && (tirado.ino !== visto.ino || tirado.dev !== visto.dev || tirado.mtimeMs !== visto.mtimeMs)) {
      try { renameSync(fora, mutex); } catch { /* já há outro mutex no lugar */ }
      try { rmSync(fora, { recursive: true, force: true }); } catch { /* best effort */ }
      return false;
    }
    try { rmSync(fora, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return false;
}

/** Mesmo arquivo e mesmo conteúdo do lock avaliado: `ino`/`dev`, tamanho, mtime e nonce (lock vazio do `wx` não tem nonce). */
const mesmoLock = (arq: string, avaliado: { nonce?: string; stat: Stats }): boolean => {
  let st: Stats; try { st = statSync(arq); } catch { return false; }
  const a = avaliado.stat;
  return st.ino === a.ino && st.dev === a.dev && st.size === a.size && st.mtimeMs === a.mtimeMs && lerLock(arq).nonce === avaliado.nonce;
};

/**
 * Tira o lock velho do caminho por `rename`, dentro do mutex `serve.lock.retomando` (só uma retomada por vez; quem não
 * consegue entrar espera um pouco e recomeça a aquisição). Dentro do mutex, o lock só é tirado se ainda for o avaliado
 * (`mesmoLock`): quem avaliou o mesmo lock velho que outro já retomou não toca no lock novo (sem isso, um terceiro processo
 * podia criar o seu lock enquanto o novo estava fora do lugar, e o novo se perdia com o dono acreditando tê-lo; num FS sem
 * hard link, o lock velho vazio e o novo ainda vazio do `wx` têm o mesmo nonce, nenhum). O mutex sai sempre no `finally`.
 */
async function retomar(alvo: string, avaliado: { nonce?: string; stat: Stats }): Promise<"mutex ocupado" | "recomeçar"> {
  const mutex = `${alvo}.retomando`;
  if (!entrarNoMutex(mutex)) { await new Promise((ok) => setTimeout(ok, ESPERA_MUTEX_MS)); return "mutex ocupado"; }
  try {
    if (!mesmoLock(alvo, avaliado)) return "recomeçar"; // outro já retomou: recomeça e avalia o lock novo
    const fora = `${alvo}.${randomBytes(6).toString("hex")}.velho`;
    try { renameSync(alvo, fora); } catch { return "recomeçar"; } // ENOENT: o lock saiu
    if (!mesmoLock(fora, avaliado)) {
      // trocado entre a conferência e o rename (o dono o apagou e outro o criou): devolve sem sobrescrever
      try { linkSync(fora, alvo); } catch { /* já há outro lock (ele decide) ou FS sem hard link */ }
    }
    try { rmSync(fora, { force: true }); } catch { /* best effort */ }
    return "recomeçar";
  } finally {
    try { rmdirSync(mutex); } catch { /* best effort */ }
  }
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
