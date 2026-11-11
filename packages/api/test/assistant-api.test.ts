import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Assistant, Brain, createClaudeEngine, principal, type ExecutorClaude, type SaidaProcesso } from "@brain/core";
import { issueHumanSession, startApi, type ApiHandle } from "../src/index.js";
import { human, terminalHuman } from "../../core/test/helpers.js";

const MCP = { command: "/usr/bin/node-ficticio", args: ["/opt/brain-ficticio/bin.js", "mcp"] };
const saidaOk = (estruturado: unknown): SaidaProcesso => ({
  codigo: 0, estourouTempo: false, stderr: "",
  stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(estruturado), structured_output: estruturado, subagent_stats: { refused: { budget: 0 } } }),
});
const saidaDeslogado: SaidaProcesso = {
  codigo: 1, estourouTempo: false, stderr: "",
  stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", terminal_reason: "api_error", subagent_stats: { refused: { budget: 0 } } }),
};
const agenteDe = (args: string[]) => {
  const cfg = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1]!, "utf8")) as { mcpServers: Record<string, { env: Record<string, string> }> };
  return cfg.mcpServers["second-brain"]!.env.BRAIN_AGENT_NAME!;
};

let dir: string; let brain: Brain; let api: ApiHandle; let semAssistente: ApiHandle;
let uiToken: string; let deskToken: string; let noteId: string;
let deslogado = false; let chamadas = 0;
const NOTAS = [
  { t: "Cometa de Halley fictício", b: "O cometa fictício retorna a cada setenta e seis anos e brilha sobre o observatório." },
  { t: "Receita de ferrugem", b: "Vinagre com sal acelera a oxidação de pregos deixados na bancada do laboratório." },
  { t: "Orquídeas da estufa", b: "As orquídeas da estufa pedem névoa pela manhã e sombra parcial durante a tarde." },
  { t: "Vulcão adormecido", b: "A cratera do vulcão adormecido guarda um lago esverdeado com fumarolas esparsas." },
  { t: "Tapete persa demonstrativo", b: "Nós duplos e lã tingida com raízes definem a trama do tapete da exposição." },
  { t: "Cartografia de marés", b: "Tábuas de maré mostram preamar às seis horas e baixa-mar perto do meio-dia." },
  { t: "Fermentação do pão", b: "A massa descansa doze horas na geladeira antes do forno bem quente." },
  { t: "Telescópio de bolso", b: "Lentes acromáticas pequenas revelam crateras lunares em noites sem nuvens." },
];
const sessions = () => ({ file: join(dir, "sessions.json") });
const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
const call = (t: string, method: string, p: string, body?: unknown, base = () => api.url) =>
  fetch(base() + p, { method, headers: auth(t), body: body === undefined ? undefined : JSON.stringify(body) });

/** Executor falso: captura propõe a nota pelo core (como o MCP filho); pergunta responde citando a nota semeada. */
const exec: ExecutorClaude = async (_exe, args) => {
  if (deslogado) return saidaDeslogado;
  const agente = agenteDe(args);
  if (agente === "assistant/ask") return saidaOk({ resposta: "O timeout é de 45 segundos.", fontes: [noteId] });
  // conteúdo distinto a cada chamada: nada vira duplicata nem complemento (que ficariam na fila e não seriam notas novas)
  const nota = NOTAS[chamadas++ % NOTAS.length]!;
  const p = await brain.propose({ title: nota.t, type: "learning", body: nota.b }, principal("agent", agente, "mcp"));
  if (!p.auto?.note_id) throw new Error("proposta não aplicada: " + JSON.stringify(p.analysis));
  return saidaOk({ notas: [{ id: p.auto!.note_id!, acao: "criada" }], segredo_omitido: false, texto_mascarado: null });
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-asst-api-"));
  brain = await Brain.init(join(dir, "vault"));
  await brain.updateConfig({ agents: { commit_policy: "additive" } }, human);
  noteId = (await brain.createNote({ title: "Limite de conexões fictício", type: "fact", body: "O serviço fictício X aceita 200 conexões simultâneas." }, human)).id;
  const assistant = new Assistant(brain, createClaudeEngine(brain, exec, MCP));
  api = await startApi(brain, { port: 0, sessions: sessions(), assistant });
  semAssistente = await startApi(brain, { port: 0, sessions: sessions() });
  const proof = await terminalHuman("alice", sessions());
  uiToken = issueHumanSession(brain.vault.root, proof, sessions());
  deskToken = issueHumanSession(brain.vault.root, proof, { ...sessions(), scope: "desktop", label: "desktop" });
});
afterAll(async () => { await api.close(); await semAssistente.close(); brain.close(); rmSync(dir, { recursive: true, force: true }); });

describe("endpoints do assistente", () => {
  it("capture exige sessão humana", async () => {
    const texto = { text: "O timeout padrão do serviço fictício X é 45 segundos." };
    expect((await call(api.token, "POST", "/api/assistant/capture", texto)).status).toBe(403);
    const r = await call(deskToken, "POST", "/api/assistant/capture", texto);
    expect(r.status).toBe(200);
    const b = await r.json() as any;
    expect(b.capture_id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(b.state).toBe("processada");
    expect(b.result.ok).toBe(true);
    // a origem vem do canal da sessão
    const reg = readFileSync(join(brain.vault.root, ".brain", "captures", `${b.capture_id.slice(0, 4)}-${b.capture_id.slice(4, 6)}.md`), "utf8");
    expect(reg).toContain(`### ${b.capture_id} · processada`);
    expect(reg).toContain("origem: desktop");
    const ui = await (await call(uiToken, "POST", "/api/assistant/capture", { text: "Anotação pela interface web." })).json() as any;
    expect(readFileSync(join(brain.vault.root, ".brain", "captures", `${ui.capture_id.slice(0, 4)}-${ui.capture_id.slice(4, 6)}.md`), "utf8")).toMatch(new RegExp(`${ui.capture_id}[^]*?origem: ui`));
  });

  it("capture sem texto: 400", async () => {
    expect((await call(deskToken, "POST", "/api/assistant/capture", { text: "   " })).status).toBe(400);
    expect((await call(deskToken, "POST", "/api/assistant/capture", {})).status).toBe(400);
  });

  it("undo pela sessão desktop", async () => {
    const c = await (await call(deskToken, "POST", "/api/assistant/capture", { text: "Outro fato sobre o serviço fictício X: usa a porta 9090." })).json() as any;
    expect(c.state).toBe("processada");
    expect((await call(api.token, "POST", `/api/assistant/captures/${c.capture_id}/undo`)).status).toBe(403);
    const r = await call(deskToken, "POST", `/api/assistant/captures/${c.capture_id}/undo`);
    expect(r.status).toBe(200);
    const b = await r.json() as any;
    expect(b.reverted.length).toBeGreaterThanOrEqual(1);
    expect((await call(deskToken, "POST", "/api/assistant/captures/20261110-153012-a1b2/undo")).status).toBe(404);
  });

  it("decidir proposta com sessão desktop dá 403", async () => {
    // quase igual a uma nota existente: sob `additive` não é aplicada pelo agente e fica na fila de revisão
    const p = await brain.propose({ title: "Limite de conexões fictício", type: "fact", body: "O serviço fictício X aceita 250 conexões simultâneas." }, principal("agent", "claude-code", "mcp"));
    expect(p.auto).toBeUndefined();
    const fila = p.id;
    expect((await call(deskToken, "POST", `/api/proposals/${fila}/resolve`, { resolution: "create" })).status).toBe(403);
    expect((await call(deskToken, "POST", "/api/proposals/approve-many", { ids: [fila] })).status).toBe(403);
  });

  it("ask devolve fontes", async () => {
    expect((await call(api.token, "POST", "/api/assistant/ask", { question: "Qual o limite?" })).status).toBe(403);
    const r = await call(deskToken, "POST", "/api/assistant/ask", { question: "Qual o timeout do serviço X?" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, resposta: "O timeout é de 45 segundos.", fontes: [noteId] });
    expect((await call(deskToken, "POST", "/api/assistant/ask", { question: "" })).status).toBe(400);
  });

  it("falha do motor: 200 com resultado tipado, captura pendente; retry reprocessa", async () => {
    deslogado = true;
    const r = await call(deskToken, "POST", "/api/assistant/capture", { text: "Fato guardado enquanto o claude está deslogado." });
    expect(r.status).toBe(200);
    const b = await r.json() as any;
    expect(b.state).toBe("pendente");
    expect(b.result).toMatchObject({ ok: false, tipo: "auth" });
    const lista = await (await call(deskToken, "GET", "/api/assistant/captures?state=pendente")).json() as any[];
    expect(lista.map((e) => e.id)).toContain(b.capture_id);
    expect(lista.find((e) => e.id === b.capture_id)).toMatchObject({ state: "pendente", origin: "desktop", text: "Fato guardado enquanto o claude está deslogado." });
    expect((await call(api.token, "GET", "/api/assistant/captures?state=pendente")).status).toBe(403);
    expect((await call(deskToken, "GET", "/api/assistant/captures?state=processada")).status).toBe(400);
    // desfazer captura ainda pendente: 503 com a mensagem do core
    const u = await call(deskToken, "POST", `/api/assistant/captures/${b.capture_id}/undo`);
    expect(u.status).toBe(503);
    expect((await u.json() as any).message).toMatch(/em processamento/);
    deslogado = false;
    expect((await call(api.token, "POST", "/api/assistant/captures/retry")).status).toBe(403);
    const rt = await (await call(uiToken, "POST", "/api/assistant/captures/retry")).json() as any;
    expect(rt.retried).toBeGreaterThanOrEqual(1);
    expect(await (await call(deskToken, "GET", "/api/assistant/captures?state=pendente")).json()).toEqual([]);
  });

  it("emite SSE notes e proposals depois da captura", async () => {
    const { ticket } = await (await call(uiToken, "POST", "/api/events/ticket")).json() as any;
    const ctl = new AbortController();
    const res = await fetch(`${api.url}/api/events?ticket=${ticket}`, { signal: ctl.signal });
    const reader = res.body!.getReader(); let seen = "";
    const lendo = (async () => { const dec = new TextDecoder(); try { for (;;) { const { value, done } = await reader.read(); if (done) break; seen += dec.decode(value); if (seen.includes("event: notes") && seen.includes("event: proposals")) break; } } catch { /* abortado */ } })();
    await call(deskToken, "POST", "/api/assistant/capture", { text: "Mais um fato do serviço fictício X para o evento." });
    await Promise.race([lendo, new Promise((r) => setTimeout(r, 4000))]);
    ctl.abort();
    expect(seen).toContain("event: notes");
    expect(seen).toContain("event: proposals");
  });

  it("credencial desktop só acessa o assistente e a saúde (allowlist estrita, antes do roteamento)", async () => {
    const barradas: Array<[string, string, unknown?]> = [
      ["POST", "/api/import/preview", { kind: "text", text: "# Titulo, conteudo" }], ["POST", "/api/import/submit", { candidates: [] }],
      ["POST", "/api/reindex"], ["POST", "/api/analyze", { title: "x", type: "fact", body: "y" }], ["GET", "/api/settings"], ["PUT", "/api/settings", {}],
      ["POST", "/api/notes", { title: "x", type: "fact", body: "texto qualquer" }], ["POST", "/api/git/revert", { rev: "HEAD" }],
      ["GET", "/api/notes"], ["POST", "/api/events/ticket"], ["GET", "/api/rota-que-nao-existe"],
    ];
    for (const [m, p, b] of barradas) {
      const r = await call(deskToken, m, p, b);
      expect([m, p, r.status]).toEqual([m, p, 403]);
      expect((await r.json() as any).message).toBe("credencial do desktop só acessa o assistente");
    }
    expect((await call(deskToken, "GET", "/api/health")).status).toBe(200);
    expect((await call(deskToken, "GET", "/api/assistant/captures?state=pendente")).status).toBe(200);
    expect((await call(deskToken, "POST", "/api/assistant/ask", { question: "Qual o limite?" })).status).toBe(200);
    // a sessão ui segue acessando tudo
    for (const [m, p] of [["GET", "/api/settings"], ["GET", "/api/notes"], ["POST", "/api/events/ticket"], ["POST", "/api/reindex"]] as const) expect((await call(uiToken, m, p)).status).toBe(200);
    expect((await call(uiToken, "POST", "/api/import/preview", { kind: "text", text: "# Titulo, conteudo" })).status).toBe(200);
  });

  it("renovação da credencial: só o canal desktop renova; ui e agente recebem 403", async () => {
    const proof = await terminalHuman("alice", sessions());
    const antigo = issueHumanSession(brain.vault.root, proof, { ...sessions(), scope: "desktop", label: "desktop" });
    expect((await call(uiToken, "POST", "/api/assistant/session/renew")).status).toBe(403);
    expect((await call(api.token, "POST", "/api/assistant/session/renew")).status).toBe(403);
    const r = await call(antigo, "POST", "/api/assistant/session/renew");
    expect(r.status).toBe(200);
    const { token } = await r.json() as { token: string };
    expect(token).toMatch(/^hs_[0-9a-f]{64}$/);
    expect((await call(token, "GET", "/api/health")).status).toBe(200);
    expect((await call(token, "GET", "/api/notes")).status).toBe(403); // continua desktop: não promove escopo
    expect((await call(antigo, "GET", "/api/health")).status).toBe(401);
    // a credencial do desktop da suíte continua viva (cota própria de 2)
    expect((await call(deskToken, "GET", "/api/health")).status).toBe(200);
  });

  it("sem assistente configurado: 503 com mensagem clara", async () => {
    const r = await call(deskToken, "POST", "/api/assistant/ask", { question: "Qualquer coisa?" }, () => semAssistente.url);
    expect(r.status).toBe(503);
    expect((await r.json() as any).message).toMatch(/assistente/i);
    // agente continua recebendo 403, não 503
    expect((await call(semAssistente.token, "POST", "/api/assistant/ask", { question: "x" }, () => semAssistente.url)).status).toBe(403);
  });
});
