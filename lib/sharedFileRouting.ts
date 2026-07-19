// Picks the right `<input type="file">` to receive a shared file based on
// each input's `accept` attribute. Used by the WebView share-content handler
// (lib/bridges/injectedJS.ts) — the same logic is also embedded as inline JS
// inside the injected script, since the script is a static string. Keep the
// two ports in sync.

/**
 * Returns true if a file with the given mimeType/fileName satisfies the
 * `accept` attribute per the HTML5 spec. Token rules:
 *   - Contains '/': MIME pattern. Trailing '/*' → prefix-match; else exact.
 *   - Starts with '.': extension. Case-insensitive suffix match on fileName.
 *   - '*' or '*\/*': catch-all.
 * Empty/blank accept is treated as catch-all (input takes anything).
 * Any of the comma-separated tokens matching is enough to satisfy accept.
 */
export function matchesAccept(accept: string, mimeType: string, fileName: string): boolean {
    const acc = (accept || '').trim().toLowerCase();
    if (!acc) return true;

    const mime = (mimeType || '').trim().toLowerCase();
    const name = (fileName || '').toLowerCase();

    const tokens = acc.split(',').map(t => t.trim()).filter(Boolean);
    if (tokens.length === 0) return true;

    for (const token of tokens) {
        if (token === '*' || token === '*/*') return true;

        if (token.startsWith('.')) {
            if (name.endsWith(token)) return true;
            continue;
        }

        if (token.includes('/')) {
            if (token.endsWith('/*')) {
                const prefix = token.slice(0, -1); // keep the slash: "image/"
                if (mime.startsWith(prefix)) return true;
            } else if (mime === token) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Picks the first `<input type="file">` (in DOM order) whose `accept` matches
 * the shared content, or null if none match.
 *
 * Note: an input without an `accept` attribute (or with `accept=""`) is
 * treated as catch-all — this preserves the pre-fix behavior for spells with
 * a single generic uploader. When accept-having and accept-less inputs are
 * mixed, DOM order still wins (an accept-less input later in the DOM only
 * gets picked if every earlier accept-having input rejects the content).
 */
export function pickFileInputElement(
    inputs: HTMLInputElement[] | NodeListOf<HTMLInputElement>,
    mimeType: string,
    fileName: string,
): HTMLInputElement | null {
    const list = Array.from(inputs);
    for (const input of list) {
        const accept = input.getAttribute('accept') || '';
        if (matchesAccept(accept, mimeType, fileName)) {
            return input;
        }
    }
    return null;
}
