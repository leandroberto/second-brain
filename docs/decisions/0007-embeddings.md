# ADR 0007 — Embeddings plugáveis; offline por padrão; externo é opt-in

Status: aceito · Data: 2026-10-14

## Decisão
Interface `EmbeddingProvider`. Padrão `hash-v1` (offline, determinístico: palavras+bigramas+trigramas de caracteres, 512 dims). Opcional `openai-compatible` (OpenAI/Ollama/LM Studio) — se a URL não for localhost exige `external_opt_in: true`, senão cai para `hash` com aviso. Trocar provider invalida vetores e reembute. Sem embeddings o FTS5 segue funcionando.

## Chave só para hosts autorizados (2026-11-12)
A chave lida de `api_key_env` (padrão `OPENAI_API_KEY`) só é enviada se o host de `base_url` estiver em
`embeddings.api_key_hosts` (padrão `["api.openai.com"]`): hostname exato, em minúsculas, sem curinga (a porta não entra na
comparação) e com `https`, exceto no loopback (`localhost`, `127.0.0.1`, `::1`). URL com credencial embutida nunca recebe a
chave. Host fora da lista: o embedder roda **sem** credencial (Ollama/LM Studio locais seguem funcionando) e, se a variável
estiver definida, `brain doctor` e *Configurações → Saúde* avisam "a chave de embeddings não é enviada para <host>: adicione-o
em embeddings.api_key_hosts no .brain/config.yaml". `api_key_hosts` só se altera no `.brain/config.yaml` (`PUT /api/settings`
responde 403): sem isso, a sessão do navegador trocaria `base_url` + `external_opt_in` e levaria a chave a um servidor
qualquer. O valor da chave nunca aparece em aviso, log ou resposta.

```yaml
embeddings:
  provider: openai-compatible
  base_url: https://meu-servidor.example/v1
  external_opt_in: true
  api_key_env: MINHA_CHAVE_DE_EMBEDDINGS
  api_key_hosts: [api.openai.com, meu-servidor.example]
```

## Honestidade
`hash-v1` **não é semântica profunda**; serve para quase-duplicatas e morfologia. Documentado em UI e docs.
