import React, { useEffect, useState } from 'react';
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
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as ShareIntent from 'share-intent';
import { useAppStore } from '../lib/store';
import { AppCard } from '../components/AppCard';
import { EmptyState } from '../components/EmptyState';
import { ChatDialog, RenameDialog, ConfirmDialog } from '../components/Dialogs';
import { colors, spacing, borderRadius } from '../lib/theme';

import { GeneratedApp } from '../lib/database/types';
import { createShortcut, updateDynamicShortcuts } from '../lib/shortcuts';
import { t } from '../lib/i18n';

export default function HomeScreen() {
    const router = useRouter();
    const {
        apps,
        isLoading,
        isGenerating,
        isImporting,
        error,
        statusMessage,
        loadApps,
        openApp,
        createApp,
        deleteApp,
        renameApp,
        updateAppIcon,
        exportBackup,
        importBackup,
        importProject,
        clearError,
        clearStatusMessage,
        setStatusMessage,
    } = useAppStore();

    // Dialog states
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [renameTarget, setRenameTarget] = useState<GeneratedApp | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<GeneratedApp | null>(null);
    const [showMenu, setShowMenu] = useState(false);
    const [iconTarget, setIconTarget] = useState<GeneratedApp | null>(null);
    const [isPicking, setIsPicking] = useState(false);
    const [showLegal, setShowLegal] = useState(false);
    const [legalTab, setLegalTab] = useState<'privacy' | 'terms'>('privacy');

    useEffect(() => {
        loadApps();
    }, []);

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

    const handleCreateApp = async (description: string) => {
        const app = await createApp(description);
        if (app) {
            setShowCreateDialog(false);
            openApp(app.id);
        }
    };

    const handleRunApp = async (app: GeneratedApp) => {
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

    const handleEditApp = (app: GeneratedApp) => {
        openApp(app.id, 'edit');
        router.push({ pathname: '/runner/[id]', params: { id: app.id, edit: 'true' } });
    };

    const handleDeleteConfirm = async () => {
        if (deleteTarget) {
            await deleteApp(deleteTarget.id);
            setDeleteTarget(null);
        }
    };

    const handleRenameConfirm = async (newName: string) => {
        if (renameTarget) {
            await renameApp(renameTarget.id, newName);
            setRenameTarget(null);
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

    const handleCreateShortcut = async (app: GeneratedApp) => {
        const result = await createShortcut(app.id, app.name, app.iconPath || null);
        if (result) {
            setStatusMessage(`${t('shortcutCreated')} ${app.name}`);
        } else {
            setStatusMessage(t('shortcutError'));
        }
    };

    const handleExport = async () => {
        setShowMenu(false);
        await exportBackup();
    };

    const handleImport = () => {
        if (isImporting || isPicking) return;
        setShowMenu(false);
        setIsPicking(true);

        setTimeout(async () => {
            try {
                const result = await DocumentPicker.getDocumentAsync({
                    type: ['application/json', 'text/plain'],
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

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            {/* Header with menu */}
            <View style={styles.header}>
                <Text style={styles.headerTitle}>✨ {t('appName')}</Text>
                <TouchableOpacity onPress={() => setShowMenu(true)} style={styles.menuBtn}>
                    <Text style={styles.menuIcon}>⋮</Text>
                </TouchableOpacity>
            </View>

            {apps.length === 0 && !isGenerating ? (
                <EmptyState />
            ) : (
                <FlatList
                    data={apps}
                    keyExtractor={(item) => item.id.toString()}
                    contentContainerStyle={styles.list}
                    ListHeaderComponent={
                        <Text style={styles.sectionTitle}>{t('yourApps')}</Text>
                    }
                    renderItem={({ item }) => (
                        <AppCard
                            app={item}
                            onRun={() => handleRunApp(item)}
                            onEdit={() => handleEditApp(item)}
                            onDelete={() => setDeleteTarget(item)}
                            onRename={() => setRenameTarget(item)}
                            onIconPress={() => setIconTarget(item)}
                            onShortcut={() => handleCreateShortcut(item)}
                        />
                    )}
                />
            )}

            {/* FAB */}
            <TouchableOpacity
                style={styles.fab}
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
                        <TouchableOpacity style={styles.menuItem} onPress={handleImportProject}>
                            <Text style={styles.menuItemIcon}>📦</Text>
                            <Text style={styles.menuItemText}>{t('importProject')}</Text>
                        </TouchableOpacity>
                        <View style={styles.menuDivider} />
                        <TouchableOpacity style={styles.menuItem} onPress={handleExport}>
                            <Text style={styles.menuItemIcon}>📤</Text>
                            <Text style={styles.menuItemText}>{t('exportBackup')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.menuItem} onPress={handleImport}>
                            <Text style={styles.menuItemIcon}>📥</Text>
                            <Text style={styles.menuItemText}>{t('importBackup')}</Text>
                        </TouchableOpacity>
                        <View style={styles.menuDivider} />
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

            <RenameDialog
                visible={!!renameTarget}
                currentName={renameTarget?.name || ''}
                onDismiss={() => setRenameTarget(null)}
                onConfirm={handleRenameConfirm}
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

            {/* Error Snackbar */}
            {error && (
                <TouchableOpacity style={styles.errorBar} onPress={clearError}>
                    <Text style={styles.errorText}>{error}</Text>
                </TouchableOpacity>
            )}

            {/* Status Message Snackbar */}
            {statusMessage && (
                <TouchableOpacity style={styles.statusBar} onPress={clearStatusMessage}>
                    <Text style={styles.statusText}>{statusMessage}</Text>
                </TouchableOpacity>
            )}

            {/* Legal Modal */}
            <Modal visible={showLegal} animationType="slide">
                <SafeAreaView style={styles.legalContainer}>
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
                                <Text style={styles.legalSectionTitle}>{t('privacyTitle')}</Text>
                                <Text style={styles.legalText}>{t('lastUpdated')}</Text>

                                <Text style={styles.legalHeading}>1. {t('privacyCollectTitle').split(' ')[0]}</Text>
                                <Text style={styles.legalText}>{t('privacyIntro')}</Text>

                                <Text style={styles.legalHeading}>2. {t('privacyCollectTitle')}</Text>
                                <Text style={styles.legalText}>{t('privacyCollect')}</Text>

                                <Text style={styles.legalHeading}>3. {t('privacyStorageTitle')}</Text>
                                <Text style={styles.legalText}>{t('privacyStorage')}</Text>

                                <Text style={styles.legalHeading}>4. {t('privacySharingTitle')}</Text>
                                <Text style={styles.legalText}>{t('privacySharing')}</Text>

                                <Text style={styles.legalHeading}>5. {t('privacyRightsTitle')}</Text>
                                <Text style={styles.legalText}>{t('privacyRights')}</Text>

                                <Text style={styles.legalHeading}>6. {t('contactTitle')}</Text>
                                <Text style={styles.legalText}>{t('privacyContact')}</Text>
                            </>
                        ) : (
                            <>
                                <Text style={styles.legalSectionTitle}>{t('termsTitle')}</Text>
                                <Text style={styles.legalText}>{t('lastUpdated')}</Text>

                                <Text style={styles.legalHeading}>1. {t('termsAcceptTitle')}</Text>
                                <Text style={styles.legalText}>{t('termsAccept')}</Text>

                                <Text style={styles.legalHeading}>2. {t('termsDescTitle')}</Text>
                                <Text style={styles.legalText}>{t('termsDesc')}</Text>

                                <Text style={styles.legalHeading}>3. {t('termsUseTitle')}</Text>
                                <Text style={styles.legalText}>{t('termsUseCan')}</Text>
                                <Text style={styles.legalText}>{t('termsUseCannot')}</Text>

                                <Text style={styles.legalHeading}>4. {t('termsPropertyTitle')}</Text>
                                <Text style={styles.legalText}>{t('termsProperty')}</Text>

                                <Text style={styles.legalHeading}>5. {t('termsDisclaimerTitle')}</Text>
                                <Text style={styles.legalText}>{t('termsDisclaimer')}</Text>

                                <Text style={styles.legalHeading}>6. {t('contactTitle')}</Text>
                                <Text style={styles.legalText}>{t('termsContact')}</Text>
                            </>
                        )}
                    </ScrollView>
                </SafeAreaView>
            </Modal>
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
        bottom: spacing.lg,
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
    statusBar: {
        position: 'absolute',
        bottom: spacing.xl * 3,
        left: spacing.md,
        right: spacing.md,
        backgroundColor: colors.surface,
        padding: spacing.md,
        borderRadius: borderRadius.md,
        borderWidth: 1,
        borderColor: colors.primary,
    },
    statusText: {
        color: colors.onSurface,
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
