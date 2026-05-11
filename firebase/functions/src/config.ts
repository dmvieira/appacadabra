export const OR_BASE_URL = 'https://openrouter.ai/api/v1';

export const MODELS = {
    SPELL_S: 'deepseek/deepseek-v4-flash',
    SUGGEST: 'openai/gpt-oss-120b:free',
    WEBVIEW: 'google/gemini-3.1-flash-lite-preview',
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const OR_REASONING_HIGH: any = { reasoning: { effort: 'high' } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const OR_WEB_SEARCH: any = { tools: [{ type: 'openrouter:web_search' }] };
