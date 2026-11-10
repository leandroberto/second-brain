// Reaplica o lint atual a um JSON de benchmark antigo (para comparar com o mesmo critério).
import { readFileSync, writeFileSync } from "node:fs";
import { lint } from "./bench-lint.mjs";
const [inp, out] = process.argv.slice(2);
const d = JSON.parse(readFileSync(inp, "utf8"));
for (const c of d.candidates) c.flags = lint(c);
const flagged = d.candidates.filter((c) => c.flags.length);
d.summary.flagged = flagged.length; d.summary.clean = d.candidates.length - flagged.length; d.summary.by_flag = {};
for (const c of d.candidates) for (const f of c.flags) d.summary.by_flag[f] = (d.summary.by_flag[f] ?? 0) + 1;
writeFileSync(out, JSON.stringify(d, null, 2)); console.log(JSON.stringify({ total: d.summary.total, flagged: d.summary.flagged, clean: d.summary.clean, by_flag: d.summary.by_flag }));
