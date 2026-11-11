export default {
  sdk: 1, id: "lanca", nome: "Lança", versao: "1.0.0",
  rotas: [{ metodo: "GET", caminho: "/eco", async rodar(req) { return { chamador: req.chamador }; } }],
  async iniciar() { throw new Error("falha proposital no iniciar"); },
};
