import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BrainError, type Principal } from "@brain/shared";
import { isPrincipal } from "./authz.js";

/**
 * Sessões HUMANAS da UI (quem pode revisar). O `.brain/api-token` do vault continua existindo, mas agora identifica um AGENTE
 * local (lê e propõe): qualquer processo do usuário consegue ler o vault, então aquele arquivo não prova que há um humano.
 *
 * Uma sessão humana só é emitida por `brain serve`/`brain ui` num TERMINAL INTERATIVO (e, se o revisor definiu uma frase-senha,
 * depois de digitá-la). Fica guardada FORA do vault, só como hash (sha256), com validade; o token em claro só existe na URL
 * mostrada ao humano e no localStorage do navegador.
 */
export interface SessionStoreOptions { file?: string }
interface Entry { hash: string; created_at: string; expires_at: string; label: string }
type Store = Record<string, Entry[]> & { __reviewer?: never };
interface Reviewer { passphrase?: { salt: string; hash: string; set_at: string } }

const configDir = () => join(homedir(), ".config", "second-brain");
export const defaultSessionsFile = () => process.env.BRAIN_SESSIONS_FILE ?? join(configDir(), "ui-sessions.json");
const reviewerFile = (sessionsFile: string) => join(dirname(sessionsFile), "reviewer.json");
const keyOf = (vault: string) => { try { return realpathSync(vault); } catch { return resolve(vault); } };
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

function load<T>(f: string, empty: T): T { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return empty; } }
function save(f: string, data: unknown) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(data, null, 2), { mode: 0o600 }); try { chmodSync(f, 0o600); } catch { /* fs sem chmod */ } }

/** Emite uma sessão humana da UI. Só para quem JÁ provou ser o revisor num terminal (`humanFromTerminal`): sem isso, negado. */
export function issueHumanSession(vault: string, proof: Principal, o: SessionStoreOptions & { label?: string; ttlDays?: number } = {}): string {
  if (!isPrincipal(proof) || proof.kind !== "human" || proof.channel !== "cli-admin") throw new BrainError("forbidden", "sessão humana só é emitida para o revisor autenticado num terminal interativo (brain ui / brain serve)");
  const f = o.file ?? defaultSessionsFile(); const st = load<Store>(f, {} as Store); const k = keyOf(vault);
  const token = `hs_${randomBytes(32).toString("hex")}`; const now = Date.now();
  const live = (st[k] ?? []).filter((e) => Date.parse(e.expires_at) > now).slice(-9); // no máximo 10 sessões vivas por vault
  live.push({ hash: sha(token), created_at: new Date(now).toISOString(), expires_at: new Date(now + (o.ttlDays ?? 30) * 864e5).toISOString(), label: (o.label ?? "ui").slice(0, 60) });
  st[k] = live; save(f, st);
  return token;
}

export function isHumanSession(vault: string, token: string, o: SessionStoreOptions = {}): boolean {
  if (!token.startsWith("hs_") || token.length !== 67) return false;
  const st = load<Store>(o.file ?? defaultSessionsFile(), {} as Store); const h = Buffer.from(sha(token)); const now = Date.now();
  return (st[keyOf(vault)] ?? []).some((e) => Date.parse(e.expires_at) > now && e.hash.length === h.length && timingSafeEqual(Buffer.from(e.hash), h));
}

export function revokeHumanSessions(vault: string, proof: Principal, o: SessionStoreOptions = {}): number {
  if (!isPrincipal(proof) || proof.kind !== "human") throw new BrainError("forbidden", "revogar sessões exige o revisor humano");
  const f = o.file ?? defaultSessionsFile(); const st = load<Store>(f, {} as Store); const k = keyOf(vault);
  const n = st[k]?.length ?? 0; delete st[k]; if (existsSync(f)) save(f, st); return n;
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
