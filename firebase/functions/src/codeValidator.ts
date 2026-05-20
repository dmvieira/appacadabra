/**
 * Code Validator for Generated HTML/JS/CSS
 * Deterministic validation to catch common generation errors
 */

import * as vm from 'vm';

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

/**
 * Validate generated HTML structure
 */
function validateHtmlStructure(html: string): ValidationError[] {
    const errors: ValidationError[] = [];

    // Check for basic HTML structure
    if (!html.includes('<html') && !html.includes('<body') && !html.includes('<div')) {
        errors.push({
            type: 'html',
            message: 'Missing basic HTML structure (no html, body, or div tags found)',
            fixable: true
        });
    }

    // Check for unclosed common tags - REMOVED
    // Naive regex counting causes false positives when tags appear in JS strings or content
    // We rely on the browser/webview to handle minor HTML malformations

    // Truncation detection
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
            fixable: true
        });
    }

    // Check for script tags
    if (!html.includes('<script')) {
        errors.push({
            type: 'html',
            message: 'No <script> tag found - app has no JavaScript',
            fixable: false
        });
    }

    // Check for style tags
    if (!html.includes('<style')) {
        errors.push({
            type: 'html',
            message: 'No <style> tag found - app has no CSS styling',
            fixable: false
        });
    }

    return errors;
}

/**
 * Validate JavaScript syntax using basic pattern matching
 * Note: We can't use eval/Function in production, so we use heuristics
 */
function validateJavaScript(js: string): ValidationError[] {
    const errors: ValidationError[] = [];

    // Real syntax check — compile only, no execution
    try {
        new vm.Script(js);
    } catch (e: any) {
        if (e instanceof SyntaxError) {
            const lineMatch = (e as any).stack?.match(/<anonymous>:(\d+):\d+/);
            const lineNum = lineMatch ? parseInt(lineMatch[1]) : null;
            const problematicLine = lineNum ? js.split('\n')[lineNum - 1]?.trim() : null;
            errors.push({
                type: 'js',
                message: `JavaScript syntax error: ${e.message}${lineNum ? ` (line ${lineNum}${problematicLine ? `: \`${problematicLine}\`` : ''})` : ''}`,
                fixable: true
            });
            return errors;
        }
    }

    // Check for common typos/mistakes
    if (js.includes('fucntion') || js.includes('funtion')) {
        errors.push({
            type: 'js',
            message: 'Typo in "function" keyword',
            fixable: true
        });
    }

    if (js.includes('retrun') || js.includes('reutrn')) {
        errors.push({
            type: 'js',
            message: 'Typo in "return" keyword',
            fixable: true
        });
    }

    // Check for incomplete statements
    const incompletePatterns = [
        /if\s*\(\s*\)\s*{/,                    // empty if condition
        /for\s*\(\s*;\s*;\s*\)\s*{/,           // incomplete for loop
    ];

    for (const pattern of incompletePatterns) {
        if (pattern.test(js)) {
            errors.push({
                type: 'js',
                message: `Incomplete JavaScript statement detected`,
                fixable: true
            });
            break;
        }
    }

    // Check for Appacadabra callback pattern issues
    const badCallbackPattern = /(Appacadabra\w+\.\w+\([^)]*,\s*)(function\s*\(|(\([^)]*\)\s*=>))/g;
    if (badCallbackPattern.test(js)) {
        errors.push({
            type: 'js',
            message: 'Inline callback detected in Appacadabra API call - should use global function name string',
            fixable: true
        });
    }

    // Count braces
    const openBraces = (js.match(/\{/g) || []).length;
    const closeBraces = (js.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
        errors.push({
            type: 'js',
            message: `Mismatched braces in JavaScript: ${openBraces} opening, ${closeBraces} closing`,
            fixable: true
        });
    }

    // Count parentheses
    const openParens = (js.match(/\(/g) || []).length;
    const closeParens = (js.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
        errors.push({
            type: 'js',
            message: `Mismatched parentheses in JavaScript: ${openParens} opening, ${closeParens} closing`,
            fixable: true
        });
    }

    return errors;
}

/**
 * Validate CSS syntax
 */
function validateCss(css: string): ValidationError[] {
    const errors: ValidationError[] = [];

    // Count braces
    const openBraces = (css.match(/{/g) || []).length;
    const closeBraces = (css.match(/}/g) || []).length;
    if (openBraces !== closeBraces) {
        errors.push({
            type: 'css',
            message: `Mismatched braces in CSS: ${openBraces} opening, ${closeBraces} closing`,
            fixable: true
        });
    }

    // Check for common CSS errors
    if (css.includes(';;')) {
        errors.push({
            type: 'css',
            message: 'Double semicolons detected in CSS',
            fixable: true
        });
    }

    // Check for empty rules - REMOVED
    // Empty CSS rules are benign and removing them is an optimization, not a validation requirement

    return errors;
}

function checkSolidColorScreen(html: string): string | null {
    // Signal 1: very little visible content
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyContent = bodyMatch ? bodyMatch[1] : html;
    const strippedText = bodyContent.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const interactiveElements = (bodyContent.match(/<(button|input|select|textarea|a\s)[^>]*>/gi) || []).length;
    const hasMinimalContent = strippedText.length < 20 && interactiveElements === 0;

    if (!hasMinimalContent) return null;

    // Signal 2: solid background on a top-level selector
    const styleBlocks = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
    for (const block of styleBlocks) {
        const css = block.replace(/<\/?style[^>]*>/gi, '');
        if (/(?:body|html|:root|\*)\s*\{[^}]*background(?:-color)?/i.test(css)) {
            return 'Generated HTML appears to be a solid-color screen with no interactive content';
        }
    }
    return null;
}

/**
 * Main validation function - validates entire HTML file
 */
export function validateGeneratedCode(html: string): ValidationResult {
    const errors: ValidationError[] = [];

    // 1. Validate HTML structure
    errors.push(...validateHtmlStructure(html));

    // 2. Extract and validate JavaScript
    const scriptMatches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of scriptMatches) {
        if (match[1] && match[1].trim().length > 0) {
            errors.push(...validateJavaScript(match[1]));
        }
    }

    // 3. Extract and validate CSS
    const styleMatches = html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    for (const match of styleMatches) {
        if (match[1] && match[1].trim().length > 0) {
            errors.push(...validateCss(match[1]));
        }
    }

    // 4. Check for solid-color screen (broken generation)
    const solidColorError = checkSolidColorScreen(html);
    if (solidColorError) {
        errors.push({ type: 'html', message: solidColorError, fixable: true });
    }

    // Determine if we can retry
    const canRetry = errors.some(e => e.fixable);

    return {
        valid: errors.length === 0,
        errors,
        canRetry
    };
}

/**
 * Generate a fix prompt based on validation errors
 */
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
