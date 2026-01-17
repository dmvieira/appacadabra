import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import * as Linking from 'expo-linking';
import { colors } from '../lib/theme';
import ShareReceiver from '../components/ShareReceiver';
import { ManaShop } from '../components/ManaShop';

export default function RootLayout() {
    const segments = useSegments();

    // Block runapp:// URLs from being processed internally by expo-router
    // They should only be handled by the external RunnerActivity
    useEffect(() => {
        const subscription = Linking.addEventListener('url', ({ url }) => {
            if (url.startsWith('runapp://')) {
                console.log('_layout: Blocking runapp:// URL from expo-router:', url);
                // Do nothing - let Android handle it externally
                return;
            }
        });
        return () => subscription.remove();
    }, []);

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
            <ManaShop />
        </>
    );
}

