import * as Print from 'expo-print';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

export const screenCapability: CapabilityModule = {
    id: 'screen',
    displayName: 'Screen',
    minVersion: '1.0.0',

    docs: `🎨 SCREEN (AppacadabraScreen)
- \`print()\` - Open native print dialog
- \`capture(callback)\` - Capture screenshot of current view
    - **Callback Data (string)**: Base64 encoded PNG image
    - **Example**: \`AppacadabraScreen.capture("onScreenshotTaken")\``,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraScreen = {
      print: function() {
          sendMessage('PRINT', { html: document.documentElement.outerHTML });
      },
      capture: function(callbackName) {
          sendMessage('SCREEN_CAPTURE', {}, callbackName);
      }
  };
`,

    handleMessage: async (type: string, data: any, ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        switch (type) {
            case 'SCREEN_CAPTURE': {
                console.log('[Bridge] Capturing screen...');
                const captureTarget = (ctx.viewContainerRef?.current)
                    ?? (ctx.webViewRef?.current ?? null);

                if (captureTarget) {
                    try {
                        const { captureRef } = require('react-native-view-shot');
                        const uri = await captureRef(captureTarget, { format: 'png', quality: 0.8, result: 'base64' });
                        return { success: true, result: uri.replace(/(\r\n|\n|\r)/gm, '') };
                    } catch (e) {
                        return { success: false, result: e instanceof Error ? e.message : 'Screen capture failed' };
                    }
                } else {
                    return { success: false, result: 'Capture target not available' };
                }
            }

            case 'PRINT': {
                console.log('[Bridge] Requesting print dialog...');
                try {
                    if (data.html) {
                        await Print.printAsync({ html: data.html });
                        return { success: true, result: 'Print dialog opened' };
                    } else {
                        return { success: false, result: 'No content to print' };
                    }
                } catch (e) {
                    console.error('Print error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Print failed' };
                }
            }

            default:
                return null;
        }
    },
};
