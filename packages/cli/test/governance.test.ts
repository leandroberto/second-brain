import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Brain, issueHumanSession, principal } from "@brain/core";
import { startApi, type ApiHandle } from "@brain/api";
import { adminCommand, hiddenInput, type AdminIO } from "../src/admin.js";
import { seedDemo } from "../src/seed.js";
import { terminalHuman } from "../../core/test/helpers.js";

/**
 * GOVERNANÇA NO CORE: a mesma decisão (aprovar) por TODOS os adapters disponíveis, com resultado coerente com a IDENTIDADE —
 * nunca com o adapter. Processos reais: servidor MCP stdio (dist), API HTTP, CLI.
 */
const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
let dir: string; let vault: string; let brain: Brain; let api: ApiHandle; let humanToken: string;
const sessions = () => ({ file: join(dir, "ui-sessions.json") });
const clients: Client[] = [];
let human: Awaited<ReturnType<typeof terminalHuman>>;

async function mcp(name: string): Promise<Client> {
  const c = new Client({ name, version: "1.0.0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], env: { ...(process.env as Record<string, string>), BRAIN_VAULT: vault, HOME: dir } }));
  clients.push(c); return c;
}
const tool = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = await c.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
  let data: any; try { data = JSON.parse(r.content[0]!.text); } catch { data = r.content[0]!.text; } return { isError: !!r.isError, data };
};
const http = (tok: string, path: string, body?: unknown, extra: Record<string, string> = {}, method?: string) =>
  fetch(api.url + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
// vocabulário SEM sobreposição entre propostas: cada uma é "new" (nenhum semelhante)
const word = () => Array.from({ length: 3 }, () => "bcdfghjklmnpqrstvz"[Math.floor(Math.random() * 18)] + "aeiou"[Math.floor(Math.random() * 5)]).join("");
const fresh = async (who = principal("agent", "claude-code", "mcp")) => { const w = Array.from({ length: 6 }, word); return (await brain.propose({ title: `Fato ${w[0]} ${w[1]} ${w[2]}`, type: "learning", body: `${w[3]} ${w[4]} ${w[5]} ${word()} ${word()} ${word()}.`, confidence: "high" }, who)).id; };
const state = (id: string) => brain.getProposal(id).state;
/** Terminal interativo simulado SÓ dentro do teste (a CLI real usa o TTY do processo). */
async function withTTY<T>(fn: () => Promise<T>): Promise<T> {
  const prev = [Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), Object.getOwnPropertyDescriptor(process.stdout, "isTTY")];
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true }); Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try { return await fn(); } finally { for (const [i, s] of [process.stdin, process.stdout].entries()) { const d = prev[i]; if (d) Object.defineProperty(s, "isTTY", d); else delete (s as { isTTY?: boolean }).isTTY; } }
}
const io = (answers: string[], out: string[] = []): AdminIO => ({ user: "alice", out: (l) => out.push(l), ask: async () => answers.shift() ?? "", sessions: sessions() });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-gov-"));
  vault = join(dir, "vault");
  brain = await Brain.init(vault);
  api = await startApi(brain, { port: 0, sessions: sessions() });
  human = await terminalHuman("alice", sessions());
  // como `brain ui` num terminal: a sessão humana só nasce do revisor autenticado no terminal
  const out: string[] = [];
  expect(await withTTY(() => adminCommand(brain, ["ui"], { port: api.port }, io([], out)))).toBe(0);
  humanToken = /#token=(hs_[0-9a-f]{64})/.exec(out.join("\n"))![1]!;
});
afterAll(async () => { for (const c of clients) await c.close().catch(() => {}); await api?.close(); brain?.close(); rmSync(dir, { recursive: true, force: true }); });

describe("governança aplicada no Core (bypass por adapter)", () => {
  it("1. Claude via MCP: brain_commit (aprovar) → NEGADO", async () => {
    const id = await fresh();
    const r = await tool(await mcp("claude-code"), "brain_commit", { proposal_id: id, resolution: "create" });
    expect(r.isError).toBe(true); expect(r.data.error).toBe("forbidden");
    expect(state(id)).toBe("pending");
  });

  it("2. Codex via MCP: brain_supersede só PROPÕE; substituir de fato (commit replace / link supersedes / link qualquer) → NEGADO", async () => {
    const old = await brain.createNote({ title: "Fila em Redis para notificações", type: "decision", body: "Notificações usam fila em Redis." }, human);
    const other = await brain.createNote({ title: "Cache de catálogo em memória", type: "decision", body: "O catálogo é cacheado em memória por 60 segundos." }, human);
    const c = await mcp("codex");
    const p = await tool(c, "brain_supersede", { old_id: old.id, title: "Fila em SQLite para notificações", type: "decision", body: "Notificações usam fila no SQLite, sem Redis." });
    expect(p.isError).toBe(false); expect(p.data.proposal_id).toMatch(/^prop-/);
    expect((await tool(c, "brain_commit", { proposal_id: p.data.proposal_id, resolution: "replace", target_id: old.id })).data.error).toBe("forbidden");
    expect((await tool(c, "brain_link", { from: other.id, to: old.id, type: "supersedes" })).data.error).toBe("forbidden");
    // vault com can_link=true (padrão do init) mas commit_policy=never: relação também não é gravada por agente
    expect(brain.config.agents.can_link).toBe(true);
    expect((await tool(c, "brain_link", { from: other.id, to: old.id, type: "related_to" })).data.error).toBe("forbidden");
    await brain.sync({ force: true });
    expect(brain.db.getRow(old.id)?.status).toBe("active");
    expect(brain.loadNote(other.id).relations).toEqual({});
  });

  it("3. Agente via API comum (api-token do vault): aprovar/lote/ignorar/editar nota/config → NEGADO (403)", async () => {
    const id = await fresh();
    expect((await http(api.token, `/api/proposals/${id}/resolve`, { resolution: "create" })).status).toBe(403);
    expect((await http(api.token, "/api/proposals/approve-many", { ids: [id] })).status).toBe(403);
    expect((await http(api.token, "/api/proposals/ignore-many", { ids: [id] })).status).toBe(403);
    expect((await http(api.token, "/api/notes", { title: "Escrita direta de agente", type: "fact", body: "Agente tentando escrever direto." })).status).toBe(403);
    expect((await http(api.token, "/api/settings", { agents: { commit_policy: "all" } }, {}, "PUT")).status).toBe(403);
    expect((await http(api.token, "/api/git/commit", {})).status).toBe(403);
    expect(state(id)).toBe("pending"); expect(brain.config.agents.commit_policy).toBe("never");
  });

  it("4. Agente tentando se passar por humano ou por outro agente → NEGADO", async () => {
    const id = await fresh();
    expect((await http(api.token, `/api/proposals/${id}/resolve`, { resolution: "create", actor: { kind: "human", name: "alice" }, decided_by: "human" }, { "x-brain-actor": "human", "x-brain-agent": "human" })).status).toBe(403);
    const meta = await (await http(api.token, "/api/meta")).json() as any;
    expect(meta.principal).toEqual({ kind: "agent", name: "api-client", channel: "api" }); expect(meta.can_review).toBe(false);
    // cabeçalho com o nome de outro agente não dá a autoria dele (não corrige a proposta do claude-code)
    const r = await http(api.token, `/api/proposals/${id}`, { title: "Título trocado por impostor" }, { "x-brain-agent": "claude-code" }, "PATCH");
    expect(r.status).toBe(403);
    // no Core: objeto literal "humano", fábrica pública com kind humano e emissão de sessão sem prova → negados
    await expect(brain.resolve(id, { resolution: "create" }, { kind: "human", name: "alice", channel: "ui" } as never)).rejects.toMatchObject({ code: "forbidden" });
    expect(() => principal("human" as never, "alice", "ui")).toThrow(/identidade humana/);
    expect(() => principal("agent", "x", "ui")).toThrow(/identidade humana/);
    expect(() => issueHumanSession(vault, principal("agent", "claude-code", "mcp"), sessions())).toThrow(/terminal/);
    expect(state(id)).toBe("pending");
  });

  it("5. UI humana (sessão emitida por `brain ui` no terminal): aprovar → PERMITIDO; SSE só com ticket", async () => {
    const id = await fresh();
    const meta = await (await http(humanToken, "/api/meta")).json() as any;
    expect(meta.can_review).toBe(true); expect(meta.principal.channel).toBe("ui");
    expect((await http(humanToken, `/api/proposals/${id}/resolve`, { resolution: "create" })).status).toBe(200);
    expect(state(id)).toBe("accepted");
    // a sessão nunca vai na URL: /api/events aceita só ticket curto e de uso único
    expect((await fetch(`${api.url}/api/events?token=${humanToken}`)).status).toBe(401);
    const { ticket } = await (await http(humanToken, "/api/events/ticket", {})).json() as { ticket: string };
    const ctl = new AbortController(); const ev = await fetch(`${api.url}/api/events?ticket=${ticket}`, { signal: ctl.signal });
    expect(ev.status).toBe(200); ctl.abort();
    expect((await fetch(`${api.url}/api/events?ticket=${ticket}`)).status).toBe(401); // uso único
  });

  it("6. CLI administrativa: sem terminal → NEGADO (processo real); com terminal + confirmação → PERMITIDO", async () => {
    const id = await fresh();
    await expect(run(process.execPath, [BIN, "admin", "approve", id, "--vault", vault], { env: { ...process.env, HOME: dir } })).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/terminal interativo/) });
    await expect(run(process.execPath, [BIN, "ui", "--vault", vault], { env: { ...process.env, HOME: dir } })).rejects.toMatchObject({ code: 1 });
    await expect(run(process.execPath, [BIN, "integrate", "--apply", "--vault", vault], { env: { ...process.env, HOME: dir } })).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/terminal interativo/) });
    await expect(adminCommand(brain, ["approve", id], {}, io(["sim"]))).rejects.toMatchObject({ code: "forbidden" }); // sem TTY, mesmo com "sim"
    expect(state(id)).toBe("pending");
    expect(await withTTY(() => adminCommand(brain, ["approve", id], {}, io(["não"])))).toBe(1); // sem confirmar: cancelado
    expect(state(id)).toBe("pending");
    expect(await withTTY(() => adminCommand(brain, ["approve", id], {}, io(["sim"])))).toBe(0);
    expect(state(id)).toBe("accepted");
    const [c] = await brain.git.log(undefined, 1);
    expect((await run("git", ["-C", vault, "show", "-s", "--format=%B", c!.hash])).stdout).toContain("Brain-Channel: cli-admin");
  });

  it("6b. frase-senha do revisor (quando definida) é exigida pela CLI administrativa e pela emissão de sessão", async () => {
    expect(await withTTY(() => adminCommand(brain, ["passphrase"], {}, io(["frase-segura-1", "frase-segura-1"])))).toBe(0);
    const id = await fresh();
    await expect(withTTY(() => adminCommand(brain, ["approve", id], {}, io(["errada", "sim"])))).rejects.toMatchObject({ code: "forbidden" });
    await expect(withTTY(() => adminCommand(brain, ["ui"], {}, io(["errada"])))).rejects.toMatchObject({ code: "forbidden" });
    expect(state(id)).toBe("pending");
    expect(await withTTY(() => adminCommand(brain, ["approve", id], {}, io(["frase-segura-1", "sim"])))).toBe(0);
    expect(state(id)).toBe("accepted");
    // o vault passa a EXIGIR a frase-senha: apontar outro armazenamento/HOME (sem frase-senha) não cai para "só terminal"
    brain.config = (await import("@brain/core")).loadConfig(join(vault, ".brain", "config.yaml"));
    expect(brain.config.review.passphrase_required).toBe(true);
    const id2 = await fresh();
    const elsewhere: AdminIO = { ...io(["sim"]), sessions: { file: join(dir, "outro-home", "ui-sessions.json") } };
    await expect(withTTY(() => adminCommand(brain, ["approve", id2], {}, elsewhere))).rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/exige a frase-senha/) });
    expect(state(id2)).toBe("pending");
  });

  it("6c. trocar a frase-senha: curta ou repetida diferente não altera nada; a atual continua valendo", async () => {
    expect(await withTTY(() => adminCommand(brain, ["passphrase"], {}, io(["frase-segura-1", "curta"])))).toBe(1);
    expect(await withTTY(() => adminCommand(brain, ["passphrase"], {}, io(["frase-segura-1", "frase-nova-123", "frase-nova-124"])))).toBe(1);
    const id = await fresh();
    expect(await withTTY(() => adminCommand(brain, ["approve", id], {}, io(["frase-segura-1", "sim"])))).toBe(0);
    expect(state(id)).toBe("accepted");
  });

  it("6d. entrada oculta: frase colada com Enter no mesmo bloco não leva o Enter; backspace, setas e Ctrl+C", () => {
    expect(hiddenInput("", "frase-colada\r")).toEqual({ buf: "frase-colada", done: true });
    expect(hiddenInput("", "frase-colada\r\n")).toEqual({ buf: "frase-colada", done: true });
    let st = hiddenInput("", "fras"); st = hiddenInput(st.buf, "ee\u007f"); st = hiddenInput(st.buf, "\u001b[D-1\n");
    expect(st).toEqual({ buf: "frase-1", done: true });
    expect(hiddenInput("abc", "\u0003").abort).toBe(true);
    // casos de borda (revisão independente): SS3, ESC cortado entre blocos, emoji no backspace, C1
    expect(hiddenInput("", "ab\u001bOAc\r")).toEqual({ buf: "abc", done: true });
    const cut = hiddenInput("", "ab\u001b");
    expect(cut).toEqual({ buf: "ab", pending: "\u001b" });
    expect(hiddenInput(cut.buf, "[Dc\r", cut.pending)).toEqual({ buf: "abc", done: true });
    expect(hiddenInput("", "a😀\u007f\r")).toEqual({ buf: "a", done: true });
    expect(hiddenInput("", "a\u0085b\u009bc\r")).toEqual({ buf: "abc", done: true });
  });

  it("7. Core chamado direto sem identidade (ou com identidade de agente): toda operação mutativa → NEGADO", async () => {
    const id = await fresh(); const note = await brain.createNote({ title: "Nota alvo de teste", type: "fact", body: "Alvo para operações mutativas." }, human);
    const note2 = await brain.createNote({ title: "Segunda nota alvo", type: "fact", body: "Outro alvo para relações." }, human);
    const anon = undefined as never; const agent = principal("agent", "claude-code", "mcp");
    for (const who of [anon, agent]) for (const op of [
      () => brain.resolve(id, { resolution: "create" }, who),
      () => brain.approveMany([id], who),
      () => brain.ignoreMany([id], undefined, who),
      () => brain.createNote({ title: "Nota sem dono", type: "fact", body: "Escrita sem identidade." }, who),
      () => brain.createProject("proj-x", "Proj X", "x", who),
      () => brain.updateNote(note.id, { title: "Trocado", expected_revision: note.revision }, who),
      () => brain.link(note.id, note2.id, "related_to", who),
      () => brain.updateConfig({ agents: { commit_policy: "all" } }, who),
      () => brain.commitPending(undefined, who),
      () => brain.revertCommit("HEAD", who),
      () => brain.attachFreshness([{ id, freshness: { state: "current" } as never }], who),
    ]) await expect(op()).rejects.toMatchObject({ code: "forbidden" });
    await expect(brain.propose({ title: "Proposta sem dono", type: "fact", body: "Proposta sem identidade alguma." }, anon)).rejects.toMatchObject({ code: "forbidden" });
    await expect(brain.editProposal(id, { title: "Título trocado sem identidade" }, anon)).rejects.toMatchObject({ code: "forbidden" });
    await expect(brain.commitExternalEdits()).rejects.toMatchObject({ code: "forbidden" }); // auto_commit_external desligado
    expect(state(id)).toBe("pending"); expect(brain.config.agents.commit_policy).toBe("never");
  });

  it("8. PROPOR continua funcionando para agentes (MCP e API); agente corrige só a PRÓPRIA proposta", async () => {
    const c = await mcp("claude-code");
    const p = await tool(c, "brain_propose", { title: "Capivaras nadam bem em água doce", type: "fact", body: "Capivaras são excelentes nadadoras em rios e lagos." });
    expect(p.isError).toBe(false);
    const viaApi = await http(api.token, "/api/proposals", { title: "Tamanduás comem formigas e cupins", type: "fact", body: "Tamanduás se alimentam sobretudo de formigas e cupins.", freshness: { state: "current" }, maintenance: { kind: "revalidate", reason: "x" } });
    expect(viaApi.status).toBe(200);
    const apiProp = await viaApi.json() as any;
    expect(apiProp.proposed_by).toEqual({ kind: "agent", name: "api-client" }); expect(apiProp.freshness).toBeUndefined(); expect(apiProp.maintenance).toBeUndefined();
    const own = await tool(c, "brain_amend", { proposal_id: p.data.proposal_id, title: "Capivaras nadam bem e mergulham para fugir", temporal: { as_of: "2026-10-14", revalidate_when: "novo estudo de campo" } });
    expect(own.isError).toBe(false); expect(own.data.temporal.as_of).toBe("2026-10-14");
    expect((await tool(await mcp("codex"), "brain_amend", { proposal_id: p.data.proposal_id, title: "Título trocado por outro agente" })).data.error).toBe("forbidden");
    expect(brain.getProposal(p.data.proposal_id).draft.title).toBe("Capivaras nadam bem e mergulham para fugir");
  });

  it("política opcional por tipo vale igual em MCP e API; lote, final_body e atualização continuam humanos", async () => {
    await brain.updateConfig({ agents: { commit_policy: "all", per_type: { learning: "auto" } } }, human);
    try {
      const a = await fresh(); const b = await fresh();
      expect((await tool(await mcp("claude-code"), "brain_commit", { proposal_id: a, resolution: "create" })).data).toMatchObject({ state: "accepted" });
      expect((await http(api.token, `/api/proposals/${b}/resolve`, { resolution: "create" })).status).toBe(200);
      expect((await http(api.token, "/api/proposals/approve-many", { ids: [await fresh()] })).status).toBe(403);
      // corpo final escrito à mão é exclusivo do revisor (senão um "complemento" reescreveria a nota inteira)
      const t = await brain.createNote({ title: "Alvo de complemento", type: "learning", body: "Texto original do alvo." }, human);
      const comp = await brain.propose({ title: "Alvo de complemento", type: "learning", body: "Mais um detalhe sobre o alvo original.", intent: "complement", target_id: t.id }, principal("agent", "claude-code", "mcp"));
      expect((await tool(await mcp("claude-code"), "brain_commit", { proposal_id: comp.id, resolution: "complement", target_id: t.id, final_body: "APAGADO" })).data.error).toBe("forbidden");
      expect((await tool(await mcp("claude-code"), "brain_commit", { proposal_id: comp.id, resolution: "update", target_id: t.id })).data.error).toBe("forbidden");
    } finally { await brain.updateConfig({ agents: { commit_policy: "never", per_type: { learning: "review" } } }, human); }
  });

  it("seed nunca apaga um vault que não seja DEMO; o canal seed não escreve fora de vault DEMO", async () => {
    const real = join(dir, "vault-real"); mkdirSync(real, { recursive: true }); writeFileSync(join(real, "nota.md"), "dado real");
    await expect(seedDemo(real, {})).rejects.toThrow(/não é um vault DEMO/);
    await expect(brain.createNote({ title: "Escrita do seed no vault real", type: "fact", body: "Não deveria acontecer." }, (await import("@brain/core")).seedPrincipal())).rejects.toMatchObject({ code: "forbidden" });
    const n = await brain.createNote({ title: "Nota real que o seed não pode editar", type: "fact", body: "Conteúdo real." }, human);
    await expect(brain.updateNote(n.id, { body: "sobrescrito", expected_revision: n.revision }, (await import("@brain/core")).seedPrincipal())).rejects.toMatchObject({ code: "forbidden" });
  });
});
