import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  Assistant, BRAIN_TOOLS, Brain, CaptureLog, ConfigSchema, createClaudeEngine, interpretarSaida, principal,
  type ExecutorClaude, type SaidaProcesso,
} from "../src/index.js";
import { cleanup, human, tempBrain } from "./helpers.js";

afterAll(cleanup);

/** Comando fictício do MCP: o adapter (serve) é quem informa o caminho real do bin do cli. */
const MCP = { command: "/usr/bin/node-ficticio", args: ["/opt/brain-ficticio/bin.js", "mcp"] };

async function additiveBrain(): Promise<Brain> {
  const b = await tempBrain();
  await b.updateConfig({ agents: { commit_policy: "additive" } }, human);
  return b;
}

/** Saída no formato do `claude -p --output-format json` (campos relevantes). */
const saidaOk = (estruturado: unknown): SaidaProcesso => ({
  codigo: 0, estourouTempo: false, stderr: "",
  stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(estruturado), structured_output: estruturado, subagent_stats: { refused: { budget: 0 } } }),
});
const saidaDeslogado: SaidaProcesso = {
  codigo: 1, estourouTempo: false, stderr: "",
  stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", terminal_reason: "api_error", subagent_stats: { refused: { budget: 0 } } }),
};
const saidaOrcamento: SaidaProcesso = {
  codigo: 1, estourouTempo: false, stderr: "",
  stdout: JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.53, errors: ["Reached maximum budget ($0.5)"] }),
};
const semNotas = { notas: [], segredo_omitido: false, texto_mascarado: null };

const valorDe = (args: string[], flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
type McpCfg = { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
const lerMcp = (args: string[]): McpCfg => JSON.parse(readFileSync(valorDe(args, "--mcp-config")!, "utf8")) as McpCfg;
const agenteDe = (args: string[]) => lerMcp(args).mcpServers["second-brain"]!.env.BRAIN_AGENT_NAME!;
const idDaCaptura = (args: string[]) => agenteDe(args).replace(/^assistant\//, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const commitsDoRegistro = (b: Brain) => execFileSync("git", ["-C", b.vault.root, "log", "--format=%s", "--", ".brain/captures"], { encoding: "utf8" }).split("\n").filter(Boolean);

/** Executor falso que simula o MCP filho: o agente `assistant/<id>` propõe a nota pelo core. */
function execQuePropoe(b: Brain, titulo: string, corpo: string): ExecutorClaude {
  return async (_exe, args) => {
    const quem = principal("agent", agenteDe(args), "mcp");
    const p = await b.propose({ title: titulo, type: "learning", body: corpo }, quem);
    return saidaOk({ notas: [{ id: p.auto!.note_id!, acao: "criada" }], segredo_omitido: false, texto_mascarado: null });
  };
}

describe("custoUsd só no modo complete", () => {
  it("erro de capture e de ask não traz custoUsd; o de complete traz", async () => {
    const b = await tempBrain();
    const motor = createClaudeEngine(b, async () => saidaOrcamento, MCP);
    const cap = await motor.capture({ id: "20261111-120000-abcd", text: "texto", origin: "ui", state: "pendente", ids: [] });
    expect(cap).toMatchObject({ ok: false, tipo: "orcamento" });
    expect(cap).not.toHaveProperty("custoUsd");
    const ask = await motor.ask("pergunta");
    expect(ask).toMatchObject({ ok: false, tipo: "orcamento" });
    expect(ask).not.toHaveProperty("custoUsd");
    expect(await motor.complete({ agente: "module/x", prompt: "p", orcamentoUsd: 0.5, timeoutS: 10, comNotas: false })).toMatchObject({ ok: false, custoUsd: 0.53 });
  });
});

describe("registro de capturas e motor de assistente", () => {
  it("captura grava o texto antes de chamar o motor", async () => {
    const b = await tempBrain();
    let visto: ReturnType<CaptureLog["get"]>;
    const exec: ExecutorClaude = async (_exe, args) => { visto = asst.captures.get(idDaCaptura(args)); return saidaOk(semNotas); };
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    const texto = "Para reiniciar o consumidor da fila demo, pare o serviço antes do deploy.";
    const r = await asst.capture(texto, "desktop");
    expect(r.capture.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(visto?.state).toBe("pendente");
    expect(visto?.text).toBe(texto);
    expect(visto?.origin).toBe("desktop");
    // versionado: um commit ao gravar a entrada e outro ao marcar
    expect(commitsDoRegistro(b)).toHaveLength(2);
  });

  it("args nunca contêm o texto e não liberam ferramentas embutidas", async () => {
    const b = await tempBrain();
    let chamada: { exe: string; args: string[]; entrada: string; timeoutMs: number; cwd: string; mcp: McpCfg; mcpPath: string } | undefined;
    const exec: ExecutorClaude = async (exe, args, op) => {
      chamada = { exe, args: [...args], entrada: op.entrada, timeoutMs: op.timeoutMs, cwd: op.cwd, mcp: lerMcp(args), mcpPath: valorDe(args, "--mcp-config")! };
      return saidaOk(semNotas);
    };
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    const texto = "Anotação distintiva zebra-42: o relatório mensal fecha no quinto dia útil.";
    const r = await asst.capture(texto, "ui");
    const c = chamada!;
    expect(c.args.some((a) => a.includes("zebra-42"))).toBe(false);
    expect(c.entrada).toContain(texto);
    expect(c.args).toContain("-p");
    expect(c.args).toContain("--strict-mcp-config");
    expect(c.args).toContain("--no-session-persistence");
    const permitidas = valorDe(c.args, "--allowedTools")!.split(",");
    expect(permitidas.every((t) => /^mcp__second-brain__brain_[a-z]+$/.test(t))).toBe(true);
    expect([...permitidas].sort()).toEqual(["search", "similar", "get", "context", "propose", "link"].map((t) => `mcp__second-brain__brain_${t}`).sort());
    expect(valorDe(c.args, "--tools")).toBe(""); // nenhuma ferramenta embutida
    for (const t of ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"]) expect(c.args).not.toContain(t);
    expect(valorDe(c.args, "--output-format")).toBe("json");
    expect(valorDe(c.args, "--model")).toBe("sonnet");
    expect(valorDe(c.args, "--max-budget-usd")).toBe("0.5");
    expect(JSON.parse(valorDe(c.args, "--json-schema")!).required).toEqual(["notas", "segredo_omitido", "texto_mascarado"]);
    expect(valorDe(c.args, "--append-system-prompt-file")!.replace(/\\/g, "/")).toMatch(/templates\/assistant\/capture\.md$/);
    expect(existsSync(valorDe(c.args, "--append-system-prompt-file")!)).toBe(true);
    expect(c.exe).toBe("claude");
    expect(c.timeoutMs).toBe(120_000);
    // o MCP filho é o do próprio second-brain, com a identidade do agente da captura
    expect(Object.keys(c.mcp.mcpServers)).toEqual(["second-brain"]);
    const srv = c.mcp.mcpServers["second-brain"]!;
    expect(srv.command).toBe(MCP.command);
    expect(srv.args).toEqual(MCP.args);
    expect(srv.env.BRAIN_VAULT).toBe(b.vault.root);
    expect(srv.env.BRAIN_AGENT_NAME).toBe(`assistant/${r.capture.id}`);
    expect(srv.env.BRAIN_MCP_SEM_MODULOS).toBe("1"); // ferramentas de módulo nem são importadas no MCP do assistente
    expect(existsSync(c.mcpPath)).toBe(false); // arquivo temporário apagado ao terminar
  });

  it("repassa BRAIN_STATE_DIR ao MCP e usa o prompt do vault quando existe", async () => {
    const b = await tempBrain();
    mkdirSync(join(b.vault.root, ".brain", "assistant"), { recursive: true });
    writeFileSync(join(b.vault.root, ".brain", "assistant", "capture.md"), "Regras do vault.\n");
    let args: string[] = [];
    let env: Record<string, string> = {};
    const exec: ExecutorClaude = async (_exe, a) => { args = [...a]; env = lerMcp(a).mcpServers["second-brain"]!.env; return saidaOk(semNotas); };
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    const antes = process.env.BRAIN_STATE_DIR;
    try {
      process.env.BRAIN_STATE_DIR = "/tmp/estado-ficticio";
      await asst.capture("Primeira anotação de teste do estado.", "ui");
      expect(env.BRAIN_STATE_DIR).toBe("/tmp/estado-ficticio");
      delete process.env.BRAIN_STATE_DIR;
      await asst.capture("Segunda anotação de teste do estado.", "ui");
      expect(env).not.toHaveProperty("BRAIN_STATE_DIR");
    } finally { if (antes === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = antes; }
    expect(valorDe(args, "--append-system-prompt-file")).toBe(join(b.vault.root, ".brain", "assistant", "capture.md"));
  });

  it("captura bem-sucedida marca processada com ids", async () => {
    const b = await additiveBrain();
    const asst = new Assistant(b, createClaudeEngine(b, execQuePropoe(b, "Ordem de parada do consumidor", "O consumidor da fila demo é parado antes do produtor."), MCP));
    const r = await asst.capture("O consumidor da fila demo é parado antes do produtor.", "desktop");
    expect(r.result.ok).toBe(true);
    const noteId = r.result.ok ? r.result.notas[0]!.id : "";
    expect(b.loadNote(noteId).title).toBe("Ordem de parada do consumidor");
    expect(r.capture.state).toBe("processada");
    expect(r.capture.ids).toEqual([noteId]);
    expect(asst.captures.get(r.capture.id)).toMatchObject({ state: "processada", ids: [noteId] });
    const id = r.capture.id;
    const arquivo = readFileSync(join(b.vault.root, ".brain", "captures", `${id.slice(0, 4)}-${id.slice(4, 6)}.md`), "utf8");
    expect(arquivo).toContain(`### ${id} · processada → ${noteId}\n`);
    // o commit da gravação automática identifica a captura (usado depois para desfazer)
    const msgs = execFileSync("git", ["-C", b.vault.root, "log", "--format=%B"], { encoding: "utf8" });
    expect(msgs).toContain(`Brain-Decided-By: agent/assistant/${id}`);
    expect(commitsDoRegistro(b)).toHaveLength(2);
  });

  it("captura com erro de auth fica pendente e retry processa", async () => {
    const b = await additiveBrain();
    let n = 0;
    const ok = execQuePropoe(b, "Janela de manutenção demo", "A janela de manutenção do ambiente demo é às quartas, das 20h às 22h.");
    const exec: ExecutorClaude = async (exe, args, op) => (n++ === 0 ? saidaDeslogado : ok(exe, args, op));
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    const r = await asst.capture("A janela de manutenção do ambiente demo é às quartas, das 20h às 22h.", "ui");
    expect(r.result).toMatchObject({ ok: false, tipo: "auth" });
    expect(r.capture.state).toBe("pendente");
    expect(asst.captures.get(r.capture.id)?.state).toBe("pendente");
    expect(asst.captures.pending().map((e) => e.id)).toEqual([r.capture.id]);
    expect(await asst.retryPending()).toBe(1);
    expect(asst.captures.get(r.capture.id)?.state).toBe("processada");
    expect(asst.captures.get(r.capture.id)?.ids).toHaveLength(1);
    expect(asst.captures.pending()).toEqual([]);
    expect(await asst.retryPending()).toBe(0);
  });

  it("orçamento estourado, timeout e exceção do executor voltam tipados e deixam pendente", async () => {
    const b = await tempBrain();
    const saidas: Array<SaidaProcesso | Error> = [saidaOrcamento, { codigo: null, stdout: "", stderr: "", estourouTempo: true }, new Error("spawn claude ENOENT")];
    const exec: ExecutorClaude = async () => { const s = saidas.shift()!; if (s instanceof Error) throw s; return s; };
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    const r1 = await asst.capture("Primeira anotação que vai estourar o orçamento.", "ui");
    const r2 = await asst.capture("Segunda anotação que vai estourar o tempo.", "ui");
    const r3 = await asst.capture("Terceira anotação com executor quebrado.", "ui");
    expect(r1.result).toMatchObject({ ok: false, tipo: "orcamento" });
    expect(r2.result).toMatchObject({ ok: false, tipo: "timeout" });
    expect(r3.result).toMatchObject({ ok: false, tipo: "erro" });
    expect(asst.captures.pending()).toHaveLength(3);
  });

  it("interpretarSaida: orçamento pelo subtype, auth pela mensagem, sem confundir com campos de estatística", () => {
    expect(interpretarSaida(saidaOrcamento)).toMatchObject({ ok: false, tipo: "orcamento" });
    expect(interpretarSaida(saidaDeslogado)).toMatchObject({ ok: false, tipo: "auth" });
    expect(interpretarSaida({ codigo: 1, stdout: "", stderr: "Error: Exceeded USD budget (0.5)", estourouTempo: false })).toMatchObject({ ok: false, tipo: "orcamento" });
    expect(interpretarSaida({ codigo: 1, stdout: "", stderr: "boom", estourouTempo: false })).toEqual({ ok: false, tipo: "erro", mensagem: "boom" });
    expect(interpretarSaida({ codigo: 0, stdout: "", stderr: "", estourouTempo: true })).toMatchObject({ ok: false, tipo: "timeout" });
    expect(interpretarSaida(saidaOk({ a: 1 }))).toEqual({ ok: true, dados: { a: 1 } });
  });

  it("saída estruturada fora do esquema vira erro e deixa pendente", async () => {
    const b = await tempBrain();
    const asst = new Assistant(b, createClaudeEngine(b, async () => saidaOk({ arquivos: ["a.md"] }), MCP));
    const r = await asst.capture("Anotação com resposta fora do esquema.", "ui");
    expect(r.result).toMatchObject({ ok: false, tipo: "erro" });
    expect(r.capture.state).toBe("pendente");
  });

  it("capturas simultâneas são serializadas", async () => {
    const b = await tempBrain();
    let ativas = 0; let maximo = 0; let chamadas = 0;
    const exec: ExecutorClaude = async () => { chamadas++; ativas++; maximo = Math.max(maximo, ativas); await sleep(60); ativas--; return saidaOk(semNotas); };
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    const [a, c] = await Promise.all([asst.capture("Primeira captura simultânea de teste.", "desktop"), asst.capture("Segunda captura simultânea de teste.", "ui")]);
    expect(chamadas).toBe(2);
    expect(maximo).toBe(1);
    expect([a.capture.state, c.capture.state]).toEqual(["processada", "processada"]);
    expect(a.capture.id).not.toBe(c.capture.id);
  });

  it("ask sem fontes responde Não está anotado.", async () => {
    const b = await tempBrain();
    let args: string[] = []; let agente = "";
    const exec: ExecutorClaude = async (_exe, a) => { args = [...a]; agente = agenteDe(a); return saidaOk({ resposta: "x", fontes: [] }); };
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    const r = await asst.ask("Qual é a janela de manutenção?");
    expect(r).toEqual({ ok: true, resposta: "Não está anotado.", fontes: [] });
    const permitidas = valorDe(args, "--allowedTools")!.split(",");
    expect([...permitidas].sort()).toEqual(["context", "get", "search"].map((t) => `mcp__second-brain__brain_${t}`));
    expect(args).toContain("--strict-mcp-config");
    expect(valorDe(args, "--tools")).toBe("");
    expect(args.some((a) => a.includes("janela de manutenção"))).toBe(false);
    expect(JSON.parse(valorDe(args, "--json-schema")!).required).toEqual(["resposta", "fontes"]);
    expect(valorDe(args, "--append-system-prompt-file")!.replace(/\\/g, "/")).toMatch(/templates\/assistant\/ask\.md$/);
    expect(agente).toBe("assistant/ask");
    expect(args).toContain("--no-session-persistence"); // pergunta avulsa, sem conversa
    // nenhuma captura é gravada por uma pergunta
    expect(asst.captures.pending()).toEqual([]);
  });

  it("ask só aceita fontes que existem no vault e mantém a conversa", async () => {
    const b = await tempBrain();
    const nota = await b.createNote({ title: "Janela de manutenção demo", type: "fact", body: "A janela de manutenção do ambiente demo é às quartas." }, human);
    const chamadas: string[][] = [];
    const respostas = [{ resposta: "Às quartas.", fontes: [nota.id, "nota-inventada"] }, { resposta: "Inventado.", fontes: ["nota-inventada"] }];
    const exec: ExecutorClaude = async (_exe, a) => { chamadas.push([...a]); return saidaOk(respostas.shift()); };
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    const conversa = "0b8f3d4e-1c2a-4f5b-9e6d-7a8b9c0d1e2f";
    expect(await asst.ask("Quando é a janela?", conversa)).toEqual({ ok: true, resposta: "Às quartas.", fontes: [nota.id] });
    expect(await asst.ask("E o horário?", conversa)).toEqual({ ok: true, resposta: "Não está anotado.", fontes: [] });
    expect(valorDe(chamadas[0]!, "--session-id")).toBe(conversa);
    expect(chamadas[0]).not.toContain("--resume");
    expect(valorDe(chamadas[1]!, "--resume")).toBe(conversa);
    expect(chamadas[1]).not.toContain("--session-id");
    expect(await asst.ask("Conversa inválida", "nao-e-uuid")).toMatchObject({ ok: false, tipo: "erro" });
  });

  it("cerca cresce quando o texto tem ~~~~", async () => {
    const b = await tempBrain();
    const log = new CaptureLog(b);
    const texto = "Antes da cerca\n~~~~\nmeio com cerca\n~~~~~\nfim do texto";
    const e = await log.append(texto, "ui");
    const raw = readFileSync(join(b.vault.root, ".brain", "captures", `${e.id.slice(0, 4)}-${e.id.slice(4, 6)}.md`), "utf8");
    expect(raw).toContain(`### ${e.id} · pendente\n`);
    expect(raw).toContain("\n~~~~~~\nAntes da cerca\n");
    expect(log.get(e.id)?.text).toBe(texto);
    await log.mark(e.id, "processada", ["nota-a", "nota-b"]);
    expect(log.get(e.id)).toMatchObject({ text: texto, state: "processada", ids: ["nota-a", "nota-b"], origin: "ui" });
    await log.mark(e.id, "desfeita");
    expect(log.get(e.id)).toMatchObject({ text: texto, state: "desfeita", ids: ["nota-a", "nota-b"] });
  });

  it("lê entradas legadas migradas do _entrada", async () => {
    const b = await tempBrain();
    const dir = join(b.vault.root, ".brain", "captures");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-11.md"), [
      "### 20261106-154437-a1b2 · processada → ambiente/wsl-proxy.md, processos/deploy.md",
      "~~~~",
      "Texto antigo ditado no app desktop.",
      "~~~~",
      "",
      "### 20261106-160000-c3d4 · pendente",
      "",
      "~~~~",
      "Texto antigo que ficou pendente.",
      "~~~~",
      "",
    ].join("\n"));
    const log = new CaptureLog(b);
    expect(log.get("20261106-154437-a1b2")).toEqual({ id: "20261106-154437-a1b2", text: "Texto antigo ditado no app desktop.", origin: "desktop", state: "processada", ids: ["ambiente/wsl-proxy.md", "processos/deploy.md"] });
    expect(log.pending().map((e) => e.id)).toEqual(["20261106-160000-c3d4"]);
    expect(log.get("20261106-160000-c3d4")?.text).toBe("Texto antigo que ficou pendente.");
    // marcar uma entrada legada preserva as vizinhas
    await log.mark("20261106-160000-c3d4", "processada", ["fact-x"]);
    expect(log.get("20261106-154437-a1b2")?.ids).toEqual(["ambiente/wsl-proxy.md", "processos/deploy.md"]);
    expect(log.get("20261106-160000-c3d4")).toMatchObject({ state: "processada", ids: ["fact-x"] });
  });

  it("segredo detectado pelo core não entra no registro versionado", async () => {
    const b = await tempBrain();
    const log = new CaptureLog(b);
    const e = await log.append("Acesso ao banco demo: password=Sup3rS3cr3tV4lue usuário app_demo.", "ui");
    expect(e.text).not.toContain("Sup3rS3cr3tV4lue");
    expect(e.text).toContain("[SENHA OMITIDA]");
    expect(e.text).toContain("usuário app_demo");
    const historico = execFileSync("git", ["-C", b.vault.root, "log", "-p", "--", ".brain/captures"], { encoding: "utf8" });
    expect(historico).not.toContain("Sup3rS3cr3tV4lue");
  });

  it("config: seção assistant com os padrões", () => {
    expect(ConfigSchema.parse({}).assistant).toEqual({ engine: "claude", model: "sonnet", max_budget_usd: 0.5, timeout_s: 120, claude_path: "claude" });
  });
});

describe("rodada 1: cwd estável, retomada de conversa e ferramentas negadas", () => {
  const CONVERSA = "0b8f3d4e-1c2a-4f5b-9e6d-7a8b9c0d1e2f";
  const ehCaptura = (args: string[]) => valorDe(args, "--allowedTools")!.includes("brain_propose");
  const falha = (stderr: string): SaidaProcesso => ({ codigo: 1, stdout: "", stderr, estourouTempo: false });

  it("cwd estável e vazio: o mesmo na captura e nas perguntas da mesma conversa", async () => {
    const b = await tempBrain();
    const cwds: string[] = [];
    const exec: ExecutorClaude = async (_exe, a, op) => { cwds.push(op.cwd); return ehCaptura(a) ? saidaOk(semNotas) : saidaOk({ resposta: "x", fontes: [] }); };
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    await asst.capture("Captura para conferir o diretório de trabalho.", "ui");
    await asst.ask("Primeira pergunta?", CONVERSA);
    await asst.ask("Segunda pergunta?", CONVERSA);
    expect(cwds).toHaveLength(3);
    expect(new Set(cwds).size).toBe(1);
    expect(cwds[0]).toBe(join(b.vault.root, ".brain", "assistant-cwd"));
    expect(existsSync(cwds[0]!)).toBe(true);
    // não é versionado: o init ignora o diretório
    expect(readFileSync(join(b.vault.root, ".gitignore"), "utf8")).toContain(".brain/assistant-cwd/");
  });

  it("com estado externo, o cwd fica no diretório de estado (fora do vault)", async () => {
    const antes = process.env.BRAIN_STATE_DIR;
    const base = mkdtempSync(join(tmpdir(), "brain-asst-ext-"));
    try {
      process.env.BRAIN_STATE_DIR = join(base, "state");
      const vault = join(base, "vault");
      mkdirSync(join(vault, ".brain"), { recursive: true });
      writeFileSync(join(vault, ".brain", "config.yaml"), "state:\n  external: true\n");
      const b = await Brain.init(vault);
      let cwd = "";
      const asst = new Assistant(b, createClaudeEngine(b, async (_exe, _a, op) => { cwd = op.cwd; return saidaOk({ resposta: "x", fontes: [] }); }, MCP));
      await asst.ask("Pergunta com estado externo?");
      b.close();
      expect(cwd).toBe(join(base, "state", "assistant-cwd"));
      expect(existsSync(join(vault, ".brain", "assistant-cwd"))).toBe(false);
    } finally {
      if (antes === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = antes;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("--session-id em uso (restart) é retomado com --resume do mesmo id", async () => {
    const b = await tempBrain();
    const chamadas: string[][] = [];
    const exec: ExecutorClaude = async (_exe, a) => {
      chamadas.push([...a]);
      return a.includes("--session-id") ? falha(`Error: Session ID ${CONVERSA} is already in use.\n`) : saidaOk({ resposta: "x", fontes: [] });
    };
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    expect(await asst.ask("Pergunta depois do restart?", CONVERSA)).toMatchObject({ ok: true });
    expect(chamadas).toHaveLength(2);
    expect(valorDe(chamadas[0]!, "--session-id")).toBe(CONVERSA);
    expect(valorDe(chamadas[1]!, "--resume")).toBe(CONVERSA);
    expect(chamadas[1]).not.toContain("--session-id");
  });

  it("--resume de sessão inexistente começa uma conversa nova com id novo e segue nela", async () => {
    const b = await tempBrain();
    const chamadas: string[][] = [];
    let perdeu = false; // a 2ª pergunta encontra a sessão apagada
    const exec: ExecutorClaude = async (_exe, a) => {
      chamadas.push([...a]);
      if (perdeu && valorDe(a, "--resume") === CONVERSA) return falha(`No conversation found with session ID: ${CONVERSA}\n`);
      return saidaOk({ resposta: "x", fontes: [] });
    };
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    expect(await asst.ask("Primeira?", CONVERSA)).toMatchObject({ ok: true });
    perdeu = true;
    expect(await asst.ask("Segunda?", CONVERSA)).toMatchObject({ ok: true });
    expect(await asst.ask("Terceira?", CONVERSA)).toMatchObject({ ok: true });
    expect(chamadas).toHaveLength(4);
    expect(valorDe(chamadas[0]!, "--session-id")).toBe(CONVERSA);
    expect(valorDe(chamadas[1]!, "--resume")).toBe(CONVERSA);
    const nova = valorDe(chamadas[2]!, "--session-id")!;
    expect(nova).toMatch(/^[0-9a-f-]{36}$/);
    expect(nova).not.toBe(CONVERSA);
    expect(valorDe(chamadas[3]!, "--resume")).toBe(nova);
  });

  it("em uso e depois inexistente: tenta --resume e então começa com id novo; outro erro não repete", async () => {
    const b = await tempBrain();
    const chamadas: string[][] = [];
    const exec: ExecutorClaude = async (_exe, a) => {
      chamadas.push([...a]);
      if (valorDe(a, "--session-id") === CONVERSA) return falha(`Error: Session ID ${CONVERSA} is already in use.\n`);
      if (valorDe(a, "--resume") === CONVERSA) return falha(`No conversation found with session ID: ${CONVERSA}\n`);
      return saidaOk({ resposta: "x", fontes: [] });
    };
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    expect(await asst.ask("Pergunta?", CONVERSA)).toMatchObject({ ok: true });
    expect(chamadas).toHaveLength(3);
    expect(valorDe(chamadas[1]!, "--resume")).toBe(CONVERSA);
    expect(valorDe(chamadas[2]!, "--session-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(valorDe(chamadas[2]!, "--session-id")).not.toBe(CONVERSA);
    let n = 0;
    const asst2 = new Assistant(b, createClaudeEngine(b, async () => { n++; return falha("boom"); }, MCP));
    expect(await asst2.ask("Pergunta?", CONVERSA)).toMatchObject({ ok: false, tipo: "erro" });
    expect(n).toBe(1);
  });

  it("--disallowedTools traz o complemento exato das ferramentas brain_* liberadas", async () => {
    const b = await tempBrain();
    const porModo: Record<string, string[]> = {};
    const exec: ExecutorClaude = async (_exe, a) => {
      porModo[ehCaptura(a) ? "capture" : "ask"] = [...a];
      return ehCaptura(a) ? saidaOk(semNotas) : saidaOk({ resposta: "x", fontes: [] });
    };
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    await asst.capture("Captura para conferir as ferramentas negadas.", "ui");
    await asst.ask("Pergunta para conferir as ferramentas negadas?");
    const negadas = (m: string) => (valorDe(porModo[m]!, "--disallowedTools") ?? "").split(",").filter(Boolean).sort();
    const nomes = (ts: string[]) => ts.map((t) => `mcp__second-brain__brain_${t}`).sort();
    expect(negadas("capture")).toEqual(nomes(["amend", "commit", "health", "projects", "recent", "supersede"]));
    expect(negadas("ask")).toEqual(nomes(["amend", "commit", "health", "projects", "recent", "supersede", "propose", "link", "similar"]));
    // liberadas + negadas = todas as ferramentas conhecidas, sem sobreposição
    for (const m of ["capture", "ask"]) {
      const liberadas = valorDe(porModo[m]!, "--allowedTools")!.split(",");
      expect([...liberadas, ...negadas(m)].sort()).toEqual(BRAIN_TOOLS.map((t) => `mcp__second-brain__${t}`).sort());
    }
  });
});
