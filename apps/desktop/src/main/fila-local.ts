import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { FalhaCliente, RespostaAnotar } from './cliente-api';

/**
 * Anotações que não chegaram à API (second-brain parado ou desktop sem pareamento). O texto ditado fica exatamente
 * como foi digitado, em <userData>/fila-local.json, gravado de forma atômica (arquivo temporário + rename), e sai da
 * fila só quando a API responde 200.
 *
 * Nada some em silêncio:
 * - arquivo ilegível vira `.corrompido-<ts>` (conteúdo original preservado) e gera um aviso;
 * - itens malformados vão para `.descartados-<ts>.json`;
 * - item que a API recusa 5 vezes seguidas vai para `fila-local.quarentena.json` e a fila segue;
 * - item que fica em dúvida (`incerto`: o servidor pode ter gravado) vai direto para a quarentena, sem reenvio.
 */

export const MAX_TENTATIVAS = 5;

interface Item {
  id: string;
  texto: string;
  em: string;
  tentativas?: number;
}

export interface ResultadoEnvio {
  enviados: Array<{ texto: string; resposta: Extract<RespostaAnotar, { ok: true }> }>;
  /** Textos que foram para a quarentena neste ciclo. */
  quarentenados: string[];
  /** Falha que interrompeu o ciclo (a ordem é preservada). */
  falha?: FalhaCliente;
}

/** Avisos de arquivo corrompido da fila local E do diário em-voo: nenhum dos dois pode ficar oculto. */
export function avisosDasFilas(fila: FilaLocal, emVoo: FilaLocal): string[] {
  return [...fila.obterAvisos(), ...emVoo.obterAvisos()];
}

const carimbo = (): string => new Date().toISOString().replace(/[:.]/g, '-');
const itemValido = (i: unknown): i is Item =>
  typeof (i as Item)?.id === 'string' && typeof (i as Item)?.texto === 'string';

export class FilaLocal {
  readonly arquivoQuarentena: string;
  private enviando: Promise<ResultadoEnvio> | null = null;
  private readonly avisos: string[] = [];
  /** Aceitos pela API (200) cuja remoção do disco falhou: nunca são reenviados nesta execução. */
  private readonly aceitos = new Set<string>();

  constructor(private readonly arquivo: string) {
    this.arquivoQuarentena = arquivo.replace(/\.json$/, '') + '.quarentena.json';
  }

  /** Nomes dos arquivos `.corrompido-*` criados desde a última chamada (o main avisa uma vez). */
  obterAvisos(): string[] {
    return this.avisos.splice(0);
  }

  private ler(): Item[] {
    let bruto: string;
    try {
      bruto = readFileSync(this.arquivo, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e; // leitura que falhou por outro motivo (arquivo em uso): não é "fila vazia"
    }
    let dados: unknown;
    try {
      dados = JSON.parse(bruto);
    } catch {
      dados = undefined;
    }
    if (!Array.isArray(dados)) {
      const destino = `${this.arquivo}.corrompido-${carimbo()}`;
      renameSync(this.arquivo, destino);
      this.avisos.push(basename(destino));
      return [];
    }
    const bons = dados.filter(itemValido);
    if (bons.length !== dados.length) {
      writeFileSync(`${this.arquivo}.descartados-${carimbo()}.json`, JSON.stringify(dados.filter((i) => !itemValido(i)), null, 2), 'utf8');
      this.gravar(bons);
    }
    return bons.filter((i) => !this.aceitos.has(i.id));
  }

  private gravar(itens: Item[]): void {
    mkdirSync(dirname(this.arquivo), { recursive: true });
    const tmp = `${this.arquivo}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(itens, null, 2), 'utf8');
    renameSync(tmp, this.arquivo);
  }

  adicionar(texto: string): string {
    const id = randomUUID();
    this.gravar([...this.ler(), { id, texto, em: new Date().toISOString() }]);
    return id;
  }

  remover(id: string): void {
    this.gravar(this.ler().filter((i) => i.id !== id));
  }

  pendentes(): string[] {
    return this.ler().map((i) => i.texto);
  }

  quarentena(): string[] {
    try {
      const dados = JSON.parse(readFileSync(this.arquivoQuarentena, 'utf8'));
      return Array.isArray(dados) ? dados.filter(itemValido).map((i) => i.texto) : [];
    } catch {
      return [];
    }
  }

  private paraQuarentena(item: Item): void {
    let atual: unknown[] = [];
    try {
      const d = JSON.parse(readFileSync(this.arquivoQuarentena, 'utf8'));
      if (Array.isArray(d)) atual = d;
    } catch {
      /* sem quarentena ainda */
    }
    const tmp = `${this.arquivoQuarentena}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...atual, item], null, 2), 'utf8');
    renameSync(tmp, this.arquivoQuarentena);
  }

  /** Envia em ordem e remove só o que a API aceitou. Chamadas simultâneas compartilham o mesmo envio. */
  enviar(cliente: { anotar(texto: string): Promise<RespostaAnotar> }): Promise<ResultadoEnvio> {
    if (this.enviando) return this.enviando;
    this.enviando = this.enviarTudo(cliente).finally(() => {
      this.enviando = null;
    });
    return this.enviando;
  }

  private async enviarTudo(cliente: { anotar(texto: string): Promise<RespostaAnotar> }): Promise<ResultadoEnvio> {
    const resultado: ResultadoEnvio = { enviados: [], quarentenados: [] };
    for (;;) {
      const primeiro = this.ler()[0];
      if (!primeiro) return resultado;
      const resposta = await cliente.anotar(primeiro.texto);
      if (!resposta.ok) {
        // offline e falta de pareamento não são culpa do item: não contam tentativa
        if (resposta.tipo === 'offline' || resposta.tipo === 'pareamento') return { ...resultado, falha: resposta };
        const tentativas = (primeiro.tentativas ?? 0) + 1;
        // `incerto` (timeout, 5xx em anotar): o servidor pode ter gravado; reenviar duplicaria. Vai direto para a quarentena.
        if (resposta.tipo !== 'incerto' && tentativas < MAX_TENTATIVAS) {
          this.gravar(this.ler().map((i) => (i.id === primeiro.id ? { ...i, tentativas } : i)));
          return { ...resultado, falha: resposta }; // mantém a ordem: tenta de novo no próximo ciclo
        }
        this.paraQuarentena({ ...primeiro, tentativas });
        resultado.quarentenados.push(primeiro.texto);
        this.retirar(primeiro.id);
        continue;
      }
      this.retirar(primeiro.id);
      resultado.enviados.push({ texto: primeiro.texto, resposta });
    }
  }

  /** Tira o item da fila; se o disco falhar depois de a API aceitar, lembra o id para nunca reenviar. */
  private retirar(id: string): void {
    this.aceitos.add(id);
    try {
      this.gravar(this.ler().filter((i) => i.id !== id));
      this.aceitos.delete(id);
    } catch {
      /* o id fica em `aceitos`: ler() o esconde e a próxima gravação bem-sucedida o leva embora */
    }
  }
}
