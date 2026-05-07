import AsyncStorage from '@react-native-async-storage/async-storage';
import { createCallbackScript } from './mediaHelpers';
import { requestGoogleScopes } from '../firebase';
import { CapabilityModule, HandlerContext, HandlerResult, WebViewRef } from './types';

const SHEETS_CACHE_PREFIX = 'appacadabra_sheets_cache_';

async function loadSheetsCache(sheetId: string): Promise<{ headers: string[]; rows: Record<string, string>[] } | null> {
    try {
        const raw = await AsyncStorage.getItem(SHEETS_CACHE_PREFIX + sheetId);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function saveSheetsCache(sheetId: string, data: { headers: string[]; rows: Record<string, string>[] }): void {
    AsyncStorage.setItem(SHEETS_CACHE_PREFIX + sheetId, JSON.stringify(data))?.catch(() => {});
}

type Row = Record<string, string>;

// ── Module-level state ────────────────────────────────────────────────────────

interface SheetWatcher {
    interval: ReturnType<typeof setInterval>;
    webViewRef: WebViewRef;
    callbackName: string;
    snapshot: Row[] | null;
    skipNextPoll: boolean;
}

export const activeWatchers = new Map<string, SheetWatcher>();
export const resourceCache = new Map<string, { headers: string[]; rows: Row[] }>();
export const editModeLoadedKeys = new Set<string>();

export function cleanupWatchersForApp(appId: number | null): void {
    if (!appId) return;
    const prefix = `${appId}_`;
    for (const [key, watcher] of activeWatchers) {
        if (key.startsWith(prefix)) {
            clearInterval(watcher.interval);
            activeWatchers.delete(key);
        }
    }
}

export function cleanupEditModeForApp(appId: number | null): void {
    if (!appId) return;
    const prefix = `${appId}_`;
    for (const key of editModeLoadedKeys) {
        if (key.startsWith(prefix)) editModeLoadedKeys.delete(key);
    }
}

interface PendingWrite { execute: () => Promise<void>; }
export const writeQueue: PendingWrite[] = [];

export function isNetworkError(e: unknown): boolean {
    return e instanceof TypeError && e.message.includes('Network');
}

export async function flushWriteQueue(): Promise<void> {
    while (writeQueue.length > 0) {
        const item = writeQueue[0];
        try {
            await item.execute();
            writeQueue.shift();
        } catch (e) {
            if (isNetworkError(e)) break;
            writeQueue.shift(); // non-network error: discard and continue
        }
    }
}

export function computeDiff(prev: Row[], next: Row[]): { added: Row[]; changed: Row[]; deleted: Row[] } {
    const minLen = Math.min(prev.length, next.length);
    const changed: Row[] = [];
    for (let i = 0; i < minLen; i++) {
        if (JSON.stringify(prev[i]) !== JSON.stringify(next[i])) changed.push(next[i]);
    }
    return { added: next.slice(prev.length), changed, deleted: prev.slice(next.length) };
}

const SHEETS_SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

// ─────────────────────────────────────────────────────────────────────────────

export const sheetsCapability: CapabilityModule = {
    id: 'sheets',
    displayName: 'Sheets',
    minVersion: '1.0.0',

    docs: `📊 SHEETS (AppacadabraSheets) — Google Sign-In required (consent shown on first use only)
⚠️ **Restricted access:** \`getRows()\`, \`appendRows()\`, \`watchSheet()\` and \`setRows()\` work **only with spreadsheets created by this app via \`createSheet()\`**. Existing Google Sheets from the user cannot be accessed. If the user wants to use "their sales spreadsheet" or similar, explain the limitation and offer to create a new dedicated spreadsheet inside the app.

**Simple mode (insert-only, no sync):**
- \`createSheet(title, headers[], callback)\` — Creates a Google Spreadsheet
  - \`headers\`: optional column headers written to row 1 (e.g. \`["Name", "Date", "Status"]\`)
  - **Callback data**: \`{ sheetId, url }\`
- \`appendRows(sheetId, rows[][], callback)\` — Appends rows of raw data (string[][])
  - \`rows\`: array of arrays e.g. \`[["Alice", "2026-03-26", "Active"], ["Bob", "2026-03-25", "Pending"]]\`
  - **Callback data**: \`{ updatedRows }\` (number of rows added)
- \`getRows(sheetId, callback)\` — Reads all data; first row treated as headers
  - **Callback data**: \`{ headers: ["Name","Date"], rows: [{ "Name": "Alice", "Date": "2026-03-26" }, ...] }\`

**Native sync mode (recommended — no control columns in the spreadsheet):**

Use \`watchSheet\` + \`setRows\` in spells that need to display or edit data that may be changed externally (by other people or other devices). The capability handles all caching and diff detection — the spell only needs to render and save.

- \`watchSheet(sheetId, intervalMs, callbackName)\` — Starts polling for external changes
  - Fires **immediately** with current data (\`initial: true\`), then only when rows change
  - \`intervalMs\`: polling interval in ms (e.g. \`5000\` = every 5 s)
  - **Callback data (ok, data)**:
    - \`data.rows\`: all current rows as objects \`{ "Name": "Alice", ... }\`
    - \`data.headers\`: column names (string[])
    - \`data.added\`: rows added since last poll (empty on initial)
    - \`data.changed\`: rows modified since last poll (empty on initial)
    - \`data.deleted\`: rows removed since last poll (empty on initial)
    - \`data.initial\`: \`true\` on first call — use to populate the full UI
    - \`data.cached\`: \`true\` when offline and data comes from last successful read
  - Offline behaviour: fires with \`{ cached: true, ...lastKnownData }\`; if no cache ever: \`ok=false, { offline: true }\`
- \`stopWatchSheet(sheetId, callbackName)\` — Stops polling
  - **Callback data**: \`{ stopped: true }\`
- \`setRows(sheetId, rows[], callbackName)\` — Replaces ALL data rows (row objects), keeps headers
  - \`rows\`: \`[{ "Name": "Alice", "Date": "2026-03-26" }, ...]\` — pass \`[]\` to clear data while keeping headers
  - After write, the active watcher skips the next poll to avoid a spurious change event
  - Offline: queued and auto-replayed when connection returns; callback receives \`{ queued: true }\`
  - **Callback data**: \`{ rowsWritten: N }\` or \`{ queued: true }\`

**⚠️ RULE:** Never add control columns (\`__modified_at__\`, \`__sync__\`) to the spreadsheet — diffing is handled by the capability. Use \`appendRows\` + \`getRows\` only for insert-only spells (logs, checklists without editing).

**Usage (native sync):**
\`\`\`js
// 1. watchSheet: full render on initial load, incremental updates after
AppacadabraSheets.watchSheet(localStorage.getItem('sheetId'), 5000, 'onChanged');
window.onChanged = function(ok, data) {
  if (!ok) { if (data.offline) showBanner('No connection'); return; }
  if (data.cached) showBanner('Offline data');
  if (data.initial) {
    renderTable(data.headers, data.rows);   // full render only on first call
  } else {
    // Incremental updates: add/modify/remove rows without re-rendering everything
    data.added.forEach(row => appendRowToTable(row));
    data.changed.forEach(row => updateRowInTable(row));
    data.deleted.forEach(row => removeRowFromTable(row));
  }
};

// 2. setRows: optimistic update — update in-memory state BEFORE saving
function saveRows(rows) {
  state.rows = rows;
  renderTable(state.headers, state.rows);    // update UI immediately (optimistic)
  AppacadabraSheets.setRows(localStorage.getItem('sheetId'), rows, 'onSaved'); // persist to Sheets
  // Note: onChanged will NOT fire after setRows (internal mechanism prevents it)
  // Use localStorage only for app data that does NOT live in the spreadsheet (e.g. sheetId, settings)
}
window.onSaved = function(ok, data) {
  if (data.queued) showBanner('Saving when connection returns');
};

// 3. Stop when closing the screen
AppacadabraSheets.stopWatchSheet(localStorage.getItem('sheetId'), 'done');
\`\`\``,

    validationMock: `    window.AppacadabraSheets = apiProxy;`,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraSheets = {
    createSheet: function(title, headers, callbackName) {
      if (window.__IS_EDIT_MODE__) return;
      console.log('[AppacadabraSheets.createSheet] title:', title, 'callback:', callbackName);
      sendMessage('SHEETS_CREATE', { title, headers: headers || [] }, callbackName);
    },
    appendRows: function(sheetId, rows, callbackName) {
      if (window.__IS_EDIT_MODE__) return;
      console.log('[AppacadabraSheets.appendRows] sheetId:', sheetId, 'rows:', rows.length, 'callback:', callbackName);
      sendMessage('SHEETS_APPEND_ROWS', { sheetId, rows }, callbackName);
    },
    getRows: function(sheetId, callbackName) {
      console.log('[AppacadabraSheets.getRows] sheetId:', sheetId, 'callback:', callbackName);
      sendMessage('SHEETS_GET_ROWS', { sheetId }, callbackName);
    },
    watchSheet: function(sheetId, intervalMs, callbackName) {
      console.log('[AppacadabraSheets.watchSheet] sheetId:', sheetId, 'interval:', intervalMs, 'callback:', callbackName);
      sendMessage('SHEETS_WATCH', { sheetId, intervalMs: intervalMs || 5000, callbackName: callbackName }, callbackName);
    },
    stopWatchSheet: function(sheetId, callbackName) {
      console.log('[AppacadabraSheets.stopWatchSheet] sheetId:', sheetId, 'callback:', callbackName);
      sendMessage('SHEETS_STOP_WATCH', { sheetId }, callbackName);
    },
    setRows: function(sheetId, rows, callbackName) {
      if (window.__IS_EDIT_MODE__) return;
      console.log('[AppacadabraSheets.setRows] sheetId:', sheetId, 'rows:', rows.length, 'callback:', callbackName);
      sendMessage('SHEETS_SET_ROWS', { sheetId, rows }, callbackName);
    }
  };
`,

    handleMessage: async (type: string, data: any, ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        switch (type) {
            case 'SHEETS_CREATE': {
                console.log(`[Bridge] Sheets create: ${data.title}`);
                try {
                    const token = await requestGoogleScopes(SHEETS_SCOPES);
                    if (!token) {
                        return { success: false, result: 'Google Sheets access was denied. Please try again and grant permission.' };
                    }

                    const createRes = await fetch(SHEETS_API, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            properties: { title: data.title },
                            sheets: [{ properties: { title: 'Sheet1' } }],
                        }),
                    });
                    if (!createRes.ok) {
                        return { success: false, result: `Failed to create sheet: ${createRes.status} ${await createRes.text()}` };
                    }
                    const created = await createRes.json();
                    const spreadsheetId: string = created.spreadsheetId;

                    const headers: string[] = data.headers || [];
                    if (headers.length > 0) {
                        const appendRes = await fetch(
                            `${SHEETS_API}/${spreadsheetId}/values/Sheet1:append?valueInputOption=USER_ENTERED`,
                            {
                                method: 'POST',
                                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                                body: JSON.stringify({ values: [headers] }),
                            }
                        );
                        if (!appendRes.ok) {
                            return { success: false, result: `Failed to write headers: ${appendRes.status} ${await appendRes.text()}` };
                        }
                    }

                    return { success: true, result: JSON.stringify({ sheetId: spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` }) };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Sheets create error' };
                }
            }

            case 'SHEETS_APPEND_ROWS': {
                console.log(`[Bridge] Sheets append rows: ${data.sheetId}`);
                try {
                    const token = await requestGoogleScopes(SHEETS_SCOPES);
                    if (!token) {
                        return { success: false, result: 'Google Sheets access was denied. Please try again and grant permission.' };
                    }

                    const rows: string[][] = data.rows || [];
                    if (rows.length === 0) {
                        return { success: true, result: JSON.stringify({ updatedRows: 0 }) };
                    }

                    const appendRes = await fetch(
                        `${SHEETS_API}/${data.sheetId}/values/Sheet1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
                        {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ values: rows }),
                        }
                    );
                    if (!appendRes.ok) {
                        return { success: false, result: `Failed to append rows: ${appendRes.status} ${await appendRes.text()}` };
                    }
                    const appendData = await appendRes.json();

                    // Atualiza snapshot e cache para evitar callback espúrio no próximo poll
                    const key = `${ctx.appId}_${data.sheetId}`;
                    const watcher = activeWatchers.get(key);
                    const cached = resourceCache.get(data.sheetId);
                    if (watcher && cached) {
                        const newRowObjects: Row[] = rows.map((rawRow: string[]) =>
                            cached.headers.reduce((acc: Row, h, i) => { acc[h] = rawRow[i] ?? ''; return acc; }, {} as Row)
                        );
                        const updatedRows = [...cached.rows, ...newRowObjects];
                        watcher.snapshot = updatedRows;
                        resourceCache.set(data.sheetId, { headers: cached.headers, rows: updatedRows });
                        watcher.skipNextPoll = true;
                    }

                    return { success: true, result: JSON.stringify({ updatedRows: appendData.updates?.updatedRows ?? rows.length }) };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Sheets append rows error' };
                }
            }

            case 'SHEETS_GET_ROWS': {
                console.log(`[Bridge] Sheets get rows: ${data.sheetId}`);
                try {
                    const token = await requestGoogleScopes(SHEETS_SCOPES);
                    if (!token) {
                        return { success: false, result: 'Google Sheets access was denied. Please try again and grant permission.' };
                    }

                    const getRes = await fetch(`${SHEETS_API}/${data.sheetId}/values/Sheet1`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    if (!getRes.ok) {
                        const cached = resourceCache.get(data.sheetId) ?? await loadSheetsCache(data.sheetId);
                        if (cached) return { success: true, result: JSON.stringify({ ...cached, cached: true }) };
                        return { success: false, result: `Failed to get rows: ${getRes.status} ${await getRes.text()}` };
                    }
                    const getData = await getRes.json();
                    const values: string[][] = getData.values || [];
                    if (values.length === 0) {
                        return { success: true, result: JSON.stringify({ headers: [], rows: [] }) };
                    }
                    const headers: string[] = values[0];
                    const rows = values.slice(1).map((row: string[]) =>
                        headers.reduce((acc: Row, header: string, i: number) => {
                            acc[header] = row[i] ?? '';
                            return acc;
                        }, {})
                    );
                    resourceCache.set(data.sheetId, { headers, rows });
                    saveSheetsCache(data.sheetId, { headers, rows });
                    await flushWriteQueue();
                    return { success: true, result: JSON.stringify({ headers, rows }) };
                } catch (e) {
                    const cached = resourceCache.get(data.sheetId) ?? await loadSheetsCache(data.sheetId);
                    if (cached) return { success: true, result: JSON.stringify({ ...cached, cached: true }) };
                    if (isNetworkError(e)) return { success: false, result: JSON.stringify({ offline: true }) };
                    return { success: false, result: e instanceof Error ? e.message : 'Sheets get rows error' };
                }
            }

            case 'SHEETS_WATCH': {
                console.log(`[Bridge] Sheets watch: ${data.sheetId}`);
                const sheetId: string = data.sheetId;
                const intervalMs: number = data.intervalMs || 5000;
                const callbackName: string = data.callbackName;
                const key = `${ctx.appId}_${sheetId}`;

                const existing = activeWatchers.get(key);
                const existingSnapshot = existing?.snapshot ?? null;

                const doPoll = async (initial: boolean) => {
                    try {
                        const token = await requestGoogleScopes(SHEETS_SCOPES);
                        if (!token) {
                            if (initial) {
                                const cached = resourceCache.get(sheetId) ?? await loadSheetsCache(sheetId);
                                const script = cached
                                    ? createCallbackScript(callbackName, true, JSON.stringify({ ...cached, initial: true, cached: true, added: [], changed: [], deleted: [] }))
                                    : createCallbackScript(callbackName, false, JSON.stringify({ offline: true }));
                                ctx.webViewRef.current?.injectJavaScript(script);
                            }
                            return;
                        }

                        const getRes = await fetch(`${SHEETS_API}/${sheetId}/values/Sheet1`, {
                            headers: { Authorization: `Bearer ${token}` },
                        });
                        if (!getRes.ok) throw new Error(`${getRes.status}`);

                        const getData = await getRes.json();
                        const values: string[][] = getData.values || [];
                        const headers: string[] = values.length > 0 ? values[0] : [];
                        const rows: Row[] = values.slice(1).map((row: string[]) =>
                            headers.reduce((acc: Row, h, i) => { acc[h] = row[i] ?? ''; return acc; }, {})
                        );

                        resourceCache.set(sheetId, { headers, rows });
                        saveSheetsCache(sheetId, { headers, rows });

                        const watcher = activeWatchers.get(key);

                        if (!initial && watcher?.skipNextPoll) {
                            watcher.skipNextPoll = false;
                            return;
                        }

                        const prevSnapshot = watcher?.snapshot ?? null;
                        const hasChanged = initial || prevSnapshot === null || JSON.stringify(prevSnapshot) !== JSON.stringify(rows);

                        if (hasChanged) {
                            const diff = (initial || prevSnapshot === null)
                                ? { added: [], changed: [], deleted: [] }
                                : computeDiff(prevSnapshot, rows);
                            if (watcher && !ctx.isEditMode) watcher.snapshot = rows;
                            const script = createCallbackScript(callbackName, true,
                                JSON.stringify({ rows, headers, ...diff, initial }));
                            ctx.webViewRef.current?.injectJavaScript(script);
                        }

                        await flushWriteQueue();
                    } catch (e) {
                        if (initial) {
                            const cached = resourceCache.get(sheetId) ?? await loadSheetsCache(sheetId);
                            const script = cached
                                ? createCallbackScript(callbackName, true, JSON.stringify({ ...cached, initial: true, cached: true, added: [], changed: [], deleted: [] }))
                                : createCallbackScript(callbackName, false, JSON.stringify({ offline: true }));
                            ctx.webViewRef.current?.injectJavaScript(script);
                        }
                    }
                };

                // Edit mode: one-shot fetch, não cria watcher persistente para não
                // interferir com o watcher do RunnerActivity que pode estar ativo.
                if (ctx.isEditMode) {
                    doPoll(true);
                    return { success: true, result: JSON.stringify({ watching: true }), deferredCallback: true };
                }

                // Runner mode: stop previous watcher and create a new one
                if (existing) clearInterval(existing.interval);

                // Set up watcher first so doPoll can update the snapshot
                const interval = setInterval(() => doPoll(false), intervalMs);
                activeWatchers.set(key, { interval, webViewRef: ctx.webViewRef, callbackName, snapshot: existingSnapshot, skipNextPoll: false });

                // If re-watching with an existing snapshot, treat as non-initial so we
                // only fire if data actually changed (avoids spurious full-render callbacks).
                doPoll(existingSnapshot === null);

                return { success: true, result: JSON.stringify({ watching: true }), deferredCallback: true };
            }

            case 'SHEETS_STOP_WATCH': {
                console.log(`[Bridge] Sheets stop watch: ${data.sheetId}`);
                const key = `${ctx.appId}_${data.sheetId}`;
                const watcher = activeWatchers.get(key);
                if (watcher) {
                    clearInterval(watcher.interval);
                    activeWatchers.delete(key);
                }
                return { success: true, result: JSON.stringify({ stopped: true }) };
            }

            case 'SHEETS_SET_ROWS': {
                console.log(`[Bridge] Sheets set rows: ${data.sheetId}`);
                const sheetId: string = data.sheetId;
                const rows: Row[] = data.rows || [];

                const executeSetRows = async () => {
                    const token = await requestGoogleScopes(SHEETS_SCOPES);
                    if (!token) throw new Error('Google Sheets access was denied.');

                    // GET current headers from row 1
                    const headerRes = await fetch(`${SHEETS_API}/${sheetId}/values/Sheet1!1:1`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    let headers: string[] = [];
                    if (headerRes.ok) {
                        const hd = await headerRes.json();
                        headers = hd.values?.[0] ?? [];
                    }
                    // Fallback: derive headers from first row object keys
                    if (headers.length === 0 && rows.length > 0) {
                        headers = Object.keys(rows[0]);
                    }

                    // Protect the clear→append window against concurrent polls
                    const key = `${ctx.appId}_${sheetId}`;
                    const watcher = activeWatchers.get(key);
                    if (watcher) watcher.skipNextPoll = true;

                    // Clear all data
                    await fetch(`${SHEETS_API}/${sheetId}/values/Sheet1:clear`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: '{}',
                    });

                    // Re-append headers + new rows
                    const values: string[][] = [
                        headers,
                        ...rows.map(row => headers.map(h => row[h] ?? '')),
                    ];
                    if (values.some(v => v.length > 0)) {
                        await fetch(
                            `${SHEETS_API}/${sheetId}/values/Sheet1:append?valueInputOption=USER_ENTERED`,
                            {
                                method: 'POST',
                                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                                body: JSON.stringify({ values }),
                            }
                        );
                    }

                    // Update snapshot with normalized rows (same format doPoll produces)
                    // so JSON.stringify comparison won't produce false positives
                    if (watcher) {
                        watcher.snapshot = rows.map(row =>
                            headers.reduce((acc: Row, h) => { acc[h] = row[h] ?? ''; return acc; }, {} as Row)
                        );
                    }
                    resourceCache.set(sheetId, { headers, rows });
                };

                try {
                    await executeSetRows();
                    await flushWriteQueue();
                    return { success: true, result: JSON.stringify({ rowsWritten: rows.length }) };
                } catch (e) {
                    if (isNetworkError(e)) {
                        writeQueue.push({ execute: executeSetRows });
                        return { success: true, result: JSON.stringify({ queued: true }) };
                    }
                    return { success: false, result: e instanceof Error ? e.message : 'Sheets set rows error' };
                }
            }

            default:
                return null;
        }
    },
};
