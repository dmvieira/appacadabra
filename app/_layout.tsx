import { Stack, useRouter, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { logScreenView } from '../lib/analytics';
import { Alert, AppState, LogBox, Linking, Platform, View } from 'react-native';
import * as ShareIntent from 'share-intent';
import { colors } from '../lib/theme';
import { t } from '../lib/i18n';
import ShareReceiver from '../components/ShareReceiver';
import { ManaShop } from '../components/ManaShop';
import { ManaConfirmModal } from '../components/ManaConfirmModal';
import { LargePayloadConfirmModal } from '../components/LargePayloadConfirmModal';
import { useManaStore } from '../lib/manaStore';
import { Toast } from '../components/Toast';
import { useAppStore } from '../lib/store';
import { useStoreSyncStore } from '../lib/storeSync';
import { isGoogleUser } from '../lib/firebase';
import * as Notifications from 'expo-notifications';
import { preloadAllStorage } from '../lib/storageCache';
import { restoreScheduledAlarms } from '../lib/bridges/messageHandlers';

import * as SplashScreen from 'expo-splash-screen';
import { Toast as ToastComponent } from '../components/Toast';
import MobileAds from 'react-native-google-mobile-ads';

// Suppress LogBox banners globally in dev builds — the banner intercepts touch events
// and blocks E2E test flows. Warnings remain accessible via Metro / console output.
if (__DEV__) LogBox.ignoreAllLogs();

let lastHandledNotificationTapId: string | null = null;

// Configure Expo Router to only handle specific schemes for navigation
export const unstable_settings = {
    initialRouteName: 'index',
};

if (__DEV__) {
    LogBox.ignoreLogs([
        "The action 'REPLACE' with payload",
        'Looks like you have configured linking in multiple places.',
        'Unable to activate keep awake',
    ]);
}

// Notification Handler (foreground)
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
    }),
});

// Keep the splash screen visible while we fetch resources
try {
    SplashScreen.preventAutoHideAsync().catch((e: any) => {
        console.warn('SplashScreen.preventAutoHideAsync skipped:', e?.message || e);
    });
} catch (e: any) {
    console.warn('SplashScreen.preventAutoHideAsync threw synchronously:', e?.message || e);
}

export default function RootLayout() {
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        logScreenView(pathname);
    }, [pathname]);

    useEffect(() => {
        console.log('RootLayout: Mounted');

        const extractAppIdFromNotification = (content: any): string | number | null => {
            let appId: string | number | null =
                content?.data?.appId ??
                content?.badge ??
                null;

            if (!appId && content?.channelId) {
                const match = String(content.channelId).match(/^spell-(\d+)$/);
                if (match) appId = match[1];
            }

            return appId;
        };

        const openSpellFromNotification = (response: Notifications.NotificationResponse | null) => {
            if (!response) return;

            const tapId = response.notification.request.identifier;
            if (tapId && tapId === lastHandledNotificationTapId) {
                return;
            }

            const content = response.notification.request.content as any;
            const notificationType = content?.data?.notificationType;
            const appId = extractAppIdFromNotification(content);

            if (!appId) {
                if (notificationType === 'app_created') {
                    try { router.replace('/'); } catch {}
                }
                return;
            }

            // Guard: do not open runner for unknown/deleted spell — skip for app_created (app may not exist yet)
            if (notificationType !== 'app_created') {
                const knownApps = useAppStore.getState().apps;
                if (!knownApps.some(a => String(a.id) === String(appId))) {
                    console.warn('[Layout] Notification for unknown/deleted spell:', appId);
                    Notifications.dismissNotificationAsync(
                        response.notification.request.identifier
                    ).catch(() => {});
                    return;
                }
            }

            lastHandledNotificationTapId = tapId || String(appId);

            if (notificationType === 'app_created') {
                const status = content?.data?.status;
                try {
                    if (status === 'failed') {
                        // App was never created — don't pass a nonexistent setupAppId
                        router.replace('/');
                    } else {
                        router.replace({ pathname: '/', params: { setupAppId: String(appId) } });
                    }
                } catch {
                    // If navigator isn't ready yet, initial route is listing anyway.
                }
                return;
            }

            if (Platform.OS === 'android') {
                ShareIntent.startRunnerActivity(Number(appId)).catch(() => {});
            } else {
                router.push({ pathname: '/runner/[id]', params: { id: String(appId) } });
            }
        };

        // Preload all app localStorage for faster runner startup
        preloadAllStorage().catch(err => {
            console.error('Failed to preload storage:', err);
        });

        // Restore AlarmManager entries lost during process restart
        restoreScheduledAlarms().catch(err => {
            console.warn('Failed to restore scheduled alarms:', err);
        });

        // Initialize Mobile Ads SDK (required for PAID event delivery)
        MobileAds().initialize().catch((e: any) => {
            console.warn('MobileAds init failed:', e?.message || e);
        });

        // Initialize Mana Store (Firebase Sync)
        try {
            useManaStore.getState().init();
        } catch (e) {
            console.error('RootLayout: ManaStore init failed:', e);
        }

        // Initialize App Store (Job Listeners)
        try {
            useAppStore.getState().initializeListeners();
        } catch (e) {
            console.error('RootLayout: AppStore listeners init failed:', e);
        }

        // Check for notification permissions
        (async () => {
            const { status } = await Notifications.getPermissionsAsync();
            if (status !== 'granted') {
                await Notifications.requestPermissionsAsync();
            }
        })();

        // Open the spell runner when the user taps a scheduled notification
        const notifSubscription = Notifications.addNotificationResponseReceivedListener(response => {
            openSpellFromNotification(response);
        });

        // Cold start: app opened by tapping a notification while fully closed
        Notifications.getLastNotificationResponseAsync()
            .then((response) => {
                if (!response) return;
                // Apps may not be loaded yet on cold start — wait until isLoading becomes false
                if (!useAppStore.getState().isLoading) {
                    openSpellFromNotification(response);
                } else {
                    const unsubscribe = useAppStore.subscribe((state) => {
                        if (!state.isLoading) {
                            unsubscribe();
                            openSpellFromNotification(response);
                        }
                    });
                }
            })
            .catch(() => {});

        // SAFETY: Force hide splash screen after 1s just in case
        setTimeout(async () => {
            console.log('RootLayout: Forcing Splash Screen Hide');
            await SplashScreen.hideAsync().catch((e: any) => console.log('Error hiding splash:', e));
        }, 1000);

        // Spell Store — foreground sync of learned spells and published spell status
        const maybeSyncStoreState = () => {
            if (isGoogleUser()) {
                useStoreSyncStore.getState().syncLearnedSpells().catch(() => {});
            }
            useStoreSyncStore.getState().syncPublishedSpellsStatus().catch(() => {});
        };
        setTimeout(maybeSyncStoreState, 2000);
        const appStateSub = AppState.addEventListener('change', (next) => {
            if (next === 'active') maybeSyncStoreState();
        });

        // Deep link: appacadabra://store?spellId=xxx
        const handleStoreDeepLink = (url: string | null) => {
            if (!url) return;
            const match = url.match(/[?&]spellId=([^&]+)/);
            if (!match) return;
            const isStoreLink = url.startsWith('appacadabra://store') || url.startsWith('https://appacadabra.ai/store');
            if (!isStoreLink) return;
            maybeSyncLearnedSpells();
            try { router.replace('/'); } catch {}
        };
        Linking.getInitialURL().then(handleStoreDeepLink).catch(() => {});
        const linkingSub = Linking.addEventListener('url', ({ url }) => handleStoreDeepLink(url));

        return () => {
            notifSubscription.remove();
            appStateSub.remove();
            linkingSub.remove();
        };
    }, []);

    return (
        <View style={{ flex: 1 }}>
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
                    name="spell/[id]"
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
            <ManaConfirmModal />
            <LargePayloadConfirmModal />
            <ToastComponent />
        </View>
    );
}

