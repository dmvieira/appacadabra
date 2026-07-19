/**
 * @jest-environment jsdom
 *
 * Runs the DOM snapshot capture + restore scripts in a real jsdom document to
 * validate the full round-trip. The scripts are string blobs meant to be
 * evaluated inside a WebView — we use `Function` to execute them here in a
 * jsdom global that mimics the WebView bridge.
 */

import { createDomSnapshotScript, createDomSnapshotRestoreScript } from '../bridges/injectedJS';

interface CapturedMessage { type: string; data: string }

function withMockBridge(): CapturedMessage[] {
    const messages: CapturedMessage[] = [];
    (window as any).ReactNativeWebView = {
        postMessage: (msg: string) => {
            try { messages.push(JSON.parse(msg)); } catch { /* ignore */ }
        }
    };
    return messages;
}

function runScript(script: string) {
    // eslint-disable-next-line no-new-func
    new Function(script)();
}

function captureAndReturn(): string | null {
    const messages = withMockBridge();
    runScript(createDomSnapshotScript());
    const snap = messages.find(m => m.type === 'DOM_SNAPSHOT');
    return snap ? snap.data : null;
}

beforeEach(() => {
    document.body.innerHTML = '';
    try { sessionStorage.clear(); } catch { /* ignore */ }
    delete (window as any).__APPACADABRA_RESTORING__;
});

describe('DOM snapshot — capture', () => {
    it('serializes input, textarea, and checkbox values', () => {
        document.body.innerHTML = `
            <input id="name" type="text">
            <textarea id="notes"></textarea>
            <input id="agree" type="checkbox">
        `;
        (document.getElementById('name') as HTMLInputElement).value = 'Alice';
        (document.getElementById('notes') as HTMLTextAreaElement).value = 'Line1\nLine2';
        (document.getElementById('agree') as HTMLInputElement).checked = true;

        const raw = captureAndReturn();
        expect(raw).not.toBeNull();
        const snap = JSON.parse(raw!);
        const byId = (id: string) => snap.fields.find((f: any) => f.selector.includes(id));
        expect(byId('name').value).toBe('Alice');
        expect(byId('notes').value).toBe('Line1\nLine2');
        expect(byId('agree').checked).toBe(true);
    });

    it('skips password and file inputs to avoid persisting secrets or invalid paths', () => {
        document.body.innerHTML = `
            <input id="pw" type="password">
            <input id="file" type="file">
        `;
        (document.getElementById('pw') as HTMLInputElement).value = 'secret';

        const raw = captureAndReturn();
        const snap = JSON.parse(raw!);
        for (const f of snap.fields) {
            if (f.selector.includes('pw') || f.selector.includes('file')) {
                expect(f.value).toBeUndefined();
            }
        }
    });

    it('captures sessionStorage', () => {
        sessionStorage.setItem('foo', 'bar');
        sessionStorage.setItem('count', '42');

        const raw = captureAndReturn();
        const snap = JSON.parse(raw!);
        expect(snap.session.foo).toBe('bar');
        expect(snap.session.count).toBe('42');
    });

    it('captures contenteditable innerHTML', () => {
        document.body.innerHTML = `<div id="ed" contenteditable="true"><b>hi</b></div>`;
        const raw = captureAndReturn();
        const snap = JSON.parse(raw!);
        expect(snap.editable.length).toBe(1);
        expect(snap.editable[0].html).toContain('<b>hi</b>');
    });

    it('skips capture when a restore is already in progress', () => {
        (window as any).__APPACADABRA_RESTORING__ = true;
        const messages = withMockBridge();
        runScript(createDomSnapshotScript());
        expect(messages.length).toBe(0);
    });

    it('drops sessionStorage first when snapshot exceeds the 500KB cap', () => {
        // ~600KB of session data — should get dropped.
        const bigValue = 'x'.repeat(600_000);
        sessionStorage.setItem('big', bigValue);
        document.body.innerHTML = `<input id="tiny" type="text">`;
        (document.getElementById('tiny') as HTMLInputElement).value = 'kept';

        const raw = captureAndReturn();
        expect(raw).not.toBeNull();
        const snap = JSON.parse(raw!);
        expect(Object.keys(snap.session).length).toBe(0);
        expect(snap.fields.some((f: any) => f.value === 'kept')).toBe(true);
    });
});

describe('DOM snapshot — restore', () => {
    it('restores input values and dispatches change events', () => {
        document.body.innerHTML = `<input id="name" type="text">`;
        const raw = captureAndReturn();
        // Clear the DOM as if the WebView was recreated.
        document.body.innerHTML = `<input id="name" type="text">`;
        const input = document.getElementById('name') as HTMLInputElement;
        let changeFired = false;
        input.addEventListener('change', () => { changeFired = true; });
        (input as any).value = 'original';

        const snap = JSON.parse(raw!);
        snap.fields[0].value = 'restored';
        runScript(createDomSnapshotRestoreScript(JSON.stringify(snap)));

        return new Promise<void>(resolve => {
            setTimeout(() => {
                expect(input.value).toBe('restored');
                expect(changeFired).toBe(true);
                resolve();
            }, 80);
        });
    });

    it('ignores selectors that no longer match', () => {
        const snap = {
            fields: [{ selector: 'input#gone', tag: 'input', type: 'text', value: 'orphan' }],
            scrolls: [],
            windowScroll: { x: 0, y: 0 },
            session: {},
            editable: []
        };
        // No matching DOM node — should not throw.
        expect(() => runScript(createDomSnapshotRestoreScript(JSON.stringify(snap)))).not.toThrow();
    });

    it('restores sessionStorage', () => {
        const snap = {
            fields: [],
            scrolls: [],
            windowScroll: { x: 0, y: 0 },
            session: { theme: 'dark', locale: 'pt' },
            editable: []
        };
        runScript(createDomSnapshotRestoreScript(JSON.stringify(snap)));
        return new Promise<void>(resolve => {
            setTimeout(() => {
                expect(sessionStorage.getItem('theme')).toBe('dark');
                expect(sessionStorage.getItem('locale')).toBe('pt');
                resolve();
            }, 80);
        });
    });

    it('sets and clears __APPACADABRA_RESTORING__ around the restore', () => {
        runScript(createDomSnapshotRestoreScript(JSON.stringify({
            fields: [], scrolls: [], windowScroll: { x: 0, y: 0 }, session: {}, editable: []
        })));
        // Synchronously true immediately after entry.
        return new Promise<void>(resolve => {
            setTimeout(() => {
                expect((window as any).__APPACADABRA_RESTORING__).toBe(false);
                resolve();
            }, 80);
        });
    });

    it('tolerates malformed snapshot JSON without throwing', () => {
        expect(() => runScript(createDomSnapshotRestoreScript('not-json'))).not.toThrow();
    });
});
