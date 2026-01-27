import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import * as Linking from 'expo-linking';
import { colors } from '../lib/theme';
import ShareReceiver from '../components/ShareReceiver';
import { ManaShop } from '../components/ManaShop';
import { useManaStore } from '../lib/manaStore';
import { Toast } from '../components/Toast';
import { useAppStore } from '../lib/store';
import * as Notifications from 'expo-notifications';

import * as SplashScreen from 'expo-splash-screen';

// Notification Handler (foreground)
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
    }),
});

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync().catch(() => { });

export default function RootLayout() {
    const segments = useSegments();

    useEffect(() => {
        console.log('RootLayout: Mounted');

        // Initialize Mana Store (Firebase Sync)
        useManaStore.getState().init();

        // Initialize App Store (Job Listeners)
        useAppStore.getState().initializeListeners();

        // Check for notification permissions
        (async () => {
            const { status } = await Notifications.getPermissionsAsync();
            if (status !== 'granted') {
                await Notifications.requestPermissionsAsync();
            }
        })();

        const subscription = Linking.addEventListener('url', ({ url }) => {
            if (url.startsWith('runapp://')) {
                console.log('_layout: Blocking runapp:// URL from expo-router:', url);
                return;
            }
        });

        // SAFETY: Force hide splash screen after 1s just in case
        setTimeout(async () => {
            console.log('RootLayout: Forcing Splash Screen Hide');
            await SplashScreen.hideAsync().catch((e: any) => console.log('Error hiding splash:', e));
        }, 1000);

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
            <Toast />
        </>
    );
}

