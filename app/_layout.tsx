import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../lib/theme';
import ShareReceiver from '../components/ShareReceiver';

export default function RootLayout() {
    const router = useRouter();
    const segments = useSegments();
    const appState = useRef(AppState.currentState);

    // Reset to index when app becomes active (prevents corrupted state)
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
            // When coming back from background to active
            if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
                // If we're somehow on a runner route, go back to index
                if (segments[0] === 'runner') {
                    router.replace('/');
                }
            }
            appState.current = nextAppState;
        });

        return () => subscription.remove();
    }, [segments, router]);

    return (
        <>
            <StatusBar style="light" />
            <Stack
                screenOptions={{
                    headerStyle: {
                        backgroundColor: colors.background,
                    },
                    headerTintColor: colors.primary,
                    headerTitleStyle: {
                        fontWeight: 'bold',
                    },
                    contentStyle: {
                        backgroundColor: colors.background,
                    },
                }}
            >
                <Stack.Screen
                    name="index"
                    options={{
                        headerShown: false,
                    }}
                />
                <Stack.Screen
                    name="runner/[id]"
                    options={{
                        headerShown: false,
                        animation: 'slide_from_right',
                    }}
                />
            </Stack>
            <ShareReceiver />
        </>
    );
}
