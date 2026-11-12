import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { MODULE_ID_RE, safeResolve } from "@brain/core";
import { moduloDaRotaDePagina, type ModulesApiOptions } from "./modules.js";

// ---- Aba do módulo (§7.7): token de página, origem opaca e estático ----

const TTL_PAGINA_MS = 12 * 3600_000;
/** Tokens de página vivos por módulo; ao passar, os mais antigos caem (cada `brain:renovar` emite um novo). */
export const MAX_TOKENS_POR_MODULO = 20;
const hashDoToken = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * Tokens de página em memória do processo (reiniciar o `serve` invalida todos). Guarda só o SHA-256: a busca é pelo hash
 * do que o cliente apresentou, então o segredo nunca é comparado byte a byte. Cada emissão gera um token novo.
 * Cada token lembra o hash da sessão humana que o emitiu, e `sessaoViva` é consultada A CADA USO: sessão revogada
 * (`brain admin revoke-sessions`) ou expirada derruba na hora os tokens de página que ela emitiu.
 */
export class TokensDePagina {
  private readonly porHash = new Map<string, { modulo: string; expira: number; sessao: string }>();
  constructor(private readonly sessaoViva: (hashDaSessao: string) => boolean) {}

  emitir(modulo: string, sessaoEmissora: string): { token: string; expira: string } {
    const agora = Date.now();
    // uma varredura só: remove os expirados e conta os vivos do módulo (o `Map` guarda a ordem de emissão)
    const doModulo: string[] = [];
    for (const [h, e] of this.porHash) {
      if (e.expira <= agora) this.porHash.delete(h);
      else if (e.modulo === modulo) doModulo.push(h);
    }
    for (const h of doModulo.slice(0, Math.max(0, doModulo.length - (MAX_TOKENS_POR_MODULO - 1)))) this.porHash.delete(h);
    const token = randomBytes(32).toString("base64url");
    const expira = agora + TTL_PAGINA_MS;
    this.porHash.set(hashDoToken(token), { modulo, expira, sessao: hashDoToken(sessaoEmissora) });
    return { token, expira: new Date(expira).toISOString() };
  }

  /** Id do módulo do token, ou `undefined` (desconhecido, expirado ou de uma sessão que já não está viva; é descartado). */
  modulo(token: string): string | undefined {
    if (!token) return undefined;
    const h = hashDoToken(token);
    const e = this.porHash.get(h);
    if (!e) return undefined;
    if (e.expira <= Date.now() || !this.sessaoViva(e.sessao)) { this.porHash.delete(h); return undefined; }
    return e.modulo;
  }
}

/**
 * Caminhos em que a origem opaca `null` (iframe da aba, sem `allow-same-origin`) é aceita: o estático `/modules/*` e
 * `/api/modules/<id>/*` fora de ui-token/_mcp/_tarefas. A segurança vem do token de página, não da origem.
 */
export const aceitaOrigemOpaca = (caminho: string): boolean => caminho.startsWith("/modules/") || moduloDaRotaDePagina(caminho) !== undefined;
export const CORS_OPACO = { "access-control-allow-origin": "null", vary: "Origin" } as const;
export const PREFLIGHT_OPACO = {
  ...CORS_OPACO, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE", "access-control-max-age": "600",
} as const;
/**
 * CSP do estático da aba. O `sandbox` (sem `allow-same-origin`) força a origem opaca mesmo quando a página é aberta como
 * documento de topo (link numa nota, favorito, URL digitada, um `.svg` da aba): sem ele, ela rodaria na origem real do SB e
 * leria o `localStorage` onde a UI guarda a sessão humana (anti-objetivo do §4). Os subrecursos de um documento sandboxed
 * mandam `Origin: null`, que é exatamente o CORS aceito nos prefixos de módulo.
 */
export const CSP_DA_ABA = "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'; form-action 'self'; sandbox allow-scripts allow-forms";

/** Caminho cru com segmento `.`/`..` (inclusive `%2e`, e `\` que a URL trata como `/`): a URL já normalizou, então recusa. */
export const temSegmentoDePonto = (bruto: string): boolean =>
  bruto.split(/[\\/]/).some((s) => { const d = s.replace(/%2e/gi, "."); return d === "." || d === ".."; });

/** `packages/module-sdk/static`, localizado pelo pacote (não pelo layout do repositório). */
export function pastaEstaticaDoSdk(): string | undefined {
  try { return join(dirname(createRequire(import.meta.url).resolve("@brain/module-sdk/package.json")), "static"); } catch { return undefined; }
}
const ARQUIVOS_DO_SDK = new Set(["base.css", "brain-module-client.js"]);

/**
 * Arquivo de `/modules/<id>/<arquivo>` (dentro de `<dir>/<aba.pasta>`, via `safeResolve`) ou de `/modules/_sdk/<arquivo>`.
 * `undefined` = 404: módulo inexistente, não ativo, sem aba, traversal, symlink para fora ou arquivo ausente.
 * `_sdk` não colide com módulo: o id sempre começa com letra.
 */
export function arquivoDaAba(o: ModulesApiOptions | undefined, pastaSdk: string | undefined, caminho: string): string | undefined {
  const resto = caminho.slice("/modules/".length);
  const barra = resto.indexOf("/");
  if (barra < 0) return undefined;
  const id = resto.slice(0, barra);
  let rel: string;
  try { rel = decodeURIComponent(resto.slice(barra + 1)); } catch { return undefined; }
  if (id === "_sdk") return pastaSdk && ARQUIVOS_DO_SDK.has(rel) ? join(pastaSdk, rel) : undefined;
  if (!MODULE_ID_RE.test(id)) return undefined;
  const m = o?.registry.get(id);
  const pasta = m?.def?.aba?.pasta;
  if (!m || m.status !== "ativo" || typeof pasta !== "string") return undefined;
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  try {
    const raiz = safeResolve(m.dir, pasta); // a pasta declarada também não sai da raiz do módulo
    const arq = safeResolve(raiz, rel);
    return statSync(arq).isFile() ? arq : undefined;
  } catch { return undefined; }
}
