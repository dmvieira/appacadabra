/**
 * HTML utility functions for WebView content preparation.
 */

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">';

// Regex to match any existing viewport meta tag (case-insensitive, handles single/double quotes)
const VIEWPORT_REGEX = /<meta\s+[^>]*name\s*=\s*["']viewport["'][^>]*>/gi;

/**
 * Ensures the given HTML code contains a correct viewport meta tag.
 * - If a viewport meta exists but is incomplete, replaces it.
 * - If no viewport meta exists but a <head> exists, inserts one after <head>.
 * - If no <head> exists, inserts <head> with viewport before <body> or at start.
 */
export function ensureViewportMeta(code: string): string {
    const existing = code.match(VIEWPORT_REGEX);

    if (existing) {
        // Check if the existing tag already has the correct content
        const first = existing[0];
        if (first.includes('width=device-width') && first.includes('initial-scale')) {
            return code; // Already correct
        }
        // Replace the first occurrence with our standard viewport
        return code.replace(VIEWPORT_REGEX, VIEWPORT_META);
    }

    // No viewport meta found — insert one
    const headMatch = code.match(/<head[^>]*>/i);
    if (headMatch) {
        // Insert right after <head>
        return code.replace(headMatch[0], headMatch[0] + '\n' + VIEWPORT_META);
    }

    // No <head> tag at all — add before <body> or at the start
    const bodyMatch = code.match(/<body[^>]*>/i);
    if (bodyMatch) {
        return code.replace(bodyMatch[0], `<head>${VIEWPORT_META}</head>\n${bodyMatch[0]}`);
    }

    // Fallback: prepend viewport meta at the very beginning
    return VIEWPORT_META + '\n' + code;
}
