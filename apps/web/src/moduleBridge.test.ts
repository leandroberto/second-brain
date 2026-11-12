import { describe, expect, it } from "vitest";
import { criarControlePonte, mensagemToken, criarControleRemontagem, deveRemontar, idModuloValido, mensagemInit, parseMensagemDoModulo, restoDoHash, restoValido } from "./moduleBridge";

const janela = {};
const ev = (data: unknown, over: Partial<{ origin: string; source: unknown }> = {}) => ({ origin: "null", source: janela, data, ...over });

describe("parseMensagemDoModulo", () => {
  it("recusa origem diferente de null", () => {
    expect(parseMensagemDoModulo(ev({ type: "brain:pronto" }, { origin: "http://127.0.0.1:3737" }), janela)).toBeUndefined();
    expect(parseMensagemDoModulo(ev({ type: "brain:pronto" }, { origin: "" }), janela)).toBeUndefined();
  });
  it("recusa source que não é o iframe", () => {
    expect(parseMensagemDoModulo(ev({ type: "brain:pronto" }, { source: {} }), janela)).toBeUndefined();
    expect(parseMensagemDoModulo(ev({ type: "brain:pronto" }), undefined)).toBeUndefined();
    expect(parseMensagemDoModulo(ev({ type: "brain:pronto" }, { source: undefined }), undefined)).toBeUndefined();
  });
  it("recusa tipo desconhecido e payload fora do schema", () => {
    for (const d of [null, "brain:pronto", 3, {}, { type: "brain:outro" }, { type: "brain:navegar" }, { type: "brain:navegar", resto: 4 }, { type: "brain:abrirNota", id: "" }, { type: "brain:badge", n: "3" }])
      expect(parseMensagemDoModulo(ev(d), janela)).toBeUndefined();
  });
  it("aceita brain:renovar só com nonce string não vazia e curta", () => {
    expect(parseMensagemDoModulo(ev({ type: "brain:renovar", nonce: "abc123" }), janela)).toEqual({ type: "brain:renovar", nonce: "abc123" });
    for (const nonce of [undefined, "", 3, null, {}, "x".repeat(129)])
      expect(parseMensagemDoModulo(ev({ type: "brain:renovar", nonce }), janela)).toBeUndefined();
    expect(parseMensagemDoModulo(ev({ type: "brain:renovar", nonce: "abc" }, { origin: "http://127.0.0.1:3737" }), janela)).toBeUndefined();
    expect(parseMensagemDoModulo(ev({ type: "brain:renovar", nonce: "abc" }, { source: {} }), janela)).toBeUndefined();
  });
  it("aceita brain:pronto, navegar, abrirNota e badge", () => {
    expect(parseMensagemDoModulo(ev({ type: "brain:pronto" }), janela)).toEqual({ type: "brain:pronto" });
    expect(parseMensagemDoModulo(ev({ type: "brain:navegar", resto: "lista/3" }), janela)).toEqual({ type: "brain:navegar", resto: "lista/3" });
    expect(parseMensagemDoModulo(ev({ type: "brain:navegar", resto: "" }), janela)).toEqual({ type: "brain:navegar", resto: "" });
    expect(parseMensagemDoModulo(ev({ type: "brain:abrirNota", id: "minha-nota-1" }), janela)).toEqual({ type: "brain:abrirNota", id: "minha-nota-1" });
    expect(parseMensagemDoModulo(ev({ type: "brain:badge", n: 0 }), janela)).toEqual({ type: "brain:badge", n: 0 });
  });
  it("recusa resto perigoso em navegar", () => {
    for (const resto of ["../x", "a/../b", "/abs", "https://x", "javascript:alert(1)", "a:b", "x".repeat(501), "a\\b"])
      expect(parseMensagemDoModulo(ev({ type: "brain:navegar", resto }), janela)).toBeUndefined();
    expect(parseMensagemDoModulo(ev({ type: "brain:navegar", resto: "x".repeat(500) }), janela)).toBeDefined();
  });
  it("recusa id de nota fora do formato", () => {
    for (const id of ["../x", "Maiuscula", "a/b", "a", "-ab", "ab-", "a b", "x".repeat(121)])
      expect(parseMensagemDoModulo(ev({ type: "brain:abrirNota", id }), janela)).toBeUndefined();
  });
  it("recusa badge que não é inteiro finito >= 0", () => {
    for (const n of [-1, 1.5, Number.NaN, Infinity, -Infinity])
      expect(parseMensagemDoModulo(ev({ type: "brain:badge", n }), janela)).toBeUndefined();
  });
});

describe("mensagemInit", () => {
  it("tem token, expira, nonce, tema, resto e apiBase /api/modules/<id>", () => {
    expect(mensagemInit("tok", "2030-01-01T00:00:00.000Z", "n1", "escuro", "a/b", "/api/modules/lembrete"))
      .toEqual({ type: "brain:init", token: "tok", expira: "2030-01-01T00:00:00.000Z", nonce: "n1", tema: "escuro", resto: "a/b", apiBase: "/api/modules/lembrete" });
  });
  it("brain:token carrega token e expira (e nada mais)", () => {
    expect(mensagemToken("t2", "2030-01-01T12:00:00.000Z")).toEqual({ type: "brain:token", token: "t2", expira: "2030-01-01T12:00:00.000Z" });
  });
});

describe("validadores", () => {
  it("idModuloValido segue o formato de id de módulo", () => {
    expect(idModuloValido("lembrete")).toBe(true);
    for (const id of ["", "a", "1abc", "Abc", "a/b", "a..b", "a".repeat(32), "../x"]) expect(idModuloValido(id)).toBe(false);
  });
  it("restoValido", () => { expect(restoValido("")).toBe(true); expect(restoValido("..")).toBe(false); });
});

describe("restoDoHash", () => {
  it("devolve o resto da rota do próprio módulo", () => {
    expect(restoDoHash("#/m/lembrete", "lembrete")).toBe("");
    expect(restoDoHash("#/m/lembrete/item/3?x=1", "lembrete")).toBe("item/3");
    expect(restoDoHash("#/m/lembrete/a%20b", "lembrete")).toBe("a b");
  });
  it("undefined fora de #/m/<id>: outra tela, outro módulo, hash vazio ou codificação inválida", () => {
    for (const h of ["", "#", "#/graph", "#/note/abc", "#/m/outro/x", "#/m", "#/m/lembrete%ZZ"]) expect(restoDoHash(h, "lembrete"), h).toBeUndefined();
  });
  it("resto inválido vira vazio (como o useRoute)", () => { expect(restoDoHash("#/m/lembrete/%2e%2e/x", "lembrete")).toBe(""); });
});

describe("deveRemontar", () => {
  it("não remonta quando a rota acompanha o último resto enviado pelo módulo", () => { expect(deveRemontar("a/b", "a/b")).toBe(false); expect(deveRemontar("", "")).toBe(false); });
  it("remonta quando o resto muda por fora", () => { expect(deveRemontar("", "a/b")).toBe(true); expect(deveRemontar("x", "")).toBe(true); });
});

describe("criarControleRemontagem", () => {
  it("navegar e depois mudar por fora para o resto inicial remonta", () => {
    const c = criarControleRemontagem("");
    c.aoNavegar("a/b");
    expect(c.aoMudarHash("")).toBe(true); // clique no item do menu do próprio módulo
    expect(c.ultimo()).toBe("");
    expect(c.aoMudarHash("")).toBe(false); // sem laço
  });
  it("hash igual ao último navegado não remonta; outro resto remonta uma vez", () => {
    const c = criarControleRemontagem("x");
    c.aoNavegar("a/b");
    expect(c.aoMudarHash("a/b")).toBe(false);
    expect(c.aoMudarHash("c")).toBe(true);
    expect(c.aoMudarHash("c")).toBe(false);
  });
});

describe("criarControlePonte", () => {
  it("brain:pronto só vale uma vez por montagem do iframe e devolve o nonce", () => {
    const p = criarControlePonte(() => "n1");
    expect(p.aoPronto()).toBe("n1");
    expect(p.aoPronto()).toBeUndefined(); // um segundo pronto (outro documento no mesmo iframe) não recebe nonce nem token
    expect(p.aoCarregar()).toBe(true);
    expect(p.podeEnviar()).toBe(true);
  });
  it("pronto antes ou depois do primeiro load é aceito", () => {
    const p = criarControlePonte(() => "n1");
    expect(p.aoCarregar()).toBe(true);
    expect(p.aoPronto()).toBe("n1");
  });
  it("o nonce padrão é aleatório e diferente a cada montagem", () => {
    const a = criarControlePonte().aoPronto()!; const b = criarControlePonte().aoPronto()!;
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(b).not.toBe(a);
  });
  it("renovação: só com o nonce da montagem atual, depois do pronto", () => {
    const p = criarControlePonte(() => "n1");
    expect(p.aoRenovar("n1")).toBe(false); // sem pronto aceito ainda
    p.aoPronto();
    expect(p.aoRenovar("n1")).toBe(true);
    expect(p.aoRenovar("n1")).toBe(true); // renovações repetidas com o mesmo nonce valem (várias horas de aba aberta)
    for (const n of ["", "n2", "N1", "n1 "]) expect(p.aoRenovar(n)).toBe(false);
    // nonce de outra montagem não vale nesta
    const outra = criarControlePonte(() => "n9"); outra.aoPronto();
    expect(p.aoRenovar("n9")).toBe(false);
  });
  it("segundo load (o iframe navegou para outro documento) corta a credencial de vez, inclusive a renovação", () => {
    const p = criarControlePonte(() => "n1");
    p.aoCarregar(); p.aoPronto();
    expect(p.aoCarregar()).toBe(false);
    expect(p.podeEnviar()).toBe(false);
    expect(p.aoPronto()).toBeUndefined();
    expect(p.aoRenovar("n1")).toBe(false);
    expect(p.aoCarregar()).toBe(false);
  });
  it("navegou antes de qualquer pronto: nada é enviado", () => {
    const p = criarControlePonte(() => "n1");
    p.aoCarregar(); p.aoCarregar();
    expect(p.aoPronto()).toBeUndefined();
    expect(p.podeEnviar()).toBe(false);
  });
});
