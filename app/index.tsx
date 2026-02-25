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
    Platform,
    ScrollView,
    KeyboardAvoidingView,
    Image,
    Linking as RNLinking,
    Alert,
    RefreshControl,
    useWindowDimensions,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as ShareIntent from 'share-intent';
import * as LocalAuthentication from 'expo-local-authentication';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAppStore } from '../lib/store';
import { AppCard } from '../components/AppCard';
import { EmptyState } from '../components/EmptyState';
import { ChatDialog, EditDetailsDialog, ConfirmDialog } from '../components/Dialogs';
import { Onboarding } from '../components/Onboarding';
import { colors, spacing, borderRadius } from '../lib/theme';

import { GeneratedApp } from '../lib/database/types';
import { createShortcut, updateDynamicShortcuts } from '../lib/shortcuts';
import { t, getCurrentLanguage } from '../lib/i18n';
import { ManaDisplay } from '../components/ManaDisplay';
import * as db from '../lib/database/db';
import { exportSingleApp } from '../lib/backup';
import * as firebase from '../lib/firebase';
import { ScheduledNotifications } from '../components/ScheduledNotifications';
import { useManaStore } from '../lib/manaStore';

const ONBOARDING_KEY = 'appacadabra_onboarding_seen';
const SHORTCUT_NUDGES_KEY = 'appacadabra_shortcut_nudges_dismissed';

export default function HomeScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const { balance, openShop } = useManaStore();
    const {
        apps,
        isLoading,
        isGenerating,
        isImporting,
        error,
        statusMessage,
        creatingApps,
        updatingAppIds,
        pendingImportUrl, // Get pending import from store
        setPendingImportUrl, // To clear it
        loadApps,
        openApp,
        createApp,
        deleteApp,
        renameApp,
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
    } = useAppStore();

    // Dialog states
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [editTarget, setEditTarget] = useState<GeneratedApp | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<GeneratedApp | null>(null);
    const [showMenu, setShowMenu] = useState(false);
    const [iconTarget, setIconTarget] = useState<GeneratedApp | null>(null);
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
    const [dismissedShortcutNudges, setDismissedShortcutNudges] = useState<Record<number, boolean>>({});

    // Initialize background listeners for async jobs
    useEffect(() => {
        initializeListeners();
    }, []);

    // Show setup modal when a new spell is created
    useEffect(() => {
        if (lastCreatedAppId) {
            const created = apps.find(a => a.id === lastCreatedAppId);
            if (created) {
                setSetupTarget(created);
                setSetupName(created.name);
                setSetupDescription(created.shortDescription || '');
                clearLastCreatedApp();
            }
        }
    }, [lastCreatedAppId, apps]);

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

    // Load shortcut nudge dismissals in a single batched read (avoid per-card AsyncStorage calls)
    useEffect(() => {
        let active = true;
        AsyncStorage.getItem(SHORTCUT_NUDGES_KEY)
            .then(raw => {
                if (!active || !raw) return;
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) return;
                const map: Record<number, boolean> = {};
                parsed.forEach((value: any) => {
                    const id = Number(value);
                    if (Number.isFinite(id)) map[id] = true;
                });
                if (active) setDismissedShortcutNudges(map);
            })
            .catch(() => { });

        return () => {
            active = false;
        };
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
            importOnboardingSpell(selectedChip);
        }
    };

    // Track last alert interaction to prevent ghost clicks or stacking
    const lastAlertInteraction = React.useRef(0);

    // (Old effect removed - now handled by /import_spell route)


    useFocusEffect(
        useCallback(() => {
            loadApps();
        }, [])
    );

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await loadApps();
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
    };

    const handleRunApp = async (app: GeneratedApp) => {
        // Check biometric lock
        if (app.requiresBiometric) {
            const authResult = await authenticateBiometric();
            if (!authResult) return;
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
        }
    };

    const handleEditConfirm = async (newName: string, newDescription: string) => {
        if (editTarget) {
            if (newName !== editTarget.name) {
                await renameApp(editTarget.id, newName);
            }
            if (newDescription !== editTarget.shortDescription) {
                await updateAppDescription(editTarget.id, newDescription);
            }
            setEditTarget(null);
        }
    };

    // --- Setup modal handlers ---
    const handleSetupSave = async () => {
        if (!setupTarget) return;
        if (setupName.trim() && setupName.trim() !== setupTarget.name) {
            await renameApp(setupTarget.id, setupName.trim());
        }
        if (setupDescription !== (setupTarget.shortDescription || '')) {
            await updateAppDescription(setupTarget.id, setupDescription);
        }
        setSetupTarget(null);
    };

    const handleSetupSkip = () => setSetupTarget(null);

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
                }
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

    const handleSelectIconFromGallery = async () => {
        if (!iconTarget || isPicking) return;

        try {
            setIsPicking(true);
            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsEditing: true,
                aspect: [1, 1],
                quality: 0.8,
            });

            if (!result.canceled && result.assets[0]) {
                await updateAppIcon(iconTarget.id, result.assets[0].uri);
            }
        } catch (e) {
            console.error('Error selecting icon from gallery:', e);
        } finally {
            setIsPicking(false);
        }
        setIconTarget(null);
    };

    const handleSelectIconFromFile = async () => {
        if (!iconTarget || isPicking) return;

        try {
            setIsPicking(true);
            const result = await DocumentPicker.getDocumentAsync({
                type: ['image/*'],
                copyToCacheDirectory: true,
            });

            if (!result.canceled && result.assets && result.assets[0]) {
                await updateAppIcon(iconTarget.id, result.assets[0].uri);
            }
        } catch (e) {
            console.error('Error selecting icon from file:', e);
        } finally {
            setIsPicking(false);
        }
        setIconTarget(null);
    };

    const handleSearchIconOnGoogle = async () => {
        if (!iconTarget) return;

        // Open Google Images search for app icon
        const searchQuery = encodeURIComponent(`${iconTarget.name} app icon`);
        const googleImageUrl = `https://www.google.com/search?tbm=isch&q=${searchQuery}`;
        await Linking.openURL(googleImageUrl);

        // Close modal - user will download image, then select from gallery
        setIconTarget(null);
    };

    const handleGenerateIconWithAI = async () => {
        if (!iconTarget || isGeneratingIcon) return;

        try {
            setIsGeneratingIcon(true);

            // Use manual shortDescription if available, otherwise fallback to version instruction
            let creationPrompt = iconTarget.shortDescription || '';

            if (!creationPrompt) {
                const versions = await db.getVersionsForApp(iconTarget.id);
                // Versions are sorted DESC, so the last one is v1 (original)
                const firstVersion = versions.length > 0 ? versions[versions.length - 1] : null;
                creationPrompt = firstVersion?.instruction || '';
            }

            const prompt = `App icon for "${iconTarget.name}". ${creationPrompt ? `The app does: ${creationPrompt}.` : ''} . REALLY simple, easy to understand, colorful, minimalist, rounded square, borderless icon suitable for a mobile app. No text. Recognizable symbol because the icon is small. Professional quality that describes the app.`;

            const result = await firebase.generateSpellImageGen(prompt);
            const base64Image = result.text;
            const creditsUsed = result.creditsUsed || 0;

            if (base64Image) {
                // Save base64 to a temp file
                const iconDir = `${FileSystem.documentDirectory}icons/`;
                const dirInfo = await FileSystem.getInfoAsync(iconDir);
                if (!dirInfo.exists) {
                    await FileSystem.makeDirectoryAsync(iconDir, { intermediates: true });
                }
                const iconPath = `${iconDir}ai_icon_${iconTarget.id}_${Date.now()}.png`;
                await FileSystem.writeAsStringAsync(iconPath, base64Image, {
                    encoding: FileSystem.EncodingType.Base64,
                });

                await updateAppIcon(iconTarget.id, iconPath);

                // Update per-spell mana cost in real-time
                if (creditsUsed > 0) {
                    await incrementAppManaCost(iconTarget.id, creditsUsed);
                }

                setStatusMessage(t('iconGenerated'));

                // Only close on success
                setIconTarget(null);
            }
        } catch (e: any) {
            console.error('Error generating icon with AI:', e);

            // Extract error message safely
            const errorMsg = e?.message || String(e);

            // Check for various forms of credit/mana errors
            const isManaError =
                errorMsg.toLowerCase().includes('insufficient credits') ||
                errorMsg.toLowerCase().includes('insufficient mana') ||
                errorMsg.toLowerCase().includes('no credits') ||
                errorMsg.toLowerCase().includes('no user data') ||
                errorMsg.toLowerCase().includes('out of mana');

            if (isManaError) {
                // Close the icon picker modal so the shop can be seen clearly
                setIconTarget(null);

                Alert.alert(
                    t('manaDepletedTitle') || 'Out of Mana',
                    t('manaDepletedMessage') || 'You need more Mana to generate icons.',
                    [
                        {
                            text: t('getMana') || 'Get Mana',
                            onPress: () => {
                                // Small delay to ensure modal close animation finishes
                                setTimeout(() => {
                                    useManaStore.getState().openShop();
                                }, 300);
                            }
                        },
                        { text: t('cancel'), style: 'cancel' }
                    ]
                );
            } else {
                Alert.alert(`${t('iconGenError')}`);
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

    const handleDismissShortcutNudge = (app: GeneratedApp, andCreateShortcut: boolean) => {
        setDismissedShortcutNudges(prev => {
            if (prev[app.id]) return prev;
            const next = { ...prev, [app.id]: true };
            AsyncStorage.setItem(SHORTCUT_NUDGES_KEY, JSON.stringify(Object.keys(next))).catch(() => { });
            return next;
        });

        if (andCreateShortcut) {
            handleCreateShortcut(app);
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
        isPlaceholder: true, // Marker property
    } as GeneratedApp)); // Cast to satisfy type, we handle isPlaceholder in renderItem

    const allApps = [...placeholderApps, ...apps];
    const searchThreshold = width >= 768 ? 8 : 4;
    const showSearch = apps.length > searchThreshold;

    const filteredApps = searchQuery.trim()
        ? allApps.filter(a =>
            a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (a.shortDescription || '').toLowerCase().includes(searchQuery.toLowerCase())
          )
        : allApps;

        const fabBottom = spacing.lg + (Platform.OS === 'android' ? 24 : 0) + insets.bottom;
        const listBottomPadding = fabBottom + 92;

    useEffect(() => {
        if (!showSearch && searchQuery) {
            setSearchQuery('');
        }
    }, [showSearch]);

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

            {filteredApps.length === 0 && !isGenerating ? (
                <View style={{ flex: 1, paddingBottom: listBottomPadding }}>
                    <EmptyState />
                </View>
            ) : (
                <FlatList
                    data={filteredApps}
                    keyExtractor={(item) => item.id.toString()}
                    contentContainerStyle={[styles.list, { paddingBottom: listBottomPadding }]}
                    onScroll={onScroll}
                    scrollEventThrottle={16}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={onRefresh}
                            colors={[colors.primary]}
                            tintColor={colors.primary}
                            enabled={isAtTop || refreshing} // Only enable if at top or already refreshing
                        />
                    }
                    ListHeaderComponent={
                        <Text style={styles.listLabel}>{t('yourApps').toUpperCase()}</Text>
                    }
                    renderItem={({ item }) => {
                        // Check if this item is a placeholder (from our manual mapping above)
                        const isPlaceholder = (item as any).isPlaceholder;
                        // Check if this real app is currently updating
                        const isLocked = updatingAppIds.includes(item.id);

                        return (
                            <AppCard
                                app={item}
                                onRun={() => handleRunApp(item)}
                                onEdit={() => handleEditApp(item)}
                                onDelete={() => setDeleteTarget(item)}
                                onRename={() => setEditTarget(item)}
                                onIconPress={() => setIconTarget(item)}
                                onShortcut={() => handleCreateShortcut(item)}
                                shortcutNudgeDismissed={!!dismissedShortcutNudges[item.id]}
                                onDismissShortcutNudge={(andCreateShortcut) => handleDismissShortcutNudge(item, andCreateShortcut)}
                                onToggleBiometric={() => handleToggleBiometric(item)}
                                onShare={() => handleShareApp(item)}
                                onViewSchedules={() => setScheduleTarget(item)}
                                isPlaceholder={isPlaceholder}
                                isLocked={isLocked}
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
            <Modal visible={showMenu} transparent animationType="fade">
                <TouchableOpacity
                    style={styles.menuOverlay}
                    activeOpacity={1}
                    onPress={() => setShowMenu(false)}
                >
                    <View style={styles.menuSheet}>
                        {/* TODO: Uncomment when Import Scroll feature is ready
                        <TouchableOpacity style={styles.menuItem} onPress={handleImportProject}>
                            <Text style={styles.menuItemIcon}>📦</Text>
                            <Text style={styles.menuItemText}>{t('importProject')}</Text>
                        </TouchableOpacity>
                        <View style={styles.menuDivider} />
                        */}
                        <TouchableOpacity style={styles.menuItem} onPress={handleExport} accessibilityLabel={t('exportBackup')} accessibilityRole="menuitem">
                            <Text style={styles.menuItemIcon}>📤</Text>
                            <Text style={styles.menuItemText}>{t('exportBackup')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.menuItem} onPress={handleImport} accessibilityLabel={t('importBackup')} accessibilityRole="menuitem">
                            <Text style={styles.menuItemIcon}>📥</Text>
                            <Text style={styles.menuItemText}>{t('importBackup')}</Text>
                        </TouchableOpacity>
                        <View style={styles.menuDivider} />
                        <TouchableOpacity style={styles.menuItem} onPress={() => { setShowMenu(false); setShowOnboarding(true); }} accessibilityLabel={t('replayOnboarding')} accessibilityRole="menuitem">
                            <Text style={styles.menuItemIcon}>📖</Text>
                            <Text style={styles.menuItemText}>{t('replayOnboarding')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.menuItem} onPress={() => { setShowMenu(false); setShowLegal(true); }} accessibilityLabel={t('legal')} accessibilityRole="menuitem">
                            <Text style={styles.menuItemIcon}>📜</Text>
                            <Text style={styles.menuItemText}>{t('legal')}</Text>
                        </TouchableOpacity>
                    </View>
                </TouchableOpacity>
            </Modal>

            {/* Icon Picker Modal */}
            <Modal visible={!!iconTarget} transparent animationType="fade">
                <View style={styles.menuOverlay}>
                    <View style={styles.iconSheet}>
                        <Text style={styles.iconSheetTitle}>{t('chooseIcon')}</Text>
                        <Text style={styles.iconSheetSubtitle}>{iconTarget?.name}</Text>
                        <TouchableOpacity style={styles.iconBtn} onPress={handleSelectIconFromGallery}>
                            <Text style={styles.iconBtnIcon}>🖼️</Text>
                            <Text style={styles.iconBtnText}>{t('fromGallery')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.iconBtn} onPress={handleSelectIconFromFile}>
                            <Text style={styles.iconBtnIcon}>📁</Text>
                            <Text style={styles.iconBtnText}>{t('fromFiles')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.iconBtn} onPress={handleSearchIconOnGoogle}>
                            <Text style={styles.iconBtnIcon}>🔍</Text>
                            <Text style={styles.iconBtnText}>{t('searchGoogle')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.iconBtn}
                            onPress={handleGenerateIconWithAI}
                            disabled={isGeneratingIcon}
                        >
                            {isGeneratingIcon ? (
                                <ActivityIndicator size="small" color={colors.onPrimaryContainer} style={{ marginEnd: 12 }} />
                            ) : (
                                <Text style={styles.iconBtnIcon}>✨</Text>
                            )}
                            <Text style={styles.iconBtnText}>
                                {isGeneratingIcon ? t('generatingIcon') : t('generateWithAI')}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.cancelBtn}
                            onPress={() => setIconTarget(null)}
                        >
                            <Text style={styles.cancelText}>{t('cancel')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            {/* Dialogs */}
            <ChatDialog
                visible={showCreateDialog}
                title={t('createTitle')}
                isGenerating={isGenerating}
                onDismiss={() => !isGenerating && setShowCreateDialog(false)}
                onSend={handleCreateApp}
            />

            <EditDetailsDialog
                visible={!!editTarget}
                currentName={editTarget?.name || ''}
                currentDescription={editTarget?.shortDescription || ''}
                onDismiss={() => setEditTarget(null)}
                onConfirm={handleEditConfirm}
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
                            <Text style={styles.setupTitle}>{t('setupModalTitle')}</Text>
                            <Text style={styles.setupSubtitle}>{t('setupModalSubtitle')}</Text>

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

                            {/* Cost notice */}
                            <View style={styles.setupCostNotice}>
                                <Text style={styles.setupCostText}>
                                    💡 {t('setupCostNotice', { cost: (setupTarget?.totalManaCost ?? 0).toLocaleString(getCurrentLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}
                                </Text>
                            </View>

                            <TouchableOpacity style={styles.setupSaveBtn} onPress={handleSetupSave}>
                                <Text style={styles.setupSaveBtnText}>{t('setupModalSave')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.setupSkipBtn} onPress={handleSetupSkip}>
                                <Text style={styles.setupSkipBtnText}>{t('setupModalSkip')}</Text>
                            </TouchableOpacity>
                        </ScrollView>
                    </SafeAreaView>
                </KeyboardAvoidingView>
            </Modal>

            {/* Import Progress Modal */}
            <Modal visible={isImporting} transparent animationType="fade">
                <View style={styles.menuOverlay}>
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
                onClose={() => setScheduleTarget(null)}
            />

            {/* Onboarding */}
            <Onboarding visible={showOnboarding} onComplete={handleOnboardingComplete} />
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
        padding: spacing.md,
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
    menuOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'flex-end',
    },
    menuSheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: borderRadius.xl,
        borderTopRightRadius: borderRadius.xl,
        padding: spacing.lg,
    },
    menuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.md,
    },
    menuItemIcon: {
        fontSize: 24,
        marginEnd: spacing.md,
    },
    menuItemText: {
        color: colors.onSurface,
        fontSize: 16,
    },
    menuDivider: {
        height: 1,
        backgroundColor: colors.surfaceVariant,
        marginVertical: spacing.sm,
    },
    iconSheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: borderRadius.xl,
        borderTopRightRadius: borderRadius.xl,
        padding: spacing.lg,
        alignItems: 'center',
    },
    iconSheetTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.onSurface,
    },
    iconSheetSubtitle: {
        color: colors.onSurfaceVariant,
        marginBottom: spacing.lg,
    },
    iconBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.primaryContainer,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        borderRadius: borderRadius.md,
        marginBottom: spacing.md,
    },
    iconBtnIcon: {
        fontSize: 24,
        marginEnd: spacing.sm,
    },
    iconBtnText: {
        color: colors.onPrimaryContainer,
        fontSize: 16,
    },
    cancelBtn: {
        padding: spacing.md,
    },
    iconBtnAI: {
        borderWidth: 1,
        borderColor: colors.primary,
        backgroundColor: `${colors.primary}15`,
    },
    cancelText: {
        color: colors.onSurfaceVariant,
        fontSize: 16,
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
});
