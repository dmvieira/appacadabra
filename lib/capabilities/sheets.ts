import { requestGoogleScopes } from '../firebase';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

export const sheetsCapability: CapabilityModule = {
    id: 'sheets',
    displayName: 'Sheets',
    minVersion: '1.0.0',

    docs: `📊 SHEETS (AppacadabraSheets) — Google Sign-In required (consent shown on first use only)
⚠️ **Acesso restrito:** \`getRows()\` e \`appendRows()\` funcionam **apenas com planilhas criadas por este app via \`createSheet()\`**. Não é possível acessar Google Sheets existentes do usuário. Se o usuário quiser usar "sua planilha de vendas" ou similar, explique a limitação e ofereça criar uma nova planilha dedicada dentro do app.
- \`createSheet(title, headers[], callback)\` — Creates a Google Spreadsheet
  - \`headers\`: optional column headers written to row 1 (e.g. \`["Name", "Date", "Status"]\`)
  - **Callback data**: \`{ sheetId, url }\`
- \`appendRows(sheetId, rows[][], callback)\` — Appends rows of data
  - \`rows\`: array of arrays e.g. \`[["Alice", "2026-03-26", "Active"], ["Bob", "2026-03-25", "Pending"]]\`
  - **Callback data**: \`{ updatedRows }\` (number of rows added)
- \`getRows(sheetId, callback)\` — Reads all data; first row treated as headers
  - **Callback data**: \`{ headers: ["Name", "Date"], rows: [{ "Name": "Alice", "Date": "2026-03-26" }, ...] }\`
- \`clearRows(sheetId, callback)\` — Clears all data from the sheet
  - **Callback data**: \`{ sheetId }\`
- \`updateCell(sheetId, cell, value, callback)\` — Sets a single cell value (e.g. \`"B3"\`)
  - **Callback data**: \`{ sheetId }\`
- **Usage**:
  \`\`\`js
  AppacadabraSheets.createSheet("Patient Log",
    ["Name", "Date", "Reason", "Status"], "onSheetReady");
  window.onSheetReady = function(ok, data) {
    if (!ok) return;
    localStorage.setItem('logSheetId', data.sheetId);
  };

  // Log a new patient visit
  AppacadabraSheets.appendRows(localStorage.getItem('logSheetId'),
    [["Maria Silva", "2026-03-26", "Consultation", "Completed"]], "onAppended");

  // Read all records
  AppacadabraSheets.getRows(localStorage.getItem('logSheetId'), "onRows");
  window.onRows = function(ok, data) {
    if (ok) renderTable(data.headers, data.rows);
  };
  \`\`\``,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraSheets = {
    createSheet: function(title, headers, callbackName) {
      console.log('[AppacadabraSheets.createSheet] title:', title, 'callback:', callbackName);
      sendMessage('SHEETS_CREATE', { title, headers: headers || [] }, callbackName);
    },
    appendRows: function(sheetId, rows, callbackName) {
      console.log('[AppacadabraSheets.appendRows] sheetId:', sheetId, 'rows:', rows.length, 'callback:', callbackName);
      sendMessage('SHEETS_APPEND_ROWS', { sheetId, rows }, callbackName);
    },
    getRows: function(sheetId, callbackName) {
      console.log('[AppacadabraSheets.getRows] sheetId:', sheetId, 'callback:', callbackName);
      sendMessage('SHEETS_GET_ROWS', { sheetId }, callbackName);
    },
    clearRows: function(sheetId, callbackName) {
      console.log('[AppacadabraSheets.clearRows] sheetId:', sheetId, 'callback:', callbackName);
      sendMessage('SHEETS_CLEAR_ROWS', { sheetId }, callbackName);
    },
    updateCell: function(sheetId, cell, value, callbackName) {
      console.log('[AppacadabraSheets.updateCell] sheetId:', sheetId, 'cell:', cell, 'callback:', callbackName);
      sendMessage('SHEETS_UPDATE_CELL', { sheetId, cell, value }, callbackName);
    }
  };
`,

    handleMessage: async (type: string, data: any, _ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        const SHEETS_SCOPES = ['https://www.googleapis.com/auth/drive.file'];
        const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

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
                        return { success: false, result: `Failed to get rows: ${getRes.status} ${await getRes.text()}` };
                    }
                    const getData = await getRes.json();
                    const values: string[][] = getData.values || [];
                    if (values.length === 0) {
                        return { success: true, result: JSON.stringify({ headers: [], rows: [] }) };
                    }
                    const headers: string[] = values[0];
                    const rows = values.slice(1).map((row: string[]) =>
                        headers.reduce((acc: Record<string, string>, header: string, i: number) => {
                            acc[header] = row[i] ?? '';
                            return acc;
                        }, {})
                    );
                    return { success: true, result: JSON.stringify({ headers, rows }) };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Sheets get rows error' };
                }
            }

            case 'SHEETS_CLEAR_ROWS': {
                console.log(`[Bridge] Sheets clear rows: ${data.sheetId}`);
                try {
                    const token = await requestGoogleScopes(SHEETS_SCOPES);
                    if (!token) {
                        return { success: false, result: 'Google Sheets access was denied. Please try again and grant permission.' };
                    }

                    const clearRes = await fetch(`${SHEETS_API}/${data.sheetId}/values/Sheet1:clear`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({}),
                    });
                    if (!clearRes.ok) {
                        return { success: false, result: `Failed to clear rows: ${clearRes.status} ${await clearRes.text()}` };
                    }
                    return { success: true, result: JSON.stringify({ sheetId: data.sheetId }) };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Sheets clear rows error' };
                }
            }

            case 'SHEETS_UPDATE_CELL': {
                console.log(`[Bridge] Sheets update cell: ${data.sheetId} ${data.cell}`);
                try {
                    const token = await requestGoogleScopes(SHEETS_SCOPES);
                    if (!token) {
                        return { success: false, result: 'Google Sheets access was denied. Please try again and grant permission.' };
                    }

                    const updateRes = await fetch(
                        `${SHEETS_API}/${data.sheetId}/values/Sheet1!${data.cell}?valueInputOption=USER_ENTERED`,
                        {
                            method: 'PUT',
                            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ values: [[data.value]] }),
                        }
                    );
                    if (!updateRes.ok) {
                        return { success: false, result: `Failed to update cell: ${updateRes.status} ${await updateRes.text()}` };
                    }
                    return { success: true, result: JSON.stringify({ sheetId: data.sheetId }) };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Sheets update cell error' };
                }
            }

            default:
                return null;
        }
    },
};
