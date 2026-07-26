import * as Speech from 'expo-speech';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import * as ai from '../api/ai';
import { useBridgeUIStore } from '../bridgeUIStore';
import * as db from '../database/db';
import { saveAiMediaToFile, buildBlobMarker } from './mediaHelpers';
import { hasOpenRouterKey } from '../api/keyStorage';
import { estimateUsd, formatUsd } from '../api/pricing';
import { getPreferredModel } from '../api/modelPreferences';
import { signalModelUnavailable } from '../api/modelUnavailableSignal';
import { withKeepAlive } from '../webviewAiKeepAlive';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

// Module-level state
let currentRecording: Audio.Recording | null = null;
let audioRecordingTimeout: NodeJS.Timeout | null = null;
let currentAITTS: Audio.Sound | null = null;

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
    description: "`recordStart`/`recordStop` capture microphone audio (M4A); `play`/`stop`/`isPlaying` play audio from base64 or URL; `speak` uses the device TTS engine (free); `speakAI`/`stopSpeaking`/`isSpeaking` drive high-quality AI voice (costs credits); `generateMusic` generates full songs from a text prompt and returns base64 WAV (costs credits — model configurable in Settings).",
    androidPermissions: [
        'android.permission.RECORD_AUDIO',
        'android.permission.MODIFY_AUDIO_SETTINGS',
    ],

    docs: `🎙️ AUDIO (AppacadabraAudio)
- \`recordStart(callback)\` - Start audio recording (M4A/AAC)
    - **Return**: "Recording started"
- \`recordStop(callback)\` - Stop recording and get result
    - **Callback Data (string)**: Complete DataURI string (\`data:audio/mp4;base64,...\`). **CRITICAL**: Use this string immediately with \`AppacadabraAI.fromAudio(uri).generate(...)\` or in an \`<audio>\` tag. do NOT append prefixes.
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
- \`generateMusic(prompt, callback)\` - Generate a full song from a text prompt (costs credits — model configurable in Settings > AI Provider). Returns raw base64 WAV; use \`play()\` to hear it.
    - **Callback Data (string)**: base64 WAV.
    - **Example**:
      \`\`\`javascript
      AppacadabraAudio.generateMusic("upbeat lo-fi hip hop about coffee", function(ok, base64) {
        if (ok) AppacadabraAudio.play(base64, { mimeType: "audio/wav" }, "onPlaying");
      });
      \`\`\`
- \`stopSpeaking(callback)\` - Stop ALL speech (current + queued)
    - **Return**: "Stopped" (string)
- \`isSpeaking(callback)\` - Check if currently speaking
    - **Return**: "true" or "false" (string)
- \`play(input, options, callback)\` - Play audio from base64 or URL
    - **input** (string): Base64 DataURI (\`data:audio/mp4;base64,...\`), Blob marker (\`__appblob__:...\`), or URL
    - **options** (object, optional): \`{ mimeType?: "audio/mp4"|"audio/wav" }\`
    - **Return**: "Playing" (string)
    - **Example**: \`AppacadabraAudio.play(audioBase64, "onPlaying")\`
- \`stop(callback)\` - Stop current audio playback
    - **Return**: "Stopped" (string)
- \`isPlaying(callback)\` - Check if audio is currently playing
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

    validationMock: `    window.AppacadabraAudio = apiProxy;`,

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
      generateMusic: function(prompt, callbackName) {
        console.log('[AppacadabraAudio.generateMusic] prompt:', prompt && prompt.substring(0, 50), 'callback:', callbackName);
        var interceptName = '__caigm' + Date.now();
        __setupLegacyBlobInterceptor(callbackName, interceptName);
        sendMessage('AUDIO_GENERATE_MUSIC', { prompt: prompt }, interceptName);
      },
      stopSpeaking: function(callbackName) {
        console.log('[AppacadabraAudio.stopSpeaking] callback:', callbackName);
        sendMessage('TTS_STOP', {}, callbackName);
      },
      isSpeaking: function(callbackName) {
        console.log('[AppacadabraAudio.isSpeaking] callback:', callbackName);
        sendMessage('TTS_IS_SPEAKING', {}, callbackName);
      },
      play: function(input, options, callbackName) {
        if (typeof options === 'string') { callbackName = options; options = {}; }
        var opts = options || {};
        var payload = { mimeType: opts.mimeType || 'audio/mp4' };

        if (typeof input === 'string' && (input.indexOf('http') === 0 || input.indexOf('file://') === 0)) {
            payload.url = input;
        } else {
            payload.base64 = input;
        }

        console.log('[AppacadabraAudio.play] type:', (payload.url ? 'URL' : 'B64'), 'callback:', callbackName);
        sendMessage('AUDIO_PLAY', payload, callbackName);
      },
      stop: function(callbackName) {
        console.log('[AppacadabraAudio.stop] callback:', callbackName);
        sendMessage('AUDIO_STOP', {}, callbackName);
      },
      isPlaying: function(callbackName) {
        console.log('[AppacadabraAudio.isPlaying] callback:', callbackName);
        sendMessage('AUDIO_IS_PLAYING', {}, callbackName);
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
                const hasKey = await hasOpenRouterKey();
                if (!hasKey) {
                    const action = await useBridgeUIStore.getState().requestKeyMissing('audio');
                    return {
                        success: false,
                        result:
                            action === 'openSettings'
                                ? 'AI key required. Configure OpenRouter to continue.'
                                : 'AI key not configured.',
                    };
                }
                const audioUsd = estimateUsd({
                    type: 'webview_ai_tts',
                    promptLength: 0,
                    ttsCharacters: typeof data?.text === 'string' ? data.text.length : 0,
                });
                const confirmedAudio = await useBridgeUIStore.getState()
                    .requestCostEstimate(ctx.appId, 'audio', formatUsd(audioUsd), await getPreferredModel('TTS'));
                if (!confirmedAudio) { return { success: false, result: 'Cost confirmation cancelled.' }; }
                console.log(`[Bridge] AI TTS request: "${data.text?.substring(0, 50)}..." voice=${data.voiceName || 'Aoede'}`);
                try {
                    const ttsResult = await ai.aiGenerateTTS(data.text, data.voiceName);
                    const { audioBase64 } = ttsResult;
                    const costUsd = ttsResult.costUsd || 0;

                    // Mirror AUDIO_PLAY (~line 316) — without this a prior
                    // recordStart or another capability leaves the audio
                    // session in a mode that silences MediaPlayer on Android.
                    await Audio.setAudioModeAsync({
                        allowsRecordingIOS: false,
                        playsInSilentModeIOS: true,
                        staysActiveInBackground: false,
                    });

                    if (currentAITTS) {
                        try { await currentAITTS.stopAsync(); await currentAITTS.unloadAsync(); } catch (_) { }
                        currentAITTS = null;
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

                    if (ctx.appId) await db.incrementSpendUsd(ctx.appId, costUsd);

                    const isFirstAiUse = await checkAndMarkFirstAiUse();

                    // Runner owns disk persistence, cache registration and chunked WebView delivery.
                    return { success: true, result: audioBase64, creditsUsed: costUsd, isFirstAiUse };
                } catch (e) {
                    const errorMsg = e instanceof Error ? e.message : 'Error';
                    // Surface the picker modal if the user's chosen TTS model
                    // is dead. We still fall back to native Speech below so
                    // the user hears *something*; the modal is the recovery
                    // path they'll use next time.
                    signalModelUnavailable(
                        ctx.appId ?? null,
                        'TTS',
                        e,
                        await getPreferredModel('TTS'),
                    );
                    console.warn('[AUDIO_SPEAK_AI] AI TTS failed, falling back to Speech.speak:', errorMsg);
                    try {
                        Speech.speak(data.text, { language: data.language || undefined });
                        return { success: true, result: 'Speaking' };
                    } catch (fallbackErr) {
                        return { success: false, result: errorMsg };
                    }
                }
            }

            case 'AUDIO_GENERATE_MUSIC': {
                const hasKey = await hasOpenRouterKey();
                if (!hasKey) {
                    const action = await useBridgeUIStore.getState().requestKeyMissing('music');
                    return {
                        success: false,
                        result:
                            action === 'openSettings'
                                ? 'AI key required. Configure OpenRouter to continue.'
                                : 'AI key not configured.',
                    };
                }
                const musicUsd = estimateUsd({ type: 'webview_ai_music' });
                const confirmedMusic = await useBridgeUIStore.getState()
                    .requestCostEstimate(ctx.appId, 'music', formatUsd(musicUsd), await getPreferredModel('MUSIC'));
                if (!confirmedMusic) { return { success: false, result: 'Cost confirmation cancelled.' }; }
                console.log(`[Bridge] Music generation request: "${data.prompt?.substring(0, 50)}..."`);
                try {
                    const { audioBase64, costUsd } = await withKeepAlive('music', () => ai.aiGenerateMusic(data.prompt));
                    if (ctx.appId) await db.incrementSpendUsd(ctx.appId, costUsd);
                    const isFirstAiUse = await checkAndMarkFirstAiUse();
                    // Returns raw base64 only — the spell decides when/how to
                    // play it via AppacadabraAudio.play(). Reusing AUDIO_PLAY
                    // keeps a single Sound state machine on the native side.
                    return { success: true, result: audioBase64, creditsUsed: costUsd, isFirstAiUse };
                } catch (e) {
                    const errorMsg = e instanceof Error ? e.message : 'Error';
                    signalModelUnavailable(
                        ctx.appId ?? null,
                        'MUSIC',
                        e,
                        await getPreferredModel('MUSIC'),
                    );
                    console.warn('[AUDIO_GENERATE_MUSIC] failed:', errorMsg);
                    return { success: false, result: errorMsg };
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
                            const result = buildBlobMarker('audio/mp4', ctx.callbackName, path);
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

            case 'AUDIO_PLAY': {
                console.log('[Bridge] Playing audio...');
                try {
                    await Audio.setAudioModeAsync({
                        allowsRecordingIOS: false,
                        playsInSilentModeIOS: true,
                        staysActiveInBackground: false,
                    });

                    if (!data.base64 && !data.url) throw new Error('No audio data provided');

                    let audioFileUri = '';

                    if (data.url) {
                        audioFileUri = data.url;
                    } else {
                        const cleanBase64 = data.base64.replace(/^data:.*?;base64,/i, '').replace(/\s/g, '');
                        const mimeType = data.mimeType || 'audio/mp4';
                        const ext = mimeType.includes('wav') ? 'wav' : 'm4a';
                        audioFileUri = FileSystem.cacheDirectory + `audio_play_${Date.now()}.${ext}`;

                        await FileSystem.writeAsStringAsync(audioFileUri, cleanBase64, {
                            encoding: FileSystem.EncodingType.Base64,
                        });
                    }

                    if (currentAITTS) {
                        try { await currentAITTS.stopAsync(); await currentAITTS.unloadAsync(); } catch (_) { }
                        currentAITTS = null;
                    }

                    const { sound } = await Audio.Sound.createAsync(
                        { uri: audioFileUri },
                        { shouldPlay: true }
                    );
                    currentAITTS = sound;

                    sound.setOnPlaybackStatusUpdate(async (status) => {
                        if (status.isLoaded && status.didJustFinish) {
                            if (currentAITTS === sound) currentAITTS = null;
                            await sound.unloadAsync();
                        }
                    });

                    return { success: true, result: 'Playing' };
                } catch (e) {
                    console.error('Audio play error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Audio playback failed' };
                }
            }

            case 'AUDIO_STOP': {
                console.log('[Bridge] Stopping audio playback...');
                try {
                    if (currentAITTS) {
                        await currentAITTS.stopAsync();
                        await currentAITTS.unloadAsync();
                        currentAITTS = null;
                    }
                    return { success: true, result: 'Stopped' };
                } catch (e) {
                    console.error('Audio stop error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Audio stop failed' };
                }
            }

            case 'AUDIO_IS_PLAYING': {
                try {
                    if (currentAITTS) {
                        const status = await currentAITTS.getStatusAsync();
                        return { success: true, result: status.isLoaded && status.isPlaying ? 'true' : 'false' };
                    }
                    return { success: true, result: 'false' };
                } catch (e) {
                    return { success: false, result: 'false' };
                }
            }

            default:
                return null;
        }
    },

    cleanup: async () => {
        console.log('[AudioCapability] Cleaning up...');
        if (currentRecording) {
            try { await currentRecording.stopAndUnloadAsync(); } catch (_) { }
            currentRecording = null;
        }
        if (audioRecordingTimeout) {
            clearTimeout(audioRecordingTimeout);
            audioRecordingTimeout = null;
        }
        if (currentAITTS) {
            try { await currentAITTS.stopAsync(); await currentAITTS.unloadAsync(); } catch (_) { }
            currentAITTS = null;
        }
        try { Speech.stop(); } catch (_) { }
    }
};
