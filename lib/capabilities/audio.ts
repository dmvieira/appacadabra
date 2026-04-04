import * as Speech from 'expo-speech';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import * as ai from '../api/ai';
import { useManaStore } from '../manaStore';
import { useBridgeUIStore } from '../bridgeUIStore';
import { useAppStore } from '../store';
import * as db from '../database/db';
import { saveAiMediaToFile, buildBlobMarker } from './mediaHelpers';
import { t } from '../i18n';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

// Module-level state
let currentRecording: Audio.Recording | null = null;
let audioRecordingTimeout: NodeJS.Timeout | null = null;
let currentAITTS: Audio.Sound | null = null;

async function estimateManaCost(type: string, data: any): Promise<{ display: string; value: number }> {
    const manaLabel = t('mana');
    const result = await ai.estimateManaCost(type, data);
    return { display: `${result.mana} ${manaLabel}`, value: result.value };
}

async function checkAndMarkFirstAiUse(): Promise<boolean> {
    const hasUsed = await db.getSetting('has_used_ai_ever');
    if (!hasUsed) {
        await db.setSetting('has_used_ai_ever', 'true');
        return true;
    }
    return false;
}

export const audioCapability: CapabilityModule = {
    id: 'audio',
    displayName: 'Audio',
    minVersion: '1.0.0',
    androidPermissions: [
        'android.permission.RECORD_AUDIO',
        'android.permission.MODIFY_AUDIO_SETTINGS',
    ],

    docs: `🎙️ AUDIO (AppacadabraAudio)
- \`recordStart(callback)\` - Start audio recording (M4A/AAC)
    - **Return**: "Recording started"
- \`recordStop(callback)\` - Stop recording and get result
    - **Callback Data (string)**: Complete DataURI string (\`data:audio/m4a;base64,...\`). **CRITICAL**: Use this string immediately with \`AppacadabraAI.fromAudio(uri).generate(...)\` or in an \`<audio>\` tag. do NOT append prefixes.
    - **Example**: \`AppacadabraAudio.recordStop("onAudioRecorded")\`
- \`speak(text, options, callback)\` - Speak text aloud using device TTS engine (free)
    - **options** (object, optional): \`{ language?: "en-US"|"pt-BR"|..., pitch?: 0.5-2.0, rate?: 0.5-2.0, volume?: 0.0-1.0 }\`
    - **Return**: "Speaking" (string)
    - **Example**: \`AppacadabraAudio.speak("Hello world", { language: "en-US", rate: 1.0 }, "onSpeakDone")\`
- \`speakAI(text, options, callback)\` - Generate high-quality AI voice using Gemini TTS (costs Mana ⚡)
    - **options** (object, optional): \`{ voice?: "Aoede"|"Charon"|"Fenrir"|"Kore"|"Puck"|"Orbit"|"Zephyr", language?: "en-US"|"pt-BR"|... }\`
    - Default voice: "Aoede". Cost: ~0.01–0.05 Mana per sentence (depends on text length)
    - Use \`speak()\` for free device TTS; use \`speakAI()\` when voice quality matters
    - **Return**: "Speaking" (string) — callback called when audio starts playing
    - **Example**: \`AppacadabraAudio.speakAI("Welcome to your spell!", { voice: "Kore" }, "onSpeakDone")\`
- \`stopSpeaking(callback)\` - Stop ALL speech (current + queued)
    - **Return**: "Stopped" (string)
- \`isSpeaking(callback)\` - Check if currently speaking
    - **Return**: "true" or "false" (string)

--- VOICE INPUT WORKFLOW (EXAMPLE) ---
\`\`\`javascript
function onMicrophoneClick() {
  if (!isRecording) {
    AppacadabraAudio.recordStart("onStart");
  } else {
    AppacadabraAudio.recordStop("onAudioResult");
  }
}

window.onAudioResult = function(success, base64) {
  if (success) {
    AppacadabraAI.fromAudio(base64)
      .withSchema(mySchema)
      .generate("Extract data from this audio", "onAIProcessed");
  }
}
\`\`\``,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraAudio = {
      recordStart: function(callbackName) {
          sendMessage('AUDIO_RECORD_START', {}, callbackName);
      },
      recordStop: function(callbackName) {
          sendMessage('AUDIO_RECORD_STOP', {}, callbackName);
      },
      speak: function(text, options, callbackName) {
        console.log('[AppacadabraAudio.speak] text:', text && text.substring(0, 50), 'callback:', callbackName);
        var opts = options || {};
        sendMessage('TTS_SPEAK', { text: text, language: opts.language, pitch: opts.pitch, rate: opts.rate, volume: opts.volume }, callbackName);
      },
      speakAI: function(text, options, callbackName) {
        console.log('[AppacadabraAudio.speakAI] text:', text && text.substring(0, 50), 'callback:', callbackName);
        var opts = options || {};
        var interceptName = '__caits' + Date.now();
        __setupLegacyBlobInterceptor(callbackName, interceptName);
        sendMessage('AUDIO_SPEAK_AI', {
          text: text,
          voiceName: opts.voice || 'Aoede',
          language: opts.language || null
        }, interceptName);
      },
      stopSpeaking: function(callbackName) {
        console.log('[AppacadabraAudio.stopSpeaking] callback:', callbackName);
        sendMessage('TTS_STOP', {}, callbackName);
      },
      isSpeaking: function(callbackName) {
        console.log('[AppacadabraAudio.isSpeaking] callback:', callbackName);
        sendMessage('TTS_IS_SPEAKING', {}, callbackName);
      }
  };
`,

    handleMessage: async (type: string, data: any, ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        switch (type) {
            case 'TTS_SPEAK': {
                try {
                    const { text, language, pitch, rate, volume } = data;
                    if (!text) {
                        return { success: false, result: 'Text is required' };
                    }
                    const options: Speech.SpeechOptions = {};
                    if (language) options.language = language;
                    if (pitch !== undefined) options.pitch = pitch;
                    if (rate !== undefined) options.rate = rate;
                    if (volume !== undefined) options.volume = volume;
                    options.onDone = () => {
                        console.log('[Bridge] TTS finished speaking');
                    };
                    Speech.speak(text, options);
                    return { success: true, result: 'Speaking' };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'TTS Error' };
                }
            }

            case 'TTS_STOP': {
                try {
                    Speech.stop();
                    return { success: true, result: 'Stopped' };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'TTS Stop Error' };
                }
            }

            case 'TTS_IS_SPEAKING': {
                try {
                    const speaking = await Speech.isSpeakingAsync();
                    return { success: true, result: speaking ? 'true' : 'false' };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'TTS Error' };
                }
            }

            case 'AUDIO_SPEAK_AI': {
                let audioCostDisplay: string;
                let audioCostValue: number;
                try {
                    ({ display: audioCostDisplay, value: audioCostValue } = await estimateManaCost('audio', data));
                } catch (e) {
                    console.warn('[Bridge] Mana estimation failed, blocking operation:', e);
                    useManaStore.getState().openShop();
                    return { success: false, result: t('manaDepletedMessage') };
                }
                if (audioCostValue > useManaStore.getState().balance) {
                    useManaStore.getState().openShop(audioCostValue);
                    return { success: false, result: t('manaDepletedMessage') };
                }
                const manaConfirmedAudio = await useBridgeUIStore.getState()
                    .requestManaConfirmation(ctx.appId, 'audio', audioCostDisplay);
                if (!manaConfirmedAudio) { return { success: false, result: t('manaConfirmCancelled') }; }
                console.log(`[Bridge] AI TTS request: "${data.text?.substring(0, 50)}..." voice=${data.voiceName || 'Aoede'}`);
                try {
                    const ttsResult = await ai.aiGenerateTTS(data.text, data.voiceName, ctx.onJobCreated);
                    const { audioBase64, creditsUsed } = ttsResult;

                    let permanentPath: string | undefined;
                    if (ctx.appId && ctx.callbackName) {
                        try {
                            const docDir = (FileSystem.documentDirectory ?? '').replace('file://', '');
                            const dir = `${docDir}appacadabra_media/${ctx.appId}`;
                            await FileSystem.makeDirectoryAsync(`file://${dir}`, { intermediates: true }).catch(() => { });
                            permanentPath = `${dir}/${ctx.callbackName}.wav`;
                            await FileSystem.writeAsStringAsync(`file://${permanentPath}`, audioBase64.replace(/[\r\n]/g, ''), {
                                encoding: FileSystem.EncodingType.Base64,
                            });
                        } catch (saveErr) {
                            console.warn('[AUDIO_SPEAK_AI] Failed to save permanent file:', saveErr);
                        }
                    }

                    const fileUri = FileSystem.cacheDirectory + `tts_${Date.now()}.wav`;
                    await FileSystem.writeAsStringAsync(fileUri, audioBase64.replace(/[\r\n]/g, ''), {
                        encoding: FileSystem.EncodingType.Base64,
                    });

                    const { sound } = await Audio.Sound.createAsync(
                        { uri: fileUri },
                        { shouldPlay: true }
                    );
                    currentAITTS = sound;

                    sound.setOnPlaybackStatusUpdate(async (status) => {
                        if (status.isLoaded && status.didJustFinish) {
                            if (currentAITTS === sound) currentAITTS = null;
                            await sound.unloadAsync();
                            try { await FileSystem.deleteAsync(fileUri, { idempotent: true }); } catch (_) { }
                        }
                    });

                    if (ctx.appId && creditsUsed > 0) {
                        try {
                            await useAppStore.getState().incrementAppManaCost(ctx.appId, creditsUsed);
                            console.log(`[Bridge] App ${ctx.appId} mana cost increased by ${creditsUsed}`);
                        } catch (e) {
                            console.warn('Failed to update app mana cost:', e);
                        }
                    }

                    const isFirstAiUse = await checkAndMarkFirstAiUse();

                    let result: string;
                    if (permanentPath && ctx.callbackName) {
                        result = buildBlobMarker('audio/wav', ctx.callbackName, permanentPath);
                        console.log(`[Bridge] AUDIO_SPEAK_AI returning blob marker: ${result}`);
                    } else {
                        result = audioBase64;
                    }

                    return { success: true, result, creditsUsed, isFirstAiUse };
                } catch (e) {
                    const errorMsg = e instanceof Error ? e.message : 'Error';

                    const isManaError = errorMsg.toLowerCase().includes('insufficient credits') ||
                        errorMsg.toLowerCase().includes('insufficient mana');

                    if (isManaError) {
                        useManaStore.getState().openShop();
                        return { success: false, result: t('manaDepletedMessage') };
                    } else {
                        console.warn('[AUDIO_SPEAK_AI] AI TTS failed, falling back to Speech.speak:', errorMsg);
                        try {
                            Speech.speak(data.text, { language: data.language || undefined });
                            return { success: true, result: 'Speaking' };
                        } catch (fallbackErr) {
                            return { success: false, result: errorMsg };
                        }
                    }
                }
            }

            case 'AUDIO_RECORD_START': {
                console.log('[Bridge] Starting audio recording...');
                try {
                    const perm = await Audio.requestPermissionsAsync();
                    if (!perm.granted) throw new Error('Audio permission denied');

                    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
                    if (currentRecording) { await currentRecording.stopAndUnloadAsync(); currentRecording = null; }

                    const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
                    currentRecording = recording;

                    if (audioRecordingTimeout) clearTimeout(audioRecordingTimeout);
                    audioRecordingTimeout = setTimeout(async () => {
                        console.log('[Bridge] Auto-stopping audio recording due to timeout');
                        if (currentRecording) {
                            try {
                                await currentRecording.stopAndUnloadAsync();
                            } catch (e) {
                                console.warn('Error auto-stopping audio:', e);
                            }
                            currentRecording = null;
                        }
                    }, 5 * 60 * 1000);

                    return { success: true, result: 'Recording started' };
                } catch (e) {
                    console.error('Audio start error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Audio start failed' };
                }
            }

            case 'AUDIO_RECORD_STOP': {
                console.log('[Bridge] Stopping audio recording...');
                try {
                    if (!currentRecording) throw new Error('No recording active');
                    await currentRecording.stopAndUnloadAsync();

                    if (audioRecordingTimeout) {
                        clearTimeout(audioRecordingTimeout);
                        audioRecordingTimeout = null;
                    }

                    const uri = currentRecording.getURI();
                    currentRecording = null;

                    if (uri) {
                        const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
                        if (ctx.appId && ctx.callbackName && base64) {
                            const path = await saveAiMediaToFile(ctx.appId, ctx.callbackName, 'AUDIO_RECORD_STOP', base64);
                            const result = buildBlobMarker('audio/m4a', ctx.callbackName, path);
                            console.log(`[Bridge] Audio recorded and saved to ${path}, returning marker`);
                            return { success: true, result };
                        } else {
                            return { success: true, result: base64 };
                        }
                    } else {
                        throw new Error('No recording URI');
                    }
                } catch (e) {
                    console.error('Audio stop error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Audio stop failed' };
                }
            }

            default:
                return null;
        }
    },
};
