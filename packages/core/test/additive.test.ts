import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { principal, type Brain } from "../src/index.js";
import { classify } from "../src/governance.js";
import { ConfigSchema } from "../src/config.js";
import { cleanup, claude, human, importer, tempBrain } from "./helpers.js";

afterAll(cleanup);

/** Vault com a política `additive` (ADR 0014): o agente grava direto o que é aditivo. */
async function additiveBrain(extra: Record<string, unknown> = {}): Promise<Brain> {
  const b = await tempBrain();
  await b.updateConfig({ agents: { commit_policy: "additive", ...extra } }, human);
  return b;
}
const noteCount = (b: Brain) => (b.db.db.prepare("SELECT COUNT(*) n FROM notes").get() as { n: number }).n;

const lote = { title: "Processamento do lote noturno", type: "fact" as const, project: "pagamentos-demo", body: "O lote noturno roda às 2h. Ele processa os pagamentos pendentes do dia. O resultado vai para a fila de conciliação.\n" };

describe("política additive (ADR 0014)", () => {
  it("additive: nota nova é criada direto", async () => {
    const b = await additiveBrain();
    const p = await b.propose({ title: "Observação inédita sobre zebras", type: "learning", body: "Zebras listradas confundem moscas hematófagas com o padrão das listras." }, claude);
    expect(p.auto?.resolution).toBe("create");
    expect(p.auto?.note_id).toBeTruthy();
    expect(b.loadNote(p.auto!.note_id!).title).toBe("Observação inédita sobre zebras");
    expect(b.listProposals("pending")).toEqual([]);
    // a decisão automática passa pelo mesmo caminho do resolve: decided/ com o agente como decisor e commit preenchido
    expect(p.state).toBe("accepted");
    expect(p.decided?.by).toEqual({ kind: "agent", name: "claude-code" });
    expect(p.decided?.commit).toBeTruthy();
    expect(p.auto?.commit).toBe(p.decided?.commit);
    expect(b.listProposals("decided").map((x) => x.id)).toEqual([p.id]);
    const msg = execFileSync("git", ["-C", b.vault.root, "log", "-1", "--format=%B"], { encoding: "utf8" });
    expect(msg).toContain(`Brain-Proposal: ${p.id}`);
    expect(msg).toContain("Brain-Proposed-By: agent/claude-code");
    expect(msg).toContain("Brain-Decided-By: agent/claude-code");
    expect(msg).toContain("Brain-Channel: mcp");
    expect(msg).toContain("Brain-Resolution: create");
    b.close();
  });

  it("additive: complemento é anexado direto", async () => {
    const b = await additiveBrain();
    const n = await b.createNote(lote, human);
    // 5 sentenças no rascunho (título + 4), 2 novas = 40%
    const p = await b.propose({ ...lote, body: "O lote noturno roda às 2h. Ele processa os pagamentos pendentes do dia. Pagamentos recusados ganham uma segunda tentativa automática no lote seguinte. Um relatório resumido é enviado por e-mail ao time financeiro." }, claude);
    expect(p.analysis.classification).toBe("complement");
    expect(p.auto?.resolution).toBe("complement");
    expect(p.auto?.note_id).toBe(n.id);
    const body = b.loadNote(n.id).body;
    expect(body).toContain("segunda tentativa automática");
    expect(body).toContain("O lote noturno roda às 2h."); // nada foi sobrescrito
    expect(b.listProposals("pending")).toEqual([]);
    b.close();
  });

  it("additive: duplicata é ignorada sem nota nova", async () => {
    const b = await additiveBrain();
    await b.createNote(lote, human);
    const before = noteCount(b);
    const p = await b.propose({ ...lote }, claude);
    expect(p.analysis.classification).toBe("duplicate");
    expect(p.auto?.resolution).toBe("ignore");
    expect(p.auto?.note_id).toBeUndefined();
    expect(p.state).toBe("ignored");
    expect(b.listProposals("decided").length).toBe(1);
    expect(b.listProposals("pending")).toEqual([]);
    expect(noteCount(b)).toBe(before);
    b.close();
  });

  it("additive: complement declarado com número divergente vai para a fila", async () => {
    const b = await additiveBrain();
    const n = await b.createNote({ title: "Timeout do lote", type: "fact", project: "pagamentos-demo", body: "Timeout do lote é 30 s." }, human);
    const p = await b.propose({ title: "Timeout do lote", type: "fact", project: "pagamentos-demo", body: "Timeout do lote é 60 s.", intent: "complement", target_id: n.id }, claude);
    expect(p.auto).toBeUndefined();
    expect(p.analysis.classification).toBe("update");
    expect(b.listProposals("pending").length).toBe(1);
    expect(b.loadNote(n.id).body).toContain("30 s");
    b.close();
  });

  it("additive: contradição vai para a fila", async () => {
    const b = await additiveBrain();
    await b.createNote({ title: "Uso de cache no checkout", type: "fact", project: "menu-litoral", body: "O checkout usa cache de preços por 5 minutos." }, human);
    const p = await b.propose({ title: "Uso de cache no checkout", type: "fact", project: "menu-litoral", body: "O checkout não usa cache de preços por 5 minutos." }, claude);
    expect(p.analysis.classification).toBe("conflict");
    expect(p.auto).toBeUndefined();
    expect(b.listProposals("pending").length).toBe(1);
    b.close();
  });

  it("additive: contradição com intent complement e alvo declarado continua conflito", async () => {
    const b = await additiveBrain();
    const n = await b.createNote({ title: "Uso de cache no checkout", type: "fact", project: "menu-litoral", body: "O checkout usa cache de preços por 5 minutos." }, human);
    const p = await b.propose({ title: "Uso de cache no checkout", type: "fact", project: "menu-litoral", body: "O checkout não usa cache de preços por 5 minutos.", intent: "complement", target_id: n.id }, claude);
    expect(p.analysis.classification).toBe("conflict");
    expect(p.auto).toBeUndefined();
    expect(b.listProposals("pending").length).toBe(1);
    b.close();
  });

  it("additive: alvo declarado sem relação não esconde o valor divergente da nota semelhante", async () => {
    const b = await additiveBrain();
    await b.createNote({ title: "Timeout do lote", type: "fact", project: "pagamentos-demo", body: "Timeout do lote é 30 s." }, human);
    const other = await b.createNote({ title: "Cores do painel administrativo", type: "fact", body: "O painel administrativo usa tons de verde e cinza." }, human);
    const p = await b.propose({ title: "Timeout do lote", type: "fact", project: "pagamentos-demo", body: "Timeout do lote é 60 s.", intent: "complement", target_id: other.id }, claude);
    expect(p.auto).toBeUndefined();
    expect(p.analysis.classification).toBe("update");
    expect(b.loadNote(other.id).body).not.toContain("60 s");
    b.close();
  });

  it("additive: per_type review explícito vai para a fila", async () => {
    const b = await additiveBrain({ per_type: { decision: "review" } });
    const p = await b.propose({ title: "Decisão sobre quasares distantes", type: "decision", body: "Decidimos observar quasares distantes com o instrumento novo." }, claude);
    expect(p.analysis.classification).toBe("new");
    expect(p.auto).toBeUndefined();
    expect(b.listProposals("pending").length).toBe(1);
    b.close();
  });

  it("additive: complemento de nota de tipo marcado review vai para a fila (tipo do alvo conta)", async () => {
    const b = await additiveBrain({ per_type: { decision: "review" } });
    const n = await b.createNote({ ...lote, type: "decision" }, human);
    const p = await b.propose({ ...lote, type: "learning", body: "O lote noturno roda às 2h. Ele processa os pagamentos pendentes do dia. Pagamentos recusados ganham uma segunda tentativa automática no lote seguinte. Um relatório resumido é enviado por e-mail ao time financeiro." }, claude);
    expect(p.analysis.classification).toBe("complement");
    expect(p.auto).toBeUndefined();
    expect(b.loadNote(n.id).body).not.toContain("segunda tentativa");
    b.close();
  });

  it("additive: validação do resolve que falha antes de escrever deixa a proposta na fila, com aviso", async () => {
    const b = await additiveBrain();
    const n = await b.createNote(lote, human);
    // edição manual (fora do Core) colocou um possível segredo no alvo: o complemento resultante não passa no filtro
    const file = join(b.vault.root, n.path);
    writeFileSync(file, readFileSync(file, "utf8").replace("O resultado vai", "Chave sk-abcdefghijklmnopqrstuvwxyz0123. O resultado vai"));
    await b.sync({ force: true });
    const p = await b.propose({ ...lote, body: "O lote noturno roda às 2h. Ele processa os pagamentos pendentes do dia. Pagamentos recusados ganham uma segunda tentativa automática no lote seguinte. Um relatório resumido é enviado por e-mail ao time financeiro." }, claude);
    expect(p.analysis.classification).toBe("complement");
    expect(p.auto).toBeUndefined();
    expect(p.state).toBe("pending");
    expect(p.analysis.warnings.join(" ")).toMatch(/não aplicada/);
    expect(b.listProposals("pending").length).toBe(1);
    expect(b.loadNote(n.id).body).not.toContain("segunda tentativa");
    b.close();
  });

  it("additive: humano propondo não é auto-aplicado", async () => {
    const b = await additiveBrain();
    const p = await b.propose({ title: "Observação inédita sobre girafas", type: "learning", body: "Girafas dormem poucos minutos por vez, em pé na maior parte do tempo." }, human);
    expect(p.auto).toBeUndefined();
    expect(p.state).toBe("pending");
    expect(b.listProposals("pending").length).toBe(1);
    b.close();
  });

  it("additive: agente continua sem aplicar update, keep_separate ou final_body pelo brain_commit", async () => {
    const b = await additiveBrain();
    const n = await b.createNote({ title: "Timeout do lote", type: "fact", project: "pagamentos-demo", body: "Timeout do lote é 30 s." }, human);
    const p = await b.propose({ title: "Timeout do lote", type: "fact", project: "pagamentos-demo", body: "Timeout do lote é 60 s." }, claude);
    expect(p.analysis.classification).toBe("update");
    await expect(b.resolve(p.id, { resolution: "update" }, claude)).rejects.toMatchObject({ code: "forbidden" });
    await expect(b.resolve(p.id, { resolution: "keep_separate" }, claude)).rejects.toMatchObject({ code: "forbidden" });
    await expect(b.resolve(p.id, { resolution: "create" }, claude)).rejects.toMatchObject({ code: "forbidden" });
    await expect(b.resolve(p.id, { resolution: "complement", target_id: n.id }, claude)).rejects.toMatchObject({ code: "forbidden" });
    expect(b.loadNote(n.id).body).toContain("30 s");
    b.close();
  });

  it("never continua exigindo revisão", async () => {
    const b = await tempBrain();
    expect(b.config.agents.commit_policy).toBe("never");
    const p = await b.propose({ title: "Observação inédita sobre zebras", type: "learning", body: "Zebras listradas confundem moscas hematófagas com o padrão das listras." }, claude);
    expect(p.analysis.classification).toBe("new");
    expect(p.auto).toBeUndefined();
    expect(b.listProposals("pending").length).toBe(1);
    b.close();
  });
});

describe("additive: decisões da fila continuam humanas (rodada de correção 1)", () => {
  const zebra = { title: "Observação inédita sobre zebras", type: "learning" as const, body: "Zebras listradas confundem moscas hematófagas com o padrão das listras." };

  it("agente não decide proposta de humano (nem ignore de duplicata, nem create de nova)", async () => {
    const b = await additiveBrain();
    await b.createNote(lote, human);
    const dup = await b.propose({ ...lote }, human);
    expect(dup.analysis.classification).toBe("duplicate");
    await expect(b.resolve(dup.id, { resolution: "ignore" }, claude)).rejects.toMatchObject({ code: "forbidden" });
    const novo = await b.propose(zebra, human);
    expect(novo.analysis.classification).toBe("new");
    await expect(b.resolve(novo.id, { resolution: "create" }, claude)).rejects.toMatchObject({ code: "forbidden" });
    expect(b.listProposals("pending").length).toBe(2);
    b.close();
  });

  it("agente não decide proposta do importador", async () => {
    const b = await additiveBrain();
    const p = await b.propose(zebra, importer);
    expect(p.analysis.classification).toBe("new");
    expect(p.auto).toBeUndefined();
    await expect(b.resolve(p.id, { resolution: "create" }, claude)).rejects.toMatchObject({ code: "forbidden" });
    expect(b.listProposals("pending").length).toBe(1);
    b.close();
  });

  it("o agente assistant/A não decide nem complementa pelo brain_commit uma proposta do agente assistant/B", async () => {
    const b = await tempBrain(); // sob never as duas propostas de B ficam na fila; depois o vault passa a additive
    const agenteA = principal("agent", "assistant/20261110-100000-aaaa", "mcp");
    const agenteB = principal("agent", "assistant/20261110-100000-bbbb", "mcp");
    const n = await b.createNote(lote, human);
    const nova = await b.propose(zebra, agenteB);
    const comp = await b.propose({ ...lote, body: "O lote noturno roda às 2h. Ele processa os pagamentos pendentes do dia. Pagamentos recusados ganham uma segunda tentativa automática no lote seguinte. Um relatório resumido é enviado por e-mail ao time financeiro." }, agenteB);
    expect([nova.analysis.classification, comp.analysis.classification]).toEqual(["new", "complement"]);
    await b.updateConfig({ agents: { commit_policy: "additive" } }, human);
    await expect(b.resolve(nova.id, { resolution: "create" }, agenteA)).rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/próprias propostas/) });
    await expect(b.resolve(comp.id, { resolution: "complement", target_id: n.id }, agenteA)).rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/próprias propostas/) });
    expect(b.loadNote(n.id).body).not.toContain("segunda tentativa");
    expect(b.listProposals("pending").length).toBe(2);
    // o autor (B) decide as duas: a recusa acima é por autoria, não pela classificação
    expect((await b.resolve(nova.id, { resolution: "create" }, agenteB)).note?.title).toBe(zebra.title);
    await b.resolve(comp.id, { resolution: "complement", target_id: n.id }, agenteB);
    expect(b.loadNote(n.id).body).toContain("segunda tentativa");
    b.close();
  });

  it("proposta classificada sob never (intent complement mascarava o valor divergente) não é aplicada pelo brain_commit depois do switch", async () => {
    const b = await tempBrain();
    const n = await b.createNote({ title: "Timeout do lote", type: "fact", project: "pagamentos-demo", body: "Timeout do lote é 30 s." }, human);
    const p = await b.propose({ title: "Timeout do lote", type: "fact", project: "pagamentos-demo", body: "Timeout do lote é 60 s.", intent: "complement", target_id: n.id }, claude);
    expect(p.analysis.classification).toBe("complement"); // sob never a dica é confiável
    await b.updateConfig({ agents: { commit_policy: "additive" } }, human);
    await expect(b.resolve(p.id, { resolution: "complement", target_id: n.id }, claude)).rejects.toMatchObject({ code: "forbidden" });
    expect(b.loadNote(n.id).body).not.toContain("60 s");
    expect(b.listProposals("pending").length).toBe(1);
    b.close();
  });

  it("a própria proposta legítima, feita antes do switch, ainda pode ser aplicada pelo agente", async () => {
    const b = await tempBrain();
    const p = await b.propose(zebra, claude);
    await b.updateConfig({ agents: { commit_policy: "additive" } }, human);
    const r = await b.resolve(p.id, { resolution: "create" }, claude);
    expect(r.note?.title).toBe(zebra.title);
    b.close();
  });

  it("intent complement com alvo sem relação vira nota nova (não anexa ao alvo)", async () => {
    const b = await additiveBrain();
    const other = await b.createNote({ title: "Cores do painel administrativo", type: "fact", body: "O painel administrativo usa tons de verde e cinza." }, human);
    const p = await b.propose({ ...zebra, intent: "complement", target_id: other.id }, claude);
    expect(p.analysis.classification).toBe("new");
    expect(p.auto?.resolution).toBe("create");
    expect(p.auto?.note_id).not.toBe(other.id);
    expect(b.loadNote(other.id).body).not.toContain("Zebras");
    b.close();
  });

  it("alvo declarado sem intent e sem relação também não recebe complemento", async () => {
    const b = await additiveBrain();
    const other = await b.createNote({ title: "Cores do painel administrativo", type: "fact", body: "O painel administrativo usa tons de verde e cinza." }, human);
    const p = await b.propose({ ...zebra, target_id: other.id }, claude);
    expect(p.analysis.classification).toBe("new");
    expect(b.loadNote(other.id).body).not.toContain("Zebras");
    b.close();
  });
});

describe("recentAgentWrites", () => {
  it("recentAgentWrites lista gravações automáticas dos últimos 7 dias", async () => {
    const b = await additiveBrain();
    const n = await b.createNote(lote, human);
    const novo = await b.propose({ title: "Observação inédita sobre girafas", type: "learning", body: "Girafas dormem poucos minutos por vez, em pé, para fugir de predadores." }, claude);
    const compl = await b.propose({ ...lote, body: "O lote noturno roda às 2h. Ele processa os pagamentos pendentes do dia. Pagamentos recusados ganham uma segunda tentativa automática no lote seguinte. Um relatório resumido é enviado por e-mail ao time financeiro." }, claude);
    expect(compl.auto?.resolution).toBe("complement");
    const w = await b.recentAgentWrites({});
    expect(w).toHaveLength(2);
    const byRes = Object.fromEntries(w.map((x) => [x.resolution, x]));
    expect(byRes.create).toMatchObject({ note_id: novo.auto!.note_id, title: "Observação inédita sobre girafas", agent: "claude-code", commit: novo.decided!.commit });
    expect(byRes.complement).toMatchObject({ note_id: n.id, title: lote.title, agent: "claude-code", commit: compl.decided!.commit });
    expect(byRes.create!.capture_id).toBeUndefined();
    // filtros: por agente e por janela de dias
    expect(await b.recentAgentWrites({ agent: "codex" })).toEqual([]);
    expect(await b.recentAgentWrites({ agent: "claude-code" })).toHaveLength(2);
    expect(await b.recentAgentWrites({ days: 0 })).toEqual([]);
    b.close();
  });
  it("respeita limit (mais novas primeiro)", async () => {
    const b = await additiveBrain();
    const fatos = ["girafas", "focas", "tucanos"].map((x) => ({ title: `Observação inédita sobre ${x}`, type: "learning" as const, body: `Fato exclusivo e distinto sobre ${x}, sem relação com qualquer outra nota do vault.` }));
    for (const f of fatos) await b.propose(f, claude);
    const all = await b.recentAgentWrites({});
    expect(all).toHaveLength(3);
    const two = await b.recentAgentWrites({ limit: 2 });
    expect(two.map((x) => x.note_id)).toEqual(all.slice(0, 2).map((x) => x.note_id));
    b.close();
  });

  it("depois de revertCommit do complemento automático, o item não é mais listado", async () => {
    const b = await additiveBrain();
    const n = await b.createNote(lote, human);
    const compl = await b.propose({ ...lote, body: "O lote noturno roda às 2h. Ele processa os pagamentos pendentes do dia. Pagamentos recusados ganham uma segunda tentativa automática no lote seguinte. Um relatório resumido é enviado por e-mail ao time financeiro." }, claude);
    expect(compl.auto?.resolution).toBe("complement");
    expect(await b.recentAgentWrites({})).toHaveLength(1);
    await b.revertCommit(compl.decided!.commit!, human);
    expect(b.loadNote(n.id).body).not.toContain("segunda tentativa automática");
    expect(await b.recentAgentWrites({})).toEqual([]);
    b.close();
  });

  it("some da lista quando a nota foi arquivada", async () => {
    const b = await additiveBrain();
    const p = await b.propose({ title: "Observação inédita sobre pinguins", type: "learning", body: "Pinguins-imperadores se revezam no centro do grupo para dividir o calor." }, claude);
    expect(await b.recentAgentWrites({})).toHaveLength(1);
    await b.updateNote(p.auto!.note_id!, { status: "archived", expected_revision: b.loadNote(p.auto!.note_id!).revision }, human);
    expect(await b.recentAgentWrites({})).toEqual([]);
    b.close();
  });

  it("extrai o capture_id do agente assistant/<id>, ignora humanos e esconde nota que não existe mais", async () => {
    const b = await additiveBrain();
    const asst = principal("agent", "assistant/20261110-153012-a1b2", "mcp");
    const p = await b.propose({ title: "Fato gravado pelo assistente", type: "fact", body: "A estufa fictícia mantém vinte e dois graus durante o dia inteiro." }, asst);
    await b.createNote({ title: "Nota humana qualquer", type: "fact", body: "Texto escrito pelo humano, nunca listado como gravação de agente." }, human);
    const w = await b.recentAgentWrites({});
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ agent: "assistant/20261110-153012-a1b2", capture_id: "20261110-153012-a1b2", note_id: p.auto!.note_id });
    rmSync(join(b.vault.root, b.db.getRow(p.auto!.note_id!)!.path));
    await b.sync({ force: true });
    expect(await b.recentAgentWrites({})).toEqual([]);
    b.close();
  });
});

describe("classify com trustHint", () => {
  const cfg = ConfigSchema.parse({}).governance;
  const ex = { id: "fact-timeout", title: "Timeout do lote", body: "Timeout do lote é 30 s." };
  const match = { id: ex.id, title: ex.title, type: "fact" as const, status: "active" as const, similarity: 0.9, reasons: [], revision: "r1", updated_at: "2026-11-10" };
  const get = (id: string) => (id === ex.id ? ex : undefined);
  const draft = { title: "Timeout do lote", body: "Timeout do lote é 60 s." };
  const hint = { intent: "complement" as const, target_id: ex.id };

  it("por padrão (confiança na dica) mantém o comportamento atual: respeita intent complement", () => {
    expect(classify(draft, [match], get, cfg, hint).classification).toBe("complement");
  });
  it("sem confiança, intent complement nunca rebaixa update por valor divergente", () => {
    expect(classify(draft, [match], get, cfg, hint, { trustHint: false }).classification).toBe("update");
  });
  it("sem confiança, a dica ainda pode escalar (update/replace explícitos)", () => {
    const d = { title: "Timeout do lote", body: "Timeout do lote é 30 s. Vale para todos os ambientes de homologação." };
    expect(classify(d, [match], get, cfg, { intent: "update", target_id: ex.id }, { trustHint: false }).classification).toBe("update");
    expect(classify(d, [match], get, cfg, { intent: "replace", target_id: ex.id }, { trustHint: false }).classification).toBe("replace");
  });
});
