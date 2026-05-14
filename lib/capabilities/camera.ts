import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Audio } from 'expo-av';
import { useBridgeUIStore } from '../bridgeUIStore';
import { saveAiMediaToFile, buildBlobMarker } from './mediaHelpers';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

// Module-level state
let currentVideoSound: Audio.Sound | null = null;
let scannerTimeout: NodeJS.Timeout | null = null;

export const cameraCapability: CapabilityModule = {
    id: 'camera',
    displayName: 'Camera',
    minVersion: '1.0.0',
    androidPermissions: [
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO',
    ],

    docs: `📸 CAMERA (AppacadabraCamera)
- \`takePhoto(callback)\` - Take a photo using the device camera
    - **Callback Data (string)**: Complete DataURI string (\`data:image/jpeg;base64,...\`). Use directly as img src (do NOT append prefixes manually).
    - **Example**: \`AppacadabraCamera.takePhoto("onPhotoTaken")\`
- \`recordVideo(options, callback)\` - Record a video using the device camera
    - **options** (object, optional): \`{ maxDuration?: number (seconds, default 60, max 300), quality?: "high"|"low" }\`
    - **Callback Data (string)**: Complete DataURI string (\`data:video/mp4;base64,...\`). Use with \`AppacadabraAI.fromVideo(uri).generate(...)\`.
    - **Example**: \`AppacadabraCamera.recordVideo({ maxDuration: 30 }, "onVideoRecorded")\`
    - **Example (no options)**: \`AppacadabraCamera.recordVideo("onVideoRecorded")\`
- \`playVideo(base64, options, callback)\` - Play a video from base64 data
    - **options** (object, optional): \`{ mimeType?: "video/mp4"|"video/webm" }\`
    - **Return**: "Playing" (string)
    - **Example**: \`AppacadabraCamera.playVideo(videoBase64, "onPlaying")\`
- \`stopPlaying(callback)\` - Stop current video playback
    - **Return**: "Stopped" (string)
- \`isPlaying(callback)\` - Check if video is currently playing
    - **Return**: "true" or "false" (string)
- \`scan(callback)\` - Open QR/Barcode scanner overlay
    - **Callback Data (string)**: Scanned content string
    - **Example**: \`AppacadabraCamera.scan("onCodeScanned")\``,

    validationMock: `    window.AppacadabraCamera = apiProxy;`,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraCamera = {
      takePhoto: function(callbackName) {
          sendMessage('CAMERA_TAKE_PHOTO', {}, callbackName);
      },
      recordVideo: function(options, callbackName) {
          if (typeof options === 'string') { callbackName = options; options = {}; }
          var opts = options || {};
          console.log('[AppacadabraCamera.recordVideo] maxDuration:', opts.maxDuration || 60, 'callback:', callbackName);
          sendMessage('CAMERA_RECORD_VIDEO', {
              maxDuration: opts.maxDuration || 60,
              quality: opts.quality || 'high'
          }, callbackName);
      },
      playVideo: function(input, options, callbackName) {
          if (typeof options === 'string') { callbackName = options; options = {}; }
          var opts = options || {};
          var payload = { mimeType: opts.mimeType || 'video/mp4' };

          if (typeof input === 'string' && (input.indexOf('http') === 0 || input.indexOf('file://') === 0)) {
              payload.url = input;
          } else {
              payload.base64 = input;
          }

          console.log('[AppacadabraCamera.playVideo] type:', (payload.url ? 'URL' : 'B64'), 'callback:', callbackName);
          sendMessage('VIDEO_PLAY', payload, callbackName);
      },
      stopPlaying: function(callbackName) {
          console.log('[AppacadabraCamera.stopPlaying] callback:', callbackName);
          sendMessage('VIDEO_STOP', {}, callbackName);
      },
      isPlaying: function(callbackName) {
          console.log('[AppacadabraCamera.isPlaying] callback:', callbackName);
          sendMessage('VIDEO_IS_PLAYING', {}, callbackName);
      },
      scan: function(callbackName) {
          sendMessage('SCANNER_SCAN', {}, callbackName);
      }
  };
`,

    handleMessage: async (type: string, data: any, ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        switch (type) {
            case 'CAMERA_TAKE_PHOTO': {
                console.log('[Bridge] Taking photo...');
                const store = useBridgeUIStore.getState();
                try {
                    const permission = await ImagePicker.requestCameraPermissionsAsync();
                    if (!permission.granted) throw new Error('Camera permission denied');

                    // Small delay to ensure ActivityResultLauncher is registered on Android
                    if (Platform.OS === 'android') {
                        await new Promise(resolve => setTimeout(resolve, 150));
                    }

                    store.setNativeActivityActive(true);
                    const resultPicker = await ImagePicker.launchCameraAsync({
                        mediaTypes: ['images'] as any,
                        base64: true,
                        quality: 0.5,
                    });

                    if (!resultPicker.canceled) {
                        let b64 = '';
                        if (resultPicker.assets[0].base64) {
                            b64 = resultPicker.assets[0].base64.replace(/[\r\n]/g, '');
                        } else {
                            b64 = await FileSystem.readAsStringAsync(resultPicker.assets[0].uri, { encoding: FileSystem.EncodingType.Base64 });
                            b64 = b64.replace(/[\r\n]/g, '');
                        }

                        if (ctx.appId && ctx.callbackName && b64) {
                            const path = await saveAiMediaToFile(ctx.appId, ctx.callbackName, 'CAMERA_TAKE_PHOTO', b64);
                            const result = buildBlobMarker('image/jpeg', ctx.callbackName, path);
                            console.log(`[Bridge] Photo saved to ${path}, returning marker`);
                            return { success: true, result };
                        } else {
                            return { success: true, result: b64 };
                        }
                    } else {
                        return { success: false, result: 'Cancelled' };
                    }
                } catch (e) {
                    console.error('Camera error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Camera failed' };
                } finally {
                    store.setNativeActivityActive(false);
                }
            }

            case 'CAMERA_RECORD_VIDEO': {
                console.log(`[Bridge] Recording video... maxDuration=${data.maxDuration || 60}`);
                const videoStore = useBridgeUIStore.getState();
                try {
                    const camPerm = await ImagePicker.requestCameraPermissionsAsync();
                    if (!camPerm.granted) throw new Error('Camera permission denied');

                    const audioPerm = await Audio.requestPermissionsAsync();
                    if (!audioPerm.granted) {
                        console.warn('[Bridge] Audio permission denied, recording video without audio');
                    }

                    const maxDuration = Math.min(data.maxDuration || 60, 300);
                    const quality = data.quality === 'low' ? 0 : 1;

                    // Small delay to ensure ActivityResultLauncher is registered on Android
                    if (Platform.OS === 'android') {
                        await new Promise(resolve => setTimeout(resolve, 150));
                    }

                    videoStore.setNativeActivityActive(true);
                    const videoPicker = await ImagePicker.launchCameraAsync({
                        mediaTypes: ['videos'] as any,
                        videoMaxDuration: maxDuration,
                        videoQuality: quality,
                    });

                    if (!videoPicker.canceled && videoPicker.assets[0]) {
                        const videoUri = videoPicker.assets[0].uri;
                        const videoBase64 = await FileSystem.readAsStringAsync(videoUri, {
                            encoding: FileSystem.EncodingType.Base64,
                        });
                        const b64 = videoBase64.replace(/[\r\n]/g, '');

                        if (ctx.appId && ctx.callbackName && b64) {
                            const path = await saveAiMediaToFile(ctx.appId, ctx.callbackName, 'CAMERA_RECORD_VIDEO', b64);
                            const result = buildBlobMarker('video/mp4', ctx.callbackName, path);
                            console.log(`[Bridge] Video recorded and saved to ${path}, returning marker`);
                            return { success: true, result };
                        } else {
                            return { success: true, result: b64 };
                        }
                    } else {
                        return { success: false, result: 'Cancelled' };
                    }
                } catch (e) {
                    console.error('Video record error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Video recording failed' };
                } finally {
                    videoStore.setNativeActivityActive(false);
                }
            }

            case 'VIDEO_PLAY': {
                console.log('[Bridge] Playing video...');
                try {
                    await Audio.setAudioModeAsync({
                        allowsRecordingIOS: false,
                        playsInSilentModeIOS: true,
                        staysActiveInBackground: false,
                    });

                    if (!data.base64 && !data.url) throw new Error('No video data provided');

                    let videoFileUri = '';

                    if (data.url) {
                        videoFileUri = data.url;
                    } else {
                        const cleanBase64 = data.base64.replace(/^data:.*?;base64,/i, '').replace(/\s/g, '');

                        const mimeType = data.mimeType || 'video/mp4';
                        const ext = mimeType.includes('webm') ? 'webm' : 'mp4';
                        videoFileUri = FileSystem.cacheDirectory + `video_play_${Date.now()}.${ext}`;

                        await FileSystem.writeAsStringAsync(videoFileUri, cleanBase64, {
                            encoding: FileSystem.EncodingType.Base64,
                        });
                    }

                    if (currentVideoSound) {
                        try { await currentVideoSound.unloadAsync(); } catch (_) { }
                        currentVideoSound = null;
                    }

                    const uiStore = useBridgeUIStore.getState();
                    uiStore.openVideoPlayer(videoFileUri, ctx.callbackName);

                    return { success: true, result: 'Playing', deferredCallback: true };
                } catch (e) {
                    console.error('Video play error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Video playback failed' };
                }
            }

            case 'VIDEO_STOP': {
                console.log('[Bridge] Stopping video playback...');
                try {
                    if (currentVideoSound) {
                        await currentVideoSound.stopAsync();
                        await currentVideoSound.unloadAsync();
                        currentVideoSound = null;
                    }
                    return { success: true, result: 'Stopped' };
                } catch (e) {
                    console.error('Video stop error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Video stop failed' };
                }
            }

            case 'VIDEO_IS_PLAYING': {
                console.log('[Bridge] Checking video playback status...');
                try {
                    if (currentVideoSound) {
                        const status = await currentVideoSound.getStatusAsync();
                        return { success: true, result: status.isLoaded && status.isPlaying ? 'true' : 'false' };
                    } else {
                        return { success: true, result: 'false' };
                    }
                } catch (e) {
                    return { success: true, result: 'false' };
                }
            }

            case 'SCANNER_SCAN': {
                console.log('[Bridge] Opening QR scanner...');
                const callbackName = data.callback || ctx.callbackName;

                useBridgeUIStore.getState().openScanner(callbackName);

                if (scannerTimeout) clearTimeout(scannerTimeout);
                scannerTimeout = setTimeout(() => {
                    console.log('[Bridge] Auto-closing scanner due to timeout');
                    useBridgeUIStore.getState().closeScanner();
                }, 2 * 60 * 1000);

                return { success: true, result: 'Scanner opened', handled: true, deferredCallback: true };
            }

            default:
                return null;
        }
    },
};
