import { createHash } from "node:crypto";
import { tokenize } from "./text.js";

export interface EmbeddingProvider {
  /** identificador estável; mudar de provider invalida vetores */
  readonly id: string;
  readonly dim: number;
  /** true se o texto sai da máquina */
  readonly external: boolean;
  embed(texts: string[]): Promise<Float32Array[]>;
}

function h32(s: string): number {
  return createHash("md5").update(s).digest().readUInt32LE(0);
}

/**
 * Embedding offline determinístico (feature hashing de palavras, bigramas e trigramas de caracteres).
 * Captura sobreposição lexical/morfológica — NÃO é semântica profunda. Serve como fallback sempre
 * disponível e para detecção de quase-duplicatas; use um provider real para recall semântico.
 */
export class HashEmbedder implements EmbeddingProvider {
  readonly id = "hash-v1";
  readonly external = false;
  constructor(readonly dim = 512) {}
  async embed(texts: string[]): Promise<Float32Array[]> { return texts.map((t) => this.one(t)); }
  one(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const add = (feat: string, w: number) => {
      const h = h32(feat);
      v[h % this.dim]! += (h & 0x80000000 ? -1 : 1) * w;
    };
    const toks = tokenize(text);
    toks.forEach((t, i) => {
      add(`w:${t}`, 1);
      if (i > 0) add(`b:${toks[i - 1]}_${t}`, 0.6);
      if (t.length >= 5 && !/\d/.test(t)) for (let k = 0; k + 3 <= t.length; k++) add(`c:${t.slice(k, k + 3)}`, 0.15);
    });
    return normalize(v);
  }
}

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** true somente para loopback EXATO (sem credenciais na URL). "localhost.evil.com" NÃO é local. */
export function isLocalUrl(u: string): boolean {
  try {
    const x = new URL(u);
    if (x.username || x.password) return false;
    if (x.protocol !== "http:" && x.protocol !== "https:") return false;
    return LOOPBACK.includes(x.hostname);
  } catch { return false; }
}

/** Se a chave de embeddings pode ir para `baseUrl` e, quando não, o host e o motivo (para o aviso do doctor). */
export type ChaveDeEmbeddings = { envia: true } | { envia: false; host: string; motivo: "fora_da_lista" | "sem_https" };

/**
 * A chave só vai para um host de `hosts` (`embeddings.api_key_hosts`, editável só no config.yaml): hostname exato, em minúsculas,
 * sem curinga (a porta não entra na comparação) e com https, exceto no loopback. URL inválida, com credencial embutida ou de
 * outro protocolo nunca recebe a chave. Sem isso, quem troca `base_url` pela UI levaria a chave a um servidor qualquer.
 */
export function chaveDeEmbeddings(baseUrl: string, hosts: readonly string[]): ChaveDeEmbeddings {
  let x: URL;
  try { x = new URL(baseUrl); } catch { return { envia: false, host: baseUrl, motivo: "fora_da_lista" }; }
  const host = x.hostname.toLowerCase();
  const autorizados = new Set(hosts.map((h) => h.trim().toLowerCase()));
  // o IPv6 vem entre colchetes no `hostname`: "::1" na lista vale para "[::1]"
  const naLista = autorizados.has(host) || (host.startsWith("[") && autorizados.has(host.slice(1, -1)));
  if (!naLista || x.username || x.password || (x.protocol !== "https:" && x.protocol !== "http:")) return { envia: false, host, motivo: "fora_da_lista" };
  if (x.protocol === "http:" && !LOOPBACK.includes(host)) return { envia: false, host, motivo: "sem_https" };
  return { envia: true };
}

/** Endpoint compatível com OpenAI /v1/embeddings (OpenAI, Ollama, LM Studio, vLLM...). Opt-in. */
export class OpenAICompatibleEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly external: boolean;
  private readonly o: { baseUrl: string; model: string; dim: number };
  /** a credencial só fica guardada se `apiKeyHosts` autoriza o host de `baseUrl` (ver `chaveDeEmbeddings`) */
  private readonly apiKey: string | undefined;
  constructor({ apiKey, apiKeyHosts, ...o }: { baseUrl: string; model: string; apiKey?: string; apiKeyHosts: readonly string[]; dim: number }) {
    this.o = o;
    this.id = `oa:${o.model}`;
    this.external = !isLocalUrl(o.baseUrl);
    this.apiKey = chaveDeEmbeddings(o.baseUrl, apiKeyHosts).envia ? apiKey : undefined;
  }
  get dim() { return this.o.dim; }
  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.o.model, input: texts.map((t) => t.slice(0, 8000)) }),
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
    const j = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return j.data.map((d) => normalize(Float32Array.from(d.embedding)));
  }
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0; for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}
export const cosine = (a: Float32Array, b: Float32Array): number => {
  let s = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
};
