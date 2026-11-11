import type { StandardSchema } from "@brain/module-sdk";

/** Valida por Standard Schema (`~standard.validate`), nunca por `instanceof`. A mensagem junta `path: message` de cada issue. */
export async function validar<T>(s: StandardSchema<T>, v: unknown): Promise<{ ok: true; value: T } | { ok: false; mensagem: string }> {
  let r;
  try { r = await s["~standard"].validate(v); }
  catch (e) { return { ok: false, mensagem: `validação lançou: ${e instanceof Error ? e.message : String(e)}` }; }
  if ("issues" in r && r.issues) {
    const mensagem = r.issues.map((i) => {
      const caminho = (i.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join(".");
      return caminho ? `${caminho}: ${i.message}` : i.message;
    }).join("; ");
    return { ok: false, mensagem };
  }
  return { ok: true, value: (r as { value: T }).value };
}
