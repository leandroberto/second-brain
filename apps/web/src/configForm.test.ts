import { describe, expect, it } from "vitest";
import { AVISO_SEM_VALIDAR, avisoDeValidacao, camposDoSchema, configDoFormulario, esperarReinicio, valoresIniciais } from "./configForm";

// `configJson` do exemplo `lembrete` (examples/modules/lembrete/src), como o módulo o publica
const SCHEMA_LEMBRETE = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { horario: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }, ia: { default: false, type: "boolean" } },
  required: ["horario", "ia"],
  additionalProperties: false,
};

describe("camposDoSchema", () => {
  it("lembrete: horario texto obrigatório e ia booleano com padrão false", () => {
    expect(camposDoSchema(SCHEMA_LEMBRETE)).toEqual([
      { nome: "horario", tipo: "texto", rotulo: "horario", obrigatorio: true },
      { nome: "ia", tipo: "booleano", rotulo: "ia", obrigatorio: true, padrao: false },
    ]);
  });

  it("número, inteiro, título e descrição", () => {
    const c = camposDoSchema({ type: "object", properties: { n: { type: "integer", title: "Quantidade", description: "quantos", default: 3 }, x: { type: "number" } }, required: ["n"] });
    expect(c).toEqual([
      { nome: "n", tipo: "numero", rotulo: "Quantidade", descricao: "quantos", obrigatorio: true, padrao: 3 },
      { nome: "x", tipo: "numero", rotulo: "x", obrigatorio: false },
    ]);
  });

  it("enum vira opções", () => {
    const c = camposDoSchema({ type: "object", properties: { modo: { type: "string", enum: ["a", "b"] } } });
    expect(c).toEqual([{ nome: "modo", tipo: "opcoes", rotulo: "modo", obrigatorio: false, opcoes: ["a", "b"] }]);
  });

  it("objeto aninhado, array ou forma desconhecida → undefined (editor JSON)", () => {
    expect(camposDoSchema({ type: "object", properties: { a: { type: "object", properties: {} } } })).toBeUndefined();
    expect(camposDoSchema({ type: "object", properties: { a: { type: "array", items: { type: "string" } } } })).toBeUndefined();
    expect(camposDoSchema({ type: "object", properties: { a: { anyOf: [{ type: "string" }] } } })).toBeUndefined();
    expect(camposDoSchema({ type: "object", properties: { a: { enum: [1, 2] } } })).toBeUndefined();
    expect(camposDoSchema({ type: "string" })).toBeUndefined();
    expect(camposDoSchema(undefined)).toBeUndefined();
    expect(camposDoSchema([])).toBeUndefined();
  });
});

describe("valoresIniciais", () => {
  const campos = camposDoSchema(SCHEMA_LEMBRETE)!;
  it("usa a config existente e cai no padrão", () => {
    expect(valoresIniciais(campos, { horario: "08:30" })).toEqual({ horario: "08:30", ia: false });
    expect(valoresIniciais(campos, { horario: "08:30", ia: true })).toEqual({ horario: "08:30", ia: true });
    expect(valoresIniciais(campos)).toEqual({ ia: false });
  });
});

describe("configDoFormulario", () => {
  it("converte números e descarta campos vazios", () => {
    const campos = camposDoSchema({ type: "object", properties: { n: { type: "number" }, t: { type: "string" }, b: { type: "boolean" } } })!;
    expect(configDoFormulario(campos, { n: "4.5", t: "", b: true })).toEqual({ n: 4.5, b: true });
    expect(configDoFormulario(campos, { n: "abc", t: "x" })).toEqual({ n: "abc", t: "x" }); // o servidor recusa; não inventa valor
  });

  it("mescla sobre a config atual: chaves fora do schema ficam; campo do schema esvaziado sai", () => {
    const campos = camposDoSchema({ type: "object", properties: { t: { type: "string" }, n: { type: "number" } } })!;
    const atual = { t: "antes", n: 3, extra: { a: 1 }, outra: "x" };
    expect(configDoFormulario(campos, { t: "", n: "7" }, atual)).toEqual({ n: 7, extra: { a: 1 }, outra: "x" });
    expect(atual).toEqual({ t: "antes", n: 3, extra: { a: 1 }, outra: "x" }); // não muda a original
  });
});

describe("avisoDeValidacao", () => {
  it("falho ou ausente sem schema, e o que não roda aqui num vault com frase: não dá para validar agora", () => {
    const sem = { temSchema: false, desligado: false, fraseSenha: false };
    expect(avisoDeValidacao({ ...sem, status: "falho" })).toBe(AVISO_SEM_VALIDAR);
    expect(avisoDeValidacao({ ...sem, status: "ausente" })).toBe(AVISO_SEM_VALIDAR);
    expect(avisoDeValidacao({ ...sem, status: "falho", temSchema: true })).toBeUndefined(); // falhou pela config: o schema valida
    expect(avisoDeValidacao({ ...sem, status: "ativo" })).toBeUndefined();
    expect(avisoDeValidacao({ ...sem, status: undefined, desligado: true })).toBeUndefined(); // sem frase: a conferência valida
    expect(avisoDeValidacao({ ...sem, status: undefined, desligado: true, fraseSenha: true })).toBe(AVISO_SEM_VALIDAR);
    expect(avisoDeValidacao({ ...sem, status: "inativo", fraseSenha: true })).toBe(AVISO_SEM_VALIDAR);
    expect(AVISO_SEM_VALIDAR).toBe("Não foi possível validar agora: a configuração será conferida quando o módulo voltar a carregar.");
  });
});

describe("esperarReinicio", () => {
  it("pid antigo, falha de rede, pid novo → ok", async () => {
    const respostas: Array<() => Promise<{ pid: number } | undefined>> = [
      async () => ({ pid: 10 }), async () => { throw new Error("rede"); }, async () => ({ pid: 11 }),
    ];
    let i = 0;
    expect(await esperarReinicio(10, { buscar: () => respostas[i++]!(), intervaloMs: 1, limiteMs: 2000 })).toBe("ok");
    expect(i).toBe(3);
  });

  it("sempre o pid antigo → tempo", async () => {
    expect(await esperarReinicio(10, { buscar: async () => ({ pid: 10 }), intervaloMs: 2, limiteMs: 40 })).toBe("tempo");
  });

  it("sem pid antigo: ok só depois de uma falha e de a resposta voltar", async () => {
    const r: Array<() => Promise<{ pid: number } | undefined>> = [async () => ({ pid: 5 }), async () => { throw new Error("rede"); }, async () => ({ pid: 5 })];
    let i = 0;
    expect(await esperarReinicio(undefined, { buscar: () => r[i++]!(), intervaloMs: 1, limiteMs: 2000 })).toBe("ok");
    expect(i).toBe(3);
    expect(await esperarReinicio(undefined, { buscar: async () => ({ pid: 5 }), intervaloMs: 2, limiteMs: 30 })).toBe("tempo");
  });
});
