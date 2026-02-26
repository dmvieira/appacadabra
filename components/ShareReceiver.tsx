import React, { useEffect, useState, useMemo } from 'react';
import { View, Text, Modal, StyleSheet, TouchableOpacity, FlatList, Image, AppState, Platform, Animated } from 'react-native';

import { useRouter, useGlobalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../lib/store';
import { GeneratedApp } from '../lib/database/types';
import * as ShareIntent from 'share-intent';
import * as FileSystem from 'expo-file-system/legacy';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { peekBackupMetadata } from '../lib/backup';

const AVATAR_COLORS = [
    '#7B2EFF', '#00B4D8', '#FF2EAB', '#00C853', '#FF6D00',
    '#448AFF', '#FF1744', '#00BFA5', '#AA00FF', '#FFD600',
];

function getAvatarColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name: string): string {
    const words = name.trim().split(/\s+/);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
}

function getFileIcon(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    if (ext === 'spell') return '✨';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return '🖼️';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return '🎬';
    if (['mp3', 'wav', 'ogg', 'aac', 'flac'].includes(ext)) return '🎵';
    if (['pdf'].includes(ext)) return '📄';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
    if (['txt', 'md', 'csv', 'json', 'xml', 'html', 'css', 'js', 'ts'].includes(ext)) return '📝';
    return '📎';
}

function getFileTypeLabel(fileName: string, mimeType?: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    if (ext === 'spell') return '.spell';
    if (ext) return `.${ext}`;
    if (mimeType) return mimeType.split('/').pop() || mimeType;
    return '';
}

type ShareContentType = 'text' | 'image' | 'file';

function detectContentType(mimeType?: string, hasUri?: boolean, hasText?: boolean): ShareContentType {
    const mime = (mimeType || '').toLowerCase();
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('text/') || (!hasUri && hasText)) return 'text';
    return 'file';
}

/** Check if a spell's HTML/JS code can receive the given content type.
 *  Mirrors the injection logic in injectedJS.ts handleSharedContent(). */
function canSpellReceive(code: string, contentType: ShareContentType): boolean {
    // Spell explicitly handles shared content via JS events — accepts anything
    if (/sharedFile|sharedContent/i.test(code)) return true;

    switch (contentType) {
        case 'text':
            return /<textarea/i.test(code)
                || /type\s*=\s*["']text["']/i.test(code)
                || /contenteditable/i.test(code);
        case 'image':
        case 'file':
            return /type\s*=\s*["']file["']/i.test(code);
    }
}

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
    const [resolvedSpellDesc, setResolvedSpellDesc] = useState<string>('');
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
                setResolvedSpellDesc('');
                return;
            }

            const fallbackName = sharedContent.fileName || sharedContent.uri.split('/').pop() || '';
            setResolvedSpellName(fallbackName);
            setResolvedSpellDesc('');

            try {
                const meta = await peekBackupMetadata(sharedContent.uri);
                if (!cancelled && meta?.name) {
                    setResolvedSpellName(meta.name);
                }
                if (!cancelled && meta?.shortDescription) {
                    setResolvedSpellDesc(meta.shortDescription);
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
    const displaySpellDescription = resolvedSpellDesc;
    const displayFileName = sharedContent.fileName || sharedContent.uri?.split('/').pop() || 'shared_file';
    const contentType = detectContentType(sharedContent.mimeType, !!sharedContent.uri, !!sharedContent.text);

    return (
        <ShareReceiverUI
            isSpell={isSpell}
            displaySpellName={displaySpellName}
            displaySpellDescription={displaySpellDescription}
            displayFileName={displayFileName}
            mimeType={sharedContent.mimeType}
            contentType={contentType}
            isProcessing={isProcessing}
            apps={apps}
            onImportSpell={handleImportSpell}
            onSelectApp={handleSelectApp}
            onClose={handleClose}
        />
    );
}

/** Visual bottom sheet UI — separated for clarity */
function ShareReceiverUI({
    isSpell,
    displaySpellName,
    displaySpellDescription,
    displayFileName,
    mimeType,
    contentType,
    isProcessing,
    apps,
    onImportSpell,
    onSelectApp,
    onClose,
}: {
    isSpell: boolean;
    displaySpellName: string;
    displaySpellDescription: string;
    displayFileName: string;
    mimeType?: string;
    contentType: ShareContentType;
    isProcessing: boolean;
    apps: GeneratedApp[];
    onImportSpell: () => void;
    onSelectApp: (app: GeneratedApp) => void;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const [activeTab, setActiveTab] = useState<'spell' | 'file'>(isSpell ? 'spell' : 'file');
    const slideAnim = useMemo(() => new Animated.Value(0), []);
    const compatibleApps = useMemo(
        () => apps.filter(app => canSpellReceive(app.code, contentType)),
        [apps, contentType],
    );

    useEffect(() => {
        Animated.spring(slideAnim, {
            toValue: 1,
            useNativeDriver: true,
            damping: 20,
            stiffness: 200,
        }).start();
    }, [slideAnim]);

    const fileIcon = getFileIcon(displayFileName);
    const fileType = getFileTypeLabel(displayFileName, mimeType);

    const renderSpellItem = ({ item }: { item: GeneratedApp }) => {
        const avatarColor = getAvatarColor(item.name);
        const initials = getInitials(item.name);

        return (
            <TouchableOpacity
                style={[styles.spellItem, { opacity: isProcessing ? 0.5 : 1 }]}
                onPress={() => onSelectApp(item)}
                disabled={isProcessing}
                activeOpacity={0.7}
            >
                {item.iconPath ? (
                    <Image source={{ uri: item.iconPath }} style={styles.spellAvatar} />
                ) : (
                    <View style={[styles.spellAvatar, { backgroundColor: avatarColor }]}>
                        <Text style={styles.spellAvatarText}>{initials}</Text>
                    </View>
                )}
                <View style={styles.spellInfo}>
                    <Text style={styles.spellName} numberOfLines={1}>{item.name}</Text>
                    {!!item.shortDescription && (
                        <Text style={styles.spellDesc} numberOfLines={1}>{item.shortDescription}</Text>
                    )}
                </View>
                <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
        );
    };

    return (
        <Modal visible={true} animationType="none" transparent statusBarTranslucent>
            <View style={styles.overlay}>
                <TouchableOpacity style={styles.overlayTouchable} activeOpacity={1} onPress={onClose} />

                <Animated.View style={[
                    styles.sheet,
                    { paddingBottom: Math.max(insets.bottom, 16) },
                    {
                        transform: [{
                            translateY: slideAnim.interpolate({
                                inputRange: [0, 1],
                                outputRange: [600, 0],
                            }),
                        }],
                    },
                ]}>
                    {/* Handle */}
                    <View style={styles.handleRow}>
                        <View style={styles.handle} />
                    </View>

                    {/* Tabs */}
                    <View style={styles.tabRow}>
                        <TouchableOpacity
                            style={[styles.tab, activeTab === 'spell' && styles.tabActive]}
                            onPress={() => setActiveTab('spell')}
                            activeOpacity={0.7}
                        >
                            <Text style={[styles.tabText, activeTab === 'spell' && styles.tabTextActive]}>
                                ✨ {t('shareTabSpell')}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.tab, activeTab === 'file' && styles.tabActive]}
                            onPress={() => setActiveTab('file')}
                            activeOpacity={0.7}
                        >
                            <Text style={[styles.tabText, activeTab === 'file' && styles.tabTextActive]}>
                                📎 {t('shareTabFile')}
                            </Text>
                        </TouchableOpacity>
                    </View>

                    {/* File preview card */}
                    <View style={styles.previewCard}>
                        <Text style={styles.previewIcon}>{fileIcon}</Text>
                        <View style={styles.previewInfo}>
                            <Text style={styles.previewName} numberOfLines={1}>
                                {activeTab === 'spell' ? displaySpellName : displayFileName}
                            </Text>
                            {activeTab === 'spell' && !!displaySpellDescription ? (
                                <Text style={styles.previewDesc} numberOfLines={2}>{displaySpellDescription}</Text>
                            ) : (
                                <Text style={styles.previewType}>{fileType}</Text>
                            )}
                        </View>
                    </View>

                    {activeTab === 'spell' ? (
                        /* ——— Spell tab ——— */
                        <>
                            {/* Import button */}
                            <TouchableOpacity
                                style={[styles.importButton, { opacity: isProcessing ? 0.5 : 1 }]}
                                onPress={onImportSpell}
                                disabled={isProcessing}
                                activeOpacity={0.7}
                            >
                                <Text style={styles.importButtonText}>✨ {t('shareImportSpell')}</Text>
                            </TouchableOpacity>

                            {/* Divider */}
                            {compatibleApps.length > 0 && (
                                <View style={styles.dividerRow}>
                                    <View style={styles.dividerLine} />
                                    <Text style={styles.dividerText}>{t('shareOrSendTo')}</Text>
                                    <View style={styles.dividerLine} />
                                </View>
                            )}

                            {/* Spell list */}
                            {compatibleApps.length > 0 && (
                                <FlatList
                                    data={compatibleApps}
                                    keyExtractor={(item) => item.id.toString()}
                                    renderItem={renderSpellItem}
                                    style={styles.spellList}
                                />
                            )}
                        </>
                    ) : (
                        /* ——— File tab ——— */
                        <>
                            {compatibleApps.length > 0 && (
                                <Text style={styles.sendToLabel}>{t('shareSendToWhich')}</Text>
                            )}

                            <FlatList
                                data={compatibleApps}
                                keyExtractor={(item) => item.id.toString()}
                                renderItem={renderSpellItem}
                                style={styles.spellList}
                                ListEmptyComponent={
                                    <Text style={styles.emptyText}>
                                        {apps.length === 0 ? t('shareNoSpells') : t('shareNoCompatible')}
                                    </Text>
                                }
                            />
                        </>
                    )}

                    {/* Cancel */}
                    <TouchableOpacity style={styles.cancelButton} onPress={onClose} activeOpacity={0.7}>
                        <Text style={styles.cancelText}>{t('cancel')}</Text>
                    </TouchableOpacity>
                </Animated.View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        justifyContent: 'flex-end',
    },
    overlayTouchable: {
        flex: 1,
    },
    sheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        maxHeight: '85%',
        paddingHorizontal: spacing.lg,
    },
    handleRow: {
        alignItems: 'center',
        paddingVertical: 12,
    },
    handle: {
        width: 40,
        height: 4,
        borderRadius: 2,
        backgroundColor: colors.onSurfaceVariant,
        opacity: 0.4,
    },

    // Tabs
    tabRow: {
        flexDirection: 'row',
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        padding: 3,
        marginBottom: spacing.md,
    },
    tab: {
        flex: 1,
        paddingVertical: 10,
        borderRadius: borderRadius.md - 2,
        alignItems: 'center',
    },
    tabActive: {
        backgroundColor: colors.primaryContainer,
    },
    tabText: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
        fontWeight: '600',
    },
    tabTextActive: {
        color: colors.onPrimaryContainer,
    },

    // Preview card
    previewCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        marginBottom: spacing.md,
    },
    previewIcon: {
        fontSize: 28,
        marginRight: spacing.md,
    },
    previewInfo: {
        flex: 1,
    },
    previewName: {
        color: colors.onSurface,
        fontSize: 15,
        fontWeight: '600',
    },
    previewType: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginTop: 2,
    },
    previewDesc: {
        color: colors.onSurfaceVariant,
        fontSize: 13,
        marginTop: 2,
        lineHeight: 17,
    },

    // Import button
    importButton: {
        backgroundColor: colors.primary,
        borderRadius: borderRadius.md,
        paddingVertical: 14,
        alignItems: 'center',
        marginBottom: spacing.md,
    },
    importButtonText: {
        color: colors.onPrimary,
        fontSize: 16,
        fontWeight: 'bold',
    },

    // Divider
    dividerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: spacing.md,
    },
    dividerLine: {
        flex: 1,
        height: 1,
        backgroundColor: colors.surfaceVariant,
    },
    dividerText: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginHorizontal: spacing.sm,
    },

    // Send to label
    sendToLabel: {
        color: colors.onSurface,
        fontSize: 15,
        fontWeight: '600',
        marginBottom: spacing.sm,
    },

    // Spell list
    spellList: {
        maxHeight: 240,
        marginBottom: spacing.md,
    },
    spellItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: spacing.sm,
        borderRadius: borderRadius.sm,
        marginBottom: 2,
    },
    spellAvatar: {
        width: 36,
        height: 36,
        borderRadius: 18,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: spacing.md,
    },
    spellAvatarText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: 'bold',
    },
    spellInfo: {
        flex: 1,
        marginRight: spacing.sm,
    },
    spellName: {
        color: colors.onSurface,
        fontSize: 15,
        fontWeight: '500',
    },
    spellDesc: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginTop: 1,
    },
    chevron: {
        color: colors.onSurfaceVariant,
        fontSize: 22,
        fontWeight: '300',
    },
    emptyText: {
        color: colors.onSurfaceVariant,
        textAlign: 'center',
        padding: spacing.lg,
        fontStyle: 'italic',
    },

    // Cancel
    cancelButton: {
        paddingVertical: 14,
        borderRadius: borderRadius.md,
        alignItems: 'center',
        backgroundColor: colors.surfaceVariant,
        marginTop: spacing.xs,
    },
    cancelText: {
        color: colors.onSurfaceVariant,
        fontSize: 15,
        fontWeight: '600',
    },
});
