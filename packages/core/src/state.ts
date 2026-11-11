import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BrainError } from "@brain/shared";
import type { BrainConfig } from "./config.js";

/** Slug ASCII ([a-z0-9-]) do nome do vault, para o diretório de estado padrão. */
export function stateSlug(name: string): string {
  const s = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "vault";
}

/** Arquivo do diretório de estado que diz a qual vault (realpath) ele pertence. */
export const STATE_OWNER_FILE = "vault-path";

/**
 * Diretório de estado (SQLite, lock, fila pendente, api-token, git-dir) fora do vault.
 * `undefined` quando `state.external` é falso. Padrão: ~/.local/state/second-brain/<slug>/, sobrescrito por BRAIN_STATE_DIR.
 * Nasce com permissão 0700. Na primeira abertura grava `vault-path` com o realpath do vault; depois, um vault diferente
 * apontando para o mesmo estado é recusado (dois vaults dividindo índice, lock e histórico corromperiam os dois).
 */
export function resolveStateDir(vaultRoot: string, cfg: BrainConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!cfg.state.external) return undefined;
  const dir = env.BRAIN_STATE_DIR || join(env.HOME || homedir(), ".local", "state", "second-brain", stateSlug(cfg.vault_name));
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, constants.W_OK);
    const probe = join(dir, `.probe-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
  } catch (e) {
    throw new BrainError("state_unavailable", `diretório de estado indisponível ou sem permissão de escrita: ${dir} (${(e as Error).message})`);
  }
  claimStateOwner(dir, vaultRoot);
  return dir;
}

/**
 * Garantia de dono de um diretório de estado: na primeira vez grava `<dir>/vault-path` com o realpath do vault; depois, um
 * vault diferente apontando para o mesmo diretório é recusado (`state_unavailable`). Usada pelo estado da máquina e pelo
 * estado dos módulos (com o `serve.json` e o `serve.lock`).
 */
export function claimStateOwner(dir: string, vaultRoot: string): void {
  const vault = (() => { try { return realpathSync(vaultRoot); } catch { return resolve(vaultRoot); } })();
  const owner = join(dir, STATE_OWNER_FILE);
  if (existsSync(owner)) {
    const dono = readFileSync(owner, "utf8").trim();
    if (dono !== vault) {
      throw new BrainError("state_unavailable", `o diretório de estado ${dir} pertence a outro vault (${dono}), não a ${vault}. Use outro BRAIN_STATE_DIR para este vault, e o mesmo BRAIN_STATE_DIR em todos os pontos de entrada de um vault (serve, MCP, timer). Se a pasta do vault só mudou de lugar, corrija o caminho em ${owner}.`);
    }
  } else {
    writeFileSync(owner, `${vault}\n`, { mode: 0o600 });
  }
}
