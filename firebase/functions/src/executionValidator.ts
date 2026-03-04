import { JSDOM } from 'jsdom';
import { ValidationError, ValidationResult } from './codeValidator';

// Padrões de erro do jsdom que são limitações da lib, não bugs do código gerado
const JSDOM_FALSE_POSITIVE_PATTERNS = [
    'not implemented',       // jsdom: canvas, AudioContext, etc.
    'Could not parse CSS',   // jsdom: vendor prefixes / modern CSS
    'cross-origin',          // jsdom: segurança de origem
    'SecurityError',         // jsdom: algumas APIs restritas
    "Unexpected token '<'",  // JSX syntax ou CDN retornando HTML (limitação jsdom)
];

function isJsdomFalsePositive(message: string): boolean {
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
    window.AppacadabraAI = apiProxy;
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

export function validateWithExecution(html: string): ValidationResult {
    const errors: ValidationError[] = [];
    const jsErrors: string[] = [];

    try {
        // Inject CDN stubs into <head> (before user scripts) and mocks into <body>
        const htmlWithStubs = html.replace(/(<head[^>]*>)/i, `$1${CDN_LIBRARY_STUBS}`);
        const htmlWithMocks = htmlWithStubs.replace(/(<body[^>]*>)/i, `$1${APPACADABRA_MOCKS}`);

        const dom = new JSDOM(htmlWithMocks, {
            runScripts: 'dangerously',
            pretendToBeVisual: true,
            url: 'https://app.appacadabra.local/',
        });

        // Capture script errors during synchronous initialization
        dom.window.addEventListener('error', (e: ErrorEvent) => {
            if (!isJsdomFalsePositive(e.message)) {
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

        dom.window.close();
    } catch (e: any) {
        // jsdom crash — HTML muito quebrado
        errors.push({
            type: 'html',
            message: `Failed to parse/render HTML: ${e.message}`,
            fixable: true
        });
    }

    return {
        valid: errors.length === 0,
        errors,
        canRetry: errors.some(e => e.fixable),
    };
}
