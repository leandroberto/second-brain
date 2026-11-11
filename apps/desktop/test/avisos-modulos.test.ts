import { describe, expect, test, vi } from "vitest";
import { criarVigiaAvisos, montarUrlAviso, type AvisoModulo } from "../src/main/avisos-modulos";
import type { ClienteApi } from "../src/main/cliente-api";

const aviso = (n: number, extra: Partial<AvisoModulo> = {}): AvisoModulo => ({
  id: `a${n}`,
  modulo: "lembrete",
  titulo: `Aviso ${n}`,
  criado: `2026-11-11T10:${String(n).padStart(2, "0")}:00.000Z`,
  visto: false,
  ...extra,
});

function montar(respostas: Array<{ avisos: AvisoModulo[]; cursor: string; total: number } | Error>) {
  const fila = [...respostas];
  const chamadas: Array<string | undefined> = [];
  const marcados: string[] = [];
  const cliente = {
    avisos: async (depois?: string) => {
      chamadas.push(depois);
      const r = fila.shift() ?? { avisos: [], cursor: "fim", total: 0 };
      if (r instanceof Error) throw r;
      return r;
    },
    marcarVisto: async (id: string) => void marcados.push(id),
  } as unknown as ClienteApi;
  const notificacoes: Array<{ titulo: string; corpo: string; aoClicar: () => void }> = [];
  const abertas: string[] = [];
  const totais: number[] = [];
  const vigia = criarVigiaAvisos({
    cliente,
    notificar: (n) => void notificacoes.push(n),
    abrir: (u) => void abertas.push(u),
    base: "http://localhost:3737",
    aoTotal: (n) => void totais.push(n),
  });
  return { vigia, chamadas, marcados, notificacoes, abertas, totais };
}

describe("vigia de avisos de módulo", () => {
  test("primeira leitura notifica no máximo 5 (os mais recentes) e o total vem do servidor", async () => {
    const t = montar([{ avisos: [1, 2, 3, 4, 5, 6, 7].map((n) => aviso(n)), cursor: "c1", total: 7 }]);
    await t.vigia.agora();
    expect(t.notificacoes.map((n) => n.titulo)).toEqual(["Aviso 7", "Aviso 6", "Aviso 5", "Aviso 4", "Aviso 3"]);
    expect(t.totais).toEqual([7]);
    expect(t.chamadas).toEqual([undefined]);
  });

  test("clique abre a aba e marca visto", async () => {
    const t = montar([{ avisos: [aviso(1, { link: "item/3", corpo: "corpo" })], cursor: "c1", total: 1 }]);
    await t.vigia.agora();
    expect(t.notificacoes[0]).toMatchObject({ titulo: "Aviso 1", corpo: "corpo" });
    t.notificacoes[0]!.aoClicar();
    await vi.waitFor(() => expect(t.marcados).toEqual(["a1"]));
    expect(t.abertas).toEqual(["http://localhost:3737/#/m/lembrete/item/3"]);
  });

  test("cursor avança, não repete e limita 5 por ciclo", async () => {
    const t = montar([
      { avisos: [aviso(1)], cursor: "c1", total: 1 },
      { avisos: [aviso(1), ...[2, 3, 4, 5, 6, 7, 8].map((n) => aviso(n))], cursor: "c2", total: 8 },
      { avisos: [], cursor: "c2", total: 8 },
    ]);
    await t.vigia.agora();
    await t.vigia.agora();
    await t.vigia.agora();
    expect(t.chamadas).toEqual([undefined, "c1", "c2"]);
    expect(t.notificacoes.map((n) => n.titulo)).toEqual(["Aviso 1", "Aviso 8", "Aviso 7", "Aviso 6", "Aviso 5", "Aviso 4"]);
  });

  test("não notifica avisos já vistos", async () => {
    const t = montar([{ avisos: [aviso(1, { visto: true }), aviso(2)], cursor: "c1", total: 1 }]);
    await t.vigia.agora();
    expect(t.notificacoes.map((n) => n.titulo)).toEqual(["Aviso 2"]);
  });

  test("erro de rede não lança, mantém o cursor e tenta de novo", async () => {
    const t = montar([{ avisos: [aviso(1)], cursor: "c1", total: 1 }, new Error("fetch failed"), { avisos: [aviso(2)], cursor: "c2", total: 2 }]);
    await t.vigia.agora();
    await expect(t.vigia.agora()).resolves.toBeUndefined();
    await t.vigia.agora();
    expect(t.chamadas).toEqual([undefined, "c1", "c1"]);
    expect(t.notificacoes.map((n) => n.titulo)).toEqual(["Aviso 1", "Aviso 2"]);
    expect(t.totais).toEqual([1, 2]);
  });

  test("aoTotal recebe o total, inclusive zero", async () => {
    const t = montar([{ avisos: [], cursor: "c0", total: 0 }, { avisos: [], cursor: "c0", total: 4 }]);
    await t.vigia.agora();
    await t.vigia.agora();
    expect(t.totais).toEqual([0, 4]);
  });

  test("iniciar consulta já e a cada intervalo; parar encerra", async () => {
    vi.useFakeTimers();
    try {
      const t = montar([]);
      t.vigia.iniciar();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.chamadas).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.chamadas).toHaveLength(2);
      t.vigia.parar();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(t.chamadas).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("montarUrlAviso (dados do servidor não são confiáveis)", () => {
  const base = "http://localhost:3737";
  const raiz = `${base}/#/m/lembrete/`;
  const url = (modulo: string, link?: string) => montarUrlAviso(base, { modulo, link });

  test("link válido, com segmentos codificados e barras preservadas", () => {
    expect(url("lembrete", "item/3")).toBe(`${raiz}item/3`);
    expect(url("lembrete", "a b/c?d#e")).toBe(`${raiz}a%20b/c%3Fd%23e`);
    expect(url("lembrete")).toBe(raiz);
  });

  test.each([
    ["..", "../x"],
    ["dois pontos", "https://evil.example/x"],
    ["esquema", "javascript:alert(1)"],
    ["barra invertida", "a\\b"],
    ["começa com barra", "/etc/passwd"],
    ["maior que 500", "a".repeat(501)],
  ])("link inválido (%s) cai na raiz do módulo", (_n, link) => {
    expect(url("lembrete", link)).toBe(raiz);
  });

  test("link de 500 caracteres ainda vale", () => {
    expect(url("lembrete", "a".repeat(500))).toBe(`${raiz}${"a".repeat(500)}`);
  });

  test.each(["Lembrete", "a", "1abc", "a/b", "a..b", "../x", "", "a".repeat(32), "a b"])("módulo inválido (%s) não abre nada", (m) => {
    expect(url(m, "item/3")).toBeNull();
  });

  test("clique com link inválido abre a raiz do módulo e ainda marca visto; módulo inválido só marca visto", async () => {
    const t = montar([
      {
        avisos: [aviso(1, { link: "../x" }), aviso(2, { modulo: "Ruim!" })],
        cursor: "c1",
        total: 2,
      },
    ]);
    await t.vigia.agora();
    for (const n of t.notificacoes) n.aoClicar();
    await vi.waitFor(() => expect(t.marcados.sort()).toEqual(["a1", "a2"]));
    expect(t.abertas).toEqual([raiz]);
  });
});
