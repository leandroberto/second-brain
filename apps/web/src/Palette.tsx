import { useEffect, useMemo, useRef, useState } from "react";
import { Search as SearchIcon } from "lucide-react";
import { api, type SearchHit } from "./api";
import { go, TypeBadge, useDebounced } from "./lib";

export interface Cmd { id: string; label: string; hint?: string; run: () => void }

/** Paleta estilo Spotlight: comandos + busca de conhecimento ao vivo. Toda a lógica de busca vem da API. */
export function Palette({ commands, onClose }: { commands: Cmd[]; onClose: () => void }) {
  const [q, setQ] = useState(""); const [sel, setSel] = useState(0); const [hits, setHits] = useState<SearchHit[]>([]);
  const dq = useDebounced(q, 120); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (dq.trim().length < 2) { setHits([]); return; } let live = true; api<SearchHit[]>(`/api/search?q=${encodeURIComponent(dq)}&limit=6`).then((h) => live && setHits(h)).catch(() => undefined); return () => { live = false; }; }, [dq]);
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const cmds = useMemo(() => commands.filter((c) => !q.trim() || norm(c.label).includes(norm(q.trim()))), [commands, q]);
  const items: Array<{ key: string; node: React.ReactNode; run: () => void; sec?: string }> = [
    ...cmds.map((c) => ({ key: c.id, sec: "Comandos", run: c.run, node: <><span style={{ flex: 1 }}>{c.label}</span>{c.hint && <span className="kbd">{c.hint}</span>}</> })),
    ...hits.map((h) => ({ key: h.id, sec: "Conhecimento", run: () => go(`note/${h.id}`), node: <><TypeBadge type={h.type} /><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.title}</span>{h.project && <span className="muted small">{h.project}</span>}</> })),
  ];
  if (q.trim()) items.push({ key: "__search", sec: "Buscar", run: () => go(`search?q=${encodeURIComponent(q)}`), node: <><SearchIcon size={14} /><span style={{ flex: 1 }}>Buscar “{q}” com filtros</span></> });
  useEffect(() => { setSel(0); }, [q, hits.length]);
  useEffect(() => { ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [sel]);
  const exec = (i: number) => { const it = items[i]; if (it) { onClose(); it.run(); } };
  let last = "";
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label="Paleta de comandos">
      <div className="modal">
        <input className="pal-in" autoFocus placeholder="Buscar conhecimento ou digitar um comando…" value={q} onChange={(e) => setQ(e.target.value)} role="combobox" aria-expanded="true" aria-controls="pal-list"
          onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); } else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); } else if (e.key === "Enter") exec(sel); else if (e.key === "Escape") onClose(); }} />
        <div className="pal-list" id="pal-list" role="listbox" ref={ref}>
          {items.map((it, i) => { const sec = it.sec !== last ? it.sec : undefined; last = it.sec ?? ""; return <div key={it.key}>{sec && <div className="pal-sec">{sec}</div>}<button role="option" aria-selected={i === sel} className="pal-item" onMouseMove={() => setSel(i)} onClick={() => exec(i)}>{it.node}</button></div>; })}
          {!items.length && <div className="empty">Nada encontrado</div>}
        </div>
        <div className="pal-foot"><span><span className="kbd">↑↓</span> navegar</span><span><span className="kbd">↵</span> abrir</span><span><span className="kbd">esc</span> fechar</span></div>
      </div>
    </div>
  );
}
