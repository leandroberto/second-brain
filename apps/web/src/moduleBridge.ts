// Ponte postMessage entre o Second Brain e a aba de um módulo (iframe de origem opaca).
// Funções puras: sem React, sem DOM.

export type MsgModulo =
  | { type: "brain:pronto" }
  | { type: "brain:navegar"; resto: string }
  | { type: "brain:abrirNota"; id: string }
  | { type: "brain:badge"; n: number }
  | { type: "brain:renovar"; nonce: string };

export type Tema = "claro" | "escuro";

/** Mesmo formato de id de módulo do core (ver `modules/`). */
export const idModuloValido = (id: string): boolean => /^[a-z][a-z0-9-]{1,30}$/.test(id);
/** Mesmo formato de id de nota (`ID_PATTERN` de @brain/shared), usado nas rotas `#/note/<id>`. */
const idNotaValido = (id: string): boolean => /^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/.test(id);

/** `resto` da rota do módulo: relativo, curto, sem `..`, sem esquema (`:`) e sem começar com `/`. */
export const restoValido = (s: unknown): s is string =>
  typeof s === "string" && s.length <= 500 && !s.includes("..") && !s.includes(":") && !s.includes("\\") && !s.startsWith("/");

/**
 * Valida uma mensagem vinda do iframe. Só vale `origin === "null"` (origem opaca do sandbox) vinda exatamente da
 * janela do iframe que o SB montou; qualquer outra coisa é ignorada.
 */
export function parseMensagemDoModulo(ev: { origin: string; source: unknown; data: unknown }, iframeWindow: unknown): MsgModulo | undefined {
  if (ev.origin !== "null") return undefined;
  if (iframeWindow == null || ev.source !== iframeWindow) return undefined;
  const d = ev.data;
  if (typeof d !== "object" || d === null) return undefined;
  const m = d as Record<string, unknown>;
  switch (m.type) {
    case "brain:pronto": return { type: "brain:pronto" };
    case "brain:navegar": return restoValido(m.resto) ? { type: "brain:navegar", resto: m.resto } : undefined;
    case "brain:abrirNota": return typeof m.id === "string" && idNotaValido(m.id) ? { type: "brain:abrirNota", id: m.id } : undefined;
    case "brain:renovar": return typeof m.nonce === "string" && m.nonce.length > 0 && m.nonce.length <= 128 ? { type: "brain:renovar", nonce: m.nonce } : undefined;
    case "brain:badge": return typeof m.n === "number" && Number.isInteger(m.n) && m.n >= 0 ? { type: "brain:badge", n: m.n } : undefined;
    default: return undefined;
  }
}

/** `expira` (ISO) é de `token`; `nonce` vale só para esta montagem e autoriza os pedidos `brain:renovar` dela. */
export const mensagemInit = (token: string, expira: string, nonce: string, tema: Tema, resto: string, apiBase: string) => ({ type: "brain:init" as const, token, expira, nonce, apiBase, tema, resto });
/** Resposta a um `brain:renovar` válido: o SB nunca envia token sem esse pedido. */
export const mensagemToken = (token: string, expira: string) => ({ type: "brain:token" as const, token, expira });
export const mensagemTema = (tema: Tema) => ({ type: "brain:tema" as const, tema });

/**
 * `resto` da rota `#/m/<id>/<resto>` para o módulo `id`, lido de um `location.hash` (mesmo parse do `useRoute`).
 * `undefined` = o hash não é do módulo (outra tela ou outro módulo): o `hashchange` deve ser ignorado, sem remontar.
 */
export function restoDoHash(hash: string, id: string): string | undefined {
  const [path = ""] = hash.replace(/^#\/?/, "").split("?");
  let seg: string[]; try { seg = path.split("/").filter(Boolean).map(decodeURIComponent); } catch { return undefined; }
  if (seg[0] !== "m" || seg[1] !== id) return undefined;
  const r = seg.slice(2).join("/");
  return restoValido(r) ? r : "";
}

/**
 * Decide se a aba deve ser remontada: o `resto` da rota diferente do último que o próprio módulo enviou por
 * `brain:navegar` (ou do inicial) significa mudança externa (link, menu, voltar). Mudança vinda do módulo não remonta.
 */
export const deveRemontar = (restoDaRota: string, ultimoDoModulo: string): boolean => restoDaRota !== ultimoDoModulo;

/** Controlador puro da remontagem: guarda o último resto conhecido do iframe e decide a cada mudança de hash. */
export function criarControleRemontagem(restoInicial: string) {
  let ultimo = restoInicial;
  return {
    ultimo: () => ultimo,
    /** O módulo navegou sozinho (`brain:navegar`): não remonta. */
    aoNavegar(resto: string): void { ultimo = resto; },
    /** O hash mudou (qualquer origem que dispare `hashchange`): true se o iframe deve ser remontado com `resto`. */
    aoMudarHash(resto: string): boolean { if (!deveRemontar(resto, ultimo)) return false; ultimo = resto; return true; },
  };
}

const nonceAleatorio = (): string => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Controle da ponte de UM iframe montado (defesa em profundidade). O token só vai para o documento da aba que o SB carregou,
 * e a renovação é por pedido (pull) com nonce:
 * - `brain:pronto` é aceito uma única vez por montagem (outro documento no mesmo iframe pediria o token de novo) e gera o
 *   nonce, que só vai no `brain:init` desse documento;
 * - `brain:renovar` só é atendido com esse nonce e enquanto a ponte não foi cortada: o SB nunca empurra token sem pedido;
 * - o primeiro `load` é o da aba; um segundo `load` significa que o iframe navegou para outro documento (link externo, form,
 *   `location = ...`), e a partir daí nada mais é enviado (nem renovação de token). O SB então remonta ou mostra erro.
 */
export function criarControlePonte(gerarNonce: () => string = nonceAleatorio) {
  let cargas = 0; let nonce: string | undefined; let cortada = false;
  return {
    /** Evento `load` do iframe: `false` quando é uma navegação para outro documento (a credencial foi cortada). */
    aoCarregar(): boolean { cargas++; if (cargas > 1) cortada = true; return !cortada; },
    /** `brain:pronto`: o nonce só na primeira vez e enquanto a ponte não foi cortada (então envie `brain:init` com ele). */
    aoPronto(): string | undefined { if (cortada || nonce !== undefined) return undefined; nonce = gerarNonce(); return nonce; },
    /** `brain:renovar`: `true` só com o nonce desta montagem e a ponte viva (reconfira depois de qualquer espera). */
    aoRenovar(n: string): boolean { return !cortada && nonce !== undefined && n === nonce; },
    /** Ainda pode mandar mensagens (token, tema) para o iframe. */
    podeEnviar(): boolean { return !cortada; },
  };
}
