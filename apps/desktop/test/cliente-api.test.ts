import { expect, test } from "vitest";
import { criarClienteApi, TIMEOUT_API_MS } from "../src/main/cliente-api";

type Chamada = { url: string; init: RequestInit };
const resposta = (status: number, corpo: unknown): Response =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
const falso = (resp: (c: Chamada) => Response | Promise<Response>) => {
  const chamadas: Chamada[] = [];
  const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const c = { url: String(url), init };
    chamadas.push(c);
    return resp(c);
  }) as typeof fetch;
  return { f, chamadas };
};
const OK_CAPTURA = {
  capture_id: "20261110-153012-a1b2",
  state: "processada",
  result: { ok: true, notas: [{ id: "nota-x", acao: "criada" }], segredo_omitido: false, texto_mascarado: null },
};

test("anotar envia Authorization Bearer e devolve capture_id", async () => {
  const { f, chamadas } = falso(() => resposta(200, OK_CAPTURA));
  const r = await criarClienteApi("http://localhost:3737", "hs_segredo", f).anotar("texto ditado");
  expect(r).toMatchObject({ ok: true, capture_id: "20261110-153012-a1b2", state: "processada" });
  expect(chamadas).toHaveLength(1);
  expect(chamadas[0]!.url).toBe("http://localhost:3737/api/assistant/capture");
  expect(chamadas[0]!.init.method).toBe("POST");
  expect((chamadas[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer hs_segredo");
  expect(JSON.parse(chamadas[0]!.init.body as string)).toEqual({ text: "texto ditado" });
});

const erroComCausa = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
const falhaCom = (e: unknown) =>
  (async () => {
    throw e;
  }) as typeof fetch;

test("erro de rede vira offline", async () => {
  const c = criarClienteApi("http://localhost:3737", "t", falhaCom(erroComCausa("ECONNREFUSED")));
  expect(await c.anotar("x")).toEqual({ ok: false, tipo: "offline" });
  expect(await c.perguntar("x")).toEqual({ ok: false, tipo: "offline" });
  expect(await c.saude()).toBe(false);
});

test("só falha de conexão nunca aceita vira offline", async () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"]) {
    expect(await criarClienteApi("http://localhost:3737", "t", falhaCom(erroComCausa(code))).anotar("x")).toEqual({ ok: false, tipo: "offline" });
  }
  // AggregateError (localhost tenta IPv6 e IPv4) carrega o código no próprio erro
  const agregado = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" }) });
  expect(await criarClienteApi("http://localhost:3737", "t", falhaCom(agregado)).anotar("x")).toEqual({ ok: false, tipo: "offline" });
});

test("timeout depois do envio vira incerto (não offline), em anotar e em perguntar", async () => {
  for (const code of ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]) {
    const c = criarClienteApi("http://localhost:3737", "t", falhaCom(erroComCausa(code)));
    const a = await c.anotar("x");
    expect(a).toMatchObject({ ok: false, tipo: "incerto" });
    expect((a as { mensagem: string }).mensagem).toContain("Organizar pendentes");
    expect(await c.perguntar("x")).toMatchObject({ ok: false, tipo: "incerto" });
  }
  // erro sem causa conhecida também não é "offline"
  expect(await criarClienteApi("http://localhost:3737", "t", falhaCom(new TypeError("fetch failed"))).anotar("x")).toMatchObject({ tipo: "incerto" });
});

test("5xx em anotar vira incerto (o servidor pode ter gravado); 4xx continua http", async () => {
  let status = 500;
  const { f } = falso(() => resposta(status, { error: "internal", message: "erro interno" }));
  const c = criarClienteApi("http://localhost:3737", "t", f);
  expect(await c.anotar("x")).toMatchObject({ ok: false, tipo: "incerto" });
  status = 503;
  expect(await c.anotar("x")).toMatchObject({ ok: false, tipo: "incerto" });
  status = 413;
  expect(await c.anotar("x")).toEqual({ ok: false, tipo: "http", status: 413, mensagem: "erro interno" });
});

test("os timeouts do agente HTTP são de 15 min (maiores que o do motor)", () => {
  expect(TIMEOUT_API_MS).toBe(15 * 60 * 1000);
});

test("401 vira pareamento, e a mensagem manda rodar brain pair-desktop", async () => {
  const { f } = falso(() => new Response("token inválido", { status: 401 }));
  const r = await criarClienteApi("http://localhost:3737", "t", f).anotar("x");
  expect(r).toMatchObject({ ok: false, tipo: "pareamento" });
  expect((r as { mensagem: string }).mensagem).toContain("brain pair-desktop");
});

test("403 também vira pareamento", async () => {
  const { f } = falso(() => resposta(403, { error: "forbidden", message: "credencial do desktop só acessa o assistente" }));
  expect(await criarClienteApi("http://localhost:3737", "t", f).perguntar("x")).toMatchObject({ ok: false, tipo: "pareamento" });
});

test("anotar com result de erro (200) preserva o state pendente e o result tipado", async () => {
  const corpo = { capture_id: "20261110-153012-a1b2", state: "pendente", result: { ok: false, tipo: "auth", mensagem: "Not logged in" } };
  const { f } = falso(() => resposta(200, corpo));
  expect(await criarClienteApi("http://localhost:3737", "t", f).anotar("x")).toEqual({ ok: true, ...corpo });
});

test("perguntar envia question e conversation_id e devolve o AskResult", async () => {
  const { f, chamadas } = falso(() => resposta(200, { ok: true, resposta: "45 segundos.", fontes: ["nota-x"] }));
  const r = await criarClienteApi("http://localhost:3737", "t", f).perguntar("qual o timeout?", "0b3f2c1e-1111-4222-8333-444455556666");
  expect(r).toEqual({ ok: true, resposta: "45 segundos.", fontes: ["nota-x"] });
  expect(chamadas[0]!.url).toBe("http://localhost:3737/api/assistant/ask");
  expect(JSON.parse(chamadas[0]!.init.body as string)).toEqual({
    question: "qual o timeout?",
    conversation_id: "0b3f2c1e-1111-4222-8333-444455556666",
  });
});

test("perguntar sem conversa não manda conversation_id", async () => {
  const { f, chamadas } = falso(() => resposta(200, { ok: false, tipo: "auth", mensagem: "Not logged in" }));
  const r = await criarClienteApi("http://localhost:3737", "t", f).perguntar("q");
  expect(r).toEqual({ ok: false, tipo: "auth", mensagem: "Not logged in" });
  expect(JSON.parse(chamadas[0]!.init.body as string)).toEqual({ question: "q" });
});

test("desfazer: POST no id; 200 devolve reverted; 503 vira ocupado; 404 vira inexistente; 409 traz a mensagem", async () => {
  const id = "20261110-153012-a1b2";
  let status = 200;
  let corpo: unknown = { reverted: ["nota-x"] };
  const { f, chamadas } = falso(() => resposta(status, corpo));
  const c = criarClienteApi("http://localhost:3737", "t", f);
  expect(await c.desfazer(id)).toEqual({ ok: true, reverted: ["nota-x"] });
  expect(chamadas[0]!.url).toBe(`http://localhost:3737/api/assistant/captures/${id}/undo`);
  expect(chamadas[0]!.init.method).toBe("POST");
  status = 503;
  corpo = { error: "locked", message: "captura ainda em processamento; tente de novo em instantes" };
  expect(await c.desfazer(id)).toMatchObject({ ok: false, tipo: "ocupado" });
  status = 404;
  corpo = { error: "not_found", message: "captura x não existe" };
  expect(await c.desfazer(id)).toMatchObject({ ok: false, tipo: "inexistente" });
  status = 409;
  corpo = { error: "conflict_revision", message: "a nota n foi alterada depois; desfaça pela revisão" };
  expect(await c.desfazer(id)).toEqual({ ok: false, tipo: "http", status: 409, mensagem: "a nota n foi alterada depois; desfaça pela revisão" });
});

test("organizarPendentes chama retry e depois lista as pendentes", async () => {
  const { f, chamadas } = falso((c) => (c.url.endsWith("/retry") ? resposta(200, { retried: 2 }) : resposta(200, [{ id: "a" }])));
  const r = await criarClienteApi("http://localhost:3737", "t", f).organizarPendentes();
  expect(r).toEqual({ ok: true, retried: 2, restantes: 1 });
  expect(chamadas.map((c) => `${c.init.method ?? "GET"} ${c.url}`)).toEqual([
    "POST http://localhost:3737/api/assistant/captures/retry",
    "GET http://localhost:3737/api/assistant/captures?state=pendente",
  ]);
});

test("saude: true com 200, false com 401 ou erro; estado distingue pareamento de offline", async () => {
  let status = 200;
  const { f, chamadas } = falso(() => (status === 200 ? resposta(200, { ok: true }) : new Response("x", { status })));
  const c = criarClienteApi("http://localhost:3737", "t", f);
  expect(await c.saude()).toBe(true);
  expect(chamadas[0]!.url).toBe("http://localhost:3737/api/health");
  status = 401;
  expect(await c.saude()).toBe(false);
  expect(await c.estado()).toBe("pareamento");
});

test("só chama rotas da allowlist do desktop", async () => {
  const { f, chamadas } = falso(() => resposta(200, {}));
  const c = criarClienteApi("http://localhost:3737", "t", f);
  await c.anotar("x");
  await c.perguntar("x");
  await c.desfazer("20261110-153012-a1b2");
  await c.organizarPendentes();
  await c.saude();
  for (const { url } of chamadas) {
    const p = new URL(url).pathname;
    expect(p.startsWith("/api/assistant/") || p === "/api/health").toBe(true);
  }
});

test("base com barra final é normalizada", async () => {
  const { f, chamadas } = falso(() => resposta(200, {}));
  await criarClienteApi("http://localhost:3737/", "t", f).saude();
  expect(chamadas[0]!.url).toBe("http://localhost:3737/api/health");
});

test("renovar chama POST /api/assistant/session/renew e devolve o token novo; 401 vira pareamento", async () => {
  const novo = `hs_${"c".repeat(64)}`;
  const { f, chamadas } = falso(() => resposta(200, { token: novo }));
  expect(await criarClienteApi("http://localhost:3737", "hs_velho", f).renovar()).toEqual({ ok: true, token: novo });
  expect(chamadas[0]!.url).toBe("http://localhost:3737/api/assistant/session/renew");
  expect(chamadas[0]!.init.method).toBe("POST");
  expect((chamadas[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer hs_velho");
  expect(await criarClienteApi("http://localhost:3737", "t", falso(() => resposta(401, { message: "x" })).f).renovar()).toMatchObject({ ok: false, tipo: "pareamento" });
  // resposta sem token válido não vira credencial
  expect(await criarClienteApi("http://localhost:3737", "t", falso(() => resposta(200, { token: "" })).f).renovar()).toMatchObject({ ok: false, tipo: "http" });
});
