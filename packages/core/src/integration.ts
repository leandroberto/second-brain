import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const START = "<!-- second-brain:start -->"; export const END = "<!-- second-brain:end -->";
const H = homedir();
export const paths = {
  claudeJson: join(H, ".claude.json"), claudeMd: join(H, ".claude", "CLAUDE.md"), codexToml: join(H, ".codex", "config.toml"),
  codexMd: join(H, ".codex", "AGENTS.md"), claudeSkill: join(H, ".claude", "skills", "second-brain"), agentsSkill: join(H, ".agents", "skills", "second-brain"),
  backups: join(H, ".config", "second-brain", "backups"),
};

export interface IntegrationStatus {
  claude: { mcp: boolean; command?: string; vault?: string; policy: boolean; skill: boolean };
  codex: { mcp: boolean; command?: string; vault?: string; policy: boolean; skill: boolean };
}

/** Lê o estado atual sem executar nenhum CLI (rápido e sem efeitos colaterais). */
export function integrationStatus(): IntegrationStatus {
  const out: IntegrationStatus = { claude: { mcp: false, policy: false, skill: false }, codex: { mcp: false, policy: false, skill: false } };
  try {
    const s = (JSON.parse(readFileSync(paths.claudeJson, "utf8")) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> }).mcpServers?.["second-brain"];
    if (s) out.claude = { ...out.claude, mcp: true, command: [s.command, ...(s.args ?? [])].join(" "), vault: s.env?.BRAIN_VAULT };
  } catch { /* sem arquivo */ }
  try {
    const t = readFileSync(paths.codexToml, "utf8");
    const m = /\[mcp_servers\.second-brain\]([\s\S]*?)(?=\n\[(?!mcp_servers\.second-brain\.)|$)/.exec(t);
    if (m) {
      const block = m[1] ?? "";
      out.codex = { ...out.codex, mcp: true, command: /command\s*=\s*"([^"]+)"/.exec(block)?.[1] + " " + (/args\s*=\s*\[([^\]]*)\]/.exec(block)?.[1] ?? "").replace(/["\s]/g, "").split(",").join(" "), vault: /BRAIN_VAULT\s*=\s*"([^"]+)"/.exec(t.slice(t.indexOf("[mcp_servers.second-brain")))?.[1] };
    }
  } catch { /* sem arquivo */ }
  const has = (f: string) => { try { return readFileSync(f, "utf8").includes(START); } catch { return false; } };
  out.claude.policy = has(paths.claudeMd); out.codex.policy = has(paths.codexMd);
  out.claude.skill = existsSync(paths.claudeSkill); out.codex.skill = existsSync(paths.agentsSkill);
  return out;
}


