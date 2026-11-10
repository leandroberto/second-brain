import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractCandidates, importPath } from "../src/index.js";
import { assess, implementationDensity, isGenericHeading, leadClause } from "../src/importer/quality.js";
import { dedupeCandidates } from "../src/importer/extract.js";
import { cleanup, human, tempBrain } from "./helpers.js";

afterAll(cleanup);
const doc = (md: string, path = "docs/design.md") => extractCandidates(`# Catálogo de Ofertas — Design\n\n${md}`, path, { project: "catalogo" });
const titles = (r: ReturnType<typeof doc>) => r.candidates.map((c) => c.title);

describe("qualidade da extração: conhecimento ≠ índice de headings", () => {
  it("1a. heading organizacional + texto deítico NÃO vira simplesmente o título do heading; vira afirmação reformulada com o contexto (ou é descartado)", () => {
    const r = doc("## Decisões futuras, organizadas por fase\n\nEstas decisões não invalidam a arquitetura geral, mas devem ser fechadas antes da fase indicada. Nenhuma delas bloqueia a Fase 1 e elas não serão reabertas durante seu planejamento.\n");
    expect(titles(r)).not.toContain("Decisões futuras, organizadas por fase");
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    expect(c.title).toMatch(/Decisões futuras não invalidam a arquitetura geral/);   // título = afirmação, não categoria
    expect(c.body).not.toMatch(/^\s*Estas decisões/);                                 // abertura deítica resolvida
    expect(c.flags).toEqual(expect.arrayContaining(["enriched", "title-synthesized"])); expect(c.confidence).not.toBe("high");
  });
  it("1b. o mesmo texto sob cabeçalho GENÉRICO ('Decisões') não é resolvível e é descartado", () => {
    const r = doc("## Decisões\n\nEstas decisões não invalidam a arquitetura geral, mas devem ser fechadas antes da fase indicada.\n");
    expect(r.candidates).toEqual([]); expect(r.rejections[0]!.reason).toMatch(/contexto|deítica|organizacional/);
  });

  it("2. '## Decisão' com decisão concreta gera Decision específica (título vem do conteúdo)", () => {
    const r = doc("## Decisão\n\nUsaremos SQLite FTS5 em vez de Elasticsearch na V1.\n");
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    expect(c.type).toBe("decision"); expect(c.title).toMatch(/SQLite FTS5 em vez de Elasticsearch/); expect(c.title).not.toBe("Decisão");
    expect(c.why!.join(" ")).toMatch(/cabeçalho|derivado|afirma/); expect(c.flags).toContain("title-synthesized");
  });

  it("3. '## Arquitetura da Fase 2' descritivo, sem decisão, não vira Decision", () => {
    const r = doc("## Arquitetura da Fase 2\n\nO serviço de consulta lê o catálogo e devolve uma lista paginada de ofertas para o controlador de apresentação.\n");
    expect(r.candidates.filter((c) => c.type === "decision")).toEqual([]);
    expect(titles(r)).not.toContain("Arquitetura da Fase 2");
  });

  it("4. '## Learning' com armadilha reutilizável vira learning (título do conteúdo)", () => {
    const r = doc("## Learning\n\npkill -f com um padrão que também casa o próprio comando derruba o shell que o executou; prefira fuser -k PORTA/tcp.\n");
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.type).toBe("learning"); expect(r.candidates[0]!.title).toMatch(/pkill -f/i);
  });

  it("5. heading genérico + conteúdo específico: o título reflete o CONTEÚDO", () => {
    const r = doc("## Decisões da Fase 1\n\nO worker de mídia roda fora do caminho crítico e nunca bloqueia o upsert comercial das ofertas.\n");
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.title).toMatch(/worker de mídia/i); expect(r.candidates[0]!.title).not.toMatch(/Fase 1/i);
  });

  it("6. conteúdo que depende de contexto anterior é descartado (cabeçalho genérico) ou enriquecido (cabeçalho informativo)", () => {
    const dropped = doc("## Decisões\n\nEla deve ser revisada pelo time responsável antes da fase seguinte do projeto.\n");
    expect(dropped.candidates).toEqual([]);
    expect(dropped.rejections[0]!.reason).toMatch(/depende de contexto/);
    const enriched = doc("## Decisão sobre reenvio de ofertas\n\nEla nunca deve gerar notificação repetida para o mesmo usuário dentro da janela de resfriamento configurada.\n", "docs/design.md");
    // cabeçalho informativo + pronome ("Ela" = a política do título): aceito com o contexto do cabeçalho ANEXADO e confiança limitada
    expect(enriched.candidates).toHaveLength(1);
    expect(enriched.candidates[0]!.flags).toContain("enriched"); expect(enriched.candidates[0]!.confidence).toBe("medium"); expect(enriched.candidates[0]!.body).toMatch(/Contexto: .*Decisão sobre reenvio de ofertas/);
  });

  it("7. seção com várias decisões independentes é separada; itens curtos/detalhe de implementação não viram propostas", () => {
    const r = doc("## Decisões\n\n- Notificações nunca são enviadas duas vezes ao mesmo usuário para o mesmo produto no mesmo dia.\n- O catálogo deve continuar funcionando quando a fila de mídia estiver indisponível ou lenta.\n- principal_revision nunca diminui; availability_cycle_id só incrementa em transição_ativa.\n- Cache curto.\n");
    expect(r.candidates.length).toBe(2);
    expect(r.candidates.every((c) => c.flags?.includes("split"))).toBe(true);
    expect(new Set(r.candidates.map((c) => c.title)).size).toBe(2);
    expect(r.candidates.map((c) => c.body).join(" ")).not.toMatch(/principal_revision/);
    expect(r.rejections.some((x) => /não propostos/.test(x.reason))).toBe(true);
  });

  it("8. a mesma decisão em dois documentos gera UMA proposta; depois de aprovada, a reimportação é duplicata", async () => {
    const d = mkdtempSync(join(tmpdir(), "brain-q-")); execFileSync("git", ["init", "-q", "-b", "main", d]);
    mkdirSync(join(d, "docs"));
    const same = "## Decisão\n\nNotificações passam por uma fila durável com retry exponencial para sobreviver ao rate limit do Telegram.\n";
    writeFileSync(join(d, "docs", "a.md"), `# Notificações — Design\n\n${same}`);
    writeFileSync(join(d, "docs", "b.md"), `# Notificações — Adendo\n\n${same}`);
    execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i"]);
    const b = await tempBrain();
    const rep = await importPath(b, d, { project: "notif" });
    expect(rep.dropped_similar).toBe(1); expect(rep.queued).toBe(1);
    const p = b.listProposals()[0]!;
    await b.resolve(p.id, { resolution: "create" }, human);
    const again = await importPath(b, d, { project: "notif" });
    expect(again.queued).toBe(0); expect(again.items.every((i) => i.status === "duplicate-skipped")).toBe(true);
    b.close();
  });
});

describe("critérios de qualidade (princípios, não listas)", () => {
  it("ADR com decisão explícita é alta; só cabeçalho (sem afirmação) é rejeitado; heading+frase vaga nunca é alta", () => {
    const adr = extractCandidates("# ADR 0001 — Usar fila durável\n\n## Contexto\nPerdíamos mensagens em picos de tráfego do Telegram.\n\n## Decisão\nNotificações passam por fila durável com retry exponencial.\n", "docs/adr/0001-fila.md");
    expect(adr.candidates[0]!.confidence).toBe("high");
    const vague = doc("## Decisões\n\nVeja abaixo.\n");
    expect(vague.candidates).toEqual([]);
    const a = assess({ title: "Decisões do projeto", body: "Algumas coisas foram conversadas e ficaram combinadas entre as pessoas envolvidas no trabalho.", heading: "Decisões", viaHeading: true, synthesizedTitle: false, enriched: false });
    expect(a.confidence).not.toBe("high");
  });
  it("texto que descreve o documento (meta) e referência a outras seções do documento são descartados", () => {
    expect(doc("## Decisão de validação\n\nEsta spec consolida a visão aprovada do produto e mantém a implementação incremental por fases.\n").candidates).toEqual([]);
    const r = doc("## Por que a premissa muda\n\nA seção 12.5 tratava a chamada como fonte única, e a reverificação da seção 13.9 mostrou que isso era frágil na prática.\n");
    expect(r.candidates).toEqual([]); expect(r.rejections[0]!.reason).toMatch(/seções do documento/);
  });
  it("lista de links sem prosa não é conhecimento; detalhe de implementação é derivável do código", () => {
    expect(doc("## Referências\n\n- https://exemplo.dev/a\n- https://exemplo.dev/b\n- https://exemplo.dev/c\n").candidates).toEqual([]);
    expect(implementationDensity("principal_revision nunca diminui e availability_cycle_id só muda em transição_ativa")).toBeGreaterThanOrEqual(2);
    expect(implementationDensity("Notificações nunca são enviadas duas vezes ao mesmo usuário")).toBe(0);
  });
  it("cabeçalho genérico é sinal fraco: poucos termos de conteúdo ou só palavras estruturais", () => {
    for (const h of ["Decisões", "Arquitetura da Fase 2", "Overview", "Known limitations", "Próximos passos"]) expect(isGenericHeading(h)).toBe(true);
    for (const h of ["Política de reenvio de ofertas", "Idempotência dos webhooks do Telegram", "Escolha do banco de dados"]) expect(isGenericHeading(h)).toBe(false);
  });
  it("lista coesa repetida em outro documento: itens repetidos saem; só sobrevive com ≥ 2 itens novos", () => {
    const mk = (items: string[], title: string) => ({ id: "", title, type: "fact" as const, body: items.map((i) => `- ${i}`).join("\n"), tags: [], confidence: "medium" as const, rule: "x", evidence: "", source: { path: title }, flags: ["group"] });
    const a = mk(["Conteúdo protegido pelo Telegram não pode ser encaminhado.", "Mensagens editadas não são reavaliadas pelo matching.", "O histórico de entregas reinicia a cada reinício do processo."], "A");
    const b = mk(["Conteúdo protegido pelo Telegram não pode ser encaminhado.", "Mensagens editadas não são reavaliadas pelo matching.", "Fontes são globais e não específicas por usuário do bot."], "B");
    const { kept } = dedupeCandidates([a, b]);
    expect(kept).toHaveLength(2);
    expect(kept[1]!.body).toBe("Fontes são globais e não específicas por usuário do bot."); // só o item novo sobrevive
    expect(kept[1]!.flags).not.toContain("group");
  });
  it("lead clause: título curto, sem marcadores e sem terminar em artigo/preposição", () => {
    expect(leadClause("- [x] Cada baseline persiste uma única principal por usuário/produto, não a fronteira de alternativas.")).toBe("Cada baseline persiste uma única principal por usuário/produto");
    expect(leadClause("Usaremos SQLite FTS5 em vez de Elasticsearch na V1.")).toBe("Usaremos SQLite FTS5 em vez de Elasticsearch na V1");
    expect(leadClause("a".repeat(200)).length).toBeLessThanOrEqual(90);
  });
});

describe("regressões da revisão independente (bilíngue, fixtures sanitizadas)", () => {
  it("logística/agenda/status transitório NÃO é conhecimento durável, nem com marcador normativo", () => {
    for (const body of ["We will meet tomorrow afternoon to discuss the remaining agenda with the entire team.", "Faremos a reunião amanhã à tarde para discutir toda a pauta restante com o time inteiro."]) {
      const r = doc(`## Decisions\n\n${body}\n`); expect(r.candidates).toEqual([]); expect(r.rejections[0]!.reason).toMatch(/transitório/);
    }
  });
  it("ADR/regras vagos (sem afirmação normativa) não recebem confiança alta", () => {
    const adr = extractCandidates("# ADR 0002 — Algo\n\n## Decisão\nO time conversou sobre o assunto e todos acharam interessante continuar avaliando as possibilidades.\n", "docs/adr/0002-x.md");
    expect(adr.candidates[0]?.confidence ?? "medium").not.toBe("high");
  });
  it("dedupe preserva contradições (polaridade) e números diferentes", () => {
    const mk = (b: string, t: string) => ({ id: "", title: t, type: "decision" as const, body: b, tags: [], confidence: "medium" as const, rule: "x", evidence: "", source: { path: t } });
    const a = mk("We must allow retries for failed payments because network outages are common in practice.", "A");
    const b = mk("We must not allow retries for failed payments because network outages are common in practice.", "B");
    expect(dedupeCandidates([a, b]).kept).toHaveLength(2);
    const c = mk("O timeout de resolução de links curtos é de 3 segundos para cada tentativa de expansão.", "C");
    const d = mk("O timeout de resolução de links curtos é de 5 segundos para cada tentativa de expansão.", "D");
    expect(dedupeCandidates([c, d]).kept).toHaveLength(2);
  });
  it("lista descartada não envenena o dedupe seguinte (itens só contam depois de mantidos)", () => {
    const g = (items: string[], t: string) => ({ id: "", title: t, type: "fact" as const, body: items.map((i) => `- ${i}`).join("\n"), tags: [], confidence: "medium" as const, rule: "x", evidence: "", source: { path: t }, flags: ["group"] });
    const A = "Faturas devem ser retidas por cinco anos para fins de auditoria fiscal.";
    const B = "Pagamentos arquivados precisam de trilha de auditoria imutável e consultável.";
    const C = "Consentimentos médicos expiram após doze meses sem renovação do paciente.";
    const { kept } = dedupeCandidates([{ ...g([A], "solo"), flags: [] }, g([A, B], "g1"), g([B, C], "g2")]);
    const all = kept.map((k) => k.body).join("\n");
    expect(all).toContain(B); expect(all).toContain(C); // B e C não somem por terem sido "vistos" em listas descartadas
  });
  it("entrada patológica (32 mil linhas em branco) é linear", () => {
    const t0 = Date.now();
    extractCandidates("# D\n\n## Decisions\n" + " \n".repeat(32_000) + "We chose SQLite instead of Redis because offline operation is mandatory for remote clinics.\n", "docs/x.md");
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it("texto colado rejeitado pela qualidade NÃO é ressuscitado como paste:single", async () => {
    const b = await tempBrain();
    const { importText } = await import("../src/index.js");
    const rep = await importText(b, "## Decisions\n\nThis document describes the work completed yesterday during our planning meeting.\n", { dryRun: true });
    expect(rep.candidates).toBe(0);
    const solto = await importText(b, "Descobri que o webhook reenvia a mesma atualização duas vezes quando respondemos devagar; precisa de idempotência por update_id.", { dryRun: true });
    expect(solto.items[0]?.candidate.rule).toBe("paste:single");
    b.close();
  });
  it("item único de lista não se perde e ressalvas essenciais ficam no corpo", () => {
    const r = doc("## Decision\n\n- We chose SQLite instead of Redis because offline operation is mandatory for remote clinics.\n");
    expect(r.candidates).toHaveLength(1);
    const q = doc("## Decisions\n\n- We must delete every customer record, but only after the legal retention period has fully elapsed.\n- Audit logs must be kept for seven years regardless of any customer deletion request received.\n");
    expect(q.candidates.length).toBe(2);
    expect(q.candidates.map((c) => c.body).join(" ")).toMatch(/but only after the legal retention period/);
  });
  it("identificador em backticks conta UMA vez e justificativa explícita mantém o item", () => {
    expect(implementationDensity("We must preserve `request_id` across retries")).toBe(1);
    const r = doc("## Decisions\n\n- We must preserve `request_id` across retries because customers use it to reconcile duplicate payments.\n- We must never log full card numbers because auditors treat them as regulated personal data.\n");
    expect(r.candidates.length).toBe(2);
  });
  it("citação externa ('RFC 9110 section 9.2'), 'Both X and Y' e perguntas abertas são tratados corretamente", () => {
    expect(doc("## Decision\n\nWe follow RFC 9110 section 9.2 and treat PUT requests as idempotent across every public endpoint.\n").candidates).toHaveLength(1);
    expect(doc("## Decision\n\nBoth PostgreSQL and SQLite require serialized migrations because concurrent schema changes can corrupt deployments.\n").candidates).toHaveLength(1);
    const q = doc("## Open questions\n\nShould retries use exponential backoff or a fixed interval for the payment provider integration?\n");
    expect(q.candidates).toHaveLength(1); expect(q.candidates[0]!.type).toBe("open-question");
  });
  it("Unicode: cabeçalho NFD e acentos nos marcadores ('será') dão o mesmo resultado que ASCII", () => {
    const nfc = doc("## Decisão\n\nO arquivo será preservado por contrato externo durante todo o período de retenção legal.\n");
    const nfd = doc("## Decisão".normalize("NFD") + "\n\nO arquivo será preservado por contrato externo durante todo o período de retenção legal.\n");
    const ascii = doc("## Decisao\n\nO arquivo sera preservado por contrato externo durante todo o periodo de retencao legal.\n");
    expect(nfc.candidates).toHaveLength(1); expect(nfd.candidates).toHaveLength(1); expect(ascii.candidates).toHaveLength(1);
  });
  it("limite por seção é aplicado DEPOIS da avaliação: itens deíticos não ocupam as vagas dos válidos", () => {
    const r = doc("## Decisions\n\n- This must be reviewed carefully by the responsible team before every release cycle.\n- It must be approved by the security group before any production deployment happens.\n- They must be documented in the runbook with the owner and the escalation path described.\n- Audit retention must be seven years for every regulated customer record stored in the platform.\n");
    expect(r.candidates.map((c) => c.title).join(" ")).toMatch(/Audit retention/);
  });
  it("segredo rejeitado não aparece no relatório (corpo, evidência nem título)", async () => {
    const b = await tempBrain(); const { importText } = await import("../src/index.js");
    const tok = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const rep = await importText(b, `# P\n\n## Armadilhas conhecidas\nAtenção: o token ${tok} vaza em logs; cuidado ao imprimir variáveis de ambiente do servidor.\n`, { dryRun: true });
    expect(JSON.stringify(rep)).not.toContain(tok); expect(rep.items[0]?.status).toBe("rejected");
    b.close();
  });
  it("--loose agrupa listas curtas (recall opcional) em vez de descartá-las", () => {
    const md = "# Doc\n\n## Decisões já aprovadas\n\n- Telegram é uma fonte, não o domínio do produto.\n- O catálogo é global e independe de matches atuais.\n- Matching é conservador e evita false merge.\n";
    expect(extractCandidates(md, "docs/d.md", {}).candidates).toEqual([]);
    const loose = extractCandidates(md, "docs/d.md", { loose: true }).candidates;
    expect(loose).toHaveLength(1); expect(loose[0]!.flags).toContain("group");
  });
});

describe("referência interna com § ", () => {
  it("'§9/§6.2' remete a outras seções do documento e é descartado", () => {
    const r = doc("## Decisões\n\n- Reativação transiciona revoked para joining e reexecuta o mesmo fluxo técnico do §9, nunca um atalho direto para active.\n- Cada fonte nova deve ter aprovação manual do owner antes de ficar ativa para qualquer usuário.\n");
    expect(r.candidates.map((c) => c.title).join(" ")).not.toMatch(/Reativação/);
    expect(r.candidates.map((c) => c.title).join(" ")).toMatch(/aprovação manual/);
  });
});
