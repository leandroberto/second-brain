// Script da janela, carregado como módulo ES (<script type="module">).

import { markdownParaHtml } from './markdown.js';

type ModoJanela = 'anotar' | 'perguntar';

type RespostaJanela =
  | { tipo: 'resposta'; texto: string; fontes: string[] }
  | { tipo: 'nao-anotado' }
  | { tipo: 'erro'; motivo: string; mensagem: string };

declare global {
  interface Window {
    cerebro: {
      acaoDaTecla(e: { key: string; shiftKey: boolean }): 'alternar' | 'enviar' | 'quebrar-linha' | 'fechar' | null;
      anotar(texto: string): Promise<{ aceito: boolean }>;
      perguntar(texto: string): Promise<RespostaJanela>;
      abrirNota(caminho: string): Promise<void>;
      mudouModo(modo: ModoJanela): void;
      ajustarAltura(altura: number): void;
      fechar(): void;
      aoMostrar(cb: (dados: { modo: ModoJanela; texto?: string; aviso?: string }) => void): void;
    };
  }
}

(() => {
  const api = window.cerebro;
  const painel = document.getElementById('painel') as HTMLDivElement;
  const caixa = document.getElementById('caixa') as HTMLTextAreaElement;
  const dica = document.getElementById('dica') as HTMLDivElement;
  const aviso = document.getElementById('aviso') as HTMLDivElement;
  const resposta = document.getElementById('resposta') as HTMLDivElement;
  const abas = Array.from(document.querySelectorAll<HTMLButtonElement>('#abas button'));

  let modo: ModoJanela = 'anotar';
  let ocupado = false;

  const TEXTOS: Record<ModoJanela, { placeholder: string; dica: string }> = {
    anotar: {
      placeholder: 'O que você quer guardar?',
      dica: 'Enter guarda · Shift+Enter nova linha · Tab troca · Esc fecha',
    },
    perguntar: {
      placeholder: 'O que você quer saber?',
      dica: 'Enter pergunta · Shift+Enter nova linha · Tab troca · Esc fecha',
    },
  };

  function aplicarModo(novo: ModoJanela): void {
    modo = novo;
    for (const aba of abas) aba.classList.toggle('ativa', aba.dataset.modo === novo);
    caixa.placeholder = TEXTOS[novo].placeholder;
    dica.textContent = TEXTOS[novo].dica;
    if (novo === 'anotar') limparResposta();
  }

  function crescer(): void {
    caixa.style.height = 'auto';
    const linha = parseFloat(getComputedStyle(caixa).lineHeight) || 20;
    caixa.style.height = `${Math.min(caixa.scrollHeight, linha * 8 + 22)}px`;
  }

  function limparResposta(): void {
    resposta.hidden = true;
    resposta.className = '';
    resposta.replaceChildren();
  }

  function mostrarResposta(r: RespostaJanela): void {
    resposta.hidden = false;
    resposta.className = r.tipo === 'erro' ? 'erro' : '';
    resposta.replaceChildren();
    if (r.tipo === 'nao-anotado') {
      resposta.textContent = 'Não está anotado.';
      return;
    }
    if (r.tipo === 'erro') {
      resposta.textContent = r.mensagem;
      return;
    }
    const corpo = document.createElement('div');
    corpo.innerHTML = markdownParaHtml(r.texto); // markdownParaHtml escapa tudo antes de formatar
    resposta.append(corpo);
    const fontes = document.createElement('div');
    fontes.className = 'fontes';
    fontes.append('Fonte: ');
    for (const caminho of r.fontes) {
      const link = document.createElement('a');
      link.textContent = caminho.split(/[\\/]/).slice(-2).join('/');
      link.title = caminho;
      link.addEventListener('click', () => void api.abrirNota(caminho));
      fontes.append(link);
    }
    resposta.append(fontes);
  }

  async function enviar(): Promise<void> {
    const texto = caixa.value;
    if (texto.trim() === '' || ocupado) return;
    if (modo === 'anotar') {
      // só limpa a caixa depois que o processo principal guardou o texto; se não guardou, o texto fica aqui
      const { aceito } = await api.anotar(texto);
      if (aceito) {
        caixa.value = '';
        crescer();
      } else {
        aviso.hidden = false;
        aviso.textContent = 'Não consegui guardar a anotação; o texto continua aqui.';
      }
      return;
    }
    ocupado = true;
    caixa.disabled = true;
    resposta.hidden = false;
    resposta.className = '';
    resposta.textContent = 'pensando…';
    try {
      mostrarResposta(await api.perguntar(texto));
      caixa.value = '';
      crescer();
    } finally {
      ocupado = false;
      caixa.disabled = false;
      caixa.focus();
    }
  }

  caixa.addEventListener('keydown', (e) => {
    // Só dados simples atravessam a ponte do preload: um KeyboardEvent chega lá vazio.
    const acao = api.acaoDaTecla({ key: e.key, shiftKey: e.shiftKey });
    if (acao === 'alternar') {
      e.preventDefault();
      aplicarModo(modo === 'anotar' ? 'perguntar' : 'anotar');
      api.mudouModo(modo);
    } else if (acao === 'enviar') {
      e.preventDefault();
      void enviar();
    } else if (acao === 'fechar') {
      e.preventDefault();
      caixa.value = '';
      crescer();
      limparResposta();
      aviso.hidden = true;
      api.fechar();
    }
  });
  caixa.addEventListener('input', crescer);

  for (const aba of abas) {
    aba.addEventListener('click', () => {
      aplicarModo(aba.dataset.modo as ModoJanela);
      api.mudouModo(modo);
      caixa.focus();
    });
  }

  new ResizeObserver(() => api.ajustarAltura(Math.ceil(painel.getBoundingClientRect().height))).observe(painel);

  api.aoMostrar((dados) => {
    aplicarModo(dados.modo);
    if (dados.texto !== undefined) caixa.value = dados.texto;
    aviso.hidden = !dados.aviso;
    aviso.textContent = dados.aviso ?? '';
    crescer();
    caixa.focus();
    caixa.setSelectionRange(caixa.value.length, caixa.value.length);
  });

  aplicarModo('anotar');
})();
