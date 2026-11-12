// Segundo módulo dos testes da API (sem aba): o token de página de `ok` não pode alcançá-lo.
export default {
  sdk: 1, id: "outro", nome: "Outro", versao: "1.0.0",
  rotas: [{ metodo: "GET", caminho: "/eco", async rodar(req) { return { chamador: req.chamador }; } }],
};
