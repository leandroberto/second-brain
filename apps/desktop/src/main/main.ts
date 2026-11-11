import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { garantirAtalhos } from './atalhos-windows';
import { criarBandeja } from './bandeja';
import { criarClienteApi, MENSAGEM_PAREAMENTO, type ClienteApi, type EstadoApi, type RespostaAnotar } from './cliente-api';
import { criarCredencial } from './credencial';
import { gravarUltimoModo, lerUltimoModo } from './estado-ui';
import { avisosDasFilas, FilaLocal } from './fila-local';
import { anotarComFila } from './fluxo';
import { ajustarAltura, criarJanela, mostrarJanela } from './janela';
import { notificar } from './notificacoes';
import { INTERVALO_RENOVACAO_MS, renovarSeNecessario } from './renovacao';
import type { Modo } from './tipos';
import {
  textoAtalhoOcupado,
  textoDesfazer,
  textoFilaCorrompida,
  textoGuardadoNaFila,
  textoPergunta,
  textoQuarentena,
  textoResultado,
  textoResumoPendentes,
} from './textos';

export const AUMID = 'br.com.second-brain.desktop';
const ATALHO = 'F1';
const BASE = (process.env.SECOND_BRAIN_URL ?? 'http://localhost:3737').replace(/\/+$/, '');
const INTERVALO_FILA_MS = 30_000;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(AUMID);
  app.whenReady().then(iniciar);
}

let janela: BrowserWindow;

function abrir(dados: { modo?: Modo; texto?: string; aviso?: string } = {}): void {
  mostrarJanela(janela, { modo: dados.modo ?? lerUltimoModo(app.getPath('userData')), ...dados });
}

/** Abre a nota na UI web do second-brain (a UI já tem a sessão de revisão do usuário). */
function abrirNota(id: string): Promise<void> {
  return shell.openExternal(`${BASE}/#/note/${encodeURIComponent(id)}`);
}

/** Roda second-brain.cmd (instalado ao lado do app; no repositório, em scripts/windows). */
function iniciarSecondBrain(): void {
  const raiz = app.getAppPath();
  const cmd = [join(raiz, 'second-brain.cmd'), join(raiz, '..', '..', 'scripts', 'windows', 'second-brain.cmd')].find(existsSync);
  if (!cmd) {
    notificar({
      titulo: 'Não achei o second-brain.cmd',
      corpo: 'Reinstale o desktop com scripts/windows/desktop-install.ps1.',
      desfazer: false,
    });
    return;
  }
  const filho = spawn('cmd.exe', ['/c', cmd], { stdio: ['ignore', 'ignore', 'pipe'] });
  let erro = '';
  filho.stderr.on('data', (d: Buffer) => {
    erro = (erro + d.toString()).slice(-500);
  });
  const falhou = (detalhe: string): void =>
    notificar({ titulo: 'Não consegui iniciar o second-brain', corpo: detalhe.trim() || 'sem detalhes', desfazer: false });
  filho.on('error', (e) => falhou(e.message));
  filho.on('exit', (codigo) => {
    if (codigo !== 0) falhou(`O second-brain.cmd terminou com código ${codigo}. ${erro}`);
  });
}

function iniciar(): void {
  const userData = app.getPath('userData');
  const credencial = criarCredencial(join(userData, 'credencial.bin'), safeStorage);
  const fila = new FilaLocal(join(userData, 'fila-local.json'));
  // diário do que a janela entregou e ainda não teve destino (servidor, fila local ou volta à janela):
  // se o app fechar no meio, o texto vai para a fila local na próxima abertura
  const arquivoEmVoo = join(userData, 'em-voo.json');
  const emVoo = new FilaLocal(arquivoEmVoo);
  try {
    const sobras = emVoo.pendentes();
    for (const texto of sobras) fila.adicionar(texto);
    if (sobras.length > 0) rmSync(arquivoEmVoo, { force: true });
  } catch (e) {
    console.error('[em-voo]', e);
  }
  // sem token a API responde 401 e o cliente devolve "pareamento": o aviso é o mesmo de um token vencido
  let cliente: ClienteApi = criarClienteApi(BASE, credencial.ler() ?? '');
  let ultima: { id: string; texto: string } | null = null;
  let conversa = randomUUID();
  let ultimoEstado: EstadoApi | null = null;
  let avisouPareamento = false;

  janela = criarJanela(join(__dirname, 'preload.js'), join(__dirname, '..', 'renderer', 'index.html'));

  const bandeja = criarBandeja({
    abrir: () => abrir(),
    organizarPendentes: () => void organizarPendentes(true),
    desfazerUltimo: () => void desfazerUltimo(),
    parear: () => void parear(),
    iniciarSecondBrain,
    abrirQuarentena: () => void shell.openPath(fila.arquivoQuarentena),
    sair: () => app.quit(),
  });

  const acaoIniciar = { texto: 'Iniciar second-brain', aoAcionar: iniciarSecondBrain };

  function atualizarErro(): void {
    try {
      const naFila = fila.pendentes().length;
      if (naFila > 0) bandeja.definirErro(true, `${naFila} anotação(ões) na fila local`);
      else bandeja.definirErro(false);
      bandeja.definirQuarentena(fila.quarentena().length);
      for (const arquivo of avisosDasFilas(fila, emVoo)) notificar(textoFilaCorrompida(arquivo));
    } catch (e) {
      console.error('[fila]', e);
    }
  }

  async function desfazerUltimo(): Promise<void> {
    if (!ultima) return notificar(textoDesfazer('nenhuma'));
    const alvo = ultima;
    const r = await cliente.desfazer(alvo.id);
    notificar(textoDesfazer(r), !r.ok && r.tipo === 'offline' ? { acao: acaoIniciar } : {});
    if (r.ok) {
      ultima = null;
      if (r.reverted.length > 0) abrir({ modo: 'anotar', texto: alvo.texto });
    }
  }

  /** Organiza o que ficou pendente no servidor; avisa só quando foi pedido pelo menu. */
  async function organizarPendentes(avisar: boolean): Promise<void> {
    const r = await cliente.organizarPendentes();
    if (avisar) notificar(textoResumoPendentes(r), !r.ok && r.tipo === 'offline' ? { acao: acaoIniciar } : {});
  }

  function aoResultado(r: RespostaAnotar, texto: string): void {
    const t = textoResultado(r);
    if (!r.ok) return notificar(t);
    ultima = { id: r.capture_id, texto };
    notificar(t, {
      aoDesfazer: () => void desfazerUltimo(),
      aoClicar: () => abrir({ modo: 'anotar', aviso: `${t.corpo} Clique em Desfazer na bandeja para desfazer.` }),
    });
  }

  async function anotar(texto: string): Promise<void> {
    const { resposta, enfileirado } = await anotarComFila(cliente, fila, texto);
    atualizarErro();
    if (enfileirado && !resposta.ok) {
      if (resposta.tipo === 'pareamento') {
        return notificar({
          titulo: 'Desktop não pareado',
          corpo: `${resposta.mensagem} Sua anotação ficou guardada na fila local.`,
          desfazer: false,
        });
      }
      if (resposta.tipo === 'offline') return notificar(textoGuardadoNaFila(fila.pendentes().length), { acao: acaoIniciar });
    }
    if (!resposta.ok) {
      // 4xx ou incerto (não vão para a fila): devolve o texto à janela para nada se perder
      const t = textoResultado(resposta);
      abrir({ modo: 'anotar', texto, aviso: t.corpo });
      return notificar(t);
    }
    aoResultado(resposta, texto);
  }

  /** Esvazia a fila local (de 30 em 30 s e quando a API volta) e organiza os pendentes ao voltar. Nunca rejeita. */
  async function tique(): Promise<void> {
    try {
      await tiqueInterno();
    } catch (e) {
      console.error('[tique]', e);
    }
  }

  async function tiqueInterno(): Promise<void> {
    const estado = await cliente.estado();
    const voltou = estado === 'ok' && ultimoEstado !== 'ok';
    ultimoEstado = estado;
    if (estado === 'pareamento') {
      if (!avisouPareamento && fila.pendentes().length > 0) {
        avisouPareamento = true;
        notificar({ titulo: 'Desktop não pareado', corpo: MENSAGEM_PAREAMENTO, desfazer: false });
      }
      return atualizarErro();
    }
    avisouPareamento = false;
    if (estado !== 'ok') return atualizarErro();
    if (fila.pendentes().length > 0) {
      const { enviados, quarentenados } = await fila.enviar(cliente);
      if (quarentenados.length > 0) notificar(textoQuarentena(quarentenados.length));
      if (enviados.length === 1) aoResultado(enviados[0]!.resposta, enviados[0]!.texto);
      else if (enviados.length > 1) {
        const ultimo = enviados[enviados.length - 1]!;
        ultima = { id: ultimo.resposta.capture_id, texto: ultimo.texto };
        notificar({
          titulo: 'Anotações enviadas',
          corpo: `${enviados.length} anotações da fila local chegaram ao second-brain.`,
          desfazer: false,
        });
      }
    }
    atualizarErro();
    if (voltou) void organizarPendentes(false);
  }

  /**
   * Renova a credencial desktop (validade de 30 dias) quando ela tem mais de 7 dias: na subida e uma vez por dia.
   * Recusada (401/403) → mensagem de pareamento; offline → tenta na próxima vez. Nunca rejeita.
   */
  async function renovarCredencial(): Promise<void> {
    try {
      const r = await renovarSeNecessario(credencial, (token) => criarClienteApi(BASE, token).renovar());
      if (r.estado === 'renovada') {
        cliente = criarClienteApi(BASE, r.token);
        if (r.erroAoGuardar) {
          notificar({
            titulo: 'Não guardei a credencial renovada',
            corpo: `${r.erroAoGuardar}. Ela vale até o app fechar; depois, pareie de novo.`,
            desfazer: false,
          });
        }
      } else if (r.estado === 'pareamento') {
        notificar({ titulo: 'Desktop não pareado', corpo: MENSAGEM_PAREAMENTO, desfazer: false });
      }
    } catch (e) {
      console.error('[renovar]', e);
    }
  }

  /** Lê o token da área de transferência (`brain pair-desktop` imprime só o token) e o valida na API. */
  async function parear(): Promise<void> {
    const token = (await clipboard.readText()).trim();
    if (!token || /\s/.test(token)) {
      return notificar({
        titulo: 'Token não encontrado',
        corpo: 'Rode `brain pair-desktop` no WSL, copie o token e use esta opção de novo.',
        desfazer: false,
      });
    }
    const candidato = criarClienteApi(BASE, token);
    const estado = await candidato.estado();
    if (estado === 'offline') {
      return notificar({ titulo: 'second-brain parado', corpo: 'Inicie-o e tente parear de novo.', desfazer: false }, { acao: acaoIniciar });
    }
    if (estado === 'pareamento') {
      return notificar({ titulo: 'Token recusado', corpo: MENSAGEM_PAREAMENTO, desfazer: false });
    }
    try {
      credencial.salvar(token);
    } catch (e) {
      return notificar({ titulo: 'Não guardei o token', corpo: (e as Error).message, desfazer: false });
    }
    cliente = candidato;
    avisouPareamento = false;
    if ((await clipboard.readText()).trim() === token) clipboard.clear();
    notificar({ titulo: 'Desktop pareado', corpo: 'Token guardado com segurança neste computador.', desfazer: false });
    void tique();
  }

  /** Processa a anotação por trás; o texto nunca se perde: servidor, fila local ou de volta à janela. */
  async function anotarSeguro(texto: string, idEmVoo: string): Promise<void> {
    try {
      await anotar(texto);
    } catch (e) {
      console.error('[anotar]', e);
      abrir({ modo: 'anotar', texto, aviso: 'Não consegui processar a anotação; o texto voltou para a janela.' });
      notificar({ titulo: 'Não consegui anotar', corpo: `${(e as Error).message}. O texto voltou para a janela.`, desfazer: false });
    } finally {
      try {
        emVoo.remover(idEmVoo);
      } catch (e) {
        console.error('[em-voo]', e);
      }
    }
  }

  // A janela só limpa a caixa depois que o texto está guardado em disco (diário em-voo): `aceito: false` mantém o texto.
  ipcMain.handle('anotar', (_e, texto: string): { aceito: boolean } => {
    let id: string;
    try {
      id = emVoo.adicionar(texto);
    } catch (e) {
      notificar({ titulo: 'Não consegui guardar a anotação', corpo: `${(e as Error).message}. O texto continua na janela.`, desfazer: false });
      return { aceito: false };
    }
    janela.hide(); // fecha na hora; a API organiza por trás
    void anotarSeguro(texto, id);
    return { aceito: true };
  });
  ipcMain.handle('perguntar', async (_e, texto: string) => textoPergunta(await cliente.perguntar(texto, conversa)));
  ipcMain.handle('abrir-nota', (_e, id: string) => abrirNota(String(id)));
  ipcMain.on('mudou-modo', (_e, modo: Modo) => gravarUltimoModo(userData, modo));
  ipcMain.on('ajustar-altura', (_e, altura: number) => ajustarAltura(janela, altura));
  ipcMain.on('fechar', () => {
    conversa = randomUUID(); // a próxima pergunta começa uma conversa nova
    janela.hide();
  });

  const registrou = globalShortcut.register(ATALHO, () => {
    if (janela.isVisible() && janela.isFocused()) janela.hide();
    else abrir();
  });
  if (!registrou) {
    notificar(textoAtalhoOcupado(ATALHO));
    bandeja.definirErro(true, `atalho ${ATALHO} em uso`);
  }

  garantirAtalhos(AUMID);
  atualizarErro();
  if (!credencial.ler()) notificar({ titulo: 'Desktop não pareado', corpo: MENSAGEM_PAREAMENTO, desfazer: false });
  void renovarCredencial().then(() => tique());
  setInterval(() => void tique(), INTERVALO_FILA_MS);
  setInterval(() => void renovarCredencial(), INTERVALO_RENOVACAO_MS);

  app.on('second-instance', () => abrir());
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {
    /* continua residente */
  });
}
