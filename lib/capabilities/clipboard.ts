import { CapabilityModule } from './types';

export const clipboardCapability: CapabilityModule = {
    id: 'clipboard',
    displayName: 'Clipboard',
    minVersion: '1.0.0',

    docs: `📋 CLIPBOARD (AppacadabraClipboard)
- \`setString(text)\` - Copy text to clipboard
- \`getString(callback)\` - Get text from clipboard
    - **Return**: Clipboard text (string)`,

    validationMock: `    window.AppacadabraClipboard = apiProxy;`,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraClipboard = {
    setString: function(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(e => console.error('Clipboard error:', e));
        } else {
            console.warn('Clipboard API not available');
        }
    },
    getString: function(callbackName) {
        if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText()
                .then(text => sendCallback(callbackName, text))
                .catch(e => sendCallback(callbackName, null, e.message));
        } else {
            sendCallback(callbackName, null, 'Clipboard API not available');
        }
    }
  };
`,

    // Clipboard is pure WebView Web API — no native bridge messages.
    handleMessage: async (_type: string, _data: any, _ctx: any) => null,
};
