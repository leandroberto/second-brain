export default {
  sdk: 1, id: "ok", nome: "Ok", versao: "1.2.3",
  aba: { titulo: "Ok", pasta: "ui" },
  async iniciar(ctx) {
    globalThis.__fixtureOkIniciar = (globalThis.__fixtureOkIniciar ?? 0) + 1;
    globalThis.__fixtureOkCtx = ctx;
  },
};
