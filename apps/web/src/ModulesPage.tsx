import { useState } from "react";
import { api, atualizarModulo, reiniciarServe, removerModulo, type EntradaDeModulo, type ErroDeCampo, type ModuloInfo, type RespostaGerenciar } from "./api";
import { AddModuleWizard, DialogoDeFrase, EditorDeConfig, configDaTela, errosDaConfig, pedeFrase } from "./AddModuleWizard";
import { camposDoSchema, esperarReinicio, valoresIniciais } from "./configForm";
import { Skeleton, errMsg, href, timeAgo, useData, useModulos, useToast } from "./lib";

const STATUS: Record<ModuloInfo["status"] | "desligado", [string, string]> = { ativo: ["ok", "ativo"], falho: ["danger", "falho"], inativo: ["", "inativo nesta máquina"], ausente: ["warn", "ausente"], desligado: ["", "desligado"] };
const DICA: Partial<Record<ModuloInfo["status"], string>> = {
  falho: "Veja os erros, corrija o módulo e use Tentar de novo.",
  ausente: "Confira se a pasta ainda existe; se não, remova o módulo.",
  inativo: "Este módulo está marcado para rodar só em outra máquina (host).",
};
const quando = (iso?: string) => { if (!iso) return "—"; const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); };
const MSG_SEM_REINICIO = "O brain serve não reiniciou. Veja o serve.log na pasta de estado do second-brain.";

interface Settings { config: { modules?: Record<string, EntradaDeModulo> } }
type Pedido = { titulo: string; mensagem: string; enviar: (frase: string | undefined) => void };

export function ModulesPage() {
  const { data: mods, error: erroMods, reload } = useModulos();
  const { data: s, reload: recarregarCfg } = useData<Settings>("/api/settings");
  // "rodar agora" exige a sessão humana `full` da UI (canal ui); api-token e outras credenciais recebem 403, então nem mostra
  const { data: meta } = useData<{ principal: { kind: string; channel: string } }>("/api/meta");
  const podeGerenciar = meta?.principal.kind === "human" && meta.principal.channel === "ui";
  const toast = useToast();
  const [adicionando, setAdicionando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [reinicio, setReinicio] = useState<"" | "esperando" | "tempo">("");
  const [pedido, setPedido] = useState<Pedido>();
  const [editando, setEditando] = useState<string>();
  const [rodando, setRodando] = useState(""); const [resultados, setResultados] = useState<Record<string, string>>({});
  const [verErros, setVerErros] = useState<Record<string, boolean>>({});

  /** Executa a ação que reinicia o serve: toast com a mensagem, espera o `pid` mudar e recarrega a página. */
  const aplicar = async (acao: () => Promise<RespostaGerenciar>) => {
    // pid desconhecido (a consulta falhou): segue com a ação; a espera aceita qualquer pid depois de uma falha
    const antes = await api<{ pid: number }>("/api/serve").then((x) => x.pid, () => undefined);
    const r = await acao();
    toast(r.mensagem);
    if (r.reiniciar) { reload(); recarregarCfg(); return; } // sem reinício automático (API fora do brain serve): a mensagem pede o manual
    setReinicio("esperando");
    if (await esperarReinicio(antes) === "ok") location.reload(); else setReinicio("tempo");
  };
  const tentarDeNovo = async () => {
    setOcupado(true);
    try { await aplicar(() => reiniciarServe()); } catch (e) { setReinicio("tempo"); toast(errMsg(e), true); } finally { setOcupado(false); }
  };

  /** `acao` recebe a frase-senha (quando pedida). Frase errada ou ausente abre o pedido; os outros erros vão ao toast (ou a `onErro`). */
  const executar = async (acao: (frase?: string) => Promise<RespostaGerenciar>, titulo: string, frase?: string, onErro?: (e: unknown) => boolean) => {
    setOcupado(true); setPedido(undefined);
    try { await aplicar(() => acao(frase)); }
    catch (e) {
      if (pedeFrase(e)) setPedido({ titulo, mensagem: e.message, enviar: (f) => void executar(acao, titulo, f, onErro) });
      else if (!onErro?.(e)) toast(errMsg(e), true);
    } finally { setOcupado(false); }
  };
  const confirmar = (acao: string, nome: string) => confirm(`${acao} ${nome}? O brain serve será reiniciado.`);

  const rodar = async (m: ModuloInfo, tarefa: string) => {
    if (!confirm(`Rodar agora a tarefa "${tarefa}" do módulo "${m.nome}"?\n\nA tarefa pode causar uma ação externa (enviar mensagem, chamar um serviço) e não pode ser desfeita por aqui.`)) return;
    const k = `${m.id}/${tarefa}`; setRodando(k);
    try {
      const r = await api<{ resultado: string; erro?: string }>(`/api/modules/${m.id}/_tarefas/${encodeURIComponent(tarefa)}/rodar`, { method: "POST", body: {} });
      const txt = r.erro ? `${r.resultado}: ${r.erro}` : r.resultado; setResultados((x) => ({ ...x, [k]: txt })); toast(`${tarefa}: ${txt}`, r.resultado !== "ok"); reload();
    } catch (e) { setResultados((x) => ({ ...x, [k]: errMsg(e) })); toast(errMsg(e), true); } finally { setRodando(""); }
  };

  if (!mods || !s) return <div className="wrap">{erroMods ? <div className="banner danger" role="alert">{erroMods}</div> : <Skeleton n={4} />}</div>;
  const entradas = s.config.modules ?? {};
  const infos = new Map(mods.modulos.map((m) => [m.id, m]));
  const ids = [...new Set([...Object.keys(entradas), ...mods.modulos.map((m) => m.id)])].sort();

  return (
    <div className="wrap">
      <p className="small"><a href={href("settings")} style={{ textDecoration: "underline" }}>← Configurações</a></p>
      <h1>Módulos</h1><p className="sub">Módulos instalados neste brain. Mudanças reiniciam o brain serve.</p>
      {mods.reiniciar && reinicio === "" && <div className="banner" role="status">a configuração de módulos mudou: reinicie o brain serve</div>}
      {reinicio === "esperando" && <div className="banner info" role="status">Reiniciando o brain serve… a página volta sozinha quando ele estiver no ar.</div>}
      {reinicio === "tempo" && <div className="banner danger" role="alert"><span style={{ flex: 1 }}>{MSG_SEM_REINICIO}</span><button className="btn sm" disabled={ocupado} onClick={() => void tentarDeNovo()}>Tentar de novo</button></div>}

      {adicionando ? <AddModuleWizard onFechar={() => setAdicionando(false)} executar={(acao) => aplicar(async () => { const r = await acao(); setAdicionando(false); return r; })} /> : (
        podeGerenciar && <p><button className="btn primary" disabled={ocupado} onClick={() => setAdicionando(true)}>+ Adicionar módulo</button></p>
      )}
      {!podeGerenciar && meta && <div className="banner" role="status">Gerenciar módulos exige a sessão humana (<code>brain ui</code>).</div>}
      {ids.length === 0 && <p className="muted">Nenhum módulo configurado.</p>}

      <div className="grid">
        {ids.map((id) => {
          const m = infos.get(id); const e = entradas[id];
          const desligado = e?.enabled === false;
          const [cls, lbl] = STATUS[desligado ? "desligado" : m?.status ?? "ausente"];
          const nome = m?.nome ?? id;
          const abrirConfig = () => setEditando(id);
          return (
            <section key={id} className="card" data-testid={`modulo-${id}`}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><h2 style={{ margin: 0 }}>{nome}</h2> <code className="mono small">{id}</code> <span className={`badge ${cls}`}>{lbl}</span>{m?.versao && <span className="muted small">v{m.versao}</span>}{e?.host && <span className="badge" title="só roda nesta máquina do vault">host {e.host}</span>}</div>
              {m?.causa && <div className="small" style={{ color: "var(--danger)", marginTop: 4 }}>{m.causa}{DICA[m.status] && <span className="muted"> — {DICA[m.status]}</span>}</div>}
              <div className="small muted" style={{ marginTop: 4 }}>{(m?.pasta || e?.path) && <><code className="mono" title="pasta do módulo">{m?.pasta || e?.path}</code> · </>}{m && (m.iaBloqueada ? <span style={{ color: "var(--danger)" }}>IA {m.iaBloqueio ?? "bloqueada"}</span> : <>IA hoje: US$ {(m.iaHojeUsd ?? 0).toFixed(2)}</>)}</div>

              {m?.tarefas.map((t) => { const k = `${id}/${t.tarefa}`; const res = resultados[k]; return (
                <div key={t.tarefa} className="small" style={{ marginTop: 8, paddingLeft: 10, borderLeft: "2px solid var(--line)" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><b>{t.tarefa}</b> <code className="mono">{t.quando}</code>{t.suspensa && <span className="badge warn" title={`${t.errosSeguidos} erros seguidos`}>suspensa</span>}
                    {podeGerenciar && <button className="btn sm" style={{ marginLeft: "auto" }} disabled={!!rodando} onClick={() => void rodar(m, t.tarefa)}>{rodando === k ? "Rodando…" : "Rodar agora"}</button>}</div>
                  <div className="muted">próxima: {quando(t.proxima)} · última: {t.fim || t.inicio ? `${quando(t.fim ?? t.inicio)} (${timeAgo(t.fim ?? t.inicio)})` : "nunca"} {t.resultado && <span className={`badge ${t.resultado === "ok" ? "ok" : "danger"}`}>{t.resultado}</span>}</div>
                  {t.erro && <div style={{ color: "var(--danger)" }}>{t.erro}</div>}
                  {res && <div role="status">resultado agora: {res}</div>}
                </div>); })}

              {verErros[id] && m && (m.erros.length ? <div style={{ marginTop: 8 }}>{m.erros.map((x, i) => <div key={i} className="small" style={{ padding: "3px 0" }}><span className="muted">{quando(x.em)}</span> <code className="mono">{x.onde}</code> {x.mensagem}</div>)}</div> : <div className="small muted" style={{ marginTop: 8 }}>Sem erros recentes.</div>)}

              {editando === id && <ConfigurarModulo
                nome={nome} atual={e?.config ?? {}} configJson={m?.configJson} ocupado={ocupado}
                onCancelar={() => setEditando(undefined)}
                onSalvar={(config, setErros) => {
                  if (!confirmar("Salvar configuração de", nome)) return;
                  void executar(() => atualizarModulo(id, { config }), "Salvar configuração", undefined, (er) => { const l = errosDaConfig(er); if (l) { setErros(l); return true; } return false; });
                }} />}

              {podeGerenciar && <div className="actions" style={{ marginTop: 10, flexWrap: "wrap" }}>
                <button className="btn sm" disabled={ocupado} onClick={abrirConfig}>Configurar</button>
                {desligado
                  ? <button className="btn sm" disabled={ocupado} onClick={() => { if (confirmar("Ligar", nome)) void executar((f) => atualizarModulo(id, { enabled: true, ...(f ? { fraseSenha: f } : {}) }), `Ligar ${nome}`); }}>Ligar</button>
                  : <button className="btn sm" disabled={ocupado} onClick={() => { if (confirmar("Desligar", nome)) void executar(() => atualizarModulo(id, { enabled: false }), `Desligar ${nome}`); }}>Desligar</button>}
                {m && <button className="btn sm" disabled={ocupado} onClick={() => setVerErros((v) => ({ ...v, [id]: !v[id] }))}>Ver erros{m.erros.length ? ` (${m.erros.length})` : ""}</button>}
                {m?.status === "falho" && <button className="btn sm" disabled={ocupado} onClick={() => { if (confirmar("Tentar de novo", nome)) void tentarDeNovo(); }}>Tentar de novo</button>}
                <button className="btn sm danger" disabled={ocupado} onClick={() => { if (confirmar("Remover", nome)) void executar(() => removerModulo(id), `Remover ${nome}`); }}>Remover</button>
              </div>}
            </section>
          );
        })}
      </div>

      {pedido && <DialogoDeFrase titulo={pedido.titulo} texto="Este vault tem frase-senha de revisor: ela é pedida para ligar um módulo." mensagem={pedido.mensagem} mostrarCampo ocupado={ocupado} rotuloOcupado="Enviando…" onEnviar={pedido.enviar} onCancelar={() => setPedido(undefined)} />}
    </div>
  );
}

/**
 * "Configurar": os mesmos campos da etapa 3 do assistente, pelo schema que o serve já tem do módulo carregado (`configJson`);
 * sem ele (desligado, falho, ausente) ou com schema que não cabe em campos simples, o editor JSON da config atual.
 */
function ConfigurarModulo({ nome, atual, configJson, ocupado, onSalvar, onCancelar }: { nome: string; atual: Record<string, unknown>; configJson?: Record<string, unknown>; ocupado: boolean; onSalvar: (config: Record<string, unknown>, setErros: (e: ErroDeCampo[]) => void) => void; onCancelar: () => void }) {
  const campos = camposDoSchema(configJson);
  const [valores, setValores] = useState(() => (campos ? valoresIniciais(campos, atual) : {}));
  const [json, setJson] = useState(JSON.stringify(atual, null, 2));
  const [erros, setErros] = useState<ErroDeCampo[]>([]);
  const salvar = () => {
    const r = configDaTela(campos, valores, json);
    if ("erro" in r) { setErros([{ campo: "", mensagem: r.erro }]); return; }
    setErros([]); onSalvar(r.config, setErros);
  };
  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }} aria-label={`Configurar ${nome}`}>
      <EditorDeConfig campos={campos} valores={valores} onValores={setValores} json={json} onJson={setJson} erros={erros} nota={configJson ? undefined : "O formulário aparece quando o módulo estiver ativo."} />
      <div className="actions"><button className="btn primary sm" disabled={ocupado} onClick={salvar}>Salvar e reiniciar</button><button className="btn ghost sm" disabled={ocupado} onClick={onCancelar}>Cancelar</button></div>
    </div>
  );
}
