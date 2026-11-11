import { describe, expect, it } from "vitest";
import { idModuloValido, mensagemInit, parseMensagemDoModulo, restoValido } from "./moduleBridge";

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
  it("tem token, tema, resto e apiBase /api/modules/<id>", () => {
    expect(mensagemInit("tok", "escuro", "a/b", "/api/modules/lembrete")).toEqual({ type: "brain:init", token: "tok", tema: "escuro", resto: "a/b", apiBase: "/api/modules/lembrete" });
  });
});

describe("validadores", () => {
  it("idModuloValido segue o formato de id de módulo", () => {
    expect(idModuloValido("lembrete")).toBe(true);
    for (const id of ["", "a", "1abc", "Abc", "a/b", "a..b", "a".repeat(32), "../x"]) expect(idModuloValido(id)).toBe(false);
  });
  it("restoValido", () => { expect(restoValido("")).toBe(true); expect(restoValido("..")).toBe(false); });
});
