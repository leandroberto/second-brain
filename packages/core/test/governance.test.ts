import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BrainError } from "@brain/shared";
import { cleanup, claude, codex, human, tempBrain } from "./helpers.js";

afterAll(cleanup);

const py = { title: "Versão do Python do projeto", type: "fact" as const, project: "promo-watcher", body: "O projeto utiliza Python 3.12 em produção.\n" };

describe("deduplicação e governança", () => {
  it("fluxo completo: new -> duplicate -> complement -> update -> replace", async () => {
    const b = await tempBrain();
    const n1 = await b.createNote(py, human);
    expect(n1.path).toBe("knowledge/projects/promo-watcher/" + n1.id + ".md");

    // as 4 variações do prompt NÃO viram 4 memórias
    for (const body of ["Python atual é 3.12.", "Versão Python do projeto: 3.12", "Projeto configurado com Python 3.12"]) {
      const p = await b.propose({ title: "Python do projeto", type: "fact", project: "promo-watcher", body }, claude);
      expect(["duplicate", "complement", "update"]).toContain(p.analysis.classification);
      expect(p.analysis.target_id).toBe(n1.id);
      expect(p.analysis.suggested_resolution === "create").toBe(false);
    }

    // sem relação nenhuma -> new
    const novo = await b.propose({ title: "Política de cancelamento", type: "decision", project: "menu-litoral", body: "Pedidos podem ser cancelados até 5 minutos após a confirmação." }, codex);
    expect(novo.analysis.classification).toBe("new");

    // valor divergente -> update, nunca silencioso
    const up = await b.propose({ title: "Versão do Python do projeto", type: "fact", project: "promo-watcher", body: "O projeto utiliza Python 3.13 em produção." }, claude);
    expect(up.analysis.classification).toBe("update");
    expect(up.analysis.warnings.join(" ")).toMatch(/3\.12.*3\.13/);
    const prev = await b.preview(up.id, "update");
    expect(prev.after).toContain("3.13");
    expect(prev.after).not.toContain("3.12");
    const r = await b.resolve(up.id, { resolution: "update" }, human);
    expect(r.commit).toBeTruthy();
    // a decisão não deixa o vault sujo (o JSON decidido não é regravado com o próprio hash) e a UI ainda recebe o commit
    expect(await b.git.dirty(".brain")).toEqual([]);
    expect((await b.proposalView(up.id)).decided?.commit).toBe(r.commit);
    expect(readFileSync(join(b.vault.root, n1.path), "utf8")).toContain("Python 3.13");
    // histórico preservado no Git
    const hist = await b.git.log(n1.path);
    expect(hist.length).toBeGreaterThanOrEqual(2);
    expect(await b.git.fileAt(hist[hist.length - 1]!.hash, n1.path)).toContain("3.12");

    // complemento
    const comp = await b.propose({ title: "Versão do Python do projeto", type: "fact", project: "promo-watcher", body: "O gerenciador de dependências é uv, com lockfile versionado e ambientes reproduzíveis em CI." }, claude);
    expect(comp.analysis.classification).toBe("complement");
    const r2 = await b.resolve(comp.id, { resolution: "complement" }, human);
    expect(r2.note!.body).toContain("## Complemento");
    expect(r2.note!.body).toContain("uv");

    // replace -> preserva histórico com supersedes/superseded_by
    const rep = await b.supersede({ old_id: n1.id, draft: { title: "Runtime do Promo Watcher", type: "fact", project: "promo-watcher", body: "O runtime passou a ser Node 24 com TypeScript." }, reason: "migração" }, codex);
    expect(rep.analysis.suggested_resolution).toBe("replace");
    const r3 = await b.resolve(rep.id, { resolution: "replace", target_id: n1.id }, human);
    const old = b.loadNote(n1.id);
    expect(old.status).toBe("superseded");
    expect(old.relations.superseded_by).toEqual([r3.note!.id]);
    expect(r3.note!.relations.supersedes).toEqual([n1.id]);
    expect(existsSync(join(b.vault.root, old.path))).toBe(true); // nada deletado
    // superseded sai da busca padrão
    expect((await b.search("Python 3.13")).some((h) => h.id === n1.id)).toBe(false);
    expect((await b.search("Python 3.13", { include_inactive: true })).some((h) => h.id === n1.id)).toBe(true);
    b.close();
  });

  it("detecta conflito por negação", async () => {
    const b = await tempBrain();
    await b.createNote({ title: "Uso de cache no checkout", type: "decision", project: "menu-litoral", body: "O checkout usa cache de preços por 5 minutos." }, human);
    const p = await b.propose({ title: "Uso de cache no checkout", type: "decision", project: "menu-litoral", body: "O checkout não usa cache de preços por 5 minutos." }, claude);
    expect(p.analysis.classification).toBe("conflict");
    b.close();
  });

  it("deduplica propostas idênticas pendentes", async () => {
    const b = await tempBrain();
    const a = await b.propose({ title: "Regra X", type: "pattern", body: "Sempre validar entrada no servidor antes de persistir." }, claude);
    const c = await b.propose({ title: "Regra X", type: "pattern", body: "Sempre validar entrada no servidor antes de persistir." }, codex);
    expect(c.id).toBe(a.id);
    expect(b.listProposals().length).toBe(1);
    b.close();
  });

  it("rejeita segredos e código gigante na proposta", async () => {
    const b = await tempBrain();
    await expect(b.propose({ title: "Config", type: "fact", body: "api_key = sk-abcdefghijklmnopqrstuvwxyz" }, claude)).rejects.toMatchObject({ code: "secret_detected" });
    await expect(b.propose({ title: "Dump", type: "fact", body: "```\n" + "linha\n".repeat(80) + "```" }, claude)).rejects.toMatchObject({ code: "too_large" });
    expect(b.listProposals().length).toBe(0);
    b.close();
  });

  it("política: agentes não persistem por padrão; new_only permite apenas novos", async () => {
    const b = await tempBrain();
    const p = await b.propose({ title: "Algo novo e único", type: "learning", body: "Observação inédita sobre zebras e girafas." }, claude);
    await expect(b.resolve(p.id, { resolution: "create" }, claude)).rejects.toMatchObject({ code: "forbidden" });
    await b.updateConfig({ agents: { commit_policy: "new_only" } }, human);
    // mesmo com new_only, o tipo precisa estar liberado explicitamente (padrão: review para todos)
    await expect(b.resolve(p.id, { resolution: "create" }, claude)).rejects.toMatchObject({ code: "forbidden" });
    await b.updateConfig({ agents: { per_type: { learning: "auto" } } }, human);
    const r = await b.resolve(p.id, { resolution: "create" }, claude);
    expect(r.note?.created_by).toEqual({ kind: "agent", name: "claude-code" });
    // decisão continua exigindo revisão
    const d = await b.propose({ title: "Decisão sobre algo inédito de quasares", type: "decision", body: "Decidimos observar quasares distantes com o instrumento novo." }, claude);
    await expect(b.resolve(d.id, { resolution: "create" }, claude)).rejects.toMatchObject({ code: "forbidden" });
    b.close();
  });

  it("ignore não cria nota mas registra a decisão", async () => {
    const b = await tempBrain();
    const p = await b.propose({ title: "Ruído", type: "learning", body: "Algo irrelevante sobre nada importante." }, claude);
    const r = await b.resolve(p.id, { resolution: "ignore", note: "ruído" }, human);
    expect(r.note).toBeUndefined();
    expect(b.getProposal(p.id).state).toBe("ignored");
    expect(b.listProposals().length).toBe(0);
    b.close();
  });
});

describe("concorrência", () => {
  it("alvo alterado após a análise => conflict_revision e proposta stale", async () => {
    const b = await tempBrain();
    const n = await b.createNote(py, human);
    const p = await b.propose({ title: "Versão do Python do projeto", type: "fact", project: "promo-watcher", body: "O projeto utiliza Python 3.13 em produção." }, claude);
    // outro agente/humano muda o alvo
    await b.updateNote(n.id, { body: "O projeto utiliza Python 3.11 legado.\n", expected_revision: n.revision }, human);
    await expect(b.resolve(p.id, { resolution: "update" }, human)).rejects.toMatchObject({ code: "conflict_revision" });
    expect(b.getProposal(p.id).state).toBe("stale");
    const re = await b.reanalyze(p.id, human);
    expect(re.state).toBe("pending");
    const ok = await b.resolve(p.id, { resolution: "update" }, human);
    expect(ok.note!.body).toContain("3.13");
    b.close();
  });

  it("updateNote exige revision atual", async () => {
    const b = await tempBrain();
    const n = await b.createNote(py, human);
    await b.updateNote(n.id, { tags: ["x"], expected_revision: n.revision }, human);
    await expect(b.updateNote(n.id, { tags: ["y"], expected_revision: n.revision }, human)).rejects.toBeInstanceOf(BrainError);
    b.close();
  });

  it("escritas paralelas (processos simulados) não corrompem nem perdem notas", async () => {
    const b1 = await tempBrain();
    const { Brain } = await import("../src/index.js");
    const b2 = await Brain.open(b1.vault.root, claude);
    const b3 = await Brain.open(b1.vault.root, codex);
    const titles = Array.from({ length: 12 }, (_, i) => `Nota paralela número ${i} sobre assunto distinto ${["alfa", "beta", "gama", "delta"][i % 4]}${i}`);
    await Promise.all(titles.map((t, i) => [b1, b2, b3][i % 3]!.createNote({ title: t, type: "learning", body: `Conteúdo único ${i} ${"x".repeat(i)} palavra${i}.` }, human)));
    await b1.sync({ force: true });
    expect(b1.db.rows("1=1", [], "id", 100).length).toBe(12);
    const health = await b1.health();
    expect(health.problems.duplicate_ids).toBe(0);
    expect((await b1.git.dirty("knowledge")).length).toBe(0); // tudo commitado
    [b1, b2, b3].forEach((x) => x.close());
  });
});

describe("watcher/reindex e Obsidian", () => {
  it("edição manual é percebida pelo sync e preservada", async () => {
    const b = await tempBrain();
    const n = await b.createNote(py, human);
    const f = join(b.vault.root, n.path);
    writeFileSync(f, readFileSync(f, "utf8").replace("3.12", "3.14 editado no Obsidian"));
    const r = await b.sync({ force: false });
    expect(r.changed).toContain(n.id);
    expect((await b.search("Obsidian")).map((h) => h.id)).toContain(n.id);
    // git enxerga como alteração pendente e pode agrupar num commit
    expect((await b.git.dirty("knowledge")).length).toBe(1);
    const c = await b.commitPending(undefined, human);
    expect(c.commit).toBeTruthy();
    // sync de novo é no-op (sem loop)
    const again = await b.sync({ force: false });
    expect([...again.added, ...again.changed, ...again.removed]).toEqual([]);
    b.close();
  });

  it("índice é reconstruível: apagar o SQLite não perde conhecimento", async () => {
    const b = await tempBrain();
    await b.createNote(py, human);
    const root = b.vault.root; b.close();
    const { rmSync } = await import("node:fs");
    rmSync(join(root, ".brain", "index.db"), { force: true });
    const { Brain } = await import("../src/index.js");
    const b2 = await Brain.open(root);
    expect((await b2.search("Python")).length).toBe(1);
    b2.close();
  });
});

describe("ignorar em lote", () => {
  it("ignora N propostas em UM commit e preserva a trilha em decided/", async () => {
    const b = await tempBrain();
    const a = await b.propose({ title: "Alfa único sobre zebras", type: "learning", body: "Zebras listradas habitam savanas e são muito rápidas em fuga." }, claude);
    const c = await b.propose({ title: "Beta único sobre baleias", type: "learning", body: "Baleias azuis cantam em frequências baixíssimas no oceano profundo." }, codex);
    const before = (await b.git.log(undefined, 50)).length;
    const r = await b.ignoreMany([a.id, c.id, "prop-20200101-aaaaaa"], "ruído", human);
    expect(r.ignored).toBe(2);
    expect((await b.git.log(undefined, 50)).length).toBe(before + 1);
    expect(b.getProposal(a.id).state).toBe("ignored");
    expect(b.listProposals().length).toBe(0);
    expect(b.listProposals("decided").length).toBe(2);
    b.close();
  });
});

describe("Claude + Codex propondo o mesmo conhecimento", () => {
  it("a segunda proposta é sinalizada e, após aprovar a primeira, é reanalisada como duplicata/complemento do novo conhecimento", async () => {
    const b = await tempBrain();
    const a = await b.propose({ title: "Timeout de resolução de links curtos", type: "learning", project: "promo-watcher", body: "Links curtos de afiliados precisam de timeout de 3 segundos ao serem expandidos com HEAD." }, claude);
    const c = await b.propose({ title: "Expandir links curtos com timeout", type: "learning", project: "promo-watcher", body: "Ao expandir links curtos de afiliados com HEAD, usar timeout de 3 segundos." }, codex);
    expect(a.id).not.toBe(c.id);
    expect(c.analysis.warnings.join(" ")).toMatch(/outra proposta pendente/);
    const r = await b.resolve(a.id, { resolution: "create" }, human);
    const c2 = b.getProposal(c.id);
    expect(["duplicate", "complement", "update"]).toContain(c2.analysis.classification);
    expect(c2.analysis.target_id).toBe(r.note!.id);
    expect(c2.target_revision).toBe(b.db.getRow(r.note!.id)!.revision);
    b.close();
  });
});

describe("aprovação em lote", () => {
  it("cria só propostas 'new', em UM commit, com ids únicos; recusa as demais", async () => {
    const b = await tempBrain();
    const base = await b.createNote({ title: "Versão do Python do projeto", type: "fact", project: "proj", body: "O projeto utiliza Python 3.12 em produção." }, human);
    const ps = [];
    const distinct = [["Rotação de logs", "Os logs de aplicação rotacionam diariamente e são comprimidos após sete dias."], ["Tema da interface", "A interface adota tema escuro por padrão com opção de tema claro nas configurações."], ["Fuso horário", "Todos os horários são armazenados em UTC e convertidos apenas na apresentação."]];
    for (const [t, body] of distinct) ps.push(await b.propose({ title: t!, type: "decision", body: body!, confidence: "high" }, claude));
    const dup = await b.propose({ title: "Versão do Python do projeto", type: "fact", project: "proj", body: "O projeto utiliza Python 3.12 em produção.", confidence: "high" }, codex);
    const medium = await b.propose({ title: "Observação sobre cogumelos", type: "learning", body: "Cogumelos decompõem matéria orgânica em florestas úmidas todos os anos.", confidence: "medium" }, claude);
    const undeclared = await b.propose({ title: "Observação sobre musgos", type: "learning", body: "Musgos retêm umidade em troncos antigos de florestas temperadas do sul." }, claude);
    const before = (await b.git.log(undefined, 100)).length;
    const r = await b.approveMany([...ps.map((p) => p.id), dup.id, medium.id, undeclared.id, "prop-20200101-aaaaaa"], human);
    expect(r.skipped.filter((s) => /confiança/.test(s.reason)).length).toBe(2); // lote exige confiança ALTA
    expect(r.created.length).toBe(3);
    expect(r.skipped.map((s) => s.reason).join("|")).toMatch(/classe duplicate.*\|?.*não existe|não existe.*classe/s);
    expect((await b.git.log(undefined, 100)).length).toBe(before + 1);
    expect(new Set(r.created.map((c) => c.id)).size).toBe(3);
    expect(b.getProposal(dup.id).state).toBe("pending");
    expect(b.db.getRow(base.id)).toBeTruthy();
    b.close();
  });
});

describe("editar proposta antes de decidir", () => {
  it("corrige título/corpo, reanalisa e continua sob as mesmas regras de segurança", async () => {
    const b = await tempBrain();
    const p = await b.propose({ title: "Rascunho ruim", type: "learning", body: "Texto original sobre pinguins e geleiras do sul do planeta." }, claude);
    const e = await b.editProposal(p.id, { title: "Pinguins dependem do gelo marinho", body: "Pinguins-imperadores dependem do gelo marinho estável para reprodução.", tags: ["fauna", "fauna", " clima "] }, human);
    expect(e.draft.title).toBe("Pinguins dependem do gelo marinho"); expect(e.draft.tags).toEqual(["fauna", "clima"]); expect(e.edited?.by.name).toBe("alice");
    await expect(b.editProposal(p.id, { body: "chave sk-abcdefghijklmnopqrstuvwxyz0123456789 aqui" }, human)).rejects.toMatchObject({ code: "secret_detected" });
    const r = await b.resolve(p.id, { resolution: "create" }, human);
    expect(r.note!.title).toBe("Pinguins dependem do gelo marinho");
    await expect(b.editProposal(p.id, { title: "x" }, human)).rejects.toMatchObject({ code: "invalid" });
    b.close();
  });
});
