import type { Freshness } from "@brain/shared";

/** Rótulos da atualidade (freshness): "esta afirmação ainda representa o estado atual?" — independente da confiança de extração. */
export const FRESH_LABEL: Record<string, string> = { current: "atual", planned: "planejado", historical: "histórico", superseded: "substituído", reverted: "revertido", uncertain: "incerto", conflict: "conflito" };
const FRESH_CLASS: Record<string, string> = { current: "ok", planned: "warn", uncertain: "warn", conflict: "danger", historical: "info", superseded: "info", reverted: "info" };
export const EFFORT_LABEL: Record<string, string> = { auto_clear: "evidência clara", quick: "revisão rápida", investigate: "investigar" };
const KIND_LABEL: Record<string, string> = { adr: "ADR", spec: "Spec", plan: "Plano", docs: "Documentação", readme: "README", agents: "AGENTS/CLAUDE.md", changelog: "Changelog", issue: "Issue", commit: "Commit", code: "Código", test: "Teste", conversation: "Conversa", other: "Outro" };
const INTENT_LABEL: Record<string, string> = { in_force: "em vigor", superseded: "substituída", reverted: "revertida", unknown: "não determinada", "n/a": "—" };
const IMPL_LABEL: Record<string, string> = { confirmed: "confirmada no HEAD", partial: "parcial", absent: "ausente do HEAD", diverges: "diverge (HEAD faz outra coisa)", unknown: "não verificável no código" };
const CONF_LABEL: Record<string, string> = { high: "alta", medium: "média", low: "baixa" };
const date = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("pt-BR") : "");

export function FreshBadge({ f, title }: { f?: Pick<Freshness, "state" | "confidence"> | string; title?: string }) {
  if (!f) return null;
  const state = typeof f === "string" ? f : f.state;
  return <span className={`badge ${FRESH_CLASS[state] ?? ""}`} title={title ?? "Atualidade verificada contra o repositório"}>{FRESH_LABEL[state] ?? state}{typeof f !== "string" && f.confidence !== "high" ? ` · ${CONF_LABEL[f.confidence]}` : ""}</span>;
}

/** O que "Aceitar sugestão" fará — texto do botão; undefined quando a decisão é humana (investigar). */
export function suggestionAction(f: Freshness, classification: string): { label: string; resolution: string; as_historical?: boolean; target?: string; note?: string } | undefined {
  const isNew = classification === "new";
  switch (f.suggestion) {
    case "accept_current": return isNew ? { label: "Aceitar: criar como conhecimento atual", resolution: "create", as_historical: false } : undefined;
    case "confirm": return isNew ? { label: "Confirmar que ainda vale e criar", resolution: "create", as_historical: false } : undefined;
    case "accept_historical": return isNew ? { label: "Aceitar: guardar como histórico", resolution: "create", as_historical: true } : undefined;
    case "complement_current": return f.suggestion_target ? { label: "Aceitar: anexar como histórico à nota atual", resolution: "complement", as_historical: true, target: f.suggestion_target } : undefined;
    case "ignore": return { label: f.state === "planned" ? "Aceitar: ignorar (plano sem implementação)" : "Aceitar: ignorar (documentação desatualizada)", resolution: "ignore", note: `atualidade: ${f.state} — ${f.summary}`.slice(0, 280) };
    default: return undefined;
  }
}
const SUGGESTION_TEXT: Record<string, string> = {
  accept_current: "criar como conhecimento atual", confirm: "não verificável no código e nada contradiz: confirme se ainda vale",
  accept_historical: "guardar como histórico (fica fora do contexto padrão, continua pesquisável)", complement_current: "anexar como histórico à nota atual relacionada",
  ignore: "não registrar como estado atual", investigate: "decisão sua: as evidências são conflitantes ou insuficientes",
};

/** Caixa "Validade" da Review Queue: de onde veio, contra o que foi verificado, evidências rastreáveis, conclusão e sugestão. */
export function ValidityBox({ f, extraction, classification, onAccept, busy }: { f: Freshness; extraction?: string; classification: string; onAccept?: (a: NonNullable<ReturnType<typeof suggestionAction>>) => void; busy?: boolean }) {
  const action = suggestionAction(f, classification);
  const mark = (s: string) => (s === "supports" ? "✓" : s === "contradicts" ? "✗" : "·");
  return (
    <section className="card" aria-label="Validade" style={{ marginTop: 14, padding: "12px 14px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Validade</h2><FreshBadge f={f} /><span className={`badge ${f.effort === "investigate" ? "danger" : f.effort === "auto_clear" ? "ok" : ""}`} title="Esforço de revisão estimado (métrica de UX; nunca aprova sozinho)">{EFFORT_LABEL[f.effort] ?? f.effort}</span>
        <span className="small muted">extração {CONF_LABEL[extraction ?? ""] ?? "—"} · atualidade {CONF_LABEL[f.confidence]}</span>
      </div>
      <dl className="small" style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "2px 10px", margin: "8px 0" }}>
        <dt className="muted">Fonte</dt><dd style={{ margin: 0 }}>{KIND_LABEL[f.source.kind] ?? f.source.kind}{f.source.path && <> · <code>{f.source.path}</code></>}{f.source.date && <> · {date(f.source.date)}</>}{f.source.commit && <> · commit <code>{f.source.commit}</code></>}{!f.source.in_head && f.source.path && <> · <b>fora do HEAD</b></>}</dd>
        {f.against && <><dt className="muted">Verificado contra</dt><dd style={{ margin: 0 }}><code>{f.against.repo}@{f.against.commit}</code>{f.against.date && <> · {date(f.against.date)}</>} · em {date(f.checked_at)}</dd></>}
        <dt className="muted">Intenção (porquê)</dt><dd style={{ margin: 0 }}>{INTENT_LABEL[f.intent] ?? f.intent}</dd>
        <dt className="muted">Implementação (agora)</dt><dd style={{ margin: 0 }}>{IMPL_LABEL[f.implementation] ?? f.implementation}</dd>
        <dt className="muted">Conclusão</dt><dd style={{ margin: 0 }}><b>{f.summary}</b></dd>
        <dt className="muted">Sugestão</dt><dd style={{ margin: 0 }}>{SUGGESTION_TEXT[f.suggestion] ?? f.suggestion}</dd>
      </dl>
      <details open={f.effort === "investigate"}>
        <summary style={{ cursor: "pointer" }} className="small">Ver evidências ({f.evidence.length})</summary>
        {f.evidence.length ? <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 4, listStyle: "none" }}>{f.evidence.map((e, i) => <li key={i} style={{ marginBottom: 3 }}><span aria-hidden="true" style={{ color: e.stance === "supports" ? "var(--ok)" : e.stance === "contradicts" ? "var(--danger)" : "var(--text-2)", fontWeight: 600, marginRight: 6 }}>{mark(e.stance)}</span><span className="sr-only">{e.stance === "supports" ? "sustenta: " : e.stance === "contradicts" ? "contradiz: " : "contexto: "}</span><code>{e.ref}</code> — {e.detail}</li>)}</ul> : <p className="small muted">Nenhuma evidência verificável no repositório.</p>}
      </details>
      {onAccept && action && <div className="actions" style={{ marginTop: 10 }}><button className="btn primary sm" disabled={busy} onClick={() => onAccept(action)}>{action.label}</button><span className="small muted">ou escolha outra decisão abaixo</span></div>}
    </section>
  );
}

export const HISTORICAL = ["superseded", "reverted", "historical"];
