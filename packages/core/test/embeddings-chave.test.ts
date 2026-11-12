import { inspect } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleEmbedder, chaveDeEmbeddings, coreDoctor, type Brain } from "../src/index.js";
import { cleanup, human, tempBrain } from "./helpers.js";

// valor fictício, só deste teste: nunca pode aparecer em aviso, log ou resposta
const VAR = "BRAIN_TESTE_CHAVE_EMBEDDINGS";
const VALOR = "valor-ficticio-da-chave-de-teste";

/** Requisições ao `/embeddings`, com o cabeçalho de credencial que cada uma levou (o servidor de embeddings é simulado). */
let pedidos: Array<{ url: string; authorization: string | undefined }> = [];
beforeEach(() => {
  pedidos = [];
  process.env[VAR] = VALOR;
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const corpo = JSON.parse(String(init?.body)) as { input: string[] };
    pedidos.push({ url: String(url), authorization: headers.get("authorization") ?? undefined });
    return new Response(JSON.stringify({ data: corpo.input.map(() => ({ embedding: [1, 0, 0, 0, 0, 0, 0, 0] })) }), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env[VAR]; });
afterAll(cleanup);

async function brainCom(embeddings: Record<string, unknown>): Promise<Brain> {
  const b = await tempBrain();
  await b.updateConfig({ embeddings: { provider: "openai-compatible", external_opt_in: true, model: "m", dimensions: 8, api_key_env: VAR, ...embeddings } }, human);
  return b;
}
/** Credencial que a próxima chamada ao embedder leva. */
async function credencial(b: Brain): Promise<string | undefined> {
  pedidos = [];
  await b.embedder.embed(["texto"]);
  expect(pedidos).toHaveLength(1);
  return pedidos[0]!.authorization;
}

describe("chave de embeddings só para os hosts de embeddings.api_key_hosts", () => {
  it("o padrão do config.yaml autoriza só api.openai.com", async () => {
    const b = await tempBrain();
    expect(b.config.embeddings.api_key_hosts).toEqual(["api.openai.com"]);
    b.close();
  });

  it("api.openai.com (o padrão) continua recebendo a chave", async () => {
    const b = await brainCom({ base_url: "https://api.openai.com/v1" });
    expect(await credencial(b)).toBe(`Bearer ${VALOR}`);
    b.close();
  });

  it("servidor externo fora da lista: a requisição sai sem Authorization", async () => {
    const b = await brainCom({ base_url: "https://coletor.example/v1" });
    expect(await credencial(b)).toBeUndefined();
    expect(pedidos[0]!.url).toBe("https://coletor.example/v1/embeddings");
    b.close();
  });

  it("host na lista com https recebe a chave; com http (fora do loopback) não", async () => {
    const b = await brainCom({ base_url: "https://emb.example/v1", api_key_hosts: ["emb.example"] });
    expect(await credencial(b)).toBe(`Bearer ${VALOR}`);
    await b.updateConfig({ embeddings: { base_url: "http://emb.example/v1" } }, human);
    expect(await credencial(b)).toBeUndefined();
    b.close();
  });

  it("loopback dispensa https se estiver na lista; fora dela o servidor local roda sem chave (Ollama, LM Studio)", async () => {
    const b = await brainCom({ base_url: "http://localhost:11434/v1" });
    expect(await credencial(b)).toBeUndefined();
    await b.updateConfig({ embeddings: { api_key_hosts: ["localhost"] } }, human);
    expect(await credencial(b)).toBe(`Bearer ${VALOR}`);
    b.close();
  });

  it("comparação exata do hostname, em minúsculas: subdomínio, sufixo e credencial na URL não passam", () => {
    const hosts = ["api.openai.com", "EMB.Example"];
    expect(chaveDeEmbeddings("https://API.OpenAI.com/v1", hosts).envia).toBe(true);
    expect(chaveDeEmbeddings("https://emb.example:8443/v1", hosts).envia).toBe(true);
    for (const u of ["https://evil.api.openai.com/v1", "https://api.openai.com.evil.example/v1", "https://openai.com/v1", "https://user:pw@api.openai.com/v1", "ftp://api.openai.com/v1", "lixo"]) {
      expect([u, chaveDeEmbeddings(u, hosts).envia]).toEqual([u, false]);
    }
    expect(chaveDeEmbeddings("https://x.example/v1", ["*.example", "*"]).envia).toBe(false);
    for (const u of ["http://127.0.0.1:1234/v1", "http://[::1]:8080/v1"]) expect(chaveDeEmbeddings(u, ["127.0.0.1", "::1"]).envia).toBe(true);
  });

  it("doctor e Saúde avisam que a chave não vai para o host, sem mostrar o valor", async () => {
    const b = await brainCom({ base_url: "https://coletor.example/v1" });
    const aviso = "a chave de embeddings não é enviada para coletor.example: adicione-o em embeddings.api_key_hosts no .brain/config.yaml";
    expect((await b.health()).embeddings.aviso).toBe(aviso);
    const check = (await coreDoctor(b)).find((c) => c.id === "embeddings-chave");
    expect(check).toMatchObject({ status: "warn", detail: aviso });
    // http num host da lista: o aviso pede https
    await b.updateConfig({ embeddings: { base_url: "http://coletor.example/v1", api_key_hosts: ["coletor.example"] } }, human);
    expect((await b.health()).embeddings.aviso).toBe("a chave de embeddings não é enviada para coletor.example: use https em embeddings.base_url");
    const tudo = JSON.stringify([await b.health(), await coreDoctor(b), b.db.activity({ limit: 50 })]);
    expect(tudo).not.toContain(VALOR);
    b.close();
  });

  it("motivo de cada recusa: URL inválida, usuário/senha na URL, protocolo que não é http(s), fora da lista, http fora do loopback", () => {
    const hosts = ["api.openai.com"];
    expect(chaveDeEmbeddings("lixo", hosts)).toEqual({ envia: false, motivo: "url_invalida" });
    expect(chaveDeEmbeddings("https://user:pw@api.openai.com/v1", hosts)).toEqual({ envia: false, host: "api.openai.com", motivo: "credenciais_na_url" });
    expect(chaveDeEmbeddings("https://user@coletor.example/v1", hosts)).toEqual({ envia: false, host: "coletor.example", motivo: "credenciais_na_url" });
    expect(chaveDeEmbeddings("ftp://api.openai.com/v1", hosts)).toEqual({ envia: false, host: "api.openai.com", motivo: "protocolo" });
    expect(chaveDeEmbeddings("https://coletor.example/v1", hosts)).toEqual({ envia: false, host: "coletor.example", motivo: "fora_da_lista" });
    expect(chaveDeEmbeddings("http://api.openai.com/v1", hosts)).toEqual({ envia: false, host: "api.openai.com", motivo: "sem_https" });
  });

  it("o aviso diz o motivo certo e nunca ecoa uma base_url inválida (caracteres de controle iriam ao terminal do doctor)", async () => {
    const b = await brainCom({ base_url: "https://user:pw@api.openai.com/v1" });
    expect((await b.health()).embeddings.aviso).toBe("a chave de embeddings não é enviada para api.openai.com: embeddings.base_url não pode ter usuário/senha");
    await b.updateConfig({ embeddings: { base_url: "ftp://api.openai.com/v1" } }, human);
    expect((await b.health()).embeddings.aviso).toBe("a chave de embeddings não é enviada para api.openai.com: embeddings.base_url precisa ser https");
    await b.updateConfig({ embeddings: { base_url: "file:///tmp/embeddings" } }, human); // sem host
    expect((await b.health()).embeddings.aviso).toBe("a chave de embeddings não é enviada: embeddings.base_url precisa ser https");
    await b.updateConfig({ embeddings: { base_url: "https://colet\x1b[31mor.example/v1" } }, human);
    const aviso = (await b.health()).embeddings.aviso;
    expect(aviso).toBe("a chave de embeddings não é enviada: embeddings.base_url inválida");
    expect(aviso).not.toContain("\x1b");
    expect((await coreDoctor(b)).find((c) => c.id === "embeddings-chave")?.detail).toBe(aviso);
    b.close();
  });

  it("o embedder não expõe a chave em JSON.stringify nem em util.inspect", async () => {
    const e = new OpenAICompatibleEmbedder({ baseUrl: "https://api.openai.com/v1", model: "m", dim: 8, apiKey: VALOR, apiKeyHosts: ["api.openai.com"] });
    expect(JSON.stringify(e)).not.toContain(VALOR);
    expect(inspect(e, { showHidden: true, depth: 10 })).not.toContain(VALOR);
    const b = await brainCom({ base_url: "https://api.openai.com/v1" });
    expect(await credencial(b)).toBe(`Bearer ${VALOR}`); // a chave continua indo para o host autorizado
    expect(JSON.stringify(b.embedder)).not.toContain(VALOR);
    expect(inspect(b.embedder, { showHidden: true, depth: 10 })).not.toContain(VALOR);
    b.close();
  });

  it("sem aviso quando a chave vai, quando não há chave definida ou quando o embedder é o local", async () => {
    const b = await brainCom({ base_url: "https://api.openai.com/v1" });
    expect((await b.health()).embeddings.aviso).toBeUndefined();
    expect((await coreDoctor(b)).some((c) => c.id === "embeddings-chave")).toBe(false);
    await b.updateConfig({ embeddings: { base_url: "http://localhost:11434/v1" } }, human);
    delete process.env[VAR];
    expect((await b.health()).embeddings.aviso).toBeUndefined();
    process.env[VAR] = VALOR;
    await b.updateConfig({ embeddings: { provider: "hash" } }, human);
    expect((await b.health()).embeddings.aviso).toBeUndefined();
    b.close();
  });
});
