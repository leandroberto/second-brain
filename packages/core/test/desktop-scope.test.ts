import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@brain/shared";
import { afterAll, describe, expect, it } from "vitest";
import {
  Assistant, Brain, authorize, createClaudeEngine, humanFromSession, issueHumanSession, principal, renewDesktopSession, revokeHumanSessions, sessionScope,
  type ExecutorClaude, type SaidaProcesso,
} from "../src/index.js";
import { claude, cleanup, human, tempBrain } from "./helpers.js";

afterAll(cleanup);

/** Comando fictício do MCP (o adapter informa o real). */
const MCP = { command: "/usr/bin/node-ficticio", args: ["/opt/brain-ficticio/bin.js", "mcp"] };
const sessionsFile = () => join(tmpdir(), `brain-test-desktop-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

async function additiveBrain(): Promise<Brain> {
  const b = await tempBrain();
  await b.updateConfig({ agents: { commit_policy: "additive" } }, human);
  return b;
}

/** Cunha o principal do desktop como a API faz: sessão com escopo desktop emitida pelo revisor, apresentada a `humanFromSession`. */
function desktopOf(b: Brain): Principal {
  const file = sessionsFile();
  const token = issueHumanSession(b.vault.root, human, { file, scope: "desktop" });
  return humanFromSession(b.vault.root, token, "alice", { file })!;
}

const saidaOk = (estruturado: unknown): SaidaProcesso => ({
  codigo: 0, estourouTempo: false, stderr: "",
  stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(estruturado), structured_output: estruturado, subagent_stats: { refused: { budget: 0 } } }),
});
const semNotas = { notas: [], segredo_omitido: false, texto_mascarado: null };
const agenteDe = (args: string[]) => {
  const cfg = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1]!, "utf8")) as { mcpServers: Record<string, { env: Record<string, string> }> };
  return cfg.mcpServers["second-brain"]!.env.BRAIN_AGENT_NAME!;
};

/** Executor falso que simula o MCP filho: o agente `assistant/<id>` propõe cada nota pelo core (sob additive, grava direto). */
function execQuePropoe(b: Brain, notas: Array<{ titulo: string; corpo: string }>): ExecutorClaude {
  return async (_exe, args) => {
    const quem = principal("agent", agenteDe(args), "mcp");
    const out: Array<{ id: string; acao: "criada" | "na_fila" }> = [];
    for (const n of notas) {
      const p = await b.propose({ title: n.titulo, type: "learning", body: n.corpo }, quem);
      out.push(p.auto?.note_id ? { id: p.auto.note_id, acao: "criada" } : { id: p.id, acao: "na_fila" });
    }
    return saidaOk({ notas: out, segredo_omitido: false, texto_mascarado: null });
  };
}

const git = (b: Brain, ...args: string[]) => execFileSync("git", ["-C", b.vault.root, ...args], { encoding: "utf8" });

describe("sessão com escopo desktop", () => {
  it("sessão desktop não decide nem reverte", async () => {
    const b = await tempBrain();
    const desk = desktopOf(b);
    expect(desk).toMatchObject({ kind: "human", name: "alice", channel: "desktop" });
    // proposta pendente (política padrão never): só o revisor decide
    const p = await b.propose({ title: "Regra de backup demo", type: "fact", body: "O backup do ambiente demo roda toda noite." }, claude);
    await expect(b.resolve(p.id, { resolution: "create" }, desk)).rejects.toMatchObject({ code: "forbidden" });
    const head = git(b, "rev-parse", "--short", "HEAD").trim();
    await expect(b.revertCommit(head, desk)).rejects.toMatchObject({ code: "forbidden" });
    await expect(b.updateConfig({ agents: { commit_policy: "additive" } }, desk)).rejects.toMatchObject({ code: "forbidden" });
    await expect(b.approveMany([p.id], desk)).rejects.toMatchObject({ code: "forbidden" });
    await expect(b.createNote({ title: "Nota direta", type: "fact", body: "Escrita direta não é do desktop." }, desk)).rejects.toMatchObject({ code: "forbidden" });
    // anotar (propor) e assistir continuam permitidos
    await expect(b.propose({ title: "Anotação do atalho", type: "learning", body: "O atalho desktop só propõe." }, desk)).resolves.toBeTruthy();
    expect(authorize(desk, "assist", { config: b.config })).toBe(desk);
    expect(authorize(human, "assist", { config: b.config })).toBe(human);
    expect(() => authorize(claude, "assist", { config: b.config })).toThrow(/assist|desktop|revisor/);
    expect(() => authorize(principal("system", "import", "importer"), "assist", { config: b.config })).toThrow();
    // o canal desktop nunca nasce de principal(): só de uma sessão com escopo desktop
    expect(() => principal("agent", "falso", "desktop")).toThrow(/identidade humana|sessão/);
    expect(() => principal("system", "falso", "desktop")).toThrow(/identidade humana|sessão/);
    // a credencial do desktop não revoga as sessões do revisor
    expect(() => revokeHumanSessions(b.vault.root, desk, { file: sessionsFile() })).toThrow(/revisor/);
  });

  it("sessão desktop desfaz a própria captura", async () => {
    const b = await additiveBrain();
    const desk = desktopOf(b);
    const asst = new Assistant(b, createClaudeEngine(b, execQuePropoe(b, [{ titulo: "Ordem de parada do consumidor", corpo: "O consumidor da fila demo é parado antes do produtor." }]), MCP));
    const r = await asst.capture("O consumidor da fila demo é parado antes do produtor.", "desktop");
    const noteId = r.result.ok ? r.result.notas[0]!.id : "";
    expect(b.loadNote(noteId).title).toBe("Ordem de parada do consumidor");
    const sujo = git(b, "status", "--porcelain"); // updateConfig não commita o config.yaml (comportamento existente)
    const out = await b.undoCapture(r.capture.id, desk);
    expect(out.reverted).toHaveLength(1);
    expect(() => b.loadNote(noteId)).toThrow();
    expect(asst.captures.get(r.capture.id)?.state).toBe("desfeita");
    expect(git(b, "status", "--porcelain")).toBe(sujo);
    expect(git(b, "log", "-1", "--format=%s")).toContain("desfeita");
    // desfazer de novo não faz nada (e não falha)
    await expect(b.undoCapture(r.capture.id, desk)).resolves.toEqual({ reverted: [] });
  });

  it("desfaz todos os commits da captura, do mais novo para o mais antigo, e ignora agente com nome parecido", async () => {
    const b = await additiveBrain();
    const desk = desktopOf(b);
    const asst = new Assistant(b, createClaudeEngine(b, execQuePropoe(b, [
      { titulo: "Janela de manutenção demo", corpo: "A janela de manutenção do ambiente demo é às quartas, das 20h às 22h." },
      { titulo: "Responsável pelo deploy demo", corpo: "Quem aprova o deploy do ambiente demo é o time de plataforma fictício." },
    ]), MCP));
    const r = await asst.capture("Duas anotações sobre o ambiente demo.", "desktop");
    const ids = r.result.ok ? r.result.notas.map((n) => n.id) : [];
    expect(ids).toHaveLength(2);
    // outro agente cujo nome contém o da captura: o trailer dele não é exatamente o da captura
    const impostor = principal("agent", `assistant/${r.capture.id}-x`, "mcp");
    const outra = await b.propose({ title: "Nota de outro agente", type: "learning", body: "Zebras listradas confundem moscas hematófagas." }, impostor);
    const out = await b.undoCapture(r.capture.id, desk);
    expect(out.reverted).toHaveLength(2);
    for (const id of ids) expect(() => b.loadNote(id)).toThrow();
    expect(b.loadNote(outra.auto!.note_id!).title).toBe("Nota de outro agente");
  });

  for (const sentido of ["nova->antiga", "antiga->nova"] as const) {
    it(`desfaz também o brain_link do agente da captura (${sentido}): notas e relações voltam, sem link pendurado`, async () => {
      const b = await additiveBrain();
      const desk = desktopOf(b);
      const antiga = await b.createNote({ title: "Servidor de filas do ambiente demo", type: "fact", body: "O servidor de filas do ambiente demo usa a porta padrão do broker." }, human);
      const antes = b.loadNote(antiga.id);
      // o prompt de captura manda relacionar a nota nova a uma existente com brain_link
      const exec: ExecutorClaude = async (_exe, args) => {
        const quem = principal("agent", agenteDe(args), "mcp");
        const p = await b.propose({ title: "Regra de arredondamento de juros compostos", type: "fact", body: "Juros compostos mensais são arredondados para baixo na segunda casa decimal." }, quem);
        const nova = p.auto!.note_id!;
        if (sentido === "nova->antiga") await b.link(nova, antiga.id, "related_to", quem); else await b.link(antiga.id, nova, "related_to", quem);
        return saidaOk({ notas: [{ id: nova, acao: "criada" }], segredo_omitido: false, texto_mascarado: null });
      };
      const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
      const r = await asst.capture("Anotar a regra de arredondamento de juros compostos mensais.", "desktop");
      const nova = r.result.ok ? r.result.notas[0]!.id : "";
      expect(git(b, "log", "--format=%an|%s")).toMatch(new RegExp(`^assistant/${r.capture.id}\\|brain: link `, "m"));
      const out = await b.undoCapture(r.capture.id, desk);
      expect(out.reverted).toHaveLength(2);
      expect(() => b.loadNote(nova)).toThrow();
      const depois = b.loadNote(antiga.id);
      expect(depois.relations).toEqual(antes.relations);
      expect(depois.revision).toBe(antes.revision);
      const h = await b.health();
      expect(h.problems.dangling_links).toBe(0);
      expect(asst.captures.get(r.capture.id)?.state).toBe("desfeita");
    });
  }

  it("commit de link de outro agente ou com Brain-Actor forjado fora do bloco final não é revertido", async () => {
    const b = await additiveBrain();
    const desk = desktopOf(b);
    const asst = new Assistant(b, createClaudeEngine(b, execQuePropoe(b, [{ titulo: "Limite de conexões demo", corpo: "O banco demo aceita no máximo cem conexões simultâneas." }]), MCP));
    const r = await asst.capture("O banco demo aceita no máximo cem conexões simultâneas.", "desktop");
    const nova = r.result.ok ? r.result.notas[0]!.id : "";
    // autor certo, mas o Brain-Actor do agente está fora do bloco final; e autor errado com o trailer certo
    const forja = (arquivo: string, autor: string, msg: string) => {
      writeFileSync(join(b.vault.root, "knowledge", arquivo), `conteúdo de ${arquivo}\n`);
      git(b, "add", "--", `knowledge/${arquivo}`);
      git(b, "-c", "user.name=Second Brain", "-c", "user.email=brain@localhost", "commit", "-q", "--author", autor, "-m", msg);
    };
    forja("forjado-link-a.md", `assistant/${r.capture.id} <x@agents.local>`, `brain: link a related_to b\n\nBrain-Actor: agent/assistant/${r.capture.id}\n\nBrain-Actor: human/alice`);
    forja("forjado-link-b.md", "Second Brain <brain@localhost>", `brain: link a related_to b\n\nBrain-Actor: agent/assistant/${r.capture.id}`);
    const out = await b.undoCapture(r.capture.id, desk);
    expect(out.reverted).toHaveLength(1);
    expect(() => b.loadNote(nova)).toThrow();
    for (const f of ["forjado-link-a.md", "forjado-link-b.md"]) expect(existsSync(join(b.vault.root, "knowledge", f))).toBe(true);
  });

  it("link de outro agente (nome que estende o da captura) sobre a nota nova não é da captura: o undo conflita e nada muda", async () => {
    const b = await additiveBrain();
    const desk = desktopOf(b);
    const asst = new Assistant(b, createClaudeEngine(b, execQuePropoe(b, [{ titulo: "Limite de conexões demo", corpo: "O banco demo aceita no máximo cem conexões simultâneas." }]), MCP));
    const r = await asst.capture("O banco demo aceita no máximo cem conexões simultâneas.", "desktop");
    const nova = r.result.ok ? r.result.notas[0]!.id : "";
    const outraNota = await b.createNote({ title: "Pool de conexões demo", type: "fact", body: "O pool de conexões demo fica no serviço de aplicação." }, human);
    const impostor = principal("agent", `assistant/${r.capture.id}-x`, "mcp");
    await b.link(nova, outraNota.id, "related_to", impostor);
    await expect(b.undoCapture(r.capture.id, desk)).rejects.toMatchObject({ code: "conflict_revision" });
    expect(b.loadNote(nova).relations.related_to).toEqual([outraNota.id]);
    expect(asst.captures.get(r.capture.id)?.state).toBe("processada");
  });

  it("sessão desktop não desfaz captura da UI; o revisor desfaz", async () => {
    const b = await additiveBrain();
    const desk = desktopOf(b);
    const asst = new Assistant(b, createClaudeEngine(b, execQuePropoe(b, [{ titulo: "Fechamento do relatório demo", corpo: "O relatório mensal demo fecha no quinto dia útil." }]), MCP));
    const r = await asst.capture("O relatório mensal demo fecha no quinto dia útil.", "ui");
    const noteId = r.result.ok ? r.result.notas[0]!.id : "";
    await expect(b.undoCapture(r.capture.id, desk)).rejects.toMatchObject({ code: "forbidden" });
    expect(b.loadNote(noteId).title).toBe("Fechamento do relatório demo");
    expect(asst.captures.get(r.capture.id)?.state).toBe("processada");
    // agente nunca desfaz
    await expect(b.undoCapture(r.capture.id, claude)).rejects.toMatchObject({ code: "forbidden" });
    // o revisor humano desfaz qualquer captura
    await expect(b.undoCapture(r.capture.id, human)).resolves.toMatchObject({ reverted: [expect.any(String)] });
    expect(() => b.loadNote(noteId)).toThrow();
    expect(asst.captures.get(r.capture.id)?.state).toBe("desfeita");
  });

  it("captura inexistente: not_found", async () => {
    const b = await tempBrain();
    await expect(b.undoCapture("20261110-153012-a1b2", desktopOf(b))).rejects.toMatchObject({ code: "not_found" });
    await expect(b.undoCapture("../../x", desktopOf(b))).rejects.toMatchObject({ code: "not_found" });
  });

  it("captura sem commits (nada gravado ou tudo na fila) volta vazio, marca desfeita e mantém a proposta pendente", async () => {
    const b = await tempBrain(); // política never: a proposta do assistente vai para a fila
    const desk = desktopOf(b);
    const asst = new Assistant(b, createClaudeEngine(b, execQuePropoe(b, [{ titulo: "Proposta que fica na fila", corpo: "Esta proposta do assistente aguarda o revisor." }]), MCP));
    const r = await asst.capture("Esta proposta do assistente aguarda o revisor.", "desktop");
    expect(b.listProposals("pending")).toHaveLength(1);
    await expect(b.undoCapture(r.capture.id, desk)).resolves.toEqual({ reverted: [] });
    expect(asst.captures.get(r.capture.id)?.state).toBe("desfeita");
    expect(b.listProposals("pending")).toHaveLength(1);
    const vazia = await new Assistant(b, createClaudeEngine(b, async () => saidaOk(semNotas), MCP)).capture("Nada para organizar aqui.", "desktop");
    await expect(b.undoCapture(vazia.capture.id, desk)).resolves.toEqual({ reverted: [] });
    expect(asst.captures.get(vazia.capture.id)?.state).toBe("desfeita");
  });

  it("nota alterada depois da captura: aborta o revert, árvore limpa, captura não é desfeita", async () => {
    const b = await additiveBrain();
    const desk = desktopOf(b);
    const asst = new Assistant(b, createClaudeEngine(b, execQuePropoe(b, [
      { titulo: "Porta do serviço demo", corpo: "O serviço demo escuta na porta 8080 do ambiente de testes." },
      { titulo: "Cache do serviço demo", corpo: "O cache do serviço demo expira a cada cinco minutos." },
    ]), MCP));
    const r = await asst.capture("Duas anotações sobre o serviço demo.", "desktop");
    const [antiga, nova] = r.result.ok ? r.result.notas.map((n) => n.id) : [];
    // o revisor edita a nota MAIS ANTIGA: o revert da mais nova passaria, o da antiga conflita, e nada pode ficar pela metade
    const n = b.loadNote(antiga!);
    await b.updateNote(antiga!, { body: `${n.body}\n\nAtualizado pelo revisor depois da captura.`, expected_revision: n.revision }, human);
    const head = git(b, "rev-parse", "HEAD").trim();
    const sujo = git(b, "status", "--porcelain"); // updateConfig não commita o config.yaml (comportamento existente)
    await expect(b.undoCapture(r.capture.id, desk)).rejects.toMatchObject({ code: "conflict_revision", message: expect.stringMatching(new RegExp(`a nota .*${antiga}.* foi alterada depois; desfaça pela revisão`)) });
    expect(git(b, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(b, "status", "--porcelain")).toBe(sujo);
    expect(existsSync(join(git(b, "rev-parse", "--absolute-git-dir").trim(), "REVERT_HEAD"))).toBe(false);
    expect(existsSync(join(git(b, "rev-parse", "--absolute-git-dir").trim(), "sequencer"))).toBe(false);
    expect(b.loadNote(antiga!).body).toContain("Atualizado pelo revisor");
    expect(b.loadNote(nova!).title).toBe("Cache do serviço demo");
    expect(asst.captures.get(r.capture.id)?.state).toBe("processada");
  });

  it("linha do trailer injetada no título ou na nota de uma decisão humana não é revertida pelo undo", async () => {
    const b = await additiveBrain();
    await b.updateConfig({ agents: { per_type: { fact: "review" } } }, human); // fatos do agente vão para a fila do revisor
    const desk = desktopOf(b);
    const asst = new Assistant(b, createClaudeEngine(b, execQuePropoe(b, [{ titulo: "Rotação de logs demo", corpo: "Os logs do ambiente demo giram a cada sete dias." }]), MCP));
    const r = await asst.capture("Os logs do ambiente demo giram a cada sete dias.", "desktop");
    const legit = r.result.ok ? r.result.notas[0]!.id : "";
    const linha = `Brain-Decided-By: agent/assistant/${r.capture.id}`;
    // 1) título com a linha injetada, aprovado pelo revisor
    const p1 = await b.propose({ title: `Título injetado\n${linha}\nfim`, type: "fact", body: "O ambiente demo tem três réplicas de leitura." }, claude);
    const n1 = (await b.resolve(p1.id, { resolution: "create" }, human)).note!;
    // 2) nota da decisão (Brain-Note) com a linha injetada
    const p2 = await b.propose({ title: "Fila de reprocessamento demo", type: "fact", body: "A fila de reprocessamento demo guarda mensagens por dois dias." }, claude);
    const n2 = (await b.resolve(p2.id, { resolution: "create", note: `ok\n\n${linha}` }, human)).note!;
    // 3) nota do ignore em lote com a linha injetada
    const p3 = await b.propose({ title: "Ruído sobre cores do painel demo", type: "fact", body: "O painel demo usa tons de verde nos gráficos." }, claude);
    await b.ignoreMany([p3.id], `ruído\n\n${linha}`, human);
    // nenhuma mensagem de commit carrega a quebra de linha injetada
    const msgs = git(b, "log", "--format=%B%x1e").split("\x1e");
    expect(msgs.filter((m) => m.split("\n").some((l) => l.trim() === linha))).toHaveLength(1);
    const out = await b.undoCapture(r.capture.id, desk);
    expect(out.reverted).toHaveLength(1);
    expect(() => b.loadNote(legit)).toThrow();
    expect(b.loadNote(n1.id).body).toContain("três réplicas");
    expect(b.loadNote(n2.id).body).toContain("dois dias");
    expect(b.getProposal(p3.id).state).toBe("ignored");
  });

  it("commit forjado à mão: autor diferente ou trailer fora do bloco final não casa", async () => {
    const b = await additiveBrain();
    const desk = desktopOf(b);
    const asst = new Assistant(b, createClaudeEngine(b, execQuePropoe(b, [{ titulo: "Horário do backup demo", corpo: "O backup do ambiente demo começa às 3h." }]), MCP));
    const r = await asst.capture("O backup do ambiente demo começa às 3h.", "desktop");
    const linha = `Brain-Decided-By: agent/assistant/${r.capture.id}`;
    const forja = (arquivo: string, autor: string, msg: string) => {
      writeFileSync(join(b.vault.root, "knowledge", arquivo), `conteúdo de ${arquivo}\n`);
      git(b, "add", "--", `knowledge/${arquivo}`);
      git(b, "-c", "user.name=Second Brain", "-c", "user.email=brain@localhost", "commit", "-q", "--author", autor, "-m", msg);
    };
    // (a) trailer genuíno no bloco final, mas o autor não é o agente da captura
    forja("forjado-a.md", "Second Brain <brain@localhost>", `brain: add fact "a"\n\n${linha}\nBrain-Channel: mcp`);
    // (b) autor certo, mas o primeiro Brain-Decided-By do bloco final é outro
    forja("forjado-b.md", `assistant/${r.capture.id} <x@agents.local>`, `brain: add fact "b"\n\nBrain-Decided-By: human/alice\n${linha}`);
    // (b) autor certo, linha fora do bloco final de trailers
    forja("forjado-c.md", `assistant/${r.capture.id} <x@agents.local>`, `brain: add fact "c"\n\n${linha}\n\nBrain-Decided-By: human/alice`);
    const out = await b.undoCapture(r.capture.id, desk);
    expect(out.reverted).toHaveLength(1);
    for (const f of ["forjado-a.md", "forjado-b.md", "forjado-c.md"]) expect(existsSync(join(b.vault.root, "knowledge", f))).toBe(true);
  });

  it("undo de captura pendente é recusado (ainda em processamento)", async () => {
    const b = await additiveBrain();
    const desk = desktopOf(b);
    const asst = new Assistant(b, createClaudeEngine(b, async () => saidaOk(semNotas), MCP));
    const e = await asst.captures.append("Captura que ainda não foi processada.", "desktop");
    await expect(b.undoCapture(e.id, desk)).rejects.toMatchObject({ code: "locked", message: expect.stringMatching(/em processamento/) });
    expect(asst.captures.get(e.id)?.state).toBe("pendente");
  });

  it("o motor não sobrescreve uma captura desfeita durante o processamento", async () => {
    const b = await additiveBrain();
    const exec: ExecutorClaude = async (_exe, args) => {
      const id = agenteDe(args).replace(/^assistant\//, "");
      await asst.captures.mark(id, "desfeita"); // outra via marcou enquanto o motor rodava (o lock não é segurado durante o motor)
      return saidaOk(semNotas);
    };
    const asst = new Assistant(b, createClaudeEngine(b, exec, MCP));
    const r = await asst.capture("Texto que vai ser desfeito no meio do caminho.", "desktop");
    expect(r.result.ok).toBe(true);
    expect(r.capture.state).toBe("desfeita");
    expect(asst.captures.get(r.capture.id)?.state).toBe("desfeita");
  });

  it("sessões desktop têm cota própria (2 vivas por vault) e não contam no limite das full", async () => {
    const b = await tempBrain();
    const file = sessionsFile();
    const desk = [1, 2, 3].map(() => issueHumanSession(b.vault.root, human, { file, scope: "desktop" }));
    // a terceira despeja a desktop mais antiga
    expect(desk.map((t) => sessionScope(b.vault.root, t, { file }))).toEqual([undefined, "desktop", "desktop"]);
    // 12 sessões full: só as 10 mais novas vivem, e nenhuma desktop é despejada
    const full = Array.from({ length: 12 }, () => issueHumanSession(b.vault.root, human, { file }));
    expect(full.map((t) => sessionScope(b.vault.root, t, { file }))).toEqual([undefined, undefined, ...Array(10).fill("full")]);
    expect(desk.slice(1).map((t) => sessionScope(b.vault.root, t, { file }))).toEqual(["desktop", "desktop"]);
  });

  it("renewDesktopSession renova a credencial desktop viva, revoga a antiga e recusa full, expirada ou desconhecida", async () => {
    const b = await tempBrain();
    const file = sessionsFile();
    const antigo = issueHumanSession(b.vault.root, human, { file, scope: "desktop", ttlDays: 2 });
    const novo = renewDesktopSession(b.vault.root, antigo, { file });
    expect(novo).toMatch(/^hs_[0-9a-f]{64}$/);
    expect(novo).not.toBe(antigo);
    expect(sessionScope(b.vault.root, novo, { file })).toBe("desktop");
    expect(sessionScope(b.vault.root, antigo, { file })).toBeUndefined();
    // validade nova de 30 dias
    const st = JSON.parse(readFileSync(file, "utf8")) as Record<string, Array<{ scope?: string; expires_at: string }>>;
    const [entrada] = Object.values(st).flat().filter((e) => e.scope === "desktop");
    expect(Date.parse(entrada!.expires_at) - Date.now()).toBeGreaterThan(29.9 * 864e5);
    expect(Object.values(st).flat().filter((e) => e.scope === "desktop")).toHaveLength(1);
    // o token antigo (já revogado) não renova de novo
    expect(() => renewDesktopSession(b.vault.root, antigo, { file })).toThrow(expect.objectContaining({ code: "forbidden" }));
    // sessão full não é renovada por aqui (nem promovida)
    const full = issueHumanSession(b.vault.root, human, { file });
    expect(() => renewDesktopSession(b.vault.root, full, { file })).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(sessionScope(b.vault.root, full, { file })).toBe("full");
    // expirada e desconhecida
    const vencida = issueHumanSession(b.vault.root, human, { file, scope: "desktop", ttlDays: -1 });
    expect(() => renewDesktopSession(b.vault.root, vencida, { file })).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => renewDesktopSession(b.vault.root, `hs_${"0".repeat(64)}`, { file })).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => renewDesktopSession(b.vault.root, "lixo", { file })).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(sessionScope(b.vault.root, novo, { file })).toBe("desktop");
  });

  it("sessões antigas sem scope continuam full", async () => {
    const b = await tempBrain();
    const file = sessionsFile();
    const token = issueHumanSession(b.vault.root, human, { file });
    // entrada gravada antes do campo existir
    const st = JSON.parse(readFileSync(file, "utf8")) as Record<string, Array<Record<string, unknown>>>;
    for (const list of Object.values(st)) for (const e of list) delete e.scope;
    writeFileSync(file, JSON.stringify(st));
    expect(sessionScope(b.vault.root, token, { file })).toBe("full");
    expect(humanFromSession(b.vault.root, token, "alice", { file })).toMatchObject({ kind: "human", channel: "ui" });
    // sessão desktop explícita e token inválido
    const desk = issueHumanSession(b.vault.root, human, { file, scope: "desktop" });
    expect(sessionScope(b.vault.root, desk, { file })).toBe("desktop");
    expect(sessionScope(b.vault.root, `hs_${"0".repeat(64)}`, { file })).toBeUndefined();
    // escopo desconhecido (arquivo adulterado) não vale como sessão
    const st2 = JSON.parse(readFileSync(file, "utf8")) as Record<string, Array<Record<string, unknown>>>;
    for (const list of Object.values(st2)) for (const e of list) e.scope = "root";
    writeFileSync(file, JSON.stringify(st2));
    expect(sessionScope(b.vault.root, token, { file })).toBeUndefined();
    expect(humanFromSession(b.vault.root, desk, "alice", { file })).toBeUndefined();
  });
});
