import React, { useEffect, useState } from 'react';
import { View, Text, Modal, StyleSheet, TouchableOpacity, FlatList, Image, AppState, Platform } from 'react-native';

import { useRouter, useGlobalSearchParams } from 'expo-router';
import { useAppStore } from '../lib/store';
import { GeneratedApp } from '../lib/database/types';
import * as ShareIntent from 'share-intent';
import * as FileSystem from 'expo-file-system/legacy';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { peekBackupMetadata } from '../lib/backup';

// Module-level variables to sync across initial setup
let appSelectionInProgress = false;
let isHandlingAction = false;
let lastRouteOpenUri: string | null = null;
let lastRouteOpenUriAt: number = 0;
const ROUTE_URI_DEDUPE_MS = 500;

export default function ShareReceiver() {
    const [sharedContent, setSharedContent] = useState<ShareIntent.SharedContent | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [resolvedSpellName, setResolvedSpellName] = useState<string>('');
    const [openUriPriority, setOpenUriPriority] = useState(false);
    const router = useRouter();
    const { openUri } = useGlobalSearchParams<{ openUri?: string }>();
    const {
        apps,
        isLoading,
        clearSharedContent: storeClearSharedContent,
        importBackup
    } = useAppStore();
    const hasPendingOpenUri = openUriPriority;

    const safeReplaceHome = React.useCallback((attempt: number = 0) => {
        try {
            router.replace('/');
        } catch (e) {
            if (attempt < 5) {
                setTimeout(() => safeReplaceHome(attempt + 1), 120);
            } else {
                console.warn('ShareReceiver: safeReplaceHome skipped (router not ready yet)');
            }
        }
    }, [router]);

    // Helper to check and lock content
    const tryLockContent = (_content: ShareIntent.SharedContent): boolean => true;

    // Helper to check for content and verify it's not dismissed
    const checkContent = React.useCallback(() => {
        if (isLoading) return;
        // If an "open with" URI is pending, prefer it over stale ACTION_SEND content
        if (hasPendingOpenUri) return;

        // Skip if user already selected an app (prevents modal from returning)
        if (appSelectionInProgress) {
            console.log('ShareReceiver: Skipping check - app selection in progress');
            return;
        }

        const content = ShareIntent.getSharedContent();
        if (content) {
            if (!tryLockContent(content)) {
                return;
            }
            console.log('ShareReceiver: Content found (initial/resume) and locked:', content.uri || 'text content');
            setSharedContent(content);
        }
    }, [isLoading, hasPendingOpenUri]);

    // Initial check when store is ready
    useEffect(() => {
        if (!isLoading) {
            checkContent();
        }
    }, [isLoading, checkContent]);

    // Unified flow: ACTION_VIEW (open with) is routed to /?openUri=... via +native-intent
    // Convert it to the same sharedContent flow used by ACTION_SEND.
    useEffect(() => {
        if (!openUri || typeof openUri !== 'string') return;
        if (isLoading) return;
        if (appSelectionInProgress) return;

        let decodedUri = '';
        try {
            decodedUri = decodeURIComponent(openUri);
        } catch {
            decodedUri = openUri;
        }

        if (!decodedUri.startsWith('content://') && !decodedUri.startsWith('file://')) return;
        const now = Date.now();
        if (lastRouteOpenUri === decodedUri && now - lastRouteOpenUriAt < ROUTE_URI_DEDUPE_MS) return;

        const resolvedName = ShareIntent.getContentFileName(decodedUri)
            || decodedUri.split('/').pop()
            || 'shared_file';

        const syntheticContent = {
            mimeType: 'application/octet-stream',
            uri: decodedUri,
            fileName: resolvedName,
        } as ShareIntent.SharedContent;

        console.log('ShareReceiver: [OPEN_WITH] Routed ACTION_VIEW into shared flow:', decodedUri);
        lastRouteOpenUri = decodedUri;
        lastRouteOpenUriAt = now;
        setOpenUriPriority(true);
        // Clear stale shared payload from previous ACTION_SEND before showing openUri content
        ShareIntent.clearSharedContent();
        storeClearSharedContent();
        setSharedContent(syntheticContent);

        // Clean URL query to avoid retriggering on remounts.
        safeReplaceHome();

        // OpenUri gets temporary priority only to avoid stale overwrite; then normal shares resume.
        setTimeout(() => {
            setOpenUriPriority(false);
        }, 1200);
    }, [openUri, isLoading, safeReplaceHome, storeClearSharedContent]);

    // Resolve spell name by reading backup metadata from the file (same behavior as old import modal)
    useEffect(() => {
        let cancelled = false;

        const resolveName = async () => {
            if (!sharedContent?.uri) {
                setResolvedSpellName('');
                return;
            }

            const fallbackName = sharedContent.fileName || sharedContent.uri.split('/').pop() || '';
            setResolvedSpellName(fallbackName);

            try {
                const meta = await peekBackupMetadata(sharedContent.uri);
                if (!cancelled && meta?.name) {
                    setResolvedSpellName(meta.name);
                }
            } catch {
                // keep fallback name
            }
        };

        resolveName();

        return () => {
            cancelled = true;
        };
    }, [sharedContent?.uri, sharedContent?.fileName]);

    useEffect(() => {
        console.log('ShareReceiver: MOUNTED (Listeners Setup) ----------');

        // Listen for new shared content (when app is already open)
        const subscription = ShareIntent.addShareListener((event) => {
            console.log('ShareReceiver: [LISTENER] addShareListener fired, appSelectionInProgress:', appSelectionInProgress, ' uri:', event.uri);
            if (appSelectionInProgress) return;
            if (hasPendingOpenUri) return;
            if (!tryLockContent(event)) {
                return;
            }
            console.log('ShareReceiver: [LISTENER] Setting sharedContent from listener');
            setSharedContent(event);
        });

        // Safety Monitor: Poll every 600ms
        const safetyInterval = setInterval(() => {
            if (appSelectionInProgress) return;
            if (hasPendingOpenUri) return;
            ShareIntent.checkShareIntent();
            checkContent();
        }, 600);

        // Listen for AppState changes to catch missed events
        const appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
            if (nextAppState === 'active') {
                console.log('ShareReceiver: App active, checking immediately');
                if (appSelectionInProgress) return;
                if (hasPendingOpenUri) return;

                ShareIntent.checkShareIntent();
                checkContent();

                // Burst poll: Check every 500ms for 3 seconds
                let checks = 0;
                const burstInterval = setInterval(() => {
                    if (checks >= 6) {
                        clearInterval(burstInterval);
                        return;
                    }
                    if (appSelectionInProgress) {
                        clearInterval(burstInterval);
                        return;
                    }
                    console.log('ShareReceiver: Burst check', checks + 1);
                    ShareIntent.checkShareIntent();
                    checkContent();
                    checks++;
                }, 500);
            }
        });

        return () => {
            console.log('ShareReceiver: UNMOUNTED (Listeners Cleanup) -------');
            subscription.remove();
            appStateSubscription.remove();
            clearInterval(safetyInterval);
        };
    }, [checkContent, hasPendingOpenUri]);

    const handleSelectApp = async (app: GeneratedApp) => {
        if (!sharedContent || isHandlingAction) return;
        isHandlingAction = true;
        setIsProcessing(true);
        appSelectionInProgress = true;

        console.log('ShareReceiver: Processing shared content:', JSON.stringify(sharedContent));

        let base64Data: string | undefined;

        // If there's a URI, read it as base64
        if (sharedContent.uri) {
            try {
                console.log('ShareReceiver: Reading file from URI:', sharedContent.uri);

                // content:// URIs need to be copied to local cache first
                const fileName = sharedContent.uri.split('/').pop() || 'shared_file';
                const cacheUri = FileSystem.cacheDirectory + fileName;

                // Copy to cache
                await FileSystem.copyAsync({
                    from: sharedContent.uri,
                    to: cacheUri,
                });
                console.log('ShareReceiver: File copied to:', cacheUri);

                // Now read from cache
                const fileContent = await FileSystem.readAsStringAsync(cacheUri, {
                    encoding: FileSystem.EncodingType.Base64,
                });
                base64Data = fileContent;
                console.log('ShareReceiver: File read successfully, base64 length:', base64Data?.length || 0);

                // Clean up cache file
                await FileSystem.deleteAsync(cacheUri, { idempotent: true });
            } catch (error) {
                console.error('ShareReceiver: Failed to read file:', error);
            }
        }

        const shareId = Date.now().toString();
        const contentToStore = {
            mimeType: sharedContent.mimeType || 'text/plain',
            text: sharedContent.text,
            uri: sharedContent.uri,
            base64: base64Data,
            fileName: sharedContent.fileName || sharedContent.uri?.split('/').pop() || 'shared_file',
            shareId: shareId,
            targetAppId: app.id, // Include target app for routing
        };

        // FIXED DROP-BOX: Always use the same file name
        const payloadPath = FileSystem.cacheDirectory + 'pending_share.json';

        try {
            await FileSystem.writeAsStringAsync(payloadPath, JSON.stringify(contentToStore));
            console.log('ShareReceiver: Payload written to drop-box:', payloadPath);
        } catch (e) {
            console.error('ShareReceiver: Failed to write payload:', e);
            return;
        }

        // Close modal and clear native BEFORE navigating
        setSharedContent(null);
        ShareIntent.clearSharedContent();

        // Close only the RunnerActivity for THIS specific app (if open)
        console.log('ShareReceiver: Closing runner window for app', app.id);
        await ShareIntent.finishRunnerActivity(app.id);

        if (Platform.OS === 'android') {
            // On Android, open via RunnerActivity — it reads the drop-box on mount
            console.log('ShareReceiver: Opening RunnerActivity for app', app.id);
            // Small delay to let finishRunnerActivity broadcast be processed first
            await new Promise(resolve => setTimeout(resolve, 300));
            await ShareIntent.startRunnerActivity(app.id);
        } else {
            // On iOS, navigate inside expo-router
            console.log('ShareReceiver: Navigating to runner via expo-router', app.id);
            router.push({
                pathname: '/runner/[id]',
                params: { id: app.id.toString(), share: 'true' }
            });
        }

        // Reset guard after a short delay so future shares are still handled
        setTimeout(() => {
            ShareIntent.clearSharedContent();
            storeClearSharedContent();
            appSelectionInProgress = false;
            isHandlingAction = false;
            setIsProcessing(false);
        }, 2500);
    };

    const handleImportSpell = () => {
        if (!sharedContent || !sharedContent.uri || isHandlingAction) return;
        console.log('ShareReceiver: [IMPORT] handleImportSpell called, uri:', sharedContent.uri);
        isHandlingAction = true;
        appSelectionInProgress = true;

        const uri = sharedContent.uri;

        // Close modal immediately
        setSharedContent(null);
        ShareIntent.clearSharedContent();
        storeClearSharedContent();

        // Import in background
        importBackup(uri).finally(() => {
            console.log('ShareReceiver: [IMPORT] importBackup finished, resetting guards');
            isHandlingAction = false;
            // Keep appSelectionInProgress true a bit longer so burst checks don't re-trigger
            setTimeout(() => { appSelectionInProgress = false; }, 3000);
        });
    };

    const handleClose = () => {
        ShareIntent.clearSharedContent();
        storeClearSharedContent();
        setSharedContent(null);
        appSelectionInProgress = false;
        isHandlingAction = false;
        setIsProcessing(false);
    };

    if (!sharedContent) return null;

    const uri = sharedContent.uri?.toLowerCase() || '';
    const mime = sharedContent.mimeType?.toLowerCase() || '';
    const name = sharedContent.fileName?.toLowerCase() || uri.split('/').pop()?.toLowerCase() || '';
    const isSpell = name.endsWith('.spell') || uri.endsWith('.spell') || mime === 'application/octet-stream';
    const displaySpellName = resolvedSpellName || sharedContent.fileName || sharedContent.uri?.split('/').pop() || '';

    return (
        <Modal visible={true} animationType="slide" transparent>
            <View style={styles.container}>
                <View style={styles.content}>
                    {isSpell && (
                        <TouchableOpacity
                            style={[styles.importCard, { opacity: isProcessing ? 0.5 : 1 }]}
                            onPress={handleImportSpell}
                            disabled={isProcessing}
                        >
                            <Text style={styles.importCardTitle}>✨ {t('importSpell')}</Text>
                            {!!displaySpellName && (
                                <Text style={styles.importCardName} numberOfLines={1}>
                                    {displaySpellName}
                                </Text>
                            )}
                        </TouchableOpacity>
                    )}

                    <Text style={styles.title}>{t('shareWithAppacadabra')}</Text>
                    <Text style={styles.subtitle}>
                        {sharedContent.mimeType} {sharedContent.uri ? t('fileLabel') : t('textLabel')}
                    </Text>
                    {!isSpell && !!(resolvedSpellName || sharedContent.uri) && (
                        <Text style={styles.fileName} numberOfLines={1}>
                            {resolvedSpellName || sharedContent.uri?.split('/').pop()}
                        </Text>
                    )}

                    <Text style={styles.sectionHeader}>{t('chooseApp')}</Text>

                    <FlatList
                        data={apps}
                        keyExtractor={(item) => item.id.toString()}
                        renderItem={({ item }) => (
                            <TouchableOpacity style={[styles.appItem, { opacity: isProcessing ? 0.5 : 1 }]} onPress={() => handleSelectApp(item)} disabled={isProcessing}>
                                {item.iconPath ? (
                                    <Image source={{ uri: item.iconPath }} style={styles.appIcon} />
                                ) : (
                                    <View style={[styles.appIcon, styles.appIconPlaceholder]}>
                                        <Text style={styles.appIconText}>📱</Text>
                                    </View>
                                )}
                                <Text style={styles.appName}>{item.name}</Text>
                            </TouchableOpacity>
                        )}
                        style={styles.list}
                        ListEmptyComponent={
                            <Text style={styles.emptyText}>{apps.length === 0 ? t('noAppsCreated') : ''}</Text>
                        }
                    />

                    <TouchableOpacity style={styles.cancelButton} onPress={handleClose}>
                        <Text style={styles.cancelText}>{t('cancel')}</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'flex-end',
    },
    content: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: borderRadius.xl,
        borderTopRightRadius: borderRadius.xl,
        padding: spacing.lg,
        maxHeight: '80%',
    },
    importCard: {
        backgroundColor: colors.primaryContainer,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        marginBottom: spacing.lg,
        alignItems: 'center',
    },
    importCardTitle: {
        color: colors.onPrimaryContainer,
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: spacing.xs,
        textAlign: 'center',
    },
    importCardName: {
        color: colors.onPrimaryContainer,
        fontSize: 14,
        fontWeight: '600',
        textAlign: 'center',
    },
    title: {
        color: colors.onSurface,
        fontSize: 20,
        fontWeight: 'bold',
        marginBottom: spacing.xs,
        textAlign: 'center',
    },
    subtitle: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
        marginBottom: spacing.lg,
        textAlign: 'center',
    },
    fileName: {
        color: colors.primary,
        fontSize: 13,
        marginBottom: spacing.lg,
        textAlign: 'center',
    },
    sectionHeader: {
        color: colors.onSurface,
        fontSize: 16,
        marginBottom: spacing.sm,
    },
    list: {
        marginBottom: spacing.md,
    },
    appItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: spacing.md,
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        marginBottom: spacing.sm,
    },
    appIcon: {
        width: 40,
        height: 40,
        borderRadius: borderRadius.sm,
        marginEnd: spacing.md,
    },
    appIconPlaceholder: {
        backgroundColor: colors.primaryContainer,
        justifyContent: 'center',
        alignItems: 'center',
    },
    appIconText: {
        fontSize: 20,
    },
    appName: {
        color: colors.onSurface,
        fontSize: 16,
        fontWeight: '600',
        flex: 1,
    },
    emptyText: {
        color: colors.onSurfaceVariant,
        textAlign: 'center',
        padding: spacing.lg,
        fontStyle: 'italic',
    },
    cancelButton: {
        padding: spacing.md,
        backgroundColor: colors.error,
        borderRadius: borderRadius.md,
        alignItems: 'center',
    },
    cancelText: {
        color: colors.onError,
        fontSize: 16,
        fontWeight: 'bold',
    },
});
