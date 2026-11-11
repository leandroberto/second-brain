import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Brain } from "@brain/core";
import { agentChannelFromEnv, agentNameFromEnv } from "../src/index.js";
import { terminalHuman } from "../../core/test/helpers.js";

const human = await terminalHuman("t");
const BIN = fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "brain-mcp-agent-"));
const clients: Client[] = [];
afterAll(async () => { await Promise.all(clients.map((c) => c.close().catch(() => undefined))); rmSync(dir, { recursive: true, force: true }); });

describe("nome do agente do MCP vindo de BRAIN_AGENT_NAME", () => {
  it("valida o nome; inválido vira claude-code com aviso; ausente não muda nada", () => {
    const avisos: string[] = [];
    const warn = (m: string) => { avisos.push(m); };
    expect(agentNameFromEnv({ BRAIN_AGENT_NAME: "assistant/20261110-153012-a1b2" }, warn)).toBe("assistant/20261110-153012-a1b2");
    expect(agentNameFromEnv({ BRAIN_AGENT_NAME: "assistant/ask" }, warn)).toBe("assistant/ask");
    expect(avisos).toEqual([]);
    expect(agentNameFromEnv({ BRAIN_AGENT_NAME: "Assistente Malicioso!" }, warn)).toBe("claude-code");
    expect(agentNameFromEnv({ BRAIN_AGENT_NAME: "a".repeat(81) }, warn)).toBe("claude-code");
    expect(avisos).toHaveLength(2);
    expect(avisos[0]).toContain("BRAIN_AGENT_NAME");
    expect(agentNameFromEnv({}, warn)).toBeUndefined();
    expect(agentNameFromEnv({ BRAIN_AGENT_NAME: "" }, warn)).toBeUndefined();
  });

  it("canal module aceito só com nome module/<id>", () => {
    const avisos: string[] = [];
    const warn = (m: string) => { avisos.push(m); };
    expect(agentChannelFromEnv({ BRAIN_AGENT_NAME: "module/xy", BRAIN_AGENT_CHANNEL: "module" }, "module/xy", warn)).toBe("module");
    expect(avisos).toEqual([]);
    expect(agentChannelFromEnv({ BRAIN_AGENT_NAME: "claude-code", BRAIN_AGENT_CHANNEL: "module" }, "claude-code", warn)).toBe("mcp");
    expect(agentChannelFromEnv({ BRAIN_AGENT_CHANNEL: "module" }, undefined, warn)).toBe("mcp");
    expect(agentChannelFromEnv({ BRAIN_AGENT_CHANNEL: "module" }, "module/X", warn)).toBe("mcp");
    for (const c of ["ui", "cli-admin", "desktop", "bobagem"]) expect(agentChannelFromEnv({ BRAIN_AGENT_CHANNEL: c }, "module/xy", warn)).toBe("mcp");
    expect(avisos).toHaveLength(7);
    expect(avisos[0]).toContain("BRAIN_AGENT_CHANNEL");
    expect(agentChannelFromEnv({}, "module/xy", warn)).toBe("mcp");
    expect(agentChannelFromEnv({ BRAIN_AGENT_CHANNEL: "" }, "module/xy", warn)).toBe("mcp");
    expect(avisos).toHaveLength(7);
  });

  it("o MCP grava como agent/<BRAIN_AGENT_NAME>, mesmo com outro nome de cliente", async () => {
    const vault = join(dir, "vault");
    const b = await Brain.init(vault);
    await b.updateConfig({ agents: { commit_policy: "additive" } }, human);
    b.close();
    const c = new Client({ name: "claude-code", version: "1.0.0" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], env: { ...(process.env as Record<string, string>), BRAIN_VAULT: vault, BRAIN_AGENT_NAME: "assistant/20261110-153012-a1b2" } }));
    clients.push(c);
    const r = await c.callTool({ name: "brain_propose", arguments: { title: "Observação inédita sobre zebras", type: "learning", body: "Zebras listradas confundem moscas hematófagas com o padrão das listras." } }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content[0]!.text) as { proposal_id: string; auto?: { resolution: string } };
    expect(out.auto?.resolution).toBe("create");
    const b2 = await Brain.open(vault);
    const p = b2.getProposal(out.proposal_id);
    b2.close();
    expect(p.proposed_by).toEqual({ kind: "agent", name: "assistant/20261110-153012-a1b2" });
    expect(p.decided?.by).toEqual({ kind: "agent", name: "assistant/20261110-153012-a1b2" });
  });
});
