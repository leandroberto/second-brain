export interface SecretFinding { kind: string; sample: string; line: number }

const PATTERNS: Array<[string, RegExp]> = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["openai-style-key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe-key", /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/],
  ["url-credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@[^\s/]+/i],
  ["cookie-header", /\b(?:Set-)?Cookie:\s*[^\s=]+=[^\s;]{16,}/i],
  // atribuição de credencial: password = "xxxx", API_KEY: abcdef...
  ["credential-assignment", /\b(?:pass(?:word|wd)?|senha|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth)\b["']?\s*[:=]\s*["']?(?!\s*$)(?![<$({[]|your|xxx|changeme|example|placeholder|\*{3})[^\s"']{8,}/i],
];

const PLACEHOLDER = /(<[^>]+>|\$\{?\w+\}?|process\.env|os\.environ|\bxxx+\b|\*{3,}|redacted)/i;

const GLOBAL = PATTERNS.map(([k, re]) => [k, new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")] as const);

/** Detecção best-effort. Falsos positivos são aceitáveis: segredo nunca entra na base. Examina TODAS as ocorrências. */
export function scanSecrets(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((full, i) => {
    // linhas gigantes são varridas em janelas sobrepostas (nunca truncadas: segredo após o caractere 20 000 também é achado)
    const seen = new Set<string>();
    for (let off = 0; off === 0 || off < full.length; off += 19_000) {
      const ln = full.slice(off, off + 20_000);
      for (const [kind, re] of GLOBAL) {
        re.lastIndex = 0;
        for (const m of ln.matchAll(re)) {
          if (kind === "credential-assignment" && PLACEHOLDER.test(m[0])) continue;
          const key = `${kind}:${off + (m.index ?? 0)}`; if (seen.has(key)) continue; seen.add(key);
          out.push({ kind, sample: redact(m[0]), line: i + 1 });
        }
      }
      if (off + 20_000 >= full.length) break;
    }
  });
  return out;
}

/** Substitui trechos sensíveis por [REDACTED] (para logs/atividade e para o que é mostrado a agentes). */
export function redactSecrets(text: string): string {
  let t = text;
  for (const [kind, re] of GLOBAL) {
    re.lastIndex = 0;
    t = t.replace(re, (m) => (kind === "credential-assignment" && PLACEHOLDER.test(m) ? m : "[REDACTED]"));
  }
  return t;
}

const redact = (s: string): string => (s.length <= 8 ? "***" : `${s.slice(0, 4)}…(${s.length} chars)`);

/** Heurística contra despejar código/log gigante na memória. */
export function scanBulk(text: string, limits: { maxChars: number; maxCodeLines: number }): string[] {
  const w: string[] = [];
  if (text.length > limits.maxChars) w.push(`conteúdo muito grande (${text.length} > ${limits.maxChars} caracteres)`);
  let inCode = false; let codeLines = 0; let maxBlock = 0;
  for (const ln of text.split("\n")) {
    if (/^\s*```/.test(ln)) { if (inCode) maxBlock = Math.max(maxBlock, codeLines); inCode = !inCode; codeLines = 0; continue; }
    if (inCode) codeLines++;
  }
  if (inCode) maxBlock = Math.max(maxBlock, codeLines);
  if (maxBlock > limits.maxCodeLines) w.push(`bloco de código com ${maxBlock} linhas (máx ${limits.maxCodeLines}); prefira referência a repo/arquivo/commit`);
  return w;
}
