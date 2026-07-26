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
    | 'byok.error.parse'
    | 'byok.error.modelUnavailable';

export class OpenRouterError extends Error {
    readonly code: OpenRouterErrorCode;
    readonly status?: number;
    readonly retryable: boolean;
    /** Set when `code === 'byok.error.modelUnavailable'` so callers can surface the affected model in UI. */
    readonly modelId?: string;

    constructor(
        code: OpenRouterErrorCode,
        message: string,
        status?: number,
        retryable = false,
        modelId?: string,
    ) {
        super(message);
        this.name = 'OpenRouterError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.modelId = modelId;
    }
}

const MODEL_UNAVAILABLE_CODES = new Set([
    'model_not_found',
    'model_unavailable',
    'invalid_model',
]);
const MODEL_UNAVAILABLE_MSG_HINTS = ['not a valid model', 'does not exist', 'no endpoints found'];

function looksLikeModelUnavailable(bodyText: string): boolean {
    try {
        const parsed = JSON.parse(bodyText) as { error?: { code?: string; message?: string } };
        const code = parsed.error?.code;
        if (code && MODEL_UNAVAILABLE_CODES.has(code)) return true;
        const msg = (parsed.error?.message ?? '').toLowerCase();
        if (msg && MODEL_UNAVAILABLE_MSG_HINTS.some(h => msg.includes(h))) return true;
    } catch {
        // Non-JSON error body — fall through to substring check.
    }
    const lower = bodyText.toLowerCase();
    return MODEL_UNAVAILABLE_MSG_HINTS.some(h => lower.includes(h));
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
    plugins?: unknown[];
    extra?: Record<string, unknown>;
    signal?: AbortSignal;
    timeoutMs?: number;
    // Bypass OpenRouter's prompt cache for this call. Retries flip this to
    // `true` so a bad cached response (empty content, truncated JSON, etc.)
    // cannot re-serve itself and defeat the retry.
    noCache?: boolean;
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

async function buildHeaders(noCache?: boolean): Promise<Record<string, string>> {
    const key = await getOpenRouterKey();
    if (!key) {
        throw new OpenRouterError('byok.error.noKey', 'OpenRouter key is not configured');
    }
    return {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': APP_REFERRER,
        'X-Title': APP_TITLE,
        'X-OpenRouter-Cache': noCache ? 'false' : 'true',
    };
}

function mapHttpError(status: number, bodyText: string, modelId?: string): OpenRouterError {
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
    if (status === 404 || (status === 400 && looksLikeModelUnavailable(bodyText))) {
        return new OpenRouterError(
            'byok.error.modelUnavailable',
            `Model unavailable: ${snippet}`,
            status,
            false,
            modelId,
        );
    }
    if (status >= 500) {
        return new OpenRouterError('byok.error.upstream', `Upstream ${status}: ${snippet}`, status, true);
    }
    return new OpenRouterError('byok.error.upstream', `HTTP ${status}: ${snippet}`, status);
}

async function rawFetchOnce(
    path: string,
    body: object,
    opts: { signal?: AbortSignal; timeoutMs?: number; accept?: string; noCache?: boolean },
): Promise<Response> {
    const headers = await buildHeaders(opts.noCache);
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
            // User-cancelled aborts aren't retryable; timeouts (signaled via the
            // controller too) usually mean the upstream is wedged — also not
            // worth retrying since we already waited the full timeoutMs.
            throw new OpenRouterError('byok.error.aborted', 'Request aborted');
        }
        const msg = err instanceof Error ? err.message : 'network error';
        // Network failures are transient by nature — let withRetry try again.
        throw new OpenRouterError('byok.error.network', msg, undefined, true);
    }
    clearTimeout(timeout);

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        const modelId = (body as { model?: string }).model;
        throw mapHttpError(response.status, text, modelId);
    }
    return response;
}

// Retries for transient failures (429/5xx/network) are applied at the
// generators layer via `withRetry()` in `lib/api/generationUtils.ts`, which
// inspects `OpenRouterError.retryable`. Keeping the retry logic out of the
// HTTP layer avoids double-wrapping and lets callers opt out when needed.
const rawFetch = rawFetchOnce;

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
        plugins: req.plugins,
        usage: { include: true },
        ...req.extra,
    };

    const response = await rawFetch('/chat/completions', body, {
        signal: req.signal,
        timeoutMs: req.timeoutMs,
        noCache: req.noCache,
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
        plugins: req.plugins,
        stream: true,
        usage: { include: true },
        ...req.extra,
    };

    const response = await rawFetch('/chat/completions', body, {
        signal: req.signal,
        timeoutMs: req.timeoutMs,
        accept: 'text/event-stream',
        noCache: req.noCache,
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
        { signal: req.signal, timeoutMs: req.timeoutMs, noCache: true },
    );
    type ImagePart = { type?: string; image_url?: { url?: string }; data?: string };
    const json = (await response.json()) as {
        choices: Array<{
            message: {
                content?: string | ImagePart[];
                images?: ImagePart[];
            };
        }>;
        usage?: OpenRouterUsage;
    };

    const images: string[] = [];
    const message = json.choices?.[0]?.message;
    // Gemini nano-banana returns images in `message.images[]` (top-level, alongside a string content).
    if (Array.isArray(message?.images)) {
        for (const part of message.images) {
            if (part.image_url?.url) images.push(part.image_url.url);
            else if (part.data) images.push(part.data);
        }
    }
    // Legacy fallback: some models embed image parts in the content array.
    if (Array.isArray(message?.content)) {
        for (const part of message.content) {
            if (part.type === 'image_url' && part.image_url?.url) images.push(part.image_url.url);
            else if (part.data) images.push(part.data);
        }
    }
    if (images.length === 0) {
        throw new OpenRouterError('byok.error.parse', 'No image in generation response');
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
    // Gemini TTS via OpenRouter uses the dedicated `/audio/speech` endpoint and
    // returns raw PCM bytes (not JSON). We wrap the PCM in a WAV header so the
    // WebView `<audio>` element can play it back directly.
    //
    // Confirmed via live probe (2026-07-18): this endpoint accepts ONLY
    // response_format=pcm for Gemini TTS. `wav` returns 400 (Zod: expected
    // "mp3"|"pcm") and `mp3` returns 400 ("Gemini TTS only supports pcm").
    // Response Content-Type is `audio/pcm;rate=24000;channels=1`, matching the
    // constants in pcmToWav below.
    const response = await rawFetch(
        '/audio/speech',
        {
            model: req.model,
            input: req.text,
            voice: req.voice ?? 'Aoede',
            response_format: 'pcm',
        },
        { signal: req.signal, timeoutMs: req.timeoutMs },
    );
    const arrayBuffer = await response.arrayBuffer();
    const pcm = new Uint8Array(arrayBuffer);
    if (pcm.length === 0) {
        throw new OpenRouterError('byok.error.parse', 'Empty TTS response');
    }
    const wav = pcmToWav(pcm);
    return {
        audioBase64: bytesToBase64(wav),
        mimeType: 'audio/wav',
        // /audio/speech does not return `usage`; cost is estimated at the caller.
        usage: undefined,
    };
}

// Gemini TTS PCM: 24kHz, mono, 16-bit signed little-endian.
function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1, bitDepth = 16): Uint8Array {
    const dataSize = pcm.length;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    // "RIFF"
    view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46);
    view.setUint32(4, 36 + dataSize, true);
    // "WAVE"
    view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45);
    // "fmt "
    view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * (bitDepth / 8), true);
    view.setUint16(32, channels * (bitDepth / 8), true);
    view.setUint16(34, bitDepth, true);
    // "data"
    view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61);
    view.setUint32(40, dataSize, true);
    const bytes = new Uint8Array(buffer);
    bytes.set(pcm, 44);
    return bytes;
}

// Chunked to stay under String.fromCharCode.apply's stack-arg limit on Hermes.
function bytesToBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const end = Math.min(i + chunkSize, bytes.length);
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, end)));
    }
    return btoa(binary);
}

// ============= MUSIC =============

export interface MusicRequest {
    model: string;
    prompt: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface MusicResponse {
    audioBase64: string;
    mimeType: string;
    usage?: OpenRouterUsage;
}

/**
 * Music generation via OpenRouter's chat-completions with audio output
 * modality. Lyria (google/lyria-3-pro-preview) mandates `stream: true` on the
 * request whenever `modalities` includes `'audio'` — sending `stream: false`
 * returns HTTP 400 "Audio output requires stream: true", so we cannot drop
 * streaming at the request level regardless of the runtime.
 *
 * Hermes/RN 0.81 does not expose a real `ReadableStream` on `response.body`
 * (no `getReader`) — RN buffers the whole payload internally — so we always
 * read the SSE payload via `response.text()` and parse it with a single loop.
 * The parser tolerates SSE keep-alive comments (e.g. `: OPENROUTER PROCESSING`)
 * by only reacting to lines starting with `data:`, and swallows malformed
 * frames in a try/catch so a corrupt intermediate frame never aborts the
 * whole read. Usage arrives on the final `chat.completion.chunk` frame
 * (with `finish_reason: 'stop'`), not on a separate frame — we capture it
 * from any frame that carries a `usage` object.
 */
export async function generateMusic(req: MusicRequest): Promise<MusicResponse> {
    const body = {
        model: req.model,
        messages: [{ role: 'user' as const, content: req.prompt }],
        modalities: ['text', 'audio'],
        audio: { format: 'wav' },
        stream: true,
        usage: { include: true },
    };

    const response = await rawFetch('/chat/completions', body, {
        signal: req.signal,
        timeoutMs: req.timeoutMs ?? 240_000,
        accept: 'text/event-stream',
    });

    const raw = await response.text();
    let audioBase64 = '';
    let finalUsage: OpenRouterUsage | undefined;

    for (const line of raw.split('\n')) {
        const stripped = line.replace(/\r$/, '');
        if (!stripped.startsWith('data:')) continue;
        const payload = stripped.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const evt = JSON.parse(payload) as {
                choices?: Array<{ delta?: { audio?: { data?: string } } }>;
                usage?: OpenRouterUsage;
            };
            const chunk = evt.choices?.[0]?.delta?.audio?.data;
            if (chunk) audioBase64 += chunk;
            if (evt.usage) finalUsage = evt.usage;
        } catch {
            // Tolerate keep-alive comments and malformed frames.
        }
    }

    if (!audioBase64) throw new OpenRouterError('byok.error.parse', 'Empty music response');
    return { audioBase64, mimeType: 'audio/wav', usage: finalUsage };
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
        const url = req.inputImageBase64.startsWith('data:')
            ? req.inputImageBase64
            : `data:${req.inputImageBase64.startsWith('iVBOR') ? 'image/png' : 'image/jpeg'};base64,${req.inputImageBase64}`;
        body.input_references = [{ type: 'image_url', image_url: { url } }];
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
        data?: Array<{ url?: string }>;
        usage?: OpenRouterUsage;
    };
    if (json.status === 'failed' || json.status === 'cancelled' || json.status === 'expired') {
        throw new OpenRouterError('byok.error.upstream', `Video generation ${json.status}`);
    }
    if (json.status !== 'completed' && json.status !== 'succeeded') return null;

    // Prefer the signed URL exposed in `data[0].url` (no auth); fall back to the
    // authenticated content endpoint derived from the polling URL.
    const videoUrl = json.data?.[0]?.url;
    let downloadResponse: Response;
    if (videoUrl) {
        downloadResponse = await fetch(videoUrl, { signal });
    } else {
        const idMatch = pollingUrl.match(/\/videos\/([^/?#]+)/);
        if (!idMatch) {
            throw new OpenRouterError('byok.error.parse', 'Cannot derive video ID from polling URL');
        }
        const contentUrl = `${OR_BASE_URL}/videos/${idMatch[1]}/content?index=0`;
        downloadResponse = await fetch(contentUrl, { method: 'GET', headers, signal });
    }
    if (!downloadResponse.ok) {
        const text = await downloadResponse.text().catch(() => '');
        throw mapHttpError(downloadResponse.status, text);
    }
    const arrayBuffer = await downloadResponse.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length === 0) {
        throw new OpenRouterError('byok.error.parse', 'Empty video response');
    }
    return { videoBase64: bytesToBase64(bytes), usage: json.usage };
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
