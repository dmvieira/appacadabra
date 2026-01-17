import { useState, useCallback, useEffect } from 'react';
import {
    ExpoSpeechRecognitionModule,
    useSpeechRecognitionEvent
} from 'expo-speech-recognition';
import { getLocales } from 'expo-localization';
import { t } from './i18n';

export function useSpeechToText() {
    const [isListening, setIsListening] = useState(false);
    const [transcript, setTranscript] = useState('');
    const [error, setError] = useState<string | null>(null);

    // Handle recognition results
    useSpeechRecognitionEvent('result', (event) => {
        const text = event.results[0]?.transcript || '';
        setTranscript(text);
    });

    // Handle errors
    useSpeechRecognitionEvent('error', (event) => {
        console.error('Speech recognition error:', event.error);
        setError(event.error);
        setIsListening(false);
    });

    // Handle end of recognition
    useSpeechRecognitionEvent('end', () => {
        setIsListening(false);
    });

    const startListening = useCallback(async () => {
        setError(null);
        setTranscript('');

        // Request permission
        const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!result.granted) {
            setError(t('micPermissionDenied'));
            return;
        }

        try {
            setIsListening(true);
            const locale = getLocales()[0]?.languageTag || 'en-US';
            await ExpoSpeechRecognitionModule.start({
                lang: locale,
                interimResults: true,
                maxAlternatives: 1,
                continuous: false,
            });
        } catch (e) {
            console.error('Failed to start speech recognition:', e);
            setError(t('speechStartError'));
            setIsListening(false);
        }
    }, []);

    const stopListening = useCallback(async () => {
        try {
            await ExpoSpeechRecognitionModule.stop();
        } catch (e) {
            console.error('Failed to stop speech recognition:', e);
        }
        setIsListening(false);
    }, []);

    return {
        isListening,
        transcript,
        error,
        startListening,
        stopListening,
    };
}
