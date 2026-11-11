// Cliente mínimo da aba de módulo (spec de módulos §7.7). ES module sem dependências, servido em
// /modules/_sdk/brain-module-client.js. A página roda num iframe sem allow-same-origin (origem opaca): fala com o SB só por
// postMessage e chama a API com o token de página, que fica só em memória (nunca em storage).
//
//   import { conectar } from "/modules/_sdk/brain-module-client.js";
//   const sb = await conectar();
//   const itens = await sb.api("/api/modules/<id>/itens");

const DO_SB = new Set(["brain:init", "brain:token", "brain:tema"]);
const TEMAS = new Set(["claro", "escuro"]);

/**
 * Faz o handshake com o SB (`brain:pronto` → `brain:init`) e devolve o cliente. `brain:token` renova o token e
 * `brain:tema` troca o tema. Só aceita mensagens da janela pai, com `type` conhecido.
 * @returns {Promise<{ api(caminho: string, init?: RequestInit): Promise<unknown>; navegar(resto: string): void; abrirNota(id: string): void; aoMudarTema(fn: (t: "claro" | "escuro") => void): void; resto: string }>}
 */
export function conectar() {
  const pai = window.parent;
  let token = "";
  let apiBase = "";
  let tema = "escuro";
  const ouvintesTema = new Set();
  const avisar = (tipo, dados) => pai.postMessage({ type: tipo, ...dados }, "*");
  const aplicarTema = (t) => {
    tema = t;
    document.documentElement.dataset.theme = t === "claro" ? "light" : "dark";
    for (const fn of ouvintesTema) { try { fn(t); } catch (e) { console.error(e); } }
  };

  return new Promise((resolve) => {
    let conectado = false;
    window.addEventListener("message", (event) => {
      if (event.source !== pai) return;
      const d = event.data;
      if (!d || typeof d !== "object" || typeof d.type !== "string" || !DO_SB.has(d.type)) return;
      if (d.type === "brain:token") { if (typeof d.token === "string" && d.token) token = d.token; return; }
      if (d.type === "brain:tema") { if (TEMAS.has(d.tema)) aplicarTema(d.tema); return; }
      // brain:init
      if (typeof d.token !== "string" || !d.token || typeof d.apiBase !== "string") return;
      token = d.token;
      if (TEMAS.has(d.tema)) aplicarTema(d.tema);
      if (conectado) return; // um init repetido só renova token e tema
      conectado = true;
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
    avisar("brain:pronto", {});
  });
}
