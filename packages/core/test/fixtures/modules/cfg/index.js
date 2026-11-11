// Standard Schema escrito à mão: exige { horario: string }
const configSchema = { "~standard": { version: 1, vendor: "fixture", validate(v) {
  return v && typeof v.horario === "string" ? { value: v } : { issues: [{ message: "obrigatório", path: ["horario"] }] };
} } };
export default { sdk: 1, id: "cfg", nome: "Cfg", versao: "1.0.0", configSchema };
