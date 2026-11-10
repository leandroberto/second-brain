# ADR 0012 — Atualidade (freshness) separada da extração; status continua governando a recuperação

Status: aceito · Data: 2026-10-14

## Decisão
O Import Assistant reconcilia cada candidato com o **HEAD** do repositório de origem (somente leitura, heurístico, sem LLM) e anexa à **proposta** um veredito de atualidade (`current/planned/historical/superseded/reverted/uncertain/conflict`), separando **intenção** (a decisão ainda vale?) de **implementação** (o que o HEAD faz), com evidência rastreável, sugestão e esforço de revisão. Na **nota**, nada de taxonomia nova: o `status` existente continua sendo o que a recuperação usa (conhecimento histórico aprovado vira `superseded`) e um único bloco `verification {state, confidence, against, checked_at}` registra o resultado; `source.kind` registra a semântica da fonte. `brain_context` entrega o atual em `items` e o substituído em `history`.

## Por quê
Extrair bem não basta: uma afirmação corretamente extraída pode estar desatualizada. Novos status ("historical", "planned") espalhariam regras por toda a busca/UI/governança; reutilizar `superseded` (já excluído da busca/contexto por padrão e nunca apagado) preserva a história com custo mínimo. A evidência completa fica na proposta decidida (versionada), não na nota.

## Consequências
- Plano/spec nunca viram "atuais" sem evidência no código; ADR antiga continua atual se o HEAD a sustenta.
- Aprovação em lote exige atualidade `current`; auto-approve continua desligado.
- Heurística explicável tem limites (semântica de comportamento, idiomas, negativas sobre conceitos): na dúvida, `uncertain`, nunca `current`.
