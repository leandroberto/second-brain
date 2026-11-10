import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Proposal } from "@brain/shared";
import type { Vault } from "./vault.js";

export const newProposalId = (): string => `prop-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;

/** Fila em disco (JSON). Pendentes não vão para o Git; decididas vão (auditoria versionada). */
export class ProposalStore {
  constructor(private vault: Vault) {}
  private file(dir: string, id: string) { return join(dir, `${id}.json`); }

  savePending(p: Proposal): void {
    mkdirSync(this.vault.pendingDir, { recursive: true });
    const f = this.file(this.vault.pendingDir, p.id);
    writeFileSync(`${f}.tmp`, JSON.stringify(p, null, 2));
    renameSync(`${f}.tmp`, f);
  }
  get(id: string): Proposal | undefined {
    if (!/^prop-[0-9]{8}-[0-9a-f]{6}$/.test(id)) return undefined;
    for (const d of [this.vault.pendingDir, this.vault.decidedDir]) {
      const f = this.file(d, id);
      if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as Proposal;
    }
    return undefined;
  }
  list(which: "pending" | "decided" | "all" = "pending"): Proposal[] {
    const dirs = which === "pending" ? [this.vault.pendingDir] : which === "decided" ? [this.vault.decidedDir] : [this.vault.pendingDir, this.vault.decidedDir];
    const out: Proposal[] = [];
    for (const d of dirs) {
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) if (f.endsWith(".json")) {
        try { out.push(JSON.parse(readFileSync(join(d, f), "utf8")) as Proposal); } catch { /* arquivo corrompido é ignorado */ }
      }
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  /** Move para decided/ e devolve o caminho relativo ao vault (para entrar no commit). */
  saveDecided(p: Proposal): string {
    mkdirSync(this.vault.decidedDir, { recursive: true });
    const f = this.file(this.vault.decidedDir, p.id);
    writeFileSync(`${f}.tmp`, JSON.stringify(p, null, 2));
    renameSync(`${f}.tmp`, f);
    const pend = this.file(this.vault.pendingDir, p.id);
    rmSync(pend, { force: true });
    return `.brain/proposals/decided/${p.id}.json`;
  }
}
