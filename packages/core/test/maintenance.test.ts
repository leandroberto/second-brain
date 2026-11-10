import { afterAll, describe, expect, it } from "vitest";
import { auditTitles, clearRepoCache, knowledgeAudit, revalidateNotes, suggestTitle, titleIssues } from "../src/index.js";
import { cleanupRepos, gitRepo } from "./git-fixture.js";
import { claude, cleanup, human, tempBrain } from "./helpers.js";

afterAll(() => { cleanup(); cleanupRepos(); });

describe("conhecimento temporal + revalidação (nunca altera em silêncio)", () => {
  it("evidência nova contra nota temporal → UMA proposta de revalidação; confirmar renova a validade", async () => {
    const b = await tempBrain();
    const n = await b.createNote({ title: "Proj ainda não está em produção", type: "fact", project: "proj", body: "Em 14/10/2026 o Proj ainda está em pré-produção; dados de ambientes de desenvolvimento podem ser recriados.", source: { type: "conversation", repository: "proj" }, temporal: { as_of: "2026-10-14", revalidate_when: "status de produção do Proj mudar" } }, human);
    expect(n.temporal?.as_of).toBe("2026-10-14");
    const { root } = gitRepo([
      { date: "2026-09-01T10:00:00Z", msg: "feat: init", files: { "src/app.ts": "export const app = 1;\n" } },
      { date: "2026-11-02T10:00:00Z", msg: "release", files: { "RELEASES.md": "# Releases\n\nProduction launch completed on 2026-11-02.\n" } },
    ]);
    clearRepoCache();
    const dry = await revalidateNotes(b, root);
    expect(dry.items.find((i) => i.id === n.id)!.needs).toBe(true);
    expect(b.listProposals().length).toBe(0); // somente leitura por padrão
    const r = await revalidateNotes(b, root, { apply: true });
    const pid = r.items.find((i) => i.id === n.id)!.proposal!;
    const p = b.getProposal(pid);
    expect(p.maintenance?.kind).toBe("revalidate"); expect(p.proposed_by).toEqual({ kind: "system", name: "maintenance" });
    expect(p.analysis.classification).toBe("update"); expect(p.target_id).toBe(n.id);
    expect(p.freshness?.suggestion).toBe("revalidate"); expect(p.maintenance!.evidence!.join(" ")).toMatch(/RELEASES\.md/);
    // idempotente: rodar de novo não duplica
    const again = await revalidateNotes(b, root, { apply: true });
    expect(again.items.find((i) => i.id === n.id)!.skipped).toMatch(/já há revalidação pendente/);
    // nota NÃO mudou até o humano decidir
    expect(b.loadNote(n.id).temporal?.as_of).toBe("2026-10-14");
    // agente não decide manutenção (mesmo com política aberta)
    await b.updateConfig({ agents: { commit_policy: "all", per_type: { fact: "auto" } } }, human);
    await expect(b.resolve(pid, { resolution: "update", target_id: n.id }, claude)).rejects.toMatchObject({ code: "forbidden" });
    expect(p.draft.temporal?.as_of).toBe("2026-10-14"); // a proposta não antecipa a nova validade
    const ok = await b.resolve(pid, { resolution: "update", target_id: n.id }, human);
    expect(ok.note?.temporal?.as_of).toBe(new Date().toISOString().slice(0, 10)); // "Confirmar" = validade renovada NA DATA DO ACEITE
    expect(ok.note?.body).toBe(n.body);
    b.close();
  });

  it("brain_context entrega o conhecimento temporal marcado (data de validade + gatilho) e avisa para revalidar", async () => {
    const b = await tempBrain();
    await b.createNote({ title: "Proj ainda em pré-produção", type: "fact", project: "proj", body: "O Proj ainda está em pré-produção; dados de desenvolvimento podem ser recriados.", temporal: { as_of: "2026-10-14", revalidate_when: "status de produção mudar" } }, human);
    await b.createNote({ title: "Proj usa fila SQLite", type: "decision", project: "proj", body: "O Proj usa fila no SQLite para notificações." }, human);
    const ctx = await b.context({ project: "proj", topic: "produção dados de desenvolvimento" });
    const t = ctx.items.find((i) => i.title === "Proj ainda em pré-produção")!;
    expect(t.temporal).toEqual({ as_of: "2026-10-14", revalidate_when: "status de produção mudar" });
    expect(ctx.items.find((i) => i.title === "Proj usa fila SQLite")?.temporal).toBeUndefined();
    expect(ctx.hint).toMatch(/revalide/);
    b.close();
  });

  it("aceitar manutenção não duplica seções nem mistura afirmação velha e nova (sem merge heurístico)", async () => {
    const b = await tempBrain();
    const body = "## Política de dados\n\nFEATURE_X está desligada.\n\n## Por quê\n\nReduz risco.";
    const n = await b.createNote({ title: "Decisões fechadas neste documento", type: "decision", project: "proj", body }, human);
    const t = (await auditTitles(b, { apply: true })).items.find((x) => x.id === n.id)!;
    const same = await b.resolve(t.proposal!, { resolution: "update", target_id: n.id }, human);
    expect(same.note!.body.trim()).toBe(body); // nenhuma seção "## Política de dados" duplicada
    // "Alterar": o revisor edita o rascunho; o corpo editado SUBSTITUI (não convive com a frase antiga)
    const again = await b.propose({ title: same.note!.title, type: "decision", project: "proj", body, intent: "update", target_id: n.id, maintenance: { kind: "revalidate", reason: "teste" } }, (await import("../src/index.js")).principal("system", "maintenance", "maintenance"));
    await b.editProposal(again.id, { body: body.replace("desligada", "ligada desde 2026-11") }, human);
    const changed = await b.resolve(again.id, { resolution: "update", target_id: n.id }, human);
    expect(changed.note!.body).toContain("ligada desde 2026-11"); expect(changed.note!.body).not.toContain("está desligada");
    b.close();
  });

  it("agente não injeta proposta de manutenção nem veredito de atualidade", async () => {
    const b = await tempBrain();
    await expect(b.propose({ title: "Falsa revalidação de algo", type: "fact", body: "Texto qualquer de teste aqui.", maintenance: { kind: "revalidate", reason: "x" } }, claude)).rejects.toMatchObject({ code: "forbidden" });
    b.close();
  });
});

describe("qualidade de títulos (sugere, nunca renomeia sozinho)", () => {
  it("detecta título dependente de arquivo/organizacional e sugere a partir do conteúdo", async () => {
    expect(titleIssues({ title: "CLAUDE.md: Architecture", type: "concept", body: "x" })).toContain("depende do nome do arquivo");
    expect(titleIssues({ title: "Decisões fechadas neste documento", type: "decision", body: "x" }).length).toBeGreaterThan(0);
    expect(titleIssues({ title: "Promo Watcher: References", type: "reference", body: "x" }, "Promo Watcher").length).toBeGreaterThan(0);
    // citar CLAUDE.md no meio de uma afirmação é legítimo
    expect(titleIssues({ title: "Claude Code recebe o contrato por --append-system-prompt-file, nunca por CLAUDE.md", type: "decision", body: "x" })).toEqual([]);
    expect(titleIssues({ title: "Promo Watcher", type: "project", body: "x" })).toEqual([]);
    const s = suggestTitle({ title: "CLAUDE.md: Architecture", project: "promo-watcher", body: "Two Telegram clients cooperate under one process supervised by `app.run_watcher`: a Telethon user client and an aiogram bot." }, "Promo Watcher");
    expect(s.title).toBe("Promo Watcher: Two Telegram clients cooperate under one process supervised by app.run_watcher");
    expect(suggestTitle({ title: "Refs", body: "- Bot API: https://core.telegram.org/bots/api\n- aiogram: https://docs.aiogram.dev\n", project: "p" }, "P").title).toBe("P: referências — Bot API, aiogram");
  });

  it("--apply cria proposta de título; confirmar renomeia mantendo id e arquivo", async () => {
    const b = await tempBrain();
    const n = await b.createNote({ title: "Decisões fechadas neste documento", type: "decision", project: "promo", body: "- Aprovação manual do owner antes de qualquer fonte ficar ativa.\n- Limite de 3 sugestões por usuário." }, human);
    const r = await auditTitles(b, { apply: true });
    const it = r.items.find((x) => x.id === n.id)!;
    const p = b.getProposal(it.proposal!);
    expect(p.maintenance?.kind).toBe("title"); expect(p.draft.title).toBe("Aprovação manual do owner antes de qualquer fonte ficar ativa");
    expect((await auditTitles(b, { apply: true })).items.find((x) => x.id === n.id)!.skipped).toMatch(/pendente/);
    const done = await b.resolve(p.id, { resolution: "update", target_id: n.id }, human);
    expect(done.note?.id).toBe(n.id); expect(done.note?.title).toBe(p.draft.title); expect(done.note?.path).toBe(n.path);
    const a = await knowledgeAudit(b);
    expect(a.generic_titles.length).toBe(0); expect(a.total).toBe(1);
    b.close();
  });
});
