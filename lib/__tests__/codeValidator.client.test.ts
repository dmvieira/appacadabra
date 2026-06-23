/**
 * Client port of `firebase/functions/src/__tests__/codeValidator.test.ts`
 * fixtures. The server uses `vm.Script` for syntax checks; the client port
 * uses `new Function()` — but the surface-level pass/fail must stay the same
 * so the auto-fix loop behaves identically.
 */

import {
    validateGeneratedCode,
    generateFixPrompt,
    ValidationError,
} from '../validators/codeValidator';

describe('codeValidator (client port)', () => {
    it('returns valid for well-formed HTML', () => {
        const html = `
            <html>
            <head><style>body { margin: 0; }</style></head>
            <body>
                <div>Hello</div>
                <script>console.log('hi');</script>
            </body>
            </html>
        `;
        const result = validateGeneratedCode(html);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it('detects missing <script>', () => {
        const html = `<html><head><style>body{}</style></head><body><div>X</div></body></html>`;
        const result = validateGeneratedCode(html);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.type === 'html' && e.message.includes('script'))).toBe(true);
    });

    it('detects missing <style>', () => {
        const html = `<html><body><div>X</div><script>1</script></body></html>`;
        const result = validateGeneratedCode(html);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.type === 'html' && e.message.includes('style'))).toBe(true);
    });

    it('detects mismatched braces in JS', () => {
        const html = `<html><style>body{}</style><body><script>
            function bad(){ if(true){ console.log('x'); }
        </script></body></html>`;
        const result = validateGeneratedCode(html);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.type === 'js')).toBe(true);
    });

    it('detects mismatched parentheses in JS', () => {
        const html = `<html><style>body{}</style><body><script>
            if (true { console.log('hi'); }
        </script></body></html>`;
        const result = validateGeneratedCode(html);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.type === 'js')).toBe(true);
    });

    it('detects "fucntion" typo via syntax check', () => {
        // Either the dedicated typo heuristic catches it, or the syntax check
        // does — both outcomes mean the auto-fix loop will run.
        const html = `<html><style>body{}</style><body><script>fucntion x(){return 1;}</script></body></html>`;
        const result = validateGeneratedCode(html);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.type === 'js')).toBe(true);
    });

    it('detects unclosed <style> (the j6P8qyl7aBskj8SJhT2a regression)', () => {
        const html = `
            <html><head><style>body { margin: 0; }</head>
            <body><div>X</div><script>1</script></body></html>
        `;
        const result = validateGeneratedCode(html);
        expect(
            result.errors.some(e => e.type === 'html' && /unclosed\s+<style>/i.test(e.message)),
        ).toBe(true);
    });

    it('detects inline callbacks in Appacadabra API calls', () => {
        const html = `<html><style>body{}</style><body><script>
            AppacadabraStorage.get('key', function(result) { console.log(result); });
        </script></body></html>`;
        const result = validateGeneratedCode(html);
        expect(result.errors.some(e => e.message.includes('callback'))).toBe(true);
    });

    it('generateFixPrompt embeds the error list and original code', () => {
        const errors: ValidationError[] = [
            { type: 'js', message: 'Mismatched braces', fixable: true },
            { type: 'css', message: 'Bad selector', fixable: false },
        ];
        const prompt = generateFixPrompt(errors, '<html></html>');
        expect(prompt).toContain('[JS] Mismatched braces');
        expect(prompt).toContain('[CSS] Bad selector');
        expect(prompt).toContain('<html></html>');
    });
});
