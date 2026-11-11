import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BrainError, type Principal } from "@brain/shared";
import { isHumanReviewer, isPrincipal } from "./authz.js";

/**
 * Sessões HUMANAS da UI (quem pode revisar). O `.brain/api-token` do vault continua existindo, mas agora identifica um AGENTE
 * local (lê e propõe): qualquer processo do usuário consegue ler o vault, então aquele arquivo não prova que há um humano.
 *
 * Uma sessão humana só é emitida por `brain serve`/`brain ui` num TERMINAL INTERATIVO (e, se o revisor definiu uma frase-senha,
 * depois de digitá-la). Fica guardada FORA do vault, só como hash (sha256), com validade; o token em claro só existe na URL
 * mostrada ao humano e no localStorage do navegador.
 */
export interface SessionStoreOptions { file?: string }
/**
 * Escopo da sessão: `full` é a sessão de revisão da UI; `desktop` é a credencial de longa duração do atalho desktop, que só
 * anota, pergunta, reprocessa e desfaz as próprias capturas (canal `desktop`, fora de `HUMAN_CHANNELS`).
 */
export type SessionScope = "full" | "desktop";
const SCOPES: readonly SessionScope[] = ["full", "desktop"];
/** `scope` ausente = entrada gravada antes do campo existir = `full`. */
interface Entry { hash: string; created_at: string; expires_at: string; label: string; scope?: SessionScope }
type Store = Record<string, Entry[]> & { __reviewer?: never };
interface Reviewer { passphrase?: { salt: string; hash: string; set_at: string } }

const configDir = () => join(homedir(), ".config", "second-brain");
export const defaultSessionsFile = () => process.env.BRAIN_SESSIONS_FILE ?? join(configDir(), "ui-sessions.json");
const reviewerFile = (sessionsFile: string) => join(dirname(sessionsFile), "reviewer.json");
const keyOf = (vault: string) => { try { return realpathSync(vault); } catch { return resolve(vault); } };
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

function load<T>(f: string, empty: T): T { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return empty; } }
function save(f: string, data: unknown) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(data, null, 2), { mode: 0o600 }); try { chmodSync(f, 0o600); } catch { /* fs sem chmod */ } }

/**
 * Emite uma sessão humana da UI. Só para quem JÁ provou ser o revisor num terminal (`humanFromTerminal`): sem isso, negado.
 * `ttlMinutes`, se vier, prevalece sobre `ttlDays` (sessão curta do `brain modules run`).
 */
export function issueHumanSession(vault: string, proof: Principal, o: SessionStoreOptions & { label?: string; ttlDays?: number; ttlMinutes?: number; scope?: SessionScope } = {}): string {
  if (!isPrincipal(proof) || proof.kind !== "human" || proof.channel !== "cli-admin") throw new BrainError("forbidden", "sessão humana só é emitida para o revisor autenticado num terminal interativo (brain ui / brain serve)");
  const scope = o.scope ?? "full";
  if (!SCOPES.includes(scope)) throw new BrainError("invalid", `escopo de sessão inválido: ${String(scope)}`);
  const f = o.file ?? defaultSessionsFile(); const st = load<Store>(f, {} as Store); const k = keyOf(vault);
  const token = `hs_${randomBytes(32).toString("hex")}`; const now = Date.now();
  const live = (st[k] ?? []).filter((e) => Date.parse(e.expires_at) > now);
  if (o.ttlMinutes !== undefined && !(Number.isFinite(o.ttlMinutes) && o.ttlMinutes > 0)) throw new BrainError("invalid", "ttlMinutes deve ser maior que zero");
  const ttlMs = o.ttlMinutes !== undefined ? o.ttlMinutes * 60_000 : (o.ttlDays ?? 30) * 864e5;
  st[k] = capped([...live, entry(token, now, ttlMs, o.label ?? (scope === "desktop" ? "desktop" : "ui"), scope)]); save(f, st);
  return token;
}

const MAX_FULL = 10; const MAX_DESKTOP = 2;
const entry = (token: string, now: number, ttlMs: number, label: string, scope: SessionScope): Entry =>
  ({ hash: sha(token), created_at: new Date(now).toISOString(), expires_at: new Date(now + ttlMs).toISOString(), label: label.slice(0, 60), scope });
/**
 * Cotas por vault, separadas: no máximo 10 sessões `full` e 2 `desktop` vivas (as mais antigas de cada escopo saem primeiro).
 * Assim abrir a UI muitas vezes nunca despeja a credencial de longa duração do desktop.
 */
const capped = (list: Entry[]): Entry[] => {
  const desk = list.filter((e) => e.scope === "desktop");
  return [...list.filter((e) => e.scope !== "desktop").slice(-MAX_FULL), ...desk.slice(-MAX_DESKTOP)];
};

/**
 * Renova a credencial do desktop: o token precisa ser uma sessão VIVA de escopo `desktop`. Emite um token novo com o mesmo
 * escopo e validade nova (30 dias) e revoga o antigo. Nada além disso: não aceita sessão `full` nem promove escopo.
 */
export function renewDesktopSession(vault: string, token: string, o: SessionStoreOptions & { ttlDays?: number } = {}): string {
  const deny = () => new BrainError("forbidden", "só uma credencial do desktop viva pode ser renovada; pareie o desktop de novo");
  if (typeof token !== "string" || !token.startsWith("hs_") || token.length !== 67) throw deny();
  const f = o.file ?? defaultSessionsFile(); const st = load<Store>(f, {} as Store); const k = keyOf(vault);
  const h = Buffer.from(sha(token)); const now = Date.now();
  const list = (st[k] ?? []).filter((e) => Date.parse(e.expires_at) > now);
  const cur = list.find((e) => e.hash.length === h.length && timingSafeEqual(Buffer.from(e.hash), h));
  if (!cur || cur.scope !== "desktop") throw deny();
  const next = `hs_${randomBytes(32).toString("hex")}`;
  st[k] = capped([...list.filter((e) => e !== cur), entry(next, now, (o.ttlDays ?? 30) * 864e5, cur.label, "desktop")]);
  save(f, st);
  return next;
}

/**
 * Escopo da sessão viva que corresponde ao token, ou `undefined` se não há (token inválido, expirado ou com escopo
 * desconhecido no armazenamento: nunca vale como sessão).
 */
export function sessionScope(vault: string, token: string, o: SessionStoreOptions = {}): SessionScope | undefined {
  if (typeof token !== "string" || !token.startsWith("hs_") || token.length !== 67) return undefined;
  const st = load<Store>(o.file ?? defaultSessionsFile(), {} as Store); const h = Buffer.from(sha(token)); const now = Date.now();
  const e = (st[keyOf(vault)] ?? []).find((e) => Date.parse(e.expires_at) > now && e.hash.length === h.length && timingSafeEqual(Buffer.from(e.hash), h));
  if (!e) return undefined;
  const scope = e.scope ?? "full";
  return SCOPES.includes(scope) ? scope : undefined;
}

/** Há uma sessão humana viva para o token (de qualquer escopo; o canal resultante é decidido em `humanFromSession`). */
export function isHumanSession(vault: string, token: string, o: SessionStoreOptions = {}): boolean {
  return sessionScope(vault, token, o) !== undefined;
}

export function revokeHumanSessions(vault: string, proof: Principal, o: SessionStoreOptions = {}): number {
  // a credencial restrita do desktop (canal "desktop") não revoga as sessões do revisor
  if (!isPrincipal(proof) || !isHumanReviewer(proof)) throw new BrainError("forbidden", "revogar sessões exige o revisor humano");
  const f = o.file ?? defaultSessionsFile(); const st = load<Store>(f, {} as Store); const k = keyOf(vault);
  const n = st[k]?.length ?? 0; delete st[k]; if (existsSync(f)) save(f, st); return n;
}

/**
 * Revoga só a sessão deste token (a sessão curta do `brain modules run`, no `finally`). As demais continuam válidas. Token
 * desconhecido ou já expirado: nada a fazer, não lança. Não exige prova de humano: quem tem o token já pode usá-lo.
 */
export function revokeHumanSession(vault: string, token: string, o: SessionStoreOptions = {}): void {
  if (typeof token !== "string" || !token) return;
  const f = o.file ?? defaultSessionsFile(); if (!existsSync(f)) return;
  const st = load<Store>(f, {} as Store); const k = keyOf(vault); const h = sha(token);
  const list = st[k] ?? []; const rest = list.filter((e) => e.hash !== h);
  if (rest.length === list.length) return;
  st[k] = rest; save(f, st);
}

// ---- frase-senha opcional do revisor (eleva a barreira: um agente não a conhece) ----
export function hasReviewerPassphrase(o: SessionStoreOptions = {}): boolean { return !!load<Reviewer>(reviewerFile(o.file ?? defaultSessionsFile()), {}).passphrase; }
export function setReviewerPassphrase(pass: string, proof: Principal, o: SessionStoreOptions = {}): void {
  if (!isPrincipal(proof) || proof.kind !== "human" || proof.channel !== "cli-admin") throw new BrainError("forbidden", "definir a frase-senha exige o revisor num terminal");
  if (pass.length < 8) throw new Error("frase-senha: mínimo 8 caracteres");
  const salt = randomBytes(16).toString("hex");
  save(reviewerFile(o.file ?? defaultSessionsFile()), { passphrase: { salt, hash: scryptSync(pass, salt, 32).toString("hex"), set_at: new Date().toISOString() } } satisfies Reviewer);
}
export function checkReviewerPassphrase(pass: string, o: SessionStoreOptions = {}): boolean {
  const r = load<Reviewer>(reviewerFile(o.file ?? defaultSessionsFile()), {}); if (!r.passphrase) return true;
  const got = scryptSync(pass, r.passphrase.salt, 32); const want = Buffer.from(r.passphrase.hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}
