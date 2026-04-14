import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import { marked } from 'marked';
import { createCallbackScript } from './mediaHelpers';
import { requestGoogleScopes } from '../firebase';
import { CapabilityModule, HandlerContext, HandlerResult, WebViewRef } from './types';

// ============= Google Docs Helpers =============

function parseInlineStyles(text: string): Array<{ text: string; bold: boolean; italic: boolean }> {
    const segments: Array<{ text: string; bold: boolean; italic: boolean }> = [];
    const re = /(\*\*(.+?)\*\*)|(\*(.+?)\*)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        if (match.index > lastIndex) {
            segments.push({ text: text.slice(lastIndex, match.index), bold: false, italic: false });
        }
        if (match[1]) {
            segments.push({ text: match[2], bold: true, italic: false });
        } else if (match[3]) {
            segments.push({ text: match[4], bold: false, italic: true });
        }
        lastIndex = re.lastIndex;
    }
    if (lastIndex < text.length) {
        segments.push({ text: text.slice(lastIndex), bold: false, italic: false });
    }
    return segments.filter(s => s.text.length > 0);
}

function buildDocsRequests(markdownText: string, startIndex: number): { requests: any[]; endIndex: number } {
    const lines = markdownText.split('\n');
    const requests: any[] = [];
    let cursor = startIndex;

    for (const rawLine of lines) {
        let lineText = rawLine;
        let paragraphStyle: string | null = null;
        let isBullet = false;

        if (lineText.startsWith('### ')) {
            paragraphStyle = 'HEADING_3';
            lineText = lineText.slice(4);
        } else if (lineText.startsWith('## ')) {
            paragraphStyle = 'HEADING_2';
            lineText = lineText.slice(3);
        } else if (lineText.startsWith('# ')) {
            paragraphStyle = 'HEADING_1';
            lineText = lineText.slice(2);
        } else if (lineText.startsWith('- ')) {
            isBullet = true;
            lineText = lineText.slice(2);
        }

        const lineStart = cursor;
        const segments = parseInlineStyles(lineText);

        for (const seg of segments) {
            requests.push({ insertText: { location: { index: cursor }, text: seg.text } });
            if (seg.bold || seg.italic) {
                requests.push({
                    updateTextStyle: {
                        range: { startIndex: cursor, endIndex: cursor + seg.text.length },
                        textStyle: { bold: seg.bold, italic: seg.italic },
                        fields: seg.bold && seg.italic ? 'bold,italic' : seg.bold ? 'bold' : 'italic',
                    },
                });
            }
            cursor += seg.text.length;
        }

        requests.push({ insertText: { location: { index: cursor }, text: '\n' } });
        cursor += 1;

        if (paragraphStyle) {
            requests.push({
                updateParagraphStyle: {
                    range: { startIndex: lineStart, endIndex: cursor },
                    paragraphStyle: { namedStyleType: paragraphStyle },
                    fields: 'namedStyleType',
                },
            });
        }

        if (isBullet) {
            requests.push({
                createParagraphBullets: {
                    range: { startIndex: lineStart, endIndex: cursor },
                    bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
                },
            });
        }
    }

    return { requests, endIndex: cursor };
}

function docsToMarkdown(doc: any): string {
    const bodyContent: any[] = doc.body?.content || [];
    const lines: string[] = [];

    for (const section of bodyContent) {
        const para = section.paragraph;
        if (!para) continue;

        const styleType: string = para.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
        const hasBullet = !!para.bullet;

        let prefix = '';
        if (styleType === 'HEADING_1') prefix = '# ';
        else if (styleType === 'HEADING_2') prefix = '## ';
        else if (styleType === 'HEADING_3') prefix = '### ';
        else if (hasBullet) prefix = '- ';

        let lineText = '';
        for (const el of (para.elements || [])) {
            const run = el.textRun;
            if (!run) continue;
            let content: string = run.content || '';
            content = content.replace(/\n$/, '');
            if (!content) continue;
            const bold = run.textStyle?.bold ?? false;
            const italic = run.textStyle?.italic ?? false;
            if (bold && italic) content = `**_${content}_**`;
            else if (bold) content = `**${content}**`;
            else if (italic) content = `*${content}*`;
            lineText += content;
        }

        lines.push(prefix + lineText);
    }

    return lines.join('\n').replace(/\n+$/, '');
}

// ── Module-level state ────────────────────────────────────────────────────────

interface DocSnapshot { title: string; content: string; }

interface DocWatcher {
    interval: ReturnType<typeof setInterval>;
    webViewRef: WebViewRef;
    callbackName: string;
    snapshot: DocSnapshot | null;
}

export const activeWatchers = new Map<string, DocWatcher>();
export const resourceCache = new Map<string, DocSnapshot>();

interface PendingWrite { execute: () => Promise<void>; }
export const writeQueue: PendingWrite[] = [];

export function isNetworkError(e: unknown): boolean {
    return e instanceof TypeError && e.message.includes('Network');
}

async function flushWriteQueue(): Promise<void> {
    while (writeQueue.length > 0) {
        const item = writeQueue[0];
        try {
            await item.execute();
            writeQueue.shift();
        } catch (e) {
            if (isNetworkError(e)) break;
            writeQueue.shift();
        }
    }
}

const DOCS_SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const DOCS_API = 'https://docs.googleapis.com/v1/documents';

async function fetchDocSnapshot(docId: string, token: string): Promise<DocSnapshot> {
    const res = await fetch(`${DOCS_API}/${docId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Failed to get doc: ${res.status}`);
    const doc = await res.json();
    return { title: doc.title, content: docsToMarkdown(doc) };
}

// ─────────────────────────────────────────────────────────────────────────────

export const docsCapability: CapabilityModule = {
    id: 'docs',
    displayName: 'Docs',
    minVersion: '1.0.0',

    docs: `📄 DOCS (AppacadabraDocs) — Google Sign-In required (consent shown on first use only)
⚠️ **Acesso restrito:** \`getDoc()\`, \`appendText()\`, \`setDoc()\` e \`watchDoc()\` funcionam **apenas com documentos criados por este app via \`createDoc()\`**. Não é possível acessar Google Docs externos do usuário — nem mesmo documentos que ele criou manualmente no Google Drive. Se o usuário mencionar um documento que já existe, explique que o app só pode acessar arquivos que ele mesmo gerou e ofereça criar um novo.

**Operações básicas:**
- \`createDoc(title, content, callback)\` — Creates a Google Doc with optional markdown content
  - \`content\`: optional markdown string. Supported: \`# H1\`, \`## H2\`, \`### H3\`, \`- bullet\`, \`**bold**\`, \`*italic*\`, plain paragraphs
  - **Callback data**: \`{ docId, url }\`
- \`getDoc(docId, callback)\` — Reads document content as markdown
  - **Callback data**: \`{ title, content }\` (content is a markdown string — headings, bullets, bold, italic preserved)
- \`appendText(docId, text, callback)\` — Appends markdown text to the end of the document
  - **Callback data**: \`{ docId }\`
- \`setDoc(docId, content, callback)\` — **Replaces** the entire document body with new markdown content
  - Use when you want to rewrite or clear the document (e.g. save a new version of a report)
  - After success, the active watcher (if any) skips the next poll to avoid a spurious change event
  - Offline: write is queued and auto-replayed; callback receives \`{ queued: true }\`
  - **Callback data**: \`{ docId }\` or \`{ queued: true }\`
- \`generatePDF(content, type, callback)\` — Converts markdown or HTML to a styled PDF (base64)
  - \`content\`: markdown string or full HTML document
  - \`type\`: \`'markdown'\` (default, auto-styled) | \`'html'\` (used as-is)
  - **Callback data (string)**: Base64-encoded PDF — use with \`AppacadabraShare.shareFile(base64, 'application/pdf', 'doc.pdf', cb)\`

**Modo sync nativo (recomendado para documentos editados externamente):**

Use \`watchDoc\` em spells tipo "editor colaborativo" ou "log compartilhado" onde o documento pode ser editado de fora (outro usuário ou device). A capability detecta mudanças e dispara o callback automaticamente.

- \`watchDoc(docId, intervalMs, callbackName)\` — Starts polling for external changes
  - Fires **immediately** with current content (\`initial: true\`), then only when title or content changes
  - \`intervalMs\`: polling interval in ms (e.g. \`10000\` = every 10 s)
  - **Callback data (ok, data)**:
    - \`data.title\`: document title
    - \`data.content\`: full document content as markdown string
    - \`data.initial\`: \`true\` on first call — use to populate the editor
    - \`data.cached\`: \`true\` when offline and data comes from last successful read
  - Offline behaviour: fires with \`{ cached: true, ...lastKnownData }\`; if no cache: \`ok=false, { offline: true }\`
- \`stopWatchDoc(docId, callbackName)\` — Stops polling
  - **Callback data**: \`{ stopped: true }\`

**⚠️ REGRA:** Use \`watchDoc\` + \`setDoc\` para edição colaborativa. Use \`appendText\` + \`getDoc\` para docs de insert-only (diários, logs). Não salve \`lastSyncTimestamp\` no localStorage — o diff fica na capability.

**Usage (sync nativo):**
\`\`\`js
// 1. Ao abrir: carrega conteúdo atual (ou cache offline)
AppacadabraDocs.watchDoc(localStorage.getItem('docId'), 10000, 'onDocChanged');
window.onDocChanged = function(ok, data) {
  if (!ok) { if (data.offline) showBanner('Sem conexão'); return; }
  if (data.cached) showBanner('Conteúdo offline');
  editor.setValue(data.content);   // data.initial = true na primeira chamada
};

// 2. Salvar nova versão completa (enfileira offline automaticamente)
AppacadabraDocs.setDoc(localStorage.getItem('docId'), editor.getValue(), 'onSaved');
window.onSaved = function(ok, data) {
  if (data.queued) showBanner('Salvando quando voltar a internet');
};

// 3. Só acrescentar (sem reescrever tudo)
AppacadabraDocs.appendText(localStorage.getItem('docId'), '\\n## Nova Seção\\nConteúdo', 'done');

// 4. Parar ao fechar a tela
AppacadabraDocs.stopWatchDoc(localStorage.getItem('docId'), 'done');
\`\`\``,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraDocs = {
    createDoc: function(title, content, callbackName) {
      console.log('[AppacadabraDocs.createDoc] title:', title, 'callback:', callbackName);
      sendMessage('DOCS_CREATE', { title, content }, callbackName);
    },
    getDoc: function(docId, callbackName) {
      console.log('[AppacadabraDocs.getDoc] docId:', docId, 'callback:', callbackName);
      sendMessage('DOCS_GET', { docId }, callbackName);
    },
    appendText: function(docId, text, callbackName) {
      console.log('[AppacadabraDocs.appendText] docId:', docId, 'callback:', callbackName);
      sendMessage('DOCS_APPEND_TEXT', { docId, text }, callbackName);
    },
    setDoc: function(docId, content, callbackName) {
      console.log('[AppacadabraDocs.setDoc] docId:', docId, 'callback:', callbackName);
      sendMessage('DOCS_SET', { docId, content }, callbackName);
    },
    watchDoc: function(docId, intervalMs, callbackName) {
      console.log('[AppacadabraDocs.watchDoc] docId:', docId, 'interval:', intervalMs, 'callback:', callbackName);
      sendMessage('DOCS_WATCH', { docId, intervalMs: intervalMs || 10000, callbackName: callbackName }, callbackName);
    },
    stopWatchDoc: function(docId, callbackName) {
      console.log('[AppacadabraDocs.stopWatchDoc] docId:', docId, 'callback:', callbackName);
      sendMessage('DOCS_STOP_WATCH', { docId }, callbackName);
    },
    generatePDF: function(content, type, callbackName) {
      console.log('[AppacadabraDocs.generatePDF] type:', type, 'callback:', callbackName);
      sendMessage('GENERATE_PDF', { content, type: type || 'markdown' }, callbackName);
    }
  };
`,

    handleMessage: async (type: string, data: any, ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        switch (type) {
            case 'DOCS_CREATE': {
                console.log(`[Bridge] Docs create: ${data.title}`);
                try {
                    const token = await requestGoogleScopes(DOCS_SCOPES);
                    if (!token) {
                        return { success: false, result: 'Google Docs access was denied. Please try again and grant permission.' };
                    }

                    const createRes = await fetch(DOCS_API, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ title: data.title }),
                    });
                    if (!createRes.ok) {
                        return { success: false, result: `Failed to create doc: ${createRes.status} ${await createRes.text()}` };
                    }
                    const created = await createRes.json();
                    const documentId: string = created.documentId;

                    if (data.content) {
                        const { requests } = buildDocsRequests(data.content, 1);
                        if (requests.length > 0) {
                            const batchRes = await fetch(`${DOCS_API}/${documentId}:batchUpdate`, {
                                method: 'POST',
                                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                                body: JSON.stringify({ requests }),
                            });
                            if (!batchRes.ok) {
                                return { success: false, result: `Failed to write doc content: ${batchRes.status} ${await batchRes.text()}` };
                            }
                        }
                    }

                    return { success: true, result: JSON.stringify({ docId: documentId, url: `https://docs.google.com/document/d/${documentId}/edit` }) };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Docs create error' };
                }
            }

            case 'DOCS_GET': {
                console.log(`[Bridge] Docs get: ${data.docId}`);
                try {
                    const token = await requestGoogleScopes(DOCS_SCOPES);
                    if (!token) {
                        return { success: false, result: 'Google Docs access was denied. Please try again and grant permission.' };
                    }

                    const snap = await fetchDocSnapshot(data.docId, token);
                    resourceCache.set(data.docId, snap);
                    await flushWriteQueue();
                    return { success: true, result: JSON.stringify(snap) };
                } catch (e) {
                    if (isNetworkError(e)) {
                        const cached = resourceCache.get(data.docId);
                        if (cached) return { success: true, result: JSON.stringify({ ...cached, cached: true }) };
                        return { success: false, result: JSON.stringify({ offline: true }) };
                    }
                    return { success: false, result: e instanceof Error ? e.message : 'Docs get error' };
                }
            }

            case 'DOCS_APPEND_TEXT': {
                console.log(`[Bridge] Docs append: ${data.docId}`);
                try {
                    const token = await requestGoogleScopes(DOCS_SCOPES);
                    if (!token) {
                        return { success: false, result: 'Google Docs access was denied. Please try again and grant permission.' };
                    }

                    const docRes = await fetch(`${DOCS_API}/${data.docId}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    if (!docRes.ok) {
                        return { success: false, result: `Failed to get doc: ${docRes.status} ${await docRes.text()}` };
                    }
                    const doc = await docRes.json();
                    const bodyContent: any[] = doc.body?.content || [];
                    const lastSegment = bodyContent[bodyContent.length - 1];
                    const endIndex: number = (lastSegment?.endIndex ?? 1) - 1;

                    const { requests } = buildDocsRequests('\n' + data.text, endIndex);
                    if (requests.length > 0) {
                        const batchRes = await fetch(`${DOCS_API}/${data.docId}:batchUpdate`, {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ requests }),
                        });
                        if (!batchRes.ok) {
                            return { success: false, result: `Failed to append text: ${batchRes.status} ${await batchRes.text()}` };
                        }
                    }

                    // Update watcher snapshot so the next poll doesn't re-fire
                    try {
                        const snap = await fetchDocSnapshot(data.docId, token);
                        resourceCache.set(data.docId, snap);
                        const key = `${ctx.appId}_${data.docId}`;
                        const watcher = activeWatchers.get(key);
                        if (watcher) watcher.snapshot = snap;
                    } catch (_) { /* snapshot update is best-effort */ }

                    await flushWriteQueue();
                    return { success: true, result: JSON.stringify({ docId: data.docId }) };
                } catch (e) {
                    if (isNetworkError(e)) {
                        const docId = data.docId;
                        const text = data.text;
                        writeQueue.push({
                            execute: async () => {
                                const t = await requestGoogleScopes(DOCS_SCOPES);
                                if (!t) throw new Error('No token');
                                const dr = await fetch(`${DOCS_API}/${docId}`, { headers: { Authorization: `Bearer ${t}` } });
                                if (!dr.ok) throw new Error(`${dr.status}`);
                                const d = await dr.json();
                                const bc: any[] = d.body?.content || [];
                                const last = bc[bc.length - 1];
                                const ei: number = (last?.endIndex ?? 1) - 1;
                                const { requests: reqs } = buildDocsRequests('\n' + text, ei);
                                if (reqs.length > 0) {
                                    await fetch(`${DOCS_API}/${docId}:batchUpdate`, {
                                        method: 'POST',
                                        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ requests: reqs }),
                                    });
                                }
                            },
                        });
                        return { success: true, result: JSON.stringify({ queued: true }) };
                    }
                    return { success: false, result: e instanceof Error ? e.message : 'Docs append error' };
                }
            }

            case 'DOCS_SET': {
                console.log(`[Bridge] Docs set: ${data.docId}`);
                const docId: string = data.docId;
                const content: string = data.content ?? '';

                const executeSetDoc = async () => {
                    const token = await requestGoogleScopes(DOCS_SCOPES);
                    if (!token) throw new Error('Google Docs access was denied.');

                    // GET current doc to find endIndex
                    const docRes = await fetch(`${DOCS_API}/${docId}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    if (!docRes.ok) throw new Error(`Failed to get doc: ${docRes.status}`);
                    const doc = await docRes.json();
                    const bodyContent: any[] = doc.body?.content || [];
                    const lastSegment = bodyContent[bodyContent.length - 1];
                    const endIndex: number = lastSegment?.endIndex ?? 1;

                    const requests: any[] = [];

                    // Delete existing body content (if any)
                    if (endIndex > 2) {
                        requests.push({
                            deleteContentRange: {
                                range: { startIndex: 1, endIndex: endIndex - 1 },
                            },
                        });
                    }

                    // Insert new content
                    if (content) {
                        const { requests: insertReqs } = buildDocsRequests(content, 1);
                        requests.push(...insertReqs);
                    }

                    if (requests.length > 0) {
                        const batchRes = await fetch(`${DOCS_API}/${docId}:batchUpdate`, {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ requests }),
                        });
                        if (!batchRes.ok) throw new Error(`Failed to set doc: ${batchRes.status}`);
                    }

                    // Update watcher snapshot so next poll doesn't re-fire
                    try {
                        const snap = await fetchDocSnapshot(docId, token);
                        resourceCache.set(docId, snap);
                        const key = `${ctx.appId}_${docId}`;
                        const watcher = activeWatchers.get(key);
                        if (watcher) watcher.snapshot = snap;
                    } catch (_) { /* best-effort */ }
                };

                try {
                    await executeSetDoc();
                    await flushWriteQueue();
                    return { success: true, result: JSON.stringify({ docId }) };
                } catch (e) {
                    if (isNetworkError(e)) {
                        writeQueue.push({ execute: executeSetDoc });
                        return { success: true, result: JSON.stringify({ queued: true }) };
                    }
                    return { success: false, result: e instanceof Error ? e.message : 'Docs set error' };
                }
            }

            case 'DOCS_WATCH': {
                console.log(`[Bridge] Docs watch: ${data.docId}`);
                const docId: string = data.docId;
                const intervalMs: number = data.intervalMs || 10000;
                const callbackName: string = data.callbackName;
                const key = `${ctx.appId}_${docId}`;

                const existing = activeWatchers.get(key);
                if (existing) clearInterval(existing.interval);

                const doPoll = async (initial: boolean) => {
                    try {
                        const token = await requestGoogleScopes(DOCS_SCOPES);
                        if (!token) {
                            if (initial) {
                                const cached = resourceCache.get(docId);
                                const script = cached
                                    ? createCallbackScript(callbackName, true, JSON.stringify({ ...cached, initial: true, cached: true }))
                                    : createCallbackScript(callbackName, false, JSON.stringify({ offline: true }));
                                ctx.webViewRef.current?.injectJavaScript(script);
                            }
                            return;
                        }

                        const snap = await fetchDocSnapshot(docId, token);
                        resourceCache.set(docId, snap);

                        const watcher = activeWatchers.get(key);
                        const prev = watcher?.snapshot ?? null;
                        const hasChanged = initial || prev === null
                            || prev.title !== snap.title
                            || prev.content !== snap.content;

                        if (hasChanged) {
                            if (watcher) watcher.snapshot = snap;
                            const script = createCallbackScript(callbackName, true,
                                JSON.stringify({ ...snap, initial }));
                            ctx.webViewRef.current?.injectJavaScript(script);
                        }

                        await flushWriteQueue();
                    } catch (e) {
                        if (isNetworkError(e) && initial) {
                            const cached = resourceCache.get(docId);
                            const script = cached
                                ? createCallbackScript(callbackName, true, JSON.stringify({ ...cached, initial: true, cached: true }))
                                : createCallbackScript(callbackName, false, JSON.stringify({ offline: true }));
                            ctx.webViewRef.current?.injectJavaScript(script);
                        }
                    }
                };

                const interval = setInterval(() => doPoll(false), intervalMs);
                activeWatchers.set(key, { interval, webViewRef: ctx.webViewRef, callbackName, snapshot: null });

                doPoll(true);

                return { success: true, result: JSON.stringify({ watching: true }), deferredCallback: true };
            }

            case 'DOCS_STOP_WATCH': {
                console.log(`[Bridge] Docs stop watch: ${data.docId}`);
                const key = `${ctx.appId}_${data.docId}`;
                const watcher = activeWatchers.get(key);
                if (watcher) {
                    clearInterval(watcher.interval);
                    activeWatchers.delete(key);
                }
                return { success: true, result: JSON.stringify({ stopped: true }) };
            }

            case 'GENERATE_PDF': {
                console.log('[Bridge] Generating PDF...');
                try {
                    const { content, type } = data;
                    if (!content) {
                        return { success: false, result: 'No content provided' };
                    }
                    const bodyHtml = type === 'html' ? null : await marked(String(content));
                    const html = type === 'html'
                        ? content
                        : `<!DOCTYPE html><html><head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.7; }
                h1, h2, h3, h4 { color: #111; margin-top: 1.5em; }
                h1 { font-size: 2em; border-bottom: 2px solid #eee; padding-bottom: 0.3em; }
                h2 { font-size: 1.5em; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
                p { margin: 0.8em 0; }
                pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow: auto; font-size: 0.9em; }
                code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
                pre code { background: none; padding: 0; }
                blockquote { border-left: 4px solid #d0d7de; margin: 0; padding: 0 1em; color: #636c76; }
                table { border-collapse: collapse; width: 100%; }
                th, td { border: 1px solid #d0d7de; padding: 8px 12px; }
                th { background: #f6f8fa; }
                img { max-width: 100%; }
                a { color: #0969da; }
                ul, ol { padding-left: 1.5em; }
                hr { border: none; border-top: 1px solid #eee; }
            </style>
        </head><body>${bodyHtml}</body></html>`;
                    const { uri } = await Print.printToFileAsync({ html });
                    const base64 = await FileSystem.readAsStringAsync(uri, {
                        encoding: FileSystem.EncodingType.Base64
                    });
                    await FileSystem.deleteAsync(uri, { idempotent: true });
                    return { success: true, result: base64 };
                } catch (e) {
                    console.error('PDF generation error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'PDF generation failed' };
                }
            }

            default:
                return null;
        }
    },
};
