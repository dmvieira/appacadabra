import { t } from '../i18n';
import type { CapabilityModule, HandlerContext, HandlerResult } from './types';

export const mcpCapability: CapabilityModule = {
    id: 'mcp',
    displayName: 'MCP',
    minVersion: '3.1.6',
    description:
        'Connect to external remote MCP servers (PicPay, Notion, Stripe, Context7, etc.) and call their tools. Use `listTools` to discover tools, then `callTool` to run them. These are direct data APIs for the app — no AI call involved. Login/consent is handled automatically by the app.',

    docs: `🔌 MCP — Model Context Protocol connectors (AppacadabraMCP)
Appacadabra can call external tools exposed by remote MCP servers the user has connected (e.g. PicPay, Notion, Stripe, Context7). Only **remote** servers work (no local/stdio).

⚠️ HOW TO USE (READ CAREFULLY)
1. FIRST discover the tools for a server — never guess tool names:
   \`AppacadabraMCP.listTools("picpay", "onTools");\`
2. Then call the tool you need by its exact \`name\`:
   \`AppacadabraMCP.callTool("picpay", "get_balance", { }, "onResult");\`
3. If the server needs the user to log in, the app shows a friendly connection screen automatically the first time you call/list a tool. Your callback fires normally after the user connects.
4. All callbacks follow \`callback(success, data)\` and MUST be global functions on \`window\`.

- \`AppacadabraMCP.connect(slug, callback)\` — Ensure the user is connected to a server (triggers the login/consent flow if needed).
    - **Return**: \`{ ok: true }\` on success.
- \`AppacadabraMCP.isConnected(slug, callback)\` — Check whether a server is connected.
    - **Return**: boolean.
- \`AppacadabraMCP.listTools(slug, callback)\` — List the tools a server exposes.
    - **Return**: array of \`{ name, description, inputSchema }\`.
- \`AppacadabraMCP.callTool(slug, toolName, args, callback)\` — Invoke a tool.
    - \`args\` is a plain object matching the tool's \`inputSchema\`.
    - **Return**: \`{ text, raw, isError }\` — \`text\` is the human-readable result; \`raw\` is the server's payload already unwrapped (structured object when the server returns JSON — never the MCP protocol envelope).
    - **Result structure**: when the system prompt shows \`Returns (observed)\` for a tool, \`raw\` matches EXACTLY that structure — read date and amount fields from the shown paths (e.g. \`raw.dias[0].movimentacoes\`), never invent field names. Amounts may be strings ("123.45") — use parseFloat before math. Group lists by the exact date field shown.
- \`AppacadabraMCP.readResource(slug, uri, callback)\` — Read a resource published by that server (when it publishes any).
    - **Return**: \`{ uri, contents }\` — \`contents\` is the server's array of resource content blocks.

- **Server slugs**: use the requested server's slug (lowercase), e.g. \`"picpay"\`, \`"notion"\`, \`"context7"\`. If unsure of a slug, prefer the ones listed for this app; otherwise call listTools and show a clear error if it fails.
- **Identifiers**: NEVER invent IDs. If a tool requires an identifier in its \`inputSchema\` (often in \`required\`), that ID comes from another tool — find the list/search tool that returns it, call it first, then chain LIST → DETAIL. Pass identifiers exactly as returned: they are opaque server-side values; never format, trim, decode or rebuild them. An "identifier not found" error almost always means the list step was skipped.
- **Arguments**: build args strictly from the tool's \`inputSchema\` — respect \`required\`, enums and formats (dates are usually \`YYYY-MM-DD\`; send start and end together) and omit optional fields you don't need.
- **Economics**: MCP calls are NOT AI calls — they do not consume AI tokens. Use them freely for deterministic operations.
- **Direct API access — no AI involved**: AppacadabraMCP is a plain data API for the app's OWN JavaScript. Fetch external data on load, on button taps or on timers and render it directly — no AI call needed at runtime. Both styles work:
    - Callback: \`AppacadabraMCP.callTool("slug", "tool", args, "onResult");\`
    - Promise (recommended for direct data access): \`var res = await AppacadabraMCP.callTool("slug", "tool", args);\` → resolves \`{ success, data }\` where \`data\` is exactly what the callback would receive.
- **Auth**: NEVER ask the user for a password inside the app. Login happens in the browser via the connection screen. Never hard-code tokens.
- **Errors**: always handle \`success === false\` (e.g. user cancelled login or the network failed) with a clear message.

**Examples**
\`\`\`javascript
// Discover then call:
AppacadabraUI.showLoader("Consultando...");
AppacadabraMCP.listTools("picpay", "onPicpayTools");

window.onPicpayTools = function(success, tools) {
    if (!success) { AppacadabraUI.hideLoader(); AppacadabraUI.toast("Não foi possível conectar ao PicPay", "error"); return; }
    var balanceTool = tools.find(function(t) { return t.name.indexOf("balance") !== -1; });
    if (!balanceTool) { AppacadabraUI.hideLoader(); AppacadabraUI.toast("Recurso indisponível", "error"); return; }
    AppacadabraMCP.callTool("picpay", balanceTool.name, {}, "onBalance");
};

window.onBalance = function(success, result) {
    AppacadabraUI.hideLoader();
    if (!success) { AppacadabraUI.toast(result, "error"); return; }
    document.getElementById("output").innerText = result.text;
};
\`\`\`

\`\`\`javascript
// Direct API (Promise) — fetch and render external data yourself, no AI:
window.onload = async function() {
    var res = await AppacadabraMCP.callTool("picpay", "get_balance", {});
    if (!res.success) { document.getElementById("output").innerText = "Indisponível"; return; }
    document.getElementById("output").innerText = res.data.text;
};
\`\`\``,

    validationMock: `    window.AppacadabraMCP = (function() {
        function reply(cb, data) {
            if (typeof cb === 'string' && cb) { if (typeof window[cb] === 'function') window[cb](true, data); return undefined; }
            return Promise.resolve({ success: true, data: data });
        }
        return {
            connect: function(slug, cb) { return reply(cb, { ok: true }); },
            isConnected: function(slug, cb) { return reply(cb, true); },
            listTools: function(slug, cb) { return reply(cb, [{ name: slug + '_echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }]); },
            callTool: function(slug, tool, args, cb) { if (typeof args === 'string' && cb === undefined) { cb = args; } return reply(cb, { text: 'example result', raw: {}, isError: false }); },
            readResource: function(slug, uri, cb) { return reply(cb, { uri: uri, contents: [] }); }
        };
    })();`,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraMCP = (function() {
    var seq = 0;
    var LOG_MAX = 1500;
    function preview(s, max) {
      s = String(s);
      return s.length > max ? s.slice(0, max) + '…[' + s.length + ' chars]' : s;
    }
    // Mandatory observability: every MCP response is echoed to the spell's
    // console (debug panel) so the user — and the NEXT AI edit, which
    // receives the console log — sees the EXACT raw structure to parse.
    function logResult(type, payload, success, data) {
      try {
        var ok = !!success && !(data && data.isError);
        var msg;
        if (type === 'MCP_CALL_TOOL') {
          var body = (data && data.raw !== undefined) ? JSON.stringify(data.raw) : JSON.stringify(data);
          msg = (ok ? '' : '✗ ') + payload.slug + '.' + payload.tool + ' → ' + body;
        } else if (type === 'MCP_LIST_TOOLS') {
          msg = payload.slug + '.listTools → ' + (success && Array.isArray(data)
            ? data.length + ' tools: ' + data.slice(0, 10).map(function(t) { return t && t.name; }).join(', ')
            : String(data));
        } else if (type === 'MCP_READ_RESOURCE') {
          msg = (ok ? '' : '✗ ') + payload.slug + '.readResource(' + payload.uri + ') → ' + JSON.stringify(data && data.contents);
        } else {
          return;
        }
        console.log('[MCP] ' + preview(msg, LOG_MAX));
      } catch (e) { /* a log must never break the app */ }
    }
    function deliver(type, payload, name, onResult) {
      window[name] = function(success, data) {
        logResult(type, payload, success, data);
        try { delete window[name]; } catch (e) { window[name] = undefined; }
        onResult(success, data);
      };
    }
    // Callback style: invoke(type, payload, 'cbName') → cb(success, data).
    // Promise style: invoke(type, payload) → Promise<{ success, data }> —
    // enables direct API use (await AppacadabraMCP.callTool(...)).
    function invoke(type, payload, callbackName) {
      if (typeof callbackName === 'string' && callbackName) {
        // Wrap the user's callback so the response is logged first.
        var userCb = callbackName;
        var wrap = '__appacadabraMcpLog' + (++seq) + '_' + Date.now();
        deliver(type, payload, wrap, function(success, data) {
          var cb = window[userCb];
          if (typeof cb === 'function') cb(success, data);
        });
        sendMessage(type, payload, wrap);
        return undefined;
      }
      return new Promise(function(resolve) {
        var name = '__appacadabraMcpCb' + (++seq) + '_' + Date.now();
        deliver(type, payload, name, function(success, data) {
          resolve({ success: !!success, data: data });
        });
        sendMessage(type, payload, name);
      });
    }
    return {
      connect: function(slug, callbackName) {
        return invoke('MCP_CONNECT', { slug: String(slug || '') }, callbackName);
      },
      isConnected: function(slug, callbackName) {
        return invoke('MCP_IS_CONNECTED', { slug: String(slug || '') }, callbackName);
      },
      listTools: function(slug, callbackName) {
        return invoke('MCP_LIST_TOOLS', { slug: String(slug || '') }, callbackName);
      },
      callTool: function(slug, toolName, args, callbackName) {
        // Tolerate callTool(slug, tool, callback) with omitted args.
        if (typeof args === 'string' && callbackName === undefined) {
          callbackName = args;
          args = {};
        }
        return invoke('MCP_CALL_TOOL', { slug: String(slug || ''), tool: String(toolName || ''), args: args || {} }, callbackName);
      },
      readResource: function(slug, uri, callbackName) {
        return invoke('MCP_READ_RESOURCE', { slug: String(slug || ''), uri: String(uri || '') }, callbackName);
      }
    };
  })();
`,

    handleMessage: async (type: string, data: any, ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        if (!type.startsWith('MCP_')) return null;

        const { useBridgeUIStore } = require('../bridgeUIStore');
        const manager = require('../mcp/manager') as typeof import('../mcp/manager');

        const askConsent = async (slug: string, name?: string): Promise<boolean> => {
            return useBridgeUIStore.getState().requestMcpConnect(slug, name || slug);
        };

        // Nudge: when the connection was established from inside THIS spell and
        // the spell carries a pending-fix flag for that server, tell the user
        // to run the one-tap integration update.
        const maybeNudgePendingFix = async (slug: string, name: string): Promise<void> => {
            try {
                if (ctx.appId == null) return;
                const db = require('../database/db');
                const app = await db.getAppById(ctx.appId);
                if (!app?.mcpPendingFix?.includes(slug)) return;
                const { t: translate } = require('../i18n');
                const store = require('../store');
                store.useAppStore.getState().setStatusMessage(translate('mcpConnectedNudge', { name }));
            } catch {
                // Nudge is best-effort.
            }
        };

        const ensureConnected = async (slug: string): Promise<{ ok: boolean; error?: string }> => {
            const connection = await manager.ensureConnectionForSlug(slug);
            if (!connection) return { ok: false, error: t('mcpErrorUnknownServer', { slug }) };
            if (await manager.isConnected(slug)) return { ok: true };
            const agreed = await askConsent(slug, connection.name);
            if (!agreed) return { ok: false, error: t('mcpErrorCancelled') };
            const res = await manager.connectProvider(connection);
            if (!res.success) return { ok: false, error: res.error || t('mcpErrorConnectFailed') };
            void maybeNudgePendingFix(slug, connection.name);
            return { ok: true };
        };

        const isAuthError = (err: unknown): boolean =>
            err instanceof Error && err.name === 'McpAuthRequiredError';

        // Runs an authenticated operation; when the server rejects the token
        // (expired/revoked — the manager already cleared it and marked the
        // connection `needs_auth`), re-runs the consent + login flow ONCE and
        // retries. Login cancellation/failure surfaces as a plain Error.
        const withAuthRetry = async <T,>(slug: string, op: () => Promise<T>): Promise<T> => {
            try {
                return await op();
            } catch (err) {
                if (!isAuthError(err)) throw err;
                const gate = await ensureConnected(slug);
                if (!gate.ok) throw new Error(gate.error);
                return op();
            }
        };

        const errorMessage = (err: unknown, fallbackKey: string): string => {
            if (isAuthError(err)) return t('mcpErrorAuthRequired');
            return err instanceof Error && err.message ? err.message : t(fallbackKey);
        };

        switch (type) {
            case 'MCP_IS_CONNECTED': {
                const slug = String(data?.slug || '');
                const connected = slug ? await manager.isConnected(slug) : false;
                return { success: true, result: connected };
            }

            case 'MCP_CONNECT': {
                const slug = String(data?.slug || '');
                if (!slug) return { success: false, result: t('mcpErrorSlugRequired') };
                const connection = await manager.ensureConnectionForSlug(slug);
                if (!connection) return { success: false, result: t('mcpErrorUnknownServer', { slug }) };
                const agreed = await askConsent(slug, connection.name);
                if (!agreed) return { success: false, result: t('mcpErrorCancelled') };
                const res = await manager.connectProvider(connection);
                return { success: res.success, result: res.success ? { ok: true } : (res.error || t('mcpErrorConnectFailed')) };
            }

            case 'MCP_LIST_TOOLS': {
                const slug = String(data?.slug || '');
                if (!slug) return { success: false, result: t('mcpErrorSlugRequired') };
                const gate = await ensureConnected(slug);
                if (!gate.ok) return { success: false, result: gate.error };
                try {
                    const tools = await withAuthRetry(slug, () => manager.listProviderTools(slug, { forceRefresh: true }));
                    return { success: true, result: tools };
                } catch (err) {
                    console.warn(`[MCP] ${slug} listTools failed:`, err);
                    return { success: false, result: errorMessage(err, 'mcpErrorListTools') };
                }
            }

            case 'MCP_CALL_TOOL': {
                const slug = String(data?.slug || '');
                const tool = String(data?.tool || '');
                if (!slug || !tool) return { success: false, result: t('mcpErrorSlugRequired') };
                const gate = await ensureConnected(slug);
                if (!gate.ok) return { success: false, result: gate.error };
                try {
                    const result = await withAuthRetry(slug, () => manager.callProviderTool(slug, tool, data?.args || {}));
                    if (result.isError) {
                        // Tool-level error: surface the server's human-readable
                        // message so spells can display it directly.
                        return { success: false, result: result.text || t('mcpErrorToolFailed') };
                    }
                    return { success: true, result };
                } catch (err) {
                    console.warn(`[MCP] ${slug}.${tool} failed:`, err);
                    return { success: false, result: errorMessage(err, 'mcpErrorCallTool') };
                }
            }

            case 'MCP_READ_RESOURCE': {
                const slug = String(data?.slug || '');
                const uri = String(data?.uri || '');
                if (!slug || !uri) return { success: false, result: t('mcpErrorSlugRequired') };
                const gate = await ensureConnected(slug);
                if (!gate.ok) return { success: false, result: gate.error };
                try {
                    const result = await withAuthRetry(slug, () => manager.readProviderResource(slug, uri));
                    return { success: true, result };
                } catch (err) {
                    console.warn(`[MCP] ${slug} readResource(${uri}) failed:`, err);
                    return { success: false, result: errorMessage(err, 'mcpErrorReadResource') };
                }
            }

            default:
                return null;
        }
    },
};
