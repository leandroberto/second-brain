#!/usr/bin/env node
// Análise SOMENTE LEITURA de uma fila de propostas: reconcilia cada proposta contra o HEAD atual do repositório de origem.
// Nunca escreve nas propostas (só lê os JSON) e nunca abre o vault. Uso:
//   node scripts/freshness-queue.mjs <pasta-de-propostas> repo=caminho [repo=caminho ...] [--json saida.json]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { reconcileBatch } from "../packages/core/dist/freshness/index.js";

const args = process.argv.slice(2);
const dir = args[0]; const out = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
const repos = Object.fromEntries(args.slice(1).filter((a) => a.includes("=") && !a.startsWith("--")).map((a) => { const [k, v] = a.split("="); return [k, resolve(v.replace(/^~/, homedir()))]; }));
const props = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
const refPath = (ref) => { const p = ref?.split("#")[0]?.replace(/@[0-9a-f]{7,40}$/, "").trim(); return p && !/[;\s]/.test(p) ? p : undefined; };
const rows = [];
for (const [name, root] of Object.entries(repos)) {
  const mine = props.filter((p) => p.draft.source?.repository === name && p.import);
  for (const p of props.filter((x) => x.draft.source?.repository === name && !x.import)) rows.push({ id: p.id, by: p.proposed_by.name, repo: name, title: p.draft.title, f: undefined, na: "aprendizado de agente (conversa): não é afirmação sobre o estado do repositório" });
  // o import original pode ter usado uma subpasta (ex.: docs/) como raiz: resolve o caminho que existe no repositório
  const items = mine.map((p) => { const rp = refPath(p.draft.source?.ref) ?? refPath(p.import?.source_path); const path = rp && !existsSync(join(root, rp)) && existsSync(join(root, "docs", rp)) ? `docs/${rp}` : rp; return { title: p.draft.title, body: p.draft.body, path }; });
  const t0 = Date.now();
  const r = await reconcileBatch(items, { scanRoot: root, ignore: [name] });
  console.log(`\n=== ${name} (${mine.length} propostas) — verificado contra ${r.index?.name}@${r.index?.head?.short} em ${Date.now() - t0} ms`);
  mine.forEach((p, i) => { const f = r.results[i]; rows.push({ id: p.id, by: p.proposed_by.name, repo: name, title: p.draft.title, path: items[i].path, f }); console.log(`- ${(f ? `${f.state}/${f.confidence}` : "—").padEnd(16)} ${(f?.effort ?? "").padEnd(12)} [${p.proposed_by.name}] ${p.draft.title.slice(0, 64)}  ← ${items[i].path ?? "?"}`); for (const e of f?.evidence.slice(0, 3) ?? []) console.log(`      ${e.stance === "supports" ? "✓" : e.stance === "contradicts" ? "✗" : "·"} ${e.ref}: ${e.detail.slice(0, 130)}`); });
}
const count = (k) => rows.reduce((a, r) => { const v = r.f ? r.f[k] : r.na ? "n/a (agente)" : "sem-verificação"; a[v] = (a[v] ?? 0) + 1; return a; }, {});
console.log("\nestados:", JSON.stringify(count("state")), "\nesforço:", JSON.stringify(count("effort")), "\nsugestões:", JSON.stringify(count("suggestion")));
if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
