import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    FlatList,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import * as ShareIntent from 'share-intent';
import { useAppStore } from '../lib/store';
import { AppCard } from '../components/AppCard';
import { EmptyState } from '../components/EmptyState';
import { ChatDialog, RenameDialog, ConfirmDialog } from '../components/Dialogs';
import { colors, spacing, borderRadius } from '../lib/theme';

import { GeneratedApp } from '../lib/database/types';
import { createShortcut, updateDynamicShortcuts } from '../lib/shortcuts';

export default function HomeScreen() {
    const router = useRouter();
    const {
        apps,
        isLoading,
        isGenerating,
        error,
        backupStatus,
        loadApps,
        openApp,
        createApp,
        deleteApp,
        renameApp,
        updateAppIcon,
        exportBackup,
        importBackup,
        clearError,
        clearBackupStatus,
    } = useAppStore();

    // Dialog states
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [renameTarget, setRenameTarget] = useState<GeneratedApp | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<GeneratedApp | null>(null);
    const [showMenu, setShowMenu] = useState(false);
    const [iconTarget, setIconTarget] = useState<GeneratedApp | null>(null);

    useEffect(() => {
        loadApps();
    }, []);

    useEffect(() => {
        if (apps.length > 0) {
            updateDynamicShortcuts(apps);
        }
    }, [apps]);

    // Clear backup status after 3 seconds
    useEffect(() => {
        if (backupStatus) {
            const timer = setTimeout(() => clearBackupStatus(), 3000);
            return () => clearTimeout(timer);
        }
    }, [backupStatus]);

    const handleCreateApp = async (description: string) => {
        const app = await createApp(description);
        if (app) {
            setShowCreateDialog(false);
            openApp(app.id);
        }
    };

    const handleRunApp = async (app: GeneratedApp) => {
        // Use openRunnerWindow which creates separate windows per app
        // This uses FLAG_ACTIVITY_NEW_DOCUMENT for document-based tasks
        console.log('handleRunApp: Opening app window via native', app.id);
        const success = await ShareIntent.openRunnerWindow(app.id);
        if (!success) {
            console.error('Native openRunnerWindow failed');
            alert('Não foi possível iniciar o app em nova janela.');
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

    const handlePickIcon = async () => {
        if (!iconTarget) return;

        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.8,
        });

        if (!result.canceled && result.assets[0]) {
            await updateAppIcon(iconTarget.id, result.assets[0].uri);
        }
        setIconTarget(null);
    };

    const handleCreateShortcut = async (app: GeneratedApp) => {
        const result = await createShortcut(app.id, app.name, app.iconPath || null);
        if (result) {
            // Note: success means request sent, but on newer Android it shows a dialog
            // alert('Atalho criado (ou solicitado)!', 'Verifique sua tela inicial.');
        } else {
            // alert('Erro', 'Não foi possível criar o atalho.');
        }
    };

    const handleExport = async () => {
        setShowMenu(false);
        await exportBackup();
    };

    const handleImport = async () => {
        setShowMenu(false);
        await importBackup();
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
                <Text style={styles.headerTitle}>✨ Appacadabra</Text>
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
                        <Text style={styles.sectionTitle}>Seus Apps</Text>
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
                <Text style={styles.fabText}>Criar App</Text>
            </TouchableOpacity>

            {/* Menu Modal */}
            <Modal visible={showMenu} transparent animationType="fade">
                <TouchableOpacity
                    style={styles.menuOverlay}
                    activeOpacity={1}
                    onPress={() => setShowMenu(false)}
                >
                    <View style={styles.menuSheet}>
                        <TouchableOpacity style={styles.menuItem} onPress={handleExport}>
                            <Text style={styles.menuItemIcon}>📤</Text>
                            <Text style={styles.menuItemText}>Exportar Backup</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.menuItem} onPress={handleImport}>
                            <Text style={styles.menuItemIcon}>📥</Text>
                            <Text style={styles.menuItemText}>Importar Backup</Text>
                        </TouchableOpacity>
                    </View>
                </TouchableOpacity>
            </Modal>

            {/* Icon Picker Modal */}
            <Modal visible={!!iconTarget} transparent animationType="fade">
                <View style={styles.menuOverlay}>
                    <View style={styles.iconSheet}>
                        <Text style={styles.iconSheetTitle}>Escolher Ícone</Text>
                        <Text style={styles.iconSheetSubtitle}>{iconTarget?.name}</Text>
                        <TouchableOpacity style={styles.iconBtn} onPress={handlePickIcon}>
                            <Text style={styles.iconBtnIcon}>🖼️</Text>
                            <Text style={styles.iconBtnText}>Escolher da Galeria</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.cancelBtn}
                            onPress={() => setIconTarget(null)}
                        >
                            <Text style={styles.cancelText}>Cancelar</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            {/* Dialogs */}
            <ChatDialog
                visible={showCreateDialog}
                title="Criar Novo App"
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
                title="Deletar app?"
                message={`Tem certeza que deseja deletar '${deleteTarget?.name}'? Ação irreversível.`}
                confirmText="Deletar"
                onDismiss={() => setDeleteTarget(null)}
                onConfirm={handleDeleteConfirm}
            />

            {/* Error Snackbar */}
            {error && (
                <TouchableOpacity style={styles.errorBar} onPress={clearError}>
                    <Text style={styles.errorText}>{error}</Text>
                </TouchableOpacity>
            )}

            {/* Backup Status Snackbar */}
            {backupStatus && (
                <TouchableOpacity style={styles.statusBar} onPress={clearBackupStatus}>
                    <Text style={styles.statusText}>{backupStatus}</Text>
                </TouchableOpacity>
            )}
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
});
