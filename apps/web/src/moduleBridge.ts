// Ponte postMessage entre o Second Brain e a aba de um módulo (iframe de origem opaca).
// Funções puras: sem React, sem DOM.

export type MsgModulo =
  | { type: "brain:pronto"; nonce: string }
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

const nonceValido = (n: unknown): n is string => typeof n === "string" && n.length > 0 && n.length <= 128;

/** Fragmento do `src` do iframe: `#n=<nonce>&r=<resto codificado>`. O client lê o nonce e reescreve o hash como `#<resto>`. */
export const fragmentoDaAba = (nonce: string, resto: string): string => `#n=${nonce}&r=${encodeURIComponent(resto)}`;

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
    case "brain:pronto": return nonceValido(m.nonce) ? { type: "brain:pronto", nonce: m.nonce } : undefined;
    case "brain:navegar": return restoValido(m.resto) ? { type: "brain:navegar", resto: m.resto } : undefined;
    case "brain:abrirNota": return typeof m.id === "string" && idNotaValido(m.id) ? { type: "brain:abrirNota", id: m.id } : undefined;
    case "brain:renovar": return nonceValido(m.nonce) ? { type: "brain:renovar", nonce: m.nonce } : undefined;
    case "brain:badge": return typeof m.n === "number" && Number.isInteger(m.n) && m.n >= 0 ? { type: "brain:badge", n: m.n } : undefined;
    default: return undefined;
  }
}

/** `expira` (ISO) é de `token`. O nonce não vai aqui: o client já o tem, do fragmento do `src`. */
export const mensagemInit = (token: string, expira: string, tema: Tema, resto: string, apiBase: string) => ({ type: "brain:init" as const, token, expira, apiBase, tema, resto });
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

/** Intervalo mínimo entre duas emissões de token por `brain:renovar` (o client pede 1 h antes de expirar). */
export const MIN_ENTRE_RENOVACOES_MS = 30_000;

/**
 * Controle da ponte de UM iframe montado (defesa em profundidade). O nonce nasce com a montagem, ANTES do iframe, e vai só no
 * fragmento do `src` congelado: um documento para onde o iframe navegue não o tem.
 * - `brain:pronto` só é aceito com esse nonce e uma única vez por montagem; só então o token vai (`brain:init`);
 * - `brain:renovar` só é atendido com o mesmo nonce, depois do pronto, com a ponte viva, um pedido por vez e a pelo menos
 *   `MIN_ENTRE_RENOVACOES_MS` da última emissão: o SB nunca empurra token sem pedido;
 * - o primeiro `load` é o da aba; um segundo `load` significa que o iframe navegou para outro documento (link externo, form,
 *   `location = ...`), e a partir daí nada mais é enviado (nem renovação de token). O SB então remonta ou mostra erro.
 */
export function criarControlePonte(gerarNonce: () => string = nonceAleatorio) {
  const nonce = gerarNonce();
  let cargas = 0; let prontoAceito = false; let cortada = false;
  let emAndamento = false; let ultimaEmissao = -Infinity;
  return {
    nonce,
    /** Evento `load` do iframe: `false` quando é uma navegação para outro documento (a credencial foi cortada). */
    aoCarregar(): boolean { cargas++; if (cargas > 1) cortada = true; return !cortada; },
    /** `brain:pronto` com o nonce: `true` só na primeira vez, com o nonce certo e a ponte não cortada (então envie `brain:init`). */
    aoPronto(n: string): boolean { if (cortada || prontoAceito || n !== nonce) return false; prontoAceito = true; return true; },
    /** `brain:renovar`: `true` só com o nonce desta montagem, depois do pronto e a ponte viva (reconfira depois de qualquer espera). */
    aoRenovar(n: string): boolean { return !cortada && prontoAceito && n === nonce; },
    /** Início de uma renovação: além de `aoRenovar`, um pedido por vez e a `MIN_ENTRE_RENOVACOES_MS` da última emissão. */
    iniciarRenovacao(n: string, agora: number = Date.now()): boolean {
      if (!this.aoRenovar(n) || emAndamento || agora - ultimaEmissao < MIN_ENTRE_RENOVACOES_MS) return false;
      emAndamento = true; return true;
    },
    /** Fim da renovação iniciada; `emitiu` marca o instante da emissão. */
    concluirRenovacao(emitiu: boolean, agora: number = Date.now()): void { emAndamento = false; if (emitiu) ultimaEmissao = agora; },
    /** Ainda pode mandar mensagens (token, tema) para o iframe. */
    podeEnviar(): boolean { return !cortada; },
  };
}
