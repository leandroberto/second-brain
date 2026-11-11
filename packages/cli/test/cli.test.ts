import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupRepos, gitRepo } from "../../core/test/git-fixture.js";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "brain-cli-home-"));
const vault = join(home, "vault");
afterAll(() => { rmSync(home, { recursive: true, force: true }); cleanupRepos(); });

const brain = async (args: string[], input?: string) => {
  const p = run(process.execPath, [BIN, ...args, "--vault", vault], { env: { ...process.env, HOME: home, BRAIN_VAULT: "" }, timeout: 60_000 });
  if (input !== undefined) p.child.stdin?.end(input);
  return p;
};

describe("CLI `brain` (processo real, HOME isolado)", () => {
  it("init cria vault, repositório Git e não toca fora do HOME de teste", async () => {
    const r = await run(process.execPath, [BIN, "init", vault], { env: { ...process.env, HOME: home } });
    expect(r.stdout).toContain("Vault pronto");
    expect(existsSync(join(vault, ".git"))).toBe(true);
    expect(existsSync(join(vault, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(home, ".config", "second-brain", "config.json"))).toBe(true);
  });

  it("import via stdin (texto) gera propostas; --dry-run não; review lista", async () => {
    const md = "# Projeto Z\n\nServiço fictício Z usado no teste de CLI.\n\n## Armadilhas conhecidas\nAtenção: o cron do host roda em UTC; cuidado ao agendar tarefas locais, ou elas disparam três horas depois.\n";
    const dry = await brain(["import", "-", "--project", "projeto-z", "--dry-run"], md);
    expect(dry.stdout).toContain("[DRY-RUN]"); expect(dry.stdout).toContain("Nada foi gravado");
    expect((await brain(["review"])).stdout.trim()).toBe("");
    const real = await brain(["import", "-", "--project", "projeto-z"], md);
    expect(real.stdout).toMatch(/proposta\(s\) na Review Queue/);
    expect((await brain(["review"])).stdout).toContain("Armadilhas conhecidas");
    expect(readdirSync(join(vault, "knowledge/projects")).length).toBe(0); // nada virou conhecimento
  });

  it("import de repositório git reconcilia a atualidade (processo real); reconcile é somente leitura sem --apply", async () => {
    const D = (x: string) => `${x}T12:00:00+00:00`;
    const { root } = gitRepo([
      { date: D("2026-01-05"), msg: "docs", files: { "docs/specs/2026-01-05-fila-design.md": "# Fila\n\n## Decisões\n\nA ingestão deve usar `IngestQueue` com Kafka para desacoplar o resolver, porque picos travam o worker.\n", "src/app.ts": "export const app = 1;\n" } },
    ], "repo-cli");
    const dry = await brain(["import", root, "--dry-run", "--show-evidence"]);
    expect(dry.stdout).toMatch(/atualidade \(verificada contra repo-cli@[0-9a-f]{7}\)/);
    expect(dry.stdout).toMatch(/planned\//);
    expect(dry.stdout).toMatch(/IngestQueue/);
    await brain(["import", root]);
    const snap = () => { const d = join(vault, ".brain/proposals/pending"); return readdirSync(d).sort().map((f) => readFileSync(join(d, f), "utf8")).join("\n"); };
    const before = snap();
    const ro = await brain(["reconcile", root]);
    expect(ro.stdout).toContain("[SOMENTE LEITURA]");
    expect(ro.stdout).toMatch(/planned\//);
    expect(snap()).toBe(before); // conteúdo idêntico: nada gravado sem --apply
    const ap = await brain(["reconcile", root, "--apply"]);
    expect(ap.stdout).toContain("Verificação gravada");
  });

  it("doctor --json: handshake MCP real ok; integrações só avisam (HOME isolado)", async () => {
    const r = await brain(["doctor", "--json"]).catch((e) => e as { stdout: string });
    const checks = JSON.parse(r.stdout) as Array<{ id: string; status: string }>;
    const by = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    expect(by.vault).toBe("ok"); expect(by.git).toBe("ok"); expect(by.sqlite).toBe("ok"); expect(by.fts).toBe("ok"); expect(by.index).toBe("ok"); expect(by.mcp).toBe("ok");
    expect(by["int-claude"]).toBe("warn"); expect(by["int-codex"]).toBe("warn");
  });

  it("integrate (dry-run) descreve e NÃO altera nada; update-policy é privilegiado (fora de terminal interativo é negado)", async () => {
    const r = await brain(["integrate"]);
    expect(r.stdout).toContain("Dry-run"); expect(r.stdout).toContain("claude mcp add");
    expect(existsSync(join(home, ".claude.json"))).toBe(false); expect(existsSync(join(home, ".codex"))).toBe(false);
    const before = readFileSync(join(vault, "AGENTS.md"), "utf8");
    await expect(brain(["update-policy"])).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/terminal interativo/) });
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).toBe(before);
  });

  it("pair-desktop é privilegiado: fora de terminal interativo é negado e nenhum token sai", async () => {
    await expect(brain(["pair-desktop"])).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringMatching(/terminal interativo/) });
  });

  it("update-policy --dry-run mostra o que mudaria sem exigir terminal e sem gravar nada", async () => {
    const agents = join(vault, "AGENTS.md");
    const before = readFileSync(agents, "utf8");
    writeFileSync(agents, "# política antiga\n"); // vault com política desatualizada
    const r = await brain(["update-policy", "--dry-run"]);
    expect(r.stdout).toContain("[SOMENTE LEITURA]");
    expect(r.stdout).toMatch(/vault {2}AGENTS\.md/);
    expect(r.stdout).toContain("Nada foi gravado");
    expect(readFileSync(agents, "utf8")).toBe("# política antiga\n");
    expect(existsSync(join(home, ".codex"))).toBe(false);
    writeFileSync(agents, before);
    expect((await brain(["update-policy", "--dry-run"])).stdout).toContain("já está atualizado");
  });

  it("reindex + search funcionam e comando desconhecido falha com código 2", async () => {
    expect((await brain(["reindex"])).stdout).toContain("reindexado");
    await expect(run(process.execPath, [BIN, "nao-existe"], { env: { ...process.env, HOME: home } })).rejects.toMatchObject({ code: 2 });
  });
});
