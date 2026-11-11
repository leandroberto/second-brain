import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Brain, ConfigSchema, createClaudeEngine, createModuleIa, type ExecutorClaude, type SaidaProcesso } from "../src/index.js";

const MCP = { command: "/usr/bin/node-ficticio", args: ["/opt/brain-ficticio/bin.js", "mcp"] };
const saida = (extra: Record<string, unknown> = {}, estruturado: unknown = { x: 1 }): SaidaProcesso => ({
  codigo: 0, estourouTempo: false, stderr: "",
  stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "texto", structured_output: estruturado, ...extra }),
});
const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

let dir: string; let brain: Brain;
beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), "brain-ia-")); brain = await Brain.init(join(dir, "vault")); });
afterAll(() => { brain.close(); rmSync(dir, { recursive: true, force: true }); });

function montar(resposta: () => SaidaProcesso, iaMax = 2, assist: Record<string, unknown> = {}) {
  const chamadas: { args: string[]; entrada: string; timeoutMs: number; mcp?: { env: Record<string, string> } }[] = [];
  const exec: ExecutorClaude = async (_e, args, o) => {
    const i = args.indexOf("--mcp-config");
    const mcp = i >= 0 ? (JSON.parse(readFileSync(args[i + 1]!, "utf8")) as { mcpServers: Record<string, { env: Record<string, string> }> }).mcpServers["second-brain"] : undefined;
    chamadas.push({ args, entrada: o.entrada, timeoutMs: o.timeoutMs, mcp });
    return resposta();
  };
  const engine = createClaudeEngine(brain, exec, MCP);
  const cfg = ConfigSchema.parse({ assistant: { max_budget_usd: 0.5, timeout_s: 90, ...assist }, modules: { x: { ia_max_usd_dia: iaMax } } });
  const root = mkdtempSync(join(dir, "root-"));
  return { chamadas, ia: createModuleIa(engine, cfg, root, "x"), root };
}
const gasto = (root: string) => JSON.parse(readFileSync(join(root, "_ia.json"), "utf8")) as Record<string, Record<string, number>>;

describe("complete / createModuleIa", () => {
  it("complete sem notas não passa mcp-config", async () => {
    const { chamadas, ia } = montar(() => saida());
    const r = await ia.completar({ prompt: "olá", schemaJson: { type: "object" } });
    expect(r).toMatchObject({ ok: true, dados: { x: 1 } });
    const a = chamadas[0]!.args;
    expect(a).not.toContain("--mcp-config");
    expect(a).not.toContain("--allowedTools");
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a).toContain("--strict-mcp-config");
    expect(a).toContain("--no-session-persistence");
    expect(a).toContain("--json-schema");
    expect(a).not.toContain("--append-system-prompt-file");
    expect(chamadas[0]!.entrada).toBe("olá");
    expect(chamadas[0]!.timeoutMs).toBe(90_000);
  });

  it("sem schema não passa --json-schema e devolve o texto", async () => {
    const { chamadas, ia } = montar(() => saida({}, null));
    expect(await ia.completar({ prompt: "p" })).toMatchObject({ ok: true, dados: "texto" });
    expect(chamadas[0]!.args).not.toContain("--json-schema");
  });

  it("complete com notas usa ferramentas de leitura e agente module/x", async () => {
    const { chamadas, ia } = montar(() => saida());
    await ia.completar({ prompt: "p", comNotas: true });
    const a = chamadas[0]!.args;
    expect(a[a.indexOf("--allowedTools") + 1]).toBe("mcp__second-brain__brain_search,mcp__second-brain__brain_get,mcp__second-brain__brain_context");
    expect(chamadas[0]!.mcp!.env.BRAIN_AGENT_NAME).toBe("module/x");
    expect(chamadas[0]!.mcp!.env.BRAIN_AGENT_CHANNEL).toBe("module");
  });

  it("extrai total_cost_usd e soma no dia", async () => {
    const { ia, root } = montar(() => saida({ total_cost_usd: 0.12 }));
    expect(await ia.completar({ prompt: "p" })).toMatchObject({ ok: true, custoUsd: 0.12 });
    await ia.completar({ prompt: "p" });
    expect(gasto(root).x![hoje()]).toBeCloseTo(0.24);
  });

  it("sem custo conta o orçamento da chamada, limitado ao do assistente", async () => {
    const { chamadas, ia, root } = montar(() => saida());
    await ia.completar({ prompt: "p", orcamentoUsd: 0.2 });
    await ia.completar({ prompt: "p", orcamentoUsd: 99 });
    expect(chamadas[1]!.args[chamadas[1]!.args.indexOf("--max-budget-usd") + 1]).toBe("0.5");
    expect(gasto(root).x![hoje()]).toBeCloseTo(0.7);
  });

  it("teto diário bloqueia sem chamar o claude", async () => {
    const { chamadas, ia, root } = montar(() => saida(), 0.1);
    writeFileSync(join(root, "_ia.json"), JSON.stringify({ x: { [hoje()]: 0.1 } }));
    expect(await ia.completar({ prompt: "p" })).toEqual({ ok: false, tipo: "orcamento", mensagem: "teto diário de IA do módulo x atingido" });
    expect(chamadas).toHaveLength(0);
  });

  it("gasto de outro dia não conta; mantém só 31 dias", async () => {
    const { ia, root } = montar(() => saida({ total_cost_usd: 0.01 }), 0.1);
    const antigos = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`2020-01-${String(i + 1).padStart(2, "0")}`, 5]));
    writeFileSync(join(root, "_ia.json"), JSON.stringify({ x: antigos, outro: { "2020-01-01": 1 } }));
    expect((await ia.completar({ prompt: "p" })).ok).toBe(true);
    const g = gasto(root);
    expect(Object.keys(g.x!)).toHaveLength(31);
    expect(g.x![hoje()]).toBeCloseTo(0.01);
    expect(g.outro).toEqual({ "2020-01-01": 1 });
  });

  it("chamadas concorrentes não perdem soma", async () => {
    const { ia, root } = montar(() => saida({ total_cost_usd: 0.01 }));
    await Promise.all(Array.from({ length: 20 }, () => ia.completar({ prompt: "p" })));
    expect(gasto(root).x![hoje()]).toBeCloseTo(0.2);
    expect(existsSync(join(root, "_ia.json"))).toBe(true);
  });

  it("valida entradas", async () => {
    const { chamadas, ia } = montar(() => saida());
    for (const p of [{ prompt: "" }, { prompt: "  " }, { prompt: "p", orcamentoUsd: 0 }, { prompt: "p", orcamentoUsd: -1 }, { prompt: "p", orcamentoUsd: NaN }, { prompt: "p", orcamentoUsd: Infinity }, { prompt: "p", timeoutS: 0 }]) {
      expect(await ia.completar(p)).toMatchObject({ ok: false, tipo: "erro" });
    }
    expect(chamadas).toHaveLength(0);
  });

  it("falha do claude não soma gasto", async () => {
    const { ia, root } = montar(() => ({ codigo: 1, estourouTempo: false, stderr: "boom", stdout: "" }));
    expect(await ia.completar({ prompt: "p" })).toMatchObject({ ok: false, tipo: "erro" });
    expect(existsSync(join(root, "_ia.json"))).toBe(false);
  });
});
