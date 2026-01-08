import { useState, useCallback, useEffect } from 'react';
import {
    ExpoSpeechRecognitionModule,
    useSpeechRecognitionEvent
} from 'expo-speech-recognition';

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
            setError('Permissão de microfone negada');
            return;
        }

        try {
            setIsListening(true);
            await ExpoSpeechRecognitionModule.start({
                lang: 'pt-BR',
                interimResults: true,
                maxAlternatives: 1,
                continuous: false,
            });
        } catch (e) {
            console.error('Failed to start speech recognition:', e);
            setError('Erro ao iniciar reconhecimento de voz');
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
