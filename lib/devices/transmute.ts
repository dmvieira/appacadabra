/**
 * The forja: transmutes a spell into an encantamento bundle.
 *
 * A bundle is the autonomous payload the device stores under `enc:<id>`
 * (PROTOCOL.md §4): manifest + voice prompt + JSON-string data (mirroring
 * `app_storage` TEXT values) + capability permissionamento (v0.2).
 *
 * Two entry points:
 *  - transmuteSpell(input)  — pure, validated, test-friendly (prompt pronto)
 *  - transmuteApp(app, io)  — the real forja: reads the spell's capabilities
 *    (generated_apps.required_capabilities) and storage (app_storage), and
 *    generates the voice prompt with the BYOK OpenRouter pipeline
 */

import type { AppStorage } from '../database/types';
import { getCurrentLanguage } from '../i18n';
import { CapabilityEntry, ContractFieldType, DeviceRequirement, Bundle, DataSchemas, encIdForSpell, generateEncantamentoId, validEncantamentoId, validPowerName } from './protocol';
import { mapRequirements } from './capabilityMap';

const DATA_KEY_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const CAP_ID_RE = /^[a-z][a-z0-9_]{0,30}$/;
const ALL_REQUIREMENTS: DeviceRequirement[] = ['mic', 'speaker', 'net', 'storage', 'camera'];

/** Limites das palavras-chave de roteamento (manifest.keywords). */
export const KEYWORDS_MAX = 12;
export const KEYWORD_MAX_LEN = 64;

/** Normaliza keywords: trim, remove vazias, dedupe (case-insensitive), cap. */
export function normalizeKeywords(input: readonly string[] | undefined): string[] {
    if (!input) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of input) {
        if (typeof raw !== 'string') continue;
        const k = raw.trim().replace(/\s+/g, ' ');
        if (!k) continue;
        const kk = k.toLowerCase();
        if (seen.has(kk)) continue;
        seen.add(kk);
        out.push(k.slice(0, KEYWORD_MAX_LEN));
        if (out.length >= KEYWORDS_MAX) break;
    }
    return out;
}

function validateCapabilityEntry(entry: CapabilityEntry, prefix: string): string | null {
    if (!entry || typeof entry !== 'object') return `${prefix} invalida`;
    if (typeof entry.id !== 'string' || !CAP_ID_RE.test(entry.id)) return `${prefix}.id invalido: ${entry.id}`;
    if (entry.status !== 'granted' && entry.status !== 'not-supported') {
        return `${prefix}.status deve ser granted|not-supported`;
    }
    if (!Array.isArray(entry.powers) || entry.powers.length > 4) return `${prefix}.powers deve ser array de ate 4`;
    for (const p of entry.powers) {
        if (typeof p !== 'string' || !validPowerName(p)) return `${prefix}.poder invalido: ${p}`;
    }
    if (!Array.isArray(entry.requires) || entry.requires.length > 5) return `${prefix}.requires deve ser array de ate 5`;
    for (const r of entry.requires) {
        if (!ALL_REQUIREMENTS.includes(r)) return `${prefix}.require invalido: ${r}`;
    }
    return null;
}

export interface TransmuteInput {
    spellId: string;
    name: string;
    prompt: string;
    /** Objects are serialized to JSON strings (app_storage TEXT semantics). */
    data?: Record<string, unknown>;
    /** Contrato de dados (v0.3, opcional) — validação das mutações de voz. */
    dataSchemas?: DataSchemas;
    version?: number;
    requiredPowers?: string[];
    createdAt?: number;
    /** Fixed encantamento id (tests); generated when omitted. */
    encId?: string;
    /** Capability permissionamento (v0.2) — from mapRequirements(). */
    capabilities?: CapabilityEntry[];
    /** Palavras/frases de roteamento (manifest.keywords). */
    keywords?: string[];
}

/** Returns null when valid, or a human-readable error otherwise. */
export function validateBundle(bundle: Bundle): string | null {
    const m = bundle.manifest;
    if (!m || typeof m !== 'object') return 'manifest ausente';
    if (!validEncantamentoId(m.id)) return `manifest.id invalido: ${m.id}`;
    if (typeof m.spellId !== 'string' || m.spellId.length < 1 || m.spellId.length > 64) {
        return 'manifest.spellId deve ter 1-64 chars';
    }
    if (typeof m.name !== 'string' || m.name.length < 1 || m.name.length > 64) {
        return 'manifest.name deve ter 1-64 chars';
    }
    if (!Number.isInteger(m.version) || m.version < 1) return 'manifest.version deve ser inteiro >= 1';
    if (!Array.isArray(m.requiredPowers) || m.requiredPowers.length > 8) {
        return 'manifest.requiredPowers deve ser array de ate 8';
    }
    for (const p of m.requiredPowers) {
        if (typeof p !== 'string' || !validPowerName(p)) return `poder invalido: ${p}`;
    }
    if (!Number.isInteger(m.createdAt) || m.createdAt < 0) return 'manifest.createdAt deve ser inteiro >= 0';
    if (m.capabilities !== undefined) {
        if (!Array.isArray(m.capabilities) || m.capabilities.length > 16) {
            return 'manifest.capabilities deve ser array de ate 16';
        }
        const seen = new Set<string>();
        for (let i = 0; i < m.capabilities.length; i++) {
            const err = validateCapabilityEntry(m.capabilities[i], `capabilities[${i}]`);
            if (err) return err;
            if (seen.has(m.capabilities[i].id)) return `capabilities[${i}].id duplicado: ${m.capabilities[i].id}`;
            seen.add(m.capabilities[i].id);
        }
    }

    if (m.keywords !== undefined) {
        if (!Array.isArray(m.keywords) || m.keywords.length > KEYWORDS_MAX) {
            return `manifest.keywords deve ser array de ate ${KEYWORDS_MAX}`;
        }
        const seenK = new Set<string>();
        for (const k of m.keywords) {
            if (typeof k !== 'string' || k.trim().length < 1 || k.length > KEYWORD_MAX_LEN) {
                return `keyword invalida: ${k}`;
            }
            const kk = k.toLowerCase();
            if (seenK.has(kk)) return `keyword duplicada: ${k}`;
            seenK.add(kk);
        }
    }

    if (typeof bundle.prompt !== 'string' || bundle.prompt.length < 1 || bundle.prompt.length > 8192) {
        return 'prompt deve ter 1-8192 chars';
    }

    if (!bundle.data || typeof bundle.data !== 'object' || Array.isArray(bundle.data)) {
        return 'data deve ser objeto';
    }
    for (const [key, value] of Object.entries(bundle.data)) {
        if (!DATA_KEY_RE.test(key)) return `chave de data invalida: ${key}`;
        if (typeof value !== 'string') return `data.${key} deve ser string (JSON serializado)`;
    }

    if (bundle.config?.refreshPolicy !== 'manual' && bundle.config?.refreshPolicy !== 'onconnect') {
        return 'config.refreshPolicy deve ser manual|onconnect';
    }
    return null;
}

/**
 * Builds a validated bundle from spell-derived inputs. Throws on invalid
 * input (caller-facing forja errors should be actionable, not silent).
 */
export function transmuteSpell(input: TransmuteInput): Bundle {
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.data ?? {})) {
        data[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    const capabilities = input.capabilities?.map((c) => ({ ...c, powers: [...c.powers], requires: [...c.requires] }));
    const keywords = normalizeKeywords(input.keywords);
    const bundle: Bundle = {
        manifest: {
            id: input.encId ?? generateEncantamentoId(),
            spellId: input.spellId,
            name: input.name,
            version: input.version ?? 1,
            requiredPowers: [...new Set([...(input.requiredPowers ?? []), ...(capabilities?.flatMap((c) => (c.status === 'granted' ? c.powers : [])) ?? [])])],
            createdAt: input.createdAt ?? Date.now(),
            ...(capabilities ? { capabilities } : {}),
            ...(keywords.length ? { keywords } : {}),
        },
        prompt: input.prompt,
        data,
        ...(input.dataSchemas ? { dataSchemas: input.dataSchemas } : {}),
        config: { refreshPolicy: 'manual' },
    };
    const err = validateBundle(bundle);
    if (err) throw new Error(`transmutacao invalida: ${err}`);
    return bundle;
}

// ============= The real forja (transmuteApp) =============

export interface MinimalSpellApp {
    id: number;
    name: string;
    /** HTML da spell (usado para contexto do prompt de voz). */
    code?: string;
    /** Descrição curta editável da Spell (contexto primário do encantamento). */
    description?: string;
    requiredCapabilities?: string[] | null;
}

/**
 * Contrato a partir de DADOS REAIS (app_storage/webview — ground truth):
 * campos presentes em >=50% dos itens = required; tipo = maioria observada.
 */
export function deriveSchemasFromData(
    data: Record<string, string>,
    keys?: string[],
): DataSchemas {
    const out: DataSchemas = {};
    const wanted = keys ?? Object.keys(data);
    for (const key of wanted) {
        const parsed = (() => {
            try {
                return JSON.parse(data[key] ?? '');
            } catch {
                return undefined;
            }
        })();
        if (Array.isArray(parsed)) {
            if (parsed.length === 0) continue;
            const items = parsed.filter(
                (it) => it && typeof it === 'object' && !Array.isArray(it),
            ) as Array<Record<string, unknown>>;
            if (!items.length) continue;
            const fields = new Set(items.flatMap((it) => Object.keys(it)));
            const required: Record<string, ContractFieldType> = {};
            const optional: Record<string, ContractFieldType> = {};
            for (const f of fields) {
                const present = items.filter((it) => f in it).length;
                const values = items.map((it) => (it as Record<string, unknown>)[f]).filter((v) => v !== undefined && v !== null);
                const types = new Set(values.map((v) => typeof v).filter((t) => t === 'string' || t === 'number' || t === 'boolean'));
                const t = (types.size === 1 ? [...types][0] : 'string') as ContractFieldType;
                // presente em TODOS os itens = required; parcial = optional
                (present === items.length ? required : optional)[f] = t;
            }
            if (Object.keys(required).length || Object.keys(optional).length) {
                out[key] = { type: 'array', item: { required, optional } };
            }
        } else if (parsed && typeof parsed === 'object') {
            const obj = parsed as Record<string, unknown>;
            const required: Record<string, ContractFieldType> = {};
            const optional: Record<string, ContractFieldType> = {};
            for (const [f, v] of Object.entries(obj)) {
                const t = (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
                    ? typeof v
                    : 'string') as ContractFieldType;
                (v === null || v === undefined ? optional : required)[f] = t;
            }
            if (Object.keys(required).length || Object.keys(optional).length) {
                out[key] = { type: 'object', required, optional };
            }
        }
    }
    return out;
}

/**
 * Contrato a partir do CÓDIGO da spell (estático, determinístico): localiza
 * literais de objeto criados para as chaves (var X = {...} usado com
 * setItem('<key>', JSON.stringify(...)) ou push na lista) e infere tipos dos
 * literais. Campos iniciados com null/undefined viram optional.
 */
export function deriveSchemasFromCode(code: string | undefined, keys: string[]): DataSchemas {
    const out: DataSchemas = {};
    if (!code) return out;

    const fieldRe = /^\s*['"]?([A-Za-z_]\w*)['"]?\s*:\s*(.{1,80})$/;

    // extrai o literal de objeto balanceado a partir do '{' em code[at]
    const takeObject = (at: number): string | null => {
        if (code[at] !== '{') return null;
        let depth = 0;
        for (let i = at; i < code.length; i++) {
            const ch = code[i];
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) return code.slice(at, i + 1);
            }
        }
        return null;
    };

    for (const key of keys) {
        // setItem('<key>', JSON.stringify(<var>)) — variação de aspas
        let listVar: string | null = null;
        for (const q of ["'", '"']) {
            const marker = `setItem(${q}${key}${q}, JSON.stringify(`;
            let at = code.indexOf(marker);
            while (at >= 0) {
                const rest = code.slice(at + marker.length);
                const m = /^\s*(\w+)\s*\)/.exec(rest);
                if (m) {
                    listVar = m[1];
                    break;
                }
                at = code.indexOf(marker, at + 1);
            }
            if (listVar) break;
        }
        if (!listVar) continue;

        // item anexado: <listVar>.push(<literal>) — literal balanceado
        let fieldsSrc: string | null = null;
        const pushMarker = `${listVar}.push(`;
        let pat = code.indexOf(pushMarker);
        while (pat >= 0 && !fieldsSrc) {
            const lit = takeObject(pat + pushMarker.length - 1);
            if (lit) {
                fieldsSrc = lit;
                break;
            }
            pat = code.indexOf(pushMarker, pat + 1);
        }
        // push de variável: acha o literal dela
        if (!fieldsSrc) {
            const pushVarRe = new RegExp(`${listVar}\\.push\\(\\s*(\\w+)\\s*\\)`);
            const mv = pushVarRe.exec(code);
            if (mv) {
                const varRe = new RegExp(`(?:var|let|const)\\s+${mv[1]}\\s*=\\s*\\{`);
                const braceAt = varRe.exec(code);
                if (braceAt) fieldsSrc = takeObject(code.indexOf('{', braceAt.index));
            }
        }
        if (!fieldsSrc) continue;

        // separa campos no nível superior do literal (vírgulas balanceadas)
        const body = fieldsSrc.slice(1, -1);
        const parts: string[] = [];
        let depth = 0;
        let cur = '';
        for (const ch of body) {
            if (ch === '{' || ch === '(' || ch === '[') depth++;
            else if (ch === '}' || ch === ')' || ch === ']') depth--;
            if (ch === ',' && depth === 0) {
                parts.push(cur);
                cur = '';
            } else {
                cur += ch;
            }
        }
        if (cur.trim()) parts.push(cur);

        const required: Record<string, ContractFieldType> = {};
        const optional: Record<string, ContractFieldType> = {};
        for (const part of parts) {
            const fm = fieldRe.exec(part.replace(/\n/g, ' '));
            if (!fm) continue;
            const name = fm[1];
            const v = fm[2].trim();
            let t: ContractFieldType = 'string';
            if (/^(true|false)$/.test(v)) t = 'boolean';
            else if (/^\d+(\.\d+)?$/.test(v) || /Date\.now\(\)/.test(v)) t = 'number';
            else if (/^(null|undefined)$/.test(v)) {
                optional[name] = 'string';
                continue;
            }
            required[name] = t;
        }
        if (Object.keys(required).length || Object.keys(optional).length) {
            out[key] = { type: 'array', item: { required, optional } };
        }
    }
    return out;
}

export interface TransmuteIO {
    /** Storage da spell (app_storage). Default: no-op (vazio). */
    getStorage?: (appId: number) => Promise<AppStorage[]>;
    /** Gerador do prompt de voz (chat OpenRouter). Default: prompt estático. */
    generatePrompt?: (app: MinimalSpellApp, dataKeys: string[]) => Promise<string>;
    /** Gerador do encantamento completo (prompt + keywords). Preferido. */
    generateEnchantment?: (app: MinimalSpellApp, dataKeys: string[]) => Promise<{
        prompt: string;
        keywords: string[];
        dataSchemas?: DataSchemas;
    }>;
    /** Contrato pronto (ex.: do preview da tela) — tem precedência sobre o gerador. */
    dataSchemas?: DataSchemas;
    now?: () => number;
    encId?: string;
    /** Overrides (ex.: edição do usuário antes de encantar). */
    promptOverride?: string;
    keywordsOverride?: string[];
    version?: number;
}

/** Prompt de voz padrão quando não há IA disponível. */
function fallbackPrompt(app: MinimalSpellApp, dataKeys: string[], description: string): string {
    const keys = dataKeys.length ? dataKeys.join(', ') : 'nenhum dado';
    const lang = getCurrentLanguage();
    const parts = [
        `Você é "${app.name}", um assistente de voz que vive num Familiar — um dispositivo ao lado do usuário.`,
        `O usuário FALA um comando em voz alta; você executa a tarefa correspondente sobre os dados que guarda (${keys}) e responde em voz alta, com frases curtas e naturais para alto-falante.`,
        `Quando o comando pedir uma mudança nesses dados, confirme e registre a mudança.`,
        `Idioma: responda no idioma do usuário — o código BCP-47 desse idioma é "${lang}".`,
    ];
    if (description) parts.splice(1, 0, `Esta spell serve para: ${description}`);
    return parts.join(' ');
}

/** Keywords de roteamento padrão (quando não há IA): nome + descrição + dados. */
function fallbackKeywords(app: MinimalSpellApp, dataKeys: string[], description: string): string[] {
    const nameWords = app.name
        .toLowerCase()
        .split(/[^a-zà-ú0-9]+/)
        .filter((w) => w.length >= 3);
    const descWords = description
        .toLowerCase()
        .split(/[^a-zà-ú0-9]+/)
        .filter((w) => w.length >= 3);
    return normalizeKeywords([...nameWords, ...descWords, ...dataKeys]);
}

/**
 * Texto visível aproximado de um HTML de spell — fallback de descrição quando a
 * Spell não tem `shortDescription`. Remove script/style/comentários, tira tags,
 * decodifica entidades comuns e colapsa espaços; capa em ~500 chars.
 */
export function extractTextFromHtml(code: string): string {
    let text = code
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ');
    text = text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
    return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}


/**
 * Semeia o `data` do encantamento a partir das chaves de localStorage que o
 * código da spell usa. Spell nova nunca rodou = app_storage vazio = encantamento
 * sem data = o protocolo de write-back (@@APPA) jamais entra no prompt. Extrai
 * `localStorage.getItem|setItem('chave')` e tenta inferir o literal default
 * (`getItem('k') ?? []`); sem literal, semeia `{}` (op "merge" é objeto).
 */
export function extractStorageKeys(code: string | undefined, max = 8): Record<string, string> {
    const out: Record<string, string> = {};
    if (!code) return out;
    const re = /localStorage\.(?:getItem|setItem)\(\s*['"]([A-Za-z0-9_.-]{1,64})['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null && Object.keys(out).length < max) {
        const key = m[1];
        if (key.startsWith('__') || key in out) continue;
        // Default imediatamente após a chave: `getItem('k') ?? '[]'` (literal
        // JSON entre aspas) ou `?? []`/`?? {}` (literal cru). Colado ao `??` —
        // nada de janela larga, que pegava literal de OUTRA linha.
        const rest = code.slice(re.lastIndex, re.lastIndex + 80);
        const quoted = rest.match(/^[)\s]*\?\?\s*'((?:[^'\\]|\\.)*)'/);
        const raw = quoted
            ? quoted[1]
            : rest.match(/^[)\s]*\?\?\s*(\[[^\]]*\]|\{[^}]*\})/)?.[1];
        const v = raw && /^[[{]/.test(raw.trim()) ? raw.trim() : '{}';
        out[key] = v;
    }
    return out;
}

export interface TransmuteAppResult {
    bundle: Bundle;
    mapping: ReturnType<typeof mapRequirements>;
    promptGeneratedByAI: boolean;
}

/**
 * Transmutes a real spell app into an encantamento bundle:
 * requirements → capability entries (permissionamento), app_storage → data,
 * IA BYOK → voice prompt.
 */
export async function transmuteApp(app: MinimalSpellApp, io: TransmuteIO = {}): Promise<TransmuteAppResult> {
    const mapping = mapRequirements(app.requiredCapabilities ?? []);

    const storage = io.getStorage ? await io.getStorage(app.id) : [];
    const data: Record<string, string> = extractStorageKeys(app.code);
    for (const item of storage) {
        // Value já é TEXT (string) no app_storage; blobs marcados ficam de fora.
        // Valores reais sobrescrevem as sementes extraídas do código.
        if (!DATA_KEY_RE.test(item.key)) continue;
        if (item.key.startsWith('__')) continue; // chaves internas (ex.: DOM snapshot)
        data[item.key] = item.value;
    }

    const description = app.description?.trim() || extractTextFromHtml(app.code ?? '');
    let prompt = fallbackPrompt(app, Object.keys(data), description);
    let keywords = fallbackKeywords(app, Object.keys(data), description);
    // Contrato por camadas: io (preview) > CÓDIGO (o que a spell cria e
    // renderiza — vence) > DADOS REAIS (podem estar contaminados por mutações
    // antigas fora do contrato) > gerador (refino, só chaves faltantes).
    const derivedData = deriveSchemasFromData(data, Object.keys(data));
    const derivedCode = deriveSchemasFromCode(app.code, Object.keys(data));
    let dataSchemas: DataSchemas | undefined;
    {
        const merged: DataSchemas = { ...derivedData, ...derivedCode };
        dataSchemas = Object.keys(merged).length ? merged : undefined;
    }
    let promptGeneratedByAI = false;
    if (io.generateEnchantment) {
        const gen = await io.generateEnchantment(app, Object.keys(data));
        if (gen?.prompt && gen.prompt.trim().length >= 40) {
            prompt = gen.prompt.trim().slice(0, 8192);
            promptGeneratedByAI = true;
        }
        if (gen?.keywords?.length) keywords = normalizeKeywords(gen.keywords);
        if (gen?.dataSchemas) {
            const merged: DataSchemas = { ...dataSchemas };
            for (const [k, v] of Object.entries(gen.dataSchemas)) {
                if (!merged[k]) merged[k] = v; // só chaves sem derivação determinística
            }
            dataSchemas = Object.keys(merged).length ? merged : dataSchemas;
        }
    } else if (io.generatePrompt) {
        const generated = await io.generatePrompt(app, Object.keys(data));
        if (generated && generated.trim().length >= 40) {
            prompt = generated.trim().slice(0, 8192);
            promptGeneratedByAI = true;
        }
    }
    // Edição do usuário tem prioridade sobre a geração automática.
    if (io.promptOverride && io.promptOverride.trim()) {
        prompt = io.promptOverride.trim().slice(0, 8192);
        promptGeneratedByAI = false;
    }
    if (io.keywordsOverride) keywords = normalizeKeywords(io.keywordsOverride);

    const bundle = transmuteSpell({
        encId: io.encId ?? encIdForSpell(app.id),
        spellId: `app_${app.id}`,
        name: app.name.slice(0, 64) || 'Encantamento',
        prompt,
        data,
        ...(io.dataSchemas ?? dataSchemas ? { dataSchemas: io.dataSchemas ?? dataSchemas } : {}),
        capabilities: mapping.entries,
        keywords,
        version: io.version,
    });
    return { bundle, mapping, promptGeneratedByAI };
}
