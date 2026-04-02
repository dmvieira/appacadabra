/**
 * Shared helpers used by capability modules.
 * Extracted here to avoid circular imports between capabilities/ and bridges/.
 */
import * as FileSystem from 'expo-file-system/legacy';

/**
 * Creates a JS script that invokes a named callback in the WebView with a result.
 * Mirrors the implementation in bridges/injectedJS.ts to avoid circular imports.
 */
export function createCallbackScript(callbackName: string, success: boolean, data: any): string {
    const dataString = typeof data === 'string' ? data : JSON.stringify(data);

    const escapedData = dataString
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');

    return `
    (function() {
      var __d = "${escapedData}";
      if (__d && (__d[0] === '{' || __d[0] === '[')) { try { __d = JSON.parse(__d); } catch(e) {} }
      var dataPreview = typeof __d === 'string' ? (__d.length > 100 ? __d.substring(0, 100) + "..." : __d) : JSON.stringify(__d).substring(0, 100);
      if ("${callbackName}" && "${callbackName}" !== "undefined") {
          console.log("[BridgeReturn] ${callbackName} | Success: ${success} | Data: " + dataPreview);
          if (typeof window["${callbackName}"] === 'function') {
            window["${callbackName}"](${success}, __d);
          } else if (typeof ${callbackName} === 'function') {
            ${callbackName}(${success}, __d);
          }
      } else {
          console.log("[BridgeReturn] No callback | Data: " + dataPreview);
      }
    })();
  `;
}

const STORAGE_BLOB_MARKER = '__appblob__:';

export const AI_MEDIA_EXT: Record<string, string> = {
    AI_GENERATE_IMAGE: 'jpg', AI_GENERATE_VIDEO: 'mp4',
    CAMERA_TAKE_PHOTO: 'jpg', CAMERA_RECORD_VIDEO: 'mp4',
    AUDIO_RECORD_STOP: 'm4a', AUDIO_SPEAK_AI: 'wav',
};

export async function saveAiMediaToFile(
    appId: number, callbackName: string, action: string, base64: string
): Promise<string> {
    const ext = AI_MEDIA_EXT[action] ?? 'bin';
    const docDir = (FileSystem.documentDirectory ?? '').replace('file://', '');
    const dir = `${docDir}appacadabra_media/${appId}`;
    await FileSystem.makeDirectoryAsync(`file://${dir}`, { intermediates: true }).catch(() => { });
    const path = `${dir}/${callbackName}.${ext}`;
    await FileSystem.writeAsStringAsync(`file://${path}`, base64, { encoding: FileSystem.EncodingType.Base64 });
    return path; // bare path (no file://)
}

export function buildBlobMarker(mimeType: string, callbackName: string, barePath: string): string {
    return `${STORAGE_BLOB_MARKER}${mimeType}|${callbackName}|${barePath}`;
}
