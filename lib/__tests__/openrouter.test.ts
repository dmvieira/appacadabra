/**
 * Tests for the OpenRouter HTTP client. We mock `fetch` and the keyStorage
 * wrapper directly; the real device transport (Hermes fetch + SSE) is
 * exercised by the Maestro flows downstream.
 */

jest.mock('../api/keyStorage', () => ({
    getOpenRouterKey: jest.fn(),
}));

import * as keyStorage from '../api/keyStorage';
import {
    chat,
    chatStream,
    checkAuth,
    tts,
    OpenRouterError,
} from '../api/openrouter';

const mockedGetKey = keyStorage.getOpenRouterKey as jest.MockedFunction<typeof keyStorage.getOpenRouterKey>;

function jsonResponse(body: object, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    }) as Response;
}

function textErrorResponse(text: string, status: number): Response {
    return new Response(text, { status }) as Response;
}

beforeEach(() => {
    mockedGetKey.mockReset();
    (global as any).fetch = jest.fn();
});

describe('openrouter.chat', () => {
    beforeEach(() => {
        mockedGetKey.mockResolvedValue('sk-or-v1-test-key');
    });

    it('throws byok.error.noKey when no key is configured', async () => {
        mockedGetKey.mockResolvedValueOnce(null);
        await expect(
            chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
        ).rejects.toMatchObject({ code: 'byok.error.noKey' });
    });

    it('includes Authorization Bearer, HTTP-Referer, and X-Title headers', async () => {
        (global as any).fetch = jest.fn().mockResolvedValue(
            jsonResponse({ id: 'x', model: 'm', choices: [], usage: undefined }),
        );
        await chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
        const args = ((global as any).fetch as jest.Mock).mock.calls[0];
        expect(args[1].headers.Authorization).toBe('Bearer sk-or-v1-test-key');
        expect(args[1].headers['HTTP-Referer']).toBeDefined();
        expect(args[1].headers['X-Title']).toBeDefined();
    });

    it('sets usage.include=true so cost comes back on the response', async () => {
        (global as any).fetch = jest.fn().mockResolvedValue(
            jsonResponse({ id: 'x', model: 'm', choices: [], usage: undefined }),
        );
        await chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
        const sent = JSON.parse(((global as any).fetch as jest.Mock).mock.calls[0][1].body);
        expect(sent.usage).toEqual({ include: true });
    });

    it.each([
        [401, 'byok.error.invalidKey'],
        [403, 'byok.error.invalidKey'],
        [402, 'byok.error.outOfCredit'],
        [429, 'byok.error.rateLimited'],
        [500, 'byok.error.upstream'],
        [503, 'byok.error.upstream'],
    ])('maps HTTP %i to %s', async (status, expectedCode) => {
        (global as any).fetch = jest.fn().mockResolvedValue(textErrorResponse('err', status));
        try {
            await chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
            fail('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(OpenRouterError);
            expect((e as OpenRouterError).code).toBe(expectedCode);
        }
    });

    it('marks 429 and 5xx as retryable so callers can back off', async () => {
        const cases = [429, 500, 502, 503];
        for (const status of cases) {
            (global as any).fetch = jest.fn().mockResolvedValue(textErrorResponse('x', status));
            try {
                await chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
            } catch (e) {
                expect((e as OpenRouterError).retryable).toBe(true);
            }
        }
    });

    it('returns parsed body on success', async () => {
        const body = {
            id: 'cmpl_1',
            model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cost: 0.0002 },
        };
        (global as any).fetch = jest.fn().mockResolvedValue(jsonResponse(body));
        const out = await chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
        expect(out.choices[0].message.content).toBe('hi');
        expect(out.usage?.cost).toBe(0.0002);
    });
});

describe('openrouter.chatStream', () => {
    beforeEach(() => {
        mockedGetKey.mockResolvedValue('sk-or-v1-test-key');
    });

    function streamResponse(chunks: string[]): Response {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const c of chunks) controller.enqueue(encoder.encode(c));
                controller.close();
            },
        });
        return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        }) as Response;
    }

    it('emits text deltas, a final usage frame, and a done marker', async () => {
        const sse = [
            `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n`,
            `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n`,
            `data: {"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3,"cost":0.0001}}\n\n`,
            `data: [DONE]\n\n`,
        ];
        (global as any).fetch = jest.fn().mockResolvedValue(streamResponse(sse));

        const events: Array<{ type: string; text?: string; usage?: any }> = [];
        for await (const evt of chatStream({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
        })) {
            events.push(evt);
        }
        const text = events.filter(e => e.type === 'delta').map(e => e.text).join('');
        expect(text).toBe('Hello');
        expect(events.some(e => e.type === 'usage' && e.usage?.cost === 0.0001)).toBe(true);
        expect(events[events.length - 1].type).toBe('done');
    });

    it('tolerates malformed JSON frames without aborting the stream', async () => {
        const sse = [
            `data: {"choices":[{"delta":{"content":"A"}}]}\n\n`,
            `data: this is not json\n\n`,
            `data: {"choices":[{"delta":{"content":"B"}}]}\n\n`,
            `data: [DONE]\n\n`,
        ];
        (global as any).fetch = jest.fn().mockResolvedValue(streamResponse(sse));
        let combined = '';
        for await (const evt of chatStream({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
        })) {
            if (evt.type === 'delta') combined += evt.text;
        }
        expect(combined).toBe('AB');
    });
});

describe('openrouter.tts', () => {
    beforeEach(() => {
        mockedGetKey.mockResolvedValue('sk-or-v1-test-key');
    });

    function binaryResponse(bytes: Uint8Array): Response {
        // Response's TS lib.d.ts doesn't include Uint8Array in BodyInit even
        // though the runtime accepts it — pass the underlying ArrayBuffer.
        return new Response(bytes.buffer as ArrayBuffer, {
            status: 200,
            headers: { 'Content-Type': 'audio/pcm;rate=24000;channels=1' },
        }) as Response;
    }

    // Small helper: decode a base64 → bytes so tests can inspect the WAV header.
    function b64ToBytes(b64: string): Uint8Array {
        const bin = Buffer.from(b64, 'base64');
        return new Uint8Array(bin);
    }

    it('POSTs to /audio/speech with response_format=pcm', async () => {
        // Confirmed via live probe (2026-07-18): `/audio/speech` accepts ONLY
        // `pcm` for Gemini TTS — asking for `wav` or `mp3` returns HTTP 400.
        // A prior attempt to send `wav` triggered the Speech.speak fallback in
        // AUDIO_SPEAK_AI because the endpoint rejected the request before any
        // audio bytes came back.
        (global as any).fetch = jest.fn().mockResolvedValue(binaryResponse(new Uint8Array(48000)));
        await tts({ model: 'google/gemini-3.1-flash-tts-preview', text: 'hello' });
        const args = ((global as any).fetch as jest.Mock).mock.calls[0];
        expect(args[0]).toContain('/audio/speech');
        const sent = JSON.parse(args[1].body);
        expect(sent.response_format).toBe('pcm');
        expect(sent.input).toBe('hello');
        expect(sent.voice).toBe('Aoede');
    });

    it('wraps PCM bytes with a valid WAV header (RIFF/WAVE, 24kHz mono 16-bit)', async () => {
        // OpenRouter returns raw PCM; we must prepend a 44-byte RIFF header
        // before handing the base64 to the WebView `<audio>` element or to
        // expo-av's Audio.Sound.createAsync. Constants (24kHz/mono/16-bit LE)
        // come from the endpoint's own Content-Type header on live responses.
        const pcm = new Uint8Array(1000); // 1000 zero-bytes as fake PCM payload
        (global as any).fetch = jest.fn().mockResolvedValue(binaryResponse(pcm));

        const out = await tts({ model: 'm', text: 'hi' });
        expect(out.mimeType).toBe('audio/wav');

        const wav = b64ToBytes(out.audioBase64);
        expect(wav.length).toBe(44 + pcm.length);
        // "RIFF"
        expect(Array.from(wav.slice(0, 4))).toEqual([0x52, 0x49, 0x46, 0x46]);
        // "WAVE"
        expect(Array.from(wav.slice(8, 12))).toEqual([0x57, 0x41, 0x56, 0x45]);
        // "fmt "
        expect(Array.from(wav.slice(12, 16))).toEqual([0x66, 0x6d, 0x74, 0x20]);
        // channels (offset 22, uint16 LE) = 1
        const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
        expect(view.getUint16(22, true)).toBe(1);
        // sample rate (offset 24, uint32 LE) = 24000
        expect(view.getUint32(24, true)).toBe(24000);
        // bit depth (offset 34, uint16 LE) = 16
        expect(view.getUint16(34, true)).toBe(16);
        // "data" chunk id
        expect(Array.from(wav.slice(36, 40))).toEqual([0x64, 0x61, 0x74, 0x61]);
        // data size (offset 40) matches pcm length
        expect(view.getUint32(40, true)).toBe(pcm.length);
    });

    it('throws byok.error.parse when the response body is empty', async () => {
        (global as any).fetch = jest.fn().mockResolvedValue(binaryResponse(new Uint8Array(0)));
        await expect(tts({ model: 'm', text: 'hi' })).rejects.toMatchObject({
            code: 'byok.error.parse',
        });
    });
});

describe('openrouter.checkAuth', () => {
    beforeEach(() => {
        mockedGetKey.mockResolvedValue('sk-or-v1-test-key');
    });

    it('reports valid + remaining credit on success', async () => {
        (global as any).fetch = jest.fn().mockResolvedValue(
            jsonResponse({ data: { label: 'My key', limit: 10, usage: 3, is_free_tier: false } }),
        );
        const out = await checkAuth();
        expect(out.valid).toBe(true);
        expect(out.label).toBe('My key');
        expect(out.creditLimit).toBe(10);
        expect(out.usage).toBe(3);
    });

    it('reports invalid (not throws) for 401', async () => {
        (global as any).fetch = jest.fn().mockResolvedValue(textErrorResponse('x', 401));
        const out = await checkAuth();
        expect(out.valid).toBe(false);
    });

    it('throws byok.error.network when fetch rejects', async () => {
        (global as any).fetch = jest.fn().mockRejectedValue(new Error('network down'));
        await expect(checkAuth()).rejects.toMatchObject({ code: 'byok.error.network' });
    });
});
