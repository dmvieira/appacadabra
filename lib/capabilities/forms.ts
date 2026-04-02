import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestGoogleScopes } from '../firebase';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

export const formsCapability: CapabilityModule = {
    id: 'forms',
    displayName: 'Forms',
    minVersion: '1.0.0',

    docs: `📋 FORMS (AppacadabraForms) — Google Sign-In required (consent shown on first use only)
- \`createForm(title, questions[], callback)\` — Creates a Google Form
  - \`questions\`: \`[{ type: "text"|"paragraph"|"radio"|"checkbox"|"dropdown", title: "...", options?: ["..."] }]\`
  - **Callback data**: \`{ formId, shareUrl }\`
- \`updateForm(formId, title, questions[], callback)\` — Replaces form questions; same shareUrl is preserved
  - **Callback data**: \`{ formId, shareUrl }\`
- \`getResponses(formId, callback)\` — Fetches all responses with human-readable answer labels
  - **Callback data**: \`{ responses: [{ responseId, submitTime, answers: { "Question title": "answer" } }] }\`
  - Question title mapping and history preservation are handled automatically by the bridge
- **Question types** (all support \`required: true\` and optional \`title\`):
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
- **Usage**:
  \`\`\`js
  AppacadabraForms.createForm("Patient Intake", [
    { type: "text", title: "Full name" },
    { type: "text", title: "Date of birth" },
    { type: "radio", title: "Reason for visit", options: ["Consultation", "Follow-up", "Emergency"] },
    { type: "checkbox", title: "Current symptoms", options: ["Fever", "Cough", "Fatigue", "None"] },
    { type: "paragraph", title: "Additional notes" }
  ], "onFormReady");
  window.onFormReady = function(ok, data) {
    if (!ok) return;
    localStorage.setItem('formId', data.formId);
    showShareLink(data.shareUrl); // send this link to the patient
  };

  AppacadabraForms.getResponses(localStorage.getItem('formId'), "onResponses");
  window.onResponses = function(ok, data) {
    if (ok) displayResponses(data.responses); // answers[title] always works, even for edited forms
  };
  \`\`\``,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraForms = {
    createForm: function(title, questions, callbackName) {
      console.log('[AppacadabraForms.createForm] title:', title, 'questions:', questions.length, 'callback:', callbackName);
      sendMessage('FORMS_CREATE', { title, questions }, callbackName);
    },
    updateForm: function(formId, title, questions, callbackName) {
      console.log('[AppacadabraForms.updateForm] formId:', formId, 'questions:', questions.length, 'callback:', callbackName);
      sendMessage('FORMS_UPDATE', { formId, title, questions }, callbackName);
    },
    getResponses: function(formId, callbackName) {
      console.log('[AppacadabraForms.getResponses] formId:', formId, 'callback:', callbackName);
      sendMessage('FORMS_GET_RESPONSES', { formId }, callbackName);
    }
  };
`,

    handleMessage: async (type: string, data: any, _ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        const FORMS_SCOPES = ['https://www.googleapis.com/auth/drive.file'];
        const FORMS_API = 'https://forms.googleapis.com/v1/forms';

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
                        return { success: false, result: `Failed to fetch responses: ${respRes.status} ${await respRes.text()}` };
                    }
                    const respData = await respRes.json();
                    const rawResponses: any[] = respData.responses || [];

                    const responses = rawResponses.map((r: any) => {
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

                    return { success: true, result: JSON.stringify({ responses }) };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Forms get responses error' };
                }
            }

            default:
                return null;
        }
    },
};
