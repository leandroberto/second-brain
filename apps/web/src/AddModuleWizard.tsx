import { useEffect, useRef, useState } from "react";
import { ApiError, adicionarModulo, inspecionarModulo, listarPastas, type Conferencia, type ErroDeCampo, type ListagemDePastas, type RespostaGerenciar } from "./api";
import { camposDoSchema, configDoFormulario, valoresIniciais, type Campo } from "./configForm";
import { errMsg } from "./lib";

/**
 * Teto diário de IA de um módulo recém-adicionado: `modules.<id>.ia_max_usd_dia` ainda não existe, vale o padrão do core. Cópia
 * do padrão de `ConfigSchema.modules[].ia_max_usd_dia` (packages/core/src/config.ts, hoje 2): mude os dois juntos.
 */
const TETO_IA_PADRAO_USD = 2;
export const TEXTO_DE_CONFIANCA = "Para conferir, o código desta pasta será carregado no seu computador. Continue só com módulos em que você confia.";
const ETAPAS = ["Pasta", "Conferir", "Configurar", "Confirmar"];

/** O servidor recusou por falta da frase-senha (`motivo` "errada" ou "exigida") e ela pode ser digitada aqui; "ausente" não pode. */
export const pedeFrase = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 403 && e.code === "frase_senha" && e.corpo?.motivo !== "ausente";

const FOCAVEIS = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Diálogo modal acessível: ao montar foca o primeiro campo (senão o botão primário), prende o Tab dentro dele, Escape fecha e,
 * ao sair, o foco volta ao elemento que o abriu.
 */
export function Dialogo({ titulo, onFechar, fechavel = true, children }: { titulo: string; onFechar: () => void; fechavel?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const origem = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const el = ref.current;
    (el?.querySelector<HTMLElement>("input") ?? el?.querySelector<HTMLElement>("button.primary") ?? el)?.focus();
    return () => { origem?.focus(); };
  }, []);
  const teclas = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { if (fechavel) { e.stopPropagation(); onFechar(); } return; }
    if (e.key !== "Tab") return;
    const itens = [...(ref.current?.querySelectorAll<HTMLElement>(FOCAVEIS) ?? [])];
    if (!itens.length) { e.preventDefault(); return; }
    const primeiro = itens[0]!; const ultimo = itens[itens.length - 1]!; const ativo = document.activeElement;
    if (e.shiftKey && (ativo === primeiro || ativo === ref.current)) { e.preventDefault(); ultimo.focus(); }
    else if (!e.shiftKey && ativo === ultimo) { e.preventDefault(); primeiro.focus(); }
  };
  return (
    <div className="overlay" onKeyDown={teclas}>
      <div className="modal" style={{ padding: 22 }} role="dialog" aria-modal="true" aria-label={titulo} tabIndex={-1} ref={ref}>{children}</div>
    </div>
  );
}

/**
 * Diálogo com texto e, quando `mostrarCampo`, o campo da frase-senha do revisor (aviso de confiança da etapa 1 e pedido ao ligar).
 * O valor fica só no campo (não controlado): sai no envio e o campo é limpo; nunca vai a storage nem ao estado.
 */
export function DialogoDeFrase({ titulo, texto, mensagem, mostrarCampo, ocupado, rotuloOcupado, onEnviar, onCancelar }: { titulo: string; texto?: string; mensagem?: string; mostrarCampo: boolean; ocupado?: boolean; rotuloOcupado: string; onEnviar: (frase: string | undefined) => void; onCancelar: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const botao = useRef<HTMLButtonElement>(null);
  // depois de enviar (botão desabilitado) o foco se perde: volta ao campo, ou ao botão primário quando não há campo
  useEffect(() => { if (!ocupado) (mostrarCampo ? ref.current : botao.current)?.focus(); }, [mostrarCampo, mensagem, ocupado]);
  const enviar = () => { const frase = ref.current?.value || undefined; if (ref.current) ref.current.value = ""; onEnviar(frase); };
  return (
    <Dialogo titulo={titulo} onFechar={onCancelar} fechavel={!ocupado}>
      <h1 style={{ fontSize: 18 }}>{titulo}</h1>
      {texto && <p>{texto}</p>}
      {mensagem && <div className="banner danger" role="alert">{mensagem}</div>}
      <form onSubmit={(e) => { e.preventDefault(); enviar(); }}>
        {mostrarCampo && <div className="field"><label htmlFor="mod-frase">Frase-senha do revisor</label><input id="mod-frase" ref={ref} type="password" autoComplete="off" /></div>}
        <div className="actions"><button type="submit" className="btn primary" ref={botao} disabled={ocupado}>{ocupado ? rotuloOcupado : "Continuar"}</button><button type="button" className="btn ghost" disabled={ocupado} onClick={onCancelar}>Cancelar</button></div>
      </form>
    </Dialogo>
  );
}

const errosDe = (e: unknown): ErroDeCampo[] => {
  const l = e instanceof ApiError ? e.corpo?.erros : undefined;
  return Array.isArray(l) ? l.filter((x): x is ErroDeCampo => !!x && typeof x.campo === "string" && typeof x.mensagem === "string") : [];
};
/** Erros de `config_invalida` (400), ou os de `config.yaml` com erro de edição (400 com a mensagem do servidor). */
export const errosDaConfig = (e: unknown): ErroDeCampo[] | undefined => {
  if (!(e instanceof ApiError)) return undefined;
  if (e.status === 400 && e.code === "config_invalida") return errosDe(e);
  return undefined;
};

/**
 * Edita a config de um módulo: formulário quando há `campos`, senão editor JSON. `valores` é o estado controlado do formulário;
 * `json` o texto do editor. Erro por campo ao lado dele; `campo: ""` (e campos sem correspondência) ficam no topo. `aviso` (no
 * topo) diz que o servidor não vai validar pelo schema agora.
 */
export function EditorDeConfig({ campos, valores, onValores, json, onJson, erros, nota, aviso }: { campos?: Campo[]; valores: Record<string, unknown>; onValores: (v: Record<string, unknown>) => void; json: string; onJson: (t: string) => void; erros: ErroDeCampo[]; nota?: string; aviso?: string }) {
  const nomes = new Set((campos ?? []).map((c) => c.nome));
  const gerais = erros.filter((e) => !nomes.has(e.campo));
  const set = (nome: string, v: unknown) => onValores({ ...valores, [nome]: v });
  return (
    <div>
      {aviso && <div className="banner" role="note">{aviso}</div>}
      {gerais.length > 0 && <div className="banner danger" role="alert"><div>{gerais.map((e, i) => <div key={i}>{e.campo ? <><code className="mono">{e.campo}</code>: </> : null}{e.mensagem}</div>)}</div></div>}
      {campos ? (campos.length === 0 ? <p className="small muted">Este módulo não tem campos para configurar.</p> : campos.map((c) => {
        const id = `cfg-${c.nome}`; const erro = erros.filter((e) => e.campo === c.nome); const v = valores[c.nome];
        return (
          <div className="field" key={c.nome}>
            {c.tipo === "booleano" ? (
              <label className="switch" htmlFor={id} style={{ borderTop: 0, padding: 0 }}><span>{c.rotulo}{c.obrigatorio && " *"}</span><input id={id} type="checkbox" checked={v === true} onChange={(e) => set(c.nome, e.target.checked)} /></label>
            ) : (
              <>
                <label htmlFor={id}>{c.rotulo}{c.obrigatorio && " *"}</label>
                {c.tipo === "opcoes"
                  ? <select id={id} value={typeof v === "string" ? v : ""} onChange={(e) => set(c.nome, e.target.value)}><option value="">(escolha)</option>{c.opcoes?.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                  : <input id={id} type={c.tipo === "numero" ? "number" : "text"} step={c.tipo === "numero" ? "any" : undefined} value={v === undefined ? "" : String(v)} aria-invalid={erro.length > 0 || undefined} aria-describedby={erro.length ? `${id}-erro` : undefined} onChange={(e) => set(c.nome, e.target.value)} />}
              </>
            )}
            {c.descricao && <div className="small muted">{c.descricao}</div>}
            {erro.length > 0 && <div id={`${id}-erro`} className="small" role="alert" style={{ color: "var(--danger)" }}>{erro.map((e) => e.mensagem).join("; ")}</div>}
          </div>
        );
      })) : (
        <div className="field"><label htmlFor="cfg-json">Configuração (JSON)</label><textarea id="cfg-json" className="mono" spellCheck={false} rows={8} value={json} onChange={(e) => onJson(e.target.value)} /><div className="small muted">{nota ?? "Este módulo não declara campos simples; edite o objeto de configuração em JSON."}</div></div>
      )}
    </div>
  );
}

/**
 * Config a enviar: do formulário (mesclado sobre `atual`, quando há: chaves fora do schema ficam), ou o objeto do editor JSON
 * (`erro` com a mensagem se não é um objeto JSON).
 */
export function configDaTela(campos: Campo[] | undefined, valores: Record<string, unknown>, json: string, atual?: Record<string, unknown>): { config: Record<string, unknown> } | { erro: string } {
  if (campos) return { config: configDoFormulario(campos, valores, atual) };
  try {
    const v: unknown = JSON.parse(json.trim() || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return { erro: "a configuração deve ser um objeto JSON" };
    return { config: v as Record<string, unknown> };
  } catch { return { erro: "JSON inválido" }; }
}

type Dialogo = { fase: "aviso" } | { fase: "frase"; mensagem: string };

/**
 * Assistente de 4 etapas (spec §2): pasta, conferir, configurar, confirmar. O aviso de confiança (e a frase-senha, se o servidor a
 * exigir) vem no Continuar da etapa 1, antes de o servidor carregar o código da pasta. `executar` aplica a ação que reinicia o
 * serve (toast, espera do reinício, recarga) e propaga os erros da API.
 */
export function AddModuleWizard({ onFechar, executar }: { onFechar: () => void; executar: (acao: () => Promise<RespostaGerenciar>) => Promise<void> }) {
  const [etapa, setEtapa] = useState(1);
  const [lista, setLista] = useState<ListagemDePastas>();
  const [caminho, setCaminho] = useState("");
  const [erro, setErro] = useState<string>();
  const [dialogo, setDialogo] = useState<Dialogo>();
  const [ocupado, setOcupado] = useState(false);
  const [conf, setConf] = useState<Conferencia>();
  const [valores, setValores] = useState<Record<string, unknown>>({});
  const [json, setJson] = useState("{}");
  const [soNesta, setSoNesta] = useState(false);
  const [erros, setErros] = useState<ErroDeCampo[]>([]);

  const abrir = async (c?: string) => {
    try { const l = await listarPastas(c); setLista(l); setCaminho(l.caminho); setErro(undefined); }
    catch (e) { setErro(errMsg(e)); }
  };
  useEffect(() => { void abrir(); }, []);

  const campos = conf?.resumo?.configJson ? camposDoSchema(conf.resumo.configJson) : undefined;

  const conferir = async (frase?: string) => {
    setOcupado(true);
    try {
      const c = await inspecionarModulo(caminho.trim(), frase);
      setDialogo(undefined); setConf(c); setErros([]); setErro(undefined);
      const cs = c.resumo?.configJson ? camposDoSchema(c.resumo.configJson) : undefined;
      setValores(cs ? valoresIniciais(cs) : {}); setJson("{}"); setSoNesta(false);
      setEtapa(2);
    } catch (e) {
      // frase errada ou ausente: o diálogo mostra o campo e a mensagem do servidor; qualquer outra recusa (429 inclusive) fecha
      // o diálogo e fica na etapa 1: reenviar é uma decisão da pessoa, nunca um laço
      if (pedeFrase(e)) setDialogo({ fase: "frase", mensagem: e.message });
      else { setDialogo(undefined); setErro(errMsg(e)); }
    } finally { setOcupado(false); }
  };

  const continuar3 = () => {
    const r = configDaTela(campos, valores, json);
    if ("erro" in r) { setErros([{ campo: "", mensagem: r.erro }]); return; }
    setErros([]); setEtapa(4);
  };

  const adicionar = async () => {
    const r = configDaTela(campos, valores, json);
    if (!conf?.ticket || "erro" in r) return;
    setOcupado(true); setErro(undefined);
    try { await executar(() => adicionarModulo({ ticket: conf.ticket!, config: r.config, soNestaMaquina: soNesta })); }
    catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === "ticket_invalido") { setConf(undefined); setEtapa(1); setErro("A conferência expirou. Confira a pasta de novo."); }
      else if (e instanceof ApiError && e.status === 409 && e.code === "id_mudou") { setConf(undefined); setEtapa(1); setErro("O módulo mudou desde a conferência; confira de novo."); }
      else if (e instanceof ApiError && e.status === 409 && e.code === "id_existente") setErro(`${e.message}${typeof e.corpo?.caminho === "string" ? ` (pasta já configurada: ${e.corpo.caminho})` : ""}`);
      else if (e instanceof ApiError && e.status === 400 && e.code === "modulo_invalido") { setConf(undefined); setEtapa(1); setErro(`${e.message}. Confira a pasta de novo.`); }
      else if (errosDaConfig(e)) { setErros(errosDaConfig(e)!); setEtapa(3); }
      else setErro(errMsg(e));
    } finally { setOcupado(false); }
  };

  const r = conf?.resumo;
  return (
    <section className="card" data-testid="add-module-wizard">
      <h2>Adicionar módulo</h2>
      <ol className="steps" aria-label="Etapas">{ETAPAS.map((n, i) => <li key={n} aria-current={etapa === i + 1 ? "step" : undefined} className={etapa > i + 1 ? "done" : ""}><span>{i + 1}</span> {n}</li>)}</ol>
      {erro && <div className="banner danger" role="alert">{erro}</div>}

      {etapa === 1 && (
        <div>
          <div className="field"><label htmlFor="mod-caminho">Caminho da pasta do módulo</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input id="mod-caminho" className="mono" value={caminho} onChange={(e) => setCaminho(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void abrir(caminho.trim() || undefined); }} placeholder="/home/você/projetos/meu-modulo" />
              <button className="btn" onClick={() => void abrir(caminho.trim() || undefined)}>Abrir</button>
              <button className="btn" disabled={!lista?.pai} onClick={() => lista?.pai && void abrir(lista.pai)}>Subir</button>
            </div></div>
          <div className="pastas" role="list" aria-label="Subpastas">
            {lista?.pastas.length === 0 && <div className="small muted" style={{ padding: 8 }}>Nenhuma subpasta aqui.</div>}
            {lista?.pastas.map((p) => (
              <div key={p.caminho} role="listitem" className="pasta"><button className="btn ghost" onClick={() => void abrir(p.caminho)}>{p.nome}</button>{p.provavelModulo && <span className="badge ok">módulo provável</span>}</div>
            ))}
          </div>
          <div className="actions" style={{ marginTop: 12 }}><button className="btn primary" disabled={!caminho.trim()} onClick={() => setDialogo({ fase: "aviso" })}>Continuar</button><button className="btn ghost" onClick={onFechar}>Cancelar</button></div>
        </div>
      )}

      {etapa === 2 && conf && (
        <div>
          {!conf.ok || !r ? (
            <>
              <div className="banner danger" role="alert"><div><b>Esta pasta não é um módulo válido:</b>{conf.causas.map((c, i) => <div key={i}>{c}</div>)}</div></div>
              <div className="actions"><button className="btn" onClick={() => setEtapa(1)}>Voltar</button><button className="btn primary" disabled>Continuar</button></div>
            </>
          ) : (
            <>
              <h3 style={{ margin: "0 0 4px" }}>{r.nome} <span className="muted small">v{r.versao}</span></h3>
              <div className="small muted">id <code className="mono">{r.id}</code> · sdk {r.sdk} · <code className="mono">{conf.caminho}</code></div>
              <p style={{ marginBottom: 4 }}><b>O que este módulo vai fazer</b></p>
              <ul className="faz">
                {r.aba && <li>Aba no menu: {r.aba.titulo}</li>}
                {r.tarefas.map((t) => <li key={t.id}>Tarefa <b>{t.id}</b>: {t.quandoTexto}</li>)}
                {r.ferramentas.length > 0 && <li>Ferramentas para os agentes: {r.ferramentas.map((f) => <code className="mono" key={f}>{f} </code>)}</li>}
                <li>{r.rotas.total} rotas, {r.rotas.humanas} agem fora (só com você logado)</li>
                {r.usaIa && <li>usa IA (até US$ {TETO_IA_PADRAO_USD.toFixed(2).replace(".", ",")}/dia)</li>}
                <li>propõe notas como <code className="mono">module/{r.id}</code></li>
              </ul>
              <div className="actions"><button className="btn" onClick={() => setEtapa(1)}>Voltar</button><button className="btn primary" onClick={() => { setEtapa(3); }}>Continuar</button></div>
            </>
          )}
        </div>
      )}

      {etapa === 3 && conf && (
        <div>
          <EditorDeConfig campos={campos} valores={valores} onValores={setValores} json={json} onJson={setJson} erros={erros} />
          <label className="switch" htmlFor="mod-so-nesta"><span>Só nesta máquina<span className="small muted" style={{ display: "block" }}>O módulo só roda aqui (grava o nome desta máquina em <code>host</code>).</span></span><input id="mod-so-nesta" type="checkbox" checked={soNesta} onChange={(e) => setSoNesta(e.target.checked)} /></label>
          <div className="actions" style={{ marginTop: 12 }}><button className="btn" onClick={() => setEtapa(2)}>Voltar</button><button className="btn primary" onClick={continuar3}>Continuar</button></div>
        </div>
      )}

      {etapa === 4 && conf && r && (() => {
        const cfg = configDaTela(campos, valores, json);
        return (
          <div>
            <dl className="kv"><dt>Módulo</dt><dd>{r.nome} <code className="mono">{r.id}</code> v{r.versao}</dd><dt>Pasta</dt><dd><code className="mono">{conf.caminho}</code></dd>
              <dt>Configuração</dt><dd>{"config" in cfg && Object.keys(cfg.config).length ? <pre className="mono small" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(cfg.config, null, 2)}</pre> : <span className="muted">(vazia)</span>}</dd>
              {soNesta && <><dt>Roda em</dt><dd>só nesta máquina</dd></>}</dl>
            <div className="actions"><button className="btn" disabled={ocupado} onClick={() => setEtapa(3)}>Voltar</button><button className="btn primary" disabled={ocupado} onClick={() => void adicionar()}>{ocupado ? "Adicionando…" : "Adicionar e reiniciar o serve"}</button></div>
          </div>
        );
      })()}

      {dialogo && <DialogoDeFrase titulo="Conferir o módulo" texto={TEXTO_DE_CONFIANCA} mostrarCampo={dialogo.fase === "frase"} mensagem={dialogo.fase === "frase" ? dialogo.mensagem : undefined} ocupado={ocupado} rotuloOcupado="Conferindo…" onEnviar={(f) => void conferir(f)} onCancelar={() => setDialogo(undefined)} />}
    </section>
  );
}
