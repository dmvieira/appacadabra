import React, { useEffect, useState, useCallback } from 'react';
import {
    View,
    Text,
    TextInput,
    FlatList,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    Modal,
    Pressable,
    Platform,
    ScrollView,
    KeyboardAvoidingView,
    Image,
    Linking as RNLinking,
    Alert,
    RefreshControl,
    useWindowDimensions,
} from 'react-native';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as ShareIntent from 'share-intent';
import * as LocalAuthentication from 'expo-local-authentication';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';
import { useAppStore } from '../lib/store';
import { AppCard } from '../components/AppCard';
import { EmptyState } from '../components/EmptyState';
import { EmptySearchState } from '../components/EmptySearchState';
import { ChatDialog, ConfirmDialog } from '../components/Dialogs';
import { Onboarding } from '../components/Onboarding';
import { colors, spacing, borderRadius } from '../lib/theme';
import SignOutModal from '../components/SignOutModal';

import { GeneratedApp } from '../lib/database/types';
import { createShortcut, updateDynamicShortcuts } from '../lib/shortcuts';
import { t, getCurrentLanguage } from '../lib/i18n';
import { ManaDisplay } from '../components/ManaDisplay';
import * as db from '../lib/database/db';
import { exportSingleApp } from '../lib/backup';
import * as firebase from '../lib/firebase';
import { ScheduledNotifications } from '../components/ScheduledNotifications';
import { useManaStore } from '../lib/manaStore';
import SpellSetup from '../components/SpellSetup';
import { logIconGenerated } from '../lib/analytics';
import { useBackupStore } from '../lib/backupStore';
import BackupSyncModal from '../components/BackupSyncModal';
import { autoBackupAfterChange, tryRestoreOnLogin, checkLocalBackupExists, markBackupDirty, startPeriodicBackup, stopPeriodicBackup } from '../lib/backupSync';

const ONBOARDING_KEY = 'appacadabra_onboarding_seen';

export default function HomeScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const { setupAppId } = useLocalSearchParams<{ setupAppId?: string }>();
    const { balance, openShop, isAnonymous } = useManaStore();
    const {
        apps,
        isLoading,
        isGenerating,
        isImporting,
        creatingApps,
        error,
        statusMessage,
        loadApps,
        openApp,
        updateAppDescription,
        updateAppIcon,
        incrementAppManaCost,
        exportBackup,
        importBackup,
        importOnboardingSpell,
        importProject,
        clearError,
        clearStatusMessage,
        setStatusMessage,
        initializeListeners,
        lastCreatedAppId,
        clearLastCreatedApp,
        reorderApp,
        wipeAllData,
        createApp,
        deleteApp,
        renameApp,
        updatingAppIds,
        pendingImportUrl,
        setPendingImportUrl,
        lastFailedPrompt,
        clearLastFailedPrompt,
        clearAppStorage,
    } = useAppStore();

    const [showSignOutModal, setShowSignOutModal] = useState(false);
    const [signOutBanner, setSignOutBanner] = useState<'keep' | 'clear' | null>(null);

    // Auto-dismiss sign-out banner after 1 minute
    useEffect(() => {
        if (signOutBanner) {
            const timer = setTimeout(() => {
                setSignOutBanner(null);
            }, 60000); // 1 minute
            return () => clearTimeout(timer);
        }
    }, [signOutBanner]);

    // Dialog states
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [createDialogInitialText, setCreateDialogInitialText] = useState<string | undefined>(undefined);
    const [deleteTarget, setDeleteTarget] = useState<GeneratedApp | null>(null);
    const [showMenu, setShowMenu] = useState(false);
    const [isPicking, setIsPicking] = useState(false);
    const [showLegal, setShowLegal] = useState(false);
    const [legalTab, setLegalTab] = useState<'privacy' | 'terms'>('privacy');
    const [showOnboarding, setShowOnboarding] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [scheduleTarget, setScheduleTarget] = useState<GeneratedApp | null>(null);
    const [isGeneratingIcon, setIsGeneratingIcon] = useState(false);
    const [isAtTop, setIsAtTop] = useState(true); // Track scroll position for smarter refresh control
    const [searchQuery, setSearchQuery] = useState('');
    const [setupTarget, setSetupTarget] = useState<GeneratedApp | null>(null);
    const [setupName, setSetupName] = useState('');
    const [setupDescription, setSetupDescription] = useState('');
    const [setupMode, setSetupMode] = useState<'create' | 'edit'>('create');
    const [firstRunSetupTarget, setFirstRunSetupTarget] = useState<GeneratedApp | null>(null);
    const [notifCounts, setNotifCounts] = useState<Record<number, number>>({});
    const [coachStep, setCoachStep] = useState(0); // 0=off, 1=dots menu hint, 2=edit hint
    const [activeCardId, setActiveCardId] = useState<number | null>(null);
    const [showSyncModal, setShowSyncModal] = useState(false);
    const [syncModalMode, setSyncModalMode] = useState<'choose' | 'reconnect'>('choose');
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [suggestions, setSuggestions] = useState<Array<{ title: string; description: string }>>([]);
    const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);

    // Backup store
    const { backupMode, localFolderUri, restoredCount, clearRestoredCount, hydrated: backupHydrated, hydrate: hydrateBackup, isRestoring, lastBackupAt } = useBackupStore();

    // Initialize background listeners for async jobs
    useEffect(() => {
        initializeListeners();
        hydrateBackup();
        startPeriodicBackup();
        return () => stopPeriodicBackup();
    }, []);

    // Show setup modal when a new spell is created
    useEffect(() => {
        if (lastCreatedAppId) {
            const created = apps.find(a => a.id === lastCreatedAppId);
            if (created) {
                setSetupTarget(created);
                setSetupName(created.name);
                setSetupDescription(created.shortDescription || '');
                setSetupMode('create');
                clearLastCreatedApp();
            }
        }
    }, [lastCreatedAppId, apps]);

    // Restore failed CREATE prompt — re-open dialog with user's original text
    useEffect(() => {
        if (lastFailedPrompt?.type === 'create') {
            setCreateDialogInitialText(lastFailedPrompt.text);
            setShowCreateDialog(true);
            clearLastFailedPrompt();
        }
    }, [lastFailedPrompt]);

    // Notification tap: open setup modal for newly created spell
    useEffect(() => {
        if (setupAppId && apps.length > 0) {
            const app = apps.find(a => String(a.id) === setupAppId);
            if (app && !setupTarget) {
                // Only show setup if it hasn't been done yet
                AsyncStorage.getItem(`spell_setup_done_${app.id}`).then(done => {
                    if (!done) {
                        setSetupTarget(app);
                        setSetupName(app.name);
                        setSetupDescription(app.shortDescription || '');
                        setSetupMode('create');
                    }
                });
                // Clear the param so it doesn't re-trigger
                router.setParams({ setupAppId: '' });
            }
        }
    }, [setupAppId, apps]);

    // Backup: check if logged-in user needs backup setup
    useEffect(() => {
        if (!backupHydrated) return;
        if (!isAnonymous && (backupMode === null || backupMode === undefined)) {
            // User is logged in with Google but has no backup preference — show sync modal
            setSyncModalMode('choose');
            setShowSyncModal(true);
        }
    }, [backupHydrated, isAnonymous, backupMode]);

    // Backup: restore on Google login
    useEffect(() => {
        let active = true;
        if (!backupHydrated || isAnonymous) return;

        if (backupMode === 'google_drive') {
            // Delay to ensure GoogleSignin tokens are ready after Firebase Auth init.
            // zustand-persist restores isAnonymous=false from AsyncStorage before
            // Firebase Auth actually initializes, so tokens aren't available yet.
            const timer = setTimeout(() => {
                if (!active) return;
                tryRestoreOnLogin().catch(e => console.warn('[BackupSync] Auto-restore failed:', e));
            }, 1500);
            return () => { active = false; clearTimeout(timer); };
        } else if (backupMode === 'local_folder') {
            console.log('[Index] Local backup check, URI:', localFolderUri);
            if (localFolderUri) {
                checkLocalBackupExists(localFolderUri).then(exists => {
                    if (!active) return;
                    console.log('[Index] Local backup exists:', exists);
                    if (exists) {
                        tryRestoreOnLogin().catch(e => console.warn('[BackupSync] Local restore failed:', e));
                    } else {
                        setSyncModalMode('reconnect');
                        setShowSyncModal(true);
                    }
                });
            } else {
                setSyncModalMode('reconnect');
                setShowSyncModal(true);
            }
        }
        return () => { active = false; };
        // localFolderUri omitido intencionalmente: incluí-lo causava o modal de reconnect
        // aparecer duas vezes ao trocar local→Drive (setLocalFolderUri(null) disparava o
        // efeito antes de backupMode atualizar para 'google_drive').
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [backupHydrated, isAnonymous, backupMode]);

    // Backup: auto-dismiss restore banner after 5s
    useEffect(() => {
        if (restoredCount > 0) {
            const timer = setTimeout(() => clearRestoredCount(), 5000);
            return () => clearTimeout(timer);
        }
    }, [restoredCount]);

    // Keep setup modal target in sync with apps (e.g. after icon change)
    useEffect(() => {
        if (setupTarget) {
            const updated = apps.find(a => a.id === setupTarget.id);
            if (updated) setSetupTarget(updated);
        }
    }, [apps]);

    // Check if onboarding should be shown
    useEffect(() => {
        const checkOnboarding = async () => {
            try {
                const seen = await AsyncStorage.getItem(ONBOARDING_KEY);
                if (!seen) {
                    setShowOnboarding(true);
                }
            } catch (e) {
                console.error('Error checking onboarding:', e);
            }
        };
        checkOnboarding();
    }, []);

    const onboardingChipKeys = [
        'obChipShoppingFull',
        'obChipDiaryFull',
        'obChipWorkoutFull',
        'obChipExpensesFull',
    ];

    const handleOnboardingComplete = async (selectedChip: number | null) => {
        try {
            await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
        } catch (e) {
            console.error('Error saving onboarding state:', e);
        }
        setShowOnboarding(false);

        // If user selected a chip, import the free template spell directly
        if (selectedChip !== null && selectedChip >= 0 && selectedChip < onboardingChipKeys.length) {
            const newId = await importOnboardingSpell(selectedChip);
            if (newId) {
                maybeStartCoach(newId);
            }
        }
    };

    // Track last alert interaction to prevent ghost clicks or stacking
    const lastAlertInteraction = React.useRef(0);

    // (Old effect removed - now handled by /import_spell route)


    const refreshNotifCounts = useCallback(() => {
        Notifications.getAllScheduledNotificationsAsync().then(all => {
            const counts: Record<number, number> = {};
            for (const n of all) {
                const c = n.content as any;
                let appId: number | undefined;

                // 1. Check data.appId (iOS / older Android)
                if (c.data?.appId) {
                    appId = Number(c.data.appId);
                }

                // 2. Check data.payload (stringified workaround)
                if (!appId && c.data?.payload) {
                    try {
                        const p = typeof c.data.payload === 'string' ? JSON.parse(c.data.payload) : c.data.payload;
                        if (p.appId) appId = Number(p.appId);
                    } catch { }
                }

                // 3. Check channelId "spell-{id}" (Android primary)
                if (!appId && typeof c.channelId === 'string' && c.channelId.startsWith('spell-')) {
                    const parsed = Number(c.channelId.replace('spell-', ''));
                    if (!isNaN(parsed) && parsed > 0) appId = parsed;
                }

                // 4. Check badge (Android fallback)
                if (!appId && typeof c.badge === 'number' && c.badge > 0) {
                    appId = c.badge;
                }

                if (appId) counts[appId] = (counts[appId] || 0) + 1;
            }
            setNotifCounts(counts);
        }).catch(() => { });
    }, []);

    useFocusEffect(
        useCallback(() => {
            loadApps();
            refreshNotifCounts();

            // Poll notification counts while screen is focused (catches notifs scheduled by running spells)
            const interval = setInterval(refreshNotifCounts, 5000);
            return () => clearInterval(interval);
        }, [])
    );

    // Also refresh notification counts whenever apps change (e.g. after returning from a spell)
    useEffect(() => {
        if (apps.length > 0) refreshNotifCounts();
    }, [apps]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await loadApps();
        refreshNotifCounts();
        setRefreshing(false);
    }, []);

    const onScroll = useCallback((e: any) => {
        const offset = e.nativeEvent.contentOffset.y;
        // Only enable refresh if we are at the very top (with small tolerance)
        const newIsAtTop = offset <= 5;
        if (newIsAtTop !== isAtTop) {
            setIsAtTop(newIsAtTop);
        }
    }, [isAtTop]);

    useEffect(() => {
        if (apps.length > 0) {
            updateDynamicShortcuts(apps);
        }
    }, [apps]);


    // Clear status message after 3 seconds
    useEffect(() => {
        if (statusMessage) {
            const timer = setTimeout(() => clearStatusMessage(), 3000);
            return () => clearTimeout(timer);
        }
    }, [statusMessage]);

    // Error handling is managed globally by Toast in _layout.tsx
    // (Old alert effect removed to prevent conflict)

    // Compute showSearch early so we can use it in the hook above the early return
    const searchThreshold = width >= 768 ? 8 : 4;
    const showSearch = apps.length > searchThreshold;

    // Clear search query when search bar disappears
    useEffect(() => {
        if (!showSearch && searchQuery) {
            setSearchQuery('');
        }
    }, [showSearch]);

    // Fetch AI suggestions when search has no matches
    useEffect(() => {
        const trimmed = searchQuery.trim();
        if (!trimmed || apps.length === 0) {
            setSuggestions([]);
            return;
        }
        const hasMatch = apps.some(a =>
            a.name.toLowerCase().includes(trimmed.toLowerCase()) ||
            (a.shortDescription || '').toLowerCase().includes(trimmed.toLowerCase())
        );
        if (hasMatch) { setSuggestions([]); return; }

        setIsLoadingSuggestions(true);
        const timer = setTimeout(async () => {
            try {
                const result = await firebase.suggestSpells(trimmed);
                setSuggestions(result);
            } catch {
                setSuggestions([]);
            } finally {
                setIsLoadingSuggestions(false);
            }
        }, 600);
        return () => { clearTimeout(timer); setIsLoadingSuggestions(false); };
    }, [searchQuery, apps]);

    const handleCreateApp = async (description: string) => {
        // Double check mana before submitting (though button should be intercepted)
        if (balance <= 0) {
            Alert.alert(
                t('manaDepletedTitle'),
                t('manaDepletedMessage'),
                [
                    { text: t('buyMana'), onPress: openShop },
                    { text: t('cancel'), style: 'cancel' }
                ]
            );
            return false;
        }
        // Async: createApp returns true if job submitted
        const success = await createApp(description);
        if (success) {
            setShowCreateDialog(false);
            setCreateDialogInitialText(undefined);
            // We do NOT open the app immediately.
            return true;
        }
        return false;
    };

    // Biometric authentication helper
    const authenticateBiometric = async (): Promise<boolean> => {
        try {
            const hasHardware = await LocalAuthentication.hasHardwareAsync();
            const isEnrolled = await LocalAuthentication.isEnrolledAsync();

            if (!hasHardware || !isEnrolled) {
                Alert.alert(t('error'), t('biometricsNotAvailable') || 'Biometrics not available');
                return false;
            }

            const result = await LocalAuthentication.authenticateAsync({
                promptMessage: t('biometricRequired'),
                fallbackLabel: t('usePassword'),
                disableDeviceFallback: false,
            });

            if (!result.success) {
                setStatusMessage(t('biometricUnlockFailed'));
                return false;
            }

            return true;
        } catch (e) {
            console.error('Biometric auth error:', e);
            return false;
        }
    };

    // Toggle biometric lock for an app
    const handleToggleBiometric = async (app: GeneratedApp) => {
        // If already locked, require auth to unlock
        if (app.requiresBiometric) {
            const authResult = await authenticateBiometric();
            if (!authResult) return;
        }

        // Toggle the setting
        const newValue = !app.requiresBiometric;
        await db.updateBiometricLock(app.id, newValue);
        await loadApps(); // Refresh UI
        setStatusMessage(newValue ? t('enableBiometric') : t('disableBiometric'));
        markBackupDirty();
    };

    const handleRunApp = async (app: GeneratedApp) => {
        // Check biometric lock
        if (app.requiresBiometric) {
            const authResult = await authenticateBiometric();
            if (!authResult) return;
        }

        // First-run setup: show config screen before opening for the first time
        const setupKey = `spell_setup_done_${app.id}`;
        const setupDone = await AsyncStorage.getItem(setupKey);
        if (!setupDone) {
            setFirstRunSetupTarget(app);
            return;
        }

        // On iOS, we just navigate to the runner screen within the same window
        if (Platform.OS === 'ios') {
            router.push({ pathname: '/runner/[id]', params: { id: app.id } });
            return;
        }

        // Use openRunnerWindow which creates separate windows per app
        // This uses FLAG_ACTIVITY_NEW_DOCUMENT for document-based tasks
        console.log('handleRunApp: Opening app window via native', app.id);
        const success = await ShareIntent.openRunnerWindow(app.id);
        if (!success) {
            console.error('Native openRunnerWindow failed');
            alert(t('errorOpeningWindow'));
        }
    };

    const handleFirstRunSetupComplete = async (options: { biometric: boolean; homeScreen: boolean }) => {
        if (!firstRunSetupTarget) return;
        const app = firstRunSetupTarget;
        setFirstRunSetupTarget(null);

        // Apply biometric setting
        if (options.biometric) {
            await db.updateBiometricLock(app.id, true);
            await loadApps();
        }

        // Create home screen shortcut
        if (options.homeScreen && Platform.OS === 'android') {
            await createShortcut(app.id, app.name, app.iconPath || null);
        }

        // Mark setup as done
        await AsyncStorage.setItem(`spell_setup_done_${app.id}`, '1');

        // Trigger coach marks so they appear when user returns from the runner
        maybeStartCoach(app.id);

        // Now actually open the spell
        if (Platform.OS === 'ios') {
            router.push({ pathname: '/runner/[id]', params: { id: app.id } });
        } else {
            const success = await ShareIntent.openRunnerWindow(app.id);
            if (!success) {
                console.error('Native openRunnerWindow failed');
                alert(t('errorOpeningWindow'));
            }
        }
    };

    const handleEditApp = async (app: GeneratedApp) => {
        // Check biometric lock
        if (app.requiresBiometric) {
            const authResult = await authenticateBiometric();
            if (!authResult) return;
        }

        openApp(app.id, 'edit');
        router.push({ pathname: '/runner/[id]', params: { id: app.id, edit: 'true' } });
    };

    const handleDeleteConfirm = async () => {
        if (deleteTarget) {
            await deleteApp(deleteTarget.id);
            setDeleteTarget(null);
            autoBackupAfterChange();
        }
    };

    // --- Setup modal handlers ---
    const handleSetupSave = async () => {
        if (!setupTarget) return;
        const targetId = setupTarget.id;
        if (setupName.trim() && setupName.trim() !== setupTarget.name) {
            await renameApp(setupTarget.id, setupName.trim());
        }
        if (setupDescription !== (setupTarget.shortDescription || '')) {
            await updateAppDescription(setupTarget.id, setupDescription);
        }
        // Don't mark spell_setup_done here — let SpellSetup (biometric/homescreen) handle it
        setSetupTarget(null);
        // Show coach marks if this was the first spell
        maybeStartCoach(targetId);
        markBackupDirty();
    };

    const handleSetupSkip = async () => {
        const targetId = setupTarget?.id;
        setSetupTarget(null);
        if (targetId) {
            // Don't mark spell_setup_done here — let SpellSetup (biometric/homescreen) handle it
            maybeStartCoach(targetId);
        }
    };

    const maybeStartCoach = async (appId: number) => {
        try {
            const seen = await AsyncStorage.getItem('appacadabra_coach_done');
            if (!seen) {
                // Small delay so the card is visible before showing coach
                setTimeout(() => setCoachStep(1), 500);
            }
        } catch (e) {
            // ignore
        }
    };

    const handleCoachDismiss = async () => {
        if (coachStep === 1) {
            setCoachStep(2);
        } else if (coachStep === 2) {
            setCoachStep(3);
        } else {
            setCoachStep(0);
            try {
                await AsyncStorage.setItem('appacadabra_coach_done', '1');
            } catch (e) {
                // ignore
            }
        }
    };

    const handleSpellSetupSkip = async () => {
        if (!firstRunSetupTarget) return;
        const app = firstRunSetupTarget;
        setFirstRunSetupTarget(null);
        await AsyncStorage.setItem(`spell_setup_done_${app.id}`, '1');
        maybeStartCoach(app.id);
    };

    const handleSetupIconFromGallery = async () => {
        if (!setupTarget || isPicking) return;
        try {
            setIsPicking(true);
            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsEditing: true,
                aspect: [1, 1],
                quality: 0.8,
            });
            if (!result.canceled && result.assets[0]) {
                await updateAppIcon(setupTarget.id, result.assets[0].uri);
                markBackupDirty();
            }
        } catch (e) {
            console.error('Error selecting setup icon from gallery:', e);
        } finally {
            setIsPicking(false);
        }
    };

    const handleSetupSearchGoogle = async () => {
        if (!setupTarget) return;
        const query = encodeURIComponent(`${setupTarget.name} app icon`);
        await Linking.openURL(`https://www.google.com/search?tbm=isch&q=${query}`);
    };

    const handleSetupGenerateIconWithAI = async () => {
        if (!setupTarget || isGeneratingIcon) return;
        try {
            setIsGeneratingIcon(true);
            let creationPrompt = setupDescription || setupTarget.shortDescription || '';
            if (!creationPrompt) {
                const versions = await db.getVersionsForApp(setupTarget.id);
                const first = versions.length > 0 ? versions[versions.length - 1] : null;
                creationPrompt = first?.instruction || '';
            }
            const prompt = `App icon for "${setupTarget.name}". ${creationPrompt ? `The app does: ${creationPrompt}.` : ''} . REALLY simple, easy to understand, colorful, minimalist, rounded square, borderless icon suitable for a mobile app. No text. Recognizable symbol because the icon is small.`;
            const result = await firebase.generateSpellImageGen(prompt);
            const base64Image = result.text;
            const creditsUsed = result.creditsUsed || 0;
            if (base64Image) {
                const iconDir = `${FileSystem.documentDirectory}icons/`;
                const dirInfo = await FileSystem.getInfoAsync(iconDir);
                if (!dirInfo.exists) {
                    await FileSystem.makeDirectoryAsync(iconDir, { intermediates: true });
                }
                const iconPath = `${iconDir}ai_icon_${setupTarget.id}_${Date.now()}.png`;
                await FileSystem.writeAsStringAsync(iconPath, base64Image, {
                    encoding: FileSystem.EncodingType.Base64,
                });
                await updateAppIcon(setupTarget.id, iconPath);
                if (creditsUsed > 0) {
                    await incrementAppManaCost(setupTarget.id, creditsUsed);
                    // Force mana balance refresh from server
                    firebase.getCredits().then(c => useManaStore.getState().setBalance(c)).catch(() => { });
                }
                logIconGenerated('setup', creditsUsed);
                setStatusMessage(t('iconGenerated'));
            }
        } catch (e: any) {
            console.error('Error generating setup icon with AI:', e);
            const errorMsg = e?.message || String(e);
            const isManaError = errorMsg.toLowerCase().includes('insufficient credits') ||
                errorMsg.toLowerCase().includes('insufficient mana') ||
                errorMsg.toLowerCase().includes('no credits');
            if (isManaError) {
                Alert.alert(
                    t('manaDepletedTitle') || 'Out of Mana',
                    t('manaDepletedMessage') || 'You need more Mana to generate icons.',
                    [
                        { text: t('getMana') || 'Get Mana', onPress: () => { setTimeout(() => useManaStore.getState().openShop(), 300); } },
                        { text: t('cancel'), style: 'cancel' }
                    ]
                );
            } else {
                Alert.alert(t('iconGenError'));
            }
        } finally {
            setIsGeneratingIcon(false);
        }
    };

    const handleCreateShortcut = async (app: GeneratedApp) => {
        const result = await createShortcut(app.id, app.name, app.iconPath || null);
        if (result) {
            setStatusMessage(`${t('shortcutCreated')} ${app.name}`);
        } else {
            setStatusMessage(t('shortcutError'));
        }
    };

    const handleExport = () => {
        setShowMenu(false);
        // Direct call - global backup always includes data
        exportBackup();
    };

    const handleShareApp = async (app: GeneratedApp) => {
        // Share single app - clean export (no data)
        setStatusMessage(t('exporting'));
        const success = await exportSingleApp(app.id);
        if (success) {
            setStatusMessage(t('backupExportedSuccess'));
        } else {
            setStatusMessage(t('errorExportingBackup'));
        }
    };

    const handleImport = () => {
        if (isImporting || isPicking) return;
        setShowMenu(false);
        setIsPicking(true);

        setTimeout(async () => {
            try {
                const result = await DocumentPicker.getDocumentAsync({
                    type: ['*/*'], // Allow .spell and .json
                    copyToCacheDirectory: true,
                });

                if (result.canceled || !result.assets?.[0]) {
                    return;
                }

                await importBackup(result.assets[0].uri);
                markBackupDirty();
            } catch (error) {
                console.error('Error picking backup file:', error);
            } finally {
                setIsPicking(false);
            }
        }, 300);
    };

    const handleImportProject = () => {
        if (isImporting || isPicking) return;
        setShowMenu(false);
        setIsPicking(true);

        setTimeout(async () => {
            try {
                const result = await DocumentPicker.getDocumentAsync({
                    type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
                    copyToCacheDirectory: true,
                });

                if (result.canceled || !result.assets?.[0]) {
                    return;
                }

                const app = await importProject(result.assets[0].uri);
                if (app) {
                    openApp(app.id, 'edit');
                    router.push({ pathname: '/runner/[id]', params: { id: app.id, edit: 'true' } });
                }
            } catch (error) {
                console.error('Error picking project file:', error);
            } finally {
                setIsPicking(false);
            }
        }, 300);
    };

    if (isLoading) {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.primary} />
                </View>
            </SafeAreaView>
        );
    }

    // Combine real apps with placeholders
    const placeholderApps = creatingApps.map((ca, index) => ({
        id: -1 - index, // Negative IDs to avoid conflict
        name: t('newApp'),
        code: '',
        currentVersion: 0,
        iconPath: null,
        lastUpdated: Date.now(),
        createdAt: Date.now(),
        consoleLogs: '',
        totalManaCost: 0,
        requiresBiometric: false,
        sortOrder: 0,
        isPlaceholder: true, // Marker property
    } as GeneratedApp)); // Cast to satisfy type, we handle isPlaceholder in renderItem

    const allApps = [...placeholderApps, ...apps];

    const filteredApps = searchQuery.trim()
        ? allApps.filter(a =>
            a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (a.shortDescription || '').toLowerCase().includes(searchQuery.toLowerCase())
        )
        : allApps;

    const fabBottom = spacing.lg + (Platform.OS === 'android' ? 24 : 0) + insets.bottom;
    const listBottomPadding = fabBottom + 92;

    const handleSignOutKeep = async () => {
        try {
            await firebase.signOut();
            setSignOutBanner('keep');
        } catch (e) {
            console.error('Sign out failed:', e);
        }
    };

    const handleSignOutClear = async () => {
        try {
            await wipeAllData();
            await firebase.signOut();
            setSignOutBanner('clear');
        } catch (e) {
            console.error('Sign out & clear failed:', e);
        }
    };

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>

            {/* Header with menu */}
            <View style={styles.header}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.headerTitle}>
                        <Text style={styles.headerTitleStar}>✦ </Text>
                        {t('appName')}
                    </Text>
                </View>
                <ManaDisplay />
                <TouchableOpacity onPress={() => setShowMenu(true)} style={[styles.menuBtn, { marginStart: spacing.md }]} accessibilityLabel={t('options')} accessibilityRole="button">
                    <Text style={styles.menuIcon}>⋮</Text>
                </TouchableOpacity>
            </View>

            {/* Search bar */}
            {showSearch && (
                <View style={styles.searchBar}>
                    <Text style={styles.searchIcon}>🔍</Text>
                    <TextInput
                        style={styles.searchInput}
                        placeholder={t('searchSpells')}
                        placeholderTextColor="#8b8aad"
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        returnKeyType="search"
                        clearButtonMode="while-editing"
                    />
                    {!!searchQuery && Platform.OS !== 'ios' && (
                        <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Text style={styles.searchClear}>✕</Text>
                        </TouchableOpacity>
                    )}
                </View>
            )}

            <View style={{ marginTop: spacing.xs }}>
                {/* Status Banner (Post-logout) */}
                {signOutBanner && (
                    <TouchableOpacity
                        style={styles.statusBanner}
                        onPress={() => setSignOutBanner(null)}
                        activeOpacity={0.9}
                    >
                        <Text style={styles.statusBannerEmoji}>ℹ️</Text>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.statusBannerTitle}>{t('signOutSuccessTitle')}</Text>
                            <Text style={styles.statusBannerText}>
                                {signOutBanner === 'keep' ? t('signOutSuccessKeep') : t('signOutSuccessClear')}
                            </Text>
                        </View>
                        <Text style={styles.statusBannerClose}>✕</Text>
                    </TouchableOpacity>
                )}

                {balance <= 0 && (
                    <TouchableOpacity
                        style={styles.manaWarningBanner}
                        onPress={openShop}
                        activeOpacity={0.8}
                    >
                        <Text style={styles.manaWarningEmoji}>⚡</Text>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.manaWarningTitle}>{t('manaDepletedTitle')}</Text>
                            <Text style={styles.manaWarningText}>{t('manaDepletedMessage')}</Text>
                        </View>
                        <Text style={styles.manaWarningAction}>›</Text>
                    </TouchableOpacity>
                )}

                {/* Backup restore success banner */}
                {(restoredCount > 0 || isRestoring) && (
                    <TouchableOpacity
                        style={[styles.restoreBanner, isRestoring && { opacity: 0.8 }]}
                        onPress={isRestoring ? undefined : clearRestoredCount}
                        activeOpacity={isRestoring ? 1 : 0.9}
                        disabled={isRestoring}
                    >
                        {isRestoring ? (
                            <ActivityIndicator size="small" color={colors.success} style={{ marginRight: spacing.md }} />
                        ) : (
                            <Text style={styles.restoreBannerEmoji}>🔮</Text>
                        )}
                        <View style={{ flex: 1 }}>
                            <Text style={styles.restoreBannerTitle}>
                                {isRestoring ? t('restoringSpells') : t('backupRestoredCount', { count: restoredCount })}
                            </Text>
                            <Text style={styles.restoreBannerText}>
                                {isRestoring ? t('pleaseWait') : t('backupRestoredDesc')}
                            </Text>
                        </View>
                    </TouchableOpacity>
                )}

                {/* No-backup warning banner */}
                {!isAnonymous && backupHydrated && (backupMode === null || backupMode === 'none') && (
                    <TouchableOpacity
                        style={styles.noBackupBanner}
                        onPress={() => { setSyncModalMode('choose'); setShowSyncModal(true); }}
                        activeOpacity={0.8}
                    >
                        <Text style={styles.noBackupEmoji}>⚠️</Text>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.noBackupTitle}>{t('noBackupTitle')}</Text>
                            <Text style={styles.noBackupText}>{t('noBackupDesc')}</Text>
                        </View>
                        <Text style={styles.noBackupAction}>›</Text>
                    </TouchableOpacity>
                )}

                {/* Active backup status banner */}
                {(!isAnonymous && (backupMode === 'google_drive' || backupMode === 'local_folder') && restoredCount === 0) && (
                    <View style={styles.backupActiveBanner}>
                        <Text style={styles.backupActiveBannerEmoji}>{backupMode === 'google_drive' ? '☁️' : '📁'}</Text>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.backupActiveBannerTitle}>{t('backupActive')}</Text>
                            <Text style={styles.backupActiveBannerText}>
                                {t(backupMode === 'local_folder' ? 'backupActiveLocalDesc' : 'backupActiveDesc')}
                                {lastBackupAt && (
                                    <> {'\n'}<Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                                        {t('lastBackupAtLabel', { date: new Date(lastBackupAt).toLocaleString(getCurrentLanguage(), { dateStyle: 'medium', timeStyle: 'medium' }) })}
                                    </Text></>
                                )}
                            </Text>
                        </View>
                    </View>
                )}
            </View>

            {filteredApps.length === 0 && !isGenerating ? (
                <View style={{ flex: 1, paddingBottom: listBottomPadding }}>
                    {searchQuery.trim() && apps.length > 0 ? (
                        <EmptySearchState
                            query={searchQuery}
                            suggestions={suggestions}
                            isLoading={isLoadingSuggestions}
                            onSuggestionPress={(s) => {
                                setSearchQuery(''); // Clear search to return to listing
                                setCreateDialogInitialText(s.description);
                                setShowCreateDialog(true);
                            }}
                        />
                    ) : (
                        <EmptyState />
                    )}
                </View>
            ) : (
                <FlatList
                    data={filteredApps}
                    keyExtractor={(item) => item.id.toString()}
                    contentContainerStyle={[styles.list, { paddingBottom: listBottomPadding }]}
                    onScroll={onScroll}
                    scrollEventThrottle={16}
                    onScrollBeginDrag={() => setActiveCardId(null)}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={onRefresh}
                            colors={[colors.primary]}
                            tintColor={colors.primary}
                            enabled={isAtTop || refreshing}
                        />
                    }
                    ListHeaderComponent={
                        <Text style={styles.listLabel}>{t('yourApps').toUpperCase()}</Text>
                    }
                    renderItem={({ item, index }) => {
                        // Check if this item is a placeholder (from our manual mapping above)
                        const isPlaceholder = (item as any).isPlaceholder;
                        // Check if this real app is currently updating
                        const isLocked = updatingAppIds.includes(item.id);

                        const realApps = filteredApps.filter(a => !(a as any).isPlaceholder);
                        const ctxIdx = realApps.findIndex(a => a.id === item.id);
                        const lastRealIdx = realApps.length - 1;

                        return (
                            <AppCard
                                app={item}
                                onRun={() => handleRunApp(item)}
                                onEdit={() => handleEditApp(item)}
                                onDelete={() => setDeleteTarget(item)}
                                onRename={() => {
                                    setSetupTarget(item);
                                    setSetupName(item.name);
                                    setSetupDescription(item.shortDescription || '');
                                    setSetupMode('edit');
                                }}
                                onShortcut={() => handleCreateShortcut(item)}
                                onToggleBiometric={() => handleToggleBiometric(item)}
                                onShare={() => handleShareApp(item)}
                                onViewSchedules={() => setScheduleTarget(item)}
                                isPlaceholder={isPlaceholder}
                                isLocked={isLocked}
                                notificationCount={notifCounts[item.id] || 0}
                                coachStep={!isPlaceholder && !isLocked && filteredApps.indexOf(item) === 0 ? coachStep : 0}
                                onCoachDismiss={handleCoachDismiss}
                                isActive={activeCardId === item.id}
                                canMoveUp={!isPlaceholder && ctxIdx > 0}
                                canMoveDown={!isPlaceholder && ctxIdx < lastRealIdx}
                                onMoveUp={() => { reorderApp(item.id, 'up'); markBackupDirty(); }}
                                onMoveDown={() => { reorderApp(item.id, 'down'); markBackupDirty(); }}
                                onDismissActive={() => setActiveCardId(null)}
                                onLongPress={!isPlaceholder && !isLocked ? () => {
                                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                                    setActiveCardId(item.id);
                                } : undefined}
                                onClearData={() => {
                                    Alert.alert(
                                        t('clearDataConfirmTitle'),
                                        t('clearDataConfirmMessage'),
                                        [
                                            { text: t('cancel'), style: 'cancel' },
                                            {
                                                text: t('clearDataConfirm'),
                                                style: 'destructive',
                                                onPress: () => {
                                                    clearAppStorage(item.id);
                                                    markBackupDirty();
                                                }
                                            }
                                        ]
                                    );
                                }}
                            />
                        );
                    }}
                />
            )}

            {/* FAB */}
            <View style={[styles.fabWrap, { bottom: fabBottom }]} pointerEvents="box-none">
                <TouchableOpacity
                    style={styles.fab}
                    onPress={() => {
                        if (balance <= 0) {
                            Alert.alert(
                                t('manaDepletedTitle'),
                                t('manaDepletedMessage'),
                                [
                                    { text: t('buyMana'), onPress: openShop },
                                    { text: t('cancel'), style: 'cancel' }
                                ]
                            );
                        } else {
                            setShowCreateDialog(true);
                        }
                    }}
                    accessibilityLabel={t('createApp')}
                    accessibilityRole="button"
                >
                    <Text style={styles.fabIcon}>✨</Text>
                    <Text style={styles.fabText}>{t('createApp')}</Text>
                </TouchableOpacity>
            </View>


            {/* Menu Modal */}
            <Modal visible={showMenu} transparent animationType="slide" onRequestClose={() => { setShowMenu(false); setShowAdvanced(false); }}>
                <Pressable style={styles.sheetOverlay} onPress={() => { setShowMenu(false); setShowAdvanced(false); }}>
                    <Pressable style={[styles.sheetContainer, { paddingBottom: Math.max(insets.bottom, 20) + 12 }]}>
                        <View style={styles.sheetHandle} />

                        {/* Header */}
                        <View style={styles.sheetHeader}>
                            <View style={styles.sheetHeaderIcon}>
                                <Text style={{ fontSize: 20 }}>⚙️</Text>
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.sheetHeaderTitle}>{t('options')}</Text>
                            </View>
                            <TouchableOpacity style={styles.sheetCloseBtn} onPress={() => { setShowMenu(false); setShowAdvanced(false); }}>
                                <Text style={styles.sheetCloseBtnText}>✕</Text>
                            </TouchableOpacity>
                        </View>

                        {/* Items */}
                        <View style={styles.sheetBody}>
                            <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowMenu(false); setShowAdvanced(false); setShowOnboarding(true); }} accessibilityLabel={t('replayOnboarding')} accessibilityRole="menuitem">
                                <View style={styles.sheetItemIcon}><Text style={styles.sheetItemEmoji}>📖</Text></View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.sheetItemTitle}>{t('replayOnboarding')}</Text>
                                </View>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowMenu(false); setShowAdvanced(false); setShowLegal(true); }} accessibilityLabel={t('legal')} accessibilityRole="menuitem">
                                <View style={styles.sheetItemIcon}><Text style={styles.sheetItemEmoji}>📜</Text></View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.sheetItemTitle}>{t('legal')}</Text>
                                </View>
                            </TouchableOpacity>

                            {/* Advanced Section (collapsible) */}
                            <TouchableOpacity style={styles.sheetItem} onPress={() => setShowAdvanced(v => !v)} accessibilityLabel={t('advanced')} accessibilityRole="menuitem">
                                <View style={[styles.sheetItemIcon, { backgroundColor: 'rgba(124,58,237,0.15)' }]}><Text style={styles.sheetItemEmoji}>⚙️</Text></View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.sheetItemTitle}>{t('advanced')}</Text>
                                    <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>{t('advancedDesc')}</Text>
                                </View>
                                <Text style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>{showAdvanced ? '▼' : '›'}</Text>
                            </TouchableOpacity>

                            {showAdvanced && (
                                <View style={{ marginStart: 20, borderStartWidth: 1, borderStartColor: 'rgba(255,255,255,0.07)', paddingStart: 8 }}>
                                    <TouchableOpacity style={styles.sheetItem} onPress={handleExport} accessibilityLabel={t('exportBackup')} accessibilityRole="menuitem">
                                        <View style={styles.sheetItemIcon}><Text style={styles.sheetItemEmoji}>📤</Text></View>
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.sheetItemTitle}>{t('exportBackup')}</Text>
                                        </View>
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.sheetItem} onPress={handleImport} accessibilityLabel={t('importBackup')} accessibilityRole="menuitem">
                                        <View style={styles.sheetItemIcon}><Text style={styles.sheetItemEmoji}>📥</Text></View>
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.sheetItemTitle}>{t('importBackup')}</Text>
                                        </View>
                                    </TouchableOpacity>
                                    {/* Import Project — hidden for now
                                    <TouchableOpacity style={styles.sheetItem} onPress={handleImportProject} accessibilityLabel={t('importProject')} accessibilityRole="menuitem">
                                        <View style={styles.sheetItemIcon}><Text style={styles.sheetItemEmoji}>📜</Text></View>
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.sheetItemTitle}>{t('importProject')}</Text>
                                        </View>
                                    </TouchableOpacity>
                                    */}

                                    {!isAnonymous && (
                                        <TouchableOpacity style={styles.sheetItem} onPress={() => {
                                            setShowMenu(false);
                                            setShowAdvanced(false);
                                            setSyncModalMode('choose');
                                            setShowSyncModal(true);
                                        }} accessibilityLabel={t('syncSettings')} accessibilityRole="menuitem">
                                            <View style={styles.sheetItemIcon}><Text style={styles.sheetItemEmoji}>🔄</Text></View>
                                            <View style={{ flex: 1 }}>
                                                <Text style={styles.sheetItemTitle}>{t('syncSettings')}</Text>
                                                <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>{t('syncSettingsDesc')}</Text>
                                            </View>
                                        </TouchableOpacity>
                                    )}
                                </View>
                            )}

                            {/* Sign Out - only when logged in */}
                            {!isAnonymous && (
                                <>
                                    <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.07)', marginVertical: 8 }} />
                                    <TouchableOpacity
                                        style={styles.sheetItem}
                                        onPress={() => {
                                            setShowMenu(false);
                                            setShowAdvanced(false);
                                            setShowSignOutModal(true);
                                        }}
                                        accessibilityLabel={t('signOut')}
                                        accessibilityRole="menuitem"
                                    >
                                        <View style={[styles.sheetItemIcon, { backgroundColor: 'rgba(248,113,113,0.15)' }]}>
                                            <Text style={styles.sheetItemEmoji}>🚪</Text>
                                        </View>
                                        <View style={{ flex: 1 }}>
                                            <Text style={[styles.sheetItemTitle, { color: '#f87171' }]}>{t('signOut')}</Text>
                                        </View>
                                    </TouchableOpacity>
                                </>
                            )}
                        </View>
                    </Pressable>
                </Pressable>
            </Modal>

            {/* Advanced Sign-Out Modal */}
            <SignOutModal
                visible={showSignOutModal}
                onClose={() => setShowSignOutModal(false)}
                onSelectKeep={handleSignOutKeep}
                onSelectClear={handleSignOutClear}
            />

            {/* Dialogs */}
            <ChatDialog
                visible={showCreateDialog}
                title={t('createTitle')}
                isGenerating={isGenerating}
                onDismiss={() => { if (!isGenerating) { setShowCreateDialog(false); setCreateDialogInitialText(undefined); } }}
                onSend={handleCreateApp}
                initialText={createDialogInitialText}
            />

            <ConfirmDialog
                visible={!!deleteTarget}
                title={t('deleteTitle')}
                message={t('deleteMessage', { name: deleteTarget?.name })}
                confirmText={t('delete')}
                onDismiss={() => setDeleteTarget(null)}
                onConfirm={handleDeleteConfirm}
            />

            {/* Post-Creation Setup Modal */}
            <Modal
                visible={!!setupTarget}
                animationType="slide"
                onRequestClose={handleSetupSkip}
            >
                <KeyboardAvoidingView
                    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                    style={{ flex: 1, backgroundColor: colors.background }}
                >
                    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
                        <ScrollView
                            contentContainerStyle={styles.setupContainer}
                            keyboardShouldPersistTaps="handled"
                        >
                            <Text style={styles.setupTitle}>
                                {setupMode === 'edit' ? t('editAppDetails') : t('setupModalTitle')}
                            </Text>
                            {setupMode === 'create' && (
                                <Text style={styles.setupSubtitle}>{t('setupModalSubtitle')}</Text>
                            )}

                            {/* Icon preview + picker buttons */}
                            <View style={styles.setupIconRow}>
                                {setupTarget?.iconPath ? (
                                    <Image
                                        source={{ uri: setupTarget.iconPath }}
                                        style={styles.setupIconPreview}
                                    />
                                ) : (
                                    <View style={[styles.setupIconPreview, styles.setupIconInitials]}>
                                        <Text style={styles.setupIconInitialsText}>
                                            {setupTarget?.name?.charAt(0)?.toUpperCase() ?? '?'}
                                        </Text>
                                    </View>
                                )}
                                <View style={styles.setupIconBtns}>
                                    <TouchableOpacity
                                        style={styles.setupIconBtn}
                                        onPress={handleSetupIconFromGallery}
                                        disabled={isPicking}
                                    >
                                        <Text style={styles.setupIconBtnText}>🖼️  {t('fromGallery')}</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        style={styles.setupIconBtn}
                                        onPress={handleSetupSearchGoogle}
                                    >
                                        <Text style={styles.setupIconBtnText}>🔍  {t('searchGoogle')}</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        style={[styles.setupIconBtn, styles.setupIconBtnAI]}
                                        onPress={handleSetupGenerateIconWithAI}
                                        disabled={isGeneratingIcon}
                                    >
                                        {isGeneratingIcon ? (
                                            <ActivityIndicator size="small" color={colors.primary} />
                                        ) : (
                                            <Text style={styles.setupIconBtnAIText}>✨  {t('generateWithAI')}  ⚡ {(0.5).toLocaleString(getCurrentLanguage(), { minimumFractionDigits: 1 })}</Text>
                                        )}
                                    </TouchableOpacity>
                                </View>
                            </View>

                            {/* Name */}
                            <Text style={styles.setupLabel}>{t('spellNameLabel')}</Text>
                            <TextInput
                                style={styles.setupInput}
                                value={setupName}
                                onChangeText={setSetupName}
                                placeholder={t('spellNameLabel')}
                                placeholderTextColor={colors.onSurfaceVariant}
                            />

                            {/* Description */}
                            <Text style={styles.setupLabel}>{t('shortDescriptionLabel')}</Text>
                            <TextInput
                                style={[styles.setupInput, styles.setupTextArea]}
                                value={setupDescription}
                                onChangeText={setSetupDescription}
                                placeholder={t('shortDescriptionLabel')}
                                placeholderTextColor={colors.onSurfaceVariant}
                                multiline
                                numberOfLines={3}
                            />

                            {/* Cost notice — only in create mode */}
                            {setupMode === 'create' && (
                                <View style={styles.setupCostNotice}>
                                    <Text style={styles.setupCostText}>
                                        💡 {t('setupCostNotice', { cost: (setupTarget?.totalManaCost ?? 0).toLocaleString(getCurrentLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}
                                    </Text>
                                </View>
                            )}

                            <TouchableOpacity style={styles.setupSaveBtn} onPress={handleSetupSave}>
                                <Text style={styles.setupSaveBtnText}>
                                    {setupMode === 'edit' ? t('save') : t('setupModalSave')}
                                </Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.setupSkipBtn} onPress={handleSetupSkip}>
                                <Text style={styles.setupSkipBtnText}>
                                    {setupMode === 'edit' ? t('cancel') : t('setupModalSkip')}
                                </Text>
                            </TouchableOpacity>
                        </ScrollView>
                    </SafeAreaView>
                </KeyboardAvoidingView>
            </Modal>

            {/* Import Progress Modal */}
            <Modal visible={isImporting} transparent animationType="fade">
                <View style={styles.importOverlay}>
                    <View style={styles.importingModal}>
                        <ActivityIndicator size="large" color={colors.primary} />
                        <Text style={styles.importingText}>{t('importing')}</Text>
                        <Text style={styles.importingHint}>{t('processing')}</Text>
                    </View>
                </View>
            </Modal>



            {/* Legal Modal */}
            <Modal visible={showLegal} animationType="slide" onRequestClose={() => setShowLegal(false)}>
                <SafeAreaView style={[styles.legalContainer, { paddingBottom: Math.max(insets.bottom, 20) }]}>
                    <View style={styles.legalHeader}>
                        <Text style={styles.legalTitle}>📜 {t('legalTitle')}</Text>
                        <TouchableOpacity onPress={() => setShowLegal(false)} style={styles.legalCloseBtn}>
                            <Text style={styles.legalCloseText}>✕</Text>
                        </TouchableOpacity>
                    </View>

                    {/* Tab Buttons */}
                    <View style={styles.legalTabs}>
                        <TouchableOpacity
                            style={[styles.legalTab, legalTab === 'privacy' && styles.legalTabActive]}
                            onPress={() => setLegalTab('privacy')}
                        >
                            <Text style={[styles.legalTabText, legalTab === 'privacy' && styles.legalTabTextActive]}>
                                {t('privacyTab')}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.legalTab, legalTab === 'terms' && styles.legalTabActive]}
                            onPress={() => setLegalTab('terms')}
                        >
                            <Text style={[styles.legalTabText, legalTab === 'terms' && styles.legalTabTextActive]}>
                                {t('termsTab')}
                            </Text>
                        </TouchableOpacity>
                    </View>

                    <ScrollView style={styles.legalContent} contentContainerStyle={styles.legalContentInner}>
                        {legalTab === 'privacy' ? (
                            <>
                                <Text style={styles.legalSectionTitle}>Privacy Policy</Text>
                                <Text style={styles.legalText}>Last updated: January 2026</Text>

                                <Text style={styles.legalHeading}>1. Introduction</Text>
                                <Text style={styles.legalText}>Appacadabra is a tool generator that uses artificial intelligence to create personalized applications. This Privacy Policy describes how we collect, use, and protect your information.</Text>

                                <Text style={styles.legalHeading}>2. Information We Collect</Text>
                                <Text style={styles.legalText}>• Tool descriptions you provide{'\n'}• Generated code (stored locally){'\n'}• Permissions accessed only when needed (contacts, calendar, location)</Text>

                                <Text style={styles.legalHeading}>3. Storage</Text>
                                <Text style={styles.legalText}>All data is stored exclusively on your device. We do not maintain servers with your personal data.</Text>

                                <Text style={styles.legalHeading}>4. Sharing</Text>
                                <Text style={styles.legalText}>App descriptions are processed by Google Gemini API. We do not sell or share your data with third parties for marketing.</Text>

                                <Text style={styles.legalHeading}>5. Your Rights</Text>
                                <Text style={styles.legalText}>You can delete any app at any time, revoke permissions, or uninstall the application to remove all local data.</Text>

                                <Text style={styles.legalHeading}>6. Contact</Text>
                                <Text style={styles.legalText}>For questions: support@appacadabra.ai</Text>
                            </>
                        ) : (
                            <>
                                <Text style={styles.legalSectionTitle}>Terms of Service</Text>
                                <Text style={styles.legalText}>Last updated: January 2026</Text>

                                <Text style={styles.legalHeading}>1. Acceptance</Text>
                                <Text style={styles.legalText}>By using Appacadabra, you agree to these Terms of Service.</Text>

                                <Text style={styles.legalHeading}>2. Service Description</Text>
                                <Text style={styles.legalText}>Appacadabra is a tool that uses AI to generate web applications (HTML/CSS/JavaScript) based on your descriptions.</Text>

                                <Text style={styles.legalHeading}>3. Acceptable Use</Text>
                                <Text style={styles.legalText}>✅ You may:{'\n'}• Create apps for personal or commercial use{'\n'}• Modify and share generated apps</Text>
                                <Text style={styles.legalText}>❌ You may NOT:{'\n'}• Create apps with illegal or malicious content{'\n'}• Generate code for phishing or fraud{'\n'}• Attempt to bypass security filters</Text>

                                <Text style={styles.legalHeading}>4. Property</Text>
                                <Text style={styles.legalText}>The apps you generate are your property. You may use them commercially without royalties.</Text>

                                <Text style={styles.legalHeading}>5. Disclaimer</Text>
                                <Text style={styles.legalText}>The service is provided "as is". We do not guarantee that generated code will be perfect or secure.</Text>

                                <Text style={styles.legalHeading}>6. Contact</Text>
                                <Text style={styles.legalText}>For questions: support@appacadabra.ai</Text>
                            </>
                        )}
                    </ScrollView>
                </SafeAreaView>
            </Modal>

            {/* Scheduled Notifications */}
            <ScheduledNotifications
                visible={!!scheduleTarget}
                appId={scheduleTarget?.id || null}
                appName={scheduleTarget?.name || ''}
                onClose={() => { setScheduleTarget(null); refreshNotifCounts(); }}
            />

            {/* Onboarding */}
            <Onboarding visible={showOnboarding} onComplete={handleOnboardingComplete} />

            {/* First-run spell setup */}
            {firstRunSetupTarget && (
                <SpellSetup
                    app={firstRunSetupTarget}
                    onComplete={handleFirstRunSetupComplete}
                    onSkip={handleSpellSetupSkip}
                />
            )}

            {/* Backup Sync Modal */}
            <BackupSyncModal
                visible={showSyncModal}
                mode={syncModalMode}
                onClose={() => setShowSyncModal(false)}
            />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        backgroundColor: colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: colors.surfaceVariant,
    },
    headerTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#a855f7',
    },
    headerTitleStar: {
        color: '#f59e0b',
    },
    searchBar: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: spacing.md,
        marginVertical: spacing.sm,
        backgroundColor: '#12121f',
        borderWidth: 1.5,
        borderColor: '#1e1e32',
        borderRadius: borderRadius.full,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        gap: spacing.sm,
    },
    searchIcon: {
        fontSize: 14,
        color: '#8b8aad',
    },
    searchInput: {
        flex: 1,
        color: '#f1f0ff',
        fontSize: 14,
        padding: 0,
    },
    searchClear: {
        fontSize: 14,
        color: '#8b8aad',
    },
    listLabel: {
        fontSize: 10,
        fontWeight: '700',
        color: '#8b8aad',
        textTransform: 'uppercase',
        letterSpacing: 1.5,
        paddingTop: spacing.sm,
        paddingBottom: spacing.sm,
        paddingHorizontal: spacing.xs,
    },
    menuBtn: {
        padding: spacing.sm,
    },
    menuIcon: {
        fontSize: 24,
        color: colors.onSurface,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    list: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.md,
    },
    sectionTitle: {
        fontSize: 20,
        fontWeight: '600',
        color: colors.onSurface,
        marginBottom: spacing.md,
    },
    fabWrap: {
        position: 'absolute',
        left: spacing.md,
        right: spacing.md,
        alignItems: 'center',
    },
    fab: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.primary,
        paddingVertical: 15,
        paddingHorizontal: spacing.xl,
        borderRadius: borderRadius.full,
        elevation: 8,
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.55,
        shadowRadius: 14,
        gap: spacing.sm,
    },
    fabIcon: {
        fontSize: 18,
    },
    fabText: {
        color: colors.onPrimary,
        fontSize: 15,
        fontWeight: '700',
    },


    // ── Context Menu styles ──
    ctxBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(5,5,14,0.75)',
        justifyContent: 'center',
        alignItems: 'flex-end',
        paddingRight: 16,
    },
    ctxMenu: {
        backgroundColor: '#1c1c2e',
        borderRadius: 16,
        minWidth: 220,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
        overflow: 'hidden',
    },
    ctxItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 14,
        paddingHorizontal: 14,
    },
    ctxItemDisabled: {
        opacity: 0.4,
    },
    ctxIconWrap: {
        width: 36,
        height: 36,
        borderRadius: 10,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
    },
    ctxIconText: {
        fontSize: 18,
    },
    ctxItemTitle: {
        color: '#F9FAFB',
        fontSize: 14,
        fontWeight: '700',
    },
    ctxItemSub: {
        color: '#6B7280',
        fontSize: 12,
        fontWeight: '500',
        marginTop: 1,
    },
    ctxTextDisabled: {
        color: '#6B7280',
    },
    ctxSeparator: {
        height: 1,
        backgroundColor: 'rgba(255,255,255,0.05)',
        marginHorizontal: 14,
    },

    // ── Unified bottom sheet styles (matches AppCard sheet) ──
    sheetOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.55)',
        justifyContent: 'flex-end',
    },
    sheetContainer: {
        backgroundColor: '#111827',
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
    },
    sheetHandle: {
        width: 40,
        height: 4,
        backgroundColor: '#374151',
        borderRadius: 2,
        alignSelf: 'center',
        marginTop: 12,
        marginBottom: 20,
    },
    sheetHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 20,
        paddingBottom: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#1F2937',
    },
    sheetHeaderIcon: {
        width: 40,
        height: 40,
        borderRadius: 12,
        backgroundColor: '#1F2937',
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
    },
    sheetHeaderTitle: {
        color: '#F9FAFB',
        fontSize: 15,
        fontWeight: '800',
    },
    sheetHeaderSub: {
        color: '#6B7280',
        fontSize: 12,
        fontWeight: '600',
        marginTop: 1,
    },
    sheetCloseBtn: {
        marginLeft: 'auto',
        width: 32,
        height: 32,
        borderRadius: 99,
        backgroundColor: '#1F2937',
        justifyContent: 'center',
        alignItems: 'center',
    },
    sheetCloseBtnText: {
        color: '#9CA3AF',
        fontSize: 16,
    },
    sheetBody: {
        paddingHorizontal: 20,
        paddingTop: 16,
        gap: 8,
    },
    sheetItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: 14,
        backgroundColor: '#0D0D1A',
        borderWidth: 1,
        borderColor: '#1F2937',
        borderRadius: 14,
    },
    sheetItemIcon: {
        width: 40,
        height: 40,
        borderRadius: 12,
        backgroundColor: '#1F2937',
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
    },
    sheetItemEmoji: {
        fontSize: 20,
    },
    sheetItemTitle: {
        color: '#F9FAFB',
        fontSize: 14,
        fontWeight: '800',
    },
    sheetItemSub: {
        color: '#6B7280',
        fontSize: 12,
        fontWeight: '600',
        marginTop: 2,
    },
    sheetItemDanger: {
        borderColor: 'rgba(248,113,113,0.13)',
    },
    sheetItemDangerTitle: {
        color: '#f87171',
    },
    sheetItemIconDanger: {
        backgroundColor: '#2a1a1a',
    },

    errorBar: {
        position: 'absolute',
        bottom: spacing.xl * 3,
        left: spacing.md,
        right: spacing.md,
        backgroundColor: colors.error,
        padding: spacing.md,
        borderRadius: borderRadius.md,
    },
    errorText: {
        color: colors.onError,
        textAlign: 'center',
    },
    iconSourceModal: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.lg,
        padding: spacing.lg,
        width: '80%',
        alignItems: 'center',
    },
    iconSourceTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: colors.onSurface,
        marginBottom: spacing.xs,
    },
    iconSourceSubtitle: {
        fontSize: 14,
        color: colors.onSurfaceVariant,
        marginBottom: spacing.lg,
    },
    iconSourceOption: {
        width: '100%',
        padding: spacing.md,
        backgroundColor: colors.primaryContainer,
        borderRadius: borderRadius.md,
        marginBottom: spacing.sm,
        alignItems: 'center',
    },
    iconSourceOptionText: {
        fontSize: 16,
        color: colors.onPrimaryContainer,
        fontWeight: '500',
    },
    iconSourceCancel: {
        marginTop: spacing.sm,
        padding: spacing.md,
    },
    iconSourceCancelText: {
        fontSize: 14,
        color: colors.onSurfaceVariant,
    },
    importOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    importingModal: {
        backgroundColor: colors.surface,
        padding: spacing.xl,
        borderRadius: borderRadius.lg,
        alignItems: 'center',
        margin: spacing.lg,
    },
    importingText: {
        color: colors.onSurface,
        fontSize: 18,
        fontWeight: '600',
        marginTop: spacing.md,
    },
    importingHint: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
        marginTop: spacing.sm,
    },
    // Legal Modal Styles
    legalContainer: {
        flex: 1,
        backgroundColor: colors.background,
    },
    legalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.md,
        backgroundColor: colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: colors.surfaceVariant,
    },
    legalTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.onSurface,
    },
    legalCloseBtn: {
        padding: spacing.sm,
    },
    legalCloseText: {
        fontSize: 24,
        color: colors.onSurfaceVariant,
    },
    legalTabs: {
        flexDirection: 'row',
        backgroundColor: colors.surface,
        padding: spacing.sm,
    },
    legalTab: {
        flex: 1,
        paddingVertical: spacing.md,
        alignItems: 'center',
        borderRadius: borderRadius.md,
    },
    legalTabActive: {
        backgroundColor: colors.primaryContainer,
    },
    legalTabText: {
        fontSize: 16,
        color: colors.onSurfaceVariant,
    },
    legalTabTextActive: {
        color: colors.primary,
        fontWeight: '600',
    },
    legalContent: {
        flex: 1,
    },
    legalContentInner: {
        padding: spacing.lg,
        paddingBottom: spacing.xl * 2,
    },
    legalSectionTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        color: colors.primary,
        marginBottom: spacing.sm,
    },
    legalHeading: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.onSurface,
        marginTop: spacing.lg,
        marginBottom: spacing.sm,
    },
    legalText: {
        fontSize: 14,
        color: colors.onSurfaceVariant,
        lineHeight: 22,
    },
    manaWarningBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.error + '15', // Subtle error background
        margin: spacing.md,
        marginTop: 0,
        padding: spacing.md,
        borderRadius: borderRadius.lg,
        borderWidth: 1,
        borderColor: colors.error + '40',
    },
    manaWarningEmoji: {
        fontSize: 24,
        marginEnd: spacing.md,
    },
    manaWarningTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        color: colors.error,
    },
    manaWarningText: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
    },
    manaWarningAction: {
        fontSize: 20,
        color: colors.error,
        opacity: 0.5,
        marginStart: spacing.sm,
    },
    // Setup modal styles
    setupContainer: {
        padding: spacing.lg,
        paddingBottom: spacing.xl * 3,
    },
    setupTitle: {
        fontSize: 26,
        fontWeight: 'bold',
        color: colors.onSurface,
        textAlign: 'center',
        marginBottom: spacing.xs,
        marginTop: spacing.lg,
    },
    setupSubtitle: {
        fontSize: 14,
        color: colors.onSurfaceVariant,
        textAlign: 'center',
        marginBottom: spacing.xl,
        lineHeight: 20,
    },
    setupIconRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: spacing.lg,
        gap: spacing.md,
    },
    setupIconPreview: {
        width: 80,
        height: 80,
        borderRadius: 20,
    },
    setupIconInitials: {
        backgroundColor: colors.primaryContainer,
        justifyContent: 'center',
        alignItems: 'center',
    },
    setupIconInitialsText: {
        color: colors.onPrimaryContainer,
        fontSize: 32,
        fontWeight: 'bold',
    },
    setupIconBtns: {
        flex: 1,
        gap: spacing.sm,
    },
    setupIconBtn: {
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
    },
    setupIconBtnText: {
        color: colors.onSurface,
        fontSize: 13,
    },
    setupIconBtnAI: {
        backgroundColor: `${colors.primary}20`,
        borderColor: `${colors.primary}60`,
        borderWidth: 1,
    },
    setupIconBtnAIText: {
        color: colors.primary,
        fontSize: 13,
        fontWeight: '600',
    },
    setupLabel: {
        color: colors.onSurfaceVariant,
        fontSize: 11,
        fontWeight: '700',
        marginBottom: spacing.xs,
        marginTop: spacing.md,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
    },
    setupInput: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        color: colors.onSurface,
        fontSize: 16,
        borderWidth: 1,
        borderColor: colors.surfaceVariant,
    },
    setupTextArea: {
        height: 90,
        textAlignVertical: 'top',
    },
    setupCostNotice: {
        backgroundColor: '#F59E0B18',
        borderRadius: borderRadius.md,
        padding: spacing.md,
        marginTop: spacing.lg,
        marginBottom: spacing.md,
        borderWidth: 1,
        borderColor: '#F59E0B30',
    },
    setupCostText: {
        color: colors.onSurfaceVariant,
        fontSize: 13,
        lineHeight: 20,
    },
    setupSaveBtn: {
        backgroundColor: colors.primary,
        borderRadius: borderRadius.lg,
        paddingVertical: spacing.md + 2,
        alignItems: 'center',
        marginTop: spacing.lg,
    },
    setupSaveBtnText: {
        color: colors.onPrimary,
        fontSize: 16,
        fontWeight: 'bold',
    },
    setupSkipBtn: {
        paddingVertical: spacing.md,
        alignItems: 'center',
        marginTop: spacing.sm,
    },
    setupSkipBtnText: {
        color: colors.onSurfaceVariant,
        fontSize: 15,
    },
    statusBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.primary + '15',
        margin: spacing.md,
        marginTop: 0,
        padding: spacing.md,
        borderRadius: borderRadius.lg,
        borderWidth: 1,
        borderColor: colors.primary + '40',
    },
    statusBannerEmoji: {
        fontSize: 22,
        marginEnd: spacing.md,
    },
    statusBannerTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        color: colors.primary,
    },
    statusBannerText: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
    },
    statusBannerClose: {
        fontSize: 18,
        color: colors.onSurfaceVariant,
        paddingHorizontal: spacing.sm,
    },
    // Backup banners
    noBackupBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#F59E0B15',
        margin: spacing.md,
        marginTop: 0,
        padding: spacing.md,
        borderRadius: borderRadius.lg,
        borderWidth: 1,
        borderColor: '#F59E0B40',
    },
    noBackupEmoji: {
        fontSize: 22,
        marginEnd: spacing.md,
    },
    noBackupTitle: {
        fontSize: 14,
        fontWeight: 'bold' as const,
        color: '#fbbf24',
    },
    noBackupText: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
    },
    noBackupAction: {
        fontSize: 20,
        color: '#fbbf24',
        opacity: 0.5,
        marginStart: spacing.sm,
    },
    restoreBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#10B98115',
        margin: spacing.md,
        marginTop: 0,
        padding: spacing.md,
        borderRadius: borderRadius.lg,
        borderWidth: 1,
        borderColor: '#10B98140',
    },
    restoreBannerEmoji: {
        fontSize: 22,
        marginEnd: spacing.md,
    },
    restoreBannerTitle: {
        fontSize: 14,
        fontWeight: 'bold' as const,
        color: colors.success,
    },
    restoreBannerText: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
    },
    backupActiveBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#10B98110',
        margin: spacing.md,
        marginTop: 0,
        padding: spacing.sm + 2,
        paddingHorizontal: spacing.md,
        borderRadius: borderRadius.md,
        borderWidth: 1,
        borderColor: '#10B98120',
    },
    backupActiveBannerEmoji: {
        fontSize: 16,
        marginEnd: spacing.sm,
    },
    backupActiveBannerTitle: {
        fontSize: 13,
        fontWeight: '600' as const,
        color: colors.success,
    },
    backupActiveBannerText: {
        fontSize: 11,
        color: colors.onSurfaceVariant,
    },
});
