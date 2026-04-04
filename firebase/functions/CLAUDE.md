# Firebase Functions — Arquitetura

Cloud Functions do Appacadabra. Região: `southamerica-east1`. Entry point: `src/index.ts`.

**Executar `npm run sync-capabilities` na raiz do projeto antes de qualquer deploy** — gera os arquivos `src/capabilities/*.ts` a partir de `lib/capabilities/`.

---

## Funções Exportadas

| Função | Tipo | Descrição |
|--------|------|-----------|
| `processSpellJob` | Firestore trigger (`jobs/{jobId}`) | Pipeline principal: cria/edita/converte apps, gera ícones, executa AI da WebView |
| `addCredits` | Callable | Adiciona mana (compra IAP ou reward de ad) |
| `getCredits` | Callable | Retorna saldo atual do usuário |
| `estimateManaCost` | Callable | Estima custo antes de executar operação AI |
| `uploadMedia` | Callable | Upload de mídia base64 grande para Storage |
| `suggestSpells` | Callable | Sugestões AI de apps (2 por chamada, modelo lite) |
| `claimInstallBonus` | Callable | Bônus de instalação (deduplicação por device ID) |

---

## Pipeline de Jobs (`processSpellJob`)

Trigger: criação/atualização de documento em `jobs/{jobId}`.

**Lifecycle:** `queued → processing → completed | failed`

### Ações disponíveis

**`create` (2 estágios):**
1. Planner: `UNIFIED_CREATE_PLANNER_PROMPT` → gera `appPlan` JSON (features, UI, passos)
2. Coder: `UNIFIED_CREATE_CODE_PROMPT` + plano → HTML completo
3. Validação + auto-fix loop

**`edit` (2 estágios):**
1. Edit Planner: analisa instrução contra código numerado, identifica seções afetadas
2. Patch Generator: gera JSON array de patches `{ startLine, endLine, content }`
3. Aplica patches → valida → auto-fix
4. Guardrail: impede renomear/remover chaves localStorage existentes

**`convert`:** Converte código React/Node → HTML standalone (1 estágio)

**`app_icon`:** Gera ícone via `gemini-3.1-flash-image-preview` → salva no Storage

**`webview_ai`:** Geração de texto com ferramentas (search, maps), schema enforcement, inputs de mídia

**`webview_ai_image`:** Geração ou edição de imagens (até 14 inputs)

**`webview_ai_video`:** Geração de vídeo ou animação image-to-video

**`webview_ai_tts`:** Text-to-speech, converte PCM→WAV, upload ao Storage se > 800KB

**`webview_ai_similarity`:** Matriz de similaridade semântica via `gemini-embedding-001`

---

## Modelos AI

| Modelo | Usado em |
|--------|---------|
| `gemini-3-flash-preview` | create, edit, convert (thinking HIGH, search tools) |
| `gemini-2.5-flash-lite` | suggestSpells |
| `gemini-3.1-flash-image-preview` | app_icon, webview_ai_image |
| `gemini-2.5-flash-preview-tts` | webview_ai_tts |
| `gemini-embedding-001` | webview_ai_similarity |

**Context Caching:** System instructions (~1.800 tokens) cacheadas por 1h por versão do app. Cache reuse = 25% do preço de input. Fallback automático se cache falhar.

---

## Sistema de Créditos (Mana)

- **1 Mana = $0,06 USD** de custo computacional
- Custo fixo para create/edit: **1,0 mana**
- Custo dinâmico para webview_ai_*: calculado por tokens + mídia
- Deduções em transações Firestore (atomicidade garantida)

**Pricing de referência:**
- Imagem: $0,04/unidade + $0,10/input image
- Vídeo: $0,25/s (fast) ou $0,65/s (std)
- TTS: $10,00/M output tokens
- Tokens cacheados: 25% do preço de input

---

## Capabilities (`src/capabilities/`)

**Auto-gerado por `npm run sync-capabilities`** — não editar manualmente.

Cada arquivo exporta um objeto com `id`, `displayName`, `minVersion` e `docs` (Markdown).
`src/capabilities/index.ts` compõe `buildSystemInstructions(appVersion, capabilities)` que monta o system prompt completo para o AI.

---

## Validação de Código

**`codeValidator.ts`:** Valida sintaxe HTML/JS/CSS, estrutura de tags, presença de `<script>`/`<style>`.

**`executionValidator.ts`:** Executa o HTML gerado com JSDOM, verifica erros de DOM e compatibilidade com localStorage.

**Auto-fix loop:** Coleta erros → gera `fixPrompt` → regenera → re-valida (até erros insolúveis).

---

## Firestore Schema (relevante para Functions)

| Coleção | Descrição |
|---------|-----------|
| `users/{uid}` | credits, creditsUsed, rateLimit, lastActive |
| `users/{uid}/creditLogs` | Histórico de transações de crédito |
| `users/{uid}/usageLogs` | Breakdown detalhado de custo AI por job |
| `jobs/{jobId}` | Estado do job + payload + result + audit logs |
| `install_bonuses` | Deduplicação de bônus de instalação |

**Storage:**
- `job_inputs/{uid}/{uuid}` — mídia enviada pelo cliente
- `generated_images/{uid}/{jobId}` — ícones gerados
- `generated_audio/{uid}/{jobId}` — output TTS

---

## Rate Limiting

- **Por minuto:** 30 chamadas / 500K tokens → cooldown de 60s
- **Por dia:** 10 chamadas para `suggestSpells`
- Rastreado em `users/{uid}.rateLimit` no Firestore

---

## Timeouts

- Chamadas AI padrão: 300s
- Jobs com thinking (create/edit): 540s
