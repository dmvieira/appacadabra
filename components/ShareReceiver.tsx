import React, { useEffect, useState } from 'react';
import { View, Text, Modal, StyleSheet, TouchableOpacity, FlatList, Image, AppState } from 'react-native';

import { useRouter } from 'expo-router';
import { useAppStore } from '../lib/store';
import { GeneratedApp } from '../lib/database/types';
import * as ShareIntent from 'share-intent';
import * as FileSystem from 'expo-file-system/legacy';
import * as Linking from 'expo-linking';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';

// Module-level variables to sync across all instances
let globalLastProcessedContentId: string | null = null;
let globalLastProcessedTimestamp: number = 0;
const DEBOUNCE_TIME_MS = 2000; // 2 seconds debounce
let appSelectionInProgress = false; // Stop polling when app is selected

export default function ShareReceiver() {
    const [sharedContent, setSharedContent] = useState<ShareIntent.SharedContent | null>(null);
    const router = useRouter();
    const { apps, setSharedContent: storeSharedContent, clearSharedContent: storeClearSharedContent, importBackup } = useAppStore();

    // Helper to check and lock content
    const tryLockContent = (content: ShareIntent.SharedContent): boolean => {
        const contentId = JSON.stringify(content);
        const now = Date.now();

        // Check if this same content was processed recently
        if (contentId === globalLastProcessedContentId && (now - globalLastProcessedTimestamp < DEBOUNCE_TIME_MS)) {
            console.log('ShareReceiver: Content locked (recently processed), skipping:', content.uri);
            return false;
        }

        // Lock immediate to prevent race conditions from other instances
        globalLastProcessedContentId = contentId;
        globalLastProcessedTimestamp = now;
        return true;
    };

    useEffect(() => {
        console.log('ShareReceiver: MOUNTED ----------------------------');

        // ... rest of logic
        const checkContent = () => {
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
                console.log('ShareReceiver: Content found (initial/resume) and locked:', content.uri);
                setSharedContent(content);
            }
        };

        checkContent();

        // Listen for new shared content (when app is already open)
        const subscription = ShareIntent.addShareListener((event) => {
            if (!tryLockContent(event)) {
                return;
            }
            console.log('ShareReceiver: Event received and locked:', JSON.stringify(event));
            setSharedContent(event);
        });

        // Safety Monitor: Poll every 600ms
        // This guarantees we catch shares even if specific events/state-changes are missed
        const safetyInterval = setInterval(() => {
            ShareIntent.checkShareIntent();
            checkContent();
        }, 600);



        // Listen for AppState changes to catch missed events
        const appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
            if (nextAppState === 'active') {
                console.log('ShareReceiver: App active, checking immediately');

                // Immediate check to remove delay
                ShareIntent.checkShareIntent();
                checkContent();

                // Burst poll: Check every 500ms for 3 seconds
                // This covers race conditions without draining battery forever
                let checks = 0;
                const burstInterval = setInterval(() => {
                    if (checks >= 6) { // 3 seconds total
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
            console.log('ShareReceiver: UNMOUNTED --------------------------');
            subscription.remove();
            appStateSubscription.remove();
            clearInterval(safetyInterval);
        };
    }, []);

    const handleSelectApp = async (app: GeneratedApp) => {
        if (!sharedContent) return;

        // Set flag to stop all polling immediately
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

        console.log('ShareReceiver: Navigating to runner via expo-router', app.id);

        // Use internal navigation for reliable file delivery
        // The app/runner/[id].tsx will read the drop-box file on mount
        router.push({
            pathname: '/runner/[id]',
            params: {
                id: app.id.toString(),
                share: 'true'
            }
        });
    };

    const handleImportSpell = async () => {
        if (!sharedContent || !sharedContent.uri) return;

        console.log('ShareReceiver: Importing spell from:', sharedContent.uri);

        // Close modal immediately to indicate action taken
        setSharedContent(null);
        ShareIntent.clearSharedContent();

        // Call store import action
        // We pass the URI directly - importBackup handles it
        // But for content:// URIs, importBackup might need help if it doesn't have permission?
        // Actually importBackup has logic for content://.
        // But let's copy to cache here just in case, similar to handleSelectApp logic?
        // importBackup (in backup.ts) already has robust fallback logic (readAsString, copyAsync, fetch).
        // Let's try passing URI directly first.

        await importBackup(sharedContent.uri);

        storeClearSharedContent();
    };

    const handleClose = () => {
        // Clear everything to prevent the modal from coming back
        ShareIntent.clearSharedContent();

        storeClearSharedContent();
        setSharedContent(null);
    };

    if (!sharedContent) return null;

    return (
        <Modal visible={true} animationType="slide" transparent>
            <View style={styles.container}>
                <View style={styles.content}>
                    <Text style={styles.title}>{t('shareWithAppacadabra')}</Text>
                    <Text style={styles.subtitle}>
                        {sharedContent.mimeType} {sharedContent.uri ? t('fileLabel') : t('textLabel')}
                    </Text>

                    <Text style={styles.sectionHeader}>{t('chooseApp')}</Text>

                    {(() => {
                        const uri = sharedContent.uri?.toLowerCase() || '';
                        const mime = sharedContent.mimeType?.toLowerCase() || '';
                        const name = sharedContent.fileName?.toLowerCase() || uri.split('/').pop()?.toLowerCase() || '';

                        const isSpell = uri.endsWith('.spell') ||
                            name.endsWith('.spell') ||
                            mime === 'application/vnd.appacadabra.spell' ||
                            mime === 'application/json' ||
                            mime === 'text/plain' || // Allow text/plain if extension matches (or user can try to import anything)
                            (mime === 'application/octet-stream' && name.endsWith('.spell'));

                        // Prepare data with optional import item at the top
                        const listData = isSpell
                            ? [{ id: -1, isImport: true, name: t('importSpell') } as any, ...apps]
                            : apps;

                        return (
                            <FlatList
                                data={listData}
                                keyExtractor={(item) => item.id.toString()}
                                renderItem={({ item }) => {
                                    if (item.isImport) {
                                        return (
                                            <TouchableOpacity
                                                style={[styles.appItem, { backgroundColor: colors.primaryContainer }]}
                                                onPress={handleImportSpell}
                                            >
                                                <View style={[styles.appIcon, styles.appIconPlaceholder, { backgroundColor: colors.primary }]}>
                                                    <Text style={styles.appIconText}>✨</Text>
                                                </View>
                                                <View>
                                                    <Text style={[styles.appName, { color: colors.onPrimaryContainer, fontWeight: 'bold' }]}>
                                                        {item.name}
                                                    </Text>
                                                    <Text style={{ fontSize: 12, color: colors.onPrimaryContainer }}>
                                                        {t('newApp')}
                                                    </Text>
                                                </View>
                                            </TouchableOpacity>
                                        );
                                    }

                                    return (
                                        <TouchableOpacity style={styles.appItem} onPress={() => handleSelectApp(item)}>
                                            {item.iconPath ? (
                                                <Image source={{ uri: item.iconPath }} style={styles.appIcon} />
                                            ) : (
                                                <View style={[styles.appIcon, styles.appIconPlaceholder]}>
                                                    <Text style={styles.appIconText}>📱</Text>
                                                </View>
                                            )}
                                            <Text style={styles.appName}>{item.name}</Text>
                                        </TouchableOpacity>
                                    );
                                }}
                                style={styles.list}
                                ListEmptyComponent={
                                    <Text style={styles.emptyText}>{apps.length === 0 ? t('noAppsCreated') : ''}</Text>
                                }
                            />
                        );
                    })()}

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
        marginRight: spacing.md,
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
