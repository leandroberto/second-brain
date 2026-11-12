// Cliente mínimo da aba de módulo (spec de módulos §7.7). ES module sem dependências, servido em
// /modules/_sdk/brain-module-client.js. A página roda num iframe sem allow-same-origin (origem opaca): fala com o SB só por
// postMessage e chama a API com o token de página, que fica só em memória (nunca em storage).
//
//   import { conectar } from "/modules/_sdk/brain-module-client.js";
//   const sb = await conectar();
//   const itens = await sb.api("/itens"); // relativo a /api/modules/<id>

const DO_SB = new Set(["brain:init", "brain:token", "brain:tema"]);
const TEMAS = new Set(["claro", "escuro"]);
const ANTECEDENCIA_MS = 3600_000; // pede um token novo 1 h antes de `expira`
const MIN_ESPERA_MS = 30_000; // nunca pede com menos de 30 s de intervalo
const SEM_EXPIRA_MS = 11 * 3600_000; // `expira` ausente ou ilegível: o token de página dura 12 h

/**
 * O SB monta o iframe com `#n=<nonce>&r=<resto codificado>`. O nonce é lido UMA vez, ao carregar este arquivo, e o hash volta
 * a `#<resto>` (o nonce não fica em `location.hash` para o resto da página). Sem o fragmento (outro documento, recarga) o
 * nonce é vazio e o SB recusa o `brain:pronto`.
 */
const NONCE = (() => {
  const m = /^#n=([A-Za-z0-9_-]+)&r=(.*)$/.exec(window.location.hash);
  if (!m) return "";
  // o nonce é guardado ANTES de mexer no hash: falha na reescrita não pode derrubar o handshake
  const nonce = m[1];
  try {
    let resto = m[2];
    try { resto = decodeURIComponent(resto); } catch { /* mantém cru */ }
    const { pathname, search } = window.location; // só o fragmento muda (a página pode ter <base>)
    window.history.replaceState(null, "", pathname + search + "#" + resto);
  } catch (e) { console.warn("brain-module-client: não consegui tirar o nonce do hash", e); }
  return nonce;
})();

let conexao;

/**
 * Faz o handshake com o SB (`brain:pronto` → `brain:init`) e devolve o cliente. Chame uma vez por página: chamadas repetidas
 * devolvem a mesma conexão (a mesma promessa). O `brain:pronto` leva o nonce do fragmento. A renovação do token é por pedido:
 * o `brain:init` traz `expira`, o cliente pede `brain:renovar` (com o nonce) 1 h antes de expirar e só aceita um `brain:token` enquanto espera a resposta; o
 * SB nunca empurra token sem pedido. `brain:tema` troca o tema. Só aceita mensagens da janela pai, com `type` conhecido.
 * `api(caminho)`: `caminho` é relativo às rotas do módulo (o client acrescenta `/api/modules/<id>`), ex.: `"/itens"`.
 * @returns {Promise<{ api(caminho: string, init?: RequestInit): Promise<unknown>; navegar(resto: string): void; abrirNota(id: string): void; aoMudarTema(fn: (t: "claro" | "escuro") => void): void; resto: string }>}
 */
export function conectar() {
  conexao ??= abrirConexao();
  return conexao;
}

function abrirConexao() {
  const pai = window.parent;
  let token = "";
  let apiBase = "";
  let tema = "escuro";
  let aguardando = false; // há um `brain:renovar` sem resposta
  let temporizador;
  const ouvintesTema = new Set();
  const avisar = (tipo, dados) => pai.postMessage({ type: tipo, ...dados }, "*");
  const aplicarTema = (t) => {
    tema = t;
    document.documentElement.dataset.theme = t === "claro" ? "light" : "dark";
    for (const fn of ouvintesTema) { try { fn(t); } catch (e) { console.error(e); } }
  };
  const agendar = (expira) => {
    clearTimeout(temporizador);
    const fim = typeof expira === "string" ? Date.parse(expira) : NaN;
    const espera = Number.isFinite(fim) ? fim - ANTECEDENCIA_MS - Date.now() : SEM_EXPIRA_MS;
    temporizador = setTimeout(pedirRenovacao, Math.max(MIN_ESPERA_MS, espera));
  };
  function pedirRenovacao() {
    aguardando = true;
    avisar("brain:renovar", { nonce: NONCE });
    // sem resposta (SB ocupado ou ponte cortada): pergunta de novo, sem acumular temporizadores
    clearTimeout(temporizador);
    temporizador = setTimeout(pedirRenovacao, MIN_ESPERA_MS);
  }

  return new Promise((resolve) => {
    let conectado = false;
    window.addEventListener("message", (event) => {
      if (event.source !== pai) return;
      const d = event.data;
      if (!d || typeof d !== "object" || typeof d.type !== "string" || !DO_SB.has(d.type)) return;
      if (d.type === "brain:token") {
        // só como resposta a um pedido nosso: token empurrado sem pedido é ignorado
        if (conectado && aguardando && typeof d.token === "string" && d.token) { token = d.token; aguardando = false; agendar(d.expira); }
        return;
      }
      if (d.type === "brain:tema") { if (TEMAS.has(d.tema)) aplicarTema(d.tema); return; }
      // brain:init: uma vez por documento
      if (conectado) return;
      if (typeof d.token !== "string" || !d.token || typeof d.apiBase !== "string") return;
      conectado = true;
      token = d.token;
      if (TEMAS.has(d.tema)) aplicarTema(d.tema);
      agendar(d.expira);
      apiBase = d.apiBase.replace(/\/+$/, "");
      resolve({
        resto: typeof d.resto === "string" ? d.resto : "",
        async api(caminho, init = {}) {
          const headers = new Headers(init.headers);
          headers.set("authorization", "Bearer " + token);
          const res = await fetch(apiBase + caminho, { ...init, headers });
          const texto = await res.text();
          let corpo;
          try { corpo = texto ? JSON.parse(texto) : undefined; } catch { corpo = texto; }
          if (!res.ok) {
            const msg = corpo && typeof corpo === "object" && typeof corpo.message === "string" ? corpo.message : `HTTP ${res.status}`;
            throw Object.assign(new Error(msg), { status: res.status, corpo });
          }
          return corpo;
        },
        navegar(resto) { avisar("brain:navegar", { resto: String(resto) }); },
        abrirNota(id) { avisar("brain:abrirNota", { id: String(id) }); },
        /** Registra `fn` e já a chama com o tema atual. */
        aoMudarTema(fn) { ouvintesTema.add(fn); try { fn(tema); } catch (e) { console.error(e); } },
      });
    });
    avisar("brain:pronto", { nonce: NONCE });
  });
}
