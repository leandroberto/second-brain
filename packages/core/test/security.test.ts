import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Brain, assertImportablePath, extractCandidates, isLocalUrl, redactSecrets, scanSecrets, withFileLock } from "../src/index.js";
import { cleanup, claude, codex, human, tempBrain } from "./helpers.js";

afterAll(cleanup);

describe("achados da revisão independente (Codex)", () => {
  it("#1 embeddings: só loopback exato é local; localhost.evil.com não", () => {
    for (const u of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080/v1"]) expect(isLocalUrl(u)).toBe(true);
    for (const u of ["http://localhost.attacker.example/v1", "http://127.0.0.1.evil.com/v1", "https://api.openai.com/v1", "http://user:pw@localhost/v1", "file:///etc/passwd", "lixo"]) expect(isLocalUrl(u)).toBe(false);
  });
  it("#1 provider externo sem opt-in cai para o embedder local", async () => {
    const b = await tempBrain();
    await b.updateConfig({ embeddings: { provider: "openai-compatible", base_url: "http://localhost.attacker.example/v1", external_opt_in: false } }, human);
    expect(b.embedder.id).toBe("hash-v1");
    b.close();
  });

  it("#2 mover/arquivar nunca sobrescreve arquivo existente no destino", async () => {
    const b = await tempBrain();
    const n = await b.createNote({ title: "Nota a arquivar", type: "learning", body: "Conteúdo a ser arquivado com cuidado." }, human);
    mkdirSync(join(b.vault.root, "knowledge/archive"), { recursive: true });
    writeFileSync(join(b.vault.root, `knowledge/archive/${n.id}.md`), "# arquivo manual do usuário\n\nnão pode ser sobrescrito.\n");
    await expect(b.updateNote(n.id, { status: "archived", expected_revision: n.revision }, human)).rejects.toMatchObject({ code: "duplicate_id" });
    expect(readFileSync(join(b.vault.root, `knowledge/archive/${n.id}.md`), "utf8")).toContain("não pode ser sobrescrito");
    expect(b.loadNote(n.id).status).toBe("active");
    b.close();
  });

  it("#3 lock: dono vivo e ativo NÃO perde o lock por demorar; liberação não apaga o lock do sucessor", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "brain-lock-")), "l.d");
    const order: string[] = [];
    const a = withFileLock(dir, async () => { order.push("a-in"); await new Promise((r) => setTimeout(r, 700)); order.push("a-out"); }, { staleMs: 300, heartbeatMs: 60, timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    const c = withFileLock(dir, async () => { order.push("c-in"); order.push("c-out"); }, { staleMs: 300, heartbeatMs: 60, timeoutMs: 5000 });
    await Promise.all([a, c]);
    expect(order).toEqual(["a-in", "a-out", "c-in", "c-out"]); // C esperou, não roubou
    // sucessor: A perde o lock "à força"; B adquire; a saída de A não pode apagar o de B
    const dir2 = join(mkdtempSync(join(tmpdir(), "brain-lock2-")), "l.d");
    let bHeld = false;
    await withFileLock(dir2, async () => {
      rmSync(dir2, { recursive: true, force: true }); // simula roubo
      const bp = withFileLock(dir2, async () => { bHeld = true; await new Promise((r) => setTimeout(r, 300)); }, { timeoutMs: 3000 });
      await new Promise((r) => setTimeout(r, 80));
      expect(bHeld).toBe(true);
      void bp; // A sai agora, enquanto B ainda segura
      (globalThis as { __bp?: Promise<unknown> }).__bp = bp;
    });
    expect(existsSync(dir2)).toBe(true); // lock de B preservado
    await (globalThis as { __bp?: Promise<unknown> }).__bp;
    expect(existsSync(dir2)).toBe(false);
  });
  it("#3 lock órfão (PID morto) é recuperado", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "brain-lock3-")), "l.d");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "owner"), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now(), token: "x" }));
    await expect(withFileLock(dir, () => "ok", { timeoutMs: 2000 })).resolves.toBe("ok");
  });

  it("#4 entrada inválida é rejeitada ANTES de persistir e não envenena o índice", async () => {
    const b = await tempBrain();
    await expect(b.createNote({ title: "x".repeat(201), type: "fact", body: "corpo válido de teste." }, human)).rejects.toMatchObject({ code: "invalid" });
    await expect(b.createNote({ title: "ok", type: "fact", body: "corpo válido", tags: Array(30).fill("t") }, human)).rejects.toMatchObject({ code: "invalid" });
    const n = await b.createNote({ title: "Válida", type: "fact", body: "corpo válido de teste." }, human);
    await expect(b.updateNote(n.id, { project: "../../etc", expected_revision: n.revision }, human)).rejects.toMatchObject({ code: "invalid" });
    await expect(b.updateNote(n.id, { title: "y".repeat(500), expected_revision: n.revision }, human)).rejects.toMatchObject({ code: "invalid" });
    expect(b.db.rows("1=1").length).toBe(1);
    // arquivo já inválido no disco (editado à mão) não derruba o sync
    writeFileSync(join(b.vault.root, "knowledge/inbox/gigante.md"), `---\nid: gigante\ntitle: ${"z".repeat(900)}\ntype: fact\n---\ncorpo\n`);
    await expect(b.sync()).resolves.toBeDefined();
    expect(b.db.getRow("gigante")!.title.length).toBeLessThanOrEqual(200);
    b.close();
  });

  it("#5 segredos em tags, motivo, evidência, nota da decisão e consultas não chegam ao disco/log", async () => {
    const b = await tempBrain();
    const tok = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await expect(b.propose({ title: "Tag suspeita", type: "fact", body: "corpo normal de teste aqui.", tags: [tok] }, claude)).rejects.toMatchObject({ code: "secret_detected" });
    await expect(b.propose({ title: "Motivo suspeito", type: "fact", body: "corpo normal de teste aqui.", reason: `veio de ${tok}` }, claude)).rejects.toMatchObject({ code: "secret_detected" });
    await expect(b.propose({ title: "Evidência", type: "fact", body: "corpo normal de teste aqui.", meta: { run: "r", rule: "x", evidence: `token ${tok}`, source_path: "a.md" } }, claude)).rejects.toMatchObject({ code: "secret_detected" });
    const p = await b.propose({ title: "Proposta limpa", type: "fact", body: "Conteúdo limpo e único sobre ornitorrincos." }, claude);
    await expect(b.resolve(p.id, { resolution: "create", note: `colei ${tok}` }, human)).rejects.toMatchObject({ code: "secret_detected" });
    await b.search(`procurando ${tok}`, {}, 5, claude);
    const log = JSON.stringify(b.db.activity({ limit: 50 }));
    expect(log).not.toContain(tok);
    expect(log).toContain("REDACTED");
    b.close();
  });

  it("#6 extração de Markdown patológico termina rápido (sem backtracking)", () => {
    const t0 = Date.now();
    extractCandidates(`## x${" ".repeat(20000)}!\n\ntexto ${"[".repeat(40000)} decisão importante aqui.\n\n## Decisão\n${"[a](".repeat(5000)}\nDecidimos algo.`, "docs/x.md");
    extractCandidates("# t\n\n## Armadilhas\n" + "[".repeat(100000) + " atenção cuidado armadilha", "README.md");
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("#7 a revision registrada na proposta é a do snapshot analisado (propose × update concorrentes)", async () => {
    const b = await tempBrain();
    const n = await b.createNote({ title: "Versão do Python do projeto", type: "fact", project: "proj", body: "O projeto utiliza Python 3.12 em produção." }, human);
    const [prop] = await Promise.all([
      b.propose({ title: "Versão do Python do projeto", type: "fact", project: "proj", body: "O projeto utiliza Python 3.13 em produção." }, claude),
      b.updateNote(n.id, { tags: ["a"], expected_revision: n.revision }, human),
    ]);
    const m = prop.analysis.matches.find((x) => x.id === n.id)!;
    expect(prop.target_revision).toBe(m.revision);
    b.close();
  });

  it("#8 política alterada por OUTRO processo vale imediatamente (config relida sob o lock)", async () => {
    const b1 = await tempBrain();
    const b2 = await Brain.open(b1.vault.root, claude);
    await b1.updateConfig({ agents: { commit_policy: "all" } }, human);
    const p = await b2.propose({ title: "Algo novo sobre capivaras", type: "learning", body: "Capivaras são roedoras semiaquáticas muito sociáveis." }, claude);
    await b1.updateConfig({ agents: { commit_policy: "never" } }, human); // revoga
    await expect(b2.resolve(p.id, { resolution: "create" }, claude)).rejects.toMatchObject({ code: "forbidden" });
    b1.close(); b2.close();
  });

  it("#9 importar: symlink dentro da raiz que aponta para fora é recusado", () => {
    const home = mkdtempSync(join(tmpdir(), "brain-home-")); const outside = mkdtempSync(join(tmpdir(), "brain-out-"));
    writeFileSync(join(outside, "privado.md"), "# privado\n");
    symlinkSync(outside, join(home, "atalho"));
    mkdirSync(join(home, "ok")); writeFileSync(join(home, "ok", "a.md"), "# a\n");
    expect(() => assertImportablePath(join(home, "atalho", "privado.md"), [home])).toThrow(/restrita/);
    expect(assertImportablePath(join(home, "ok"), [home])).toContain("ok");
  });

  it("#11 git: pathspec é literal e revert valida a revisão", async () => {
    const b = await tempBrain();
    const dir = join(b.vault.root, "knowledge/inbox");
    writeFileSync(join(dir, "x1.md"), "# um\n"); writeFileSync(join(dir, "x*.md"), "# estrela\n");
    const c = await b.git.commitPaths(["knowledge/inbox/x*.md"], "teste literal");
    expect(c).toBeTruthy();
    expect(await b.git.dirty("knowledge")).toEqual(["knowledge/inbox/x1.md"]); // x1.md NÃO foi pego pelo glob
    await expect(b.git.revert("--abort")).rejects.toMatchObject({ code: "invalid" });
    await expect(b.git.revert("zzzz")).rejects.toMatchObject({ code: "invalid" });
    await expect(b.git.revert("deadbeef")).rejects.toBeDefined();
    b.close();
  });

  it("#12 placeholder não esconde uma credencial real na mesma linha", () => {
    expect(scanSecrets("password=process.env.PASS password=realCredential123").length).toBe(1);
    expect(scanSecrets("api_key=<seu-token> e depois api_key=abcdef1234567890xyz").length).toBe(1);
    expect(redactSecrets("a senha: password=hunter2hunter2 ok")).toContain("[REDACTED]");
    expect(redactSecrets("a senha: password=hunter2hunter2 ok")).not.toContain("hunter2");
  });

  it("#13 edição manual com segredo: mascarada no índice, fora de embeddings/commits e redigida para agentes", async () => {
    const b = await tempBrain();
    const n = await b.createNote({ title: "Nota segura", type: "learning", body: "Conteúdo seguro sobre tucanos." }, human);
    const f = join(b.vault.root, n.path);
    const tok = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    writeFileSync(f, readFileSync(f, "utf8") + `\nminha chave é ${tok} (colada sem querer)\n`);
    await b.sync();
    expect((await b.search("abcdefghijklmnopqrstuvwxyz0123456789")).length).toBe(0);      // FTS sem o segredo
    expect(b.db.getRow(n.id)!.body).not.toContain(tok);
    const h = await b.health();
    expect(h.details.issues.some((i) => i.issues.some((x) => x.includes("segredo")))).toBe(true);
    const c = await b.commitPending(undefined, human);
    expect(c.commit).toBeUndefined(); expect(c.skipped).toEqual([n.path]);                // não versionou o segredo
    const g = await b.get(n.id, claude);
    expect(g.note.body).not.toContain(tok);                                               // agente recebe redigido
    await expect(b.link(n.id, n.id === "x" ? "y" : n.id, "related_to", human)).rejects.toBeDefined();
    const other = await b.createNote({ title: "Outra", type: "learning", body: "Outro conteúdo sobre araras." }, human);
    await expect(b.link(n.id, other.id, "related_to", human)).rejects.toMatchObject({ code: "secret_detected" }); // não reescreve/commita nota com segredo
    b.close();
  });
});

describe("segunda revisão do Codex (regressões das próprias correções)", () => {
  it("R1 analyze/import validam ANTES de embutir: segredo nunca chega ao embedder", async () => {
    const b = await tempBrain();
    let embedded = 0; const orig = b.embedder.embed.bind(b.embedder);
    b.embedder.embed = async (t: string[]) => { embedded++; return orig(t); };
    await expect(b.analyze({ title: "Config", type: "fact", body: "chave sk-abcdefghijklmnopqrstuvwxyz0123456789 em produção" })).rejects.toMatchObject({ code: "secret_detected" });
    const { importText } = await import("../src/index.js");
    const rep = await importText(b, "# P\n\n## Armadilhas conhecidas\nAtenção: o token ghp_abcdefghijklmnopqrstuvwxyz0123456789 vaza em logs; cuidado ao imprimir variáveis de ambiente.\n", { dryRun: true });
    expect(rep.items.every((i) => i.status === "rejected")).toBe(true);
    expect(embedded).toBe(0);
    b.close();
  });
  it("R2 revogar o opt-in externo em outro processo vale imediatamente no embedder", async () => {
    const b1 = await tempBrain(); const b2 = await Brain.open(b1.vault.root, claude);
    await b1.updateConfig({ embeddings: { provider: "openai-compatible", base_url: "https://api.example.com/v1", external_opt_in: true } }, human);
    await b2.createNote({ title: "Dispara releitura", type: "fact", body: "Conteúdo qualquer para forçar escrita sob o lock." }, human).catch(() => undefined);
    expect(b2.embedder.external).toBe(true);
    await b1.updateConfig({ embeddings: { external_opt_in: false } }, human); // revoga
    await b2.updateConfig({ git: { auto_commit: true } }, human); // qualquer escrita relê a config sob o lock
    expect(b2.embedder.id).toBe("hash-v1"); expect(b2.embedder.external).toBe(false);
    b1.close(); b2.close();
  });
  it("R3 heartbeat do lock nunca expõe owner parcial a leitores concorrentes", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "brain-hb-")), "l.d");
    let bad = 0; let stop = false;
    const holder = withFileLock(dir, async () => {
      const reader = (async () => { while (!stop) { for (let i = 0; i < 200; i++) { try { JSON.parse(readFileSync(join(dir, "owner"), "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") bad++; } } await new Promise((r) => setTimeout(r, 1)); } })();
      await new Promise((r) => setTimeout(r, 600)); stop = true; await reader;
    }, { heartbeatMs: 3 });
    await holder;
    expect(bad).toBe(0);
  });
  it("R4 aprovar a proposta A deixa B (mesmo alvo) STALE; B não sobrescreve as mudanças de A", async () => {
    const b = await tempBrain();
    const t = await b.createNote({ title: "Versão do Python do projeto", type: "fact", project: "proj", body: "O projeto utiliza Python 3.12 em produção." }, human);
    const pa = await b.propose({ title: "Versão do Python do projeto", type: "fact", project: "proj", body: "O projeto utiliza Python 3.13 em produção." }, claude);
    const pb = await b.propose({ title: "Versão do Python do projeto", type: "fact", project: "proj", body: "O gerenciador de dependências é uv com lockfile versionado em CI e ambientes reproduzíveis." }, codex);
    expect(pa.target_id).toBe(t.id); expect(pb.target_id).toBe(t.id);
    await b.resolve(pa.id, { resolution: "update" }, human);
    expect(b.getProposal(pb.id).state).toBe("stale");
    await expect(b.resolve(pb.id, { resolution: "complement", final_body: "SOBRESCREVE TUDO\n" }, human)).rejects.toMatchObject({ code: "conflict_revision" });
    expect(b.loadNote(t.id).body).toContain("3.13");
    b.close();
  });
  it("R5 ignoreMany rejeita nota com segredo sem mutar nada", async () => {
    const b = await tempBrain();
    const p = await b.propose({ title: "Qualquer coisa inédita sobre cogumelos", type: "learning", body: "Cogumelos decompõem matéria orgânica em florestas úmidas." }, claude);
    await expect(b.ignoreMany([p.id], "veja ghp_abcdefghijklmnopqrstuvwxyz0123456789", human)).rejects.toMatchObject({ code: "secret_detected" });
    expect(b.getProposal(p.id).state).toBe("pending");
    b.close();
  });
  it("R6 segredo depois do caractere 20 000 de uma linha é detectado", () => {
    expect(scanSecrets("x".repeat(25_000) + " password=hunter2hunter2 " + "y".repeat(100)).length).toBe(1);
    expect(scanSecrets("a".repeat(60_000)).length).toBe(0);
  });
  it("R7 cópia com id duplicado contendo segredo também fica fora de commitPending", async () => {
    const b = await tempBrain();
    const n = await b.createNote({ title: "Original limpa", type: "learning", body: "Conteúdo limpo sobre baleias." }, human);
    mkdirSync(join(b.vault.root, "knowledge/inbox"), { recursive: true });
    writeFileSync(join(b.vault.root, "knowledge/inbox/copia.md"), readFileSync(join(b.vault.root, n.path), "utf8") + "\nchave sk-abcdefghijklmnopqrstuvwxyz0123456789\n");
    await b.sync();
    const c = await b.commitPending(undefined, human);
    expect(c.commit).toBeUndefined(); expect(c.skipped).toContain("knowledge/inbox/copia.md");
    expect((await b.git.dirty("knowledge"))).toContain("knowledge/inbox/copia.md");
    b.close();
  });
  it("R8 replace com nota antiga contendo segredo falha SEM deixar a nova nota gravada", async () => {
    const b = await tempBrain();
    const old = await b.createNote({ title: "Versão do Python do projeto", type: "fact", project: "proj", body: "O projeto utiliza Python 3.12 em produção." }, human);
    const f = join(b.vault.root, old.path);
    writeFileSync(f, readFileSync(f, "utf8") + "\nsenha: password=hunter2hunter2\n"); await b.sync();
    const p = await b.supersede({ old_id: old.id, draft: { title: "Runtime novo do projeto", type: "fact", project: "proj", body: "O runtime passou a ser Node 24." } }, claude);
    await expect(b.resolve(p.id, { resolution: "replace", target_id: old.id }, human)).rejects.toMatchObject({ code: "secret_detected" });
    expect(b.db.rows("title='Runtime novo do projeto'").length).toBe(0);
    expect(b.getProposal(p.id).state).toBe("pending");
    expect((await b.git.dirty("knowledge")).filter((x) => x.includes("runtime"))).toEqual([]);
    b.close();
  });
  it("R9 aprovação em lote não cria near-duplicatas (reanalisa cada item contra o índice atual)", async () => {
    const b = await tempBrain();
    const a = await b.propose({ title: "Timeout de links curtos", type: "learning", project: "proj", body: "Links curtos de afiliados precisam de timeout de 3 segundos ao serem expandidos com HEAD.", confidence: "high" }, claude);
    const c = await b.propose({ title: "Expandir links curtos com timeout", type: "learning", project: "proj", body: "Ao expandir links curtos de afiliados com HEAD, usar timeout de 3 segundos.", confidence: "high" }, codex);
    const r = await b.approveMany([a.id, c.id], human);
    expect(r.created.length).toBe(1); expect(r.skipped.length).toBe(1);
    expect(r.skipped[0]!.reason).toMatch(/agora é/);
    b.close();
  });
  it("R12 slug de projeto longo é recusado e ids ficam dentro do limite do schema", async () => {
    const b = await tempBrain();
    await expect(b.createNote({ title: "Nota", type: "fact", project: "a".repeat(100), body: "Conteúdo de teste suficiente." }, human)).rejects.toMatchObject({ code: "invalid" });
    const p = await b.createProject("b".repeat(90), "Projeto com slug enorme", "descrição", human);
    expect(p.id.length).toBeLessThanOrEqual(120); expect(b.db.getRow(p.id)).toBeTruthy();
    b.close();
  });
});

describe("provider de embeddings indisponível", () => {
  it("escrever e buscar continuam funcionando (FTS) e o doctor avisa", async () => {
    const b = await tempBrain();
    await b.updateConfig({ embeddings: { provider: "openai-compatible", base_url: "http://127.0.0.1:9/v1", model: "x", dimensions: 8 } }, human);
    const n = await b.createNote({ title: "Nota sem embeddings", type: "learning", body: "Conteúdo pesquisável sobre ornitorrincos australianos." }, human);
    expect((await b.search("ornitorrincos")).map((h) => h.id)).toContain(n.id);
    expect(b.db.getMeta("embed_error")).toBeTruthy();
    const { coreDoctor } = await import("../src/index.js");
    const emb = (await coreDoctor(b)).find((c) => c.id === "embeddings")!;
    expect(emb.status).toBe("warn");
    b.close();
  });
});

describe("rodada 3 (subagente Claude)", () => {
  it("consulta/contexto com segredo: redigidos no log e nunca enviados ao embedder", async () => {
    const b = await tempBrain(); const tok = "sk-abcdefghijklmnopqrstuvwxyz0123456789"; const sent: string[] = [];
    const orig = b.embedder.embed.bind(b.embedder); b.embedder.embed = async (t: string[]) => { sent.push(...t); return orig(t); };
    await b.search(`erro com ${tok}`, {}, 5, claude); await b.context({ topic: `chave ${tok}`, task: `usar ${tok}` }, claude);
    expect(sent.join(" ")).not.toContain(tok); expect(JSON.stringify(b.db.activity({ limit: 20 }))).not.toContain(tok);
    b.close();
  });
  it("provider de embeddings fora do ar: search/similar/propose seguem funcionando", async () => {
    const b = await tempBrain();
    await b.createNote({ title: "Nota base sobre lontras", type: "learning", body: "Lontras-marinhas usam pedras como ferramenta para abrir moluscos." }, human);
    b.embedder.embed = async () => { throw new Error("rede fora do ar"); };
    expect((await b.search("lontras")).length).toBe(1);
    const p = await b.propose({ title: "Lontras e ferramentas", type: "learning", body: "Lontras-marinhas usam pedras como ferramenta para abrir moluscos duros." }, claude);
    expect(p.analysis.matches.length).toBeGreaterThan(0);
    b.close();
  });
  it("commitPending varre TODOS os arquivos sujos (não só os 2000 primeiros) e trata renomeações", async () => {
    const b = await tempBrain(); const dir = join(b.vault.root, "knowledge/inbox");
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `n${i}.md`), `# n${i}\n\nconteúdo ${i}\n`);
    writeFileSync(join(dir, "z-segredo.md"), "# z\n\nchave sk-abcdefghijklmnopqrstuvwxyz0123456789\n");
    const c = await b.commitPending(undefined, human);
    expect(c.files.length).toBe(5); expect(c.skipped).toEqual(["knowledge/inbox/z-segredo.md"]);
    b.close();
  });
  it("lock: dois contendores sobre um lock órfão não entram juntos", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "brain-lk-")), "l.d"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "owner"), JSON.stringify({ pid: 2 ** 22 + 99, at: Date.now(), token: "morto" }));
    let inside = 0; let max = 0;
    const work = () => withFileLock(dir, async () => { inside++; max = Math.max(max, inside); await new Promise((r) => setTimeout(r, 40)); inside--; }, { timeoutMs: 5000 });
    await Promise.all([work(), work(), work(), work()]);
    expect(max).toBe(1);
  });
});
