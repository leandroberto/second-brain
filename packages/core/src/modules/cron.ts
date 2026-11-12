import { BrainError } from "@brain/shared";

/**
 * Expressão cron de 5 campos (minuto hora dia-do-mês mês dia-da-semana), em hora local. Horário de verão: uma hora que não
 * existe (pulo para frente) conta como a mesma hora depois do pulo (02:30 → 03:30), uma vez; uma hora que se repete (volta do
 * relógio) conta só na primeira passagem.
 */
export interface Cron {
  /** primeira ocorrência estritamente depois de `after` */
  next(after: Date): Date;
  /** ocorrência mais recente em `before` ou antes dele (o minuto de `before` conta) */
  prev(before: Date): Date;
}

const MIN = 60_000;
/** Maior salto do relógio local numa troca de horário (as zonas reais saltam 30 min a 2 h). */
const SALTO_MAX = 2 * 60 * MIN;
/** Candidatos examinados por busca: cobre a janela de 3 × SALTO_MAX (360 paredes) mesmo com cron de todo minuto. */
const MAX_CANDIDATOS = 1000;
/** Data/hora local de `d` (minuto cheio) como "parede": um Date cujos campos UTC são os campos locais. */
const parede = (d: Date): number => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes());
/** Instante da parede `w` no fuso local. */
const instante = (w: Date): Date => new Date(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes());

const LIMITES: Array<[string, number, number]> = [
  ["minuto", 0, 59], ["hora", 0, 23], ["dia do mês", 1, 31], ["mês", 1, 12], ["dia da semana", 0, 7],
];

function campo(txt: string, [nome, min, max]: [string, number, number]): Set<number> {
  const out = new Set<number>();
  const num = (s: string): number => {
    if (!/^\d+$/.test(s)) throw new BrainError("invalid", `cron: valor inválido "${s}" em ${nome}`);
    const n = Number(s);
    if (n < min || n > max) throw new BrainError("invalid", `cron: ${nome} fora de ${min}-${max}: ${n}`);
    return n;
  };
  for (const parte of txt.split(",")) {
    const [faixa, passoTxt, resto] = parte.split("/");
    if (resto !== undefined || faixa === "") throw new BrainError("invalid", `cron: campo inválido "${txt}" em ${nome}`);
    let passo = 1;
    if (passoTxt !== undefined) {
      passo = Number(passoTxt);
      if (!/^\d+$/.test(passoTxt) || passo < 1) throw new BrainError("invalid", `cron: passo inválido "${passoTxt}" em ${nome}`);
    }
    let de: number, ate: number;
    if (faixa === "*") { de = min; ate = max; }
    else if (faixa!.includes("-")) {
      const [a, b, extra] = faixa!.split("-");
      if (extra !== undefined) throw new BrainError("invalid", `cron: intervalo inválido "${faixa}" em ${nome}`);
      de = num(a!); ate = num(b!);
      if (de > ate) throw new BrainError("invalid", `cron: intervalo invertido "${faixa}" em ${nome}`);
    } else {
      de = num(faixa!);
      ate = passoTxt !== undefined ? max : de; // "5/10" = de 5 até o fim, de 10 em 10
    }
    for (let v = de; v <= ate; v += passo) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const partes = String(expr).trim().split(/\s+/);
  if (partes.length !== 5 || partes[0] === "") throw new BrainError("invalid", `cron: esperados 5 campos, recebidos ${partes[0] === "" ? 0 : partes.length}`);
  const [min, hor, dom, mes, dow] = partes.map((p, i) => campo(p, LIMITES[i]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (dow.has(7)) dow.add(0);
  // semântica clássica: com dia do mês E dia da semana restritos, vale um OU o outro
  const domRestrito = !partes[2]!.startsWith("*");
  const dowRestrito = !partes[4]!.startsWith("*");
  const diaOk = (d: Date): boolean => {
    const a = dom.has(d.getUTCDate()), b = dow.has(d.getUTCDay());
    return domRestrito && dowRestrito ? a || b : a && b;
  };
  const MAX_PASSOS = 20000;

  // As buscas andam no RELÓGIO DE PAREDE local (um Date cujos campos UTC são a data/hora local), sem fuso no meio: assim a
  // hora que o horário de verão pula ou repete não desorienta a busca. Só no fim a parede vira instante (`instante`).
  /** menor parede que casa, estritamente depois de `w` */
  const paredeSeguinte = (w: Date): Date => {
    const d = new Date(w.getTime() + MIN);
    for (let i = 0; i < MAX_PASSOS; i++) {
      if (!mes.has(d.getUTCMonth() + 1)) { d.setUTCMonth(d.getUTCMonth() + 1, 1); d.setUTCHours(0, 0, 0, 0); continue; }
      if (!diaOk(d)) { d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(0, 0, 0, 0); continue; }
      if (!hor.has(d.getUTCHours())) { d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0); continue; }
      if (!min.has(d.getUTCMinutes())) { d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0); continue; }
      return d;
    }
    throw new BrainError("invalid", "cron: nenhuma próxima ocorrência encontrada");
  };
  /** maior parede que casa, em `w` ou antes */
  const paredeAnterior = (w: Date): Date => {
    const d = new Date(w.getTime());
    for (let i = 0; i < MAX_PASSOS; i++) {
      if (!mes.has(d.getUTCMonth() + 1)) { d.setUTCDate(0); d.setUTCHours(23, 59, 0, 0); continue; }
      if (!diaOk(d)) { d.setUTCDate(d.getUTCDate() - 1); d.setUTCHours(23, 59, 0, 0); continue; }
      if (!hor.has(d.getUTCHours())) { d.setUTCHours(d.getUTCHours() - 1, 59, 0, 0); continue; }
      if (!min.has(d.getUTCMinutes())) { d.setUTCMinutes(d.getUTCMinutes() - 1, 0, 0); continue; }
      return d;
    }
    throw new BrainError("invalid", "cron: nenhuma ocorrência anterior encontrada");
  };

  // Uma parede vira instante pela regra do JS: hora inexistente (pulo para frente) avança junto com o relógio (02:30 → 03:30)
  // e hora repetida (volta) fica na primeira passagem. O instante NÃO é monotônico na parede perto de uma troca (com pulo de
  // 30 min ou 2 h, uma parede posterior pode dar um instante anterior), mas dista da parede no máximo SALTO_MAX. Por isso a
  // busca examina todas as paredes de uma janela: a partir de SALTO_MAX antes (next) / depois (prev) e até SALTO_MAX além da
  // primeira que serve, ficando com o menor (next) / maior (prev) instante.
  return {
    next(after) {
      let w = new Date(parede(after) - SALTO_MAX);
      let melhor: Date | undefined; let limite: number | undefined;
      for (let i = 0; i < MAX_CANDIDATOS; i++) {
        w = paredeSeguinte(w);
        if (limite !== undefined && w.getTime() > limite) return melhor!;
        const t = instante(w);
        if (t.getTime() > after.getTime()) {
          if (!melhor || t.getTime() < melhor.getTime()) melhor = t;
          limite ??= w.getTime() + SALTO_MAX;
        }
      }
      if (melhor) return melhor;
      throw new BrainError("invalid", "cron: nenhuma próxima ocorrência encontrada");
    },
    prev(before) {
      let w = new Date(parede(before) + SALTO_MAX + MIN);
      let melhor: Date | undefined; let limite: number | undefined;
      for (let i = 0; i < MAX_CANDIDATOS; i++) {
        w = paredeAnterior(new Date(w.getTime() - MIN));
        if (limite !== undefined && w.getTime() < limite) return melhor!;
        const t = instante(w);
        if (t.getTime() <= before.getTime()) {
          if (!melhor || t.getTime() > melhor.getTime()) melhor = t;
          limite ??= w.getTime() - SALTO_MAX;
        }
      }
      if (melhor) return melhor;
      throw new BrainError("invalid", "cron: nenhuma ocorrência anterior encontrada");
    },
  };
}
