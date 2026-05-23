# BYOK Migration Plan — Appacadabra

Plano de migração para um modo **Bring Your Own Key (BYOK)** onde o utilizador fornece a sua própria chave OpenRouter e todo o processamento AI acontece diretamente no app, sem passar pelas Firebase Functions.

---

## Motivação

- Elimina custo de infraestrutura para utilizadores que preferem pagar o AI diretamente
- Remove a dependência das Firebase Functions para o core de geração de spells
- O sistema de mana/créditos torna-se desnecessário para estes utilizadores

---

## Estado atual da arquitetura

```
App (RN)  →  jobs/{jobId} (Firestore)  →  processSpellJob (Functions)  →  OpenRouter
```

Cada operação AI cria um documento `jobs/{jobId}`, o trigger `processSpellJob` executa a pipeline e escreve o resultado de volta. O app aguarda via listener Firestore.

---

## Arquitetura BYOK proposta

```
App (RN)  →  OpenRouter (direto, chave do utilizador)
```

Dois caminhos paralelos coexistem:

| Modo | Entry point | Backend |
|------|-------------|---------|
| Gerido (atual) | `lib/api/ai.ts` | `jobs/{jobId}` → Functions → OpenRouter |
| BYOK (novo) | `lib/api/aiByok.ts` | OpenRouter direto |

Switch numa flag de utilizador (`userMode: 'managed' | 'byok'`), armazenada localmente.

---

## O que muda (e o que não muda)

### Não muda — já é local
Os dados que importam já vivem no **SQLite local**, não no Firestore:

| Tabela SQLite | Conteúdo |
|---------------|----------|
| `generated_apps` | Spells (código HTML), nome, ícone |
| `app_versions` | Histórico de versões |
| `app_storage` | localStorage persistido das apps |
| `webview_ai_cache` | Cache de chamadas AI dentro da WebView |
| `scheduled_notifications` | Alarmes agendados |

O Firestore nunca foi o banco de dados principal — era exclusivamente infraestrutura de billing e pipeline de jobs.

### Desaparece em BYOK

| Componente | Motivo |
|------------|--------|
| `jobs/{jobId}` (Firestore) | Jobs não existem — chamada é síncrona no app |
| `users/{uid}.credits` (Firestore) | Mana não existe — OpenRouter cobra o utilizador |
| `users/{uid}/creditLogs` | Irrelevante |
| `users/{uid}/usageLogs` | Opcional — pode ir para SQLite local |
| `processSpellJob` (Functions) | Bypassed completamente |
| `ManaShop` UI | Oculta quando BYOK ativo |
| `manaStore.ts` listener | `init()` não inicializa em modo BYOK |

### Precisa de porting

| Componente | Localização atual | Ação |
|------------|-------------------|------|
| Pipeline create (planner + coder + fix loop) | `firebase/functions/src/generators.ts` | Portar para `lib/byok/generators.ts` |
| `codeValidator.ts` (regex/string) | `firebase/functions/src/codeValidator.ts` | Portar — sem dependências de Node |
| `executionValidator.ts` (JSDOM) | `firebase/functions/src/executionValidator.ts` | Ver secção abaixo |
| Assembly do system prompt | `firebase/functions/src/capabilities/` | Já existe em `lib/capabilities/` — reutilizar diretamente |

### Firebase Storage

Em modo gerido, ícones/áudio TTS/vídeo são guardados no Firebase Storage. Em BYOK:
- Guardar diretamente no sistema de ficheiros via `expo-file-system`
- `expo-file-system` já é dependência do projeto

---

## O único bloqueador real: `executionValidator.ts`

O `executionValidator.ts` usa **JSDOM** para executar o HTML gerado e detetar erros de runtime. JSDOM não corre em React Native.

**Opções:**

1. **Drop** — remover a validação de execução em BYOK. Baixa o bar de qualidade mas simplifica o porting. O `codeValidator.ts` (sintaxe) continua ativo.

2. **WebView oculta** — executar o HTML numa WebView invisível e receber erros de volta via bridge. Preserva a validação mas adiciona complexidade.

**Recomendação para MVP:** Drop. Adicionar WebView validation numa iteração posterior se a qualidade sem ela se revelar insuficiente.

---

## Plano de implementação (MVP)

### 1. Armazenamento seguro da chave
- Campo de entrada nas Settings do app
- Guardar em `expo-secure-store` (Keystore no Android)
- Nunca expor a chave em logs ou Firestore

### 2. Cliente OpenRouter no app
Criar `lib/byok/client.ts`:
```typescript
import OpenAI from 'openai';
import * as SecureStore from 'expo-secure-store';

export async function getByokClient(): Promise<OpenAI> {
    const apiKey = await SecureStore.getItemAsync('openrouter_api_key');
    if (!apiKey) throw new Error('No OpenRouter API key configured');
    return new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey,
        dangerouslyAllowBrowser: true,
        defaultHeaders: { 'X-OpenRouter-Cache': 'true' },
    });
}
```

### 3. Port da pipeline de geração
Criar `lib/byok/generators.ts` — port de `firebase/functions/src/generators.ts`:
- `generateSpellCreate` e `generateSpellEdit` com as mesmas assinaturas
- Drop de `executionValidator` no MVP
- Port de `codeValidator.ts` para `lib/byok/codeValidator.ts` (sem alterações de lógica)

### 4. Entry point BYOK
Criar `lib/api/aiByok.ts` que expõe a mesma interface de `lib/api/ai.ts`:
```typescript
export async function generateApp(prompt: string): Promise<string>
export async function editApp(params: EditParams): Promise<string>
```
Internamente chama `getByokClient()` + `generateSpellCreate`/`generateSpellEdit`.

### 5. Switch de modo
Em `lib/store.ts` ou config local:
```typescript
type UserMode = 'managed' | 'byok';
```
- `lib/api/ai.ts` verifica o modo e delega para `aiByok.ts` ou mantém o flow atual
- `manaStore.ts`: `init()` retorna early se `userMode === 'byok'`
- `ManaShop`: não renderiza em modo BYOK

### 6. UI de configuração
- Ecrã Settings (novo ou expandir existente)
- Campo para colar a chave OpenRouter
- Botão de teste (valida a chave com uma chamada mínima)
- Toggle visível de modo ativo

---

## Esforço estimado

**3–5 dias** para um engenheiro experiente:

| Tarefa | Esforço |
|--------|---------|
| Secure store + UI de chave | 0.5 dia |
| `lib/byok/client.ts` | 0.5 dia |
| Port `generators.ts` + `codeValidator.ts` | 1.5 dias |
| `lib/api/aiByok.ts` + switch de modo | 0.5 dia |
| Ocultar mana UI em modo BYOK | 0.5 dia |
| Testes + QA | 1 dia |

---

## Ficheiros relevantes (referência)

| Ficheiro | Relevância |
|----------|------------|
| `firebase/functions/src/index.ts` | Pipeline completo atual (`processSpellJob`) |
| `firebase/functions/src/generators.ts` | Lógica de geração a portar |
| `firebase/functions/src/codeValidator.ts` | Portável diretamente |
| `firebase/functions/src/executionValidator.ts` | Bloqueador (JSDOM) |
| `firebase/firestore.rules` | Confirma que `credits` é Admin-SDK-only (BYOK não interfere) |
| `lib/api/ai.ts` | Entry point atual — adaptar para switch de modo |
| `lib/firebase.ts` | `submitJobAndWait` — não usado em BYOK |
| `lib/manaStore.ts` | Short-circuit em modo BYOK |
| `lib/capabilities/` | System prompt — já disponível no bundle, reutilizar diretamente |
