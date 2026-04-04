import { JSDOM, VirtualConsole } from 'jsdom';
import { ValidationError, ValidationResult } from './codeValidator';

// Padrões de erro do jsdom que são limitações da lib, não bugs do código gerado
const JSDOM_FALSE_POSITIVE_PATTERNS = [
    'not implemented',       // jsdom: canvas, AudioContext, etc.
    'Could not parse CSS',   // jsdom: vendor prefixes / modern CSS
    'cross-origin',          // jsdom: segurança de origem
    'SecurityError',         // jsdom: algumas APIs restritas
    "Unexpected token '<'",  // JSX syntax ou CDN retornando HTML (limitação jsdom)
];

export function isJsdomFalsePositive(message: string): boolean {
    return JSDOM_FALSE_POSITIVE_PATTERNS.some(p =>
        message.toLowerCase().includes(p.toLowerCase())
    );
}

// Stubs para bibliotecas CDN comuns que jsdom não consegue carregar
const CDN_LIBRARY_STUBS = `
<script>
(function() {
    function makeStub() {
        return new Proxy(function() { return makeStub(); }, {
            get: function(t, k) { if (k === 'then') return undefined; return makeStub(); },
            construct: function() { return makeStub(); }
        });
    }
    if (typeof THREE === 'undefined') window.THREE = makeStub();      // three.js
    if (typeof PIXI === 'undefined') window.PIXI = makeStub();        // pixi.js
    if (typeof BABYLON === 'undefined') window.BABYLON = makeStub();  // babylon.js
    if (typeof p5 === 'undefined') window.p5 = makeStub();            // p5.js
    if (typeof Chart === 'undefined') window.Chart = makeStub();      // chart.js
    if (typeof Matter === 'undefined') window.Matter = makeStub();    // matter.js
    if (typeof Tone === 'undefined') window.Tone = makeStub();        // tone.js
    if (typeof Hammer === 'undefined') window.Hammer = makeStub();    // hammer.js
})();
</script>
`;

// Mocks para todas as APIs Appacadabra injetadas pelo app
const APPACADABRA_MOCKS = `
<script>
(function() {
    var noop = function() {};
    var apiProxy = new Proxy({}, { get: function() { return noop; } });

    function sampleFromSchema(s) {
        if (!s) return {};
        if (s.type === 'string') return 'test';
        if (s.type === 'number' || s.type === 'integer') return 0;
        if (s.type === 'boolean') return false;
        if (s.type === 'array') return s.items ? [sampleFromSchema(s.items)] : [];
        if (s.type === 'object') {
            var obj = {};
            if (s.properties) Object.keys(s.properties).forEach(function(k) { obj[k] = sampleFromSchema(s.properties[k]); });
            return obj;
        }
        return null;
    }

    function makeAIBuilder(schema) {
        var builder = {
            withSchema: function(s) { return makeAIBuilder(s); },
            withSearch: function() { return this; },
            fromImage: function() { return this; },
            fromVideo: function() { return this; },
            fromAudio: function() { return this; },
            generate: function(prompt, callbackName) {
                if (callbackName && typeof window[callbackName] === 'function') {
                    var sample = schema ? JSON.stringify(sampleFromSchema(schema)) : '{}';
                    window[callbackName](true, sample);
                }
            }
        };
        return builder;
    }

    window.AppacadabraAI = {
        withSchema: function(s) { return makeAIBuilder(s); },
        withSearch: function() { return makeAIBuilder(null); },
        fromImage: function() { return makeAIBuilder(null); },
        fromVideo: function() { return makeAIBuilder(null); },
        fromAudio: function() { return makeAIBuilder(null); },
        generate: function(prompt, cb) {
            if (cb && typeof window[cb] === 'function') window[cb](true, '{}');
        },
        generateImage: noop,
        generateVideo: noop,
        similarity: noop,
    };

    window.AppacadabraNotify = apiProxy;
    window.AppacadabraCalendar = apiProxy;
    window.AppacadabraShare = apiProxy;
    window.AppacadabraHealth = apiProxy;
    window.AppacadabraContacts = apiProxy;
    window.AppacadabraClipboard = apiProxy;
    window.AppacadabraDevice = apiProxy;
    window.AppacadabraCamera = apiProxy;
    window.AppacadabraAudio = apiProxy;
    window.AppacadabraScreen = apiProxy;
    window.AppacadabraSensors = apiProxy;
    window.ReactNativeWebView = { postMessage: noop };
})();
</script>
`;

export function injectAtStart(html: string, injection: string): string {
    // 1. Prefer injecting right after <head>
    const withHead = html.replace(/(<head[^>]*>)/i, `$1${injection}`);
    if (withHead !== html) return withHead;
    // 2. Fallback: before the first <script> tag
    const withScript = html.replace(/(<script[\s>])/i, `${injection}$1`);
    if (withScript !== html) return withScript;
    // 3. Last resort: prepend to entire document
    return injection + html;
}

export function validateWithExecution(html: string): ValidationResult {
    try {
        const errors: ValidationError[] = [];
        const jsErrors: string[] = [];

        // Inject CDN stubs and mocks robustly (works even without <head>/<body>)
        const htmlWithStubs = injectAtStart(html, CDN_LIBRARY_STUBS);
        const htmlWithMocks = injectAtStart(htmlWithStubs, APPACADABRA_MOCKS);

        const virtualConsole = new VirtualConsole();
        // Silence jsdomError (covers "not implemented": navigation, canvas, AudioContext, etc.)
        // Real JS errors are captured separately via onerror/addEventListener
        virtualConsole.on('jsdomError', () => {});

        const dom = new JSDOM(htmlWithMocks, {
            runScripts: 'dangerously',
            pretendToBeVisual: true,
            url: 'https://app.appacadabra.local/',
            virtualConsole,
            beforeParse(win) {
                (win as any).onerror = (msg: string | Event) => {
                    const message = typeof msg === 'string' ? msg : (msg as ErrorEvent).message ?? String(msg);
                    if (!isJsdomFalsePositive(message)) {
                        jsErrors.push(message);
                    }
                    return true; // suppress — don't re-throw
                };
            },
        });

        // Also capture any errors fired after beforeParse
        dom.window.addEventListener('error', (e: ErrorEvent) => {
            if (!isJsdomFalsePositive(e.message) && !jsErrors.includes(e.message)) {
                jsErrors.push(e.message);
            }
        });

        const window = dom.window;

        // 1. Runtime errors (filtered) — tela branca por crash na inicialização
        for (const err of jsErrors) {
            errors.push({
                type: 'js',
                message: `Runtime error during page initialization: ${err}`,
                fixable: true
            });
        }

        // 2. onclick handlers definidos em window — botões congelados
        const allElements = window.document.querySelectorAll('[onclick]');
        for (const el of Array.from(allElements)) {
            const onclickAttr = el.getAttribute('onclick') ?? '';
            const fnName = onclickAttr.match(/^\s*(\w+)\s*\(/)?.[1];
            if (fnName && typeof (window as any)[fnName] !== 'function') {
                errors.push({
                    type: 'js',
                    message: `onclick handler "${fnName}" is not defined — button will be frozen when clicked`,
                    fixable: true
                });
            }
        }

        // 3. Invoke onclick handlers to exercise AI callback paths
        // Suppress browser dialogs that would block JSDOM
        (window as any).alert = () => {};
        (window as any).confirm = () => true;
        (window as any).prompt = () => '';

        const allClickable = window.document.querySelectorAll('[onclick]');
        for (const el of Array.from(allClickable)) {
            const onclickAttr = el.getAttribute('onclick') ?? '';
            const fnName = onclickAttr.match(/^\s*(\w+)\s*\(/)?.[1];
            if (fnName && typeof (window as any)[fnName] === 'function') {
                try { (window as any)[fnName](); } catch (_) { /* errors captured via onerror */ }
            }
        }

        dom.window.close();

        return {
            valid: errors.length === 0,
            errors,
            canRetry: errors.some(e => e.fixable),
        };
    } catch (e: any) {
        // Known HTML parse crash → return as fixable error
        return {
            valid: false,
            errors: [{ type: 'html', message: `Failed to parse/render HTML: ${e.message}`, fixable: true }],
            canRetry: true,
        };
    }
}
