import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

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
 * O `serve` anunciado no `serve.json` está vivo E é deste vault? Pré-filtro pelo pid; confirmação por HTTP
 * (`GET <url>/api/serve` com o api-token, timeout curto): responde com o mesmo pid do arquivo e a impressão do mesmo vault.
 * Pid reusado, porta sem ninguém, token recusado ou outro vault: `undefined` (tratado como morto).
 */
export async function serveVivo(root: string, vault: { root: string; tokenPath: string }, o: { timeoutMs?: number } = {}): Promise<{ url: string; pid: number } | undefined> {
  const i = readServeInfo(root);
  if (!i) return undefined;
  let token: string;
  try { token = readFileSync(vault.tokenPath, "utf8").trim(); } catch { return undefined; }
  if (!token) return undefined;
  try {
    const r = await fetch(`${i.url}/api/serve`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(o.timeoutMs ?? 1500) });
    if (!r.ok) return undefined;
    const j = await r.json() as { vault?: unknown; pid?: unknown };
    return j.pid === i.pid && j.vault === vaultFingerprint(vault.root) ? i : undefined;
  } catch { return undefined; }
}

/**
 * Onde chamar o `serve` para LEITURA ou ferramenta com o api-token (§7.10): o do `serve.json` confirmado por `serveVivo` ou, na
 * falta dele, `http://127.0.0.1:<BRAIN_PORT ou 3737>`. Nunca use o fallback para enviar uma sessão humana.
 */
export async function serveUrl(root: string, vault: { root: string; tokenPath: string }, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const vivo = await serveVivo(root, vault);
  if (vivo) return vivo.url;
  const porta = Number(env.BRAIN_PORT);
  return `http://127.0.0.1:${Number.isInteger(porta) && porta > 0 ? porta : 3737}`;
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
