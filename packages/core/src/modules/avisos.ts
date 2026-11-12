import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BrainError } from "@brain/shared";
import type { Aviso } from "@brain/module-sdk";
import { writeFileAtomic } from "../fs-atomic.js";
import { scanSecrets } from "../secrets.js";
import type { AvisosSink } from "./context.js";

export interface AvisoGravado { id: string; modulo: string; titulo: string; corpo?: string; link?: string; chave?: string; criado: string; visto: boolean }
export type EventoAviso = "module.notification" | "module.badge";
type Ouvinte = (ev: EventoAviso, data: unknown) => void;

const MAX_TITULO = 200;
const MAX_CORPO = 2000;
const MAX_LINK = 500;
const MAX_CHAVE = 200;
/** Quantos avisos o arquivo mantém ao compactar, e a partir de quantas linhas ele compacta. */
const MANTER = 500;
const LIMITE_LINHAS = 1000;

type Linha = AvisoGravado | { id: string; visto: true; marca: true };

function validar(a: Aviso): void {
  const texto = (campo: string, v: unknown, max: number, obrigatorio = false): void => {
    if (v === undefined && !obrigatorio) return;
    if (typeof v !== "string" || (obrigatorio && !v.trim())) throw new BrainError("invalid", `aviso: ${campo} inválido`);
    if (v.length > max) throw new BrainError("invalid", `aviso: ${campo} passa de ${max} caracteres`);
    if (scanSecrets(v).length) throw new BrainError("invalid", `aviso: ${campo} contém possível segredo`);
  };
  texto("titulo", a?.titulo, MAX_TITULO, true);
  texto("corpo", a?.corpo, MAX_CORPO);
  texto("link", a?.link, MAX_LINK);
  // chave definida precisa ter conteúdo: "" deduplicaria todos os avisos do módulo entre si
  texto("chave", a?.chave, MAX_CHAVE, a?.chave !== undefined);
  // o link é o `resto` relativo da aba (#/m/<id>/<link>): nada de caminho absoluto, //host ou esquema
  if (a.link !== undefined && (a.link.startsWith("/") || a.link.includes(":") || a.link.includes("\\"))) {
    throw new BrainError("invalid", "aviso: link deve ser relativo à aba do módulo (sem /, // nem esquema)");
  }
}

/**
 * Avisos (`<root>/_avisos.jsonl`, só-acréscimo com compactação atômica) e badges (memória + `<root>/_badges.json`).
 * O `serve` é o único escritor: o índice dos avisos fica em memória, é lido do disco só na construção e atualizado pelas
 * próprias escritas (disco primeiro, memória depois). Outro processo que grave no arquivo só é visto por uma instância nova.
 */
export class AvisosStore implements AvisosSink {
  private readonly arq: string;
  private readonly arqBadges: string;
  private badges: Record<string, number> = {};
  private readonly ouvintes = new Set<Ouvinte>();
  private ultimoTs = 0;
  private linhas = 0;
  /** avisos (com a marca de visto aplicada) em ordem de gravação (= ordem de id) */
  private indice: AvisoGravado[];

  constructor(private readonly root: string, onChange?: Ouvinte) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.arq = join(root, "_avisos.jsonl");
    this.arqBadges = join(root, "_badges.json");
    if (onChange) this.ouvintes.add(onChange);
    try {
      const b = JSON.parse(readFileSync(this.arqBadges, "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(b)) if (typeof v === "number" && Number.isFinite(v) && v > 0) this.badges[k] = Math.floor(v);
    } catch { /* sem badges gravados */ }
    this.indice = this.ler();
    const ult = this.indice[this.indice.length - 1];
    if (ult) this.ultimoTs = parseInt(ult.id.slice(0, 9), 36) || 0;
  }

  /** Assina os eventos; devolve a função que cancela. Erro de um ouvinte não afeta os demais. */
  aoMudar(fn: Ouvinte): () => void {
    this.ouvintes.add(fn);
    return () => { this.ouvintes.delete(fn); };
  }

  private emitir(ev: EventoAviso, data: unknown): void {
    for (const fn of [...this.ouvintes]) {
      try { fn(ev, data); } catch { /* ouvinte com defeito não derruba o aviso */ }
    }
  }

  private novoId(): string {
    this.ultimoTs = Math.max(Date.now(), this.ultimoTs + 1);
    return this.ultimoTs.toString(36).padStart(9, "0") + randomBytes(4).toString("hex");
  }

  /** Lê o arquivo aplicando as marcas de visto; ignora linhas corrompidas. Ordem de gravação (= ordem de id). */
  private ler(): AvisoGravado[] {
    let bruto: string;
    try { bruto = readFileSync(this.arq, "utf8"); } catch { return []; }
    const avisos = new Map<string, AvisoGravado>();
    const vistos = new Set<string>();
    let n = 0;
    for (const l of bruto.split("\n")) {
      if (!l.trim()) continue;
      n++;
      try {
        const o = JSON.parse(l) as Linha;
        if ("marca" in o) vistos.add(o.id);
        else avisos.set(o.id, o);
      } catch { /* linha truncada/corrompida */ }
    }
    this.linhas = n;
    return [...avisos.values()].map((a) => (vistos.has(a.id) ? { ...a, visto: true } : a));
  }

  /** Grava a linha e, só depois, aplica no índice em memória (se a gravação falhar, a memória fica como estava). */
  private acrescentar(l: Linha): void {
    const novo = !existsSync(this.arq);
    appendFileSync(this.arq, `${JSON.stringify(l)}\n`, { mode: 0o600 });
    if (novo) { try { chmodSync(this.arq, 0o600); } catch { /* best effort */ } }
    this.linhas++;
    if ("marca" in l) this.indice = this.indice.map((a) => (a.id === l.id ? { ...a, visto: true } : a));
    else this.indice.push({ ...l });
  }

  /**
   * Reescreve o arquivo (atômico) com no máximo `MANTER` avisos: TODOS os não vistos mais os vistos mais recentes até o limite.
   * Um não visto só sai se os não vistos sozinhos passarem do limite (ficam os mais recentes), com aviso no stderr.
   */
  private compactar(): void {
    const todos = this.indice;
    const naoVistos = todos.filter((a) => !a.visto);
    if (naoVistos.length > MANTER) {
      console.error(`[brain] avisos dos módulos: mais de ${MANTER} avisos não vistos; os mais antigos foram descartados (ficam os ${MANTER} mais recentes)`);
    }
    const manter = new Set((naoVistos.length >= MANTER ? naoVistos.slice(-MANTER) : [...naoVistos, ...todos.filter((a) => a.visto).slice(-(MANTER - naoVistos.length))]).map((a) => a.id));
    const mantidos = todos.filter((a) => manter.has(a.id));
    writeFileAtomic(this.arq, mantidos.map((a) => `${JSON.stringify(a)}\n`).join(""));
    this.linhas = mantidos.length;
    this.indice = mantidos;
  }

  async avisar(modulo: string, a: Aviso): Promise<AvisoGravado> {
    validar(a);
    const g: AvisoGravado = { id: this.novoId(), modulo, titulo: a.titulo, criado: new Date().toISOString(), visto: false };
    if (a.corpo !== undefined) g.corpo = a.corpo;
    if (a.link !== undefined) g.link = a.link;
    if (a.chave !== undefined) g.chave = a.chave;
    // a mesma chave substitui o aviso anterior ainda não visto: o novo é gravado ANTES de o anterior ser marcado como visto
    // (falha no meio deixa uma duplicata, nunca perde o aviso)
    const anteriores = g.chave === undefined ? [] : this.indice.filter((ant) => !ant.visto && ant.modulo === modulo && ant.chave === g.chave);
    this.acrescentar(g);
    let falha: unknown;
    try { for (const ant of anteriores) this.acrescentar({ id: ant.id, visto: true, marca: true }); } catch (e) { falha = e; }
    if (falha === undefined && this.linhas > LIMITE_LINHAS) this.compactar();
    this.emitir("module.notification", g);
    if (falha !== undefined) throw falha;
    return g;
  }

  listar(depois?: string): { avisos: AvisoGravado[]; cursor: string; badges: Record<string, number>; total: number } {
    const todos = this.indice;
    const avisos = todos.filter((a) => !a.visto && (depois === undefined || a.id > depois)).map((a) => ({ ...a }));
    const cursor = todos.length ? todos[todos.length - 1]!.id : (depois ?? "");
    const total = Object.values(this.badges).reduce((s, n) => s + n, 0);
    return { avisos, cursor, badges: { ...this.badges }, total };
  }

  marcarVisto(id: string): void {
    if (!this.indice.some((a) => a.id === id && !a.visto)) return;
    this.acrescentar({ id, visto: true, marca: true });
  }

  badge(modulo: string, n: number): void {
    const v = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    // disco primeiro, memória depois: se a gravação falhar, a memória fica como estava e o erro sobe
    const novos = { ...this.badges };
    if (v === 0) delete novos[modulo]; else novos[modulo] = v;
    writeFileAtomic(this.arqBadges, JSON.stringify(novos));
    this.badges = novos;
    const total = Object.values(this.badges).reduce((s, x) => s + x, 0);
    this.emitir("module.badge", { modulo, n: v, total });
  }
}
