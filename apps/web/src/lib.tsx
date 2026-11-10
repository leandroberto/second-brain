import { useCallback, useEffect, useMemo, useRef, useState, createContext, useContext, type ReactNode } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api, subscribe, ApiError } from "./api";

// ---------- router (hash) ----------
export function useRoute() {
  const [h, setH] = useState(location.hash);
  useEffect(() => { const f = () => setH(location.hash); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  const raw = h.replace(/^#\/?/, "");
  const [pathPart = "", query = ""] = raw.split("?");
  return { path: pathPart.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(query) };
}
export const go = (to: string) => { location.hash = to.startsWith("#") ? to : `#/${to.replace(/^\//, "")}`; };
export const href = (to: string) => `#/${to.replace(/^\//, "")}`;

// ---------- toasts ----------
type Toast = { id: number; msg: string; err?: boolean };
const ToastCtx = createContext<(msg: string, err?: boolean) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((msg: string, err?: boolean) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, msg, err }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), err ? 7000 : 3500);
  }, []);
  return <ToastCtx.Provider value={push}>{children}<div className="toasts" role="status" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.err ? "err" : ""}`}>{t.msg}</div>)}</div></ToastCtx.Provider>;
}
export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

// ---------- data ----------
export function useData<T>(path: string | null, deps: unknown[] = [], pollMs = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => subscribe(() => reload()), [reload]);
  useEffect(() => { if (!pollMs) return; const i = setInterval(reload, pollMs); return () => clearInterval(i); }, [pollMs, reload]);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    let live = true;
    api<T>(path).then((d) => { if (live) { setData(d); setError(undefined); setLoading(false); } })
      .catch((e) => { if (live) { setError(errMsg(e)); setLoading(false); } });
    return () => { live = false; };
  }, [path, tick, ...deps]);
  return { data, error, loading, reload };
}

// ---------- format ----------
export function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return "agora";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d`;
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}
export const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
export const dayLabel = (iso: string) => {
  const d = new Date(iso); const t = new Date();
  if (d.toDateString() === t.toDateString()) return "Hoje";
  const y = new Date(Date.now() - 864e5); if (d.toDateString() === y.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
};
export const TYPE_LABEL: Record<string, string> = { decision: "Decisão", learning: "Aprendizado", fact: "Fato", preference: "Preferência", pattern: "Padrão", reference: "Referência", concept: "Conceito", project: "Projeto", "open-question": "Pergunta aberta" };
export const CLASS_LABEL: Record<string, string> = { new: "Novo", duplicate: "Duplicata", complement: "Complemento", update: "Atualização", replace: "Substituição", conflict: "Conflito" };
export const RES_LABEL: Record<string, string> = { create: "Criar", complement: "Complementar", update: "Atualizar", replace: "Substituir", keep_separate: "Manter separado", ignore: "Ignorar" };

// ---------- primitives ----------
export function TypeBadge({ type }: { type: string }) {
  return <span className="badge type" style={{ ["--c" as string]: `var(--t-${type})` }}><i className="dot" style={{ ["--c" as string]: `var(--t-${type})` }} />{TYPE_LABEL[type] ?? type}</span>;
}
export function StatusBadge({ status }: { status: string }) {
  if (status === "active") return null;
  const cls = status === "superseded" || status === "deprecated" ? "warn" : status === "proposed" ? "info" : "";
  return <span className={`badge ${cls}`}>{status}</span>;
}
export function ClassBadge({ c }: { c: string }) {
  const cls = c === "conflict" ? "danger" : c === "new" ? "ok" : c === "duplicate" ? "" : "warn";
  return <span className={`badge ${cls}`}>{CLASS_LABEL[c] ?? c}</span>;
}
export const Empty = ({ title, hint }: { title: string; hint?: string }) => <div className="empty"><b>{title}</b>{hint}</div>;
export const Skeleton = ({ n = 3 }: { n?: number }) => <>{Array.from({ length: n }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />)}</>;
export function ErrorBox({ error }: { error?: string }) { return error ? <div className="banner danger" role="alert">{error}</div> : null; }

// ---------- markdown ----------
marked.setOptions({ gfm: true, breaks: false });
export function Markdown({ text, known }: { text: string; known?: (id: string) => boolean }) {
  const html = useMemo(() => {
    const withLinks = text.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, id: string, alias?: string) => `[${alias ?? id}](${href(`note/${encodeURIComponent(id.trim())}`)} "wikilink")`);
    const raw = marked.parse(withLinks, { async: false }) as string;
    const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_ATTR: ["target"] });
    return clean.replace(/<a href="#\/note\/([^"]+)" title="wikilink">/g, (_m, id: string) => `<a class="wikilink${known && !known(decodeURIComponent(id)) ? " broken" : ""}" href="#/note/${id}">`);
  }, [text, known]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Realça trechos «assim» devolvidos pelo FTS. */
export function Snippet({ text }: { text: string }) {
  const parts = text.replace(/\s+/g, " ").split(/(«[^»]*»)/g);
  return <>{parts.map((p, i) => (p.startsWith("«") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}</>;
}

// ---------- diff (LCS por linha) ----------
export function lineDiff(a: string, b: string): Array<{ t: "same" | "add" | "del"; s: string }> {
  const x = a.split("\n"); const y = b.split("\n");
  const m = x.length; const n = y.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Array<{ t: "same" | "add" | "del"; s: string }> = []; let i = 0; let j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) { out.push({ t: "same", s: x[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ t: "del", s: x[i++]! });
    else out.push({ t: "add", s: y[j++]! });
  }
  while (i < m) out.push({ t: "del", s: x[i++]! });
  while (j < n) out.push({ t: "add", s: y[j++]! });
  return out;
}
export function Diff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => lineDiff(before.trimEnd(), after.trimEnd()), [before, after]);
  return <div className="diff" role="figure" aria-label="Diferença entre versões">{lines.map((l, i) => <div key={i} className={l.t === "same" ? "" : l.t}>{l.t === "add" ? "+ " : l.t === "del" ? "− " : "  "}{l.s || " "}</div>)}</div>;
}

export function useDebounced<T>(v: T, ms = 180): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}
export function useHotkey(key: string, fn: (e: KeyboardEvent) => void, opts: { ctrl?: boolean } = {}) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? "");
      if (opts.ctrl ? (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === key : !typing && !e.ctrlKey && !e.metaKey && e.key === key) { e.preventDefault(); ref.current(e); }
    };
    addEventListener("keydown", h); return () => removeEventListener("keydown", h);
  }, [key, opts.ctrl]);
}
