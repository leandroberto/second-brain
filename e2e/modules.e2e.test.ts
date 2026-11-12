import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { Brain, issueHumanSession } from "../packages/core/src/index.js";
import { startServe, type ServeHandle } from "../packages/cli/src/serve.js";
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
