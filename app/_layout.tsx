import { Stack, useRouter, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { logScreenView } from '../lib/analytics';
import { Alert, AppState, DeviceEventEmitter, LogBox, Linking, Platform, View } from 'react-native';
import * as bgGen from '../lib/backgroundGenerator';
import * as ShareIntent from 'share-intent';
import { colors } from '../lib/theme';
import { t } from '../lib/i18n';
import ShareReceiver from '../components/ShareReceiver';
import { CostEstimateModal } from '../components/CostEstimateModal';
import { KeyMissingModal } from '../components/KeyMissingModal';
import { ModelUnavailableModal } from '../components/ModelUnavailableModal';
import { GenerationErrorModal } from '../components/GenerationErrorModal';
import { LargePayloadConfirmModal } from '../components/LargePayloadConfirmModal';
import { Toast } from '../components/Toast';
import { useAppStore } from '../lib/store';
import { useStoreSyncStore } from '../lib/storeSync';
import { useUserStore } from '../lib/userStore';
import { isGoogleUser, onAuthStateChanged } from '../lib/firebase';
import * as Notifications from 'expo-notifications';
import { preloadAllStorage } from '../lib/storageCache';
import { restoreScheduledAlarms } from '../lib/bridges/messageHandlers';

import * as SplashScreen from 'expo-splash-screen';
import { Toast as ToastComponent } from '../components/Toast';

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
            const kind = content?.data?.kind;
            const appId = extractAppIdFromNotification(content);

            if (!appId) {
                if (kind === 'create-success') {
                    try { router.replace('/'); } catch {}
                }
                return;
            }

            // Guard: do not open runner for unknown/deleted spell — skip for
            // create-success (the app was just inserted and store may not have hydrated yet).
            if (kind !== 'create-success') {
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

            if (kind === 'create-success') {
                try {
                    router.replace({ pathname: '/', params: { setupAppId: String(appId) } });
                } catch {
                    // If navigator isn't ready yet, initial route is listing anyway.
                }
                return;
            }

            // Edit-failure notifications land on the runner in edit mode; the
            // effect at app/runner/[id].tsx:567 detects lastFailedPrompt and
            // reopens the ChatDialog pre-filled with the failed instruction,
            // so the user can retry directly.
            if (kind === 'edit-failure') {
                try {
                    router.push({ pathname: '/runner/[id]', params: { id: String(appId), edit: 'true' } });
                } catch {}
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

        // Initialize App Store (Job Listeners)
        try {
            useAppStore.getState().initializeListeners();
        } catch (e) {
            console.error('RootLayout: AppStore listeners init failed:', e);
        }

        // Subscribe useUserStore to Firebase auth so isAnonymous/userEmail stay in sync.
        try {
            useUserStore.getState().init();
        } catch (e) {
            console.error('RootLayout: UserStore init failed:', e);
        }

        // Reconcile pending_jobs on cold start: any 'processing' row past
        // the platform staleness floor (30s iOS / 15min Android) that this
        // process is not actively driving gets resumed from the last
        // persisted stage or marked failed. After reconcile, reap any FGS
        // notification that lingered from a previous session (OEM ROMs
        // sometimes leave the ongoing "Appacadabra" notification pinned
        // past its `stopForeground` teardown).
        useAppStore.getState().reconcilePendingJobs()
            .then(() => bgGen.stopServiceIfIdle())
            .catch(err => {
                console.warn('RootLayout: reconcilePendingJobs failed:', err);
            });

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

        // Spell Store — foreground sync of learned spells and published spell status.
        // recoverAll covers reinstall and cross-device cases: we pull every learned spell
        // each foreground sync; tombstones + storeSpellId dedup keep this idempotent.
        // Throttled to 60s because AppState 'active' fires on every return-to-foreground,
        // and recoverAll generates a signed URL per learned spell on the backend.
        let lastStoreSyncAt = 0;
        const maybeSyncStoreState = () => {
            const now = Date.now();
            if (now - lastStoreSyncAt < 60_000) return;
            lastStoreSyncAt = now;
            if (isGoogleUser()) {
                useStoreSyncStore.getState().syncLearnedSpells({ recoverAll: true }).catch(() => {});
            }
            useStoreSyncStore.getState().syncPublishedSpellsStatus().catch(() => {});
        };
        setTimeout(maybeSyncStoreState, 2000);
        // Foreground reconciliation for the background-generation pipeline.
        // Throttled to avoid double-firing on rapid inactive→active flips
        // (control-center pull-down, share sheet dismiss).
        let lastReconcileAt = 0;
        const maybeReconcilePendingJobs = () => {
            const now = Date.now();
            if (now - lastReconcileAt < 5_000) return;
            lastReconcileAt = now;
            useAppStore.getState().reconcilePendingJobs()
                .then(() => bgGen.stopServiceIfIdle())
                .catch(err => {
                    console.warn('AppState: reconcilePendingJobs failed:', err);
                });
        };
        const appStateSub = AppState.addEventListener('change', (next) => {
            if (next === 'active') {
                maybeSyncStoreState();
                maybeReconcilePendingJobs();
            }
            if (next === 'background' || next === 'inactive') {
                // Android: reap any zombie FGS notification if no work is
                // active. No-op when a generation is genuinely running.
                if (Platform.OS === 'android') {
                    bgGen.stopServiceIfIdle().catch(() => {});
                }
                // iOS: when going to background with an in-flight generation,
                // ask iOS to opportunistically wake us via BGProcessingTask.
                // Safe even with no active jobs — the handler no-ops if
                // reconcile finds nothing to do.
                if (Platform.OS === 'ios' && bgGen.activeInProcessJobCount() > 0) {
                    bgGen.scheduleBackgroundProcessing().catch(() => {});
                }
            }
        });

        // BGProcessingTask fired by iOS — AppDelegate hops through
        // NotificationCenter → BackgroundGenerator.sendEvent → here.
        // Kick reconciliation the same way we would on foreground return.
        const bgReconcileSub = DeviceEventEmitter.addListener('BGReconcileRequest', () => {
            maybeReconcilePendingJobs();
        });

        // Global bg-generation event handlers. Replaces the per-call
        // subscribers that used to live in createApp/updateAppWithAI — those
        // closures died when the RN bridge was torn down, leaving
        // creatingApps/updatingAppIds stale. Global subscribers + the store's
        // syncInFlightFromDb keep the UI aligned with `pending_jobs`.
        const bgCompletedSub = bgGen.onCompleted((e) => {
            useAppStore.getState().handleBgGenCompleted(e).catch((err) => {
                console.warn('handleBgGenCompleted failed:', err);
            });
        });
        const bgFailedSub = bgGen.onFailed((e) => {
            useAppStore.getState().handleBgGenFailed(e).catch((err) => {
                console.warn('handleBgGenFailed failed:', err);
            });
        });
        const bgProgressSub = bgGen.onProgress((e) => {
            useAppStore.getState().handleBgGenProgress(e).catch(() => {});
        });

        // Sweeper: catches lost terminal events (bridge died between headless
        // finalize and UI subscriber). DB is authoritative, so re-deriving
        // creatingApps/updatingAppIds every 30s self-cleans in ≤30s.
        const sweeperInterval = setInterval(() => {
            const s = useAppStore.getState();
            if (s.creatingApps.length + s.updatingAppIds.length > 0) {
                s.syncInFlightFromDb().catch(() => {});
            }
        }, 30_000);

        // Deep link: appacadabra://store?spellId=xxx
        // Invariant: Firebase Auth may not be ready when getInitialURL() resolves on cold start.
        // We buffer the deep link until the first auth state callback fires.
        let pendingDeepLinkSpellId: string | null = null;
        let authReady = false;

        const processStoreDeepLink = (spellId: string) => {
            const store = useAppStore.getState();
            if (!isGoogleUser()) {
                store.setStatusMessage(t('learnSpellSignInRequired'));
                try { router.replace('/'); } catch {}
                return;
            }
            store.setStatusMessage(t('learnSpellDownloading'));
            useStoreSyncStore.getState().syncLearnedSpells({
                triggeredByDeepLink: true,
                forceSpellId: spellId,
            });
            useStoreSyncStore.getState().syncPublishedSpellsStatus().catch(() => {});
            try { router.replace('/'); } catch {}
        };

        const handleStoreDeepLink = (url: string | null) => {
            if (!url) return;
            const match = url.match(/[?&]spellId=([^&]+)/);
            if (!match) return;
            const isStoreLink = url.startsWith('appacadabra://store') || url.startsWith('https://appacadabra.ai/store');
            if (!isStoreLink) return;
            const spellId = decodeURIComponent(match[1]);
            if (!authReady) {
                pendingDeepLinkSpellId = spellId;
                return;
            }
            processStoreDeepLink(spellId);
        };
        const unsubscribeAuth = onAuthStateChanged(() => {
            authReady = true;
            if (pendingDeepLinkSpellId) {
                const id = pendingDeepLinkSpellId;
                pendingDeepLinkSpellId = null;
                processStoreDeepLink(id);
            }
        });
        Linking.getInitialURL().then(handleStoreDeepLink).catch(() => {});
        const linkingSub = Linking.addEventListener('url', ({ url }) => handleStoreDeepLink(url));

        return () => {
            notifSubscription.remove();
            appStateSub.remove();
            bgReconcileSub.remove();
            bgCompletedSub.remove();
            bgFailedSub.remove();
            bgProgressSub.remove();
            clearInterval(sweeperInterval);
            linkingSub.remove();
            try { unsubscribeAuth(); } catch {}
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
            <CostEstimateModal />
            <KeyMissingModal />
            <ModelUnavailableModal />
            <GenerationErrorModal />
            <LargePayloadConfirmModal />
            <ToastComponent />
        </View>
    );
}

