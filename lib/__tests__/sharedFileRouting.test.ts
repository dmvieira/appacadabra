/**
 * @jest-environment jsdom
 *
 * Tests for lib/sharedFileRouting — the module that picks which
 * `<input type="file">` in the WebView receives a shared file, based on
 * each input's `accept` attribute.
 *
 * The bug this fixes: previously, a shared audio would land in the FIRST
 * file input in DOM order even if that input had `accept="image/*"`, because
 * the injected script used a naive `document.querySelector('input[type=file]')`.
 *
 * These tests exercise every accept-attribute shape a spell author might
 * realistically write (MIME wildcard, exact MIME, extension, mixed lists,
 * catch-all), and every share type the OS might hand us (image, audio, video,
 * PDF, ZIP, plus the frustrating `application/octet-stream` case that some
 * source apps like WhatsApp emit for otherwise-well-known files).
 */

import { matchesAccept, pickFileInputElement } from '../sharedFileRouting';

// ---------------------------------------------------------------------------
// matchesAccept — 20 rows, one per behavior we care about
// ---------------------------------------------------------------------------

describe('matchesAccept — positive cases', () => {
    it('matches image via MIME wildcard', () => {
        expect(matchesAccept('image/*', 'image/png', 'foto.png')).toBe(true);
    });

    it('matches image via exact MIME in a comma list', () => {
        expect(matchesAccept('image/png,image/jpeg', 'image/jpeg', 'foto.jpg')).toBe(true);
    });

    it('matches audio via MIME wildcard', () => {
        expect(matchesAccept('audio/*', 'audio/mpeg', 'song.mp3')).toBe(true);
    });

    it('matches audio via extension list', () => {
        expect(matchesAccept('.mp3,.wav', 'audio/mpeg', 'song.mp3')).toBe(true);
    });

    it('matches video via MIME wildcard', () => {
        expect(matchesAccept('video/*', 'video/mp4', 'clip.mp4')).toBe(true);
    });

    it('matches video via extension when MIME differs from extension family', () => {
        expect(matchesAccept('.mp4,.mov,.avi', 'video/quicktime', 'clip.mov')).toBe(true);
    });

    it('matches PDF via exact MIME', () => {
        expect(matchesAccept('application/pdf', 'application/pdf', 'doc.pdf')).toBe(true);
    });

    it('matches PDF via extension', () => {
        expect(matchesAccept('.pdf', 'application/pdf', 'doc.pdf')).toBe(true);
    });

    it('matches ZIP via exact MIME', () => {
        expect(matchesAccept('application/zip', 'application/zip', 'arch.zip')).toBe(true);
    });

    it('matches ZIP via extension in a mixed archive list', () => {
        expect(matchesAccept('.zip,.tar,.gz', 'application/zip', 'arch.zip')).toBe(true);
    });

    it('rescues generic application/octet-stream MP3 via .mp3 extension', () => {
        expect(matchesAccept('.mp3', 'application/octet-stream', 'song.mp3')).toBe(true);
    });

    it('rescues generic application/octet-stream ZIP via .zip extension', () => {
        expect(matchesAccept('.zip', 'application/octet-stream', 'arch.zip')).toBe(true);
    });

    it('catch-all */* matches anything', () => {
        expect(matchesAccept('*/*', 'application/x-obscure', 'weird.bin')).toBe(true);
    });

    it('empty accept is treated as catch-all', () => {
        expect(matchesAccept('', 'audio/mpeg', 'song.mp3')).toBe(true);
    });

    it('extension match is case-insensitive on fileName', () => {
        expect(matchesAccept('.png', 'image/png', 'FOTO.PNG')).toBe(true);
    });
});

describe('matchesAccept — negative cases', () => {
    it('audio share does not match image/*', () => {
        expect(matchesAccept('image/*', 'audio/mpeg', 'song.mp3')).toBe(false);
    });

    it('video share does not match image/*,audio/*', () => {
        expect(matchesAccept('image/*,audio/*', 'video/mp4', 'clip.mp4')).toBe(false);
    });

    it('PDF share does not match image/*', () => {
        expect(matchesAccept('image/*', 'application/pdf', 'doc.pdf')).toBe(false);
    });

    it('ZIP share does not match video/*', () => {
        expect(matchesAccept('video/*', 'application/zip', 'arch.zip')).toBe(false);
    });

    it('generic octet-stream with wrong extension does not match', () => {
        expect(matchesAccept('.mp3', 'application/octet-stream', 'foo.bin')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// pickFileInputElement — 12 realistic spell DOMs
// ---------------------------------------------------------------------------

function makeInputs(accepts: (string | null)[]): HTMLInputElement[] {
    document.body.innerHTML = '';
    return accepts.map(a => {
        const el = document.createElement('input');
        el.type = 'file';
        if (a !== null) el.setAttribute('accept', a);
        document.body.appendChild(el);
        return el;
    });
}

describe('pickFileInputElement — single input without accept', () => {
    it('accepts an image share', () => {
        const [only] = makeInputs([null]);
        expect(pickFileInputElement([only], 'image/png', 'foto.png')).toBe(only);
    });

    it('accepts an audio share', () => {
        const [only] = makeInputs([null]);
        expect(pickFileInputElement([only], 'audio/mpeg', 'song.mp3')).toBe(only);
    });

    it('accepts a video share', () => {
        const [only] = makeInputs([null]);
        expect(pickFileInputElement([only], 'video/mp4', 'clip.mp4')).toBe(only);
    });

    it('accepts a PDF share', () => {
        const [only] = makeInputs([null]);
        expect(pickFileInputElement([only], 'application/pdf', 'doc.pdf')).toBe(only);
    });

    it('accepts a ZIP share', () => {
        const [only] = makeInputs([null]);
        expect(pickFileInputElement([only], 'application/zip', 'arch.zip')).toBe(only);
    });
});

describe('pickFileInputElement — image/audio spell (the reported bug)', () => {
    it('image share picks the first (image) input', () => {
        const [img, aud] = makeInputs(['image/*', 'audio/*']);
        expect(pickFileInputElement([img, aud], 'image/png', 'foto.png')).toBe(img);
    });

    it('audio share picks the second (audio) input — the fix', () => {
        const [img, aud] = makeInputs(['image/*', 'audio/*']);
        expect(pickFileInputElement([img, aud], 'audio/mpeg', 'song.mp3')).toBe(aud);
    });
});

describe('pickFileInputElement — multi-type spell', () => {
    it('video share on [image/*, video/*] picks the video input', () => {
        const [img, vid] = makeInputs(['image/*', 'video/*']);
        expect(pickFileInputElement([img, vid], 'video/mp4', 'clip.mp4')).toBe(vid);
    });

    it('PDF share on [image/*, application/pdf] picks the PDF input', () => {
        const [img, pdf] = makeInputs(['image/*', 'application/pdf']);
        expect(pickFileInputElement([img, pdf], 'application/pdf', 'doc.pdf')).toBe(pdf);
    });

    it('ZIP share on [audio/*, video/*, application/pdf] returns null (no match)', () => {
        const inputs = makeInputs(['audio/*', 'video/*', 'application/pdf']);
        expect(pickFileInputElement(inputs, 'application/zip', 'arch.zip')).toBeNull();
    });

    it('PDF share on [image/*] returns null', () => {
        const inputs = makeInputs(['image/*']);
        expect(pickFileInputElement(inputs, 'application/pdf', 'doc.pdf')).toBeNull();
    });
});

describe('pickFileInputElement — extension-only accepts', () => {
    it('MP3 (with proper MIME) picks input with accept=".mp3,.wav"', () => {
        const inputs = makeInputs(['.mp3,.wav']);
        expect(pickFileInputElement(inputs, 'audio/mpeg', 'song.mp3')).toBe(inputs[0]);
    });

    it('ZIP (with proper MIME) picks input with accept=".pdf,.zip"', () => {
        const inputs = makeInputs(['.pdf,.zip']);
        expect(pickFileInputElement(inputs, 'application/zip', 'arch.zip')).toBe(inputs[0]);
    });
});

describe('pickFileInputElement — accept-less input as fallback', () => {
    it('[image/*, no-accept], PDF share → the no-accept input catches it', () => {
        const [img, any] = makeInputs(['image/*', null]);
        expect(pickFileInputElement([img, any], 'application/pdf', 'doc.pdf')).toBe(any);
    });

    it('[no-accept, image/*], PDF share → the no-accept input wins on DOM order', () => {
        const [any, img] = makeInputs([null, 'image/*']);
        expect(pickFileInputElement([any, img], 'application/pdf', 'doc.pdf')).toBe(any);
    });
});

describe('pickFileInputElement — no file inputs', () => {
    it('empty list returns null', () => {
        document.body.innerHTML = '';
        expect(pickFileInputElement([], 'image/png', 'foto.png')).toBeNull();
    });
});
