// Ponte postMessage entre o Second Brain e a aba de um módulo (iframe de origem opaca).
// Funções puras: sem React, sem DOM.

export type MsgModulo =
  | { type: "brain:pronto" }
  | { type: "brain:navegar"; resto: string }
  | { type: "brain:abrirNota"; id: string }
  | { type: "brain:badge"; n: number };

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
    case "brain:badge": return typeof m.n === "number" && Number.isInteger(m.n) && m.n >= 0 ? { type: "brain:badge", n: m.n } : undefined;
    default: return undefined;
  }
}

export const mensagemInit = (token: string, tema: Tema, resto: string, apiBase: string) => ({ type: "brain:init" as const, token, apiBase, tema, resto });
export const mensagemToken = (token: string) => ({ type: "brain:token" as const, token });
export const mensagemTema = (tema: Tema) => ({ type: "brain:tema" as const, tema });

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
