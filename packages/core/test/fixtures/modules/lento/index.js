import { setTimeout } from "node:timers";
export default { sdk: 1, id: "lento", nome: "Lento", versao: "1.0.0", iniciar: () => new Promise((r) => setTimeout(r, 1000)) };
