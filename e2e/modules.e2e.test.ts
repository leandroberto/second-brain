import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { Brain, issueHumanSession, setReviewerPassphrase } from "../packages/core/src/index.js";
import { startServe, type ServeHandle } from "../packages/cli/src/serve.js";
import { conferirEmProcessoFilho } from "../packages/cli/src/modules.js";
import { terminalHuman } from "../packages/core/test/helpers.js";

// Mesmo padrão de `ui.e2e.test.ts`: Chrome real via playwright-core; sem Chrome o arquivo é pulado.
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
// o `vitest.global.ts` constrói o web na suíte normal; sem o dist (rodando por fora dela) o arquivo é pulado em vez de falhar
const webRoot = join(process.cwd(), "apps/web/dist");
const pronto = !!chrome && existsSync(join(webRoot, "index.html"));
const LEMBRETE = resolve(import.meta.dirname, "../examples/modules/lembrete");
const savedState = process.env.BRAIN_STATE_DIR;

let dir: string; let brain: Brain; let serve: ServeHandle; let browser: Browser; let page: Page; let sessao: string; let itemId = "";
const sessions = () => ({ file: join(dir, "sessions.json") });
const nav = (hash: string) => page.evaluate((h) => { location.hash = h; }, hash);
const menu = () => page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: /Lembretes/ });
const frame = () => page.frameLocator('iframe[title="Módulo lembrete"]');

describe.skipIf(!pronto)("módulos na UI web (browser real)", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "brain-mod-ui-"));
    process.env.BRAIN_STATE_DIR = join(dir, "state");
    // o config com o módulo é escrito antes do `Brain.open`: o bloco `modules` é lido na abertura
    (await Brain.init(join(dir, "vault"))).close();
    const cfg = join(dir, "vault", ".brain", "config.yaml");
    const atual = readFileSync(cfg, "utf8").replace(/^modules:.*$/m, "");
    writeFileSync(cfg, `${atual.trimEnd()}\nmodules: ${JSON.stringify({ lembrete: { enabled: true, path: LEMBRETE, config: { horario: "10:00" } } })}\n`, "utf8");
    brain = await Brain.open(join(dir, "vault"));
    // sem agendador automático: perto das 10:00 locais o tick competiria com o "rodar agora"
    serve = await startServe(brain, { port: 0, sessions: sessions(), agendador: false, webRoot });
    sessao = issueHumanSession(brain.vault.root, await terminalHuman("alice", sessions()), sessions());
    const r = await fetch(`${serve.url}/api/modules/lembrete/_tarefas/diario/rodar`, { method: "POST", headers: { authorization: `Bearer ${sessao}`, "content-type": "application/json" }, body: "{}" });
    expect(((await r.json()) as { resultado: string }).resultado).toBe("ok");
    const n = (await (await fetch(`${serve.url}/api/notifications`, { headers: { authorization: `Bearer ${sessao}` } })).json()) as { avisos: Array<{ link: string }> };
    itemId = n.avisos[0]!.link.slice("item/".length);
    browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
    page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  });
  afterAll(async () => {
    await browser?.close(); await serve?.close(); brain?.close(); rmSync(dir, { recursive: true, force: true });
    if (savedState === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = savedState;
  });

  it("o menu mostra o módulo com o contador de pendentes", async () => {
    await page.goto(`${serve.url}/#token=${sessao}`);
    await menu().waitFor();
    expect(await menu().locator(".count").innerText()).toBe("1");
  });

  it("a aba carrega o iframe com sandbox, completa o handshake e lista o item sem mexer no hash do topo", async () => {
    // `console` de nível error inclui os frames (o iframe do módulo); `pageerror` pega exceções não tratadas do topo
    const errors: string[] = [];
    const onErro = (e: Error) => errors.push(String(e)); const onCon = (m: { type(): string; text(): string }) => { if (m.type() === "error") errors.push(m.text()); };
    page.on("pageerror", onErro); page.on("console", onCon);
    try {
      await menu().click();
      const iframe = page.locator('iframe[title="Módulo lembrete"]');
      await iframe.waitFor();
      expect(await iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
      // o `src` leva o nonce no fragmento; depois do handshake a lista aparece (o token só chega pelo `brain:init`)
      expect(await iframe.getAttribute("src")).toMatch(/^\/modules\/lembrete\/index\.html#n=[A-Za-z0-9_-]+&r=/);
      await frame().locator("li.card .texto").filter({ hasText: /^Lembrete de \d{4}-\d{2}-\d{2}/ }).waitFor();
      expect(await frame().locator("#resumo").innerText()).toBe("1 pendente(s) de 1");
      // o client reescreveu o hash do iframe para `#<resto>` (sem o nonce); o do topo do SB continua `#/m/lembrete`
      const frm = page.frames().find((f) => f.url().includes("/modules/lembrete/index.html"))!;
      expect(await frm.evaluate(() => location.hash)).not.toContain("n=");
      expect(new URL(page.url()).hash).toBe("#/m/lembrete");
    } finally {
      page.off("pageerror", onErro); page.off("console", onCon); // mesmo se uma asserção falhar antes
    }
    expect(errors).toEqual([]);
  });

  it('"feito" na página zera o contador do menu', async () => {
    await frame().getByRole("button", { name: "feito" }).click();
    await frame().locator("#resumo").filter({ hasText: "0 pendente(s) de 1" }).waitFor();
    await menu().locator(".count").waitFor({ state: "detached", timeout: 10000 });
  });

  it("o link do aviso, com a aba aberta, leva ao item", async () => {
    expect(await frame().locator("li.card.destaque").count()).toBe(0);
    await nav(`#/m/lembrete/item/${itemId}`);
    await frame().locator("li.card.destaque").waitFor();
    expect(await frame().locator("li.card.destaque .texto").innerText()).toContain("Lembrete de");
  });

  it("Configurações › Módulos mostra status e tarefa, e Rodar agora (confirmado) devolve o resultado", async () => {
    await nav("#/settings/modulos");
    const sec = page.getByTestId("modulo-lembrete");
    await sec.waitFor();
    expect(await sec.innerText()).toMatch(/Lembretes[\s\S]*lembrete[\s\S]*ativo/i);
    expect(await sec.innerText()).toContain("diario");
    let pergunta = ""; // o `expect` dentro do handler não chegaria ao teste: guarda a mensagem, aceita e confere depois
    page.once("dialog", (d) => { pergunta = d.message(); void d.accept(); });
    await sec.getByRole("button", { name: "Rodar agora" }).click();
    expect(pergunta).toMatch(/Rodar agora a tarefa "diario"/);
    await sec.getByRole("status").filter({ hasText: "resultado agora: ok" }).waitFor();
  });
});

// Gerenciar pela UI: o assistente de 4 etapas adiciona o exemplo `lembrete`, o serve "reinicia" e a aba aparece; depois desligar e remover.
const BIN = join(process.cwd(), "packages/cli/dist/bin.js"); // construído pelo `vitest.global.ts`; a conferência roda o `brain modules check` nele
// vindo de `src/` (vitest), o filho não acha o `bin.js` sozinho
const conferirNoBin = (c: string, cfg?: unknown) => conferirEmProcessoFilho(c, cfg, { bin: BIN });
const TEXTO_CONFIANCA = "Para conferir, o código desta pasta será carregado no seu computador. Continue só com módulos em que você confia.";

describe.skipIf(!pronto)("gerenciar módulos pela UI (browser real)", () => {
  let d: string; let b: Brain; let sv: ServeHandle; let br: Browser; let pg: Page; let token: string; let porta = 0; let sess: { file: string };
  let reinicios = 0; let religando: Promise<void> | undefined;
  const vaultDir = () => join(d, "vault");
  const montar = (brainAberto: Brain) => startServe(brainAberto, { port: porta, sessions: sess, agendador: false, webRoot, conferir: conferirNoBin, reiniciarServe });
  // `reiniciarServe` de teste: registra a chamada e, depois da resposta, fecha o serve e sobe outro na mesma porta (o `Brain` é reaberto: o bloco `modules` é lido na abertura)
  const reiniciarServe = async () => {
    reinicios++;
    religando = new Promise<void>((ok, falha) => { setTimeout(() => { void (async () => { await sv.close(); b.close(); b = await Brain.open(vaultDir()); sv = await montar(b); })().then(ok, falha); }, 150); });
  };
  const pagina = (url: string) => pg.goto(`${url}/#token=${token}`);
  const reiniciosVistos = () => reinicios;

  beforeAll(async () => {
    d = mkdtempSync(join(tmpdir(), "brain-mod-add-"));
    process.env.BRAIN_STATE_DIR = join(d, "state");
    (await Brain.init(vaultDir())).close(); // sem módulos e sem frase-senha: o fluxo não pede frase
    b = await Brain.open(vaultDir());
    sess = { file: join(d, "sessions.json") };
    sv = await montar(b);
    porta = Number(new URL(sv.url).port);
    token = issueHumanSession(b.vault.root, await terminalHuman("alice", sess), sess);
    br = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
    pg = await br.newPage({ viewport: { width: 1360, height: 860 } });
    // O serve de teste reinicia no MESMO processo, então o `pid` de `GET /api/serve` não muda e a UI esperaria o limite de 60 s.
    // Só no teste: depois do reinício pedido, a resposta do navegador a `/api/serve` ganha outro pid (a UI em produção não muda).
    await pg.route("**/api/serve", async (rota) => {
      const real = await rota.fetch();
      if (reiniciosVistos() === 0) return rota.fulfill({ response: real });
      const corpo = (await real.json()) as { pid: number };
      return rota.fulfill({ response: real, json: { ...corpo, pid: corpo.pid + reiniciosVistos() } });
    });
  });
  afterAll(async () => {
    await br?.close(); await religando?.catch(() => undefined); await sv?.close(); b?.close(); rmSync(d, { recursive: true, force: true });
    if (savedState === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = savedState;
  });

  it("adiciona o lembrete pelas 4 etapas, o serve reinicia, a aba aparece; desliga e remove sem apagar a pasta", async () => {
    await pagina(`${sv.url}`);
    await pg.evaluate(() => { location.hash = "#/settings/modulos"; });
    await pg.getByText("Nenhum módulo configurado.").waitFor();
    expect(await pg.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: /Lembretes/ }).count()).toBe(0);
    await pg.getByRole("button", { name: "+ Adicionar módulo" }).click();

    // etapa 1: navega pelas pastas até o exemplo
    const wiz = pg.getByTestId("add-module-wizard");
    await wiz.getByLabel("Caminho da pasta do módulo").fill(resolve(LEMBRETE, ".."));
    await wiz.getByRole("button", { name: "Abrir", exact: true }).click();
    await wiz.getByRole("list", { name: "Subpastas" }).getByRole("button", { name: "lembrete", exact: true }).click();
    await expect.poll(() => wiz.getByLabel("Caminho da pasta do módulo").inputValue()).toBe(LEMBRETE);
    await wiz.getByRole("button", { name: "Continuar" }).click();
    const aviso = pg.getByRole("dialog", { name: "Conferir o módulo" });
    expect(await aviso.innerText()).toContain(TEXTO_CONFIANCA);
    expect(await aviso.getByLabel("Frase-senha do revisor").count()).toBe(0); // vault sem frase-senha
    await aviso.getByRole("button", { name: "Continuar" }).click();

    // etapa 2: o que o módulo vai fazer
    const faz = wiz.locator("ul.faz");
    await faz.waitFor();
    const txt = await faz.innerText();
    expect(txt).toContain("lembrete_listar");
    expect(txt).toContain("todo dia às 10:00");
    await wiz.getByRole("button", { name: "Continuar" }).click();

    // etapa 3: configuração pelo formulário
    await wiz.getByLabel("horario").fill("09:30");
    await wiz.getByRole("button", { name: "Continuar" }).click();

    // etapa 4: resumo e confirmação
    expect(await wiz.innerText()).toContain("09:30");
    await wiz.getByRole("button", { name: "Adicionar e reiniciar o serve" }).click();
    await pg.getByText("Módulo adicionado. O brain serve será reiniciado para aplicar as alterações.").waitFor();

    // o serve de teste foi chamado e subiu de novo; a página recarrega sozinha e o menu ganha a aba
    await religando; expect(reinicios).toBe(1);
    const item = pg.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: /Lembretes/ });
    await item.waitFor({ timeout: 20000 });
    const cfg = readFileSync(join(vaultDir(), ".brain", "config.yaml"), "utf8");
    expect(cfg).toContain(LEMBRETE); expect(cfg).toContain("09:30");

    // desligar (confirm aceito): o item some do menu depois do reinício
    const card = pg.getByTestId("modulo-lembrete");
    await card.waitFor();
    let pergunta = "";
    pg.once("dialog", (x) => { pergunta = x.message(); void x.accept(); });
    await card.getByRole("button", { name: "Desligar" }).click();
    await item.waitFor({ state: "detached", timeout: 20000 });
    expect(pergunta).toMatch(/Desligar .*O brain serve será reiniciado/);
    expect(reinicios).toBe(2);
    await pg.getByTestId("modulo-lembrete").getByText("desligado", { exact: true }).waitFor();

    // remover: a lista volta vazia e a pasta do exemplo continua no disco
    pg.once("dialog", (x) => void x.accept());
    await pg.getByTestId("modulo-lembrete").getByRole("button", { name: "Remover" }).click();
    await pg.getByText("Nenhum módulo configurado.").waitFor({ timeout: 20000 });
    expect(reinicios).toBe(3);
    expect(existsSync(join(LEMBRETE, "package.json"))).toBe(true);
    expect(readFileSync(join(vaultDir(), ".brain", "config.yaml"), "utf8")).not.toContain(LEMBRETE);
  });
});

// Com frase-senha de revisor configurada, o Continuar da etapa 1 pede a frase antes de conferir (o código só roda depois dela).
describe.skipIf(!pronto)("gerenciar módulos pela UI com frase-senha (browser real)", () => {
  let d: string; let b: Brain; let sv: ServeHandle; let br: Browser; let pg: Page; let token: string;
  beforeAll(async () => {
    d = mkdtempSync(join(tmpdir(), "brain-mod-frase-"));
    process.env.BRAIN_STATE_DIR = join(d, "state");
    (await Brain.init(join(d, "vault"))).close();
    b = await Brain.open(join(d, "vault"));
    const sess = { file: join(d, "sessions.json") };
    const prova = await terminalHuman("alice", sess); // antes da frase existir; depois dela o terminal a pediria
    token = issueHumanSession(b.vault.root, prova, sess);
    setReviewerPassphrase("frase certa do revisor", prova, sess);
    sv = await startServe(b, { port: 0, sessions: sess, agendador: false, webRoot, conferir: conferirNoBin });
    br = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
    pg = await br.newPage({ viewport: { width: 1360, height: 860 } });
  });
  afterAll(async () => {
    await br?.close(); await sv?.close(); b?.close(); rmSync(d, { recursive: true, force: true });
    if (savedState === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = savedState;
  });

  it("pede a frase no Continuar da etapa 1: errada é recusada, certa leva à conferência", async () => {
    await pg.goto(`${sv.url}/#token=${token}`);
    await pg.evaluate(() => { location.hash = "#/settings/modulos"; });
    await pg.getByRole("button", { name: "+ Adicionar módulo" }).click();
    const wiz = pg.getByTestId("add-module-wizard");
    await wiz.getByLabel("Caminho da pasta do módulo").fill(LEMBRETE);
    await wiz.getByRole("button", { name: "Continuar" }).click();
    const dlg = pg.getByRole("dialog", { name: "Conferir o módulo" });
    await dlg.getByRole("button", { name: "Continuar" }).click(); // sem frase: o servidor pede
    await dlg.getByLabel("Frase-senha do revisor").waitFor();
    await dlg.getByLabel("Frase-senha do revisor").fill("frase errada");
    await dlg.getByRole("button", { name: "Continuar" }).click();
    await dlg.getByRole("alert").waitFor();
    await dlg.getByLabel("Frase-senha do revisor").fill("frase certa do revisor");
    await dlg.getByRole("button", { name: "Continuar" }).click();
    await wiz.locator("ul.faz").waitFor();
    expect(await wiz.locator("ul.faz").innerText()).toContain("lembrete_listar");
  });
});
