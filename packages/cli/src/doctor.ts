import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { statSync } from "node:fs";
import { Brain, coreDoctor, hasReviewerPassphrase, integrationChecks, type Check } from "@brain/core";

const c = (id: string, name: string, status: Check["status"], detail: string, fix?: string): Check => ({ id, name, status, detail, ...(fix ? { fix } : {}) });

async function apiCheck(vault: string, port: number, repoRoot: string): Promise<Check[]> {
  const tokenFile = join(vault, ".brain", "api-token");
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { authorization: `Bearer ${existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : ""}` }, signal: AbortSignal.timeout(2500) });
    if (r.status === 401) return [c("api", "API local", "warn", `porta ${port} responde mas recusou o token (outro vault/processo?)`, `brain serve --vault ${vault}`)];
    const j = (await r.json()) as { vault?: string; api?: { watcher?: boolean; build?: { commit?: string; id?: string } } };
    const out = [j.vault === vault ? c("api", "API local", "ok", `http://127.0.0.1:${port}`) : c("api", "API local", "warn", `a API na porta ${port} serve outro vault: ${j.vault}`, `pare-a e rode: brain serve --vault ${vault}`)];
    // a API carrega o código na inicialização: build em disco mais novo que o da API = mudanças ainda não ativas
    let disk: string | undefined; try { disk = String(Math.round(statSync(join(repoRoot, "packages/core/dist/brain.js")).mtimeMs)); } catch { /* sem build */ }
    const b = j.api?.build;
    out.push(!b?.id ? c("api-build", "Build da API", "warn", "a API em execução é anterior ao registro de build (build antigo)", "reinicie o brain serve") : b.id === disk ? c("api-build", "Build da API", "ok", `build atual${b.commit ? ` (${b.commit})` : ""}`) : c("api-build", "Build da API", "warn", `a API roda um build mais antigo que o do disco${b.commit ? ` (${b.commit})` : ""}`, "reinicie o brain serve"));
    out.push(j.api?.watcher ? c("watcher", "Watcher (Obsidian)", "ok", "ativo na API (fs.watch + varredura a cada 5 s)") : c("watcher", "Watcher (Obsidian)", "warn", "inativo", "brain serve"));
    return out;
  } catch {
    return [c("api", "API local", "warn", `não está rodando na porta ${port} (opcional: o MCP não depende dela)`, "./scripts/start.sh"), c("watcher", "Watcher (Obsidian)", "warn", "só roda junto da API; edições manuais são reindexadas na próxima consulta MCP/CLI", "./scripts/start.sh")];
  }
}

/** Handshake MCP real contra o MESMO comando que o Claude/Codex usariam. */
export async function mcpSmoke(vault: string, binPath: string): Promise<Check> {
  const client = new Client({ name: "brain-doctor", version: "0.1.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [binPath, "mcp"], env: { ...(process.env as Record<string, string>), BRAIN_VAULT: vault } }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const h = await client.callTool({ name: "brain_health", arguments: {} });
    await client.close();
    return tools.length >= 11 && !(h as { isError?: boolean }).isError ? c("mcp", "Servidor MCP", "ok", `${tools.length} ferramentas, brain_health ok`) : c("mcp", "Servidor MCP", "fail", `ferramentas: ${tools.length}`, "pnpm build");
  } catch (e) { await client.close().catch(() => undefined); return c("mcp", "Servidor MCP", "fail", (e as Error).message.slice(0, 160), "pnpm build && brain health"); }
}

export async function runDoctor(vault: string, repoRoot: string, port: number): Promise<Check[]> {
  const bin = join(repoRoot, "packages/cli/dist/bin.js");
  const checks: Check[] = [];
  if (!existsSync(join(vault, ".brain", "config.yaml"))) return [c("vault", "Vault", "fail", `não encontrado em ${vault}`, "brain init")];
  const b = await Brain.open(vault);
  try { checks.push(...(await coreDoctor(b))); } finally { b.close(); }
  checks.push(...(await apiCheck(vault, port, repoRoot)));
  // governança: quem pode decidir e quão forte é a prova de "humano"
  {
    const bb = await Brain.open(vault); const ag = bb.config.agents; bb.close();
    const agentWrites = ag.commit_policy !== "never" ? `agentes persistem (${ag.commit_policy}; tipos auto: ${Object.entries(ag.per_type).filter(([, v]) => v === "auto").map(([k]) => k).join(", ") || "nenhum"})` : "agentes só leem e propõem";
    checks.push(c("governance", "Governança", ag.commit_policy === "never" ? "ok" : "warn", `${agentWrites}; decisões só pela UI com sessão humana ou brain admin`, ag.commit_policy === "never" ? undefined : "revise agents.commit_policy no config"));
    checks.push(hasReviewerPassphrase() ? c("reviewer", "Identidade do revisor", "ok", "frase-senha definida: brain ui / brain admin a exigem")
      : c("reviewer", "Identidade do revisor", "warn", "sem frase-senha: a prova de humano é só o terminal interativo (agentes e scripts não têm TTY, mas um processo local que simule um terminal passaria)", "brain admin passphrase"));
  }
  checks.push(await mcpSmoke(vault, bin));
  checks.push(...integrationChecks(vault));
  return checks;
}

export function printChecks(checks: Check[]): void {
  const icon = { ok: "✔", warn: "▲", fail: "✘" } as const;
  for (const k of checks) {
    console.log(`${icon[k.status]} ${k.name.padEnd(26)} ${k.detail}`);
    if (k.status !== "ok" && k.fix) console.log(`  ↳ correção: ${k.fix}`);
  }
  const f = checks.filter((k) => k.status === "fail").length; const w = checks.filter((k) => k.status === "warn").length;
  console.log(`\n${f ? "COM FALHAS" : w ? "OK com avisos" : "TUDO OK"} — ${checks.length - f - w} ok, ${w} aviso(s), ${f} falha(s)`);
}
