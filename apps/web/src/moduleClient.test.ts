import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// O cliente da aba (static do SDK) é um ES module sem tipos que lê `window`/`document`: aqui rodam sobre um janela falsa.
const CLIENTE = new URL("../../../packages/module-sdk/static/brain-module-client.js", import.meta.url).href;
type Ouvinte = (ev: { source: unknown; data: unknown }) => void;
interface Conexao { api(c: string): Promise<unknown>; resto: string }

let pai: { postMessage: ReturnType<typeof vi.fn> };
let ouvintes: Ouvinte[];
let janela: { parent: unknown; location: { hash: string; pathname?: string; search?: string }; history: { replaceState: ReturnType<typeof vi.fn> }; addEventListener: (t: string, f: Ouvinte) => void };
const enviar = (data: unknown, source: unknown = pai) => ouvintes.forEach((f) => f({ source, data }));
const enviados = () => pai.postMessage.mock.calls.map((c) => c[0] as { type: string; nonce?: string });
const preparar = (hash: string) => { janela.location.hash = hash; };
const carregar = async () => { vi.resetModules(); return await import(/* @vite-ignore */ CLIENTE) as { conectar(): Promise<Conexao> }; };
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const init = (over: Record<string, unknown> = {}) => ({ type: "brain:init", token: "t1", expira: iso(12 * 3600_000), apiBase: "/api/modules/x", tema: "escuro", resto: "a/b", ...over });

beforeEach(() => {
  vi.useFakeTimers();
  pai = { postMessage: vi.fn() };
  ouvintes = [];
  janela = {
    parent: pai, location: { hash: "#n=n1&r=a%2Fb", pathname: "/modules/x/index.html", search: "" }, addEventListener: (_t: string, f: Ouvinte) => ouvintes.push(f),
    history: { replaceState: vi.fn((_s: unknown, _t: string, url: string) => { janela.location.hash = url.slice(url.indexOf("#")); }) },
  };
  vi.stubGlobal("window", janela);
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("brain-module-client", () => {
  it("conectar() repetido devolve a mesma conexão e um só handshake", async () => {
    const { conectar } = await carregar();
    const a = conectar(); const b = conectar();
    expect(b).toBe(a);
    expect(enviados().filter((m) => m.type === "brain:pronto")).toHaveLength(1);
    enviar(init());
    expect((await a).resto).toBe("a/b");
    expect(await conectar()).toBe(await a);
  });

  it("lê o nonce do fragmento, manda no brain:pronto e tira o nonce do hash", async () => {
    preparar("#n=abc123&r=a%2Fb%20c");
    const { conectar } = await carregar();
    const c = conectar();
    expect(enviados().find((m) => m.type === "brain:pronto")).toEqual({ type: "brain:pronto", nonce: "abc123" });
    expect(janela.location.hash).toBe("#a/b c"); // só o resto; o nonce não fica visível para o módulo
    enviar(init({ expira: iso(10_000) }));
    await c;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enviados().find((m) => m.type === "brain:renovar")).toEqual({ type: "brain:renovar", nonce: "abc123" });
  });

  it("replaceState que lança não derruba o handshake: o nonce vai, com aviso no console", async () => {
    preparar("#n=abc123&r=x");
    janela.history.replaceState.mockImplementation(() => { throw new Error("SecurityError"); });
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { conectar } = await carregar();
      void conectar();
      expect(enviados().find((m) => m.type === "brain:pronto")).toEqual({ type: "brain:pronto", nonce: "abc123" });
      expect(aviso).toHaveBeenCalled();
    } finally { aviso.mockRestore(); }
  });

  it("a reescrita do hash preserva caminho e query da página (<base>)", async () => {
    preparar("#n=abc123&r=x");
    Object.assign(janela.location, { pathname: "/modules/ok/index.html", search: "?q=1" });
    const { conectar } = await carregar();
    void conectar();
    expect(janela.history.replaceState).toHaveBeenCalledWith(null, "", "/modules/ok/index.html?q=1#x");
  });

  it("sem o fragmento (outro documento, recarga) o nonce vai vazio e o hash não muda", async () => {
    preparar("#so-o-resto");
    const { conectar } = await carregar();
    void conectar();
    expect(enviados().find((m) => m.type === "brain:pronto")).toEqual({ type: "brain:pronto", nonce: "" });
    expect(janela.history.replaceState).not.toHaveBeenCalled();
  });

  it("pede a renovação com o nonce 1 h antes de expirar e só aceita token como resposta", async () => {
    const { conectar } = await carregar();
    const c = conectar();
    enviar(init({ expira: iso(2 * 3600_000) }));
    const sb = await c;
    const fetchFalso = vi.fn(async (_u: string, _i: { headers: Headers }) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchFalso);
    // token empurrado sem pedido: ignorado
    enviar({ type: "brain:token", token: "empurrado", expira: iso(3600_000) });
    await sb.api("/p");
    expect(fetchFalso.mock.calls[0]![1].headers.get("authorization")).toBe("Bearer t1");
    expect(enviados().some((m) => m.type === "brain:renovar")).toBe(false);
    await vi.advanceTimersByTimeAsync(3600_000 + 1000); // 1 h antes de expirar = daqui a 1 h
    expect(enviados().filter((m) => m.type === "brain:renovar")).toEqual([{ type: "brain:renovar", nonce: "n1" }]);
    enviar({ type: "brain:token", token: "t2", expira: iso(12 * 3600_000) });
    await sb.api("/p");
    expect(fetchFalso.mock.calls[1]![1].headers.get("authorization")).toBe("Bearer t2");
    // respondido: o próximo pedido só daqui a ~11 h, e um token sem pedido pendente volta a ser ignorado
    enviar({ type: "brain:token", token: "t3", expira: iso(3600_000) });
    await sb.api("/p");
    expect(fetchFalso.mock.calls[2]![1].headers.get("authorization")).toBe("Bearer t2");
    await vi.advanceTimersByTimeAsync(10 * 3600_000);
    expect(enviados().filter((m) => m.type === "brain:renovar")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(enviados().filter((m) => m.type === "brain:renovar")).toHaveLength(2);
  });

  it("sem resposta, pergunta de novo a cada 30 s (um temporizador só)", async () => {
    const { conectar } = await carregar();
    const c = conectar();
    enviar(init({ expira: iso(10_000) })); // já dentro da antecedência: pede em 30 s
    await c;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enviados().filter((m) => m.type === "brain:renovar")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enviados().filter((m) => m.type === "brain:renovar")).toHaveLength(3);
  });

  it("ignora mensagens de outra janela e init repetido", async () => {
    const { conectar } = await carregar();
    const c = conectar();
    enviar(init({ resto: "da-outra-janela" }), {}); // outra janela
    enviar(init({ resto: "primeiro" }));
    enviar(init({ token: "t9", resto: "segundo" })); // init repetido não troca nada
    expect((await c).resto).toBe("primeiro");
    await vi.advanceTimersByTimeAsync(12 * 3600_000);
    expect(enviados().filter((m) => m.type === "brain:renovar").every((m) => m.nonce === "n1")).toBe(true);
  });
});
