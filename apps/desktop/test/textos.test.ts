import { expect, test } from "vitest";
import type { RespostaAnotar, RespostaDesfazer, RespostaPerguntar } from "../src/main/cliente-api";
import {
  MENSAGEM_INCERTO,
  MENSAGEM_PAREAMENTO,
  textoFilaCorrompida,
  textoQuarentena,
  textoAtalhoOcupado,
  textoDesfazer,
  textoGuardadoNaFila,
  textoPergunta,
  textoResultado,
  textoResumoPendentes,
} from "../src/main/textos";

const ID = "20261110-153012-a1b2";
const captura = (state: string, result: unknown): RespostaAnotar => ({ ok: true, capture_id: ID, state, result } as RespostaAnotar);

test("guardado: título Anotado, notas, estado da captura e ação Desfazer", () => {
  const t = textoResultado(captura("processada", { ok: true, notas: [{ id: "ambiente-wsl", acao: "criada" }], segredo_omitido: false, texto_mascarado: null }))!;
  expect(t.titulo).toBe("Anotado");
  expect(t.corpo).toBe("Guardei em ambiente-wsl. Estado: processada.");
  expect(t.desfazer).toBe(true);
});

test("guardado: complementada e na fila aparecem entre parênteses; senha omitida avisa", () => {
  const t = textoResultado(
    captura("processada", {
      ok: true,
      notas: [{ id: "a", acao: "complementada" }, { id: "b", acao: "na_fila" }],
      segredo_omitido: true,
      texto_mascarado: "x",
    }),
  )!;
  expect(t.corpo).toBe("Guardei em a (complementada), b (na fila de revisão). Estado: processada. Senha omitida.");
});

test("guardado sem nenhuma nota nova", () => {
  const t = textoResultado(captura("processada", { ok: true, notas: [], segredo_omitido: false, texto_mascarado: null }))!;
  expect(t.corpo).toBe("Nenhuma nota nova. Estado: processada.");
});

test("result auth: manda rodar claude setup-token no WSL e mostra o estado", () => {
  const t = textoResultado(captura("pendente", { ok: false, tipo: "auth", mensagem: "Not logged in" }))!;
  expect(t.titulo).toBe("Claude deslogado");
  expect(t.corpo).toContain("rode `claude setup-token` no WSL");
  expect(t.corpo).toContain("Estado: pendente");
  expect(t.desfazer).toBe(false);
});

test("result timeout, orçamento ou erro: guardado como pendente, com a mensagem e o estado", () => {
  for (const tipo of ["timeout", "orcamento", "erro"] as const) {
    const t = textoResultado(captura("pendente", { ok: false, tipo, mensagem: "demorou" }))!;
    expect(t.titulo).toBe("Guardado como pendente");
    expect(t.corpo).toBe("Organizo depois. (demorou) Estado: pendente.");
  }
});

test("pareamento e erro HTTP de captura", () => {
  expect(textoResultado({ ok: false, tipo: "pareamento", mensagem: MENSAGEM_PAREAMENTO })).toEqual({
    titulo: "Desktop não pareado",
    corpo: MENSAGEM_PAREAMENTO,
    desfazer: false,
  });
  expect(textoResultado({ ok: false, tipo: "http", status: 413, mensagem: "corpo > 1MB" })).toEqual({
    titulo: "Não consegui anotar",
    corpo: "corpo > 1MB (HTTP 413)",
    desfazer: false,
  });
});

test("incerto: não sei se foi registrado, confira as pendentes antes de reenviar", () => {
  const t = textoResultado({ ok: false, tipo: "incerto", mensagem: MENSAGEM_INCERTO });
  expect(t.titulo).toBe("Não sei se foi registrado");
  expect(t.corpo).toBe("Não sei se foi registrado; confira as pendentes (bandeja → Organizar pendentes) antes de reenviar.");
  expect(MENSAGEM_INCERTO).toBe(t.corpo);
  expect(textoDesfazer({ ok: false, tipo: "incerto", mensagem: MENSAGEM_INCERTO }).titulo).toBe("Não sei se foi desfeito");
  expect(textoResumoPendentes({ ok: false, tipo: "incerto", mensagem: MENSAGEM_INCERTO }).titulo).toBe("Não sei se organizou");
});

test("avisos da fila: corrompida e itens em quarentena", () => {
  expect(textoFilaCorrompida("fila-local.json.corrompido-1")).toEqual({
    titulo: "Fila local corrompida",
    corpo: "Guardei o arquivo original como fila-local.json.corrompido-1 e comecei uma fila nova.",
    desfazer: false,
  });
  expect(textoQuarentena(2).titulo).toBe("Anotações em quarentena");
  expect(textoQuarentena(2).corpo).toContain("2 anotação(ões)");
});

test("a mensagem de pareamento cita brain pair-desktop", () => {
  expect(MENSAGEM_PAREAMENTO).toBe("Rode `brain pair-desktop` no WSL e cole o token.");
});

test("offline: second-brain parado, anotação guardada", () => {
  expect(textoGuardadoNaFila(1)).toEqual({
    titulo: "second-brain parado, anotação guardada",
    corpo: "Envio assim que ele voltar (1 na fila).",
    desfazer: false,
  });
  expect(textoGuardadoNaFila(3).corpo).toBe("Envio assim que ele voltar (3 na fila).");
});

test("desfazer: desfeito, nada a reverter, ocupado, inexistente, conflito, offline e pareamento", () => {
  const casos: Array<[RespostaDesfazer | "nenhuma", string, string]> = [
    [{ ok: true, reverted: ["a"] }, "Desfeito", "Reabri a janela com o seu texto."],
    [{ ok: true, reverted: [] }, "Nada para desfazer", "Esta captura já estava desfeita ou não tinha notas para reverter."],
    [{ ok: false, tipo: "ocupado", mensagem: "x" }, "Captura em processamento", "Captura ainda em processamento; tente de novo em instantes."],
    [{ ok: false, tipo: "inexistente", mensagem: "x" }, "Nada para desfazer", "O second-brain não conhece mais essa captura."],
    [{ ok: false, tipo: "http", status: 409, mensagem: "a nota n foi alterada depois; desfaça pela revisão" }, "Não dá para desfazer", "a nota n foi alterada depois; desfaça pela revisão"],
    [{ ok: false, tipo: "offline" }, "second-brain parado", "Não consegui desfazer agora; tente quando ele voltar."],
    [{ ok: false, tipo: "pareamento", mensagem: MENSAGEM_PAREAMENTO }, "Desktop não pareado", MENSAGEM_PAREAMENTO],
    ["nenhuma", "Nada para desfazer", "Não há anotação recente do desktop para desfazer."],
  ];
  for (const [r, titulo, corpo] of casos) expect(textoDesfazer(r)).toEqual({ titulo, corpo, desfazer: false });
});

test("resumo de pendentes organizados pelo menu", () => {
  expect(textoResumoPendentes({ ok: true, retried: 0, restantes: 0 })).toEqual({ titulo: "Nada pendente", corpo: "Não há capturas pendentes.", desfazer: false });
  expect(textoResumoPendentes({ ok: true, retried: 2, restantes: 1 })).toEqual({
    titulo: "Pendentes organizados",
    corpo: "2 organizada(s), 1 ainda pendente(s).",
    desfazer: false,
  });
  expect(textoResumoPendentes({ ok: false, tipo: "offline" }).titulo).toBe("second-brain parado");
});

test("pergunta: resposta, não anotado, auth, erro, offline e pareamento", () => {
  const casos: Array<[RespostaPerguntar, unknown]> = [
    [{ ok: true, resposta: "45 s.", fontes: ["n1"] }, { tipo: "resposta", texto: "45 s.", fontes: ["n1"] }],
    [{ ok: true, resposta: "Não está anotado.", fontes: [] }, { tipo: "nao-anotado" }],
    [{ ok: false, tipo: "auth", mensagem: "Not logged in" }, { tipo: "erro", motivo: "auth", mensagem: "Claude deslogado: rode `claude setup-token` no WSL." }],
    [{ ok: false, tipo: "timeout", mensagem: "O Claude demorou demais para responder." }, { tipo: "erro", motivo: "timeout", mensagem: "O Claude demorou demais para responder." }],
    [{ ok: false, tipo: "offline" }, { tipo: "erro", motivo: "offline", mensagem: "O second-brain está parado. Inicie-o pelo menu da bandeja e pergunte de novo." }],
    [{ ok: false, tipo: "pareamento", mensagem: MENSAGEM_PAREAMENTO }, { tipo: "erro", motivo: "pareamento", mensagem: MENSAGEM_PAREAMENTO }],
    [{ ok: false, tipo: "incerto", mensagem: "x" }, { tipo: "erro", motivo: "timeout", mensagem: "A pergunta demorou demais para responder; tente de novo." }],
  ];
  for (const [r, esperado] of casos) expect(textoPergunta(r)).toEqual(esperado);
});

test("atalho ocupado", () => {
  expect(textoAtalhoOcupado("F1")).toEqual({
    titulo: "Atalho F1 já está em uso",
    corpo: "Feche o outro programa que usa essa tecla e reinicie o second-brain desktop.",
    desfazer: false,
  });
});
