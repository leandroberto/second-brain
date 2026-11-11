import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BookOpen, Bot, CalendarDays, ChartBar, CircleCheck, Clock, Cloud, Database, FileText, Folder, Globe, Heart, Lightbulb, ListTodo, Mail, MessageSquare, Puzzle, Rocket, Sparkles, Star, StickyNote, Tag, Timer, Users, Wallet, Wrench, Zap, type LucideIcon } from "lucide-react";
import { api } from "./api";
import { errMsg, go } from "./lib";
import { idModuloValido, mensagemInit, mensagemTema, mensagemToken, parseMensagemDoModulo, restoValido, deveRemontar, type Tema } from "./moduleBridge";

/** Ícones aceitos para `icone` do módulo (nome em kebab-case do lucide). Qualquer outro vira `Puzzle`. */
const ICONES: Record<string, LucideIcon> = {
  bell: Bell, "book-open": BookOpen, bot: Bot, "calendar-days": CalendarDays, "chart-bar": ChartBar, "circle-check": CircleCheck, clock: Clock, cloud: Cloud,
  database: Database, "file-text": FileText, folder: Folder, globe: Globe, heart: Heart, lightbulb: Lightbulb, "list-todo": ListTodo, mail: Mail,
  "message-square": MessageSquare, puzzle: Puzzle, rocket: Rocket, sparkles: Sparkles, star: Star, "sticky-note": StickyNote, tag: Tag, timer: Timer,
  users: Users, wallet: Wallet, wrench: Wrench, zap: Zap,
};
export function iconeDoModulo(nome?: string): LucideIcon {
  const k = (nome ?? "").trim().replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return Object.prototype.hasOwnProperty.call(ICONES, k) ? ICONES[k]! : Puzzle;
}

const temaAtual = (): Tema => (document.documentElement.dataset.theme === "light" ? "claro" : "escuro");
const ANTECEDENCIA_MS = 3600_000; // renova 1 h antes de expirar

/** Aba de um módulo: iframe sandbox de origem opaca + ponte postMessage. O token de página fica só em memória. */
export function ModuleFrame({ id, resto, onBadge }: { id: string; resto: string; onBadge?: (id: string, n: number) => void }) {
  if (!idModuloValido(id)) return <div className="wrap"><h1>Módulo não encontrado</h1></div>;
  return <ModuleFrameValido id={id} resto={restoValido(resto) ? resto : ""} onBadge={onBadge} />;
}

function ModuleFrameValido({ id, resto, onBadge }: { id: string; resto: string; onBadge?: (id: string, n: number) => void }) {
  const ultimo = useRef(resto); // último resto conhecido do iframe (inicial ou enviado por brain:navegar)
  const [geracao, setGeracao] = useState(0);
  useEffect(() => { if (deveRemontar(resto, ultimo.current)) { ultimo.current = resto; setGeracao((g) => g + 1); } }, [resto]);
  return <Frame key={`${id}#${geracao}`} id={id} resto={resto} onBadge={onBadge} onNavegou={(r) => { ultimo.current = r; }} />;
}

function Frame({ id, resto, onBadge, onNavegou }: { id: string; resto: string; onBadge?: (id: string, n: number) => void; onNavegou: (resto: string) => void }) {
  const [src] = useState(() => `/modules/${id}/index.html#${resto}`); // congelado no mount: navegar não recarrega o iframe
  const iframe = useRef<HTMLIFrameElement>(null);
  const restoRef = useRef(resto); // resto inicial: `navegar` não recarrega o iframe
  const tokenRef = useRef<{ token: string; expira: number } | undefined>(undefined);
  const onBadgeRef = useRef(onBadge); onBadgeRef.current = onBadge;
  const onNavegouRef = useRef(onNavegou); onNavegouRef.current = onNavegou;
  const [pronto, setPronto] = useState(false);
  const [erro, setErro] = useState<string>();
  const [expiraEm, setExpiraEm] = useState<number>();
  const apiBase = `/api/modules/${id}`;

  const enviar = useCallback((msg: unknown) => { iframe.current?.contentWindow?.postMessage(msg, "*"); }, []); // origem opaca: só "*"

  const obterToken = useCallback(async (): Promise<boolean> => {
    try {
      const r = await api<{ token: string; expira: string }>(`/api/modules/${id}/ui-token`, { method: "POST" });
      const expira = Date.parse(r.expira);
      const exp = Number.isFinite(expira) ? expira : Date.now() + 12 * ANTECEDENCIA_MS;
      tokenRef.current = { token: r.token, expira: exp }; setExpiraEm(exp);
      setErro(undefined);
      return true;
    } catch (e) { setErro(errMsg(e)); return false; }
  }, [id]);

  const renovar = useCallback(async () => {
    if (await obterToken()) { setPronto(true); if (tokenRef.current) enviar(mensagemToken(tokenRef.current.token)); }
  }, [obterToken, enviar]);

  useEffect(() => { void renovar(); }, [renovar]);

  // Renovação 1 h antes de expirar (reagenda a cada token novo) e ao voltar o foco se já expirou.
  useEffect(() => {
    if (!expiraEm) return;
    const t = setTimeout(() => { void renovar(); }, Math.max(30_000, expiraEm - ANTECEDENCIA_MS - Date.now()));
    return () => clearTimeout(t);
  }, [expiraEm, renovar]);
  useEffect(() => {
    const f = () => { if (document.visibilityState !== "hidden" && tokenRef.current && Date.now() >= tokenRef.current.expira) void renovar(); };
    addEventListener("focus", f); document.addEventListener("visibilitychange", f);
    return () => { removeEventListener("focus", f); document.removeEventListener("visibilitychange", f); };
  }, [renovar]);

  // Mensagens do iframe.
  useEffect(() => {
    const h = (ev: MessageEvent) => {
      const m = parseMensagemDoModulo(ev, iframe.current?.contentWindow);
      if (!m) return;
      if (m.type === "brain:pronto") { if (tokenRef.current) enviar(mensagemInit(tokenRef.current.token, temaAtual(), restoRef.current, apiBase)); }
      else if (m.type === "brain:navegar") { restoRef.current = m.resto; onNavegouRef.current(m.resto); history.replaceState(null, "", `#/m/${id}${m.resto ? "/" + m.resto.split("/").map(encodeURIComponent).join("/") : ""}`); }
      else if (m.type === "brain:abrirNota") go(`note/${encodeURIComponent(m.id)}`);
      else onBadgeRef.current?.(id, m.n);
    };
    addEventListener("message", h); return () => removeEventListener("message", h);
  }, [id, apiBase, enviar]);

  // Tema: o mecanismo da UI é `data-theme` no <html>.
  useEffect(() => {
    const o = new MutationObserver(() => enviar(mensagemTema(temaAtual())));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => o.disconnect();
  }, [enviar]);

  return (
    <div className="modframe">
      {erro && <div className="banner danger" role="alert"><span>Não foi possível obter o acesso da aba do módulo: {erro}</span><button className="btn sm" onClick={() => void renovar()}>Tentar de novo</button></div>}
      {pronto && <iframe ref={iframe} title={`Módulo ${id}`} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" src={src} />}
    </div>
  );
}
