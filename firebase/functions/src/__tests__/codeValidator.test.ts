/**
 * Unit tests for codeValidator.ts
 */

import { validateGeneratedCode, generateFixPrompt, ValidationError } from '../codeValidator';

describe('codeValidator', () => {
    describe('validateGeneratedCode', () => {
        it('should return valid for well-formed HTML with script and style', () => {
            const validHtml = `
        <html>
        <head>
          <style>
            body { margin: 0; }
          </style>
        </head>
        <body>
          <div>Hello</div>
          <script>
            console.log('hello');
          </script>
        </body>
        </html>
      `;

            const result = validateGeneratedCode(validHtml);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('should detect missing script tag', () => {
            const htmlNoScript = `
        <html>
        <head>
          <style>body { margin: 0; }</style>
        </head>
        <body><div>Hello</div></body>
        </html>
      `;

            const result = validateGeneratedCode(htmlNoScript);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.type === 'html' && e.message.includes('script'))).toBe(true);
        });

        it('should detect missing style tag', () => {
            const htmlNoStyle = `
        <html>
        <body>
          <div>Hello</div>
          <script>console.log('hi');</script>
        </body>
        </html>
      `;

            const result = validateGeneratedCode(htmlNoStyle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.type === 'html' && e.message.includes('style'))).toBe(true);
        });

        it('should detect mismatched braces in JavaScript', () => {
            const htmlBadJs = `
        <html>
        <style>body{}</style>
        <body>
          <script>
            function test() {
              if (true) {
                console.log('missing closing brace');
            }
          </script>
        </body>
        </html>
      `;

            const result = validateGeneratedCode(htmlBadJs);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.type === 'js' && e.message.includes('braces'))).toBe(true);
        });

        it('should detect mismatched parentheses in JavaScript', () => {
            const htmlBadParens = `
        <html>
        <style>body{}</style>
        <body>
          <script>
            if (true {
              console.log('hi');
            }
          </script>
        </body>
        </html>
      `;

            const result = validateGeneratedCode(htmlBadParens);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.type === 'js' && e.message.includes('parentheses'))).toBe(true);
        });

        it('should detect function typo', () => {
            const htmlTypo = `
        <html>
        <style>body{}</style>
        <body>
          <script>
            fucntion test() { return 1; }
          </script>
        </body>
        </html>
      `;

            const result = validateGeneratedCode(htmlTypo);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.message.includes('function'))).toBe(true);
        });

        it('should detect CSS brace mismatch', () => {
            const htmlBadCss = `
        <html>
        <style>
          body { margin: 0;
          .container { padding: 10px; }
        </style>
        <script>console.log('hi');</script>
        <body></body>
        </html>
      `;

            const result = validateGeneratedCode(htmlBadCss);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.type === 'css' && e.message.includes('braces'))).toBe(true);
        });

        it('regression: detects unclosed <style> tag (spell j6P8qyl7aBskj8SJhT2a "Fábrica de Sonhos" shipped as a blank page)', () => {
            // The published HTML for spell j6P8qyl7aBskj8SJhT2a had an opening <style>
            // with no matching </style> before </head>. Browsers parsed the entire body
            // as CSS text, so the store iframe and the in-app WebView rendered white.
            // validateHtmlStructure must flag mismatched <style> open/close counts so the
            // auto-fix loop can repair the document before publish.
            const htmlUnclosedStyle = `
        <html>
        <head>
          <style>
            body { margin: 0; background: #fff; }
        </head>
        <body>
          <div>Hello</div>
          <script>console.log('hi');</script>
        </body>
        </html>
      `;

            const result = validateGeneratedCode(htmlUnclosedStyle);

            expect(result.valid).toBe(false);
            expect(
                result.errors.some(
                    e => e.type === 'html' && /unclosed\s+<style>/i.test(e.message)
                )
            ).toBe(true);
        });

        it('does not flag a properly balanced <style> tag', () => {
            const htmlBalancedStyle = `
        <html>
        <head>
          <style>body { margin: 0; }</style>
        </head>
        <body>
          <div>Hi</div>
          <script>console.log('hi');</script>
        </body>
        </html>
      `;

            const result = validateGeneratedCode(htmlBalancedStyle);

            expect(
                result.errors.some(
                    e => e.type === 'html' && /unclosed\s+<style>/i.test(e.message)
                )
            ).toBe(false);
        });

        it('should detect inline callbacks in Appacadabra API calls', () => {
            const htmlBadCallback = `
        <html>
        <style>body{}</style>
        <body>
          <script>
            AppacadabraStorage.get('key', function(result) {
              console.log(result);
            });
          </script>
        </body>
        </html>
      `;

            const result = validateGeneratedCode(htmlBadCallback);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.message.includes('callback'))).toBe(true);
        });
    });

    describe('generateFixPrompt', () => {
        it('should generate a prompt with error list', () => {
            const errors: ValidationError[] = [
                { type: 'js', message: 'Mismatched braces', fixable: true },
                { type: 'css', message: 'Invalid selector', fixable: false }
            ];
            const originalCode = '<html><body></body></html>';

            const prompt = generateFixPrompt(errors, originalCode);

            expect(prompt).toContain('[JS] Mismatched braces');
            expect(prompt).toContain('[CSS] Invalid selector');
            expect(prompt).toContain('```html');
            expect(prompt).toContain(originalCode);
        });
    });
});
