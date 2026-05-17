import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

export const shareCapability: CapabilityModule = {
    id: 'share',
    displayName: 'Share',
    minVersion: '1.0.0',
    description: "`share` opens the native share sheet with text and/or a URL; `shareFile` shares a binary file given its base64 content, MIME type, and filename.",

    docs: `📤 SHARE (AppacadabraShare)
- \`share(text, url, callback)\`
- \`shareFile(base64, mimeType, filename, callback)\`
- **Return**: "Shared" (string)`,

    validationMock: `    window.AppacadabraShare = apiProxy;`,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraShare = {
    share: function(text, url, callbackName) {
        console.log('[AppacadabraShare.share] text:', text?.substring(0, 50), 'url:', url, 'callback:', callbackName);
        sendMessage('SHARE_CONTENT', { text, url }, callbackName);
    },
    shareFile: function(base64, mimeType, filename, callbackName) {
        console.log('[AppacadabraShare.shareFile] mimeType:', mimeType, 'filename:', filename, 'callback:', callbackName);
        sendMessage('SHARE_FILE', { base64, mimeType, filename }, callbackName);
    }
  };
`,

    handleMessage: async (type: string, data: any, _ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        switch (type) {
            case 'SHARE_CONTENT': {
                console.log('[Bridge] Share content request');
                try {
                    const { Share: RNShare, Platform } = require('react-native');
                    const shareContent: { message?: string; url?: string; title?: string } = {};

                    if (Platform.OS === 'android') {
                        const textParts: string[] = [];
                        if (data.text) textParts.push(data.text);
                        if (data.url) textParts.push(data.url);
                        shareContent.message = textParts.join('\n');
                    } else {
                        if (data.text) shareContent.message = data.text;
                        if (data.url) shareContent.url = data.url;
                    }

                    const shareResult = await RNShare.share(shareContent);
                    return { success: true, result: shareResult.action === RNShare.sharedAction ? 'Shared' : 'Dismissed' };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }
            }

            case 'SHARE_FILE': {
                console.log('[Bridge] Share file:', data.filename);
                try {
                    if (await Sharing.isAvailableAsync()) {
                        let sharePath: string;
                        const input: string = data.base64 ?? '';

                        if (input.startsWith('file://') || (input.startsWith('/') && input.length < 500)) {
                            sharePath = input.startsWith('/') ? `file://${input}` : input;
                        } else {
                            let base64Data = input;
                            const commaIdx = input.indexOf(',');
                            if (input.startsWith('data:') && commaIdx !== -1) {
                                base64Data = input.slice(commaIdx + 1);
                            }
                            const safeFilename = (data.filename || 'shared_file')
                                .normalize('NFD')
                                .replace(/[\u0300-\u036f]/g, '')
                                .replace(/[^a-zA-Z0-9._-]/g, '_');
                            sharePath = FileSystem.cacheDirectory + safeFilename;
                            await FileSystem.writeAsStringAsync(sharePath, base64Data, {
                                encoding: FileSystem.EncodingType.Base64,
                            });
                        }

                        await Sharing.shareAsync(sharePath, { mimeType: data.mimeType || 'application/octet-stream' });
                        return { success: true, result: 'File shared' };
                    } else {
                        return { success: false, result: 'Sharing not available' };
                    }
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }
            }

            default:
                return null;
        }
    },
};
