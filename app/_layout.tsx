import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { Stack, useRouter, useGlobalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../lib/theme';
import ShareReceiver from '../components/ShareReceiver';

export default function RootLayout() {
    const router = useRouter();
    const params = useGlobalSearchParams<{ edit?: string }>();
    const appState = useRef(AppState.currentState);

    // Reset to index when app becomes active (prevents corrupted state from Play button)
    // But ONLY if not in edit mode
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
            // When coming back from background to active
            if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
                // Only reset if NOT in edit mode
                if (params.edit !== 'true') {
                    router.replace('/');
                }
            }
            appState.current = nextAppState;
        });

        return () => subscription.remove();
    }, [params.edit, router]);

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

