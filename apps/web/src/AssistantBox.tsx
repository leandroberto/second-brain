import { useState } from "react";
import { api, type AskOutcome, type AssistantErrorKind, type CaptureAction, type CaptureResponse } from "./api";
import { errMsg, href, useToast } from "./lib";

export const ERRO_TXT: Record<AssistantErrorKind, string> = {
  auth: "O assistente não está autenticado. Rode `claude setup-token` no WSL e tente de novo.",
  timeout: "O assistente demorou demais e foi interrompido.",
  orcamento: "O orçamento do assistente para esta chamada acabou.",
  erro: "O assistente falhou.",
};
const ACAO_TXT: Record<CaptureAction, string> = { criada: "criada", complementada: "complementada", na_fila: "na fila de revisão", ignorada: "ignorada (já existia)" };
const STATE_TXT = { pendente: "pendente (fica salva e será reprocessada)", processada: "processada", desfeita: "desfeita" } as const;
const erroMsg = (tipo: AssistantErrorKind, mensagem: string) => (tipo === "erro" && mensagem ? `${ERRO_TXT.erro} ${mensagem}` : ERRO_TXT[tipo]);

export type AssistantTab = "capture" | "ask";

/** Campo Anotar/Perguntar. O texto digitado é enviado inteiro; quem organiza em notas é o assistente (Tarefa 9), via API. */
export function AssistantBox({ initialTab = "capture", autoFocus = false }: { initialTab?: AssistantTab; autoFocus?: boolean }) {
  const [tab, setTab] = useState<AssistantTab>(initialTab);
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState<CaptureResponse>(); const [ans, setAns] = useState<AskOutcome>(); const [err, setErr] = useState<string>();
  const toast = useToast();
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(undefined);
    try {
      if (tab === "capture") { const r = await api<CaptureResponse>("/api/assistant/capture", { method: "POST", body: { text } }); setCap(r); setAns(undefined); if (r.result.ok) { setText(""); toast("Anotação registrada"); } }
      else { setAns(await api<AskOutcome>("/api/assistant/ask", { method: "POST", body: { question: text } })); setCap(undefined); }
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const pick = (t: AssistantTab) => { setTab(t); setCap(undefined); setAns(undefined); setErr(undefined); };
  return (
    <div data-testid="assistant-box">
      <div className="tabs" role="tablist" aria-label="Assistente">
        <button className="tab" role="tab" aria-selected={tab === "capture"} onClick={() => pick("capture")}>Anotar</button>
        <button className="tab" role="tab" aria-selected={tab === "ask"} onClick={() => pick("ask")}>Perguntar</button>
      </div>
      <div className="field"><label htmlFor="asst-in">{tab === "capture" ? "O que você quer anotar?" : "O que você quer saber?"}</label>
        <textarea id="asst-in" autoFocus={autoFocus} value={text} rows={tab === "capture" ? 4 : 2} onChange={(e) => setText(e.target.value)} placeholder={tab === "capture" ? "Escreva do seu jeito; o assistente organiza em notas." : "Pergunte sobre o que está anotado."}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} /></div>
      <div className="actions" style={{ marginTop: 0 }}><button className="btn primary" disabled={busy || !text.trim()} onClick={send}>{busy ? "Enviando…" : tab === "capture" ? "Anotar" : "Perguntar"}</button><span className="muted small">Ctrl+Enter envia</span></div>
      {err && <div className="banner danger" role="alert" style={{ marginTop: 10 }}>{err}</div>}
      {cap && (
        <div style={{ marginTop: 12 }} role="status" data-testid="capture-result">
          <div className="small muted">Captura <code>{cap.capture_id}</code> · estado: <b>{STATE_TXT[cap.state]}</b></div>
          {cap.result.ok ? <>
            {cap.result.notas.length ? <ul style={{ margin: "6px 0", paddingLeft: 18 }}>{cap.result.notas.map((n) => <li key={n.id}><a href={href(n.acao === "na_fila" ? "review" : `note/${n.id}`)} style={{ textDecoration: "underline" }}>{n.id}</a> · {ACAO_TXT[n.acao]}</li>)}</ul> : <p className="small">Nenhuma nota foi gravada.</p>}
            {cap.result.segredo_omitido && <div className="banner">Um segredo foi omitido do texto antes de gravar ([SENHA OMITIDA]).</div>}
          </> : <div className="banner danger" role="alert">{erroMsg(cap.result.tipo, cap.result.mensagem)}</div>}
        </div>
      )}
      {ans && (
        <div style={{ marginTop: 12 }} role="status" data-testid="ask-result">
          {ans.ok ? <>
            <p style={{ whiteSpace: "pre-wrap", margin: "0 0 8px" }}>{ans.resposta}</p>
            {ans.fontes.length > 0 && <div className="small muted">Fontes: {ans.fontes.map((id, i) => <span key={id}>{i > 0 && ", "}<a href={href(`note/${id}`)} style={{ textDecoration: "underline" }}>{id}</a></span>)}</div>}
          </> : <div className="banner danger" role="alert">{erroMsg(ans.tipo, ans.mensagem)}</div>}
        </div>
      )}
    </div>
  );
}

export function AssistantModal({ tab, onClose }: { tab: AssistantTab; onClose: () => void }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label={tab === "capture" ? "Anotar" : "Perguntar"} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal wide" style={{ padding: 22 }}><AssistantBox initialTab={tab} autoFocus /><div className="actions"><button className="btn ghost" onClick={onClose}>Fechar</button></div></div>
    </div>
  );
}
