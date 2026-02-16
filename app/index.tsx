import React, { useEffect, useState, useCallback } from 'react';
import {
    View,
    Text,
    FlatList,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    Modal,
    Platform,
    ScrollView,
    Linking as RNLinking,
    Alert,
    RefreshControl,
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
import { t } from '../lib/i18n';
import { ManaDisplay } from '../components/ManaDisplay';
import * as db from '../lib/database/db';
import { exportSingleApp } from '../lib/backup';
import * as firebase from '../lib/firebase';
import { ScheduledNotifications } from '../components/ScheduledNotifications';
import { useManaStore } from '../lib/manaStore';

const ONBOARDING_KEY = 'appacadabra_onboarding_seen';

export default function HomeScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
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
        importProject,
        clearError,
        clearStatusMessage,
        setStatusMessage,
        initializeListeners,
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

    // Initialize background listeners for async jobs
    useEffect(() => {
        initializeListeners();
    }, []);

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

    const handleOnboardingComplete = async () => {
        try {
            await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
        } catch (e) {
            console.error('Error saving onboarding state:', e);
        }
        setShowOnboarding(false);
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
        consoleLogs: '',
        totalManaCost: 0,
        requiresBiometric: false,
        isPlaceholder: true, // Marker property
    } as GeneratedApp)); // Cast to satisfy type, we handle isPlaceholder in renderItem

    const allApps = [...placeholderApps, ...apps];

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            {/* Header with menu */}
            <View style={styles.header}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.headerTitle}>✨ {t('appName')}</Text>
                </View>
                <ManaDisplay />
                <TouchableOpacity onPress={() => setShowMenu(true)} style={[styles.menuBtn, { marginLeft: spacing.md }]}>
                    <Text style={styles.menuIcon}>⋮</Text>
                </TouchableOpacity>
            </View>

            {allApps.length === 0 && !isGenerating ? (
                <EmptyState />
            ) : (
                <FlatList
                    data={allApps}
                    keyExtractor={(item) => item.id.toString()}
                    contentContainerStyle={styles.list}
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
                        <Text style={styles.sectionTitle}>{t('yourApps')}</Text>
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
            <TouchableOpacity
                style={[styles.fab, { bottom: spacing.lg + (Platform.OS === 'android' ? 24 : 0) + insets.bottom }]}
                onPress={() => setShowCreateDialog(true)}
            >
                <Text style={styles.fabIcon}>✨</Text>
                <Text style={styles.fabText}>{t('createApp')}</Text>
            </TouchableOpacity>

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
                        <TouchableOpacity style={styles.menuItem} onPress={handleExport}>
                            <Text style={styles.menuItemIcon}>📤</Text>
                            <Text style={styles.menuItemText}>{t('exportBackup')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.menuItem} onPress={handleImport}>
                            <Text style={styles.menuItemIcon}>📥</Text>
                            <Text style={styles.menuItemText}>{t('importBackup')}</Text>
                        </TouchableOpacity>
                        <View style={styles.menuDivider} />
                        <TouchableOpacity style={styles.menuItem} onPress={() => { setShowMenu(false); setShowOnboarding(true); }}>
                            <Text style={styles.menuItemIcon}>📖</Text>
                            <Text style={styles.menuItemText}>{t('replayOnboarding')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.menuItem} onPress={() => { setShowMenu(false); setShowLegal(true); }}>
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
                                <ActivityIndicator size="small" color={colors.onPrimaryContainer} style={{ marginRight: 12 }} />
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
        color: colors.primary,
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
    fab: {
        position: 'absolute',
        right: spacing.md,
        bottom: spacing.lg + (Platform.OS === 'android' ? 24 : 0), // Add extra clearace for tablets/nav bars
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.primary,
        paddingVertical: spacing.sm + 4,
        paddingHorizontal: spacing.lg,
        borderRadius: borderRadius.lg,
        elevation: 6,
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
    },
    fabIcon: {
        fontSize: 20,
        marginRight: spacing.sm,
    },
    fabText: {
        color: colors.onPrimary,
        fontSize: 16,
        fontWeight: '600',
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
        marginRight: spacing.md,
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
        marginRight: spacing.sm,
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
});
