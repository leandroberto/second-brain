import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { Brain, principal } from "../packages/core/src/index.js";
import { issueHumanSession, startApi, type ApiHandle } from "../packages/api/src/index.js";
import { terminalHuman } from "../packages/core/test/helpers.js";
import { seedDemo } from "../packages/cli/src/seed.js";
import { importPath } from "../packages/core/src/index.js";
import { cleanupRepos, gitRepo } from "../packages/core/test/git-fixture.js";

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).filter((x) => x.startsWith("chromium-")).sort().reverse()) {
    const p = join(base, d, "chrome-linux64", "chrome"); if (existsSync(p)) return p;
  }
  return undefined;
}
const chrome = findChrome();
const api_get = async (p: string) => (await fetch(api.url + p, { headers: { authorization: `Bearer ${humanToken}` } })).json() as Promise<any[]>;
const nav = (hash: string) => page.evaluate((h) => { location.hash = h; }, hash);
let dir: string; let brain: Brain; let api: ApiHandle; let browser: Browser; let page: Page; let humanToken: string;

describe.skipIf(!chrome)("UI web (browser real)", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "brain-e2e-"));
    await seedDemo(join(dir, "vault"), {});
    brain = await Brain.open(join(dir, "vault"));
    const sessions = { file: join(dir, "ui-sessions.json") };
    api = await startApi(brain, { port: 0, webRoot: join(process.cwd(), "apps/web/dist"), sessions });
    humanToken = issueHumanSession(join(dir, "vault"), await terminalHuman("alice", sessions), sessions); // como `brain ui` num terminal
    // SwiftShader dá WebGL ao Chromium headless (grafo 3D)
    browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
    page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  });
  afterAll(async () => { await browser?.close(); await api?.close(); brain?.close(); rmSync(dir, { recursive: true, force: true }); cleanupRepos(); });
  // cada teste parte de um estado conhecido: documento novo com a sessão humana e sem ouvintes de um teste anterior que falhou
  // no meio (diálogo pendente, coletores de erro), para que uma falha não deixe a página no meio do fluxo para o seguinte
  beforeEach(async () => {
    for (const ev of ["dialog", "pageerror", "console"] as const) page.removeAllListeners(ev);
    await page.goto("about:blank");
    await page.goto(`${api.url}/#token=${humanToken}`);
    await page.getByRole("navigation", { name: "Principal" }).waitFor();
  });
  /** Espera o toast de uma decisão (some em 3,5 s: espere logo depois da ação). */
  const toast = (texto: RegExp) => page.locator(".toasts .toast").filter({ hasText: texto }).first().waitFor({ timeout: 15000 });
  /** Espera a UI sair da proposta decidida (ela navega para a próxima ou para a lista). */
  const saiuDe = (hash: string) => page.waitForFunction((h) => location.hash !== h, hash, { timeout: 15000 });

  it("abre o dashboard sem erros de console", async () => {
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    // token de AGENTE (api-token do vault): a UI abre só para leitura/proposta e avisa (documento novo: o token do hash vale)
    await page.goto("about:blank");
    await page.goto(`${api.url}/#token=${api.token}`);
    await page.getByTestId("readonly-banner").waitFor();
    await page.goto(`${api.url}/#token=${humanToken}`);
    await page.reload();
    await page.getByText("Precisa de revisão").first().waitFor();
    expect(await page.getByTestId("readonly-banner").count()).toBe(0);
    expect(await page.getByText("Conhecimentos").count()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it("paleta Ctrl+K encontra conhecimento", async () => {
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder(/Buscar conhecimento/).fill("identidade listings");
    await page.getByRole("option", { name: /Resolução de identidade/ }).waitFor();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Resolução de identidade de listings" }).waitFor();
  });

  it("Review Queue: aprova atualização e o Markdown + Git refletem", async () => {
    await nav("#/review");
    await page.getByRole("link", { name: /Versão do Python do projeto/ }).click();
    await page.getByRole("button", { name: /^Atualizar Corrige/ }).click();
    await page.getByText("Prévia do resultado").waitFor();
    const naProposta = await page.evaluate(() => location.hash);
    await page.getByRole("button", { name: /Atualizar e persistir/ }).click();
    await toast(/^Persistido/);
    await saiuDe(naProposta); // a UI concluiu a navegação pós-decisão
    const note = brain.db.getRow("fact-promo-watcher-versao-do-python-do-projeto")!;
    await vi.waitFor(() => expect(readFileSync(join(brain.vault.root, note.path), "utf8")).toContain("Python 3.13"), { timeout: 10000 });
    const file = readFileSync(join(brain.vault.root, note.path), "utf8");
    expect(file).toContain("Python 3.13");
    expect(file).not.toContain("Python 3.12");
    await vi.waitFor(async () => expect((await brain.git.log(note.path, 1))[0]!.subject).toMatch(/^brain: update fact/), { timeout: 10000 });
  });

  it("Review Queue: substituir preserva o antigo como superseded", async () => {
    await nav("#/review");
    await page.getByRole("link", { name: /Janela de cancelamento/ }).click();
    await page.getByRole("button", { name: /^Substituir Novo/ }).click();
    const naProposta = await page.evaluate(() => location.hash);
    await page.getByRole("button", { name: /Substituir e persistir/ }).click();
    await toast(/^Persistido/);
    await saiuDe(naProposta);
    await vi.waitFor(() => expect(brain.loadNote("decision-menu-litoral-janela-de-cancelamento-de-pedidos").status).toBe("superseded"), { timeout: 10000 });
    const old = brain.loadNote("decision-menu-litoral-janela-de-cancelamento-de-pedidos");
    expect(old.status).toBe("superseded");
    expect(old.relations.superseded_by?.length).toBe(1);
  });

  it("Importar: colar Markdown, analisar, enviar candidatos à Review Queue", async () => {
    await nav("#/import");
    await page.getByLabel(/Cole Markdown/).fill("# Projeto X\n\nVisão geral do projeto fictício X para teste.\n\n## Armadilhas conhecidas\nAtenção: o cache do edge ignora o cabeçalho Vary; cuidado ao servir conteúdo por idioma, senão mistura idiomas.\n");
    await page.getByRole("button", { name: "Analisar" }).click();
    await page.getByText(/candidato\(s\) em/).waitFor();
    const before = (await api_get("/api/proposals")).length;
    await page.getByRole("button", { name: /Enviar \d+ para a Review Queue/ }).click();
    await page.getByText("Fila de revisão").waitFor();
    expect((await api_get("/api/proposals")).length).toBeGreaterThan(before);
  });

  it("Review Queue: caixa Validade mostra evidência de atualidade e 'Aceitar sugestão' decide num clique", async () => {
    const D = (x: string) => `${x}T12:00:00+00:00`;
    const { root } = gitRepo([
      { date: D("2026-01-10"), msg: "docs", files: { "docs/specs/2026-01-10-ident-design.md": "# Identidade\n\n## Decisão\n\nO resolver de ofertas deve usar `catalog_id` como identidade do produto, porque o catálogo agrupa variantes.\n", "docs/specs/2026-01-11-fila-design.md": "# Fila\n\n## Decisões\n\nA ingestão deve usar `IngestQueue` com Kafka para desacoplar o resolver, porque picos travam o worker.\n" } },
      { date: D("2026-01-15"), msg: "feat: resolver", files: { "src/resolver.ts": "export const r = (o: { catalog_id: string }) => o.catalog_id;\n" } },
      { date: D("2026-03-01"), msg: "refactor: listing", files: { "src/resolver.ts": "export const r = (o: { listing_id: string }) => o.listing_id;\n", "docs/specs/2026-03-01-listing-design.md": "# Listing\n\nMigramos o resolver de `catalog_id` para `listing_id` porque o catálogo fragmentava ofertas.\n" } },
    ], "lojinha");
    await importPath(brain, root, { project: "lojinha" });
    const props = await api_get("/api/proposals");
    const planned = props.find((p) => p.freshness?.state === "planned" && /IngestQueue/.test(p.draft.body));
    const old = props.find((p) => /superseded|historical/.test(p.freshness?.state ?? ""));
    expect(planned && old).toBeTruthy();
    await nav(`#/review/${planned.id}`);
    const box = page.getByRole("region", { name: "Validade" });
    await box.waitFor({ timeout: 5000 });
    await box.getByText("planejado").first().waitFor({ timeout: 5000 });
    await box.locator("details").evaluate((d) => { (d as HTMLDetailsElement).open = true; });
    await box.getByText(/IngestQueue/).first().waitFor({ timeout: 5000 });
    await box.getByRole("button", { name: /Aceitar: ignorar \(plano sem implementação\)/ }).click();
    await vi.waitFor(() => expect(brain.getProposal(planned.id).state).toBe("ignored"), { timeout: 10000 });
    // "Aceitar" navega para a próxima proposta: espera essa navegação terminar antes de abrir a outra (evita corrida sob carga)
    await page.waitForFunction((pid) => !location.hash.includes(pid), planned.id, { timeout: 15000 });
    await nav(`#/review/${old.id}`);
    await page.getByRole("heading", { name: old.draft.title }).first().waitFor({ timeout: 15000 });
    await page.getByRole("region", { name: "Validade" }).getByRole("button", { name: /guardar como histórico|anexar como histórico/ }).click();
    await vi.waitFor(async () => { const d = brain.getProposal(old.id); expect(d.state).toBe("accepted"); await brain.sync(); if (d.decided?.resolution === "create") expect(brain.db.getRow(d.decided.result_id!)?.status).toBe("superseded"); }, { timeout: 10000 });
  }, 90_000); // a suíte completa roda em paralelo com testes pesados de git: margem para máquina carregada

  it("Inbox: seleciona as novas e aprova em lote (um commit, confirmação explícita)", async () => {
    await nav("#/inbox");
    await page.getByRole("button", { name: /Selecionar elegíveis/ }).click();
    const before = brain.db.rows("1=1", [], "id", 1000).length;
    let confirmacao = ""; // aceita sempre (uma asserção no ouvinte deixaria o diálogo aberto); a mensagem é conferida depois
    page.once("dialog", (d) => { confirmacao = d.message(); void d.accept(); });
    await page.getByRole("button", { name: /Aprovar \d+ em lote/ }).click();
    await toast(/^\d+ criado\(s\)/); // a UI recebeu a resposta e recarregou a lista
    expect(confirmacao).toMatch(/Criar \d+ conhecimento/);
    await vi.waitFor(async () => { await brain.sync(); expect(brain.db.rows("1=1", [], "id", 1000).length).toBeGreaterThan(before); }, { timeout: 10000 });
    await vi.waitFor(async () => expect((await brain.git.log(undefined, 1))[0]!.subject).toMatch(/bulk approve/), { timeout: 10000 });
  });

  it("Home mostra Entrou recentemente e Desfazer remove a nota", async () => {
    const errors: string[] = []; const onErr = (e: Error) => errors.push(String(e)); page.on("pageerror", onErr);
    await brain.updateConfig({ agents: { commit_policy: "additive" } }, await terminalHuman("alice"));
    const p = await brain.propose({ title: "Observação inédita sobre capivaras", type: "learning", body: "Capivaras dividem o território com garças, que pousam nas costas delas." }, principal("agent", "claude-code", "mcp"));
    const id = p.auto!.note_id!;
    expect(brain.db.getRow(id)).toBeTruthy();
    await nav("#/"); await page.reload();
    const card = page.getByRole("region", { name: "Entrou recentemente" });
    const item = card.getByTestId("recent-write").filter({ hasText: "Observação inédita sobre capivaras" });
    await item.waitFor({ timeout: 10000 });
    expect(await item.innerText()).toMatch(/claude-code/);
    expect(await item.getByRole("link", { name: /capivaras/ }).getAttribute("href")).toBe(`#/note/${id}`);
    await item.getByRole("button", { name: /^Desfazer/ }).click();
    await vi.waitFor(async () => { await brain.sync({ force: true }); expect(brain.db.getRow(id)).toBeUndefined(); }, { timeout: 10000 });
    await item.waitFor({ state: "detached", timeout: 10000 });
    // página própria
    await nav("#/recent");
    await page.getByRole("heading", { name: "Entrou recentemente" }).waitFor();
    expect(await page.getByTestId("recent-write").filter({ hasText: "capivaras" }).count()).toBe(0);
    page.off("pageerror", onErr); expect(errors).toEqual([]);
  });

  it("paleta Ctrl+K abre Anotar… e Perguntar…", async () => {
    await nav("#/");
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder(/Buscar conhecimento/).fill("Anotar");
    await page.getByRole("option", { name: /^Anotar…/ }).click();
    const dlg = page.getByRole("dialog", { name: "Anotar" }); await dlg.waitFor();
    expect(await dlg.getByRole("tab", { name: "Anotar" }).getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("Escape"); await dlg.waitFor({ state: "detached" });
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder(/Buscar conhecimento/).fill("Perguntar");
    await page.getByRole("option", { name: /^Perguntar…/ }).click();
    expect(await page.getByRole("dialog", { name: "Perguntar" }).getByRole("tab", { name: "Perguntar" }).getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("Escape");
  });

  it("criar conhecimento manualmente avisa sobre semelhantes", async () => {
    await nav("#/");
    await page.getByRole("button", { name: "+ Adicionar" }).click();
    await page.getByLabel("Título").fill("Decisão de fila para notificações");
    await page.getByLabel(/Conteúdo/).fill("Notificações passam por fila durável com retry exponencial para evitar perda quando o Telegram limita.");
    await page.getByText(/semelhante/i).first().waitFor();
    await page.getByRole("button", { name: "Enviar para revisão" }).click();
    await page.getByText("Fila de revisão").waitFor();
  });
  // O grafo 3D renderiza a cada quadro (bloom) em WebGL por software (SwiftShader): sem GPU, cada ação do Playwright fica lenta
  // e o teste inteiro levava de 16 a 31 s, perto ou além dos 30 s padrão. Esperas por condição observável (o `data-state="ready"`
  // que o componente já expõe depois dos dois primeiros quadros, a contagem dos rótulos) com prazo próprio, e o teste com o seu.
  it("Grafo 3D: núcleos por projeto, destaque, foco e alternância para 2D sem erros", async () => {
    const PRONTO_MS = 30_000;
    const errors: string[] = []; const onErr = (e: Error) => errors.push(String(e)); const onCon = (m: { type(): string; text(): string }) => { if (m.type() === "error") errors.push(m.text()); };
    page.on("pageerror", onErr); page.on("console", onCon);
    try {
      await page.evaluate(() => { try { localStorage.removeItem("brain.graph.view"); } catch { /* ok */ } });
      await nav("#/graph");
      const g = page.locator('[data-testid="graph3d"]');
      await g.and(page.locator('[data-state="ready"]')).waitFor({ timeout: PRONTO_MS });
      expect(await g.locator("canvas").count()).toBe(1);
      const projects = new Set(brain.db.rows("status!='archived'", [], "id", 1000).map((r) => r.project ?? "_"));
      expect(await g.locator(".g3d-chip").count()).toBe(projects.size);
      await expect.poll(() => g.locator(".g3d-label.hub").count(), { timeout: PRONTO_MS }).toBe(projects.size);
      // destaque por texto conta só os nós que casam
      await g.getByLabel("Destacar conhecimentos no grafo").fill("listings");
      await expect.poll(async () => Number(await g.locator(".g3d-search em").textContent()), { timeout: PRONTO_MS }).toBeGreaterThan(0);
      await g.getByLabel("Destacar conhecimentos no grafo").fill("");
      // foco de projeto liga/desliga
      const chip = g.locator(".g3d-chip").first(); await chip.click(); expect(await chip.getAttribute("aria-pressed")).toBe("true");
      await chip.click(); expect(await chip.getAttribute("aria-pressed")).toBe("false");
      await g.getByRole("button", { name: /Rotação/ }).click(); expect(await g.getByRole("button", { name: /Rotação/ }).getAttribute("aria-pressed")).toBe("false");
      // alternância 2D e volta (a preferência fica no navegador)
      await page.getByRole("group", { name: "Visualização" }).getByRole("button", { name: "2D" }).click();
      const g2 = page.getByTestId("graph2d"); await g2.waitFor(); expect(await g.count()).toBe(0);
      // 2D: projetos como agrupamentos; o selo da ligação explica o porquê (nota que cita o outro projeto) e o clique fixa
      expect(await g2.locator(".g2d-label").allTextContents()).toEqual(expect.arrayContaining([expect.stringMatching(/^Promo Watcher/), expect.stringMatching(/^Second Brain/)]));
      const badge = g2.getByTestId("xlink-badge").first(); await badge.hover();
      const card = g2.locator(".g2d-card"); await card.waitFor();
      expect(await card.innerText()).toMatch(/Promo Watcher → cita Second Brain[\s\S]*a decisão vai para o Second Brain/);
      await badge.click(); await page.mouse.move(5, 5); await card.getByRole("button", { name: /abrir/ }).first().waitFor();
      await page.reload(); await g2.waitFor();
      await page.getByRole("group", { name: "Visualização" }).getByRole("button", { name: "3D" }).click();
      await g.and(page.locator('[data-state="ready"]')).waitFor({ timeout: PRONTO_MS });
    } finally {
      page.off("pageerror", onErr); page.off("console", onCon);
    }
    expect(errors).toEqual([]);
  }, 120_000);

  it("Vizinhança da nota, sugestão de relação registrada pelo revisor e filtros do 2D na URL", async () => {
    const errors: string[] = []; const onErr = (e: Error) => errors.push(String(e)); page.on("pageerror", onErr);
    const q = brain.db.rows("type='open-question'", [], "id", 10).find((r) => r.title.startsWith("Como lidar com timeouts"))!;
    await nav(`#/note/${q.id}`);
    await page.getByRole("tab", { name: "Vizinhança" }).click();
    const lg = page.getByTestId("local-graph"); await lg.waitFor();
    await lg.getByTestId("local-center").waitFor();
    await expect.poll(async () => await lg.locator(".lg-edge.mention").count()).toBeGreaterThan(0); // cita o Second Brain
    // sugestão (derivada do texto) → o REVISOR registra; depois some
    const sug = page.getByTestId("suggestions"); await sug.waitFor();
    expect(await sug.innerText()).toMatch(/Second Brain[\s\S]*a decisão vai para o Second Brain/);
    await sug.getByRole("button", { name: "Registrar relação" }).click();
    await expect.poll(() => page.getByTestId("suggestions").count()).toBe(0);
    expect(brain.loadNote(q.id).relations.references).toContain("project-second-brain");
    // ligação entre projetos ainda só derivada → registrar pelo cartão fixado a torna "registrada" (linha cheia)
    await nav("#/graph?view=2d");
    const g2 = page.getByTestId("graph2d"); await g2.waitFor();
    expect(await g2.locator(".g2d-xlink.confirmed").count()).toBe(0);
    await g2.getByTestId("xlink-badge").first().click(); await page.mouse.move(5, 5);
    await g2.locator(".g2d-card").getByRole("button", { name: "Registrar relação" }).click();
    await expect.poll(() => g2.locator(".g2d-xlink.confirmed").count()).toBe(1);
    // filtro por tipo vai para a URL e sobrevive ao recarregar
    await g2.getByRole("button", { name: "decisão" }).click();
    expect(decodeURIComponent(page.url())).toMatch(/hide=decision/);
    await page.reload(); await g2.waitFor();
    expect(await g2.locator(".g2d-leg.off").count()).toBe(1);
    await g2.getByRole("button", { name: /Recentrar e limpar/ }).click();
    expect(decodeURIComponent(page.url())).not.toMatch(/hide=/);
    page.off("pageerror", onErr); expect(errors).toEqual([]);
  });
});
