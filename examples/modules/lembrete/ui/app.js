import { conectar } from "/modules/_sdk/brain-module-client.js";

const lista = document.getElementById("lista");
const resumo = document.getElementById("resumo");
const erro = document.getElementById("erro");

const sb = await conectar();
// `resto` vem do hash do SB (#/m/lembrete/item/<id>): é o link do aviso
const destaque = sb.resto.startsWith("item/") ? sb.resto.slice("item/".length) : "";

function mostrarErro(e) {
  erro.textContent = e instanceof Error ? e.message : String(e);
  erro.hidden = false;
}

function linha(item) {
  const li = document.createElement("li");
  li.className = "card" + (item.feito ? " feito" : "") + (item.id === destaque ? " destaque" : "");
  // dado sempre por textContent, nunca innerHTML
  const texto = document.createElement("span");
  texto.className = "texto";
  texto.textContent = item.texto;
  li.append(texto);
  if (!item.feito) {
    const botao = document.createElement("button");
    botao.className = "btn primary";
    botao.type = "button";
    botao.textContent = "feito";
    botao.addEventListener("click", async () => {
      botao.disabled = true;
      try {
        await sb.api(`/itens/${encodeURIComponent(item.id)}/feito`, { method: "POST" });
        await carregar();
      } catch (e) {
        botao.disabled = false;
        mostrarErro(e);
      }
    });
    li.append(botao);
  }
  return li;
}

async function carregar() {
  erro.hidden = true;
  try {
    const { itens } = await sb.api("/itens");
    const abertos = itens.filter((i) => !i.feito).length;
    resumo.textContent = itens.length ? `${abertos} pendente(s) de ${itens.length}` : "Nenhum lembrete ainda.";
    lista.replaceChildren(...itens.map(linha));
  } catch (e) {
    mostrarErro(e);
  }
}

sb.aoMudarTema(() => {});
await carregar();
