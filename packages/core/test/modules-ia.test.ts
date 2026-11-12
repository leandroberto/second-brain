import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Brain, ConfigSchema, createClaudeEngine, createModuleIa, bloqueioIaNoDia, gastoIaDoDia, type ExecutorClaude, type SaidaProcesso } from "../src/index.js";

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
    expect(chamadas[0]!.mcp!.env.BRAIN_MCP_SEM_MODULOS).toBe("1"); // o MCP do motor não importa módulos
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

  it("orcamento e timeout contam o orçamento da chamada; erro com total_cost_usd conta o custo", async () => {
    const estouro: SaidaProcesso = { codigo: 1, estourouTempo: false, stderr: "", stdout: JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true }) };
    const a = montar(() => estouro);
    expect(await a.ia.completar({ prompt: "p", orcamentoUsd: 0.2 })).toMatchObject({ ok: false, tipo: "orcamento" });
    expect(gasto(a.root).x![hoje()]).toBeCloseTo(0.2);

    const b = montar(() => ({ codigo: null, estourouTempo: true, stderr: "", stdout: "" }));
    expect(await b.ia.completar({ prompt: "p", orcamentoUsd: 0.3 })).toMatchObject({ ok: false, tipo: "timeout" });
    expect(gasto(b.root).x![hoje()]).toBeCloseTo(0.3);

    const c = montar(() => ({ codigo: 1, estourouTempo: false, stderr: "", stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "falhou", total_cost_usd: 0.07 }) }));
    expect(await c.ia.completar({ prompt: "p" })).toMatchObject({ ok: false, tipo: "erro", custoUsd: 0.07 });
    expect(gasto(c.root).x![hoje()]).toBeCloseTo(0.07);

    const d = montar(() => estouro, 0.2);
    await d.ia.completar({ prompt: "p", orcamentoUsd: 0.2 });
    expect(await d.ia.completar({ prompt: "p" })).toMatchObject({ ok: false, tipo: "orcamento", mensagem: "teto diário de IA do módulo x atingido" });
    expect(d.chamadas).toHaveLength(1);
  });

  it("_ia.json ilegível: fail-closed (preserva o arquivo, avisa no stderr e bloqueia a IA de hoje)", async () => {
    const { chamadas, ia, root } = montar(() => saida({ total_cost_usd: 0.01 }));
    writeFileSync(join(root, "_ia.json"), "{ não é json");
    const avisos: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => { avisos.push(String(m)); });
    try {
      const r1 = await ia.completar({ prompt: "p" });
      const preservado = readdirSync(root).filter((f) => f.startsWith("_ia.json.corrompido-"));
      expect(preservado).toHaveLength(1);
      const bloqueio = { ok: false, tipo: "orcamento", mensagem: `registro de gasto de IA ilegível; IA do módulo x bloqueada até amanhã; o registro ilegível foi guardado em ${join(root, preservado[0]!)}` };
      expect(r1).toEqual(bloqueio);
      expect(await ia.completar({ prompt: "p" })).toEqual(bloqueio); // o bloqueio (e onde ficou o registro) persiste no novo _ia.json
      expect(chamadas).toHaveLength(0);
      expect(avisos).toHaveLength(1);
      expect(avisos[0]).toMatch(/ilegível.*_ia\.json/);
      expect(readFileSync(join(root, preservado[0]!), "utf8")).toBe("{ não é json");
    } finally { spy.mockRestore(); }
  });

  it("bloqueio por _ia.json ilegível vale só no dia em que foi detectado", async () => {
    const { chamadas, ia, root } = montar(() => saida({ total_cost_usd: 0.01 }));
    writeFileSync(join(root, "_ia.json"), JSON.stringify({ _ilegivel: "2000-01-01" }));
    expect(await ia.completar({ prompt: "p" })).toMatchObject({ ok: true });
    expect(chamadas).toHaveLength(1);
    expect(gasto(root)).toEqual({ x: { [hoje()]: 0.01 } });
  });

  it("timeoutS é limitado a 3600 s", async () => {
    const { chamadas, ia } = montar(() => saida());
    await ia.completar({ prompt: "p", timeoutS: 1e9 });
    expect(chamadas[0]!.timeoutMs).toBe(3_600_000);
  });
});

describe("gastoIaDoDia", () => {
  it("_ia.json corrompido ou com valor que não é número dá 0", () => {
    const root = mkdtempSync(join(dir, "gasto-"));
    const dia = hoje();
    writeFileSync(join(root, "_ia.json"), JSON.stringify({ x: { [dia]: "muito" }, y: { [dia]: null }, z: { [dia]: 0.25 } }));
    expect(gastoIaDoDia(root, "x")).toBe(0);
    expect(gastoIaDoDia(root, "y")).toBe(0);
    expect(gastoIaDoDia(root, "z")).toBe(0.25);
    expect(gastoIaDoDia(root, "nenhum")).toBe(0);
    writeFileSync(join(root, "_ia.json"), "{ não é json");
    expect(gastoIaDoDia(root, "z")).toBe(0);
    writeFileSync(join(root, "_ia.json"), JSON.stringify({ z: "texto" }));
    expect(gastoIaDoDia(root, "z")).toBe(0);
  });
});

const comoRoot = process.getuid?.() === 0;

describe("bloqueioIaNoDia", () => {
  it("marca do dia (registro guardado) e arquivo ilegível ainda não tocado, sem efeito colateral", () => {
    const root = mkdtempSync(join(dir, "bloq-"));
    const arq = join(root, "_ia.json");
    expect(bloqueioIaNoDia(root)).toBeUndefined(); // sem arquivo
    writeFileSync(arq, JSON.stringify({ z: { [hoje()]: 0.1 } }));
    expect(bloqueioIaNoDia(root)).toBeUndefined();
    writeFileSync(arq, JSON.stringify({ _ilegivel: hoje(), _guardado: "/estado/_ia.json.corrompido-x", z: { [hoje()]: 0.1 } }));
    expect(bloqueioIaNoDia(root)?.motivo).toBe("bloqueada até amanhã; o registro ilegível foi guardado em /estado/_ia.json.corrompido-x");
    expect(gastoIaDoDia(root, "z")).toBe(0.1);
    writeFileSync(arq, JSON.stringify({ _ilegivel: "2000-01-01", _guardado: "/x" }));
    expect(bloqueioIaNoDia(root)).toBeUndefined(); // marca de outro dia
    writeFileSync(arq, "{ trunc");
    expect(bloqueioIaNoDia(root)?.motivo).toBe("bloqueada: registro de gasto ilegível (será guardado na próxima chamada)");
    expect(readFileSync(arq, "utf8")).toBe("{ trunc"); // nada foi preservado nem gravado
    expect(readdirSync(root)).toEqual(["_ia.json"]);
  });

  it.skipIf(comoRoot)("ilegível numa pasta sem permissão de escrita: bloqueada até corrigir (exibição e chamada)", async () => {
    const { chamadas, ia, root } = montar(() => saida({ total_cost_usd: 0.01 }));
    writeFileSync(join(root, "_ia.json"), "{ trunc");
    chmodSync(root, 0o500);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const motivo = `bloqueada até corrigir: não foi possível guardar o registro ilegível em ${root}; confira as permissões`;
      expect(bloqueioIaNoDia(root)?.motivo).toBe(motivo);
      expect(await ia.completar({ prompt: "p" })).toEqual({ ok: false, tipo: "orcamento", mensagem: `registro de gasto de IA ilegível; IA do módulo x ${motivo}` });
      expect(chamadas).toHaveLength(0);
    } finally { spy.mockRestore(); chmodSync(root, 0o700); }
    expect(readFileSync(join(root, "_ia.json"), "utf8")).toBe("{ trunc");
  });

  it.skipIf(comoRoot)("registro inacessível (permissão negada): bloqueio visível com o código", () => {
    const root = mkdtempSync(join(dir, "bloq-"));
    writeFileSync(join(root, "_ia.json"), JSON.stringify({ z: { [hoje()]: 0.1 } }));
    chmodSync(join(root, "_ia.json"), 0o000);
    try { expect(bloqueioIaNoDia(root)?.motivo).toBe("bloqueada: registro de gasto inacessível (EACCES)"); }
    finally { chmodSync(join(root, "_ia.json"), 0o600); }
  });
});
