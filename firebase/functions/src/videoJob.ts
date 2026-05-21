import { OR_BASE_URL } from './config';

export async function submitVideoJob(
    prompt: string,
    imageUrl: string | undefined,
    model: string,
    apiKey: string,
): Promise<{ id: string; polling_url: string }> {
    const body: Record<string, unknown> = { model, prompt };
    if (imageUrl) {
        body.input_references = [{
            type: 'image_url',
            image_url: { url: imageUrl },
        }];
    }

    const r = await fetch(`${OR_BASE_URL}/videos`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Video submit failed: ${r.status} ${await r.text()}`);
    return r.json() as Promise<{ id: string; polling_url: string }>;
}

export async function pollAndDownloadVideo(
    jobId: string,
    pollingUrl: string,
    apiKey: string,
    maxPolls = 60,
    pollIntervalMs = 30000,
    onPoll?: (poll: number, max: number) => void,
): Promise<Buffer> {
    let videoUrl: string | undefined;
    let completed = false;

    for (let poll = 0; poll < maxPolls; poll++) {
        onPoll?.(poll + 1, maxPolls);
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        const r = await fetch(pollingUrl, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!r.ok) throw new Error(`Video poll failed: ${r.status}`);

        const status = await r.json() as { status: string; data?: Array<{ url?: string }> };
        if (status.status === 'completed') {
            videoUrl = status.data?.[0]?.url;
            completed = true;
            break;
        }
        if (['failed', 'cancelled', 'expired'].includes(status.status))
            throw new Error(`Video generation ${status.status}`);
    }

    if (!completed) throw new Error('Video generation timed out after polling limit');

    const downloadTarget = videoUrl ?? `${OR_BASE_URL}/videos/${jobId}/content?index=0`;
    const headers: HeadersInit | undefined = videoUrl ? undefined : { 'Authorization': `Bearer ${apiKey}` };
    const dl = await fetch(downloadTarget, headers ? { headers } : undefined);
    if (!dl.ok) throw new Error(`Video download failed: ${dl.status}`);

    const buf = Buffer.from(await dl.arrayBuffer());
    if (!buf.length) throw new Error('Video generation returned empty data');
    return buf;
}
