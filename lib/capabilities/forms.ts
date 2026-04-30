import AsyncStorage from '@react-native-async-storage/async-storage';
import { createCallbackScript } from './mediaHelpers';
import { requestGoogleScopes } from '../firebase';
import { CapabilityModule, HandlerContext, HandlerResult, WebViewRef } from './types';

// ── Module-level state ────────────────────────────────────────────────────────

interface FormWatcher {
    interval: ReturnType<typeof setInterval>;
    webViewRef: WebViewRef;
    callbackName: string;
    snapshot: Set<string> | null; // set of responseIds seen so far
}

export const activeWatchers = new Map<string, FormWatcher>();
export const resourceCache = new Map<string, any[]>(); // formId → responses[]
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

export function isNetworkError(e: unknown): boolean {
    return e instanceof TypeError && e.message.includes('Network');
}

const FORMS_CACHE_PREFIX = 'appacadabra_forms_responses_cache_';

async function loadFormsCache(formId: string): Promise<any[] | null> {
    try {
        const raw = await AsyncStorage.getItem(FORMS_CACHE_PREFIX + formId);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function saveFormsCache(formId: string, data: any[]): void {
    AsyncStorage.setItem(FORMS_CACHE_PREFIX + formId, JSON.stringify(data))?.catch(() => {});
}

const FORMS_SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const FORMS_API = 'https://forms.googleapis.com/v1/forms';

// ─────────────────────────────────────────────────────────────────────────────

export const formsCapability: CapabilityModule = {
    id: 'forms',
    displayName: 'Forms',
    minVersion: '1.0.0',

    docs: `📋 FORMS (AppacadabraForms) — Google Sign-In required (consent shown on first use only)
⚠️ **Restricted access:** \`getResponses()\`, \`updateForm()\` and \`watchResponses()\` work **only with forms created by this app via \`createForm()\`**. External forms cannot be accessed for two reasons: (1) OAuth scope restriction \`drive.file\`; (2) the question mapping is stored internally at creation time and does not exist for external forms. Never suggest the user use an existing Google Form.

**Basic operations:**
- \`createForm(title, questions[], callback)\` — Creates a Google Form
  - \`questions\`: \`[{ type: "text"|"paragraph"|"radio"|"checkbox"|"dropdown", title: "...", options?: ["..."] }]\`
  - **Callback data**: \`{ formId, shareUrl }\`
- \`updateForm(formId, title, questions[], callback)\` — Replaces form questions; same shareUrl is preserved
  - **Callback data**: \`{ formId, shareUrl }\`
- \`getResponses(formId, callback)\` — Fetches all responses with human-readable answer labels
  - **Callback data**: \`{ responses: [{ responseId, submitTime, answers: { "Question title": "answer" } }] }\`

**Native sync mode (recommended — receives new responses in real time):**

Use \`watchResponses\` in dashboard spells that need to display responses as they arrive, without the user having to reload the page. The capability detects new responseIds and fires the callback only when there are new entries.

- \`watchResponses(formId, intervalMs, callbackName)\` — Starts polling for new responses
  - Fires **immediately** with all current responses (\`initial: true\`), then only when new ones arrive
  - \`intervalMs\`: polling interval in ms (e.g. \`15000\` = every 15 s)
  - **Callback data (ok, data)**:
    - \`data.responses\`: all responses (use on \`initial: true\` to populate the table)
    - \`data.newResponses\`: only the responses added since the last poll (use to append new rows)
    - \`data.initial\`: \`true\` on first call — render everything; subsequent calls only when new responses exist
    - \`data.cached\`: \`true\` when offline and data comes from last successful read
  - Offline behaviour: fires with \`{ cached: true, ...lastKnownData }\`; if no cache: \`ok=false, { offline: true }\`
- \`stopWatchResponses(formId, callbackName)\` — Stops polling
  - **Callback data**: \`{ stopped: true }\`

**Question types** (all support \`required: true\` and optional \`title\`):
  - \`"text"\` — short text answer: \`{ type: "text", title: "Full name" }\`
  - \`"paragraph"\` — long text answer: \`{ type: "paragraph", title: "Describe your symptoms" }\`
  - \`"radio"\` — pick exactly one: \`{ type: "radio", title: "Reason for visit", options: ["Consultation", "Follow-up", "Emergency"] }\`
  - \`"checkbox"\` — pick one or more: \`{ type: "checkbox", title: "Current symptoms", options: ["Fever", "Cough", "Fatigue"] }\`
  - \`"dropdown"\` — pick one from a list: \`{ type: "dropdown", title: "Preferred time", options: ["Morning", "Afternoon", "Evening"] }\`
  - Add \`shuffle: true\` to any \`radio\`/\`checkbox\`/\`dropdown\` to randomise option order
  - \`"date"\` — date picker: \`{ type: "date", title: "Date of birth" }\`
  - \`"datetime"\` — date + time picker: \`{ type: "datetime", title: "Appointment date and time" }\`
  - \`"time"\` — specific time of day: \`{ type: "time", title: "Preferred appointment time" }\`
  - \`"duration"\` — elapsed time (hh:mm:ss): \`{ type: "duration", title: "How long did symptoms last?" }\`
  - \`"scale"\` — numeric range (\`low\` and \`high\` required): \`{ type: "scale", title: "Pain level", low: 1, high: 10, lowLabel: "No pain", highLabel: "Worst pain" }\`
  - \`"rating"\` — icon-based rating: \`{ type: "rating", title: "Rate your experience", level: 5, icon: "star" }\` — \`icon\`: \`"star"\` | \`"heart"\` | \`"thumb"\` (default: \`"star"\`, default level: \`5\`)

**⚠️ RULE:** Use \`watchResponses\` instead of \`getResponses\` in any spell that needs to show live responses. Do not use a manual \`setInterval\` in the spell — polling is handled by the capability.

**Usage (native sync):**
\`\`\`js
// 1. On open: loads existing responses and listens for new ones
AppacadabraForms.watchResponses(localStorage.getItem('formId'), 15000, 'onResponses');
window.onResponses = function(ok, data) {
  if (!ok) { if (data.offline) showBanner('No connection'); return; }
  if (data.cached) showBanner('Offline data');
  if (data.initial) renderAll(data.responses);        // first call: render everything
  else data.newResponses.forEach(r => addRow(r));     // subsequent calls: only new ones
};

// 2. Stop when closing the screen
AppacadabraForms.stopWatchResponses(localStorage.getItem('formId'), 'done');
\`\`\``,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraForms = {
    createForm: function(title, questions, callbackName) {
      if (window.__IS_EDIT_MODE__) return;
      console.log('[AppacadabraForms.createForm] title:', title, 'questions:', questions.length, 'callback:', callbackName);
      sendMessage('FORMS_CREATE', { title, questions }, callbackName);
    },
    updateForm: function(formId, title, questions, callbackName) {
      if (window.__IS_EDIT_MODE__) return;
      console.log('[AppacadabraForms.updateForm] formId:', formId, 'questions:', questions.length, 'callback:', callbackName);
      sendMessage('FORMS_UPDATE', { formId, title, questions }, callbackName);
    },
    getResponses: function(formId, callbackName) {
      console.log('[AppacadabraForms.getResponses] formId:', formId, 'callback:', callbackName);
      sendMessage('FORMS_GET_RESPONSES', { formId }, callbackName);
    },
    watchResponses: function(formId, intervalMs, callbackName) {
      console.log('[AppacadabraForms.watchResponses] formId:', formId, 'interval:', intervalMs, 'callback:', callbackName);
      sendMessage('FORMS_WATCH_RESPONSES', { formId, intervalMs: intervalMs || 15000, callbackName: callbackName }, callbackName);
    },
    stopWatchResponses: function(formId, callbackName) {
      console.log('[AppacadabraForms.stopWatchResponses] formId:', formId, 'callback:', callbackName);
      sendMessage('FORMS_STOP_WATCH_RESPONSES', { formId }, callbackName);
    }
  };
`,

    handleMessage: async (type: string, data: any, ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        const buildQuestionItem = (q: any, index: number) => {
            let questionField: any;
            if (q.type === 'text') {
                questionField = { textQuestion: { paragraph: false } };
            } else if (q.type === 'paragraph') {
                questionField = { textQuestion: { paragraph: true } };
            } else if (q.type === 'radio') {
                questionField = { choiceQuestion: { type: 'RADIO', options: (q.options || []).map((v: string) => ({ value: v })), shuffle: q.shuffle ?? false } };
            } else if (q.type === 'checkbox') {
                questionField = { choiceQuestion: { type: 'CHECKBOX', options: (q.options || []).map((v: string) => ({ value: v })), shuffle: q.shuffle ?? false } };
            } else if (q.type === 'dropdown') {
                questionField = { choiceQuestion: { type: 'DROP_DOWN', options: (q.options || []).map((v: string) => ({ value: v })), shuffle: q.shuffle ?? false } };
            } else if (q.type === 'date') {
                questionField = { dateQuestion: { includeTime: false, includeYear: true } };
            } else if (q.type === 'datetime') {
                questionField = { dateQuestion: { includeTime: true, includeYear: true } };
            } else if (q.type === 'time') {
                questionField = { timeQuestion: { duration: false } };
            } else if (q.type === 'duration') {
                questionField = { timeQuestion: { duration: true } };
            } else if (q.type === 'scale') {
                questionField = { scaleQuestion: { low: q.low, high: q.high, ...(q.lowLabel ? { lowLabel: q.lowLabel } : {}), ...(q.highLabel ? { highLabel: q.highLabel } : {}) } };
            } else if (q.type === 'rating') {
                const ICON_MAP: Record<string, string> = { star: 'STAR', heart: 'HEART', thumb: 'THUMB_UP' };
                questionField = { ratingQuestion: { ratingScaleLevel: q.level ?? 5, iconType: ICON_MAP[q.icon ?? 'star'] ?? 'STAR' } };
            } else {
                questionField = { textQuestion: { paragraph: false } };
            }
            return {
                createItem: {
                    item: {
                        title: q.title,
                        questionItem: {
                            question: { required: q.required ?? false, ...questionField },
                        },
                    },
                    location: { index },
                },
            };
        };

        const parseResponses = (rawResponses: any[], schemaMap: Record<string, string>) =>
            rawResponses.map((r: any) => {
                const answers: Record<string, string> = {};
                for (const [questionId, answerObj] of Object.entries(r.answers || {})) {
                    const title = schemaMap[questionId] || questionId;
                    const a = answerObj as any;
                    let value = '';
                    if (a.textAnswers?.answers?.length) {
                        value = a.textAnswers.answers[0].value ?? '';
                    } else if (a.choiceAnswers?.answers?.length) {
                        value = a.choiceAnswers.answers.map((x: any) => x.value).join(', ');
                    } else if (a.dateAnswers?.answers?.length) {
                        const d = a.dateAnswers.answers[0];
                        value = `${d.year ?? ''}-${String(d.month ?? '').padStart(2, '0')}-${String(d.day ?? '').padStart(2, '0')}`;
                    } else if (a.timeAnswers?.answers?.length) {
                        const tm = a.timeAnswers.answers[0];
                        value = `${String(tm.hours ?? 0).padStart(2, '0')}:${String(tm.minutes ?? 0).padStart(2, '0')}`;
                    } else if (a.scaleAnswers?.answers?.length) {
                        value = String(a.scaleAnswers.answers[0].value ?? '');
                    }
                    answers[title] = value;
                }
                return { responseId: r.responseId, submitTime: r.lastSubmittedTime, answers };
            });

        switch (type) {
            case 'FORMS_CREATE': {
                console.log(`[Bridge] Forms create: ${data.title}`);
                try {
                    const token = await requestGoogleScopes(FORMS_SCOPES);
                    if (!token) {
                        return { success: false, result: 'Google Forms access was denied. Please try again and grant permission.' };
                    }

                    const createRes = await fetch(FORMS_API, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ info: { title: data.title } }),
                    });
                    if (!createRes.ok) {
                        return { success: false, result: `Failed to create form: ${createRes.status} ${await createRes.text()}` };
                    }
                    const created = await createRes.json();
                    const formId: string = created.formId;

                    const questions: any[] = data.questions || [];
                    const requests: any[] = [
                        ...questions.map((q: any, i: number) => buildQuestionItem(q, i)),
                        {
                            updateSettings: {
                                settings: { quizSettings: { isQuiz: false } },
                                updateMask: 'quizSettings',
                            },
                        },
                    ];

                    const batchRes = await fetch(`${FORMS_API}/${formId}:batchUpdate`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ requests }),
                    });
                    if (!batchRes.ok) {
                        return { success: false, result: `Failed to update form: ${batchRes.status} ${await batchRes.text()}` };
                    }

                    const formRes = await fetch(`${FORMS_API}/${formId}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    const formData = await formRes.json();
                    const schemaMap: Record<string, string> = {};
                    for (const item of (formData.items || [])) {
                        if (item.questionItem?.question?.questionId) {
                            schemaMap[item.questionItem.question.questionId] = item.title || '';
                        }
                    }
                    await AsyncStorage.setItem('appacadabra_forms_' + formId, JSON.stringify(schemaMap));

                    return { success: true, result: JSON.stringify({ formId, shareUrl: `https://docs.google.com/forms/d/${formId}/viewform` }) };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Forms create error' };
                }
            }

            case 'FORMS_UPDATE': {
                console.log(`[Bridge] Forms update: ${data.formId}`);
                try {
                    const token = await requestGoogleScopes(FORMS_SCOPES);
                    if (!token) {
                        return { success: false, result: 'Google Forms access was denied. Please try again and grant permission.' };
                    }

                    const formId: string = data.formId;

                    const existingRes = await fetch(`${FORMS_API}/${formId}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    if (!existingRes.ok) {
                        return { success: false, result: `Failed to fetch form: ${existingRes.status}` };
                    }
                    const existingForm = await existingRes.json();
                    const existingItems: any[] = existingForm.items || [];

                    const deleteRequests = existingItems
                        .slice()
                        .reverse()
                        .map((_: any, revIdx: number) => ({
                            deleteItem: { location: { index: existingItems.length - 1 - revIdx } },
                        }));

                    const questions: any[] = data.questions || [];
                    const createRequests = questions.map((q: any, i: number) => buildQuestionItem(q, i));
                    const infoRequests = data.title
                        ? [{ updateFormInfo: { info: { title: data.title }, updateMask: 'title' } }]
                        : [];

                    const batchRes = await fetch(`${FORMS_API}/${formId}:batchUpdate`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ requests: [...infoRequests, ...deleteRequests, ...createRequests] }),
                    });
                    if (!batchRes.ok) {
                        return { success: false, result: `Failed to update form: ${batchRes.status} ${await batchRes.text()}` };
                    }

                    const formRes = await fetch(`${FORMS_API}/${formId}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    const updatedForm = await formRes.json();
                    const newMap: Record<string, string> = {};
                    for (const item of (updatedForm.items || [])) {
                        if (item.questionItem?.question?.questionId) {
                            newMap[item.questionItem.question.questionId] = item.title || '';
                        }
                    }

                    const stored = await AsyncStorage.getItem('appacadabra_forms_' + formId);
                    const storedMap: Record<string, string> = stored ? JSON.parse(stored) : {};
                    const mergedMap = { ...storedMap, ...newMap };
                    await AsyncStorage.setItem('appacadabra_forms_' + formId, JSON.stringify(mergedMap));

                    return { success: true, result: JSON.stringify({ formId, shareUrl: `https://docs.google.com/forms/d/${formId}/viewform` }) };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Forms update error' };
                }
            }

            case 'FORMS_GET_RESPONSES': {
                console.log(`[Bridge] Forms get responses: ${data.formId}`);
                try {
                    const token = await requestGoogleScopes(FORMS_SCOPES);
                    if (!token) {
                        return { success: false, result: 'Google Forms access was denied. Please try again and grant permission.' };
                    }

                    const formId: string = data.formId;

                    const stored = await AsyncStorage.getItem('appacadabra_forms_' + formId);
                    const storedMap: Record<string, string> = stored ? JSON.parse(stored) : {};

                    const formRes = await fetch(`${FORMS_API}/${formId}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    const currentForm = await formRes.json();
                    const currentMap: Record<string, string> = {};
                    for (const item of (currentForm.items || [])) {
                        if (item.questionItem?.question?.questionId) {
                            currentMap[item.questionItem.question.questionId] = item.title || '';
                        }
                    }
                    const schemaMap: Record<string, string> = { ...storedMap, ...currentMap };

                    const respRes = await fetch(`${FORMS_API}/${formId}/responses`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    if (!respRes.ok) {
                        const cached = resourceCache.get(formId) ?? await loadFormsCache(formId);
                        if (cached) return { success: true, result: JSON.stringify({ responses: cached, cached: true }) };
                        return { success: false, result: `Failed to fetch responses: ${respRes.status} ${await respRes.text()}` };
                    }
                    const respData = await respRes.json();
                    const rawResponses: any[] = respData.responses || [];
                    const responses = parseResponses(rawResponses, schemaMap);
                    resourceCache.set(formId, responses);
                    saveFormsCache(formId, responses);

                    return { success: true, result: JSON.stringify({ responses }) };
                } catch (e) {
                    const cached = resourceCache.get(data.formId) ?? await loadFormsCache(data.formId);
                    if (cached) return { success: true, result: JSON.stringify({ responses: cached, cached: true }) };
                    if (isNetworkError(e)) return { success: false, result: JSON.stringify({ offline: true }) };
                    return { success: false, result: e instanceof Error ? e.message : 'Forms get responses error' };
                }
            }

            case 'FORMS_WATCH_RESPONSES': {
                console.log(`[Bridge] Forms watch responses: ${data.formId}`);
                const formId: string = data.formId;
                const intervalMs: number = data.intervalMs || 15000;
                const callbackName: string = data.callbackName;
                const key = `${ctx.appId}_${formId}`;

                const existing = activeWatchers.get(key);
                const existingSnapshot = existing?.snapshot ?? null;

                const fetchResponses = async (token: string): Promise<any[]> => {
                    const stored = await AsyncStorage.getItem('appacadabra_forms_' + formId);
                    const storedMap: Record<string, string> = stored ? JSON.parse(stored) : {};

                    const formRes = await fetch(`${FORMS_API}/${formId}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    const currentForm = await formRes.json();
                    const currentMap: Record<string, string> = {};
                    for (const item of (currentForm.items || [])) {
                        if (item.questionItem?.question?.questionId) {
                            currentMap[item.questionItem.question.questionId] = item.title || '';
                        }
                    }
                    const schemaMap = { ...storedMap, ...currentMap };

                    const respRes = await fetch(`${FORMS_API}/${formId}/responses`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    if (!respRes.ok) throw new Error(`${respRes.status}`);
                    const respData = await respRes.json();
                    return parseResponses(respData.responses || [], schemaMap);
                };

                const doPoll = async (initial: boolean) => {
                    try {
                        const token = await requestGoogleScopes(FORMS_SCOPES);
                        if (!token) {
                            if (initial) {
                                const cached = resourceCache.get(formId) ?? await loadFormsCache(formId);
                                const script = cached
                                    ? createCallbackScript(callbackName, true, JSON.stringify({ responses: cached, newResponses: [], initial: true, cached: true }))
                                    : createCallbackScript(callbackName, false, JSON.stringify({ offline: true }));
                                ctx.webViewRef.current?.injectJavaScript(script);
                            }
                            return;
                        }

                        const responses = await fetchResponses(token);
                        resourceCache.set(formId, responses);
                        saveFormsCache(formId, responses);

                        const watcher = activeWatchers.get(key);
                        const prevSnapshot = watcher?.snapshot ?? null;

                        if (initial || prevSnapshot === null) {
                            // First call: fire with all responses
                            const allIds = new Set(responses.map((r: any) => r.responseId));
                            if (watcher && !ctx.isEditMode) watcher.snapshot = allIds;
                            const script = createCallbackScript(callbackName, true,
                                JSON.stringify({ responses, newResponses: [], initial: true }));
                            ctx.webViewRef.current?.injectJavaScript(script);
                        } else {
                            // Subsequent polls: only fire if new responses found
                            const newResponses = responses.filter((r: any) => !prevSnapshot.has(r.responseId));
                            if (newResponses.length > 0) {
                                newResponses.forEach((r: any) => prevSnapshot.add(r.responseId));
                                const script = createCallbackScript(callbackName, true,
                                    JSON.stringify({ responses, newResponses, initial: false }));
                                ctx.webViewRef.current?.injectJavaScript(script);
                            }
                        }
                    } catch (e) {
                        if (initial) {
                            const cached = resourceCache.get(formId) ?? await loadFormsCache(formId);
                            const script = cached
                                ? createCallbackScript(callbackName, true, JSON.stringify({ responses: cached, newResponses: [], initial: true, cached: true }))
                                : createCallbackScript(callbackName, false, JSON.stringify({ offline: true }));
                            ctx.webViewRef.current?.injectJavaScript(script);
                        }
                    }
                };

                // Edit mode: one-shot fetch, no persistent interval
                if (ctx.isEditMode) {
                    if (editModeLoadedKeys.has(key)) {
                        return { success: true, result: JSON.stringify({ watching: true }), deferredCallback: true };
                    }
                    editModeLoadedKeys.add(key);
                    doPoll(true);
                    return { success: true, result: JSON.stringify({ watching: true }), deferredCallback: true };
                }

                if (existing) clearInterval(existing.interval);
                const interval = setInterval(() => doPoll(false), intervalMs);
                activeWatchers.set(key, { interval, webViewRef: ctx.webViewRef, callbackName, snapshot: existingSnapshot });

                doPoll(existingSnapshot === null);

                return { success: true, result: JSON.stringify({ watching: true }), deferredCallback: true };
            }

            case 'FORMS_STOP_WATCH_RESPONSES': {
                console.log(`[Bridge] Forms stop watch: ${data.formId}`);
                const key = `${ctx.appId}_${data.formId}`;
                const watcher = activeWatchers.get(key);
                if (watcher) {
                    clearInterval(watcher.interval);
                    activeWatchers.delete(key);
                }
                return { success: true, result: JSON.stringify({ stopped: true }) };
            }

            default:
                return null;
        }
    },
};
