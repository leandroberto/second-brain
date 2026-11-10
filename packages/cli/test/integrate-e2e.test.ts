import { execFileSync, execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
// integrate --apply/--remove é ação do revisor (exige terminal): aqui roda dentro de um pty de `script`, como num terminal real
const inTerminal = (args: string[], env: NodeJS.ProcessEnv) => run("script", ["-qec", [process.execPath, BIN, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" "), "/dev/null"], { env, timeout: 90_000 });
const has = (c: string) => { try { execFileSync("which", [c], { stdio: "ignore" }); return true; } catch { return false; } };

// Usa os CLIs REAIS (claude e codex) com HOME isolado: nada do usuário é tocado.
describe.skipIf(!has("claude") || !has("codex") || !has("script"))("integrate --apply/--remove com claude e codex reais (HOME isolado)", () => {
  it("aplica, preserva o que já existia e desfaz", async () => {
    const H = mkdtempSync(join(tmpdir(), "brain-int-e2e-"));
    mkdirSync(join(H, ".claude"), { recursive: true }); mkdirSync(join(H, ".codex"), { recursive: true });
    writeFileSync(join(H, ".claude.json"), JSON.stringify({ mcpServers: { outro: { command: "echo", args: ["hi"] } }, keep: "me" }));
    writeFileSync(join(H, ".claude", "CLAUDE.md"), "# Minhas regras\nSempre pt-br.\n");
    writeFileSync(join(H, ".codex", "config.toml"), 'model = "x"\n\n[mcp_servers.outro]\ncommand = "echo"\n');
    const env = { ...process.env, HOME: H, BRAIN_VAULT: join(H, "vault") };
    await run(process.execPath, [BIN, "init", join(H, "vault")], { env });
    // fora de um terminal (como um agente rodaria): negado e nada muda
    await expect(run(process.execPath, [BIN, "integrate", "--apply"], { env })).rejects.toMatchObject({ code: 1 });
    expect(Object.keys(JSON.parse(readFileSync(join(H, ".claude.json"), "utf8")).mcpServers)).toEqual(["outro"]);
    await inTerminal(["integrate", "--apply"], env);
    const after = JSON.parse(readFileSync(join(H, ".claude.json"), "utf8"));
    expect(Object.keys(after.mcpServers).sort()).toEqual(["outro", "second-brain"]); expect(after.keep).toBe("me");
    const toml = readFileSync(join(H, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.outro]"); expect(toml).toContain("[mcp_servers.second-brain]");
    expect(readFileSync(join(H, ".claude", "CLAUDE.md"), "utf8")).toContain("Sempre pt-br.");
    expect(existsSync(join(H, ".config", "second-brain", "backups"))).toBe(true);
    // idempotente
    await inTerminal(["integrate", "--apply"], env);
    expect((readFileSync(join(H, ".claude", "CLAUDE.md"), "utf8").match(/second-brain:start/g) ?? []).length).toBe(1);
    await inTerminal(["integrate", "--remove"], env);
    const gone = JSON.parse(readFileSync(join(H, ".claude.json"), "utf8"));
    expect(Object.keys(gone.mcpServers)).toEqual(["outro"]); expect(gone.keep).toBe("me");
    expect(readFileSync(join(H, ".codex", "config.toml"), "utf8")).not.toContain("second-brain");
    expect(readFileSync(join(H, ".claude", "CLAUDE.md"), "utf8")).toBe("# Minhas regras\nSempre pt-br.\n");
    rmSync(H, { recursive: true, force: true });
  });
});
