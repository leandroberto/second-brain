import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BrainError } from "@brain/shared";
import type { Brain } from "./brain.js";

/**
 * Grava o histórico git num bundle dentro do vault (`.brain/backup/history.bundle`), para que o backup da pasta
 * sincronizada o inclua mesmo com o git-dir fora do vault. Pula se o HEAD não mudou desde o último bundle.
 */
export async function bundleHistory(brain: Brain): Promise<{ path: string; skipped: boolean }> {
  const dir = join(brain.vault.root, ".brain", "backup");
  const path = join(dir, "history.bundle");
  // head() é tolerante: sem esta checagem, erro real de git (ex.: git-dir errado) viraria "pulado"
  if (!(await brain.git.isRepo())) throw new BrainError("git_error", "backup do histórico: repositório git inacessível");
  const head = await brain.git.head();
  if (!head) return { path, skipped: true }; // repositório sem commits: nada a salvar
  if (existsSync(path) && brain.db.getMeta("last_bundle_head") === head) return { path, skipped: true };
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await brain.git.bundle(tmp);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  brain.db.setMeta("last_bundle_head", head);
  return { path, skipped: false };
}
