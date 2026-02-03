import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Alert } from 'react-native';
import * as Linking from 'expo-linking';
import { colors } from '../lib/theme';
import { t } from '../lib/i18n';
import ShareReceiver from '../components/ShareReceiver';
import { ManaShop } from '../components/ManaShop';
import { useManaStore } from '../lib/manaStore';
import { Toast } from '../components/Toast';
import { useAppStore } from '../lib/store';
import * as Notifications from 'expo-notifications';

import * as SplashScreen from 'expo-splash-screen';
import { Toast as ToastComponent } from '../components/Toast';

// Configure Expo Router to only handle specific schemes for navigation
export const unstable_settings = {
    initialRouteName: 'index',
};

export const linking = {
    prefixes: ['appacadabra://', 'runapp://'],
    config: {
        screens: {
            index: '',
            'runner/[id]': 'runner/:id',
        },
    },
    async getInitialURL() {
        const url = await Linking.getInitialURL();
        if (url && (url.startsWith('content://') || url.startsWith('file://'))) {
            console.log('Router: Blocking initial file URL navigation');
            return null; // Stop Router from handling this
        }
        return url;
    },
    // @ts-ignore
    subscribe(listener) {
        // @ts-ignore
        const onReceiveURL = ({ url }) => {
            if (url.startsWith('content://') || url.startsWith('file://')) {
                console.log('Router: Blocking file deep link navigation');
                // Do not call listener(url) for files
            } else {
                listener(url);
            }
        };
        const subscription = Linking.addEventListener('url', onReceiveURL);
        return () => subscription.remove();
    },
};

// Notification Handler (foreground)
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
    }),
});

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync().catch(() => { });

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync().catch(() => { });

// Track processed URLs to prevent loops (module-level to survive remounts)
let lastProcessedDeepLink: string | null = null;
let lastDeepLinkTimestamp: number = 0;
let processedInitialUrl: boolean = false;

export default function RootLayout() {
    const router = useRouter();
    const segments = useSegments();
    // Start with a valid URL or null. If we let Expo Router see 'content://', it tries to navigate.
    // We want the Router to IGNORE content:// URLs, but we still want to read them.
    // Since we are blocking the Router from seeing these URLs via the 'linking' config below,
    // 'Linking.useURL()' might also be affected or return null depending on context.
    // To be safe, we use raw Linking listeners here to ensure we catch the Intent.
    // const deepLinkUrl = Linking.useURL(); 

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

        // Handle Deep Links (File Imports)
        const handleDeepLink = (rawUrl: string | null) => {
            if (!rawUrl) return;

            // Normalize URL to prevent encoded/decoded mismatches bypassing dedupe
            const url = decodeURIComponent(rawUrl);
            console.log('Deep Link detected (Normalized):', url);

            if (url.startsWith('runapp://')) {
                console.log('_layout: Blocking runapp:// URL from expo-router:', url);
                return;
            }

            // Handle File Imports (content:// or file://)
            if (url.startsWith('content://') || url.startsWith('file://')) {
                const now = Date.now();

                // 1. Startup Echo Protection
                if (processedInitialUrl && (now - lastDeepLinkTimestamp < 2500)) {
                    console.log('Skipping Startup Echo/Duplicate:', url);
                    return;
                }

                // 2. Duplicate Check (Debounce)
                // If it's the exact same URL as the last one we processed recently, ignore it.
                if (url === lastProcessedDeepLink && (now - lastDeepLinkTimestamp < 3000)) {
                    console.log('Skipping duplicate Deep Link (Debounced):', url);
                    return;
                }

                // Also prevent any rapid-fire different files (1s cooldown)
                if (now - lastDeepLinkTimestamp < 1000) {
                    console.log('Skipping Deep Link (Rapid Fire):', url);
                    return;
                }

                // 3. Navigate to Import Screen
                lastProcessedDeepLink = url;
                lastDeepLinkTimestamp = now;

                console.log('Deep Link -> Routing to Import Screen:', url);

                // Use router.push to open the import modal with the URI
                // We must use 'setImmediate' or similar to ensure router is ready if cold boot?
                // But normally inside useEffect it's fine.
                // We use encoded rawUrl to preserve characters.

                // Note: We need to ensure we are not already on the import screen with this URL?
                // But router.push will just add it.
                // We can use params.
                router.push({
                    pathname: '/import_spell',
                    params: { uri: rawUrl }
                });
            }
        };

        // Check initial URL (Cold Boot)
        Linking.getInitialURL().then(url => {
            if (url) {
                console.log('Initial URL detected:', url);
                processedInitialUrl = true; // Mark startup as handled
                handleDeepLink(url);
            }
        });

        // Listen for updates (Warm Boot)
        const subscription = Linking.addEventListener('url', (e) => handleDeepLink(e.url));

        // SAFETY: Force hide splash screen after 1s just in case
        setTimeout(async () => {
            console.log('RootLayout: Forcing Splash Screen Hide');
            await SplashScreen.hideAsync().catch((e: any) => console.log('Error hiding splash:', e));
        }, 1000);

        return () => subscription.remove();
    }, []);

    // Safety timeout for splash is handled below
    useEffect(() => {
        setTimeout(async () => {
            console.log('RootLayout: Forcing Splash Screen Hide');
            await SplashScreen.hideAsync().catch((e: any) => console.log('Error hiding splash:', e));
        }, 1000);
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
                    name="import_spell"
                    options={{
                        presentation: 'transparentModal',
                        headerShown: false,
                        animation: 'fade',
                    }}
                />
                <Stack.Screen
                    name="runner/[id]"
                    options={{
                        headerShown: false,
                        animation: 'slide_from_right',
                    }}
                />
                <Stack.Screen
                    name="+not-found"
                    options={{
                        headerShown: false,
                        // Revert to default presentation (no modal) since we are blocking navigation now
                    }}
                />
            </Stack>
            <ShareReceiver />
            <ManaShop />
            <ToastComponent />
        </>
    );
}

