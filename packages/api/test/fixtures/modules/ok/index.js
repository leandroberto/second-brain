// Fixture de módulo para os testes da API: JS puro, sem importar o SDK.
/** Standard Schema escrito à mão: exige `{ texto: string }`. */
const entradaEco = {
  "~standard": {
    version: 1, vendor: "fixture",
    validate(v) {
      if (v && typeof v === "object" && typeof v.texto === "string") return { value: { texto: v.texto } };
      return { issues: [{ message: "texto obrigatório", path: ["texto"] }] };
    },
  },
};

export default {
  sdk: 1, id: "ok", nome: "Ok", versao: "1.2.3", icone: "sino",
  aba: { titulo: "Ok", pasta: "ui" },
  rotas: [
    { metodo: "GET", caminho: "/eco", async rodar(req) { return { chamador: req.chamador }; } },
    { metodo: "GET", caminho: "/itens/:id", async rodar(req) { return { id: req.params.id, q: req.query.get("q") }; } },
    { metodo: "POST", caminho: "/acao", humano: true, async rodar(req) { return { feito: true, body: req.body }; } },
    { metodo: "DELETE", caminho: "/vazio", async rodar() { return undefined; } },
    { metodo: "GET", caminho: "/lanca", async rodar() { throw new Error("detalhe interno que não pode vazar"); } },
    // rota com nome reservado: nunca alcançável (o SB trata _mcp antes das rotas do módulo)
    { metodo: "POST", caminho: "/_mcp/eco", async rodar() { return { sequestrada: true }; } },
  ],
  ferramentasMcp: [{
    nome: "eco", descricao: "devolve o texto", entrada: entradaEco,
    entradaJson: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"] },
    async rodar(args) { return { eco: args.texto }; },
  }, {
    // schema que LANÇA (bug do módulo), diferente de devolver issues (entrada inválida)
    nome: "quebra", descricao: "schema com defeito", entradaJson: { type: "object" },
    entrada: { "~standard": { version: 1, vendor: "fixture", validate() { throw new Error("schema quebrado por dentro"); } } },
    async rodar() { return { nunca: true }; },
  }],
  tarefas: [{
    id: "diaria", quando: "0 9 * * *",
    async rodar(ctx) { globalThis.__apiOkOcorrencia = ctx.ocorrencia.toISOString(); },
  }],
  async iniciar(ctx) { globalThis.__apiOkCtx = ctx; },
};
