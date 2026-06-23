# Firebase Functions — Arquitetura

Cloud Functions do Appacadabra. Região: `southamerica-east1`. Entry point: `src/index.ts`.

A pipeline de geração de AI foi **removida** na refactor 3.0.0 — agora o cliente Android chama OpenRouter diretamente via BYOK (`lib/api/openrouter.ts`). As Functions cuidam apenas da **Spell Store pública** (publicar, despublicar, aprender, esquecer, sincronizar).

---

## Funções Exportadas (5 callables)

| Função | Descrição |
|--------|-----------|
| `publishSpell` | Publica um spell na store, sanitiza HTML, grava em Storage + `store_spells` |
| `unpublishSpell` | Remove um spell publicado pelo dono |
| `learnSpell` | Registra que um usuário aprendeu um spell (alimenta contadores de discovery) |
| `unlearnSpell` | Remove o registro de `learned_spells` para um usuário |
| `syncLearnedSpells` | Reconcilia a biblioteca local com os spells aprendidos no servidor |

Todas exigem autenticação Google (`requireGoogleAuth()` no início de cada handler).

---

## Sanitização HTML (`publishSpell`)

Spells publicados passam por sanitizer que remove `<script src="...">` apontando para origens externas não-whitelisted, atributos `onerror=`/`onclick=`/etc., e protocolos `javascript:`/`data:` (exceto `data:image/*`). Veja `src/htmlSanitizer.ts`.

---

## Firestore Schema (Functions)

| Coleção | Descrição |
|---------|-----------|
| `store_spells/{spellId}` | Spell publicado: name, code (sanitizado), authorUid, downloadCount |
| `learned_spells/{uid}/spells/{spellId}` | Quais spells cada usuário aprendeu |

Regras em `firebase/firestore.rules`:
- `store_spells`: leitura pública, escrita **só via Functions** (cliente nunca escreve)
- `learned_spells/{uid}/...`: leitura+escrita só pelo próprio `uid`

---

## Storage

- `published_spells/{spellId}/icon.png` — ícones de spells publicados

---

## Capabilities (referência cruzada)

O sync-capabilities **não gera mais** arquivos em `firebase/functions/src/capabilities/`. A documentação que vai para o system prompt do AI mora em `lib/api/systemPrompt.ts` no cliente, montada a partir de `lib/capabilities/*.ts`.

---

## Deploy

```bash
cd firebase/functions
npm install
firebase deploy --only functions
```

Não é mais necessário rodar `sync-capabilities` antes do deploy — as Functions não dependem mais do registry de capabilities.
