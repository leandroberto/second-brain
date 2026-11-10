# ADR 0005 — Governança: propostas, classificação e política de agentes

Status: aceito · Data: 2026-10-14

## Decisão
Agentes **nunca gravam conhecimento diretamente**. `brain_propose` cria proposta em `.brain/proposals/pending` com análise (`new|duplicate|complement|update|replace|conflict`) e sugestão. A decisão (`create|complement|update|replace|keep_separate|ignore`) é humana pela UI/CLI, ou do agente apenas se `agents.commit_policy` permitir (padrão `never`). `brain_supersede` também é proposta. `brain_link` é aditivo e direto (configurável).

## Por quê
Princípios 8–10 do prompt. A classificação é **heurística e explicável** (cobertura lexical, cosseno, números divergentes, negação invertida) — melhor do que um LLM opaco na V1 e testável; o humano sempre vê existente × proposto × prévia.

## Consequências
Paráfrases sem sobreposição lexical podem passar como `new` com o embedder offline; mitigação: provider de embeddings real (opt-in) e revisão humana.
