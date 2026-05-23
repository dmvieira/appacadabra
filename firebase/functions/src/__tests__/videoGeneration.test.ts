import { submitVideoJob, pollAndDownloadVideo } from '../videoJob';
import { OR_BASE_URL } from '../config';

const FAKE_KEY = 'test-api-key';
const POLLING_URL = 'https://openrouter.ai/api/v1/videos/v1/status';
const SUBMIT_RESPONSE = { id: 'v1', polling_url: POLLING_URL };

function mockFetch(...responses: Array<{ ok: boolean; json?: object; text?: string; arrayBuffer?: ArrayBuffer }>) {
    let call = 0;
    return jest.spyOn(global, 'fetch').mockImplementation(async () => {
        const resp = responses[Math.min(call++, responses.length - 1)];
        return {
            ok: resp.ok,
            status: resp.ok ? 200 : 404,
            json: async () => resp.json ?? {},
            text: async () => resp.text ?? '',
            arrayBuffer: async () => resp.arrayBuffer ?? new ArrayBuffer(0),
            headers: { get: () => null },
        } as unknown as Response;
    });
}

afterEach(() => jest.restoreAllMocks());

// ---- submitVideoJob ----

describe('submitVideoJob', () => {
    it('posts to /api/v1/videos (not /videos/generations)', async () => {
        const spy = mockFetch({ ok: true, json: SUBMIT_RESPONSE });
        await submitVideoJob('hello', [], 'google/veo-3.1-fast', FAKE_KEY);
        expect(spy).toHaveBeenCalledWith(
            `${OR_BASE_URL}/videos`,
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('text-only: body has no input_references', async () => {
        const spy = mockFetch({ ok: true, json: SUBMIT_RESPONSE });
        await submitVideoJob('hello', [], 'google/veo-3.1-fast', FAKE_KEY);
        const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
        expect(body).not.toHaveProperty('input_references');
        expect(body.prompt).toBe('hello');
    });

    it('single image: body uses input_references with the provided HTTPS URL', async () => {
        const spy = mockFetch({ ok: true, json: SUBMIT_RESPONSE });
        const imageUrl = 'https://storage.googleapis.com/bucket/video_refs/uid/job_ref0.jpg?alt=media&token=abc';
        await submitVideoJob('hello', [imageUrl], 'google/veo-3.1-fast', FAKE_KEY);
        const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
        expect(body.input_references).toHaveLength(1);
        expect(body.input_references[0].type).toBe('image_url');
        expect(body.input_references[0].image_url.url).toBe(imageUrl);
    });

    it('multiple images: all passed as input_references', async () => {
        const spy = mockFetch({ ok: true, json: SUBMIT_RESPONSE });
        const urls = [
            'https://storage.googleapis.com/bucket/ref0.jpg',
            'https://storage.googleapis.com/bucket/ref1.jpg',
            'https://storage.googleapis.com/bucket/ref2.jpg',
        ];
        await submitVideoJob('hello', urls, 'google/veo-3.1-fast', FAKE_KEY);
        const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
        expect(body.input_references).toHaveLength(3);
        urls.forEach((url, i) => {
            expect(body.input_references[i].image_url.url).toBe(url);
        });
    });

    it('throws on non-ok response', async () => {
        mockFetch({ ok: false, text: 'Not Found' });
        await expect(submitVideoJob('p', [], 'm', FAKE_KEY)).rejects.toThrow('Video submit failed: 404');
    });
});

// ---- pollAndDownloadVideo ----

const MP4_MAGIC = Buffer.from('0000002066747970', 'hex'); // valid ftyp

describe('pollAndDownloadVideo', () => {
    it('polls using the provided polling_url', async () => {
        const spy = mockFetch(
            { ok: true, json: { status: 'completed', data: [{ url: 'https://cdn.example.com/v.mp4' }] } },
            { ok: true, arrayBuffer: MP4_MAGIC.buffer },
        );
        await pollAndDownloadVideo('v1', POLLING_URL, FAKE_KEY, 1, 0);
        expect(spy.mock.calls[0][0]).toBe(POLLING_URL);
    });

    it('falls back to content endpoint when data has no url', async () => {
        const spy = mockFetch(
            { ok: true, json: { status: 'completed', data: [{}] } },
            { ok: true, arrayBuffer: MP4_MAGIC.buffer },
        );
        await pollAndDownloadVideo('v1', POLLING_URL, FAKE_KEY, 1, 0);
        const downloadUrl = spy.mock.calls[1][0] as string;
        expect(downloadUrl).toBe(`${OR_BASE_URL}/videos/v1/content?index=0`);
    });

    it('throws on failed status', async () => {
        mockFetch({ ok: true, json: { status: 'failed' } });
        await expect(
            pollAndDownloadVideo('v1', POLLING_URL, FAKE_KEY, 5, 0),
        ).rejects.toThrow('Video generation failed');
    });

    it('throws on cancelled status', async () => {
        mockFetch({ ok: true, json: { status: 'cancelled' } });
        await expect(
            pollAndDownloadVideo('v1', POLLING_URL, FAKE_KEY, 5, 0),
        ).rejects.toThrow('Video generation cancelled');
    });

    it('throws after poll limit exhausted', async () => {
        mockFetch({ ok: true, json: { status: 'in_progress' } });
        await expect(
            pollAndDownloadVideo('v1', POLLING_URL, FAKE_KEY, 3, 0),
        ).rejects.toThrow('timed out');
    });
});
