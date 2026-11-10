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

/** true somente para loopback EXATO (sem credenciais na URL). "localhost.evil.com" NÃO é local. */
export function isLocalUrl(u: string): boolean {
  try {
    const x = new URL(u);
    if (x.username || x.password) return false;
    if (x.protocol !== "http:" && x.protocol !== "https:") return false;
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(x.hostname);
  } catch { return false; }
}

/** Endpoint compatível com OpenAI /v1/embeddings (OpenAI, Ollama, LM Studio, vLLM...). Opt-in. */
export class OpenAICompatibleEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly external: boolean;
  constructor(private o: { baseUrl: string; model: string; apiKey?: string; dim: number }) {
    this.id = `oa:${o.model}`;
    this.external = !isLocalUrl(o.baseUrl);
  }
  get dim() { return this.o.dim; }
  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
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
