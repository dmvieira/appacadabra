/**
 * OpenRouter HTTP client (Android/RN side, BYOK).
 *
 * Mirrors the server-side surface we used to hit through the OpenAI SDK in
 * `firebase/functions/src/index.ts`, but goes straight to OpenRouter from the
 * device. The user's key is read lazily from SecureStore on every request
 * (`keyStorage.getOpenRouterKey()`) — never cached at the module level — so
 * a heap dump catches the key for at most one request's lifetime.
 *
 * Transport:
 *   - `fetch` (Hermes/RN 0.81). SSE uses `response.body.getReader()` + a small
 *     line-buffered parser, no third-party dep. Streaming falls back to
 *     non-streaming if `body.getReader` isn't available on the running runtime.
 *
 * Attribution headers (`HTTP-Referer`, `X-Title`) identify the app to
 * OpenRouter — they're required for rank-and-route attribution and for the
 * activity dashboard to show "Appacadabra".
 *
 * Error mapping uses stable i18n keys (`byok.error.*`) so callers can show
 * localized messages without inspecting status codes.
 */

import { OR_BASE_URL } from './pricing';
import { getOpenRouterKey } from './keyStorage';

const APP_REFERRER = 'https://appacadabra.ai';
const APP_TITLE = 'Appacadabra';
const DEFAULT_TIMEOUT_MS = 480_000;

export type OpenRouterErrorCode =
    | 'byok.error.noKey'
    | 'byok.error.invalidKey'
    | 'byok.error.outOfCredit'
    | 'byok.error.rateLimited'
    | 'byok.error.upstream'
    | 'byok.error.network'
    | 'byok.error.aborted'
    | 'byok.error.parse';

export class OpenRouterError extends Error {
    readonly code: OpenRouterErrorCode;
    readonly status?: number;
    readonly retryable: boolean;

    constructor(code: OpenRouterErrorCode, message: string, status?: number, retryable = false) {
        super(message);
        this.name = 'OpenRouterError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | Array<{ type: string; [key: string]: unknown }>;
    name?: string;
    tool_call_id?: string;
}

export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
    response_format?: { type: 'json_object' | 'text' };
    reasoning?: { effort: 'low' | 'medium' | 'high' };
    tools?: unknown[];
    tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
    extra?: Record<string, unknown>;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface OpenRouterUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
    completion_tokens_details?: {
        reasoning_tokens?: number;
    };
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
}

export interface ChatResponse {
    id: string;
    model: string;
    choices: Array<{
        index: number;
        message: { role: string; content: string; tool_calls?: unknown[] };
        finish_reason: string;
    }>;
    usage?: OpenRouterUsage;
}

export interface ChatStreamDelta {
    type: 'delta' | 'usage' | 'done';
    text?: string;
    usage?: OpenRouterUsage;
}

// ============= INTERNAL =============

async function buildHeaders(): Promise<Record<string, string>> {
    const key = await getOpenRouterKey();
    if (!key) {
        throw new OpenRouterError('byok.error.noKey', 'OpenRouter key is not configured');
    }
    return {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': APP_REFERRER,
        'X-Title': APP_TITLE,
        'X-OpenRouter-Cache': 'true',
    };
}

function mapHttpError(status: number, bodyText: string): OpenRouterError {
    const snippet = bodyText.slice(0, 300);
    if (status === 401 || status === 403) {
        return new OpenRouterError('byok.error.invalidKey', `Auth rejected: ${snippet}`, status);
    }
    if (status === 402) {
        return new OpenRouterError('byok.error.outOfCredit', `Out of credit: ${snippet}`, status);
    }
    if (status === 429) {
        return new OpenRouterError('byok.error.rateLimited', `Rate limited: ${snippet}`, status, true);
    }
    if (status >= 500) {
        return new OpenRouterError('byok.error.upstream', `Upstream ${status}: ${snippet}`, status, true);
    }
    return new OpenRouterError('byok.error.upstream', `HTTP ${status}: ${snippet}`, status);
}

async function rawFetch(
    path: string,
    body: object,
    opts: { signal?: AbortSignal; timeoutMs?: number; accept?: string },
): Promise<Response> {
    const headers = await buildHeaders();
    if (opts.accept) headers.Accept = opts.accept;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (opts.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
        response = await fetch(`${OR_BASE_URL}${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        clearTimeout(timeout);
        if (controller.signal.aborted) {
            throw new OpenRouterError('byok.error.aborted', 'Request aborted');
        }
        const msg = err instanceof Error ? err.message : 'network error';
        throw new OpenRouterError('byok.error.network', msg);
    }
    clearTimeout(timeout);

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw mapHttpError(response.status, text);
    }
    return response;
}

// ============= CHAT (non-streaming) =============

export async function chat(req: ChatRequest): Promise<ChatResponse> {
    const body = {
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        response_format: req.response_format,
        reasoning: req.reasoning,
        tools: req.tools,
        tool_choice: req.tool_choice,
        usage: { include: true },
        ...req.extra,
    };

    const response = await rawFetch('/chat/completions', body, {
        signal: req.signal,
        timeoutMs: req.timeoutMs,
    });
    try {
        return (await response.json()) as ChatResponse;
    } catch {
        throw new OpenRouterError('byok.error.parse', 'Failed to parse chat response');
    }
}

// ============= CHAT (streaming via SSE) =============

/**
 * Streams `/chat/completions` with `stream: true`. Yields incremental deltas
 * and a final `{ type: 'usage', usage }` frame carrying `usage.cost`.
 *
 * Falls back to non-streaming and emits a single delta + usage if
 * `response.body.getReader` is not supported on this runtime.
 */
export async function* chatStream(req: ChatRequest): AsyncGenerator<ChatStreamDelta, void, void> {
    const body = {
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        response_format: req.response_format,
        reasoning: req.reasoning,
        tools: req.tools,
        tool_choice: req.tool_choice,
        stream: true,
        usage: { include: true },
        ...req.extra,
    };

    const response = await rawFetch('/chat/completions', body, {
        signal: req.signal,
        timeoutMs: req.timeoutMs,
        accept: 'text/event-stream',
    });

    const reader = response.body && typeof (response.body as ReadableStream).getReader === 'function'
        ? (response.body as ReadableStream<Uint8Array>).getReader()
        : null;

    if (!reader) {
        // Runtime missing streaming support — degrade gracefully.
        const fallback = await chat({ ...req, extra: { ...req.extra, stream: false } });
        const text = fallback.choices[0]?.message?.content ?? '';
        if (text) yield { type: 'delta', text };
        if (fallback.usage) yield { type: 'usage', usage: fallback.usage };
        yield { type: 'done' };
        return;
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finalUsage: OpenRouterUsage | undefined;

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let nlIdx: number;
            while ((nlIdx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nlIdx).replace(/\r$/, '');
                buffer = buffer.slice(nlIdx + 1);
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data) continue;
                if (data === '[DONE]') {
                    if (finalUsage) yield { type: 'usage', usage: finalUsage };
                    yield { type: 'done' };
                    return;
                }
                try {
                    const evt = JSON.parse(data) as {
                        choices?: Array<{ delta?: { content?: string } }>;
                        usage?: OpenRouterUsage;
                    };
                    const delta = evt.choices?.[0]?.delta?.content;
                    if (delta) yield { type: 'delta', text: delta };
                    if (evt.usage) finalUsage = evt.usage;
                } catch {
                    // Tolerate malformed SSE frames; OpenRouter occasionally
                    // sends keepalive comments or partial JSON across chunks.
                }
            }
        }
        if (finalUsage) yield { type: 'usage', usage: finalUsage };
        yield { type: 'done' };
    } finally {
        try { reader.releaseLock(); } catch { /* noop */ }
    }
}

// ============= IMAGE =============

export interface ImageGenerationRequest {
    model: string;
    prompt: string;
    referenceImagesBase64?: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface ImageGenerationResponse {
    images: string[]; // base64 data URLs or raw base64
    usage?: OpenRouterUsage;
}

/**
 * Image generation/editing via OpenRouter's chat completions surface
 * (Gemini image-preview accepts image inputs in `messages` and returns
 * a base64 image part). Mirrors how the server invokes these models today.
 */
export async function generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    const userParts: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }];
    for (const img of req.referenceImagesBase64 ?? []) {
        userParts.push({
            type: 'image_url',
            image_url: { url: img.startsWith('data:') ? img : `data:image/png;base64,${img}` },
        });
    }

    const response = await rawFetch(
        '/chat/completions',
        {
            model: req.model,
            messages: [{ role: 'user', content: userParts }],
            usage: { include: true },
        },
        { signal: req.signal, timeoutMs: req.timeoutMs },
    );
    const json = (await response.json()) as {
        choices: Array<{
            message: {
                content: string | Array<{ type: string; image_url?: { url: string }; data?: string }>;
            };
        }>;
        usage?: OpenRouterUsage;
    };

    const images: string[] = [];
    const content = json.choices?.[0]?.message?.content;
    if (Array.isArray(content)) {
        for (const part of content) {
            if (part.type === 'image_url' && part.image_url?.url) images.push(part.image_url.url);
            else if (part.data) images.push(part.data);
        }
    }
    return { images, usage: json.usage };
}

// ============= TTS =============

export interface TtsRequest {
    model: string;
    text: string;
    voice?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface TtsResponse {
    audioBase64: string;
    mimeType: string;
    usage?: OpenRouterUsage;
}

export async function tts(req: TtsRequest): Promise<TtsResponse> {
    const response = await rawFetch(
        '/chat/completions',
        {
            model: req.model,
            messages: [{ role: 'user', content: req.text }],
            modalities: ['audio'],
            audio: req.voice ? { voice: req.voice, format: 'wav' } : { format: 'wav' },
            usage: { include: true },
        },
        { signal: req.signal, timeoutMs: req.timeoutMs },
    );
    const json = (await response.json()) as {
        choices: Array<{ message: { audio?: { data?: string; format?: string } } }>;
        usage?: OpenRouterUsage;
    };
    const audio = json.choices?.[0]?.message?.audio;
    if (!audio?.data) {
        throw new OpenRouterError('byok.error.parse', 'No audio in TTS response');
    }
    return {
        audioBase64: audio.data,
        mimeType: audio.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
        usage: json.usage,
    };
}

// ============= VIDEO (submit + poll) =============

export interface VideoRequest {
    model: string;
    prompt: string;
    durationSeconds?: number;
    inputImageBase64?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface VideoSubmission {
    id: string;
    pollingUrl: string;
}

export interface VideoResult {
    videoUrl?: string;
    videoBase64?: string;
    usage?: OpenRouterUsage;
}

export async function submitVideo(req: VideoRequest): Promise<VideoSubmission> {
    const body: Record<string, unknown> = {
        model: req.model,
        prompt: req.prompt,
        duration_seconds: req.durationSeconds,
    };
    if (req.inputImageBase64) {
        body.input_image = req.inputImageBase64.startsWith('data:')
            ? req.inputImageBase64
            : `data:image/png;base64,${req.inputImageBase64}`;
    }
    const response = await rawFetch('/videos', body, {
        signal: req.signal,
        timeoutMs: req.timeoutMs,
    });
    const json = (await response.json()) as { id: string; polling_url?: string };
    return { id: json.id, pollingUrl: json.polling_url ?? `${OR_BASE_URL}/videos/${json.id}/status` };
}

export async function pollVideo(pollingUrl: string, signal?: AbortSignal): Promise<VideoResult | null> {
    const headers = await buildHeaders();
    const response = await fetch(pollingUrl, { method: 'GET', headers, signal });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw mapHttpError(response.status, text);
    }
    const json = (await response.json()) as {
        status: string;
        video_url?: string;
        video_base64?: string;
        usage?: OpenRouterUsage;
    };
    if (json.status !== 'completed' && json.status !== 'succeeded') return null;
    return { videoUrl: json.video_url, videoBase64: json.video_base64, usage: json.usage };
}

// ============= EMBEDDINGS =============

export interface EmbedRequest {
    model: string;
    input: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface EmbedResponse {
    vectors: number[][];
    usage?: OpenRouterUsage;
}

export async function embed(req: EmbedRequest): Promise<EmbedResponse> {
    const response = await rawFetch(
        '/embeddings',
        { model: req.model, input: req.input, usage: { include: true } },
        { signal: req.signal, timeoutMs: req.timeoutMs },
    );
    const json = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
        usage?: OpenRouterUsage;
    };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return { vectors: sorted.map(d => d.embedding), usage: json.usage };
}

// ============= AUTH TEST (Settings > Test Key) =============

export interface AuthCheck {
    valid: boolean;
    label?: string;
    creditLimit?: number;
    usage?: number;
    isFreeTier?: boolean;
}

/**
 * Calls `GET /auth/key` to validate the configured key and surface remaining
 * credit. Settings screen renders this as idle/loading/valid/invalid/no-credit.
 */
export async function checkAuth(signal?: AbortSignal): Promise<AuthCheck> {
    const headers = await buildHeaders();
    let response: Response;
    try {
        response = await fetch(`${OR_BASE_URL}/auth/key`, { method: 'GET', headers, signal });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'network error';
        throw new OpenRouterError('byok.error.network', msg);
    }
    if (response.status === 401 || response.status === 403) {
        return { valid: false };
    }
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw mapHttpError(response.status, text);
    }
    const json = (await response.json()) as {
        data?: {
            label?: string;
            limit?: number;
            usage?: number;
            is_free_tier?: boolean;
        };
    };
    const d = json.data ?? {};
    return {
        valid: true,
        label: d.label,
        creditLimit: d.limit,
        usage: d.usage,
        isFreeTier: d.is_free_tier,
    };
}
