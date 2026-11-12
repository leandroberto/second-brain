import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BookOpen, Bot, CalendarDays, ChartBar, CircleCheck, Clock, Cloud, Database, FileText, Folder, Globe, Heart, Lightbulb, ListTodo, Mail, MessageSquare, Puzzle, Rocket, Sparkles, Star, StickyNote, Tag, Timer, Users, Wallet, Wrench, Zap, type LucideIcon } from "lucide-react";
import { api } from "./api";
import { errMsg, go } from "./lib";
import { idModuloValido, mensagemInit, mensagemTema, mensagemToken, parseMensagemDoModulo, restoDoHash, restoValido, criarControlePonte, criarControleRemontagem, type Tema } from "./moduleBridge";

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

/** Aba de um módulo: iframe sandbox de origem opaca + ponte postMessage. O token de página fica só em memória. */
export function ModuleFrame({ id, resto, onBadge }: { id: string; resto: string; onBadge?: (id: string, n: number) => void }) {
  if (!idModuloValido(id)) return <div className="wrap"><h1>Módulo não encontrado</h1></div>;
  return <ModuleFrameValido key={id} id={id} resto={restoValido(resto) ? resto : ""} onBadge={onBadge} />;
}

function ModuleFrameValido({ id, resto, onBadge }: { id: string; resto: string; onBadge?: (id: string, n: number) => void }) {
  const ctrl = useRef(criarControleRemontagem(resto));
  const [geracao, setGeracao] = useState(0);
  // `replaceState` do `brain:navegar` não dispara hashchange; qualquer hashchange é mudança externa.
  useEffect(() => {
    const f = () => {
      const r = restoDoHash(location.hash, id);
      if (r === undefined) return; // rota fora de `#/m/<id>`: o módulo vai ser desmontado, não remonta
      if (ctrl.current.aoMudarHash(r)) setGeracao((g) => g + 1);
    };
    addEventListener("hashchange", f); return () => removeEventListener("hashchange", f);
  }, [id]);
  return <Frame key={geracao} id={id} resto={ctrl.current.ultimo()} onBadge={onBadge} onNavegou={(r) => ctrl.current.aoNavegar(r)} onRemontar={() => setGeracao((g) => g + 1)} />;
}

function Frame({ id, resto, onBadge, onNavegou, onRemontar }: { id: string; resto: string; onBadge?: (id: string, n: number) => void; onNavegou: (resto: string) => void; onRemontar: () => void }) {
  const [src] = useState(() => `/modules/${id}/index.html#${resto}`); // congelado no mount: navegar não recarrega o iframe
  const iframe = useRef<HTMLIFrameElement>(null);
  const restoRef = useRef(resto); // resto inicial: `navegar` não recarrega o iframe
  const tokenRef = useRef<{ token: string; expira: string } | undefined>(undefined); // só o token inicial, até o `brain:init`
  const onBadgeRef = useRef(onBadge); onBadgeRef.current = onBadge;
  const onNavegouRef = useRef(onNavegou); onNavegouRef.current = onNavegou;
  const ponte = useRef(criarControlePonte()); // um por montagem do iframe (cada remontagem cria outro Frame)
  const [pronto, setPronto] = useState(false);
  const [saiu, setSaiu] = useState(false); // o iframe navegou para outro documento: credencial cortada
  const [erro, setErro] = useState<string>();
  const apiBase = `/api/modules/${id}`;

  // origem opaca: só "*". Por isso nada sai depois que o iframe navegou para outro documento (`ponte`)
  const enviar = useCallback((msg: unknown) => { if (ponte.current.podeEnviar()) iframe.current?.contentWindow?.postMessage(msg, "*"); }, []);

  const buscarToken = useCallback(async (): Promise<{ token: string; expira: string } | undefined> => {
    try { const r = await api<{ token: string; expira: string }>(`/api/modules/${id}/ui-token`, { method: "POST" }); setErro(undefined); return r; }
    catch (e) { setErro(errMsg(e)); return undefined; }
  }, [id]);

  // Token inicial: buscado antes de montar o iframe. Depois disso o SB só emite outro em resposta a `brain:renovar` com nonce.
  const iniciar = useCallback(async () => {
    const r = await buscarToken();
    if (r) { tokenRef.current = r; setPronto(true); }
  }, [buscarToken]);
  useEffect(() => { void iniciar(); }, [iniciar]);

  // Renovação por pedido (pull): vale só com o nonce desta montagem; a ponte é reconferida depois da espera pela rede.
  const renovar = useCallback(async (nonce: string) => {
    const r = await buscarToken();
    if (r && ponte.current.aoRenovar(nonce)) enviar(mensagemToken(r.token, r.expira));
  }, [buscarToken, enviar]);

  // Mensagens do iframe.
  useEffect(() => {
    const h = (ev: MessageEvent) => {
      const m = parseMensagemDoModulo(ev, iframe.current?.contentWindow);
      if (!m) return;
      if (m.type === "brain:pronto") {
        const t = tokenRef.current;
        const nonce = t ? ponte.current.aoPronto() : undefined;
        if (t && nonce) { enviar(mensagemInit(t.token, t.expira, nonce, temaAtual(), restoRef.current, apiBase)); tokenRef.current = undefined; }
      }
      else if (m.type === "brain:renovar") { if (ponte.current.aoRenovar(m.nonce)) void renovar(m.nonce); }
      else if (m.type === "brain:navegar") { restoRef.current = m.resto; onNavegouRef.current(m.resto); history.replaceState(null, "", `#/m/${id}${m.resto ? "/" + m.resto.split("/").map(encodeURIComponent).join("/") : ""}`); }
      else if (m.type === "brain:abrirNota") go(`note/${encodeURIComponent(m.id)}`);
      else onBadgeRef.current?.(id, m.n);
    };
    addEventListener("message", h); return () => removeEventListener("message", h);
  }, [id, apiBase, enviar, renovar]);

  // Tema: o mecanismo da UI é `data-theme` no <html>.
  useEffect(() => {
    const o = new MutationObserver(() => enviar(mensagemTema(temaAtual())));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => o.disconnect();
  }, [enviar]);

  return (
    <div className="modframe">
      {erro && <div className="banner danger" role="alert"><span>Não foi possível obter o acesso da aba do módulo: {erro}</span>{!pronto && <button className="btn sm" onClick={() => void iniciar()}>Tentar de novo</button>}</div>}
      {saiu && <div className="banner danger" role="alert"><span>A aba do módulo saiu da própria página (link externo ou outro documento) e o acesso dela foi cortado.</span><button className="btn sm" onClick={onRemontar}>Recarregar a aba</button></div>}
      {pronto && !saiu && <iframe ref={iframe} title={`Módulo ${id}`} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" src={src}
        onLoad={() => { if (!ponte.current.aoCarregar()) { tokenRef.current = undefined; setSaiu(true); } }} />}
    </div>
  );
}
