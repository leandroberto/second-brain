import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** `{ url, pid }` do `serve` se o arquivo existe e o processo ainda está vivo; senão `undefined` (arquivo de um serve que caiu). */
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

/**
 * Onde procurar o `serve`: o `serve.json` vivo ou, na falta dele, `http://127.0.0.1:<BRAIN_PORT ou 3737>` (§7.10).
 * `doArquivo` diz se o endereço veio do arquivo (o fallback pode ser outro processo ou nada).
 */
export function serveAddress(root: string, env: NodeJS.ProcessEnv = process.env): { url: string; doArquivo: boolean } {
  const i = readServeInfo(root);
  if (i) return { url: i.url, doArquivo: true };
  const porta = Number(env.BRAIN_PORT);
  return { url: `http://127.0.0.1:${Number.isInteger(porta) && porta > 0 ? porta : 3737}`, doArquivo: false };
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
