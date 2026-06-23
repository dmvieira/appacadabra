/**
 * Code validator for generated HTML/JS/CSS — client port.
 *
 * Mirrors `firebase/functions/src/codeValidator.ts` exactly, except for the
 * JavaScript syntax check: the server uses Node's `vm.Script(js)` which is
 * not available in React Native. We swap in `new Function(js)`, which throws
 * `SyntaxError` on the same set of parse errors that matter for spell HTML
 * (no top-level `await` is expected — spells use callbacks).
 *
 * All other heuristics (typos, brace/paren balance, callback pattern,
 * solid-color screen detector) are copied verbatim so the auto-fix loop
 * behaves the same as the server.
 */

export interface ValidationError {
    type: 'html' | 'js' | 'css';
    message: string;
    line?: number;
    fixable: boolean;
}

export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    canRetry: boolean;
}

function validateHtmlStructure(html: string): ValidationError[] {
    const errors: ValidationError[] = [];

    if (!html.includes('<html') && !html.includes('<body') && !html.includes('<div')) {
        errors.push({
            type: 'html',
            message: 'Missing basic HTML structure (no html, body, or div tags found)',
            fixable: true,
        });
    }

    if (html.includes('<html') && !html.includes('</html>')) {
        errors.push({ type: 'html', message: 'Missing </html> closing tag — HTML may be truncated', fixable: true });
    }
    if (html.includes('<body') && !html.includes('</body>')) {
        errors.push({ type: 'html', message: 'Missing </body> closing tag — HTML may be truncated', fixable: true });
    }

    const scriptOpenCount = (html.match(/<script\b/gi) || []).length;
    const scriptCloseCount = (html.match(/<\/script>/gi) || []).length;
    if (scriptOpenCount > scriptCloseCount) {
        errors.push({
            type: 'html',
            message: `Unclosed <script> tag — HTML may be truncated (${scriptOpenCount} open, ${scriptCloseCount} closed)`,
            fixable: true,
        });
    }
    const styleOpenCount = (html.match(/<style\b/gi) || []).length;
    const styleCloseCount = (html.match(/<\/style>/gi) || []).length;
    if (styleOpenCount > styleCloseCount) {
        errors.push({
            type: 'html',
            message: `Unclosed <style> tag — body content will render as CSS text (${styleOpenCount} open, ${styleCloseCount} closed)`,
            fixable: true,
        });
    }

    if (!html.includes('<script')) {
        errors.push({
            type: 'html',
            message: 'No <script> tag found - app has no JavaScript',
            fixable: false,
        });
    }

    if (!html.includes('<style')) {
        errors.push({
            type: 'html',
            message: 'No <style> tag found - app has no CSS styling',
            fixable: false,
        });
    }

    return errors;
}

function parseSyntax(js: string): SyntaxError | null {
    try {
        // `new Function(body)` parses the body at construction time and
        // throws SyntaxError on bad parse. Same shape of check as the server's
        // `new vm.Script(js)` for the syntax errors we care about.
        // eslint-disable-next-line no-new-func
        new Function(js);
        return null;
    } catch (e) {
        if (e instanceof SyntaxError) return e;
        return null;
    }
}

function validateJavaScript(js: string): ValidationError[] {
    const errors: ValidationError[] = [];

    const syntaxErr = parseSyntax(js);
    if (syntaxErr) {
        const lineMatch = syntaxErr.stack?.match(/<anonymous>:(\d+):\d+/);
        const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : null;
        const problematicLine = lineNum ? js.split('\n')[lineNum - 1]?.trim() : null;
        errors.push({
            type: 'js',
            message: `JavaScript syntax error: ${syntaxErr.message}${
                lineNum ? ` (line ${lineNum}${problematicLine ? `: \`${problematicLine}\`` : ''})` : ''
            }`,
            fixable: true,
        });
        return errors;
    }

    if (js.includes('fucntion') || js.includes('funtion')) {
        errors.push({ type: 'js', message: 'Typo in "function" keyword', fixable: true });
    }

    if (js.includes('retrun') || js.includes('reutrn')) {
        errors.push({ type: 'js', message: 'Typo in "return" keyword', fixable: true });
    }

    const incompletePatterns = [/if\s*\(\s*\)\s*\{/, /for\s*\(\s*;\s*;\s*\)\s*\{/];
    for (const pattern of incompletePatterns) {
        if (pattern.test(js)) {
            errors.push({ type: 'js', message: 'Incomplete JavaScript statement detected', fixable: true });
            break;
        }
    }

    const badCallbackPattern = /(Appacadabra\w+\.\w+\([^)]*,\s*)(function\s*\(|(\([^)]*\)\s*=>))/g;
    if (badCallbackPattern.test(js)) {
        errors.push({
            type: 'js',
            message: 'Inline callback detected in Appacadabra API call - should use global function name string',
            fixable: true,
        });
    }

    const openBraces = (js.match(/\{/g) || []).length;
    const closeBraces = (js.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
        errors.push({
            type: 'js',
            message: `Mismatched braces in JavaScript: ${openBraces} opening, ${closeBraces} closing`,
            fixable: true,
        });
    }

    const openParens = (js.match(/\(/g) || []).length;
    const closeParens = (js.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
        errors.push({
            type: 'js',
            message: `Mismatched parentheses in JavaScript: ${openParens} opening, ${closeParens} closing`,
            fixable: true,
        });
    }

    return errors;
}

function validateCss(css: string): ValidationError[] {
    const errors: ValidationError[] = [];

    const openBraces = (css.match(/\{/g) || []).length;
    const closeBraces = (css.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
        errors.push({
            type: 'css',
            message: `Mismatched braces in CSS: ${openBraces} opening, ${closeBraces} closing`,
            fixable: true,
        });
    }

    if (css.includes(';;')) {
        errors.push({ type: 'css', message: 'Double semicolons detected in CSS', fixable: true });
    }

    return errors;
}

function checkSolidColorScreen(html: string): string | null {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyContent = bodyMatch ? bodyMatch[1] : html;
    const strippedText = bodyContent.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const interactiveElements = (bodyContent.match(/<(button|input|select|textarea|a\s)[^>]*>/gi) || []).length;
    const hasMinimalContent = strippedText.length < 20 && interactiveElements === 0;

    if (!hasMinimalContent) return null;

    const styleBlocks = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
    for (const block of styleBlocks) {
        const css = block.replace(/<\/?style[^>]*>/gi, '');
        if (/(?:body|html|:root|\*)\s*\{[^}]*background(?:-color)?/i.test(css)) {
            return 'Generated HTML appears to be a solid-color screen with no interactive content';
        }
    }
    return null;
}

export function validateGeneratedCode(html: string): ValidationResult {
    const errors: ValidationError[] = [];

    errors.push(...validateHtmlStructure(html));

    const scriptMatches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of scriptMatches) {
        if (match[1] && match[1].trim().length > 0) {
            errors.push(...validateJavaScript(match[1]));
        }
    }

    const styleMatches = html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    for (const match of styleMatches) {
        if (match[1] && match[1].trim().length > 0) {
            errors.push(...validateCss(match[1]));
        }
    }

    const solidColorError = checkSolidColorScreen(html);
    if (solidColorError) {
        errors.push({ type: 'html', message: solidColorError, fixable: true });
    }

    const canRetry = errors.some(e => e.fixable);

    return {
        valid: errors.length === 0,
        errors,
        canRetry,
    };
}

export function generateFixPrompt(errors: ValidationError[], originalCode: string): string {
    const errorList = errors.map(e => `- [${e.type.toUpperCase()}] ${e.message}`).join('\n');

    return `The following errors were found in the generated code:

${errorList}

Please fix these errors. Return the corrected complete HTML file wrapped in \`\`\`html ... \`\`\`

Current code:
\`\`\`html
${originalCode}
\`\`\``;
}
