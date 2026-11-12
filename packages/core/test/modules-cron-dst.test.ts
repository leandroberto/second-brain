import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleContext, ModuleDef, Tarefa, TarefaContext } from "@brain/module-sdk";
import { ModuleRegistry, Scheduler, parseCron } from "../src/index.js";

// Arquivo isolado: o fuso com horário de verão vale só aqui (o Node relê process.env.TZ a cada mudança).
// Em America/New_York, 2026-03-08 02:00 EST pula para 03:00 EDT e 2026-11-01 02:00 EDT volta para 01:00 EST.
const tzAntes = process.env.TZ;
beforeAll(() => { process.env.TZ = "America/New_York"; });
afterAll(() => { if (tzAntes === undefined) delete process.env.TZ; else process.env.TZ = tzAntes; });

const U = (a: number, m: number, d: number, h: number, mi: number) => new Date(Date.UTC(a, m - 1, d, h, mi));
// timers falsos (a data fica real: o agendador usa o relógio injetado): `esperar` avança o tempo sem dormir
const esperar = (ms = 60) => vi.advanceTimersByTimeAsync(ms);
const abertos: Scheduler[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); });
afterEach(async () => { await Promise.all(abertos.splice(0).map((s) => s.stop())); vi.useRealTimers(); });

function montar(t: Tarefa, inicial: Date, estado: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "brain-dst-"));
  writeFileSync(join(root, "_scheduler.json"), JSON.stringify(estado));
  const reg = new ModuleRegistry(root);
  reg.add({ id: "mod", def: { sdk: 1, id: "mod", nome: "Mod", versao: "1", tarefas: [t] } as ModuleDef, dir: root, status: "ativo", ctx: {} as ModuleContext });
  const relogio = { agora: inicial };
  const s = new Scheduler(reg, root, { agora: () => relogio.agora, tickMs: 10 });
  abertos.push(s);
  return { s, reg, relogio };
}

describe("cron com horário de verão (America/New_York)", () => {
  it("hora inexistente (pulo para frente) vira a próxima hora válida daquele dia, uma vez", () => {
    const c = parseCron("30 2 * * *");
    const ocorrencia = U(2026, 3, 8, 7, 30); // 03:30 EDT
    expect(c.next(U(2026, 3, 8, 6, 0))).toEqual(ocorrencia); // de 01:00 EST
    expect(c.prev(U(2026, 3, 8, 8, 0))).toEqual(ocorrencia); // de 04:00 EDT
    expect(c.prev(U(2026, 3, 8, 7, 10))).toEqual(U(2026, 3, 7, 7, 30)); // 03:10 EDT: a de hoje ainda não chegou
    expect(c.next(ocorrencia)).toEqual(U(2026, 3, 9, 6, 30)); // amanhã 02:30 EDT
    expect(parseCron("0 * * * *").next(U(2026, 3, 8, 6, 30))).toEqual(U(2026, 3, 8, 7, 0)); // 01:30 EST -> 03:00 EDT
  });

  it("hora repetida (volta do relógio): a ocorrência local é a primeira passagem, uma vez", () => {
    const c = parseCron("30 1 * * *");
    const primeira = U(2026, 11, 1, 5, 30); // 01:30 EDT
    expect(c.prev(U(2026, 11, 1, 6, 45))).toEqual(primeira); // 01:45 EST
    expect(c.prev(U(2026, 11, 1, 6, 10))).toEqual(primeira); // 01:10 EST
    expect(c.next(primeira)).toEqual(U(2026, 11, 2, 6, 30)); // amanhã 01:30 EST
    // 01:00 EST: o "01:00" local já passou (na primeira passagem); a última ocorrência é 01:45 EDT, 15 min antes
    expect(parseCron("*/15 * * * *").prev(U(2026, 11, 1, 6, 0))).toEqual(U(2026, 11, 1, 5, 45));
    expect(parseCron("*/15 * * * *").next(U(2026, 11, 1, 5, 45))).toEqual(U(2026, 11, 1, 7, 0)); // depois de 01:45 EDT: 02:00 EST
  });
});

describe("agendador com horário de verão (America/New_York)", () => {
  it("na volta do relógio não roda de novo a mesma ocorrência local", async () => {
    const ocs: Date[] = [];
    const t: Tarefa = { id: "t", quando: "*/15 * * * *", recuperar: true, rodar: async (c: TarefaContext) => { ocs.push(c.ocorrencia); } };
    const { s, relogio } = montar(t, U(2026, 11, 1, 5, 46), { "mod/t": { ultimaOcorrencia: U(2026, 11, 1, 5, 30).toISOString(), suspensa: false, errosSeguidos: 0 } });
    s.start(); await esperar();
    expect(ocs).toEqual([U(2026, 11, 1, 5, 45)]); // 01:45 EDT
    for (const agora of [U(2026, 11, 1, 6, 0), U(2026, 11, 1, 6, 16), U(2026, 11, 1, 6, 46)]) { relogio.agora = agora; await esperar(); } // 01:00, 01:15, 01:45 EST
    expect(ocs).toHaveLength(1);
    relogio.agora = U(2026, 11, 1, 7, 0); await esperar(); // 02:00 EST
    expect(ocs).toEqual([U(2026, 11, 1, 5, 45), U(2026, 11, 1, 7, 0)]);
  });

  it("no pulo para frente a ocorrência da hora inexistente roda uma vez, sem erro", async () => {
    const ocs: Date[] = [];
    const t: Tarefa = { id: "t", quando: "30 2 * * *", recuperar: true, rodar: async (c: TarefaContext) => { ocs.push(c.ocorrencia); } };
    const { s, reg, relogio } = montar(t, U(2026, 3, 8, 6, 59), { "mod/t": { ultimaOcorrencia: U(2026, 3, 7, 7, 30).toISOString(), suspensa: false, errosSeguidos: 0 } });
    s.start(); await esperar();
    for (const agora of [U(2026, 3, 8, 7, 10), U(2026, 3, 8, 7, 31), U(2026, 3, 8, 8, 0)]) { relogio.agora = agora; await esperar(); } // 03:10, 03:31, 04:00 EDT
    expect(ocs).toEqual([U(2026, 3, 8, 7, 30)]);
    expect(reg.errors("mod")).toEqual([]);
  });
});

describe("cron em fusos com salto de 30 min e de 2 h", () => {
  const comFuso = (tz: string, fn: () => void) => { const antes = process.env.TZ; process.env.TZ = tz; try { fn(); } finally { process.env.TZ = antes; } };

  it("Australia/Lord_Howe (pulo de 30 min): a parede inexistente 02:20 vira 02:50 e é a ocorrência mais recente", () => comFuso("Australia/Lord_Howe", () => {
    // 2026-10-04 02:00 LHST (+10:30) pula para 02:30 LHDT (+11)
    const c = parseCron("20,40 2 * * *");
    expect(c.prev(U(2026, 10, 3, 15, 55))).toEqual(U(2026, 10, 3, 15, 50)); // 02:55 LHDT -> 02:50 (parede 02:20)
    expect(c.next(U(2026, 10, 3, 15, 0))).toEqual(U(2026, 10, 3, 15, 40)); // 02:00 LHDT... -> 02:40 LHDT antes de 02:50
  }));

  it("Antarctica/Troll (pulo de 2 h): next fica com o menor instante, não com a primeira parede", () => comFuso("Antarctica/Troll", () => {
    // 2026-03-29 01:00 UTC: 01:00 (+0) pula para 03:00 (+2)
    const c = parseCron("0,30 2,3 * * *");
    expect(c.next(U(2026, 3, 29, 0, 59))).toEqual(U(2026, 3, 29, 1, 0)); // 03:00 local, não 02:00 UTC (parede 02:00)
    expect(c.prev(U(2026, 3, 29, 1, 45))).toEqual(U(2026, 3, 29, 1, 30));
  }));

  it("força bruta: next/prev batem com o mínimo/máximo de todas as ocorrências perto das trocas de horário", () => {
    const casos: Array<[string, Date[]]> = [
      ["America/New_York", [U(2026, 3, 8, 7, 0), U(2026, 11, 1, 6, 0)]],
      ["Australia/Lord_Howe", [U(2026, 10, 3, 15, 30), U(2026, 4, 4, 15, 0)]],
      ["Antarctica/Troll", [U(2026, 3, 29, 1, 0), U(2026, 10, 25, 1, 0)]],
    ];
    const crons: Array<[string, number[], number[]]> = [
      ["20,40 2 * * *", [20, 40], [2]], ["0,30 2,3 * * *", [0, 30], [2, 3]], ["*/15 * * * *", [0, 15, 30, 45], [...Array(24).keys()]],
      ["30 1 * * *", [30], [1]], ["0 * * * *", [0], [...Array(24).keys()]], ["45 2 * * *", [45], [2]],
    ];
    let divergencias = 0;
    for (const [tz, trocas] of casos) comFuso(tz, () => {
      for (const [expr, mins, horas] of crons) {
        const c = parseCron(expr);
        for (const troca of trocas) {
          // todas as ocorrências (parede → instante) num raio de 2 dias
          const ocorrencias: number[] = [];
          const ini = new Date(troca.getTime() - 2 * 86_400_000);
          for (let d = 0; d <= 4; d++) {
            const dia = new Date(ini.getFullYear(), ini.getMonth(), ini.getDate() + d, 12);
            for (const h of horas) for (const mi of mins) ocorrencias.push(new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), h, mi).getTime());
          }
          for (let x = troca.getTime() - 5 * 3600_000; x <= troca.getTime() + 5 * 3600_000; x += 10 * 60_000) {
            const esperadoNext = Math.min(...ocorrencias.filter((o) => o > x));
            const esperadoPrev = Math.max(...ocorrencias.filter((o) => o <= x));
            if (c.next(new Date(x)).getTime() !== esperadoNext) divergencias++;
            if (c.prev(new Date(x)).getTime() !== esperadoPrev) divergencias++;
          }
        }
      }
    });
    expect(divergencias).toBe(0);
  });
});
