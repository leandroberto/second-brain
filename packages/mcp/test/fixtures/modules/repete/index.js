// Nomes repetidos e inválidos: só a primeira `eco` é registrada.
const qualquer = { "~standard": { version: 1, vendor: "fixture", validate: (v) => ({ value: v }) } };
const ferramenta = (nome, descricao, entradaJson = { type: "object" }) => ({ nome, descricao, entrada: qualquer, entradaJson, async rodar() { return { nome }; } });
export default {
  sdk: 1, id: "repete", nome: "Repete", versao: "1.0.0",
  ferramentasMcp: [
    ferramenta("eco", "primeira"),
    ferramenta("eco", "segunda (repetida)"),
    ferramenta("Nome-Invalido", "nome fora da regra"),
    ferramenta("lista", "entrada que não é objeto", { type: "array" }),
  ],
};
