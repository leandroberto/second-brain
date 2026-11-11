import { useState } from "react";
import { api, type RecentWrite } from "./api";
import { Empty, ErrorBox, Skeleton, errMsg, href, timeAgo, useData, useToast } from "./lib";

const RES_TXT: Record<RecentWrite["resolution"], string> = { create: "nota nova", complement: "complemento" };

/** Mensagem clara para as falhas esperadas do desfazer (conflito e captura em processamento). */
export function undoMessage(e: unknown): string {
  const status = (e as { status?: number }).status;
  if (status === 409) return `Não foi possível desfazer: a nota foi alterada depois. ${errMsg(e)}`;
  if ((e as { code?: string }).code === "git_error") return "Não foi possível desfazer: a nota mudou depois; use a revisão/histórico.";
  if (status === 503) return "A captura ainda está em processamento. Tente de novo em instantes.";
  return errMsg(e);
}

/** Lista as gravações automáticas dos agentes com Desfazer/Arquivar. Sem fila bloqueante: tudo já entrou, o humano só confere. */
function useRecentWrites(days: number, limit: number) {
  const { data, error, loading, reload } = useData<RecentWrite[]>(`/api/recent-writes?days=${days}&limit=${limit}`, [], 30000);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string>();
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const toast = useToast();
  const key = (w: RecentWrite) => `${w.commit}:${w.note_id}`;
  const act = async (w: RecentWrite, name: "undo" | "archive") => {
    setBusy(key(w)); setRowErr(({ [key(w)]: _, ...rest }) => rest);
    try {
      if (name === "undo") {
        if (w.capture_id) await api(`/api/assistant/captures/${encodeURIComponent(w.capture_id)}/undo`, { method: "POST" });
        else await api("/api/git/revert", { method: "POST", body: { rev: w.commit } });
        toast(`Desfeito: ${w.title}`);
      } else {
        const d = await api<{ note: { revision: string } }>(`/api/notes/${encodeURIComponent(w.note_id)}`);
        await api(`/api/notes/${encodeURIComponent(w.note_id)}/status`, { method: "POST", body: { status: "archived", expected_revision: d.note.revision } });
        toast(`Arquivado: ${w.title}`);
      }
      setGone((g) => new Set(g).add(key(w)));
      reload();
    } catch (e) {
      const msg = name === "undo" ? undoMessage(e) : errMsg(e);
      setRowErr((r) => ({ ...r, [key(w)]: msg })); toast(msg, true);
    } finally { setBusy(undefined); }
  };
  const items = (data ?? []).filter((w) => !gone.has(key(w)));
  return { items, error, loading, busy, rowErr, act, key };
}

function Item({ w, busy, err, act }: { w: RecentWrite; busy: boolean; err?: string; act: (n: "undo" | "archive") => void }) {
  const noCommit = !w.capture_id && !w.commit; // sem commit nem captura não há o que reverter
  return (
    <div className="row" data-testid="recent-write" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
      <div className="grow">
        <a className="title" href={href(`note/${w.note_id}`)} style={{ display: "block" }}>{w.title}</a>
        <div className="meta"><span className="badge info">{RES_TXT[w.resolution]}</span><span>{w.agent}</span><span title={w.date}>{timeAgo(w.date)}</span></div>
        {err && <div className="small" role="alert" style={{ color: "var(--danger)", marginTop: 4 }}>{err}</div>}
      </div>
      <div className="actions" style={{ margin: 0 }}>
        <button className="btn sm" disabled={busy || noCommit} title={noCommit ? "sem commit (auto_commit desligado)" : undefined} onClick={() => act("undo")} aria-label={`Desfazer: ${w.title}`}>Desfazer</button>
        <button className="btn sm ghost" disabled={busy} onClick={() => act("archive")} aria-label={`Arquivar: ${w.title}`}>Arquivar</button>
      </div>
    </div>
  );
}

export function RecentWritesCard({ limit = 5 }: { limit?: number }) {
  const r = useRecentWrites(7, limit);
  return (
    <section className="card flush" aria-label="Entrou recentemente">
      <div className="card-h" style={{ padding: "14px 18px 0" }}><h2>Entrou recentemente</h2><a className="btn sm ghost" href={href("recent")}>Ver tudo</a></div>
      {r.error && <ErrorBox error={r.error} />}
      {r.items.length ? r.items.slice(0, limit).map((w) => <Item key={r.key(w)} w={w} busy={r.busy === r.key(w)} err={r.rowErr[r.key(w)]} act={(n) => r.act(w, n)} />)
        : <Empty title="Nada entrou nos últimos 7 dias" hint="Notas que os agentes gravam direto aparecem aqui para você conferir." />}
    </section>
  );
}

export function RecentWritesPage() {
  const [days, setDays] = useState(7);
  const r = useRecentWrites(days, 100);
  return (
    <div className="wrap"><h1>Entrou recentemente</h1>
      <p className="sub">O que os agentes gravaram direto no vault. Confira e desfaça ou arquive com um clique; nada fica esperando aprovação.</p>
      <div className="field" style={{ maxWidth: 220 }}><label htmlFor="rw-days">Período</label>
        <select id="rw-days" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={1}>Último dia</option><option value={7}>Últimos 7 dias</option><option value={30}>Últimos 30 dias</option></select></div>
      <ErrorBox error={r.error} />
      <section className="card flush" aria-label="Gravações recentes">
        {r.loading && !r.items.length ? <Skeleton n={4} /> : r.items.length ? r.items.map((w) => <Item key={r.key(w)} w={w} busy={r.busy === r.key(w)} err={r.rowErr[r.key(w)]} act={(n) => r.act(w, n)} />)
          : <Empty title="Nada entrou neste período" hint="Notas que os agentes gravam direto aparecem aqui." />}
      </section>
    </div>
  );
}
