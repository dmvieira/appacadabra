/**
 * Client-side execution validator (regex + AST-lite, no JSDOM).
 *
 * The server validator (`firebase/functions/src/executionValidator.ts`) spins
 * up JSDOM, mounts mocked Appacadabra APIs, and invokes every `onclick`
 * handler to surface frozen-button bugs. JSDOM isn't available in RN, so we
 * approximate with three cheap structural checks against the raw HTML/JS:
 *
 *   1. Every inline event handler attribute (`onclick="foo()"` etc.) points at
 *      a function that is at least *declared* in the script.
 *   2. Every `Appacadabra<Cap>.method` call references a known capability id.
 *   3. Every `addEventListener('click', handlerName)` with a bare name has the
 *      named handler declared somewhere.
 *
 * Coverage is roughly 70% of what the server catches (the planner+coder
 * pipeline plus the codeValidator covers the long tail of obvious failures).
 * False positives are kept low by only flagging clearly missing identifiers.
 */

import { ValidationError, ValidationResult } from './codeValidator';
import { ALL_CAPABILITIES } from '../capabilities';

const INLINE_EVENT_ATTRS = [
    'onclick',
    'ondblclick',
    'onmousedown',
    'onmouseup',
    'onmouseover',
    'onmouseout',
    'onmouseenter',
    'onmouseleave',
    'onchange',
    'oninput',
    'onsubmit',
    'onfocus',
    'onblur',
    'onkeydown',
    'onkeyup',
    'onkeypress',
    'ontouchstart',
    'ontouchend',
    'onload',
    'onerror',
];

function extractScripts(html: string): string {
    const matches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    let combined = '';
    for (const m of matches) {
        if (m[1]) combined += m[1] + '\n';
    }
    return combined;
}

/**
 * Strip JS comments and string literals before searching for declarations, so
 * that a string like `"function foo"` inside the source doesn't get treated as
 * a real declaration.
 */
function stripCommentsAndStrings(js: string): string {
    return js
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/`(?:\\.|[^\\`])*`/g, '""')
        .replace(/"(?:\\.|[^\\"])*"/g, '""')
        .replace(/'(?:\\.|[^\\'])*'/g, "''");
}

/**
 * Returns true if `js` declares an identifier that a runtime call site of the
 * form `name(...)` could resolve to. Catches:
 *   - function declarations
 *   - var/let/const bindings
 *   - assignments to `name`, `window.name`, `globalThis.name`, `self.name`
 *   - class declarations
 */
function declaresIdentifier(js: string, name: string): boolean {
    const safe = stripCommentsAndStrings(js);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
        new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`),
        new RegExp(`\\b(?:var|let|const)\\s+${escaped}\\b`),
        new RegExp(`\\bclass\\s+${escaped}\\b`),
        new RegExp(`\\bwindow\\.${escaped}\\s*=`),
        new RegExp(`\\bglobalThis\\.${escaped}\\s*=`),
        new RegExp(`\\bself\\.${escaped}\\s*=`),
        // Top-level assignment: `name = ...` (not inside an object literal field).
        new RegExp(`(^|;|\\n)\\s*${escaped}\\s*=`),
    ];
    return patterns.some(p => p.test(safe));
}

function findInlineHandlerCalls(html: string): Array<{ attr: string; fnName: string }> {
    const found: Array<{ attr: string; fnName: string }> = [];
    for (const attr of INLINE_EVENT_ATTRS) {
        const re = new RegExp(`\\b${attr}\\s*=\\s*"([^"]+)"`, 'gi');
        let match: RegExpExecArray | null;
        while ((match = re.exec(html)) !== null) {
            const expr = match[1] ?? '';
            const fnMatch = expr.match(/^\s*([a-zA-Z_$][\w$]*)\s*\(/);
            if (fnMatch) {
                found.push({ attr, fnName: fnMatch[1] });
            }
        }
    }
    return found;
}

const APPACADABRA_BROWSER_GLOBALS = new Set([
    'alert',
    'confirm',
    'prompt',
    'console',
    'document',
    'window',
    'history',
    'localStorage',
    'sessionStorage',
    'navigator',
    'location',
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'fetch',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'JSON',
    'Math',
    'Date',
    'parseInt',
    'parseFloat',
    'isNaN',
    'isFinite',
    'encodeURIComponent',
    'decodeURIComponent',
    'String',
    'Number',
    'Boolean',
    'Array',
    'Object',
    'Promise',
    'Error',
    'Event',
    'CustomEvent',
    'FormData',
    'URLSearchParams',
    'btoa',
    'atob',
    'this',
    'return',
    'void',
    'event',
]);

function validateInlineHandlers(html: string, js: string): ValidationError[] {
    const errors: ValidationError[] = [];
    const calls = findInlineHandlerCalls(html);
    const seen = new Set<string>();
    for (const { fnName } of calls) {
        if (APPACADABRA_BROWSER_GLOBALS.has(fnName)) continue;
        if (seen.has(fnName)) continue;
        seen.add(fnName);
        if (!declaresIdentifier(js, fnName)) {
            errors.push({
                type: 'js',
                message: `Inline handler "${fnName}" is not defined — button will be frozen when triggered`,
                fixable: true,
            });
        }
    }
    return errors;
}

function validateAddEventListener(js: string): ValidationError[] {
    const errors: ValidationError[] = [];
    const safe = stripCommentsAndStrings(js);
    // Match addEventListener('event', handlerName) — only flag when the
    // 2nd arg is a bare identifier (not an inline function, not a call).
    const re = /\.addEventListener\s*\(\s*['"][^'"]*['"]\s*,\s*([a-zA-Z_$][\w$]*)\s*[\),]/g;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((match = re.exec(safe)) !== null) {
        const fnName = match[1];
        if (seen.has(fnName)) continue;
        seen.add(fnName);
        if (APPACADABRA_BROWSER_GLOBALS.has(fnName)) continue;
        if (!declaresIdentifier(js, fnName)) {
            errors.push({
                type: 'js',
                message: `addEventListener handler "${fnName}" is not defined — event will not fire`,
                fixable: true,
            });
        }
    }
    return errors;
}

function buildKnownCapabilityNames(): Set<string> {
    // `displayName` is the source of truth for the bridge namespace
    // (`window.Appacadabra<displayName>`). Deriving it from `cap.id` misses
    // acronym casing — `ai`/`ui` would resolve to `Ai`/`Ui` while the bridge
    // registers `AI`/`UI`, producing false-positive validation errors.
    const names = new Set<string>();
    for (const cap of ALL_CAPABILITIES) {
        names.add(`Appacadabra${cap.displayName}`);
    }
    return names;
}

function validateCapabilityReferences(js: string): ValidationError[] {
    const errors: ValidationError[] = [];
    const known = buildKnownCapabilityNames();
    const safe = stripCommentsAndStrings(js);
    const re = /\b(Appacadabra[A-Z][a-zA-Z0-9_]*)\b/g;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((match = re.exec(safe)) !== null) {
        const name = match[1];
        if (seen.has(name)) continue;
        seen.add(name);
        // Allow `Appacadabra` namespace itself (e.g., `window.Appacadabra`).
        if (name === 'Appacadabra') continue;
        if (!known.has(name)) {
            errors.push({
                type: 'js',
                message: `Unknown Appacadabra capability "${name}" — not registered in this app version`,
                fixable: true,
            });
        }
    }
    return errors;
}

export function validateWithExecution(html: string): ValidationResult {
    const errors: ValidationError[] = [];
    const js = extractScripts(html);

    if (js.trim().length > 0) {
        errors.push(...validateInlineHandlers(html, js));
        errors.push(...validateAddEventListener(js));
        errors.push(...validateCapabilityReferences(js));
    } else {
        // No <script> in the doc — codeValidator already flags this.
    }

    return {
        valid: errors.length === 0,
        errors,
        canRetry: errors.some(e => e.fixable),
    };
}
