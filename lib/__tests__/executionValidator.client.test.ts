/**
 * Tests for the regex+AST-lite execution validator (client side, no JSDOM).
 *
 * We can't catch *every* frozen-button bug the JSDOM server validator
 * catches, but we must flag the most common failure modes deterministically.
 */

import { validateWithExecution } from '../validators/executionValidator';

function htmlWith(scriptBody: string, extraBodyHtml = '') {
    return `<html><head><style>body{}</style></head><body>${extraBodyHtml}<script>${scriptBody}</script></body></html>`;
}

describe('validateWithExecution', () => {
    it('returns valid when handlers and capabilities all resolve', () => {
        const html = htmlWith(
            `function greet(){ console.log('hi'); }`,
            `<button onclick="greet()">Hi</button>`,
        );
        const result = validateWithExecution(html);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it('flags an onclick handler that is never declared', () => {
        const html = htmlWith(`function other(){}`, `<button onclick="missing()">Go</button>`);
        const result = validateWithExecution(html);
        expect(result.valid).toBe(false);
        expect(
            result.errors.some(e => /Inline handler "missing"/.test(e.message)),
        ).toBe(true);
    });

    it('accepts a handler defined via window assignment', () => {
        const html = htmlWith(
            `window.onTap = function(){ console.log('x'); };`,
            `<button onclick="onTap()">Tap</button>`,
        );
        const result = validateWithExecution(html);
        expect(result.valid).toBe(true);
    });

    it('accepts a handler defined via const/let/var', () => {
        const html = htmlWith(
            `const onTap = () => console.log('y');`,
            `<button onclick="onTap()">Tap</button>`,
        );
        const result = validateWithExecution(html);
        expect(result.valid).toBe(true);
    });

    it('does not flag standard browser globals like alert/confirm', () => {
        const html = htmlWith(`var x = 1;`, `<button onclick="alert('hi')">A</button>`);
        const result = validateWithExecution(html);
        expect(result.valid).toBe(true);
    });

    it('flags addEventListener with a bare-name handler that is undefined', () => {
        const html = htmlWith(
            `document.body.addEventListener('click', missingHandler);`,
        );
        const result = validateWithExecution(html);
        expect(
            result.errors.some(e => /addEventListener handler "missingHandler"/.test(e.message)),
        ).toBe(true);
    });

    it('does not flag addEventListener with an inline function', () => {
        const html = htmlWith(
            `document.body.addEventListener('click', function(){ console.log('x'); });`,
        );
        const result = validateWithExecution(html);
        // No false positive on inline functions
        expect(result.errors.some(e => /addEventListener handler/.test(e.message))).toBe(false);
    });

    it('flags an unknown Appacadabra capability namespace', () => {
        const html = htmlWith(`AppacadabraNonexistentThing.doStuff();`);
        const result = validateWithExecution(html);
        expect(
            result.errors.some(e => /Unknown Appacadabra capability "AppacadabraNonexistentThing"/.test(e.message)),
        ).toBe(true);
    });

    it('accepts known capability namespaces from the registry', () => {
        const html = htmlWith(`AppacadabraCalendar.list('onResult');`);
        const result = validateWithExecution(html);
        expect(result.errors.some(e => /Unknown Appacadabra capability/.test(e.message))).toBe(false);
    });

    it('accepts acronym-cased namespaces registered by the bridge (AppacadabraAI, AppacadabraUI)', () => {
        // Regression: `pascal(cap.id)` used to produce "AppacadabraAi"/"AppacadabraUi",
        // but the bridge registers `window.AppacadabraAI`/`window.AppacadabraUI`
        // (per `displayName`). Every AI/UI-using spell hit a false-positive
        // validation error, forcing planner+coder retries.
        const html = htmlWith(
            `AppacadabraAI.generate('hi', 'onResult');`,
            `AppacadabraUI.toast('done', 'success');`,
        );
        const result = validateWithExecution(html);
        expect(result.errors.some(e => /Unknown Appacadabra capability "AppacadabraAI"/.test(e.message))).toBe(false);
        expect(result.errors.some(e => /Unknown Appacadabra capability "AppacadabraUI"/.test(e.message))).toBe(false);
    });

    it('does not treat strings containing "function foo" as declarations', () => {
        const html = htmlWith(
            `const msg = "function fooBar() {}";`,
            `<button onclick="fooBar()">x</button>`,
        );
        const result = validateWithExecution(html);
        expect(result.errors.some(e => /Inline handler "fooBar"/.test(e.message))).toBe(true);
    });
});
