export const OR_BASE_URL = 'https://openrouter.ai/api/v1';

export const MODELS = {
    SPELL_S: 'deepseek/deepseek-v4-flash',
    SUGGEST: 'deepseek/deepseek-v4-flash',
    WEBVIEW: 'google/gemini-3.1-flash-lite',
    IMAGE: 'google/gemini-3.1-flash-image-preview',
    IMAGE_EDIT: 'google/gemini-2.5-flash-image',
    TTS: 'google/gemini-3.1-flash-tts-preview',
    EMBED: 'google/gemini-embedding-001',
    VIDEO_FAST: 'google/veo-3.1-lite',
    VIDEO_STD: 'google/veo-3.1-fast',
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const OR_REASONING_HIGH: any = { reasoning: { effort: 'high' } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const OR_WEB_SEARCH: any = {
    tools: [
        {
            type: 'openrouter:web_search',
            parameters: {
                engine: 'parallel',
                max_results: 10,
                max_total_results: 20,
            }
        },
        {
            type: 'openrouter:web_fetch',
            parameters: {
                engine: 'openrouter',
                max_uses: 10,
                max_content_tokens: 50000,
            }
        }
    ]
};
