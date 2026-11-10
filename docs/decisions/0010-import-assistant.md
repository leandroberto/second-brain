# ADR 0010 — Import Assistant heurístico, sem LLM, só produz propostas

Status: aceito · Data: 2026-10-14

## Contexto
Alimentar a base à mão não escala; despejar documentos inteiros degrada a memória. O sistema precisa continuar funcionando sem API paga.

## Decisão
Pipeline determinístico e explicável (scan seguro → extração por cabeçalhos ancorados/ADR/AGENTS → dedupe → classificação → **proposta**). Nunca grava conhecimento direto. LLM seria um provider opcional futuro que só produz `Candidate[]`.

## Alternativas
Extração por LLM (melhor recall, mas custo, privacidade e não determinismo); regex por palavra-chave em qualquer ponto (testado em repositório real: dezenas de falsos positivos).

## Consequências
Precisão alta e auditável (regra + evidência por candidato); recall menor (sinais só no corpo exigem `--loose`). O custo do recall é a revisão humana já existente.
