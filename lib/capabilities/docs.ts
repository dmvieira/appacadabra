import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import { marked, type Token, type Tokens } from 'marked';
import TurndownService from 'turndown';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createCallbackScript } from './mediaHelpers';
import { requestGoogleScopes } from '../firebase';
import { CapabilityModule, HandlerContext, HandlerResult, WebViewRef } from './types';
import * as aiApi from '../api/ai';
import * as db from '../database/db';
import { hasOpenRouterKey } from '../api/keyStorage';
import { useBridgeUIStore } from '../bridgeUIStore';
import { estimateUsd, formatUsd } from '../api/pricing';
import { getPreferredModel } from '../api/modelPreferences';

const DOCS_CACHE_PREFIX = 'appacadabra_docs_cache_';

async function loadDocsCache(docId: string): Promise<{ title: string; content: string } | null> {
    try {
        const raw = await AsyncStorage.getItem(DOCS_CACHE_PREFIX + docId);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function saveDocsCache(docId: string, data: { title: string; content: string }): void {
    AsyncStorage.setItem(DOCS_CACHE_PREFIX + docId, JSON.stringify(data))?.catch(() => {});
}

// ============= Format Conversion Helpers =============

const _td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
_td.remove(['script', 'style']);
_td.addRule('force-em', {
    filter: ['em', 'i'],
    replacement: (content: string) => { const c = content.trim(); return c ? `*${c}*` : content; },
});
_td.addRule('force-strong', {
    filter: ['strong', 'b'],
    replacement: (content: string) => { const c = content.trim(); return c ? `**${c}**` : content; },
});

function sanitizeMarkdown(md: string): string {
    return md
        .replace(/([^\n])\n(---+\s*)$/gm, '$1\n\n$2')
        .replace(/\*\*([^*\n]+?)\*\*/g, (_, c) => `**${c.trim()}**`)
        .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, (_, c) => `*${c.trim()}*`);
}

async function markdownToHtml(md: string): Promise<string> {
    return marked(sanitizeMarkdown(md)) as Promise<string>;
}

// Metro's browser field remaps turndown → turndown.browser.cjs.js which relies on
// document.createElement (unavailable in React Native). Pre-parsing with domino gives
// turndown a DOM node instead of a string, so it skips its internal HTML parser entirely.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _domino = require('@mixmark-io/domino');

function htmlToMd(html: string): string {
    const doc = _domino.createDocument(html) as { body: Element };
    const raw = _td.turndown(doc.body as unknown as HTMLElement);
    return raw.replace(/\\([*_`\[\]()#.!|>~])/g, '$1');
}

const DOC_STYLES = `
  @page { margin: 40px 32px; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 0; color: #1a1a1a; line-height: 1.7; }
  h1, h2, h3, h4 { color: #111; margin-top: 1.5em; page-break-after: avoid; }
  h1 { font-size: 2em; border-bottom: 2px solid #eee; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
  p { margin: 0.8em 0; }
  li { margin-bottom: 0.3em; }
  pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow: auto; font-size: 0.9em; }
  code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #d0d7de; margin: 0; padding: 0 1em; color: #636c76; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d0d7de; padding: 8px 12px; }
  th { background: #f6f8fa; }
  img { max-width: 100%; }
  a { color: #0969da; }
  ul, ol { padding-left: 1.5em; }
  hr { border: none; border-top: 2px solid #eee; margin: 1.5em 0; }
`;

function wrapDocHtml(bodyHtml: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${DOC_STYLES}</style></head><body>${bodyHtml}</body></html>`;
}

// ============= Google Docs Helpers =============

type Segment = { text: string; bold: boolean; italic: boolean };

function extractInlineSegments(tokens: Token[], bold = false, italic = false): Segment[] {
    const out: Segment[] = [];
    for (const tok of tokens) {
        if (tok.type === 'strong') {
            out.push(...extractInlineSegments((tok as Tokens.Strong).tokens, true, italic));
        } else if (tok.type === 'em') {
            out.push(...extractInlineSegments((tok as Tokens.Em).tokens, bold, true));
        } else if (tok.type === 'text') {
            const t = tok as Tokens.Text;
            if (t.tokens?.length) {
                out.push(...extractInlineSegments(t.tokens, bold, italic));
            } else {
                out.push({ text: t.text, bold, italic });
            }
        } else if (tok.type === 'codespan' || tok.type === 'escape') {
            out.push({ text: (tok as Tokens.Codespan | Tokens.Escape).text, bold, italic });
        }
    }
    return out;
}

function buildDocsRequests(markdownText: string, startIndex: number): { requests: any[]; endIndex: number } {
    const blockTokens = marked.lexer(markdownText);
    const requests: any[] = [];
    let cursor = startIndex;

    function insertLine(segments: Segment[], paragraphStyle: string | null, isBullet: boolean) {
        const lineStart = cursor;
        for (const seg of segments) {
            if (!seg.text) continue;
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

    for (const tok of blockTokens) {
        if (tok.type === 'heading') {
            const h = tok as Tokens.Heading;
            const style = (['HEADING_1', 'HEADING_2', 'HEADING_3'] as const)[h.depth - 1] ?? null;
            insertLine(extractInlineSegments(h.tokens), style, false);
        } else if (tok.type === 'paragraph') {
            insertLine(extractInlineSegments((tok as Tokens.Paragraph).tokens), null, false);
        } else if (tok.type === 'list') {
            for (const item of (tok as Tokens.List).items) {
                const firstTok = item.tokens[0];
                const inlineToks = firstTok?.tokens ?? (firstTok ? [firstTok] : []);
                insertLine(extractInlineSegments(inlineToks), null, true);
            }
        }
        // space and other block types are skipped
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
            const trailing = content.match(/\s+$/)?.[0] ?? '';
            const inner = trailing ? content.slice(0, -trailing.length) : content;
            if (inner) {
                if (bold && italic) lineText += `***${inner}***${trailing}`;
                else if (bold)      lineText += `**${inner}**${trailing}`;
                else if (italic)    lineText += `*${inner}*${trailing}`;
                else                lineText += content;
            } else {
                lineText += content;
            }
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
export const editModeLoadedKeys = new Set<string>();

export function cleanupWatchersForApp(appId: number | null): void {
    if (!appId) return;
    const prefix = `${appId}_`;
    for (const [key, watcher] of activeWatchers) {
        if (key.startsWith(prefix)) {
            clearInterval(watcher.interval);
            activeWatchers.delete(key);
        }
    }
}

export function cleanupEditModeForApp(appId: number | null): void {
    if (!appId) return;
    const prefix = `${appId}_`;
    for (const key of editModeLoadedKeys) {
        if (key.startsWith(prefix)) editModeLoadedKeys.delete(key);
    }
}

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

// ============= Extract (PDF / DOCX / TXT / Markdown → text) =============

const SCANNED_CHAR_THRESHOLD = 20;
const EXTRACT_MAX_PAGES_DEFAULT = 50;
const EXTRACT_MAX_PAGES_HARD_CAP = 200;
const OCR_PROMPT = 'Extract the text from this scanned page verbatim. Output only the text, no commentary.';

function base64ToUint8Array(b64: string): Uint8Array {
    const clean = b64.replace(/^data:[^,]+,/i, '').replace(/\s+/g, '');
    const bin = globalThis.atob(clean);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return globalThis.btoa(bin);
}

interface PdfTextResult {
    text: string;
    pageCount: number;
    avgCharsPerPage: number;
    doc: any;
}

async function loadPdfjs(): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = '';
    return pdfjs;
}

async function extractTextFromPdf(bytes: Uint8Array, maxPages: number): Promise<PdfTextResult> {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: bytes, disableWorker: true, useWorker: false, isEvalSupported: false }).promise;
    const pageCount = Math.min(doc.numPages, maxPages);
    const parts: string[] = [];
    let totalChars = 0;
    for (let i = 1; i <= pageCount; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map((it: any) => (typeof it.str === 'string' ? it.str : '')).join(' ');
        parts.push(pageText);
        totalChars += pageText.replace(/\s/g, '').length;
    }
    return {
        text: parts.join('\n\n').trim(),
        pageCount,
        avgCharsPerPage: pageCount > 0 ? totalChars / pageCount : 0,
        doc,
    };
}

async function extractJpegImagesFromPdf(doc: any, pageCount: number): Promise<string[]> {
    const images: string[] = [];
    for (let i = 1; i <= pageCount; i++) {
        const page = await doc.getPage(i);
        const ops = await page.getOperatorList();
        const imageNames: string[] = [];
        for (let j = 0; j < ops.fnArray.length; j++) {
            const fn = ops.fnArray[j];
            // OPS.paintImageXObject === 85 in pdfjs; check by name defensively.
            const name = ops.argsArray[j]?.[0];
            if (typeof name === 'string' && name.startsWith('img_')) {
                imageNames.push(name);
            }
        }
        if (imageNames.length === 0) {
            throw new Error('ocr_unsupported_pdf');
        }
        // Grab first image (scanned PDFs typically have one full-page image).
        const imgObj: any = await new Promise((resolve) => {
            try {
                page.objs.get(imageNames[0], (img: any) => resolve(img));
            } catch (_) {
                resolve(null);
            }
        });
        const rawData: Uint8Array | undefined = imgObj?.data;
        if (!rawData || rawData.length < 4) {
            throw new Error('ocr_unsupported_pdf');
        }
        // JPEG magic (0xFF 0xD8). If not JPEG, we don't have a canvas to encode PNG.
        if (rawData[0] !== 0xff || rawData[1] !== 0xd8) {
            throw new Error('ocr_unsupported_pdf');
        }
        images.push(uint8ArrayToBase64(rawData));
    }
    return images;
}

async function extractFromDocx(bytes: Uint8Array): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mammoth = require('mammoth/mammoth.browser.min.js');
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return String(result?.value ?? '').trim();
}

function isDocxMime(mimeType: string): boolean {
    return mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

function isPdfMime(mimeType: string): boolean {
    return mimeType === 'application/pdf';
}

function isTextMime(mimeType: string): boolean {
    return mimeType.startsWith('text/') || mimeType === 'application/json';
}

// ─────────────────────────────────────────────────────────────────────────────

export const docsCapability: CapabilityModule = {
    id: 'docs',
    displayName: 'Docs',
    minVersion: '1.0.0',
    description: "`createDoc` creates a document with optional markdown content; `getDoc` reads it back as markdown; `appendText` adds content to the end; `setDoc` replaces the full body; `watchDoc`/`stopWatchDoc` poll for external changes; `convert` transforms between markdown, HTML, and PDF; `extract` reads text from PDF, DOCX, TXT or MD files (scanned PDFs auto-OCR with user cost confirmation).",

    docs: `📄 DOCS (AppacadabraDocs) — Google Sign-In required (consent shown on first use only)
⚠️ **Restricted access:** \`getDoc()\`, \`appendText()\`, \`setDoc()\` and \`watchDoc()\` work **only with documents created by this app via \`createDoc()\`**. Existing Google Docs from the user cannot be accessed — not even documents they created manually in Google Drive. If the user mentions an existing document, explain that the app can only access files it generated itself and offer to create a new one.

**Basic operations:**
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
- \`convert(from, to, content, callbackName)\` — Converts between formats (all async, callback-based)
  - \`from\`: \`'markdown'\` | \`'html'\`
  - \`to\`: \`'html'\` | \`'markdown'\` | \`'pdf'\`
  - **Callback data**: string — HTML, markdown, or base64 PDF
  - For \`to: 'pdf'\`: use \`AppacadabraShare.shareFile(base64, 'application/pdf', 'doc.pdf', cb)\`
  - Markdown supported: H1–H3, bullets, bold, italic, tables, code blocks, blockquotes, \`---\` hr

**Native sync mode (recommended for documents edited externally):**

Use \`watchDoc\` in spells like "collaborative editor" or "shared log" where the document may be edited from outside (another user or device). The capability detects changes and fires the callback automatically.

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

**⚠️ RULE:** Use \`watchDoc\` + \`setDoc\` for collaborative editing. Use \`appendText\` + \`getDoc\` for insert-only docs (journals, logs). Do not save \`lastSyncTimestamp\` in localStorage — diffing is handled by the capability.

**📄 Text extraction from shared files (\`extract\`):**

Combined with \`AppacadabraShare\`, lets a spell read the contents of any PDF, DOCX, TXT or Markdown file the user shares.

- \`extract(base64OrBlobMarker, mimeType, callback, options?)\` — Extracts plain text
  - \`base64OrBlobMarker\`: raw base64, \`data:...;base64,...\`, or an \`__appblob__:\` marker (e.g. what \`AppacadabraShare\` gives you). All three shapes are accepted.
  - \`mimeType\`: e.g. \`'application/pdf'\`, \`'application/vnd.openxmlformats-officedocument.wordprocessingml.document'\`, \`'text/plain'\`, \`'text/markdown'\`
  - \`options.maxPages\`: for PDFs only. Default 50, hard cap 200. Ignored for other formats.
  - **Callback data (ok, text)**:
    - On success: \`text\` is the plain extracted text (concatenated across pages for PDF; body only for DOCX).
    - On failure the second argument is one of:
      - \`'user_cancelled'\` — user cancelled the OCR cost confirmation
      - \`'no_openrouter_key'\` — OCR needed but user has no OpenRouter key
      - \`'ocr_unsupported_pdf'\` — PDF is scanned but pages have no extractable embedded image (rare, layered/masked PDFs)
      - \`'password_protected'\` — encrypted PDF
      - \`'encrypted_docx'\` — encrypted DOCX
      - \`'Unsupported mimeType: ...'\` for other formats
      - a generic error message string for anything else
- **Scanned PDFs are handled automatically:** if a PDF has no selectable text the capability falls back to AI OCR. It shows **one** cost-confirmation modal for the whole file (aggregated over N pages), then runs OCR silently. The spell doesn't need to decide anything — just call \`extract\`.

\`\`\`js
AppacadabraShare.receiveShared(function(ok, shared) {
  if (!ok || !shared) return;
  AppacadabraDocs.extract(shared.base64, shared.mimeType, 'onExtracted');
});
window.onExtracted = function(ok, textOrError) {
  if (!ok) { alert('Could not read file: ' + textOrError); return; }
  document.getElementById('output').value = textOrError;
};
\`\`\`

**Usage (native sync):**
\`\`\`js
// 1. On open: loads current content (or offline cache)
AppacadabraDocs.watchDoc(localStorage.getItem('docId'), 10000, 'onDocChanged');
window.onDocChanged = function(ok, data) {
  if (!ok) { if (data.offline) showBanner('No connection'); return; }
  if (data.cached) showBanner('Offline content');
  editor.setValue(data.content);   // data.initial = true on first call
};

// 2. Save a full new version (queued offline automatically)
AppacadabraDocs.setDoc(localStorage.getItem('docId'), editor.getValue(), 'onSaved');
window.onSaved = function(ok, data) {
  if (data.queued) showBanner('Saving when connection returns');
};

// 3. Append only (without rewriting everything)
AppacadabraDocs.appendText(localStorage.getItem('docId'), '\\n## New Section\\nContent', 'done');

// 4. Stop when closing the screen
AppacadabraDocs.stopWatchDoc(localStorage.getItem('docId'), 'done');

// 5. WYSIWYG editor pattern (read → display editable → save back)
AppacadabraDocs.watchDoc(localStorage.getItem('docId'), 10000, 'onDoc');
const editor = document.getElementById('editor');
editor.contentEditable = 'true';
window.onDoc = function(ok, data) {
  if (!ok) return;
  AppacadabraDocs.convert('markdown', 'html', data.content, 'onRendered');
};
window.onRendered = function(ok, html) { editor.innerHTML = html; };
function save() {
  AppacadabraDocs.convert('html', 'markdown', editor.innerHTML, 'onConverted');
}
window.onConverted = function(ok, md) {
  AppacadabraDocs.setDoc(localStorage.getItem('docId'), md, 'onSaved');
};
\`\`\``,

    validationMock: `    window.AppacadabraDocs = apiProxy;`,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraDocs = {
    convert: function(from, to, content, callbackName) {
      console.log('[AppacadabraDocs.convert]', from, '\\u2192', to);
      sendMessage('CONVERT', { from: from, to: to, content: content }, callbackName);
    },
    createDoc: function(title, content, callbackName) {
      if (window.__IS_EDIT_MODE__) return;
      console.log('[AppacadabraDocs.createDoc] title:', title, 'callback:', callbackName);
      sendMessage('DOCS_CREATE', { title, content }, callbackName);
    },
    getDoc: function(docId, callbackName) {
      console.log('[AppacadabraDocs.getDoc] docId:', docId, 'callback:', callbackName);
      sendMessage('DOCS_GET', { docId }, callbackName);
    },
    appendText: function(docId, text, callbackName) {
      if (window.__IS_EDIT_MODE__) return;
      console.log('[AppacadabraDocs.appendText] docId:', docId, 'callback:', callbackName);
      sendMessage('DOCS_APPEND_TEXT', { docId, text }, callbackName);
    },
    setDoc: function(docId, content, callbackName) {
      if (window.__IS_EDIT_MODE__) return;
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
    extract: function(input, mimeType, callbackName, options) {
      console.log('[AppacadabraDocs.extract] mimeType:', mimeType, 'callback:', callbackName);
      var resolved = input;
      if (typeof input === 'string') {
        if (input.indexOf('__appblob__:') === 0 && window.__APPACADABRA_BLOB_CACHE__ && window.__APPACADABRA_BLOB_CACHE__[input]) {
          resolved = window.__APPACADABRA_BLOB_CACHE__[input].replace(/^data:[^,]+,/i, '');
        } else if (input.indexOf('data:') === 0) {
          resolved = input.replace(/^data:[^,]+,/i, '');
        }
      }
      sendMessage('DOCS_EXTRACT', { base64: resolved, mimeType: mimeType, options: options || {} }, callbackName);
    },
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

                    return { success: true, result: { docId: documentId, url: `https://docs.google.com/document/d/${documentId}/edit` } };
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
                    saveDocsCache(data.docId, snap);
                    await flushWriteQueue();
                    return { success: true, result: snap };
                } catch (e) {
                    const cached = resourceCache.get(data.docId) ?? await loadDocsCache(data.docId);
                    if (cached) return { success: true, result: { ...cached, cached: true } };
                    if (isNetworkError(e)) return { success: false, result: { offline: true } };
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
                    return { success: true, result: { docId: data.docId } };
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
                        return { success: true, result: { queued: true } };
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
                    return { success: true, result: { docId } };
                } catch (e) {
                    if (isNetworkError(e)) {
                        writeQueue.push({ execute: executeSetDoc });
                        return { success: true, result: { queued: true } };
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
                const existingSnapshot = existing?.snapshot ?? null;

                const doPoll = async (initial: boolean) => {
                    try {
                        const token = await requestGoogleScopes(DOCS_SCOPES);
                        if (!token) {
                            if (initial) {
                                const cached = resourceCache.get(docId) ?? await loadDocsCache(docId);
                                const script = cached
                                    ? createCallbackScript(callbackName, true, { ...cached, initial: true, cached: true })
                                    : createCallbackScript(callbackName, false, { offline: true });
                                ctx.webViewRef.current?.injectJavaScript(script);
                            }
                            return;
                        }

                        const snap = await fetchDocSnapshot(docId, token);
                        resourceCache.set(docId, snap);
                        saveDocsCache(docId, snap);

                        const watcher = activeWatchers.get(key);
                        const prev = watcher?.snapshot ?? null;
                        const hasChanged = initial || prev === null
                            || prev.title !== snap.title
                            || prev.content !== snap.content;

                        if (hasChanged) {
                            if (watcher && !ctx.isEditMode) watcher.snapshot = snap;
                            const script = createCallbackScript(callbackName, true, { ...snap, initial });
                            ctx.webViewRef.current?.injectJavaScript(script);
                        }

                        await flushWriteQueue();
                    } catch (e) {
                        if (initial) {
                            const cached = resourceCache.get(docId) ?? await loadDocsCache(docId);
                            const script = cached
                                ? createCallbackScript(callbackName, true, { ...cached, initial: true, cached: true })
                                : createCallbackScript(callbackName, false, { offline: true });
                            ctx.webViewRef.current?.injectJavaScript(script);
                        }
                    }
                };

                // Edit mode: one-shot fetch, no persistent interval
                if (ctx.isEditMode) {
                    doPoll(true);
                    return { success: true, result: { watching: true }, deferredCallback: true };
                }

                if (existing) clearInterval(existing.interval);
                const interval = setInterval(() => doPoll(false), intervalMs);
                activeWatchers.set(key, { interval, webViewRef: ctx.webViewRef, callbackName, snapshot: existingSnapshot });

                doPoll(existingSnapshot === null);

                return { success: true, result: { watching: true }, deferredCallback: true };
            }

            case 'DOCS_STOP_WATCH': {
                console.log(`[Bridge] Docs stop watch: ${data.docId}`);
                const key = `${ctx.appId}_${data.docId}`;
                const watcher = activeWatchers.get(key);
                if (watcher) {
                    clearInterval(watcher.interval);
                    activeWatchers.delete(key);
                }
                return { success: true, result: { stopped: true } };
            }

            case 'CONVERT': {
                console.log(`[Bridge] Convert: ${data.from} → ${data.to}`);
                const { from, to, content } = data;
                if (!content) return { success: false, result: 'No content provided' };
                try {
                    if (from === 'markdown' && to === 'html') {
                        return { success: true, result: await markdownToHtml(String(content)) };
                    }
                    if (from === 'html' && to === 'markdown') {
                        return { success: true, result: htmlToMd(String(content)) };
                    }
                    if (from === 'markdown' && to === 'pdf') {
                        const bodyHtml = await markdownToHtml(String(content));
                        const { uri } = await Print.printToFileAsync({ html: wrapDocHtml(bodyHtml) });
                        const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
                        await FileSystem.deleteAsync(uri, { idempotent: true });
                        return { success: true, result: base64 };
                    }
                    if (from === 'html' && to === 'pdf') {
                        const paginationStyle = `<style>@page{margin:40px 32px;}h1,h2,h3,h4{page-break-after:avoid;break-after:avoid;}</style>`;
                        let html = String(content);
                        if (/<head[^>]*>/i.test(html)) {
                            html = html.replace(/(<head[^>]*>)/i, `$1${paginationStyle}`);
                        } else {
                            html = paginationStyle + html;
                        }
                        const { uri } = await Print.printToFileAsync({ html });
                        const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
                        await FileSystem.deleteAsync(uri, { idempotent: true });
                        return { success: true, result: base64 };
                    }
                    return { success: false, result: `Unsupported conversion: ${from} → ${to}` };
                } catch (e) {
                    console.error('Convert error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Convert error' };
                }
            }

            case 'DOCS_EXTRACT': {
                const base64: string = typeof data?.base64 === 'string' ? data.base64 : '';
                const mimeType: string = typeof data?.mimeType === 'string' ? data.mimeType : '';
                const opts = data?.options ?? {};
                const requestedMax = typeof opts.maxPages === 'number' && opts.maxPages > 0 ? opts.maxPages : EXTRACT_MAX_PAGES_DEFAULT;
                const maxPages = Math.min(requestedMax, EXTRACT_MAX_PAGES_HARD_CAP);

                if (!base64) return { success: false, result: 'Empty file contents' };
                if (!mimeType) return { success: false, result: 'Missing mimeType' };

                console.log(`[Bridge] Docs extract: mimeType=${mimeType}, base64=${base64.length}B`);

                let bytes: Uint8Array;
                try {
                    bytes = base64ToUint8Array(base64);
                } catch (e) {
                    return { success: false, result: 'Invalid base64 input' };
                }

                try {
                    if (isTextMime(mimeType)) {
                        const text = new TextDecoder('utf-8').decode(bytes);
                        return { success: true, result: text };
                    }

                    if (isDocxMime(mimeType)) {
                        try {
                            const text = await extractFromDocx(bytes);
                            return { success: true, result: text };
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);
                            if (/encrypted|password/i.test(msg)) {
                                return { success: false, result: 'encrypted_docx' };
                            }
                            return { success: false, result: msg };
                        }
                    }

                    if (isPdfMime(mimeType)) {
                        let pdf: PdfTextResult;
                        try {
                            pdf = await extractTextFromPdf(bytes, maxPages);
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);
                            if (/password|encrypted/i.test(msg)) {
                                return { success: false, result: 'password_protected' };
                            }
                            return { success: false, result: msg };
                        }

                        // If the PDF has selectable text, we're done.
                        if (pdf.avgCharsPerPage >= SCANNED_CHAR_THRESHOLD) {
                            return { success: true, result: pdf.text };
                        }

                        // ── Scanned PDF: OCR fallback ────────────────────
                        const hasKey = await hasOpenRouterKey();
                        if (!hasKey) {
                            await useBridgeUIStore.getState().requestKeyMissing('generate');
                            return { success: false, result: 'no_openrouter_key' };
                        }

                        let pageImages: string[];
                        try {
                            pageImages = await extractJpegImagesFromPdf(pdf.doc, pdf.pageCount);
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);
                            return { success: false, result: msg === 'ocr_unsupported_pdf' ? 'ocr_unsupported_pdf' : msg };
                        }

                        const modelId = await getPreferredModel('WEBVIEW');
                        const perPageUsd = estimateUsd({
                            type: 'webview_ai',
                            promptLength: OCR_PROMPT.length,
                            inputImages: 1,
                            modelId,
                        });
                        const totalUsd = perPageUsd * pageImages.length;
                        const confirmed = await useBridgeUIStore
                            .getState()
                            .requestCostEstimate(ctx.appId, 'generate', formatUsd(totalUsd), modelId, pageImages.length);
                        if (!confirmed) return { success: false, result: 'user_cancelled' };

                        const texts: string[] = [];
                        let accumulatedUsd = 0;
                        for (const imgB64 of pageImages) {
                            const result = await aiApi.aiGenerate({
                                prompt: OCR_PROMPT,
                                images: [imgB64],
                            });
                            texts.push(String(result.text ?? '').trim());
                            accumulatedUsd += result.costUsd ?? 0;
                        }
                        if (ctx.appId !== null && accumulatedUsd > 0) {
                            try { await db.incrementSpendUsd(ctx.appId, accumulatedUsd); } catch (_) {}
                        }
                        return { success: true, result: texts.join('\n\n').trim() };
                    }

                    return { success: false, result: `Unsupported mimeType: ${mimeType}` };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Extract error' };
                }
            }

            default:
                return null;
        }
    },
};
