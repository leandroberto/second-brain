import { BrainError } from "@brain/shared";

/** Expressão cron de 5 campos (minuto hora dia-do-mês mês dia-da-semana), em hora local. */
export interface Cron {
  /** primeira ocorrência estritamente depois de `after` */
  next(after: Date): Date;
  /** ocorrência mais recente em `before` ou antes dele (o minuto de `before` conta) */
  prev(before: Date): Date;
}

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
    const a = dom.has(d.getDate()), b = dow.has(d.getDay());
    return domRestrito && dowRestrito ? a || b : a && b;
  };
  const MAX_PASSOS = 20000;

  return {
    next(after) {
      const d = new Date(after.getTime());
      d.setSeconds(0, 0);
      d.setMinutes(d.getMinutes() + 1);
      for (let i = 0; i < MAX_PASSOS; i++) {
        if (!mes.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
        if (!diaOk(d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
        if (!hor.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
        if (!min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
        return d;
      }
      throw new BrainError("invalid", "cron: nenhuma próxima ocorrência encontrada");
    },
    prev(before) {
      const d = new Date(before.getTime());
      d.setSeconds(0, 0);
      for (let i = 0; i < MAX_PASSOS; i++) {
        if (!mes.has(d.getMonth() + 1)) { d.setDate(0); d.setHours(23, 59, 0, 0); continue; }
        if (!diaOk(d)) { d.setDate(d.getDate() - 1); d.setHours(23, 59, 0, 0); continue; }
        if (!hor.has(d.getHours())) { d.setHours(d.getHours() - 1, 59, 0, 0); continue; }
        if (!min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() - 1, 0, 0); continue; }
        return d;
      }
      throw new BrainError("invalid", "cron: nenhuma ocorrência anterior encontrada");
    },
  };
}
