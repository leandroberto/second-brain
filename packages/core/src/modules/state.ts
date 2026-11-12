import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrainError } from "@brain/shared";
import type { ModuleState } from "@brain/module-sdk";
import type { Brain } from "../brain.js";
import { writeFileAtomic } from "../fs-atomic.js";
import { withFileLock } from "../lock.js";
import { claimStateOwner, stateSlug } from "../state.js";
import { vaultFingerprint } from "./serve-info.js";

/**
 * Raiz do estado dos módulos (e, ao lado dela, do `serve.json` e do `serve.lock`): SEMPRE fora do vault e NUNCA dividida entre
 * vaults diferentes. Com `state.external`, `<stateDir>/modules` (o `stateDir` já tem dono). Sem ele, uma subpasta própria
 * `<slug do vault_name>-<impressão do vault>` (o nome sozinho colide: o padrão é o mesmo em todo vault) dentro de
 * `BRAIN_STATE_DIR` ou, sem ele, de `~/.local/state/second-brain`, com a mesma garantia de dono do estado da máquina
 * (`vault-path`) nessa subpasta. `BRAIN_STATE_DIR` aqui é só a raiz: nunca é usado cru nem reivindicado, porque o core o ignora
 * quando `state.external` é falso e ele pode ser o estado de outro vault (externo) herdado do shell. Nasce com modo 0700.
 */
export function modulesStateRoot(brain: Brain, env: NodeJS.ProcessEnv = process.env): string {
  const base = brain.vault.stateDir ?? baseSemEstadoExterno(brain, env);
  const root = join(base, "modules");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch { /* best effort */ }
  return root;
}

function baseSemEstadoExterno(brain: Brain, env: NodeJS.ProcessEnv): string {
  const raiz = env.BRAIN_STATE_DIR || join(env.HOME || homedir(), ".local", "state", "second-brain");
  const base = join(raiz, `${stateSlug(brain.config.vault_name)}-${vaultFingerprint(brain.vault.root)}`);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  claimStateOwner(base, brain.vault.root);
  return base;
}

const NOME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function nomeSeguro(nome: string): string {
  if (!NOME_OK.test(nome) || nome.includes("..")) throw new BrainError("invalid", `nome de arquivo de estado inválido: "${nome}"`);
  return nome;
}

/** Estado de um módulo: pasta própria `<root>/<id>`, escrita atômica (tmp + rename) e lock por mkdir atômico. */
export function createModuleState(root: string, id: string): ModuleState {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    dir,
    lerJson<T>(nome: string): T | undefined {
      try { return JSON.parse(readFileSync(join(dir, `${nomeSeguro(nome)}.json`), "utf8")) as T; }
      catch (e) { if (e instanceof BrainError) throw e; return undefined; }
    },
    gravarJson(nome: string, v: unknown): void {
      writeFileAtomic(join(dir, `${nomeSeguro(nome)}.json`), JSON.stringify(v));
    },
    lock<T>(nome: string, fn: () => Promise<T>): Promise<T> {
      return withFileLock(join(dir, `${nomeSeguro(nome)}.lock.d`), fn);
    },
  };
}
